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
	for _, target := range [][2]string{{"Linux", "riscv64"}, {"Darwin", "ppc"}, {"MINGW64_NT-10.0", "x86_64"}} {
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
