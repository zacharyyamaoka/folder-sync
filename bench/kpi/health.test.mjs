// The passive stall check's verdicts (node --test bench/kpi/health.test.mjs): a folder is idle / pending / stalled / offline, its cause
// from the engine's own state, what counts as pending, one alert per stall episode, the quiet point rule, and real-use samples.
import assert from "node:assert/strict";
import { test } from "node:test";
import { notify, unitFiles } from "./stall.mjs";
import {
	alertText, classifyFolder, describeLock, hasDefaultRoute, healthPoint, latencySamples, lockFromText, nextEpisodes, parseInterval, pendingChanges, pendingSince, pointDue,
	pointKeyOf, realUsePoints, STALL_AFTER_MS, updateFirstSeen,
} from "./health.mjs";
import { sourceOf } from "./lib.mjs";

const NOW = Date.parse("2026-11-04T20:00:00Z");
const MIN = 60_000;
const iso = (minutesAgo) => new Date(NOW - minutesAgo * MIN).toISOString();
const okRound = (extra = {}) => ({ ok: true, round_started: iso(0.1), round_finished: iso(0.1), last_clean_run: iso(0.1), ...extra });
const waiting = (minutes, extra = {}) => ({ files: 1, deletes: 0, oldest_change_ms: NOW - minutes * MIN, sample: ["a.md"], ...extra });
const folder = (over) => classifyFolder({ project: "zach", folder: "/home/me/zach", now: NOW, online: true, dirExists: true, last: okRound(), pending: { files: 0, deletes: 0, oldest_change_ms: null, sample: [] }, intervalMs: 10_000, lock: null, ...over });

test("pending: the engine's own test, size and mtime against the last pushed manifest, no hashing", () => {
	const manifestFiles = [
		{ path: "same.md", size: 5, mtime: "2026-11-04T10:00:00.123456789Z" },
		{ path: "edited.md", size: 5, mtime: "2026-11-04T10:00:00Z" },
		{ path: "grew.md", size: 5, mtime: "2026-11-04T10:00:00Z" },
		{ path: "gone.md", size: 1, mtime: "2026-11-04T10:00:00Z" },
		{ path: "skipped.md", size: 1, mtime: "2026-11-04T10:00:00Z" },
	];
	const listing = [
		{ Path: "same.md", Size: 5, ModTime: "2026-11-04T10:00:00.123Z" },
		{ Path: "edited.md", Size: 5, ModTime: "2026-11-04T10:05:00Z" },
		{ Path: "grew.md", Size: 9, ModTime: "2026-11-04T10:00:00Z" },
		{ Path: "new.md", Size: 2, ModTime: "2026-11-04T10:07:00Z" },
		{ Path: "manifest.json", Size: 2, ModTime: "2026-11-04T10:07:00Z" },
		{ Path: "dir", IsDir: true, Size: 0, ModTime: "2026-11-04T10:07:00Z" },
	];
	const got = pendingChanges({ listing, manifestFiles, skip: new Set(["skipped.md"]) });
	assert.deepEqual([got.files, got.deletes], [3, 1]);
	assert.equal(got.oldest_change_ms, Date.parse("2026-11-04T10:00:00Z"));
	assert.deepEqual(pendingChanges({ listing: [], manifestFiles: [], skip: new Set() }), { files: 0, deletes: 0, oldest_change_ms: null, sample: [] });
});

test("how long a change has waited: from first seen or the file's write, whichever is later; never in the future", () => {
	assert.equal(pendingSince(waiting(30), NOW - 12 * MIN, NOW), NOW - 12 * MIN, "a check that first looked 12 minutes ago");
	assert.equal(pendingSince(waiting(2), NOW - 12 * MIN, NOW), NOW - 2 * MIN, "a file written two minutes ago has waited two");
	assert.equal(pendingSince({ files: 0, deletes: 2, oldest_change_ms: null }, null, NOW), NOW, "a delete is first seen now");
	assert.equal(pendingSince(waiting(-5), NOW - MIN, NOW), NOW, "a clock-skewed mtime is clamped");
});

test("idle: nothing changed on disk is quiet, even when the engine is not running", () => {
	const v = folder({});
	assert.deepEqual([v.state, v.cause], ["idle", null]);
	assert.equal(folder({ last: okRound({ round_finished: iso(600), last_clean_run: iso(600) }) }).state, "idle");
});

test("pending then stalled: a change that has waited 10 minutes while online; at 9 it is only pending", () => {
	const young = folder({ pending: waiting(9), firstSeenMs: NOW - 9 * MIN });
	assert.equal(young.state, "pending");
	const old = folder({ pending: waiting(30), firstSeenMs: NOW - 11 * MIN });
	assert.deepEqual([old.state, old.cause], ["stalled", "no_rounds"]);
	assert.match(old.detail, /1 changed file not pushed for 11 min/);
	assert.equal(folder({ pending: waiting(30), firstSeenMs: NOW - 11 * MIN, engineRunning: true }).cause, "not_pushing");
	assert.equal(folder({ pending: { files: 0, deletes: 2, oldest_change_ms: null }, firstSeenMs: NOW - 20 * MIN }).state, "stalled");
});

test("a file that is written all the time (a log) is never stalled while the engine keeps up with it", () => {
	assert.equal(folder({ pending: waiting(0.05), firstSeenMs: NOW - 120 * MIN }).state, "pending");
});

test("held-lock cause: pid and age, a dead holder, an empty lock", () => {
	const at = (text) => lockFromText(text, { mtimeMs: NOW - 30 * MIN, now: NOW, alive: (pid) => pid === 91 });
	const held = folder({ pending: waiting(25), firstSeenMs: NOW - 25 * MIN, lock: at(`pid 91 at ${iso(25)}\n`) });
	assert.deepEqual([held.state, held.cause], ["stalled", "lock"]);
	assert.match(held.detail, /a lock held by pid 91 \(running\) for 25 min/);
	assert.match(describeLock(at(`pid 92 at ${iso(14)}\n`)), /pid 92, which is gone, 14 min old/);
	const empty = folder({ pending: waiting(40), firstSeenMs: NOW - 40 * MIN, lock: at("") });
	assert.equal(empty.cause, "lock");
	assert.match(empty.detail, /empty lock .* 30 min old/);
});

test("causes from the engine's state: quota, signed out, held deletes, a failing round", () => {
	const stuck = { pending: waiting(30), firstSeenMs: NOW - 30 * MIN };
	const failing = (error, extra = {}) => ({ ok: false, error, round_started: iso(0.2), round_finished: iso(0.2), last_clean_run: iso(30), ...extra });
	assert.equal(folder({ ...stuck, last: failing("this account is over its storage quota (storage): 3 upload(s) held") }).cause, "quota");
	assert.equal(folder({ ...stuck, last: failing("401 unauthorized") }).cause, "auth");
	assert.equal(folder({ ...stuck, signedIn: false }).cause, "auth");
	const held = folder({ pending: { files: 0, deletes: 60, oldest_change_ms: null }, firstSeenMs: NOW - 30 * MIN, last: failing("held", { held_deletes: ["a"].concat(Array(59).fill("b")) }) });
	assert.equal(held.cause, "held_deletes");
	const round = folder({ ...stuck, last: failing("rclone: 500 internal error") });
	assert.deepEqual([round.cause, /500 internal/.test(round.detail)], ["round_failed", true]);
});

test("offline is not measured and never red: no route, or a round that could not reach the server", () => {
	const stuck = { pending: waiting(90), firstSeenMs: NOW - 90 * MIN };
	assert.equal(folder({ ...stuck, online: false }).state, "offline");
	const unreachable = { ok: false, error: "dial tcp: lookup vibetracks.dev: no such host", round_started: iso(1), round_finished: iso(1), last_clean_run: iso(90) };
	assert.equal(folder({ ...stuck, last: unreachable }).state, "offline");
	assert.equal(hasDefaultRoute("Iface\tDestination\tGateway\tFlags\nwlan0\t00000000\t0100A8C0\t0003\n"), true);
	assert.equal(hasDefaultRoute("Iface\tDestination\tGateway\tFlags\nlo\t0000007F\t00000000\t0001\n"), false);
	assert.equal(hasDefaultRoute("Iface\tDestination\tGateway\tFlags\n"), false);
	assert.equal(hasDefaultRoute(null), true, "no kernel table (macOS, Windows): the round's own error says offline");
});

test("skipped: the bench's own folder, a gone folder, a folder with no round yet, a shared tree", () => {
	assert.equal(folder({ project: "bench-latency", pending: waiting(60) }).state, "skipped");
	assert.equal(folder({ dirExists: false }).state, "skipped");
	assert.equal(folder({ last: undefined }).state, "skipped");
	assert.equal(folder({ pending: null }).state, "skipped");
});

test("a long interval raises the bar (3 x the interval); the bar is 10 minutes", () => {
	assert.equal(STALL_AFTER_MS, 600_000);
	assert.equal(folder({ pending: waiting(25), firstSeenMs: NOW - 25 * MIN, intervalMs: 10 * MIN }).state, "pending");
	assert.equal(folder({ pending: waiting(35), firstSeenMs: NOW - 35 * MIN, intervalMs: 10 * MIN }).state, "stalled");
});

test("first-seen is kept while a change waits and forgotten when it clears or the machine goes offline", () => {
	const verdicts = [{ project: "a", state: "pending" }, { project: "b", state: "stalled" }, { project: "c", state: "idle" }, { project: "d", state: "offline" }];
	assert.deepEqual(updateFirstSeen({ a: 1, b: 2, c: 3, d: 4 }, verdicts, NOW), { a: 1, b: 2 });
	assert.deepEqual(updateFirstSeen({}, verdicts, NOW), { a: NOW, b: NOW });
});

test("interval and parse helpers read the real texts", () => {
	assert.equal(parseInterval('project = "x"\ninterval = "30s"\n'), 30_000);
	assert.equal(parseInterval(""), 10_000);
});

test("an episode alerts once: first stalled check fires, later ones do not, idle closes it, offline and pending leave it open", () => {
	const causes = { "folder:zach": "lock" };
	let step = nextEpisodes({}, { "folder:zach": "stalled" }, { now: NOW, causes });
	assert.deepEqual(step.fire, ["folder:zach"]);
	step = nextEpisodes(step.episodes, { "folder:zach": "stalled" }, { now: NOW + 5 * MIN, causes });
	assert.deepEqual(step.fire, []);
	step = nextEpisodes(step.episodes, { "folder:zach": "offline" }, { now: NOW + 10 * MIN, causes });
	assert.deepEqual([step.fire, Object.keys(step.episodes)], [[], ["folder:zach"]]);
	step = nextEpisodes(step.episodes, { "folder:zach": "pending" }, { now: NOW + 11 * MIN, causes });
	assert.deepEqual(Object.keys(step.episodes), ["folder:zach"]);
	step = nextEpisodes(step.episodes, { "folder:zach": "idle" }, { now: NOW + 20 * MIN, causes });
	assert.deepEqual([step.resolved, step.episodes], [["folder:zach"], {}]);
	assert.deepEqual(nextEpisodes(step.episodes, { "folder:zach": "stalled" }, { now: NOW + 25 * MIN, causes }).fire, ["folder:zach"], "a new episode alerts again");
});

test("notify(): one call per message through the notifier; no notifier on the machine is false, not a throw", () => {
	process.env.FOLDER_SYNC_NOTIFY_CMD = JSON.stringify(["/nonexistent/notify-send"]);
	try {
		assert.equal(notify("t", "b"), false);
	} finally {
		delete process.env.FOLDER_SYNC_NOTIFY_CMD;
	}
	assert.match(alertText(["a: x", "b: y"]).title, /\(2\)/);
	assert.equal(alertText(["a: x"]).title, "folder-sync has stopped syncing");
});

test("the health point: the stalled count and each stalled folder with its cause; offline is a failed point, never a zero", () => {
	const source = sourceOf("t/1", "stall-test", { sha: "abc", dirty: false });
	const t = "2026-11-04T13:00:00-07:00";
	const stalled = folder({ pending: waiting(30), firstSeenMs: NOW - 30 * MIN, project: "bam" });
	const folders = [folder({}), stalled, folder({ project: "bench-latency", pending: waiting(60) })];
	const point = healthPoint({ folders, env: "prod", t, source });
	assert.deepEqual([point.kpi, point.status, point.value, point.n, point.labels.result, point.labels.checked, point.slice], ["sync_stalled_folders", "measured", 1, 2, "stalled", 2, { env: "prod" }]);
	assert.deepEqual(point.labels.stalled.map((f) => [f.project, f.cause, f.age_min]), [["bam", "no_rounds", 30]]);
	const quiet = healthPoint({ folders: [folder({}), folder({ project: "bam", pending: waiting(1), firstSeenMs: NOW })], env: "prod", t, source });
	assert.deepEqual([quiet.value, quiet.labels.result, quiet.labels.pending], [0, "ok", 1]);
	const off = healthPoint({ folders: [folder({ online: false }), folder({ project: "bam", online: false })], env: "prod", t, source });
	assert.deepEqual([off.status, off.value, off.labels.result, off.labels.reason], ["failed", null, "offline", "offline, not measured"]);
});

test("quiet: a point only when the result changes or the hour's heartbeat is due", () => {
	const source = sourceOf("t/1", "stall-test", { sha: "abc", dirty: false });
	const ok = healthPoint({ folders: [folder({})], env: "prod", t: "2026-11-04T13:00:00-07:00", source });
	assert.equal(pointDue(ok, null, NOW), true, "the first check");
	const last = { at: NOW - 10 * MIN, key: pointKeyOf(ok) };
	assert.equal(pointDue(ok, last, NOW), false, "nothing changed, ten minutes later: nothing written");
	assert.equal(pointDue(ok, { ...last, at: NOW - 61 * MIN }, NOW), true, "an hour of quiet: one heartbeat");
	const stalled = healthPoint({ folders: [folder({ pending: waiting(30), firstSeenMs: NOW - 30 * MIN })], env: "prod", t: "2026-11-04T13:05:00-07:00", source });
	assert.equal(pointDue(stalled, last, NOW), true, "the result changed");
	assert.equal(pointDue(stalled, { at: NOW - MIN, key: pointKeyOf(stalled) }, NOW), false, "still stalled the same way: no spam");
});

test("real use: a pushed file's written_at minus mtime is a propagation sample; old mtimes, old pushes and clock skew are not", () => {
	const files = [
		{ path: "a", mtime: "2026-11-04T10:00:00.000Z", written_at: "2026-11-04T10:00:02.500Z" },
		{ path: "b", mtime: "2026-11-04T10:00:10.000Z", written_at: "2026-11-04T10:00:10.800Z" },
		{ path: "copied", mtime: "2025-01-01T00:00:00Z", written_at: "2026-11-04T10:00:11Z" },
		{ path: "before", mtime: "2026-11-04T09:00:00Z", written_at: "2026-11-04T09:00:01Z" },
		{ path: "skew", mtime: "2026-11-04T10:30:00Z", written_at: "2026-11-04T10:00:12Z" },
	];
	const got = latencySamples(files, Date.parse("2026-11-04T09:30:00Z"));
	assert.deepEqual(got.map((s) => s.ms), [2500, 800]);
	const source = sourceOf("t/1", "stall-test", { sha: "abc", dirty: false });
	const points = realUsePoints({ samples: got, env: "prod", t: "2026-11-04T13:00:00-07:00", source });
	assert.deepEqual(points.map((p) => [p.kpi, p.value, p.n, p.slice]), [["propagation_p50_ms", 1650, 2, { env: "prod", direction: "machine->web", op: "real" }], ["propagation_p95_ms", 2415, 2, { env: "prod", direction: "machine->web", op: "real" }]]);
	assert.deepEqual(realUsePoints({ samples: [], env: "prod", t: "x", source }), [], "nothing pushed, nothing written");
});

test("the timer: every 5 minutes, local-only, under the user's bus", () => {
	const { service, timer } = unitFiles({ repo: "/r", node: "/usr/bin/node" });
	assert.match(timer, /OnUnitInactiveSec=5min/);
	assert.match(service, /ExecStart=\/usr\/bin\/node \/r\/bench\/kpi\/stall\.mjs run/);
	assert.match(service, /DBUS_SESSION_BUS_ADDRESS/);
});
