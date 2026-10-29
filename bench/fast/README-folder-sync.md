# The folder-sync harness (`bench/fast/fs_bench.mjs`)

folder-sync's side of the Fast Folder Sync bench. The ruler is `CONTRACT.md`: its directions, workloads, faults and
row schema, unchanged here.

## Run it

```bash
systemd-run --user --scope -p MemoryMax=16G -- node /home/bam/folder-sync/.claude/worktrees/bench/bench/fast/fs_bench.mjs run --variant push --trials 10
```

- `--variant poll|push` (required). `poll` is `0db76d4`, `claude/folder-sync-v0`'s last polling-only commit. The
  branch took the push merge (`99560d9`) after this bench was specified, so poll is pinned to the merge's first
  parent. `push` is `lane/fast-sync` (PEP 0005: a folder watcher and a Durable Object hub).
- `--config k=v,...`: `interval=2s` for both variants. It is written into each machine's `.folder-sync.toml` after
  `init`, and folder-sync refuses anything under 1s. For push only: `debounce=25ms`, `fallback=60s` and
  `discover_every=5m`. Any of these applies `patches/fast-sync-tunables.patch` to the export and sets
  `FOLDER_SYNC_DEBOUNCE`, `FOLDER_SYNC_FALLBACK` or `FOLDER_SYNC_DISCOVER_EVERY`; without them the tree is unpatched.
  `transfers=` is refused. Neither ref passes `--transfers` or `--checkers` to rclone, and `internal/rclone` strips
  every `RCLONE_*` variable, so there is nothing to tune: rclone's default of 4 is in force.
- `--directions`, `--workloads`, `--faults` take comma lists of the contract's ids (the default is all of them).
  Also `--trials N` (default 10), `--run-id ID` and `--idle-s S` (default 120; 0 skips the idle row).

Each run exports the ref with `git archive` into `~/.cache/folder-sync-bench/<variant>-<sha>[-p<patch>]/` and builds
the CLI there. Nothing is built in a checkout. `accounts/node_modules` is one `npm ci` per lockfile, shared through a
symlink. Remove the cache yourself with `rm -r ~/.cache/folder-sync-bench` when you no longer need it. The stack is
the export's own `accounts/scripts/dev.mjs` on 127.0.0.1:5100-5103. Everything a run starts is stopped by its PID at
the end (and on Ctrl-C), and the run's temp dir in `/tmp` is deleted.

Rows go to `results/raw/<run_id>.jsonl`, `.idle.jsonl`, `.ops.jsonl` and `.summary.json` (p50/p95 per direction and
workload). The raw evidence goes to `results/raw/<run_id>/`: the stand-in's request log, wrangler's log and each
daemon's output. `results/raw/` is gitignored.

## The hosts

| host | what it is |
|---|---|
| A, B | separate HOMEs, one test person (email code), `folder-sync login` (device grant), `init` of the same project, then `sync --watch`. Each daemon runs in its own `systemd-run --user --scope -p MemoryMax=4G --unit fsbench-<run>-<host>` |
| web | `PUT /fs/v1/folders/<p>/web/<path>` and `GET …/files/<hostA>/<path>` from the harness, with the bearer of a third logged-in machine |
| agent | that third machine's bearer and no daemon: every attempt is one fresh `curl` process that reads every pending file through `/fs/` |

## Network: every host through its own `tcpproxy.mjs`

Ports: A on 5110-5113, B on 5114-5117, web on 5120-5121, agent on 5122-5123 (listen/control pairs).

The Worker vends one S3 endpoint (`R2_ENDPOINT`, the stand-in on 127.0.0.1:5100) and signs that host into the
session token's `aud`, which the stand-in checks against `Host`. A per-host proxy on another port would fail that
check, and neither ref lets a machine pick its own endpoint. So each machine runs in its own unprivileged network
namespace (`unshare -rn`, no root). Inside it, 127.0.0.1:5100 (S3) and 127.0.0.1:5102 (Worker and hub) are
`lib/fwd.mjs` pipes to unix sockets. Outside, those sockets lead into that machine's two proxies, then to the real
services. A machine therefore dials exactly the URLs a direct one would, and it has no route that skips its proxies.
`drop` cuts both of B's proxies, which cuts every path B has. The pipes count nothing and never cut. Note that a
connection opened during a cut is accepted by the inner pipe and then closed when the proxy resets it, rather than
refused at connect.

Set-up (`login`, `init`, the first `sync --once`) runs outside the namespaces, straight to the stack, and is never
timed or counted.

## What the numbers are

- Trial rows: the clock starts just before the write and stops when the reader holds the same sha256 (disk polled every
  10 ms, web every 25 ms, agent one fresh `curl` per attempt with at least 25 ms between starts). Each trial sleeps a
  random 0.2 s to (interval + 0.2 s) first. In `w2m storm` the 20 PUTs are each awaited and then spaced 50 ms apart,
  because overlapping PUTs to one path could land out of order. Conflicts are the new files in each machine's
  `~/.folder-sync/conflicts`, counted when the next trial writes. A peer that is not the reader makes its conflict
  copy on its own next round.
- Idle row: `cpu_pct_per_host` is each scope's `cpu.stat usage_usec` delta, which includes rclone children.
  Wakeups are the summed voluntary and involuntary context switches over `cgroup.procs` at the end of the window.
  This is a battery proxy, and it misses short-lived children (each rclone run), so it undercounts poll the most.
  Net bytes come from the machine's two proxies. Requests come from the stand-in's log (`gate.jsonl`, classed as R2
  bills them) and wrangler's request log, divided by the 2 hosts. Neither log says which machine made a request: every
  vended key carries the parent's key id.
- Ops rows: one `1k` change (m2m, then w2m), counted over 15 s from the write across all hosts, minus the idle rate over
  the same span (the raw counts are in `note`). `do_msgs` is null: the hub logs nothing, and its WebSocket frames are
  not requests.
