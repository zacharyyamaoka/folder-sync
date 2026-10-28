// Package trace writes timing events as JSON lines, for latency measurement.
//
// WHY (fast-sync, 2026-10-26): a round's log line says only `took=`; to show Zach where each second of a sync goes,
// every step and every rclone process is stamped in epoch milliseconds, the same clock the measurement harness and
// the page use. Off unless FOLDER_SYNC_TRACE names a file; it never changes what a round does.
package trace

import (
	"encoding/json"
	"os"
	"sync"
	"time"
)

// Env names the file trace events are appended to.
const Env = "FOLDER_SYNC_TRACE"

// Writer appends events; a nil *Writer is a no-op.
type Writer struct {
	mu   sync.Mutex
	file *os.File
}

// Open returns a Writer for path, or nil when path is empty or cannot be opened.
func Open(path string) *Writer {
	if path == "" {
		return nil
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return nil
	}
	return &Writer{file: f}
}

// Event writes {"t": now ms, "ev": ev, ...fields}.
func (w *Writer) Event(ev string, fields map[string]any) {
	if w == nil {
		return
	}
	rec := map[string]any{"t": time.Now().UnixMilli(), "ev": ev}
	for k, v := range fields {
		rec[k] = v
	}
	line, _ := json.Marshal(rec)
	w.mu.Lock()
	defer w.mu.Unlock()
	w.file.Write(append(line, '\n'))
}

// Since writes ev with its start time and duration in ms.
func (w *Writer) Since(ev string, start time.Time, fields map[string]any) {
	if w == nil {
		return
	}
	if fields == nil {
		fields = map[string]any{}
	}
	fields["start"] = start.UnixMilli()
	fields["ms"] = float64(time.Since(start).Microseconds()) / 1000
	w.Event(ev, fields)
}
