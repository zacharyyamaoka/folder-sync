package syncer

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"folder-sync/internal/config"
	"folder-sync/internal/host"
	"folder-sync/internal/rclone"
)

// A fake rclone: `lsjson` reports one local file, `copy` succeeds, and `copyto` (the manifest
// publish) writes a marker the moment the object is in the bucket, then lingers like rclone's
// post-upload HEAD and exit do.
const fakeRclone = `#!/bin/sh
case "$1" in
  lsjson) echo '[{"Path":"a.md","Size":3,"ModTime":"2026-10-01T10:00:00Z","IsDir":false}]' ;;
  copyto) touch "$FAKE_PUT_DONE"; exec sleep 1 ;;
esac
`

// TestStopDuringTheManifestPublishStillCommitsIt: SIGTERM cancels the round's context. If that
// kills rclone after the manifest PUT but before the local state is saved, the next round
// finds the same files "changed" and PUTs a second manifest (seq + 1) that no peer needed.
// WHY it matters: peers' conditional GETs answer 200 instead of 304 and the request-cost
// contract (a no-change round is one conditional GET) breaks, which the e2e suite caught as a
// flaky "second round with no changes".
func TestStopDuringTheManifestPublishStillCommitsIt(t *testing.T) {
	root := t.TempDir()
	fake := filepath.Join(root, "rclone")
	if err := os.WriteFile(fake, []byte(fakeRclone), 0o755); err != nil {
		t.Skip("cannot write a fake rclone here:", err)
	}
	putDone := filepath.Join(root, "put-done")
	t.Setenv("FAKE_PUT_DONE", putDone)
	l := testLayout(t)
	p := &Project{
		Folder:   filepath.Join(root, "folder"),
		Config:   config.New("demo", "bkt"),
		Layout:   l,
		Host:     host.Host{ID: "7d4aad79-573d-4137-8641-77208820afd5", Name: "a"},
		StateDir: filepath.Join(root, "state"),
		Out:      io.Discard,
		Now:      time.Now,
	}
	p.Rclone = rclone.Runner{Bin: fake, Layout: l}
	os.MkdirAll(p.Folder, 0o755)
	os.WriteFile(filepath.Join(p.Folder, "a.md"), []byte("abc"), 0o644)
	os.Chtimes(filepath.Join(p.Folder, "a.md"), time.Date(2026, 10, 1, 10, 0, 0, 0, time.UTC), time.Date(2026, 10, 1, 10, 0, 0, 0, time.UTC))

	ctx, stop := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		var result Result
		done <- p.Push(ctx, "20261001T100000Z", &result)
	}()
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		if _, err := os.Stat(putDone); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the fake manifest PUT never started")
		}
	}
	stop() // the signal arrives while rclone is still finishing the publish
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("Push did not return after the stop")
	}
	committed, err := p.ownManifest()
	if err != nil {
		t.Fatal(err)
	}
	if len(committed.Files) != 1 || committed.Files[0].Path != "a.md" || committed.Seq != 1 {
		t.Errorf("the published manifest was not committed locally: %+v", committed)
	}
	if _, err := os.Stat(p.statePath("manifest.pending.json")); err == nil {
		t.Error("manifest.pending.json is left behind")
	}
}
