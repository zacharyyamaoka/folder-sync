package ignore

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"

	"folder-sync/internal/testtools"
)

func TestToRcloneShapes(t *testing.T) {
	rules, err := Parse([]string{"# comment", "", "build/", "/TODO", "*.log", "docs/draft.md", "!keep.log", "**/tmp", `\#hash`, "a{b}"})
	if err != nil {
		t.Fatal(err)
	}
	var lines []string
	for _, line := range ToRclone(rules) {
		if !strings.HasPrefix(line, "#") {
			lines = append(lines, line)
		}
	}
	want := []string{
		`- a\{b\}`, `- a\{b\}/**`,
		"- #hash", "- #hash/**",
		"- tmp", "- tmp/**",
		"+ keep.log", "+ keep.log/**",
		"- /docs/draft.md", "- /docs/draft.md/**",
		"- *.log", "- *.log/**",
		"- /TODO", "- /TODO/**",
		"- build/**",
	}
	if !reflect.DeepEqual(lines, want) {
		t.Fatalf("got\n%s\nwant\n%s", strings.Join(lines, "\n"), strings.Join(want, "\n"))
	}
}

func TestDefaultsAreFirstAndOverridable(t *testing.T) {
	body, err := Compile([]string{"!.env"}, "/hosts/")
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(body, "\n")
	// The extra rule (peers dir) comes first in rclone order, so nothing re-includes it.
	if lines[2] != "- /hosts/**" {
		t.Fatalf("first rule = %q\n%s", lines[2], body)
	}
	if !strings.Contains(body, "+ .env\n") {
		t.Fatalf("project rule missing:\n%s", body)
	}
}

// TestMatchesGit uses git itself as the oracle for gitignore semantics and the
// pinned rclone as the engine: the files rclone lists with the translated filters
// must be exactly the files git does not ignore.
func TestMatchesGit(t *testing.T) {
	_, here, _, _ := runtime.Caller(0)
	rcloneBin := testtools.PinnedRclone(t, filepath.Join(filepath.Dir(here), "..", ".."))
	if _, err := exec.LookPath("git"); err != nil {
		testtools.Missing(t, "no git")
	}
	root := t.TempDir()
	files := []string{
		"a.md", "notes/b.md", "notes/b.log", "keep.log", "deep/x/keep.log",
		"build/out.bin", "src/build/out.bin", "TODO", "docs/TODO", "docs/draft.md", "x/docs/draft.md",
		"tmp", "a/tmp/f", "id_rsa", "id_ed25519.pub", "cert.pem", "server.key", ".env", "sub/.env",
		".env.example", "node_modules/p/i.js", "web/node_modules/q.js", "a{b}", "space name.txt",
		"#hash", "z/#hash", "lib/build", "y/node_modules",
	}
	for _, f := range files {
		path := filepath.Join(root, filepath.FromSlash(f))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(f), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	project := []string{"build/", "/TODO", "*.log", "docs/draft.md", "!keep.log", "**/tmp", `\#hash`, "a{b}"}
	gitignore := strings.Join(append(append([]string{}, Defaults...), project...), "\n") + "\n"
	if err := os.WriteFile(filepath.Join(root, ".gitignore"), []byte(gitignore), 0o644); err != nil {
		t.Fatal(err)
	}
	git := exec.Command("git", "-c", "init.defaultBranch=main", "init", "-q", root)
	if out, err := git.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	out, err := exec.Command("git", "-C", root, "ls-files", "--others", "--exclude-standard").Output()
	if err != nil {
		t.Fatal(err)
	}
	var want []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line != ".gitignore" {
			want = append(want, line)
		}
	}
	sort.Strings(want)

	body, err := Compile(project)
	if err != nil {
		t.Fatal(err)
	}
	filterFile := filepath.Join(t.TempDir(), "filters.txt")
	if err := os.WriteFile(filterFile, []byte(body+"- /.gitignore\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(rcloneBin, "lsjson", "-R", "--files-only", "--no-mimetype", "--config", testtools.NoConfig(t), "--filter-from", filterFile, root)
	listing, err := cmd.Output()
	if err != nil {
		t.Fatalf("rclone: %v", err)
	}
	var items []struct{ Path string }
	if err := json.Unmarshal(listing, &items); err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, item := range items {
		got = append(got, item.Path)
	}
	sort.Strings(got)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("rclone kept\n  %s\ngit keeps\n  %s\nfilters:\n%s", strings.Join(got, "\n  "), strings.Join(want, "\n  "), body)
	}
}
