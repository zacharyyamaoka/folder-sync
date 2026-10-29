package rclonebin

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

func fakeZip(t *testing.T, exe string) []byte {
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	f, err := w.Create("rclone-" + Version + "-test/" + exe)
	if err != nil {
		t.Fatal(err)
	}
	f.Write([]byte("#!/bin/sh\necho rclone " + Version + "\n"))
	w.Create("rclone-" + Version + "-test/README.txt")
	w.Close()
	return buf.Bytes()
}

func TestInstallVerifiesThePinnedChecksum(t *testing.T) {
	for _, goos := range []string{"linux", "windows", "darwin"} {
		exe := "rclone"
		if goos == "windows" {
			exe = "rclone.exe"
		}
		data := fakeZip(t, exe)
		platform := Platform(goos, "amd64")
		var requested string
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requested = r.URL.Path
			w.Write(data)
		}))
		saved := SHA256[platform]
		sum := sha256.Sum256(data)
		SHA256[platform] = hex.EncodeToString(sum[:])

		dest := filepath.Join(t.TempDir(), "bin", exe)
		if err := Install(server.URL, goos, "amd64", dest); err != nil {
			t.Fatalf("%s: %v", goos, err)
		}
		if requested != "/"+Version+"/"+ZipName(platform) {
			t.Errorf("%s: downloaded %s", goos, requested)
		}
		if got, _ := os.ReadFile(dest); !strings.Contains(string(got), "echo rclone") {
			t.Errorf("%s: wrong file extracted", goos)
		}

		SHA256[platform] = saved // the real pin cannot match the fake zip
		bad := filepath.Join(t.TempDir(), exe)
		if err := Install(server.URL, goos, "amd64", bad); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
			t.Errorf("%s: a tampered download must be refused, got %v", goos, err)
		}
		if _, err := os.Stat(bad); err == nil {
			t.Errorf("%s: a refused download left a binary behind", goos)
		}
		server.Close()
	}
}

// TestConcurrentInstallsBothSucceed: an app's background service and its sign-in can run folder-sync's first command on
// a new machine at once; both must end with a whole rclone and no temp file left (each writes a temp file of its own).
func TestConcurrentInstallsBothSucceed(t *testing.T) {
	exe := "rclone"
	if runtime.GOOS == "windows" {
		exe = "rclone.exe"
	}
	// a binary of a few MB, so the writes overlap the way a real 60 MB rclone's do
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	f, err := w.Create("rclone-" + Version + "-test/" + exe)
	if err != nil {
		t.Fatal(err)
	}
	f.Write([]byte("#!/bin/sh\necho rclone " + Version + "\n#" + strings.Repeat("x", 4<<20) + "\n"))
	w.Close()
	data := buf.Bytes()
	whole := 4 << 20
	platform := Platform(runtime.GOOS, runtime.GOARCH)
	saved, had := SHA256[platform]
	sum := sha256.Sum256(data)
	SHA256[platform] = hex.EncodeToString(sum[:])
	defer func() {
		if had {
			SHA256[platform] = saved
		} else {
			delete(SHA256, platform)
		}
	}()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(data) }))
	defer server.Close()
	dir := filepath.Join(t.TempDir(), "bin")
	dest := filepath.Join(dir, exe)
	const n = 8
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		go func() { errs <- Install(server.URL, runtime.GOOS, runtime.GOARCH, dest) }()
	}
	for i := 0; i < n; i++ {
		if err := <-errs; err != nil {
			t.Errorf("install %d: %v", i, err)
		}
	}
	if got, _ := os.ReadFile(dest); !strings.HasPrefix(string(got), "#!/bin/sh\necho rclone "+Version) || len(got) < whole {
		t.Errorf("the installed rclone is not whole: %d bytes", len(got))
	}
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		if entry.Name() != exe {
			t.Errorf("left behind: %s", entry.Name())
		}
	}
	if info, err := os.Stat(dest); err == nil && runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		t.Errorf("rclone is not executable: %v", info.Mode())
	}
}

func TestPinsCoverEveryTarget(t *testing.T) {
	for _, target := range []string{"linux-amd64", "linux-arm64", "osx-amd64", "osx-arm64", "windows-amd64", "windows-arm64"} {
		if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(SHA256[target]) {
			t.Errorf("no pin for %s", target)
		}
	}
	if Platform("darwin", "arm64") != "osx-arm64" {
		t.Error("darwin must map to rclone's osx")
	}
}

// devToolsPlan runs `scripts/dev-tools --print-plan` as if on the given uname -s / -m.
func devToolsPlan(t *testing.T, osName, machine string) (fields []string, stderr string, err error) {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	script := filepath.Join(filepath.Dir(here), "..", "..", "scripts", "dev-tools")
	cmd := exec.Command("bash", script, "--print-plan")
	cmd.Env = append(os.Environ(), "FOLDER_SYNC_UNAME_S="+osName, "FOLDER_SYNC_UNAME_M="+machine)
	var errOut bytes.Buffer
	cmd.Stderr = &errOut
	out, err := cmd.Output()
	return strings.Fields(string(out)), errOut.String(), err
}

// TestDevToolsScriptUsesTheSamePin keeps scripts/dev-tools and this package in step: the
// script reads its pins from install.go, so there is one table, and it covers every machine
// a developer has (Zach's Mac is darwin-arm64).
func TestDevToolsScriptUsesTheSamePin(t *testing.T) {
	targets := []struct{ uname, machine, platform string }{
		{"Linux", "x86_64", "linux-amd64"},
		{"Linux", "aarch64", "linux-arm64"},
		{"Darwin", "arm64", "osx-arm64"},
		{"Darwin", "x86_64", "osx-amd64"},
		// Git Bash on a Windows runner: uname -s carries the Windows build; MSYS2 says MSYS_NT
		{"MINGW64_NT-10.0-20348", "x86_64", "windows-amd64"},
		{"MSYS_NT-10.0-26100", "x86_64", "windows-amd64"},
		{"MINGW64_NT-10.0-26100", "aarch64", "windows-arm64"},
	}
	for _, target := range targets {
		fields, stderr, err := devToolsPlan(t, target.uname, target.machine)
		if err != nil {
			t.Errorf("%s/%s: %v\n%s", target.uname, target.machine, err, stderr)
			continue
		}
		want := []string{target.platform, BaseURL + "/" + Version + "/" + ZipName(target.platform), SHA256[target.platform]}
		if strings.Join(fields, " ") != strings.Join(want, " ") {
			t.Errorf("%s/%s: plan %q, want %q", target.uname, target.machine, fields, want)
		}
	}
	_, here, _, _ := runtime.Caller(0)
	script, _ := os.ReadFile(filepath.Join(filepath.Dir(here), "..", "..", "scripts", "dev-tools"))
	if regexp.MustCompile(`[0-9a-f]{64}`).Match(script) || strings.Contains(string(script), `"`+Version+`"`) {
		t.Error("scripts/dev-tools carries its own pin; it must read internal/rclonebin/install.go")
	}
}

func TestDevToolsScriptRefusesWhatIsNotPinned(t *testing.T) {
	for _, target := range [][2]string{{"Linux", "riscv64"}, {"Darwin", "ppc"}, {"MINGW64_NT-10.0", "riscv64"}, {"FreeBSD", "amd64"}} {
		_, stderr, err := devToolsPlan(t, target[0], target[1])
		if err == nil || !strings.Contains(stderr, "no pinned rclone") {
			t.Errorf("%v: want a refusal naming the missing pin, got %v %q", target, err, stderr)
		}
	}
}

func TestAtLeast(t *testing.T) {
	cases := map[string]bool{
		"rclone v1.75.2": true, "rclone v1.76.0": true, "rclone v2.0.0": true, "rclone v1.75.10": true,
		"rclone v1.75.1": false, "rclone v1.60.1": false, "rclone v1.75.2-beta.1234": true, "garbage": false,
	}
	for line, want := range cases {
		if got := AtLeast(line, "v1.75.2"); got != want {
			t.Errorf("AtLeast(%q) = %v", line, got)
		}
	}
}
