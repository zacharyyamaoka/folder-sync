// scripts/first-sync-timer's own tests: that it runs the install command the README tells a person to run, how a step list
// becomes pass/fail against the 2-minute gate, and the shape of the file scripts/gates collects. The run itself (the local
// stack, a clean HOME) is the proof: `scripts/first-sync-timer`. Run: node --test scripts/first-sync-timer.test.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const timer = require("./first-sync-timer");
const repo = path.resolve(import.meta.dirname, "..");

test("the install step is the README's install command, for this checkout", () => {
	const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8");
	// WHY the Quick start's step 1: the Nov 4 README rewrite moved the install command there, in an indented fence.
	const start = readme.indexOf("## Quick start");
	assert.ok(start >= 0, "README has a Quick start");
	const step1 = readme.slice(start, readme.indexOf("2. **", start));
	const fence = /```bash\n\s*([^\n]+)\n\s*```/.exec(step1)?.[1];
	assert.match(fence ?? "", /^go build -o ~\/\.folder-sync\/bin\/folder-sync \.\/cmd\/folder-sync$/);
	const [go, build, flag, out, pkg] = timer.installArgv("/h", "go", "linux");
	assert.deepEqual([go, build, flag, pkg], ["go", "build", "-o", "./cmd/folder-sync"]);
	assert.equal(out, path.join("/h", ".folder-sync", "bin", "folder-sync"), "~ is the clean HOME, nowhere else");
	assert.equal(path.basename(timer.installArgv("C:\\h", "go", "win32")[3]), "folder-sync.exe");
});

const step = (name, seconds, ok = true, detail = "") => ({ name, seconds, ok, detail });
test("verdict: the sum of the steps against the limit, and a failed step fails whatever the clock says", () => {
	const quick = [step("install", 30), step("sign_in", 3), step("add_folder", 2), step("first_sync", 5)];
	assert.deepEqual(timer.verdict(quick, 120), { ok: true, seconds: 40, why: "" });
	const edge = [step("install", 119.5), step("first_sync", 0.5)];
	assert.equal(timer.verdict(edge, 120).ok, true, "exactly 120 s is within the gate");
	const slow = [step("install", 100), step("first_sync", 20.5)];
	assert.equal(timer.verdict(slow, 120).ok, false);
	assert.match(timer.verdict(slow, 120).why, /120\.5 s is over the 120 s gate/);
	const broken = [step("install", 1), step("sign_in", 1, false, "no code")];
	assert.equal(timer.verdict(broken, 120).ok, false);
	assert.match(timer.verdict(broken, 120).why, /sign_in failed: no code/);
});

test("the document scripts/gates collects: os in Go's spelling, seconds, the limit and every step", () => {
	assert.equal(timer.osName("win32"), "windows");
	assert.equal(timer.osName("darwin"), "darwin");
	assert.equal(timer.osName("linux"), "linux");
	const doc = timer.document([step("install", 1.23456), step("first_sync", 2)], 120);
	assert.equal(doc.schema, "folder-sync-first-sync/1");
	assert.equal(doc.seconds, 3.235);
	assert.equal(doc.limit_seconds, 120);
	assert.equal(doc.ok, true);
	assert.deepEqual(doc.steps.map((s) => s.name), ["install", "first_sync"]);
	assert.ok(["linux", "darwin", "windows"].includes(doc.os));
});
