// O2 in test: H on a deterministic workload, on the local stack. Same Worker code and the same /fs/v1/usage as production,
// over the R2 stand-in (e2e/r2standin in front of `rclone serve s3`), so a change to what the engine keeps (PEP 0009's
// pointers and zstd, say) moves this number and not just production's slow one.
//
// The workload "ci-history-v1" is seeded (mulberry32), so two runs write the same bytes:
//   round 0   60 markdown notes (2-6 KB), 6 append-only logs (4 KB), 3 binary blobs (20 KB), all new
//   rounds 1-5 (each ROUND_GAP_S apart)  12 notes get a few lines rewritten, every log grows by ~1 KB, 1 blob is replaced
// WHY ROUND_GAP_S = 31: PEP 0007's burst rule keeps a leaving version that lived at least Burst (30 s) and at most one per
// 30 s otherwise, so rounds 31 s apart keep every replaced version: the workload measures what a kept version costs, not
// what the throttle happens to drop. It is NOT a 30-day replay (that is bench/kpi's production series and PEP 0009 §9's
// replay30.py); the schedule's hourly and daily thinning never starts inside 3 minutes.
//
//   node bench/kpi/storage-test.mjs [--out DIR] [--no-kpi] [--cli PATH]     one run, one point pair appended
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localStack, Online, sleep } from "../latency/harness.mjs";
import { appendPoints, codeSha, DEFAULT_OUT, makePoint, readSeries, rollingMax, sourceOf, stampOf } from "./lib.mjs";

export const WORKLOAD = "ci-history-v1";
export const ROUNDS = 5;
export const ROUND_GAP_S = 31;
const BENCH_VERSION = "folder-sync-kpi-storage-test/1";

/** mulberry32: a 32-bit seeded generator, so the workload is the same bytes every run. */
export function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const WORDS = "sync folder note plan robot sorter belt arm camera model train cost price test merge branch review build ship hospital waste plastic paper metal glass compost sensor gripper vision queue".split(" ");

function line(rand) {
	const n = 6 + Math.floor(rand() * 10);
	return Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(" ");
}

function note(rand, bytes) {
	let s = `# ${line(rand)}\n\n`;
	while (s.length < bytes) s += `- ${line(rand)}\n`;
	return s;
}

function blob(rand, bytes) {
	const b = Buffer.alloc(bytes);
	for (let i = 0; i < bytes; i++) b[i] = Math.floor(rand() * 256);
	return b;
}

/** Round 0's files: [{path, bytes}]. Pure and deterministic. */
export function workload(seed = 20261104) {
	const base = rng(seed);
	const out = [];
	for (let i = 0; i < 60; i++) out.push({ path: `notes/note-${String(i).padStart(2, "0")}.md`, bytes: Buffer.from(note(base, 2048 + Math.floor(base() * 4096))) });
	for (let i = 0; i < 6; i++) out.push({ path: `logs/day-${i}.jsonl`, bytes: Buffer.from(Array.from({ length: 32 }, (_, k) => JSON.stringify({ k, text: line(base) })).join("\n") + "\n") });
	for (let i = 0; i < 3; i++) out.push({ path: `blobs/blob-${i}.bin`, bytes: blob(base, 20 * 1024) });
	return out;
}

/** Applies round `round` to the in-memory tree `files` (Map path -> Buffer) and returns the changed paths. */
export function applyRound(files, round, seed = 20261104) {
	if (round === 0) {
		for (const f of workload(seed)) files.set(f.path, f.bytes);
		return [...files.keys()];
	}
	const r = rng(seed + round * 7919);
	const changed = [];
	const notes = [...files.keys()].filter((p) => p.startsWith("notes/"));
	for (let k = 0; k < 12; k++) {
		const path = notes[Math.floor(r() * notes.length)];
		const lines = files.get(path).toString().split("\n");
		for (let j = 0; j < 4; j++) lines[2 + Math.floor(r() * (lines.length - 3))] = `- ${line(r)}`;
		files.set(path, Buffer.from(lines.join("\n")));
		changed.push(path);
	}
	for (const path of [...files.keys()].filter((p) => p.startsWith("logs/"))) {
		const add = Array.from({ length: 12 }, (_, k) => JSON.stringify({ round, k, text: line(r) })).join("\n") + "\n";
		files.set(path, Buffer.concat([files.get(path), Buffer.from(add)]));
		changed.push(path);
	}
	const path = `blobs/blob-${round % 3}.bin`;
	files.set(path, blob(r, 20 * 1024));
	changed.push(path);
	return changed;
}

export async function measureH({ cli = null, sha, log = () => {} } = {}) {
	const stack = await localStack({ cli, sha, machines: 1, prefix: "folder-sync-storage-",
		// WHY a 1 s recheck: the Worker caches a person's usage for QUOTA_RECHECK_S (300 s in production); the first figure of a
		// new account is the empty one, so without this the workload's H would read 0 / 0
		env: { QUOTA_RECHECK_S: "1" } });
	try {
		const [A] = stack.machines;
		const online = new Online(stack.server, A.token());
		const files = new Map();
		const roundsLog = [];
		let changedBytes = 0;
		for (let round = 0; round <= ROUNDS; round++) {
			if (round > 0) await sleep(ROUND_GAP_S * 1000);
			const changed = applyRound(files, round);
			for (const path of changed) {
				const target = join(A.folder, path);
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, files.get(path));
				changedBytes += files.get(path).length;
			}
			A.must(["sync", "--once", "--dir", A.folder]);
			roundsLog.push({ round, changed: changed.length });
			log(`round ${round}: ${changed.length} files`);
		}
		await sleep(2000);
		const usage = await online.usage();
		return { usage, rounds: roundsLog, files: files.size, changed_bytes: changedBytes };
	} finally {
		stack.teardown();
	}
}

export function storagePoints({ measured, series, at = new Date(), code }) {
	const t = stampOf(at);
	const id = at.toISOString().slice(0, 16).replace(/[-:]/g, "");
	const slice = { env: "test", workload: WORKLOAD };
	const { usage } = measured;
	const live = usage.live.bytes;
	const history = usage.history.bytes;
	const h = live > 0 ? history / live : null;
	const labels = { live_bytes: live, history_bytes: history, history_objects: usage.history.objects, rounds: ROUNDS, round_gap_s: ROUND_GAP_S, files: measured.files, changed_bytes: measured.changed_bytes, not_a_30_day_replay: true };
	const point = makePoint({ kpi: "storage_efficiency_h", value: h, n: h === null ? 0 : 1, t, source: sourceOf(BENCH_VERSION, `storage-test-${id}`, code), slice, labels, reason: "no live bytes in the test workload's usage" });
	const window = rollingMax([...series, point], { kpi: "storage_efficiency_h", slice, days: 30, now: at });
	const max = makePoint({ kpi: "storage_efficiency_h_30d_max", value: window ? window.value : null, n: window ? window.n : 0, t, slice, source: sourceOf(BENCH_VERSION, `storage-test-30dmax-${id}`, code), labels: { window_days: 30, gate: 1.0, stretch: 0.25 }, reason: "no measured H sample in the last 30 days" });
	return [point, max];
}

export async function run({ out = DEFAULT_OUT, kpi = true, cli = null } = {}) {
	const code = codeSha();
	const measured = await measureH({ cli, sha: code.sha, log: (m) => console.error(`storage-test: ${m}`) });
	const points = storagePoints({ measured, series: readSeries(out), code });
	if (kpi) appendPoints(out, points);
	return { measured, points };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const o = { kpi: !args.includes("--no-kpi") };
	if (args.includes("--out")) o.out = resolve(args[args.indexOf("--out") + 1]);
	if (args.includes("--cli")) o.cli = resolve(args[args.indexOf("--cli") + 1]);
	try {
		const { points } = await run(o);
		console.log(JSON.stringify(points.map((p) => ({ kpi: p.kpi, value: p.value, slice: p.slice, labels: p.labels }))));
		process.exit(0);
	} catch (error) {
		console.error(`storage-test: ${error.message || error}`);
		process.exit(1);
	}
}
