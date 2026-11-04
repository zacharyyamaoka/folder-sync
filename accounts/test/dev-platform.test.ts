// accounts/scripts/dev.mjs on Windows and macOS: the parts of "start the local stack" that depend on the OS, as plain functions
// so Linux can test them. The first CI run reached none of this on Windows (go test failed first), so each case below is a way
// the stack would have failed to start or to stop there: a binary built without .exe, rclone's config at /dev/null (Git Bash
// turns that into the reserved device name "nul"), a process group that Windows does not have, and `sleep`, which it does not ship.

import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error plain JavaScript module
import { defaultRclone, exeName, sleepMs, standinBinary, stopPlan, storeArgv } from "../scripts/dev.mjs";

test("a built or fetched program has .exe on Windows only", () => {
	assert.equal(exeName("r2standin", "win32"), "r2standin.exe");
	assert.equal(exeName("r2standin", "linux"), "r2standin");
	assert.equal(exeName("r2standin", "darwin"), "r2standin");
	assert.equal(exeName("rclone.exe", "win32"), "rclone.exe", "never a double suffix");
});

test("the R2 stand-in is built into the state dir with the platform's suffix", () => {
	assert.match(standinBinary("/s/state", "win32"), /r2standin\.exe$/);
	assert.match(standinBinary("/s/state", "linux"), /r2standin$/);
});

test("the default rclone is the one scripts/dev-tools fetches: rclone.exe on Windows", () => {
	assert.match(defaultRclone("/repo", "win32"), /\.tools[\\/]rclone\.exe$/);
	assert.match(defaultRclone("/repo", "linux"), /\.tools[\\/]rclone$/);
});

test("rclone serve s3 gets a real config file in the state dir, never /dev/null or nul", () => {
	const argv: string[] = storeArgv("/r/rclone", "/s/state", 4931);
	assert.ok(!argv.includes("/dev/null") && !argv.some((a) => /^nul$/i.test(a)));
	assert.match(argv[argv.indexOf("--config") + 1], /state[\\/]rclone\.conf$/);
	assert.equal(argv[0], "/r/rclone");
	assert.ok(argv.includes("127.0.0.1:4931"));
});

test("stopping a process: a signal to its group on POSIX, taskkill of its tree on Windows", () => {
	assert.deepEqual(stopPlan(4242, "linux", false), { kind: "signal", pid: -4242, signal: "SIGTERM" });
	assert.deepEqual(stopPlan(4242, "darwin", true), { kind: "signal", pid: -4242, signal: "SIGKILL" });
	// Windows has no process groups and no SIGTERM: /T takes wrangler's workerd children with it, /F because nothing handles a polite stop
	assert.deepEqual(stopPlan(4242, "win32", false), { kind: "taskkill", command: "taskkill", args: ["/PID", "4242", "/T", "/F"] });
	assert.deepEqual(stopPlan(4242, "win32", true), { kind: "taskkill", command: "taskkill", args: ["/PID", "4242", "/T", "/F"] });
});

test("waiting is done by the process itself, not by a `sleep` program Windows does not have", () => {
	const started = Date.now();
	sleepMs(60);
	assert.ok(Date.now() - started >= 55);
});
