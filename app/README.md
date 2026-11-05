# folder-sync desktop

The downloadable app from [PEP 0006](../docs/peps/0006-desktop-app.md): sign in, and your folder is just there.
No terminal, no code to type. Tauri 2.11.5 wraps the folder-sync Go binary, which runs as its sidecar unchanged.

## What the person sees

1. **Open the app.** It shows one button, *Sign in*, and under *Advanced* the server (https://vibetracks.dev). The tray icon is a
   folder with a hollow badge.
2. **Sign in.** The system browser opens the device-approval page (`<server>/fs/device?user_code=…`). The person signs in to the
   site as usual and clicks *Approve*. The app never sees a password, and nothing is typed into it.
3. **Choose a folder, the way Obsidian chooses a vault.** The window offers three things:
   - *Create new folder*: a name and a place (default `~/folder-sync/<name>`, `Documents\folder-sync\<name>` on Windows).
   - *Open existing folder…*: the native folder dialog. Whatever is in the folder uploads.
   - *Your folders online*: the person's folders on the server. On a second computer (the Mac), *Download…* one into an empty place.
   The project is the folder's name (or the online folder picked). Every folder the app makes or joins is a shared tree (PEP 0010):
   the same files on every machine and on the web Files page.
4. **It runs in the tray.** The tray shows *Synced*, *Syncing…*, *Offline*, *Over quota* (with the server's reason),
   *Paused*, *Sync error* or *Signed out*. Its menu has *Open folder*, *Open online* (the Files page of this folder), *Pause sync* /
   *Resume sync*, *Change folder…* (the picker again), *Show window*, *Start at login*, *Sign out* and *Quit*. Closing the window
   keeps sync running.

## How it works

| Piece | Where | What it does |
|---|---|---|
| Sign-in | `src-tauri/src/core.rs` `sign_in` | runs `folder-sync login --json --print-token`. Opens the `device` event's link in the system browser. Moves the `signed_in` event's session from the pipe straight into the keychain |
| Session | `src-tauri/src/vault.rs` | the stock `keyring` crate: Secret Service on Linux, Keychain on macOS, Credential Manager on Windows. One entry per server (`dev.folder-sync.desktop` / `session@<server>`), so a local or staging sign-in is never used against production. **The token is never written to disk in plain text.** There is no `account.json` |
| Engine ↔ session | `FOLDER_SYNC_ACCOUNT_PROCESS` | the engine runs `folder-sync-desktop --account-process` whenever it needs the sign-in (keys, hub, logout). That reads the keychain and prints it; exit 3 means signed out |
| Folders online | `core.rs` `refresh_online` | `folder-sync projects --json`: one LIST of the person's folders, for *Your folders online* |
| Folder | `core.rs` `use_folder` | `mkdir -p`, `folder-sync init [--project P] --dir <folder>`, then `folder-sync share --dir <folder>`, and only then the running folder changes |
| Sync | `core.rs` `start_engine` | `folder-sync sync --watch --events --dir <folder>`, so push is on (PEP 0005). Each round is a `folder-sync-event/1` JSON line, and the tray state comes from those lines. The engine is restarted if it dies and stopped with SIGTERM so it finishes its round |
| Folder dialog | `src-tauri/src/main.rs` | the stock `tauri-plugin-dialog` (`open_existing`, `pick_location`) |
| Tray | `src-tauri/src/tray.rs` | an icon per state (`icons/tray/*.png`, drawn by `scripts/make_icons.py`) and a menu rebuilt on every change |
| Login autostart | `tauri-plugin-autostart` | turned on at the first sign-in; *Start at login* toggles it. On Linux it writes `~/.config/autostart/folder-sync.desktop` with `--hidden` (tray only) |
| Window | `ui/` | one plain HTML page. Every button is an `action` or one of the picker's commands (`create_folder`, `join_folder`, `open_existing`, `pick_location`, `set_server`) |

Settings (folder, project, server if changed, paused, the email shown in the window) are in `~/.config/dev.folder-sync.desktop/settings.json`.
The engine's log is in `~/.local/share/dev.folder-sync.desktop/engine.log`.

The server is `$FOLDER_SYNC_SERVER` when set (a dev or test run; the *Server* field is then read-only), else the one chosen under
*Advanced* while signed out, else `https://vibetracks.dev`. A dev or test run sets `FOLDER_SYNC_SERVER=http://127.0.0.1:4983` and
can never reach production.

## Build (Linux)

```bash
app/scripts/build.sh
```

It builds the Go engine into `src-tauri/binaries/folder-sync-<target triple>` (Tauri's `externalBin`), installs the
pinned Tauri CLI (2.11.5) into `app/node_modules` on first use, then builds:

- `src-tauri/target/release/bundle/deb/folder-sync_0.2.0_amd64.deb`: `/usr/bin/folder-sync-desktop`, `/usr/bin/folder-sync`,
  the hicolor icons and `/usr/share/applications/folder-sync.desktop`
- `src-tauri/target/release/bundle/appimage/folder-sync_0.2.0_amd64.AppImage`: one file that runs on any glibc Linux

`--no-bundle` builds only the binary. The build needs Rust ≥ 1.88, `libwebkit2gtk-4.1-dev`,
`libayatana-appindicator3-dev`, `librsvg2-dev` and Go. All of these are already on Zach's machine.

## Try it (local stack, this desktop)

```bash
/home/bam/folder-sync/app/scripts/try_local.sh
```

This starts the local accounts stack (`accounts/scripts/dev.mjs`, ports 4981–4984) and runs the AppImage with its own HOME under
`~/.cache/folder-sync-desktop-try`, so your real folders, autostart entry and `~/.folder-sync` are untouched. To sign in, enter
`maker@example.com` on the device page, then the code shown at `http://127.0.0.1:4983/fs/dev/mailbox?email=maker@example.com`. Quit
from the tray and the stack stops.

## Proof

Three levels, each says what it proves:

```bash
cargo test --manifest-path app/src-tauri/Cargo.toml --locked
node --test app/test/shell.test.mjs
node app/test/journey.mjs --shots /tmp/shots
node app/scripts/real_window.mjs --out /tmp/real
```

- `cargo test`: the Rust helpers (project names, the Files-page address, settings) and that the page carries the ids the journey drives.
- `app/test/journey.mjs` (also CI, `desktop journey (linux, macos)`, and G5's desktop proof): the window's page and the web Files page
  in Chromium over the real engine and the local stack, on two computers. The Rust shell is played in Node (`app/test/shell.mjs`);
  `shell.test.mjs` fails if its headlines, command names or engine calls drift from `core.rs` and `main.rs`.
- `app/scripts/real_window.mjs`: the real binary. An Xvfb screen, a private D-Bus session, a throwaway gnome-keyring, a scratch HOME,
  the local stack and a headed Chrome on the Files page. It signs in through the device grant, creates a folder by typing in the real
  window, drops three files in and watches the Files page show them, downloads the folder on a second HOME, and relaunches in light
  and dark. It writes the screenshots, a video and `real-window.json`. By hand: it needs the display tools and a built binary
  (`app/scripts/build.sh --no-bundle`).
- `app/scripts/proof_linux.py` is the older robotparts-stack walk of the tray's states (over quota, offline, signed out, token not on
  disk). Its first-run steps predate the picker (they click *Create ~/robotparts*), so only its later steps still apply.

## macOS and Windows: what they need (not built)

Both use the same code. Rust and Tauri are cross-platform, `keyring` picks the OS store, and the Go engine already
cross-compiles (`GOOS=darwin|windows`). What is missing is per-OS packaging, signing and a few seams:

**macOS**
- Build on a Mac (Tauri does not cross-compile to macOS): `cargo tauri build --target universal-apple-darwin`. Build
  the engine for both `aarch64-apple-darwin` and `x86_64-apple-darwin` and `lipo` them, or ship one per target.
- Signing: an Apple Developer ID Application certificate, plus notarization (`APPLE_ID`, `APPLE_PASSWORD`,
  `APPLE_TEAM_ID` for `tauri build`). The sidecar must be signed too, with the hardened runtime. These are Zach's
  accounts. Unsigned, Gatekeeper blocks the first open.
- The tray: `TrayIconBuilder::icon_as_template(true)` with a monochrome template icon, so the menu bar tints it.
  Add `LSUIElement = true` in `Info.plist` if it should have no Dock icon.
- Login autostart: the plugin's `MacosLauncher::LaunchAgent` is already chosen.
- The folder default is `~/folder-sync/<name>`. Keychain access prompts once per binary signature, so a stable signing
  identity matters, or every update re-prompts.
- The engine's own `--install-service` launchd plist is not used by the app.

**Windows**
- Build on Windows or in CI (`x86_64-pc-windows-msvc`): an NSIS `.exe` or an `.msi` (WiX). The per-user NSIS install
  (`"installMode": "currentUser"`) matches ClaudeParty's no-admin rule.
- Signing: an OV/EV code-signing certificate or Azure Trusted Signing (`bundle.windows.signCommand`). Unsigned,
  SmartScreen warns.
- WebView2 is on every current Windows. Set `webviewInstallMode` to `downloadBootstrapper` for older ones.
- The default place is `Documents\folder-sync` (`core::default_parent` already does this).
- **Stopping the engine:** today `stop_engine` kills it on Windows. It must start the engine in its own process group
  (`CREATE_NEW_PROCESS_GROUP`) and send `CTRL_BREAK_EVENT` first, so `--watch` finishes its manifest publish (PEP
  0006 §4). This is marked `TODO(windows)` in `core.rs`.
- The engine needs `CREATE_NO_WINDOW`, or a console flashes up on every round.
- Login autostart: the plugin writes the `HKCU\…\Run` key.

**All three:** auto-update through `tauri-plugin-updater` with a signed `latest.json` (minisign key pair; ClaudeParty's
rule of upload the artifact first and the manifest last). A download page on vibetracks.dev. Both wait on where
builds are hosted.
