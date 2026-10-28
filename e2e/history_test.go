package e2e

// PEP 0007's version history, end to end on the stand-in: an edit keeps the old version, a burst keeps one, *.log
// keeps none, a delete is restorable, a restore never loses an unsynced edit, a restore request from the web or from
// another machine is carried out and answered, and the engine's own prune follows the schedule. The stand-in (rclone
// serve s3) ignores x-amz-copy-source-if-match and lists an object's LastModified as its file's mtime, so the 412
// path is proved in internal/syncer against a fake store, and the prune here ages objects by their mtime.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"testing"
	"time"

	"folder-sync/internal/s3"
)

// historyWorld is TestTwoMachines' setup: a fresh binary, the stand-in, the counting proxy, and two machines with
// the key in their environment.
func historyWorld(t *testing.T) (*world, *machine, *machine) {
	rcloneBin := filepath.Join(repo, ".tools", "rclone")
	if _, err := os.Stat(rcloneBin); err != nil {
		t.Skip("no .tools/rclone: run scripts/dev-tools first")
	}
	work := t.TempDir()
	bin := filepath.Join(work, "folder-sync")
	goBuild(t, bin, "./cmd/folder-sync")
	w := &world{t: t, bin: bin, rclone: rcloneBin, data: filepath.Join(work, "s3"), keyID: "e2e" + randomHex(8), secret: randomHex(20), ops: &opLog{}}
	os.MkdirAll(filepath.Join(w.data, bucket), 0o755)
	startStandIn(t, rcloneBin, w.data, w.keyID, w.secret)
	startProxy(t, w.ops)
	a, b := w.newMachine("A", true), w.newMachine("B", true)
	w.must(a, "init", "--project", project, "--bucket", bucket)
	w.must(b, "init", "--project", project, "--bucket", bucket)
	return w, a, b
}

// put writes an object through the stand-in's S3 API, as the accounts Worker would. WHY not into its directory: the
// stand-in caches its listings, so a file written behind its back is not listed. A non-zero mtime becomes the
// object's LastModified on the stand-in (rclone keeps x-amz-meta-mtime as the file's mtime, and lists that), which is
// how a test ages history without waiting 30 days.
func (w *world) put(t *testing.T, key, content string, mtime time.Time) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPut, "http://"+standInAddr+"/"+bucket+"/"+s3.EncodePath(key), strings.NewReader(content))
	if !mtime.IsZero() {
		req.Header.Set("X-Amz-Meta-Mtime", fmt.Sprintf("%d.%09d", mtime.Unix(), mtime.Nanosecond()))
	}
	sum := sha256.Sum256([]byte(content))
	s3.Sign(req, w.keyID, w.secret, "auto", time.Now(), hex.EncodeToString(sum[:]))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT %s: %s", key, resp.Status)
	}
}

func sha16(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])[:16]
}

func stateDir(t *testing.T, m *machine) string {
	t.Helper()
	states, _ := filepath.Glob(filepath.Join(m.home, ".folder-sync", "projects", project+"-*"))
	if len(states) != 1 {
		t.Fatalf("%s's state dirs: %v", m.name, states)
	}
	return states[0]
}

// versions answers the kept versions of one path: version id -> bytes.
func (w *world) versions(host, path string) map[string]string {
	out := map[string]string{}
	prefix := "_history/" + project + "/" + host + "/" + path + "/"
	for _, key := range w.objects(prefix) {
		rest := strings.TrimPrefix(key, prefix)
		if strings.Contains(rest, "/") {
			continue
		}
		content, _ := w.object(key)
		out[rest] = content
	}
	return out
}

func (w *world) jsonObject(t *testing.T, key string, into any) {
	t.Helper()
	data, ok := w.object(key)
	if !ok {
		t.Fatalf("no object %s; the bucket holds:\n  %s", key, strings.Join(w.objects(""), "\n  "))
	}
	if err := json.Unmarshal([]byte(data), into); err != nil {
		t.Fatalf("%s: %v\n%s", key, err, data)
	}
}

type recordEvent struct {
	Event   string `json:"event"`
	Path    string `json:"path"`
	Op      string `json:"op"`
	From    string `json:"from"`
	Request string `json:"request"`
	Seq     int64  `json:"seq"`
	Host    string `json:"host"`
	Peer    string `json:"peer"`
	PeerSeq int64  `json:"peer_seq"`
	UpMs    *int64 `json:"up_ms"`
	DownMs  *int64 `json:"down_ms"`
	Was     *struct {
		Kept *string `json:"kept"`
		Why  string  `json:"why"`
	} `json:"was"`
}

type changeRecord struct {
	Schema string        `json:"schema"`
	Seq    int64         `json:"seq"`
	At     string        `json:"at"`
	By     string        `json:"by"`
	Events []recordEvent `json:"events"`
}

func (r changeRecord) event(path string) recordEvent {
	for _, e := range r.Events {
		if e.Path == path {
			return e
		}
	}
	return recordEvent{}
}

func manifestSeq(t *testing.T, w *world, host string) int64 {
	var m struct{ Seq int64 }
	w.jsonObject(t, project+"/hosts/"+host+"/manifest.json", &m)
	return m.Seq
}

// validateAgainst checks JSON objects against one of schema/'s files with python-jsonschema (skipped without it),
// resolving the schemas' relative $refs between files.
func validateAgainst(t *testing.T, schema string, docs ...string) {
	t.Helper()
	if reason := missingPythonModule("python3", "jsonschema"); reason != "" {
		t.Log(reason)
		return
	}
	script := `import json, sys, os, jsonschema
d = sys.argv[1]
store = {}
for name in os.listdir(d):
    if name.endswith(".schema.json"):
        doc = json.load(open(os.path.join(d, name)))
        store["https://folder-sync.invalid/schema/" + name] = doc
        store[doc["$id"]] = doc
schema = store["https://folder-sync.invalid/schema/" + sys.argv[2]]
resolver = jsonschema.RefResolver("https://folder-sync.invalid/schema/" + sys.argv[2], schema, store=store)
for doc in sys.argv[3:]:
    jsonschema.validate(json.loads(doc), schema, resolver=resolver)
print("valid:", len(sys.argv) - 3)`
	args := append([]string{"-c", script, filepath.Join(repo, "schema"), schema}, docs...)
	if out, err := exec.Command("python3", args...).CombinedOutput(); err != nil {
		t.Fatalf("%s: %v\n%s", schema, err, out)
	}
}

func TestHistory(t *testing.T) {
	w, a, b := historyWorld(t)
	idA, idB := hostID(t, a), hostID(t, b)
	plan := filepath.Join(a.folder, "notes", "plan.md")
	agentLog := filepath.Join(a.folder, "logs", "agent.log")

	writeFile(t, plan, "plan v1\n", time.Time{})
	writeFile(t, agentLog, "line 1\n", time.Time{})
	w.must(a, "sync", "--once")
	w.must(b, "sync", "--once") // B learns of A (its first round reconciles and discovers)
	w.ops.take()

	var v1 string // the id of plan v1 in A's history
	t.Run("an edit keeps the old version, with no listing; *.log keeps none", func(t *testing.T) {
		writeFile(t, plan, "plan v2\n", time.Time{})
		writeFile(t, agentLog, "line 1\nline 2\n", time.Time{})
		out := w.must(a, "sync", "--once")
		ops := w.ops.take()
		kept := w.versions(idA, "notes/plan.md")
		for id, content := range kept {
			if content == "plan v1\n" && strings.HasSuffix(id, "_"+sha16("plan v1\n")) {
				v1 = id
			}
		}
		if v1 == "" || len(kept) != 1 {
			t.Fatalf("history of notes/plan.md: %v\n%s", kept, out)
		}
		if logs := w.versions(idA, "logs/agent.log"); len(logs) != 0 {
			t.Errorf("*.log kept history: %v", logs)
		}
		c := counts(ops)
		if c["COPY"] != 1 || c["LIST"] != 0 || c["DELETE"] != 0 {
			t.Errorf("an edit of one kept file and one log: want 1 COPY, no LIST, no DELETE: %v", c)
		}
		if live, _ := w.object(project + "/hosts/" + idA + "/notes/plan.md"); live != "plan v2\n" {
			t.Errorf("live plan.md = %q", live)
		}
		var record changeRecord
		seq := manifestSeq(t, w, idA)
		w.jsonObject(t, fmt.Sprintf("_changes/%s/%s/%012d.json", project, idA, seq), &record)
		edit, logEdit := record.event("notes/plan.md"), record.event("logs/agent.log")
		if record.Schema != "folder-sync-changes/1" || record.Seq != seq || record.By != "machine" ||
			edit.Event != "upload" || edit.Op != "edit" || edit.Was == nil || edit.Was.Kept == nil || *edit.Was.Kept != v1 || edit.UpMs == nil {
			t.Errorf("the change record for seq %d: %+v (plan.md: %+v)", seq, record, edit)
		}
		if logEdit.Was == nil || logEdit.Was.Kept != nil || logEdit.Was.Why != "no_history" {
			t.Errorf("agent.log's event: %+v", logEdit)
		}
		raw, _ := w.object(fmt.Sprintf("_changes/%s/%s/%012d.json", project, idA, seq))
		validateAgainst(t, "changes.schema.json", raw)
	})

	t.Run("a burst keeps at most one version per 30 s", func(t *testing.T) {
		writeFile(t, plan, "plan v3\n", time.Time{})
		w.must(a, "sync", "--once")
		if kept := w.versions(idA, "notes/plan.md"); len(kept) != 1 {
			t.Fatalf("v2 lived under 30 s, and v1 was kept seconds ago: %v", kept)
		}
		var record changeRecord
		w.jsonObject(t, fmt.Sprintf("_changes/%s/%s/%012d.json", project, idA, manifestSeq(t, w, idA)), &record)
		if e := record.event("notes/plan.md"); e.Was == nil || e.Was.Kept != nil || e.Was.Why != "burst" {
			t.Errorf("v2's event: %+v", e)
		}
		w.ops.take()
	})

	t.Run("a delete is kept and restorable", func(t *testing.T) {
		os.Remove(plan)
		w.must(a, "sync", "--once")
		if _, ok := w.object(project + "/hosts/" + idA + "/notes/plan.md"); ok {
			t.Fatal("the deleted file is still live")
		}
		kept := w.versions(idA, "notes/plan.md")
		var v3 string
		for id, content := range kept {
			if content == "plan v3\n" {
				v3 = id
			}
		}
		if v3 == "" {
			t.Fatalf("a delete inside a burst is kept: %v", kept)
		}
		out := w.must(a, "deleted")
		if !strings.Contains(out, "notes/plan.md") || !strings.Contains(out, v3) {
			t.Fatalf("deleted:\n%s", out)
		}
		out = w.must(a, "deleted", "--restore", "notes/")
		if data, _ := os.ReadFile(plan); string(data) != "plan v3\n" {
			t.Fatalf("after deleted --restore notes/: %q\n%s", data, out)
		}
		if live, _ := w.object(project + "/hosts/" + idA + "/notes/plan.md"); live != "plan v3\n" {
			t.Errorf("the restore was not published: %q", live)
		}
		var record changeRecord
		w.jsonObject(t, fmt.Sprintf("_changes/%s/%s/%012d.json", project, idA, manifestSeq(t, w, idA)), &record)
		if e := record.event("notes/plan.md"); e.Event != "restore" || e.From != v3 {
			t.Errorf("the restore's event: %+v", e)
		}
		if out := w.must(a, "deleted"); strings.Contains(out, "notes/plan.md") {
			t.Errorf("a restored file is no longer deleted:\n%s", out)
		}
		w.ops.take()
	})

	t.Run("a restore with an unsynced edit keeps the edit", func(t *testing.T) {
		// WHY no wait for the burst: the version a restore replaces is always kept (PEP 0007 §14.3)
		writeFile(t, plan, "an edit never synced\n", time.Time{})
		out := w.must(a, "restore", "notes/plan.md", "--version", v1)
		if data, _ := os.ReadFile(plan); string(data) != "plan v1\n" {
			t.Fatalf("after restore --version v1: %q\n%s", data, out)
		}
		found := false
		for _, content := range w.versions(idA, "notes/plan.md") {
			found = found || content == "an edit never synced\n"
		}
		if !found {
			t.Fatalf("the unsynced edit is not in history: %v\n%s", w.versions(idA, "notes/plan.md"), out)
		}
		out = w.must(a, "history", "notes/plan.md")
		if !strings.Contains(out, v1) {
			t.Errorf("history:\n%s", out)
		}
		w.ops.take()
	})

	t.Run("a restore asked from the web and from another machine is carried out and answered", func(t *testing.T) {
		// a path of its own, so its first replaced version is outside any burst
		other := filepath.Join(a.folder, "notes", "other.md")
		writeFile(t, other, "other v1\n", time.Time{})
		w.must(a, "sync", "--once")
		writeFile(t, other, "other v2\n", time.Time{})
		w.must(a, "sync", "--once")
		var v4 string
		for id, content := range w.versions(idA, "notes/other.md") {
			if content == "other v1\n" {
				v4 = id
			}
		}
		if v4 == "" {
			t.Fatalf("other v1 was not kept: %v", w.versions(idA, "notes/other.md"))
		}
		// the web: the accounts Worker's request, written straight into the bucket
		webID := "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d"
		pruned := "2026-09-20T10:00:00.000Z_0011223344556677"
		web := fmt.Sprintf(`{"schema":"folder-sync-restore/1","id":%q,"project":%q,"host":%q,"at":%q,"by":{"kind":"web","name":"Chrome on Linux"},"items":[{"path":"notes/other.md","version":%q},{"path":"notes/very-old.md","version":%q}]}`,
			webID, project, idA, time.Now().UTC().Format(time.RFC3339Nano), v4, pruned)
		webKey := "_requests/" + project + "/" + idA + "/" + webID + ".json"
		w.put(t, webKey, web, time.Time{})
		w.ops.take()
		out := w.must(a, "sync", "--once", "--discover")
		if data, _ := os.ReadFile(other); string(data) != "other v1\n" {
			t.Fatalf("the web request was not applied: %q\n%s", data, out)
		}
		var answered struct {
			Outcome *struct {
				Seq     int64 `json:"seq"`
				Results []struct {
					Path  string `json:"path"`
					OK    bool   `json:"ok"`
					Error string `json:"error"`
				} `json:"results"`
			} `json:"outcome"`
		}
		w.jsonObject(t, webKey, &answered)
		if answered.Outcome == nil || len(answered.Outcome.Results) != 2 || !answered.Outcome.Results[0].OK ||
			answered.Outcome.Results[1].OK || answered.Outcome.Results[1].Error != "pruned" || answered.Outcome.Seq != manifestSeq(t, w, idA) {
			raw, _ := w.object(webKey)
			t.Fatalf("the request's outcome: %s", raw)
		}
		raw, _ := w.object(webKey)
		validateAgainst(t, "restore.schema.json", raw)
		var record changeRecord
		w.jsonObject(t, fmt.Sprintf("_changes/%s/%s/%012d.json", project, idA, answered.Outcome.Seq), &record)
		if e := record.event("notes/other.md"); e.Event != "restore" || e.From != v4 || e.Request != webID {
			t.Errorf("the restore's event: %+v", e)
		}

		// another machine: B asks for v1 of A's file through its own copy's path
		out = w.must(b, "restore", "hosts/"+idA+"/notes/plan.md", "--version", v1)
		requests := w.objects("_requests/" + project + "/" + idA + "/")
		if len(requests) != 2 || !strings.Contains(out, "asked") {
			t.Fatalf("B's request: %v\n%s", requests, out)
		}
		w.must(a, "sync", "--once", "--discover")
		if data, _ := os.ReadFile(plan); string(data) != "plan v1\n" {
			t.Fatalf("B's request was not applied: %q", data)
		}
		w.ops.take()
	})

	t.Run("the peer that pulls writes a pull record with its sync times", func(t *testing.T) {
		w.must(b, "sync", "--once")
		pulls := w.objects("_changes/" + project + "/" + idB + "/pulls/")
		if len(pulls) == 0 {
			t.Fatalf("B wrote no pull record; its changes: %v", w.objects("_changes/"+project+"/"+idB+"/"))
		}
		var record struct {
			Schema string        `json:"schema"`
			Events []recordEvent `json:"events"`
		}
		w.jsonObject(t, pulls[len(pulls)-1], &record)
		e := record.Events[0]
		if record.Schema != "folder-sync-pulls/1" || e.Event != "download" || e.Peer != idA || e.PeerSeq == 0 || e.DownMs == nil {
			t.Errorf("B's pull record: %+v", record)
		}
		raw, _ := w.object(pulls[len(pulls)-1])
		validateAgainst(t, "pulls.schema.json", raw)
		w.ops.take()
	})

	t.Run("a restore while another round holds the folder is left for it, and --watch applies it", func(t *testing.T) {
		writeFile(t, plan, "plan before the queued restore\n", time.Time{})
		w.must(a, "sync", "--once")
		// WHY a lock file and not a racing --watch: the restore must meet a held lock every time
		lock := filepath.Join(stateDir(t, a), "lock")
		os.WriteFile(lock, []byte("pid 1 at test\n"), 0o600)
		out := w.must(a, "restore", "notes/plan.md", "--version", v1)
		os.Remove(lock)
		if !strings.Contains(out, "applies it") {
			t.Fatalf("restore output: %s", out)
		}
		if data, _ := os.ReadFile(plan); string(data) != "plan before the queued restore\n" {
			t.Fatalf("a restore must not write while another round holds the folder: %q", data)
		}
		editConfig(t, a, `interval = "10s"`, `interval = "1s"`)
		cmd := exec.Command(w.bin, "sync", "--watch")
		cmd.Env, cmd.Dir = a.env, a.folder
		var buf bytes.Buffer
		cmd.Stdout, cmd.Stderr = &buf, &buf
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		defer func() {
			cmd.Process.Signal(syscall.SIGTERM)
			cmd.Wait()
			editConfig(t, a, `interval = "1s"`, `interval = "10s"`)
		}()
		answered := func() bool {
			entries, _ := os.ReadDir(filepath.Join(stateDir(t, a), "requests"))
			for _, entry := range entries {
				if data, _ := os.ReadFile(filepath.Join(stateDir(t, a), "requests", entry.Name())); !strings.Contains(string(data), `"outcome"`) {
					return false
				}
			}
			return len(entries) > 0
		}
		for deadline := time.Now().Add(15 * time.Second); ; time.Sleep(200 * time.Millisecond) {
			data, _ := os.ReadFile(plan)
			live, _ := w.object(project + "/hosts/" + idA + "/notes/plan.md")
			if string(data) == "plan v1\n" && live == "plan v1\n" && answered() {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("--watch did not apply the local request:\n%s", buf.String())
			}
		}
		w.ops.take()
	})

	t.Run("the engine prunes its own history to the schedule, and old records and trash", func(t *testing.T) {
		now := time.Now().UTC()
		plant := func(key, content string, mtime time.Time) { w.put(t, key, content, mtime) }
		id := func(left time.Time) string {
			return left.Add(-time.Minute).Format("2006-01-02T15:04:05.000Z") + "_" + sha16(left.String())
		}
		hour := now.Truncate(time.Hour).Add(-5 * time.Hour)   // 5 to 6 hours old: the hourly tier
		day := now.AddDate(0, 0, -3).Truncate(24 * time.Hour) // 2 to 3 days old: the daily tier
		aged := map[string]time.Time{
			"hour-early": hour.Add(10 * time.Minute), "hour-late": hour.Add(40 * time.Minute),
			"day-early": day.Add(time.Hour), "day-late": day.Add(2 * time.Hour),
			"month-old": now.AddDate(0, 0, -31), "fresh": now.Add(-10 * time.Minute),
		}
		prefix := "_history/" + project + "/" + idA + "/aged/x.md/"
		keyOf := map[string]string{}
		for name, left := range aged {
			keyOf[name] = prefix + id(left)
			plant(keyOf[name], name, left)
		}
		old := now.AddDate(0, 0, -31)
		recent := now.AddDate(0, 0, -29)
		plant("_trash/"+project+"/"+idA+"/"+old.Format("20060102T150405Z")+"/gone.md", "old trash", old)
		plant("_trash/"+project+"/"+idA+"/"+recent.Format("20060102T150405Z")+"-123-abcd1234/kept.md", "recent trash", recent)
		plant(fmt.Sprintf("_changes/%s/%s/%012d.json", project, idA, 900), "{}", old)
		plant("_changes/"+project+"/"+idA+"/pulls/"+old.Format("2006-01-02T15:04:05.000Z")+".json", "{}", now) // the key's at counts
		plant("_requests/"+project+"/"+idA+"/0f0e0d0c-0b0a-4908-8706-050403020100.json", "{}", old)
		// due: never pruned, and a reconcile due
		state := stateDir(t, a)
		os.Remove(filepath.Join(state, "prune.json"))
		var last map[string]any
		data, _ := os.ReadFile(filepath.Join(state, "last-sync.json"))
		json.Unmarshal(data, &last)
		last["last_reconcile"] = ""
		data, _ = json.Marshal(last)
		os.WriteFile(filepath.Join(state, "last-sync.json"), data, 0o600)

		out := w.must(a, "sync", "--once")
		var left []string
		for _, key := range w.objects(prefix) {
			content, _ := w.object(key)
			left = append(left, content)
		}
		sort.Strings(left)
		if want := "day-late,fresh,hour-late"; strings.Join(left, ",") != want {
			t.Errorf("aged/x.md keeps %v, want %s\n%s", left, want, out)
		}
		trash := w.objects("_trash/" + project + "/" + idA + "/")
		if len(trash) != 1 || !strings.HasSuffix(trash[0], "/kept.md") {
			t.Errorf("legacy trash after the prune: %v", trash)
		}
		if _, ok := w.object(fmt.Sprintf("_changes/%s/%s/%012d.json", project, idA, 900)); ok {
			t.Error("a change record older than 30 days is still there")
		}
		for _, key := range w.objects("_changes/" + project + "/" + idA + "/pulls/") {
			if strings.Contains(key, old.Format("2006-01-02T15:04:05.000Z")) {
				t.Error("a pull record older than 30 days is still there")
			}
		}
		if _, ok := w.object("_requests/" + project + "/" + idA + "/0f0e0d0c-0b0a-4908-8706-050403020100.json"); ok {
			t.Error("a request older than 30 days is still there")
		}
		if kept := w.versions(idA, "notes/plan.md"); len(kept) == 0 {
			t.Error("the prune removed this hour's versions of notes/plan.md")
		}
		w.ops.take()
	})

	t.Run("a second round with no changes still does zero uploads and no listing", func(t *testing.T) {
		for _, m := range []*machine{a, b, a, b} {
			w.must(m, "sync", "--once")
		}
		for _, m := range []*machine{a, b} {
			w.ops.take()
			w.must(m, "sync", "--once")
			ops := w.ops.take()
			if len(ops) != 1 || ops[0].Method != http.MethodGet || ops[0].Status != http.StatusNotModified {
				t.Errorf("%s: want one conditional manifest GET answered 304, got %+v", m.name, ops)
			}
		}
	})
}
