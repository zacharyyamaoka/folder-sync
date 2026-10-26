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
2. **A session token** is signed on every request, folder-sync's own (`x-amz-security-token` as a signed header) and
   rclone's (`RCLONE_CONFIG_FSREMOTE_SESSION_TOKEN`).
3. **An account root.** When the keys carry a `Prefix` (`users/<id>/`), every key folder-sync reads or writes starts
   with it: `<root><project>/hosts/<host>/…` and `<root>_trash/<project>/…` (docs/CONTRACT.md). A folder's state records
   the root it was first synced under, and a round with keys for another root is refused ("folder-sync never moves a
   folder's files into another account"). WHY: two people on one computer account must never copy one person's folder
   into the other's prefix. A prefix-scoped key may not HEAD the bucket, so `init` checks it with one LIST under the root.
4. **`sync --discover`** looks for new machines this round (one LIST) instead of waiting for the 5-minute scan, so an
   app's "sync now" finds a machine that just joined. **`status --json`** prints `folder-sync-status/1` for apps.
5. **The stand-in.** `e2e/r2standin` checks requests the way R2 documents its temporary credentials (the JWT, the derived
   secret, scope or actions, `prefixPaths`), conservatively where the page is silent (a listing's prefix and a copy's
   source must lie inside the scope), in front of `rclone serve s3`. `e2e/scoped_test.go` syncs two people on three
   machines through it; its own suite has ten mutations of its rules, each red.

## What does not change

- v0's single bucket key (`FOLDER_SYNC_ACCESS_KEY_ID` … or `credentials.json`) and its keys: an empty root, the same
  state directories, the same bucket layout.
- The bucket contract's shape: a root is a prefix in front of it; readers take it as an optional argument.

## Revisit when

- R2 documents prefix scoping for listings and copy sources differently from the stand-in's strict reading
  (vibetracks' `worker/test/check-r2.mjs` asks real R2).
- Two-way `shared/` folders (v1) arrive: the lease object lives under the root too.
