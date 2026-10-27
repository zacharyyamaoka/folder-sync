// Short-lived R2 credentials for ONE prefix (PEP 0003 §3.1, moved from vibetracks worker/src/creds.ts): the
// boundary between two people.
//
// R2's locally signed temporary credentials, as Cloudflare documents them
// (developers.cloudflare.com/r2/api/s3/temporary-credentials/ and r2/examples/authenticate-r2-temp-credentials/):
// a JWT signed HS256 with the parent key's secret, claims {bucket, scope | actions, paths {prefixPaths,
// objectPaths}, sub: the account id, iss: the parent access key id, aud: the endpoint's host, iat, exp}; the
// temporary secret is the hex SHA-256 of the JWT; the session token is base64("jwt/" + JWT); the access key id
// is the parent's. R2 then checks every request against those claims itself.
//
// WHY local signing and not the Temporary Credentials API: it needs no Cloudflare API token (only the parent R2
// key, which the Worker must hold either way), no round trip per mint, and it is the one documented way to
// scope by action. WHY WebCrypto and not jose: the same three primitives (HMAC-SHA256, SHA-256, base64url), and
// the unit tests then run with no npm modules; the independent check is folder-sync's e2e/r2standin, which
// verifies what this file signs from its own reading of the same page.

export type Scope = "object-read-write" | "object-read-only";

export interface CredsEnv {
	R2_ACCOUNT_ID?: string;
	R2_PARENT_ACCESS_KEY_ID?: string;
	R2_PARENT_SECRET_ACCESS_KEY?: string;
	SYNC_BUCKET?: string;
	/** The S3 endpoint; default https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com (a local stand-in in the proof). */
	R2_ENDPOINT?: string;
	SYNC_CREDENTIAL_TTL_S?: string;
}

/** What `folder-sync credentials` prints (AWS credential_process plus Endpoint, Bucket, Prefix: PEP 0002). */
export interface Minted {
	Version: 1;
	AccessKeyId: string;
	SecretAccessKey: string;
	SessionToken: string;
	Expiration: string;
	Endpoint: string;
	Bucket: string;
	Prefix: string;
	Region: "auto";
	Provider: "Cloudflare";
}

export class NotConfigured extends Error {}

/** Better Auth's generated ids are 32 letters and digits; anything else never names a prefix. */
export const USER_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** docs/CONTRACT.md's project name. */
export const PROJECT = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const ONE_ROOT = /^users\/[A-Za-z0-9_-]{8,64}\/$/;
const ONE_FOLDER = /^users\/[A-Za-z0-9_-]{8,64}\/[a-z0-9][a-z0-9._-]{0,62}\/$/;

/** The one prefix a person's machines may touch: users/<their id>/. */
export function userRoot(userId: string): string {
	if (!USER_ID.test(userId)) throw new Error("this account's id cannot name a storage prefix");
	// WHY the trailing slash (fs-mutation: the root's trailing slash): R2 matches prefixPaths as plain string
	// prefixes, so without it the prefix users/abc would also cover users/abcd/, another person's.
	return `users/${userId}/`;
}

/** One person's one folder: users/<id>/<project>/, what a page's read is signed for (a public folder's too). */
export function folderPrefix(userId: string, project: string): string {
	if (!PROJECT.test(project)) throw new Error("not a project name");
	return `${userRoot(userId)}${project}/`;
}

export function endpointOf(env: CredsEnv): string {
	if (env.R2_ENDPOINT) return env.R2_ENDPOINT.replace(/\/+$/, "");
	if (!env.R2_ACCOUNT_ID) throw new NotConfigured("R2_ACCOUNT_ID is not set");
	return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
}

/** The lifetime of a sync credential: SYNC_CREDENTIAL_TTL_S, 300 s by default, kept between 30 s and one hour. */
export function ttlOf(env: CredsEnv): number {
	const asked = Number(env.SYNC_CREDENTIAL_TTL_S || 300);
	// WHY at most an hour: a revoked machine (or one over its quota, quota.ts) keeps the credential it holds until it
	// expires, so the lifetime is how long a revocation takes. WHY 5 minutes by default (it was 15): it also bounds how
	// far past the quota one person can upload (review r1 #7), at a refresh every ~3 minutes, ~20 Worker calls an hour
	return Math.min(3600, Math.max(30, Number.isFinite(asked) ? Math.floor(asked) : 300));
}

const enc = new TextEncoder();

function base64url(bytes: Uint8Array): string {
	let text = "";
	for (const byte of bytes) text += String.fromCharCode(byte);
	return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Signs a credential for exactly `prefix` (one person's root, or one of their folders), `scope`, `ttlSeconds`
 *  from `now` (ms). */
export async function mint(env: CredsEnv, prefix: string, scope: Scope, ttlSeconds: number, now: number): Promise<Minted> {
	const parentId = env.R2_PARENT_ACCESS_KEY_ID;
	const parentSecret = env.R2_PARENT_SECRET_ACCESS_KEY;
	const bucket = env.SYNC_BUCKET;
	if (!parentId || !parentSecret || !bucket || !env.R2_ACCOUNT_ID) throw new NotConfigured("the sync store is not set up on this Worker");
	// WHY again here: whatever a caller computed, a credential is only ever minted for one person's root or folder
	if (!ONE_ROOT.test(prefix) && !ONE_FOLDER.test(prefix)) throw new Error("a credential is only ever minted for one person's root or folder");
	const endpoint = endpointOf(env);
	const iat = Math.floor(now / 1000);
	const exp = iat + ttlSeconds;
	const claims = {
		bucket,
		scope,
		// fs-mutation: the prefix scope. WHY: this one line is what keeps one person's machines out of everyone
		// else's files; R2 refuses any key, list or copy source outside it.
		paths: { prefixPaths: [prefix], objectPaths: [] as string[] },
		sub: env.R2_ACCOUNT_ID,
		iss: parentId,
		aud: new URL(endpoint).host,
		iat,
		exp,
	};
	const header = base64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
	const payload = base64url(enc.encode(JSON.stringify(claims)));
	const key = await crypto.subtle.importKey("raw", enc.encode(parentSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${header}.${payload}`)));
	const jwt = `${header}.${payload}.${base64url(signature)}`;
	return {
		Version: 1,
		AccessKeyId: parentId,
		SecretAccessKey: hex(await crypto.subtle.digest("SHA-256", enc.encode(jwt))),
		SessionToken: btoa(`jwt/${jwt}`),
		Expiration: new Date(exp * 1000).toISOString(),
		Endpoint: endpoint,
		Bucket: bucket,
		Prefix: prefix,
		Region: "auto",
		Provider: "Cloudflare",
	};
}

/** The claims inside a minted session token (tests and the proof read them; nothing here trusts them). */
export function claimsOf(sessionToken: string): Record<string, unknown> {
	const jwt = atob(sessionToken).replace(/^jwt\//, "");
	const payload = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
	return JSON.parse(atob(payload + "=".repeat((4 - (payload.length % 4)) % 4)));
}
