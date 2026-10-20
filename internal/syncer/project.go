// Package syncer runs folder-sync rounds: push this machine's changes, pull
// peers' changes, and write last-sync.json (docs/peps/0001 §4-§5).
package syncer

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"folder-sync/internal/config"
	"folder-sync/internal/creds"
	"folder-sync/internal/host"
	"folder-sync/internal/layout"
	"folder-sync/internal/manifest"
	"folder-sync/internal/rclone"
	"folder-sync/internal/s3"
)

// ReconcileEvery is how often a full listing reconcile runs (docs/peps/0001 §4: "at start and hourly").
const ReconcileEvery = time.Hour

// Registration is projects/<key>/project.json: which folder a state dir belongs to.
type Registration struct {
	Schema       string `json:"schema"`
	Project      string `json:"project"`
	Bucket       string `json:"bucket"`
	Folder       string `json:"folder"`
	HostID       string `json:"host_id"`
	RegisteredAt string `json:"registered_at"`
}

// RegistrationSchema names project.json.
const RegistrationSchema = "folder-sync-project/1"

// StateKey names a project folder's state dir: the project plus a hash of the folder's path,
// so two clones of one project on a machine never share state.
func StateKey(project, folder string) string {
	sum := sha256.Sum256([]byte(folder))
	return project + "-" + hex.EncodeToString(sum[:])[:8]
}

// Project is one synced folder on this machine, ready to run rounds.
type Project struct {
	Folder   string
	Config   config.Config
	Layout   layout.Layout
	Host     host.Host
	Creds    creds.Creds
	Rclone   rclone.Runner
	S3       *s3.Client
	StateDir string
	Log      io.Writer // round log (~/.folder-sync/logs/<key>.log)
	Out      io.Writer // what the user sees
	Now      func() time.Time

	// reportedSkips are the names last round already reported, so --watch says each once.
	reportedSkips map[string]bool
}

// Open loads everything a round needs for the folder.
func Open(folder string, l layout.Layout, getenv func(string) string, rcloneBin string, out io.Writer) (*Project, error) {
	abs, err := filepath.Abs(folder)
	if err != nil {
		return nil, err
	}
	cfg, err := config.Load(abs)
	if err != nil {
		return nil, err
	}
	h, err := host.Load(l.HostFile)
	if err != nil {
		return nil, err
	}
	c, err := creds.Load(l.Credentials, getenv)
	if err != nil {
		return nil, err
	}
	key := StateKey(cfg.Project, abs)
	p := &Project{
		Folder:   abs,
		Config:   cfg,
		Layout:   l,
		Host:     h,
		Creds:    c,
		StateDir: filepath.Join(l.Projects, key),
		Out:      out,
		Now:      time.Now,
	}
	if err := EnsureRegistered(l, p.StateDir, Registration{Project: cfg.Project, Bucket: cfg.Bucket, Folder: abs, HostID: h.ID}); err != nil {
		return nil, err
	}
	logFile, err := os.OpenFile(filepath.Join(l.Logs, key+".log"), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	p.Log = logFile
	p.Rclone = rclone.Runner{Bin: rcloneBin, Layout: l, Creds: c, Log: logFile, Debug: getenv("FOLDER_SYNC_DEBUG") != ""}
	p.S3 = &s3.Client{Endpoint: c.Endpoint, Region: c.Region, AccessKeyID: c.AccessKeyID, SecretAccessKey: c.SecretAccessKey}
	return p, nil
}

// Close releases the log file.
func (p *Project) Close() {
	if closer, ok := p.Log.(io.Closer); ok {
		closer.Close()
	}
}

// EnsureRegistered writes project.json for a state dir, refusing a second folder on
// this machine for the same project and bucket: both would write hosts/<host-id>/.
func EnsureRegistered(l layout.Layout, stateDir string, reg Registration) error {
	entries, _ := os.ReadDir(l.Projects)
	for _, entry := range entries {
		other := filepath.Join(l.Projects, entry.Name())
		if other == stateDir {
			continue
		}
		existing, err := ReadRegistration(other)
		if err != nil || existing.Project != reg.Project || existing.Bucket != reg.Bucket {
			continue
		}
		if _, err := os.Stat(filepath.Join(existing.Folder, config.FileName)); err == nil {
			return fmt.Errorf("project %q in bucket %q is already synced on this machine from %s; "+
				"one machine publishes a project from one folder (both would write hosts/<host-id>/)",
				reg.Project, reg.Bucket, existing.Folder)
		}
	}
	if existing, err := ReadRegistration(stateDir); err == nil && existing.Folder == reg.Folder {
		return nil
	}
	reg.Schema = RegistrationSchema
	reg.RegisteredAt = time.Now().UTC().Format(time.RFC3339)
	return writeJSON(filepath.Join(stateDir, "project.json"), reg)
}

// ReadRegistration reads a state dir's project.json.
func ReadRegistration(stateDir string) (Registration, error) {
	var reg Registration
	data, err := os.ReadFile(filepath.Join(stateDir, "project.json"))
	if err != nil {
		return reg, err
	}
	return reg, json.Unmarshal(data, &reg)
}

// Keys in the bucket (docs/CONTRACT.md).

// HostPrefix is <project>/hosts/<host-id>.
func (p *Project) HostPrefix(hostID string) string {
	return p.Config.Project + "/hosts/" + hostID
}

// TrashPrefix is _trash/<project>/<host-id>/<UTC-stamp>.
func (p *Project) TrashPrefix(stamp string) string {
	return "_trash/" + p.Config.Project + "/" + p.Host.ID + "/" + stamp
}

// Stamp formats a round's UTC time for trash folders.
func Stamp(t time.Time) string {
	return t.UTC().Format("20060102T150405Z")
}

// State files.

func (p *Project) statePath(name string) string { return filepath.Join(p.StateDir, name) }

// PeerState is peers.json: known peers and the ETag of each one's last applied manifest.
type PeerState struct {
	Known []string          `json:"known"`
	ETags map[string]string `json:"etags"`
}

func (p *Project) loadPeers() PeerState {
	state := PeerState{ETags: map[string]string{}}
	data, err := os.ReadFile(p.statePath("peers.json"))
	if err == nil {
		_ = json.Unmarshal(data, &state)
	}
	if state.ETags == nil {
		state.ETags = map[string]string{}
	}
	return state
}

func (p *Project) savePeers(state PeerState) error {
	sort.Strings(state.Known)
	return writeJSON(p.statePath("peers.json"), state)
}

func (p *Project) peerManifestPath(peerID string) string {
	return filepath.Join(p.StateDir, "peers", peerID+".json")
}

func writeJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Lock is a per-project lock so a manual `sync --once` and the service never run a round together.
type Lock struct{ path string }

// staleLock is how old a lock file must be before a crashed holder is assumed.
const staleLock = 30 * time.Minute

// AcquireLock takes the project's lock or explains who holds it.
func (p *Project) AcquireLock() (*Lock, error) {
	path := p.statePath("lock")
	for attempt := 0; attempt < 2; attempt++ {
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			fmt.Fprintf(f, "pid %d at %s\n", os.Getpid(), time.Now().UTC().Format(time.RFC3339))
			f.Close()
			return &Lock{path: path}, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		info, statErr := os.Stat(path)
		if statErr == nil && time.Since(info.ModTime()) > staleLock {
			os.Remove(path)
			continue
		}
		holder, _ := os.ReadFile(path)
		return nil, fmt.Errorf("another folder-sync round is running for this folder (%s: %s)", path, strings.TrimSpace(string(holder)))
	}
	return nil, fmt.Errorf("cannot take the lock %s", path)
}

// Release drops the lock.
func (l *Lock) Release() { os.Remove(l.path) }

// HashFile returns the lowercase hex SHA-256 of a file.
func HashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// ownManifest is the last manifest this machine uploaded.
func (p *Project) ownManifest() (manifest.Manifest, error) {
	m, _, err := manifest.Load(p.statePath("manifest.json"))
	return m, err
}

func (p *Project) logf(format string, args ...any) {
	if p.Log != nil {
		fmt.Fprintf(p.Log, "%s %s\n", p.Now().UTC().Format(time.RFC3339), fmt.Sprintf(format, args...))
	}
}

func (p *Project) say(format string, args ...any) {
	if p.Out != nil {
		fmt.Fprintf(p.Out, format+"\n", args...)
	}
	p.logf(format, args...)
}
