package store_test

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"folder-sync/internal/s3"
	"folder-sync/internal/store"
	"folder-sync/internal/store/storetest"
)

func TestFileStoreConformance(t *testing.T) {
	root := t.TempDir()
	f := &store.FileStore{Root: root}
	storetest.Run(t, f, root, "p/", f.Capabilities())
}

func TestFileStoreCreateOnceIsAtomicAcrossWriters(t *testing.T) {
	f := &store.FileStore{Root: t.TempDir()}
	const writers = 16
	results := make(chan error, writers)
	for i := 0; i < writers; i++ {
		go func() {
			_, err := f.Put("", "k/once", []byte{byte(i)}, "", "*", "")
			results <- err
		}()
	}
	won := 0
	for i := 0; i < writers; i++ {
		if err := <-results; err == nil {
			won++
		} else if !errors.Is(err, s3.ErrPreconditionFailed) {
			t.Errorf("unexpected error: %v", err)
		}
	}
	if won != 1 {
		t.Errorf("%d writers created the object, want exactly 1", won)
	}
}

func TestFileStoreRefusesKeysOutsideItsRoot(t *testing.T) {
	root := t.TempDir()
	f := &store.FileStore{Root: filepath.Join(root, "hub")}
	os.MkdirAll(f.Root, 0o755)
	for _, key := range []string{"../escape", "a/../../escape", "/abs", "a//b", "", "a/./b", `a\b`} {
		if _, err := f.Put("", key, []byte("x"), "", "", ""); err == nil {
			t.Errorf("Put(%q) succeeded", key)
		}
	}
	if entries, _ := os.ReadDir(root); len(entries) != 1 {
		t.Errorf("something was written outside the hub: %v", entries)
	}
}

func TestFileStoreDoesNotCreateAMissingDirectory(t *testing.T) {
	// WHY: an unmounted NAS is a missing directory, and creating it would sync onto the local disk under the mount point
	missing := filepath.Join(t.TempDir(), "nas", "hub")
	f := &store.FileStore{Root: missing}
	if err := f.HeadBucket(""); err == nil {
		t.Fatal("HeadBucket of a missing directory succeeded")
	}
	if _, err := os.Stat(missing); err == nil {
		t.Fatal("the directory was created")
	}
}

func TestFileStoreListSkipsItsOwnTempFiles(t *testing.T) {
	f := &store.FileStore{Root: t.TempDir()}
	f.Put("", "a/b", []byte("x"), "", "", "")
	listed, _ := f.List("", "", "")
	for _, obj := range listed.Objects {
		if obj.Key != "a/b" {
			t.Errorf("listed %s", obj.Key)
		}
	}
}
