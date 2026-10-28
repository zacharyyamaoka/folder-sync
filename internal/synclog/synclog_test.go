package synclog

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	hostID   = "b55e9683-7854-4121-a56a-9bae7c3ab1da"
	peerID   = "e2a0b1c2-d3e4-4f50-9a1b-2c3d4e5f6a7b"
	sha      = "7e3b9d0a1c2f4e5d6b7a8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f"
	oldSHA   = "9f2c1a3b4c5d6e7f00112233445566778899aabbccddeeff0011223344556677"
	secret   = "very-secret-value"
	reqID    = "3f0e1d2c-4b5a-4968-8776-a5b4c3d2e1f0"
	oldStamp = "2026-10-28T20:31:00.117260411Z"
	oldID    = "2026-10-28T20:31:00.117Z_9f2c1a3b4c5d6e7f"
)

// clock is a settable Now.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) set(t time.Time) {
	c.mu.Lock()
	c.t = t
	c.mu.Unlock()
}

func newLog(t *testing.T, at time.Time) (*Log, *bytes.Buffer, *clock) {
	t.Helper()
	var stdout bytes.Buffer
	c := &clock{t: at}
	return &Log{Dir: filepath.Join(t.TempDir(), "log"), Stdout: &stdout, Project: "notes", Host: hostID, HostName: "bam-GPU",
		Scrub: func(s string) string { return strings.ReplaceAll(s, secret, "[redacted]") }, Now: c.now}, &stdout, c
}

func lines(t *testing.T, data []byte) [][]byte {
	t.Helper()
	var out [][]byte
	for _, l := range bytes.Split(data, []byte("\n")) {
		if len(l) > 0 {
			out = append(out, l)
		}
	}
	return out
}

func dayFile(t *testing.T, l *Log, day string) [][]byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(l.Dir, day+".jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	return lines(t, data)
}

func generic(t *testing.T, data []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("not a JSON object: %q", data)
	}
	return m
}

func i64(n int64) *int64   { return &n }
func str(s string) *string { return &s }
func yes() *bool           { b := true; return &b }
func no() *bool            { b := false; return &b }

// every kind of line the engine writes, as its callers build them (no level, no project or host: the log adds them)
func everyEvent() []any {
	return []any{
		Event{Event: "watching", Folder: "/home/bam/notes", Project: "notes", Host: hostID, Watcher: yes(), Hub: "on"},
		Event{Event: "hub", Hub: "connected"},
		Event{Event: "round_start", Source: "start"},
		Event{Event: "round", OK: yes(), Fetched: 2, Peers: 2, Ms: 412},
		Event{Event: "round", OK: no(), Ms: 3004, Kind: "offline", Why: "r2.example:443 does not answer"},
		Event{Event: "round", OK: no(), Ms: 96, Kind: "error", Why: "rclone said " + secret},
		Event{Event: "upload", Seq: 43, Path: "notes/new-idea.md", Size: i64(0), SHA256: sha, Op: "add", UpMs: i64(0)},
		Event{Event: "upload", Seq: 43, Path: "notes/plan.md", Size: i64(2140), SHA256: sha, Op: "edit",
			Was: &Was{SHA256: oldSHA, Size: 1980, WrittenAt: oldStamp, Kept: str(oldID)}, UpMs: i64(406)},
		Event{Event: "upload", Seq: 43, Path: "notes/scratch.md", Size: i64(12), SHA256: sha, Op: "edit",
			Was: &Was{SHA256: oldSHA, Size: 10, WrittenAt: oldStamp, Why: "burst"}},
		Event{Event: "delete", Seq: 43, Path: "notes/old-ideas.md", Was: &Was{SHA256: oldSHA, Size: 5121, WrittenAt: oldStamp, Kept: str(oldID)}, UpMs: i64(1203)},
		Event{Event: "delete", Seq: 45, Path: "notes/big.bin", Permanent: true, Was: &Was{SHA256: oldSHA, Size: 9, WrittenAt: oldStamp, Why: "permanent"}},
		Event{Event: "restore", Seq: 44, Path: "notes/plan.md", Size: i64(1980), SHA256: oldSHA, From: oldID, Request: reqID},
		Event{Event: "restore", Path: "notes/very-old.md", From: "2026-09-20T10:00:00.000Z_0011223344556677", Request: reqID, Error: "pruned"},
		Event{Event: "download", Peer: peerID, PeerName: "web", Path: "hearts/clamp-24.json", Size: i64(233), PeerSeq: 6, DownMs: i64(1318)},
		Event{Event: "remove_copy", Peer: peerID, PeerName: "web", Path: "hearts/old-draft.json", PeerSeq: 6, DownMs: i64(-40)},
		Event{Event: "skip", Path: "CON.txt", Why: "a reserved name on Windows: rename CON.txt to sync it"},
		Event{Event: "conflict", Peer: peerID, PeerName: "bam-laptop", Path: "notes/plan.md", KeptAt: "~/.folder-sync/conflicts/notes/x/notes/plan.md"},
		Event{Event: "hold", Why: "max_delete", Count: 73},
		Event{Event: "synced"},
		&Event{Event: "stopped"},
		map[string]any{"event": "upload", "path": "a.md", "size": 3, "sha256": sha, "op": "add", "bytes_per_s": 12.5},
	}
}

// The tray reads these lines today (docs/peps/0006): each parses into an Event and comes back field for field, and
// so does every file event the contract's fixture shows.
func TestFixtureLinesParseAndComeBackFieldForField(t *testing.T) {
	for _, name := range []string{"desktop.jsonl", "file-events.jsonl"} {
		for i, line := range fixtureLines(t, name) {
			var ev Event
			if err := json.Unmarshal(line, &ev); err != nil {
				t.Fatalf("%s line %d does not parse: %v", name, i+1, err)
			}
			back, err := json.Marshal(ev)
			if err != nil {
				t.Fatal(err)
			}
			if want, got := generic(t, line), generic(t, back); !reflect.DeepEqual(want, got) {
				t.Errorf("%s line %d:\n want %s\n got  %s", name, i+1, line, back)
			}
		}
	}
}

// `--events` on stdout stays exactly what the desktop app reads (CONTRACT: "The desktop app's events stay exactly as
// they are"): no level, host_name or project added there; the local log adds them.
func TestStdoutKeepsTheDesktopLinesAsTheyAre(t *testing.T) {
	l, stdout, _ := newLog(t, time.Date(2026, 10, 28, 20, 59, 0, 0, time.UTC))
	fixture := fixtureLines(t, "desktop.jsonl")
	for _, line := range fixture {
		var ev Event
		json.Unmarshal(line, &ev)
		if err := l.Emit(ev); err != nil {
			t.Fatal(err)
		}
	}
	out := lines(t, stdout.Bytes())
	if len(out) != len(fixture) {
		t.Fatalf("%d stdout lines, want %d", len(out), len(fixture))
	}
	for i := range fixture {
		if want, got := generic(t, fixture[i]), generic(t, out[i]); !reflect.DeepEqual(want, got) {
			t.Errorf("stdout line %d:\n want %s\n got  %s", i+1, fixture[i], out[i])
		}
	}
	local := dayFile(t, l, "2026-10-28")
	if len(local) != len(fixture) {
		t.Fatalf("%d local lines, want %d", len(local), len(fixture))
	}
	for i, line := range local {
		m := generic(t, line)
		if m["project"] != "notes" || m["host"] != hostID || m["host_name"] != "bam-GPU" || m["level"] == nil {
			t.Errorf("local line %d lacks project, host, host_name or level: %s", i+1, line)
		}
	}
}

func TestEveryLineItWritesValidatesAgainstTheSchema(t *testing.T) {
	v := newValidator(t)
	l, stdout, _ := newLog(t, time.Date(2026, 10, 28, 20, 41, 0, 117260411, time.UTC))
	events := everyEvent()
	for _, ev := range events {
		if err := l.Emit(ev); err != nil {
			t.Fatalf("Emit(%+v): %v", ev, err)
		}
	}
	local := dayFile(t, l, "2026-10-28")
	out := lines(t, stdout.Bytes())
	if len(local) != len(events) || len(out) != len(events) {
		t.Fatalf("%d local and %d stdout lines, want %d each", len(local), len(out), len(events))
	}
	for i := range events {
		for where, line := range map[string][]byte{"local": local[i], "stdout": out[i]} {
			if errs := v.line(line); len(errs) > 0 {
				t.Errorf("%s line %d %s: %v", where, i+1, line, errs)
			}
		}
	}
	levels := map[string]string{}
	for _, line := range local {
		m := generic(t, line)
		key := m["event"].(string)
		if m["ok"] == false {
			key += "/" + m["kind"].(string)
		}
		if m["error"] != nil {
			key += "/error"
		}
		levels[key] = m["level"].(string)
	}
	for key, want := range map[string]string{"round": "info", "round/offline": "warn", "round/error": "error", "upload": "info",
		"restore": "info", "restore/error": "error", "skip": "warn", "conflict": "warn", "hold": "warn", "synced": "info"} {
		if levels[key] != want {
			t.Errorf("level of %s is %q, want %q", key, levels[key], want)
		}
	}
	// an unknown field a caller adds survives (readers ignore what they do not know)
	if m := generic(t, local[len(local)-1]); m["bytes_per_s"] != 12.5 {
		t.Errorf("an extra field was lost: %s", local[len(local)-1])
	}
}

func TestDayFilesAreUTCDaysAndRotateAtMidnight(t *testing.T) {
	tokyo := time.FixedZone("JST", 9*3600)
	// 08:59:59 in Tokyo on the 29th is 23:59:59 UTC on the 28th
	l, _, c := newLog(t, time.Date(2026, 10, 29, 8, 59, 59, 900_000_000, tokyo))
	l.Emit(Event{Event: "round_start", Source: "timer"})
	c.set(time.Date(2026, 10, 29, 9, 0, 0, 100_000_000, tokyo))
	l.Emit(Event{Event: "round", OK: yes(), Ms: 200})
	if got := dayFile(t, l, "2026-10-28"); len(got) != 1 || generic(t, got[0])["event"] != "round_start" {
		t.Fatalf("2026-10-28.jsonl: %q", got)
	}
	if got := dayFile(t, l, "2026-10-29"); len(got) != 1 || generic(t, got[0])["event"] != "round" {
		t.Fatalf("2026-10-29.jsonl: %q", got)
	}
	// a line whose at its caller set (a --once round_start, stamped when the round began) goes in that at's day
	l.Emit(Event{Event: "round_start", At: "2026-10-28T23:59:58.5Z", Source: "once"})
	if got := dayFile(t, l, "2026-10-28"); len(got) != 2 {
		t.Fatalf("a line stamped on the 28th went elsewhere: %q", got)
	}
}

func names(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		out = append(out, e.Name())
	}
	sort.Strings(out)
	return out
}

// Kept 14 days: today's file and the 13 before it. Anything that is not a day file is never touched.
func TestDayFilesExpireAfterFourteenDays(t *testing.T) {
	l, _, c := newLog(t, time.Date(2026, 10, 28, 0, 0, 1, 0, time.UTC))
	os.MkdirAll(l.Dir, 0o700)
	for d := time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC); d.Before(time.Date(2026, 10, 28, 0, 0, 0, 0, time.UTC)); d = d.AddDate(0, 0, 1) {
		os.WriteFile(filepath.Join(l.Dir, d.Format("2006-01-02")+".jsonl"), []byte("{}\n"), 0o600)
	}
	for _, other := range []string{"notes.txt", "2026-09-01.jsonl.bak", "2026-9-1.jsonl"} {
		os.WriteFile(filepath.Join(l.Dir, other), []byte("x"), 0o600)
	}
	l.Emit(Event{Event: "round_start", Source: "start"})
	var want []string
	for d := time.Date(2026, 10, 15, 0, 0, 0, 0, time.UTC); !d.After(time.Date(2026, 10, 28, 0, 0, 0, 0, time.UTC)); d = d.AddDate(0, 0, 1) {
		want = append(want, d.Format("2006-01-02")+".jsonl")
	}
	want = append(want, "2026-09-01.jsonl.bak", "2026-9-1.jsonl", "notes.txt")
	sort.Strings(want)
	if got := names(t, l.Dir); !reflect.DeepEqual(got, want) {
		t.Fatalf("after a write on 2026-10-28:\n got  %v\n want %v", got, want)
	}
	// a writer that runs for days expires as the days turn
	c.set(time.Date(2026, 10, 29, 0, 0, 1, 0, time.UTC))
	l.Emit(Event{Event: "round_start", Source: "timer"})
	var next []string
	for _, name := range want {
		if name != "2026-10-15.jsonl" {
			next = append(next, name)
		}
	}
	want = append(next, "2026-10-29.jsonl")
	sort.Strings(want)
	if got := names(t, l.Dir); !reflect.DeepEqual(got, want) {
		t.Fatalf("after a write on 2026-10-29:\n got  %v\n want %v", got, want)
	}
}

// At most MaxDayBytes a day, then one truncated line and nothing more that day, even across a restart; stdout (the
// tray) keeps every line.
func TestTheDayCapWritesOneTruncatedLineThenNothing(t *testing.T) {
	v := newValidator(t)
	l, stdout, c := newLog(t, time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC))
	l.MaxDayBytes = 2000
	for i := 0; i < 40; i++ {
		l.Emit(Event{Event: "round", OK: yes(), Ms: int64(i), Peers: 2})
	}
	path := filepath.Join(l.Dir, "2026-10-28.jsonl")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	got := lines(t, data)
	last := got[len(got)-1]
	if generic(t, last)["event"] != "truncated" {
		t.Fatalf("the last line is not truncated: %s", last)
	}
	if n := int64(len(data) - len(last) - 1); n > 2000 {
		t.Fatalf("%d bytes before the truncated line, over the 2000 cap", n)
	}
	for i, line := range got {
		if errs := v.line(line); len(errs) > 0 {
			t.Errorf("line %d: %v", i+1, errs)
		}
		if i < len(got)-1 && generic(t, line)["event"] == "truncated" {
			t.Errorf("a second truncated line at %d", i+1)
		}
	}
	if !strings.Contains(string(last), "2000 bytes") {
		t.Errorf("the truncated line does not say the cap: %s", last)
	}
	if n := len(lines(t, stdout.Bytes())); n != 40 {
		t.Errorf("stdout has %d lines, want all 40", n)
	}
	// a restart the same day writes nothing more
	again := &Log{Dir: l.Dir, Project: "notes", Host: hostID, HostName: "bam-GPU", Now: c.now, MaxDayBytes: 2000}
	again.Emit(Event{Event: "round_start", Source: "start"})
	if after, _ := os.ReadFile(path); !bytes.Equal(after, data) {
		t.Fatalf("a restart wrote past the cap:\n%s", after[len(data):])
	}
	// the next day logs again
	c.set(time.Date(2026, 10, 29, 0, 0, 0, 0, time.UTC))
	again.Emit(Event{Event: "round_start", Source: "timer"})
	if got := dayFile(t, again, "2026-10-29"); len(got) != 1 {
		t.Fatalf("2026-10-29.jsonl: %q", got)
	}
}

func TestTheDefaultCapIsTwentyMegabytes(t *testing.T) {
	if MaxDayBytes != 20<<20 || KeepDays != 14 {
		t.Fatalf("MaxDayBytes %d, KeepDays %d", MaxDayBytes, KeepDays)
	}
	l, _, _ := newLog(t, time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC))
	os.MkdirAll(l.Dir, 0o700)
	path := filepath.Join(l.Dir, "2026-10-28.jsonl")
	os.WriteFile(path, bytes.Repeat([]byte("{}\n"), (20<<20)/3), 0o600)
	l.Emit(Event{Event: "round_start", Source: "start"})
	got := dayFile(t, l, "2026-10-28")
	if m := generic(t, got[len(got)-1]); m["event"] != "truncated" || !strings.Contains(m["why"].(string), "20 MB") {
		t.Fatalf("at 20 MB: %v", m)
	}
}

// No line ever holds a key or a token: every why goes through the scrub, and a field named like a secret is dropped.
func TestWhyIsScrubbedAndSecretFieldsAreDropped(t *testing.T) {
	l, stdout, _ := newLog(t, time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC))
	l.Emit(Event{Event: "round", OK: no(), Kind: "error", Why: "PUT failed with " + secret})
	l.Emit(map[string]any{"event": "hub", "hub": "connected", "token": "tok-abc", "session_token": "tok-def",
		"secret_access_key": "s", "access_key_id": "k", "Authorization": "Bearer x", "peer_name": "web"})
	local, _ := os.ReadFile(filepath.Join(l.Dir, "2026-10-28.jsonl"))
	for where, data := range map[string][]byte{"stdout": stdout.Bytes(), "local": local} {
		for _, leak := range []string{secret, "tok-abc", "tok-def", `"secret_access_key"`, `"access_key_id"`, "Bearer"} {
			if bytes.Contains(data, []byte(leak)) {
				t.Errorf("%s holds %q:\n%s", where, leak, data)
			}
		}
		if !bytes.Contains(data, []byte("[redacted]")) || !bytes.Contains(data, []byte(`"peer_name":"web"`)) {
			t.Errorf("%s lost the scrubbed why or a plain field:\n%s", where, data)
		}
	}
}

func TestEmitRefusesALineWithoutAnEventAndANilLogIsSilent(t *testing.T) {
	l, stdout, _ := newLog(t, time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC))
	if err := l.Emit(Event{Source: "start"}); err == nil {
		t.Fatal("an event without a name was written")
	}
	if err := l.Emit(42); err == nil {
		t.Fatal("a number was written")
	}
	if stdout.Len() != 0 {
		t.Fatalf("stdout: %q", stdout.String())
	}
	var none *Log
	if err := none.Emit(Event{Event: "stopped"}); err != nil {
		t.Fatal(err)
	}
	stdoutOnly := &Log{Stdout: stdout}
	stdoutOnly.Emit(Event{Event: "stopped"})
	if !strings.Contains(stdout.String(), `"event":"stopped"`) {
		t.Fatalf("a Log without a Dir still prints: %q", stdout.String())
	}
}

func TestDirIsInsideTheStateDir(t *testing.T) {
	if got := Dir(filepath.Join("home", ".folder-sync", "projects", "notes-1a2b3c4d")); got != filepath.Join("home", ".folder-sync", "projects", "notes-1a2b3c4d", "log") {
		t.Fatalf("Dir: %q", got)
	}
}

// The hub reports from its own goroutine: lines never interleave.
func TestConcurrentEmitsWriteWholeLines(t *testing.T) {
	l, _, _ := newLog(t, time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC))
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				l.Emit(Event{Event: "hub", Hub: "connected", Why: strings.Repeat("x", 300)})
			}
		}()
	}
	wg.Wait()
	got := dayFile(t, l, "2026-10-28")
	if len(got) != 400 {
		t.Fatalf("%d lines, want 400", len(got))
	}
	for _, line := range got {
		generic(t, line)
	}
}
