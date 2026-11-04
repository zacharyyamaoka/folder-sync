// The Vibe Tracks KPI catalog for folder-sync: Zach's three objectives (2026-11-04: fast, storage efficient, cheap)
// and the four legacy latency entries, which stay as they were. One function, so bench/latency/bench.mjs and
// bench/kpi/run-all.mjs write the same file.

const HOURLY = 3600;
const BASE = { computed_from: "runs", scale: "linear", cadence_s: HOURLY, aggregate: null };
const ENV = { lines_by: "env", line_values: ["test", "prod"] };

function legacy() {
	const common = { unit: "ms", direction: "lower", facets: ["stack", "code_sha"], aggregate: null, computed_from: "runs", scale: "linear", cadence_s: 3600, lines_by: "stack", line_values: ["local", "prod"] };
	const how = "folder-sync bench/latency/bench.mjs: 10 trials per run, each at a random phase of `sync --watch`'s interval. The headline is the local stack (rclone serve s3 + the R2 stand-in + wrangler dev on loopback), hourly; the prod line is this machine's signed-in session against the deployed Worker and R2, run by hand.";
	return [
		{ id: "sync_up_ms", title: "Disk to online (p50)", level: 0, parent: null, ...common, description: `A file saved into a synced folder, until GET /fs/v1/folders/<project>/files/<host>/<path> serves its bytes: what anyone reading it online waits. ${how}`, formula: "p50 over the run's trials of (first 200 with the same bytes, polled every 50 ms) - (the write)" },
		{ id: "sync_down_ms", title: "Online to disk (p50)", level: 0, parent: null, ...common, description: `A file saved online through the web host (PUT /fs/v1/folders/<project>/web/<path>, the call a page makes), until it is on the machine's disk at <folder>/hosts/<web host>/<path>. ${how}`, formula: "p50 over the run's trials of (file on disk with the same bytes, polled every 10 ms) - (the PUT sent)" },
		{ id: "sync_up_ms_p95", title: "Disk to online (p95)", level: 1, parent: "sync_up_ms", ...common, description: "The slow tail of sync_up_ms: the 95th percentile of the same trials.", formula: "p95 (linear between ranks) over the run's trials" },
		{ id: "sync_down_ms_p95", title: "Online to disk (p95)", level: 1, parent: "sync_down_ms", ...common, description: "The slow tail of sync_down_ms: the 95th percentile of the same trials.", formula: "p95 (linear between ranks) over the run's trials" },
	];
}

function objectives() {
	return [
		{
			id: "propagation_p50_ms", title: "Propagation (p50)", level: 0, parent: null, unit: "ms", direction: "lower", facets: ["env", "direction", "op", "tool", "code_sha"], ...BASE, ...ENV,
			description: "O1 Fast. Save to bytes on the other disk and online: machine->machine, machine->web, web->machine, for add / edit / delete / rename and `mixed` (all four pooled). Target p50 <= 1 s. env=test is the local stack (rclone serve s3 + the R2 stand-in + wrangler dev) and env=prod is the deployed Worker and R2 through this machine's signed-in session (project bench-latency); slice.tool names an off-the-shelf tool's number from bench/fast (PEP 0008) for the same direction. See docs/KPI.md.",
			formula: "p50 over the run's trials of (the other side holds the same bytes, or no longer holds the deleted / renamed path) - (the write, PUT or DELETE issued)",
		},
		{ id: "propagation_p95_ms", title: "Propagation (p95)", level: 1, parent: "propagation_p50_ms", unit: "ms", direction: "lower", facets: ["env", "direction", "op", "tool", "code_sha"], ...BASE, ...ENV, description: "O1 Fast, the slow tail. Target p95 <= 3 s.", formula: "p95 (linear between ranks) over the run's trials" },
		{
			id: "storage_efficiency_h", title: "History ratio H", level: 0, parent: null, unit: "ratio", direction: "lower", facets: ["env", "workload"], ...BASE, ...ENV,
			description: "O2 Storage efficient. History bytes divided by live bytes (what GET /fs/v1/usage reports as `history` and `live`: _history/, _changes/, _requests/, _trash/ over everything else). env=prod is the signed-in account, hourly; env=test is a deterministic workload run against the local stack (bench/kpi/storage-test.mjs).",
			formula: "usage.history.bytes / usage.live.bytes",
		},
		{ id: "storage_efficiency_h_30d_max", title: "History ratio H (30-day max)", level: 1, parent: "storage_efficiency_h", unit: "ratio", direction: "lower", facets: ["env", "workload"], ...BASE, ...ENV, description: "O2 gate value: the largest H sample in the last 30 days. Target <= 1.0, stretch <= 0.25.", formula: "max of storage_efficiency_h over the trailing 30 days, same slice" },
		{
			id: "cost_per_gb_month_usd", title: "Cost per GB-month", level: 0, parent: null, unit: "USD/GB-month", direction: "lower", facets: ["provider", "profile"], ...BASE, lines_by: "provider", line_values: ["r2", "s3", "gcs", "b2", "wasabi"],
			description: "O3 Storage cost. Monthly provider bill (storage on live x (1+H), class A/B requests, egress) for the reference profile (10 GB, 3 machines, 1000 changes a day), per live GB. List prices in bench/cost/prices.json (docs/PRICES.md); request counts measured by bench/kpi/ops.mjs; H from storage_efficiency_h. `labels.lower_bound` is true where a provider's egress price is not known.",
			formula: "(storage + operations + egress) at list price / live GB",
		},
		{
			id: "cost_per_person_month_usd", title: "Cost per person-month", level: 0, parent: null, unit: "USD/person-month", direction: "lower", facets: ["provider", "profile"], ...BASE, lines_by: "provider", line_values: ["r2", "s3", "gcs", "b2", "wasabi"],
			description: "O3. The provider bill above plus the Workers / Durable Object request overage, per person, for the profiles `reference` and `average` (from Zach's real account). Excludes the $5 Workers Paid fee, which is one deployment's, not a person's (labels.platform_base_usd). Target <= $0.50 at 10 GB.",
			formula: "provider bill + Worker and Durable Object requests at list overage",
		},
		{ id: "idle_cpu_pct", title: "Idle CPU", level: 1, parent: null, unit: "% of one core", direction: "lower", facets: ["env"], ...BASE, ...ENV, description: "O3 idle. `sync --watch` on a synced, untouched folder for 10 minutes (env=test, the local stack), or the real daemons observed for 60 s (env=prod). Target < 0.1 %.", formula: "(utime + stime of the watcher and every child it reaped) / wall time" },
		{ id: "idle_ops_per_hour", title: "Idle requests per hour", level: 1, parent: null, unit: "requests/hour", direction: "lower", facets: ["env", "kind"], ...BASE, ...ENV, description: "O3 idle. Storage and Worker requests per hour one idle machine costs (class A, class B and Worker requests summed; the split is in labels). Measured on the local stack: its R2 stand-in's log and wrangler's request log.", formula: "(class A + class B + Worker requests during the idle window) / window hours" },
	];
}

// Health checks (docs/KPI.md "Is it syncing?"): not objectives, no target; the stall check runs every 5 minutes.
function health() {
	const base = { level: 1, parent: null, direction: "lower", facets: ["env"], computed_from: "runs", scale: "linear", cadence_s: 300, aggregate: null, lines_by: "env", line_values: ["test", "prod"] };
	return [
		{
			id: "sync_canary_ms", title: "Sync canary", unit: "ms", ...base,
			description: "Health check, not an objective. Every 5 minutes bench/kpi/canary.mjs saves a small file in a dedicated canary folder synced by this machine's installed engine and times it until the Worker serves its bytes. labels.result is ok, stalled (not online after 10 minutes, or a cause found sooner: held lock, quota, signed out) or offline (no route to the server: not measured, never red). A stalled or offline run is a `failed` point with the reason.",
			formula: "first read of GET /fs/v1/folders/<canary>/files/<host>/canary.txt with the same bytes - the write",
		},
		{
			id: "sync_stalled_folders", title: "Stalled folders", unit: "folders", ...base,
			description: "Health check, not an objective. Of this machine's synced folders (folder-sync status --json), how many have not completed a round for more than 10 minutes while online (labels.stalled names each with its cause: held lock and holder, quota, signed out, failing rounds, no engine running). Offline: not measured.",
			formula: "count of folders whose last clean round is older than max(10 minutes, 3 x the folder's interval)",
		},
	];
}

export function catalog(generatedAt) {
	return {
		schema: "vt-kpi-catalog/1",
		generated_at: generatedAt,
		unit_of_iteration: "run",
		title: "folder-sync: fast, storage efficient, cheap",
		producer: { name: "folder-sync bench/kpi/run-all.mjs", bench_version: "folder-sync-kpi/1", repo: "/home/bam/folder-sync", doc: "docs/KPI.md" },
		cadence_s: HOURLY,
		kpis: [...legacy(), ...objectives(), ...health()],
	};
}
