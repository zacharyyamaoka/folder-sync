// O1: propagation trials -> propagation_p50_ms / propagation_p95_ms points, one pair per direction and op, plus a
// "mixed" pair per direction (every op pooled). A pure function so the data contract is testable without a stack.
import { DIRECTIONS, makePoint, OPS, percentile } from "./lib.mjs";

/** @param trials [{direction, op, ms|null, timeout?}]  @param ctx {env, t, source, labels, extraSlice, failReason}: failReason replaces the timeout text on cells with no
 *  measured trial (a run refused before it started, say) */
export function propagationPoints(trials, { env, t, source, labels = {}, extraSlice = {}, failReason = null }) {
	const out = [];
	for (const direction of DIRECTIONS) {
		const here = trials.filter((x) => x.direction === direction);
		for (const op of [...OPS, "mixed"]) {
			const cell = op === "mixed" ? here : here.filter((x) => x.op === op);
			if (!cell.length) continue;
			const ms = cell.map((x) => x.ms).filter((x) => typeof x === "number");
			const timeouts = cell.length - ms.length;
			const stats = { p50: percentile(ms, 50), p95: percentile(ms, 95), max: ms.length ? Math.max(...ms) : null, min: ms.length ? Math.min(...ms) : null, timeouts, trials: cell.length };
			for (const [kpi, value] of [["propagation_p50_ms", stats.p50], ["propagation_p95_ms", stats.p95]]) {
				out.push(makePoint({
					kpi, value, n: ms.length, t, source,
					labels: { ...stats, ...labels },
					slice: { env, direction, op, ...extraSlice },
					reason: failReason || `timed out: ${timeouts} of ${cell.length} trials never arrived`,
				}));
			}
		}
	}
	return out;
}
