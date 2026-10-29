package e2e

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"

	"folder-sync/internal/testtools"
)

// utf16LE is text as schtasks /XML wants it: UTF-16 little endian, no BOM here (a substring is searched for).
func utf16LE(text string) []byte {
	units := utf16.Encode([]rune(text))
	out := make([]byte, 2*len(units))
	for i, unit := range units {
		binary.LittleEndian.PutUint16(out[2*i:], unit)
	}
	return out
}

func TestTwinPlanOnACaseInsensitiveFolderHasNoTwinAssertions(t *testing.T) {
	insensitive := planTwins(false)
	if insensitive.writeTwin || len(insensitive.forbidden) > 0 || len(insensitive.statusWants) > 0 {
		t.Errorf("one file, not a twin: %+v", insensitive)
	}
	if len(insensitive.uploaded) != 1 || insensitive.uploaded[0] != "README.md" {
		t.Errorf("the single README.md is a normal file and uploads: %+v", insensitive)
	}
	sensitive := planTwins(true)
	if !sensitive.writeTwin || len(sensitive.forbidden) != 2 || len(sensitive.uploaded) != 0 {
		t.Errorf("a case-sensitive folder keeps the twin check: %+v", sensitive)
	}
}

func TestCaseProbeAnswersForThisFilesystem(t *testing.T) {
	dir := t.TempDir()
	got, err := folderIsCaseSensitive(dir)
	if err != nil {
		t.Fatal(err)
	}
	// An independent oracle: write two names that differ only in case and count the files.
	os.WriteFile(filepath.Join(dir, "Twin"), []byte("1"), 0o644)
	os.WriteFile(filepath.Join(dir, "twin"), []byte("2"), 0o644)
	entries, _ := os.ReadDir(dir)
	if want := len(entries) == 2; got != want {
		t.Errorf("probe says case-sensitive=%v, but %d entries after writing Twin and twin", got, len(entries))
	}
	if left, _ := filepath.Glob(filepath.Join(dir, ".case-probe-*")); len(left) != 0 {
		t.Errorf("the probe left %v behind", left)
	}
}

func TestMissingPythonModuleNamesTheModule(t *testing.T) {
	reason := missingPythonModule(testtools.PythonBinary(), "folder_sync_no_such_module")
	if !strings.Contains(reason, `"folder_sync_no_such_module"`) || !strings.Contains(reason, "pip install folder_sync_no_such_module") {
		t.Errorf("skip message must name the module and how to get it: %q", reason)
	}
	if reason := missingPythonModule(testtools.PythonBinary(), "json"); reason != "" {
		t.Errorf("json is stdlib: %q", reason)
	}
}

func TestServiceExpectationPerOS(t *testing.T) {
	glob, command := serviceExpectation("darwin", "/Users/zach")
	if glob != "/Users/zach/Library/LaunchAgents/dev.folder-sync.demo-*.plist" || !strings.HasPrefix(command, "launchctl bootstrap") {
		t.Errorf("darwin: %s %s", glob, command)
	}
	glob, command = serviceExpectation("windows", `C:\Users\BAM`)
	if !strings.HasSuffix(glob, `.folder-sync\service\folder-sync-demo-*.xml`) || !strings.HasPrefix(command, "schtasks /Create") {
		t.Errorf("windows: %s %s", glob, command)
	}
	glob, command = serviceExpectation("linux", "/home/bam")
	if !strings.HasSuffix(glob, ".folder-sync/service/folder-sync-demo-*.service") || !strings.HasPrefix(command, "systemctl --user") {
		t.Errorf("linux: %s %s", glob, command)
	}
}
