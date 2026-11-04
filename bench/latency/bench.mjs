#!/usr/bin/env node
// folder-sync's propagation KPI (Zach's objective O1): how long a change takes from one place to another, for every
// direction and every kind of change. A black box: it drives the folder-sync CLI exactly as a person runs it (`init`,
// then `sync --watch` in the background) and watches only what a person would see, so a change to the CLI or the Worker
// (PEP 0004's push sync, say) moves the number without touching this file.
//
// Zach, 2026-10-28: "Please add a KPI for the folder sync project which is tracking the time to sync from local to
// online and the time from online to local ... thats really kinda key performance indicator I want to continue to
// work on." Zach, 2026-11-04 (objectives): "Fast: propagation p50 <= 1 s, p95 <= 3 s, save -> bytes on the other disk
// and online; add/edit/delete/rename; machine<->machine and machine<->web", "in production as well as testing".
//
//   node bench/latency/bench.mjs run [--stack local|prod] [--trials 6] [--out DIR] [--no-kpi] [--cli PATH] [--json FILE]
//   node bench/latency/bench.mjs install-timer      the hourly local-stack run alone, as a systemd --user timer (idempotent;
//                                                    bench/kpi/run-all.mjs install-timer is the one that runs everything)
//
// Two writers, `--trials` samples each (default 6). A sample is a file taken through add, edit, rename, delete, each op
// started at a random phase of the machine's sync interval, each op's clock started just before the write:
// - machine A writes in its synced folder (add = write-then-rename as an editor saves; edit = the same path with new bytes;
//   rename = mv; delete = rm). Two readers race the one write, so one write gives two directions:
//     machine->web      GET /fs/v1/folders/<project>/files/<A>/<path> (every 50 ms): 200 with the same bytes, or for a delete
//                       / the old name of a rename, 404
//     machine->machine  machine B's disk <folder>/hosts/<A>/<path> (every 10 ms): the same bytes, or the path gone
// - the web host writes (PUT /fs/v1/folders/<project>/web/<path>, the call a page makes; DELETE for delete; a web rename is
//   what a page does, PUT the new name then DELETE the old, clock from before the PUT): web->machine, A's disk
//   <folder>/hosts/<web host>/<path>.
// A clock stops only when the reader holds the end state, so each number is what a person waits. After three ops in a
// row that never arrive a sample stops waiting (the rest are recorded as timeouts), so a broken stack costs minutes, not hours.
//
// --stack local (env=test; the default and the hourly run): accounts/scripts/dev.mjs stands up the whole stack on
// loopback (rclone serve s3, the R2 stand-in, `wrangler dev` with a local D1) in a fresh temp dir, a test person signs in
// by email code, two throwaway HOMEs run `folder-sync login`, and everything is stopped and deleted afterwards. Ports
// 4950-4953 unless FS_STANDIN_PORT / FS_STORE_PORT / FS_ACCOUNTS_PORT / FS_INSPECTOR_PORT say otherwise.
// --stack prod (env=prod): this machine's own signed-in session (~/.folder-sync/account.json, never printed or copied;
// the second machine reaches it through FOLDER_SYNC_ACCOUNT_PROCESS) and its server, in one throwaway project,
// `bench-latency`. It never touches another project. If the account is over its storage quota, writes would be held, so
// the run records failed points saying so instead of waiting out timeouts.
//
// Out (unless --no-kpi): Vibe Tracks producer files in --out (default ~/vt/zach/producers/folder-sync): kpi_catalog.json
// (rewritten), kpi_series.jsonl and runs_table.jsonl (appended). The legacy sync_up_ms / sync_down_ms points (machine->web
// add, web->machine add) are still written beside the propagation_* points. The CLI is built from this checkout unless --cli.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { catalog } from "../kpi/catalog.mjs";
import { appendPoints, codeSha, DEFAULT_OUT, percentile, sourceOf, stampOf } from "../kpi/lib.mjs";
import { propagationPoints } from "../kpi/propagation.mjs";
import { HOME, localStack, now, Online, prodStack, PROJECT, REPO, sleep } from "./harness.mjs";

export { percentile };
const BENCH_VERSION = "folder-sync-latency/2";
const LEGACY_VERSION = "folder-sync-latency/1";

// ------------------------------------------------------------------------------------------------ options

function options(argv) {
	const o = { verb: argv[0] || "run", stack: "local", trials: 6, out: DEFAULT_OUT, kpi: true, cli: null, json: null, timeoutS: 60 };
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

/** Polls `probe` every `every` ms until it is true or `deadline`; the ms since t0, or null. */
async function settle(probe, t0, deadline, every) {
	while (now() < deadline) {
		const started = now();
		if (await probe()) return Math.round(now() - t0);
		await sleep(Math.max(0, every - (now() - started)));
	}
	return null;
}

/** The end state a reader must hold: these paths have these bytes (`null` = the path is gone). */
const holds = (check, states) => async () => {
	for (const [path, bytes] of states) if (!(await check(path, bytes))) return false;
	return true;
};

/** Runs one chain of ops; `ops` is [{op, act, readers: [{direction, probe, every}]}]. After three ops in a row nobody
 *  received, the rest are recorded as timeouts without waiting. */
async function chain(ops, id, interval, timeoutMs, onRow) {
	let dead = 0;
	for (const step of ops) {
		const row = (reader, ms, extra = {}) => onRow({ direction: reader.direction, op: step.op, id, ms, ...(ms === null ? { timeout: true } : {}), ...extra });
		if (dead >= 3) {
			for (const reader of step.readers) row(reader, null, { skipped: "three earlier ops in this sample never arrived" });
			continue;
		}
		// WHY a random wait across a whole interval: an op started at one fixed phase of the round timer would
		// measure that phase, not what a person sees
		await sleep(200 + Math.random() * interval);
		const t0 = now();
		let extra = {};
		try {
			extra = (await step.act()) || {};
		} catch (error) {
			for (const reader of step.readers) row(reader, null, { error: String(error.message || error).slice(0, 200) });
			dead++;
			continue;
		}
		const deadline = t0 + timeoutMs;
		const results = await Promise.all(step.readers.map((reader) => settle(reader.probe, t0, deadline, reader.every)));
		step.readers.forEach((reader, i) => row(reader, results[i], extra));
		dead = results.every((ms) => ms === null) ? dead + 1 : 0;
	}
}

/** Machine A's sample: one file through add, edit, rename, delete; machine->web and machine->machine race each write. */
function machineChain(ctx, id) {
	const { A, B, online, host } = ctx;
	const rel = `bench/${id}.txt`;
	const moved = `bench/${id}-renamed.txt`;
	const v1 = body(`${id}-1`);
	const v2 = body(`${id}-2`);
	const put = (path, bytes) => {
		const target = join(A.folder, path);
		mkdirSync(dirname(target), { recursive: true });
		// WHY write-then-rename: an editor's save; the watcher never sees a half-written file
		writeFileSync(`${target}.tmp~`, bytes);
		renameSync(`${target}.tmp~`, target);
	};
	const web = (states) => ({ direction: "machine->web", every: 50, probe: holds(async (path, bytes) => {
		const got = await online.get(host, path);
		return bytes ? got.status === 200 && got.bytes.equals(bytes) : got.status === 404;
	}, states) });
	const disk = (states) => ({ direction: "machine->machine", every: 10, probe: holds(async (path, bytes) => {
		const file = join(B.folder, "hosts", host, path);
		return bytes ? same(file, bytes) : !existsSync(file);
	}, states) });
	const readers = (states) => [web(states), ...(B ? [disk(states)] : [])];
	return [
		{ op: "add", act: () => put(rel, v1), readers: readers([[rel, v1]]) },
		{ op: "edit", act: () => put(rel, v2), readers: readers([[rel, v2]]) },
		{ op: "rename", act: () => renameSync(join(A.folder, rel), join(A.folder, moved)), readers: readers([[moved, v2], [rel, null]]) },
		{ op: "delete", act: () => rmSync(join(A.folder, moved)), readers: readers([[moved, null]]) },
	];
}

/** The web host's sample: PUT / PUT / PUT+DELETE / DELETE; web->machine is A's disk under hosts/<web host>/. */
function webChain(ctx, id) {
	const { A, online, webHost } = ctx;
	const rel = `bench/${id}.txt`;
	const moved = `bench/${id}-renamed.txt`;
	const v1 = body(`${id}-1`);
	const v2 = body(`${id}-2`);
	const disk = (states) => ({ direction: "web->machine", every: 10, probe: holds(async (path, bytes) => {
		const file = join(A.folder, "hosts", webHost, path);
		return bytes ? same(file, bytes) : !existsSync(file);
	}, states) });
	return [
		{ op: "add", act: async () => ({ put_ms: await timed(() => online.put(rel, v1)) }), readers: [disk([[rel, v1]])] },
		{ op: "edit", act: async () => ({ put_ms: await timed(() => online.put(rel, v2)) }), readers: [disk([[rel, v2]])] },
		{ op: "rename", act: async () => ({ put_ms: await timed(async () => { await online.put(moved, v2); await online.remove(rel); }) }), readers: [disk([[moved, v2], [rel, null]])] },
		{ op: "delete", act: async () => ({ put_ms: await timed(() => online.remove(moved)) }), readers: [disk([[moved, null]])] },
	];
}

async function timed(fn) {
	const t0 = now();
	await fn();
	return Math.round(now() - t0);
}

function summary(rows) {
	const ms = rows.map((t) => t.ms).filter((x) => typeof x === "number");
	return { n: ms.length, timeouts: rows.length - ms.length, p50: percentile(ms, 50), p95: percentile(ms, 95), max: ms.length ? Math.max(...ms) : null, min: ms.length ? Math.min(...ms) : null };
}

async function measure(o) {
	const code = codeSha();
	const sha = code.dirty ? `${code.sha}+dirty` : code.sha;
	const started = new Date();
	const result = { stack: o.stack, env: o.stack === "local" ? "test" : "prod", server: null, code: { ...code, label: sha }, started: started.toISOString(), trials: [], samples: o.trials, refused: null };
	if (o.stack === "prod") {
		if (!existsSync(join(HOME, ".folder-sync", "account.json"))) throw new Error("prod is unmeasured: this machine is not signed in (no ~/.folder-sync/account.json); run folder-sync login");
		const account = JSON.parse(readFileSync(join(HOME, ".folder-sync", "account.json"), "utf8"));
		result.server = account.server;
		const usage = await new Online(account.server, account.token).usage();
		// WHY not try anyway: over its quota the account holds every upload, so each op would wait out its timeout and say
		// nothing the quota does not say better (and nothing is initialised or written online before this check)
		if (usage.over) {
			result.refused = `account is over its storage quota, so writes are held: ${usage.over}`.slice(0, 300);
			console.error(`prod refused: ${result.refused}`);
			return finish(result);
		}
	}
	const stack = o.stack === "local" ? await localStack({ cli: o.cli, sha: code.sha, machines: 2 }) : prodStack({ cli: o.cli, sha: code.sha, second: true });
	result.server = stack.server;
	const [A, B] = stack.machines;
	const online = new Online(stack.server, stack.token || A.token());
	try {
		const host = A.hostId();
		// WHY a file that stays: deleting every bench file would leave the folder empty, and folder-sync's
		// empty-folder guard (rightly) refuses to push a round that deletes everything, so the tidy would never land
		const keep = join(A.folder, "README.txt");
		if (!existsSync(keep)) writeFileSync(keep, "folder-sync's propagation bench (bench/latency/bench.mjs) writes and deletes its trial files here.\n");
		// Set-up, never timed: A has pushed once, the web host exists, and both machines know every host (else the first
		// trial would wait for host discovery, every 5 min, which is the "new machine" path, not this one)
		A.must(["sync", "--once", "--dir", A.folder]);
		const warm = `warmup-${Date.now()}`;
		const made = await online.put(`bench/${warm}.txt`, body(warm));
		const webHost = made.host;
		A.must(["sync", "--once", "--discover", "--dir", A.folder]);
		B.must(["sync", "--once", "--discover", "--dir", B.folder]);
		await A.watch();
		await B.watch();
		const interval = A.intervalMs();
		result.interval_ms = interval;
		result.web_host = webHost;
		await sleep(1500); // each machine's first round (a reconcile) runs now; trials start after it
		const stamp = Date.now().toString(36);
		const ctx = { A, B, online, host, webHost };
		const timeoutMs = o.timeoutS * 1000;
		for (let n = 0; n < o.trials; n++) {
			await chain(machineChain(ctx, `m-${stamp}-${n}`), `m-${stamp}-${n}`, interval, timeoutMs, (row) => result.trials.push(row));
			console.error(`machine sample ${n + 1}/${o.trials}: ${result.trials.slice(-8).map((t) => `${t.direction.split("->")[1][0]}:${t.op}=${t.ms ?? "x"}`).join(" ")}`);
		}
		for (let n = 0; n < o.trials; n++) {
			await chain(webChain(ctx, `w-${stamp}-${n}`), `w-${stamp}-${n}`, interval, timeoutMs, (row) => result.trials.push(row));
			console.error(`web sample ${n + 1}/${o.trials}: ${result.trials.slice(-4).map((t) => `${t.op}=${t.ms ?? "x"}`).join(" ")}`);
		}
		// tidy: the chains delete their own files; the warm-up file is the one left (prod: folder-sync moves it to history)
		await online.remove(`bench/${warm}.txt`);
		if (o.stack === "prod") await sleep(interval + 3000);
	} finally {
		await A.stop();
		await B.stop();
		stack.teardown();
	}
	return finish(result);
}

function finish(result) {
	result.finished = new Date().toISOString();
	// the legacy shapes: sync_up_ms = machine->web add, sync_down_ms = web->machine add
	result.up = result.trials.filter((t) => t.direction === "machine->web" && t.op === "add");
	result.down = result.trials.filter((t) => t.direction === "web->machine" && t.op === "add");
	result.summary = { up: summary(result.up), down: summary(result.down) };
	return result;
}

// ------------------------------------------------------------------------------------------------ Vibe Tracks

/** The legacy points: sync_up_ms / sync_down_ms and their p95, exactly as the bench has always written them. */
export function points(result, runId, t) {
	const out = [];
	const host = hostname();
	const source = { code_sha: result.code.label, bench_version: LEGACY_VERSION, run_ids: [runId], dirty: result.code.dirty };
	for (const [dir, s] of [["up", result.summary.up], ["down", result.summary.down]]) {
		for (const [kpi, value] of [[`sync_${dir}_ms`, s.p50], [`sync_${dir}_ms_p95`, s.p95]]) {
			const labels = { stack: result.stack, n: s.n, p50: s.p50, p95: s.p95, max: s.max, timeouts: s.timeouts, interval_ms: result.interval_ms, host, branch: result.code.branch, code_sha: result.code.label };
			const base = { schema: "vt-kpi-point/1", kpi, t, value, n: s.n, status: value === null ? "not_measured" : "measured", labels, source };
			// WHY the unsliced (headline) point is the local stack only: it runs every hour on the same machine, so
			// its trend is the code's; prod is its own line, never mixed in
			// (and the code_sha slice too, so one version's local numbers are never averaged with prod's)
			out.push({ ...base, slice: { stack: result.stack } });
			if (result.stack === "local") out.push(base, { ...base, slice: { code_sha: result.code.label } });
		}
	}
	return out;
}

export function runRow(result, runId, t) {
	const by = (direction, op) => summary(result.trials.filter((x) => x.direction === direction && (op === "mixed" || x.op === op)));
	const metrics = { samples: result.samples, duration_s: Math.round((Date.parse(result.finished) - Date.parse(result.started)) / 100) / 10 };
	for (const [tag, direction] of [["m2m", "machine->machine"], ["m2w", "machine->web"], ["w2m", "web->machine"]]) {
		const s = by(direction, "mixed");
		Object.assign(metrics, { [`${tag}_n`]: s.n, [`${tag}_p50_ms`]: s.p50, [`${tag}_p95_ms`]: s.p95, [`${tag}_max_ms`]: s.max, [`${tag}_timeouts`]: s.timeouts });
	}
	return {
		schema: "vt-run/1",
		run_id: runId,
		t,
		facets: { stack: result.stack, env: result.env, code_sha: result.code.label, branch: result.code.branch, dirty: result.code.dirty, host: hostname(), server: result.server, interval_ms: result.interval_ms ?? null, refused: result.refused },
		metrics,
		trials: Object.fromEntries(["machine->machine", "machine->web", "web->machine"].map((d) => [d, result.trials.filter((x) => x.direction === d).map((x) => ({ op: x.op, ms: x.ms }))])),
	};
}

export function writeKpi(dir, result) {
	mkdirSync(dir, { recursive: true });
	const t = stampOf(new Date(result.finished));
	const runId = `latency-${result.stack}-${result.finished.replace(/[-:]/g, "").slice(0, 15)}-${result.code.label}`;
	const tmp = join(dir, `.kpi_catalog.json.${process.pid}`);
	writeFileSync(tmp, `${JSON.stringify(catalog(t), null, 1)}\n`);
	renameSync(tmp, join(dir, "kpi_catalog.json"));
	const source = sourceOf(BENCH_VERSION, runId, { sha: result.code.sha, dirty: result.code.dirty });
	const labels = { stack: result.stack, host: hostname(), branch: result.code.branch, interval_ms: result.interval_ms ?? null, samples: result.samples, bench: "bench/latency/bench.mjs" };
	const rows = result.refused
		? ["machine->machine", "machine->web", "web->machine"].flatMap((direction) => ["add", "edit", "delete", "rename"].map((op) => ({ direction, op, ms: null, timeout: true })))
		: result.trials;
	const fresh = [
		...(result.refused ? [] : points(result, runId, t)),
		...propagationPoints(rows, { env: result.env, t, source, labels, failReason: result.refused }),
	];
	appendPoints(dir, fresh);
	appendFileSync(join(dir, "runs_table.jsonl"), `${JSON.stringify(runRow(result, runId, t))}\n`);
	return runId;
}

// ------------------------------------------------------------------------------------------------ the timer

function installTimer() {
	const units = join(HOME, ".config", "systemd", "user");
	mkdirSync(units, { recursive: true });
	const go = process.env.GO || join(HOME, ".local", "go", "bin", "go");
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

/** One run: measure, write the KPI files, return what run-all.mjs and the CLI print. */
export async function run(o) {
	const result = await measure(o);
	if (o.json) writeFileSync(o.json, JSON.stringify(result, null, 1));
	if (o.kpi) result.run_id = writeKpi(o.out, result);
	return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	let code = 0;
	try {
		const o = options(process.argv.slice(2));
		if (o.verb === "install-timer") {
			installTimer();
		} else if (o.verb === "run") {
			const result = await run(o);
			const cell = (d) => summary(result.trials.filter((t) => t.direction === d));
			console.log(JSON.stringify({ stack: result.stack, code_sha: result.code.label, interval_ms: result.interval_ms ?? null, run_id: result.run_id ?? null, refused: result.refused, "machine->machine": cell("machine->machine"), "machine->web": cell("machine->web"), "web->machine": cell("web->machine") }));
		} else {
			throw new Error("usage: node bench/latency/bench.mjs run|install-timer [options]");
		}
	} catch (error) {
		console.error(`bench: ${error instanceof Error ? error.message : error}`);
		code = 1;
	}
	process.exit(code);
}
