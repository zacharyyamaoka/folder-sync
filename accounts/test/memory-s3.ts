// An in-memory S3 endpoint for the Worker's unit tests: GET, HEAD, PUT (If-Match / If-None-Match honoured, as R2
// does), CopyObject, DELETE and ListObjectsV2, path style, and R2's temporary-credential scope (the session token's
// claims: bucket, scope, paths.prefixPaths) enforced on every key, listing prefix and copy source, as R2 enforces it.
// Moved from vibetracks worker/test/memory-s3.ts and given the writes the web host makes. The signature itself is
// not checked here: folder-sync's e2e/r2standin does that in the end-to-end proof (test/proof.mjs). What this checks
// is the part the Worker decides: which prefix and scope it asked for.

import { createHash } from "node:crypto";

export class MemoryS3 {
	readonly objects = new Map<string, Uint8Array>();
	readonly calls: { method: string; key: string; prefix?: string; allowed: boolean; scoped: string[] | null; scope?: string }[] = [];
	/** Runs once before the next conditional PUT of `key` (a concurrent writer, for the 412 test). */
	beforeConditional: { key: string; run: () => void } | null = null;

	readonly endpoint: string;
	readonly bucket: string;

	constructor(endpoint: string, bucket: string) {
		this.endpoint = endpoint;
		this.bucket = bucket;
	}

	put(key: string, data: string | Uint8Array): void {
		this.objects.set(key, typeof data === "string" ? new TextEncoder().encode(data) : data);
	}

	text(key: string): string | null {
		const data = this.objects.get(key);
		return data ? new TextDecoder().decode(data) : null;
	}

	private claims(request: Request): Record<string, any> | null {
		const token = request.headers.get("X-Amz-Security-Token");
		if (!token) return null;
		const jwt = Buffer.from(token, "base64").toString("utf8").replace(/^jwt\//, "");
		return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
	}

	private inScope(claims: Record<string, any> | null, key: string): boolean {
		if (!claims) return false; // only temporary credentials ever reach this endpoint in these tests
		const prefixes: string[] | undefined = claims.paths?.prefixPaths;
		if (!prefixes) return true;
		return prefixes.some((p) => p && key.startsWith(p));
	}

	private etag(data: Uint8Array): string {
		return `"${createHash("md5").update(data).digest("hex")}"`;
	}

	readonly fetch = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		if (`${url.origin}` !== this.endpoint) return new Response("wrong endpoint", { status: 400 });
		const path = decodeURIComponent(url.pathname.slice(1));
		const [bucket, ...rest] = path.split("/");
		const key = rest.join("/");
		const claims = this.claims(request);
		const scoped: string[] | null = claims?.paths?.prefixPaths ?? null;
		const scope: string | undefined = claims?.scope;
		const deny = (what: string) => {
			this.calls.push({ method: request.method, key: what, allowed: false, scoped, scope });
			return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
		};
		if (!claims || bucket !== this.bucket || claims.bucket !== this.bucket) return deny(key);
		if (!key && url.searchParams.get("list-type") === "2") {
			const prefix = url.searchParams.get("prefix") || "";
			if (!this.inScope(claims, prefix) || !prefix) return deny(`LIST ${prefix}`);
			this.calls.push({ method: "LIST", key: "", prefix, allowed: true, scoped, scope });
			const delimiter = url.searchParams.get("delimiter") || "";
			const common = new Set<string>();
			const contents: string[] = [];
			for (const name of [...this.objects.keys()].sort()) {
				if (!name.startsWith(prefix)) continue;
				const after = name.slice(prefix.length);
				const cut = delimiter ? after.indexOf(delimiter) : -1;
				if (cut >= 0) common.add(prefix + after.slice(0, cut + 1));
				else contents.push(name);
			}
			const xml = `<ListBucketResult><IsTruncated>false</IsTruncated>${contents.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}${[...common].sort().map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join("")}</ListBucketResult>`;
			return new Response(xml, { status: 200, headers: { "Content-Type": "application/xml" } });
		}
		if (!this.inScope(claims, key)) return deny(key);
		const writes = request.method === "PUT" || request.method === "DELETE";
		if (writes && scope !== "object-read-write") return deny(key);
		const source = request.headers.get("x-amz-copy-source");
		let from: string | null = null;
		if (source) {
			from = decodeURIComponent(source).replace(/^\//, "").split("/").slice(1).join("/");
			if (!this.inScope(claims, from)) return deny(`COPY ${from}`);
		}
		this.calls.push({ method: source ? "COPY" : request.method, key, allowed: true, scoped, scope });
		if (request.method === "PUT" && from !== null) {
			const data = this.objects.get(from);
			if (!data) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
			this.objects.set(key, data);
			return new Response(`<CopyObjectResult><ETag>${this.etag(data)}</ETag></CopyObjectResult>`, { status: 200 });
		}
		if (request.method === "PUT") {
			const ifMatch = request.headers.get("If-Match");
			const ifNoneMatch = request.headers.get("If-None-Match");
			if ((ifMatch || ifNoneMatch) && this.beforeConditional?.key === key) {
				const hook = this.beforeConditional;
				this.beforeConditional = null;
				hook.run();
			}
			const current = this.objects.get(key);
			if (ifMatch && (!current || this.etag(current) !== ifMatch)) return new Response("<Error><Code>PreconditionFailed</Code></Error>", { status: 412 });
			if (ifNoneMatch === "*" && current) return new Response("<Error><Code>PreconditionFailed</Code></Error>", { status: 412 });
			const data = new Uint8Array(await request.arrayBuffer());
			this.objects.set(key, data);
			return new Response(null, { status: 200, headers: { ETag: this.etag(data) } });
		}
		if (request.method === "DELETE") {
			this.objects.delete(key);
			return new Response(null, { status: 204 });
		}
		if (request.method !== "GET" && request.method !== "HEAD") return new Response("no", { status: 405 });
		const data = this.objects.get(key);
		if (!data) return new Response("", { status: 404 });
		const etag = this.etag(data);
		if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
		return new Response(request.method === "HEAD" ? null : data, { status: 200, headers: { ETag: etag, "Content-Length": String(data.length) } });
	};
}
