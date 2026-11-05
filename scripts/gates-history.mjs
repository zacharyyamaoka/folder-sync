// scripts/gates-history: one line a run in gates-history.jsonl (folder-sync-gates-history/1), oldest first.
//
//   scripts/gates-history [--repo owner/name] [--branch B]... [--limit N] [--cache DIR] [--gates FILE] [--out FILE] [--no-fetch]
//   --repo     default: the origin remote of this checkout
//   --branch   CI branches to list (default claude/folder-sync-v0 and main); the `test` workflow's runs on each
//   --limit    runs per branch (default 30)
//   --cache    default ~/.cache/folder-sync/gates-history: <run id>/{meta.json,gates.json}, and local/<run_at>.json snapshots
//   --gates    the local gates.json to snapshot (default reports/status/gates.json in this checkout)
//   --out      default reports/status/gates-history.jsonl in this checkout (next to gates.json, where the dev view looks)
//   --no-fetch only the cache and the local file (no network, no gh)
//
// A CI run's column is the gates.json that run uploaded (artifact `gates-json`, 30 days of retention). A completed run is cached by
// its id and never asked for again; a run still going, or one that uploaded no gates file, is a column with `gates: null` (the grid
// draws it hollow: "no result"), never a guess. Every local `scripts/gates` result this script has seen is kept as a snapshot, so a
// local run is a column too. The gate ids G1..G12 and gates.json's shape (folder-sync-gates/1) are the frozen contract; nothing
// here changes them.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
export const HISTORY_SCHEMA = "folder-sync-gates-history/1";
export const GATE_IDS = Array.from({ length: 12 }, (_, i) => `G${i + 1}`);
const USAGE = `usage: scripts/gates-history [--repo owner/name] [--branch B]... [--limit N] [--cache DIR] [--gates FILE] [--out FILE] [--no-fetch]`;

/** One history line from a gates.json document. `meta` says where it came from. */
export function entryFromGates(doc, meta) {
	const gates = {};
	for (const g of Array.isArray(doc?.gates) ? doc.gates : []) {
		if (!g || !GATE_IDS.includes(g.id)) continue;
		const failing = (Array.isArray(g.tests) ? g.tests : []).filter((t) => t?.status === "fail").map((t) => String(t.name).slice(0, 200));
		gates[g.id] = { status: ["pass", "fail", "not_built", "skipped"].includes(g.status) ? g.status : "unknown", failing: failing.slice(0, 4), failing_total: failing.length, summary: String(g.summary ?? "").slice(0, 200) };
	}
	return {
		schema: HISTORY_SCHEMA, id: meta.id, source: meta.source, branch: doc?.branch ?? meta.branch ?? null, sha: doc?.code_sha ?? meta.sha ?? null,
		t: doc?.run_at ?? meta.t ?? null, url: meta.url ?? null, conclusion: meta.conclusion ?? null, profile: doc?.profile ?? null, gates, note: "",
	};
}

/** A CI run that has no gates file to read: a column with no result. */
export function emptyEntry(meta, note) {
	return { schema: HISTORY_SCHEMA, id: meta.id, source: meta.source, branch: meta.branch ?? null, sha: meta.sha ?? null, t: meta.t ?? null, url: meta.url ?? null, conclusion: meta.conclusion ?? null, profile: null, gates: null, note };
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

function defaultGh(args) {
	const done = spawnSync("gh", args, { encoding: "utf8", timeout: 120_000 });
	return { ok: done.status === 0, out: done.stdout ?? "", err: done.stderr ?? "" };
}

function download(repo, runId, dir, gh) {
	const tmp = mkdtempSync(join(tmpdir(), "gates-history-"));
	try {
		const got = gh(["run", "download", String(runId), "-R", repo, "-n", "gates-json", "-D", tmp]);
		const file = join(tmp, "gates.json");
		if (!got.ok || !existsSync(file)) return false;
		copyFileSync(file, join(dir, "gates.json"));
		return true;
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/** Lists the `test` workflow's runs on each branch and caches every completed run's gates.json by run id.
 *  @returns {warnings: string[]} (a branch gh cannot be asked about is a warning, not a failure) */
export function fetchRuns({ repo, branches, limit, cacheDir, gh = defaultGh }) {
	const warnings = [];
	for (const branch of branches) {
		const list = gh(["run", "list", "-R", repo, "--workflow", "test.yml", "--branch", branch, "--limit", String(limit), "--json", "databaseId,status,conclusion,headSha,headBranch,createdAt,url,event"]);
		if (!list.ok) {
			warnings.push(`gh run list (${branch}) failed: ${list.err.trim().split("\n")[0]}`);
			continue;
		}
		let runs = [];
		try { runs = JSON.parse(list.out); } catch { warnings.push(`gh run list (${branch}) printed no JSON`); }
		for (const run of runs) {
			if (run.event && run.event !== "push" && run.event !== "workflow_dispatch") continue;
			const dir = join(cacheDir, String(run.databaseId));
			const metaFile = join(dir, "meta.json");
			const meta = { id: `ci-${run.databaseId}`, run_id: run.databaseId, source: "ci", branch: run.headBranch, sha: run.headSha, t: run.createdAt, url: run.url, conclusion: run.conclusion || run.status, status: run.status };
			mkdirSync(dir, { recursive: true });
			if (readJson(metaFile)?.status === "completed") continue;
			// WHY a running run is asked again next time: the gates job uploads its file near the end of the run
			if (!download(repo, run.databaseId, dir, gh) && run.status === "completed") meta.no_artifact = true;
			writeFileSync(metaFile, JSON.stringify(meta));
		}
	}
	return { warnings };
}

/** Keeps a copy of this checkout's gates.json (once per run_at + sha) so a local run outlives the next local run. */
export function snapshotLocal({ gatesFile, cacheDir }) {
	const doc = readJson(gatesFile);
	if (!doc || !doc.run_at || !Array.isArray(doc.gates)) return null;
	const dir = join(cacheDir, "local");
	mkdirSync(dir, { recursive: true });
	const name = `${doc.run_at.replace(/[:.]/g, "-")}-${String(doc.code_sha ?? "unknown").slice(0, 9)}.json`;
	const file = join(dir, name);
	if (!existsSync(file)) copyFileSync(gatesFile, file);
	return file;
}

/** Every cached run and local snapshot as history lines, oldest first. */
export function buildHistory({ cacheDir }) {
	const entries = [];
	if (existsSync(cacheDir)) {
		for (const name of readdirSync(cacheDir)) {
			if (name === "local") continue;
			const meta = readJson(join(cacheDir, name, "meta.json"));
			if (!meta) continue;
			const doc = readJson(join(cacheDir, name, "gates.json"));
			if (doc && Array.isArray(doc.gates)) entries.push(entryFromGates(doc, meta));
			else entries.push(emptyEntry(meta, meta.status !== "completed" ? "still running, or its gates job has not uploaded the file yet" : "this run uploaded no gates file (its gates job failed or never started)"));
		}
	}
	const localDir = join(cacheDir, "local");
	if (existsSync(localDir)) {
		for (const name of readdirSync(localDir)) {
			const doc = readJson(join(localDir, name));
			if (doc && Array.isArray(doc.gates)) entries.push(entryFromGates(doc, { id: `local-${name.replace(/\.json$/, "")}`, source: "local" }));
		}
	}
	entries.sort((a, b) => (Date.parse(a.t) || 0) - (Date.parse(b.t) || 0) || a.id.localeCompare(b.id));
	return entries;
}

export function writeHistory(entries, out) {
	mkdirSync(dirname(out), { recursive: true });
	const tmp = `${out}.${process.pid}`;
	writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
	renameSync(tmp, out);
}

function repoFromRemote() {
	const done = spawnSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8" });
	const m = /github\.com[:/]([^/]+\/[^/.\s]+)/.exec(done.stdout ?? "");
	return m ? m[1] : "zacharyyamaoka/folder-sync";
}

export function parseArgs(argv) {
	const o = { repo: null, branches: [], limit: 30, cache: join(homedir(), ".cache", "folder-sync", "gates-history"), gates: join(root, "reports", "status", "gates.json"), out: join(root, "reports", "status", "gates-history.jsonl"), fetch: true };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const value = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
		if (a === "--help" || a === "-h") return { help: true };
		else if (a === "--repo") o.repo = value();
		else if (a === "--branch") o.branches.push(value());
		else if (a === "--limit") o.limit = Number(value());
		else if (a === "--cache") o.cache = resolve(value());
		else if (a === "--gates") o.gates = resolve(value());
		else if (a === "--out") o.out = resolve(value());
		else if (a === "--no-fetch") o.fetch = false;
		else throw new Error(`unknown option: ${a}`);
	}
	if (!o.branches.length) o.branches = ["claude/folder-sync-v0", "main"];
	if (!(o.limit >= 1)) throw new Error("--limit is a positive number");
	return o;
}

export async function main(argv, { gh } = {}) {
	let o;
	try { o = parseArgs(argv); } catch (error) { console.error(`${error.message}\n${USAGE}`); return 2; }
	if (o.help) { console.log(USAGE); return 0; }
	mkdirSync(o.cache, { recursive: true });
	const warnings = [];
	if (o.fetch) warnings.push(...fetchRuns({ repo: o.repo ?? repoFromRemote(), branches: o.branches, limit: o.limit, cacheDir: o.cache, gh }).warnings);
	snapshotLocal({ gatesFile: o.gates, cacheDir: o.cache });
	const entries = buildHistory({ cacheDir: o.cache });
	writeHistory(entries, o.out);
	for (const w of warnings) console.error(`gates-history: ${w}`);
	console.log(`gates-history: ${entries.length} runs (${entries.filter((e) => e.source === "ci").length} CI, ${entries.filter((e) => e.source === "local").length} local, ${entries.filter((e) => e.gates).length} with results) -> ${o.out}`);
	return 0;
}
