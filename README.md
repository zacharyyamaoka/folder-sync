# folder-sync

Point it at any folder; that folder is now on every machine you use, and readable online.

- **Local files are the truth.** Any tool, editor or AI agent works on plain files in a plain folder. Nothing has to go through an app.
- **Sync across machines.** Linux, Windows and macOS, with one install command that an agent can finish unaided. It runs headless as a background service, or alongside an app.
- **Readable online.** Every synced folder can also be viewed on the web (read-only is fine), and an app's own web UI can read the same files. Vibe Tracks is the first user, through `vibetracks.dev`.
- **A drop-in for any project.** A folder plus a small config file, with ignore rules. Many projects per machine. A cloud agent joins by installing the CLI and logging in.

```text
folder-sync init      # this folder becomes a synced folder
folder-sync sync      # once, or as a background service
folder-sync publish   # make it readable online
folder-sync status    # last rounds; --json prints folder-sync-status/1 for apps
folder-sync projects  # the projects under the key's account root (one LIST): what a new machine can join
```

The design is [`docs/peps/0001`](docs/peps/0001-wrap-rclone-and-r2.md) (accepted): rclone moves the files, one Cloudflare R2 bucket is the always-on copy, R2-Explorer is the web backdoor, and a thin Go binary owns the rest. Apps read projects through [the bucket contract](docs/CONTRACT.md): "the folder is the database".

## Install (v0: from source)

```bash
~/.local/go/bin/go build -o ~/.folder-sync/bin/folder-sync ./cmd/folder-sync
```

On first `init`, folder-sync downloads the pinned rclone v1.75.2 from downloads.rclone.org into `~/.folder-sync/bin/`, checks its SHA-256 against the pin compiled into the binary, and refuses on a mismatch. Everything it keeps lives in `~/.folder-sync/`, never in AppData and never in `~/.config/rclone` (every rclone call is told its config path). The one exception is the macOS launchd plist, below. Cross-compile for Windows with `GOOS=windows GOARCH=amd64 go build -o dist/folder-sync.exe ./cmd/folder-sync`.

## Quick start

Give it a bucket-scoped R2 key, through the environment (cloud agents) or once with `folder-sync login --key` (stored in `~/.folder-sync/credentials.json`, mode 0600; plain `login` signs in to an account instead, below):

```bash
export FOLDER_SYNC_ACCOUNT_ID=… FOLDER_SYNC_ACCESS_KEY_ID=… FOLDER_SYNC_SECRET_ACCESS_KEY=…
```

Then, in the folder:

```bash
folder-sync init --project notes --bucket folder-sync
folder-sync sync --watch
```

Each machine publishes its own files to `<project>/hosts/<host-id>/` and receives its peers' files, read-only, in `<folder>/hosts/<host-id>/`. `folder-sync status` shows the last push, pull and clean run, peers, skipped names and conflicts. `folder-sync sync --install-service` writes a systemd user unit, a Task Scheduler task or a launchd agent and prints the one command that enables it. The unit and task file live in `~/.folder-sync/service/`; the macOS plist goes to `~/Library/LaunchAgents/`, the only place launchd reloads at login, so it survives a reboot. `folder-sync publish --viewer` writes the R2-Explorer Worker config (read-only, behind Cloudflare Access, `workers_dev` and previews off) and prints its deploy command.

### Short-lived credentials

Instead of a stored key, `FOLDER_SYNC_CREDENTIAL_PROCESS` can name a program (a JSON array, its argv, `argv[0]` absolute) that prints short-lived keys scoped to one account prefix: AWS's `credential_process` JSON (`Version` 1, `AccessKeyId`, `SecretAccessKey`, `SessionToken`, `Expiration`) plus optional `Endpoint`, `Bucket` (the only bucket these keys can use), `Prefix` (the account root, like `users/AbC123/`), `Region` and `Provider`. folder-sync runs it before every round, caches the answer in `~/.folder-sync/session.json`, and syncs under that prefix ([`docs/CONTRACT.md`](docs/CONTRACT.md), "Bucket layout"). Exit 3 means signed out (`sync --once` then exits 4); any other failure is transient and still-valid cached keys carry on. `sync --once` exits 75 when another round holds the folder. An app that signs a person's next machine in asks `folder-sync projects --json` which folders that person already syncs, and `sync --discover` looks for new machines at once instead of within 5 minutes ([`docs/peps/0002`](docs/peps/0002-short-lived-scoped-credentials.md)).

### Accounts: sign in instead of pasting a key

folder-sync has its own accounts ([`docs/peps/0003`](docs/peps/0003-accounts.md)): one sign-in across every app that syncs a folder (robotparts.dev first), served by the `accounts/` Worker (Better Auth on Cloudflare Workers + D1), mounted at `/fs/` on each app's own domain.

```text
folder-sync login [--server URL]     sign this machine in: open the printed link, approve the code in your browser
folder-sync whoami                   who this machine is signed in as, and its account root (users/<id>/)
folder-sync credentials              the credential-process JSON (short-lived keys for users/<id>/); exit 3 signed out
folder-sync publish --public         anyone can read this folder online; --private undoes it
folder-sync logout                   end this machine's session on the server, then delete account.json
folder-sync login --key              v0's stored bucket key instead (credentials.json)
```

The server is `--server`, else `FOLDER_SYNC_SERVER`, else the accounts Worker's own host; an app prints its own (`folder-sync login --server https://robotparts.dev`) so the approving browser is usually signed in already. The session is kept in `~/.folder-sync/account.json` (`folder-sync-account/1`, mode 0600). Once it exists, and neither `FOLDER_SYNC_CREDENTIAL_PROCESS` nor a key is set in the environment, folder-sync runs its own `credentials` as the credential process, so the short-lived keys, their cache and their exit codes are PEP 0002's, unchanged; a key in the environment still wins, and a signed-in machine no longer uses a stored `credentials.json`.

Run the Worker locally (rclone serve s3, the R2 stand-in, `wrangler dev` with a local D1 and generated test keys): `npm install --prefix accounts`, then `node accounts/scripts/dev.mjs up` (`down` stops exactly what it started). Its tests: `node --test accounts/test/worker.test.ts` and the end-to-end proof `node accounts/test/proof.mjs` (ports 4930-4932).

### Try it with no cloud account

These assume the checkout is at `~/folder-sync`; Go is on your `PATH`, or at `~/.local/go/bin`.

```bash
"$HOME/folder-sync/scripts/dev-tools"
PATH="$HOME/.local/go/bin:$PATH" go -C "$HOME/folder-sync" test ./...
```

`scripts/dev-tools` fetches the pinned rclone for Linux (amd64, arm64) or macOS (Intel, Apple silicon) into `.tools/`, checked against the same SHA-256 table `init` uses (`internal/rclonebin/install.go`). On Windows, use `folder-sync init`.

The end-to-end test (`e2e/`) runs two simulated machines (two HOME dirs, two folders) against `rclone serve s3` on 127.0.0.1:4801 with throwaway keys, through a counting proxy on :4802. It needs:

- `.tools/rclone` from `scripts/dev-tools`, or the whole suite skips.
- `python3` with the `jsonschema` module (`python3 -m pip install jsonschema`) for the manifest-schema check. macOS's stock `python3` (3.9) does not ship it; without it that one subtest skips and says so.
- `node` ≥ 22.18 for the Worker-reader check, which skips without it.
- Ports 4801 and 4802 free.

On a case-insensitive folder (the macOS default) `README.md` and `readme.md` are one file, so the case-twin checks are skipped there and the single file is expected to upload.

## Latency KPI

How long a file takes from a machine's disk to being served online (`sync_up_ms`), and from an online write to a machine's disk (`sync_down_ms`): Zach's key number for this project (2026-10-28). `bench/latency/bench.mjs` measures both as a black box, through the CLI exactly as a person runs it (`init`, then `sync --watch`), so a faster CLI or Worker moves the number without touching the bench:

- **up:** write `bench/<id>.txt` into the synced folder; stop when `GET /fs/v1/folders/<project>/files/<host>/bench/<id>.txt` serves the same bytes (polled every 50 ms). That route is what a page, or anyone reading the folder online, gets.
- **down:** `PUT /fs/v1/folders/<project>/web/bench/<id>.txt` (the web host: the call a page makes to save); stop when `<folder>/hosts/<web host>/bench/<id>.txt` holds the same bytes (polled every 10 ms).

10 trials each way, each at a random phase of the folder's `interval`; the p50, p95 and max go into Vibe Tracks (`~/vt/zach/producers/folder-sync/`: `kpi_catalog.json`, `kpi_series.jsonl`, `runs_table.jsonl`; the data never goes in git). Two stacks, one chart line each:

```bash
node bench/latency/bench.mjs run --stack local
node bench/latency/bench.mjs run --stack prod
```

`local` stands the whole stack up on loopback with `accounts/scripts/dev.mjs` (ports 4950-4953; it needs `npm install --prefix accounts`, Go and the pinned rclone), signs a test person and a throwaway HOME in, and deletes it all afterwards. It is the headline, run hourly. `prod` uses this machine's own signed-in session (`~/.folder-sync/account.json`) in one throwaway project, `bench-latency` (folder `~/.local/share/folder-sync-bench/bench-latency`), and deletes its trial files at the end. `--no-kpi` measures without writing; `--json FILE` keeps every trial.

The hourly run is a systemd user timer; this writes `folder-sync-latency.{service,timer}` for the checkout it is run from and enables it (run it again from another checkout to re-point it):

```bash
node bench/latency/bench.mjs install-timer
```

## What is real and what is pending

| | State |
|---|---|
| `init`, `login`, `sync --once`, `sync --watch`, `status`, `publish` | Built, tested end to end against a local S3 stand-in |
| Accounts: `login` (device grant), `credentials`, `whoami`, `logout`, `publish --public/--private`, the `accounts/` Worker and its web host | Built; tested end to end locally (`accounts/test/proof.mjs`: `wrangler dev`, local D1, the R2 stand-in). **Not deployed**: the D1 database, the secrets and Google's OAuth client are Zach's |
| Push from the manifest diff, pull by conditional GET, `_trash/` on overwrite and delete, `max_delete`, empty-folder guard | Built and tested |
| Ignore rules (gitignore syntax → rclone filters) | Built; tested against `git` itself as the oracle |
| Windows paths, reserved names, case twins, nothing in AppData | Unit-tested on Linux; the Windows binary cross-compiles. **Not yet run on Windows** |
| `sync --install-service` | Writes the unit / task XML / plist and prints the command; never registers anything |
| `publish --viewer` | Writes the R2-Explorer config and prints the deploy command; never deploys |
| Two-way `shared/` folders (bisync under a lease) | v1. v0 refuses a `shared` mode with a clear error |
| **Real R2** | **Pending Zach**: `scripts/check-r2` (mtime round trip, conditional writes through rclone). Against the stand-in, mtimes pass and conditional writes fail, because the stand-in ignores those headers |
| **Task Scheduler run on the Windows box** | **Pending Zach**: `scripts\check-windows-task.cmd` |
| Lifecycle rule on `_trash/` (30 days; no bucket lock: PEP 0003 §3.7), budget alert | Pending Zach, in the R2 dashboard. It only ever matches v0 bucket-key folders (empty root): a rule matches a literal prefix, so a signed-in person's `users/<id>/_trash/` never matched it; the folder's Durable Object expires that 30 days after its stamp (PEP 0007 §1.4) |

### The real-R2 check (Zach)

1. In the Cloudflare dashboard → R2 → Create bucket `folder-sync` (location: automatic). Leave public access off: no r2.dev URL, no custom domain.
2. R2 → Manage API tokens → Create API token: permission "Object Read & Write", applied to the `folder-sync` bucket only. Copy the access key id and secret (shown once) and the account id.
3. Run:

   ```bash
   export FOLDER_SYNC_ACCOUNT_ID=<account id> FOLDER_SYNC_ACCESS_KEY_ID=<key id> FOLDER_SYNC_SECRET_ACCESS_KEY=<secret> FOLDER_SYNC_CHECK_BUCKET=folder-sync
   "$HOME/folder-sync/scripts/check-r2"
   ```

   It writes and then deletes two objects under `_checks/<stamp>/`. All five lines should say PASS.
4. While there: R2 → the bucket → Settings → Object lifecycle rules → delete objects with prefix `_trash/` after 30 days; Bucket locks → prefix `_trash/`, 30 days; and a budget alert at a few dollars a month.

### The Windows check (Zach, on the Windows box)

1. Build on Linux: `GOOS=windows GOARCH=amd64 ~/.local/go/bin/go build -o dist/folder-sync.exe ./cmd/folder-sync`, and copy it to `C:\Users\BAM\.folder-sync\bin\folder-sync.exe`.
2. In `cmd.exe` (not PowerShell: AllSigned), with the key set via `set FOLDER_SYNC_…=…`: `folder-sync.exe login --key`, then `folder-sync.exe init --project wincheck --bucket folder-sync --dir C:\Users\BAM\wincheck`. If Defender or Smart App Control blocks rclone, init says so and stops; adding an exclusion is your call.
3. Run `scripts\check-windows-task.cmd C:\Users\BAM\wincheck`. It registers a one-off task, runs one round from Task Scheduler, checks the log in `%USERPROFILE%\.folder-sync\logs` and that nothing appeared under AppData, and deletes the task.

## What it does not do (in the spirit of Unix)

- It does not understand what's in the files. Apps like Vibe Tracks do that.
- It does not reinvent a sync engine where a stock one is good enough. It wraps the engine and owns only the missing piece: one simple command line, a Windows-safe install, per-project config, and the online read view.

## Status

Started 2026-10-20 as a separate project, split out of Vibe Tracks (Zach: "clearly a separate functionality that I can get right once and then reuse"). PEP 0001 was accepted the same day, with BearDrive as the reference product; v0 is built on branch `claude/folder-sync-v0`.

The name is literal on purpose, like `stable_preview_switcher`: a plain repo name, not a brand. An unrelated Android app is also called FolderSync (foldersync.io).
