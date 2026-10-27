# 0003 · Accounts: sign in to folder-sync, on the web and from the command line

- **Date:** 2026-10-26
- **Status:** proposed, built on branch `lane/accounts` (cut from `claude/folder-sync-v0` 0b20f06, the branch that
  holds the code; `main` holds only PEP 0001). Final when Zach merges it.
- **Source:** Zach, 2026-10-26: "I think you should add account logins to folder sync instead of using simple hosted
  files for that logic." Before that, for robotparts: "File first is the basis, everything else is just an add on… having
  it local or online and all synced is ideal… so now it's like folder sync… we should implement accounts for robotparts
  that you can log into, and also have this sync completely set up."
- **Builds on** PEP 0002 (a credential process prints short-lived keys scoped to an account root `users/<id>/`). 0002
  left *who signs a person in* to each app; Vibe Tracks answered it with its own Better Auth Worker (vibetracks PEP
  0011b). This PEP moves that answer into folder-sync, so every app that syncs a folder shares one account.

## 1. What a good answer looks like (weights first)

| Criterion | Weight | Why |
|---|---|---|
| Off-the-shelf: nothing per person hand-rolled (sessions, OAuth, device codes, password-free) | 25 | Zach's first rule: the stock part, then only the missing piece |
| A machine signs in without a pasted storage key (CLI device login) | 20 | "replaces the raw bucket-scoped R2 key with the user's own session" |
| Works for many apps on their own domains (robotparts.dev, vibetracks.dev) with one account | 15 | one account across Zach's apps |
| Runs where the storage keys are minted: Workers + D1 | 15 | the minter needs the R2 parent key; one Worker, one secret set |
| Anyone can sign up with Google (not seat-limited) | 15 | robotparts.dev is a public site |
| Already proven in Zach's own stack | 10 | Simple Hosted Files and Vibe Tracks both run it in production |

## 2. The auth part, weighed

| Option | Off-shelf (25) | CLI login (20) | Many apps (15) | Workers+D1 (15) | Public Google (15) | Proven (10) | Score |
|---|---|---|---|---|---|---|---|
| **Better Auth** (Google, `bearer`, `deviceAuthorization` RFC 8628, `oneTimeToken`, `emailOTP` in dev; D1) | 25 | 20 | 12 | 15 | 15 | 10 | **97** |
| Cloudflare Access (Zero Trust, Google IdP, `Cf-Access-Jwt-Assertion`) | 22 | 10 (`cloudflared access login`, an extra install) | 12 | 15 | 4 (seats: a team product, no self sign-up page) | 8 (the R2-Explorer backdoor) | 71 |
| Auth.js (`@auth/core` on Workers, D1 adapter) | 18 | 0 (no device grant: hand-rolled) | 10 | 12 | 15 | 0 | 55 |
| A Worker + a stock OAuth library (arctic/oslo) | 8 (sessions, device codes, schema all ours) | 4 | 10 | 15 | 15 | 0 | 52 |
| Lucia | 0 (deprecated as a library in 2025; now a guide to writing it yourself) | 4 | 10 | 15 | 15 | 0 | 44 |

**Chosen: Better Auth**, the same version Vibe Tracks pins (1.7.11). Cloudflare Access keeps its one job: the read-only
R2-Explorer backdoor and Vibe Tracks' Access-gated shares, which are for Zach, not the public. Many-apps loses 3 points
because Better Auth's `baseURL` is per host, so the Worker keeps one instance per registered origin (Simple Hosted Files
v2.9 does the same).

## 3. Decision

### 3.1 The accounts Worker (`accounts/` in this repo)

One Cloudflare Worker, `folder-sync-accounts`, with:

- **D1** `folder-sync-accounts`: Better Auth's tables (`user`, `session`, `account`, `verification`, `deviceCode`) plus
  three of ours (`accounts/migrations/0001_accounts.sql`):
  - `folder(owner_id, project, visibility 'private'|'public', updated_at)` — a row only once a folder is published or
    shared; no row = private.
  - `folder_reader(owner_id, project, reader_email, created_at)` — who else may read a private folder.
  - `web_host(owner_id, project, host_id, created_at)` — the folder's web writer (§3.4).
- **A Durable Object per folder's web host** (`WEB_HOST`): its one writer (§3.4).
- **No R2 binding.** It reads and writes through R2 temporary credentials it signs for exactly one prefix per request
  (vibetracks `worker/src/creds.ts`, moved here unchanged in spirit: HS256 JWT, `prefixPaths`, secret = sha256(jwt),
  session token = base64("jwt/"+jwt)). The parent R2 key is its only storage secret.
- **An app registry**, `accounts/apps.json`: `{ "<app id>": { "name", "origins": [..], "project": "<default project>" } }`.
  An origin not listed gets no CORS, no sign-in and no cookie routes.

### 3.2 Mounted on each app's own domain at `/fs/`

An app's domain forwards `/fs/*` unchanged (method, body, cookies, `Origin`) to this Worker through a **service binding**
(the app's Worker: `assets.run_worker_first: ["/fs/*"]` and `return env.FOLDER_SYNC.fetch(request)` for those paths).
WHY on the app's domain and not a shared accounts domain:
- pages then call only their own origin (robotparts' rule: a page loads only robotparts.dev's own files);
- the session cookie is host-only on the app's domain, so no third-party cookies and no token in page JavaScript;
- one Google OAuth client lists each app's callback `https://<app>/fs/api/auth/callback/google`; Google's `sub` is the
  same across them, so one person is one user everywhere (one D1).

The Worker also answers on its own host (workers.dev or a later domain) with the same paths, for the CLI and the
account page.

### 3.3 HTTP API (everything under `/fs`; JSON; errors `{ "error": "<code>", "why": "<sentence>" }`)

Sessions: a browser sends its cookie; a machine or an app server sends `Authorization: Bearer <session token>`.
**A cookie-authenticated write must carry `X-Folder-Sync: 1` and a same-origin `Origin`** (CSRF: a cross-site form
cannot set a header).

| Route | Who | Answer |
|---|---|---|
| `/fs/api/auth/*` | anyone | Better Auth (Google; `emailOTP` only when `ENVIRONMENT=dev`) |
| `GET /fs/signin?return=<same-origin path>` | browser | the sign-in page (Google button; dev: email + code); back to `return` signed in |
| `GET /fs/device` | browser | approve a machine's code (RFC 8628 verification page) |
| `GET /fs/dev/mailbox?email=` | loopback + dev only | `{ email, code }`, the last sign-in code |
| `GET /fs/v1/me` | session | `{ user: {id,email,name,image}, root: "users/<id>/", app: {id, project} \| null }` |
| `POST /fs/v1/sign-out` | session | ends this session (cookie cleared, or the bearer's session deleted) |
| `GET /fs/v1/folders` | session | `{ folders: [{project, visibility, hosts}], readable: [{owner, project, role}] }` |
| `GET /fs/v1/folders/:project[?owner=<id>]` | owner, reader, or anyone if public | the union view: `{ project, owner, visibility, hosts: [{id, name, seq, generatedAt, web}], files: [{host, path, size, sha256, mtime, writtenAt}] }` |
| `GET /fs/v1/folders/:project/bundle?prefix=<p>[&owner=]` | same | `{ files: [{host, path, mtime, sha256, text}] }`, UTF-8 files under `prefix`, ≤ 256 KB each, ≤ 2 MB total (one request for an app's small files) |
| `GET /fs/v1/folders/:project/files/:host/<path>[?owner=]` | same | the bytes (`ETag: "<sha256>"`, `Cache-Control: private, no-store` unless public) |
| `PUT /fs/v1/folders/:project/web/<path>` | owner | writes `<path>` into the folder's web host (§3.4) → `{ host, path, sha256, seq }` |
| `DELETE /fs/v1/folders/:project/web/<path>` | owner | removes it from the web host (moved to `_trash/`) → `{ host, path, seq }` |
| `PATCH /fs/v1/folders/:project` `{visibility}` | owner | `"public"` or `"private"` → the folder row |
| `POST /fs/v1/folders/:project/readers` `{email}` / `DELETE …/readers/:email` | owner | grants / revokes read |
| `GET /fs/v1/access?project=&owner=` | session | `{ allowed, role: "owner"\|"reader"\|"public"\|null, root }` — for an app's own server |
| `POST /fs/v1/credentials` | **bearer only** | AWS `credential_process` JSON + `Endpoint`, `Bucket`, `Prefix: "users/<id>/"`, read-write, 15 min (a browser cookie never gets storage keys) |

`:project` matches the contract's `^[a-z0-9][a-z0-9._-]{0,62}$`; `<path>` follows the contract's path rules; anything
else is 400. The root is always the session's (`users/<id>/`), never a URL's, body's or header's. A public folder's
reads are signed for `users/<owner>/<project>/` only.

### 3.4 The web host: how a browser writes without breaking single-writer

The bucket contract says only folder-sync writes `hosts/<host-id>/`, one writer per host. A browser has no folder, so
the accounts Worker **is** a folder-sync host for each (person, project): it mints a host id on first write
(`web_host` row; a lowercase UUID v4, `host_name: "web"`), writes files then the manifest exactly as a round does
(changed objects first copied to `_trash/`), and writes the manifest with `If-Match` on its last ETag, retrying from a
fresh read on 412 (R2 honours conditional PUTs; the local stand-in does not, PEP 0001's known gap). Every machine pulls
it like any peer, read-only, into `<folder>/hosts/<web-host-id>/`.

**One writer per web host, as per machine host** (review r1 #3): every write and delete of one (person, project) runs
in that folder's Durable Object (`WEB_HOST`, `src/webhost-do.ts`), one at a time, so no two interleave their file and
manifest steps. A change journals what it is about to touch (in the object's storage); if its manifest PUT fails or it
is cut off, the file goes back to the bytes the manifest lists (from the trash copy, or deleted when the path was new),
at once or first thing in the folder's next write. So every object always matches its manifest's sha256. Each trash
copy's stamp is the contract's UTC stamp plus the millisecond and a nonce, so two replacements in one second keep both.
WHY a queue and not new bytes under a content-addressed key the manifest points at: every reader reads
`hosts/<host>/<path>` and checks it against the manifest, and a second layout would change the contract for all of
them. `docs/CONTRACT.md` "Who writes" gains this one
sentence. WHY not v1's two-way `shared/`: it needs the lease, which is not built; the web host needs nothing new from
the sync engine and keeps every rule.

### 3.5 The command line

- `folder-sync login [--server URL]` (default `$FOLDER_SYNC_SERVER`, else the production accounts URL): the device
  grant. It prints the code and `<server>/fs/device?user_code=…`, polls, and stores `~/.folder-sync/account.json`
  (`folder-sync-account/1`: server, token, user; mode 0600). An app prints its own mount
  (`--server https://robotparts.dev`) so the approving browser is usually already signed in there.
- `folder-sync login --key` keeps v0's stored bucket key (and the key in the environment still wins, unchanged).
- `folder-sync credentials` prints the credential-process JSON from `POST /fs/v1/credentials` (exit 3 when signed out
  or revoked). **When `account.json` exists and no `FOLDER_SYNC_CREDENTIAL_PROCESS` or key is set, folder-sync uses
  itself as the credential process**, so 0002's cache, refresh, exit codes and root rules apply unchanged.
- `folder-sync logout` (deletes the session on the server, then the file), `folder-sync whoami`.
- `folder-sync publish --public | --private` sets the folder's visibility through `PATCH`; `publish --viewer` is unchanged.

### 3.6 What an app does

1. Register: one entry in `accounts/apps.json` (id, name, every exact origin, default project).
2. Its Worker forwards `/fs/*` through a service binding to `folder-sync-accounts` (a dozen lines).
3. Pages link to `/fs/signin?return=…`, read `/fs/v1/me`, and read and write the folder through `/fs/v1/folders/...`.
   The app owns its file formats; folder-sync owns accounts, storage and sync.
4. Its users run `folder-sync login --server https://<app>` and `folder-sync init --project <project>` to get the same
   folder on disk; their agents edit plain files there.

## 4. Vibe Tracks, to switch (not done here)

- Replace `worker/src/auth.ts` and `creds.ts` with the `/fs/*` forwarder; register `vibetracks` in `apps.json`.
- Move its D1 `user`/`account`/`session` rows into `folder-sync-accounts` **keeping the ids**, so every `users/<id>/`
  prefix and every signed-in machine stays valid; then drop its own `BETTER_AUTH_SECRET` and R2 parent key.
- `vt login` runs `folder-sync login --server https://vibetracks.dev`; vt's credential process becomes folder-sync's
  own (`sync.py:653-672` stops setting `FOLDER_SYNC_CREDENTIAL_PROCESS`).
- `/me/<space>/…` reads through `/fs/v1/folders/<space>/files/…`; the Access-gated `/s/` shares are unchanged.
- Its invite list (`SIGN_UP_EMAILS`) becomes the accounts Worker's (§6).

## 5. What does not change

The bucket layout, the manifest, the credential-process shape (0002), the stand-in, and v0's key login.

## 6. Open, with the default taken

- **Who may sign up.** Default: `SIGN_UP_EMAILS` like Vibe Tracks (unset = nobody new, `*` = anyone). Recommended `*`
  for robotparts.dev once Zach is happy with the public sign-in; until he sets it, only listed emails get accounts.
- **Organisations** (robotparts' "only for our organisation"): v1 here is per-person readers (`folder_reader`). An org
  is a later `orgs/<id>/` root with members; not built.

## 7. Revisit when

- R2 answers conditional manifest writes differently from its docs (the web host's retry loop rests on them).
- Two-way `shared/` folders land: the web host can write there instead.
