# 0002 · Short-lived keys from a credential process, and an account root per person

- **Date:** 2026-10-25
- **Status:** proposed 2026-10-25, built on branch `claude/folder-sync-builtin` for Vibe Tracks' built-in sync
  (vibetracks PEP 0011b). Final when Zach merges it.
- **Source:** Zach, Oct 25 (for Vibe Tracks): "I want this to be more integrated into the application like obsidan
  sync. the user just downloads vibetracsk they don't need to think about the sync feature its already backed in", and
  "my sister and I will both want to use it and our file information needs to be kept separately".
- **Builds on** PEP 0001 §9: "v1 credential: a short-lived R2 temporary credential limited to the agent's own prefix. A
  small Worker mints it."

## Decision

1. **A credential process.** `FOLDER_SYNC_CREDENTIAL_PROCESS` names a program (a JSON array argv, `argv[0]` absolute)
   that prints keys in AWS's `credential_process` shape (`Version`, `AccessKeyId`, `SecretAccessKey`, `SessionToken`,
   `Expiration`) plus folder-sync's optional `Endpoint`, `Bucket` and `Prefix`. folder-sync runs it before every round,
   caches the answer in `~/.folder-sync/session.json` (0600) and asks again when less than `min(5 min, a third of the
   key's life)` is left. Exit 3 means signed out or revoked: the cache is deleted and the command exits 4. Any other
   failure is transient: keys still valid for more than 30 s carry on.
   - **WHY a process and not keys in the environment:** the keys change every few minutes and the app that owns the
     sign-in (vt) is the only thing that can refresh them; folder-sync stays ignorant of any app.
   - **WHY AWS's shape:** it is the stock convention every S3 tool already knows; folder-sync adds three fields an app
     needs to tell it (where, which bucket, which root), and ignores the rest.
   - **`ReadOnly` and `Reason`** (optional, review r2 #7): `"ReadOnly": true` says the keys only read, as the accounts
     Worker issues them to an account over its storage quota (PEP 0003 §3.7), and `Reason` says why, in a sentence
     folder-sync prints. A round with read-only keys skips the reconcile, holds its uploads (the round fails, naming
     them and the reason), sends its deletes to the accounts server (`POST …/hosts/<host>/delete` with a job id, the seq it
     last published and the paths; the server builds the next manifest, deletes them permanently, lowers the usage
     and answers the manifest, which folder-sync keeps once checked). The job is kept in the project's state dir
     (`delete-job.json`) until its answer comes, and asked for again first thing next round (its answer is checked
     against the job's own seq; a job whose result this machine already holds, by a reconcile or a restart before the
     file went, is simply retired: review r4 #4; jobs are cut to fit the server, at most 400 paths and 250 KiB of request each,
     and a kept job the server refuses as too large is split: review r5 #3); a server that says the
     manifest moved on makes the round take its own manifest from the bucket, a read, as its read-only reconcile does
     when that one is ahead. Whatever goes wrong there, the round still pulls. Absent, the keys read and write, as before.
2. **A session token** is signed on every request, folder-sync's own (`x-amz-security-token` as a signed header) and
   rclone's (`RCLONE_CONFIG_FSREMOTE_SESSION_TOKEN`).
3. **An account root.** When the keys carry a `Prefix` (`users/<id>/`), every key folder-sync reads or writes starts
   with it: `<root><project>/hosts/<host>/…` and `<root>_trash/<project>/…` (docs/CONTRACT.md). A folder's state records
   the root it was first synced under, and a round with keys for another root is refused ("folder-sync never moves a
   folder's files into another account"). WHY: two people on one computer account must never copy one person's folder
   into the other's prefix. A prefix-scoped key may not HEAD the bucket, so `init` checks it with one LIST under the root.
4. **`sync --discover`** looks for new machines this round (one LIST) instead of waiting for the 5-minute scan, so an
   app's "sync now" finds a machine that just joined. **`projects --json`** lists the projects under the keys' account
   root (one delimiter LIST), so an app can join a person's next machine to the folders they already sync.
   **`status --json`** prints `folder-sync-status/1` for apps.
5. **The stand-in.** `e2e/r2standin` checks requests the way R2 documents its temporary credentials (the JWT, the derived
   secret, scope or actions, `prefixPaths`), conservatively where the page is silent (a listing's prefix and a copy's
   source must lie inside the scope), in front of `rclone serve s3`. `e2e/scoped_test.go` syncs two people on three
   machines through it; its own suite has ten mutations of its rules, each red.

6. **One writer per host is a convention inside one person's root, not a fence** (review r2 finding 10, kept as is).
   A machine's keys are scoped to its own person's root, `users/<id>/`, read-write, so they also reach that person's
   other hosts' prefixes, the folder's web host (`hosts/<web-host-id>/`, PEP 0003 §3.4) included. A buggy or hostile
   client on one of a person's machines can therefore overwrite or break that person's own other hosts; it cannot reach
   anyone else's root. The gap stays inside one person's own machines, never across people. WHY not fenced now: an R2
   temporary credential carries one scope for all its `prefixPaths` (read-write or read-only, no deny), so "read the
   whole root, write only my own host" takes two keys. **Future option:** the credential process prints two key sets,
   read-only for the root and read-write for the machine's own `<project>/hosts/<host>/` and `_trash/<project>/<host>/`
   per project, and the engine pushes with the second; the accounts Worker then needs the host id and the projects.
   That changes this contract, so it waits for a need.

## What does not change

- v0's single bucket key (`FOLDER_SYNC_ACCESS_KEY_ID` … or `credentials.json`) and its keys: an empty root, the same
  state directories, the same bucket layout.
- The bucket contract's shape: a root is a prefix in front of it; readers take it as an optional argument.

## Revisit when

- R2 documents prefix scoping for listings and copy sources differently from the stand-in's strict reading
  (vibetracks' `worker/test/check-r2.mjs` asks real R2).
- Two-way `shared/` folders (v1) arrive: the lease object lives under the root too.
