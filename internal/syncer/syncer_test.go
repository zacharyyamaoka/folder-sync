package syncer

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"folder-sync/internal/config"
	"folder-sync/internal/layout"
)

func testLayout(t *testing.T) layout.Layout {
	home := t.TempDir()
	l, err := layout.For("linux", func(k string) string { return map[string]string{"HOME": home}[k] })
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range l.Dirs() {
		os.MkdirAll(dir, 0o700)
	}
	return l
}

func TestStateKeySeparatesClones(t *testing.T) {
	a, b := StateKey("demo", "/home/bam/demo", ""), StateKey("demo", "/home/bam/demo-copy", "")
	if a == b || !strings.HasPrefix(a, "demo-") || len(a) != len("demo-")+8 {
		t.Fatalf("%s %s", a, b)
	}
}

func TestOneFolderPerProjectPerMachine(t *testing.T) {
	l := testLayout(t)
	first, second := t.TempDir(), t.TempDir()
	for _, folder := range []string{first, second} {
		config.Write(folder, config.New("demo", "folder-sync"))
	}
	reg := func(folder string) error {
		return EnsureRegistered(l, filepath.Join(l.Projects, StateKey("demo", folder, "")),
			Registration{Project: "demo", Bucket: "folder-sync", Folder: folder, HostID: "h"})
	}
	if err := reg(first); err != nil {
		t.Fatal(err)
	}
	if err := reg(first); err != nil {
		t.Fatalf("registering the same folder again: %v", err)
	}
	if err := reg(second); err == nil || !strings.Contains(err.Error(), "already synced on this machine") {
		t.Fatalf("a second folder for the same project must be refused: %v", err)
	}
	// Once the first folder is gone, the project can move.
	os.Remove(filepath.Join(first, config.FileName))
	if err := reg(second); err != nil {
		t.Fatal(err)
	}
}

func TestReconcileAndDiscoverCadence(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	fresh := now.Add(-2 * time.Minute).Format(time.RFC3339Nano)
	old := now.Add(-61 * time.Minute).Format(time.RFC3339Nano)
	if !ReconcileDue(LastSync{}, now) || ReconcileDue(LastSync{LastReconcile: fresh}, now) || !ReconcileDue(LastSync{LastReconcile: old}, now) {
		t.Fatal("reconcile: at start (no state) and hourly")
	}
	if due(fresh, DiscoverEvery, now) || !due(now.Add(-6*time.Minute).Format(time.RFC3339Nano), DiscoverEvery, now) {
		t.Fatal("peer discovery every 5 minutes")
	}
}

func TestSameTime(t *testing.T) {
	if !sameTime("2026-10-20T22:00:00.5Z", "2026-10-20T15:00:00.500000000-07:00") || sameTime("2026-10-20T22:00:00Z", "2026-10-20T22:00:00.000000001Z") || sameTime("", "") {
		t.Fatal("sameTime compares instants at full precision")
	}
}

func TestLockIsExclusive(t *testing.T) {
	p := &Project{StateDir: t.TempDir()}
	lock, err := p.AcquireLock()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.AcquireLock(); !errors.Is(err, ErrBusy) || !strings.Contains(err.Error(), "another folder-sync round") {
		t.Fatalf("second lock: %v", err)
	}
	lock.Release()
	again, err := p.AcquireLock()
	if err != nil {
		t.Fatal(err)
	}
	again.Release()
	// A crashed holder's lock goes stale.
	os.WriteFile(filepath.Join(p.StateDir, "lock"), []byte("pid 1"), 0o600)
	past := time.Now().Add(-time.Hour)
	os.Chtimes(filepath.Join(p.StateDir, "lock"), past, past)
	if stale, err := p.AcquireLock(); err != nil {
		t.Fatalf("stale lock: %v", err)
	} else {
		stale.Release()
	}
}
