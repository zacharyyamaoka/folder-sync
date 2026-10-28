package syncer

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"folder-sync/internal/config"
	"folder-sync/internal/history"
	"folder-sync/internal/host"
	"folder-sync/internal/manifest"
	"folder-sync/internal/s3"
)

// fakeStore is just enough of S3 for a history copy, and it honours x-amz-copy-source-if-match, which the e2e
// stand-in ignores: objects by key with their ETag.
type fakeStore struct {
	mu      sync.Mutex
	objects map[string]string // key -> ETag (unquoted)
	copies  []string          // "src -> dst if-match"
	refuse  bool              // answer every copy 403
}

func (f *fakeStore) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	key := strings.TrimPrefix(r.URL.Path, "/bkt/")
	switch {
	case r.Method == http.MethodPut && r.Header.Get("X-Amz-Copy-Source") != "":
		src := strings.TrimPrefix(r.Header.Get("X-Amz-Copy-Source"), "/bkt/")
		f.copies = append(f.copies, src+" -> "+key+" "+r.Header.Get("X-Amz-Copy-Source-If-Match"))
		etag, ok := f.objects[src]
		switch {
		case f.refuse:
			w.WriteHeader(http.StatusForbidden)
		case !ok:
			w.WriteHeader(http.StatusNotFound)
		case r.Header.Get("X-Amz-Copy-Source-If-Match") != "" && r.Header.Get("X-Amz-Copy-Source-If-Match") != `"`+etag+`"`:
			w.WriteHeader(http.StatusPreconditionFailed)
		default:
			f.objects[key] = etag
			w.Write([]byte(`<CopyObjectResult></CopyObjectResult>`))
		}
	case r.Method == http.MethodHead:
		etag, ok := f.objects[key]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("ETag", `"`+etag+`"`)
		w.Header().Set("Last-Modified", "Wed, 28 Oct 2026 20:00:00 GMT")
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

const testHost = "b55e9683-7854-4121-a56a-9bae7c3ab1da"

func historyProject(t *testing.T, store *fakeStore) *Project {
	server := httptest.NewServer(store)
	t.Cleanup(server.Close)
	cfg := config.New("notes", "bkt")
	return &Project{Config: cfg, Host: host.Host{ID: testHost, Name: "bam-GPU"}, Root: "users/AbC123/", StateDir: t.TempDir(),
		S3: &s3.Client{Endpoint: server.URL, Region: "auto", AccessKeyID: "key", SecretAccessKey: "secret"}}
}

var planEntry = manifest.Entry{Path: "notes/plan.md", Size: 1980, MTime: "2026-10-28T20:30:59Z",
	SHA256: "9f2c1a3b4c5d6e7f00112233445566778899aabbccddeeff0011223344556677", WrittenAt: "2026-10-28T20:31:00.117260411Z", ObjectETag: "aaa"}

// TestCopyKeepsTheListedVersion: the copy names the version by the entry it leaves, and is conditioned on its ETag.
func TestCopyKeepsTheListedVersion(t *testing.T) {
	live := "users/AbC123/notes/hosts/" + testHost + "/notes/plan.md"
	store := &fakeStore{objects: map[string]string{live: "aaa"}}
	p := historyProject(t, store)
	it := &leaving{Path: "notes/plan.md", Op: history.OpReplace, Old: planEntry}
	if err := p.keepLeaving(t.Context(), []*leaving{it}, time.Date(2026, 10, 28, 20, 41, 0, 0, time.UTC)); err != nil || it.Err != nil {
		t.Fatal(err, it.Err)
	}
	want := "users/AbC123/_history/notes/" + testHost + "/notes/plan.md/2026-10-28T20:31:00.117Z_9f2c1a3b4c5d6e7f"
	if it.Kept != "2026-10-28T20:31:00.117Z_9f2c1a3b4c5d6e7f" || len(store.copies) != 1 || store.copies[0] != live+" -> "+want+` "aaa"` {
		t.Fatalf("kept %q, copies %q", it.Kept, store.copies)
	}
	// a round whose manifest PUT failed sees the same version leave again: it is not copied twice
	again := &leaving{Path: "notes/plan.md", Op: history.OpReplace, Old: planEntry}
	p.keepLeaving(t.Context(), []*leaving{again}, time.Date(2026, 10, 28, 20, 42, 0, 0, time.UTC))
	if again.Kept != it.Kept || len(store.copies) != 1 {
		t.Fatalf("a second copy of the kept version: %q %q", again.Kept, store.copies)
	}
}

// TestCopyOfAnUnlistedObjectKeepsItAsUnlisted (CONTRACT "Deletions and history"): when the live object is not the
// version the manifest lists (the copy's If-Match answers 412), what is there is kept as <LastModified>_unlisted.
func TestCopyOfAnUnlistedObjectKeepsItAsUnlisted(t *testing.T) {
	live := "users/AbC123/notes/hosts/" + testHost + "/notes/plan.md"
	store := &fakeStore{objects: map[string]string{live: "bbb"}} // someone else's bytes
	p := historyProject(t, store)
	it := &leaving{Path: "notes/plan.md", Op: history.OpReplace, Old: planEntry}
	if err := p.keepLeaving(t.Context(), []*leaving{it}, time.Date(2026, 10, 28, 20, 41, 0, 0, time.UTC)); err != nil || it.Err != nil {
		t.Fatal(err, it.Err)
	}
	unlisted := "users/AbC123/_history/notes/" + testHost + "/notes/plan.md/2026-10-28T20:00:00.000Z_unlisted"
	if it.Kept != "2026-10-28T20:00:00.000Z_unlisted" || store.objects[unlisted] != "bbb" {
		t.Fatalf("kept %q; copies %q", it.Kept, store.copies)
	}
	listed := "users/AbC123/_history/notes/" + testHost + "/notes/plan.md/2026-10-28T20:31:00.117Z_9f2c1a3b4c5d6e7f"
	if _, mislabelled := store.objects[listed]; mislabelled {
		t.Fatal("the other bytes were kept under the listed version's name")
	}
}

// TestFailedCopyHoldsThePath: a copy the store refuses leaves the path's error set (the push then holds it), and a
// missing source asks the next round to reconcile.
func TestFailedCopyHoldsThePath(t *testing.T) {
	store := &fakeStore{objects: map[string]string{}, refuse: true}
	p := historyProject(t, store)
	it := &leaving{Path: "notes/plan.md", Op: history.OpDelete, Old: planEntry}
	p.keepLeaving(t.Context(), []*leaving{it}, time.Now())
	if it.Err == nil || it.Kept != "" {
		t.Fatalf("a refused copy: %+v", it)
	}
	store.refuse = false
	gone := &leaving{Path: "notes/plan.md", Op: history.OpDelete, Old: planEntry}
	p.keepLeaving(t.Context(), []*leaving{gone}, time.Now())
	if gone.Err == nil || !p.reconcileRequested() {
		t.Fatalf("a missing source: %+v, reconcile requested %v", gone, p.reconcileRequested())
	}
}

// TestNoHistoryAndKeyTooLongAreNotCopied: no copy is made for a no_history path or a key past 1,024 bytes.
func TestNoHistoryAndKeyTooLongAreNotCopied(t *testing.T) {
	store := &fakeStore{objects: map[string]string{}}
	p := historyProject(t, store)
	logEntry := planEntry
	logEntry.Path = "logs/agent.log"
	long := planEntry
	long.Path = strings.Repeat("a", 990) + ".md"
	items := []*leaving{{Path: logEntry.Path, Op: history.OpDelete, Old: logEntry}, {Path: long.Path, Op: history.OpDelete, Old: long}}
	p.keepLeaving(t.Context(), items, time.Now())
	if items[0].Why != history.WhyNoHistory || items[1].Why != history.WhyKeyTooLong || len(store.copies) != 0 {
		t.Fatalf("%+v %+v %q", items[0], items[1], store.copies)
	}
	if _, err := os.Stat(p.statePath("history.json")); err != nil {
		t.Fatal(err)
	}
}
