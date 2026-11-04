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
  `GET /fs/v1/folders/:project/files/:host/<path>` (PEP 0003 §3.3), and `folder-sync serve` answers it the same way
  (`files` below).

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
`bad_project`, `bad_host`, `bad_path`). On the machine, when two folders sync one project, `?folder=<path>` picks one
(the element's `folder` attribute), else `409 ambiguous_folder`.

| Route | Body (`$defs/…`) | Worker | serve |
|---|---|---|---|
| `GET …/status` | `status` | owner; readers and public get `project, owner, role, state, headline, devices` only | owner, with `this_device` |
| `GET …/activity?before=&limit=&level=&host=` | `activity` | owner: every host's published `upload` / `delete` / `restore` events and pulled `download` / `remove_copy` events | owner: this machine's whole local log, plus the others' published events |
| `GET …/history/:host/<path>` | `history` | owner | owner (old bytes need the network) |
| `GET …/history/:host/<path>?version=<id>` | the bytes | owner | owner |
| `GET …/files/:host/<path>` | the bytes | owner, readers, public (exists, PEP 0003 §3.3) | owner (the bytes need the network) |
| `GET …/deleted[?host=]` | `deleted` | owner | owner |
| `POST …/restore` | `restore_request` → `restore_response` | owner | owner |
| `POST …/history/purge` | `purge_request` → `purge_response` | owner | `501 online_only` |
| `GET /fs/v1/usage` | `usage` (adds `live`, `history`) | session (exists, PEP 0003) | no |
| `GET /fs/v1/usage/breakdown` | what is in the account (below; not a frozen schema) | session | no |
| `GET /fs/v1/folders` | `folders` | session (exists, PEP 0003) | the folders this machine syncs, with `folder` |
| `GET /fs/ui/v1/<file>` | the element's files | yes | yes (embedded in the binary) |
| `GET /fs/` | a page with one `<folder-sync-status>` per folder | no | yes |
| `GET /fs/files[?project=]` | the Files page (below): `<folder-sync-status view="files">` full-page | signed in (else `303` to `/fs/signin?return=/fs/files`) | no |

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
  is not one is `400 bad_version`. A version's `size` is its own whatever form the bucket keeps it in (a whole copy, a
  `.zst` keyframe or a `.prefix` pointer, docs/CONTRACT.md "Deletions and history"); the bytes are decoded and checked
  against the version's name before they are sent, bytes that fail are `502 corrupt`, and on the Worker a keyframe or pointer over
  32 MiB is `413 too_large` (restore it from a machine).
- **`files`** is a live file's bytes, as PEP 0003 §3.3 serves them online: typed by suffix, `ETag: "<sha256>"`,
  `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox` for
  `.html`/`.htm`/`.svg`, `Accept-Ranges: bytes` with one `Range` (`206`), `If-None-Match` (`304`), `If-Range` and
  `HEAD`. A path the host's manifest does not list is `404 not_found`. On `serve` the manifest is the one this
  machine published or last pulled, and the bytes are read from the bucket and checked against its sha256 before
  anything is sent; bytes that are not that manifest's (a newer upload) are `404 not_found`. Version history's
  "Current" reads it.
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

- **`usage/breakdown`** (Storage tab) lists the signed-in person's own root with a read-only credential, at most
  `BREAKDOWN_MAX_PAGES` (default 100) pages of 1,000 objects, and answers `partial: true` when it was cut. It never
  takes an owner: a stranger's prefix is not a thing a caller can name. The body: `owner`, `measured_at`, `used` and
  `quota` (`bytes`, `objects`; `used.objects` is what the quota counts, which is every object but `_changes/` records),
  `over` (the quota's reason, or `null`), `kinds` (account-wide: `live`, `history`, `trash`, `changes`, `requests`,
  `other`, each `bytes`, `objects`, `oldest`, `newest` and `clock`: `key` where the date is in the key, trash's stamp
  and a version's `written_at`, else `modified`), `projects` (each with its `kinds`, each with its `hosts`, a device's
  `host_name` being its manifest's, empty when it has none), `folders` and `files` (the 10 biggest, a folder at most
  three levels deep, with `live_bytes` and `old_bytes`, which counts history and legacy trash) and `suggestions`
  (`id`, `title`, `why`, `bytes`, `objects`: what a person could free, never done by this route; they overlap).

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
| 502 | `corrupt` | the bytes stored for a version are not that version's: a `.zst` that does not open to its size, or a prefix pointer whose anchor does not hash to its `sha256` (PEP 0009 §4.3). Something outside folder-sync changed the history; the version is not served | both |
| 503 | `recovering` | the web host is settling a cut-off change (PEP 0003) | Worker |
| 503 | `unavailable` | a route that reads the bucket (`history`, `files`, `deleted`) could not reach it: no network, or sync's credentials did not open the folder | serve |

## The shared tree

One tree that every device, agent and page of a folder edits ([`docs/peps/0010`](peps/0010-shared-tree.md); the layout, the merge rules and the conflict-copy name are in [`docs/CONTRACT.md`](CONTRACT.md) "The shared tree"). The Worker only; owner only (a reader can read the tree, never write it). A cookie write needs `X-Folder-Sync: 1` and `X-Folder-Sync-User`, a machine's bearer needs neither.

| Route | Body | Answer |
|---|---|---|
| `POST /fs/v1/folders/:project/share` | `{private?: [pattern, …]}`, up to 200 gitignore patterns | `{host, name: "shared", private, seq, created}`. Mints the tree's id once and writes its empty manifest (seq 1); asking again returns it. A different `private` than the first is `409 already_shared` |
| `POST /fs/v1/folders/:project/shared` | `{device, host?, max_delete?, changes: [{path, base, sha256, size, body \| staged \| delete: true, at_local}]}` | `{host, name, seq, changed, results: [{path, outcome, version, sha256, size, merge?, kept_as?, why?, conflict_path?, conflict_version?}]}`, in the order sent |
| `PUT /fs/v1/folders/:project/shared/<path>` | the file's bytes (up to 32 MiB); `X-Folder-Sync-Base: <version id>` (absent for a new file); `X-Folder-Sync-Merge: never` makes a mismatch a `412` | `{host, seq, path, outcome, version, …}`, one result as above |
| `DELETE /fs/v1/folders/:project/shared/<path>` | `X-Folder-Sync-Base` is required | one result: `accepted` (gone) or `edit_won` |

The commit:

- `base` is `null` for a path the device never knew, else `{version, sha256?}`: the version id of the bytes its file last held in step with the tree (`<written_at>_<sha16>`, [`docs/CONTRACT.md`](CONTRACT.md)), and their sha256.
- `body` is base64, up to 1 MiB a file and 8 MiB a request; a bigger file is uploaded by the machine to `_incoming/<project>/<host>/<uuid>` with its own key and named by `staged` (the uuid; `host` says whose). Up to 100 paths a request. `sha256` is checked against the bytes (`400 bad_body`).
- `max_delete` is the device's own (default 50): a commit with more deletes is refused whole (`409 max_delete`).
- `at_local` is the device's local time, for the name of a conflict copy.
- `outcome` is one of: `accepted` (the tree now holds the bytes, or the delete went; `version` is the path's new version); `merged` (the file is the merge; `merge` is `lines` or `tails`, and `kept_as` is the version id under which the device's own bytes are kept, absent for `tails`); `conflict` (the path keeps the first change, `conflict_path` holds the device's bytes, `why` is `not_mergeable`, `too_big`, `overlap` or `parse`); `edit_won` (the device's delete was not applied: another device changed the file; `version` is the winner, which the device pulls back).
- Refusals: `409 not_shared` (run `folder-sync share`), `409 private_path`, `409 max_delete`, `403 over_quota` (a commit that adds bytes; a commit that only deletes still goes), `400 bad_path | bad_body | bad_change | bad_staged | staged_missing`, `413 too_large`, `412 precondition_failed` (`X-Folder-Sync-Merge: never`), `503 busy | recovering`.

The shared tree is one more host to every other route: `GET …/folders/:project` lists it, `GET …/files/:host/<path>` opens its files, `…/history/:host/<path>` lists and opens its versions, `POST …/restore` writes a kept version back as a new version (by the folder's object, not by a machine's request), and `POST …/history/purge` purges them.

## The element: `<folder-sync-status>`

Every app embeds the same element with two lines, on its own origin:

```html
<script type="module" src="/fs/ui/v1/folder-sync.js"></script>
<folder-sync-status project="notes"></folder-sync-status>
```

It is a pill showing the folder's state; clicking it opens a menu (native `popover`) with **Files**, **Activity**,
**Version history**, **Deleted files**, **Storage** and a link to `/fs/account` (devices, visibility); each opens a
panel in a native `<dialog>`. Activity shows each sync's time beside its line (`↑ 0.4 s`, `↓ 1.3 s`, from `up_ms` and
`down_ms`). Version history shows a file's versions with **Show changes** (a line diff, jsdiff's
`diffLines`, vendored at `/fs/ui/v1/vendor/diff.js`), **Download** and **Restore**; Deleted files restores one or
many at once. Storage (online, the owner's) answers "what is in this account": used of quota and what most of it is,
a bar by kind, suggestions for what to free (shown, not yet doable), then project, kind and device, and the biggest
folders and files.

- **URL:** `/fs/ui/v1/folder-sync.js`, an ES module with no dependency beyond its own `/fs/ui/v1/` files; served by
  the Worker from its assets and by `serve` from the binary, the same bytes. `/fs/ui/v1/` takes fixes; a breaking
  change gets `/fs/ui/v2/`.
- **Attributes:**
  - `project` (required): the folder.
  - `owner` (optional): the owner's id, for a folder someone shared with you (sent as `?owner=`).
  - `folder` (optional): on a machine, the folder's path, for a project two folders on it sync (sent as `?folder=`,
    so the machine never answers `409 ambiguous_folder`; `serve`'s `/fs/` page sets it on each element).
  - `base` (optional, default `/fs`): where the app mounts folder-sync.
  - `view` (optional): `files`, `activity`, `history`, `deleted` or `storage` opens that panel at once and shows no pill (`serve`'s `/fs/`
    page, an app's "Sync details" window and `/fs/files` use it).
- **Methods:** `open(view, {host, path}?)` opens a panel (`history` with a `host` and `path` opens that file's
  versions, `files` with them opens that file); `close()`; `refresh()` reads `status` now.
- **Events** (bubbling, composed, on the element):
  - `folder-sync:status`, `detail` = the `status` body, each time it changes: an app can show its own indicator from
    it and hide the pill (`hidden` attribute).
  - `folder-sync:restored`, `detail` = the `restore_response` body, after a Restore.
  - `folder-sync:project`, `detail` = `{ project }`, when the Files tab's folder picker switches the folder: the element's
    `project` attribute is now that folder, so every tab follows it (`/fs/files` keeps `?project=` from it).
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

## The Files tab and the `/fs/files` page

Zach, 2026-11-04: the web **Files** page is "the only missing piece of the simplest Dropbox": a signed-in person
browses, opens, uploads, renames and deletes their synced files in a browser, with the browser's own preview. It is a
tab of the same element (first in the menu and the tab bar) and, full-page, `GET /fs/files`. **It adds no data
route**: it uses the ones above and PEP 0003 §3.3.

| What the tab does | Route |
|---|---|
| lists the person's folders (the picker) | `GET /fs/v1/folders` |
| lists a folder's files, every device's: `hosts` (`id`, `name`, `web`) and `files` (`host`, `path`, `size`, `sha256`, `mtime`, `writtenAt`) | `GET /fs/v1/folders/:project` |
| opens a file (image, PDF, video and audio by URL, text by `fetch`), and Download | `GET …/files/:host/<path>` |
| upload (button or drop), and the second half of a rename | `PUT …/web/<path>` (web host only; `403 csrf`, `409 wrong_user`, `413 too_large` over 32 MiB, `400` for a name the contract refuses, `403 over_quota`) |
| delete, and the last step of a rename | `DELETE …/web/<path>` (into the web host's history: Deleted files restores it for 30 days) |
| Version history of a file | the History tab, `open("history", {host, path})` |

- **Who may change what:** only the web host's files. Every other device's file is that device's to write (CONTRACT
  "Who writes"), so the tab shows "Written by <device>; edit it there." and no Rename or Delete; the web host's `PUT`
  and `DELETE` cannot name another host's path (`accounts/test/files-page.test.ts` proves a machine's objects and manifest
  stay byte for byte the same). A shared, editable tree is PEP 0010, not this tab.
- **Rename** is the three calls a client can make: read the bytes, `PUT` them at the new path, `DELETE` the old one. It
  refuses a name that already exists, and a failure after the `PUT` leaves the file twice, never zero times.
- **Preview** is by suffix and nothing else: image `png jpg jpeg gif webp svg avif bmp ico` (an `<img>`, so an SVG's
  script never runs), `pdf` (a frame on the file's own URL), video `mp4 m4v webm mov`, audio `mp3 wav ogg oga m4a flac
  aac opus` (native players), and text (`txt md json jsonl csv yaml toml log` and common source suffixes) as plain text in a
  `<pre>` up to 1 MiB, never markup. Anything else, a text file over 1 MiB and bytes that are not UTF-8 get **Download**.
- **Sort and filter:** by name (the default), modified or size inside each device's group, and a filter on the path.
- **Copy link** appears only in a public folder, where a link works for anyone (`?owner=<id>`); a private folder's file
  has no link that works for another person.
- **On a machine** (`serve` has no folder listing) the tab says to browse online and the menu does not list it.
- **The list is resizable:** the handle between the list and the file drags (and takes the arrow keys), and the width is
  remembered in `localStorage` (`folder-sync-status/files-split`). At 700 px wide or less the list and the file take
  turns, with a "← Files" button back.
- **`GET /fs/files`** is a shell: `/fs/site/files.js` signs-in-checks, picks the folder (`?project=` or the first) and mounts
  `<folder-sync-status view="files">` on it. Its Content-Security-Policy is the page policy plus what a preview needs and
  nothing else (`media-src 'self'`, `frame-src 'self'`, inline styles for the element's Shadow DOM); scripts, connections
  and frames stay `'self'` or `'none'`, and the page is never framed.

## Cut at acceptance (Unix scope)

Zach, 2026-10-28: keep it "super straight forward", "something that does 1 thing very well". These parts of PEP 0007's
draft are not in this API: a second `<folder-sync-panel>` tag, the Settings view (pause, device name, Disconnect,
rules, debug info), `GET …/events` on `serve`, `/fs/v1/local/*`, the Worker's `/fs/sync` page, `folder-sync ui`,
activity's `q=`, and the hub's `request` / `status` messages. PEP 0007 §13 lists them with the reason for each.
