package ui

import (
	"io/fs"
	"strings"
	"testing"
)

// serve mounts Files at /fs/ui/, so the element's URL /fs/ui/v1/folder-sync.js is v1/folder-sync.js here, and the
// module's relative import ./vendor/diff.js is v1/vendor/diff.js.
func TestFilesHoldTheElementAndJsdiff(t *testing.T) {
	for path, want := range map[string]string{
		"v1/folder-sync.js":      `customElements.define("folder-sync-status"`,
		"v1/vendor/diff.js":      "jsdiff 9.0.0",
		"v1/vendor/diff.LICENSE": "BSD 3-Clause License",
	} {
		b, err := fs.ReadFile(Files, path)
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if !strings.Contains(string(b), want) {
			t.Errorf("%s does not contain %q", path, want)
		}
	}
}
