package main

// `sync --watch --events`: one folder-sync-event/1 JSON object per line on stdout, for an app (the desktop app's
// tray, docs/peps/0006) to show what the engine is doing without parsing human text. The human lines go to stderr.
// Every sync, --once or --watch, also writes the same lines to the folder's local log (internal/synclog, PEP 0007 §4).

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"folder-sync/internal/account"
	"folder-sync/internal/creds"
	"folder-sync/internal/syncer"
	"folder-sync/internal/synclog"
)

// EventSchema names `sync --events`' lines.
const EventSchema = synclog.Schema

// Error kinds a failed round is sorted into. WHY these four: they are the tray's states (PEP 0006) — the person can
// act on "signed out" (sign in) and "over quota" (delete files, see Why), waits out "offline", and reads the rest.
const (
	KindSignedOut = "signed_out"
	KindOverQuota = "over_quota"
	KindOffline   = "offline"
	KindError     = "error"
)

// syncEvent is one folder-sync-event/1 line (internal/synclog, PEP 0007 §4): the desktop app's events here, the file
// events from the round.
type syncEvent = synclog.Event

// eventWriter is the activity log of the folder a sync runs: its local day files (~/.folder-sync/projects/<key>/log/)
// and, with --events, stdout. Safe from several goroutines (the hub reports from its own). A nil writer drops
// everything; one built with only out (and now) prints and keeps no local log.
type eventWriter struct {
	out  io.Writer
	now  func() time.Time
	log  *synclog.Log
	once sync.Once
}

// newEventWriter writes the folder's local log, and stdout when it is not nil (--events).
// WHY the scrub reads p.Creds at each line: a short-lived key rolls over between rounds (Project.refreshCreds).
func newEventWriter(p *syncer.Project, stdout io.Writer) *eventWriter {
	return &eventWriter{out: stdout, log: &synclog.Log{Dir: synclog.Dir(p.StateDir), Stdout: stdout, Project: p.Config.Project,
		Host: p.Host.ID, HostName: p.Host.Name, Scrub: func(text string) string { return p.Creds.Scrub(text) }}}
}

func (w *eventWriter) emit(ev syncEvent) {
	if w == nil {
		return
	}
	w.once.Do(func() {
		if w.log == nil {
			w.log = &synclog.Log{Stdout: w.out, Now: w.now}
		}
	})
	w.log.Emit(ev)
}

// onceRound logs a `sync --once` round as `--watch` logs each of its rounds: round_start, stamped when it began, then
// round. A round that never ran (another holds the folder lock, exit 75) logs nothing: that round's writer logs it.
// WHY classify and not classifyRound: the probe dials each endpoint for up to 3 s, and --once is what scripts and
// `vt sync now` wait on.
func (w *eventWriter) onceRound(started time.Time, result syncer.Result, err error) {
	if errors.Is(err, syncer.ErrBusy) {
		return
	}
	w.emit(syncEvent{Event: "round_start", At: started.UTC().Format(time.RFC3339Nano), Source: "once"})
	w.fileEvents(result)
	ms := time.Since(started).Milliseconds()
	if err != nil {
		kind, why := classify(err)
		w.emit(syncEvent{Event: "round", OK: boolPtr(false), Kind: kind, Why: why, Ms: ms})
		return
	}
	w.emit(syncEvent{Event: "round", OK: boolPtr(true), Uploaded: len(result.Uploaded), Deleted: len(result.Deleted),
		Fetched: fetched(result), Peers: len(result.Peers), Ms: ms})
}

var offlinePattern = regexp.MustCompile(`(?i)did not answer|connection refused|no such host|network is unreachable|i/o timeout|dial tcp|context deadline exceeded|no route to host|temporary failure in name resolution|connection reset`)

// classify sorts a failed round's error into a kind and the reason to show.
func classify(err error) (kind, why string) {
	if err == nil {
		return "", ""
	}
	msg := err.Error()
	var quota *account.OverQuotaError
	var readOnly *syncer.ReadOnlyError
	switch {
	case errors.Is(err, creds.ErrSignedOut), errors.Is(err, account.ErrSignedOut), errors.Is(err, account.ErrNotSignedIn):
		return KindSignedOut, msg
	case errors.As(err, &quota):
		return KindOverQuota, quota.Why
	// WHY: since PEP 0003 §3.7 an account over its quota gets read-only keys rather than a refusal, and the round
	// reports its held uploads as a ReadOnlyError; before the offline check, because a delete it could not finish may
	// wrap a refused connection (found by the desktop proof after the v0 merge, 2026-10-28)
	case errors.As(err, &readOnly):
		if readOnly.Reason != "" {
			return KindOverQuota, readOnly.Reason
		}
		return KindOverQuota, readOnly.Error()
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

// probeTimeout bounds the reachability check a failed round makes.
const probeTimeout = 3 * time.Second

// unreachable dials each endpoint (an http(s) URL) and returns the first that does not answer, with why.
// WHY a dial and not only the error text: rclone words a refused connection in ways that do not say so (its S3
// backend reports "is a file not a directory" when the HEAD it uses to tell files from folders fails), so a round's
// error alone cannot tell "the server is down" from "something is wrong"; one TCP dial can.
func unreachable(dial func(network, address string, timeout time.Duration) (net.Conn, error), endpoints ...string) (string, bool) {
	for _, endpoint := range endpoints {
		u, err := url.Parse(endpoint)
		if err != nil || u.Host == "" {
			continue
		}
		host := u.Host
		if u.Port() == "" {
			if u.Scheme == "http" || u.Scheme == "ws" {
				host = net.JoinHostPort(u.Hostname(), "80")
			} else {
				host = net.JoinHostPort(u.Hostname(), "443")
			}
		}
		conn, err := dial("tcp", host, probeTimeout)
		if err != nil {
			return fmt.Sprintf("%s does not answer (%v)", u.Host, err), true
		}
		conn.Close()
	}
	return "", false
}

// classifyRound is classify, plus: an unrecognised failure while the storage or account server does not answer is
// offline.
func classifyRound(err error, endpoints ...string) (kind, why string) {
	kind, why = classify(err)
	if kind == KindError {
		if reason, down := unreachable(net.DialTimeout, endpoints...); down {
			return KindOffline, reason
		}
	}
	return kind, why
}
