// The shared tree (docs/peps/0010): one tree of files that every device, agent and page of a folder edits, written by the
// folder's Durable Object alone. It is a host like any other: `<project>/hosts/<shared-id>/` with its own manifest
// (`host_name` "shared", plus `"shared": {"private": [...]}`), its history in _history/ and its change records in
// _changes/, so every reader, the history, prune, quota and view code work on it unchanged, and an engine that has
// never heard of it sees its files read-only under hosts/<shared-id>/.
//
// A device never writes this tree in the bucket. It sends each change to the object with the version the change was made
// from (its base); the object, which runs one commit at a time (webhost.ts WebHostCore):
//   - base is the current version, or holds the same bytes, or both are absent: accepts it (git's fast-forward);
//   - otherwise resolves it in one place for machines, agents and pages alike: appended whole lines on both sides are
//     both kept, other text merges three-way, anything else or a collision becomes a conflict copy; an edit beats a delete.
// One commit is one manifest version, however many paths it holds: the files go first, then the manifest (If-Match), then
// the change record, as a web-host write does; a commit the manifest did not take is undone, from the journal, at once
// or by the folder's next operation.
//
// WHY the base's bytes come from _history/ (PEP 0010 §6.4): a three-way merge is only as right as its base. When the
// 5-minute throttle dropped it, the newest kept version written before it is used instead: diff3 takes a change both sides
// made only once, so an older base can only add collisions, never repeat text.

import { ContractError, SCHEMA, type Manifest, type ManifestEntry } from "../../readers/worker/src/folder-sync-read.ts";
import { anchorOf, changesKey, historyKey, historyPrefix, KEY_MAX, keepOnWrite, listedObject, matchesAny, parsePrefixBody, preferred, readOrder, objectName, parseVersion, versionId, PREFIX_SCHEMA, type ListedObject } from "./history.ts";
import { conflictName, mergeBytes } from "./shared-merge.ts";
import {
	ATTEMPTS, BadPath, Busy, CHANGES, EVENT, OverQuota, Refusal, SHARED_NAME, change, checkWebPath, copyOut, hostKey, keptKey, manifestBytes, next, readManifest, recordBytes, recordChange, recover, sha256Hex,
	writeManifest, type ChangeRecord, type Journal, type Ledger, type Pending, type Where, type WritableBucket,
} from "./webhost.ts";

/** What the shared tree reads and lists with: the web host's bucket, plus a listing. */
export interface ListingBucket extends WritableBucket {
	objects(prefix: string, options?: { delimiter?: string; cursor?: string; max?: number }): Promise<{ objects: { key: string; size: number; lastModified: number }[]; truncated: boolean; cursor?: string }>;
}

/** The version a device's change was made from: a version id, and the sha256 of its bytes. */
export interface SharedBase {
	version: string;
	sha256?: string;
}

/** One path of a commit: a write (`data`, or `staged` for a file the device uploaded itself), or a delete. */
export interface SharedChange {
	path: string;
	base: SharedBase | null;
	sha256?: string;
	data?: Uint8Array;
	/** The id of an object the device uploaded to `<root>_incoming/<project>/<host>/<staged>` with its own key. */
	staged?: string;
	delete?: boolean;
	/** The device's local time (RFC 3339 as written), for a conflict copy's name. */
	at_local?: string;
	/** Overwrite whatever is there: a restore. */
	force?: boolean;
	restoreFrom?: string;
	/** A page that merges its own data: a base that is no longer current is a 412, not a merge. */
	never?: boolean;
}

export interface SharedRequest {
	/** The committer's name: a machine's host_name, a page's browser ("Chrome on Linux"). */
	device: string;
	/** The committing machine's host id: where its staged uploads are, and `by_host` of the events. */
	host?: string;
	via?: string;
	/** The device's own max_delete: a commit holding more deletes is refused (PEP 0010 §5). */
	maxDelete: number;
	changes: SharedChange[];
	/** When the Worker received the request (a page's up_ms). */
	receivedAt?: number;
}

export type Outcome = "accepted" | "merged" | "conflict" | "edit_won";

/** The object's answer for one path (docs/API.md "The shared tree"). */
export interface PathResult {
	path: string;
	outcome: Outcome;
	/** The path's version after this commit: absent when it is not in the tree. For a conflict, the version that kept the path. */
	version?: string;
	sha256?: string;
	size?: number;
	written_at?: string;
	/** merged: how (`tails` or `lines`), and the version id under which the device's own bytes are kept in history. */
	merge?: "tails" | "lines";
	kept_as?: string;
	/** conflict: why, and where the device's bytes went. */
	why?: string;
	conflict_path?: string;
	conflict_version?: string;
}

export interface CommitAnswer {
	host: string;
	name: typeof SHARED_NAME;
	seq: number;
	/** Whether the tree's manifest moved (then the hub is told). */
	changed: boolean;
	results: PathResult[];
}

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID = HOST_ID;
/** Private patterns: how many, and how long. */
const PRIVATE_MAX = 200;

/** The patterns of `share --private`, checked: a list of single-line gitignore patterns. */
export function checkPrivate(patterns: unknown): string[] {
	if (!Array.isArray(patterns) || patterns.length > PRIVATE_MAX || patterns.some((p) => typeof p !== "string" || !p.trim() || p.length > 256 || /[\r\n\0]/.test(p))) {
		throw new Refusal(400, "bad_private", `private is a list of up to ${PRIVATE_MAX} single-line gitignore patterns`);
	}
	return patterns as string[];
}

// ------------------------------------------------------------------------------------------------ share

/** Creates the shared tree's empty manifest (seq 1) with its private rule; the same call again returns it. Changing the
 *  private rule after the share is not in v1 (PEP 0010 §7): a different rule is a 409. */
export async function shareTree(bucket: WritableBucket, w: Where, priv: string[] | undefined, clock: () => number): Promise<{ host: string; name: string; private: string[]; seq: number; created: boolean }> {
	const wanted = priv === undefined ? undefined : checkPrivate(priv);
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const { manifest, etag } = await readManifest(bucket, w);
		if (etag !== null) {
			if (!manifest.shared) throw new Refusal(409, "not_shared", "this host is not a shared tree");
			if (wanted && JSON.stringify(wanted) !== JSON.stringify(manifest.shared.private)) {
				throw new Refusal(409, "already_shared", `this folder is already shared with private ${JSON.stringify(manifest.shared.private)}; changing it is not in v1`);
			}
			return { host: w.hostId, name: SHARED_NAME, private: manifest.shared.private, seq: manifest.seq, created: false };
		}
		const created: Manifest = { schema: SCHEMA, project: w.project, host_id: w.hostId, host_name: SHARED_NAME, seq: 1, generated_at: new Date(clock()).toISOString(), files: [], shared: { private: wanted ?? [] } };
		if (await writeManifest(bucket, w, created, null)) return { host: w.hostId, name: SHARED_NAME, private: created.shared!.private, seq: 1, created: true };
	}
	throw new Busy("the shared tree's manifest kept changing; try again");
}

// ------------------------------------------------------------------------------------------------ reading history

/** A path's kept versions, in every form (one listing of …/<path>/). */
async function versionsOf(bucket: ListingBucket, w: Where, path: string): Promise<ListedObject[]> {
	const prefix = historyPrefix(w.root, w.project, w.hostId, path);
	const found: ListedObject[] = [];
	let cursor: string | undefined;
	for (let pages = 0; pages < 20; pages++) {
		const page = await bucket.objects(prefix, { delimiter: "/", cursor });
		for (const object of page.objects) {
			const listed = listedObject(prefix, object);
			if (listed) found.push(listed);
		}
		cursor = page.truncated ? page.cursor : undefined;
		if (!cursor) break;
	}
	return found;
}

async function bytesOf(bucket: WritableBucket, key: string): Promise<Uint8Array | null> {
	const object = await bucket.get(key);
	return object && "arrayBuffer" in object ? new Uint8Array(await object.arrayBuffer()) : null;
}

/** The exact bytes of kept version `id` of `path`, checked against its name, or null when they are not there. A pointer is
 *  read from what it rests on: the next whole copy, or the live file (PEP 0009). The shared tree writes whole copies and
 *  pointers; a keyframe (written by an engine) is not read here. */
async function openVersion(bucket: ListingBucket, w: Where, manifest: Manifest, path: string, id: string, stored: ListedObject[]): Promise<Uint8Array | null> {
	const sha16 = parseVersion(id)?.sha16 ?? "";
	for (const form of readOrder(stored.filter((o) => o.id === id))) {
		if (form.kind === "zst") continue;
		const object = await bytesOf(bucket, form.key);
		if (!object) continue;
		if (form.kind === "full") {
			if (!sha16 || (await sha256Hex(object)).startsWith(sha16)) return object;
			continue;
		}
		const body = parsePrefixBody(new TextDecoder().decode(object));
		if (!body || body.size !== form.size || !body.sha256.startsWith(sha16)) continue;
		const anchor = anchorOf(stored, id);
		let source: Uint8Array | null = null;
		if (anchor) source = anchor.kind === "full" ? await bytesOf(bucket, anchor.key) : null;
		else if (manifest.files.some((e) => e.path === path)) source = await bytesOf(bucket, hostKey(w, path));
		const start = source?.subarray(0, body.size);
		if (start && start.byteLength === body.size && (await sha256Hex(start)) === body.sha256) return start.slice();
	}
	return null;
}

/** A merge's base: the exact version the device made its change from, else the newest kept version written before it
 *  (PEP 0010 §6.4), else nothing (diff3 then reports more collisions, never repeats text). */
async function baseBytes(bucket: ListingBucket, w: Where, manifest: Manifest, path: string, base: SharedBase): Promise<Uint8Array | null> {
	const stored = await versionsOf(bucket, w, path);
	const exact = await openVersion(bucket, w, manifest, path, base.version, stored);
	if (exact) return exact;
	for (const older of preferred(stored).filter((v) => v.id < base.version).sort((a, b) => (a.id < b.id ? 1 : -1))) {
		const got = await openVersion(bucket, w, manifest, path, older.id, stored);
		if (got) return got;
	}
	return null;
}

// ------------------------------------------------------------------------------------------------ one commit

/** A file to write at `path`, and what it replaces. */
interface Put {
	path: string;
	bytes: Uint8Array;
	entry: ManifestEntry;
	leaving: ManifestEntry | null;
	/** A merge keeps both inputs, whatever the throttle: the version that leaves is always kept whole. */
	forceKeep: boolean;
	/** A merge also keeps the device's own bytes under their own version id. */
	yours?: { id: string; bytes: Uint8Array; key: string };
	op: "replace" | "restore";
	/** What the event says about this write. */
	event: { kind: "upload" | "restore"; merge?: { base: string | null; yours: string | null; result: string }; conflictOf?: string; restoreFrom?: string };
}

interface Del {
	path: string;
	leaving: ManifestEntry;
}

function same(a: string | undefined, b: string): boolean {
	return a !== undefined && a === b;
}

function pointerBody(size: number, sha256: string): Uint8Array {
	return new TextEncoder().encode(JSON.stringify({ schema: PREFIX_SCHEMA, size, sha256 }));
}

/** The path's own metadata for an answer. */
function ownResult(path: string, outcome: Outcome, entry: ManifestEntry | undefined): PathResult {
	return entry
		? { path, outcome, version: versionId(entry.written_at, entry.sha256), sha256: entry.sha256, size: entry.size, written_at: entry.written_at }
		: { path, outcome };
}

/** Runs one commit of the shared tree: see the header. */
export async function commitShared(bucket: ListingBucket, w: Where, request: SharedRequest, clock: () => number, journal: Journal, ledger?: Ledger): Promise<CommitAnswer> {
	const changes = [...request.changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	// the answer lists the paths in the order they were sent
	const asked = new Map(request.changes.map((c, i) => [c.path, i]));
	const inOrder = (results: PathResult[]) => results.sort((a, b) => asked.get(a.path)! - asked.get(b.path)!);
	const seen = new Set<string>();
	for (const ch of changes) {
		checkWebPath(ch.path);
		if (seen.has(ch.path)) throw new BadPath(`${JSON.stringify(ch.path)} is in this commit twice`);
		seen.add(ch.path);
	}
	if (changes.filter((c) => c.delete).length > request.maxDelete) {
		throw new Refusal(409, "max_delete", `this commit deletes ${changes.filter((c) => c.delete).length} files, more than max_delete = ${request.maxDelete}; raise max_delete on the machine, or restore the files`);
	}
	await recover(bucket, w, journal);

	// the bytes of every write, once: inline, or the object the device staged (checked, never trusted)
	const staged: string[] = [];
	const bodies = new Map<string, Uint8Array>();
	for (const ch of changes) {
		if (ch.delete) continue;
		let data = ch.data;
		if (data === undefined && ch.staged !== undefined) {
			if (!request.host || !HOST_ID.test(request.host) || !UUID.test(ch.staged)) throw new Refusal(400, "bad_staged", "staged names an object a machine uploaded to _incoming/ under its own host id");
			const key = `${w.root}_incoming/${w.project}/${request.host}/${ch.staged}`;
			data = (await bytesOf(bucket, key)) ?? undefined;
			if (!data) throw new Refusal(400, "staged_missing", `the staged upload of ${JSON.stringify(ch.path)} is not there`);
			staged.push(key);
		}
		if (data === undefined) throw new Refusal(400, "bad_change", `${JSON.stringify(ch.path)} has neither a body nor staged nor delete`);
		if (ch.sha256 !== undefined && (await sha256Hex(data)) !== ch.sha256) throw new Refusal(400, "bad_body", `the bytes of ${JSON.stringify(ch.path)} do not hash to the sha256 sent`);
		bodies.set(ch.path, data);
	}

	// the staged uploads go once the commit has ended, however it ended
	const dropStaged = async () => {
		for (const key of staged) {
			try {
				await bucket.delete(key);
			} catch {
				// left for the folder's prune (_incoming/ older than a day)
			}
		}
	};

	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const now = clock();
		const iso = new Date(now).toISOString();
		const { manifest, etag, size } = await readManifest(bucket, w);
		if (etag === null || !manifest.shared) throw new Refusal(409, "not_shared", "this folder has no shared tree: run folder-sync share");
		const priv = manifest.shared.private;
		for (const ch of changes) {
			if (priv.length && matchesAny(ch.path, priv)) throw new Refusal(409, "private_path", `${JSON.stringify(ch.path)} is private: it stays on each machine's own host`);
		}
		const live = new Map(manifest.files.map((e) => [e.path, e]));
		const taken = new Set(live.keys());
		const lower = new Map(manifest.files.map((e) => [e.path.toLowerCase(), e.path]));
		const results: PathResult[] = [];
		const puts: Put[] = [];
		const dels: Del[] = [];
		const committer = { device: request.device, host: request.host };

		for (const ch of changes) {
			const cur = live.get(ch.path);
			const curVersion = cur ? versionId(cur.written_at, cur.sha256) : undefined;
			const agrees = !!cur && (ch.force || (!!ch.base && (ch.base.version === curVersion || same(ch.base.sha256, cur.sha256))));
			if (ch.delete) {
				if (!cur) results.push(ownResult(ch.path, "accepted", undefined));
				else if (agrees) {
					dels.push({ path: ch.path, leaving: cur });
					results.push(ownResult(ch.path, "accepted", undefined));
				} else results.push(ownResult(ch.path, "edit_won", cur)); // an edit beats a delete
				continue;
			}
			const bytes = bodies.get(ch.path)!;
			const sha256 = await sha256Hex(bytes);
			const entry: ManifestEntry = { path: ch.path, size: bytes.byteLength, mtime: iso, sha256, written_at: iso, object_etag: "0".repeat(32) };
			const twin = lower.get(ch.path.toLowerCase());
			if (twin !== undefined && twin !== ch.path) throw new BadPath(`${JSON.stringify(ch.path)} and ${JSON.stringify(twin)} differ only by case, which Windows and macOS cannot hold`);
			const op = ch.restoreFrom ? "restore" : "replace";
			const event: Put["event"] = ch.restoreFrom ? { kind: "restore", restoreFrom: ch.restoreFrom } : { kind: "upload" };
			if (cur && cur.sha256 === sha256) {
				results.push(ownResult(ch.path, "accepted", cur)); // the tree already holds these bytes
				continue;
			}
			if (!cur || agrees) {
				// WHY a delete by the other side is not a collision (PEP 0010 §6.3): the file comes back, with this edit
				puts.push({ path: ch.path, bytes, entry, leaving: cur ?? null, forceKeep: false, op, event });
				results.push({ ...ownResult(ch.path, "accepted", entry) });
				continue;
			}
			// the tree moved since this version: resolve it
			if (ch.never) throw new Refusal(412, "precondition_failed", `${JSON.stringify(ch.path)} changed since the version this edit was made from (X-Folder-Sync-Merge: never)`);
			const theirs = await bytesOf(bucket, hostKey(w, ch.path));
			if (!theirs || (await sha256Hex(theirs)) !== cur.sha256) throw new Error(`${JSON.stringify(ch.path)} does not match its manifest`);
			const base = ch.base ? await baseBytes(bucket, w, manifest, ch.path, ch.base) : null;
			const merge = mergeBytes(ch.path, base, bytes, theirs);
			if (merge.kind === "unchanged") {
				results.push(ownResult(ch.path, "accepted", cur));
			} else if (merge.kind === "tails" || merge.kind === "merged") {
				const mergedSha = await sha256Hex(merge.bytes);
				const result: ManifestEntry = { ...entry, size: merge.bytes.byteLength, sha256: mergedSha };
				const yours = merge.kind === "merged" ? { id: versionId(iso, sha256), bytes, key: historyKey(w.root, w.project, w.hostId, ch.path, versionId(iso, sha256)) } : undefined;
				puts.push({ path: ch.path, bytes: merge.bytes, entry: result, leaving: cur, forceKeep: merge.kind === "merged", yours, op: "replace",
					event: { kind: "upload", merge: { base: ch.base?.version ?? null, yours: yours?.id ?? null, result: versionId(iso, mergedSha) } } });
				results.push({ ...ownResult(ch.path, "merged", result), merge: merge.kind === "tails" ? "tails" : "lines", ...(yours ? { kept_as: yours.id } : {}) });
			} else {
				const copyPath = conflictName(ch.path, committer.device, ch.at_local, (name) => taken.has(name) || puts.some((p) => p.path === name), now);
				const copy: ManifestEntry = { ...entry, path: copyPath };
				if (lower.has(copyPath.toLowerCase())) throw new BadPath(`${JSON.stringify(copyPath)} is taken`);
				taken.add(copyPath);
				puts.push({ path: copyPath, bytes, entry: copy, leaving: null, forceKeep: false, op: "replace", event: { kind: "upload", conflictOf: ch.path } });
				results.push({ ...ownResult(ch.path, "conflict", cur), why: merge.why, conflict_path: copyPath, conflict_version: versionId(iso, sha256) });
			}
		}
		for (const put of puts) checkWebPath(put.path);

		if (!puts.length && !dels.length) {
			await dropStaged();
			return { host: w.hostId, name: SHARED_NAME, seq: manifest.seq, changed: false, results: inOrder(results) };
		}

		// ---- what leaves, and in which form it is kept
		const recent = (await journal.recent?.()) ?? {};
		const pointers = (await journal.pointers?.()) ?? new Set<string>();
		interface Leaves { path: string; old: ManifestEntry; backup: string; keep: boolean; why?: "no_history" | "burst"; pointer: boolean; op: "replace" | "delete" | "restore" }
		const leaves: Leaves[] = [];
		const encoder = new TextEncoder();
		for (const put of puts) {
			if (!put.leaving) continue;
			const old = put.leaving;
			const backup = keptKey(w, put.path, old);
			const append = old.size >= 1 && put.bytes.byteLength > old.size && (await sha256Hex(put.bytes.subarray(0, old.size))) === old.sha256;
			const decision = put.forceKeep
				? ({ keep: true } as const)
				: keepOnWrite({ op: put.op, path: put.path, writtenAt: old.written_at, now, lastKeptLeftAt: recent[put.path] ?? null, newestKeptIsPointer: pointers.has(put.path), appendUploaded: append });
			const pointerKey = historyKey(w.root, w.project, w.hostId, put.path, objectName(versionId(old.written_at, old.sha256), "prefix", old.size));
			const pointer = decision.keep && !put.forceKeep && put.op === "replace" && append && encoder.encode(pointerKey).byteLength <= KEY_MAX;
			leaves.push({ path: put.path, old, backup, keep: decision.keep, why: decision.keep ? undefined : decision.why, pointer, op: put.op });
		}
		for (const del of dels) {
			const decision = keepOnWrite({ op: "delete", path: del.path, writtenAt: del.leaving.written_at, now, lastKeptLeftAt: null });
			leaves.push({ path: del.path, old: del.leaving, backup: keptKey(w, del.path, del.leaving), keep: decision.keep, why: decision.keep ? undefined : decision.why, pointer: false, op: "delete" });
		}
		const leaf = new Map(leaves.map((l) => [l.path, l]));

		// ---- the manifest and its record
		const entries = manifest.files.filter((e) => !dels.some((d) => d.path === e.path) && !puts.some((p) => p.path === e.path));
		const updated = next(manifest, [...entries, ...puts.map((p) => p.entry)], now);
		const events: Record<string, unknown>[] = [];
		const by = { ...(request.host && HOST_ID.test(request.host) ? { by_host: request.host } : {}), by_name: request.device };
		const common = { schema: EVENT, level: "info", at: iso, project: w.project, host: w.hostId, host_name: SHARED_NAME, seq: updated.seq };
		const wasOf_ = (l: Leaves) => ({ sha256: l.old.sha256, size: l.old.size, written_at: l.old.written_at, kept: l.keep ? versionId(l.old.written_at, l.old.sha256) : null, ...(l.keep ? {} : { why: l.why }) });
		const upMs = request.receivedAt !== undefined ? { up_ms: Math.max(0, Date.parse(updated.generated_at) - request.receivedAt) } : {};
		for (const put of puts) {
			const l = leaf.get(put.path);
			if (put.event.kind === "restore") events.push({ ...common, event: "restore", path: put.path, from: put.event.restoreFrom, size: put.bytes.byteLength, sha256: put.entry.sha256, ...(l ? { was: wasOf_(l) } : {}), ...by });
			else events.push({ ...common, event: "upload", path: put.path, size: put.bytes.byteLength, sha256: put.entry.sha256, op: l ? "edit" : "add", ...(l ? { was: wasOf_(l) } : {}), ...(put.event.merge ? { merge: put.event.merge } : {}), ...upMs, ...by });
			if (put.event.conflictOf) events.push({ ...common, event: "conflict", level: "warn", path: put.event.conflictOf, kept_at: put.path, peer: request.host && HOST_ID.test(request.host) ? request.host : w.hostId, peer_name: request.device, ...by });
		}
		for (const del of dels) events.push({ ...common, event: "delete", path: del.path, was: wasOf_(leaf.get(del.path)!), ...upMs, ...by });
		events.sort((a, b) => (a.path as string) < (b.path as string) ? -1 : (a.path as string) > (b.path as string) ? 1 : 0);
		const record: ChangeRecord = { schema: CHANGES, project: w.project, host_id: w.hostId, host_name: SHARED_NAME, seq: updated.seq, at: updated.generated_at, by: "shared", ...(request.via ? { via: request.via } : {}), events };

		// ---- the cost, admitted at most; charged as it ends
		const manifestDelta = manifestBytes(updated).byteLength - size;
		const recorded = recordBytes(record);
		const adds = puts.filter((p) => !p.leaving).length;
		const copies = leaves.length;
		const yourBytes = puts.reduce((n, p) => n + (p.yours?.bytes.byteLength ?? 0), 0);
		const yourCount = puts.filter((p) => p.yours).length;
		// WHY only a commit that adds bytes: a delete frees space, and over quota it must still go (as the web host's)
		if (puts.length) await ledger?.admit(puts.reduce((n, p) => n + p.bytes.byteLength, 0) + leaves.reduce((n, l) => n + l.old.size, 0) + yourBytes + manifestDelta + recorded, adds + copies + yourCount);

		// ---- the change: backups, the files, then the manifest (If-Match)
		const items: Pending[] = [
			...puts.map((p) => ({ where: w, path: p.path, restore: leaf.get(p.path)?.backup ?? null, restoreSha256: p.leaving?.sha256 ?? null, restoreSize: p.leaving?.size ?? null, sha256: p.entry.sha256 })),
			...dels.map((d) => ({ where: w, path: d.path, restore: leaf.get(d.path)!.backup, restoreSha256: d.leaving.sha256, restoreSize: d.leaving.size, sha256: null })),
		];
		const pending: Pending = { ...items[0], more: items.slice(1), ...(yourCount ? { discard: puts.filter((p) => p.yours).map((p) => p.yours!.key) } : {}) };
		const committed = await change(bucket, w, journal, pending, async () => {
			for (const l of leaves) {
				if (!(await copyOut(bucket, w, l.path, l.old, l.backup))) throw new Error(`${JSON.stringify(l.path)} could not be copied to its history`);
			}
			for (const put of puts) {
				if (put.yours) await bucket.put(put.yours.key, put.yours.bytes, { ifNoneMatch: "*" });
			}
			for (const put of puts) {
				const stored = await bucket.put(hostKey(w, put.path), put.bytes);
				if (/^[0-9A-Za-z-]{1,128}$/.test(stored.etag)) put.entry.object_etag = stored.etag;
				else delete put.entry.object_etag; // an ETag this cannot name: the file is then read whole and sha256-checked
			}
			for (const del of dels) await bucket.delete(hostKey(w, del.path));
			// the entries were sized with a placeholder ETag; the manifest carries the real ones
			return writeManifest(bucket, w, next(manifest, [...entries, ...puts.map((p) => p.entry)], now), etag);
		});
		if (!committed) continue; // another writer moved the manifest (never the object's own queue): start over from a fresh read

		// ---- after the manifest: pointers instead of copies, the throttle's memory, the usage, the record
		let historyBytes = yourBytes;
		let historyObjects = yourCount;
		for (const l of leaves) {
			if (!l.keep) {
				// not kept (the throttle, no_history): the undo copy goes, and the bytes with it
				try {
					await bucket.delete(l.backup);
				} catch {
					await journal.stray(w.root, l.backup, l.old.size);
				}
				continue;
			}
			historyObjects += 1;
			if (l.pointer) {
				const body = pointerBody(l.old.size, l.old.sha256);
				const key = historyKey(w.root, w.project, w.hostId, l.path, objectName(versionId(l.old.written_at, l.old.sha256), "prefix", l.old.size));
				try {
					const written = await bucket.put(key, body, { ifNoneMatch: "*", contentType: "application/json" });
					if (!written.ok && written.status !== 412) throw new Error("the pointer was not written");
					await bucket.delete(l.backup);
					historyBytes += body.byteLength;
					await journal.pointed?.(l.path, true);
				} catch {
					// the whole copy stays: it is the version, in its best form
					historyBytes += l.old.size;
					await journal.pointed?.(l.path, false);
				}
			} else {
				historyBytes += l.old.size;
				await journal.pointed?.(l.path, false);
			}
			await journal.kept?.(l.path, now);
		}
		for (const put of puts) if (put.forceKeep || !leaf.get(put.path)) await journal.pointed?.(put.path, false);
		for (const del of dels) await journal.pointed?.(del.path, false);
		const liveNew = puts.reduce((n, p) => n + p.bytes.byteLength, 0);
		const liveOld = leaves.reduce((n, l) => n + l.old.size, 0);
		const objectsNet = adds - dels.length + historyObjects;
		await ledger?.charge(liveNew - liveOld + historyBytes + manifestDelta, objectsNet, { bytes: historyBytes, objects: historyObjects });
		await ledger?.charge(recorded, 0, { bytes: recorded, objects: 0 });
		await recordChange(bucket, journal, changesKey(w.root, w.project, w.hostId, updated.seq), record);
		await dropStaged();
		return { host: w.hostId, name: SHARED_NAME, seq: updated.seq, changed: true, results: inOrder(results) };
	}
	throw new Busy("the shared tree's manifest kept changing; try again");
}

// ------------------------------------------------------------------------------------------------ restore

/** Writes kept versions of the shared tree back as new versions, one commit each (what a page's Restore asks for): the
 *  version's bytes are read and checked against the sha16 in its name; what could not be restored is named, never thrown. */
export async function restoreShared(bucket: ListingBucket, w: Where, items: { path: string; version: string }[], clock: () => number, journal: Journal, ledger: Ledger | undefined, options: { via?: string } = {}):
	Promise<{ applied: { host: string; path: string; version: string; seq: number }[]; failed: { host: string; path: string; version: string; error: "pruned" | "mismatch" | "not_found" | "over_quota" | "failed" }[] }> {
	const applied = [];
	const failed = [];
	for (const { path, version } of items) {
		const fail = (error: "pruned" | "mismatch" | "not_found" | "over_quota" | "failed") => failed.push({ host: w.hostId, path, version, error });
		if (!parseVersion(version)) {
			fail("not_found");
			continue;
		}
		try {
			const { manifest } = await readManifest(bucket, w);
			const bytes = await openVersion(bucket, w, manifest, path, version, await versionsOf(bucket, w, path));
			if (!bytes) {
				fail("pruned");
				continue;
			}
			const done = await commitShared(bucket, w, { device: options.via ?? "a browser", via: options.via, maxDelete: 0, changes: [{ path, base: null, data: bytes, force: true, restoreFrom: version }] }, clock, journal, ledger);
			applied.push({ host: w.hostId, path, version, seq: done.seq });
		} catch (error) {
			if (error instanceof OverQuota) fail("over_quota");
			else if (error instanceof Refusal || error instanceof BadPath || error instanceof ContractError) fail("failed");
			else fail("failed");
		}
	}
	return { applied, failed };
}
