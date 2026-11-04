#!/usr/bin/env node
// Every folder-sync objective KPI, one idempotent command, safe to run hourly (Zach, 2026-11-04: "For all of the KPIs we
// should where applicable monitor in production as well as testing"). Appends vt-kpi-point/1 lines to
// ~/vt/zach/producers/folder-sync/kpi_series.jsonl and rewrites kpi_catalog.json.
//
//   node bench/kpi/run-all.mjs [run] [--only a,b] [--force] [--out DIR] [--dry-run]
//   node bench/kpi/run-all.mjs status             what is due and when each stage last wrote a point
//   node bench/kpi/run-all.mjs install-timer      folder-sync-kpi.service + .timer (hourly) in ~/.config/systemd/user, enabled;
//                                                 replaces folder-sync-latency.timer (this covers its run)
//
// Stages, each with its own cadence (a stage is skipped while its newest point is younger than that), so an hourly timer
// costs a few minutes and the 10-minute idle window runs twice a day:
//   propagation-test   O1 test  : bench/latency/bench.mjs --stack local  (3 directions x add/edit/delete/rename)   50 min
//   propagation-prod   O1 prod  : the same against the deployed Worker and R2 (bench-latency project)               50 min
//   usage-prod         O2 prod  : GET /fs/v1/usage -> H and its 30-day max                                          50 min
//   offshelf           O1 vs    : bench/fast's newest summary -> propagation_* with slice.tool                      once per summary
//   storage-test       O2 test  : the deterministic workload -> H                                                   6 h
//   ops                O3 idle  : idle CPU and requests, per-change counters (10 min idle window)                   12 h
//   idle-prod          O3 idle  : the real daemons' CPU, observed 30 s                                              6 h
//   cost               O3 cost  : prices x counters x H -> $ per GB-month and per person-month, per provider        50 min
// A stage that throws writes failed points saying why (a gap in a chart is a worse answer than a red point). Exit 1 if any did.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changesPerDay, costPoints } from "../cost/cost.mjs";
import { run as propagation } from "../latency/bench.mjs";
import { fetchUsage, usagePoints } from "./usage.mjs";
import { appendPoints, codeSha, DEFAULT_OUT, makePoint, readSeries, REPO, STATE_DIR, stampOf, withLock } from "./lib.mjs";
import { catalog } from "./catalog.mjs";
import { loadSummary, newestSummary, offShelfPoints } from "./offshelf.mjs";
import { observe } from "./idle-prod.mjs";
import { loadCounters, run as opsRun } from "./ops.mjs";
import { run as storageTest, WORKLOAD } from "./storage-test.mjs";

const MIN = 60_000;

const sliceHas = (p, want) => Object.entries(want).every(([k, v]) => p.slice?.[k] === v);
const lastWrite = (series, kpi, slice) => series.filter((p) => p.kpi === kpi && sliceHas(p, slice)).map((p) => Date.parse(p.t)).sort((a, b) => b - a)[0] ?? 0;

/** The failed points a stage writes when it throws: one per KPI/slice it would have written. */
function failures(stage, reason, at = new Date()) {
	const source = { code_sha: codeSha().sha, bench_version: "folder-sync-kpi-run-all/1", run_ids: [`${stage.id}-error-${at.toISOString().slice(0, 16).replace(/[-:]/g, "")}`], dirty: false };
	return stage.marks.map(({ kpi, slice }) => makePoint({ kpi, value: null, n: 0, t: stampOf(at), source, slice, reason: `stage ${stage.id} failed: ${reason}`.slice(0, 400) }));
}

export function stages(o) {
	return [
		{ id: "propagation-test", every: 50 * MIN, marks: [{ kpi: "propagation_p50_ms", slice: { env: "test", direction: "machine->machine", op: "mixed" } }], run: () => propagation({ stack: "local", trials: 6, out: o.out, kpi: true, cli: null, json: null, timeoutS: 60 }) },
		{ id: "propagation-prod", every: 50 * MIN, marks: [{ kpi: "propagation_p50_ms", slice: { env: "prod", direction: "machine->web", op: "mixed" } }], run: () => propagation({ stack: "prod", trials: 6, out: o.out, kpi: true, cli: null, json: null, timeoutS: 60 }) },
		{
			id: "usage-prod", every: 50 * MIN, marks: [{ kpi: "storage_efficiency_h", slice: { env: "prod" } }],
			run: async () => {
				const got = await fetchUsage();
				appendPoints(o.out, usagePoints({ ...got, series: readSeries(o.out), code: codeSha() }));
			},
		},
		{
			id: "offshelf", every: Infinity, marks: [{ kpi: "propagation_p50_ms", slice: { env: "test", workload: "1k" } }],
			due: (series) => { const f = newestSummary(); if (!f) return false; const s = loadSummary(f); return !series.some((p) => p.source?.run_ids?.[0]?.startsWith(`fast-${s.tag}-`)); },
			run: async () => { const s = loadSummary(newestSummary()); appendPoints(o.out, offShelfPoints(s, { t: s.generated })); },
		},
		{ id: "storage-test", every: 6 * 60 * MIN, marks: [{ kpi: "storage_efficiency_h", slice: { env: "test", workload: WORKLOAD } }], run: () => storageTest({ out: o.out, kpi: true }) },
		{ id: "ops", every: 12 * 60 * MIN, marks: [{ kpi: "idle_cpu_pct", slice: { env: "test" } }, { kpi: "idle_ops_per_hour", slice: { env: "test", kind: "per_machine" } }], run: () => opsRun({ out: o.out, kpi: true }) },
		{ id: "idle-prod", every: 6 * 60 * MIN, marks: [{ kpi: "idle_cpu_pct", slice: { env: "prod", kind: "observed" } }], run: async () => { appendPoints(o.out, [await observe({ code: codeSha() })]); } },
		{
			id: "cost", every: 50 * MIN, marks: [{ kpi: "cost_per_person_month_usd", slice: { env: "test", provider: "r2", profile: "reference" } }, { kpi: "cost_per_person_month_usd", slice: { env: "prod", provider: "r2", profile: "average" } }],
			run: async () => {
				const got = await fetchUsage();
				let folders = null;
				if (got.usage) {
					try {
						const account = JSON.parse(readFileSync(join(homedir(), ".folder-sync", "account.json"), "utf8"));
						const answer = await fetch(`${account.server}/fs/v1/folders`, { headers: { Authorization: `Bearer ${account.token}` } });
						if (answer.status === 200) folders = await answer.json();
					} catch { /* the average profile falls back to one machine */ }
				}
				appendPoints(o.out, costPoints({ counters: loadCounters(), series: readSeries(o.out), usage: got.usage, folders, logs: changesPerDay() }));
			},
		},
	];
}

function options(argv) {
	const o = { verb: "run", only: null, force: false, out: DEFAULT_OUT, dry: false, repo: REPO };
	const rest = [...argv];
	if (rest[0] && !rest[0].startsWith("--")) o.verb = rest.shift();
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === "--only") o.only = rest[++i].split(",");
		else if (a === "--force") o.force = true;
		else if (a === "--out") o.out = resolve(rest[++i]);
		else if (a === "--dry-run") o.dry = true;
		else if (a === "--repo") o.repo = resolve(rest[++i]);
		else throw new Error(`unknown argument ${a}`);
	}
	return o;
}

function dueIn(stage, series, o, at = Date.now()) {
	if (o.only && !o.only.includes(stage.id)) return { due: false, why: "not selected" };
	if (o.force) return { due: true, why: "forced" };
	if (stage.due) return { due: stage.due(series), why: stage.due(series) ? "new summary" : "already emitted" };
	const last = Math.max(...stage.marks.map((m) => lastWrite(series, m.kpi, m.slice)));
	const age = at - last;
	return age >= stage.every ? { due: true, why: last ? `last ${Math.round(age / MIN)} min ago` : "never run" } : { due: false, why: `last ${Math.round(age / MIN)} min ago, every ${Math.round(stage.every / MIN)}` };
}

async function runAll(o) {
	mkdirSync(o.out, { recursive: true });
	const results = [];
	for (const stage of stages(o)) {
		const series = readSeries(o.out);
		const { due, why } = dueIn(stage, series, o);
		if (!due) { results.push({ stage: stage.id, ran: false, why }); continue; }
		if (o.dry) { results.push({ stage: stage.id, ran: false, would_run: true, why }); continue; }
		const started = Date.now();
		try {
			await stage.run();
			results.push({ stage: stage.id, ran: true, ok: true, s: Math.round((Date.now() - started) / 1000) });
		} catch (error) {
			const reason = String(error?.message || error);
			console.error(`run-all: ${stage.id} failed: ${reason}`);
			appendPoints(o.out, failures(stage, reason));
			results.push({ stage: stage.id, ran: true, ok: false, error: reason.slice(0, 200), s: Math.round((Date.now() - started) / 1000) });
		}
	}
	if (!o.dry) {
		const tmp = join(o.out, `.kpi_catalog.json.${process.pid}`);
		writeFileSync(tmp, `${JSON.stringify(catalog(stampOf(new Date())), null, 1)}\n`);
		renameSync(tmp, join(o.out, "kpi_catalog.json"));
	}
	return results;
}

function installTimer(o) {
	const units = join(homedir(), ".config", "systemd", "user");
	mkdirSync(units, { recursive: true });
	const go = process.env.GO || join(homedir(), ".local", "go", "bin", "go");
	const node = process.env.NODE || (existsSync("/usr/bin/node") ? "/usr/bin/node" : process.execPath);
	const script = join(o.repo, "bench", "kpi", "run-all.mjs");
	const service = `[Unit]
Description=folder-sync objective KPIs (O1 propagation, O2 storage efficiency, O3 cost), test and production, into Vibe Tracks
Documentation=file://${o.repo}/docs/KPI.md

[Service]
Type=oneshot
# written by ${script} install-timer (--repo picks the checkout it runs from); run it again to change it
WorkingDirectory=${o.repo}
Environment=PATH=${dirname(go)}:${dirname(node)}:/usr/local/bin:/usr/bin:/bin
Environment=GO=${go}
ExecStart=${node} ${script} run
Nice=10
TimeoutStartSec=50min
`;
	const timer = `[Unit]
Description=folder-sync objective KPIs, hourly

[Timer]
OnCalendar=hourly
RandomizedDelaySec=300
Persistent=true

[Install]
WantedBy=timers.target
`;
	writeFileSync(join(units, "folder-sync-kpi.service"), service);
	writeFileSync(join(units, "folder-sync-kpi.timer"), timer);
	const ctl = (...args) => { const d = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" }); if (d.status !== 0) throw new Error(`systemctl --user ${args.join(" ")}: ${d.stderr}`); return d.stdout; };
	ctl("daemon-reload");
	// WHY the old timer is switched off: two hourly timers would run the same local stack on the same ports (4950-4953) at
	// once. propagation-test is the old timer's run, with the new directions added. Its unit file stays, so
	// `node bench/latency/bench.mjs install-timer` brings it back.
	spawnSync("systemctl", ["--user", "disable", "--now", "folder-sync-latency.timer"], { encoding: "utf8" });
	ctl("enable", "--now", "folder-sync-kpi.timer");
	console.log(ctl("list-timers", "folder-sync-kpi.timer", "--no-pager").trim());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	let code = 0;
	try {
		const o = options(process.argv.slice(2));
		if (o.verb === "install-timer") {
			installTimer(o);
		} else if (o.verb === "status") {
			const series = readSeries(o.out);
			for (const s of stages(o)) { const d = dueIn(s, series, o); console.log(`${s.id.padEnd(18)} ${d.due ? "DUE " : "ok  "} ${d.why}`); }
		} else if (o.verb === "run") {
			const lock = await withLock(join(STATE_DIR, "run-all.lock"), () => runAll(o));
			if (lock.skipped) { console.error(`run-all: another run (pid ${lock.holder}) holds the lock; nothing to do`); }
			else { console.log(JSON.stringify(lock.value)); if (lock.value.some((r) => r.ok === false)) code = 1; }
		} else {
			throw new Error("usage: node bench/kpi/run-all.mjs [run|status|install-timer] [--only a,b] [--force] [--out DIR] [--dry-run]");
		}
	} catch (error) {
		console.error(`run-all: ${error instanceof Error ? error.message : error}`);
		code = 1;
	}
	process.exit(code);
}
