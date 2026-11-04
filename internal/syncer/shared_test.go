package syncer

// The engine's side of the shared tree (docs/peps/0010): what a machine sends, what it believes afterwards, and what it
// will never overwrite. The folder's object is a stand-in here (treeServer): it follows the Worker's contract for who wins
// (accounts/test/shared.test.ts proves the real one), so what is tested is the machine's bookkeeping: the base of every
// change is the hash of bytes it wrote or sent, a local edit is never overwritten, and a file leaves the machine's own host
// only after the tree holds it. The whole thing end to end, with the real Worker, is e2e/shared_test.go.

import (
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"folder-sync/internal/config"
	"folder-sync/internal/history"
	"folder-sync/internal/host"
	"folder-sync/internal/manifest"
	"folder-sync/internal/rclone"
	"folder-sync/internal/s3"
)

const treeHost = "5d0f6c8e-2b1a-4e7d-9c3f-8a6b5e4d3c2b"

func sum(data []byte) string {
	s := sha256.Sum256(data)
	return hex.EncodeToString(s[:])
}

// treeServer stands in for the folder's Durable Object: it holds the tree, writes its objects and manifest into the store as
// the real one does, and answers a commit with the contract's four outcomes. A mismatch is a conflict copy unless merge says
// how the two merge.
type treeServer struct {
	t       *testing.T
	store   *memStore
	clock   func() time.Time
	seq     int64
	private []string
	files   map[string]manifest.Entry
	// merge, when set, merges a collision: it returns the merged bytes and true, or false for a conflict copy
	merge   func(path string, ours, theirs []byte) ([]byte, bool)
	commits []SharedRequest
	// down makes every commit fail (the accounts server does not answer)
	down bool
}

func newTreeServer(t *testing.T, store *memStore, clock func() time.Time) *treeServer {
	ts := &treeServer{t: t, store: store, clock: clock, files: map[string]manifest.Entry{}, private: []string{}}
	ts.publish()
	return ts
}

func (ts *treeServer) key(p string) string {
	return worldRoot + worldProject + "/hosts/" + treeHost + "/" + p
}

func (ts *treeServer) put(key string, data []byte) {
	ts.store.mu.Lock()
	defer ts.store.mu.Unlock()
	ts.store.store(key, data)
}

func (ts *treeServer) publish() {
	ts.seq++
	m := manifest.Manifest{Schema: manifest.Schema, Project: worldProject, HostID: treeHost, HostName: "shared", Seq: ts.seq,
		GeneratedAt: manifest.FormatTime(ts.clock()), Shared: &manifest.Shared{Private: ts.private}}
	for _, e := range ts.files {
		m.Files = append(m.Files, e)
	}
	m.Sort()
	if m.Files == nil {
		m.Files = []manifest.Entry{}
	}
	ts.put(worldRoot+worldProject+"/hosts/"+treeHost+"/"+manifest.FileName, manifest.Marshal(m))
}

func (ts *treeServer) write(p string, data []byte) manifest.Entry {
	at := manifest.FormatTime(ts.clock())
	md := md5.Sum(data)
	e := manifest.Entry{Path: p, Size: int64(len(data)), MTime: at, SHA256: sum(data), WrittenAt: at, ObjectETag: hex.EncodeToString(md[:])}
	ts.put(ts.key(p), data)
	ts.files[p] = e
	return e
}

// edit is another device's change landing in the tree (no commit from the machine under test).
func (ts *treeServer) edit(p string, data []byte) {
	ts.write(p, data)
	ts.publish()
}

func (ts *treeServer) remove(p string) {
	delete(ts.files, p)
	ts.store.mu.Lock()
	delete(ts.store.objects, ts.key(p))
	ts.store.mu.Unlock()
	ts.publish()
}

func (ts *treeServer) version(p string) string {
	e, ok := ts.files[p]
	if !ok {
		return ""
	}
	return versionOf(e)
}

func copyName(p, device string, at time.Time, taken map[string]manifest.Entry) string {
	ext := path.Ext(p)
	stem := strings.TrimSuffix(p, ext)
	name := fmt.Sprintf("%s (Conflicted copy %s %s)%s", stem, device, at.Format("200601021504"), ext)
	for n := 2; ; n++ {
		if _, used := taken[name]; !used {
			return name
		}
		name = fmt.Sprintf("%s (Conflicted copy %s %s) %d%s", stem, device, at.Format("200601021504"), n, ext)
	}
}

func (ts *treeServer) commit(_ context.Context, req SharedRequest) (SharedAnswer, error) {
	if ts.down {
		return SharedAnswer{}, fmt.Errorf("accounts.example did not answer")
	}
	ts.commits = append(ts.commits, req)
	answer := SharedAnswer{Host: treeHost}
	changed := false
	for _, c := range req.Changes {
		cur, have := ts.files[c.Path]
		agrees := have && c.Base != nil && (c.Base.Version == versionOf(cur) || (c.Base.SHA256 != "" && c.Base.SHA256 == cur.SHA256))
		r := SharedResult{Path: c.Path, Outcome: "accepted"}
		if c.Delete {
			switch {
			case !have:
			case agrees:
				delete(ts.files, c.Path)
				ts.store.mu.Lock()
				delete(ts.store.objects, ts.key(c.Path))
				ts.store.mu.Unlock()
				changed = true
			default:
				r.Outcome, r.Version, r.SHA256, r.Size = "edit_won", versionOf(cur), cur.SHA256, cur.Size
			}
			answer.Results = append(answer.Results, r)
			continue
		}
		var data []byte
		if c.Staged != "" {
			data = ts.store.get(worldRoot + "_incoming/" + worldProject + "/" + req.Host + "/" + c.Staged)
		} else {
			data, _ = base64.StdEncoding.DecodeString(c.Body)
		}
		if sum(data) != c.SHA256 {
			return SharedAnswer{}, fmt.Errorf("400 bad_body: the bytes of %s do not hash to the sha256 sent", c.Path)
		}
		switch {
		case have && cur.SHA256 == c.SHA256:
			r.Version, r.SHA256, r.Size = versionOf(cur), cur.SHA256, cur.Size
		case !have || agrees:
			e := ts.write(c.Path, data)
			r.Version, r.SHA256, r.Size = versionOf(e), e.SHA256, e.Size
			changed = true
		default:
			theirs := ts.store.get(ts.key(c.Path))
			if merged, ok := ts.mergeOf(c.Path, data, theirs); ok {
				e := ts.write(c.Path, merged)
				r.Outcome, r.Merge, r.Version, r.SHA256, r.Size = "merged", "lines", versionOf(e), e.SHA256, e.Size
			} else {
				copyPath := copyName(c.Path, req.Device, ts.clock(), ts.files)
				ce := ts.write(copyPath, data)
				r.Outcome, r.Why, r.ConflictPath, r.ConflictVersion = "conflict", "overlap", copyPath, versionOf(ce)
				r.Version, r.SHA256, r.Size = versionOf(cur), cur.SHA256, cur.Size
			}
			changed = true
		}
		answer.Results = append(answer.Results, r)
	}
	if changed {
		ts.publish()
	}
	answer.Seq, answer.Changed = ts.seq, changed
	return answer, nil
}

func (ts *treeServer) mergeOf(p string, ours, theirs []byte) ([]byte, bool) {
	if ts.merge == nil {
		return nil, false
	}
	return ts.merge(p, ours, theirs)
}

// machine is a second (or third) machine of the folder: its own folder, state and host id on the same store.
type machine struct {
	*world
}

// join adds another machine to w's folder: the same bucket, its own folder, state dir and host.
func join(t *testing.T, w *world, id, name string) *machine {
	t.Helper()
	m := &world{t: t, clock: w.clock, folder: t.TempDir(), store: w.store}
	cfg := config.New(worldProject, "bkt")
	cfg.MaxDelete = w.p.Config.MaxDelete
	l := testLayout(t)
	c := w.p.Creds
	m.p = &Project{Folder: m.folder, Config: cfg, Layout: l, Host: host.Host{ID: id, Name: name}, Creds: c, Root: worldRoot,
		Rclone:   rclone.Runner{Bin: os.Args[0], Layout: l, Creds: c},
		S3:       &s3.Client{Endpoint: c.Endpoint, Region: "auto", AccessKeyID: "key", SecretAccessKey: "secret", HTTP: &http.Client{Timeout: time.Minute}},
		StateDir: t.TempDir(), Now: func() time.Time { return m.clock }}
	return &machine{m}
}

// shareWith makes w's project follow the tree, with a commit that goes to ts.
func shareWith(t *testing.T, w *world, ts *treeServer) {
	t.Helper()
	w.p.SharedCommit = ts.commit
	if err := w.p.AdoptShared(treeHost, ts.private); err != nil {
		t.Fatal(err)
	}
	// the tree is a peer like any: the pull finds it by its id
	data, _ := json.Marshal(PeerState{Known: []string{treeHost}, ETags: map[string]string{}})
	os.WriteFile(filepath.Join(w.p.StateDir, "peers.json"), data, 0o600)
}

// sync runs one whole round at the current fake time; the periodic reconcile is already done so it does not forget the
// machine's own published files (the fake rclone cannot list the bucket).
func (w *world) sync() Result {
	w.t.Helper()
	last := LastSync{Schema: LastSyncSchema, LastReconcile: w.clock.Format(time.RFC3339Nano), LastDiscover: w.clock.Format(time.RFC3339Nano)}
	writeJSON(filepath.Join(w.p.StateDir, "last-sync.json"), last)
	result, err := w.p.Round(context.Background(), Options{})
	if err != nil {
		w.t.Fatalf("round at %s: %v", w.clock.Format(time.RFC3339), err)
	}
	return result
}

func (w *world) exists(path string) bool {
	_, err := os.Stat(filepath.Join(w.folder, filepath.FromSlash(path)))
	return err == nil
}

func (w *world) files() []string {
	var out []string
	filepath.WalkDir(w.folder, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(w.folder, p)
		rel = filepath.ToSlash(rel)
		if rel != config.FileName && !strings.HasPrefix(rel, "hosts/") {
			out = append(out, rel)
		}
		return nil
	})
	sort.Strings(out)
	return out
}

func TestSharedNewFilesGoWithNoBaseAndTheirVersionIsRemembered(t *testing.T) {
	w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), nil)
	ts := newTreeServer(t, w.store, func() time.Time { return w.clock })
	shareWith(t, w, ts)
	w.write("notes/a.md", []byte("alpha\n"))
	w.write("b.txt", []byte("beta\n"))
	w.advance(time.Second)
	result := w.sync()
	if len(ts.commits) != 1 {
		t.Fatalf("one commit for one round, got %d", len(ts.commits))
	}
	req := ts.commits[0]
	if req.Device != "bam-GPU" || req.Host != testHost || req.MaxDelete != 50 {
		t.Fatalf("request: %+v", req)
	}
	var paths []string
	for _, c := range req.Changes {
		paths = append(paths, c.Path)
		if c.Base != nil || c.Delete || c.Staged != "" {
			t.Errorf("%s: a new file has no base and travels inline: %+v", c.Path, c)
		}
		data, _ := base64.StdEncoding.DecodeString(c.Body)
		if c.SHA256 != sum(data) || c.Size != int64(len(data)) || c.AtLocal == "" {
			t.Errorf("%s: the body, its hash and size, and the device's time must agree: %+v", c.Path, c)
		}
	}
	if strings.Join(paths, ",") != "b.txt,notes/a.md" {
		t.Fatalf("paths %v", paths)
	}
	st := w.p.sharedStateRef()
	if got := st.Held["b.txt"]; got.Version != ts.version("b.txt") || got.SHA256 != sum([]byte("beta\n")) {
		t.Fatalf("held %+v, the tree's version is %s", got, ts.version("b.txt"))
	}
	if strings.Join(result.Uploaded, ",") != "b.txt,notes/a.md" {
		t.Fatalf("uploaded %v", result.Uploaded)
	}
	// nothing changed: nothing is sent, and nothing is fetched back (the tree's version is the file)
	w.advance(time.Second)
	w.sync()
	if len(ts.commits) != 1 {
		t.Fatalf("a quiet round commits nothing, got %d commits", len(ts.commits))
	}
	// an edit goes with the version it was made from; a delete likewise
	w.advance(time.Second)
	w.write("b.txt", []byte("beta, edited\n"))
	w.sync()
	last := ts.commits[len(ts.commits)-1].Changes[0]
	if last.Path != "b.txt" || last.Base == nil || last.Base.Version == "" || last.Base.SHA256 != sum([]byte("beta\n")) {
		t.Fatalf("the edit's base: %+v", last)
	}
	w.advance(time.Second)
	os.Remove(filepath.Join(w.folder, "notes/a.md"))
	w.sync()
	last = ts.commits[len(ts.commits)-1].Changes[0]
	if !last.Delete || last.Path != "notes/a.md" || last.Base == nil {
		t.Fatalf("the delete: %+v", last)
	}
	if _, ok := ts.files["notes/a.md"]; ok {
		t.Fatal("the tree still lists the deleted file")
	}
	if _, held := w.p.sharedStateRef().Held["notes/a.md"]; held {
		t.Fatal("a deleted file is no longer held")
	}
}

func TestSharedAnotherMachinesFilesArriveAsTheFolderItself(t *testing.T) {
	w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), nil)
	ts := newTreeServer(t, w.store, func() time.Time { return w.clock })
	shareWith(t, w, ts)
	ts.edit("from/web.md", []byte("written in a browser\n"))
	ts.edit("empty.txt", nil)
	result := w.sync()
	if got := string(w.read("from/web.md")); got != "written in a browser\n" {
		t.Fatalf("got %q", got)
	}
	if !w.exists("empty.txt") || len(w.files()) != 2 {
		t.Fatalf("files %v", w.files())
	}
	if w.exists("hosts/" + treeHost + "/from/web.md") {
		t.Fatal("the shared tree is the folder, not a read-only peer copy under hosts/")
	}
	if len(result.Peers) != 1 || result.Peers[0].Fetched != 2 {
		t.Fatalf("peers %+v", result.Peers)
	}
	var downloads int
	for _, ev := range result.Events {
		if ev.Event == "download" && ev.Peer == treeHost && ev.PeerName == "shared" {
			downloads++
		}
	}
	if downloads != 2 {
		t.Fatalf("download events %d: %+v", downloads, result.Events)
	}
	// the file's mtime is the manifest's, so a quiet round does not see a change
	w.advance(time.Second)
	w.sync()
	if len(ts.commits) != 0 {
		t.Fatalf("a file that only arrived is not committed back: %d commits", len(ts.commits))
	}
}

func TestSharedAConflictKeepsTheLocalBytesInTheCopyAndTheFileTakesTheTreesVersion(t *testing.T) {
	w := newWorld(t, time.Date(2026, 11, 4, 9, 7, 0, 0, time.UTC), nil)
	ts := newTreeServer(t, w.store, func() time.Time { return w.clock })
	shareWith(t, w, ts)
	w.write("plan.md", []byte("one\ntwo\nthree\n"))
	w.advance(time.Second)
	w.sync()
	// another device changes the same line first
	w.advance(time.Second)
	ts.edit("plan.md", []byte("one\ntwo (theirs)\nthree\n"))
	w.advance(time.Second)
	w.write("plan.md", []byte("one\ntwo (mine)\nthree\n"))
	result := w.sync()
	if len(result.Conflicts) != 1 || result.Conflicts[0].Path != "plan.md" || !strings.HasPrefix(result.Conflicts[0].KeptAt, "plan (Conflicted copy bam-GPU ") {
		t.Fatalf("conflicts %+v", result.Conflicts)
	}
	var conflictEvents int
	for _, ev := range result.Events {
		if ev.Event == "conflict" && ev.Level == "warn" && ev.Path == "plan.md" && ev.KeptAt == result.Conflicts[0].KeptAt {
			conflictEvents++
		}
	}
	if conflictEvents != 1 {
		t.Fatalf("conflict events: %+v", result.Events)
	}
	// the round's pull brought both: the file holds the tree's version, the copy holds exactly what this machine wrote
	if got := string(w.read("plan.md")); got != "one\ntwo (theirs)\nthree\n" {
		t.Fatalf("plan.md %q", got)
	}
	if got := string(w.read(result.Conflicts[0].KeptAt)); got != "one\ntwo (mine)\nthree\n" {
		t.Fatalf("copy %q", got)
	}
	// and the next round neither commits them again nor reports another conflict
	w.advance(time.Second)
	n := len(ts.commits)
	again := w.sync()
	if len(ts.commits) != n || len(again.Conflicts) != 0 {
		t.Fatalf("a settled folder: %d new commits, conflicts %+v", len(ts.commits)-n, again.Conflicts)
	}
}

func TestSharedAMergeReplacesTheLocalFileWithTheMergedResult(t *testing.T) {
	w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), nil)
	ts := newTreeServer(t, w.store, func() time.Time { return w.clock })
	ts.merge = func(_ string, ours, theirs []byte) ([]byte, bool) {
		return append(append([]byte{}, theirs...), ours...), true
	}
	shareWith(t, w, ts)
	w.write("n.md", []byte("base\n"))
	w.advance(time.Second)
	w.sync()
	w.advance(time.Second)
	ts.edit("n.md", []byte("base\ntheirs\n"))
	w.advance(time.Second)
	w.write("n.md", []byte("ours\n"))
	w.sync()
	if got := string(w.read("n.md")); got != "base\ntheirs\nours\n" {
		t.Fatalf("merged file %q", got)
	}
	if h := w.p.sharedStateRef().Held["n.md"]; h.Version != ts.version("n.md") || h.SHA256 != sum([]byte("base\ntheirs\nours\n")) || len(h.Also) != 0 {
		t.Fatalf("after the merge the file is in step with the tree: %+v", h)
	}
}

// PEP 0010 §5.5: a file that differs from what this machine last knew is never overwritten.
func TestSharedAPullNeverOverwritesALocalEdit(t *testing.T) {
	w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), nil)
	ts := newTreeServer(t, w.store, func() time.Time { return w.clock })
	ts.merge = func(_ string, ours, theirs []byte) ([]byte, bool) {
		return append(append([]byte{}, theirs...), ours...), true
	}
	shareWith(t, w, ts)
	w.write("n.md", []byte("v1\n"))
	w.advance(time.Second)
	w.sync()
	w.advance(time.Second)
	ts.edit("n.md", []byte("v1\nfrom the web\n"))
	// the person saves between the push and the pull of a round: exercise the pull alone
	w.write("n.md", []byte("v1\nlocal edit\n"))
	var result Result
	if err := w.p.Pull(context.Background(), &result); err != nil {
		t.Fatal(err)
	}
	if got := string(w.read("n.md")); got != "v1\nlocal edit\n" {
		t.Fatalf("the pull overwrote a local edit: %q", got)
	}
	if len(result.Conflicts) != 0 {
		t.Fatalf("a deferred file is not a conflict: %+v", result.Conflicts)
	}
	if h := w.p.sharedStateRef().Held["n.md"]; h.SHA256 != sum([]byte("v1\n")) {
		t.Fatalf("the base stays what the edit was made from: %+v", h)
	}
	// the next round commits the edit against its own base and the tree merges it
	w.advance(time.Second)
	w.sync()
	c := ts.commits[len(ts.commits)-1].Changes[0]
	if c.Base == nil || c.Base.SHA256 != sum([]byte("v1\n")) {
		t.Fatalf("the edit's base is the version it was made from, not the pulled one: %+v", c.Base)
	}
	if got := string(w.read("n.md")); got != "v1\nfrom the web\nv1\nlocal edit\n" {
		t.Fatalf("merged %q", got)
	}
}

func TestSharedADeleteInTheTreeRemovesOnlyAnUnchangedFile(t *testing.T) {
	w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), nil)
	ts := newTreeServer(t, w.store, func() time.Time { return w.clock })
	shareWith(t, w, ts)
	w.write("keep/a.md", []byte("a\n"))
	w.write("keep/b.md", []byte("b\n"))
	w.write("gone/c.md", []byte("c\n"))
	w.advance(time.Second)
	w.sync()
	w.advance(time.Second)
	for _, p := range []string{"keep/a.md", "keep/b.md", "gone/c.md"} {
		ts.remove(p)
	}
	w.write("keep/b.md", []byte("b, edited meanwhile\n")) // an edit beats a delete
	w.sync()
	if w.exists("gone/c.md") || w.exists("gone") {
		t.Fatalf("an unchanged file the tree deleted is removed, with its empty folder: %v", w.files())
	}
	if w.exists("keep/a.md") {
		t.Fatal("keep/a.md was unchanged and deleted in the tree")
	}
	if got := string(w.read("keep/b.md")); got != "b, edited meanwhile\n" {
		t.Fatalf("the edit must survive the delete: %q", got)
	}
	// and it comes back to the tree with the edit (their delete, our edit: accepted as a new file)
	if _, ok := ts.files["keep/b.md"]; !ok {
		t.Fatalf("the edited file is committed back: tree %v", ts.files)
	}
}

func TestSharedAnEditBeatsOurDeleteAndTheFileComesBack(t *testing.T) {
	w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), nil)
	ts := newTreeServer(t, w.store, func() time.Time { return w.clock })
	shareWith(t, w, ts)
	w.write("a.md", []byte("one\n"))
	w.write("other.md", []byte("so the folder does not look empty\n"))
	w.advance(time.Second)
	w.sync()
	w.advance(time.Second)
	ts.edit("a.md", []byte("one, edited elsewhere\n"))
	os.Remove(filepath.Join(w.folder, "a.md"))
	w.sync()
	if got := string(w.read("a.md")); got != "one, edited elsewhere\n" {
		t.Fatalf("the delete was undone and the edit is back: %q", got)
	}
}

// PEP 0010 §7: the migration. A file leaves this machine's own host only after the tree holds it, and moving is not deleting.
func TestSharedFilesLeaveTheOwnHostOnlyOnceTheTreeHoldsThem(t *testing.T) {
	w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), func(c *config.Config) { c.MaxDelete = 1 })
	w.write("a.md", []byte("a\n"))
	w.write("b.md", []byte("b\n"))
	w.write("c.md", []byte("c\n"))
	w.advance(time.Second)
	w.sync() // not shared yet: all three are on this host
	own, _ := w.p.ownManifest()
	if len(own.Files) != 3 {
		t.Fatalf("own host %d files", len(own.Files))
	}
	ts := newTreeServer(t, w.store, func() time.Time { return w.clock })
	shareWith(t, w, ts)
	ts.down = true
	w.advance(time.Second)
	// the accounts server does not answer: the round fails to push the tree, but the files stay published on this host
	if _, err := w.p.Round(context.Background(), Options{}); err == nil || !strings.Contains(err.Error(), "shared") {
		t.Fatalf("a round that cannot commit says so: %v", err)
	}
	own, _ = w.p.ownManifest()
	if len(own.Files) != 3 {
		t.Fatalf("nothing leaves the own host before the tree holds it: %d files", len(own.Files))
	}
	ts.down = false
	w.advance(time.Second)
	result := w.sync()
	own, _ = w.p.ownManifest()
	if len(own.Files) != 0 {
		t.Fatalf("the own host keeps only the private files: %+v", own.Files)
	}
	if len(ts.files) != 3 {
		t.Fatalf("the tree holds %d files", len(ts.files))
	}
	if len(result.HeldDeletes) != 0 {
		t.Fatalf("moving three files with max_delete = 1 is not a delete: held %v", result.HeldDeletes)
	}
	if len(result.Deleted) != 0 {
		t.Fatalf("moved files are not deletes: %v", result.Deleted)
	}
	for _, p := range []string{"a.md", "b.md", "c.md"} {
		if kept := w.store.keysUnder(worldRoot + "_history/" + worldProject + "/" + testHost + "/" + p + "/"); len(kept) != 1 {
			t.Errorf("%s: the old version stays in this host's history: %v", p, kept)
		}
		if !w.exists(p) {
			t.Errorf("%s left the folder", p)
		}
	}
}

func TestSharedAFolderThatLooksEmptyDeletesNothing(t *testing.T) {
	w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), nil)
	ts := newTreeServer(t, w.store, func() time.Time { return w.clock })
	shareWith(t, w, ts)
	w.write("a.md", []byte("a\n"))
	w.advance(time.Second)
	w.sync()
	os.Remove(filepath.Join(w.folder, "a.md")) // an unmounted disk shows no file at all
	w.advance(time.Second)
	if _, err := w.p.Round(context.Background(), Options{}); err == nil || !strings.Contains(err.Error(), "looks empty") {
		t.Fatalf("an empty-looking folder is refused: %v", err)
	}
	if _, ok := ts.files["a.md"]; !ok {
		t.Fatal("the tree lost a file to an unmounted disk")
	}
}

func TestSharedMoreDeletesThanMaxDeleteAreHeld(t *testing.T) {
	w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), func(c *config.Config) { c.MaxDelete = 2 })
	ts := newTreeServer(t, w.store, func() time.Time { return w.clock })
	shareWith(t, w, ts)
	for _, n := range []string{"1", "2", "3", "4"} {
		w.write(n+".md", []byte(n+"\n"))
	}
	w.write("keep.md", []byte("k\n"))
	w.advance(time.Second)
	w.sync()
	w.advance(time.Second)
	for _, n := range []string{"1", "2", "3", "4"} {
		os.Remove(filepath.Join(w.folder, n+".md"))
	}
	result := w.sync()
	if len(result.HeldDeletes) != 4 || len(ts.files) != 5 {
		t.Fatalf("held %v, the tree keeps %d files", result.HeldDeletes, len(ts.files))
	}
}

func TestSharedAFileOverTheLimitStaysOnTheOwnHost(t *testing.T) {
	w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), nil)
	ts := newTreeServer(t, w.store, func() time.Time { return w.clock })
	shareWith(t, w, ts)
	w.write("small.md", []byte("s\n"))
	w.write("big.bin", make([]byte, sharedFileMax+1))
	w.advance(time.Second)
	w.sync()
	if _, ok := ts.files["big.bin"]; ok {
		t.Fatal("a file over the shared tree's limit must not be committed")
	}
	own, _ := w.p.ownManifest()
	if len(own.Files) != 1 || own.Files[0].Path != "big.bin" {
		t.Fatalf("the big file is published from this machine's own host: %+v", own.Files)
	}
}

func TestSharedAFileOverOneMiBIsStagedNotSentInline(t *testing.T) {
	w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), nil)
	ts := newTreeServer(t, w.store, func() time.Time { return w.clock })
	shareWith(t, w, ts)
	big := make([]byte, sharedInlineMax+10)
	for i := range big {
		big[i] = byte(i % 251)
	}
	w.write("big.dat", big)
	w.advance(time.Second)
	w.sync()
	c := ts.commits[0].Changes[0]
	if c.Staged == "" || c.Body != "" {
		t.Fatalf("staged expected: %+v", c)
	}
	if got := ts.store.get(ts.key("big.dat")); sum(got) != sum(big) {
		t.Fatal("the tree holds the big file's bytes")
	}
}

func TestSharedOverQuotaHoldsUploadsButStillSendsDeletes(t *testing.T) {
	w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), nil)
	ts := newTreeServer(t, w.store, func() time.Time { return w.clock })
	shareWith(t, w, ts)
	w.write("a.md", []byte("a\n"))
	w.advance(time.Second)
	w.sync()
	w.p.Creds.ReadOnly, w.p.Creds.Reason = true, "over quota"
	w.advance(time.Second)
	w.write("b.md", []byte("b\n"))
	os.Remove(filepath.Join(w.folder, "a.md"))
	var result Result
	if err := w.p.pushShared(context.Background(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.HeldUploads) != 1 || result.HeldUploads[0] != "b.md" {
		t.Fatalf("held %v", result.HeldUploads)
	}
	if _, ok := ts.files["a.md"]; ok {
		t.Fatal("the delete must go even over quota: it frees space")
	}
	if _, ok := ts.files["b.md"]; ok {
		t.Fatal("the upload must wait")
	}
}

// PEP 0008's save-storm race, in the shared tree (PEP 0010 §9, §11 case 6): one machine saves a file twenty times while the
// other only pulls, at any rate. No conflict copy, and the same bytes at the end. Then they take turns.
func TestSharedSaveStormMakesNoConflict(t *testing.T) {
	a := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), nil)
	ts := newTreeServer(t, a.store, func() time.Time { return a.clock })
	shareWith(t, a, ts)
	b := join(t, a, "7c9e6679-7425-40de-944b-e07fc1f90ae7", "bam-Air")
	shareWith(t, b.world, ts)
	a.write("storm.md", []byte("first\n"))
	a.advance(time.Second)
	a.sync()
	b.clock = a.clock
	b.sync()
	var conflicts int
	for i := 1; i <= 20; i++ {
		a.advance(50 * time.Millisecond)
		b.clock = a.clock
		a.write("storm.md", []byte(fmt.Sprintf("save %d\n", i)))
		a.sync()
		if i%3 == 0 { // the other machine pulls at some of the moments
			conflicts += len(b.sync().Conflicts)
		}
	}
	b.sync()
	conflicts += len(a.sync().Conflicts)
	if conflicts != 0 {
		t.Fatalf("%d conflicts in a save storm", conflicts)
	}
	for _, m := range []*world{a, b.world} {
		if got := string(m.read("storm.md")); got != "save 20\n" {
			t.Fatalf("final bytes %q", got)
		}
		for _, f := range m.files() {
			if strings.Contains(f, "Conflicted") {
				t.Fatalf("a conflict copy: %s", f)
			}
		}
	}
	// taking turns, each editing after the other's change arrived: still none
	for i := 0; i < 6; i++ {
		editor, other := a, b.world
		if i%2 == 1 {
			editor, other = b.world, a
		}
		editor.advance(time.Second)
		other.clock = editor.clock
		editor.write("storm.md", append(editor.read("storm.md"), []byte(fmt.Sprintf("turn %d\n", i))...))
		if r := editor.sync(); len(r.Conflicts) != 0 {
			t.Fatalf("turn %d: conflicts %+v", i, r.Conflicts)
		}
		if r := other.sync(); len(r.Conflicts) != 0 {
			t.Fatalf("turn %d (pull): conflicts %+v", i, r.Conflicts)
		}
	}
	if string(a.read("storm.md")) != string(b.read("storm.md")) {
		t.Fatal("the two machines differ at the end")
	}
	if n := len(ts.files); n != 1 {
		t.Fatalf("the tree holds %d files, want 1 (no conflict copies): %v", n, ts.files)
	}
}

func TestSharedAMachineThatIsNotSignedInReportsItAndStillPulls(t *testing.T) {
	w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), nil)
	ts := newTreeServer(t, w.store, func() time.Time { return w.clock })
	shareWith(t, w, ts)
	w.p.SharedCommit = nil
	ts.edit("web.md", []byte("hello\n"))
	w.write("local.md", []byte("local\n"))
	_, err := w.p.Round(context.Background(), Options{})
	if err == nil || !strings.Contains(err.Error(), "folder-sync login") {
		t.Fatalf("the round says why it cannot push the shared tree: %v", err)
	}
	if !w.exists("web.md") {
		t.Fatal("the pull still runs")
	}
}

func TestSharedStateSurvivesARestart(t *testing.T) {
	w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), nil)
	ts := newTreeServer(t, w.store, func() time.Time { return w.clock })
	shareWith(t, w, ts)
	w.write("a.md", []byte("a\n"))
	w.advance(time.Second)
	w.sync()
	data, err := os.ReadFile(w.p.sharedPath())
	if err != nil {
		t.Fatal(err)
	}
	var st sharedState
	if err := json.Unmarshal(data, &st); err != nil || st.Host != treeHost || st.Held["a.md"].SHA256 != sum([]byte("a\n")) {
		t.Fatalf("shared.json %s: %v", data, err)
	}
	// a new process: nothing in memory
	w.p.shared = nil
	if w.p.SharedHost() != treeHost {
		t.Fatal("the folder is still shared after a restart")
	}
	if _, err := history.VersionID(w.p.sharedStateRef().Held["a.md"].Version[:24], strings.Repeat("0", 64)); err != nil {
		t.Fatalf("the remembered version is a version id: %v", err)
	}
}

func TestSharedHostIsFoundWhenFirstMet(t *testing.T) {
	w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), nil)
	ts := newTreeServer(t, w.store, func() time.Time { return w.clock })
	ts.private = []string{"events/", "*.sqlite"}
	ts.publish()
	if w.p.SharedHost() != "" {
		t.Fatal("not shared yet")
	}
	w.p.noteShared(treeHost)
	if w.p.SharedHost() != treeHost || strings.Join(w.p.sharedStateRef().Private, ",") != "events/,*.sqlite" {
		t.Fatalf("state %+v", w.p.sharedStateRef())
	}
	// a plain host is not a shared tree
	other := "7c9e6679-7425-40de-944b-e07fc1f90ae7"
	m := manifest.Manifest{Schema: manifest.Schema, Project: worldProject, HostID: other, HostName: "air", Seq: 1, GeneratedAt: manifest.FormatTime(w.clock), Files: []manifest.Entry{}}
	ts.put(worldRoot+worldProject+"/hosts/"+other+"/manifest.json", manifest.Marshal(m))
	w2 := newWorld(t, w.clock, nil)
	w2.store = w.store
	w2.p.S3 = w.p.S3
	w2.p.noteShared(other)
	if w2.p.SharedHost() != "" {
		t.Fatal("an ordinary host does not make the folder shared")
	}
}
