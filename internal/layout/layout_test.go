package layout

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

func env(vars map[string]string) Getenv {
	return func(key string) string { return vars[key] }
}

// A Windows box as the PEP describes it: AppData set (and virtualized by MSIX).
var windowsEnv = map[string]string{
	"USERPROFILE":  `C:\Users\BAM`,
	"APPDATA":      `C:\Users\BAM\AppData\Roaming`,
	"LOCALAPPDATA": `C:\Users\BAM\AppData\Local`,
	"TEMP":         `C:\Users\BAM\AppData\Local\Temp`,
	"HOMEDRIVE":    `D:`,
	"HOMEPATH":     `\elsewhere`,
}

func TestWindowsLayoutNeverResolvesToAppData(t *testing.T) {
	l, err := For("windows", env(windowsEnv))
	if err != nil {
		t.Fatal(err)
	}
	if l.Root != `C:\Users\BAM\.folder-sync` {
		t.Fatalf("root = %q", l.Root)
	}
	for _, path := range append(l.All(), l.Dirs()...) {
		if !strings.HasPrefix(path, `C:\Users\BAM\.folder-sync`) {
			t.Errorf("%q escapes ~/.folder-sync", path)
		}
		if strings.Contains(strings.ToLower(path), "appdata") || strings.Contains(path, "/") {
			t.Errorf("%q mentions AppData or a forward slash", path)
		}
	}
	if l.Rclone != `C:\Users\BAM\.folder-sync\bin\rclone.exe` {
		t.Errorf("rclone = %q", l.Rclone)
	}
}

func TestWindowsHomeFallsBackToHomeDriveNotAppData(t *testing.T) {
	vars := map[string]string{}
	for k, v := range windowsEnv {
		vars[k] = v
	}
	delete(vars, "USERPROFILE")
	l, err := For("windows", env(vars))
	if err != nil {
		t.Fatal(err)
	}
	if l.Root != `D:\elsewhere\.folder-sync` {
		t.Fatalf("root = %q", l.Root)
	}
	delete(vars, "HOMEDRIVE")
	if _, err := For("windows", env(vars)); err == nil {
		t.Fatal("with only APPDATA/LOCALAPPDATA set, the home must be unknown, not AppData")
	}
}

func TestUnixLayout(t *testing.T) {
	l, err := For("linux", env(map[string]string{"HOME": "/home/bam", "XDG_CONFIG_HOME": "/home/bam/.config"}))
	if err != nil {
		t.Fatal(err)
	}
	if l.Root != "/home/bam/.folder-sync" || l.Rclone != "/home/bam/.folder-sync/bin/rclone" || l.Credentials != "/home/bam/.folder-sync/credentials.json" {
		t.Fatalf("%+v", l)
	}
	if _, err := For("darwin", env(map[string]string{})); err == nil {
		t.Fatal("no HOME must be an error")
	}
}

func TestJoin(t *testing.T) {
	cases := []struct {
		goos string
		in   []string
		want string
	}{
		{"windows", []string{`C:\`, "a", "b.txt"}, `C:\a\b.txt`},
		{"windows", []string{`C:\Users\BAM\`, `\x\`, "y"}, `C:\Users\BAM\x\y`},
		{"linux", []string{"/", "home", "bam"}, "/home/bam"},
		{"linux", []string{"/home/bam/", "/.folder-sync"}, "/home/bam/.folder-sync"},
		{"darwin", []string{"/Users/z", "", "x"}, "/Users/z/x"},
	}
	for _, c := range cases {
		if got := Join(c.goos, c.in...); got != c.want {
			t.Errorf("Join(%s, %q) = %q, want %q", c.goos, c.in, got, c.want)
		}
	}
}

// TestNoSourceReadsAppData is the static half of the proof: no non-test Go file
// asks the OS for its config/cache dirs or reads APPDATA/LOCALAPPDATA/TEMP.
func TestNoSourceReadsAppData(t *testing.T) {
	_, here, _, _ := runtime.Caller(0)
	repo := filepath.Join(filepath.Dir(here), "..", "..")
	forbidden := regexp.MustCompile(`os\.UserConfigDir|os\.UserCacheDir|os\.TempDir|Getenv\("(APPDATA|LOCALAPPDATA|TEMP|TMP)"\)`)
	err := filepath.Walk(repo, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() && (info.Name() == ".git" || info.Name() == ".tools" || info.Name() == "node_modules") {
			return filepath.SkipDir
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for i, line := range strings.Split(string(data), "\n") {
			if trimmed := strings.TrimSpace(line); strings.HasPrefix(trimmed, "//") {
				continue
			}
			if forbidden.MatchString(line) {
				t.Errorf("%s:%d reads an AppData-style location: %s", path, i+1, strings.TrimSpace(line))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
