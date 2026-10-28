// The account's devices and the files route's media (node --test accounts/test/devices.test.ts; bare Node, like
// worker.test.ts: no npm modules, no network, no ports).
//
// What must hold (PEP 0003 §3.3):
// - GET /fs/v1/devices lists this person's sessions and nobody else's, and never a session token;
// - POST /fs/v1/devices/revoke {id} deletes one of the caller's own sessions: after it, that bearer is 401 everywhere
//   and gets no new storage keys; another person's id is the same 404 as an unknown one; a browser's revoke needs
//   the CSRF header from its own origin; the answer states how long keys already handed out still live;
// - GET /fs/account is a whole page with no script, whose Revoke and Sign out are plain form POSTs a foreign origin
//   cannot send;
// - …/files/ serves .log, .mp4, .webm, .mov and .m4v as what they are, and answers Range (206, 416, If-Range, HEAD)
//   by reading only the asked-for bytes from storage.
// The mutations at the bottom prove the ownership and CSRF tests go red when the line that holds them is broken.
//
// The accounts layer is a stand-in (`fakeDeps`); Better Auth's own sessions are exercised by test/proof.mjs.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { handle, type Deps, type Env, type Person } from "../src/app.ts";
import type { SessionRow } from "../src/devices.ts";
import { MemoryS3 } from "./memory-s3.ts";
import { MemoryStore } from "./memory-store.ts";

const SITE = "https://robotparts.dev";
const OWN = "https://accounts.example.test";
const ENDPOINT = "https://acct0123.r2.cloudflarestorage.com";
const BUCKET = "folder-sync";
const MACHINE = "b55e9683-7854-4121-a56a-9bae7c3ab1da";
const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const OWNER = { userId: "ownerABC123", email: "owner@example.com", name: "Owner" };
const SISTER = { userId: "ownerABC1234", email: "sister@example.com", name: "Sister" };

type Handle = typeof handle;
type Live = SessionRow & { token: string; userId: string; email: string; name: string };

function env(extra: Partial<Env> = {}): Env {
	return {
		ENVIRONMENT: "production",
		PUBLIC_URL: OWN,
		R2_ACCOUNT_ID: "acct0123",
		R2_PARENT_ACCESS_KEY_ID: "parent-key-id",
		R2_PARENT_SECRET_ACCESS_KEY: "parent-secret-fixture",
		SYNC_BUCKET: BUCKET,
		...extra,
	};
}

/** Each person's sessions: the owner's browser, laptop and an old one with no User-Agent; the sister's two. */
function sessions(): Map<string, Live> {
	const rows: Live[] = [
		{ ...OWNER, id: "sess-owner-browser", token: "tok-owner-browser", userAgent: CHROME, createdAt: "2026-10-01T09:00:00.000Z", updatedAt: "2026-10-26T08:00:00.000Z" },
		{ ...OWNER, id: "sess-owner-laptop", token: "token-owner-laptop", userAgent: "folder-sync/v0.3.1 (zach-laptop; linux)", createdAt: "2026-10-03T10:00:00.000Z", updatedAt: "2026-10-25T10:00:00.000Z" },
		{ ...OWNER, id: "sess-owner-old", token: "token-owner-old", userAgent: null, createdAt: "2026-09-02T10:00:00.000Z", updatedAt: "2026-09-02T10:00:00.000Z" },
		{ ...SISTER, id: "sess-sister-browser", token: "tok-sister-browser", userAgent: CHROME, createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-26T10:00:00.000Z" },
		{ ...SISTER, id: "sess-sister-laptop", token: "token-sister-laptop", userAgent: "folder-sync/v0.3.1 (sister-mbp; darwin)", createdAt: "2026-10-06T10:00:00.000Z", updatedAt: "2026-10-26T11:00:00.000Z" },
	];
	return new Map(rows.map((r) => [r.token, r]));
}

function personOf(row: Live): Person {
	return { userId: row.userId, email: row.email, name: row.name, image: null, sessionId: row.id, sessionToken: row.token };
}

function fakeDeps(s3: MemoryS3, live = sessions(), extra: Partial<Deps> = {}) {
	const deps: Deps = {
		async auth() {
			return new Response("{}", { headers: { "Content-Type": "application/json" } });
		},
		async person(request, via) {
			const token = via === "bearer"
				? (request.headers.get("Authorization") || "").replace(/^bearer\s+/i, "")
				: /(?:^|;\s*)s=([^;]+)/.exec(request.headers.get("Cookie") || "")?.[1];
			const row = token ? live.get(token) : undefined;
			return row ? personOf(row) : null;
		},
		async signOut(_request, via, _app, person) {
			live.delete(person.sessionToken);
			return via === "cookie" ? ["s=; Path=/; Max-Age=0"] : [];
		},
		async sessions(userId) {
			return [...live.values()].filter((r) => r.userId === userId).map(({ id, userAgent, createdAt, updatedAt }) => ({ id, userAgent, createdAt, updatedAt }));
		},
		async revokeSession(userId, id) {
			for (const [token, row] of live) {
				if (row.userId === userId && row.id === id) {
					live.delete(token);
					return true;
				}
			}
			return false;
		},
		store: new MemoryStore(),
		s3: s3.fetch,
		now: () => Date.parse("2026-10-27T12:00:00Z"),
		uuid: () => "3f1c2a9e-5b7d-4c11-8e2f-0a1b2c3d4e5f",
		...extra,
	};
	return { deps, live };
}

function call(h: Handle, e: Env, deps: Deps | null, path: string, init: RequestInit & { origin?: string } = {}): Promise<Response> {
	const origin = init.origin ?? SITE;
	return h(new Request(`${origin}${path}`, { redirect: "manual", ...init }), e, deps);
}

const cookie = (token: string) => ({ Cookie: `s=${token}` });
/** A write from the app's own page: its cookie, its Origin, the CSRF header and the user it shows. */
const page = (token: string, userId: string) => ({ ...cookie(token), Origin: SITE, "X-Folder-Sync": "1", "X-Folder-Sync-User": userId });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
/** A no-JavaScript form POST from `origin` (null: none sent). */
function form(token: string, fields: Record<string, string>, origin: string | null = SITE): RequestInit {
	return { method: "POST", headers: { ...cookie(token), "Content-Type": "application/x-www-form-urlencoded", ...(origin ? { Origin: origin } : {}) }, body: new URLSearchParams(fields).toString() };
}
const revoke = (headers: Record<string, string>, id: string): RequestInit => ({ method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ id }) });

// ------------------------------------------------------------------------------------------------ devices

test("GET /fs/v1/devices: only my own sessions, named truthfully, the current one marked, never a token", async () => {
	const { deps } = fakeDeps(new MemoryS3(ENDPOINT, BUCKET));
	const answer = await call(handle, env(), deps, "/fs/v1/devices", { headers: cookie("tok-owner-browser") });
	assert.equal(answer.status, 200);
	const text = await answer.text();
	const body = JSON.parse(text);
	assert.equal(body.owner, OWNER.userId);
	assert.deepEqual(body.devices, [
		{ id: "sess-owner-browser", kind: "browser", name: "Chrome on Linux", created: "2026-10-01T09:00:00.000Z", lastSeen: "2026-10-26T08:00:00.000Z", current: true },
		{ id: "sess-owner-laptop", kind: "machine", name: "zach-laptop", created: "2026-10-03T10:00:00.000Z", lastSeen: "2026-10-25T10:00:00.000Z", current: false },
		{ id: "sess-owner-old", kind: "browser", name: null, created: "2026-09-02T10:00:00.000Z", lastSeen: "2026-09-02T10:00:00.000Z", current: false },
	]);
	for (const secret of ["tok-owner-browser", "token-owner-laptop", "token-owner-old", "sister", "token-sister-laptop"]) assert.ok(!text.includes(secret), `the list holds ${secret}`);
	// a machine sees the same list, itself current
	const machine = await (await call(handle, env(), deps, "/fs/v1/devices", { origin: OWN, headers: bearer("token-owner-laptop") })).json();
	assert.deepEqual(machine.devices.filter((d: { current: boolean }) => d.current).map((d: { id: string }) => d.id), ["sess-owner-laptop"]);
	const sister = await (await call(handle, env(), deps, "/fs/v1/devices", { headers: cookie("tok-sister-browser") })).json();
	assert.deepEqual(sister.devices.map((d: { id: string; name: string }) => `${d.id}:${d.name}`), ["sess-sister-browser:Chrome on Linux", "sess-sister-laptop:sister-mbp"]);
	assert.equal((await call(handle, env(), deps, "/fs/v1/devices")).status, 401);
	assert.equal((await call(handle, env(), deps, "/fs/v1/devices", { method: "POST" })).status, 405);
});

test("revoke: the revoked bearer is 401 on /fs/v1/* and gets no new storage keys; the answer states the keys' lifetime", async () => {
	const s3 = new MemoryS3(ENDPOINT, BUCKET);
	const { deps, live } = fakeDeps(s3);
	const e = env();
	const keys = () => call(handle, e, deps, "/fs/v1/credentials", { origin: OWN, method: "POST", headers: bearer("token-owner-laptop") });
	const before = await keys();
	assert.equal(before.status, 200, "keys before the revoke");
	assert.ok((await before.json()).SessionToken);
	const answer = await call(handle, e, deps, "/fs/v1/devices/revoke", revoke(page("tok-owner-browser", OWNER.userId), "sess-owner-laptop"));
	assert.equal(answer.status, 200);
	const body = await answer.json();
	assert.deepEqual({ ...body, note: undefined }, { revoked: "sess-owner-laptop", current: false, keysExpireWithinS: 300, note: undefined });
	assert.match(body.note, /within 5 minutes/);
	assert.ok(![...live.values()].some((r) => r.id === "sess-owner-laptop"), "the session is gone");
	const after = await keys();
	assert.equal(after.status, 401);
	assert.ok(!("SessionToken" in (await after.json())), "no new keys");
	for (const path of ["/fs/v1/me", "/fs/v1/devices", "/fs/v1/folders", "/fs/v1/usage"]) {
		assert.equal((await call(handle, e, deps, path, { origin: OWN, headers: bearer("token-owner-laptop") })).status, 401, path);
	}
	// the TTL said is the one keys are minted with
	const short = await call(handle, env({ SYNC_CREDENTIAL_TTL_S: "90" }), deps, "/fs/v1/devices/revoke", revoke(page("tok-owner-browser", OWNER.userId), "sess-owner-old"));
	const shortBody = await short.json();
	assert.equal(shortBody.keysExpireWithinS, 90);
	assert.match(shortBody.note, /within 90 seconds/);
	// the browser that revoked is still signed in
	assert.equal((await call(handle, e, deps, "/fs/v1/me", { headers: cookie("tok-owner-browser") })).status, 200);
});

test("revoke: another person's device is the same 404 as an unknown id, and stays signed in", async () => {
	const { deps, live } = fakeDeps(new MemoryS3(ENDPOINT, BUCKET));
	const e = env();
	const crossed = await call(handle, e, deps, "/fs/v1/devices/revoke", revoke(page("tok-owner-browser", OWNER.userId), "sess-sister-laptop"));
	const unknown = await call(handle, e, deps, "/fs/v1/devices/revoke", revoke(page("tok-owner-browser", OWNER.userId), "sess-nobody"));
	assert.equal(crossed.status, 404);
	assert.equal(unknown.status, 404);
	assert.deepEqual(await crossed.json(), await unknown.json());
	assert.ok(live.has("token-sister-laptop"));
	assert.equal((await call(handle, e, deps, "/fs/v1/credentials", { origin: OWN, method: "POST", headers: bearer("token-sister-laptop") })).status, 200);
	// from a machine too
	const byMachine = await call(handle, e, deps, "/fs/v1/devices/revoke", { origin: OWN, ...revoke(bearer("token-owner-laptop"), "sess-sister-browser") });
	assert.equal(byMachine.status, 404);
	assert.ok(live.has("tok-sister-browser"));
	for (const bad of [{}, { id: 7 }, { id: "" }, { id: "x".repeat(300) }]) {
		const answer = await call(handle, e, deps, "/fs/v1/devices/revoke", { method: "POST", headers: { ...page("tok-owner-browser", OWNER.userId), "Content-Type": "application/json" }, body: JSON.stringify(bad) });
		assert.equal(answer.status, 400, JSON.stringify(bad));
	}
});

test("revoke: a browser's revoke from a foreign origin, or without the CSRF header, or for another tab's user, is refused", async () => {
	const { deps, live } = fakeDeps(new MemoryS3(ENDPOINT, BUCKET));
	const e = env();
	const tries: [string, Record<string, string>][] = [
		["foreign Origin", { ...page("tok-owner-browser", OWNER.userId), Origin: "https://evil.example" }],
		["no X-Folder-Sync", { ...cookie("tok-owner-browser"), Origin: SITE, "X-Folder-Sync-User": OWNER.userId }],
		["no Origin", { ...cookie("tok-owner-browser"), "X-Folder-Sync": "1", "X-Folder-Sync-User": OWNER.userId }],
	];
	for (const [what, headers] of tries) {
		const answer = await call(handle, e, deps, "/fs/v1/devices/revoke", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ id: "sess-owner-laptop" }) });
		assert.equal(answer.status, 403, what);
		assert.equal((await answer.json()).error, "csrf", what);
	}
	const wrongTab = await call(handle, e, deps, "/fs/v1/devices/revoke", revoke(page("tok-owner-browser", SISTER.userId), "sess-owner-laptop"));
	assert.equal(wrongTab.status, 409);
	// the account page's form: a foreign Origin, or none, is refused before anything is read
	for (const origin of ["https://evil.example", "null", null]) {
		const answer = await call(handle, e, deps, "/fs/account/revoke", form("tok-owner-browser", { id: "sess-owner-laptop", user: OWNER.userId }, origin));
		assert.equal(answer.status, 403, `form from ${origin}`);
	}
	const signOut = await call(handle, e, deps, "/fs/account/sign-out", form("tok-owner-browser", { user: OWNER.userId }, "https://evil.example"));
	assert.equal(signOut.status, 403);
	assert.ok(live.has("token-owner-laptop") && live.has("tok-owner-browser"), "nothing was signed out");
});

test("revoke: revoking my current browser session signs me out (its cookie cleared); a machine may revoke itself", async () => {
	const { deps, live } = fakeDeps(new MemoryS3(ENDPOINT, BUCKET));
	const e = env();
	const answer = await call(handle, e, deps, "/fs/v1/devices/revoke", revoke(page("tok-owner-browser", OWNER.userId), "sess-owner-browser"));
	assert.equal(answer.status, 200);
	assert.equal((await answer.json()).current, true);
	assert.match(answer.headers.get("Set-Cookie") || "", /Max-Age=0/);
	assert.ok(!live.has("tok-owner-browser"));
	assert.equal((await call(handle, e, deps, "/fs/v1/me", { headers: cookie("tok-owner-browser") })).status, 401);
	const self = await call(handle, e, deps, "/fs/v1/devices/revoke", { origin: OWN, ...revoke(bearer("token-owner-laptop"), "sess-owner-laptop") });
	assert.equal(self.status, 200);
	assert.equal(self.headers.get("Set-Cookie"), null);
	assert.equal((await call(handle, e, deps, "/fs/v1/credentials", { origin: OWN, method: "POST", headers: bearer("token-owner-laptop") })).status, 401);
});

// ------------------------------------------------------------------------------------------------ the account page

function rootOf(s3: MemoryS3, userId: string, bytes: number) {
	s3.put(`users/${userId}/robotparts/hosts/${MACHINE}/data.bin`, new Uint8Array(bytes));
}

test("GET /fs/account: the whole page with no script: who, usage, devices with Revoke forms, Sign out; the TTL stated", async () => {
	const s3 = new MemoryS3(ENDPOINT, BUCKET);
	rootOf(s3, OWNER.userId, 3 * 1024 * 1024);
	const { deps } = fakeDeps(s3);
	const answer = await call(handle, env(), deps, "/fs/account", { headers: cookie("tok-owner-browser") });
	assert.equal(answer.status, 200);
	assert.match(answer.headers.get("Content-Type") || "", /^text\/html/);
	assert.match(answer.headers.get("Content-Security-Policy") || "", /form-action 'self'/);
	assert.equal(answer.headers.get("X-Frame-Options"), "DENY");
	const html = await answer.text();
	assert.ok(!/<script/i.test(html), "no script: the page works with JavaScript off");
	assert.ok(!/(href|action|src)="(https?:)?\/\//.test(html), "every link stays on the app's own domain");
	assert.ok(html.includes("owner@example.com"));
	assert.match(html, /3(\.0)? MiB of 1 GiB/);
	assert.match(html, /1 of 100,000 files/);
	assert.match(html, /within 5 minutes/);
	// each device: its name (or Unnamed device), kind, first-seen date, and a Revoke form for exactly its id
	for (const [id, name] of [["sess-owner-browser", "Chrome on Linux"], ["sess-owner-laptop", "zach-laptop"], ["sess-owner-old", "Unnamed device"]]) {
		const item = new RegExp(`<li[^>]*data-device="${id}"[\\s\\S]*?</li>`).exec(html)?.[0] || "";
		assert.ok(item.includes(name), `${id} named ${name}`);
		assert.match(item, /<form method="post" action="\/fs\/account\/revoke">/);
		assert.ok(item.includes(`name="id" value="${id}"`));
		assert.ok(item.includes(`name="user" value="${OWNER.userId}"`));
		assert.match(item, /<button[^>]*>Revoke<\/button>/);
	}
	assert.match(new RegExp(`<li[^>]*data-device="sess-owner-old"[\\s\\S]*?</li>`).exec(html)![0], /Browser · first seen 2026-09-02/);
	assert.match(new RegExp(`<li[^>]*data-device="sess-owner-laptop"[\\s\\S]*?</li>`).exec(html)![0], /Machine · first seen 2026-10-03/);
	assert.match(new RegExp(`<li[^>]*data-device="sess-owner-browser"[\\s\\S]*?</li>`).exec(html)![0], /This browser/);
	assert.ok(!html.includes("sister") && !html.includes("tok-") && !html.includes("token-"), "no one else's devices, no tokens");
	assert.match(html, /<form method="post" action="\/fs\/account\/sign-out">[\s\S]*?<button[^>]*>Sign out<\/button>/);
	assert.ok(html.includes('href="/fs/site/account.css"'));
});

test("the account page's forms: Revoke (303 back, the device gone), revoking this browser or Sign out signs out; signed out the page says so", async () => {
	const s3 = new MemoryS3(ENDPOINT, BUCKET);
	const { deps, live } = fakeDeps(s3);
	const e = env();
	const revoked = await call(handle, e, deps, "/fs/account/revoke", form("tok-owner-browser", { id: "sess-owner-laptop", user: OWNER.userId }));
	assert.equal(revoked.status, 303);
	assert.equal(revoked.headers.get("Location"), "/fs/account?done=revoked");
	assert.ok(!live.has("token-owner-laptop"));
	const after = await (await call(handle, e, deps, "/fs/account?done=revoked", { headers: cookie("tok-owner-browser") })).text();
	assert.ok(!after.includes('data-device="sess-owner-laptop"'));
	assert.match(after, /Signed that device out\. Storage keys it already holds stop working within 5 minutes\./);
	// another person's id through the form: nothing happens, the page says so
	const crossed = await call(handle, e, deps, "/fs/account/revoke", form("tok-owner-browser", { id: "sess-sister-laptop", user: OWNER.userId }));
	assert.equal(crossed.headers.get("Location"), "/fs/account?done=not-found");
	assert.ok(live.has("token-sister-laptop"));
	// a form from a tab that showed someone else changes nothing
	const wrong = await call(handle, e, deps, "/fs/account/revoke", form("tok-owner-browser", { id: "sess-owner-old", user: SISTER.userId }));
	assert.equal(wrong.headers.get("Location"), "/fs/account?done=wrong-user");
	assert.ok(live.has("token-owner-old"));
	// revoking this browser from its own page signs it out
	const self = await call(handle, e, deps, "/fs/account/revoke", form("tok-owner-browser", { id: "sess-owner-browser", user: OWNER.userId }));
	assert.equal(self.status, 303);
	assert.equal(self.headers.get("Location"), "/fs/account?done=signed-out");
	assert.match(self.headers.get("Set-Cookie") || "", /Max-Age=0/);
	assert.ok(!live.has("tok-owner-browser"));
	const out = await call(handle, e, deps, "/fs/account?done=signed-out", { headers: cookie("tok-owner-browser") });
	assert.equal(out.status, 200);
	const outHtml = await out.text();
	assert.ok(!/<script/i.test(outHtml));
	assert.match(outHtml, /href="\/fs\/signin\?return=\/fs\/account"/);
	assert.ok(!outHtml.includes("owner@example.com") && !outHtml.includes("data-device"));
	// Sign out
	const signOut = await call(handle, e, deps, "/fs/account/sign-out", form("tok-sister-browser", { user: SISTER.userId }));
	assert.equal(signOut.status, 303);
	assert.equal(signOut.headers.get("Location"), "/fs/account?done=signed-out");
	assert.ok(!live.has("tok-sister-browser") && live.has("token-sister-laptop"), "only the browser signed out");
	// an origin no app lists gets no page
	assert.equal((await call(handle, e, deps, "/fs/account", { origin: "https://evil.example", headers: cookie("tok-sister-browser") })).status, 404);
	assert.equal((await call(handle, e, deps, "/fs/account", { method: "PUT" })).status, 405);
});

test("the account page escapes what a device sent, and shows a long name whole one step away (title)", async () => {
	const live = sessions();
	const ua = "folder-sync/v0.3.1 (<b>lab</b> & co; linux)";
	live.set("token-owner-odd", { ...OWNER, id: "sess-owner-odd", token: "token-owner-odd", userAgent: ua, createdAt: "2026-10-20T10:00:00.000Z", updatedAt: "2026-10-20T10:00:00.000Z" });
	const strange = "Mozilla/5.0 (PlayStation; PlayStation 5/2.26) AppleWebKit/605.1.15 (KHTML, like Gecko)";
	live.set("tok-owner-ps5", { ...OWNER, id: "sess-owner-ps5", token: "tok-owner-ps5", userAgent: strange, createdAt: "2026-10-21T10:00:00.000Z", updatedAt: "2026-10-21T10:00:00.000Z" });
	const { deps } = fakeDeps(new MemoryS3(ENDPOINT, BUCKET), live);
	const html = await (await call(handle, env(), deps, "/fs/account", { headers: cookie("tok-owner-browser") })).text();
	assert.ok(!html.includes("<b>lab</b>"));
	assert.ok(html.includes("&lt;b&gt;lab&lt;/b&gt; &amp; co"));
	const ps5 = new RegExp(`<li[^>]*data-device="sess-owner-ps5"[\\s\\S]*?</li>`).exec(html)![0];
	assert.ok(ps5.includes(`title="${strange}"`), "the whole User-Agent, one hover away");
	const list = await (await call(handle, env(), deps, "/fs/v1/devices", { headers: cookie("tok-owner-browser") })).json();
	assert.equal(list.devices.find((d: { id: string }) => d.id === "sess-owner-ps5").name, strange, "an unrecognised User-Agent is the name as sent, never a guess");
});

// ------------------------------------------------------------------------------------------------ media and logs

const LOG = "0123456789abcdef\n";
const BIG = 3 * 1024 * 1024;

function bytes(n: number): Uint8Array {
	const out = new Uint8Array(n);
	for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 0xff;
	return out;
}

/** The owner's private robotparts, published by one machine: a log and some videos (one of them 3 MiB). */
function media(): MemoryS3 {
	const s3 = new MemoryS3(ENDPOINT, BUCKET);
	const files: Record<string, Uint8Array> = {
		"logs/run.log": new TextEncoder().encode(LOG),
		"media/clip.mp4": bytes(2000),
		"media/clip.webm": bytes(1500),
		"media/clip.mov": bytes(1200),
		"media/clip.m4v": bytes(1100),
		"media/big.mp4": bytes(BIG),
	};
	const base = `users/${OWNER.userId}/robotparts/hosts/${MACHINE}/`;
	s3.put(`${base}manifest.json`, JSON.stringify({
		schema: "folder-sync-manifest/1", project: "robotparts", host_id: MACHINE, host_name: "ws", seq: 3, generated_at: "2026-10-26T12:00:00Z",
		files: Object.entries(files).map(([path, data]) => ({ path, size: data.byteLength, mtime: "2026-10-26T11:00:00Z", sha256: createHash("sha256").update(data).digest("hex"), written_at: "2026-10-26T12:00:00Z" })),
	}));
	for (const [path, data] of Object.entries(files)) s3.put(`${base}${path}`, data);
	return s3;
}

const fileUrl = (path: string) => `/fs/v1/folders/robotparts/files/${MACHINE}/${path}`;
const shaOf = (data: string | Uint8Array) => `"${createHash("sha256").update(data).digest("hex")}"`;

test("…/files/: .log, .mp4, .webm, .mov and .m4v are served as what they are, nosniff, not sandboxed", async () => {
	const s3 = media();
	const { deps } = fakeDeps(s3);
	for (const [path, type] of [["logs/run.log", "text/plain; charset=utf-8"], ["media/clip.mp4", "video/mp4"], ["media/clip.webm", "video/webm"], ["media/clip.mov", "video/quicktime"], ["media/clip.m4v", "video/mp4"]]) {
		const answer = await call(handle, env(), deps, fileUrl(path), { headers: cookie("tok-owner-browser") });
		assert.equal(answer.status, 200, path);
		assert.equal(answer.headers.get("Content-Type"), type, path);
		assert.equal(answer.headers.get("X-Content-Type-Options"), "nosniff", path);
		assert.equal(answer.headers.get("Content-Security-Policy"), null, `${path} is not active content`);
		assert.equal(answer.headers.get("Accept-Ranges"), "bytes", path);
		await answer.arrayBuffer();
	}
	assert.equal(await (await call(handle, env(), deps, fileUrl("logs/run.log"), { headers: cookie("tok-owner-browser") })).text(), LOG);
});

test("…/files/ Range: 206 with Content-Range for one range, 416 past the end, multi-range the whole body, If-Range, HEAD", async () => {
	const s3 = media();
	const { deps } = fakeDeps(s3);
	const get = (range: string | null, extra: Record<string, string> = {}, method = "GET") =>
		call(handle, env(), deps, fileUrl("logs/run.log"), { method, headers: { ...cookie("tok-owner-browser"), ...(range ? { Range: range } : {}), ...extra } });
	const size = LOG.length;
	for (const [range, start, end] of [["bytes=2-5", 2, 5], ["bytes=10-", 10, size - 1], ["bytes=-3", size - 3, size - 1], ["bytes=4-1000", 4, size - 1], ["bytes=0-0", 0, 0]] as const) {
		const answer = await get(range);
		assert.equal(answer.status, 206, range);
		assert.equal(answer.headers.get("Content-Range"), `bytes ${start}-${end}/${size}`, range);
		assert.equal(answer.headers.get("Content-Length"), String(end - start + 1), range);
		assert.equal(answer.headers.get("ETag"), shaOf(LOG), range);
		assert.equal(answer.headers.get("Accept-Ranges"), "bytes", range);
		assert.equal(answer.headers.get("Content-Type"), "text/plain; charset=utf-8", range);
		assert.equal(await answer.text(), LOG.slice(start, end + 1), range);
	}
	for (const range of ["bytes=17-", "bytes=100-200", "bytes=-0"]) {
		const answer = await get(range);
		assert.equal(answer.status, 416, range);
		assert.equal(answer.headers.get("Content-Range"), `bytes */${size}`, range);
	}
	// multi-range, or a range this Worker does not parse: the whole body, 200
	for (const range of ["bytes=0-1, 4-5", "bytes=5-2", "items=0-1", "bytes=abc"]) {
		const answer = await get(range);
		assert.equal(answer.status, 200, range);
		assert.equal(await answer.text(), LOG, range);
	}
	// If-Range: the ETag it names still current -> the range; anything else (another ETag, a weak one, a date) -> 200
	const same = await get("bytes=2-5", { "If-Range": shaOf(LOG) });
	assert.equal(same.status, 206);
	assert.equal(await same.text(), LOG.slice(2, 6));
	for (const ifRange of [shaOf("an older version"), `W/${shaOf(LOG)}`, "Tue, 27 Oct 2026 10:00:00 GMT"]) {
		const answer = await get("bytes=2-5", { "If-Range": ifRange });
		assert.equal(answer.status, 200, ifRange);
		assert.equal(await answer.text(), LOG, ifRange);
	}
	// ETag and If-None-Match keep working, with or without a Range
	assert.equal((await get(null, { "If-None-Match": shaOf(LOG) })).status, 304);
	assert.equal((await get("bytes=2-5", { "If-None-Match": shaOf(LOG) })).status, 304);
	// HEAD with a Range: the 206's headers and no body, and no file bytes read
	s3.calls.length = 0;
	const head = await get("bytes=2-5", {}, "HEAD");
	assert.equal(head.status, 206);
	assert.equal(head.headers.get("Content-Range"), `bytes 2-5/${size}`);
	assert.equal(head.headers.get("Content-Length"), "4");
	assert.equal(await head.text(), "");
	assert.ok(!s3.calls.some((c) => c.key.endsWith("logs/run.log")), `HEAD read the file: ${JSON.stringify(s3.calls.map((c) => c.key))}`);
	const head416 = await get("bytes=99-", {}, "HEAD");
	assert.equal(head416.status, 416);
	// signed out, another person: the same 401 / 404 as without a Range
	assert.equal((await call(handle, env(), deps, fileUrl("logs/run.log"), { headers: { Range: "bytes=0-3" } })).status, 401);
	assert.equal((await call(handle, env(), deps, `${fileUrl("logs/run.log")}?owner=${OWNER.userId}`, { headers: { ...cookie("tok-sister-browser"), Range: "bytes=0-3" } })).status, 404);
});

test("a large video: a seek reads only the asked-for bytes from storage, never the whole object", async () => {
	const s3 = media();
	const { deps } = fakeDeps(s3);
	const key = `users/${OWNER.userId}/robotparts/hosts/${MACHINE}/media/big.mp4`;
	const whole = s3.objects.get(key)!;
	s3.calls.length = 0;
	const answer = await call(handle, env(), deps, fileUrl("media/big.mp4"), { headers: { ...cookie("tok-owner-browser"), Range: "bytes=1048576-1049599" } });
	assert.equal(answer.status, 206);
	assert.equal(answer.headers.get("Content-Type"), "video/mp4");
	assert.equal(answer.headers.get("Content-Range"), `bytes 1048576-1049599/${BIG}`);
	const got = new Uint8Array(await answer.arrayBuffer());
	assert.deepEqual(got, whole.slice(1048576, 1049600));
	const reads = s3.calls.filter((c) => c.key === key);
	assert.deepEqual(reads.map((c) => ({ method: c.method, range: c.range, sent: c.sent })), [{ method: "GET", range: "bytes=1048576-1049599", sent: 1024 }], "the reader was asked for exactly that range");
	// Chrome's first request for a <video>: bytes=0-, answered 206 and streamed from storage as a range too
	s3.calls.length = 0;
	const first = await call(handle, env(), deps, fileUrl("media/big.mp4"), { headers: { ...cookie("tok-owner-browser"), Range: "bytes=0-" } });
	assert.equal(first.status, 206);
	assert.equal(first.headers.get("Content-Range"), `bytes 0-${BIG - 1}/${BIG}`);
	assert.equal(first.headers.get("Content-Length"), String(BIG));
	const reader = first.body!.getReader();
	const chunk = await reader.read();
	assert.ok(chunk.value && chunk.value.byteLength > 0);
	await reader.cancel();
	assert.deepEqual(s3.calls.filter((c) => c.key === key).map((c) => c.range), [`bytes=0-${BIG - 1}`]);
});

test("a range whose stored object no longer matches the manifest's size is a 404, never another version's bytes", async () => {
	const s3 = media();
	const { deps } = fakeDeps(s3);
	s3.put(`users/${OWNER.userId}/robotparts/hosts/${MACHINE}/logs/run.log`, "a newer, longer log line that the manifest has not caught up with\n");
	const answer = await call(handle, env(), deps, fileUrl("logs/run.log"), { headers: { ...cookie("tok-owner-browser"), Range: "bytes=0-3" } });
	assert.equal(answer.status, 404);
});

// ------------------------------------------------------------------------------------------------ mutations

type Edit = { marker: string; replacement: string };

/** Imports copies of app.ts and devices.ts with devices.ts's marked lines changed; always removes the copies. */
async function withMutant<T>(edits: Edit[], run: (m: { handle: Handle }) => Promise<T>): Promise<T> {
	const dir = new URL("../src/", import.meta.url);
	const tag = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	const written: string[] = [];
	const read = (name: string) => readFileSync(fileURLToPath(new URL(name, dir)), "utf-8");
	const copy = (name: string, text: string) => {
		const path = fileURLToPath(new URL(`.mutant-${tag}-${name}`, dir));
		writeFileSync(path, text);
		written.push(path);
		return path;
	};
	try {
		let devices = read("devices.ts");
		for (const edit of edits) {
			assert.ok(devices.includes(edit.marker), `the marker moved in devices.ts: ${edit.marker}`);
			devices = devices.replace(edit.marker, edit.replacement);
		}
		copy("devices.ts", devices);
		const app = read("app.ts").replace('from "./devices.ts"', `from "./.mutant-${tag}-devices.ts"`);
		const loaded = (await import(pathToFileURL(copy("app.ts", app)).href)) as { handle: Handle };
		return await run(loaded);
	} finally {
		for (const path of written) unlinkSync(path);
	}
}

/** A revoke that trusts the live layer alone (here a stand-in whose delete does not check the owner). */
function looseDeps() {
	const made = fakeDeps(new MemoryS3(ENDPOINT, BUCKET));
	made.deps.revokeSession = async (_userId, id) => {
		for (const [token, row] of made.live) if (row.id === id) return made.live.delete(token);
		return false;
	};
	return made;
}

test("mutation: without the route's own owner check, one person revokes another's machine (red)", async () => {
	const edits = [{ marker: "if (!(await deps.sessions!(owner)).some((row) => row.id === id)) return null; // fs-mutation: only the owner revokes", replacement: "" }];
	const { deps } = looseDeps();
	const sound = await call(handle, env(), deps, "/fs/v1/devices/revoke", revoke(page("tok-owner-browser", OWNER.userId), "sess-sister-laptop"));
	assert.equal(sound.status, 404, "the real route refuses it even over a loose live layer");
	await withMutant(edits, async (m) => {
		const { deps: loose, live } = looseDeps();
		const answer = await call(m.handle, env(), loose, "/fs/v1/devices/revoke", revoke(page("tok-owner-browser", OWNER.userId), "sess-sister-laptop"));
		assert.equal(answer.status, 200, "the mutant revoked another person's device");
		assert.ok(!live.has("token-sister-laptop"));
	});
});

test("mutation: without the form's Origin check, a foreign page's form revokes a device (red)", async () => {
	const edits = [{ marker: "return !!origin && origin === new URL(request.url).origin && !!app && app.origins.includes(origin); // fs-mutation: the form's origin", replacement: "return true;" }];
	await withMutant(edits, async (m) => {
		const { deps, live } = fakeDeps(new MemoryS3(ENDPOINT, BUCKET));
		const answer = await call(m.handle, env(), deps, "/fs/account/revoke", form("tok-owner-browser", { id: "sess-owner-laptop", user: OWNER.userId }, "https://evil.example"));
		assert.equal(answer.status, 303, "the mutant took a foreign form");
		assert.ok(!live.has("token-owner-laptop"));
	});
});
