package syncer

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"folder-sync/internal/config"
	"folder-sync/internal/creds"
	"folder-sync/internal/host"
	"folder-sync/internal/rclone"
	"folder-sync/internal/s3"
)

const hostID = "b55e9683-7854-4121-a56a-9bae7c3ab1da"

// scripted is a fake rclone or credential process: a /bin/sh script in a temp dir.
// Every test also points HOME and USERPROFILE at a temp dir, never the real ~/.folder-sync.
func scripted(t *testing.T, name, body string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake programs are /bin/sh scripts")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Skip("cannot write a fake program here:", err)
	}
	return path
}

// argvRclone records its argv, one line per call, and answers lsjson with no folders.
func argvRclone(t *testing.T) (bin, argvFile string) {
	t.Helper()
	argvFile = filepath.Join(t.TempDir(), "argv")
	bin = scripted(t, "rclone", "echo \"$@\" >> "+argvFile+"\necho '[]'\n")
	return bin, argvFile
}

func demoProject(t *testing.T, root string) *Project {
	t.Helper()
	return &Project{
		Config:   config.New("demo", "folder-sync"),
		Host:     host.Host{ID: hostID, Name: "box"},
		Root:     root,
		StateDir: t.TempDir(),
		Now:      time.Now,
	}
}

func TestKeysStartWithTheRootAndAreUnchangedWithout(t *testing.T) {
	cases := []struct {
		root, hostPrefix, trash, hosts string
	}{
		{"users/AbC123/", "users/AbC123/demo/hosts/peer", "users/AbC123/_trash/demo/" + hostID + "/20261025T120000Z", "users/AbC123/demo/hosts"},
		{"a/b/", "a/b/demo/hosts/peer", "a/b/_trash/demo/" + hostID + "/20261025T120000Z", "a/b/demo/hosts"},
		{"", "demo/hosts/peer", "_trash/demo/" + hostID + "/20261025T120000Z", "demo/hosts"},
	}
	for _, tc := range cases {
		p := demoProject(t, tc.root)
		if got := p.HostPrefix("peer"); got != tc.hostPrefix {
			t.Errorf("root %q: HostPrefix = %q, want %q", tc.root, got, tc.hostPrefix)
		}
		if got := p.TrashPrefix("20261025T120000Z"); got != tc.trash {
			t.Errorf("root %q: TrashPrefix = %q, want %q", tc.root, got, tc.trash)
		}
		if got := p.HostsPrefix(); got != tc.hosts {
			t.Errorf("root %q: HostsPrefix = %q, want %q", tc.root, got, tc.hosts)
		}
	}
}

func TestDiscoverListsUnderTheRoot(t *testing.T) {
	for _, root := range []string{"users/AbC123/", ""} {
		bin, argvFile := argvRclone(t)
		p := demoProject(t, root)
		l := testLayout(t)
		p.Rclone = rclone.Runner{Bin: bin, Layout: l}
		if err := p.Discover(context.Background()); err != nil {
			t.Fatal(err)
		}
		data, _ := os.ReadFile(argvFile)
		if !strings.HasPrefix(string(data), "lsjson ") || !strings.HasSuffix(strings.TrimSpace(string(data)), " fsremote:folder-sync/"+root+"demo/hosts") {
			t.Errorf("root %q: rclone was run as %q", root, data)
		}
	}
}

func TestStateKeyKeepsV0DirsAndSeparatesRoots(t *testing.T) {
	// sha256("/home/bam/demo") starts f74ed6aa: the key every v0 state dir already has.
	if got := StateKey("demo", "/home/bam/demo", ""); got != "demo-f74ed6aa" {
		t.Fatalf("a v0 state dir must keep its key: %s", got)
	}
	a, b := StateKey("demo", "/home/bam/demo", "users/AbC123/"), StateKey("demo", "/home/bam/demo", "users/Other1/")
	if a == b || a == "demo-f74ed6aa" || b == "demo-f74ed6aa" {
		t.Fatalf("the root must be part of the key: %s %s", a, b)
	}
	if again := StateKey("demo", "/home/bam/demo", "users/AbC123/"); again != a {
		t.Fatal("the key must be stable")
	}
}

// refusalSetup is a project registered under users/AbC123/ whose credentials change.
func refusalSetup(t *testing.T, refresh func() (creds.Creds, error)) (*Project, string) {
	t.Helper()
	bin, argvFile := argvRclone(t)
	l := testLayout(t)
	p := demoProject(t, "users/AbC123/")
	p.Layout = l
	p.Folder = t.TempDir()
	p.StateDir = filepath.Join(l.Projects, "demo-x")
	p.Rclone = rclone.Runner{Bin: bin, Layout: l}
	p.S3 = &s3.Client{}
	p.Refresh = refresh
	if err := writeJSON(filepath.Join(p.StateDir, "project.json"), Registration{Schema: RegistrationSchema, Project: "demo",
		Bucket: "folder-sync", Folder: p.Folder, HostID: hostID, Root: "users/AbC123/"}); err != nil {
		t.Fatal(err)
	}
	return p, argvFile
}

func TestRoundRefusesAnotherRootOrBucket(t *testing.T) {
	cases := []struct {
		name  string
		creds creds.Creds
		want  string
	}{
		{"another person's root", creds.Creds{Prefix: "users/Other1/"}, "this folder syncs to account root users/AbC123/; these credentials are for users/Other1/: folder-sync never moves a folder's files into another account"},
		{"no root at all", creds.Creds{}, `this folder syncs to account root users/AbC123/; these credentials are for ""`},
		{"another bucket", creds.Creds{Prefix: "users/AbC123/", Bucket: "other-bucket"}, `bucket "folder-sync"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p, argvFile := refusalSetup(t, func() (creds.Creds, error) { return tc.creds, nil })
			_, err := p.Round(context.Background(), Options{})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want %q, got %v", tc.want, err)
			}
			if tc.name == "another bucket" && !strings.Contains(err.Error(), `"other-bucket"`) {
				t.Fatalf("the message must name both buckets: %v", err)
			}
			if tc.name != "another bucket" && !errors.Is(err, ErrRootChanged) {
				t.Fatalf("errors.Is(ErrRootChanged) = false for %v", err)
			}
			if _, statErr := os.Stat(argvFile); !errors.Is(statErr, os.ErrNotExist) {
				t.Fatal("a refused round must not run rclone")
			}
			if p.Root != "users/AbC123/" {
				t.Fatalf("a refused round must not change the root: %q", p.Root)
			}
			last, loadErr := LoadLastSync(p.StateDir)
			if loadErr != nil || last.OK || last.Root != "users/AbC123/" || !strings.Contains(last.Error, tc.want) {
				t.Fatalf("last-sync.json must record the refusal: %+v %v", last, loadErr)
			}
			if _, statErr := os.Stat(filepath.Join(p.StateDir, "lock")); !errors.Is(statErr, os.ErrNotExist) {
				t.Fatal("the lock must be released")
			}
		})
	}
}

func TestRoundSignedOutKeepsTheSentinel(t *testing.T) {
	p, _ := refusalSetup(t, func() (creds.Creds, error) {
		return creds.Creds{}, &creds.SignedOutError{Message: "this machine is signed out"}
	})
	_, err := p.Round(context.Background(), Options{})
	if !errors.Is(err, creds.ErrSignedOut) {
		t.Fatalf("%v", err)
	}
}

func TestRefreshSwapsTheKeysEverywhere(t *testing.T) {
	next := creds.Creds{AccessKeyID: "ASIA2", SecretAccessKey: "secret2", SessionToken: "tok2", Endpoint: "https://e2", Region: "auto", Prefix: "users/AbC123/", Bucket: "folder-sync"}
	p, _ := refusalSetup(t, func() (creds.Creds, error) { return next, nil })
	p.Creds = creds.Creds{AccessKeyID: "ASIA1", SessionToken: "tok1"}
	if err := p.refreshCreds(); err != nil {
		t.Fatal(err)
	}
	if p.Creds.SessionToken != "tok2" || p.Rclone.Creds.SessionToken != "tok2" || p.Rclone.Creds.AccessKeyID != "ASIA2" ||
		p.S3.SessionToken != "tok2" || p.S3.AccessKeyID != "ASIA2" || p.S3.SecretAccessKey != "secret2" || p.S3.Endpoint != "https://e2" {
		t.Fatalf("%+v %+v %+v", p.Creds, p.Rclone.Creds, p.S3)
	}
}

// processEnv makes Open resolve its keys from a fake credential process whose answer is in out.json.
func processEnv(t *testing.T, output string) func(string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "out.json"), []byte(output), 0o600); err != nil {
		t.Fatal(err)
	}
	script := scripted(t, "cred-process", "cat "+dir+"/out.json\n")
	argv, _ := json.Marshal([]string{script})
	return func(key string) string {
		if key == creds.EnvCredentialProcess {
			return string(argv)
		}
		return ""
	}
}

func accountOutput(prefix, bucket string) string {
	return `{"Version":1,"AccessKeyId":"ASIAEXAMPLE1234","SecretAccessKey":"very-secret-value","SessionToken":"tok-session-abcdef",` +
		`"Expiration":"2099-01-01T00:00:00Z","Endpoint":"https://acct.r2.cloudflarestorage.com","Bucket":"` + bucket + `","Prefix":"` + prefix + `"}`
}

func TestOpenBindsTheFolderToTheCredentialsRoot(t *testing.T) {
	l := testLayout(t)
	if _, _, err := host.Ensure(l.HostFile); err != nil {
		t.Fatal(err)
	}
	folder := t.TempDir()
	config.Write(folder, config.New("demo", "folder-sync"))

	p, err := Open(folder, l, processEnv(t, accountOutput("users/AbC123/", "folder-sync")), "rclone", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	abs, _ := filepath.Abs(folder)
	if p.Root != "users/AbC123/" || p.Creds.SessionToken != "tok-session-abcdef" || p.S3.SessionToken != "tok-session-abcdef" ||
		p.Rclone.Creds.SessionToken != "tok-session-abcdef" || p.Refresh == nil {
		t.Fatalf("%+v", p)
	}
	if want := filepath.Join(l.Projects, StateKey("demo", abs, "users/AbC123/")); p.StateDir != want {
		t.Fatalf("StateDir %q, want %q", p.StateDir, want)
	}
	if reg, err := ReadRegistration(p.StateDir); err != nil || reg.Root != "users/AbC123/" {
		t.Fatalf("%+v %v", reg, err)
	}

	// The same folder with another person's credentials: refused, by the same words a round uses.
	_, err = Open(folder, l, processEnv(t, accountOutput("users/Other1/", "folder-sync")), "rclone", nil)
	if err == nil || !errors.Is(err, ErrRootChanged) || !strings.Contains(err.Error(), "never moves a folder's files into another account") {
		t.Fatalf("%v", err)
	}
	// And with credentials bound to another bucket.
	_, err = Open(folder, l, processEnv(t, accountOutput("users/AbC123/", "other-bucket")), "rclone", nil)
	if err == nil || !strings.Contains(err.Error(), `"folder-sync"`) || !strings.Contains(err.Error(), `"other-bucket"`) {
		t.Fatalf("%v", err)
	}
}

func TestAV0FolderIsNotMovedIntoAnAccount(t *testing.T) {
	l := testLayout(t)
	if _, _, err := host.Ensure(l.HostFile); err != nil {
		t.Fatal(err)
	}
	folder := t.TempDir()
	config.Write(folder, config.New("demo", "folder-sync"))
	static := func(key string) string {
		return map[string]string{creds.EnvAccessKeyID: "AKID1234", creds.EnvSecretAccessKey: "secret-value", creds.EnvAccountID: "acct"}[key]
	}
	v0, err := Open(folder, l, static, "rclone", nil)
	if err != nil {
		t.Fatal(err)
	}
	v0.Close()
	abs, _ := filepath.Abs(folder)
	if filepath.Base(v0.StateDir) != StateKey("demo", abs, "") {
		t.Fatal("a folder without a root keeps its v0 state dir")
	}
	data, _ := os.ReadFile(filepath.Join(v0.StateDir, "project.json"))
	if strings.Contains(string(data), `"root"`) {
		t.Fatalf("a v0 registration has no root field: %s", data)
	}
	_, err = Open(folder, l, processEnv(t, accountOutput("users/AbC123/", "folder-sync")), "rclone", nil)
	if !errors.Is(err, ErrRootChanged) || !strings.Contains(err.Error(), `account root ""; these credentials are for users/AbC123/`) {
		t.Fatalf("%v", err)
	}
	// RegisteredRoot finds the registration for the service installer's state key.
	if got := RegisteredRoot(l, "demo", abs); got != "" {
		t.Fatalf("RegisteredRoot = %q", got)
	}
}

func TestLastSyncCarriesTheRoot(t *testing.T) {
	data, _ := json.Marshal(LastSync{Root: "users/AbC123/"})
	if !strings.Contains(string(data), `"root":"users/AbC123/"`) {
		t.Fatal(string(data))
	}
	data, _ = json.Marshal(LastSync{})
	if !strings.Contains(string(data), `"root":""`) {
		t.Fatalf("a v0 last-sync.json says root \"\" (status --json shows it): %s", data)
	}
}
