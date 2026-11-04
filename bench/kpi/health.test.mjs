// The live stall check's verdicts (node --test bench/kpi/health.test.mjs): canary ok / stalled / offline and its causes, a folder's
// verdict from its last clean round and its lock, one alert per stall episode, and the shape of the points.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { alert, notify, probeServer, unitFiles } from "./canary.mjs";
import {
	alertText, busyHolder, classifyCanary, classifyFolder, classifyReachability, describeLock, healthPoints, lockFromText, nextEpisodes, parseInterval, STALL_AFTER_MS,
} from "./health.mjs";
import { makePoint, sourceOf } from "./lib.mjs";

const NOW = Date.parse("2026-11-04T20:00:00Z");
const MIN = 60_000;
const online = classifyReachability({ state: "http", status: 200, over: null });
const iso = (minutesAgo) => new Date(NOW - minutesAgo * MIN).toISOString();
const last = (minutesAgo, extra = {}) => ({ ok: true, round_started: iso(minutesAgo), round_finished: iso(minutesAgo), last_clean_run: iso(minutesAgo), ...extra });
const folder = (over) => classifyFolder({ project: "zach", folder: "/home/me/zach", now: NOW, online: true, dirExists: true, last: last(0.1), intervalMs: 10_000, lock: null, ...over });

test("reachability: no route is offline; 401 is signed out; 5xx is a server error; 200 carries the quota verdict", () => {
	assert.equal(classifyReachability({ state: "network" }).state, "offline");
	assert.equal(classifyReachability({ state: "http", status: 401 }).state, "auth");
	assert.equal(classifyReachability({ state: "http", status: 502 }).state, "server_error");
	assert.equal(classifyReachability({ state: "http", status: 200, over: "storage" }).quotaOver, "storage");
});

test("canary: visible online is ok with its time", () => {
	assert.deepEqual(classifyCanary({ reach: online, visibleMs: 812.4, timeoutMs: 600_000 }), { result: "ok", cause: null, detail: "", value: 812 });
});

test("canary: not online by the timeout is stalled, and says what it could see", () => {
	const plain = classifyCanary({ reach: online, visibleMs: null, reachAfter: online, timeoutMs: 600_000, engine: { exited: false, log: "Watching /x every 10s" } });
	assert.deepEqual([plain.result, plain.cause, plain.value], ["stalled", "no_propagation", null]);
	assert.match(plain.detail, /not online after 600 s/);
	const locked = classifyCanary({ reach: online, visibleMs: null, reachAfter: online, timeoutMs: 600_000, engine: { exited: false, log: "round failed: another folder-sync round is running for this folder (/h/.folder-sync/projects/c/lock: pid 4242 at 2026-11-04T19:00:00Z)" } });
	assert.equal(locked.cause, "lock");
	assert.match(locked.detail, /pid 4242 at 2026-11-04T19:00:00Z/);
	const dead = classifyCanary({ reach: online, visibleMs: null, reachAfter: online, timeoutMs: 600_000, engine: { exited: true, code: 1, log: "boom\nfatal: rclone not found" } });
	assert.equal(dead.cause, "engine_exited");
	assert.match(dead.detail, /rclone not found/);
});

test("canary: offline is not measured, never stalled, before the check and when the network drops during it", () => {
	const off = classifyReachability({ state: "network" });
	assert.deepEqual(classifyCanary({ reach: off, visibleMs: null, timeoutMs: 600_000 }), { result: "offline", cause: "offline", detail: "offline, not measured", value: null });
	const drop = classifyCanary({ reach: online, visibleMs: null, reachAfter: off, timeoutMs: 600_000, engine: { exited: false, log: "" } });
	assert.equal(drop.result, "offline");
});

test("canary: an over-quota account or a signed-out machine is stalled at once, with that cause", () => {
	const quota = classifyCanary({ reach: classifyReachability({ state: "http", status: 200, over: "storage 10.4 GiB of 10 GiB" }), visibleMs: null, timeoutMs: 600_000 });
	assert.deepEqual([quota.result, quota.cause], ["stalled", "quota"]);
	const auth = classifyCanary({ reach: classifyReachability({ state: "http", status: 401 }), visibleMs: null, timeoutMs: 600_000 });
	assert.deepEqual([auth.result, auth.cause], ["stalled", "auth"]);
});

test("a lock file: its holder, its age, and whether the holder is running", () => {
	const mtimeMs = NOW - 90 * MIN;
	const live = lockFromText(`pid 77 at ${iso(14)}\n`, { mtimeMs, now: NOW, alive: (pid) => pid === 77 });
	assert.deepEqual([live.pid, live.alive, Math.round(live.ageMs / MIN), live.empty], [77, true, 14, false]);
	assert.equal(describeLock(live), "a lock held by pid 77 (running) for 14 min");
	const gone = lockFromText(`pid 78 at ${iso(14)}\n`, { mtimeMs, now: NOW, alive: () => false });
	assert.match(describeLock(gone), /pid 78, which is gone/);
	const empty = lockFromText("", { mtimeMs, now: NOW, alive: () => true });
	assert.deepEqual([empty.empty, empty.alive, Math.round(empty.ageMs / MIN)], [true, false, 90]);
	assert.match(describeLock(empty), /empty lock .* 90 min old/);
});

test("folder: a clean round a few seconds ago is ok", () => {
	const v = folder({});
	assert.equal(v.state, "ok");
});

test("folder: no clean round for more than 10 minutes while online is stalled; at 9 it is not", () => {
	assert.equal(folder({ last: last(9) }).state, "ok");
	const v = folder({ last: last(11) });
	assert.deepEqual([v.state, v.cause], ["stalled", "no_rounds"]);
	assert.match(v.detail, /no round completed for 11 min/);
});

test("folder: a held lock is the named cause, with pid and age; a dead holder and an empty lock too", () => {
	const mtimeMs = NOW - 30 * MIN;
	const held = folder({ last: last(25), lock: lockFromText(`pid 91 at ${iso(25)}\n`, { mtimeMs, now: NOW, alive: () => true }) });
	assert.deepEqual([held.state, held.cause], ["stalled", "lock"]);
	assert.match(held.detail, /lock held by pid 91 \(running\) for 25 min/);
	const emptyLock = folder({ last: last(40), lock: lockFromText("", { mtimeMs, now: NOW, alive: () => true }) });
	assert.equal(emptyLock.cause, "lock");
	assert.match(emptyLock.detail, /empty lock/);
});

test("folder: a round that has been running (holding its lock) for over 10 minutes is stalled even though the last clean round is recent", () => {
	const lock = lockFromText(`pid 91 at ${iso(12)}\n`, { mtimeMs: NOW - 12 * MIN, now: NOW, alive: () => true });
	const v = folder({ last: last(3), lock });
	assert.deepEqual([v.state, v.cause], ["stalled", "lock"]);
	const short = folder({ last: last(3), lock: lockFromText(`pid 91 at ${iso(2)}\n`, { mtimeMs: NOW - 2 * MIN, now: NOW, alive: () => true }) });
	assert.equal(short.state, "ok");
});

test("folder: quota, signed out and failing rounds are named", () => {
	assert.equal(folder({ last: last(30), quotaOver: "storage" }).cause, "quota");
	assert.equal(folder({ last: last(30), signedIn: false }).cause, "auth");
	const failing = { ok: false, error: "rclone: 500 internal", round_started: iso(0.2), round_finished: iso(0.2), last_clean_run: iso(30) };
	const v = folder({ last: failing });
	assert.deepEqual([v.cause, /500 internal/.test(v.detail)], ["round_failed", true]);
	assert.equal(folder({ last: { ...failing, error: "upload refused: over quota" } }).cause, "quota");
	assert.equal(folder({ last: { ...failing, error: "401 unauthorized" } }).cause, "auth");
});

test("folder: offline is not measured, the bench's own folders and gone folders are skipped, a folder never synced is skipped", () => {
	assert.equal(folder({ online: false, last: last(60) }).state, "offline");
	assert.equal(folder({ project: "bench-latency", last: last(60) }).state, "skipped");
	assert.equal(folder({ dirExists: false, last: last(60) }).state, "skipped");
	assert.equal(folder({ last: undefined }).state, "skipped");
});

test("folder: a long interval raises the bar (3 x the interval)", () => {
	assert.equal(folder({ last: last(25), intervalMs: 10 * MIN }).state, "ok");
	assert.equal(folder({ last: last(35), intervalMs: 10 * MIN }).state, "stalled");
});

test("interval and the busy holder are read from the real texts", () => {
	assert.equal(parseInterval('project = "x"\ninterval = "30s"\n'), 30_000);
	assert.equal(parseInterval('interval = "2m"'), 120_000);
	assert.equal(parseInterval(""), 10_000);
	assert.equal(busyHolder("sync: another folder-sync round is running for this folder (/a/lock: pid 5 at 2026-11-04T10:00:00Z)"), "pid 5 at 2026-11-04T10:00:00Z");
	assert.equal(busyHolder("fine"), null);
});

test("an episode alerts once: first stalled check fires, later ones do not, ok closes it, offline leaves it open", () => {
	const causes = { canary: "no_propagation" };
	let step = nextEpisodes({}, { canary: "stalled" }, { now: NOW, causes });
	assert.deepEqual(step.fire, ["canary"]);
	step = nextEpisodes(step.episodes, { canary: "stalled" }, { now: NOW + 5 * MIN, causes });
	assert.deepEqual(step.fire, []);
	step = nextEpisodes(step.episodes, { canary: "offline" }, { now: NOW + 10 * MIN, causes });
	assert.deepEqual([step.fire, Object.keys(step.episodes)], [[], ["canary"]]);
	step = nextEpisodes(step.episodes, { canary: "stalled" }, { now: NOW + 15 * MIN, causes });
	assert.deepEqual(step.fire, [], "still the same episode after an offline gap");
	step = nextEpisodes(step.episodes, { canary: "ok" }, { now: NOW + 20 * MIN, causes });
	assert.deepEqual([step.resolved, step.episodes], [["canary"], {}]);
	step = nextEpisodes(step.episodes, { canary: "stalled" }, { now: NOW + 25 * MIN, causes });
	assert.deepEqual(step.fire, ["canary"], "a new episode alerts again");
});

test("alert(): one desktop notification per episode through the notifier, none on the next check", () => {
	const dir = mkdtempSync(join(tmpdir(), "canary-alert-"));
	const sink = join(dir, "sent.txt");
	process.env.FOLDER_SYNC_NOTIFY_CMD = JSON.stringify(["/bin/sh", "-c", `printf '%s\\n' "$0 | $1" >> ${sink}`]);
	try {
		const stalled = { result: "stalled", cause: "lock", detail: "held lock" };
		const first = alert({ canary: stalled, folders: [{ project: "zach", state: "ok" }], now: NOW, stateDir: dir });
		assert.deepEqual([first.fire, first.sent], [["canary"], true]);
		const second = alert({ canary: stalled, folders: [], now: NOW + 5 * MIN, stateDir: dir });
		assert.deepEqual([second.fire, second.sent], [[], false]);
		const lines = readFileSync(sink, "utf8").trim().split("\n");
		assert.equal(lines.length, 1);
		assert.match(lines[0], /stopped syncing/);
		assert.match(lines[0], /canary: held lock/);
		alert({ canary: { result: "ok" }, folders: [], now: NOW + 10 * MIN, stateDir: dir });
		const third = alert({ canary: stalled, folders: [], now: NOW + 15 * MIN, stateDir: dir });
		assert.deepEqual(third.fire, ["canary"]);
		assert.equal(readFileSync(sink, "utf8").trim().split("\n").length, 2);
	} finally {
		delete process.env.FOLDER_SYNC_NOTIFY_CMD;
	}
});

test("notify() with no notifier on the machine reports false instead of throwing", () => {
	process.env.FOLDER_SYNC_NOTIFY_CMD = JSON.stringify(["/nonexistent/notify-send"]);
	try {
		assert.equal(notify("t", "b"), false);
	} finally {
		delete process.env.FOLDER_SYNC_NOTIFY_CMD;
	}
	assert.match(alertText(["a: x", "b: y"]).title, /\(2\)/);
});

test("probeServer: a refused connection is offline, 401 is auth, 500 is retried then a server error, 200 reads the quota", async () => {
	const answer = (status, body = {}) => async () => ({ status, json: async () => body });
	assert.equal((await probeServer("http://x", "t", { fetchImpl: async () => { throw new TypeError("fetch failed"); } })).state, "offline");
	assert.equal((await probeServer("http://x", "t", { fetchImpl: answer(401) })).state, "auth");
	let calls = 0;
	const flaky = async () => (++calls < 2 ? { status: 500, json: async () => ({}) } : { status: 200, json: async () => ({ over: null }) });
	assert.equal((await probeServer("http://x", "t", { fetchImpl: flaky })).state, "online");
	assert.equal((await probeServer("http://x", "t", { fetchImpl: answer(200, { over: "storage" }) })).quotaOver, "storage");
});

test("the points: ok has a value; stalled and offline are failed points that say why; the folder count names each stalled folder", () => {
	const source = sourceOf("t/1", "canary-test", { sha: "abc", dirty: false });
	const t = "2026-11-04T13:00:00-07:00";
	const [ok] = healthPoints({ canary: { result: "ok", value: 640, cause: null, detail: "", project: "canary-sync", timeout_s: 600 }, env: "prod", t, source });
	assert.deepEqual([ok.kpi, ok.status, ok.value, ok.labels.result, ok.slice], ["sync_canary_ms", "measured", 640, "ok", { env: "prod" }]);
	const [bad] = healthPoints({ canary: { result: "stalled", value: null, cause: "lock", detail: "held lock", project: "canary-sync", timeout_s: 600 }, env: "prod", t, source });
	assert.deepEqual([bad.status, bad.value, bad.labels.result, bad.labels.cause], ["failed", null, "stalled", "lock"]);
	assert.match(bad.labels.reason, /stalled: held lock/);
	const [off] = healthPoints({ canary: { result: "offline", value: null, cause: "offline", detail: "offline, not measured", project: "canary-sync", timeout_s: 600 }, env: "prod", t, source });
	assert.deepEqual([off.status, off.labels.result, off.labels.reason], ["failed", "offline", "offline, not measured"]);
	const folders = [folder({}), folder({ project: "bam", last: last(30) }), folder({ project: "bench-latency", last: last(60) })];
	const [count] = healthPoints({ folders, env: "prod", t, source });
	assert.deepEqual([count.kpi, count.value, count.n, count.labels.result, count.labels.checked], ["sync_stalled_folders", 1, 2, "stalled", 2]);
	assert.deepEqual(count.labels.stalled.map((f) => [f.project, f.cause, f.age_min]), [["bam", "no_rounds", 30]]);
	const [none] = healthPoints({ folders: [folder({ online: false }), folder({ project: "bam", online: false })], env: "prod", t, source });
	assert.deepEqual([none.status, none.labels.result], ["failed", "offline"]);
	assert.throws(() => makePoint({ kpi: "sync_canary_ms", value: null, t, source, slice: { env: "prod" } }), /reason/);
});

test("the timer: every 5 minutes, a service that runs the canary under the user's bus; the stall bar is 10 minutes", () => {
	const { service, timer } = unitFiles({ repo: "/r", node: "/usr/bin/node" });
	assert.match(timer, /OnUnitInactiveSec=5min/);
	assert.match(service, /ExecStart=\/usr\/bin\/node \/r\/bench\/kpi\/canary\.mjs run/);
	assert.match(service, /DBUS_SESSION_BUS_ADDRESS/);
	assert.equal(STALL_AFTER_MS, 600_000);
});
