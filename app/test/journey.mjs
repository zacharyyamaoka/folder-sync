#!/usr/bin/env node
// Gate G5, the desktop surface: the app's window, from a signed-in person with a folder to a file edited and synced.
//
//   1. the window opens on "Signed in: choose your folder" with the folder's name on its button
//   2. Create ~/<folder> (the folder already holds two files): the engine starts, the window reads "Synced at HH:MM:SS"
//   3. Open folder: the folder is handed to the OS file manager, and it lists the files; both are readable online too
//   4. edit one file: the window reads a new "Synced at", and the edit is in the bucket's copy served by the accounts Worker
//
// What is real: the page (app/ui/index.html + app.js, in Chromium), the folder-sync engine (`init`, `sync --watch --events`) and
// the local accounts stack (accounts/scripts/dev.mjs: wrangler dev, the R2 stand-in, rclone's S3 store). What is played by
// app/test/shell.mjs: the Rust shell around the page (keychain, tray, native window, file manager). See that file for why and
// for what proves the Rust itself. Linux, macOS and Windows runners all have Chromium; no display is needed.
//
//   node app/test/journey.mjs [--shots <dir>]
//
// Starts everything on free ports in a scratch dir and stops exactly what it started. Needs `npm ci` in accounts/ and app/, the
// pinned rclone in .tools/ (scripts/dev-tools), Go, and Chromium (`npx playwright install chromium`).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { Shell, localHms } from "./shell.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(APP, "..");
const PROJECT = "journey";
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePorts(count) {
	return Promise.all(Array.from({ length: count }, () => new Promise((done, fail) => {
		const probe = createServer();
		probe.once("error", fail);
		probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => done(port)); });
	})));
}

function rcloneBinary() {
	const exe = process.platform === "win32" ? "rclone.exe" : "rclone";
	if (process.env.RCLONE) return resolve(process.env.RCLONE);
	if (existsSync(join(REPO, ".tools", exe))) return join(REPO, ".tools", exe);
	throw new Error("no rclone: run scripts/dev-tools, or set RCLONE");
}

/** Polls until `check` returns something truthy; a timeout names what it was waiting for. */
async function until(what, check, seconds = 60) {
	const deadline = Date.now() + seconds * 1000;
	for (;;) {
		const got = await check();
		if (got) return got;
		if (Date.now() > deadline) throw new Error(`timed out after ${seconds} s waiting for ${what}`);
		await sleep(50);
	}
}

const harness = await import(pathToFileURL(join(REPO, "bench", "latency", "harness.mjs")).href);
const dev = await import(pathToFileURL(join(REPO, "accounts", "scripts", "dev.mjs")).href);
const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "desktop-journey-"));
const stateDir = join(scratch, "stack");
let stack = null;
let browser = null;
let shell = null;
let stopped = false;
async function stop() {
	if (stopped) return;
	stopped = true;
	if (shell) await shell.stopEngine().catch(() => {});
	if (browser) await browser.close().catch(() => {});
	if (stack) {
		try { dev.down(stateDir); } catch { /* stopped */ }
		if (process.platform === "win32") for (const pid of Object.values(stack.pids || {})) if (pid) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
	}
	try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* a Windows file still held: the runner is thrown away */ }
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stop().then(() => process.exit(130)); });

let code = 1;
try {
	const [standin, store, accounts, inspector] = await freePorts(4);
	const go = process.env.GO || (existsSync("/home/bam/.local/go/bin/go") ? "/home/bam/.local/go/bin/go" : "go");
	const rclone = rcloneBinary();
	stack = await dev.up(stateDir, { ...process.env, RCLONE: rclone, GO: go, FS_STANDIN_PORT: String(standin), FS_STORE_PORT: String(store), FS_ACCOUNTS_PORT: String(accounts), FS_INSPECTOR_PORT: String(inspector) });
	console.log(`stack up: ${stack.accounts}`);

	// a person who is signed in: the machine's HOME holds the session `folder-sync login` wrote (the app keeps it in the keychain)
	const home = join(scratch, "home");
	mkdirSync(home, { recursive: true });
	const env = { HOME: home, USERPROFILE: home, FOLDER_SYNC_SERVER: stack.accounts, FOLDER_SYNC_RCLONE: rclone, LANG: "C.UTF-8" };
	for (const key of ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "COMSPEC", "PATHEXT", "WINDIR"]) if (process.env[key]) env[key] = process.env[key];
	const email = "desktop-journey@example.com";
	const cli = harness.buildCli(join(scratch, "bin"), "journey");
	const machine = new harness.Machine({ name: "desktop", cli, home, folder: join(home, PROJECT), env });
	await harness.login(machine, await harness.signIn(stack.accounts, email));

	// the person's folder already holds two files before the app is told about it
	const folder = join(home, PROJECT);
	mkdirSync(join(folder, "notes"), { recursive: true });
	writeFileSync(join(folder, "welcome.md"), "welcome, version 1\n");
	writeFileSync(join(folder, "notes", "todo.md"), "- call the farm\n");

	// the window: the real page, the shell's two IPC calls answered by shell.mjs
	browser = await chromium.launch();
	const page = await browser.newPage({ viewport: { width: 420, height: 560 }, locale: "en-US" });
	const problems = [];
	page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
	page.on("console", (message) => { if (message.type() === "error") problems.push(`console: ${message.text()}`); });
	shell = new Shell({ machine, project: PROJECT, email, server: stack.accounts, onState: (snapshot) => page.evaluate((s) => window.__emitState(s), snapshot).catch(() => {}) });
	await page.exposeFunction("__shellInvoke", async (command, args) => {
		if (command === "snapshot") return shell.snapshot();
		if (command === "action") return shell.action(args.id);
		throw new Error(`the journey shell does not implement the command ${command}`);
	});
	await page.addInitScript(() => {
		const listeners = [];
		window.__emitState = (snapshot) => listeners.forEach((fn) => fn({ payload: snapshot }));
		window.__TAURI__ = { core: { invoke: (command, args) => window.__shellInvoke(command, args || {}) }, event: { listen: async (name, fn) => { if (name === "state") listeners.push(fn); return () => {}; } } };
	});
	await page.goto(pathToFileURL(join(APP, "ui", "index.html")).href);
	const shots = arg("--shots") ? resolve(arg("--shots")) : null;
	if (shots) mkdirSync(shots, { recursive: true });
	const shoot = async (name) => { if (shots) await page.screenshot({ path: join(shots, `desktop-${name}.png`) }); };
	const text = (id) => page.getByTestId(id).innerText();
	const step = (line) => console.log(`ok  ${line}`);

	// 1. signed in, no folder yet
	await until("the window's first state", async () => (await text("headline")) === "Signed in: choose your folder");
	assert.equal(await text("who"), `Signed in as ${email}`);
	const shown = shell.tilde(folder); // ~/journey, or the full path on Windows (core.rs tilde)
	assert.equal(await text("create-folder"), `Create ${shown}`);
	await shoot("1-choose-folder");
	step(`window: "Signed in: choose your folder", button "Create ${shown}"`);

	// 2. create the folder: init, the engine, the first sync
	await page.getByTestId("create-folder").click();
	await until(`the window to read Synced after the first round`, async () => /^Synced at \d\d:\d\d:\d\d/.test(await text("headline")));
	assert.equal(await text("folder"), shown);
	await shoot("2-first-sync");
	step(`create folder: init + sync --watch --events, window "${await text("headline")}"`);

	// 3. open the folder: the OS file manager is given exactly the synced folder, and it lists the files
	await page.getByTestId("open-folder").click();
	await until("the file manager to be asked for the folder", () => shell.opened.length === 1);
	assert.equal(shell.opened[0], folder);
	const listing = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listing(join(dir, e.name)).map((n) => `${e.name}/${n}`) : [e.name]));
	const files = listing(shell.opened[0]).filter((n) => !n.startsWith(".")).sort();
	assert.deepEqual(files.filter((n) => !n.startsWith("hosts/")), ["notes/todo.md", "welcome.md"]);
	const online = new harness.Online(stack.accounts, machine.token(), PROJECT);
	const host = machine.hostId();
	const read = async (path) => { const bytes = await online.read(host, path); return bytes && bytes.toString(); };
	assert.equal(await until("welcome.md online", () => read("welcome.md")), "welcome, version 1\n");
	assert.equal(await read("notes/todo.md"), "- call the farm\n");
	step(`open folder: ${files.join(", ")} (and the same two files served online)`);

	// 4. edit a file: the window goes Syncing, then Synced at that round's time; the edit is online
	const roundsBefore = shell.rounds.length;
	const statesBefore = shell.history.length;
	const editedAt = Date.now();
	writeFileSync(join(folder, "welcome.md"), "welcome, version 2: edited in the journey\n");
	assert.equal(await until("the edit online", async () => { const got = await read("welcome.md"); return got && got.includes("version 2") ? got : null; }), "welcome, version 2: edited in the journey\n");
	const seconds = ((Date.now() - editedAt) / 1000).toFixed(1);
	const round = await until("the round that uploaded the edit", () => shell.rounds.slice(roundsBefore).find((r) => r.ok === true && r.uploaded >= 1));
	await until("the window to show that round", async () => (await text("headline")).startsWith(`Synced at ${localHms(round.at)}`));
	assert.deepEqual(shell.history.slice(statesBefore).filter((s, i, all) => s !== all[i - 1]), ["syncing", "synced"], "the window went Syncing, then Synced");
	await shoot("3-edited-and-synced");
	step(`edit: welcome.md version 2 is online ${seconds} s after the save; window ${shell.history.slice(statesBefore).join(" > ")}, "${await text("headline")}"`);

	assert.deepEqual(problems, [], "the page logged errors");
	console.log("desktop journey: PASS");
	code = 0;
} catch (error) {
	console.error(`desktop journey: FAIL\n${error instanceof Error ? error.stack || error.message : error}`);
	if (shell) console.error(`engine stderr:\n${shell.log.trim().split("\n").slice(-10).join("\n")}`);
} finally {
	await stop();
}
process.exit(code);
