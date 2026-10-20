package manifest

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const hostID = "b55e9683-7854-4121-a56a-9bae7c3ab1da"

func sample() Manifest {
	return Manifest{
		Schema: Schema, Project: "demo", HostID: hostID, HostName: "box", Seq: 3,
		GeneratedAt: "2026-10-20T22:43:41.512Z",
		Files: []Entry{
			{Path: "z.md", Size: 1, MTime: "2026-10-20T22:00:00.123456789Z", SHA256: strings.Repeat("a", 64), WrittenAt: "2026-10-20T22:43:41Z"},
			{Path: "notes/a.md", Size: 0, MTime: "2026-10-20T22:00:00Z", SHA256: strings.Repeat("b", 64), WrittenAt: "2026-10-20T22:43:41Z"},
		},
	}
}

func TestMarshalParseRoundTripSorts(t *testing.T) {
	data := Marshal(sample())
	m, err := Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	if m.Files[0].Path != "notes/a.md" || m.Files[1].MTime != "2026-10-20T22:00:00.123456789Z" {
		t.Fatalf("%+v", m.Files)
	}
	path := filepath.Join(t.TempDir(), "m.json")
	if err := Save(path, m); err != nil {
		t.Fatal(err)
	}
	loaded, ok, err := Load(path)
	if err != nil || !ok || len(loaded.Files) != 2 {
		t.Fatalf("%+v %v %v", loaded, ok, err)
	}
	empty, ok, err := Load(filepath.Join(t.TempDir(), "none.json"))
	if err != nil || ok || len(empty.Files) != 0 {
		t.Fatal("a missing manifest is an empty one")
	}
}

func TestValidateRejects(t *testing.T) {
	mutations := map[string]func(*Manifest){
		"schema":       func(m *Manifest) { m.Schema = "folder-sync-manifest/2" },
		"host id":      func(m *Manifest) { m.HostID = "laptop" },
		"generated_at": func(m *Manifest) { m.GeneratedAt = "yesterday" },
		"dotdot":       func(m *Manifest) { m.Files[0].Path = "../../.ssh/authorized_keys" },
		"absolute":     func(m *Manifest) { m.Files[0].Path = "/etc/passwd" },
		"backslash":    func(m *Manifest) { m.Files[0].Path = `a\b` },
		"duplicate":    func(m *Manifest) { m.Files[1].Path = m.Files[0].Path },
		"sha":          func(m *Manifest) { m.Files[0].SHA256 = "ABC" },
		"size":         func(m *Manifest) { m.Files[0].Size = -1 },
		"mtime":        func(m *Manifest) { m.Files[0].MTime = "" },
	}
	for name, mutate := range mutations {
		m := sample()
		mutate(&m)
		if err := m.Validate(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// TestSchemaFileAgrees keeps schema/manifest.schema.json in step with this package.
func TestSchemaFileAgrees(t *testing.T) {
	_, here, _, _ := runtime.Caller(0)
	data, err := os.ReadFile(filepath.Join(filepath.Dir(here), "..", "..", "schema", "manifest.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var schema struct {
		Required   []string `json:"required"`
		Properties struct {
			Schema struct {
				Const string `json:"const"`
			} `json:"schema"`
		} `json:"properties"`
		Defs struct {
			Entry struct {
				Required []string `json:"required"`
			} `json:"entry"`
		} `json:"$defs"`
	}
	if err := json.Unmarshal(data, &schema); err != nil {
		t.Fatal(err)
	}
	if schema.Properties.Schema.Const != Schema {
		t.Fatalf("schema const %q, package %q", schema.Properties.Schema.Const, Schema)
	}
	var top map[string]any
	json.Unmarshal(Marshal(sample()), &top)
	for _, key := range schema.Required {
		if _, ok := top[key]; !ok {
			t.Errorf("the schema requires %q, the package does not write it", key)
		}
	}
	entry := top["files"].([]any)[0].(map[string]any)
	for _, key := range schema.Defs.Entry.Required {
		if _, ok := entry[key]; !ok {
			t.Errorf("the schema requires files[].%s, the package does not write it", key)
		}
	}
}
