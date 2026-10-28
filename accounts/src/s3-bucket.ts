// folder-sync's reader (readers/worker/src/folder-sync-read.ts) over the S3 API, plus the four writes the web host
// makes (§3.4: PUT, a conditional manifest PUT, CopyObject into _trash/, DELETE), each signed with ONE temporary
// credential (creds.ts). Moved from vibetracks worker/src/s3-bucket.ts. WHY the S3 API and not an R2 binding: the
// Worker then binds no bucket at all, and every call it makes goes through a credential R2 itself scopes to one
// person's prefix, so a bug in a route can at worst touch the signed-in person's own files.
//
// Signing is aws4fetch (vendored, MIT), the stock SigV4 signer for Workers.

import { AwsClient } from "./vendor/aws4fetch.js";
import type { R2BucketLike, R2ListResultLike, R2ObjectBodyLike, R2ObjectLike } from "../../readers/worker/src/folder-sync-read.ts";
import type { Minted } from "./creds.ts";

/** R2 refused the request (403): the credential does not cover the key. Never shown to the person as anything but
 *  "not found". */
export class Denied extends Error {}

export type FetchLike = (request: Request) => Promise<Response>;

function decodeXml(text: string): string {
	return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (whole, name: string) => {
		const named: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
		if (named[name]) return named[name];
		const code = name.startsWith("#x") ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
		return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
	});
}

function tagValues(xml: string, tag: string): string[] {
	const out: string[] = [];
	const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
	for (let match = pattern.exec(xml); match; match = pattern.exec(xml)) out.push(decodeXml(match[1]));
	return out;
}

function etagOf(answer: Response): string {
	return (answer.headers.get("ETag") || "").replace(/^W\//, "").replace(/"/g, "");
}

export class S3Bucket implements R2BucketLike {
	private readonly client: AwsClient;
	private readonly base: string;
	private readonly bucket: string;
	private readonly send: FetchLike;
	readonly calls: string[] = [];

	constructor(creds: Pick<Minted, "AccessKeyId" | "SecretAccessKey" | "SessionToken" | "Endpoint" | "Bucket">, send: FetchLike) {
		this.client = new AwsClient({
			accessKeyId: creds.AccessKeyId,
			secretAccessKey: creds.SecretAccessKey,
			sessionToken: creds.SessionToken,
			service: "s3",
			region: "auto",
			retries: 0,
		});
		this.bucket = creds.Bucket;
		this.base = `${creds.Endpoint}/${encodeURIComponent(creds.Bucket)}`;
		this.send = send;
	}

	private encodeKey(key: string): string {
		return key.split("/").map(encodeURIComponent).join("/");
	}

	private url(key: string): string {
		return `${this.base}/${this.encodeKey(key)}`;
	}

	private async call(url: string, init: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {}): Promise<Response> {
		const signed = await this.client.sign(url, { method: init.method || "GET", headers: init.headers || {}, body: init.body });
		const answer = await this.send(signed);
		if (answer.status === 403) {
			await answer.body?.cancel();
			throw new Denied("the storage refused this credential");
		}
		return answer;
	}

	async get(key: string, options?: { onlyIf?: { etagDoesNotMatch?: string } }): Promise<R2ObjectBodyLike | R2ObjectLike | null> {
		this.calls.push(`GET ${key}`);
		const etag = options?.onlyIf?.etagDoesNotMatch;
		const answer = await this.call(this.url(key), { headers: etag ? { "If-None-Match": `"${etag}"` } : {} });
		if (answer.status === 404) {
			await answer.body?.cancel();
			return null;
		}
		const tag = etagOf(answer);
		if (answer.status === 304) return { key, etag: tag || etag || "", size: 0 };
		if (!answer.ok) {
			await answer.body?.cancel();
			throw new Error(`the storage answered ${answer.status} for a read`);
		}
		const data = await answer.arrayBuffer();
		return { key, etag: tag, size: data.byteLength, arrayBuffer: async () => data };
	}

	/** `length` bytes of `key` from `offset` (one ranged GET), streamed, never read whole: what a video's seek reads
	 *  (ranges.ts). `size` is the whole object's, as R2's ranged get answers it; null when there is no such object or
	 *  the range is past its end (it changed since its manifest was read). */
	async getRange(key: string, offset: number, length: number): Promise<{ key: string; etag: string; size: number; body: ReadableStream<Uint8Array> | null } | null> {
		this.calls.push(`GET ${key} bytes=${offset}-${offset + length - 1}`);
		const answer = await this.call(this.url(key), { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
		if (answer.status === 404 || answer.status === 416) {
			await answer.body?.cancel();
			return null;
		}
		if (answer.status === 200) {
			// a store that ignored the Range: the whole object came back, so take the asked-for slice of it
			const data = new Uint8Array(await answer.arrayBuffer());
			return { key, etag: etagOf(answer), size: data.byteLength, body: new Blob([data.slice(offset, offset + length)]).stream() };
		}
		if (answer.status !== 206) {
			await answer.body?.cancel();
			throw new Error(`the storage answered ${answer.status} for a ranged read`);
		}
		const total = /\/(\d+)\s*$/.exec(answer.headers.get("Content-Range") || "");
		if (!total) {
			await answer.body?.cancel();
			throw new Error("the storage answered a ranged read without its size");
		}
		return { key, etag: etagOf(answer), size: Number(total[1]), body: answer.body };
	}

	async list(options: { prefix: string; delimiter: string; cursor?: string }): Promise<R2ListResultLike> {
		this.calls.push(`LIST ${options.prefix}`);
		const query = new URLSearchParams({ "list-type": "2", prefix: options.prefix, delimiter: options.delimiter });
		if (options.cursor) query.set("continuation-token", options.cursor);
		const answer = await this.call(`${this.base}?${query}`);
		if (!answer.ok) {
			await answer.body?.cancel();
			throw new Error(`the storage answered ${answer.status} for a listing`);
		}
		const xml = await answer.text();
		const prefixes = [...xml.matchAll(/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g)].flatMap((m) => tagValues(m[1], "Prefix"));
		const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
		const cursor = tagValues(xml, "NextContinuationToken")[0];
		return { delimitedPrefixes: prefixes, truncated, ...(truncated && cursor ? { cursor } : {}) };
	}

	/** Bytes and objects under `prefix` (ListObjectsV2, no delimiter, 1000 a page), counting stopped once either
	 *  passes `stop` (then the answer only says "over"): what a person's quota is measured with. */
	async measure(prefix: string, stop: { bytes: number; objects: number }): Promise<{ bytes: number; objects: number; complete: boolean }> {
		let bytes = 0;
		let objects = 0;
		let cursor: string | undefined;
		do {
			this.calls.push(`LIST ${prefix}`);
			const query = new URLSearchParams({ "list-type": "2", prefix, "max-keys": "1000" });
			if (cursor) query.set("continuation-token", cursor);
			const answer = await this.call(`${this.base}?${query}`);
			if (!answer.ok) {
				await answer.body?.cancel();
				throw new Error(`the storage answered ${answer.status} for a listing`);
			}
			const xml = await answer.text();
			for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
				objects += 1;
				bytes += Number(tagValues(match[1], "Size")[0] || 0);
			}
			const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
			cursor = truncated ? tagValues(xml, "NextContinuationToken")[0] : undefined;
		} while (cursor && bytes <= stop.bytes && objects <= stop.objects);
		// stopped with pages left: a lower bound (review r4 #5)
		return { bytes, objects, complete: !cursor };
	}

	/** An object's size and ETag (HEAD), or null when there is none. */
	async head(key: string): Promise<{ size: number; etag: string } | null> {
		this.calls.push(`HEAD ${key}`);
		const answer = await this.call(this.url(key), { method: "HEAD" });
		await answer.body?.cancel();
		if (answer.status === 404) return null;
		if (!answer.ok) throw new Error(`the storage answered ${answer.status} for a HEAD`);
		return { size: Number(answer.headers.get("Content-Length") || 0), etag: etagOf(answer) };
	}

	/** Up to `max` keys under `prefix` with their sizes (one ListObjectsV2 page), and whether there are more. */
	async keys(prefix: string, max = 1000): Promise<{ keys: { key: string; size: number }[]; more: boolean }> {
		this.calls.push(`LIST ${prefix}`);
		const query = new URLSearchParams({ "list-type": "2", prefix, "max-keys": String(max) });
		const answer = await this.call(`${this.base}?${query}`);
		if (!answer.ok) {
			await answer.body?.cancel();
			throw new Error(`the storage answered ${answer.status} for a listing`);
		}
		const xml = await answer.text();
		const keys = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => ({ key: tagValues(m[1], "Key")[0], size: Number(tagValues(m[1], "Size")[0] || 0) }));
		return { keys, more: /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml) };
	}

	/** PUT an object. `ifMatch` / `ifNoneMatch` make it conditional; a 412 comes back as `{ ok: false, status: 412 }`. */
	async put(key: string, body: Uint8Array, options: { ifMatch?: string; ifNoneMatch?: "*"; contentType?: string } = {}): Promise<{ ok: boolean; status: number; etag: string }> {
		this.calls.push(`PUT ${key}`);
		const headers: Record<string, string> = { "Content-Type": options.contentType || "application/octet-stream" };
		if (options.ifMatch) headers["If-Match"] = `"${options.ifMatch}"`;
		if (options.ifNoneMatch) headers["If-None-Match"] = options.ifNoneMatch;
		const answer = await this.call(this.url(key), { method: "PUT", headers, body });
		await answer.body?.cancel();
		if (answer.status === 412) return { ok: false, status: 412, etag: "" };
		if (!answer.ok) throw new Error(`the storage answered ${answer.status} for a write`);
		return { ok: true, status: answer.status, etag: etagOf(answer) };
	}

	/** CopyObject `from` to `to` in this bucket (the trash copy). False when `from` is gone. */
	async copy(from: string, to: string): Promise<boolean> {
		this.calls.push(`COPY ${from} -> ${to}`);
		const answer = await this.call(this.url(to), { method: "PUT", headers: { "x-amz-copy-source": `/${encodeURIComponent(this.bucket)}/${this.encodeKey(from)}` } });
		const text = await answer.text();
		if (answer.status === 404) return false;
		// WHY the body too: S3 may answer a failed copy with 200 and an <Error> document
		if (!answer.ok || /<Error>/.test(text)) throw new Error(`the storage answered ${answer.status} for a copy`);
		return true;
	}

	async delete(key: string): Promise<void> {
		this.calls.push(`DELETE ${key}`);
		const answer = await this.call(this.url(key), { method: "DELETE" });
		await answer.body?.cancel();
		if (!answer.ok && answer.status !== 404) throw new Error(`the storage answered ${answer.status} for a delete`);
	}
}
