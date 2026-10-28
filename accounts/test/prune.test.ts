// The folder's prune (PEP 0007 §3.2): the folder's Durable Object thins every host's history by the staggered
// schedule and deletes change records, pull records, restore requests and legacy _trash/ 30 days on, on its one alarm,
// set by whatever touches the folder. And the lifecycle fix (§1.4): a signed-in person's rooted users/<id>/_trash/,
// which no R2 lifecycle rule can match, is expired too.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mint } from "../src/creds.ts";
import { pruneFolder } from "../src/prune.ts";
import { S3Bucket } from "../src/s3-bucket.ts";
import { WebHostCore } from "../src/webhost.ts";
import { MemoryS3 } from "./memory-s3.ts";
import { MemoryStore } from "./memory-store.ts";

const ENDPOINT = "https://acct0123.r2.cloudflarestorage.com";
const OWNER = "ownerABC123";
const ROOT = `users/${OWNER}/`;
const MACHINE = "b55e9683-7854-4121-a56a-9bae7c3ab1da";
const GONE = "7c1d2e3f-0a1b-4c2d-8e3f-405162738495"; // a machine that never comes back
const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const H = 3600_000;
const D = 24 * H;
const env = { R2_ACCOUNT_ID: "acct0123", R2_PARENT_ACCESS_KEY_ID: "p", R2_PARENT_SECRET_ACCESS_KEY: "s", SYNC_BUCKET: "folder-sync" };

function bucketAt(now = NOW) {
	const s3 = new MemoryS3(ENDPOINT, "folder-sync");
	s3.now = () => now;
	return s3;
}

const version = (leftAt: number, n = 0) => `${new Date(leftAt - 1000).toISOString()}_${String(n).padStart(16, "0")}`;

test("the prune: every host's history by the schedule, records and requests and legacy _trash/ 30 days on; the rest untouched", async () => {
	const s3 = bucketAt();
	const keep: string[] = [];
	const drop: string[] = [];
	const put = (key: string, at: number, kept: boolean) => {
		s3.put(`${ROOT}${key}`, "x".repeat(10), at);
		(kept ? keep : drop).push(`${ROOT}${key}`);
	};
	for (const host of [MACHINE, GONE]) {
		// one path: under an hour all stay; hourly newest per UTC hour; daily newest per UTC day; 30 days gone
		const p = `_history/notes/${host}/notes/plan.md/`;
		put(`${p}${version(NOW - 10 * 60_000, 1)}`, NOW - 10 * 60_000, true);
		put(`${p}${version(NOW - 20 * 60_000, 2)}`, NOW - 20 * 60_000, true);
		put(`${p}${version(NOW - 2 * H - 10 * 60_000, 3)}`, NOW - 2 * H - 10 * 60_000, true);
		put(`${p}${version(NOW - 2 * H - 40 * 60_000, 4)}`, NOW - 2 * H - 40 * 60_000, false);
		put(`${p}${version(NOW - 3 * D, 5)}`, NOW - 3 * D, true);
		put(`${p}${version(NOW - 3 * D - H, 6)}`, NOW - 3 * D - H, false);
		put(`${p}${version(NOW - 31 * D, 7)}`, NOW - 31 * D, false);
		// a deleted file's last version stays until 30 days
		put(`_history/notes/${host}/gone.md/${version(NOW - 29 * D, 8)}`, NOW - 29 * D, true);
		// change records, pull records (their key is their at) and requests
		put(`_changes/notes/${host}/000000000040.json`, NOW - 31 * D, false);
		put(`_changes/notes/${host}/000000000041.json`, NOW - 29 * D, true);
		put(`_changes/notes/${host}/pulls/${new Date(NOW - 31 * D).toISOString()}.json`, NOW - D, false);
		put(`_changes/notes/${host}/pulls/${new Date(NOW - 29 * D).toISOString()}.json`, NOW - D, true);
		put(`_requests/notes/${host}/9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d.json`, NOW - 31 * D, false);
		put(`_requests/notes/${host}/c4d5e6f7-0819-4a2b-8c3d-4e5f60718293.json`, NOW - 2 * D, true);
		// legacy _trash/, 30 days after its stamp (the machine's, and the web host's with its ms and nonce)
		put(`_trash/notes/${host}/20260920T000000Z/old.md`, NOW, false);
		put(`_trash/notes/${host}/20260920T000000Z-123-1f2e3d4c/saved/x.json`, NOW, false);
		put(`_trash/notes/${host}/20261020T000000Z/recent.md`, NOW - 20 * D, true);
	}
	// what is not the pruner's: live files, another folder, a key that is not a version
	put(`notes/hosts/${MACHINE}/notes/plan.md`, NOW - 40 * D, true);
	put(`other/hosts/${MACHINE}/x.md`, NOW - 40 * D, true);
	put(`_history/other/${MACHINE}/x.md/${version(NOW - 40 * D)}`, NOW - 40 * D, true);
	put(`_history/notes/${MACHINE}/notes/stray-file`, NOW - 40 * D, true);
	const bucket = new S3Bucket(await mint(env, ROOT, "object-read-write", 300, NOW), s3.fetch);
	const pruned = await pruneFolder(bucket, ROOT, "notes", NOW);
	const left = new Set(s3.objects.keys());
	assert.deepEqual(drop.filter((k) => left.has(k)), [], "every aged-out object is gone");
	assert.deepEqual(keep.filter((k) => !left.has(k)), [], "every kept object stays");
	assert.deepEqual([pruned.deleted, pruned.bytes, pruned.more], [drop.length, drop.length * 10, false]);
	// change records count bytes only (quota.ts), so their deletes credit no object
	assert.equal(pruned.objects, drop.filter((k) => !k.includes("/_changes/")).length);
	// idempotent: a second prune (another pruner on the same keys) deletes nothing more
	assert.equal((await pruneFolder(bucket, ROOT, "notes", NOW)).deleted, 0);
	// one bulk delete per thousand keys, all inside the owner's root
	assert.ok(s3.calls.filter((c) => c.method === "DELETE_MANY").every((c) => c.scope === "object-read-write" && c.scoped?.[0] === ROOT));
});

test("the lifecycle fix (PEP 0007 §1.4): a signed-in person's rooted _trash/ is expired by the folder's object, on its alarm", async () => {
	const s3 = bucketAt();
	let now = NOW;
	s3.now = () => now;
	const store = new MemoryStore();
	store.usageRows.set(OWNER, { bytes: 1000, objects: 3, measured_at: new Date(NOW).toISOString() });
	const storage = (() => {
		const data = new Map<string, unknown>();
		const st = {
			data,
			alarm: null as number | null,
			get: async <T>(key: string) => data.get(key) as T | undefined,
			put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
			delete: async (key: string) => data.delete(key),
			list: async <T>({ prefix }: { prefix: string }) => new Map([...data].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, v as T])),
			setAlarm: async (at: number) => { st.alarm = at; },
			deleteAlarm: async () => { st.alarm = null; },
		};
		return st;
	})();
	const core = new WebHostCore(env, s3.fetch, storage, () => now, store);
	// the README's lifecycle rule (prefix _trash/) never matches this key: it starts with users/<id>/
	const trashed = `${ROOT}_trash/notes/${MACHINE}/20260901T000000Z/notes/plan.md`;
	s3.put(trashed, "old bytes", NOW - 57 * D);
	// a page's read touches the folder: its object learns which folder it is and sets its first prune
	assert.equal((await core.run({ method: "TOUCH", owner: OWNER, project: "notes", hostId: "", path: "" })).status, 200);
	assert.equal(storage.alarm, NOW + 60_000, "the first prune, a minute after the folder was touched");
	assert.ok(s3.objects.has(trashed), "nothing deleted yet");
	now = storage.alarm!;
	await core.alarm();
	assert.equal(s3.objects.has(trashed), false, "expired: 30 days after its stamp");
	assert.equal(storage.alarm, now + D, "and the next prune a day on");
	assert.equal((await store.usage(OWNER))!.stale, true, "the credit marks the usage stale: measured again next");
	// an alarm that is not the prune's (a settle retry) does not prune again
	s3.put(`${ROOT}_trash/notes/${MACHINE}/20260901T000000Z/b.md`, "b", NOW - 57 * D);
	now += H;
	await core.alarm();
	assert.ok(s3.objects.has(`${ROOT}_trash/notes/${MACHINE}/20260901T000000Z/b.md`), "the prune waits for its day");
});

test("the folder's object prunes a machine's history with no machine and no page: a measurement's listing wakes it", async () => {
	const { handle } = await import("../src/app.ts");
	const s3 = bucketAt();
	const store = new MemoryStore();
	const old = `${ROOT}_history/notes/${GONE}/notes/a.md/${version(NOW - 40 * D)}`;
	s3.put(old, "aged", NOW - 40 * D);
	s3.put(`${ROOT}notes/hosts/${MACHINE}/manifest.json`, JSON.stringify({ schema: "folder-sync-manifest/1", project: "notes", host_id: MACHINE, host_name: "ws", seq: 1, generated_at: "2026-10-28T11:00:00Z", files: [] }), NOW);
	const person = { userId: OWNER, email: "o@example.com", name: null, image: null, sessionId: "s1", sessionToken: "t1" };
	const cores: WebHostCore[] = [];
	let t = NOW;
	const deps = {
		auth: async () => new Response("{}"), person: async () => person, signOut: async () => [], store, s3: s3.fetch, now: () => NOW, uuid: () => crypto.randomUUID(),
		webHost: (() => {
			// one object per folder, as the Durable Object namespace gives
			const byName = new Map<string, WebHostCore>();
			const storage = () => { const data = new Map<string, unknown>(); return { get: async (k: string) => data.get(k), put: async (k: string, v: unknown) => { data.set(k, v); }, delete: async (k: string) => data.delete(k), list: async ({ prefix }: { prefix: string }) => new Map([...data].filter(([k]) => k.startsWith(prefix))), setAlarm: async () => undefined, deleteAlarm: async () => undefined } as any; };
			return (op: any) => {
				const name = `${op.owner}/${op.project}`;
				if (!byName.has(name)) {
					const core = new WebHostCore(env, s3.fetch, storage(), () => t, store);
					byName.set(name, core);
					cores.push(core);
				}
				return byName.get(name)!.run(op);
			};
		})(),
	};
	// a machine refreshes its keys: the person's root is measured, and every folder the listing passes is woken
	const keys = await handle(new Request("https://accounts.example.test/fs/v1/credentials", { method: "POST", headers: { Authorization: "Bearer t1" } }), { ...env, PUBLIC_URL: "https://accounts.example.test" } as any, deps as any);
	assert.equal(keys.status, 200);
	await new Promise((done) => setTimeout(done, 10));
	assert.equal(cores.length, 1, "the folder notes was woken");
	t = NOW + 2 * 60_000; // its first prune is due a minute after the wake
	await cores[0].alarm();
	assert.equal(s3.objects.has(old), false, "the gone machine's 40-day-old version is pruned");
});
