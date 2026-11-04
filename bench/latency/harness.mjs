// The machinery shared by the latency bench and the other KPI producers that need a real folder-sync stack: a
// Machine (a HOME and its folder-sync CLI), Online (the signed-in HTTP side), the local stack on loopback and this
// machine's own signed-in session against production. Moved out of bench.mjs unchanged in behaviour; the second
// machine and the 404/absent reads are new (the machine<->machine and delete/rename trials need them).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..");
export const HOME = homedir();
export const PROJECT = "bench-latency";
export const BENCH_ROOT = join(HOME, ".local", "share", "folder-sync-bench");
export const PROD_FOLDER = join(BENCH_ROOT, PROJECT);
export const PROD_B_HOME = join(BENCH_ROOT, "machine-b");
export const BENCH_PORTS = { FS_STANDIN_PORT: "4950", FS_STORE_PORT: "4951", FS_ACCOUNTS_PORT: "4952", FS_INSPECTOR_PORT: "4953" };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => performance.timeOrigin + performance.now();

export function goBin() {
	if (process.env.GO) return process.env.GO;
	const local = join(HOME, ".local", "go", "bin", "go");
	return existsSync(local) ? local : "go";
}

/** The pinned rclone: RCLONE, else this checkout's .tools/ (scripts/dev-tools), else the one `init` installed. */
export function rcloneBin() {
	for (const candidate of [process.env.RCLONE, join(REPO, ".tools", "rclone"), join(HOME, ".folder-sync", "bin", "rclone")]) {
		if (candidate && existsSync(candidate)) return resolve(candidate);
	}
	throw new Error("no rclone: run scripts/dev-tools, or set RCLONE");
}

export function buildCli(dir, sha) {
	mkdirSync(dir, { recursive: true });
	const bin = join(dir, "folder-sync");
	const built = spawnSync(goBin(), ["-C", REPO, "build", "-ldflags", `-X main.version=bench-${sha}`, "-o", bin, "./cmd/folder-sync"], { encoding: "utf8" });
	if (built.status !== 0) throw new Error(`folder-sync build failed: ${built.stderr || built.error}`);
	return bin;
}

/** One machine: a HOME and its folder-sync. `env` is what every CLI call runs with. */
export class Machine {
	constructor({ cli, home, folder, env, name = "A" }) {
		Object.assign(this, { cli, home, folder, env, name, watcher: null, log: "" });
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

/** The online side, as a signed-in session sees it: a bearer token, never printed. */
export class Online {
	constructor(server, token, project = PROJECT) {
		this.server = server.replace(/\/+$/, "");
		this.project = project;
		this.auth = { Authorization: `Bearer ${token}` };
	}

	url(path) {
		return `${this.server}/fs/v1/folders/${this.project}${path}`;
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

	/** One read of a host's file: {status, bytes}; status 0 is a dropped connection (never "absent"). */
	async get(host, path) {
		try {
			const answer = await fetch(this.url(`/files/${host}/${path}`), { headers: this.auth });
			return { status: answer.status, bytes: Buffer.from(await answer.arrayBuffer()) };
		} catch {
			return { status: 0, bytes: null }; // "not yet"; the next poll tries again
		}
	}

	/** One read of a host's file: its bytes when it answers 200, else null. */
	async read(host, path) {
		const got = await this.get(host, path);
		return got.status === 200 ? got.bytes : null;
	}

	async view() {
		const answer = await fetch(this.url(""), { headers: this.auth });
		return answer.status === 200 ? answer.json() : null;
	}

	/** GET /fs/v1/usage, retried: the Worker answers an occasional 1101 / 5xx that the next call does not. */
	async usage() {
		let last = null;
		for (let attempt = 0; attempt < 4; attempt++) {
			try {
				const answer = await fetch(`${this.server}/fs/v1/usage`, { headers: this.auth });
				if (answer.status === 200) return await answer.json();
				last = `GET /fs/v1/usage: ${answer.status}`;
				if (answer.status < 500 && answer.status !== 429) break;
			} catch (error) {
				last = `GET /fs/v1/usage: ${error.message}`;
			}
			await sleep(1000 * (attempt + 1));
		}
		throw new Error(last);
	}
}

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

export async function signIn(site, email) {
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
export async function login(machine, browser) {
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

/** The whole stack on loopback in a fresh temp dir, with `machines` (1 or 2) signed in as one test person and
 *  initialised on the project. `env` adds to the dev stack's environment (QUOTA_RECHECK_S, say). Returns {machines, server, stateDir, gateLog, workerLog, teardown}. */
export async function localStack({ cli: cliPath = null, sha, machines = 1, project = PROJECT, prefix = "folder-sync-latency-", env: extraEnv = {} }) {
	const dev = await import(join(REPO, "accounts", "scripts", "dev.mjs"));
	const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), prefix));
	const rclone = rcloneBin();
	const env = { ...process.env, ...Object.fromEntries(Object.entries(BENCH_PORTS).map(([k, v]) => [k, process.env[k] || v])), RCLONE: rclone, GO: goBin(), ...extraEnv };
	const stateDir = join(scratch, "stack");
	const stack = await dev.up(stateDir, env);
	const teardown = () => {
		try { dev.down(stateDir); } catch { /* stopped */ }
		rmSync(scratch, { recursive: true, force: true });
	};
	try {
		const cli = cliPath || buildCli(join(scratch, "bin"), sha);
		const browser = await signIn(stack.accounts, "bench@example.com");
		const made = [];
		for (const name of ["A", "B"].slice(0, machines)) {
			const home = join(scratch, `home-${name}`);
			const folder = join(home, project);
			mkdirSync(folder, { recursive: true });
			// WHY a bare PATH and HOME: the machine is a fresh computer with only folder-sync on it, nothing of this one's
			const machine = new Machine({ name, cli, home, folder, env: { PATH: "/usr/bin:/bin", HOME: home, USERPROFILE: home, LANG: "C.UTF-8", FOLDER_SYNC_SERVER: stack.accounts, FOLDER_SYNC_RCLONE: rclone } });
			await login(machine, browser);
			machine.must(["init", "--project", project, "--dir", folder]);
			made.push(machine);
		}
		return { machines: made, server: stack.accounts, stateDir, gateLog: join(stateDir, "gate.jsonl"), workerLog: join(stateDir, "accounts.log"), teardown };
	} catch (error) {
		teardown();
		throw error;
	}
}

/** This machine's own signed-in session and its server, in the throwaway project `bench-latency` (folder
 *  ~/.local/share/folder-sync-bench/bench-latency). With `second`, a second machine too: a persistent HOME of its own
 *  (its own host id) that reaches the same session through FOLDER_SYNC_ACCOUNT_PROCESS, so the token is never copied
 *  (PEP 0006's account process: `cat` of account.json). It never touches another project. */
export function prodStack({ cli: cliPath = null, sha, second = false }) {
	const accountPath = join(HOME, ".folder-sync", "account.json");
	if (!existsSync(accountPath)) throw new Error("prod is unmeasured: this machine is not signed in (no ~/.folder-sync/account.json); run folder-sync login");
	const account = JSON.parse(readFileSync(accountPath, "utf8"));
	const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "folder-sync-latency-"));
	const cli = cliPath || buildCli(scratch, sha);
	const guard = (machine) => {
		const project = readFileSync(join(machine.folder, ".folder-sync.toml"), "utf8");
		// WHY refuse: the bench deletes what it wrote; it must only ever run in its own project
		if (!new RegExp(`^\\s*project\\s*=\\s*"${PROJECT}"`, "m").test(project)) throw new Error(`${machine.folder} is not the ${PROJECT} project; refusing`);
	};
	mkdirSync(PROD_FOLDER, { recursive: true });
	const a = new Machine({ name: "A", cli, home: HOME, folder: PROD_FOLDER, env: { ...process.env } });
	if (!existsSync(join(PROD_FOLDER, ".folder-sync.toml"))) a.must(["init", "--project", PROJECT, "--dir", PROD_FOLDER]);
	guard(a);
	const machines = [a];
	if (second) {
		const folder = join(PROD_B_HOME, PROJECT);
		mkdirSync(folder, { recursive: true });
		const env = { ...process.env, HOME: PROD_B_HOME, USERPROFILE: PROD_B_HOME, FOLDER_SYNC_ACCOUNT_PROCESS: JSON.stringify(["/usr/bin/cat", accountPath]), FOLDER_SYNC_RCLONE: rcloneBin() };
		const b = new Machine({ name: "B", cli, home: PROD_B_HOME, folder, env });
		if (!existsSync(join(folder, ".folder-sync.toml"))) b.must(["init", "--project", PROJECT, "--dir", folder]);
		guard(b);
		machines.push(b);
	}
	return { machines, server: account.server, token: account.token, teardown: () => rmSync(scratch, { recursive: true, force: true }) };
}
