# The gates: twelve pass/fail checks, each a runnable test

A **gate** is satisficing: it passes or it does not, it runs on every change, and a red gate blocks a release. The objectives (speed, storage efficiency, cost per GB) are numbers we keep improving; they live in the KPI series, not here. The ids G1..G12 are a frozen contract: the dev view, the README and `gates.json` use them.

```bash
scripts/gates                  # every proof that runs on this machine, the CI profile (about 6 minutes)
scripts/gates --list           # the gates and the exact tests behind each, run nothing
scripts/gates --only G1,G9     # just those
scripts/gates --profile smoke  # the soak at smoke size (seconds); --profile long: 30 minutes
scripts/gates --with-web       # also the Files page against the real accounts Worker (G5, needs npm ci in accounts/ and ui/)
scripts/gates --publish        # also write /home/bam/folder-sync/reports/status/gates.json, where the dev view reads it
node --test scripts/gates.test.mjs   # the runner's own tests: that every proof it names exists, and the shape of the file
```

## How a gate gets its status

| status | meaning |
|---|---|
| `pass` | every proof the gate needs ran, and all passed |
| `fail` | a proof ran and failed |
| `not_built` | a proof the gate needs does not exist yet, or cannot run on this machine (a runner we do not have). The summary says which. |
| `skipped` | a proof exists but this run left it out (`--only`, no `--with-web`, a tool missing) |

WHY there is no fake pass: a gate whose proof does not exist says `not_built` and names what is missing. A gate cannot be `pass` while a required proof is missing, and the runner's own test (`scripts/gates.test.mjs`) fails if a test a gate names has been renamed or deleted, so a gate cannot go quietly green by losing its test.

`gates.json` (`folder-sync-gates/1`) is written to `reports/status/gates.json` in the checkout, and with `--publish` also to the main checkout's `reports/status/` (gitignored), with the evidence files beside it (`evidence/`). The shape is `{schema, run_at, code_sha, branch, gates: [{id, name, status, summary, tests: [{name, status: pass|fail|skip, duration_ms, detail}], evidence: [paths]}]}`; each gate also carries its `target` sentence. `scripts/gates` exits 1 only when a gate failed.

CI: the `gates (linux)` job of `.github/workflows/test.yml` runs `scripts/gates --profile ci --with-web` after the other jobs (it `needs` them, so G4 reads this very run), writes the table into the job summary and uploads `reports/status` as the `gates-json` artifact. The matrix `test (...)` jobs each time a fresh first sync (G11) and upload it as `g11-<os>`.

## The twelve

| | Gate | Target | The proof (exact tests) | Where it runs |
|---|---|---|---|---|
| **G1** | Nothing lost | 100% of randomized soak runs end converged, 0 lost versions | `e2e/soak_test.go` `TestSoakNothingLost`. Three machines and the web host (a stand-in writer following the bucket contract). A seeded RNG (`FOLDER_SYNC_SOAK_SEED`) drives writes, edits, deletes, renames, directory moves, kills in the middle of a sync (SIGKILL to the whole process group), offline periods, rounds that run at the same moment on two or three machines, and a second person editing a peer copy. Then the machines sync until settled and the test checks: each manifest lists exactly its folder and every object holds those bytes; every machine's copy of every other host is byte-identical (except a copy a second person edited, which keeps the edit until that host's next change replaces it and moves the edit to `conflicts/`); every change record's kept version is in `_history/` with the bytes its name says; every delete kept the file's last bytes; every edit made to a peer copy is still in place or in `~/.folder-sync/conflicts/`. | `go test ./...` runs the smoke size (about 7 s); `scripts/gates` runs `FOLDER_SYNC_SOAK=ci` (90 s of editing, 700 steps at most); `FOLDER_SYNC_SOAK=long` is the local 30-minute run. A failure prints the seed and the command that reproduces it. |
| **G2** | Version history | Any version kept in the last 30 days restores byte-identical; deleted files restore for 30 days | `e2e/gates_history_test.go`: `TestGateVersionHistory30Days` (a fake clock: versions planted as having left 5 minutes ... 29 days 23 hours ago, the engine's own prune, then `folder-sync history`/`restore`/`deleted --restore` through the CLI; a file deleted 29 d 20 h ago restores, one deleted 30 d 1 h ago is gone), `TestGateEditsFiveMinutesApartAreAllKept`, plus `TestHistory`, `internal/history`, and `accounts/test/history.test.ts` (the web side of the same schedule). Only the public path, so PEP 0009 changing the kinds of object does not break them. | `go test ./...`, `scripts/gates` |
| **G3** | Private | No one reads another account's files | `e2e` `TestScopedCredentialsKeepPeopleApart` (scoped keys against the R2 stand-in), and in `accounts/test`: `worker.test.ts` "two people: ..." and its `mutation:` tests, `storage.test.ts` "nobody sees another account's prefix", `app-root.test.ts` "two deployments, one bucket". | `go test ./...`, `server-cloudflare (linux)`, `scripts/gates` |
| **G4** | Cross-platform | Linux/macOS/Windows CI and the installer smoke are green | Read, not run: in CI the `needs` of the gates job (the `test` matrix, `core, no server`, `server-cloudflare`, `ui`, the cross-OS pair); locally the latest completed run of `test.yml` and of `desktop-smoke.yml` that `gh` can see (on this branch, else the default branch, with its commit shown). The installer smoke only runs on changes to `app/**`; until it has run once, G4 is `not_built`. | `gates (linux)` |
| **G5** | Three surfaces | CLI, desktop and web each pass one journey | CLI: `e2e` `TestTwoMachines`. Web: `node ui/scripts/files-real.mjs` (the Files page on the real accounts Worker: sign in, browse, preview, upload, rename, delete, history, isolation). Desktop: the last `desktop-smoke.yml` run (`app/scripts/smoke_install.sh`); `app/scripts/proof_linux.py` needs an AppImage and the robotparts stack, so it stays a manual proof. | `go test ./...`, `gates (linux)` with `--with-web`; the desktop half is read from GitHub |
| **G6** | Headless | A fresh machine syncs from a script | `e2e/gates_core_test.go` `TestGateHeadlessFreshMachine`: two fresh homes, a POSIX `sh` script (`init`, `sync --once`), an environment of `PATH`, `HOME` and the bucket key, stdin closed; the second machine receives the first one's file and nothing prompted. The accounts sign-in (a person approves a device code) is human by design and is not part of G6. | `go test ./...` |
| **G7** | Storage provider swappable | The core e2e passes on R2, another S3 store and `file://` | **Not built.** The e2e runs on `rclone serve s3` and the R2 stand-in only; storage is S3-only (`internal/creds`, `internal/rclone`). Waits for the storage-agnostic lane. | - |
| **G8** | Drop-in | 20 lines of app code or fewer; 30 minutes of agent time or fewer | `scripts/gates-lib.cjs` `dropIn8`: counts the stock snippet in `docs/API.md` (2 lines) + every code line of the demo app's Worker (`demo/worker.ts`) + its service binding (`demo/wrangler.toml` `[[services]]`) and fails above 20; checks that `demo/site/index.html` embeds the documented snippet and that the Worker holds no server of its own. The 30-minute half needs a timed agent trial on a scratch app; none has been run (shown as an advisory `not built` line, it does not block the pass). | `node --test scripts/gates.test.mjs`, `scripts/gates` |
| **G9** | Ignore rules | `.gitignore`-style rules; OS junk ignored by default; NFC/NFD names | `internal/ignore`: `TestDefaultsKeepOSJunkOut`, `TestOSJunkDefaultsAreOverridable`, `TestGitignoreStyleRules` (git itself is the oracle), `TestMatchesGit`; `internal/syncer` `TestTwinGroups...`; `e2e` `TestCrossOSRoundTrip` (its `junk-*` and `unicode-*` cases: the two cases that were quarantined, now fixed and removed from `FOLDER_SYNC_QUARANTINE`), `TestNormalization...` (below). | `go test ./...` on all three OSes |
| **G10** | Accounts | Google and email-code sign-in; one deployment per app | `accounts/test`: `worker.test.ts` (sign-in page offers Google and email codes, production email delivery, sign-up list, `me`, the app registry), `app-root.test.ts` (one deployment per app: `ROOT_PREFIX`), `real-auth.test.ts` (device approval, revocation, rate limits), `identity-seam.test.ts` (seam 2). | `server-cloudflare (linux)` |
| **G11** | Easy to start | 2 minutes or fewer from a fresh machine to the first sync, per platform | `e2e/gates_core_test.go` `TestGateFirstSyncWithinTwoMinutes`: a fresh HOME, `init`, `sync --once` of 4 files against the stand-in. It starts from the built binary with rclone already installed; the one-time rclone download and the installers are timed by no test (shown as `not built`). macOS and Windows are measured by the CI matrix jobs and collected. | each `test (...)` job; `gates (linux)` collects |
| **G12** | Trusted restore | A restore takes 5 seconds or fewer | `e2e/gates_history_test.go` `TestGateRestoreWithinFiveSeconds`: a 1 MB version out of 60 kept versions of a 2 MB file, `folder-sync restore`, and `deleted --restore`, timed from the command to the bytes on disk and published (about 0.3 s on the stand-in). Real R2 adds its round trips: the production probe measures that. | `go test ./...` |

## What "5-minute resolution" means in the contract today (G2), a question for Zach

The gate says "any version from the last 30 days, at 5-minute resolution". The contract (`docs/CONTRACT.md` "What is kept") and PEP 0009 together give this shape:

- **write time**: the version an edit replaces is kept unless one was kept in the last 30 s (5 min under PEP 0009's throttle `history_every`). So edits 5 minutes apart are all kept.
- **the pruner** then thins what is older than an hour to one version per UTC hour, and older than a day to one per UTC day, until 30 days. PEP 0009 leaves the pruner alone (its section 7.1).

So restore is at 5-minute resolution for the last hour, hourly for the last day, daily to 30 days. `TestGateVersionHistory30Days` pins exactly that, including that five edits 5 minutes apart in one clock hour three hours ago keep only the newest. **If the gate means 5-minute resolution for all 30 days**, that is up to 8,640 versions per continuously edited file instead of about 64 (PEP 0009 §5: 12 + 23 + 29), which is the opposite of objective O2 (H at most 1.0), and the pruner's schedule would change. Recommended default: the shape above, which is what the tests assert; say so if you want the other reading.

## The names rule (G9)

A file's name is its bytes, everywhere: the bucket key, the manifest path and the file on disk are the name the writer used, never rewritten (`docs/CONTRACT.md`: "byte for byte"; and Zach's rule that stored text is not silently normalized).

- Unicode has two spellings of an accented letter: NFC (one code point) and NFD (the letter and a combining mark). macOS file managers and some apps write NFD, Windows and most Linux tools NFC, so one logical file meets both across a person's machines.
- **Before:** rclone's `copy` folds names to NFC to compare them. A folder holding both spellings uploaded one of them (`NOTICE: Duplicate object found in source - ignoring`) while the manifest named both, so the manifest listed an object the bucket lacked; and a file re-saved under the other spelling was skipped as "already there", then deleted under its old name.
- **Now:** the engine runs rclone's `copy` with `--no-unicode-normalization` (`exactNames`, `internal/syncer/round.go`). The two spellings are two names, each uploaded once; a file respelled by an app is uploaded under its new name and the old name is removed (kept in history). Each machine's copy of a peer's file lands under the spelling its writer used.
- **A disk that folds them into one file** (APFS, HFS+; case-insensitive NTFS for case) cannot hold a peer's two names as two files. After a pull the engine finds names that are the same file on that disk (`internal/syncer/twins.go`, `os.SameFile`), removes that one file and refuses both with a reason in `status`, as the push refuses case-only twins. Nothing lands under a name that holds another name's bytes.
- Prior art: rclone's default merges the two (the loss above) and exposes `--no-unicode-normalization` to turn that off, which is the flag used. The other design, one canonical form (NFC) with names rewritten on the way in, is also consistent but changes what the person typed; this project does not. S3 and R2 keys are bytes, so the e2e stand-ins run with the same flag (without it the stand-in answered a HEAD for the NFD key with the NFC object).

Default ignore list, first in every project's rules so a project's own `!rule` overrides it (`internal/ignore` `Defaults`): `.git/`, `node_modules/`, `.env`, `*.pem`, `id_*`, `*.key`, and the OS junk `.DS_Store`, `._*` (macOS AppleDouble), `Thumbs.db`, `desktop.ini`. To sync one on purpose, add its negation to `ignore` in `.folder-sync.toml`, for example `ignore = ["!Thumbs.db"]`. The ignore list is the `ignore` array of `.folder-sync.toml` in gitignore syntax; a separate `.folder-syncignore` file does not exist yet (the gate text names one).

## Running a profile of the soak by hand

```bash
FOLDER_SYNC_SOAK=ci   go test -count=1 -v ./e2e -run TestSoakNothingLost     # what CI runs: 90 s of editing
FOLDER_SYNC_SOAK=long FOLDER_SYNC_SOAK_SEED=7 go test -count=1 -v -timeout 60m ./e2e -run TestSoakNothingLost
FOLDER_SYNC_SOAK_REPORT=/tmp/soak.json ...                                     # a JSON summary: ops, rounds, lost versions
```

`FOLDER_SYNC_E2E_STANDIN` and `FOLDER_SYNC_E2E_PROXY` move the e2e off ports 4801/4802 when another lane holds them.
