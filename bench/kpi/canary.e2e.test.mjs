// The live stall check against the real engine on the local stack (node --test bench/kpi/canary.e2e.test.mjs): a healthy folder is
// timed online, a folder whose lock is held by a live process goes "stalled" within the (short) timeout and alerts once, it recovers,
// and a machine with no route to the server is "offline, not measured" with no alert. Skips when the stack's tools are not here.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localStack } from "../latency/harness.mjs";
import { check } from "./canary.mjs";
import { findStateDir } from "./health.mjs";
import { CANARY_PROJECT } from "./health.mjs";
import { readSeries, REPO } from "./lib.mjs";

const haveStack = existsSync(join(REPO, "accounts", "node_modules", ".bin", "cf-wrangler")) && existsSync(join(REPO, ".tools", "rclone"));
const SHA = { sha: "e2e", dirty: false };

test("the stall check on the local stack: ok, stalled by a held lock (one alert), recovered, offline", { skip: !haveStack && "needs accounts/node_modules and .tools/rclone (npm --prefix accounts ci; scripts/dev-tools)", timeout: 300_000 }, async () => {
	const scratch = mkdtempSync(join(tmpdir(), "canary-e2e-"));
	const sent = join(scratch, "sent.txt");
	process.env.FOLDER_SYNC_NOTIFY_CMD = JSON.stringify(["/bin/sh", "-c", `printf '%s@@' "$0 | $1" >> ${sent}`]);
	const stack = await localStack({ sha: "canary", machines: 1, project: CANARY_PROJECT, prefix: "folder-sync-canary-" });
	const [machine] = stack.machines;
	let sleeper = null;
	try {
		// a second between rounds keeps the test short; the canary's own folder runs at the default 10 s
		const tomlPath = join(machine.folder, ".folder-sync.toml");
		writeFileSync(tomlPath, readFileSync(tomlPath, "utf8").replace(/^interval\s*=.*$/m, 'interval = "1s"'));
		const out = join(scratch, "series");
		const common = { machine, server: stack.server, token: machine.token(), env: "test", out, stateDir: join(scratch, "state"), code: SHA, pollMs: 100, stallAfterMs: 2000 };
		const episodes = () => { try { return Object.keys(JSON.parse(readFileSync(join(scratch, "state", "canary-alerts.json"), "utf8")).episodes); } catch { return []; } };
		const notifications = () => (existsSync(sent) ? readFileSync(sent, "utf8").split("@@").filter(Boolean) : []);

		// one of "Zach's own folders" beside the canary's: synced once, then it is only ever looked at
		const notes = join(machine.home, "notes");
		mkdirSync(notes, { recursive: true });
		writeFileSync(join(notes, "a.txt"), "a note\n");
		machine.must(["init", "--project", "notes", "--dir", notes]);
		const notesToml = join(notes, ".folder-sync.toml");
		writeFileSync(notesToml, readFileSync(notesToml, "utf8").replace(/^interval\s*=.*$/m, 'interval = "1s"'));
		machine.must(["sync", "--once", "--dir", notes]);

		// 1. healthy: the file reaches the Worker and its time is recorded
		const healthy = await check({ ...common, timeoutMs: 60_000 });
		assert.equal(healthy.canary.result, "ok", JSON.stringify(healthy.canary));
		assert.ok(healthy.canary.value > 0 && healthy.canary.value < 30_000, `canary took ${healthy.canary.value} ms`);
		assert.deepEqual(healthy.folders.map((f) => [f.project, f.state]).sort(), [[CANARY_PROJECT, "skipped"], ["notes", "ok"]]); // the canary's own folder is its own check
		assert.deepEqual(healthy.alerts.fire, []);

		// 2. the engine's lock is held by a process that is alive and does nothing: no round can run
		sleeper = spawn("sleep", ["600"], { stdio: "ignore" });
		const stateDir = findStateDir(machine.folder, machine.home);
		assert.ok(stateDir, "the canary project's state dir");
		const held = `pid ${sleeper.pid} at ${new Date().toISOString()}\n`;
		writeFileSync(join(stateDir, "lock"), held);
		writeFileSync(join(findStateDir(notes, machine.home), "lock"), held);
		const started = Date.now();
		const stalled = await check({ ...common, timeoutMs: 12_000 });
		const took = Date.now() - started;
		assert.equal(stalled.canary.result, "stalled", JSON.stringify(stalled.canary));
		assert.ok(took < 12_000 + 20_000, `the check gave its verdict after ${took} ms, the timeout was 12 s`);
		assert.ok(["lock", "no_propagation", "engine_exited"].includes(stalled.canary.cause), stalled.canary.cause);
		console.error(`canary stalled in ${took} ms, cause ${stalled.canary.cause}: ${stalled.canary.detail}`);
		// the folder next to it: its last clean round is older than the (2 s) bar and a live process holds its lock
		const quiet = stalled.folders.find((f) => f.project === "notes");
		assert.deepEqual([quiet.state, quiet.cause], ["stalled", "lock"]);
		assert.match(quiet.detail, new RegExp(`lock held by pid ${sleeper.pid} \\(running\\)`));
		assert.deepEqual(stalled.alerts.fire.sort(), ["canary", "folder:notes"]);
		assert.equal(notifications().length, 1, "one notification for the whole episode start");
		assert.match(notifications()[0], /notes: .*lock held by pid/);
		assert.deepEqual(episodes().sort(), ["canary", "folder:notes"]);
		const point = readSeries(out).filter((p) => p.kpi === "sync_canary_ms").at(-1);
		assert.deepEqual([point.status, point.value, point.labels.result, point.slice.env], ["failed", null, "stalled", "test"]);

		// the second check of the same episode does not notify again
		const again = await check({ ...common, timeoutMs: 4000 });
		assert.equal(again.canary.result, "stalled");
		assert.deepEqual(again.alerts.fire, []);
		assert.equal(notifications().length, 1, "one notification per episode");

		// 3. the holder goes away: the engine takes the dead lock itself and the file arrives
		sleeper.kill("SIGKILL");
		sleeper = null;
		const recovered = await check({ ...common, timeoutMs: 60_000 });
		assert.equal(recovered.canary.result, "ok", JSON.stringify(recovered.canary));
		assert.deepEqual(recovered.alerts.resolved, ["canary"]);
		assert.deepEqual(episodes(), ["folder:notes"], "the notes folder is still stalled: nothing has run a round for it");

		// 4. no route to the server: offline, not measured, never red, no alert
		const offline = await check({ ...common, server: "http://127.0.0.1:1", timeoutMs: 4000, probeTimeoutMs: 1500 });
		assert.equal(offline.canary.result, "offline");
		assert.deepEqual(offline.alerts.fire, []);
		assert.equal(notifications().length, 1);
		const last = readSeries(out).filter((p) => p.kpi === "sync_canary_ms").at(-1);
		assert.deepEqual([last.status, last.labels.result, last.labels.reason], ["failed", "offline", "offline, not measured"]);
	} finally {
		sleeper?.kill("SIGKILL");
		await machine.stop();
		stack.teardown();
		delete process.env.FOLDER_SYNC_NOTIFY_CMD;
	}
});
