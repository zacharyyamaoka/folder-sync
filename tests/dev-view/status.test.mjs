// The dev view's generator (scripts/status): the KPI series and the gate results in, one static page and a status.json out.
// Run: node --test tests/dev-view/status.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
