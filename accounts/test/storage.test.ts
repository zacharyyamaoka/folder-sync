// GET /fs/v1/usage/breakdown (accounts/src/storage.ts): what is in this account, by project, kind and device, over the
// in-memory S3 (test/memory-s3.ts) it is listed from. The kinds are live files and the history kinds (PEP 0007 §3.5:
// _history, _trash, _changes, _requests). Then the auth rules (signed out is 401, nobody sees another account's
// prefix), a capped listing marked partial, and the realistic account's answer pinned to the file the UI's test reads.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { handle, type Deps, type Env, type Person } from "../src/app.ts";
import type { MemoryS3 } from "./memory-s3.ts";
import type { MemoryStore } from "./memory-store.ts";
import { accounts, blob, BUCKET, GPU, LAPTOP, NOW, OTHER, OWNER, realistic, ROOT, tiny, WEB } from "./storage-seed.ts";

const SITE = "https://robotparts.dev";
const GOLDEN = fileURLToPath(new URL("../../ui/test/fixtures/storage-breakdown.json", import.meta.url));
const PATH = "/fs/v1/usage/breakdown";

function env(extra: Partial<Env> = {}): Env {
	return { ENVIRONMENT: "production", PUBLIC_URL: "https://accounts.example.test", R2_ACCOUNT_ID: "acct0123", R2_PARENT_ACCESS_KEY_ID: "parent-key-id", R2_PARENT_SECRET_ACCESS_KEY: "parent-secret-fixture", SYNC_BUCKET: BUCKET, QUOTA_BYTES: "100000000", ...extra };
}

function deps(s3: MemoryS3, store: MemoryStore): Deps {
	const people = new Map<string, Person>([[OWNER.sessionId, OWNER], [OTHER.sessionId, OTHER]]);
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

async function ask(s3: MemoryS3, store: MemoryStore, who: Person | null, options: { env?: Partial<Env>; path?: string; method?: string } = {}) {
	const headers: Record<string, string> = who ? { Cookie: `s=${who.sessionId}` } : {};
	const res = await handle(new Request(`${SITE}${options.path ?? PATH}`, { method: options.method ?? "GET", headers }), env(options.env), deps(s3, store));
	return { res, body: (await res.json()) as any };
}

const sum = (s3: MemoryS3, prefix: string) => [...s3.objects].filter(([k]) => k.startsWith(`${ROOT}${prefix}`)).reduce((n, [, v]) => n + v.byteLength, 0);

test("tiny: the account's totals, and each kind's, add up to what is in the bucket", async () => {
	const { s3, store } = accounts();
	tiny(s3);
	const { res, body } = await ask(s3, store, OWNER);
	assert.equal(res.status, 200, JSON.stringify(body));
	assert.equal(body.owner, OWNER.userId);
	const all = [...s3.objects.values()].reduce((n, v) => n + v.byteLength, 0);
	assert.equal(body.used.bytes, all);
	// the quota does not count _changes records as objects (quota.ts measureRoot); every other object it does
	assert.equal(body.used.objects, [...s3.objects.keys()].filter((k) => !k.startsWith(`${ROOT}_changes/`)).length);
	assert.deepEqual(body.quota, { bytes: 100_000_000, objects: 100_000 });
	assert.equal(body.over, null);
	assert.equal(body.partial, false);
	const kind = (name: string) => body.kinds.find((k: any) => k.kind === name);
	assert.equal(kind("trash").bytes, sum(s3, "_trash/"));
	assert.equal(kind("history").bytes, sum(s3, "_history/"));
	assert.equal(kind("changes").bytes, sum(s3, "_changes/"));
	assert.equal(kind("requests").bytes, sum(s3, "_requests/"));
	assert.equal(kind("live").bytes, sum(s3, "notes/") + sum(s3, "scratch/"));
	assert.equal(kind("trash").objects, 7);
	assert.equal(kind("changes").objects, 2);
	assert.equal(body.kinds.reduce((n: number, k: any) => n + k.bytes, 0), all);
	// the projects add up too, biggest first
	assert.deepEqual(body.projects.map((p: any) => p.project), ["notes", "scratch"]);
	assert.equal(body.projects[0].bytes, sum(s3, "notes/") + sum(s3, "_trash/notes/") + sum(s3, "_history/notes/") + sum(s3, "_changes/notes/") + sum(s3, "_requests/notes/"));
});

test("tiny: per project, per kind, per device, with the device's name where its manifest gives one", async () => {
	const { s3, store } = accounts();
	tiny(s3);
	const { body } = await ask(s3, store, OWNER);
	const notes = body.projects[0];
	assert.deepEqual(notes.kinds.map((k: any) => k.kind), ["live", "history", "trash", "changes", "requests"]);
	const live = notes.kinds[0];
	assert.deepEqual(live.hosts.map((h: any) => [h.host, h.host_name]), [[GPU, "bam-GPU"], [WEB, "web"]]);
	assert.equal(live.hosts[0].bytes, sum(s3, `notes/hosts/${GPU}/`));
	const trash = notes.kinds.find((k: any) => k.kind === "trash");
	assert.deepEqual(trash.hosts.map((h: any) => [h.host, h.host_name, h.bytes, h.objects]), [[GPU, "bam-GPU", 12_800_000, 6]]);
	// a device that never published a manifest has no name to show, and is still counted
	const scratch = body.projects[1];
	assert.deepEqual(scratch.kinds.map((k: any) => [k.kind, k.hosts.map((h: any) => [h.host, h.host_name])]), [["live", [[LAPTOP, ""]]], ["trash", [[LAPTOP, ""]]]]);
});

test("tiny: the oldest and newest timestamp of a kind, from the key where the key carries one", async () => {
	const { s3, store } = accounts();
	tiny(s3);
	const { body } = await ask(s3, store, OWNER);
	const kind = (name: string) => body.kinds.find((k: any) => k.kind === name);
	// trash: the stamp in _trash/<project>/<host>/<stamp>/..., not the object's LastModified
	assert.deepEqual([kind("trash").oldest, kind("trash").newest, kind("trash").clock], ["2026-10-05T12:00:00.000Z", "2026-10-27T00:00:00.000Z", "key"]);
	// history: the version's written_at in its name
	assert.deepEqual([kind("history").oldest, kind("history").newest, kind("history").clock], ["2026-10-01T10:00:00.000Z", "2026-10-27T10:00:00.000Z", "key"]);
	// live files and records carry none: the store's LastModified
	assert.deepEqual([kind("live").clock, kind("changes").oldest, kind("changes").newest, kind("changes").clock], ["modified", "2026-10-27T10:00:00.000Z", "2026-10-28T20:00:00.000Z", "modified"]);
	const notes = body.projects[0].kinds.find((k: any) => k.kind === "trash");
	assert.deepEqual([notes.oldest, notes.newest], ["2026-10-05T12:00:00.000Z", "2026-10-26T18:00:00.000Z"]);
});

test("tiny: the biggest folders are three levels deep at most, and the biggest files add their old copies", async () => {
	const { s3, store } = accounts();
	tiny(s3);
	const { body } = await ask(s3, store, OWNER);
	assert.deepEqual(body.folders.map((f: any) => [f.project, f.host_name, f.folder, f.bytes, f.live_bytes, f.old_bytes]).slice(0, 4), [
		["notes", "bam-GPU", "logs", 17_800_000, 5_000_000, 12_800_000],
		["notes", "bam-GPU", "photos/2026/trip", 3_000_000, 3_000_000, 0],
		["notes", "bam-GPU", "notes", 5_300, 2_000, 3_300],
		["notes", "web", "site", 700, 700, 0],
	]);
	assert.ok(body.folders.length <= 10);
	assert.deepEqual(body.files.slice(0, 3).map((f: any) => [f.host_name, f.path, f.bytes, f.live_bytes, f.old_bytes, f.copies]), [
		["bam-GPU", "logs/agent.log", 17_800_000, 5_000_000, 12_800_000, 6],
		["bam-GPU", "photos/2026/trip/day1/IMG_1.jpg", 3_000_000, 3_000_000, 0, 0],
		["bam-GPU", "notes/plan.md", 5_300, 2_000, 3_300, 2],
	]);
	assert.ok(body.files.length <= 10);
});

test("tiny: suggestions say how much they free and why", async () => {
	const { s3, store } = accounts();
	tiny(s3);
	const { body } = await ask(s3, store, OWNER);
	assert.deepEqual(body.suggestions.map((s: any) => [s.id, s.title, s.bytes, s.objects]), [
		["log:notes/" + GPU + "/logs/agent.log", "logs/agent.log is an append-only log replaced 6 times", 9_800_000, 5],
		["trash-old", "Empty trash older than 7 days", 7_000_000, 4],
		["history-old", "Delete history older than 7 days", 1_500, 1],
	]);
	for (const s of body.suggestions) assert.match(s.why, /\S/);
	assert.match(body.suggestions[0].why, /12\.2 MiB.*9\.3 MiB/);
	assert.match(body.suggestions[0].why, /newest copy/);
});

test("a growing file with few copies, or a rewritten one, is not called a log", async () => {
	const { s3, store } = accounts();
	const put = (key: string, size: number, modified: string) => s3.put(`${ROOT}${key}`, blob(size), Date.parse(modified));
	// five copies of 1.2 MB each but one shrank: replaced many times, not append-only
	for (const [n, size] of [1_200_000, 1_300_000, 1_100_000, 1_400_000, 1_500_000].entries()) put(`_trash/p/${GPU}/2026102${n}T000000Z-aa00/db.sqlite`, size, "2026-10-20T00:00:00.000Z");
	// three copies: too few to say
	for (const [n, size] of [1_000_000, 2_000_000, 3_000_000].entries()) put(`_trash/p/${GPU}/2026102${n}T000000Z-bb00/small.log`, size, "2026-10-20T00:00:00.000Z");
	const { body } = await ask(s3, store, OWNER);
	const files = body.suggestions.filter((s: any) => s.id.startsWith("file:") || s.id.startsWith("log:"));
	assert.deepEqual(files.map((s: any) => [s.id, s.title]), [[`file:p/${GPU}/db.sqlite`, "db.sqlite has 5 old copies"]]);
});

test("an empty account is an answer, not an error", async () => {
	const { s3, store } = accounts();
	const { res, body } = await ask(s3, store, OWNER);
	assert.equal(res.status, 200);
	assert.deepEqual([body.used, body.projects, body.folders, body.files, body.suggestions, body.partial], [{ bytes: 0, objects: 0 }, [], [], [], [], false]);
});

test("over quota says why", async () => {
	const { s3, store } = accounts();
	tiny(s3);
	const { body } = await ask(s3, store, OWNER, { env: { QUOTA_BYTES: "1000000" } });
	assert.match(body.over, /holds \d+ bytes/);
});

test("keys outside the layout are counted as other, never dropped or thrown on", async () => {
	const { s3, store } = accounts();
	s3.put(`${ROOT}notes/stray.txt`, blob(50), NOW);
	s3.put(`${ROOT}_mystery/x`, blob(70), NOW);
	s3.put(`${ROOT}rootfile`, blob(30), NOW);
	const { res, body } = await ask(s3, store, OWNER);
	assert.equal(res.status, 200);
	assert.equal(body.used.bytes, 150);
	assert.equal(body.kinds.find((k: any) => k.kind === "other").bytes, 150);
});

test("signed out is 401 and reads nothing", async () => {
	const { s3, store } = accounts();
	tiny(s3);
	const { res, body } = await ask(s3, store, null);
	assert.equal(res.status, 401);
	assert.equal(body.error, "signed_out");
	assert.equal(s3.calls.length, 0);
});

test("nobody sees another account's prefix, and ?owner= is not a way to ask", async () => {
	const { s3, store } = accounts();
	tiny(s3);
	const stranger = await ask(s3, store, OTHER, { path: `${PATH}?owner=${OWNER.userId}` });
	assert.equal(stranger.res.status, 200);
	assert.deepEqual([stranger.body.owner, stranger.body.used, stranger.body.projects], [OTHER.userId, { bytes: 0, objects: 0 }, []]);
	assert.ok(s3.calls.length > 0);
	for (const call of s3.calls) {
		assert.ok(call.allowed, `${call.method} ${call.key || call.prefix} was refused`);
		assert.deepEqual(call.scoped, [`users/${OTHER.userId}/`]);
		assert.ok((call.prefix ?? call.key).startsWith(`users/${OTHER.userId}/`));
	}
});

test("it only reads: read-only keys, GETs and LISTs, and no other method", async () => {
	const { s3, store } = accounts();
	tiny(s3);
	const { res } = await ask(s3, store, OWNER);
	assert.equal(res.status, 200);
	assert.ok(s3.calls.length > 1);
	for (const call of s3.calls) {
		assert.ok(["LIST", "GET"].includes(call.method), call.method);
		assert.equal(call.scope, "object-read-only");
	}
	const before = s3.objects.size;
	for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await ask(s3, store, OWNER, { method })).res.status, 405);
	assert.equal(s3.objects.size, before);
});

test("a listing longer than the cap is cut and marked partial; uncapped, it is whole", async () => {
	const { s3, store } = accounts();
	for (let n = 0; n < 2_300; n++) s3.put(`${ROOT}p/hosts/${GPU}/f${String(n).padStart(5, "0")}.txt`, blob(10), NOW);
	const capped = await ask(s3, store, OWNER, { env: { BREAKDOWN_MAX_PAGES: "2" } });
	assert.equal(capped.body.partial, true);
	assert.deepEqual(capped.body.used, { bytes: 20_000, objects: 2_000 });
	const whole = await ask(s3, store, OWNER);
	assert.equal(whole.body.partial, false);
	assert.deepEqual(whole.body.used, { bytes: 23_000, objects: 2_300 });
});

test("the realistic account: about 90% old copies, and the UI's test reads exactly this answer", async () => {
	const { s3, store } = accounts();
	realistic(s3, store);
	const { res, body } = await ask(s3, store, OWNER, { env: { QUOTA_BYTES: String(10 * 1024 ** 3) } });
	assert.equal(res.status, 200);
	const trash = body.kinds.find((k: any) => k.kind === "trash").bytes;
	assert.ok(trash / body.used.bytes > 0.85 && trash / body.used.bytes < 0.95, `${trash} of ${body.used.bytes}`);
	assert.ok(body.suggestions.some((s: any) => s.id === `log:robotparts/${GPU}/logs/agent.log`));
	if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, `${JSON.stringify(body, null, "\t")}\n`);
	assert.deepEqual(body, JSON.parse(readFileSync(GOLDEN, "utf8")), "ui/test/fixtures/storage-breakdown.json is out of date: UPDATE_GOLDEN=1 npm --prefix accounts test");
});

test("the breakdown's quota is the owner's own ceiling (QUOTA_BY_OWNER), everyone else's is the default", async () => {
	const { s3, store } = accounts();
	tiny(s3);
	const granted = { QUOTA_BYTES: "100000000", QUOTA_BY_OWNER: JSON.stringify({ [OWNER.userId]: { bytes: 10 * 1024 ** 3 } }) };
	const own = await ask(s3, store, OWNER, { env: granted });
	assert.deepEqual(own.body.quota, { bytes: 10 * 1024 ** 3, objects: 100_000 }, "the person granted more sees their own ceiling");
	assert.equal(own.body.over, null);
	const other = await ask(s3, store, OTHER, { env: granted });
	assert.deepEqual(other.body.quota, { bytes: 100_000_000, objects: 100_000 }, "someone not named keeps the default");
});
