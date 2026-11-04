package syncer

import (
	"os"
	"path/filepath"
	"testing"

	"folder-sync/internal/config"
	"folder-sync/internal/host"
	"folder-sync/internal/s3"
	"folder-sync/internal/store"
	"folder-sync/internal/store/storetest"
)

// openWith opens a folder whose config names storeURL, with env as the environment.
func openWith(t *testing.T, storeURL string, env map[string]string) *Project {
	t.Helper()
	l := testLayout(t)
	if _, _, err := host.Ensure(l.HostFile); err != nil {
		t.Fatal(err)
	}
	folder := t.TempDir()
	cfg := config.New("demo", "folder-sync")
	if storeURL != "" {
		cfg.Store, cfg.Bucket = storeURL, ""
	}
	if err := config.Write(folder, cfg); err != nil {
		t.Fatal(err)
	}
	p, err := Open(folder, l, func(k string) string { return env[k] }, "rclone", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	return p
}

func TestObjectsIsTheS3ClientUntilAStoreIsSet(t *testing.T) {
	client := &s3.Client{}
	p := &Project{S3: client}
	if p.Objects() != store.Objects(client) {
		t.Errorf("Objects = %T", p.Objects())
	}
	if (&Project{}).Objects() != nil {
		t.Error("a project with no store has no objects")
	}
	other := &store.FileStore{Root: t.TempDir()}
	p.Store = other
	if p.Objects() != store.Objects(other) {
		t.Errorf("Objects = %T", p.Objects())
	}
}

func TestOpenAFileStoreNeedsNoKeyAndUsesTheLocalRemote(t *testing.T) {
	hub := filepath.ToSlash(t.TempDir())
	p := openWith(t, "file://"+hub, map[string]string{})
	if _, ok := p.Objects().(*store.FileStore); !ok {
		t.Fatalf("Objects = %T", p.Objects())
	}
	if p.Rclone.Store.Kind != store.File || p.Config.Bucket != hub || p.Root != "" {
		t.Errorf("rclone store %+v, bucket %q, root %q", p.Rclone.Store, p.Config.Bucket, p.Root)
	}
}

func TestOpenAnS3StoreProbesOnceAndGuardsWhatItLacks(t *testing.T) {
	fake := &storetest.FakeS3{IgnoreCreateOnce: true, IgnoreCopyIfMatch: true}
	endpoint := fake.Start(t)
	env := map[string]string{"FOLDER_SYNC_ACCESS_KEY_ID": "key12345", "FOLDER_SYNC_SECRET_ACCESS_KEY": "secret", "FOLDER_SYNC_ENDPOINT": endpoint}
	l := testLayout(t)
	host.Ensure(l.HostFile)
	folder := t.TempDir()
	cfg := config.New("demo", "")
	cfg.Store = "s3://folder-sync/team"
	if err := config.Write(folder, cfg); err != nil {
		t.Fatal(err)
	}
	open := func() *Project {
		p, err := Open(folder, l, func(k string) string { return env[k] }, "rclone", nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(p.Close)
		return p
	}
	p := open()
	if p.Root != "team/" || p.Rclone.Creds.Endpoint != endpoint {
		t.Errorf("root %q, endpoint %q", p.Root, p.Rclone.Creds.Endpoint)
	}
	if p.Caps != (store.Capabilities{PutIfMatch: true, GetIfMatch: true}) {
		t.Errorf("caps = %+v", p.Caps)
	}
	if _, ok := p.Objects().(*s3.Client); ok {
		t.Error("a store that lacks create-once must be guarded")
	}
	probed := fake.Saw("_probe/")
	if probed == 0 {
		t.Fatal("nothing was probed")
	}
	// the second open reads the cache
	open()
	if fake.Saw("_probe/") != probed {
		t.Errorf("a second Open probed again")
	}
	if _, err := os.Stat(filepath.Join(p.StateDir, "store-caps.json")); err != nil {
		t.Error(err)
	}
}

func TestOpenR2IsNotProbedOrGuarded(t *testing.T) {
	fake := &storetest.FakeS3{}
	endpoint := fake.Start(t)
	p := openWith(t, "", map[string]string{"FOLDER_SYNC_ACCESS_KEY_ID": "key12345", "FOLDER_SYNC_SECRET_ACCESS_KEY": "secret", "FOLDER_SYNC_ENDPOINT": endpoint})
	if _, ok := p.Objects().(*s3.Client); !ok {
		t.Errorf("Objects = %T", p.Objects())
	}
	if len(fake.Seen) != 0 {
		t.Errorf("R2 is trusted as before; the open made requests: %v", fake.Seen)
	}
}

// WHY an override: an operator who knows better than the probe (a store that answers a probe one way and a busy day another),
// and the e2e, which proves the guarded path on a real server that honours everything.
func TestStoreCapsOverrideSkipsTheProbe(t *testing.T) {
	fake := &storetest.FakeS3{}
	endpoint := fake.Start(t)
	p := openWith(t, "s3://folder-sync", map[string]string{"FOLDER_SYNC_ACCESS_KEY_ID": "key12345", "FOLDER_SYNC_SECRET_ACCESS_KEY": "secret",
		"FOLDER_SYNC_ENDPOINT": endpoint, "FOLDER_SYNC_STORE_CAPS": "none"})
	if p.Caps != (store.Capabilities{}) {
		t.Errorf("caps = %+v", p.Caps)
	}
	if _, ok := p.Objects().(*s3.Client); ok {
		t.Error("with nothing honoured the store must be guarded")
	}
	if len(fake.Seen) != 0 {
		t.Errorf("an override is not probed: %v", fake.Seen)
	}
}
