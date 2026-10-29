package serve

// `folder-sync serve` end to end, on the stand-in (rclone serve s3) with the real binary: serve a synced folder,
// edit a file and sync, see the old version in its history (its bytes, and the current ones), restore it from the
// API, and the next sync round puts it back on disk and publishes it; delete a file and it is in deleted. Stopping
// serve removes serve.json. Skipped without .tools/rclone (scripts/dev-tools) or with -short.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"folder-sync/internal/history"
	"folder-sync/internal/manifest"
	"folder-sync/internal/testtools"
)

var repo = func() string {
	_, here, _, _ := runtime.Caller(0)
	return filepath.Dir(filepath.Dir(filepath.Dir(here)))
}()

type e2e struct {
	t      *testing.T
	bin    string
	env    []string
	home   string
	folder string
	data   string // the stand-in's directory; the bucket is data/<e2eBucket>
	base   string
	token  string
}

const e2eBucket = "fs-serve"

func freePort(t *testing.T) int {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

// background starts a process, logged to logPath, and stops it (SIGTERM, then a kill) when the test ends.
func background(t *testing.T, logPath string, env []string, dir string, argv ...string) *exec.Cmd {
	t.Helper()
	log, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env, cmd.Dir, cmd.Stdout, cmd.Stderr = env, dir, log, log
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { cmd.Wait(); log.Close(); close(done) }()
	t.Cleanup(func() {
		testtools.Terminate(cmd.Process)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			cmd.Process.Kill()
			<-done
		}
	})
	return cmd
}

func newE2E(t *testing.T) *e2e {
	if testing.Short() {
		t.Skip("-short: no stand-in")
	}
	rcloneBin := testtools.PinnedRclone(t, repo)
	work := t.TempDir()
	e := &e2e{t: t, bin: filepath.Join(work, testtools.Exe("folder-sync")), home: filepath.Join(work, "home"), folder: filepath.Join(work, "notes"), data: filepath.Join(work, "s3")}
	build := exec.Command("go", "build", "-o", e.bin, "./cmd/folder-sync")
	build.Dir = repo
	if goroot := runtime.GOROOT(); goroot != "" {
		build.Path = filepath.Join(goroot, "bin", "go")
	}
	if text, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, text)
	}
	for _, dir := range []string{e.home, e.folder, filepath.Join(e.data, e2eBucket)} {
		os.MkdirAll(dir, 0o755)
	}
	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	key, secret := "serve"+fmt.Sprint(time.Now().UnixNano()%1e6), "secret-for-the-stand-in-only"
	background(t, filepath.Join(work, "stand-in.log"), os.Environ(), work, rcloneBin, "serve", "s3", "--addr", addr, "--auth-key", key+","+secret,
		"--config", os.DevNull, "--cache-dir", filepath.Join(work, "stand-in-cache"), e.data)
	for i := 0; ; i++ {
		if conn, err := net.DialTimeout("tcp", addr, 100*time.Millisecond); err == nil {
			conn.Close()
			break
		}
		if i == 50 {
			t.Fatal("the stand-in did not start")
		}
		time.Sleep(100 * time.Millisecond)
	}
	for _, kv := range os.Environ() {
		if upper := strings.ToUpper(kv); !testtools.IsHomeVar(kv) && !strings.HasPrefix(upper, "FOLDER_SYNC_") && !strings.HasPrefix(upper, "RCLONE_") {
			e.env = append(e.env, kv)
		}
	}
	e.env = append(append(e.env, testtools.HomeEnv(e.home)...), "FOLDER_SYNC_RCLONE="+rcloneBin, "FOLDER_SYNC_ACCESS_KEY_ID="+key,
		"FOLDER_SYNC_SECRET_ACCESS_KEY="+secret, "FOLDER_SYNC_ENDPOINT=http://"+addr)
	return e
}

func (e *e2e) must(args ...string) string {
	e.t.Helper()
	cmd := exec.Command(e.bin, args...)
	// WHY PWD: a shell sets it, and Go's os.Getwd (so filepath.Abs(".")) then answers the folder as the person reached it. Without it
	// the kernel answers the real path, and on macOS t.TempDir() (/var/folders/…) comes back as /private/var/folders/…. The engine
	// keeps the folder as configured, never canonicalised: someone whose folder is a symlink (~/Dropbox -> …) expects to see their
	// own path, and the project's state key is made from it.
	cmd.Env, cmd.Dir = append(append([]string{}, e.env...), "PWD="+e.folder), e.folder
	out, err := cmd.CombinedOutput()
	if err != nil {
		e.t.Fatalf("folder-sync %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return string(out)
}

// serve starts `folder-sync serve` and reads its address and token from serve.json, as an app on the machine does.
func (e *e2e) serve() *exec.Cmd {
	e.t.Helper()
	cmd := background(e.t, filepath.Join(filepath.Dir(e.bin), "serve.log"), e.env, e.home, e.bin, "serve")
	path := filepath.Join(e.home, ".folder-sync", "serve.json")
	for i := 0; ; i++ {
		var info Info
		if data, err := os.ReadFile(path); err == nil && json.Unmarshal(data, &info) == nil && info.PID == cmd.Process.Pid {
			e.base, e.token = strings.TrimRight(info.URL, "/"), info.Token
			return cmd
		}
		if i == 100 {
			log, _ := os.ReadFile(filepath.Join(filepath.Dir(e.bin), "serve.log"))
			e.t.Fatalf("serve.json never appeared:\n%s", log)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (e *e2e) api(method, path string, body any, out any) int {
	e.t.Helper()
	var reader io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		reader = bytes.NewReader(data)
	}
	req, _ := http.NewRequest(method, e.base+path, reader)
	req.Header.Set("Authorization", "Bearer "+e.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if out != nil {
		if b, ok := out.(*[]byte); ok {
			*b = data
		} else if err := json.Unmarshal(data, out); err != nil {
			e.t.Fatalf("%s %s: %d %s", method, path, resp.StatusCode, data)
		}
	}
	return resp.StatusCode
}

func TestServeEndToEndOnTheStandIn(t *testing.T) {
	e := newE2E(t)
	e.must("init", "--project", "notes", "--bucket", e2eBucket)
	plan := filepath.Join(e.folder, "notes", "plan.md")
	os.MkdirAll(filepath.Dir(plan), 0o755)
	v1 := "# Plan\n\n- order the clamp\n- print the bracket v2\n"
	v2 := "# Plan\n\n- order the clamp\n- print the bracket v3\n- test the wrist camera at 30 fps\n"
	os.WriteFile(plan, []byte(v1), 0o644)
	os.WriteFile(filepath.Join(e.folder, "old-ideas.md"), []byte("# Old ideas\n"), 0o644)
	e.must("sync", "--once")
	serving := e.serve()
	var hostFile struct {
		ID string `json:"id"`
	}
	readJSON(t, filepath.Join(e.home, ".folder-sync", "host.json"), &hostFile)
	me := hostFile.ID

	var folders struct {
		Folders []folderEntry `json:"folders"`
	}
	if status := e.api(http.MethodGet, "/fs/v1/folders", nil, &folders); status != http.StatusOK || len(folders.Folders) != 1 || folders.Folders[0].Folder != e.folder {
		t.Fatalf("folders: %d %+v", status, folders)
	}

	// an edit: the old version is kept, and history lists it
	os.WriteFile(plan, []byte(v2), 0o644)
	os.Remove(filepath.Join(e.folder, "old-ideas.md"))
	e.must("sync", "--once")
	var h historyBody
	if status := e.api(http.MethodGet, "/fs/v1/folders/notes/history/"+me+"/notes/plan.md", nil, &h); status != http.StatusOK {
		t.Fatalf("history: %d", status)
	}
	if h.Live == nil || h.Live.SHA256 != sha(v2) || len(h.Versions) != 1 || h.Versions[0].SHA16 != sha(v1)[:16] || h.HostName == "" {
		t.Fatalf("history after the edit: %+v", h)
	}
	kept := h.Versions[0].ID
	var old []byte
	if status := e.api(http.MethodGet, "/fs/v1/folders/notes/history/"+me+"/notes/plan.md?version="+kept, nil, &old); status != http.StatusOK || string(old) != v1 {
		t.Fatalf("the old bytes: %d %q", status, old)
	}
	// and the current ones, Version history's "Current"
	var current []byte
	if status := e.api(http.MethodGet, "/fs/v1/folders/notes/files/"+me+"/notes/plan.md", nil, &current); status != http.StatusOK || string(current) != v2 {
		t.Fatalf("the current bytes: %d %q", status, current)
	}
	var activity struct {
		Events []map[string]any `json:"events"`
	}
	e.api(http.MethodGet, "/fs/v1/folders/notes/activity", nil, &activity)
	edited := false
	for _, ev := range activity.Events {
		if was, ok := ev["was"].(map[string]any); ok && ev["event"] == "upload" && ev["path"] == "notes/plan.md" && was["kept"] == kept {
			edited = true
		}
	}
	if !edited {
		t.Errorf("activity has no edit of notes/plan.md keeping %s: %v", kept, activity.Events)
	}
	var deleted deletedBody
	if e.api(http.MethodGet, "/fs/v1/folders/notes/deleted", nil, &deleted); len(deleted.Files) != 1 || deleted.Files[0].Path != "old-ideas.md" {
		t.Errorf("deleted: %+v", deleted)
	}

	// restore from the API: a local request, which the next round applies and publishes
	var restored restoreBody
	if status := e.api(http.MethodPost, "/fs/v1/folders/notes/restore", map[string]any{"items": []restoreItem{{Host: me, Path: "notes/plan.md", Version: kept}}}, &restored); status != http.StatusOK ||
		len(restored.Requested) != 1 || restored.Requested[0].Where != "local" {
		t.Fatalf("restore: %d %+v", status, restored)
	}
	var status statusBody
	e.api(http.MethodGet, "/fs/v1/folders/notes/status", nil, &status)
	if len(status.Waiting) != 1 || status.Waiting[0].Request != restored.Requested[0].Request || status.State != "attention" {
		t.Errorf("status while the restore waits: %s %+v", status.State, status.Waiting)
	}
	if got, _ := os.ReadFile(plan); string(got) != v2 {
		t.Fatalf("serve wrote the file itself: %q", got)
	}
	e.must("sync", "--once")
	if got, _ := os.ReadFile(plan); string(got) != v1 {
		t.Fatalf("after the round: %q, want the restored version", got)
	}
	published, err := os.ReadFile(filepath.Join(e.data, e2eBucket, "notes", "hosts", me, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	m, _ := manifest.Parse(published)
	if m.Index()["notes/plan.md"].SHA256 != sha(v1) {
		t.Errorf("the published manifest has %s, want the restored version's sha", m.Index()["notes/plan.md"].SHA256)
	}
	e.api(http.MethodGet, "/fs/v1/folders/notes/history/"+me+"/notes/plan.md", nil, &h)
	if len(h.Versions) != 2 || h.Versions[0].SHA16 != sha(v2)[:16] {
		t.Errorf("the version the restore replaced is kept first: %+v", h.Versions)
	}
	e.api(http.MethodGet, "/fs/v1/folders/notes/status", nil, &status)
	if len(status.Waiting) != 0 {
		t.Errorf("still waiting after the round: %+v", status.Waiting)
	}
	e.api(http.MethodGet, "/fs/v1/folders/notes/activity", nil, &activity)
	if !hasRestore(activity.Events, kept) {
		t.Errorf("no restore event from %s in activity: %v", kept, activity.Events)
	}
	if !history.ValidVersionID(kept) {
		t.Errorf("kept %q is not a version id", kept)
	}

	if runtime.GOOS == "windows" {
		return // no SIGTERM to send: a kill leaves serve.json for the next serve to find stale
	}
	serving.Process.Signal(syscall.SIGTERM)
	for i := 0; i < 100; i++ {
		if _, err := os.Stat(filepath.Join(e.home, ".folder-sync", "serve.json")); os.IsNotExist(err) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Errorf("serve.json is still there after serve stopped")
}

func hasRestore(events []map[string]any, from string) bool {
	for _, ev := range events {
		if ev["event"] == "restore" && ev["from"] == from && ev["error"] == nil {
			return true
		}
	}
	return false
}
