#!/usr/bin/env node
// The folder-sync side of the Fast Folder Sync bench (bench/fast/CONTRACT.md, the frozen ruler): two machines, a web
// host and an agent on one loopback stack, every host's traffic through its own bench/fast/tcpproxy.mjs, and one
// fast-folder-sync-trial/1 row per trial. A black box like bench/latency/bench.mjs: it drives the CLI as a person runs
// it (`login`, `init`, `sync --watch`) and watches only what a person would see.
//
//   node bench/fast/fs_bench.mjs run --variant poll|push [--config k=v,...] [--directions m2m,m2w,w2m,m2a,offline]
//        [--workloads 1k,100k,10m,200m,many100,storm] [--faults drop,sleep] [--trials N] [--run-id ID] [--idle-s 120]
//
// Variants (each built from a `git archive` export of the main checkout's ref, never inside a worktree):
// - poll: claude/folder-sync-v0, the deployed engine: a round every `interval` (.folder-sync.toml, 10 s by default).
// - push: lane/fast-sync, PEP 0005: a folder watcher and the folder's Durable Object hub start a round at once.
// --config: interval=2s (both; written into each machine's .folder-sync.toml after init, at least 1s), and for push
// debounce=25ms, fallback=60s, discover_every=5m (bench/fast/patches/fast-sync-tunables.patch is then applied to
// the export and FOLDER_SYNC_DEBOUNCE / _FALLBACK / _DISCOVER_EVERY set; unpatched without them).
//
// Hosts: machines A and B (separate HOMEs, the same test person, the same project, each `sync --watch` in its own
// `systemd-run --user --scope` for its CPU and in its own network namespace for its network), the web host (PUT and
// GET through /fs/ by a third machine's bearer, from this process), and an agent (a fresh `curl` per attempt with that
// bearer). Rows go to bench/fast/results/raw/<run_id>.jsonl, .idle.jsonl and .ops.jsonl. How the network is wired
// and what each number means: bench/fast/README-folder-sync.md.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, closeSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { proxyControl } from "./tcpproxy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = "/home/bam/folder-sync"; // the refs are exported from here; nothing is built in any checkout
const RCLONE = join(MAIN, ".tools", "rclone");
// WHY poll is a pinned commit: claude/folder-sync-v0 took the push merge (99560d9, 2026-10-28 15:11) after the bench
// was specified; its first parent, 0db76d4, is the last polling-only v0 (no watcher, no hub), the engine "poll" means
// WHY head: claude/folder-sync-v0 took the push merge (99560d9) and PEP 0007 history on 2026-10-28; "head" measures what
// is on the deployed branch now (push + history), untuned, so a regression from history writes shows up beside "push"
const REFS = { poll: "0db76d4be572e92f76ed9017edb4779395aa4fe9", push: "lane/fast-sync", head: "claude/folder-sync-v0" };
const REF_LABELS = { poll: "claude/folder-sync-v0^1", push: "lane/fast-sync", head: "claude/folder-sync-v0" };
const PATCH = join(HERE, "patches", "fast-sync-tunables.patch");
const CACHE = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "folder-sync-bench");
const OUT = join(HERE, "results", "raw");
const PROJECT = "fast-bench";
const EMAIL = "fast-bench@example.com";
// CONTRACT.md "Ports": the folder-sync harness owns 127.0.0.1:5100-5139
const STACK_PORTS = { FS_STANDIN_PORT: 5100, FS_STORE_PORT: 5101, FS_ACCOUNTS_PORT: 5102, FS_INSPECTOR_PORT: 5103 };
const PROXY_PORTS = {
	a: { worker: [5110, 5111], s3: [5112, 5113] },
	b: { worker: [5114, 5115], s3: [5116, 5117] },
	web: { worker: [5120, 5121] },
	agent: { worker: [5122, 5123] },
};
const DIRECTIONS = ["m2m", "m2w", "w2m", "m2a", "offline"];
const WORKLOADS = { "1k": 1024, "100k": 100 * 1024, "10m": 10 * 1024 * 1024, "200m": 200 * 1024 * 1024, many100: 1024, storm: 1024 };
const FAULTS = ["drop", "sleep"];
const TIMEOUT_MS = { "1k": 60_000, "100k": 60_000, "10m": 120_000, "200m": 300_000, many100: 120_000, storm: 60_000, offline: 180_000 };
const TUNABLES = { debounce: "FOLDER_SYNC_DEBOUNCE", fallback: "FOLDER_SYNC_FALLBACK", discover_every: "FOLDER_SYNC_DISCOVER_EVERY", backoff_max: "FOLDER_SYNC_BACKOFF_MAX" };
const DEFAULTS_MS = { debounce_ms: 100, fallback_ms: 60_000, discover_every_ms: 300_000, backoff_max_ms: 30_000, interval_ms: 10_000 };
const OPS_WINDOW_MS = 15_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.timeOrigin + performance.now();
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const log = (...a) => console.error(...a);

// ------------------------------------------------------------------------------------------------ options

function durationMs(text) {
	const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(String(text));
	if (!m) throw new Error(`${text}: use a Go duration like 25ms, 2s, 5m`);
	return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2]];
}

function list(text, allowed, what) {
	const items = text.split(",").map((s) => s.trim()).filter(Boolean);
	for (const item of items) if (!allowed.includes(item)) throw new Error(`${what} ${item}: one of ${allowed.join(", ")}`);
	return items;
}

function options(argv) {
	const o = { verb: argv[0], variant: null, config: {}, directions: DIRECTIONS, workloads: Object.keys(WORKLOADS), faults: FAULTS, trials: 10, runId: null, idleS: 120 };
	for (let i = 1; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
			return argv[++i];
		};
		if (a === "--variant") o.variant = next();
		else if (a === "--config") {
			for (const pair of next().split(",").filter(Boolean)) {
				const [k, v] = pair.split("=");
				o.config[k.trim()] = (v || "").trim();
			}
		} else if (a === "--directions") o.directions = list(next(), DIRECTIONS, "direction");
		else if (a === "--workloads") o.workloads = list(next(), Object.keys(WORKLOADS), "workload");
		else if (a === "--faults") o.faults = list(next(), FAULTS, "fault");
		else if (a === "--trials") o.trials = Number(next());
		else if (a === "--run-id") o.runId = next();
		else if (a === "--idle-s") o.idleS = Number(next());
		else throw new Error(`unknown argument ${a}`);
	}
	if (o.verb !== "run") throw new Error("usage: node bench/fast/fs_bench.mjs run --variant poll|push [options]");
	if (!REFS[o.variant]) throw new Error("--variant is poll, push or head");
	if (!Number.isInteger(o.trials) || o.trials < 1) throw new Error("--trials is a positive integer");
	if (!(o.idleS >= 0)) throw new Error("--idle-s is a number of seconds");
	for (const [k, v] of Object.entries(o.config)) {
		if (k === "transfers") {
			// WHY refused, not ignored: neither ref passes --transfers/--checkers to rclone (internal/rclone strips every
			// RCLONE_* variable too), so the patch has nothing to override and a row must never claim a setting it lacked
			throw new Error("transfers: neither ref invokes rclone with --transfers/--checkers, so there is nothing to tune (rclone's default, 4, is in force)");
		}
		if (k === "interval") {
			if (durationMs(v) < 1000) throw new Error("interval: folder-sync's config refuses less than 1s");
		} else if (TUNABLES[k]) {
			if (o.variant !== "push") throw new Error(`${k} is a push (lane/fast-sync) tunable`);
			durationMs(v);
		} else throw new Error(`--config ${k}: one of interval, ${Object.keys(TUNABLES).join(", ")}`);
	}
	o.runId ||= `fs-${o.variant}-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
	if (!/^[A-Za-z0-9_.-]+$/.test(o.runId)) throw new Error("--run-id: letters, digits, '.', '_' and '-' only");
	return o;
}

/** The tunables in force, in ms, as each row's `config` carries them. */
function configOf(o, code) {
	const c = { code, interval_ms: o.config.interval ? durationMs(o.config.interval) : DEFAULTS_MS.interval_ms, discover_every_ms: o.config.discover_every ? durationMs(o.config.discover_every) : DEFAULTS_MS.discover_every_ms };
	if (o.variant !== "poll") {
		c.backoff_max_ms = o.config.backoff_max ? durationMs(o.config.backoff_max) : DEFAULTS_MS.backoff_max_ms;
		c.debounce_ms = o.config.debounce ? durationMs(o.config.debounce) : DEFAULTS_MS.debounce_ms;
		c.fallback_ms = o.config.fallback ? durationMs(o.config.fallback) : DEFAULTS_MS.fallback_ms;
		c.patched = Object.keys(TUNABLES).some((k) => o.config[k]);
	}
	return c;
}

// ------------------------------------------------------------------------------------------------ the source

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

/** accounts/node_modules for a lockfile: `npm ci` once into the cache, shared by every export with that lockfile. */
function nodeModules(accounts) {
	const lock = readFileSync(join(accounts, "package-lock.json"));
	const dir = join(CACHE, `node_modules-${sha256(lock).slice(0, 12)}`);
	if (!existsSync(join(dir, ".ready"))) {
		mkdirSync(dir, { recursive: true });
		copyFileSync(join(accounts, "package.json"), join(dir, "package.json"));
		copyFileSync(join(accounts, "package-lock.json"), join(dir, "package-lock.json"));
		log(`npm ci into ${dir}`);
		const done = spawnSync("npm", ["ci", "--no-audit", "--no-fund", "--registry", "https://registry.npmjs.org/"], { cwd: dir, encoding: "utf8", maxBuffer: 64 << 20 });
		if (done.status === 0) writeFileSync(join(dir, ".ready"), "");
		else {
			// the fallback the bench's brief allows: the fast-sync lane's (read-only use; nothing here writes into it)
			const lane = join(MAIN, ".claude", "worktrees", "lane-fast-sync", "accounts", "node_modules");
			log(`npm ci failed (${(done.stderr || "").trim().split("\n").slice(-1)[0]}); using ${lane}`);
			return lane;
		}
	}
	return join(dir, "node_modules");
}

/** An export of the variant's ref, built: {dir, cli, code}. Cached by commit (and patch) in ~/.cache/folder-sync-bench. */
function prepare(o) {
	const ref = REFS[o.variant];
	const sha = must("git", ["-C", MAIN, "rev-parse", "--short=12", ref]).trim();
	const patched = o.variant === "push" && Object.keys(TUNABLES).some((k) => o.config[k]);
	const tag = patched ? `-p${sha256(readFileSync(PATCH)).slice(0, 8)}` : "";
	const dir = join(CACHE, `${o.variant}-${sha}${tag}`);
	const code = `${REF_LABELS[o.variant]}@${sha}${patched ? "+tunables.patch" : ""}`;
	if (!existsSync(join(dir, ".ready"))) {
		const tmp = `${dir}.tmp-${process.pid}`;
		mkdirSync(tmp, { recursive: true });
		log(`export ${ref} (${sha}) to ${dir}`);
		must("sh", ["-c", `git -C "$1" archive "$2" | tar -x -C "$3"`, "sh", MAIN, ref, tmp]);
		if (patched) must("git", ["apply", PATCH], { cwd: tmp });
		must(goBin(), ["-C", tmp, "build", "-ldflags", `-X main.version=bench-${sha}`, "-o", join(tmp, ".bench-bin", "folder-sync"), "./cmd/folder-sync"]);
		symlinkSync(nodeModules(join(tmp, "accounts")), join(tmp, "accounts", "node_modules"));
		renameSync(tmp, dir);
		writeFileSync(join(dir, ".ready"), `${code}\n`);
	}
	return { dir, cli: join(dir, ".bench-bin", "folder-sync"), code };
}

// ------------------------------------------------------------------------------------------------ processes

/** Spawn a helper that prints one JSON line when ready; resolve {child, info}. */
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

// ------------------------------------------------------------------------------------------------ the stack's browser

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

// ------------------------------------------------------------------------------------------------ a machine

class Machine {
	constructor(name, { cli, scratch, server, extraEnv }) {
		this.name = name;
		this.cli = cli;
		this.home = join(scratch, `home-${name}`);
		this.folder = join(this.home, PROJECT);
		mkdirSync(this.folder, { recursive: true });
		// WHY a bare PATH and HOME: the machine is a fresh computer with only folder-sync on it, nothing of this one's
		this.env = { PATH: "/usr/bin:/bin", HOME: this.home, USERPROFILE: this.home, LANG: "C.UTF-8", FOLDER_SYNC_SERVER: server, FOLDER_SYNC_RCLONE: RCLONE, ...extraEnv };
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

	setInterval(text) {
		const path = join(this.folder, ".folder-sync.toml");
		const toml = readFileSync(path, "utf8");
		if (!/^\s*interval\s*=/m.test(toml)) throw new Error(`${path} names no interval`);
		writeFileSync(path, toml.replace(/^(\s*interval\s*=\s*)"[^"]*"/m, `$1"${text}"`));
	}

	intervalMs() {
		const m = /^\s*interval\s*=\s*"([^"]+)"/m.exec(readFileSync(join(this.folder, ".folder-sync.toml"), "utf8"));
		return m ? durationMs(m[1]) : DEFAULTS_MS.interval_ms;
	}

	/** Files kept as conflict copies on this machine (~/.folder-sync/conflicts, recursively). */
	conflicts() {
		const count = (dir) => {
			let n = 0;
			let entries = [];
			try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
			for (const e of entries) n += e.isDirectory() ? count(join(dir, e.name)) : 1;
			return n;
		};
		return count(join(this.home, ".folder-sync", "conflicts"));
	}

	/**
	 * `sync --watch` in its own network namespace (lib/fwd.mjs holds it: 127.0.0.1:<Worker> and 127.0.0.1:<S3> there
	 * are pipes into this machine's proxies) and its own scope (MemoryMax=4G) so its CPU is its cgroup's.
	 */
	async watch(runId, nsPid) {
		this.unit = `fsbench-${runId}-${this.name}`.replace(/[^A-Za-z0-9_.-]/g, "-");
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

	cpuUsec() {
		const m = /^usage_usec (\d+)$/m.exec(readFileSync(join(this.cgroup, "cpu.stat"), "utf8"));
		return Number(m[1]);
	}

	/** {pid: voluntary + involuntary context switches over its threads}, for every process in the scope now. */
	switches() {
		const out = {};
		for (const pid of this.pids()) {
			let n = 0;
			try {
				for (const task of readdirSync(`/proc/${pid}/task`)) {
					const s = readFileSync(`/proc/${pid}/task/${task}/status`, "utf8");
					n += Number(/^voluntary_ctxt_switches:\s+(\d+)/m.exec(s)?.[1] || 0) + Number(/^nonvoluntary_ctxt_switches:\s+(\d+)/m.exec(s)?.[1] || 0);
				}
			} catch { continue; }
			out[pid] = n;
		}
		return out;
	}

	/** SIGSTOP (or SIGCONT) every process in the scope; twice, so a child forked during the first sweep is caught. */
	signalAll(sig) {
		for (let sweep = 0; sweep < 2; sweep++) {
			for (const pid of this.pids()) try { process.kill(pid, sig); } catch { /* gone */ }
		}
	}

	async stop() {
		if (!this.pid) return;
		this.signalAll("SIGCONT");
		await stopPid(this.pid);
		// rclone children left behind are this scope's, so this run's: stop them by the pids the scope lists
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

// ------------------------------------------------------------------------------------------------ the web and the agent

class Online {
	constructor(base, token) {
		this.base = base;
		this.auth = { Authorization: `Bearer ${token}` };
	}

	url(path) {
		return `${this.base}/fs/v1/folders/${PROJECT}${path}`;
	}

	async put(rel, body) {
		const answer = await fetch(this.url(`/web/${rel}`), { method: "PUT", body, headers: { ...this.auth, "Content-Type": "application/octet-stream" } });
		const text = await answer.text();
		if (answer.status !== 200) throw new Error(`PUT web/${rel}: ${answer.status} ${text.slice(0, 200)}`);
		return JSON.parse(text);
	}

	async read(host, rel) {
		try {
			const answer = await fetch(this.url(`/files/${host}/${rel}`), { headers: this.auth });
			const bytes = Buffer.from(await answer.arrayBuffer());
			return answer.status === 200 ? bytes : null;
		} catch {
			return null; // a dropped connection is "not yet"
		}
	}
}

/** The agent: no daemon, no folder; each attempt is one fresh `curl` reading every pending file through /fs/. */
class Agent {
	constructor(base, token, dir) {
		this.base = base;
		this.dir = dir;
		mkdirSync(dir, { recursive: true });
		this.header = join(dir, "auth.header");
		writeFileSync(this.header, `Authorization: Bearer ${token}\n`, { mode: 0o600 }); // never in argv (ps)
	}

	/** One fresh process; resolves {i: bytes} for each rel that answered 2xx, and the wall time of the process. */
	attempt(host, rels) {
		const args = ["-sS", "-f", "--parallel", "--parallel-max", "16", "-H", `@${this.header}`];
		const outs = rels.map((rel, i) => join(this.dir, `out-${i}`));
		for (const [i, rel] of rels.entries()) {
			rmSync(outs[i], { force: true });
			args.push("-o", outs[i], `${this.base}/fs/v1/folders/${PROJECT}/files/${host}/${rel}`);
		}
		const t0 = now();
		return new Promise((done) => {
			const child = spawn("curl", args, { stdio: "ignore" });
			child.on("exit", () => {
				const got = {};
				for (const [i, path] of outs.entries()) if (existsSync(path)) got[i] = readFileSync(path);
				done({ got, ms: now() - t0 });
			});
		});
	}
}

// ------------------------------------------------------------------------------------------------ the counters

/** Bytes, stand-in requests and Worker requests since a mark. */
class Counters {
	constructor(stack, machines, proxies) {
		this.gateLog = join(stack.stateDir, "gate.jsonl");
		this.workerLog = join(stack.stateDir, "accounts.log");
		this.machines = machines;
		this.proxies = proxies;
	}

	size(path) {
		try { return statSync(path).size; } catch { return 0; }
	}

	tail(path, from) {
		const to = this.size(path);
		if (to <= from) return "";
		const fd = openSync(path, "r");
		const buf = Buffer.alloc(to - from);
		readSync(fd, buf, 0, buf.length, from);
		closeSync(fd);
		return buf.toString("utf8");
	}

	async mark() {
		for (const p of Object.values(this.proxies)) await proxyControl.reset(p.control);
		return { t: now(), gate: this.size(this.gateLog), worker: this.size(this.workerLog) };
	}

	async read(mark) {
		const seconds = (now() - mark.t) / 1000;
		const bytes = {};
		for (const [name, p] of Object.entries(this.proxies)) {
			const s = await proxyControl.stats(p.control);
			bytes[name] = s.bytes_in + s.bytes_out;
		}
		// WHY totals only: every temporary key the Worker vends carries the parent's access key id (the session token
		// is what differs), so the stand-in's log cannot say which machine (or the web host) made a request
		const s3 = { class_a: 0, class_b: 0, free: 0 };
		for (const line of this.tail(this.gateLog, mark.gate).split("\n")) {
			if (!line.trim()) continue;
			let e;
			try { e = JSON.parse(line); } catch { continue; }
			s3[classOf(e.op)]++;
		}
		// wrangler dev logs one line per request it answers: "[wrangler:info] GET /fs/... 200 OK (12ms)"
		const workerLines = this.tail(this.workerLog, mark.worker).split("\n").filter((l) => /\b(GET|PUT|POST|DELETE|HEAD|PATCH|OPTIONS) \/\S* \d{3}\b/.test(l));
		return { seconds, bytes, s3, worker: workerLines.length, workerLines };
	}
}

/** R2's billing classes (CONTRACT.md): A = writes and lists, B = reads; deletes are free. */
function classOf(op) {
	if (["GetObject", "HeadObject", "HeadBucket"].includes(op)) return "class_b";
	if (["DeleteObject", "AbortMultipartUpload"].includes(op)) return "free";
	return "class_a"; // PutObject, CopyObject, *Multipart*, UploadPart*, List*, DeleteObjects (a POST), GetBucketLocation (a bucket-level GET)
}

// ------------------------------------------------------------------------------------------------ trials

function content(workload, tag) {
	const size = WORKLOADS[workload];
	if (workload === "1k" || workload === "many100" || workload === "storm") {
		const head = JSON.stringify({ tag, t: new Date().toISOString(), pad: "" });
		const pad = randomBytes(size).toString("hex").slice(0, size - head.length);
		return Buffer.from(JSON.stringify({ tag, t: new Date().toISOString(), pad }));
	}
	return randomBytes(size);
}

function writeLocal(folder, rel, bytes) {
	const target = join(folder, rel);
	mkdirSync(dirname(target), { recursive: true });
	// WHY write-then-rename: an editor's save (CONTRACT.md); the watcher ignores the `~` temp name
	writeFileSync(`${target}.tmp~`, bytes);
	renameSync(`${target}.tmp~`, target);
}

/** A disk reader: does path hold want? Hashes only when size matches and the file changed since the last look. */
function diskReader() {
	const seen = new Map();
	return (path, want) => {
		let st;
		try { st = statSync(path); } catch { return false; }
		if (st.size !== want.bytes.length) return false;
		const key = `${st.ino}:${st.mtimeMs}:${st.size}`;
		const cached = seen.get(path);
		if (cached && cached.key === key && cached.sha === want.sha) return cached.ok;
		let ok = false;
		try { ok = sha256(readFileSync(path)) === want.sha; } catch { ok = false; }
		seen.set(path, { key, sha: want.sha, ok });
		return ok;
	};
}

/**
 * Poll every `period` ms until every item is held; item i is `check(i)` (sync or async). Returns
 * {first, last, held} in ms after t0 (null when never).
 */
async function pollAll(n, check, t0, timeoutMs, period, { sequential = false } = {}) {
	const held = new Array(n).fill(null);
	let pending = [...Array(n).keys()];
	const deadline = t0 + timeoutMs;
	while (pending.length && now() < deadline) {
		const started = now();
		const still = [];
		for (const i of pending) {
			if (await check(i)) held[i] = now() - t0;
			else {
				still.push(i);
				if (sequential) {
					still.push(...pending.slice(pending.indexOf(i) + 1));
					break;
				}
			}
		}
		pending = still;
		if (pending.length) await sleep(Math.max(0, period - (now() - started)));
	}
	const times = held.filter((x) => x !== null);
	return { first: times.length ? Math.min(...times) : null, last: pending.length ? null : Math.max(...times), held };
}

class Bench {
	constructor(o, ctx) {
		Object.assign(this, ctx);
		this.o = o;
		this.rows = [];
		this.disk = diskReader();
		this.seq = 0;
	}

	row(fields) {
		const r = {
			schema: "fast-folder-sync-trial/1", run_id: this.o.runId, tool: "folder-sync", variant: this.o.variant, config: this.config,
			direction: null, workload: null, fault: null, trial: null, status: "ok", ms: null, first_ms: null, put_ms: null,
			cold_read_ms: null, bytes: null, sha256_ok: false, conflicts: 0, lost: 0, real: true, env: "local-loopback",
			load1: null, t: null, note: null, ...fields,
		};
		for (const k of ["ms", "first_ms", "put_ms", "cold_read_ms"]) if (typeof r[k] === "number") r[k] = Math.round(r[k]);
		appendFileSync(this.trialsFile, `${JSON.stringify(r)}\n`);
		this.rows.push(r);
		log(`${r.direction} ${r.workload}${r.fault ? `/${r.fault}` : ""} #${r.trial}: ${r.status} ${r.ms ?? "-"} ms${r.first_ms !== null ? ` (first ${r.first_ms})` : ""}${r.conflicts ? ` conflicts ${r.conflicts}` : ""}${r.note ? ` · ${r.note}` : ""}`);
	}

	conflictsNow() {
		return { a: this.a.conflicts(), b: this.b.conflicts() };
	}

	/** New conflict copies since `before`: {n, note} (CONTRACT.md: any conflict copy is a correctness failure). */
	conflictsSince(before) {
		const after = this.conflictsNow();
		const a = after.a - before.a;
		const b = after.b - before.b;
		return { n: a + b, note: a + b ? `conflict copies in ~/.folder-sync/conflicts: A ${a}, B ${b} (raw/<run_id>/<host>.log names them)` : null };
	}

	/**
	 * Hold a trial's row until the next trial writes (or the run settles), then count its conflict copies.
	 * WHY: a machine that is not the reader (B in w2m) makes its conflict copy on its own next round, after the reader
	 * already holds the bytes; counting at the match would hand it to the following trial or miss it.
	 */
	defer(fields, before, notes) {
		this.flush();
		this.pending = { fields, before, notes };
	}

	flush() {
		if (!this.pending) return;
		const { fields, before, notes } = this.pending;
		this.pending = null;
		const conflicts = this.conflictsSince(before);
		const note = [...notes, conflicts.note].filter(Boolean).join("; ") || null;
		this.row({ ...fields, conflicts: conflicts.n, note });
	}

	/** The last trial's conflict copies get one more round of every machine before they are counted. */
	async settle() {
		if (!this.pending) return;
		await sleep(this.phaseMs + 3000);
		this.flush();
	}

	/** The files a trial writes: [{rel, bytes, sha}], and for storm the 20 saves of one file. */
	plan(workload, id) {
		const ext = ["1k", "many100", "storm"].includes(workload) ? "json" : "bin";
		if (workload === "many100") return [...Array(100).keys()].map((i) => this.want(`bench/${id}/f${String(i).padStart(3, "0")}.${ext}`, content(workload, `${id}-${i}`)));
		return [this.want(`bench/${id}/data.${ext}`, content(workload, id))];
	}

	want(rel, bytes) {
		return { rel, bytes, sha: sha256(bytes) };
	}

	/** Write from A's disk (or the web for w2m) the way the workload says; returns {t0, files (the versions to wait for)}. */
	async write(direction, workload, id) {
		const put = direction === "w2m";
		const save = async (f) => (put ? this.web.put(f.rel, f.bytes) : writeLocal(this.a.folder, f.rel, f.bytes));
		if (workload === "storm") {
			let last;
			let t0;
			for (let n = 0; n < 20; n++) {
				last = this.want(`bench/${id}/storm.json`, content(workload, `${id}-save${n}`));
				t0 = now(); // the clock starts at the last save
				await save(last);
				// WHY awaited for the web: twenty overlapping PUTs to one path could land out of order, and the last
				// one sent would not be the last version; a save from disk is synchronous anyway
				if (n < 19) await sleep(Math.max(0, 50 - (now() - t0)));
			}
			return { t0, files: [last], putMs: put ? now() - t0 : null };
		}
		const files = this.plan(workload, id);
		const t0 = now();
		if (put) {
			let next = 0;
			const worker = async () => {
				while (next < files.length) await save(files[next++]);
			};
			await Promise.all([...Array(Math.min(8, files.length))].map(worker));
		} else for (const f of files) await save(f);
		return { t0, files, putMs: put ? now() - t0 : null };
	}

	async trial(direction, workload, n) {
		const id = `${this.o.runId}-${direction}-${workload}-${n}-${(this.seq++).toString(36)}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
		await sleep(200 + Math.random() * this.phaseMs);
		this.flush();
		const load1 = Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
		const t = stampOf(new Date());
		const conflicts0 = this.conflictsNow();
		const timeout = TIMEOUT_MS[workload];
		const base = { direction, workload, trial: n, load1, t, bytes: workload === "many100" ? 100 * 1024 : WORKLOADS[workload] };
		let wrote;
		try {
			wrote = await this.write(direction, workload, id);
		} catch (error) {
			return this.row({ ...base, status: "error", note: `write failed: ${String(error.message || error).slice(0, 300)}` });
		}
		const { t0, files, putMs } = wrote;
		let result;
		let cold = null;
		if (direction === "m2m" || direction === "w2m") {
			const reader = direction === "m2m" ? this.b : this.a;
			const from = direction === "m2m" ? this.aId : this.webHost;
			result = await pollAll(files.length, (i) => this.disk(join(reader.folder, "hosts", from, files[i].rel), files[i]), t0, timeout, 10);
		} else if (direction === "m2w") {
			result = await pollAll(files.length, async (i) => {
				const got = await this.web.read(this.aId, files[i].rel);
				return got !== null && got.length === files[i].bytes.length && sha256(got) === files[i].sha;
			}, t0, timeout, 25, { sequential: true });
		} else if (direction === "m2a") {
			result = await this.agentPoll(files, t0, timeout);
			if (result.last !== null) cold = (await this.agent.attempt(this.aId, files.map((f) => f.rel))).ms;
		}
		const lost = result.held.filter((x) => x === null).length;
		const notes = [];
		if (direction === "w2m" && workload === "storm") notes.push("20 PUTs, each awaited then 50 ms apart");
		if (direction === "m2a") notes.push("one fresh curl per attempt reading every pending file");
		this.defer({ ...base, status: result.last === null ? "timeout" : "ok", ms: result.last, first_ms: workload === "many100" ? result.first : null, put_ms: putMs, cold_read_ms: cold, sha256_ok: result.last !== null, lost }, conflicts0, notes);
	}

	async agentPoll(files, t0, timeoutMs) {
		const held = new Array(files.length).fill(null);
		const deadline = t0 + timeoutMs;
		while (held.includes(null) && now() < deadline) {
			const started = now();
			const pending = held.flatMap((h, i) => (h === null ? [i] : []));
			const { got } = await this.agent.attempt(this.aId, pending.map((i) => files[i].rel));
			for (const [k, i] of pending.entries()) {
				const bytes = got[k];
				if (bytes && bytes.length === files[i].bytes.length && sha256(bytes) === files[i].sha) held[i] = now() - t0;
			}
			if (held.includes(null)) await sleep(Math.max(0, 25 - (now() - started)));
		}
		const times = held.filter((x) => x !== null);
		return { first: times.length ? Math.min(...times) : null, last: held.includes(null) ? null : Math.max(...times), held };
	}

	/** CONTRACT.md "offline": B cut off (drop) or stopped (sleep) for 20 s while A writes 10 x 1 KB; clock from restore. */
	async offline(fault, n) {
		const id = `${this.o.runId}-offline-${fault}-${n}-${(this.seq++).toString(36)}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
		await sleep(200 + Math.random() * this.phaseMs);
		this.flush();
		const load1 = Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
		const t = stampOf(new Date());
		const conflicts0 = this.conflictsNow();
		const files = [...Array(10).keys()].map((i) => this.want(`bench/${id}/f${i}.json`, content("1k", `${id}-${i}`)));
		const cutAt = now();
		if (fault === "drop") for (const p of this.bProxies) await proxyControl.cut(p.control);
		else this.b.signalAll("SIGSTOP");
		let note;
		try {
			for (const [i, f] of files.entries()) {
				await sleep(Math.max(0, cutAt + i * 2000 - now()));
				writeLocal(this.a.folder, f.rel, f.bytes);
			}
			await sleep(Math.max(0, cutAt + 20_000 - now()));
		} finally {
			if (fault === "drop") for (const p of this.bProxies) await proxyControl.restore(p.control);
			else this.b.signalAll("SIGCONT");
		}
		const t0 = now();
		note = fault === "drop"
			? "cut: both of B's proxies (its Worker/hub path and its S3 path; B's network namespace has no other route) for 20 s; A wrote one file every 2 s"
			: "SIGSTOP of every process in B's scope for 20 s, then SIGCONT; A wrote one file every 2 s";
		const result = await pollAll(files.length, (i) => this.disk(join(this.b.folder, "hosts", this.aId, files[i].rel), files[i]), t0, TIMEOUT_MS.offline, 10);
		this.defer({ direction: "offline", workload: "1k", fault, trial: n, load1, t, bytes: 10 * 1024, status: result.last === null ? "timeout" : "ok", ms: result.last, first_ms: result.first, sha256_ok: result.last !== null, lost: result.held.filter((x) => x === null).length }, conflicts0, [note]);
	}

	/** CONTRACT.md idle row: the two machines doing nothing for idleS seconds. */
	async idle() {
		const machines = [this.a, this.b];
		await sleep(5000);
		const mark = await this.counters.mark();
		const cpu0 = Object.fromEntries(machines.map((m) => [m.name, m.cpuUsec()]));
		const sw0 = Object.fromEntries(machines.map((m) => [m.name, m.switches()]));
		const until = now() + this.o.idleS * 1000;
		await sleep(Math.max(0, until - now()));
		const c = await this.counters.read(mark);
		const minutes = c.seconds / 60;
		const per = {};
		for (const m of machines) {
			const sw1 = m.switches();
			let wake = 0;
			for (const [pid, v] of Object.entries(sw1)) wake += v - (sw0[m.name][pid] ?? 0);
			per[m.name] = {
				cpu_pct: ((m.cpuUsec() - cpu0[m.name]) / 1e6 / c.seconds) * 100,
				wakeups_per_min: wake / minutes,
				net_bytes_per_min: (c.bytes[`${m.name}-worker`] + c.bytes[`${m.name}-s3`]) / minutes,
			};
		}
		const mean = (k) => machines.reduce((s, m) => s + per[m.name][k], 0) / machines.length;
		const r1 = (x) => Math.round(x * 10) / 10;
		const r3 = (x) => Math.round(x * 1000) / 1000;
		const row = {
			schema: "fast-folder-sync-idle/1", run_id: this.o.runId, tool: "folder-sync", variant: this.o.variant, config: this.config,
			window_s: Math.round(c.seconds), hosts: machines.length, cpu_pct_per_host: r3(mean("cpu_pct")), wakeups_per_min_per_host: r1(mean("wakeups_per_min")),
			net_bytes_per_min_per_host: Math.round(mean("net_bytes_per_min")),
			requests_per_min_per_host: { class_a: r3(c.s3.class_a / machines.length / minutes), class_b: r3(c.s3.class_b / machines.length / minutes), worker: r3(c.worker / machines.length / minutes) },
			real: true, env: "local-loopback",
			note: [
				`per host: ${machines.map((m) => `${m.name.toUpperCase()} cpu ${r3(per[m.name].cpu_pct)}%, wakeups ${r1(per[m.name].wakeups_per_min)}/min, net ${Math.round(per[m.name].net_bytes_per_min)} B/min`).join("; ")}`,
				`requests = the stand-in's log (gate.jsonl: class A ${c.s3.class_a}, class B ${c.s3.class_b}, deletes ${c.s3.free}) and wrangler dev's (${c.worker} requests) over the window, / ${machines.length} hosts: neither log says which host (every vended key shares the parent's key id; a WebSocket message is not a request)`,
				"wakeups = context switches of the scope's processes alive at the end of the window; a short-lived child (each rclone run) that exited inside the window is missed, so this undercounts the poll variant most",
				`load1 at start ${readFileSync("/proc/loadavg", "utf8").split(" ")[0]}`,
			].join(" | "),
		};
		appendFileSync(this.idleFile, `${JSON.stringify(row)}\n`);
		log(`idle: ${JSON.stringify(row)}`);
		this.idleRates = { s3: c.s3, worker: c.worker, seconds: c.seconds };
		return row;
	}

	/** CONTRACT.md ops rows: the requests one change costs, over a fixed window, less the idle rate over that window. */
	async ops() {
		for (const direction of ["m2m", "w2m"]) {
			await sleep(5000);
			const mark = await this.counters.mark();
			const id = `${this.o.runId}-ops-${direction}-${(this.seq++).toString(36)}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
			const f = this.want(`bench/${id}/data.json`, content("1k", id));
			const t0 = now();
			if (direction === "m2m") writeLocal(this.a.folder, f.rel, f.bytes);
			else await this.web.put(f.rel, f.bytes);
			const reader = direction === "m2m" ? join(this.b.folder, "hosts", this.aId, f.rel) : join(this.a.folder, "hosts", this.webHost, f.rel);
			const got = await pollAll(1, () => this.disk(reader, f), t0, TIMEOUT_MS["1k"], 10);
			await sleep(Math.max(0, t0 + OPS_WINDOW_MS - now()));
			const c = await this.counters.read(mark);
			const idle = (k) => (this.idleRates ? (this.idleRates.s3[k] / this.idleRates.seconds) * c.seconds : 0);
			const idleWorker = this.idleRates ? (this.idleRates.worker / this.idleRates.seconds) * c.seconds : 0;
			const r1 = (x) => Math.round(x * 10) / 10;
			const row = {
				schema: "fast-folder-sync-ops/1", run_id: this.o.runId, tool: "folder-sync", variant: this.o.variant, config: this.config, workload: "1k", direction,
				class_a: r1(c.s3.class_a - idle("class_a")), class_b: r1(c.s3.class_b - idle("class_b")), worker: r1(c.worker - idleWorker), do_msgs: null,
				note: `${got.last === null ? "the change never arrived (timeout); " : `arrived in ${Math.round(got.last)} ms; `}counted over ${Math.round(c.seconds)} s from the write, all hosts, less the idle run's rate over the same span (raw: class_a ${c.s3.class_a}, class_b ${c.s3.class_b}, worker ${c.worker}; idle-rate share: ${r1(idle("class_a"))} / ${r1(idle("class_b"))} / ${r1(idleWorker)}${this.idleRates ? "" : " (no idle window ran, nothing subtracted)"}); deletes (free in R2) ${c.s3.free}; do_msgs not observable: the hub logs nothing and its WebSocket frames are not requests in wrangler's log`,
			};
			appendFileSync(this.opsFile, `${JSON.stringify(row)}\n`);
			log(`ops ${direction}: ${JSON.stringify(row)}`);
		}
	}
}

/** RFC 3339 with this machine's offset (bench/latency/bench.mjs's). */
function stampOf(date) {
	const off = -date.getTimezoneOffset();
	const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
	const local = new Date(date.getTime() + off * 60_000).toISOString().slice(0, 19);
	return `${local}${off >= 0 ? "+" : "-"}${pad(off / 60)}:${pad(off % 60)}`;
}

/** p-th percentile, linear between the closest ranks (numpy's default); null on no values. */
export function percentile(values, p) {
	const v = values.filter((x) => typeof x === "number").sort((a, b) => a - b);
	if (!v.length) return null;
	const rank = (p / 100) * (v.length - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	return Math.round(v[lo] + (v[hi] - v[lo]) * (rank - lo));
}

export function summarize(rows) {
	const groups = new Map();
	for (const r of rows) {
		const key = `${r.direction} ${r.workload}${r.fault ? `/${r.fault}` : ""}`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(r);
	}
	return [...groups].map(([key, rs]) => {
		const ms = rs.filter((r) => r.status === "ok").map((r) => r.ms);
		return {
			key, n: ms.length, timeouts: rs.filter((r) => r.status === "timeout").length, errors: rs.filter((r) => r.status === "error").length,
			p50: percentile(ms, 50), p95: percentile(ms, 95), first_p50: percentile(rs.map((r) => r.first_ms), 50),
			sha256_ok: rs.every((r) => r.sha256_ok), conflicts: rs.reduce((s, r) => s + r.conflicts, 0), lost: rs.reduce((s, r) => s + r.lost, 0),
		};
	});
}

// ------------------------------------------------------------------------------------------------ the run

async function run(o) {
	for (const port of [...Object.values(STACK_PORTS), ...Object.values(PROXY_PORTS).flatMap((h) => Object.values(h).flat())]) {
		if (port < 5100 || port > 5139) throw new Error(`port ${port} is outside the harness's 5100-5139`);
		if (!free(port)) throw new Error(`port ${port} is taken; another bench run (or a peer) holds it`);
	}
	if (!existsSync(RCLONE)) throw new Error(`no rclone at ${RCLONE}`);
	const src = prepare(o);
	const config = configOf(o, src.code);
	mkdirSync(OUT, { recursive: true });
	const files = { trialsFile: join(OUT, `${o.runId}.jsonl`), idleFile: join(OUT, `${o.runId}.idle.jsonl`), opsFile: join(OUT, `${o.runId}.ops.jsonl`) };
	const scratch = mkdtempSync(join(process.env.FSBENCH_TMP || tmpdir(), "fsbench-"));
	const owned = { pids: [], machines: [], stateDir: null, dev: null };
	const teardown = async () => {
		for (const m of owned.machines) await m.stop().catch(() => {});
		// the raw evidence next to the rows (gitignored): the stand-in's request log, wrangler's, each daemon's output
		const evidence = join(OUT, o.runId);
		mkdirSync(evidence, { recursive: true });
		if (owned.stateDir) for (const [from, to] of [["gate.jsonl", "gate.jsonl"], ["accounts.log", "worker.log"]]) try { copyFileSync(join(owned.stateDir, from), join(evidence, to)); } catch { /* none */ }
		for (const m of owned.machines) writeFileSync(join(evidence, `${m.name}.log`), m.log);
		for (const pid of owned.pids.reverse()) await stopPid(pid, 3000);
		if (owned.dev && owned.stateDir) try { owned.dev.down(owned.stateDir); } catch { /* stopped */ }
		rmSync(scratch, { recursive: true, force: true });
	};
	let interrupted = false;
	const onSignal = (sig) => {
		if (interrupted) return;
		interrupted = true;
		log(`${sig}: stopping everything this run started`);
		teardown().finally(() => process.exit(130));
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	try {
		// the stack, from the export's own dev.mjs (rclone serve s3, the R2 stand-in, wrangler dev)
		owned.dev = await import(join(src.dir, "accounts", "scripts", "dev.mjs"));
		owned.stateDir = join(scratch, "stack");
		const env = { ...process.env, ...Object.fromEntries(Object.entries(STACK_PORTS).map(([k, v]) => [k, String(v)])), RCLONE, GO: goBin() };
		log(`stack up (${src.code})`);
		const stack = await owned.dev.up(owned.stateDir, env);
		const server = stack.accounts; // http://127.0.0.1:5102: every machine's FOLDER_SYNC_SERVER, inside its namespace too
		const standinPort = Number(new URL(stack.endpoint).port);
		const workerPort = STACK_PORTS.FS_ACCOUNTS_PORT;

		// one tcpproxy per host and target (CONTRACT.md: hosts reach the store and each other only through it)
		const proxies = {};
		for (const [host, targets] of Object.entries(PROXY_PORTS)) {
			for (const [what, [listen, control]] of Object.entries(targets)) {
				const target = what === "worker" ? workerPort : standinPort;
				const { child } = await spawnReady(process.execPath, [join(HERE, "tcpproxy.mjs"), "--listen", String(listen), "--target", `127.0.0.1:${target}`, "--control", String(control)], `proxy ${host}-${what}`);
				owned.pids.push(child.pid);
				proxies[`${host}-${what}`] = { listen, control, pid: child.pid };
			}
		}
		// the outside half of each machine's pipe: unix socket -> its proxies
		const net = join(scratch, "net");
		mkdirSync(net);
		const sock = (host, what) => join(net, `${host}-${what}.sock`);
		const outside = await spawnReady(process.execPath, [join(HERE, "lib", "fwd.mjs"), ...["a", "b"].flatMap((h) => ["worker", "s3"].flatMap((w) => ["--map", `unix:${sock(h, w)}=tcp:${proxies[`${h}-${w}`].listen}`]))], "fwd (outside)");
		owned.pids.push(outside.child.pid);

		// the test person and three machines (set-up runs outside the namespaces, straight to the stack: never timed)
		const extraEnv = {};
		if (o.variant === "push") for (const [k, name] of Object.entries(TUNABLES)) if (o.config[k]) extraEnv[name] = o.config[k];
		const browser = await signIn(server, EMAIL);
		const a = new Machine("a", { cli: src.cli, scratch, server, extraEnv });
		const b = new Machine("b", { cli: src.cli, scratch, server, extraEnv });
		const c = new Machine("agent", { cli: src.cli, scratch, server, extraEnv });
		for (const m of [a, b, c]) await login(m, browser);
		a.must(["init", "--project", PROJECT, "--dir", a.folder]);
		// WHY a file that stays: folder-sync's empty-folder guard refuses a round that would leave the folder empty
		writeFileSync(join(a.folder, "README.txt"), "folder-sync's fast bench (bench/fast/fs_bench.mjs) writes its trial files here.\n");
		a.must(["sync", "--once", "--dir", a.folder]);
		const web = new Online(`http://127.0.0.1:${proxies["web-worker"].listen}`, c.token());
		const warm = await web.put("bench/warmup.txt", Buffer.from(`warm ${Date.now()}\n`));
		const webHost = warm.host;
		b.must(["init", "--project", PROJECT, "--dir", b.folder]);
		b.must(["sync", "--once", "--discover", "--dir", b.folder]);
		a.must(["sync", "--once", "--discover", "--dir", a.folder]);
		if (o.config.interval) for (const m of [a, b]) m.setInterval(o.config.interval);
		config.interval_ms = a.intervalMs();
		const agent = new Agent(`http://127.0.0.1:${proxies["agent-worker"].listen}`, c.token(), join(scratch, "agent"));

		// each machine's namespace (held by the inside half of its pipe), then its daemon in its scope
		for (const m of [a, b]) {
			const inside = await spawnReady("unshare", ["-rn", "sh", "-c", `ip link set lo up && exec "$0" "$@"`, process.execPath, join(HERE, "lib", "fwd.mjs"),
				"--map", `tcp:${workerPort}=unix:${sock(m.name, "worker")}`, "--map", `tcp:${standinPort}=unix:${sock(m.name, "s3")}`], `fwd (inside ${m.name})`);
			owned.pids.push(inside.child.pid);
			owned.machines.push(m);
			await m.watch(o.runId, inside.child.pid);
			log(`${m.name}: ${m.log.trim().split("\n").find((l) => /Watching /.test(l))}`);
		}
		await sleep(5000); // the first round of each (a reconcile) runs now; trials start after it

		const bench = new Bench(o, {
			...files, config, a, b, aId: a.hostId(), webHost, web, agent, phaseMs: config.interval_ms,
			bProxies: [proxies["b-worker"], proxies["b-s3"]],
			counters: new Counters(stack, [a, b], Object.fromEntries(["a-worker", "a-s3", "b-worker", "b-s3"].map((k) => [k, proxies[k]]))),
		});
		for (const direction of o.directions) {
			if (direction === "offline") {
				for (const fault of o.faults) for (let n = 1; n <= o.trials; n++) await bench.offline(fault, n);
				continue;
			}
			for (const workload of o.workloads) {
				if (workload === "200m" && !["m2m", "m2w", "w2m"].includes(direction)) continue; // CONTRACT.md: 200m is m2m, m2w and w2m only
				for (let n = 1; n <= o.trials; n++) await bench.trial(direction, workload, n);
			}
		}
		await bench.settle();
		if (o.idleS > 0) await bench.idle();
		await bench.ops();
		for (const m of [a, b]) if (m.daemon.exitCode !== null) log(`${m.name}: sync --watch exited ${m.daemon.exitCode} during the run: ${m.log.trim().split("\n").slice(-5).join(" · ")}`);
		const summary = { run_id: o.runId, variant: o.variant, config, rows: files, summary: summarize(bench.rows) };
		writeFileSync(join(OUT, `${o.runId}.summary.json`), `${JSON.stringify(summary, null, 1)}\n`);
		return summary;
	} finally {
		if (!interrupted) await teardown();
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	let code = 0;
	try {
		const summary = await run(options(process.argv.slice(2)));
		console.log(JSON.stringify(summary));
	} catch (error) {
		console.error(`fs_bench: ${error instanceof Error ? error.stack || error.message : error}`);
		code = 1;
	}
	process.exit(code);
}
