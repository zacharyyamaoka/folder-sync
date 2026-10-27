package main

// `sync --watch --events`: one folder-sync-event/1 JSON object per line on stdout, for an app (the desktop app's
// tray, docs/peps/0005) to show what the engine is doing without parsing human text. The human lines go to stderr.

import (
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strings"
	"sync"
	"time"

	"folder-sync/internal/account"
	"folder-sync/internal/creds"
)

// EventSchema names `sync --events`' lines.
const EventSchema = "folder-sync-event/1"

// Error kinds a failed round is sorted into. WHY these four: they are the tray's states (PEP 0005) — the person can
// act on "signed out" (sign in) and "over quota" (delete files, see Why), waits out "offline", and reads the rest.
const (
	KindSignedOut = "signed_out"
	KindOverQuota = "over_quota"
	KindOffline   = "offline"
	KindError     = "error"
)

type syncEvent struct {
	Schema   string `json:"schema"`
	Event    string `json:"event"` // watching | round_start | round | hub | stopped
	At       string `json:"at"`
	Folder   string `json:"folder,omitempty"`
	Project  string `json:"project,omitempty"`
	Host     string `json:"host,omitempty"`
	Watcher  *bool  `json:"watcher,omitempty"`
	Hub      string `json:"hub,omitempty"` // on | off | connected | closed
	Source   string `json:"source,omitempty"`
	OK       *bool  `json:"ok,omitempty"`
	Uploaded int    `json:"uploaded,omitempty"`
	Deleted  int    `json:"deleted,omitempty"`
	Fetched  int    `json:"fetched,omitempty"`
	Peers    int    `json:"peers,omitempty"`
	Ms       int64  `json:"ms,omitempty"`
	Kind     string `json:"kind,omitempty"`
	Why      string `json:"why,omitempty"`
}

// eventWriter is safe from several goroutines (the hub reports from its own). A nil writer drops everything.
type eventWriter struct {
	mu  sync.Mutex
	out io.Writer
	now func() time.Time
}

func (w *eventWriter) emit(ev syncEvent) {
	if w == nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	ev.Schema = EventSchema
	now := time.Now
	if w.now != nil {
		now = w.now
	}
	ev.At = now().UTC().Format(time.RFC3339Nano)
	data, _ := json.Marshal(ev)
	w.out.Write(append(data, '\n'))
}

var offlinePattern = regexp.MustCompile(`(?i)did not answer|connection refused|no such host|network is unreachable|i/o timeout|dial tcp|context deadline exceeded|no route to host|temporary failure in name resolution|connection reset`)

// classify sorts a failed round's error into a kind and the reason to show.
func classify(err error) (kind, why string) {
	if err == nil {
		return "", ""
	}
	msg := err.Error()
	var quota *account.OverQuotaError
	switch {
	case errors.Is(err, creds.ErrSignedOut), errors.Is(err, account.ErrSignedOut), errors.Is(err, account.ErrNotSignedIn):
		return KindSignedOut, msg
	case errors.As(err, &quota):
		return KindOverQuota, quota.Why
	}
	// The credential process's failure reaches us as its last stderr line (internal/creds), so over quota is read
	// from `credentials`' fixed prefix.
	if i := strings.Index(msg, account.OverQuotaPrefix); i >= 0 {
		return KindOverQuota, strings.TrimSpace(msg[i+len(account.OverQuotaPrefix):])
	}
	if offlinePattern.MatchString(msg) {
		return KindOffline, msg
	}
	return KindError, msg
}

func boolPtr(b bool) *bool { return &b }
