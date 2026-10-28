#!/usr/bin/env node
// folder-sync's latency KPI: how long a file takes from a machine's disk to being served online, and from an online
// write to a machine's disk. A black box: it drives the folder-sync CLI exactly as a person runs it (`init`, then
// `sync --watch` in the background) and watches only what a person would see, so a change to the CLI or the Worker
// (PEP 0004's push sync, say) moves the number without touching this file.
//
// Zach, 2026-10-28: "Please add a KPI for the folder sync project which is tracking the time to sync from local to
// online and the time from online to local ... thats really kinda key performance indicator I want to continue to
// work on."
//
//   node bench/latency/bench.mjs run [--stack local|prod] [--trials 10] [--out DIR] [--no-kpi] [--cli PATH] [--json FILE]
//   node bench/latency/bench.mjs install-timer      the hourly local-stack run, as a systemd --user timer (idempotent)
//
// Two directions, each --trials times, each trial started at a random phase of the machine's sync interval:
// - up:   write bench/<id>.txt into the synced folder, then GET /fs/v1/folders/<project>/files/<host>/bench/<id>.txt
//         every 50 ms until it answers 200 with the same bytes: the moment a page (or anyone online) can read it.
// - down: PUT /fs/v1/folders/<project>/web/bench/<id>.txt (the web host: the call a web page makes to save), then
//         read <folder>/hosts/<web host>/bench/<id>.txt every 10 ms until it holds the same bytes.
// Both clocks start just before the write and stop when the reader holds the bytes, so each is what a person waits.
//
// --stack local (the default, and the hourly run): accounts/scripts/dev.mjs stands up the whole stack on loopback
// (rclone serve s3, the R2 stand-in, `wrangler dev` with a local D1) in a fresh temp dir, a test person signs in by
// email code, a throwaway HOME runs `folder-sync login`, and everything is stopped and deleted afterwards. Ports
// 4950-4953 unless FS_STANDIN_PORT / FS_STORE_PORT / FS_ACCOUNTS_PORT / FS_INSPECTOR_PORT say otherwise.
// --stack prod: this machine's own signed-in session (~/.folder-sync/account.json, never printed or copied) and its
// server, in one throwaway project, `bench-latency`, folder ~/.local/share/folder-sync-bench/bench-latency. It never
// touches another project. The bench files are deleted at the end (folder-sync moves them to _trash/).
//
// Out (unless --no-kpi): Vibe Tracks producer files in --out (default ~/vt/zach/producers/folder-sync): kpi_catalog.json
// (rewritten), kpi_series.jsonl and runs_table.jsonl (appended). The CLI is built from this checkout unless --cli.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const HOME = homedir();
const PROJECT = "bench-latency";
const BENCH_VERSION = "folder-sync-latency/1";
const DEFAULT_OUT = join(HOME, "vt", "zach", "producers", "folder-sync");
const PROD_FOLDER = join(HOME, ".local", "share", "folder-sync-bench", PROJECT);
const BENCH_PORTS = { FS_STANDIN_PORT: "4950", FS_STORE_PORT: "4951", FS_ACCOUNTS_PORT: "4952", FS_INSPECTOR_PORT: "4953" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.timeOrigin + performance.now();

// ------------------------------------------------------------------------------------------------ options

function options(argv) {
	const o = { verb: argv[0] || "run", stack: "local", trials: 10, out: process.env.VT_PRODUCER_DIR || DEFAULT_OUT, kpi: true, cli: null, json: null, timeoutS: 120 };
	for (let i = 1; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
			return argv[++i];
		};
		if (a === "--stack") o.stack = next();
		else if (a === "--trials") o.trials = Number(next());
		else if (a === "--out") o.out = resolve(next());
		else if (a === "--no-kpi") o.kpi = false;
		else if (a === "--cli") o.cli = resolve(next());
		else if (a === "--json") o.json = resolve(next());
		else if (a === "--timeout-s") o.timeoutS = Number(next());
		else throw new Error(`unknown argument ${a}`);
	}
	if (!["local", "prod"].includes(o.stack)) throw new Error("--stack is local or prod");
	if (!Number.isInteger(o.trials) || o.trials < 1) throw new Error("--trials is a positive integer");
	return o;
}

// ------------------------------------------------------------------------------------------------ tools

function goBin() {
	if (process.env.GO) return process.env.GO;
	const local = join(HOME, ".local", "go", "bin", "go");
	return existsSync(local) ? local : "go";
}

/** The pinned rclone: RCLONE, else this checkout's .tools/ (scripts/dev-tools), else the one `init` installed. */
function rcloneBin() {
	for (const candidate of [process.env.RCLONE, join(REPO, ".tools", "rclone"), join(HOME, ".folder-sync", "bin", "rclone")]) {
		if (candidate && existsSync(candidate)) return resolve(candidate);
	}
	throw new Error("no rclone: run scripts/dev-tools, or set RCLONE");
}

function codeSha() {
	const head = spawnSync("git", ["-C", REPO, "rev-parse", "--short=12", "HEAD"], { encoding: "utf8" });
	const sha = head.status === 0 ? head.stdout.trim() : "unknown";
	const status = spawnSync("git", ["-C", REPO, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" });
	const dirty = status.status === 0 && status.stdout.trim() !== "";
	const branch = spawnSync("git", ["-C", REPO, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
	return { sha, dirty, branch: branch.status === 0 ? branch.stdout.trim() : null };
}

function buildCli(dir, sha) {
	const bin = join(dir, "folder-sync");
	const built = spawnSync(goBin(), ["-C", REPO, "build", "-ldflags", `-X main.version=bench-${sha}`, "-o", bin, "./cmd/folder-sync"], { encoding: "utf8" });
	if (built.status !== 0) throw new Error(`folder-sync build failed: ${built.stderr || built.error}`);
	return bin;
}

// ------------------------------------------------------------------------------------------------ a machine

/** One machine: a HOME and its folder-sync. `env` is what every CLI call runs with. */
class Machine {
	constructor({ cli, home, folder, env }) {
		Object.assign(this, { cli, home, folder, env, watcher: null, log: "" });
	}

	run(args, timeout = 180_000) {
		const done = spawnSync(this.cli, args, { cwd: this.home, env: this.env, encoding: "utf8", timeout });
		return { code: done.status, out: done.stdout || "", err: done.stderr || "" };
	}

	must(args) {
		const done = this.run(args);
		if (done.code !== 0) throw new Error(`folder-sync ${args.join(" ")} exited ${done.code}: ${(done.out + done.err).trim().split("\n").slice(-3).join(" · ")}`);
		return done;
	}

	hostId() {
		return JSON.parse(readFileSync(join(this.home, ".folder-sync", "host.json"), "utf8")).id;
	}

	token() {
		return JSON.parse(readFileSync(join(this.home, ".folder-sync", "account.json"), "utf8")).token;
	}

	/** The interval `sync --watch` runs at, from the folder's .folder-sync.toml (10 s when it names none). */
	intervalMs() {
		const toml = readFileSync(join(this.folder, ".folder-sync.toml"), "utf8");
		const m = /^\s*interval\s*=\s*"(\d+(?:\.\d+)?)(ms|s|m)"/m.exec(toml);
		if (!m) return 10_000;
		return Number(m[1]) * { ms: 1, s: 1000, m: 60_000 }[m[2]];
	}

	/** `folder-sync sync --watch`, as a person leaves it running; resolves once it says it is watching. */
	async watch() {
		const child = spawn(this.cli, ["sync", "--watch", "--dir", this.folder], { cwd: this.home, env: this.env });
		this.watcher = child;
		child.stdout.on("data", (b) => { this.log += b; });
		child.stderr.on("data", (b) => { this.log += b; });
		const until = Date.now() + 60_000;
		while (!/Watching /.test(this.log)) {
			if (child.exitCode !== null) throw new Error(`sync --watch exited ${child.exitCode}: ${this.log.trim()}`);
			if (Date.now() > until) throw new Error(`sync --watch did not start: ${this.log.trim()}`);
			await sleep(50);
		}
	}

	async stop() {
		const child = this.watcher;
		if (!child || child.exitCode !== null) return;
		child.kill("SIGTERM");
		const until = Date.now() + 15_000;
		while (child.exitCode === null && child.signalCode === null && Date.now() < until) await sleep(50);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
}

// ------------------------------------------------------------------------------------------------ online

/** The online side, as a signed-in session sees it: a bearer token, never printed. */
class Online {
	constructor(server, token) {
		this.server = server.replace(/\/+$/, "");
		this.auth = { Authorization: `Bearer ${token}` };
	}

	url(path) {
		return `${this.server}/fs/v1/folders/${PROJECT}${path}`;
	}

	async put(path, body) {
		const answer = await fetch(this.url(`/web/${path}`), { method: "PUT", body, headers: { ...this.auth, "Content-Type": "text/plain" } });
		const text = await answer.text();
		if (answer.status !== 200) throw new Error(`PUT web/${path}: ${answer.status} ${text.slice(0, 200)}`);
		return JSON.parse(text);
	}

	async remove(path) {
		const answer = await fetch(this.url(`/web/${path}`), { method: "DELETE", headers: this.auth });
		await answer.arrayBuffer();
		return answer.status;
	}

	/** One read of a host's file: its bytes when it answers 200, else null. */
	async read(host, path) {
		try {
			const answer = await fetch(this.url(`/files/${host}/${path}`), { headers: this.auth });
			const bytes = Buffer.from(await answer.arrayBuffer());
			return answer.status === 200 ? bytes : null;
		} catch {
			return null; // a dropped connection is "not yet", the next poll tries again
		}
	}

	async view() {
		const answer = await fetch(this.url(""), { headers: this.auth });
		return answer.status === 200 ? answer.json() : null;
	}
}

// ------------------------------------------------------------------------------------------------ the stacks

/** A browser by hand on the local stack: just enough cookie jar to sign a test person in and approve a machine. */
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

/** `folder-sync login` on the machine, approved by the test person's browser session (the device grant). */
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
		throw new Error(`folder-sync login printed no code: ${out.trim()}`);
	}
	const userCode = found[2].replace(/[^A-Z0-9]/gi, "").toUpperCase();
	await browser.fetch(`/fs/api/auth/device?user_code=${encodeURIComponent(userCode)}`);
	const approved = await browser.write("/fs/api/auth/device/approve", { method: "POST", body: { userCode } });
	if (!approved.ok) throw new Error(`device approve: ${approved.status}`);
	const code = await Promise.race([exited, sleep(60_000).then(() => "timeout")]);
	if (code !== 0) {
		child.kill();
		throw new Error(`folder-sync login exited ${code}: ${out.trim()}`);
	}
}

async function localStack(o, sha) {
	const dev = await import(join(REPO, "accounts", "scripts", "dev.mjs"));
	const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "folder-sync-latency-"));
	const rclone = rcloneBin();
	const env = { ...process.env, ...Object.fromEntries(Object.entries(BENCH_PORTS).map(([k, v]) => [k, process.env[k] || v])), RCLONE: rclone, GO: goBin() };
	const stateDir = join(scratch, "stack");
	const stack = await dev.up(stateDir, env);
	const teardown = () => {
		try { dev.down(stateDir); } catch { /* stopped */ }
		rmSync(scratch, { recursive: true, force: true });
	};
	try {
		const cli = o.cli || buildCli(join(scratch, "bin"), sha);
		const home = join(scratch, "home");
		const folder = join(home, PROJECT);
		mkdirSync(folder, { recursive: true });
		// WHY a bare PATH and HOME: the machine is a fresh computer with only folder-sync on it, nothing of this one's
		const machine = new Machine({ cli, home, folder, env: { PATH: "/usr/bin:/bin", HOME: home, USERPROFILE: home, LANG: "C.UTF-8", FOLDER_SYNC_SERVER: stack.accounts, FOLDER_SYNC_RCLONE: rclone } });
		const browser = await signIn(stack.accounts, "bench@example.com");
		await login(machine, browser);
		machine.must(["init", "--project", PROJECT, "--dir", folder]);
		return { machine, server: stack.accounts, teardown, cleanup: async () => {} };
	} catch (error) {
		teardown();
		throw error;
	}
}

async function prodStack(o, sha) {
	const accountPath = join(HOME, ".folder-sync", "account.json");
	if (!existsSync(accountPath)) throw new Error("prod is unmeasured: this machine is not signed in (no ~/.folder-sync/account.json); run folder-sync login");
	const account = JSON.parse(readFileSync(accountPath, "utf8"));
	const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "folder-sync-latency-"));
	const cli = o.cli || buildCli(scratch, sha);
	mkdirSync(PROD_FOLDER, { recursive: true });
	const machine = new Machine({ cli, home: HOME, folder: PROD_FOLDER, env: { ...process.env } });
	if (!existsSync(join(PROD_FOLDER, ".folder-sync.toml"))) machine.must(["init", "--project", PROJECT, "--dir", PROD_FOLDER]);
	const project = readFileSync(join(PROD_FOLDER, ".folder-sync.toml"), "utf8");
	// WHY refuse: the bench deletes what it wrote; it must only ever run in its own project
	if (!new RegExp(`^\\s*project\\s*=\\s*"${PROJECT}"`, "m").test(project)) throw new Error(`${PROD_FOLDER} is not the ${PROJECT} project; refusing`);
	return { machine, server: account.server, teardown: () => rmSync(scratch, { recursive: true, force: true }), cleanup: async () => {} };
}

// ------------------------------------------------------------------------------------------------ the trials

function body(id) {
	return Buffer.from(`${id} ${new Date().toISOString()} ${randomBytes(6).toString("hex")}\n`);
}

function same(path, want) {
	try {
		return readFileSync(path).equals(want);
	} catch {
		return false;
	}
}

async function up(machine, online, host, id, timeoutMs) {
	const rel = `bench/${id}.txt`;
	const want = body(id);
	const target = join(machine.folder, "bench", `${id}.txt`);
	mkdirSync(dirname(target), { recursive: true });
	const t0 = now();
	// WHY write-then-rename: an editor's save; the watcher never sees a half-written file
	writeFileSync(`${target}.tmp~`, want);
	renameSync(`${target}.tmp~`, target);
	const deadline = t0 + timeoutMs;
	while (now() < deadline) {
		const started = now();
		const got = await online.read(host, rel);
		if (got && got.equals(want)) return { id, ms: Math.round(now() - t0), path: rel };
		await sleep(Math.max(0, 50 - (now() - started)));
	}
	return { id, ms: null, path: rel, timeout: true };
}

async function down(machine, online, webHost, id, timeoutMs) {
	const rel = `bench/${id}.txt`;
	const want = body(id);
	const target = join(machine.folder, "hosts", webHost, "bench", `${id}.txt`);
	const t0 = now();
	const put = await online.put(rel, want);
	const putMs = Math.round(now() - t0);
	const deadline = t0 + timeoutMs;
	while (now() < deadline) {
		if (same(target, want)) return { id, ms: Math.round(now() - t0), put_ms: putMs, path: rel, seq: put.seq };
		await sleep(10);
	}
	return { id, ms: null, put_ms: putMs, path: rel, timeout: true };
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

function summary(trials) {
	const ms = trials.map((t) => t.ms).filter((x) => typeof x === "number");
	return { n: ms.length, timeouts: trials.length - ms.length, p50: percentile(ms, 50), p95: percentile(ms, 95), max: ms.length ? Math.max(...ms) : null, min: ms.length ? Math.min(...ms) : null };
}

async function measure(o) {
	const code = codeSha();
	const sha = code.dirty ? `${code.sha}+dirty` : code.sha;
	const started = new Date();
	const stack = o.stack === "local" ? await localStack(o, code.sha) : await prodStack(o, code.sha);
	const { machine } = stack;
	const online = new Online(stack.server, machine.token());
	const result = { stack: o.stack, server: stack.server, code: { ...code, label: sha }, started: started.toISOString(), up: [], down: [] };
	try {
		const host = machine.hostId();
		// WHY a file that stays: deleting every bench file would leave the folder empty, and folder-sync's
		// empty-folder guard (rightly) refuses to push a round that deletes everything, so the tidy would never land
		const keep = join(machine.folder, "README.txt");
		if (!existsSync(keep)) writeFileSync(keep, "folder-sync's latency bench (bench/latency/bench.mjs) writes and deletes its trial files here.\n");
		// Set-up, never timed: the web host exists and this machine knows it (else the first down trial would wait
		// for host discovery, every 5 min, which is the "new machine" path, not this one)
		const warm = `warmup-${Date.now()}`;
		const made = await online.put(`bench/${warm}.txt`, body(warm));
		const webHost = made.host;
		machine.must(["sync", "--once", "--discover", "--dir", machine.folder]);
		await machine.watch();
		const interval = machine.intervalMs();
		result.interval_ms = interval;
		result.web_host = webHost;
		await sleep(1500); // its first round (a reconcile) runs now; trials start after it
		const stamp = Date.now().toString(36);
		for (let n = 0; n < o.trials; n++) {
			// WHY a random wait across a whole interval: a trial started at one fixed phase of the round timer would
			// measure that phase, not what a person sees
			await sleep(200 + Math.random() * interval);
			const trial = await up(machine, online, host, `up-${stamp}-${n}`, o.timeoutS * 1000);
			result.up.push(trial);
			console.error(`up   ${n + 1}/${o.trials}: ${trial.ms ?? "timeout"} ms`);
		}
		for (let n = 0; n < o.trials; n++) {
			await sleep(200 + Math.random() * interval);
			const trial = await down(machine, online, webHost, `down-${stamp}-${n}`, o.timeoutS * 1000);
			result.down.push(trial);
			console.error(`down ${n + 1}/${o.trials}: ${trial.ms ?? "timeout"} ms (PUT ${trial.put_ms} ms)`);
		}
		// tidy (prod: the bench's own files only; folder-sync moves them to _trash/)
		if (o.stack === "prod") {
			for (const t of result.up) rmSync(join(machine.folder, t.path), { force: true });
			for (const t of [...result.down, { path: `bench/${warm}.txt` }]) await online.remove(t.path);
			await sleep(interval + 3000);
		}
	} finally {
		await machine.stop();
		stack.teardown();
	}
	result.finished = new Date().toISOString();
	result.summary = { up: summary(result.up), down: summary(result.down) };
	return result;
}

// ------------------------------------------------------------------------------------------------ Vibe Tracks

/** RFC 3339 with this machine's offset, as the other producers write it. */
function stampOf(date) {
	const off = -date.getTimezoneOffset();
	const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
	const local = new Date(date.getTime() + off * 60_000).toISOString().slice(0, 19);
	return `${local}${off >= 0 ? "+" : "-"}${pad(off / 60)}:${pad(off % 60)}`;
}

export function catalog(generatedAt) {
	const common = { unit: "ms", direction: "lower", facets: ["stack", "code_sha"], aggregate: null, computed_from: "runs", scale: "linear", cadence_s: 3600, lines_by: "stack", line_values: ["local", "prod"] };
	const how = "folder-sync bench/latency/bench.mjs: 10 trials per run, each at a random phase of `sync --watch`'s interval. The headline is the local stack (rclone serve s3 + the R2 stand-in + wrangler dev on loopback), hourly; the prod line is this machine's signed-in session against the deployed Worker and R2, run by hand.";
	return {
		schema: "vt-kpi-catalog/1",
		generated_at: generatedAt,
		unit_of_iteration: "run",
		title: "folder-sync latency: a machine's disk <-> online",
		producer: { name: "folder-sync bench/latency/bench.mjs", bench_version: BENCH_VERSION, repo: "/home/bam/folder-sync", doc: "README.md#latency-kpi" },
		cadence_s: 3600,
		kpis: [
			{ id: "sync_up_ms", title: "Disk to online (p50)", level: 0, parent: null, ...common, description: `A file saved into a synced folder, until GET /fs/v1/folders/<project>/files/<host>/<path> serves its bytes: what anyone reading it online waits. ${how}`, formula: "p50 over the run's trials of (first 200 with the same bytes, polled every 50 ms) - (the write)" },
			{ id: "sync_down_ms", title: "Online to disk (p50)", level: 0, parent: null, ...common, description: `A file saved online through the web host (PUT /fs/v1/folders/<project>/web/<path>, the call a page makes), until it is on the machine's disk at <folder>/hosts/<web host>/<path>. ${how}`, formula: "p50 over the run's trials of (file on disk with the same bytes, polled every 10 ms) - (the PUT sent)" },
			{ id: "sync_up_ms_p95", title: "Disk to online (p95)", level: 1, parent: "sync_up_ms", ...common, description: "The slow tail of sync_up_ms: the 95th percentile of the same trials.", formula: "p95 (linear between ranks) over the run's trials" },
			{ id: "sync_down_ms_p95", title: "Online to disk (p95)", level: 1, parent: "sync_down_ms", ...common, description: "The slow tail of sync_down_ms: the 95th percentile of the same trials.", formula: "p95 (linear between ranks) over the run's trials" },
		],
	};
}

export function points(result, runId, t) {
	const out = [];
	const host = hostname();
	const source = { code_sha: result.code.label, bench_version: BENCH_VERSION, run_ids: [runId], dirty: result.code.dirty };
	for (const [dir, s] of [["up", result.summary.up], ["down", result.summary.down]]) {
		for (const [kpi, value] of [[`sync_${dir}_ms`, s.p50], [`sync_${dir}_ms_p95`, s.p95]]) {
			const labels = { stack: result.stack, n: s.n, p50: s.p50, p95: s.p95, max: s.max, timeouts: s.timeouts, interval_ms: result.interval_ms, host, branch: result.code.branch, code_sha: result.code.label };
			const base = { schema: "vt-kpi-point/1", kpi, t, value, n: s.n, status: value === null ? "not_measured" : "measured", labels, source };
			// WHY the unsliced (headline) point is the local stack only: it runs every hour on the same machine, so
			// its trend is the code's; prod runs by hand over the internet and is its own line, never mixed in
			// (and the code_sha slice too, so one version's local numbers are never averaged with prod's)
			out.push({ ...base, slice: { stack: result.stack } });
			if (result.stack === "local") out.push(base, { ...base, slice: { code_sha: result.code.label } });
		}
	}
	return out;
}

export function runRow(result, runId, t) {
	return {
		schema: "vt-run/1",
		run_id: runId,
		t,
		facets: { stack: result.stack, code_sha: result.code.label, branch: result.code.branch, dirty: result.code.dirty, host: hostname(), server: result.server, interval_ms: result.interval_ms },
		metrics: {
			trials: result.up.length,
			up_n: result.summary.up.n, up_p50_ms: result.summary.up.p50, up_p95_ms: result.summary.up.p95, up_max_ms: result.summary.up.max, up_timeouts: result.summary.up.timeouts,
			down_n: result.summary.down.n, down_p50_ms: result.summary.down.p50, down_p95_ms: result.summary.down.p95, down_max_ms: result.summary.down.max, down_timeouts: result.summary.down.timeouts,
			duration_s: Math.round((Date.parse(result.finished) - Date.parse(result.started)) / 100) / 10,
		},
		trials: { up: result.up.map((x) => x.ms), down: result.down.map((x) => x.ms) },
	};
}

function writeKpi(dir, result) {
	mkdirSync(dir, { recursive: true });
	const t = stampOf(new Date(result.finished));
	const runId = `latency-${result.stack}-${result.finished.replace(/[-:]/g, "").slice(0, 15)}-${result.code.label}`;
	const tmp = join(dir, `.kpi_catalog.json.${process.pid}`);
	writeFileSync(tmp, `${JSON.stringify(catalog(t), null, 1)}\n`);
	renameSync(tmp, join(dir, "kpi_catalog.json"));
	appendFileSync(join(dir, "kpi_series.jsonl"), points(result, runId, t).map((p) => JSON.stringify(p)).join("\n") + "\n");
	appendFileSync(join(dir, "runs_table.jsonl"), `${JSON.stringify(runRow(result, runId, t))}\n`);
	return runId;
}

// ------------------------------------------------------------------------------------------------ the timer

function installTimer() {
	const units = join(HOME, ".config", "systemd", "user");
	mkdirSync(units, { recursive: true });
	const go = goBin();
	// WHY the system node when there is one: the timer must not depend on whichever node this shell found first
	const node = process.env.NODE || (existsSync("/usr/bin/node") ? "/usr/bin/node" : process.execPath);
	const service = `[Unit]
Description=folder-sync latency KPI (local stack) into Vibe Tracks
Documentation=file://${REPO}/README.md

[Service]
Type=oneshot
# written by ${join(REPO, "bench", "latency", "bench.mjs")} install-timer; run it again to change it
WorkingDirectory=${REPO}
Environment=PATH=${dirname(go)}:${dirname(node)}:/usr/local/bin:/usr/bin:/bin
Environment=GO=${go}
ExecStart=${node} ${join(REPO, "bench", "latency", "bench.mjs")} run --stack local
Nice=10
TimeoutStartSec=20min
`;
	const timer = `[Unit]
Description=folder-sync latency KPI, hourly

[Timer]
OnCalendar=hourly
RandomizedDelaySec=300
Persistent=true

[Install]
WantedBy=timers.target
`;
	writeFileSync(join(units, "folder-sync-latency.service"), service);
	writeFileSync(join(units, "folder-sync-latency.timer"), timer);
	for (const args of [["daemon-reload"], ["enable", "--now", "folder-sync-latency.timer"]]) {
		const done = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
		if (done.status !== 0) throw new Error(`systemctl --user ${args.join(" ")}: ${done.stderr}`);
	}
	const shown = spawnSync("systemctl", ["--user", "list-timers", "folder-sync-latency.timer", "--no-pager"], { encoding: "utf8" });
	console.log(shown.stdout.trim());
}

// ------------------------------------------------------------------------------------------------ main

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	let code = 0;
	try {
		const o = options(process.argv.slice(2));
		if (o.verb === "install-timer") {
			installTimer();
		} else if (o.verb === "run") {
			const result = await measure(o);
			if (o.json) writeFileSync(o.json, JSON.stringify(result, null, 1));
			if (o.kpi) result.run_id = writeKpi(o.out, result);
			console.log(JSON.stringify({ stack: result.stack, code_sha: result.code.label, interval_ms: result.interval_ms, run_id: result.run_id ?? null, up: result.summary.up, down: result.summary.down }));
		} else {
			throw new Error("usage: node bench/latency/bench.mjs run|install-timer [options]");
		}
	} catch (error) {
		console.error(`bench: ${error instanceof Error ? error.message : error}`);
		code = 1;
	}
	process.exit(code);
}
