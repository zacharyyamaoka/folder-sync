// The accounts Worker on bare Node (node --test accounts/test/worker.test.ts; no npm modules, no network, no ports).
//
// What must hold (PEP 0003 §3.3-3.4):
// - the boundary between people: a machine's storage keys cover exactly users/<its person's id>/ (with the trailing
//   slash), only a bearer session gets them, the root is always the session's (never a URL's, body's or header's), a
//   private folder is 404 to another person and 401 signed out, a public one is readable signed out;
// - CSRF: a cookie-authenticated write needs X-Folder-Sync: 1 and its own origin;
// - the web host writes as a folder-sync round does: _trash/ first, the file, then the manifest with If-Match, and
//   starts over from a fresh read on 412.
// The mutations at the bottom prove those tests go red when the line that holds them is broken.
//
// The accounts layer is a stand-in (`fakeDeps`): Better Auth itself is exercised end to end by test/proof.mjs.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appFor, apps } from "../src/apps.ts";
import { handle, rawPath, returnPath, segments, type Deps, type Env, type Person } from "../src/app.ts";
import { claimsOf, mint, ttlOf, userRoot } from "../src/creds.ts";
import { signUpAllowed } from "../src/signup.ts";
import { Measuring, quotaOf, usageOf } from "../src/quota.ts";
import { checkWebPath, deleteWebFile, memoryJournal, settle, stamp, writeWebFile } from "../src/webhost.ts";
import { S3Bucket } from "../src/s3-bucket.ts";
import { MemoryS3 } from "./memory-s3.ts";
import { MemoryStore } from "./memory-store.ts";
import { d1Store, type D1Like } from "../src/store.ts";

const SITE = "https://robotparts.dev";
const OWN = "https://accounts.example.test";
const ENDPOINT = "https://acct0123.r2.cloudflarestorage.com";
const BUCKET = "folder-sync";
const MACHINE = "b55e9683-7854-4121-a56a-9bae7c3ab1da";
const SISTER_MACHINE = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const WEB = "3f1c2a9e-5b7d-4c11-8e2f-0a1b2c3d4e5f";
// WHY these two ids: the sister's starts with the owner's, so only the trailing slash of a root keeps them apart
const OWNER: Person = { userId: "ownerABC123", email: "owner@example.com", name: "Owner", image: null, sessionId: "sess-owner-browser", sessionToken: "tok-owner-browser" };
const SISTER: Person = { userId: "ownerABC1234", email: "sister@example.com", name: "Sister", image: null, sessionId: "sess-sister-browser", sessionToken: "tok-sister-browser" };

type Handle = typeof handle;

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

function manifest(project: string, host: string, name: string, files: Record<string, string>) {
	return {
		schema: "folder-sync-manifest/1",
		project,
		host_id: host,
		host_name: name,
		seq: 3,
		generated_at: "2026-10-26T12:00:00Z",
		files: Object.entries(files).map(([path, text]) => ({
			path,
			size: Buffer.byteLength(text),
			mtime: "2026-10-26T11:00:00Z",
			sha256: createHash("sha256").update(text).digest("hex"),
			written_at: "2026-10-26T12:00:00Z",
		})),
	};
}

/** Two people's folders in one bucket, each under their own root: the owner's private robotparts and public pub,
 *  the sister's robotparts. */
function people(): MemoryS3 {
	const s3 = new MemoryS3(ENDPOINT, BUCKET);
	const folders: [Person, string, string, string, Record<string, string>][] = [
		[OWNER, "robotparts", MACHINE, "ws", { "saved/a.json": '{"who": "owner", "part": "M3"}\n', "cad/bracket.step": "ISO-10303-21;\n" }],
		[OWNER, "pub", MACHINE, "ws", { "index.md": "# the owner's public notes\n" }],
		[SISTER, "robotparts", SISTER_MACHINE, "sister-laptop", { "saved/a.json": '{"who": "sister", "part": "608"}\n' }],
	];
	for (const [person, project, host, name, files] of folders) {
		const base = `users/${person.userId}/${project}/hosts/${host}/`;
		s3.put(`${base}manifest.json`, JSON.stringify(manifest(project, host, name, files)));
		for (const [path, text] of Object.entries(files)) s3.put(`${base}${path}`, text);
	}
	s3.put(`users/${OWNER.userId}/_trash/robotparts/${MACHINE}/20261020T000000Z/saved/a.json`, '{"trashed": true}\n');
	return s3;
}

function fakeDeps(s3: MemoryS3, store = new MemoryStore(), extra: Partial<Deps> = {}) {
	const browsers = new Map<string, Person>([[OWNER.sessionId, OWNER], [SISTER.sessionId, SISTER]]);
	const machines = new Map<string, Person>([
		["token-owner-laptop", { ...OWNER, sessionId: "sess-owner-laptop", sessionToken: "token-owner-laptop" }],
		["token-sister-laptop", { ...SISTER, sessionId: "sess-sister-laptop", sessionToken: "token-sister-laptop" }],
	]);
	const authCalls: string[] = [];
	store.rows.set(`${OWNER.userId}\u0000pub`, { owner_id: OWNER.userId, project: "pub", visibility: "public", updated_at: "2026-10-26T00:00:00Z" });
	let ids = 0;
	const deps: Deps = {
		async auth(request) {
			authCalls.push(new URL(request.url).pathname);
			return new Response("{}", { headers: { "Content-Type": "application/json" } });
		},
		async person(request, via) {
			if (via === "bearer") return machines.get((request.headers.get("Authorization") || "").replace(/^bearer\s+/i, "")) ?? null;
			const id = /(?:^|;\s*)s=([^;]+)/.exec(request.headers.get("Cookie") || "")?.[1];
			return id ? (browsers.get(id) ?? null) : null;
		},
		async signOut(_request, via, _app, person) {
			if (via === "bearer") machines.delete(person.sessionToken);
			else browsers.delete(person.sessionId);
			return via === "cookie" ? ["s=; Path=/; Max-Age=0"] : [];
		},
		store,
		s3: s3.fetch,
		now: () => Date.parse("2026-10-26T12:34:56Z"),
		uuid: () => (ids++ === 0 ? WEB : `3f1c2a9e-5b7d-4c11-8e2f-${String(ids).padStart(12, "0")}`),
		...extra,
	};
	return { deps, authCalls, store };
}

function call(h: Handle, e: Env, deps: Deps | null, path: string, init: RequestInit & { origin?: string } = {}): Promise<Response> {
	const origin = init.origin ?? SITE;
	return h(new Request(`${origin}${path}`, init), e, deps);
}

const cookie = (who: Person) => ({ Cookie: `s=${who.sessionId}` });
/** A write from the app's own page: its cookie, its Origin, the CSRF header and the user it shows. */
const page = (who: Person, extra: Record<string, string> = {}) => ({ ...cookie(who), Origin: SITE, "X-Folder-Sync": "1", "X-Folder-Sync-User": who.userId, ...extra });

// ------------------------------------------------------------------------------------------------ the boundary

/** The boundary between people, as a list of what went wrong (empty: it holds). Mutations run it on mutants. */
async function boundary(h: Handle): Promise<string[]> {
	const failures: string[] = [];
	// WHY every call caught: a mutant may throw on one route; the failures of the others must still be counted
	const go = (...args: Parameters<typeof call>) => call(...args).catch((e) => new Response(`threw: ${e}`, { status: 599 }));
	const e = env();
	const s3 = people();
	const { deps } = fakeDeps(s3);
	// 1. each machine's keys, then a direct probe of the other person's files with them; the root is the session's
	for (const [token, mine, theirs] of [["token-owner-laptop", OWNER, SISTER], ["token-sister-laptop", SISTER, OWNER]] as const) {
		const answer = await go(h, e, deps, `/fs/v1/credentials?root=${encodeURIComponent(userRoot(theirs.userId))}&owner=${theirs.userId}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "X-Folder-Sync-Root": userRoot(theirs.userId) },
			body: JSON.stringify({ root: userRoot(theirs.userId), Prefix: userRoot(theirs.userId) }),
		});
		if (answer.status !== 200) { failures.push(`${token}: credentials ${answer.status}`); continue; }
		const body = await answer.json();
		const prefixes = (claimsOf(body.SessionToken).paths as { prefixPaths?: string[] } | undefined)?.prefixPaths;
		if (JSON.stringify(prefixes) !== JSON.stringify([`users/${mine.userId}/`])) failures.push(`${token}: prefixPaths ${JSON.stringify(prefixes)}`);
		if (body.Prefix !== `users/${mine.userId}/`) failures.push(`${token}: Prefix ${body.Prefix}`);
		const host = theirs === SISTER ? SISTER_MACHINE : MACHINE;
		for (const key of [`users/${theirs.userId}/robotparts/hosts/${host}/manifest.json`, `users/${theirs.userId}/robotparts/hosts/${host}/saved/a.json`]) {
			const probe = await s3.fetch(new Request(`${ENDPOINT}/${BUCKET}/${key}`, { headers: { "X-Amz-Security-Token": body.SessionToken } }));
			if (probe.status !== 403) failures.push(`${token} read ${key}: ${probe.status}`);
		}
		const list = await s3.fetch(new Request(`${ENDPOINT}/${BUCKET}?list-type=2&prefix=${encodeURIComponent(`users/${theirs.userId}/`)}&delimiter=%2F`, { headers: { "X-Amz-Security-Token": body.SessionToken } }));
		if (list.status !== 403) failures.push(`${token} listed the other root: ${list.status}`);
	}
	// 2. a browser's cookie never gets storage keys, whatever it sends along
	for (const headers of [cookie(OWNER), page(OWNER)]) {
		const answer = await go(h, e, deps, "/fs/v1/credentials", { method: "POST", headers });
		if (answer.status !== 401) failures.push(`credentials with a browser cookie: ${answer.status}`);
	}
	if ((await go(h, e, deps, "/fs/v1/credentials", { method: "POST" })).status !== 401) failures.push("credentials with no session: not 401");
	// 3. reads: each person's own folder, never the other's private one (404 signed in, 401 signed out)
	for (const [who, other, word] of [[OWNER, SISTER, "sister"], [SISTER, OWNER, "owner"]] as const) {
		const own = await go(h, e, deps, "/fs/v1/folders/robotparts/bundle?prefix=saved/", { headers: cookie(who) });
		const ownText = await own.text();
		if (own.status !== 200 || ownText.includes(`\\"who\\": \\"${word}\\"`)) failures.push(`${who.email}'s own bundle: ${own.status} ${ownText.slice(0, 80)}`);
		for (const path of [`/fs/v1/folders/robotparts?owner=${other.userId}`, `/fs/v1/folders/robotparts/bundle?prefix=saved/&owner=${other.userId}`,
			`/fs/v1/folders/robotparts/files/${other === SISTER ? SISTER_MACHINE : MACHINE}/saved/a.json?owner=${other.userId}`]) {
			const crossed = await go(h, e, deps, path, { headers: cookie(who) });
			const text = await crossed.text();
			if (crossed.status !== 404 || text.includes(`"who": "${word}"`) || text.includes(`\\"who\\": \\"${word}\\"`)) failures.push(`${who.email} read the other's ${path.split("?")[0]}: ${crossed.status} ${text.slice(0, 80)}`);
			const anon = await go(h, e, deps, path);
			if (anon.status !== 401) failures.push(`signed out ${path.split("?")[0]} of a private folder: ${anon.status}`);
		}
		const access = await go(h, e, deps, `/fs/v1/access?project=robotparts&owner=${other.userId}`, { headers: cookie(who) });
		const accessBody = access.status === 200 ? await access.json() : null;
		if (accessBody?.allowed !== false) failures.push(`${who.email} access to the other's robotparts: ${JSON.stringify(accessBody)}`);
	}
	// 4. public: readable signed out, and only that folder
	const pub = await go(h, e, deps, `/fs/v1/folders/pub/files/${MACHINE}/index.md?owner=${OWNER.userId}`);
	if (pub.status !== 200 || !(await pub.text()).includes("public notes")) failures.push(`signed out, the public folder's file: ${pub.status}`);
	else if (pub.headers.get("Cache-Control") !== "public, max-age=60") failures.push(`public file Cache-Control ${pub.headers.get("Cache-Control")}`);
	const pubView = await go(h, e, deps, `/fs/v1/folders/pub?owner=${OWNER.userId}`);
	if (pubView.status !== 200) failures.push(`signed out, the public folder's view: ${pubView.status}`);
	const readScopes = s3.calls.filter((c) => c.allowed && c.scope === "object-read-only" && c.scoped?.[0]?.includes("/pub/"));
	if (!readScopes.length || readScopes.some((c) => c.scoped?.[0] !== `users/${OWNER.userId}/pub/`)) failures.push(`a public read was not signed for users/<owner>/pub/ only: ${JSON.stringify(readScopes.map((c) => c.scoped))}`);
	// 5. writes: the web host lands in the session's root only, and a cookie write needs the CSRF header
	const put = await go(h, e, deps, `/fs/v1/folders/robotparts/web/saved/b.json?owner=${SISTER.userId}&root=${encodeURIComponent(userRoot(SISTER.userId))}`, {
		method: "PUT", headers: page(OWNER, { "X-Folder-Sync-Root": userRoot(SISTER.userId) }), body: '{"from": "the owner\'s page"}\n',
	});
	if (put.status !== 200) failures.push(`the owner's web PUT: ${put.status} ${await put.text()}`);
	const planted = [...s3.objects.keys()].filter((k) => k.startsWith(`users/${SISTER.userId}/`) && k.includes("saved/b.json"));
	if (planted.length) failures.push(`the owner's web PUT wrote into the sister's root: ${planted.join(", ")}`);
	if (![...s3.objects.keys()].some((k) => k.startsWith(`users/${OWNER.userId}/robotparts/hosts/${WEB}/saved/b.json`))) failures.push("the owner's web PUT is not in the owner's web host");
	for (const [what, headers] of [
		// each lacks only what it names (X-Folder-Sync-User is the page's own: review r1 #2)
		["no X-Folder-Sync", { ...cookie(OWNER), Origin: SITE, "X-Folder-Sync-User": OWNER.userId }],
		["another site's Origin", { ...cookie(OWNER), Origin: "https://evil.example", "X-Folder-Sync": "1", "X-Folder-Sync-User": OWNER.userId }],
		["no Origin", { ...cookie(OWNER), "X-Folder-Sync": "1", "X-Folder-Sync-User": OWNER.userId }],
	] as const) {
		const before = s3.objects.size;
		const answer = await go(h, e, deps, "/fs/v1/folders/robotparts/web/saved/csrf.json", { method: "PUT", headers, body: "{}" });
		if (answer.status !== 403 || s3.objects.size !== before) failures.push(`a cookie PUT with ${what}: ${answer.status}`);
		const patch = await go(h, e, deps, "/fs/v1/folders/robotparts", { method: "PATCH", headers: { ...headers, "Content-Type": "application/json" }, body: '{"visibility":"public"}' });
		if (patch.status !== 403) failures.push(`a cookie PATCH with ${what}: ${patch.status}`);
	}
	return failures;
}

test("two people: keys, reads, public folders and the web host cover exactly what each session may", async () => {
	assert.deepEqual(await boundary(handle), []);
});

test("a root is users/<id>/ for a well-formed id only, always with its trailing slash", async () => {
	assert.equal(userRoot("ownerABC123"), "users/ownerABC123/");
	for (const bad of ["", "short", "../../x", "a/b/cdefgh", "ownerABC123/", "ownerABC123\n", "x".repeat(65)]) assert.throws(() => userRoot(bad), bad);
	await assert.rejects(mint(env(), "users/ownerABC123", "object-read-only", 60, 0), /one person's root or folder/);
	await assert.rejects(mint(env(), "users/", "object-read-only", 60, 0));
	await assert.rejects(mint(env(), "users/ownerABC123/../x/", "object-read-only", 60, 0));
	const minted = await mint(env(), "users/ownerABC123/robotparts/", "object-read-only", 60, Date.parse("2026-10-26T00:00:00Z"));
	assert.deepEqual((claimsOf(minted.SessionToken).paths as { prefixPaths: string[] }).prefixPaths, ["users/ownerABC123/robotparts/"]);
	assert.equal(minted.Expiration, "2026-10-26T00:01:00.000Z");
	assert.equal(ttlOf({}), 300, "5 minutes by default since review r1 #7 (it was 15)");
	assert.equal(ttlOf({ SYNC_CREDENTIAL_TTL_S: "5" }), 30);
	assert.equal(ttlOf({ SYNC_CREDENTIAL_TTL_S: "99999" }), 3600);
});

test("me: the session's person and root, and the app the origin belongs to", async () => {
	const { deps } = fakeDeps(people());
	const onApp = await (await call(handle, env(), deps, "/fs/v1/me", { headers: cookie(OWNER) })).json();
	assert.deepEqual(onApp, { user: { id: OWNER.userId, email: OWNER.email, name: "Owner", image: null }, root: "users/ownerABC123/", app: { id: "robotparts", project: "robotparts" } });
	const own = await (await call(handle, env(), deps, "/fs/v1/me", { origin: OWN, headers: { Authorization: "Bearer token-owner-laptop" } })).json();
	assert.equal(own.app, null, "the Worker's own host is not an app");
	assert.equal((await call(handle, env(), deps, "/fs/v1/me")).status, 401);
	const bad = await call(handle, env(), deps, "/fs/v1/me", { headers: { Authorization: "Bearer nope", ...cookie(OWNER) } });
	assert.equal(bad.status, 401, "a bearer that fails is not rescued by a cookie");
	const body = await bad.json();
	assert.equal(body.error, "signed_out");
	assert.equal(typeof body.why, "string");
});

test("an origin no app lists: no sign-in, no pages, no cookie, no CORS; a bearer still works", async () => {
	const { deps, authCalls } = fakeDeps(people());
	const stranger = "https://elsewhere.example";
	assert.equal((await call(handle, env(), deps, "/fs/api/auth/get-session", { origin: stranger })).status, 404);
	assert.equal((await call(handle, env(), deps, "/fs/signin", { origin: stranger })).status, 404);
	assert.equal((await call(handle, env(), deps, "/fs/v1/me", { origin: stranger, headers: cookie(OWNER) })).status, 401);
	assert.equal((await call(handle, env(), deps, "/fs/v1/me", { origin: stranger, headers: { Authorization: "Bearer token-owner-laptop" } })).status, 200);
	assert.deepEqual(authCalls, []);
	const preflight = await call(handle, env(), deps, "/fs/v1/me", { method: "OPTIONS", headers: { Origin: stranger } });
	assert.equal(preflight.status, 403);
	assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), null);
	const listed = await call(handle, env(), deps, "/fs/v1/me", { origin: OWN, method: "OPTIONS", headers: { Origin: SITE } });
	assert.equal(listed.status, 204);
	assert.equal(listed.headers.get("Access-Control-Allow-Origin"), SITE);
	assert.match(listed.headers.get("Access-Control-Allow-Headers") || "", /X-Folder-Sync/);
	await call(handle, env(), deps, "/fs/api/auth/get-session");
	assert.deepEqual(authCalls, ["/fs/api/auth/get-session"]);
});

test("the registry: apps.json's origins, plus PUBLIC_URL's for the Worker's own host", () => {
	const registered = apps("http://127.0.0.1:4932/");
	assert.equal(appFor("https://robotparts.dev", registered)?.id, "robotparts");
	assert.equal(appFor("https://www.robotparts.dev", registered)?.id, "robotparts");
	assert.equal(appFor("http://127.0.0.1:4933", registered)?.id, "robotparts");
	assert.equal(appFor("http://localhost:4933", registered)?.project, "robotparts");
	assert.equal(appFor("http://127.0.0.1:4932", registered)?.id, "folder-sync");
	assert.equal(appFor("https://robotparts.dev.evil.example", registered), null);
	assert.equal(appFor("http://robotparts.dev", registered), null, "the scheme is part of the origin");
	assert.equal(appFor(null, registered), null);
});

test("the registry: a plain-http (loopback, dev) origin counts only when ENVIRONMENT=dev", async () => {
	// WHY: apps.json lists robotparts' local demo origins beside its real ones; production must not treat a page on
	// someone's 127.0.0.1:4933 as robotparts.dev (sign-in, cookie routes, CORS)
	const production = apps("https://accounts.example.test", undefined, false);
	assert.equal(appFor("https://robotparts.dev", production)?.id, "robotparts");
	assert.equal(appFor("http://127.0.0.1:4933", production), null);
	assert.equal(appFor("http://localhost:4933", production), null);
	const dev = apps("http://127.0.0.1:4932/", undefined, true);
	assert.equal(appFor("http://127.0.0.1:4933", dev)?.id, "robotparts");
	const { deps, authCalls } = fakeDeps(people());
	const loop = "http://127.0.0.1:4933";
	assert.equal((await call(handle, env({ ENVIRONMENT: "production" }), deps, "/fs/signin", { origin: loop })).status, 404, "no sign-in page for a loopback origin in production");
	assert.equal((await call(handle, env({ ENVIRONMENT: "production" }), deps, "/fs/v1/me", { origin: loop, headers: cookie(OWNER) })).status, 401, "no cookie session for a loopback origin in production");
	assert.deepEqual(authCalls, []);
});

test("folders: my folders with their hosts and visibility, and the ones shared with me", async () => {
	const s3 = people();
	const { deps } = fakeDeps(s3);
	const mine = await (await call(handle, env(), deps, "/fs/v1/folders", { headers: cookie(OWNER) })).json();
	assert.deepEqual(mine.folders, [{ project: "pub", visibility: "public", hosts: [MACHINE] }, { project: "robotparts", visibility: "private", hosts: [MACHINE] }]);
	assert.deepEqual(mine.readable, []);
	const granted = await call(handle, env(), deps, "/fs/v1/folders/robotparts/readers", { method: "POST", headers: page(OWNER, { "Content-Type": "application/json" }), body: JSON.stringify({ email: "Sister@Example.com" }) });
	assert.equal(granted.status, 200);
	assert.deepEqual(await granted.json(), { project: "robotparts", readers: ["sister@example.com"] });
	const hers = await (await call(handle, env(), deps, "/fs/v1/folders", { headers: cookie(SISTER) })).json();
	assert.deepEqual(hers.readable, [{ owner: OWNER.userId, project: "robotparts", role: "reader" }]);
	const view = await call(handle, env(), deps, `/fs/v1/folders/robotparts?owner=${OWNER.userId}`, { headers: cookie(SISTER) });
	assert.equal(view.status, 200);
	const body = await view.json();
	assert.equal(body.owner, OWNER.userId);
	assert.equal(body.visibility, "private");
	assert.deepEqual(body.hosts, [{ id: MACHINE, name: "ws", seq: 3, generatedAt: "2026-10-26T12:00:00Z", web: false }]);
	assert.deepEqual(body.files.map((f: { path: string }) => f.path).sort(), ["cad/bracket.step", "saved/a.json"]);
	assert.deepEqual(Object.keys(body.files[0]).sort(), ["host", "mtime", "path", "sha256", "size", "writtenAt"]);
	assert.equal(view.headers.get("Cache-Control"), "private, no-store");
	assert.equal((await (await call(handle, env(), deps, `/fs/v1/access?project=robotparts&owner=${OWNER.userId}`, { headers: cookie(SISTER) })).json()).role, "reader");
	const revoked = await call(handle, env(), deps, `/fs/v1/folders/robotparts/readers/${encodeURIComponent("sister@example.com")}`, { method: "DELETE", headers: page(OWNER) });
	assert.equal(revoked.status, 200);
	assert.equal((await call(handle, env(), deps, `/fs/v1/folders/robotparts?owner=${OWNER.userId}`, { headers: cookie(SISTER) })).status, 404);
	assert.ok(s3.calls.every((c) => !c.key.includes("_trash/")), "a trashed version was read");
});

test("files and bundle: exact manifest entries, sha256 ETag, sandboxed active types, the bundle's limits", async () => {
	const s3 = people();
	const big = "x".repeat(256 * 1024 + 1);
	const base = `users/${OWNER.userId}/robotparts/hosts/${MACHINE}/`;
	const files: Record<string, string> = { "saved/a.json": '{"who": "owner"}\n', "saved/big.txt": big, "saved/page.html": "<script>1</script>\n", "saved/bin.dat": "ÿ" };
	s3.put(`${base}manifest.json`, JSON.stringify(manifest("robotparts", MACHINE, "ws", files)));
	for (const [path, text] of Object.entries(files)) s3.put(`${base}${path}`, text);
	s3.put(`${base}saved/bin.dat`, new Uint8Array([0xff, 0xfe]));
	const m = JSON.parse(s3.text(`${base}manifest.json`)!);
	m.files.find((f: { path: string }) => f.path === "saved/bin.dat").sha256 = createHash("sha256").update(new Uint8Array([0xff, 0xfe])).digest("hex");
	m.files.find((f: { path: string }) => f.path === "saved/bin.dat").size = 2;
	s3.put(`${base}manifest.json`, JSON.stringify(m));
	s3.put(`${base}saved/unlisted.json`, "{}");
	const { deps } = fakeDeps(s3);
	const bundle = await (await call(handle, env(), deps, "/fs/v1/folders/robotparts/bundle?prefix=saved/", { headers: cookie(OWNER) })).json();
	assert.deepEqual(bundle.files.map((f: { path: string }) => f.path).sort(), ["saved/a.json", "saved/page.html"], "over 256 KB and non-UTF-8 left out");
	assert.deepEqual(Object.keys(bundle.files[0]).sort(), ["host", "mtime", "path", "sha256", "text"]);
	assert.equal((await call(handle, env(), deps, "/fs/v1/folders/robotparts/bundle?prefix=../x", { headers: cookie(OWNER) })).status, 400);
	const one = await call(handle, env(), deps, `/fs/v1/folders/robotparts/files/${MACHINE}/saved/a.json`, { headers: cookie(OWNER) });
	assert.equal(one.status, 200);
	assert.equal(one.headers.get("ETag"), `"${createHash("sha256").update('{"who": "owner"}\n').digest("hex")}"`);
	assert.equal(one.headers.get("Content-Type"), "application/json; charset=utf-8");
	const again = await call(handle, env(), deps, `/fs/v1/folders/robotparts/files/${MACHINE}/saved/a.json`, { headers: { ...cookie(OWNER), "If-None-Match": one.headers.get("ETag")! } });
	assert.equal(again.status, 304);
	const active = await call(handle, env(), deps, `/fs/v1/folders/robotparts/files/${MACHINE}/saved/page.html`, { headers: cookie(OWNER) });
	assert.equal(active.headers.get("Content-Security-Policy"), "sandbox");
	assert.equal((await call(handle, env(), deps, `/fs/v1/folders/robotparts/files/${MACHINE}/saved/unlisted.json`, { headers: cookie(OWNER) })).status, 404, "never an object no manifest lists");
	// WHY not 400: the URL parser (WHATWG, as on Workers) already resolved %2e%2e before the Worker sees it; what
	// matters is that nothing outside the folder is reached
	const climbed = await call(handle, env(), deps, `/fs/v1/folders/robotparts/files/${MACHINE}/saved/%2e%2e/%2e%2e/%2e%2e/%2e%2e/_trash/robotparts/${MACHINE}/20261020T000000Z/saved/a.json`, { headers: cookie(OWNER) });
	assert.ok(climbed.status >= 400 && !(await climbed.text()).includes("trashed"), `a climb reached ${climbed.status}`);
	for (const path of [`/fs/v1/folders/robotparts/files/${MACHINE}/saved%2Fa.json`, `/fs/v1/folders/robotparts/files/${MACHINE}/saved%5Ca.json`, "/fs/v1/folders/robotparts/files/not-a-host/a.json", "/fs/v1/folders/Robot Parts", "/fs/v1/folders/_trash"]) {
		assert.equal((await call(handle, env(), deps, path, { headers: cookie(OWNER) })).status, 400, path);
	}
});

test("the web host: trash first, the file, the manifest with If-Match; a 412 starts over from a fresh read", async () => {
	const s3 = people();
	const { deps, store } = fakeDeps(s3);
	const root = `users/${OWNER.userId}/`;
	const at = (path: string) => `${root}robotparts/hosts/${WEB}/${path}`;
	const put = (path: string, body: string) => call(handle, env(), deps, `/fs/v1/folders/robotparts/web/${path}`, { method: "PUT", headers: page(OWNER), body });
	const first = await (await put("saved/x.json", "one\n")).json();
	assert.deepEqual(first, { host: WEB, path: "saved/x.json", sha256: createHash("sha256").update("one\n").digest("hex"), seq: 1 });
	assert.equal(await store.webHost(OWNER.userId, "robotparts"), WEB);
	const m1 = JSON.parse(s3.text(at("manifest.json"))!);
	assert.equal(m1.schema, "folder-sync-manifest/1");
	assert.equal(m1.host_name, "web");
	assert.equal(m1.host_id, WEB);
	assert.equal(m1.project, "robotparts");
	assert.deepEqual(m1.files.map((f: { path: string }) => f.path), ["saved/x.json"]);
	const writes = s3.calls.filter((c) => c.method !== "GET" && c.method !== "LIST").map((c) => `${c.method} ${c.key.slice(root.length)}`);
	assert.deepEqual(writes, [`PUT robotparts/hosts/${WEB}/saved/x.json`, `PUT robotparts/hosts/${WEB}/manifest.json`], "the file, then the manifest");
	s3.calls.length = 0;
	// overwrite: the old version goes to _trash/ first
	const second = await (await put("saved/x.json", "two\n")).json();
	assert.equal(second.seq, 2);
	// the trash key is the contract's stamp plus the millisecond and a nonce (review r1 #8), so find it by its stamp
	const trashed = [...s3.objects.keys()].filter((k) => k.startsWith(`${root}_trash/robotparts/${WEB}/${stamp(deps.now())}-`) && k.endsWith("/saved/x.json"));
	assert.deepEqual(trashed.map((k) => s3.text(k)), ["one\n"]);
	assert.equal(s3.text(at("saved/x.json")), "two\n");
	assert.deepEqual(s3.calls.filter((c) => c.method !== "GET").map((c) => c.method), ["COPY", "PUT", "PUT"]);
	// the same bytes again: nothing written, same seq
	s3.calls.length = 0;
	assert.equal((await (await put("saved/x.json", "two\n")).json()).seq, 2);
	assert.deepEqual(s3.calls.filter((c) => c.method !== "GET"), []);
	// a concurrent writer moves the manifest between our read and our conditional PUT: 412, then a fresh read
	s3.beforeConditional = {
		key: at("manifest.json"),
		run: () => {
			const theirs = JSON.parse(s3.text(at("manifest.json"))!);
			theirs.seq += 1;
			theirs.files.push({ path: "saved/theirs.json", size: 3, mtime: "2026-10-26T12:00:00Z", sha256: createHash("sha256").update("abc").digest("hex"), written_at: "2026-10-26T12:00:00Z" });
			s3.put(at("saved/theirs.json"), "abc");
			s3.put(at("manifest.json"), JSON.stringify(theirs));
		},
	};
	const raced = await (await put("saved/y.json", "why\n")).json();
	const m4 = JSON.parse(s3.text(at("manifest.json"))!);
	assert.equal(raced.seq, 4, "their seq 3, then ours");
	assert.deepEqual(m4.files.map((f: { path: string }) => f.path), ["saved/theirs.json", "saved/x.json", "saved/y.json"], "neither write lost, sorted by path");
	// delete: to _trash/, then the manifest without it
	const gone = await call(handle, env(), deps, "/fs/v1/folders/robotparts/web/saved/x.json", { method: "DELETE", headers: page(OWNER) });
	assert.deepEqual(await gone.json(), { host: WEB, path: "saved/x.json", seq: 5 });
	assert.equal(s3.objects.has(at("saved/x.json")), false);
	assert.equal((await call(handle, env(), deps, "/fs/v1/folders/robotparts/web/saved/x.json", { method: "DELETE", headers: page(OWNER) })).status, 404);
	// path rules and case twins: 400, nothing written
	const before = s3.objects.size;
	for (const bad of ["manifest.json", "saved/CON.txt", "saved/a:b.json", "saved/trailing.", "saved/Y.json", "saved/", "saved%2Fz.json"]) {
		const answer = await put(bad, "{}");
		assert.equal(answer.status, 400, bad);
		assert.equal((await answer.json()).error, "bad_path", bad);
	}
	assert.equal(s3.objects.size, before);
	// every write was signed read-write for the owner's root, nothing wider
	assert.ok(s3.calls.filter((c) => c.method !== "GET" && c.method !== "LIST").every((c) => c.scope === "object-read-write" && JSON.stringify(c.scoped) === JSON.stringify([root])));
});

test("checkWebPath follows internal/names: relative, Windows-safe, not the root manifest.json", () => {
	for (const ok of ["a.json", "saved/x.json", "deep/er/file name.txt", "hosts/x.json", "manifest.json.bak", "sub/manifest.json"]) checkWebPath(ok);
	for (const bad of ["", "/abs", "a//b", "a/./b", "a/../b", "a\\b", "C:x", "nul", "LPT1.txt", "com¹", "a?b", "a*b", "a\u0001b", "dot.", "space ", "manifest.json", "x".repeat(901)]) {
		assert.throws(() => checkWebPath(bad), undefined, JSON.stringify(bad));
	}
	assert.equal(stamp(Date.parse("2026-10-26T12:34:56.789Z")), "20261026T123456Z");
});

test("sign-out ends the session it is sent with: a cookie (with the CSRF header) or a bearer", async () => {
	const { deps } = fakeDeps(people());
	assert.equal((await call(handle, env(), deps, "/fs/v1/sign-out", { method: "POST", headers: cookie(OWNER) })).status, 403, "a cookie sign-out needs the header too");
	const out = await call(handle, env(), deps, "/fs/v1/sign-out", { method: "POST", headers: page(OWNER) });
	assert.equal(out.status, 200);
	assert.match(out.headers.get("Set-Cookie") || "", /Max-Age=0/);
	assert.equal((await call(handle, env(), deps, "/fs/v1/me", { headers: cookie(OWNER) })).status, 401);
	assert.equal((await call(handle, env(), deps, "/fs/v1/sign-out", { origin: OWN, method: "POST", headers: { Authorization: "Bearer token-sister-laptop" } })).status, 200);
	assert.equal((await call(handle, env(), deps, "/fs/v1/credentials", { origin: OWN, method: "POST", headers: { Authorization: "Bearer token-sister-laptop" } })).status, 401);
});

test("not configured, nothing is served: no deps is 503, no parent key is 503, never a person's data", async () => {
	for (const [path, method] of [["/fs/v1/credentials", "POST"], ["/fs/v1/me", "GET"], ["/fs/api/auth/get-session", "GET"], ["/fs/v1/folders", "GET"]] as const) {
		const answer = await call(handle, env(), null, path, { method });
		assert.equal(answer.status, 503, `${method} ${path}`);
		assert.equal((await answer.json()).error, "not_configured");
	}
	const { deps } = fakeDeps(people());
	const keyless = await call(handle, env({ R2_PARENT_SECRET_ACCESS_KEY: undefined }), deps, "/fs/v1/credentials", { method: "POST", headers: { Authorization: "Bearer token-owner-laptop" } });
	assert.equal(keyless.status, 503);
	assert.equal((await call(handle, env(), deps, "/elsewhere")).status, 404);
});

test("production never offers email codes or a mailbox; dev offers both, on this machine only", async () => {
	const { deps, authCalls } = fakeDeps(people(), new MemoryStore(), { mailbox: () => "123456" });
	for (const path of ["/fs/api/auth/email-otp/send-verification-otp", "/fs/api/auth/sign-in/email-otp"]) {
		assert.equal((await call(handle, env(), deps, path, { method: "POST", body: "{}" })).status, 404, path);
	}
	assert.equal((await call(handle, env(), deps, "/fs/dev/mailbox?email=a@b.c")).status, 404);
	assert.deepEqual(authCalls, []);
	const dev = env({ ENVIRONMENT: "dev", PUBLIC_URL: "http://127.0.0.1:4932" });
	assert.equal((await call(handle, dev, deps, "/fs/dev/mailbox?email=a@b.c")).status, 404, "not from robotparts.dev");
	const local = await call(handle, dev, deps, "/fs/dev/mailbox?email=a@b.c", { origin: "http://127.0.0.1:4932" });
	assert.equal(local.status, 200);
	assert.equal((await local.json()).code, "123456");
	await call(handle, dev, deps, "/fs/api/auth/email-otp/send-verification-otp", { origin: "http://127.0.0.1:4932", method: "POST", body: "{}" });
	assert.deepEqual(authCalls, ["/fs/api/auth/email-otp/send-verification-otp"]);
});

test("the pages: sign-in and device, a strict policy, never framed, and `return` only ever a same-origin path", async () => {
	const signin = await call(handle, env(), null, "/fs/signin?return=%2Fparts%2Fm3%3Ftab%3Dcad");
	assert.equal(signin.status, 200);
	const html = await signin.text();
	assert.match(html, /<meta name="fs-signin" content="none">/, "no Google client yet: sign-in says it is not switched on");
	assert.match(html, /<meta name="fs-return" content="\/parts\/m3\?tab=cad">/);
	assert.match(html, /<meta name="fs-app" content="Robot Parts">/);
	assert.equal(signin.headers.get("X-Frame-Options"), "DENY");
	assert.doesNotMatch(signin.headers.get("Content-Security-Policy") || "", /https?:|unsafe/);
	assert.match(await (await call(handle, env({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" }), null, "/fs/signin")).text(), /content="google"/);
	assert.match(await (await call(handle, env({ ENVIRONMENT: "dev" }), null, "/fs/signin")).text(), /content="email"/);
	const device = await (await call(handle, env(), null, "/fs/device?user_code=ABCDEFGH")).text();
	assert.match(device, /\/fs\/site\/signin\.js[\s\S]*\/fs\/site\/device\.js/);
	for (const [given, want] of [["/a", "/a"], ["//evil.example/x", "/"], ["https://evil.example", "/"], ["/\\evil.example", "/"], [null, "/"], ["/a\nb", "/"]] as const) {
		assert.equal(returnPath(given), want, String(given));
	}
	const html2 = await (await call(handle, env(), null, `/fs/signin?return=${encodeURIComponent('/"><script>alert(1)</script>')}`)).text();
	assert.doesNotMatch(html2, /<script>alert/);
});

test("the path parser refuses dot segments, encoded slashes and empty segments", () => {
	assert.equal(rawPath("https://robotparts.dev/fs/v1/me?x=1"), "/fs/v1/me");
	assert.deepEqual(segments("/fs/v1/folders/a/files/h/b%20c.json"), ["fs", "v1", "folders", "a", "files", "h", "b c.json"]);
	for (const bad of ["/fs/../x", "/fs/%2e%2e/x", "/fs//x", "/fs/a%2Fb", "/fs/a%5Cb", "/fs/%00"]) assert.equal(segments(bad), null, bad);
});

test("sign-up: the list, closed when unset, '*' for anyone; Better Auth's user-create hook asks it", () => {
	assert.equal(signUpAllowed("a@b.c", undefined), false);
	assert.equal(signUpAllowed("A@B.c", "x@y.z, a@b.c"), true);
	assert.equal(signUpAllowed("anyone@x.y", "*"), true);
	assert.equal(signUpAllowed("", "*"), true);
	assert.equal(signUpAllowed(null, "a@b.c"), false);
	const auth = readFileSync(fileURLToPath(new URL("../src/auth.ts", import.meta.url)), "utf-8");
	assert.match(auth, /before: async \(user: \{ email\?: string \}\) => \{\s*if \(!signUpAllowed\(user\.email, env\.SIGN_UP_EMAILS\)\) \{\s*throw new APIError\("FORBIDDEN"/);
	assert.match(auth, /basePath: BASE_PATH/);
	assert.match(auth, /export const BASE_PATH = "\/fs\/api\/auth";/);
	assert.match(auth, /verificationUri: "\/fs\/device"/);
});

// ------------------------------------------------------------------------------------------------ mutations

type Edit = { file: "app.ts" | "creds.ts"; marker: string; replacement: string };

/** Imports a copy of app.ts (and creds.ts when an edit names it) with the marked lines changed; always removes the
 *  copies. */
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
	const mutate = (name: string) => {
		let text = read(name);
		for (const edit of edits.filter((e) => e.file === name)) {
			assert.ok(text.includes(edit.marker), `the marker moved in ${name}: ${edit.marker}`);
			text = text.replace(edit.marker, edit.replacement);
		}
		return text;
	};
	try {
		let app = mutate("app.ts");
		if (edits.some((e) => e.file === "creds.ts")) {
			copy("creds.ts", mutate("creds.ts"));
			app = app.replace('from "./creds.ts"', `from "./.mutant-${tag}-creds.ts"`);
		}
		const loaded = (await import(pathToFileURL(copy("app.ts", app)).href)) as { handle: Handle };
		return await run(loaded);
	} finally {
		for (const path of written) unlinkSync(path);
	}
}

const red = (failures: string[], pattern: RegExp, what: string) =>
	assert.ok(failures.some((f) => pattern.test(f)), `${what}: the boundary test stayed green:\n${failures.join("\n")}`);

test("mutation: a root taken from the request (?root=, ?owner=) instead of the session crosses people (red)", async () => {
	const failures = await withMutant([
		{ file: "app.ts", marker: 'const minted = await mint(env, userRoot(person.userId), "object-read-write", ttlOf(env), deps.now()); // fs-mutation: the session\'s root', replacement: 'const asked = new URL(request.url).searchParams.get("root"); const minted = await mint(env, asked || userRoot(person.userId), "object-read-write", ttlOf(env), deps.now());' },
		{ file: "app.ts", marker: "const owner = who.person.userId; // fs-mutation: the web host's root. WHY: the session's, never a URL's, a body's or a header's", replacement: 'const owner = new URL(request.url).searchParams.get("owner") || who.person.userId;' },
	], (m) => boundary(m.handle));
	red(failures, /^token-owner-laptop: prefixPaths \["users\/ownerABC1234\/"\]/, "credentials from ?root=");
	red(failures, /wrote into the sister's root/, "the web host from ?owner=");
});

test("mutation: a root without its trailing slash lets users/ownerABC123 cover users/ownerABC1234/ (red)", async () => {
	const slash = { file: "creds.ts" as const, marker: "return `users/${userId}/`;", replacement: "return `users/${userId}`;" };
	const guard = { file: "creds.ts" as const, marker: 'if (!ONE_ROOT.test(prefix) && !ONE_FOLDER.test(prefix)) throw new Error("a credential is only ever minted for one person\'s root or folder");', replacement: "" };
	// the slash dropped alone: mint's own guard still refuses to sign anything but one person's root
	await withMutant([slash], async (m) => {
		const { deps } = fakeDeps(people());
		await assert.rejects(m.handle(new Request(`${OWN}/fs/v1/credentials`, { method: "POST", headers: { Authorization: "Bearer token-owner-laptop" } }), env(), deps));
	});
	const failures = await withMutant([slash, guard], (m) => boundary(m.handle));
	red(failures, /^token-owner-laptop read users\/ownerABC1234\//, "users/<id> with no slash");
});

test("mutation: storage keys for a browser cookie, with both guards dropped (red)", async () => {
	const failures = await withMutant([
		{ file: "app.ts", marker: 'if (!/^bearer\\s+\\S/i.test(request.headers.get("Authorization") || "")) return fail(401, "signed_out", "a machine signs in with folder-sync login");', replacement: "" },
		{ file: "app.ts", marker: 'const person = await deps.person(request, "bearer", app); // fs-mutation: the bearer session', replacement: 'const person = (await deps.person(request, "bearer", app)) ?? (await deps.person(request, "cookie", app));' },
	], (m) => boundary(m.handle));
	red(failures, /^credentials with a browser cookie: 200/, "a cookie gets keys");
});

test("mutation: dropping the CSRF rule lets a cookie write without X-Folder-Sync: 1 (red)", async () => {
	const failures = await withMutant([
		{ file: "app.ts", marker: 'return request.headers.get("X-Folder-Sync") === "1" && !!app && !!origin && origin === new URL(request.url).origin && app.origins.includes(origin); // fs-mutation: the CSRF rule', replacement: "return true;" },
	], (m) => boundary(m.handle));
	red(failures, /^a cookie PUT with no X-Folder-Sync: 200/, "no CSRF header");
	red(failures, /^a cookie PUT with another site's Origin: 200/, "a foreign Origin");
});

test("mutation: a private folder that answers like a public one is readable by another person and signed out (red)", async () => {
	const failures = await withMutant([
		{ file: "app.ts", marker: 'return person ? fail(404, "not_found", "no such folder, or it is not shared with you") : fail(401, "signed_out", "sign in to read this folder"); // fs-mutation: private stays private', replacement: 'return { owner, role: "public", visibility };' },
	], (m) => boundary(m.handle));
	red(failures, /^owner@example\.com read the other's \/fs\/v1\/folders\/robotparts\/bundle: 200/, "another person");
	red(failures, /^signed out \/fs\/v1\/folders\/robotparts of a private folder: 200/, "signed out");
});

test("mutation: without the public rule, a public folder is not readable signed out (red)", async () => {
	const failures = await withMutant([
		{ file: "app.ts", marker: 'if (visibility === "public") return { owner, role: "public", visibility }; // fs-mutation: public is readable signed out', replacement: "" },
	], (m) => boundary(m.handle));
	red(failures, /^signed out, the public folder's file: 401/, "public signed out");
});

test("mutation: a public read signed for the owner's whole root instead of the one folder (red)", async () => {
	const failures = await withMutant([
		{ file: "app.ts", marker: 'const bucket = await bucketFor(env, deps, folderPrefix(owner, project), "object-read-only", READ_TTL_S); // fs-mutation: the read scope', replacement: 'const bucket = await bucketFor(env, deps, userRoot(owner), "object-read-only", READ_TTL_S);' },
	], (m) => boundary(m.handle));
	red(failures, /^a public read was not signed for users\/<owner>\/pub\/ only/, "the read scope");
});

// ------------------------------------------------------------------------------------------------ round-1 review

test("review r1 #8: two replacements in the same second keep two trash objects", async () => {
	const s3 = people();
	const { deps } = fakeDeps(s3); // WHY a fixed clock: every write lands in the same millisecond, the worst case
	const put = (body: string) => call(handle, env(), deps, "/fs/v1/folders/robotparts/web/saved/x.json", { method: "PUT", headers: page(OWNER), body });
	for (const body of ["one\n", "two\n", "three\n"]) assert.equal((await put(body)).status, 200, body);
	const trash = `users/${OWNER.userId}/_trash/robotparts/${WEB}/`;
	const kept = [...s3.objects.keys()].filter((k) => k.startsWith(trash) && k.endsWith("/saved/x.json")).map((k) => s3.text(k)).sort();
	assert.deepEqual(kept, ["one\n", "two\n"], "both replaced versions are in _trash/, neither overwrote the other");
	for (const key of [...s3.objects.keys()].filter((k) => k.startsWith(trash))) {
		assert.match(key.slice(trash.length), /^20261026T123456Z[^/]*\/saved\/x\.json$/, "the trash stamp still starts with the contract's UTC stamp");
	}
});

/** Every file the owner's web host's manifest lists, against its object: the paths whose bytes do not match. */
function mismatched(s3: MemoryS3, project = "robotparts", host = WEB): string[] {
	const base = `users/${OWNER.userId}/${project}/hosts/${host}/`;
	const text = s3.text(`${base}manifest.json`);
	if (!text) return [];
	const listed: { path: string; sha256: string }[] = JSON.parse(text).files;
	const out = listed.filter((e) => {
		const data = s3.objects.get(base + e.path);
		return !data || createHash("sha256").update(data).digest("hex") !== e.sha256;
	}).map((e) => e.path);
	// an object under the host that no manifest lists is an upload in flight: none may be left behind either
	const strays = [...s3.objects.keys()].filter((k) => k.startsWith(base) && k !== `${base}manifest.json` && !listed.some((e) => base + e.path === k)).map((k) => `stray ${k.slice(base.length)}`);
	return [...out, ...strays];
}

/** The reviewer's interleaving: before each of this request's manifest CASes, another writer lands a whole write to
 *  another path (its bytes and a newer manifest), six times in a row, so every attempt gets a 412. */
function sixWriters(s3: MemoryS3, project = "robotparts", host = WEB) {
	const base = `users/${OWNER.userId}/${project}/hosts/${host}/`;
	let n = 0;
	s3.beforeConditional = {
		key: `${base}manifest.json`,
		again: 5,
		run: () => {
			const theirs = JSON.parse(s3.text(`${base}manifest.json`)!);
			const path = `saved/other-${++n}.json`;
			const body = `{"n": ${n}}\n`;
			theirs.seq += 1;
			theirs.files.push({ path, size: body.length, mtime: "2026-10-26T12:00:00Z", sha256: createHash("sha256").update(body).digest("hex"), written_at: "2026-10-26T12:00:00Z" });
			theirs.files.sort((a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : 1));
			s3.put(base + path, body);
			s3.put(`${base}manifest.json`, JSON.stringify(theirs));
		},
	};
}

async function ownerBucket(s3: MemoryS3) {
	return new S3Bucket(await mint(env(), `users/${OWNER.userId}/`, "object-read-write", 300, Date.parse("2026-10-26T12:34:56Z")), s3.fetch);
}

test("review r1 #3: a write that loses every manifest CAS leaves the file's bytes matching its manifest", async () => {
	const s3 = people();
	const { deps } = fakeDeps(s3);
	assert.equal((await call(handle, env(), deps, "/fs/v1/folders/robotparts/web/saved/x.json", { method: "PUT", headers: page(OWNER), body: "old\n" })).status, 200);
	sixWriters(s3);
	const where = { root: `users/${OWNER.userId}/`, project: "robotparts", hostId: WEB };
	await assert.rejects(writeWebFile(await ownerBucket(s3), where, "saved/x.json", new TextEncoder().encode("new\n"), deps.now), /kept changing/);
	assert.equal(s3.beforeConditional, null, "all six writers ran");
	assert.deepEqual(mismatched(s3), [], "every object matches its manifest's sha256 (the review saw saved/x.json hold new bytes, the manifest the old sha)");
	assert.equal(s3.text(`users/${OWNER.userId}/robotparts/hosts/${WEB}/saved/x.json`), "old\n");
});

test("review r1 #3: a delete that loses every manifest CAS leaves the file in place, matching its manifest", async () => {
	const s3 = people();
	const { deps } = fakeDeps(s3);
	assert.equal((await call(handle, env(), deps, "/fs/v1/folders/robotparts/web/saved/x.json", { method: "PUT", headers: page(OWNER), body: "kept\n" })).status, 200);
	sixWriters(s3);
	const where = { root: `users/${OWNER.userId}/`, project: "robotparts", hostId: WEB };
	await assert.rejects(deleteWebFile(await ownerBucket(s3), where, "saved/x.json", deps.now), /kept changing/);
	assert.deepEqual(mismatched(s3), [], "the manifest still lists saved/x.json, so its object is still there");
	assert.equal(s3.text(`users/${OWNER.userId}/robotparts/hosts/${WEB}/saved/x.json`), "kept\n");
});

test("review r1 #3: concurrent web writes and deletes, same path and others, all land and match the manifest", async () => {
	const s3 = people();
	const { deps } = fakeDeps(s3);
	const at = (path: string, method: string, body?: string) => call(handle, env(), deps, `/fs/v1/folders/robotparts/web/${path}`, { method, headers: page(OWNER), body });
	assert.equal((await at("saved/x.json", "PUT", "v0\n")).status, 200);
	assert.equal((await at("saved/gone.json", "PUT", "bye\n")).status, 200);
	let seed = 7;
	s3.jitter = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) % 4);
	const answers = await Promise.all([
		at("saved/x.json", "PUT", "v1\n"), at("saved/x.json", "PUT", "v2\n"), at("saved/gone.json", "DELETE"),
		...[1, 2, 3, 4, 5, 6].map((n) => at(`saved/p${n}.json`, "PUT", `{"n": ${n}}\n`)),
	]);
	s3.jitter = null;
	assert.deepEqual(answers.map((a) => a.status), [200, 200, 200, 200, 200, 200, 200, 200, 200], "no write is turned away as busy: one writer per web host");
	assert.deepEqual(mismatched(s3), []);
	const listed = JSON.parse(s3.text(`users/${OWNER.userId}/robotparts/hosts/${WEB}/manifest.json`)!).files.map((e: { path: string }) => e.path);
	assert.deepEqual(listed, ["saved/p1.json", "saved/p2.json", "saved/p3.json", "saved/p4.json", "saved/p5.json", "saved/p6.json", "saved/x.json"]);
});

test("review r1 #3: a write cut off between its bytes and its manifest is undone, at once or by the next write", async () => {
	const s3 = people();
	const { deps } = fakeDeps(s3);
	const at = (path: string, body: string) => call(handle, env(), deps, `/fs/v1/folders/robotparts/web/${path}`, { method: "PUT", headers: page(OWNER), body });
	assert.equal((await at("saved/x.json", "one\n")).status, 200);
	const manifestKey = `users/${OWNER.userId}/robotparts/hosts/${WEB}/manifest.json`;
	// the manifest PUT fails: the bytes go back at once
	s3.fail = (method, key) => method === "PUT" && key === manifestKey;
	await assert.rejects(at("saved/x.json", "two\n"));
	s3.fail = null;
	assert.deepEqual(mismatched(s3), [], "rolled back at once");
	// the manifest PUT and the roll-back both fail: the next write puts it right first. WHY only the undo's COPY (into
	// hosts/, from _trash/): the trash copy before the write must succeed, or no bytes would have changed (review r2)
	const xKey = `users/${OWNER.userId}/robotparts/hosts/${WEB}/saved/x.json`;
	s3.fail = (method, key) => (method === "PUT" && key === manifestKey) || (method === "COPY" && key === xKey);
	const cut = await at("saved/x.json", "three\n");
	assert.equal(cut.status, 503, "a change that cannot be undone yet answers 503 recovering (review r2 #3)");
	assert.equal((await cut.json()).error, "recovering");
	s3.fail = null;
	assert.deepEqual(mismatched(s3), ["saved/x.json"], "the undo really failed: the file holds the uncommitted bytes");
	assert.equal((await at("saved/y.json", "why\n")).status, 200);
	assert.deepEqual(mismatched(s3), [], "the next write settled the cut-off one first");
	assert.equal(s3.text(`users/${OWNER.userId}/robotparts/hosts/${WEB}/saved/x.json`), "one\n");
});

test("review r1 #4: with X-Folder-Sync-Keep-Newest: at, an older heart arriving after a newer un-heart leaves the un-heart", async () => {
	const s3 = people();
	const { deps } = fakeDeps(s3);
	const key = `users/${OWNER.userId}/robotparts/hosts/${WEB}/saved/gim.json`;
	const heart = (saved: boolean, at: string, extra: Record<string, string> = { "X-Folder-Sync-Keep-Newest": "at" }) =>
		call(handle, env(), deps, "/fs/v1/folders/robotparts/web/saved/gim.json", { method: "PUT", headers: page(OWNER, { "Content-Type": "application/json", ...extra }), body: `${JSON.stringify({ part: "gim", saved, at })}\n` });
	// two tabs: the newer un-heart (12:00:05) reaches the server first, the older, delayed heart (12:00:00) after it
	assert.equal((await heart(false, "2026-10-26T12:00:05Z")).status, 200);
	const late = await heart(true, "2026-10-26T12:00:00Z");
	assert.equal(late.status, 409, "the older write is refused with a clear status");
	assert.equal((await late.json()).error, "stale");
	assert.equal(JSON.parse(s3.text(key)!).saved, false, "the un-heart stays");
	// instants, not text: 13:00:06+01:00 is 12:00:06Z, newer, so it is taken
	assert.equal((await heart(true, "2026-10-26T13:00:06+01:00")).status, 200);
	assert.equal(JSON.parse(s3.text(key)!).saved, true);
	// a body without the field it names is refused (400), nothing written
	const before = s3.text(key);
	const bare = await call(handle, env(), deps, "/fs/v1/folders/robotparts/web/saved/gim.json", { method: "PUT", headers: page(OWNER, { "X-Folder-Sync-Keep-Newest": "at" }), body: '{"saved": true}' });
	assert.equal(bare.status, 400);
	assert.equal((await bare.json()).error, "bad_body");
	assert.equal(s3.text(key), before);
	// without the header the web host stays a plain file host: the last write wins, as before
	assert.equal((await heart(false, "2000-01-01T00:00:00Z", {})).status, 200);
	assert.equal(JSON.parse(s3.text(key)!).at, "2000-01-01T00:00:00Z");
	assert.deepEqual(mismatched(s3), []);
});

test("review r1 #2: a cookie write names the user its page shows (X-Folder-Sync-User); another user's tab is refused", async () => {
	const s3 = people();
	const { deps } = fakeDeps(s3);
	const sisterWeb = `users/${SISTER.userId}/robotparts/hosts/`;
	const before = [...s3.objects.keys()].filter((k) => k.startsWith(sisterWeb)).length;
	// tab 1 still shows the owner; the browser's cookie is now the sister's (signed out and in again in tab 2)
	const stale = { ...cookie(SISTER), Origin: SITE, "X-Folder-Sync": "1", "X-Folder-Sync-User": OWNER.userId };
	const put = await call(handle, env(), deps, "/fs/v1/folders/robotparts/web/saved/a.json", { method: "PUT", headers: stale, body: '{"part": "a", "saved": true, "at": "2026-10-26T12:00:00Z"}' });
	assert.equal(put.status, 409);
	assert.equal((await put.json()).error, "wrong_user");
	const patch = await call(handle, env(), deps, "/fs/v1/folders/robotparts", { method: "PATCH", headers: { ...stale, "Content-Type": "application/json" }, body: '{"visibility":"public"}' });
	assert.equal(patch.status, 409);
	// a page that does not say who it is signed in as is refused too
	const unnamed = { ...cookie(SISTER), Origin: SITE, "X-Folder-Sync": "1" };
	assert.equal((await call(handle, env(), deps, "/fs/v1/folders/robotparts/web/saved/a.json", { method: "PUT", headers: unnamed, body: "{}" })).status, 409);
	assert.equal([...s3.objects.keys()].filter((k) => k.startsWith(sisterWeb)).length, before, "nothing landed in the sister's folder");
	assert.equal((await deps.store.folder(SISTER.userId, "robotparts")), null, "and her folder was not published");
	// the sister's own page, naming her, writes; a machine's bearer needs no such header (its token is one person)
	assert.equal((await call(handle, env(), deps, "/fs/v1/folders/robotparts/web/saved/a.json", { method: "PUT", headers: { ...unnamed, "X-Folder-Sync-User": SISTER.userId }, body: "{}" })).status, 200);
	assert.equal((await call(handle, env(), deps, "/fs/v1/folders/robotparts", { origin: OWN, method: "PATCH", headers: { Authorization: "Bearer token-sister-laptop", "Content-Type": "application/json" }, body: '{"visibility":"private"}' })).status, 200);
});

test("review r1 #7: over the per-person quota, no new storage keys and no web writes; deletes still work", async () => {
	const s3 = people();
	let now = Date.parse("2026-10-26T12:34:56Z");
	const { deps } = fakeDeps(s3, new MemoryStore(), { now: () => now });
	const bytesUnder = (root: string) => [...s3.objects].filter(([k]) => k.startsWith(root)).reduce((sum, [, v]) => sum + v.byteLength, 0);
	const keys = (token: string, e: Env) => call(handle, e, deps, "/fs/v1/credentials", { origin: OWN, method: "POST", headers: { Authorization: `Bearer ${token}` } });
	// a web file to delete later, written while the owner is well under the default quota
	assert.equal((await call(handle, env(), deps, "/fs/v1/folders/robotparts/web/saved/w.json", { method: "PUT", headers: page(OWNER), body: "{}\n" })).status, 200);
	const owner = bytesUnder(`users/${OWNER.userId}/`);
	const sister = bytesUnder(`users/${SISTER.userId}/`);
	assert.ok(sister + 10 < owner, `the fixture: the owner holds more (${owner}) than the sister (${sister})`);
	const tight = env({ QUOTA_BYTES: String(sister + 10), QUOTA_OBJECTS: "100000" });
	// since review r2 #7: over the quota, read-only keys (pull still works) that say why, not none
	const refused = await keys("token-owner-laptop", tight);
	assert.equal(refused.status, 200);
	const body = await refused.json();
	assert.equal(body.ReadOnly, true, "over the byte quota: read-only keys");
	assert.match(body.Reason, /bytes/);
	assert.equal(claimsOf(body.SessionToken).scope, "object-read-only");
	assert.equal((await keys("token-sister-laptop", tight)).status, 200, "under it: keys as before");
	const put = await call(handle, tight, deps, "/fs/v1/folders/robotparts/web/saved/more.json", { method: "PUT", headers: page(OWNER), body: "{}\n" });
	assert.equal(put.status, 403, "over the quota: no web write");
	assert.equal((await put.json()).error, "over_quota");
	assert.ok(![...s3.objects.keys()].some((k) => k.endsWith("saved/more.json")));
	assert.equal((await call(handle, tight, deps, "/fs/v1/folders/robotparts/web/saved/w.json", { method: "DELETE", headers: page(OWNER) })).status, 200, "a delete is always allowed");
	// the object count counts too (the sister holds two: her manifest and saved/a.json)
	const few = env({ QUOTA_OBJECTS: "1" });
	assert.equal((await (await keys("token-sister-laptop", few)).json()).ReadOnly, true, "over the object quota: read-only keys");
	// measured by listing the root, cached: no second listing until QUOTA_RECHECK_S has passed
	const lists = () => s3.calls.filter((c) => c.method === "LIST" && c.prefix === `users/${SISTER.userId}/`).length;
	const listed = lists();
	assert.ok(listed >= 1, "the root was listed to measure it");
	await keys("token-sister-laptop", tight);
	assert.equal(lists(), listed, "cached");
	now += 301_000;
	await keys("token-sister-laptop", tight);
	assert.equal(lists(), listed + 1, "measured again after QUOTA_RECHECK_S (300 s by default)");
	// a short credential lifetime bounds how far past the quota one window can go
	assert.equal(ttlOf({}), 300);
	assert.equal(new Date((await (await keys("token-sister-laptop", env())).json()).Expiration).getTime() - Math.floor(now / 1000) * 1000, 300_000);
});

// ------------------------------------------------------------------------------------------------ round-2 review

test("review r2 #3: a failed undo stops the write and keeps its journal, so the file can still be put back", async () => {
	const s3 = people();
	const { deps } = fakeDeps(s3);
	assert.equal((await call(handle, env(), deps, "/fs/v1/folders/robotparts/web/saved/x.json", { method: "PUT", headers: page(OWNER), body: "old\n" })).status, 200);
	sixWriters(s3);
	const xKey = `users/${OWNER.userId}/robotparts/hosts/${WEB}/saved/x.json`;
	let undos = 0;
	// the first undo (a COPY from _trash/ back over the file) answers 500, as in the review
	s3.fail = (method, key) => method === "COPY" && key === xKey && ++undos === 1;
	const where = { root: `users/${OWNER.userId}/`, project: "robotparts", hostId: WEB };
	const bucket = await ownerBucket(s3);
	const journal = memoryJournal();
	await assert.rejects(writeWebFile(bucket, where, "saved/x.json", new TextEncoder().encode("new\n"), deps.now, journal));
	const pending = await journal.get();
	assert.ok(pending, "the journal still names the cut-off write (the review found it null)");
	assert.equal(pending.restoreSha256, createHash("sha256").update("old\n").digest("hex"), "and the bytes the manifest lists, not the new ones");
	assert.equal(undos, 1, "no retry after the failed undo");
	s3.fail = null;
	s3.beforeConditional = null;
	await settle(bucket, where, journal);
	assert.deepEqual(mismatched(s3), []);
	assert.equal(s3.text(xKey), "old\n");
	assert.equal(await journal.get(), null);
});

/** A Durable Object's storage, in memory: the journal's key and the one alarm. */
function objectStorage() {
	const data = new Map<string, unknown>();
	const storage = {
		data,
		alarm: null as number | null,
		get: async <T>(key: string) => data.get(key) as T | undefined,
		put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
		delete: async (key: string) => data.delete(key),
		list: async <T>({ prefix }: { prefix: string }) => new Map([...data].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T])),
		setAlarm: async (at: number) => { storage.alarm = at; },
		deleteAlarm: async () => { storage.alarm = null; },
	};
	return storage;
}

/** A write cut off between its bytes and its manifest, with its undo failing too: the journal is all that is left. */
function cutOff(s3: MemoryS3) {
	const base = `users/${OWNER.userId}/robotparts/hosts/${WEB}/`;
	s3.fail = (method, key) => (method === "PUT" && key === `${base}manifest.json`) || (method === "COPY" && key === `${base}saved/x.json`);
}

test("review r2 #2: a read settles a cut-off write: the bundle serves the file again with no new write", async () => {
	const s3 = people();
	const { deps } = fakeDeps(s3);
	const at = (body: string) => call(handle, env(), deps, "/fs/v1/folders/robotparts/web/saved/x.json", { method: "PUT", headers: page(OWNER), body });
	assert.equal((await at('{"v": "one"}\n')).status, 200);
	cutOff(s3);
	assert.equal((await at('{"v": "two"}\n')).status, 503);
	s3.fail = null;
	assert.deepEqual(mismatched(s3), ["saved/x.json"], "cut off: the file holds bytes its manifest does not list");
	const bundle = await (await call(handle, env(), deps, "/fs/v1/folders/robotparts/bundle?prefix=saved/", { headers: cookie(OWNER) })).json();
	assert.deepEqual(bundle.files.filter((f: { host: string }) => f.host === WEB).map((f: { path: string; text: string }) => [f.path, f.text]), [["saved/x.json", '{"v": "one"}\n']],
		"the review saw three bundles of {files: []} here");
	assert.deepEqual(mismatched(s3), []);
});

test("review r2 #2: the folder's Durable Object settles a cut-off write on its own alarm", async () => {
	const { WebHostCore } = (await import("../src/webhost.ts")) as Record<string, any>;
	const s3 = people();
	const storage = objectStorage();
	const core = new WebHostCore(env(), s3.fetch, storage, () => Date.parse("2026-10-26T12:34:56Z"), new MemoryStore());
	const op = (text: string) => ({ method: "PUT", owner: OWNER.userId, project: "robotparts", hostId: WEB, path: "saved/x.json", data: new TextEncoder().encode(text) });
	assert.equal((await core.run(op("one\n"))).status, 200);
	assert.equal(storage.alarm, null, "nothing pending, no alarm");
	cutOff(s3);
	assert.equal((await core.run(op("two\n"))).status, 503);
	s3.fail = null;
	assert.ok(storage.data.get("pending"), "the journal is in the object's storage");
	assert.ok(storage.alarm !== null, "and an alarm is set to settle it if nothing else does");
	await core.alarm();
	assert.deepEqual(mismatched(s3), []);
	assert.equal(s3.text(`users/${OWNER.userId}/robotparts/hosts/${WEB}/saved/x.json`), "one\n");
	assert.equal(storage.data.get("pending"), undefined);
	assert.equal(storage.alarm, null);
});

test("review r2 #5: keep-newest settles an exact tie the same whichever write arrives first", async () => {
	const T = "2026-10-26T12:00:00Z";
	const stored = async (order: boolean[], prefer: boolean) => {
		const s3 = people();
		const { deps } = fakeDeps(s3);
		const statuses = [];
		for (const saved of order) {
			const headers = page(OWNER, { "X-Folder-Sync-Keep-Newest": "at", ...(prefer ? { "X-Folder-Sync-Tie-Prefers": "saved" } : {}) });
			statuses.push((await call(handle, env(), deps, "/fs/v1/folders/robotparts/web/saved/gim.json", { method: "PUT", headers, body: `${JSON.stringify({ part: "gim", saved, at: T })}\n` })).status);
		}
		return { saved: JSON.parse(s3.text(`users/${OWNER.userId}/robotparts/hosts/${WEB}/saved/gim.json`)!).saved, statuses };
	};
	// robotparts' rule (X-Folder-Sync-Tie-Prefers: saved): a heart wins an exact tie, in either order
	assert.deepEqual(await stored([true, false], true), { saved: true, statuses: [200, 409] });
	assert.deepEqual(await stored([false, true], true), { saved: true, statuses: [200, 200] });
	// with no preference, still one answer whatever the order (the larger sha256)
	const a = await stored([true, false], false);
	const b = await stored([false, true], false);
	assert.equal(a.saved, b.saved, "the review saw false one way round and true the other");
});

/** What is really stored under a person's root: bytes and objects. */
function stored(s3: MemoryS3, who: Person) {
	const entries = [...s3.objects].filter(([k]) => k.startsWith(`users/${who.userId}/`));
	return { bytes: entries.reduce((sum, [, v]) => sum + v.byteLength, 0), objects: entries.length };
}

/** Since review r5 #2 a deletion never subtracts from the measured figure: it marks it stale (an upper bound) and the
 *  next request measures again. This is that request, and what it leaves: the measured figure. */
async function measuredAgain(store: MemoryStore, deps: Deps, e: Env = env()) {
	await call(handle, e, deps, "/fs/v1/usage", { headers: cookie(OWNER) });
	const u = (await store.usage(OWNER.userId))!;
	return { bytes: u.bytes, objects: u.objects };
}

/** After a deletion in an object driven directly (no route to measure through): the figure is stale and never below
 *  what is stored (review r5 #2). */
async function staleUpperBound(store: MemoryStore, s3: MemoryS3) {
	const u = (await store.usage(OWNER.userId))!;
	const real = stored(s3, OWNER);
	assert.ok(u.stale && u.bytes >= real.bytes && u.objects >= real.objects, `stale and an upper bound: ${JSON.stringify([u, real])}`);
}

test("review r2 #6: concurrent web writes are admitted one at a time, and usage counts what is really stored", async () => {
	const s3 = people();
	const store = new MemoryStore();
	const { deps } = fakeDeps(s3, store);
	const quota = stored(s3, OWNER).bytes + 1000;
	const e = env({ QUOTA_BYTES: String(quota), QUOTA_RECHECK_S: "3600" });
	const answers = await Promise.all(Array.from({ length: 25 }, (_, n) =>
		call(handle, e, deps, `/fs/v1/folders/robotparts/web/saved/p${n}.json`, { method: "PUT", headers: page(OWNER), body: "x".repeat(100) })));
	const statuses = answers.map((a) => a.status);
	assert.ok(statuses.includes(200) && statuses.includes(403), `some admitted, the rest refused: ${statuses}`);
	const real = stored(s3, OWNER);
	assert.ok(real.bytes <= quota, `stored ${real.bytes} bytes, over the ${quota} quota (the review saw all 25 admitted)`);
	const counted = await store.usage(OWNER.userId);
	assert.deepEqual({ bytes: counted!.bytes, objects: counted!.objects }, real, "the count is what is stored, manifest included");
});

test("review r2 #6: a write that changes nothing costs nothing; a replacement costs its trash copy and the manifest's change", async () => {
	const s3 = people();
	const store = new MemoryStore();
	const { deps } = fakeDeps(s3, store);
	const e = env({ QUOTA_BYTES: String(stored(s3, OWNER).bytes + 2000), QUOTA_RECHECK_S: "3600" });
	const put = (body: string) => call(handle, e, deps, "/fs/v1/folders/robotparts/web/saved/same.json", { method: "PUT", headers: page(OWNER), body });
	for (let n = 0; n < 11; n++) assert.equal((await put("y".repeat(100))).status, 200, `identical write ${n + 1} (the review saw the 11th refused)`);
	assert.equal((await put("z".repeat(100))).status, 200);
	const counted = await store.usage(OWNER.userId);
	assert.deepEqual({ bytes: counted!.bytes, objects: counted!.objects }, stored(s3, OWNER));
	assert.equal((await call(handle, e, deps, "/fs/v1/folders/robotparts/web/saved/same.json", { method: "DELETE", headers: page(OWNER) })).status, 200);
	// since review r5 #2 a delete marks the figure stale, and the next request measures it again
	assert.deepEqual(await measuredAgain(store, deps, e), stored(s3, OWNER), "a delete is counted too");
});

test("review r2 #8: one quota measurement per person at a time, paged as S3 pages it, and a failed one is not retried at once", async () => {
	const s3 = people();
	for (let n = 0; n < 2500; n++) s3.put(`users/${OWNER.userId}/robotparts/hosts/${MACHINE}/bulk/${String(n).padStart(5, "0")}.txt`, "x");
	let now = Date.parse("2026-10-26T12:34:56Z");
	const { deps } = fakeDeps(s3, new MemoryStore(), { now: () => now });
	const root = `users/${OWNER.userId}/`;
	const pages = () => s3.calls.filter((c) => c.method === "LIST" && c.prefix === root).length;
	const keys = () => call(handle, env(), deps, "/fs/v1/credentials", { origin: OWN, method: "POST", headers: { Authorization: "Bearer token-owner-laptop" } }).catch(() => new Response(null, { status: 599 }));
	// a failed measurement: answered 503, and not tried again for a minute
	s3.fail = (method) => method === "LIST";
	const failed = await keys();
	assert.equal(failed.status, 503, "a measurement that fails is a 503 to try again");
	s3.fail = null;
	const tried = pages();
	assert.equal((await keys()).status, 503, "still within the minute: the failure is remembered");
	assert.equal(pages(), tried, "and the root is not listed again");
	now += 61_000;
	// thirty machines at once: one measurement (2500 files and the fixture's: three pages of 1000)
	const answers = await Promise.all(Array.from({ length: 30 }, keys));
	assert.equal(pages() - tried, 3, `one measurement of three pages, not one per request (the review saw thirty)`);
	assert.ok(answers.some((a) => a.status === 200), "the request that measured gets its keys");
	assert.ok(answers.every((a) => a.status === 200 || a.status === 503), `the others wait for it: ${answers.map((a) => a.status)}`);
	assert.equal((await keys()).status, 200, "once measured, everyone gets keys from the cache");
	assert.equal(pages() - tried, 3);
});

test("review r2 #1: the bundle names whose folder it is, so a page can refuse an answer for someone else", async () => {
	const { deps } = fakeDeps(people());
	const mine = await (await call(handle, env(), deps, "/fs/v1/folders/robotparts/bundle?prefix=saved/", { headers: cookie(OWNER) })).json();
	assert.equal(mine.owner, OWNER.userId);
	const hers = await (await call(handle, env(), deps, "/fs/v1/folders/robotparts/bundle?prefix=saved/", { headers: cookie(SISTER) })).json();
	assert.equal(hers.owner, SISTER.userId);
	const pub = await (await call(handle, env(), deps, `/fs/v1/folders/pub/bundle?owner=${OWNER.userId}`)).json();
	assert.equal(pub.owner, OWNER.userId);
});

test("review r2 #8: a web write whose quota cannot be measured answers 503 measuring, not a fault", async () => {
	const s3 = people();
	const { deps } = fakeDeps(s3);
	s3.fail = (method) => method === "LIST";
	const put = await call(handle, env(), deps, "/fs/v1/folders/robotparts/web/saved/m.json", { method: "PUT", headers: page(OWNER), body: "{}" });
	assert.equal(put.status, 503);
	assert.equal((await put.json()).error, "measuring");
	assert.ok(![...s3.objects.keys()].some((k) => k.endsWith("saved/m.json")), "nothing written");
});

// ------------------------------------------------------------------------------------------------ migrations

const MIGRATIONS = new URL("../migrations/", import.meta.url);

test("migrations are append-only: every file matches the sha256 it was first committed with (test/migrations.lock.json)", () => {
	const lock = JSON.parse(readFileSync(new URL("./migrations.lock.json", import.meta.url), "utf8"));
	const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
	for (const file of files) {
		assert.ok(lock[file], `${file} is not locked: add its sha256 to test/migrations.lock.json as it is first committed`);
		const sha = createHash("sha256").update(readFileSync(new URL(file, MIGRATIONS))).digest("hex");
		assert.equal(sha, lock[file], `${file} changed after it was written: put the change in a new migration`);
	}
});

test("the store's SQL runs against the migrations applied in order on SQLite, D1's engine", async () => {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
	const d1: D1Like = {
		prepare: (sql) => ({
			bind: (...values) => {
				const statement = db.prepare(sql);
				return {
					first: async <T>() => (statement.get(...(values as never[])) as T) ?? null,
					all: async <T>() => ({ results: statement.all(...(values as never[])) as T[] }),
					run: async () => ({ meta: { changes: Number(statement.run(...(values as never[])).changes) } }),
				};
			},
		}),
	};
	db.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)').run(OWNER.userId, "Owner", OWNER.email, "2026-10-26", "2026-10-26");
	const store = d1Store(d1);
	assert.equal(await store.claimMeasurement(OWNER.userId, 1000, 61_000, "claim-a"), true, "the first claim");
	assert.equal(await store.claimMeasurement(OWNER.userId, 2000, 62_000, "claim-x"), false, "a second while the first is live");
	assert.equal(await store.claimMeasurement(OWNER.userId, 61_001, 121_001, "claim-b"), true, "once it has run out");
	assert.equal(await store.setUsage(OWNER.userId, 0, 0, "2026-10-26T11:00:00.000Z", "claim-a"), false, "the outlived claim's result is fenced off (review r3 #7)");
	assert.equal(await store.setUsage(OWNER.userId, 100, 2, "2026-10-26T12:00:00.000Z", "claim-b"), true);
	await store.addUsage(OWNER.userId, 40, 1);
	assert.deepEqual({ ...(await store.usage(OWNER.userId)) }, { bytes: 140, objects: 3, measured_at: "2026-10-26T12:00:00.000Z", partial: false, stale: false });
	await store.addUsage(OWNER.userId, -40, -1);
	assert.deepEqual({ ...(await store.usage(OWNER.userId)) }, { bytes: 140, objects: 3, measured_at: "2026-10-26T12:00:00.000Z", partial: false, stale: true },
		"a credit marks the figure stale, never subtracts (review r5 #2)");
	assert.equal(await store.claimMeasurement(OWNER.userId, 200_000, 260_000, "claim-c"), true);
	await store.addUsage(OWNER.userId, -1, 0); // a deletion while claim-c lists
	assert.equal(await store.setUsage(OWNER.userId, 100, 2, "2026-10-26T12:02:00.000Z", "claim-c"), true);
	assert.equal((await store.usage(OWNER.userId))!.stale, true, "a measurement a deletion crossed is stored stale");
	assert.equal(await store.claimMeasurement(OWNER.userId, 300_000, 360_000, "claim-d"), true);
	await store.addUsage(OWNER.userId, 50, 1); // a write charged while claim-d lists
	assert.equal(await store.setUsage(OWNER.userId, 100, 2, "2026-10-26T12:03:00.000Z", "claim-d"), true);
	const crossed = (await store.usage(OWNER.userId))!;
	assert.deepEqual([crossed.bytes, crossed.objects], [150, 3], "a measurement a charge crossed keeps the charge (review r6 #2)");
	await store.setUsage(OWNER.userId, 1000, 1000, "2026-10-26T12:01:00.000Z", undefined, true);
	assert.equal((await store.usage(OWNER.userId))!.partial, true, "a lower bound reads back as one (review r4 #5)");
	assert.equal(await store.ensureWebHost(OWNER.userId, "robotparts", WEB, "2026-10-26"), WEB);
});

// ------------------------------------------------------------------------------------------------ over quota (r2 #7)

test("review r2 #7: over quota, a machine still gets keys: read-only, saying why, so it can still pull", async () => {
	const s3 = people();
	const { deps } = fakeDeps(s3);
	const tight = env({ QUOTA_BYTES: String(stored(s3, SISTER).bytes + 10) });
	const answer = await call(handle, tight, deps, "/fs/v1/credentials", { origin: OWN, method: "POST", headers: { Authorization: "Bearer token-owner-laptop" } });
	assert.equal(answer.status, 200);
	const keys = await answer.json();
	assert.equal(keys.ReadOnly, true);
	assert.match(keys.Reason, /bytes/);
	assert.equal(claimsOf(keys.SessionToken).scope, "object-read-only");
	assert.deepEqual((claimsOf(keys.SessionToken).paths as { prefixPaths: string[] }).prefixPaths, [`users/${OWNER.userId}/`]);
	const put = await s3.fetch(new Request(`${ENDPOINT}/${BUCKET}/users/${OWNER.userId}/robotparts/hosts/${MACHINE}/more.md`, { method: "PUT", body: "more", headers: { "X-Amz-Security-Token": keys.SessionToken } }));
	assert.equal(put.status, 403, "R2 refuses a write with them");
	const read = await s3.fetch(new Request(`${ENDPOINT}/${BUCKET}/users/${OWNER.userId}/robotparts/hosts/${MACHINE}/manifest.json`, { headers: { "X-Amz-Security-Token": keys.SessionToken } }));
	assert.equal(read.status, 200, "and lets it read: pull still works");
	const under = await (await call(handle, tight, deps, "/fs/v1/credentials", { origin: OWN, method: "POST", headers: { Authorization: "Bearer token-sister-laptop" } })).json();
	assert.equal(under.ReadOnly, undefined, "under quota: read-write keys, as before");
	assert.equal(claimsOf(under.SessionToken).scope, "object-read-write");
});

test("review r2 #7: a machine deletes through the Worker: exactly its manifest minus those paths, permanently, usage down", async () => {
	// since review r3 #1-2 the request is { job, from_seq, paths } and the server builds the manifest
	const s3 = people();
	const store = new MemoryStore();
	const { deps } = fakeDeps(s3, store);
	assert.equal((await call(handle, env(), deps, "/fs/v1/folders/robotparts/web/saved/w.json", { method: "PUT", headers: page(OWNER), body: "{}\n" })).status, 200);
	const base = `users/${OWNER.userId}/robotparts/hosts/${MACHINE}/`;
	const old = JSON.parse(s3.text(`${base}manifest.json`)!);
	const del = (body: unknown, headers: Record<string, string> = { Authorization: "Bearer token-owner-laptop" }, host = MACHINE) =>
		call(handle, env(), deps, `/fs/v1/folders/robotparts/hosts/${host}/delete`, { origin: OWN, method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const before = new Map(s3.objects);
	for (const [what, answer, status] of [
		["a browser's cookie", del({ job: JOB, from_seq: old.seq, paths: ["cad/bracket.step"] }, page(OWNER)), 401],
		["a path the manifest does not list", del({ job: JOB, from_seq: old.seq, paths: ["nope.md"] }), 400],
		["a from_seq that is not the stored one", del({ job: JOB, from_seq: old.seq - 1, paths: ["cad/bracket.step"] }), 409],
		["the web host (its deletes are DELETE …/web/<path>)", del({ job: JOB, from_seq: 1, paths: ["saved/w.json"] }, undefined, WEB), 400],
		["a host this person does not have", del({ job: JOB, from_seq: 1, paths: ["saved/a.json"] }, undefined, SISTER_MACHINE), 404],
		["no job id", del({ from_seq: old.seq, paths: ["cad/bracket.step"] }), 400],
	] as const) {
		assert.equal((await answer).status, status, what);
		assert.deepEqual([...s3.objects.keys()].sort(), [...before.keys()].sort(), `${what}: nothing changed`);
	}
	// measured first (a machine's keys measure the person), then the delete
	await call(handle, env(), deps, "/fs/v1/credentials", { origin: OWN, method: "POST", headers: { Authorization: "Bearer token-owner-laptop" } });
	const ok = await del({ job: JOB, from_seq: old.seq, paths: ["cad/bracket.step"] });
	assert.equal(ok.status, 200);
	const answer = await ok.json();
	assert.equal(answer.seq, old.seq + 1);
	assert.deepEqual(answer.deleted, ["cad/bracket.step"]);
	assert.equal(s3.objects.has(`${base}cad/bracket.step`), false, "deleted");
	assert.ok(![...s3.objects.keys()].some((k) => k.includes("_trash/") && k.endsWith("cad/bracket.step")), "permanently: no trash copy");
	assert.deepEqual(JSON.parse(s3.text(`${base}manifest.json`)!).files.map((f: { path: string }) => f.path), ["saved/a.json"]);
	assert.deepEqual(await measuredAgain(store, deps), stored(s3, OWNER), "the usage went down by what was deleted, manifest included");
});

// ------------------------------------------------------------------------------------------------ round-3 review

test("review r3 #4: a read whose folder cannot be settled answers 503 recovering, never a bundle with the file missing", async () => {
	const s3 = people();
	const { deps } = fakeDeps(s3);
	const at = (body: string) => call(handle, env(), deps, "/fs/v1/folders/robotparts/web/saved/x.json", { method: "PUT", headers: page(OWNER), body });
	assert.equal((await at('{"v": "one"}\n')).status, 200);
	cutOff(s3);
	assert.equal((await at('{"v": "two"}\n')).status, 503);
	// the undo still fails: every read of the folder says so
	for (const path of ["/fs/v1/folders/robotparts/bundle?prefix=saved/", "/fs/v1/folders/robotparts", `/fs/v1/folders/robotparts/files/${WEB}/saved/x.json`]) {
		const read = await call(handle, env(), deps, path, { headers: cookie(OWNER) });
		assert.equal(read.status, 503, `${path} (the review saw 200 {files: []})`);
		assert.equal((await read.json()).error, "recovering");
	}
	s3.fail = null;
	const bundle = await call(handle, env(), deps, "/fs/v1/folders/robotparts/bundle?prefix=saved/", { headers: cookie(OWNER) });
	assert.equal(bundle.status, 200);
	assert.ok((await bundle.json()).files.some((f: { host: string; text: string }) => f.host === WEB && f.text === '{"v": "one"}\n'));
});

/** A delete job's id, as a machine mints and keeps one until it has the answer (review r3 #2). */
const JOB = "6f9b2c1e-3d4a-4b5c-8d7e-9f0a1b2c3d4e";

test("review r3 #1: the delete endpoint builds the next manifest itself: the review's 1 MiB padding is no upload channel", async () => {
	const s3 = people();
	const store = new MemoryStore();
	const { deps } = fakeDeps(s3, store);
	const base = `users/${OWNER.userId}/robotparts/hosts/${MACHINE}/`;
	const old = JSON.parse(s3.text(`${base}manifest.json`)!);
	const del = (body: unknown) => call(handle, env({ QUOTA_BYTES: "1" }), deps, `/fs/v1/folders/robotparts/hosts/${MACHINE}/delete`,
		{ origin: OWN, method: "POST", headers: { Authorization: "Bearer token-owner-laptop", "Content-Type": "application/json" }, body: JSON.stringify(body) });
	await call(handle, env({ QUOTA_BYTES: "1" }), deps, "/fs/v1/credentials", { origin: OWN, method: "POST", headers: { Authorization: "Bearer token-owner-laptop" } });
	const usedBefore = (await store.usage(OWNER.userId))!.bytes;
	const before = new Map(s3.objects);
	// the review: a one-byte quota, a delete carrying a manifest with a 1 MiB padding field
	const padded = { ...old, seq: old.seq + 1, files: old.files.filter((f: { path: string }) => f.path !== "cad/bracket.step"), padding: "x".repeat(1 << 20) };
	const exploit = await del({ job: JOB, from_seq: old.seq, paths: ["cad/bracket.step"], manifest: padded });
	assert.equal(exploit.status, 413, "a body over the cap is refused before it is read (the review saw 200)");
	// a small body with anything but from_seq and paths is refused too: the server builds the manifest
	assert.equal((await del({ job: JOB, from_seq: old.seq, paths: ["cad/bracket.step"], manifest: { padding: "x" } })).status, 400);
	assert.equal((await del({ job: JOB, from_seq: old.seq, paths: ["cad/bracket.step"], note: "x" })).status, 400);
	assert.deepEqual([...s3.objects.keys()].sort(), [...before.keys()].sort(), "nothing changed");
	assert.equal((await store.usage(OWNER.userId))!.bytes, usedBefore);
	// the real delete: from_seq and paths only; the stored manifest is the server's own build
	// since review r3 #2 a delete is a job, with its id
	const ok = await del({ job: JOB, from_seq: old.seq, paths: ["cad/bracket.step"] });
	assert.equal(ok.status, 200);
	const answer = await ok.json();
	const written = JSON.parse(s3.text(`${base}manifest.json`)!);
	assert.deepEqual(Object.keys(written).sort(), ["files", "generated_at", "host_id", "host_name", "project", "schema", "seq"], "no field the caller made up");
	assert.equal(written.seq, old.seq + 1);
	assert.equal(written.generated_at, "2026-10-26T12:34:56.000Z", "the server's clock");
	assert.deepEqual(written.files, old.files.filter((f: { path: string }) => f.path !== "cad/bracket.step"));
	assert.deepEqual(answer.manifest, written, "the answer carries the manifest, for the machine to keep");
	assert.ok((await measuredAgain(store, deps, env({ QUOTA_BYTES: "1" }))).bytes < usedBefore, "and the usage went down");
});


test("review r3 #2: a delete cut off after its manifest commits is finished later, once, by a replay of the same job", async () => {
	const s3 = people();
	const store = new MemoryStore();
	const { deps } = fakeDeps(s3, store);
	const base = `users/${OWNER.userId}/robotparts/hosts/${MACHINE}/`;
	const old = JSON.parse(s3.text(`${base}manifest.json`)!);
	const del = (body: unknown) => call(handle, env(), deps, `/fs/v1/folders/robotparts/hosts/${MACHINE}/delete`,
		{ origin: OWN, method: "POST", headers: { Authorization: "Bearer token-owner-laptop", "Content-Type": "application/json" }, body: JSON.stringify(body) });
	await call(handle, env(), deps, "/fs/v1/credentials", { origin: OWN, method: "POST", headers: { Authorization: "Bearer token-owner-laptop" } });
	const request = { job: JOB, from_seq: old.seq, paths: ["cad/bracket.step"] };
	s3.fail = (method, key) => method === "DELETE" && key === `${base}cad/bracket.step`;
	const first = await del(request);
	assert.equal(first.status, 200);
	const one = await first.json();
	assert.deepEqual([one.seq, one.deleted, one.pending], [old.seq + 1, [], ["cad/bracket.step"]], "committed, the cleanup still to do (the review saw deleted: [] and nothing pending)");
	// the answer is lost, or the cleanup still fails: the same job again is the same answer, charged once
	const again = await (await del(request)).json();
	assert.deepEqual([again.seq, again.deleted, again.pending], [old.seq + 1, [], ["cad/bracket.step"]], "a replay of the job, not a 400 or 409");
	s3.fail = null;
	const done = await (await del(request)).json();
	assert.deepEqual([done.seq, done.deleted, done.pending], [old.seq + 1, ["cad/bracket.step"], []]);
	assert.deepEqual(done.manifest.files.map((f: { path: string }) => f.path), ["saved/a.json"]);
	assert.equal(s3.objects.has(`${base}cad/bracket.step`), false);
	assert.deepEqual(await measuredAgain(store, deps), stored(s3, OWNER), "the usage is what is stored: charged once");
	assert.equal((await (await del(request)).json()).seq, old.seq + 1, "a done job still answers");
	assert.equal((await del({ ...request, paths: ["saved/a.json"] })).status, 409, "the same job id with other paths is refused");
});

test("review r3 #2: the folder's Durable Object finishes a delete's cleanup on its own alarm", async () => {
	const { WebHostCore } = (await import("../src/webhost.ts")) as Record<string, any>;
	const s3 = people();
	const store = new MemoryStore();
	const storage = objectStorage();
	const core = new WebHostCore(env(), s3.fetch, storage, () => Date.parse("2026-10-26T12:34:56Z"), store);
	const base = `users/${OWNER.userId}/robotparts/hosts/${MACHINE}/`;
	const old = JSON.parse(s3.text(`${base}manifest.json`)!);
	s3.fail = (method, key) => method === "DELETE" && key === `${base}cad/bracket.step`;
	const answer = await core.run({ method: "HOST_DELETE", owner: OWNER.userId, project: "robotparts", hostId: MACHINE, path: "", job: JOB, fromSeq: old.seq, paths: ["cad/bracket.step"] });
	assert.equal(answer.status, 200);
	assert.deepEqual(answer.body.pending, ["cad/bracket.step"]);
	assert.ok(storage.alarm !== null, "an alarm is set to finish it");
	s3.fail = null;
	await core.alarm();
	assert.equal(s3.objects.has(`${base}cad/bracket.step`), false, "finished with no request");
	assert.equal(storage.alarm, null, "nothing left to do");
});

test("review r3 #3: a web-only person deletes their way under quota: a permanent web delete and a purge of the web host's trash", async () => {
	const s3 = people();
	const store = new MemoryStore();
	const { deps } = fakeDeps(s3, store);
	const web = (path: string, init: RequestInit) => call(handle, env(), deps, `/fs/v1/folders/robotparts/${path}`, init);
	const big = "x".repeat(10_000);
	assert.equal((await web("web/saved/big.json", { method: "PUT", headers: page(OWNER), body: big })).status, 200);
	assert.equal((await web("web/saved/old.json", { method: "PUT", headers: page(OWNER), body: big })).status, 200);
	assert.equal((await web("web/saved/old.json", { method: "DELETE", headers: page(OWNER) })).status, 200, "an ordinary delete: into the trash");
	const before = await measuredAgain(store, deps); // what is stored (the delete above left the cached figure stale)
	// over quota now (read-only keys), and the person has only a browser
	const tight = env({ QUOTA_BYTES: String(before.bytes - 1) });
	assert.equal((await (await call(handle, tight, deps, "/fs/v1/credentials", { origin: OWN, method: "POST", headers: { Authorization: "Bearer token-owner-laptop" } })).json()).ReadOnly, true);
	const gone = await call(handle, tight, deps, "/fs/v1/folders/robotparts/web/saved/big.json?permanent=1", { method: "DELETE", headers: page(OWNER) });
	assert.equal(gone.status, 200, "a permanent web delete (the review saw only the manifest shrink)");
	assert.equal(s3.objects.has(`users/${OWNER.userId}/robotparts/hosts/${WEB}/saved/big.json`), false);
	assert.ok(![...s3.objects].some(([k, v]) => k.includes("/_trash/") && k.endsWith("saved/big.json") && v.byteLength === 10_000), "no trash copy of it");
	const purge = await call(handle, tight, deps, "/fs/v1/folders/robotparts/web-trash/purge", { method: "POST", headers: page(OWNER) });
	assert.equal(purge.status, 200, "the web host's trash, purged");
	assert.ok(![...s3.objects.keys()].some((k) => k.startsWith(`users/${OWNER.userId}/_trash/robotparts/${WEB}/`)));
	const after = await measuredAgain(store, deps, tight);
	assert.deepEqual(after, stored(s3, OWNER), "the usage is what is stored");
	assert.ok(after.bytes < before.bytes - 20_000 && after.objects < before.objects, `bytes and objects really dropped: ${JSON.stringify([before, after])}`);
	assert.equal((await (await call(handle, tight, deps, "/fs/v1/credentials", { origin: OWN, method: "POST", headers: { Authorization: "Bearer token-owner-laptop" } })).json()).ReadOnly, undefined, "back under: read-write keys");
	// a cookie purge needs the page's own headers, like any write
	assert.equal((await call(handle, tight, deps, "/fs/v1/folders/robotparts/web-trash/purge", { method: "POST", headers: cookie(OWNER) })).status, 403);
});

test("review r3 #6: replacements rolled back leave no uncounted trash copies: the usage stays what is stored", async () => {
	const s3 = people();
	const store = new MemoryStore();
	const { deps } = fakeDeps(s3, store);
	const put = (body: string) => call(handle, env(), deps, "/fs/v1/folders/robotparts/web/saved/x.json", { method: "PUT", headers: page(OWNER), body }).catch(() => null);
	assert.equal((await put("v0".repeat(50)))!.status, 200);
	const manifestKey = `users/${OWNER.userId}/robotparts/hosts/${WEB}/manifest.json`;
	s3.fail = (method, key) => method === "PUT" && key === manifestKey;
	for (let n = 1; n <= 12; n++) await put(`v${n}`.repeat(50)); // each fails at its manifest and is rolled back
	s3.fail = null;
	const counted = (await store.usage(OWNER.userId))!;
	assert.deepEqual({ bytes: counted.bytes, objects: counted.objects }, stored(s3, OWNER), "the review saw 547 bytes / 2 objects counted, 1,747 / 14 stored");
	assert.deepEqual(mismatched(s3), []);
});

test("review r3 #7: a measurement that outlives its claim cannot overwrite a newer one", async () => {
	const store = new MemoryStore();
	const quota = quotaOf({ QUOTA_RECHECK_S: "300" });
	const t0 = Date.parse("2026-10-26T12:00:00Z");
	let finishA!: (value: { bytes: number; objects: number }) => void;
	const a = usageOf(store, OWNER.userId, quota, t0, () => new Promise((done) => { finishA = done; }));
	await new Promise((done) => setTimeout(done, 0)); // A holds the claim, its listing still running
	const b = await usageOf(store, OWNER.userId, quota, t0 + 61_000, async () => ({ bytes: 2000, objects: 3 }));
	assert.equal(b.bytes, 2000, "B claimed after A's claim ran out, and measured");
	finishA({ bytes: 0, objects: 0 });
	await a;
	assert.equal((await store.usage(OWNER.userId))!.bytes, 2000, "A's late result is fenced off (the review saw it overwrite B with 0)");
});

test("review r3 #7: a measurement too old to trust gives read-only keys and refuses web writes; reads still work", async () => {
	const s3 = people();
	const store = new MemoryStore();
	const now = Date.parse("2026-10-27T12:00:00Z");
	const { deps } = fakeDeps(s3, store, { now: () => now });
	await store.setUsage(OWNER.userId, 0, 0, "2026-10-26T12:00:00.000Z"); // a day old, and zero
	s3.fail = (method) => method === "LIST";
	const keys = await call(handle, env(), deps, "/fs/v1/credentials", { origin: OWN, method: "POST", headers: { Authorization: "Bearer token-owner-laptop" } });
	assert.equal(keys.status, 200);
	const body = await keys.json();
	assert.equal(body.ReadOnly, true, "no write access on a day-old measurement (the review saw it renew write access)");
	assert.match(body.Reason, /measured/);
	const put = await call(handle, env(), deps, "/fs/v1/folders/robotparts/web/saved/n.json", { method: "PUT", headers: page(OWNER), body: "{}" });
	assert.equal(put.status, 503);
	assert.equal((await put.json()).error, "measuring");
	s3.fail = null;
	assert.equal((await call(handle, env(), deps, "/fs/v1/folders/robotparts/bundle?prefix=saved/", { headers: cookie(OWNER) })).status, 200, "reads still work");
});

test("review r3 #8: production email codes, when delivery is configured: the routes, the page, and the sender", async () => {
	const { deps, authCalls } = fakeDeps(people());
	const mail = env({ RESEND_API_KEY: "re_test_fixture_not_a_key", EMAIL_FROM: "Robot Parts <signin@example.test>", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" });
	for (const path of ["/fs/api/auth/email-otp/send-verification-otp", "/fs/api/auth/sign-in/email-otp"]) {
		assert.notEqual((await call(handle, mail, deps, path, { method: "POST", body: "{}" })).status, 404, `${path} (the review saw 404 "no email codes here")`);
	}
	assert.deepEqual(authCalls, ["/fs/api/auth/email-otp/send-verification-otp", "/fs/api/auth/sign-in/email-otp"]);
	const html = await (await call(handle, mail, null, "/fs/signin")).text();
	assert.match(html, /<meta name="fs-signin" content="google email">/, "both ways in");
	// unconfigured production still offers none
	assert.equal((await call(handle, env(), deps, "/fs/api/auth/email-otp/send-verification-otp", { method: "POST", body: "{}" })).status, 404);
	// the sender: Resend's API, the key only in its Authorization header
	const { emailSender } = (await import("../src/email.ts")) as Record<string, any>;
	assert.equal(emailSender(env(), async () => new Response()), null, "no key, no sender");
	const sent: Request[] = [];
	const send = emailSender(mail, async (request: Request) => { sent.push(request); return new Response('{"id":"x"}', { status: 200 }); });
	await send("person@example.com", "123456");
	assert.equal(sent.length, 1);
	assert.equal(sent[0].url, "https://api.resend.com/emails");
	assert.equal(sent[0].headers.get("Authorization"), "Bearer re_test_fixture_not_a_key");
	const body = await sent[0].json();
	assert.deepEqual([body.from, body.to], ["Robot Parts <signin@example.test>", ["person@example.com"]]);
	assert.match(body.text, /123456/);
	assert.doesNotMatch(JSON.stringify(body), /re_test_fixture/, "the key never in the message");
	const failing = emailSender(mail, async () => new Response('{"message":"invalid"}', { status: 422 }));
	await assert.rejects(failing("person@example.com", "123456"), /could not be sent/);
	const auth = readFileSync(fileURLToPath(new URL("../src/auth.ts", import.meta.url)), "utf-8");
	assert.match(auth, /emailSender\(env, \(request\) => fetch\(request\)\)/, "auth.ts sends production codes through it");
});

test("review r3 #9: the device page never shows folder-sync login as the way in; the CLI is behind 'For developers'", async () => {
	const { runInNewContext } = await import("node:vm");
	const script = readFileSync(fileURLToPath(new URL("../site/device.js", import.meta.url)), "utf-8");
	const pages: string[] = [];
	const element = () => ({ onclick: null, onkeydown: null, value: "", hidden: true, textContent: "", focus() {} });
	const box = {
		set innerHTML(html: string) { pages.push(html); },
		get innerHTML() { return pages.at(-1) ?? ""; },
		querySelector: () => element(),
	};
	const render = async (search: string, fetchAnswer: () => Promise<Response>) => {
		const window: Record<string, unknown> = {
			FSSignIn: { render: () => undefined, post: async () => ({}), esc: (s: string) => String(s), session: async () => ({ user: { email: "a@example.com" } }), AUTH: "/fs/api/auth" },
		};
		runInNewContext(script, { window, document: { querySelector: () => box }, location: { search, href: `https://robotparts.dev/fs/device${search}` }, URLSearchParams, fetch: fetchAnswer });
		await new Promise((done) => setTimeout(done, 10));
	};
	await render("", async () => new Response("{}"));
	await render("?user_code=ABCDEFGH", async () => new Response('{"message":"expired"}', { status: 400 }));
	await render("?user_code=ABCDEFGH", async () => new Response('{"status":"denied"}', { status: 200 }));
	assert.ok(pages.length >= 3, `the page drew ${pages.length} times`);
	for (const html of pages) {
		const shown = html.replace(/<details[\s\S]*?<\/details>/g, "");
		assert.doesNotMatch(shown, /folder-sync login/, `outside a disclosure: ${shown}`);
		for (const disclosure of html.match(/<details[\s\S]*?<\/details>/g) ?? []) assert.match(disclosure, /<summary>For developers<\/summary>/);
	}
	assert.ok(pages.some((html) => /desktop app \(coming\)/.test(html)), "a machine syncs through the desktop app (coming)");
	assert.ok(pages.some((html) => /<details[\s\S]*folder-sync login[\s\S]*<\/details>/.test(html)), "the CLI is still there, for developers");
});

// ------------------------------------------------------------------------------------------------ round-4 review

/** One folder's object over in-memory storage, as the Durable Object runs it, with ops for the owner's web host. */
async function folderObject(s3: MemoryS3, store = new MemoryStore(), e: Env = env()) {
	const { WebHostCore } = (await import("../src/webhost.ts")) as Record<string, any>;
	const storage = objectStorage();
	const core = new WebHostCore(e, s3.fetch, storage, () => Date.parse("2026-10-26T12:34:56Z"), store);
	const op = (method: string, path: string, extra: Record<string, unknown> = {}) => core.run({ method, owner: OWNER.userId, project: "robotparts", hostId: WEB, path, ...extra });
	const put = (path: string, text: string) => op("PUT", path, { data: new TextEncoder().encode(text) });
	return { core, storage, store, op, put };
}

test("review r4 #1: a delete's pending cleanup never erases a later replacement of the same path", async () => {
	const s3 = people();
	const { core, store, op, put } = await folderObject(s3);
	const key = `users/${OWNER.userId}/robotparts/hosts/${WEB}/saved/x.json`;
	assert.equal((await put("saved/x.json", "old\n")).status, 200);
	s3.fail = (method, k) => method === "DELETE" && k === key;
	const gone = await op("DELETE", "saved/x.json", { permanent: true });
	assert.equal(gone.status, 200);
	assert.deepEqual(gone.body.pending, ["saved/x.json"], "committed; the object still to delete");
	s3.fail = null;
	assert.equal((await put("saved/x.json", "replacement\n")).status, 200);
	await core.alarm();
	assert.equal(s3.text(key), "replacement\n", "the review saw the alarm delete the replacement");
	assert.deepEqual(mismatched(s3), []);
	await staleUpperBound(store, s3);
});

test("review r4 #2: a purge never destroys a backup a cut-off change still needs; a restore from nothing is no restore", async () => {
	const s3 = people();
	const { core, storage, op, put } = await folderObject(s3);
	const base = `users/${OWNER.userId}/robotparts/hosts/${WEB}/`;
	assert.equal((await put("saved/x.json", "old\n")).status, 200);
	cutOff(s3); // the manifest PUT and the undo COPY both fail
	assert.equal((await put("saved/x.json", "new\n")).status, 503);
	const purge = await op("PURGE_TRASH", "");
	assert.equal(purge.status, 503, "the folder is recovering: no purge (the review saw 200 and the backup gone)");
	assert.ok([...s3.objects.keys()].some((k) => k.includes("/_trash/") && k.endsWith("saved/x.json") && s3.text(k) === "old\n"), "the backup is still there");
	s3.fail = null;
	await core.alarm();
	assert.equal(s3.text(`${base}saved/x.json`), "old\n");
	assert.deepEqual(mismatched(s3), []);
	// a backup that is gone: the restore cannot happen, so the change stays journalled, and reads say so
	cutOff(s3);
	assert.equal((await put("saved/x.json", "newer\n")).status, 503);
	s3.fail = null;
	for (const k of [...s3.objects.keys()].filter((k) => k.includes("/_trash/") && k.endsWith("saved/x.json") && s3.text(k) === "old\n")) s3.objects.delete(k);
	await core.alarm();
	assert.ok(storage.data.get("pending"), "the journal stays: a COPY from nothing is a failure (the review saw it cleared)");
	assert.equal((await op("SETTLE", "")).status, 503);
});

test("review r4 #3: a delete job has its alarm before its first bucket write, so a restart mid-job still finishes it", async () => {
	const s3 = people();
	const { core, storage, store } = await folderObject(s3);
	const base = `users/${OWNER.userId}/robotparts/hosts/${MACHINE}/`;
	const old = JSON.parse(s3.text(`${base}manifest.json`)!);
	// the object is cut off right after the manifest commits: saving committed: true never happens
	const realPut = storage.put;
	storage.put = async (key: string, value: unknown) => {
		if (key.startsWith("job:") && (value as { committed: boolean }).committed) throw new Error("the object restarted");
		return realPut(key, value);
	};
	await assert.rejects(core.run({ method: "HOST_DELETE", owner: OWNER.userId, project: "robotparts", hostId: MACHINE, path: "", job: JOB, fromSeq: old.seq, paths: ["cad/bracket.step"] }));
	assert.equal(JSON.parse(s3.text(`${base}manifest.json`)!).seq, old.seq + 1, "the manifest committed");
	assert.ok(storage.alarm !== null, "and an alarm is set to finish the job (the review saw none)");
	storage.put = realPut;
	await core.alarm();
	assert.equal(s3.objects.has(`${base}cad/bracket.step`), false, "the alarm finished it");
	assert.equal(storage.alarm, null);
	void store;
});

test("review r4 #7: a backup that cannot be removed after an undo is charged until the alarm removes it", async () => {
	const s3 = people();
	const store = new MemoryStore();
	const { core, put } = await folderObject(s3, store);
	assert.equal((await put("saved/x.json", "v0".repeat(100))).status, 200);
	const manifestKey = `users/${OWNER.userId}/robotparts/hosts/${WEB}/manifest.json`;
	// each replacement fails at its manifest and is undone, but its backup cannot be deleted
	s3.fail = (method, key) => (method === "PUT" && key === manifestKey) || (method === "DELETE" && key.includes("/_trash/"));
	for (let n = 1; n <= 5; n++) await put("saved/x.json", `v${n}`.repeat(100)).catch(() => null);
	s3.fail = null;
	const counted = async () => { const u = (await store.usage(OWNER.userId))!; return { bytes: u.bytes, objects: u.objects }; };
	assert.deepEqual(await counted(), stored(s3, OWNER), "the backups left behind are charged (the review saw 1,728 / 8 counted, 3,228 / 13 stored)");
	await core.alarm();
	assert.ok(![...s3.objects.keys()].some((k) => k.includes("/_trash/robotparts/" + WEB + "/")), "the alarm removed them");
	await staleUpperBound(store, s3); // credited: since review r5 #2 a credit marks the figure stale for measuring again
	assert.deepEqual(mismatched(s3), []);
});

test("review r4 #5: a measurement that stopped early is a lower bound: deletion credits never make it 'under quota'", async () => {
	const s3 = people();
	// 999 tiny files that sort before everything else of the owner's but the trash, then a 10,000-byte file of A's machine
	for (let n = 0; n < 999; n++) s3.put(`users/${OWNER.userId}/a-bulk/${String(n).padStart(4, "0")}`, "x");
	const base = `users/${OWNER.userId}/robotparts/hosts/${MACHINE}/`;
	const m = JSON.parse(s3.text(`${base}manifest.json`)!);
	const big = "b".repeat(10_000);
	m.files.push({ path: "cad/big.bin", size: big.length, mtime: "2026-10-26T11:00:00Z", sha256: createHash("sha256").update(big).digest("hex"), written_at: "2026-10-26T12:00:00Z" });
	s3.put(`${base}cad/big.bin`, big);
	s3.put(`${base}manifest.json`, JSON.stringify(m));
	let now = Date.parse("2026-10-26T12:34:56Z");
	const store = new MemoryStore();
	const { deps } = fakeDeps(s3, store, { now: () => now });
	const tight = env({ QUOTA_BYTES: "900" });
	const keys = async () => (await call(handle, tight, deps, "/fs/v1/credentials", { origin: OWN, method: "POST", headers: { Authorization: "Bearer token-owner-laptop" } })).json();
	assert.equal((await keys()).ReadOnly, true, "over: the first page alone exceeds 900 bytes");
	const del = await call(handle, tight, deps, `/fs/v1/folders/robotparts/hosts/${MACHINE}/delete`, { origin: OWN, method: "POST",
		headers: { Authorization: "Bearer token-owner-laptop", "Content-Type": "application/json" }, body: JSON.stringify({ job: JOB, from_seq: m.seq, paths: ["cad/big.bin"] }) });
	assert.equal(del.status, 200);
	assert.ok(stored(s3, OWNER).bytes > 900, "still over: a thousand small files remain");
	for (const later of [0, 601_000, 1_202_000]) {
		now = Date.parse("2026-10-26T12:34:56Z") + later;
		assert.equal((await keys()).ReadOnly, true, `at +${later / 1000} s: still read-only (the review saw read-write keys on a negative usage)`);
	}
});

test("review r4 #6: a measurement that loses its claim never admits writes on a figure past QUOTA_MAX_AGE_S", async () => {
	const store = new MemoryStore();
	const quota = quotaOf({});
	const t0 = Date.parse("2026-10-27T12:00:00Z");
	await store.setUsage(OWNER.userId, 0, 0, "2026-10-26T12:00:00.000Z"); // a day old
	let finishA!: (value: { bytes: number; objects: number; complete: boolean }) => void;
	const a = usageOf(store, OWNER.userId, quota, t0, () => new Promise((done) => { finishA = done; }));
	await new Promise((done) => setTimeout(done, 0));
	// B claims once A's claim has run out, and is still listing
	void usageOf(store, OWNER.userId, quota, t0 + 61_000, () => new Promise(() => undefined));
	await new Promise((done) => setTimeout(done, 0));
	finishA({ bytes: 0, objects: 0, complete: true });
	await assert.rejects(a, Measuring, "A lost its claim: no figure young enough, so no write access (the review saw the day-old zero admitted)");
});

test("the person's usage for a page: GET /fs/v1/usage says over or not, and why (for /saved/'s recovery controls)", async () => {
	const s3 = people();
	const { deps } = fakeDeps(s3);
	const usage = async (e: Env, headers: Record<string, string> = cookie(OWNER)) => call(handle, e, deps, "/fs/v1/usage", { headers });
	const under = await usage(env());
	assert.equal(under.status, 200);
	const ok = await under.json();
	assert.equal(ok.over, null);
	assert.deepEqual(ok.quota, { bytes: 1024 ** 3, objects: 100_000 });
	assert.deepEqual(ok.used, { bytes: stored(s3, OWNER).bytes, objects: stored(s3, OWNER).objects });
	const tight = await (await usage(env({ QUOTA_BYTES: "10", QUOTA_RECHECK_S: "0" }))).json();
	assert.match(tight.over, /bytes/, "over: the reason, as the keys' Reason says it");
	assert.equal((await usage(env(), {})).status, 401, "signed out: nothing");
});

test("the device page: signin.js never sends a signed-in person away from it (the desktop lane's reload loop)", async () => {
	const { runInNewContext } = await import("node:vm");
	const script = readFileSync(fileURLToPath(new URL("../site/signin.js", import.meta.url)), "utf-8");
	const replaced: string[] = [];
	let parsed = false; // the parser reaches device.js's <script> tag only after signin.js has run
	const listeners: Record<string, (() => void)[]> = {};
	const document = {
		readyState: "loading",
		querySelector: (selector: string) => {
			if (selector === 'script[src="/fs/site/device.js"]') return parsed ? {} : null;
			if (selector.startsWith("meta[name=")) return { getAttribute: () => (selector.includes("fs-return") ? "/fs/device" : "google") };
			if (selector.includes("fs-card")) return { innerHTML: "", querySelector: () => null };
			return null;
		},
		addEventListener: (name: string, run: () => void) => { (listeners[name] ??= []).push(run); },
	};
	const window: Record<string, unknown> = {};
	runInNewContext(script, {
		window, document, URL, URLSearchParams,
		location: { search: "?user_code=ABCDEFGH", origin: "https://robotparts.dev", href: "https://robotparts.dev/fs/device?user_code=ABCDEFGH", replace: (to: string) => replaced.push(to) },
		fetch: async () => new Response(JSON.stringify({ user: { id: "u", email: "a@example.com" }, session: {} }), { status: 200 }),
	});
	parsed = true;
	document.readyState = "interactive";
	for (const run of listeners.DOMContentLoaded ?? []) run();
	await new Promise((done) => setTimeout(done, 10));
	assert.deepEqual(replaced, [], "signed in on the device page: it stays, with its code (the desktop lane saw a reload loop to /fs/device)");
});

// ------------------------------------------------------------------------------------------------ round-5 review

test("review r5 #6: the fresh-cache shortcut honours QUOTA_MAX_AGE_S too", async () => {
	const s3 = people();
	const store = new MemoryStore();
	const now = Date.parse("2026-10-27T12:00:00Z");
	const { deps } = fakeDeps(s3, store, { now: () => now });
	await store.setUsage(OWNER.userId, 0, 0, new Date(now - 200_000).toISOString()); // a 200 s old zero
	const e = env({ QUOTA_BYTES: "100", QUOTA_RECHECK_S: "300", QUOTA_MAX_AGE_S: "60" });
	const keys = await (await call(handle, e, deps, "/fs/v1/credentials", { origin: OWN, method: "POST", headers: { Authorization: "Bearer token-owner-laptop" } })).json();
	assert.equal(keys.ReadOnly, true, "older than the max age: measured again, and over (the review saw read-write keys on the cached zero)");
});

test("review r5 #1: GET /fs/v1/usage names whose usage it is, so a page can refuse another person's", async () => {
	const { deps } = fakeDeps(people());
	assert.equal((await (await call(handle, env(), deps, "/fs/v1/usage", { headers: cookie(OWNER) })).json()).owner, OWNER.userId);
	assert.equal((await (await call(handle, env(), deps, "/fs/v1/usage", { headers: cookie(SISTER) })).json()).owner, SISTER.userId);
});

test("review r5 #2: a deletion credit that lands after a complete measurement never takes the figure below what is stored", async () => {
	const s3 = people();
	const base = `users/${OWNER.userId}/robotparts/hosts/${MACHINE}/`;
	const m = JSON.parse(s3.text(`${base}manifest.json`)!);
	for (const [path, size] of [["cad/big.bin", 50_000], ["cad/other.bin", 11_000]] as const) {
		const body = "b".repeat(size);
		m.files.push({ path, size, mtime: "2026-10-26T11:00:00Z", sha256: createHash("sha256").update(body).digest("hex"), written_at: "2026-10-26T12:00:00Z" });
		s3.put(`${base}${path}`, body);
	}
	s3.put(`${base}manifest.json`, JSON.stringify(m));
	const store = new MemoryStore();
	let now = Date.parse("2026-10-27T12:00:00Z");
	const { deps } = fakeDeps(s3, store, { now: () => now });
	const tight = env({ QUOTA_BYTES: "1000" });
	const keys = async () => (await call(handle, tight, deps, "/fs/v1/credentials", { origin: OWN, method: "POST", headers: { Authorization: "Bearer token-owner-laptop" } })).json();
	assert.equal((await keys()).ReadOnly, true);
	// the per-file credit waits; meanwhile a complete measurement already sees the file gone
	const real = store.addUsage.bind(store);
	let release!: () => void;
	const gate = new Promise<void>((done) => { release = done; });
	let reached!: () => void;
	const atCredit = new Promise<void>((done) => { reached = done; });
	store.addUsage = async (owner: string, bytes: number, objects: number) => {
		if (objects < 0) { reached(); await gate; }
		return real(owner, bytes, objects);
	};
	const del = call(handle, tight, deps, `/fs/v1/folders/robotparts/hosts/${MACHINE}/delete`, { origin: OWN, method: "POST",
		headers: { Authorization: "Bearer token-owner-laptop", "Content-Type": "application/json" }, body: JSON.stringify({ job: JOB, from_seq: m.seq, paths: ["cad/big.bin"] }) });
	await atCredit;
	now += 601_000;
	assert.equal((await call(handle, tight, deps, "/fs/v1/usage", { headers: cookie(OWNER) })).status, 200);
	release();
	assert.equal((await del).status, 200);
	const counted = (await store.usage(OWNER.userId))!;
	assert.ok(counted.bytes >= 0, `the review saw the figure go to −38 KB: ${counted.bytes}`);
	assert.equal((await keys()).ReadOnly, true, "still over (11 KB stored against 1 KB): no write access");
	const after = (await store.usage(OWNER.userId))!;
	assert.deepEqual({ bytes: after.bytes, objects: after.objects }, stored(s3, OWNER), "measured again: the figure is what is stored");
});

test("review r6 #1: a delete cut off after its manifest commits keeps its cleanup when a later change moves the seq on", async () => {
	const s3 = people();
	const { core, storage, store, op, put } = await folderObject(s3);
	const base = `users/${OWNER.userId}/robotparts/hosts/${WEB}/`;
	const big = "x".repeat(10_000);
	assert.equal((await put("saved/x.json", big)).status, 200);
	assert.equal((await put("saved/y.json", big)).status, 200);
	// X's delete is cut off right after its manifest commits: saving committed: true never happens
	const realPut = storage.put;
	storage.put = async (key: string, value: unknown) => {
		if (key.startsWith("job:") && (value as { committed: boolean }).committed) throw new Error("the object restarted");
		return realPut(key, value);
	};
	await assert.rejects(op("DELETE", "saved/x.json", { permanent: true }));
	storage.put = realPut;
	// before the alarm, Y is deleted for good too: the manifest moves past X's job's seq
	assert.equal((await op("DELETE", "saved/y.json", { permanent: true })).status, 200);
	await core.alarm();
	assert.deepEqual(JSON.parse(s3.text(`${base}manifest.json`)!).files, [], "neither listed");
	assert.equal(s3.objects.has(`${base}saved/x.json`), false, "X's cleanup still ran (the review saw X stored, counted, and its job gone)");
	assert.equal(s3.objects.has(`${base}saved/y.json`), false);
	assert.equal(storage.alarm, null, "nothing left to do");
	assert.deepEqual(mismatched(s3), []);
	await staleUpperBound(store, s3);
});

test("review r6 #1: a delete job that never wrote its manifest is dropped when the seq moves on, and deletes nothing", async () => {
	const s3 = people();
	const { core, storage, op, put } = await folderObject(s3);
	const base = `users/${OWNER.userId}/robotparts/hosts/${WEB}/`;
	assert.equal((await put("saved/x.json", "x\n")).status, 200);
	// cut off before its manifest write: the bucket refuses the manifest PUT, and the object restarts there
	s3.fail = (method, key) => method === "PUT" && key === `${base}manifest.json`;
	await op("DELETE", "saved/x.json", { permanent: true }).catch(() => undefined);
	s3.fail = null;
	assert.equal((await put("saved/z.json", "z\n")).status, 200, "a later write moves the seq on");
	await core.alarm();
	assert.deepEqual(JSON.parse(s3.text(`${base}manifest.json`)!).files.map((f: { path: string }) => f.path), ["saved/x.json", "saved/z.json"]);
	assert.equal(s3.text(`${base}saved/x.json`), "x\n", "a file still listed is never deleted");
	assert.equal(storage.alarm, null);
});

test("review r6 #2: a measurement crossed by a write's charge keeps the charge, and its caller answers with the figure stored", async () => {
	const s3 = people();
	const store = new MemoryStore();
	let now = Date.parse("2026-10-27T12:00:00Z");
	const { deps } = fakeDeps(s3, store, { now: () => now });
	const usage = async () => (await call(handle, env(), deps, "/fs/v1/usage", { headers: cookie(OWNER) })).json();
	assert.equal((await usage()).used.bytes, stored(s3, OWNER).bytes, "measured once");
	now += 301_000; // past QUOTA_RECHECK_S: the next request measures again
	// that measurement has listed the root; before it stores its figure, a web write is admitted and charged
	const real = store.setUsage.bind(store);
	let release!: () => void;
	const gate = new Promise<void>((done) => { release = done; });
	let reached!: () => void;
	const listed = new Promise<void>((done) => { reached = done; });
	store.setUsage = async (...args: Parameters<MemoryStore["setUsage"]>) => {
		if (args[4] !== undefined) { reached(); await gate; }
		return real(...args);
	};
	const measuring = usage();
	await listed;
	const put = await call(handle, env(), deps, "/fs/v1/folders/robotparts/web/saved/late.json", { method: "PUT", headers: page(OWNER), body: "l".repeat(14_000) });
	assert.equal(put.status, 200);
	release();
	const answered = await measuring;
	const actual = stored(s3, OWNER);
	const cached = (await store.usage(OWNER.userId))!;
	assert.ok(cached.bytes >= actual.bytes && cached.objects >= actual.objects, `the review saw the charge erased: cached ${JSON.stringify(cached)}, stored ${JSON.stringify(actual)}`);
	assert.ok(answered.used.bytes >= actual.bytes, `the measuring request answers with the figure it stored, not its own listing: ${answered.used.bytes} < ${actual.bytes}`);
	// and so the quota holds: a quota between the listing and the truth gives read-only keys
	const tight = env({ QUOTA_BYTES: String(actual.bytes - 1) });
	assert.equal((await (await call(handle, tight, deps, "/fs/v1/credentials", { origin: OWN, method: "POST", headers: { Authorization: "Bearer token-owner-laptop" } })).json()).ReadOnly, true);
});

test("review r6 #3: an unchanged partial measurement is not taken again at once; a deletion asks for one sooner", async () => {
	const s3 = people();
	for (let n = 0; n < 2001; n++) s3.put(`users/${OWNER.userId}/a-bulk/${String(n).padStart(4, "0")}`, "x");
	const root = `users/${OWNER.userId}/`;
	const lists = () => s3.calls.filter((c) => c.method === "LIST" && c.prefix === root).length;
	const store = new MemoryStore();
	const now = Date.parse("2026-10-27T12:00:00Z");
	const { deps } = fakeDeps(s3, store, { now: () => now });
	const tight = env({ QUOTA_OBJECTS: "1000" });
	const keys = async () => (await call(handle, tight, deps, "/fs/v1/credentials", { origin: OWN, method: "POST", headers: { Authorization: "Bearer token-owner-laptop" } })).json();
	assert.equal((await keys()).ReadOnly, true);
	const once = lists();
	for (let n = 0; n < 9; n++) assert.equal((await keys()).ReadOnly, true);
	assert.equal(lists(), once, `ten requests, one measurement (the review saw twenty LISTs): ${lists()} LISTs`);
	// a deletion (here a machine's, through the Worker) asks for a measurement before the backoff is up
	const base = `users/${OWNER.userId}/robotparts/hosts/${MACHINE}/`;
	const m = JSON.parse(s3.text(`${base}manifest.json`)!);
	const del = await call(handle, tight, deps, `/fs/v1/folders/robotparts/hosts/${MACHINE}/delete`, { origin: OWN, method: "POST",
		headers: { Authorization: "Bearer token-owner-laptop", "Content-Type": "application/json" }, body: JSON.stringify({ job: JOB, from_seq: m.seq, paths: ["cad/bracket.step"] }) });
	assert.equal(del.status, 200);
	const before = lists();
	assert.equal((await keys()).ReadOnly, true);
	assert.ok(lists() > before, "measured again after the deletion");
});
