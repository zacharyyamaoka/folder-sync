package names

import (
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"folder-sync/internal/testtools"
)

func TestCheckRelative(t *testing.T) {
	for _, ok := range []string{"a", "notes/a.md", ".env.example", "a/b/c d.txt", "日本/ファイル.md"} {
		if err := CheckRelative(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "/etc/passwd", "../x", "a/../b", "a/./b", "a//b", "a/", `a\b`, `C:\x`, "C:/x", "c:x", "a\x00b"} {
		if err := CheckRelative(bad); err == nil {
			t.Errorf("%q passed", bad)
		}
	}
}

func TestCheckWindows(t *testing.T) {
	for _, ok := range []string{"console.md", "CONFIG", "com10.txt", "lpt.md", "notes/aux-notes.md", "a b/c.txt", "conn.txt", "x.CON"} {
		if err := CheckWindows(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{
		"CON", "con.txt", "a/aux.md", "LPT1", "nul.tar.gz", "COM¹.log", "PRN ",
		"a:b.md", "what?.md", "star*.txt", `quote".txt`, "pipe|.txt", "lt<.md", "gt>.md",
		"trail.", "dir./x", "trail ", "tab\there",
	} {
		if err := CheckWindows(bad); err == nil {
			t.Errorf("%q passed", bad)
		}
	}
}

func TestCaseTwins(t *testing.T) {
	got := CaseTwins([]string{"README.md", "readme.md", "a.md", "Docs/x.md", "docs/x.md", "docs/y.md", "ReadMe.MD"})
	want := [][]string{{"Docs/x.md", "docs/x.md"}, {"README.md", "ReadMe.MD", "readme.md"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestLint(t *testing.T) {
	ok, skipped := Lint(
		[]string{"a.md", "README.md", "readme.md", "CON.txt", "manifest.json", "notes/manifest.json"},
		map[string]string{"manifest.json": "reserved"},
	)
	if !reflect.DeepEqual(ok, []string{"a.md", "notes/manifest.json"}) {
		t.Fatalf("ok = %q", ok)
	}
	var paths []string
	for _, s := range skipped {
		paths = append(paths, s.Path)
		if s.Reason == "" {
			t.Errorf("%s has no reason", s.Path)
		}
	}
	if !reflect.DeepEqual(paths, []string{"README.md", "readme.md", "CON.txt", "manifest.json"}) {
		t.Fatalf("skipped = %q", paths)
	}
}

// TestEveryTrackedPathChecksOutOnWindows: git cannot create a file with a ':' (or a reserved device name, or a trailing
// dot) on Windows, so such a path in the repo breaks `git clone` there, before any test runs (a fixture named after an
// RFC 3339 time did exactly that, 2026-10-29). The rule is internal/names' own CheckWindows, the one the sync applies.
func TestEveryTrackedPathChecksOutOnWindows(t *testing.T) {
	_, here, _, _ := runtime.Caller(0)
	repo := filepath.Join(filepath.Dir(here), "..", "..")
	cmd := exec.Command("git", "ls-files", "-z")
	cmd.Dir = repo
	out, err := cmd.Output()
	if err != nil {
		testtools.Missing(t, "git ls-files: %v", err)
	}
	var paths []string
	for _, p := range strings.Split(string(out), "\x00") {
		if p != "" {
			paths = append(paths, p)
		}
	}
	if len(paths) < 100 {
		t.Fatalf("git ls-files listed only %d paths: is this a checkout?", len(paths))
	}
	for _, p := range paths {
		if err := CheckWindows(p); err != nil {
			t.Errorf("tracked path cannot be checked out on Windows: %v", err)
		}
	}
	for _, group := range CaseTwins(paths) {
		t.Errorf("tracked paths differ only by case, so one is lost on Windows and macOS: %v", group)
	}
}
