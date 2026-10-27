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
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appFor, apps } from "../src/apps.ts";
import { handle, rawPath, returnPath, segments, type Deps, type Env, type Person } from "../src/app.ts";
import { claimsOf, mint, ttlOf, userRoot } from "../src/creds.ts";
import { signUpAllowed } from "../src/signup.ts";
import { checkWebPath, deleteWebFile, stamp, writeWebFile } from "../src/webhost.ts";
import { S3Bucket } from "../src/s3-bucket.ts";
import { MemoryS3 } from "./memory-s3.ts";
import { MemoryStore } from "./memory-store.ts";

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
/** A write from the app's own page: its cookie, its Origin and the CSRF header. */
const page = (who: Person, extra: Record<string, string> = {}) => ({ ...cookie(who), Origin: SITE, "X-Folder-Sync": "1", ...extra });

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
		["no X-Folder-Sync", { ...cookie(OWNER), Origin: SITE }],
		["another site's Origin", { ...cookie(OWNER), Origin: "https://evil.example", "X-Folder-Sync": "1" }],
		["no Origin", { ...cookie(OWNER), "X-Folder-Sync": "1" }],
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
	assert.equal(ttlOf({}), 900);
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
	// the manifest PUT and the roll-back both fail (the storage is down): the next write puts it right first
	s3.fail = (method, key) => (method === "PUT" && key === manifestKey) || method === "COPY" || method === "DELETE";
	await assert.rejects(at("saved/x.json", "three\n"));
	s3.fail = null;
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
