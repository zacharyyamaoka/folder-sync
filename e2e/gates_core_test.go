package e2e

// Gates G6 and G11, the core's half.
//
//	G6  Headless: a fresh machine syncs from a script. No terminal, no prompt, no browser: a shell script, a throwaway HOME,
//	    an environment of PATH and the bucket key, and nothing else.
//	G11 Easy to start: from a fresh machine to the first sync is 2 minutes or less. This measures the Linux/macOS/Windows
//	    runner it runs on (the matrix jobs run it too and upload FOLDER_SYNC_G11_OUT; scripts/gates collects them). It starts
//	    from the built binary with rclone already installed: the one-time rclone download is the installer's step, and
//	    needs the network, which a test does not.

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// freshMachine is a new HOME and an empty folder, and the smallest environment folder-sync can run in.
func freshMachine(t *testing.T, w *world, name string) *machine {
	t.Helper()
	root := t.TempDir()
	m := &machine{name: name, home: filepath.Join(root, "home"), folder: filepath.Join(root, name)}
	os.MkdirAll(m.home, 0o700)
	os.MkdirAll(m.folder, 0o755)
	for _, key := range []string{"PATH", "SYSTEMROOT", "TEMP", "TMP"} { // Windows needs these three to start a process at all
		if v := os.Getenv(key); v != "" {
			m.env = append(m.env, key+"="+v)
		}
	}
	m.env = append(m.env, "HOME="+m.home, "USERPROFILE="+m.home, "FOLDER_SYNC_RCLONE="+w.rclone)
	m.env = append(m.env, w.keyEnv()...)
	return m
}

// runScript runs a shell script on m the way a provisioning tool would: no terminal on stdin, nothing but m.env.
func runScript(t *testing.T, w *world, m *machine, script string) (string, time.Duration) {
	t.Helper()
	path := filepath.Join(filepath.Dir(m.home), "provision.sh")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("sh", path)
	cmd.Env = append(append([]string{}, m.env...), "FS="+w.bin, "FOLDER="+m.folder, "BUCKET="+bucket, "PROJECT=headless")
	cmd.Dir = filepath.Dir(m.home)
	cmd.Stdin = nil // /dev/null: a prompt would read end-of-file and fail
	started := time.Now()
	out, err := cmd.CombinedOutput()
	took := time.Since(started)
	if err != nil {
		t.Fatalf("%s's script failed after %s: %v\n%s", m.name, took, err, out)
	}
	return string(out), took
}

const provisionScript = `set -eu
mkdir -p "$FOLDER"
cd "$FOLDER"
%s
"$FS" init --project "$PROJECT" --bucket "$BUCKET"
"$FS" sync --once
`

func TestGateHeadlessFreshMachine(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the script is POSIX sh; Git Bash on the Windows runner runs the same flow through the CLI e2e")
	}
	w, _, _ := historyWorld(t)
	first := freshMachine(t, w, "fresh-1")
	second := freshMachine(t, w, "fresh-2")
	out1, took1 := runScript(t, w, first, strings.Replace(provisionScript, "%s", `printf 'written by a script\n' > notes.md`, 1))
	out2, took2 := runScript(t, w, second, strings.Replace(provisionScript, "%s", ":", 1))
	t.Logf("first machine %s, second %s", took1, took2)
	for _, out := range []string{out1, out2} {
		for _, prompt := range []string{"[y/N]", "[Y/n]", "Press Enter", "password:", "Password:"} {
			if strings.Contains(out, prompt) {
				t.Errorf("the script's output holds a prompt (%q):\n%s", prompt, out)
			}
		}
	}
	idFirst := hostID(t, first)
	got, err := os.ReadFile(filepath.Join(second.folder, "hosts", idFirst, "notes.md"))
	if err != nil || string(got) != "written by a script\n" {
		t.Fatalf("the second fresh machine did not receive the first one's file: %q %v\nfirst:\n%s\nsecond:\n%s", got, err, out1, out2)
	}
}

func TestGateFirstSyncWithinTwoMinutes(t *testing.T) {
	w, _, _ := historyWorld(t)
	m := freshMachine(t, w, "fresh")
	for _, name := range []string{"notes/a.md", "notes/b.md", "docs/c.txt", "d.md"} {
		writeFile(t, filepath.Join(m.folder, filepath.FromSlash(name)), "a first file\n", time.Time{})
	}
	started := time.Now()
	w.must(m, "init", "--project", "first", "--bucket", bucket)
	w.must(m, "sync", "--once")
	took := time.Since(started)
	t.Logf("init + first sync of 4 files on %s/%s: %s", runtime.GOOS, runtime.GOARCH, took.Round(time.Millisecond))
	if live, ok := w.object("first/hosts/" + hostID(t, m) + "/d.md"); !ok || live != "a first file\n" {
		t.Fatalf("the first sync did not publish: found=%v %q", ok, live)
	}
	if path := os.Getenv("FOLDER_SYNC_G11_OUT"); path != "" {
		data, _ := json.MarshalIndent(map[string]any{
			"schema": "folder-sync-g11/1", "os": runtime.GOOS, "arch": runtime.GOARCH, "seconds": took.Seconds(),
			"measures": "init + first sync of 4 files, rclone preinstalled, stand-in bucket on 127.0.0.1",
		}, "", "  ")
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Errorf("cannot write %s: %v", path, err)
		}
	}
	if took > 2*time.Minute {
		t.Errorf("init + first sync took %s, the gate allows 2 minutes", took)
	}
}
