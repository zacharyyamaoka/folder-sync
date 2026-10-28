# The sync view's API: one shape, two servers, one element

This is what [`docs/peps/0007`](peps/0007-history-and-sync-view.md) froze on 2026-10-28 for seeing a folder's sync
state, its versions and undoing changes. Two servers answer it with the same JSON: the **accounts Worker** online (on
every app's `/fs/` mount, PEP 0003 §3.2) and **`folder-sync serve`** on a machine. One custom element,
`<folder-sync-status>`, reads it from whichever origin its page is on. The bucket underneath is
[`docs/CONTRACT.md`](CONTRACT.md).

- **Shapes:** [`schema/view-api.schema.json`](../schema/view-api.schema.json) (`$defs` per body), events in
  [`schema/event.schema.json`](../schema/event.schema.json), versions in
  [`schema/history.schema.json`](../schema/history.schema.json).
- **Fixtures:** [`testdata/view-api/`](../testdata/view-api/), one request and its answer per file, each saying which
  servers must answer exactly that (`servers`). Both servers' tests and the element's tests load them.
  `node --test schema/fixtures.test.mjs` checks every fixture against its schema. The owner's id is `AbC123zz9yX8`
  (an account id is 8 to 64 characters). A version a fixture restores has a real id: its `given.bytes` holds the
  bytes, keyed `<host>/<path>@<version>`, and the version's sha16 is theirs (`restore-online`: web's
  `hearts/clamp-24.json` at `2026-10-28T19:02:11.481Z_763d2e71f45a8d0f`, 230 bytes, sha256 `763d2e71…22fb0e`).
- **Nothing here is new for the files themselves:** reading a live file is still
  `GET /fs/v1/folders/:project/files/:host/<path>` (PEP 0003 §3.3).

## Auth

**Online (the accounts Worker):** exactly PEP 0003 §3.3. A browser sends its session cookie; a machine or an app's
server sends `Authorization: Bearer <session token>`. A cookie-authenticated `POST` must carry `X-Folder-Sync: 1`, a
same-origin `Origin` and `X-Folder-Sync-User: <the owner id the page shows>` (else `403 csrf` or `409 wrong_user`).
History, activity, deleted files, restore and purge are **owner only**; a reader or the public asking for them gets
the same `404 not_found` as an unknown folder. `status` answers owners, readers and the public (if the folder is
public), each with what their role may see.

**On the machine (`folder-sync serve`):**

- It listens on `127.0.0.1` only, on the port the OS gives it (`--port` to pick one), and writes
  `~/.folder-sync/serve.json` (mode 0600; `{schema: "folder-sync-serve/1", url, port, token, pid}`;
  `$defs/serve_json`) once it listens, and removes it when it stops. The token is 32 random bytes, base64url, new
  for every start.
- **Host check:** every request's `Host` must be exactly `127.0.0.1:<port>`, else `421 wrong_host` (DNS rebinding).
- **Token:** every `/fs/v1/*` request carries `Authorization: Bearer <token>`, or the cookie `folder_sync_serve`
  (HttpOnly, SameSite=Strict, Path=/fs/) that its own page set; else `401 no_token`. The page gets the cookie the
  Jupyter way: `folder-sync serve` prints `http://127.0.0.1:<port>/fs/?token=<token>`, and that one request sets the
  cookie and answers `303` to `/fs/`, so the token leaves the address bar at once.
- A cookie-authenticated `POST` must also carry `X-Folder-Sync: 1` (`403 csrf`). It never sends CORS headers.
- Its only caller holds the token, so it is always the owner; it has no readers.
- **It only reads**, with the same credentials sync uses: the state directory and the bucket. Its writes are restore
  requests (local ones for this machine's files, bucket ones for another machine's) and, for the web host's files, a
  `POST …/restore` it forwards to the accounts server with this machine's session. The engine still does all the
  syncing.
- **Apps on the machine** forward `/fs/*` to it the way online apps forward `/fs/*` to the Worker: `vt serve` reads
  `serve.json`, sends the bearer token, and keeps its own CSRF rule for the page in front of it. The desktop app opens
  `serve`'s `/fs/` in a window.

## Routes

`…` is `/fs/v1/folders/:project`. `:project`, `:host` and `<path>` follow the contract's rules (else `400`
`bad_project`, `bad_host`, `bad_path`). On the machine, when two folders sync one project, `?folder=<path>` picks one,
else `409 ambiguous_folder`.

| Route | Body (`$defs/…`) | Worker | serve |
|---|---|---|---|
| `GET …/status` | `status` | owner; readers and public get `project, owner, role, state, headline, devices` only | owner, with `this_device` |
| `GET …/activity?before=&limit=&level=&host=` | `activity` | owner: every host's published `upload` / `delete` / `restore` events and pulled `download` / `remove_copy` events | owner: this machine's whole local log, plus the others' published events |
| `GET …/history/:host/<path>` | `history` | owner | owner (old bytes need the network) |
| `GET …/history/:host/<path>?version=<id>` | the bytes | owner | owner |
| `GET …/deleted[?host=]` | `deleted` | owner | owner |
| `POST …/restore` | `restore_request` → `restore_response` | owner | owner |
| `POST …/history/purge` | `purge_request` → `purge_response` | owner | `501 online_only` |
| `GET /fs/v1/usage` | `usage` (adds `live`, `history`) | session (exists, PEP 0003) | no |
| `GET /fs/v1/folders` | `folders` | session (exists, PEP 0003) | the folders this machine syncs, with `folder` |
| `GET /fs/ui/v1/<file>` | the element's files | yes | yes (embedded in the binary) |
| `GET /fs/` | a page with one `<folder-sync-status>` per folder | no | yes |

### Each route

- **`status`** gives one headline `state` (`synced`, `syncing`, `offline`, `attention`, `error`, `unknown`; never red
  for offline) and a `headline` sentence; `devices` (each host: `id, name, kind: machine | web, seq, last_change`);
  for the owner, `warnings` (each says what to do), `waiting` (restore requests no host has answered) and `storage`
  (the usage figure; `serve` shows its last online figure with `measured_at`, or `null`). On `serve`, `this_device`
  is this machine's engine: `engine: watching | idle` (whether a `sync --watch` holds the folder lock) and its
  `last_round` (from `status --json`). Online, a device's state is only what its manifest says (`seq`,
  `last_change`): there is no live presence.
- **Skip warnings** (`kind: skipped`, a name folder-sync will not sync) come only from `folder-sync serve` and the
  machine's local activity log (`skip` events): a skip is decided on the machine and never written to the bucket, so
  the Worker cannot know of one and never gives it, nor counts it in `headline`.
- **`activity`** is newest first. `limit` is 1–500 (default 200); `level=warn` gives `warn` and `error` lines,
  `level=error` only errors; `host` keeps one host's. `before` is the `next` cursor of the previous page (opaque).
  Every event carries `host` and `host_name`; events from change records carry `seq`. Online, the Worker reads each
  host's newest change records by key, counting down from its manifest's `seq` (no listing), and its newest pull
  records with one listing of `…/pulls/`, and merges them by `at`. Searching is the element's, over what it loaded.
- **Sync times** ride on the events (CONTRACT "Sync times"): `up_ms` (disk to online) on `upload` / `delete`,
  `down_ms` (online to disk, two clocks) on `download` / `remove_copy`. No route summarises them; a page that wants
  "how long each sync took" reads `activity`.
- **`history`** lists the live entry (`null` when the path is deleted) and every kept version, newest first (`id`,
  `written_at`, `sha16`, `left_at`, `size`; `unlisted` instead of the first two for an unlisted version), at most
  1,000 (`more`). `?version=<id>` answers that version's bytes, typed by suffix as the files route is, with
  `X-Folder-Sync-Version: <id>`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff` and, for
  `.html`/`.htm`/`.svg`, `Content-Security-Policy: sandbox`. A version that has been pruned is `410 pruned`; an id that
  is not one is `400 bad_version`.
- **`deleted`** lists every path with a kept version and no live entry, newest deletion first, each with the
  `version` to restore. One listing per host, at most 10,000 versions per call (`more`).
- **`restore`** takes up to 1,000 `{host, path, version}` items and answers `applied` (written now as a new version:
  online, the web host's items, which the folder's object writes at once), `requested` (one restore request per other
  host, `where: bucket`, or `where: local` on `serve` for this machine's own files, which its engine applies in its
  next round) and `failed` (refused before anything was written: `pruned`, `mismatch`, `not_found`, `over_quota`,
  `failed`). The version a restore replaces is always kept first.
- **`history/purge`** deletes history for good, online only: one version (`host`, `path`, `version`: "I synced a
  secret"), or everything older than `older_than_days` (0–30, optionally one `host` and `path`: "Free up space"). Up
  to 1,000 objects a call, the usage lowered by each; `more: true` means call again (as PEP 0003's `web-trash/purge`).

### Errors

Every non-2xx JSON answer is `{ "error": "<code>", "why": "<sentence>" }` (PEP 0003 §3.3; `$defs/error`).

| Status | `error` | When | Server |
|---|---|---|---|
| 400 | `bad_request`, `bad_project`, `bad_path`, `bad_host`, `bad_version` | a malformed body, project, path, host id or version id | both |
| 401 | `signed_out` | no session | Worker |
| 401 | `no_token` | no bearer token and no page cookie | serve |
| 403 | `csrf` | a cookie `POST` without `X-Folder-Sync: 1` (Worker: or a foreign `Origin`) | both |
| 403 | `over_quota` | restoring a web-host file over quota (as web writes, PEP 0003 §3.7) | Worker |
| 404 | `not_found` | no such folder, host or path, or not the owner of an owner-only route | both |
| 405 | `method` | another method | both |
| 409 | `wrong_user` | `X-Folder-Sync-User` is not the session's | Worker |
| 409 | `ambiguous_folder` | two folders on this machine sync the project, and no `?folder=` | serve |
| 410 | `pruned` | the version asked for is gone | both |
| 413 | `too_large` | more than 1,000 items, or a body over 256 KiB | both |
| 415 | `json_only` | a `POST` body that is not JSON | both |
| 421 | `wrong_host` | `Host` is not `127.0.0.1:<port>` | serve |
| 501 | `online_only` | purge | serve |
| 503 | `recovering` | the web host is settling a cut-off change (PEP 0003) | Worker |

## The element: `<folder-sync-status>`

Every app embeds the same element with two lines, on its own origin:

```html
<script type="module" src="/fs/ui/v1/folder-sync.js"></script>
<folder-sync-status project="notes"></folder-sync-status>
```

It is a pill showing the folder's state; clicking it opens a menu (native `popover`) with **Activity**, **Version
history**, **Deleted files**, and online **Storage** and a link to `/fs/account` (devices, visibility); each opens a
panel in a native `<dialog>`. Activity shows each sync's time beside its line (`↑ 0.4 s`, `↓ 1.3 s`, from `up_ms` and
`down_ms`). Version history shows a file's versions with **Show changes** (a line diff, jsdiff's
`diffLines`, vendored at `/fs/ui/v1/vendor/diff.js`), **Download** and **Restore**; Deleted files restores one or
many at once.

- **URL:** `/fs/ui/v1/folder-sync.js`, an ES module with no dependency beyond its own `/fs/ui/v1/` files; served by
  the Worker from its assets and by `serve` from the binary, the same bytes. `/fs/ui/v1/` takes fixes; a breaking
  change gets `/fs/ui/v2/`.
- **Attributes:**
  - `project` (required): the folder.
  - `owner` (optional): the owner's id, for a folder someone shared with you (sent as `?owner=`).
  - `base` (optional, default `/fs`): where the app mounts folder-sync.
  - `view` (optional): `activity`, `history` or `deleted` opens that panel at once and shows no pill (`serve`'s `/fs/`
    page and an app's "Sync details" window use it).
- **Methods:** `open(view, {host, path}?)` opens a panel (`history` with a `host` and `path` opens that file's
  versions); `close()`; `refresh()` reads `status` now.
- **Events** (bubbling, composed, on the element):
  - `folder-sync:status`, `detail` = the `status` body, each time it changes: an app can show its own indicator from
    it and hide the pill (`hidden` attribute).
  - `folder-sync:restored`, `detail` = the `restore_response` body, after a Restore.
- **Theme:** CSS custom properties on the element or any ancestor: `--fs-font`, `--fs-fg`, `--fs-bg`, `--fs-muted`,
  `--fs-accent`, `--fs-warn`, `--fs-error`, `--fs-radius`; `::part(pill)`, `::part(menu)`, `::part(panel)`. It
  follows `prefers-color-scheme` when they are unset. Its Shadow DOM keeps the app's CSS out and its own in.
- **Behaviour an app can count on:**
  - It only ever calls its own origin (`credentials: "same-origin"`), never holds a token, and sends
    `X-Folder-Sync: 1` and `X-Folder-Sync-User` (the owner id from `status`) on its `POST`s.
  - It reads `status` when shown and every 10 s while the page is visible; online it also refetches when the folder's
    hub says `changed` (PEP 0005), and never polls while `document.hidden`.
  - It works in Chromium and WebKitGTK (the Linux desktop app), by keyboard (the menu and the dialog trap and return
    focus), and with no network on `serve` (status and activity; old versions need the network).
  - A readers' or the public's view shows the pill and the devices only.

## Cut at acceptance (Unix scope)

Zach, 2026-10-28: keep it "super straight forward", "something that does 1 thing very well". These parts of PEP 0007's
draft are not in this API: a second `<folder-sync-panel>` tag, the Settings view (pause, device name, Disconnect,
rules, debug info), `GET …/events` on `serve`, `/fs/v1/local/*`, the Worker's `/fs/sync` page, `folder-sync ui`,
activity's `q=`, and the hub's `request` / `status` messages. PEP 0007 §13 lists them with the reason for each.
