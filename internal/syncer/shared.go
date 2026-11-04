package syncer

// The shared tree on a machine (docs/peps/0010). A folder that was shared with `folder-sync share` has one tree that every
// device, agent and page edits: the files of the folder itself, except the ones the folder's private rule keeps on each
// machine's own host. A machine never writes the shared tree in the bucket. Each round it
//
//  1. commits what changed on disk to the accounts server, with the version each change was made from (its base); the
//     folder's Durable Object, the tree's one writer, accepts it, merges it, or keeps it as a conflict copy;
//  2. pulls the tree's manifest like a peer's and brings the files it lists to the folder, never over a file that
//     differs from what the machine last knew (its base).
//
// WHY a base from hashes this machine took itself (PEP 0010 §5, §9): the base is the sha256 of bytes this machine wrote (a
// pull) or sent (a commit), never what a manifest claims. PEP 0008's save-storm race was a pull recorded as "what I pulled"
// when the bytes fetched were a newer upload; a base set only after hashing the bytes cannot be wrong that way.
//
// State is local, not contract: <state dir>/shared.json.

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"folder-sync/internal/history"
	"folder-sync/internal/ignore"
	"folder-sync/internal/manifest"
	"folder-sync/internal/names"
	"folder-sync/internal/s3"
	"folder-sync/internal/synclog"
)

// The limits of one commit (docs/API.md "The shared tree"). WHY a file over sharedFileMax stays on this machine's own host:
// the folder's object holds a file in memory to hash, merge and write it (128 MB per isolate), so the shared tree takes
// files up to 64 MiB in v1; a bigger one is published as a host-only file, as before sharing.
const (
	sharedInlineMax  = 1 << 20
	sharedRequestMax = 6 << 20
	sharedChangesMax = 100
	sharedFileMax    = 64 << 20
)

// heldFile is what this machine knows of one shared path: the bytes its file last held in step with the tree.
type heldFile struct {
	// Version is the shared version those bytes were at ("" when the machine has no base: both sides added the path).
	Version string `json:"version,omitempty"`
	SHA256  string `json:"sha256,omitempty"`
	Size    int64  `json:"size"`
	// MTime is the file's modification time when its bytes were hashed: size and mtime unchanged means unchanged.
	MTime string `json:"mtime,omitempty"`
	// Also are other contents the file may hold and be replaced without loss: the bytes this machine sent that the tree
	// kept elsewhere (merged into the file, or in a conflict copy), so the pull may write the tree's version over them.
	Also []string `json:"also,omitempty"`
}

// sharedState is projects/<key>/shared.json.
type sharedState struct {
	// Host is the shared tree's host id ("" while the folder is not shared).
	Host    string              `json:"host,omitempty"`
	Private []string            `json:"private"`
	Held    map[string]heldFile `json:"held"`
}

// SharedChange is one path of a commit (docs/API.md "The shared tree"). Base is null for a path this machine never knew.
type SharedChange struct {
	Path    string      `json:"path"`
	Base    *SharedBase `json:"base"`
	SHA256  string      `json:"sha256,omitempty"`
	Size    int64       `json:"size,omitempty"`
	Body    string      `json:"body,omitempty"` // base64, up to 1 MiB
	Staged  string      `json:"staged,omitempty"`
	Delete  bool        `json:"delete,omitempty"`
	AtLocal string      `json:"at_local,omitempty"`
}

// SharedBase is the version a change was made from.
type SharedBase struct {
	Version string `json:"version"`
	SHA256  string `json:"sha256,omitempty"`
}

// SharedRequest is a commit.
type SharedRequest struct {
	Device    string         `json:"device"`
	Host      string         `json:"host"`
	MaxDelete int            `json:"max_delete"`
	Changes   []SharedChange `json:"changes"`
}

// SharedResult is the folder's object's answer for one path: accepted, merged, conflict or edit_won.
type SharedResult struct {
	Path            string `json:"path"`
	Outcome         string `json:"outcome"`
	Version         string `json:"version,omitempty"`
	SHA256          string `json:"sha256,omitempty"`
	Size            int64  `json:"size"`
	Merge           string `json:"merge,omitempty"`
	KeptAs          string `json:"kept_as,omitempty"`
	Why             string `json:"why,omitempty"`
	ConflictPath    string `json:"conflict_path,omitempty"`
	ConflictVersion string `json:"conflict_version,omitempty"`
}

// SharedAnswer is the answer to a commit.
type SharedAnswer struct {
	Host    string         `json:"host"`
	Seq     int64          `json:"seq"`
	Changed bool           `json:"changed"`
	Results []SharedResult `json:"results"`
}

// SharedUnavailableError: the folder is shared but this machine cannot commit to it (it is not signed in to the accounts
// server, or a commit was refused); the round still pulls, and reports this.
type SharedUnavailableError struct{ Err error }

func (e *SharedUnavailableError) Error() string {
	return "this folder is shared: its changes go through the accounts server, which refused or did not answer: " + e.Err.Error()
}

func (e *SharedUnavailableError) Unwrap() error { return e.Err }

// ---------------------------------------------------------------------------------------------------- state

func (p *Project) sharedPath() string { return p.statePath("shared.json") }

// sharedStateRef loads shared.json once per round (the round's pull and push share it) and returns the live copy.
func (p *Project) sharedStateRef() *sharedState {
	if p.shared != nil {
		return p.shared
	}
	st := &sharedState{Private: []string{}, Held: map[string]heldFile{}}
	if data, err := os.ReadFile(p.sharedPath()); err == nil {
		json.Unmarshal(data, st)
	}
	if st.Held == nil {
		st.Held = map[string]heldFile{}
	}
	if st.Private == nil {
		st.Private = []string{}
	}
	p.shared = st
	return st
}

// saveShared writes shared.json when something changed.
func (p *Project) saveShared() error {
	if p.shared == nil || !p.sharedDirty {
		return nil
	}
	p.sharedDirty = false
	return writeJSON(p.sharedPath(), p.shared)
}

// SharedHost is the shared tree's host id, "" while the folder is not shared.
func (p *Project) SharedHost() string { return p.sharedStateRef().Host }

// AdoptShared records that this folder is shared (what `folder-sync share` and a discovered shared host both do).
func (p *Project) AdoptShared(host string, private []string) error {
	st := p.sharedStateRef()
	if st.Host != "" && st.Host != host {
		return fmt.Errorf("this folder already follows shared tree %s; the accounts server says %s", st.Host, host)
	}
	if private == nil {
		private = []string{}
	}
	if st.Host == host && strings.Join(st.Private, "\n") == strings.Join(private, "\n") {
		return nil
	}
	st.Host, st.Private = host, private
	p.sharedDirty = true
	return p.saveShared()
}

// noteShared looks at a host this machine just met: when its manifest is a shared tree's, the folder is shared. One GET,
// only for a host met for the first time (Discover).
func (p *Project) noteShared(id string) {
	got, err := p.S3.GetIfNoneMatch(p.Config.Bucket, p.HostPrefix(id)+"/"+manifest.FileName, "")
	if err != nil || got.NotFound || got.NotModified {
		return
	}
	m, err := manifest.Parse(got.Body)
	if err != nil || m.HostID != id || m.Shared == nil {
		return
	}
	if err := p.AdoptShared(id, m.Shared.Private); err != nil {
		p.say("%v", err)
		return
	}
	p.say("shared folder: %s is the shared tree (private: %s)", id, privateLabel(m.Shared.Private))
}

func privateLabel(private []string) string {
	if len(private) == 0 {
		return "nothing"
	}
	return strings.Join(private, ", ")
}

// versionOf is the version id of a manifest entry.
func versionOf(e manifest.Entry) string {
	id, err := history.VersionID(e.WrittenAt, e.SHA256)
	if err != nil {
		return ""
	}
	return id
}

func hasHash(h heldFile, sum string) bool {
	if sum == "" {
		return false
	}
	if h.SHA256 == sum {
		return true
	}
	for _, also := range h.Also {
		if also == sum {
			return true
		}
	}
	return false
}

// privatePaths are the paths among paths that the folder's private rule keeps on this machine's own host: one more
// local listing, filtered by the same rclone that applies the ignore rules.
func (p *Project) privatePaths(ctx context.Context, paths []string) (map[string]bool, error) {
	st := p.sharedStateRef()
	out := map[string]bool{}
	if len(st.Private) == 0 || len(paths) == 0 {
		return out, nil
	}
	body, err := ignore.CompileOnly(st.Private)
	if err != nil {
		return nil, fmt.Errorf("the shared tree's private rule: %w", err)
	}
	filters := p.statePath("filters-private.txt")
	if err := os.MkdirAll(p.StateDir, 0o700); err != nil {
		return nil, err
	}
	if err := os.WriteFile(filters, []byte(body), 0o600); err != nil {
		return nil, err
	}
	matched, err := p.Scan(ctx, filters)
	if err != nil {
		return nil, err
	}
	for _, f := range matched {
		out[f.Path] = true
	}
	return out, nil
}

// ---------------------------------------------------------------------------------------------------- push

// sharedFile is one file that went into a commit: the bytes' hash and where they were read (for the Held record).
type sharedFile struct {
	path  string
	sha   string
	size  int64
	mtime string
}

// pushShared commits what changed on disk to the shared tree. Called before the machine's own push in a shared folder.
// The files that leave this machine's own host (the migration) leave only after the tree holds them: Held says so.
func (p *Project) pushShared(ctx context.Context, result *Result) error {
	st := p.sharedStateRef()
	if st.Host == "" {
		return nil
	}
	if p.SharedCommit == nil {
		return &SharedUnavailableError{Err: errors.New("this machine is not signed in (folder-sync login)")}
	}
	filters, err := p.Filters()
	if err != nil {
		return err
	}
	local, err := p.Scan(ctx, filters)
	if err != nil {
		return err
	}
	byPath := make(map[string]LocalFile, len(local))
	paths := make([]string, 0, len(local))
	for _, f := range local {
		byPath[f.Path] = f
		paths = append(paths, f.Path)
	}
	okPaths, _ := names.Lint(paths, reservedPaths()) // the skips are reported by the machine's own push, once
	if len(okPaths) == 0 {
		if len(st.Held) > 0 {
			result.Events = append(result.Events, p.holdEvent("unmounted", len(st.Held)))
			return &EmptyFolderError{Folder: p.Folder, Had: len(st.Held)}
		}
		return nil
	}
	private, err := p.privatePaths(ctx, okPaths)
	if err != nil {
		return err
	}
	var shared []string
	present := map[string]bool{}
	for _, path := range okPaths {
		if private[path] || byPath[path].Size > sharedFileMax {
			continue
		}
		shared = append(shared, path)
		present[path] = true
	}
	var changes []SharedChange
	sent := map[string]sharedFile{}
	for _, path := range shared {
		f := byPath[path]
		held, known := st.Held[path]
		mtime := manifest.FormatTime(f.MTime)
		if known && held.Size == f.Size && sameTime(held.MTime, mtime) {
			continue
		}
		hash, err := HashFile(filepath.Join(p.Folder, filepath.FromSlash(path)))
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue // gone since the listing: the next round sees it
			}
			return err
		}
		if known && hasHash(held, hash) {
			// same content, new mtime: remember the mtime; nothing to send
			if held.SHA256 == hash {
				held.MTime, held.Size = mtime, f.Size
				st.Held[path] = held
				p.sharedDirty = true
			}
			continue
		}
		change := SharedChange{Path: path, SHA256: hash, Size: f.Size, AtLocal: p.Now().Format(time.RFC3339)}
		if known && held.Version != "" {
			change.Base = &SharedBase{Version: held.Version, SHA256: held.SHA256}
		}
		changes = append(changes, change)
		sent[path] = sharedFile{path: path, sha: hash, size: f.Size, mtime: mtime}
	}
	// deletes: a path this machine holds that is no longer on its disk
	var deletes []SharedChange
	heldPaths := make([]string, 0, len(st.Held))
	for path := range st.Held {
		heldPaths = append(heldPaths, path)
	}
	sort.Strings(heldPaths)
	for _, path := range heldPaths {
		if present[path] {
			continue
		}
		// WHY only what is not on the disk at all: a file the ignore rules, the name lint or the private rule left out of
		// the listing is still there, and unlisting it must not delete it for every device
		if _, err := os.Lstat(filepath.Join(p.Folder, filepath.FromSlash(path))); err == nil {
			continue
		}
		held := st.Held[path]
		change := SharedChange{Path: path, Delete: true}
		if held.Version != "" {
			change.Base = &SharedBase{Version: held.Version, SHA256: held.SHA256}
		}
		deletes = append(deletes, change)
	}
	if len(deletes) > p.Config.MaxDelete {
		p.say("holding %d deletes: more than max_delete = %d in one round; they stay in the shared tree until you raise max_delete or restore the files", len(deletes), p.Config.MaxDelete)
		for _, c := range deletes {
			result.HeldDeletes = append(result.HeldDeletes, c.Path)
		}
		result.Events = append(result.Events, p.holdEvent("max_delete", len(deletes)))
		deletes = nil
	}
	if p.Creds.ReadOnly && len(changes) > 0 {
		// over quota: the folder's object refuses bytes that add to the account, so they wait; deletes still go
		for _, c := range changes {
			result.HeldUploads = append(result.HeldUploads, c.Path)
		}
		result.Events = append(result.Events, p.holdEvent("over_quota", len(changes)))
		changes = nil
	}
	changes = append(changes, deletes...)
	if len(changes) == 0 {
		return nil
	}
	sort.SliceStable(changes, func(i, j int) bool { return changes[i].Path < changes[j].Path })
	for start := 0; start < len(changes); {
		batch, err := p.loadBatch(changes[start:min(start+sharedChangesMax, len(changes))])
		start += sharedChangesMax
		if err != nil {
			return err
		}
		if len(batch) == 0 {
			continue
		}
		answer, err := p.SharedCommit(ctx, SharedRequest{Device: p.Host.Name, Host: p.Host.ID, MaxDelete: p.Config.MaxDelete, Changes: batch})
		if err != nil {
			p.saveShared()
			return &SharedUnavailableError{Err: err}
		}
		p.applyCommit(answer, sent, result)
	}
	return p.saveShared()
}

// loadBatch reads the bytes of one request's writes: inline up to sharedInlineMax each and sharedRequestMax together, a
// bigger one staged in _incoming/ with this machine's own key. WHY read again here and not in the scan: a round holds no
// more than one request of bytes. A file that no longer hashes to what the scan found changed since: it is left for the next
// round, so the bytes sent are always the bytes hashed.
func (p *Project) loadBatch(batch []SharedChange) ([]SharedChange, error) {
	var out []SharedChange
	inline := 0
	for _, c := range batch {
		if c.Delete {
			out = append(out, c)
			continue
		}
		data, err := os.ReadFile(filepath.Join(p.Folder, filepath.FromSlash(c.Path)))
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, err
		}
		if sum := sha256.Sum256(data); hex.EncodeToString(sum[:]) != c.SHA256 {
			continue
		}
		if len(data) <= sharedInlineMax && inline+len(data) <= sharedRequestMax {
			c.Body = base64.StdEncoding.EncodeToString(data)
			inline += len(data)
		} else {
			id := newJobID()
			if _, err := p.S3.PutFile(p.Config.Bucket, p.Root+"_incoming/"+p.Config.Project+"/"+p.Host.ID+"/"+id, data, time.Time{}); err != nil {
				return nil, fmt.Errorf("staging %s for the shared tree: %w", c.Path, err)
			}
			c.Staged = id
		}
		out = append(out, c)
	}
	return out, nil
}

// applyCommit records the folder's object's answer for each path: the bases move only for what the tree took.
func (p *Project) applyCommit(answer SharedAnswer, sent map[string]sharedFile, result *Result) {
	st := p.sharedStateRef()
	now := p.Now()
	for _, r := range answer.Results {
		file, wrote := sent[r.Path]
		held, known := st.Held[r.Path]
		switch r.Outcome {
		case "accepted":
			if !wrote {
				// a delete the tree took, or bytes it already held
				if _, existed := st.Held[r.Path]; existed && r.Version == "" {
					delete(st.Held, r.Path)
					ev := p.fileEvent("delete", now)
					ev.Path, ev.Seq = r.Path, answer.Seq
					result.Events = append(result.Events, ev)
					result.Deleted = append(result.Deleted, r.Path)
				}
				continue
			}
			st.Held[r.Path] = heldFile{Version: r.Version, SHA256: file.sha, Size: file.size, MTime: file.mtime}
			ev := p.fileEvent("upload", now)
			ev.Path, ev.Size, ev.SHA256, ev.Seq, ev.Op = r.Path, int64p(file.size), file.sha, answer.Seq, "add"
			if known {
				ev.Op = "edit"
			}
			if f, ok := p.sharedLocalMTime(r.Path); ok {
				ev.UpMs = p.upMs(f, now)
			}
			result.Events = append(result.Events, ev)
			result.Uploaded = append(result.Uploaded, r.Path)
		case "merged", "conflict":
			if !wrote {
				continue
			}
			// the tree kept this machine's bytes elsewhere (merged into the file, or in a conflict copy): the file may now
			// be replaced by the tree's version, and the base stays what the edit was made from
			held.Also = append(held.Also, file.sha)
			if !known {
				held.Size = file.size
			}
			st.Held[r.Path] = held
			result.Uploaded = append(result.Uploaded, r.Path)
			if r.Outcome == "conflict" {
				c := Conflict{Peer: answer.Host, Path: r.Path, KeptAt: r.ConflictPath, FoundAt: manifest.FormatTime(now)}
				result.Conflicts = append(result.Conflicts, c)
				ev := p.fileEvent("conflict", now)
				ev.Level, ev.Peer, ev.PeerName, ev.Path, ev.KeptAt = "warn", answer.Host, "shared", r.Path, r.ConflictPath
				result.Events = append(result.Events, ev)
				p.say("conflict: %s changed here and in the shared tree; your version is kept as %s", r.Path, r.ConflictPath)
			} else {
				p.say("merged: %s changed here and in the shared tree; both edits are in the file", r.Path)
			}
		case "edit_won":
			// our delete was not applied: another device changed the file. The pull brings it back.
			p.say("%s was changed elsewhere, so deleting it here was undone", r.Path)
		}
	}
	p.sharedDirty = true
}

// sharedLocalMTime is a shared file's modification time on disk now.
func (p *Project) sharedLocalMTime(path string) (time.Time, bool) {
	info, err := os.Stat(filepath.Join(p.Folder, filepath.FromSlash(path)))
	if err != nil {
		return time.Time{}, false
	}
	return info.ModTime(), true
}

// ---------------------------------------------------------------------------------------------------- pull

// errMoved: the tree's file changed again between its manifest and this fetch; the next manifest has it.
var errMoved = errors.New("the shared tree changed while it was fetched")

// pullShared applies the shared tree's manifest to the folder (called by pullPeer for the host whose manifest is shared).
func (p *Project) pullShared(ctx context.Context, id string, m manifest.Manifest, etag string, cached manifest.Manifest, peers *PeerState, result *Result) (PeerResult, error) {
	st := p.sharedStateRef()
	if st.Host == "" {
		if err := p.AdoptShared(id, m.Shared.Private); err != nil {
			return PeerResult{}, err
		}
	}
	pr := PeerResult{ID: id, Name: m.HostName, Files: len(m.Files), Seq: m.Seq}
	online, _ := time.Parse(time.RFC3339Nano, m.GeneratedAt)
	pulled := func(name, path string, size *int64) synclog.Event {
		at := p.Now()
		ev := p.fileEvent(name, at)
		ev.Peer, ev.PeerName, ev.PeerSeq, ev.Path, ev.Size = id, m.HostName, m.Seq, path, size
		if !online.IsZero() {
			ev.DownMs = int64p(at.Sub(online).Milliseconds())
		}
		return ev
	}
	listed := map[string]manifest.Entry{}
	consistent, deferred := true, false
	for _, e := range m.Files {
		if runtime.GOOS == "windows" {
			if err := names.CheckWindows(e.Path); err != nil {
				result.Skipped = append(result.Skipped, names.Skipped{Path: e.Path, Reason: "the shared tree: " + err.Error()})
				pr.Skipped++
				continue
			}
		}
		listed[e.Path] = e
		version := versionOf(e)
		held, known := st.Held[e.Path]
		local := filepath.Join(p.Folder, filepath.FromSlash(e.Path))
		info, statErr := os.Lstat(local)
		if statErr != nil {
			if known && held.Version == version {
				continue // deleted here since: the next push says so
			}
			// new in the tree, or changed there while it was deleted here: an edit beats a delete
		} else {
			if known && held.Version == version && info.Size() == held.Size && sameTime(held.MTime, manifest.FormatTime(info.ModTime())) {
				continue
			}
			sum, err := HashFile(local)
			if err != nil {
				return pr, err
			}
			switch {
			case sum == e.SHA256:
				p.applyMTime(local, e.MTime)
				st.Held[e.Path] = heldFile{Version: version, SHA256: e.SHA256, Size: e.Size, MTime: e.MTime}
				p.sharedDirty = true
				continue
			case known && hasHash(held, sum):
				// the file still holds what this machine last knew: safe to replace
			default:
				// edited here since (or never known): never overwritten. The next push commits it against the base it
				// was made from, and the tree merges it.
				deferred = true
				continue
			}
		}
		switch err := p.fetchShared(id, e, local, st.Held[e.Path]); {
		case err == nil:
			st.Held[e.Path] = heldFile{Version: version, SHA256: e.SHA256, Size: e.Size, MTime: e.MTime}
			p.sharedDirty = true
			pr.Fetched++
			result.Events = append(result.Events, pulled("download", e.Path, int64p(e.Size)))
		case errors.Is(err, errMoved):
			consistent = false
		case errors.Is(err, errEditedWhileFetched):
			deferred = true
		default:
			return pr, fmt.Errorf("%s: %w", e.Path, err)
		}
	}
	// paths this machine holds that the tree no longer lists
	gone := make([]string, 0)
	for path := range st.Held {
		if _, still := listed[path]; !still {
			gone = append(gone, path)
		}
	}
	sort.Strings(gone)
	for _, path := range gone {
		held := st.Held[path]
		local := filepath.Join(p.Folder, filepath.FromSlash(path))
		info, err := os.Lstat(local)
		if err != nil {
			delete(st.Held, path) // gone on both sides
			p.sharedDirty = true
			continue
		}
		if info.IsDir() {
			continue
		}
		sum, err := HashFile(local)
		if err != nil {
			return pr, err
		}
		if !hasHash(held, sum) {
			// WHY kept: an edit here beats the delete there (PEP 0010 §6.3); the next push writes it back with its base
			deferred = true
			continue
		}
		if err := os.Remove(local); err != nil {
			return pr, err
		}
		removeEmptyParents(filepath.Dir(local), p.Folder)
		delete(st.Held, path)
		p.sharedDirty = true
		pr.Removed++
		result.Events = append(result.Events, pulled("remove_copy", path, nil))
	}
	if err := manifest.Save(p.peerManifestPath(id), m); err != nil {
		return pr, err
	}
	if consistent && !deferred {
		peers.ETags[id] = etag
	} else {
		delete(peers.ETags, id)
		p.behind = true
	}
	return pr, p.saveShared()
}

var errEditedWhileFetched = errors.New("the file was edited here while the tree's version was fetched")

// fetchShared brings one version of a shared file to local: a native GET carrying If-Match on the object's ETag when the
// manifest names it, into a temporary file beside its target; checked against the manifest's sha256; the local file checked
// once more; then renamed over it (PEP 0010 §5.4). held says what the file may hold and still be replaced.
func (p *Project) fetchShared(id string, e manifest.Entry, local string, held heldFile) error {
	dir := filepath.Dir(local)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp := filepath.Join(dir, restoreTempPrefix+newJobID()[:8])
	defer os.Remove(tmp)
	key := p.HostPrefix(id) + "/" + e.Path
	var err error
	switch {
	case e.Size == 0:
		err = os.WriteFile(tmp, nil, 0o644)
	case e.ObjectETag != "":
		err = p.S3.GetRangeToFile(p.Config.Bucket, key, tmp, 0, e.Size-1, e.ObjectETag)
	default:
		err = p.S3.GetToFile(p.Config.Bucket, key, tmp)
	}
	if errors.Is(err, s3.ErrPreconditionFailed) || errors.Is(err, s3.ErrNotFound) {
		return errMoved
	}
	if err != nil {
		return err
	}
	sum, err := HashFile(tmp)
	if err != nil {
		return err
	}
	if sum != e.SHA256 {
		return errMoved // the object was overwritten after this manifest: take the next one
	}
	// the local file once more, as late as possible: an edit made while the fetch ran is not overwritten
	if _, statErr := os.Lstat(local); statErr == nil {
		now, err := HashFile(local)
		if err != nil {
			return err
		}
		if now != e.SHA256 && !hasHash(held, now) {
			return errEditedWhileFetched
		}
		if info, err := os.Stat(local); err == nil {
			os.Chmod(tmp, info.Mode().Perm())
		}
	}
	if err := os.Rename(tmp, local); err != nil {
		return err
	}
	p.applyMTime(local, e.MTime)
	return nil
}

// ---------------------------------------------------------------------------------------------------- the machine's own host

// splitShared tells Push which of a machine's paths the shared tree owns (PEP 0010 §7): the files that are not private
// leave this machine's own host once the tree holds them. okPaths are every file the listing found; the result is the
// paths this host publishes (private ones), and the set of shared paths.
func (p *Project) splitShared(ctx context.Context, okPaths []string, byPath map[string]LocalFile) (own []string, shared map[string]bool, err error) {
	st := p.sharedStateRef()
	if st.Host == "" {
		return okPaths, nil, nil
	}
	private, err := p.privatePaths(ctx, okPaths)
	if err != nil {
		return nil, nil, err
	}
	shared = map[string]bool{}
	for _, path := range okPaths {
		if private[path] || byPath[path].Size > sharedFileMax {
			own = append(own, path)
			continue
		}
		shared[path] = true
	}
	return own, shared, nil
}
