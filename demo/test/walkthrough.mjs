// The demo, end to end and local (PEP 0007 §6, §7 lane/demo): the real accounts Worker (accounts/scripts/dev.mjs:
// `wrangler dev` on a local D1, email codes instead of Google, folder-sync's R2 stand-in in front of `rclone serve s3`),
// the demo Worker under its own `wrangler dev` with its FOLDER_SYNC service binding resolved through a private dev
// registry, the folder-sync CLI built from this checkout, and Playwright's Chromium driving the demo page. One test
// person, one machine (a HOME under the scratch dir). Test values only; nothing leaves this machine.
//
//   [PROOF_DIR=<scratch>] [MEDIA_DIR=<dir for screenshots and the clip>] [PLAYWRIGHT_FROM=<dir with node_modules>]
//   [RCLONE=<pinned rclone>] [GO=<go>] node demo/test/walkthrough.mjs
//
// Ports (127.0.0.1): 4936 the demo (apps.json lists exactly this local origin for "demo"), 4946 its inspector; the
// stack on 4950-4953 (FS_STANDIN_PORT, FS_STORE_PORT, FS_ACCOUNTS_PORT, FS_INSPECTOR_PORT override them), away from a
// dev stack someone runs on 4930-4932. Each must be free. Playwright comes from ui/ (`npm install --prefix ui`) or
// PLAYWRIGHT_FROM. What it proves, one PASS/FAIL line each:
// - the demo's /fs/ is the accounts Worker through the service binding; the page is static, with its own CSP;
// - signed out, the page says what it is, offers Sign in (/fs/signin?return=/) and the own-bucket path, and no route a
//   stranger can write through: a signed-out web PUT is 401, a foreign Origin cannot start a sign-in, the page's own
//   paths take no writes;
// - a person signs in from the page (the email code in dev) and comes back to /, signed in, with no folders yet;
// - `folder-sync login --server <demo>` is approved on the demo's /fs/device page; init and a first sync; the folder
//   and its file appear under the machine's name;
// - "Write a test file" writes into the folder's web host, with its disk-to-online time; `sync --watch` pulls it and
//   its online-to-disk time shows on the page;
// - an edit on disk appears on the page with its disk-to-online time (recorded as the clip);
// - a file's versions open in <folder-sync-status>; the page fits 375 px with no sideways scroll; light and dark.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEMO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO = resolve(DEMO, "..");
const ACCOUNTS = join(REPO, "accounts");
const DIR = resolve(process.env.PROOF_DIR || join(DEMO, ".state", "walkthrough"));
const STATE = join(DIR, "stack");
const MEDIA = process.env.MEDIA_DIR ? resolve(process.env.MEDIA_DIR) : null;
const GO = process.env.GO || (existsSync(join(homedir(), ".local", "go", "bin", "go")) ? join(homedir(), ".local", "go", "bin", "go") : "go");
const RCLONE = resolve(process.env.RCLONE || join(REPO, ".tools", "rclone"));
const WRANGLER = join(ACCOUNTS, "node_modules", "wrangler", "bin", "wrangler.js");
const PORT = 4936;
const INSPECTOR = Number(process.env.DEMO_INSPECTOR_PORT || 4946);
const SITE = `http://127.0.0.1:${PORT}`;
const STACK = {
	FS_STANDIN_PORT: process.env.FS_STANDIN_PORT || "4950",
	FS_STORE_PORT: process.env.FS_STORE_PORT || "4951",
	FS_ACCOUNTS_PORT: process.env.FS_ACCOUNTS_PORT || "4952",
	FS_INSPECTOR_PORT: process.env.FS_INSPECTOR_PORT || "4953",
};
// WHY a private registry: wrangler dev resolves the FOLDER_SYNC binding by Worker name through its dev registry, and
// another session's folder-sync-accounts must never answer this run's /fs/
const QUIET = { CI: "1", WRANGLER_SEND_METRICS: "false", FORCE_COLOR: "0", WRANGLER_REGISTRY_PATH: join(DIR, "registry") };
const PROJECT = "notes";
const EMAIL = "demo-person@example.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
function check(name, ok, detail = "") {
	const text = typeof detail === "string" ? detail : JSON.stringify(detail);
	checks.push({ name, ok: !!ok, detail: text });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${text ? ` · ${text.slice(0, 220)}` : ""}`);
	return !!ok;
}

function playwright() {
	const from = [process.env.PLAYWRIGHT_FROM, join(REPO, "ui")].filter(Boolean);
	for (const dir of from) {
		const require = createRequire(join(resolve(dir), "package.json"));
		for (const name of ["playwright", "@playwright/test"]) {
			try {
				return require(name);
			} catch { /* next */ }
		}
	}
	throw new Error(`no Playwright under ${from.join(" or ")}: npm install --prefix ui, or set PLAYWRIGHT_FROM`);
}

function free(port) {
	return new Promise((done) => {
		const probe = createServer();
		probe.once("error", () => done(false));
		probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
	});
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// ------------------------------------------------------------------------------------------------ the processes

const started = {};

function start(name, argv, cwd, env) {
	const log = join(DIR, `${name}.log`);
	writeFileSync(log, "");
	// WHY detached: the pid is a process group (wrangler and its workerd), so stopping it stops exactly what this started
	const child = spawn(argv[0], argv.slice(1), { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env });
	child.stdout.on("data", (b) => appendFileSync(log, b));
	child.stderr.on("data", (b) => appendFileSync(log, b));
	child.unref();
	started[name] = child.pid;
	return child.pid;
}

async function stop(name) {
	const pid = started[name];
	if (!pid) return;
	try { process.kill(-pid, "SIGTERM"); } catch { /* gone */ }
	const until = Date.now() + 5000;
	while (alive(pid) && Date.now() < until) await sleep(100);
	if (alive(pid)) try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
	delete started[name];
}

function dev(verb) {
	const done = spawnSync(process.execPath, [join(ACCOUNTS, "scripts", "dev.mjs"), verb, "--state-dir", STATE], { encoding: "utf8", env: { ...process.env, ...QUIET, ...STACK, RCLONE, GO } });
	const last = (done.stdout || "").trim().split("\n").pop() || "";
	if (done.status !== 0) throw new Error(`dev.mjs ${verb} exited ${done.status}: ${done.stderr}`);
	return JSON.parse(last);
}

async function ready(url, pid, name, seconds = 120) {
	const until = Date.now() + seconds * 1000;
	while (Date.now() < until) {
		if (!alive(pid)) throw new Error(`${name} exited during start; see ${join(DIR, `${name}.log`)}`);
		try {
			await fetch(url);
			return;
		} catch { /* not yet */ }
		await sleep(300);
	}
	throw new Error(`${url} did not answer within ${seconds} s`);
}

// ------------------------------------------------------------------------------------------------ the machine

function envOf(home) {
	return { PATH: "/usr/bin:/bin", HOME: home, USERPROFILE: home, LANG: "C.UTF-8", FOLDER_SYNC_SERVER: SITE, FOLDER_SYNC_RCLONE: RCLONE };
}

function cli(bin, home, args) {
	const done = spawnSync(bin, args, { cwd: home, env: envOf(home), encoding: "utf8", timeout: 180_000 });
	return { code: done.status, out: done.stdout || "", err: done.stderr || "" };
}

/** `folder-sync login --server <demo>`, approved by the person on the demo's own /fs/device page. */
async function login(bin, home, context) {
	const child = spawn(bin, ["login", "--server", SITE], { cwd: home, env: envOf(home) });
	let out = "";
	child.stdout.on("data", (b) => { out += b; });
	child.stderr.on("data", (b) => { out += b; });
	const exited = new Promise((r) => child.on("exit", (code) => r(code)));
	const until = Date.now() + 30_000;
	while (!/open (\S+) and approve the code (\S+)/.test(out) && Date.now() < until) await sleep(200);
	const [, url] = /open (\S+) and approve the code (\S+)/.exec(out) || [];
	if (!url) {
		child.kill();
		return { exit: await exited, out, url: null };
	}
	const page = await context.newPage();
	await page.goto(url);
	await page.getByTestId("fs-device-approve").click();
	const done = await page.getByTestId("fs-device-done").textContent({ timeout: 30_000 }).catch(() => "");
	await page.close();
	const exit = await Promise.race([exited, sleep(60_000).then(() => "timeout")]);
	if (exit === "timeout") child.kill();
	return { exit, out, url, done };
}

function walk(root) {
	const out = [];
	if (!existsSync(root)) return out;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) out.push(...walk(path));
		else out.push(path);
	}
	return out;
}

/** Waits until `probe()` is truthy (it may throw meanwhile); its last value, or null after `seconds`. */
async function until(probe, seconds) {
	const end = Date.now() + seconds * 1000;
	while (Date.now() < end) {
		try {
			const value = await probe();
			if (value) return value;
		} catch { /* not yet */ }
		await sleep(150);
	}
	return null;
}

const rows = (page) => page.$$eval("#activity li[data-event]", (lis) => lis.map((li) => ({ event: li.dataset.event, path: li.dataset.path, host: li.dataset.hostName, ms: li.dataset.ms === undefined ? null : Number(li.dataset.ms), text: li.textContent })));

async function shot(page, name, options = {}) {
	if (!MEDIA) return;
	await page.screenshot({ path: join(MEDIA, name), ...options });
	console.log(`  · ${join(MEDIA, name)}`);
}

// ------------------------------------------------------------------------------------------------ the journey

async function run(bin, browser) {
	const home = join(DIR, "home");
	const folder = join(home, PROJECT);
	mkdirSync(home, { recursive: true });

	// 1. the integration: /fs/ through the binding, the page static with its own headers
	const me = await fetch(`${SITE}/fs/v1/me`);
	check("the demo's /fs/ is the accounts Worker through the service binding (GET /fs/v1/me signed out: 401 signed_out)", me.status === 401 && (await me.json()).error === "signed_out", me.status);
	const ui = await fetch(`${SITE}/fs/ui/v1/folder-sync.js`);
	check("the element is served on the demo's own origin (/fs/ui/v1/folder-sync.js)", ui.ok && /javascript/.test(ui.headers.get("content-type") || ""), ui.status);
	const home0 = await fetch(`${SITE}/`);
	const csp = home0.headers.get("content-security-policy") || "";
	check("the page is static, with its own CSP (connect-src 'self', no framing)", home0.ok && /connect-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp), csp || home0.status);

	// 2. a stranger: nothing to write through
	const put = await fetch(`${SITE}/fs/v1/folders/${PROJECT}/web/stranger.txt`, { method: "PUT", body: "hi", headers: { Origin: SITE, "X-Folder-Sync": "1" } });
	check("signed out, a web PUT through the demo is 401", put.status === 401, put.status);
	const foreign = await fetch(`${SITE}/fs/api/auth/email-otp/send-verification-otp`, { method: "POST", body: JSON.stringify({ email: "x@example.com", type: "sign-in" }), headers: { "Content-Type": "application/json", Origin: "https://evil.example" } });
	check("a foreign Origin cannot start a sign-in on the demo (not 2xx)", !foreign.ok, foreign.status);
	const own = await Promise.all(["PUT", "POST", "DELETE"].map((method) => fetch(`${SITE}/index.html`, { method, body: method === "DELETE" ? undefined : "x" }).then((r) => r.status)));
	check("the page's own paths take no writes (PUT, POST, DELETE on /index.html are not 2xx)", own.every((s) => s < 200 || s >= 300), own);

	// 3. signed out, on the page
	const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: "light" });
	const page = await context.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	// WHY not "Failed to load resource": the browser logs the signed-out GET /fs/v1/me (401) the page asks on purpose
	page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
	await page.goto(`${SITE}/`);
	await page.getByTestId("signed-out").waitFor({ state: "visible" });
	const signInHref = await page.getByTestId("sign-in").getAttribute("href");
	const outText = await page.getByTestId("signed-out").innerText();
	check("signed out: one line saying what it is, and Sign in to /fs/signin?return=/", signInHref === "/fs/signin?return=/" && /every computer you use, and here/.test(await page.locator(".lead").innerText()), signInHref);
	check("signed out: the own-bucket path (folder-sync login --key)", /Bring your own bucket/.test(outText) && /folder-sync login --key/.test(outText));
	check("signed out: no pill and no folder", await page.locator("#pill").isHidden() && await page.getByTestId("signed-in").isHidden());
	await shot(page, "01-signed-out.png", { fullPage: true });

	// 4. sign in from the page and come back to it
	await page.getByTestId("sign-in").click();
	await page.waitForURL(`${SITE}/fs/signin?return=/`);
	await page.getByTestId("fs-signin-email").fill(EMAIL);
	await page.getByTestId("fs-signin-send").click();
	await page.getByTestId("fs-signin-code-step").waitFor({ state: "visible" });
	const { code } = await (await fetch(`${SITE}/fs/dev/mailbox?email=${encodeURIComponent(EMAIL)}`)).json();
	await page.getByTestId("fs-signin-code").fill(code || "");
	await page.getByTestId("fs-signin-verify").click();
	await page.waitForURL(`${SITE}/`);
	await page.getByTestId("signed-in").waitFor({ state: "visible" });
	await until(() => page.getByTestId("no-folders").isVisible(), 10);
	check("signed in from the page, back on /: no folders yet, and the commands for another computer", await page.getByTestId("no-folders").isVisible() && (await page.locator("#commands").innerText()).includes(`folder-sync login --server ${SITE}`), (await page.locator("main").innerText()).slice(0, 300));
	const cookies = (await context.cookies(SITE)).map((c) => c.name);
	check("the session cookie is host-only on the demo's origin", cookies.some((n) => n.endsWith("session_token")) && (await context.cookies(SITE)).every((c) => c.domain === "127.0.0.1"), cookies);

	// 5. a machine joins: login on the demo, init, first sync
	const signedIn = await login(bin, home, context);
	check("folder-sync login --server <demo> is approved on the demo's /fs/device page", signedIn.exit === 0 && signedIn.url?.startsWith(`${SITE}/fs/device?user_code=`), `${signedIn.url} exit ${signedIn.exit} ${signedIn.done || signedIn.out.slice(-200)}`);
	mkdirSync(folder, { recursive: true }); // the page's command: mkdir -p ~/<folder> && folder-sync init …
	const init = cli(bin, home, ["init", "--project", PROJECT, "--dir", folder]);
	check(`folder-sync init --project ${PROJECT}`, init.code === 0, (init.out + init.err).trim().split("\n").slice(-1)[0]);
	writeFileSync(join(folder, "hello.md"), "# Hello\n\nWritten on the machine.\n");
	const once = cli(bin, home, ["sync", "--once", "--dir", folder]);
	check("sync --once publishes hello.md", once.code === 0, (once.out + once.err).trim().split("\n").slice(-1)[0]);
	await page.reload();
	await page.getByTestId("folder").waitFor({ state: "visible" });
	const machine = await until(async () => page.locator(`.device[data-device="${hostname()}"] li[data-path="hello.md"]`).count(), 20);
	check("the folder appears with hello.md under the machine's name", (await page.getByTestId("folder-name").innerText()) === PROJECT && machine, hostname());
	check("its upload is in recent activity", (await rows(page)).some((r) => r.event === "upload" && r.path === "hello.md" && r.host === hostname()), await rows(page));

	// 6. "Write a test file": the web host, then the machine pulls it
	await page.getByTestId("write").click();
	const wrote = await until(async () => /^Wrote folder-sync-demo\/\S+\.txt/.test(await page.getByTestId("wrote").innerText()) && (await page.getByTestId("wrote").innerText()), 20);
	const written = /folder-sync-demo\/\S+\.txt/.exec(wrote || "")?.[0];
	const webLine = await until(async () => (await rows(page)).find((r) => r.event === "upload" && r.path === written && r.host === "web"), 20);
	check("Write a test file puts folder-sync-demo/<time>.txt into the web host, listed under web", !!written && (await page.locator(`.device[data-device="web"] li[data-path="${written}"]`).count()) === 1, wrote);
	check("its disk-to-online time (up_ms, the Worker's receipt to its manifest) shows beside it", Number.isFinite(webLine?.ms) && /↑ /.test(webLine?.text || ""), webLine);
	const toml = join(folder, ".folder-sync.toml");
	writeFileSync(toml, readFileSync(toml, "utf8").replace(/^interval = ".*"$/m, 'interval = "2s"'));
	start("watch", [bin, "sync", "--watch", "--dir", folder], home, envOf(home));
	const landed = await until(() => walk(join(folder, "hosts")).find((p) => p.endsWith(written)), 60);
	check("sync --watch pulls the test file to disk", !!landed, landed || "not on disk within 60 s");
	const downLine = await until(async () => (await rows(page)).find((r) => r.event === "download" && r.path === written && Number.isFinite(r.ms)), 40);
	check("the page shows its online-to-disk time (down_ms, from the pull record)", !!downLine && /↓ /.test(downLine.text), downLine);
	const downFigure = await page.getByTestId("time-down").getAttribute("data-last");
	check("the online-to-disk figures (median and last) are filled", downFigure !== "" && (await page.getByTestId("time-down").locator('[data-k="median"]').innerText()) !== "–", downFigure);
	check("the page says online to disk reads two clocks", /two clocks/.test(await page.getByTestId("time-down").innerText()));
	const pill = await until(() => page.evaluate(() => document.querySelector("folder-sync-status").shadowRoot.querySelector(".pill")?.dataset.state), 15);
	check("the live pill shows the folder's state", !!pill && pill !== "unknown", pill);
	await shot(page, "02-signed-in.png", { fullPage: true });
	await page.getByTestId("times").screenshot(MEDIA ? { path: join(MEDIA, "03-timings.png") } : {});

	// 7. an edit on disk appears with its time: the clip
	const state = await context.storageState();
	const clipDir = join(DIR, "clip");
	rmSync(clipDir, { recursive: true, force: true });
	const recording = await browser.newContext({ viewport: { width: 1100, height: 1000 }, colorScheme: "light", storageState: state, recordVideo: { dir: clipDir, size: { width: 1100, height: 1000 } } });
	const clip = await recording.newPage();
	await clip.goto(`${SITE}/`);
	await clip.getByTestId("folder").waitFor({ state: "visible" });
	await until(async () => (await rows(clip)).length, 10);
	// one view holds both: the sync times above, recent activity below
	await clip.evaluate(() => window.scrollTo(0, document.querySelector('[data-testid="times"]').getBoundingClientRect().top + window.scrollY - 40));
	await sleep(4000);
	const before = (await rows(clip)).filter((r) => r.event === "upload" && r.path === "hello.md").length;
	const editedAt = Date.now();
	appendFileSync(join(folder, "hello.md"), `\nEdited on disk at ${new Date(editedAt).toISOString()}.\n`);
	const edited = await until(async () => {
		const top = (await rows(clip)).filter((r) => r.event === "upload" && r.path === "hello.md");
		return top.length > before && /edited hello\.md/.test(top[0].text) && Number.isFinite(top[0].ms) ? top[0] : null;
	}, 30);
	const seenAfter = Date.now() - editedAt;
	check("an edit on disk appears on the page as 'edited hello.md' with its disk-to-online time", !!edited && /↑ /.test(edited.text), edited ? `${edited.text} · on the page ${seenAfter} ms after the write` : "not within 30 s");
	const upFigure = await clip.getByTestId("time-up").getAttribute("data-last");
	check("the disk-to-online 'last' figure is that edit's time", edited && Number(upFigure) === edited.ms, { upFigure, ms: edited?.ms });
	await sleep(5000);
	const video = clip.video();
	await recording.close();
	if (MEDIA && video) {
		const raw = await video.path();
		const mp4 = join(MEDIA, "04-edit-appears.mp4");
		const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4], { encoding: "utf8" });
		check("the clip is written as MP4", made.status === 0, made.stderr || mp4);
		const gif = join(MEDIA, "04-edit-appears.gif");
		spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-vf", "fps=8,scale=720:-1:flags=lanczos", gif]);
		console.log(`  · ${mp4}`);
	}

	// 8. the element's own views, from the page
	await page.locator(`.device[data-device="${hostname()}"] button[data-path="hello.md"]`).click();
	const versions = await until(() => page.evaluate(() => {
		const root = document.querySelector("folder-sync-status").shadowRoot;
		return root.querySelector("dialog.panel")?.open && root.querySelector('[aria-selected="true"]')?.textContent;
	}), 10);
	check("a file's path opens its version history in <folder-sync-status>", versions === "Version history", versions);
	await sleep(800);
	await shot(page, "05-history.png");
	await page.keyboard.press("Escape");

	// 9. phone width and dark
	const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "light", storageState: state });
	const small = await phone.newPage();
	await small.goto(`${SITE}/`);
	await small.getByTestId("folder").waitFor({ state: "visible" });
	await until(async () => (await rows(small)).length, 10);
	const widths = await small.evaluate(() => ({ scroll: document.documentElement.scrollWidth, view: window.innerWidth }));
	check("at 375 px the page has no sideways scroll", widths.scroll <= widths.view, widths);
	await shot(small, "06-phone.png", { fullPage: true });
	await phone.close();
	const dark = await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: "dark", storageState: state });
	const night = await dark.newPage();
	await night.goto(`${SITE}/`);
	await night.getByTestId("folder").waitFor({ state: "visible" });
	await until(async () => (await rows(night)).length, 10);
	const bg = await night.evaluate(() => getComputedStyle(document.body).backgroundColor);
	check("dark mode follows prefers-color-scheme", bg === "rgb(20, 20, 19)", bg);
	await shot(night, "07-dark.png", { fullPage: true });
	await dark.close();

	check("no script errors on the page", errors.length === 0, errors);
	await context.close();
}

let code = 0;
try {
	mkdirSync(DIR, { recursive: true });
	if (MEDIA) mkdirSync(MEDIA, { recursive: true });
	for (const port of [PORT, INSPECTOR, ...Object.values(STACK).map(Number)]) {
		if (!(await free(port))) throw new Error(`port ${port} is taken on 127.0.0.1 (set FS_*_PORT for the stack; the demo's ${PORT} is fixed by apps.json)`);
	}
	const { chromium } = playwright();
	const bin = join(DIR, "bin", "folder-sync");
	const built = spawnSync(GO, ["-C", REPO, "build", "-o", bin, "./cmd/folder-sync"], { encoding: "utf8" });
	if (built.status !== 0) throw new Error(`folder-sync build failed: ${built.stderr}`);
	rmSync(STATE, { recursive: true, force: true });
	rmSync(join(DIR, "home"), { recursive: true, force: true });
	const stack = dev("up");
	console.log(`stack: accounts ${stack.accounts}, demo ${SITE}`);
	// WHY --local-upstream: the accounts Worker must see the demo's own 127.0.0.1:4936 origin, the one apps.json lists
	const demo = start("demo", [process.execPath, WRANGLER, "dev", "--config", join(DEMO, "wrangler.toml"), "--port", String(PORT), "--ip", "127.0.0.1",
		"--inspector-port", String(INSPECTOR), "--local-upstream", `127.0.0.1:${PORT}`, "--upstream-protocol", "http", "--show-interactive-dev-session=false"],
	DEMO, { ...process.env, ...QUIET });
	await ready(`${SITE}/fs/v1/me`, demo, "demo");
	const browser = await chromium.launch();
	try {
		await run(bin, browser);
	} finally {
		await browser.close();
	}
} catch (error) {
	check("the walkthrough ran to the end", false, error instanceof Error ? error.stack || error.message : String(error));
} finally {
	await stop("watch");
	await stop("demo");
	try { dev("down"); } catch (error) { console.error(String(error)); }
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length} passed, ${failed.length} failed`);
code = failed.length ? 1 : 0;
process.exit(code);
