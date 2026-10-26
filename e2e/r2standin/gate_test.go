package main

import (
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"folder-sync/internal/s3"
)

const (
	testAccount = "acct0123456789abcdef"
	parentID    = "parent-key-id-0001"
	parentSec   = "parent-secret-not-real-0001"
	bucketName  = "fs-test"
)

type world struct {
	t       *testing.T
	gate    *httptest.Server
	mu      sync.Mutex
	reached []string // what got through to the storage: "METHOD path?query"
}

func newWorld(t *testing.T) *world {
	w := &world{t: t}
	backend := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		w.mu.Lock()
		w.reached = append(w.reached, r.Method+" "+r.RequestURI)
		w.mu.Unlock()
		if r.Header.Get("Authorization") != "" || r.Header.Get("X-Amz-Security-Token") != "" {
			t.Errorf("the storage received auth headers: %v", r.Header)
		}
		rw.WriteHeader(200)
		io.WriteString(rw, "ok")
	}))
	t.Cleanup(backend.Close)
	gate := &Gate{Account: testAccount, Parents: map[string]string{parentID: parentSec},
		Backend: strings.TrimPrefix(backend.URL, "http://")}
	w.gate = httptest.NewServer(gate)
	t.Cleanup(w.gate.Close)
	return w
}

func (w *world) host() string { return strings.TrimPrefix(w.gate.URL, "http://") }

// cred mints a temporary credential for the gate's host with the given claims.
func (w *world) cred(claims map[string]any, ttl time.Duration) (id, secret, token string) {
	id, secret, token, _ = Mint(testAccount, parentID, parentSec, w.host(), bucketName, claims, ttl, time.Now())
	return
}

func scoped(prefix string) map[string]any {
	return map[string]any{"scope": "object-read-write", "paths": map[string]any{"prefixPaths": []string{prefix}, "objectPaths": []string{}}}
}

// do sends a signed request: path is /<bucket>/<key>, query raw, headers extra.
func (w *world) do(method, path, query string, id, secret, token string, extra map[string]string, body string) (int, string) {
	w.t.Helper()
	u := w.gate.URL + path
	if query != "" {
		u += "?" + query
	}
	req, err := http.NewRequest(method, u, strings.NewReader(body))
	if err != nil {
		w.t.Fatal(err)
	}
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	s3.SignWithToken(req, id, secret, token, "auto", time.Now(), "UNSIGNED-PAYLOAD")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		w.t.Fatal(err)
	}
	defer resp.Body.Close()
	text, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(text)
}

func (w *world) reachedCount() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.reached)
}

func TestTemporaryCredentialStaysInsideItsPrefix(t *testing.T) {
	w := newWorld(t)
	id, secret, token := w.cred(scoped("users/abc/"), 15*time.Minute)
	cases := []struct {
		name, method, path, query string
		extra                     map[string]string
		body                      string
		want                      int
	}{
		{"read own key", "GET", "/fs-test/users/abc/home/hosts/h1/manifest.json", "", nil, "", 200},
		{"write own key", "PUT", "/fs-test/users/abc/home/hosts/h1/notes.md", "", nil, "x", 200},
		{"head own key", "HEAD", "/fs-test/users/abc/home/hosts/h1/notes.md", "", nil, "", 200},
		{"delete own key", "DELETE", "/fs-test/users/abc/_trash/home/h1/x", "", nil, "", 200},
		{"list own prefix", "GET", "/fs-test", "list-type=2&prefix=users%2Fabc%2Fhome%2Fhosts%2F&delimiter=%2F", nil, "", 200},
		{"copy inside", "PUT", "/fs-test/users/abc/_trash/home/h1/s/a", "", map[string]string{"X-Amz-Copy-Source": "/fs-test/users/abc/home/hosts/h1/a"}, "", 200},
		// WHY each refusal: the boundary between two people is exactly these checks.
		{"read another person's key", "GET", "/fs-test/users/xyz/home/hosts/h9/manifest.json", "", nil, "", 403},
		{"a prefix that only shares the start", "GET", "/fs-test/users/abcd/home/hosts/h9/manifest.json", "", nil, "", 403},
		{"write another person's key", "PUT", "/fs-test/users/xyz/home/hosts/h9/x", "", nil, "x", 403},
		{"list another person's prefix", "GET", "/fs-test", "list-type=2&prefix=users%2Fxyz%2F", nil, "", 403},
		{"list everyone", "GET", "/fs-test", "list-type=2&prefix=users%2F", nil, "", 403},
		{"list the bucket", "GET", "/fs-test", "list-type=2", nil, "", 403},
		{"copy out of another person's prefix", "PUT", "/fs-test/users/abc/stolen", "", map[string]string{"X-Amz-Copy-Source": "/fs-test/users/xyz/home/hosts/h9/a"}, "", 403},
		{"head the bucket", "HEAD", "/fs-test", "", nil, "", 403},
		{"bulk delete with one foreign key", "POST", "/fs-test", "delete", nil,
			`<Delete><Object><Key>users/abc/a</Key></Object><Object><Key>users/xyz/b</Key></Object></Delete>`, 403},
		{"another bucket", "GET", "/other-bucket/users/abc/x", "", nil, "", 403},
	}
	for _, c := range cases {
		before := w.reachedCount()
		status, text := w.do(c.method, c.path, c.query, id, secret, token, c.extra, c.body)
		if status != c.want {
			t.Errorf("%s: %s %s?%s answered %d, want %d (%s)", c.name, c.method, c.path, c.query, status, c.want, text)
		}
		if c.want == 403 && w.reachedCount() != before {
			t.Errorf("%s: a refused request reached the storage", c.name)
		}
	}
}

func TestTheParentKeyReadsTheWholeBucket(t *testing.T) {
	w := newWorld(t)
	for _, path := range []string{"/fs-test/users/abc/x", "/fs-test/users/xyz/y"} {
		if status, text := w.do("GET", path, "", parentID, parentSec, "", nil, ""); status != 200 {
			t.Errorf("parent key GET %s: %d %s", path, status, text)
		}
	}
	if status, _ := w.do("GET", "/fs-test", "list-type=2", parentID, parentSec, "", nil, ""); status != 200 {
		t.Errorf("parent key LIST: %d", status)
	}
}

func TestATemporaryCredentialMustBeGenuineAndCurrent(t *testing.T) {
	w := newWorld(t)
	path := "/fs-test/users/abc/x"
	id, secret, token := w.cred(scoped("users/abc/"), 15*time.Minute)

	// expired
	eid, esecret, etoken := w.cred(scoped("users/abc/"), -time.Minute)
	if status, _ := w.do("GET", path, "", eid, esecret, etoken, nil, ""); status != 400 {
		t.Errorf("expired credential answered %d, want 400", status)
	}
	// signed with another parent secret
	_, fsecret, ftoken, _ := Mint(testAccount, parentID, "some-other-secret", w.host(), bucketName, scoped("users/abc/"), time.Minute, time.Now())
	if status, _ := w.do("GET", path, "", parentID, fsecret, ftoken, nil, ""); status != 403 {
		t.Errorf("forged credential answered %d, want 403", status)
	}
	// the payload changed after signing (a wider prefix)
	raw, _ := base64.StdEncoding.DecodeString(token)
	parts := strings.Split(strings.TrimPrefix(string(raw), "jwt/"), ".")
	payload, _ := b64url.DecodeString(parts[1])
	widened := strings.Replace(string(payload), "users/abc/", "users/", 1)
	parts[1] = b64url.EncodeToString([]byte(widened))
	tampered := strings.Join(parts, ".")
	ttoken := base64.StdEncoding.EncodeToString([]byte("jwt/" + tampered))
	if status, _ := w.do("GET", "/fs-test/users/xyz/x", "", id, TempSecret(tampered), ttoken, nil, ""); status != 403 {
		t.Errorf("tampered credential answered %d, want 403", status)
	}
	// minted for another endpoint (aud)
	_, asecret, atoken, _ := Mint(testAccount, parentID, parentSec, "elsewhere.example:443", bucketName, scoped("users/abc/"), time.Minute, time.Now())
	if status, _ := w.do("GET", path, "", parentID, asecret, atoken, nil, ""); status != 403 {
		t.Errorf("credential for another endpoint answered %d, want 403", status)
	}
	// minted for another account (sub)
	_, ssecret, stoken, _ := Mint("another-account", parentID, parentSec, w.host(), bucketName, scoped("users/abc/"), time.Minute, time.Now())
	if status, _ := w.do("GET", path, "", parentID, ssecret, stoken, nil, ""); status != 403 {
		t.Errorf("credential for another account answered %d, want 403", status)
	}
	// the right token with the parent's secret instead of the derived one
	if status, _ := w.do("GET", path, "", id, parentSec, token, nil, ""); status != 403 {
		t.Errorf("token signed with the parent secret answered %d, want 403", status)
	}
	// genuine
	if status, text := w.do("GET", path, "", id, secret, token, nil, ""); status != 200 {
		t.Errorf("genuine credential answered %d: %s", status, text)
	}
}

func TestScopeAndActions(t *testing.T) {
	w := newWorld(t)
	both := map[string]any{"scope": "object-read-write", "actions": []string{"GetObject"}}
	id, secret, token := w.cred(both, time.Minute)
	if status, _ := w.do("GET", "/fs-test/a", "", id, secret, token, nil, ""); status != 400 {
		t.Errorf("scope and actions together answered %d, want 400", status)
	}
	id, secret, token = w.cred(map[string]any{}, time.Minute)
	if status, _ := w.do("GET", "/fs-test/a", "", id, secret, token, nil, ""); status != 400 {
		t.Errorf("neither scope nor actions answered %d, want 400", status)
	}
	readOnly := map[string]any{"actions": []string{"GetObject", "HeadObject"}, "paths": map[string]any{"prefixPaths": []string{"users/abc/"}}}
	id, secret, token = w.cred(readOnly, time.Minute)
	if status, _ := w.do("GET", "/fs-test/users/abc/a", "", id, secret, token, nil, ""); status != 200 {
		t.Errorf("GetObject with actions [GetObject] answered %d", status)
	}
	if status, _ := w.do("PUT", "/fs-test/users/abc/a", "", id, secret, token, nil, "x"); status != 403 {
		t.Errorf("PutObject with actions [GetObject HeadObject] answered %d, want 403", status)
	}
	if status, _ := w.do("GET", "/fs-test", "list-type=2&prefix=users%2Fabc%2F", id, secret, token, nil, ""); status != 403 {
		t.Errorf("ListObjectsV2 with actions [GetObject HeadObject] answered %d, want 403", status)
	}
	ro := map[string]any{"scope": "object-read-only", "paths": map[string]any{"prefixPaths": []string{"users/abc/"}}}
	id, secret, token = w.cred(ro, time.Minute)
	if status, _ := w.do("PUT", "/fs-test/users/abc/a", "", id, secret, token, nil, "x"); status != 403 {
		t.Errorf("PutObject with scope object-read-only answered %d, want 403", status)
	}
}

func TestSignatures(t *testing.T) {
	w := newWorld(t)
	// unsigned
	resp, err := http.Get(w.gate.URL + "/fs-test/users/abc/x")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Errorf("an unsigned request answered %d, want 403", resp.StatusCode)
	}
	// a wrong secret
	id, _, token := w.cred(scoped("users/abc/"), time.Minute)
	if status, _ := w.do("GET", "/fs-test/users/abc/x", "", id, "wrong", token, nil, ""); status != 403 {
		t.Errorf("a bad signature answered %d, want 403", status)
	}
	// the token sent but not signed
	id, secret, token := w.cred(scoped("users/abc/"), time.Minute)
	req, _ := http.NewRequest("GET", w.gate.URL+"/fs-test/users/abc/x", nil)
	s3.SignWithToken(req, id, secret, "", "auto", time.Now(), "UNSIGNED-PAYLOAD")
	req.Header.Set("X-Amz-Security-Token", token)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Errorf("an unsigned token answered %d, want 403", resp.StatusCode)
	}
	// an unknown key id
	if status, _ := w.do("GET", "/fs-test/x", "", "nobody", "x", "", nil, ""); status != 403 {
		t.Errorf("an unknown key answered %d, want 403", status)
	}
}

func TestCanonicalQuerySortsAndReencodes(t *testing.T) {
	got := canonicalQuery("prefix=users%2Fabc%2F&list-type=2&delimiter=/&max-keys=1")
	want := "delimiter=%2F&list-type=2&max-keys=1&prefix=users%2Fabc%2F"
	if got != want {
		t.Fatalf("canonicalQuery = %q, want %q", got, want)
	}
	if q, _ := url.ParseQuery("delete"); !q.Has("delete") {
		t.Fatal("a bare ?delete must parse as present")
	}
}
