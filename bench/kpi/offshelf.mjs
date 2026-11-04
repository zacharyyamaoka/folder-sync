// The "vs best off-the-shelf" reference (PEP 0008): the last results of the bench/fast comparison, folded into the same
// propagation_* series with slice.tool, so one chart holds folder-sync and its competitors per direction. Reads
// bench/fast/results/summary-<tag>.json (the newest); each cell is a 1 KB-file p50 / p95 measured on this machine for the
// tool named, loopback, two hosts (bench/fast/README-folder-sync.md has the method). Emitted once per summary tag.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makePoint, REPO } from "./lib.mjs";

const DIRECTION = { m2m: "machine->machine", m2w: "machine->web", w2m: "web->machine" };
const VERSION = "folder-sync-bench-fast/1";
// WHY only these folder-sync series: the sweep ran 20 tunings of folder-sync; the series keeps the headline four (v0 before
// push, push, v0 now, and the tuned PEP 0008 §7 candidate) so the competitors are not buried in knobs
const FOLDER_SYNC_SERIES = new Set(["folder-sync poll", "folder-sync push", "folder-sync head", "folder-sync push-tuned"]);

export function newestSummary(dir = join(REPO, "bench", "fast", "results")) {
	if (!existsSync(dir)) return null;
	const files = readdirSync(dir).filter((f) => /^summary-.+\.json$/.test(f)).sort();
	return files.length ? join(dir, files[files.length - 1]) : null;
}

/** Propagation points for every networked-direction cell with a 1 KB workload, one per (tool, variant, direction). */
export function offShelfPoints(summary, { t }) {
	const out = [];
	const seen = new Set();
	for (const c of summary.cells ?? []) {
		const direction = DIRECTION[c.direction];
		if (!direction || c.workload !== "1k" || c.fault || c.status !== "ok") continue;
		if (c.tool === "folder-sync" && !FOLDER_SYNC_SERIES.has(c.series)) continue;
		const key = `${c.series}|${direction}`;
		if (seen.has(key)) continue; // one cell per series and direction; the summary lists steps once
		seen.add(key);
		const { p50, p95, n } = c;
		const slice = { env: "test", direction, op: "mixed", tool: c.tool, variant: c.variant, workload: "1k" };
		const source = { code_sha: summary.bench_code ?? "unknown", bench_version: VERSION, run_ids: [`fast-${summary.tag}-${c.series.replace(/\s+/g, "_")}-${c.direction}`], dirty: false };
		const labels = { series: c.series, summary_schema: summary.schema, summary_tag: summary.tag, lost: c.lost ?? null, timeouts: c.timeouts ?? null, sha256_fail: c.sha256_fail ?? null, load1_p50: c.load1_p50 ?? null, config: c.config ?? null };
		for (const [kpi, value] of [["propagation_p50_ms", p50], ["propagation_p95_ms", p95]]) {
			out.push(makePoint({ kpi, value: typeof value === "number" ? value : null, n, t, source, slice, labels, reason: `bench/fast cell has no ${kpi === "propagation_p50_ms" ? "p50" : "p95"}` }));
		}
	}
	return out;
}

export function loadSummary(file) {
	return JSON.parse(readFileSync(file, "utf8"));
}
