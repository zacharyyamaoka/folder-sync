// Package manifest is the per-host file list that drives every round
// (docs/peps/0001 §4: "the manifest is the diff engine; the remote is never
// listed on every round") and that apps read (docs/CONTRACT.md).
package manifest

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"

	"folder-sync/internal/host"
	"folder-sync/internal/names"
)

// Schema is the manifest format id. A reader refuses any other major version.
const Schema = "folder-sync-manifest/1"

// FileName is the manifest's name inside hosts/<host-id>/.
const FileName = "manifest.json"

// Entry is one file this host wrote.
type Entry struct {
	Path      string `json:"path"`       // slash-separated, relative to hosts/<host-id>/
	Size      int64  `json:"size"`       // bytes
	MTime     string `json:"mtime"`      // the source file's modification time, RFC 3339 UTC with nanoseconds
	SHA256    string `json:"sha256"`     // lowercase hex of the content
	WrittenAt string `json:"written_at"` // when this host uploaded this content, RFC 3339 UTC
}

// Manifest is hosts/<host-id>/manifest.json.
type Manifest struct {
	Schema      string  `json:"schema"`
	Project     string  `json:"project"`
	HostID      string  `json:"host_id"`
	HostName    string  `json:"host_name"`
	Seq         int64   `json:"seq"`          // +1 on every rewrite
	GeneratedAt string  `json:"generated_at"` // RFC 3339 UTC
	Files       []Entry `json:"files"`        // sorted by path
}

var sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Validate checks a manifest read from the bucket before anything acts on it.
func (m Manifest) Validate() error {
	if m.Schema != Schema {
		return fmt.Errorf("manifest schema %q, want %q", m.Schema, Schema)
	}
	if !host.IsID(m.HostID) {
		return fmt.Errorf("manifest host_id %q is not a host id", m.HostID)
	}
	if _, err := time.Parse(time.RFC3339Nano, m.GeneratedAt); err != nil {
		return fmt.Errorf("manifest generated_at %q: %w", m.GeneratedAt, err)
	}
	seen := map[string]bool{}
	for _, e := range m.Files {
		if err := names.CheckRelative(e.Path); err != nil {
			return fmt.Errorf("manifest entry: %w", err)
		}
		if seen[e.Path] {
			return fmt.Errorf("manifest lists %q twice", e.Path)
		}
		seen[e.Path] = true
		if e.Size < 0 || !sha256Hex.MatchString(e.SHA256) {
			return fmt.Errorf("manifest entry %q: bad size or sha256", e.Path)
		}
		if _, err := time.Parse(time.RFC3339Nano, e.MTime); err != nil {
			return fmt.Errorf("manifest entry %q mtime: %w", e.Path, err)
		}
		if _, err := time.Parse(time.RFC3339Nano, e.WrittenAt); err != nil {
			return fmt.Errorf("manifest entry %q written_at: %w", e.Path, err)
		}
	}
	return nil
}

// Index maps path to entry.
func (m Manifest) Index() map[string]Entry {
	index := make(map[string]Entry, len(m.Files))
	for _, e := range m.Files {
		index[e.Path] = e
	}
	return index
}

// Sort orders the entries by path.
func (m *Manifest) Sort() {
	sort.Slice(m.Files, func(i, j int) bool { return m.Files[i].Path < m.Files[j].Path })
}

// Parse decodes and validates a manifest.
func Parse(data []byte) (Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return Manifest{}, fmt.Errorf("manifest is not valid JSON: %w", err)
	}
	if m.Files == nil {
		m.Files = []Entry{}
	}
	return m, m.Validate()
}

// Marshal encodes a manifest the way it is stored (indented, trailing newline).
func Marshal(m Manifest) []byte {
	m.Sort()
	if m.Files == nil {
		m.Files = []Entry{}
	}
	data, _ := json.MarshalIndent(m, "", "  ")
	return append(data, '\n')
}

// Load reads a manifest file; a missing file is an empty manifest.
func Load(path string) (Manifest, bool, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return Manifest{Schema: Schema, Files: []Entry{}}, false, nil
	}
	if err != nil {
		return Manifest{}, false, err
	}
	m, err := Parse(data)
	return m, true, err
}

// Save writes a manifest file atomically.
func Save(path string, m Manifest) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, Marshal(m), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// FormatTime renders a time the way manifests store it.
func FormatTime(t time.Time) string {
	return t.UTC().Format(time.RFC3339Nano)
}
