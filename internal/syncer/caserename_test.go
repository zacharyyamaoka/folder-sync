package syncer

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"folder-sync/internal/manifest"
)

// foldedDisk poses as a case-insensitive, case-preserving filesystem (NTFS, APFS): Report.md and report.md are one
// file, and a listing gives the spelling it was created with. Keys are the lower-cased slash path of each file; values
// are its actual spelling.
type foldedDisk map[string]string

func (d foldedDisk) disk() disk {
	return disk{
		exists: func(p string) bool {
			p = strings.ToLower(filepath.ToSlash(p))
			for lower := range d {
				if lower == p || strings.HasPrefix(lower, p+"/") {
					return true
				}
			}
			return false
		},
		names: func(dir string) []string {
			dir = strings.ToLower(filepath.ToSlash(dir))
			seen := map[string]bool{}
			var out []string
			for lower, actual := range d {
				if rest, ok := strings.CutPrefix(lower, dir+"/"); ok && rest != "" {
					depth := strings.Count(dir, "/") + 1
					name := strings.Split(actual, "/")[depth]
					if !seen[name] {
						seen[name] = true
						out = append(out, name)
					}
				}
			}
			sort.Strings(out)
			return out
		},
		rename: func(from, to string) error {
			from, to = filepath.ToSlash(from), filepath.ToSlash(to)
			if actual, ok := d[strings.ToLower(from)]; !ok || actual != from {
				return fmt.Errorf("rename %s: no such file", from)
			}
			delete(d, strings.ToLower(from))
			d[strings.ToLower(to)] = to
			return nil
		},
	}
}

// sensitiveDisk poses as ext4: names are exact. Keys are the slash paths of the files.
type sensitiveDisk map[string]bool

func (d sensitiveDisk) disk() disk {
	return disk{
		exists: func(p string) bool {
			p = filepath.ToSlash(p)
			for file := range d {
				if file == p || strings.HasPrefix(file, p+"/") {
					return true
				}
			}
			return false
		},
		names: func(dir string) []string {
			dir = filepath.ToSlash(dir)
			seen := map[string]bool{}
			var out []string
			for file := range d {
				if rest, ok := strings.CutPrefix(file, dir+"/"); ok {
					name, _, _ := strings.Cut(rest, "/")
					if !seen[name] {
						seen[name] = true
						out = append(out, name)
					}
				}
			}
			sort.Strings(out)
			return out
		},
		rename: func(from, to string) error {
			panic("a case-sensitive disk has nothing to rename: the two spellings are two files")
		},
	}
}

func entries(paths ...string) []manifest.Entry {
	var out []manifest.Entry
	for _, p := range paths {
		out = append(out, manifest.Entry{Path: p, SHA256: strings.Repeat("a", 64)})
	}
	return out
}

// A peer renames Report.md to report.md. On a case-insensitive disk the pull used to see the new name already "there"
// (it is the same file), keep it, and then remove the OLD name: which deleted the only copy. macOS CI, 2026-10-29:
// "pull: 0 fetched, 1 removed", and the folder was empty.
func TestACaseOnlyRenameOnAFoldedDiskRenamesTheFileInsteadOfDeletingIt(t *testing.T) {
	d := foldedDisk{"/peer/rename/report.md": "/peer/rename/Report.md"}
	oldIndex := manifest.Manifest{Files: entries("rename/Report.md", "keep.md")}.Index()
	if err := adoptCaseRenames(d.disk(), "/peer", oldIndex, entries("rename/report.md", "keep.md")); err != nil {
		t.Fatal(err)
	}
	if got := d["/peer/rename/report.md"]; got != "/peer/rename/report.md" {
		t.Errorf("the file is spelled %q on disk, want the new spelling", got)
	}
	if _, stale := oldIndex["rename/Report.md"]; stale {
		t.Error("the old spelling is still in the old index, so the removal pass would delete the file by that name")
	}
	if _, ok := oldIndex["rename/report.md"]; !ok {
		t.Error("the old entry must move to the new spelling, so the pull still knows what the file held")
	}
	if _, ok := oldIndex["keep.md"]; !ok {
		t.Error("an unrelated entry was touched")
	}
}

// On a case-sensitive disk they are two files: the pull fetches the new one and removes the old one, as before.
func TestACaseOnlyRenameOnACaseSensitiveDiskIsLeftToTheNormalPull(t *testing.T) {
	d := sensitiveDisk{"/peer/rename/Report.md": true}
	oldIndex := manifest.Manifest{Files: entries("rename/Report.md")}.Index()
	if err := adoptCaseRenames(d.disk(), "/peer", oldIndex, entries("rename/report.md")); err != nil {
		t.Fatal(err)
	}
	if _, ok := oldIndex["rename/Report.md"]; !ok || len(oldIndex) != 1 {
		t.Errorf("the old index must be left alone: %v", oldIndex)
	}
}

// A path that exists under both spellings in the new manifest is not a rename (the push lints twins, but a peer might not).
func TestTwoSpellingsInTheNewManifestAreNotARename(t *testing.T) {
	d := foldedDisk{"/peer/a.md": "/peer/A.md"}
	oldIndex := manifest.Manifest{Files: entries("A.md")}.Index()
	if err := adoptCaseRenames(d.disk(), "/peer", oldIndex, entries("A.md", "a.md")); err != nil {
		t.Fatal(err)
	}
	if _, ok := oldIndex["A.md"]; !ok {
		t.Errorf("A.md is still listed, so it is not renamed: %v", oldIndex)
	}
}

// Renaming a FOLDER by case ("Notes" to "notes") leaves its files at the same paths but for the folder's spelling: the disk
// opens them under either, so each is adopted under its new path (nothing to rename), and none is removed as "gone".
func TestACaseOnlyRenameOfAFolderOnAFoldedDiskKeepsItsFiles(t *testing.T) {
	d := foldedDisk{"/peer/notes/x.md": "/peer/Notes/x.md", "/peer/notes/sub/y.md": "/peer/Notes/sub/y.md"}
	oldIndex := manifest.Manifest{Files: entries("Notes/x.md", "Notes/sub/y.md")}.Index()
	if err := adoptCaseRenames(d.disk(), "/peer", oldIndex, entries("notes/x.md", "notes/sub/y.md")); err != nil {
		t.Fatal(err)
	}
	for _, adopted := range []string{"notes/x.md", "notes/sub/y.md"} {
		if oldIndex[adopted].Path != adopted {
			t.Errorf("%s should be listed under the new spelling: %v", adopted, oldIndex)
		}
	}
	for _, old := range []string{"Notes/x.md", "Notes/sub/y.md"} {
		if _, stale := oldIndex[old]; stale {
			t.Errorf("%s is still in the old index: the removal pass would delete the file", old)
		}
	}
}

// The same names on a case-sensitive disk are two folders: nothing is adopted.
func TestTwoFoldersThatDifferByCaseOnACaseSensitiveDiskAreNotAdopted(t *testing.T) {
	d := sensitiveDisk{"/peer/Notes/x.md": true, "/peer/notes/x.md": true}
	oldIndex := manifest.Manifest{Files: entries("Notes/x.md")}.Index()
	if err := adoptCaseRenames(d.disk(), "/peer", oldIndex, entries("notes/x.md")); err != nil {
		t.Fatal(err)
	}
	if _, ok := oldIndex["Notes/x.md"]; !ok || len(oldIndex) != 1 {
		t.Errorf("the old index must be left alone: %v", oldIndex)
	}
}
