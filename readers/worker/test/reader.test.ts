// Unit tests for the Worker reader (run: node --test readers/worker/test/reader.test.ts).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { checkRoot, ContractError, Project, SCHEMA, validateManifest } from "../src/folder-sync-read.ts";
import { MemoryBucket } from "./memory-bucket.ts";

const HOST_A = "b55e9683-7854-4121-a56a-9bae7c3ab1da";
const HOST_B = "26ec27de-c7e5-45fb-ad10-50b750c5b132";

function manifest(hostId: string, files: Record<string, string>, seq = 1) {
	return {
		schema: SCHEMA,
		project: "demo",
		host_id: hostId,
		host_name: "box-" + hostId.slice(0, 4),
		seq,
		generated_at: "2026-10-20T22:00:00Z",
		files: Object.entries(files).map(([path, text]) => ({
			path,
			size: Buffer.byteLength(text),
			mtime: "2026-10-20T21:00:00Z",
			sha256: createHash("sha256").update(text).digest("hex"),
			written_at: "2026-10-20T22:00:00Z",
		})),
	};
}

function setup() {
	const bucket = new MemoryBucket();
	bucket.put(`demo/hosts/${HOST_A}/manifest.json`, JSON.stringify(manifest(HOST_A, { "notes/a.md": "hello" })));
	bucket.put(`demo/hosts/${HOST_A}/notes/a.md`, "hello");
	bucket.put(`demo/hosts/${HOST_B}/manifest.json`, JSON.stringify(manifest(HOST_B, {})));
	bucket.put("demo/hosts/not-a-host/x", "ignored");
	bucket.put(`_trash/demo/${HOST_A}/20261020T000000Z/old.md`, "old");
	return { bucket, project: new Project(bucket, "demo") };
}

test("lists every host's files from manifests and one delimiter listing", async () => {
	const { bucket, project } = setup();
	const files = await project.files();
	assert.deepEqual(
		files.map((f) => [f.hostId, f.path, f.size, f.key]),
		[[HOST_A, "notes/a.md", 5, `demo/hosts/${HOST_A}/notes/a.md`]],
	);
	assert.deepEqual(await project.hosts(), [HOST_A, HOST_B].sort());
	assert.deepEqual(bucket.calls.filter((c) => c.startsWith("LIST")), ["LIST demo/hosts/"]);
});

test("a second listing only sends conditional GETs", async () => {
	const { bucket, project } = setup();
	await project.files();
	bucket.calls.length = 0;
	await project.files();
	assert.ok(bucket.calls.length > 0 && bucket.calls.every((c) => c.endsWith("(conditional)")), bucket.calls.join("\n"));
});

test("read verifies sha256 and retries once with the new manifest", async () => {
	const { bucket, project } = setup();
	assert.equal(new TextDecoder().decode(await project.read(HOST_A, "notes/a.md")), "hello");
	bucket.put(`demo/hosts/${HOST_A}/notes/a.md`, "hello v2");
	bucket.put(`demo/hosts/${HOST_A}/manifest.json`, JSON.stringify(manifest(HOST_A, { "notes/a.md": "hello v2" }, 2)));
	assert.equal(new TextDecoder().decode(await project.read(HOST_A, "notes/a.md")), "hello v2");
});

test("a file missing from the manifest is deleted", async () => {
	const { bucket, project } = setup();
	bucket.put(`demo/hosts/${HOST_A}/manifest.json`, JSON.stringify(manifest(HOST_A, {}, 2)));
	await assert.rejects(project.read(HOST_A, "notes/a.md"), ContractError);
});

test("rejects other schemas, other hosts and unsafe paths", () => {
	const other = { ...manifest(HOST_A, {}), schema: "folder-sync-manifest/2" };
	assert.throws(() => validateManifest(other, "demo", HOST_A), ContractError);
	assert.throws(() => validateManifest(manifest(HOST_B, {}), "demo", HOST_A), ContractError);
	for (const path of ["../etc/passwd", "/abs", "a/../b", "a\\b", "C:/x", "a//b"]) {
		assert.throws(() => validateManifest(manifest(HOST_A, { [path]: "x" }), "demo", HOST_A), ContractError, path);
	}
});

test("an account root prefixes every key and leaves v0 unchanged", async () => {
	const root = "users/AbC123/";
	const bucket = new MemoryBucket();
	bucket.put(`${root}demo/hosts/${HOST_A}/manifest.json`, JSON.stringify(manifest(HOST_A, { "notes/a.md": "hello" })));
	bucket.put(`${root}demo/hosts/${HOST_A}/notes/a.md`, "hello");
	// Another person's project and a v0 project in the same bucket must stay invisible.
	bucket.put(`users/Other1/demo/hosts/${HOST_B}/manifest.json`, JSON.stringify(manifest(HOST_B, {})));
	bucket.put(`demo/hosts/${HOST_B}/manifest.json`, JSON.stringify(manifest(HOST_B, {})));
	const project = new Project(bucket, "demo", root);
	const files = await project.files();
	assert.deepEqual(
		files.map((f) => [f.hostId, f.path, f.key]),
		[[HOST_A, "notes/a.md", `${root}demo/hosts/${HOST_A}/notes/a.md`]],
	);
	assert.equal(new TextDecoder().decode(await project.read(HOST_A, "notes/a.md")), "hello");
	assert.deepEqual(await project.hosts(), [HOST_A]);
	assert.deepEqual(bucket.calls.filter((c) => c.startsWith("LIST")), [`LIST ${root}demo/hosts/`]);
	// Without a root the same bucket reads as v0 does: the root-less project sees only its own host.
	assert.deepEqual(await new Project(bucket, "demo").hosts(), [HOST_B]);
});

test("rejects a bad account root", () => {
	for (const root of ["users/x", "/users/x/", "users//x/", "users/../x/", "../", "a/b/c/d/e/f/g/h/i/"]) {
		assert.throws(() => checkRoot(root), ContractError, root);
		assert.throws(() => new Project(new MemoryBucket(), "demo", root), ContractError, root);
	}
	for (const root of ["", "users/AbC123/", "a/", "a/b/c/d/e/f/g/h/"]) assert.doesNotThrow(() => checkRoot(root), root);
});
