package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"folder-sync/internal/config"
	"folder-sync/internal/creds"
	"folder-sync/internal/host"
	"folder-sync/internal/layout"
	"folder-sync/internal/rclonebin"
	"folder-sync/internal/syncer"
)

// sandbox points HOME and USERPROFILE at a temp dir (never the real ~/.folder-sync), with a fake rclone
// that only answers `version`, and returns the layout and the host.
func sandbox(t *testing.T) (layout.Layout, host.Host) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fakes are /bin/sh scripts")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	for _, name := range []string{creds.EnvAccessKeyID, creds.EnvSecretAccessKey, creds.EnvAccountID, creds.EnvEndpoint, creds.EnvCredentialProcess} {
		t.Setenv(name, "")
	}
	rcloneBin := filepath.Join(t.TempDir(), "rclone")
	if err := os.WriteFile(rcloneBin, []byte("#!/bin/sh\necho 'rclone "+rclonebin.Version+"'\n"), 0o755); err != nil {
		t.Skip("cannot write a fake rclone here:", err)
	}
	t.Setenv("FOLDER_SYNC_RCLONE", rcloneBin)
	l, err := layout.For(runtime.GOOS, os.Getenv)
	if err != nil {
		t.Fatal(err)
	}
	if err := ensureDirs(l); err != nil {
		t.Fatal(err)
	}
	h, _, err := host.Ensure(l.HostFile)
	if err != nil {
		t.Fatal(err)
	}
	return l, h
}

// useProcess makes FOLDER_SYNC_CREDENTIAL_PROCESS a script with the given body.
func useProcess(t *testing.T, body string) {
	t.Helper()
	script := filepath.Join(t.TempDir(), "cred-process")
	if err := os.WriteFile(script, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Skip("cannot write a fake credential process here:", err)
	}
	argv, _ := json.Marshal([]string{script})
	t.Setenv(creds.EnvCredentialProcess, string(argv))
}

func processOutput(endpoint, prefix, bucket string) string {
	return `{"Version":1,"AccessKeyId":"ASIAEXAMPLE1234","SecretAccessKey":"very-secret-value","SessionToken":"tok-session-abcdef",` +
		`"Expiration":"2099-01-01T00:00:00Z","Endpoint":"` + endpoint + `","Bucket":"` + bucket + `","Prefix":"` + prefix + `"}`
}

func runCmd(args ...string) (code int, stdout, stderr string) {
	var out, errOut bytes.Buffer
	code = run(args, &out, &errOut)
	return code, out.String(), errOut.String()
}

func TestSyncOnceExitsFourWhenSignedOut(t *testing.T) {
	l, _ := sandbox(t)
	folder := t.TempDir()
	config.Write(folder, config.New("demo", "folder-sync"))
	useProcess(t, "echo 'this machine is signed out: run vt login' >&2\nexit 3\n")
	code, out, errOut := runCmd("sync", "--once", "--dir", folder)
	if code != 4 || !strings.Contains(errOut, "this machine is signed out: run vt login") {
		t.Fatalf("code %d, stdout %q, stderr %q", code, out, errOut)
	}
	if _, err := os.Stat(l.Session); err == nil {
		t.Fatal("no session.json after exit 3")
	}
}

func TestSyncOnceExitsSeventyFiveWhenTheLockIsHeld(t *testing.T) {
	l, _ := sandbox(t)
	folder := t.TempDir()
	config.Write(folder, config.New("demo", "folder-sync"))
	abs, _ := filepath.Abs(folder)
	useProcess(t, "cat <<'EOF'\n"+processOutput("http://127.0.0.1:1", "users/AbC123/", "folder-sync")+"\nEOF\n")
	stateDir := filepath.Join(l.Projects, syncer.StateKey("demo", abs, "users/AbC123/"))
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "lock"), []byte("pid 1 at now\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	code, _, errOut := runCmd("sync", "--once", "--dir", folder)
	if code != 75 || !strings.Contains(errOut, "another folder-sync round") {
		t.Fatalf("code %d, stderr %q", code, errOut)
	}
}

func TestSyncOnceExitsOneOtherwise(t *testing.T) {
	sandbox(t)
	folder := t.TempDir()
	config.Write(folder, config.New("demo", "folder-sync"))
	useProcess(t, "echo 'network is down' >&2\nexit 4\n")
	code, _, errOut := runCmd("sync", "--once", "--dir", folder)
	if code != 1 || !strings.Contains(errOut, "network is down") {
		t.Fatalf("code %d, stderr %q", code, errOut)
	}
}

func TestInitWithAccountCredentialsListsItsPrefixAndTakesTheBoundBucket(t *testing.T) {
	l, _ := sandbox(t)
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path+" prefix="+r.URL.Query().Get("prefix")+" max="+r.URL.Query().Get("max-keys"))
		if r.Header.Get("x-amz-security-token") != "tok-session-abcdef" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Write([]byte("<ListBucketResult/>"))
	}))
	defer server.Close()
	useProcess(t, "cat <<'EOF'\n"+processOutput(server.URL, "users/AbC123/", "vt-bucket")+"\nEOF\n")

	folder := t.TempDir()
	code, out, errOut := runCmd("init", "--project", "demo", "--dir", folder)
	if code != 0 {
		t.Fatalf("code %d\nstdout %s\nstderr %s", code, out, errOut)
	}
	if want := []string{"GET /vt-bucket prefix=users/AbC123/ max=1"}; strings.Join(requests, "|") != strings.Join(want, "|") {
		t.Fatalf("requests %q", requests)
	}
	cfg, err := config.Load(folder)
	if err != nil || cfg.Bucket != "vt-bucket" {
		t.Fatalf("--bucket omitted must take the credentials' bucket: %+v %v", cfg, err)
	}
	if !strings.Contains(out, `can reach prefix "users/AbC123/" in bucket "vt-bucket"`) {
		t.Fatal(out)
	}
	if strings.Contains(out+errOut, "very-secret-value") || strings.Contains(out+errOut, "tok-session") || strings.Contains(out+errOut, "ASIAEXAMPLE") {
		t.Fatalf("a secret reached the output:\n%s%s", out, errOut)
	}
	abs, _ := filepath.Abs(folder)
	if reg, err := syncer.ReadRegistration(filepath.Join(l.Projects, syncer.StateKey("demo", abs, "users/AbC123/"))); err != nil || reg.Root != "users/AbC123/" {
		t.Fatalf("init registers the folder under the credentials' root: %+v %v", reg, err)
	}

	// An explicit other bucket is refused, and so is a signed-out process.
	if code, _, errOut := runCmd("init", "--project", "demo2", "--bucket", "other-bucket", "--dir", t.TempDir()); code == 0 || !strings.Contains(errOut, `"vt-bucket"`) {
		t.Fatalf("code %d, stderr %q", code, errOut)
	}
	useProcess(t, "echo 'signed out' >&2\nexit 3\n")
	if code, _, _ := runCmd("init", "--project", "demo3", "--dir", t.TempDir()); code != 4 {
		t.Fatalf("a signed-out init exits 4, got %d", code)
	}
}

func TestInitWithoutAProcessStillHeadsTheBucket(t *testing.T) {
	sandbox(t)
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path+" "+r.URL.RawQuery)
	}))
	defer server.Close()
	t.Setenv(creds.EnvAccessKeyID, "AKID1234")
	t.Setenv(creds.EnvSecretAccessKey, "secret-value")
	t.Setenv(creds.EnvEndpoint, server.URL)
	if code, out, errOut := runCmd("init", "--project", "demo", "--bucket", "folder-sync", "--dir", t.TempDir()); code != 0 {
		t.Fatalf("code %d\n%s%s", code, out, errOut)
	}
	if len(requests) != 1 || requests[0] != "HEAD /folder-sync " {
		t.Fatalf("%q", requests)
	}
}

func TestStatusJSON(t *testing.T) {
	l, h := sandbox(t)
	parent := t.TempDir()
	two, one := filepath.Join(parent, "b-second"), filepath.Join(parent, "a-first")
	for _, dir := range []string{one, two} {
		os.MkdirAll(dir, 0o700)
		config.Write(dir, config.New("demo", "folder-sync"))
	}
	// one: a v0 folder with a finished round; two: under an account root, no round yet.
	if err := syncer.EnsureRegistered(l, filepath.Join(l.Projects, syncer.StateKey("one", one, "")),
		syncer.Registration{Project: "one", Bucket: "folder-sync", Folder: one, HostID: h.ID}); err != nil {
		t.Fatal(err)
	}
	if err := syncer.EnsureRegistered(l, filepath.Join(l.Projects, syncer.StateKey("two", two, "users/AbC123/")),
		syncer.Registration{Project: "two", Bucket: "vt-bucket", Folder: two, HostID: h.ID, Root: "users/AbC123/"}); err != nil {
		t.Fatal(err)
	}
	last := syncer.LastSync{Schema: syncer.LastSyncSchema, Project: "one", Bucket: "folder-sync", Folder: one, HostID: h.ID, HostName: h.Name,
		RoundStarted: time.Now().UTC().Format(time.RFC3339Nano), RoundFinished: time.Now().UTC().Format(time.RFC3339Nano), OK: true, Uploaded: 3}
	data, _ := json.Marshal(last)
	os.WriteFile(filepath.Join(l.Projects, syncer.StateKey("one", one, ""), "last-sync.json"), data, 0o600)

	code, out, errOut := runCmd("status", "--json")
	if code != 0 || errOut != "" {
		t.Fatalf("code %d, stderr %q", code, errOut)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("not one JSON document: %v\n%s", err, out)
	}
	if got := keys(doc); got != "host,projects,schema" {
		t.Fatalf("top-level keys %s", got)
	}
	var schema string
	json.Unmarshal(doc["schema"], &schema)
	var hostDoc map[string]string
	json.Unmarshal(doc["host"], &hostDoc)
	if schema != "folder-sync-status/1" || hostDoc["id"] != h.ID || hostDoc["name"] != h.Name || len(hostDoc) != 2 {
		t.Fatalf("%s %v", schema, hostDoc)
	}
	var projects []map[string]json.RawMessage
	json.Unmarshal(doc["projects"], &projects)
	if len(projects) != 2 {
		t.Fatalf("%d projects in %s", len(projects), out)
	}
	for _, project := range projects {
		if got := keys(project); got != "bucket,folder,last,project,root" {
			t.Fatalf("project keys %s", got)
		}
	}
	// Sorted by folder: a-first (a finished v0 round), then b-second (no round: last is null).
	var firstLast map[string]any
	json.Unmarshal(projects[0]["last"], &firstLast)
	if string(projects[0]["root"]) != `""` || firstLast["ok"] != true || firstLast["uploaded"] != float64(3) || firstLast["root"] != "" || firstLast["schema"] != syncer.LastSyncSchema {
		t.Fatalf("%s", out)
	}
	if string(projects[1]["root"]) != `"users/AbC123/"` || string(projects[1]["bucket"]) != `"vt-bucket"` || string(projects[1]["last"]) != "null" {
		t.Fatalf("%s", out)
	}

	// --dir narrows it, and an empty machine still prints a document with "projects": [].
	if code, out, _ := runCmd("status", "--json", "--dir", two); code != 0 || strings.Count(out, `"project":`) != 1 {
		t.Fatalf("code %d\n%s", code, out)
	}
	os.RemoveAll(l.Projects)
	os.MkdirAll(l.Projects, 0o700)
	if _, out, _ := runCmd("status", "--json"); !strings.Contains(out, `"projects": []`) {
		t.Fatalf("%s", out)
	}
}

func keys(m map[string]json.RawMessage) string {
	var names []string
	for name := range m {
		names = append(names, name)
	}
	sort.Strings(names)
	return strings.Join(names, ",")
}
