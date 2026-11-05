// The dev view's page: the model (status-model.mjs) in, one self-contained HTML string out. No CDN, no external font, no
// framework: inline CSS, inline SVG charts and ~20 lines of script for the hover tooltip. Opening a card or a gate is a
// URL fragment (:target), so it works without script, survives a reload and the back button returns to the glance.
import { readFileSync } from "node:fs";
import { WINDOW_DAYS } from "./status-model.mjs";

// The chart library, vendored and pinned (scripts/dev-view-vendor/README.md), inlined so the page stays one file with no CDN.
export const CHART_JS_VERSION = "4.4.7";
const CHARTS_JS = readFileSync(new URL("./dev-view-charts.js", import.meta.url), "utf8");
const CHART_JS = readFileSync(new URL("./dev-view-vendor/chart.umd.js", import.meta.url), "utf8").replace(/<\/(script)/gi, "<\\/$1");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const DAY_MS = 864e5;
const ENVS = ["test", "prod"];

function sig(v, digits = 2) {
	return String(Number(v.toPrecision(digits)));
}
export function fmt(unit, v) {
	if (v === null || v === undefined || !Number.isFinite(v)) return "–";
	switch (unit) {
		case "ms": return v < 1000 ? `${Math.round(v)} ms` : `${Number((v / 1000).toFixed(1))} s`;
		case "usd": return v < 0.1 ? `$${sig(v)}` : `$${v.toFixed(2)}`;
		case "pct": return `${sig(v)} %`;
		case "ops": return sig(v, 3);
		default: return v >= 100 ? String(Math.round(v)) : sig(v);
	}
}
const shortDate = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const stamp = (isoText) => (isoText ? String(isoText).replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, " UTC") : "–");
function ago(isoText, nowMs) {
	const d = nowMs - Date.parse(isoText);
	if (!Number.isFinite(d)) return "";
	if (d < 6e4) return "just now";
	if (d < 36e5) return `${Math.round(d / 6e4)} min ago`;
	if (d < 2 * DAY_MS) return `${Math.round(d / 36e5)} h ago`;
	return `${Math.round(d / DAY_MS)} d ago`;
}
const duration = (ms) => (ms === null ? "–" : fmt("ms", ms));

const STATUS_WORD = { ok: "meets target", amber: "near miss", red: "misses target", none: "not measured yet", info: "" };
const targetText = (m) => (m.target === undefined ? "" : `≤ ${fmt(m.unit, m.target)}`);

// --- charts -----------------------------------------------------------------------------------------------------------

function scale(domain, range) {
	const [d0, d1] = domain, [r0, r1] = range;
	return (x) => (d1 === d0 ? (r0 + r1) / 2 : r0 + ((x - d0) / (d1 - d0)) * (r1 - r0));
}
function yDomain(values) {
	let lo = Math.min(...values), hi = Math.max(...values);
	if (lo === hi) {
		const pad = Math.abs(lo) * 0.1 || 1;
		return [lo - pad, hi + pad];
	}
	const pad = (hi - lo) * 0.1;
	return [lo >= 0 && lo - pad < 0 ? 0 : lo - pad, hi + pad]; // a non-negative KPI never gets a negative axis
}

function spark(cell, nowMs) {
	const W = 160, H = 28, from = nowMs - WINDOW_DAYS * DAY_MS;
	const pts = cell.sparkline.map((p) => ({ x: Date.parse(p.t), v: p.v }));
	if (!pts.length) return "";
	const sx = scale([from, nowMs], [3, W - 3]);
	const sy = scale(yDomain(pts.map((p) => p.v)).reverse(), [3, H - 3]);
	const d = pts.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)} ${sy(p.v).toFixed(1)}`).join("");
	const last = pts.at(-1);
	return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="last 30 days"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${sx(last.x).toFixed(1)}" cy="${sy(last.v).toFixed(1)}" r="3" fill="currentColor"/></svg>`;
}

// One chart per slice group (Chart.js, drawn by the script at the bottom): the test and prod lines over time or over commits, the
// target a dashed line, a tooltip with value, commit and time. `registry.specs` is the data the script reads; the canvas names its spec.
function chartFigure(group, metric, registry, { caption = group[0].label } = {}) {
	const series = group.filter((s) => s.history.length).map((s) => ({ env: s.env, points: s.history }));
	if (!series.length) {
		return `<figure class="chart"><figcaption>${esc(caption)}</figcaption><p class="empty">no points yet${group.some((s) => s.latest !== null) ? ` (latest ${group.map((s) => `${esc(s.env)} ${esc(fmt(metric.unit, s.latest))}`).join(", ")})` : ""}</p></figure>`;
	}
	const index = registry.specs.push({ title: metric.title, label: caption, unit: metric.unit, target: metric.target ?? null, series }) - 1;
	return `<figure class="chart"><figcaption>${esc(caption)}</figcaption><div class="cv"><canvas data-chart="${index}" role="img" aria-label="${esc(metric.title)}, ${esc(caption)}, over time or commits"></canvas></div></figure>`;
}

// --- at a glance ------------------------------------------------------------------------------------------------------

// The cost cells' second line: the cheapest provider's price, whichever provider the folder is on (cost points only).
function cheapestHtml(metric, c) {
	return c.cheapest ? `<span class="cap" data-cheapest>cheapest provider: ${esc(c.cheapest.provider)} ${esc(fmt(metric.unit, c.cheapest.value))}</span>` : "";
}

function cellHtml(metric, env, nowMs) {
	const c = metric.env[env];
	const attrs = `class="cell env-${env}" data-cell="${esc(metric.kpi)}:${env}" data-status="${c.status}"`;
	if (c.value === null) {
		// WHY not the cheapest as the headline: a folder on a MinIO, a NAS or a directory has no price, and a price for a store it is not on would be wrong
		if (c.unpriced) return `<div ${attrs}><span class="val none">no price for this store</span>${cheapestHtml(metric, c)}</div>`;
		return `<div ${attrs}><span class="val none">${c.lastRunFailed ? `<span class="dot" data-status="red"></span>last run failed` : "not measured yet"}</span></div>`;
	}
	const bits = [];
	if (c.provider) bits.push(`on ${esc(c.provider)}`);
	if (metric.target !== undefined) bits.push(`${STATUS_WORD[c.status]} ${esc(targetText(metric))}`);
	else if (metric.note) bits.push(esc(metric.note));
	bits.push(c.stale ? `last measured ${esc(ago(c.t, nowMs))}` : esc(ago(c.t, nowMs)));
	return `<div ${attrs}>
		<span class="val"><span class="dot" data-status="${c.status}"></span>${esc(fmt(metric.unit, c.value))}</span>
		${spark(c, nowMs)}
		<span class="cap">${bits.join(" · ")}</span>
		${cheapestHtml(metric, c)}
		${c.lastRunFailed ? `<span class="cap bad">✗ last run failed</span>` : ""}
	</div>`;
}

function cardHtml(o, nowMs, competitors) {
	const rows = o.metrics.filter((m) => m.primary).map((m) => `
		<div class="row"><span class="rl">${esc(m.label)}${m.target !== undefined ? ` <small>${esc(targetText(m))}</small>` : ""}</span>
			${ENVS.map((e) => cellHtml(m, e, nowMs)).join("")}</div>`).join("");
	return `<a class="card" id="card-${o.id.toLowerCase()}" href="#${o.id.toLowerCase()}" data-status="${o.status}">
		<span class="card-head"><span class="dot" data-status="${o.status}"></span><h2>${esc(o.id)} · ${esc(o.name)}</h2><span class="more">details ›</span></span>
		<span class="blurb">${esc(o.blurb)}</span>
		<span class="envs"><span></span><span class="envtag env-test">test</span><span class="envtag env-prod">prod</span></span>
		${rows}
		${o.id === "O3" && competitors?.line ? `<span class="cap vs" data-competitors>${esc(competitors.line)}</span>` : ""}
	</a>`;
}

const GLYPH = { pass: "✓", fail: "✗", not_built: "○", skipped: "–", unknown: "?" };
const GATE_WORD = { pass: "pass", fail: "fail", not_built: "not built", skipped: "skipped", unknown: "no result" };

function pillHtml(g) {
	return `<a class="gate-pill" id="pill-${g.id.toLowerCase()}" href="#${g.id.toLowerCase()}" data-status="${g.status}"><b>${esc(g.id)}</b><span class="gname">${esc(g.name)}</span><span class="gst">${GLYPH[g.status]} ${GATE_WORD[g.status]}</span></a>`;
}

// --- drill down -------------------------------------------------------------------------------------------------------

function metricDetail(m, nowMs, registry) {
	const headline = ENVS.map((e) => {
		const c = m.env[e];
		return `<span class="hl env-${e}"><span class="envtag env-${e}">${e}</span> <span class="dot" data-status="${c.status}"></span><b>${esc(fmt(m.unit, c.value))}</b></span>`;
	}).join("");
	const groups = new Map();
	for (const s of m.series) {
		if (!groups.has(s.label)) groups.set(s.label, []);
		groups.get(s.label).push(s);
	}
	const charts = [...groups.values()].map((g) => chartFigure(g, m, registry)).join("");
	const rows = m.series.map((s) => `<tr>
		<td data-label="Slice">${esc(s.label)}${s.onStore ? ` <small>${esc(s.folders.length ? `holds ${s.folders.join(", ")}` : "holds a folder")}</small>` : ""}</td>
		<td data-label="Env"><span class="envtag env-${esc(s.env)}">${esc(s.env)}</span></td>
		<td data-label="Latest"><span class="dot" data-status="${s.status}"></span>${esc(fmt(m.unit, s.latest))}${s.lastRunFailed ? ` <span class="bad">✗ last run failed</span>` : ""}</td>
		<td data-label="Status">${esc(STATUS_WORD[s.status] || "–")}</td>
		<td data-label="${WINDOW_DAYS}-day range">${s.min === null ? "–" : `${esc(fmt(m.unit, s.min))} to ${esc(fmt(m.unit, s.max))}`}</td>
		<td data-label="Points">${s.points.length}${s.pointsAll > s.points.length ? ` <small>of ${s.pointsAll}</small>` : ""}</td>
		<td data-label="Last measured">${s.latestAt ? `${esc(stamp(s.latestAt))} <small>${esc(ago(s.latestAt, nowMs))}</small>` : "–"}</td></tr>`).join("");
	const sub = [m.target !== undefined ? `target ${esc(targetText(m))}` : "no target set", m.stretch !== undefined ? `stretch ≤ ${esc(fmt(m.unit, m.stretch))}` : "", m.note ? esc(m.note) : ""].filter(Boolean).join(" · ");
	return `<section class="metric" id="m-${esc(m.kpi)}">
		<h3>${esc(m.title)}</h3><p class="sub">${sub}</p><p class="heads">${headline}</p>
		${m.series.length ? `<div class="charts">${charts}</div>
		<table><thead><tr><th>Slice</th><th>Env</th><th>Latest</th><th>Status</th><th>${WINDOW_DAYS}-day range</th><th>Points</th><th>Last measured</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="empty">not measured yet</p>`}
	</section>`;
}

function objectiveDetail(o, nowMs, registry, competitors) {
	return `<section class="detail" id="${o.id.toLowerCase()}">
		<header><h2><span class="dot" data-status="${o.status}"></span>${esc(o.id)} · ${esc(o.name)}</h2><a class="close" href="#">Close ×</a></header>
		<p class="sub">${esc(o.blurb)}. <span class="legend"><span class="envtag env-test">test</span> <span class="envtag env-prod">prod</span> lines are every measured point; the dashed line is the target. Hover a point for its value, commit and time.</span></p>
		${axisToggle()}
		${o.metrics.map((m) => metricDetail(m, nowMs, registry)).join("")}
		${o.id === "O3" ? competitorsTable(competitors) : ""}
	</section>`;
}

const axisToggle = () => `<div class="seg" role="group" aria-label="X axis"><span class="seg-l">x axis</span><button type="button" data-axis="time" aria-pressed="true">Time</button><button type="button" data-axis="commit" aria-pressed="false">Commits</button></div>`;

// What the others cost, in the same row style as folder-sync's own number (bench/cost/competitors.json).
function competitorsTable(c) {
	if (!c) return "";
	const usd = (v) => (v === null || v === undefined ? "–" : `$${v < 0.1 ? Number(v.toPrecision(2)) : v.toFixed(2)}`);
	const row = (i, own) => `<tr${own ? ' class="own"' : ""}>
		<td data-label="Service">${own ? "<b>folder-sync</b>" : esc(i.name)}${i.plan && !own ? ` <small>${esc(i.plan)}</small>` : ""}${own ? ` <small>${esc(i.plan)}</small>` : ""}</td>
		<td data-label="Per month">${own ? "–" : esc(usd(i.price_usd_month))}${!own && i.billing ? ` <small>${esc(i.billing)}</small>` : ""}</td>
		<td data-label="Storage">${own || i.storage_gb === null ? "–" : `${esc(String(i.storage_gb))} GB`}</td>
		<td data-label="Per GB-month">${esc(usd(i.per_gb_month_usd))}</td>
		<td data-label="Per person-month, 10 GB"><b>${esc(usd(i.per_person_month_10gb_usd))}</b></td>
		<td data-label="Source">${own ? "this build, the dev view's O3 numbers" : `${i.source_url ? `<a href="${esc(i.source_url)}" rel="noreferrer">price page</a>` : "–"} <small>${esc(i.accessed)}</small>${i.notes ? ` <small>${esc(i.notes)}</small>` : ""}`}</td></tr>`;
	const rows = [...(c.own ? [row(c.own, true)] : []), ...c.items.map((i) => row(i, false))].join("");
	return `<section class="metric" id="m-competitors"><h3>What the others cost</h3><p class="sub">List prices as of ${esc(c.as_of || "an unknown date")}; folder-sync's row is its own current number on the provider each folder is on.</p>
		<table><thead><tr><th>Service</th><th>Per month</th><th>Storage</th><th>Per GB-month</th><th>Per person-month, 10 GB</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function evidenceItem(e) {
	return /^https?:\/\//.test(e) ? `<li><a href="${esc(e)}" rel="noreferrer">${esc(e)}</a></li>` : `<li><code>${esc(e)}</code></li>`;
}

function gateDetail(g, model) {
	const run = model.inputs.gates;
	const tests = g.tests.length ? `<table><thead><tr><th>Test</th><th>Status</th><th>Duration</th><th>Detail</th></tr></thead><tbody>${g.tests.map((t) => `<tr data-status="${t.status}">
		<td data-label="Test">${esc(t.name)}</td><td data-label="Status"><span class="tst" data-status="${t.status}">${t.status === "pass" ? "✓ pass" : t.status === "fail" ? "✗ fail" : "– skip"}</span></td>
		<td data-label="Duration">${esc(duration(t.duration_ms))}</td><td data-label="Detail">${esc(t.detail) || "–"}</td></tr>`).join("")}</tbody></table>` : `<p class="empty">${g.status === "unknown" ? "No result reported for this gate yet." : "No individual tests listed."}</p>`;
	return `<section class="detail" id="${g.id.toLowerCase()}">
		<header><h2>${esc(g.id)} · ${esc(g.name)} <span class="gate-badge" data-status="${g.status}">${GLYPH[g.status]} ${GATE_WORD[g.status]}</span></h2><a class="close" href="#">Close ×</a></header>
		${g.summary ? `<p class="sub">${esc(g.summary)}</p>` : ""}
		${g.status !== "unknown" ? `<p class="sub">Run ${esc(stamp(run.run_at))}${run.code_sha ? ` · <code>${esc(run.code_sha)}</code>` : ""}${run.branch ? ` · ${esc(run.branch)}` : ""}</p>` : ""}
		${tests}
		${g.evidence.length ? `<h3>Evidence</h3><ul class="evidence">${g.evidence.map(evidenceItem).join("")}</ul>` : ""}
	</section>`;
}

// --- is it syncing? ---------------------------------------------------------------------------------------------------

const LIVE_WORD = { red: "stalled", ok: "syncing", stale: "not being checked", offline: "offline, not measured", none: "not measured yet" };
const STRIP_WORD = { ok: "ok", stalled: "stalled", offline: "offline, not measured" };
const CAUSE_WORD = { lock: "held lock", quota: "over quota", auth: "signed out", round_failed: "failing rounds", no_rounds: "no engine running", engine_exited: "engine exited", no_propagation: "not online in time", server: "server error" };
const liveDot = (h) => (h.status === "red" ? "red" : h.status === "ok" ? "ok" : h.status === "stale" ? "amber" : "none");

// WHY a bar only when it is red: a page that is calm when nothing is wrong is one where a red bar is seen (Zach: Notion/Obsidian restraint)
function liveBar(h, nowMs) {
	if (h.status === "red") {
		return `<a class="alert" href="#live" role="alert" data-live="red"><b>Sync stalled</b><span>${h.lines.map(esc).join(" · ") || "a sync check failed"}</span><span class="more">details ›</span></a>`;
	}
	const bits = [];
	if (h.canary?.result === "ok") bits.push(`canary file online in ${esc(fmt("ms", h.canary.value))}`);
	else if (h.canary?.result === "offline") bits.push("offline, not measured");
	if (h.folders && h.folders.result !== "offline") bits.push(`${h.folders.checked} folder${h.folders.checked === 1 ? "" : "s"} checked, none stalled`);
	if (h.status === "stale") bits.push(`last checked ${esc(ago(h.newest, nowMs))}: is the folder-sync-canary timer running?`);
	else if (h.newest) bits.push(esc(ago(h.newest, nowMs)));
	const text = h.status === "none" ? "Live sync check: not measured yet (install it with node bench/kpi/canary.mjs install-timer)" : bits.join(" · ");
	return `<a class="livebar" href="#live" data-live="${h.status}"><span class="dot" data-status="${liveDot(h)}"></span><b>Sync</b> <span>${text}</span><span class="more">history ›</span></a>`;
}

function liveDetail(h, nowMs, registry) {
	const strip = h.strip.length
		? `<div class="strip" role="img" aria-label="the last ${h.strip.length} canary checks">${h.strip.map((c) => `<span class="sc" data-result="${esc(c.result)}" data-tip="${esc(`${stamp(c.t)} · ${STRIP_WORD[c.result] ?? c.result}${c.value !== null ? ` · ${fmt("ms", c.value)}` : ""}`)}"></span>`).join("")}</div><p class="cap">The last ${h.strip.length} checks, oldest to newest: <span class="sc" data-result="ok"></span> ok <span class="sc" data-result="stalled"></span> stalled <span class="sc" data-result="offline"></span> offline, not measured.</p>`
		: `<p class="empty">no checks yet</p>`;
	const chart = h.canaryHistory.length ? chartFigure([{ env: "prod", label: "Canary file, saved to online", latest: h.canaryHistory.at(-1).v, history: h.canaryHistory }], { title: "Sync canary", unit: "ms" }, registry, { caption: "Canary file, saved to online (prod)" }) : "";
	const stalledRows = (h.folders?.stalled ?? []).map((f) => `<tr><td data-label="Folder">${esc(f.project)}</td><td data-label="Cause">${esc(CAUSE_WORD[f.cause] ?? f.cause)}</td><td data-label="Last clean round">${f.age_min === null ? "never" : `${f.age_min} min ago`}</td><td data-label="Detail">${esc(f.detail)}</td></tr>`).join("");
	const now = h.status === "none" ? `<p class="empty">The check has not run yet. Install it: <code>node bench/kpi/canary.mjs install-timer</code>.</p>` : `<p class="heads">
		<span class="hl"><span class="dot" data-status="${liveDot(h)}"></span><b>${esc(LIVE_WORD[h.status])}</b></span>
		${h.canary ? `<span class="hl">canary <b>${h.canary.result === "ok" ? esc(fmt("ms", h.canary.value)) : esc(h.canary.result)}</b> <small>${esc(ago(h.canary.t, nowMs))}</small></span>` : ""}
		${h.folders ? `<span class="hl">folders <b>${h.folders.result === "offline" ? "offline" : `${h.folders.stalled.length} stalled of ${h.folders.checked}`}</b> <small>${esc(ago(h.folders.t, nowMs))}</small></span>` : ""}</p>
		${h.canary && h.canary.result !== "ok" ? `<p class="sub ${h.canary.result === "stalled" ? "bad" : ""}">Canary: ${esc(h.canary.detail || h.canary.result)}</p>` : ""}`;
	return `<section class="detail" id="live">
		<header><h2><span class="dot" data-status="${liveDot(h)}"></span>Is it syncing?</h2><a class="close" href="#">Close ×</a></header>
		<p class="sub">Every 5 minutes a small file is saved in a dedicated canary folder, synced by the installed engine, and timed until the server serves its bytes; ten minutes without it is a stall. Each synced folder's last clean round is checked the same way. With no route to the server nothing is measured and nothing is red.</p>
		${now}
		<h3>Recent checks</h3>${strip}
		${chart ? `<h3>Canary time over time</h3>${axisToggle()}<div class="charts">${chart}</div>` : ""}
		${stalledRows ? `<h3>Folders that have stopped</h3><table><thead><tr><th>Folder</th><th>Cause</th><th>Last clean round</th><th>Detail</th></tr></thead><tbody>${stalledRows}</tbody></table>` : ""}
	</section>`;
}

// --- gate history -----------------------------------------------------------------------------------------------------

const HIST_GLYPH = { pass: "✓", fail: "✗", not_built: "○", skipped: "–", unknown: "?", none: "·" };
const HIST_WORD = { pass: "pass", fail: "fail", not_built: "not built", skipped: "skipped", unknown: "no result", none: "no gates result for this run" };

function gateHistory(model) {
	const h = model.gatesHistory;
	if (!h.found || !h.runs.length) return `<section aria-label="Gate history" class="ghist"><div class="gates-head"><h2>Gate history</h2></div><p class="empty">${h.found ? "No runs yet" : "Not built yet"}: run <code>scripts/gates-history</code> to collect the CI runs' gate results.</p></section>`;
	const head = h.runs.map((r) => {
		const kind = r.source === "local" ? "local" : r.branch === "main" ? "main" : "branch";
		const sha = r.sha ? r.sha.slice(0, 7) : "?";
		const label = `${sha} · ${r.source === "local" ? "local run" : `CI on ${r.branch ?? "?"}`} · ${stamp(r.t)}${r.conclusion ? ` · ${r.conclusion}` : ""}`;
		const inner = `<span class="rsha">${esc(sha)}</span>`;
		return `<th scope="col" class="run" data-kind="${kind}" data-tip="${esc(label)}">${r.url ? `<a href="${esc(r.url)}" rel="noreferrer" aria-label="${esc(label)}">${inner}</a>` : inner}</th>`;
	}).join("");
	const rows = model.gates.map((g) => `<tr><th scope="row"><a href="#${g.id.toLowerCase()}"><b>${esc(g.id)}</b> <span class="rn">${esc(g.name)}</span></a></th>${h.runs.map((r) => {
		const c = r.gates[g.id];
		const fail = c.failing.length ? ` · ${c.failing.join(" ; ")}${c.failing_total > c.failing.length ? ` (+${c.failing_total - c.failing.length} more)` : ""}` : "";
		const tip = `${g.id} ${g.name} · ${HIST_WORD[c.status]} · ${r.sha ? r.sha.slice(0, 7) : "?"} ${r.source === "local" ? "(local)" : `on ${r.branch ?? "?"}`} · ${stamp(r.t)}${fail}${!r.hasResult && r.note ? ` · ${r.note}` : ""}`;
		return `<td><span class="hc" data-status="${c.status}" data-tip="${esc(tip)}" tabindex="0" aria-label="${esc(tip)}">${HIST_GLYPH[c.status]}</span></td>`;
	}).join("")}</tr>`).join("");
	return `<section aria-label="Gate history" class="ghist">
		<div class="gates-head"><h2>Gate history</h2><span class="meta">the last ${h.runs.length} runs, oldest on the left: <span class="hc" data-status="pass">✓</span> pass <span class="hc" data-status="fail">✗</span> fail <span class="hc" data-status="not_built">○</span> not built <span class="hc" data-status="none">·</span> no result · header edge: <span class="kindkey" data-kind="branch"></span>CI on the branch <span class="kindkey" data-kind="main"></span>CI on main <span class="kindkey" data-kind="local"></span>local</span></div>
		<div class="hwrap"><table class="hgrid"><thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
	</section>`;
}

// --- page -------------------------------------------------------------------------------------------------------------

const ids = (model) => [...model.objectives.map((o) => o.id.toLowerCase()), ...model.gates.map((g) => g.id.toLowerCase())];
const jsonForScript = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

const CSS = `
:root { color-scheme: light; --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --ink-3: #898781; --grid: #e1e0d9; --axis: #c3c2b7;
	--ring: rgba(11, 11, 11, .1); --hover: rgba(11, 11, 11, .04); --test: #2a78d6; --prod: #eb6834;
	--good: #0ca30c; --good-ink: #006300; --warn: #fab219; --warn-ink: #7a5200; --bad: #d03b3b; --bad-ink: #a82a2a; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --ink-3: #898781;
	--grid: #2c2c2a; --axis: #383835; --ring: rgba(255, 255, 255, .1); --hover: rgba(255, 255, 255, .05); --test: #3987e5; --prod: #d95926;
	--good-ink: #0ca30c; --warn-ink: #fab219; --bad-ink: #ec7b7b; } }
:root[data-theme="dark"] { color-scheme: dark; --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --ink-3: #898781;
	--grid: #2c2c2a; --axis: #383835; --ring: rgba(255, 255, 255, .1); --hover: rgba(255, 255, 255, .05); --test: #3987e5; --prod: #d95926;
	--good-ink: #0ca30c; --warn-ink: #fab219; --bad-ink: #ec7b7b; }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
body { margin: 0; background: var(--page); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 20px 16px 48px; }
h1, h2, h3, p, ul { margin: 0; }
h1 { font-size: 20px; font-weight: 600; } h1 span { color: var(--ink-3); font-weight: 400; }
h2 { font-size: 15px; font-weight: 600; } h3 { font-size: 13px; font-weight: 600; margin: 16px 0 4px; }
small, .sub, .meta, .blurb, .cap { color: var(--ink-2); }
small { font-size: 12px; }
code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
a { color: inherit; }
.top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; margin-bottom: 16px; }
.meta { font-size: 12px; }
.banner { margin: 0 0 12px; padding: 8px 12px; border-radius: 6px; background: var(--hover); color: var(--ink-2); font-size: 12px; overflow-wrap: anywhere; }
.hint { color: var(--ink-3); font-size: 12px; margin: 16px 0 0; }
body:has(.detail:target) .hint { display: none; }

/* status: a dot plus a word, never colour alone. Amber and red only for a miss. */
.dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; background: transparent; box-shadow: inset 0 0 0 1.5px var(--axis); flex: none; }
.dot[data-status="ok"] { background: var(--good); box-shadow: none; }
.dot[data-status="amber"] { background: var(--warn); box-shadow: none; }
.dot[data-status="red"] { background: var(--bad); box-shadow: none; }
.dot[data-status="info"] { box-shadow: inset 0 0 0 1.5px var(--ink-3); }
.bad { color: var(--bad-ink); }
.envtag { font-size: 11px; color: var(--ink-2); }
.envtag::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; background: var(--test); }
.envtag.env-prod::before { background: var(--prod); }

/* the glance */
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
.card { display: block; padding: 14px 16px 12px; border-radius: 10px; background: var(--surface); box-shadow: 0 0 0 1px var(--ring); text-decoration: none; }
.card:hover { box-shadow: 0 0 0 1px var(--axis); }
.card-head { display: flex; align-items: center; } .card-head h2 { flex: 1; min-width: 0; }
.more { color: var(--ink-3); font-size: 12px; }
.blurb { display: block; font-size: 12px; margin: 2px 0 10px; }
.envs, .row { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
.envs { margin-bottom: 2px; } .envs > span:first-child { display: none; }
.row { padding: 8px 0 6px; border-top: 1px solid var(--grid); }
.rl { grid-column: 1 / -1; font-size: 12px; color: var(--ink-2); margin-bottom: 2px; }
.cell { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cell.env-test .spark { color: var(--test); } .cell.env-prod .spark { color: var(--prod); }
.val { display: flex; align-items: center; font-size: 22px; font-weight: 600; line-height: 1.2; }
.val.none { font-size: 13px; font-weight: 400; color: var(--ink-3); min-height: 26px; }
.spark { width: 100%; height: auto; display: block; }
.cap { font-size: 11px; line-height: 1.3; }
.cap.vs { display: block; padding-top: 8px; border-top: 1px solid var(--grid); }

.gates { margin-top: 20px; }
.gates-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; margin-bottom: 8px; }
.pills { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.gate-pill { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 6px; padding: 8px 10px; border-radius: 8px; background: var(--surface); box-shadow: 0 0 0 1px var(--ring); text-decoration: none; min-width: 0; }
.gate-pill:hover { box-shadow: 0 0 0 1px var(--axis); }
.gate-pill b { font-size: 12px; } .gname { flex: 1; min-width: 0; font-size: 13px; overflow-wrap: anywhere; }
.gst { width: 100%; font-size: 11px; color: var(--ink-3); }
.gate-pill[data-status="pass"] .gst { color: var(--good-ink); }
.gate-pill[data-status="fail"] { box-shadow: 0 0 0 1.5px var(--bad); } .gate-pill[data-status="fail"] .gst { color: var(--bad-ink); }
.gate-pill[data-status="not_built"] { background: transparent; box-shadow: 0 0 0 1px var(--axis); }
.gate-pill[data-status="unknown"] { background: transparent; box-shadow: none; border: 1px dashed var(--axis); }
.gate-pill[data-status="unknown"] .gname { color: var(--ink-2); }

/* drill-down: only the targeted section shows */
.detail { display: none; margin-top: 24px; padding: 16px; border-radius: 10px; background: var(--surface); box-shadow: 0 0 0 1px var(--ring); scroll-margin-top: 12px; }
.detail:target { display: block; }
.detail > header { display: flex; align-items: center; gap: 12px; } .detail > header h2 { flex: 1; min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; font-size: 17px; }
.close { color: var(--ink-3); font-size: 12px; text-decoration: none; white-space: nowrap; } .close:hover { color: var(--ink); }
.sub { font-size: 12px; margin-top: 4px; }
.gate-badge { font-size: 12px; font-weight: 500; padding: 1px 8px; border-radius: 999px; background: var(--hover); color: var(--ink-2); }
.gate-badge[data-status="pass"] { color: var(--good-ink); } .gate-badge[data-status="fail"] { color: var(--bad-ink); }
.metric { padding-top: 8px; border-top: 1px solid var(--grid); margin-top: 16px; } .metric:first-of-type { margin-top: 12px; }
.metric h3 { margin-top: 8px; font-size: 14px; }
.heads { display: flex; flex-wrap: wrap; gap: 4px 20px; margin: 6px 0 10px; } .hl { display: inline-flex; align-items: center; gap: 4px; font-size: 16px; } .hl .envtag { margin-right: 4px; }
.charts { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px 16px; margin-bottom: 12px; }
.chart { margin: 0; min-width: 0; } .chart figcaption { font-size: 12px; color: var(--ink-2); margin-bottom: 2px; overflow-wrap: anywhere; }
.empty { color: var(--ink-3); font-size: 12px; margin: 6px 0; }
table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 4px; }
th { text-align: left; font-weight: 500; color: var(--ink-3); padding: 4px 8px 4px 0; border-bottom: 1px solid var(--grid); }
td { padding: 6px 8px 6px 0; border-bottom: 1px solid var(--grid); vertical-align: top; overflow-wrap: anywhere; }
td small { color: var(--ink-3); }
.tst[data-status="pass"] { color: var(--good-ink); } .tst[data-status="fail"] { color: var(--bad-ink); } .tst[data-status="skip"] { color: var(--ink-3); }
.evidence { padding-left: 18px; font-size: 12px; } .evidence li { margin: 2px 0; overflow-wrap: anywhere; }
.notes { margin-top: 28px; font-size: 12px; color: var(--ink-2); } .notes summary { cursor: pointer; color: var(--ink-3); } .notes ul { padding-left: 18px; margin-top: 6px; } .notes li { overflow-wrap: anywhere; }
#tip { position: fixed; z-index: 10; pointer-events: none; padding: 4px 8px; border-radius: 6px; background: var(--ink); color: var(--page); font-size: 12px; max-width: min(440px, calc(100vw - 16px)); overflow-wrap: anywhere; }
#tip[hidden] { display: none; }

/* is it syncing */
.alert { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; margin: 0 0 12px; padding: 10px 14px; border-radius: 8px; background: var(--bad); color: #fff; text-decoration: none; font-size: 13px; }
.alert b { font-size: 14px; } .alert span:not(.more) { flex: 1; min-width: 0; overflow-wrap: anywhere; } .alert .more { color: rgba(255, 255, 255, .8); font-size: 12px; }
.livebar { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; margin: 0 0 12px; padding: 8px 12px; border-radius: 8px; background: var(--surface); box-shadow: 0 0 0 1px var(--ring); text-decoration: none; font-size: 13px; }
.livebar:hover { box-shadow: 0 0 0 1px var(--axis); } .livebar > span:not(.dot):not(.more) { flex: 1; min-width: 0; color: var(--ink-2); overflow-wrap: anywhere; } .livebar .more { color: var(--ink-3); font-size: 12px; }
.strip { display: flex; flex-wrap: wrap; gap: 3px; margin: 6px 0 4px; }
.sc { display: inline-block; width: 10px; height: 18px; border-radius: 2px; vertical-align: middle; background: var(--good); }
.sc[data-result="stalled"] { background: var(--bad); } .sc[data-result="offline"] { background: transparent; box-shadow: inset 0 0 0 1.5px var(--axis); }
.cap .sc { height: 10px; margin: 0 2px 0 6px; }
.seg { display: inline-flex; align-items: center; margin: 10px 0 2px; font-size: 12px; } .seg-l { color: var(--ink-3); margin-right: 8px; }
.seg button { font: inherit; color: var(--ink-2); background: transparent; border: 1px solid var(--axis); padding: 3px 12px; cursor: pointer; }
.seg button:first-of-type { border-radius: 6px 0 0 6px; } .seg button:last-of-type { border-radius: 0 6px 6px 0; border-left: 0; }
.seg button[aria-pressed="true"] { background: var(--ink); color: var(--page); border-color: var(--ink); }
.seg button:focus-visible { outline: 2px solid var(--ink-2); outline-offset: 1px; }
.cv { position: relative; height: 190px; } .cv canvas { width: 100% !important; }

/* gate history grid: rows are gates, columns are runs */
.ghist { margin-top: 20px; }
.hwrap { overflow-x: auto; padding-bottom: 4px; }
.hgrid { width: auto; border-collapse: separate; border-spacing: 3px; font-size: 12px; margin: 0; }
.hgrid th, .hgrid td { border: 0; padding: 0; }
.hgrid tbody th { text-align: left; font-weight: 400; white-space: nowrap; padding-right: 10px; } .hgrid tbody th a { text-decoration: none; } .hgrid tbody th .rn { color: var(--ink-3); }
.hgrid thead th.run { height: 58px; vertical-align: bottom; border-top: 3px solid var(--ink-3); padding-top: 2px; }
.hgrid thead th.run[data-kind="main"] { border-top-color: var(--prod); } .hgrid thead th.run[data-kind="branch"] { border-top-color: var(--test); } .hgrid thead th.run[data-kind="local"] { border-top-style: dotted; }
.rsha { display: inline-block; writing-mode: vertical-rl; transform: rotate(180deg); font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ink-2); } .hgrid th.run a { text-decoration: none; }
.kindkey { display: inline-block; width: 14px; border-top: 3px solid var(--ink-3); margin: 0 4px 3px 8px; vertical-align: middle; } .kindkey[data-kind="main"] { border-top-color: var(--prod); } .kindkey[data-kind="branch"] { border-top-color: var(--test); } .kindkey[data-kind="local"] { border-top-style: dotted; }
.hc { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 4px; font-size: 12px; font-weight: 600; color: var(--ink-3); background: var(--hover); box-shadow: inset 0 0 0 1px var(--axis); }
.hc[data-status="pass"] { background: var(--good); color: #fff; box-shadow: none; } .hc[data-status="fail"] { background: var(--bad); color: #fff; box-shadow: none; }
.hc[data-status="none"], .hc[data-status="unknown"] { background: transparent; }
.hc:focus-visible { outline: 2px solid var(--ink-2); outline-offset: 1px; }
.meta .hc { width: 16px; height: 16px; font-size: 10px; margin: 0 2px 0 6px; vertical-align: middle; }
tr.own td { background: var(--hover); }

/* phone: tables become stacked rows, nothing scrolls sideways */
@media (max-width: 640px) {
	main { padding: 16px 16px 40px; }
	.detail { padding: 12px; }
	table:not(.hgrid), table:not(.hgrid) thead, table:not(.hgrid) tbody, table:not(.hgrid) tr, table:not(.hgrid) td { display: block; width: 100%; }
	table:not(.hgrid) thead { position: absolute; left: -9999px; }
	table:not(.hgrid) tr { padding: 6px 0; border-bottom: 1px solid var(--grid); } table:not(.hgrid) td { border: 0; padding: 1px 0; }
	table:not(.hgrid) td::before { content: attr(data-label) ": "; color: var(--ink-3); }
}
`;

const JS = `
(function () {
	var tip = document.getElementById("tip");
	function place(e) { tip.style.left = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8) + "px"; tip.style.top = (e.clientY + 14) + "px"; }
	document.addEventListener("pointerover", function (e) {
		var t = e.target.closest && e.target.closest("[data-tip]");
		if (!t) { tip.hidden = true; return; }
		tip.textContent = t.getAttribute("data-tip"); tip.hidden = false; place(e);
	});
	document.addEventListener("pointermove", function (e) { if (!tip.hidden) place(e); });
	document.addEventListener("pointerdown", function (e) { if (!(e.target.closest && e.target.closest("[data-tip]"))) tip.hidden = true; });
	document.addEventListener("focusin", function (e) {
		var t = e.target.closest && e.target.closest("[data-tip]");
		if (!t) { tip.hidden = true; return; }
		var r = t.getBoundingClientRect();
		tip.textContent = t.getAttribute("data-tip"); tip.hidden = false; place({ clientX: r.left, clientY: r.bottom });
	});
	document.addEventListener("focusout", function () { tip.hidden = true; });
})();
`;

export function renderPage(model) {
	const nowMs = Date.parse(model.now);
	const selected = ids(model).map((id) => `body:has(#${id}:target) #card-${id}, body:has(#${id}:target) #pill-${id} { box-shadow: 0 0 0 2px var(--ink-2); }`).join("\n") + "\nbody:has(#live:target) .livebar { box-shadow: 0 0 0 2px var(--ink-2); }";
	const s = model.gateSummary;
	const summary = [`${s.pass} pass`, s.fail ? `${s.fail} fail` : "", s.not_built ? `${s.not_built} not built` : "", s.skipped ? `${s.skipped} skipped` : "", s.unknown ? `${s.unknown} no result` : ""].filter(Boolean).join(" · ");
	const banners = [
		!model.inputs.kpi.found ? `KPI series not found${model.inputs.kpi.path ? ` at ${esc(model.inputs.kpi.path)}` : ""}: every KPI reads “not measured yet”.` : "",
		!model.inputs.gates.found ? `Gate results not found${model.inputs.gates.path ? ` at ${esc(model.inputs.gates.path)}` : ""}: every gate reads “no result”.` : "",
	].filter(Boolean).map((b) => `<p class="banner">${b}</p>`).join("");
	const g = model.inputs.gates;
	const registry = { specs: [] };
	const objectives = model.objectives.map((o) => objectiveDetail(o, nowMs, registry, model.competitors)).join("\n");
	const live = liveDetail(model.health, nowMs, registry);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Folder Sync Dev View</title>
<meta name="description" content="Progress on the folder-sync objectives and the status of its gates.">
<style>${CSS}${selected}</style>
</head>
<body>
<main>
	<div class="top"><h1>Folder Sync <span>dev view</span></h1>
		<p class="meta">Built ${esc(stamp(model.now))}${g.found ? ` · gates run ${esc(stamp(g.run_at))}${g.code_sha ? ` at <code>${esc(g.code_sha)}</code>` : ""}${g.branch ? ` on ${esc(g.branch)}` : ""}` : ""}${model.inputs.kpi.found ? ` · ${model.inputs.kpi.points} KPI points` : ""}</p></div>
	${banners}
	${liveBar(model.health, nowMs)}
	<section aria-label="Objectives" class="cards">${model.objectives.map((o) => cardHtml(o, nowMs, model.competitors)).join("")}</section>
	<section aria-label="Gates" class="gates">
		<div class="gates-head"><h2>Gates</h2><span class="meta">${esc(summary)}</span></div>
		<div class="pills">${model.gates.map(pillHtml).join("")}</div>
	</section>
	${gateHistory(model)}
	<p class="hint">Select an objective or a gate for the detail.</p>
	${live}
	${objectives}
	${model.gates.map((gate) => gateDetail(gate, model)).join("\n")}
	<details class="notes"><summary>Sources and data notes${model.warnings.length ? ` (${model.warnings.length})` : ""}</summary><ul>
		<li>KPI series: <code>${esc(model.inputs.kpi.path ?? "none")}</code> (${model.inputs.kpi.found ? `${model.inputs.kpi.lines} lines, ${model.inputs.kpi.points} points used` : "not found"})</li>
		<li>Gate results: <code>${esc(model.inputs.gates.path ?? "none")}</code> (${model.inputs.gates.found ? "read" : "not found"})</li>
		<li>Headline of an env = the worst latest value over its slices (for cost: the provider each folder is on, the dearer one when folders are on two, with the cheapest provider beside it); sparklines cover the last ${model.window_days} days. A value that meets its target has a green dot; within 2× the target is amber; beyond that red.</li>
		${model.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}
	</ul></details>
</main>
<div id="tip" hidden></div>
<script type="application/json" id="chart-data">${jsonForScript(registry.specs)}</script>
<script>${CHART_JS}</script>
<script>${CHARTS_JS.replace("/*FMT*/", `${sig.toString()}\n${fmt.toString()}`)}</script>
<script>${JS}</script>
</body>
</html>
`;
}
