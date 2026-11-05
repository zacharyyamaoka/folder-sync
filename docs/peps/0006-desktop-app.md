# 0006 · A downloadable app: sign in, and your folder is just there

- **Date:** 2026-10-26
- **Status:** prototype built on `lane/desktop` (2026-10-27): Tauri 2.11.5 app in `app/`, Linux `.deb` and AppImage,
  proven headlessly against the local accounts stack (`app/scripts/proof_linux.py`). §8 records what was built and
  where it departs from §4. macOS and Windows are written down in `app/README.md`, not built.
- **Source:** Zach, 2026-10-26: "I don't want any CLI logins for this. I want it to feel like Obsidian: I download it as
  a standalone, fully integrated, complete app and don't need to think about how anything is happening in the
  backend. I just sign in and it works. Everything across all the things is the same." "When I download the app I
  think it can make this folder itself."
- **Builds on** PEP 0003 (accounts, the device grant, `/fs/` on each app's domain) and PEP 0005 (push sync: the
  watcher and the hub make an app's folder feel instant).

## 1. What a good answer looks like (weights first)

| Criterion | Weight | Why |
|---|---|---|
| Zero terminal: download, sign in, the folder exists and syncs | 30 | the whole ask |
| Reuses folder-sync unchanged (the Go binary is the engine) | 20 | one engine, tested once; CLI, service and app behave the same |
| Small, quiet, runs at login in the background | 15 | a sync app lives in the tray for years |
| Windows, macOS and Linux from one codebase | 15 | Zach's machines are all three |
| Signed builds and auto-update | 10 | an unsigned app is a warning dialog; a stale one is a bug report |
| Already proven in Zach's stack | 10 | fewer new things to learn |

## 2. The shell, weighed

| Option | Zero terminal (30) | Reuses Go engine (20) | Small/quiet (15) | 3 OSes (15) | Signed + update (10) | Proven here (10) | Score |
|---|---|---|---|---|---|---|---|
| **Tauri 2** (system WebView, Rust core; the Go binary as a `sidecar` / `externalBin`; tray, autostart, deep-link and updater plugins) | 30 | 20 (sidecar is built for exactly this) | 14 (~5–10 MB + the 15 MB Go binary; idle tens of MB) | 12 (WebKitGTK on Linux differs from Chromium; the UI here is plain HTML, so the risk is small) | 9 (updater plugin with signatures; code signing still per OS) | 3 (nothing of Zach's uses it yet) | **88** |
| Electron (Chromium + Node; the Go binary as a child process; electron-builder / Forge, `autoUpdater`) | 30 | 18 | 6 (~100+ MB download, ~150 MB idle) | 15 (same Chromium everywhere) | 10 (most mature signing and update path) | 3 | 82 |
| No shell: the Go binary installs itself as a service + a tray icon (ClaudeParty's pattern: `install.sh`, a Python tray, sha256 manifest updates) and the person uses the website | 22 (an install command, then the browser) | 20 | 15 | 10 (the tray is per OS) | 8 | 10 (ClaudeParty ships this) | 85 |

**Recommended: Tauri**, with ClaudeParty's install/update discipline (per-user, no admin, versions side by side,
sha256-checked manifest, one-step rollback) copied as the update policy. Electron stays the fallback if WebKitGTK
misrenders the site on Linux. The no-shell row is the tracer bullet: it can ship first and the Tauri app wraps the
same pieces.

## 3. What the app does (the person's view)

1. **Download and open.** First run shows one button: *Sign in*.
2. **Sign in in the browser, no codes.** The app runs folder-sync's device grant (PEP 0003 §3.5) and opens the
   system browser at `verification_uri_complete` (`/fs/device?user_code=…`), already signed in on robotparts.dev for
   most people: one click on *Approve*. The app polls, stores `account.json`, done. WHY the system browser and not a
   web view inside the app: RFC 8252 (OAuth for native apps) — the person's existing Google session and password
   manager work, and the app never sees a password. A `robotparts://signed-in` deep link can bring the window back
   to the front; nothing depends on it.
3. **The folder makes itself.** `~/robotparts` (Documents\\robotparts on Windows), created with
   `folder-sync init --project robotparts`; if the person already syncs that project on another machine
   (`folder-sync projects --json`), the app says so and joins it.
4. **Sync runs in the background**: the app starts `folder-sync sync --watch` as its sidecar (PEP 0005 push: a change
   lands everywhere in under a second), and registers login autostart. Closing the window leaves the tray icon; the
   tray shows *Synced · 2 machines · web* or what is wrong, from `folder-sync status --json`.
5. **The site opens in the app window**: robotparts.dev itself (same account, same cookie jar as the window), so the
   app and the website are one product. A *Show folder* item opens the folder in the file manager.

## 4. What it needs from folder-sync (small, additive)

- `folder-sync login --open` (or `--json`): print the device grant as JSON and exit only when approved, so the app
  drives it without parsing human text. Today `login` prints text for a terminal.
- `folder-sync status --json` already exists; add the hub and watcher state (PEP 0005) to it for the tray.
- A clean stop: the sidecar is stopped by the app with SIGTERM / CTRL_BREAK; `--watch` already finishes the manifest
  publish before exiting.
- Later, for offline: `folder-sync serve` — the same `/fs/v1/folders/…` read routes answered from the local folder on
  127.0.0.1, so the app's window reads disk instead of the cloud when the folder is local, and keeps working offline.
  Not needed for the first app.

## 5. Reuse

- **folder-sync** — the engine, unchanged: accounts (0003), push sync (0005), the service definitions (`--install-service`
  becomes the app's autostart fallback).
- **ClaudeParty** (`/home/bam/claude-hub/packaging/`, `tray/`) — per-user install without admin, versioned installs with
  an atomic `current` link and one-step rollback, a sha256-checked update manifest, the tray's login autostart and a
  URL-scheme handler. It is Python + a web sidebar, not Electron or Tauri; its packaging rules carry over, its code does not.
- **stable_preview_switcher** (`/home/bam/stable_preview_switcher`) — Stable / Preview channels and the dock icon's
  right-click (*Open Preview*, *Make Preview Stable*, *Roll Stable Back*) for the app's own builds.
- **Clank** (`/home/bam/clank-workbench`) — a Python host for file views, not a desktop shell; nothing to reuse here.

## 6. What a prototype would need

1. A Tauri 2 project (`app/` in this repo) with the `shell` sidecar (`externalBin: ["bin/folder-sync"]`, the Go binary
   cross-built per target triple), `tray-icon`, `autostart`, `deep-link` and `updater` plugins, and one HTML page:
   the *Sign in* button, then a status line and *Open robotparts* / *Show folder*.
2. The `login --json` change above; everything else is the CLI as it is.
3. A first-run proof on Linux (Xvfb, the real binary, the local accounts stack from `accounts/scripts/dev.mjs`): click
   *Sign in* → approve in a headless browser → the folder appears → an edit on the page lands in it within a second.
4. Signing: Apple Developer ID + notarization, a Windows code-signing certificate (or Azure Trusted Signing), both Zach's
   accounts; until then, unsigned dev builds with the OS warning.

## 7. Open, with the default taken

- **Per-app folder or one folder for every app?** Default: per app (`~/robotparts`, later `~/vibetracks`), because each
  app owns its file formats and its project; one app can host several later.
- **Ship the no-shell tracer first?** Default: yes — the service + tray works without a new toolchain, and the Tauri
  app wraps the same sidecar.

## 8. What was built (lane/desktop, 2026-10-27)

- **The token never touches the disk.** §4's `login --json` would have written `account.json` (plain text, mode 0600).
  The app instead runs `login --json --print-token`: the session arrives on the pipe and goes straight into the OS
  keychain (`keyring` 3.6.3). The engine gets it back through a new hook, `FOLDER_SYNC_ACCOUNT_PROCESS` (the app's own
  `--account-process`: print the folder-sync-account/1 document, exit 3 when signed out), used everywhere account.json
  was: `credentials`, the push hub's bearer, `logout`, `whoami`. WHY a program and not an environment variable with
  the token: the environment of every helper process would carry it, and a sign-out would not reach a running engine.
- **The tray reads events, not text.** `sync --watch --events` prints one folder-sync-event/1 JSON line per round
  (`watching`, `round_start`, `round` with `ok` or `kind` = `signed_out` / `over_quota` / `offline` / `error` and its
  `why`, `hub`, `stopped`); human lines move to stderr. `credentials` names a 403 `over_quota` with a fixed
  `over quota: <why>` prefix so the round's error carries the server's reason to the tray.
- **One engine.** The app shells out to the same binary for sign-in, init, sync and sign-out; Rust holds no HTTP client.
- **One keychain entry per server** (`session@<server>`), so a local or staging sign-in never reaches a robotparts.dev run.
- **Offline is shown while it is true.** `--watch` trims rclone's own retries (the loop retries anyway), and a failed
  round dials the storage endpoint and the account server before it is called an error. Before this change, with storage
  down, a round held the tray on "Syncing…" for minutes.
- **Found by the proof:** the device page reload-looped for anyone already signed in (`signin.js` ran its own boot
  before `device.js`'s tag existed). Fixed here in `26f3701`; `lane/accounts` still has it.
- **Not done yet:** the updater plugin and signing (both need a build host and Zach's certificates), a download page,
  the deep link, and `folder-sync serve` for offline reads. The rclone the engine needs is downloaded and sha256-checked
  on first `init` (`~/.folder-sync/bin`), as for the CLI; bundling it as a second sidecar (85 MB) is the alternative.

## 9. As built, Nov 4 (lane/desktop-journey, Zach's criterion)

Zach's test (2026-11-04): "sign into the desktop app, put some files in there, and then just log in online and see it there. AND on my
mac, then logging there and then sync. I think it can be like Obsidian where you select a new folder or existing vault." This
replaces §7's "per-app folder" default and §3's "Create ~/robotparts".

- **The folder is chosen, not fixed.** After sign-in the window offers *Create new folder* (name and place, default
  `~/folder-sync/<name>`), *Open existing folder…* (the stock `tauri-plugin-dialog`; its files upload) and *Your folders online*
  (`folder-sync projects --json`; *Download…* puts one in an empty place of the person's choice). *Change folder…* in the tray and
  the window reopens it. There is no fixed project: it is the folder's name, read back from `.folder-sync.toml` after `init`.
- **Every folder is a shared tree (PEP 0010).** `use_folder` runs `init`, then `share`, then the engine, so the Mac gets the same
  files, not a read-only copy per machine under `hosts/`. `share` is idempotent, so *Download…* runs it too. Nothing about the running
  folder changes until `init` and `share` have succeeded, so a refusal (an online folder of that name, a non-empty place, no network)
  is text under the button and the old folder keeps syncing.
- **Server.** The default is `https://vibetracks.dev`, where Zach's own account and `/fs/files` live. `FOLDER_SYNC_SERVER` still wins
  (dev, tests; the field is then read-only). The first-run window has the *Server* field under *Advanced*, only while signed out
  (a session belongs to one server). A 0.1 `settings.json` that pinned robotparts.dev is dropped back to the default.
- **Open online** (tray and window) is `<server>/fs/files?project=<folder>`.
- **Found by running it.** (1) `folder-sync projects --json` was an AccessDenied for an account with no folders yet, which is the
  first screen of every new account: rclone checks the root's parent, which a prefix-scoped key may not list. The engine now falls back
  to the S3 client's own delimited LIST (`cmd/folder-sync/main.go`; `e2e` "projects of an account with no folders yet" fails without
  it). (2) The keychain can hold a sign-in while `settings.json` has no email; the window keyed its picker on the email, so a second
  computer showed no picker. It keys on `signed_in` now. (3) The engine counts the shared tree among a folder's peers, so a lone
  computer read "1 other machine"; the app subtracts the tree.
- **Proof.** `app/test/journey.mjs` runs the whole story on two computers (§ PLATFORMS "G5"), in CI on Linux and a real Mac
  (`desktop journey`). `app/scripts/real_window.mjs` drives the real binary on a virtual display: typing in the real window, three
  files on the Files page 0.9 s after the drop, the second computer's download, light and dark.
- **Releases.** `desktop-release.yml` builds macOS (universal `.dmg`, which contains arm64), Windows (`-setup.exe` and `.msi`) and Linux
  (`.deb` and `.AppImage`) from a `desktop-v*` tag and publishes every one as a GitHub pre-release (unsigned). Version 0.2.0.
- **Not done.** Signing and notarization, the updater, a tray host on every Linux desktop, a Windows engine stop with CTRL_BREAK (still
  `TODO(windows)`), and the real Tauri window on macOS in CI (no driver exists for WKWebView; the journey runs the page and engine
  there, and `cargo test` plus the installer smoke build and unpack the real app).
