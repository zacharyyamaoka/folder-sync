#!/usr/bin/env node
// The live stall check (Zach, 2026-11-04, after a killed sync left an empty lock that blocked a folder for 30 minutes and nothing
// noticed: "monitor live ... to catch this ... if things never propagate it times out after like 10 minutes").
//
//   node bench/kpi/canary.mjs run [--out DIR] [--timeout-s 600] [--env prod|test] [--no-notify] [--no-canary] [--no-folders]
//   node bench/kpi/canary.mjs status               the newest points and the open stall episodes
//   node bench/kpi/canary.mjs install-timer        folder-sync-canary.service + .timer (every 5 minutes) in ~/.config/systemd/user,
//                                                  enabled; --print shows the units and writes nothing
//
// Two checks, one run, appended to ~/vt/zach/producers/folder-sync/kpi_series.jsonl (docs/KPI.md "Is it syncing?"):
//   canary   sync_canary_ms         a small file saved in a dedicated canary folder (project canary-sync, never one of Zach's folders),
//                                   synced by the INSTALLED engine (`folder-sync sync --watch`), timed until the Worker serves its
//                                   bytes. Not online in --timeout-s (10 minutes) = stalled. No route to the server = offline, not measured.
//   folders  sync_stalled_folders   every synced folder in `folder-sync status --json`: no clean round for 10 minutes while online = stalled,
//                                   naming the cause (held lock + pid/age, quota, signed out, failing rounds, no engine running).
// A stall opens an episode: one desktop notification (notify-send, no focus steal) when it opens, none while it lasts.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Machine, Online, sleep } from "../latency/harness.mjs";
import {
	alertText, CANARY_FILE, CANARY_PROJECT, classifyCanary, classifyFolder, classifyReachability, findStateDir, healthPoints, nextEpisodes, parseInterval, readLock,
	STALL_AFTER_MS,
} from "./health.mjs";
import { appendPoints, codeSha, DEFAULT_OUT, readSeries, REPO, sourceOf, STATE_DIR, stampOf, withLock } from "./lib.mjs";

const HOME = homedir();
export const CANARY_FOLDER = join(HOME, ".local", "share", "folder-sync-canary", CANARY_PROJECT);

/** The installed engine: FOLDER_SYNC_CLI, else the folder-sync on PATH, else ~/.local/bin/folder-sync. */
export function installedCli() {
	if (process.env.FOLDER_SYNC_CLI) return process.env.FOLDER_SYNC_CLI;
	const found = spawnSync("sh", ["-c", "command -v folder-sync"], { encoding: "utf8" });
	const path = found.status === 0 ? found.stdout.trim() : "";
	return path || join(HOME, ".local", "bin", "folder-sync");
}

// ------------------------------------------------------------------------------------------------------------- server

/** One cheap request to the server: GET /fs/v1/usage (it also says whether the account is over its quota). A dropped connection,
 *  a refused one, DNS failing and a timeout are all "no route": offline. A 5xx is retried twice (the Worker answers an occasional
 *  1101 that the next call does not) before it counts. */
export async function probeServer(server, token, { timeoutMs = 8000, fetchImpl = fetch } = {}) {
	let last = { state: "network" };
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const answer = await fetchImpl(`${server.replace(/\/+$/, "")}/fs/v1/usage`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
			if (answer.status === 200) {
				const usage = await answer.json().catch(() => ({}));
				return classifyReachability({ state: "http", status: 200, over: usage.over ?? null });
			}
			last = { state: "http", status: answer.status };
			if (answer.status < 500 && answer.status !== 429) break;
		} catch {
			last = { state: "network" };
			break; // no route is not worth waiting out three times
		}
		await sleep(1000 * (attempt + 1));
	}
	return classifyReachability(last);
}

function account() {
	const file = join(HOME, ".folder-sync", "account.json");
	if (!existsSync(file)) return null;
	try {
		const a = JSON.parse(readFileSync(file, "utf8"));
		return a.server && a.token ? a : null;
	} catch {
		return null;
	}
}

// ------------------------------------------------------------------------------------------------------------- canary

/** Saves the canary file and times it until the Worker serves the same bytes.
 *  @param o {machine, online, project, folder, timeoutMs, pollMs, reach, reachAgain}  machine is a harness Machine (the installed engine, a HOME)
 *  @returns {result, cause, detail, value, project, timeout_s} (classifyCanary's verdict) */
export async function runCanary(o) {
	const { machine, online, timeoutMs, pollMs = 500, reach } = o;
	const project = o.project ?? CANARY_PROJECT;
	const finish = (verdict) => ({ ...verdict, project, timeout_s: Math.round(timeoutMs / 1000) });
	// offline, signed out, a server error or an over-quota account: the answer is known without waiting 10 minutes
	if (reach.state !== "online" || reach.quotaOver) return finish(classifyCanary({ reach, visibleMs: null, timeoutMs }));
	mkdirSync(machine.folder, { recursive: true });
	if (!existsSync(join(machine.folder, ".folder-sync.toml"))) machine.must(["init", "--project", project, "--dir", machine.folder]);
	// WHY a file that stays and is rewritten: a new name every 5 minutes would add 288 files a day to the folder and to history;
	// one name keeps the folder at two files, and every run is an "edit" the other side has to receive
	const keep = join(machine.folder, "README.txt");
	if (!existsSync(keep)) writeFileSync(keep, "folder-sync's sync canary (bench/kpi/canary.mjs) rewrites canary.txt here every 5 minutes.\n");
	const host = machine.hostId();
	try {
		await machine.watch();
	} catch (error) {
		return finish(classifyCanary({ reach, visibleMs: null, timeoutMs, engine: { exited: true, code: "did not start", log: `${error.message}\n${machine.log}` } }));
	}
	let visibleMs = null;
	try {
		const body = Buffer.from(`folder-sync canary ${new Date().toISOString()} ${Math.random().toString(36).slice(2)}\n`);
		const staged = join(machine.folder, `.${CANARY_FILE}.writing`);
		const started = performance.timeOrigin + performance.now();
		writeFileSync(staged, body);
		renameSync(staged, join(machine.folder, CANARY_FILE)); // an editor's save: write, then rename into place
		const until = Date.now() + timeoutMs;
		while (Date.now() < until && machine.watcher.exitCode === null && machine.watcher.signalCode === null) {
			const got = await online.get(host, CANARY_FILE);
			if (got.status === 200 && got.bytes.equals(body)) {
				visibleMs = performance.timeOrigin + performance.now() - started;
				break;
			}
			await sleep(pollMs);
		}
	} finally {
		const exited = machine.watcher.exitCode !== null || machine.watcher.signalCode !== null;
		const code = machine.watcher.exitCode ?? machine.watcher.signalCode;
		o.engineAtEnd = { exited, code, log: machine.log };
		await machine.stop();
	}
	const reachAfter = visibleMs === null ? await (o.reachAgain ?? (() => reach))() : reach;
	return finish(classifyCanary({ reach, reachAfter, visibleMs, timeoutMs, engine: o.engineAtEnd }));
}

// ------------------------------------------------------------------------------------------------------------- folders

/** Every synced folder of `cli`'s HOME, from `status --json` and each project's lock file. */
export function checkFolders({ cli, home = HOME, env = process.env, reach, now = Date.now(), stallAfterMs = STALL_AFTER_MS, alive }) {
	const done = spawnSync(cli, ["status", "--json"], { cwd: home, env, encoding: "utf8", timeout: 30_000 });
	if (done.status !== 0) throw new Error(`folder-sync status --json exited ${done.status}: ${(done.stderr || done.error || "").toString().trim().slice(0, 200)}`);
	const status = JSON.parse(done.stdout);
	return (status.projects ?? []).map((p) => {
		const dirExists = existsSync(p.folder);
		let intervalMs = 10_000;
		try { intervalMs = parseInterval(readFileSync(join(p.folder, ".folder-sync.toml"), "utf8")); } catch { /* the default */ }
		const stateDir = findStateDir(p.folder, home);
		return classifyFolder({
			project: p.project, folder: p.folder, now, dirExists, last: p.last, intervalMs, stallAfterMs,
			online: reach.state !== "offline", lock: readLock(stateDir, { now, alive: alive ?? undefined }),
			quotaOver: reach.quotaOver, signedIn: reach.state === "auth" ? false : undefined,
		});
	});
}

// ------------------------------------------------------------------------------------------------------------- alerts

export function notify(title, body, { env = process.env } = {}) {
	const argv = env.FOLDER_SYNC_NOTIFY_CMD ? JSON.parse(env.FOLDER_SYNC_NOTIFY_CMD) : ["notify-send", "--app-name=folder-sync", "--urgency=critical", "--icon=dialog-warning"];
	// notify-send posts to the desktop's notification daemon; it takes no focus and opens no window
	const done = spawnSync(argv[0], [...argv.slice(1), title, body], { encoding: "utf8", timeout: 10_000 });
	return done.status === 0;
}

const alertsFile = (stateDir) => join(stateDir, "canary-alerts.json");
export function loadEpisodes(stateDir) {
	try { return JSON.parse(readFileSync(alertsFile(stateDir), "utf8")).episodes ?? {}; } catch { return {}; }
}
function saveEpisodes(stateDir, episodes) {
	mkdirSync(stateDir, { recursive: true });
	const tmp = `${alertsFile(stateDir)}.${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify({ schema: "folder-sync-canary-alerts/1", episodes }, null, 1)}\n`);
	renameSync(tmp, alertsFile(stateDir));
}

/** Opens and closes stall episodes and sends the one notification a new episode earns. */
export function alert({ canary, folders, now = Date.now(), stateDir = STATE_DIR, send = true }) {
	const current = {};
	const causes = {};
	const lines = {};
	if (canary) {
		current.canary = canary.result === "ok" ? "ok" : canary.result;
		causes.canary = canary.cause;
		lines.canary = `canary: ${canary.detail}`;
	}
	for (const f of folders ?? []) {
		current[`folder:${f.project}`] = f.state;
		causes[`folder:${f.project}`] = f.cause;
		lines[`folder:${f.project}`] = `${f.project}: ${f.detail}`;
	}
	const { episodes, fire, resolved } = nextEpisodes(loadEpisodes(stateDir), current, { now, causes });
	saveEpisodes(stateDir, episodes);
	let sent = false;
	if (fire.length && send) {
		const text = alertText(fire.map((k) => lines[k]));
		sent = notify(text.title, text.body);
	}
	return { fire, resolved, open: Object.keys(episodes), sent };
}

// ------------------------------------------------------------------------------------------------------------- one run

/** One check of this machine: probe the server, run the canary and the folder check, append the points, alert.
 *  `o` carries what a test replaces (the machine, the server, the series dir); the defaults are this machine's real ones. */
export async function check(o) {
	const at = new Date(o.now ?? Date.now());
	const t = stampOf(at);
	const env = o.env ?? "prod";
	// WHY milliseconds: pointKey de-duplicates on the run id, and two checks in one second are two checks
	const runId = `canary-${at.toISOString().replace(/[-:.]/g, "").slice(0, 18)}${env === "test" ? "-test" : ""}`;
	const source = sourceOf("folder-sync-canary/1", runId, o.code ?? codeSha(o.repo ?? REPO));
	const reach = await probeServer(o.server, o.token, { timeoutMs: o.probeTimeoutMs });
	let canary = null;
	let folders = null;
	if (o.canary !== false) {
		canary = await runCanary({ machine: o.machine, online: new Online(o.server, o.token, o.project ?? CANARY_PROJECT), project: o.project, timeoutMs: o.timeoutMs ?? STALL_AFTER_MS, pollMs: o.pollMs, reach, reachAgain: () => probeServer(o.server, o.token, { timeoutMs: o.probeTimeoutMs }) });
	}
	if (o.folders !== false) {
		// the canary just took its time: look at the network again so a drop during the wait does not read as folders gone quiet
		const reachNow = canary && canary.result === "offline" ? { ...reach, state: "offline" } : reach;
		folders = checkFolders({ cli: o.machine.cli, home: o.machine.home, env: o.machine.env, reach: reachNow, now: Date.now(), stallAfterMs: o.stallAfterMs, alive: o.alive });
	}
	const points = healthPoints({ canary, folders, env, t, source });
	appendPoints(o.out ?? DEFAULT_OUT, points);
	const alerts = alert({ canary, folders, stateDir: o.stateDir ?? STATE_DIR, send: o.notify !== false });
	return { canary, folders, points, alerts };
}

// ------------------------------------------------------------------------------------------------------------- timer

export function unitFiles({ repo = REPO, node = existsSync("/usr/bin/node") ? "/usr/bin/node" : process.execPath } = {}) {
	const script = join(repo, "bench", "kpi", "canary.mjs");
	const service = `[Unit]
Description=folder-sync live stall check: a canary file to the Worker, and every synced folder's last clean round
Documentation=file://${repo}/docs/KPI.md

[Service]
Type=oneshot
# written by ${script} install-timer (--repo picks the checkout it runs from); run it again to change it
WorkingDirectory=${repo}
Environment=PATH=${HOME}/.local/bin:${dirname(node)}:/usr/local/bin:/usr/bin:/bin
# notify-send reaches the desktop's notification daemon through the user's session bus
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/%U/bus
ExecStart=${node} ${script} run
Nice=10
# the canary waits up to 10 minutes for a stalled sync before it says so
TimeoutStartSec=15min
`;
	const timer = `[Unit]
Description=folder-sync live stall check, every 5 minutes

[Timer]
OnBootSec=2min
OnUnitInactiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
`;
	return { service, timer };
}

function installTimer(o) {
	const { service, timer } = unitFiles({ repo: o.repo });
	if (o.print) {
		console.log(`# folder-sync-canary.service\n${service}\n# folder-sync-canary.timer\n${timer}`);
		return;
	}
	const units = join(HOME, ".config", "systemd", "user");
	mkdirSync(units, { recursive: true });
	writeFileSync(join(units, "folder-sync-canary.service"), service);
	writeFileSync(join(units, "folder-sync-canary.timer"), timer);
	const ctl = (...args) => { const d = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" }); if (d.status !== 0) throw new Error(`systemctl --user ${args.join(" ")}: ${d.stderr}`); return d.stdout; };
	ctl("daemon-reload");
	ctl("enable", "--now", "folder-sync-canary.timer");
	console.log(ctl("list-timers", "folder-sync-canary.timer", "--no-pager").trim());
}

function options(argv) {
	const o = { verb: "run", out: DEFAULT_OUT, timeoutMs: STALL_AFTER_MS, env: "prod", notify: true, canary: true, folders: true, repo: REPO, print: false };
	const rest = [...argv];
	if (rest[0] && !rest[0].startsWith("--")) o.verb = rest.shift();
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === "--out") o.out = resolve(rest[++i]);
		else if (a === "--timeout-s") o.timeoutMs = Number(rest[++i]) * 1000;
		else if (a === "--env") o.env = rest[++i];
		else if (a === "--no-notify") o.notify = false;
		else if (a === "--no-canary") o.canary = false;
		else if (a === "--no-folders") o.folders = false;
		else if (a === "--repo") o.repo = resolve(rest[++i]);
		else if (a === "--print") o.print = true;
		else throw new Error(`unknown argument ${a}`);
	}
	if (!["prod", "test"].includes(o.env) || !(o.timeoutMs > 0)) throw new Error("--env is prod or test; --timeout-s is a positive number");
	return o;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	let code = 0;
	try {
		const o = options(process.argv.slice(2));
		if (o.verb === "install-timer") {
			installTimer(o);
		} else if (o.verb === "status") {
			const mine = readSeries(o.out).filter((p) => p.kpi === "sync_canary_ms" || p.kpi === "sync_stalled_folders");
			for (const kpi of ["sync_canary_ms", "sync_stalled_folders"]) {
				const p = mine.filter((x) => x.kpi === kpi).at(-1);
				console.log(p ? `${kpi.padEnd(22)} ${p.t}  ${p.labels?.result}  ${p.value ?? "-"}  ${p.labels?.detail || p.labels?.reason || ""}` : `${kpi.padEnd(22)} never run`);
			}
			console.log(`open stall episodes: ${JSON.stringify(loadEpisodes(STATE_DIR))}`);
		} else if (o.verb === "run") {
			const a = account();
			if (!a) throw new Error("this machine is not signed in (no ~/.folder-sync/account.json): nothing to check; run folder-sync login");
			const cli = installedCli();
			const machine = new Machine({ name: "canary", cli, home: HOME, folder: CANARY_FOLDER, env: { ...process.env } });
			const ran = await withLock(join(STATE_DIR, "canary.lock"), () => check({ ...o, machine, server: a.server, token: a.token }), { staleMs: 30 * 60_000 });
			if (ran.skipped) {
				console.error(`canary: the previous check (pid ${ran.holder}) is still running; nothing to do`);
			} else {
				const { canary, folders, alerts } = ran.value;
				if (canary) console.log(`canary: ${canary.result}${canary.value !== null ? ` ${canary.value} ms` : ""}${canary.detail ? ` (${canary.detail})` : ""}`);
				if (folders) console.log(`folders: ${folders.filter((f) => f.state === "stalled").length} stalled of ${folders.filter((f) => f.state !== "skipped").length} checked${folders.filter((f) => f.state === "stalled").map((f) => `\n  ${f.project}: ${f.detail}`).join("")}`);
				if (alerts.fire.length) console.log(`alert: ${alerts.sent ? "notified" : "NOT sent"} for ${alerts.fire.join(", ")}`);
			}
		} else {
			throw new Error("usage: node bench/kpi/canary.mjs [run|status|install-timer] [--out DIR] [--timeout-s N] [--env prod|test] [--no-notify] [--no-canary] [--no-folders] [--print]");
		}
	} catch (error) {
		console.error(`canary: ${error instanceof Error ? error.message : error}`);
		code = 1;
	}
	process.exit(code);
}
