package e2e

// Short-lived, prefix-scoped credentials end to end (docs/peps/0002): two people, three machines, one
// bucket. Person A syncs from two machines under users/aaa/, person B from one under users/aaab/ (an id
// that starts like A's on purpose: only the trailing slash keeps the two apart). Every key comes from a
// credential process (`r2standin mint`), and every request goes through r2standin, which refuses what R2
// refuses for a temporary credential scoped to one prefix. Storage is `rclone serve s3` with no keys of its
// own, reachable only through the gate.
//
// Ports: the gate on 127.0.0.1:4912 and the storage on 127.0.0.1:4913 (FOLDER_SYNC_E2E_GATE /
// FOLDER_SYNC_E2E_STORAGE override them). Needs the pinned rclone (.tools/rclone or FOLDER_SYNC_E2E_RCLONE).

import (
	"bufio"
	"encoding/json"
	"fmt"
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

	"folder-sync/internal/s3"
)

const scopedBucket = "fs-test"

func addr(env, fallback string) string {
	if value := os.Getenv(env); value != "" {
		return value
	}
	return fallback
}

func goBuild(t *testing.T, out, pkg string) {
	t.Helper()
	build := exec.Command("go", "build", "-o", out, pkg)
	build.Dir = repo
	if goroot := runtime.GOROOT(); goroot != "" {
		build.Path = filepath.Join(goroot, "bin", "go")
	}
	if text, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build %s: %v\n%s", pkg, err, text)
	}
}

func startProcess(t *testing.T, name, logPath string, argv ...string) {
	t.Helper()
	log, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Stdout, cmd.Stderr = log, log
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Logf("%s: pid %d", name, cmd.Process.Pid)
	t.Cleanup(func() {
		cmd.Process.Signal(syscall.SIGTERM)
		done := make(chan struct{})
		go func() { cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			cmd.Process.Kill()
		}
		log.Close()
	})
}

func waitPort(t *testing.T, address string) {
	t.Helper()
	for i := 0; i < 100; i++ {
		if conn, err := net.DialTimeout("tcp", address, 100*time.Millisecond); err == nil {
			conn.Close()
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("nothing answered on %s", address)
}

func portFree(t *testing.T, address string) {
	t.Helper()
	if conn, err := net.DialTimeout("tcp", address, 200*time.Millisecond); err == nil {
		conn.Close()
		t.Fatalf("%s is busy: stop whatever holds it", address)
	}
}

type gateEntry struct {
	Temporary  bool     `json:"temporary"`
	Prefixes   []string `json:"prefixes"`
	Op         string   `json:"op"`
	Object     string   `json:"object"`
	ListPrefix string   `json:"list_prefix"`
	CopyFrom   string   `json:"copy_from"`
	Allowed    bool     `json:"allowed"`
	Why        string   `json:"why"`
}

func readGateLog(t *testing.T, path string) []gateEntry {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	var out []gateEntry
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		var e gateEntry
		if json.Unmarshal(scanner.Bytes(), &e) == nil {
			out = append(out, e)
		}
	}
	return out
}

func TestScopedCredentialsKeepPeopleApart(t *testing.T) {
	rcloneBin := os.Getenv("FOLDER_SYNC_E2E_RCLONE")
	if rcloneBin == "" {
		rcloneBin = filepath.Join(repo, ".tools", "rclone")
	}
	if _, err := os.Stat(rcloneBin); err != nil {
		t.Skip("no pinned rclone (.tools/rclone or FOLDER_SYNC_E2E_RCLONE): run scripts/dev-tools first")
	}
	gateAddr, storageAddr := addr("FOLDER_SYNC_E2E_GATE", "127.0.0.1:4912"), addr("FOLDER_SYNC_E2E_STORAGE", "127.0.0.1:4913")
	portFree(t, gateAddr)
	portFree(t, storageAddr)
	work := t.TempDir()
	bin, standin := filepath.Join(work, "folder-sync"), filepath.Join(work, "r2standin")
	goBuild(t, bin, "./cmd/folder-sync")
	goBuild(t, standin, "./e2e/r2standin")

	account, parentID, parentSecret := "acct"+randomHex(8), "parent"+randomHex(8), randomHex(24)
	data := filepath.Join(work, "s3")
	os.MkdirAll(filepath.Join(data, scopedBucket), 0o755)
	gateLog := filepath.Join(work, "gate.jsonl")
	startProcess(t, "storage", filepath.Join(work, "storage.log"), rcloneBin, "serve", "s3", "--addr", storageAddr,
		"--config", os.DevNull, "--cache-dir", filepath.Join(work, "storage-cache"), data)
	startProcess(t, "gate", filepath.Join(work, "gate.log"), standin, "serve", "--listen", gateAddr, "--backend", storageAddr,
		"--account", account, "--parent", parentID+":"+parentSecret, "--log", gateLog)
	waitPort(t, storageAddr)
	waitPort(t, gateAddr)
	endpoint := "http://" + gateAddr

	process := func(prefix string) string {
		argv, _ := json.Marshal([]string{standin, "mint", "--account", account, "--parent", parentID + ":" + parentSecret,
			"--endpoint", endpoint, "--bucket", scopedBucket, "--prefix", prefix, "--ttl", "15m"})
		return string(argv)
	}
	w := &world{t: t, bin: bin, rclone: rcloneBin, data: data}
	mk := func(name, prefix string) *machine {
		m := w.newMachine(name, false)
		m.env = append(m.env, "FOLDER_SYNC_CREDENTIAL_PROCESS="+process(prefix))
		return m
	}
	const rootA, rootB = "users/aaa/", "users/aaab/"
	a1, a2, b1 := mk("A1", rootA), mk("A2", rootA), mk("B1", rootB)
	writeFile(t, filepath.Join(a1.folder, "tracks", "a.md"), "A's track\n", time.Time{})
	writeFile(t, filepath.Join(b1.folder, "tracks", "b.md"), "B's track\n", time.Time{})

	for _, m := range []*machine{a1, a2, b1} {
		out := w.must(m, "init", "--project", "home") // no --bucket: the credentials' Bucket
		if !strings.Contains(out, "can reach") {
			t.Fatalf("%s init: %s", m.name, out)
		}
	}
	idA1, idA2, idB1 := hostID(t, a1), hostID(t, a2), hostID(t, b1)

	t.Run("each machine writes under its person's root only", func(t *testing.T) {
		w.must(a1, "sync", "--once")
		w.must(b1, "sync", "--once")
		// w.object and w.objects take keys inside the bucket (the e2e's bucket constant is the same name)
		if _, ok := w.object(rootA + "home/hosts/" + idA1 + "/tracks/a.md"); !ok {
			t.Fatalf("A1's file is not under %s: %v", rootA, w.objects(""))
		}
		if _, ok := w.object(rootB + "home/hosts/" + idB1 + "/tracks/b.md"); !ok {
			t.Fatalf("B1's file is not under %s: %v", rootB, w.objects(""))
		}
		for _, key := range w.objects("") {
			if !strings.HasPrefix(key, rootA) && !strings.HasPrefix(key, rootB) {
				t.Errorf("an object outside both roots: %s", key)
			}
		}
	})

	t.Run("A's two machines converge both ways", func(t *testing.T) {
		w.must(a2, "sync", "--once") // a first round reconciles, which discovers A1, then pulls its files
		if got, err := os.ReadFile(filepath.Join(a2.folder, "hosts", idA1, "tracks", "a.md")); err != nil || string(got) != "A's track\n" {
			t.Fatalf("A2 lacks A1's file: %v %q", err, got)
		}
		writeFile(t, filepath.Join(a2.folder, "tracks", "from-a2.md"), "written on A2\n", time.Time{})
		w.must(a2, "sync", "--once")
		// A1 discovered peers at its first round, before A2 existed; --discover looks again now (vt sync now)
		out := w.must(a1, "sync", "--once", "--discover")
		got, err := os.ReadFile(filepath.Join(a1.folder, "hosts", idA2, "tracks", "from-a2.md"))
		if err != nil || string(got) != "written on A2\n" {
			t.Fatalf("A1 lacks A2's file (%v): %s", err, out)
		}
		// an overwrite and a delete: server-side copies into <root>_trash/, a move out of hosts/
		writeFile(t, filepath.Join(a1.folder, "tracks", "a.md"), "A's track, edited\n", time.Time{})
		writeFile(t, filepath.Join(a1.folder, "tracks", "gone.md"), "short-lived\n", time.Time{})
		w.must(a1, "sync", "--once")
		os.Remove(filepath.Join(a1.folder, "tracks", "gone.md"))
		w.must(a1, "sync", "--once")
		trash := w.objects(rootA + "_trash/home/" + idA1)
		var old, gone bool
		for _, key := range trash {
			content, _ := w.object(key)
			old = old || (strings.HasSuffix(key, "/tracks/a.md") && content == "A's track\n")
			gone = gone || (strings.HasSuffix(key, "/tracks/gone.md") && content == "short-lived\n")
		}
		if !old || !gone {
			t.Fatalf("A's trash under its root holds %v", trash)
		}
		w.must(a2, "sync", "--once")
		if got, _ := os.ReadFile(filepath.Join(a2.folder, "hosts", idA1, "tracks", "a.md")); string(got) != "A's track, edited\n" {
			t.Fatalf("A2 has %q", got)
		}
		if _, err := os.Stat(filepath.Join(a2.folder, "hosts", idA1, "tracks", "gone.md")); err == nil {
			t.Fatal("A2 still has the deleted file")
		}
	})

	t.Run("folder-sync never asks outside its root", func(t *testing.T) {
		w.must(b1, "sync", "--once")
		entries := readGateLog(t, gateLog)
		if len(entries) == 0 {
			t.Fatal("the gate logged nothing")
		}
		for _, e := range entries {
			if !e.Temporary {
				t.Errorf("a request with the parent key during sync: %+v", e)
				continue
			}
			if !e.Allowed {
				t.Errorf("the gate refused a request folder-sync made while syncing: %+v", e)
			}
			if len(e.Prefixes) != 1 {
				t.Errorf("a credential with %d prefixes: %+v", len(e.Prefixes), e)
				continue
			}
			for _, key := range []string{e.Object, e.ListPrefix, strings.TrimPrefix(e.CopyFrom, scopedBucket+"/")} {
				if key != "" && !strings.HasPrefix(key, e.Prefixes[0]) {
					t.Errorf("a request outside its root %s: %+v", e.Prefixes[0], e)
				}
			}
		}
	})

	t.Run("projects lists only the key's own account root", func(t *testing.T) {
		for _, c := range []struct {
			m    *machine
			root string
		}{{a2, rootA}, {b1, rootB}} {
			var doc struct {
				Schema   string   `json:"schema"`
				Root     string   `json:"root"`
				Projects []string `json:"projects"`
			}
			if err := json.Unmarshal([]byte(w.must(c.m, "projects", "--json")), &doc); err != nil {
				t.Fatal(err)
			}
			if doc.Schema != "folder-sync-projects/1" || doc.Root != c.root || strings.Join(doc.Projects, ",") != "home" {
				t.Errorf("%s: projects %+v", c.m.name, doc)
			}
		}
	})

	t.Run("B never sees A, and A never sees B", func(t *testing.T) {
		if entries, _ := os.ReadDir(filepath.Join(b1.folder, "hosts")); len(entries) != 0 {
			t.Fatalf("B1 holds peer copies: %v", entries)
		}
		for _, m := range []*machine{a1, a2} {
			for _, id := range []string{idB1} {
				if _, err := os.Stat(filepath.Join(m.folder, "hosts", id)); err == nil {
					t.Fatalf("%s holds B1's files", m.name)
				}
			}
		}
		// direct probes with each person's own minted keys
		mintFor := func(prefix string) map[string]string {
			out, err := exec.Command(standin, "mint", "--account", account, "--parent", parentID+":"+parentSecret,
				"--endpoint", endpoint, "--bucket", scopedBucket, "--prefix", prefix, "--ttl", "5m").Output()
			if err != nil {
				t.Fatal(err)
			}
			var c map[string]any
			json.Unmarshal(out, &c)
			return map[string]string{"id": fmt.Sprint(c["AccessKeyId"]), "secret": fmt.Sprint(c["SecretAccessKey"]), "token": fmt.Sprint(c["SessionToken"])}
		}
		probe := func(c map[string]string, method, path, query string) int {
			u := endpoint + "/" + scopedBucket + "/" + path
			if query != "" {
				u = endpoint + "/" + scopedBucket + "?" + query
			}
			req, _ := http.NewRequest(method, u, nil)
			s3.SignWithToken(req, c["id"], c["secret"], c["token"], "auto", time.Now(), s3.EmptySHA256)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			return resp.StatusCode
		}
		credA, credB := mintFor(rootA), mintFor(rootB)
		checks := []struct {
			who    string
			cred   map[string]string
			method string
			path   string
			query  string
			want   int
		}{
			{"B reads A1's manifest", credB, "GET", rootA + "home/hosts/" + idA1 + "/manifest.json", "", 403},
			{"B lists A's root", credB, "GET", "", "list-type=2&prefix=" + strings.ReplaceAll(rootA, "/", "%2F"), 403},
			{"B writes into A's root", credB, "PUT", rootA + "home/hosts/" + idA1 + "/planted.md", "", 403},
			{"A reads B1's manifest", credA, "GET", rootB + "home/hosts/" + idB1 + "/manifest.json", "", 403},
			{"A lists everyone", credA, "GET", "", "list-type=2&prefix=users%2F", 403},
			{"A reads its own", credA, "GET", rootA + "home/hosts/" + idA1 + "/manifest.json", "", 200},
			{"B reads its own", credB, "GET", rootB + "home/hosts/" + idB1 + "/manifest.json", "", 200},
		}
		for _, c := range checks {
			if got := probe(c.cred, c.method, c.path, c.query); got != c.want {
				t.Errorf("%s: %d, want %d", c.who, got, c.want)
			}
		}
	})

	t.Run("a machine never moves its folder into another person's root", func(t *testing.T) {
		before := w.objects(scopedBucket + "/" + rootB)
		a2.env = append(a2.env[:len(a2.env)-1], "FOLDER_SYNC_CREDENTIAL_PROCESS="+process(rootB))
		out, code := w.run(a2, "sync", "--once")
		if code == 0 || !strings.Contains(out, "never moves a folder's files into another account") {
			t.Fatalf("A2 with B's credentials: exit %d: %s", code, out)
		}
		if after := w.objects(scopedBucket + "/" + rootB); strings.Join(after, "\n") != strings.Join(before, "\n") {
			t.Fatalf("A2 wrote into B's root:\n%s", strings.Join(after, "\n"))
		}
		a2.env = append(a2.env[:len(a2.env)-1], "FOLDER_SYNC_CREDENTIAL_PROCESS="+process(rootA))
	})

	t.Run("signed out: exit 4 and the cached keys are dropped", func(t *testing.T) {
		script := filepath.Join(work, "signed-out.sh")
		os.WriteFile(script, []byte("#!/bin/sh\necho 'this machine is signed out' >&2\nexit 3\n"), 0o755)
		argv, _ := json.Marshal([]string{script})
		a1.env = append(a1.env[:len(a1.env)-1], "FOLDER_SYNC_CREDENTIAL_PROCESS="+string(argv))
		if _, err := os.Stat(filepath.Join(a1.home, ".folder-sync", "session.json")); err != nil {
			t.Fatalf("A1 has no cached keys before the test: %v", err)
		}
		out, code := w.run(a1, "sync", "--once")
		if code != 4 || !strings.Contains(out, "signed out") {
			t.Fatalf("signed-out process: exit %d: %s", code, out)
		}
		if _, err := os.Stat(filepath.Join(a1.home, ".folder-sync", "session.json")); err == nil {
			t.Fatal("session.json survived a signed-out answer")
		}
	})
}
