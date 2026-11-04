// Which priced provider a folder's store URL is on (docs/STORAGE.md), so cost_per_gb_month_usd for a folder on s3:// is the
// S3 price and a folder on r2:// the R2 price. The same lookup as internal/store Spec.CostProvider in Go; the two tests
// (bench/cost/store.test.mjs and internal/store/spec_test.go TestProviders) hold the same table.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { costSummary, PROFILES } from "./model.mjs";

/** The id in prices.json ("r2" "s3" "gcs" "b2" "wasabi") a store URL is costed at, or null when none is priced
 *  (a MinIO server, a NAS, a directory). An empty URL is r2://, the config of a folder that names only a bucket. */
export function providerOfStore(url) {
	if (!url) return "r2";
	const scheme = /^([a-z0-9]+):\/\//.exec(url)?.[1];
	if (!["r2", "s3", "gs", "file"].includes(scheme)) throw new Error(`store ${JSON.stringify(url)}: the scheme must be r2://, s3://, gs:// or file://`);
	if (scheme === "r2") return "r2";
	if (scheme === "gs") return "gcs";
	if (scheme === "file") return null;
	const endpoint = new URL(url).searchParams.get("endpoint");
	if (!endpoint) return "s3";
	let host;
	try {
		host = new URL(endpoint).hostname.toLowerCase();
	} catch {
		return null;
	}
	const on = (suffix) => host === suffix || host.endsWith(`.${suffix}`);
	// WHY the host and not the scheme alone: s3:// also names Backblaze B2 and Wasabi, which cost very differently from AWS
	if (on("amazonaws.com")) return "s3";
	if (on("backblazeb2.com")) return "b2";
	if (on("wasabisys.com")) return "wasabi";
	if (on("r2.cloudflarestorage.com")) return "r2";
	if (on("googleapis.com")) return "gcs";
	return null;
}

/** The store as a label: the URL without its options (an endpoint can carry a host nobody wants in a KPI file). */
export function storeLabel(url) {
	return (url || "r2://").replace(/\?.*$/, "");
}

/** One line: what a person costs on this store's provider, at the reference profile. */
export function storeCostLine({ url, prices, counters, h = 1, profile = PROFILES.reference }) {
	const provider = providerOfStore(url);
	if (!provider) return `${storeLabel(url)}: no price in prices.json for this store (a server or a directory you run); add its provider to bench/cost/prices.json to cost it`;
	const c = costSummary({ provider, prices, counters, profile, h });
	const f = (x) => `$${x.toFixed(x < 0.1 ? 4 : 3)}`;
	return `${storeLabel(url)} is ${prices.providers[provider].name}: ${f(c.per_gb_usd)} per live GB-month, ${f(c.person_usd)} per person-month (${profile.live_gb} GB, H = ${h})${c.lower_bound ? ", a lower bound (its egress price is unknown)" : ""}`;
}

/** The store URL a folder's .folder-sync.toml names: its `store`, else r2:// of its `bucket` (the config of a folder that
 *  names only a bucket), else "" (which providerOfStore reads as r2://). Only the top-level keys count: a [viewer] table
 *  has keys of its own. A line-by-line read, not a TOML parser, because the repo's node tools take no dependency. */
export function storeOfConfig(text) {
	let store = "";
	let bucket = "";
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("[")) break;
		const m = /^(store|bucket)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(line);
		if (!m) continue;
		if (m[1] === "store") store = m[2] ?? m[3];
		else bucket = m[2] ?? m[3];
	}
	return store || (bucket ? `r2://${bucket}` : "");
}

/** The folders this machine syncs and the store each names: ~/.folder-sync/projects/<key>/project.json says where the
 *  folder is, its .folder-sync.toml says where its bytes live. A registration whose folder lost its config is skipped
 *  (the engine's own rule, internal/serve folders()). */
export function registeredStores(home = homedir()) {
	const projects = join(home, ".folder-sync", "projects");
	if (!existsSync(projects)) return [];
	const out = [];
	for (const key of readdirSync(projects).sort()) {
		try {
			const reg = JSON.parse(readFileSync(join(projects, key, "project.json"), "utf8"));
			const config = join(reg.folder, ".folder-sync.toml");
			if (!existsSync(config)) continue;
			out.push({ project: String(reg.project), folder: String(reg.project), path: reg.folder, store: storeOfConfig(readFileSync(config, "utf8")) });
		} catch { /* a registration that cannot be read is not a folder */ }
	}
	return out;
}

/** Which stores the cost points are for. WHY this order: FOLDER_SYNC_STORE is an explicit override (a one-off "what would
 *  this cost on s3://?"); otherwise every folder on this machine says for itself, so a folder moved to another provider moves
 *  its cost without anyone editing an environment; a machine with no folders is costed as r2://, the default. */
export function storesToCost({ env = process.env, home = homedir() } = {}) {
	if (env.FOLDER_SYNC_STORE) return [{ folder: null, store: env.FOLDER_SYNC_STORE }];
	const registered = registeredStores(home);
	return registered.length ? registered.map(({ folder, store }) => ({ folder, store })) : [{ folder: null, store: "" }];
}
