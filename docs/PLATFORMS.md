# Platforms: testing on macOS and Windows without a Mac or a Windows PC

Gates G4 (cross-platform), G5 (three surfaces) and G11 (easy to start) are proved on GitHub-hosted runners. Nothing here needs Zach's own computer: push the branch, open the run, read the verdict.

```bash
gh run watch --repo zacharyyamaoka/folder-sync        # after the push
```

## What runs where

| Runner | Go suite + e2e (R2 stand-in) | Installer / desktop build smoke | First sync from a clean HOME |
|---|---|---|---|
| `ubuntu-latest` | `test (linux)` | `desktop / smoke (linux)`: the `.deb` is built and unpacked, its engine runs | `scripts/first-sync-timer`, uploaded as `g11-timer-linux` |
| `macos-latest` (Apple silicon, arm64) | `test (macos)` | `desktop / smoke (macos)`: universal `.dmg` built, mounted, the `.app` copied, its engine runs | `g11-timer-macos` |
| `windows-latest` | `test (windows)` | `desktop / smoke (windows)`: `.msi` installed with `msiexec /qn`, the NSIS `-setup.exe /S`, the installed engine runs | `g11-timer-windows` |

All of it is in `.github/workflows/test.yml` (the `test` matrix, the `desktop` job that calls `desktop-smoke.yml`, and `gates (linux)`). `desktop-smoke.yml` also runs alone with `workflow_dispatch`.

WHY `desktop-smoke.yml` is called from `test.yml` on every push, not only on `app/**` changes: G4 has to read this very run's installer result, and a path-filtered trigger meant most commits read an older run. The cost is the Tauri build, about 20 minutes per OS. To run it only on app changes, put an `if:` on the `desktop` job (a one-line undo).

## How G4 reads the result (and when it passes)

Each `test (<os>)` job ends with `scripts/gates --os-leg <os> --job-status ${{ job.status }}`, which writes `gates-<os>.json` (schema `folder-sync-gates/1`, plus a `leg` object): its G4 is that job's own verdict, its G11 is that OS's timer file. The job uploads it as the artifact `gates-leg-<os>`.

`gates (linux)` downloads all three and runs `scripts/gates --os-results <dir>`. **G4 passes only when**:

- `gates-linux.json`, `gates-macos.json` and `gates-windows.json` are all there, each valid, each G4 = pass, and each built from this commit (a leg from another commit is `skipped`, never a pass);
- the installer smoke of this run (`needs.desktop`) passed on all three OSes;
- the other CI jobs (`core, no server`, `server-cloudflare`, `ui`, the cross-OS pair) passed;
- `scripts/gates-actionlint` (the pinned actionlint over `.github/workflows/`) is clean.

A missing file is `not_built` and names the OS. To read a finished run locally:

```bash
gh run download <run-id> --repo zacharyyamaoka/folder-sync --pattern 'gates-leg-*' --pattern 'g11-*' -D /tmp/fs-run
scripts/gates --only G4,G11 --os-results /tmp/fs-run --collect /tmp/fs-run --no-gh
```

## G5, one journey per surface

| Surface | The journey | Proof |
|---|---|---|
| CLI | two machines log in, init, push and pull each other's files, with ignore rules, case twins and Windows-unsafe names | `e2e` `TestTwoMachines` (`go test ./...`, all three OSes) |
| Web | sign in, browse, preview, upload, rename, delete, history, isolation, on the real accounts Worker | `node ui/scripts/files-real.mjs` (`--with-web`) |
| Desktop | a signed-in person with a folder: the window offers the folder, **Create** starts the engine, the window reads *Synced at HH:MM:SS*, **Open folder** hands exactly that folder to the file manager and it lists the files (also served online), an edit makes the window go *Syncing…* then *Synced*, and the edit is online | `node app/test/journey.mjs` (`--with-web`) |

What is real in the desktop journey: the page (`app/ui`, in Chromium), the engine (`init`, `sync --watch --events`), the local accounts stack. What is played in Node (`app/test/shell.mjs`): the Rust shell around the page (OS keychain, tray, native window, file manager), because those cannot be driven headless on three CI runners (a tauri-driver / WebDriver run needs WebKitWebDriver on Linux, msedgedriver on Windows and has no driver at all on macOS's WKWebView). `app/test/shell.test.mjs` fails if the headlines or event-to-status rules it copies drift from `core.rs`. The Rust itself is covered by `cargo test`, the installer smoke above, and `app/scripts/proof_linux.py` (the real AppImage on a virtual display; by hand, needs the robotparts stack).

## G11, the clock

`scripts/first-sync-timer`, from a clean HOME:

1. **install**: the README's command, `go build -o ~/.folder-sync/bin/folder-sync ./cmd/folder-sync` (a test checks the README still says this);
2. **sign in**: `folder-sync login`, the device code approved by a scripted browser session on the local stack (`/fs/dev/mailbox`), nobody at the keyboard;
3. **add a folder**: four files, `folder-sync init`;
4. **first sync**: `folder-sync sync --watch` until the first file reads back from the accounts Worker.

It fails over 120 s or when a step fails, and writes `first-sync-<os>.json` (`folder-sync-first-sync/1`: per-step seconds, total, OS, arch).

Not timed: starting the local stack (it stands for the server that is already up) and the test person's own web sign-in. The engine downloads the pinned rclone on first use, as it does for a person, and that time **is** counted (`--rclone PATH` skips it for an offline run). The Go toolchain and module cache are the machine's own (only HOME is clean): v0 installs from source, there is no release binary to download yet.

Linux, this machine (Ryzen 9 7900X, local network), 2026-11-04: **6.6 s** (install 0.3, sign-in 5.2, add folder 0.9, first sync 0.3; rclone download included in the folder step). macOS and Windows: not measured until the runners run it.

```bash
scripts/first-sync-timer --out /tmp/first-sync-linux.json
```

## Running it locally

```bash
scripts/gates-actionlint                                   # the workflows, linted with the pinned actionlint
node --test scripts/gates.test.mjs scripts/first-sync-timer.test.mjs app/test/shell.test.mjs
node app/test/journey.mjs --shots /tmp/shots               # needs npm ci in accounts/ and app/, scripts/dev-tools, Chromium
scripts/gates --only G4,G5,G11 --with-web --no-gh
```

`act` (local GitHub Actions runner) is not installed here, so the workflows were linted and their scripts run directly; the first real run of the three-OS matrix, and above all the local stack on Windows (`accounts/scripts/dev.mjs` was written for POSIX process groups; the timer stops the stack's PIDs with `taskkill` there), happens when the branch is pushed.
