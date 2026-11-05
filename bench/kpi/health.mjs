// "Is it syncing?": the classifiers behind the passive stall check (bench/kpi/stall.mjs). Pure functions over what was observed, so
// the verdicts are testable without a stack: a folder is idle / pending / stalled / offline / skipped, and a stall always names its
// cause (a held lock and its holder, quota, signed out, held deletes, failing rounds, or nothing running rounds).
//
// WHY passive (Zach, 2026-11-04: "couldn't you just kinda monitor when the files change by the users? it would be nice if we are
// super quiet when nothing is changing"): the check looks only at the engine's local state and at the folder itself. No file is
// written to any folder, no request goes to the server, and a folder where nothing changes is "idle", which costs nothing and
// writes nothing. A stall is a change that has sat on this disk, unpushed, for 10 minutes while this machine is online.
// WHY offline is never red ("if you are not connecting online then we cannot expect it to propagate"): it is "offline, not measured".
// WHY 10 minutes: a round takes seconds (a first reconcile a couple of minutes), so ten minutes with a change not pushed is not
// slow, it is stopped. A killed sync once blocked a folder for the 30 minutes of an empty lock (internal/syncer/project.go) and
// nothing noticed.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { makePoint, percentile } from "./lib.mjs";

export const STALL_AFTER_MS = 10 * 60_000;
/** The propagation bench's own folder: its rounds are another stage's business. */
export const OWN_PROJECTS = ["bench-latency"];
/** A latency above this is not a sync delay (a file that arrived with an old mtime, or a stall, which the stall check reports). */
export const SAMPLE_CAP_MS = STALL_AFTER_MS;
/** At most one point an hour while nothing changes (the idle heartbeat the dev view reads as "still being checked"). */
export const HEARTBEAT_MS = 60 * 60_000;

const minutes = (ms) => (ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);
export const ageText = minutes;

/** `interval = "10s"` from a folder's .folder-sync.toml, in ms (10 s when it names none, as the engine does). */
export function parseInterval(toml) {
	const m = /^\s*interval\s*=\s*"(\d+(?:\.\d+)?)(ms|s|m|h)"/m.exec(toml ?? "");
	if (!m) return 10_000;
	return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2]];
}

// ---------------------------------------------------------------------------------------------------------------- locks

/** The engine's lock file ("pid 1234 at 2026-11-04T10:00:00Z\n"; internal/syncer/project.go) as a verdict-ready object.
 *  `alive` is injected so a test never signals a real process. */
export function lockFromText(text, { mtimeMs, now, alive }) {
	const raw = String(text ?? "").trim();
	const m = /^pid (\d+)(?: at (\S+))?/.exec(raw);
	if (!m) return { pid: null, empty: raw === "", raw, ageMs: Math.max(0, now - mtimeMs), alive: false };
	const pid = Number(m[1]);
	const since = Number.isFinite(Date.parse(m[2])) ? Date.parse(m[2]) : mtimeMs;
	return { pid, empty: false, raw, ageMs: Math.max(0, now - since), alive: alive(pid) };
}

export function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

/** The lock in a project's state dir, or null when there is none. */
export function readLock(stateDir, { now = Date.now(), alive = pidAlive } = {}) {
	if (!stateDir) return null;
	const file = join(stateDir, "lock");
	try {
		return lockFromText(readFileSync(file, "utf8"), { mtimeMs: statSync(file).mtimeMs, now, alive });
	} catch {
		return null;
	}
}

export function describeLock(lock) {
	if (lock.empty) return `an empty lock (left by a round killed as it started), ${ageText(lock.ageMs)} old`;
	if (lock.pid === null) return `an unreadable lock (${JSON.stringify(lock.raw.slice(0, 60))}), ${ageText(lock.ageMs)} old`;
	return lock.alive ? `a lock held by pid ${lock.pid} (running) for ${ageText(lock.ageMs)}` : `a lock left by pid ${lock.pid}, which is gone, ${ageText(lock.ageMs)} old`;
}

/** The state dir of the project that syncs `folder`: ~/.folder-sync/projects/<name>-<hash>/project.json names its folder. */
export function findStateDir(folder, home) {
	const base = join(home, ".folder-sync", "projects");
	let entries = [];
	try { entries = readdirSync(base); } catch { return null; }
	for (const name of entries) {
		try {
			const project = JSON.parse(readFileSync(join(base, name, "project.json"), "utf8"));
			if (project.folder && resolve(project.folder) === resolve(folder)) return join(base, name);
		} catch { /* not a project dir */ }
	}
	return null;
}

// ---------------------------------------------------------------------------------------------------------------- pending changes

const floorMs = (text) => { const t = Date.parse(text); return Number.isFinite(t) ? t : null; };

/** What is on this disk that the last push does not hold: the engine's own test (a file is unchanged when its size and mtime match
 *  the manifest entry; internal/syncer/round.go Push), with no hashing and no network.
 *  @param listing [{Path, Size, ModTime}] the folder through the engine's filters (rclone lsjson)
 *  @param manifestFiles [{path, size, mtime}] this machine's last pushed manifest
 *  @param skip Set of paths the engine skips by name (status's `skipped`) and so never pushes
 *  @returns {files, deletes, oldest_change_ms, sample: [paths]} */
export function pendingChanges({ listing, manifestFiles, skip = new Set() }) {
	const known = new Map(manifestFiles.map((e) => [e.path, e]));
	const present = new Set();
	const changed = [];
	let oldest = null;
	for (const item of listing) {
		if (item.IsDir || skip.has(item.Path) || item.Path === "manifest.json") continue; // manifest.json at the root is reserved
		present.add(item.Path);
		const old = known.get(item.Path);
		const mtime = floorMs(item.ModTime);
		if (old && old.size === item.Size && floorMs(old.mtime) === mtime) continue;
		changed.push(item.Path);
		if (mtime !== null && (oldest === null || mtime < oldest)) oldest = mtime;
	}
	const deleted = manifestFiles.filter((e) => !present.has(e.path) && !skip.has(e.path)).map((e) => e.path);
	return { files: changed.length, deletes: deleted.length, oldest_change_ms: oldest, sample: [...changed, ...deleted].slice(0, 5) };
}

/** How long a folder's pending change has waited: from when this check first saw it, or when the file was last written if that is
 *  later. WHY the later: a file written a minute ago has waited a minute even if the check first looked only now, and a file copied
 *  in with an old mtime has waited only since it arrived. A file written every second (a log) is always young. */
export function pendingSince(pending, firstSeenMs, now) {
	const seen = firstSeenMs ?? now;
	return Math.min(now, pending.oldest_change_ms === null ? seen : Math.max(seen, pending.oldest_change_ms));
}

/** Keeps each folder's "first seen pending" while it stays pending, and forgets it when nothing is pending or the machine is offline
 *  (time spent offline is not time stalled: reconnecting never starts red). */
export function updateFirstSeen(previous, verdicts, now) {
	const next = {};
	for (const v of verdicts) {
		if (v.state === "pending" || v.state === "stalled") next[v.project] = previous?.[v.project] ?? now;
	}
	return next;
}

// ---------------------------------------------------------------------------------------------------------------- folders

const QUOTA = /quota|over its|storage limit/i;
const AUTH = /signed out|sign(?:ed)? in|401|403|unauthori[sz]ed|token|revoked|credential/i;
// a round that fails for want of a route is the network being down, not the engine being stuck
const NETWORK = /no such host|network is unreachable|connection refused|dial tcp|i\/o timeout|no route to host|temporary failure in name resolution|offline/i;

/** One synced folder's verdict.
 *  @param f {project, folder, now, online, dirExists, last, pending, firstSeenMs, intervalMs, lock, signedIn, engineRunning, stallAfterMs}
 *  `pending` is pendingChanges' result, or null when the folder's changes cannot be told locally (a shared tree).
 *  @returns {project, folder, state: idle|pending|stalled|offline|skipped, cause, detail, age_ms, pending_files, interval_ms} */
export function classifyFolder(f) {
	const { project, folder, now, last, lock = null, pending } = f;
	const stallAfterMs = f.stallAfterMs ?? STALL_AFTER_MS;
	const intervalMs = f.intervalMs ?? 10_000;
	const base = { project, folder, interval_ms: intervalMs, age_ms: null, cause: null, detail: "", pending_files: pending ? pending.files + pending.deletes : 0 };
	if (OWN_PROJECTS.includes(project)) return { ...base, state: "skipped", detail: "checked by its own stage" };
	if (!f.dirExists) return { ...base, state: "skipped", detail: "the folder is gone from this machine" };
	if (!f.online) return { ...base, state: "offline", detail: "offline, not measured" };
	if (!last || !last.round_finished) return { ...base, state: "skipped", detail: "no round has run yet" };
	if (!last.ok && NETWORK.test(String(last.error ?? ""))) return { ...base, state: "offline", detail: "offline, not measured (the last round could not reach the server)" };
	if (!pending) return { ...base, state: "skipped", detail: "changes in a shared folder are not told locally" };
	if (pending.files + pending.deletes === 0) return { ...base, state: "idle" };
	const age = Math.max(0, now - pendingSince(pending, f.firstSeenMs, now));
	const threshold = Math.max(stallAfterMs, 3 * intervalMs);
	if (age <= threshold) return { ...base, state: "pending", age_ms: age };
	const what = `${pending.files ? `${pending.files} changed file${pending.files === 1 ? "" : "s"}` : ""}${pending.files && pending.deletes ? " and " : ""}${pending.deletes ? `${pending.deletes} deleted` : ""}`;
	const since = `${what} not pushed for ${ageText(age)}`;
	const why = (cause, detail) => ({ ...base, state: "stalled", age_ms: age, cause, detail: `${since}; ${detail}` });
	const error = String(last.error ?? "");
	if (!last.ok && QUOTA.test(error)) return why("quota", `the account is over its storage quota, so uploads are held (${error.slice(0, 120)})`);
	if (f.signedIn === false || (!last.ok && AUTH.test(error))) return why("auth", f.signedIn === false ? "this machine is signed out" : `the server refused this machine's sign-in (${error.slice(0, 120)})`);
	if (pending.deletes && Array.isArray(last.held_deletes) && last.held_deletes.length) return why("held_deletes", `${last.held_deletes.length} deletes are held for being over max_delete`);
	if (lock) return why("lock", describeLock(lock));
	if (!last.ok) return why("round_failed", `the last round failed: ${error.slice(0, 160) || "no error text"}`);
	return why(f.engineRunning ? "not_pushing" : "no_rounds", f.engineRunning ? "the engine is running but rounds are not pushing it" : "nothing is running rounds for it (no sync --watch and no timer)");
}

/** Is this machine on a network at all? A default route, read from the kernel's table: no request, nothing sent. Where there is no
 *  such table (macOS, Windows) it says yes, and a round that fails for want of a route says offline through classifyFolder. */
export function hasDefaultRoute(routeText) {
	if (routeText === null || routeText === undefined) return true;
	return routeText.split("\n").slice(1).some((line) => {
		const [, destination, , flags] = line.trim().split(/\s+/);
		return destination === "00000000" && (parseInt(flags, 16) & 1) === 1;
	});
}

// ---------------------------------------------------------------------------------------------------------------- real propagation

/** Latency samples from real use: each file pushed after `afterMs` took (written_at - mtime) from being saved to being in the
 *  store. WHY the manifest and no extra measurement: a push records both times for every file it uploads, so every real save is a
 *  sample at no cost. Over SAMPLE_CAP_MS it is not a sync delay (an old mtime arrived with the file) and is left out. */
export function latencySamples(manifestFiles, afterMs) {
	const out = [];
	for (const e of manifestFiles) {
		const wrote = floorMs(e.written_at);
		const saved = floorMs(e.mtime);
		if (wrote === null || saved === null || wrote <= afterMs) continue;
		const ms = wrote - saved;
		if (ms >= 0 && ms <= SAMPLE_CAP_MS) out.push({ ms, wrote });
	}
	return out;
}

// ---------------------------------------------------------------------------------------------------------------- alerts

/** One alert per stall episode, not one per check: an episode starts when a key ("folder:<project>") is first seen stalled and ends
 *  when it is seen idle or pushed. Offline, pending and skipped keys leave an open episode open (nothing is known).
 *  @returns {episodes, fire: [keys that started an episode], resolved: [keys that ended one]} */
export function nextEpisodes(previous, current, { now, causes = {} }) {
	const episodes = { ...previous };
	const fire = [];
	const resolved = [];
	for (const [key, state] of Object.entries(current)) {
		if (state === "stalled" && !episodes[key]) {
			episodes[key] = { since: new Date(now).toISOString(), cause: causes[key] ?? null };
			fire.push(key);
		} else if ((state === "idle" || state === "ok") && episodes[key]) {
			delete episodes[key];
			resolved.push(key);
		}
	}
	return { episodes, fire, resolved };
}

/** What the desktop notification says. */
export function alertText(lines) {
	return { title: lines.length === 1 ? "folder-sync has stopped syncing" : `folder-sync has stopped syncing (${lines.length})`, body: lines.join("\n") };
}

// ---------------------------------------------------------------------------------------------------------------- points

/** The one health point of a check (vt-kpi-point/1; docs/KPI.md): the number of stalled folders. Offline is a `failed` point that says
 *  so, never a zero. */
export function healthPoint({ folders, env, t, source }) {
	const watched = folders.filter((f) => f.state !== "skipped");
	const offline = watched.length > 0 && watched.every((f) => f.state === "offline");
	const stalled = folders.filter((f) => f.state === "stalled");
	const labels = {
		result: offline ? "offline" : stalled.length ? "stalled" : "ok", checked: watched.length, pending: folders.filter((f) => f.state === "pending").length,
		stalled: stalled.map((f) => ({ project: f.project, folder: f.folder, cause: f.cause, detail: f.detail, age_min: f.age_ms === null ? null : Math.round(f.age_ms / 60_000), interval_s: Math.round(f.interval_ms / 1000) })),
	};
	return makePoint({ kpi: "sync_stalled_folders", value: offline ? null : stalled.length, n: offline ? 0 : watched.length, t, source, slice: { env }, labels, reason: "offline, not measured" });
}

/** The identity of a point for "did anything change since the last one": its result, its count and which folders stalled on what. */
export const pointKeyOf = (point) => JSON.stringify([point.labels.result, point.value, (point.labels.stalled ?? []).map((s) => `${s.project}:${s.cause}`).sort()]);

/** Whether this check earns a point: something changed since the last one (the result, the stalled set), or the hour's heartbeat is
 *  due. WHY: a quiet folder writes nothing (Zach: "super quiet when nothing is changing"), and the heartbeat is how the dev view
 *  knows the check is still running. */
export function pointDue(point, lastWritten, now) {
	if (!lastWritten) return true;
	return now - lastWritten.at >= HEARTBEAT_MS || pointKeyOf(point) !== lastWritten.key;
}

/** The propagation points of real use (docs/KPI.md "From real use"): p50 and p95 of the samples this check found. */
export function realUsePoints({ samples, env, t, source, labels = {} }) {
	if (!samples.length) return [];
	const ms = samples.map((s) => s.ms);
	const stats = { p50: percentile(ms, 50), p95: percentile(ms, 95), max: Math.max(...ms), min: Math.min(...ms), trials: ms.length, timeouts: 0 };
	return [["propagation_p50_ms", stats.p50], ["propagation_p95_ms", stats.p95]].map(([kpi, value]) => makePoint({
		kpi, value, n: ms.length, t, source, labels: { ...stats, ...labels, measured: "real use: each pushed file's manifest written_at minus its mtime" }, slice: { env, direction: "machine->web", op: "real" },
	}));
}
