package syncer

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// TestTwinGroupsFindNamesThatAreOneFileOnThisDisk poses as APFS with hard links: two names, one file. A real disk that folds
// NFC to NFD (or case) does the same thing: the second name opens the first one's file. Gate G9, names.
func TestTwinGroupsFindNamesThatAreOneFileOnThisDisk(t *testing.T) {
	root := t.TempDir()
	write := func(name, content string) {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("unicode/caf\u00e9.txt", "one file")
	if err := os.Link(filepath.Join(root, "unicode", "caf\u00e9.txt"), filepath.Join(root, "unicode", "cafe\u0301.txt")); err != nil {
		t.Skipf("no hard links here: %v", err)
	}
	write("unicode/other.txt", "another file")
	write("plain.txt", "plain")

	got := twinGroups(root, []string{"unicode/caf\u00e9.txt", "unicode/cafe\u0301.txt", "unicode/other.txt", "plain.txt", "gone.txt"})
	want := [][]string{{"unicode/cafe\u0301.txt", "unicode/caf\u00e9.txt"}} // byte order: "cafe" sorts before "caf\xc3"
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("twin groups = %q, want %q", got, want)
	}
	if got := twinGroups(root, []string{"unicode/other.txt", "plain.txt"}); len(got) != 0 {
		t.Errorf("two different files are not twins: %q", got)
	}
}
