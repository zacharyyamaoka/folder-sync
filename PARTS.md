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

## The seams

What crosses from one part to another, and nothing else:

1. **The bucket layout and manifest** ([`docs/CONTRACT.md`](docs/CONTRACT.md), schemas in `schema/`, fixtures in `testdata/`). The core writes it; the server and every app read it (the Worker through `readers/worker`). Nothing imports the other way.
2. **The credential process** ([`docs/peps/0002`](docs/peps/0002-short-lived-scoped-credentials.md)): any program that prints short-lived keys scoped to a prefix, in AWS's `credential_process` shape. Two adapters exist: `login --key` (a bare bucket key, no server) and `folder-sync credentials` (signs in through the accounts Worker). A company's own key broker would be a third program; the core does not change.
3. **`/fs/v1` HTTP** ([`docs/API.md`](docs/API.md), `schema/view-api.schema.json`): the accounts Worker online and `folder-sync serve` on a machine answer the same JSON; the CLI is the Worker's client for sign-in, `me`, `credentials` and the web host. The element speaks it to whichever origin its page is on.

## Which part may import which

| From \ to | core | server-cloudflare | ui | desktop |
|---|---|---|---|---|
| **core** | | never | `ui/v1` bytes, embedded at build (`ui/embed.go`) and nothing else | never |
| **server-cloudflare** | the contract only: `readers/worker`, `schema/`, `testdata/` | | `ui/v1`, symlinked at `accounts/site/ui/v1` | never |
| **ui** | `testdata/` and `schema/` for its tests | never | | never |
| **desktop** | the `folder-sync` binary, as a sidecar process (`app/scripts/build.sh`) | never | `app/ui/` | |

`demo/` reaches the Worker only through its service binding (`/fs/*` to `folder-sync-accounts`).

## The two seam tests

Both run in CI as their own lines (`.github/workflows/test.yml`) and locally:

- **The core works with no server.** `scripts/check-core-alone` copies the checkout without `accounts/`, `demo/` and `app/`, then builds, vets and tests the core there: the e2e suite on bucket-key login against `e2e/r2standin`, the Go tests, the schema fixtures. A core that imports, reads or starts the server part fails, because the directory is not there. CI job: `core, no server (linux)`.
- **The server reaches identity through one function.** The identity port is `deps.person(request, via, app)` in `accounts/src/app.ts`, `whoIs(request) -> person | null`: every route asks it, and only the identity adapter `accounts/src/auth.ts` answers it, over Better Auth. `accounts/test/identity-seam.test.ts` fails if any other file of the server part imports `better-auth`, or if any file but the Worker entry (`index.ts`) imports the adapter (so a route cannot build Better Auth around the port). Swapping Better Auth for another sign-in means rewriting `auth.ts` and nothing else. CI job: `server-cloudflare (linux)`, step "seam 2".

## Per-part checks

| Part | Check | CI line |
|---|---|---|
| core | `go build ./... && go vet ./... && go test ./...`, `node --test schema/fixtures.test.mjs` | `test (linux)`, `test (macos)`, `test (windows)`, the two cross-OS pair lines |
| core, alone | `scripts/check-core-alone` | `core, no server (linux)` |
| server-cloudflare | `npm --prefix accounts test` (includes the identity seam) | `server-cloudflare (linux)` |
| ui | `npm --prefix ui test` (Playwright, Chromium) | `ui (linux)` |
| desktop | installers built and silently installed | `desktop-smoke` (on `app/**` changes), `desktop-release` |
