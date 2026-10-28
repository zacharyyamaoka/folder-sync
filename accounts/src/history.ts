// Version history in the bucket, path first (PEP 0007 §3.1, docs/CONTRACT.md "Deletions and history"): the keys and
// version ids, the write-time rule (what a writer keeps when a version leaves) and the pruner's rule (what stays as
// it ages). One rule implemented twice, the engine in Go and this in TypeScript, both pinned by
// testdata/retention/schedule.json and testdata/history/keys.json.
//
//   <root>_history/<project>/<host>/<path>/<written_at>_<sha16>    a kept version: the file's exact bytes
//   <root>_changes/<project>/<host>/<seq, 12 digits>.json          what manifest version <seq> changed
//   <root>_changes/<project>/<host>/pulls/<at>.json                 the peer files that host wrote in one round
//   <root>_requests/<project>/<host>/<id>.json                      a restore that host is asked to make
//
// WHY a colon in a version id is safe: no published path holds ":" (webhost.checkWebPath, the engine's
// names.CheckWindows), so a version is never a file or folder of the published tree, and a delimiter listing of
// …/<path>/ shows versions as objects and deeper paths as prefixes.

import { checkPath } from "../../readers/worker/src/folder-sync-read.ts";

/** burst: a version that lived less than this inside a burst of saves may go (CONTRACT "What is kept"). */
export const BURST_MS = 30_000;
/** keep_days: nothing older is kept. */
export const KEEP_DAYS = 30;
/** The web host has no .folder-sync.toml: it keeps the default. */
export const NO_HISTORY_DEFAULT = ["*.log"];
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

export const VERSION_ID = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z_([0-9a-f]{16}|unlisted)$/;
const PROJECT = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROOT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** R2's longest key: a path whose history key would pass it is published but never kept (CONTRACT). */
export const KEY_MAX = 1024;

// ------------------------------------------------------------------------------------------------ ids and keys

/** An RFC 3339 instant truncated (never rounded) to the millisecond, as YYYY-MM-DDTHH:MM:SS.mmmZ. WHY by hand for a
 *  Z instant: the engine writes up to 9 fraction digits, and a Date would round some of them. */
export function toMillis(instant: string): string {
	const z = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(instant);
	if (z) return `${z[1]}.${(z[2] ?? "").padEnd(3, "0").slice(0, 3)}Z`;
	const time = Date.parse(instant);
	if (!Number.isFinite(time)) throw new Error(`not an RFC 3339 instant: ${JSON.stringify(instant)}`);
	return new Date(time).toISOString();
}

/** The version id of a manifest entry that leaves: `<written_at to the ms>_<sha16>`. */
export function versionId(writtenAt: string, sha256: string): string {
	return `${toMillis(writtenAt)}_${sha256.slice(0, 16)}`;
}

/** The id of an object that was not the version its manifest listed: `<its LastModified, to the ms>_unlisted`. */
export function unlistedId(lastModified: number): string {
	return `${new Date(lastModified).toISOString()}_unlisted`;
}

export interface Version {
	id: string;
	/** Absent for an unlisted version. */
	written_at?: string;
	sha16?: string;
	unlisted: boolean;
}

/** A version id taken apart, or null when it is not one. */
export function parseVersion(id: string): Version | null {
	if (!VERSION_ID.test(id)) return null;
	const cut = id.lastIndexOf("_");
	const at = id.slice(0, cut);
	if (!Number.isFinite(Date.parse(at)) || new Date(Date.parse(at)).toISOString() !== at) return null;
	const tail = id.slice(cut + 1);
	return tail === "unlisted" ? { id, unlisted: true } : { id, written_at: at, sha16: tail, unlisted: false };
}

/** A published path as history keys may hold it: the contract's rules, and never a ":". */
export function historyPath(path: string): boolean {
	try {
		checkPath(path);
	} catch {
		return false;
	}
	return !path.includes(":");
}

export function historyPrefix(root: string, project: string, host?: string, path?: string): string {
	return `${root}_history/${project}/${host ? `${host}/` : ""}${host && path ? `${path}/` : ""}`;
}

export function historyKey(root: string, project: string, host: string, path: string, version: string): string {
	return `${historyPrefix(root, project, host, path)}${version}`;
}

/** Whether a version of `path` can be kept at all: its key fits R2's 1,024 bytes. */
export function keyFits(root: string, project: string, host: string, path: string): boolean {
	return new TextEncoder().encode(historyKey(root, project, host, path, `${"0".repeat(23)}Z_${"0".repeat(16)}`)).byteLength <= KEY_MAX;
}

export interface HistoryKey {
	root: string;
	project: string;
	host: string;
	path: string;
	version: string;
}

/** A history key taken apart (testdata/history/keys.json), or null when it is not one. The root ends where the first
 *  `_history` segment is: a root segment never starts with "_". */
export function parseHistoryKey(key: string): HistoryKey | null {
	const parts = key.split("/");
	const at = parts.indexOf("_history");
	if (at < 0 || at > 8) return null;
	const rootParts = parts.slice(0, at);
	if (!rootParts.every((s) => ROOT_SEGMENT.test(s))) return null;
	const [project, host, ...rest] = parts.slice(at + 1);
	if (!project || !PROJECT.test(project) || !host || !HOST_ID.test(host) || rest.length < 2) return null;
	const version = rest[rest.length - 1];
	const path = rest.slice(0, -1).join("/");
	if (!parseVersion(version) || !historyPath(path)) return null;
	return { root: rootParts.length ? `${rootParts.join("/")}/` : "", project, host, path, version };
}

export function changesKey(root: string, project: string, host: string, seq: number): string {
	return `${root}_changes/${project}/${host}/${String(seq).padStart(12, "0")}.json`;
}

export function pullsPrefix(root: string, project: string, host: string): string {
	return `${root}_changes/${project}/${host}/pulls/`;
}

export function requestsPrefix(root: string, project: string, host?: string): string {
	return `${root}_requests/${project}/${host ? `${host}/` : ""}`;
}

// ------------------------------------------------------------------------------------------------ no_history

/** One gitignore pattern as a RegExp over a slash path: `*` and `?` stay inside a segment, `**` crosses them. */
function globOf(pattern: string): RegExp {
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "*" && pattern[i + 1] === "*") {
			out += ".*";
			i++;
			if (pattern[i + 1] === "/") i++;
		} else if (c === "*") out += "[^/]*";
		else if (c === "?") out += "[^/]";
		else if (c === "[") {
			const end = pattern.indexOf("]", i + 1);
			if (end < 0) out += "\\[";
			else {
				out += `[${pattern.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
				i = end;
			}
		} else out += c.replace(/[.+^${}()|\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`);
}

/** Whether `path` matches the gitignore-style `patterns` (.folder-sync.toml's no_history): a pattern with no slash
 *  matches a name at any depth, one with a slash matches from the folder's top; a later "!pattern" takes it back. */
export function matchesAny(path: string, patterns: string[]): boolean {
	const names = path.split("/");
	let matched = false;
	for (const raw of patterns) {
		let pattern = raw.trim();
		if (!pattern || pattern.startsWith("#")) continue;
		const negate = pattern.startsWith("!");
		if (negate) pattern = pattern.slice(1);
		pattern = pattern.replace(/\/$/, "");
		let hit: boolean;
		if (pattern.includes("/")) {
			const glob = globOf(pattern.replace(/^\//, ""));
			// anchored: the whole path, or a folder above it
			hit = names.some((_, i) => glob.test(names.slice(0, i + 1).join("/")));
		} else {
			const glob = globOf(pattern);
			hit = names.some((name) => glob.test(name));
		}
		if (hit) matched = !negate;
	}
	return matched;
}

// ------------------------------------------------------------------------------------------------ the rules

export interface Leaving {
	/** replace: an edit; delete; restore: replaced by a restore. */
	op: "replace" | "delete" | "restore";
	path: string;
	/** The leaving version's manifest written_at. */
	writtenAt: string;
	/** When it leaves (ms). */
	now: number;
	/** The left_at (ms) of the last version of this path this writer kept, or null. */
	lastKeptLeftAt: number | null;
	noHistory?: string[];
}

/** When a version leaves: kept, or not and why (CONTRACT "What is kept", the five rules in order). */
export function keepOnWrite(leaving: Leaving): { keep: true } | { keep: false; why: "no_history" | "burst" } {
	if (matchesAny(leaving.path, leaving.noHistory ?? NO_HISTORY_DEFAULT)) return { keep: false, why: "no_history" };
	if (leaving.op === "delete" || leaving.op === "restore") return { keep: true };
	const lived = leaving.now - Date.parse(leaving.writtenAt);
	if (lived >= BURST_MS) return { keep: true };
	if (leaving.lastKeptLeftAt !== null && leaving.lastKeptLeftAt > leaving.now - BURST_MS) return { keep: false, why: "burst" };
	return { keep: true };
}

/** The ids of one (host, path)'s versions the pruner keeps at `now` (CONTRACT "What is kept", the pruner's four rules).
 *  WHY UTC clock hours and days of left_at, not distances from now: a prune is idempotent, and two pruners running at
 *  once cannot disagree. */
export function pruneVersions(versions: { id: string; left_at: number }[], now: number, keepDays = KEEP_DAYS): Set<string> {
	const kept = new Set<string>();
	const newest = new Map<string, { id: string; left_at: number }>();
	const newer = (a: { id: string; left_at: number }, b: { id: string; left_at: number }) => a.left_at > b.left_at || (a.left_at === b.left_at && a.id > b.id);
	for (const v of versions) {
		const age = now - v.left_at;
		if (age >= keepDays * DAY_MS) continue;
		if (age < HOUR_MS) {
			kept.add(v.id);
			continue;
		}
		const bucket = age < DAY_MS ? `h${Math.floor(v.left_at / HOUR_MS)}` : `d${Math.floor(v.left_at / DAY_MS)}`;
		const best = newest.get(bucket);
		if (!best || newer(v, best)) newest.set(bucket, v);
	}
	for (const v of newest.values()) kept.add(v.id);
	return kept;
}

/** A legacy _trash/ stamp (YYYYMMDDTHHMMSSZ, the web host's with "-<ms>-<nonce>") as ms, or null. */
export function trashStampTime(stamp: string): number | null {
	const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-(\d{3})-[0-9a-f]{8})?$/.exec(stamp);
	if (!m) return null;
	const time = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7] ? +m[7] : 0);
	return Number.isFinite(time) ? time : null;
}
