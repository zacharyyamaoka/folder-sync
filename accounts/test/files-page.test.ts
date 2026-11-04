// The Files page (PEP 0007's sync view, the Files tab; docs/API.md "The Files tab"): what the Worker owes it, on bare
// Node over the in-memory S3. The tab itself adds no data route (it lists with GET …/folders/:project, opens with
// …/files/…, writes with PUT and DELETE …/web/…), so this pins that those routes do what a file browser needs:
// - GET /fs/files, the standalone page: signed out is sent to sign in, the page's own CSP lets a file be previewed
//   (images, media, a PDF frame) and nothing else, it is never framed, and its two site files are served;
// - the audio and image suffixes a preview needs are served as what they are;
// - the boundary: signed out is 401, another person is 404, a cookie write needs the CSRF headers;
// - a machine's files are read-only: the web host's routes never write or delete them;
// - upload, replace, rename (read, write at the new path, delete the old) and delete, with the old bytes kept.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { handle, type Deps, type Env, type Person } from "../src/app.ts";
import { MemoryS3 } from "./memory-s3.ts";
import { MemoryStore } from "./memory-store.ts";

const SITE = "https://robotparts.dev";
const ENDPOINT = "https://acct0123.r2.cloudflarestorage.com";
const BUCKET = "folder-sync";
const MACHINE = "b55e9683-7854-4121-a56a-9bae7c3ab1da";
const SISTER_MACHINE = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OWNER: Person = { userId: "ownerABC123", email: "owner@example.com", name: "Owner", image: null, sessionId: "sess-owner", sessionToken: "tok-owner" };
const SISTER: Person = { userId: "ownerABC1234", email: "sister@example.com", name: "Sister", image: null, sessionId: "sess-sister", sessionToken: "tok-sister" };
const NOW = Date.parse("2026-11-04T12:00:00Z");
const PLAN = "# Plan\n\n- order the clamp\n";

const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

function env(extra: Partial<Env> = {}): Env {
	const files = new Map([["/files.js", "// files page"], ["/files.css", "/* files page */"]]);
	return {
		ENVIRONMENT: "production",
		PUBLIC_URL: "https://accounts.example.test",
		R2_ACCOUNT_ID: "acct0123",
		R2_PARENT_ACCESS_KEY_ID: "parent-key-id",
		R2_PARENT_SECRET_ACCESS_KEY: "parent-secret-fixture",
		SYNC_BUCKET: BUCKET,
		ASSETS: { fetch: async (request: Request) => (files.has(new URL(request.url).pathname) ? new Response(files.get(new URL(request.url).pathname)) : new Response("", { status: 404 })) },
		...extra,
	};
}

/** A folder with one machine ("bam-GPU") and its files, for `person`; no web host yet. */
function seed(s3: MemoryS3, person: Person, host: string, name: string, files: Record<string, string | Uint8Array>) {
	const base = `users/${person.userId}/notes/hosts/${host}/`;
	s3.put(`${base}manifest.json`, JSON.stringify({
		schema: "folder-sync-manifest/1", project: "notes", host_id: host, host_name: name, seq: 3, generated_at: "2026-11-04T10:00:00Z",
		files: Object.entries(files).map(([path, data]) => ({ path, size: data.length, mtime: "2026-11-04T09:00:00Z", sha256: sha(data), written_at: "2026-11-04T10:00:00Z" })),
	}));
	for (const [path, data] of Object.entries(files)) s3.put(`${base}${path}`, data);
}

function setup() {
	const s3 = new MemoryS3(ENDPOINT, BUCKET);
	s3.now = () => clock.at;
	const clock = { at: NOW };
	const store = new MemoryStore();
	seed(s3, OWNER, MACHINE, "bam-GPU", { "notes/plan.md": PLAN, "cad/bracket.step": "ISO-10303-21;\n", "photo.png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) });
	seed(s3, SISTER, SISTER_MACHINE, "sister-laptop", { "private.md": "the sister's\n" });
	const browsers = new Map<string, Person>([[OWNER.sessionId, OWNER], [SISTER.sessionId, SISTER]]);
	let ids = 0;
	const deps: Deps = {
		auth: async () => new Response("{}"),
		async person(request, via) {
			if (via === "bearer") return null;
			const id = /(?:^|;\s*)s=([^;]+)/.exec(request.headers.get("Cookie") || "")?.[1];
			return id ? (browsers.get(id) ?? null) : null;
		},
		signOut: async () => [],
		store,
		s3: s3.fetch,
		now: () => clock.at,
		uuid: () => `3f1c2a9e-5b7d-4c11-8e2f-${String(ids++).padStart(12, "0")}`,
	};
	return { s3, store, deps, clock };
}

type World = ReturnType<typeof setup>;

const as = (who: Person | null) => (who ? { Cookie: `s=${who.sessionId}` } : {});
/** A write from the page: its cookie, its Origin, the CSRF header and the user it shows. */
const page = (who: Person, extra: Record<string, string> = {}) => ({ ...as(who), Origin: SITE, "X-Folder-Sync": "1", "X-Folder-Sync-User": who.userId, ...extra });

function ask(w: World, path: string, init: RequestInit = {}, e: Env = env()): Promise<Response> {
	return handle(new Request(`${SITE}${path}`, init), e, w.deps);
}

const listing = async (w: World, who: Person | null = OWNER) => {
	const res = await ask(w, "/fs/v1/folders/notes", { headers: as(who) });
	return { res, body: (await res.json()) as any };
};
const webOf = (body: any) => body.hosts.find((h: any) => h.web);
const filesOf = (body: any, host: string) => body.files.filter((f: any) => f.host === host).map((f: any) => f.path).sort();
const put = (w: World, path: string, body: string | Uint8Array, who: Person = OWNER, extra: Record<string, string> = {}) =>
	ask(w, `/fs/v1/folders/notes/web/${path}`, { method: "PUT", headers: page(who, extra), body });
const del = (w: World, path: string, who: Person = OWNER) => ask(w, `/fs/v1/folders/notes/web/${path}`, { method: "DELETE", headers: page(who) });
const read = (w: World, host: string, path: string, who: Person | null = OWNER) => ask(w, `/fs/v1/folders/notes/files/${host}/${path}`, { headers: as(who) });

// ------------------------------------------------------------------------------------------------ the page

test("GET /fs/files: signed out is sent to sign in and back; signed in gets the page, its policy and no frame", async () => {
	const w = setup();
	const out = await ask(w, "/fs/files?project=notes", { redirect: "manual" });
	assert.equal(out.status, 303);
	assert.equal(out.headers.get("Location"), "/fs/signin?return=%2Ffs%2Ffiles%3Fproject%3Dnotes");
	const page = await ask(w, "/fs/files", { headers: as(OWNER) });
	assert.equal(page.status, 200);
	assert.match(page.headers.get("Content-Type") || "", /^text\/html/);
	const html = await page.text();
	assert.match(html, /<script src="\/fs\/site\/files\.js"><\/script>/);
	assert.match(html, /<link rel="stylesheet" href="\/fs\/site\/files\.css">/);
	assert.match(html, /data-user="ownerABC123"/);
	assert.ok(!/<script>/.test(html) && !/ on[a-z]+=/.test(html), "no inline script or handler");
	const policy = page.headers.get("Content-Security-Policy") || "";
	const directive = (name: string) => policy.split(/;\s*/).find((d) => d.startsWith(`${name} `));
	// what a preview needs from the page's own origin, and nothing from anywhere else
	assert.equal(directive("default-src"), "default-src 'none'");
	assert.equal(directive("script-src"), "script-src 'self'");
	assert.equal(directive("connect-src"), "connect-src 'self'");
	assert.equal(directive("media-src"), "media-src 'self'");
	assert.equal(directive("frame-src"), "frame-src 'self'");
	assert.match(directive("img-src") || "", /^img-src 'self' data:$/);
	assert.equal(directive("frame-ancestors"), "frame-ancestors 'none'");
	assert.equal(directive("object-src"), "object-src 'none'");
	assert.ok(!/unsafe-eval|\*|https?:/.test(policy), policy);
	assert.equal(page.headers.get("X-Frame-Options"), "DENY");
	assert.equal(page.headers.get("Cache-Control"), "no-store");
});

test("GET /fs/files: HEAD has no body, other methods are 405, an origin no app lists gets 404, the title names the app", async () => {
	const w = setup();
	const head = await ask(w, "/fs/files", { method: "HEAD", headers: as(OWNER) });
	assert.equal(head.status, 200);
	assert.equal(await head.text(), "");
	for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await ask(w, "/fs/files", { method, headers: page(OWNER) })).status, 405, method);
	const stranger = await handle(new Request("https://evil.example/fs/files", { headers: as(OWNER) }), env(), w.deps);
	assert.equal(stranger.status, 404);
	assert.equal((await stranger.json() as any).error, "unknown_origin");
	assert.equal((await ask(w, "/fs/files/extra", { headers: as(OWNER) })).status, 404);
	assert.match(await (await ask(w, "/fs/files", { headers: as(OWNER) })).text(), /<title>Files · Robot Parts<\/title>/);
});

test("/fs/site/files.js and files.css are served from the Worker's assets, and only those", async () => {
	const w = setup();
	const js = await ask(w, "/fs/site/files.js");
	assert.equal(js.status, 200);
	assert.match(js.headers.get("Content-Type") || "", /^text\/javascript/);
	const css = await ask(w, "/fs/site/files.css");
	assert.equal(css.status, 200);
	assert.match(css.headers.get("Content-Type") || "", /^text\/css/);
	assert.equal((await ask(w, "/fs/site/other.js")).status, 404);
});

// ------------------------------------------------------------------------------------------------ what a preview is served as

test("…/files/ serves what a preview shows as what it is: audio, images, PDF, video, text; none of it sandboxed", async () => {
	const w = setup();
	const kinds: [string, string][] = [
		["a.mp3", "audio/mpeg"], ["a.wav", "audio/wav"], ["a.ogg", "audio/ogg"], ["a.oga", "audio/ogg"], ["a.opus", "audio/ogg"], ["a.m4a", "audio/mp4"],
		["a.flac", "audio/flac"], ["a.aac", "audio/aac"], ["a.png", "image/png"], ["a.avif", "image/avif"], ["a.bmp", "image/bmp"], ["a.ico", "image/x-icon"],
		["a.pdf", "application/pdf"], ["a.webm", "video/webm"], ["a.md", "text/markdown; charset=utf-8"], ["a.json", "application/json; charset=utf-8"], ["a.txt", "text/plain; charset=utf-8"],
	];
	seed(w.s3, OWNER, MACHINE, "bam-GPU", Object.fromEntries(kinds.map(([name]) => [name, `bytes of ${name}`])));
	for (const [name, type] of kinds) {
		const res = await read(w, MACHINE, name);
		assert.equal(res.status, 200, name);
		assert.equal(res.headers.get("Content-Type"), type, name);
		assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff", name);
		assert.equal(res.headers.get("Content-Security-Policy"), null, `${name} is not active content`);
		assert.equal(res.headers.get("Accept-Ranges"), "bytes", name);
		await res.arrayBuffer();
	}
});

// ------------------------------------------------------------------------------------------------ the boundary

test("the listing and the bytes: signed out is 401, another person is 404, a stranger never learns the folder exists", async () => {
	const w = setup();
	const out = await listing(w, null);
	assert.equal(out.res.status, 401);
	assert.equal(out.body.error, "signed_out");
	assert.equal((await read(w, MACHINE, "notes/plan.md", null)).status, 401);
	const sister = await ask(w, `/fs/v1/folders/notes?owner=${OWNER.userId}`, { headers: as(SISTER) });
	assert.equal(sister.status, 404);
	assert.equal((await ask(w, `/fs/v1/folders/notes/files/${MACHINE}/notes/plan.md?owner=${OWNER.userId}`, { headers: as(SISTER) })).status, 404);
	// her own listing is her own folder, whatever the host ids in it
	const hers = await listing(w, SISTER);
	assert.equal(hers.res.status, 200);
	assert.deepEqual(hers.body.files.map((f: any) => f.path), ["private.md"]);
	assert.equal(hers.body.owner, SISTER.userId);
	// the owner's: the machine's three files, with the device's name for the group
	const mine = await listing(w);
	assert.equal(mine.body.owner, OWNER.userId);
	assert.deepEqual(mine.body.hosts.map((h: any) => [h.id, h.name, h.web]), [[MACHINE, "bam-GPU", false]]);
	assert.deepEqual(filesOf(mine.body, MACHINE), ["cad/bracket.step", "notes/plan.md", "photo.png"]);
	const entry = mine.body.files.find((f: any) => f.path === "notes/plan.md");
	assert.deepEqual(Object.keys(entry).sort(), ["host", "mtime", "path", "sha256", "size", "writtenAt"]);
	assert.equal(entry.size, PLAN.length);
	assert.equal(entry.sha256, sha(PLAN));
});

test("writes from the page need the CSRF headers and the user it shows; a delete or upload for no one is refused", async () => {
	const w = setup();
	const bare = await ask(w, "/fs/v1/folders/notes/web/a.txt", { method: "PUT", headers: { ...as(OWNER), Origin: SITE }, body: "x" });
	assert.equal(bare.status, 403);
	assert.equal(((await bare.json()) as any).error, "csrf");
	const wrong = await ask(w, "/fs/v1/folders/notes/web/a.txt", { method: "PUT", headers: page(OWNER, { "X-Folder-Sync-User": SISTER.userId }), body: "x" });
	assert.equal(wrong.status, 409);
	assert.equal((await put(w, "a.txt", "x", OWNER)).status, 200);
	assert.equal((await ask(w, "/fs/v1/folders/notes/web/a.txt", { method: "DELETE", headers: as(null) })).status, 401);
	assert.equal(webOf((await listing(w)).body).name, "web");
});

// ------------------------------------------------------------------------------------------------ read-only devices

test("another device's files are read-only: the web host's PUT and DELETE never touch them", async () => {
	const w = setup();
	const machineKeys = () => [...w.s3.objects].filter(([k]) => k.startsWith(`users/${OWNER.userId}/notes/hosts/${MACHINE}/`)).map(([k, v]) => [k, sha(v)]);
	const before = machineKeys();
	// the same path the machine publishes, written through the page: a second, separate file on the web host
	assert.equal((await put(w, "notes/plan.md", "# the web's plan\n")).status, 200);
	assert.deepEqual(machineKeys(), before, "the machine's objects, manifest included, are byte for byte the same");
	const after = await listing(w);
	const web = webOf(after.body);
	assert.deepEqual(filesOf(after.body, web.id), ["notes/plan.md"]);
	assert.equal(await (await read(w, MACHINE, "notes/plan.md")).text(), PLAN);
	assert.equal(await (await read(w, web.id, "notes/plan.md")).text(), "# the web's plan\n");
	// a path only the machine has cannot be deleted through the page: there is nothing of that name on the web host
	const gone = await del(w, "cad/bracket.step");
	assert.equal(gone.status, 404);
	assert.deepEqual(machineKeys(), before);
	assert.equal((await read(w, MACHINE, "cad/bracket.step")).status, 200);
	// and the machine's host id is not a route a write can name
	const sneaky = await ask(w, `/fs/v1/folders/notes/web/..%2Fhosts%2F${MACHINE}%2Fnotes%2Fplan.md`, { method: "PUT", headers: page(OWNER), body: "owned" });
	assert.equal(sneaky.status, 400);
	assert.deepEqual(machineKeys(), before);
});

// ------------------------------------------------------------------------------------------------ upload, rename, delete

test("upload, replace, rename and delete: the web host's files change and every old version is kept", async () => {
	const w = setup();
	const bytes = new Uint8Array([0, 255, 1, 254, 2, 253]);
	assert.equal((await put(w, "scan.bin", bytes)).status, 200);
	assert.equal((await put(w, "ideas.md", "# ideas\n")).status, 200);
	let now = await listing(w);
	const web = webOf(now.body);
	assert.deepEqual(filesOf(now.body, web.id), ["ideas.md", "scan.bin"]);
	assert.deepEqual(new Uint8Array(await (await read(w, web.id, "scan.bin")).arrayBuffer()), bytes, "binary bytes survive");

	// replace: the new bytes are live, the old ones are a kept version
	w.clock.at += 120_000;
	assert.equal((await put(w, "ideas.md", "# ideas v2\n")).status, 200);
	assert.equal(await (await read(w, web.id, "ideas.md")).text(), "# ideas v2\n");
	const versions = (await (await ask(w, `/fs/v1/folders/notes/history/${web.id}/ideas.md`, { headers: as(OWNER) })).json()) as any;
	assert.equal(versions.live.size, "# ideas v2\n".length);
	assert.equal(versions.versions.length, 1);

	// rename = read the bytes, write them at the new path, delete the old path (what the tab does)
	w.clock.at += 120_000;
	const old = await (await read(w, web.id, "ideas.md")).arrayBuffer();
	assert.equal((await put(w, "notes/ideas-2026.md", new Uint8Array(old))).status, 200);
	assert.equal((await del(w, "ideas.md")).status, 200);
	now = await listing(w);
	assert.deepEqual(filesOf(now.body, web.id), ["notes/ideas-2026.md", "scan.bin"]);
	assert.equal(await (await read(w, web.id, "notes/ideas-2026.md")).text(), "# ideas v2\n");
	assert.equal((await read(w, web.id, "ideas.md")).status, 404);

	// delete: gone from the listing, listed under Deleted files with a version to restore, the machine's files untouched
	w.clock.at += 120_000;
	assert.equal((await del(w, "scan.bin")).status, 200);
	now = await listing(w);
	assert.deepEqual(filesOf(now.body, web.id), ["notes/ideas-2026.md"]);
	const deleted = (await (await ask(w, "/fs/v1/folders/notes/deleted", { headers: as(OWNER) })).json()) as any;
	assert.deepEqual(deleted.files.filter((f: any) => f.host === web.id).map((f: any) => f.path).sort(), ["ideas.md", "scan.bin"]);
	assert.deepEqual(filesOf(now.body, MACHINE), ["cad/bracket.step", "notes/plan.md", "photo.png"]);
});

test("upload lands in the signed-in person's own web host: the sister's upload is hers and the owner never sees it", async () => {
	const w = setup();
	assert.equal((await put(w, "mine.txt", "owner's")).status, 200);
	assert.equal((await put(w, "hers.txt", "sister's", SISTER)).status, 200);
	const mine = await listing(w, OWNER);
	const hers = await listing(w, SISTER);
	assert.deepEqual(mine.body.files.map((f: any) => f.path).sort(), ["cad/bracket.step", "mine.txt", "notes/plan.md", "photo.png"]);
	assert.deepEqual(hers.body.files.map((f: any) => f.path).sort(), ["hers.txt", "private.md"]);
	assert.notEqual(webOf(mine.body).id, webOf(hers.body).id);
	assert.ok([...w.s3.objects.keys()].every((k) => !k.includes("hers.txt") || k.startsWith(`users/${SISTER.userId}/`)));
});

test("the web host takes 32 MiB and no more, and says so; a bad name is 400 with a reason", async () => {
	const w = setup();
	const big = await ask(w, "/fs/v1/folders/notes/web/big.bin", { method: "PUT", headers: page(OWNER, { "Content-Length": String(33 * 1024 * 1024) }), body: "x" });
	assert.equal(big.status, 413);
	assert.equal(((await big.json()) as any).error, "too_large");
	for (const name of ["manifest.json", "con.txt", "a%5Cb.txt", "trailing."]) {
		const bad = await put(w, name, "x");
		assert.equal(bad.status, 400, name);
		assert.ok(((await bad.json()) as any).why, name);
	}
	assert.equal(webOf((await listing(w)).body), undefined, "nothing was created");
});

test("the account page links to the Files page", async () => {
	const w = setup();
	const html = await (await ask(w, "/fs/account", { headers: as(OWNER) })).text();
	assert.match(html, /<a href="\/fs\/files" data-testid="fs-files-link">Browse your files<\/a>/);
});
