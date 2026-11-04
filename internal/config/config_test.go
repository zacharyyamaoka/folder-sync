package config

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"folder-sync/internal/testtools"
)

func TestRenderLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	c := New("demo", "folder-sync")
	c.Ignore = []string{"*.tmp", "build/"}
	c.Modes = map[string]string{"notes": ModePush}
	c.Viewer = Viewer{AccessTeam: "bam", Domain: "files.example.com"}
	if err := Write(dir, c); err != nil {
		t.Fatal(err)
	}
	got, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, c) {
		t.Fatalf("got %+v\nwant %+v", got, c)
	}
	if got.IntervalDuration().Seconds() != 10 {
		t.Fatal(got.Interval)
	}
}

func TestSharedModeInModesPointsAtShare(t *testing.T) {
	dir := t.TempDir()
	c := New("demo", "folder-sync")
	c.Modes = map[string]string{"shared": ModeShared}
	if err := Write(dir, c); err != nil {
		t.Fatal(err)
	}
	_, err := Load(dir)
	var refusal ErrUseShare
	if !errors.As(err, &refusal) || refusal.Subfolder != "shared" {
		t.Fatalf("want ErrUseShare, got %v", err)
	}
	for _, phrase := range []string{"not a setting", "folder-sync share", "--private"} {
		if !strings.Contains(err.Error(), phrase) {
			t.Errorf("refusal does not say %q: %v", phrase, err)
		}
	}
}

func TestLoadRejects(t *testing.T) {
	cases := map[string]string{
		"unknown key":              "project = \"demo\"\nbucket = \"folder-sync\"\npasword = \"x\"\n",
		"bad project":              "project = \"_trash\"\nbucket = \"folder-sync\"\n",
		"bad bucket":               "project = \"demo\"\nbucket = \"Folder_Sync\"\n",
		"bad peers dir":            "project = \"demo\"\nbucket = \"folder-sync\"\npeers_dir = \"../x\"\n",
		"history_every under 30s":  "project = \"demo\"\nbucket = \"folder-sync\"\nhistory_every = \"10s\"\n",
		"history_every not a time": "project = \"demo\"\nbucket = \"folder-sync\"\nhistory_every = \"often\"\n",
		"bad interval":             "project = \"demo\"\nbucket = \"folder-sync\"\ninterval = \"100ms\"\n",
		"bad mode":                 "project = \"demo\"\nbucket = \"folder-sync\"\n[modes]\nx = \"mirror\"\n",
	}
	for name, body := range cases {
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, FileName), []byte(body), 0o644)
		if _, err := Load(dir); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := Load(t.TempDir()); err == nil || !strings.Contains(err.Error(), "folder-sync init") {
		t.Errorf("missing config: %v", err)
	}
}

func TestFindWalksUp(t *testing.T) {
	dir := t.TempDir()
	Write(dir, New("demo", "folder-sync"))
	deep := filepath.Join(dir, "a", "b")
	os.MkdirAll(deep, 0o755)
	got, err := Find(deep)
	if err != nil || got != dir {
		t.Fatalf("Find = %q, %v", got, err)
	}
}

func TestProjectFromFolder(t *testing.T) {
	cases := map[string]string{"/x/My Notes": "my-notes", "/x/vibetracks": "vibetracks", "/x/_hidden": "hidden", "/x/日本": "project", "/x/___": "project"}
	for in, want := range cases {
		got := ProjectFromFolder(in)
		if got != want {
			t.Errorf("ProjectFromFolder(%q) = %q, want %q", in, got, want)
		}
		if err := ValidateProject(got); err != nil {
			t.Error(err)
		}
	}
}

// TestNoHistoryDefaultAndEmpty (PEP 0007 §10.6): an absent no_history is ["*.log"]; `no_history = []` keeps every
// version, *.log included; a written config round-trips its own list.
func TestNoHistoryDefaultAndEmpty(t *testing.T) {
	for name, tc := range map[string]struct {
		line string
		want []string
	}{
		"absent": {"", []string{"*.log"}},
		"empty":  {"no_history = []\n", []string{}},
		"own":    {"no_history = [\"*.csv\", \"big/\"]\n", []string{"*.csv", "big/"}},
	} {
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, FileName), []byte("project = \"demo\"\nbucket = \"folder-sync\"\n"+tc.line), 0o644)
		got, err := Load(dir)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !reflect.DeepEqual(got.NoHistory, tc.want) {
			t.Errorf("%s: no_history = %#v, want %#v", name, got.NoHistory, tc.want)
		}
		if err := Write(dir, got); err != nil {
			t.Fatal(err)
		}
		again, err := Load(dir)
		if err != nil || !reflect.DeepEqual(again.NoHistory, tc.want) {
			t.Errorf("%s: after Write, no_history = %#v (%v)", name, again.NoHistory, err)
		}
	}
	if New("demo", "folder-sync").NoHistory[0] != "*.log" {
		t.Error("a new config starts with no_history = [\"*.log\"]")
	}
}

// TestHistoryEvery (PEP 0009 §5): five minutes unless the file says otherwise, and never less than 30 s.
func TestHistoryEvery(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, FileName), []byte("project = \"demo\"\nbucket = \"folder-sync\"\n"), 0o644)
	c, err := Load(dir)
	if err != nil || c.HistoryEvery != "5m" || c.HistoryEveryDuration().Minutes() != 5 {
		t.Fatalf("absent: %+v %v", c, err)
	}
	os.WriteFile(filepath.Join(dir, FileName), []byte("project = \"demo\"\nbucket = \"folder-sync\"\nhistory_every = \"45s\"\n"), 0o644)
	c, err = Load(dir)
	if err != nil || c.HistoryEveryDuration().Seconds() != 45 {
		t.Fatalf("45s: %+v %v", c, err)
	}
	c.HistoryEvery = "2m"
	if err := Write(dir, c); err != nil {
		t.Fatal(err)
	}
	if again, err := Load(dir); err != nil || again.HistoryEvery != "2m" {
		t.Fatalf("written and read back: %+v %v", again, err)
	}
}

// The store is a URL (docs/STORAGE.md). A config that names only a bucket is r2://<bucket>, as before.
func TestStoreURLRoundTrip(t *testing.T) {
	dir := t.TempDir()
	c := New("demo", "")
	c.Store = "s3://my-bucket/team?region=eu-west-1"
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	if c.Bucket != "my-bucket" {
		t.Fatalf("Validate must derive the bucket from the store, got %q", c.Bucket)
	}
	if err := Write(dir, c); err != nil {
		t.Fatal(err)
	}
	text, _ := os.ReadFile(filepath.Join(dir, FileName))
	if !strings.Contains(string(text), `store = "s3://my-bucket/team?region=eu-west-1"`) || strings.Contains(string(text), "\nbucket =") {
		t.Errorf("a store config names the store and not a bucket:\n%s", text)
	}
	got, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, c) {
		t.Fatalf("got %+v\nwant %+v", got, c)
	}
	spec := got.StoreSpec()
	if spec.Kind != "s3" || spec.Bucket != "my-bucket" || spec.Prefix != "team/" || spec.Region != "eu-west-1" {
		t.Errorf("StoreSpec = %+v", spec)
	}
}

func TestNoStoreMeansR2(t *testing.T) {
	c := New("demo", "folder-sync")
	if spec := c.StoreSpec(); spec.Kind != "r2" || spec.Bucket != "folder-sync" {
		t.Errorf("StoreSpec = %+v", spec)
	}
	if text := Render(c); !strings.Contains(text, `bucket = "folder-sync"`) || strings.Contains(text, "store =") {
		t.Errorf("a v0 config is rendered as before:\n%s", text)
	}
}

func TestFileStoreConfig(t *testing.T) {
	dir := t.TempDir()
	hub := filepath.ToSlash(filepath.Join(dir, "hub"))
	if err := os.WriteFile(filepath.Join(dir, FileName), []byte("project = \"demo\"\nstore = \""+testtools.FileURL(hub)+"\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	c, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if c.Bucket != hub || c.StoreSpec().Kind != "file" {
		t.Errorf("bucket %q, spec %+v", c.Bucket, c.StoreSpec())
	}
}

func TestLoadRejectsBadStores(t *testing.T) {
	cases := map[string]string{
		"unknown scheme":           "project = \"demo\"\nstore = \"ftp://x/y\"\n",
		"relative file store":      "project = \"demo\"\nstore = \"file://rel/dir\"\n",
		"bucket disagrees":         "project = \"demo\"\nbucket = \"other-bucket\"\nstore = \"s3://my-bucket\"\n",
		"bad bucket in store":      "project = \"demo\"\nstore = \"s3://BAD\"\n",
		"neither store nor bucket": "project = \"demo\"\n",
	}
	for name, body := range cases {
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, FileName), []byte(body), 0o644)
		if _, err := Load(dir); err == nil {
			t.Errorf("%s: Load succeeded", name)
		}
	}
	// the bucket may be repeated beside the store when it is the same one
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, FileName), []byte("project = \"demo\"\nbucket = \"my-bucket\"\nstore = \"s3://my-bucket\"\n"), 0o644)
	if _, err := Load(dir); err != nil {
		t.Errorf("the same bucket beside its store: %v", err)
	}
}
