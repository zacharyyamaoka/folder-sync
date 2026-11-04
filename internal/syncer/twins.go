package syncer

import (
	"os"
	"path/filepath"
	"sort"
)

// twinGroups answers which of paths (slash-separated, under root) are one file on this disk: names a file system folds
// together, such as "cafe" with an acute e written as NFC and as NFD on APFS or HFS+, or Report.md and report.md. Each group has two or more
// names, sorted; the groups are sorted by their first name. A path that is not there is not a twin.
//
// WHY (gate G9): names are bytes everywhere in the bucket (docs/CONTRACT.md), so a Linux peer can publish both spellings as
// two files. A disk that folds them keeps one file, holding whichever was written last, so neither name holds its own
// bytes. The pull refuses both with a reason, as the push refuses case-only twins, instead of showing the last writer's
// bytes under both names.
func twinGroups(root string, paths []string) [][]string {
	type seen struct {
		info os.FileInfo
		path string
	}
	var files []seen
	for _, path := range paths {
		if info, err := os.Stat(filepath.Join(root, filepath.FromSlash(path))); err == nil {
			files = append(files, seen{info, path})
		}
	}
	var groups [][]string
	used := make([]bool, len(files))
	for i := range files {
		if used[i] {
			continue
		}
		group := []string{files[i].path}
		for j := i + 1; j < len(files); j++ {
			if !used[j] && os.SameFile(files[i].info, files[j].info) {
				used[j] = true
				group = append(group, files[j].path)
			}
		}
		if len(group) > 1 {
			sort.Strings(group)
			groups = append(groups, group)
		}
	}
	sort.Slice(groups, func(i, j int) bool { return groups[i][0] < groups[j][0] })
	return groups
}

func setOf(paths []string) map[string]bool {
	set := make(map[string]bool, len(paths))
	for _, path := range paths {
		set[path] = true
	}
	return set
}
