#!/usr/bin/env node
// The hero video of the Fast Folder Sync report: two folder-sync machines on this computer, side by side, with each
// write's latency MEASURED live (bench/fast/CONTRACT.md's m2m and w2m ruler), recorded from the running system.
//
//   node bench/fast/demo/hero.mjs record --variant push|poll --out <path.mp4> [--gif <path.gif>] [--seconds 16]
//
// It brings up what bench/fast/fs_bench.mjs brings up for the variant (the export's own accounts/scripts/dev.mjs
// stack; machines A and B logged in as one test person, each `sync --watch` in its own scope and network namespace
// behind tcpproxy.mjs + lib/fwd.mjs; a web host through its own tcpproxy), serves a viewer page on 127.0.0.1:5149
// that lists both machines' real folders (read every 20 ms), runs a scripted sequence (scenario.mjs: 1 KB JSON saves
// at A, one web PUT, one 100-file burst), records the page with headless Chrome over --remote-debugging-pipe, and
// encodes an H.264 mp4 (and a GIF) with ffmpeg. The measured readouts go to <out without .mp4>.json.
//
// Ports (all 127.0.0.1, the recorder's own 5140-5149): the stack 5140-5143, the web host's proxy 5144/5145, the
// viewer 5149. A machine's proxies live inside its namespace (demo/nshost.mjs). wrangler and workerd also bind
// ephemeral ports of the OS's choosing, as they do in the bench.
//
// fs_bench.mjs exports none of the pieces used here (only percentile and summarize), so the ones needed are copied,
// marked "fs_bench.mjs's". The cached export (~/.cache/folder-sync-bench/<variant>-<sha>) is copied into this run's
// temp dir before its stack starts, because dev.mjs writes accounts/.dev.vars and wrangler writes accounts/.wrangler
// into the export it runs from, and a bench run may be using that very export.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, openSync, readSync, closeSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, copyFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir, getPriority } from "node:os";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAST = join(HERE, "..");
const MAIN = "/home/bam/folder-sync";
const RCLONE = join(MAIN, ".tools", "rclone");
// fs_bench.mjs's REFS for the two variants a hero shows
const REFS = { poll: "0db76d4be572e92f76ed9017edb4779395aa4fe9", push: "lane/fast-sync" };
const REF_LABELS = { poll: "claude/folder-sync-v0^1", push: "lane/fast-sync" };
const CACHE = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "folder-sync-bench");
const PROJECT = "fast-bench";
const EMAIL = "fast-bench@example.com";
const STACK_PORTS = { FS_STANDIN_PORT: 5140, FS_STORE_PORT: 5141, FS_ACCOUNTS_PORT: 5142, FS_INSPECTOR_PORT: 5143 };
const WEB_PROXY = { listen: 5144, control: 5145 };
const VIEWER_PORT = 5149;
// inside a machine's namespace only: the pipe ends its proxies forward to (never host ports)
const NS_VIA = { worker: 5148, s3: 5147 };
const CHROME = "/usr/bin/google-chrome";
const FFMPEG = "/usr/bin/ffmpeg";
const FPS = 15;
const SIZE = { width: 1280, height: 720 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.timeOrigin + performance.now();
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const log = (...a) => console.error(...a);

// ------------------------------------------------------------------------------------------------ options

function options(argv) {
	const o = { verb: argv[0], variant: null, out: null, gif: null, seconds: 16 };
	for (let i = 1; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
			return argv[++i];
		};
		if (a === "--variant") o.variant = next();
		else if (a === "--out") o.out = resolve(next());
		else if (a === "--gif") o.gif = resolve(next());
		else if (a === "--seconds") o.seconds = Number(next());
		else throw new Error(`unknown argument ${a}`);
	}
	if (o.verb !== "record") throw new Error("usage: node bench/fast/demo/hero.mjs record --variant push|poll --out <path.mp4> [--gif <path.gif>] [--seconds 16]");
	if (!REFS[o.variant]) throw new Error("--variant is push or poll");
	if (!o.out || !o.out.endsWith(".mp4")) throw new Error("--out is a path ending in .mp4");
	if (!(o.seconds >= 6 && o.seconds <= 60)) throw new Error("--seconds is 6 to 60");
	o.json = o.out.replace(/\.mp4$/, ".json");
	o.runId = `hero-${o.variant}-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
	return o;
}

// ------------------------------------------------------------------------------------------------ the source (fs_bench.mjs's)

function goBin() {
	if (process.env.GO) return process.env.GO;
	const local = join(homedir(), ".local", "go", "bin", "go");
	return existsSync(local) ? local : "go";
}

function must(cmd, args, opts = {}) {
	const done = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
	if (done.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: exit ${done.status}: ${(done.stderr || done.stdout || String(done.error)).trim().slice(-1500)}`);
	return done.stdout;
}

/** fs_bench.mjs's nodeModules(): accounts/node_modules for a lockfile, one `npm ci` into the cache. */
function nodeModules(accounts) {
	const lock = readFileSync(join(accounts, "package-lock.json"));
	const dir = join(CACHE, `node_modules-${sha256(lock).slice(0, 12)}`);
	if (!existsSync(join(dir, ".ready"))) {
		mkdirSync(dir, { recursive: true });
		copyFileSync(join(accounts, "package.json"), join(dir, "package.json"));
		copyFileSync(join(accounts, "package-lock.json"), join(dir, "package-lock.json"));
		log(`npm ci into ${dir}`);
		const done = spawnSync("npm", ["ci", "--no-audit", "--no-fund", "--registry", "https://registry.npmjs.org/"], { cwd: dir, encoding: "utf8", maxBuffer: 64 << 20 });
		if (done.status !== 0) throw new Error(`npm ci failed: ${(done.stderr || "").trim().split("\n").slice(-1)[0]}`);
		writeFileSync(join(dir, ".ready"), "");
	}
	return join(dir, "node_modules");
}

/** fs_bench.mjs's prepare(), unpatched: the variant's export, built and cached by commit. {dir, cli, code}. */
function prepare(variant) {
	const ref = REFS[variant];
	const sha = must("git", ["-C", MAIN, "rev-parse", "--short=12", ref]).trim();
	const dir = join(CACHE, `${variant}-${sha}`);
	const code = `${REF_LABELS[variant]}@${sha}`;
	if (!existsSync(join(dir, ".ready"))) {
		const tmp = `${dir}.tmp-${process.pid}`;
		mkdirSync(tmp, { recursive: true });
		log(`export ${ref} (${sha}) to ${dir}`);
		must("sh", ["-c", `git -C "$1" archive "$2" | tar -x -C "$3"`, "sh", MAIN, ref, tmp]);
		must(goBin(), ["-C", tmp, "build", "-ldflags", `-X main.version=bench-${sha}`, "-o", join(tmp, ".bench-bin", "folder-sync"), "./cmd/folder-sync"]);
		symlinkSync(nodeModules(join(tmp, "accounts")), join(tmp, "accounts", "node_modules"));
		renameSync(tmp, dir);
		writeFileSync(join(dir, ".ready"), `${code}\n`);
	}
	return { dir, code };
}

/** A private copy of the cached export (see the header): its own .dev.vars and .wrangler, the shared node_modules. */
function privateCopy(src, scratch) {
	const dir = join(scratch, "src");
	must("cp", ["-a", src.dir, dir]);
	rmSync(join(dir, "accounts", ".dev.vars"), { force: true });
	rmSync(join(dir, "accounts", ".wrangler"), { recursive: true, force: true });
	return { dir, cli: join(dir, ".bench-bin", "folder-sync"), code: src.code };
}

// ------------------------------------------------------------------------------------------------ processes (fs_bench.mjs's)

function spawnReady(cmd, args, what, opts = {}) {
	return new Promise((resolveReady, reject) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
		let out = "";
		let err = "";
		const timer = setTimeout(() => reject(new Error(`${what} did not start: ${err.trim()}`)), 15_000);
		child.stderr.on("data", (b) => { err += b; });
		child.stdout.on("data", (b) => {
			out += b;
			const nl = out.indexOf("\n");
			if (nl >= 0 && timer) {
				clearTimeout(timer);
				try {
					resolveReady({ child, info: JSON.parse(out.slice(0, nl)) });
				} catch (e) {
					reject(new Error(`${what}: ${out.slice(0, nl)}`));
				}
			}
		});
		child.on("exit", (code) => reject(new Error(`${what} exited ${code}: ${err.trim()}`)));
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

async function stopPid(pid, grace = 10_000) {
	if (!pid || !alive(pid)) return;
	try { process.kill(pid, "SIGCONT"); } catch { /* gone */ }
	try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
	const until = Date.now() + grace;
	while (alive(pid) && Date.now() < until) await sleep(50);
	if (alive(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
}

function free(port) {
	return spawnSync("sh", ["-c", `ss -Hltn "sport = :${port}" | grep -q .`]).status !== 0;
}

// ------------------------------------------------------------------------------------------------ the stack's browser (fs_bench.mjs's)

class Browser {
	constructor(site) {
		this.site = site;
		this.jar = new Map();
	}

	async fetch(path, { method = "GET", body, headers = {} } = {}) {
		const h = { ...headers };
		if (this.jar.size) h.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
		if (body !== undefined) {
			h["Content-Type"] = "application/json";
			body = JSON.stringify(body);
		}
		const answer = await fetch(`${this.site}${path}`, { method, body, headers: h, redirect: "manual" });
		for (const line of answer.headers.getSetCookie()) {
			const [pair] = line.split(";");
			const at = pair.indexOf("=");
			const name = pair.slice(0, at).trim();
			const value = pair.slice(at + 1).trim();
			if (/max-age=0/i.test(line) || value === "") this.jar.delete(name);
			else this.jar.set(name, value);
		}
		return answer;
	}

	write(path, init = {}) {
		const user = this.userId ? { "X-Folder-Sync-User": this.userId } : {};
		return this.fetch(path, { ...init, headers: { Origin: this.site, "X-Folder-Sync": "1", ...user, ...(init.headers || {}) } });
	}
}

async function signIn(site, email) {
	const browser = new Browser(site);
	const sent = await browser.write("/fs/api/auth/email-otp/send-verification-otp", { method: "POST", body: { email, type: "sign-in" } });
	if (!sent.ok) throw new Error(`send code: ${sent.status} ${await sent.text()}`);
	const { code } = await (await fetch(`${site}/fs/dev/mailbox?email=${encodeURIComponent(email)}`)).json();
	const signed = await browser.write("/fs/api/auth/sign-in/email-otp", { method: "POST", body: { email, otp: code } });
	if (!signed.ok) throw new Error(`sign in: ${signed.status} ${await signed.text()}`);
	browser.userId = (await (await browser.fetch("/fs/v1/me")).json()).user?.id;
	return browser;
}

// ------------------------------------------------------------------------------------------------ a machine (fs_bench.mjs's)

class Machine {
	constructor(name, { cli, scratch, server }) {
		this.name = name;
		this.cli = cli;
		this.home = join(scratch, `home-${name}`);
		this.folder = join(this.home, PROJECT);
		mkdirSync(this.folder, { recursive: true });
		// WHY a bare PATH and HOME: the machine is a fresh computer with only folder-sync on it, nothing of this one's
		this.env = { PATH: "/usr/bin:/bin", HOME: this.home, USERPROFILE: this.home, LANG: "C.UTF-8", FOLDER_SYNC_SERVER: server, FOLDER_SYNC_RCLONE: RCLONE };
		this.log = "";
	}

	must(args) {
		const done = spawnSync(this.cli, args, { cwd: this.home, env: this.env, encoding: "utf8", timeout: 180_000 });
		if (done.status !== 0) throw new Error(`${this.name}: folder-sync ${args.join(" ")} exited ${done.status}: ${((done.stdout || "") + (done.stderr || "")).trim().split("\n").slice(-3).join(" · ")}`);
		return done.stdout;
	}

	hostId() {
		return JSON.parse(readFileSync(join(this.home, ".folder-sync", "host.json"), "utf8")).id;
	}

	token() {
		return JSON.parse(readFileSync(join(this.home, ".folder-sync", "account.json"), "utf8")).token;
	}

	intervalMs() {
		const m = /^\s*interval\s*=\s*"(\d+(?:\.\d+)?)(ms|s|m)"/m.exec(readFileSync(join(this.folder, ".folder-sync.toml"), "utf8"));
		return m ? Number(m[1]) * { ms: 1, s: 1000, m: 60_000 }[m[2]] : 10_000;
	}

	async watch(runId, nsPid) {
		this.unit = `fshero-${runId}-${this.name}`.replace(/[^A-Za-z0-9_.-]/g, "-");
		const envPairs = Object.entries(this.env).map(([k, v]) => `${k}=${v}`);
		const child = spawn("systemd-run", ["--user", "--scope", "--quiet", "-p", "MemoryMax=4G", "--unit", this.unit, "--",
			"nsenter", "-t", String(nsPid), "-U", "-n", "--preserve-credentials", "--",
			"env", "-i", ...envPairs, this.cli, "sync", "--watch", "--dir", this.folder], { cwd: this.home, stdio: ["ignore", "pipe", "pipe"] });
		this.daemon = child;
		this.pid = child.pid; // systemd-run, nsenter and env each exec: this is folder-sync's pid
		const keep = (b) => {
			this.log += b;
			if (this.log.length > 256 * 1024) this.log = this.log.slice(-128 * 1024);
		};
		child.stdout.on("data", keep);
		child.stderr.on("data", keep);
		const until = Date.now() + 60_000;
		while (!/Watching /.test(this.log)) {
			if (child.exitCode !== null) throw new Error(`${this.name}: sync --watch exited ${child.exitCode}: ${this.log.trim()}`);
			if (Date.now() > until) throw new Error(`${this.name}: sync --watch did not start: ${this.log.trim()}`);
			await sleep(50);
		}
		const cg = must("systemctl", ["--user", "show", "-p", "ControlGroup", "--value", `${this.unit}.scope`]).trim();
		if (!cg) throw new Error(`${this.unit}.scope has no cgroup`);
		this.cgroup = join("/sys/fs/cgroup", cg);
	}

	pids() {
		try {
			return readFileSync(join(this.cgroup, "cgroup.procs"), "utf8").split("\n").filter(Boolean).map(Number);
		} catch {
			return [];
		}
	}

	async stop() {
		if (!this.pid) return;
		await stopPid(this.pid);
		for (const pid of this.pids()) await stopPid(pid, 3000);
		if (this.unit && spawnSync("systemctl", ["--user", "is-active", "--quiet", `${this.unit}.scope`]).status === 0) {
			spawnSync("systemctl", ["--user", "stop", `${this.unit}.scope`]);
		}
		this.pid = null;
	}
}

async function login(machine, browser) {
	const child = spawn(machine.cli, ["login"], { cwd: machine.home, env: machine.env });
	let out = "";
	child.stdout.on("data", (b) => { out += b; });
	child.stderr.on("data", (b) => { out += b; });
	const exited = new Promise((r) => child.on("exit", (code) => r(code)));
	const until = Date.now() + 30_000;
	while (!/open (\S+) and approve the code (\S+)/.test(out) && Date.now() < until) await sleep(100);
	const found = /open (\S+) and approve the code (\S+)/.exec(out);
	if (!found) {
		child.kill();
		throw new Error(`${machine.name}: folder-sync login printed no code: ${out.trim()}`);
	}
	const userCode = found[2].replace(/[^A-Z0-9]/gi, "").toUpperCase();
	await browser.fetch(`/fs/api/auth/device?user_code=${encodeURIComponent(userCode)}`);
	const approved = await browser.write("/fs/api/auth/device/approve", { method: "POST", body: { userCode } });
	if (!approved.ok) throw new Error(`device approve: ${approved.status}`);
	const code = await Promise.race([exited, sleep(60_000).then(() => "timeout")]);
	if (code !== 0) {
		child.kill();
		throw new Error(`${machine.name}: folder-sync login exited ${code}: ${out.trim()}`);
	}
}

async function webPut(base, token, rel, body) {
	const answer = await fetch(`${base}/fs/v1/folders/${PROJECT}/web/${rel}`, { method: "PUT", body, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" } });
	const text = await answer.text();
	if (answer.status !== 200) throw new Error(`PUT web/${rel}: ${answer.status} ${text.slice(0, 200)}`);
	return JSON.parse(text);
}

// ------------------------------------------------------------------------------------------------ the script

/**
 * The scripted sequence, ~2 s apart, as offsets from the recording's start. WHY a random phase (CONTRACT.md: each
 * trial starts at a random phase): the first save waits a uniform 0.2 s to 2.2 s and every later one up to 0.4 s more
 * than its slot, so no fixed phase of a round timer is what the video shows. Steps past the recording are dropped.
 */
function schedule(seconds) {
	const phase = 200 + Math.random() * 2000;
	const slots = [
		{ id: "edit-1", kind: "edit", rel: "demo/edit-1.json", label: "edit-1.json" },
		{ id: "edit-2", kind: "edit", rel: "demo/edit-2.json", label: "edit-2.json" },
		{ id: "web-1", kind: "web", rel: "demo/from-web.json", label: "from-web.json" },
		{ id: "edit-3", kind: "edit", rel: "demo/edit-3.json", label: "edit-3.json" },
		{ id: "burst-100", kind: "burst", dir: "demo/burst", label: "demo/burst/" },
		{ id: "edit-4", kind: "edit", rel: "demo/edit-4.json", label: "edit-4.json" },
	];
	return slots.map((s, i) => ({ ...s, at_ms: Math.round(phase + i * 2000 + (i ? Math.random() * 400 : 0)) })).filter((s) => s.at_ms < (seconds - 2.5) * 1000);
}

// ------------------------------------------------------------------------------------------------ the viewer

/** A folder as the viewer lists it: files with size and the first 40 characters; a directory of >6 files is one row. */
function scanFolder(root, previews) {
	const files = [];
	const walk = (dir) => {
		let entries;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			// WHY hidden: dotfiles (.folder-sync.toml) and an editor's `~` temp file are not the folder's content
			if (e.name.startsWith(".") || e.name.endsWith("~")) continue;
			const path = join(dir, e.name);
			if (e.isDirectory()) walk(path);
			else if (e.isFile()) {
				let st;
				try { st = statSync(path); } catch { continue; }
				const key = `${st.ino}:${st.mtimeMs}:${st.size}`;
				let preview = previews.get(path);
				if (!preview || preview.key !== key) {
					let text = "";
					try {
						const fd = openSync(path, "r");
						const buf = Buffer.alloc(160);
						const n = readSync(fd, buf, 0, buf.length, 0);
						closeSync(fd);
						text = [...buf.subarray(0, n).toString("utf8")].slice(0, 40).join("");
					} catch { /* gone between stat and read */ }
					preview = { key, text };
					previews.set(path, preview);
				}
				files.push({ rel: relative(root, path), size: st.size, mtime: st.mtimeMs, preview: preview.text });
			}
		}
	};
	walk(root);
	const byDir = new Map();
	for (const f of files) {
		const d = dirname(f.rel);
		if (!byDir.has(d)) byDir.set(d, []);
		byDir.get(d).push(f);
	}
	const rows = [];
	for (const [d, fs] of byDir) {
		if (fs.length > 6 && d !== ".") {
			// WHY first and last by name, not "newest": a file's mtime has the kernel's coarse clock, so a burst ties
			const names = fs.map((f) => f.rel.split("/").pop()).sort();
			rows.push({ rel: `${d}/`, group: fs.length, size: fs.reduce((n, f) => n + f.size, 0), mtime: Math.max(...fs.map((f) => f.mtime)), preview: `${names[0]} … ${names.at(-1)}` });
		} else rows.push(...fs);
	}
	return rows.sort((a, b) => a.rel.localeCompare(b.rel));
}

function viewer(state) {
	const clients = new Set();
	const previews = { a: new Map(), b: new Map() };
	let last = "";
	const send = (force = false) => {
		const snapshot = JSON.stringify({ ...state.meta, readouts: state.readouts, a: scanFolder(state.aFolder, previews.a), b: scanFolder(state.bFolder, previews.b) });
		if (!force && snapshot === last) return;
		last = snapshot;
		for (const res of clients) res.write(`data: ${snapshot}\n\n`);
	};
	// WHY the server reads the real directories (every 20 ms): the page shows what is on each machine's disk, not what
	// the script believes it wrote
	const timer = setInterval(() => send(), 20);
	const server = createServer((req, res) => {
		if (req.url === "/events") {
			res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
			clients.add(res);
			req.on("close", () => clients.delete(res));
			last = "";
			send(true);
			return;
		}
		if (req.url === "/" || req.url.startsWith("/?")) {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
			res.end(PAGE);
			return;
		}
		res.writeHead(404);
		res.end();
	});
	return new Promise((resolveUp, reject) => {
		server.once("error", reject);
		server.listen(VIEWER_PORT, "127.0.0.1", () => resolveUp({
			push: () => send(true),
			close: () => {
				clearInterval(timer);
				for (const res of clients) res.end();
				return new Promise((r) => server.close(r));
			},
		}));
	});
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>folder-sync live</title>
<style>
:root { --bg:#f4f5f7; --card:#ffffff; --ink:#111827; --muted:#6b7280; --line:#e5e7eb; --fresh:#fde68a; --ok:#047857; --wait:#b45309; --chipA:#dbeafe; --chipW:#ede9fe; }
* { box-sizing:border-box; margin:0; padding:0; }
body { width:1280px; height:720px; overflow:hidden; background:var(--bg); color:var(--ink); font:16px/1.3 Inter, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; padding:18px 24px; display:flex; flex-direction:column; gap:14px; }
header { display:flex; align-items:baseline; justify-content:space-between; }
h1 { font-size:28px; font-weight:700; letter-spacing:-0.01em; }
h1 .live { display:inline-block; width:12px; height:12px; border-radius:50%; background:#dc2626; margin-left:10px; vertical-align:middle; }
.clock { font:600 24px ui-monospace, "DejaVu Sans Mono", monospace; color:var(--muted); }
.sub { font-size:14px; color:var(--muted); margin-top:-8px; }
.panels { display:grid; grid-template-columns:1fr 1fr; gap:20px; height:392px; }
.panel { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 16px; overflow:hidden; }
.panel h2 { font-size:22px; font-weight:700; display:flex; justify-content:space-between; align-items:baseline; border-bottom:1px solid var(--line); padding-bottom:8px; margin-bottom:4px; }
.panel h2 small { font:400 13px ui-monospace, "DejaVu Sans Mono", monospace; color:var(--muted); }
.row { padding:4px 6px; border-radius:6px; height:38px; }
.row .l1 { display:flex; justify-content:space-between; gap:12px; font-size:16px; white-space:nowrap; }
.row .path { overflow:hidden; text-overflow:ellipsis; }
.row .pre { color:var(--muted); font-size:12px; }
.row .size { color:var(--muted); font:14px ui-monospace, "DejaVu Sans Mono", monospace; }
.row .pv { font:12.5px ui-monospace, "DejaVu Sans Mono", monospace; color:#374151; white-space:pre; overflow:hidden; }
.chip { font-size:12px; font-weight:600; border-radius:4px; padding:0 5px; margin-right:6px; }
.chip.a { background:var(--chipA); color:#1e40af; } .chip.w { background:var(--chipW); color:#5b21b6; }
.empty { color:var(--muted); font-size:15px; padding:8px 6px; }
.readouts { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:8px 20px; }
.ro { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:7px 14px; display:flex; gap:14px; justify-content:space-between; align-items:baseline; height:44px; }
.ro .what { font-size:17px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ro .what b { font-weight:600; }
.ro .what span { color:var(--muted); font-size:14px; }
.ro .val { flex-shrink:0; font:700 22px ui-monospace, "DejaVu Sans Mono", monospace; color:var(--ok); white-space:nowrap; }
.ro .val.wait { color:var(--wait); font-weight:500; }
.ro .val .first { font-size:14px; font-weight:400; color:var(--muted); }
.ro.idle { opacity:0.35; }
.foot { font-size:12.5px; color:var(--muted); }
</style></head>
<body>
<header><h1 id="title">folder-sync · two machines on this computer · live<span class="live"></span></h1><div class="clock" id="clock">t = 0.0 s</div></header>
<div class="sub" id="sub"></div>
<div class="panels"><div class="panel" id="pa"></div><div class="panel" id="pb"></div></div>
<div class="readouts" id="ro"></div>
<div class="foot">Each number is measured on this computer as the bench measures it: the clock starts just before the write (a save, write-then-rename, on A; or a PUT through /fs/ for the web) and stops when the other machine's file has the same sha256 (polled every 10 ms). Files listed are read from each machine's real folder every 20 ms.</div>
<script>
let S = null;
const seen = { a: new Map(), b: new Map() };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const kb = (n) => n >= 1024 ? (n / 1024).toFixed(n >= 10240 ? 0 : 1) + " KB" : n + " B";
const ms = (x) => Math.round(x).toLocaleString("en-US") + " ms";
function rowHtml(side, r) {
  const sig = r.size + ":" + r.mtime + ":" + (r.group || 0);
  const prev = seen[side].get(r.rel);
  if (!prev || prev.sig !== sig) seen[side].set(r.rel, { sig, at: Date.now() });
  const firstSeen = seen[side].get(r.rel);
  const age = Date.now() - firstSeen.at;
  const fresh = S.tStart !== null && firstSeen.at >= S.tStart ? Math.max(0, 1 - age / 1500) : 0;
  let path = esc(r.rel), chip = "";
  const m = /^hosts\\/([^/]+)\\/(.*)$/.exec(r.rel);
  if (m) {
    const who = m[1] === S.aId ? "a" : m[1] === S.webHost ? "w" : "";
    chip = who ? '<span class="chip ' + who + '">from ' + (who === "a" ? "A" : "web") + "</span>" : "";
    path = '<span class="pre">hosts/' + esc(m[1].slice(0, 8)) + '…/</span>' + esc(m[2]);
  }
  const bg = fresh > 0 ? "background: rgba(253,230,138," + fresh.toFixed(2) + ")" : "";
  return '<div class="row" style="' + bg + '"><div class="l1"><span class="path">' + chip + path + '</span><span class="size">' + (r.group ? r.group + " files · " : "") + kb(r.size) + '</span></div><div class="pv">' + esc(r.preview) + "</div></div>";
}
function panel(side, name, host, rows) {
  const body = rows.length ? rows.slice(0, 9).map((r) => rowHtml(side, r)).join("") + (rows.length > 9 ? '<div class="empty">+ ' + (rows.length - 9) + " more</div>" : "") : '<div class="empty">(empty)</div>';
  return "<h2>" + name + "<small>host " + esc(host.slice(0, 8)) + "… · ~/" + esc(S.project) + "</small></h2>" + body;
}
function readout(r) {
  const lead = r.kind === "web" ? "<b>web write</b> (PUT /fs/) → on A" : r.kind === "burst" ? "<b>100 files</b> at A → all on B" : "<b>wrote at A</b> → on B";
  let val;
  if (r.ms != null) val = '<span class="val">' + ms(r.ms) + (r.first_ms != null ? ' <span class="first">first ' + ms(r.first_ms) + "</span>" : "") + "</span>";
  else if (r.status === "timeout") val = '<span class="val wait">not there after ' + Math.round(r.timeout_ms / 1000) + " s</span>";
  else if (r.status === "error") val = '<span class="val wait">error</span>';
  else if (r.t_write != null) val = '<span class="val wait">waiting ' + ((Date.now() - r.t_write) / 1000).toFixed(1) + " s</span>";
  else val = '<span class="val wait">—</span>';
  return '<div class="ro' + (r.t_write == null ? " idle" : "") + '"><span class="what">' + lead + ': <span>' + esc(r.label) + "</span></span>" + val + "</div>";
}
function draw() {
  if (!S) return;
  document.getElementById("title").innerHTML = "folder-sync " + esc(S.variant) + ' · two machines on this computer · live<span class="live"></span>';
  document.getElementById("sub").textContent = S.code + " · " + S.cadence + " · " + S.env;
  document.getElementById("clock").textContent = S.tStart === null ? "t = 0.0 s" : "t = " + Math.max(0, (Date.now() - S.tStart) / 1000).toFixed(1) + " s";
  document.getElementById("pa").innerHTML = panel("a", "Machine A", S.aId, S.a);
  document.getElementById("pb").innerHTML = panel("b", "Machine B", S.bId, S.b);
  document.getElementById("ro").innerHTML = S.readouts.map(readout).join("");
}
const es = new EventSource("/events");
es.onmessage = (e) => { S = JSON.parse(e.data); draw(); window.__ready = true; };
setInterval(draw, 50);
</script></body></html>`;

// ------------------------------------------------------------------------------------------------ the recorder

/** Chrome's DevTools protocol over --remote-debugging-pipe (fd 3 in, fd 4 out, NUL-separated JSON): no port at all. */
class Cdp {
	constructor(child) {
		this.toChrome = child.stdio[3];
		this.id = 0;
		this.waiting = new Map();
		this.events = [];
		let buf = Buffer.alloc(0);
		child.stdio[4].on("data", (b) => {
			buf = Buffer.concat([buf, b]);
			let z;
			while ((z = buf.indexOf(0)) >= 0) {
				const msg = JSON.parse(buf.subarray(0, z).toString("utf8"));
				buf = buf.subarray(z + 1);
				if (msg.id && this.waiting.has(msg.id)) {
					const w = this.waiting.get(msg.id);
					this.waiting.delete(msg.id);
					if (msg.error) w.reject(new Error(`${w.method}: ${msg.error.message}`));
					else w.resolve(msg.result);
				} else for (const fn of this.events) fn(msg);
			}
		});
	}

	send(method, params = {}, sessionId) {
		const id = ++this.id;
		this.toChrome.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
		return new Promise((res, rej) => this.waiting.set(id, { resolve: res, reject: rej, method }));
	}
}

async function chrome(profile) {
	const child = spawn(CHROME, ["--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
		"--disable-extensions", "--disable-sync", "--disable-background-networking", "--disable-component-update", "--disable-breakpad", "--disable-crash-reporter",
		"--mute-audio", "--hide-scrollbars", "--force-device-scale-factor=1", `--window-size=${SIZE.width},${SIZE.height}`, "about:blank"],
	{ stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
	let err = "";
	child.stderr.on("data", (b) => {
		err += b;
		if (err.length > 64 * 1024) err = err.slice(-32 * 1024);
	});
	const cdp = new Cdp(child);
	const exited = new Promise((r) => child.on("exit", r));
	const until = Date.now() + 20_000;
	let page;
	while (!page) {
		if (child.exitCode !== null) throw new Error(`chrome exited ${child.exitCode}: ${err.trim().slice(-500)}`);
		if (Date.now() > until) throw new Error(`chrome opened no page: ${err.trim().slice(-500)}`);
		const { targetInfos } = await cdp.send("Target.getTargets");
		page = targetInfos.find((t) => t.type === "page");
		if (!page) await sleep(100);
	}
	const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
	const call = (method, params) => cdp.send(method, params, sessionId);
	await call("Emulation.setDeviceMetricsOverride", { ...SIZE, deviceScaleFactor: 1, mobile: false });
	await call("Page.enable");
	return {
		pid: child.pid,
		call,
		log: () => err,
		async close() {
			try { await Promise.race([cdp.send("Browser.close"), sleep(3000)]); } catch { /* gone */ }
			await Promise.race([exited, sleep(5000)]);
			await stopPid(child.pid, 3000);
		},
	};
}

/** Screenshots at FPS until `untilMs` (epoch ms); each frame keeps the wall time it was taken at. */
async function capture(tab, dir, untilMs) {
	mkdirSync(dir, { recursive: true });
	const frames = [];
	const period = 1000 / FPS;
	let next = now();
	while (now() < untilMs) {
		const at = now();
		const { data } = await tab.call("Page.captureScreenshot", { format: "jpeg", quality: 90, optimizeForSpeed: true });
		const file = join(dir, `f${String(frames.length).padStart(5, "0")}.jpg`);
		writeFileSync(file, Buffer.from(data, "base64"));
		frames.push({ at, file });
		next += period;
		await sleep(Math.max(0, next - now()));
	}
	return frames;
}

/** frames -> ffconcat (each frame held until the next one was taken) -> H.264 mp4 and, if asked, a GIF. */
function encode(frames, tEnd, out, gif, dir) {
	const list = join(dir, "frames.ffconcat");
	const lines = ["ffconcat version 1.0"];
	for (const [i, f] of frames.entries()) {
		const until = i + 1 < frames.length ? frames[i + 1].at : tEnd;
		lines.push(`file '${f.file}'`, `duration ${((until - f.at) / 1000).toFixed(4)}`);
	}
	lines.push(`file '${frames.at(-1).file}'`); // the concat demuxer drops the last entry's duration otherwise
	writeFileSync(list, `${lines.join("\n")}\n`);
	mkdirSync(dirname(out), { recursive: true });
	must(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-vf", `fps=${FPS},format=yuv420p`,
		"-c:v", "libx264", "-preset", "slow", "-crf", "30", "-movflags", "+faststart", "-an", out]);
	if (gif) {
		mkdirSync(dirname(gif), { recursive: true });
		must(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list,
			"-vf", "fps=8,scale=640:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=64:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle", gif]);
	}
}

// ------------------------------------------------------------------------------------------------ the run

async function record(o) {
	for (const port of [...Object.values(STACK_PORTS), WEB_PROXY.listen, WEB_PROXY.control, VIEWER_PORT]) {
		if (port < 5140 || port > 5149) throw new Error(`port ${port} is outside the recorder's 5140-5149`);
		if (!free(port)) throw new Error(`port ${port} is taken; another recording (or a peer) holds it`);
	}
	if (!existsSync(RCLONE)) throw new Error(`no rclone at ${RCLONE}`);
	const scratch = mkdtempSync(join(tmpdir(), "fshero-"));
	const owned = { pids: [], machines: [], stateDir: null, dev: null, tab: null, worker: null, view: null };
	const teardown = async () => {
		if (owned.tab) await owned.tab.close().catch(() => {});
		if (owned.view) await owned.view.close().catch(() => {});
		if (owned.worker) await owned.worker.terminate().catch(() => {});
		for (const m of owned.machines) await m.stop().catch(() => {});
		for (const pid of owned.pids.reverse()) await stopPid(pid, 3000);
		if (owned.dev && owned.stateDir) try { owned.dev.down(owned.stateDir); } catch { /* stopped */ }
		rmSync(scratch, { recursive: true, force: true });
	};
	let interrupted = false;
	const onSignal = (sig) => {
		if (interrupted) return;
		interrupted = true;
		log(`${sig}: stopping everything this recording started`);
		teardown().finally(() => process.exit(130));
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	try {
		const src = privateCopy(prepare(o.variant), scratch);
		// WHY: wrangler's dev registry and logs default to ~/.config/.wrangler, which a bench run's wrangler is using
		process.env.WRANGLER_REGISTRY_PATH = join(scratch, "wrangler-registry");
		process.env.WRANGLER_LOG_PATH = join(scratch, "wrangler-logs");
		owned.dev = await import(join(src.dir, "accounts", "scripts", "dev.mjs"));
		owned.stateDir = join(scratch, "stack");
		const env = { ...process.env, ...Object.fromEntries(Object.entries(STACK_PORTS).map(([k, v]) => [k, String(v)])), RCLONE, GO: goBin() };
		log(`stack up (${src.code})`);
		const stack = await owned.dev.up(owned.stateDir, env);
		const server = stack.accounts;
		const standinPort = Number(new URL(stack.endpoint).port);
		const workerPort = STACK_PORTS.FS_ACCOUNTS_PORT;

		const webProxy = await spawnReady(process.execPath, [join(FAST, "tcpproxy.mjs"), "--listen", String(WEB_PROXY.listen), "--target", `127.0.0.1:${workerPort}`, "--control", String(WEB_PROXY.control)], "proxy web-worker");
		owned.pids.push(webProxy.child.pid);
		const net = join(scratch, "net");
		mkdirSync(net);
		const sock = (host, what) => join(net, `${host}-${what}.sock`);
		const outside = await spawnReady(process.execPath, [join(FAST, "lib", "fwd.mjs"), ...["a", "b"].flatMap((h) => [
			"--map", `unix:${sock(h, "worker")}=tcp:${workerPort}`, "--map", `unix:${sock(h, "s3")}=tcp:${standinPort}`])], "fwd (outside)");
		owned.pids.push(outside.child.pid);

		const browser = await signIn(server, EMAIL);
		const a = new Machine("a", { cli: src.cli, scratch, server });
		const b = new Machine("b", { cli: src.cli, scratch, server });
		const c = new Machine("web", { cli: src.cli, scratch, server });
		for (const m of [a, b, c]) await login(m, browser);
		a.must(["init", "--project", PROJECT, "--dir", a.folder]);
		writeFileSync(join(a.folder, "README.txt"), "folder-sync's fast bench (bench/fast/demo/hero.mjs) writes its demo files here.\n");
		a.must(["sync", "--once", "--dir", a.folder]);
		const webBase = `http://127.0.0.1:${WEB_PROXY.listen}`;
		const warm = await webPut(webBase, c.token(), "setup/hello-from-web.txt", Buffer.from(`hello from the web host, ${new Date().toISOString()}\n`));
		const webHost = warm.host;
		b.must(["init", "--project", PROJECT, "--dir", b.folder]);
		b.must(["sync", "--once", "--discover", "--dir", b.folder]);
		a.must(["sync", "--once", "--discover", "--dir", a.folder]);
		const intervalMs = a.intervalMs();

		for (const m of [a, b]) {
			const inside = await spawnReady("unshare", ["-rn", "sh", "-c", `ip link set lo up && exec "$0" "$@"`, process.execPath, join(HERE, "nshost.mjs"),
				"--pass", `${workerPort}:${NS_VIA.worker}`, "--pass", `${standinPort}:${NS_VIA.s3}`,
				"--map", `tcp:${NS_VIA.worker}=unix:${sock(m.name, "worker")}`, "--map", `tcp:${NS_VIA.s3}=unix:${sock(m.name, "s3")}`], `nshost ${m.name}`);
			owned.pids.push(inside.info.fwd_pid, inside.child.pid);
			owned.machines.push(m);
			await m.watch(o.runId, inside.child.pid);
			log(`${m.name}: ${m.log.trim().split("\n").find((l) => /Watching /.test(l))}`);
		}
		await sleep(5000); // the first round of each (a reconcile) runs now, as in fs_bench.mjs

		const steps = schedule(o.seconds);
		const aId = a.hostId();
		const cadence = o.variant === "push" ? "a folder watcher + the folder's hub push each change (debounce 100 ms)" : `a round every ${intervalMs / 1000} s, no watcher`;
		const state = {
			aFolder: a.folder, bFolder: b.folder,
			meta: { variant: o.variant, code: src.code, cadence, env: "local-loopback (no WAN round trip)", project: PROJECT, aId, bId: b.hostId(), webHost, tStart: null },
			readouts: steps.map((s) => ({ id: s.id, kind: s.kind, label: s.label, at_ms: s.at_ms, t_write: null, status: "pending", ms: null, first_ms: null, put_ms: null, timeout_ms: s.kind === "burst" ? 120_000 : 60_000 })),
		};
		owned.view = await viewer(state);
		owned.tab = await chrome(join(scratch, "chrome"));
		await owned.tab.call("Page.navigate", { url: `http://127.0.0.1:${VIEWER_PORT}/` });
		const readyUntil = Date.now() + 15_000;
		while (!(await owned.tab.call("Runtime.evaluate", { expression: "window.__ready === true", returnByValue: true })).result.value) {
			if (Date.now() > readyUntil) throw new Error(`the viewer page never drew: ${owned.tab.log().slice(-500)}`);
			await sleep(100);
		}

		let finished;
		const allMeasured = new Promise((r) => { finished = r; });
		owned.worker = new Worker(join(HERE, "scenario.mjs"), { workerData: { steps, aFolder: a.folder, bFolder: b.folder, aId, webHost, webBase, project: PROJECT, token: c.token() } });
		owned.worker.on("error", (e) => { log(`scenario: ${e.stack || e}`); finished(); });
		owned.worker.on("message", (m) => {
			if (m.type === "finished") return finished();
			const r = state.readouts.find((x) => x.id === m.id);
			if (m.type === "wrote") Object.assign(r, { t_write: m.t_write, status: "measuring" });
			else Object.assign(r, { status: m.status, ms: m.ms ?? null, first_ms: m.first_ms ?? null, put_ms: m.put_ms ?? null, lost: m.lost, bytes: m.bytes, note: m.note ?? null, t_arrived: now() });
			owned.view.push();
			if (m.type === "arrived") log(`${m.id}: ${m.status} ${m.ms != null ? Math.round(m.ms) : "-"} ms`);
		});
		const load1 = Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
		const tStart = now();
		state.meta.tStart = tStart;
		owned.view.push();
		owned.worker.postMessage({ tStart });
		const tEnd = tStart + o.seconds * 1000;
		const frames = await capture(owned.tab, join(scratch, "frames"), tEnd);
		log(`captured ${frames.length} frames in ${((now() - tStart) / 1000).toFixed(1)} s; waiting for every readout`);
		await allMeasured;

		encode(frames, tEnd, o.out, o.gif, scratch);
		const r0 = (x) => (typeof x === "number" ? Math.round(x) : x);
		const report = {
			schema: "fast-folder-sync-hero/1", run_id: o.runId, tool: "folder-sync", variant: o.variant, code: src.code, interval_ms: intervalMs,
			env: "local-loopback", real: true, t: new Date(tStart).toISOString(), load1, nice: getPriority(),
			video: { mp4: o.out, gif: o.gif, seconds: o.seconds, fps: FPS, frames: frames.length, size: SIZE },
			readouts: state.readouts.map((r) => ({
				id: r.id, kind: r.kind, direction: r.kind === "web" ? "w2m" : "m2m", workload: r.kind === "burst" ? "many100" : "1k", label: r.label,
				t_write_s: r.t_write != null ? Math.round((r.t_write - tStart) / 10) / 100 : null, status: r.status, ms: r0(r.ms), first_ms: r0(r.first_ms), put_ms: r0(r.put_ms),
				bytes: r.bytes ?? null, lost: r.lost ?? null, in_video: r.t_arrived != null && r.t_arrived <= tEnd, note: r.note ?? null,
			})),
			note: "each ms is measured as bench/fast/fs_bench.mjs measures m2m and w2m: the clock starts just before the write and stops when the reader's disk holds the same sha256, polled every 10 ms; in_video: the number was on screen before the recording ended",
		};
		writeFileSync(o.json, `${JSON.stringify(report, null, 1)}\n`);
		for (const m of [a, b]) if (m.daemon.exitCode !== null) log(`${m.name}: sync --watch exited ${m.daemon.exitCode} during the recording: ${m.log.trim().split("\n").slice(-5).join(" · ")}`);
		return report;
	} finally {
		if (!interrupted) await teardown();
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	let code = 0;
	try {
		const report = await record(options(process.argv.slice(2)));
		console.log(JSON.stringify(report));
	} catch (error) {
		console.error(`hero: ${error instanceof Error ? error.stack || error.message : error}`);
		code = 1;
	}
	process.exit(code);
}
