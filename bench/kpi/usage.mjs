// O2 in production: history bytes / live bytes for the signed-in account, from GET /fs/v1/usage (bearer token from
// ~/.folder-sync/account.json, never printed), and the rolling 30-day max of those samples. Run hourly by run-all.mjs.
//
// H is the quantity PEP 0009 gates: "H = history bytes / live bytes, per person, from GET /fs/v1/usage, taken as the 30-day
// max of hourly samples: <= 1.0, stretch <= 0.25". `history` is what the Worker counts as _history/, _changes/, _requests/
// and legacy _trash/; `live` is everything else (accounts/src/quota.ts HISTORY_TOPS).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Online } from "../latency/harness.mjs";
import { makePoint, readSeries, rollingMax, sourceOf, stampOf } from "./lib.mjs";

export const BENCH_VERSION = "folder-sync-kpi-usage/1";

/** H from a usage body; null with a reason when there is no live byte to divide by. */
export function ratioOf(usage) {
	const live = usage?.live?.bytes;
	const history = usage?.history?.bytes;
	if (typeof live !== "number" || typeof history !== "number") return { h: null, reason: "usage answered without live / history bytes" };
	if (live <= 0) return { h: null, reason: history > 0 ? "no live bytes against history bytes: H is unbounded" : "nothing stored yet" };
	return { h: history / live, reason: null };
}

export function hourId(date) {
	return date.toISOString().slice(0, 13).replace(/[-:]/g, "");
}

/** Reads the usage and returns {usage, error}; an unreachable Worker is a failed point, not a crashed run. */
export async function fetchUsage(account = join(homedir(), ".folder-sync", "account.json")) {
	if (!existsSync(account)) return { usage: null, error: "prod is unmeasured: this machine is not signed in (no ~/.folder-sync/account.json)" };
	const a = JSON.parse(readFileSync(account, "utf8"));
	try {
		return { usage: await new Online(a.server, a.token).usage(), error: null, server: a.server };
	} catch (error) {
		return { usage: null, error: String(error.message || error), server: a.server };
	}
}

/** The two points for this hour: storage_efficiency_h and storage_efficiency_h_30d_max (env=prod). */
export function usagePoints({ usage, error, series, at = new Date(), code, server = null }) {
	const t = stampOf(at);
	const id = hourId(at);
	const slice = { env: "prod" };
	const hRun = sourceOf(BENCH_VERSION, `usage-prod-${id}`, code);
	const { h, reason } = error ? { h: null, reason: error } : ratioOf(usage);
	const labels = usage ? { live_bytes: usage.live?.bytes ?? null, history_bytes: usage.history?.bytes ?? null, used_bytes: usage.used?.bytes ?? null, used_objects: usage.used?.objects ?? null, quota_bytes: usage.quota?.bytes ?? null, over: usage.over ?? null, partial: !!usage.partial, server } : { server };
	const point = makePoint({ kpi: "storage_efficiency_h", value: h, n: h === null ? 0 : 1, t, source: hRun, slice, labels, reason });
	const window = rollingMax([...series, point], { kpi: "storage_efficiency_h", slice, days: 30, now: at });
	const max = makePoint({
		kpi: "storage_efficiency_h_30d_max", value: window ? window.value : null, n: window ? window.n : 0, t, slice,
		source: sourceOf(BENCH_VERSION, `usage-prod-30dmax-${id}`, code),
		labels: { window_days: 30, samples: window ? window.n : 0, gate: 1.0, stretch: 0.25 },
		reason: "no measured H sample in the last 30 days",
	});
	return [point, max];
}

export { readSeries };
