#!/usr/bin/env node
// The passive stall check (Zach, 2026-11-04, after a killed sync left an empty lock that blocked a folder for 30 minutes and nothing
// noticed: "monitor live ... if things never propagate it times out after like 10 minutes"; then: "couldn't you just kinda monitor
// when the files change by the users? it would be nice if we are super quiet when nothing is changing").
//
//   node bench/kpi/stall.mjs run [--out DIR] [--env prod|test] [--no-notify]
//   node bench/kpi/stall.mjs status                the newest points and the open stall episodes
//   node bench/kpi/stall.mjs install-timer         folder-sync-stall.service + .timer (every 5 minutes) in ~/.config/systemd/user, enabled;
//                                                  --print shows the units and writes nothing
//
// It watches each real synced folder and writes nothing to any of them, makes no network request and adds no storage request:
//   stall   a change on this disk that the last push does not hold (the engine's own size + mtime test, over rclone's local listing
//           with the engine's filters) and that has waited 10 minutes while this machine is online. The cause comes from the engine's
//           state: a held lock with its pid and age, quota, signed out, held deletes, a failing round with its error, or no engine.
//   real use  every file the engine pushed since the last check is a propagation sample (the manifest's written_at minus mtime),
//           written as propagation_p50_ms / p95 with slice op "real": O1 measured from real use, at no extra cost.
//   quiet   nothing changing writes nothing: one sync_stalled_folders point when the result changes, else at most one an hour.
// A stall opens an episode: one desktop notification (notify-send, no focus steal) when it opens, none while it lasts.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rcloneBin } from "../latency/harness.mjs";
import {
	alertText, classifyFolder, findStateDir, hasDefaultRoute, healthPoint, latencySamples, nextEpisodes, parseInterval, pendingChanges, pointDue, pointKeyOf, readLock,
	realUsePoints, STALL_AFTER_MS, updateFirstSeen,
} from "./health.mjs";
import { appendPoints, codeSha, DEFAULT_OUT, readSeries, REPO, sourceOf, STATE_DIR, stampOf, withLock } from "./lib.mjs";

const HOME = homedir();

/** The installed engine: FOLDER_SYNC_CLI, else the folder-sync on PATH, else ~/.local/bin/folder-sync. */
export function installedCli() {
	if (process.env.FOLDER_SYNC_CLI) return process.env.FOLDER_SYNC_CLI;
	const found = spawnSync("sh", ["-c", "command -v folder-sync"], { encoding: "utf8" });
	const path = found.status === 0 ? found.stdout.trim() : "";
	return path || join(HOME, ".local", "bin", "folder-sync");
}

function localRclone(env, home) {
	for (const candidate of [env.FOLDER_SYNC_RCLONE, join(home, ".folder-sync", "bin", "rclone")]) if (candidate && existsSync(candidate)) return candidate;
	return rcloneBin();
}

// ------------------------------------------------------------------------------------------------------------- local reads

/** Is this machine on a network at all (a default route in the kernel's table; no request). */
export function machineOnline() {
	let text = null;
	try { text = readFileSync("/proc/net/route", "utf8"); } catch { /* no such table here */ }
	return hasDefaultRoute(text);
}

/** pids of running `folder-sync sync --watch` processes and their argv. */
export function watchers() {
	const found = [];
	let names = [];
	try { names = readdirSync("/proc"); } catch { return found; }
	for (const name of names) {
		if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
		try {
			const argv = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean);
			if (argv.length && basename(argv[0]) === "folder-sync" && argv.includes("sync") && argv.includes("--watch")) found.push({ pid: Number(name), argv, cwd: (() => { try { return readFileSync(`/proc/${name}/cwd`, "utf8"); } catch { return ""; } })() });
		} catch { /* gone */ }
	}
	return found;
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

/** One folder's pending changes, or null when they cannot be told here (no filters yet, a shared tree, rclone failing). A local
 *  listing only: rclone lsjson on the folder, with the engine's own filter file (the project's state dir keeps it from the last round). */
export function localPending({ folder, stateDir, last, rclone }) {
	if (!stateDir) return null;
	const filters = join(stateDir, "filters.txt");
	if (!existsSync(filters)) return null;
	const shared = readJson(join(stateDir, "shared.json"));
	if (shared && shared.host) return null; // a shared tree's files leave this machine's manifest: the round is their only judge
	const manifest = readJson(join(stateDir, "manifest.json"));
	if (!manifest || !Array.isArray(manifest.files)) return null;
	const listed = spawnSync(rclone, ["lsjson", "-R", "--files-only", "--no-mimetype", "--config", process.platform === "win32" ? "NUL" : "/dev/null", "--filter-from", filters, folder], { encoding: "utf8", timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
	if (listed.status !== 0) return null;
	let listing;
	try { listing = JSON.parse(listed.stdout || "[]"); } catch { return null; }
	const skip = new Set((last?.skipped ?? []).map((s) => s.path ?? s.Path).filter(Boolean));
	return pendingChanges({ listing, manifestFiles: manifest.files, skip });
}

// ------------------------------------------------------------------------------------------------------------- state

const stateFile = (stateDir) => join(stateDir, "stall-state.json");
export function loadState(stateDir) {
	const doc = readJson(stateFile(stateDir)) ?? {};
	return { first_seen: doc.first_seen ?? {}, episodes: doc.episodes ?? {}, last_point: doc.last_point ?? null, watermarks: doc.watermarks ?? {} };
}
function saveState(stateDir, state) {
	mkdirSync(stateDir, { recursive: true });
	const tmp = `${stateFile(stateDir)}.${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify({ schema: "folder-sync-stall-state/1", ...state }, null, 1)}\n`);
	renameSync(tmp, stateFile(stateDir));
}

export function notify(title, body, { env = process.env } = {}) {
	const argv = env.FOLDER_SYNC_NOTIFY_CMD ? JSON.parse(env.FOLDER_SYNC_NOTIFY_CMD) : ["notify-send", "--app-name=folder-sync", "--urgency=critical", "--icon=dialog-warning"];
	// notify-send posts to the desktop's notification daemon; it takes no focus and opens no window
	const done = spawnSync(argv[0], [...argv.slice(1), title, body], { encoding: "utf8", timeout: 10_000 });
	return done.status === 0;
}

// ------------------------------------------------------------------------------------------------------------- one run

/** One check of this machine's folders. `o` carries what a test replaces (the machine, the series dir, the clock, the route); the
 *  defaults are this machine's real ones. Returns {folders, points, alerts, samples}. */
export function check(o) {
	const nowMs = o.now ?? Date.now();
	const at = new Date(nowMs);
	const t = stampOf(at);
	const env = o.env ?? "prod";
	const home = o.machine.home ?? HOME;
	const stateRoot = o.stateDir ?? STATE_DIR;
	const state = loadState(stateRoot);
	const online = o.online ?? machineOnline();
	const rclone = o.rclone ?? localRclone(o.machine.env ?? process.env, home);
	const done = spawnSync(o.machine.cli, ["status", "--json"], { cwd: home, env: o.machine.env ?? process.env, encoding: "utf8", timeout: 30_000 });
	if (done.status !== 0) throw new Error(`folder-sync status --json exited ${done.status}: ${(done.stderr || done.error || "").toString().trim().slice(0, 200)}`);
	const status = JSON.parse(done.stdout);
	const running = o.watchers ?? watchers();

	const folders = [];
	const samples = [];
	const watermarks = {};
	for (const p of status.projects ?? []) {
		const dirExists = existsSync(p.folder);
		let intervalMs = 10_000;
		try { intervalMs = parseInterval(readFileSync(join(p.folder, ".folder-sync.toml"), "utf8")); } catch { /* the default */ }
		const stateDir = findStateDir(p.folder, home);
		const quiet = !dirExists || !online || !p.last || p.project === "bench-latency";
		const pending = quiet ? null : localPending({ folder: p.folder, stateDir, last: p.last, rclone });
		folders.push({
			...classifyFolder({
				project: p.project, folder: p.folder, now: nowMs, dirExists, online, last: p.last, pending, firstSeenMs: state.first_seen[p.project], intervalMs, stallAfterMs: o.stallAfterMs,
				lock: stateDir ? readLock(stateDir, { now: nowMs, alive: o.alive ?? undefined }) : null, engineRunning: running.some((w) => w.argv.includes(p.folder) || w.cwd === p.folder),
			}),
		});
		// real-use samples: files pushed since this folder's watermark (the first run takes the clock: it never backfills history)
		if (stateDir && p.project !== "bench-latency") {
			const manifestFile = join(stateDir, "manifest.json");
			const mark = state.watermarks[p.project] ?? { written_at_ms: nowMs, manifest_mtime_ms: 0 };
			let mtimeMs = 0;
			try { mtimeMs = statSync(manifestFile).mtimeMs; } catch { /* no manifest yet */ }
			watermarks[p.project] = mark;
			if (mtimeMs && mtimeMs !== mark.manifest_mtime_ms) {
				const manifest = readJson(manifestFile);
				const mine = latencySamples(manifest?.files ?? [], mark.written_at_ms);
				samples.push(...mine.map((s) => ({ ...s, project: p.project })));
				const newest = (manifest?.files ?? []).reduce((m, e) => Math.max(m, Date.parse(e.written_at) || 0), mark.written_at_ms);
				watermarks[p.project] = { written_at_ms: newest, manifest_mtime_ms: mtimeMs };
			}
		}
	}
	state.first_seen = updateFirstSeen(state.first_seen, folders, nowMs);
	state.watermarks = watermarks;

	const code = o.code ?? codeSha(o.repo ?? REPO);
	const runId = `stall-${at.toISOString().replace(/[-:.]/g, "").slice(0, 18)}${env === "test" ? "-test" : ""}`;
	const source = sourceOf("folder-sync-stall/1", runId, code);
	const points = [];
	const health = healthPoint({ folders, env, t, source });
	if (pointDue(health, state.last_point, nowMs)) {
		points.push(health);
		state.last_point = { at: nowMs, key: pointKeyOf(health) };
	}
	points.push(...realUsePoints({ samples, env, t, source, labels: { folders: [...new Set(samples.map((s) => s.project))] } }));
	if (points.length) appendPoints(o.out ?? DEFAULT_OUT, points);

	const current = {};
	const causes = {};
	const lines = {};
	for (const f of folders) {
		current[`folder:${f.project}`] = f.state;
		causes[`folder:${f.project}`] = f.cause;
		lines[`folder:${f.project}`] = `${f.project}: ${f.detail}`;
	}
	const { episodes, fire, resolved } = nextEpisodes(state.episodes, current, { now: nowMs, causes });
	state.episodes = episodes;
	let sent = false;
	if (fire.length && o.notify !== false) {
		const text = alertText(fire.map((k) => lines[k]));
		sent = notify(text.title, text.body);
	}
	saveState(stateRoot, state);
	return { folders, points, samples, alerts: { fire, resolved, open: Object.keys(episodes), sent } };
}

// ------------------------------------------------------------------------------------------------------------- timer

export function unitFiles({ repo = REPO, node = existsSync("/usr/bin/node") ? "/usr/bin/node" : process.execPath } = {}) {
	const script = join(repo, "bench", "kpi", "stall.mjs");
	const service = `[Unit]
Description=folder-sync passive stall check: has a change been waiting to be pushed for 10 minutes while online?
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
# local files only: a check takes a second or two
TimeoutStartSec=2min
`;
	const timer = `[Unit]
Description=folder-sync passive stall check, every 5 minutes

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
		console.log(`# folder-sync-stall.service\n${service}\n# folder-sync-stall.timer\n${timer}`);
		return;
	}
	const units = join(HOME, ".config", "systemd", "user");
	mkdirSync(units, { recursive: true });
	writeFileSync(join(units, "folder-sync-stall.service"), service);
	writeFileSync(join(units, "folder-sync-stall.timer"), timer);
	const ctl = (...args) => { const d = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" }); if (d.status !== 0) throw new Error(`systemctl --user ${args.join(" ")}: ${d.stderr}`); return d.stdout; };
	ctl("daemon-reload");
	ctl("enable", "--now", "folder-sync-stall.timer");
	console.log(ctl("list-timers", "folder-sync-stall.timer", "--no-pager").trim());
}

function options(argv) {
	const o = { verb: "run", out: DEFAULT_OUT, env: "prod", notify: true, repo: REPO, print: false };
	const rest = [...argv];
	if (rest[0] && !rest[0].startsWith("--")) o.verb = rest.shift();
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === "--out") o.out = resolve(rest[++i]);
		else if (a === "--env") o.env = rest[++i];
		else if (a === "--no-notify") o.notify = false;
		else if (a === "--repo") o.repo = resolve(rest[++i]);
		else if (a === "--print") o.print = true;
		else throw new Error(`unknown argument ${a}`);
	}
	if (!["prod", "test"].includes(o.env)) throw new Error("--env is prod or test");
	return o;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	let code = 0;
	try {
		const o = options(process.argv.slice(2));
		if (o.verb === "install-timer") {
			installTimer(o);
		} else if (o.verb === "status") {
			const p = readSeries(o.out).filter((x) => x.kpi === "sync_stalled_folders").at(-1);
			console.log(p ? `sync_stalled_folders ${p.t}  ${p.labels?.result}  ${p.value ?? "-"}  pending ${p.labels?.pending ?? 0}  ${(p.labels?.stalled ?? []).map((s) => `${s.project}: ${s.detail}`).join(" | ")}` : "sync_stalled_folders never run");
			console.log(`open stall episodes: ${JSON.stringify(loadState(STATE_DIR).episodes)}`);
		} else if (o.verb === "run") {
			const machine = { cli: installedCli(), home: HOME, env: { ...process.env } };
			const ran = await withLock(join(STATE_DIR, "stall.lock"), () => check({ ...o, machine }), { staleMs: 10 * 60_000 });
			if (ran.skipped) {
				console.error(`stall: the previous check (pid ${ran.holder}) is still running; nothing to do`);
			} else {
				const { folders, alerts, samples, points } = ran.value;
				const by = (s) => folders.filter((f) => f.state === s);
				console.log(`folders: ${by("stalled").length} stalled, ${by("pending").length} pending, ${by("idle").length} idle, ${by("offline").length} offline of ${folders.filter((f) => f.state !== "skipped").length} watched; ${samples.length} pushed since the last check; ${points.length} point${points.length === 1 ? "" : "s"} written${by("stalled").map((f) => `\n  ${f.project}: ${f.detail}`).join("")}`);
				if (alerts.fire.length) console.log(`alert: ${alerts.sent ? "notified" : "NOT sent"} for ${alerts.fire.join(", ")}`);
			}
		} else {
			throw new Error("usage: node bench/kpi/stall.mjs [run|status|install-timer] [--out DIR] [--env prod|test] [--no-notify] [--print]");
		}
	} catch (error) {
		console.error(`stall: ${error instanceof Error ? error.message : error}`);
		code = 1;
	}
	process.exit(code);
}
