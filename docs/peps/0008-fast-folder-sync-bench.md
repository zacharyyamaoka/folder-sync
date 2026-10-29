# 0008 · Fast Folder Sync: sync speed as a measured optimization problem

- **Date:** 2026-10-28
- **Status:** proposed, built and measured on branch `lane/sync-bench`. Final when Zach merges it.
- **Source:** Zach, 2026-10-28: "I think we can actually run this for real to get hard data. Like we can turn this
  into an optimization problem. We always want faster subject to certain constraints right..." Also: "Faster Folder
  Sync should be started as another track within the Folder Sync effort."
- **Builds on:** PEP 0001 (rclone + one R2 bucket, the manifest), PEP 0003 (the accounts Worker, the web host),
  PEP 0005 (push sync: the watcher + the folder's Durable Object hub, `lane/fast-sync`), PEP 0007 (history). The
  hourly black-box KPI `bench/latency/bench.mjs` (`lane/latency-kpi`) is the one-machine version of this bench and
  stays as it is.
- **Numbering:** 0005 (push sync), 0006 (desktop app) and 0007 (history and sync view) are taken on other branches.
  This is 0008.
- **Report:** `reports/media/fast-folder-sync-bench-2026-10-28.html`. **Track:** Vibe Tracks `faster-folder-sync`,
  a child of `folder-sync`, reading `producers/folder-sync-bench`.

## 1. The problem

**Minimise** end-to-end propagation latency, p50 and p95, separately for each direction:

| id | direction | clock starts | clock stops |
|---|---|---|---|
| `m2m` | machine → machine | the file is renamed into place on A's disk | B's copy has the same sha256 |
| `m2w` | machine → web | as above | `GET /fs/v1/folders/<p>/files/<A>/<path>` returns the same bytes |
| `w2m` | web → machine | the page's `PUT /fs/v1/folders/<p>/web/<path>` is sent | A's copy has the same sha256 |
| `m2a` | machine → agent/CLI | as for m2m | an agent with a credential and no daemon (a fresh process per attempt) reads the same bytes |
| `offline` | catch-up after reconnect | host B's network comes back (`drop`) or its processes resume (`sleep`) | every file A wrote meanwhile is on B with its sha256 |

**Subject to** (hard constraints; a configuration that breaks one is out, however fast):

| # | Constraint | Bound | How it is measured |
|---|---|---|---|
| C1 | Cloudflare cost at Zach's scale: 5 people × 3 devices + 3 pages, 2,000 changes/day | ≤ $5/month (the Workers Paid plan the accounts Worker already needs; $0 overage) | Measured requests (idle per minute per host, per change) × list prices; DO load modelled (§4) |
| C2 | Idle CPU per machine | ≤ 0.1 % of one core | The machine's cgroup `cpu.stat` over 120 s, daemon and every child |
| C3 | Idle bandwidth per machine | ≤ 10 KB/min | Bytes through the machine's own TCP proxy |
| C4 | Battery / wakeups | ≤ 300 context switches/min (proxy) | `/proc/<pid>/task/*/status` of the machine's live processes |
| C5 | Correctness | 0 lost writes, 0 conflict copies on a single-writer workload, 100 % sha256 match | Every trial |
| C6 | Single writer per host; the folder is the database | structural | Unchanged engine contract (PEP 0001): a configuration may change timing, never the data model |

The objective is a vector (five directions × p50/p95), so the answer is a **frontier**, not one number: for each
direction, the configurations no other configuration beats on both latency and cost (or idle CPU).

## 2. Workloads and faults (the matrix)

| Sizes | Bursts | Faults (offline only) |
|---|---|---|
| 1 KB JSON · 100 KB · 10 MB · 200 MB | one edit · 100 small files at once · a save storm (one file, 20 saves 50 ms apart) | `drop`: B's network cut for 20 s while A writes 10 files · `sleep`: B's processes `SIGSTOP`ped 20 s |

Each trial starts at a random phase of the polling interval, so a timer's fixed phase is never what is measured. The
KPI headline is the 1 KB file (the common case: a JSON note); offline's is `drop`.

## 3. The harness (run for real, on one machine)

`bench/fast/` (contract: `bench/fast/CONTRACT.md`, frozen before either harness was written):

- `fs_bench.mjs`: folder-sync. Exports a ref (`poll` = v0 before push, `0db76d4`; `push` = `lane/fast-sync`;
  `head` = `claude/folder-sync-v0` now), builds the CLI, stands up the local stack (`rclone serve s3` + the R2
  stand-in + `wrangler dev` with local D1 and the hub Durable Object), signs a test person in, and runs two machines
  (separate HOMEs, each in its own unprivileged network namespace whose only routes are its own `tcpproxy.mjs`), the
  web host and an agent. `--config` sweeps the tunables (§5).
- `competitors/bench_competitors.py`: Syncthing, Unison, Mutagen, rclone bisync and lsyncd, official release binaries
  checksummed into `competitors/.tools/` (`tools.lock.json`), the same hosts/proxy/workloads/rows.
- `tcpproxy.mjs`: the one network seam: byte counts and cut/restore for every tool alike.
- `analyse.py`: rows → `results/summary-<tag>.json`, the cost model, the frontier and the Vibe Tracks producer.
- `run_all.sh`: everything, one run at a time.

Every host runs in its own `systemd-run --user --scope`, so idle CPU includes short-lived children (rclone runs).
Limits of the method, stated once: all hosts are on one machine over loopback, so there is no WAN round trip
(it adds the same RTTs to every networked tool); the machine is shared with other work (each row records `load1`).

## 4. Cost model

`$/month = $5 (Workers Paid) + overage of R2 class A, R2 class B, Workers requests and DO requests`, where:
idle requests/min/host (measured) × 15 devices × 43,200 min + per-change requests (measured, 1 KB m2m) × 60,000
changes, with reads × 14 (every other device reads each change, pessimistic) + pages (3 pages × 8 h/day re-reading
every 10 s with polling, every 60 s as push's safety net, plus once per change with push) + the hub's DO requests
(151k/month: the fast-sync report's pessimistic model, because the local hub's messages are not observable). Prices:
R2 class A $4.50/M after 1M free, class B $0.36/M after 10M, Workers $0.30/M after 10M, DO $0.15/M after 1M.
Peer-to-peer tools cost $0 on Cloudflare and have no web or agent copy at all.

## 5. The tunables (what the optimiser turns)

| Tunable | Where | Default | Swept |
|---|---|---|---|
| poll interval | `.folder-sync.toml` `interval` | 10 s | 1 s, 2 s, 5 s (poll) |
| watcher debounce | `internal/push/watch.go` `Debounce` | 100 ms | 1, 25, 50, 250 ms |
| hub reconnect cap | `internal/push/hub.go` (backoff 0.5 s doubling to 30 s) | 30 s | 1, 2, 5 s |
| safety-net poll | `internal/push/wait.go` `Fallback` | 60 s | 15 s, 300 s |
| host discovery | `internal/syncer/run.go` `DiscoverEvery` | 5 min | (hub discovers new hosts at once; unchanged) |
| hub fan-out | the hub broadcasts every `changed` to every socket | all | not a knob in the code; measured as-is |
| upload concurrency | rclone `--transfers` | rclone's 4 | not a knob: neither ref passes it, and the engine strips `RCLONE_*` |

The sweep uses `bench/fast/patches/fast-sync-tunables.patch`, which turns those constants into env overrides on an
exported copy of `lane/fast-sync`, with the defaults unchanged. It is a proposal and is never committed to that branch.

## 6. Results

Measured, local loopback, 2026-10-28: see §6 of the report and `bench/fast/results/summary-20261028.json`. The
decision this PEP asks for is in §7.

## 7. Decision

Pending the measured run (filled in from the summary, never ahead of it).

## 8. Re-run

```bash
systemd-run --user --scope -p MemoryMax=16G -- bash /home/bam/folder-sync/bench/fast/run_all.sh
```
