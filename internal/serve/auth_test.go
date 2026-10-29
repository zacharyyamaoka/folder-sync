package serve

// serve's auth (docs/API.md "On the machine"): every request's Host must be exactly 127.0.0.1:<port> (DNS
// rebinding), every /fs/v1/* request carries the token (a bearer, or the cookie the page set), a cookie POST also
// carries X-Folder-Sync: 1, and no answer has a CORS header.

import (
	"bytes"
	"io"
	"io/fs"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"folder-sync/ui"
)

func authWorld(t *testing.T) *world {
	return notes(t, "status-serve")
}

func TestAHostOtherThanItsOwnLoopbackAddressIsRefused(t *testing.T) {
	w := authWorld(t)
	port := w.srv.Port()
	for _, host := range []string{"evil.example:41873", "localhost:" + strconv.Itoa(port), "127.0.0.1", "127.0.0.1:" + strconv.Itoa(port+1), "[::1]:" + strconv.Itoa(port), "127.0.0.1." + ":" + strconv.Itoa(port)} {
		for _, path := range []string{"/fs/v1/folders/notes/status", "/fs/", "/fs/ui/v1/folder-sync.js", "/fs/?token=" + w.srv.Token()} {
			req, _ := http.NewRequest(http.MethodGet, w.base+strings.TrimPrefix(path, "/"), nil)
			req.Host = host
			req.Header.Set("Authorization", "Bearer "+w.srv.Token())
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode != http.StatusMisdirectedRequest || !strings.Contains(string(body), `"wrong_host"`) {
				t.Errorf("Host %s %s: %d %s", host, path, resp.StatusCode, body)
			}
		}
	}
	if status, _, _ := w.do(http.MethodGet, "/fs/v1/folders/notes/status", "owner", nil); status != http.StatusOK {
		t.Errorf("its own Host: %d", status)
	}
}

func TestAWrongOrMissingTokenIsRefused(t *testing.T) {
	w := authWorld(t)
	for _, tc := range []struct {
		name  string
		setup func(*http.Request)
	}{
		{"no token", func(*http.Request) {}},
		{"a wrong bearer", func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+strings.Repeat("A", 43)) }},
		{"the token, not as a bearer", func(r *http.Request) { r.Header.Set("Authorization", w.srv.Token()) }},
		{"a wrong cookie", func(r *http.Request) { r.AddCookie(&http.Cookie{Name: CookieName, Value: "nope"}) }},
		{"the token in the query", func(r *http.Request) { r.URL.RawQuery = "token=" + w.srv.Token() }},
		{"a wrong bearer beside the right cookie", func(r *http.Request) {
			r.Header.Set("Authorization", "Bearer nope")
			r.AddCookie(&http.Cookie{Name: CookieName, Value: w.srv.Token()})
		}},
	} {
		for _, path := range []string{"/fs/v1/folders/notes/status", "/fs/v1/folders", "/fs/v1/folders/notes/activity", "/fs/v1/folders/nope/status"} {
			req, _ := http.NewRequest(http.MethodGet, strings.TrimRight(w.base, "/")+path, nil)
			tc.setup(req)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode != http.StatusUnauthorized || !strings.Contains(string(body), `"no_token"`) {
				t.Errorf("%s, %s: %d %s", tc.name, path, resp.StatusCode, body)
			}
		}
	}
	if status, _, _ := w.do(http.MethodGet, "/fs/v1/folders/notes/status", "cookie", nil); status != http.StatusOK {
		t.Errorf("the right cookie: %d", status)
	}
}

func TestACookiePostNeedsXFolderSync(t *testing.T) {
	w := authWorld(t)
	items := map[string]any{"items": []map[string]string{{"host": gpu, "path": "notes/plan.md", "version": "2026-10-28T20:31:00.117Z_9f2c1a3b4c5d6e7f"}}}
	status, _, data := w.do(http.MethodPost, "/fs/v1/folders/notes/restore", "cookie-bare", items)
	if status != http.StatusForbidden || !strings.Contains(string(data), `"csrf"`) {
		t.Errorf("a cookie POST without X-Folder-Sync: %d %s", status, data)
	}
	if entries := localRequests(w); len(entries) != 0 {
		t.Errorf("a refused POST wrote a request: %v", entries)
	}
	if status, _, data := w.do(http.MethodPost, "/fs/v1/folders/notes/history/purge", "cookie-bare", map[string]any{"older_than_days": 7}); status != http.StatusForbidden {
		t.Errorf("purge, a cookie POST without X-Folder-Sync: %d %s", status, data)
	}
	if status, _, data := w.do(http.MethodPost, "/fs/v1/folders/notes/restore", "cookie", items); status != http.StatusOK {
		t.Errorf("a cookie POST with X-Folder-Sync: 1: %d %s", status, data)
	}
	if status, _, data := w.do(http.MethodPost, "/fs/v1/folders/notes/restore", "owner", items); status != http.StatusOK {
		t.Errorf("a bearer POST (its caller holds the token): %d %s", status, data)
	}
	// a POST that is not JSON, or too big
	req, _ := http.NewRequest(http.MethodPost, w.base+"fs/v1/folders/notes/restore", strings.NewReader("items=1"))
	req.Header.Set("Authorization", "Bearer "+w.srv.Token())
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, _ := http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnsupportedMediaType {
		t.Errorf("a form POST: %d", resp.StatusCode)
	}
	req, _ = http.NewRequest(http.MethodPost, w.base+"fs/v1/folders/notes/restore", bytes.NewReader(bytes.Repeat([]byte(" "), maxBody+1)))
	req.Header.Set("Authorization", "Bearer "+w.srv.Token())
	req.Header.Set("Content-Type", "application/json")
	resp, _ = http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("a body over 256 KiB: %d", resp.StatusCode)
	}
	if status, _, _ := w.do(http.MethodGet, "/fs/v1/folders/notes/restore", "owner", nil); status != http.StatusMethodNotAllowed {
		t.Errorf("GET restore: %d", status)
	}
}

// localRequests are the local restore requests written for this machine's folder.
func localRequests(w *world) []string {
	found, _ := filepath.Glob(filepath.Join(w.states[w.folders["/home/bam/notes"]], "requests", "*.json"))
	return found
}

// The page gets its cookie the Jupyter way: the printed URL's one request sets it and answers 303 to /fs/.
func TestThePageSetsItsCookieAndDropsTheToken(t *testing.T) {
	w := authWorld(t)
	status, header, _ := w.do(http.MethodGet, "/fs/?token="+w.srv.Token(), "none", nil)
	if status != http.StatusSeeOther || header.Get("Location") != "/fs/" {
		t.Fatalf("the printed URL: %d to %q", status, header.Get("Location"))
	}
	cookie := header.Get("Set-Cookie")
	for _, want := range []string{CookieName + "=" + w.srv.Token(), "Path=/fs/", "HttpOnly", "SameSite=Strict"} {
		if !strings.Contains(cookie, want) {
			t.Errorf("Set-Cookie %q lacks %s", cookie, want)
		}
	}
	if status, header, _ := w.do(http.MethodGet, "/fs/?token=nope", "none", nil); status != http.StatusUnauthorized || header.Get("Set-Cookie") != "" {
		t.Errorf("a wrong token in the URL: %d %q", status, header.Get("Set-Cookie"))
	}
	if status, _, _ := w.do(http.MethodGet, "/fs/", "none", nil); status != http.StatusUnauthorized {
		t.Errorf("the page with no cookie: %d", status)
	}
	status, _, page := w.do(http.MethodGet, "/fs/", "cookie", nil)
	folder := w.folders["/home/bam/notes"]
	if status != http.StatusOK || !strings.Contains(string(page), `<script type="module" src="/fs/ui/v1/folder-sync.js"></script>`) ||
		!strings.Contains(string(page), `<folder-sync-status project="notes" folder="`+folder+`"></folder-sync-status>`) {
		t.Errorf("the page: %d %s", status, page)
	}
}

// The element's files are ui.Files, the same bytes; never a listing, never outside them.
func TestTheElementsFilesAreTheEmbeddedOnes(t *testing.T) {
	w := authWorld(t)
	want, _ := fs.ReadFile(ui.Files, "v1/folder-sync.js")
	status, header, got := w.do(http.MethodGet, "/fs/ui/v1/folder-sync.js", "none", nil)
	if status != http.StatusOK || !bytes.Equal(got, want) || !strings.HasPrefix(header.Get("Content-Type"), "text/javascript") {
		t.Errorf("/fs/ui/v1/folder-sync.js: %d %s, %d bytes, want %d", status, header.Get("Content-Type"), len(got), len(want))
	}
	if status, _, _ := w.do(http.MethodGet, "/fs/ui/v1/vendor/diff.js", "none", nil); status != http.StatusOK {
		t.Errorf("diff.js: %d", status)
	}
	for _, path := range []string{"/fs/ui/v1/", "/fs/ui/v1", "/fs/ui/", "/fs/ui/v1/../embed.go", "/fs/ui/v1/nope.js"} {
		if status, _, _ := w.do(http.MethodGet, path, "none", nil); status != http.StatusNotFound {
			t.Errorf("%s: %d", path, status)
		}
	}
}

func TestNoAnswerCarriesACORSHeader(t *testing.T) {
	w := authWorld(t)
	for _, path := range []string{"/fs/v1/folders/notes/status", "/fs/v1/folders", "/fs/", "/fs/ui/v1/folder-sync.js", "/fs/v1/nope"} {
		req, _ := http.NewRequest(http.MethodGet, strings.TrimRight(w.base, "/")+path, nil)
		req.Header.Set("Origin", "https://evil.example")
		req.Header.Set("Authorization", "Bearer "+w.srv.Token())
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		for name := range resp.Header {
			if strings.HasPrefix(strings.ToLower(name), "access-control-") {
				t.Errorf("%s: %s", path, name)
			}
		}
	}
}
