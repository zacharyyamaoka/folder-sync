# Storage: where a folder's bytes live

A folder's **store** is a URL in its `.folder-sync.toml`. folder-sync moves files with rclone, which already speaks every store below, and makes a handful of S3 calls of its own (manifests, history, restore requests). Both go through the same URL, so changing providers is changing one line. Zach, 2026-11-04: "make it storage agnostic so any backend works (s3://, gs://, S3-compatible, file://), with the Cloudflare-specific parts clearly separated from the agnostic parts, so provider prices feed the cost KPI." This is gate G7.

```toml
# .folder-sync.toml
project = "notes"
store = "s3://my-bucket/team?region=eu-west-1"   # omitted: r2://<bucket>, exactly as before
```

`folder-sync init --store URL` writes it. `bucket = "..."` alone still means `r2://<bucket>`, so every folder from before keeps working untouched.

## The four kinds

| URL | What it is | Keys | rclone | Native calls |
|---|---|---|---|---|
| `r2://bucket[/prefix]` | Cloudflare R2. The default, and the only store the accounts Worker serves. | `FOLDER_SYNC_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` / `_ACCOUNT_ID`, `login --key`, or the accounts sign-in | s3 remote, provider Cloudflare | S3 client, trusted (not probed) |
| `s3://bucket[/prefix][?endpoint=&region=&provider=]` | AWS S3 or any S3-compatible endpoint: Backblaze B2, Wasabi, MinIO, Ceph, a company's own | `FOLDER_SYNC_*`, the standard `AWS_*` variables, `~/.aws/credentials` (`AWS_PROFILE`), or a credential process | s3 remote, provider AWS / Wasabi / Other / what `provider=` says | S3 client, probed once |
| `gs://bucket[/prefix]` | Google Cloud Storage through its S3-interoperable XML API with an HMAC key | the same as `s3://`: the HMAC access id and secret go in `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (or `FOLDER_SYNC_*`) | s3 remote, provider GCS, endpoint `https://storage.googleapis.com` | S3 client, probed once |
| `file:///abs/dir` | A directory: local disk, a mounted NAS, a test folder. `file:///C:/Users/BAM/hub` on Windows. | none | rclone's local backend | `store.FileStore`, no network |

**Why `gs://` goes through the S3-interoperable API and not rclone's `gcs` backend.** The engine's own calls (conditional manifest GET, ranged GET with `If-Match`, server-side copy, create-once PUT) are S3 calls. The interoperability API lets one wire protocol, one signer and one set of tests serve R2, AWS, B2, MinIO and GCS; rclone's `gcs` backend speaks Google's JSON API, so every native call would need a second implementation and a second test matrix. The cost is that GCS's HMAC keys are a separate credential from `gcloud auth` (create one in the console: Cloud Storage → Settings → Interoperability).

The options after `?` are `endpoint=` (an `http://` or `https://` URL), `region=` and `provider=` (an rclone s3 provider name such as `Minio`). `FOLDER_SYNC_ENDPOINT`, `_REGION` and `_PROVIDER` override them: a `.folder-sync.toml` is copied between machines, and a MinIO on the LAN has another address from each. Order, first wins: the environment, the URL's options, what a credential process printed, `AWS_REGION` / `AWS_DEFAULT_REGION`, the kind's default (AWS: `https://s3.<region>.amazonaws.com`, region `us-east-1`).

The prefix (`s3://bucket/team`) is a folder inside the bucket that holds everything; it goes in front of the account root the credentials carry (`docs/CONTRACT.md`).

## One example per provider

```toml
store = "r2://folder-sync"                                    # Cloudflare R2 (the default)
store = "s3://my-bucket/folder-sync?region=eu-west-1"         # AWS S3
store = "s3://my-bucket?endpoint=https://s3.us-west-004.backblazeb2.com&region=us-west-004"   # Backblaze B2
store = "s3://my-bucket?endpoint=https://s3.eu-central-1.wasabisys.com&region=eu-central-1"    # Wasabi
store = "s3://folder-sync?endpoint=http://192.168.1.20:9000&provider=Minio"                   # MinIO / any S3 server on your LAN
store = "gs://my-bucket/folder-sync"                          # Google Cloud Storage (HMAC key)
store = "file:///mnt/nas/folder-sync"                         # a directory; nothing leaves the machine
```

Keys, per provider (set in the environment of `folder-sync sync`, or the service unit; never in the config):

```bash
# AWS S3, B2, Wasabi, MinIO: the standard variables, or folder-sync's own
export AWS_ACCESS_KEY_ID=...  AWS_SECRET_ACCESS_KEY=...          # AWS_SESSION_TOKEN for temporary keys; or a profile in ~/.aws/credentials
export FOLDER_SYNC_ACCESS_KEY_ID=...  FOLDER_SYNC_SECRET_ACCESS_KEY=...   # these win over AWS_*
# AWS SSO, an assumed role, IMDS: let the AWS CLI mint the keys. Its output is exactly the credential-process shape.
export FOLDER_SYNC_CREDENTIAL_PROCESS='["/usr/local/bin/aws","configure","export-credentials","--format","process"]'
# GCS: an HMAC key goes in the same two variables
export AWS_ACCESS_KEY_ID=GOOG1E...  AWS_SECRET_ACCESS_KEY=...
```

Not read for other stores, on purpose: `credentials.json` (what `login --key` saves is an R2 key) and this machine's accounts sign-in (its keys are the Worker's R2 keys). Handing either to an S3 or Google endpoint would send a secret to the wrong party.

## What the engine needs from a store, and what each store does

The engine relies on four conditional S3 calls (PEP 0007 §3.1, PEP 0009 §4, `docs/CONTRACT.md` "Deletions and history"):

| Call | Used for | When a store lacks it, folder-sync does this instead |
|---|---|---|
| **create once**: `PUT` with `If-None-Match: *` | a history keyframe or pointer, a change record, a restore request | HEAD first; refuses if the key exists. Safe without the header: those keys are named by their content (`<version>_<sha16>`), a sequence number or a random id, so a second writer writes the same bytes. |
| **put if match**: `PUT` with `If-Match` | a restore request's outcome | HEAD, compare the ETag, then an unconditional PUT. Safe: only the host a request names writes its outcome. |
| **copy if match**: `x-amz-copy-source-if-match` | keeping the version the manifest listed | HEAD the source, compare, then an unconditional copy. The race is a writer replacing the live file between the two requests; that host is the only writer of its own files. |
| **get if match**: ranged `GET` with `If-Match` | reading a pointer that rests on the live file | HEAD, compare, then the ranged GET. A read that raced is caught anyway: the bytes are checked against the pointer's sha256 and a mismatch is `ErrVersionMismatch`, never wrong bytes. |

A store that **ignores** a header (accepts it and does nothing) is worse than one that refuses it: the write goes through unconditionally and nothing says so. So folder-sync measures instead of trusting a name. `folder-sync init` (or the first sync) writes a scratch object under `<root>_probe/`, makes each call fail on purpose, deletes what it wrote, and keeps the answer in the project's state dir (`store-caps.json`, reused until the store URL, endpoint or root changes). A call that is refused with a 412 is honoured; one that succeeds, or errors otherwise (a 501), is checked by the engine as above, and the header is never sent. R2 is not probed (it is the baseline every PEP was written against). A store that cannot be reached at open is treated as lacking all four until a round can ask it. `FOLDER_SYNC_STORE_CAPS=none` (or `all`, or `create_once,get_if_match`) declares the answer instead of probing.

| Capability | R2 | AWS S3 | MinIO | `file://` | Backblaze B2, Wasabi, GCS interop |
|---|---|---|---|---|---|
| create once | yes (Cloudflare documents conditional writes) | yes (AWS added `If-None-Match` on PUT in 2024; not run here) | **measured: yes** (build below) | **measured: yes, atomic** across processes (a hard link) | not run here: no credentials. `init` measures; the fallback covers a no. |
| put if match | yes | yes (2024; not run here) | **measured: yes** | **measured: yes**, checked then written (not atomic) | as above |
| copy if match | yes | yes (long-standing; not run here) | **measured: yes** | **measured: yes**, checked then written | as above |
| get if match | yes | yes | **measured: yes** | **measured: yes** | as above |
| the R2 stand-in (`rclone serve s3`) | ignores copy-source-if-match and the others (its e2e comments say so); only used as R2's test double |

"Measured" is `internal/store`'s conformance suite plus the e2e journeys in `e2e/storage_test.go`, run on this machine against MinIO built from `github.com/minio/minio@v0.0.0-20260212201848-7aac2a2c5b7c` (see `scripts/fetch-minio`) and on a directory. Cells marked "not run here" are the vendors' documented behaviour or unknown; nothing was run against a real AWS, Google or Backblaze account. `TestStorageJourneyRealProvider` does it when given a bucket: `FOLDER_SYNC_E2E_S3_URL=s3://bucket/ci-prefix AWS_ACCESS_KEY_ID=... go test ./e2e -run RealProvider -v`.

## Where a store differs from R2

- **Keys over 1,024 bytes** are never kept in history on any store (`history.MaxKeyBytes`, S3's limit). A `file://` store is tighter: a filesystem refuses a path segment over 255 bytes (a long file name, or a long name's history copy), so such a file fails to upload there.
- **`file://` on a case-insensitive disk** (macOS and Windows defaults) folds names that differ only in case, as the folder itself would. Use a case-sensitive volume for a shared hub. Windows keys with `:` and the other characters Windows cannot hold are stored the way rclone's local backend stores them (fullwidth look-alikes), so rclone and the engine agree.
- **A `file://` directory that is missing is an error, never created.** An unmounted NAS is a missing directory; creating it would sync onto the local disk under the mount point.
- **Mixing processes on one `file://` directory** is safe for the engine's writes (a temp file renamed into place; create-once is a hard link). It is not a database: two machines on one NFS share see each other's renames as the share delivers them.
- **ETag** is the quoted MD5 of the content on every store (a single-part upload's ETag; the file store computes it), so `object_etag` in a manifest means the same everywhere. A multipart upload's ETag (`<md5>-<n>`) is never recorded, as before.
- **ACLs.** `x-amz-acl: private` is sent to R2 only; a bucket with ACLs disabled (AWS's default for new buckets) refuses a request that sets one.
- **Addressing** is path-style (`<endpoint>/<bucket>/<key>`) for the engine's own calls; AWS and every store above accept it.

## Cloudflare-specific and storage-agnostic

Spelled out in [`PARTS.md`](../PARTS.md). In one paragraph: the accounts Worker (Better Auth, D1, Durable Objects, R2 bindings), the web host, the pruner Durable Object, the per-person quota, the R2-Explorer viewer, `publish --viewer`, `publish --public/--private`, the accounts sign-in and `r2://` are Cloudflare's. The engine, the CLI, `folder-sync serve`, the contract, history, restore and the cost KPI are not: a folder on `s3://`, `gs://` or `file://` syncs between machines, keeps and restores history, prunes its own host's history once a day (there is no Worker to prune the rest; the e2e journeys prove keep and restore on every store, the prune schedule only on the R2 stand-in), and shows its sync view through `folder-sync serve`, with no Cloudflare account, code or credential. `scripts/check-core-alone` proves it by running the whole suite, the `file://` journey included, in a copy without `accounts/`, `demo/` and `app/` and with Cloudflare credentials unset. **The accounts Worker stays on Cloudflare** (R2, Durable Objects, D1); a deployment on another cloud is a different server part, and PARTS.md says the split into repos waits for that.

## Cost: the provider comes from the store URL

`bench/cost/prices.json` prices `r2`, `s3`, `gcs`, `b2` and `wasabi`. `bench/cost/store.mjs` `providerOfStore(url)` (and `Spec.CostProvider` in Go, the same table) maps a store URL to one of them: `r2://` is `r2`, `gs://` is `gcs`, `s3://` is `s3` unless its endpoint is Backblaze (`b2`), Wasabi (`wasabi`) or R2's own, and a MinIO, a NAS or a directory has no price (`null`: the cost points say `store_unpriced`, they do not guess). `cost_per_gb_month_usd` and `cost_per_person_month_usd` still carry one point per provider (`slice.provider`), so the dev view can compare, and the point of the provider the folder is on carries `labels.is_store_provider: true` and `labels.store`. `FOLDER_SYNC_STORE` names the store the points are for (default `r2://`).

```bash
node bench/cost/cost.mjs store 's3://my-bucket?endpoint=https://s3.us-west-004.backblazeb2.com'
```

prints what a person costs on that store's provider at the reference profile (10 GB, 3 machines, 1,000 changes a day). The Cloudflare side of the bill (Worker, Durable Objects, D1) is added whatever the bucket, as the accounts server stays on Cloudflare; a folder with no accounts server pays none of it.
