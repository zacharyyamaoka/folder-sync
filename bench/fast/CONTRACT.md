# Fast Folder Sync bench: the frozen contract (PEP 0008)

Every harness in `bench/fast/` writes rows in this shape, so folder-sync and every off-the-shelf tool are measured
with one ruler. Change this file only in its own commit, before the harnesses that read it.

## Directions (the clock starts just before the write and stops when the reader holds the same sha256)

| id | from | to | reader |
|---|---|---|---|
| `m2m` | host A's disk (write-then-rename, as an editor saves) | host B's disk | poll B's file every 10 ms, compare sha256 |
| `m2w` | host A's disk | a web reader | HTTP GET every 25 ms. folder-sync: `GET /fs/v1/folders/<p>/files/<hostA>/<path>` with the bearer; an S3-backed tool: `GET` of the object from the S3 endpoint |
| `w2m` | a web write | host A's disk | folder-sync: `PUT /fs/v1/folders/<p>/web/<path>`; an S3-backed tool: S3 `PutObject` into its bucket. Poll A's disk every 10 ms |
| `m2a` | host A's disk | an agent/CLI with a credential and no daemon or synced folder | each attempt is a fresh process (`curl`-like fetch through the /fs/ API with the bearer for folder-sync; `rclone cat` for an S3-backed tool), retried until the bytes match; also record the cold one-shot read cost (`cold_read_ms`) |
| `offline` | host A writes while host B is cut off | host B's disk | the clock starts at **restore**, stops when every file written during the cut-off is on B with its sha256 |

A tool with no path for a direction (Syncthing, Unison and Mutagen have no web or bucket copy) gets one row with
`status: "n/a"` and `note` saying why. Never a 0, never a guess.

## Workloads

| id | what is written |
|---|---|
| `1k` | one 1 KB JSON file (random content) |
| `100k` | one 100 KB file (random bytes) |
| `10m` | one 10 MB file (random bytes) |
| `200m` | one 200 MB file (random bytes; m2m, m2w and w2m only) |
| `many100` | 100 files of 1 KB each, written as fast as possible. `ms` = until the last one is readable, `first_ms` = the first |
| `storm` | one 1 KB file saved 20 times, 50 ms apart. The clock starts at the **last** save; done when the reader holds the last version. Any conflict copy or lost final version is a correctness failure |

Faults, applied to `offline`:
- `drop`: the network between host B and everything else is cut (TCP proxy refuses and resets) for 20 s while A writes
  10 x 1 KB files, then restored.
- `sleep`: host B's daemon processes are `SIGSTOP`ped for 20 s while A writes 10 x 1 KB files, then `SIGCONT`.

Each trial starts at a random phase: sleep a uniform random 0.2 s to (1 polling interval + 0.2 s) before writing, so a fixed
phase of a round timer is never what is measured.

## One results row (JSON Lines, `results/<run_id>.jsonl`, one row per trial)

```json
{"schema":"fast-folder-sync-trial/1","run_id":"…","tool":"folder-sync","variant":"push","config":{"debounce_ms":100},
 "direction":"m2m","workload":"1k","fault":null,"trial":3,"status":"ok","ms":312,"first_ms":null,"put_ms":null,
 "cold_read_ms":null,"bytes":1024,"sha256_ok":true,"conflicts":0,"lost":0,"real":true,"env":"local-loopback",
 "load1":1.8,"t":"2026-10-28T15:30:00-07:00","note":null}
```

- `status`: `ok` | `timeout` (no match within the trial's timeout; `ms: null`) | `n/a` | `error` (with `note`).
- `real`: true when the tool ran for real on this machine. A published number is never a row here; it goes in
  `bench/fast/published.json` with a URL and an access date, labelled "not run".
- `env`: `local-loopback` (all hosts on this machine over 127.0.0.1, no WAN RTT) or `real-r2` (Cloudflare R2 + the
  deployed Worker over the internet).
- `load1`: `/proc/loadavg`'s first field when the trial started. A noisy machine shows here.

## Idle rows (`results/<run_id>.idle.jsonl`, one per tool + variant + config)

```json
{"schema":"fast-folder-sync-idle/1","run_id":"…","tool":"syncthing","variant":"default","config":{},
 "window_s":120,"hosts":2,"cpu_pct_per_host":0.4,"wakeups_per_min_per_host":310,"net_bytes_per_min_per_host":5200,
 "requests_per_min_per_host":{"class_a":0,"class_b":0,"worker":0},"real":true,"env":"local-loopback","note":"…"}
```

- `cpu_pct_per_host`: the host's whole process tree (every daemon and every child it spawns, e.g. rclone runs), from its
  cgroup's `cpu.stat usage_usec` (each host runs in its own `systemd-run --user --scope`), as % of one core.
- `wakeups_per_min_per_host`: voluntary + involuntary context switches of the host's processes. This is a battery proxy and is
  labelled as one.
- `net_bytes_per_min_per_host`: bytes through the host's TCP proxy (both ways).
- `requests_per_min_per_host`: S3 requests seen by the store (class A = PUT/POST/COPY/LIST, class B = GET/HEAD, as R2 bills
  them) and Worker requests. These feed the cost model.

Per-change request counts (for cost) go in `results/<run_id>.ops.jsonl`:
`{"schema":"fast-folder-sync-ops/1","tool":…,"variant":…,"workload":"1k","direction":"m2m","class_a":…,"class_b":…,"worker":…,"do_msgs":…}`.

## Rules every harness keeps

- Each host is a separate HOME and a separate process tree. Hosts reach each other and the store only through the
  bench's TCP proxy (`bench/fast/tcpproxy.mjs`), which counts bytes and can cut a host off.
- Ports: the folder-sync harness uses 127.0.0.1:5100-5139, the competitors' harness 5200-5239. 4950-4953 belong to the
  hourly latency timer and 4973 to the fast-sync demo; never bind them.
- Stop every process you start, by the PID you recorded. Delete your temp dirs. Never touch `~/.folder-sync`,
  `~/.config/syncthing` or any real config of this machine's user.
- Heavy runs go under `systemd-run --user --scope -p MemoryMax=16G --`.
