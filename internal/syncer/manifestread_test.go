package syncer

// A manifest read that comes back short (the first half of the bytes, correctly framed, 200) must be read again, never acted on.
// WHY (gate G1, the soak's one unexplained failure: "manifest is not valid JSON: unexpected end of JSON input" beside "Unsolicited
// response received on idle HTTP channel", from the rclone serve s3 stand-in): real S3 and R2 replace an object atomically, but a
// store that serves an object while it is being replaced can answer with part of it. The engine never treated such a body as a
// state (manifest.Parse refuses it), yet one short read failed the whole round, and Discover's noteShared dropped it silently, so a
// shared folder met at that moment was never recognised as shared.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"folder-sync/internal/manifest"
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
