package syncer

// A manifest read that comes back short (the first half of the bytes, correctly framed, 200) must be read again, never acted on.
// WHY (gate G1, the soak's one unexplained failure: "manifest is not valid JSON: unexpected end of JSON input" beside "Unsolicited
// response received on idle HTTP channel", from the rclone serve s3 stand-in): real S3 and R2 replace an object atomically, but a
// store that serves an object while it is being replaced can answer with part of it. The engine never treated such a body as a
// state (manifest.Parse refuses it), yet one short read failed the whole round, and Discover's noteShared dropped it silently, so a
// shared folder met at that moment was never recognised as shared.

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"folder-sync/internal/manifest"
	"folder-sync/internal/s3"
)

const readPeer = "0f1e2d3c-4b5a-4968-8776-655443322110"

func peerManifestKey() string {
	return worldRoot + worldProject + "/hosts/" + readPeer + "/" + manifest.FileName
}

// plantPeer stores a manifest for readPeer naming files (with real-looking entries) and returns what a good read would say.
func plantPeer(w *world, seq int64, files ...string) manifest.Manifest {
	m := manifest.Manifest{Schema: manifest.Schema, Project: worldProject, HostID: readPeer, HostName: "bam-Air", Seq: seq,
		GeneratedAt: manifest.FormatTime(w.clock), Files: []manifest.Entry{}}
	for _, path := range files {
		m.Files = append(m.Files, manifest.Entry{Path: path, Size: 10, MTime: manifest.FormatTime(w.clock), SHA256: strings.Repeat("a", 64), WrittenAt: manifest.FormatTime(w.clock)})
	}
	w.store.mu.Lock()
	w.store.store(peerManifestKey(), manifest.Marshal(m))
	w.store.mu.Unlock()
	return m
}

func noPause(t *testing.T) {
	t.Helper()
	was := manifestRetryPause
	manifestRetryPause = 0
	t.Cleanup(func() { manifestRetryPause = was })
}

func TestAPeerManifestThatReadsShortOnceIsReadAgain(t *testing.T) {
	noPause(t)
	w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), nil)
	plantPeer(w, 1, "a.md", "b.md")
	w.store.short[peerManifestKey()] = 1
	if err := w.p.savePeers(PeerState{Known: []string{readPeer}, ETags: map[string]string{}}); err != nil {
		t.Fatal(err)
	}
	var result Result
	if err := w.p.Pull(t.Context(), &result); err != nil {
		t.Fatalf("one short read of a peer's manifest must not fail the pull: %v", err)
	}
	if len(result.Peers) != 1 || result.Peers[0].Files != 2 || result.Peers[0].Seq != 1 {
		t.Fatalf("the pull should have taken the whole manifest on the second read: %+v", result.Peers)
	}
	if left := w.store.short[peerManifestKey()]; left != 0 {
		t.Fatalf("the short read was never served (%d left)", left)
	}
}

func TestAPeerManifestThatKeepsReadingShortChangesNothing(t *testing.T) {
	noPause(t)
	w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), nil)
	plantPeer(w, 1, "a.md")
	if err := w.p.savePeers(PeerState{Known: []string{readPeer}, ETags: map[string]string{}}); err != nil {
		t.Fatal(err)
	}
	var first Result
	if err := w.p.Pull(t.Context(), &first); err != nil {
		t.Fatal(err)
	}
	// the copy of a.md has landed (the fake rclone lands none)
	copyPath := filepath.Join(w.folder, "hosts", readPeer, "a.md")
	if err := os.MkdirAll(filepath.Dir(copyPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(copyPath, []byte("aaaaaaaaa\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	etagBefore := w.p.loadPeers().ETags[readPeer]

	// the peer publishes seq 2 with no files; every read of it comes back short
	plantPeer(w, 2)
	w.store.short[peerManifestKey()] = 1000
	var second Result
	err := w.p.Pull(t.Context(), &second)
	if err == nil || !strings.Contains(err.Error(), "not valid JSON") {
		t.Fatalf("a manifest that never reads whole is an error, got %v", err)
	}
	if _, statErr := os.Stat(copyPath); statErr != nil {
		t.Fatalf("a short manifest read must not remove the peer's file from this machine: %v", statErr)
	}
	if got := w.p.loadPeers().ETags[readPeer]; got != etagBefore {
		t.Fatalf("a short read must not move the remembered ETag: %q -> %q", etagBefore, got)
	}
	cached, _, loadErr := manifest.Load(w.p.peerManifestPath(readPeer))
	if loadErr != nil || cached.Seq != 1 || len(cached.Files) != 1 {
		t.Fatalf("the remembered manifest stays seq 1: %+v (%v)", cached, loadErr)
	}

	// the next round reads it whole and carries on
	w.store.short[peerManifestKey()] = 0
	var third Result
	if err := w.p.Pull(t.Context(), &third); err != nil {
		t.Fatalf("the round after a short read: %v", err)
	}
	if _, statErr := os.Stat(copyPath); !os.IsNotExist(statErr) {
		t.Fatalf("seq 2 has no a.md, so its copy goes (%v)", statErr)
	}
}

func TestASharedHostWhoseManifestReadsShortIsStillFound(t *testing.T) {
	noPause(t)
	w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), nil)
	ts := newTreeServer(t, w.store, func() time.Time { return w.clock })
	ts.private = []string{"events/", "*.sqlite"}
	ts.publish()
	w.store.short[ts.key(manifest.FileName)] = 1
	w.p.noteShared(treeHost)
	if w.p.SharedHost() != treeHost {
		t.Fatal("a short read of the shared host's manifest made this folder miss that it is shared; Discover asks only once per host")
	}
}

// The two other ways a read the store did answer comes back broken. WHY (gate G1's second failure, CI run 41926097553 at aca22dd,
// reproduced under load as "pull from <peer>: unexpected EOF" in a round that ran beside another machine's): the body can end
// before its Content-Length (the connection drops part way; the client reads io.ErrUnexpectedEOF), or the store can answer 500
// InternalError, S3's "please try again". The stand-in does both while a PUT replaces the object (20 s, one writer, three
// readers: 283 cut, 622 busy and 681 short of about 166,000 GETs); a real network drops connections, and R2 and S3 document 500
// and 503 as answers to retry. Each failed the whole round, as the short read did before it was read again.

type brokenForm struct {
	name string
	set  func(s *memStore, key string, reads int)
	says string // in the error when every read breaks
}

var brokenForms = []brokenForm{
	{"short", func(s *memStore, key string, reads int) { s.short[key] = reads }, "not valid JSON"},
	{"cut in transit", func(s *memStore, key string, reads int) { s.cut[key] = reads }, "unexpected EOF"},
	{"the store says try again", func(s *memStore, key string, reads int) { s.busy[key] = reads }, "500 Internal Server Error"},
}

func brokenLeft(s *memStore, key string) int { return s.short[key] + s.cut[key] + s.busy[key] }

func TestAPeerManifestReadThatBreaksOnceIsReadAgain(t *testing.T) {
	for _, form := range brokenForms {
		t.Run(form.name, func(t *testing.T) {
			noPause(t)
			w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), nil)
			plantPeer(w, 1, "a.md", "b.md")
			form.set(w.store, peerManifestKey(), 1)
			if err := w.p.savePeers(PeerState{Known: []string{readPeer}, ETags: map[string]string{}}); err != nil {
				t.Fatal(err)
			}
			var result Result
			if err := w.p.Pull(t.Context(), &result); err != nil {
				t.Fatalf("one broken read of a peer's manifest must not fail the pull: %v", err)
			}
			if len(result.Peers) != 1 || result.Peers[0].Files != 2 || result.Peers[0].Seq != 1 {
				t.Fatalf("the pull should have taken the whole manifest on the next read: %+v", result.Peers)
			}
			if left := brokenLeft(w.store, peerManifestKey()); left != 0 {
				t.Fatalf("the broken read was never served (%d left)", left)
			}
		})
	}
}

func TestAPeerManifestReadThatKeepsBreakingChangesNothing(t *testing.T) {
	for _, form := range brokenForms {
		t.Run(form.name, func(t *testing.T) {
			noPause(t)
			w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), nil)
			plantPeer(w, 1, "a.md")
			if err := w.p.savePeers(PeerState{Known: []string{readPeer}, ETags: map[string]string{}}); err != nil {
				t.Fatal(err)
			}
			var first Result
			if err := w.p.Pull(t.Context(), &first); err != nil {
				t.Fatal(err)
			}
			copyPath := filepath.Join(w.folder, "hosts", readPeer, "a.md")
			if err := os.MkdirAll(filepath.Dir(copyPath), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(copyPath, []byte("aaaaaaaaa\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			etagBefore := w.p.loadPeers().ETags[readPeer]

			// the peer publishes seq 2 with no files; every read of it breaks
			plantPeer(w, 2)
			form.set(w.store, peerManifestKey(), 1000)
			var second Result
			err := w.p.Pull(t.Context(), &second)
			if err == nil || !strings.Contains(err.Error(), form.says) {
				t.Fatalf("a manifest that never reads whole is an error that says why (%q), got %v", form.says, err)
			}
			if _, statErr := os.Stat(copyPath); statErr != nil {
				t.Fatalf("a broken manifest read must not remove the peer's file from this machine: %v", statErr)
			}
			if got := w.p.loadPeers().ETags[readPeer]; got != etagBefore {
				t.Fatalf("a broken read must not move the remembered ETag: %q -> %q", etagBefore, got)
			}
			cached, _, loadErr := manifest.Load(w.p.peerManifestPath(readPeer))
			if loadErr != nil || cached.Seq != 1 || len(cached.Files) != 1 {
				t.Fatalf("the remembered manifest stays seq 1: %+v (%v)", cached, loadErr)
			}

			// the next round reads it whole and carries on
			form.set(w.store, peerManifestKey(), 0)
			var third Result
			if err := w.p.Pull(t.Context(), &third); err != nil {
				t.Fatalf("the round after the broken reads: %v", err)
			}
			if _, statErr := os.Stat(copyPath); !os.IsNotExist(statErr) {
				t.Fatalf("seq 2 has no a.md, so its copy goes (%v)", statErr)
			}
		})
	}
}

func TestASharedHostWhoseManifestReadBreaksIsStillFound(t *testing.T) {
	for _, form := range brokenForms {
		t.Run(form.name, func(t *testing.T) {
			noPause(t)
			w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), nil)
			ts := newTreeServer(t, w.store, func() time.Time { return w.clock })
			ts.private = []string{"events/", "*.sqlite"}
			ts.publish()
			form.set(w.store, ts.key(manifest.FileName), 1)
			w.p.noteShared(treeHost)
			if w.p.SharedHost() != treeHost {
				t.Fatal("a broken read of the shared host's manifest made this folder miss that it is shared; Discover asks only once per host")
			}
		})
	}
}

// Only a broken answer is read again. WHY: an answer the store meant (403, any 4xx) is not transient, and a store that cannot
// be reached is offline, which `sync --watch` must show in seconds (rclone.FailFast), not after a pause per peer.
func TestAManifestReadTheStoreRefusedOrNeverGotIsReadOnce(t *testing.T) {
	was := manifestRetryPause
	manifestRetryPause = 10 * time.Second // a read again would sleep this long first; WHY 10 s: on Windows one refused dial takes about 2 s
	t.Cleanup(func() { manifestRetryPause = was })

	var reads atomic.Int32
	refusing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		w.WriteHeader(http.StatusForbidden)
		io.WriteString(w, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>`)
	}))
	t.Cleanup(refusing.Close)
	client := &s3.Client{Endpoint: refusing.URL, Region: "auto", AccessKeyID: "key", SecretAccessKey: "secret"}
	if _, _, err := getManifest(client, "bkt", "demo/hosts/x/manifest.json", ""); err == nil || reads.Load() != 1 {
		t.Fatalf("a 403 is read once and is an error: %d reads, %v", reads.Load(), err)
	}

	gone := httptest.NewServer(http.NotFoundHandler())
	gone.Close() // nothing listens on its address now
	client = &s3.Client{Endpoint: gone.URL, Region: "auto", AccessKeyID: "key", SecretAccessKey: "secret"}
	started := time.Now()
	if _, _, err := getManifest(client, "bkt", "demo/hosts/x/manifest.json", ""); err == nil {
		t.Fatal("a store nothing answers for is an error")
	}
	if took := time.Since(started); took >= manifestRetryPause {
		t.Fatalf("an offline read was read again (%s): offline must fail at once", took)
	}
}
