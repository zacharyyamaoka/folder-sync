package store_test

// Seam 3 of PARTS.md: the storage-agnostic core does not reach the Cloudflare-specific parts. The engine's packages
// (syncer, store, s3, rclone, creds, config, history, manifest, ...) never import the accounts Worker's client
// (internal/account), the R2-Explorer viewer (internal/viewer) or the hub's push client (internal/push); only the CLI
// (cmd/folder-sync) and the local view server (internal/serve, which shows who is signed in) wire them in. A folder on
// s3:// or file:// therefore needs none of them, and scripts/check-core-alone runs the whole suite without accounts/.

import (
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestTheAgnosticCoreDoesNotImportTheCloudflareSpecificPackages(t *testing.T) {
	_, here, _, _ := runtime.Caller(0)
	repo := filepath.Dir(filepath.Dir(filepath.Dir(here)))
	// the packages that are Cloudflare-specific (the accounts Worker's client, the R2-Explorer config, the hub's socket)
	// and the two places allowed to wire them in
	cloudflare := map[string]bool{"folder-sync/internal/account": true, "folder-sync/internal/viewer": true, "folder-sync/internal/push": true}
	mayImport := func(path string) bool {
		slash := filepath.ToSlash(path)
		return strings.HasPrefix(slash, "cmd/folder-sync/") || strings.HasPrefix(slash, "internal/serve/") ||
			strings.HasPrefix(slash, "internal/account/") || strings.HasPrefix(slash, "internal/viewer/") || strings.HasPrefix(slash, "internal/push/")
	}
	checked := 0
	for _, root := range []string{"internal", "cmd"} {
		filepath.WalkDir(filepath.Join(repo, root), func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			rel, _ := filepath.Rel(repo, path)
			file, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
			if err != nil {
				t.Errorf("%s: %v", rel, err)
				return nil
			}
			checked++
			for _, spec := range file.Imports {
				imported := strings.Trim(spec.Path.Value, `"`)
				if cloudflare[imported] && !mayImport(rel) {
					t.Errorf("%s imports %s: the agnostic core must not reach the Cloudflare-specific packages (PARTS.md)", rel, imported)
				}
			}
			return nil
		})
	}
	if checked < 30 {
		t.Fatalf("only %d files checked: the walk found nothing", checked)
	}
}

// internal/store is the storage-agnostic seam itself: it knows r2:// as one kind and imports nothing but the S3 client.
func TestStorePackageImportsOnlyTheStandardLibraryAndS3(t *testing.T) {
	_, here, _, _ := runtime.Caller(0)
	dir := filepath.Dir(here)
	files, _ := filepath.Glob(filepath.Join(dir, "*.go"))
	for _, path := range files {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, spec := range file.Imports {
			imported := strings.Trim(spec.Path.Value, `"`)
			if strings.Contains(imported, ".") && imported != "folder-sync/internal/s3" {
				t.Errorf("%s imports %s", filepath.Base(path), imported)
			}
			if strings.HasPrefix(imported, "folder-sync/") && imported != "folder-sync/internal/s3" {
				t.Errorf("%s imports %s", filepath.Base(path), imported)
			}
		}
	}
}
