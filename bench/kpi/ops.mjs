// O3 idle and per-change counters: what an idle synced folder costs (CPU and requests) and what one change costs, measured
// on the local stack with two machines. Feeds idle_cpu_pct, idle_ops_per_hour and the cost model's counters
// (~/.local/state/folder-sync-kpi/cost_counters.json).
//
// Requests are counted from the stack's own logs, as bench/fast did (PEP 0008 §4): the R2 stand-in's gate.jsonl (one line per
// storage call, classed A = writes and lists, B = reads, deletes free: R2's billing classes) and wrangler dev's accounts.log
// (one line per Worker request). A Durable Object message is not observable locally, so the model assumes it (counters.assumed).
// CPU is the watcher's whole process tree from /proc: utime + stime of every live process and the rolled-up cutime + cstime of
// the children each has reaped, so the short-lived rclone it starts count.
//
//   node bench/kpi/ops.mjs [--idle-s 600] [--changes 12] [--out DIR] [--no-kpi] [--cli PATH]
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localStack, Online, sleep, now } from "../latency/harness.mjs";
import { appendPoints, codeSha, DEFAULT_OUT, makePoint, sourceOf, STATE_DIR, stampOf } from "./lib.mjs";
import { randomBytes } from "node:crypto";

const BENCH_VERSION = "folder-sync-kpi-ops/1";
const CLK_TCK = Number(spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout) || 100;
export const COUNTERS_FILE = join(STATE_DIR, "cost_counters.json");

// ------------------------------------------------------------------------------------------------ CPU

/** pid -> {ppid, ticks} for every process (u + s + cu + cs, in clock ticks). */
function table() {
	const out = new Map();
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		try {
			const stat = readFileSync(`/proc/${name}/stat`, "utf8");
			const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // fields from 3: state ppid ...
			const f = (n) => Number(rest[n - 3]);
			out.set(Number(name), { ppid: f(4), ticks: f(14) + f(15) + f(16) + f(17) });
		} catch { /* gone */ }
	}
	return out;
}

/** Clock ticks used so far by `root` and everything live below it, plus what they reaped. */
export function treeTicks(root) {
	const procs = table();
	const kids = new Map();
	for (const [pid, p] of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), pid]);
	let total = 0;
	const walk = (pid) => {
		total += procs.get(pid)?.ticks ?? 0;
		for (const k of kids.get(pid) ?? []) walk(k);
	};
	if (procs.has(root)) walk(root);
	return total;
}

// ------------------------------------------------------------------------------------------------ request logs

function sizeOf(file) {
	return existsSync(file) ? statSync(file).size : 0;
}

function tail(file, from) {
	const size = sizeOf(file);
	if (size <= from) return "";
	const buf = Buffer.alloc(size - from);
	const fd = openSync(file, "r");
	readSync(fd, buf, 0, buf.length, from);
	closeSync(fd);
	return buf.toString("utf8");
}

/** R2's billing classes (docs/CONTRACT.md, PEP 0008): A = writes and lists, B = reads; deletes are free. */
export function classOf(op) {
	if (["GetObject", "HeadObject", "HeadBucket"].includes(op)) return "class_b";
	if (["DeleteObject", "AbortMultipartUpload"].includes(op)) return "free";
	return "class_a";
}

export function countRequests({ gate, worker }) {
	const s3 = { class_a: 0, class_b: 0, free: 0 };
	for (const line of gate.split("\n")) {
		if (!line.trim()) continue;
		try { s3[classOf(JSON.parse(line).op)]++; } catch { /* a torn line */ }
	}
	// wrangler dev logs one line per request it answers: "[wrangler:info] GET /fs/... 200 OK (12ms)"
	const workerN = worker.split("\n").filter((l) => /\b(GET|PUT|POST|DELETE|HEAD|PATCH|OPTIONS) \/\S* \d{3}\b/.test(l)).length;
	return { ...s3, worker: workerN };
}

class Mark {
	constructor(stack, machines) {
		this.stack = stack;
		this.machines = machines;
		this.t = now();
		this.gate = sizeOf(stack.gateLog);
		this.workerLog = sizeOf(stack.workerLog);
		this.ticks = machines.map((m) => treeTicks(m.watcher.pid));
	}

	read() {
		const seconds = (now() - this.t) / 1000;
		const counts = countRequests({ gate: tail(this.stack.gateLog, this.gate), worker: tail(this.stack.workerLog, this.workerLog) });
		const cpu = this.machines.map((m, i) => ((treeTicks(m.watcher.pid) - this.ticks[i]) / CLK_TCK / seconds) * 100);
		return { seconds, counts, cpu_pct_per_machine: cpu };
	}
}

// ------------------------------------------------------------------------------------------------ the measurement

const r3 = (x) => Math.round(x * 1000) / 1000;

export async function measureOps({ cli = null, sha, idleS = 600, changes = 12, changeKb = 50, log = () => {} }) {
	const stack = await localStack({ cli, sha, machines: 2, prefix: "folder-sync-ops-" });
	try {
		const [A, B] = stack.machines;
		const online = new Online(stack.server, A.token());
		const host = A.hostId();
		writeFileSync(join(A.folder, "README.txt"), "folder-sync's ops bench (bench/kpi/ops.mjs).\n");
		A.must(["sync", "--once", "--dir", A.folder]);
		B.must(["sync", "--once", "--discover", "--dir", B.folder]);
		await A.watch();
		await B.watch();
		await sleep(20_000); // initial reconcile rounds and discovery settle; the window starts on a quiet stack

		log(`idle window ${idleS} s`);
		const idleMark = new Mark(stack, [A, B]);
		await sleep(idleS * 1000);
		const idle = idleMark.read();
		const hours = idle.seconds / 3600;
		const perMachineHour = (n) => n / hours / 2;

		// per-change: N changes of changeKb, spaced so each one's rounds finish before the next. Phase W: only A runs;
		// phase R: B runs too. A change is `settled` once the online copy (and, in R, B's disk) holds the bytes.
		const idleRate = { class_a: idle.counts.class_a / idle.seconds, class_b: idle.counts.class_b / idle.seconds, worker: idle.counts.worker / idle.seconds };
		const phase = async (name, machines) => {
			const mark = new Mark(stack, machines);
			for (let i = 0; i < changes; i++) {
				const rel = `ops/${name}-${i}.bin`;
				const bytes = randomBytes(changeKb * 1024);
				mkdirSync(dirname(join(A.folder, rel)), { recursive: true });
				writeFileSync(join(A.folder, `${rel}.tmp~`), bytes);
				renameSync(join(A.folder, `${rel}.tmp~`), join(A.folder, rel));
				const deadline = now() + 60_000;
				for (;;) {
					const got = await online.get(host, rel);
					const onB = machines.length < 2 || (existsSync(join(B.folder, "hosts", host, rel)) && readFileSync(join(B.folder, "hosts", host, rel)).equals(bytes));
					if (got.status === 200 && got.bytes.equals(bytes) && onB) break;
					if (now() > deadline) throw new Error(`${rel} never settled in phase ${name}`);
					await sleep(50);
				}
				await sleep(8000); // trailing calls of the round (manifest, change record, hub) land before the next change
			}
			const read = mark.read();
			// WHY the idle rate is subtracted: the window includes the machines' own polling; what is left is what the changes cost
			const net = (k) => Math.max(0, read.counts[k] - idleRate[k] * read.seconds * (machines.length / 2));
			return { class_a: net("class_a") / changes, class_b: net("class_b") / changes, worker: net("worker") / changes, seconds: read.seconds };
		};
		log(`phase W: ${changes} changes, machine A alone`);
		await B.stop();
		B.watcher = null;
		const writer = await phase("w", [A]);
		log(`phase R: ${changes} changes, A and B`);
		await B.watch();
		await sleep(15_000);
		const both = await phase("r", [A, B]);
		const reader = { class_a: Math.max(0, both.class_a - writer.class_a), class_b: Math.max(0, both.class_b - writer.class_b), worker: Math.max(0, both.worker - writer.worker) };

		return {
			measured_at: new Date().toISOString(),
			idle: {
				window_s: r3(idle.seconds), machines: 2,
				class_a_per_hour_per_machine: r3(perMachineHour(idle.counts.class_a)), class_b_per_hour_per_machine: r3(perMachineHour(idle.counts.class_b)),
				worker_per_hour_per_machine: r3(perMachineHour(idle.counts.worker)), do_per_hour_per_machine: 0,
				cpu_pct_per_machine: idle.cpu_pct_per_machine.map(r3), cpu_pct: r3(idle.cpu_pct_per_machine.reduce((a, b) => a + b, 0) / 2),
				raw: idle.counts,
			},
			change: {
				samples: changes, bytes_per_change: changeKb * 1024,
				class_a_writer: r3(writer.class_a), class_b_writer: r3(writer.class_b), worker: r3(writer.worker + reader.worker), do: 1,
				class_a_per_reader: r3(reader.class_a), class_b_per_reader: r3(reader.class_b), worker_writer: r3(writer.worker), worker_per_reader: r3(reader.worker),
			},
		};
	} finally {
		for (const m of stack.machines) await m.stop();
		stack.teardown();
	}
}

export function opsPoints({ measured, at = new Date(), code }) {
	const t = stampOf(at);
	const id = at.toISOString().slice(0, 16).replace(/[-:]/g, "");
	const slice = { env: "test" };
	const src = (what) => sourceOf(BENCH_VERSION, `ops-${what}-${id}`, code);
	const i = measured.idle;
	const perHour = i.class_a_per_hour_per_machine + i.class_b_per_hour_per_machine + i.worker_per_hour_per_machine;
	return [
		makePoint({ kpi: "idle_cpu_pct", value: i.cpu_pct, n: 2, t, slice, source: src("cpu"), labels: { window_s: i.window_s, machines: 2, cpu_pct_per_machine: i.cpu_pct_per_machine, target: 0.1, measured_by: "/proc utime+stime+cutime+cstime of the sync --watch tree" } }),
		makePoint({ kpi: "idle_ops_per_hour", value: r3(perHour), n: 2, t, slice: { ...slice, kind: "per_machine" }, source: src("ops"), labels: { window_s: i.window_s, class_a: i.class_a_per_hour_per_machine, class_b: i.class_b_per_hour_per_machine, worker: i.worker_per_hour_per_machine, do_assumed: 0 } }),
	];
}

export function saveCounters(measured, code) {
	mkdirSync(STATE_DIR, { recursive: true });
	const doc = {
		schema: "folder-sync-cost-counters/1", ...measured, code_sha: code.dirty ? `${code.sha}+dirty` : code.sha, source: "local stack (bench/kpi/ops.mjs): R2 stand-in gate.jsonl + wrangler dev accounts.log",
		assumed: { do: "A Durable Object message is not observable on the local stack. The model assumes the hub's one `changed` message per change (change.do = 1) and nothing while idle (WebSocket hibernation); at list price both are well under $0.01 a person-month.", d1: "D1 rows are not counted: a few rows per sign-in and project, immaterial." },
	};
	const tmp = `${COUNTERS_FILE}.${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(doc, null, 1)}\n`);
	renameSync(tmp, COUNTERS_FILE);
	return doc;
}

export function loadCounters() {
	return existsSync(COUNTERS_FILE) ? JSON.parse(readFileSync(COUNTERS_FILE, "utf8")) : null;
}

export async function run({ out = DEFAULT_OUT, kpi = true, cli = null, idleS = 600, changes = 12 } = {}) {
	const code = codeSha();
	const measured = await measureOps({ cli, sha: code.sha, idleS, changes, log: (m) => console.error(`ops: ${m}`) });
	const points = opsPoints({ measured, code });
	if (kpi) {
		saveCounters(measured, code);
		appendPoints(out, points);
	}
	return { measured, points };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const val = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
	try {
		const { measured } = await run({ out: resolve(val("--out", DEFAULT_OUT)), kpi: !args.includes("--no-kpi"), cli: val("--cli", null) && resolve(val("--cli")), idleS: Number(val("--idle-s", 600)), changes: Number(val("--changes", 12)) });
		console.log(JSON.stringify(measured));
		process.exit(0);
	} catch (error) {
		console.error(`ops: ${error.message || error}`);
		process.exit(1);
	}
}
