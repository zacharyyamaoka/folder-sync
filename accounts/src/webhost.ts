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
import { Denied, S3Bucket, type FetchLike } from "./s3-bucket.ts";

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

interface Where {
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

/** The web host's manifest and the ETag it was read with; an empty seq-0 manifest before the first write. */
async function readManifest(bucket: WritableBucket, w: Where): Promise<{ manifest: Manifest; etag: string | null }> {
	const object = await bucket.get(hostKey(w, "manifest.json"));
	if (!object) {
		return { manifest: { schema: SCHEMA, project: w.project, host_id: w.hostId, host_name: WEB_HOST_NAME, seq: 0, generated_at: "", files: [] }, etag: null };
	}
	if (!("arrayBuffer" in object)) throw new ContractError("the web host's manifest came back without a body");
	const manifest = validateManifest(JSON.parse(new TextDecoder().decode(await object.arrayBuffer())) as Manifest, w.project, w.hostId);
	return { manifest, etag: object.etag };
}

async function writeManifest(bucket: WritableBucket, w: Where, manifest: Manifest, etag: string | null): Promise<boolean> {
	const body = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
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
	path: string;
	/** The trash copy of the bytes the manifest lists for `path`, or null when it lists none (a new path). */
	restore: string | null;
	/** Their sha256, so a copy is only put back over the bytes it was taken from. */
	restoreSha256: string | null;
	/** What the manifest lists once the change commits: the new bytes' sha256, or null for a delete. */
	sha256: string | null;
}

/** Where a web host keeps its one Pending: the Durable Object's storage live, memory in the tests. */
export interface Journal {
	get(): Promise<Pending | null>;
	put(pending: Pending): Promise<void>;
	delete(): Promise<void>;
}

export function memoryJournal(): Journal {
	let pending: Pending | null = null;
	return {
		get: async () => pending,
		put: async (p) => { pending = p; },
		delete: async () => { pending = null; },
	};
}

/** Puts a cut-off write or delete right: when the manifest did not take it, the file goes back to the bytes the
 *  manifest lists (the trash copy), or away when it lists none. Every web-host operation starts with this. */
export async function settle(bucket: WritableBucket, w: Where, journal: Journal): Promise<void> {
	const pending = await journal.get();
	if (!pending) return;
	const { manifest } = await readManifest(bucket, w);
	const entry = manifest.files.find((e) => e.path === pending.path);
	const committed = pending.sha256 === null ? !entry : entry?.sha256 === pending.sha256;
	if (!committed) {
		if (!entry) await bucket.delete(hostKey(w, pending.path));
		else if (pending.restore && entry.sha256 === pending.restoreSha256) await bucket.copy(pending.restore, hostKey(w, pending.path));
	}
	await journal.delete();
}

/** Runs one change (its file steps, then the manifest PUT); undoes the file steps unless the manifest took them. */
async function change(bucket: WritableBucket, w: Where, journal: Journal, pending: Pending, steps: () => Promise<boolean>): Promise<boolean> {
	await journal.put(pending);
	let committed = false;
	try {
		committed = await steps();
	} finally {
		// WHY swallowed: the step's own error is the one to report; a failed undo stays journalled for the next write
		if (committed) await journal.delete();
		else await settle(bucket, w, journal).catch(() => undefined);
	}
	return committed;
}

/** Writes `path` into the web host: trash copy of the old version, the file, then the manifest (If-Match). */
export async function writeWebFile(bucket: WritableBucket, w: Where, path: string, data: Uint8Array, clock: () => number, journal: Journal = memoryJournal()): Promise<{ host: string; path: string; sha256: string; seq: number }> {
	checkWebPath(path);
	const sha256 = await sha256Hex(data);
	await settle(bucket, w, journal);
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const now = clock();
		const { manifest, etag } = await readManifest(bucket, w);
		const old = manifest.files.find((e) => e.path === path);
		if (old && old.sha256 === sha256 && old.size === data.byteLength) return { host: w.hostId, path, sha256, seq: manifest.seq };
		const twin = manifest.files.find((e) => e.path !== path && e.path.toLowerCase() === path.toLowerCase());
		if (twin) throw new BadPath(`${JSON.stringify(path)} and ${JSON.stringify(twin.path)} differ only by case, which Windows and macOS cannot hold`);
		const restore = old ? trashKey(w, path, now) : null;
		if (restore) await bucket.copy(hostKey(w, path), restore);
		const iso = new Date(now).toISOString();
		const entry: ManifestEntry = { path, size: data.byteLength, mtime: iso, sha256, written_at: iso };
		const updated = next(manifest, [...manifest.files.filter((e) => e.path !== path), entry], now);
		const committed = await change(bucket, w, journal, { path, restore, restoreSha256: old?.sha256 ?? null, sha256 }, async () => {
			await bucket.put(hostKey(w, path), data);
			return writeManifest(bucket, w, updated, etag);
		});
		if (committed) return { host: w.hostId, path, sha256, seq: updated.seq };
		// 412: another write moved the manifest since our read; the file is back as it was, start over from a fresh read
	}
	throw new Busy("the web host's manifest kept changing; try again");
}

/** Removes `path` from the web host (moved to _trash/); null when the web host does not hold it. */
export async function deleteWebFile(bucket: WritableBucket, w: Where, path: string, clock: () => number, journal: Journal = memoryJournal()): Promise<{ host: string; path: string; seq: number } | null> {
	checkWebPath(path);
	await settle(bucket, w, journal);
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const now = clock();
		const { manifest, etag } = await readManifest(bucket, w);
		const old = manifest.files.find((e) => e.path === path);
		if (!old) return null;
		const restore = trashKey(w, path, now);
		await bucket.copy(hostKey(w, path), restore);
		const updated = next(manifest, manifest.files.filter((e) => e.path !== path), now);
		const committed = await change(bucket, w, journal, { path, restore, restoreSha256: old.sha256, sha256: null }, async () => {
			await bucket.delete(hostKey(w, path));
			return writeManifest(bucket, w, updated, etag);
		});
		if (committed) return { host: w.hostId, path, seq: updated.seq };
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
	method: "PUT" | "DELETE";
	owner: string;
	project: string;
	hostId: string;
	path: string;
	data?: Uint8Array;
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
export async function runWebOp(env: CredsEnv, s3: FetchLike, op: WebOp, journal: Journal, clock: () => number): Promise<WebAnswer> {
	try {
		const root = userRoot(op.owner);
		const bucket = new S3Bucket(await mint(env, root, "object-read-write", WRITE_TTL_S, clock()), s3);
		const w = { root, project: op.project, hostId: op.hostId };
		if (op.method === "PUT") return { status: 200, body: await writeWebFile(bucket, w, op.path, op.data ?? new Uint8Array(), clock, journal) };
		const gone = await deleteWebFile(bucket, w, op.path, clock, journal);
		return gone ? { status: 200, body: gone } : { status: 404, body: { error: "not_found", why: "the web host does not hold that file" } };
	} catch (error) {
		if (error instanceof BadPath) return { status: 400, body: { error: "bad_path", why: error.message } };
		if (error instanceof Busy) return { status: 503, body: { error: "busy", why: error.message }, headers: { "Retry-After": "1" } };
		if (error instanceof NotConfigured) return { status: 503, body: { error: "not_configured", why: "folder storage is not set up on this Worker yet" } };
		if (error instanceof Denied) return { status: 404, body: { error: "not_found", why: "no such file" } };
		if (error instanceof ContractError) return { status: 502, body: { error: "bad_manifest", why: "a host's manifest breaks the contract" } };
		throw error;
	}
}

/** The web host in this isolate: one queue and journal per folder. WHY only for the tests and a local proof without a
 *  Durable Object binding: in production two isolates would each have their own queue (auth.ts never uses it). */
export function localWebHost(env: CredsEnv, s3: FetchLike, clock: () => number): (op: WebOp) => Promise<WebAnswer> {
	const serial = new Serial();
	const journals = new Map<string, Journal>();
	return (op) => {
		const name = webHostName(op.owner, op.project);
		if (!journals.has(name)) journals.set(name, memoryJournal());
		return serial.run(name, () => runWebOp(env, s3, op, journals.get(name)!, clock));
	};
}
