package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"folder-sync/internal/account"
	"folder-sync/internal/config"
	"folder-sync/internal/creds"
	"folder-sync/internal/layout"
)

// accountsServer is the accounts Worker as far as the CLI uses it: the device grant, /fs/v1/me, credentials,
// sign-out and the visibility PATCH. revoked makes every bearer call 401.
type accountsServer struct {
	mu       sync.Mutex
	revoked  bool
	broken   bool
	calls    []string
	agents   []string
	patched  map[string]any
	signedOf string
}

func (a *accountsServer) start(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		defer a.mu.Unlock()
		a.calls = append(a.calls, r.Method+" "+r.URL.Path)
		a.agents = append(a.agents, r.Header.Get("User-Agent"))
		data, _ := io.ReadAll(r.Body)
		live := r.Header.Get("Authorization") == "Bearer tok-machine" && !a.revoked
		w.Header().Set("Content-Type", "application/json")
		if a.broken && r.URL.Path == "/fs/v1/credentials" {
			w.WriteHeader(503)
			io.WriteString(w, `{"error":"not_configured","why":"folder storage is not set up on this Worker yet"}`)
			return
		}
		switch r.Method + " " + r.URL.Path {
		case "POST /fs/api/auth/device/code":
			io.WriteString(w, `{"device_code":"dc","user_code":"WXYZ2345","verification_uri":"http://`+r.Host+`/fs/device","verification_uri_complete":"http://`+r.Host+`/fs/device?user_code=WXYZ2345","expires_in":900,"interval":1}`)
		case "POST /fs/api/auth/device/token":
			io.WriteString(w, `{"access_token":"tok-machine","token_type":"Bearer","expires_in":100,"scope":""}`)
		case "GET /fs/v1/me":
			if !live {
				w.WriteHeader(401)
				io.WriteString(w, `{"error":"signed_out","why":"not signed in"}`)
				return
			}
			io.WriteString(w, `{"user":{"id":"ownerABC123","email":"owner@example.com","name":"Owner","image":null},"root":"users/ownerABC123/","app":null}`)
		case "POST /fs/v1/credentials":
			if !live {
				w.WriteHeader(401)
				io.WriteString(w, `{"error":"signed_out","why":"this machine is signed out (signed out or revoked): run folder-sync login"}`)
				return
			}
			io.WriteString(w, `{"Version":1,"AccessKeyId":"parent-id","SecretAccessKey":"temp-secret-value","SessionToken":"tok-session","Expiration":"2099-01-01T00:00:00Z","Endpoint":"http://127.0.0.1:1","Bucket":"folder-sync","Prefix":"users/ownerABC123/","Region":"auto","Provider":"Cloudflare"}`)
		case "POST /fs/v1/sign-out":
			a.signedOf = r.Header.Get("Authorization")
			a.revoked = true
			io.WriteString(w, `{"ok":true}`)
		case "PATCH /fs/v1/folders/demo":
			json.Unmarshal(data, &a.patched)
			if !live {
				w.WriteHeader(401)
				return
			}
			io.WriteString(w, `{"owner_id":"ownerABC123","project":"demo","visibility":"`+a.patched["visibility"].(string)+`","updated_at":"2026-10-26T00:00:00Z"}`)
		default:
			w.WriteHeader(404)
			io.WriteString(w, `{"error":"not_found"}`)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// signIn writes account.json as `login` leaves it.
func signIn(t *testing.T, l layout.Layout, server string) {
	t.Helper()
	if err := account.Save(l.Account, account.Account{Server: server, Token: "tok-machine", User: account.User{ID: "ownerABC123", Email: "owner@example.com"}}); err != nil {
		t.Fatal(err)
	}
}

func TestLoginIsTheDeviceGrantAndStoresAccountJSON(t *testing.T) {
	l, h := sandbox(t)
	fake := &accountsServer{}
	srv := fake.start(t)
	t.Setenv(account.EnvServer, srv.URL)
	code, out, errOut := runCmd("login")
	if code != 0 {
		t.Fatalf("code %d, stderr %q", code, errOut)
	}
	if !strings.Contains(out, "open "+srv.URL+"/fs/device?user_code=WXYZ2345 and approve the code WXYZ-2345") {
		t.Fatalf("no code line: %q", out)
	}
	if strings.Contains(out, "tok-machine") || strings.Contains(errOut, "tok-machine") {
		t.Fatal("the token was printed")
	}
	a, err := account.Load(l.Account)
	if err != nil || a.Server != srv.URL || a.Token != "tok-machine" || a.User.Email != "owner@example.com" || a.Schema != account.Schema {
		t.Fatalf("account.json %+v %v", a, err)
	}
	if info, _ := os.Stat(l.Account); info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", info.Mode().Perm())
	}
	want := "folder-sync/" + version + " (" + h.Name + "; "
	for _, agent := range fake.agents {
		if !strings.HasPrefix(agent, want) {
			t.Fatalf("User-Agent %q, want %q…", agent, want)
		}
	}
}

func TestLoginServerFlagAndKeyAreSeparate(t *testing.T) {
	sandbox(t)
	fake := &accountsServer{}
	srv := fake.start(t)
	t.Setenv(account.EnvServer, "http://203.0.113.9")
	if code, _, errOut := runCmd("login", "--server", srv.URL); code != 0 {
		t.Fatalf("--server wins over $%s: %d %q", account.EnvServer, code, errOut)
	}
	if code, _, errOut := runCmd("login", "--server", "http://robotparts.dev"); code == 0 || !strings.Contains(errOut, "https") {
		t.Fatalf("plain http off this machine: %d %q", code, errOut)
	}
	if code, _, errOut := runCmd("login", "--key", "--server", srv.URL); code == 0 || !strings.Contains(errOut, "exclusive") {
		t.Fatalf("--key with --server: %d %q", code, errOut)
	}
}

func TestLoginKeyKeepsV0Behaviour(t *testing.T) {
	l, _ := sandbox(t)
	t.Setenv(creds.EnvAccessKeyID, "AKIDEXAMPLE1234")
	t.Setenv(creds.EnvSecretAccessKey, "secret-value")
	t.Setenv(creds.EnvEndpoint, "http://127.0.0.1:1")
	code, out, errOut := runCmd("login", "--key")
	if code != 0 || !strings.Contains(out, "Stored key …1234") {
		t.Fatalf("code %d, out %q, err %q", code, out, errOut)
	}
	if _, err := os.Stat(l.Credentials); err != nil {
		t.Fatal("no credentials.json:", err)
	}
	if _, err := os.Stat(l.Account); err == nil {
		t.Fatal("login --key wrote account.json")
	}
}

func TestCredentialsPrintsTheProcessJSONAndExitsThreeSignedOut(t *testing.T) {
	l, _ := sandbox(t)
	fake := &accountsServer{}
	srv := fake.start(t)
	if code, out, errOut := runCmd("credentials"); code != 3 || out != "" || !strings.Contains(errOut, "not signed in") {
		t.Fatalf("no account.json: code %d, out %q, err %q", code, out, errOut)
	}
	signIn(t, l, srv.URL)
	code, out, errOut := runCmd("credentials")
	var keys map[string]any
	if code != 0 || json.Unmarshal([]byte(out), &keys) != nil || keys["Prefix"] != "users/ownerABC123/" || keys["Version"] != float64(1) {
		t.Fatalf("code %d, out %q, err %q", code, out, errOut)
	}
	fake.broken = true
	if code, out, _ := runCmd("credentials"); code != 1 || out != "" {
		t.Fatalf("a server error is transient (1), got %d %q", code, out)
	}
	fake.broken = false
	fake.revoked = true
	if code, out, errOut := runCmd("credentials"); code != 3 || out != "" || !strings.Contains(errOut, "signed out or revoked") {
		t.Fatalf("revoked: code %d, out %q, err %q", code, out, errOut)
	}
	if _, err := os.Stat(l.Account); err != nil {
		t.Fatal("a revoked machine keeps account.json until logout (whoami says why):", err)
	}
}

func TestCredentialsFromItselfIsWhatSyncRuns(t *testing.T) {
	l, _ := sandbox(t)
	self := func() (string, error) { return "/opt/folder-sync/bin/folder-sync", nil }
	getenv := func(set map[string]string) func(string) string {
		return func(name string) string { return set[name] }
	}
	if env := credentialEnv(l, getenv(nil), self); env(creds.EnvCredentialProcess) != "" {
		t.Fatal("not signed in: no credential process")
	}
	signIn(t, l, "http://127.0.0.1:1")
	env := credentialEnv(l, getenv(map[string]string{"HOME": "/x"}), self)
	// the argv names the sign-in, so its cache is that sign-in's alone (review r1 #1)
	if got := env(creds.EnvCredentialProcess); got != `["/opt/folder-sync/bin/folder-sync","credentials","--account","ownerABC123@http://127.0.0.1:1"]` {
		t.Fatalf("signed in: %q", got)
	}
	if env("HOME") != "/x" {
		t.Fatal("other variables pass through")
	}
	for _, set := range []map[string]string{
		{creds.EnvCredentialProcess: `["/usr/bin/vt","sync","credentials"]`},
		{creds.EnvAccessKeyID: "AKID", creds.EnvSecretAccessKey: "s"},
	} {
		env := credentialEnv(l, getenv(set), self)
		if got := env(creds.EnvCredentialProcess); got != set[creds.EnvCredentialProcess] {
			t.Fatalf("%v: the environment's own choice must win, got %q", set, got)
		}
	}
	// and the resolver takes it: the argv is a JSON array whose argv[0] is absolute
	resolver := creds.NewResolver(l.Credentials, l.Session, env)
	if !resolver.UsesProcess() {
		t.Fatal("the resolver does not see the credential process")
	}
}

func TestSyncSignedInWithoutAKeyRunsItsOwnCredentials(t *testing.T) {
	// The real binary runs `<itself> credentials`; under `go test` itself is the test binary, so this stands a
	// script in for it (credentialEnv's argv[0]) and proves the round asks it, caches it and honours its exit 3.
	l, _ := sandbox(t)
	folder := t.TempDir()
	config.Write(folder, config.New("demo", "folder-sync"))
	signIn(t, l, "http://127.0.0.1:1")
	script := filepath.Join(t.TempDir(), "folder-sync")
	os.WriteFile(script, []byte("#!/bin/sh\n[ \"$1\" = credentials ] || exit 9\necho 'this machine is signed out: run folder-sync login' >&2\nexit 3\n"), 0o755)
	env := credentialEnv(l, os.Getenv, func() (string, error) { return script, nil })
	_, err := creds.NewResolver(l.Credentials, l.Session, env).Current()
	if err == nil || !strings.Contains(err.Error(), "signed out") {
		t.Fatalf("exit 3 from its own credentials: %v", err)
	}
}

func TestLogoutEndsTheSessionThenDeletesTheFile(t *testing.T) {
	l, _ := sandbox(t)
	fake := &accountsServer{}
	srv := fake.start(t)
	if code, out, _ := runCmd("logout"); code != 0 || !strings.Contains(out, "not signed in") {
		t.Fatalf("not signed in: %d %q", code, out)
	}
	signIn(t, l, srv.URL)
	code, out, errOut := runCmd("logout")
	if code != 0 || fake.signedOf != "Bearer tok-machine" {
		t.Fatalf("code %d, out %q, err %q, sign-out with %q", code, out, errOut, fake.signedOf)
	}
	if _, err := os.Stat(l.Account); err == nil {
		t.Fatal("account.json is still there")
	}
}

func TestWhoami(t *testing.T) {
	l, _ := sandbox(t)
	fake := &accountsServer{}
	srv := fake.start(t)
	if code, _, _ := runCmd("whoami"); code != 3 {
		t.Fatalf("not signed in: %d", code)
	}
	signIn(t, l, srv.URL)
	if code, out, _ := runCmd("whoami"); code != 0 || !strings.Contains(out, "owner@example.com (ownerABC123) at "+srv.URL+", account root users/ownerABC123/") {
		t.Fatalf("code %d, out %q", code, out)
	}
	fake.revoked = true
	if code, _, errOut := runCmd("whoami"); code != 3 || !strings.Contains(errOut, "revoked") {
		t.Fatalf("revoked: %d %q", code, errOut)
	}
}

func TestPublishPublicAndPrivateIsThePatch(t *testing.T) {
	l, _ := sandbox(t)
	fake := &accountsServer{}
	srv := fake.start(t)
	folder := t.TempDir()
	config.Write(folder, config.New("demo", "folder-sync"))
	if code, _, errOut := runCmd("publish", "--public", "--dir", folder); code != 3 || !strings.Contains(errOut, "folder-sync login") {
		t.Fatalf("not signed in: %d %q", code, errOut)
	}
	signIn(t, l, srv.URL)
	code, out, errOut := runCmd("publish", "--public", "--dir", folder)
	if code != 0 || fake.patched["visibility"] != "public" || !strings.Contains(out, "demo is public") {
		t.Fatalf("code %d, out %q, err %q, patched %v", code, out, errOut, fake.patched)
	}
	if code, out, _ := runCmd("publish", "--private", "--dir", folder); code != 0 || fake.patched["visibility"] != "private" || !strings.Contains(out, "demo is private") {
		t.Fatalf("private: %d %q", code, out)
	}
	if code, _, errOut := runCmd("publish", "--public", "--private", "--dir", folder); code == 0 || !strings.Contains(errOut, "exclusive") {
		t.Fatalf("both: %d %q", code, errOut)
	}
	for _, call := range fake.calls {
		if strings.HasPrefix(call, "PUT") {
			t.Fatalf("publish --public ran a round: %v", fake.calls)
		}
	}
}

// TestMain lets the test binary stand in for folder-sync itself: signed in, folder-sync's credential process is
// `<its own binary> credentials`, so with FOLDER_SYNC_TEST_AS_MAIN=1 this binary runs folder-sync's commands.
func TestMain(m *testing.M) {
	if os.Getenv("FOLDER_SYNC_TEST_AS_MAIN") == "1" {
		os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
	}
	os.Exit(m.Run())
}

// twoPeople is the accounts Worker for two people signing in on one machine, one after the other: the device grant
// hands out the token of whoever is next, and each token's /fs/v1/me and credentials are that person's.
type twoPeople struct {
	mu   sync.Mutex
	next string
}

var twoPeopleIDs = map[string]string{"A": "userAAAA1111", "B": "userBBBB2222"}

func (p *twoPeople) start(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.mu.Lock()
		defer p.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		who := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer tok-")
		id, known := twoPeopleIDs[who]
		switch r.Method + " " + r.URL.Path {
		case "POST /fs/api/auth/device/code":
			io.WriteString(w, `{"device_code":"dc","user_code":"WXYZ2345","verification_uri":"http://`+r.Host+`/fs/device","verification_uri_complete":"http://`+r.Host+`/fs/device?user_code=WXYZ2345","expires_in":900,"interval":1}`)
		case "POST /fs/api/auth/device/token":
			io.WriteString(w, `{"access_token":"tok-`+p.next+`","token_type":"Bearer","expires_in":100,"scope":""}`)
		case "GET /fs/v1/me", "POST /fs/v1/credentials":
			if !known {
				w.WriteHeader(401)
				io.WriteString(w, `{"error":"signed_out","why":"not signed in"}`)
				return
			}
			if r.URL.Path == "/fs/v1/me" {
				io.WriteString(w, `{"user":{"id":"`+id+`","email":"`+strings.ToLower(who)+`@example.com"},"root":"users/`+id+`/","app":null}`)
				return
			}
			io.WriteString(w, processOutput("http://127.0.0.1:1", "users/"+id+"/", "folder-sync"))
		case "POST /fs/v1/sign-out":
			io.WriteString(w, `{"ok":true}`)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// Review r1 #1: login and logout change account.json, and the cached keys in session.json must follow it.
func TestAnotherPersonsLoginNeverGetsTheCachedKeys(t *testing.T) {
	l, _ := sandbox(t)
	people := &twoPeople{next: "A"}
	srv := people.start(t)
	t.Setenv(account.EnvServer, srv.URL)
	t.Setenv("FOLDER_SYNC_TEST_AS_MAIN", "1") // read by the credential process (this binary), not by this test
	prefix := func(step string) string {
		t.Helper()
		c, err := creds.NewResolver(l.Credentials, l.Session, credentialEnv(l, os.Getenv, os.Executable)).Current()
		if err != nil {
			t.Fatalf("%s: %v", step, err)
		}
		return c.Prefix
	}
	login := func(who string) {
		t.Helper()
		people.mu.Lock()
		people.next = who
		people.mu.Unlock()
		if code, _, errOut := runCmd("login"); code != 0 {
			t.Fatalf("login as %s: %d %q", who, code, errOut)
		}
	}
	login("A")
	if got := prefix("A signed in"); got != "users/userAAAA1111/" {
		t.Fatalf("A signed in: %q", got)
	}
	cachedA, err := os.ReadFile(l.Session)
	if err != nil {
		t.Fatal("A's keys were not cached:", err)
	}
	if code, _, errOut := runCmd("logout"); code != 0 {
		t.Fatalf("logout: %d %q", code, errOut)
	}
	login("B")
	if got := prefix("B signed in after A logged out"); got != "users/userBBBB2222/" {
		t.Fatalf("B's next credential belongs to %q: A's cached keys outlived A's sign-in", got)
	}
	// A's cache back on disk (a copy that survived somehow) is never B's: its identity is not account.json's
	if err := os.WriteFile(l.Session, cachedA, 0o600); err != nil {
		t.Fatal(err)
	}
	if got := prefix("A's old cache beside B's account.json"); got != "users/userBBBB2222/" {
		t.Fatalf("a cache for A was used while account.json is B: %q", got)
	}
	// and a login on top of another, with no logout between, starts from nothing too
	login("A")
	if got := prefix("A signed in over B"); got != "users/userAAAA1111/" {
		t.Fatalf("A signed in over B: %q", got)
	}
}
