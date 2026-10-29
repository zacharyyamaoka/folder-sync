// Package serve is `folder-sync serve`: the sync view's API and page on this machine (docs/API.md; docs/peps/0007
// §5.2). It answers the same routes and JSON as the accounts Worker online, from this machine's own state (the
// state directory, its local activity log) and the bucket, with the credentials sync uses, so one element,
// <folder-sync-status>, reads either. It listens on 127.0.0.1 only, with a token new for every start and a Host
// check, and sends no CORS headers. It only reads: its writes are restore requests (local ones for this machine's
// files, bucket ones for another machine's) and the web host's restores, forwarded to the accounts server with this
// machine's session. The engine still does all the syncing.
package serve

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"folder-sync/internal/account"
	"folder-sync/internal/layout"
	"folder-sync/internal/syncer"
)

// InfoSchema names serve.json (schema/view-api.schema.json#/$defs/serve_json).
const InfoSchema = "folder-sync-serve/1"

// CookieName is the page's cookie: the token, set by the one request that carries it in the address bar.
const CookieName = "folder_sync_serve"

// maxBody is the largest POST body (docs/API.md "Errors": 413 too_large).
const maxBody = 256 << 10

// Config is what a Server reads with. The command fills it from the machine's layout and sign-in; tests fill it
// with a scratch home, a stand-in bucket and a stub accounts server.
type Config struct {
	Layout layout.Layout
	// UI is the element's files, rooted above v1 (ui.Files): /fs/ui/<path> serves <path>.
	UI fs.FS
	// Open opens a synced folder with the credentials sync uses, for the routes that read the bucket. The server
	// closes what it opens.
	Open func(folder string) (*syncer.Project, error)
	// Account is this machine's sign-in (account.Current), or an error when it has none: the owner the page shows,
	// the storage figure, and the session the web host's restores are forwarded with.
	Account func() (account.Account, error)
	// HTTP calls the accounts server (nil: a client with a 10 s timeout).
	HTTP *http.Client
	// UserAgent names this machine to the accounts server.
	UserAgent string
	Now       func() time.Time // nil: time.Now
}

// Server answers the API and the page for every folder this machine syncs.
type Server struct {
	cfg   Config
	token string
	port  int

	mu       sync.Mutex
	logs     map[string]dayFile      // parsed local log day files, by path (re-read when size or mtime moves)
	records  map[string]recordCache  // change and pull records of other hosts, by key (immutable once written)
	pulls    map[string]listingCache // other hosts' pulls/ listings, by prefix
	waiting  map[string]waitingCache // the bucket's unanswered restore requests, by state dir
	usage    *usageFigure            // the last storage figure measured online
	usageTry time.Time               // when the figure was last asked for
	busy     map[string]bool         // background work in flight, by key
	work     sync.WaitGroup
}

// New makes a server with a fresh token: 32 random bytes, base64url (docs/API.md "On the machine").
func New(cfg Config) (*Server, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.HTTP == nil {
		cfg.HTTP = &http.Client{Timeout: 10 * time.Second}
	}
	return &Server{cfg: cfg, token: base64.RawURLEncoding.EncodeToString(raw), logs: map[string]dayFile{},
		records: map[string]recordCache{}, pulls: map[string]listingCache{}, waiting: map[string]waitingCache{}, busy: map[string]bool{}}, nil
}

// Token is this start's token.
func (s *Server) Token() string { return s.token }

// Listen binds 127.0.0.1:port (0: the port the OS gives) and remembers the port for the Host check.
func (s *Server) Listen(port int) (net.Listener, error) {
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	s.port = ln.Addr().(*net.TCPAddr).Port
	return ln, nil
}

// Port is the port Listen bound.
func (s *Server) Port() int { return s.port }

// URL is the server's root, as serve.json gives it.
func (s *Server) URL() string { return fmt.Sprintf("http://127.0.0.1:%d/", s.port) }

// PageURL is what `folder-sync serve` prints: the page, with the token that sets its cookie.
func (s *Server) PageURL() string { return s.URL() + "fs/?token=" + s.token }

// Info is serve.json (schema/view-api.schema.json#/$defs/serve_json).
type Info struct {
	Schema string `json:"schema"`
	URL    string `json:"url"`
	Port   int    `json:"port"`
	Token  string `json:"token"`
	PID    int    `json:"pid"`
}

// InfoPath is ~/.folder-sync/serve.json.
func InfoPath(l layout.Layout) string { return filepath.Join(l.Root, "serve.json") }

// WriteInfo writes serve.json, mode 0600, once the server listens.
func (s *Server) WriteInfo(path string) error {
	data, err := json.MarshalIndent(Info{Schema: InfoSchema, URL: s.URL(), Port: s.port, Token: s.token, PID: os.Getpid()}, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// RemoveInfo removes serve.json when it is still this server's. WHY the check: a second serve started since owns
// the file now, and its callers must keep finding it.
func (s *Server) RemoveInfo(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var info Info
	if json.Unmarshal(data, &info) == nil && info.Token == s.token {
		os.Remove(path)
	}
}

// apiError is a non-2xx answer: { "error": <code>, "why": <sentence> } (schema/view-api.schema.json#/$defs/error).
type apiError struct {
	Status int    `json:"-"`
	Code   string `json:"error"`
	Why    string `json:"why"`
}

func (e *apiError) Error() string { return e.Code + ": " + e.Why }

func fail(status int, code, why string) *apiError {
	return &apiError{Status: status, Code: code, Why: why}
}

var (
	errWrongHost = fail(http.StatusMisdirectedRequest, "wrong_host", "This server answers only http://127.0.0.1:<its port>/.")
	errNoToken   = fail(http.StatusUnauthorized, "no_token", "Send Authorization: Bearer <token> from ~/.folder-sync/serve.json, or open the URL folder-sync serve printed.")
	errCSRF      = fail(http.StatusForbidden, "csrf", "A page's POST must carry X-Folder-Sync: 1.")
	errMethod    = fail(http.StatusMethodNotAllowed, "method", "This route does not take that method.")
	errNotFound  = fail(http.StatusNotFound, "not_found", "No such folder, host or path on this machine.")
)

func writeJSON(w http.ResponseWriter, status int, body any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false) // WHY: a why says "<token>" and "<path>" as written; the answer is JSON, never HTML
	data := []byte(`{"error":"failed","why":"The answer could not be written."}` + "\n")
	if err := enc.Encode(body); err == nil {
		data = buf.Bytes()
	} else {
		status = http.StatusInternalServerError
	}
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Cache-Control", "private, no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	w.Write(data)
}

func writeError(w http.ResponseWriter, err error) {
	var e *apiError
	if !errors.As(err, &e) {
		e = fail(http.StatusInternalServerError, "failed", "This machine could not answer: "+err.Error())
	}
	writeJSON(w, e.Status, e)
}

// ServeHTTP checks the Host on every request (DNS rebinding), and the token on the API and the page.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Host != fmt.Sprintf("127.0.0.1:%d", s.port) {
		writeError(w, errWrongHost)
		return
	}
	path := r.URL.Path
	switch {
	case path == "/" || path == "/fs":
		http.Redirect(w, r, "/fs/", http.StatusSeeOther)
	case path == "/fs/":
		s.page(w, r)
	case strings.HasPrefix(path, "/fs/ui/"):
		s.uiFile(w, r)
	case strings.HasPrefix(path, "/fs/v1/"):
		viaCookie, ok := s.authorized(r)
		if !ok {
			writeError(w, errNoToken)
			return
		}
		// WHY only for the cookie: a page's POST rides on it, and a cross-site form cannot set this header; a
		// bearer caller (vt serve, a script) holds the token itself
		if r.Method == http.MethodPost && viaCookie && r.Header.Get("X-Folder-Sync") != "1" {
			writeError(w, errCSRF)
			return
		}
		s.api(w, r)
	default:
		writeError(w, errNotFound)
	}
}

// authorized reports whether the request carries the token, as a bearer or as the page's cookie.
func (s *Server) authorized(r *http.Request) (viaCookie, ok bool) {
	if bearer, found := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); found {
		return false, s.isToken(bearer)
	}
	if c, err := r.Cookie(CookieName); err == nil {
		return true, s.isToken(c.Value)
	}
	return false, false
}

func (s *Server) isToken(value string) bool {
	return subtle.ConstantTimeCompare([]byte(value), []byte(s.token)) == 1
}

// readBody reads a POST's JSON body into v (413 too_large, 415 json_only, 400 bad_request).
func readBody(r *http.Request, v any) error {
	if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(strings.ToLower(strings.TrimSpace(ct)), "application/json") {
		return fail(http.StatusUnsupportedMediaType, "json_only", "Send the body as application/json.")
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil {
		return fail(http.StatusBadRequest, "bad_request", "The body could not be read.")
	}
	if len(data) > maxBody {
		return fail(http.StatusRequestEntityTooLarge, "too_large", "A body is at most 256 KiB.")
	}
	if err := json.Unmarshal(data, v); err != nil {
		return fail(http.StatusBadRequest, "bad_request", "The body is not the JSON this route takes.")
	}
	return nil
}

// later runs fn in the background, at most one per key at a time; Close waits for them.
func (s *Server) later(key string, fn func()) {
	s.mu.Lock()
	if s.busy[key] {
		s.mu.Unlock()
		return
	}
	s.busy[key] = true
	s.work.Add(1)
	s.mu.Unlock()
	go func() {
		defer s.work.Done()
		fn()
		s.mu.Lock()
		delete(s.busy, key)
		s.mu.Unlock()
	}()
}

// Close waits for the background work (the storage figure, the bucket's restore requests) to finish.
func (s *Server) Close() { s.work.Wait() }
