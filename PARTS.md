# The parts

One repo, named parts, seams that tests enforce. Zach, 2026-11-04: "the UI can continue to churn, the Cloudflare can continue to churn, etc., apart from core." The choice and its scoring are in the vault note "folder-sync: Five KPIs and the Core-or-Turnkey Split" (option B); the split into separate repos waits until a second backend actually exists (a self-hosted MinIO, a company's SSO, another cloud).

The parts are named here, in the CI job names and in each `package.json`; no directory moved, because live deploys, the `folder-sync-latency` systemd unit, the install scripts and other lanes all use today's paths.

| Part | What it is | Paths |
|---|---|---|
| **core** | The Go CLI and engine: init, sync, status, the credential process, `serve`. Works alone on a bucket key. Owns the bucket contract and its reference readers. | `cmd/`, `internal/`, `e2e/` (with `e2e/r2standin`, the local R2 stand-in), `schema/`, `readers/`, `testdata/`, `scripts/`, `go.mod`, `go.sum` |
| **server-cloudflare** | The online half: the accounts Worker (Better Auth, D1, Durable Objects: the key broker, web host, push hub, history and prune, quota, the view API) and the demo site in front of it. | `accounts/`, `demo/` |
| **ui** | The pages a person sees: `<folder-sync-status>` (one ES module, served by the Worker and by `folder-sync serve`) and the desktop shell's own page. | `ui/` (the element is `ui/v1`), `app/ui/` |
| **desktop** | The Tauri shell and its installers (PEP 0006): wraps the core as a sidecar and loads `app/ui`. A fourth part because it has its own toolchain (Rust) and its own CI (`desktop-smoke.yml`, `desktop-release.yml`); its page stays with `ui`, as `app/ui/` is what the shell `include_str!`s. | `app/src-tauri/`, `app/scripts/`, `app/release/`, `app/package.json` |

Not parts: `docs/` (the contract and the PEPs, for all of them), `bench/` (measures the whole stack: `bench/latency` runs the Worker's dev stack, so it uses `accounts/node_modules`), `reports/`, `dist/`, `.github/`.

## Cloudflare-specific and storage-agnostic

Zach, 2026-11-04: the Cloudflare parts churn on their own; the core does not care where the bytes are. Where a folder's bytes live is a store URL ([`docs/STORAGE.md`](docs/STORAGE.md)): `r2://`, `s3://`, `gs://` or `file://`.

**Cloudflare-specific** (change with Cloudflare, and a deployment on another cloud would replace them):

- the whole **server-cloudflare** part: the accounts Worker (Better Auth, D1, Durable Objects, R2 bindings), the web host, the pruner and quota, the per-app mounts, `demo/`;
- in the core, only what talks to them: `internal/account` (the Worker's client and the sign-in files), `internal/viewer` (the R2-Explorer Worker config), `internal/push` (the hub's WebSocket), the accounts `credentials` adapter in `cmd/folder-sync`, `publish --viewer`, `publish --public/--private`, and the `r2://` kind (the Cloudflare endpoint from an account id, `provider Cloudflare`, `x-amz-acl: private`);
- `e2e/r2standin` and the R2 journey in `e2e/storage_test.go`, which test R2's behaviour.

**Storage-agnostic** (the same code on every store): the sync engine (`internal/syncer`, `internal/history`, `internal/manifest`, `internal/ignore`, `internal/names`), the store seam (`internal/store`: the URL, the object calls behind one interface, the directory store, the capability probe and the fallbacks), the S3 client (`internal/s3`, any S3-compatible endpoint), rclone (`internal/rclone`), keys (`internal/creds`: `FOLDER_SYNC_*`, `AWS_*`, a credential process), the CLI, `folder-sync serve` and the sync view, the bucket contract and its readers.

The accounts Worker **stays on Cloudflare** (R2, Durable Objects, D1). A folder on another store has no web host, no Worker pruner and no quota: it is the core on its own, which is seam 3 below.

## The seams

What crosses from one part to another, and nothing else:

1. **The bucket layout and manifest** ([`docs/CONTRACT.md`](docs/CONTRACT.md), schemas in `schema/`, fixtures in `testdata/`). The core writes it; the server and every app read it (the Worker through `readers/worker`). Nothing imports the other way.
2. **The credential process** ([`docs/peps/0002`](docs/peps/0002-short-lived-scoped-credentials.md)): any program that prints short-lived keys scoped to a prefix, in AWS's `credential_process` shape. Two adapters exist: `login --key` (a bare bucket key, no server) and `folder-sync credentials` (signs in through the accounts Worker). A company's own key broker would be a third program; the core does not change.
3. **`/fs/v1` HTTP** ([`docs/API.md`](docs/API.md), `schema/view-api.schema.json`): the accounts Worker online and `folder-sync serve` on a machine answer the same JSON; the CLI is the Worker's client for sign-in, `me`, `credentials` and the web host. The element speaks it to whichever origin its page is on.

3. **The core's storage seam.** Everything above `internal/store` reaches a store through its URL and the `store.Objects` interface; the Cloudflare-specific packages (`internal/account`, `internal/viewer`, `internal/push`) are imported by `cmd/folder-sync` and `internal/serve` and by no engine package (`internal/store/seam_test.go` walks the imports and fails otherwise). `scripts/check-core-alone` runs the whole suite, the `file://` journey included, with no `accounts/`, `demo/` or `app/` and with the Cloudflare variables unset. A new store is a new `Kind` in `internal/store/spec.go` and nothing else.

## Which part may import which

| From \ to | core | server-cloudflare | ui | desktop |
|---|---|---|---|---|
| **core** | | never | `ui/v1` bytes, embedded at build (`ui/embed.go`) and nothing else | never |
| **server-cloudflare** | the contract only: `readers/worker`, `schema/`, `testdata/` | | `ui/v1`, symlinked at `accounts/site/ui/v1` | never |
| **ui** | `testdata/` and `schema/` for its tests | never | | never |
| **desktop** | the `folder-sync` binary, as a sidecar process (`app/scripts/build.sh`) | never | `app/ui/` | |

`demo/` reaches the Worker only through its service binding (`/fs/*` to `folder-sync-accounts`).

## The seam tests

Seams 1 and 2 run in CI as their own lines (`.github/workflows/test.yml`) and locally; seam 3 is part of `go test ./...`:

- **The core works with no server.** `scripts/check-core-alone` copies the checkout without `accounts/`, `demo/` and `app/`, then builds, vets and tests the core there: the e2e suite on bucket-key login against `e2e/r2standin`, the Go tests, the schema fixtures. A core that imports, reads or starts the server part fails, because the directory is not there. CI job: `core, no server (linux)`.
- **The server reaches identity through one function.** The identity port is `deps.person(request, via, app)` in `accounts/src/app.ts`, `whoIs(request) -> person | null`: every route asks it, and only the identity adapter `accounts/src/auth.ts` answers it, over Better Auth. `accounts/test/identity-seam.test.ts` fails if any other file of the server part imports `better-auth`, or if any file but the Worker entry (`index.ts`) imports the adapter (so a route cannot build Better Auth around the port). Swapping Better Auth for another sign-in means rewriting `auth.ts` and nothing else. CI job: `server-cloudflare (linux)`, step "seam 2".

- **The engine does not reach Cloudflare.** `internal/store/seam_test.go` parses every non-test Go file under `internal/` and `cmd/` and fails if one outside `cmd/folder-sync`, `internal/serve` and the three Cloudflare-specific packages imports `internal/account`, `internal/viewer` or `internal/push`; and it fails if `internal/store` imports anything but the standard library and `internal/s3`. The behaviour half is `e2e` `TestStorageJourneyFileDirectory` (two machines on a directory, no key, no server), which `scripts/check-core-alone` runs in the copy without the server part.

## Per-part checks

| Part | Check | CI line |
|---|---|---|
| core | `go build ./... && go vet ./... && go test ./...`, `node --test schema/fixtures.test.mjs` | `test (linux)`, `test (macos)`, `test (windows)`, the two cross-OS pair lines |
| core, alone | `scripts/check-core-alone` (also runs with no Cloudflare credentials) | `core, no server (linux)` |
| core, other stores | `scripts/fetch-minio` then `go test ./e2e -run StorageJourney`; gate G7 | `gates (linux)` |
| server-cloudflare | `npm --prefix accounts test` (includes the identity seam) | `server-cloudflare (linux)` |
| ui | `npm --prefix ui test` (Playwright, Chromium) | `ui (linux)` |
| desktop | installers built and silently installed | `desktop-smoke` (on `app/**` changes), `desktop-release` |
