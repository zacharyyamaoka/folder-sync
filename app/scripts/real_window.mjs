#!/usr/bin/env node
// The REAL desktop app, driven on a virtual display: the Tauri binary (the Rust shell, the keychain, the native window), its sidecar
// engine, the local accounts stack, and a headed Chromium on the web Files page, all on an invisible Xvfb screen. It is the proof that
// app/test/journey.mjs cannot give (that one plays the Rust shell in Node): the first-run window, Create new folder, three files
// dropped in and shown on the Files page, in light and dark, recorded to a video.
//
//   node app/scripts/real_window.mjs --out <dir> [--app <folder-sync-desktop binary>] [--display 97]
//
// Writes <dir>/desktop-2026-11-04-*.png (the window, light and dark), <dir>/real-window.mp4 (the whole run), <dir>/hero.mp4 (the
// journey part, about 12 s) and <dir>/real-window.json (what was asserted). Linux only, by hand (CI has the journey and the installer
// smoke). Needs Xvfb, xdotool, ffmpeg, dbus-run-session, gnome-keyring-daemon, `npm ci` in accounts/ and app/, the pinned rclone, Go,
// and `app/scripts/build.sh --no-bundle` (or the full build) first. Test values only: the person is desktop-real@example.com on a
// stack on 127.0.0.1, the keyring password is a constant made up here, and nothing leaves this machine. It never fronts a window on
// the person's own screen: the display is Xvfb's.
//
// WHY keyboard-driven (Tab, Enter, typed text) and not coordinates: WebKitGTK has no DevTools protocol to drive from outside, and the
// page's focus order is the page's own contract (name, Choose, Create, ...); with no window manager the keys go to the window under
// the pointer.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(APP, "..");
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = resolve(arg("--out", join(REPO, "reports", "media")));
const BINARY = resolve(arg("--app", join(APP, "src-tauri", "target", "release", "folder-sync-desktop")));
const DISPLAY = `:${arg("--display", "97")}`;
const W = 1360;
const H = 800;
const WIN = { x: 24, y: 40, w: 460, h: 720 }; // the app window on the screen
const EMAIL = "desktop-real@example.com";
const FOLDER_NAME = "journey-notes";
const FILES = { "welcome.md": "welcome, version 1\n", "todo.md": "- call the farm\n- water the plants\n", "ideas.md": "# ideas\n\nsort the bins by colour\n" };
const KEYRING_PASSWORD = "real-window-proof-only"; // a throwaway keyring in the scratch HOME

// The private session bus (keyring, portals) must not reach the person's own session: re-run this script under dbus-run-session with a
// scratch XDG_RUNTIME_DIR. WHY /tmp and a short name: unix sockets are capped at 108 bytes.
if (process.env.FS_REAL_INNER !== "1") {
	const runtime = mkdtempSync(join("/tmp", "fsr-"));
	// WHY a scratch HOME for the whole bus: the desktop portal it starts reads the person's own GNOME settings from HOME (here
	// prefer-dark), and WebKitGTK takes the window's light or dark from it; a scratch one lets this script set it per launch
	const bareHome = mkdtempSync(join("/tmp", "fsh-"));
	const go = process.env.GO || (existsSync("/home/bam/.local/go/bin/go") ? "/home/bam/.local/go/bin/go" : "go");
	const goEnv = Object.fromEntries(["GOPATH", "GOCACHE", "GOMODCACHE"].map((name) => [name, spawnSync(go, ["env", name], { encoding: "utf8" }).stdout.trim()]));
	const child = spawnSync("dbus-run-session", ["--", process.execPath, ...process.argv.slice(1)], {
		stdio: "inherit", env: { ...process.env, ...goEnv, FS_REAL_INNER: "1", HOME: bareHome, XDG_RUNTIME_DIR: runtime, GIO_USE_VFS: "local", GTK_USE_PORTAL: "0" },
	});
	// the bus's document portal may still have <runtime>/doc mounted for a moment after the bus exits
	for (let i = 0; i < 40 && (existsSync(runtime) || existsSync(bareHome)); i++) {
		for (const dir of [runtime, bareHome]) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* still mounted */ } }
		await sleep(250);
	}
	process.exit(child.status ?? 1);
}

const harness = await import(pathToFileURL(join(REPO, "bench", "latency", "harness.mjs")).href);
const dev = await import(pathToFileURL(join(REPO, "accounts", "scripts", "dev.mjs")).href);
mkdirSync(OUT, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "real-window-"));
const home = join(scratch, "home");
const runtime = process.env.XDG_RUNTIME_DIR;
const stateDir = join(scratch, "stack");
const procs = new Map();
const marks = {}; // seconds into the recording, for cutting the hero clip
const result = { app: BINARY, steps: [] };
const t0 = Date.now();
const log = (...line) => console.error(new Date().toTimeString().slice(0, 8), ...line);
const step = (name, extra = {}) => { result.steps.push({ t: +((Date.now() - t0) / 1000).toFixed(1), step: name, ...extra }); log(name, Object.keys(extra).length ? JSON.stringify(extra) : ""); };

function freePorts(count) {
	return Promise.all(Array.from({ length: count }, () => new Promise((done, fail) => {
		const probe = createServer();
		probe.once("error", fail);
		probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => done(port)); });
	})));
}
function spawnLogged(name, argv, env, extra = {}) {
	const logPath = join(scratch, `${name}.log`);
	const out = { stdio: ["ignore", "ignore", "ignore"], ...extra };
	const child = spawn(argv[0], argv.slice(1), { env, ...out });
	procs.set(name, child);
	child.logPath = logPath;
	return child;
}
async function stopProc(name, signal = "SIGTERM") {
	const child = procs.get(name);
	procs.delete(name);
	if (!child || child.exitCode !== null) return;
	child.kill(signal);
	const until = Date.now() + 10_000;
	while (child.exitCode === null && child.signalCode === null && Date.now() < until) await sleep(50);
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

const home2 = join(scratch, "home2"); // the second computer
const appEnv = (extra = {}, h = home) => {
	const env = {};
	for (const key of ["PATH", "LANG"]) if (process.env[key]) env[key] = process.env[key];
	Object.assign(env, {
		HOME: h, DISPLAY, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
		XDG_CONFIG_HOME: join(h, ".config"), XDG_DATA_HOME: join(h, ".local/share"), XDG_CACHE_HOME: join(h, ".cache"),
		GDK_BACKEND: "x11", NO_AT_BRIDGE: "1", WEBKIT_DISABLE_COMPOSITING_MODE: "1", WEBKIT_DISABLE_DMABUF_RENDERER: "1", GIO_USE_VFS: "local", GTK_USE_PORTAL: "0",
	});
	return { ...env, ...extra };
};
const x = (...args) => spawnSync("xdotool", args, { env: { DISPLAY, PATH: process.env.PATH }, encoding: "utf8" }).stdout.trim();
const clickAt = async (px, py) => { x("mousemove", String(WIN.x + px), String(WIN.y + py)); await sleep(250); x("click", "1"); await sleep(250); };
const typed = (text) => x("type", "--delay", "40", text);
const keys = (...names) => x("key", "--delay", "60", ...names);
/** The pixels of the window as RGB (ffmpeg grabs the region; no image library needed). */
function windowPixels() {
	const grabbed = spawnSync("ffmpeg", ["-loglevel", "error", "-f", "x11grab", "-video_size", `${WIN.w}x${WIN.h}`, "-i", `${DISPLAY}+${WIN.x},${WIN.y}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { env: { PATH: process.env.PATH }, maxBuffer: 64 << 20 });
	return grabbed.stdout;
}
/** The middle of the primary (accent-blue) button: how the window's one big button is found, in either theme. */
function primaryButton() {
	const pixels = windowPixels();
	const xs = [];
	const ys = [];
	for (let py = 0; py < WIN.h; py += 2) {
		for (let px = 0; px < WIN.w; px += 2) {
			const at = (py * WIN.w + px) * 3;
			const [r, g, b] = [pixels[at], pixels[at + 1], pixels[at + 2]];
			if (b > 200 && r < 90 && g > 90 && g < 140) { xs.push(px); ys.push(py); } // #2563eb, #3b78ec
		}
	}
	if (xs.length < 40) return null;
	xs.sort((a, b) => a - b);
	ys.sort((a, b) => a - b);
	return { x: xs[xs.length >> 1], y: ys[ys.length >> 1] };
}
async function clickPrimary(what, dx = 0, dy = 0) {
	const found = await until(`the primary button (${what})`, primaryButton, 20);
	step(`click ${what}`, { at: [found.x + dx, found.y + dy] });
	await clickAt(found.x + dx, found.y + dy);
}
function windowShot(name) {
	const path = join(OUT, `${name}.png`);
	const grabbed = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-draw_mouse", "0", "-video_size", `${WIN.w}x${WIN.h}`, "-i", `${DISPLAY}+${WIN.x},${WIN.y}`, "-frames:v", "1", path], { env: { PATH: process.env.PATH } });
	if (grabbed.status !== 0) throw new Error(`screenshot failed: ${grabbed.stderr}`);
	return path;
}
const settings = (h = home) => { try { return JSON.parse(readFileSync(join(h, ".config", "dev.folder-sync.desktop", "settings.json"), "utf8")); } catch { return {}; } };
const engineLog = (h = home) => { try { return readFileSync(join(h, ".local", "share", "dev.folder-sync.desktop", "engine.log"), "utf8"); } catch { return ""; } };
async function until(what, check, seconds = 60) {
	const deadline = Date.now() + seconds * 1000;
	for (;;) {
		const got = await check();
		if (got) return got;
		if (Date.now() > deadline) throw new Error(`timed out after ${seconds} s waiting for ${what}`);
		await sleep(100);
	}
}
const lastStatus = () => engineLog().split("\n").filter((l) => l.includes("status:")).pop() || "";

let browser = null;
let code = 1;
async function cleanup() {
	if (browser) await browser.close().catch(() => {});
	for (const name of ["app", "ffmpeg", "chromium"]) await stopProc(name, name === "ffmpeg" ? "SIGINT" : "SIGTERM");
	for (const name of ["keyring", "xvfb"]) await stopProc(name);
	try { dev.down(stateDir); } catch { /* stopped */ }
	try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch { /* best effort */ }
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { cleanup().then(() => process.exit(130)); });

try {
	mkdirSync(home, { recursive: true });
	mkdirSync(home2, { recursive: true });
	// the keyring first: anything that asks for org.freedesktop.secrets before it would bus-activate a second, locked one
	const keyring = spawn("gnome-keyring-daemon", ["--foreground", "--unlock", "--components=secrets"], { env: appEnv(), stdio: ["pipe", "ignore", "ignore"] });
	procs.set("keyring", keyring);
	keyring.stdin.end(KEYRING_PASSWORD);
	await until("the test keyring", () => spawnSync("dbus-send", ["--session", "--print-reply", "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.ListNames"], { env: appEnv(), encoding: "utf8" }).stdout.includes("org.freedesktop.secrets"), 15);
	spawnLogged("xvfb", ["Xvfb", DISPLAY, "-screen", "0", `${W}x${H}x24`, "-nolisten", "tcp"], { PATH: process.env.PATH });
	await until("Xvfb", () => existsSync(`/tmp/.X11-unix/X${DISPLAY.slice(1)}`), 10);
	step("keyring and display ready");

	const [standin, store, accounts, inspector] = await freePorts(4);
	const rclone = existsSync(join(REPO, ".tools", "rclone")) ? join(REPO, ".tools", "rclone") : process.env.RCLONE;
	const stack = await dev.up(stateDir, { ...process.env, RCLONE: rclone, GO: process.env.GO || "/home/bam/.local/go/bin/go", FS_STANDIN_PORT: String(standin), FS_STORE_PORT: String(store), FS_ACCOUNTS_PORT: String(accounts), FS_INSPECTOR_PORT: String(inspector) });
	const server = stack.accounts;
	step("stack up", { server });

	// "the system browser": the app hands every link to this program. A device link is approved as the person's browser would; any other
	// (Open online) is written to a file, and this script opens it in the visible Chromium
	const opened = join(scratch, "opened.txt");
	writeFileSync(join(scratch, "open-url.mjs"), `import { pathToFileURL } from "node:url";
import { appendFileSync } from "node:fs";
const url = process.argv[2];
const code = new URL(url).searchParams.get("user_code");
if (!code) { appendFileSync(${JSON.stringify(opened)}, url + "\\n"); process.exit(0); }
const harness = await import(pathToFileURL(${JSON.stringify(join(REPO, "bench", "latency", "harness.mjs"))}).href);
const person = await harness.signIn(${JSON.stringify(server)}, ${JSON.stringify(EMAIL)});
await person.fetch("/fs/api/auth/device?user_code=" + encodeURIComponent(code));
const approved = await person.write("/fs/api/auth/device/approve", { method: "POST", body: { userCode: code } });
process.exit(approved.ok ? 0 : 1);
`);
	const opener = join(scratch, "open-url");
	writeFileSync(opener, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(scratch, "open-url.mjs"))} "$1"\n`);
	chmodSync(opener, 0o755);

	// the visible Chromium on the right half: the web Files page, signed in as the same person with an email code
	// WHY the system Chrome: a headed run needs the full browser; the pinned headless shell is only what the journey uses
	browser = await chromium.launch({ headless: false, channel: process.env.FS_REAL_CHANNEL || "chrome", env: { DISPLAY, PATH: process.env.PATH, HOME: join(scratch, "chromium-home") }, args: ["--no-first-run", "--disable-features=Translate", `--window-position=${WIN.x + WIN.w + 20},24`, `--window-size=${W - WIN.x - WIN.w - 44},${H - 48}`] });
	const context = await browser.newContext({ viewport: null, locale: "en-US" });
	const web = await context.newPage();
	// WHY xdotool: with no window manager Chrome does not place its window; every visible Chrome window goes to the right half
	await until("Chrome's window", () => x("search", "--onlyvisible", "--class", "chrome").length > 0, 20);
	for (const id of x("search", "--onlyvisible", "--class", "chrome").split("\n").filter(Boolean)) {
		x("windowsize", id, String(W - WIN.x - WIN.w - 44), String(H - 48));
		x("windowmove", id, String(WIN.x + WIN.w + 20), "24");
		log("chrome window", id, x("getwindowgeometry", id).replace(/\n/g, " "));
	}
	await web.goto(`${server}/fs/files`);
	await web.waitForURL(/\/fs\/signin\?return=/);
	await web.getByTestId("fs-signin-email").fill(EMAIL);
	await web.getByTestId("fs-signin-send").click();
	await web.getByTestId("fs-signin-code-step").waitFor();
	const mail = await (await web.request.get(`${server}/fs/dev/mailbox?email=${encodeURIComponent(EMAIL)}`)).json();
	await web.getByTestId("fs-signin-code").fill(mail.code);
	await web.getByTestId("fs-signin-verify").click();
	await web.waitForURL(`${server}/fs/files**`);
	step("web Files page signed in (no folders yet)");

	const recording = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-framerate", "15", "-video_size", `${W}x${H}`, "-i", DISPLAY, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", join(OUT, "real-window.mp4")], { env: { PATH: process.env.PATH }, stdio: ["pipe", "ignore", "ignore"] });
	procs.set("ffmpeg", recording);
	const recordingStarted = Date.now();
	const now = () => +((Date.now() - recordingStarted) / 1000).toFixed(1);

	const launch = async (theme, h = home) => {
		const extra = { FOLDER_SYNC_SERVER: server, FOLDER_SYNC_RCLONE: rclone, FOLDER_SYNC_DESKTOP_OPEN_URL: opener };
		// the OS's light or dark, as GNOME's setting the desktop portal serves to WebKitGTK
		spawnSync("dconf", ["write", "/org/gnome/desktop/interface/color-scheme", theme === "dark" ? "'prefer-dark'" : "'prefer-light'"], { env: process.env });
		await sleep(400);
		const child = spawnLogged("app", [BINARY], appEnv(extra, h));
		// WHY by pid: the Files page in Chrome is titled "... folder-sync" too
		const id = await until("the app window", () => x("search", "--onlyvisible", "--pid", String(child.pid)).split("\n")[0], 30);
		x("windowmove", id, String(WIN.x), String(WIN.y));
		x("windowsize", id, String(WIN.w), String(WIN.h));
		await sleep(1200);
		return id;
	};
	const quit = async () => { await stopProc("app"); await sleep(500); };

	// ---------------------------------------------------------------- 1. light: first run, sign in, the picker
	await launch("light");
	windowShot("desktop-2026-11-04-signed-out-light");
	step("first run: the window says Signed out");
	await clickPrimary("Sign in"); // the engine's device link goes to the opener, which approves it as the person's browser
	await until("the picker (Signed in: choose your folder)", () => engineLog().includes("status: Signed in: choose your folder"), 60);
	await until("the (empty) online list", () => engineLog().includes("online folders:"), 30);
	await sleep(800);
	windowShot("desktop-2026-11-04-picker-light");
	assert(settings().email === EMAIL, `settings.email is ${settings().email}`);
	step("signed in through the device grant; first-run picker shown", { email: settings().email });
	await quit();

	// ---------------------------------------------------------------- 2. dark: the same picker, then Create new folder
	await launch("dark"); // signed in already: the session came back out of the keychain
	await sleep(2500);
	windowShot("desktop-2026-11-04-picker-dark");
	step("relaunched in the dark theme: the keychain kept the sign-in, the picker is shown again");
	marks.create = now();
	const create = await until("the Create folder button", primaryButton, 20);
	await clickAt(create.x, create.y - 87); // the Name field sits one row above the place line
	keys("ctrl+a");
	typed(FOLDER_NAME);
	await sleep(600);
	windowShot("desktop-2026-11-04-picker-typed-dark");
	await clickAt(create.x, create.y);
	await until("the first sync", () => /status: Synced at/.test(engineLog()), 90);
	const folder = join(home, "folder-sync", FOLDER_NAME);
	assert(existsSync(join(folder, ".folder-sync.toml")), "the folder was not made");
	assert(settings().folder === folder && settings().project === FOLDER_NAME, `settings ${JSON.stringify(settings())}`);
	await sleep(800);
	windowShot("desktop-2026-11-04-synced-dark");
	step("Create new folder: the engine started, the window says Synced", { folder, status: lastStatus().slice(9) });

	// three files dropped in: they are on the Files page, which "Open online" opens
	marks.drop = now();
	for (const [name, body] of Object.entries(FILES)) writeFileSync(join(folder, name), body);
	await clickPrimary("Open online", 120); // beside Open folder, the primary button
	const link = await until("Open online to reach the opener", () => existsSync(opened) && readFileSync(opened, "utf8").trim().split("\n").pop(), 15);
	assert(link === `${server}/fs/files?project=${FOLDER_NAME}`, `Open online went to ${link}`);
	const dropped = Date.now();
	const rows = (path) => web.locator(`folder-sync-status .frow[title="${path}"]`);
	for (;;) {
		await web.goto(link);
		const seen = await Promise.all(Object.keys(FILES).map((path) => rows(path).first().waitFor({ timeout: 2500 }).then(() => true, () => false)));
		if (seen.every(Boolean)) break;
		if (Date.now() - dropped > 20_000) throw new Error("the three files never reached the Files page");
		await sleep(500);
	}
	marks.shown = now();
	const seconds = (Date.now() - dropped) / 1000;
	await sleep(1500);
	windowShot("desktop-2026-11-04-synced-with-files-dark");
	writeFileSync(join(OUT, "desktop-2026-11-04-web-files.png"), await web.screenshot());
	step("the three files are rows on the Files page", { link, seconds: +seconds.toFixed(1) });
	assert(seconds <= 10, `${seconds} s is over the 10 s the journey allows`);
	await quit();

	// ---------------------------------------------------------------- 2b. a second computer (its own HOME and host id) joins the folder
	// WHY it signs in by itself: the keychain is shared here (one test keyring), so this computer is signed in the moment it starts; on a
	// real second machine the same device grant as above runs. What this proves is the Rust: the picker lists "Your folders online",
	// Download runs init + share + the engine in an empty place, and the three files arrive.
	await launch("light", home2);
	await until("the second computer's picker", () => engineLog(home2).includes("status: Signed in: choose your folder"), 60);
	await until("the online list on the second computer", () => engineLog(home2).includes(`online folders: ${FOLDER_NAME}`), 30);
	await sleep(800);
	windowShot("desktop-2026-11-04-picker-online-light");
	await clickAt(230, 30); // focus the page
	keys("Tab", "Tab", "Tab", "Tab", "Tab", "Return"); // name, Choose, Create, Open existing, Download... of journey-notes
	await sleep(600);
	windowShot("desktop-2026-11-04-download-light");
	keys("Tab", "Tab", "Return"); // Choose..., Download
	const folder2 = join(home2, "folder-sync", FOLDER_NAME);
	await until("the three files on the second computer", () => existsSync(folder2) && Object.keys(FILES).every((name) => existsSync(join(folder2, name)) && readFileSync(join(folder2, name), "utf8") === FILES[name]), 60);
	assert(settings(home2).folder === folder2 && settings(home2).project === FOLDER_NAME, `second computer settings ${JSON.stringify(settings(home2))}`);
	await until("the second computer's first sync", () => /status: Synced at/.test(engineLog(home2)), 60);
	await sleep(800);
	windowShot("desktop-2026-11-04-downloaded-light");
	step("the second computer downloaded the folder from \"Your folders online\": three files on its disk", { folder: folder2 });
	await quit();

	// ---------------------------------------------------------------- 3. light: relaunched on the folder
	const logged = engineLog().length;
	await launch("light");
	await until("the engine's first round after the relaunch", () => /status: Synced at/.test(engineLog().slice(logged)), 60);
	await sleep(1200);
	windowShot("desktop-2026-11-04-synced-light");
	step("relaunched in the light theme: it goes straight to the folder and syncs", { status: lastStatus().slice(9) });
	marks.end = now();
	await quit();

	await stopProc("ffmpeg", "SIGINT");
	// the hero: from just before Create to a moment after the files are on the page (6 to 20 s)
	const from = Math.max(0, marks.create - 2);
	const length = Math.min(20, Math.max(6, marks.shown - from + 3));
	spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-ss", String(from), "-t", String(length), "-i", join(OUT, "real-window.mp4"), "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "26", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(OUT, "hero.mp4")]);
	step("hero clip cut", { from, seconds: length });
	result.marks = marks;
	writeFileSync(join(OUT, "real-window.json"), JSON.stringify(result, null, 2));
	console.log("real window: PASS");
	code = 0;
} catch (error) {
	console.error(`real window: FAIL\n${error instanceof Error ? error.stack || error.message : error}`);
	console.error(`engine.log tail:\n${engineLog().trim().split("\n").slice(-12).join("\n")}`);
	try { windowShot("real-window-failure"); } catch { /* no display */ }
} finally {
	await cleanup();
}
process.exit(code);

function assert(ok, why) { if (!ok) throw new Error(`assertion failed: ${why}`); }
