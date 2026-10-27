# The folder is the database: the bucket contract

This is what an app may rely on when it reads a folder-sync project, online or on disk. It is the "port" of [`docs/peps/0001`](peps/0001-wrap-rclone-and-r2.md) §3: folder-sync writes it, apps read it, and nothing imports the other way. Vibe Tracks (vibetracks.dev) is the first app.

Two reference readers implement this page and are tested against a live stand-in:

- Python, stdlib only (boto3 optional): [`readers/python/folder_sync_read.py`](../readers/python/folder_sync_read.py)
- TypeScript for a Cloudflare Worker with an R2 binding: [`readers/worker/src/folder-sync-read.ts`](../readers/worker/src/folder-sync-read.ts)

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
  _trash/
    <project>/<host-id>/<UTC-stamp>/<path>   every overwritten or deleted object, kept 30 days
  _leases/<project>.json             the shared folder's lock: v1
```

- `<root>` is the empty string (the layout above, unchanged) or an account root: one to eight segments, each `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`, each followed by `/` (so `users/AbC123/`; exactly `^([A-Za-z0-9][A-Za-z0-9._-]{0,127}/){1,8}$`). With a root, every key in this page, `_trash/` included, is that key with `<root>` in front: `<root><project>/hosts/<host-id>/manifest.json`, `<root>_trash/<project>/<host-id>/<UTC-stamp>/<path>`. The root comes from the credentials folder-sync is given, never from a project's config, and a folder keeps the root it was first synced under (a round under another root is refused). Readers take the root as an optional parameter whose default, `""`, reads a v0 bucket.
- `<project>` matches `^[a-z0-9][a-z0-9._-]{0,62}$`. A leading `_` is reserved for folder-sync's own prefixes.
- `<host-id>` is a lowercase UUID v4, minted once per machine and kept in that machine's `~/.folder-sync/host.json`. The readable name is the manifest's `host_name`.
- `<UTC-stamp>` is `YYYYMMDDTHHMMSSZ`, the start of the round that replaced the object.
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

## How an app lists and reads a project

Only manifests and GETs. An app never needs to list the files themselves.

1. **Find the hosts.** One delimiter listing: `ListObjectsV2(prefix="<root><project>/hosts/", delimiter="/")` returns one common prefix per host. Cache it; a new machine appears at most rarely. (An app that already knows its host ids skips this.)
2. **Read each host's manifest.** `GET <root><project>/hosts/<host-id>/manifest.json`. Keep the ETag and send it as `If-None-Match` next time: an unchanged manifest costs one `304`.
3. **The project's view** is the union of all hosts' `files[]`. A file's identity is `(host_id, path)`; its key is `<root><project>/hosts/<host-id>/<path>`. Two hosts may publish the same `path`: they are two files, and the app decides how to show them (Vibe Tracks shows them under their machine).
4. **Read a file.** `GET` its key. Optionally check `sha256`.

Costs on R2: step 1 is one Class A operation; each manifest check and each file read is one Class B operation; egress is free.

## Consistency

R2 is strongly consistent: a GET after a PUT sees the PUT. Each folder-sync round writes in this order:

1. upload new and changed files (the replaced object is first copied to `_trash/`);
2. move deleted files' objects to `_trash/`;
3. write the manifest.

So every file a manifest lists was in the bucket when the manifest was written. A reader holding manifest `seq N` can still race round `N+1`:

- a GET returns content whose `sha256` differs from the entry: the file was overwritten after `N`;
- a GET returns 404: the file was deleted after `N`.

Either way, re-read the manifest (it has changed) and retry once. Never treat an object that no manifest lists as live: it is an upload in flight, or a stray that the next hourly reconcile moves to `_trash/`.

## Deletions and the trash

- A path missing from the manifest is deleted. That is the only deletion signal; there are no tombstones.
- The deleted or overwritten object is kept at `<root>_trash/<project>/<host-id>/<UTC-stamp>/<path>`. An app can offer "restore" by copying it back to the owner's folder, never into `hosts/`.
- A bucket lifecycle rule expires `_trash/` after 30 days, and an R2 bucket lock on `_trash/` stops anyone deleting it sooner. Both are set once in the R2 dashboard (README, "Pending").
- folder-sync never deletes more than `max_delete` files (default 50) in one round, and refuses outright to push when a folder that had files looks empty (unmounted disk); it still pulls the other hosts, and the round reports the refusal.

## Who writes

- Only folder-sync writes `hosts/<host-id>/`, and only from the machine that owns `<host-id>`. An app that writes there breaks the single-writer rule and will be overwritten or moved to `_trash/` by the owner's next reconcile.
- An app that wants to change a file writes it into a synced folder on some machine; folder-sync publishes it from there.
- A browser writes through folder-sync's accounts Worker, which is itself one more host of the folder: its web host (`host_name` `"web"`, a host id minted on the first write) writes files, `_trash/` and its manifest exactly as a round does, its manifest PUT conditional on the last ETag, and every machine pulls it read-only like any peer ([`docs/peps/0003`](peps/0003-accounts.md) §3.4).
- Two-way folders (`<project>/shared/`, under a lease in `_leases/`) are v1. v0 refuses a `shared` mode in `.folder-sync.toml` with an error.

## The same layout on disk

A machine's own files stay where they are in its folder. Its peers' files land read-only at `<folder>/<peers_dir>/<host-id>/<path>` (`peers_dir` defaults to `hosts`), so a local app reads a peer's file at the same relative path as the bucket key minus `<project>/`. folder-sync never publishes `peers_dir/` or `.folder-sync.toml`. If you edit a peer's copy, folder-sync moves your edit to `~/.folder-sync/conflicts/` before the peer's next version lands, and `status` lists it.

## Not part of the contract

- `_trash/`, `_leases/` and `shared/` layouts beyond what this page states.
- Object metadata. rclone stores the mtime as object metadata too, but the manifest is authoritative.
- How folder-sync decides what changed (its local state in `~/.folder-sync/`).
