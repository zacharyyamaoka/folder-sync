// The dev view's model: the KPI series (vt-kpi-point/1 lines) and the gate results (folder-sync-gates/1) in, one plain
// object out. No HTML here (status-render.mjs) and no I/O beyond loadSources. A missing or broken source is a warning and
// "not measured yet" in the page, never a crash.
import { existsSync, readFileSync } from "node:fs";

export const WINDOW_DAYS = 30;
const DAY_MS = 864e5;

// `headline: "store"` (the cost metrics): the headline is the cost on the provider each folder is actually on (the cost points'
// labels.is_store_provider, bench/cost/store.mjs), the dearer one when folders are on two; the cheapest provider is a second line.
// Points without those labels (written before they existed) fall back to the cheapest, as `agg: "best"` says.
// Zach's objectives (Nov 4 2026). Targets are the numbers in PROJECT - Folder Sync; "primary" rows are on the at-a-glance card.
// WHY amber/red only for a miss: a calm page (Zach: Notion/Obsidian restraint), so a value that meets its target has no colour but green.
export const OBJECTIVES = [
	{
		id: "O1", name: "Fast", blurb: "Save to bytes on the other disk and online",
		metrics: [
			{ kpi: "propagation_p50_ms", label: "p50", title: "Propagation p50", unit: "ms", target: 1000, agg: "worst", primary: true },
			{ kpi: "propagation_p95_ms", label: "p95", title: "Propagation p95", unit: "ms", target: 3000, agg: "worst", primary: true },
		],
	},
	{
		id: "O2", name: "Storage efficient", blurb: "History bytes / live bytes, 30-day max",
		metrics: [
			{ kpi: "storage_efficiency_h_30d_max", label: "H, 30-day max", title: "Storage efficiency H, 30-day max", unit: "ratio", target: 1.0, stretch: 0.25, agg: "worst", primary: true },
			{ kpi: "storage_efficiency_h", label: "H, now", title: "Storage efficiency H, now", unit: "ratio", agg: "worst", primary: false },
		],
	},
	{
		id: "O3", name: "Cost per GB", blurb: "Per GB-month and per person-month at 10 GB; idle near zero",
		metrics: [
			{ kpi: "cost_per_gb_month_usd", label: "per GB-month", title: "Cost per GB-month", unit: "usd", agg: "best", headline: "store", primary: true },
			{ kpi: "cost_per_person_month_usd", label: "per person-month, 10 GB", title: "Cost per person-month", unit: "usd", target: 0.5, agg: "best", headline: "store", primary: true, note: "10 GB profile", prefer: { key: "profile", re: /\b10\s*-?gb\b/i } },
			{ kpi: "idle_cpu_pct", label: "idle CPU", title: "Idle CPU", unit: "pct", target: 0.1, agg: "worst", primary: true },
			{ kpi: "idle_ops_per_hour", label: "idle ops/hour", title: "Idle operations per hour", unit: "ops", agg: "worst", primary: false },
		],
	},
];

// The gate ids are a frozen contract (G1..G12); the names are only used when gates.json does not carry one.
export const GATE_NAMES = {
	G1: "Nothing lost", G2: "Version history", G3: "Private", G4: "Cross-platform", G5: "Three surfaces", G6: "Headless",
	G7: "Storage swappable", G8: "Drop-in", G9: "Ignore rules", G10: "Accounts", G11: "Easy to start", G12: "Trusted restore",
};
export const GATE_STATUSES = ["pass", "fail", "not_built", "skipped"];

// Points written before the data contract (lane/latency-kpi): read as propagation in their own "legacy" op so two bench
// versions never share a line. The stack becomes the env: local is the test rig, prod the deployed Worker.
const LEGACY = {
	sync_up_ms: { kpi: "propagation_p50_ms", direction: "machine->web" },
	sync_down_ms: { kpi: "propagation_p50_ms", direction: "web->machine" },
	sync_up_ms_p95: { kpi: "propagation_p95_ms", direction: "machine->web" },
	sync_down_ms_p95: { kpi: "propagation_p95_ms", direction: "web->machine" },
};
const LEGACY_ENV = { local: "test", prod: "prod" };
const KNOWN_KPIS = new Set(OBJECTIVES.flatMap((o) => o.metrics.map((m) => m.kpi)));
// Health check (docs/KPI.md "Is it syncing?"): not an objective, so it has no card and no target; it gets the live bar.
export const HEALTH_KPIS = ["sync_stalled_folders"];
// WHY 90 minutes: a quiet check writes one heartbeat point an hour (bench/kpi/health.mjs), so nothing for 90 minutes means it is not running
export const HEALTH_STALE_MS = 90 * 60_000;
export const HISTORY_RUNS = 40;
const HISTORY_POINTS = 600;
const ENVS = ["test", "prod"];

export function loadSources({ kpi, gates, history, competitors }) {
	const read = (path) => {
		if (!path || !existsSync(path)) return { path, found: false, text: null };
		try {
			return { path, found: true, text: readFileSync(path, "utf8") };
		} catch (err) {
			return { path, found: false, text: null, error: String(err.message ?? err) };
		}
	};
	return { kpi: read(kpi), gates: read(gates), history: read(history), competitors: read(competitors) };
}

// WHY 2x: "within double the target" is a near miss (amber), anything worse is red; the page never colours a value that meets its target.
export function classify(metric, value) {
	if (value === null || value === undefined || !Number.isFinite(value)) return "none";
	if (metric.target === undefined) return "info";
	if (value <= metric.target) return "ok";
	return value <= metric.target * 2 ? "amber" : "red";
}

const RANK = { none: 0, info: 0, ok: 1, amber: 2, red: 3 };
export const worstStatus = (list) => list.reduce((acc, s) => (RANK[s] > RANK[acc] ? s : acc), "none");

function parsePoints(source, warnings) {
	const skipped = { badJson: 0, badTime: 0, badValue: 0, noEnv: 0, unknownEnv: 0, unknownKpi: 0, duplicate: 0, legacyRollup: 0, badStatus: 0 };
	const seen = new Set();
	const points = [];
	let lines = 0;
	for (const raw of (source.text ?? "").split("\n")) {
		if (!raw.trim()) continue;
		lines++;
		let p;
		try {
			p = JSON.parse(raw);
		} catch {
			skipped.badJson++;
			continue;
		}
		if (!p || typeof p !== "object" || p.schema !== "vt-kpi-point/1" || typeof p.kpi !== "string") {
			skipped.badJson++;
			continue;
		}
		const slice = p.slice && typeof p.slice === "object" ? { ...p.slice } : {};
		let kpi = p.kpi;
		if (LEGACY[kpi]) {
			const env = LEGACY_ENV[slice.stack];
			if (!env) {
				skipped.legacyRollup++; // the code_sha and slice-less copies of the same measurement
				continue;
			}
			const legacy = LEGACY[kpi];
			kpi = legacy.kpi;
			for (const k of Object.keys(slice)) delete slice[k];
			Object.assign(slice, { env, direction: legacy.direction, op: "legacy" });
		} else if (!KNOWN_KPIS.has(kpi) && !HEALTH_KPIS.includes(kpi)) {
			skipped.unknownKpi++;
			continue;
		}
		if (slice.env === undefined) {
			skipped.noEnv++;
			continue;
		}
		if (!ENVS.includes(slice.env)) {
			skipped.unknownEnv++;
			continue;
		}
		const t = Date.parse(p.t);
		if (!Number.isFinite(t)) {
			skipped.badTime++;
			continue;
		}
		if (p.status !== "measured" && p.status !== "failed") {
			skipped.badStatus++;
			continue;
		}
		if (p.status === "measured" && !(typeof p.value === "number" && Number.isFinite(p.value))) {
			skipped.badValue++;
			continue;
		}
		const key = [kpi, t, JSON.stringify(Object.entries(slice).sort()), p.value, p.status].join("|");
		if (seen.has(key)) {
			skipped.duplicate++;
			continue;
		}
		seen.add(key);
		points.push({ kpi, env: slice.env, slice, t, v: p.status === "measured" ? p.value : null, failed: p.status === "failed", n: p.n, labels: p.labels && typeof p.labels === "object" ? p.labels : {}, sha: typeof p.source?.code_sha === "string" ? p.source.code_sha : null });
	}
	const say = (n, text) => n && warnings.push(`${n} ${text}`);
	say(skipped.badJson, "KPI lines skipped: not valid JSON or not vt-kpi-point/1");
	say(skipped.noEnv, "KPI points skipped: no slice.env");
	say(skipped.unknownEnv, "KPI points skipped: slice.env is neither test nor prod");
	say(skipped.unknownKpi, "KPI points skipped: unknown KPI name");
	say(skipped.badTime, "KPI points skipped: unparseable time");
	say(skipped.badValue, "KPI points skipped: value is not a number");
	say(skipped.badStatus, "KPI points skipped: status is neither measured nor failed");
	say(skipped.duplicate, "duplicate KPI points skipped");
	say(skipped.legacyRollup, "legacy sync_up/down points skipped: facet roll-ups without slice.stack (the stack lines carry the measurement)");
	return { points, lines, skipped };
}

const SLICE_ORDER = ["direction", "op", "provider", "profile"];
function sliceKey(slice) {
	const keys = Object.keys(slice).filter((k) => k !== "env");
	keys.sort((a, b) => {
		const ia = SLICE_ORDER.indexOf(a), ib = SLICE_ORDER.indexOf(b);
		return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
	});
	return keys;
}
// the identity of a slice apart from its env
const sliceId = (slice) => JSON.stringify(Object.entries(slice).filter(([k]) => k !== "env").sort());
const sliceLabel = (slice) => sliceKey(slice).map((k) => String(slice[k])).join(" · ") || "all";
const iso = (ms) => new Date(ms).toISOString();

function buildSeries(points, metric, now) {
	const byKey = new Map();
	for (const p of points) {
		const k = p.env + "|" + JSON.stringify(sliceKey(p.slice).map((x) => [x, p.slice[x]]));
		if (!byKey.has(k)) byKey.set(k, []);
		byKey.get(k).push(p);
	}
	const from = now - WINDOW_DAYS * DAY_MS;
	const series = [];
	for (const list of byKey.values()) {
		list.sort((a, b) => a.t - b.t);
		const measured = list.filter((p) => !p.failed);
		const failed = list.filter((p) => p.failed);
		const lastMeasured = measured.at(-1);
		const inWindow = measured.filter((p) => p.t >= from);
		const values = inWindow.map((p) => p.v);
		const slice = { ...list[0].slice };
		delete slice.env;
		const labels = lastMeasured?.labels ?? {};
		series.push({
			// where the folders are (cost points only): null = the point does not say
			onStore: typeof labels.is_store_provider === "boolean" ? labels.is_store_provider : null,
			unpriced: labels.store_unpriced === true,
			providerName: typeof labels.provider_name === "string" ? labels.provider_name : String(slice.provider ?? ""),
			folders: Array.isArray(labels.folders) ? labels.folders.map(String) : [],
			env: list[0].env,
			slice,
			label: sliceLabel(list[0].slice),
			latest: lastMeasured ? lastMeasured.v : null,
			latestAt: lastMeasured ? iso(lastMeasured.t) : null,
			status: lastMeasured ? classify(metric, lastMeasured.v) : "none",
			lastRunFailed: failed.length > 0 && (!lastMeasured || failed.at(-1).t > lastMeasured.t),
			pointsAll: measured.length,
			points: inWindow.map((p) => ({ t: iso(p.t), v: p.v, sha: p.sha })),
			// every measured point, newest HISTORY_POINTS of them, for the history chart (time or commits on the x axis)
			history: measured.slice(-HISTORY_POINTS).map((p) => ({ t: iso(p.t), v: p.v, sha: p.sha })),
			min: values.length ? Math.min(...values) : null,
			max: values.length ? Math.max(...values) : null,
		});
	}
	series.sort((a, b) => a.label.localeCompare(b.label) || a.env.localeCompare(b.env));
	return series;
}

// One cell of the at-a-glance card: the env's headline (worst or best latest value over its slices) and a 30-day line of
// that same aggregate, carried forward from slice to slice so the line ends on the headline.
function buildCell(metric, env, points, series, now) {
	// WHY no `tool` slices: a competitor (or an old folder-sync variant) measured on the same rig is a comparison row of the series
	// table, never the headline. Counting lsyncd's 15 s as folder-sync's "Fast" made the objective read 15 s when it is 0.3 s.
	const mine = series.filter((s) => s.env === env && s.slice.tool === undefined);
	let chosen = mine;
	if (metric.prefer) {
		const preferred = mine.filter((s) => metric.prefer.re.test(String(s.slice[metric.prefer.key] ?? "")));
		if (preferred.length) chosen = preferred;
	}
	const withValue = chosen.filter((s) => s.latest !== null);
	const pick = metric.agg === "best" ? Math.min : Math.max;
	// the cost headline: the providers that hold a folder, when the points say which
	const storeAware = metric.headline === "store" && withValue.some((s) => s.onStore !== null);
	const held = storeAware ? withValue.filter((s) => s.onStore === true) : withValue;
	const unpriced = storeAware && held.length === 0;
	const value = held.length ? (storeAware ? Math.max : pick)(...held.map((s) => s.latest)) : null;
	const cheapestSeries = storeAware && withValue.length ? withValue.reduce((a, b) => (b.latest < a.latest ? b : a)) : null;
	const lastRunFailed = chosen.some((s) => s.lastRunFailed);
	const last = held.length ? held.map((s) => s.latestAt).sort().at(-1) : null;

	const wanted = new Set((storeAware ? held : chosen).map((s) => sliceId(s.slice)));
	const events = points.filter((p) => !p.failed && p.env === env && wanted.has(sliceId(p.slice))).sort((a, b) => a.t - b.t);
	const state = new Map();
	const line = [];
	for (const e of events) {
		state.set(sliceId(e.slice), e.v);
		if (e.t < now - WINDOW_DAYS * DAY_MS) continue;
		const v = (storeAware ? Math.max : pick)(...state.values());
		if (line.length && line.at(-1).ms === e.t) line.pop(); // several slices measured in the same run: keep the last aggregate
		line.push({ ms: e.t, t: iso(e.t), v });
	}
	const status = value === null ? (lastRunFailed ? "red" : "none") : classify(metric, value);
	const cell = {
		value, status, t: last, lastRunFailed,
		stale: last !== null && Date.parse(last) < now - WINDOW_DAYS * DAY_MS,
		nSeries: chosen.length,
		sparkline: line.map(({ t, v }) => ({ t, v })),
	};
	if (metric.headline === "store") {
		cell.provider = storeAware ? [...new Set(held.map((s) => s.providerName))].join(", ") : null;
		cell.folders = storeAware ? [...new Set(held.flatMap((s) => s.folders))].sort() : [];
		cell.unpriced = unpriced;
		cell.cheapest = cheapestSeries ? { value: cheapestSeries.latest, provider: cheapestSeries.providerName } : null;
	}
	return cell;
}

function buildGates(source, warnings) {
	let doc = null;
	if (source.found) {
		try {
			doc = JSON.parse(source.text);
			if (!doc || typeof doc !== "object" || !Array.isArray(doc.gates)) throw new Error("no gates array");
		} catch (err) {
			warnings.push(`gates.json ignored: ${err.message}`);
			doc = null;
		}
	}
	const byId = new Map();
	for (const g of doc?.gates ?? []) {
		if (g && typeof g.id === "string" && GATE_NAMES[g.id]) byId.set(g.id, g);
		else warnings.push(`gates.json: ignored an entry with id ${JSON.stringify(g?.id)}`);
	}
	const gates = Object.keys(GATE_NAMES).map((id) => {
		const g = byId.get(id);
		if (!g) return { id, name: GATE_NAMES[id], status: "unknown", summary: "Not reported yet", tests: [], evidence: [] };
		let status = g.status;
		if (!GATE_STATUSES.includes(status)) {
			warnings.push(`gates.json: ${id} has status ${JSON.stringify(g.status)}, shown as unknown`);
			status = "unknown";
		}
		return {
			id, name: String(g.name ?? GATE_NAMES[id]), status, summary: String(g.summary ?? ""),
			tests: (Array.isArray(g.tests) ? g.tests : []).map((t) => ({
				name: String(t?.name ?? ""), status: ["pass", "fail", "skip"].includes(t?.status) ? t.status : "skip",
				duration_ms: Number.isFinite(t?.duration_ms) ? t.duration_ms : null, detail: String(t?.detail ?? ""),
			})),
			evidence: (Array.isArray(g.evidence) ? g.evidence : []).map(String),
		};
	});
	const gateSummary = { pass: 0, fail: 0, not_built: 0, skipped: 0, unknown: 0 };
	for (const g of gates) gateSummary[g.status]++;
	return { gates, gateSummary, run: doc ? { run_at: doc.run_at ?? null, code_sha: doc.code_sha ?? null, branch: doc.branch ?? null } : null };
}

// "Is it syncing?": the passive stall check's health KPI (bench/kpi/stall.mjs). The verdict is the newest production point: any stalled
// folder is red; nothing recent is "not being checked" (the timer is off), not "fine"; offline is never red.
function buildHealth(points, nowMs) {
	const mine = points.filter((p) => HEALTH_KPIS.includes(p.kpi) && p.env === "prod").sort((a, b) => a.t - b.t);
	const result = (p) => (typeof p.labels.result === "string" ? p.labels.result : p.failed ? "stalled" : "ok");
	const latest = mine.at(-1);
	const folders = latest ? {
		t: iso(latest.t), value: latest.v, result: result(latest), sha: latest.sha, checked: Number(latest.labels.checked ?? 0), pending: Number(latest.labels.pending ?? 0),
		stalled: (Array.isArray(latest.labels.stalled) ? latest.labels.stalled : []).map((f) => ({ project: String(f?.project ?? ""), cause: String(f?.cause ?? ""), detail: String(f?.detail ?? ""), age_min: Number.isFinite(f?.age_min) ? f.age_min : null })),
	} : null;
	let status = "none";
	if (latest) status = folders.result === "stalled" ? "red" : nowMs - latest.t > HEALTH_STALE_MS ? "stale" : folders.result === "offline" ? "offline" : "ok";
	const lines = (folders?.stalled ?? []).map((f) => `${f.project}: ${f.detail}`);
	// the strip: the last 48 points, oldest to newest (a point is written when the result changes and once an hour while it does not)
	const strip = mine.slice(-48).map((p) => ({ t: iso(p.t), result: result(p), value: p.v }));
	return { status, folders, lines, strip, newest: latest ? iso(latest.t) : null, stale: status === "stale", points: mine.length, stalledChecks: mine.filter((p) => result(p) === "stalled").length };
}

// The gates' history (scripts/gates-history): one column per run, newest HISTORY_RUNS of them, oldest to newest.
function buildGatesHistory(source, warnings) {
	const empty = { found: source.found, path: source.path ?? null, runs: [] };
	if (!source.found) return empty;
	const runs = [];
	let bad = 0;
	for (const raw of (source.text ?? "").split("\n")) {
		if (!raw.trim()) continue;
		let e;
		try { e = JSON.parse(raw); } catch { bad++; continue; }
		if (!e || e.schema !== "folder-sync-gates-history/1" || typeof e.id !== "string") { bad++; continue; }
		const gates = {};
		for (const id of Object.keys(GATE_NAMES)) {
			const g = e.gates?.[id];
			gates[id] = g && GATE_STATUSES.includes(g.status) ? { status: g.status, failing: (Array.isArray(g.failing) ? g.failing : []).map(String), failing_total: Number(g.failing_total ?? 0), summary: String(g.summary ?? "") } : { status: e.gates ? "unknown" : "none", failing: [], failing_total: 0, summary: "" };
		}
		runs.push({ id: e.id, source: e.source === "local" ? "local" : "ci", branch: e.branch ?? null, sha: typeof e.sha === "string" ? e.sha : null, t: e.t ?? null, url: typeof e.url === "string" && /^https:\/\//.test(e.url) ? e.url : null, conclusion: e.conclusion ?? null, note: String(e.note ?? ""), hasResult: Boolean(e.gates), gates });
	}
	if (bad) warnings.push(`${bad} lines of the gates history skipped: not folder-sync-gates-history/1`);
	runs.sort((a, b) => (Date.parse(a.t) || 0) - (Date.parse(b.t) || 0));
	return { ...empty, total: runs.length, runs: runs.slice(-HISTORY_RUNS) };
}

// "vs Dropbox Plus $11.99, Google One $2.99, Obsidian Sync $4 per person-month": the three Zach named (Dropbox, Google Drive, Obsidian
// Sync), each by its cheapest listed plan at 10 GB; the cheapest other vendors stand in when one of them is not listed.
const NAMED_COMPETITORS = [/dropbox/i, /google/i, /obsidian/i];
export function competitorLine(byVendor) {
	const usd = (v) => `$${v.toFixed(2)}`;
	const named = NAMED_COMPETITORS.map((re) => byVendor.find((v) => re.test(v.vendor) || re.test(v.name))).filter(Boolean);
	const shown = named.length ? named : byVendor.slice(0, 3);
	return shown.length ? `vs ${shown.map((v) => `${v.name} ${usd(v.per_person_month_10gb_usd)}`).join(", ")} per person-month at 10 GB` : null;
}

// What the competitors cost (bench/cost/competitors.json, folder-sync-competitor-prices/1, written by the cost lane), beside
// folder-sync's own number in the same row style. Absent or broken: null, and the page says nothing about it.
function buildCompetitors(source, objectives, warnings) {
	if (!source.found) return null;
	let doc;
	try {
		doc = JSON.parse(source.text);
		if (!doc || doc.schema !== "folder-sync-competitor-prices/1" || !Array.isArray(doc.items)) throw new Error("not folder-sync-competitor-prices/1");
	} catch (err) {
		warnings.push(`competitor prices ignored: ${err.message}`);
		return null;
	}
	const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
	const items = doc.items.filter((i) => i && typeof i.name === "string").map((i) => ({
		name: i.name, vendor: String(i.vendor ?? i.name), plan: String(i.plan ?? ""), price_usd_month: num(i.price_usd_month), billing: String(i.billing ?? ""), storage_gb: num(i.storage_gb),
		per_gb_month_usd: num(i.per_gb_month_usd), per_person_month_10gb_usd: num(i.per_person_month_10gb_usd), notes: String(i.notes ?? ""),
		source_url: typeof i.source_url === "string" && /^https:\/\//.test(i.source_url) ? i.source_url : null, accessed: String(i.accessed ?? ""),
		// the optional per-tier shape: [{storage_gb, price_usd_month, per_gb_month_usd}], smallest first; an item without it stays valid
		tiers: (Array.isArray(i.tiers) ? i.tiers : []).filter((x) => x && num(x.storage_gb) !== null).map((x) => ({ storage_gb: x.storage_gb, price_usd_month: num(x.price_usd_month), per_gb_month_usd: num(x.per_gb_month_usd) })).sort((a, b) => a.storage_gb - b.storage_gb),
	}));
	items.sort((a, b) => (a.per_person_month_10gb_usd ?? Infinity) - (b.per_person_month_10gb_usd ?? Infinity));
	const cheapestByVendor = new Map();
	for (const i of items) if (i.per_person_month_10gb_usd !== null && !cheapestByVendor.has(i.vendor)) cheapestByVendor.set(i.vendor, i);
	const o3 = objectives.find((o) => o.id === "O3");
	const cell = (kpi, env) => o3?.metrics.find((m) => m.kpi === kpi)?.env[env];
	const pickEnv = ["prod", "test"].find((e) => cell("cost_per_person_month_usd", e)?.value !== null && cell("cost_per_person_month_usd", e)?.value !== undefined) ?? null;
	const own = pickEnv ? {
		name: "folder-sync", vendor: "folder-sync", plan: `on ${cell("cost_per_person_month_usd", pickEnv).provider ?? "the cheapest provider"} (${pickEnv})`, per_gb_month_usd: cell("cost_per_gb_month_usd", pickEnv)?.value ?? null,
		per_person_month_10gb_usd: cell("cost_per_person_month_usd", pickEnv).value, env: pickEnv,
	} : null;
	const byVendor = [...cheapestByVendor.values()].map((i) => ({ vendor: i.vendor, name: i.name, per_person_month_10gb_usd: i.per_person_month_10gb_usd }));
	return { as_of: String(doc.as_of ?? ""), items, own, byVendor, line: competitorLine(byVendor) };
}

export function buildModel(sources, { now = Date.now() } = {}) {
	const nowMs = typeof now === "number" ? now : Date.parse(now);
	const warnings = [];
	if (sources.kpi.error) warnings.push(`KPI series unreadable: ${sources.kpi.error}`);
	if (sources.gates.error) warnings.push(`gates unreadable: ${sources.gates.error}`);
	const parsed = parsePoints(sources.kpi, warnings);
	const objectives = OBJECTIVES.map((o) => {
		const metrics = o.metrics.map((m) => {
			const mine = parsed.points.filter((p) => p.kpi === m.kpi);
			const series = buildSeries(mine, m, nowMs);
			const env = Object.fromEntries(ENVS.map((e) => [e, buildCell(m, e, mine, series, nowMs)]));
			return { ...m, prefer: undefined, env, series };
		});
		const statuses = metrics.filter((m) => m.primary && m.target !== undefined).flatMap((m) => ENVS.map((e) => m.env[e].status));
		return { id: o.id, name: o.name, blurb: o.blurb, status: worstStatus(statuses), metrics };
	});
	const g = buildGates(sources.gates, warnings);
	const health = buildHealth(parsed.points, nowMs);
	const gatesHistory = buildGatesHistory(sources.history ?? { found: false }, warnings);
	const competitors = buildCompetitors(sources.competitors ?? { found: false }, objectives, warnings);
	return {
		schema: "folder-sync-dev-status/1",
		generated_at: new Date().toISOString(),
		now: iso(nowMs),
		window_days: WINDOW_DAYS,
		inputs: {
			kpi: { path: sources.kpi.path ?? null, found: sources.kpi.found, lines: parsed.lines, points: parsed.points.length },
			gates: { path: sources.gates.path ?? null, found: sources.gates.found, ...(g.run ?? {}) },
			history: { path: sources.history?.path ?? null, found: Boolean(sources.history?.found), runs: gatesHistory.runs.length },
			competitors: { path: sources.competitors?.path ?? null, found: Boolean(sources.competitors?.found) },
		},
		objectives,
		health,
		gatesHistory,
		competitors,
		gates: g.gates,
		gateSummary: g.gateSummary,
		warnings,
	};
}
