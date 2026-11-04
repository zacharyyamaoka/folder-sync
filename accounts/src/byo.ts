// Bring your own tokens (PEP 0003 §3.11): a person attaches an S3-compatible bucket of their own on the account page, and the
// device flow then hands THEIR machines credentials for that store instead of R2-scoped ones.
//
//   GET    /fs/v1/byo      { owner, attached, endpoint, bucket, prefix, region, store, keyHint, updated }  (never the secret)
//   PUT    /fs/v1/byo      { endpoint, bucket, prefix?, region?, accessKeyId, secretAccessKey }: tries the bucket, then keeps it
//   DELETE /fs/v1/byo      forgets it; machines get the service's keys again at their next refresh
//   POST   /fs/account/byo | /fs/account/byo/remove   the account page's forms (devices.ts), the same two writes
//
// The store is described the way lane/storage-backends does, as a URL string (s3://bucket/prefix) with the endpoint apart
// (`storeUrl`); the credential answer carries it as `Store` beside the fields the core already reads (Endpoint, Bucket,
// Prefix, Region, Provider), so a core that knows only those still works.
//
// WHY these rules (Zach: "bring your own tokens"; the review questions a person's own keys raise):
// - the secret is sealed with AES-GCM (Web Crypto), a key derived (HKDF-SHA256) from the Worker secret BYO_ENCRYPTION_KEY, and
//   the row is bound to its owner as additional data, so a sealed value copied into another person's row opens for nobody;
//   it is never logged, never answered, and the Worker refuses to store one without that key (503), never unsealed;
// - only a signed-in BROWSER attaches or removes a bucket: a stolen laptop's bearer must not be able to point the person's
//   other machines at someone else's bucket; the same goes for reading the setting back;
// - the bucket is tried first (one ListObjectsV2 signed with the keys given), so a typo is met here, not by a machine later;
// - a machine that cannot be given the person's bucket (the row will not open) gets NOTHING (503 byo_unreadable), never the
//   service's storage unasked: a person's files would otherwise land somewhere they did not choose;
// - these are long-lived keys, handed as they are: the core re-asks every SYNC_CREDENTIAL_TTL_S, so a removal or a rotation
//   reaches a machine within that, but revoking a device cannot revoke a key the device already holds. The page says so.

import type { App } from "./apps.ts";
import { fail, json, session, stillSignedIn, writer, type Deps, type Env, type Person } from "./app.ts";
import { ttlOf } from "./creds.ts";
import { Denied, S3Bucket } from "./s3-bucket.ts";
import type { ByoRow } from "./store.ts";

export interface ByoEnv {
	/** The Worker secret the sealing key is derived from: at least 32 characters. */
	BYO_ENCRYPTION_KEY?: string;
}

/** What a person gives (and parseByo returns, cleaned). */
export interface ByoInput {
	endpoint: string;
	bucket: string;
	prefix: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const KEY_MIN = 32;
const VERSION = "v1";

function b64(bytes: Uint8Array): string {
	let text = "";
	for (const byte of bytes) text += String.fromCharCode(byte);
	return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64(text: string): Uint8Array {
	const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
	return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function aesKey(secret: string): Promise<CryptoKey> {
	if (!secret || secret.length < KEY_MIN) throw new Error(`BYO_ENCRYPTION_KEY must be a Worker secret of at least ${KEY_MIN} characters`);
	const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
	return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("folder-sync byo v1"), info: enc.encode("aes-256-gcm") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** `plaintext` sealed for `owner`: "v1.<iv>.<ciphertext+tag>", base64url. A fresh random IV every time. */
export async function sealSecret(secret: string, owner: string, plaintext: string): Promise<string> {
	const key = await aesKey(secret);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	// WHY the owner as additional data: the tag then fails for any other owner's row
	const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(`byo/${VERSION}/${owner}`) }, key, enc.encode(plaintext)));
	return `${VERSION}.${b64(iv)}.${b64(sealed)}`;
}

/** The text `sealSecret` sealed for `owner`; throws for another key, another owner, a changed byte or an unknown version. */
export async function openSecret(secret: string, owner: string, sealed: string): Promise<string> {
	const parts = sealed.split(".");
	if (parts.length !== 3 || parts[0] !== VERSION) throw new Error("not a sealed value this Worker knows");
	const key = await aesKey(secret);
	const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(parts[1]), additionalData: enc.encode(`byo/${VERSION}/${owner}`) }, key, unb64(parts[2]));
	return dec.decode(opened);
}

// ------------------------------------------------------------------------------------------------ the rules

/** Every reason a bucket is refused, in a person's words (also what the account page's notice says). */
export const BYO_ERRORS: Record<string, string> = {
	bad_endpoint: "The endpoint is the storage service's address, like https://s3.us-west-002.backblazeb2.com: https, a host name (no IP address), no path.",
	bad_bucket: "The bucket name is 3 to 63 lower-case letters, digits, dots or dashes.",
	bad_prefix: "The folder prefix is a relative path like folder-sync (no leading slash, no '..', no empty parts), or empty for the whole bucket.",
	bad_region: "The region is a short lower-case name like us-west-002, or auto.",
	bad_keys: "The access key id and the secret are the two strings your storage service gave you (no spaces; the secret is 8 to 256 characters).",
	byo_denied: "The storage service refused those keys for that bucket. Check them and try again.",
	byo_unreachable: "That bucket could not be reached at that endpoint. Check the endpoint and bucket name, and that the bucket exists.",
	not_configured: "This app can't keep storage keys yet: the operator has to set BYO_ENCRYPTION_KEY.",
};

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{1,32}$/;
const KEY_ID = /^[A-Za-z0-9_\-./+=]{4,128}$/;
const SECRET_KEY = /^[\x21-\x7e]{8,256}$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function refused(error: keyof typeof BYO_ERRORS): { error: string; why: string } {
	return { error, why: BYO_ERRORS[error] };
}

/** A person's bucket as given, checked and cleaned; or why not. `dev` also takes plain http on loopback (the local proof's store).
 *  WHY no IP literals or localhost in production: the Worker will fetch this address, so it must name a public service host. */
export function parseByo(input: unknown, dev: boolean): { value: ByoInput } | { error: string; why: string } {
	const raw = (input ?? {}) as Record<string, unknown>;
	let url: URL;
	try {
		url = new URL(String(raw.endpoint ?? ""));
	} catch {
		return refused("bad_endpoint");
	}
	const host = url.hostname.toLowerCase();
	const loopback = host === "127.0.0.1" || host === "localhost";
	const named = !host.includes(":") && !IPV4.test(host) && host !== "localhost" && !host.endsWith(".localhost") && host.includes(".");
	const schemeOk = url.protocol === "https:" ? named || (dev && loopback) : dev && url.protocol === "http:" && loopback;
	if (!schemeOk || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return refused("bad_endpoint");
	const bucket = raw.bucket;
	if (typeof bucket !== "string" || !BUCKET.test(bucket) || bucket.includes("..")) return refused("bad_bucket");
	let prefix = raw.prefix === undefined || raw.prefix === null ? "" : raw.prefix;
	if (typeof prefix !== "string" || prefix.length > 200 || prefix.includes("\\") || /[\u0000-\u001f\u007f]/.test(prefix)) return refused("bad_prefix");
	if (prefix !== "") {
		const parts = prefix.replace(/\/$/, "").split("/");
		if (prefix.startsWith("/") || parts.some((part) => part === "" || part === "." || part === "..")) return refused("bad_prefix");
		prefix = `${parts.join("/")}/`;
	}
	const region = raw.region === undefined || raw.region === null || raw.region === "" ? "auto" : raw.region;
	if (typeof region !== "string" || !REGION.test(region)) return refused("bad_region");
	const { accessKeyId, secretAccessKey } = raw;
	if (typeof accessKeyId !== "string" || !KEY_ID.test(accessKeyId) || typeof secretAccessKey !== "string" || !SECRET_KEY.test(secretAccessKey)) return refused("bad_keys");
	return { value: { endpoint: `${url.protocol}//${url.host}`, bucket, prefix, region, accessKeyId, secretAccessKey } };
}

/** The store as one string, the endpoint apart: s3://<bucket>/<prefix> (lane/storage-backends' URL form). */
export function storeUrl(store: { bucket: string; prefix: string }): string {
	return `s3://${store.bucket}/${store.prefix}`;
}

// ------------------------------------------------------------------------------------------------ attaching

const TRY_MS = 8000;

/** Tries the bucket with the person's own keys: one ListObjectsV2 for a single key under their prefix. */
async function tryBucket(deps: Deps, input: ByoInput): Promise<{ error: string; why: string } | null> {
	const bucket = new S3Bucket({ AccessKeyId: input.accessKeyId, SecretAccessKey: input.secretAccessKey, Endpoint: input.endpoint, Bucket: input.bucket, Region: input.region }, deps.s3);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([bucket.objects(input.prefix, { max: 1 }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), TRY_MS); })]);
		return null;
	} catch (error) {
		// WHY nothing of the error is passed on: it can carry the endpoint's own words, and the answer never carries a key
		return refused(error instanceof Denied ? "byo_denied" : "byo_unreachable");
	} finally {
		clearTimeout(timer);
	}
}

export type Attached = { row: ByoRow } | { status: number; error: string; why: string };

/** Tries and keeps a person's bucket. WHY the order: 503 before anything is read or sent, then the rules, then the bucket. */
export async function attach(env: Env, deps: Deps, owner: string, given: unknown): Promise<Attached> {
	if (!deps.store.setByo) return { status: 503, ...refused("not_configured") };
	const secret = env.BYO_ENCRYPTION_KEY;
	if (!secret || secret.length < KEY_MIN) return { status: 503, ...refused("not_configured") };
	const parsed = parseByo(given, env.ENVIRONMENT === "dev");
	if ("error" in parsed) return { status: 400, ...parsed };
	const bad = await tryBucket(deps, parsed.value);
	if (bad) return { status: 400, ...bad };
	const now = new Date(deps.now()).toISOString();
	const before = await deps.store.byo?.(owner);
	const row: ByoRow = {
		owner_id: owner,
		endpoint: parsed.value.endpoint,
		bucket: parsed.value.bucket,
		prefix: parsed.value.prefix,
		region: parsed.value.region,
		key_hint: parsed.value.accessKeyId.slice(-4),
		sealed: await sealSecret(secret, owner, JSON.stringify({ id: parsed.value.accessKeyId, secret: parsed.value.secretAccessKey })),
		created_at: before?.created_at ?? now,
		updated_at: now,
	};
	await deps.store.setByo(row);
	return { row };
}

/** A row as a page or the API shows it: everything but the secret. */
export function shown(owner: string, row: ByoRow | null): Record<string, unknown> {
	if (!row) return { owner, attached: false };
	return { owner, attached: true, endpoint: row.endpoint, bucket: row.bucket, prefix: row.prefix, region: row.region, store: storeUrl(row), keyHint: row.key_hint, updated: row.updated_at };
}

// ------------------------------------------------------------------------------------------------ the device handoff

/** The keys a machine of `person` is handed when they attached a bucket: theirs, as the core's credential-process shape plus
 *  `Store`; null when they attached none. A row that will not open is an error answer, never null (see the header). */
export async function handoff(env: Env, deps: Deps, person: Person): Promise<Response | null> {
	const row = await deps.store.byo?.(person.userId);
	if (!row) return null;
	// WHY the clock started before the read, as credentials() does for the service's keys: the session was alive when asked
	const authorizedAt = deps.now();
	if (!(await stillSignedIn(deps, person, authorizedAt))) return fail(401, "signed_out", "this machine is signed out (signed out or revoked): run folder-sync login");
	let keys: { id: string; secret: string };
	try {
		keys = JSON.parse(await openSecret(env.BYO_ENCRYPTION_KEY ?? "", person.userId, row.sealed));
		if (typeof keys.id !== "string" || typeof keys.secret !== "string") throw new Error("shape");
	} catch {
		return fail(503, "byo_unreadable", "your own bucket's keys can't be read on this server: attach them again on the account page");
	}
	return json(200, {
		Version: 1,
		AccessKeyId: keys.id,
		SecretAccessKey: keys.secret,
		Expiration: new Date(authorizedAt + ttlOf(env) * 1000).toISOString(),
		Endpoint: row.endpoint,
		Bucket: row.bucket,
		Prefix: row.prefix,
		Region: row.region,
		Provider: "Other",
		Store: storeUrl(row),
	});
}

// ------------------------------------------------------------------------------------------------ /fs/v1/byo

/** The signed-in browser's session, or the answer refusing it (401 signed out, 403 for a machine's bearer). */
async function browserOnly(request: Request, deps: Deps, app: App | null): Promise<{ person: Person } | Response> {
	const who = await session(request, deps, app);
	if (!who) return fail(401, "signed_out", "sign in first");
	if (who.via !== "cookie") return fail(403, "browser_only", "your own bucket is set from your browser, signed in: a machine can't change where your machines sync");
	return { person: who.person };
}

export async function byoRoute(request: Request, env: Env, deps: Deps, app: App | null, rest: string[], method: string): Promise<Response> {
	if (rest.length) return fail(404, "not_found", "no such route");
	const read = method === "GET" || method === "HEAD";
	if (read) {
		const who = await browserOnly(request, deps, app);
		if (who instanceof Response) return who;
		if (!deps.store.byo) return fail(503, "not_configured", "this server keeps no storage keys");
		return json(200, shown(who.person.userId, await deps.store.byo(who.person.userId)));
	}
	if (method !== "PUT" && method !== "DELETE") return fail(405, "method", "GET, PUT or DELETE", { Allow: "GET, HEAD, PUT, DELETE" });
	const first = await browserOnly(request, deps, app);
	if (first instanceof Response) return first;
	const who = await writer(request, deps, app);
	if (who instanceof Response) return who;
	const owner = who.person.userId;
	if (method === "DELETE") {
		await deps.store.removeByo?.(owner);
		return json(200, shown(owner, null));
	}
	if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) return fail(415, "json_only", "send Content-Type: application/json");
	if (Number(request.headers.get("Content-Length") || 0) > 8192) return fail(413, "too_large", "a bucket is a few short fields");
	let body: unknown;
	try {
		body = JSON.parse(await request.text());
	} catch {
		return fail(400, "bad_request", "the body is not JSON");
	}
	const done = await attach(env, deps, owner, body);
	if ("row" in done) return json(200, shown(owner, done.row));
	return fail(done.status, done.error, done.why);
}
