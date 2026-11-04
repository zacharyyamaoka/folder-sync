// O3: the cost model. Turns measured counters (requests per idle machine-hour, requests per change, bytes per change)
// and a usage profile into $ per month on each storage provider and on the Worker / Durable Object side, from the
// list prices in prices.json (every price carries its source URL and date; docs/PRICES.md renders them).
//
// Units: 1 GB = 1e9 bytes, a month = `days` x 24 h (30 by default). No free tier is applied unless asked: a free tier is
// per account, so counting it in a per-person cost would flatter a number that does not hold at scale.
//
// WHY the $5 Workers Paid fee is kept apart (platform.base_usd): it is a fixed cost of one deployment, not of a
// person. cost_per_person_month_usd is the variable part; docs/KPI.md says how many people make the fixed part fit
// under Zach's $0.50 target.

export const PROFILES = {
	// Zach, 2026-11-04 objectives: "<= $0.50 at 10 GB" per person
	reference: { name: "reference", live_gb: 10, machines: 3, changes_per_day: 1000, change_kb: 50, days: 30 },
};

const HOURS = 24;

/** Requests and bytes in a month: idle machines polling or holding sockets, plus the changes (the writer's calls once,
 *  each other machine's reads once per change). */
export function monthlyOps(counters, profile) {
	const days = profile.days ?? 30;
	const hours = days * HOURS;
	const machines = profile.machines;
	const changes = profile.changes_per_day * days;
	const idle = counters.idle ?? {};
	const ch = counters.change ?? {};
	const idleOf = (k) => (idle[`${k}_per_hour_per_machine`] ?? 0) * hours * machines;
	const readers = Math.max(0, machines - 1);
	return {
		class_a: idleOf("class_a") + (ch.class_a_writer ?? 0) * changes + (ch.class_a_per_reader ?? 0) * readers * changes,
		class_b: idleOf("class_b") + ((ch.class_b_writer ?? 0) + (ch.class_b_per_reader ?? 0) * readers) * changes,
		worker: idleOf("worker") + (ch.worker ?? 0) * changes,
		do: idleOf("do") + (ch.do ?? 0) * changes,
		changes,
		egress_gb: (profile.change_kb * 1024 * readers * changes) / 1e9,
	};
}

/** What one provider charges a month for `profile`, given the history ratio `h` (history bytes / live bytes: stored
 *  = live x (1 + h)). `lower_bound` is true when a price the provider charges is not known (egress null). */
export function costFor({ provider, prices, counters, profile, h = 1, free_tier = false }) {
	const p = prices.providers[provider];
	if (!p) throw new Error(`no provider ${provider} in the price table`);
	const ops = monthlyOps(counters, profile);
	const stored = profile.live_gb * (1 + h);
	const free = free_tier ? p.free_tier ?? {} : {};
	const storage_usd = Math.max(0, stored - (free.storage_gb ?? 0)) * p.storage_per_gb_month;
	const ops_usd = Math.max(0, ops.class_a / 1e6 - (free.class_a_million ?? 0)) * p.class_a_per_million + Math.max(0, ops.class_b / 1e6 - (free.class_b_million ?? 0)) * p.class_b_per_million;
	let egress_usd = 0;
	let lower_bound = false;
	if (p.egress_per_gb === null) {
		lower_bound = ops.egress_gb > 0;
	} else {
		const included = (p.egress_free_multiple_of_stored ?? 0) * stored;
		egress_usd = Math.max(0, ops.egress_gb - included) * p.egress_per_gb;
	}
	const raw = storage_usd + ops_usd + egress_usd;
	const min = p.min_monthly_usd ?? 0;
	const total_usd = Math.max(raw, min);
	return {
		provider, profile: profile.name, h, stored_gb: stored, ops, storage_usd, ops_usd, egress_gb: ops.egress_gb, egress_usd,
		min_applied: min > raw, total_usd, per_gb_usd: total_usd / profile.live_gb, lower_bound,
	};
}

/** The Cloudflare side every provider needs (the Worker, the hub's Durable Object, D1): requests above nothing free, at
 *  list overage, and the fixed $5 apart. D1 rows are counted only when the counters measured them. */
export function platformCost({ prices, counters, profile }) {
	const ops = monthlyOps(counters, profile);
	const w = prices.platform.workers;
	const d = prices.platform.durable_objects;
	const d1 = prices.platform.d1;
	const d1Written = (counters.change?.d1_rows_written ?? 0) * ops.changes;
	const usd = (ops.worker / 1e6) * w.per_million + (ops.do / 1e6) * d.per_million + (d1Written / 1e6) * d1.rows_written_per_million;
	return { worker_requests: ops.worker, do_requests: ops.do, d1_rows_written: d1Written, usd, base_usd: w.base_usd_month };
}

/** Everything a point needs for one provider and profile. */
export function costSummary({ provider, prices, counters, profile, h, free_tier = false }) {
	const c = costFor({ provider, prices, counters, profile, h, free_tier });
	const platform = platformCost({ prices, counters, profile });
	return { ...c, platform, person_usd: c.total_usd + platform.usd };
}
