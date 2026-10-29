// Package syncer runs folder-sync rounds: push this machine's changes, pull
// peers' changes, and write last-sync.json (docs/peps/0001 §4-§5).
package syncer

import (
	"context"
	"crypto/md5"
	"crypto/rand"
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
	"folder-sync/internal/trace"
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
	Root         string `json:"root,omitempty"` // the account root the folder was first synced under ("" = v0, none)
	RegisteredAt string `json:"registered_at"`
}

// RegistrationSchema names project.json.
const RegistrationSchema = "folder-sync-project/1"

// StateKey names a project folder's state dir: the project plus a hash of the folder's path,
// so two clones of one project on a machine never share state.
// WHY the root joins the hash only when set: v0 state dirs (root "") must keep their key.
func StateKey(project, folder, root string) string {
	hashed := folder
	if root != "" {
		hashed = folder + "\x00" + root
	}
	sum := sha256.Sum256([]byte(hashed))
	return project + "-" + hex.EncodeToString(sum[:])[:8]
}

// RegisteredRoot is the account root the folder's state dir was registered with ("" when none or unregistered).
func RegisteredRoot(l layout.Layout, project, folder string) string {
	regs, _ := AllStates(l)
	for _, reg := range regs {
		if reg.Project == project && reg.Folder == folder {
			return reg.Root
		}
	}
	return ""
}

// ErrBusy matches (errors.Is) the lock being held by another round: nothing was done.
var ErrBusy = errors.New("another folder-sync round is running for this folder")

// ErrRootChanged matches (errors.Is) a round whose credentials carry another account root than the folder's.
var ErrRootChanged = errors.New("account root changed")

type rootChangedError struct{ old, now string }

func (e *rootChangedError) Error() string {
	return fmt.Sprintf("this folder syncs to account root %s; these credentials are for %s: "+
		"folder-sync never moves a folder's files into another account", rootLabel(e.old), rootLabel(e.now))
}

func (e *rootChangedError) Is(target error) bool { return target == ErrRootChanged }

func rootLabel(root string) string {
	if root == "" {
		return `""`
	}
	return root
}

// rootError explains why a folder never moves between account roots.
// WHY refused: two people on one computer account must never copy one person's
// folder into the other's prefix.
func rootError(old, now string) error {
	return &rootChangedError{old: old, now: now}
}

// Project is one synced folder on this machine, ready to run rounds.
type Project struct {
	Folder   string
	Config   config.Config
	Layout   layout.Layout
	Host     host.Host
	Creds    creds.Creds
	Root     string                      // the account root of Creds ("" = none): every key starts with it
	Refresh  func() (creds.Creds, error) // the credentials to use now; Round calls it first
	Rclone   rclone.Runner
	S3       *s3.Client
	StateDir string
	Log      io.Writer // round log (~/.folder-sync/logs/<key>.log)
	Out      io.Writer // what the user sees
	Now      func() time.Time
	// RemoteDelete deletes this machine's files through the accounts server while its keys are read-only (an account
	// over its storage quota, docs/peps/0003 §3.7), as job (an id kept until the answer comes), from the manifest at
	// fromSeq; the server answers the manifest it built. Nil when not signed in.
	RemoteDelete func(ctx context.Context, job string, fromSeq int64, paths []string) (DeleteAnswer, error)
	Trace    *trace.Writer // FOLDER_SYNC_TRACE: step timings; nil = off

	// reportedSkips are the names last round already reported, so --watch says each once.
	reportedSkips map[string]bool
	// prevRoundStart is when the previous round started: a file whose mtime is later changed since (up_ms).
	prevRoundStart time.Time
	// restoring is the paths a restore wrote back this round (their push publishes restore events).
	restoring map[string]restoreMark
	// behind is set by a pull that did not apply a peer's latest manifest (this round is not "synced").
	behind bool
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
	resolver := creds.NewResolver(l.Credentials, l.Session, getenv)
	c, err := resolver.Current()
	if err != nil {
		return nil, err
	}
	if err := CheckBucket(c, cfg.Bucket); err != nil {
		return nil, err
	}
	key := StateKey(cfg.Project, abs, c.Prefix)
	p := &Project{
		Folder:   abs,
		Config:   cfg,
		Layout:   l,
		Host:     h,
		Creds:    c,
		Root:     c.Prefix,
		Refresh:  resolver.Current,
		StateDir: filepath.Join(l.Projects, key),
		Out:      out,
		Now:      time.Now,
	}
	if err := EnsureRegistered(l, p.StateDir, Registration{Project: cfg.Project, Bucket: cfg.Bucket, Folder: abs, HostID: h.ID, Root: c.Prefix}); err != nil {
		return nil, err
	}
	logFile, err := os.OpenFile(filepath.Join(l.Logs, key+".log"), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	p.Log = logFile
	p.Rclone = rclone.Runner{Bin: rcloneBin, Layout: l, Creds: c, Log: logFile, Debug: getenv("FOLDER_SYNC_DEBUG") != ""}
	p.Trace = trace.Open(getenv(trace.Env))
	p.Rclone.Trace = p.Trace
	p.S3 = &s3.Client{}
	p.useCreds(c)
	return p, nil
}

// CheckBucket refuses a bucket other than the one the credentials are bound to.
func CheckBucket(c creds.Creds, bucket string) error {
	if c.Bucket != "" && c.Bucket != bucket {
		return fmt.Errorf("bucket %q (from %s) differs from %q, the only bucket these credentials can use", bucket, config.FileName, c.Bucket)
	}
	return nil
}

// useCreds points the rclone runner and the S3 client at c's keys and token.
func (p *Project) useCreds(c creds.Creds) {
	p.Creds, p.Root = c, c.Prefix
	p.Rclone.Creds = c
	p.S3.Endpoint, p.S3.Region = c.Endpoint, c.Region
	p.S3.AccessKeyID, p.S3.SecretAccessKey, p.S3.SessionToken = c.AccessKeyID, c.SecretAccessKey, c.SessionToken
}

// refreshCreds fetches the credentials for this round (a short-lived key may have
// rolled over, or the person may have signed in as someone else) and refuses a
// bucket or account root this folder is not bound to.
func (p *Project) refreshCreds() error {
	if p.Refresh == nil {
		return nil
	}
	c, err := p.Refresh()
	if err != nil {
		return err
	}
	if err := CheckBucket(c, p.Config.Bucket); err != nil {
		return err
	}
	registered := p.Root
	if reg, err := ReadRegistration(p.StateDir); err == nil {
		registered = reg.Root
	}
	if c.Prefix != registered {
		return rootError(registered, c.Prefix)
	}
	p.useCreds(c)
	return nil
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
	// WHY first: the same folder under another root is the account switch to refuse, not "a second folder".
	if others := registrationsOfFolder(l, stateDir, reg); len(others) > 0 && others[0].Root != reg.Root {
		return rootError(others[0].Root, reg.Root)
	}
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

// registrationsOfFolder lists other state dirs registered for the same project, bucket and folder.
func registrationsOfFolder(l layout.Layout, stateDir string, reg Registration) []Registration {
	var found []Registration
	entries, _ := os.ReadDir(l.Projects)
	for _, entry := range entries {
		other := filepath.Join(l.Projects, entry.Name())
		if other == stateDir {
			continue
		}
		existing, err := ReadRegistration(other)
		if err == nil && existing.Project == reg.Project && existing.Bucket == reg.Bucket && existing.Folder == reg.Folder {
			found = append(found, existing)
		}
	}
	return found
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

// HostPrefix is <root><project>/hosts/<host-id>.
func (p *Project) HostPrefix(hostID string) string {
	return p.Root + p.Config.Project + "/hosts/" + hostID
}

// TrashPrefix is <root>_trash/<project>/<host-id>/<UTC-stamp>.
func (p *Project) TrashPrefix(stamp string) string {
	return p.Root + "_trash/" + p.Config.Project + "/" + p.Host.ID + "/" + stamp
}

// HostsPrefix is <root><project>/hosts: the folder Discover lists.
func (p *Project) HostsPrefix() string {
	return p.Root + p.Config.Project + "/hosts"
}

// Stamp names a round's trash folder (and its conflict copies): the round's UTC second, then the millisecond and 8
// random hex digits (20261025T120000Z-789-1f2e3d4c), as the web host's trash. WHY unique (review r2 #9): two rounds
// in one second replacing the same path would move both old versions onto one key, and the second would overwrite
// the first; WHY the second first: anything sorting or grouping the trash by its second still reads it.
func Stamp(t time.Time) string {
	nonce := make([]byte, 4)
	rand.Read(nonce)
	u := t.UTC()
	return fmt.Sprintf("%s-%03d-%s", u.Format("20060102T150405Z"), u.Nanosecond()/1_000_000, hex.EncodeToString(nonce))
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
		return nil, fmt.Errorf("%w (%s: %s)", ErrBusy, path, strings.TrimSpace(string(holder)))
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

// HashFiles returns the lowercase hex SHA-256 and MD5 of a file, from one read: the MD5 is what a single-part upload's
// ETag is, so it ties the stored object to these bytes (recordObjectETags).
func HashFiles(path string) (sha string, md string, err error) {
	f, err := os.Open(path)
	if err != nil {
		return "", "", err
	}
	defer f.Close()
	h, m := sha256.New(), md5.New()
	if _, err := io.Copy(io.MultiWriter(h, m), f); err != nil {
		return "", "", err
	}
	return hex.EncodeToString(h.Sum(nil)), hex.EncodeToString(m.Sum(nil)), nil
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

// ManifestSeq is the seq of the last manifest this machine uploaded (0 before the first).
func (p *Project) ManifestSeq() int {
	m, err := p.ownManifest()
	if err != nil {
		return 0
	}
	return int(m.Seq)
}

// KnownPeers maps each peer this machine pulls to the seq of the manifest it last read from it (0 if none yet).
// WHY (PEP 0005): a hub message naming a host not in this map starts a discover in that round, not in 5 minutes.
func (p *Project) KnownPeers() map[string]int {
	out := map[string]int{}
	for _, id := range p.loadPeers().Known {
		seq := 0
		if m, ok, err := manifest.Load(p.peerManifestPath(id)); err == nil && ok {
			seq = int(m.Seq)
		}
		out[id] = seq
	}
	return out
}
