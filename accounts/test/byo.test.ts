// Bring your own tokens (accounts/src/byo.ts, PEP 0003 §3.11): a person attaches an S3-compatible bucket of their own on
// the account page; the Worker keeps its secret encrypted (Web Crypto AES-GCM, a key from the Worker secret
// BYO_ENCRYPTION_KEY, the row bound to its owner), and the device flow hands their machines credentials for that store
// instead of R2-scoped ones.
//
// What must hold:
// - the secret is never stored, logged or answered in the clear; a row opens only with the key and only for its owner;
// - only a signed-in BROWSER attaches or removes a bucket: a stolen laptop's bearer must not be able to point the
//   person's other machines at someone else's bucket;
// - the bucket is tried (one ListObjectsV2 with the keys the person gave) before it is stored;
// - a machine gets exactly those keys and the store as a URL string (s3://bucket/prefix, endpoint apart);
// - a row that cannot be opened fails closed (503), never falls back to the service's storage unasked.
// Production-only rules (https only, no IP literals) are checked on the pure function: the harness runs as "dev".

import assert from "node:assert/strict";
import { test } from "node:test";
import { openSecret, parseByo, sealSecret, storeUrl } from "../src/byo.ts";
import { OWN, realStack } from "./real-auth.ts";

const KEY = "byo-key-for-tests-0123456789abcdef0123456789";
const EMAIL = "maker@example.com";
const BYO_HOST = "s3.byo.example.test";
const ACCESS = "AKIABYOTESTKEY1234";
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYBYOTESTSECRET";

/** Another provider's S3 endpoint: answers ListObjectsV2 for one bucket, only to requests signed with the right key id. */
function byoStore() {
	const requests: { method: string; url: string; credential: string }[] = [];
	const state = { reachable: true, accept: ACCESS };
	const fetch = async (request: Request): Promise<Response> => {
		const credential = /Credential=([^/,]+)\//.exec(request.headers.get("Authorization") ?? "")?.[1] ?? "";
		requests.push({ method: request.method, url: request.url, credential });
		if (!state.reachable) throw new TypeError("fetch failed");
		if (credential !== state.accept) return new Response("<Error><Code>InvalidAccessKeyId</Code></Error>", { status: 403 });
		return new Response('<?xml version="1.0"?><ListBucketResult><Name>mine</Name><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200, headers: { "Content-Type": "application/xml" } });
	};
	return { fetch, requests, state };
}

async function stack(extra: Record<string, string> = {}) {
	const s = await realStack({ FEATURE_BYO: "on", BYO_ENCRYPTION_KEY: KEY, QUOTA_BYTES: "2000", ...extra });
	const theirs = byoStore();
	const hosted = s.deps.s3;
	s.deps.s3 = (request) => (new URL(request.url).host === BYO_HOST ? theirs.fetch(request) : hosted(request));
	const attach = (who: { page: Record<string, string> }, body: Record<string, unknown> = {}) =>
		s.call("/fs/v1/byo", { method: "PUT", headers: { ...who.page, "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: `https://${BYO_HOST}`, bucket: "mine", prefix: "folder-sync", accessKeyId: ACCESS, secretAccessKey: SECRET, ...body }) });
	return { s, theirs, attach };
}

// ------------------------------------------------------------------------------------------------ sealing

test("a secret opens with its key for its owner, and only then; each seal is different; nothing in it reads as the secret", async () => {
	const sealed = await sealSecret(KEY, "ownerABC123", SECRET);
	assert.match(sealed, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
	assert.equal(await openSecret(KEY, "ownerABC123", sealed), SECRET);
	assert.notEqual(await sealSecret(KEY, "ownerABC123", SECRET), sealed, "a fresh IV each time");
	assert.ok(!sealed.includes(SECRET) && !Buffer.from(sealed.split(".")[2], "base64url").toString("latin1").includes("MDENG"), "not in the clear");
	await assert.rejects(openSecret(`${KEY}x`, "ownerABC123", sealed), "another key");
	await assert.rejects(openSecret(KEY, "ownerABC1234", sealed), "another owner's row");
	const [version, iv, body] = sealed.split(".");
	const flipped = Buffer.from(body, "base64url");
	flipped[0] ^= 1;
	await assert.rejects(openSecret(KEY, "ownerABC123", `${version}.${iv}.${flipped.toString("base64url")}`), "a changed byte");
	await assert.rejects(openSecret(KEY, "ownerABC123", "v2.a.b"), "an unknown version");
	await assert.rejects(openSecret(KEY, "ownerABC123", "garbage"));
});

test("a weak key is refused: the secret is at least 32 characters", async () => {
	await assert.rejects(sealSecret("short", "ownerABC123", SECRET), /BYO_ENCRYPTION_KEY/);
	await assert.rejects(sealSecret("", "ownerABC123", SECRET), /BYO_ENCRYPTION_KEY/);
});

// ------------------------------------------------------------------------------------------------ the rules

test("parseByo: production takes https endpoints on a host name only; dev also takes http on loopback", () => {
	const good = { endpoint: "https://s3.us-west-002.backblazeb2.com", bucket: "my-bucket", prefix: "sync", accessKeyId: ACCESS, secretAccessKey: SECRET };
	const ok = parseByo(good, false);
	assert.ok("value" in ok, JSON.stringify(ok));
	assert.deepEqual(ok.value, { endpoint: "https://s3.us-west-002.backblazeb2.com", bucket: "my-bucket", prefix: "sync/", region: "auto", accessKeyId: ACCESS, secretAccessKey: SECRET });
	const why = (change: Record<string, unknown>, dev = false) => {
		const answer = parseByo({ ...good, ...change }, dev);
		assert.ok("error" in answer, `accepted ${JSON.stringify(change)}`);
		return answer.error;
	};
	assert.equal(why({ endpoint: "http://s3.example.com" }), "bad_endpoint");
	assert.equal(why({ endpoint: "http://s3.example.com" }, true), "bad_endpoint", "dev takes http on loopback only");
	assert.equal(why({ endpoint: "https://10.0.0.5" }), "bad_endpoint", "an IP literal");
	assert.equal(why({ endpoint: "https://[::1]" }), "bad_endpoint");
	assert.equal(why({ endpoint: "https://localhost" }), "bad_endpoint");
	assert.equal(why({ endpoint: "https://user:pw@s3.example.com" }), "bad_endpoint", "credentials in the URL");
	assert.equal(why({ endpoint: "https://s3.example.com/path" }), "bad_endpoint", "a path");
	assert.equal(why({ endpoint: "https://s3.example.com?x=1" }), "bad_endpoint");
	assert.equal(why({ endpoint: "ftp://s3.example.com" }), "bad_endpoint");
	assert.equal(why({ endpoint: "not a url" }), "bad_endpoint");
	assert.equal(why({ endpoint: undefined }), "bad_endpoint");
	assert.equal(why({ bucket: "UPPER" }), "bad_bucket");
	assert.equal(why({ bucket: "a" }), "bad_bucket");
	assert.equal(why({ bucket: "has/slash" }), "bad_bucket");
	assert.equal(why({ prefix: "../other" }), "bad_prefix");
	assert.equal(why({ prefix: "/abs" }), "bad_prefix");
	assert.equal(why({ prefix: "a//b" }), "bad_prefix");
	assert.equal(why({ prefix: "a\\b" }), "bad_prefix");
	assert.equal(why({ prefix: "x".repeat(300) }), "bad_prefix");
	assert.equal(why({ accessKeyId: "" }), "bad_keys");
	assert.equal(why({ accessKeyId: "has space" }), "bad_keys");
	assert.equal(why({ secretAccessKey: "short" }), "bad_keys");
	assert.equal(why({ secretAccessKey: "x".repeat(300) }), "bad_keys");
	assert.equal(why({ region: "Not A Region!" }), "bad_region");
	// dev: loopback http is fine
	assert.ok("value" in parseByo({ ...good, endpoint: "http://127.0.0.1:9000" }, true));
	assert.ok("value" in parseByo({ ...good, endpoint: "http://localhost:9000" }, true));
	assert.equal(why({ endpoint: "http://127.0.0.1:9000" }), "bad_endpoint", "never in production");
	// an empty prefix is the bucket's root, a trailing slash is kept once
	assert.equal((parseByo({ ...good, prefix: "" }, false) as { value: { prefix: string } }).value.prefix, "");
	assert.equal((parseByo({ ...good, prefix: "a/b/" }, false) as { value: { prefix: string } }).value.prefix, "a/b/");
	assert.equal((parseByo({ ...good, region: "us-east-1" }, false) as { value: { region: string } }).value.region, "us-east-1");
	assert.equal((parseByo({ ...good, endpoint: "https://S3.Example.COM/" }, false) as { value: { endpoint: string } }).value.endpoint, "https://s3.example.com");
});

test("storeUrl: s3://bucket/prefix, the endpoint apart", () => {
	assert.equal(storeUrl({ bucket: "mine", prefix: "folder-sync/" }), "s3://mine/folder-sync/");
	assert.equal(storeUrl({ bucket: "mine", prefix: "" }), "s3://mine/");
});

// ------------------------------------------------------------------------------------------------ the routes

test("attach: the bucket is tried with the person's keys, stored encrypted, and answered without the secret", async () => {
	const { s, theirs, attach } = await stack();
	const a = await s.browser(EMAIL);
	assert.deepEqual(await (await s.call("/fs/v1/byo", { headers: { Cookie: a.cookie } })).json(), { owner: a.userId, attached: false });
	const answer = await attach(a);
	assert.equal(answer.status, 200, await answer.clone().text());
	const body = await answer.json();
	assert.deepEqual(body, { owner: a.userId, attached: true, endpoint: `https://${BYO_HOST}`, bucket: "mine", prefix: "folder-sync/", region: "auto", store: "s3://mine/folder-sync/", keyHint: "1234", updated: body.updated });
	assert.ok(!JSON.stringify(body).includes(SECRET) && !JSON.stringify(body).includes(ACCESS));
	// tried once, with their key id and a listing, nothing written
	assert.equal(theirs.requests.length, 1);
	assert.equal(theirs.requests[0].method, "GET");
	assert.match(theirs.requests[0].url, /list-type=2/);
	assert.equal(theirs.requests[0].credential, ACCESS);
	// at rest: not in the clear anywhere in the row
	const row = s.db.prepare('SELECT * FROM "byo_store" WHERE "owner_id" = ?').get(a.userId) as Record<string, unknown>;
	const dump = JSON.stringify(row);
	assert.ok(!dump.includes(SECRET) && !dump.includes("MDENG") && !dump.includes(ACCESS), `plaintext in the row: ${dump}`);
	assert.match(String(row.sealed), /^v1\./);
	assert.equal(row.key_hint, "1234");
	// and the read-back says the same
	const read = await (await s.call("/fs/v1/byo", { headers: { Cookie: a.cookie } })).json();
	assert.deepEqual(read, body);
});

test("a machine signed in through the device flow gets the person's own bucket's keys, as a store URL, not the service's", async () => {
	const { s, attach } = await stack();
	const a = await s.browser(EMAIL);
	const laptop = await s.machine(a.cookie);
	const bearer = { Authorization: `Bearer ${laptop.token}` };
	assert.equal((await (await s.call("/fs/v1/credentials", { method: "POST", headers: bearer })).json()).AccessKeyId, "parent-key-id", "before: the service's");
	assert.equal((await attach(a)).status, 200);
	s.clock.now += 1000;
	const keys = await (await s.call("/fs/v1/credentials", { method: "POST", headers: bearer })).json();
	assert.equal(keys.AccessKeyId, ACCESS);
	assert.equal(keys.SecretAccessKey, SECRET);
	assert.equal(keys.Endpoint, `https://${BYO_HOST}`);
	assert.equal(keys.Bucket, "mine");
	assert.equal(keys.Prefix, "folder-sync/");
	assert.equal(keys.Store, "s3://mine/folder-sync/");
	assert.equal(keys.Provider, "Other");
	assert.equal(keys.Region, "auto");
	assert.equal(keys.Version, 1);
	assert.ok(!("SessionToken" in keys) || keys.SessionToken === "", "long-lived keys have no session token");
	assert.equal(keys.ReadOnly, undefined);
	// the machine re-asks within the usual TTL, so a removal or a rotation reaches it soon
	assert.equal(Date.parse(keys.Expiration), s.clock.now + 300_000);
	// a second person on the same deployment is untouched
	const b = await s.browser("other@example.com");
	const other = await s.machine(b.cookie);
	const theirs = await (await s.call("/fs/v1/credentials", { method: "POST", headers: { Authorization: `Bearer ${other.token}` } })).json();
	assert.equal(theirs.AccessKeyId, "parent-key-id");
	assert.equal(theirs.Prefix, `users/${b.userId}/`);
});

test("a bucket of one's own has no hosted quota: the service's usage never turns the machine read-only", async () => {
	const { s, attach } = await stack();
	const a = await s.browser(EMAIL);
	const laptop = await s.machine(a.cookie);
	s.s3.put(`users/${a.userId}/notes/hosts/h/big.bin`, new Uint8Array(3000)); // over the 2000-byte quota
	const bearer = { Authorization: `Bearer ${laptop.token}` };
	assert.equal((await (await s.call("/fs/v1/credentials", { method: "POST", headers: bearer })).json()).ReadOnly, true);
	await attach(a);
	const keys = await (await s.call("/fs/v1/credentials", { method: "POST", headers: bearer })).json();
	assert.equal(keys.ReadOnly, undefined);
	assert.equal(keys.AccessKeyId, ACCESS);
});

test("remove: the row is deleted and machines get the service's keys again", async () => {
	const { s, attach } = await stack();
	const a = await s.browser(EMAIL);
	const laptop = await s.machine(a.cookie);
	await attach(a);
	const removed = await s.call("/fs/v1/byo", { method: "DELETE", headers: a.page });
	assert.equal(removed.status, 200);
	assert.deepEqual(await removed.json(), { owner: a.userId, attached: false });
	assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM "byo_store"').get()!.n, 0);
	assert.equal((await (await s.call("/fs/v1/credentials", { method: "POST", headers: { Authorization: `Bearer ${laptop.token}` } })).json()).AccessKeyId, "parent-key-id");
});

test("attaching again replaces the keys (rotation); the old secret is gone from the row", async () => {
	const { s, theirs, attach } = await stack();
	const a = await s.browser(EMAIL);
	await attach(a);
	theirs.state.accept = "AKIAROTATED0000099";
	assert.equal((await attach(a)).status, 400, "the old key no longer works on their side");
	assert.equal((await attach(a, { accessKeyId: "AKIAROTATED0000099", secretAccessKey: "rotated/secret/for/the/test/0123456789" })).status, 200);
	assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM "byo_store"').get()!.n, 1);
	const laptop = await s.machine(a.cookie);
	const keys = await (await s.call("/fs/v1/credentials", { method: "POST", headers: { Authorization: `Bearer ${laptop.token}` } })).json();
	assert.equal(keys.AccessKeyId, "AKIAROTATED0000099");
	assert.equal(keys.SecretAccessKey, "rotated/secret/for/the/test/0123456789");
});

test("keys the bucket refuses, or a bucket that cannot be reached, are not stored, and the answer never echoes a key", async () => {
	const { s, theirs, attach } = await stack();
	const a = await s.browser(EMAIL);
	const denied = await attach(a, { accessKeyId: "AKIAWRONGKEY00000" });
	assert.equal(denied.status, 400);
	const deniedBody = await denied.json();
	assert.equal(deniedBody.error, "byo_denied");
	theirs.state.reachable = false;
	const gone = await attach(a);
	assert.equal(gone.status, 400);
	const goneBody = await gone.json();
	assert.equal(goneBody.error, "byo_unreachable");
	for (const text of [JSON.stringify(deniedBody), JSON.stringify(goneBody)]) assert.ok(!text.includes(SECRET) && !text.includes("AKIAWRONGKEY"), text);
	assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM "byo_store"').get()!.n, 0);
});

test("only a signed-in browser attaches or removes a bucket: not a machine's bearer, not a cookie without the page's CSRF header, not a stranger", async () => {
	const { s, attach } = await stack();
	const a = await s.browser(EMAIL);
	const laptop = await s.machine(a.cookie);
	const asMachine = await s.call("/fs/v1/byo", { method: "PUT", headers: { Authorization: `Bearer ${laptop.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: `https://${BYO_HOST}`, bucket: "mine", accessKeyId: ACCESS, secretAccessKey: SECRET }) });
	assert.equal(asMachine.status, 403, "a stolen laptop must not redirect the person's other machines");
	assert.equal((await asMachine.json()).error, "browser_only");
	assert.equal((await s.call("/fs/v1/byo", { method: "DELETE", headers: { Authorization: `Bearer ${laptop.token}` } })).status, 403);
	assert.equal((await attach({ page: { Cookie: a.cookie } })).status, 403, "no CSRF header");
	assert.equal((await s.call("/fs/v1/byo", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401, "signed out");
	assert.equal((await s.call("/fs/v1/byo", { headers: { Authorization: `Bearer ${laptop.token}` } })).status, 403, "a machine cannot read it back either");
	assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM "byo_store"').get()!.n, 0);
});

test("without BYO_ENCRYPTION_KEY nothing is attached (503): the secret is never stored unsealed", async () => {
	const { s, attach } = await stack({ BYO_ENCRYPTION_KEY: "" });
	const a = await s.browser(EMAIL);
	const answer = await attach(a);
	assert.equal(answer.status, 503);
	assert.equal((await answer.json()).error, "not_configured");
	assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM "byo_store"').get()!.n, 0);
});

test("a row that cannot be opened (another key, or copied from someone else) fails closed: no keys at all, never the service's storage unasked", async () => {
	const { s, attach } = await stack();
	const a = await s.browser(EMAIL);
	const b = await s.browser("other@example.com");
	await attach(a);
	const laptopA = await s.machine(a.cookie);
	const laptopB = await s.machine(b.cookie);
	// B's row is A's sealed secret: bound to A, it does not open for B
	const row = s.db.prepare('SELECT * FROM "byo_store" WHERE "owner_id" = ?').get(a.userId) as Record<string, string>;
	s.db.prepare('INSERT INTO "byo_store" ("owner_id", "endpoint", "bucket", "prefix", "key_hint", "sealed", "created_at", "updated_at") VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(b.userId, row.endpoint, row.bucket, row.prefix, row.key_hint, row.sealed, row.created_at, row.updated_at);
	const stolen = await s.call("/fs/v1/credentials", { method: "POST", headers: { Authorization: `Bearer ${laptopB.token}` } });
	assert.equal(stolen.status, 503);
	const stolenBody = await stolen.json();
	assert.equal(stolenBody.error, "byo_unreadable");
	assert.ok(!JSON.stringify(stolenBody).includes(SECRET));
	// the Worker's key changed: A's own row no longer opens
	s.env.BYO_ENCRYPTION_KEY = `${KEY}-rotated`;
	const rotated = await s.call("/fs/v1/credentials", { method: "POST", headers: { Authorization: `Bearer ${laptopA.token}` } });
	assert.equal(rotated.status, 503);
	assert.equal((await rotated.json()).error, "byo_unreadable");
});

test("the account page: the form when nothing is attached; the bucket and the last four of the key id, and Remove, once attached; never a secret", async () => {
	const { s, attach } = await stack();
	const a = await s.browser(EMAIL);
	const page = async () => (await s.call("/fs/account", { headers: { Cookie: a.cookie } })).text();
	const none = await page();
	assert.match(none, /data-testid="fs-byo"/);
	assert.match(none, /<form method="post" action="\/fs\/account\/byo">/);
	for (const field of ["endpoint", "bucket", "prefix", "accessKeyId", "secretAccessKey"]) assert.match(none, new RegExp(`name="${field}"`), field);
	assert.match(none, /name="secretAccessKey"[^>]*type="password"|type="password"[^>]*name="secretAccessKey"/);
	assert.match(none, /autocomplete="off"/);

	// the page's own form: attach
	const form = (path: string, body: Record<string, string>, origin = OWN) =>
		s.call(path, { method: "POST", headers: { Cookie: a.cookie, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
	const fields = { user: a.userId, endpoint: `https://${BYO_HOST}`, bucket: "mine", prefix: "folder-sync", accessKeyId: ACCESS, secretAccessKey: SECRET };
	assert.equal((await form("/fs/account/byo", fields, "https://evil.example")).status, 403);
	assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM "byo_store"').get()!.n, 0);
	const sent = await form("/fs/account/byo", fields);
	assert.equal(sent.status, 303, await sent.clone().text());
	assert.match(sent.headers.get("Location")!, /\/fs\/account\?done=byo-attached/);
	const attached = await page();
	assert.match(attached, /s3:\/\/mine\/folder-sync\//);
	assert.match(attached, new RegExp(BYO_HOST.replace(/\./g, "\\.")));
	assert.match(attached, /1234/);
	assert.match(attached, /action="\/fs\/account\/byo\/remove"/);
	assert.ok(!attached.includes(SECRET) && !attached.includes(ACCESS), "no secret, and not even the whole key id");
	// a refused bucket comes back to the page with its reason, nothing stored over the old one
	const bad = await form("/fs/account/byo", { ...fields, bucket: "UPPER" });
	assert.match(bad.headers.get("Location")!, /done=byo-bad_bucket/);
	assert.match(await (await s.call("/fs/account?done=byo-bad_bucket", { headers: { Cookie: a.cookie } })).text(), /bucket name/i);
	// remove
	const removed = await form("/fs/account/byo/remove", { user: a.userId });
	assert.match(removed.headers.get("Location")!, /done=byo-removed/);
	assert.match(await page(), /<form method="post" action="\/fs\/account\/byo">/);
	// a page open for another account changes nothing
	assert.match((await form("/fs/account/byo", { ...fields, user: "someoneelse1" })).headers.get("Location")!, /done=wrong-user/);
	assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM "byo_store"').get()!.n, 0);
});
