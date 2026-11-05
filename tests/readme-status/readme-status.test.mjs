// scripts/readme-status: the objectives and gates block of README.md (and of the landing page), generated from the KPI series
// and gates.json, never typed. Run: node --test tests/readme-status/readme-status.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const KPI = join(root, "tests/fixtures/readme-status/kpi-series.jsonl");
const GATES = join(root, "tests/fixtures/readme-status/gates.json");
const NOW = "2026-11-04T21:00:00Z";
const { loadSources, buildModel } = await import("../../scripts/status-model.mjs");
const { formatValue, statusView, renderMarkdown, renderHtml, replaceBlock, BEGIN, END } = await import("../../scripts/readme-status.mjs");

const model = (kpi = KPI, gates = GATES) => buildModel(loadSources({ kpi, gates }), { now: NOW });
const view = (kpi, gates) => statusView(model(kpi, gates));
const row = (v, kpi) => v.objectives.flatMap((o) => o.rows).find((r) => r.kpi === kpi);

test("formatValue: milliseconds become seconds from one second up, ratios and money keep what a reader needs", () => {
	const ms = { unit: "ms" };
	assert.equal(formatValue(ms, 293), "293 ms");
	assert.equal(formatValue(ms, 999.4), "999 ms");
	assert.equal(formatValue(ms, 1000), "1.0 s");
	assert.equal(formatValue(ms, 5154), "5.2 s");
	assert.equal(formatValue(ms, 15102), "15 s");
	assert.equal(formatValue({ unit: "ratio" }, 0.07415), "0.07");
	assert.equal(formatValue({ unit: "ratio" }, 68.04451), "68");
	assert.equal(formatValue({ unit: "usd" }, 0.31870), "$0.32");
	assert.equal(formatValue({ unit: "usd" }, 0.017459), "$0.017");
	assert.equal(formatValue({ unit: "pct" }, 0.089), "0.089 %");
	assert.equal(formatValue({ unit: "ops" }, 122.974), "123");
	assert.equal(formatValue({ unit: "ms" }, null), "not measured yet");
});

test("O1: the headline is folder-sync's own slowest direction; a competitor on the same rig never becomes the headline", () => {
	const v = view();
	const p50 = row(v, "propagation_p50_ms");
	assert.equal(p50.test.text, "293 ms");
	assert.equal(p50.test.verdict, "met");
	assert.equal(p50.prod.text, "5.2 s");
	assert.equal(p50.prod.verdict, "missed");
	const p95 = row(v, "propagation_p95_ms");
	assert.equal(p95.test.text, "450 ms");
	assert.equal(p95.prod.text, "38 s");
	assert.equal(p95.prod.verdict, "missed");
	assert.equal(p95.prod.lastRunFailed, true, "a later failed run is said, next to the last good value");
});

test("the competitor rows stay in the series table, only the headline leaves them out", () => {
	const p50 = model().objectives[0].metrics[0];
	const rivals = p50.series.filter((s) => s.slice.tool !== undefined);
	assert.deepEqual(rivals.map((s) => `${s.slice.tool}:${s.latest}`), ["lsyncd:15102"]);
	assert.equal(p50.env.test.nSeries, 2, "the headline counts folder-sync's own two directions");
});

test("O2 and O3 rows carry the numbers of the series, the verdict only where a target exists", () => {
	const v = view();
	const h = row(v, "storage_efficiency_h_30d_max");
	assert.equal(h.target, "≤ 1.0 (stretch ≤ 0.25)");
	assert.deepEqual([h.test.text, h.test.verdict, h.prod.text, h.prod.verdict], ["1.51", "missed", "68", "missed"]);
	assert.equal(row(v, "storage_efficiency_h").prod.verdict, "");
	const perGb = row(v, "cost_per_gb_month_usd");
	assert.deepEqual([perGb.test.text, perGb.prod.text, perGb.target], ["$0.017", "$0.92", "no number set; lower is better"]);
	const person = row(v, "cost_per_person_month_usd");
	assert.deepEqual([person.test.text, person.test.verdict, person.prod.text, person.prod.verdict], ["$0.22", "met", "$0.32", "met"]);
	const cpu = row(v, "idle_cpu_pct");
	assert.equal(cpu.test.verdict, "met");
	assert.equal(cpu.prod.text, "could not be measured");
	assert.equal(cpu.prod.verdict, "failed");
	assert.equal(row(v, "idle_ops_per_hour").prod.text, "not measured yet");
});

test("the gates: all twelve in order, a plain-language line each, 'not built yet' named for what it is", () => {
	const v = view();
	assert.deepEqual(v.gates.map((g) => g.id), ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10", "G11", "G12"]);
	assert.deepEqual(v.gateCounts, { pass: 8, fail: 1, not_built: 2, skipped: 1, unknown: 0 });
	const g4 = v.gates.find((g) => g.id === "G4");
	assert.equal(g4.word, "not built yet");
	assert.equal(g4.detail, "4 passed, 1 skipped, 1 proof not built", "the summary stops before the list of what is missing");
	assert.match(g4.what, /Linux, macOS and Windows/);
	assert.equal(v.gates.find((g) => g.id === "G6").word, "FAIL");
	assert.equal(v.gates.find((g) => g.id === "G8").word, "left out of this run");
});

test("markdown: the headline lines, the objectives table and the gates table", () => {
	const md = renderMarkdown(view());
	assert.match(md, /8 of 12 gates pass, 1 fails, 2 are not built yet, 1 was left out of this run/);
	assert.match(md, /^\| Objective \| What is measured \| Target \| Test \| Production \|$/m);
	assert.match(md, /^\| \*\*O1 Fast\*\* \| .*median \(p50\).* \| ≤ 1 s \| 293 ms, met \| 5\.2 s, missed \|$/m);
	assert.match(md, /^\|  \| .*95th percentile \(p95\).* \| ≤ 3 s \| 450 ms, met \| 38 s, missed; the latest run failed \|$/m);
	assert.match(md, /^\| \*\*O3 Cost per GB\*\* \|/m);
	assert.match(md, /^\| Gate \| What it checks \| Status \|$/m);
	assert.match(md, /^\| \*\*G1\*\* Nothing lost \| .* \| pass \(77 passed\) \|$/m);
	assert.match(md, /^\| \*\*G6\*\* Headless \| .* \| \*\*FAIL\*\* \(1 failed: fresh machine did not sync\) \|$/m);
	assert.match(md, /^\| \*\*G4\*\* Cross-platform \| .* \| not built yet \(4 passed, 1 skipped, 1 proof not built\) \|$/m);
	assert.match(md, /2026-11-04 20:17 UTC/, "the newest production measurement is dated");
	assert.match(md, /2026-11-04 20:56 UTC/, "so is the gate run");
	assert.match(md, /`bb601e2`/, "with the commit it ran on");
	assert.ok(!md.includes(BEGIN) && !md.includes(END));
	assert.ok(!/\p{Extended_Pictographic}/u.test(md), "no emoji");
});

test("html: escapes what the sources say, links gates to docs, marks each cell by its verdict", () => {
	const html = renderHtml(view(), { linkBase: "https://example.test/blob/main/" });
	assert.ok(!html.includes("<b>"), "the <b> in G10's summary is escaped");
	assert.ok(html.includes("69 passed &lt;b&gt;"));
	assert.match(html, /href="https:\/\/example\.test\/blob\/main\/docs\/GATES\.md#the-twelve"/);
	for (const id of ["G1", "G12"]) assert.ok(html.includes(`data-gate="${id}"`));
	assert.match(html, /class="cell met"[^>]*>293 ms/);
	assert.match(html, /class="cell missed"[^>]*>5\.2 s/);
	assert.match(html, /class="gate g-notbuilt"/);
	assert.match(html, /class="gate g-fail"/);
	assert.doesNotMatch(html, /<script|<style|src="https?:/);
});

test("replaceBlock: replaces only between the markers, keeps the text around, refuses a missing or doubled marker", () => {
	const doc = `before\n${BEGIN}\nold\n${END}\nafter\n`;
	assert.equal(replaceBlock(doc, "new"), `before\n${BEGIN}\nnew\n${END}\nafter\n`);
	assert.equal(replaceBlock(replaceBlock(doc, "new"), "new"), replaceBlock(doc, "new"), "idempotent");
	assert.throws(() => replaceBlock("no markers", "x"), /status:begin/);
	assert.throws(() => replaceBlock(`${doc}${doc}`, "x"), /more than once/);
	assert.throws(() => replaceBlock(`${END}\n${BEGIN}\n`, "x"), /status:end/);
});

test("missing sources: every cell says 'not measured yet' and every gate 'no result', nothing throws", () => {
	const v = view("/nonexistent/kpi.jsonl", "/nonexistent/gates.json");
	assert.equal(row(v, "propagation_p50_ms").test.text, "not measured yet");
	assert.ok(v.gates.every((g) => g.word === "no result"));
	assert.match(renderMarkdown(v), /no gate results yet/);
	assert.ok(renderHtml(v, {}).length > 100);
});

test("CLI: rewrites the README block and the landing block, only those; --check fails on a stale file and writes nothing", () => {
	const dir = mkdtempSync(join(tmpdir(), "readme-status-"));
	const readme = join(dir, "README.md");
	const landing = join(dir, "index.html");
	writeFileSync(readme, `# title\n\nintro stays\n\n${BEGIN}\nstale\n${END}\n\ntail stays\n`);
	writeFileSync(landing, `<html><body>\n<main>\n${BEGIN}\nstale\n${END}\n</main>\n</body></html>\n`);
	const run = (...args) => spawnSync(join(root, "scripts/readme-status"), ["--kpi", KPI, "--gates", GATES, "--now", NOW, "--readme", readme, "--assets", join(dir, "assets"), ...args], { encoding: "utf8" });

	const stale = run("--landing", landing, "--check");
	assert.equal(stale.status, 1, stale.stderr);
	assert.match(readFileSync(readme, "utf8"), /stale/, "--check writes nothing");

	const wrote = run("--landing", landing);
	assert.equal(wrote.status, 0, wrote.stderr);
	const md = readFileSync(readme, "utf8");
	assert.ok(md.startsWith("# title\n\nintro stays\n\n"));
	assert.ok(md.endsWith("\n\ntail stays\n"));
	assert.match(md, /293 ms, met/);
	const page = readFileSync(landing, "utf8");
	assert.match(page, /class="cell met"/);
	assert.match(page, /href="https:\/\/github\.com\/zacharyyamaoka\/folder-sync\/blob\/main\/docs\/GATES\.md#the-twelve"/);

	assert.equal(run("--landing", landing, "--check").status, 0, "up to date after a write");
	assert.equal(run("--bogus").status, 2);
	const unmarked = join(dir, "NOMARK.md");
	writeFileSync(unmarked, "nothing here\n");
	assert.equal(spawnSync(join(root, "scripts/readme-status"), ["--kpi", KPI, "--gates", GATES, "--readme", unmarked, "--assets", join(dir, "assets")], { encoding: "utf8" }).status, 2);
});

test("the repository's README carries the markers once and its block is what the script would write today", () => {
	const text = readFileSync(join(root, "README.md"), "utf8");
	assert.equal(text.split(BEGIN).length - 1, 1);
	assert.equal(text.split(END).length - 1, 1);
	// the block is regenerated from live sources by scripts/readme-status; here only that it is non-empty and has the three objectives
	const block = text.slice(text.indexOf(BEGIN), text.indexOf(END));
	for (const id of ["O1", "O2", "O3"]) assert.ok(block.includes(`**${id} `), `${id} is in the README block`);
	for (let n = 1; n <= 12; n++) assert.ok(block.includes(`**G${n}**`), `G${n} is in the README block`);
});

test("CLI: --readme none rewrites only the landing page (how the gh-pages branch uses it)", () => {
	const dir = mkdtempSync(join(tmpdir(), "readme-status-landing-"));
	const landing = join(dir, "index.html");
	writeFileSync(landing, `<main>\n${BEGIN}\n${END}\n</main>\n`);
	const done = spawnSync(join(root, "scripts/readme-status"), ["--kpi", KPI, "--gates", GATES, "--now", NOW, "--readme", "none", "--landing", landing], { encoding: "utf8" });
	assert.equal(done.status, 0, done.stderr);
	assert.match(readFileSync(landing, "utf8"), /class="cell met"/);
	assert.doesNotMatch(done.stdout, /README/);
});

// a copy of the fixtures survives being passed by relative path (the CLI resolves --kpi/--gates from the cwd)
test("CLI accepts relative source paths", () => {
	const dir = mkdtempSync(join(tmpdir(), "readme-status-rel-"));
	copyFileSync(KPI, join(dir, "k.jsonl"));
	copyFileSync(GATES, join(dir, "g.json"));
	const readme = join(dir, "README.md");
	writeFileSync(readme, `${BEGIN}\n${END}\n`);
	execFileSync(join(root, "scripts/readme-status"), ["--kpi", "k.jsonl", "--gates", "g.json", "--now", NOW, "--readme", readme, "--assets", join(dir, "assets")], { cwd: dir });
	assert.match(readFileSync(readme, "utf8"), /8 of 12 gates pass/);
});

// ---- history: sparklines per objective, the gate strip, the competitor line ---------------------------------------------------------

const HISTORY = join(root, "tests/fixtures/dev-view/gates-history.jsonl");
const PRICES = join(root, "tests/fixtures/dev-view/competitors.json");
const { sparkSvg, historySvg, assetFiles } = await import("../../scripts/readme-status.mjs");
const withExtras = () => statusView(buildModel(loadSources({ kpi: KPI, gates: GATES, history: HISTORY, competitors: PRICES }), { now: NOW }));

test("a sparkline per objective on its headline measure: both envs, the target dashed, a title that says the same numbers", () => {
	const v = withExtras();
	assert.deepEqual(v.sparks.map((s) => s.id), ["O1", "O2", "O3"]);
	const o1 = v.sparks[0];
	assert.equal(o1.kpi, "propagation_p50_ms");
	assert.deepEqual([o1.ends.test, o1.ends.prod], ["293 ms", "5.2 s"]);
	const svg = sparkSvg(o1);
	assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
	assert.match(svg, /<title>Save to bytes elsewhere, p50, last 30 days: test 293 ms, production 5\.2 s; target ≤ 1 s<\/title>/);
	assert.equal((svg.match(/<path /g) ?? []).length, 2, "a test line and a production line");
	assert.match(svg, /stroke-dasharray="4 3"/, "the target");
	assert.ok(!/<script|onload/i.test(svg));
	const noData = sparkSvg({ ...o1, test: [], prod: [], target: null });
	assert.ok(!/<path/.test(noData), "no points, no line: nothing is drawn that was not measured");
});

test("the gate strip: a cell per gate and run, green red grey, and a title naming what failed", () => {
	const v = withExtras();
	assert.equal(v.history.runs.length, 6, "runs with a result only (a run with no gates file is not drawn as a pass or a fail)");
	assert.deepEqual(v.history.failedGates, ["G1", "G4", "G7", "G11"]);
	const svg = historySvg(v.history);
	assert.equal((svg.match(/<rect /g) ?? []).length, 12 * 6);
	assert.equal((svg.match(/fill="#d03b3b"/g) ?? []).length, 7, "seven failing cells in the fixture's runs");
	assert.match(svg, /failed in at least one run: G1, G4, G7, G11/);
});

test("markdown links the SVGs, names the competitors, and the assets are the files it links to", () => {
	const v = withExtras();
	const md = renderMarkdown(v);
	assert.match(md, /<img src="docs\/status\/spark-o1\.svg" alt="Save to bytes elsewhere, p50, last 30 days: test 293 ms, production 5\.2 s"/);
	assert.match(md, /<img src="docs\/status\/gate-history\.svg" alt="Gate history, the last 6 runs; G1, G4, G7, G11 failed in at least one"/);
	assert.match(md, /Cost, compared: folder-sync against Fixture Drive A \$2\.00, Fixture Box Plus \$12\.00, Fixture Vault Sync \$40\.00 per person-month at 10 GB \(list prices as of 2026-11-04\)\./);
	assert.deepEqual(Object.keys(assetFiles(v)).sort(), ["gate-history.svg", "spark-o1.svg", "spark-o2.svg", "spark-o3.svg"]);
	assert.match(md, /^\| Objective \| What is measured \| Target \| Test \| Production \|$/m, "the table itself is unchanged");
	const html = renderHtml(v);
	assert.match(html, /<svg class="spark"/);
	assert.match(html, /<svg class="gate-strip"/);
	assert.match(html, /<p class="vs">vs Fixture Drive A/);
	assert.ok(!/<img/.test(html), "the landing page draws them inline");
});

test("without history or prices the block says nothing about them", () => {
	const v = view();
	assert.equal(v.history, null);
	assert.equal(v.competitors, null);
	const md = renderMarkdown(v);
	assert.ok(!/Gate history|Cost, compared/.test(md));
});

test("CLI writes the SVG assets and --check calls a missing or changed one stale", () => {
	const dir = mkdtempSync(join(tmpdir(), "readme-status-assets-"));
	const readme = join(dir, "README.md");
	writeFileSync(readme, `${BEGIN}\n${END}\n`);
	const args = ["--kpi", KPI, "--gates", GATES, "--history", HISTORY, "--competitors", PRICES, "--now", NOW, "--readme", readme, "--assets", join(dir, "assets")];
	assert.equal(spawnSync(join(root, "scripts/readme-status"), [...args, "--check"], { encoding: "utf8" }).status, 1);
	assert.equal(spawnSync(join(root, "scripts/readme-status"), args, { encoding: "utf8" }).status, 0);
	assert.match(readFileSync(join(dir, "assets", "spark-o1.svg"), "utf8"), /^<svg /);
	assert.equal(spawnSync(join(root, "scripts/readme-status"), [...args, "--check"], { encoding: "utf8" }).status, 0);
	writeFileSync(join(dir, "assets", "gate-history.svg"), "<svg/>\n");
	assert.equal(spawnSync(join(root, "scripts/readme-status"), [...args, "--check"], { encoding: "utf8" }).status, 1);
});
