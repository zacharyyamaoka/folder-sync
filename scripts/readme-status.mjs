// scripts/readme-status: the "Objectives & Gates" block of README.md (and of the GitHub Pages landing page), generated from the
// same two sources as the dev view (the KPI series and gates.json, through status-model.mjs), never typed. The block sits between
// two marker comments; everything outside them is left alone.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModel, loadSources } from "./status-model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const BEGIN = "<!-- status:begin -->";
export const END = "<!-- status:end -->";
const REPO_URL = "https://github.com/zacharyyamaoka/folder-sync/blob/main/";
const USAGE = `usage: scripts/readme-status [--kpi <kpi_series.jsonl>] [--gates <gates.json>] [--readme <README.md>] [--landing <index.html>] [--check] [--now <ISO time>]
  --kpi      default ~/vt/zach/producers/folder-sync/kpi_series.jsonl
  --gates    default reports/status/gates.json in the main checkout (the gate runner's --publish target)
  --readme   the file whose ${BEGIN} ... ${END} block is rewritten (default: README.md in this checkout; the word none skips it)
  --landing  also rewrite the same block, as HTML, in this file (the gh-pages index.html)
  --check    write nothing; exit 1 if a file's block is out of date
  --now      the "present" for the 30-day window (default: the clock; tests pin it)
Exit 0 ok, 1 stale (--check), 2 bad arguments or a file without exactly one marker pair.`;

// WHY plain words per row: the README and the landing page are read by a stranger; the dev view's titles are for Zach.
// Each metric: what the number is, and the target as a sentence (the numbers are Zach's, PROJECT - Folder Sync, Nov 4 2026).
const METRIC_TEXT = {
	propagation_p50_ms: { what: "Save to the bytes on the other disk and online, median (p50)", target: "≤ 1 s" },
	propagation_p95_ms: { what: "The same, 95th percentile (p95)", target: "≤ 3 s" },
	storage_efficiency_h_30d_max: { what: "History bytes ÷ live bytes (H), worst of the last 30 days", target: "≤ 1.0 (stretch ≤ 0.25)" },
	storage_efficiency_h: { what: "H, latest sample", target: "none (the 30-day worst is the target)" },
	cost_per_gb_month_usd: { what: "Cost per GB-month, cheapest provider", target: "no number set; the cheapest provider" },
	cost_per_person_month_usd: { what: "Cost per person-month at 10 GB, cheapest provider", target: "≤ $0.50" },
	idle_cpu_pct: { what: "CPU when idle", target: "< 0.1 %" },
	idle_ops_per_hour: { what: "Storage requests an hour when idle", target: "none (idle cost should be about $0)" },
};

// Each gate in one plain line; the exact tests are in docs/GATES.md.
const GATE_WHAT = {
	G1: "Random edits, deletes, renames and crashes end with every file and every kept version intact.",
	G2: "Any version from the last 30 days restores byte for byte; deleted files restore for 30 days.",
	G3: "No account can read another account's files.",
	G4: "Linux, macOS and Windows all pass CI, and the desktop installers install on all three.",
	G5: "The command line, the desktop app and the web page each pass one full journey.",
	G6: "A fresh machine syncs from a script with no prompt and no browser.",
	G7: "The same journey passes on R2, another S3-compatible store and a plain folder.",
	G8: "An app adds sync, accounts and the sync view in 20 lines of code or fewer.",
	G9: "gitignore-style rules; OS junk ignored by default; accented names land exactly once.",
	G10: "Google and email-code sign-in; one deployment per app.",
	G11: "From a fresh machine to the first sync in 2 minutes or less.",
	G12: "A restore takes 5 seconds or less.",
};

const WORDS = { pass: "pass", fail: "FAIL", not_built: "not built yet", skipped: "left out of this run", unknown: "no result" };
const GATE_CLASS = { pass: "g-pass", fail: "g-fail", not_built: "g-notbuilt", skipped: "g-skipped", unknown: "g-unknown" };

export function formatValue(metric, value) {
	if (value === null || value === undefined || !Number.isFinite(value)) return "not measured yet";
	switch (metric.unit) {
		case "ms":
			if (value < 999.5) return `${Math.round(value)} ms`;
			return value < 9950 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value / 1000)} s`;
		case "ratio":
			return value < 9.995 ? value.toFixed(2) : String(Math.round(value));
		case "usd":
			return value < 0.1 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`;
		case "pct":
			return `${Number(value.toPrecision(2))} %`;
		case "ops":
			return String(Math.round(value));
		default:
			return String(value);
	}
}

const utc = (iso) => (iso ? `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC` : null);

function cellView(metric, cell) {
	if (cell.value === null) {
		return cell.lastRunFailed
			? { text: "could not be measured", verdict: "failed", lastRunFailed: true, at: null }
			: { text: "not measured yet", verdict: "", lastRunFailed: false, at: null };
	}
	const verdict = cell.status === "ok" ? "met" : cell.status === "amber" || cell.status === "red" ? "missed" : "";
	return { text: formatValue(metric, cell.value), verdict, lastRunFailed: cell.lastRunFailed, at: cell.t };
}

// A gate's summary ends with "Missing: <proofs>" when something is not built; the table keeps the part before it.
function gateDetail(g) {
	if (g.status === "unknown") return "";
	const cut = g.summary.split(/\.?\s*Missing:/)[0].trim().replace(/\.$/, "");
	return cut;
}

export function statusView(model) {
	const objectives = model.objectives.map((o) => ({
		id: o.id, name: o.name, blurb: o.blurb,
		rows: o.metrics.map((m) => ({
			kpi: m.kpi, what: METRIC_TEXT[m.kpi]?.what ?? m.title, target: METRIC_TEXT[m.kpi]?.target ?? "",
			test: cellView(m, m.env.test), prod: cellView(m, m.env.prod),
		})),
	}));
	const newest = (env) => objectives.flatMap((o) => o.rows).map((r) => r[env].at).filter(Boolean).sort().at(-1) ?? null;
	const gates = model.gates.map((g) => ({
		id: g.id, name: g.name, status: g.status, word: WORDS[g.status] ?? g.status, what: GATE_WHAT[g.id] ?? "",
		detail: gateDetail(g), missing: (g.summary.split(/Missing:/)[1] ?? "").trim(),
	}));
	const run = model.inputs.gates.found ? { at: model.inputs.gates.run_at ?? null, sha: (model.inputs.gates.code_sha ?? "").slice(0, 7), branch: model.inputs.gates.branch ?? null } : null;
	return {
		objectives, gates, gateCounts: model.gateSummary,
		measured: { test: newest("test"), prod: newest("prod") }, gateRun: run,
		gatesFound: model.inputs.gates.found,
	};
}

function gateHeadline(v) {
	if (!v.gatesFound) return "no gate results yet";
	const c = v.gateCounts;
	const parts = [`${c.pass} of 12 gates pass`];
	if (c.fail) parts.push(c.fail === 1 ? "1 fails" : `${c.fail} fail`);
	if (c.not_built) parts.push(`${c.not_built} ${c.not_built === 1 ? "is" : "are"} not built yet`);
	if (c.skipped) parts.push(`${c.skipped} ${c.skipped === 1 ? "was" : "were"} left out of this run`);
	if (c.unknown) parts.push(`${c.unknown} ${c.unknown === 1 ? "has" : "have"} no result`);
	return parts.join(", ");
}

function sourceLine(v) {
	const bits = [];
	if (v.measured.test || v.measured.prod) {
		bits.push(`Latest measurements: test ${utc(v.measured.test) ?? "none yet"}, production ${utc(v.measured.prod) ?? "none yet"}.`);
	} else bits.push("No measurements yet.");
	if (v.gateRun) bits.push(`Gates last run ${utc(v.gateRun.at) ?? "at an unknown time"}${v.gateRun.sha ? ` on \`${v.gateRun.sha}\`` : ""}.`);
	return bits.join(" ");
}

const cellMd = (c) => (c.verdict === "" ? c.text : c.verdict === "failed" ? c.text : `${c.text}, ${c.verdict}${c.lastRunFailed ? "; the latest run failed" : ""}`);

export function renderMarkdown(v) {
	const out = [];
	out.push(`_Generated by \`scripts/readme-status\` from the hourly measurements and the last gate run; do not edit between the markers. ${sourceLine(v)}_`);
	out.push("");
	out.push("**Objectives**: numbers we keep improving, measured in a test rig and in production.");
	out.push("");
	out.push("| Objective | What is measured | Target | Test | Production |");
	out.push("|---|---|---|---|---|");
	for (const o of v.objectives) {
		o.rows.forEach((r, i) => out.push(`| ${i === 0 ? `**${o.id} ${o.name}**` : ""} | ${r.what} | ${r.target} | ${cellMd(r.test)} | ${cellMd(r.prod)} |`));
	}
	out.push("");
	out.push(`**Gates**: pass or fail, checked on every change. ${gateHeadline(v)}.`);
	out.push("");
	out.push("| Gate | What it checks | Status |");
	out.push("|---|---|---|");
	for (const g of v.gates) {
		const word = g.status === "fail" ? `**${g.word}**` : g.word;
		const detail = g.detail && g.detail !== g.word ? ` (${g.detail})` : "";
		out.push(`| **${g.id}** ${g.name} | ${g.what} | ${word}${detail} |`);
	}
	const open = v.gates.filter((g) => g.status === "not_built");
	if (open.length) {
		out.push("");
		out.push(`Not built yet: ${open.map((g) => `${g.id} ${g.name}`).join(", ")}. Each waits on a proof that does not exist yet (see [docs/GATES.md](docs/GATES.md)); a gate never passes without its proof.`);
	}
	return out.join("\n");
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderHtml(v, { linkBase = REPO_URL } = {}) {
	const out = [];
	out.push('<div class="status">');
	out.push(`<p class="asof">${esc(sourceLine(v).replace(/`/g, ""))}</p>`);
	out.push('<div class="objectives">');
	for (const o of v.objectives) {
		out.push(`<article class="objective" data-objective="${esc(o.id)}">`);
		out.push(`<h3><span class="oid">${esc(o.id)}</span> ${esc(o.name)}</h3>`);
		out.push(`<p class="blurb">${esc(o.blurb)}</p>`);
		out.push('<table class="kpis"><thead><tr><th scope="col">Measure</th><th scope="col">Target</th><th scope="col">Test</th><th scope="col">Production</th></tr></thead><tbody>');
		for (const r of o.rows) {
			const cell = (c, env) => {
				const klass = c.verdict === "" ? "none" : c.verdict;
				const note = c.verdict === "met" || c.verdict === "missed" ? `<span class="verdict">${c.verdict}${c.lastRunFailed ? ", latest run failed" : ""}</span>` : "";
				return `<td class="cell ${klass}" data-env="${env}">${esc(c.text)}${note}</td>`;
			};
			out.push(`<tr><th scope="row">${esc(r.what)}</th><td class="target">${esc(r.target)}</td>${cell(r.test, "test")}${cell(r.prod, "prod")}</tr>`);
		}
		out.push("</tbody></table></article>");
	}
	out.push("</div>");
	out.push(`<p class="gate-line">${esc(gateHeadline(v))}.</p>`);
	out.push('<ul class="gates">');
	for (const g of v.gates) {
		const tip = [g.name, g.what, g.detail || g.word].filter(Boolean).join(". ");
		out.push(`<li class="gate ${GATE_CLASS[g.status] ?? "g-unknown"}" data-gate="${esc(g.id)}"><a href="${esc(linkBase)}docs/GATES.md#the-twelve" title="${esc(tip)}"><strong>${esc(g.id)}</strong><span class="gname">${esc(g.name)}</span><i>${esc(g.word)}</i></a></li>`);
	}
	out.push("</ul>");
	out.push("</div>");
	return out.join("\n");
}

export function replaceBlock(text, block) {
	const starts = text.split(BEGIN).length - 1;
	const ends = text.split(END).length - 1;
	if (starts === 0) throw new Error(`no ${BEGIN} marker`);
	if (ends === 0) throw new Error(`no ${END} marker`);
	if (starts > 1 || ends > 1) throw new Error(`${BEGIN} or ${END} appears more than once`);
	const from = text.indexOf(BEGIN);
	const to = text.indexOf(END);
	if (to < from) throw new Error(`${END} comes before ${BEGIN}`);
	return `${text.slice(0, from)}${BEGIN}\n${block}\n${text.slice(to)}`;
}

function parseArgs(argv) {
	const opts = {
		kpi: join(homedir(), "vt/zach/producers/folder-sync/kpi_series.jsonl"),
		gates: join(mainCheckout(), "reports/status/gates.json"),
		readme: resolve(here, "../README.md"),
		landing: undefined, check: false, now: undefined,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--help" || a === "-h") return { help: true };
		if (a === "--check") { opts.check = true; continue; }
		const name = a.startsWith("--") ? a.slice(2) : null;
		if (!name || !(name in opts) || name === "check" || i + 1 >= argv.length) throw new Error(`unknown or incomplete option: ${a}`);
		opts[name] = argv[++i];
	}
	return opts;
}

// WHY the main checkout: reports/status/ is gitignored and `scripts/gates --publish` writes it there, so a lane's worktree has none.
function mainCheckout() {
	const own = resolve(here, "..");
	const marker = `${join(".claude", "worktrees")}/`;
	const at = own.indexOf(marker);
	return at >= 0 ? own.slice(0, at - 1) : own;
}

export function main(argv) {
	let opts;
	try {
		opts = parseArgs(argv);
	} catch (err) {
		console.error(`${err.message}\n${USAGE}`);
		return 2;
	}
	if (opts.help) {
		console.log(USAGE);
		return 0;
	}
	const now = opts.now ? Date.parse(opts.now) : Date.now();
	if (!Number.isFinite(now)) {
		console.error(`--now is not a time: ${opts.now}\n${USAGE}`);
		return 2;
	}
	const view = statusView(buildModel(loadSources({ kpi: resolve(opts.kpi), gates: resolve(opts.gates) }), { now }));
	const targets = opts.readme === "none" ? [] : [[resolve(opts.readme), renderMarkdown(view)]];
	if (opts.landing) targets.push([resolve(opts.landing), renderHtml(view)]);
	let stale = false;
	for (const [path, block] of targets) {
		let before;
		let after;
		try {
			before = readFileSync(path, "utf8");
			after = replaceBlock(before, block);
		} catch (err) {
			console.error(`${path}: ${err.message}`);
			return 2;
		}
		if (after === before) {
			console.log(`${path}: up to date`);
		} else if (opts.check) {
			console.log(`${path}: out of date`);
			stale = true;
		} else {
			writeFileSync(path, after);
			console.log(`${path}: rewritten (${gateHeadline(view)})`);
		}
	}
	return stale ? 1 : 0;
}
