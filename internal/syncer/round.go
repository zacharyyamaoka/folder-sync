package syncer

import (
	"context"
	"crypto/rand"
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

	"folder-sync/internal/config"
	"folder-sync/internal/host"
	"folder-sync/internal/ignore"
	"folder-sync/internal/manifest"
	"folder-sync/internal/names"
	"folder-sync/internal/rclone"
)

// manifestPublishTimeout bounds the one publish a stop waits for.
const manifestPublishTimeout = time.Minute

// LocalFile is one file found in the project folder.
type LocalFile struct {
	Path  string
	Size  int64
	MTime time.Time
}

// Conflict is a local edit to a peer's read-only copy, moved aside before the peer's version landed.
type Conflict struct {
	Peer    string `json:"peer"`
	Path    string `json:"path"`
	KeptAt  string `json:"kept_at"` // where the local edit was moved
	FoundAt string `json:"found_at"`
}

// PeerResult is one peer's part of a pull.
type PeerResult struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Files       int    `json:"files"`
	Seq         int64  `json:"seq"`
	NotModified bool   `json:"not_modified"`
	Fetched     int    `json:"fetched"`
	Removed     int    `json:"removed"`
	Skipped     int    `json:"skipped"`
}

// Result is what one round did.
type Result struct {
	Reconciled      bool            `json:"reconciled"`
	Uploaded        []string        `json:"uploaded"`
	Deleted         []string        `json:"deleted"`
	HeldDeletes     []string        `json:"held_deletes"`
	HeldUploads     []string        `json:"held_uploads"` // read-only keys (over quota): not uploaded this round
	ManifestWritten bool            `json:"manifest_written"`
	Skipped         []names.Skipped `json:"skipped"`
	Peers           []PeerResult    `json:"peers"`
	Conflicts       []Conflict      `json:"conflicts"`
}

// Filters writes the rclone filter file for this project's push and returns its path.
// The peers' folder is always excluded: a machine publishes only its own files.
func (p *Project) Filters() (string, error) {
	// The project config is excluded too: a peer's copy of it inside <peers_dir>/ would
	// make that copy look like a synced folder of its own.
	body, err := ignore.Compile(p.Config.Ignore, "/"+p.Config.PeersDir+"/", "/"+config.FileName)
	if err != nil {
		return "", err
	}
	path := p.statePath("filters.txt")
	if err := os.MkdirAll(p.StateDir, 0o700); err != nil {
		return "", err
	}
	return path, os.WriteFile(path, []byte(body), 0o600)
}

type lsjsonItem struct {
	Path    string
	Size    int64
	ModTime string // RFC 3339; empty with --no-modtime
	IsDir   bool
}

// Scan lists the project folder through rclone with the filters applied
// (a local listing: no bucket operation).
func (p *Project) Scan(ctx context.Context, filters string) ([]LocalFile, error) {
	out, err := p.Rclone.Run(ctx, "lsjson", "-R", "--files-only", "--no-mimetype", "--filter-from", filters, p.Folder)
	if err != nil {
		return nil, err
	}
	var items []lsjsonItem
	if err := json.Unmarshal(out, &items); err != nil {
		return nil, fmt.Errorf("rclone lsjson: %w", err)
	}
	files := make([]LocalFile, 0, len(items))
	for _, item := range items {
		if item.IsDir {
			continue
		}
		mtime, err := time.Parse(time.RFC3339Nano, item.ModTime)
		if err != nil {
			return nil, fmt.Errorf("rclone lsjson: %s: %w", item.Path, err)
		}
		files = append(files, LocalFile{Path: item.Path, Size: item.Size, MTime: mtime})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files, nil
}

// reservedPaths may not be published from the folder root: the bucket contract uses them.
func reservedPaths() map[string]string {
	return map[string]string{
		manifest.FileName: "manifest.json at the folder root is reserved: the bucket keeps this machine's manifest at hosts/<host-id>/manifest.json (docs/CONTRACT.md)",
	}
}

// EmptyFolderError is Push refusing a folder that lists no file when its last
// manifest had some: an unmounted disk or a wiped folder must never delete them all.
type EmptyFolderError struct {
	Folder string
	Had    int
}

func (e *EmptyFolderError) Error() string {
	return fmt.Sprintf("%s looks empty or unmounted (0 files, the last manifest had %d); refusing to delete them all", e.Folder, e.Had)
}

// ReadOnlyError is a push with read-only keys (the account is over its storage quota, docs/peps/0003 §3.7) that held
// uploads or could not finish its deletes: the round still pulls, and reports this.
type ReadOnlyError struct {
	Reason string
	Held   int
	Err    error // a delete through the accounts server that did not finish this round
}

func (e *ReadOnlyError) Error() string {
	why := e.Reason
	if why == "" {
		why = "the storage keys are read-only"
	}
	msg := fmt.Sprintf("this account is over its storage quota (%s): %d upload(s) held until it is back under; deleting files frees space", why, e.Held)
	if e.Err != nil {
		msg += "; " + e.Err.Error()
	}
	return msg
}

func (e *ReadOnlyError) Unwrap() error { return e.Err }

// ErrManifestChanged: the accounts server says this host's manifest is not at the seq a delete named (a round the local
// copy never saw); the round takes the bucket's own manifest.
var ErrManifestChanged = errors.New("this host's manifest moved on")

// Push uploads this machine's changes, moves overwritten and deleted objects to
// _trash/, and rewrites the manifest (docs/peps/0001 §4-§5).
func (p *Project) Push(ctx context.Context, stamp string, result *Result) error {
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
	okPaths, skipped := names.Lint(paths, reservedPaths())
	result.Skipped = append(result.Skipped, skipped...)
	for _, s := range skipped {
		if !p.reportedSkips[s.Path] { // `status` always lists them; the round says each once
			p.say("skipped %s: %s", s.Path, s.Reason)
		}
	}

	prev, err := p.ownManifest()
	if err != nil {
		return fmt.Errorf("this machine's last manifest: %w", err)
	}
	if len(okPaths) == 0 && len(prev.Files) > 0 {
		return &EmptyFolderError{Folder: p.Folder, Had: len(prev.Files)}
	}
	prevIndex := prev.Index()
	now := manifest.FormatTime(p.Now())

	var next []manifest.Entry
	var changed []string
	metadataOnly := 0
	present := map[string]bool{}
	for _, path := range okPaths {
		present[path] = true
		f := byPath[path]
		mtime := manifest.FormatTime(f.MTime)
		old, known := prevIndex[path]
		if known && old.Size == f.Size && sameTime(old.MTime, mtime) {
			next = append(next, old)
			continue
		}
		sum, err := HashFile(filepath.Join(p.Folder, filepath.FromSlash(path)))
		if err != nil {
			return err
		}
		if known && old.SHA256 == sum {
			// Same content, new mtime: no upload; the manifest records the new mtime.
			old.MTime = mtime
			next = append(next, old)
			metadataOnly++
			continue
		}
		changed = append(changed, path)
		next = append(next, manifest.Entry{Path: path, Size: f.Size, MTime: mtime, SHA256: sum, WrittenAt: now})
	}
	var deleted []string
	for _, old := range prev.Files {
		if !present[old.Path] {
			deleted = append(deleted, old.Path)
		}
	}
	if len(deleted) > p.Config.MaxDelete {
		p.say("holding %d deletes: more than max_delete = %d in one round; they stay in the bucket until you raise max_delete or restore the files", len(deleted), p.Config.MaxDelete)
		result.HeldDeletes = deleted
		for _, path := range deleted {
			next = append(next, prevIndex[path])
		}
		deleted = nil
	}

	if p.Creds.ReadOnly {
		return p.pushReadOnly(ctx, prev, changed, deleted, result)
	}

	remoteRoot := rclone.Path(p.Config.Bucket, p.HostPrefix(p.Host.ID))
	trash := rclone.Path(p.Config.Bucket, p.TrashPrefix(stamp))
	if len(changed) > 0 {
		list, err := p.writeList("upload.txt", changed)
		if err != nil {
			return err
		}
		// rclone refuses --filter-from beside --files-from; the list comes from the
		// filtered scan above, so the ignore rules are already applied.
		if _, err := p.Rclone.Run(ctx, "copy", p.Folder, remoteRoot,
			"--files-from-raw", list, "--no-traverse",
			"--backup-dir", trash, "--max-delete", fmt.Sprint(p.Config.MaxDelete)); err != nil {
			return err
		}
		result.Uploaded = changed
	}
	if len(deleted) > 0 {
		list, err := p.writeList("delete.txt", deleted)
		if err != nil {
			return err
		}
		// A delete is a server-side move into _trash/: nothing is lost without a copy.
		if _, err := p.Rclone.Run(ctx, "move", remoteRoot, trash,
			"--files-from-raw", list, "--no-traverse", "--max-delete", fmt.Sprint(p.Config.MaxDelete)); err != nil {
			return err
		}
		result.Deleted = deleted
	}
	needManifest := len(changed) > 0 || len(deleted) > 0 || metadataOnly > 0 || p.manifestMissing()
	if !needManifest {
		return nil
	}
	m := manifest.Manifest{
		Schema:      manifest.Schema,
		Project:     p.Config.Project,
		HostID:      p.Host.ID,
		HostName:    p.Host.Name,
		Seq:         prev.Seq + 1,
		GeneratedAt: now,
		Files:       next,
	}
	m.Sort()
	if err := m.Validate(); err != nil {
		return fmt.Errorf("refusing to publish an invalid manifest: %w", err)
	}
	pending := p.statePath("manifest.pending.json")
	if err := manifest.Save(pending, m); err != nil {
		return err
	}
	// WHY: a stop (SIGTERM, Ctrl-C) must not cut the publish between the PUT and the local
	// commit below. The PUT lands, rclone is killed during its post-upload check, the rename
	// never runs, and the next round sees the same files as changed and PUTs the manifest a
	// second time (seq + 1), so every peer's conditional GET answers 200 instead of 304.
	// The manifest is one small object; the stop waits for it, bounded.
	publishCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), manifestPublishTimeout)
	defer cancel()
	if _, err := p.Rclone.Run(publishCtx, "copyto", pending,
		rclone.Path(p.Config.Bucket, p.HostPrefix(p.Host.ID)+"/"+manifest.FileName), "--no-check-dest"); err != nil {
		return err
	}
	if err := os.Rename(pending, p.statePath("manifest.json")); err != nil {
		return err
	}
	os.Remove(p.statePath("manifest.missing"))
	result.ManifestWritten = true
	return nil
}

// DeleteAnswer is the accounts server's answer to a delete: the manifest it built and published for this host, the
// paths whose objects are gone, and (review r3 #2) the ones it will still delete on its own.
type DeleteAnswer struct {
	Seq      int64             `json:"seq"`
	Deleted  []string          `json:"deleted"`
	Pending  []string          `json:"pending"`
	Manifest manifest.Manifest `json:"manifest"`
}

// deleteJob is ~/.folder-sync/projects/<key>/delete-job.json: a delete sent to the accounts server whose answer has
// not arrived. WHY kept (review r3 #2): the server may have committed it; the same job id asked again gets the same
// answer, never a second delete.
type deleteJob struct {
	Job     string   `json:"job"`
	FromSeq int64    `json:"from_seq"`
	Paths   []string `json:"paths"`
}

func newJobID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// pushReadOnly is a push with read-only keys (review r2 #7): nothing is uploaded and nothing is written to the bucket.
// Deletes go through the accounts server as a job (review r3 #1-2): it builds the next manifest from the published
// one, deletes them permanently and lowers the usage; its manifest becomes this machine's once checked. A job whose
// answer was lost is asked for again first; a server that says the manifest moved on makes the round take the
// bucket's own (a read). Anything that goes wrong is a ReadOnlyError, so the round still pulls.
func (p *Project) pushReadOnly(ctx context.Context, prev manifest.Manifest, changed, deleted []string, result *Result) error {
	refusal := func(err error) error {
		held := len(changed)
		if held > 0 {
			result.HeldUploads = changed
		}
		if err == nil && held == 0 {
			return nil
		}
		return &ReadOnlyError{Reason: p.Creds.Reason, Held: held, Err: err}
	}
	if p.RemoteDelete == nil {
		if len(deleted) > 0 {
			return refusal(fmt.Errorf("this machine is not signed in to an accounts server to delete through"))
		}
		return refusal(nil)
	}
	jobPath := p.statePath("delete-job.json")
	run := func(job deleteJob) error {
		answer, err := p.RemoteDelete(ctx, job.Job, job.FromSeq, job.Paths)
		if errors.Is(err, ErrManifestChanged) {
			os.Remove(jobPath)
			if adoptErr := p.adoptPublished(); adoptErr != nil {
				return fmt.Errorf("the accounts server says this host's manifest moved on, and it could not be read: %w", adoptErr)
			}
			return fmt.Errorf("this host's manifest had moved on; taken from the bucket, the deletes go next round")
		}
		if err != nil {
			return fmt.Errorf("deleting through the accounts server (asked again next round): %w", err)
		}
		// WHY against the job's own base (review r4 #4): its answer is from_seq + 1, whatever this machine holds since
		if prev.Seq != job.FromSeq {
			return fmt.Errorf("a delete from seq %d against a local manifest at seq %d", job.FromSeq, prev.Seq)
		}
		if err := checkDeleteAnswer(prev, job.Paths, answer.Manifest, p.Host.ID, p.Config.Project); err != nil {
			return fmt.Errorf("the accounts server's manifest: %w", err)
		}
		if err := p.keepManifest(answer.Manifest); err != nil {
			return err
		}
		os.Remove(jobPath)
		prev = answer.Manifest
		result.Deleted = append(result.Deleted, answer.Deleted...)
		result.ManifestWritten = true
		p.say("%d deleted permanently through the accounts server (over quota: no trash copy)", len(answer.Deleted))
		if len(answer.Pending) > 0 {
			p.say("%d more out of the manifest; the accounts server deletes their files on its own", len(answer.Pending))
		}
		return nil
	}
	var earlier deleteJob
	if data, err := os.ReadFile(jobPath); err == nil && json.Unmarshal(data, &earlier) == nil && earlier.Job != "" {
		split := false
		if prev.Seq > earlier.FromSeq {
			// its result, or a later manifest, is already this machine's (kept before a restart removed the job file,
			// or taken from the bucket by a read-only reconcile): the job is done (review r4 #4)
			os.Remove(jobPath)
		} else if err := run(earlier); errors.Is(err, ErrTooLarge) {
			// refused before anything was done (review r5 #3): its paths go again below, in jobs that fit
			os.Remove(jobPath)
			split = true
		} else if err != nil {
			return refusal(err)
		}
		done := make(map[string]bool, len(earlier.Paths))
		for _, path := range earlier.Paths {
			done[path] = !split // a split job's paths are still to delete
		}
		var rest []string
		for _, path := range deleted {
			if !done[path] {
				rest = append(rest, path)
			}
		}
		deleted = rest
	}
	for _, batch := range deleteBatches(deleted) {
		job := deleteJob{Job: newJobID(), FromSeq: prev.Seq, Paths: batch}
		data, _ := json.Marshal(job)
		if err := os.WriteFile(jobPath, data, 0o600); err != nil {
			return refusal(err)
		}
		if err := run(job); err != nil {
			if errors.Is(err, ErrTooLarge) {
				os.Remove(jobPath) // refused before anything was done: never kept to be refused again
			}
			return refusal(err)
		}
	}
	return refusal(nil)
}

// deleteBatch is how many paths one delete job carries (the server takes up to 400: a HEAD and a DELETE each), and
// deleteBodyMax how many bytes its request body may be (the server takes up to 256 KiB; the margin is for the seq).
const (
	deleteBatch   = 400
	deleteBodyMax = 250 * 1024
)

// deleteBatches splits paths into jobs that each fit the server: at most deleteBatch paths and deleteBodyMax bytes of
// {"from_seq":…,"job":"<uuid>","paths":[…]} as encoded. WHY bytes too (review r5 #3): 400 long paths were a 285 KB
// request, refused with 413, and the job was kept and refused again for good.
func deleteBatches(paths []string) [][]string {
	envelope := len(`{"from_seq":9223372036854775807,"job":"00000000-0000-4000-8000-000000000000","paths":[]}`)
	var batches [][]string
	var batch []string
	size := envelope
	for _, path := range paths {
		encoded, _ := json.Marshal(path)
		cost := len(encoded) + 1 // the comma
		if len(batch) > 0 && (len(batch) == deleteBatch || size+cost > deleteBodyMax) {
			batches = append(batches, batch)
			batch, size = nil, envelope
		}
		batch = append(batch, path)
		size += cost
	}
	if len(batch) > 0 {
		batches = append(batches, batch)
	}
	return batches
}

// ErrTooLarge: the accounts server refused a delete's request body as too large (413), before doing anything.
var ErrTooLarge = errors.New("the delete request is too large")

// keepManifest makes m this machine's published manifest (it already is, in the bucket).
func (p *Project) keepManifest(m manifest.Manifest) error {
	pending := p.statePath("manifest.pending.json")
	if err := manifest.Save(pending, m); err != nil {
		return err
	}
	return os.Rename(pending, p.statePath("manifest.json"))
}

// ReconcileReadOnly is the reconcile of a round with read-only keys: no stray moves (they write), only this host's
// published manifest taken when it is ahead of the local copy (a delete's answer lost with its job file).
func (p *Project) ReconcileReadOnly() error {
	got, err := p.S3.GetIfNoneMatch(p.Config.Bucket, p.HostPrefix(p.Host.ID)+"/"+manifest.FileName, "")
	if err != nil || got.NotFound {
		return err
	}
	remote, err := manifest.Parse(got.Body)
	if err != nil {
		return err
	}
	if local, err := p.ownManifest(); err == nil && remote.Seq <= local.Seq {
		return nil
	}
	return p.adoptPublished()
}

// adoptPublished takes this host's manifest from the bucket (a read): a round with read-only keys reconciles its
// manifest state this way, with no write (review r3 #2).
func (p *Project) adoptPublished() error {
	got, err := p.S3.GetIfNoneMatch(p.Config.Bucket, p.HostPrefix(p.Host.ID)+"/"+manifest.FileName, "")
	if err != nil {
		return err
	}
	if got.NotFound {
		return fmt.Errorf("this host has no manifest in the bucket")
	}
	m, err := manifest.Parse(got.Body)
	if err != nil {
		return err
	}
	if m.HostID != p.Host.ID || m.Project != p.Config.Project {
		return fmt.Errorf("the manifest under this host's prefix claims %s/%s", m.Project, m.HostID)
	}
	return p.keepManifest(m)
}

// checkDeleteAnswer: the server's manifest is this host's, the next seq, and exactly prev minus the deleted paths.
func checkDeleteAnswer(prev manifest.Manifest, deleted []string, next manifest.Manifest, hostID, project string) error {
	if err := next.Validate(); err != nil {
		return err
	}
	if next.HostID != hostID || next.Project != project || next.Seq != prev.Seq+1 {
		return fmt.Errorf("it is %s/%s seq %d, not this host's seq %d", next.Project, next.HostID, next.Seq, prev.Seq+1)
	}
	gone := make(map[string]bool, len(deleted))
	for _, path := range deleted {
		gone[path] = true
	}
	want := map[string]manifest.Entry{}
	for _, e := range prev.Files {
		if !gone[e.Path] {
			want[e.Path] = e
		}
	}
	if len(want) != len(next.Files) {
		return fmt.Errorf("it lists %d files, not %d", len(next.Files), len(want))
	}
	for _, e := range next.Files {
		if w, ok := want[e.Path]; !ok || w != e {
			return fmt.Errorf("it changes %s", e.Path)
		}
	}
	return nil
}

// manifestMissing is set by a reconcile that found no manifest in the bucket.
func (p *Project) manifestMissing() bool {
	_, err := os.Stat(p.statePath("manifest.missing"))
	return err == nil
}

func sameTime(a, b string) bool {
	ta, errA := time.Parse(time.RFC3339Nano, a)
	tb, errB := time.Parse(time.RFC3339Nano, b)
	return errA == nil && errB == nil && ta.Equal(tb)
}

func (p *Project) writeList(name string, paths []string) (string, error) {
	path := p.statePath(name)
	return path, os.WriteFile(path, []byte(strings.Join(paths, "\n")+"\n"), 0o600)
}

// Reconcile is the safety net (docs/peps/0001 §4: "a full listing reconcile runs at start
// and hourly"). It lists this machine's prefix once, forgets manifest entries the bucket
// lacks (so the next push re-uploads them), moves stray objects to _trash/, and
// discovers peers.
func (p *Project) Reconcile(ctx context.Context, stamp string, result *Result) error {
	own := p.HostPrefix(p.Host.ID)
	out, err := p.Rclone.Run(ctx, "lsjson", "-R", "--files-only", "--no-mimetype", rclone.Path(p.Config.Bucket, own))
	if err != nil && !strings.Contains(err.Error(), "directory not found") {
		return err
	}
	var items []lsjsonItem
	if len(out) > 0 {
		if err := json.Unmarshal(out, &items); err != nil {
			return fmt.Errorf("rclone lsjson: %w", err)
		}
	}
	remote := map[string]int64{}
	for _, item := range items {
		remote[item.Path] = item.Size
	}
	prev, err := p.ownManifest()
	if err != nil {
		return err
	}
	if _, ok := remote[manifest.FileName]; !ok {
		os.WriteFile(p.statePath("manifest.missing"), nil, 0o600)
	}
	var kept []manifest.Entry
	forgotten := 0
	inManifest := map[string]bool{}
	for _, e := range prev.Files {
		inManifest[e.Path] = true
		if size, ok := remote[e.Path]; ok && size == e.Size {
			kept = append(kept, e)
		} else {
			forgotten++
		}
	}
	if forgotten > 0 {
		p.say("reconcile: %d files in the manifest are missing or different in the bucket; the next push re-uploads them", forgotten)
		prev.Files = kept
		if err := manifest.Save(p.statePath("manifest.json"), prev); err != nil {
			return err
		}
	}
	var strays []string
	for path := range remote {
		if path != manifest.FileName && !inManifest[path] {
			strays = append(strays, path)
		}
	}
	sort.Strings(strays)
	if len(strays) > 0 {
		p.say("reconcile: moving %d objects the manifest does not list to _trash/", len(strays))
		list, err := p.writeList("strays.txt", strays)
		if err != nil {
			return err
		}
		if _, err := p.Rclone.Run(ctx, "move", rclone.Path(p.Config.Bucket, own), rclone.Path(p.Config.Bucket, p.TrashPrefix(stamp)),
			"--files-from-raw", list, "--no-traverse"); err != nil {
			return err
		}
	}

	result.Reconciled = true
	return p.Discover(ctx)
}

// Discover lists the project's hosts/ folder one level deep (one delimiter LIST, not a
// full listing) and adds new peers. It runs with every reconcile and every DiscoverEvery.
func (p *Project) Discover(ctx context.Context) error {
	out, err := p.Rclone.Run(ctx, "lsjson", "--dirs-only", "--no-mimetype", "--no-modtime", rclone.Path(p.Config.Bucket, p.HostsPrefix()))
	if err != nil && !strings.Contains(err.Error(), "directory not found") {
		return err
	}
	var dirs []lsjsonItem
	if len(out) > 0 {
		if err := json.Unmarshal(out, &dirs); err != nil {
			return fmt.Errorf("rclone lsjson: %w", err)
		}
	}
	peers := p.loadPeers()
	known := map[string]bool{}
	for _, id := range peers.Known {
		known[id] = true
	}
	for _, dir := range dirs {
		if host.IsID(dir.Path) && dir.Path != p.Host.ID && !known[dir.Path] {
			p.say("found peer %s", dir.Path)
			peers.Known = append(peers.Known, dir.Path)
			known[dir.Path] = true
		}
	}
	return p.savePeers(peers)
}

// Pull fetches peers' changes: one conditional GET of each peer's manifest, then
// only the files that changed, into <folder>/<peers_dir>/<peer-id>/ (read-only copies).
func (p *Project) Pull(ctx context.Context, result *Result) error {
	peers := p.loadPeers()
	var firstErr error
	for _, peerID := range peers.Known {
		peerResult, err := p.pullPeer(ctx, peerID, &peers, result)
		if err != nil {
			p.say("pull from %s: %v", peerID, err)
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		result.Peers = append(result.Peers, peerResult)
	}
	if err := p.savePeers(peers); err != nil {
		return err
	}
	return firstErr
}

func (p *Project) pullPeer(ctx context.Context, peerID string, peers *PeerState, result *Result) (PeerResult, error) {
	cachedPath := p.peerManifestPath(peerID)
	cached, haveCached, err := manifest.Load(cachedPath)
	if err != nil {
		haveCached = false
		cached = manifest.Manifest{}
	}
	etag := ""
	if haveCached {
		etag = peers.ETags[peerID]
	}
	got, err := p.S3.GetIfNoneMatch(p.Config.Bucket, p.HostPrefix(peerID)+"/"+manifest.FileName, etag)
	if err != nil {
		return PeerResult{}, err
	}
	if got.NotModified {
		return PeerResult{ID: peerID, Name: cached.HostName, Files: len(cached.Files), Seq: cached.Seq, NotModified: true}, nil
	}
	if got.NotFound {
		return PeerResult{ID: peerID, NotModified: true}, nil
	}
	m, err := manifest.Parse(got.Body)
	if err != nil {
		return PeerResult{}, err
	}
	if m.HostID != peerID || m.Project != p.Config.Project {
		return PeerResult{}, fmt.Errorf("manifest under hosts/%s claims host %s, project %s", peerID, m.HostID, m.Project)
	}
	pr := PeerResult{ID: peerID, Name: m.HostName, Files: len(m.Files), Seq: m.Seq}
	localRoot := filepath.Join(p.Folder, p.Config.PeersDir, peerID)
	oldIndex := cached.Index()
	stamp := Stamp(p.Now())

	var fetch []string
	newIndex := map[string]manifest.Entry{}
	for _, e := range m.Files {
		if runtime.GOOS == "windows" {
			if err := names.CheckWindows(e.Path); err != nil {
				result.Skipped = append(result.Skipped, names.Skipped{Path: peerID + "/" + e.Path, Reason: err.Error()})
				pr.Skipped++
				continue
			}
		}
		newIndex[e.Path] = e
		localPath := filepath.Join(localRoot, filepath.FromSlash(e.Path))
		info, statErr := os.Stat(localPath)
		if old, ok := oldIndex[e.Path]; ok && statErr == nil && old.SHA256 == e.SHA256 &&
			info.Size() == e.Size && sameTime(manifest.FormatTime(info.ModTime()), e.MTime) {
			continue // unchanged since the last pull: no hashing
		}
		if statErr == nil && info.Size() == e.Size {
			if sum, err := HashFile(localPath); err == nil && sum == e.SHA256 {
				p.applyMTime(localPath, e.MTime)
				continue
			}
		}
		if statErr == nil {
			if old, ok := oldIndex[e.Path]; !ok || !p.unchangedSince(localPath, old) {
				if conflict, err := p.keepLocalEdit(peerID, e.Path, localPath, stamp); err == nil {
					result.Conflicts = append(result.Conflicts, conflict)
				} else {
					return pr, err
				}
			}
		}
		fetch = append(fetch, e.Path)
	}
	for path, old := range oldIndex {
		if _, still := newIndex[path]; still {
			continue
		}
		localPath := filepath.Join(localRoot, filepath.FromSlash(path))
		if _, err := os.Stat(localPath); err != nil {
			continue
		}
		if !p.unchangedSince(localPath, old) {
			conflict, err := p.keepLocalEdit(peerID, path, localPath, stamp)
			if err != nil {
				return pr, err
			}
			result.Conflicts = append(result.Conflicts, conflict)
			continue
		}
		if err := os.Remove(localPath); err != nil {
			return pr, err
		}
		removeEmptyParents(filepath.Dir(localPath), localRoot)
		pr.Removed++
	}
	sort.Strings(fetch)
	if len(fetch) > 0 {
		list, err := p.writeList("fetch-"+peerID+".txt", fetch)
		if err != nil {
			return pr, err
		}
		if _, err := p.Rclone.Run(ctx, "copy", rclone.Path(p.Config.Bucket, p.HostPrefix(peerID)), localRoot,
			"--files-from-raw", list, "--no-traverse"); err != nil {
			return pr, err
		}
	}
	consistent := true
	for _, path := range fetch {
		e := newIndex[path]
		localPath := filepath.Join(localRoot, filepath.FromSlash(path))
		sum, err := HashFile(localPath)
		if err != nil || sum != e.SHA256 {
			// The peer overwrote the file after writing this manifest: take the next manifest.
			consistent = false
			continue
		}
		p.applyMTime(localPath, e.MTime)
	}
	pr.Fetched = len(fetch)
	if err := manifest.Save(cachedPath, m); err != nil {
		return pr, err
	}
	if consistent {
		peers.ETags[peerID] = got.ETag
	} else {
		delete(peers.ETags, peerID)
	}
	return pr, nil
}

// unchangedSince reports whether a peer copy still holds what was pulled for entry.
func (p *Project) unchangedSince(localPath string, entry manifest.Entry) bool {
	info, err := os.Stat(localPath)
	if err != nil {
		return false
	}
	if info.Size() != entry.Size {
		return false
	}
	sum, err := HashFile(localPath)
	return err == nil && sum == entry.SHA256
}

// keepLocalEdit moves a locally edited peer copy to ~/.folder-sync/conflicts/ before it is replaced.
func (p *Project) keepLocalEdit(peerID, path, localPath, stamp string) (Conflict, error) {
	dest := filepath.Join(p.Layout.Conflicts, p.Config.Project, peerID, stamp, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
		return Conflict{}, err
	}
	if err := os.Rename(localPath, dest); err != nil {
		return Conflict{}, err
	}
	p.say("conflict: %s/%s was edited here, but it is %s's file; your edit is kept at %s", peerID, path, peerID, dest)
	return Conflict{Peer: peerID, Path: path, KeptAt: dest, FoundAt: manifest.FormatTime(p.Now())}, nil
}

func (p *Project) applyMTime(localPath, mtime string) {
	t, err := time.Parse(time.RFC3339Nano, mtime)
	if err != nil {
		return
	}
	if info, err := os.Stat(localPath); err == nil && !info.ModTime().Equal(t) {
		os.Chtimes(localPath, t, t)
	}
}

func removeEmptyParents(dir, stop string) {
	for dir != stop && strings.HasPrefix(dir, stop) {
		if err := os.Remove(dir); err != nil {
			return
		}
		dir = filepath.Dir(dir)
	}
}
