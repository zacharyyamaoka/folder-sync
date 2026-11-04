# 0009 · History that costs what changed: a pointer for an append, one version per 5 minutes, zstd for the rest

- **Date:** 2026-11-04
- **Status:** Draft, 2026-11-04, on `lane/peps-0009-0010` (cut from `claude/folder-sync-v0` at 6e1baf3). Nothing is
  built. Until Zach accepts it, PEP 0007 and `docs/CONTRACT.md` stand as written.
- **Amends:** PEP 0007 §3.1 (what a kept version's object may be), §3.2 (the write-time rule and the pruner) and §3.5
  (what history costs); `docs/CONTRACT.md` "Bucket layout", "Deletions and history" and "What is kept". The rest of
  PEP 0007 stands.
- **Source:** Zach:
  1. 2026-10-29: "how do we do this more efficently, how does obsidan do it? I guess for markdown files mabye it does
     diffs? ... I think this is like a new KPI which is like storage efficiency and certaintly right now this doesn't
     seem efficeint at all."
  2. 2026-10-29: "Why do we have so much trash in there? ... find the best practices for dealing with these trash
     things."
  3. 2026-11-04, `PROJECT - Folder Sync`, "What do we want?": "Version history — Up to X days back (30 by default?) —
     Version control timestamps, every X min? (5 by default)".
  4. 2026-11-04, same note: "[[C - Write Amplification]] — Great lets use this to measure memory efficiecy".
- **Research behind it:** the vault note `folder-sync — Trash, Version History and Storage Efficiency (2026-10-29)`
  [1], its two research lanes and experiments [2–4], and this PEP's 30-day replay [5]. All the evidence is in the
  gitignored `reports/media/storage-history-2026-10-29/`.
- **Builds on:** PEP 0003 §3.7 (the quota), PEP 0004 (`object_etag`), PEP 0005 §4 (native S3 calls, named there as the
  next speed-up), PEP 0007 (path-first `_history/`, the schedule, the pruner).

## 0. The decisions on one screen

1. **An append keeps a pointer, not a copy.** When the new bytes start with the old version (the sha256 of their
   first `old.size` bytes is `old.sha256`), the old version becomes an object of about 125 B,
   `<version>.<size>.prefix`. Its bytes are the start of the path's next full object: the next keyframe in history, or
   the live file. Restoring it is one Range GET and a hash check.
2. **A pointer only ever rests on bytes the engine itself uploaded.** An append of up to 64 MiB is uploaded with one
   native PUT of the very bytes it hashed, never re-read by rclone. WHY: the engine hashes a file and then rclone
   reads it again, so a rewrite in between would strand a pointer and lose a version that PEP 0007's full copy keeps
   (§1.4).
3. **At most one version per path per 5 minutes** (Zach's default). It is PEP 0007's burst rule with 30 s raised to
   5 min, set per folder by `history_every`. Deletes and restores are still always kept, and so is one new case: any
   change to a path whose newest kept version is a pointer, unless the engine uploads the new bytes itself.
4. **Everything else is a zstd keyframe,** `<version>.<size>.zst`. The engine makes the compressed copy while it
   hashes a version, so a keyframe is one PUT and nothing is downloaded. Without that copy, it is today's plain
   CopyObject. The encoder is klauspost/compress at its default level, about zstd 3.
5. **The pruner keeps an anchor while a pointer rests on it.** It deletes pointers before anchors, and deletes and
   reports a pointer whose anchor has gone.
6. **The engine writes change records compact,** as the web host already does: 25% smaller. At the recorded round
   rate they are now as large a share of H as the versions themselves (§8).
7. **The KPIs.**
   - **H** = history bytes ÷ live bytes, per person, from `GET /fs/v1/usage`, taken as the 30-day max of hourly
     samples: ≤ 1.0, stretch ≤ 0.25. It is reported in two parts, versions and records.
   - **A** = history bytes written ÷ bytes changed, on three fixed CI workloads. The append workload is gated at
     ≤ 0.1.
8. **The real Oct 28 replay passes, with less room than the vault note said.** Replayed as a 30-day steady state
   instead of one day, it sits at H 0.47–0.90 with all of the above: under 1.0, over 0.25. Pointers and the throttle
   without zstd sit at 1.8–6.5, so zstd is required, not a stretch.
9. **Legacy `_trash/`: nothing new is built.** v0's pruner deletes it 30 days after each stamp. Until then the choice
   is Zach's: empty it now (irreversible), or let it age out (§10).
10. **Not done:** deltas (`zstd --patch-from`), chunk stores, a compressor inside the Worker, and folding records.
11. **This is a durable decision about the bucket contract:** the `.zst` and `.prefix` objects, the anchor rule and
    the 5-minute rule. A later rewrite must not quietly re-decide it; this PEP is its record.

## 1. The frame: what the ask assumes, and what is true here

1. **"The trash is the problem" is right, and it is now urgent.**
   - On Oct 29 the account held 949 MiB of replaced versions against 108 MiB of files [1].
   - By Nov 4 it held 10.1 GiB against 148 MiB, which is H ≈ 70. It is over Zach's 10 GiB ceiling, and `zach` and
     `vibetracks` stopped syncing at about 04:15 [6].
   - Both figures come from the Oct 25 binary, which keeps every replaced file whole and never prunes. Installing v0
     stops the growth. This PEP decides what v0 should keep.
2. **The KPI is a 30-day max, and the vault note measured one day.** Its replay sampled H at the first day's peak
   [3]. Over 30 days, more piles up:
   - the hourly and daily survivors of every rewritten file: up to 23 + 29 versions per path under PEP 0007's
     schedule, on top of the last hour's;
   - Vibe Tracks keeps rewriting old day logs. `events/<host>/2026-10-25.jsonl` changed on Oct 30, with lines out of
     order 18% of the way into the file, so it was rewritten, not appended to [7].

   Replayed as 30 days (§9), pointers and the throttle alone stay at H 1.8–6.5. zstd is what passes.
3. **Change records are history too, in the quota and in H, and nothing in the brief touches them.**
   `GET /fs/v1/usage` counts `_changes/` as history [8]. At the recorded rate of 761 manifest versions a day, the
   engine's indented records come to 1.66 MiB a day. That is 0.46 of H at 30 days, about as much as all the kept
   versions after this PEP (0.13–0.55). They grow with the number of rounds, not with the number of kept versions.
4. **A pointer is only as safe as the bytes it points into.**
   - The engine hashes a changed file, then rclone reads it again to upload it (`round.go` `Push`) [9]. PEP 0004's
     review found the same gap for `object_etag`.
   - If the file is rewritten in between, the stored object need not start with the old version. With PEP 0007's
     full copy, the old version is safe in `_history/`. With a pointer, it is gone.
   - The same is true when the throttle drops a version that open pointers rest on. The vault note's "every pointer
     has a newer full object" holds only for kept versions, and only for bytes the engine controls.
5. **"Every 5 min" sets how fine history is, not how fast sync is.**
   - The live file still syncs at once, so KPI 1 does not move.
   - Only the versions kept for undo thin to one per 5 minutes. Inside 5 minutes of churn, the in-between versions
     go.

## 2. Weights

These are adapted from the vault note §5 [1], with "nothing lost" first, as in PEP 0007 §2.

| Criterion | Weight | How it is scored |
|---|---|---|
| Nothing lost: every kept version restores byte-identical from the bucket alone | 25 | a race or a prune that can lose a kept version scores ≤ 15 |
| Storage efficiency: H on the 30-day replay (§9), old day logs rewritten daily | 25 | 25 at ≤ 0.25, 18 at ≤ 1.0, 8 at about 2, 0 at ≥ 8 |
| Plain files: readable keys, any S3 tool, `rclone copy` as the way out | 15 | |
| Small change to reviewed code; stock parts first | 15 | |
| Restore and prune stay simple: one GET to restore, one rule per object | 10 | |
| Engine cost: CPU, RAM, requests and latency per round (KPI 1 must not move) | 10 | |

**The gate:** H ≤ 1.0 on the 30-day replay. An option that fails it is out, whatever it scores.

## 3. What one kept version costs

The 30-day H columns come from `replay30.py` (§9). The first number has old day logs rewritten every day, as their
mtimes say they are; the second has them rewritten once.

| Option | 30-day H | Lost (25) | Eff (25) | Plain (15) | Small (15) | Simple (10) | Engine (10) | Score | Gate |
|---|---|---|---|---|---|---|---|---|---|
| A. v0 as merged: the 30 s burst rule, full copies | 16.9 · 12.1 | 25 | 0 | 15 | 15 | 10 | 9 | 74 | fail |
| B. 5 min throttle + zstd copies, no pointers | 1.24 · 0.81 | 25 | 15 | 13 | 11 | 10 | 8 | 82 | **fail** |
| C. Pointers + 5 min throttle, full copies (the vault note's "D") | 6.5 · 1.8 | 23 | 1 | 14 | 11 | 8 | 9 | 66 | fail |
| **D. Pointers + 5 min throttle + zstd keyframes (this PEP)** | **0.90 · 0.47** | 23 | 18 | 12 | 8 | 8 | 8 | **77** | **pass** |
| E. D + `zstd --patch-from` deltas against the hour's keyframe | not replayed at 30 days (one day: 0.03) | 21 | 21 | 7 | 5 | 4 | 6 | 64 | pass |
| F. Our own content-defined chunk store, 4–16 KiB | not replayed | 15 | 20 | 2 | 3 | 3 | 7 | 50 | — |
| G. restic or kopia as the history backend | not replayed | 18 | 10 | 2 | 5 | 7 | 6 | 48 | — |

**Chosen: D.**
- **B scores higher but fails the gate** when old day logs keep being rewritten, which is what their mtimes show.
  Pointers are what take the appended logs to almost nothing, and so they are the margin.
- **zstd is the other half.** Without it (C), the hourly and daily survivors of every rewritten file are whole copies.
- **E is the next lever** if H is still too high. A delta needs its base, and that brings back chains. F and G need
  reachability garbage collection across hosts, the hardest part of every backup tool. They also break one writer
  per path [2].

## 4. A · Prefix pointers

### 4.1 The check, the upload, the object

- **The check costs no extra read.** `HashFiles` already reads each changed file once, for its sha256 and MD5. While
  it does, it also takes the sha256 of the first `old.size` bytes, where `old` is the path's entry in the last
  manifest. If that equals `old.sha256`, the change is an **append**.
- **An append is uploaded from the bytes that were hashed.**
  - Up to 64 MiB, the engine keeps the bytes it read and uploads them with one native PUT (`internal/s3`). It never
    leaves them to rclone. Its `object_etag` is the PUT's ETag, recorded once it matches the buffer's MD5 (PEP
    0004's rule).
  - At most 256 MiB is held in one round. An append past either limit goes through rclone, and its old version is
    kept as a keyframe, as today (the pin, §4.3, covers the pointers before it).
  - Rewrites, new files and everything else still go through rclone.
  - WHY: then every byte a pointer rests on was written by the engine from the bytes it checked (§1.4). It is also
    PEP 0005 §4's native-call speed-up for hot appended logs: one process fewer per round.
- **The object.** If the schedule keeps the old version, the engine writes
  `<root>_history/<project>/<host>/<path>/<version>.<size>.prefix`, created once (`If-None-Match: *` [18]), with the body
  `{"schema":"folder-sync-prefix/1","size":<n>,"sha256":"<64 hex>"}` (about 125 B).
  - `<version>` is PEP 0007's version id, unchanged.
  - `<size>` is that version's own size, in decimal. A listing then shows each version's real size without a GET,
    and the view shows true sizes.
- **Where a pointer's bytes are:** the first `size` bytes of the oldest full object of that path newer than the
  pointer, in version order. That object is a keyframe (`.zst` or plain), an `_unlisted` copy, or, when there is none,
  the live file.

### 4.2 Keeping those bytes safe: the options

The weights here are nothing lost when the file is rewritten between the hash and the upload (40), storage (25),
small change (20) and latency (15).

| Option | Lost (40) | Storage (25) | Small (20) | Latency (15) | Score |
|---|---|---|---|---|---|
| (a) The vault design: pointers rest on the live file, uploaded by rclone as today | 10: that race loses kept versions | 25 | 20 | 12 | 67 |
| (b) The newest kept version of an appended file stays whole; older ones become pointers once a newer whole copy proves them | 40 | 18: one compressed copy per appended file, about +0.08 of H for the replay's day logs (estimated) | 12: per-path chain state and a demote step | 12 | 82 |
| (c) A safety copy of the live file before every upload of an appended file, deleted once the upload is proven | 40 | 25 | 16 | 4: a server-side copy of the whole log on every round | 85 |
| **(d) Pointers rest on the live file, and an append is uploaded with one native PUT of the hashed bytes** | 40 | 25 | 12: a second upload path, for appends only | 15: one process fewer per round | **92** |

**Chosen: (d).** It is engine-internal: readers resolve a pointer the same way under (b), (c) and (d). So if the
native PUT path ever proves troublesome, (b) replaces it without a contract change.

### 4.3 The pin, and restore

- **The pin:** while the newest version this writer kept of a path is a pointer, a version that leaves is kept as a
  keyframe, whatever the throttle says, unless its replacement is an append the writer uploads itself.
  - WHY: those pointers rest on the live file. A rewrite, or an append rclone uploads, could replace it with bytes
    that do not start with them. The vault note's "anything else becomes a keyframe" holds only when the schedule
    keeps it.
  - The writer knows the answer without a listing. `history.json` records the kind of the last version kept.
  - The throttle only drops a version when one was kept within the last 5 minutes, and `history.json` keeps the
    last kept version for an hour, so the record is there whenever it matters. That hour becomes
    `max(1 h, history_every)`.
  - With no record at all (lost state), nothing is dropped, as today.
- **Restore** lists the path's versions, one LIST as today. For a `.prefix`:
  - Range GET `bytes=0-(size−1)` of the anchor. When the anchor is the live file, the GET carries `If-Match` on its
    `object_etag`.
  - For a `.zst` anchor, stream-decompress the first `size` bytes instead.
  - Check the bytes against the pointer's sha256, and against the `sha16` in its name.
  - It is one GET. If a live anchor fails the check (it was rewritten after the listing, so the pin made a newer
    keyframe), list again once.
- **The web host,** and PEP 0010's shared tree, hold the bytes they write, so they make the same check on those
  bytes. They write the pointer after the manifest has taken the change, in place of the undo copy PEP 0003 §3.4
  makes. If a writer is cut off in between, its journal finishes the change. Until it does, readers that find both
  forms of one version use the whole one.

## 5. B · One version per 5 minutes

**When a version leaves** (at time `t`, its manifest entry written at `w`), it is kept unless the first rule that
matches says not. The changes from `docs/CONTRACT.md` "What is kept" are in bold.

1. Its path matches `no_history`: **not kept**.
2. It is deleted, or replaced by a restore: **kept**.
3. **The newest version this writer kept of the path is a pointer, and the new bytes are not an append the writer
   uploads itself: kept** (the pin, §4.3).
4. It lived **`every`** or longer (`t − w ≥ 5 min`): **kept**.
5. This writer kept a version of this path that left after **`t − 5 min`** (strictly): **not kept** (`why: burst`, the
   existing code).
6. Otherwise: **kept**.

- **The setting.** `every` is `history_every` in `.folder-sync.toml`: default `"5m"`, at least `"30s"`. The web host
  uses 5 min.
  - WHY it can vary per machine: each writer applies it only to its own host, so two machines with different values
    never disagree about a key.
  - `keep_days` stays 30 for everyone. The folder's object prunes every host by one rule, so a per-folder value
    needs a folder setting on the server (§13).
- **The worst case per path** over 30 days falls from about 120 + 24 + 30 versions to about 12 + 23 + 29. On the
  replay, copy requests (Class A [19]) fall from 2,361 a day to 682 [3].
- **What it costs in undo:** the in-between versions of 5 minutes of churn. The live file, the version a restore
  replaces and the last version of a deleted file are always there.

## 6. C · zstd keyframes

**Where the compressed bytes come from.** Keyframes are made before the upload, so this decides the latency of a
round that keeps an edit. One edit after a quiet spell is exactly such a round: its old version is always kept. (The
latency bench writes new files, so it cannot see this; PEP 0007 §9 asked it for an edit trial.)

| Option | Lost (25) | KPI 1 (25) | Small (20) | Engine (15) | Plain (15) | Score |
|---|---|---|---|---|---|---|
| Z1. GET the old object when it leaves, compress it, PUT it | 25 | 12: a download before every kept edit's upload | 16 | 9: the download | 13 | 75 |
| **Z2. Compress each version as it is hashed (a local copy); PUT that copy when the version leaves** | 25 | 25: one PUT where CopyObject was | 12: a folder of copies and its cleanup | 11: CPU when a version is published; disk ≈ compressed live | 13 | **86** |
| Z3. CopyObject now, and compress after the round | 23: two copies for a moment | 25 | 9: a deferred job, its state, three more requests | 8 | 8: `LastModified` would no longer be when it left | 73 |
| Z4. Compress in the Worker | — | — | — | — | — | n/a: Workers have no stock zstd encoder; the one WASM package is an alpha [10,11] |

**Chosen: Z2.**

- **The local copy.** The same read that hashes a changed file of up to 64 MiB also feeds a zstd encoder
  (klauspost/compress, `SpeedDefault`, about zstd level 3, window at most 8 MiB) [12].
  - If the result is under 90% of the file's size, the engine keeps it as
    `~/.folder-sync/projects/<key>/shadow/<sha256>.zst`.
  - When that version later leaves as a keyframe, the engine PUTs the copy as `<version>.<size>.zst`
    (`If-None-Match: *`) instead of the CopyObject.
  - With no copy (a new machine, a big or incompressible file), it does the plain CopyObject of today.
  - A copy is deleted when its version leaves, and a reconcile deletes any that no version needs.
- **WHY it keeps the listed version exactly.** The copy is made from the bytes whose sha256 the manifest lists, so the
  keyframe is that version even when the upload raced. PEP 0007's CopyObject copies whatever is live, and needs
  `_unlisted` for that case.
- **What it costs.**
  - Disk: about the compressed size of the folder's compressible files, for example 7 MiB for `zach`'s 75 MiB of
    JSON.
  - CPU: one zstd pass per published version. The zstd CLI took 11 ms per 4 MB at level 3 [2]. klauspost's Go
    encoder was not measured here.
- **The object** is one zstd frame (RFC 8878) of exactly the version's bytes [13]. It is plain enough: `zstd -d`
  reads it, and the name says what it is and how big it opens.
- **Readers that decode it:**
  - the engine and `folder-sync serve`, with klauspost's decoder;
  - the Worker, with fzstd (MIT, 8 kB, streaming), vendored like jsdiff [14]. Workers' `DecompressionStream` lists
    gzip and deflate, not zstd [10]. fzstd's 32 MiB window limit is why the encoder's window stops at 8 MiB.
  - Python 3.14's standard `compression.zstd` [15], and the `zstd` CLI.
- **The web host,** and PEP 0010's shared tree, keep plain keyframes for now. Web writes are few, and the Worker has
  no encoder (§15).

## 7. D · The pruner

1. **The schedule is unchanged** (PEP 0007 §3.2). It applies to version ids, whatever their form.
2. **Anchors.**
   - A keyframe that a kept pointer rests on stays, even when the schedule would drop it. It goes when its last
     pointer goes.
   - A pointer is always older than its anchor, so this costs at most one keyframe per kept pointer. Usually the
     anchor is kept anyway, as the newest of its hour or day.
   - A live anchor needs nothing: it is the file.
3. **Order:** in every batch, pointers are deleted before the keyframes they rest on. So a prune cut off halfway
   never strands a pointer.
4. **Dangling pointers.** A pointer with no full object newer than it, and no live file, is deleted and reported as a
   new event, `history_lost` (warn), which KPI 2 counts. Its bytes were already gone. It happens after:
   - an over-quota delete job (PEP 0003 §3.7, permanent by design);
   - a purge;
   - an object deleted outside folder-sync.

   The folder's object reads each host's manifest to know which paths are live (one GET per host).
5. **Purging** a keyframe ("I synced a secret") also purges the pointers that rest on it. "Free up space" (history
   older than N days) needs nothing new, since an anchor is always newer than its pointers.
6. **The pruner still runs daily.** Pruning every hour lowers the 30-day H by only 0.04 on the replay (0.90 to 0.86),
   for 24 times the listings.
7. **Old pruners leave the new objects alone.** Both skip any name they cannot parse as a version (`prune.ts`: "not a
   version: never this pruner's to delete"; Go's `ParseKey` fails the same way). So a machine on an older engine can
   never delete one.

## 8. E · Change records

- **What they cost:** one record per manifest version. The engine writes them with `json.MarshalIndent`
  (`project.go` `writeJSON`); the web host writes compact JSON (`webhost.ts` `recordBody`).
  - The contract's own fixture is 3,267 B indented and 2,444 B compact.
  - At the replay's 761 manifest versions a day, that is 1.66 MiB a day as written today: 0.46 of H at 30 days.
- **Decision:** the engine writes them compact. That saves 25%, with no contract change, since JSON readers ignore
  whitespace.
- **The levers left, in order:**
  1. **Keep records 14 days, like the local log, instead of 30.** On the replay that takes H from 0.90 to 0.71 (old
     day logs rewritten daily), or from 0.47 to 0.29 (rewritten once). It is a contract constant, so it is Zach's
     call (§13).
  2. **Drop the fields each event repeats from its record** (project, host, host_name). The schema requires them,
     so this is a schema change.
  3. **Folding records,** cut by PEP 0007 §13.
- **Records follow the round rate.** Vibe Tracks runs `folder-sync sync --once` from its tick
  (`vibetracks/core/sync.py`; the tick is 10 s) [16], which gave 761 rounds a day on Oct 28.
  - A folder under `sync --watch` gets a round for every write. On Oct 28 the event log grew about 10 lines a minute,
    so a watched copy of it would make about 10 times the records.
  - It would also make about 10 times the live uploads of a 2–3 MB file.
  - That bound belongs to the live path (sending a file that keeps changing at most every N seconds), not to history
    (§15).

## 9. F · The KPIs: H in production, A in CI

### 9.1 H, storage efficiency

- **Definition:** for one person, `usage.history.bytes ÷ (usage.bytes − usage.history.bytes)`. `GET /fs/v1/usage`
  already gives it, counting `_history/`, `_changes/`, `_requests/` and legacy `_trash/` as history [8].
  - It is reported in two parts: versions (`_history/` and `_trash/`) and records (`_changes/` and `_requests/`).
    `measureRoot` already sorts every object by its top-level prefix, so the split costs nothing extra.
- **How it is measured:** the folder-sync producer in `~/vt/zach/producers/folder-sync/` samples it every hour and
  records the daily max and the 30-day max. WHY hourly: the peak is just before the prune, whenever the folder's alarm
  runs.
- **Targets:** 30-day max ≤ 1.0, stretch ≤ 0.25. Today: 8.8 on Oct 29, about 70 on Nov 4 [1,6].
- **Its guard is KPI 2, "nothing lost".** Keeping nothing scores H = 0, so H counts only while the restore check
  stays green. Once a week, the check restores 20 random kept versions per folder, pointers and `.zst` included, and
  compares their sha256 [20].

### 9.2 The replay

`python3 -I replay30.py listing.tsv` [5] repeats the real Oct 28 day for 45 days. It runs PEP 0007's schedule once a
day, with this PEP's rules, and samples H just before each prune. It holds live bytes at 108 MiB, which overstates H.
Its assumptions are in its docstring:
- the same append classification as `replay.py`;
- a pointer is 200 B;
- zstd shrinks a keyframe 11.1 times;
- records are 250 B plus 650 B per event, ×0.75 when compact.

| Policy | Day 1, versions | 30-day max: versions | records | **total** |
|---|---|---|---|---|
| v0 as merged (30 s rule, full copies, indented records) | 8.49 | 16.42 · 11.67 | 0.46 | 16.88 · 12.13 |
| C. Pointers + 5 min, full copies | 0.65 | 6.14 · 1.41 | 0.35 | 6.48 · 1.76 |
| B. 5 min + zstd, no pointers | 0.19 | 0.90 · 0.47 | 0.35 | 1.24 · 0.81 |
| D, with records as written today | 0.06 | 0.55 · 0.13 | 0.46 | 1.01 · 0.59 |
| **D. This PEP** | **0.06** | **0.55 · 0.13** | **0.35** | **0.90 · 0.47** |
| D, records kept 14 days | 0.06 | 0.55 · 0.13 | 0.16 | 0.71 · 0.29 |
| D, pruned every hour | 0.06 | 0.51 · 0.08 | 0.35 | 0.86 · 0.43 |

- The two numbers in a cell are old day logs rewritten daily · rewritten once.
- **Day 1** is the vault note's metric. `replay.py` reports 8.7 for v0, 0.77 for C and 0.07 for D, a little higher
  because it counts the whole 27-hour window.
- **The gate holds:** this PEP is at 0.90 or below. The stretch needs records kept 14 days and an end to the daily
  rewrites of old day logs.

### 9.3 A, write amplification (CI)

`A = bytes written into _history/ ÷ bytes changed`. For an append, the bytes changed are the tail. Three generators are
frozen in `testdata/efficiency/` with seeds. They run against the e2e stand-in on a fake clock, and the bytes come from
the stand-in's listing, not from the engine's own count.

| Fixture | Workload | Gate | Expected under this PEP | v0 (estimated) |
|---|---|---|---|---|
| append | a 4 MiB JSONL of synthetic, seeded event-shaped lines, plus about 1.2 KB every 2 s for an hour (1,800 rounds) | **A ≤ 0.1** | about 0.001 (12 pointers) | about 240 (120 whole copies) |
| markdown | PEP 0007's text (67 KB), 100 small mid-file edits a minute apart | report only | about 135 (20 zstd keyframes) | about 1,700 |
| rewrite | a 270 KB JSON whose four rolling counters change every minute for an hour (Vibe Tracks' bundle) | report only | about 200 (12 zstd keyframes) | about 11,000 |

- The gate is tested red first: the append fixture must fail on today's code.
- The engine's lane never edits these fixtures. If it cannot pass one, it reports it.
- The markdown and rewrite rows stay high until deltas, which is option E's revisit.

## 10. G · Legacy `_trash/`

The weights here are nothing lost (30), back under quota soon (25), small build (20), reversible (15) and doing one
thing (10).

| Option | Lost (30) | Under quota (25) | Build (20) | Reversible (15) | One thing (10) | Score |
|---|---|---|---|---|---|---|
| **(a) As PEP 0007 accepted: the pruner deletes it 30 days after each stamp** | 30 | 5: the account stays over until it ages out, unless the ceiling rises | 20 | 15 | 10 | **80** |
| (b) "Empty old trash": the Storage view's owner action, any age, permanent [17] | 22: 75% of it is the start of files that still exist; the rest is old computed bundles | 25 | 18: built on `lane/storage-view` | 0 | 10 | 75 |
| (c) Adopt it: turn each trash object that is a prefix of a live file into a pointer | 28 | 18: frees about 75% at once | 6: a one-off command | 15 | 3 | 70 |
| (d) Move it all into `_history/` as keyframes | 30 | 0: frees nothing | 4 | 15 | 2 | 51 |

**Chosen: (a).** No new code.
- **(b) is one click and irreversible, so it is Zach's word only** (§13). It frees the whole 10.1 GiB at once.
- **(c) is worth knowing and not worth building.**
  - It needs no download: a single-part object's ETag is its MD5 (S3's rule; not checked on R2's copies), and the
    owning machine can hash the first `size` bytes of its live file in one pass.
  - But it is a one-off, of the kind PEP 0007 §13 cut, for versions that expire within 30 days anyway.
- **The order that gets `zach` and `vibetracks` syncing again:**
  1. install v0, so no new `_trash/` is written;
  2. empty the trash (b), or raise the ceiling until the pruner expires it, around 30 days after the last old-binary
     stamp.

  Raising the ceiling is a reversible `QUOTA_BY_OWNER` edit and deploy, and it is Zach's.

## 11. Build plan

**B0, the contract, lands alone first.** These are its files:
- `docs/CONTRACT.md`:
  - "Bucket layout": `<version>`, `<version>.<size>.zst` or `<version>.<size>.prefix`;
  - "Deletions and history": anchors, and how each form restores;
  - "What is kept": 5 min, `every`, the pin, and the new worked examples;
- `schema/history.schema.json`: the object-name pattern and the prefix body;
- `schema/event.schema.json`: `history_lost`;
- `testdata/history/keys.json`: the new forms;
- `testdata/retention/schedule.json`, with new cases:
  - the 5-minute edge;
  - a rewrite after a pointer, inside the window;
  - an anchor kept past its tier;
  - pointer-before-anchor order;
  - a dangling pointer;
- `testdata/efficiency/`: the three generators and their bounds (§9.3).

No lane edits these. A lane that cannot pass a fixture reports it.

| Lane | Write set | Proves |
|---|---|---|
| `lane/history-engine` | `internal/syncer/{round,history,project}.go`: the prefix hash and zstd copy in `HashFiles`; a native PUT for appends; `keepVersion` writes a pointer, a `.zst` from the copy, or the CopyObject fallback; the pin; `Prune` with anchors, order and dangling pointers; restore of each form; compact records. Also `internal/history/**` (`Keep` at 5 min, name parsing), `internal/config/**` (`history_every`), `e2e/history_test.go`, `scripts/check-r2` | every B0 fixture; append A ≤ 0.1 on the stand-in; a restore of each form byte-identical; against real R2: a Range GET with `If-Match`, and that a native PUT's ETag is its MD5 |
| `lane/history-worker` | `accounts/src/{history,prune,webhost}.ts` (5 min, the pin, web-host pointers, anchors, order, dangling pointers), the history and download routes (decode `.zst` with a vendored fzstd, resolve `.prefix`), `accounts/test/**` | the same fixtures in TypeScript; a `.zst` and a `.prefix` version served byte-identical |
| `lane/history-kpi` | the folder-sync producer (hourly `GET /fs/v1/usage`, H's daily and 30-day max, the split, the weekly restore check of §9.1), `.github/workflows` lines for the A fixtures | H on the track; A in CI, red on today's code |

- The paths are those at 6e1baf3. `lane/parts` is renaming the repo's parts, so a lane cut after it uses its names.
- The two code lanes have disjoint write sets and start together after B0.
- `lane/history-kpi` follows them.
- The CI workflow line waits for `lane/parts`, which is renaming CI now.
- Deploys stay Zach's.

## 12. What does not change

- path-first `_history/` and the version id;
- one writer per host;
- the schedule's tiers and 30 days;
- the fail-closed quota (PEP 0007 §3.5);
- the `no_history` default, `["*.log"]` (Zach's, PEP 0007 §10.6; see §13);
- the change record's schema;
- the restore request and its outcome;
- PEP 0005's hub;
- the view API's shapes (a version's `size` is now true for every form).

## 13. Open questions for Zach

Each one has a recommendation, and the default that holds if he says nothing.

1. **Legacy `_trash/` (10.1 GiB on Nov 4).**
   - **Recommendation:** install v0, then empty it. It is old copies of files that still exist, plus recomputable
     bundles.
   - **Default:** nothing is deleted. The pruner removes it 30 days after its stamps, and the two folders stay
     stopped until then unless he raises his own ceiling.
2. **How long change records stay online.**
   - **Recommendation:** 14 days, like the local log. Version history stays 30 days either way.
   - **Default:** 30 days, unchanged. If production H passes 0.5, this is the first lever.
3. **"Every X min" and "up to X days" as settings.**
   - **Default:** `history_every` per folder in `.folder-sync.toml`, 5 min by default.
   - `keep_days` stays 30 for everyone until folder settings live on the server, where the folder's object can read
     them.
4. **`no_history = ["*.log"]`.** Its reason was "an appended log copied whole on every round"; with pointers, a kept
   version of an appended log costs about 125 B.
   - **Recommendation:** drop it, so logs get undo too.
   - **Default:** keep it, since it was his decision on Oct 28.

## 14. Evidence

### What was checked

- **The code,** on `claude/folder-sync-v0` at 6e1baf3:
  - `internal/history/history.go` (`Burst` 30 s, `Keep`, `Prune`);
  - `internal/syncer/history.go` (`keepLeaving`, `keepVersion`, the 1-hour `keptFor`, the own-host `Prune`);
  - `internal/syncer/round.go` (`Push`: `HashFiles`, then `keepLeaving`, then `rclone copy`, then
    `recordObjectETags`);
  - `internal/syncer/project.go` (`writeJSON` indents);
  - `accounts/src/{prune,webhost,quota}.ts`. Both pruners skip names `parseVersion` does not know. The web host makes
    an undo copy on every write and writes compact records. Usage counts `_changes/` as history.
- **The 30-day replay,** run on 2026-11-04: `replay30.py` and `replay30.json` beside `replay.py` [5].
- **The round rate and the append rate,** from the listing: 761 manifest versions a day, and the event log growing
  179 KiB an hour, about 600 lines.
- **How Vibe Tracks runs sync:** `sync --once` per pass, with a 10 s tick [16]. Old day logs keep changing
  (`2026-10-25.jsonl` on Oct 30, `2026-10-14` to `-16` on Oct 31), with out-of-order lines mid-file [7].
- **Vendor documentation** for every library and limit in this PEP (Sources).

### What was not verified

- klauspost's encoder speed on this machine. The CPU figure is the zstd CLI's.
- R2's answers to a native PUT (that the ETag is the MD5) and to a Range GET with `If-Match`. PEP 0004 relies on the
  second, and `scripts/check-r2` is where both get checked.
- That Workers' `DecompressionStream` really lacks zstd at runtime. The claim rests on the typings [10].
- The replay's assumptions:
  - the appended paths are classified by name;
  - zstd shrinks every keyframe 11.1 times, as measured on two real files;
  - the record sizes come from one fixture;
  - live bytes are held constant.
- The tenfold rise in records under `--watch`. It is an estimate from the log's growth, not a measurement.

## 15. Revisit when

- **H in production passes 0.5:** keep records 14 days (§13), then add deltas for rewritten files (option E).
- **A folder runs `--watch` with a file appended every few seconds:** limit how often a file that keeps changing is
  sent on the live path. That is its own PEP, trading KPI 1 against KPI 3.
- **Appended files over 64 MiB show up in H:** keep the newest kept version whole for them (§4.2 (b)).
- **Workers get a stock zstd encoder:** compress the web host's and the shared tree's keyframes.
- **R2 ships object versioning:** PEP 0007's revisit.

## Sources

Web sources accessed 2026-11-04 unless marked.

1. Vault: `folder-sync — Trash, Version History and Storage Efficiency (2026-10-29)` (Sources/Notes): the listing, the
   products and techniques research, options A–H, H and A
2. `reports/media/storage-history-2026-10-29/research-techniques.md`, `exp.py`, `exp_md.py`, `results-N300.json`,
   `results-md.json`: zstd -3 at 11 ms per 4 MB; 11.35× on JSONL, 2.5× on Markdown; restic, CDC, git, `--patch-from`
3. `reports/media/storage-history-2026-10-29/replay.py` and `replay.json`: the one-day replay (8.66 → 0.77 → 0.07)
4. `reports/media/storage-history-2026-10-29/research-products.md` and `measurements-bundle.txt`: Obsidian, Dropbox,
   Nextcloud (2 min), Obsidian File Recovery (5 min), Syncthing; zstd 11.1× on the live bundle
5. `reports/media/storage-history-2026-10-29/replay30.py` and `replay30.json`: this PEP's 30-day replay, 2026-11-04
6. Vault: `MOC - Folder Sync` (Nov 4 readings, by the Folder Sync Agent, not re-measured here: 148 MiB live, 10.1
   GiB of history and trash; `zach` and `vibetracks` over quota since about 04:15) and `PROJECT - Folder Sync`
7. `~/vt/zach/events/7c0d68b8-…/`: day-log mtimes, and `2026-10-25.jsonl` (10,035 lines, 63 out-of-order pairs, the
   first 18% in), read 2026-11-04
8. This repository: `accounts/src/quota.ts` (`HISTORY_TOPS`: `_history`, `_changes`, `_requests`, `_trash`)
9. This repository: `internal/syncer/round.go` (`Push`, `recordObjectETags`, with its review note "the file is
   hashed before rclone copies it"), `internal/syncer/{history,project}.go`, `internal/history/history.go`,
   `accounts/src/{history,prune,webhost}.ts`
10. `@cloudflare/workers-types` 4.20251118.0 as rendered by LiveStore: `DecompressionStream` formats "gzip" |
    "deflate" | "deflate-raw" — https://docs.livestore.dev/api/sync-cf/livestore/namespaces/cftypes/classes/decompressionstream/ ;
    MDN, DecompressionStream() — https://developer.mozilla.org/docs/Web/API/DecompressionStream/DecompressionStream
11. `@bokuweb/zstd-wasm` (0.0.21-alpha.5) — https://www.npmjs.com/package/@bokuweb/zstd-wasm
12. `github.com/klauspost/compress/zstd` (v1.20.3, 2026-10-12; `SpeedDefault` ≈ level 3; `WithEncoderDictRaw`;
    streaming `NewReader`) — https://pkg.go.dev/github.com/klauspost/compress/zstd
13. RFC 8878, Zstandard Compression and the application/zstd Media Type — https://www.rfc-editor.org/rfc/rfc8878
    (not re-fetched)
14. fzstd (MIT, 8 kB, streaming, back-references up to 2^25 bytes) — https://github.com/101arrowz/fzstd
15. Python 3.14, `compression.zstd` ("Added in version 3.14"; an optional module) —
    https://docs.python.org/3.14/library/compression.zstd.html
16. Vibe Tracks: `vibetracks/core/sync.py` (`sync --once` per pass), `vibetracks/views/serve.py`
    (`TICK_INTERVAL_S = 10.0`), `vibetracks/core/online.py` (the bundle at most once a minute)
17. Vault: `MOC - Folder Sync`, open question 4 ("wire 'Free up', including an 'Empty old trash' that ignores
    age"), and `lane/storage-view`
18. Cloudflare R2, S3 API compatibility (PutObject conditionals evaluated atomically; CopyObject
    `x-amz-copy-source-if-match`; no `PutBucketVersioning`) — https://developers.cloudflare.com/r2/api/s3/api/
19. Cloudflare R2, Pricing (CopyObject and PutObject are Class A; DeleteObject is free) —
    https://developers.cloudflare.com/r2/pricing/ (via [1])
20. Vault: `C - Write Amplification`, `C - Goodhart's Law`, `C - Hard Gates vs Soft KPIs`
