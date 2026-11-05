# The objective KPIs

Zach's three objectives of 2026-11-04 (`PROJECT - Folder Sync`, "Nov 4 - Final Objectives for Now"), as numbers that are measured
every hour in **test** and in **production** and appended to Vibe Tracks:

| | Objective | Target | KPI names (exact) |
|---|---|---|---|
| **O1** | Fast | propagation p50 <= 1 s, p95 <= 3 s, save to bytes on the other disk and online; add, edit, delete, rename; machine<->machine and machine<->web; benchmarked against the best off-the-shelf tool | `propagation_p50_ms`, `propagation_p95_ms` |
| **O2** | Storage efficient | H = history bytes / live bytes, 30-day max <= 1.0 (stretch <= 0.25) | `storage_efficiency_h`, `storage_efficiency_h_30d_max` |
| **O3** | Cheap | cost per person-month <= $0.50 at 10 GB, idle ~ $0 and < 0.1 % CPU; compared with Obsidian Sync, Dropbox and other storage providers | `cost_per_gb_month_usd`, `cost_per_person_month_usd`, `idle_cpu_pct`, `idle_ops_per_hour` |

The older `sync_up_ms` / `sync_down_ms` (and `_p95`) points keep being written: they are `machine->web` add and `web->machine` add of the
same run, so their history is unbroken.

## The data contract (frozen)

One JSON object a line in `~/vt/zach/producers/folder-sync/kpi_series.jsonl`, `vt-kpi-point/1`:

```json
{"schema":"vt-kpi-point/1","kpi":"propagation_p50_ms","t":"2026-11-04T10:30:00-07:00","value":303,"n":24,"status":"measured",
 "labels":{"p95":455,"timeouts":0,"stack":"local","interval_ms":10000},
 "source":{"code_sha":"18aabfc64c17","bench_version":"folder-sync-latency/2","run_ids":["latency-local-..."],"dirty":false},
 "slice":{"env":"test","direction":"machine->machine","op":"mixed"}}
```

- `status` is `measured`, or `failed` with `value: null` and `labels.reason`. A KPI that cannot be measured says so; it is never
  skipped and never zero. (Today every production propagation point is `failed`: see "What is red".)
- `slice.env` is `test` or `prod`. Propagation adds `direction` (`machine->machine` | `machine->web` | `web->machine`) and `op`
  (`add` | `edit` | `delete` | `rename` | `mixed`, all four pooled); a competitor's number adds `tool` and `variant`; storage adds `workload`;
  cost adds `provider` (`r2` `s3` `gcs` `b2` `wasabi`) and `profile` (`reference` | `average`).
- `bench/kpi/lib.mjs` `appendPoints` never writes the same (kpi, slice, run id) twice, so every producer is idempotent.
- The catalog is `kpi_catalog.json` (`vt-kpi-catalog/1`); `bench/kpi/catalog.mjs` writes it, the four legacy entries unchanged.

## How each one is measured

### O1 propagation (`bench/latency/bench.mjs`)

A black box over the real CLI (`init`, `sync --watch`). Each sample is one file taken through **add, edit, rename, delete**, each op started
at a random phase of the 10 s sync interval; the clock starts just before the write and stops when the reader holds the end state:

| direction | the write | the reader that stops the clock |
|---|---|---|
| `machine->web` | machine A: write-then-rename (an editor's save), rename, rm | `GET /fs/v1/folders/<p>/files/<A>/<path>` every 50 ms: same bytes, or 404 for a delete / the old name |
| `machine->machine` | the same write (one write feeds both readers) | machine B's `hosts/<A>/<path>` every 10 ms: same bytes, or gone |
| `web->machine` | `PUT /web/<path>`, `DELETE /web/<path>`; a web rename is PUT new then DELETE old, as a page does it | machine A's `hosts/<web host>/<path>` every 10 ms |

6 samples a run, so 6 trials per op and 24 pooled (`mixed`). After three ops in a row that never arrive a sample stops waiting.

- **env=test**: `--stack local`, the whole stack on loopback (rclone serve s3, the R2 stand-in, `wrangler dev` with a local D1), two machines in
  throwaway HOMEs. Hourly.
- **env=prod**: `--stack prod`, this machine's signed-in session against `https://vibetracks.dev` and real R2, in the project `bench-latency` only. A second
  machine (a persistent HOME, `~/.local/share/folder-sync-bench/machine-b`, its own host id) reaches the same session through
  `FOLDER_SYNC_ACCOUNT_PROCESS` = `cat ~/.folder-sync/account.json` (PEP 0006's account process), so the token is never copied. Before it touches anything it reads
  `GET /fs/v1/usage`; an account over its quota holds every upload, so it records `failed` points with the quota message instead of waiting out timeouts.
- **vs off-the-shelf**: `bench/kpi/offshelf.mjs` folds the newest `bench/fast/results/summary-*.json` (PEP 0008) into the same series with `slice.tool` /
  `slice.variant` (`syncthing`, `unison`, `mutagen`, `lsyncd`, `rclone-bisync`, and folder-sync's own `poll`, `push`, `head`, `push-tuned`), 1 KB file,
  `op: mixed`, once per summary. Those are loopback numbers from 2026-10-28; Dropbox, Google Drive and Resilio are published numbers in `bench/fast/published.json`, not measured.

### O2 storage efficiency

H comes from `GET /fs/v1/usage`: `history.bytes / live.bytes`, where history is `_history/`, `_changes/`, `_requests/` and legacy `_trash/` (`accounts/src/quota.ts`).

- **env=prod** (`bench/kpi/usage.mjs`, hourly): the signed-in account's own usage. `storage_efficiency_h_30d_max` is the largest sample of the trailing 30 days in
  the series, written with each sample.
- **env=test** (`bench/kpi/storage-test.mjs`, every 6 h): the deterministic workload `ci-history-v1` on the local stack with `QUOTA_RECHECK_S=1` (production caches
  usage 300 s): 60 notes (2-6 KB), 6 append-only logs, 3 binary blobs; then 5 rounds, 31 s apart, each rewriting 12 notes, appending to every log and replacing one
  blob. The 31 s is PEP 0007's burst window plus one second, so every replaced version is kept and the number measures what a kept version costs. It is **not a
  30-day replay**: the hourly and daily thinning never starts inside three minutes. It is the number that moves when the engine changes what it keeps (PEP 0009); the
  30-day max over test points is therefore a max over workload runs, not over a month of use.

### O3 cost

- **Prices** (`bench/cost/prices.json`, rendered in [PRICES.md](PRICES.md)): list prices with a source URL, quote and date for R2, S3, GCS, B2, Wasabi and the Workers /
  Durable Objects / D1 side. `bench/cost/model.test.mjs` fails if a price has no source.
- **Counters** (`bench/kpi/ops.mjs`, every 12 h, ~19 min): two machines on the local stack. Requests are counted from the R2 stand-in's log (class A = writes and lists,
  class B = reads, deletes free) and `wrangler dev`'s request log. A 10-minute idle window gives `idle_ops_per_hour` and `idle_cpu_pct` (the watcher's whole process tree
  from `/proc`); then 12 changes of 50 KB with A alone and 12 with A and B give requests per change for the writer and for each reader, less the idle rate. Written to
  `~/.local/state/folder-sync-kpi/cost_counters.json`. Durable Object messages are not observable locally; the model assumes one per change and nothing idle
  (`assumed` in the file), which at list price is well under a cent.
- **Model** (`bench/cost/model.mjs`, hourly): stored bytes = live x (1 + H); requests = idle machine-hours + changes (writer once, each other machine's reads once);
  egress = bytes per change x other machines; provider minimums applied; no free tier (a free tier is per account). Workers + DO request overage is added for
  `cost_per_person_month_usd`; the fixed $5 Workers Paid fee is a deployment's, not a person's, and is reported apart in `labels.platform_base_usd`.
- **Profiles**: `reference` (env=test) = 10 GB live, 3 machines, 1000 changes/day, 50 KB a change, H from the test workload. `average` (env=prod) = Zach's account:
  live bytes and H from `/fs/v1/usage`, machines = distinct hosts in `/fs/v1/folders`, changes a day from this machine's sync logs over 7 days (one machine's writes, so a lower bound).
- **Idle in production** (`bench/kpi/idle-prod.mjs`, every 6 h): the CPU of the real `sync --watch` daemons for 30 s, labelled `kind: observed`. There is no production
  `idle_ops_per_hour`: request counts live in Cloudflare's analytics, which needs an API token this machine does not hold. The local counters are the same engine.

## Running it

```bash
node /home/bam/folder-sync/bench/kpi/run-all.mjs run
```

`run-all.mjs` takes an exclusive lock (`~/.local/state/folder-sync-kpi/run-all.lock`), skips each stage while its newest point is younger than its cadence
(`status` shows what is due; `--force` and `--only a,b` override), and turns a stage that throws into `failed` points that say why. Stages: `propagation-test` and `propagation-prod`
and `usage-prod` and `cost` (50 min), `storage-test` (6 h), `ops` (12 h), `idle-prod` (6 h), `offshelf` (once per summary).

`folder-sync-kpi.timer` (hourly, `Persistent=true`) runs it; `run-all.mjs install-timer` writes the units to `~/.config/systemd/user` and **switches off
`folder-sync-latency.timer`** (its run is the `propagation-test` stage; two timers would start the same stack on the same ports). The old unit file stays, so
`node bench/latency/bench.mjs install-timer` brings it back. The units run from the checkout `install-timer` was run in (`--repo`): run it again from the main checkout
once this lane is merged.

Tests: `node --test 'bench/**/*.test.mjs'`.

## Is it syncing? (a health check, not an objective)

Zach, 2026-11-04, after a killed sync left an empty lock that blocked a folder for 30 minutes and nothing noticed: "monitor live ... if things never propagate it times out after like 10 minutes"; and then, on a canary that writes a test file: "couldn't you just kinda monitor when the files change by the users? it would be nice if we are super quiet when nothing is changing". So the check is **passive**: `bench/kpi/stall.mjs`, every 5 minutes (`folder-sync-stall.timer`), reads only this machine's own state. It writes nothing to any folder, makes **no network request** and adds no storage request.

One new KPI name in the same `vt-kpi-point/1` shape (the shape is unchanged); it has no target and no card, it is an alarm:

| KPI | Meaning | Points |
|---|---|---|
| `sync_stalled_folders` | Of this machine's synced folders (`folder-sync status --json`; not the bench's own), how many have a **change on disk that the last push does not hold and that has waited more than max(10 minutes, 3 x the folder's interval) while online**. "A change the last push does not hold" is the engine's own test (`internal/syncer/round.go` `Push`): rclone's local listing with the engine's filter file (`filters.txt` in the project's state dir) against the size and mtime of each file in the state dir's `manifest.json`, less the files the engine skips by name; a missing path is a pending delete. How long it has waited is the later of when a check first saw it and when the file was last written, so a file written every second (a log) is never stalled while the engine keeps up, and a file copied in with an old mtime is judged from its arrival. | `value` = the number stalled; `labels.checked`, `labels.pending` (changes waiting but younger than the bar), `labels.result` `ok` / `stalled` / `offline`; `labels.stalled` = `[{project, folder, cause, detail, age_min, interval_s}]`. `cause` comes from the engine's state: `lock` (the project's lock file: holder pid, whether it is running, age; an empty or dead holder's lock too), `quota` / `auth` (the last round's error), `held_deletes` (`last.held_deletes`), `round_failed` (the error text), `not_pushing` (a `sync --watch` for the folder is running but not pushing), `no_rounds` (nothing is running rounds for it). |

- **Quiet when nothing changes.** A folder with nothing pending is `idle`: no network, no file, no point. A point is written when the result or the stalled set changes, else at most one an hour (the idle heartbeat the dev view reads as "still being checked"; 90 minutes without a point reads "not being checked", never "fine").
- **Offline is not red.** Online is a default route in the kernel's table (`/proc/net/route`, nothing is sent; where there is no such table the engine's own round error says so): a round that failed with no route or no such host is offline too. Offline writes a `failed` point reading "offline, not measured", raises no alert, and the time spent offline does not count toward a stall (reconnecting never starts red).
- **A stall alerts once per episode.** A folder first seen stalled opens an episode and fires one `notify-send` (no focus steal; `FOLDER_SYNC_NOTIFY_CMD`, a JSON argv, replaces it in tests); later stalled checks stay quiet; a push or an idle check closes it; offline and pending leave it open. The episodes are in `~/.local/state/folder-sync-kpi/stall-state.json`. The dev view shows a red "Sync stalled" bar with the causes at the top.
- **From real use: O1 at no extra cost.** Every file the engine pushes records its mtime and its `written_at` in the manifest, so a push is a sample: `written_at - mtime` is save to bytes in the store. Each check turns the files pushed since the last check into `propagation_p50_ms` / `propagation_p95_ms` points (`slice` `{env, direction: "machine->web", op: "real"}`, `labels.n`, `labels.measured` says how) and writes nothing when nothing was pushed. Samples over 10 minutes are left out (a copied file's old mtime, or a stall, which the check above reports); the first run starts at the clock and never backfills. It is the load-bearing caveat that this is save to *pushed*, one hop, from the engine's own clock reading, not machine to machine.
- **Install** (this repo ships the units and does not enable them): `node bench/kpi/stall.mjs install-timer` writes `folder-sync-stall.service` and `.timer` to `~/.config/systemd/user` and enables the timer (`--print` shows them, writes nothing); `node bench/kpi/stall.mjs run` is one check by hand (`--no-notify`, `--env test`); `status` prints the newest point and the open episodes.
- **Tests**: `bench/kpi/health.test.mjs` (the classifier: idle / pending / stalled / offline / skipped, each cause, what counts as pending, the quiet-point rule, one alert per episode, real-use samples, the point shapes) and `bench/kpi/stall.e2e.test.mjs` (the local stack and the real engine: a quiet folder writes one point then nothing; a change saved with the engine stopped is `pending`, then `stalled` after the test's 3 s bar with one notification; a live process holding the lock is named; the engine pushing again ends the episode and leaves a real propagation point; no route is `offline` with no alert).

## What is red (first full run, 2026-11-04, code `18aabfc`)

| | Result | vs target |
|---|---|---|
| O1 test, all 15 direction x op cells | p50 189-407 ms, p95 240-616 ms, 0 timeouts in 72 trials; pooled p50 260-303 ms, p95 447-460 ms | **meets** p50 <= 1 s, p95 <= 3 s (loopback: no WAN round trip) |
| O1 prod | `failed`: the account is over its 10 GiB quota, so uploads are held | **not measurable** until the account is back under quota |
| O1 vs off-the-shelf | folder-sync push-tuned m2m 370 ms; Unison supervised 515 ms; Mutagen 40 ms (local-only); rclone bisync 1.5 s; Syncthing 1.4-8.4 s | folder-sync is 2nd on machine<->machine (only Mutagen's local-only session is faster) and 1st on machine<->web and web<->machine among the tools that have them (2026-10-28 numbers) |
| O2 prod | H = 68.0 (10.59 GB of history over 155.6 MB live) | **fails** <= 1.0 by 68x; the Oct 25 binary keeps every replaced file whole and never prunes (PEP 0009 §1) |
| O2 test | H = 1.51 after 5 rewrite rounds of `ci-history-v1` | **fails** <= 1.0; PEP 0009's pointers + zstd are the lever |
| O3 reference, R2 | $1.69 per person-month ($0.165 per live GB-month) at H = 1.51; $1.62 at H = 1.0; $1.50 at H = 0.25 | **fails** <= $0.50: requests are $1.28 of it |
| O3 reference, B2 | $0.22 per person-month | meets, because B2 does not charge for requests |
| O3 idle | 0.089 % of a core per machine; 123 requests an hour per machine (39 class A, 72 class B, 12 Worker) | CPU meets < 0.1 % with 11 % to spare; "idle ~ $0" does not hold on R2: idle class A alone is $0.38 per person-month |

Reading the cost miss: on R2 a person's bill is dominated by class A requests (idle polling 84k a month for 3 machines, plus 2.9 per change for the writer and 0.9 for each
reader), not by bytes. Lowering H from 1.5 to 0.25 saves $0.19; halving idle class A would save as much. The fixed $5 Workers Paid fee comes on top: with a
variable cost of $1.69 the $0.50 target is not reachable at any number of people on R2.
