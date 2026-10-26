// List and read a folder-sync project from a Cloudflare Worker's R2 binding, using
// only manifests and GETs: the reference reader for docs/CONTRACT.md.
//
//   import { Project } from "./folder-sync-read.ts";
//   const project = new Project(env.BUCKET, "demo");            // folder-sync v0: keys start at the project
//   const mine = new Project(env.BUCKET, "demo", "users/AbC123/"); // an account root: every key starts with it
//   const files = await project.files();
//   const bytes = await project.read(files[0].hostId, files[0].path);
//
// It needs nothing but the binding (no S3 keys in the Worker), and it is written
// with erasable TypeScript only, so Node runs the tests without a build step.

export const SCHEMA = "folder-sync-manifest/1";
const ROOT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The subset of Cloudflare's R2Bucket binding this reader uses.
export interface R2ObjectLike {
	key: string;
	etag: string;
	size: number;
}
export interface R2ObjectBodyLike extends R2ObjectLike {
	arrayBuffer(): Promise<ArrayBuffer>;
}
export interface R2ListResultLike {
	delimitedPrefixes: string[];
	truncated: boolean;
	cursor?: string;
}
export interface R2BucketLike {
	get(
		key: string,
		options?: { onlyIf?: { etagDoesNotMatch?: string } },
	): Promise<R2ObjectBodyLike | R2ObjectLike | null>;
	list(options: { prefix: string; delimiter: string; cursor?: string }): Promise<R2ListResultLike>;
}

export interface ManifestEntry {
	path: string;
	size: number;
	mtime: string;
	sha256: string;
	written_at: string;
}

export interface Manifest {
	schema: string;
	project: string;
	host_id: string;
	host_name: string;
	seq: number;
	generated_at: string;
	files: ManifestEntry[];
}

export interface FileRef extends ManifestEntry {
	project: string;
	hostId: string;
	hostName: string;
	key: string;
}

export class ContractError extends Error {}

function hasBody(object: R2ObjectBodyLike | R2ObjectLike): object is R2ObjectBodyLike {
	return typeof (object as R2ObjectBodyLike).arrayBuffer === "function";
}

/** An account root is "" or one to eight slash-ended segments, like "users/AbC123/" (docs/CONTRACT.md). */
export function checkRoot(root: string): void {
	if (root === "") return;
	const segments = root.split("/");
	const last = segments.pop();
	if (last !== "" || segments.length < 1 || segments.length > 8 || !segments.every((s) => ROOT_SEGMENT.test(s))) {
		throw new ContractError(`bad account root ${JSON.stringify(root)}`);
	}
}

export function checkPath(path: string): void {
	if (
		!path ||
		path.startsWith("/") ||
		path.includes("\\") ||
		/^[A-Za-z]:/.test(path) ||
		path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
	) {
		throw new ContractError(`unsafe manifest path ${JSON.stringify(path)}`);
	}
}

export function validateManifest(manifest: Manifest, project: string, hostId: string): Manifest {
	if (manifest.schema !== SCHEMA) {
		throw new ContractError(`manifest schema ${JSON.stringify(manifest.schema)}, this reader knows ${SCHEMA}`);
	}
	if (manifest.project !== project || manifest.host_id !== hostId) {
		throw new ContractError(`manifest under hosts/${hostId} claims ${manifest.project}/${manifest.host_id}`);
	}
	const seen = new Set<string>();
	for (const entry of manifest.files ?? []) {
		checkPath(entry.path);
		if (seen.has(entry.path)) throw new ContractError(`manifest lists ${entry.path} twice`);
		seen.add(entry.path);
		if (!/^[0-9a-f]{64}$/.test(entry.sha256) || entry.size < 0) {
			throw new ContractError(`bad entry ${entry.path}`);
		}
	}
	return manifest;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** One project's view: the union of every host's manifest. */
export class Project {
	readonly bucket: R2BucketLike;
	readonly project: string;
	readonly root: string;
	private manifests = new Map<string, { etag: string; manifest: Manifest }>();
	private hostIds: string[] | null = null;

	/** root: the account root every key starts with ("" = folder-sync v0, unchanged). */
	constructor(bucket: R2BucketLike, project: string, root = "") {
		checkRoot(root);
		this.bucket = bucket;
		this.project = project;
		this.root = root;
	}

	/** Host ids, from one delimiter listing of <root><project>/hosts/ (cached). */
	async hosts(refresh = false): Promise<string[]> {
		if (this.hostIds && !refresh) return this.hostIds;
		const prefix = `${this.root}${this.project}/hosts/`;
		const found: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.bucket.list({ prefix, delimiter: "/", cursor });
			for (const p of page.delimitedPrefixes) found.push(p.slice(prefix.length).replace(/\/$/, ""));
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
		this.hostIds = found.filter((id) => HOST_ID.test(id)).sort();
		return this.hostIds;
	}

	/** The host's manifest, re-fetched only when its ETag changed (a conditional GET). */
	async manifest(hostId: string): Promise<Manifest | null> {
		const cached = this.manifests.get(hostId);
		const object = await this.bucket.get(
			`${this.root}${this.project}/hosts/${hostId}/manifest.json`,
			cached ? { onlyIf: { etagDoesNotMatch: cached.etag } } : undefined,
		);
		if (object === null) {
			this.manifests.delete(hostId);
			return null;
		}
		if (!hasBody(object)) {
			if (cached) return cached.manifest; // 304: unchanged
			throw new ContractError(`no body for ${object.key}`);
		}
		const text = new TextDecoder().decode(await object.arrayBuffer());
		const manifest = validateManifest(JSON.parse(text) as Manifest, this.project, hostId);
		this.manifests.set(hostId, { etag: object.etag, manifest });
		return manifest;
	}

	async files(): Promise<FileRef[]> {
		const refs: FileRef[] = [];
		for (const hostId of await this.hosts()) {
			const manifest = await this.manifest(hostId);
			if (!manifest) continue;
			for (const entry of manifest.files) {
				refs.push({
					...entry,
					project: this.project,
					hostId,
					hostName: manifest.host_name,
					key: `${this.root}${this.project}/hosts/${hostId}/${entry.path}`,
				});
			}
		}
		return refs.sort((a, b) => (a.hostId + "\0" + a.path < b.hostId + "\0" + b.path ? -1 : 1));
	}

	/** A file's bytes. On a race with the writer (missing or sha mismatch), re-read the manifest once. */
	async read(hostId: string, path: string, verify = true): Promise<ArrayBuffer> {
		checkPath(path);
		for (let attempt = 0; attempt < 2; attempt++) {
			const manifest = await this.manifest(hostId);
			const entry = manifest?.files.find((e) => e.path === path);
			if (!entry) throw new ContractError(`${hostId}/${path} is not in the manifest (deleted, or never published)`);
			const object = await this.bucket.get(`${this.root}${this.project}/hosts/${hostId}/${path}`);
			if (object && hasBody(object)) {
				const data = await object.arrayBuffer();
				if (!verify || (await sha256Hex(data)) === entry.sha256) return data;
			}
			this.manifests.delete(hostId); // the writer moved on; take its next manifest
		}
		throw new ContractError(`${hostId}/${path} kept changing while it was read`);
	}
}
