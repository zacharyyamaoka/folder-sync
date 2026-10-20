package names

import (
	"reflect"
	"testing"
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
