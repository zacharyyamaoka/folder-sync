package main

// The activity log's wiring (PEP 0007 §4): every sync writes the folder's local log; --events adds stdout.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"folder-sync/internal/config"
	"folder-sync/internal/syncer"
	"folder-sync/internal/synclog"
)

func localLog(t *testing.T, stateDir string) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(synclog.Dir(stateDir), time.Now().UTC().Format("2006-01-02")+".jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("not a JSON line: %q", line)
		}
		out = append(out, m)
	}
	return out
}

func TestSyncOnceWritesItsRoundToTheLocalLog(t *testing.T) {
	l, h := sandbox(t)
	folder := t.TempDir()
	config.Write(folder, config.New("demo", "folder-sync"))
	abs, _ := filepath.Abs(folder)
	useProcess(t, "cat <<'EOF'\n"+processOutput("http://127.0.0.1:1", "users/AbC123/", "folder-sync")+"\nEOF\n")
	if code, _, _ := runCmd("sync", "--once", "--dir", folder); code == 0 {
		t.Fatal("a round against a closed port succeeded")
	}
	stateDir := filepath.Join(l.Projects, syncer.StateKey("demo", abs, "users/AbC123/"))
	got := localLog(t, stateDir)
	if len(got) != 2 || got[0]["event"] != "round_start" || got[0]["source"] != "once" || got[1]["event"] != "round" || got[1]["ok"] != false {
		t.Fatalf("local log %v", got)
	}
	for _, m := range got {
		if m["schema"] != synclog.Schema || m["project"] != "demo" || m["host"] != h.ID || m["host_name"] != h.Name || m["level"] == nil {
			t.Fatalf("a local line lacks what the contract says it has: %v", m)
		}
	}
	if got[1]["kind"] == nil || got[1]["why"] == "" {
		t.Fatalf("a failed round says neither kind nor why: %v", got[1])
	}
	data, _ := os.ReadFile(filepath.Join(synclog.Dir(stateDir), time.Now().UTC().Format("2006-01-02")+".jsonl"))
	for _, leak := range []string{"very-secret-value", "tok-session-abcdef", "ASIAEXAMPLE1234"} {
		if bytes.Contains(data, []byte(leak)) {
			t.Fatalf("the log holds %q:\n%s", leak, data)
		}
	}
}

func TestARoundThatNeverRanLogsNothing(t *testing.T) {
	l, _ := sandbox(t)
	folder := t.TempDir()
	config.Write(folder, config.New("demo", "folder-sync"))
	abs, _ := filepath.Abs(folder)
	useProcess(t, "cat <<'EOF'\n"+processOutput("http://127.0.0.1:1", "users/AbC123/", "folder-sync")+"\nEOF\n")
	stateDir := filepath.Join(l.Projects, syncer.StateKey("demo", abs, "users/AbC123/"))
	os.MkdirAll(stateDir, 0o700)
	os.WriteFile(filepath.Join(stateDir, "lock"), []byte(fmt.Sprintf("pid %d at now\n", os.Getpid())), 0o600)
	if code, _, _ := runCmd("sync", "--once", "--dir", folder); code != 75 {
		t.Fatalf("code %d, want 75", code)
	}
	if entries, _ := os.ReadDir(synclog.Dir(stateDir)); len(entries) != 0 {
		t.Fatalf("a round that never ran wrote %v", entries)
	}
}

// --events keeps the tray's lines as they were; the local log gets the same events with project, host, host_name and
// level, and the why scrubbed of the round's keys in both.
func TestTheWatchWriterPrintsTheTraysLinesAndLogsTheFullOnes(t *testing.T) {
	l, h := sandbox(t)
	p := &syncer.Project{StateDir: filepath.Join(l.Projects, "demo-1a2b3c4d"), Host: h}
	p.Config.Project = "demo"
	p.Creds.SecretAccessKey = "very-secret-value"
	var stdout bytes.Buffer
	ev := newEventWriter(p, &stdout)
	ev.emit(syncEvent{Event: "watching", Folder: "/f", Project: "demo", Host: h.ID, Watcher: boolPtr(true), Hub: "off"})
	ev.emit(syncEvent{Event: "round", OK: boolPtr(false), Kind: KindError, Why: "PUT refused very-secret-value", Ms: 5})
	printed := strings.Split(strings.TrimSpace(stdout.String()), "\n")
	if len(printed) != 2 || strings.Contains(stdout.String(), `"level"`) || strings.Contains(stdout.String(), `"host_name"`) {
		t.Fatalf("stdout changed shape: %q", printed)
	}
	if strings.Contains(stdout.String(), "very-secret-value") {
		t.Fatalf("stdout holds the secret: %q", printed)
	}
	logged := localLog(t, p.StateDir)
	if len(logged) != 2 || logged[0]["level"] != "info" || logged[1]["level"] != "error" || logged[1]["host_name"] != h.Name ||
		logged[1]["why"] != "PUT refused [redacted]" {
		t.Fatalf("local log %v", logged)
	}
	// without --events nothing reaches stdout, and the local log still is written
	quiet := newEventWriter(p, nil)
	quiet.emit(syncEvent{Event: "stopped"})
	if got := localLog(t, p.StateDir); len(got) != 3 || got[2]["event"] != "stopped" {
		t.Fatalf("local log without --events %v", got)
	}
}
