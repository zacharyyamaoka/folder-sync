// "Is it syncing?": the classifiers behind the live stall check (bench/kpi/canary.mjs). Pure functions over what was observed,
// so the verdicts are testable without a stack: a canary result is ok / stalled / offline, a folder is ok / stalled / offline /
// skipped, and a stall always names its cause (a held lock and its holder, quota, signed out, failing rounds, no engine).
//
// WHY offline is never red (Zach, 2026-11-04: "if you are not connecting online though then we cannot expect it to
// propagate"): a machine with no route to the server cannot be told apart from a stalled engine by waiting, so it is recorded
// "offline, not measured" and nothing is alerted.
// WHY 10 minutes (Zach: "it times out after like 10 minutes or something"): a round takes seconds (a first reconcile a couple
// of minutes), so ten minutes with no round completed is not slow, it is stopped. A killed sync once blocked a folder for the
// 30 minutes of an empty lock (internal/syncer/project.go) and nothing noticed.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { makePoint } from "./lib.mjs";

export const STALL_AFTER_MS = 10 * 60_000;
export const CANARY_FILE = "canary.txt";
export const CANARY_PROJECT = "canary-sync";
/** Folders whose rounds are another stage's business: the propagation bench's and the canary's own. */
export const OWN_PROJECTS = ["bench-latency", CANARY_PROJECT];

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

// ---------------------------------------------------------------------------------------------------------------- folders

const QUOTA = /quota|over its|storage limit/i;
const AUTH = /signed out|sign(?:ed)? in|401|403|unauthori[sz]ed|token|revoked|credential/i;

/** One synced folder's verdict.
 *  @param f {project, folder, now, online, dirExists, last, intervalMs, lock, quotaOver, signedIn, stallAfterMs}
 *  @returns {project, folder, state: ok|stalled|offline|skipped, cause, detail, age_ms, interval_ms} */
export function classifyFolder(f) {
	const { project, folder, now, last, lock = null } = f;
	const stallAfterMs = f.stallAfterMs ?? STALL_AFTER_MS;
	const intervalMs = f.intervalMs ?? 10_000;
	const base = { project, folder, interval_ms: intervalMs, age_ms: null, cause: null, detail: "" };
	if (OWN_PROJECTS.includes(project)) return { ...base, state: "skipped", detail: "checked by its own stage" };
	if (!f.dirExists) return { ...base, state: "skipped", detail: "the folder is gone from this machine" };
	if (!f.online) return { ...base, state: "offline", detail: "offline, not measured" };
	if (!last || !last.round_finished) return { ...base, state: "skipped", detail: "no round has run yet" };
	// WHY last_clean_run, not round_finished: a round that fails every 10 s still "finishes"; the question is when one last succeeded
	const cleanAt = Date.parse(last.last_clean_run || (last.ok ? last.round_finished : ""));
	const age = Number.isFinite(cleanAt) ? Math.max(0, now - cleanAt) : null;
	const threshold = Math.max(stallAfterMs, 3 * intervalMs);
	const lockStuck = lock && lock.alive && lock.ageMs > threshold;
	if (age !== null && age <= threshold && !lockStuck) return { ...base, state: "ok", age_ms: age };
	const since = age === null ? "no round has completed" : `no round completed for ${ageText(age)}`;
	const why = (cause, detail) => ({ ...base, state: "stalled", age_ms: age, cause, detail: `${since}; ${detail}` });
	const error = String(last.error ?? "");
	if (f.quotaOver || (!last.ok && QUOTA.test(error))) return why("quota", `the account is over its storage quota${f.quotaOver ? `: ${String(f.quotaOver).slice(0, 120)}` : ""}, so uploads are held`);
	if (f.signedIn === false || (!last.ok && AUTH.test(error))) return why("auth", f.signedIn === false ? "this machine is signed out" : `the server refused this machine's sign-in (${error.slice(0, 120)})`);
	if (lock) return why("lock", describeLock(lock));
	if (!last.ok) return why("round_failed", `the last round failed: ${error.slice(0, 160) || "no error text"}`);
	return why("no_rounds", "nothing is running rounds for it (no sync --watch and no timer)");
}

// ---------------------------------------------------------------------------------------------------------------- canary

/** Is the server reachable from here, and what does it say about this account?
 *  @param r {state: "network"|"http", status?, over?} the one request's outcome (bench/kpi/canary.mjs probeServer)
 *  @returns {state: online|offline|auth|server_error, quotaOver, detail} */
export function classifyReachability(r) {
	if (r.state === "network") return { state: "offline", quotaOver: null, detail: "no route to the server" };
	if (r.status === 401 || r.status === 403) return { state: "auth", quotaOver: null, detail: `the server answered ${r.status}: signed out or revoked` };
	if (r.status >= 500 || r.status === 429) return { state: "server_error", quotaOver: null, detail: `the server answered ${r.status}` };
	if (r.status === 200) return { state: "online", quotaOver: r.over || null, detail: "" };
	return { state: "server_error", quotaOver: null, detail: `the server answered ${r.status}` };
}

/** Pulls "another round is running … (lock: pid 1 at …)" out of an engine's output: the lock is why nothing syncs. */
export function busyHolder(log) {
	const m = /another folder-sync round is running[^\n]*?\(([^)\n]*)\)/.exec(String(log ?? ""));
	return m ? m[1].replace(/^[^:]*lock:\s*/, "").trim() || "no holder written" : null;
}

/** The canary's verdict.
 *  @param c {reach, visibleMs, timeoutMs, reachAfter, engine: {exited, code, log}}
 *  reach/reachAfter: classifyReachability results before the write and when the wait ended. */
export function classifyCanary(c) {
	const { reach, visibleMs, timeoutMs } = c;
	const out = (result, cause, detail, value = null) => ({ result, cause, detail, value });
	if (reach.state === "offline") return out("offline", "offline", "offline, not measured");
	if (reach.state === "auth") return out("stalled", "auth", reach.detail);
	if (reach.state === "server_error") return out("stalled", "server", reach.detail);
	if (reach.quotaOver) return out("stalled", "quota", `the account is over its storage quota, so uploads are held: ${String(reach.quotaOver).slice(0, 160)}`);
	if (typeof visibleMs === "number") return out("ok", null, "", Math.round(visibleMs));
	// the wait ended with nothing online. Offline at that moment: the network went away mid-check, which proves nothing about the engine
	if (c.reachAfter?.state === "offline") return out("offline", "offline", "went offline during the check, not measured");
	const holder = busyHolder(c.engine?.log);
	const waited = `${Math.round(timeoutMs / 1000)} s`;
	if (c.engine?.exited) return out("stalled", "engine_exited", `sync --watch exited (${c.engine.code}) before the file was online: ${String(c.engine.log ?? "").trim().split("\n").slice(-2).join(" / ").slice(0, 200)}`);
	if (holder) return out("stalled", "lock", `every round was refused: another round holds the folder's lock (${holder}); the file was not online after ${waited}`);
	return out("stalled", "no_propagation", `the file was not online after ${waited} and the engine was running`);
}

// ---------------------------------------------------------------------------------------------------------------- alerts

/** One alert per stall episode, not one per check: an episode starts when a key (the canary, or "folder:<project>") is first
 *  seen stalled and ends when it is seen ok. Offline and skipped keys leave an open episode open (nothing is known).
 *  @param previous {key: {since, cause}}  @param current {key: "ok"|"stalled"|"offline"|"skipped"}
 *  @returns {episodes, fire: [keys that started an episode], resolved: [keys that ended one]} */
export function nextEpisodes(previous, current, { now, causes = {} }) {
	const episodes = { ...previous };
	const fire = [];
	const resolved = [];
	for (const [key, state] of Object.entries(current)) {
		if (state === "stalled" && !episodes[key]) {
			episodes[key] = { since: new Date(now).toISOString(), cause: causes[key] ?? null };
			fire.push(key);
		} else if (state === "ok" && episodes[key]) {
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

/** The two KPI points of one check (vt-kpi-point/1; docs/KPI.md). Stalled and offline are `failed` points that say why, never a zero. */
export function healthPoints({ canary, folders, env, t, source }) {
	const out = [];
	if (canary) {
		const labels = { result: canary.result, cause: canary.cause, detail: canary.detail, timeout_s: canary.timeout_s, project: canary.project };
		out.push(makePoint({ kpi: "sync_canary_ms", value: canary.result === "ok" ? canary.value : null, n: canary.result === "ok" ? 1 : 0, t, source, slice: { env }, labels, reason: canary.result === "offline" ? "offline, not measured" : `stalled: ${canary.detail}`.slice(0, 300) }));
	}
	if (folders) {
		const checked = folders.filter((f) => f.state !== "skipped");
		const offline = checked.length > 0 && checked.every((f) => f.state === "offline");
		const stalled = folders.filter((f) => f.state === "stalled");
		const labels = {
			result: offline ? "offline" : stalled.length ? "stalled" : "ok", checked: checked.length,
			stalled: stalled.map((f) => ({ project: f.project, folder: f.folder, cause: f.cause, detail: f.detail, age_min: f.age_ms === null ? null : Math.round(f.age_ms / 60_000), interval_s: Math.round(f.interval_ms / 1000) })),
		};
		out.push(makePoint({ kpi: "sync_stalled_folders", value: offline ? null : stalled.length, n: offline ? 0 : checked.length, t, source, slice: { env }, labels, reason: "offline, not measured" }));
	}
	return out;
}
