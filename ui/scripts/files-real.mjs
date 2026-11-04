#!/usr/bin/env node
// The Files page against the real accounts Worker, end to end: starts the local stack (accounts/scripts/dev.mjs: wrangler
// dev, the R2 stand-in, rclone's S3 store) on free ports in a scratch state dir, runs ui/test/real/ over it, then stops
// exactly the processes it started, by the PIDs dev.mjs recorded.
//
//   node ui/scripts/files-real.mjs [--shots <dir>] [--prefix <name->] [--hero <file.webm>]
//
// RCLONE (the pinned rclone) defaults to <repo>/.tools/rclone, else the main checkout's. Like bench/, this crosses parts on
// purpose (PARTS.md): it is a proof of the whole stack, not a part's own test, so `npm --prefix ui test` skips it.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UI = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(UI, "..");
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

function freePort() {
	return new Promise((done, fail) => {
		const probe = createServer();
		probe.once("error", fail);
		probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => done(port)); });
	});
}

function rcloneBinary() {
	if (process.env.RCLONE) return resolve(process.env.RCLONE);
	const common = spawnSync("git", ["-C", REPO, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).stdout.trim();
	for (const dir of [REPO, common ? dirname(common) : ""]) if (dir && existsSync(join(dir, ".tools", "rclone"))) return join(dir, ".tools", "rclone");
	throw new Error("no rclone: run scripts/dev-tools, or set RCLONE");
}

const state = mkdtempSync(join(tmpdir(), "files-real-"));
const env = {
	...process.env, RCLONE: rcloneBinary(),
	FS_STANDIN_PORT: String(await freePort()), FS_STORE_PORT: String(await freePort()), FS_ACCOUNTS_PORT: String(await freePort()), FS_INSPECTOR_PORT: String(await freePort()),
};
const dev = (verb) => spawnSync(process.execPath, [join(REPO, "accounts", "scripts", "dev.mjs"), verb, "--state-dir", state], { encoding: "utf8", env });
let stopped = false;
const stop = () => { if (stopped) return; stopped = true; dev("down"); rmSync(state, { recursive: true, force: true }); };
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stop(); process.exit(130); });

let code = 1;
try {
	const up = dev("up");
	if (up.status !== 0) throw new Error(`the stack did not start: ${up.stderr}`);
	const stack = up.stdout.trim().split("\n").pop();
	console.log(`stack up: ${JSON.parse(stack).accounts}`);
	const run = spawn("npx", ["playwright", "test", "test/real"], {
		cwd: UI, stdio: "inherit",
		env: { ...env, FS_STACK: stack, ...(arg("--shots") ? { FS_SHOTS: resolve(arg("--shots")) } : {}), ...(arg("--prefix") ? { FS_SHOT_PREFIX: arg("--prefix") } : {}), ...(arg("--hero") ? { FS_HERO: resolve(arg("--hero")) } : {}) },
	});
	code = await new Promise((done) => run.on("exit", (c) => done(c ?? 1)));
} catch (error) {
	console.error(`files-real: ${error instanceof Error ? error.message : error}`);
} finally {
	stop();
}
process.exit(code);
