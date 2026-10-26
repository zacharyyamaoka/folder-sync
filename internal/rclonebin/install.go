// Package rclonebin installs the pinned rclone into ~/.folder-sync/bin.
//
// docs/peps/0001 §2: rclone ≥ 1.75.2, pinned and checksum-verified, never the
// distro package (the workstation's apt build is 1.60.1, which predates the
// bisync redesign and conditional uploads). The checksums below were copied
// from https://downloads.rclone.org/v1.75.2/SHA256SUMS on 2026-10-20 and match
// the GitHub release's SHA256SUMS; scripts/dev-tools reads this same table.
package rclonebin

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Version is the pinned rclone release.
const Version = "v1.75.2"

// BaseURL is where official rclone releases are downloaded from.
const BaseURL = "https://downloads.rclone.org"

// SHA256 maps "<goos>-<goarch>" (rclone's naming: osx, not darwin) to the release zip's checksum.
var SHA256 = map[string]string{
	"linux-amd64":   "349ac8fba6ff65d6247043f1750cdcb518ec5d500ef91463a10d37c0ccdf3702",
	"linux-arm64":   "7e1e8d69654941b7b7df84ee74c5f7fb09cce7d5496947fb7bf16b55ff427d10",
	"osx-amd64":     "574e1f31cf1c464e5fb0325cb66fcbdeaf1efa1802bd9b17f13c256fd74b6561",
	"osx-arm64":     "610ab7d48615135dfc60b763858b11a426a0d3d1160c1bb76fb0ae6011b02edd",
	"windows-amd64": "8a9db2bad1dc79a65b3348fd857069598e2aab7cf4d118b77b1df23055aff818",
	"windows-arm64": "7eb9844c9e5b723b9ef28821891caa17f6d9d1a375c49365cbe04114cec8dcd9",
}

// Platform is rclone's name for goos-goarch.
func Platform(goos, goarch string) string {
	if goos == "darwin" {
		goos = "osx"
	}
	return goos + "-" + goarch
}

// ZipName is the release asset for a platform.
func ZipName(platform string) string {
	return "rclone-" + Version + "-" + platform + ".zip"
}

// Install downloads the pinned zip for goos/goarch from baseURL, verifies its
// SHA-256 against the pin, and writes the rclone binary to dest atomically.
func Install(baseURL, goos, goarch, dest string) error {
	platform := Platform(goos, goarch)
	want, ok := SHA256[platform]
	if !ok {
		return fmt.Errorf("no pinned rclone %s for %s", Version, platform)
	}
	url := strings.TrimRight(baseURL, "/") + "/" + Version + "/" + ZipName(platform)
	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("download %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: %s", url, resp.Status)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 512<<20))
	if err != nil {
		return fmt.Errorf("download %s: %w", url, err)
	}
	sum := sha256.Sum256(data)
	if got := hex.EncodeToString(sum[:]); got != want {
		return fmt.Errorf("checksum mismatch for %s: got %s, pinned %s; refusing to install", ZipName(platform), got, want)
	}
	exe := "rclone"
	if goos == "windows" {
		exe = "rclone.exe"
	}
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return err
	}
	for _, file := range archive.File {
		if filepath.Base(file.Name) != exe || file.FileInfo().IsDir() {
			continue
		}
		src, err := file.Open()
		if err != nil {
			return err
		}
		defer src.Close()
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
		// WHY a temp file of its own: an app's service and its sign-in can each run folder-sync's first command on a
		// new machine at the same moment; one shared temp name let the second truncate what the first had written.
		out, err := os.CreateTemp(filepath.Dir(dest), "."+filepath.Base(dest)+"-*.download")
		if err != nil {
			return err
		}
		tmp := out.Name()
		if _, err := io.Copy(out, src); err != nil {
			out.Close()
			os.Remove(tmp)
			return err
		}
		if err := out.Close(); err != nil {
			os.Remove(tmp)
			return err
		}
		if err := os.Chmod(tmp, 0o755); err != nil {
			os.Remove(tmp)
			return err
		}
		if err := os.Rename(tmp, dest); err != nil {
			os.Remove(tmp)
			// Windows can't replace a binary another process is running: that process installed the same pin
			if _, statErr := os.Stat(dest); statErr == nil {
				return nil
			}
			return err
		}
		return nil
	}
	return fmt.Errorf("%s has no %s inside", ZipName(platform), exe)
}

// AtLeast reports whether an `rclone version` line (e.g. "rclone v1.75.2") is at least want ("v1.75.2").
func AtLeast(versionLine, want string) bool {
	parse := func(s string) [3]int {
		var v [3]int
		s = strings.TrimSpace(s)
		if i := strings.LastIndex(s, "v"); i >= 0 {
			s = s[i+1:]
		}
		s, _, _ = strings.Cut(s, "-")
		for i, part := range strings.SplitN(s, ".", 3) {
			fmt.Sscanf(part, "%d", &v[i])
		}
		return v
	}
	got, need := parse(versionLine), parse(want)
	for i := range got {
		if got[i] != need[i] {
			return got[i] > need[i]
		}
	}
	return true
}
