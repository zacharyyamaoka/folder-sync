package host

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestEnsureMintsOnceAndKeepsIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".folder-sync", "host.json")
	first, minted, err := Ensure(path)
	if err != nil || !minted || !IsID(first.ID) || first.Name == "" {
		t.Fatalf("%+v %v %v", first, minted, err)
	}
	second, minted, err := Ensure(path)
	if err != nil || minted || second.ID != first.ID {
		t.Fatalf("second Ensure changed the id: %+v %v %v", second, minted, err)
	}
}

func TestConcurrentFirstRunsAgree(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host.json")
	ids := make([]string, 8)
	var wg sync.WaitGroup
	for i := range ids {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if h, _, err := Ensure(path); err == nil {
				ids[i] = h.ID
			} else {
				t.Errorf("racer %d: %v", i, err)
			}
		}(i)
	}
	wg.Wait()
	for _, id := range ids {
		if id != ids[0] || id == "" {
			t.Fatalf("racing first runs minted different ids: %q", ids)
		}
	}
}

func TestCorruptHostFileIsNeverReminted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host.json")
	os.WriteFile(path, []byte("{broken"), 0o600)
	if _, _, err := Ensure(path); err == nil {
		t.Fatal("a corrupt host.json must stop, not silently become a new machine")
	}
}

func TestNewIDIsV4(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		id, err := NewID()
		if err != nil || !IsID(id) || seen[id] {
			t.Fatalf("%q %v", id, err)
		}
		seen[id] = true
	}
}
