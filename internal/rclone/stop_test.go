package rclone

import (
	"context"
	"crypto/rand"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"folder-sync/internal/layout"
	"folder-sync/internal/testtools"
)

// A stop cuts rclone mid-fetch. rclone writes a fetch to <name>.<hash>.partial and renames it at the end; killed
// outright (SIGKILL, a cancelled exec.CommandContext's default) it leaves that file in the peer-copy folder, where
// the person sees it. Asked to stop (SIGTERM), rclone removes it before it exits. The pinned rclone is the oracle.
func TestACutFetchLeavesNoPartial(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no SIGTERM: a stop there is still a plain kill")
	}
	_, here, _, _ := runtime.Caller(0)
	bin := testtools.PinnedRclone(t, filepath.Join(filepath.Dir(here), "..", ".."))
	home := t.TempDir()
	l, err := layout.For(runtime.GOOS, func(key string) string { return map[string]string{"HOME": home}[key] })
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range l.Dirs() {
		os.MkdirAll(dir, 0o700)
	}
	src, dst := filepath.Join(home, "src"), filepath.Join(home, "hosts", "peer")
	os.MkdirAll(src, 0o755)
	os.MkdirAll(dst, 0o755)
	data := make([]byte, 4<<20)
	rand.Read(data)
	if err := os.WriteFile(filepath.Join(src, "big.bin"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	partials := func() []string {
		found, _ := filepath.Glob(filepath.Join(dst, "*.partial"))
		return found
	}

	r := Runner{Bin: bin, Layout: l}
	ctx, stop := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		// 4 MiB at 200 KiB/s: about 20 s, so the stop always lands mid-fetch
		_, err := r.Run(ctx, "copy", "--bwlimit", "200k", src, dst)
		done <- err
	}()
	for deadline := time.Now().Add(15 * time.Second); len(partials()) == 0; time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			stop()
			t.Fatal("rclone never started the fetch")
		}
	}
	stopped := time.Now()
	stop()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("the cut fetch reported success")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not return within 10 s of the stop")
	}
	if took := time.Since(stopped); took > 5*time.Second {
		t.Errorf("the stop took %s: SIGTERM then at most ~2 s before the kill", took)
	}
	if left := partials(); len(left) > 0 {
		names := make([]string, len(left))
		for i, p := range left {
			names[i] = filepath.Base(p)
		}
		t.Errorf("the stop left %s in the peer-copy folder", strings.Join(names, ", "))
	}
	if _, err := os.Stat(filepath.Join(dst, "big.bin")); err == nil {
		t.Error("the cut fetch left a whole big.bin: it was not cut")
	}
}
