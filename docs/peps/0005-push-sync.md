# 0005 · Push sync: a hub that says "this folder changed", so nothing waits for a poll

- **Date:** 2026-10-26
- **Status:** proposed, prototyped and measured on branch `lane/fast-sync` (cut from `lane/accounts`; §4b). Final when Zach merges it.
- **Source:** Zach, 2026-10-26: "Obsidian Sync works really quick. Perhaps we can copy its model? … I think the key
  idea is switching from polling to more of an interrupt/push system." And: "make sure it works whether you are just
  online, or online + local, and even on multiple computers."
- **Builds on** PEP 0001 (rclone + one R2 bucket, the manifest), PEP 0003 (accounts Worker at `/fs/`, the web host).
- **Prior art:** vault note `C - Fast file sync (prior art)`; measurements: `reports/media/fast-sync-2026-10-26.html`.

## 1. What was slow (measured, 2 machines + a page, 2 s rounds, local stack)

| Path | Mean | Where the time went |
|---|---|---|
| page write → laptop disk | 1.0 s | PUT 60 ms · **waiting for the next 2 s round ≈ 0.9 s** · pull (one rclone process) 56 ms |
| laptop disk → `/fs/` serves it | 1.4 s | **waiting for the round ≈ 0.85 s** · push 170 ms (three rclone processes, ~55 ms each) |
| laptop disk → open page | 7.4 s | the above · **waiting for the page's 10 s re-read 5.6 s** · fetch 0.18 s · render 0.25 s |
| laptop disk → desktop disk | 2.0 s | two rounds in a row |
| a new machine (or web host) → others | 185 s (≤ 300 s) | **host discovery every 5 minutes** |

Every big number is a timer. The work itself (PUT, push, pull, render) is under 0.5 s. Idle cost: every round runs
`rclone lsjson` to scan the folder (~50 ms of process start-up), so a machine at 2 s burns ~2.5 % of a core doing
nothing.

## 2. Decision

Copy the model every fast sync product shares (Obsidian Sync, Dropbox, Replicache, Logseq's 2026 sync, tldraw sync):
**a small push that says "host H is now at seq N", then the reader fetches the content as it does today.** The bucket,
the manifest, rclone and every rule of the contract stay unchanged; the push only removes the waiting.

1. **A hub per folder:** one Durable Object (`FolderHub`) per `(owner, project)` in the accounts Worker, holding
   hibernating WebSockets from that folder's machines and pages. Idle sockets cost nothing (hibernation); outgoing
   messages are free; at Zach's scale it is inside the Workers Paid allowance ($0 beyond the $5 plan).
2. **Machines** watch their folder (fsnotify: inotify / FSEvents / ReadDirectoryChangesW) and run a round ~100 ms
   after a change instead of on a timer; after a round that wrote the manifest they tell the hub. A `changed` from the
   hub starts a round at once; an unknown host starts a discover in that round (no more 5-minute wait).
3. **The web host** tells the hub itself after every write (the Worker is already in the path).
4. **Pages** subscribe to the same hub and re-read on `changed`.
5. **Polling stays, slowed, as the safety net:** a machine with a live hub and watcher runs a round every 60 s; with
   no hub (a stored key, offline, the hub down) it falls back to its configured `interval`. A page with a live socket
   re-reads every 60 s, else every 10 s as today. Nothing depends on a message arriving: a lost push costs one fallback
   interval, never data.

### What it does not change

The bucket layout, the manifest, single-writer, `_trash/`, conflicts (a peer's copy edited locally still goes to
`~/.folder-sync/conflicts/`), credentials, and machines signed in with a stored key (they poll, as now).

## 3. The hub protocol (frozen for the prototype)

**Endpoint:** `GET /fs/v1/folders/<project>/events` with `Upgrade: websocket`, on the accounts Worker and on every
app's `/fs/` mount. Without the upgrade header: `426`. `?owner=<id>` reads someone else's folder exactly as the other
folder routes do (`decide()`: owner, reader or public).

**Auth:** the same session as every folder read: `Authorization: Bearer <token>` (a machine: `account.json`'s token)
or the session cookie on a registered origin (a page). A cookie upgrade must also carry an `Origin` equal to the
request's own origin and listed in `apps.json` (browsers send `Origin` on WebSocket upgrades; this stops cross-site
WebSocket hijacking). The Worker decides who may connect; the hub trusts what the Worker forwards.

**The hub:** `FolderHub`, a SQLite-backed Durable Object, `idFromName("<owner>/<project>")`. It accepts with
`ctx.acceptWebSocket(ws)` (hibernation) and auto-answers the text `ping` with `pong`
(`setWebSocketAutoResponse`), so a keep-alive never wakes it. Each socket's attachment records
`{ role: "owner"|"reader"|"public", kind: "machine"|"page" }` (machine = bearer, page = cookie). It keeps `cursor`
(a counter, +1 per change) and `hosts` (`{ <host-id>: { seq } }`) in its storage.

**Messages** (JSON text; at most 1 KB; anything else is ignored):

| Direction | Message | When |
|---|---|---|
| hub → client | `{"type":"hello","cursor":7,"hosts":{"<host-id>":{"seq":12}}}` | on connect |
| hub → client | `{"type":"changed","cursor":8,"host":"<host-id>","seq":13,"web":false}` | a host's manifest moved |
| client → hub | `{"type":"changed","host":"<host-id>","seq":13}` | a machine wrote its manifest (owner + machine only; `host` a lowercase UUID v4; `seq` a positive integer) |
| client → hub | `ping` (text) | keep-alive every 30 s; answered `pong` without waking the hub |
| Worker → hub | `POST https://hub/notify` `{"host","seq","web":true}` | after a web-host write or delete succeeds (best effort: a failed notify never fails the write) |

A `changed` is broadcast to every socket except its sender. `hosts[h].seq` only moves forward. A reader learns
nothing it could not already read: host ids and sequence numbers of a folder it may read.

**Clients treat the hub as a hint.** The truth is still the manifests in the bucket: a `changed` only says "read
now"; a client that missed one catches up from `hello` (any host whose seq differs from what it holds) or from the
fallback poll.

## 4. Options weighed

| Option | Each way | Online only / local + online / multi-machine | Offline | Cloudflare $/mo at Zach's scale | Effort | Risk | Folder is the database |
|---|---|---|---|---|---|---|---|
| (a) tune polling: 0.5 s rounds, discover every round, SSE-less page poll at 1 s | 0.3–1.5 s | yes / yes / yes | unchanged | grows with devices × hosts × 1/interval: ~$10 at 2 s, ~$95 team; worse at 0.5 s | low | cost and CPU scale the wrong way | yes |
| **(b) watcher + DO hub (this PEP)** | **0.1–0.4 s** | **yes / yes / yes** | **unchanged; catch-up on reconnect** | **$0 (inside Workers Paid)** | **medium** | **WebSocket through app mounts; hub is a hint only** | **yes** |
| (c) R2 event notifications → Queue → DO | seconds (Queue batching ≥ 1–5 s, latency unpublished) | yes / yes / yes | unchanged | $0–1 | medium | slower than (b); no local stand-in | yes |
| (d) replace rclone with a native protocol | (b) + ~50 ms less per round | yes / yes / yes | must be rebuilt | $0 | high | rewrites the tested engine | yes |
| (e) off-the-shelf engine (Syncthing, Replicache, Electric, PowerSync) | sub-second | Syncthing: no web/online copy; the others: a database, not files | varies | $0–49+ | high | a second source of truth | no (except Syncthing) |

(b) keeps (c) as an optional safety net later (a write that bypassed folder-sync would still announce itself), and
(d) as an optimisation once the timers are gone: a native S3 GET/PUT instead of an rclone process saves ~50 ms per
step and the idle scan's process.

## 4b. Measured: the prototype against the same build polling (2026-10-26)

Same code on both sides, local stack, 2 machines + a page, 10 trials each way at random phases
(`tools/sync_bench.py` in robotparts lane/fast-sync). "Polling" is `sync --watch --no-push` (2 s) and the page without
WebSocket (10 s re-read): exactly the pre-PEP behaviour.

| Path (mean) | Polling | Push | |
|---|---|---|---|
| page write → laptop disk | 1.01 s | **0.28 s** | 3.6x |
| page write → desktop disk | 1.09 s | **0.29 s** | 3.8x |
| laptop disk → served at `/fs/` | 1.21 s | **0.60 s** | 2x |
| laptop disk → the open page | 6.20 s | **0.75 s** | 8x |
| laptop disk → desktop disk | 2.80 s | **0.63 s** | 4.4x |
| a new machine joins → laptop has its file | 144 s | **0.16 s** | 900x |
| browser → browser, no machine running | ~5 s (10 s poll) | **0.92 s** | |
| idle, per machine, 60 s | 29 rounds, 29 rclone runs, 3.3 % of a core | **1 round, 1 rclone run, 0.1 %** | 33x |

What is left in the push numbers is work, not waiting: the 100 ms debounce, a round's three rclone processes
(~55 ms each), the web host's PUT (~130 ms, its Durable Object), and the page's bundle read (~190 ms) + render
(~120 ms). The next cut is (d): native S3 calls instead of rclone processes, and pulling only the named host.

## 5. Revisit when

- Many hosts per folder make a full round per `changed` wasteful: pull only the named host.
- Durable Objects pricing changes the 20:1 incoming-message ratio or hibernation billing.
- Two-way `shared/` folders land: the same hub carries their lease.
