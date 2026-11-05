#!/usr/bin/env node
// Gate G5, the desktop surface: Zach's own test of the app (2026-11-04), start to finish, on two computers.
//
//   machine 1  sign in (the device grant, approved here as the person's browser would) -> the first-run picker -> Create new
//              folder -> three files dropped in it -> the same three files on the web Files page within 10 s -> "Open online"
//   machine 2  its own HOME, its own host id: sign in -> the picker lists "Your folders online" -> Download the folder -> the three
//              files arrive on its disk -> an edit made there reaches machine 1's disk
//   machine 1  "Change folder..." -> "Open existing folder" on a folder that already holds files -> they upload and show online
//
// What is real: the page (app/ui/index.html + app.js, in Chromium), the folder-sync engine (`login --json --print-token`,
// `projects --json`, `init`, `share`, `sync --watch --events`) and the local accounts stack (accounts/scripts/dev.mjs: wrangler dev,
// the R2 stand-in, rclone's S3 store), and the web Files page (/fs/files, in Chromium, signed in as the same person with an email
// code). What is played by app/test/shell.mjs: the Rust shell around the page (keychain, tray, native dialog, file manager). See that
// file for why and for what proves the Rust itself. Linux, macOS and Windows runners all have Chromium; no display is needed.
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
const FOLDER_NAME = "journey-notes"; // typed into the picker; its project is the same name
const THREE_FILES = { "welcome.md": "welcome, version 1\n", "todo.md": "- call the farm\n- water the plants\n", "ideas.md": "# ideas\n\nsort the bins by colour\n" };
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

const listing = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listing(join(dir, e.name)).map((n) => `${e.name}/${n}`) : [e.name]));
const visible = (dir) => listing(dir).filter((n) => !n.startsWith(".") && !n.startsWith("hosts/")).sort();

const harness = await import(pathToFileURL(join(REPO, "bench", "latency", "harness.mjs")).href);
const dev = await import(pathToFileURL(join(REPO, "accounts", "scripts", "dev.mjs")).href);
const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "desktop-journey-"));
const stateDir = join(scratch, "stack");
let stack = null;
let browser = null;
const shells = [];
let stopped = false;
async function stop() {
	if (stopped) return;
	stopped = true;
	for (const shell of shells) await shell.stopEngine().catch(() => {});
	if (browser) await browser.close().catch(() => {});
	if (stack) {
		try { dev.down(stateDir); } catch { /* stopped */ }
		if (process.platform === "win32") for (const pid of Object.values(stack.pids || {})) if (pid) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
	}
	try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* a Windows file still held: the runner is thrown away */ }
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stop().then(() => process.exit(130)); });

let code = 1;
const problems = [];
try {
	const [standin, store, accounts, inspector] = await freePorts(4);
	const go = process.env.GO || (existsSync("/home/bam/.local/go/bin/go") ? "/home/bam/.local/go/bin/go" : "go");
	const rclone = rcloneBinary();
	stack = await dev.up(stateDir, { ...process.env, RCLONE: rclone, GO: go, FS_STANDIN_PORT: String(standin), FS_STORE_PORT: String(store), FS_ACCOUNTS_PORT: String(accounts), FS_INSPECTOR_PORT: String(inspector) });
	const server = stack.accounts;
	console.log(`stack up: ${server}`);

	const email = "desktop-journey@example.com";
	const person = await harness.signIn(server, email); // the person's browser, signed in to the site: it approves each computer
	const cli = harness.buildCli(join(scratch, "bin"), "journey");

	/** One computer: its own HOME (so its own host id and sign-in), the engine, and the window's page over the shell. */
	browser = await chromium.launch();
	const shots = arg("--shots") ? resolve(arg("--shots")) : null;
	if (shots) mkdirSync(shots, { recursive: true });
	async function computer(name) {
		const home = join(scratch, name);
		mkdirSync(home, { recursive: true });
		const env = { HOME: home, USERPROFILE: home, FOLDER_SYNC_SERVER: server, FOLDER_SYNC_RCLONE: rclone, LANG: "C.UTF-8" };
		for (const key of ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "COMSPEC", "PATHEXT", "WINDIR"]) if (process.env[key]) env[key] = process.env[key];
		const machine = new harness.Machine({ name, cli, home, folder: join(home, "none"), env });
		const holder = {};
		// "the system browser": the engine's device link is opened, and the person approves this computer there
		const onOpen = (link, userCode) => {
			const approve = async () => {
				await person.fetch(`/fs/api/auth/device?user_code=${encodeURIComponent(userCode)}`);
				const approved = await person.write("/fs/api/auth/device/approve", { method: "POST", body: { userCode } });
				if (!approved.ok) problems.push(`device approve: ${approved.status}`);
			};
			approve().catch((error) => problems.push(`device approve: ${error.message}`));
		};
		const shell = new Shell({ machine, server, onOpen, onState: (snapshot) => holder.page?.evaluate((s) => window.__emitState(s), snapshot).catch(() => {}) });
		shells.push(shell);
		const page = await browser.newPage({ viewport: { width: 460, height: 720 }, locale: "en-US" });
		holder.page = page;
		page.on("pageerror", (error) => problems.push(`${name} page error: ${error.message}`));
		page.on("console", (message) => { if (message.type() === "error") problems.push(`${name} console: ${message.text()}`); });
		await page.exposeFunction("__shellInvoke", (command, args) => shell.invoke(command, args));
		await page.addInitScript(() => {
			const listeners = [];
			window.__emitState = (snapshot) => listeners.forEach((fn) => fn({ payload: snapshot }));
			// Tauri rejects an invoke with the command's Err text itself; Playwright's bridge rejects with an Error
			const invoke = async (command, args) => {
				try { return await window.__shellInvoke(command, args || {}); } catch (error) { throw String((error && error.message) || error).replace(/^Error: /, ""); }
			};
			window.__TAURI__ = { core: { invoke }, event: { listen: async (eventName, fn) => { if (eventName === "state") listeners.push(fn); return () => {}; } } };
		});
		await page.goto(pathToFileURL(join(APP, "ui", "index.html")).href);
		const text = (id) => page.getByTestId(id).innerText();
		// WHY both schemes: the window must read well in light and dark (Zach's standing rule for UI)
		const shoot = async (shotName) => {
			if (!shots) return;
			for (const scheme of ["light", "dark"]) {
				await page.emulateMedia({ colorScheme: scheme });
				await page.screenshot({ path: join(shots, `desktop-${name}-${shotName}-${scheme}.png`) });
			}
			await page.emulateMedia({ colorScheme: "light" });
		};
		return { name, home, machine, shell, page, text, shoot, folderOf: (folderName) => join(home, "folder-sync", folderName) };
	}
	const step = (line) => console.log(`ok  ${line}`);
	const headlineIs = (c, pattern) => until(`${c.name}'s window to read ${pattern}`, async () => pattern.test(await c.text("headline")));

	// the web Files page, signed in as the same person with an email code (as a person does on the site)
	const web = await browser.newPage({ viewport: { width: 1100, height: 760 }, locale: "en-US" });
	web.on("pageerror", (error) => problems.push(`web page error: ${error.message}`));
	await web.goto(`${server}/fs/files`);
	await web.waitForURL(/\/fs\/signin\?return=/);
	await web.getByTestId("fs-signin-email").fill(email);
	await web.getByTestId("fs-signin-send").click();
	await web.getByTestId("fs-signin-code-step").waitFor();
	const mail = await (await web.request.get(`${server}/fs/dev/mailbox?email=${encodeURIComponent(email)}`)).json();
	await web.getByTestId("fs-signin-code").fill(mail.code);
	await web.getByTestId("fs-signin-verify").click();
	await web.waitForURL(`${server}/fs/files**`);
	const webShot = async (shotName) => { if (shots) await web.screenshot({ path: join(shots, `desktop-web-${shotName}.png`) }); };
	const row = (path) => web.locator(`folder-sync-status .frow[title="${path}"]`);
	/** Reloads the Files page of `project` until every path is a row; fails after `seconds`. Returns the seconds it took. */
	async function webShows(project, paths, seconds, since) {
		const deadline = Date.now() + seconds * 1000;
		for (;;) {
			await web.goto(`${server}/fs/files?project=${project}`);
			// the element draws "Checking sync..." first, then the folder's rows: give each attempt a moment to draw them
			const missing = [];
			for (const path of paths) if (!(await row(path).first().waitFor({ timeout: missing.length ? 500 : 3000 }).then(() => true, () => false))) missing.push(path);
			if (!missing.length) return (Date.now() - since) / 1000;
			if (Date.now() > deadline) {
				if (shots) await web.screenshot({ path: join(shots, "desktop-web-failure.png") });
				throw new Error(`the Files page of ${project} did not show ${missing.join(", ")} within ${seconds} s`);
			}
			await sleep(700);
		}
	}

	// ------------------------------------------------------------------------------------------------------ machine 1
	const one = await computer("machine1");

	// 1. first run: signed out, the Server field under Advanced
	await until("the first state", async () => (await one.text("headline")) === "Signed out");
	await one.page.getByTestId("advanced").click();
	assert.equal(await one.page.getByTestId("server-input").inputValue(), server);
	assert.equal(await one.page.getByTestId("server-input").isDisabled(), true, "FOLDER_SYNC_SERVER decides the server in a test run");
	await one.shoot("1-sign-in");
	step(`window: "Signed out", Sign in, and the Server field under Advanced holds ${server}`);

	// 2. sign in: the browser opens the device link, the person approves, the picker opens
	await one.page.getByTestId("sign-in").click();
	await until("the approval code", async () => /^Signing in: approve [A-Z0-9-]+ in your browser$/.test(await one.text("headline")));
	assert.equal(one.shell.opened.length, 1);
	assert.match(one.shell.opened[0], /\/fs\/device\?user_code=/);
	await headlineIs(one, /^Signed in: choose your folder$/);
	assert.equal(await one.text("who"), `Signed in as ${email}`);
	await until("the picker's online list to load", async () => (await one.text("online-note")).startsWith("None yet"));
	assert.equal(await one.page.getByTestId("new-location").innerText(), "~/folder-sync");
	await one.shoot("2-picker");
	step(`sign in: the device link was opened, approved, window "Signed in: choose your folder"; "Your folders online" is empty`);

	// 3. Create new folder: a name and a place; the engine starts
	await one.page.getByTestId("new-name").fill(FOLDER_NAME);
	await one.page.getByTestId("create-folder").click();
	await headlineIs(one, /^Synced at \d\d:\d\d:\d\d/);
	const folder1 = one.folderOf(FOLDER_NAME);
	assert.equal(await one.text("folder"), one.shell.tilde(folder1));
	assert.equal(one.shell.project, FOLDER_NAME);
	assert.ok(existsSync(join(folder1, ".folder-sync.toml")));
	await one.shoot("3-synced");
	step(`create new folder ${one.shell.tilde(folder1)}: init + share + sync --watch --events, window "${await one.text("headline")}"`);

	// 4. drop three files: they are on the web Files page within 10 s
	const droppedAt = Date.now();
	for (const [name, body] of Object.entries(THREE_FILES)) writeFileSync(join(folder1, name), body);
	const seconds = await webShows(FOLDER_NAME, Object.keys(THREE_FILES), 10, droppedAt);
	await webShot("1-three-files");
	step(`3 files dropped in the folder are rows on ${server}/fs/files?project=${FOLDER_NAME} ${seconds.toFixed(1)} s later`);

	// 5. Open online goes to the Files page of this folder
	await one.page.getByTestId("open-online").click();
	await until("the browser to be asked for the Files page", () => one.shell.opened.length === 2);
	assert.equal(one.shell.opened[1], `${server}/fs/files?project=${FOLDER_NAME}`);
	step(`Open online: ${one.shell.opened[1]}`);

	// ------------------------------------------------------------------------------------------------------ machine 2: the Mac
	const two = await computer("machine2");
	await until("machine 2's first state", async () => (await two.text("headline")) === "Signed out");
	await two.page.getByTestId("sign-in").click();
	await headlineIs(two, /^Signed in: choose your folder$/);
	await until("machine 2 to list the folders online", async () => (await two.page.getByTestId("online-list").innerText()).includes(FOLDER_NAME));
	await two.shoot("4-picker-online");
	step(`machine 2 signs in and "Your folders online" lists ${FOLDER_NAME}`);

	// 6. Download it: three files arrive on machine 2's disk
	await two.page.getByTestId(`download-${FOLDER_NAME}`).click();
	assert.equal(await two.text("join-location"), `~/folder-sync/${FOLDER_NAME}`);
	await two.shoot("5-download");
	const downloadAt = Date.now();
	await two.page.getByTestId("join-folder").click();
	const folder2 = two.folderOf(FOLDER_NAME);
	await until("the three files on machine 2's disk", () => {
		try { return JSON.stringify(visible(folder2)) === JSON.stringify(Object.keys(THREE_FILES).sort()); } catch { return false; }
	}, 30);
	for (const [name, body] of Object.entries(THREE_FILES)) assert.equal(readFileSync(join(folder2, name), "utf8"), body, `${name} on machine 2`);
	await headlineIs(two, /^Synced at \d\d:\d\d:\d\d/);
	assert.notEqual(two.machine.hostId(), one.machine.hostId(), "two computers, two host ids");
	await two.shoot("6-synced");
	step(`machine 2 downloads ${FOLDER_NAME} into ${two.shell.tilde(folder2)}: ${Object.keys(THREE_FILES).length} files, ${((Date.now() - downloadAt) / 1000).toFixed(1)} s`);

	// 7. an edit on machine 2 reaches machine 1
	const editedAt = Date.now();
	writeFileSync(join(folder2, "welcome.md"), "welcome, version 2: edited on the second computer\n");
	await until("the edit on machine 1's disk", () => readFileSync(join(folder1, "welcome.md"), "utf8").includes("version 2"), 30);
	step(`an edit on machine 2 is on machine 1's disk ${((Date.now() - editedAt) / 1000).toFixed(1)} s later`);
	writeFileSync(join(folder1, "todo.md"), "- call the farm\n- water the plants\n- back from machine 1\n");
	await until("the edit on machine 2's disk", () => readFileSync(join(folder2, "todo.md"), "utf8").includes("machine 1"), 30);
	step("and an edit on machine 1 is on machine 2's");

	// 8. Change folder... -> Open existing folder: a folder that already holds files uploads them
	const existing = join(one.home, "existing-stuff");
	mkdirSync(join(existing, "plans"), { recursive: true });
	writeFileSync(join(existing, "readme.md"), "an existing folder\n");
	writeFileSync(join(existing, "plans", "q1.md"), "plan for the first quarter\n");
	await one.page.getByTestId("change-folder").click();
	await until("the picker to open", async () => await one.page.getByTestId("open-existing").isVisible());
	assert.equal(await one.page.getByTestId("picker-cancel").isVisible(), true, "Cancel goes back to the running folder");
	await until("the online list to show both machines' folder", async () => (await one.page.getByTestId("online-list").innerText()).includes(FOLDER_NAME));
	await one.shoot("7-change-folder");
	one.shell.dialogAnswers.push(existing); // the native folder dialog (tauri-plugin-dialog) answers with this folder
	const openedAt = Date.now();
	await one.page.getByTestId("open-existing").click();
	await until("the window to show the opened folder", async () => (await one.text("folder")) === one.shell.tilde(existing));
	await headlineIs(one, /^Synced at \d\d:\d\d:\d\d/);
	assert.equal(one.shell.project, "existing-stuff");
	const second = await webShows("existing-stuff", ["readme.md"], 10, openedAt);
	assert.equal(await web.locator("folder-sync-status .frow", { hasText: "plans" }).first().isVisible(), true, "the plans folder is a row");
	await webShot("2-existing-folder");
	step(`Open existing folder ${one.shell.tilde(existing)}: its files upload (the Files page shows them ${second.toFixed(1)} s after the click)`);

	assert.deepEqual(problems, [], "the pages or the stack logged errors");
	console.log("desktop journey: PASS");
	code = 0;
} catch (error) {
	console.error(`desktop journey: FAIL\n${error instanceof Error ? error.stack || error.message : error}`);
	for (const shell of shells) console.error(`${shell.machine.name} status ${JSON.stringify(shell.status)}, online ${JSON.stringify(shell.online)}`);
	for (const shell of shells) console.error(`engine stderr (${shell.machine.name}):\n${shell.log.trim().split("\n").slice(-10).join("\n")}`);
	if (problems.length) console.error(`problems:\n${problems.join("\n")}`);
} finally {
	await stop();
}
process.exit(code);
