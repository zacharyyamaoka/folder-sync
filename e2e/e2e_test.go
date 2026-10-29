// Package e2e runs two simulated machines (two HOME dirs, two folders) against a
// local S3-compatible stand-in: `rclone serve s3` on 127.0.0.1:4801 over a temp
// dir, with throwaway keys generated here. A counting proxy on 127.0.0.1:4802
// sits between folder-sync and the stand-in, so every bucket operation is
// counted by something folder-sync does not control.
//
// Needs the pinned rclone in .tools/ (scripts/dev-tools), python3 and node ≥ 22.18.
// Set FOLDER_SYNC_E2E_ARTIFACTS=<dir> to keep a JSON transcript for the report.
package e2e

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"folder-sync/internal/testtools"
)

const (
	bucket  = "fs-test"
	project = "demo"
)

// The stand-in's and the proxy's addresses: 4801 and 4802 unless FOLDER_SYNC_E2E_STANDIN / FOLDER_SYNC_E2E_PROXY
// name others. WHY overridable: a machine where those ports are taken (or reserved for other work) still runs it.
var (
	standInAddr = addr("FOLDER_SYNC_E2E_STANDIN", "127.0.0.1:4801")
	proxyAddr   = addr("FOLDER_SYNC_E2E_PROXY", "127.0.0.1:4802")
)

var repo = func() string {
	_, here, _, _ := runtime.Caller(0)
	return filepath.Dir(filepath.Dir(here))
}()

// --- the counting proxy -------------------------------------------------------------

type op struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Query  string `json:"query,omitempty"`
	INM    string `json:"if_none_match,omitempty"`
	Copy   string `json:"copy_source,omitempty"`
	Status int    `json:"status"`
}

func (o op) kind() string {
	key := strings.TrimPrefix(strings.TrimPrefix(o.Path, "/"+bucket), "/")
	switch {
	case o.Method == http.MethodGet && key == "":
		return "LIST"
	case o.Method == http.MethodPut && o.Copy != "":
		return "COPY"
	default:
		return o.Method
	}
}

type opLog struct {
	mu  sync.Mutex
	ops []op
}

func (l *opLog) take() []op {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := l.ops
	l.ops = nil
	return out
}

func counts(ops []op) map[string]int {
	c := map[string]int{}
	for _, o := range ops {
		c[o.kind()]++
	}
	return c
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func startProxy(t *testing.T, log *opLog) {
	target, _ := url.Parse("http://" + standInAddr)
	proxy := httputil.NewSingleHostReverseProxy(target) // keeps the client's Host header: SigV4 still verifies
	listener, err := net.Listen("tcp", proxyAddr)
	if err != nil {
		t.Fatalf("%s is busy (%v): stop whatever holds it", proxyAddr, err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		proxy.ServeHTTP(rec, r)
		log.mu.Lock()
		log.ops = append(log.ops, op{Method: r.Method, Path: r.URL.EscapedPath(), Query: r.URL.RawQuery,
			INM: r.Header.Get("If-None-Match"), Copy: r.Header.Get("X-Amz-Copy-Source"), Status: rec.status})
		log.mu.Unlock()
	})}
	go server.Serve(listener)
	t.Cleanup(func() { server.Close() })
}

// --- the stand-in -------------------------------------------------------------------

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func startStandIn(t *testing.T, rcloneBin, dataDir, keyID, secret string) {
	if conn, err := net.DialTimeout("tcp", standInAddr, 200*time.Millisecond); err == nil {
		conn.Close()
		t.Fatalf("%s is busy: stop whatever holds it", standInAddr)
	}
	logFile := filepath.Join(filepath.Dir(dataDir), "stand-in.log")
	cmd := exec.Command(rcloneBin, "serve", "s3", "--addr", standInAddr, "--auth-key", keyID+","+secret,
		"--config", testtools.NoConfig(t), "--cache-dir", filepath.Join(filepath.Dir(dataDir), "stand-in-cache"),
		"-vv", "--log-file", logFile, dataDir)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pid := cmd.Process.Pid
	t.Logf("stand-in: rclone serve s3 on %s, pid %d", standInAddr, pid)
	t.Cleanup(func() {
		testtools.Terminate(cmd.Process)
		done := make(chan struct{})
		go func() { cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			cmd.Process.Kill()
		}
	})
	for i := 0; i < 50; i++ {
		if conn, err := net.DialTimeout("tcp", standInAddr, 100*time.Millisecond); err == nil {
			conn.Close()
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("the stand-in did not start")
}

// --- machines -----------------------------------------------------------------------

type machine struct {
	name   string
	home   string
	folder string
	env    []string
}

type world struct {
	t         *testing.T
	bin       string
	rclone    string
	data      string // the stand-in's directory; the bucket is data/fs-test
	keyID     string
	secret    string
	ops       *opLog
	outputs   []string
	artifacts []map[string]any
}

func (w *world) keyEnv() []string {
	return []string{
		"FOLDER_SYNC_ACCESS_KEY_ID=" + w.keyID,
		"FOLDER_SYNC_SECRET_ACCESS_KEY=" + w.secret,
		"FOLDER_SYNC_ENDPOINT=http://" + proxyAddr,
	}
}

func baseEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		upper := strings.ToUpper(kv)
		if testtools.IsHomeVar(kv) || strings.HasPrefix(upper, "FOLDER_SYNC_") || strings.HasPrefix(upper, "RCLONE_") {
			continue
		}
		env = append(env, kv)
	}
	return env
}

func (w *world) newMachine(name string, withKeyEnv bool) *machine {
	root := w.t.TempDir()
	m := &machine{name: name, home: filepath.Join(root, "home-"+name), folder: filepath.Join(root, name)}
	os.MkdirAll(m.home, 0o700)
	os.MkdirAll(m.folder, 0o755)
	m.env = append(append(baseEnv(), testtools.HomeEnv(m.home)...), "FOLDER_SYNC_RCLONE="+w.rclone)
	if withKeyEnv {
		m.env = append(m.env, w.keyEnv()...)
	}
	return m
}

// run runs folder-sync on m and returns its combined output and exit code.
func (w *world) run(m *machine, args ...string) (string, int) {
	cmd := exec.Command(w.bin, args...)
	cmd.Env = m.env
	cmd.Dir = m.folder
	out, err := cmd.CombinedOutput()
	code := 0
	if exitErr, ok := err.(*exec.ExitError); ok {
		code = exitErr.ExitCode()
	} else if err != nil {
		w.t.Fatal(err)
	}
	text := string(out)
	w.outputs = append(w.outputs, text)
	return text, code
}

// must runs folder-sync and fails the test on a non-zero exit.
func (w *world) must(m *machine, args ...string) string {
	out, code := w.run(m, args...)
	if code != 0 {
		w.t.Fatalf("%s: folder-sync %s exited %d:\n%s", m.name, strings.Join(args, " "), code, out)
	}
	return out
}

// record keeps a step for the report: what ran, its output and the bucket operations it caused.
func (w *world) record(step, machineName, command, output string, ops []op) {
	w.artifacts = append(w.artifacts, map[string]any{
		"step": step, "machine": machineName, "command": command, "output": output, "ops": ops, "op_counts": counts(ops),
	})
}

func (w *world) object(key string) (string, bool) {
	data, err := os.ReadFile(filepath.Join(w.data, bucket, filepath.FromSlash(key)))
	return string(data), err == nil
}

func (w *world) objects(prefix string) []string {
	var keys []string
	root := filepath.Join(w.data, bucket)
	filepath.WalkDir(filepath.Join(root, filepath.FromSlash(prefix)), func(path string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			rel, _ := filepath.Rel(root, path)
			keys = append(keys, filepath.ToSlash(rel))
		}
		return nil
	})
	sort.Strings(keys)
	return keys
}

func writeFile(t *testing.T, path, content string, mtime time.Time) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if !mtime.IsZero() {
		os.Chtimes(path, mtime, mtime)
	}
}

// lockedBuffer collects a running command's output while the test reads it (a bytes.Buffer is not safe for both).
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// waitUntil polls done every 200 ms; past within, it kills cmd and fails with what cmd printed.
func waitUntil(t *testing.T, cmd *exec.Cmd, out *lockedBuffer, within time.Duration, failure string, done func() bool) {
	t.Helper()
	for deadline := time.Now().Add(within); !done(); time.Sleep(200 * time.Millisecond) {
		if time.Now().After(deadline) {
			cmd.Process.Kill()
			t.Fatalf("%s:\n%s", failure, out.String())
		}
	}
}

func hostID(t *testing.T, m *machine) string {
	data, err := os.ReadFile(filepath.Join(m.home, ".folder-sync", "host.json"))
	if err != nil {
		t.Fatal(err)
	}
	var h struct{ ID string }
	json.Unmarshal(data, &h)
	return h.ID
}

func editConfig(t *testing.T, m *machine, from, to string) {
	path := filepath.Join(m.folder, ".folder-sync.toml")
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), from) {
		t.Fatalf("%s config lacks %q", m.name, from)
	}
	os.WriteFile(path, []byte(strings.Replace(string(data), from, to, 1)), 0o644)
}

// mtimeGranularity is how finely this OS's filesystem keeps a modification time.
var mtimeGranularity = func() time.Duration {
	if runtime.GOOS == "windows" {
		return 100 * time.Nanosecond
	}
	return time.Nanosecond
}()

func nodeBinary(t *testing.T) string {
	for _, candidate := range []string{"/usr/bin/node", "node"} {
		path, err := exec.LookPath(candidate)
		if err != nil {
			continue
		}
		out, err := exec.Command(path, "--version").Output()
		var major, minor int
		fmt.Sscanf(strings.TrimSpace(string(out)), "v%d.%d", &major, &minor)
		if err == nil && (major > 22 || (major == 22 && minor >= 18)) {
			return path
		}
	}
	testtools.Missing(t, "node ≥ 22.18 not found")
	return ""
}

// folderIsCaseSensitive probes dir the way a filesystem answers: write "Probe", ask for
// "probe". macOS (APFS) and Windows (NTFS) default to case-insensitive.
func folderIsCaseSensitive(dir string) (bool, error) {
	name := ".case-probe-" + randomHex(4) + "A" // the hex is lower case, so "A" is the only upper-case letter
	upper := filepath.Join(dir, name)
	if err := os.WriteFile(upper, nil, 0o644); err != nil {
		return false, err
	}
	defer os.Remove(upper)
	_, err := os.Stat(filepath.Join(dir, strings.ToLower(name))) // only the name changes case, never the directory
	return err != nil, nil
}

// twinPlan is what the case-twin fixture (README.md and readme.md) should do on a
// folder that does, or does not, tell the two names apart. On a case-insensitive
// folder the second write overwrites the first: there is one file, not a twin.
type twinPlan struct {
	writeTwin   bool
	uploaded    []string // keys relative to the host prefix that join the bucket listing
	forbidden   []string // names that must never be uploaded
	statusWants []string // what `status` must say about them
	skipped     string   // the status line counting skipped names
}

func planTwins(caseSensitive bool) twinPlan {
	if caseSensitive {
		return twinPlan{writeTwin: true, forbidden: []string{"README.md", "readme.md"},
			statusWants: []string{"README.md", "readme.md", "case-only twins"}, skipped: "skipped:         3"}
	}
	return twinPlan{uploaded: []string{"README.md"}, skipped: "skipped:         1"}
}

// missingPythonModule is "" when python can import module, else a skip message that names it.
func missingPythonModule(python, module string) string {
	if err := exec.Command(python, "-c", "import "+module).Run(); err != nil {
		return fmt.Sprintf("python3 module %q is not installed for %s (%v); run `%s -m pip install %s`, see README \"Try it with no cloud account\"",
			module, python, err, python, module)
	}
	return ""
}

// serviceExpectation is where `sync --install-service` writes on goos and what it prints.
func serviceExpectation(goos, home string) (glob, command string) {
	switch goos {
	case "darwin":
		return filepath.Join(home, "Library", "LaunchAgents", "dev.folder-sync.demo-*.plist"), "launchctl bootstrap gui/$(id -u) "
	case "windows":
		return filepath.Join(home, ".folder-sync", "service", "folder-sync-demo-*.xml"), `schtasks /Create /TN "folder-sync\demo-`
	default:
		return filepath.Join(home, ".folder-sync", "service", "folder-sync-demo-*.service"), "systemctl --user enable --now "
	}
}

// --- the test -----------------------------------------------------------------------

func TestTwoMachines(t *testing.T) {
	rcloneBin := testtools.PinnedRclone(t, repo)
	work := t.TempDir()
	bin := filepath.Join(work, testtools.Exe("folder-sync"))
	build := exec.Command("go", "build", "-o", bin, "./cmd/folder-sync")
	build.Dir = repo
	if goroot := runtime.GOROOT(); goroot != "" {
		build.Path = filepath.Join(goroot, "bin", "go")
	}
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}

	w := &world{t: t, bin: bin, rclone: rcloneBin, data: filepath.Join(work, "s3"), keyID: "e2e" + randomHex(8), secret: randomHex(20), ops: &opLog{}}
	os.MkdirAll(filepath.Join(w.data, bucket), 0o755)
	startStandIn(t, rcloneBin, w.data, w.keyID, w.secret)
	startProxy(t, w.ops)
	defer func() {
		if dir := os.Getenv("FOLDER_SYNC_E2E_ARTIFACTS"); dir != "" {
			os.MkdirAll(dir, 0o755)
			data, _ := json.MarshalIndent(w.artifacts, "", "  ")
			os.WriteFile(filepath.Join(dir, "e2e-steps.json"), data, 0o644)
		}
	}()

	// Machine A logs in with v0's key (`login --key`: stored in ~/.folder-sync/credentials.json, env then
	// removed; plain `login` is the account sign-in since PEP 0003); machine B, like a cloud agent, keeps the key
	// in its environment.
	a := w.newMachine("A", true)
	b := w.newMachine("B", true)
	out := w.must(a, "login", "--key")
	if !strings.Contains(out, "Stored key …") || strings.Contains(out, w.secret) {
		t.Fatalf("login output: %s", out)
	}
	a.env = append(append(baseEnv(), testtools.HomeEnv(a.home)...), "FOLDER_SYNC_RCLONE="+w.rclone)

	// A's folder: files to sync, files the default ignores must keep out, names Windows can't hold.
	mtime := time.Date(2026, 10, 1, 10, 20, 30, 123456789, time.UTC)
	files := map[string]string{
		"notes/a.md":        "hello from A\n",
		"data.json":         `{"x":1}` + "\n",
		"deep/er/plan.md":   "# plan\n",
		"space name.txt":    "spaces are fine\n",
		".env":              "SECRET=never-upload\n",
		"node_modules/x.js": "module\n",
		".git/config":       "[core]\n",
		"server.key":        "key\n",
		"cert.pem":          "pem\n",
		"id_ed25519":        "ssh\n",
		"build.tmp":         "custom ignore\n",
		"CON.txt":           "reserved on Windows\n",
		"README.md":         "twin 1\n",
	}
	caseSensitive, err := folderIsCaseSensitive(a.folder)
	if err != nil {
		t.Fatal(err)
	}
	twins := planTwins(caseSensitive)
	if twins.writeTwin {
		files["readme.md"] = "twin 2\n"
	} else {
		t.Log("the folder is case-insensitive: README.md has no twin here, so the twin assertions are skipped")
	}
	for path, content := range files {
		writeFile(t, filepath.Join(a.folder, filepath.FromSlash(path)), content, mtime)
	}

	t.Run("init", func(t *testing.T) {
		out := w.must(a, "init", "--project", project, "--bucket", bucket)
		if !strings.Contains(out, "minted") || !strings.Contains(out, "one HEAD") {
			t.Fatalf("init output: %s", out)
		}
		w.record("A: init", "A", "folder-sync init --project demo --bucket fs-test", out, w.ops.take())
		editConfig(t, a, `ignore = []`, `ignore = ["*.tmp"]`)
		out = w.must(b, "init", "--project", project, "--bucket", bucket)
		w.record("B: init", "B", "folder-sync init --project demo --bucket fs-test", out, w.ops.take())

		bad := w.newMachine("bad-key", false)
		bad.env = append(bad.env, "FOLDER_SYNC_ACCESS_KEY_ID="+w.keyID, "FOLDER_SYNC_SECRET_ACCESS_KEY=wrong-secret", "FOLDER_SYNC_ENDPOINT=http://"+proxyAddr)
		if out, code := w.run(bad, "init", "--project", "bad", "--bucket", bucket); code == 0 || !strings.Contains(out, "key check") {
			t.Fatalf("a wrong key must fail init's HEAD check: %d %s", code, out)
		}
		w.ops.take()
	})

	idA, idB := hostID(t, a), hostID(t, b)
	if idA == idB {
		t.Fatal("two machines share a host id")
	}
	prefixA := project + "/hosts/" + idA + "/"

	t.Run("A pushes; ignored and unportable files never upload", func(t *testing.T) {
		out := w.must(a, "sync", "--once")
		ops := w.ops.take()
		w.record("A: first sync", "A", "folder-sync sync --once", out, ops)
		want := []string{prefixA + "data.json", prefixA + "deep/er/plan.md", prefixA + "manifest.json", prefixA + "notes/a.md", prefixA + "space name.txt"}
		for _, key := range twins.uploaded {
			want = append(want, prefixA+key)
		}
		sort.Strings(want)
		if got := w.objects(prefixA); strings.Join(got, "\n") != strings.Join(want, "\n") {
			t.Fatalf("bucket holds\n  %s\nwant\n  %s", strings.Join(got, "\n  "), strings.Join(want, "\n  "))
		}
		forbidden := append([]string{".env", "node_modules", ".git", "server.key", "cert.pem", "id_ed25519", "build.tmp", "CON.txt"}, twins.forbidden...)
		for _, o := range ops {
			for _, secret := range forbidden {
				if (o.Method == http.MethodPut || o.Method == http.MethodPost) && strings.Contains(o.Path, url.PathEscape(secret)) {
					t.Errorf("%s was uploaded: %s %s", secret, o.Method, o.Path)
				}
			}
		}
		status := w.must(a, "status")
		for _, want := range append([]string{twins.skipped, "CON.txt"}, twins.statusWants...) {
			if !strings.Contains(status, want) {
				t.Errorf("status lacks %q:\n%s", want, status)
			}
		}
		w.record("A: status", "A", "folder-sync status", status, w.ops.take())
	})

	writeFile(t, filepath.Join(b.folder, "b-notes.md"), "written on B\n", time.Time{})

	t.Run("a file pushed by A appears on B, with its mtime", func(t *testing.T) {
		out := w.must(b, "sync", "--once")
		w.record("B: first sync", "B", "folder-sync sync --once", out, w.ops.take())
		copyPath := filepath.Join(b.folder, "hosts", idA, "notes", "a.md")
		data, err := os.ReadFile(copyPath)
		if err != nil || string(data) != "hello from A\n" {
			t.Fatalf("B's copy: %q %v\n%s", data, err, out)
		}
		info, _ := os.Stat(copyPath)
		// WHY a tolerance: NTFS stores times in 100 ns steps, so a nanosecond mtime reads back rounded there
		if got := info.ModTime(); got.Sub(mtime).Abs() >= mtimeGranularity {
			t.Errorf("mtime %s, want %s", info.ModTime().UTC().Format(time.RFC3339Nano), mtime.Format(time.RFC3339Nano))
		}
		if _, err := os.Stat(filepath.Join(b.folder, "hosts", idA, ".env")); err == nil {
			t.Error("an ignored file reached B")
		}
		if _, ok := w.object(project + "/hosts/" + idB + "/b-notes.md"); !ok {
			t.Error("B's own file was not published")
		}
	})

	t.Run("an overwrite and a delete land in _history", func(t *testing.T) {
		writeFile(t, filepath.Join(a.folder, "notes", "a.md"), "changed by A\n", time.Time{})
		os.Remove(filepath.Join(a.folder, "data.json"))
		out := w.must(a, "sync", "--once")
		w.record("A: overwrite + delete", "A", "folder-sync sync --once", out, w.ops.take())
		if strings.Contains(out, "skipped") {
			t.Errorf("a round repeats skipped names the last round already reported:\n%s", out)
		}
		// PEP 0007: the old versions are kept path first, _history/<project>/<host>/<path>/<version>, not in _trash/
		kept := w.objects("_history/" + project + "/" + idA)
		var old, deleted string
		for _, key := range kept {
			content, _ := w.object(key)
			switch {
			case strings.Contains(key, "/notes/a.md/"):
				old = content
			case strings.Contains(key, "/data.json/"):
				deleted = content
			}
		}
		if old != "hello from A\n" || deleted != `{"x":1}`+"\n" {
			t.Fatalf("history holds %q: a.md=%q data.json=%q", kept, old, deleted)
		}
		if trash := w.objects("_trash/" + project + "/" + idA); len(trash) != 0 {
			t.Errorf("a round still writes the legacy _trash/: %q", trash)
		}
		if _, ok := w.object(prefixA + "data.json"); ok {
			t.Error("the deleted object is still live")
		}
		if live, _ := w.object(prefixA + "notes/a.md"); live != "changed by A\n" {
			t.Errorf("live a.md = %q", live)
		}

		out = w.must(b, "sync", "--once")
		w.record("B: pulls the change", "B", "folder-sync sync --once", out, w.ops.take())
		if data, _ := os.ReadFile(filepath.Join(b.folder, "hosts", idA, "notes", "a.md")); string(data) != "changed by A\n" {
			t.Errorf("B has %q", data)
		}
		if _, err := os.Stat(filepath.Join(b.folder, "hosts", idA, "data.json")); err == nil {
			t.Error("B still has the deleted file")
		}
	})

	t.Run("sync --watch picks up a change, and stops cleanly", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("a Go test cannot deliver Ctrl-C to a child on Windows; the stop path is covered by internal/syncer's tests")
		}
		editConfig(t, a, `interval = "10s"`, `interval = "1s"`)
		cmd := exec.Command(w.bin, "sync", "--watch")
		cmd.Env, cmd.Dir = a.env, a.folder
		var buf lockedBuffer
		cmd.Stdout, cmd.Stderr = &buf, &buf
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		// WHY wait for the first round, not a fixed 1.5 s: that round is also A's first pull from B (its reconcile
		// finds B). On a slow machine it listed the folder after the write, uploaded watched.md itself, and the stop
		// below killed its fetch of b-notes.md; a cut pull is redone by the next round, so the no-change round
		// fetched it. Written after the first round, the change is picked up by the watch loop itself (the folder
		// watcher or the timer), on any machine.
		waitUntil(t, cmd, &buf, 30*time.Second, "--watch's first round did not finish within 30 s", func() bool {
			return strings.Contains(buf.String(), "(after a full reconcile)")
		})
		const watched = "seen by --watch\n"
		writeFile(t, filepath.Join(a.folder, "watched.md"), watched, time.Time{})
		sum := sha256.Sum256([]byte(watched))
		// WHY: the manifest is written after the upload. Stopping between the two leaves A one manifest PUT behind,
		// which the next test then counts as a change. The sha256, not the name: a round that lists the folder
		// after the file is created but before its bytes are written publishes an empty watched.md.
		waitUntil(t, cmd, &buf, 15*time.Second, "--watch did not upload within 15 s", func() bool {
			manifest, _ := w.object(prefixA + "manifest.json")
			return strings.Contains(manifest, hex.EncodeToString(sum[:]))
		})
		cmd.Process.Signal(syscall.SIGTERM)
		err := cmd.Wait()
		if err != nil || !strings.Contains(buf.String(), "Stopped.") {
			t.Fatalf("--watch exit: %v\n%s", err, buf.String())
		}
		w.record("A: sync --watch", "A", "folder-sync sync --watch   (Ctrl-C after one change)", buf.String(), w.ops.take())
		// A stop that lands while the manifest is being published must still commit it locally,
		// or the next round publishes it again (seq + 1) and peers' conditional GETs miss.
		states, _ := filepath.Glob(filepath.Join(a.home, ".folder-sync", "projects", project+"-*"))
		if len(states) != 1 {
			t.Fatalf("A's state dirs: %v", states)
		}
		if committed, _ := os.ReadFile(filepath.Join(states[0], "manifest.json")); !strings.Contains(string(committed), "watched.md") {
			t.Errorf("--watch stopped with the published manifest uncommitted:\n%s", committed)
		}
		if _, err := os.Stat(filepath.Join(states[0], "manifest.pending.json")); err == nil {
			t.Error("--watch stopped with manifest.pending.json left behind")
		}
		editConfig(t, a, `interval = "1s"`, `interval = "10s"`)
		w.must(b, "sync", "--once")
		w.ops.take()
	})

	t.Run("a second round with no changes does zero uploads and no listing", func(t *testing.T) {
		for _, m := range []*machine{a, b} {
			w.ops.take()
			out := w.must(m, "sync", "--once")
			ops := w.ops.take()
			w.record(m.name+": no-change round", m.name, "folder-sync sync --once", out, ops)
			c := counts(ops)
			for _, kind := range []string{"PUT", "POST", "DELETE", "COPY", "LIST", "HEAD"} {
				if c[kind] != 0 {
					t.Errorf("%s: %d %s in a no-change round: %+v", m.name, c[kind], kind, ops)
				}
			}
			if len(ops) != 1 {
				t.Errorf("%s: want exactly one request (its peer's manifest), got %+v", m.name, ops)
			}
			for _, o := range ops {
				if o.Method != http.MethodGet || !strings.HasSuffix(o.Path, "/manifest.json") || o.INM == "" || o.Status != http.StatusNotModified {
					t.Errorf("%s: %+v is not a conditional manifest GET answered 304", m.name, o)
				}
			}
		}
	})

	t.Run("an edit to a peer's copy is kept, not lost", func(t *testing.T) {
		writeFile(t, filepath.Join(b.folder, "hosts", idA, "notes", "a.md"), "B edited A's copy\n", time.Time{})
		writeFile(t, filepath.Join(a.folder, "notes", "a.md"), "A's third version\n", time.Time{})
		w.must(a, "sync", "--once")
		out := w.must(b, "sync", "--once")
		w.record("B: local edit to a peer copy", "B", "folder-sync sync --once", out, w.ops.take())
		if data, _ := os.ReadFile(filepath.Join(b.folder, "hosts", idA, "notes", "a.md")); string(data) != "A's third version\n" {
			t.Errorf("B's copy = %q", data)
		}
		kept, _ := filepath.Glob(filepath.Join(b.home, ".folder-sync", "conflicts", project, idA, "*", "notes", "a.md"))
		if len(kept) != 1 {
			t.Fatalf("B's edit was not kept: %v\n%s", kept, out)
		}
		if data, _ := os.ReadFile(kept[0]); string(data) != "B edited A's copy\n" {
			t.Errorf("kept %q", data)
		}
		if status := w.must(b, "status"); !strings.Contains(status, "conflicts:       1") {
			t.Errorf("status:\n%s", status)
		}
	})

	t.Run("max_delete holds a mass delete", func(t *testing.T) {
		editConfig(t, a, "max_delete = 50", "max_delete = 2")
		for i := 0; i < 3; i++ {
			writeFile(t, filepath.Join(a.folder, "bulk", fmt.Sprintf("%d.md", i)), "bulk\n", time.Time{})
		}
		w.must(a, "sync", "--once")
		os.RemoveAll(filepath.Join(a.folder, "bulk"))
		out := w.must(a, "sync", "--once")
		w.record("A: mass delete held", "A", "folder-sync sync --once", out, w.ops.take())
		if !strings.Contains(out, "3 deletes held") {
			t.Fatalf("output: %s", out)
		}
		if _, ok := w.object(prefixA + "bulk/0.md"); !ok {
			t.Fatal("a held delete removed the object")
		}
		editConfig(t, a, "max_delete = 2", "max_delete = 50")
		out = w.must(a, "sync", "--once")
		if !strings.Contains(out, "3 deleted") {
			t.Fatalf("after raising max_delete: %s", out)
		}
		w.ops.take()
	})

	t.Run("an empty folder never wipes the bucket", func(t *testing.T) {
		guard := &machine{name: "A-guard", home: a.home, folder: filepath.Join(t.TempDir(), "guard"), env: a.env}
		os.MkdirAll(guard.folder, 0o755)
		// a peer of the same folder (as the web host is one): it publishes first, so the guard's first round knows it
		peer := &machine{name: "B-guard", home: b.home, folder: filepath.Join(t.TempDir(), "guard-peer"), env: b.env}
		os.MkdirAll(peer.folder, 0o755)
		writeFile(t, filepath.Join(peer.folder, "peer.md"), "peer\n", time.Time{})
		w.must(peer, "init", "--project", "guard", "--bucket", bucket)
		w.must(peer, "sync", "--once")
		writeFile(t, filepath.Join(guard.folder, "only.md"), "only\n", time.Time{})
		w.must(guard, "init", "--project", "guard", "--bucket", bucket)
		w.must(guard, "sync", "--once")
		os.Remove(filepath.Join(guard.folder, "only.md"))
		// review r1 #6: while the guard's folder is empty, an edit elsewhere must still reach it
		writeFile(t, filepath.Join(peer.folder, "edited-elsewhere.md"), "while you were empty\n", time.Time{})
		w.must(peer, "sync", "--once")
		out, code := w.run(guard, "sync", "--once")
		if code == 0 || !strings.Contains(out, "looks empty or unmounted") {
			t.Fatalf("exit %d: %s", code, out)
		}
		if _, ok := w.object("guard/hosts/" + idA + "/only.md"); !ok {
			t.Fatal("the object was deleted")
		}
		pulled := filepath.Join(guard.folder, "hosts", hostID(t, peer), "edited-elsewhere.md")
		if data, err := os.ReadFile(pulled); err != nil || string(data) != "while you were empty\n" {
			t.Fatalf("the refused push also stopped the pull: %s: %q %v", pulled, data, err)
		}
		status := w.must(guard, "status")
		if !strings.Contains(status, "FAILED") || !strings.Contains(status, "looks empty or unmounted") {
			t.Fatalf("status must show the refusal: %s", status)
		}
		w.ops.take()
	})

	t.Run("v1's shared folders are refused, clearly", func(t *testing.T) {
		editConfig(t, b, "[modes]\n", "[modes]\n\"shared\" = \"shared\"\n")
		out, code := w.run(b, "sync", "--once")
		w.record("B: shared mode refused", "B", "folder-sync sync --once   (with [modes] \"shared\" = \"shared\")", out, w.ops.take())
		if code != 3 || !strings.Contains(out, "not available in v0") {
			t.Fatalf("exit %d: %s", code, out)
		}
		editConfig(t, b, "[modes]\n\"shared\" = \"shared\"\n", "[modes]\n")
	})

	t.Run("install-service writes the unit and only prints the enable command", func(t *testing.T) {
		out := w.must(a, "sync", "--install-service")
		w.record("A: install-service", "A", "folder-sync sync --install-service", out, w.ops.take())
		glob, command := serviceExpectation(runtime.GOOS, a.home)
		units, _ := filepath.Glob(glob)
		if runtime.GOOS == "windows" {
			// the task XML is UTF-16, and the schtasks line names the task, then the XML path
			if len(units) != 1 || !strings.Contains(out, command) || !strings.Contains(out, `/XML "`+units[0]+`"`) {
				t.Fatalf("%s -> %v\n%s", glob, units, out)
			}
			unit, _ := os.ReadFile(units[0])
			if !bytes.Contains(unit, utf16LE(`sync --watch --dir`)) {
				t.Fatalf("task XML lacks the watch command (%d bytes)", len(unit))
			}
			return
		}
		if len(units) != 1 || !strings.Contains(out, command+units[0]) {
			t.Fatalf("%s -> %v\n%s", glob, units, out)
		}
		unit, _ := os.ReadFile(units[0])
		if !strings.Contains(string(unit), "sync --watch --dir") && !strings.Contains(string(unit), "<string>--watch</string>") {
			t.Fatalf("unit:\n%s", unit)
		}
	})

	t.Run("publish brings the manifest up to date; --viewer writes config, never deploys", func(t *testing.T) {
		out := w.must(a, "publish")
		w.record("A: publish", "A", "folder-sync publish", out, w.ops.take())
		out, code := w.run(a, "publish", "--viewer")
		if code == 0 || !strings.Contains(out, "access_team") {
			t.Fatalf("publish --viewer without Access settings must refuse: %d %s", code, out)
		}
		editConfig(t, a, `access_team = ""`, `access_team = "bam"`)
		editConfig(t, a, `domain = ""`, `domain = "files.example.com"`)
		out = w.must(a, "publish", "--viewer")
		w.record("A: publish --viewer", "A", "folder-sync publish --viewer", out, w.ops.take())
		wrangler, err := os.ReadFile(filepath.Join(a.home, ".folder-sync", "viewer", bucket, "wrangler.toml"))
		if err != nil || !strings.Contains(string(wrangler), "workers_dev = false") || !strings.Contains(out, "npm --prefix") {
			t.Fatalf("%v\n%s\n%s", err, wrangler, out)
		}
	})

	// B's view: B's own files plus its read-only copies of A's.
	w.must(b, "sync", "--once")
	w.ops.take()
	bView := map[string]string{}
	filepath.WalkDir(b.folder, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(b.folder, path)
		rel = filepath.ToSlash(rel)
		data, _ := os.ReadFile(path)
		switch {
		case rel == ".folder-sync.toml":
		case strings.HasPrefix(rel, "hosts/"):
			bView[strings.TrimPrefix(rel, "hosts/")] = string(data)
		default:
			bView[idB+"/"+rel] = string(data)
		}
		return nil
	})

	t.Run("manifests validate against schema/manifest.schema.json", func(t *testing.T) {
		manifests, _ := filepath.Glob(filepath.Join(w.data, bucket, "*", "hosts", "*", "manifest.json"))
		if len(manifests) != 4 {
			t.Fatalf("want 4 manifests (A, B, guard, guard's peer B), got %v", manifests)
		}
		if reason := missingPythonModule(testtools.PythonBinary(), "jsonschema"); reason != "" {
			testtools.Missing(t, "%s", reason)
		}
		script := `import json, sys, jsonschema
schema = json.load(open(sys.argv[1]))
for path in sys.argv[2:]:
    jsonschema.validate(json.load(open(path)), schema, format_checker=jsonschema.FormatChecker())
print("valid:", len(sys.argv) - 2)`
		args := append([]string{"-c", script, filepath.Join(repo, "schema", "manifest.schema.json")}, manifests...)
		out, err := exec.Command(testtools.PythonBinary(), args...).CombinedOutput()
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		w.record("schema check", "-", "python3 jsonschema.validate(manifest, schema/manifest.schema.json)", string(out), nil)
	})

	readerEnv := append(baseEnv(), w.keyEnv()...)

	t.Run("the Python reader lists and reads B's view", func(t *testing.T) {
		cmd := exec.Command(testtools.PythonBinary(), filepath.Join(repo, "readers", "python", "folder_sync_read.py"), "--bucket", bucket, "--project", project, "list")
		cmd.Env = readerEnv
		out, err := cmd.Output()
		if err != nil {
			t.Fatal(err)
		}
		got := map[string]string{}
		for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			var ref struct{ HostID, Path string }
			var raw map[string]any
			json.Unmarshal([]byte(line), &raw)
			ref.HostID, ref.Path = raw["host_id"].(string), raw["path"].(string)
			cat := exec.Command(testtools.PythonBinary(), filepath.Join(repo, "readers", "python", "folder_sync_read.py"), "--bucket", bucket, "--project", project, "cat", ref.HostID, ref.Path)
			cat.Env = readerEnv
			data, err := cat.Output()
			if err != nil {
				t.Fatal(err)
			}
			got[ref.HostID+"/"+ref.Path] = string(data)
		}
		assertSameView(t, got, bView)
		w.record("Python reader", "-", "python3 readers/python/folder_sync_read.py --bucket fs-test --project demo list", string(out), w.ops.take())
	})

	t.Run("the Worker reader lists and reads B's view", func(t *testing.T) {
		node := nodeBinary(t)
		cmd := exec.Command(node, filepath.Join(repo, "readers", "worker", "test", "e2e.ts"), bucket, project)
		cmd.Env = readerEnv
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("%v %s", err, out)
		}
		var result struct {
			Contents           map[string]string `json:"contents"`
			SecondListingCalls []string          `json:"secondListingCalls"`
		}
		if err := json.Unmarshal(out, &result); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
		assertSameView(t, result.Contents, bView)
		for _, call := range result.SecondListingCalls {
			if !strings.HasSuffix(call, "(conditional)") {
				t.Errorf("second listing made a non-conditional call: %s", call)
			}
		}
		w.record("Worker reader", "-", "node readers/worker/test/e2e.ts fs-test demo", string(out), w.ops.take())
	})

	t.Run("nothing is written in the home directory outside ~/.folder-sync", func(t *testing.T) {
		// WHY: the README promises everything lives in ~/.folder-sync/; rclone alone would
		// have made ~/.config/rclone. install-service on a Mac adds ~/Library/LaunchAgents.
		allowed := map[string]bool{".folder-sync": true}
		if runtime.GOOS == "darwin" {
			allowed["Library"] = true
		}
		for _, m := range []*machine{a, b} {
			w.must(m, "version")
			entries, err := os.ReadDir(m.home)
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range entries {
				if !allowed[entry.Name()] {
					t.Errorf("%s: %s appeared in the home directory", m.name, filepath.Join(m.home, entry.Name()))
				}
			}
		}
	})

	t.Run("no secret is ever written outside credentials.json or printed", func(t *testing.T) {
		for _, m := range []*machine{a, b} {
			filepath.WalkDir(m.home, func(path string, d fs.DirEntry, err error) error {
				if err != nil || d.IsDir() || filepath.Base(path) == "credentials.json" {
					return nil
				}
				if data, _ := os.ReadFile(path); bytes.Contains(data, []byte(w.secret)) {
					t.Errorf("the secret is in %s", path)
				}
				return nil
			})
		}
		for _, out := range w.outputs {
			if strings.Contains(out, w.secret) {
				t.Errorf("the secret was printed: %s", out)
			}
		}
		// WHY not on Windows: it has no Unix mode bits; the file sits under the user's profile, which only they can read
		info, err := os.Stat(filepath.Join(a.home, ".folder-sync", "credentials.json"))
		if err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o600) {
			t.Errorf("credentials.json: %v %v", info, err)
		}
	})
}

func assertSameView(t *testing.T, got, want map[string]string) {
	t.Helper()
	if len(got) != len(want) {
		t.Errorf("reader sees %d files, B has %d", len(got), len(want))
	}
	for key, content := range want {
		if got[key] != content {
			t.Errorf("%s: reader %q, B %q", key, got[key], content)
		}
	}
	for key := range got {
		if _, ok := want[key]; !ok {
			t.Errorf("reader sees %s, which B does not have", key)
		}
	}
}
