// scripts/status: the dev view generator. Reads the KPI series and the gate results, writes <out>/index.html (one
// self-contained page) and <out>/status.json (the same model, for CI and other readers).
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModel, loadSources } from "./status-model.mjs";
import { renderPage } from "./status-render.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const USAGE = `usage: scripts/status [--kpi <kpi_series.jsonl>] [--gates <gates.json>] [--out <dir>] [--now <ISO time>]
  --kpi    default ~/vt/zach/producers/folder-sync/kpi_series.jsonl
  --gates  default reports/status/gates.json (in this checkout)
  --out    default site/dev (in this checkout)
  --now    the "present" for the 30-day window (default: the clock; tests pin it)
A missing source is not an error: the page says "not measured yet".`;

export function parseArgs(argv) {
	const opts = {
		kpi: join(homedir(), "vt/zach/producers/folder-sync/kpi_series.jsonl"),
		gates: resolve(here, "../reports/status/gates.json"),
		out: resolve(here, "../site/dev"),
		now: undefined,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--help" || a === "-h") return { help: true };
		const name = a.startsWith("--") ? a.slice(2) : null;
		if (!name || !(name in opts) || i + 1 >= argv.length) throw new Error(`unknown or incomplete option: ${a}`);
		opts[name] = argv[++i];
	}
	return opts;
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
		console.error(`--now is not a time: ${opts.now}`);
		return 2;
	}
	const model = buildModel(loadSources({ kpi: opts.kpi, gates: opts.gates }), { now });
	const out = resolve(opts.out);
	mkdirSync(out, { recursive: true });
	writeFileSync(join(out, "index.html"), renderPage(model));
	writeFileSync(join(out, "status.json"), JSON.stringify(model, null, 2) + "\n");
	const s = model.gateSummary;
	console.log(`dev view: ${join(out, "index.html")}  (KPI ${model.inputs.kpi.found ? model.inputs.kpi.points + " points" : "missing"}, gates ${model.inputs.gates.found ? `${s.pass} pass ${s.fail} fail ${s.not_built} not built` : "missing"}, ${model.warnings.length} notes)`);
	return 0;
}
