package syncer

import (
	"os"
	"path/filepath"
	"strings"

	"folder-sync/internal/manifest"
)

// disk is the part of the filesystem adoptCaseRenames asks about, so a test can pose as a case-insensitive one.
type disk struct {
	exists func(path string) bool    // the path opens (under any spelling the disk folds to it)
	names  func(dir string) []string // the names in dir exactly as the disk spells them
	rename func(from, to string) error
}

var osDisk = disk{
	exists: func(path string) bool { _, err := os.Stat(path); return err == nil },
	names: func(dir string) []string {
		entries, _ := os.ReadDir(dir)
		out := make([]string, len(entries))
		for i, entry := range entries {
			out[i] = entry.Name()
		}
		return out
	},
	rename: os.Rename,
}

func has(list []string, name string) bool {
	for _, item := range list {
		if item == name {
			return true
		}
	}
	return false
}

// adoptCaseRenames handles a peer renaming a file (or a folder above it) only by letter case: Report.md to report.md.
//
// WHY: on a case-insensitive disk (Windows, macOS) the new name already opens the old file, so the pull keeps it as
// "present" and then its removal pass deletes the OLD name, which is the only copy: the file is gone (macOS CI,
// 2026-10-29: "0 fetched, 1 removed", an empty folder). Where a disk folds the two spellings, the file is renamed to the
// new spelling and the old index entry moves to the new path, so the pull compares content (and local edits) as it would
// for any file. Where it does not (Linux), they are two files and the normal fetch-and-remove is right, so nothing is done.
// oldIndex is edited in place.
func adoptCaseRenames(d disk, localRoot string, oldIndex map[string]manifest.Entry, files []manifest.Entry) error {
	inNew := map[string]int{} // new paths by lower-case: more than one is a twin pair, not a rename
	exact := map[string]bool{}
	for _, f := range files {
		inNew[strings.ToLower(f.Path)]++
		exact[f.Path] = true
	}
	oldByFold := map[string][]string{}
	for path := range oldIndex {
		if !exact[path] {
			oldByFold[strings.ToLower(path)] = append(oldByFold[strings.ToLower(path)], path)
		}
	}
	for _, f := range files {
		if _, known := oldIndex[f.Path]; known || inNew[strings.ToLower(f.Path)] != 1 {
			continue
		}
		olds := oldByFold[strings.ToLower(f.Path)]
		if len(olds) != 1 {
			continue
		}
		oldPath := olds[0]
		if !foldedOnDisk(d, localRoot, oldPath, f.Path) {
			continue
		}
		oldParts, newParts := strings.Split(oldPath, "/"), strings.Split(f.Path, "/")
		last := len(oldParts) - 1
		if oldParts[last] != newParts[last] {
			dir := filepath.Join(append([]string{localRoot}, oldParts[:last]...)...)
			if err := d.rename(filepath.Join(dir, oldParts[last]), filepath.Join(dir, newParts[last])); err != nil {
				return err
			}
		}
		renamed := oldIndex[oldPath]
		renamed.Path = f.Path
		oldIndex[f.Path] = renamed
		delete(oldIndex, oldPath)
	}
	return nil
}

// foldedOnDisk reports whether oldPath and newPath (slash-separated, same except for letter case) are one file here:
// the file exists, and at every component that differs the disk lists the old spelling and not the new one. On a
// case-sensitive disk the new spelling is either absent (nothing opens) or listed beside the old (two files).
func foldedOnDisk(d disk, localRoot, oldPath, newPath string) bool {
	oldParts, newParts := strings.Split(oldPath, "/"), strings.Split(newPath, "/")
	if len(oldParts) != len(newParts) || !d.exists(filepath.Join(append([]string{localRoot}, newParts...)...)) {
		return false
	}
	dir := localRoot
	for i := range oldParts {
		if oldParts[i] != newParts[i] {
			listed := d.names(dir)
			if !has(listed, oldParts[i]) || has(listed, newParts[i]) {
				return false
			}
		}
		dir = filepath.Join(dir, oldParts[i])
	}
	return true
}
