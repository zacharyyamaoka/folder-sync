package account

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func noSleep(context.Context, time.Duration) error { return nil }

func TestSaveLoadRoundTripIsOwnerOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "account.json")
	if _, err := Load(path); !errors.Is(err, ErrNotSignedIn) {
		t.Fatalf("missing file: %v, want ErrNotSignedIn", err)
	}
	a := Account{Server: "https://robotparts.dev", Token: "tok-secret-value", User: User{ID: "ownerABC123", Email: "owner@example.com"}, SignedIn: "2026-10-26T00:00:00Z"}
	if err := Save(path, a); err != nil {
		t.Fatal(err)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	a.Schema = Schema
	if got != a {
		t.Fatalf("round trip: %+v, want %+v", got, a)
	}
	if runtime.GOOS != "windows" {
		if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
			t.Fatalf("mode %v, want 0600", info.Mode().Perm())
		}
	}
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), `"schema": "folder-sync-account/1"`) {
		t.Fatalf("no schema line: %s", data)
	}
	os.WriteFile(path, []byte(`{"schema":"folder-sync-account/1","server":"x","token":"tok-secret-value"}`), 0o600)
	if _, err := Load(path); err == nil || strings.Contains(err.Error(), "tok-secret-value") {
		t.Fatalf("an incomplete file: %v", err)
	}
	os.WriteFile(path, []byte(`not json tok-secret-value`), 0o600)
	if _, err := Load(path); err == nil || strings.Contains(err.Error(), "tok-secret-value") {
		t.Fatalf("a broken file must fail without echoing it: %v", err)
	}
}

func TestServerIsHTTPSOrLoopback(t *testing.T) {
	env := func(v string) func(string) string { return func(string) string { return v } }
	for in, want := range map[string]string{
		"https://robotparts.dev":   "https://robotparts.dev",
		"https://robotparts.dev/":  "https://robotparts.dev",
		"http://127.0.0.1:4932":    "http://127.0.0.1:4932",
		"http://localhost:4932/":   "http://localhost:4932",
		"http://[::1]:4932":        "http://[::1]:4932",
		"https://a.example.com:80": "https://a.example.com:80",
	} {
		got, err := CheckServer(in)
		if err != nil || got != want {
			t.Errorf("CheckServer(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"http://robotparts.dev", "ftp://x", "robotparts.dev", "https://u:p@x.dev", "https://x.dev/fs", "https://x.dev?a=1", ""} {
		if _, err := CheckServer(bad); err == nil {
			t.Errorf("CheckServer(%q) accepted", bad)
		}
	}
	if got, _ := Server("", env("")); got != DefaultServer {
		t.Errorf("default: %q", got)
	}
	if got, _ := Server("", env("https://robotparts.dev")); got != "https://robotparts.dev" {
		t.Errorf("$%s: %q", EnvServer, got)
	}
	if got, _ := Server("https://vibetracks.dev", env("https://robotparts.dev")); got != "https://vibetracks.dev" {
		t.Errorf("--server wins: %q", got)
	}
}

func TestUserAgentNamesTheMachineOnOneSafeLine(t *testing.T) {
	if got := UserAgent("v0.3", "bam-GPU", "linux"); got != "folder-sync/v0.3 (bam-GPU; linux)" {
		t.Fatalf("got %q", got)
	}
	if got := UserAgent("v0.3", "a\r\nX-Evil: 1;(é)", "windows"); strings.ContainsAny(got[len("folder-sync/v0.3 ("):len(got)-len("; windows)")], "\r\n;()é:") {
		t.Fatalf("unsafe name kept: %q", got)
	}
	if got := UserAgent("v0.3", "", "darwin"); got != "folder-sync/v0.3 (host; darwin)" {
		t.Fatalf("got %q", got)
	}
}

// fakeServer is the accounts Worker's device grant and /fs/v1 routes, as far as the client uses them.
type fakeServer struct {
	mu         sync.Mutex
	polls      int
	pending    int    // how many polls answer authorization_pending before the token
	outcome    string // "" approve, else the error to answer once pending is done
	agents     []string
	bodies     map[string]map[string]any
	bearers    map[string]string
	signedOut  bool
	visibility string
}

func (f *fakeServer) handler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.agents = append(f.agents, r.Header.Get("User-Agent"))
		var body map[string]any
		if data, _ := io.ReadAll(r.Body); len(data) > 0 {
			json.Unmarshal(data, &body)
		}
		if f.bodies == nil {
			f.bodies, f.bearers = map[string]map[string]any{}, map[string]string{}
		}
		f.bodies[r.Method+" "+r.URL.Path] = body
		f.bearers[r.Method+" "+r.URL.Path] = r.Header.Get("Authorization")
		live := r.Header.Get("Authorization") == "Bearer tok-machine" && !f.signedOut
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /fs/api/auth/device/code":
			io.WriteString(w, `{"device_code":"dev-code-1","user_code":"ABCDEFGH","verification_uri":"`+"http://"+r.Host+`/fs/device","verification_uri_complete":"http://`+r.Host+`/fs/device?user_code=ABCDEFGH","expires_in":900,"interval":1}`)
		case "POST /fs/api/auth/device/token":
			f.polls++
			if f.polls <= f.pending {
				w.WriteHeader(400)
				io.WriteString(w, `{"error":"authorization_pending","error_description":"Authorization pending"}`)
				return
			}
			if f.outcome != "" {
				w.WriteHeader(400)
				io.WriteString(w, `{"error":"`+f.outcome+`"}`)
				return
			}
			io.WriteString(w, `{"access_token":"tok-machine","token_type":"Bearer","expires_in":7776000,"scope":""}`)
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
			io.WriteString(w, `{"Version":1,"AccessKeyId":"parent-id","SecretAccessKey":"temp-secret","SessionToken":"tok-session","Expiration":"2099-01-01T00:00:00Z","Endpoint":"http://127.0.0.1:1","Bucket":"folder-sync","Prefix":"users/ownerABC123/","Region":"auto","Provider":"Cloudflare"}`)
		case "POST /fs/v1/sign-out":
			if !live {
				w.WriteHeader(401)
				io.WriteString(w, `{"error":"signed_out"}`)
				return
			}
			f.signedOut = true
			io.WriteString(w, `{"ok":true}`)
		case "PATCH /fs/v1/folders/robotparts":
			if !live {
				w.WriteHeader(401)
				return
			}
			f.visibility, _ = body["visibility"].(string)
			io.WriteString(w, `{"owner_id":"ownerABC123","project":"robotparts","visibility":"`+f.visibility+`","updated_at":"2026-10-26T00:00:00Z"}`)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	})
}

func TestDeviceGrantPollsUntilApprovedAndSendsItsUserAgent(t *testing.T) {
	f := &fakeServer{pending: 2}
	srv := httptest.NewServer(f.handler(t))
	defer srv.Close()
	c := NewClient(srv.URL, "folder-sync/v0-test (laptop; linux)")
	d, err := c.StartDevice(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if d.Shown() != "ABCD-EFGH" || d.Link() != srv.URL+"/fs/device?user_code=ABCDEFGH" || d.Interval != 1 {
		t.Fatalf("device %+v", d)
	}
	if f.bodies["POST /fs/api/auth/device/code"]["client_id"] != ClientID {
		t.Fatalf("code request %v", f.bodies["POST /fs/api/auth/device/code"])
	}
	token, err := c.AwaitApproval(context.Background(), d, noSleep)
	if err != nil || token != "tok-machine" {
		t.Fatalf("token %q, %v", token, err)
	}
	if f.polls != 3 {
		t.Fatalf("%d polls, want 3", f.polls)
	}
	poll := f.bodies["POST /fs/api/auth/device/token"]
	if poll["grant_type"] != "urn:ietf:params:oauth:grant-type:device_code" || poll["device_code"] != "dev-code-1" || poll["client_id"] != ClientID {
		t.Fatalf("poll body %v", poll)
	}
	for _, agent := range f.agents {
		if agent != "folder-sync/v0-test (laptop; linux)" {
			t.Fatalf("User-Agent %q", agent)
		}
	}
	user, root, err := c.Me(context.Background(), token)
	if err != nil || user.Email != "owner@example.com" || root != "users/ownerABC123/" {
		t.Fatalf("me %+v %q %v", user, root, err)
	}
}

func TestDeviceGrantDeniedOrExpired(t *testing.T) {
	for outcome, want := range map[string]string{"access_denied": "denied", "expired_token": "expired", "invalid_grant": "expired", "server_error": "refused"} {
		f := &fakeServer{outcome: outcome}
		srv := httptest.NewServer(f.handler(t))
		c := NewClient(srv.URL, "ua")
		d, _ := c.StartDevice(context.Background())
		_, err := c.AwaitApproval(context.Background(), d, noSleep)
		srv.Close()
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v, want %q", outcome, err, want)
		}
	}
	// the code's lifetime is the limit
	f := &fakeServer{pending: 1 << 30}
	srv := httptest.NewServer(f.handler(t))
	defer srv.Close()
	c := NewClient(srv.URL, "ua")
	_, err := c.AwaitApproval(context.Background(), Device{DeviceCode: "x", UserCode: "y", URI: "z", ExpiresIn: 0, Interval: 1}, noSleep)
	if err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("an expired code: %v", err)
	}
}

func TestSignedOutIsErrSignedOut(t *testing.T) {
	f := &fakeServer{}
	srv := httptest.NewServer(f.handler(t))
	defer srv.Close()
	c := NewClient(srv.URL, "ua")
	keys, err := c.Credentials(context.Background(), "tok-machine")
	if err != nil || !strings.Contains(string(keys), `"Prefix":"users/ownerABC123/"`) {
		t.Fatalf("credentials %s %v", keys, err)
	}
	if f.bearers["POST /fs/v1/credentials"] != "Bearer tok-machine" {
		t.Fatalf("Authorization %q", f.bearers["POST /fs/v1/credentials"])
	}
	if row, err := c.SetVisibility(context.Background(), "tok-machine", "robotparts", "public"); err != nil || row.Visibility != "public" || f.visibility != "public" {
		t.Fatalf("visibility %+v %v", row, err)
	}
	if err := c.SignOut(context.Background(), "tok-machine"); err != nil || !f.signedOut {
		t.Fatalf("sign-out %v", err)
	}
	if _, err := c.Credentials(context.Background(), "tok-machine"); !errors.Is(err, ErrSignedOut) {
		t.Fatalf("after sign-out: %v", err)
	}
	if _, _, err := c.Me(context.Background(), "tok-machine"); !errors.Is(err, ErrSignedOut) {
		t.Fatalf("me after sign-out: %v", err)
	}
	if err := c.SignOut(context.Background(), "tok-machine"); err != nil {
		t.Fatalf("a second sign-out is not an error: %v", err)
	}
}

func TestTheTokenNeverFollowsARedirect(t *testing.T) {
	var leaked string
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		leaked = r.Header.Get("Authorization")
	}))
	defer elsewhere.Close()
	redirecting := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, elsewhere.URL+r.URL.Path, http.StatusTemporaryRedirect)
	}))
	defer redirecting.Close()
	c := NewClient(redirecting.URL, "ua")
	if _, err := c.Credentials(context.Background(), "tok-machine"); err == nil {
		t.Fatal("a redirect was taken as keys")
	}
	if leaked != "" {
		t.Fatalf("the token reached another server: %q", leaked)
	}
}
