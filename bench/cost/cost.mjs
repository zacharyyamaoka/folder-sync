// O3: the cost KPIs. Joins the price table (prices.json), the measured counters (bench/kpi/ops.mjs) and H (the production
// usage series, else the test workload's, else the 1.0 gate) into cost_per_gb_month_usd and cost_per_person_month_usd per
// provider, for two profiles:
//   reference  10 GB live, 3 machines, 1000 changes a day, 50 KB a change   (env=test: a synthetic person, counters from the local stack)
//   average    Zach's real account: live bytes and H from GET /fs/v1/usage, machines from GET /fs/v1/folders, changes a day from this
//              machine's sync logs over 7 days                                (env=prod)
//
//   node bench/cost/cost.mjs table      the markdown table docs/PRICES.md quotes
//   node bench/cost/cost.mjs points     the points (not written)
//   node bench/cost/cost.mjs store URL  what a folder on that store URL costs (r2://, s3://, gs://, file://): the provider is read from the URL
// The store a folder is on is FOLDER_SYNC_STORE (its .folder-sync.toml's store URL; absent = r2://). Every provider still
// gets its point, so the dev view can compare; the point of the folder's own provider carries labels.is_store_provider.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makePoint, sourceOf, stampOf, readSeries, DEFAULT_OUT, codeSha } from "../kpi/lib.mjs";
import { loadCounters } from "../kpi/ops.mjs";
import { costSummary, PROFILES } from "./model.mjs";
import { providerOfStore, storeCostLine, storeLabel } from "./store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROVIDERS = ["r2", "s3", "gcs", "b2", "wasabi"];
const BENCH_VERSION = "folder-sync-kpi-cost/1";

export function loadPrices() {
	return JSON.parse(readFileSync(join(HERE, "prices.json"), "utf8"));
}

/** Changes a day from this machine's sync logs: `<ts> round ok=true uploaded=N deleted=M ...` lines of the last `days` days. */
export function changesPerDay(logDir = join(homedir(), ".folder-sync", "logs"), days = 7, now = new Date()) {
	if (!existsSync(logDir)) return null;
	const since = now.getTime() - days * 86_400_000;
	let changes = 0;
	let rounds = 0;
	for (const name of readdirSync(logDir)) {
		if (!name.endsWith(".log")) continue;
		for (const line of readFileSync(join(logDir, name), "utf8").split("\n")) {
			const m = /^(\S+) round ok=true uploaded=(\d+) deleted=(\d+)/.exec(line);
			if (!m || Date.parse(m[1]) < since) continue;
			changes += Number(m[2]) + Number(m[3]);
			rounds++;
		}
	}
	return rounds ? { per_day: Math.round(changes / days), rounds, days } : null;
}

/** The average profile from what the account says about itself; null when the usage could not be read. */
export function averageProfile({ usage, folders, logs }) {
	if (!usage?.live?.bytes) return null;
	const hosts = new Set((folders?.folders ?? []).flatMap((f) => f.hosts ?? []));
	return {
		name: "average", live_gb: usage.live.bytes / 1e9, machines: Math.max(1, hosts.size), changes_per_day: logs?.per_day ?? PROFILES.reference.changes_per_day,
		change_kb: PROFILES.reference.change_kb, days: 30,
		basis: { hosts: hosts.size, changes_per_day_from: logs ? `${logs.rounds} synced rounds over ${logs.days} days in this machine's logs (one machine's writes: a lower bound)` : "the reference profile (no sync logs)", change_kb_from: "the reference profile" },
	};
}

/** The latest measured H for a slice (the newest point), or null. */
export function latestH(series, slice) {
	const mine = series.filter((p) => p.kpi === "storage_efficiency_h" && p.status === "measured" && Object.entries(slice).every(([k, v]) => p.slice?.[k] === v));
	mine.sort((a, b) => Date.parse(b.t) - Date.parse(a.t));
	return mine[0] ? { h: mine[0].value, t: mine[0].t } : null;
}

export function costPoints({ prices = loadPrices(), counters, series, usage = null, folders = null, logs = null, at = new Date(), code = codeSha(), store = process.env.FOLDER_SYNC_STORE ?? "" }) {
	const t = stampOf(at);
	const storeProvider = providerOfStore(store);
	const ofStore = (provider) => ({ store: storeLabel(store), is_store_provider: provider === storeProvider, ...(storeProvider ? {} : { store_unpriced: true }) });
	const hour = at.toISOString().slice(0, 13).replace(/[-:]/g, "");
	const out = [];
	if (!counters) {
		for (const env of ["test", "prod"]) for (const provider of PROVIDERS) for (const kpi of ["cost_per_gb_month_usd", "cost_per_person_month_usd"]) {
			out.push(makePoint({ kpi, value: null, n: 0, t, source: sourceOf(BENCH_VERSION, `cost-${env}-${hour}`, code), slice: { env, provider, profile: env === "test" ? "reference" : "average" }, reason: "no measured counters yet: run bench/kpi/ops.mjs (needs a 10-minute idle window)" }));
		}
		return out;
	}
	const avg = averageProfile({ usage, folders, logs });
	const jobs = [
		{ env: "test", profile: PROFILES.reference, h: latestH(series, { env: "test" }), hFrom: "the test workload (ci-history-v1)" },
		{ env: "prod", profile: avg, h: latestH(series, { env: "prod" }), hFrom: "the production usage series" },
	];
	for (const { env, profile, h, hFrom } of jobs) {
		for (const provider of PROVIDERS) {
			const slice = { env, provider, profile: env === "test" ? "reference" : "average" };
			const source = sourceOf(BENCH_VERSION, `cost-${env}-${hour}`, code);
			if (!profile) {
				for (const kpi of ["cost_per_gb_month_usd", "cost_per_person_month_usd"]) out.push(makePoint({ kpi, value: null, n: 0, t, source, slice, reason: "the account's usage could not be read (no live bytes)" }));
				continue;
			}
			// WHY gate 1.0 when no H was measured: an unmeasured H must not make storage look free; 1.0 is the objective's ceiling
			const hUsed = h ? h.h : 1.0;
			const c = costSummary({ provider, prices, counters, profile, h: hUsed });
			const labels = { ...ofStore(provider), provider_name: prices.providers[provider].name, h: hUsed, h_from: h ? `${hFrom}, ${h.t}` : "the 1.0 gate (no H measured yet)", live_gb: profile.live_gb, machines: profile.machines, changes_per_day: profile.changes_per_day, change_kb: profile.change_kb, lower_bound: c.lower_bound, min_monthly_applied: c.min_applied, counters_measured_at: counters.measured_at, prices_accessed: prices.date_accessed };
			out.push(makePoint({ kpi: "cost_per_gb_month_usd", value: c.per_gb_usd, n: 1, t, source, slice, labels: { ...labels, storage_usd: c.storage_usd, ops_usd: c.ops_usd, egress_usd: c.egress_usd, per: "live GB" } }));
			out.push(makePoint({ kpi: "cost_per_person_month_usd", value: c.person_usd, n: 1, t, source, slice, labels: { ...labels, provider_usd: c.total_usd, platform_usd: c.platform.usd, platform_base_usd: c.platform.base_usd, target: 0.5 } }));
		}
	}
	return out;
}

/** A markdown table of one profile on every provider (docs/PRICES.md). */
export function table({ prices = loadPrices(), counters, profile, h }) {
	const rows = PROVIDERS.map((provider) => {
		const c = costSummary({ provider, prices, counters, profile, h });
		const f = (x) => `$${x.toFixed(x < 0.1 ? 4 : 3)}`;
		return `| ${prices.providers[provider].name} | ${f(c.storage_usd)} | ${f(c.ops_usd)} | ${c.lower_bound ? ">= " : ""}${f(c.egress_usd)}${c.lower_bound ? " (price unknown)" : ""} | ${f(c.total_usd)}${c.min_applied ? " (minimum charge)" : ""} | ${f(c.platform.usd)} | **${f(c.person_usd)}** | ${f(c.per_gb_usd)} |`;
	});
	return ["| Provider | Storage | Requests | Egress | Provider total | Workers + DO requests | **Per person-month** | Per live GB-month |", "|---|---|---|---|---|---|---|---|", ...rows].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const verb = process.argv[2] || "table";
	const counters = loadCounters();
	const series = readSeries(DEFAULT_OUT);
	if (verb === "store") {
		if (!counters) throw new Error("no counters: run node bench/kpi/ops.mjs first");
		const hGate = latestH(series, { env: "test" })?.h ?? 1;
		console.log(storeCostLine({ url: process.argv[3] ?? process.env.FOLDER_SYNC_STORE ?? "", prices: loadPrices(), counters, h: hGate }));
	} else if (verb === "points") {
		console.log(costPoints({ counters, series }).map((p) => JSON.stringify(p)).join("\n"));
	} else {
		if (!counters) throw new Error("no counters: run node bench/kpi/ops.mjs first");
		const hGate = latestH(series, { env: "test" })?.h ?? 1;
		console.log(`H = ${hGate}\n`);
		console.log(table({ counters, profile: PROFILES.reference, h: hGate }));
	}
}
