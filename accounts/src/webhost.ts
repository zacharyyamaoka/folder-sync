// The web host (PEP 0003 §3.4): how a browser writes without breaking single-writer.
//
// The bucket contract (docs/CONTRACT.md "Who writes") lets only folder-sync write hosts/<host-id>/, one writer per
// host. A browser has no folder, so this Worker IS a folder-sync host for each (person, project): its id is minted
// on the first write (the web_host row, a lowercase UUID v4), and it writes exactly as a round does: a replaced or
// deleted object is first copied to _trash/<project>/<host>/<stamp>/<path>, then the file, then the manifest. The
// manifest PUT carries If-Match on the ETag it was read with (If-None-Match: * for the first), and a 412 starts over
// from a fresh read. Every machine pulls the web host like any peer, read-only, into <folder>/hosts/<web-host-id>/.
//
// WHY not v1's two-way shared/: it needs the lease, which is not built; the web host needs nothing new from the sync
// engine and keeps every rule.

import { checkPath, ContractError, SCHEMA, validateManifest, type Manifest, type ManifestEntry, type R2BucketLike } from "../../readers/worker/src/folder-sync-read.ts";

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
	return `${w.root}_trash/${w.project}/${w.hostId}/${stamp(now)}/${path}`;
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

/** Writes `path` into the web host: trash copy of the old version, the file, then the manifest (If-Match). */
export async function writeWebFile(bucket: WritableBucket, w: Where, path: string, data: Uint8Array, clock: () => number): Promise<{ host: string; path: string; sha256: string; seq: number }> {
	checkWebPath(path);
	const sha256 = await sha256Hex(data);
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const now = clock();
		const { manifest, etag } = await readManifest(bucket, w);
		const old = manifest.files.find((e) => e.path === path);
		if (old && old.sha256 === sha256 && old.size === data.byteLength) return { host: w.hostId, path, sha256, seq: manifest.seq };
		const twin = manifest.files.find((e) => e.path !== path && e.path.toLowerCase() === path.toLowerCase());
		if (twin) throw new BadPath(`${JSON.stringify(path)} and ${JSON.stringify(twin.path)} differ only by case, which Windows and macOS cannot hold`);
		if (old) await bucket.copy(hostKey(w, path), trashKey(w, path, now));
		await bucket.put(hostKey(w, path), data);
		const iso = new Date(now).toISOString();
		const entry: ManifestEntry = { path, size: data.byteLength, mtime: iso, sha256, written_at: iso };
		const updated = next(manifest, [...manifest.files.filter((e) => e.path !== path), entry], now);
		if (await writeManifest(bucket, w, updated, etag)) return { host: w.hostId, path, sha256, seq: updated.seq };
		// 412: another write moved the manifest since our read; start over from a fresh one
	}
	throw new Busy("the web host's manifest kept changing; try again");
}

/** Removes `path` from the web host (moved to _trash/); null when the web host does not hold it. */
export async function deleteWebFile(bucket: WritableBucket, w: Where, path: string, clock: () => number): Promise<{ host: string; path: string; seq: number } | null> {
	checkWebPath(path);
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const now = clock();
		const { manifest, etag } = await readManifest(bucket, w);
		if (!manifest.files.some((e) => e.path === path)) return null;
		await bucket.copy(hostKey(w, path), trashKey(w, path, now));
		await bucket.delete(hostKey(w, path));
		const updated = next(manifest, manifest.files.filter((e) => e.path !== path), now);
		if (await writeManifest(bucket, w, updated, etag)) return { host: w.hostId, path, seq: updated.seq };
	}
	throw new Busy("the web host's manifest kept changing; try again");
}
