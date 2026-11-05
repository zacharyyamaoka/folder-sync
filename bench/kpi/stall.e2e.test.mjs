// The passive stall check against the real engine on the local stack (node --test bench/kpi/stall.e2e.test.mjs): a quiet folder writes
// nothing, a change with the engine stopped goes "stalled" once it has waited (the test's bar is 3 s, not 10 minutes) and notifies once,
// a live process holding the lock is named as the cause, the engine pushing it again clears the episode and leaves a real propagation
// sample, and a machine with no route is "offline, not measured" with no alert. Skips when the stack's tools are not here.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { localStack } from "../latency/harness.mjs";
import { check, loadState } from "./stall.mjs";
import { findStateDir } from "./health.mjs";
import { readSeries, REPO } from "./lib.mjs";

const PROJECT = "stall-test";
const haveStack = existsSync(join(REPO, "accounts", "node_modules", ".bin", "cf-wrangler")) && existsSync(join(REPO, ".tools", "rclone"));
const SHA = { sha: "e2e", dirty: false };

// WHY free ports: the stack's defaults (4950-4953) are the hourly KPI run's and the Go e2e suite's; a check that fails because a peer holds a port says nothing
async function freePorts(count) {
	const servers = await Promise.all(Array.from({ length: count }, () => new Promise((resolve) => { const server = createServer(); server.listen(0, "127.0.0.1", () => resolve(server)); })));
	const ports = servers.map((server) => String(server.address().port));
	await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
	return ports;
}

test("the passive stall check on the local stack: quiet, stalled with the engine stopped, a held lock named, pushed again, offline", { skip: !haveStack && "needs accounts/node_modules and .tools/rclone (npm --prefix accounts ci; scripts/dev-tools)", timeout: 300_000 }, async () => {
	const scratch = mkdtempSync(join(tmpdir(), "stall-e2e-"));
	const sent = join(scratch, "sent.txt");
	process.env.FOLDER_SYNC_NOTIFY_CMD = JSON.stringify(["/bin/sh", "-c", `printf '%s@@' "$0 | $1" >> ${sent}`]);
	const [standin, store, accounts, inspector] = await freePorts(4);
	Object.assign(process.env, { FS_STANDIN_PORT: standin, FS_STORE_PORT: store, FS_ACCOUNTS_PORT: accounts, FS_INSPECTOR_PORT: inspector });
	const stack = await localStack({ sha: "stall", machines: 1, project: PROJECT, prefix: "folder-sync-stall-" });
	const [machine] = stack.machines;
	let sleeper = null;
	try {
		const tomlPath = join(machine.folder, ".folder-sync.toml");
		writeFileSync(tomlPath, readFileSync(tomlPath, "utf8").replace(/^interval\s*=.*$/m, 'interval = "1s"'));
		writeFileSync(join(machine.folder, "first.md"), "first\n");
		machine.must(["sync", "--once", "--dir", machine.folder]);
		const stateDir = findStateDir(machine.folder, machine.home);
		assert.ok(stateDir, "the project's state dir");

		const out = join(scratch, "series");
		const state = join(scratch, "state");
		const run = (extra = {}) => check({ machine, env: "test", out, stateDir: state, code: SHA, stallAfterMs: 3000, online: true, watchers: [], ...extra });
		const health = () => readSeries(out).filter((p) => p.kpi === "sync_stalled_folders");
		const notifications = () => (existsSync(sent) ? readFileSync(sent, "utf8").split("@@").filter(Boolean) : []);
		const only = (r) => r.folders.find((f) => f.project === PROJECT);

		// 1. quiet: nothing changed, so nothing is pending and the second check writes nothing
		const first = run();
		assert.equal(only(first).state, "idle");
		assert.equal(health().length, 1, "the first check writes its point");
		const second = run();
		assert.equal(only(second).state, "idle");
		assert.deepEqual(second.points, [], "a quiet folder writes nothing");
		assert.equal(health().length, 1);

		// 2. a change is saved and the engine is not running
		writeFileSync(join(machine.folder, "note.md"), "a change nobody pushes\n");
		const young = run();
		assert.equal(only(young).state, "pending");
		assert.equal(only(young).pending_files, 1);
		assert.deepEqual([young.points, young.alerts.fire], [[], []], "a young change is not a stall and writes nothing");
		await sleep(3500);
		const started = Date.now();
		const stalled = run();
		assert.ok(Date.now() - started < 30_000, "the check itself is local and quick");
		assert.deepEqual([only(stalled).state, only(stalled).cause], ["stalled", "no_rounds"]);
		assert.match(only(stalled).detail, /1 changed file not pushed for/);
		assert.deepEqual(stalled.alerts.fire, [`folder:${PROJECT}`]);
		assert.equal(notifications().length, 1);
		assert.match(notifications()[0], new RegExp(`${PROJECT}: 1 changed file not pushed`));
		assert.deepEqual(health().at(-1).labels.stalled.map((s) => s.cause), ["no_rounds"]);
		assert.equal(health().at(-1).value, 1);

		// the same episode five minutes on: no new notification and no new point
		const again = run();
		assert.equal(only(again).state, "stalled");
		assert.deepEqual([again.alerts.fire, again.points], [[], []]);
		assert.equal(notifications().length, 1, "one notification per episode");

		// 3. a live process holds the engine's lock: it is named as the cause
		sleeper = spawn("sleep", ["600"], { stdio: "ignore" });
		writeFileSync(join(stateDir, "lock"), `pid ${sleeper.pid} at ${new Date().toISOString()}\n`);
		const locked = run();
		assert.equal(only(locked).cause, "lock");
		assert.match(only(locked).detail, new RegExp(`lock held by pid ${sleeper.pid} \\(running\\)`));
		assert.deepEqual(locked.alerts.fire, [], "the same episode");
		assert.equal(health().at(-1).labels.stalled[0].cause, "lock", "the cause changed, so a point says so");

		// 4. the holder goes away and the engine pushes: the episode ends, and the push is a real propagation sample
		const gone = new Promise((resolve) => sleeper.once("exit", resolve)); // a killed child stays a zombie (and "alive" to kill -0) until it is reaped
		sleeper.kill("SIGKILL");
		await gone;
		sleeper = null;
		machine.must(["sync", "--once", "--dir", machine.folder]);
		const pushed = run();
		assert.equal(only(pushed).state, "idle");
		assert.deepEqual(pushed.alerts.resolved, [`folder:${PROJECT}`]);
		assert.equal(pushed.samples.length, 1);
		const real = readSeries(out).filter((p) => p.kpi === "propagation_p50_ms" && p.slice.op === "real");
		assert.equal(real.length, 1);
		assert.ok(real[0].value >= 3500 && real[0].value < 60_000, `the file waited about 4 s from save to push, got ${real[0].value} ms`);
		assert.deepEqual(real[0].slice, { env: "test", direction: "machine->web", op: "real" });
		assert.equal(health().at(-1).labels.result, "ok");
		assert.deepEqual(loadState(state).episodes, {});

		// 5. no route: offline, not measured, never red, no alert
		writeFileSync(join(machine.folder, "later.md"), "saved while offline\n");
		await sleep(3500);
		const offline = run({ online: false });
		assert.equal(only(offline).state, "offline");
		assert.deepEqual(offline.alerts.fire, []);
		assert.equal(notifications().length, 1);
		const last = health().at(-1);
		assert.deepEqual([last.status, last.labels.result, last.labels.reason], ["failed", "offline", "offline, not measured"]);
		// back online, the offline hours do not count as stalled time
		const back = run();
		assert.equal(only(back).state, "pending");
		assert.deepEqual(back.alerts.fire, []);
	} finally {
		sleeper?.kill("SIGKILL");
		stack.teardown();
		delete process.env.FOLDER_SYNC_NOTIFY_CMD;
		for (const name of ["FS_STANDIN_PORT", "FS_STORE_PORT", "FS_ACCOUNTS_PORT", "FS_INSPECTOR_PORT"]) delete process.env[name];
	}
});
