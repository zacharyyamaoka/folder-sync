package syncer

// Version history in a round (docs/peps/0007 §3; docs/CONTRACT.md "Deletions and history"): before a push overwrites
// or deletes an object, the version that leaves is copied to _history/ with a server-side copy conditioned on it
// being the version the manifest lists; each published manifest gets a change record, and each round that wrote
// peer files a pull record; restore requests are carried out and answered; and once a day the engine prunes its own
// host's history to the schedule. WHY native S3 calls and not rclone's --backup-dir: --backup-dir can only append to
// a name, so it cannot put a version under its path, and it has no conditional copy.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"folder-sync/internal/history"
	"folder-sync/internal/manifest"
	"folder-sync/internal/names"
	"folder-sync/internal/rclone"
	"folder-sync/internal/s3"
	"folder-sync/internal/synclog"
)

const (
	// copyWorkers is how many history copies (and deletes) run at once. WHY in parallel: a round's copies come
	// before its upload, and one at a time they would add a round trip per changed file to the time until it is
	// online; eight at once cost one or two.
	copyWorkers = 8
	// maxCopyBytes is the largest object a single CopyObject copies (5 GiB); a larger one goes through rclone
	// copyto, which does the multipart server-side copy.
	maxCopyBytes = 5 << 30
	// PruneEvery is how often the engine prunes its own host's history (with an hourly reconcile, so it adds its
	// listings to a round that already lists).
	PruneEvery = 24 * time.Hour
	// keptFor is how long history.json remembers a path's last kept version: the burst rule reads 30 s of it, and
	// a round whose manifest PUT failed reads it again in the next round to skip a second copy.
	keptFor = time.Hour
)

// keptState is history.json: the last version this writer kept of each path, and when. WHY local: this machine is
// the only writer of its host's history, so it knows the burst rule's answer without a listing.
type keptState struct {
	Paths map[string]keptPath `json:"paths"`
}

type keptPath struct {
	At      string `json:"at"`      // when it left, RFC 3339
	Version string `json:"version"` // its id under _history/
}

func (p *Project) loadKept() keptState {
	state := keptState{Paths: map[string]keptPath{}}
	if data, err := os.ReadFile(p.statePath("history.json")); err == nil {
		_ = json.Unmarshal(data, &state)
	}
	if state.Paths == nil {
		state.Paths = map[string]keptPath{}
	}
	return state
}

func (p *Project) saveKept(state keptState, now time.Time) error {
	for path, kept := range state.Paths {
		if at, err := time.Parse(time.RFC3339Nano, kept.At); err != nil || now.Sub(at) > keptFor {
			delete(state.Paths, path)
		}
	}
	return writeJSON(p.statePath("history.json"), state)
}

// noHistory compiles the folder's no_history rules.
func (p *Project) noHistory() (*history.Matcher, error) {
	return history.NewMatcher(p.Config.NoHistory)
}

// leaving is one version a push replaces or deletes, and where it went.
type leaving struct {
	Path string
	Op   string // history.OpReplace | OpDelete | OpRestore
	Old  manifest.Entry
	Kept string // its version id under _history/; "" when not kept
	Why  string // why not kept
	Err  error  // the copy failed: the path is held this round
}

// keepLeaving applies the write-time rule to each leaving version and copies the ones it keeps, eight at once.
func (p *Project) keepLeaving(ctx context.Context, items []*leaving, now time.Time) error {
	if len(items) == 0 {
		return nil
	}
	matcher, err := p.noHistory()
	if err != nil {
		return err
	}
	state := p.loadKept()
	var copies []*leaving
	for _, it := range items {
		written, err := time.Parse(time.RFC3339Nano, it.Old.WrittenAt)
		if err != nil {
			it.Err = fmt.Errorf("%s: its manifest entry's written_at %q: %w", it.Path, it.Old.WrittenAt, err)
			continue
		}
		var lastKept time.Time
		last, seen := state.Paths[it.Path]
		if seen {
			lastKept, _ = time.Parse(time.RFC3339Nano, last.At)
		}
		keep, why := history.Keep(it.Op, it.Path, written, now, lastKept, matcher)
		if !keep {
			it.Why = why
			continue
		}
		if id, err := history.VersionID(it.Old.WrittenAt, it.Old.SHA256); err == nil && seen && last.Version == id {
			it.Kept = id // kept by a round whose manifest never landed: copying again could overwrite it with the new bytes
			continue
		}
		copies = append(copies, it)
	}
	parallel(len(copies), func(i int) { copies[i].Err = p.keepVersion(ctx, copies[i]) })
	for _, it := range copies {
		if it.Err == nil && it.Kept != "" {
			state.Paths[it.Path] = keptPath{At: manifest.FormatTime(now), Version: it.Kept}
		}
	}
	return p.saveKept(state, now)
}

// keepVersion copies one leaving version to _history/. The copy is conditioned on the live object being the version
// the manifest lists (its object_etag); a 412 means it is not, and whatever is there is kept as <LastModified>_unlisted
// instead, so nothing is lost and nothing is mislabelled. A source that is gone asks the next round to reconcile.
func (p *Project) keepVersion(ctx context.Context, it *leaving) error {
	id, err := history.VersionID(it.Old.WrittenAt, it.Old.SHA256)
	if err != nil {
		return err
	}
	key := history.Key(p.Root, p.Config.Project, p.Host.ID, it.Path, id)
	if len(key) > history.MaxKeyBytes {
		it.Why = history.WhyKeyTooLong
		return nil
	}
	src := p.HostPrefix(p.Host.ID) + "/" + it.Path
	if it.Old.Size > maxCopyBytes {
		if _, err := p.Rclone.Run(ctx, "copyto", rclone.Path(p.Config.Bucket, src), rclone.Path(p.Config.Bucket, key)); err != nil {
			return err
		}
		it.Kept = id
		return nil
	}
	err = p.S3.Copy(p.Config.Bucket, src, key, it.Old.ObjectETag)
	switch {
	case err == nil:
		it.Kept = id
		return nil
	case errors.Is(err, s3.ErrPreconditionFailed):
		stat, err := p.S3.HeadObject(p.Config.Bucket, src)
		if err != nil {
			return err
		}
		unlisted := history.UnlistedID(stat.LastModified)
		if err := p.S3.Copy(p.Config.Bucket, src, history.Key(p.Root, p.Config.Project, p.Host.ID, it.Path, unlisted), ""); err != nil {
			return err
		}
		p.say("history: %s in the bucket was not the version the manifest listed; kept as %s", it.Path, unlisted)
		it.Kept = unlisted
		return nil
	case errors.Is(err, s3.ErrNotFound):
		p.requestReconcile()
		return fmt.Errorf("%s is missing from the bucket (the next round reconciles): %w", it.Path, err)
	}
	return err
}

// CopyError is a push that held some uploads or deletes because the copy of their old version to history failed:
// nothing the schedule keeps is overwritten without a copy. The round still pulls, and reports this.
type CopyError struct {
	Held int
	Err  error
}

func (e *CopyError) Error() string {
	return fmt.Sprintf("%d change(s) held this round: keeping the old version in history failed (%v); they go next round", e.Held, e.Err)
}

func (e *CopyError) Unwrap() error { return e.Err }

// requestReconcile asks the next round for a full reconcile (a history copy found its source gone).
func (p *Project) requestReconcile() { os.WriteFile(p.statePath("reconcile.due"), nil, 0o600) }

func (p *Project) reconcileRequested() bool {
	_, err := os.Stat(p.statePath("reconcile.due"))
	return err == nil
}

// parallel runs fn(0..n-1), copyWorkers at once.
func parallel(n int, fn func(i int)) {
	var wg sync.WaitGroup
	work := make(chan int)
	for w := 0; w < copyWorkers && w < n; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range work {
				fn(i)
			}
		}()
	}
	for i := 0; i < n; i++ {
		work <- i
	}
	close(work)
	wg.Wait()
}

// deleteObjects deletes this host's live objects for paths, eight at once.
func (p *Project) deleteObjects(paths []string) error {
	errs := make([]error, len(paths))
	parallel(len(paths), func(i int) { errs[i] = p.S3.Delete(p.Config.Bucket, p.HostPrefix(p.Host.ID)+"/"+paths[i]) })
	return errors.Join(errs...)
}

// Events.

func int64p(n int64) *int64 { return &n }

func strp(s string) *string { return &s }

// fileEvent is a file event of this host, with the fields a change or pull record needs.
func (p *Project) fileEvent(name string, at time.Time) synclog.Event {
	return synclog.Event{Schema: synclog.Schema, Event: name, At: manifest.FormatTime(at), Level: "info",
		Project: p.Config.Project, Host: p.Host.ID, HostName: p.Host.Name}
}

func wasOf(it *leaving) *synclog.Was {
	was := &synclog.Was{SHA256: it.Old.SHA256, Size: it.Old.Size, WrittenAt: it.Old.WrittenAt}
	if it.Kept != "" {
		was.Kept = strp(it.Kept)
	} else {
		was.Why = it.Why
	}
	return was
}

// upMs is disk to online for a file changed on this disk at mtime and published by the manifest generated at
// published (CONTRACT "Sync times"): absent when the mtime is not after the previous round's start, since the change
// may then be older than its mtime says nothing about.
func (p *Project) upMs(mtime, published time.Time) *int64 {
	if p.prevRoundStart.IsZero() || !mtime.After(p.prevRoundStart) || mtime.After(published) {
		return nil
	}
	return int64p(published.Sub(mtime).Milliseconds())
}

// restoreMark is a path a restore wrote back this round: its push publishes a restore event, not an upload.
type restoreMark struct {
	From    string
	Request string
}

// pushEvents are the upload, delete and restore events of one published manifest, in path order.
func (p *Project) pushEvents(m manifest.Manifest, items []*leaving, uploaded, deleted []string, local map[string]LocalFile,
	uploadedAt, deletedAt, published time.Time) []synclog.Event {
	byPath := map[string]*leaving{}
	for _, it := range items {
		byPath[it.Path] = it
	}
	entries := map[string]manifest.Entry{}
	for _, e := range m.Files {
		entries[e.Path] = e
	}
	var events []synclog.Event
	for _, path := range uploaded {
		e := entries[path]
		var ev synclog.Event
		if mark, restored := p.restoring[path]; restored {
			ev = p.fileEvent("restore", uploadedAt)
			ev.From, ev.Request = mark.From, mark.Request
		} else {
			ev = p.fileEvent("upload", uploadedAt)
			ev.Op = "add"
			ev.UpMs = p.upMs(local[path].MTime, published)
		}
		ev.Path, ev.Size, ev.SHA256, ev.Seq = path, int64p(e.Size), e.SHA256, m.Seq
		if it, ok := byPath[path]; ok {
			ev.Was = wasOf(it)
			if ev.Event == "upload" {
				ev.Op = "edit"
			}
		}
		events = append(events, ev)
	}
	for _, path := range deleted {
		ev := p.fileEvent("delete", deletedAt)
		ev.Path, ev.Seq = path, m.Seq
		if it, ok := byPath[path]; ok {
			ev.Was = wasOf(it)
		}
		events = append(events, ev)
	}
	sort.SliceStable(events, func(i, j int) bool { return events[i].Path < events[j].Path })
	return events
}

// Change and pull records: written to changes.pending/ first, then PUT after the manifest; a PUT that fails stays
// there and goes with the next round, as manifest.pending.json does (docs/peps/0007 §4).

func (p *Project) pendingDir() string { return p.statePath("changes.pending") }

// queueChanges keeps the change record of manifest m, with its events.
func (p *Project) queueChanges(m manifest.Manifest, events []synclog.Event) error {
	if events == nil {
		events = []synclog.Event{}
	}
	record := history.ChangeRecord{Schema: history.ChangesSchema, Project: m.Project, HostID: m.HostID, HostName: m.HostName,
		Seq: m.Seq, At: m.GeneratedAt, By: "machine", Events: events}
	return writeJSON(filepath.Join(p.pendingDir(), fmt.Sprintf("seq-%012d.json", m.Seq)), record)
}

// queuePulls keeps the pull record of a round that wrote or removed peer files.
func (p *Project) queuePulls(events []synclog.Event, at time.Time) error {
	var pulls []synclog.Event
	for _, ev := range events {
		if ev.Event == "download" || ev.Event == "remove_copy" {
			pulls = append(pulls, ev)
		}
	}
	if len(pulls) == 0 {
		return nil
	}
	sort.SliceStable(pulls, func(i, j int) bool {
		if pulls[i].Peer != pulls[j].Peer {
			return pulls[i].Peer < pulls[j].Peer
		}
		return pulls[i].Path < pulls[j].Path
	})
	stamp := history.FormatMs(at)
	record := history.PullRecord{Schema: history.PullsSchema, Project: p.Config.Project, HostID: p.Host.ID, HostName: p.Host.Name,
		At: stamp, Events: pulls}
	return writeJSON(filepath.Join(p.pendingDir(), fmt.Sprintf("pull-%d.json", at.UnixMilli())), record)
}

// FlushRecords PUTs every pending change and pull record, each created once (If-None-Match: *: a record whose PUT
// landed but whose answer was lost is not written twice). It reads a local folder only: no listing.
func (p *Project) FlushRecords() error {
	entries, err := os.ReadDir(p.pendingDir())
	if err != nil || p.Creds.ReadOnly { // read-only keys (over quota) write nothing: the records wait for the next round
		return nil
	}
	var firstErr error
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(p.pendingDir(), entry.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var head struct {
			Schema string `json:"schema"`
			Seq    int64  `json:"seq"`
			At     string `json:"at"`
		}
		if json.Unmarshal(data, &head) != nil {
			os.Remove(path)
			continue
		}
		var key string
		switch head.Schema {
		case history.ChangesSchema:
			key = history.ChangesKey(p.Root, p.Config.Project, p.Host.ID, head.Seq)
		case history.PullsSchema:
			key = history.PullsKey(p.Root, p.Config.Project, p.Host.ID, head.At)
		default:
			os.Remove(path)
			continue
		}
		if _, err := p.S3.Put(p.Config.Bucket, key, data, "application/json", "*", ""); err != nil && !errors.Is(err, s3.ErrPreconditionFailed) {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		os.Remove(path)
	}
	return firstErr
}

// Restore requests.

// LocalRequestsDir is ~/.folder-sync/projects/<key>/requests/: restores of this machine's own files, left for the
// engine that holds the folder (schema/restore.schema.json). The engine applies them at its next round.
func LocalRequestsDir(stateDir string) string { return filepath.Join(stateDir, "requests") }

// WriteLocalRequest leaves a restore of this machine's own files for the engine that holds the folder.
func WriteLocalRequest(stateDir string, req history.Request) error {
	return writeJSON(filepath.Join(LocalRequestsDir(stateDir), req.ID+".json"), req)
}

// pendingRequest is a restore request waiting to be applied, and where its outcome goes.
type pendingRequest struct {
	req   history.Request
	raw   map[string]json.RawMessage // every field it came with, so the outcome is written into it unchanged
	key   string                     // its bucket key ("" for a local or a command-line request)
	etag  string                     // the ETag it was read at
	local string                     // its local file
}

func parseRequest(data []byte) (history.Request, map[string]json.RawMessage, error) {
	var req history.Request
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &req); err != nil {
		return req, nil, err
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return req, nil, err
	}
	return req, raw, nil
}

// localRequests are the local requests without an outcome (a local folder read: no bucket operation).
func (p *Project) localRequests() []pendingRequest {
	dir := LocalRequestsDir(p.StateDir)
	entries, _ := os.ReadDir(dir)
	var out []pendingRequest
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		req, raw, err := parseRequest(data)
		if err != nil || req.Outcome != nil {
			continue
		}
		if err := req.Check(p.Config.Project, p.Host.ID); err != nil {
			p.say("restore request %s: %v", entry.Name(), err)
			continue
		}
		out = append(out, pendingRequest{req: req, raw: raw, local: path})
	}
	return out
}

// answeredState is requests.json: the ETag each answered bucket request had after its outcome was written, so a
// later listing skips it without a GET.
type answeredState struct {
	ETags map[string]string `json:"etags"`
}

// bucketRequests lists this host's requests in the bucket (one listing; it runs with peer discovery) and reads the
// ones not yet answered.
func (p *Project) bucketRequests() ([]pendingRequest, error) {
	listed, err := p.S3.List(p.Config.Bucket, history.RequestsPrefix(p.Root, p.Config.Project, p.Host.ID), "")
	if err != nil {
		return nil, err
	}
	var answered answeredState
	if data, err := os.ReadFile(p.statePath("requests.json")); err == nil {
		_ = json.Unmarshal(data, &answered)
	}
	still := map[string]string{}
	var out []pendingRequest
	for _, obj := range listed.Objects {
		if !strings.HasSuffix(obj.Key, ".json") {
			continue
		}
		etag := unquote(obj.ETag)
		if was, ok := answered.ETags[obj.Key]; ok && was == etag && etag != "" {
			still[obj.Key] = etag
			continue
		}
		got, err := p.S3.GetIfNoneMatch(p.Config.Bucket, obj.Key, "")
		if err != nil || got.NotFound {
			continue
		}
		req, raw, err := parseRequest(got.Body)
		if err != nil {
			p.say("restore request %s is not JSON; left as it is", obj.Key)
			continue
		}
		if req.Outcome != nil {
			still[obj.Key] = unquote(got.ETag)
			continue
		}
		if err := req.Check(p.Config.Project, p.Host.ID); err != nil {
			p.say("restore request %s: %v; left as it is", obj.Key, err)
			continue
		}
		out = append(out, pendingRequest{req: req, raw: raw, key: obj.Key, etag: unquote(got.ETag)})
	}
	return out, writeJSON(p.statePath("requests.json"), answeredState{ETags: still})
}

func unquote(etag string) string { return strings.Trim(etag, `"`) }

// answer writes a request's outcome into it: the bucket key with If-Match on the ETag it was read at, or its local
// file. The host never deletes a request; the pruner does, 30 days after its at.
func (p *Project) answer(pr pendingRequest, outcome history.Outcome) error {
	if pr.key == "" && pr.local == "" {
		return nil
	}
	data, err := json.Marshal(outcome)
	if err != nil {
		return err
	}
	if pr.raw == nil {
		pr.raw = map[string]json.RawMessage{}
	}
	pr.raw["outcome"] = data
	body, err := json.MarshalIndent(pr.raw, "", "  ")
	if err != nil {
		return err
	}
	if pr.local != "" {
		tmp := pr.local + ".tmp"
		if err := os.WriteFile(tmp, append(body, '\n'), 0o600); err != nil {
			return err
		}
		return os.Rename(tmp, pr.local)
	}
	etag, err := p.S3.Put(p.Config.Bucket, pr.key, body, "application/json", "", pr.etag)
	if err != nil {
		return err
	}
	var answered answeredState
	if data, err := os.ReadFile(p.statePath("requests.json")); err == nil {
		_ = json.Unmarshal(data, &answered)
	}
	if answered.ETags == nil {
		answered.ETags = map[string]string{}
	}
	answered.ETags[pr.key] = unquote(etag)
	return writeJSON(p.statePath("requests.json"), answered)
}

// applyRequest carries out one restore request (docs/peps/0007 §3.3): each item's version is fetched, checked
// against its name's sha16 and written over its path, after whatever is on disk there has been published; then one
// push publishes them all, each replaced version kept first. Its outcome is written back, and returned.
func (p *Project) applyRequest(ctx context.Context, stamp string, pr pendingRequest, result *Result) history.Outcome {
	req := pr.req
	results := make([]history.Result, len(req.Items))
	p.restoring = map[string]restoreMark{}
	defer func() { p.restoring = nil }()
	var written []int
	for i, item := range req.Items {
		results[i] = history.Result{Path: item.Path, Version: item.Version, OK: true}
		wrote, code, why := p.restoreOne(ctx, stamp, item, req.ID, result)
		if code != "" {
			results[i].OK, results[i].Error, results[i].Why = false, code, p.Creds.Scrub(why)
			continue
		}
		if wrote {
			written = append(written, i)
		}
	}
	outcome := history.Outcome{Results: results}
	if len(written) > 0 {
		before := p.ManifestSeq()
		err := p.Push(ctx, stamp, result)
		var copyFailed *CopyError
		held := map[string]bool{}
		for _, path := range result.HeldCopies {
			held[path] = true
		}
		if err != nil {
			why := "the restored file is on this disk; publishing it failed: " + p.Creds.Scrub(err.Error())
			for _, i := range written {
				// a held history copy holds only its own path: the other restored files went
				if !errors.As(err, &copyFailed) || held[req.Items[i].Path] {
					results[i].OK, results[i].Error, results[i].Why = false, history.ErrFailed, why
				}
			}
		}
		if seq := p.ManifestSeq(); seq > before && (err == nil || errors.As(err, &copyFailed)) {
			outcome.Seq = int64(seq)
		}
	}
	for _, r := range results {
		if r.OK {
			continue
		}
		ev := p.fileEvent("restore", p.Now())
		ev.Level, ev.Path, ev.From, ev.Request, ev.Error, ev.Why = "error", r.Path, r.Version, req.ID, r.Error, r.Why
		if pr.key == "" && pr.local == "" {
			ev.Request = "" // asked on this machine's command line: no request to name
		}
		result.Events = append(result.Events, ev)
	}
	outcome.At = manifest.FormatTime(p.Now())
	if err := p.answer(pr, outcome); err != nil {
		p.say("restore request %s: writing its outcome failed (%v); it is applied again next time", req.ID, err)
	}
	return outcome
}

// restoreOne writes one version back over its path. It answers wrote=true when the file now holds the version's
// bytes and a push is needed, or an error code (pruned | mismatch | failed) and why. WHY publish first and check
// again before the rename (docs/peps/0007 §3.3, "a restore can never lose an edit"): whatever is on disk becomes a
// version, kept in history by the restore's push, before the old bytes replace it.
func (p *Project) restoreOne(ctx context.Context, stamp string, item history.RequestItem, requestID string, result *Result) (wrote bool, code, why string) {
	path := item.Path
	if first, _, _ := strings.Cut(path, "/"); first == p.Config.PeersDir {
		return false, history.ErrFailed, path + " is another machine's copy: that machine restores it"
	}
	if ok, skipped := lintOne(path); !ok {
		return false, history.ErrFailed, skipped
	}
	local := filepath.Join(p.Folder, filepath.FromSlash(path))
	var current string // the sha256 on disk now ("" when absent), and published
	for attempt := 0; ; attempt++ {
		published, isPublished := p.publishedEntry(path)
		sum, err := HashFile(local)
		exists := err == nil
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return false, history.ErrFailed, err.Error()
		}
		if !exists || (isPublished && sum == published.SHA256) {
			current = sum
			break
		}
		if attempt == 2 {
			if !isPublished {
				return false, history.ErrFailed, path + " on this disk is not published (ignored, or a name that cannot sync): move it away to restore over it"
			}
			return false, history.ErrFailed, path + " kept changing while it was being restored: try again"
		}
		if err := p.Push(ctx, stamp, result); err != nil {
			return false, history.ErrFailed, "publishing what is on disk first: " + err.Error()
		}
	}
	_, sha16, unlisted, err := history.SplitVersionID(item.Version)
	if err != nil {
		return false, history.ErrFailed, err.Error()
	}
	if err := os.MkdirAll(filepath.Dir(local), 0o755); err != nil {
		return false, history.ErrFailed, err.Error()
	}
	tmp := filepath.Join(filepath.Dir(local), restoreTempPrefix+newJobID()[:8])
	defer os.Remove(tmp)
	key := history.Key(p.Root, p.Config.Project, p.Host.ID, path, item.Version)
	if err := p.S3.GetToFile(p.Config.Bucket, key, tmp); errors.Is(err, s3.ErrNotFound) {
		return false, history.ErrPruned, ""
	} else if err != nil {
		return false, history.ErrFailed, err.Error()
	}
	sum, err := HashFile(tmp)
	if err != nil {
		return false, history.ErrFailed, err.Error()
	}
	if !unlisted && sum[:16] != sha16 {
		return false, history.ErrMismatch, "its bytes hash to " + sum[:16] + ", not " + sha16
	}
	if sum == current {
		return false, "", "" // the file already holds those bytes
	}
	// one last look: an edit since the publish above is never overwritten
	if now, err := HashFile(local); (err == nil && now != current) || (err != nil && current != "") {
		return false, history.ErrFailed, path + " changed while it was being restored: try again"
	}
	t := p.Now()
	os.Chtimes(tmp, t, t)
	if err := os.Rename(tmp, local); err != nil {
		return false, history.ErrFailed, err.Error()
	}
	p.restoring[path] = restoreMark{From: item.Version, Request: requestID}
	return true, "", ""
}

// restoreTempPrefix names a restore's temporary file beside its target; Filters keeps one a crash left out of the push.
const restoreTempPrefix = ".folder-sync-restore-"

func lintOne(path string) (bool, string) {
	ok, skipped := names.Lint([]string{path}, reservedPaths())
	if len(ok) == 1 {
		return true, ""
	}
	if len(skipped) > 0 {
		return false, skipped[0].Reason
	}
	return false, path + " cannot be published"
}

// publishedEntry is path's entry in the last manifest this machine published.
func (p *Project) publishedEntry(path string) (manifest.Entry, bool) {
	m, err := p.ownManifest()
	if err != nil {
		return manifest.Entry{}, false
	}
	e, ok := m.Index()[path]
	return e, ok
}

// History reads.

// Versions lists one path's kept versions on host (one delimiter listing), oldest first.
func (p *Project) Versions(host, path string) ([]history.Version, error) {
	listed, err := p.S3.List(p.Config.Bucket, history.PathPrefix(p.Root, p.Config.Project, host, path), "/")
	if err != nil {
		return nil, err
	}
	return parseVersions(listed.Objects), nil
}

// AllVersions lists every kept version of host (one listing per 1,000 versions).
func (p *Project) AllVersions(host string) ([]history.Version, error) {
	listed, err := p.S3.List(p.Config.Bucket, history.Prefix(p.Root, p.Config.Project, host), "")
	if err != nil {
		return nil, err
	}
	return parseVersions(listed.Objects), nil
}

func parseVersions(objects []s3.Object) []history.Version {
	var out []history.Version
	for _, obj := range objects {
		v, err := history.ParseKey(obj.Key)
		if err != nil {
			continue
		}
		v.LeftAt, v.Size = obj.LastModified, obj.Size
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Version < out[j].Version })
	return out
}

// Newest is the newest of versions: the largest left_at, then the largest id.
func Newest(versions []history.Version) (history.Version, bool) {
	if len(versions) == 0 {
		return history.Version{}, false
	}
	best := versions[0]
	for _, v := range versions[1:] {
		if v.LeftAt.After(best.LeftAt) || (v.LeftAt.Equal(best.LeftAt) && v.Version > best.Version) {
			best = v
		}
	}
	return best, true
}

// Deleted is this host's deleted files: the paths with a kept version and no entry in its manifest, each with its
// newest version, newest deletion first.
func (p *Project) Deleted() ([]history.Version, error) {
	all, err := p.AllVersions(p.Host.ID)
	if err != nil {
		return nil, err
	}
	m, err := p.ownManifest()
	if err != nil {
		return nil, err
	}
	live := m.Index()
	var out []history.Version
	for path, group := range history.ByPath(all) {
		if _, ok := live[path]; ok {
			continue
		}
		if newest, ok := Newest(group); ok {
			out = append(out, newest)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].LeftAt.Equal(out[j].LeftAt) {
			return out[i].LeftAt.After(out[j].LeftAt)
		}
		return out[i].Path < out[j].Path
	})
	return out, nil
}

// AskRestore writes a restore request for another host's files into the bucket, created once (If-None-Match: *).
func (p *Project) AskRestore(req history.Request) error {
	body, err := json.MarshalIndent(req, "", "  ")
	if err != nil {
		return err
	}
	_, err = p.S3.Put(p.Config.Bucket, history.RequestKey(p.Root, p.Config.Project, req.Host, req.ID), body, "application/json", "*", "")
	return err
}

// NewRequestID is a request's id: a random UUID v4.
func NewRequestID() string { return newJobID() }

// The own-host pruner.

// pruneState is prune.json: when this engine last pruned its host's history.
type pruneState struct {
	At string `json:"at"`
}

func (p *Project) pruneDue(now time.Time) bool {
	var state pruneState
	if data, err := os.ReadFile(p.statePath("prune.json")); err == nil {
		_ = json.Unmarshal(data, &state)
	}
	return due(state.At, PruneEvery, now)
}

// Prune deletes what has aged out of this host's history (the schedule, docs/CONTRACT.md "What is kept"), its
// change and pull records, its restore requests (bucket and local) 30 days after their at, and its legacy _trash/
// 30 days after each stamp. WHY each engine too, not only the folder's object: a v0 bucket-key folder has no
// accounts server, so this is its only pruner; two pruners on one key are harmless (the rule is deterministic).
func (p *Project) Prune() (int, error) {
	now := p.Now()
	cutoff := now.Add(-history.KeepDays * 24 * time.Hour)
	var drop []string
	all, err := p.AllVersions(p.Host.ID)
	if err != nil {
		return 0, err
	}
	for _, group := range history.ByPath(all) {
		_, gone := history.Prune(group, now, history.KeepDays)
		for _, v := range gone {
			drop = append(drop, v.Key)
		}
	}
	changes := history.ChangesPrefix(p.Root, p.Config.Project, p.Host.ID)
	listed, err := p.S3.List(p.Config.Bucket, changes, "")
	if err != nil {
		return 0, err
	}
	for _, obj := range listed.Objects {
		if name, isPull := strings.CutPrefix(obj.Key, changes+"pulls/"); isPull {
			if at, err := time.Parse(time.RFC3339Nano, strings.TrimSuffix(name, ".json")); err == nil {
				if !at.After(cutoff) {
					drop = append(drop, obj.Key)
				}
				continue
			}
		}
		// WHY LastModified: a record is written at or after its at, so this never deletes one early
		if !obj.LastModified.After(cutoff) {
			drop = append(drop, obj.Key)
		}
	}
	listed, err = p.S3.List(p.Config.Bucket, history.RequestsPrefix(p.Root, p.Config.Project, p.Host.ID), "")
	if err != nil {
		return 0, err
	}
	for _, obj := range listed.Objects {
		if !obj.LastModified.After(cutoff) { // an outcome is written after at, so this is never early either
			drop = append(drop, obj.Key)
		}
	}
	trash := history.TrashPrefix(p.Root, p.Config.Project, p.Host.ID)
	listed, err = p.S3.List(p.Config.Bucket, trash, "")
	if err != nil {
		return 0, err
	}
	for _, obj := range listed.Objects {
		if stamp, ok := history.TrashStampAge(obj.Key, trash); ok && !stamp.After(cutoff) {
			drop = append(drop, obj.Key)
		}
	}
	errs := make([]error, len(drop))
	parallel(len(drop), func(i int) { errs[i] = p.S3.Delete(p.Config.Bucket, drop[i]) })
	if err := errors.Join(errs...); err != nil {
		return 0, err
	}
	p.pruneLocalRequests(cutoff)
	if len(drop) > 0 {
		p.logf("prune: deleted %d objects older than the schedule keeps", len(drop))
	}
	return len(drop), writeJSON(p.statePath("prune.json"), pruneState{At: manifest.FormatTime(now)})
}

func (p *Project) pruneLocalRequests(cutoff time.Time) {
	dir := LocalRequestsDir(p.StateDir)
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var req history.Request
		if json.Unmarshal(data, &req) != nil {
			continue
		}
		if at, err := time.Parse(time.RFC3339Nano, req.At); err == nil && !at.After(cutoff) {
			os.Remove(path)
		}
	}
}
