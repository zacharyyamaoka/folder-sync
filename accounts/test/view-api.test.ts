// The sync view's API online (PEP 0007 §5.2, docs/API.md) against its shared fixtures: every testdata/view-api/
// fixture with "worker" in `servers` is sent to the Worker over a bucket built from the fixture's `given` (the one
// folder below, which the fixtures describe), and its status and body must be exactly the fixture's.
//
// What a fixture says is compared by presence only (a minted request id, an opaque cursor) is compared by presence.
// Then the auth rules over the real accounts layer (test/real-auth.ts): a revoked session, a non-owner and a reader;
// then the mutations that turn those tests red.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { handle, type Deps, type Env, type Person } from "../src/app.ts";
import { MemoryS3 } from "./memory-s3.ts";
import { MemoryStore } from "./memory-store.ts";
import { realStack } from "./real-auth.ts";

const ENDPOINT = "https://acct0123.r2.cloudflarestorage.com";
const BUCKET = "folder-sync";
const SITE = "https://robotparts.dev";
const NOW = Date.parse("2026-10-28T21:15:00.000Z");
const OWNER: Person = { userId: "AbC123zz9yX8", email: "zach@example.com", name: "Zach", image: null, sessionId: "sess-owner", sessionToken: "tok-owner" };
const READER: Person = { userId: "ReaDer0000001", email: "reader@example.com", name: "Reader", image: null, sessionId: "sess-reader", sessionToken: "tok-reader" };
const ROOT = `users/${OWNER.userId}/`;
const GPU = "b55e9683-7854-4121-a56a-9bae7c3ab1da";
const WEB = "e2a0b1c2-d3e4-4f50-9a1b-2c3d4e5f6a7b";
const LAPTOP = "7c1d2e3f-0a1b-4c2d-8e3f-405162738495";
const TESTDATA = new URL("../../testdata/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, TESTDATA), "utf8");
const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
type Fixture = { name: string; servers: string[]; request: { method: string; path: string; auth?: string; body?: unknown }; response: { status: number; body: unknown } };

function env(extra: Partial<Env> = {}): Env {
	return { ENVIRONMENT: "production", PUBLIC_URL: "https://accounts.example.test", R2_ACCOUNT_ID: "acct0123", R2_PARENT_ACCESS_KEY_ID: "parent-key-id", R2_PARENT_SECRET_ACCESS_KEY: "parent-secret-fixture", SYNC_BUCKET: BUCKET, ...extra };
}

const entry = (path: string, size: number, sha256: string, writtenAt: string) => ({ path, size, mtime: writtenAt, sha256, written_at: writtenAt });
const manifest = (host: string, name: string, seq: number, generatedAt: string, files: ReturnType<typeof entry>[]) =>
	JSON.stringify({ schema: "folder-sync-manifest/1", project: "notes", host_id: host, host_name: name, seq, generated_at: generatedAt, files: [...files].sort((a, b) => (a.path < b.path ? -1 : 1)) });

/** The restored version of web's hearts/clamp-24.json and its bytes (restore-online's given.bytes). */
const CLAMP_VERSION = "2026-10-28T19:02:11.481Z_763d2e71f45a8d0f";
const CLAMP_OLD: string = JSON.parse(read("view-api/restore-online.json")).given.bytes[`${WEB}/hearts/clamp-24.json@${CLAMP_VERSION}`];

/** The folder the fixtures describe: bam-GPU (seq 46), web (seq 7, or 6 before restore-online's restore) and
 *  bam-laptop (seq 12), each version at its left_at, the change and pull records of testdata/changes/ and
 *  testdata/pulls/, testdata/requests/web-pending.json and web-answered.json, and a fresh usage measurement. */
function notes(fixture: string): { s3: MemoryS3; store: MemoryStore } {
	const s3 = new MemoryS3(ENDPOINT, BUCKET);
	s3.now = () => NOW;
	const store = new MemoryStore();
	const at = (key: string, data: string | Uint8Array, leftAt: string) => s3.put(`${ROOT}${key}`, data, Date.parse(leftAt));
	at(`notes/hosts/${GPU}/manifest.json`, manifest(GPU, "bam-GPU", 46, "2026-10-28T21:10:00.000Z", [
		entry("notes/plan.md", 1980, "9f2c1a3b4c5d6e7f00112233445566778899aabbccddeeff0011223344556677", "2026-10-28T20:46:12.004Z"),
		entry("notes/new-idea.md", 311, "4a1f0c9e8d7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f", "2026-10-28T20:41:00.402Z"),
		entry("notes/scratch.md", 12, "0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c", "2026-10-28T20:41:00.415Z"),
		entry("logs/agent.log", 88123, "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef", "2026-10-28T20:41:00.418Z"),
	]), "2026-10-28T21:10:00.000Z");
	const restoreFirst = fixture === "restore-online";
	const clamp = restoreFirst ? entry("hearts/clamp-24.json", 233, "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00", "2026-10-28T20:47:28.790Z")
		: entry("hearts/clamp-24.json", CLAMP_OLD.length, sha(CLAMP_OLD), "2026-10-28T20:50:00.010Z");
	at(`notes/hosts/${WEB}/manifest.json`, manifest(WEB, "web", restoreFirst ? 6 : 7, restoreFirst ? "2026-10-28T20:47:28.802Z" : "2026-10-28T20:50:00.020Z", [clamp]), "2026-10-28T20:50:00.020Z");
	at(`notes/hosts/${WEB}/hearts/clamp-24.json`, "x".repeat(clamp.size), clamp.written_at);
	at(`notes/hosts/${LAPTOP}/manifest.json`, manifest(LAPTOP, "bam-laptop", 12, "2026-10-22T14:05:00.000Z", [
		entry("notes/laptop-todo.md", 77, "e1d2c3b4a59687780011223344556677889900aabbccddeeff00112233445566", "2026-10-22T10:00:00.000Z"),
	]), "2026-10-22T14:05:00.000Z");
	// kept versions (testdata/view-api/history*.json, deleted*.json), at their left_at
	const kept = (host: string, path: string, version: string, size: number, leftAt: string, data?: string) => at(`_history/notes/${host}/${path}/${version}`, data ?? "v".repeat(size), leftAt);
	kept(GPU, "notes/plan.md", "2026-10-28T20:41:00.410Z_7e3b9d0a1c2f4e5d", 2140, "2026-10-28T20:46:12.004Z");
	kept(GPU, "notes/plan.md", "2026-10-28T20:31:00.117Z_9f2c1a3b4c5d6e7f", 1980, "2026-10-28T20:41:00.410Z");
	kept(GPU, "notes/plan.md", "2026-10-28T20:00:00.000Z_unlisted", 2001, "2026-10-28T20:00:00.000Z");
	kept(GPU, "notes/plan.md", "2026-10-28T18:02:41.502Z_1b2c3d4e5f607182", 1402, "2026-10-28T18:50:00.000Z");
	kept(GPU, "notes/old-ideas.md", "2026-10-21T09:12:44.500Z_5555666677778888", 5121, "2026-10-28T20:41:00.420Z");
	kept(WEB, "hearts/arm-17.json", "2026-10-26T10:00:00.999Z_aaaabbbbccccdddd", 233, "2026-10-28T14:20:00.000Z");
	kept(WEB, "hearts/clamp-24.json", CLAMP_VERSION, CLAMP_OLD.length, "2026-10-28T20:47:28.790Z", CLAMP_OLD);
	kept(LAPTOP, "photos/IMG_2231.jpg", "2026-10-22T14:03:51.090Z_2c4e6a8b0d1f3e5a", 2811409, "2026-10-22T14:05:00.000Z");
	// change records and pull records, as published
	// restore-online starts before web's seq 7: its restore writes that record
	for (const name of ["machine-000000000043.json", "machine-restore-000000000044.json", "web-000000000006.json", ...(restoreFirst ? [] : ["web-restore-000000000007.json"])]) {
		const record = JSON.parse(read(`changes/${name}`));
		at(`_changes/notes/${record.host_id}/${String(record.seq).padStart(12, "0")}.json`, JSON.stringify(record), record.at);
	}
	for (const name of readdirSync(new URL("pulls/", TESTDATA))) {
		const record = JSON.parse(read(`pulls/${name}`));
		at(`_changes/notes/${record.host_id}/pulls/${record.at}.json`, JSON.stringify(record), record.at);
	}
	for (const name of ["web-pending.json", "web-answered.json"]) {
		const request = JSON.parse(read(`requests/${name}`));
		at(`_requests/notes/${request.host}/${request.id}.json`, JSON.stringify(request), request.outcome?.at ?? request.at);
	}
	if (fixture === "purge-older") {
		// free up space: 1,001 versions older than 7 days, the first 1,000 (in key order) 48,211,002 bytes
		for (let n = 0; n <= 1000; n++) kept(GPU, `bulk/${String(n).padStart(4, "0")}.bin`, "2026-10-01T00:00:00.000Z_0123456789abcdef", n === 0 ? 48213 : 48211, "2026-10-01T00:00:01.000Z");
	}
	store.webHosts.set(`${OWNER.userId}\u0000notes`, WEB);
	store.rows.set(`${OWNER.userId}\u0000notes`, { owner_id: OWNER.userId, project: "notes", visibility: fixture === "status-public" ? "public" : "private", updated_at: "2026-10-01T00:00:00Z" });
	store.readerRows.set(`${OWNER.userId}\u0000notes`, new Set([READER.email]));
	store.usageRows.set(OWNER.userId, { bytes: 15802467, objects: 412, measured_at: new Date(NOW - 1000).toISOString(), history: { bytes: 2345678, objects: 111 } });
	return { s3, store };
}

function deps(s3: MemoryS3, store: MemoryStore): Deps {
	const people = new Map([[OWNER.sessionId, OWNER], [READER.sessionId, READER]]);
	return {
		auth: async () => new Response("{}"),
		async person(request, via) {
			if (via === "bearer") return null;
			const id = /(?:^|;\s*)s=([^;]+)/.exec(request.headers.get("Cookie") || "")?.[1];
			return id ? (people.get(id) ?? null) : null;
		},
		signOut: async () => [],
		store,
		s3: s3.fetch,
		now: () => NOW,
		uuid: () => crypto.randomUUID(),
	};
}

function headersFor(auth: string | undefined, method: string, name: string): Record<string, string> {
	if (auth === "owner") {
		const base: Record<string, string> = { Cookie: `s=${OWNER.sessionId}`, "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0.0.0 Safari/537.36" };
		if (method !== "POST") return base;
		// error-csrf: a cookie restore without X-Folder-Sync: 1 (everything else a page sends)
		return name === "error-csrf" ? { ...base, Origin: SITE, "X-Folder-Sync-User": OWNER.userId, "Content-Type": "application/json" }
			: { ...base, Origin: SITE, "X-Folder-Sync": "1", "X-Folder-Sync-User": OWNER.userId, "Content-Type": "application/json" };
	}
	if (auth === "reader") return { Cookie: `s=${READER.sessionId}` };
	return {};
}

const FIXTURES = readdirSync(new URL("view-api/", TESTDATA)).filter((f) => f.endsWith(".json")).sort();

async function answer(name: string, h = handle) {
	const fx = JSON.parse(read(`view-api/${name}.json`)) as Fixture;
	const { s3, store } = notes(name);
	const d = deps(s3, store);
	const init: RequestInit = { method: fx.request.method, headers: headersFor(fx.request.auth, fx.request.method, name) };
	if (fx.request.body !== undefined) init.body = JSON.stringify(fx.request.body);
	const res = await h(new Request(`${SITE}${fx.request.path}`, init), env(), d);
	const body = res.headers.get("Content-Type")?.startsWith("application/json") ? await res.json() : await res.text();
	return { fx, res, body, s3, store };
}

for (const file of FIXTURES) {
	const name = file.replace(/\.json$/, "");
	const fx = JSON.parse(read(`view-api/${file}`)) as Fixture;
	if (!fx.servers.includes("worker")) continue;
	test(`testdata/view-api/${file}: ${fx.name}`, async () => {
		const { fx: f, res, body } = await answer(name);
		const expected = structuredClone(f.response.body) as Record<string, any>;
		const got = structuredClone(body) as Record<string, any>;
		// compared by presence and shape only, as the fixture's given says
		if (name === "activity-page") {
			assert.equal(typeof got.next, "string", "a next cursor");
			got.next = expected.next;
		}
		if (name === "restore-online") {
			for (const r of got.requested ?? []) assert.match(r.request, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
			got.requested = got.requested?.map((r: Record<string, unknown>, i: number) => ({ ...r, request: expected.requested[i]?.request }));
		}
		assert.equal(res.status, f.response.status, JSON.stringify(body));
		assert.deepEqual(got, expected);
	});
}

test("activity pages: following next from limit=1 returns the whole online fixture, in order, each event once", async () => {
	const all = JSON.parse(read("view-api/activity-online.json")).response.body.events;
	const { s3, store } = notes("activity-online");
	const d = deps(s3, store);
	const seen = [];
	let before: string | null = null;
	for (let page = 0; page < 40; page++) {
		const path: string = `/fs/v1/folders/notes/activity?limit=3${before ? `&before=${encodeURIComponent(before)}` : ""}`;
		const body: { events: unknown[]; next: string | null } = await (await handle(new Request(`${SITE}${path}`, { headers: headersFor("owner", "GET", "") }), env(), d)).json();
		seen.push(...body.events);
		before = body.next;
		if (!before) break;
	}
	assert.deepEqual(seen, all);
	// level and host filters
	const warn = await (await handle(new Request(`${SITE}/fs/v1/folders/notes/activity?level=warn`, { headers: headersFor("owner", "GET", "") }), env(), d)).json();
	assert.deepEqual(warn, { events: [], next: null });
	const laptop = await (await handle(new Request(`${SITE}/fs/v1/folders/notes/activity?host=${LAPTOP}`, { headers: headersFor("owner", "GET", "") }), env(), d)).json();
	assert.deepEqual(laptop.events.map((e: { event: string; host: string }) => [e.event, e.host]), [["remove_copy", LAPTOP], ["download", LAPTOP]]);
	for (const bad of ["limit=0", "limit=501", "level=info", "host=nope", "before=%25%25"]) {
		assert.equal((await handle(new Request(`${SITE}/fs/v1/folders/notes/activity?${bad}`, { headers: headersFor("owner", "GET", "") }), env(), d)).status, 400, bad);
	}
});

test("history ?version=: the bytes, typed by suffix, never this site's page; restore-online leaves its request in the bucket", async () => {
	const { s3, store } = notes("history");
	const d = deps(s3, store);
	const get = (path: string) => handle(new Request(`${SITE}${path}`, { headers: headersFor("owner", "GET", "") }), env(), d);
	const bytes = await get(`/fs/v1/folders/notes/history/${GPU}/notes/plan.md?version=2026-10-28T20:31:00.117Z_9f2c1a3b4c5d6e7f`);
	assert.equal(bytes.status, 200);
	assert.equal(bytes.headers.get("Content-Type"), "text/markdown; charset=utf-8");
	assert.equal(bytes.headers.get("X-Folder-Sync-Version"), "2026-10-28T20:31:00.117Z_9f2c1a3b4c5d6e7f");
	assert.equal(bytes.headers.get("Cache-Control"), "private, no-store");
	assert.equal(bytes.headers.get("X-Content-Type-Options"), "nosniff");
	assert.equal(await bytes.text(), "v".repeat(1980));
	s3.put(`${ROOT}_history/notes/${GPU}/page.html/2026-10-28T20:00:00.000Z_0011223344556677`, "<script>alert(1)</script>", NOW - 60_000);
	const html = await get(`/fs/v1/folders/notes/history/${GPU}/page.html?version=2026-10-28T20:00:00.000Z_0011223344556677`);
	assert.equal(html.headers.get("Content-Security-Policy"), "sandbox");
	// restore-online's machine items: one request for bam-laptop, created once, in the contract's shape
	const restored = await answer("restore-online");
	const id = restored.body.requested[0].request;
	const request = JSON.parse(restored.s3.text(`${ROOT}_requests/notes/${LAPTOP}/${id}.json`)!);
	assert.deepEqual(request, { schema: "folder-sync-restore/1", id, project: "notes", host: LAPTOP, at: new Date(NOW).toISOString(), by: { kind: "web", name: "Chrome on Linux" },
		items: [{ path: "photos/IMG_2231.jpg", version: "2026-10-22T14:03:51.090Z_2c4e6a8b0d1f3e5a" }, { path: "photos/IMG_2232.jpg", version: "2026-10-22T14:03:52.771Z_7d9f1b3d5f7a9c1e" }] });
	// and the web host's item: written at once, its change record a restore from that version
	await handle(new Request(`${SITE}/fs/v1/folders/notes`, { headers: headersFor("owner", "GET", "") }), env(), deps(restored.s3, restored.store));
	assert.equal(restored.s3.text(`${ROOT}notes/hosts/${WEB}/hearts/clamp-24.json`), CLAMP_OLD);
	const record = JSON.parse(restored.s3.text(`${ROOT}_changes/notes/${WEB}/000000000007.json`)!);
	assert.deepEqual([record.by, record.via, record.events[0].event, record.events[0].from], ["web", "Chrome on Linux", "restore", CLAMP_VERSION]);
	assert.ok(record.events[0].was.kept, "the version a restore replaces is kept first");
});

test("/fs/ui/v1/: the element's files from the Worker's assets, on every app's origin; nothing else", async () => {
	const files = new Map([["/ui/v1/folder-sync.js", "export {};\n"], ["/ui/v1/vendor/diff.js", "export const diffLines = () => [];\n"]]);
	const e = env({ ASSETS: { fetch: async (r: Request) => (files.has(new URL(r.url).pathname) ? new Response(files.get(new URL(r.url).pathname)) : new Response("", { status: 404 })) } });
	const get = (path: string, method = "GET") => handle(new Request(`${SITE}${path}`, { method }), e, null);
	const js = await get("/fs/ui/v1/folder-sync.js");
	assert.equal(js.status, 200);
	assert.equal(js.headers.get("Content-Type"), "text/javascript; charset=utf-8");
	assert.equal(await js.text(), "export {};\n");
	assert.equal((await get("/fs/ui/v1/vendor/diff.js")).status, 200);
	for (const path of ["/fs/ui/v1/missing.js", "/fs/ui/v2/folder-sync.js", "/fs/ui/v1/", "/fs/ui/v1/notes.txt", "/fs/ui/v1/%2e%2e/signin.js"]) assert.notEqual((await get(path)).status, 200, path);
	assert.equal((await get("/fs/ui/v1/folder-sync.js", "POST")).status, 405);
	// what the Worker ships is the element itself: accounts/site/ui/v1 is a link to the repository's ui/v1
	assert.equal(readlinkSync(new URL("../site/ui/v1", import.meta.url)), "../../../ui/v1");
	assert.equal(readFileSync(new URL("../site/ui/v1/folder-sync.js", import.meta.url), "utf8"), readFileSync(new URL("../../ui/v1/folder-sync.js", import.meta.url), "utf8"));
});

// ------------------------------------------------------------------------------------------------ auth, for real

/** A's folder notes with one machine and one kept version, on the real accounts layer; B a stranger, then a reader. */
async function shared() {
	const s = await realStack();
	const a = await s.browser("maker@example.com");
	const b = await s.browser("stranger@example.com");
	const root = `users/${a.userId}/`;
	s.s3.put(`${root}notes/hosts/${GPU}/manifest.json`, manifest(GPU, "bam-GPU", 3, new Date(s.clock.now).toISOString(), [entry("a.md", 3, sha("new"), new Date(s.clock.now).toISOString())]));
	s.s3.put(`${root}notes/hosts/${GPU}/a.md`, "new");
	s.s3.put(`${root}_history/notes/${GPU}/a.md/2026-10-01T00:00:00.000Z_${sha("old").slice(0, 16)}`, "old");
	s.s3.put(`${root}_history/notes/${GPU}/gone.md/2026-10-01T00:00:00.000Z_${sha("gone").slice(0, 16)}`, "gone");
	const owned = [
		["GET", `/fs/v1/folders/notes/activity`],
		["GET", `/fs/v1/folders/notes/deleted`],
		["GET", `/fs/v1/folders/notes/history/${GPU}/a.md`],
		["GET", `/fs/v1/folders/notes/history/${GPU}/a.md?version=2026-10-01T00:00:00.000Z_${sha("old").slice(0, 16)}`],
		["POST", `/fs/v1/folders/notes/restore`, { items: [{ host: GPU, path: "gone.md", version: `2026-10-01T00:00:00.000Z_${sha("gone").slice(0, 16)}` }] }],
		["POST", `/fs/v1/folders/notes/history/purge`, { older_than_days: 30 }],
	] as const;
	return { s, a, b, root, owned };
}

test("real auth: the owner reads and restores; a non-owner and a reader get 404 No such folder, never a byte of history", async () => {
	const { s, a, b, owned } = await shared();
	for (const [method, path, body] of owned) {
		const own = await s.call(path, method === "POST" ? { method, headers: { ...a.page, "Content-Type": "application/json" }, body: JSON.stringify(body) } : { headers: { Cookie: a.cookie } });
		assert.equal(own.status, 200, `the owner: ${method} ${path} ${own.status}`);
	}
	const status = await (await s.call("/fs/v1/folders/notes/status", { headers: { Cookie: a.cookie } })).json();
	assert.deepEqual([status.role, status.devices.length, Array.isArray(status.warnings)], ["owner", 1, true]);
	for (const who of ["stranger", "reader"] as const) {
		if (who === "reader") assert.equal((await s.post("/fs/v1/folders/notes/readers", { email: "stranger@example.com" }, a.page)).status, 200);
		for (const [method, path, body] of owned) {
			const at = `${path}${path.includes("?") ? "&" : "?"}owner=${a.userId}`;
			const answer = await s.call(at, method === "POST" ? { method, headers: { ...b.page, "Content-Type": "application/json" }, body: JSON.stringify(body) } : { headers: { Cookie: b.cookie } });
			const text = await answer.text();
			assert.equal(answer.status, 404, `${who}: ${method} ${path}: ${answer.status} ${text}`);
			assert.deepEqual(JSON.parse(text), { error: "not_found", why: "No such folder." });
		}
		const theirs = await s.call(`/fs/v1/folders/notes/status?owner=${a.userId}`, { headers: { Cookie: b.cookie } });
		if (who === "stranger") assert.equal(theirs.status, 404, "a private folder's status is not a stranger's");
		else {
			const body = await theirs.json();
			assert.deepEqual(Object.keys(body).sort(), ["devices", "headline", "owner", "project", "role", "state"], "a reader: state and devices only");
			assert.equal(body.role, "reader");
		}
	}
	// nothing B asked for was written: no request, no purge
	assert.ok(![...s.s3.objects.keys()].some((k) => k.includes("_requests/") && k.includes(b.userId)));
});

test("real auth: a revoked session is 401 on every owner route, the browser's and the machine's", async () => {
	const { s, a, owned } = await shared();
	const laptop = await s.machine(a.cookie);
	const other = await s.browser("maker@example.com");
	assert.equal((await s.call("/fs/v1/folders/notes/activity", { headers: { Authorization: `Bearer ${laptop.token}` } })).status, 200, "a machine's bearer reads its owner's activity");
	assert.equal((await s.post("/fs/v1/devices/revoke", { id: laptop.sessionId }, a.page)).status, 200);
	assert.equal((await s.post("/fs/v1/devices/revoke", { id: other.sessionId }, a.page)).status, 200);
	for (const [method, path, body] of owned) {
		for (const [what, headers] of [["the revoked machine", { Authorization: `Bearer ${laptop.token}` }], ["the revoked browser", { ...other.page, "Content-Type": "application/json" }]] as const) {
			const answer = await s.call(path, method === "POST" ? { method, headers, body: JSON.stringify(body) } : { headers });
			assert.equal(answer.status, 401, `${what}: ${method} ${path}`);
			assert.equal((await answer.json()).error, "signed_out");
		}
	}
	assert.ok(![...s.s3.objects.keys()].some((k) => k.includes("_requests/")), "no request was written for a revoked session");
});

// ------------------------------------------------------------------------------------------------ mutations

type Edit = { file: "view.ts" | "history.ts" | "prune.ts"; marker: string; replacement: string };

/** Imports a copy of app.ts whose view.ts (and history.ts, which view.ts and webhost.ts import) carry the edits;
 *  always removes the copies. */
async function withMutant<T>(edits: Edit[], run: (m: { handle: typeof handle; history: Record<string, any>; prune: Record<string, any> }) => Promise<T>): Promise<T> {
	const dir = new URL("../src/", import.meta.url);
	const tag = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	const written: string[] = [];
	const source = (name: string) => readFileSync(fileURLToPath(new URL(name, dir)), "utf-8");
	const mutate = (name: Edit["file"], text = source(name)) => {
		for (const edit of edits.filter((e) => e.file === name)) {
			assert.ok(text.includes(edit.marker), `the marker moved in ${name}: ${edit.marker}`);
			text = text.replace(edit.marker, edit.replacement);
		}
		return text;
	};
	const copy = (name: string, text: string) => {
		const path = fileURLToPath(new URL(`.mutant-${tag}-${name}`, dir));
		writeFileSync(path, text);
		written.push(path);
		return path;
	};
	try {
		const history = copy("history.ts", mutate("history.ts"));
		const prune = copy("prune.ts", mutate("prune.ts").replace('from "./history.ts"', `from "./.mutant-${tag}-history.ts"`));
		copy("view.ts", mutate("view.ts").replace('from "./history.ts"', `from "./.mutant-${tag}-history.ts"`));
		const app = copy("app.ts", source("app.ts").replace('from "./view.ts"', `from "./.mutant-${tag}-view.ts"`));
		const loaded = (await import(pathToFileURL(app).href)) as { handle: typeof handle };
		return await run({ handle: loaded.handle, history: await import(pathToFileURL(history).href), prune: await import(pathToFileURL(prune).href) });
	} finally {
		for (const path of written) unlinkSync(path);
	}
}

test("mutation: trusting ?owner= on an owner-only route lets a reader read the owner's history (red)", async () => {
	await withMutant([{ file: "view.ts", marker: "if (named !== null && named !== who.person.userId) return notFound();", replacement: "if (named !== null && named !== who.person.userId) return { ...who, person: { ...who.person, userId: named } };" }], async (m) => {
		const { res } = await answer("error-reader-history", m.handle);
		assert.equal(res.status, 200, "the mutant served the owner's history to a reader: the fixture test above goes red");
	});
});

test("mutation: dropping the CSRF rule lets a cookie restore without X-Folder-Sync: 1 (red)", async () => {
	await withMutant([{ file: "view.ts", marker: 'if (who.via === "cookie" && !csrfOk(request, app))', replacement: "if (false)" }], async (m) => {
		const { res } = await answer("error-csrf", m.handle);
		assert.notEqual(res.status, 403, "the mutant let it through: testdata/view-api/error-csrf.json goes red");
	});
});

test("mutation: without the burst rule (rule 4), the retention fixture's burst cases go red", async () => {
	await withMutant([{ file: "history.ts", marker: "if (leaving.lastKeptLeftAt !== null && leaving.lastKeptLeftAt > leaving.now - BURST_MS) return { keep: false, why: \"burst\" };", replacement: "" }], async (m) => {
		const cases = JSON.parse(read("retention/schedule.json")).write_cases;
		const wrong = cases.filter((c: any) => m.history.keepOnWrite({ op: c.op, path: c.path, writtenAt: c.leaving.written_at, now: Date.parse(c.now), lastKeptLeftAt: c.last_kept_left_at ? Date.parse(c.last_kept_left_at) : null, noHistory: c.no_history }).keep !== c.keep);
		assert.ok(wrong.length >= 2, `the mutant passes every write case: ${wrong.length}`);
	});
});

test("mutation: a pruner that skips legacy _trash/ leaves a signed-in person's rooted trash for ever (red)", async () => {
	await withMutant([{ file: "prune.ts", marker: "if (at !== null && at < cutoff) await doom(object.key, object.size);", replacement: "void at;" }], async (m) => {
		const { s3, bucket } = await pruneBucket();
		s3.put(`${ROOT}_trash/notes/${GPU}/20260920T000000Z/old.md`, "old");
		await m.prune.pruneFolder(bucket, ROOT, "notes", NOW);
		assert.ok(s3.objects.has(`${ROOT}_trash/notes/${GPU}/20260920T000000Z/old.md`), "the mutant kept it: prune.test.ts's lifecycle test goes red");
	});
});

async function pruneBucket() {
	const { S3Bucket } = await import("../src/s3-bucket.ts");
	const { mint } = await import("../src/creds.ts");
	const s3 = new MemoryS3(ENDPOINT, BUCKET);
	s3.now = () => NOW;
	return { s3, bucket: new S3Bucket(await mint(env(), ROOT, "object-read-write", 300, NOW), s3.fetch) };
}
