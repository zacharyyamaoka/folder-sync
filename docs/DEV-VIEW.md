# The dev view

One page that answers "where are we": the three objectives (O1 Fast, O2 Storage efficient, O3 Cost per GB) with their current value against target, test and prod side by side, and the twelve gates (G1 to G12) as pass / fail / not built. Click an objective for its series by slice (direction, op, provider, env) as small charts and a table; click a gate for its tests (status, duration, detail) and evidence. Zach, 2026-11-04: "a simple dev view that allows me to see the progress on the KPIs, and the current status of the different tests."

```bash
/home/bam/folder-sync/scripts/dev-view
```

That regenerates the page from the real KPI series and gate results and serves it at `http://127.0.0.1:8137/` (`PORT=` to change it). Open one with `#o1` or `#g2` on the end of the URL.

## History

- **KPI lines**: opening an objective draws one Chart.js chart per slice (test blue, prod orange, the target a dashed line) over **every** measured point, not only the last 30 days; hovering a point shows its value, its commit (`source.code_sha`) and its time. The "x axis" toggle swaps time for **commits**: one slot per commit in the order it was first measured, ticks are short shas (the choice is remembered). Chart.js 4.4.7 is vendored and inlined (`scripts/dev-view-vendor/`, drawn by `scripts/dev-view-charts.js`), so the page is still one file with no CDN. The at-a-glance sparklines stay small SVG.
- **Gate history**: a grid under the gate pills, rows G1 to G12, columns the last 40 runs (oldest on the left): CI on `claude/folder-sync-v0` (blue edge) and `main` (orange) and local `scripts/gates` runs (dotted edge); green pass, red fail, grey not built or skipped, hollow when a run has no gates result. Hover or focus a cell for the commit, date and the failing test; a column header links to its CI run. It reads `reports/status/gates-history.jsonl` (`--history`), which **`scripts/gates-history`** builds: `gh run list` for the `test` workflow on each branch, `gh run download -n gates-json` per completed run (cached by run id under `~/.cache/folder-sync/gates-history/`, a running run is asked again), plus a snapshot of the local `gates.json` (so a local run outlives the next one). Lines are `folder-sync-gates-history/1`: `{id, source: ci|local, branch, sha, t, url, conclusion, gates: {G1: {status, failing, failing_total, summary}, ...} | null, note}`. `scripts/dev-view` refreshes it before serving (offline, it uses the cache). `gates.json` and its ids stay as they were.
- **Is it syncing?** A bar under the title: calm with "canary file online in 640 ms, 3 folders checked, none stalled" when the live check (docs/KPI.md "Is it syncing?") is healthy, a red "Sync stalled" bar naming each cause when it is not, "not being checked" when its points are older than 20 minutes. It opens the last 48 checks as a strip (green ok, red stalled, hollow offline), a chart of the canary time and a table of the folders that have stopped.
- **O3 costs**: the competitor table (`bench/cost/competitors.json`, `folder-sync-competitor-prices/1`, written by the cost lane; `--competitors`) with folder-sync's own per-person number in the same row style, and one line on the O3 card ("vs Dropbox Plus $x, ... per person-month at 10 GB"). Absent file: nothing is shown.
- **README and landing**: `scripts/readme-status` adds, per objective, a sparkline of its headline measure (SVG drawn at build time into `docs/status/`, inline on the landing page), a strip of the last 16 gate runs, and the competitor line under O3.

## Generator

`scripts/status --kpi <kpi_series.jsonl> --gates <gates.json> [--history <gates-history.jsonl>] [--competitors <competitors.json>] --out <dir> [--now <ISO>]` writes `<dir>/index.html` (one self-contained page: inline CSS, inline SVG and the vendored chart library, no CDN) and `<dir>/status.json` (the model, for CI or another reader). It needs only node. A missing or broken source is a note at the bottom of the page and "not measured yet" in the cell, never an error; only a bad command line exits non-zero. Defaults: `~/vt/zach/producers/folder-sync/kpi_series.jsonl`, `reports/status/gates.json`, `site/dev` (the output is gitignored).

| File | Role |
|---|---|
| `scripts/status` | the command; `status.mjs` parses arguments and writes the files |
| `scripts/status-model.mjs` | the sources in, a plain object out: headline per env, 30-day lines, series, gates |
| `scripts/status-render.mjs` | the object in, the page out |
| `scripts/gates-history` | the CI runs' and local gate results as `gates-history.jsonl` (`gates-history.mjs`; tests: `node --test scripts/gates-history.test.mjs`) |
| `scripts/status-test` | the tests below |
| `scripts/dev-view` | regenerate and serve |
| `scripts/readme-status` | the same model, written as the "Objectives & Gates" block of `README.md` (and, with `--landing`, of the GitHub Pages `index.html`) between `<!-- status:begin -->` and `<!-- status:end -->`; `--check` fails when a block is stale. Tests: `node --test tests/readme-status/readme-status.test.mjs` |

## What it reads

The shapes are a frozen contract shared with the lanes that write them.

- **KPI points**: `vt-kpi-point/1` lines `{kpi, t, value, status: "measured"|"failed", slice: {env: "test"|"prod", direction?, op?, provider?, profile?}, labels?}` (the cost points' `labels`: `provider_name`, `is_store_provider`, `folders`, `store_unpriced`). The names it knows: `propagation_p50_ms`, `propagation_p95_ms`, `storage_efficiency_h`, `storage_efficiency_h_30d_max`, `cost_per_gb_month_usd`, `cost_per_person_month_usd`, `idle_cpu_pct`, `idle_ops_per_hour`. Older `sync_up_ms`, `sync_down_ms` (and `_p95`) points read as propagation with `op: "legacy"`, the stack `local` as `test`; their facet roll-ups without `slice.stack` are the same measurements and are skipped. Anything else (bad JSON, no `slice.env`, an unknown KPI, a bad time, an exact duplicate) is skipped and counted under "Sources and data notes".
- **Gates**: `reports/status/gates.json`, `{schema: "folder-sync-gates/1", run_at, code_sha, branch, gates: [{id, name, status: "pass"|"fail"|"not_built"|"skipped", summary, tests: [{name, status, duration_ms, detail}], evidence}]}`. A gate id missing from the file shows as "no result".

## How the numbers are read

- **Headline of an env** is the worst latest value over its slices (a miss in any direction or op is a miss); for cost (per GB-month and per person-month) it is the cost on the provider each folder is actually on, read from the points' `labels.is_store_provider` (the dearer one when folders are on two providers; "no price for this store" for a MinIO, a NAS or a directory), with "cheapest provider: <name> <price>" as a second line under it. Cost points written before those labels existed read as the cheapest provider, as before. Person-month uses the 10 GB profile when there is one. The 30-day line is that same aggregate carried forward from slice to slice, so it ends on the headline.
- **Dot**: green meets the target, amber is within 2x of it, red is beyond; a KPI with no target (cost per GB-month, idle ops) has a hollow dot. Amber and red appear only for a miss; every dot has its word beside it. A failed run is shown beside the last measured value, never as a zero.
- **Targets** (PROJECT - Folder Sync, Nov 4): p50 <= 1 s, p95 <= 3 s; H 30-day max <= 1.0 (stretch 0.25); $0.50 per person-month at 10 GB; idle CPU <= 0.1 %. They live in `OBJECTIVES` in `status-model.mjs`.

## Tests

`scripts/status-test` runs the generator tests (`node --test tests/dev-view/status.test.mjs`) and the page in Chromium (`tests/dev-view/dev-view.spec.mjs`, Playwright from `ui/node_modules`, so `npm --prefix ui ci` first), both over `tests/fixtures/dev-view/` (a KPI series with test, prod, legacy, failed, duplicate and malformed points; a gates file with ten of the twelve gates). `DEV_VIEW_SHOTS=<dir>` also writes the light, dark and phone screenshots.
