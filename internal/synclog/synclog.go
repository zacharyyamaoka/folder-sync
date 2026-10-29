// Package synclog writes folder-sync's activity log: one line format, folder-sync-event/1 (docs/CONTRACT.md, "The
// activity log"; schema/event.schema.json), for `sync --events` on stdout (the desktop app's tray) and for each
// folder's local log, ~/.folder-sync/projects/<key>/log/<YYYY-MM-DD>.jsonl: UTC days, kept 14 days, at most 20 MB a
// day, then one `truncated` line and nothing more that day. The engine's change records carry the same events online.
// The design is docs/peps/0007 §4.
package synclog

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Schema names every line.
const Schema = "folder-sync-event/1"

const (
	// KeepDays is how many day files a folder keeps: today's and the 13 before it.
	KeepDays = 14
	// MaxDayBytes caps one day's file; the line that would pass it becomes the day's one `truncated` line.
	MaxDayBytes = 20 << 20
)

// Event is one line. The first block is the desktop app's events (watching, round_start, round, hub, stopped; PEP
// 0006), in the order `sync --events` has always printed them; the rest are PEP 0007's file events. A field a
// caller sets that Event does not name rides in Extra (readers ignore fields they do not know).
type Event struct {
	Schema   string `json:"schema"`
	Event    string `json:"event"`
	At       string `json:"at"` // RFC 3339 UTC; Emit stamps it when empty
	Level    string `json:"level,omitempty"`
	Folder   string `json:"folder,omitempty"`
	Project  string `json:"project,omitempty"`
	Host     string `json:"host,omitempty"`
	HostName string `json:"host_name,omitempty"`
	Seq      int64  `json:"seq,omitempty"`
	Watcher  *bool  `json:"watcher,omitempty"`
	Hub      string `json:"hub,omitempty"` // on | off | connected | closed
	Source   string `json:"source,omitempty"`
	OK       *bool  `json:"ok,omitempty"`
	Uploaded int    `json:"uploaded,omitempty"`
	Deleted  int    `json:"deleted,omitempty"`
	Fetched  int    `json:"fetched,omitempty"`
	Peers    int    `json:"peers,omitempty"`
	Ms       int64  `json:"ms,omitempty"`
	Kind     string `json:"kind,omitempty"` // signed_out | over_quota | offline | error
	Why      string `json:"why,omitempty"`  // always scrubbed

	Path      string `json:"path,omitempty"`
	Size      *int64 `json:"size,omitempty"` // a pointer: an empty file's upload says size 0
	SHA256    string `json:"sha256,omitempty"`
	Op        string `json:"op,omitempty"` // add | edit
	Was       *Was   `json:"was,omitempty"`
	Permanent bool   `json:"permanent,omitempty"`
	From      string `json:"from,omitempty"`    // the version a restore wrote back
	Request   string `json:"request,omitempty"` // the restore request it answered
	Error     string `json:"error,omitempty"`   // pruned | mismatch | failed
	Peer      string `json:"peer,omitempty"`
	PeerName  string `json:"peer_name,omitempty"`
	PeerSeq   int64  `json:"peer_seq,omitempty"`
	KeptAt    string `json:"kept_at,omitempty"`
	Count     int    `json:"count,omitempty"`
	UpMs      *int64 `json:"up_ms,omitempty"`   // disk to online; absent when not seen
	DownMs    *int64 `json:"down_ms,omitempty"` // online to disk, two clocks: may be negative, never clamped

	Extra map[string]json.RawMessage `json:"-"`
}

// Was is the version that left the folder, and where it went: Kept is its version id under _history/, or nil (null)
// when it was not kept, and then Why says which rule.
type Was struct {
	SHA256    string  `json:"sha256"`
	Size      int64   `json:"size"`
	WrittenAt string  `json:"written_at"`
	Kept      *string `json:"kept"`
	Why       string  `json:"why,omitempty"` // burst | no_history | key_too_long | permanent
}

// plain is Event without its methods, for the standard encoding of the named fields.
type plain Event

// known is every JSON name Event's fields carry.
var known = func() map[string]bool {
	names := map[string]bool{}
	t := reflect.TypeOf(plain{})
	for i := 0; i < t.NumField(); i++ {
		name, _, _ := strings.Cut(t.Field(i).Tag.Get("json"), ",")
		if name != "" && name != "-" {
			names[name] = true
		}
	}
	return names
}()

// MarshalJSON writes the named fields in their order, then Extra's sorted by name.
func (e Event) MarshalJSON() ([]byte, error) {
	data, err := json.Marshal(plain(e))
	if err != nil || len(e.Extra) == 0 {
		return data, err
	}
	keys := make([]string, 0, len(e.Extra))
	for k := range e.Extra {
		if !known[k] {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	var buf bytes.Buffer
	buf.Write(data[:len(data)-1])
	for _, k := range keys {
		name, _ := json.Marshal(k)
		buf.WriteByte(',')
		buf.Write(name)
		buf.WriteByte(':')
		buf.Write(e.Extra[k])
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// UnmarshalJSON reads the named fields, and keeps every other one in Extra.
func (e *Event) UnmarshalJSON(data []byte) error {
	var p plain
	if err := json.Unmarshal(data, &p); err != nil {
		return err
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(data, &all); err != nil {
		return err
	}
	for k := range all {
		if known[k] {
			delete(all, k)
		}
	}
	if len(all) == 0 {
		all = nil
	}
	*e = Event(p)
	e.Extra = all
	return nil
}

// desktop are the events `sync --events` printed before PEP 0007. On stdout they stay exactly as they were (the
// tray reads them; CONTRACT "The activity log"); only the local log adds project, host, host_name and level.
var desktop = map[string]bool{"watching": true, "round_start": true, "round": true, "hub": true, "stopped": true}

// secretName matches a field named like a key or a token: the writer drops it (PEP 0007 §4, "Nothing secret gets in").
var secretName = regexp.MustCompile(`(?i)token|secret|password|passwd|credential|authorization|cookie|(^|_)key(_|$)|apikey`)

// Dir is a folder's log directory inside its state dir (~/.folder-sync/projects/<key>/).
func Dir(stateDir string) string { return filepath.Join(stateDir, "log") }

// dayName matches a day file's name, and only that: nothing else in the directory is ever expired.
var dayName = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})\.jsonl$`)

// Log writes events to Stdout (when set) and to the day files in Dir (when set). It is safe from several goroutines
// (the hub reports from its own). The folder lock keeps it to one writer per folder (whatever runs the round); a
// second writer between rounds still appends whole lines, and the cap is read from the file, not remembered.
// A nil Log drops everything.
type Log struct {
	Dir      string    // ~/.folder-sync/projects/<key>/log ("" = no local log)
	Stdout   io.Writer // `sync --events` (nil = none)
	Project  string    // added to every local line that lacks them
	Host     string
	HostName string
	// Scrub removes keys and tokens from a why (the engine's Creds.Scrub). Nil leaves it as is.
	Scrub       func(string) string
	Now         func() time.Time // nil = time.Now
	MaxDayBytes int64            // 0 = MaxDayBytes

	mu        sync.Mutex
	day       string // the day file last written, so expiry runs once per day
	truncated string // the day whose truncated line is known to be written
}

// Emit writes one event: an Event, a *Event, or any value whose JSON is an object with an "event" (the engine's own
// types; their fields Event does not name are kept). Schema is set, At stamped when empty, Why scrubbed, and fields
// named like secrets dropped. The local line also gets project, host, host_name and level. A failure to write the
// local log is returned, after stdout has its line: a round never waits on its log.
func (l *Log) Emit(v any) error {
	if l == nil {
		return nil
	}
	ev, err := toEvent(v)
	if err != nil {
		return err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	ev.Schema = Schema
	at := l.now().UTC()
	if ev.At == "" {
		ev.At = at.Format(time.RFC3339Nano)
	} else if t, err := time.Parse(time.RFC3339Nano, ev.At); err == nil {
		at = t.UTC()
	}
	if ev.Why != "" && l.Scrub != nil {
		ev.Why = l.Scrub(ev.Why)
	}
	for k := range ev.Extra {
		if secretName.MatchString(k) {
			delete(ev.Extra, k)
		}
	}
	local := l.enrich(ev)
	if l.Stdout != nil {
		out := local
		if desktop[ev.Event] {
			out = ev
		}
		if data, err := json.Marshal(out); err == nil {
			l.Stdout.Write(append(data, '\n'))
		}
	}
	if l.Dir == "" {
		return nil
	}
	return l.write(at, local)
}

func toEvent(v any) (Event, error) {
	var ev Event
	switch x := v.(type) {
	case Event:
		ev = x
	case *Event:
		if x != nil {
			ev = *x
		}
	default:
		data, err := json.Marshal(v)
		if err != nil {
			return Event{}, err
		}
		if err := json.Unmarshal(data, &ev); err != nil {
			return Event{}, fmt.Errorf("an event must be a JSON object: %w", err)
		}
	}
	if ev.Event == "" {
		return Event{}, errors.New("an event needs a name (event)")
	}
	if ev.Extra != nil {
		extra := make(map[string]json.RawMessage, len(ev.Extra))
		for k, raw := range ev.Extra {
			extra[k] = raw
		}
		ev.Extra = extra
	}
	return ev, nil
}

func (l *Log) now() time.Time {
	if l.Now != nil {
		return l.Now()
	}
	return time.Now()
}

// enrich is the local log's line: project, host, host_name and level filled in.
func (l *Log) enrich(ev Event) Event {
	if ev.Project == "" {
		ev.Project = l.Project
	}
	if ev.Host == "" {
		ev.Host = l.Host
	}
	if ev.HostName == "" {
		ev.HostName = l.HostName
	}
	if ev.Level == "" {
		ev.Level = levelOf(ev)
	}
	return ev
}

// levelOf is an event's level when its caller set none. The schema fixes warn for skip, conflict, hold and truncated,
// and error for a failed restore. WHY a failed round offline is only a warning: the view is never red for offline
// (docs/API.md, status); it waits it out, as the tray does.
func levelOf(ev Event) string {
	switch {
	case ev.Event == "skip", ev.Event == "conflict", ev.Event == "hold", ev.Event == "truncated":
		return "warn"
	case ev.Event == "restore" && ev.Error != "":
		return "error"
	case ev.Event == "round" && ev.OK != nil && !*ev.OK:
		if ev.Kind == "offline" {
			return "warn"
		}
		return "error"
	}
	return "info"
}

// write appends ev to its UTC day's file, expiring old days when the day is new to this writer, and enforcing the cap.
func (l *Log) write(at time.Time, ev Event) error {
	day := at.Format("2006-01-02")
	if err := os.MkdirAll(l.Dir, 0o700); err != nil {
		return err
	}
	if day != l.day {
		l.expire(at)
		l.day = day
	}
	data, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	path := filepath.Join(l.Dir, day+".jsonl")
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	limit := l.MaxDayBytes
	if limit <= 0 {
		limit = MaxDayBytes
	}
	if info.Size()+int64(len(data)) <= limit {
		_, err = f.Write(data)
		return err
	}
	if l.truncated == day || endsTruncated(path, info.Size()) {
		l.truncated = day
		return nil
	}
	l.truncated = day
	line, err := json.Marshal(Event{Schema: Schema, Event: "truncated", At: ev.At, Level: "warn", Project: ev.Project,
		Host: ev.Host, HostName: ev.HostName, Why: fmt.Sprintf("this day's log reached %s; the rest of the day is not logged", size(limit))})
	if err != nil {
		return err
	}
	_, err = f.Write(append(line, '\n'))
	return err
}

// endsTruncated reports whether the file's last line is a truncated line (another writer, or this one before a
// restart, already wrote it).
func endsTruncated(path string, n int64) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	const tail = 4096
	from := n - tail
	if from < 0 {
		from = 0
	}
	buf := make([]byte, n-from)
	if _, err := f.ReadAt(buf, from); err != nil && !errors.Is(err, io.EOF) {
		return false
	}
	buf = bytes.TrimRight(buf, "\n")
	if i := bytes.LastIndexByte(buf, '\n'); i >= 0 {
		buf = buf[i+1:]
	}
	var last struct {
		Event string `json:"event"`
	}
	return json.Unmarshal(buf, &last) == nil && last.Event == "truncated"
}

func size(n int64) string {
	if n%(1<<20) == 0 {
		return fmt.Sprintf("%d MB", n>>20)
	}
	return fmt.Sprintf("%d bytes", n)
}

// expire deletes the day files older than KeepDays days before at's day. Only names that are a day file are touched.
func (l *Log) expire(at time.Time) {
	entries, err := os.ReadDir(l.Dir)
	if err != nil {
		return
	}
	today := time.Date(at.Year(), at.Month(), at.Day(), 0, 0, 0, 0, time.UTC)
	oldest := today.AddDate(0, 0, -(KeepDays - 1))
	for _, entry := range entries {
		m := dayName.FindStringSubmatch(entry.Name())
		if m == nil || entry.IsDir() {
			continue
		}
		day, err := time.Parse("2006-01-02", m[1])
		if err != nil || !day.Before(oldest) {
			continue
		}
		os.Remove(filepath.Join(l.Dir, entry.Name()))
	}
}
