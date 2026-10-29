# The folder is the database: the bucket contract

This is what an app may rely on when it reads a folder-sync project, online or on disk. It is the "port" of [`docs/peps/0001`](peps/0001-wrap-rclone-and-r2.md) §3: folder-sync writes it, apps read it, and nothing imports the other way. Vibe Tracks (vibetracks.dev) is the first app.

Two reference readers implement this page and are tested against a live stand-in:

- Python, stdlib only (boto3 optional): [`readers/python/folder_sync_read.py`](../readers/python/folder_sync_read.py)
- TypeScript for a Cloudflare Worker with an R2 binding: [`readers/worker/src/folder-sync-read.ts`](../readers/worker/src/folder-sync-read.ts)

**History, change records, pull records, restore requests, the activity log and sync times** ([`docs/peps/0007`](peps/0007-history-and-sync-view.md), accepted 2026-10-28) are frozen here, with their schemas in [`schema/`](../schema/) and shared fixtures in [`testdata/`](../testdata/) (`node --test schema/fixtures.test.mjs` keeps them in step). The writers are being built: until the engine and the accounts Worker ship them, rounds and the web host still write `_trash/` as below ("Legacy `_trash/`"). The view's HTTP API is [`docs/API.md`](API.md).

## Bucket layout

```text
<bucket>/
  <root>                             optional account root, like users/AbC123/ (below); every key starts with it
  <project>/
    hosts/
      <host-id>/                     one machine's files; only that machine writes here
        manifest.json                its file list (schema below)
        notes/plan.md                files, at their path in that machine's folder
        ...
    shared/                          two-way folder under a lease: v1, not written in v0
  _history/
    <project>/<host-id>/<path>/<version>     a kept version: the file's exact bytes (PEP 0007)
  _changes/
    <project>/<host-id>/<seq>.json           what that host's manifest version <seq> changed (PEP 0007)
    <project>/<host-id>/pulls/<at>.json      the peer files that host wrote to its disk in one round (PEP 0007)
  _requests/
    <project>/<host-id>/<id>.json            a restore that host is asked to make (PEP 0007)
  _trash/
    <project>/<host-id>/<UTC-stamp>/<path>   legacy: overwritten or deleted objects before PEP 0007
  _leases/<project>.json             the shared folder's lock: v1
```

- `<root>` is the empty string (the layout above, unchanged) or an account root: one to eight segments, each `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`, each followed by `/` (so `users/AbC123/`; exactly `^([A-Za-z0-9][A-Za-z0-9._-]{0,127}/){1,8}$`). With a root, every key in this page, `_trash/` included, is that key with `<root>` in front: `<root><project>/hosts/<host-id>/manifest.json`, `<root>_trash/<project>/<host-id>/<UTC-stamp>/<path>`. The root comes from the credentials folder-sync is given, never from a project's config, and a folder keeps the root it was first synced under (a round under another root is refused). Readers take the root as an optional parameter whose default, `""`, reads a v0 bucket.
- `<project>` matches `^[a-z0-9][a-z0-9._-]{0,62}$`. A leading `_` is reserved for folder-sync's own prefixes.
- `<host-id>` is a lowercase UUID v4, minted once per machine and kept in that machine's `~/.folder-sync/host.json`. The readable name is the manifest's `host_name`.
- `<version>` is `<written_at>_<sha16>`: the manifest entry's `written_at` truncated (not rounded) to the millisecond, as `YYYY-MM-DDTHH:MM:SS.mmmZ`, then the first 16 hex digits of its `sha256` (`2026-10-28T20:31:00.117Z_9f2c1a3b4c5d6e7f`). An object that was not the version the manifest listed is kept as `<its LastModified, to the ms>_unlisted`. Names sort oldest first. Exactly `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z_([0-9a-f]{16}|unlisted)$` ([`schema/history.schema.json`](../schema/history.schema.json)). WHY a colon is safe: no published path contains `:`, so a version name is never a file or folder of the published tree, and a delimiter listing of `…/<path>/` shows versions as objects and deeper paths as prefixes.
- `<seq>` is the manifest's `seq` as 12 digits (`000000000043`). `<id>` is a lowercase UUID v4.
- `<UTC-stamp>` (legacy `_trash/` only) is `YYYYMMDDTHHMMSSZ`, the start of the round that replaced the object; the web host appends milliseconds and 8 random hex digits.
- Object keys are the file's path in its folder, slash-separated, byte for byte. folder-sync skips (and reports in `status`) names that can't exist on every OS: Windows-reserved characters and device names, a trailing dot or space, and case-only twins such as `README.md` beside `readme.md`.
- A file at the root of a folder named `manifest.json` is not published, because the manifest uses that key.

## The manifest

`<project>/hosts/<host-id>/manifest.json`, JSON, validated by [`schema/manifest.schema.json`](../schema/manifest.schema.json):

```json
{
  "schema": "folder-sync-manifest/1",
  "project": "demo",
  "host_id": "b55e9683-7854-4121-a56a-9bae7c3ab1da",
  "host_name": "bam-GPU",
  "seq": 7,
  "generated_at": "2026-10-20T22:43:41.512Z",
  "files": [
    {
      "path": "notes/plan.md",
      "size": 1834,
      "mtime": "2026-10-20T22:41:03.117260411Z",
      "sha256": "9f2c…64 hex…",
      "written_at": "2026-10-20T22:43:41.498Z"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `schema` | Format and major version. A reader refuses anything but `folder-sync-manifest/1`. New optional fields keep `/1`; anything a v1 reader would misread bumps it to `/2`. Readers ignore fields they don't know. |
| `project`, `host_id` | Must equal the key's `<project>` and `<host-id>`. A reader rejects a manifest that claims another host. |
| `host_name` | The machine's readable name (its hostname at first `init`). Display only; not unique. |
| `seq` | Starts at 1 and goes up by one on every rewrite. |
| `generated_at` | When this version was written (RFC 3339, UTC). |
| `files[]` | Every live file this host publishes, sorted by `path`. |
| `path` | Relative to `hosts/<host-id>/`; never absolute, never `.`/`..`, never a backslash. |
| `size`, `sha256` | The content. A reader may verify `sha256` after a GET. |
| `mtime` | The source file's modification time on its machine, nanoseconds where the OS has them. |
| `written_at` | When this host uploaded this content. |
| `object_etag` | Optional. The stored object's ETag as the store answered right after this host uploaded it, without its quotes (an MD5 in hex, or `<hex>-<parts>` for a multipart upload; `^[0-9A-Za-z-]{1,128}$`). A reader may fetch a byte range of exactly this version with `If-Match: "<object_etag>"` (a 412 means the object moved on: read the manifest again), instead of the whole file to check `sha256`. Absent when the writer did not learn it, or could not prove it is the object whose `sha256` this entry carries (the CLI records it only when it is the MD5 of the very bytes it hashed, so a multipart upload's ETag is never recorded); a reader then reads the whole file. A writer must never pair one version's `sha256` with another version's `object_etag`. |

## How an app lists and reads a project

Only manifests and GETs. An app never needs to list the files themselves.

1. **Find the hosts.** One delimiter listing: `ListObjectsV2(prefix="<root><project>/hosts/", delimiter="/")` returns one common prefix per host. Cache it; a new machine appears at most rarely. (An app that already knows its host ids skips this.)
2. **Read each host's manifest.** `GET <root><project>/hosts/<host-id>/manifest.json`. Keep the ETag and send it as `If-None-Match` next time: an unchanged manifest costs one `304`.
3. **The project's view** is the union of all hosts' `files[]`. A file's identity is `(host_id, path)`; its key is `<root><project>/hosts/<host-id>/<path>`. Two hosts may publish the same `path`: they are two files, and the app decides how to show them (Vibe Tracks shows them under their machine).
4. **Read a file.** `GET` its key. Optionally check `sha256`.

Costs on R2: step 1 is one Class A operation; each manifest check and each file read is one Class B operation; egress is free.

## Consistency

R2 is strongly consistent: a GET after a PUT sees the PUT. Each folder-sync round writes in this order:

1. copy each version that is about to be replaced or deleted to `_history/` (when the schedule below keeps it);
2. upload new and changed files, and delete deleted files' objects;
3. write the manifest;
4. tell the folder's hub (PEP 0005);
5. write the change record for that `seq`. It may land before step 4: the engine sends it while the round pulls. WHY: readers wait on the manifest, never on the record, so the record need not wait on the hub.

A copy that fails holds that path's upload or delete this round, so nothing the schedule keeps is overwritten without a copy. A copy whose source is gone (the object the manifest lists is missing) holds the path the same way, and the writer reconciles with its next round. Readers wait on the manifest, never on the change record, which may land a moment later (or, after a failed PUT, on the writer's next round).

So every file a manifest lists was in the bucket when the manifest was written. A reader holding manifest `seq N` can still race round `N+1`:

- a GET returns content whose `sha256` differs from the entry: the file was overwritten after `N`;
- a GET returns 404: the file was deleted after `N`.

Either way, re-read the manifest (it has changed) and retry once. Never treat an object that no manifest lists as live: it is an upload in flight, or a stray that the next hourly reconcile moves aside (to `_trash/` today; once PEP 0007's engine ships, to `_history/` as an `_unlisted` version).

## Deletions and history

- A path missing from the manifest is deleted. That is the only deletion signal; there are no tombstones.
- The version that leaves (replaced, deleted, or replaced by a restore) is copied first to `<root>_history/<project>/<host-id>/<path>/<version>`, its exact bytes, when the schedule below keeps it. The object has no custom metadata; its `LastModified` is when it left the folder (`left_at`). Copies use S3 `CopyObject` with `x-amz-copy-source-if-match: "<object_etag>"` when the manifest entry has one; a 412 means the object is not the listed version, and it is kept as `…_unlisted` instead, so nothing is lost or mislabelled. A path whose history key would pass 1,024 bytes is published but never kept.
- **A file's versions** are one listing: `ListObjectsV2(prefix="<root>_history/<project>/<host-id>/<path>/", delimiter="/")`. **Deleted files** are the paths with a kept version and no entry in the host's manifest.
- **Restore** is only ever done by the host that owns the path, which writes the old bytes as a new version (the one it replaces is kept first). Anyone else asks it with a restore request (below). An app never copies history back into `hosts/`.
- folder-sync never deletes more than `max_delete` files (default 50) in one round, and refuses outright to push when a folder that had files looks empty (unmounted disk); it still pulls the other hosts, and the round reports the refusal.
- History, change records and requests count toward each person's storage quota (PEP 0003 §3.7). Over quota, sync stops as before; history is never evicted to make room. Deletes by the accounts Worker (a purge, an over-quota delete job) are permanent by design, and there is no bucket lock (Zach, 2026-10-27).

### What is kept

One rule, implemented twice (the engine in Go, the web host and pruner in TypeScript) and pinned by [`testdata/retention/schedule.json`](../testdata/retention/schedule.json), which both must pass. Constants: `burst` 30 s, `keep_days` 30.

**When a version leaves** (at time `t`, the version's manifest entry written at `w`), it is copied to `_history/` unless the first rule that matches says not:

1. its path matches a `no_history` pattern (`.folder-sync.toml`, gitignore syntax as `ignore`; default `["*.log"]`): **not kept** (`why: no_history`), whether replaced or deleted;
2. it is deleted, or replaced by a restore: **kept**;
3. it lived `burst` or longer (`t − w ≥ 30 s`): **kept**;
4. this writer already kept a version of this path that left after `t − 30 s` (strictly): **not kept** (`why: burst`);
5. otherwise: **kept**.

So a burst of saves keeps at most one version per 30 s per path, and never costs a copy per save. The writer knows rule 4's answer without a listing: it is the only writer of its host's history.

**When the pruner runs** (at time `now`), each kept version of one `(host, path)` with `age = now − left_at`:

1. `age ≥ keep_days × 24 h`: **deleted**;
2. `age < 1 h`: **kept**;
3. `1 h ≤ age < 24 h`: **kept** only if it is the newest (largest `left_at`, then largest version id) of the versions in this tier whose `left_at` falls in the same UTC clock hour;
4. `24 h ≤ age < keep_days`: **kept** only if it is the newest of the versions in this tier with `left_at` on the same UTC day.

A deleted file's last version is always the newest of its hour or day, so it stays until `keep_days`. The worst case for a path rewritten nonstop is about 120 + 24 + 30 versions (restic's `--keep-within 1h --keep-hourly 24 --keep-daily 30`). Bucketing by clock hour and day, not by distance from `now`, makes a prune idempotent and two pruners running at once harmless.

**Who prunes:** the folder's Durable Object (PEP 0003's `WEB_HOST`, keyed `<owner>/<project>`) prunes every host's history daily, so a machine that never comes back is pruned too; each engine also prunes its own host's history once a day, which is all a v0 bucket-key folder (no accounts server) has. The pruner also deletes change records, pull records and restore requests 30 days after their `at`, and legacy `_trash/` objects 30 days after their `<UTC-stamp>`.

Worked examples (all at `now` = `2026-10-28T12:00:00.000Z`; the fixture has every case):

| Case | Versions (left_at, or written_at → t) | Kept |
|---|---|---|
| Lived 60 s | written 11:59:00 → left 12:00:00 | yes |
| Burst | lived 5 s; a version of the path kept at 11:59:50 | no (`burst`) |
| Burst edge | lived 5 s; the last kept at exactly 11:59:30 | yes (not strictly inside 30 s) |
| Delete inside a burst | lived 2 s; the last kept 1 s ago | yes |
| A log | `logs/run.log`, lived a day | no (`no_history`) |
| Under an hour | 11:59:30, 11:59:00, 11:00:00.001 | all three |
| Hourly | 11:50, 10:50, 10:20, 10:05, 09:59:59.999 | 11:50, 10:50, 09:59:59.999 |
| Exactly 1 h | 11:30, 11:00:00.000, 10:59:59, 10:30 | 11:30, 11:00 (hour 11), 10:59:59 (hour 10) |
| Exactly 24 h | 11:59, Oct 27 12:00:00.001, Oct 27 12:00:00.000, Oct 27 06:00 | all but Oct 27 06:00 (12:00:00.001 is hourly, 12:00:00.000 daily) |
| Daily | Oct 26 23:00, Oct 26 08:00, Oct 25 12:00, Oct 25 00:00, Oct 24 23:59:59.999 | Oct 26 23:00, Oct 25 12:00, Oct 24 23:59:59.999 |
| 30 days | Sep 28 12:00:00.001 and Sep 28 12:00:00.000 | Sep 28 12:00:00.001 only |
| `keep_days` 7 | Oct 22 12:00, Oct 21 12:00 | Oct 22 12:00 |

### Change records

`<root>_changes/<project>/<host-id>/<seq>.json`, validated by [`schema/changes.schema.json`](../schema/changes.schema.json): what manifest version `<seq>` changed, as that host's `upload`, `delete` and `restore` events (below) in path order, each saying where the old version went (`was.kept`, a version id, or `null` with `why`). `by` is `machine`, `web` (the web host; `via` names the browser) or `server` (the accounts Worker's over-quota delete job, which builds that manifest). One immutable object per manifest version a writer of this format publishes, written after the manifest; a failed PUT is retried on the writer's next round. A record that is missing means "not recorded"; the manifests stay the truth. These records are a folder's activity log online.

### Restore requests

`<root>_requests/<project>/<host-id>/<id>.json`, validated by [`schema/restore.schema.json`](../schema/restore.schema.json): `{schema: "folder-sync-restore/1", id, project, host, at, by, items: [{path, version}]}`, up to 1,000 items.

- It is created once (`If-None-Match: *`) by the accounts Worker (a page's Restore) or by another of the person's machines. Only the host it names applies it.
- A machine looks for its requests when it discovers peers (one listing): on a reconcile, with `--discover`, or every 5 minutes, in `sync --once` and `--watch` alike. WHY not on every `sync --once`: a round with no changes does no listing (PEP 0001 §4). The web host's requests are applied by the folder's object at once, so the Worker writes none for it.
- Applying one: fetch each version, check its bytes against `sha16`, write it over the path as a new version (keeping the one it replaces), publish, then write `outcome` into the same key (`If-Match` on the request's ETag): `{at, seq?, results: [{path, version, ok, error?: pruned | mismatch | failed, why?}]}`, one per item in order. Each applied item is also a `restore` event with `request: <id>` in that publish's change record. The host never deletes a request; the pruner does, 30 days after `at`.
- A request without `outcome` is waiting; a page shows it as "Waiting for <host_name>", with Download as the way out.

## The activity log

One line format, `folder-sync-event/1` ([`schema/event.schema.json`](../schema/event.schema.json)), for three places: `sync --events` on stdout (the desktop app's tray), each folder's local log on its machine (`~/.folder-sync/projects/<key>/log/<YYYY-MM-DD>.jsonl`, UTC days, kept 14 days, at most 20 MB a day, then one `truncated` line and nothing more that day; written by whatever runs the round, one writer at a time under the folder lock; apps read it through `folder-sync serve`), and the events of change records online.

- Every line has `schema`, `event` and `at` (RFC 3339 UTC). A line written to the local log also has `project`, `host`, `host_name` and `level` (`info`, `warn` or `error`); stdout lines may omit them, as the desktop app's do today. New optional fields keep `/1`; readers ignore event names and fields they do not know.
- The desktop app's events stay exactly as they are: `watching`, `round_start`, `round`, `hub`, `stopped` (`cmd/folder-sync/events.go`).
- File events: `upload` (`path, size, sha256, op: add | edit`, and `was` for an edit), `delete` (`path, was`, `permanent` for a delete job's), `restore` (`path, from: <version>, request?`; `size, sha256` when it succeeded, and `was` for the version it replaced; `error` and `level: error` when not), `download` and `remove_copy` (`peer, peer_name, path`), `skip` (`path, why`), `conflict` (`peer, peer_name, path, kept_at`), `hold` (`why: max_delete | over_quota | unmounted, count`), `synced` (a clean round, nothing local pending, every known peer's latest manifest applied) and `truncated`.
- `upload`, `delete` and `restore` reach the bucket in change records, and `download` and `remove_copy` in pull records (below); a failed restore published nothing and is in the local log and the request's `outcome` only. The others stay on the machine.
- No line ever holds a key or a token: every `why` goes through the engine's scrub (`Creds.Scrub`).

### Sync times

How long each sync took, in the two directions `lane/latency-kpi`'s bench measures, carried by the events themselves
so any page can show them:

- **`up_ms`** on `upload` and `delete`: disk to online. Milliseconds from the change on disk (the watcher's first event
  for that path; without a watcher, the file's mtime when it is later than the writer's previous round's start) to
  the manifest that published it (the change record's `at`), both on that machine's clock. Absent when the writer did
  not see when the change happened. For the web host, from the Worker receiving the write to its manifest.
- **`down_ms`** on `download` and `remove_copy`: online to disk. Milliseconds from the peer's manifest `generated_at`
  (its change record's `at`, the moment the change was online) to the file written or removed on this disk, with
  `peer_seq` naming that manifest. It reads two clocks, the peer's (the Worker's for the web host) and this machine's,
  so it includes their difference and may be negative; it is shown as measured, never clamped. The bench, which
  starts and stops one clock, stays the KPI.

**Pull records**, `<root>_changes/<project>/<host-id>/pulls/<at>.json` ([`schema/pulls.schema.json`](../schema/pulls.schema.json)): after a round that wrote or removed at least one peer file, the machine writes that round's `download` and `remove_copy` events once, in (peer, path) order, under the round's end time to the millisecond. That is how a page online learns the online-to-disk times of a machine that publishes nothing itself. One extra PUT per such round; the pruner deletes them 30 days after `at`.

## Who writes

- Only folder-sync writes `hosts/<host-id>/`, and only from the machine that owns `<host-id>`. An app that writes there breaks the single-writer rule and will be overwritten or moved to `_trash/` by the owner's next reconcile.
- An app that wants to change a file writes it into a synced folder on some machine; folder-sync publishes it from there.
- Each host's `_history/…/<host-id>/` and `_changes/…/<host-id>/` (its pull records included) are written only by that host's writer (for the web host, the folder's object). `_requests/…/<host-id>/` is created by others and answered only by that host. The folder's object, and each engine for its own host, delete what has aged out; a key is written once and deleted only after it ages, so writing and pruning never race on one key.
- A browser writes through folder-sync's accounts Worker, which is itself one more host of the folder: its web host (`host_name` `"web"`, a host id minted on the first write) writes files, history and its manifest exactly as a round does, its manifest PUT conditional on the last ETag, and every machine pulls it read-only like any peer ([`docs/peps/0003`](peps/0003-accounts.md) §3.4).
- Two-way folders (`<project>/shared/`, under a lease in `_leases/`) are v1. v0 refuses a `shared` mode in `.folder-sync.toml` with an error.

## The same layout on disk

A machine's own files stay where they are in its folder. Its peers' files land read-only at `<folder>/<peers_dir>/<host-id>/<path>` (`peers_dir` defaults to `hosts`), so a local app reads a peer's file at the same relative path as the bucket key minus `<project>/`. folder-sync never publishes `peers_dir/` or `.folder-sync.toml`. If you edit a peer's copy, folder-sync moves your edit to `~/.folder-sync/conflicts/` before the peer's next version lands, and `status` lists it.

## Legacy `_trash/`

Before PEP 0007 every overwritten or deleted object was kept at `<root>_trash/<project>/<host-id>/<UTC-stamp>/<path>`. It is not migrated and the view does not show it; any S3 tool still reads it, and the pruner deletes it 30 days after its stamp. Its README lifecycle rule (prefix `_trash/`) only ever matched v0 bucket-key folders, whose root is empty: for an account root (`users/<id>/…`) no lifecycle rule can match, since rules match a literal prefix. That is why retention is folder-sync's own job.

## Not part of the contract

- `_leases/` and `shared/` layouts beyond what this page states.
- Object metadata. rclone stores the mtime as object metadata too, but the manifest is authoritative.
- How folder-sync decides what changed (its local state in `~/.folder-sync/`), the local log's files and the local restore requests included: an app reads them through `folder-sync serve`. The one file there an app reads is `~/.folder-sync/serve.json` ([`docs/API.md`](API.md)).
