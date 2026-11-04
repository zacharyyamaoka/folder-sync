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
			Kind                                                      string
			Size                                                      int64
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
		kind := Kind(want.Kind)
		if kind == "" {
			kind = KindFull
		}
		if got.Kind != kind || (kind != KindFull && got.Size != want.Size) {
			t.Errorf("%s: kind %q size %d, want %q %d", want.Key, got.Kind, got.Size, kind, want.Size)
		}
		if built := KeyOf(want.Root, want.Project, want.Host, want.Path, want.Version, kind, want.Size); built != want.Key {
			t.Errorf("KeyOf() = %q, want %q", built, want.Key)
		}
		if kind == KindFull {
			if built := Key(want.Root, want.Project, want.Host, want.Path, want.Version); built != want.Key {
				t.Errorf("Key() = %q, want %q", built, want.Key)
			}
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
			EveryMs   int64    `json:"every_ms"`
			Leaving   struct {
				WrittenAt string `json:"written_at"`
			} `json:"leaving"`
			LastKeptLeftAt      *string `json:"last_kept_left_at"`
			NewestKeptIsPointer bool    `json:"newest_kept_is_pointer"`
			AppendUploaded      bool    `json:"append_uploaded"`
			Keep                bool    `json:"keep"`
			Why                 string  `json:"why"`
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
		keep, why := Keep(Write{Op: c.Op, Path: c.Path, WrittenAt: mustTime(t, c.Leaving.WrittenAt), At: mustTime(t, c.Now), LastKept: last,
			Every: time.Duration(c.EveryMs) * time.Millisecond, NewestKeptIsPointer: c.NewestKeptIsPointer, AppendUploaded: c.AppendUploaded}, matcher)
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

// TestAnchorFixture: every anchor case in testdata/retention/schedule.json, over the names of every form.
func TestAnchorFixture(t *testing.T) {
	var doc struct {
		AnchorCases []struct {
			Name     string `json:"name"`
			Now      string `json:"now"`
			KeepDays int    `json:"keep_days"`
			Live     bool   `json:"live"`
			Versions []struct {
				Name   string `json:"name"`
				LeftAt string `json:"left_at"`
			} `json:"versions"`
			Keep         []string `json:"keep"`
			DropPointers []string `json:"drop_pointers"`
			Drop         []string `json:"drop"`
			Lost         []string `json:"lost"`
		} `json:"anchor_cases"`
	}
	readFixture(t, "retention/schedule.json", &doc)
	if len(doc.AnchorCases) == 0 {
		t.Fatal("no anchor cases")
	}
	names := func(versions []Version) []string {
		out := []string{}
		for _, v := range versions {
			out = append(out, Name(v.Version, v.Kind, v.Size))
		}
		sort.Strings(out)
		return out
	}
	sorted := func(in []string) []string {
		out := append([]string{}, in...)
		sort.Strings(out)
		return out
	}
	for _, c := range doc.AnchorCases {
		var versions []Version
		for _, v := range c.Versions {
			id, kind, size, err := ParseName(v.Name)
			if err != nil {
				t.Fatalf("%s: %v", c.Name, err)
			}
			versions = append(versions, Version{Path: "notes/plan.md", Version: id, Kind: kind, Size: size, LeftAt: mustTime(t, v.LeftAt)})
		}
		plan := PruneGroup(versions, mustTime(t, c.Now), c.KeepDays, c.Live)
		for label, got := range map[string][]string{"keep": names(plan.Keep), "drop_pointers": names(plan.DropPointers), "drop": names(plan.Drop), "lost": names(plan.Lost)} {
			want := map[string][]string{"keep": c.Keep, "drop_pointers": c.DropPointers, "drop": c.Drop, "lost": c.Lost}[label]
			if strings.Join(got, ",") != strings.Join(sorted(want), ",") {
				t.Errorf("%s: %s\n got %v\n want %v", c.Name, label, got, sorted(want))
			}
		}
		if len(plan.Keep)+len(plan.DropPointers)+len(plan.Drop) != len(versions) {
			t.Errorf("%s: every object is kept or dropped once", c.Name)
		}
		// idempotent: a second prune of what is kept drops nothing (a kept pointer's anchor is kept with it)
		again := PruneGroup(plan.Keep, mustTime(t, c.Now), c.KeepDays, c.Live)
		if len(again.DropPointers)+len(again.Drop) != 0 {
			t.Errorf("%s: a second prune dropped %d more", c.Name, len(again.DropPointers)+len(again.Drop))
		}
	}
}

// TestNamesAreRoundTripped: a name parses to its version, form and size, and builds back; the forms an unlisted
// version or a malformed size cannot take are refused.
func TestNamesAreRoundTripped(t *testing.T) {
	const id = "2026-10-28T20:31:00.117Z_9f2c1a3b4c5d6e7f"
	for _, tc := range []struct {
		name string
		kind Kind
		size int64
	}{{id, KindFull, 0}, {id + ".1980.zst", KindZst, 1980}, {id + ".4194304.prefix", KindPrefix, 4194304}, {id + ".1.zst", KindZst, 1}} {
		gotID, kind, size, err := ParseName(tc.name)
		if err != nil || gotID != id || kind != tc.kind || size != tc.size {
			t.Errorf("%s: %q %q %d %v", tc.name, gotID, kind, size, err)
		}
		if built := Name(id, kind, size); built != tc.name {
			t.Errorf("Name = %q, want %q", built, tc.name)
		}
	}
	for _, bad := range []string{id + ".zst", id + ".01.zst", id + ".12.gz", id + ".-1.prefix", id + ".12.zst.prefix", "2026-10-28T20:31:00.117Z_unlisted.12.zst", id + ".", ""} {
		if _, _, _, err := ParseName(bad); err == nil {
			t.Errorf("%q is accepted", bad)
		}
	}
}

// TestPrefixBodies: testdata/prefix/pointer.json, the bytes the engine writes and what a reader refuses.
func TestPrefixBodies(t *testing.T) {
	var doc struct {
		Valid []struct {
			Name string `json:"name"`
			JSON string `json:"json"`
		} `json:"valid"`
		Invalid []struct {
			Why  string `json:"why"`
			JSON string `json:"json"`
		} `json:"invalid"`
	}
	readFixture(t, "prefix/pointer.json", &doc)
	if len(doc.Valid) == 0 || len(doc.Invalid) == 0 {
		t.Fatal("the fixture is empty")
	}
	for _, v := range doc.Valid {
		body, err := ParsePrefixBody([]byte(v.JSON))
		if err != nil {
			t.Fatalf("%s: %v", v.Name, err)
		}
		if got := string(body.Marshal()); got != v.JSON {
			t.Errorf("Marshal = %s, want %s", got, v.JSON)
		}
		if len(body.Marshal()) > 130 {
			t.Errorf("a pointer is about 125 bytes, this one %d", len(body.Marshal()))
		}
		if id, kind, size, err := ParseName(v.Name); err != nil || kind != KindPrefix || size != body.Size || !strings.HasSuffix(id, body.SHA256[:16]) {
			t.Errorf("%s does not name its body: %q %q %d %v", v.Name, id, kind, size, err)
		}
	}
	for _, v := range doc.Invalid {
		if _, err := ParsePrefixBody([]byte(v.JSON)); err == nil {
			t.Errorf("%s is accepted: %s", v.Why, v.JSON)
		}
	}
}

// TestPinOutranksTheThrottleButNotNoHistory: the rule's order (PEP 0009 §5): no_history, then delete and restore,
// then the pin, then the version's age, then the window.
func TestPinOutranksTheThrottleButNotNoHistory(t *testing.T) {
	now := mustTime(t, "2026-11-04T12:00:00Z")
	base := Write{Op: OpReplace, Path: "a.md", WrittenAt: now.Add(-time.Minute), At: now, LastKept: now.Add(-time.Minute)}
	if keep, why := Keep(base, nil); keep || why != WhyBurst {
		t.Fatalf("the throttle: %v %q", keep, why)
	}
	pinned := base
	pinned.NewestKeptIsPointer = true
	if keep, _ := Keep(pinned, nil); !keep {
		t.Fatal("a pointer's pin keeps the leaving version inside the window")
	}
	pinned.AppendUploaded = true
	if keep, why := Keep(pinned, nil); keep || why != WhyBurst {
		t.Fatalf("an append the writer uploads itself leaves the pointer resting on live bytes: %v %q", keep, why)
	}
	logs, _ := NewMatcher([]string{"*.log"})
	pinned = Write{Op: OpReplace, Path: "run.log", WrittenAt: now.Add(-time.Minute), At: now, NewestKeptIsPointer: true}
	if keep, why := Keep(pinned, logs); keep || why != WhyNoHistory {
		t.Fatalf("no_history outranks the pin: %v %q", keep, why)
	}
	// the default window is five minutes, and a folder's own is honoured
	old := Write{Op: OpReplace, Path: "a.md", WrittenAt: now.Add(-4 * time.Minute), At: now, LastKept: now.Add(-4 * time.Minute)}
	if keep, _ := Keep(old, nil); keep {
		t.Fatal("4 minutes into the default 5-minute window")
	}
	old.Every = 30 * time.Second
	if keep, _ := Keep(old, nil); !keep {
		t.Fatal("history_every = 30s keeps it")
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
