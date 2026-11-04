// Version history in the bucket, path first (PEP 0007 §3.1, docs/CONTRACT.md "Deletions and history"): the keys and
// version ids, the write-time rule (what a writer keeps when a version leaves) and the pruner's rule (what stays as
// it ages). One rule implemented twice, the engine in Go and this in TypeScript, both pinned by
// testdata/retention/schedule.json and testdata/history/keys.json.
//
//   <root>_history/<project>/<host>/<path>/<written_at>_<sha16>    a kept version: the file's exact bytes
//   <root>_history/<project>/<host>/<path>/<version>.<size>.zst    ... as one zstd frame (a keyframe; PEP 0009)
//   <root>_history/<project>/<host>/<path>/<version>.<size>.prefix ... as a pointer to the start of the next full object
//   <root>_changes/<project>/<host>/<seq, 12 digits>.json          what manifest version <seq> changed
//   <root>_changes/<project>/<host>/pulls/<at>.json                 the peer files that host wrote in one round
//   <root>_requests/<project>/<host>/<id>.json                      a restore that host is asked to make
//
// WHY a colon in a version id is safe: no published path holds ":" (webhost.checkWebPath, the engine's
// names.CheckWindows), so a version is never a file or folder of the published tree, and a delimiter listing of
// …/<path>/ shows versions as objects and deeper paths as prefixes.

import { checkPath } from "../../readers/worker/src/folder-sync-read.ts";

/** history_every: a version that lived less than this inside a burst of saves may go (CONTRACT "What is kept"). The
 *  default is Zach's 5 minutes (2026-11-04); a machine's folder may set its own, at least MIN_EVERY_MS. The web host has no
 *  .folder-sync.toml: it keeps the default. */
export const EVERY_MS = 300_000;
export const MIN_EVERY_MS = 30_000;
/** keep_days: nothing older is kept. */
export const KEEP_DAYS = 30;
/** The web host has no .folder-sync.toml: it keeps the default. */
export const NO_HISTORY_DEFAULT = ["*.log"];
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

export const VERSION_ID = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z_([0-9a-f]{16}|unlisted)$/;
/** An object's name under …/<path>/: a version id, then for a keyframe or a pointer .<size>.<form> (no leading zero). */
const OBJECT_NAME = /^(.+?)(?:\.(0|[1-9][0-9]*)\.(zst|prefix))?$/;
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

/** The form of the object a kept version is stored as (PEP 0009). */
export type Kind = "full" | "zst" | "prefix";

export interface ObjectName {
	/** The version id. */
	id: string;
	kind: Kind;
	/** The version's own size, from the name: null for a whole copy (its size is the object's). */
	size: number | null;
}

/** An object's name taken apart, or null when it is not one. An unlisted version is always a whole copy. */
export function parseName(name: string): ObjectName | null {
	const m = OBJECT_NAME.exec(name);
	if (!m || !parseVersion(m[1])) return null;
	if (!m[3]) return { id: m[1], kind: "full", size: null };
	if (m[1].endsWith("_unlisted")) return null;
	const size = Number(m[2]);
	return Number.isSafeInteger(size) ? { id: m[1], kind: m[3] as Kind, size } : null;
}

/** The name of a version stored as `kind`. */
export function objectName(id: string, kind: Kind, size: number): string {
	return kind === "full" ? id : `${id}.${size}.${kind}`;
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
	/** The version id, whatever form the object is. */
	version: string;
	kind: Kind;
	/** The version's own size from the name (.zst and .prefix); absent for a whole copy. */
	size?: number;
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
	const name = parseName(rest[rest.length - 1]);
	const path = rest.slice(0, -1).join("/");
	if (!name || !historyPath(path)) return null;
	return { root: rootParts.length ? `${rootParts.join("/")}/` : "", project, host, path, version: name.id, kind: name.kind, ...(name.size === null ? {} : { size: name.size }) };
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
	/** history_every in ms: the burst window (default EVERY_MS). */
	everyMs?: number;
	/** The pin's two halves (PEP 0009 §4.3): the newest version this writer kept of the path is a pointer, and the new
	 *  bytes are an append the writer uploads itself. The web host writes no pointers, so it leaves both unset. */
	newestKeptIsPointer?: boolean;
	appendUploaded?: boolean;
}

/** When a version leaves: kept, or not and why (CONTRACT "What is kept", the six rules in order). */
export function keepOnWrite(leaving: Leaving): { keep: true } | { keep: false; why: "no_history" | "burst" } {
	const every = leaving.everyMs ?? EVERY_MS;
	if (matchesAny(leaving.path, leaving.noHistory ?? NO_HISTORY_DEFAULT)) return { keep: false, why: "no_history" };
	if (leaving.op === "delete" || leaving.op === "restore") return { keep: true };
	// WHY before the throttle: a pointer rests on the live file, and a rewrite could replace it with bytes that do not
	// start with the pointer's; dropping this version would lose the only copy that does
	if (leaving.newestKeptIsPointer && !leaving.appendUploaded) return { keep: true };
	const lived = leaving.now - Date.parse(leaving.writtenAt);
	if (lived >= every) return { keep: true };
	if (leaving.lastKeptLeftAt !== null && leaving.lastKeptLeftAt > leaving.now - every) return { keep: false, why: "burst" };
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

// ------------------------------------------------------------------------------------------------ anchors (PEP 0009 §7)

/** One object under a path's history, in any form. `name` is the object's whole name. */
export interface StoredVersion {
	name: string;
	id: string;
	kind: Kind;
	left_at: number;
}

const FORM_RANK: Record<Kind, number> = { full: 0, zst: 1, prefix: 2 };

/** The full object a pointer rests on: the oldest version of its path newer than it, in version order, that is not itself
 *  a pointer. Null when there is none: the pointer then rests on the live file, or, when the path is gone, on nothing. */
export function anchorOf<T extends StoredVersion>(versions: T[], pointerId: string): T | null {
	let best: T | null = null;
	for (const v of versions) {
		if (v.kind === "prefix" || v.id <= pointerId) continue;
		if (!best || v.id < best.id || (v.id === best.id && FORM_RANK[v.kind] < FORM_RANK[best.kind])) best = v;
	}
	return best;
}

export interface GroupPlan<T extends StoredVersion = StoredVersion> {
	keep: T[];
	/** Deleted first, then `drop`: a prune cut off halfway never strands a pointer. */
	dropPointers: T[];
	drop: T[];
	/** Pointers in `dropPointers` whose bytes are gone: no full object after them and no live file. */
	lost: T[];
	/** Kept pointers with no full object after them: they rest on the live file, or are lost if the path is gone. */
	unanchored: T[];
}

/** The schedule with PEP 0009's anchors, for the versions of one (host, path) in any form. The schedule decides by
 *  version id; a keyframe stays while a kept pointer rests on it; a pointer beside a whole copy of the same version goes;
 *  a pointer with nothing to rest on is dropped and reported lost. `live`: the path is in the host's manifest (the live
 *  file is what a last pointer rests on); null: not known, so a pointer with no anchor is kept. */
export function pruneGroup<T extends StoredVersion>(versions: T[], now: number, keepDays: number, live: boolean | null): GroupPlan<T> {
	const byId = new Map<string, T[]>();
	for (const v of versions) byId.set(v.id, [...(byId.get(v.id) ?? []), v]);
	const ids = [...byId.keys()].sort();
	const rep = new Map<string, T>();
	for (const id of ids) rep.set(id, byId.get(id)!.reduce((best, f) => (FORM_RANK[f.kind] < FORM_RANK[best.kind] ? f : best)));
	const reps = ids.map((id) => rep.get(id)!);
	const keepId = pruneVersions(reps, now, keepDays);
	const lost = new Set<string>();
	const unanchored: T[] = [];
	for (const id of ids) {
		if (!keepId.has(id) || rep.get(id)!.kind !== "prefix") continue;
		const anchor = anchorOf(reps, id);
		if (anchor) keepId.add(anchor.id); // the keyframe stays while this pointer does, however the schedule sees it
		else if (live === false) lost.add(id);
		else unanchored.push(rep.get(id)!);
	}
	const plan: GroupPlan<T> = { keep: [], dropPointers: [], drop: [], lost: [], unanchored };
	for (const id of ids) {
		for (const v of byId.get(id)!) {
			if (lost.has(id)) {
				plan.dropPointers.push(v);
				plan.lost.push(v);
			} else if (!keepId.has(id)) (v.kind === "prefix" ? plan.dropPointers : plan.drop).push(v);
			else if (v.kind === "prefix" && rep.get(id)!.kind !== "prefix") plan.dropPointers.push(v); // the whole copy is the version
			else plan.keep.push(v);
		}
	}
	return plan;
}

// ------------------------------------------------------------------------------------------------ the pointer's body

export const PREFIX_SCHEMA = "folder-sync-prefix/1";

/** A .prefix object's body (schema/prefix.schema.json): this version is the first `size` bytes of the path's next full
 *  object, and they hash to `sha256`. */
export interface PrefixBody {
	schema: typeof PREFIX_SCHEMA;
	size: number;
	sha256: string;
}

/** A pointer's body, or null when it is not one: exactly the three fields, a size of at least 1, a lowercase sha256. */
export function parsePrefixBody(text: string): PrefixBody | null {
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch {
		return null;
	}
	if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
	const { schema, size, sha256, ...rest } = doc as Record<string, unknown>;
	if (Object.keys(rest).length || schema !== PREFIX_SCHEMA) return null;
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) return null;
	if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return null;
	return { schema: PREFIX_SCHEMA, size, sha256 };
}

// ------------------------------------------------------------------------------------------------ listings

/** One object of a listing under a path's history, taken apart. `size` is the version's own size (the name's for a
 *  keyframe or a pointer, the object's for a whole copy); `stored` is the object's. */
export interface ListedObject extends StoredVersion {
	key: string;
	size: number;
	stored: number;
}

/** An object listed directly under `prefix` (…/<path>/), or null when its name is not a version's. */
export function listedObject(prefix: string, object: { key: string; size: number; lastModified: number }): ListedObject | null {
	const name = parseName(object.key.slice(prefix.length));
	if (!name || object.key.slice(prefix.length).includes("/")) return null;
	return { name: object.key.slice(prefix.length), id: name.id, kind: name.kind, left_at: object.lastModified, key: object.key, size: name.size ?? object.size, stored: object.size };
}

/** One object per version id, the whole form first (a version stored in two forms is read from its best). */
export function preferred<T extends StoredVersion>(objects: T[]): T[] {
	const best = new Map<string, T>();
	for (const o of objects) {
		const had = best.get(o.id);
		if (!had || FORM_RANK[o.kind] < FORM_RANK[had.kind]) best.set(o.id, o);
	}
	return [...best.values()];
}

/** Every version stored in `kind`-first order for a read: the whole copy, then the keyframe, then the pointer. */
export function readOrder<T extends StoredVersion>(objects: T[]): T[] {
	return [...objects].sort((a, b) => FORM_RANK[a.kind] - FORM_RANK[b.kind]);
}
