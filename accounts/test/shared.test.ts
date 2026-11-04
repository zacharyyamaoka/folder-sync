// The shared tree through the Worker (docs/peps/0010): one tree of files that every device and page of a folder edits,
// written by the folder's object alone. What must hold (PEP 0010 §11):
//   - two devices editing different files converge; two editing one text file merge three-way; the same line, or a binary
//     file, becomes one conflict copy with Obsidian's exact name, holding exactly the bytes the second device sent;
//   - an edit beats a delete, in both orders; a rename is a delete plus an add;
//   - two appends to a JSONL both stay, and cost pointers in history, not copies;
//   - a merge whose base the throttle dropped repeats no line; a merge that no longer parses is a conflict copy;
//   - a commit cut off mid-way is undone from the journal, and nothing is left half-written;
//   - only the owner commits (a cookie write needs the CSRF header; a reader or a stranger is refused), nothing private is
//     written, and a reader that has never heard of the shared tree reads it like any host.
// The accounts layer is a stand-in (as worker.test.ts): Better Auth itself is exercised end to end by test/proof.mjs.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { handle, type Deps, type Env, type Person } from "../src/app.ts";
import { Project } from "../../readers/worker/src/folder-sync-read.ts";
import { S3Bucket } from "../src/s3-bucket.ts";
import { pruneFolder } from "../src/prune.ts";
import { mint, userRoot } from "../src/creds.ts";
import { memoryStorage, WebHostCore, type WebAnswer, type WebOp } from "../src/webhost.ts";
import { MemoryS3 } from "./memory-s3.ts";
import { MemoryStore } from "./memory-store.ts";
import { d1Store, type D1Like } from "../src/store.ts";

const ENDPOINT = "https://acct0123.r2.cloudflarestorage.com";
const SITE = "https://robotparts.dev";
const T0 = Date.parse("2026-11-04T12:00:00.000Z");
const OWNER: Person = { userId: "AbC123zz9yX8", email: "zach@example.com", name: "Zach", image: null, sessionId: "sess-owner", sessionToken: "tok-owner" };
const READER: Person = { userId: "ReaderQq77Mm", email: "reader@example.com", name: "Reader", image: null, sessionId: "sess-reader", sessionToken: "tok-reader" };
const ROOT = `users/${OWNER.userId}/`;
const GPU = "b55e9683-7854-4121-a56a-9bae7c3ab1da";
const AIR = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const enc = new TextEncoder();

function env(): Env {
	return { ENVIRONMENT: "production", PUBLIC_URL: "https://accounts.example.test", R2_ACCOUNT_ID: "acct0123", R2_PARENT_ACCESS_KEY_ID: "parent-key-id", R2_PARENT_SECRET_ACCESS_KEY: "parent-secret-fixture", SYNC_BUCKET: "folder-sync" };
}

interface Result {
	path: string;
	outcome: "accepted" | "merged" | "conflict" | "edit_won";
	version?: string;
	sha256?: string;
	size?: number;
	merge?: string;
	kept_as?: string;
	why?: string;
	conflict_path?: string;
	conflict_version?: string;
}
interface Answer {
	host: string;
	name: string;
	seq: number;
	changed: boolean;
	results: Result[];
	error?: string;
	why?: string;
}

/** A change as a device sends it. */
interface Edit {
	path: string;
	text?: string;
	bytes?: Uint8Array;
	base?: { version: string; sha256?: string } | null;
	delete?: boolean;
	at_local?: string;
}

function world(options: { webHost?: (op: WebOp) => Promise<WebAnswer> } = {}) {
	const clock = { now: T0 };
	const s3 = new MemoryS3(ENDPOINT, "folder-sync");
	s3.now = () => clock.now;
	const store = new MemoryStore();
	store.usageRows.set(OWNER.userId, { bytes: 1, objects: 1, measured_at: new Date(T0 - 1000).toISOString(), history: { bytes: 0, objects: 0 } });
	let who: Person | null = OWNER;
	const hubTold: unknown[] = [];
	const deps: Deps = {
		auth: async () => new Response("{}"), person: async () => who, signOut: async () => [], store, s3: s3.fetch, now: () => clock.now, uuid: () => crypto.randomUUID(),
		...(options.webHost ? { webHost: options.webHost } : {}),
	};
	const environment: Env = { ...env(), HUB: { idFromName: (n: string) => n, get: () => ({ fetch: async (r: Request) => { hubTold.push(await r.json()); return new Response("ok"); } }) } as Env["HUB"] };
	const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, asCookie = false) =>
		handle(new Request(`${SITE}${path}`, {
			method,
			headers: asCookie
				? { Cookie: `s=${OWNER.sessionId}`, Origin: SITE, "X-Folder-Sync": "1", "X-Folder-Sync-User": OWNER.userId, "Content-Type": "application/json", ...headers }
				: { Authorization: "Bearer machine-token", "Content-Type": "application/json", ...headers },
			...(body === undefined ? {} : { body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body) }),
		}), environment, deps);
	const tick = (ms = 1000) => { clock.now += ms; };
	const share = async (priv?: string[]) => (await call("POST", "/fs/v1/folders/notes/share", priv === undefined ? undefined : { private: priv })).json() as Promise<{ host: string; created: boolean; private: string[]; seq: number }>;
	const commit = async (device: string, edits: Edit[], extra: Record<string, unknown> = {}, host?: string): Promise<Answer> => {
		const res = await call("POST", "/fs/v1/folders/notes/shared", {
			device, ...(host ? { host } : {}), ...extra,
			changes: edits.map((e) => {
				if (e.delete) return { path: e.path, base: e.base ?? null, delete: true };
				const data = e.bytes ?? enc.encode(e.text ?? "");
				return { path: e.path, base: e.base ?? null, sha256: sha(data), size: data.byteLength, body: Buffer.from(data).toString("base64"), ...(e.at_local ? { at_local: e.at_local } : {}) };
			}),
		});
		const answer = (await res.json()) as Answer;
		(answer as { status?: number }).status = res.status;
		return answer;
	};
	return { clock, s3, store, call, tick, share, commit, hubTold, who: (p: Person | null) => { who = p; } };
}

type World = ReturnType<typeof world>;

const base = (r: Result) => ({ version: r.version!, sha256: r.sha256 });
const live = (w: World, tree: string, path: string) => w.s3.text(`${ROOT}notes/hosts/${tree}/${path}`);
const manifestOf = (w: World, tree: string) => JSON.parse(w.s3.text(`${ROOT}notes/hosts/${tree}/manifest.json`)!) as { seq: number; host_name: string; shared?: { private: string[] }; files: { path: string; sha256: string; size: number }[] };
const historyOf = (w: World, tree: string, path: string) => [...w.s3.objects.keys()].filter((k) => k.startsWith(`${ROOT}_history/notes/${tree}/${path}/`)).map((k) => k.slice(`${ROOT}_history/notes/${tree}/${path}/`.length)).sort();
// WHY waited: the folder's object writes a change record once it has answered (CONTRACT "Consistency")
const recordOf = async (w: World, tree: string, seq: number) => {
	const key = `${ROOT}_changes/notes/${tree}/${String(seq).padStart(12, "0")}.json`;
	for (let i = 0; i < 200 && !w.s3.text(key); i++) await new Promise((done) => setTimeout(done, 5));
	return JSON.parse(w.s3.text(key)!) as { by: string; via?: string; host_name: string; events: Record<string, any>[] };
};

async function shared(): Promise<{ w: World; tree: string }> {
	const w = world();
	const out = await w.share();
	return { w, tree: out.host };
}

test("share: mints the tree once, writes its empty manifest with the private rule, tells the hub; again returns it; a different rule is refused", async () => {
	const w = world();
	const first = await w.share(["events/", "*.sqlite"]);
	assert.equal(first.created, true);
	assert.match(first.host, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	const m = manifestOf(w, first.host);
	assert.deepEqual([m.seq, m.host_name, m.shared, m.files], [1, "shared", { private: ["events/", "*.sqlite"] }, []]);
	assert.deepEqual(w.hubTold, [{ host: first.host, seq: 1, web: true }]);
	const again = await w.share(["events/", "*.sqlite"]);
	assert.deepEqual([again.host, again.created], [first.host, false]);
	const bare = await w.call("POST", "/fs/v1/folders/notes/share");
	assert.equal(bare.status, 200, JSON.stringify(await bare.clone().json()));
	assert.equal(((await bare.json()) as { host: string; private: string[] }).private.join(), "events/,*.sqlite", "asking with no rule returns the tree as it is");
	const different = await w.call("POST", "/fs/v1/folders/notes/share", { private: ["other/"] });
	assert.equal(different.status, 409);
	assert.equal(((await different.json()) as { error: string }).error, "already_shared");
	assert.equal(w.hubTold.length, 1, "only the first share is announced");
	const bad = await w.call("POST", "/fs/v1/folders/notes/share", { private: "events/" });
	assert.equal(bad.status, 400);
	assert.equal((await w.call("POST", "/fs/v1/folders/notes/share", { other: 1 })).status, 400);
});

test("two devices editing different files converge on one tree with both files", async () => {
	const { w, tree } = await shared();
	const a = await w.commit("bam-GPU", [{ path: "a.md", text: "from the GPU\n" }], {}, GPU);
	w.tick();
	const b = await w.commit("bam-Air", [{ path: "notes/b.md", text: "from the Air\n" }], {}, AIR);
	assert.deepEqual(a.results.map((r) => r.outcome), ["accepted"]);
	assert.deepEqual(b.results.map((r) => r.outcome), ["accepted"]);
	assert.equal(live(w, tree, "a.md"), "from the GPU\n");
	assert.equal(live(w, tree, "notes/b.md"), "from the Air\n");
	const m = manifestOf(w, tree);
	assert.deepEqual(m.files.map((f) => f.path), ["a.md", "notes/b.md"]);
	assert.equal(m.seq, 3, "one manifest version per commit: the share, then each commit");
	assert.deepEqual(w.hubTold.map((t) => (t as { seq: number }).seq), [1, 2, 3]);
	assert.equal(a.results[0].version, `${new Date(T0).toISOString()}_${sha("from the GPU\n").slice(0, 16)}`);
});

test("a commit holds many paths and writes one manifest version", async () => {
	const { w, tree } = await shared();
	const edits = Array.from({ length: 12 }, (_, i) => ({ path: `bulk/${i}.md`, text: `file ${i}\n` }));
	const answer = await w.commit("bam-GPU", edits, {}, GPU);
	assert.equal(answer.seq, 2);
	assert.equal(manifestOf(w, tree).files.length, 12);
	assert.equal((await recordOf(w, tree, 2)).events.length, 12);
	assert.equal(w.s3.calls.filter((c) => c.method === "PUT" && c.key.endsWith("/manifest.json")).length, 2, "the share and the commit, not one per path");
});

test("the same text file edited on two devices merges three-way: both edits, and both inputs restorable", async () => {
	const { w, tree } = await shared();
	const v1 = (await w.commit("bam-GPU", [{ path: "notes/plan.md", text: "# Plan\n\n- one\n- two\n- three\n- four\n" }], {}, GPU)).results[0];
	w.tick();
	// the Air edits the top line, then the GPU the bottom one, both from v1
	const air = await w.commit("bam-Air", [{ path: "notes/plan.md", text: "# Plan\n\n- ONE\n- two\n- three\n- four\n", base: base(v1) }], {}, AIR);
	w.tick();
	const gpu = await w.commit("bam-GPU", [{ path: "notes/plan.md", text: "# Plan\n\n- one\n- two\n- three\n- FOUR\n", base: base(v1) }], {}, GPU);
	assert.equal(air.results[0].outcome, "accepted");
	const merged = gpu.results[0];
	assert.equal(merged.outcome, "merged");
	assert.equal(merged.merge, "lines");
	assert.equal(live(w, tree, "notes/plan.md"), "# Plan\n\n- ONE\n- two\n- three\n- FOUR\n");
	assert.equal(merged.sha256, sha(live(w, tree, "notes/plan.md")!));
	// both inputs are in history: theirs (the Air's) as the leaving version, the GPU's own bytes under their own id
	const ids = historyOf(w, tree, "notes/plan.md");
	assert.ok(ids.includes(merged.kept_as!), "the device's own bytes are kept");
	assert.equal(w.s3.text(`${ROOT}_history/notes/${tree}/notes/plan.md/${merged.kept_as}`), "# Plan\n\n- one\n- two\n- three\n- FOUR\n");
	const theirs = `${new Date(T0 + 1000).toISOString()}_${sha("# Plan\n\n- ONE\n- two\n- three\n- four\n").slice(0, 16)}`;
	assert.equal(w.s3.text(`${ROOT}_history/notes/${tree}/notes/plan.md/${theirs}`), "# Plan\n\n- ONE\n- two\n- three\n- four\n", "the Air's version is kept whole, whatever the throttle");
	const event = (await recordOf(w, tree, 4)).events.find((e) => e.event === "upload")!;
	assert.equal(event.by_name, "bam-GPU");
	assert.equal(event.by_host, GPU);
	assert.deepEqual(event.merge, { base: v1.version, yours: merged.kept_as, result: merged.version });
});

test("the same line edited on two devices: the first change stays, the second becomes a conflict copy with Obsidian's name, byte for byte", async () => {
	const { w, tree } = await shared();
	const v1 = (await w.commit("bam-GPU", [{ path: "notes/plan.md", text: "# Plan\n\n- one\n- two\n- three\n" }], {}, GPU)).results[0];
	w.tick();
	await w.commit("bam-GPU", [{ path: "notes/plan.md", text: "# Plan\n\n- one\n- two (the GPU)\n- three\n", base: base(v1) }], {}, GPU);
	w.tick();
	const mine = "# Plan\n\n- one\n- two (the Air)\n- three\n";
	const out = await w.commit("bam-Air", [{ path: "notes/plan.md", text: mine, base: base(v1), at_local: "2026-11-04T09:07:44-08:00" }], {}, AIR);
	const r = out.results[0];
	assert.equal(r.outcome, "conflict");
	assert.equal(r.why, "overlap");
	assert.equal(r.conflict_path, "notes/plan (Conflicted copy bam-Air 202611040907).md");
	assert.equal(live(w, tree, "notes/plan.md"), "# Plan\n\n- one\n- two (the GPU)\n- three\n", "the path keeps the first change");
	assert.equal(live(w, tree, r.conflict_path!), mine, "the copy holds exactly what the second device wrote");
	assert.equal(r.conflict_version, `${new Date(T0 + 2000).toISOString()}_${sha(mine).slice(0, 16)}`);
	assert.ok(manifestOf(w, tree).files.some((f) => f.path === r.conflict_path), "the copy is a shared file: it syncs to every device");
	assert.ok(!live(w, tree, "notes/plan.md")!.includes("<<<<"), "no conflict markers are ever written into a file");
	const events = (await recordOf(w, tree, 4)).events;
	assert.deepEqual(events.map((e) => [e.event, e.path]).sort(), [["conflict", "notes/plan.md"], ["upload", r.conflict_path]].sort());
	const conflict = events.find((e) => e.event === "conflict")!;
	assert.equal(conflict.kept_at, r.conflict_path);
	assert.equal(conflict.level, "warn");
	assert.equal(conflict.peer_name, "bam-Air");
});

test("a binary file edited on both devices: a conflict copy, both versions sha256-identical to what each device wrote", async () => {
	const { w, tree } = await shared();
	const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, n, 255, 254]);
	const v1 = (await w.commit("bam-GPU", [{ path: "img/photo.png", bytes: png(1) }], {}, GPU)).results[0];
	w.tick();
	await w.commit("bam-GPU", [{ path: "img/photo.png", bytes: png(2), base: base(v1) }], {}, GPU);
	w.tick();
	const out = await w.commit("bam-Air", [{ path: "img/photo.png", bytes: png(3), base: base(v1), at_local: "2026-11-04T09:08:00-08:00" }], {}, AIR);
	const r = out.results[0];
	assert.deepEqual([r.outcome, r.why, r.conflict_path], ["conflict", "not_mergeable", "img/photo (Conflicted copy bam-Air 202611040908).png"]);
	assert.equal(sha(w.s3.objects.get(`${ROOT}notes/hosts/${tree}/img/photo.png`)!), sha(png(2)));
	assert.equal(sha(w.s3.objects.get(`${ROOT}notes/hosts/${tree}/${r.conflict_path}`)!), sha(png(3)));
});

test("a device named bam:laptop/2 that conflicts twice in one minute: valid Windows names, and the second gets 2", async () => {
	const { w, tree } = await shared();
	const v1 = (await w.commit("a", [{ path: "plan.md", text: "1\n2\n3\n" }], {}, GPU)).results[0];
	w.tick();
	await w.commit("a", [{ path: "plan.md", text: "1\nGPU\n3\n", base: base(v1) }], {}, GPU);
	w.tick();
	const first = (await w.commit("bam:laptop/2", [{ path: "plan.md", text: "1\nX\n3\n", base: base(v1), at_local: "2026-11-04T09:08:10-08:00" }], {}, AIR)).results[0];
	w.tick();
	const second = (await w.commit("bam:laptop/2", [{ path: "plan.md", text: "1\nY\n3\n", base: base(v1), at_local: "2026-11-04T09:08:50-08:00" }], {}, AIR)).results[0];
	assert.equal(first.conflict_path, "plan (Conflicted copy bam-laptop-2 202611040908).md");
	assert.equal(second.conflict_path, "plan (Conflicted copy bam-laptop-2 202611040908) 2.md");
	for (const r of [first, second]) assert.doesNotMatch(r.conflict_path!, /[<>:"|?*\\]/);
	assert.equal(live(w, tree, second.conflict_path!), "1\nY\n3\n");
});

test("an edit beats a delete, in both orders; deleting an unchanged file deletes it", async () => {
	const { w, tree } = await shared();
	const v1 = (await w.commit("bam-GPU", [{ path: "a.md", text: "one\n" }, { path: "b.md", text: "two\n" }, { path: "c.md", text: "three\n" }], {}, GPU)).results;
	w.tick();
	// c: deleted by the GPU from its current version: gone, and its last bytes are kept
	const del = await w.commit("bam-GPU", [{ path: "c.md", delete: true, base: base(v1[2]) }], {}, GPU);
	assert.equal(del.results[0].outcome, "accepted");
	assert.equal(live(w, tree, "c.md"), null);
	assert.ok(historyOf(w, tree, "c.md").length === 1, "the deleted file's bytes are in history");
	w.tick();
	// a: the Air edits it, then the GPU deletes it from the old version: the delete is not applied, the edit comes back
	const edit = (await w.commit("bam-Air", [{ path: "a.md", text: "one, edited\n", base: base(v1[0]) }], {}, AIR)).results[0];
	w.tick();
	const lost = await w.commit("bam-GPU", [{ path: "a.md", delete: true, base: base(v1[0]) }], {}, GPU);
	assert.equal(lost.results[0].outcome, "edit_won");
	assert.equal(lost.results[0].version, edit.version, "the answer names the version that won");
	assert.equal(live(w, tree, "a.md"), "one, edited\n");
	w.tick();
	// b: the GPU deletes it, then the Air edits it from the old version: the file comes back, with the edit
	await w.commit("bam-GPU", [{ path: "b.md", delete: true, base: base(v1[1]) }], {}, GPU);
	w.tick();
	const back = await w.commit("bam-Air", [{ path: "b.md", text: "two, edited offline\n", base: base(v1[1]) }], {}, AIR);
	assert.equal(back.results[0].outcome, "accepted");
	assert.equal(live(w, tree, "b.md"), "two, edited offline\n");
	assert.equal(historyOf(w, tree, "b.md").length, 1, "their delete kept the deleted version when it left");
	// a delete of a file that is already gone is accepted
	assert.equal((await w.commit("bam-Air", [{ path: "c.md", delete: true, base: base(v1[2]) }], {}, AIR)).results[0].outcome, "accepted");
});

test("a rename is a delete plus an add; an edit that races it leaves both names", async () => {
	const { w, tree } = await shared();
	const v1 = (await w.commit("bam-GPU", [{ path: "old.md", text: "body\n" }], {}, GPU)).results[0];
	w.tick();
	const renamed = await w.commit("bam-GPU", [{ path: "old.md", delete: true, base: base(v1) }, { path: "new.md", text: "body\n" }], {}, GPU);
	assert.deepEqual(renamed.results.map((r) => r.outcome), ["accepted", "accepted"]);
	assert.deepEqual(manifestOf(w, tree).files.map((f) => f.path), ["new.md"]);
	assert.equal((await recordOf(w, tree, 3)).events.length, 2, "a delete event and an upload event, in one change record");
	w.tick();
	// the Air edited old.md from v1 while the rename happened: the edit beats the delete (PEP 0010 §15 names this)
	const raced = await w.commit("bam-Air", [{ path: "old.md", text: "body, edited\n", base: base(v1) }], {}, AIR);
	assert.equal(raced.results[0].outcome, "accepted");
	assert.deepEqual(manifestOf(w, tree).files.map((f) => f.path), ["new.md", "old.md"]);
});

test("two appends to one JSONL: both tails, no conflict copy, and only pointers in history", async () => {
	const { w, tree } = await shared();
	const log = (n: number) => Array.from({ length: n }, (_, i) => `{"n":${i + 1}}\n`).join("");
	const v1 = (await w.commit("bam-GPU", [{ path: "logs/events.jsonl", text: log(2) }], {}, GPU)).results[0];
	w.tick(400_000); // past the 5-minute window: the leaving version is kept
	await w.commit("bam-GPU", [{ path: "logs/events.jsonl", text: `${log(2)}{"n":"gpu"}\n`, base: base(v1) }], {}, GPU);
	w.tick(400_000);
	const air = await w.commit("bam-Air", [{ path: "logs/events.jsonl", text: `${log(2)}{"n":"air"}\n`, base: base(v1) }], {}, AIR);
	assert.equal(air.results[0].outcome, "merged");
	assert.equal(air.results[0].merge, "tails");
	assert.equal(air.results[0].kept_as, undefined, "a tails merge keeps nothing else");
	assert.equal(live(w, tree, "logs/events.jsonl"), `${log(2)}{"n":"gpu"}\n{"n":"air"}\n`, "theirs, then our tail");
	assert.ok(![...w.s3.objects.keys()].some((k) => k.includes("Conflicted")), "no conflict copy");
	const kinds = historyOf(w, tree, "logs/events.jsonl").map((id) => id.split(".").pop());
	assert.deepEqual(kinds, ["prefix", "prefix"], `an append leaves as a pointer of about 125 bytes: ${historyOf(w, tree, "logs/events.jsonl")}`);
	for (const id of historyOf(w, tree, "logs/events.jsonl")) assert.ok(w.s3.objects.get(`${ROOT}_history/notes/${tree}/logs/events.jsonl/${id}`)!.byteLength < 200);
});

test("a pointer opens to the version it names, through the history route; a rewrite after pointers keeps the version whole (the pin)", async () => {
	const { w, tree } = await shared();
	const v1 = (await w.commit("bam-GPU", [{ path: "log.txt", text: "a\n" }], {}, GPU)).results[0];
	w.tick(400_000);
	const v2 = (await w.commit("bam-GPU", [{ path: "log.txt", text: "a\nb\n", base: base(v1) }], {}, GPU)).results[0];
	w.tick(400_000);
	const v3 = (await w.commit("bam-GPU", [{ path: "log.txt", text: "a\nb\nc\n", base: base(v2) }], {}, GPU)).results[0];
	assert.deepEqual(historyOf(w, tree, "log.txt").map((n) => n.split(".").pop()), ["prefix", "prefix"]);
	// a rewrite 1 minute later: v3 must be kept whole although the throttle would drop it (a pointer rests on it)
	w.tick(60_000);
	await w.commit("bam-GPU", [{ path: "log.txt", text: "z\n", base: base(v3) }], {}, GPU);
	const names = historyOf(w, tree, "log.txt");
	assert.ok(names.includes(v3.version!), `v3 is kept whole: ${names}`);
	for (const [v, text] of [[v1, "a\n"], [v2, "a\nb\n"], [v3, "a\nb\nc\n"]] as const) {
		const res = await w.call("GET", `/fs/v1/folders/notes/history/${tree}/log.txt?version=${encodeURIComponent(v.version!)}`, undefined, {}, true);
		assert.equal(res.status, 200);
		assert.equal(await res.text(), text);
	}
});

test("a merge whose base the throttle dropped uses the newest older version: no repeated line", async () => {
	const { w, tree } = await shared();
	const v1 = (await w.commit("bam-GPU", [{ path: "n.md", text: "a\nb\nc\nd\ne\nf\ng\n" }], {}, GPU)).results[0];
	w.tick(60_000);
	const v2 = (await w.commit("bam-GPU", [{ path: "n.md", text: "a\nB\nc\nd\ne\nf\ng\n", base: base(v1) }], {}, GPU)).results[0];
	w.tick(60_000);
	await w.commit("bam-GPU", [{ path: "n.md", text: "a\nB\nc\nD\ne\nf\ng\n", base: base(v2) }], {}, GPU);
	assert.ok(!historyOf(w, tree, "n.md").includes(v2.version!), "v2 left inside the window of a version already kept: the throttle dropped it");
	w.tick(1000);
	// the Air made its edit from v2, which no longer exists anywhere
	const out = await w.commit("bam-Air", [{ path: "n.md", text: "a\nB\nc\nd\ne\nF\ng\n", base: base(v2) }], {}, AIR);
	assert.equal(out.results[0].outcome, "merged");
	assert.equal(live(w, tree, "n.md"), "a\nB\nc\nD\ne\nF\ng\n");
});

test("a JSON merge that no longer parses is a conflict copy; one that parses merges", async () => {
	const { w, tree } = await shared();
	const v1 = (await w.commit("a", [{ path: "app.toml", text: "a = 1\n\nb = 2\n\nc = 3\n" }], {}, GPU)).results[0];
	w.tick();
	await w.commit("a", [{ path: "app.toml", text: "a = 1\nd = 4\n\nb = 2\n\nc = 3\n", base: base(v1) }], {}, GPU);
	w.tick();
	const out = (await w.commit("b", [{ path: "app.toml", text: "a = 1\n\nb = 2\n\nc = 3\nd = 5\n", base: base(v1), at_local: "2026-11-04T10:00:00Z" }], {}, AIR)).results[0];
	assert.deepEqual([out.outcome, out.why], ["conflict", "parse"]);
	assert.equal(live(w, tree, "app.toml"), "a = 1\nd = 4\n\nb = 2\n\nc = 3\n");
});

test("an offline device catches up: a stale base is merged against everything that happened, once", async () => {
	const { w, tree } = await shared();
	const v1 = (await w.commit("bam-GPU", [{ path: "todo.md", text: "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n" }], {}, GPU)).results[0];
	let latest = v1;
	for (const [n, line] of [[0, "one"], [4, "five"], [8, "nine"]] as const) {
		w.tick(60_000);
		const lines = live(w, tree, "todo.md")!.split("\n");
		lines[n] = line;
		latest = (await w.commit("bam-GPU", [{ path: "todo.md", text: lines.join("\n"), base: base(latest) }], {}, GPU)).results[0];
	}
	w.tick(60_000);
	// the Air was offline since v1 and edited lines 3 and 7 (index 2 and 6), between the GPU's three edits
	const out = await w.commit("bam-Air", [{ path: "todo.md", text: "1\n2\nTHREE\n4\n5\n6\nSEVEN\n8\n9\n10\n", base: base(v1) }], {}, AIR);
	assert.equal(out.results[0].outcome, "merged");
	assert.equal(live(w, tree, "todo.md"), "one\n2\nTHREE\n4\nfive\n6\nSEVEN\n8\nnine\n10\n");
});

test("the shared host is one more host to a reader that has never heard of the shared tree (an older engine reads it read-only)", async () => {
	const { w, tree } = await shared();
	await w.commit("bam-GPU", [{ path: "notes/a.md", text: "hello\n" }, { path: "b.txt", text: "world\n" }], {}, GPU);
	const bucket = new S3Bucket(await mint(env(), ROOT, "object-read-only", 300, T0), w.s3.fetch);
	const project = new Project(bucket, "notes", ROOT);
	assert.deepEqual(await project.hosts(true), [tree]);
	const files = await project.files();
	assert.deepEqual(files.map((f) => [f.hostId, f.hostName, f.path]), [[tree, "shared", "b.txt"], [tree, "shared", "notes/a.md"]]);
	assert.equal(new TextDecoder().decode(await project.read(tree, "notes/a.md")), "hello\n");
	// an older engine's push never touches it: its keys are hosts/<its own id>/ only, so the shared host is read-only to it
	assert.ok(!files.some((f) => f.hostId === GPU));
});

test("only the owner commits; a cookie write needs the CSRF header; nothing private is written; a body that lies is refused", async () => {
	const { w, tree } = await shared();
	const body = { device: "x", changes: [{ path: "a.md", base: null, body: Buffer.from("hi\n").toString("base64") }] };
	// signed out, a reader and a stranger
	w.who(null);
	assert.equal((await w.call("POST", "/fs/v1/folders/notes/shared", body)).status, 401);
	w.who(READER);
	const readerAnswer = await w.call("POST", "/fs/v1/folders/notes/shared", body);
	assert.equal(readerAnswer.status, 409, "a person's folder is their own: the stranger's session finds no shared tree under their own name");
	assert.equal(live(w, tree, "a.md"), null);
	w.who(OWNER);
	// a cookie without the CSRF header, and with the wrong user
	const noCsrf = await w.call("POST", "/fs/v1/folders/notes/shared", body, { "X-Folder-Sync": "0" }, true);
	assert.equal(noCsrf.status, 403);
	const wrongUser = await w.call("POST", "/fs/v1/folders/notes/shared", body, { "X-Folder-Sync-User": READER.userId }, true);
	assert.equal(wrongUser.status, 409);
	assert.equal(live(w, tree, "a.md"), null, "nothing was written");
	assert.equal((await w.call("POST", "/fs/v1/folders/notes/shared", body, {}, true)).status, 200, "the same body with the page's headers goes through");
	// a body that does not hash to its sha256, a path that breaks the rules, a share with no tree yet
	const lying = await w.call("POST", "/fs/v1/folders/notes/shared", { device: "x", changes: [{ path: "b.md", base: null, sha256: sha("other"), body: Buffer.from("b\n").toString("base64") }] });
	assert.equal(lying.status, 400);
	assert.equal(((await lying.json()) as { error: string }).error, "bad_body");
	assert.equal((await w.call("POST", "/fs/v1/folders/notes/shared", { device: "x", changes: [{ path: "../x", base: null, body: "" }] })).status, 400);
	assert.equal((await w.call("POST", "/fs/v1/folders/notes/shared", { device: "x", changes: [{ path: "CON.md", base: null, body: "" }] })).status, 400, "a name Windows cannot hold");
	const nothing = await w.call("POST", "/fs/v1/folders/other/shared", body);
	assert.equal(nothing.status, 409);
	assert.equal(((await nothing.json()) as { error: string }).error, "not_shared");
});

test("a private path is refused (409), the machine keeps it on its own host", async () => {
	const w = world();
	const tree = (await w.share(["events/", "*.sqlite"])).host;
	const out = await w.call("POST", "/fs/v1/folders/notes/shared", { device: "x", changes: [{ path: "a.md", base: null, body: "aGkK" }, { path: "events/2026.jsonl", base: null, body: "aGkK" }] });
	assert.equal(out.status, 409);
	assert.equal(((await out.json()) as { error: string }).error, "private_path");
	assert.equal(live(w, tree, "a.md"), null, "nothing of the commit was written");
	assert.equal((await w.call("POST", "/fs/v1/folders/notes/shared", { device: "x", changes: [{ path: "db/data.sqlite", base: null, body: "aGkK" }] })).status, 409);
});

test("max_delete: a commit with more deletes than the device allows is refused whole", async () => {
	const { w } = await shared();
	const added = (await w.commit("a", ["1", "2", "3", "4"].map((n) => ({ path: `${n}.md`, text: `${n}\n` })), {}, GPU)).results;
	w.tick();
	const out = await w.commit("a", added.map((r, i) => ({ path: `${i + 1}.md`, delete: true, base: base(r) })), { max_delete: 3 }, GPU);
	assert.deepEqual([(out as { status?: number }).status, out.error], [409, "max_delete"]);
	const ok = await w.commit("a", added.slice(0, 3).map((r, i) => ({ path: `${i + 1}.md`, delete: true, base: base(r) })), { max_delete: 3 }, GPU);
	assert.deepEqual(ok.results.map((r) => r.outcome), ["accepted", "accepted", "accepted"]);
});

test("a file the machine staged in _incoming/ is committed, checked against its sha256, and the staged object goes", async () => {
	const { w, tree } = await shared();
	const big = Buffer.from("x".repeat(1_500_000));
	const id = crypto.randomUUID();
	const key = `${ROOT}_incoming/notes/${GPU}/${id}`;
	w.s3.put(key, big);
	const res = await w.call("POST", "/fs/v1/folders/notes/shared", { device: "bam-GPU", host: GPU, changes: [{ path: "big.txt", base: null, sha256: sha(big), size: big.byteLength, staged: id }] });
	assert.equal(res.status, 200);
	assert.equal(live(w, tree, "big.txt")!.length, 1_500_000);
	assert.equal(w.s3.objects.has(key), false, "the staged object is deleted");
	// inline bodies stop at 1 MiB
	const inline = await w.call("POST", "/fs/v1/folders/notes/shared", { device: "bam-GPU", changes: [{ path: "big2.txt", base: null, body: big.toString("base64") }] });
	assert.equal(inline.status, 413);
	// a wrong sha256 on a staged object, and a staged object that is not there
	const id2 = crypto.randomUUID();
	w.s3.put(`${ROOT}_incoming/notes/${GPU}/${id2}`, "other bytes");
	const wrong = await w.call("POST", "/fs/v1/folders/notes/shared", { device: "bam-GPU", host: GPU, changes: [{ path: "w.txt", base: null, sha256: sha("expected"), staged: id2 }] });
	assert.equal(wrong.status, 400);
	const missing = await w.call("POST", "/fs/v1/folders/notes/shared", { device: "bam-GPU", host: GPU, changes: [{ path: "m.txt", base: null, staged: crypto.randomUUID() }] });
	assert.equal(((await missing.json()) as { error: string }).error, "staged_missing");
});

test("a page's PUT and DELETE go through the same commit: a base, X-Folder-Sync-Merge: never, a delete needs its base", async () => {
	const { w, tree } = await shared();
	const put = (path: string, text: string, headers: Record<string, string> = {}) => w.call("PUT", `/fs/v1/folders/notes/shared/${path}`, text, headers, true);
	const created = await put("page.md", "first\n");
	assert.equal(created.status, 200);
	const v1 = (await created.json()) as Result & { seq: number };
	assert.equal(v1.outcome, "accepted");
	w.tick();
	const second = (await (await put("page.md", "second\n", { "X-Folder-Sync-Base": v1.version! })).json()) as Result;
	w.tick();
	// a page working from v1 after the file moved on: merges by default, a 412 when it asks for never
	const never = await put("page.md", "third\n", { "X-Folder-Sync-Base": v1.version!, "X-Folder-Sync-Merge": "never" });
	assert.equal(never.status, 412);
	assert.equal(live(w, tree, "page.md"), "second\n");
	const merged = (await (await put("page.md", "first\nadded\n", { "X-Folder-Sync-Base": v1.version! })).json()) as Result;
	assert.ok(["merged", "conflict"].includes(merged.outcome));
	// a delete without its base is refused; with it, it goes
	assert.equal((await w.call("DELETE", "/fs/v1/folders/notes/shared/page.md", undefined, {}, true)).status, 400);
	const cur = manifestOf(w, tree).files.find((f) => f.path === "page.md")!;
	void second;
	const gone = await w.call("DELETE", "/fs/v1/folders/notes/shared/page.md", undefined, { "X-Folder-Sync-Base": `${new Date(T0 + 2000).toISOString().replace(/\.\d+Z$/, ".000Z")}_${cur.sha256.slice(0, 16)}` }, true);
	assert.ok([200].includes(gone.status));
	// a page's write has no CSRF-less route
	assert.equal((await w.call("PUT", "/fs/v1/folders/notes/shared/x.md", "x", { "X-Folder-Sync": "0" }, true)).status, 403);
});

test("restore: a kept version of a shared file is written back as a new version by the folder's object", async () => {
	const { w, tree } = await shared();
	const v1 = (await w.commit("bam-GPU", [{ path: "r.md", text: "version one\n" }], {}, GPU)).results[0];
	w.tick(400_000);
	await w.commit("bam-GPU", [{ path: "r.md", text: "version two, a rewrite\n", base: base(v1) }], {}, GPU);
	const res = await w.call("POST", "/fs/v1/folders/notes/restore", { items: [{ host: tree, path: "r.md", version: v1.version }] }, {}, true);
	assert.equal(res.status, 200);
	const done = (await res.json()) as { applied: { path: string }[]; failed: unknown[] };
	assert.deepEqual([done.applied.length, done.failed.length], [1, 0]);
	assert.equal(live(w, tree, "r.md"), "version one\n");
	const events = (await recordOf(w, tree, manifestOf(w, tree).seq)).events;
	assert.equal(events[0].event, "restore");
	assert.equal(events[0].from, v1.version);
});

test("over quota: a commit that adds bytes is refused (403), a commit that only deletes still goes", async () => {
	const w = world();
	const tree = (await w.share()).host;
	const v1 = (await w.commit("a", [{ path: "q.md", text: "quota\n" }], {}, GPU)).results[0];
	w.tick();
	// the quota is the Worker's env: shrink it by recording a measurement at the ceiling
	w.store.usageRows.set(OWNER.userId, { bytes: 1e12, objects: 1, measured_at: new Date(w.clock.now - 1000).toISOString(), history: { bytes: 0, objects: 0 } });
	const add = await w.commit("a", [{ path: "q2.md", text: "more\n" }], {}, GPU);
	assert.deepEqual([(add as { status?: number }).status, add.error], [403, "over_quota"]);
	assert.equal(live(w, tree, "q2.md"), null);
	const del = await w.commit("a", [{ path: "q.md", delete: true, base: base(v1) }], {}, GPU);
	assert.equal(del.results[0].outcome, "accepted");
});

test("a commit cut off before the manifest is undone from the journal; a restarted object settles it before anything else runs", async () => {
	// one folder object whose storage outlives it, as a Durable Object's does
	const storage = memoryStorage();
	const w0 = world();
	let core: WebHostCore | null = null;
	const boot = () => {
		core = new WebHostCore(env(), w0.s3.fetch, storage, () => w0.clock.now, w0.store);
	};
	boot();
	const w = world({ webHost: (op) => core!.run(op, env()) });
	// share the same S3 and store as w0 by pointing w at w0's: simplest is to use w0 for deps and the hook for the object
	const hooked = world({ webHost: (op) => core!.run(op, env()) });
	void w;
	// rebuild core over hooked's s3/store
	core = new WebHostCore(env(), hooked.s3.fetch, storage, () => hooked.clock.now, hooked.store);
	const tree = (await hooked.share()).host;
	const v1 = (await hooked.commit("a", [{ path: "keep.md", text: "stays\n" }, { path: "edit.md", text: "old\n" }], {}, GPU)).results;
	hooked.tick();
	// the manifest write fails halfway: the storage answers 500 to the commit's manifest PUT
	hooked.s3.fail = (method, key) => method === "PUT" && key === `${ROOT}notes/hosts/${tree}/manifest.json`;
	// WHY a throw: an unexpected storage failure is the Worker's 500, as for a web write
	await assert.rejects(hooked.commit("a", [{ path: "edit.md", text: "new\n", base: base(v1[1]) }, { path: "added.md", text: "added\n" }, { path: "keep.md", delete: true, base: base(v1[0]) }], {}, GPU), /500 for a write/);
	hooked.s3.fail = null;
	// whatever the cut left, the files hold exactly what the manifest lists
	const settled = await hooked.call("GET", "/fs/v1/folders/notes", undefined, {}, true);
	assert.equal(settled.status, 200, "a read settles the journal first");
	const m = manifestOf(hooked, tree);
	for (const f of m.files) assert.equal(sha(hooked.s3.objects.get(`${ROOT}notes/hosts/${tree}/${f.path}`)!), f.sha256, `${f.path} holds its manifest's bytes`);
	assert.deepEqual(m.files.map((f) => f.path), ["edit.md", "keep.md"]);
	assert.equal(live(hooked, tree, "edit.md"), "old\n");
	assert.equal(live(hooked, tree, "added.md"), null, "the new file is gone");
	assert.equal(live(hooked, tree, "keep.md"), "stays\n", "the deleted file is back");
	assert.equal(await storage.get("pending"), undefined, "the journal is clear");
	// no history copy of a change that never happened is left behind
	assert.deepEqual([...hooked.s3.objects.keys()].filter((k) => k.includes("_history/")), []);
	// and the same commit now goes
	const again = await hooked.commit("a", [{ path: "edit.md", text: "new\n", base: base(v1[1]) }, { path: "added.md", text: "added\n" }], {}, GPU);
	assert.deepEqual(again.results.map((r) => r.outcome), ["accepted", "accepted"], JSON.stringify(again));
	// a restarted object: a second core over the same storage settles a pending left by a crash. The cut change had copied
	// added.md's bytes to a backup and overwritten the file, and died before the manifest
	const backup = `${ROOT}_history/notes/${tree}/added.md/2026-11-04T12:00:01.000Z_${sha("added\n").slice(0, 16)}`;
	hooked.s3.put(backup, "added\n");
	hooked.s3.put(`${ROOT}notes/hosts/${tree}/added.md`, "overwritten\n");
	await storage.put("pending", { where: { root: ROOT, project: "notes", hostId: tree, name: "shared" }, path: "added.md", restore: backup, restoreSha256: sha("added\n"), restoreSize: 6, sha256: sha("overwritten\n") });
	const restarted = new WebHostCore(env(), hooked.s3.fetch, storage, () => hooked.clock.now, hooked.store);
	await restarted.alarm();
	assert.equal(await storage.get("pending"), undefined);
	assert.equal(live(hooked, tree, "added.md"), "added\n", "the file holds its manifest's bytes again");
	assert.equal(hooked.s3.objects.has(backup), false, "and the backup of a change that never happened is gone");
});

test("the throttle's memory: a burst of commits to one file keeps one version per 5 minutes, but a merge keeps both inputs", async () => {
	const { w, tree } = await shared();
	let latest = (await w.commit("a", [{ path: "burst.md", text: "0\n" }], {}, GPU)).results[0];
	for (let i = 1; i <= 6; i++) {
		w.tick(10_000);
		latest = (await w.commit("a", [{ path: "burst.md", text: `${i}\n`, base: base(latest) }], {}, GPU)).results[0];
	}
	assert.equal(historyOf(w, tree, "burst.md").length, 1, `six saves in a minute keep one version: ${historyOf(w, tree, "burst.md")}`);
});

test("the change record names who committed (by_host, by_name) and validates as a folder-sync-changes/1 record", async () => {
	const { w, tree } = await shared();
	await w.commit("bam-GPU", [{ path: "a.md", text: "x\n" }], {}, GPU);
	const record = await recordOf(w, tree, 2);
	assert.equal(record.by, "shared");
	assert.equal(record.host_name, "shared");
	assert.deepEqual([record.events[0].by_host, record.events[0].by_name, record.events[0].op], [GPU, "bam-GPU", "add"]);
});

test("the folder's prune removes a staged upload a crash left, after a day, and nothing fresher", async () => {
	const { w } = await shared();
	w.s3.put(`${ROOT}_incoming/notes/${GPU}/${crypto.randomUUID()}`, "old", w.clock.now - 25 * 3600_000);
	const fresh = `${ROOT}_incoming/notes/${GPU}/${crypto.randomUUID()}`;
	w.s3.put(fresh, "fresh", w.clock.now - 3600_000);
	const bucket = new S3Bucket(await mint(env(), ROOT, "object-read-write", 300, w.clock.now), w.s3.fetch);
	const pruned = await pruneFolder(bucket, ROOT, "notes", w.clock.now);
	assert.equal(pruned.deleted, 1);
	assert.deepEqual([...w.s3.objects.keys()].filter((k) => k.includes("_incoming/")), [fresh]);
});

test("the records the Worker writes have exactly the shapes of testdata/shared/record-*.json (which the schema test validates)", async () => {
	const { w, tree } = await shared();
	const fixtures = readdirSync(new URL("../../testdata/shared/", import.meta.url)).filter((f) => f.startsWith("record-")).flatMap((f) => (JSON.parse(readFileSync(new URL(`../../testdata/shared/${f}`, import.meta.url), "utf8")) as { events: Record<string, unknown>[] }).events);
	const keys = (event: string, op?: string) => new Set(fixtures.filter((e) => e.event === event && (op === undefined || e.op === op)).flatMap((e) => Object.keys(e)));
	const v1 = (await w.commit("bam-GPU", [{ path: "notes/todo.md", text: "1\n2\n3\n4\n5\n" }], {}, GPU)).results[0];
	w.tick();
	await w.commit("bam-GPU", [{ path: "notes/todo.md", text: "ONE\n2\n3\n4\n5\n", base: base(v1) }], {}, GPU);
	w.tick();
	await w.commit("bam-Air", [{ path: "notes/todo.md", text: "1\n2\n3\n4\nFIVE\n", base: base(v1) }, { path: "gone.md", delete: true, base: { version: "2026-11-04T08:00:00.000Z_0123456789abcdef" } }], {}, AIR);
	const real = (await recordOf(w, tree, 4)).events.find((e) => e.event === "upload" && e.merge)!;
	for (const key of Object.keys(real)) assert.ok(keys("upload", "edit").has(key), `the fixture's merged upload has ${key}`);
	for (const key of keys("upload", "edit")) if (!["up_ms"].includes(key)) assert.ok(key in real, `the real merged upload has ${key}`);
	const conflictWorld = await shared();
	const cw = conflictWorld.w;
	const c1 = (await cw.commit("bam-GPU", [{ path: "p.md", text: "a\n" }], {}, GPU)).results[0];
	cw.tick();
	await cw.commit("bam-GPU", [{ path: "p.md", text: "b\n", base: base(c1) }], {}, GPU);
	cw.tick();
	await cw.commit("bam-Air", [{ path: "p.md", text: "c\n", base: base(c1) }], {}, AIR);
	const conflict = (await recordOf(cw, conflictWorld.tree, 4)).events.find((e) => e.event === "conflict")!;
	for (const key of Object.keys(conflict)) assert.ok(keys("conflict").has(key), `the fixture's conflict has ${key}`);
	for (const key of keys("conflict")) assert.ok(key in conflict, `the real conflict has ${key}`);
});

test("the store's SQL for the shared tree runs on SQLite, D1's engine: one id per folder, the first one sticks", async () => {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(":memory:");
	const dir = new URL("../migrations/", import.meta.url);
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
	db.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)').run(OWNER.userId, "Owner", OWNER.email, "2026-11-04", "2026-11-04");
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
	const store = d1Store(d1);
	assert.equal(await store.sharedTree(OWNER.userId, "notes"), null);
	assert.equal(await store.ensureSharedTree(OWNER.userId, "notes", GPU, "2026-11-04T12:00:00Z"), GPU);
	assert.equal(await store.ensureSharedTree(OWNER.userId, "notes", AIR, "2026-11-04T12:00:01Z"), GPU, "a second share finds the first");
	assert.equal(await store.sharedTree(OWNER.userId, "other"), null);
	assert.equal(await store.sharedTree(READER.userId, "notes"), null);
});

test("a key with parentheses is sent escaped, as SigV4 signs it (a store that checks the path as sent refused the conflict copy's name)", async () => {
	const { w } = await shared();
	const urls: string[] = [];
	const inner = w.s3.fetch;
	(w.s3 as { fetch: typeof inner }).fetch = async (request: Request) => { urls.push(request.url); return inner(request); };
	// the world's deps hold the original fetch; go straight to a bucket over the recording one
	const bucket = new S3Bucket(await mint(env(), ROOT, "object-read-write", 300, T0), (r) => { urls.push(r.url); return inner(r); });
	await bucket.put(`${ROOT}notes/hosts/x/plan (Conflicted copy bam-Air 202611041300).md`, enc.encode("x"));
	const sent = urls.find((u) => u.includes("Conflicted"))!;
	assert.match(sent, /plan%20%28Conflicted%20copy%20bam-Air%20202611041300%29\.md$/);
	assert.doesNotMatch(sent, /[()]/);
	// and a listing's prefix: a space is %20 on the wire, not "+"
	urls.length = 0;
	await bucket.objects(`${ROOT}_history/notes/x/plan (Conflicted copy bam-Air 202611041300).md/`, { delimiter: "/" });
	const listed = urls.find((u) => u.includes("list-type"))!;
	assert.match(listed, /prefix=[^&]*plan%20%28Conflicted%20copy%20bam-Air/);
	assert.doesNotMatch(listed, /\+/);
});
