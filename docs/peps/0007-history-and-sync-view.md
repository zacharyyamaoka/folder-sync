# 0007 · See it and undo it: version history kept in the bucket, one activity log, one sync view every app embeds

- **Date:** 2026-10-28
- **Status:** Accepted 2026-10-28 (Zach: 'Looks good please merge this'). He took every §10 default and asked to
  "finish building all of this", keeping it "super straight forward" and following "the unix philosophy and have
  something that does 1 thing very well". So the contract was frozen with the cuts in §13; where this PEP's body and
  the frozen files below disagree, the files win.
- **Contract (frozen 2026-10-28):** [`docs/CONTRACT.md`](../CONTRACT.md) (history, change records, restore requests,
  the activity log, the retention rule and its worked examples), [`docs/API.md`](../API.md) (the HTTP API of both
  servers and `<folder-sync-status>`), [`schema/`](../../schema/) (`event`, `history`, `changes`, `restore`,
  `view-api`, `retention`) and the shared fixtures in [`testdata/`](../../testdata/), kept in step by
  `node --test schema/fixtures.test.mjs`. The build lanes are §7. Two feasibility spikes are in
  `docs/spikes/0007-*` (§11).
- **Source:** Zach, 2026-10-28:
  1. "update folder sync to create like a view like you have in obsidan where I can click it and it provides an
     overview of all the syncing work ... This is something you can share with any app that is doing folder sync."
  2. "extend folder sync functionality to do version control as well."
  3. "keep this functionality pure and separate from the other websites ... a super simple demo site for folder sync
     that shows it in the most pure form ... the main functionality."
  4. "basically all my software in the future is going to have folder sync as a backend as it truly enables you to use
     local agents ... and file first software design."
  5. KPIs: local → online and online → local latency (built by `lane/latency-kpi`, §9).
- **Builds on:** PEP 0001 (layout, `_trash/`, single writer), 0002 (account roots), 0003 (accounts, `/fs/` on every app,
  the web host, quota), 0004 (`object_etag` in the manifest and revocable devices: `/fs/account`, Range reads;
  `lane/devices`), 0005 (push sync: the folder hub, `lane/fast-sync`), 0006 (the desktop app and its
  `folder-sync-event/1` lines, `lane/desktop`). All of them are merged into `claude/folder-sync-v0` (99560d9).
- **Prior art:** vault notes `C - Fast file sync (prior art)`, `Running AI Agents Unattended Safely (Deep Research,
  2026-10-02)`, `C - 3-2-1 Backup Rule`; Obsidian Sync, Dropbox, Syncthing, restic, git (Sources).

## 0. The decisions on one screen

1. **History lives in the bucket as plain files, path first.** Each replaced or deleted version is copied to
   `<root>_history/<project>/<host>/<path>/<written_at>_<sha16>` before it goes. One LIST gives a file's versions, and
   R2-Explorer or any S3 tool can browse them. This replaces stamp-first `_trash/`.
2. **Each manifest version gets one change record**, `<root>_changes/<project>/<host>/<seq>.json`. It lists what that
   version added, edited, deleted or restored, and where each old version went. These records are the activity log
   online, one per device.
3. **What is kept:** every version that lived 30 s or more. In a burst of saves, one version per 30 s. After an hour,
   one per hour. After a day, one per day. After 30 days, nothing. Folders can opt files out with `no_history`
   (default `*.log`). The schedule is modelled on Syncthing's staggered versioning [9].
4. **The folder's Durable Object prunes it**, every host's history, daily. It does this even for a machine that never
   comes back. Each engine also prunes its own host's history daily with the same rule, which is all a v0
   bucket-key folder has.
5. **Restore always goes through the device that owns the file.** That device restores its own files at once. A
   browser restores web-host files directly; for a machine's file it leaves a restore request, which the machine
   applies when it next syncs and answers in place (`outcome`). Nothing is overwritten that is not already in
   history. Download works anywhere.
6. **There is no merge setting.** Each device writes only its own files, so two devices can never edit one file.
   Obsidian's "Automatically merge" has nothing to merge here. History keeps the base a 3-way merge would need if
   two-way `shared/` folders ever arrive; their default would be "keep both".
7. **History counts toward each person's quota,** as `_trash/` already does and as Obsidian does [2]. When the quota is
   full, sync stops, as PEP 0003 does today. One click on "Free up space" deletes old history.
8. **One activity log line format,** `folder-sync-event/1` from the desktop app (PEP 0006), with file-level events added. It is
   written in three places: to stdout (`--events`), to a local JSONL file per folder (14 days), and into the change
   records online. Unlike Obsidian's log, it survives a restart [5].
9. **One shared view, one custom element:** `<folder-sync-status>`, the pill, its menu, and a panel with Activity,
   Version history with a diff, and Deleted files. It is a plain ES module with Shadow DOM, the native `popover` and
   `<dialog>`, and a vendored jsdiff, served at `/fs/ui/v1/` on every app's own origin. An app adds two lines.
10. **One data API, two servers.** `/fs/v1/folders/:project/{status,activity,history,deleted,restore}` is answered by
    the accounts Worker online and by `folder-sync serve` on the machine. That is a loopback server with a token and a
    Host check. The view only ever calls the origin it is on.
11. **Which surfaces work where:** status, activity, history, deleted files and restore work online and locally. Old
    bytes need the network locally, because they live in R2. Freeing space is online only; visibility, readers and
    revoking devices stay on `/fs/account`, which the menu links to.
12. **The demo is its own tiny Worker,** `folder-sync-demo`, on `folder-sync-demo.zach-yamaoka.workers.dev`: the same
    `/fs/*` service binding every app uses, plus one page. Signed in from that page, you see **your own folder**:
    its files, recent activity, and how long each sync took, disk to online and online to disk (amended by Zach,
    2026-10-28, §6). It is illustrative, not a place to work. `folder-sync serve` shows the same over a machine's
    own state.
13. **Build plan:** the contract is frozen (B0, this PEP's acceptance), and PEPs 0004, 0005 and 0006 have landed, so
    all six lanes start at once; the demo lands last (§7).
14. **Found while reading:** for signed-in people, nothing ever expires the trash. R2 lifecycle rules match only a
    literal prefix [12], so `_trash/` never matches `users/<id>/_trash/`. Retention has to be folder-sync's own job
    (§1.4, item 4).
15. **This is a durable decision** about the bucket contract (`_history/`, `_changes/`, `_requests/`) and about the
    view API. A later rewrite must not quietly re-decide it; this PEP is its record.
16. **Cut for Unix scope at acceptance** (§13): the Settings view, pause and device controls, a second element,
    the hub's new messages, change-record folding, the legacy-trash migration, rewind, and three other small surfaces.
    What is left does one thing: show sync state, show versions, undo.

## 1. The frame: what the ask assumes, and what is true here

1. **"Like Obsidian" assumes one shared set of files.** In Obsidian Sync every device edits the same notes, so
   conflicts are real and "Automatically merge" exists [3]. In folder-sync each device publishes only
   `hosts/<own id>/`, and receives the others' files read-only (CONTRACT "Who writes"). Two devices cannot edit one
   file. Three things follow:
   - a version history is per **(device, path)**;
   - "conflict resolution" is not a setting. Its one real case is an edit to another device's read-only copy, which
     is already kept aside in `~/.folder-sync/conflicts/` (round.go `keepLocalEdit`);
   - a restore belongs to the device that owns the file.
2. **"Version control" here means file history, deleted files, restore, and later rewinding a folder to a time.** It
   does not mean commits and branches. PEP 0001 already says "Carry code. That's git." The screenshot Zach showed is
   Obsidian's per-file history: a list of revisions, "Show changes", Copy and Restore [1]. Git stays the tool for code
   (§3.1, option e).
3. **"A view any app embeds" means three places with one UI:**
   - an app's page on its own domain, with data online;
   - a page on the machine (`vt serve`, the desktop app's window), with data from this device;
   - and that same page offline.

   So the UI must not care where its data comes from. It reads the same routes from whatever origin it is on.
4. **The trash never expires for signed-in people.** The only expiry is the README's pending step, a lifecycle rule
   with prefix `_trash/`. R2 lifecycle rules match only a literal prefix, and there are at most 1,000 of them [12].
   Since PEP 0002 every key lives under `users/<id>/`. The engine's `TrashPrefix` is `p.Root + "_trash/…"`
   (`internal/syncer/project.go`), and the web host's `trashKey` is `${w.root}_trash/…` (`accounts/src/webhost.ts`). So
   for every signed-in person the rule matches nothing, and the trash grows until they hit their quota. Nothing is
   lost; the cost is quota. That makes retention folder-sync's own job, which is why this PEP has a pruner (§3.2). The
   README step still covers v0 bucket-key folders, whose root is empty. The README should say that; it is a one-line
   fix in `lane/worker-api` (§7).
5. **History is the undo for agents.** Zach's reason for folder-sync is "use local agents" on plain files (ask 4). The
   undo that matters most is "an agent overwrote or deleted something": undo the last change, get back yesterday's
   version, put back the folder an agent deleted. The vault's agent-safety research found that copies an agent cannot
   reach are the last line of defence. Here they are only partly out of reach. A machine's keys can write its whole
   root, `_history/` included (PEP 0002 §6), so a rogue agent could delete history; a careless one will not. §12
   keeps that as a revisit.

## 2. Weights for the whole design

Each part below scores its own options against these, re-weighted where noted.

| Criterion | Weight | Why |
|---|---|---|
| Nothing is lost without a copy, and the bucket alone can recover any version | 25 | PEP 0001 §5; an index is one more thing that can break |
| The folder is the database: plain bytes, readable keys, any S3 tool, `rclone copy` as the exit | 20 | PEP 0001 "What wrapping keeps"; R2-Explorer is the backdoor |
| One implementation each for UI and data rules, working online, on the machine and offline | 15 | ask 1 ("share with any app"), ask 4 (every future app) |
| Small change to reviewed code (the push, the web host's object, quota, the over-quota delete jobs) | 15 | seven review rounds went into those paths |
| Bounded storage that is honest inside each person's quota | 15 | §1.4 |
| Stock parts and published precedent | 10 | Zach's first rule |

## 3. A · Version history and deleted files

### 3.1 Where history lives

The §2 weights apply. For history, the third one reads "the view's four questions are cheap": a file's versions,
deleted files, recent activity, and the storage split.

| Option | Nothing lost (25) | Plain (20) | Queries (15) | Small change (15) | Bounded (15) | Stock (10) | Score |
|---|---|---|---|---|---|---|---|
| (a) As today: `--backup-dir` into `_trash/<p>/<h>/<stamp>/<path>`, and the view lists the trash | 22 | 9: one folder per round, so a file's versions are scattered across them | 8: a file's versions take a listing of the host's whole trash, and the key has no hash | 15 | 2: no lifecycle rule can match it (§1.4), and nothing thins it | 10 | 66 |
| **(b) Path first: `_history/<p>/<h>/<path>/<version>`, one change record per manifest version, copies by S3 `CopyObject`** | 25 | 20 | 13: a file's versions take one LIST; activity is GETs by key; deleted files take one listing per host (one call per 1,000 versions) | 9: the push's trash step and the web host's trash key change, and the legacy trash migrates | 13: staggered thinning plus 30 days, run by the folder's object; counted in the quota; fails closed | 7: S3 calls the code already signs; Syncthing and restic schedules | **87** |
| (c) Keep stamp-first `_trash/` bytes, and add change records and a SQLite index in the folder's object | 23 | 9 | 14 | 11 | 12 | 8 | 77 |
| (d) Content-addressed `_versions/<p>/<h>/<sha256>` and a per-file revision log (git's object store [17]) | 18: without its log, a blob does not say which file it was | 5: hashes as names | 10 | 8 | 9: deduplicated, but deleting needs a reachability sweep, like restic's prune [10] | 6 | 56 |
| (e) Git: one Cloudflare Artifacts repo per folder, or git with a remote | 20: a second store beside R2 | 8: git clients can read it; S3 readers and the bucket contract cannot | 7 | 3: a new store, client, auth and bill | 5: $0.50/GB-month against R2's $0.015, $0.15 per 1,000 operations, new repos capped at 1 GB, and binary history kept forever [15,16,13] | 8: open beta since 2026-10-01 | 51 |
| (f) restic or kopia snapshots of each folder into the bucket | 22 | 2: packed and encrypted | 4 | 5 | 12: forget plus prune is exactly right [10] | 9 | 54 |
| (g) R2 object versioning | not offered: R2 lists `PutBucketVersioning` as unimplemented [11] | | | | | | n/a |

**Chosen: (b).** It wins where folder-sync is different from a database. A version is the file's own bytes at a key a
person can read (`_history/notes/<host>/notes/plan.md/2026-10-28T20:41:00.117Z_9f2c1a3b4c5d6e7f`), and the bucket is
the index. Each history object has one owner and one meaning, so deleting it is a decision about that one object; no
sweep across hosts is needed. (c) is the runner-up: it keeps the byte path unchanged, but needs a derived index to be
fast and leaves the backdoor unusable.

**The layout** (`docs/CONTRACT.md` gains it; every key starts with `<root>`, as now):

```text
<root><project>/hosts/<host>/<path>                         live file (unchanged)
<root><project>/hosts/<host>/manifest.json                  manifest (unchanged; no new field)
<root>_history/<project>/<host>/<path>/<version>            a kept version: the file's exact bytes
<root>_changes/<project>/<host>/<seq, 12 digits>.json       what manifest version <seq> changed (§4)
<root>_requests/<project>/<host>/<id>.json                  a restore this host is asked to make (§3.3)
```

- **The version name is `<written_at>_<sha16>`.** `written_at` is the old manifest entry's, in RFC 3339 UTC to the
  millisecond; `sha16` is the first 16 hex digits of its sha256. So names sort oldest first, and the name says which
  bytes it holds. The object's `LastModified` is when it left the folder.
  - **WHY a colon in the name:** no published path can contain `:`. Both writers refuse it:
    `names.CheckWindows` and `webhost.checkWebPath`. So a version can never be mistaken for a file inside a folder of
    the same name. A delimiter LIST shows versions as objects and deeper paths as prefixes (spike, §11).
- **A copy happens before the overwrite.**
  - For each changed path that already had a version, the round copies the live object to history. This is a
    `CopyObject` with `x-amz-copy-source-if-match: "<object_etag>"` when the manifest has the ETag (PEP 0004),
    so it copies exactly the version the manifest lists [11].
  - A 412 means the object is not the version the manifest lists: a crashed upload, or another writer. It is still
    copied, under `<its LastModified>_unlisted`, so nothing is lost and nothing is mislabelled.
  - A restore checks the bytes against the name's `sha16`, so a mislabelled copy is never restored silently.
  - Then rclone uploads the new bytes, without `--backup-dir`.
  - A delete is a copy, then a `DeleteObject`. Deletes are free on R2 [13].
  - A copy that fails holds that path's upload this round, so nothing is overwritten without a copy.
  - Files over 5 GiB use `rclone copyto`, which does the multipart server-side copy [14].
  - A path whose history key would pass 1,024 bytes [14] is published but not versioned, and its change record says so.
- **WHY native S3 calls and not rclone's flag:** `--backup-dir` with `--suffix` can only append to a file's name. It
  cannot put the version under the path, and it has no way to do it for deletes (`move` keeps the name). The engine
  already signs S3 requests itself (`internal/s3`), and PEP 0005 §4 names native calls as its next speed-up. rclone
  keeps what it is good at: moving bytes, with retries, multipart uploads and checksums.
- **Writers:**
  - each machine writes its own `_history/…/<host>/` and `_changes/…/<host>/`;
  - the folder's Durable Object writes the web host's, and the change record for an over-quota delete job, whose
    manifest it already builds (PEP 0003 §3.7);
  - the folder's object expires all of them (§3.2).

  Writing and expiring never touch one key at the same moment: a key is written once and deleted only after it ages.
- **Legacy `_trash/`** (changed at acceptance, §13): it is not migrated. The pruner deletes it 30 days after its stamp,
  the view does not show it, and any S3 tool can still read it until then. Readers learn one layout only.

### 3.2 What is kept, and who prunes it

Weights for this choice:

| Criterion | Weight |
|---|---|
| The last real version before a mistake is always there | 30 |
| Bounded by churn, not only by time: an agent saving every 2 s must not fill the quota | 25 |
| Runs when the writing machine is gone for good | 20 |
| Fits in one table | 15 |
| Precedent | 10 |

The options:

| Option | Last version (30) | Churn (25) | Machine gone (20) | One table (15) | Precedent (10) | Score |
|---|---|---|---|---|---|---|
| Keep every version 30 days, which is what a lifecycle rule would do | 30 | 0: an agent saving every 2 s makes 1.3 million versions a month | 10: no rule can match a root (§1.4), so a pruner is needed anyway | 15 | 7 | 62 |
| A count cap per file. Simple Hosted Files keeps 100 and never thins under 30 days | 30 | 5: nothing is thinned inside 30 days | 20 | 15 | 8 | 78 |
| **A staggered schedule after Syncthing's, a burst rule at write time, and a 30-day cap, pruned by the folder's object** [9] | 28: a version that lived under 30 s inside a burst can go | 25 | 20 | 12 | 10 | **95** |

| A version that left the folder… | Is kept |
|---|---|
| less than 1 h ago | if it lived 30 s or more. Shorter-lived ones (a burst of saves) are kept at most one per 30 s per path. This **burst rule** runs at write time, so a burst never costs copies. |
| 1 h – 24 h ago | the newest in each hour |
| 1 – 30 days ago | the newest in each day |
| over 30 days ago | none (`keep_days`, 30 by default) |
| always, within 30 days | the last version of a deleted file |

- **The worst case** for a path rewritten nonstop for 30 days is about 120 + 23 + 29 versions. In restic's terms this
  is `--keep-within 1h --keep-hourly 24 --keep-daily 30` [10]. Obsidian keeps notes for 1 month on Standard and
  attachments for 2 weeks [1]. Dropbox Basic keeps history for 30 days [7].
- **`no_history`** in `.folder-sync.toml` takes gitignore patterns that are never versioned. The default is
  `["*.log"]`. WHY: an appended log copied whole on every round is the fastest way to fill a quota, and each old
  version is just the start of the current one.
- **Who prunes: the folder's Durable Object, on a daily alarm.** This is the per-folder object PEP 0003 calls
  `WEB_HOST`, keyed `<owner>/<project>`. Any request that touches the folder sets the alarm: a page read, a web write,
  or the quota measurement that lists the root when a key is refreshed. An object has one alarm, so it is set to
  whichever comes first: the 30 s retry that settles a cut-off write, or the next prune.
  - It lists `<root>_history/<project>/`, applies the table above by `LastModified`, and deletes in batches.
  - It also prunes `<root>_changes/`: records older than 30 days are deleted (folding by day was cut, §13).
  - It prunes `<root>_requests/` (30 days) and legacy `<root>_trash/`.
  - WHY the cloud and not each machine: a laptop that is stolen or wiped never runs its own pruner again, and its
    history would sit in the quota for ever.
- **Each engine also prunes its own host's history**, once a day, with the same rule (changed at acceptance). A v0
  folder on a bucket key (empty root, no accounts server) has no folder object, so this is its only pruner, and it
  needs no lifecycle rule. Two pruners on one key are harmless: the rule is deterministic and buckets by clock hour
  and day, and deleting a deleted key is a no-op.
- **The rule, exactly, with worked examples:** `docs/CONTRACT.md` "What is kept" and
  `testdata/retention/schedule.json`. It also keeps the version a restore replaces, even inside a burst.

### 3.3 Restore: from the command line, a web page and the app

**The rule: only the device that owns a file restores it, and it first publishes whatever it has.** For the web
host's files, that device is the folder's object. In one round the engine:

1. pushes as usual, so any unpublished local edit becomes a version and is copied to history;
2. fetches the requested version, checks its hash against the `sha16` in its name (and against the full hash in the
   change record when there is one), and writes it to a temporary file;
3. renames that over the path;
4. pushes again.

Every state along the way is in history, so a restore can never lose an edit. Obsidian's Restore replaces the note's
contents [1]. Simple Hosted Files writes the restored bytes as a new version and never rewrites history (its SPEC
v1 §5). folder-sync does what Simple Hosted Files does.

| From | A file this device owns | Another device's file | The web host's file |
|---|---|---|---|
| CLI: `folder-sync history <path>`; `folder-sync restore <path> [--version <id>]` (default: the newest kept); `folder-sync deleted [--restore <prefix>]` | at once, as above. If a `--watch` engine holds the folder lock, it leaves a local request and pokes the engine | it writes a restore request into the bucket | the same request, or the web route |
| The page on the machine (`folder-sync serve`) | a local request, which the running engine applies within one round | a request in the bucket | the web route |
| A web page | a restore request, applied when that device next syncs: a `--watch` machine finds it within its 5-minute peer discovery, a `sync --once` at its start | (same) | at once: the folder's object writes the old bytes as a new version |

- **A restore request** is `<root>_requests/<project>/<host>/<uuid>.json`:
  `{schema: "folder-sync-restore/1", id, at, by: {kind, name}, items: [{path, version}]}`.
  - It is written by the Worker or by another of the person's devices, and applied only by the device it names.
  - That device writes the outcome into the request itself (`outcome: {at, seq?, results}`, `If-Match` on the
    request's ETag), and each applied item is also a `restore` event in its next change record, carrying
    `request: <id>`. A version pruned before it ran gives `error: "pruned"`. (Changed at acceptance: a request that
    fails entirely publishes nothing, so without `outcome` the asker would never learn why.) The pruner deletes
    requests 30 days after `at`.
  - The view shows "Waiting for bam-laptop (last seen 6 d ago)" until then, with Download as the way out. Requests
    expire after 30 days.
  - WHY not have the Worker write the old bytes into the machine's prefix: it would break the one-writer rule, and that
    machine's next reconcile would move the object to history as a stray.
- **Bulk restore** is one request with many items. **Deleted files** come from one listing of a host's history: paths
  with versions there and no live manifest entry.
- **Rewind** a device's folder to a time ("restore this folder to Tuesday 14:00", like Dropbox Rewind [8]) is cut
  (§13). It needs nothing new in the bucket: the change records say what changed after that time, so it would be one
  bulk request plus deletes.
- **Purge** removes data on purpose. A version can be deleted early, which is the "I synced a secret" case:
  `DELETE …/history/<host>/<path>?version=`. "Free up space" deletes history older than N days. Both are owner-only
  and permanent, and they lower the quota figure the way PEP 0003 §3.7's purge does.

### 3.4 Conflicts, against Obsidian's "Automatically merge"

- **Today there is nothing to merge** (§1.1). An edit to another device's copy is kept aside, never merged; the
  activity log shows it as a `conflict` event and the status as a warning.
- **For two-way `shared/` folders (v1, under a lease, PEP 0001 §6):**
  - a per-device setting appears, as in Obsidian [3,4];
  - its default is **keep both**, a conflict copy named the Obsidian way;
  - **merge text** is opt-in, and only for `*.md`;
  - the merge is 3-way, with the base taken from history (the last version both sides had);
  - it falls back to a conflict copy when changes overlap.
- WHY not Obsidian's default: Obsidian says its merge "may sometimes create duplicate text or formatting problems"
  [3]. Here, apps and agents parse the files. A quietly merged JSON or YAML file that no longer parses breaks the app,
  while a conflict copy is visible and loses nothing.

### 3.5 Storage

- **History counts toward the quota,** as `_trash/` does now (PEP 0003 §3.7) and as Obsidian's history does [2].
  Dropbox does not count it [7].
- **When the quota is full, sync stops,** as now: read-only keys and held uploads. The view then names the share
  that is history: "Storage full · history uses 600 MB · Free up space". WHY not evict history to make room: an agent
  or ransomware that rewrites every file would push out exactly the old versions you need. Failing closed keeps them,
  as Obsidian does [2].
- **`GET /fs/v1/usage` gains `live` and `history` bytes.** The measurement already lists the whole root, so the split
  is free. `history` counts everything under `_history/`, `_changes/`, `_requests/` and legacy `_trash/`.
- **History objects count against `QUOTA_OBJECTS` too.** Folding change records by day keeps each host to about
  2,000 + 30 of them. A root with more than about 45,000 objects already needs the Workers Paid subrequest limit to
  measure (PEP 0003 §3.7), and history brings that sooner.
- **Cost per edit:** one `CopyObject` (Class A), which is what `--backup-dir` costs today, plus one `PUT` for the
  change record per publishing round. At the vault note's 2,000 changes a day that is about 60,000 Class A
  operations a month extra, inside R2's free million [13].

### 3.6 With PEP 0005's push

- **Order in a round:**
  1. copy the old versions to history;
  2. upload the new bytes;
  3. write the manifest;
  4. tell the hub `changed`;
  5. write the change record;
  6. after a round that wrote peer files, write its pull record (the demo amendment, §6).

  WHY the record comes last: readers wait on the manifest, not the record, so latency is unchanged (§9). A page that
  hears `changed` reads the folder at once and the activity a moment later.
- **The burst rule makes rapid saves cheaper than now.** Today `--backup-dir` copies every replaced version; with the
  rule, a burst copies at most one per 30 s per path.
- **Cut at acceptance (§13): the hub gains nothing.** The draft added three messages (below); PEP 0005 §3's
  "anything else is ignored" would keep them compatible if they ever come back.
  - `request` (Worker → hub → device) wakes a device for a restore.
  - `status` (machine → hub, owner + machine only, at most 200 characters of `why`) carries a device's state when it
    changes. The hub keeps the last one per host and sends it in `hello`.
  - A machine names its host id in its first message, so the hub knows which devices are connected.

  They would have given a live online overview of each device's state; the manifests' `seq` and last change are
  the overview instead.
- **Requests and freshness without new messages:** a machine looks for requests at each `sync --once` and with its
  5-minute peer discovery (one LIST); the view polls every 10 s and, online, refetches on PEP 0005's `changed`.

## 4. B · The activity log

| Criterion | Weight |
|---|---|
| One line format for every producer and reader | 25 |
| Answers what happened, where and when; filters All / Errors / Skipped / Conflicts, search and Copy, as Obsidian does [5] | 20 |
| Survives a restart and stays bounded on disk | 15 |
| Online, each device costs O(changes), never a rewrite of a growing file | 15 |
| Never carries a key or a token | 15 |
| Stock format (JSONL, RFC 3339) | 10 |

| Option | One format (25) | Answers (20) | Restart, bounded (15) | O(changes) (15) | No secrets (15) | Stock (10) | Score |
|---|---|---|---|---|---|---|---|
| **`folder-sync-event/1` (PEP 0006), extended with file events. Kept locally as JSONL; online, each device's published events go in its change records** | 25 | 18: downloads and errors stay on the device in v1 | 15 | 15 | 13 | 10 | **96** |
| A second schema just for the log | 15 | 18 | 15 | 15 | 13 | 10 | 86 |
| Upload each device's JSONL as daily objects | 25 | 20 | 15 | 0: R2 cannot append, so each flush rewrites the day | 12 | 10 | 82 |
| Parse the text log (`~/.folder-sync/logs/<key>.log`) | 5 | 10 | 8: it grows forever | 0: no online copy | 8: free text | 5 | 36 |

**The format.**
- Every line has `schema: "folder-sync-event/1"`, `event`, `at` (RFC 3339 UTC, milliseconds), `project`, `host`,
  `host_name`, and `level` (`info` | `warn` | `error`; absent means `info`).
- The desktop app's events and fields (PEP 0006) are kept: `watching`, `round_start`, `round`, `hub`, `stopped`.
- New fields are optional, so the schema stays `/1`. Readers ignore event names they do not know.

| Event | Fields | Local log | Change record |
|---|---|---|---|
| `upload` | `path, size, sha256, op: add\|edit, was?: {sha256, size, written_at, kept}, up_ms?` | yes | yes |
| `delete` | `path, was: {…, kept \| null}, permanent?` | yes | yes |
| `restore` | `path, size, sha256, from: <version>, request?, error?` | yes | yes |
| `download` / `remove_copy` | `peer, peer_name, peer_seq, path, size?, down_ms` | yes | no; in the machine's pull record (§6) |
| `skip` (warn) | `path, why` | yes | no |
| `conflict` (warn) | `peer, peer_name, path, kept_at` | yes | no |
| `hold` (warn) | `why: max_delete \| over_quota \| unmounted, count` | yes | no |
| `synced` | none. "Fully synced" means a clean round, nothing local pending, and every known peer's latest manifest applied | yes | no |
| `truncated` (warn) | `why` | yes | no |

**Where it is written.**
- **Locally:** `~/.folder-sync/projects/<key>/log/<YYYY-MM-DD>.jsonl` (UTC days), kept 14 days, at most 20 MB a day.
  When a day reaches 20 MB, one `truncated` line is written and the rest of that day is not logged.
  - It is written by whatever runs the round, `sync --once` or `--watch`. The folder lock means one writer at a time.
  - `--events` prints the same lines to stdout, so the desktop app's tray needs no change.
- **Online, per device:** the change record, `{schema: "folder-sync-changes/1", project, host_id, host_name, seq, at,
  by: machine | web | server, via?, events: [upload / delete / restore lines]}`.
  - One immutable object per manifest version, so writing costs O(changes).
  - A record exists for every `seq`, including empty ones, so readers can count on it.
  - A failed record PUT is retried from `changes.pending/` next round, the way `manifest.pending.json` is. A gap
    shows as "1 change not recorded"; the manifests stay the truth.
  - `via` names the browser for web writes ("Chrome on Linux", as PEP 0004's devices list names it).
- **Downloads, skips and errors stay on the device in v1.** Online, a device's state is what its manifest and change
  records say; there is no live presence (§13).

**How the view reads it.**
- `GET …/activity?before=<cursor>&limit=200&level=&host=` (`q=` cut, §13: the element searches what it loaded).
  - Online, the Worker reads each host's newest records by key: the manifest gives the `seq`, then it counts down,
    with no LIST. It merges them by `at`.
  - Locally, `serve` merges this device's JSONL with the others' records, fetched when asked and then cached.
- Copy gives `HH:MM:SS  device  message` lines.
- Nothing secret gets in. Every `why` goes through the engine's existing scrub (`Creds.Scrub`), and the writer drops
  any field named like a token or a key.

## 5. C · The shared sync view

### 5.1 Its form

| Criterion | Weight |
|---|---|
| Works in every page with no build step and no framework: `vt serve`, robotparts.dev, the Tauri webview, the demo | 25 |
| One UI implementation online and on the machine | 20 |
| The app's CSS cannot break it, it cannot break the app, and it still takes the app's colours | 15 |
| Same origin only: no CORS, no third-party cookie, no token in page script (PEP 0003 §3.2) | 15 |
| Calm and accessible: keyboard, focus, dark mode | 10 |
| A fix reaches every app, and a breaking change cannot | 10 |
| Stock parts | 5 |

| Option | No build (25) | One UI (20) | Isolated, themeable (15) | Same origin (15) | Calm, a11y (10) | Fixes reach all (10) | Stock (5) | Score |
|---|---|---|---|---|---|---|---|---|
| **Custom elements as plain ES modules, served at `/fs/ui/v1/` by the Worker's `ASSETS` (as `/fs/site/*.js` already is) and embedded in `folder-sync serve`** | 25 | 20 | 14 | 15 | 8: accessibility is hand-built | 9 | 4 | **95** |
| The same in Lit, which Simple Hosted Files uses, vendored as one file | 20: one library to pin | 20 | 15 | 15 | 9 | 9 | 4 | 92 |
| An iframe of a `/fs/ui/` page | 15: a pill's menu cannot leave the frame | 20 | 10: total isolation, but the app's colours cannot reach it | 15 | 5: focus and sizing | 9 | 4 | 78 |
| Server-rendered pages like `/fs/account` | 10: a link, not something embedded | 5: two renderers, TypeScript online and Go on the machine | 15 | 15 | 9 | 9 | 5 | 68 |
| A React package | 0: needs a build and React | 20 | 12 | 15 | 9 | 9 | 3 | 68 |
| Each app builds its own from the JSON (today's `vt` `sync.js`) | 25 | 0 | 15 | 15 | 5 | 0 | 5 | 65 |

**Chosen: plain custom elements.** Lit is the fallback if hand-written rendering gets unwieldy. Switching is
reversible, since it keeps the same tags and API.

**How an app embeds it:**

```html
<script type="module" src="/fs/ui/v1/folder-sync.js"></script>
<folder-sync-status project="notes"></folder-sync-status>
```

- **The frozen interface is `docs/API.md` "The element"**: attributes `project` (required: one folder), `owner`,
  `base`, `view`; methods `open(view, {host, path}?)`, `close()`, `refresh()`; events `folder-sync:status` and
  `folder-sync:restored`; `--fs-*` custom properties and `::part(pill | menu | panel)`; it follows
  `prefers-color-scheme`.
- **Inside:** native `popover` and `<dialog>`, and jsdiff (`diff` on npm, BSD-3-Clause, `diffLines`) vendored as one
  pinned file [18].
- `/fs/ui/v1/` takes fixes. A breaking change gets `/fs/ui/v2/`.
- **Page version:** `serve` serves `/fs/`, one element per folder with `view` set: the desktop app's "Sync details…"
  window and the local walkthrough. The Worker's `/fs/sync` page was cut (§13); online, the demo is the plain page.

**The spike** (§11) renders the pill, the menu and all four views from fixtures in Chromium and in WebKitGTK 2.52.6,
which is the Tauri app's engine on Linux. Neither had a script error. A deliberately hostile
`button { background: hotpink !important }` on the page reached nothing inside.

### 5.2 The data API: one shape, two servers

**Frozen as `docs/API.md`**, with every body in `schema/view-api.schema.json` and one fixture per answer in
`testdata/view-api/`, which both servers' tests and the element's tests load. In short:
`…/{status,activity,history/:host/<path>,deleted}` (GET), `…/restore` and `…/history/purge` (POST, the latter online
only), `GET /fs/v1/usage` with `live` and `history`, `GET /fs/v1/folders` (on `serve`, this machine's folders), and
`/fs/ui/v1/*`. `…` is `/fs/v1/folders/:project`; on the machine, `?folder=` picks one of two folders that sync one
project, else `409 ambiguous_folder`.

- **History, activity, deleted files and requests are owner-only.** WHY: a public folder's history would publish
  whatever its owner deleted on purpose.

**The machine's server.** The brief offered custom elements served at `/fs/ui/*.js` on every app origin, or a local
equivalent served by the CLI. It is both: the same files at the same path from two servers. For the local half:

| Option | Every local page (30) | Safe on a shared machine (25) | State files stay private (20) | Stock (15) | One process (10) | Score |
|---|---|---|---|---|---|---|
| **`folder-sync serve` on loopback, with a token and a Host check** | 30 | 22 | 20 | 13 | 8 | **93** |
| Each app reads `~/.folder-sync/` itself | 20: each app parses it again, and a plain page cannot read files at all | 25 | 0: private files would become a contract | 10 | 10 | 65 |
| Tauri IPC only | 10: the desktop app only | 25 | 20 | 10 | 10 | 75 |
| A Unix socket or named pipe | 15: a browser still needs a proxy | 25 | 20 | 8 | 8 | 76 |

**`folder-sync serve`:**
- It listens on `127.0.0.1` at a port the OS picks, and writes `~/.folder-sync/serve.json`
  (`{schema, url, port, token, pid}`, mode 0600).
- Every `/fs/v1/*` request must have a `Host` that is exactly that loopback address (against DNS rebinding) and a
  bearer token, or the cookie its own page set. It never sends CORS headers.
- **It only reads:** the state directory and the bucket, with the same credentials sync uses. Its only writes are
  restore requests (local ones for this machine's files, bucket ones for another's); the web host's items it forwards
  to the accounts server with this machine's session. The engine still does all the syncing.
- WHY a separate command and not part of `sync --watch`: `vt` runs `sync --once` per pass, while the desktop app runs
  `--watch`. A reader of the state directory serves both.
- WHY not let each app read `~/.folder-sync/` itself: those files are private ("Not part of the contract"). The API is
  the contract.
- **Apps on the machine** forward `/fs/*` to it, as online apps forward `/fs/*` to the Worker. `vt serve` reads
  `serve.json` and adds the token. The desktop app opens `/fs/` in a window. `folder-sync serve` prints its URL
  (`folder-sync ui` was cut, §13).

### 5.3 The surfaces: what each shows, and where

| Surface | Online (an app's page) | On the machine (the `serve` page, the desktop app, `vt serve`) |
|---|---|---|
| **Pill and menu.** As Obsidian's, without Pause and Settings (§13): Activity log, Version history, Deleted files [5] | the folder's state; each device's last change; warnings; storage and Free up space; a link to `/fs/account` | this device's engine first: syncing, offline, over quota |
| **Activity log.** All / Errors / Skipped / Conflicts, search, Copy sync log | every device's published changes, live | this device's full log, plus the others' published changes |
| **Version history with diff.** Versions on the left; Show changes, Copy, Download and Restore on the right | yes | yes, with the network for old bytes |
| **Deleted files and bulk restore** | yes | yes, with the network |

**Calm states.** There is one headline; detail opens on demand.

| State | How it looks |
|---|---|
| Synced | a quiet ring |
| Syncing | a turning ring in the accent colour |
| Offline | a dashed grey ring with "last synced 12 min ago" |
| Needs you (amber) | something you can act on: signed out, over quota, held deletes, a skipped name, an edit kept aside, a folder that looks unmounted |
| Error (red) | sync stopped by a fault that is not yours and not the network: no engine, repeated failures that are not offline |

Offline is never red, because it waits on the network and asks nothing of you. Every warning says what to do, for
example "Rename CON.txt to sync it". "Copy debug info" never holds a key or a token.

## 6. D · The demo site

| Criterion | Weight |
|---|---|
| Uses exactly the integration an app uses: the service binding, `apps.json`, the two-line embed | 30 |
| Separate from vibetracks.dev and robotparts.dev | 20 |
| Tiny and build-free, so a reader sees the whole integration | 20 |
| Free and reversible: no domain bought now | 15 |
| Safe in public: no anonymous writes | 15 |

| Option | Same integration (30) | Separate (20) | Tiny (20) | Free, reversible (15) | Safe (15) | Score |
|---|---|---|---|---|---|---|
| **A tiny Worker `folder-sync-demo` on `folder-sync-demo.zach-yamaoka.workers.dev`, signed-in visitors using their own `demo` folder** | 30 | 20 | 18 | 15 | 13 | **96** |
| A new domain now | 30 | 20 | 18 | 5: a cost, and a name to choose | 13 | 86 |
| A local-only page | 10: nothing online | 20 | 18 | 15 | 15 | 78 |
| The accounts Worker's own `/` | 5: it skips the very integration it should prove | 18 | 18 | 15 | 13 | 69 |
| A page on vibetracks.dev or robotparts.dev | 25 | 0 | 15 | 15 | 13 | 68 |

**Amended by Zach, 2026-10-28,** after acceptance: he wants to test folder-sync on his own computers — download it
onto any machine, sign in to his own account, and see it work, and also sign in from the landing page: "in this
simple view you can show performance numbers for how fast things take ... the purpose is not to actually use it but
to be illustrative". And on strangers: "I don't want to be paying for other people's usage at all". "Keep everything
the same" otherwise. So:

- **The demo shows the signed-in person's own folder**, not a per-visitor demo folder (that is secondary, and not in
  `lane/demo`).
- **Hosted accounts stay allowlist-only** (`SIGN_UP_EMAILS`, PEP 0003) with the per-person cap they already have
  (`QUOTA_BYTES`, 1 GiB; a smaller cap is fine and is a `wrangler.toml` value, Zach's). **The public path is your
  own bucket:** `folder-sync login --key` with your own R2 key, then `folder-sync serve` for the same view over your
  machine. Nobody else's usage reaches Zach's bill.
- **Each sync's time is in the frozen contract** (CONTRACT "Sync times"): `up_ms` on uploads and deletes in change
  records, `down_ms` on downloads in the new pull records (`_changes/<project>/<host>/pulls/<at>.json`), so the page
  reads them from `activity` like any other event.

**What it is:**
- `demo/worker.ts`, about 20 lines: static `demo/site/`, and `/fs/*` forwarded to `folder-sync-accounts` through
  a service binding, exactly PEP 0003 §3.6;
- `demo/site/index.html`, one page, no build;
- `demo/wrangler.toml`;
- an `apps.json` entry, `"demo"`, with that origin and no fixed project (the page picks one of the person's folders);
- Zach adds the Google callback `…/fs/api/auth/callback/google`, as for every app.

**What it shows, in order:**
1. One sentence and the live pill: "Point folder-sync at a folder: it is on every computer you use, and here."
2. Signed out: **Sign in** (`/fs/signin?return=/`), and for anyone without an invitation, "Bring your own bucket":
   `folder-sync login --key`, then `folder-sync serve`.
3. Signed in: **your folders** (`GET /fs/v1/folders`), the first one chosen, and its files by device
   (`GET /fs/v1/folders/:project`).
4. **Recent activity** with each sync's time beside it, and two small figures above it: the median and the last of
   `up_ms` (disk to online) and `down_ms` (online to disk) over the activity it loaded, labelled as each event's own
   measure and linking to `lane/latency-kpi`'s bench as the KPI. A `down_ms` reads two clocks, and the page says so.
5. "Put it on another computer": the desktop app for Linux (PEP 0006's `.deb` and AppImage) and three commands with
   Copy buttons: `folder-sync login --server <this origin>`, `folder-sync init --project <this folder> --dir
   ~/<this folder>`, `folder-sync sync --watch`. The machine appears as a device the moment its first manifest lands.
6. "Try it": **Write a test file** puts `folder-sync-demo/<time>.txt` into the folder's web host (the call a page makes
   to save), so the online-to-disk time of the next pull shows up; edit a file on disk to see disk to online.
7. Version history, Deleted files and Restore, through the element.
8. "Use it in your app": the two lines, and links to `docs/CONTRACT.md` and `docs/API.md`.

**The local walkthrough:** `folder-sync serve` shows the same element over this machine's own state. Status and
activity keep working offline.

## 7. E · Build plan

**Barriers, all passed:**
- **B0, the contract:** frozen at acceptance, 2026-10-28: `docs/CONTRACT.md`, `docs/API.md`, `schema/*.schema.json`
  and `testdata/**` (`node --test schema/fixtures.test.mjs`). **No lane edits these.** A change to any of them is a
  contract change: it lands alone first, with its fixtures, and every open lane rebases onto it.
- **B1, `round.go`:** PEP 0004 (`object_etag`, `lane/devices`), PEP 0005 (the watch loop and hub client,
  `lane/fast-sync`) and PEP 0006 (`events.go`, `lane/desktop`) are merged into `claude/folder-sync-v0` (99560d9).
- **B2, the accounts Worker:** PEP 0004 is merged (0db76d4). Deploying it is Zach's.
- **B3, the hub protocol:** PEP 0005 is merged. This PEP adds nothing to it (§13), so the hub is no barrier.

Every lane cuts from `claude/folder-sync-v0` at or after this PEP's commit, and owns only the files in its write set.
Fixtures are read, never written: a lane that cannot pass one reports it instead of editing it.

| Lane | Write set (it creates or edits only these) | Starts | Lands | Proves |
|---|---|---|---|---|
| `lane/view` | `ui/**`: `ui/v1/folder-sync.js` (the element), `ui/v1/vendor/diff.js` (jsdiff, pinned, its licence header kept), `ui/embed.go` (package `ui`: `//go:embed v1`, exported `Files fs.FS`), `ui/test/**` (Playwright over `testdata/view-api/`), `ui/package.json` | now | any time | every `testdata/view-api/` fixture rendered in Chromium and WebKitGTK; keyboard and focus; no CSS leak either way (the spike's hostile stylesheet); dark mode; no request off its origin; `docs/API.md` "The element" verbatim |
| `lane/activity-log` | `internal/synclog/**` (new: `Emit(any)`, the per-folder day files, 14 days, the 20 MB cap and `truncated`, the scrub, stdout for `--events`), `cmd/folder-sync/events.go`, and in `cmd/folder-sync/main.go` only where `--watch` and `--once` build and call the event writer | now | first of the three Go lanes | `testdata/events/desktop.jsonl` unchanged byte-for-field (the tray reads it), every line it writes valid against `schema/event.schema.json`, rotation, the cap, no secret in a `why` |
| `lane/engine` | `internal/s3/**` (Copy with `x-amz-copy-source-if-match`, Delete, Put with `If-None-Match` / `If-Match`, List with delimiter), `internal/history/**` (new: keys and version ids, the write-time rule, the own-host pruner, change records and their `changes.pending/` retry, requests), `internal/syncer/**` (copy before overwrite or delete in place of `--backup-dir`, the change record after the manifest and the hub, the pull record after a round that wrote peer files, `up_ms` from the watcher's event or the mtime and `down_ms` from the peer's `generated_at`, requests applied at round start, round events in `Result`), `internal/config/**` (`no_history`, default `["*.log"]`), `cmd/folder-sync/{history,restore,deleted}.go` and their dispatch and usage lines in `main.go`, `e2e/history_test.go`, `scripts/check-r2` (the conditional copy against real R2) | now | after `lane/activity-log`; its last commit emits `Result`'s events through `internal/synclog` | on the stand-in: edit, delete, restore, bulk restore by request with `outcome`, the burst rule, `no_history`, `up_ms` and `down_ms` present and within the measured round on the stand-in; `testdata/retention/schedule.json` all green; `testdata/history/keys.json` parsed and built; every record it writes valid against `testdata/changes/` shapes; against real R2: the conditional copy's 412 |
| `lane/worker-api` | `accounts/src/{history,prune,requests,activity,view}.ts` (new; activity merges change records and pull records), `accounts/src/app.ts` (the routes), `accounts/src/webhost.ts` (path-first history, the write-time rule, change records with `up_ms`, web-host restore), `accounts/src/webhost-do.ts` (the daily prune on the object's one alarm; rooted legacy `_trash/` expired: the lifecycle fix), `accounts/src/quota.ts` (`live` / `history`), the over-quota delete job's change record, `accounts/site/ui` (serves `/fs/ui/v1/` from `ui/v1/`, the same bytes), `accounts/test/{history,prune,view-api}.test.ts`, the `test` script line in `accounts/package.json`, the README "Pending" line on `_trash/` | now | any time; `/fs/ui/v1/` serves real files once `lane/view` lands | every `testdata/view-api/` fixture with `worker` in `servers`; the retention table in TypeScript; the CSRF and owner-only rules red without them; a rooted `_trash/` older than 30 days expired |
| `lane/serve` | `internal/serve/**` (new: the loopback server, Host and token checks, the cookie, the routes over the state dir and the bucket), `cmd/folder-sync/serve.go` and its dispatch and usage lines in `main.go` | now: the server shell, auth and `status` (from what `status --json` reads), with the UI as an injected `fs.FS` | after `lane/engine` and `lane/activity-log`, whose `internal/history` and `internal/synclog` its history, deleted, activity and restore routes import; it wires `ui.Files` after `lane/view` | every `testdata/view-api/` fixture with `serve` in `servers`, over a real state dir; `wrong_host` and `no_token` red without them; `serve.json` valid against `testdata/serve/` |
| `lane/demo` | `demo/**` (`worker.ts`, `site/index.html`, `wrangler.toml`), the `demo` entry in `accounts/apps.json` | now, against `testdata/view-api/` (the page reads only `status`, `activity`, `GET /fs/v1/folders`, the folder's union view and one web-host PUT, all of which have fixtures or exist) | after `lane/view` and `lane/worker-api` | the amended §6 walkthrough on the local stack, recorded: sign in from the page, a second machine joins, both sync times show; signed out, the own-bucket path; no route a stranger can write through |

**Shared files and the order they land in.**
- `cmd/folder-sync/main.go` is the one file three lanes touch, each in named places: `lane/activity-log` (the event
  writer in `--watch` and `--once`), `lane/engine` (three commands), `lane/serve` (one command). They land in that
  order, each rebased on the last; the dispatch and usage lines are additions that merge cleanly.
- `internal/history` and `internal/synclog` are each owned by one lane and only imported by others after it lands.
- `ui/embed.go` is `lane/view`'s; `lane/serve` takes an `fs.FS` until then, so neither waits to start.
- `accounts/apps.json` is `lane/demo`'s alone (moved out of the Worker lane so the two never collide).
- `schema/pulls.schema.json` and `testdata/pulls/` (the pull record, added with the demo amendment) are B0 like the
  rest: the engine writes them, the Worker reads them, the demo shows them.
- Nothing in `accounts/src/hub.ts` changes.

**Adoption (other repos, after `lane/serve` and `lane/view`):** vibetracks (`vt serve` forwards `/fs/*` to `serve`
with its token and embeds the element), robotparts (the two-line embed), the desktop app ("Sync details…" opens
`serve`'s `/fs/`).

**What waits for nothing any more:** live updates online use PEP 0005's existing `changed`; restore requests reach a
`--watch` machine within its 5-minute discovery (the hub's `request` message is a §12 revisit).

**Deploys and the R2 dashboard steps stay Zach's,** as now.

## 8. What does not change

- the live layout `hosts/<host>/`;
- the manifest (no new field);
- one writer per host for live files;
- the credential process and account roots (PEP 0002);
- PEP 0003's routes and quota rules, except the new `live` / `history` split;
- PEP 0005's `hello` and `changed`;
- `status --json` (`folder-sync-status/1`);
- `vt`'s own `sync.json`, until `vt` adopts the view.

## 9. KPIs

- **Latency** up (disk → served online) and down (web write → disk) is `lane/latency-kpi`'s bench:
  `bench/latency/bench.mjs`, `folder-sync-latency/1`, hourly on the local stack, written to Vibe Tracks producer files
  in `~/vt/zach/producers/folder-sync/`. This PEP must not move either number. The history copy replaces
  `--backup-dir`'s copy, and the change record comes after the manifest and the hub message.
- **Ask for that lane:** add an *edit* trial, replacing an existing file. Its trials write new files
  (`bench/<id>.txt`), and history costs only on a replace, so today the bench cannot see this PEP's cost.
- **Later, a third KPI: restore latency,** from Restore clicked to the bytes on that device's disk.

## 10. F · Decisions (Zach, 2026-10-28)

He answered "Looks good please merge this. and finish building all of this", taking every default:

1. **History counts toward each person's storage,** like Obsidian [2]: full means sync stops, with Free up space.
2. **30 days, staggered:** fewer versions the older they get (§3.2; the exact rule is CONTRACT "What is kept").
3. **Only the owner sees history, activity and deleted files.** Readers and the public see live files and the status
   headline.
4. **A web Restore of a machine's file leaves a request** that the owning computer carries out; Download always works.
5. **The demo is on workers.dev** for now (`folder-sync-demo.zach-yamaoka.workers.dev`); a domain once there is a
   name. He adds the Google callback URL.
6. **`*.log` keeps no history** (`no_history = ["*.log"]`), replaced or deleted.
7. **Future two-way `shared/` folders keep both copies** on a conflict; merging is not designed here.

And for the product as a whole: keep it "super straight forward", "follow the unix philosophy and have something
that does 1 thing very well". §13 is what that cut.

Taken without asking, since they are implementation:
- `serve` is a separate command;
- the pruner runs in the folder's object, and each engine prunes its own host too;
- the version name format;
- jsdiff.

## 11. Evidence

### What was checked

- **Spike 1: the layout on the e2e stand-in.** `node docs/spikes/0007-history-layout/spike.mjs <rclone> <scratch>`
  starts its own `rclone serve s3` v1.75.2 and stops it when done. All 12 checks pass:
  - `PUT`;
  - `CopyObject` live → history;
  - one LIST gives a file's versions, oldest first;
  - a delimiter LIST tells versions (objects) from deeper paths (prefixes), even with a file and a folder of one name;
  - GET returns the exact bytes;
  - delete = copy + `DeleteObject`;
  - change record by key;
  - `projects --json` still sees only the project.

  **Finding: the stand-in ignores `x-amz-copy-source-if-match`** (it answers 200 to a wrong ETag), as it ignores
  conditional PUTs (PEP 0001's known gap). That check belongs in `scripts/check-r2` against real R2, which documents
  the header [11].
- **Spike 2: the view.** `docs/spikes/0007-status-view/` holds `folder-sync.js` (one custom element, about 210
  lines), `index.html` (fixtures, and a deliberately hostile host stylesheet) and `render.py`, which drives
  Chromium (Playwright) and WebKitGTK 2.52.6 (`xvfb-run`). Results:
  - six steps each in both engines;
  - the menu opens above the pill and stays on screen;
  - the dialog opens on every view;
  - no script errors;
  - no host CSS reached inside.
- **Code read** (Source 20). The facts this PEP rests on:
  - both trash keys start with the account root;
  - both writers refuse `:` in a path;
  - the Worker already serves `/fs/site/*.js` from `ASSETS` on every app origin;
  - the desktop app (PEP 0006) stops the engine to pause;
  - `vt`'s status is one line, polled every 10 s;
  - the latency bench writes only new files.
- **Vendor docs** were read for every number in this PEP (Sources).

### What was not verified

- R2's real answer to `x-amz-copy-source-if-match`, and whether a copy of a multipart object keeps its ETag.
- How long one LIST takes from a Worker against real R2 at 20,000 or more versions. The deleted-files view rests on it
  (§12).
- WKWebView (macOS) and WebView2 (Windows). Only Chromium and WebKitGTK were rendered.
- What Durable Object alarms cost for the pruner at many folders. PEP 0005's cost arithmetic suggests it is small.

## 12. Revisit when

- **R2 ships object versioning:** keep `_changes/` and let native versions replace `_history/` bytes (PEP 0001's
  revisit).
- **The deleted-files listing is measured over 2 s for a real folder:** add a derived index in the folder's object,
  built from the change records. It can always be rebuilt from the bucket.
- **An agent is ever seen deleting history,** or Zach wants history agents cannot touch: move `_history/` outside the
  root (`_history/users/<id>/…`). One bucket lock and one lifecycle rule could then cover everyone [12]. The cost is two
  credential prefixes, two listings per measurement, and a lock that stops a person over quota from purging, which
  Zach ruled against for `_trash/` on 2026-10-27.
- **Git semantics are wanted for a text folder** (commits across files, branches): mirror it into a Cloudflare
  Artifacts repo once that leaves beta [15]. That is a mirror, not the store.
- **Two-way `shared/` folders land:** add the conflict setting (§3.4).

## 13. Cut at acceptance: one thing, done well

Zach's scope note (§10) asks what is needed to **see sync state, see versions and undo**. These parts of the draft are
not, and are out of the frozen contract:

| Cut | Why it is not needed | What covers the need instead |
|---|---|---|
| A second element, `<folder-sync-panel>` | two public tags for one view | `<folder-sync-status view="…">` and its `open()` |
| The Settings view: Pause, device name, Disconnect, the ignore and `no_history` rules, Copy debug info; `pause`, `disconnect`, `rename-device` commands; `/fs/v1/local/{pause,debug,folders}` | controlling sync is not seeing it or undoing it | the desktop app's own Pause; `.folder-sync.toml`; `/fs/account` for devices and visibility; `GET /fs/v1/folders` on `serve` |
| The hub's `request` and `status` messages, host ids on sockets, live device presence online (`lane/hub-extras`) | a faster or richer status, not a different one | each device's `seq` and last change from its manifest; requests found within 5 minutes |
| `GET …/events` (WebSocket) on `serve` | the same freshness by a second mechanism | polling `status` every 10 s |
| The Worker's `/fs/sync` page and `folder-sync ui` | two more ways to open the same view | the demo page online; `serve`'s `/fs/` and its printed URL |
| Change records folded by day | an optimisation of object counts (and see §14.2) | 30-day expiry |
| Moving legacy `_trash/` into `_history/` | a migration that must read and hash every old object | the pruner expires it after 30 days; S3 tools read it until then |
| `folder-sync rewind` | a later convenience over bulk restore | `folder-sync deleted --restore <prefix>`, bulk Restore in the view |
| `restore --before <time>` and `--dir` | the same as above | `--version`, and `deleted --restore <prefix>` |
| Activity search on the server (`q=`) | the element filters what it loaded | client-side search |
| `paused` / `resumed` / `offline` log events | a `round` with `kind: offline` already says it; pausing is the app's | `round` events |
| The `shared/` merge setting's design (§3.4) | no two-way folders exist | the decision only: keep both |
| The demo's recorded loop and latency links | marketing, and `lane/latency-kpi` owns latency | the live walkthrough |

Kept, because undo needs them: Show changes (the diff), Download, bulk restore, purge and Free up space (history
counts toward storage, so it must be freeable), `no_history`, and the storage split.

## 14. Found while freezing

1. **A failed restore had nowhere to say so.** The draft put a restore's outcome only in the next change record, but
   a request whose every item fails publishes no manifest version, so no record. The request now carries `outcome`,
   written in place by the host it names (`schema/restore.schema.json`).
2. **Folding change records by day did not bound them.** At one record per publishing round, an agent saving every
   2 s makes about 43,000 records a day, inside the 24 hours folding left alone; §3.5's "about 2,000 + 30 per host"
   assumed 2,000 rounds a day. Against `QUOTA_OBJECTS` (100,000) that is two days. Folding was cut (§13); the real
   bound is not in this contract. Recommended when `lane/worker-api` measures it: count `_changes/` in bytes only,
   not in objects (its records are small and expire on their own). Until then the default is as written: they count.
3. **The burst rule could overwrite an unkept version on restore.** "Nothing is overwritten that is not already in
   history" (§3.3) did not hold when the replaced version was inside a burst. The rule now always keeps the version a
   restore replaces, as it does a delete.
4. **"The newest version of a deleted file is always kept"** is not a separate rule: the newest version is always the
   newest of its hour or day. The contract states it as a consequence.
5. **Hour and day buckets were undefined.** They are now UTC clock hours and days of `left_at`, not distances from
   `now`, so a prune is idempotent and two pruners cannot disagree.
6. **`written_at` has nanoseconds** in the engine's manifests (RFC 3339 with up to 9 digits), so a version id
   truncates it to the millisecond; the fixture pins the truncation.
7. **The event lines the desktop app reads today** carry only `schema`, `event` and `at` on most events (`project`
   and `host` only on `watching`). The draft said every line has `project`, `host`, `host_name` and `level`; the
   schema requires only the first three fields, so today's lines stay valid, and the local log adds the rest.
8. **Online-to-disk time reads two clocks.** A machine can time disk to online on its own clock, but online to disk
   starts on the peer's (or the Worker's) clock. `down_ms` is recorded as measured, may be negative under skew, and
   the page says so; the bench stays the clock-free KPI. A machine that only receives would have nowhere to publish
   its times, which is why the amendment adds pull records rather than a field on change records.
9. **python-jsonschema 4.10 on this machine skips `format: date-time`** (no `rfc3339-validator`), so it passed a
   fixture with `"at": "yesterday"`. The fixture test checks formats itself.

## Sources

Web sources accessed 2026-10-28.

1. Obsidian Help, Version history (1 month Standard, 12 Plus, attachments 2 weeks; Restore; bulk restore) — https://obsidian.md/help/sync/version-history
2. Obsidian Help, Plans and storage limits ("Version history and attachments are also counted towards your account's storage limit"; over it, syncing stops and you prune) — https://obsidian.md/help/sync/plans
3. Obsidian Help, Troubleshoot Sync (diff-match-patch merge for Markdown, last-modified-wins otherwise, "Create conflict file" since 1.9.7) — https://obsidian.md/help/sync/troubleshoot
4. Obsidian Help, Sync settings (remote vault, status, device name, conflict resolution, deleted files, storage, debug info) — https://obsidian.md/help/sync/settings
5. Obsidian Help, Status icon and messages (Synced / Syncing / Paused / Disconnected; activity log filters All, Errors, Skipped, Merge Conflicts; not kept after Obsidian closes) — https://obsidian.md/help/sync/messages
6. Obsidian Help, File recovery (local snapshots at least 5 minutes apart, kept 7 days, device-local) — https://obsidian.md/help/plugins/file-recovery
7. Dropbox Help, Version history overview (30 / 180 / 365 days; "version history doesn't take up any of your available storage space") — https://help.dropbox.com/delete-restore/version-history-overview
8. Dropbox Help, Dropbox Rewind (undo many changes at once, within version history) — https://help.dropbox.com/delete-restore/rewind
9. Syncthing docs, File Versioning (trash can, simple, staggered: one per 30 s for the first hour, per hour for a day, per day for 30 days, per week to max age; external) — https://docs.syncthing.net/users/versioning.html
10. restic docs, Removing backup snapshots (forget, then prune; keep-within, keep-hourly, keep-daily…) — https://restic.readthedocs.io/en/stable/060_forget.html
11. Cloudflare R2, S3 API compatibility (no bucket versioning; CopyObject supports `x-amz-copy-source-if-match`; PutObject conditionals are atomic) — https://developers.cloudflare.com/r2/api/s3/api/
12. Cloudflare R2, Object lifecycles (rules apply to a prefix; 1,000 rules maximum; removal within about 24 h) — https://developers.cloudflare.com/r2/buckets/object-lifecycles/
13. Cloudflare R2, Pricing (CopyObject is Class A; DeleteObject is free; $0.015 per GB-month; 1M Class A free) — https://developers.cloudflare.com/r2/pricing/
14. Cloudflare R2, Limits (object key at most 1,024 bytes; single-part upload at most 5 GiB) — https://developers.cloudflare.com/r2/platform/limits/
15. Cloudflare changelog, Artifacts (open beta 2026-10-01; repos created from 2026-09-29 capped at 1 GB) — https://developers.cloudflare.com/changelog/product/artifacts/
16. Cloudflare Artifacts, Pricing ($0.50 per GB-month after 1 GB; $0.15 per 1,000 operations after 10,000) — https://developers.cloudflare.com/artifacts/platform/pricing/
17. Pro Git, Git Internals: Git Objects ("Git is a content-addressable filesystem") — https://git-scm.com/book/en/v2/Git-Internals-Git-Objects
18. jsdiff (`diff` on npm, BSD-3-Clause; `diffLines`, `structuredPatch`) — https://github.com/kpdecker/jsdiff
19. Vault: `C - Fast file sync (prior art)` (the hub; cost arithmetic), `Running AI Agents Unattended Safely (Deep Research, 2026-10-02)` (copies an agent cannot reach), `C - 3-2-1 Backup Rule`, `C - Single Writer Principle`, `C - Derived Index (Rebuildable from the System of Record)`
20. This repository: `internal/syncer/{round,project}.go`, `internal/names/names.go`, `accounts/src/{webhost,app}.ts`, `accounts/wrangler.toml`, README "What is real and what is pending"; `cmd/folder-sync/events.go` and `app/` (PEP 0006, `lane/desktop`); PEP 0003 §3.3 and `accounts/src/devices.ts` (PEP 0004, `lane/devices`); PEP 0005 and `accounts/src/hub.ts` (`lane/fast-sync`); `lane/latency-kpi` `bench/latency/bench.mjs`; Simple Hosted Files `SPEC.md` (versions, checkpoints, `MAX_VERSIONS_PER_FILE`)
