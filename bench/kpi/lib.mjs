// Shared plumbing for the KPI producers (bench/latency, bench/kpi, bench/cost): the vt-kpi-point/1 shape, the append
// that never writes a point twice, the rolling max, and a run lock. Dependency-free, like the rest of bench/.
//
// The shape is a frozen contract (docs/KPI.md): {schema, kpi, t, value, n, status, labels, source, slice}, one JSON
// object a line in <producer dir>/kpi_series.jsonl, read by Vibe Tracks.

import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..");
export const DEFAULT_OUT = process.env.VT_PRODUCER_DIR || join(homedir(), "vt", "zach", "producers", "folder-sync");
export const STATE_DIR = process.env.FOLDER_SYNC_KPI_STATE || join(homedir(), ".local", "state", "folder-sync-kpi");

/** The frozen KPI names (the legacy sync_* names stay valid beside them). */
export const KPI_NAMES = [
	"propagation_p50_ms", "propagation_p95_ms",
	"storage_efficiency_h", "storage_efficiency_h_30d_max",
	"cost_per_gb_month_usd", "cost_per_person_month_usd",
	"idle_cpu_pct", "idle_ops_per_hour",
];
export const LEGACY_KPI_NAMES = ["sync_up_ms", "sync_down_ms", "sync_up_ms_p95", "sync_down_ms_p95"];
export const DIRECTIONS = ["machine->machine", "machine->web", "web->machine"];
export const OPS = ["add", "edit", "delete", "rename"];

/** RFC 3339 with this machine's offset, as the other producers write it. */
export function stampOf(date) {
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

export function codeSha(repo = REPO) {
	const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	const head = git("rev-parse", "--short=12", "HEAD");
	const status = git("status", "--porcelain", "--untracked-files=no");
	const branch = git("rev-parse", "--abbrev-ref", "HEAD");
	return { sha: head.status === 0 ? head.stdout.trim() : "unknown", dirty: status.status === 0 && status.stdout.trim() !== "", branch: branch.status === 0 ? branch.stdout.trim() : null };
}

export function sourceOf(bench_version, runId, code = codeSha()) {
	return { code_sha: code.dirty ? `${code.sha}+dirty` : code.sha, bench_version, run_ids: [runId], dirty: code.dirty };
}

/** One vt-kpi-point/1. No number means status "failed" and a reason, never a silent zero or a skipped line. */
export function makePoint({ kpi, value, n, t, labels = {}, source, slice, reason }) {
	if (!KPI_NAMES.includes(kpi) && !LEGACY_KPI_NAMES.includes(kpi)) throw new Error(`unknown kpi ${kpi}`);
	if (!slice || !["test", "prod"].includes(slice.env)) {
		if (KPI_NAMES.includes(kpi)) throw new Error(`${kpi} needs slice.env test|prod`);
	}
	const measured = typeof value === "number" && Number.isFinite(value);
	if (!measured && !reason) throw new Error(`${kpi}: a point with no value needs a reason`);
	return {
		schema: "vt-kpi-point/1", kpi, t, value: measured ? value : null, n: n ?? 0, status: measured ? "measured" : "failed",
		labels: measured ? labels : { ...labels, reason }, source, slice,
	};
}

function stable(value) {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
	return JSON.stringify(value);
}

/** What makes two points the same measurement: the KPI, its slice and the run that made it. */
export function pointKey(p) {
	return `${p.kpi}|${stable(p.slice ?? null)}|${(p.source?.run_ids ?? []).join(",")}`;
}

export function readSeries(dir = DEFAULT_OUT) {
	const file = join(dir, "kpi_series.jsonl");
	if (!existsSync(file)) return [];
	const out = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try { out.push(JSON.parse(line)); } catch { /* a torn last line: a writer died mid-append; skip it */ }
	}
	return out;
}

/** Appends points not already in the series. WHY de-duplicated: run-all.mjs is safe to run twice in an hour, and a
 *  timer's catch-up (Persistent=true) must not double-count a run. Legacy points keep their old behaviour: they carry
 *  no run key distinct from their sibling slices, so they are written as the latency bench always wrote them. */
export function appendPoints(dir, points, { dedupe = true } = {}) {
	mkdirSync(dir, { recursive: true });
	const have = dedupe ? new Set(readSeries(dir).map(pointKey)) : new Set();
	const fresh = [];
	for (const p of points) {
		const key = pointKey(p);
		if (dedupe && have.has(key)) continue;
		have.add(key);
		fresh.push(p);
	}
	if (fresh.length) appendFileSync(join(dir, "kpi_series.jsonl"), `${fresh.map((p) => JSON.stringify(p)).join("\n")}\n`);
	return { written: fresh.length, skipped: points.length - fresh.length };
}

function sliceMatches(have, want) {
	return Object.entries(want).every(([k, v]) => have?.[k] === v);
}

/** The largest measured value of `kpi` (points whose slice contains `slice`) in the last `days`: {value, n}, or null. */
export function rollingMax(series, { kpi, slice, days = 30, now = new Date() }) {
	const since = now.getTime() - days * 86_400_000;
	const vals = series.filter((p) => p.kpi === kpi && p.status === "measured" && typeof p.value === "number" && sliceMatches(p.slice, slice) && Date.parse(p.t) >= since && Date.parse(p.t) <= now.getTime() + 60_000).map((p) => p.value);
	return vals.length ? { value: Math.max(...vals), n: vals.length } : null;
}

/** Runs `fn` holding an exclusive lock file; a lock whose pid is dead (or older than `staleMs`) is taken over.
 *  Returns {skipped: true} when another live run holds it. */
export async function withLock(file, fn, { staleMs = 2 * 3600_000 } = {}) {
	mkdirSync(dirname(file), { recursive: true });
	const take = () => { const fd = openSync(file, "wx"); writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`); closeSync(fd); };
	try {
		take();
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		const [pid, at] = readFileSync(file, "utf8").trim().split(" ");
		let live = true;
		try { process.kill(Number(pid), 0); } catch { live = false; }
		if (live && Date.now() - Date.parse(at) < staleMs) return { skipped: true, holder: Number(pid) };
		rmSync(file, { force: true });
		take();
	}
	try {
		return { skipped: false, value: await fn() };
	} finally {
		rmSync(file, { force: true });
	}
}
