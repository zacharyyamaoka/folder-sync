// Package viewer writes the R2-Explorer project that is folder-sync's web backdoor
// (docs/peps/0001 §2, "publish"). It writes files and prints the deploy command;
// it never deploys and never creates a Cloudflare resource: that is the user's call.
//
// Hardening (docs/peps/0001 "publish"): cfAccessTeamName set, workers_dev and
// preview URLs off, the Worker served only on a custom domain behind Access,
// readonly, and no public domain on the bucket itself.
package viewer

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Pinned versions (npm registry, 2026-10-20). The R2-Explorer template's own
// package.json uses ^ ranges; these are exact so a deploy is reproducible.
const (
	R2ExplorerVersion = "1.2.0"
	WranglerVersion   = "4.151.3"
)

// Settings is everything the viewer needs.
type Settings struct {
	Bucket     string
	AccessTeam string
	Domain     string
	WorkerName string
}

var teamPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
var domainPattern = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$`)

// Validate refuses to write a viewer that would be reachable without Access.
func (s Settings) Validate() error {
	var missing []string
	if s.AccessTeam == "" {
		missing = append(missing, `access_team = "<your Zero Trust team name>"   # Zero Trust → Settings → Custom Pages → Team domain`)
	}
	if s.Domain == "" {
		missing = append(missing, `domain = "files.example.com"   # a hostname on a zone in your Cloudflare account`)
	}
	if len(missing) > 0 {
		return fmt.Errorf("the viewer is served only behind Cloudflare Access on your own domain; set in .folder-sync.toml [viewer]:\n  %s",
			strings.Join(missing, "\n  "))
	}
	if !teamPattern.MatchString(s.AccessTeam) {
		return fmt.Errorf("viewer.access_team %q: use the team name only (the part before .cloudflareaccess.com)", s.AccessTeam)
	}
	if !domainPattern.MatchString(s.Domain) {
		return fmt.Errorf("viewer.domain %q is not a hostname", s.Domain)
	}
	return nil
}

// Files renders the viewer project: relative path → content.
func Files(s Settings) map[string]string {
	return map[string]string{
		"package.json": fmt.Sprintf(`{
  "name": %q,
  "private": true,
  "scripts": {
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "r2-explorer": %q
  },
  "devDependencies": {
    "wrangler": %q
  }
}
`, s.WorkerName, R2ExplorerVersion, WranglerVersion),
		"wrangler.toml": fmt.Sprintf(`# Written by folder-sync publish --viewer (docs/peps/0001). R2-Explorer %s, pinned.
name = %q
compatibility_date = "2024-11-06"
main = "src/index.ts"
assets = { directory = "node_modules/r2-explorer/dashboard", binding = "ASSETS", html_handling = "auto-trailing-slash", not_found_handling = "single-page-application", run_worker_first = ["/api/*", "/share/*"] }

# Hardening: no *.workers.dev address and no preview URLs. The only way in is
# the custom domain below, which a Cloudflare Access application must protect.
workers_dev = false
preview_urls = false
routes = [
  { pattern = %q, custom_domain = true }
]

# The bucket is bound to the Worker; it never needs (and must not get) a
# public r2.dev address or a custom domain of its own.
[[r2_buckets]]
binding = "BUCKET"
bucket_name = %q
`, R2ExplorerVersion, s.WorkerName, s.Domain, s.Bucket),
		"src/index.ts": fmt.Sprintf(`// Written by folder-sync publish --viewer (docs/peps/0001).
// Read-only, and every request must carry a Cloudflare Access login for team %q.
import { R2Explorer } from "r2-explorer";

export default R2Explorer({
	readonly: true,
	cfAccessTeamName: %q,
});
`, s.AccessTeam, s.AccessTeam),
	}
}

// Write writes the viewer project into dir and returns the commands the user runs.
func Write(dir string, s Settings) ([]string, error) {
	for rel, content := range Files(s) {
		path := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			return nil, err
		}
	}
	return []string{
		"npm --prefix " + dir + " install",
		"npm --prefix " + dir + " run deploy",
	}, nil
}
