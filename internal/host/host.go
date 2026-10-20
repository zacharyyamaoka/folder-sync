// Package host mints and loads this machine's host id.
//
// docs/peps/0001 §3: the host id is a UUID minted on the machine's first init
// and kept in ~/.folder-sync/host.json, never in a project's config, with a
// readable name beside it.
package host

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

// Schema names the host.json format.
const Schema = "folder-sync-host/1"

// Host is ~/.folder-sync/host.json.
type Host struct {
	Schema    string `json:"schema"`
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt string `json:"created_at"`
}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// IsID reports whether s is a host id (a lowercase UUID v4).
func IsID(s string) bool { return uuidPattern.MatchString(s) }

// NewID returns a random UUID v4.
func NewID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// Load reads the host file.
func Load(path string) (Host, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Host{}, fmt.Errorf("this machine has no host id yet (%s): run `folder-sync init` first", path)
	}
	if err != nil {
		return Host{}, err
	}
	var h Host
	if err := json.Unmarshal(data, &h); err != nil {
		return Host{}, fmt.Errorf("%s: %w", path, err)
	}
	if !IsID(h.ID) {
		return Host{}, fmt.Errorf("%s: %q is not a host id", path, h.ID)
	}
	return h, nil
}

// Ensure loads the host file, minting it on first use. minted is true when it was created now.
func Ensure(path string) (h Host, minted bool, err error) {
	if h, err := Load(path); err == nil {
		return h, false, nil
	} else if _, statErr := os.Stat(path); statErr == nil {
		// It exists: either another first run just created it, or it is corrupt.
		// Re-read once; never silently re-mint over a file that is there.
		h, err := Load(path)
		return h, false, err
	}
	id, err := NewID()
	if err != nil {
		return Host{}, false, err
	}
	name, _ := os.Hostname()
	if name == "" {
		name = "host"
	}
	h = Host{Schema: Schema, ID: id, Name: name, CreatedAt: time.Now().UTC().Format(time.RFC3339)}
	data, _ := json.MarshalIndent(h, "", "  ")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return Host{}, false, err
	}
	// Write a private temp file, then hard-link it into place: the link fails if
	// host.json already exists, so two first runs racing can never mint two ids,
	// and a reader never sees a half-written file.
	tmp, err := os.CreateTemp(filepath.Dir(path), "host-*.tmp")
	if err != nil {
		return Host{}, false, err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return Host{}, false, err
	}
	if err := tmp.Close(); err != nil {
		return Host{}, false, err
	}
	if err := os.Link(tmp.Name(), path); err != nil {
		if errors.Is(err, os.ErrExist) {
			h, err := Load(path)
			return h, false, err
		}
		return Host{}, false, err
	}
	return h, true, nil
}
