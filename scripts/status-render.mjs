// The dev view's page: the model (status-model.mjs) in, one self-contained HTML string out. No CDN, no external font, no
// framework: inline CSS, inline SVG charts and ~20 lines of script for the hover tooltip. Opening a card or a gate is a
// URL fragment (:target), so it works without script, survives a reload and the back button returns to the glance.
import { WINDOW_DAYS } from "./status-model.mjs";

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

// One small chart: the test and prod lines of one slice over the last 30 days. Marker >= 8 px, 2 px lines, hairline grid.
function chart(group, metric, nowMs) {
	const W = 320, H = 128, L = 44, R = 10, T = 10, B = 22, from = nowMs - WINDOW_DAYS * DAY_MS;
	const all = group.flatMap((s) => s.points.map((p) => ({ env: s.env, x: Date.parse(p.t), v: p.v })));
	if (!all.length) {
		return `<p class="empty">no points in the last ${WINDOW_DAYS} days${group.some((s) => s.latest !== null) ? ` (latest ${group.map((s) => `${esc(s.env)} ${esc(fmt(metric.unit, s.latest))}`).join(", ")})` : ""}</p>`;
	}
	const values = all.map((p) => p.v);
	if (metric.target !== undefined) values.push(metric.target);
	const [y0, y1] = yDomain(values);
	const sx = scale([from, nowMs], [L, W - R]);
	const sy = scale([y0, y1], [H - B, T]);
	const grid = [y0 + (y1 - y0) * 0.1, (y0 + y1) / 2, y1 - (y1 - y0) * 0.1];
	let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(metric.title)}, ${esc(group[0].label)}">`;
	for (const g of grid) svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${sy(g).toFixed(1)}" y2="${sy(g).toFixed(1)}"/><text class="ax" x="${L - 5}" y="${(sy(g) + 3).toFixed(1)}" text-anchor="end">${esc(fmt(metric.unit, g))}</text>`;
	svg += `<line class="base" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/><text class="ax" x="${L}" y="${H - 6}">${esc(shortDate(from))}</text><text class="ax" x="${W - R}" y="${H - 6}" text-anchor="end">${esc(shortDate(nowMs))}</text>`;
	if (metric.target !== undefined) svg += `<line class="target" x1="${L}" x2="${W - R}" y1="${sy(metric.target).toFixed(1)}" y2="${sy(metric.target).toFixed(1)}"/><text class="ax tgt" x="${W - R}" y="${(sy(metric.target) - 3).toFixed(1)}" text-anchor="end">target</text>`;
	for (const s of group) {
		const pts = s.points.map((p) => ({ x: Date.parse(p.t), v: p.v }));
		if (!pts.length) continue;
		const d = pts.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)} ${sy(p.v).toFixed(1)}`).join("");
		svg += `<g class="line env-${esc(s.env)}"><path d="${d}"/>`;
		const step = Math.max(1, Math.ceil(pts.length / 60));
		pts.forEach((p, i) => {
			const isLast = i === pts.length - 1;
			if (i % step && !isLast) return;
			const tip = `${s.env} · ${new Date(p.x).toISOString().slice(0, 16).replace("T", " ")} UTC · ${fmt(metric.unit, p.v)}`;
			svg += `<circle class="hit" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.v).toFixed(1)}" r="8" data-tip="${esc(tip)}"/><circle class="mk${isLast ? " last" : ""}" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.v).toFixed(1)}" r="4"/>`;
		});
		svg += `</g>`;
	}
	return svg + `</svg>`;
}

// --- at a glance ------------------------------------------------------------------------------------------------------

function cellHtml(metric, env, nowMs) {
	const c = metric.env[env];
	const attrs = `class="cell env-${env}" data-cell="${esc(metric.kpi)}:${env}" data-status="${c.status}"`;
	if (c.value === null) {
		return `<div ${attrs}><span class="val none">${c.lastRunFailed ? `<span class="dot" data-status="red"></span>last run failed` : "not measured yet"}</span></div>`;
	}
	const bits = [];
	if (metric.target !== undefined) bits.push(`${STATUS_WORD[c.status]} ${esc(targetText(metric))}`);
	else if (metric.note) bits.push(esc(metric.note));
	bits.push(c.stale ? `last measured ${esc(ago(c.t, nowMs))}` : esc(ago(c.t, nowMs)));
	return `<div ${attrs}>
		<span class="val"><span class="dot" data-status="${c.status}"></span>${esc(fmt(metric.unit, c.value))}</span>
		${spark(c, nowMs)}
		<span class="cap">${bits.join(" · ")}</span>
		${c.lastRunFailed ? `<span class="cap bad">✗ last run failed</span>` : ""}
	</div>`;
}

function cardHtml(o, nowMs) {
	const rows = o.metrics.filter((m) => m.primary).map((m) => `
		<div class="row"><span class="rl">${esc(m.label)}${m.target !== undefined ? ` <small>${esc(targetText(m))}</small>` : ""}</span>
			${ENVS.map((e) => cellHtml(m, e, nowMs)).join("")}</div>`).join("");
	return `<a class="card" id="card-${o.id.toLowerCase()}" href="#${o.id.toLowerCase()}" data-status="${o.status}">
		<span class="card-head"><span class="dot" data-status="${o.status}"></span><h2>${esc(o.id)} · ${esc(o.name)}</h2><span class="more">details ›</span></span>
		<span class="blurb">${esc(o.blurb)}</span>
		<span class="envs"><span></span><span class="envtag env-test">test</span><span class="envtag env-prod">prod</span></span>
		${rows}
	</a>`;
}

const GLYPH = { pass: "✓", fail: "✗", not_built: "○", skipped: "–", unknown: "?" };
const GATE_WORD = { pass: "pass", fail: "fail", not_built: "not built", skipped: "skipped", unknown: "no result" };

function pillHtml(g) {
	return `<a class="gate-pill" id="pill-${g.id.toLowerCase()}" href="#${g.id.toLowerCase()}" data-status="${g.status}"><b>${esc(g.id)}</b><span class="gname">${esc(g.name)}</span><span class="gst">${GLYPH[g.status]} ${GATE_WORD[g.status]}</span></a>`;
}

// --- drill down -------------------------------------------------------------------------------------------------------

function metricDetail(m, nowMs) {
	const headline = ENVS.map((e) => {
		const c = m.env[e];
		return `<span class="hl env-${e}"><span class="envtag env-${e}">${e}</span> <span class="dot" data-status="${c.status}"></span><b>${esc(fmt(m.unit, c.value))}</b></span>`;
	}).join("");
	const groups = new Map();
	for (const s of m.series) {
		if (!groups.has(s.label)) groups.set(s.label, []);
		groups.get(s.label).push(s);
	}
	const charts = [...groups.values()].map((g) => `<figure class="chart"><figcaption>${esc(g[0].label)}</figcaption>${chart(g, m, nowMs)}</figure>`).join("");
	const rows = m.series.map((s) => `<tr>
		<td data-label="Slice">${esc(s.label)}</td>
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

function objectiveDetail(o, nowMs) {
	return `<section class="detail" id="${o.id.toLowerCase()}">
		<header><h2><span class="dot" data-status="${o.status}"></span>${esc(o.id)} · ${esc(o.name)}</h2><a class="close" href="#">Close ×</a></header>
		<p class="sub">${esc(o.blurb)}. <span class="legend"><span class="envtag env-test">test</span> <span class="envtag env-prod">prod</span> lines are the last ${WINDOW_DAYS} days; the dashed line is the target.</span></p>
		${o.metrics.map((m) => metricDetail(m, nowMs)).join("")}
	</section>`;
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

// --- page -------------------------------------------------------------------------------------------------------------

const ids = (model) => [...model.objectives.map((o) => o.id.toLowerCase()), ...model.gates.map((g) => g.id.toLowerCase())];

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
.chart svg { width: 100%; height: auto; display: block; overflow: visible; }
.chart .grid { stroke: var(--grid); stroke-width: 1; } .chart .base { stroke: var(--axis); stroke-width: 1; }
.chart .target { stroke: var(--ink-3); stroke-width: 1; stroke-dasharray: 4 3; }
.chart .ax { fill: var(--ink-3); font-size: 9px; } .chart .ax.tgt { fill: var(--ink-3); }
.chart .line path { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.chart .env-test path { stroke: var(--test); } .chart .env-prod path { stroke: var(--prod); }
.chart .mk { stroke: var(--surface); stroke-width: 2; opacity: 0; pointer-events: none; }
.chart .env-test .mk { fill: var(--test); } .chart .env-prod .mk { fill: var(--prod); }
.chart .mk.last, .chart .hit:hover + .mk { opacity: 1; }
.chart .hit { fill: transparent; pointer-events: all; }
.empty { color: var(--ink-3); font-size: 12px; margin: 6px 0; }
table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 4px; }
th { text-align: left; font-weight: 500; color: var(--ink-3); padding: 4px 8px 4px 0; border-bottom: 1px solid var(--grid); }
td { padding: 6px 8px 6px 0; border-bottom: 1px solid var(--grid); vertical-align: top; overflow-wrap: anywhere; }
td small { color: var(--ink-3); }
.tst[data-status="pass"] { color: var(--good-ink); } .tst[data-status="fail"] { color: var(--bad-ink); } .tst[data-status="skip"] { color: var(--ink-3); }
.evidence { padding-left: 18px; font-size: 12px; } .evidence li { margin: 2px 0; overflow-wrap: anywhere; }
.notes { margin-top: 28px; font-size: 12px; color: var(--ink-2); } .notes summary { cursor: pointer; color: var(--ink-3); } .notes ul { padding-left: 18px; margin-top: 6px; } .notes li { overflow-wrap: anywhere; }
#tip { position: fixed; z-index: 10; pointer-events: none; padding: 4px 8px; border-radius: 6px; background: var(--ink); color: var(--page); font-size: 12px; white-space: nowrap; }
#tip[hidden] { display: none; }

/* phone: tables become stacked rows, nothing scrolls sideways */
@media (max-width: 640px) {
	main { padding: 16px 16px 40px; }
	.detail { padding: 12px; }
	table, thead, tbody, tr, td { display: block; width: 100%; }
	thead { position: absolute; left: -9999px; }
	tr { padding: 6px 0; border-bottom: 1px solid var(--grid); } td { border: 0; padding: 1px 0; }
	td::before { content: attr(data-label) ": "; color: var(--ink-3); }
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
})();
`;

export function renderPage(model) {
	const nowMs = Date.parse(model.now);
	const selected = ids(model).map((id) => `body:has(#${id}:target) #card-${id}, body:has(#${id}:target) #pill-${id} { box-shadow: 0 0 0 2px var(--ink-2); }`).join("\n");
	const s = model.gateSummary;
	const summary = [`${s.pass} pass`, s.fail ? `${s.fail} fail` : "", s.not_built ? `${s.not_built} not built` : "", s.skipped ? `${s.skipped} skipped` : "", s.unknown ? `${s.unknown} no result` : ""].filter(Boolean).join(" · ");
	const banners = [
		!model.inputs.kpi.found ? `KPI series not found${model.inputs.kpi.path ? ` at ${esc(model.inputs.kpi.path)}` : ""}: every KPI reads “not measured yet”.` : "",
		!model.inputs.gates.found ? `Gate results not found${model.inputs.gates.path ? ` at ${esc(model.inputs.gates.path)}` : ""}: every gate reads “no result”.` : "",
	].filter(Boolean).map((b) => `<p class="banner">${b}</p>`).join("");
	const g = model.inputs.gates;
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
	<section aria-label="Objectives" class="cards">${model.objectives.map((o) => cardHtml(o, nowMs)).join("")}</section>
	<section aria-label="Gates" class="gates">
		<div class="gates-head"><h2>Gates</h2><span class="meta">${esc(summary)}</span></div>
		<div class="pills">${model.gates.map(pillHtml).join("")}</div>
	</section>
	<p class="hint">Select an objective or a gate for the detail.</p>
	${model.objectives.map((o) => objectiveDetail(o, nowMs)).join("\n")}
	${model.gates.map((gate) => gateDetail(gate, model)).join("\n")}
	<details class="notes"><summary>Sources and data notes${model.warnings.length ? ` (${model.warnings.length})` : ""}</summary><ul>
		<li>KPI series: <code>${esc(model.inputs.kpi.path ?? "none")}</code> (${model.inputs.kpi.found ? `${model.inputs.kpi.lines} lines, ${model.inputs.kpi.points} points used` : "not found"})</li>
		<li>Gate results: <code>${esc(model.inputs.gates.path ?? "none")}</code> (${model.inputs.gates.found ? "read" : "not found"})</li>
		<li>Headline of an env = the worst latest value over its slices (cheapest for cost); sparklines cover the last ${model.window_days} days. A value that meets its target has a green dot; within 2× the target is amber; beyond that red.</li>
		${model.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}
	</ul></details>
</main>
<div id="tip" hidden></div>
<script>${JS}</script>
</body>
</html>
`;
}
