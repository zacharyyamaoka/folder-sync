# 0001 · Wrap, don't adopt or build: rclone moves files, one R2 bucket is the always-on copy, a stock viewer shows it

- **Date:** 2026-10-20
- **Status:** accepted 2026-10-20. Zach: "BearDrive is awesome — that is exactly what we want. It's basically like a Google Drive, but we want to expose it so it's easy to integrate into your apps, for file-first software: the folder is the database... the stock web viewer is great, just so you have the backdoor, but eventually you'll use it in your own app... please proceed and build this out."
- **Reference product:** BearDrive ("Google Drive for AI agents"). It has no Windows build, and its maintainers declined a port. Our difference is that apps are first-class readers: the bucket layout and the manifests are a public contract, so any app can read a project's files. The stock viewer is only the backdoor.
- **Source:** Zach, Oct 20: "Let's start this as a separate project, in the spirit of Unix … We shouldn't reinvent the wheel if we don't need to." The README's promises are: local files are the truth; sync across Linux, Windows and macOS with an install an agent can finish; readable online; a drop-in per project.

## Decision

1. **Wrap.** Don't adopt a product, and don't build an engine.
   - **Not adopt:** nothing scored meets the README's promises today. The two leaders each miss one structurally (scores above).
   - **Not build:** transfer, retries, checksums and conflict detection are where reliability lives. rclone has had them for a decade [1].
2. **The stock parts:**
   - **Engine:** rclone ≥ 1.75.2 (MIT), pinned and checksum-verified, never the distro package. The workstation's apt build is 1.60.1, which predates the bisync redesign and conditional uploads [2,3].
   - **Storage:** one Cloudflare R2 bucket [4].
   - **Web view:** R2-Explorer (MIT), pinned or forked, behind Cloudflare Access [5,6].
3. **The bucket layout is the contract** (the "port"):
   - `<project>/hosts/<host-id>/…` holds files written by that machine only.
   - `<project>/hosts/<host-id>/manifest.json` lists path, size, mtime, sha256 and written-at for that machine's files.
   - `<project>/shared/…` is two-way. It is not in v0.
   - `_trash/<project>/<host-id>/<UTC-stamp>/…` holds every overwritten or deleted object.
   - `_leases/<project>.json` is the shared folder's lock (v1).
   - `<host-id>` is a UUID minted on each machine's first `init` and kept in `~/.folder-sync/`, never in the project's config, with a readable name beside it. A copied project folder or config can never make two machines the same host. Cloud sessions get a per-session id and push with `copy` (no deletes).
4. **The manifest is the diff engine; the remote is never listed on every round.**
   - **Push:** compare local stats against this machine's last manifest. Upload only the changed files (`rclone copy --files-from … --no-traverse`), then rewrite the manifest.
   - **Pull:** a conditional GET of each other machine's manifest, then fetch only what changed.
   - **Safety net:** a full listing reconcile runs at start and hourly.
   - **Why:** the falsification pass priced a stock `rclone sync` every 10 s at about $20k/month in R2 operations for 5 machines × 5,000 files. The manifest-driven version stays inside the free tier.
5. **Nothing is lost without a copy.**
   - Every sync passes `--backup-dir` into `_trash/…/<UTC-stamp>/`.
   - A lifecycle rule expires `_trash/` after 30 days, and an R2 bucket lock on `_trash/` stops anyone deleting it sooner [7,8].
   - Every sync carries `--max-delete`. An empty or unmounted source can't wipe a prefix.
   - R2 has no object versioning; this is the substitute [9].
6. **Two-way editing (v1) runs only under a lease.** The lease is an object in `_leases/`:
   - **Take:** a conditional PUT (`If-None-Match: *`). R2 evaluates it atomically [10], and rclone ≥ 1.72 can send the header [3].
   - **Take over a stale lease:** `If-Match` on its ETag.
   - **Expiry:** judged by R2's clock, not the local one, and longer than rclone's `--max-duration`.
   - **Release:** by conditional overwrite, never by delete. R2 deletes take no conditions.
   - **Holder:** host-id + pid + nonce.
   - **Then:** `rclone bisync --recover --resilient --max-lock 2m --check-access --max-delete 25` [11].
   - **Why it waits for v1:** bisync's own lock is local and racy (#9793), and it still has open bugs (#9416) [12,13].
7. **Windows-safe by construction.**
   - **Where things live:** the rclone binary, its config, cache and bisync workdir, the token and the state all live in `~/.folder-sync/`. Every rclone call passes `--config`, `--cache-dir` and `--workdir`.
   - **Why not AppData:** rclone's defaults are `%APPDATA%` and `%LOCALAPPDATA%` [14,11]. winget's portable packages also land under `%LOCALAPPDATA%`. Claude Desktop's MSIX package silently virtualizes writes there, so they're visible only to the writing process tree [15,16,17].
   - **Autostart:** a long-running `sync --watch` started at logon. Task Scheduler can't repeat more often than once a minute [18]. The install proves itself from a scheduled run that writes a log into `~/.folder-sync/`.
   - **Linux** gets a systemd user unit.
8. **The wrapper is one native binary (Go).**
   - **Why native:** a PowerShell script would hit the box's AllSigned policy [17]. Python brings back the venv and `%APPDATA%` installs that broke VT-070 [19,20].
   - **Why Go:** it's the same language as rclone. It can later embed rclone (librclone, an experimental API) [21], though v0 shells out to the pinned binary.
9. **Cloud agents** install the binary and run `folder-sync sync --once` at start and end. No daemon and no FUSE.
   - **v0 credential:** a bucket-scoped R2 key in environment variables.
   - **v1 credential:** a short-lived R2 temporary credential limited to the agent's own prefix [22]. A small Worker mints it, and the VM calls that Worker with a Claude cloud network secret, so the parent key never enters the VM [23].

## Command line

```text
folder-sync init      # this folder becomes a synced folder
folder-sync sync      # once, or as a background service
folder-sync publish   # make it readable online
```

- **`init [--project NAME] [--bucket NAME]`**
  - Writes `.folder-sync.toml`: project, bucket, ignore rules in gitignore syntax translated to rclone filters [24], and the subfolder modes.
  - Mints the host id and checks the key with one HEAD.
  - Default ignores: `.git/`, `node_modules/`, `.env`, `*.pem`, `id_*`, `*.key`, and anything always held open.
- **`sync [--once | --watch] [--install-service]`**
  - One round, or a loop: push changes, pull peers, write `last-sync.json`.
  - `--install-service` writes the systemd user unit or the Task Scheduler task.
- **`publish [--viewer]`**
  - Makes the project readable online. It ensures the manifests are current, and the first time it deploys R2-Explorer with wrangler behind Access.
  - Hardening: `cfAccessTeamName` set, `workers_dev` and preview URLs off, and no public domain on the bucket itself [25,26].
  - Prints the viewer address.
- **Also:**
  - **`status`:** last push, last pull, last clean run, conflicts and skipped files, per project.
  - **`login`:** stores the key in `~/.folder-sync/`, or reads it from environment variables.

## What it does not do

- Merge file contents, or render, index or search them. That's the viewer's job, or the app's.
- Run a server of its own. Cloudflare runs the only server-shaped parts.
- Encrypt. Online viewing excludes it; keep secrets out of the folder.
- Carry code. That's git.
- Know any app. Vibe Tracks reads a folder and the manifests; nothing imports the other way.

## Safety rules from the falsification pass

- **A file held open on Windows** makes `rclone sync` skip every delete in that run [27]. Always-open files go in the ignore rules, and `status` shows the last clean run. Never use `--ignore-errors`.
- **Lint names at push:**
  - case-only twins (`README.md` beside `readme.md`);
  - Windows-reserved characters, which rclone would otherwise rewrite to look-alikes [28].
- **Antivirus:** if Defender or Smart App Control blocks rclone or the wrapper, `init` says so and stops. Adding an exclusion is Zach's to do, never the agent's [29].
- **Budget:** set a Cloudflare budget alert at a few dollars a month.

## Why

- **Adopt was rejected:**
  - Syncthing has no cloud copy, so it fails the online view and cloud agents.
  - BearDrive has no Windows build and a hashed-blob bucket.
  - Obsidian Sync has no web view or API.
  - Nextcloud, the falsification pass's one real contender, means running a PHP server. It loses on Cloudflare integration and agent installs, and wins only on multi-writer conflicts and undo.
- **Build was rejected:** "what you pay for is reliability." A decade of rclone is that reliability.
- **What wrapping keeps:** the online copy as plain paths. The bucket is readable by any S3 tool, and the exit is one `rclone copy`.

## Revisit when

- **BearDrive ships Windows.** Re-score it.
- **Two-way editing becomes the main use.** Weigh Syncthing and Nextcloud again.
- **R2 implements object versioning.** Drop `_trash/` in favour of it.
- **Cloudflare Artifacts leaves beta, and git semantics are wanted for text.**

## Sources

Research behind this record: vault note "Local-Online File Sync — What Exists and What to Build (2026-10-20)".

1. rclone latest release — v1.75.2, 2026-10-09 — https://github.com/rclone/rclone/releases
2. rclone changelog — bisync promoted from beta to stable in v1.71.0 — https://rclone.org/changelog/
3. rclone commit 83b83f776 — S3 uploads accept If-Match / If-None-Match headers (v1.72) — https://github.com/rclone/rclone/commit/83b83f776
4. R2 pricing — $0.015/GB-mo, Class A $4.50/M (incl. ListObjects), Class B $0.36/M, $0 egress — https://developers.cloudflare.com/r2/pricing/
5. R2-Explorer (G4brym) — MIT, v1.2.0 2026-04-09, read-only by default, Access or basic auth — https://github.com/G4brym/R2-Explorer
6. Cloudflare Zero Trust plans — Access free up to 50 users — https://www.cloudflare.com/plans/zero-trust-services/
7. R2 object lifecycles — expire a prefix — https://developers.cloudflare.com/r2/buckets/object-lifecycles/
8. R2 bucket locks — prefix retention that blocks overwrite and delete — https://developers.cloudflare.com/r2/buckets/bucket-locks/
9. R2 S3 API compatibility — no bucket versioning; conditional PUT supported — https://developers.cloudflare.com/r2/api/s3/api/
10. R2 consistency — strong read-after-write and list; atomic conditional writes — https://developers.cloudflare.com/r2/reference/consistency/
11. rclone bisync docs — flags, local lock, no watch mode, limitations — https://rclone.org/bisync/
12. rclone issue #9793 — non-atomic bisync lock file — https://github.com/rclone/rclone/issues/9793
13. rclone #9416 — bisync deadlock with --fast-list (open) — https://github.com/rclone/rclone/issues/9416
14. rclone docs — config file location (Windows: %APPDATA%), env-var remotes — https://rclone.org/docs/
15. claude-code #83032 — shell writes under %LOCALAPPDATA% silently virtualized (closed, not planned) — https://github.com/anthropics/claude-code/issues/83032
16. MSIX — how packaged desktop apps virtualize AppData — https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes
17. Windows / Fusion box reference (MSIX virtualizes AppData, AllSigned, GitHub Desktop auth) — vault: reference_windows_fusion_box
18. Task Scheduler repetition interval — minimum one minute — https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-interval-repetitiontype-element
19. Vibe Tracks worker setup — the Windows install steps and traps — file:///home/bam/vibetracks/docs/remote/WORKER_SETUP.md
20. uv storage reference — on Windows, tools live under %APPDATA%\uv\data\tools — https://docs.astral.sh/uv/reference/storage/
21. librclone — rclone as a library (Go, C, Python ctypes); experimental API — https://github.com/rclone/rclone/tree/master/librclone
22. R2 temporary credentials — per bucket, per prefix, with a TTL — https://developers.cloudflare.com/r2/api/s3/temporary-credentials/
23. Claude Code cloud environments — default Trusted allowlist includes *.r2.cloudflarestorage.com — https://code.claude.com/docs/en/cloud-environments
24. rclone filtering — --filter-from, --exclude-if-present — https://rclone.org/filtering/
25. R2-Explorer security and configuration — https://r2explorer.com/getting-started/security/
26. Workers workers.dev and preview URLs — protect or disable them with Access — https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
27. rclone sync — any error in a run skips deletions — https://rclone.org/commands/rclone_sync/
28. rclone local backend — long paths, Windows character encoding — https://rclone.org/local/
29. rclone forum — Windows Defender false positive on rclone — https://forum.rclone.org/t/windows-defender-false-positive/48560
