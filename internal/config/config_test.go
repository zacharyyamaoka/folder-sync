package config

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
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

func TestSharedModeIsRefusedInV0(t *testing.T) {
	dir := t.TempDir()
	c := New("demo", "folder-sync")
	c.Modes = map[string]string{"shared": ModeShared}
	if err := Write(dir, c); err != nil {
		t.Fatal(err)
	}
	_, err := Load(dir)
	var refusal ErrSharedIsV1
	if !errors.As(err, &refusal) || refusal.Subfolder != "shared" {
		t.Fatalf("want ErrSharedIsV1, got %v", err)
	}
	for _, phrase := range []string{"not available in v0", "_leases/", "bisync", "v1"} {
		if !strings.Contains(err.Error(), phrase) {
			t.Errorf("refusal does not say %q: %v", phrase, err)
		}
	}
}

func TestLoadRejects(t *testing.T) {
	cases := map[string]string{
		"unknown key":   "project = \"demo\"\nbucket = \"folder-sync\"\npasword = \"x\"\n",
		"bad project":   "project = \"_trash\"\nbucket = \"folder-sync\"\n",
		"bad bucket":    "project = \"demo\"\nbucket = \"Folder_Sync\"\n",
		"bad peers dir": "project = \"demo\"\nbucket = \"folder-sync\"\npeers_dir = \"../x\"\n",
		"bad interval":  "project = \"demo\"\nbucket = \"folder-sync\"\ninterval = \"100ms\"\n",
		"bad mode":      "project = \"demo\"\nbucket = \"folder-sync\"\n[modes]\nx = \"mirror\"\n",
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
