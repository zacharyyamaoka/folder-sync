// A folder's store URL names the provider its bytes are costed at (docs/STORAGE.md). The table here is the same one
// internal/store/spec_test.go TestProviders checks in Go (Spec.CostProvider): the two lookups must agree.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { costPoints, loadPrices } from "./cost.mjs";
import { providerOfStore, registeredStores, storeCostLine, storeOfConfig, storesToCost } from "./store.mjs";

const TABLE = [
	["r2://folder-sync", "r2"],
	["r2://folder-sync/team", "r2"],
	["s3://x-bucket", "s3"],
	["s3://x-bucket/a/b?region=eu-west-1", "s3"],
	["s3://x-bucket?endpoint=https://s3.eu-west-1.amazonaws.com", "s3"],
	["s3://x-bucket?endpoint=https://s3.us-west-004.backblazeb2.com&region=us-west-004", "b2"],
	["s3://x-bucket?endpoint=https://s3.wasabisys.com", "wasabi"],
	["s3://x-bucket?endpoint=https://s3.eu-central-1.wasabisys.com", "wasabi"],
	["s3://x-bucket?endpoint=https://acct.r2.cloudflarestorage.com", "r2"],
	["s3://x-bucket?endpoint=http://127.0.0.1:9000", null],
	["s3://x-bucket?endpoint=http://127.0.0.1:9000&provider=Minio", null],
	["gs://x-bucket", "gcs"],
	["gs://x-bucket/vault", "gcs"],
	["file:///srv/nas/hub", null],
	["", "r2"], // no store in the config means r2://bucket
];

test("the provider a store URL is costed at", () => {
	for (const [url, want] of TABLE) assert.equal(providerOfStore(url), want, url);
});

test("every priced provider the lookup can answer has a price", () => {
	const prices = loadPrices();
	for (const [, provider] of TABLE) if (provider) assert.ok(prices.providers[provider], provider);
});

test("an unknown scheme is an error, not a guess", () => {
	assert.throws(() => providerOfStore("ftp://host/x"), /scheme/);
});

const counters = {
	measured_at: "2026-11-04T00:00:00Z",
	idle: { class_a_per_hour_per_machine: 39, class_b_per_hour_per_machine: 72, worker_per_hour_per_machine: 12, do_per_hour_per_machine: 0 },
	change: { class_a_writer: 2.91, class_b_writer: 9.83, class_b_per_reader: 4.5, worker: 3.06, do: 1 },
};
const usage = { live: { bytes: 10e9 } };

// cost_per_gb_month_usd for a folder on s3:// is the S3 price, and only that provider's point says so
test("cost points mark the provider the folder's store is on", () => {
	const at = new Date("2026-11-04T12:00:00Z");
	for (const [store, provider] of [["s3://x-bucket", "s3"], ["r2://x-bucket", "r2"], ["gs://x-bucket", "gcs"]]) {
		const points = costPoints({ counters, series: [], usage, at, code: "test", store });
		const gb = points.filter((p) => p.kpi === "cost_per_gb_month_usd" && p.slice.env === "prod");
		const marked = gb.filter((p) => p.labels.is_store_provider === true).map((p) => p.slice.provider);
		assert.deepEqual(marked, [provider], store);
		assert.ok(gb.find((p) => p.slice.provider === provider).value > 0);
		for (const p of gb) assert.equal(p.labels.store, store.replace(/\?.*/, ""), "the label carries the store without its options");
	}
});

test("a store nobody prices (MinIO, a NAS, a directory) marks no provider and says why", () => {
	const points = costPoints({ counters, series: [], usage, at: new Date("2026-11-04T12:00:00Z"), code: "test", store: "file:///srv/nas/hub" });
	const gb = points.filter((p) => p.kpi === "cost_per_gb_month_usd");
	assert.ok(gb.length > 0);
	assert.ok(gb.every((p) => p.labels.is_store_provider === false && p.labels.store_unpriced === true));
});

test("the one-line costing of a store", () => {
	const prices = loadPrices();
	const line = storeCostLine({ url: "s3://x-bucket", prices, counters, h: 1 });
	assert.match(line, /AWS S3 Standard/);
	assert.match(line, /\$0\.\d+ per live GB-month/);
	assert.match(storeCostLine({ url: "file:///srv/hub", prices, counters, h: 1 }), /no price/);
});

// ---- each folder's own store URL, read from its .folder-sync.toml --------------------------------------------------------



test("a .folder-sync.toml's store: the store key, else r2:// of its bucket, else nothing; only the top-level keys count", () => {
	assert.equal(storeOfConfig('project = "a"\nstore = "s3://b/team?region=eu-west-1"\ninterval = "10s"\n'), "s3://b/team?region=eu-west-1");
	assert.equal(storeOfConfig("project = 'a'\nstore = 'gs://notes'   # the google one\n"), "gs://notes");
	assert.equal(storeOfConfig('project = "a"\nbucket = "folder-sync"\n'), "r2://folder-sync");
	assert.equal(storeOfConfig('project = "a"\n'), "");
	// a [viewer] table's own keys are not the folder's
	assert.equal(storeOfConfig('project = "a"\nbucket = "folder-sync"\n\n[viewer]\nstore = "s3://nope"\n'), "r2://folder-sync");
	assert.equal(storeOfConfig('# store = "s3://commented"\nproject = "a"\n'), "");
});

/** A fake home with registered folders: projects/<key>/project.json pointing at folders that hold a .folder-sync.toml (text) or none (null). */
function homeWith(folders) {
	const home = mkdtempSync(join(tmpdir(), "cost-home-"));
	for (const [project, toml] of Object.entries(folders)) {
		const folder = join(home, "synced", project);
		mkdirSync(folder, { recursive: true });
		if (toml !== null) writeFileSync(join(folder, ".folder-sync.toml"), toml);
		const state = join(home, ".folder-sync", "projects", `${project}-1234abcd`);
		mkdirSync(state, { recursive: true });
		writeFileSync(join(state, "project.json"), JSON.stringify({ schema: "folder-sync-project/1", project, bucket: "folder-sync", folder }));
	}
	return home;
}

test("registered folders: each one's own store, in project order; a folder that lost its config is skipped", () => {
	const home = homeWith({
		notes: 'project = "notes"\nbucket = "folder-sync"\n',
		photos: 'project = "photos"\nstore = "s3://pics?endpoint=https://s3.us-west-004.backblazeb2.com"\n',
		gone: null,
	});
	assert.deepEqual(registeredStores(home).map(({ project, store }) => [project, store]), [
		["notes", "r2://folder-sync"],
		["photos", "s3://pics?endpoint=https://s3.us-west-004.backblazeb2.com"],
	]);
	assert.deepEqual(registeredStores(join(home, "nowhere")), []);
});

test("which stores the cost points are for: FOLDER_SYNC_STORE if set, else every registered folder, else r2://", () => {
	const home = homeWith({ notes: 'project = "notes"\nstore = "gs://notes"\n' });
	assert.deepEqual(storesToCost({ env: { FOLDER_SYNC_STORE: "s3://x" }, home }).map((s) => s.store), ["s3://x"]);
	assert.deepEqual(storesToCost({ env: {}, home }).map((s) => [s.folder, s.store]), [["notes", "gs://notes"]]);
	assert.deepEqual(storesToCost({ env: {}, home: join(home, "nowhere") }).map((s) => s.store), [""]);
});

test("cost points follow every folder's own store: each provider that holds a folder is marked, with the folders on it", () => {
	const stores = [
		{ folder: "notes", store: "r2://folder-sync" },
		{ folder: "photos", store: "s3://pics?endpoint=https://s3.us-west-004.backblazeb2.com" },
		{ folder: "docs", store: "r2://folder-sync" },
		{ folder: "nas", store: "file:///srv/nas/hub" },
	];
	const points = costPoints({ counters, series: [], usage, at: new Date("2026-11-04T12:00:00Z"), code: "test", stores });
	const gb = points.filter((p) => p.kpi === "cost_per_gb_month_usd" && p.slice.env === "prod");
	assert.deepEqual(gb.filter((p) => p.labels.is_store_provider).map((p) => p.slice.provider).sort(), ["b2", "r2"]);
	assert.deepEqual(gb.find((p) => p.slice.provider === "r2").labels.folders, ["docs", "notes"]);
	assert.deepEqual(gb.find((p) => p.slice.provider === "b2").labels.folders, ["photos"]);
	assert.equal(gb.find((p) => p.slice.provider === "s3").labels.is_store_provider, false);
	assert.ok(gb.every((p) => p.labels.store_unpriced === true), "the NAS folder has no price, and every point says so");
	for (const p of gb) assert.equal(p.labels.store, "r2://folder-sync, s3://pics, file:///srv/nas/hub", "the stores without their options, each once");
});
