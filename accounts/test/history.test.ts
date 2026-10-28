// History in TypeScript against the shared fixtures (PEP 0007 §3.1-3.2): testdata/history/keys.json (keys and version
// ids, parsed and built) and testdata/retention/schedule.json (the write-time rule and the pruner's rule), which the
// engine's Go must pass too. Then the web host's own history: path first, the burst rule, *.log, the version a
// restore replaces, and the change record of each manifest version (testdata/changes/ shapes).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { historyKey, keepOnWrite, parseHistoryKey, parseVersion, pruneVersions, toMillis, trashStampTime, versionId } from "../src/history.ts";
import { memoryJournal, restoreWebFiles, writeWebFile, deleteWebFile } from "../src/webhost.ts";
import { mint } from "../src/creds.ts";
import { S3Bucket } from "../src/s3-bucket.ts";
import { MemoryS3 } from "./memory-s3.ts";

const TESTDATA = new URL("../../testdata/", import.meta.url);
const fixture = (path: string) => JSON.parse(readFileSync(new URL(path, TESTDATA), "utf8"));

test("testdata/history/keys.json: every valid key parses to its parts and is built back from them", () => {
	const keys = fixture("history/keys.json");
	assert.equal(keys.fixture, "folder-sync-history-keys/1");
	for (const k of keys.valid) {
		const parsed = parseHistoryKey(k.key);
		assert.deepEqual(parsed, { root: k.root, project: k.project, host: k.host, path: k.path, version: k.version }, k.key);
		assert.equal(historyKey(k.root, k.project, k.host, k.path, k.version), k.key);
		const v = parseVersion(k.version)!;
		assert.equal(v.unlisted, !!k.unlisted, k.key);
		if (!k.unlisted) {
			assert.equal(v.written_at, k.written_at);
			assert.equal(v.sha16, k.sha16);
		}
	}
	for (const id of keys.invalid_version_ids) assert.equal(parseVersion(id), null, id);
	for (const key of keys.invalid_keys) assert.equal(parseHistoryKey(key), null, key);
});

test("a version id truncates written_at to the millisecond, never rounding (PEP 0007 §14.6)", () => {
	const sha = "9f2c1a3b4c5d6e7f00112233445566778899aabbccddeeff0011223344556677";
	assert.equal(versionId("2026-10-28T20:31:00.117260411Z", sha), "2026-10-28T20:31:00.117Z_9f2c1a3b4c5d6e7f");
	assert.equal(versionId("2026-10-28T20:31:00.999999999Z", sha), "2026-10-28T20:31:00.999Z_9f2c1a3b4c5d6e7f");
	assert.equal(toMillis("2026-10-28T20:31:00Z"), "2026-10-28T20:31:00.000Z");
	assert.equal(toMillis("2026-10-28T20:31:00.5Z"), "2026-10-28T20:31:00.500Z");
	assert.equal(trashStampTime("20261020T000000Z"), Date.parse("2026-10-20T00:00:00Z"));
	assert.equal(trashStampTime("20261026T123456Z-789-1f2e3d4c"), Date.parse("2026-10-26T12:34:56.789Z"));
	assert.equal(trashStampTime("not-a-stamp"), null);
});

test("testdata/retention/schedule.json: the write-time rule, every case", () => {
	const cases = fixture("retention/schedule.json");
	assert.equal(cases.cases, "folder-sync-retention-cases/1");
	for (const c of cases.write_cases) {
		const got = keepOnWrite({ op: c.op, path: c.path, writtenAt: c.leaving.written_at, now: Date.parse(c.now), lastKeptLeftAt: c.last_kept_left_at ? Date.parse(c.last_kept_left_at) : null, noHistory: c.no_history });
		assert.equal(got.keep, c.keep, c.name);
		if (!c.keep) assert.equal((got as { why: string }).why, c.why, c.name);
	}
});

test("testdata/retention/schedule.json: the pruner's rule, every case", () => {
	const cases = fixture("retention/schedule.json");
	assert.ok(cases.prune_cases.length >= 8);
	for (const c of cases.prune_cases) {
		const kept = pruneVersions(c.versions.map((v: { id: string; left_at: string }) => ({ id: v.id, left_at: Date.parse(v.left_at) })), Date.parse(c.now), c.keep_days);
		assert.deepEqual([...kept].sort(), [...c.keep].sort(), c.name);
		// idempotent: pruning what was kept keeps all of it
		const again = pruneVersions(c.versions.filter((v: { id: string }) => kept.has(v.id)).map((v: { id: string; left_at: string }) => ({ id: v.id, left_at: Date.parse(v.left_at) })), Date.parse(c.now), c.keep_days);
		assert.deepEqual([...again].sort(), [...kept].sort(), `${c.name}: a second prune deletes nothing more`);
	}
});

// ------------------------------------------------------------------------------------------------ the web host's history

const ENDPOINT = "https://acct0123.r2.cloudflarestorage.com";
const ROOT = "users/ownerABC123/";
const WEB = "3f1c2a9e-5b7d-4c11-8e2f-0a1b2c3d4e5f";
const w = { root: ROOT, project: "notes", hostId: WEB };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function webHost(start = Date.parse("2026-10-28T12:00:00.000Z")) {
	const s3 = new MemoryS3(ENDPOINT, "folder-sync");
	const clock = { now: start };
	s3.now = () => clock.now;
	const env = { R2_ACCOUNT_ID: "acct0123", R2_PARENT_ACCESS_KEY_ID: "p", R2_PARENT_SECRET_ACCESS_KEY: "s", SYNC_BUCKET: "folder-sync" };
	const bucket = new S3Bucket(await mint(env, ROOT, "object-read-write", 300, start), s3.fetch);
	const journal = memoryJournal();
	const put = (path: string, text: string, extra = {}) => writeWebFile(bucket, w, path, new TextEncoder().encode(text), () => clock.now, journal, extra);
	const versions = (path: string) => [...s3.objects.keys()].filter((k) => k.startsWith(`${ROOT}_history/notes/${WEB}/${path}/`)).map((k) => k.slice(k.lastIndexOf("/") + 1));
	const record = (seq: number) => JSON.parse(s3.text(`${ROOT}_changes/notes/${WEB}/${String(seq).padStart(12, "0")}.json`)!);
	return { s3, clock, bucket, journal, put, versions, record };
}

test("the web host keeps a replaced version at _history/<project>/<host>/<path>/<written_at>_<sha16>, with its record", async () => {
	const h = await webHost();
	await h.put("notes/plan.md", "one\n", { via: "Chrome on Linux", receivedAt: h.clock.now - 7 });
	h.clock.now += 60_000;
	await h.put("notes/plan.md", "two\n", { via: "Chrome on Linux", receivedAt: h.clock.now - 5 });
	const id = `2026-10-28T12:00:00.000Z_${sha("one\n").slice(0, 16)}`;
	assert.deepEqual(h.versions("notes/plan.md"), [id]);
	assert.equal(h.s3.text(`${ROOT}_history/notes/${WEB}/notes/plan.md/${id}`), "one\n", "the version's exact bytes");
	assert.equal(h.s3.modified.get(`${ROOT}_history/notes/${WEB}/notes/plan.md/${id}`), h.clock.now, "LastModified is when it left (left_at)");
	const first = h.record(1);
	const second = h.record(2);
	// the shapes of testdata/changes/web-000000000006.json
	assert.deepEqual(Object.keys(second).sort(), ["at", "by", "events", "host_id", "host_name", "project", "schema", "seq", "via"]);
	assert.deepEqual([second.schema, second.by, second.via, second.seq, second.host_name], ["folder-sync-changes/1", "web", "Chrome on Linux", 2, "web"]);
	assert.deepEqual(first.events[0], { schema: "folder-sync-event/1", event: "upload", at: "2026-10-28T12:00:00.000Z", level: "info", project: "notes", host: WEB, host_name: "web", seq: 1, path: "notes/plan.md", size: 4, sha256: sha("one\n"), op: "add", up_ms: 7 });
	assert.deepEqual(second.events[0].was, { sha256: sha("one\n"), size: 4, written_at: "2026-10-28T12:00:00.000Z", kept: id });
	assert.equal(second.events[0].up_ms, 5, "up_ms: from the Worker receiving the write to its manifest");
	assert.equal(second.at, JSON.parse(h.s3.text(`${ROOT}notes/hosts/${WEB}/manifest.json`)!).generated_at, "a record's at is its manifest's generated_at");
});

test("the burst rule at write time: at most one version per 30 s per path; a delete and a restore always keep", async () => {
	const h = await webHost();
	await h.put("a.md", "v1\n");
	h.clock.now += 1000;
	await h.put("a.md", "v2\n"); // v1 lived 1 s, nothing kept yet: kept
	h.clock.now += 1000;
	await h.put("a.md", "v3\n"); // v2 lived 1 s, v1 kept 1 s ago: a burst
	h.clock.now += 1000;
	await h.put("a.md", "v4\n"); // the same
	assert.equal(h.versions("a.md").length, 1, "one kept version, the burst's undo copies removed");
	assert.deepEqual([h.record(3).events[0].was.kept, h.record(3).events[0].was.why], [null, "burst"]);
	h.clock.now += 30_000;
	await h.put("a.md", "v5\n"); // v4 lived 30 s: kept, whatever was kept before
	assert.equal(h.versions("a.md").length, 2);
	// a restore inside a burst still keeps the version it replaces
	h.clock.now += 1000;
	const v1 = h.versions("a.md").sort()[0];
	const restored = await restoreWebFiles(h.bucket, w, [{ path: "a.md", version: v1 }], () => h.clock.now, h.journal);
	assert.deepEqual(restored.failed, []);
	assert.equal(h.s3.text(`${ROOT}notes/hosts/${WEB}/a.md`), "v1\n");
	assert.equal(h.versions("a.md").length, 3, "v5 kept by the restore, inside the burst");
	const r = h.record(restored.applied[0].seq).events[0];
	assert.deepEqual([r.event, r.from, r.size, r.sha256, r.was.kept !== null], ["restore", v1, 3, sha("v1\n"), true]);
	// a delete always keeps
	h.clock.now += 1000;
	await deleteWebFile(h.bucket, w, "a.md", () => h.clock.now, h.journal);
	assert.equal(h.versions("a.md").length, 4);
});

test("*.log keeps no history, replaced or deleted (no_history's default)", async () => {
	const h = await webHost();
	await h.put("logs/run.log", "a\n");
	h.clock.now += 3600_000;
	await h.put("logs/run.log", "ab\n");
	h.clock.now += 3600_000;
	await deleteWebFile(h.bucket, w, "logs/run.log", () => h.clock.now, h.journal);
	assert.deepEqual(h.versions("logs/run.log"), []);
	assert.deepEqual(h.record(2).events[0].was, { sha256: sha("a\n"), size: 2, written_at: "2026-10-28T12:00:00.000Z", kept: null, why: "no_history" });
	assert.equal(h.record(3).events[0].was.why, "no_history");
});

test("a restore checks the version's bytes against its name: a mislabelled copy is never restored", async () => {
	const h = await webHost();
	await h.put("x.json", "{}\n");
	h.clock.now += 60_000;
	await h.put("x.json", "[]\n");
	const [id] = h.versions("x.json");
	h.s3.put(`${ROOT}_history/notes/${WEB}/x.json/${id}`, "tampered\n");
	const out = await restoreWebFiles(h.bucket, w, [{ path: "x.json", version: id }, { path: "x.json", version: "2026-09-01T00:00:00.000Z_0000111122223333" }], () => h.clock.now, h.journal);
	assert.deepEqual(out, { applied: [], failed: [{ host: WEB, path: "x.json", version: id, error: "mismatch" }, { host: WEB, path: "x.json", version: "2026-09-01T00:00:00.000Z_0000111122223333", error: "pruned" }] });
	assert.equal(h.s3.text(`${ROOT}notes/hosts/${WEB}/x.json`), "[]\n", "nothing written");
});

test("mutation: without the burst rule's 30 s memory every save is kept (red)", async () => {
	const h = await webHost();
	// the mutant: a journal that never remembers what it kept
	h.journal.kept = async () => undefined;
	await h.put("a.md", "v1\n");
	for (let n = 2; n <= 5; n++) {
		h.clock.now += 1000;
		await h.put("a.md", `v${n}\n`);
	}
	assert.notEqual(h.versions("a.md").length, 1, "the burst rule's test above would go red");
});
