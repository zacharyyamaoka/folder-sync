// The accounts Worker on this machine, for development and for an app's own tests (PEP 0003): `rclone serve s3` (the
// store), folder-sync's R2 stand-in in front of it (e2e/r2standin: R2's temporary-credential checks), and
// `wrangler dev` for accounts/ (ENVIRONMENT=dev: email codes instead of Google, a local D1 with the migrations
// applied). Test keys are generated here for this state dir only; nothing leaves this machine.
//
//   node accounts/scripts/dev.mjs up   [--state-dir DIR]   start (or, if already up, report) the stack
//   node accounts/scripts/dev.mjs down [--state-dir DIR]   stop exactly the processes `up` started, by recorded PID
//
// The last line `up` prints is one JSON object (an app's tests parse it):
//   {"accounts":"http://127.0.0.1:4932","endpoint":"http://127.0.0.1:4930","store":"http://127.0.0.1:4931",
//    "bucket":"folder-sync","parentKeyId":"…","accountId":"…","stateDir":"…","pids":{"store":…,"gate":…,"accounts":…}}
//
// Ports (all 127.0.0.1), each checked free before anything binds: FS_STANDIN_PORT (4930), FS_STORE_PORT (4931),
// FS_ACCOUNTS_PORT (4932), FS_INSPECTOR_PORT (4942, wrangler's devtools). Tools: RCLONE (default <repo>/.tools/rclone,
// from scripts/dev-tools), GO (default ~/.local/go/bin/go, else go). SIGN_UP_EMAILS defaults to "*" here.
// The state dir (default accounts/.state/dev) holds keys.json, the D1, the store, logs and one <name>.pid per process.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ACCOUNTS = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO = resolve(ACCOUNTS, "..");
const BUCKET = "folder-sync";
const NAMES = ["accounts", "gate", "store"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function options(argv) {
	const out = { verb: argv[0] || "up", stateDir: join(ACCOUNTS, ".state", "dev") };
	for (let i = 1; i < argv.length; i++) {
		if (argv[i] === "--state-dir" && argv[i + 1]) out.stateDir = resolve(argv[++i]);
		else if (argv[i].startsWith("--state-dir=")) out.stateDir = resolve(argv[i].slice("--state-dir=".length));
		else throw new Error(`unknown argument ${argv[i]}`);
	}
	return out;
}

export function ports(env = process.env) {
	const port = (name, fallback) => {
		const value = Number(env[name] || fallback);
		if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a port number`);
		return value;
	};
	return { standin: port("FS_STANDIN_PORT", 4930), store: port("FS_STORE_PORT", 4931), accounts: port("FS_ACCOUNTS_PORT", 4932), inspector: port("FS_INSPECTOR_PORT", 4942) };
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

function pidOf(state, name) {
	const file = join(state, `${name}.pid`);
	if (!existsSync(file)) return null;
	const pid = Number(readFileSync(file, "utf8"));
	return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function keys(state) {
	const path = join(state, "keys.json");
	if (!existsSync(path)) {
		// test values for this state dir only: the stand-in's parent key, its account id, Better Auth's secret
		const k = {
			accountId: `devacct${randomBytes(8).toString("hex")}`,
			parentKeyId: `devparent${randomBytes(8).toString("hex")}`,
			parentSecret: randomBytes(24).toString("hex"),
			authSecret: `dev-only-${randomBytes(24).toString("hex")}`,
		};
		writeFileSync(path, JSON.stringify(k, null, 1), { mode: 0o600 });
	}
	return JSON.parse(readFileSync(path, "utf8"));
}

function wrangler() {
	const bin = join(ACCOUNTS, "node_modules", "wrangler", "bin", "wrangler.js");
	if (!existsSync(bin)) throw new Error("accounts/node_modules is missing: npm install --prefix accounts");
	return bin;
}

function start(state, name, argv, cwd, env = {}) {
	const log = openSync(join(state, `${name}.log`), "a");
	// WHY detached: the pid is a process group (wrangler and its workerd), so `down` stops exactly what this started
	const child = spawn(argv[0], argv.slice(1), { cwd, detached: true, stdio: ["ignore", log, log], env: { ...process.env, ...env } });
	child.unref();
	writeFileSync(join(state, `${name}.pid`), String(child.pid));
	return child.pid;
}

async function ready(url, pid, name, seconds = 120) {
	const until = Date.now() + seconds * 1000;
	while (Date.now() < until) {
		if (!alive(pid)) throw new Error(`${name} exited during start; see its log in the state dir`);
		try {
			await fetch(url);
			return;
		} catch { /* not yet */ }
		await sleep(300);
	}
	throw new Error(`${url} did not answer within ${seconds} s`);
}

function summary(state, p, k) {
	const pids = Object.fromEntries(NAMES.map((n) => [n, pidOf(state, n)]));
	return {
		accounts: `http://127.0.0.1:${p.accounts}`,
		endpoint: `http://127.0.0.1:${p.standin}`,
		store: `http://127.0.0.1:${p.store}`,
		bucket: BUCKET,
		parentKeyId: k.parentKeyId,
		accountId: k.accountId,
		stateDir: state,
		pids,
	};
}

/** The vars the Worker runs with (also written to accounts/.dev.vars, which wrangler dev reads). */
export function devVars(p, k, env = process.env) {
	return {
		ENVIRONMENT: "dev",
		PUBLIC_URL: `http://127.0.0.1:${p.accounts}`,
		BETTER_AUTH_SECRET: k.authSecret,
		R2_ACCOUNT_ID: k.accountId,
		R2_ENDPOINT: `http://127.0.0.1:${p.standin}`,
		SYNC_BUCKET: BUCKET,
		SYNC_CREDENTIAL_TTL_S: env.SYNC_CREDENTIAL_TTL_S || "900",
		R2_PARENT_ACCESS_KEY_ID: k.parentKeyId,
		R2_PARENT_SECRET_ACCESS_KEY: k.parentSecret,
		SIGN_UP_EMAILS: env.SIGN_UP_EMAILS || "*",
	};
}

export async function up(state, env = process.env) {
	mkdirSync(state, { recursive: true, mode: 0o700 });
	const p = ports(env);
	const k = keys(state);
	const running = NAMES.filter((n) => pidOf(state, n) && alive(pidOf(state, n)));
	if (running.length === NAMES.length) return summary(state, p, k); // already up: report it again
	if (running.length) throw new Error(`a partial stack is running from ${state} (${running.join(", ")}): run down first`);
	for (const [name, port] of Object.entries(p)) {
		if (!(await free(port))) throw new Error(`port ${port} (${name}) is taken on 127.0.0.1: set FS_${name === "standin" ? "STANDIN" : name.toUpperCase()}_PORT to a free one`);
	}
	const rclone = resolve(env.RCLONE || join(REPO, ".tools", "rclone"));
	if (!existsSync(rclone)) throw new Error(`no rclone at ${rclone}: run scripts/dev-tools, or set RCLONE`);
	const go = env.GO || (existsSync(join(homedir(), ".local", "go", "bin", "go")) ? join(homedir(), ".local", "go", "bin", "go") : "go");
	for (const sub of ["s3", "bin", "d1"]) mkdirSync(join(state, sub), { recursive: true });
	mkdirSync(join(state, "s3", BUCKET), { recursive: true });

	const standin = join(state, "bin", "r2standin");
	const built = spawnSync(go, ["-C", REPO, "build", "-o", standin, "./e2e/r2standin"], { encoding: "utf8" });
	if (built.status !== 0) throw new Error(`r2standin build failed: ${built.stderr || built.error}`);
	const vars = devVars(p, k, env);
	writeFileSync(join(ACCOUNTS, ".dev.vars"), `# written by scripts/dev.mjs for ${state}: generated test values only\n${Object.entries(vars).map(([a, b]) => `${a}=${b}`).join("\n")}\n`, { mode: 0o600 });
	const quiet = { CI: "1", WRANGLER_SEND_METRICS: "false", FORCE_COLOR: "0" };
	const migrate = spawnSync(process.execPath, [wrangler(), "d1", "migrations", "apply", "DB", "--local", "--persist-to", join(state, "d1"), "--config", join(ACCOUNTS, "wrangler.toml")], {
		cwd: ACCOUNTS, encoding: "utf8", env: { ...process.env, ...quiet },
	});
	if (migrate.status !== 0) throw new Error(`migrations failed:\n${migrate.stdout}${migrate.stderr}`);

	const store = start(state, "store", [rclone, "serve", "s3", "--addr", `127.0.0.1:${p.store}`, "--config", "/dev/null", "--cache-dir", join(state, "store-cache"), join(state, "s3")], state);
	const gate = start(state, "gate", [standin, "serve", "--listen", `127.0.0.1:${p.standin}`, "--backend", `127.0.0.1:${p.store}`, "--account", k.accountId, "--parent", `${k.parentKeyId}:${k.parentSecret}`, "--log", join(state, "gate.jsonl")], state);
	// WHY --var as well as .dev.vars: the values this process runs with stay pinned even if another state dir's `up`
	// rewrites .dev.vars; WHY --local-upstream: the Worker must see its own 127.0.0.1 origin (PUBLIC_URL), the one
	// Better Auth trusts
	const accounts = start(state, "accounts", [process.execPath, wrangler(), "dev", "--config", join(ACCOUNTS, "wrangler.toml"), "--port", String(p.accounts), "--ip", "127.0.0.1",
		"--inspector-port", String(p.inspector), "--local-upstream", `127.0.0.1:${p.accounts}`, "--upstream-protocol", "http", "--persist-to", join(state, "d1"),
		"--show-interactive-dev-session=false", ...Object.entries(vars).flatMap(([a, b]) => ["--var", `${a}:${b}`])], ACCOUNTS, quiet);
	try {
		await ready(`http://127.0.0.1:${p.store}/`, store, "rclone serve s3");
		await ready(`http://127.0.0.1:${p.standin}/`, gate, "r2standin");
		await ready(`http://127.0.0.1:${p.accounts}/fs/v1/me`, accounts, "wrangler dev");
	} catch (error) {
		down(state);
		throw error;
	}
	return summary(state, p, k);
}

export function down(state) {
	const stopped = [];
	for (const name of NAMES) {
		const pid = pidOf(state, name);
		if (!pid) continue;
		// only the process group this state dir recorded, never "whatever listens on the port"
		try { process.kill(-pid, "SIGTERM"); } catch { /* gone */ }
		stopped.push({ name, pid });
	}
	const until = Date.now() + 5000;
	while (stopped.some((s) => alive(s.pid)) && Date.now() < until) spawnSync("sleep", ["0.2"]);
	for (const s of stopped) {
		if (alive(s.pid)) try { process.kill(-s.pid, "SIGKILL"); } catch { /* gone */ }
		rmSync(join(state, `${s.name}.pid`), { force: true });
	}
	return stopped;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	let code = 0;
	try {
		const o = options(process.argv.slice(2));
		if (o.verb === "up") {
			console.log(JSON.stringify(await up(o.stateDir)));
		} else if (o.verb === "down") {
			const stopped = down(o.stateDir);
			console.log(JSON.stringify({ stopped, stateDir: o.stateDir }));
		} else {
			throw new Error("usage: node accounts/scripts/dev.mjs up|down [--state-dir DIR]");
		}
	} catch (error) {
		console.error(`dev.mjs: ${error instanceof Error ? error.message : error}`);
		code = 1;
	}
	process.exit(code);
}
