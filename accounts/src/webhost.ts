// The web host (PEP 0003 §3.4): how a browser writes without breaking single-writer.
//
// The bucket contract (docs/CONTRACT.md "Who writes") lets only folder-sync write hosts/<host-id>/, one writer per
// host. A browser has no folder, so this Worker IS a folder-sync host for each (person, project): its id is minted
// on the first write (the web_host row, a lowercase UUID v4), and it writes exactly as a round does: a replaced or
// deleted object is first copied to _trash/<project>/<host>/<stamp>/<path>, then the file, then the manifest. The
// manifest PUT carries If-Match on the ETag it was read with (If-None-Match: * for the first), and a 412 starts over
// from a fresh read. Every machine pulls the web host like any peer, read-only, into <folder>/hosts/<web-host-id>/.
//
// One writer per web host, as per machine host (review r1 #3): every write and delete of one (person, project) runs
// through one queue, live a Durable Object per folder (webhost-do.ts), so two of them never interleave their file and
// manifest steps. And until the manifest lists new bytes, the old ones are what the file holds: a write journals what
// it is about to change, and a manifest PUT that fails (or never happens, if the write is cut off) is undone, at once
// or by the folder's next write, from the trash copy. WHY a queue and not a content-addressed key the manifest points
// at: every reader (the Go round, readers/worker, readers/python) reads hosts/<host>/<path> and checks its sha256
// against the manifest; a second key layout would change the bucket contract for all of them.
//
// WHY not v1's two-way shared/: it needs the lease, which is not built; the web host needs nothing new from the sync
// engine and keeps every rule.

import { checkPath, ContractError, SCHEMA, validateManifest, type Manifest, type ManifestEntry, type R2BucketLike } from "../../readers/worker/src/folder-sync-read.ts";
import { mint, NotConfigured, userRoot, type CredsEnv } from "./creds.ts";
import { Measuring, overQuota, quotaOf, usageOf, type QuotaEnv } from "./quota.ts";
import { Denied, S3Bucket, type FetchLike } from "./s3-bucket.ts";
import type { Store } from "./store.ts";

export const WEB_HOST_NAME = "web";
/** How many times a manifest write starts over after a 412 before giving up. */
const ATTEMPTS = 6;

export interface WritableBucket extends R2BucketLike {
	put(key: string, body: Uint8Array, options?: { ifMatch?: string; ifNoneMatch?: "*"; contentType?: string }): Promise<{ ok: boolean; status: number; etag: string }>;
	copy(from: string, to: string): Promise<boolean>;
	delete(key: string): Promise<void>;
}

/** The path is not one folder-sync could write on every machine (answered 400). */
export class BadPath extends Error {}
/** Another writer kept moving the manifest (answered 503: try again). */
export class Busy extends Error {}
/** The web host already holds a newer version of the path (keepNewest; answered 409). */
export class Stale extends Error {}
/** The body lacks what the write asked to be compared (keepNewest's field; answered 400). */
export class BadBody extends Error {}
/** A cut-off change could not be undone yet; nothing new runs until it is (answered 503: try again). */
export class Recovering extends Error {}
/** The write would take the person past their quota (quota.ts; answered 403). */
export class OverQuota extends Error {}

/** A change's cost to the person's quota: admitted before any byte moves, charged once the manifest takes it. Both
 *  run in the folder's queue (review r2 #6), so two writes are never admitted against the same figure. */
export interface Ledger {
	admit(bytes: number, objects: number): Promise<void>;
	charge(bytes: number, objects: number): Promise<void>;
}

/** A JSON field name a write may ask the web host to keep the newest of (X-Folder-Sync-Keep-Newest). */
export const NEWEST_FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Whether `data`'s JSON field `field` is exactly true (X-Folder-Sync-Tie-Prefers). */
export function prefers(data: Uint8Array, field: string): boolean {
	try {
		const doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
		return !!doc && typeof doc === "object" && doc[field] === true;
	} catch {
		return false;
	}
}

/** The instant in `data`'s JSON field `field` (an RFC 3339 string), or null when there is none. */
export function instantOf(data: Uint8Array, field: string): number | null {
	try {
		const doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
		const value = doc && typeof doc === "object" && !Array.isArray(doc) ? doc[field] : undefined;
		const time = typeof value === "string" ? Date.parse(value) : NaN;
		return Number.isFinite(time) ? time : null;
	} catch {
		return null;
	}
}

const WINDOWS_RESERVED_CHARS = /[<>:"|?*\\]/;
const WINDOWS_RESERVED_NAMES = new Set([
	"CON", "PRN", "AUX", "NUL",
	..."123456789¹²³".split("").flatMap((d) => [`COM${d}`, `LPT${d}`]),
]);

/** The contract's path rules (docs/CONTRACT.md "Bucket layout"), as internal/names checks them at push: relative,
 *  no '.'/'..'/empty segment, no backslash or drive letter, nothing Windows can't name, not the root manifest.json. */
export function checkWebPath(path: string): void {
	try {
		checkPath(path);
	} catch (error) {
		throw new BadPath(error instanceof Error ? error.message : String(error));
	}
	if (path === "manifest.json") throw new BadPath("manifest.json at the root of a folder is the manifest's own key");
	if (new TextEncoder().encode(path).byteLength > 900) throw new BadPath("the path is too long");
	for (const segment of path.split("/")) {
		if (WINDOWS_RESERVED_CHARS.test(segment)) throw new BadPath(`${JSON.stringify(segment)} holds a character Windows reserves`);
		if (/[\u0000-\u001f\u007f]/.test(segment)) throw new BadPath("a control character in a name");
		if (/[. ]$/.test(segment)) throw new BadPath(`Windows drops the trailing dot or space of ${JSON.stringify(segment)}`);
		const base = segment.split(".")[0].replace(/ +$/, "").toUpperCase();
		if (WINDOWS_RESERVED_NAMES.has(base)) throw new BadPath(`${JSON.stringify(segment)} is a device name on Windows`);
	}
}

/** YYYYMMDDTHHMMSSZ, the contract's trash stamp. */
export function stamp(now: number): string {
	return new Date(now).toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
}

/** One trash copy's own stamp segment: the contract's UTC stamp, then the millisecond and 8 random hex digits
 *  (20261026T123456Z-789-1f2e3d4c). WHY unique: two replacements of one path in the same second would otherwise
 *  copy to the same key, the second overwriting the first (review r1 #8); WHY the contract's stamp first: anything
 *  that sorts or groups the trash by its second still reads it. */
export function trashStamp(now: number): string {
	const nonce = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `${stamp(now)}-${String(new Date(now).getUTCMilliseconds()).padStart(3, "0")}-${nonce}`;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface Where {
	root: string;
	project: string;
	hostId: string;
}

function hostKey(w: Where, path: string): string {
	return `${w.root}${w.project}/hosts/${w.hostId}/${path}`;
}

function trashKey(w: Where, path: string, now: number): string {
	return `${w.root}_trash/${w.project}/${w.hostId}/${trashStamp(now)}/${path}`;
}

/** The web host's manifest, the ETag it was read with and its size in bytes; an empty seq-0 manifest (size 0) before
 *  the first write. */
async function readManifest(bucket: WritableBucket, w: Where): Promise<{ manifest: Manifest; etag: string | null; size: number }> {
	const object = await bucket.get(hostKey(w, "manifest.json"));
	if (!object) {
		return { manifest: { schema: SCHEMA, project: w.project, host_id: w.hostId, host_name: WEB_HOST_NAME, seq: 0, generated_at: "", files: [] }, etag: null, size: 0 };
	}
	if (!("arrayBuffer" in object)) throw new ContractError("the web host's manifest came back without a body");
	const data = await object.arrayBuffer();
	const manifest = validateManifest(JSON.parse(new TextDecoder().decode(data)) as Manifest, w.project, w.hostId);
	return { manifest, etag: object.etag, size: data.byteLength };
}

function manifestBytes(manifest: Manifest): Uint8Array {
	return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

async function writeManifest(bucket: WritableBucket, w: Where, manifest: Manifest, etag: string | null): Promise<boolean> {
	const body = manifestBytes(manifest);
	const answer = await bucket.put(hostKey(w, "manifest.json"), body, etag ? { ifMatch: etag, contentType: "application/json" } : { ifNoneMatch: "*", contentType: "application/json" });
	return answer.ok;
}

function next(manifest: Manifest, files: ManifestEntry[], now: number): Manifest {
	const iso = new Date(now).toISOString();
	return {
		schema: SCHEMA,
		project: manifest.project,
		host_id: manifest.host_id,
		host_name: WEB_HOST_NAME,
		seq: manifest.seq + 1,
		generated_at: iso,
		// sorted by path, byte order as folder-sync's Go writer sorts them
		files: [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
	};
}

/** What a write or delete is about to change, kept until the manifest lists it or it is undone (review r1 #3). */
export interface Pending {
	/** Which web host: so the folder's alarm can settle it with nothing else to go on (review r2 #2). */
	where: Where;
	path: string;
	/** The trash copy of the bytes the manifest lists for `path`, or null when it lists none (a new path). */
	restore: string | null;
	/** Their sha256, so a copy is only put back over the bytes it was taken from, and their size (what the copy costs
	 *  while it stays). */
	restoreSha256: string | null;
	restoreSize?: number | null;
	/** What the manifest lists once the change commits: the new bytes' sha256, or null for a delete. */
	sha256: string | null;
}

/** Where a web host keeps its one Pending: the Durable Object's storage live, memory in the tests. */
export interface Journal {
	get(): Promise<Pending | null>;
	put(pending: Pending): Promise<void>;
	delete(): Promise<void>;
	/** A backup an undo could not remove (review r4 #7): charged to `root`'s person and removed later, durably. */
	stray(root: string, key: string, size: number): Promise<void>;
}

export function memoryJournal(): Journal {
	let pending: Pending | null = null;
	return {
		get: async () => pending,
		put: async (p) => { pending = p; },
		delete: async () => { pending = null; },
		stray: async () => undefined,
	};
}

/** The account id of a root, users/<id>/. */
function ownerOf(root: string): string {
	return root.slice("users/".length, -1);
}

/** Puts a cut-off write or delete right: when the manifest did not take it, the file goes back to the bytes the
 *  manifest lists (the trash copy), or away when it lists none. Every web-host operation starts with this. The journal
 *  is cleared only once that has worked, so a failed undo is tried again by the next one. */
export async function settle(bucket: WritableBucket, w: Where, journal: Journal): Promise<void> {
	const pending = await journal.get();
	if (!pending) return;
	const { manifest } = await readManifest(bucket, w);
	const entry = manifest.files.find((e) => e.path === pending.path);
	const committed = pending.sha256 === null ? !entry : entry?.sha256 === pending.sha256;
	if (!committed) {
		if (!entry) await bucket.delete(hostKey(w, pending.path));
		else if (!(await holds(bucket, hostKey(w, pending.path), entry.sha256))) {
			// WHY checked, not assumed (review r4 #2): a COPY from a backup that is gone copies nothing, and the journal
			// is the only record of what to put back; it stays until the file is verified to hold the manifest's bytes
			if (!pending.restore || entry.sha256 !== pending.restoreSha256 || !(await bucket.copy(pending.restore, hostKey(w, pending.path)))) {
				throw new Error(`the backup of ${JSON.stringify(pending.path)} is not there to put back`);
			}
			if (!(await holds(bucket, hostKey(w, pending.path), entry.sha256))) throw new Error(`${JSON.stringify(pending.path)} does not match its manifest after the restore`);
		}
		// WHY (review r3 #6): the trash copy was taken for this change alone; undone, it is a second copy of what is
		// live, which the quota never charged. WHY a stray when its delete fails (review r4 #7): it is charged until the
		// folder's alarm removes it, so the usage never counts less than what is stored
		if (pending.restore) {
			try {
				await bucket.delete(pending.restore);
			} catch {
				await journal.stray(w.root, pending.restore, pending.restoreSize ?? 0);
			}
		}
	}
	await journal.delete();
}

/** Whether the object at `key` holds the bytes whose sha256 is `sha256`. */
async function holds(bucket: WritableBucket, key: string, sha256: string): Promise<boolean> {
	const object = await bucket.get(key);
	return !!object && "arrayBuffer" in object && (await sha256Hex(new Uint8Array(await object.arrayBuffer()))) === sha256;
}

/** Settles any cut-off change first; one that cannot be undone yet stops this operation (Recovering). */
async function recover(bucket: WritableBucket, w: Where, journal: Journal): Promise<void> {
	try {
		await settle(bucket, w, journal);
	} catch (error) {
		throw new Recovering(`an earlier change to this folder's web host could not be undone yet (${error instanceof Error ? error.message : String(error)}); try again`);
	}
}

/** Runs one change (its file steps, then the manifest PUT); undoes the file steps unless the manifest took them.
 *  WHY a failed undo throws (review r2 #3): a retry would journal a new change over this one, and the record of the
 *  bytes to put back would be lost; so the change stops, its journal stays, and the next operation (or the alarm,
 *  webhost-do.ts) undoes it before anything else runs. */
async function change(bucket: WritableBucket, w: Where, journal: Journal, pending: Pending, steps: () => Promise<boolean>): Promise<boolean> {
	await journal.put(pending);
	let committed = false;
	let failure: unknown = null;
	try {
		committed = await steps();
	} catch (error) {
		failure = error;
	}
	if (committed) {
		await journal.delete();
		return true;
	}
	await recover(bucket, w, journal);
	if (failure) throw failure;
	return false;
}

/** Writes `path` into the web host: trash copy of the old version, the file, then the manifest (If-Match).
 *  `keepNewest` names a JSON field (an RFC 3339 instant): then a write older than the stored version is refused
 *  (Stale), so two tabs' writes arriving out of order keep the newest (review r1 #4: newest heart wins). An exact tie
 *  is settled the same in either order (review r2 #5): the body whose `tiePrefers` field is true wins (robotparts' "a
 *  heart wins a tie"), else the larger sha256. */
export async function writeWebFile(bucket: WritableBucket, w: Where, path: string, data: Uint8Array, clock: () => number, journal: Journal = memoryJournal(),
	{ keepNewest, tiePrefers, ledger }: { keepNewest?: string; tiePrefers?: string; ledger?: Ledger } = {}): Promise<{ host: string; path: string; sha256: string; seq: number }> {
	checkWebPath(path);
	const sha256 = await sha256Hex(data);
	const mine = keepNewest ? instantOf(data, keepNewest) : null;
	if (keepNewest && mine === null) throw new BadBody(`the body is not a JSON object with an RFC 3339 ${JSON.stringify(keepNewest)}, which X-Folder-Sync-Keep-Newest names`);
	await recover(bucket, w, journal);
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const now = clock();
		const { manifest, etag, size } = await readManifest(bucket, w);
		const old = manifest.files.find((e) => e.path === path);
		if (old && old.sha256 === sha256 && old.size === data.byteLength) return { host: w.hostId, path, sha256, seq: manifest.seq };
		const twin = manifest.files.find((e) => e.path !== path && e.path.toLowerCase() === path.toLowerCase());
		if (twin) throw new BadPath(`${JSON.stringify(path)} and ${JSON.stringify(twin.path)} differ only by case, which Windows and macOS cannot hold`);
		if (keepNewest && old && mine !== null) {
			// WHY the stored bytes are the manifest's: this runs in the folder's one queue, after settle()
			const stored = await bucket.get(hostKey(w, path));
			const bytes = stored && "arrayBuffer" in stored ? new Uint8Array(await stored.arrayBuffer()) : null;
			const theirs = bytes ? instantOf(bytes, keepNewest) : null;
			if (theirs !== null && theirs > mine) throw new Stale(`the web host already holds a newer ${keepNewest} (${new Date(theirs).toISOString()}) for ${JSON.stringify(path)}`);
			if (theirs !== null && theirs === mine && bytes) {
				const ours = !!tiePrefers && prefers(data, tiePrefers);
				const kept = !!tiePrefers && prefers(bytes, tiePrefers);
				if (kept !== ours ? kept : old.sha256 > sha256) throw new Stale(`the web host already holds a version of ${JSON.stringify(path)} with the same ${keepNewest} that wins the tie`);
			}
		}
		const iso = new Date(now).toISOString();
		const entry: ManifestEntry = { path, size: data.byteLength, mtime: iso, sha256, written_at: iso };
		const updated = next(manifest, [...manifest.files.filter((e) => e.path !== path), entry], now);
		// the net cost: the new bytes (the old ones move to _trash/ and still count), one object (the file, or the trash
		// copy of the old one), and the manifest's change (one object more on the first write)
		const cost = { bytes: data.byteLength + manifestBytes(updated).byteLength - size, objects: 1 + (etag ? 0 : 1) };
		await ledger?.admit(cost.bytes, cost.objects);
		const restore = old ? trashKey(w, path, now) : null;
		// WHY the backup inside the change (review r4 #7): it is journalled before it is made, so a backup left by a
		// cut-off change is always one the journal names, and is removed or charged
		const committed = await change(bucket, w, journal, { where: w, path, restore, restoreSha256: old?.sha256 ?? null, restoreSize: old?.size ?? null, sha256 }, async () => {
			if (restore && !(await bucket.copy(hostKey(w, path), restore))) throw new Error(`${JSON.stringify(path)} could not be copied to the trash`);
			await bucket.put(hostKey(w, path), data);
			return writeManifest(bucket, w, updated, etag);
		});
		if (committed) {
			await ledger?.charge(cost.bytes, cost.objects);
			return { host: w.hostId, path, sha256, seq: updated.seq };
		}
		// 412: another write moved the manifest since our read; the file is back as it was, start over from a fresh read
	}
	throw new Busy("the web host's manifest kept changing; try again");
}

/** Removes `path` from the web host (moved to _trash/); null when the web host does not hold it. */
export async function deleteWebFile(bucket: WritableBucket, w: Where, path: string, clock: () => number, journal: Journal = memoryJournal(), ledger?: Ledger): Promise<{ host: string; path: string; seq: number } | null> {
	checkWebPath(path);
	await recover(bucket, w, journal);
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const now = clock();
		const { manifest, etag, size } = await readManifest(bucket, w);
		const old = manifest.files.find((e) => e.path === path);
		if (!old) return null;
		const restore = trashKey(w, path, now);
		const updated = next(manifest, manifest.files.filter((e) => e.path !== path), now);
		// the file moves to _trash/ (still counted): only the manifest shrinks
		const cost = { bytes: manifestBytes(updated).byteLength - size, objects: 0 };
		const committed = await change(bucket, w, journal, { where: w, path, restore, restoreSha256: old.sha256, restoreSize: old.size, sha256: null }, async () => {
			if (!(await bucket.copy(hostKey(w, path), restore))) throw new Error(`${JSON.stringify(path)} could not be copied to the trash`);
			await bucket.delete(hostKey(w, path));
			return writeManifest(bucket, w, updated, etag);
		});
		if (committed) {
			await ledger?.charge(cost.bytes, cost.objects);
			return { host: w.hostId, path, seq: updated.seq };
		}
	}
	throw new Busy("the web host's manifest kept changing; try again");
}

// ------------------------------------------------------------------------------------------------ one writer per host

/** One job at a time per key, in arrival order (a job that fails does not stop the next). */
export class Serial {
	private readonly tails = new Map<string, Promise<unknown>>();

	run<T>(key: string, job: () => Promise<T>): Promise<T> {
		const result = (this.tails.get(key) ?? Promise.resolve()).then(() => job());
		const tail = result.catch(() => undefined);
		this.tails.set(key, tail);
		void tail.then(() => {
			if (this.tails.get(key) === tail) this.tails.delete(key);
		});
		return result;
	}
}

/** One web-host operation, as the route hands it to the folder's queue (plain data: it crosses into a Durable Object). */
export interface WebOp {
	/** SETTLE only puts a cut-off change right (a read asks for it first: review r2 #2). HOST_DELETE is a machine
	 *  host's delete through the Worker while its keys are read-only (over quota: review r2 #7, r3 #1-2). */
	method: "PUT" | "DELETE" | "SETTLE" | "HOST_DELETE" | "PURGE_TRASH";
	owner: string;
	project: string;
	hostId: string;
	path: string;
	data?: Uint8Array;
	/** X-Folder-Sync-Keep-Newest: the JSON field whose newest instant the web host keeps for this path. */
	keepNewest?: string;
	/** X-Folder-Sync-Tie-Prefers: on an exact tie of keepNewest, the body whose field is true wins. */
	tiePrefers?: string;
	/** HOST_DELETE: the caller's job id (a UUID it keeps until it has the answer), the seq of the manifest it last
	 *  published, and the paths it drops. */
	job?: string;
	fromSeq?: number;
	paths?: string[];
	/** DELETE: permanently, with no trash copy (a person under or over quota freeing space, review r3 #3). */
	permanent?: boolean;
}

/** The answer to send: a status, a JSON body (an error is { error, why }) and extra headers. */
export interface WebAnswer {
	status: number;
	body: unknown;
	headers?: Record<string, string>;
}

/** The key of a folder's queue (and the name of its Durable Object). */
export function webHostName(owner: string, project: string): string {
	return `${owner}/${project}`;
}

/** How long the credential a web-host operation signs lives. */
const WRITE_TTL_S = 300;

/** Runs one web-host operation in the caller's queue: signs a read-write credential for the owner's root, settles any
 *  cut-off change first, then writes or deletes. Errors the person can act on come back as answers. */
export async function runWebOp(env: CredsEnv & QuotaEnv, s3: FetchLike, op: WebOp, journal: Journal, clock: () => number, store: Store): Promise<WebAnswer> {
	try {
		const root = userRoot(op.owner);
		const bucket = new S3Bucket(await mint(env, root, "object-read-write", WRITE_TTL_S, clock()), s3);
		const w = { root, project: op.project, hostId: op.hostId };
		const quota = quotaOf(env);
		const ledger: Ledger = {
			async admit(bytes, objects) {
				if (bytes <= 0 && objects <= 0) return;
				const usage = await usageOf(store, op.owner, quota, clock(), () => bucket.measure(root, { bytes: quota.bytes, objects: quota.objects }));
				const over = overQuota(usage, quota, bytes, objects);
				if (over) throw new OverQuota(over);
			},
			charge: (bytes, objects) => store.addUsage(op.owner, bytes, objects),
		};
		if (op.method === "SETTLE") {
			await recover(bucket, w, journal);
			return { status: 200, body: { settled: true } };
		}
		if (op.method === "PUT") return { status: 200, body: await writeWebFile(bucket, w, op.path, op.data ?? new Uint8Array(), clock, journal, { keepNewest: op.keepNewest, tiePrefers: op.tiePrefers, ledger }) };
		const gone = await deleteWebFile(bucket, w, op.path, clock, journal, ledger);
		return gone ? { status: 200, body: gone } : { status: 404, body: { error: "not_found", why: "the web host does not hold that file" } };
	} catch (error) {
		if (error instanceof BadPath) return { status: 400, body: { error: "bad_path", why: error.message } };
		if (error instanceof Busy) return { status: 503, body: { error: "busy", why: error.message }, headers: { "Retry-After": "1" } };
		if (error instanceof Stale) return { status: 409, body: { error: "stale", why: error.message } };
		if (error instanceof Measuring) return { status: 503, body: { error: "measuring", why: error.message }, headers: { "Retry-After": "60" } };
		if (error instanceof OverQuota) return { status: 403, body: { error: "over_quota", why: error.message } };
		if (error instanceof Recovering) return { status: 503, body: { error: "recovering", why: error.message }, headers: { "Retry-After": "5" } };
		if (error instanceof BadBody) return { status: 400, body: { error: "bad_body", why: error.message } };
		if (error instanceof NotConfigured) return { status: 503, body: { error: "not_configured", why: "folder storage is not set up on this Worker yet" } };
		if (error instanceof Denied) return { status: 404, body: { error: "not_found", why: "no such file" } };
		if (error instanceof ContractError) return { status: 502, body: { error: "bad_manifest", why: "a host's manifest breaks the contract" } };
		throw error;
	}
}

/** A Durable Object's storage, as the web host uses it: the journal under one key, and one alarm. */
export interface ObjectStorage {
	get<T>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<unknown>;
	list<T>(options: { prefix: string }): Promise<Map<string, T>>;
	setAlarm(at: number): Promise<void>;
	deleteAlarm(): Promise<void>;
}

/** A host's delete through the Worker (review r3 #2), kept in the folder's object until its files are gone, so the
 *  manifest commit, the cleanup and the usage are each done once: by the request, a replay of the same job id, or the
 *  alarm. The next manifest is rebuilt from the stored one each time it is needed (it can be large). */
export interface DeleteJob {
	id: string;
	owner: string;
	where: Where;
	fromSeq: number;
	toSeq: number;
	generatedAt: string;
	paths: string[];
	sizes: Record<string, number>;
	remaining: string[];
	committed: boolean;
	/** Saved true before the manifest write is first tried: until then the job cannot have committed (review r6 #1).
	 *  Absent on a job saved before this field existed: treated as tried. */
	committing?: boolean;
	at: number;
}

/** How long a finished job is kept, so a replay after a lost answer still gets it. */
const JOB_KEEP_MS = 7 * 24 * 3600 * 1000;

/** The next manifest of a delete: the stored one with the job's paths removed, the job's seq and time. */
function jobManifest(job: DeleteJob, stored: Manifest): Manifest {
	const dropped = new Set(job.paths);
	return { schema: SCHEMA, project: job.where.project, host_id: job.where.hostId, host_name: stored.host_name, seq: job.toSeq, generated_at: job.generatedAt, files: stored.files.filter((e) => !dropped.has(e.path)) };
}

/** Advances a job as far as it goes: commits its manifest (If-Match on the stored one at fromSeq), then deletes each
 *  remaining file and lowers the usage by it, saving after each step. Returns the stored manifest once committed, or
 *  null when the host's manifest moved past it some other way (the job is then dropped). */
async function advance(bucket: WritableBucket, job: DeleteJob, save: (job: DeleteJob) => Promise<void>, drop: () => Promise<void>, store: Store): Promise<Manifest | null> {
	const w = job.where;
	const object = await bucket.get(hostKey(w, "manifest.json"));
	if (!object || !("arrayBuffer" in object)) {
		await drop();
		return null;
	}
	const bytes = await object.arrayBuffer();
	const stored = validateManifest(JSON.parse(new TextDecoder().decode(bytes)) as Manifest, w.project, w.hostId);
	let current: Manifest = stored;
	if (!job.committed) {
		if (stored.seq === job.fromSeq) {
			const next = jobManifest(job, stored);
			const body = manifestBytes(next);
			if (!job.committing) {
				job.committing = true;
				await save(job);
			}
			if (!(await writeManifest(bucket, w, next, object.etag))) {
				await drop();
				return null;
			}
			job.committed = true;
			await save(job);
			// WHY saved before charged: a crash between loses this credit (the usage reads high until it is measured
			// again), never charges it twice
			await store.addUsage(job.owner, body.byteLength - bytes.byteLength, 0);
			current = next;
		} else if (stored.seq >= job.toSeq && job.committing !== false) {
			// the manifest write was tried and the seq is at or past the job's: it committed before a restart cut the job
			// off, maybe with later changes on top. WHY kept (review r6 #1): dropped, its files would stay stored and
			// counted with nothing left to delete them; and should the write not have landed after all, the fence below
			// never deletes a path the current manifest lists
			job.committed = true;
			await save(job);
		} else {
			await drop();
			return null;
		}
	}
	// WHY fenced (review r4 #1): a cleanup that waited (a failed delete, a restart) can run after the path was written
	// again; the current manifest listing it, or an object of another size, is someone's newer copy, never deleted
	const relisted = new Set(current.files.map((e) => e.path));
	for (const path of [...job.remaining]) {
		try {
			const object = relisted.has(path) ? null : await bucket.head(hostKey(w, path));
			if (object && object.size === job.sizes[path]) await bucket.delete(hostKey(w, path));
		} catch {
			continue; // still there: the next replay or the alarm tries again
		}
		// gone, or overwritten by the newer copy: either way the bytes this job removed no longer exist
		job.remaining = job.remaining.filter((p) => p !== path);
		await save(job);
		await store.addUsage(job.owner, -job.sizes[path], -1);
	}
	return current.seq === job.toSeq ? current : null;
}

/** How long a journalled change may stay unsettled before the folder's alarm settles it (and the retry after that). */
const SETTLE_AFTER_MS = 30_000;

/** One folder's web host: its queue, its journal in `storage`, and the alarm that settles a cut-off change with no
 *  other request to do it (review r2 #2). The Durable Object (webhost-do.ts) is this over its own storage. */
export class WebHostCore {
	private readonly serial = new Serial();
	private readonly env: CredsEnv & QuotaEnv;
	private readonly s3: FetchLike;
	private readonly storage: ObjectStorage;
	private readonly clock: () => number;
	private readonly store: Store;

	constructor(env: CredsEnv & QuotaEnv, s3: FetchLike, storage: ObjectStorage, clock: () => number, store: Store) {
		this.env = env;
		this.s3 = s3;
		this.storage = storage;
		this.clock = clock;
		this.store = store;
	}

	/** Sets the alarm while anything is left to do (a journalled change, a delete job with files left), else clears it. */
	private async rearm(): Promise<void> {
		const busy = !!(await this.storage.get("pending")) || [...(await this.storage.list<DeleteJob>({ prefix: "job:" })).values()].some((j) => !j.committed || j.remaining.length)
			|| (await this.storage.list({ prefix: "stray:" })).size > 0;
		if (busy) await this.storage.setAlarm(this.clock() + SETTLE_AFTER_MS);
		else await this.storage.deleteAlarm();
	}

	private journal(): Journal {
		const { storage } = this;
		return {
			get: async () => (await storage.get<Pending>("pending")) ?? null,
			// WHY one step (review r4 #3): issued together, a Durable Object commits the journal and its alarm at once,
			// before the change touches the bucket, so a restart never leaves a change with no alarm to settle it
			put: async (pending) => {
				await Promise.all([storage.put("pending", pending), storage.setAlarm(this.clock() + SETTLE_AFTER_MS)]);
			},
			delete: async () => {
				await storage.delete("pending");
				await this.rearm();
			},
			// charged first, then recorded: a restart between them over-counts until the next measurement, never under
			stray: async (root, key, size) => {
				await this.store.addUsage(ownerOf(root), size, 1);
				await Promise.all([storage.put(`stray:${key}`, { root, key, size }), storage.setAlarm(this.clock() + SETTLE_AFTER_MS)]);
			},
		};
	}

	/** One write, delete or settle of this folder's web host, or a machine host's delete, after every earlier one has
	 *  finished (`env`: the vars to run it with, the object's own unless a test's request brings others). */
	run(op: WebOp, env: CredsEnv & QuotaEnv = this.env): Promise<WebAnswer> {
		if (op.method === "HOST_DELETE") return this.serial.run("", () => this.hostDelete(env, op));
		if (op.method === "DELETE" && op.permanent) return this.serial.run("", () => this.permanentWebDelete(env, op));
		if (op.method === "PURGE_TRASH") return this.serial.run("", () => this.purgeTrash(env, op));
		return this.serial.run("", () => runWebOp(env, this.s3, op, this.journal(), this.clock, this.store));
	}

	private async job(env: CredsEnv, job: DeleteJob): Promise<Manifest | null> {
		const bucket = new S3Bucket(await mint(env, job.where.root, "object-read-write", WRITE_TTL_S, this.clock()), this.s3);
		const key = `job:${job.id}`;
		const result = await advance(bucket, job, (j) => this.storage.put(key, j), () => this.storage.delete(key).then(() => undefined), this.store);
		await this.rearm();
		return result;
	}

	/** HOST_DELETE (review r2 #7, r3 #1-2): a new job is checked against the stored manifest and saved before anything
	 *  is written; a job id seen before is the same job, resumed. */
	private async hostDelete(env: CredsEnv & QuotaEnv, op: WebOp): Promise<WebAnswer> {
		const refuse = (status: number, error: string, why: string): WebAnswer => ({ status, body: { error, why } });
		try {
			const root = userRoot(op.owner);
			const where = { root, project: op.project, hostId: op.hostId };
			const paths = op.paths ?? [];
			let job = await this.storage.get<DeleteJob>(`job:${op.job}`);
			if (job && (job.where.hostId !== op.hostId || job.owner !== op.owner || job.fromSeq !== op.fromSeq || JSON.stringify(job.paths) !== JSON.stringify(paths))) {
				return refuse(409, "job_mismatch", "this job id was used for another delete");
			}
			if (!job) {
				const bucket = new S3Bucket(await mint(env, root, "object-read-only", WRITE_TTL_S, this.clock()), this.s3);
				const object = await bucket.get(hostKey(where, "manifest.json"));
				if (!object || !("arrayBuffer" in object)) return refuse(404, "not_found", "this person has no such host in this folder");
				const stored = validateManifest(JSON.parse(new TextDecoder().decode(await object.arrayBuffer())) as Manifest, op.project, op.hostId);
				if (stored.seq !== op.fromSeq) return refuse(409, "manifest_changed", `this host's manifest is at seq ${stored.seq}, not ${op.fromSeq}: sync again`);
				const listed = new Map(stored.files.map((e) => [e.path, e]));
				const missing = paths.filter((p) => !listed.has(p));
				if (missing.length) return refuse(400, "bad_paths", `the manifest does not list ${JSON.stringify(missing.slice(0, 3))}`);
				job = { id: op.job!, owner: op.owner, where, fromSeq: stored.seq, toSeq: stored.seq + 1, generatedAt: new Date(this.clock()).toISOString(), paths,
					sizes: Object.fromEntries(paths.map((p) => [p, listed.get(p)!.size])), remaining: [...paths], committed: false, committing: false, at: this.clock() };
				// the job and its alarm together, before the first bucket write (review r4 #3)
				await Promise.all([this.storage.put(`job:${job.id}`, job), this.storage.setAlarm(this.clock() + SETTLE_AFTER_MS)]);
			}
			const manifest = await this.job(env, job);
			if (!manifest) return refuse(409, "manifest_changed", "this host's manifest moved on: sync again");
			const pending = job.remaining;
			return { status: 200, body: { seq: job.toSeq, deleted: job.paths.filter((p) => !pending.includes(p)), pending, manifest } };
		} catch (error) {
			if (error instanceof NotConfigured) return refuse(503, "not_configured", "folder storage is not set up on this Worker yet");
			if (error instanceof ContractError) return refuse(502, "bad_manifest", "a host's manifest breaks the contract");
			throw error;
		}
	}

	/** A web file deleted permanently (review r3 #3): the web host settled first, then the same job as a machine's
	 *  delete (the manifest committed, then the file deleted with no trash copy, the usage lowered, each once). */
	private async permanentWebDelete(env: CredsEnv & QuotaEnv, op: WebOp): Promise<WebAnswer> {
		const settled = await runWebOp(env, this.s3, { ...op, method: "SETTLE", permanent: false }, this.journal(), this.clock, this.store);
		if (settled.status !== 200) return settled;
		try {
			checkWebPath(op.path);
		} catch (error) {
			return { status: 400, body: { error: "bad_path", why: error instanceof Error ? error.message : String(error) } };
		}
		const root = userRoot(op.owner);
		const bucket = new S3Bucket(await mint(env, root, "object-read-only", WRITE_TTL_S, this.clock()), this.s3);
		const { manifest } = await readManifest(bucket, { root, project: op.project, hostId: op.hostId });
		if (!manifest.files.some((e) => e.path === op.path)) return { status: 404, body: { error: "not_found", why: "the web host does not hold that file" } };
		const answer = await this.hostDelete(env, { ...op, method: "HOST_DELETE", job: crypto.randomUUID(), fromSeq: manifest.seq, paths: [op.path] });
		if (answer.status !== 200) return answer;
		const body = answer.body as { seq: number; pending: string[] };
		return { status: 200, body: { host: op.hostId, path: op.path, seq: body.seq, permanent: true, pending: body.pending } };
	}

	/** The web host's trash, deleted for good, a page (1000 copies) at a time, the usage lowered by each (review r3 #3):
	 *  how a person with only a browser gets under their quota once their deletes have gone to the trash. WHY only
	 *  the web host's: a machine's trash is its own; over quota its deletes skip the trash already. */
	private async purgeTrash(env: CredsEnv & QuotaEnv, op: WebOp): Promise<WebAnswer> {
		// WHY settled first (review r4 #2): a cut-off change's backup lives in this trash; while it is journalled the
		// purge waits (503 recovering), and once settled no journal names any copy here
		const settled = await runWebOp(env, this.s3, { ...op, method: "SETTLE" }, this.journal(), this.clock, this.store);
		if (settled.status !== 200) return settled;
		const root = userRoot(op.owner);
		const bucket = new S3Bucket(await mint(env, root, "object-read-write", WRITE_TTL_S, this.clock()), this.s3);
		const { keys, more } = await bucket.keys(`${root}_trash/${op.project}/${op.hostId}/`);
		let purged = 0;
		let bytes = 0;
		for (const { key, size } of keys) {
			try {
				await bucket.delete(key);
			} catch {
				continue;
			}
			// a stray backup purged here is credited here, once (its record goes with it)
			await this.storage.delete(`stray:${key}`);
			purged += 1;
			bytes += size;
			await this.store.addUsage(op.owner, -size, -1);
		}
		return { status: 200, body: { purged, bytes, more: more || purged < keys.length } };
	}

	/** The alarm: settles a change a crash or a failed undo left journalled, finishes delete jobs, drops old finished
	 *  ones; tries again later while anything is left. */
	alarm(): Promise<void> {
		return this.serial.run("", async () => {
			const journal = this.journal();
			const pending = await journal.get();
			if (pending) {
				try {
					const bucket = new S3Bucket(await mint(this.env, pending.where.root, "object-read-write", WRITE_TTL_S, this.clock()), this.s3);
					await settle(bucket, pending.where, journal);
				} catch {
					// still pending: rearm() below keeps the alarm
				}
			}
			// backups an undo could not remove (review r4 #7): removed now, and credited once removed
			for (const [record, stray] of await this.storage.list<{ root: string; key: string; size: number }>({ prefix: "stray:" })) {
				try {
					const bucket = new S3Bucket(await mint(this.env, stray.root, "object-read-write", WRITE_TTL_S, this.clock()), this.s3);
					await bucket.delete(stray.key);
				} catch {
					continue;
				}
				await this.storage.delete(record);
				await this.store.addUsage(ownerOf(stray.root), -stray.size, -1);
			}
			for (const [key, job] of await this.storage.list<DeleteJob>({ prefix: "job:" })) {
				if (job.committed && !job.remaining.length) {
					if (this.clock() - job.at > JOB_KEEP_MS) await this.storage.delete(key);
					continue;
				}
				try {
					await this.job(this.env, job);
				} catch {
					// the next alarm tries again
				}
			}
			await this.rearm();
		});
	}
}

/** A Durable Object's storage in memory (the tests' and localWebHost's): its alarm never fires by itself. */
export function memoryStorage(): ObjectStorage {
	const data = new Map<string, unknown>();
	return {
		get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
		put: async (key, value) => { data.set(key, structuredClone(value)); },
		delete: async (key) => data.delete(key),
		list: async <T>({ prefix }: { prefix: string }) => new Map([...data].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T])),
		setAlarm: async () => undefined,
		deleteAlarm: async () => undefined,
	};
}

/** The web host in this isolate: one WebHostCore per folder. WHY only for the tests and a local proof without a
 *  Durable Object binding: in production two isolates would each have their own queue (auth.ts never uses it). */
export function localWebHost(s3: FetchLike, clock: () => number, store: Store): (op: WebOp, env: CredsEnv & QuotaEnv) => Promise<WebAnswer> {
	const cores = new Map<string, WebHostCore>();
	return (op, env) => {
		const name = webHostName(op.owner, op.project);
		if (!cores.has(name)) cores.set(name, new WebHostCore(env, s3, memoryStorage(), clock, store));
		return cores.get(name)!.run(op, env);
	};
}
