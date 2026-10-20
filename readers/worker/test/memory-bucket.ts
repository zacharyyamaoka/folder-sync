// An in-memory stand-in for an R2 binding that honours onlyIf.etagDoesNotMatch and counts calls.
import type { R2BucketLike, R2ListResultLike, R2ObjectBodyLike, R2ObjectLike } from "../src/folder-sync-read.ts";

export class MemoryBucket implements R2BucketLike {
	objects = new Map<string, Uint8Array>();
	calls: string[] = [];

	put(key: string, data: string | Uint8Array): void {
		this.objects.set(key, typeof data === "string" ? new TextEncoder().encode(data) : data);
	}

	async get(key: string, options?: { onlyIf?: { etagDoesNotMatch?: string } }): Promise<R2ObjectBodyLike | R2ObjectLike | null> {
		this.calls.push(`GET ${key}${options?.onlyIf ? " (conditional)" : ""}`);
		const data = this.objects.get(key);
		if (!data) return null;
		const digest = await crypto.subtle.digest("SHA-1", data);
		const etag = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
		if (options?.onlyIf?.etagDoesNotMatch === etag) return { key, etag, size: data.length };
		return { key, etag, size: data.length, arrayBuffer: async () => data.slice().buffer };
	}

	async list(options: { prefix: string; delimiter: string }): Promise<R2ListResultLike> {
		this.calls.push(`LIST ${options.prefix}`);
		const prefixes = new Set<string>();
		for (const key of this.objects.keys()) {
			if (!key.startsWith(options.prefix)) continue;
			const rest = key.slice(options.prefix.length);
			const cut = rest.indexOf(options.delimiter);
			if (cut >= 0) prefixes.add(options.prefix + rest.slice(0, cut + 1));
		}
		return { delimitedPrefixes: [...prefixes].sort(), truncated: false };
	}
}
