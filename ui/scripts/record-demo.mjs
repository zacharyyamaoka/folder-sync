#!/usr/bin/env node
// The README's demo video, recorded from the real running thing (docs/media/demo.{webm,mp4,gif}).
//
//   node ui/scripts/record-demo.mjs [--out DIR] [--cli PATH] [--keep]
//
// What runs, all on this machine and all real: the local stack (accounts/scripts/dev.mjs: wrangler dev with a local D1, the R2
// stand-in, rclone's S3 store), a test person signed in by email code, one "laptop" (a throwaway HOME signed in with the device
// code, running the real `folder-sync init` and `sync --watch`), and the real Files page (/fs/files) in headless Chromium. Two
// Playwright contexts record video side by side: the left one is ui/scripts/demo-stage.html (the real commands' output and the
// real folder on disk), the right one is the Files page itself. ffmpeg trims both to the same instant and puts them next to each
// other. The captions carry times this run measured by polling, not numbers typed in.
//
// The story: a file saved on the laptop appears in the Files page; a file added in the page lands on the laptop's disk; the page's
// version history restores the earlier text, and that lands on disk too.
//
// It stops everything it started (the stack by the PIDs dev.mjs recorded, the watcher and the stage server by handle). RCLONE
// defaults to the pinned one in .tools/ (scripts/dev-tools); the CLI is built with Go unless --cli names one.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const UI = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(UI, "..");
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const OUT = resolve(arg("--out") ?? join(REPO, "docs", "media"));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const log = (...a) => console.error("[record-demo]", ...a);

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

function buildCli(into) {
	if (arg("--cli")) return resolve(arg("--cli"));
	const go = existsSync(join(process.env.HOME, ".local/go/bin/go")) ? join(process.env.HOME, ".local/go/bin/go") : "go";
	const target = join(into, "folder-sync");
	const built = spawnSync(go, ["build", "-o", target, "./cmd/folder-sync"], { cwd: REPO, encoding: "utf8" });
	if (built.status !== 0) throw new Error(`go build failed: ${built.stderr}`);
	return target;
}

// WHY a fixed table: the stage server runs only these lines, typed on camera and run for real on the laptop's folder.
const COMMANDS = {
	init: "folder-sync init --project notes",
	watch: "folder-sync sync --watch",
	save: "echo '# Plan: order the clamp' > plan.md",
};

const PLAN_LINE = "# Plan: order the clamp";
const REVIEW_V1 = "# Review\n\nLooks good, ship it.\n";
const REVIEW_V2 = "# Review\n\nLooks good, ship it on Friday.\n\n- check the clamp first\n";

const work = mkdtempSync(join(tmpdir(), "record-demo-"));
const state = join(work, "stack");
mkdirSync(state, { recursive: true });
const cleanups = [];
let stopped = false;
async function stopAll() {
	if (stopped) return;
	stopped = true;
	for (const fn of cleanups.reverse()) { try { await fn(); } catch (error) { log("cleanup:", error.message); } }
	if (!process.argv.includes("--keep")) rmSync(work, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopAll().finally(() => process.exit(130)); });

const rclone = rcloneBinary();
const ports = { FS_STANDIN_PORT: String(await freePort()), FS_STORE_PORT: String(await freePort()), FS_ACCOUNTS_PORT: String(await freePort()), FS_INSPECTOR_PORT: String(await freePort()) };
const devEnv = { ...process.env, RCLONE: rclone, ...ports };
const dev = (verb) => spawnSync(process.execPath, [join(REPO, "accounts", "scripts", "dev.mjs"), verb, "--state-dir", state], { encoding: "utf8", env: devEnv });

try {
	const cli = buildCli(work);
	const up = dev("up");
	if (up.status !== 0) throw new Error(`the stack did not start: ${up.stderr}`);
	cleanups.push(() => dev("down"));
	const stack = JSON.parse(up.stdout.trim().split("\n").pop());
	const BASE = stack.accounts;
	log("stack up", BASE);

	const browser = await chromium.launch();
	cleanups.push(() => browser.close());

	// ---- a test person, signed in on the real sign-in route (not recorded) ----
	const email = `maker-${Date.now().toString(36)}@example.com`;
	const setup = await browser.newContext({ locale: "en-US", timezoneId: "UTC" });
	const sameSite = { Origin: BASE, "X-Folder-Sync": "1" };
	const sent = await setup.request.post(`${BASE}/fs/api/auth/email-otp/send-verification-otp`, { data: { email, type: "sign-in" }, headers: sameSite });
	if (!sent.ok()) throw new Error(`send code: ${sent.status()}`);
	const { code } = await (await setup.request.get(`${BASE}/fs/dev/mailbox?email=${encodeURIComponent(email)}`)).json();
	const signed = await setup.request.post(`${BASE}/fs/api/auth/sign-in/email-otp`, { data: { email, otp: code }, headers: sameSite });
	if (!signed.ok()) throw new Error(`sign in: ${signed.status()}`);
	const userId = (await (await setup.request.get(`${BASE}/fs/v1/me`)).json()).user.id;
	const session = await setup.storageState();

	// ---- the laptop: a throwaway HOME, signed in with the device code the person approves ----
	const home = join(work, "home");
	const folder = join(home, "notes");
	mkdirSync(folder, { recursive: true });
	// WHY a bare PATH and HOME: the laptop is a fresh computer with only folder-sync on it
	const env = { PATH: `${dirname(cli)}:/usr/bin:/bin`, HOME: home, USERPROFILE: home, LANG: "C.UTF-8", FOLDER_SYNC_SERVER: BASE, FOLDER_SYNC_RCLONE: rclone };
	// the computer's name is "laptop" (what folder-sync shows as the device); a real machine keeps its own host name here
	mkdirSync(join(home, ".folder-sync"), { recursive: true, mode: 0o700 });
	writeFileSync(join(home, ".folder-sync", "host.json"), JSON.stringify({ schema: "folder-sync-host/1", id: randomUUID(), name: "laptop", created_at: new Date().toISOString().replace(/\.\d+Z$/, "Z") }, null, 2) + "\n", { mode: 0o600 });
	{
		const child = spawn(cli, ["login"], { cwd: home, env });
		let out = "";
		child.stdout.on("data", (b) => { out += b; });
		child.stderr.on("data", (b) => { out += b; });
		const exited = new Promise((done) => child.on("exit", (c) => done(c)));
		const until = Date.now() + 30_000;
		while (!/open (\S+) and approve the code (\S+)/.test(out) && Date.now() < until) await sleep(100);
		const found = /open (\S+) and approve the code (\S+)/.exec(out);
		if (!found) { child.kill(); throw new Error(`login printed no code: ${out.trim()}`); }
		const userCode = found[2].replace(/[^A-Z0-9]/gi, "").toUpperCase();
		await setup.request.get(`${BASE}/fs/api/auth/device?user_code=${encodeURIComponent(userCode)}`);
		const approved = await setup.request.post(`${BASE}/fs/api/auth/device/approve`, { data: { userCode }, headers: { ...sameSite, "X-Folder-Sync-User": userId } });
		if (!approved.ok()) throw new Error(`device approve: ${approved.status()}`);
		const exit = await Promise.race([exited, sleep(60_000).then(() => "timeout")]);
		if (exit !== 0) throw new Error(`login exited ${exit}: ${out.trim()}`);
	}
	await setup.close();

	// ---- the stage server: the laptop's terminal and folder, for the left half of the video ----
	const stageHtml = readFileSync(join(UI, "scripts", "demo-stage.html"));
	const watchLog = [];
	let caption = "A folder on the laptop, synced and open in the browser.";
	let captionKind = "idle";
	let watcher = null;
	const walk = (dir, out = []) => {
		for (const name of readdirSync(dir).sort()) {
			if (name.startsWith(".folder-sync")) continue;
			const full = join(dir, name);
			if (statSync(full).isDirectory()) walk(full, out);
			else {
				const text = readFileSync(full, "utf8");
				out.push({ path: relative(folder, full), size: statSync(full).size, preview: text.trim().split("\n").filter(Boolean).slice(0, 2).join("  ") });
			}
		}
		return out;
	};
	const tidy = (text) => text.split(home).join("~");
	const stage = http.createServer((req, res) => {
		const url = new URL(req.url, "http://stage");
		const json = (body) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
		if (url.pathname === "/") { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(stageHtml); return; }
		if (url.pathname === "/api/state") { json({ watch: watchLog, files: walk(folder), caption, captionKind }); return; }
		const id = url.searchParams.get("id");
		if (!COMMANDS[id]) { res.statusCode = 404; res.end("{}"); return; }
		if (url.pathname === "/api/command") { json({ line: COMMANDS[id] }); return; }
		if (url.pathname === "/api/run" && req.method === "POST") {
			if (id === "watch") {
				watcher = spawn(cli, ["sync", "--watch"], { cwd: folder, env, stdio: ["ignore", "pipe", "pipe"] });
				cleanups.push(() => watcher.kill());
				for (const stream of [watcher.stdout, watcher.stderr]) {
					let rest = "";
					stream.on("data", (b) => {
						rest += b;
						const lines = rest.split("\n");
						rest = lines.pop();
						for (const line of lines) if (line.trim()) watchLog.push(tidy(line).slice(0, 120));
					});
				}
				json({ output: "" });
				return;
			}
			const done = spawnSync("sh", ["-c", COMMANDS[id]], { cwd: folder, env, encoding: "utf8", timeout: 60_000 });
			json({ output: tidy((done.stdout + done.stderr).trim()), code: done.status });
			return;
		}
		res.statusCode = 404;
		res.end("{}");
	});
	await new Promise((done) => stage.listen(0, "127.0.0.1", done));
	cleanups.push(() => new Promise((done) => stage.close(done)));
	const stageUrl = `http://127.0.0.1:${stage.address().port}/`;

	// ---- the two recorded pages ----
	const videos = join(work, "video");
	const ctxL = await browser.newContext({ viewport: { width: 480, height: 720 }, recordVideo: { dir: join(videos, "left"), size: { width: 480, height: 720 } }, locale: "en-US", timezoneId: "UTC" });
	const ctxR = await browser.newContext({ viewport: { width: 800, height: 720 }, recordVideo: { dir: join(videos, "right"), size: { width: 800, height: 720 } }, storageState: session, locale: "en-US", timezoneId: "UTC", colorScheme: "light" });
	// a plain dot where the pointer is, so the click can be followed (a headless recording draws no pointer)
	await ctxR.addInitScript(() => {
		addEventListener("DOMContentLoaded", () => {
			const dot = document.createElement("div");
			dot.style.cssText = "position:fixed;z-index:99999;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(47,111,79,.55);border:2px solid #2f6f4f;pointer-events:none;left:-40px;top:-40px;transition:transform .12s";
			document.body.append(dot);
			addEventListener("mousemove", (e) => { dot.style.left = `${e.clientX}px`; dot.style.top = `${e.clientY}px`; }, true);
			addEventListener("mousedown", () => { dot.style.transform = "scale(.6)"; }, true);
			addEventListener("mouseup", () => { dot.style.transform = ""; }, true);
		});
	});
	const created = {};
	const [left, right] = await Promise.all([
		ctxL.newPage().then((p) => { created.left = Date.now(); return p; }),
		ctxR.newPage().then((p) => { created.right = Date.now(); return p; }),
	]);
	await left.goto(stageUrl);
	// not on camera: the laptop starts syncing (the terminal keeps the real history), then the page opens on that folder
	await left.evaluate(() => window.stage.run("init", { speed: 12 }));
	await left.evaluate(() => window.stage.run("watch", { speed: 12 }));
	for (let i = 0; i < 600 && !watchLog.some((line) => /push:/.test(line)); i++) await sleep(50);
	await right.goto(`${BASE}/fs/files?project=notes`);
	await right.locator("folder-sync-status .panel").waitFor();
	await sleep(1200);
	// WHY a flash: a headless recording's clock starts at no moment this script can read, so both halves show a magenta full-screen
	// flash at the same instant and ffmpeg cuts each video where its flash ends (flashEnd below)
	const flash = () => new Promise((done) => {
		const cover = document.createElement("div");
		cover.style.cssText = "position:fixed;inset:0;background:#ff00ff;z-index:2147483647";
		document.body.append(cover);
		setTimeout(() => { cover.remove(); requestAnimationFrame(() => requestAnimationFrame(done)); }, 500);
	});
	await Promise.all([left.evaluate(flash), right.evaluate(flash)]);
	const scene0 = Date.now(); // both videos are cut to start where their flash ends

	const el = (css) => right.locator(`folder-sync-status ${css}`);
	const row = (path) => el(`.frow[title="${path}"]`);
	const say = (text, kind = "step") => { caption = text; captionKind = kind; };
	const glide = async (locator) => {
		const b = await locator.boundingBox();
		await right.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 14 });
		await sleep(250);
	};
	const waitDisk = async (path, includes, seconds = 30) => {
		const until = Date.now() + seconds * 1000;
		while (Date.now() < until) {
			const file = join(folder, path);
			if (existsSync(file) && readFileSync(file, "utf8").includes(includes)) return;
			await sleep(25);
		}
		throw new Error(`${path} never held ${JSON.stringify(includes)} on the laptop's disk`);
	};
	const seconds = (ms) => (ms / 1000).toFixed(1);
	const measured = {};

	await sleep(2200);
	say("1. Save a file on the laptop");
	await sleep(900);
	const { startedAt: t1 } = await left.evaluate(() => window.stage.run("save", { speed: 30 }));
	await row("plan.md").waitFor({ timeout: 60_000 }).catch(async (error) => {
		if (process.env.DEMO_DEBUG) {
			await right.screenshot({ path: join(OUT, "debug-right.png") });
			await left.screenshot({ path: join(OUT, "debug-left.png") });
			log("page text:", (await right.locator("body").innerText()).slice(0, 600));
		}
		throw error;
	});
	measured.toBrowser = Date.now() - t1;
	say(`In the browser ${seconds(measured.toBrowser)} s after the save`);
	await sleep(1700);
	await glide(row("plan.md"));
	await row("plan.md").click();
	await el("pre[data-preview=text]").waitFor();
	await sleep(1600);

	say("2. Add a file in the browser");
	const chooser = right.waitForEvent("filechooser");
	await glide(el('[data-act="upload"]'));
	await el('[data-act="upload"]').click();
	const t2 = Date.now();
	(await chooser).setFiles({ name: "review.md", mimeType: "text/markdown", buffer: Buffer.from(REVIEW_V1) });
	const hostsDir = join(folder, "hosts");
	const webHost = () => (existsSync(hostsDir) ? readdirSync(hostsDir).find((name) => existsSync(join(hostsDir, name, "review.md"))) : undefined);
	for (let i = 0; i < 2400 && !webHost(); i++) await sleep(25);
	if (!webHost()) throw new Error("review.md never reached the laptop's disk");
	measured.toDisk = Date.now() - t2;
	say(`On the laptop's disk ${seconds(measured.toDisk)} s after the upload`);
	await sleep(2200);

	say("3. Edit it, then go back to the first version");
	const chooser2 = right.waitForEvent("filechooser");
	await glide(el('[data-act="upload"]'));
	await el('[data-act="upload"]').click();
	(await chooser2).setFiles({ name: "review.md", mimeType: "text/markdown", buffer: Buffer.from(REVIEW_V2) });
	await waitDisk(join("hosts", webHost(), "review.md"), "on Friday");
	await sleep(1800);
	await glide(el('[data-act="file-history"]'));
	await el('[data-act="file-history"]').click();
	await el(".versions button").nth(1).waitFor();
	await sleep(1300);
	await glide(el(".versions button").nth(1));
	await el(".versions button").nth(1).click();
	await sleep(1500);
	await glide(el('[data-act="restore-version"]'));
	await el('[data-act="restore-version"]').click();
	const t3 = Date.now();
	await el('[data-restore="applied"]').waitFor({ timeout: 30_000 });
	say("Restored as a new version in the browser");
	await right.mouse.move(640, 560, { steps: 10 }); // the pointer off the buttons, so the text under it can be read
	// WHY only a short look at the disk: the Worker does not tell the hub about a restore (accounts/src/view.ts `restore`), so a
	// machine picks it up at its next poll, about a minute later. The caption claims the disk only if it arrived while on camera.
	const arrived = async (ms) => {
		const until = Date.now() + ms;
		while (Date.now() < until) {
			if (readFileSync(join(hostsDir, webHost(), "review.md"), "utf8") === REVIEW_V1) return true;
			await sleep(25);
		}
		return false;
	};
	if (await arrived(4000)) {
		measured.restore = Date.now() - t3;
		say(`Restored: back on the laptop's disk in ${seconds(measured.restore)} s`);
	} else {
		say("Restored as a new version. Machines pick it up at their next sync.");
	}
	await sleep(3200);
	say("Plain files on your disk. The web is a view of them.", "idle");
	await sleep(2400);
	const scene1 = Date.now();

	// ---- finish the videos and put the halves side by side ----
	const leftVideo = await left.video().path();
	const rightVideo = await right.video().path();
	await ctxL.close();
	await ctxR.close();
	mkdirSync(OUT, { recursive: true });
	// the moment each video's magenta flash ends: the last frame (at 50 fps) whose single averaged pixel is magenta
	const flashEnd = (video) => {
		const raw = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", video, "-vf", "fps=50,scale=1:1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 26 }).stdout;
		let last = -1;
		for (let i = 0; i + 2 < raw.length; i += 3) if (raw[i] > 200 && raw[i + 1] < 70 && raw[i + 2] > 200) last = i / 3;
		if (last < 0) throw new Error(`no flash found in ${video}`);
		return (last + 1) / 50;
	};
	const trim = { left: flashEnd(leftVideo), right: flashEnd(rightVideo) };
	const length = (scene1 - scene0) / 1000;
	log("measured", JSON.stringify(measured), "trim", JSON.stringify(trim), "length", length);
	const ff = (args) => {
		const done = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
		if (done.status !== 0) throw new Error(`ffmpeg ${args.slice(0, 4).join(" ")}: ${done.stderr}`);
	};
	const inputs = ["-ss", String(trim.left), "-t", String(length), "-i", leftVideo, "-ss", String(trim.right), "-t", String(length), "-i", rightVideo];
	const stack2 = "[0:v]fps=25,setsar=1[l];[1:v]fps=25,setsar=1[r];[l][r]hstack=inputs=2,format=yuv420p";
	ff([...inputs, "-filter_complex", `${stack2}[v]`, "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-movflags", "+faststart", join(OUT, "demo.mp4")]);
	ff([...inputs, "-filter_complex", `${stack2}[v]`, "-map", "[v]", "-an", "-c:v", "libvpx-vp9", "-crf", "37", "-b:v", "0", "-row-mt", "1", join(OUT, "demo.webm")]);
	ff([...inputs, "-filter_complex", `${stack2},fps=10,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle[v]`, "-map", "[v]", "-loop", "0", join(OUT, "demo.gif")]);
	writeFileSync(join(OUT, "demo.json"), JSON.stringify({ recorded_at: new Date().toISOString(), seconds: Number(length.toFixed(1)), measured_ms: measured, note: "recorded by ui/scripts/record-demo.mjs from the local stack; times are polled in that run" }, null, 2) + "\n");
	for (const name of ["demo.mp4", "demo.webm", "demo.gif"]) log(name, statSync(join(OUT, name)).size, "bytes");
} finally {
	await stopAll();
}
