//go:build !windows

package e2e

// The real accounts Worker, on this machine, for the tests that need the server part: `node accounts/scripts/dev.mjs up`
// starts `rclone serve s3`, folder-sync's R2 stand-in in front of it and `wrangler dev` (Better Auth on a local D1, the
// folder's Durable Objects), each on a free port; the machines are the real folder-sync binary, each with its own HOME,
// signed in by the device grant that a browser session approves, exactly as a person does it (accounts/test/proof.mjs is the
// same journey in Node).
//
// WHY these tests start the Worker and the rest of the e2e suite does not: a shared folder needs the accounts server (PEP
// 0010 §13.2), and its writer is the folder's Durable Object, which only the Worker's own code can be; a Go stand-in would
// test the stand-in. The core still works with no server (scripts/check-core-alone): without accounts/ these tests skip.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"folder-sync/internal/testtools"
)

// stack is a running dev stack.
type stack struct {
	t      *testing.T
	site   string // the accounts Worker, http://127.0.0.1:<port>
	state  string // the dev stack's state dir
	data   string // the stand-in's bucket directory: <state>/s3/folder-sync
	bin    string // the folder-sync binary built from this checkout
	rclone string
	// pair is each person's two machines, made once (shared_test.go newFolder)
	pair map[*browser][2]*node
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// buildBinary builds the folder-sync of the checkout at dir into out.
func buildBinary(t *testing.T, dir, out string) {
	t.Helper()
	build := exec.Command("go", "build", "-o", out, "./cmd/folder-sync")
	build.Dir = dir
	if goroot := runtime.GOROOT(); goroot != "" {
		build.Path = filepath.Join(goroot, "bin", "go")
	}
	if msg, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build in %s: %v\n%s", dir, err, msg)
	}
}

// startStack starts the dev stack, or skips when the server part is not in this tree (the core-alone copy) or its tools
// are missing and nothing requires them.
func startStack(t *testing.T) *stack {
	t.Helper()
	dev := filepath.Join(repo, "accounts", "scripts", "dev.mjs")
	if _, err := os.Stat(dev); err != nil {
		t.Skip("the server part (accounts/) is not in this tree: the shared tree needs the accounts server")
	}
	if _, err := os.Stat(filepath.Join(repo, "accounts", "node_modules", "wrangler")); err != nil {
		testtools.Missing(t, "accounts/node_modules is missing: npm ci --prefix accounts")
	}
	nodeBin := nodeBinary(t)
	rcloneBin := testtools.PinnedRclone(t, repo)
	s := &stack{t: t, state: filepath.Join(t.TempDir(), "stack"), rclone: rcloneBin, pair: map[*browser][2]*node{}}
	work := t.TempDir()
	s.bin = filepath.Join(work, testtools.Exe("folder-sync"))
	buildBinary(t, repo, s.bin)
	env := append(os.Environ(),
		fmt.Sprintf("FS_STANDIN_PORT=%d", freePort(t)), fmt.Sprintf("FS_STORE_PORT=%d", freePort(t)),
		fmt.Sprintf("FS_ACCOUNTS_PORT=%d", freePort(t)), fmt.Sprintf("FS_INSPECTOR_PORT=%d", freePort(t)),
		"RCLONE="+rcloneBin, "GO="+filepath.Join(runtime.GOROOT(), "bin", "go"))
	up := exec.Command(nodeBin, dev, "up", "--state-dir", s.state)
	up.Env = env
	out, err := up.Output()
	if err != nil {
		stderr := ""
		if exit, ok := err.(*exec.ExitError); ok {
			stderr = string(exit.Stderr)
		}
		t.Fatalf("the dev stack did not start: %v\n%s", err, stderr)
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	var summary struct {
		Accounts string `json:"accounts"`
		StateDir string `json:"stateDir"`
	}
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &summary); err != nil {
		t.Fatalf("dev.mjs up printed %q", out)
	}
	s.site = summary.Accounts
	s.data = filepath.Join(s.state, "s3", "folder-sync")
	t.Cleanup(func() {
		// the Worker's and the gate's logs, for the report of a failure (FOLDER_SYNC_E2E_ARTIFACTS=<dir>)
		if dir := os.Getenv("FOLDER_SYNC_E2E_ARTIFACTS"); dir != "" {
			os.MkdirAll(dir, 0o755)
			for _, name := range []string{"accounts.log", "gate.jsonl", "gate.log"} {
				if data, err := os.ReadFile(filepath.Join(s.state, name)); err == nil {
					os.WriteFile(filepath.Join(dir, "stack-"+name), data, 0o644)
				}
			}
		}
		if dir := os.Getenv("FOLDER_SYNC_E2E_ARTIFACTS"); dir != "" && t.Failed() {
			exec.Command("cp", "-r", filepath.Join(s.state, "s3"), filepath.Join(dir, "stack-s3")).Run()
		}
		// only the processes this `up` recorded, by pid (the dev script's own `down`)
		down := exec.Command(nodeBin, dev, "down", "--state-dir", s.state)
		down.Env = env
		down.Run()
	})
	return s
}

// browser is a person's browser: a cookie jar for the Worker's origin, and the page's own headers on a write.
type browser struct {
	s      *stack
	client *http.Client
	userID string
	email  string
}

func (s *stack) browser(email string) *browser {
	jar, _ := cookiejar.New(nil)
	b := &browser{s: s, email: email, client: &http.Client{Jar: jar, Timeout: time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	return b
}

func (b *browser) do(method, path string, body []byte, headers map[string]string) (int, []byte) {
	b.s.t.Helper()
	req, err := http.NewRequest(method, b.s.site+path, bytes.NewReader(body))
	if err != nil {
		b.s.t.Fatal(err)
	}
	if method != http.MethodGet && method != http.MethodHead {
		req.Header.Set("Origin", b.s.site)
		req.Header.Set("X-Folder-Sync", "1")
		if b.userID != "" {
			req.Header.Set("X-Folder-Sync-User", b.userID)
		}
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := b.client.Do(req)
	if err != nil {
		b.s.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	return res.StatusCode, data
}

func (b *browser) json(method, path string, body any) (int, []byte) {
	var data []byte
	headers := map[string]string{}
	if body != nil {
		data, _ = json.Marshal(body)
		headers["Content-Type"] = "application/json"
	}
	return b.do(method, path, data, headers)
}

// signIn signs the browser in by email code (the dev Worker has no Google).
func (b *browser) signIn() {
	t := b.s.t
	t.Helper()
	if status, data := b.json("POST", "/fs/api/auth/email-otp/send-verification-otp", map[string]string{"email": b.email, "type": "sign-in"}); status != 200 {
		t.Fatalf("send code: %d %s", status, data)
	}
	status, data := b.json("GET", "/fs/dev/mailbox?email="+url.QueryEscape(b.email), nil)
	var mailbox struct{ Code string }
	if status != 200 || json.Unmarshal(data, &mailbox) != nil || mailbox.Code == "" {
		t.Fatalf("mailbox: %d %s", status, data)
	}
	if status, data := b.json("POST", "/fs/api/auth/sign-in/email-otp", map[string]string{"email": b.email, "otp": mailbox.Code}); status != 200 {
		t.Fatalf("sign in: %d %s", status, data)
	}
	status, data = b.json("GET", "/fs/v1/me", nil)
	var me struct{ User struct{ ID string } }
	if status != 200 || json.Unmarshal(data, &me) != nil || me.User.ID == "" {
		t.Fatalf("me: %d %s", status, data)
	}
	b.userID = me.User.ID
}

// node is one machine: its own HOME and folder, the real binary.
type node struct {
	s      *stack
	name   string
	home   string
	folder string
	env    []string
	bin    string
}

// machine makes a machine and signs it in as b's person (the device grant, approved by b).
func (s *stack) machine(name string, b *browser) *node {
	t := s.t
	t.Helper()
	root := t.TempDir()
	n := &node{s: s, name: name, home: filepath.Join(root, "home-"+name), folder: filepath.Join(root, name), bin: s.bin}
	os.MkdirAll(n.home, 0o700)
	os.MkdirAll(n.folder, 0o755)
	n.env = append(append(baseEnv(), testtools.HomeEnv(n.home)...), "FOLDER_SYNC_RCLONE="+s.rclone, "FOLDER_SYNC_SERVER="+s.site)
	// folder-sync login: print a code, then wait for the browser to approve it
	cmd := exec.Command(s.bin, "login")
	cmd.Env, cmd.Dir = n.env, n.home
	var out lockedBuffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	pattern := regexp.MustCompile(`open (\S+) and approve the code (\S+)`)
	var code string
	for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
		if m := pattern.FindStringSubmatch(out.String()); m != nil {
			code = strings.ToUpper(regexp.MustCompile(`[^A-Za-z0-9]`).ReplaceAllString(m[2], ""))
			break
		}
	}
	if code == "" {
		cmd.Process.Kill()
		t.Fatalf("%s: login printed no code:\n%s", name, out.String())
	}
	b.json("GET", "/fs/api/auth/device?user_code="+code, nil)
	if status, data := b.json("POST", "/fs/api/auth/device/approve", map[string]string{"userCode": code}); status != 200 {
		cmd.Process.Kill()
		t.Fatalf("%s: approve: %d %s", name, status, data)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("%s: login: %v\n%s", name, err, out.String())
		}
	case <-time.After(60 * time.Second):
		cmd.Process.Kill()
		t.Fatalf("%s: login did not finish:\n%s", name, out.String())
	}
	return n
}

// run runs folder-sync on the machine; the output and exit code.
func (n *node) run(args ...string) (string, int) {
	return n.runKilled(0, args...)
}

// runKilled kills the whole process group (folder-sync and its rclone) killAfter after the start, as a power cut does.
func (n *node) runKilled(killAfter time.Duration, args ...string) (string, int) {
	n.s.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, n.bin, args...)
	cmd.Env, cmd.Dir = n.env, n.folder
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var out lockedBuffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Start(); err != nil {
		n.s.t.Fatal(err)
	}
	if killAfter > 0 {
		timer := time.AfterFunc(killAfter, func() { syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) })
		defer timer.Stop()
	}
	err := cmd.Wait()
	syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) // an rclone that outlived a killed parent, by the group id we made
	code := 0
	if exit, ok := err.(*exec.ExitError); ok {
		code = exit.ExitCode()
	} else if err != nil {
		n.s.t.Fatal(err)
	}
	return out.String(), code
}

func (n *node) must(args ...string) string {
	n.s.t.Helper()
	out, code := n.run(args...)
	if code != 0 {
		n.s.t.Fatalf("%s: folder-sync %s exited %d:\n%s", n.name, strings.Join(args, " "), code, out)
	}
	return out
}

// sync is one ordinary round: it must succeed.
func (n *node) sync() string { return n.must("sync", "--once") }

// join starts the machine in project (init), names it, and makes it known to the others at its next round.
func (n *node) init(project string) {
	n.s.t.Helper()
	n.must("init", "--project", project)
	hostFile := filepath.Join(n.home, ".folder-sync", "host.json")
	data, err := os.ReadFile(hostFile)
	if err != nil {
		n.s.t.Fatal(err)
	}
	var h map[string]any
	json.Unmarshal(data, &h)
	h["name"] = n.name // WHY: every machine of the test would otherwise be called by this computer's hostname
	data, _ = json.Marshal(h)
	os.WriteFile(hostFile, data, 0o600)
}

func (n *node) hostID() string {
	data, err := os.ReadFile(filepath.Join(n.home, ".folder-sync", "host.json"))
	if err != nil {
		n.s.t.Fatal(err)
	}
	var h struct{ ID string }
	json.Unmarshal(data, &h)
	return h.ID
}

func (n *node) path(rel string) string { return filepath.Join(n.folder, filepath.FromSlash(rel)) }

func (n *node) write(rel, content string) {
	n.s.t.Helper()
	writeFile(n.s.t, n.path(rel), content, time.Time{})
}

func (n *node) writeBytes(rel string, content []byte) {
	n.s.t.Helper()
	if err := os.MkdirAll(filepath.Dir(n.path(rel)), 0o755); err != nil {
		n.s.t.Fatal(err)
	}
	if err := os.WriteFile(n.path(rel), content, 0o644); err != nil {
		n.s.t.Fatal(err)
	}
}

func (n *node) read(rel string) (string, bool) {
	data, err := os.ReadFile(n.path(rel))
	return string(data), err == nil
}

// folderFiles is the folder's own files: what sync publishes, without the peers' copies and the config.
func (n *node) folderFiles() map[string]string {
	return readTree(n.s.t, n.folder, func(rel string) bool {
		return rel == "hosts" || strings.HasPrefix(rel, "hosts/") || rel == ".folder-sync.toml"
	})
}

// treeOnDisk is the shared tree as the bucket holds it: path -> bytes, read from the store's directory.
func (s *stack) treeOnDisk(userID, project, tree string) map[string]string {
	root := filepath.Join(s.data, "users", userID, project, "hosts", tree)
	out := map[string]string{}
	filepathWalk(s.t, root, func(rel string, isDir bool) bool {
		if !isDir && rel != "manifest.json" {
			data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
			if err != nil {
				s.t.Fatal(err)
			}
			out[rel] = string(data)
		}
		return true
	})
	return out
}

// sharedManifest is the shared tree's manifest, read from the store's directory.
func (s *stack) sharedManifest(userID, project, tree string) (m struct {
	Seq    int64 `json:"seq"`
	Shared struct {
		Private []string `json:"private"`
	} `json:"shared"`
	Files []struct {
		Path   string `json:"path"`
		SHA256 string `json:"sha256"`
	} `json:"files"`
}) {
	data, err := os.ReadFile(filepath.Join(s.data, "users", userID, project, "hosts", tree, "manifest.json"))
	if err != nil {
		s.t.Fatal(err)
	}
	json.Unmarshal(data, &m)
	return m
}

// olderEngineCommit is the engine as it was before the shared tree: this lane's base. An engine that has never heard of the
// shared tree sees its host as one more peer, read-only (PEP 0010 §4).
const olderEngineCommit = "2118ca0"

// oldEngine builds the folder-sync of olderEngineCommit from the repository's history, or skips when the history is not
// there (a shallow clone, the core-alone copy) and nothing requires it.
func oldEngine(t *testing.T) string {
	t.Helper()
	if err := exec.Command("git", "-C", repo, "cat-file", "-e", olderEngineCommit+"^{commit}").Run(); err != nil {
		testtools.Missing(t, "commit %s (the engine before the shared tree) is not in this clone's history", olderEngineCommit)
	}
	src := t.TempDir()
	archive := exec.Command("git", "-C", repo, "archive", olderEngineCommit)
	untar := exec.Command("tar", "-x", "-C", src)
	pipe, err := archive.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	untar.Stdin = pipe
	if err := untar.Start(); err != nil {
		t.Fatal(err)
	}
	if err := archive.Run(); err != nil {
		t.Fatalf("git archive %s: %v", olderEngineCommit, err)
	}
	if err := untar.Wait(); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(t.TempDir(), testtools.Exe("folder-sync-old"))
	buildBinary(t, src, bin)
	return bin
}

// treeVersion is the version id of a path of the shared tree as the bucket holds it now (what a page sends as its base), and
// the bytes; "" when the tree does not have it.
func (s *stack) treeVersion(userID, project, tree, path string) (version, content string) {
	m := s.sharedManifestFull(userID, project, tree)
	for _, f := range m.Files {
		if f.Path != path {
			continue
		}
		data, _ := os.ReadFile(filepath.Join(s.data, "users", userID, project, "hosts", tree, filepath.FromSlash(path)))
		parts := regexp.MustCompile(`^(.{19})(\.\d+)?Z$`).FindStringSubmatch(f.WrittenAt)
		frac := ".000"
		if parts != nil && parts[2] != "" {
			frac = (parts[2] + "000")[:4]
		}
		return parts[1] + frac + "Z_" + f.SHA256[:16], string(data)
	}
	return "", ""
}

// inFolder is the same machine (same HOME, host id and session) working in another folder, for another project.
func (n *node) inFolder(name string) *node {
	c := *n
	c.folder = filepath.Join(filepath.Dir(n.folder), name)
	os.MkdirAll(c.folder, 0o755)
	return &c
}

// escapePath percent-encodes each segment of a path for a URL, keeping the slashes.
func escapePath(path string) string {
	segments := strings.Split(path, "/")
	for i, segment := range segments {
		segments[i] = url.PathEscape(segment)
	}
	return strings.Join(segments, "/")
}
