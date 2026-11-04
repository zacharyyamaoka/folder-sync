# 0010 · A shared tree: every device edits every file; the folder's object orders changes and merges the rare collision

- **Date:** 2026-11-04
- **Status:** Accepted-Implemented, 2026-11-04. Accepted that day (Zach, relayed: "go with the recommendations"), with every §13
  default: the tree lives at `<project>/hosts/<shared-id>/` (L2); shared folders need the accounts server in v1; conflict copies
  are named `(Conflicted copy <device> <YYYYMMDDHHMM>)`; nothing is private unless named at `share` time. Built the same day on
  `lane/shared-tree-0010`; "As built" (§16) says what the build did and did not do. The contract's "two-way folders are v1" is
  gone: `docs/CONTRACT.md` "The shared tree" is the rule now.
- **Source:** Zach, 2026-11-04, in `PROJECT - Folder Sync`, on the `C - Single Writer Principle` bullet:
  1. "I am not sure if this is the design we want to take here though? Are there other options? I think the goal is
     to have something more like obsidian sync, github..."
  2. On the recommendation in that note's `[!ai]-` callout (`ai-singlewriter-nov4`, option C: one shared tree,
     ordered by the server; text conflicts merged three-way, binary ones kept as conflict copies): "Ok I agree with
     you rreccomendation".
  3. The note's hypothesis: "How do I give the ergonomics of a webapp, with the file first approach?" and "Obsidian
     Sync — Its basically perfect BUT, I wish I could see obsidian Online".
- **Replaces:**
  - PEP 0001 §6: two-way folders under a lease, with rclone bisync;
  - PEP 0007 §3.4 and §10.7's default for two-way folders, "keep both". On Nov 4 Zach took the recommendation that
    text merges by default.
- **Builds on:**
  - PEP 0003 §3.4: the web host, whose single writer is the folder's Durable Object, with its queue and journal;
  - PEP 0005: the hub;
  - PEP 0007: path-first history and change records;
  - PEP 0008: the bench, and the save-storm race;
  - PEP 0009: pointers and the 5-minute rule.
- **Prior art:** Obsidian Sync [1,2], git [3,4], Dropbox [5], Syncthing [6]. CRDTs (Automerge, Yjs) are the rejected
  alternative [7–9].

## 0. The decisions on one screen

1. **A shared tree beside each machine's own.** A folder that opts in gets one tree that every device, agent and page
   edits. `hosts/<id>/` stays for each machine's private files: none by default; Vibe Tracks would name `events/`.
2. **The folder's Durable Object is its one writer.**
   - A device never writes the shared tree in the bucket. It sends each change to the object, with the version the
     change was made from (its *base*).
   - If the base is still the current version, the object writes the change: a compare-and-swap, git's fast-forward
     [3].
   - The manifest PUT carries `If-Match`, as the web host's already does.
3. **Where it lives is Zach's call** (§4). Recommended: `<project>/hosts/<shared-id>/`, a host whose writer is the
   folder's object, as the web host's is. Every reader then works unchanged, and so do the history, record, prune and
   quota code. The alternative is the reserved `<project>/shared/`.
4. **On a mismatch, the object resolves it, in one place, for machines, agents and pages alike:**
   - both sides only appended whole lines: both tails, the earlier commit's first;
   - other text up to 4 MiB: a three-way merge by lines (diff3, git merge-file semantics, node-diff3), with the base
     from `_history/`. A JSON, JSONL, canvas, YAML or TOML result must still parse;
   - anything else, or a merge that collides: the first change stays at the path, and the later one becomes
     `name (Conflicted copy <device> <YYYYMMDDHHMM>).ext`, Obsidian's own name. No conflict markers are ever written
     into a file;
   - an edit beats a delete.
5. **A device's base is the hash of bytes it wrote,** never what a manifest claims, and a device never overwrites a
   local edit. PEP 0008's save-storm race breaks exactly this rule in host mode, and the same rule fixes it there
   (§9).
6. **Nothing is lost.**
   - A three-way merge keeps both of its inputs in history, whatever the throttle.
   - If the throttle dropped a merge's base, the object uses the newest older version. diff3 then reports more
     collisions; it never repeats text.
7. **Accounts only, in v1.** A shared tree needs the folder's object, so a folder on a bare bucket key stays
   host-only.
8. **Opt in per folder,** with `folder-sync share`. Existing folders change nothing until then.
9. **The test:** the nothing-lost soak gains "two devices edit one file offline; neither edit is lost", plus nine
   other shared cases (§11).
10. **CRDTs are rejected.** They need the app's data in their own format; folder-sync's promise is plain files any
    tool can edit.
11. **This is a durable decision** about who writes a shared file and where it lives in the bucket. A later rewrite
    must not quietly re-decide it; this PEP is its record.

## 1. The frame: what the ask assumes, and what is true here

1. **The single writer was at the wrong level, not wrong.**
   - Today each machine writes only `hosts/<own id>/`, so two devices can never edit one file (PEP 0007 §1.1). That
     is Syncthing's "send only", not Obsidian Sync.
   - Obsidian Sync, git and Dropbox have one writer too: the server's ordering of changes.
   - folder-sync already has that writer: each folder's Durable Object, which runs every web write and delete of the
     folder "one at a time" (PEP 0003 §3.4) [10].
2. **"Like Obsidian Sync, GitHub" means conflicts become real.**
   - Obsidian merges a Markdown conflict with diff-match-patch, merges its own settings JSON key by key, and lets the
     last modified win for every other file. Since 1.9.7 it can write a conflict file instead [1].
   - git refuses a push that is not a fast-forward [3].
   - So folder-sync now needs a merge, and a visible copy for what will not merge.
3. **The base has to be exact.** A three-way merge is only as right as its base.
   - PEP 0008 measured the engine getting it wrong: in save storms, a machine took its own pull for a local edit and
     parked a conflict copy, twice in 40 storms [11].
   - In a shared tree that mistake becomes a commit.
4. **A sequencer means a server.**
   - The bucket alone can do an atomic conditional PUT [12], but not "write the new bytes only if you win". A loser
     would already have overwritten the live file.
   - So the shared tree needs the folder's object, which means the accounts Worker. A folder on a bare bucket key
     stays host-only (§15).
5. **PEP 0001's plan was a lease and rclone bisync.**
   - PEP 0008's bench measured bisync losing the final save in 3 of 10 storms [11].
   - A folder-wide lease would also make every device wait for every other device's whole round.
   - It is replaced, not built.

## 2. Weights

These are from the `ai-singlewriter-nov4` callout Zach accepted [16], which also carries the gate: **one shared file
tree that any device or agent can edit.**

| Criterion | Weight | Why |
|---|---|---|
| Nothing silently lost: every edit ends in the file, a conflict copy, or history | 30 | KPI 2, the gate |
| Feels like Obsidian Sync: edits just appear, and the rare conflict is handled for you | 25 | Zach's ask |
| Plain files at their paths, which agents and apps read and write with any tool | 15 | file over app |
| Stock parts, and a small change to reviewed code | 15 | his first rule |
| Speed and cost: KPI 1, KPI 3 and PEP 0009's H | 15 | |

## 3. A · Who orders the changes

| Option | Lost (30) | Feel (25) | Files (15) | Small (15) | Cost (15) | Score |
|---|---|---|---|---|---|---|
| (a) A lease per folder, then rclone bisync (PEP 0001 §6) | 15: bisync lost the final save in 3 of 10 storms [11] | 8: one device at a time | 15 | 10 | 8 | 56 |
| (b) Devices compare-and-swap the manifest in R2 themselves, each version under its own key | 26 | 18 | 8: the readable path is a copy that can lag the manifest | 6: merges on every device, in Go and in JavaScript | 10: every save is written before the throttle can see it | 68 |
| **(c) The folder's Durable Object is the one writer; devices send (base, bytes)** | 28 | 23 | 15 | 11: the web host's queue and journal, opened to devices | 12: one Worker hop per change, inside Workers Paid | **89** |
| (d) A CRDT per file (Automerge, Yjs) | 27 | 24 | 3: the data lives in the CRDT's own binary updates [7–9] | 3 | 10 | 67 |
| (e) git as the backend: commit and push | 28 | 8: commit, pull and merge by hand | 12 | 6 | 7 | 61 |

**Chosen: (c).** It keeps plain files at readable keys, and it keeps the single writer, moved up one level: one
sequencer per folder, not one writer per machine. It is the callout's option C [16].

## 4. B · Where the shared tree lives (the bucket contract: Zach's call)

| Option | Readers unchanged (25) | One code path for history, records, prune, quota, view and restore (25) | Clear to an app author (20) | Matches "beside hosts/" and the reserved name (15) | Migration (15) | Score |
|---|---|---|---|---|---|---|
| **L2. `<project>/hosts/<shared-id>/`: a host whose writer is the folder's object. Its manifest gains `"shared": {"private": […]}` and `host_name: "shared"`** | 25: every reader lists it like any host | 25 | 14: a reader that ignores the field shows the files under a host named "shared" | 9 | 15 | **88** |
| L1. `<project>/shared/`, with `shared/manifest.json` | 5: readers list `hosts/`, and would miss it | 10: "shared" is not a host id, so every key parser, schema and route learns a second form | 20 | 15 | 12 | 62 |

- **WHY L2:** it is PEP 0003 §3.4's own reason for making the web host a host: "every reader reads
  `hosts/<host>/<path>` and checks it against the manifest, and a second layout would change the contract for all of
  them" [10].
  - The history key parsers already require the host segment to be a UUID (`internal/history` `ParseKey`,
    `accounts/src/history.ts`).
  - A machine on an older engine sees the shared files read-only, under `hosts/<shared-id>/`, and keeps working as
    host-only.
- **What leaves the contract:** `<project>/shared/` and `_leases/`. Both were reserved and never written.
- **The shared tree's id** is a UUID v4 minted by the folder's object when the folder is shared, kept in a D1 row
  `shared_tree(owner_id, project, host_id, created_at)`, as `web_host` is.

## 5. C · A change, end to end

**What a device keeps** (local state, not contract): for each shared path, its *base*. That is the version id
(`written_at` and `sha16`), sha256 and size its file was last known to hold. A device sets it only after it has hashed
the bytes it wrote (a pull) or the bytes it sent (an accepted commit).

**A round on a device in a shared folder:**
1. Scan. Compare each shared path's file with its base: size and mtime first, then the hash.
2. **Commit** every changed, new or deleted shared path, in one request per round:
   - `POST /fs/v1/folders/:project/shared` (bearer)
     `{changes: [{path, base | null, sha256, size, body | staged | delete: true, at_local}]}`, where `at_local` is the
     device's local time, for a conflict copy's name;
   - a body of up to 1 MiB per file travels inline, up to 8 MiB per request;
   - a bigger file is first uploaded to `<root>_incoming/<project>/<host>/<uuid>` with the machine's own key, and
     named by `staged`;
   - the engine's guards still apply: `max_delete`, and the refusal to push a folder that looks unmounted. The
     object applies the same `max_delete` to each commit.
3. **The object answers each path:**
   - `accepted`, with the new version;
   - `merged`, with the merged version, and the id under which it kept the device's own bytes;
   - `conflict`, with the path's current version and the conflict copy's path;
   - `edit_won`: the device's delete was not applied, because another device had changed the file. It comes back.
4. **Pull the shared manifest** (it has moved). For each path whose file still holds its base, or what was just sent:
   - fetch the new version with a native GET carrying `If-Match` on its `object_etag`. The object always records
     one, from its own PUT's answer;
   - check the sha256, check the local file once more, and rename the new version over it. Set the base.

   A path whose file changed in the meantime is a new edit. It is committed next round, with the version id the
   object returned as its base.
5. **Never overwrite a file that differs from its base.**

**What the object does with one path.** This runs in its queue, one change at a time, journalled like a web-host
write.
1. **The base is the current version, or holds the same bytes, or both are absent: accept.**
   - Keep the leaving version per PEP 0009 (a pointer when the new bytes start with it).
   - Write the new bytes, then the manifest (`If-Match`).
   - Queue the change record, tell the hub, and delete the staged object.

   This is exactly a web-host write (`webhost.ts` `writeWebFile`), undo copy and all.
2. **Otherwise, resolve it** (§6).

**Pages** write the same way: `PUT /fs/v1/folders/:project/shared/<path>` with `X-Folder-Sync-Base: <version>`
(absent for a new file), under PEP 0003 §3.3's CSRF rules.
- An app that merges its own data sends `X-Folder-Sync-Merge: never`; a mismatch is then a `412`.
- robotparts' keep-newest hearts stay on the web host anyway.

**Latency.** A shared change takes the web host's path: Worker, then the object, then R2. PEP 0008 measured that path
at 286 ms p50, web to machine, tuned [11]. The bench gains a shared direction before the build is called done (§11).

## 6. D · On a mismatch

### 6.1 Where the merge runs

| Option | Lost (30) | One implementation for machines, agents and pages (25) | Large files (15) | No retry storms when two devices collide (15) | Small (15) | Score |
|---|---|---|---|---|---|---|
| **In the folder's object (TypeScript)** | 28 | 25 | 8: text up to 4 MiB; anything bigger becomes a conflict copy (128 MB per isolate [13]) | 15: the object is the sequencer | 11 | **87** |
| On each device (Go), then a commit with the other side as the base | 28 | 8: Go for machines, JavaScript for pages | 15 | 8: two devices merging one file can keep losing the swap to each other | 9 | 68 |

**Chosen: the object.** The engine then needs no merge library. If a device ever has to merge (bucket-key folders,
§15), the Go library is epiclabs-io/diff3, a port of the same node-diff3 (MIT) [15].

### 6.2 The algorithm

| Option | Never repeats or garbles text (30) | Merges what people expect (25) | Files that apps parse stay valid (20) | Stock and maintained (15) | Small (10) | Score |
|---|---|---|---|---|---|---|
| **diff3 by lines (git merge-file semantics [4]; node-diff3, MIT [14]). A change both sides made is taken once; overlapping changes are a conflict. Then a parse check** | 28 | 18: two edits to one line conflict | 18 | 13 | 9 | **86** |
| diff-match-patch: the other side's patches applied fuzzily (Obsidian's) [1,17] | 15: Obsidian warns it "may sometimes create duplicate text or formatting problems" [1]; a patch applied to text that already holds it inserts it again | 24: it merges inside a line | 8 | 6: Google archived the repository on 2024-08-05 [17] | 9 | 62 |
| A key-level JSON merge (Obsidian's for settings: local keys over remote [1]) | 25 | 18 | 18 | 6 | 4 | 71 |
| CRDT text | rejected in §3 | | | | | — |

**Chosen: diff3 by lines,** with the input split into lines (node-diff3 splits on whitespace unless told otherwise
[14]) and two additions:
- **Tails first.** When a base exists, both sides start with its bytes, and both added only whole lines (PEP 0009's
  prefix check), the result is theirs plus our tail, with no diff. WHY: git's merge calls two appends at the end of a
  file a conflict. This covers JSONL logs and any append-only text. Two new files at one path have no base, so they
  never take this rule.
- **A parse check.** A `.json`, `.canvas`, `.jsonl` (every line), `.yaml`, `.yml` or `.toml` result that no longer
  parses is a conflict.
  - WHY: a clean merge can still be wrong (`C - Semantic Merge Conflict`) [16].
  - For a file an app parses, a broken file is worse than a visible copy. That was PEP 0007 §3.4's reason for "keep
    both", and it is kept here as a check rather than a ban.

**Which files merge:** valid UTF-8 with no NUL byte, up to 4 MiB, with one of these suffixes: `.md`, `.markdown`,
`.txt`, `.json`, `.jsonl`, `.yaml`, `.yml`, `.toml`, `.csv` and `.canvas`. The list is a contract default. Everything
else becomes a conflict copy.

### 6.3 What survives each case

| Case | Result | History |
|---|---|---|
| Both appended whole lines | theirs plus our tail | theirs leaves as a pointer (PEP 0009); nothing else is kept |
| Text, merged cleanly | the merged file | **both inputs are kept**, whatever the throttle: theirs as the leaving version, ours under its own version id |
| Text that collides, binary, too big, or failing the parse check | the path keeps the first change; ours becomes `<name> (Conflicted copy <device> <YYYYMMDDHHMM>)<.ext>` | the copy is a new shared file |
| Our delete, their edit | their edit stays; our file comes back (`edit_won`) | |
| Our edit, their delete | the file comes back, with our edit | their delete kept the deleted version when it left |
| Both added the same path | the same bytes: one file. Different text: merged against an empty base, so a conflict copy unless the two agree | |
| Both deleted it | gone | the version was kept when it left |

- **The conflict copy's name** is Obsidian's exact form [1].
  - The device part is the committer's `host_name` (a page's: its `via`, like "Chrome on Linux"). Any character other
    than a letter, digit, space, `.`, `_` or `-` becomes `-`, so the name is valid on Windows.
  - The time is the committer's local time (`at_local`).
  - A name that is taken gets ` 2`, ` 3`.
- **A conflict copy syncs to every device,** like any shared file, as Syncthing's do [6]. The activity log shows a
  `conflict` event, and the status turns amber (PEP 0007 §5.3).
- **Which side stays:** the first change to reach the object.
  - That is git's "first push wins" [3], and Obsidian's "The original file keeps the remote version" [1].
  - Dropbox likewise puts the later save in the conflicted copy [5].

### 6.4 When the throttle dropped the base

- The object takes the base from the path's history. PEP 0009 keeps one version per 5 minutes, so a base that lived
  less than that may be gone.
- **The object then uses the newest kept version written before the base.**
  - diff3 takes a change that both sides made only once. So an older base can only add collisions, never repeat text.
  - One wrinkle remains: a line the other side deleted after the true base can come back.
- A version that a merge replaces is always kept, so a device whose next edit is based on the merged result finds
  its base.

## 7. E · Private files, and opting in

- **`folder-sync share <project> [--private <pattern>]…`** is the owner's command. It needs a signed-in device.
  - The object mints the shared tree's id.
  - It writes the tree's empty manifest, with `"shared": {"private": [...]}` (gitignore patterns, as `ignore` and
    `no_history` use).
  - It tells the hub.
- **One rule per folder.** Every machine reads the private rule from that manifest:
  - a path that matches stays in the machine's own `hosts/<id>/`;
  - everything else is shared.

  WHY in the manifest: each machine's `.folder-sync.toml` is its own, so a per-machine rule could disagree.
  `[modes]` keeps refusing `shared`, and its message now points at `folder-sync share`.
- **Migration, per machine, at its first round after the share:**
  - Each non-private file is committed with no base. The first machine's version wins. The same bytes on another
    machine change nothing; different bytes become a conflict copy.
  - The file then leaves that machine's host manifest. That is a move, not a delete: `max_delete` does not count it,
    and its old versions stay in the host's history for 30 days.
  - Other machines' copies under `hosts/<id>/` shrink to the private files as each machine moves.
- **Not in v1:**
  - changing `private` after the share. The object refuses shared writes to private paths (`409 private_path`);
  - turning sharing off. The tree stays readable in the bucket, and `rclone copy` gets it.
- **Unchanged:** folders that are not shared change nothing, and web-host files stay on the web host.

## 8. F · With PEP 0009

1. **Pointers.**
   - The object holds the exact bytes it writes, so its append check is exact, and a commit that only appends keeps
     a pointer of about 125 B.
   - For a staged file it reads the staged object once, to check its sha256 and prefix. It does so up to 1 GiB. Above
     that, it trusts the device's sha256, as a machine's own manifest is trusted today, and keeps keyframes only.
2. **The throttle** runs in the object, per shared path, as it does for the web host (its journal's record of the last
   kept version). A three-way merge's inputs are always kept; a clean tails merge keeps nothing extra.
3. **Merges on tails.**
   - When both sides only appended, theirs is a prefix of the result, so it leaves as a pointer.
   - Two machines appending to one shared log cost about 125 B per kept version, so the log copied whole 291 times a
     day does not come back [18].
   - Per-machine logs are still better kept private: no Worker hop, and no merge at all.
4. **zstd.**
   - The object has no stock zstd encoder (PEP 0009 §6), so the shared tree's keyframes are plain in v1. For notes
     that people edit that is small. Files a machine rewrites every minute belong in `private`.
   - Revisit: a device sends the compressed copy it made of the version its change replaces; the object checks it with
     fzstd and stores it.

## 9. G · With PEP 0008's save-storm race

- **The race.** `pullPeer` saves a peer's manifest as "what I pulled" even when the fetched bytes were a newer upload
  (the round's `consistent` flag is false, and the manifest is saved anyway) [19].
  - At the next pull, the local copy matches neither the old entry nor the new one.
  - `unchangedSince` compares it with the manifest's claim, finds a difference, and parks it as "edited here".
  - That is a wrong base.
- **In the shared tree it cannot happen.**
  - A device sets its base only from the hash of the bytes it wrote.
  - It fetches with `If-Match` on the object's `object_etag`; a 412 means it reads the manifest again.
  - So it never holds bytes the manifest does not list.
- **The same rule fixes host mode.** Record, for each peer path, the sha256 of what the fetch actually wrote, and call
  a local copy an edit only when it differs from that.
  - The fix is in one function, `round.go` `pullPeer`, and PEP 0008's `storm` workload is its test.
  - It belongs to PEP 0008's fix (§7.3 there), and it is a prerequisite here: a shared tree must not start on an
    engine that mistakes its own pulls for edits.

## 10. Build plan

**Barriers, in order:**
1. PEP 0009's B0 contract.
2. PEP 0008's storm fix (§9).
3. This PEP's B0 contract, which lands alone:
   - `docs/CONTRACT.md`: the shared host, its writer, the private rule, the merge rules, the mergeable suffixes, the
     conflict-copy name, `_incoming/`. "Who writes" gains the shared host;
   - `docs/API.md`: the commit route and the page route, with their answers;
   - `schema/`: the manifest's `shared` field; a commit's `outcome`; on events, `merge: {base, yours, result}` and
     `by_host`/`by_name`;
   - fixtures in `testdata/shared/`: merges, tails, collisions, parse failures, names, an older base.

No lane edits these.

| Lane | Write set | Proves |
|---|---|---|
| `lane/shared-worker` | the folder's object: commit, resolve, the shared host's manifest, `share`; a vendored node-diff3; the routes; `accounts/test/shared*.test.ts` | every `testdata/shared/` fixture; journal recovery mid-commit; the CSRF and owner rules red without them |
| `lane/shared-engine` | `internal/syncer/**` (shared pull and push, the base state, native GETs with `If-Match`, staging, migration), `cmd/folder-sync/share.go` and its dispatch line, `e2e/shared_test.go` | the soak's cases (§11) on the local stack |
| `lane/shared-view` | the element: the shared host shown as the folder itself, not a device; conflict copies in the amber state | the view-api fixtures, plus a shared folder |
| `lane/shared-bench` | `bench/fast/`: a `shared` direction, and the randomized soak workload | KPI 1 for shared changes; the soak below |

- The paths are those at 6e1baf3. `lane/parts` is renaming the repo's parts, so a lane cut after it uses its names.
- Deploys, and the D1 migration for `shared_tree`, stay Zach's.

## 11. Test plan

**The nothing-lost soak (KPI 2's gate)** is PEP 0008's harness [11]: two machines, each in its own network namespace,
plus the web host, with `drop` and `sleep` faults. It runs a randomized workload of edits, appends, deletes, renames,
kills mid-commit and offline spells.

Every run must end converged, with every device holding the same shared files, and every edit present in a file, a
conflict copy or history. 0 lost versions. The shared cases:

1. **Two devices edit one file offline; neither edit is lost.** A and B are dropped, and each edits `notes/plan.md`,
   once on different lines and once on the same line. Then both come back:
   - different lines: one merged file holding both edits;
   - the same line: the file holds the first change, and the conflict copy holds the second, byte-identical to what
     B wrote;
   - either way, both inputs are restorable from history.
2. Both append to one shared JSONL while offline: both tails, no conflict copy, and only pointers in history.
3. A binary file edited on both: a conflict copy, and both versions sha256-identical to what each device wrote.
4. An edit against a delete, in both orders: the edit survives.
5. Both add the same new path: the same bytes give one file; different bytes give a conflict copy.
6. **A save storm.** One device saves a file 20 times, 50 ms apart, while the other only pulls: 0 conflict copies,
   and identical final bytes. This is the PEP 0008 race's regression test. Then the two take turns, each editing after
   the other's change has arrived: still 0 conflict copies.
7. A device killed mid-commit, and the object restarted mid-change: the journal settles, and nothing is left
   half-written.
8. A merge whose base the throttle dropped: no repeated line (a fixture).
9. A JSON merge that no longer parses: a conflict copy.
10. A device named `bam:laptop/2` that conflicts twice in one minute: the names are valid on Windows, and the second
    gets ` 2`.

**The other measures:**
- **KPI 1:** the bench's `shared` direction, machine to machine and machine to web, p50 ≤ 1 s. It is reported beside
  the host-file numbers.
- **PEP 0009's H:** two devices appending to one shared log for an hour cost no more history than one device appending
  to its own.

## 12. What does not change

- private files, the web host, and one writer per machine host;
- the hub protocol: the shared tree is one more host id;
- the history layout and the change record (it gains optional fields);
- folders that are not shared;
- `status --json`;
- PEP 0007's view API: the shared host is one more host.

## 13. Open questions for Zach

Accepted 2026-11-04: every recommendation below is the decision.

1. **Where the shared tree lives (the bucket contract).**
   - **Recommendation and default:** L2, `<project>/hosts/<shared-id>/`, with the reserved `shared/` and `_leases/`
     dropped from the contract (§4).
2. **Shared folders need the accounts server in v1.** A folder on your own bucket key (PEP 0007 §6's public path)
   stays host-only.
   - **Recommendation and default:** yes. Option (b) of §3 is the way in for bare-bucket folders, when someone asks.
3. **The conflict copy's name.**
   - **Recommendation and default:** Obsidian's exact `(Conflicted copy <device> <YYYYMMDDHHMM>)`, so it reads like
     the reference app. The alternative is the callout's shorter `(conflict <device> <time>)`.
4. **The private default.**
   - **Recommendation and default:** nothing is private unless named at `share` time, so it feels like Obsidian. For
     `~/vt/zach`, Vibe Tracks would name `events/`.

Already decided by Zach on Nov 4, so not asked: text merges by default; binary files and collisions become conflict
copies.

## 14. Evidence

### What was checked

- **The code,** on `claude/folder-sync-v0` at 6e1baf3:
  - `internal/syncer/round.go` `pullPeer`: the cached manifest is saved even when a fetch was inconsistent, and
    `unchangedSince` compares with the manifest's sha256;
  - `internal/config/config.go`: `ModeShared` is refused in v0;
  - `internal/history/history.go` `ParseKey`: the host must be a UUID v4;
  - `accounts/src/webhost.ts` `writeWebFile`: the undo copy, the journal, `If-Match` on the manifest, and
    `object_etag` from the PUT's answer;
  - `accounts/src/webhost-do.ts`: one object per (person, project), with a queue inside it.
- **Vendor documentation** for every claim about another product and every limit (Sources). It was fetched on
  2026-11-04, including:
  - Obsidian's conflict handling and its conflict-file name;
  - git's fast-forward and `--force-with-lease`, and `git merge-file`;
  - Dropbox's and Syncthing's conflict copies;
  - R2's conditional writes;
  - Workers' limits;
  - node-diff3, epiclabs-io/diff3, sergi/go-diff, Google's archived diff-match-patch, Automerge and Yjs.

### What was not verified

- node-diff3's speed on a 4 MiB input inside a Durable Object, and the memory three such buffers take.
- The latency of a shared change. It is estimated from the web host's measured path; the bench's `shared` direction
  measures it.
- How Obsidian merges internally, beyond its help pages.
- R2's answer to a Range GET or GET with `If-Match` on an object the object wrote. PEP 0004 relies on it, and the
  e2e stand-in ignores conditionals (PEP 0007 §11).
- Whether "an edit beats a delete" is what Obsidian does. Syncthing renames the losing file to a conflict copy even
  when the delete wins [6]; this PEP keeps the edit at its path instead.

## 15. Revisit when

- **Someone wants a shared folder on their own bucket:** option (b) of §3. Devices compare-and-swap the manifest in
  R2, each version under its own key, and merge on the device with epiclabs-io/diff3.
- **A shared tree passes about 5,000 files:** its manifest is rewritten on every commit, and at that size it passes
  about 1.5 MB. Split it.
- **Renames show up in the soak or in real use:** folder-sync sees a rename as a delete plus an add, so an edit that
  races a rename leaves both names. The fix would be rename detection by sha256.
- **Workers get a stock zstd encoder:** compressed keyframes in the shared tree.
- **Two people want to type into one document at once:** that is a CRDT inside that app's editor, saved as a plain
  file, not in folder-sync.

## 16. As built

Built on `lane/shared-tree-0010` by one lane, which took the Worker lane's and the engine lane's write sets and the §11 tests
(§10 had split them). Not built here: `lane/shared-view` (the element still shows the shared host as a device named "shared")
and `lane/shared-bench` (the bench's `shared` direction and the hour-long H run). The barriers §10 lists were already met on
the base: PEP 0009 is built, and `pullPeer`'s save-storm race is not reachable from the shared tree (§9: a base is a hash of
bytes this machine wrote or sent). Deploys and the D1 migration stay Zach's: `0011_shared_tree.sql` only adds a table.

**Where it is.**

| Part | What | Where |
|---|---|---|
| Worker | `share`, the commit, a page's `PUT`/`DELETE`, restore of a shared file; the merge; the journal for a batch | `accounts/src/shared.ts`, `shared-merge.ts`, `webhost.ts` (`Pending.more`, `Refusal`, `SHARE`/`SHARED_COMMIT`/`SHARED_RESTORE`), `app.ts`, `view.ts`, `store.ts`, `migrations/0011_shared_tree.sql` |
| Vendored | node-diff3 3.2.1 (MIT), smol-toml 1.4.2 (BSD-3), yaml 2.8.1 (ISC): `parse` only, for the parse check | `accounts/src/vendor/` |
| Engine | the shared push and pull, the state, the migration, `share` | `internal/syncer/shared.go`, `round.go` (`Push` splits the host, `pullPeer` hands the shared host on), `run.go`, `cmd/folder-sync/share.go`, `internal/account` (`Share`, `SharedCommit`), `internal/ignore` (`CompileOnly`) |
| Contract | the manifest's `shared`, `by: shared`, the `conflict` event in a record, `by_host`/`by_name`/`merge` | `schema/`, `testdata/shared/`, `docs/CONTRACT.md`, `docs/API.md` |
| Proofs | the merge and the Worker; the engine's bookkeeping; the real Worker with the real binary; the soak | `accounts/test/shared*.test.ts`, `internal/syncer/shared_test.go`, `e2e/shared_test.go`, `e2e/shared_soak_test.go` |

**How the choices above came out.**

- **§13.** Every default as accepted. Conflict copies: ` 2`, ` 3` go after the closing parenthesis, before the extension.
- **A commit is one manifest version** for however many paths it holds (up to 100 a request, 1 MiB a file inline, 8 MiB a request),
  where §5 wrote "exactly a web-host write" per path: a first sharing of a thousand notes would otherwise rewrite the manifest a
  thousand times. The web host's journal grew a batch (`Pending.more`): each path is settled on its own, and the manifest takes all
  of them or none.
- **`[modes]` still refuses `shared`** (§7), with a message that points at `folder-sync share`; the type is `config.ErrUseShare`.
  Whether a folder is shared is read from the shared host's manifest, which a machine meets at its first discover.
- **Files over 64 MiB stay on the machine's own host** in v1: the object holds a file in memory to hash and merge it (128 MB per isolate).
- **The pointer** is written after the manifest, from the whole copy that is the commit's undo (so a cut-off commit never has a
  pointer to undo); the pin (PEP 0009 §4.3) is remembered per path in the object's storage.
- **Two fixes the real stack found.** The Worker signed `plan (Conflicted copy …).md` escaped and sent it with literal parentheses,
  and a prefix with `+` for a space; a store that checks the path and query as sent refused both (`s3-bucket.ts`
  `encodeKey`, `wire`). R2 itself may have accepted them; the conflict copy's name always has both, so the Worker now sends what it signs.
- **`_incoming/`** objects are deleted by the commit that took them, and by the folder's prune after a day if no commit came.

**What stays open.**

- *Unverified:* node-diff3 on a 4 MiB input inside a Durable Object (a merge is refused as `too_big` above 200,000 lines); R2's own
  answer to the conditional GET and PUT the shared tree uses (the dev stack's stand-in ignores conditionals, §14).
- *Not in v1:* changing `private` after the share; turning sharing off; `folder-sync history`, `restore` and `deleted` for a
  shared path from the command line (the Files page's Restore does it, by the object); keyframes in the shared tree; a bucket-key
  folder (§15 names the way in).

## Sources

Web sources accessed 2026-11-04.

1. Obsidian Help, Troubleshoot Sync: diff-match-patch for Markdown; last modified wins for other files; JSON settings
   merged with local keys on top; "Create conflict file" since 1.9.7, named
   `original-note-name (Conflicted copy device-name YYYYMMDDHHMM).md`; "The original file keeps the remote version";
   the warning about duplicate text — https://obsidian.md/help/sync/troubleshoot
2. Obsidian Help, Version history — https://obsidian.md/help/sync/version-history
3. git-push: only fast-forward updates by default; `--force-with-lease`, which updates "only if the 'lease' is still
   valid" — https://git-scm.com/docs/git-push
4. git-merge-file: "A conflict occurs if both <current> and <other> have changes in a common segment of lines" —
   https://git-scm.com/docs/git-merge-file
5. Dropbox Help, conflicted copies: "The last version saved will always appear as the conflicted copy" —
   https://help.dropbox.com/organize/conflicted-copy
6. Syncthing docs, Syncing, "Conflicting Changes": `<filename>.sync-conflict-<date>-<time>-<modifiedBy>.<ext>`; the
   older file is renamed; conflict copies propagate like normal files — https://docs.syncthing.net/users/syncing.html
7. Automerge, "a library of data structures for building collaborative applications" —
   https://automerge.org/docs/hello/
8. Automerge, Storage: binary chunks and compaction into snapshots —
   https://automerge.org/docs/reference/under-the-hood/storage/
9. Yjs, Document Updates: "document updates are represented as Uint8Arrays" —
   https://docs.yjs.dev/api/document-updates
10. This repository: PEP 0003 §3.4 (the web host, its one-at-a-time queue, and its WHY against a second layout);
    `accounts/src/{webhost,webhost-do}.ts`
11. This repository: PEP 0008 §6 (2 false conflict copies in 40 save storms; rclone bisync lost the final save in 3
    of 10 storms; web to machine tuned at 286 ms p50) and its harness `bench/fast/`
12. Cloudflare R2, S3 API compatibility: PutObject conditionals "are evaluated atomically against the committed bucket
    state" — https://developers.cloudflare.com/r2/api/s3/api/
13. Cloudflare Workers, Limits: 128 MB per isolate; request bodies of 100 MB on Free and Pro; 30 s of CPU by default,
    up to 5 min — https://developers.cloudflare.com/workers/platform/limits/
14. node-diff3 (MIT): `diff3Merge(a, o, b)`, `merge`, `mergeDiff3`; splits on whitespace by default —
    https://github.com/bhousel/node-diff3
15. `github.com/epiclabs-io/diff3` (MIT, a Go port of node-diff3; `Merge(a, o, b io.Reader, …)`) —
    https://pkg.go.dev/github.com/epiclabs-io/diff3 ; `github.com/sergi/go-diff` (MIT, diff-match-patch for Go, no
    three-way merge) — https://pkg.go.dev/github.com/sergi/go-diff/diffmatchpatch
16. Vault: `PROJECT - Folder Sync` (the `ai-singlewriter-nov4` callout: criteria, options A–E, recommendation C),
    `C - Single Writer Principle`, `C - Semantic Merge Conflict (Clean Merge, Wrong Result)`,
    `C - Local First Software`, `C - Event Sourcing`
17. google/diff-match-patch: Apache-2.0, "archived by the owner on Aug 5, 2024" —
    https://github.com/google/diff-match-patch
18. Vault: `folder-sync — Trash, Version History and Storage Efficiency (2026-10-29)` (the event log copied whole 291
    times on Oct 28); PEP 0009
19. This repository: `internal/syncer/round.go` (`pullPeer`, `unchangedSince`, `keepLocalEdit`)
