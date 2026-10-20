// Package names lints relative file paths before they go to the bucket or land on disk.
//
// docs/peps/0001 "Safety rules": names are linted at push for case-only twins
// and Windows-reserved characters, which rclone would otherwise rewrite to
// look-alikes. Paths read from a peer's manifest are checked here too, so a
// manifest can never write outside the folder it lands in.
package names

import (
	"fmt"
	"sort"
	"strings"
)

// windowsReservedChars cannot appear in a Windows file name.
const windowsReservedChars = `<>:"|?*\`

// windowsReservedNames are device names, reserved with any extension (CON.txt too).
var windowsReservedNames = map[string]bool{
	"CON": true, "PRN": true, "AUX": true, "NUL": true,
	"COM1": true, "COM2": true, "COM3": true, "COM4": true, "COM5": true,
	"COM6": true, "COM7": true, "COM8": true, "COM9": true,
	"COM¹": true, "COM²": true, "COM³": true,
	"LPT1": true, "LPT2": true, "LPT3": true, "LPT4": true, "LPT5": true,
	"LPT6": true, "LPT7": true, "LPT8": true, "LPT9": true,
	"LPT¹": true, "LPT²": true, "LPT³": true,
}

// CheckRelative reports whether p is a safe slash-separated relative path:
// not empty, not absolute, no drive letter, no backslash, no "." or ".." segment.
func CheckRelative(p string) error {
	switch {
	case p == "":
		return fmt.Errorf("empty path")
	case strings.HasPrefix(p, "/"):
		return fmt.Errorf("%q is absolute", p)
	case strings.Contains(p, `\`):
		return fmt.Errorf("%q contains a backslash", p)
	case len(p) >= 2 && p[1] == ':':
		return fmt.Errorf("%q starts with a drive letter", p)
	case strings.ContainsRune(p, 0):
		return fmt.Errorf("%q contains a NUL byte", p)
	}
	for _, segment := range strings.Split(p, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return fmt.Errorf("%q has an empty, . or .. segment", p)
		}
	}
	return nil
}

// CheckWindows reports why the slash-separated relative path p cannot exist on Windows.
func CheckWindows(p string) error {
	for _, segment := range strings.Split(p, "/") {
		if i := strings.IndexAny(segment, windowsReservedChars); i >= 0 {
			return fmt.Errorf("%q: %q is reserved on Windows", p, segment[i:i+1])
		}
		for _, r := range segment {
			if r < 32 {
				return fmt.Errorf("%q: control character in a name", p)
			}
		}
		if strings.HasSuffix(segment, ".") || strings.HasSuffix(segment, " ") {
			return fmt.Errorf("%q: Windows drops a trailing dot or space from %q", p, segment)
		}
		base := segment
		if dot := strings.IndexByte(base, '.'); dot >= 0 {
			base = base[:dot]
		}
		if windowsReservedNames[strings.ToUpper(strings.TrimRight(base, " "))] {
			return fmt.Errorf("%q: %q is a reserved device name on Windows", p, segment)
		}
	}
	return nil
}

// CaseTwins groups paths that differ only by letter case (README.md beside readme.md).
// Each group is sorted; groups are sorted by their first member.
func CaseTwins(paths []string) [][]string {
	byFold := map[string][]string{}
	for _, p := range paths {
		key := strings.ToLower(p)
		byFold[key] = append(byFold[key], p)
	}
	var groups [][]string
	for _, group := range byFold {
		if len(group) > 1 {
			sort.Strings(group)
			groups = append(groups, group)
		}
	}
	sort.Slice(groups, func(i, j int) bool { return groups[i][0] < groups[j][0] })
	return groups
}

// Skipped is a path that was left out of a round, with the reason.
type Skipped struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

// Lint splits paths into those safe to sync everywhere and those skipped.
// reserved names (relative paths) are refused outright, e.g. the manifest's own key.
func Lint(paths []string, reserved map[string]string) (ok []string, skipped []Skipped) {
	bad := map[string]string{}
	for _, p := range paths {
		if why, isReserved := reserved[p]; isReserved {
			bad[p] = why
			continue
		}
		if err := CheckRelative(p); err != nil {
			bad[p] = err.Error()
			continue
		}
		if err := CheckWindows(p); err != nil {
			bad[p] = err.Error()
		}
	}
	for _, group := range CaseTwins(paths) {
		for _, p := range group {
			if _, already := bad[p]; !already {
				bad[p] = fmt.Sprintf("case-only twins %s cannot coexist on Windows or macOS", strings.Join(group, ", "))
			}
		}
	}
	for _, p := range paths {
		if why, isBad := bad[p]; isBad {
			why = strings.TrimPrefix(why, fmt.Sprintf("%q: ", p)) // the path is already in Path
			skipped = append(skipped, Skipped{Path: p, Reason: why})
		} else {
			ok = append(ok, p)
		}
	}
	return ok, skipped
}
