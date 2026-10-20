// An R2-binding look-alike over a real S3 endpoint (SigV4 with WebCrypto), so the
// end-to-end test runs the Worker reader against the same stand-in bucket the
// folder-sync machines wrote. On Cloudflare the real binding replaces this file.
import type { R2BucketLike, R2ListResultLike, R2ObjectBodyLike, R2ObjectLike } from "../src/folder-sync-read.ts";

const encoder = new TextEncoder();
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function hex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
	const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

function encode(text: string, keepSlash = false): string {
	return [...encoder.encode(text)]
		.map((byte) => {
			const ch = String.fromCharCode(byte);
			if (/[A-Za-z0-9\-_.~]/.test(ch) || (keepSlash && ch === "/")) return ch;
			return "%" + byte.toString(16).toUpperCase().padStart(2, "0");
		})
		.join("");
}

export class S3Bucket implements R2BucketLike {
	readonly endpoint: string;
	readonly bucket: string;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly region: string;
	calls: string[] = [];

	constructor(endpoint: string, bucket: string, accessKeyId: string, secretAccessKey: string, region = "auto") {
		this.endpoint = endpoint.replace(/\/$/, "");
		this.bucket = bucket;
		this.accessKeyId = accessKeyId;
		this.secretAccessKey = secretAccessKey;
		this.region = region;
	}

	private async signedFetch(path: string, query: Record<string, string>, headers: Record<string, string>): Promise<Response> {
		const url = new URL(this.endpoint + path);
		const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
		const day = amzDate.slice(0, 8);
		const all: Record<string, string> = { ...headers, host: url.host, "x-amz-date": amzDate, "x-amz-content-sha256": EMPTY_SHA256 };
		const names = Object.keys(all).map((n) => n.toLowerCase()).sort();
		const lower: Record<string, string> = {};
		for (const [k, v] of Object.entries(all)) lower[k.toLowerCase()] = v.trim();
		const canonicalQuery = Object.keys(query)
			.sort()
			.map((k) => `${encode(k)}=${encode(query[k])}`)
			.join("&");
		const canonicalRequest = ["GET", path, canonicalQuery, names.map((n) => `${n}:${lower[n]}\n`).join(""), names.join(";"), EMPTY_SHA256].join("\n");
		const scope = `${day}/${this.region}/s3/aws4_request`;
		const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(await crypto.subtle.digest("SHA-256", encoder.encode(canonicalRequest)))].join("\n");
		let key: ArrayBuffer | Uint8Array = encoder.encode("AWS4" + this.secretAccessKey);
		for (const part of [day, this.region, "s3", "aws4_request"]) key = await hmac(key, part);
		const signature = hex(await hmac(key, stringToSign));
		const sent: Record<string, string> = {};
		for (const n of names) if (n !== "host") sent[n] = lower[n];
		sent.authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
		return fetch(url.origin + path + (canonicalQuery ? "?" + canonicalQuery : ""), { headers: sent });
	}

	async get(key: string, options?: { onlyIf?: { etagDoesNotMatch?: string } }): Promise<R2ObjectBodyLike | R2ObjectLike | null> {
		const headers: Record<string, string> = {};
		const want = options?.onlyIf?.etagDoesNotMatch;
		if (want) headers["if-none-match"] = `"${want}"`;
		this.calls.push(`GET ${key}${want ? " (conditional)" : ""}`);
		const response = await this.signedFetch(`/${encode(this.bucket)}/${encode(key, true)}`, {}, headers);
		if (response.status === 404) return null;
		const etag = (response.headers.get("etag") ?? "").replace(/"/g, "");
		if (response.status === 304) return { key, etag: want ?? etag, size: 0 };
		if (response.status !== 200) throw new Error(`GET ${key}: HTTP ${response.status}`);
		const data = await response.arrayBuffer();
		return { key, etag, size: data.byteLength, arrayBuffer: async () => data };
	}

	async list(options: { prefix: string; delimiter: string; cursor?: string }): Promise<R2ListResultLike> {
		this.calls.push(`LIST ${options.prefix}`);
		const query: Record<string, string> = { "list-type": "2", prefix: options.prefix, delimiter: options.delimiter };
		if (options.cursor) query["continuation-token"] = options.cursor;
		const response = await this.signedFetch(`/${encode(this.bucket)}`, query, {});
		if (response.status !== 200) throw new Error(`LIST ${options.prefix}: HTTP ${response.status}`);
		const xml = await response.text();
		const prefixes = [...xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]*)<\/Prefix>/g)].map((m) => m[1]);
		const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
		const cursor = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/)?.[1];
		return { delimitedPrefixes: prefixes, truncated, cursor };
	}
}
