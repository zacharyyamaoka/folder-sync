// Which priced provider a folder's store URL is on (docs/STORAGE.md), so cost_per_gb_month_usd for a folder on s3:// is the
// S3 price and a folder on r2:// the R2 price. The same lookup as internal/store Spec.CostProvider in Go; the two tests
// (bench/cost/store.test.mjs and internal/store/spec_test.go TestProviders) hold the same table.
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
