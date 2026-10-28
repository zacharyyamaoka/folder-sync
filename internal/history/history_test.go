package history

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"
)

var repo = func() string {
	_, here, _, _ := runtime.Caller(0)
	return filepath.Dir(filepath.Dir(filepath.Dir(here)))
}()

func readFixture(t *testing.T, rel string, into any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(repo, "testdata", rel))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, into); err != nil {
		t.Fatalf("%s: %v", rel, err)
	}
}

func mustTime(t *testing.T, s string) time.Time {
	t.Helper()
	at, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		t.Fatal(err)
	}
	return at
}

// TestKeysFixture: every valid key in testdata/history/keys.json parses into its parts and is built back from them,
// and every invalid version id and key is refused.
func TestKeysFixture(t *testing.T) {
	var doc struct {
		Valid []struct {
			Key, Root, Project, Host, Path, Version, WrittenAt, SHA16 string
			Unlisted                                                  bool
		} `json:"valid"`
		InvalidVersionIDs []string `json:"invalid_version_ids"`
		InvalidKeys       []string `json:"invalid_keys"`
	}
	readFixture(t, "history/keys.json", &doc)
	if len(doc.Valid) == 0 || len(doc.InvalidVersionIDs) == 0 || len(doc.InvalidKeys) == 0 {
		t.Fatal("the fixture is empty")
	}
	var raw struct {
		Valid []map[string]any `json:"valid"`
	}
	readFixture(t, "history/keys.json", &raw)
	for i, want := range doc.Valid {
		writtenAt, _ := raw.Valid[i]["written_at"].(string)
		sha16, _ := raw.Valid[i]["sha16"].(string)
		got, err := ParseKey(want.Key)
		if err != nil {
			t.Errorf("%s: %v", want.Key, err)
			continue
		}
		if got.Root != want.Root || got.Project != want.Project || got.Host != want.Host || got.Path != want.Path ||
			got.Version != want.Version || got.Unlisted != want.Unlisted || got.WrittenAt != writtenAt || got.SHA16 != sha16 {
			t.Errorf("%s:\n got %+v\nwant root=%q project=%q host=%q path=%q version=%q written_at=%q sha16=%q unlisted=%v",
				want.Key, got, want.Root, want.Project, want.Host, want.Path, want.Version, writtenAt, sha16, want.Unlisted)
		}
		if built := Key(want.Root, want.Project, want.Host, want.Path, want.Version); built != want.Key {
			t.Errorf("Key() = %q, want %q", built, want.Key)
		}
		if !want.Unlisted {
			id, err := VersionID(writtenAt, sha16+strings.Repeat("0", 48))
			if err != nil || id != want.Version {
				t.Errorf("VersionID(%s, %s…) = %q %v, want %q", writtenAt, sha16, id, err, want.Version)
			}
		}
	}
	for _, id := range doc.InvalidVersionIDs {
		if ValidVersionID(id) {
			t.Errorf("version id %q is accepted", id)
		}
	}
	for _, key := range doc.InvalidKeys {
		if v, err := ParseKey(key); err == nil {
			t.Errorf("key %q is accepted: %+v", key, v)
		}
	}
}

// TestVersionIDTruncatesToTheMillisecond (PEP 0007 §14.6): the engine's written_at has nanoseconds; the id truncates.
func TestVersionIDTruncatesToTheMillisecond(t *testing.T) {
	id, err := VersionID("2026-10-28T20:31:00.117999999Z", "9f2c1a3b4c5d6e7f00112233445566778899aabbccddeeff0011223344556677")
	if err != nil || id != "2026-10-28T20:31:00.117Z_9f2c1a3b4c5d6e7f" {
		t.Fatalf("%q %v", id, err)
	}
	if got := UnlistedID(mustTime(t, "2026-10-28T20:00:00.9999Z")); got != "2026-10-28T20:00:00.999Z_unlisted" {
		t.Fatal(got)
	}
}

// TestWriteRuleFixture: every write case in testdata/retention/schedule.json.
func TestWriteRuleFixture(t *testing.T) {
	var doc struct {
		WriteCases []struct {
			Name      string   `json:"name"`
			Now       string   `json:"now"`
			Op        string   `json:"op"`
			Path      string   `json:"path"`
			NoHistory []string `json:"no_history"`
			Leaving   struct {
				WrittenAt string `json:"written_at"`
			} `json:"leaving"`
			LastKeptLeftAt *string `json:"last_kept_left_at"`
			Keep           bool    `json:"keep"`
			Why            string  `json:"why"`
		} `json:"write_cases"`
	}
	readFixture(t, "retention/schedule.json", &doc)
	if len(doc.WriteCases) == 0 {
		t.Fatal("no write cases")
	}
	for _, c := range doc.WriteCases {
		matcher, err := NewMatcher(c.NoHistory)
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		var last time.Time
		if c.LastKeptLeftAt != nil {
			last = mustTime(t, *c.LastKeptLeftAt)
		}
		keep, why := Keep(c.Op, c.Path, mustTime(t, c.Leaving.WrittenAt), mustTime(t, c.Now), last, matcher)
		if keep != c.Keep || why != c.Why {
			t.Errorf("%s: keep=%v why=%q, want keep=%v why=%q", c.Name, keep, why, c.Keep, c.Why)
		}
	}
}

// TestPruneFixture: every prune case in testdata/retention/schedule.json.
func TestPruneFixture(t *testing.T) {
	var doc struct {
		PruneCases []struct {
			Name     string `json:"name"`
			Now      string `json:"now"`
			KeepDays int    `json:"keep_days"`
			Versions []struct {
				ID     string `json:"id"`
				LeftAt string `json:"left_at"`
			} `json:"versions"`
			Keep []string `json:"keep"`
		} `json:"prune_cases"`
	}
	readFixture(t, "retention/schedule.json", &doc)
	if len(doc.PruneCases) == 0 {
		t.Fatal("no prune cases")
	}
	for _, c := range doc.PruneCases {
		var versions []Version
		for _, v := range c.Versions {
			versions = append(versions, Version{Path: "notes/plan.md", Version: v.ID, LeftAt: mustTime(t, v.LeftAt)})
		}
		keep, drop := Prune(versions, mustTime(t, c.Now), c.KeepDays)
		var got []string
		for _, v := range keep {
			got = append(got, v.Version)
		}
		sort.Strings(got)
		want := append([]string{}, c.Keep...)
		sort.Strings(want)
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("%s:\n kept %v\n want %v", c.Name, got, want)
		}
		if len(keep)+len(drop) != len(versions) {
			t.Errorf("%s: %d kept + %d dropped of %d", c.Name, len(keep), len(drop), len(versions))
		}
		// idempotent: pruning what is kept keeps it all
		again, gone := Prune(keep, mustTime(t, c.Now), c.KeepDays)
		if len(gone) != 0 || len(again) != len(keep) {
			t.Errorf("%s: a second prune dropped %d more", c.Name, len(gone))
		}
	}
}

func TestMatcherIsGitignore(t *testing.T) {
	m, err := NewMatcher([]string{"*.log", "!keep.log", "/top/", "build/**", "tmp/"})
	if err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]bool{
		"a.log": true, "x/y/b.log": true, "keep.log": false, "x/keep.log": false, "run.log.md": false,
		"top/a.md": true, "x/top/a.md": false, "top": false, "build/a/b": true, "src/build/a": false,
		"tmp/a": true, "x/tmp/a": true, "tmp": false,
	} {
		if got := m.Match(path); got != want {
			t.Errorf("%s: %v, want %v", path, got, want)
		}
	}
}

func TestRequestsAndRecordsFixtures(t *testing.T) {
	paths, _ := filepath.Glob(filepath.Join(repo, "testdata", "requests", "*.json"))
	if len(paths) == 0 {
		t.Fatal("no request fixtures")
	}
	for _, path := range paths {
		var r Request
		data, _ := os.ReadFile(path)
		if err := json.Unmarshal(data, &r); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if err := r.Check(r.Project, r.Host); err != nil {
			t.Errorf("%s: %v", filepath.Base(path), err)
		}
		if err := r.Check(r.Project, "7c1d2e3f-0a1b-4c2d-8e3f-000000000000"); err == nil {
			t.Errorf("%s: a request for another host is accepted", filepath.Base(path))
		}
	}
	if got := ChangesKey("users/AbC123/", "notes", "b55e9683-7854-4121-a56a-9bae7c3ab1da", 43); got != "users/AbC123/_changes/notes/b55e9683-7854-4121-a56a-9bae7c3ab1da/000000000043.json" {
		t.Error(got)
	}
	if got := PullsKey("", "notes", "b55e9683-7854-4121-a56a-9bae7c3ab1da", "2026-10-28T20:41:01.900Z"); got != "_changes/notes/b55e9683-7854-4121-a56a-9bae7c3ab1da/pulls/2026-10-28T20:41:01.900Z.json" {
		t.Error(got)
	}
	prefix := TrashPrefix("", "demo", "h")
	if at, ok := TrashStampAge(prefix+"20261025T120000Z-789-1f2e3d4c/a.md", prefix); !ok || !at.Equal(time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)) {
		t.Errorf("trash stamp: %v %v", at, ok)
	}
}
