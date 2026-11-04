// The shared KPI plumbing: point shape, de-duplication, the rolling 30-day max (node --test bench/).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendPoints, KPI_NAMES, makePoint, percentile, readSeries, rollingMax } from "./lib.mjs";
import { catalog } from "./catalog.mjs";
import { propagationPoints } from "./propagation.mjs";

const source = { code_sha: "abc", bench_version: "t/1", run_ids: ["r1"], dirty: false };
const T = "2026-11-04T10:00:00-07:00";

test("makePoint: a vt-kpi-point/1 with a slice; a missing value is status failed and needs a reason", () => {
	const p = makePoint({ kpi: "storage_efficiency_h", value: 0.5, n: 1, t: T, source, slice: { env: "prod" } });
	assert.deepEqual([p.schema, p.status, p.value, p.slice], ["vt-kpi-point/1", "measured", 0.5, { env: "prod" }]);
	const failed = makePoint({ kpi: "storage_efficiency_h", value: null, n: 0, t: T, source, slice: { env: "prod" }, reason: "over quota" });
	assert.equal(failed.status, "failed");
	assert.equal(failed.labels.reason, "over quota");
	assert.throws(() => makePoint({ kpi: "storage_efficiency_h", value: null, n: 0, t: T, source, slice: { env: "prod" } }), /reason/);
	assert.throws(() => makePoint({ kpi: "not_a_kpi", value: 1, n: 1, t: T, source, slice: { env: "test" } }), /unknown kpi/);
	assert.throws(() => makePoint({ kpi: "storage_efficiency_h", value: 1, n: 1, t: T, source, slice: { env: "staging" } }), /env/);
});

test("appendPoints is idempotent: the same kpi + slice + run id is written once", () => {
	const dir = mkdtempSync(join(tmpdir(), "kpi-lib-"));
	const p = makePoint({ kpi: "idle_cpu_pct", value: 0.01, n: 1, t: T, source, slice: { env: "test" } });
	assert.deepEqual(appendPoints(dir, [p]), { written: 1, skipped: 0 });
	assert.deepEqual(appendPoints(dir, [p]), { written: 0, skipped: 1 });
	const other = makePoint({ kpi: "idle_cpu_pct", value: 0.02, n: 1, t: T, source: { ...source, run_ids: ["r2"] }, slice: { env: "test" } });
	assert.deepEqual(appendPoints(dir, [other]), { written: 1, skipped: 0 });
	assert.equal(readSeries(dir).length, 2);
});

test("readSeries skips a torn last line instead of failing", () => {
	const dir = mkdtempSync(join(tmpdir(), "kpi-lib-"));
	writeFileSync(join(dir, "kpi_series.jsonl"), `${JSON.stringify(makePoint({ kpi: "idle_cpu_pct", value: 1, n: 1, t: T, source, slice: { env: "test" } }))}\n{"schema":"vt-kp`);
	assert.equal(readSeries(dir).length, 1);
});

test("rollingMax: the largest measured value of a kpi/slice inside the window, none outside it", () => {
	const at = (t, value, env = "prod") => makePoint({ kpi: "storage_efficiency_h", value, n: 1, t, source, slice: { env } });
	const series = [at("2026-09-01T00:00:00Z", 99), at("2026-10-10T00:00:00Z", 3), at("2026-10-20T00:00:00Z", 1.5), at("2026-10-21T00:00:00Z", 70, "test"), at("2026-10-22T00:00:00Z", 2)];
	const r = rollingMax(series, { kpi: "storage_efficiency_h", slice: { env: "prod" }, days: 30, now: new Date("2026-11-04T00:00:00Z") });
	assert.deepEqual(r, { value: 3, n: 3 });
	assert.equal(rollingMax(series, { kpi: "storage_efficiency_h", slice: { env: "prod" }, days: 1, now: new Date("2026-11-04T00:00:00Z") }), null);
});

test("percentile is linear between ranks", () => {
	assert.equal(percentile([100, 200, 300, 400], 50), 250);
	assert.equal(percentile([], 50), null);
});

test("the catalog names every frozen KPI and keeps the legacy four", () => {
	const ids = catalog(T).kpis.map((k) => k.id);
	for (const name of KPI_NAMES) assert.ok(ids.includes(name), name);
	for (const legacy of ["sync_up_ms", "sync_down_ms", "sync_up_ms_p95", "sync_down_ms_p95"]) assert.ok(ids.includes(legacy), legacy);
});

test("propagationPoints: p50 and p95 per direction and op, plus mixed; all-timeout cells are failed", () => {
	const trials = [];
	for (const direction of ["machine->machine", "machine->web", "web->machine"]) {
		for (const op of ["add", "edit", "delete", "rename"]) for (const ms of [100, 200, 300, 400, 500]) trials.push({ direction, op, ms });
	}
	trials.push({ direction: "machine->web", op: "rename", ms: null, timeout: true });
	const pts = propagationPoints(trials, { env: "test", t: T, source, labels: { host: "h" } });
	assert.equal(pts.length, 3 * 5 * 2);
	const m2w = pts.find((p) => p.kpi === "propagation_p50_ms" && p.slice.direction === "machine->web" && p.slice.op === "mixed");
	assert.deepEqual([m2w.value, m2w.n, m2w.slice.env], [300, 20, "test"]);
	const dead = propagationPoints([{ direction: "machine->web", op: "add", ms: null, timeout: true }], { env: "prod", t: T, source, labels: {} });
	assert.ok(dead.every((p) => p.status === "failed" && p.value === null && /timed out/.test(p.labels.reason)));
});

test("the O2 test workload is deterministic: two builds write the same bytes, a round changes 12 notes + 6 logs + 1 blob", async () => {
	const { applyRound } = await import("./storage-test.mjs");
	const a = new Map();
	const b = new Map();
	applyRound(a, 0);
	applyRound(b, 0);
	assert.equal(a.size, 69);
	for (const [k, v] of a) assert.ok(v.equals(b.get(k)), k);
	const before = new Map(a);
	const changed = applyRound(a, 1);
	assert.deepEqual(applyRound(b, 1), changed);
	const really = [...a.keys()].filter((k) => !a.get(k).equals(before.get(k)));
	assert.ok(really.length >= 17 && really.length <= 19, `changed ${really.length}`);
	for (const k of really.filter((x) => x.startsWith("logs/"))) assert.ok(a.get(k).subarray(0, before.get(k).length).equals(before.get(k)), `${k} is an append`);
});

test("usagePoints: H is history over live; no live bytes is a failed point; the 30-day max follows", async () => {
	const { usagePoints, ratioOf } = await import("./usage.mjs");
	assert.equal(ratioOf({ live: { bytes: 100 }, history: { bytes: 50 } }).h, 0.5);
	assert.equal(ratioOf({ live: { bytes: 0 }, history: { bytes: 5 } }).h, null);
	const at = new Date("2026-11-04T18:00:00Z");
	const earlier = makePoint({ kpi: "storage_efficiency_h", value: 3, n: 1, t: "2026-10-30T00:00:00Z", source, slice: { env: "prod" } });
	const [h, max] = usagePoints({ usage: { live: { bytes: 100 }, history: { bytes: 50 }, used: { bytes: 150, objects: 3 }, quota: { bytes: 1e10 }, over: null }, series: [earlier], at, code: { sha: "abc", dirty: false } });
	assert.deepEqual([h.kpi, h.value, h.slice], ["storage_efficiency_h", 0.5, { env: "prod" }]);
	assert.deepEqual([max.kpi, max.value, max.n], ["storage_efficiency_h_30d_max", 3, 2]);
	const [down] = usagePoints({ usage: null, error: "GET /fs/v1/usage: 500", series: [], at, code: { sha: "abc", dirty: false } });
	assert.deepEqual([down.status, down.labels.reason], ["failed", "GET /fs/v1/usage: 500"]);
});

test("offShelfPoints: one p50 and p95 per tool/variant/direction from the 1 KB cells, folder-sync reduced to its headline series", async () => {
	const { offShelfPoints } = await import("./offshelf.mjs");
	const cell = (series, tool, variant, direction, p50) => ({ series, tool, variant, direction, workload: "1k", fault: null, status: "ok", n: 10, p50, p95: p50 * 2, lost: 0 });
	const summary = { tag: "t", schema: "s", bench_code: "c", cells: [cell("syncthing default", "syncthing", "default", "m2m", 900), cell("folder-sync push-debounce-1ms", "folder-sync", "push-debounce-1ms", "m2m", 5), cell("folder-sync push", "folder-sync", "push", "m2w", 400), cell("syncthing default", "syncthing", "default", "m2a", 1)] };
	const pts = offShelfPoints(summary, { t: T });
	assert.equal(pts.length, 4);
	assert.deepEqual(pts.map((p) => `${p.kpi}:${p.slice.tool}:${p.slice.direction}:${p.value}`).sort(), ["propagation_p50_ms:folder-sync:machine->web:400", "propagation_p50_ms:syncthing:machine->machine:900", "propagation_p95_ms:folder-sync:machine->web:800", "propagation_p95_ms:syncthing:machine->machine:1800"]);
});
