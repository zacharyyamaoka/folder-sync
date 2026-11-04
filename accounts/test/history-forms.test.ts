// PEP 0009's three forms of a kept version through the Worker: the history route lists them with their own sizes and
// opens each byte-for-byte (a whole copy, a zstd keyframe decoded by the vendored fzstd, a pointer read from the keyframe
// or the whole copy or the live file it rests on), refuses bytes that are not the version's, the deleted route sizes them,
// a purge of a keyframe takes the pointers resting on it, and the folder's prune keeps anchors, deletes pointers first
// and reports a pointer whose bytes are gone. The keyframe is the fixture testdata/zstd/frames.json: a frame written by the
// engine's own encoder, so this is also the engine-to-Worker seam.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { handle, type Deps, type Env, type Person } from "../src/app.ts";
import { mint } from "../src/creds.ts";
import { pruneFolder } from "../src/prune.ts";
import { S3Bucket } from "../src/s3-bucket.ts";
import { MemoryS3 } from "./memory-s3.ts";
import { MemoryStore } from "./memory-store.ts";

const ENDPOINT = "https://acct0123.r2.cloudflarestorage.com";
const SITE = "https://robotparts.dev";
const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const OWNER: Person = { userId: "AbC123zz9yX8", email: "zach@example.com", name: "Zach", image: null, sessionId: "sess-owner", sessionToken: "tok-owner" };
const ROOT = `users/${OWNER.userId}/`;
const GPU = "b55e9683-7854-4121-a56a-9bae7c3ab1da";
const PATH = "logs/events.jsonl";
const HISTORY = `${ROOT}_history/notes/${GPU}/${PATH}/`;
const LIVE = `${ROOT}notes/hosts/${GPU}/${PATH}`;
const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

const frames = JSON.parse(readFileSync(new URL("../../testdata/zstd/frames.json", import.meta.url), "utf8")).frames as { name: string; template: string; count: number; plain_size: number; plain_sha256: string; frame_b64: string }[];
const BIG = frames[1];
const bigPlain = (() => {
	let out = "";
	for (let n = 0; n < BIG.count; n++) out += BIG.template.replace("%d", String(n)).replace("%d", String((n * 7919) % 100003));
	return Buffer.from(out);
})();

function env(): Env {
	return { ENVIRONMENT: "production", PUBLIC_URL: "https://accounts.example.test", R2_ACCOUNT_ID: "acct0123", R2_PARENT_ACCESS_KEY_ID: "parent-key-id", R2_PARENT_SECRET_ACCESS_KEY: "parent-secret-fixture", SYNC_BUCKET: "folder-sync" };
}

function world() {
	const s3 = new MemoryS3(ENDPOINT, "folder-sync");
	s3.now = () => NOW;
	const store = new MemoryStore();
	store.usageRows.set(OWNER.userId, { bytes: 1, objects: 1, measured_at: new Date(NOW - 1000).toISOString(), history: { bytes: 0, objects: 0 } });
	store.rows.set(`${OWNER.userId}\u0000notes`, { owner_id: OWNER.userId, project: "notes", visibility: "private", updated_at: "2026-10-01T00:00:00Z" });
	const deps: Deps = {
		auth: async () => new Response("{}"), person: async () => OWNER, signOut: async () => [], store, s3: s3.fetch, now: () => NOW, uuid: () => crypto.randomUUID(),
	};
	const call = (method: string, path: string, body?: unknown) =>
		handle(new Request(`${SITE}${path}`, { method, headers: { Cookie: `s=${OWNER.sessionId}`, Origin: SITE, "X-Folder-Sync": "1", "X-Folder-Sync-User": OWNER.userId, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env(), deps);
	const fetchVersion = (id: string) => call("GET", `/fs/v1/folders/notes/history/${GPU}/${PATH}?version=${encodeURIComponent(id)}`);
	return { s3, store, call, fetchVersion };
}

const id = (writtenAt: string, plain: string | Uint8Array) => `${writtenAt}_${sha(plain).slice(0, 16)}`;
const pointer = (plain: Uint8Array) => JSON.stringify({ schema: "folder-sync-prefix/1", size: plain.byteLength, sha256: sha(plain) });
const manifest = (etag?: string) => JSON.stringify({ schema: "folder-sync-manifest/1", project: "notes", host_id: GPU, host_name: "bam-GPU", seq: 9, generated_at: "2026-11-04T11:59:00.000Z", files: [{ path: PATH, size: 5, mtime: "2026-11-04T11:59:00.000Z", sha256: sha("x"), written_at: "2026-11-04T11:59:00.000Z", ...(etag ? { object_etag: etag } : {}) }] });

test("a keyframe is listed at its own size and opens to exactly its bytes, with the version's type and sandbox rules", async () => {
	const w = world();
	const v = id("2026-11-04T10:00:00.000Z", bigPlain);
	w.s3.put(`${HISTORY}${v}.${bigPlain.byteLength}.zst`, Buffer.from(BIG.frame_b64, "base64"), NOW - 1000);
	w.s3.put(`${ROOT}notes/hosts/${GPU}/manifest.json`, manifest());
	const listed = await (await w.call("GET", `/fs/v1/folders/notes/history/${GPU}/${PATH}`)).json();
	assert.deepEqual(listed.versions.map((x: { id: string; size: number }) => [x.id, x.size]), [[v, bigPlain.byteLength]], "the size is the version's, not the frame's");
	const res = await w.fetchVersion(v);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("Content-Length"), String(bigPlain.byteLength));
	assert.equal(res.headers.get("Content-Type"), "application/x-ndjson; charset=utf-8");
	assert.equal(sha(new Uint8Array(await res.arrayBuffer())), sha(bigPlain));
	// a HEAD says the size without decoding anything
	const head = await w.call("HEAD", `/fs/v1/folders/notes/history/${GPU}/${PATH}?version=${encodeURIComponent(v)}`);
	assert.equal(head.headers.get("Content-Length"), String(bigPlain.byteLength));
});

test("a pointer opens to the first bytes of what it rests on: a keyframe, a whole copy, or the live file (with its ETag)", async () => {
	const w = world();
	// resting on a keyframe: the first 1,000 bytes of the big frame's bytes
	const onZst = bigPlain.subarray(0, 1000);
	const pZst = id("2026-11-04T09:00:00.000Z", onZst);
	w.s3.put(`${HISTORY}${pZst}.1000.prefix`, pointer(onZst), NOW - 5000);
	const k = id("2026-11-04T10:00:00.000Z", bigPlain);
	w.s3.put(`${HISTORY}${k}.${bigPlain.byteLength}.zst`, Buffer.from(BIG.frame_b64, "base64"), NOW - 1000);
	let res = await w.fetchVersion(pZst);
	assert.equal(res.status, 200);
	assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.from(onZst));
	// resting on a whole copy
	const whole = Buffer.from("line one\nline two\nline three, which the whole copy has and the pointer does not\n");
	const head = whole.subarray(0, 18);
	const pWhole = id("2026-11-04T09:30:00.000Z", head);
	w.s3.put(`${HISTORY}${pWhole}.18.prefix`, pointer(head), NOW - 4000);
	w.s3.put(`${HISTORY}${id("2026-11-04T09:45:00.000Z", whole)}`, whole, NOW - 3000);
	res = await w.fetchVersion(pWhole);
	assert.equal(res.status, 200);
	assert.equal(await res.text(), "line one\nline two\n");
	// resting on the live file: no full object after it; read with the object_etag the manifest lists
	const live = Buffer.from("the live file begins like the pointer and goes on\n");
	const pLive = id("2026-11-04T11:00:00.000Z", live.subarray(0, 24));
	w.s3.put(`${ROOT}notes/hosts/${GPU}/${PATH}`, live, NOW - 100);
	const etag = createHash("md5").update(live).digest("hex");
	w.s3.put(`${ROOT}notes/hosts/${GPU}/manifest.json`, manifest(etag));
	const w2 = world();
	w2.s3.put(`${HISTORY}${pLive}.24.prefix`, pointer(live.subarray(0, 24)), NOW - 100);
	w2.s3.put(LIVE, live, NOW - 100);
	w2.s3.put(`${ROOT}notes/hosts/${GPU}/manifest.json`, manifest(etag));
	res = await w2.fetchVersion(pLive);
	assert.equal(res.status, 200);
	assert.equal(await res.text(), live.subarray(0, 24).toString());
	assert.ok(w2.s3.calls.some((c) => c.method === "GET" && c.key === LIVE && c.ifMatch === `"${etag}"`), "the live read carries If-Match");
	// the file was rewritten since the manifest: the ETag no longer matches, the read is retried without it and the
	// sha256 decides (here the rewrite kept the start, so it is still those bytes)
	w2.s3.put(LIVE, Buffer.concat([live, Buffer.from("and more\n")]), NOW - 50);
	assert.equal((await w2.fetchVersion(pLive)).status, 200);
});

test("bytes that are not the version's are refused, never served", async () => {
	const w = world();
	const real = bigPlain.subarray(0, 1000);
	// a pointer whose anchor does not start with its bytes
	const p = id("2026-11-04T09:00:00.000Z", real);
	w.s3.put(`${HISTORY}${p}.1000.prefix`, pointer(real), NOW - 5000);
	const other = Buffer.from("a different file that happens to be longer than the pointer says it is, by a good margin, yes\n".repeat(20));
	w.s3.put(`${HISTORY}${id("2026-11-04T10:00:00.000Z", other)}`, other, NOW - 1000);
	const bad = await w.fetchVersion(p);
	assert.equal(bad.status, 502);
	assert.equal(((await bad.json()) as { error: string }).error, "corrupt");
	// a keyframe that opens to another size than its name, and one whose bytes hash to another sha16
	const k = id("2026-11-04T10:00:00.000Z", bigPlain);
	w.s3.put(`${HISTORY}${k}.${bigPlain.byteLength + 1}.zst`, Buffer.from(BIG.frame_b64, "base64"), NOW - 900);
	assert.equal((await w.fetchVersion(k)).status, 502);
	const wrongHash = `2026-11-04T10:05:00.000Z_0000000000000000`;
	w.s3.put(`${HISTORY}${wrongHash}.${bigPlain.byteLength}.zst`, Buffer.from(BIG.frame_b64, "base64"), NOW - 800);
	assert.equal((await w.fetchVersion(wrongHash)).status, 502);
	// not a zstd frame at all
	const junk = `2026-11-04T10:10:00.000Z_1111111111111111`;
	w.s3.put(`${HISTORY}${junk}.10.zst`, "not a frame", NOW - 700);
	assert.equal((await w.fetchVersion(junk)).status, 502);
	// a version that is not in the listing is pruned, whatever its form would have been
	assert.equal((await w.fetchVersion("2026-11-04T08:00:00.000Z_ffffffffffffffff")).status, 410);
});

test("deleted files show a keyframe's and a pointer's own size", async () => {
	const w = world();
	const v = id("2026-11-04T10:00:00.000Z", bigPlain);
	w.s3.put(`${HISTORY}${v}.${bigPlain.byteLength}.zst`, Buffer.from(BIG.frame_b64, "base64"), NOW - 1000);
	const gone = await (await w.call("GET", "/fs/v1/folders/notes/deleted")).json();
	assert.deepEqual(gone.files.map((f: { path: string; size: number; version: string }) => [f.path, f.size, f.version]), [[PATH, bigPlain.byteLength, v]]);
});

test("purging a keyframe purges the pointers that rest on it, and every form of that version", async () => {
	const w = world();
	const k = id("2026-11-04T10:00:00.000Z", bigPlain);
	const early = bigPlain.subarray(0, 500);
	const mid = bigPlain.subarray(0, 900);
	const p1 = id("2026-11-04T09:00:00.000Z", early);
	const p2 = id("2026-11-04T09:30:00.000Z", mid);
	const later = Buffer.from("a later whole copy\n");
	const l = id("2026-11-04T11:00:00.000Z", later);
	for (const [name, body] of [[`${p1}.500.prefix`, pointer(early)], [`${p2}.900.prefix`, pointer(mid)], [`${l}`, later]] as [string, string | Buffer][]) w.s3.put(`${HISTORY}${name}`, body, NOW - 100);
	w.s3.put(`${HISTORY}${k}.${bigPlain.byteLength}.zst`, Buffer.from(BIG.frame_b64, "base64"), NOW - 100);
	w.s3.put(`${HISTORY}${k}.${bigPlain.byteLength}.prefix`, pointer(bigPlain), NOW - 100); // a pointer beside the keyframe of the same version
	const res = await w.call("POST", "/fs/v1/folders/notes/history/purge", { host: GPU, path: PATH, version: k });
	assert.equal(res.status, 200);
	const left = [...w.s3.objects.keys()].filter((key) => key.startsWith(HISTORY)).map((key) => key.slice(HISTORY.length));
	assert.deepEqual(left, [l], "the keyframe, its twin pointer and the two pointers resting on it are gone; the later copy stays");
	// the pointers went in a call of their own, before the keyframe
	const deletes = w.s3.calls.filter((c) => c.method === "DELETE_MANY");
	assert.equal(deletes.length, 2);
});

test("the folder's prune: an anchor stays past its tier, pointers go before keyframes, a pointer with nothing to rest on is reported", async () => {
	const s3 = new MemoryS3(ENDPOINT, "folder-sync");
	s3.now = () => NOW;
	const D = 24 * 3600_000;
	const bucket = new S3Bucket(await mint(env(), ROOT, "object-read-write", 300, NOW), s3.fetch);
	const put = (name: string, leftAt: number, host = GPU, path = PATH) => s3.put(`${ROOT}_history/notes/${host}/${path}/${name}`, "x".repeat(10), leftAt);
	// day 1: a pointer (the newest of its day), a keyframe that is not the newest of the next day but is its anchor
	const day = Date.parse("2026-11-01T00:00:00.000Z");
	put("2026-11-01T09:00:00.000Z_aaaaaaaaaaaaaaaa.1000.prefix", day + 23 * 3600_000);
	put("2026-11-01T09:30:00.000Z_bbbbbbbbbbbbbbbb.1500.zst", day + 24 * 3600_000 + 3600_000);
	put("2026-11-01T11:00:00.000Z_cccccccccccccccc.900", day + 24 * 3600_000 + 5 * 3600_000); // not a name: never touched
	put("2026-11-02T04:00:00.000Z_dddddddddddddddd", day + 24 * 3600_000 + 5 * 3600_000);
	// another path: a pointer with no full object after it, on a host whose manifest no longer lists the path
	const GONE_HOST = "7c1d2e3f-0a1b-4c2d-8e3f-405162738495";
	put("2026-11-03T10:00:00.000Z_eeeeeeeeeeeeeeee.2000.prefix", NOW - 2 * D, GONE_HOST, "logs/gone.jsonl");
	put("2026-11-03T10:00:00.000Z_ffffffffffffffff.2000.prefix", NOW - 2 * D, GPU, "logs/live.jsonl");
	const lives: Record<string, string[]> = { [GONE_HOST]: [], [GPU]: ["logs/live.jsonl"] };
	const asked: string[] = [];
	const pruned = await pruneFolder(bucket, ROOT, "notes", NOW, 30, async (host, path) => {
		asked.push(`${host}/${path}`);
		return lives[host].includes(path);
	});
	const left = [...s3.objects.keys()].map((k) => k.slice(ROOT.length)).sort();
	assert.deepEqual(left, [
		`_history/notes/${GPU}/${PATH}/2026-11-01T09:00:00.000Z_aaaaaaaaaaaaaaaa.1000.prefix`,
		`_history/notes/${GPU}/${PATH}/2026-11-01T09:30:00.000Z_bbbbbbbbbbbbbbbb.1500.zst`,
		`_history/notes/${GPU}/${PATH}/2026-11-01T11:00:00.000Z_cccccccccccccccc.900`,
		`_history/notes/${GPU}/${PATH}/2026-11-02T04:00:00.000Z_dddddddddddddddd`,
		`_history/notes/${GPU}/logs/live.jsonl/2026-11-03T10:00:00.000Z_ffffffffffffffff.2000.prefix`,
	]);
	assert.deepEqual(pruned.lost, [{ host: GONE_HOST, path: "logs/gone.jsonl", version: "2026-11-03T10:00:00.000Z_eeeeeeeeeeeeeeee" }]);
	assert.deepEqual(asked.sort(), [`${GONE_HOST}/logs/gone.jsonl`, `${GPU}/logs/live.jsonl`], "the manifests are read only for pointers with nothing after them");
	assert.equal(pruned.deleted, 1);
	// a prune that cannot read a manifest concludes nothing
	s3.put(`${ROOT}_history/notes/${GONE_HOST}/logs/gone.jsonl/2026-11-03T10:00:00.000Z_eeeeeeeeeeeeeeee.2000.prefix`, "x", NOW - 2 * D);
	const unknown = await pruneFolder(bucket, ROOT, "notes", NOW, 30, async () => null);
	assert.equal(unknown.deleted, 0);
	assert.deepEqual(unknown.lost, []);
});
