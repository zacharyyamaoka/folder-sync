// Package testtools is what tests share about the machine they run on: where the pinned rclone is, and what a
// missing tool means.
//
// WHY one switch: a skipped end-to-end test looks green and tests nothing. FOLDER_SYNC_E2E_REQUIRE=1 (set by
// .github/workflows/test.yml) turns every "tool not found" skip into a failure; a developer's laptop without
// scripts/dev-tools keeps the skip.
package testtools

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
)

// RequireEnv is the switch: any non-empty value other than "0" makes a missing tool a failure.
const RequireEnv = "FOLDER_SYNC_E2E_REQUIRE"

// Required reports whether a missing tool must fail the test instead of skipping it.
func Required() bool {
	v := os.Getenv(RequireEnv)
	return v != "" && v != "0"
}

// Missing ends t because a tool it needs is not here: a failure when Required, else a skip.
func Missing(t testing.TB, format string, args ...any) {
	t.Helper()
	if Required() {
		t.Fatalf(RequireEnv+" is set, so a missing tool fails instead of skipping: "+format, args...)
	}
	t.Skipf(format, args...)
}

// Exe is name with the platform's executable suffix.
func Exe(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

// Terminate asks a process this test started to stop: SIGTERM, so rclone and folder-sync clean up. Windows has no
// SIGTERM to send, so there it is a plain kill, the same stop internal/rclone gives it.
func Terminate(process *os.Process) {
	if runtime.GOOS == "windows" {
		process.Kill()
		return
	}
	process.Signal(syscall.SIGTERM)
}

// HomeEnv is the environment that points a child process's home at dir on every OS (folder-sync reads HOME, or
// USERPROFILE on Windows; see internal/layout).
func HomeEnv(dir string) []string {
	return []string{"HOME=" + dir, "USERPROFILE=" + dir}
}

// IsHomeVar reports whether kv ("NAME=value") sets a variable HomeEnv replaces. Env names are case-insensitive on
// Windows, hence the upper-casing.
func IsHomeVar(kv string) bool {
	upper := strings.ToUpper(kv)
	return strings.HasPrefix(upper, "HOME=") || strings.HasPrefix(upper, "USERPROFILE=")
}

// PythonBinary is the python this machine has: python3, else python (Windows installs only the latter). It runs
// "-c pass" to tell a real interpreter from the Windows Store's python3 stub.
func PythonBinary() string {
	for _, name := range []string{"python3", "python"} {
		if path, err := exec.LookPath(name); err == nil && exec.Command(path, "-c", "pass").Run() == nil {
			return path
		}
	}
	return "python3"
}

// PinnedRcloneIn is where scripts/dev-tools puts the pinned rclone for the checkout at repo.
func PinnedRcloneIn(repo string) string {
	return filepath.Join(repo, ".tools", Exe("rclone"))
}

// PinnedRclone returns PinnedRcloneIn(repo), or ends t (see Missing) when scripts/dev-tools has not been run.
func PinnedRclone(t testing.TB, repo string) string {
	t.Helper()
	path := PinnedRcloneIn(repo)
	if _, err := os.Stat(path); err != nil {
		Missing(t, "no %s: run scripts/dev-tools first", filepath.Join(".tools", Exe("rclone")))
	}
	return path
}
