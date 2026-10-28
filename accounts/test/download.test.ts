// The desktop download page (node --test accounts/test/download.test.ts; bare Node, no network, no ports).
//
// What must hold (PEP 0006, src/download.ts):
// - /fs/download needs no session and lists exactly what latest.json names, the visitor's OS first, with each file's
//   size and SHA-256 and the unsigned-app first-run steps; with nothing published it says so;
// - /fs/download/<tag>/<file> streams that object as an attachment; anything outside downloads/desktop/<tag>/ is 404;
// - a latest.json that breaks the schema (a key outside its tag, a bad checksum) is treated as nothing published.
// The mutation at the bottom proves the key check goes red when it is removed.

import assert from "node:assert/strict";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { handle, type Env } from "../src/app.ts";
import type { DownloadsBucket } from "../src/download.ts";

const SITE = "https://robotparts.dev";
const TAG = "desktop-v0.1.0-rc1";
const SHA = "a".repeat(64);
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

function file(name: string, os: string, kind: string, label: string, size: number) {
	return { name, os, arch: "x", kind, label, size, sha256: SHA, key: `downloads/desktop/${TAG}/${name}` };
}

function manifest(files = [
	file("folder-sync-0.1.0-rc1-macos-universal.dmg", "macos", "dmg", "Mac (Apple silicon and Intel)", 9_000_000),
	file("folder-sync-0.1.0-rc1-windows-x64-setup.exe", "windows", "exe", "Windows installer", 7_000_000),
	file("folder-sync-0.1.0-rc1-linux-x86_64.AppImage", "linux", "AppImage", "Linux AppImage", 80_000_000),
]) {
	return { schema: "folder-sync-downloads/1", tag: TAG, version: "0.1.0-rc1", commit: "abc", published: "2026-10-28T20:00:00Z", files };
}

/** A Map-backed stand-in for the R2 binding's get/head. */
function bucket(objects: Record<string, string>): DownloadsBucket & { reads: string[] } {
	const reads: string[] = [];
	const object = (key: string) => {
		const value = objects[key];
		if (value === undefined) return null;
		const bytes = new TextEncoder().encode(value);
		return { size: bytes.length, httpEtag: '"e1"', body: new Blob([bytes]).stream(), text: async () => value };
	};
	return {
		reads,
		async get(key) { reads.push(key); return object(key); },
		async head(key) { reads.push(key); return object(key); },
	};
}

function env(downloads?: DownloadsBucket): Env {
	return { ENVIRONMENT: "production", PUBLIC_URL: "https://accounts.example.test", DOWNLOADS: downloads };
}

const published = () => bucket({
	"downloads/desktop/latest.json": JSON.stringify(manifest()),
	[`downloads/desktop/${TAG}/folder-sync-0.1.0-rc1-macos-universal.dmg`]: "DMG-BYTES",
	[`downloads/desktop/${TAG}/SHA256SUMS`]: `${SHA}  folder-sync-0.1.0-rc1-macos-universal.dmg\n`,
	"users/someone/private.txt": "never served",
});

async function get(path: string, downloads?: DownloadsBucket, agent?: string, method = "GET"): Promise<Response> {
	return handle(new Request(SITE + path, { method, headers: agent ? { "User-Agent": agent } : {} }), env(downloads), null);
}

test("download page: no session needed; lists every installer with size and SHA-256, the visitor's OS first and open", async () => {
	const answer = await get("/fs/download", published(), MAC);
	assert.equal(answer.status, 200);
	assert.match(answer.headers.get("Content-Type")!, /text\/html/);
	assert.match(answer.headers.get("Content-Security-Policy")!, /script-src 'self'/);
	const html = await answer.text();
	assert.doesNotMatch(html, /<script/);
	assert.match(html, /data-testid="fs-download-version">0\.1\.0-rc1</);
	for (const name of ["macos-universal.dmg", "windows-x64-setup.exe", "linux-x86_64.AppImage"]) assert.match(html, new RegExp(`href="/fs/download/${TAG}/folder-sync-0\\.1\\.0-rc1-${name.replace(".", "\\.")}"`));
	assert.ok(html.includes(SHA));
	assert.match(html, /9\.0 MB/);
	assert.ok(html.indexOf('data-os="macos"') < html.indexOf('data-os="windows"'), "the Mac section leads for a Mac");
	assert.match(html, /<h2 data-os="macos">Mac <span class="fs-tag">This computer<\/span>/);
	assert.match(html, /Open Anyway/);
	assert.match(html, /<details class="fs-steps" open><summary>First run on Mac/);
	assert.match(html, /More info → Run anyway/);
	const win = await (await get("/fs/download", published(), WIN)).text();
	assert.ok(win.indexOf('data-os="windows"') < win.indexOf('data-os="macos"'), "the Windows section leads for Windows");
	assert.match(win, /class="fs-button fs-primary" href="\/fs\/download\/desktop-v0\.1\.0-rc1\/folder-sync-0\.1\.0-rc1-windows-x64-setup\.exe"/);
	assert.equal((await get("/fs/download/", published(), WIN)).status, 200, "a trailing slash is the same page");
});

test("download page: nothing published (no binding, no latest.json) says so, never an error", async () => {
	for (const downloads of [undefined, bucket({})]) {
		const answer = await get("/fs/download", downloads);
		assert.equal(answer.status, 200);
		assert.match(await answer.text(), /data-testid="fs-download-none">No desktop release is published yet/);
	}
	assert.equal((await get("/fs/download/latest.json", bucket({}))).status, 404);
});

test("download files: streamed as an attachment, immutable; SHA256SUMS as text; HEAD has no body", async () => {
	const answer = await get(`/fs/download/${TAG}/folder-sync-0.1.0-rc1-macos-universal.dmg`, published());
	assert.equal(answer.status, 200);
	assert.equal(await answer.text(), "DMG-BYTES");
	assert.equal(answer.headers.get("Content-Disposition"), 'attachment; filename="folder-sync-0.1.0-rc1-macos-universal.dmg"');
	assert.equal(answer.headers.get("Content-Type"), "application/octet-stream");
	assert.equal(answer.headers.get("Content-Length"), "9");
	assert.match(answer.headers.get("Cache-Control")!, /immutable/);
	const sums = await get(`/fs/download/${TAG}/SHA256SUMS`, published());
	assert.match(sums.headers.get("Content-Type")!, /text\/plain/);
	assert.equal(sums.headers.get("Content-Disposition"), null);
	const head = await get(`/fs/download/${TAG}/folder-sync-0.1.0-rc1-macos-universal.dmg`, published(), undefined, "HEAD");
	assert.equal(head.status, 200);
	assert.equal(await head.text(), "");
	assert.equal((await get("/fs/download/latest.json", published())).status, 200);
	assert.equal((await get(`/fs/download/${TAG}/x.dmg`, published(), undefined, "POST")).status, 405);
});

test("download files: nothing outside downloads/desktop/<tag>/ is reachable", async () => {
	const downloads = published();
	for (const path of [
		"/fs/download/users/someone/private.txt",
		"/fs/download/users/private.txt",
		`/fs/download/${TAG}/..%2Fsecret`,
		`/fs/download/${TAG}/a/b`,
		"/fs/download/not-a-tag/file.dmg",
		`/fs/download/${TAG}/.hidden`,
		`/fs/download/${TAG}/missing.dmg`,
	]) {
		const answer = await get(path, downloads);
		assert.ok(answer.status === 404 || answer.status === 400, `${path}: ${answer.status}`);
	}
	assert.ok(downloads.reads.every((key) => key.startsWith("downloads/desktop/")), downloads.reads.join(", "));
});

test("download page: a latest.json that breaks the schema is nothing published", async () => {
	const outside = manifest([{ ...file("x.dmg", "macos", "dmg", "Mac", 1), key: "users/someone/x.dmg" }]);
	const badSha = manifest([{ ...file("x.dmg", "macos", "dmg", "Mac", 1), sha256: "nope" }]);
	for (const value of [JSON.stringify(outside), JSON.stringify(badSha), "{not json", JSON.stringify({ ...manifest(), schema: "other/1" })]) {
		const html = await (await get("/fs/download", bucket({ "downloads/desktop/latest.json": value }))).text();
		assert.match(html, /No desktop release is published yet/, value.slice(0, 60));
	}
});

test("mutation: without the per-file key check, a manifest naming a key outside its tag is listed (the test above goes red)", async () => {
	const source = fileURLToPath(new URL("../src/download.ts", import.meta.url));
	const text = readFileSync(source, "utf8");
	const guard = " && f.key === `downloads/desktop/${m.tag}/${f.name}`";
	assert.ok(text.includes(guard), "the key check is where this test expects it");
	const mutant = source.replace(/download\.ts$/, `download.mutant-${process.pid}.ts`);
	writeFileSync(mutant, text.replace(guard, ""));
	try {
		const { latest } = await import(pathToFileURL(mutant).href);
		const outside = manifest([{ ...file("x.dmg", "macos", "dmg", "Mac", 1), key: "users/someone/x.dmg" }]);
		assert.notEqual(await latest(bucket({ "downloads/desktop/latest.json": JSON.stringify(outside) })), null);
	} finally {
		unlinkSync(mutant);
	}
});
