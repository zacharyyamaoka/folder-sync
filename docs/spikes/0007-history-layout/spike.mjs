#!/usr/bin/env node
// PEP 0007 spike: can the proposed history layout live in the bucket as plain objects, using only stock S3 calls,
// on the e2e stand-in (`rclone serve s3`)? A feasibility check, not the implementation.
//
//   node docs/spikes/0007-history-layout/spike.mjs <path to the pinned rclone> <scratch dir>
//
// It starts its own `rclone serve s3` on a free loopback port (throwaway keys, data under <scratch dir>), runs the
// steps below with the repo's vendored aws4fetch, prints one line per check, and stops the server it started (by pid).
//
// The layout under test (PEP 0007 §A):
//   <root><project>/hosts/<host>/<path>                                  live file (unchanged)
//   <root>_history/<project>/<host>/<path>/<written_at>_<sha256:16>      one object per kept version, plain bytes
//   <root>_changes/<project>/<host>/<seq:012>.json                       one change record per manifest seq
// WHY a colon in the version name: no published path can hold one (names.CheckWindows, webhost.checkWebPath), so a
// version object can never be mistaken for a file inside a folder of the same name.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { AwsClient } from "../../../accounts/src/vendor/aws4fetch.js";

const [rclone, scratch] = process.argv.slice(2);
if (!rclone || !scratch) {
	console.error("usage: spike.mjs <rclone> <scratch dir>");
	process.exit(2);
}

const KEY_ID = "spikekey", SECRET = "spikesecret0123456789", BUCKET = "folder-sync";
const ROOT = "users/u1/", PROJECT = "notes", HOST = "b55e9683-7854-4121-a56a-9bae7c3ab1da";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const enc = (key) => key.split("/").map(encodeURIComponent).join("/");

function freePort() {
	return new Promise((resolve) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
function note(name, detail) {
	console.log(`NOTE  ${name}  (${detail})`);
}

const port = await freePort();
const data = join(scratch, "s3");
mkdirSync(data, { recursive: true });
const server = spawn(rclone, ["serve", "s3", "--addr", `127.0.0.1:${port}`, "--auth-key", `${KEY_ID},${SECRET}`,
	"--config", "/dev/null", "--cache-dir", join(scratch, "cache"), data], { stdio: ["ignore", "ignore", "pipe"] });
let serverLog = "";
server.stderr.on("data", (chunk) => { serverLog += chunk; });
const base = `http://127.0.0.1:${port}`;
const aws = new AwsClient({ accessKeyId: KEY_ID, secretAccessKey: SECRET, service: "s3", region: "auto" });
const s3 = (method, key, init = {}) => aws.fetch(`${base}/${BUCKET}${key ? "/" + enc(key) : ""}`, { method, ...init });

async function waitUp() {
	for (let i = 0; i < 100; i++) {
		try {
			await fetch(base);
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	throw new Error(`rclone serve s3 did not start: ${serverLog}`);
}

async function list(prefix, delimiter = "/") {
	const q = new URLSearchParams({ "list-type": "2", prefix, delimiter });
	const res = await aws.fetch(`${base}/${BUCKET}?${q}`);
	const xml = await res.text();
	const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1]);
	// WHY \s*: the stand-in indents its XML; R2 does not
	const prefixes = [...xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]*)<\/Prefix>\s*<\/CommonPrefixes>/g)].map((m) => m[1]);
	return { status: res.status, keys, prefixes };
}

const timings = {};
async function timed(label, fn) {
	const t0 = performance.now();
	const out = await fn();
	timings[label] = (timings[label] || []).concat(performance.now() - t0);
	return out;
}

try {
	await waitUp();
	check("stand-in up", (await s3("PUT", "")).ok, `rclone serve s3 on 127.0.0.1:${port}, pid ${server.pid}`);

	const live = `${ROOT}${PROJECT}/hosts/${HOST}/notes/plan.md`;
	const v1 = "# Plan\n\n- one\n", v2 = "# Plan\n\n- one\n- two\n";
	// the host's manifest, as every round writes it: it keeps the project visible after its last file is deleted
	await s3("PUT", `${ROOT}${PROJECT}/hosts/${HOST}/manifest.json`, { body: "{}" });
	const put1 = await timed("PUT", () => s3("PUT", live, { body: v1 }));
	const etag1 = put1.headers.get("etag");
	check("PUT v1 of notes/plan.md", put1.ok, `ETag ${etag1}`);

	// a version is copied into history before it is overwritten: CopyObject, conditional on the manifest's object_etag
	const writtenAt = "2026-10-28T20:41:00.117Z";
	const versionKey = `${ROOT}_history/${PROJECT}/${HOST}/notes/plan.md/${writtenAt}_${sha(v1).slice(0, 16)}`;
	const copy = await timed("CopyObject", () => s3("PUT", versionKey, {
		headers: { "x-amz-copy-source": `/${BUCKET}/${enc(live)}`, "x-amz-copy-source-if-match": etag1 },
	}));
	check("CopyObject live → history (copy-source-if-match on the right ETag)", copy.ok, `HTTP ${copy.status}`);

	const wrong = await s3("PUT", `${versionKey}.wrong`, {
		headers: { "x-amz-copy-source": `/${BUCKET}/${enc(live)}`, "x-amz-copy-source-if-match": '"00000000000000000000000000000000"' },
	});
	if (wrong.status === 412) check("CopyObject with a stale copy-source-if-match is refused (412)", true);
	else note("stand-in ignores x-amz-copy-source-if-match", `HTTP ${wrong.status}; R2 documents the header as supported: test it in scripts/check-r2, never on the stand-in`);
	await s3("DELETE", `${versionKey}.wrong`);

	const put2 = await timed("PUT", () => s3("PUT", live, { body: v2 }));
	check("PUT v2 over the live key", put2.ok);

	// a file named `notes` that once existed: its versions sit beside the folder `notes/`'s files' version folders
	const notesFileVersion = `${ROOT}_history/${PROJECT}/${HOST}/notes/2026-10-27T10:00:00.000Z_${sha("old notes file").slice(0, 16)}`;
	check("PUT a version of a file named `notes` (file and folder share a name over time)",
		(await s3("PUT", notesFileVersion, { body: "old notes file" })).ok);

	const one = await timed("LIST", () => list(`${ROOT}_history/${PROJECT}/${HOST}/notes/plan.md/`));
	check("one LIST gives every version of notes/plan.md", one.keys.length === 1 && one.keys[0] === versionKey && one.prefixes.length === 0,
		`${one.keys.length} key(s): ${one.keys.map((k) => k.split("/").pop()).join(", ")}`);

	const folder = await list(`${ROOT}_history/${PROJECT}/${HOST}/notes/`);
	const folderOk = folder.keys.length === 1 && folder.keys[0] === notesFileVersion && folder.prefixes.length === 1
		&& folder.prefixes[0] === `${ROOT}_history/${PROJECT}/${HOST}/notes/plan.md/`;
	check("a delimiter LIST tells versions (objects) from files below (prefixes)", folderOk,
		`objects: ${folder.keys.map((k) => k.split("/").pop()).join(", ")}; prefixes: ${folder.prefixes.map((p) => p.split("/").slice(-2, -1)[0]).join(", ")}`);

	const back = await timed("GET", () => s3("GET", versionKey));
	const backText = await back.text();
	check("GET the version back: the very bytes of v1", back.ok && backText === v1 && sha(backText) === sha(v1));

	// a delete is a copy into history then a DeleteObject (R2: DeleteObject is free)
	const delVersion = `${ROOT}_history/${PROJECT}/${HOST}/notes/plan.md/2026-10-28T20:45:12.004Z_${sha(v2).slice(0, 16)}`;
	const copy2 = await s3("PUT", delVersion, { headers: { "x-amz-copy-source": `/${BUCKET}/${enc(live)}` } });
	const del = await timed("DELETE", () => s3("DELETE", live));
	check("delete = CopyObject into history, then DeleteObject", copy2.ok && (del.status === 204 || del.ok));
	const gone = await s3("GET", live);
	const after = await list(`${ROOT}_history/${PROJECT}/${HOST}/notes/plan.md/`);
	check("the live key is gone, both versions remain, sorted oldest first", gone.status === 404 && after.keys.length === 2 && after.keys[0] === versionKey,
		after.keys.map((k) => k.split("/").pop()).join(", "));

	// the change record: one small immutable object per manifest seq, read back by key (no LIST)
	const record = {
		schema: "folder-sync-changes/1", project: PROJECT, host_id: HOST, host_name: "bam-GPU", seq: 3, at: "2026-10-28T20:45:12.010Z", by: "machine",
		events: [{ schema: "folder-sync-event/1", event: "delete", at: "2026-10-28T20:45:12.004Z", path: "notes/plan.md",
			was: { sha256: sha(v2), size: v2.length, written_at: "2026-10-28T20:45:00.002Z", kept: delVersion } }],
	};
	const recordKey = `${ROOT}_changes/${PROJECT}/${HOST}/${String(record.seq).padStart(12, "0")}.json`;
	const rput = await timed("PUT", () => s3("PUT", recordKey, { body: JSON.stringify(record), headers: { "content-type": "application/json" } }));
	const rget = await s3("GET", recordKey);
	const rback = rget.ok ? await rget.json() : null;
	check("PUT and GET a change record by key", rput.ok && rback && rback.events[0].was.kept === delVersion, recordKey.split("/").pop());

	const projects = await list(ROOT);
	check("projects --json's root listing still sees only the project (history and changes start with _)",
		projects.prefixes.filter((p) => !p.slice(ROOT.length).startsWith("_")).map((p) => p.slice(ROOT.length, -1)).join(",") === PROJECT,
		projects.prefixes.map((p) => p.slice(ROOT.length)).join(" "));

	const ms = Object.entries(timings).map(([k, v]) => `${k} ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)} ms`).join(", ");
	note("stand-in timings (loopback, mean)", ms);
} catch (err) {
	check("spike ran", false, String(err && err.stack ? err.stack : err));
} finally {
	server.kill("SIGTERM");
	await new Promise((r) => server.once("exit", r));
	console.log(`stopped rclone serve s3 (pid ${server.pid})`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `${failed} check(s) failed` : `all ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
