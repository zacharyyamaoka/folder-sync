// Request counting, CPU accounting and the run lock (node --test bench/).
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classOf, countRequests, treeTicks } from "./ops.mjs";
import { withLock } from "./lib.mjs";
import { averageProfile, changesPerDay, latestH } from "../cost/cost.mjs";

test("R2 classes: reads are B, deletes are free, writes and lists are A", () => {
	assert.equal(classOf("GetObject"), "class_b");
	assert.equal(classOf("HeadObject"), "class_b");
	assert.equal(classOf("DeleteObject"), "free");
	assert.equal(classOf("PutObject"), "class_a");
	assert.equal(classOf("ListObjectsV2"), "class_a");
	assert.equal(classOf("DeleteObjects"), "class_a");
});

test("countRequests: the stand-in's lines by class, wrangler's request lines for the Worker", () => {
	const gate = ['{"op":"GetObject"}', '{"op":"PutObject"}', '{"op":"PutObject"}', '{"op":"DeleteObject"}', "{torn"].join("\n");
	const worker = ["[wrangler:info] GET /fs/v1/me 200 OK (3ms)", "starting up", "[wrangler:info] POST /fs/v1/credentials 200 OK (9ms)"].join("\n");
	assert.deepEqual(countRequests({ gate, worker }), { class_a: 2, class_b: 1, free: 1, worker: 2 });
});

test("treeTicks reads this process's own CPU and grows when it works", () => {
	const before = treeTicks(process.pid);
	assert.ok(before > 0);
	const end = Date.now() + 120;
	while (Date.now() < end) Math.sqrt(Math.random());
	assert.ok(treeTicks(process.pid) > before);
});

test("withLock: a live holder makes a second run skip; a dead holder's lock is taken over", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kpi-lock-"));
	const file = join(dir, "lock");
	const inner = await withLock(file, async () => await withLock(file, () => "nested"));
	assert.equal(inner.skipped, false);
	assert.equal(inner.value.skipped, true);
	writeFileSync(file, `999999999 ${new Date().toISOString()}\n`);
	const taken = await withLock(file, () => "ran");
	assert.deepEqual(taken, { skipped: false, value: "ran" });
});

test("changesPerDay sums uploaded + deleted of ok rounds in the window; averageProfile builds from the account's own numbers", () => {
	const dir = mkdtempSync(join(tmpdir(), "kpi-logs-"));
	const now = new Date("2026-11-04T00:00:00Z");
	writeFileSync(join(dir, "p-1.log"), [
		"2026-11-03T10:00:00Z round ok=true uploaded=3 deleted=1 held=0",
		"2026-11-02T10:00:00Z round ok=true uploaded=10 deleted=0 held=0",
		"2026-11-03T11:00:00Z round ok=false uploaded=99 deleted=0 held=0",
		"2026-10-01T10:00:00Z round ok=true uploaded=500 deleted=0 held=0",
	].join("\n"));
	assert.deepEqual(changesPerDay(dir, 7, now), { per_day: 2, rounds: 2, days: 7 });
	const p = averageProfile({ usage: { live: { bytes: 2e9 } }, folders: { folders: [{ hosts: ["a", "b"] }, { hosts: ["b", "c"] }] }, logs: { per_day: 40, rounds: 5, days: 7 } });
	assert.deepEqual([p.live_gb, p.machines, p.changes_per_day], [2, 3, 40]);
	assert.equal(averageProfile({ usage: { live: { bytes: 0 } }, folders: null, logs: null }), null);
});

test("latestH takes the newest measured sample of a slice", () => {
	const mk = (t, value, env) => ({ kpi: "storage_efficiency_h", status: "measured", value, t, slice: { env } });
	assert.deepEqual(latestH([mk("2026-11-01T00:00:00Z", 5, "prod"), mk("2026-11-03T00:00:00Z", 2, "prod"), mk("2026-11-04T00:00:00Z", 9, "test")], { env: "prod" }), { h: 2, t: "2026-11-03T00:00:00Z" });
});
