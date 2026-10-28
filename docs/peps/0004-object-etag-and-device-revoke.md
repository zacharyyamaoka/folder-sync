# 0004 · object_etag in the manifest, and revocable devices

Status: accepted (Zach, 2026-10-28: "Yes you can merge it"). Landed by fast-forwarding `claude/folder-sync-v0` to `lane/devices` @ 9d00e0f.

## Decision
1. **The manifest gets an optional per-file `object_etag`.** It is the stored object's ETag, unquoted, recorded only for a version the writer has proven to be that file's bytes.
   - It lets the Worker serve HTTP Range requests as one streamed R2 GET with `If-Match`, instead of reading and hashing the whole object.
   - Files without it still go through the whole-file, hash-checked path, capped at 24 MiB (`413 too_large_for_unversioned_range`).
   - An optional field keeps `folder-sync-manifest/1` (CONTRACT.md).
2. **Machine sessions are revocable from a page.** That covers `GET /fs/v1/devices`, `POST /fs/v1/devices/revoke` and `GET /fs/account`.
   - `session.kind` is set by the server when the session is created.
   - Only a browser session can approve a device code. The grant is bound to its approver, and refused once that approver has ended.
   - Revoking stops new storage keys at once. Keys already issued expire within their 300 s TTL.

## Why
- Video and log files must play and seek online (the Vibe Tracks owner view). Whole-file reads don't scale past a Worker's memory.
- Zach's rule: a stolen laptop can be revoked from a web page. Judge rounds 1–3 showed that this needs server-set session kinds and grants bound to their approver.

## Consequences
- **Land this alone, before `lane/fast-sync` and `lane/desktop`.** Both read the manifest, and fast-sync rewrites `internal/syncer/round.go`.
- **Browsers signed in before migration 0008 must sign in again** before they can approve a machine.
- **Old files over the cap answer 413** until their host uploads them again.
- **Not yet deployed:** this record covers the merge only. The live Worker changes at the next `wrangler deploy`, which needs D1 migration 0008 applied remotely first.

Details: PEP 0003 §3.3, §7. Judge rounds: `reports/media/audits/2026-10-28-devices-judge-r*.md`.
