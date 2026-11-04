package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"folder-sync/internal/config"
	"folder-sync/internal/creds"
	"folder-sync/internal/store"
	"folder-sync/internal/store/storetest"
)

func TestInitWithAFileStoreNeedsNoKey(t *testing.T) {
	l, _ := sandbox(t)
	hub := filepath.ToSlash(t.TempDir())
	folder := t.TempDir()
	code, out, errOut := runCmd("init", "--project", "demo", "--store", "file://"+hub, "--dir", folder)
	if code != 0 {
		t.Fatalf("code %d\nstdout %s\nstderr %s", code, out, errOut)
	}
	cfg, err := config.Load(folder)
	if err != nil || cfg.Store != "file://"+hub || cfg.Bucket != hub {
		t.Fatalf("config %+v %v", cfg, err)
	}
	if !strings.Contains(out, "store:") || !strings.Contains(out, hub) || strings.Contains(out, "key:    none yet") {
		t.Errorf("output:\n%s", out)
	}
	if entries, _ := os.ReadDir(l.Projects); len(entries) != 1 {
		t.Errorf("init registers the folder: %v", entries)
	}
}

// WHY: an unmounted NAS is a missing directory; creating it would sync onto the local disk under the mount point
func TestInitWithAMissingFileStoreFailsAndCreatesNothing(t *testing.T) {
	sandbox(t)
	missing := filepath.Join(t.TempDir(), "nas", "hub")
	code, out, errOut := runCmd("init", "--project", "demo", "--store", "file://"+filepath.ToSlash(missing), "--dir", t.TempDir())
	if code == 0 || !strings.Contains(out+errOut, "does not exist") {
		t.Fatalf("code %d\n%s%s", code, out, errOut)
	}
	if _, err := os.Stat(missing); err == nil {
		t.Fatal("the store's directory was created")
	}
}

func TestInitWithAnS3StoreChecksThePrefixAndProbesTheProvider(t *testing.T) {
	l, _ := sandbox(t)
	fake := &storetest.FakeS3{IgnoreCopyIfMatch: true}
	endpoint := fake.Start(t)
	t.Setenv(creds.EnvAccessKeyID, "AKID1234")
	t.Setenv(creds.EnvSecretAccessKey, "secret-value")
	t.Setenv(creds.EnvEndpoint, endpoint)
	folder := t.TempDir()
	code, out, errOut := runCmd("init", "--project", "demo", "--store", "s3://folder-sync/team", "--dir", folder)
	if code != 0 {
		t.Fatalf("code %d\n%s%s", code, out, errOut)
	}
	cfg, err := config.Load(folder)
	if err != nil || cfg.Store != "s3://folder-sync/team" || cfg.Bucket != "folder-sync" {
		t.Fatalf("config %+v %v", cfg, err)
	}
	for _, want := range []string{`can reach prefix "team/" in bucket "folder-sync"`, "store:", "copy-if-match"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out+errOut, "secret-value") {
		t.Fatalf("a secret reached the output:\n%s%s", out, errOut)
	}
	if got := fake.Saw("_probe/"); got == 0 {
		t.Error("init did not probe the store")
	}
	if n := fake.Keys(); len(n) != 0 {
		t.Errorf("the probe left %v", n)
	}
	matches, _ := filepath.Glob(filepath.Join(l.Projects, "demo-*", "store-caps.json"))
	if len(matches) != 1 {
		t.Errorf("init caches the probe next to the project: %v", matches)
	}
}

func TestInitStoreAndBucketAreExclusive(t *testing.T) {
	sandbox(t)
	code, _, errOut := runCmd("init", "--store", "file:///tmp/x", "--bucket", "folder-sync", "--dir", t.TempDir())
	if code == 0 || !strings.Contains(errOut, "--store") {
		t.Fatalf("code %d %q", code, errOut)
	}
}

func TestInitRefusesAStoreThatDiffersFromTheConfig(t *testing.T) {
	sandbox(t)
	folder := t.TempDir()
	hub := filepath.ToSlash(t.TempDir())
	if code, out, errOut := runCmd("init", "--project", "demo", "--store", "file://"+hub, "--dir", folder); code != 0 {
		t.Fatalf("%d %s%s", code, out, errOut)
	}
	other := filepath.ToSlash(t.TempDir())
	if code, _, errOut := runCmd("init", "--project", "demo", "--store", "file://"+other, "--dir", folder); code == 0 || !strings.Contains(errOut, "already") {
		t.Fatalf("code %d %q", code, errOut)
	}
	if code, _, errOut := runCmd("init", "--project", "demo", "--store", "file://"+hub, "--dir", folder); code != 0 {
		t.Fatalf("the same store again: %d %q", code, errOut)
	}
}

// WHY: this machine's sign-in is for the accounts Worker's R2; handing its keys to an S3 or Google endpoint would send them to the wrong party
func TestSignInIsNotUsedForAnotherStore(t *testing.T) {
	l, _ := sandbox(t)
	signIn(t, l, "http://127.0.0.1:1")
	self := func() (string, error) { return "/opt/folder-sync/bin/folder-sync", nil }
	for _, raw := range []string{"s3://my-bucket", "gs://my-bucket", "file:///srv/hub"} {
		spec, _ := store.Parse(raw)
		if env := credentialEnvFor(l, spec, os.Getenv, self); env(creds.EnvCredentialProcess) != "" {
			t.Errorf("%s: the account's credential process was injected", raw)
		}
	}
	spec, _ := store.Parse("r2://folder-sync")
	if env := credentialEnvFor(l, spec, os.Getenv, self); env(creds.EnvCredentialProcess) == "" {
		t.Error("r2:// must still use the sign-in")
	}
}

// WHY: the R2-Explorer viewer and the online visibility switch are Cloudflare's (the Worker's R2); on another store
// they would write config for a bucket that is not there.
func TestCloudflareOnlyCommandsRefuseOtherStores(t *testing.T) {
	sandbox(t)
	folder := t.TempDir()
	hub := filepath.ToSlash(t.TempDir())
	if code, out, errOut := runCmd("init", "--project", "demo", "--store", "file://"+hub, "--dir", folder); code != 0 {
		t.Fatalf("%d %s%s", code, out, errOut)
	}
	for _, args := range [][]string{{"publish", "--viewer", "--dir", folder}, {"publish", "--public", "--dir", folder}, {"publish", "--private", "--dir", folder}} {
		code, _, errOut := runCmd(args...)
		if code == 0 || !strings.Contains(errOut, "Cloudflare") {
			t.Errorf("%v: code %d, stderr %q", args, code, errOut)
		}
	}
}
