package serve

// `folder-sync serve` against the shared fixtures (docs/API.md, testdata/view-api/): every fixture with "serve" in
// `servers` is sent to a real Server, over a real state directory (registrations, manifests, last-sync.json and the
// local log, in the engine's own formats) and a bucket built from the fixture's `given` (the folder the fixtures
// describe), and its status and body must be exactly the fixture's. What a fixture says is compared by presence (a
// minted request id, an opaque cursor) is compared by presence; this machine's scratch folder stands for
// /home/bam/notes. Then serve.json against testdata/serve/.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"folder-sync/internal/account"
	"folder-sync/internal/config"
	"folder-sync/internal/history"
	"folder-sync/internal/layout"
	"folder-sync/internal/manifest"
	"folder-sync/internal/names"
	"folder-sync/internal/syncer"
	"folder-sync/ui"
)

const (
	gpu    = "b55e9683-7854-4121-a56a-9bae7c3ab1da"
	web    = "e2a0b1c2-d3e4-4f50-9a1b-2c3d4e5f6a7b"
	laptop = "7c1d2e3f-0a1b-4c2d-8e3f-405162738495"
	bucket = "folder-sync"
)

var testdata = filepath.Join("..", "..", "testdata")

func mustTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		panic(err)
	}
	return t
}

func readJSON(t *testing.T, path string, v any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
}

func writeFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// world is one machine: a scratch home with its layout, synced folders, a bucket and an accounts server.
type world struct {
	t        *testing.T
	home     string
	layout   layout.Layout
	now      time.Time
	s3       *fakeS3
	accounts *httptest.Server
	asked    []string // what the accounts server was asked: "<METHOD> <path> <body>"
	srv      *Server
	base     string
	folders  map[string]string // fixture path ("/home/bam/notes") -> this world's folder
	states   map[string]string // folder -> state dir
	signedIn bool
}

func newWorld(t *testing.T, now time.Time) *world {
	w := &world{t: t, home: t.TempDir(), now: now, folders: map[string]string{}, states: map[string]string{}, signedIn: true}
	l, err := layout.For("linux", func(k string) string {
		if k == "HOME" {
			return w.home
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	w.layout = l
	for _, dir := range l.Dirs() {
		os.MkdirAll(dir, 0o700)
	}
	data, _ := json.Marshal(map[string]string{"schema": "folder-sync-host/1", "id": gpu, "name": "bam-GPU", "created_at": "2026-10-01T00:00:00Z"})
	writeFile(t, l.HostFile, data)
	w.s3 = newFakeS3(t, bucket, func() time.Time { return w.now })
	w.accounts = httptest.NewServer(http.HandlerFunc(w.accountsServer))
	t.Cleanup(w.accounts.Close)
	return w
}

// accountsServer answers the two calls serve makes online: the usage figure, and the web host's restores.
func (w *world) accountsServer(rw http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	w.asked = append(w.asked, r.Method+" "+r.URL.Path+" "+strings.TrimSpace(string(body)))
	if r.Header.Get("Authorization") != "Bearer tok-owner" {
		http.Error(rw, `{"error":"signed_out","why":"no session"}`, http.StatusUnauthorized)
		return
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/fs/v1/usage":
		var fx fixture
		readJSON(w.t, filepath.Join(testdata, "view-api", "usage.json"), &fx)
		rw.Header().Set("Content-Type", "application/json")
		rw.Write(fx.Response.Body)
	case r.Method == http.MethodPost && r.URL.Path == "/fs/v1/folders/notes/restore":
		var doc struct {
			Items []restoreItem `json:"items"`
		}
		json.Unmarshal(body, &doc)
		out := restoreBody{Applied: []appliedItem{}, Requested: []requestedHost{}, Failed: []failedItem{}}
		for _, it := range doc.Items {
			out.Applied = append(out.Applied, appliedItem{Host: it.Host, Path: it.Path, Version: it.Version, Seq: 7})
		}
		rw.Header().Set("Content-Type", "application/json")
		json.NewEncoder(rw).Encode(out)
	default:
		http.Error(rw, `{"error":"not_found","why":"no"}`, http.StatusNotFound)
	}
}

// addFolder makes a synced folder at home/<name>, registered for project in bkt, standing for the fixtures' path.
func (w *world) addFolder(name, project, bkt, standsFor string) string {
	t := w.t
	dir := filepath.Join(w.home, name)
	os.MkdirAll(dir, 0o755)
	cfg := config.Config{Project: project, Bucket: bkt}
	if err := config.Write(dir, cfg); err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(w.layout.Projects, syncer.StateKey(project, dir, ""))
	data, _ := json.Marshal(syncer.Registration{Schema: syncer.RegistrationSchema, Project: project, Bucket: bkt, Folder: dir, HostID: gpu, RegisteredAt: "2026-10-01T00:00:00Z"})
	writeFile(t, filepath.Join(state, "project.json"), data)
	w.folders[standsFor] = dir
	w.states[dir] = state
	return dir
}

func entry(path string, size int64, sha, writtenAt string) manifest.Entry {
	return manifest.Entry{Path: path, Size: size, MTime: writtenAt, SHA256: sha, WrittenAt: writtenAt}
}

func (w *world) saveManifest(state, host, name string, seq int64, at string, files ...manifest.Entry) {
	m := manifest.Manifest{Schema: manifest.Schema, Project: "notes", HostID: host, HostName: name, Seq: seq, GeneratedAt: at, Files: files}
	m.Sort()
	path := filepath.Join(state, "manifest.json")
	if host != gpu {
		path = filepath.Join(state, "peers", host+".json")
	}
	os.MkdirAll(filepath.Dir(path), 0o700)
	if err := manifest.Save(path, m); err != nil {
		w.t.Fatal(err)
	}
}

// localLog writes the folder's local log for one UTC day, one event per line.
func (w *world) localLog(state, day string, lines ...string) {
	writeFile(w.t, filepath.Join(state, "log", day+".jsonl"), []byte(strings.Join(lines, "\n")+"\n"))
}

func (w *world) lastSync(state string, last syncer.LastSync) {
	last.Schema = syncer.LastSyncSchema
	data, _ := json.Marshal(last)
	writeFile(w.t, filepath.Join(state, "last-sync.json"), data)
}

// start serves the world on 127.0.0.1, its bucket reached with a key in the environment (as a v0 machine is).
func (w *world) start() {
	t := w.t
	getenv := func(k string) string {
		return map[string]string{"HOME": w.home, "FOLDER_SYNC_ACCESS_KEY_ID": "fixture-key", "FOLDER_SYNC_SECRET_ACCESS_KEY": "fixture-secret",
			"FOLDER_SYNC_ENDPOINT": w.s3.server.URL}[k]
	}
	srv, err := New(Config{
		Layout: w.layout,
		UI:     ui.Files,
		Open: func(folder string) (*syncer.Project, error) {
			return syncer.Open(folder, w.layout, getenv, "rclone", io.Discard)
		},
		Account: func() (account.Account, error) {
			if !w.signedIn {
				return account.Account{}, account.ErrNotSignedIn
			}
			return account.Account{Schema: account.Schema, Server: w.accounts.URL, Token: "tok-owner", User: account.User{ID: "AbC123zz9yX8", Email: "zach@example.com"}}, nil
		},
		Now: func() time.Time { return w.now },
	})
	if err != nil {
		t.Fatal(err)
	}
	ln, err := srv.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: srv}
	go server.Serve(ln)
	t.Cleanup(func() {
		server.Close()
		srv.Close()
	})
	w.srv, w.base = srv, srv.URL()
}

// do sends one request: auth is "owner" (the bearer token), "cookie" (the page's cookie, with X-Folder-Sync: 1 on
// a POST), "cookie-bare" (the cookie alone), "none", or "bad_host" (the token, from another Host).
func (w *world) do(method, path, auth string, body any) (int, http.Header, []byte) {
	w.t.Helper()
	var reader io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		reader = bytes.NewReader(data)
	}
	req, _ := http.NewRequest(method, strings.TrimRight(w.base, "/")+path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	switch auth {
	case "owner":
		req.Header.Set("Authorization", "Bearer "+w.srv.Token())
	case "cookie", "cookie-bare":
		req.AddCookie(&http.Cookie{Name: CookieName, Value: w.srv.Token()})
		if auth == "cookie" && method == http.MethodPost {
			req.Header.Set("X-Folder-Sync", "1")
		}
	case "bad_host":
		req.Header.Set("Authorization", "Bearer "+w.srv.Token())
		req.Host = "evil.example:41873"
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		w.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, data
}

type fixture struct {
	Name    string   `json:"name"`
	Servers []string `json:"servers"`
	Given   json.RawMessage
	Request struct {
		Method string          `json:"method"`
		Path   string          `json:"path"`
		Auth   string          `json:"auth"`
		Body   json.RawMessage `json:"body"`
	} `json:"request"`
	Response struct {
		Status int             `json:"status"`
		Body   json.RawMessage `json:"body"`
	} `json:"response"`
}

// clampOld is web's kept hearts/clamp-24.json, restore-online's given bytes.
func clampOld(t *testing.T) string {
	var fx struct {
		Given struct {
			Bytes map[string]string `json:"bytes"`
		} `json:"given"`
	}
	readJSON(t, filepath.Join(testdata, "view-api", "restore-online.json"), &fx)
	return fx.Given.Bytes[web+"/hearts/clamp-24.json@2026-10-28T19:02:11.481Z_763d2e71f45a8d0f"]
}

func sha(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// notes builds the folder every fixture describes, as this machine (bam-GPU) holds it: its manifest (seq 46), web's
// (seq 7) and bam-laptop's (seq 12) as last pulled; each kept version at its left_at; every change and pull record of
// testdata/changes/ and testdata/pulls/ (this machine's own too, which serve must not read: its local log has them);
// the local log the fixture names; and the storage figure as measured at 21:05.
func notes(t *testing.T, name string) *world {
	now := mustTime("2026-10-28T21:12:00.000Z")
	if name == "status-serve-offline" {
		now = mustTime("2026-10-28T21:22:30.000Z")
	}
	w := newWorld(t, now)
	folder := w.addFolder("notes", "notes", bucket, "/home/bam/notes")
	state := w.states[folder]
	switch name {
	case "error-serve-ambiguous", "status-serve-folder":
		w.addFolder("notes-elsewhere", "notes", "another-bucket", "/home/bam/notes-elsewhere")
	case "folders-serve":
		w.addFolder("vt", "vibetracks", bucket, "/home/bam/vt")
	}
	w.saveManifest(state, gpu, "bam-GPU", 46, "2026-10-28T21:10:00.000Z",
		entry("notes/plan.md", 1980, "9f2c1a3b4c5d6e7f00112233445566778899aabbccddeeff0011223344556677", "2026-10-28T20:46:12.004Z"),
		entry("notes/new-idea.md", 311, "4a1f0c9e8d7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f", "2026-10-28T20:41:00.402Z"),
		entry("notes/scratch.md", 12, "0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c", "2026-10-28T20:41:00.415Z"),
		entry("logs/agent.log", 88123, "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef", "2026-10-28T20:41:00.418Z"))
	old := clampOld(t)
	w.saveManifest(state, web, "web", 7, "2026-10-28T20:50:00.020Z", entry("hearts/clamp-24.json", int64(len(old)), sha(old), "2026-10-28T20:50:00.010Z"))
	w.saveManifest(state, laptop, "bam-laptop", 12, "2026-10-22T14:05:00.000Z",
		entry("notes/laptop-todo.md", 77, "e1d2c3b4a59687780011223344556677889900aabbccddeeff00112233445566", "2026-10-22T10:00:00.000Z"))
	data, _ := json.Marshal(syncer.PeerState{Known: []string{laptop, web}, ETags: map[string]string{}})
	writeFile(t, filepath.Join(state, "peers.json"), data)

	// kept versions (testdata/view-api/history*.json, deleted*.json), at their left_at
	keep := func(host, path, version string, size int, leftAt string) {
		w.s3.put(history.Key("", "notes", host, path, version), bytes.Repeat([]byte("v"), size), mustTime(leftAt))
	}
	keep(gpu, "notes/plan.md", "2026-10-28T20:41:00.410Z_7e3b9d0a1c2f4e5d", 2140, "2026-10-28T20:46:12.004Z")
	keep(gpu, "notes/plan.md", "2026-10-28T20:31:00.117Z_9f2c1a3b4c5d6e7f", 1980, "2026-10-28T20:41:00.410Z")
	keep(gpu, "notes/plan.md", "2026-10-28T20:00:00.000Z_unlisted", 2001, "2026-10-28T20:00:00.000Z")
	keep(gpu, "notes/plan.md", "2026-10-28T18:02:41.502Z_1b2c3d4e5f607182", 1402, "2026-10-28T18:50:00.000Z")
	keep(gpu, "notes/old-ideas.md", "2026-10-21T09:12:44.500Z_5555666677778888", 5121, "2026-10-28T20:41:00.420Z")
	keep(web, "hearts/arm-17.json", "2026-10-26T10:00:00.999Z_aaaabbbbccccdddd", 233, "2026-10-28T14:20:00.000Z")
	w.s3.put(history.Key("", "notes", web, "hearts/clamp-24.json", "2026-10-28T19:02:11.481Z_763d2e71f45a8d0f"), []byte(old), mustTime("2026-10-28T20:47:28.790Z"))
	keep(laptop, "photos/IMG_2231.jpg", "2026-10-22T14:03:51.090Z_2c4e6a8b0d1f3e5a", 2811409, "2026-10-22T14:05:00.000Z")
	// the records, as published
	changes, _ := filepath.Glob(filepath.Join(testdata, "changes", "*.json"))
	for _, path := range changes {
		var rec history.ChangeRecord
		readJSON(t, path, &rec)
		data, _ := os.ReadFile(path)
		w.s3.put(history.ChangesKey("", "notes", rec.HostID, rec.Seq), data, mustTime(rec.At))
	}
	pulls, _ := filepath.Glob(filepath.Join(testdata, "pulls", "*.json"))
	for _, path := range pulls {
		var rec history.PullRecord
		readJSON(t, path, &rec)
		data, _ := os.ReadFile(path)
		w.s3.put(history.PullsKey("", "notes", rec.HostID, rec.At), data, mustTime(rec.At))
	}

	// the local log: activity's is testdata/events/file-events.jsonl; status's says how the engine runs
	switch {
	case strings.HasPrefix(name, "activity-"):
		data, _ := os.ReadFile(filepath.Join(testdata, "events", "file-events.jsonl"))
		var lines []string
		for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
			// WHY without its truncated line: activity-serve and activity-warn list every other line of the log, and
			// that one (23:59:01, warn) in neither; reported to the contract owner rather than edited
			if !strings.Contains(line, `"event":"truncated"`) {
				lines = append(lines, line)
			}
		}
		w.localLog(state, "2026-10-28", lines...)
	default:
		round := func(at string, ok bool, extra string) string {
			return fmt.Sprintf(`{"schema":"folder-sync-event/1","event":"round","at":%q,"level":"info","project":"notes","host":%q,"host_name":"bam-GPU","ok":%v%s}`, at, gpu, ok, extra)
		}
		lines := []string{
			fmt.Sprintf(`{"schema":"folder-sync-event/1","event":"watching","at":"2026-10-28T08:00:00.000Z","level":"info","folder":%q,"project":"notes","host":%q,"host_name":"bam-GPU","watcher":true,"hub":"on"}`, folder, gpu),
			round("2026-10-28T21:10:00.000Z", true, `,"uploaded":1,"ms":412`),
		}
		if name == "status-serve-offline" {
			lines = append(lines, strings.Replace(round("2026-10-28T21:22:03.000Z", false, `,"kind":"offline","why":"folder-sync-accounts.zach-yamaoka.workers.dev:443 does not answer (dial tcp: i/o timeout)","ms":3002`), `"level":"info"`, `"level":"warn"`, 1))
		}
		w.localLog(state, "2026-10-28", lines...)
	}
	w.lastSync(state, syncer.LastSync{Project: "notes", Bucket: bucket, Folder: folder, HostID: gpu, HostName: "bam-GPU",
		RoundStarted: "2026-10-28T21:09:59.588Z", RoundFinished: "2026-10-28T21:10:00.000Z", OK: true, LastCleanRun: "2026-10-28T21:10:00.000Z"})
	if name == "status-serve-offline" {
		w.accounts.Close() // the network is down: the figure stays as last measured
	}
	w.start()
	var usage fixture
	readJSON(t, filepath.Join(testdata, "view-api", "usage.json"), &usage)
	var figure usageFigure
	json.Unmarshal(usage.Response.Body, &figure)
	figure.MeasuredAt = "2026-10-28T21:05:00.000Z"
	w.srv.usage, w.srv.usageTry = &figure, mustTime("2026-10-28T21:05:00.000Z")
	return w
}

// localize puts this world's folders in a fixture's request path, and the fixtures' paths back in an answer.
func (w *world) localize(path string) string {
	for standsFor, dir := range w.folders {
		path = strings.ReplaceAll(path, url.QueryEscape(standsFor), url.QueryEscape(dir))
	}
	return path
}

func (w *world) generalize(body []byte) []byte {
	type pair struct{ dir, standsFor string }
	var pairs []pair
	for standsFor, dir := range w.folders {
		pairs = append(pairs, pair{dir, standsFor})
	}
	sort.Slice(pairs, func(i, j int) bool { return len(pairs[i].dir) > len(pairs[j].dir) })
	for _, p := range pairs {
		quoted, _ := json.Marshal(p.dir)
		want, _ := json.Marshal(p.standsFor)
		body = bytes.ReplaceAll(body, quoted, want)
	}
	return body
}

var presenceOnly = regexp.MustCompile(`^\$\.(next|requested\[\d+\]\.request)$`)

// sameShape compares two JSON values exactly, except the values compared by presence only.
func sameShape(got, want any, at string) []string {
	if presenceOnly.MatchString(at) {
		if (got == nil) != (want == nil) {
			return []string{fmt.Sprintf("%s: %v, want %v (by presence)", at, got, want)}
		}
		return nil
	}
	switch wv := want.(type) {
	case map[string]any:
		gv, ok := got.(map[string]any)
		if !ok {
			return []string{fmt.Sprintf("%s: %v, want an object", at, got)}
		}
		var out []string
		for k := range wv {
			out = append(out, sameShape(gv[k], wv[k], at+"."+k)...)
			if _, ok := gv[k]; !ok {
				out = append(out, fmt.Sprintf("%s.%s: missing", at, k))
			}
		}
		for k := range gv {
			if _, ok := wv[k]; !ok {
				out = append(out, fmt.Sprintf("%s.%s: not in the fixture (%v)", at, k, gv[k]))
			}
		}
		return out
	case []any:
		gv, ok := got.([]any)
		if !ok || len(gv) != len(wv) {
			g, _ := json.Marshal(got)
			return []string{fmt.Sprintf("%s: %d items, want %d: %s", at, len(gv), len(wv), g)}
		}
		var out []string
		for i := range wv {
			out = append(out, sameShape(gv[i], wv[i], fmt.Sprintf("%s[%d]", at, i))...)
		}
		return out
	}
	if !reflect.DeepEqual(got, want) {
		return []string{fmt.Sprintf("%s: %v, want %v", at, got, want)}
	}
	return nil
}

func serveFixtures(t *testing.T) []fixture {
	paths, _ := filepath.Glob(filepath.Join(testdata, "view-api", "*.json"))
	var out []fixture
	for _, path := range paths {
		var fx fixture
		readJSON(t, path, &fx)
		fx.Name = strings.TrimSuffix(filepath.Base(path), ".json")
		for _, s := range fx.Servers {
			if s == "serve" {
				out = append(out, fx)
			}
		}
	}
	if len(out) < 15 {
		t.Fatalf("only %d serve fixtures: is testdata/ where it should be?", len(out))
	}
	return out
}

func answerFixture(t *testing.T, fx fixture) (*world, int, http.Header, []byte) {
	w := notes(t, fx.Name)
	var body any
	if len(fx.Request.Body) > 0 {
		body = fx.Request.Body
	}
	status, header, data := w.do(fx.Request.Method, w.localize(fx.Request.Path), fx.Request.Auth, body)
	return w, status, header, data
}

func TestEveryServeFixtureIsAnsweredByteForShape(t *testing.T) {
	for _, fx := range serveFixtures(t) {
		t.Run(fx.Name, func(t *testing.T) {
			w, status, _, data := answerFixture(t, fx)
			if status != fx.Response.Status {
				t.Fatalf("status %d, want %d: %s", status, fx.Response.Status, data)
			}
			var got, want any
			if err := json.Unmarshal(w.generalize(data), &got); err != nil {
				t.Fatalf("not JSON: %s", data)
			}
			json.Unmarshal(fx.Response.Body, &want)
			if diffs := sameShape(got, want, "$"); len(diffs) > 0 {
				t.Errorf("%d differences from testdata/view-api/%s.json:\n  %s", len(diffs), fx.Name, strings.Join(diffs, "\n  "))
			}
		})
	}
}

// restore-serve wrote what it answered: one local request for this machine, one bucket request for bam-laptop (both
// valid requests the engine reads), and the web host's item went to the accounts server with this machine's session.
func TestRestoreServeWritesTheRequestsItAnswers(t *testing.T) {
	var fx fixture
	readJSON(t, filepath.Join(testdata, "view-api", "restore-serve.json"), &fx)
	fx.Name = "restore-serve"
	w, status, _, data := answerFixture(t, fx)
	if status != http.StatusOK {
		t.Fatalf("%d %s", status, data)
	}
	var body restoreBody
	json.Unmarshal(data, &body)
	if len(body.Requested) != 2 {
		t.Fatalf("requested: %+v", body.Requested)
	}
	local, err := os.ReadFile(filepath.Join(syncer.LocalRequestsDir(w.states[w.folders["/home/bam/notes"]]), body.Requested[0].Request+".json"))
	if err != nil {
		t.Fatalf("the local request: %v", err)
	}
	var req history.Request
	json.Unmarshal(local, &req)
	if err := req.Check("notes", gpu); err != nil || len(req.Items) != 1 || req.Items[0].Path != "notes/plan.md" {
		t.Errorf("the local request is not one the engine applies: %v %+v", err, req)
	}
	remote, ok := w.s3.get(history.RequestKey("", "notes", laptop, body.Requested[1].Request))
	if !ok {
		t.Fatalf("no bucket request for bam-laptop: %v", w.s3.keys("_requests/"))
	}
	json.Unmarshal(remote, &req)
	if err := req.Check("notes", laptop); err != nil || req.Items[0].Version != "2026-10-27T18:20:00.250Z_e1d2c3b4a5968778" {
		t.Errorf("the bucket request: %v %+v", err, req)
	}
	forwarded := false
	for _, call := range w.asked {
		forwarded = forwarded || (strings.HasPrefix(call, "POST /fs/v1/folders/notes/restore ") && strings.Contains(call, `"host":"`+web+`"`) && !strings.Contains(call, gpu))
	}
	if !forwarded {
		t.Errorf("the web host's item was not forwarded alone: %v", w.asked)
	}
}

// activity on serve reads this machine's events from its local log only: its own change records in the bucket
// (machine-0000000000{43,44,45}.json) and its pull record never add a line, and nothing appears twice.
func TestActivityNeverReadsThisMachinesOwnRecords(t *testing.T) {
	w := notes(t, "activity-serve")
	status, _, data := w.do(http.MethodGet, "/fs/v1/folders/notes/activity?limit=500", "owner", nil)
	if status != http.StatusOK {
		t.Fatalf("%d %s", status, data)
	}
	var body struct {
		Events []map[string]any `json:"events"`
	}
	json.Unmarshal(data, &body)
	seen := map[string]bool{}
	for _, e := range body.Events {
		key := fmt.Sprint(e["host"], e["event"], e["path"], e["at"])
		if seen[key] {
			t.Errorf("twice: %s", key)
		}
		seen[key] = true
		if e["path"] == "videos/raw-take-3.mp4" {
			t.Errorf("the server's delete job for this machine came from its change record, not its log: %v", e)
		}
	}
	for _, call := range w.s3.calls {
		if strings.Contains(call, "_changes/notes/"+gpu+"/") {
			t.Errorf("read this machine's own records: %s", call)
		}
	}
}

// Records are written once: a second page of activity reads none of them again.
func TestActivityCachesTheOthersRecords(t *testing.T) {
	w := notes(t, "activity-serve")
	w.do(http.MethodGet, "/fs/v1/folders/notes/activity", "owner", nil)
	before := len(w.s3.calls)
	w.do(http.MethodGet, "/fs/v1/folders/notes/activity", "owner", nil)
	for _, call := range w.s3.calls[before:] {
		if strings.HasPrefix(call, "GET _changes/") {
			t.Errorf("read again: %s", call)
		}
	}
}

// Following next pages through the whole log one event at a time gives every event once, newest first.
func TestActivityPagesThroughEverythingOnce(t *testing.T) {
	w := notes(t, "activity-serve")
	var all []string
	path := "/fs/v1/folders/notes/activity?limit=3"
	for pages := 0; pages < 20; pages++ {
		status, _, data := w.do(http.MethodGet, path, "owner", nil)
		if status != http.StatusOK {
			t.Fatalf("%d %s", status, data)
		}
		var body struct {
			Events []map[string]any `json:"events"`
			Next   *string          `json:"next"`
		}
		json.Unmarshal(data, &body)
		for _, e := range body.Events {
			all = append(all, fmt.Sprint(e["at"]))
		}
		if body.Next == nil {
			break
		}
		path = "/fs/v1/folders/notes/activity?limit=3&before=" + url.QueryEscape(*body.Next)
	}
	var fx fixture
	readJSON(t, filepath.Join(testdata, "view-api", "activity-serve.json"), &fx)
	var want struct {
		Events []map[string]any `json:"events"`
	}
	json.Unmarshal(fx.Response.Body, &want)
	var wantAt []string
	for _, e := range want.Events {
		wantAt = append(wantAt, fmt.Sprint(e["at"]))
	}
	if !reflect.DeepEqual(all, wantAt) {
		t.Errorf("paged:\n  %v\nwant:\n  %v", all, wantAt)
	}
}

// Offline, status and activity still answer: from the state directory and the local log alone.
func TestStatusAndActivityAnswerWithNoNetwork(t *testing.T) {
	w := notes(t, "activity-serve")
	w.s3.server.Close()
	w.accounts.Close()
	if status, _, data := w.do(http.MethodGet, "/fs/v1/folders/notes/status", "owner", nil); status != http.StatusOK {
		t.Errorf("status offline: %d %s", status, data)
	}
	status, _, data := w.do(http.MethodGet, "/fs/v1/folders/notes/activity", "owner", nil)
	var body struct {
		Events []map[string]any `json:"events"`
	}
	json.Unmarshal(data, &body)
	if status != http.StatusOK || len(body.Events) != 13 {
		t.Errorf("activity offline: %d, %d events (this machine's 13), %s", status, len(body.Events), data)
	}
	if status, _, data := w.do(http.MethodGet, "/fs/v1/folders/notes/history/"+gpu+"/notes/plan.md", "owner", nil); status != http.StatusBadGateway || !strings.Contains(string(data), "needs the network") {
		t.Errorf("history offline: %d %s", status, data)
	}
}

// A skipped name is a warning on serve (the Worker never knows of one), saying what to do; status is attention.
func TestSkipWarningsComeFromThisMachine(t *testing.T) {
	w := notes(t, "status-serve")
	state := w.states[w.folders["/home/bam/notes"]]
	var last syncer.LastSync
	readJSON(t, filepath.Join(state, "last-sync.json"), &last)
	last.Skipped = append(last.Skipped, names.Skipped{Path: "CON.txt", Reason: "a reserved name on Windows: rename CON.txt to sync it"})
	w.lastSync(state, last)
	_, _, data := w.do(http.MethodGet, "/fs/v1/folders/notes/status", "owner", nil)
	var body statusBody
	json.Unmarshal(data, &body)
	want := []warning{{Kind: "skipped", Level: "warn", Path: "CON.txt", Text: "A reserved name on Windows: rename CON.txt to sync it."}}
	if !reflect.DeepEqual(body.Warnings, want) || body.State != "attention" || body.Headline != "1 thing needs you" {
		t.Errorf("%+v %s %q", body.Warnings, body.State, body.Headline)
	}
	// the engine's own wording names the reason only: the warning adds what to do
	last.Skipped = []names.Skipped{{Path: "CON.txt", Reason: `"CON.txt" is a reserved device name on Windows`}}
	w.lastSync(state, last)
	_, _, data = w.do(http.MethodGet, "/fs/v1/folders/notes/status", "owner", nil)
	json.Unmarshal(data, &body)
	if len(body.Warnings) != 1 || body.Warnings[0].Text != `"CON.txt" is a reserved device name on Windows: rename it to sync it.` {
		t.Errorf("%+v", body.Warnings)
	}
}

// serve.json once it listens: the shape of testdata/serve/serve.json, the schema's patterns, mode 0600; removed on
// stop, and only while it is still this server's.
func TestServeJSONMatchesTheFixture(t *testing.T) {
	w := newWorld(t, time.Now())
	w.start()
	path := InfoPath(w.layout)
	if err := w.srv.WriteInfo(path); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("serve.json: %v %v", err, info.Mode())
	}
	var got, want map[string]any
	readJSON(t, path, &got)
	readJSON(t, filepath.Join(testdata, "serve", "serve.json"), &want)
	if keys(got) != keys(want) {
		t.Errorf("keys %s, want %s", keys(got), keys(want))
	}
	port := w.srv.Port()
	if got["schema"] != "folder-sync-serve/1" || got["url"] != fmt.Sprintf("http://127.0.0.1:%d/", port) || got["port"] != float64(port) || got["pid"] != float64(os.Getpid()) {
		t.Errorf("serve.json: %v", got)
	}
	if !regexp.MustCompile(`^http://127\.0\.0\.1:[0-9]{1,5}/$`).MatchString(fmt.Sprint(got["url"])) || !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(fmt.Sprint(got["token"])) {
		t.Errorf("serve.json against the schema's patterns: %v", got)
	}
	other, _ := New(Config{Layout: w.layout})
	other.RemoveInfo(path)
	if _, err := os.Stat(path); err != nil {
		t.Errorf("another server removed this one's serve.json")
	}
	w.srv.RemoveInfo(path)
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("serve.json is still there: %v", err)
	}
}

func keys(m map[string]any) string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return strings.Join(out, ",")
}

// It listens on 127.0.0.1 only.
func TestListensOnLoopbackOnly(t *testing.T) {
	w := newWorld(t, time.Now())
	w.start()
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		ip, _, _ := net.ParseCIDR(a.String())
		if ip == nil || ip.IsLoopback() || ip.To4() == nil {
			continue
		}
		if conn, err := net.DialTimeout("tcp", net.JoinHostPort(ip.String(), fmt.Sprint(w.srv.Port())), 300*time.Millisecond); err == nil {
			conn.Close()
			t.Errorf("answers on %s", ip)
		}
	}
}
