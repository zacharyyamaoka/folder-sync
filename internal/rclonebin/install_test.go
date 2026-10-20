package rclonebin

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
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

// TestDevToolsScriptUsesTheSamePin keeps scripts/dev-tools and this package in step.
func TestDevToolsScriptUsesTheSamePin(t *testing.T) {
	_, here, _, _ := runtime.Caller(0)
	script, err := os.ReadFile(filepath.Join(filepath.Dir(here), "..", "..", "scripts", "dev-tools"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(script), `RCLONE_VERSION="`+Version+`"`) || !strings.Contains(string(script), SHA256["linux-amd64"]) {
		t.Fatal("scripts/dev-tools pins a different rclone than internal/rclonebin")
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
