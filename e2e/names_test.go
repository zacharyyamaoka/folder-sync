package e2e

// Gate G9, the names half: a file's name is its bytes (docs/CONTRACT.md "Object keys are the file's path ... byte for byte").
// Unicode has two spellings of an accented e (NFC: one code point; NFD: e + a combining accent). macOS Finder and some apps write
// NFD, Windows and most Linux tools NFC, so one logical file meets both across a person's machines. The rule these tests
// pin: the engine never rewrites a name and never merges two names that differ only in normalization, so a file lands
// under the spelling its writer used, exactly once, with its own content. (rclone's default, `--no-unicode-normalization`
// off, merges them: its copy keeps one of two names and logs "Duplicate object found in source - ignoring", so the manifest
// named an object the bucket lacked.)

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"
)

const (
	cafeNFC = "caf\u00e9.txt"
	cafeNFD = "cafe\u0301.txt"
)

// namesIn lists the entries of dir exactly as the file system reports them.
func namesIn(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names
}

func keysUnder(w *world, prefix string) []string {
	var keys []string
	for _, key := range w.objects(prefix) {
		keys = append(keys, strings.TrimPrefix(key, prefix))
	}
	return keys
}

// TestNormalizationOneFileTwoSpellings: A saves unicode/cafe.txt with an accented e as NFC, B saves "the same" name as NFD. Each lands on
// the other under the spelling its writer used, once, with the writer's content; the bucket holds one object per host.
func TestNormalizationOneFileTwoSpellings(t *testing.T) {
	w, a, b := historyWorld(t)
	idA, idB := hostID(t, a), hostID(t, b)
	writeFile(t, filepath.Join(a.folder, "unicode", cafeNFC), "written on A, NFC\n", time.Time{})
	writeFile(t, filepath.Join(b.folder, "unicode", cafeNFD), "written on B, NFD\n", time.Time{})
	w.must(a, "sync", "--once")
	w.must(b, "sync", "--once")
	w.must(a, "sync", "--once", "--discover") // A learns of B (B joined after A's first round)
	w.must(b, "sync", "--once")
	if got := keysUnder(w, project+"/hosts/"+idA+"/unicode/"); len(got) != 1 || got[0] != cafeNFC {
		t.Errorf("A's bucket folder holds %q, want exactly [%q]", got, cafeNFC)
	}
	if got := keysUnder(w, project+"/hosts/"+idB+"/unicode/"); len(got) != 1 || got[0] != cafeNFD {
		t.Errorf("B's bucket folder holds %q, want exactly [%q]", got, cafeNFD)
	}
	if got := namesIn(t, filepath.Join(b.folder, "hosts", idA, "unicode")); len(got) != 1 || got[0] != cafeNFC {
		t.Errorf("B's copy of A's folder holds %q, want exactly [%q]", got, cafeNFC)
	}
	if got := namesIn(t, filepath.Join(a.folder, "hosts", idB, "unicode")); len(got) != 1 || got[0] != cafeNFD {
		t.Errorf("A's copy of B's folder holds %q, want exactly [%q]", got, cafeNFD)
	}
	if data, _ := os.ReadFile(filepath.Join(b.folder, "hosts", idA, "unicode", cafeNFC)); string(data) != "written on A, NFC\n" {
		t.Errorf("B's copy of A's file: %q", data)
	}
	if data, _ := os.ReadFile(filepath.Join(a.folder, "hosts", idB, "unicode", cafeNFD)); string(data) != "written on B, NFD\n" {
		t.Errorf("A's copy of B's file: %q", data)
	}

	// WHY a folder holding both: the phases above give each machine one spelling, which rclone's default (folding names
	// to NFC) also gets right. The loss was a single folder holding both, where the default keeps one name and logs
	// "Duplicate object found in source - ignoring" (mutation-tested: without --no-unicode-normalization this phase is red).
	t.Run("one folder holding both spellings", func(t *testing.T) {
		if runtime.GOOS == "darwin" {
			t.Skip("APFS folds NFC and NFD into one name, so a folder cannot hold both there")
		}
		writeFile(t, filepath.Join(a.folder, "unicode-both", cafeNFC), "NFC bytes\n", time.Time{})
		writeFile(t, filepath.Join(a.folder, "unicode-both", cafeNFD), "NFD bytes\n", time.Time{})
		w.must(a, "sync", "--once")
		w.must(b, "sync", "--once")
		assertBothSpellings(t, w, idA, b)
	})
}

// assertBothSpellings checks that host idA's "unicode-both" folder holds NFC and NFD as two objects, each with its own
// bytes, in the bucket and in b's copy.
func assertBothSpellings(t *testing.T, w *world, idA string, b *machine) {
	t.Helper()
	prefix := project + "/hosts/" + idA + "/unicode-both/"
	if got := keysUnder(w, prefix); len(got) != 2 {
		t.Fatalf("the bucket folder holds %q, want both %q and %q as two objects", got, cafeNFC, cafeNFD)
	}
	for name, want := range map[string]string{cafeNFC: "NFC bytes\n", cafeNFD: "NFD bytes\n"} {
		if got, ok := w.object(prefix + name); !ok || got != want {
			t.Errorf("bucket object %q = %q (found %v), want %q", name, got, ok, want)
		}
		if data, _ := os.ReadFile(filepath.Join(b.folder, "hosts", idA, "unicode-both", name)); string(data) != want {
			t.Errorf("B's copy of %q = %q, want %q", name, data, want)
		}
	}
	if got := namesIn(t, filepath.Join(b.folder, "hosts", idA, "unicode-both")); len(got) != 2 {
		t.Errorf("B's copy of the folder holds %q, want both spellings", got)
	}
}

// TestNormalizationRespelledFileKeepsItsBytes: an app re-saves A's file under the other spelling (same bytes). The round
// that sees it uploads the new name and removes the old one; the file is never lost and never in the bucket twice.
func TestNormalizationRespelledFileKeepsItsBytes(t *testing.T) {
	if runtime.GOOS == "darwin" {
		t.Skip("APFS treats NFC and NFD as one name, so renaming one to the other changes nothing there")
	}
	w, a, b := historyWorld(t)
	idA := hostID(t, a)
	folder := filepath.Join(a.folder, "unicode")
	writeFile(t, filepath.Join(folder, cafeNFC), "the same bytes\n", time.Time{})
	w.must(a, "sync", "--once")
	w.must(b, "sync", "--once")
	if err := os.Rename(filepath.Join(folder, cafeNFC), filepath.Join(folder, cafeNFD)); err != nil {
		t.Fatal(err)
	}
	w.must(a, "sync", "--once")
	w.must(b, "sync", "--once")
	prefix := project + "/hosts/" + idA + "/unicode/"
	if got := keysUnder(w, prefix); len(got) != 1 || got[0] != cafeNFD {
		t.Fatalf("A's bucket folder holds %q after the respelling, want exactly [%q]", got, cafeNFD)
	}
	if got, _ := w.object(prefix + cafeNFD); got != "the same bytes\n" {
		t.Errorf("the respelled object holds %q", got)
	}
	if got := namesIn(t, filepath.Join(b.folder, "hosts", idA, "unicode")); len(got) != 1 || got[0] != cafeNFD {
		t.Errorf("B's copy holds %q after the respelling, want exactly [%q]", got, cafeNFD)
	}
	if data, _ := os.ReadFile(filepath.Join(b.folder, "hosts", idA, "unicode", cafeNFD)); string(data) != "the same bytes\n" {
		t.Errorf("B's copy of the respelled file: %q", data)
	}

	// WHY a second file under the old spelling: the respelling alone never sat beside its old name, so it passes with
	// rclone's default too. An app re-saves under NFD and another tool recreates the old NFC name: the folder now holds
	// both, and each must land with its own bytes (mutation-tested: without --no-unicode-normalization this part is red).
	both := filepath.Join(a.folder, "unicode-both")
	writeFile(t, filepath.Join(both, cafeNFC), "old bytes\n", time.Time{})
	w.must(a, "sync", "--once")
	w.must(b, "sync", "--once")
	if err := os.Rename(filepath.Join(both, cafeNFC), filepath.Join(both, cafeNFD)); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(both, cafeNFD), "NFD bytes\n", time.Time{})
	writeFile(t, filepath.Join(both, cafeNFC), "NFC bytes\n", time.Time{})
	w.must(a, "sync", "--once")
	w.must(b, "sync", "--once")
	assertBothSpellings(t, w, idA, b)
}
