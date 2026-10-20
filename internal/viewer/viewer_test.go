package viewer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/BurntSushi/toml"
)

func TestRefusesAViewerWithoutAccess(t *testing.T) {
	if err := (Settings{Bucket: "folder-sync", Domain: "files.example.com"}).Validate(); err == nil || !strings.Contains(err.Error(), "access_team") {
		t.Fatal(err)
	}
	if err := (Settings{Bucket: "folder-sync", AccessTeam: "bam"}).Validate(); err == nil || !strings.Contains(err.Error(), "domain") {
		t.Fatal(err)
	}
	if err := (Settings{Bucket: "b", AccessTeam: "bam.cloudflareaccess.com", Domain: "files.example.com"}).Validate(); err == nil {
		t.Fatal("a full team domain must be refused")
	}
}

func TestHardenedFiles(t *testing.T) {
	s := Settings{Bucket: "folder-sync", AccessTeam: "bam", Domain: "files.bamrobotics.com", WorkerName: "folder-sync-viewer-folder-sync"}
	if err := s.Validate(); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	commands, err := Write(dir, s)
	if err != nil {
		t.Fatal(err)
	}
	var wrangler struct {
		Name        string `toml:"name"`
		WorkersDev  *bool  `toml:"workers_dev"`
		PreviewURLs *bool  `toml:"preview_urls"`
		Routes      []struct {
			Pattern      string `toml:"pattern"`
			CustomDomain bool   `toml:"custom_domain"`
		} `toml:"routes"`
		Buckets []struct {
			Binding    string `toml:"binding"`
			BucketName string `toml:"bucket_name"`
		} `toml:"r2_buckets"`
	}
	if _, err := toml.DecodeFile(filepath.Join(dir, "wrangler.toml"), &wrangler); err != nil {
		t.Fatalf("wrangler.toml: %v", err)
	}
	if wrangler.WorkersDev == nil || *wrangler.WorkersDev || wrangler.PreviewURLs == nil || *wrangler.PreviewURLs {
		t.Fatal("workers_dev and preview_urls must be explicitly false")
	}
	if len(wrangler.Routes) != 1 || wrangler.Routes[0].Pattern != s.Domain || !wrangler.Routes[0].CustomDomain {
		t.Fatalf("routes: %+v", wrangler.Routes)
	}
	if len(wrangler.Buckets) != 1 || wrangler.Buckets[0].Binding != "BUCKET" || wrangler.Buckets[0].BucketName != "folder-sync" {
		t.Fatalf("buckets: %+v", wrangler.Buckets)
	}
	index, _ := os.ReadFile(filepath.Join(dir, "src", "index.ts"))
	for _, want := range []string{"readonly: true", `cfAccessTeamName: "bam"`} {
		if !strings.Contains(string(index), want) {
			t.Errorf("index.ts lacks %s", want)
		}
	}
	pkg, _ := os.ReadFile(filepath.Join(dir, "package.json"))
	if !strings.Contains(string(pkg), `"r2-explorer": "1.2.0"`) || strings.Contains(string(pkg), "^") {
		t.Errorf("versions must be exact pins: %s", pkg)
	}
	if len(commands) != 2 || !strings.Contains(commands[1], "run deploy") {
		t.Fatal(commands)
	}
}
