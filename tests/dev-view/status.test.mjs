// The dev view's generator (scripts/status): the KPI series and the gate results in, one static page and a status.json out.
// Run: node --test tests/dev-view/status.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const KPI = join(root, "tests/fixtures/dev-view/kpi-series.jsonl");
const GATES = join(root, "tests/fixtures/dev-view/gates.json");
const NOW = "2026-11-04T19:00:00Z";
const { loadSources, buildModel, classify } = await import("../../scripts/status-model.mjs");
const { renderPage } = await import("../../scripts/status-render.mjs");

const model = (kpi = KPI, gates = GATES) => buildModel(loadSources({ kpi, gates }), { now: NOW });
const metric = (m, id, kpi) => m.objectives.find((o) => o.id === id).metrics.find((x) => x.kpi === kpi);

test("classify: meets the target, within 2x is amber, beyond is red, no value is none", () => {
	const metric = { target: 1000, better: "lower" };
	assert.equal(classify(metric, 1000), "ok");
	assert.equal(classify(metric, 1001), "amber");
	assert.equal(classify(metric, 2000), "amber");
	assert.equal(classify(metric, 2001), "red");
	assert.equal(classify(metric, null), "none");
	assert.equal(classify({ better: "lower" }, 5), "info");
});

test("O1: the headline of an env is the worst latest value over its slices", () => {
	const m = model();
	const p50 = metric(m, "O1", "propagation_p50_ms");
	assert.equal(p50.env.test.value, 1200);
	assert.equal(p50.env.test.status, "amber");
	assert.equal(p50.env.prod.value, 2100);
	assert.equal(p50.env.prod.status, "red");
	const p95 = metric(m, "O1", "propagation_p95_ms");
	assert.equal(p95.env.test.value, 2100);
	assert.equal(p95.env.test.status, "ok");
	assert.equal(p95.env.prod.value, 3800);
	assert.equal(p95.env.prod.status, "amber");
});

test("a failed run is shown next to the last measured value, never as a zero", () => {
	const p95 = metric(model(), "O1", "propagation_p95_ms");
	assert.equal(p95.env.prod.lastRunFailed, true);
	assert.equal(p95.env.test.lastRunFailed, false);
});

test("legacy sync_up/down points read as propagation in their own 'legacy' op, and the stackless duplicates are dropped", () => {
	const m = model();
	const p50 = metric(m, "O1", "propagation_p50_ms");
	const legacy = p50.series.filter((s) => s.slice.op === "legacy");
	assert.deepEqual(legacy.map((s) => s.slice.direction).sort(), ["machine->web", "web->machine"]);
	assert.ok(legacy.every((s) => s.env === "test"));
	assert.equal(legacy.find((s) => s.slice.direction === "machine->web").latest, 303);
	assert.equal(legacy.find((s) => s.slice.direction === "machine->web").points.length, 8);
	assert.equal(metric(m, "O1", "propagation_p95_ms").series.filter((s) => s.slice.op === "legacy").length, 2);
});

test("O3: person-month prefers the 10 GB profile and takes the cheapest provider; per-GB takes the cheapest too", () => {
	const m = model();
	assert.equal(metric(m, "O3", "cost_per_person_month_usd").env.prod.value, 0.15);
	assert.equal(metric(m, "O3", "cost_per_person_month_usd").env.prod.status, "ok");
	assert.equal(metric(m, "O3", "cost_per_gb_month_usd").env.prod.value, 0.015);
	assert.equal(metric(m, "O3", "idle_cpu_pct").env.test.status, "ok");
	assert.equal(metric(m, "O3", "idle_cpu_pct").env.prod.status, "none");
});

test("the sparkline covers the last 30 days only, the latest value does not depend on the window", () => {
	const p50 = metric(model(), "O1", "propagation_p50_ms");
	const ts = p50.env.test.sparkline.map((p) => Date.parse(p.t));
	assert.ok(ts.length >= 8);
	assert.ok(ts.every((t) => t >= Date.parse(NOW) - 30 * 864e5));
	const series = p50.series.find((s) => s.env === "test" && s.slice.direction === "machine->machine");
	assert.equal(series.pointsAll, 12); // 11 in the window + one 36 days back
	assert.equal(series.points.length, 11);
});

test("bad lines are skipped and counted, not fatal", () => {
	const m = model();
	const text = m.warnings.join("\n");
	assert.match(text, /not valid JSON/);
	assert.match(text, /no slice\.env/);
	assert.match(text, /unknown KPI/);
	assert.match(text, /unparseable time/);
	assert.match(text, /duplicate/);
});

test("gates: the twelve frozen ids, absent ones are 'unknown', the summary counts them", () => {
	const m = model();
	assert.deepEqual(m.gates.map((g) => g.id), ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10", "G11", "G12"]);
	assert.equal(m.gates.find((g) => g.id === "G2").status, "fail");
	assert.equal(m.gates.find((g) => g.id === "G11").status, "unknown");
	assert.deepEqual(m.gateSummary, { pass: 5, fail: 2, not_built: 2, skipped: 1, unknown: 2 });
});

test("missing sources: nothing crashes, everything reads 'not measured yet'", () => {
	const m = model("/nonexistent/kpi.jsonl", "/nonexistent/gates.json");
	assert.equal(m.inputs.kpi.found, false);
	assert.equal(m.inputs.gates.found, false);
	assert.equal(metric(m, "O1", "propagation_p50_ms").env.test.status, "none");
	assert.ok(m.gates.every((g) => g.status === "unknown"));
	const html = renderPage(m);
	assert.match(html, /not measured yet/);
	assert.match(html, /id="g12"/);
});

test("a gates.json that is not JSON or has the wrong shape is a warning, not a crash", () => {
	const dir = mkdtempSync(join(tmpdir(), "devview-"));
	const bad = join(dir, "gates.json");
	execFileSync("sh", ["-c", `printf 'nope' > ${bad}`]);
	const m = model(KPI, bad);
	assert.ok(m.warnings.some((w) => /gates/.test(w)));
	assert.ok(m.gates.every((g) => g.status === "unknown"));
});

test("the page is self-contained, escapes what the sources say, and has no external references", () => {
	const html = renderPage(model());
	assert.ok(!html.includes("<script>alert(1)</script>"));
	assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
	assert.doesNotMatch(html, /(src|href)="https?:\/\/(?!example\.com)/);
	assert.doesNotMatch(html, /<link[^>]+stylesheet/);
	assert.match(html, /<title>Folder Sync Dev View<\/title>/);
	for (const id of ["o1", "o2", "o3", "g1", "g12"]) assert.match(html, new RegExp(`id="${id}"`));
});

test("CLI: --kpi --gates --out writes index.html and status.json; missing sources still exit 0", () => {
	const out = mkdtempSync(join(tmpdir(), "devview-out-"));
	execFileSync(join(root, "scripts/status"), ["--kpi", KPI, "--gates", GATES, "--out", out, "--now", NOW]);
	const status = JSON.parse(readFileSync(join(out, "status.json"), "utf8"));
	assert.equal(status.schema, "folder-sync-dev-status/1");
	assert.equal(status.objectives.length, 3);
	assert.ok(readFileSync(join(out, "index.html"), "utf8").startsWith("<!doctype html>"));
	const out2 = join(mkdtempSync(join(tmpdir(), "devview-out-")), "nested", "dev");
	execFileSync(join(root, "scripts/status"), ["--kpi", "/nope", "--gates", "/nope", "--out", out2]);
	assert.ok(existsSync(join(out2, "index.html")));
	assert.throws(() => execFileSync(join(root, "scripts/status"), ["--bogus"], { stdio: "pipe" }));
});

// ---- O3 shows the cost on the provider each folder is actually on; the cheapest provider is the second line ---------------

const NAMES = { r2: "Cloudflare R2 (Standard)", s3: "AWS S3 Standard (us-east-1)", b2: "Backblaze B2" };
/** One cost_per_gb_month_usd line, the way bench/cost/cost.mjs writes it (labels.is_store_provider says where the folder is). */
function costLine(provider, value, labels = {}, kpi = "cost_per_gb_month_usd", slice = {}) {
	return JSON.stringify({
		schema: "vt-kpi-point/1", kpi, t: "2026-11-04T12:00:00Z", value, n: 1, status: "measured",
		labels: { provider_name: NAMES[provider], ...labels }, source: { code_sha: "abc", bench_version: "t", run_ids: ["r"], dirty: false },
		slice: { env: "prod", provider, profile: "average", ...slice },
	});
}
function costModel(lines) {
	const dir = mkdtempSync(join(tmpdir(), "devview-cost-"));
	const kpi = join(dir, "kpi.jsonl");
	writeFileSync(kpi, lines.join("\n") + "\n");
	return model(kpi, "/nonexistent/gates.json");
}
const perGb = (m) => metric(m, "O3", "cost_per_gb_month_usd").env.prod;

test("O3: the headline is the cost on the provider the folder is on, the cheapest provider is a separate line", () => {
	const cell = perGb(costModel([
		costLine("r2", 0.015, { is_store_provider: true, folders: ["notes"] }),
		costLine("s3", 0.023, { is_store_provider: false }),
		costLine("b2", 0.007, { is_store_provider: false }),
	]));
	assert.equal(cell.value, 0.015);
	assert.equal(cell.provider, NAMES.r2);
	assert.deepEqual(cell.folders, ["notes"]);
	assert.deepEqual(cell.cheapest, { value: 0.007, provider: NAMES.b2 });
});

test("O3: folders on two providers show the dearer one as the headline (a cost is only met if every folder meets it)", () => {
	const cell = perGb(costModel([
		costLine("r2", 0.015, { is_store_provider: true, folders: ["notes"] }),
		costLine("s3", 0.023, { is_store_provider: true, folders: ["photos"] }),
		costLine("b2", 0.007, { is_store_provider: false }),
	]));
	assert.equal(cell.value, 0.023);
	assert.match(cell.provider, /AWS S3/);
	assert.match(cell.provider, /Cloudflare R2/);
	assert.deepEqual(cell.cheapest, { value: 0.007, provider: NAMES.b2 });
});

test("O3: a store nobody prices has no headline value, and says so; the cheapest provider is still shown", () => {
	const cell = perGb(costModel([
		costLine("r2", 0.015, { is_store_provider: false, store_unpriced: true }),
		costLine("b2", 0.007, { is_store_provider: false, store_unpriced: true }),
	]));
	assert.equal(cell.value, null);
	assert.equal(cell.unpriced, true);
	assert.deepEqual(cell.cheapest, { value: 0.007, provider: NAMES.b2 });
	const html = renderPage(costModel([costLine("r2", 0.015, { is_store_provider: false, store_unpriced: true })]));
	assert.match(html, /no price for this store/);
});

test("O3: person-month is judged on the folder's own provider, not on the cheapest", () => {
	const line = (provider, value, labels) => costLine(provider, value, labels, "cost_per_person_month_usd");
	const cell = metric(costModel([line("s3", 0.6, { is_store_provider: true, folders: ["notes"] }), line("b2", 0.1, { is_store_provider: false })]), "O3", "cost_per_person_month_usd").env.prod;
	assert.equal(cell.value, 0.6);
	assert.equal(cell.status, "amber", "over the $0.50 target on S3, though B2 would meet it");
	assert.deepEqual(cell.cheapest, { value: 0.1, provider: NAMES.b2 });
});

test("O3: points written before the store labels existed still read as the cheapest provider", () => {
	const cell = perGb(costModel([costLine("r2", 0.015), costLine("s3", 0.023)]));
	assert.equal(cell.value, 0.015);
	assert.equal(cell.cheapest, null);
});

test("the page names the provider under the cost and the cheapest one beside it", () => {
	const html = renderPage(costModel([
		costLine("s3", 0.023, { is_store_provider: true, folders: ["notes"] }),
		costLine("b2", 0.007, { is_store_provider: false }),
	]));
	const cell = html.slice(html.indexOf('data-cell="cost_per_gb_month_usd:prod"'));
	const text = cell.slice(0, cell.indexOf("</div>")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
	assert.match(text, /on AWS S3 Standard/);
	assert.match(text, /cheapest provider: Backblaze B2/);
});

// ---- history, the live stall check and competitor prices -----------------------------------------------------------------------

const { healthLines } = await import("./health-lines.mjs");
const { competitorLine } = await import("../../scripts/status-model.mjs");
const FIXTURES = join(root, "tests/fixtures/dev-view");
const withText = (text) => {
	const dir = mkdtempSync(join(tmpdir(), "devview-model-"));
	const file = join(dir, "series.jsonl");
	writeFileSync(file, text);
	return file;
};
const withHealth = (mode) => withText(readFileSync(KPI, "utf8") + healthLines(mode));
const healthOf = (mode) => buildModel(loadSources({ kpi: mode ? withHealth(mode) : KPI, gates: GATES }), { now: NOW }).health;

test("the KPI series points carry their commit and the whole measured history, for the history chart", () => {
	const series = metric(model(), "O1", "propagation_p50_ms").series.find((s) => s.env === "test" && s.label === "machine->machine · add");
	assert.ok(series.history.length >= series.points.length);
	assert.ok(series.history.every((p) => typeof p.t === "string" && typeof p.v === "number"));
	assert.equal(series.history.at(-1).sha, "770a9a21e3fa");
	assert.deepEqual(series.history.at(-1), { ...series.points.at(-1) });
});

test("health: a stalled folder is red and says why; healthy is ok; an offline gap is not red", () => {
	const ok = healthOf("ok");
	assert.equal(ok.status, "ok");
	assert.equal(ok.folders.result, "ok");
	assert.equal(ok.folders.checked, 3);
	assert.equal(ok.strip.length, 30);
	assert.deepEqual(ok.strip.filter((c) => c.result !== "ok").map((c) => c.result), ["offline"]);
	assert.equal(ok.stalledChecks, 0);
	assert.deepEqual(ok.lines, []);
	const red = healthOf("stalled");
	assert.equal(red.status, "red");
	assert.equal(red.folders.stalled[0].project, "zach");
	assert.equal(red.folders.stalled[0].cause, "lock");
	assert.equal(red.stalledChecks, 1);
	assert.match(red.lines[0], /^zach: 1 changed file not pushed for 14 min; a lock held by pid 4242/);
});

test("health: nothing for 90 minutes is 'not being checked', not fine; no points is 'none'", () => {
	assert.equal(healthOf("stale").status, "stale");
	assert.equal(healthOf(null).status, "none");
	assert.equal(healthOf(null).folders, null);
});

test("health points are not objectives: they add no card and no 'unknown KPI' note", () => {
	const m = buildModel(loadSources({ kpi: withHealth("ok"), gates: GATES }), { now: NOW });
	assert.equal(m.objectives.length, 3);
	assert.equal(m.warnings.filter((w) => /unknown KPI/.test(w)).length, 1); // the fixture's own unknown KPI, not the health ones
});

test("gate history: a column per run, oldest first, with the failing tests; a run with no result is its own state", () => {
	const m = buildModel(loadSources({ kpi: KPI, gates: GATES, history: join(FIXTURES, "gates-history.jsonl") }), { now: NOW });
	const h = m.gatesHistory;
	assert.equal(h.runs.length, 8);
	assert.deepEqual(h.runs.map((r) => r.source), ["local", "ci", "ci", "ci", "ci", "local", "ci", "ci"]);
	assert.equal(h.runs[1].gates.G1.status, "fail");
	assert.deepEqual(h.runs[1].gates.G1.failing, ["go ./e2e TestSharedTree"]);
	assert.equal(h.runs[2].hasResult, false);
	assert.equal(h.runs[2].gates.G3.status, "none");
	assert.equal(h.runs.at(-2).gates.G1.status, "pass");
	assert.match(h.runs[1].url, /^https:\/\//);
	const missing = buildModel(loadSources({ kpi: KPI, gates: GATES, history: "/nonexistent/h.jsonl" }), { now: NOW });
	assert.deepEqual([missing.gatesHistory.found, missing.gatesHistory.runs], [false, []]);
	const torn = buildModel(loadSources({ kpi: KPI, gates: GATES, history: withText("{torn\n{\"schema\":\"other\"}\n") }), { now: NOW });
	assert.equal(torn.gatesHistory.runs.length, 0);
	assert.ok(torn.warnings.some((w) => /2 lines of the gates history skipped/.test(w)));
});

test("competitor prices: rows by per-person price, folder-sync's own number beside them, one line for the three Zach named", () => {
	const m = buildModel(loadSources({ kpi: KPI, gates: GATES, competitors: join(FIXTURES, "competitors.json") }), { now: NOW });
	assert.deepEqual(m.competitors.items.map((i) => i.name), ["Fixture Drive A", "Fixture Box Plus", "Fixture Vault Sync"]);
	assert.deepEqual(m.competitors.items[0].tiers.map((t) => [t.storage_gb, t.price_usd_month, t.per_gb_month_usd]), [[100, 2, 0.02], [200, 3, 0.015], [2000, 10, 0.005]]);
	assert.deepEqual(m.competitors.items[1].tiers, [], "an item without tiers stays valid");
	assert.equal(m.competitors.own.per_person_month_10gb_usd, 0.15);
	assert.equal(m.competitors.own.env, "prod");
	assert.equal(m.competitors.line, "vs Fixture Drive A $2.00, Fixture Box Plus $12.00, Fixture Vault Sync $40.00 per person-month at 10 GB");
	const named = [{ vendor: "Dropbox", name: "Dropbox Plus", per_person_month_10gb_usd: 11.99 }, { vendor: "Google", name: "Google One", per_person_month_10gb_usd: 1.99 }, { vendor: "Obsidian", name: "Obsidian Sync", per_person_month_10gb_usd: 4 }, { vendor: "Box", name: "Box", per_person_month_10gb_usd: 5 }];
	assert.equal(competitorLine(named), "vs Dropbox Plus $11.99, Google One $1.99, Obsidian Sync $4.00 per person-month at 10 GB");
	const bad = buildModel(loadSources({ kpi: KPI, gates: GATES, competitors: withText('{"schema":"nope"}') }), { now: NOW });
	assert.equal(bad.competitors, null);
	assert.ok(bad.warnings.some((w) => /competitor prices ignored/.test(w)));
	assert.equal(model().competitors, null);
});

test("by size: the cheapest monthly plan per vendor that holds each size, and folder-sync's storage cost on R2 and B2", async () => {
	const { loadSources, buildModel, COMPARE_SIZES_GB } = await import("../../scripts/status-model.mjs");
	const root = new URL("../../", import.meta.url).pathname;
	const model = buildModel(loadSources({ competitors: `${root}bench/cost/competitors.json` }));
	const bs = model.competitors.bySize;
	assert.deepEqual(bs.rows.map((r) => r.size_gb), COMPARE_SIZES_GB);
	const at = (gb, vendor) => bs.rows.find((r) => r.size_gb === gb).cells.find((c) => c.vendor === vendor);
	assert.equal(at(2000, "Google").price_usd_month, 9.99, "Google 2 TB, monthly billing");
	assert.equal(at(1000, "Obsidian").price_usd_month, null, "Obsidian has no 1 TB plan");
	assert.equal(at(10, "Obsidian").billing, "monthly", "monthly where offered");
	const r2 = bs.rows.find((r) => r.size_gb === 2000).own.find((o) => o.provider === "r2");
	assert.equal(r2.price_usd_month, 30, "2000 GB x $0.015");
});
