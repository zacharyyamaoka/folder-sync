package history

import (
	"fmt"
	"strings"
	"time"

	"folder-sync/internal/synclog"
)

// Record schemas.
const (
	ChangesSchema = "folder-sync-changes/1"
	PullsSchema   = "folder-sync-pulls/1"
	RestoreSchema = "folder-sync-restore/1"
)

// ChangesPrefix is <root>_changes/<project>/<host>/: a host's change records, and its pull records under pulls/.
func ChangesPrefix(root, project, host string) string {
	return root + "_changes/" + project + "/" + host + "/"
}

// ChangesKey is <root>_changes/<project>/<host>/<seq, 12 digits>.json.
func ChangesKey(root, project, host string, seq int64) string {
	return fmt.Sprintf("%s%012d.json", ChangesPrefix(root, project, host), seq)
}

// PullsKey is <root>_changes/<project>/<host>/pulls/<at>.json, at to the millisecond.
func PullsKey(root, project, host, at string) string {
	return ChangesPrefix(root, project, host) + "pulls/" + at + ".json"
}

// RequestsPrefix is <root>_requests/<project>/<host>/: the restores that host is asked to make.
func RequestsPrefix(root, project, host string) string {
	return root + "_requests/" + project + "/" + host + "/"
}

// RequestKey is <root>_requests/<project>/<host>/<id>.json.
func RequestKey(root, project, host, id string) string {
	return RequestsPrefix(root, project, host) + id + ".json"
}

// TrashPrefix is legacy <root>_trash/<project>/<host>/, which the pruner expires 30 days after each stamp.
func TrashPrefix(root, project, host string) string {
	return root + "_trash/" + project + "/" + host + "/"
}

// ChangeRecord is what one manifest version changed (schema/changes.schema.json).
type ChangeRecord struct {
	Schema   string          `json:"schema"`
	Project  string          `json:"project"`
	HostID   string          `json:"host_id"`
	HostName string          `json:"host_name"`
	Seq      int64           `json:"seq"`
	At       string          `json:"at"` // the manifest's generated_at
	By       string          `json:"by"` // machine | web | server
	Via      string          `json:"via,omitempty"`
	Events   []synclog.Event `json:"events"` // upload, delete and restore, in path order
}

// PullRecord is the peer files one machine wrote or removed in one round (schema/pulls.schema.json).
type PullRecord struct {
	Schema   string          `json:"schema"`
	Project  string          `json:"project"`
	HostID   string          `json:"host_id"`
	HostName string          `json:"host_name"`
	At       string          `json:"at"`     // the round's end, to the millisecond
	Events   []synclog.Event `json:"events"` // download and remove_copy, in (peer, path) order
}

// Request is a restore a host is asked to make (schema/restore.schema.json).
type Request struct {
	Schema  string        `json:"schema"`
	ID      string        `json:"id"`
	Project string        `json:"project"`
	Host    string        `json:"host"`
	At      string        `json:"at"`
	By      RequestBy     `json:"by"`
	Items   []RequestItem `json:"items"`
	Outcome *Outcome      `json:"outcome,omitempty"`
}

// RequestBy is who asked.
type RequestBy struct {
	Kind string `json:"kind"` // web | machine
	Name string `json:"name"`
	Host string `json:"host,omitempty"`
}

// RequestItem is one path and the version to put back.
type RequestItem struct {
	Path    string `json:"path"`
	Version string `json:"version"`
}

// Outcome is written into the request by the host it names, once it ran.
type Outcome struct {
	At      string   `json:"at"`
	Seq     int64    `json:"seq,omitempty"` // the manifest that published the restored files; absent when none did
	Results []Result `json:"results"`
}

// Result is one item's outcome, in item order.
type Result struct {
	Path    string `json:"path"`
	Version string `json:"version"`
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"` // pruned | mismatch | failed
	Why     string `json:"why,omitempty"`
}

// Restore errors (the outcome's and the restore event's error).
const (
	ErrPruned   = "pruned"
	ErrMismatch = "mismatch"
	ErrFailed   = "failed"
)

// MaxItems is how many items one request may carry.
const MaxItems = 1000

// Check validates a request read from the bucket or a local requests/ folder before anything acts on it: it must be
// for project and host, and every item a published path and a version id.
func (r Request) Check(project, host string) error {
	switch {
	case r.Schema != RestoreSchema:
		return fmt.Errorf("restore request schema %q, want %q", r.Schema, RestoreSchema)
	case !hostID.MatchString(r.ID):
		return fmt.Errorf("restore request id %q is not a UUID v4", r.ID)
	case r.Project != project || r.Host != host:
		return fmt.Errorf("restore request %s is for %s/%s, not %s/%s", r.ID, r.Project, r.Host, project, host)
	case len(r.Items) == 0 || len(r.Items) > MaxItems:
		return fmt.Errorf("restore request %s has %d items (1 to %d)", r.ID, len(r.Items), MaxItems)
	}
	if _, err := time.Parse(time.RFC3339Nano, r.At); err != nil {
		return fmt.Errorf("restore request %s at %q: %w", r.ID, r.At, err)
	}
	for _, item := range r.Items {
		if err := checkPath(item.Path); err != nil {
			return fmt.Errorf("restore request %s: %q: %w", r.ID, item.Path, err)
		}
		if !ValidVersionID(item.Version) {
			return fmt.Errorf("restore request %s: %q is not a version id", r.ID, item.Version)
		}
	}
	return nil
}

// TrashStampAge reads a legacy _trash/ key's <UTC-stamp> (YYYYMMDDTHHMMSSZ, with the engine's or the web host's
// suffix after it) as a time; ok is false for a key that has none.
func TrashStampAge(key, prefix string) (time.Time, bool) {
	rest := strings.TrimPrefix(key, prefix)
	if len(rest) < 16 || rest == key {
		return time.Time{}, false
	}
	t, err := time.Parse("20060102T150405Z", rest[:16])
	return t, err == nil
}
