// Package config reads and writes a project's .folder-sync.toml.
//
// The file is safe to commit: it holds the project, the bucket, the ignore rules
// and the subfolder modes, never a key and never the host id (docs/peps/0001 §3:
// a copied project folder or config can never make two machines the same host).
package config

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/BurntSushi/toml"

	"folder-sync/internal/ignore"
	"folder-sync/internal/store"
)

// FileName is the project config's name, at the root of the synced folder.
const FileName = ".folder-sync.toml"

// Subfolder modes. Only ModePush is a setting; a shared folder is the folder's own property, set once with `folder-sync
// share` (docs/peps/0010 §7).
const (
	ModePush   = "push"   // this machine's files, published under hosts/<host-id>/
	ModeShared = "shared" // refused here: WHY one rule per folder, in the shared tree's manifest, so no two machines disagree
)

// Viewer is the R2-Explorer backdoor's settings (publish --viewer).
type Viewer struct {
	AccessTeam string `toml:"access_team"` // Cloudflare Access team name (Zero Trust → Settings → Team domain)
	Domain     string `toml:"domain"`      // custom domain the viewer Worker serves, e.g. files.example.com
	WorkerName string `toml:"worker_name"` // defaults to folder-sync-<project>
}

// Config is .folder-sync.toml.
type Config struct {
	Project string `toml:"project"`
	Bucket  string `toml:"bucket"`
	// Store is where the folder's bytes live, as a URL: r2://bucket, s3://bucket/prefix, gs://bucket/prefix or
	// file:///dir (docs/STORAGE.md). Empty means r2://<bucket>, today's behaviour. When set, Validate fills Bucket from it.
	Store     string            `toml:"store"`
	PeersDir  string            `toml:"peers_dir"`
	Interval  string            `toml:"interval"`
	MaxDelete int               `toml:"max_delete"`
	Ignore    []string          `toml:"ignore"`
	NoHistory []string          `toml:"no_history"`
	Modes     map[string]string `toml:"modes"`
	Viewer    Viewer            `toml:"viewer"`

	// HistoryEvery is how finely history is kept: at most one version of a path per this long (PEP 0009 §5).
	HistoryEvery string `toml:"history_every"`
}

// Defaults for a new project.
const (
	DefaultBucket    = "folder-sync"
	DefaultPeersDir  = "hosts"
	DefaultInterval  = "10s"
	DefaultMaxDelete = 50
	// DefaultHistoryEvery is Zach's default (2026-11-04, "Version control timestamps, every X min? (5 by default)").
	DefaultHistoryEvery = "5m"
	// MinHistoryEvery is the least: PEP 0007's 30 s.
	MinHistoryEvery = 30 * time.Second
)

// DefaultNoHistory is no_history when .folder-sync.toml does not set it: paths whose replaced or deleted versions are
// never kept in _history/ (docs/peps/0007 §3.2). WHY *.log (Zach, 2026-10-28, PEP 0007 §10.6): an appended log copied
// whole on every round is the fastest way to fill a quota, and each old version is only the start of the current one.
var DefaultNoHistory = []string{"*.log"}

var projectName = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,62}$`)
var bucketName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`)

// ValidateProject checks a project name; it becomes the bucket prefix.
// A leading "_" is reserved for folder-sync's own prefixes (_history/, _changes/, _requests/, _incoming/, _trash/).
func ValidateProject(name string) error {
	if !projectName.MatchString(name) {
		return fmt.Errorf("project name %q: use lowercase letters, digits, '.', '_' or '-', starting with a letter or digit", name)
	}
	return nil
}

// ValidateBucket checks an R2/S3 bucket name.
func ValidateBucket(name string) error {
	if !bucketName.MatchString(name) {
		return fmt.Errorf("bucket name %q: use 3-63 lowercase letters, digits or '-'", name)
	}
	return nil
}

// ProjectFromFolder derives a default project name from a folder's base name.
func ProjectFromFolder(folder string) string {
	base := strings.ToLower(filepath.Base(folder))
	var b strings.Builder
	for _, r := range base {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	name := strings.TrimLeft(b.String(), "._-")
	if name == "" {
		name = "project"
	}
	if len(name) > 63 {
		name = name[:63]
	}
	return name
}

// New returns a config with the defaults filled in.
func New(project, bucket string) Config {
	return Config{
		Project:   project,
		Bucket:    bucket,
		PeersDir:  DefaultPeersDir,
		Interval:  DefaultInterval,
		MaxDelete: DefaultMaxDelete,
		Ignore:    []string{},
		NoHistory: append([]string{}, DefaultNoHistory...),
		Modes:     map[string]string{},

		HistoryEvery: DefaultHistoryEvery,
	}
}

// Validate checks every field, including the refusal of a shared mode in [modes].
func (c *Config) Validate() error {
	if err := ValidateProject(c.Project); err != nil {
		return err
	}
	if c.Store != "" {
		spec, err := store.Parse(c.Store)
		if err != nil {
			return err
		}
		// WHY refused: two answers to "which bucket" would let a folder sync to the one the other line does not name
		if c.Bucket != "" && c.Bucket != spec.Bucket {
			return fmt.Errorf("bucket %q and store %q name different buckets: set store only", c.Bucket, c.Store)
		}
		c.Bucket = spec.Bucket
	} else if err := ValidateBucket(c.Bucket); err != nil {
		return err
	}
	if c.PeersDir == "" {
		c.PeersDir = DefaultPeersDir
	}
	if strings.ContainsAny(c.PeersDir, `/\:`) || c.PeersDir == "." || c.PeersDir == ".." {
		return fmt.Errorf("peers_dir %q must be a single folder name", c.PeersDir)
	}
	if c.Interval == "" {
		c.Interval = DefaultInterval
	}
	interval, err := time.ParseDuration(c.Interval)
	if err != nil || interval < time.Second {
		return fmt.Errorf("interval %q: use a duration of at least 1s, e.g. \"10s\"", c.Interval)
	}
	if c.MaxDelete <= 0 {
		c.MaxDelete = DefaultMaxDelete
	}
	if _, err := ignore.Parse(c.NoHistory); err != nil {
		return fmt.Errorf("no_history: %w", err)
	}
	if c.HistoryEvery == "" {
		c.HistoryEvery = DefaultHistoryEvery
	}
	if every, err := time.ParseDuration(c.HistoryEvery); err != nil || every < MinHistoryEvery {
		return fmt.Errorf("history_every %q: use a duration of at least 30s, e.g. \"5m\"", c.HistoryEvery)
	}
	subfolders := make([]string, 0, len(c.Modes))
	for subfolder := range c.Modes {
		subfolders = append(subfolders, subfolder)
	}
	sort.Strings(subfolders)
	for _, subfolder := range subfolders {
		switch mode := c.Modes[subfolder]; mode {
		case ModePush:
		case ModeShared:
			return ErrUseShare{Subfolder: subfolder}
		default:
			return fmt.Errorf("modes.%q = %q: the only mode is %q (a folder is shared with `folder-sync share`)", subfolder, mode, ModePush)
		}
	}
	return nil
}

// ErrUseShare is the refusal of a shared mode in [modes]. WHY (docs/peps/0010 §7): which files are shared is one rule for the
// whole folder, kept in the shared tree's manifest; each machine's .folder-sync.toml is its own, so a per-machine rule
// could disagree.
type ErrUseShare struct{ Subfolder string }

func (e ErrUseShare) Error() string {
	return fmt.Sprintf("modes.%q = \"shared\" is not a setting: a folder is shared once, for every machine, with "+
		"`folder-sync share <project> [--private <pattern>]...` (docs/peps/0010); remove the line to continue", e.Subfolder)
}

// StoreSpec is the parsed store: the store URL, else r2://<bucket> (Validate must have passed).
func (c Config) StoreSpec() store.Spec {
	if c.Store != "" {
		if spec, err := store.Parse(c.Store); err == nil {
			return spec
		}
	}
	return store.R2Default(c.Bucket)
}

// HistoryEveryDuration is the parsed history_every (Validate must have passed).
func (c Config) HistoryEveryDuration() time.Duration {
	d, _ := time.ParseDuration(c.HistoryEvery)
	return d
}

// IntervalDuration is the parsed interval (Validate must have passed).
func (c Config) IntervalDuration() time.Duration {
	d, _ := time.ParseDuration(c.Interval)
	return d
}

// Load reads <folder>/.folder-sync.toml and validates it.
func Load(folder string) (Config, error) {
	path := filepath.Join(folder, FileName)
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Config{}, fmt.Errorf("%s has no %s: run `folder-sync init` there first", folder, FileName)
	}
	if err != nil {
		return Config{}, err
	}
	var c Config
	meta, err := toml.Decode(string(data), &c)
	if err != nil {
		return Config{}, fmt.Errorf("%s: %w", path, err)
	}
	if undecoded := meta.Undecoded(); len(undecoded) > 0 {
		return Config{}, fmt.Errorf("%s: unknown key %q", path, undecoded[0].String())
	}
	if c.Modes == nil {
		c.Modes = map[string]string{}
	}
	// WHY IsDefined and not nil: `no_history = []` keeps every version, *.log included; only an absent key means the default
	if !meta.IsDefined("no_history") {
		c.NoHistory = append([]string{}, DefaultNoHistory...)
	} else if c.NoHistory == nil {
		c.NoHistory = []string{}
	}
	if err := c.Validate(); err != nil {
		return Config{}, fmt.Errorf("%s: %w", path, err)
	}
	return c, nil
}

// Find walks up from dir to the nearest folder holding .folder-sync.toml.
func Find(dir string) (string, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	for current := abs; ; {
		if _, err := os.Stat(filepath.Join(current, FileName)); err == nil {
			return current, nil
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", fmt.Errorf("no %s in %s or any parent: run `folder-sync init` first", FileName, abs)
		}
		current = parent
	}
}

// Render writes the config as commented TOML.
func Render(c Config) string {
	var b bytes.Buffer
	b.WriteString("# folder-sync project config (docs/peps/0001). Safe to commit: it holds no key and no host id.\n")
	fmt.Fprintf(&b, "project = %q\n", c.Project)
	if c.Store != "" {
		b.WriteString("# Where the bytes live: r2://bucket, s3://bucket/prefix, gs://bucket/prefix or file:///dir (docs/STORAGE.md).\n")
		fmt.Fprintf(&b, "store = %q\n", c.Store)
	} else {
		fmt.Fprintf(&b, "bucket = %q\n", c.Bucket)
	}
	b.WriteString("# Peers' files land read-only in <this folder>/<peers_dir>/<host-id>/, the same path as in the bucket.\n")
	fmt.Fprintf(&b, "peers_dir = %q\n", c.PeersDir)
	b.WriteString("# How often `sync --watch` runs a round.\n")
	fmt.Fprintf(&b, "interval = %q\n", c.Interval)
	b.WriteString("# A round refuses to delete more than this many files (an empty or unmounted folder can't wipe the bucket).\n")
	fmt.Fprintf(&b, "max_delete = %d\n", c.MaxDelete)
	b.WriteString("# gitignore syntax, added to the defaults: .git/ node_modules/ .env *.pem id_* *.key\n")
	b.WriteString("ignore = [")
	for i, rule := range c.Ignore {
		if i > 0 {
			b.WriteString(", ")
		}
		fmt.Fprintf(&b, "%q", rule)
	}
	b.WriteString("]\n")
	b.WriteString("# gitignore syntax: files whose replaced or deleted versions are never kept in the bucket's history.\n")
	b.WriteString("no_history = [")
	for i, rule := range c.NoHistory {
		if i > 0 {
			b.WriteString(", ")
		}
		fmt.Fprintf(&b, "%q", rule)
	}
	b.WriteString("]\n")
	b.WriteString("# History is kept at most this often per file: a burst of saves keeps one version per window (30s at least).\n")
	fmt.Fprintf(&b, "history_every = %q\n\n", c.HistoryEvery)
	b.WriteString("# Subfolder modes. There is one: every file is this machine's (\"push\").\n")
	b.WriteString("# A two-way shared folder is set once, for every machine, with `folder-sync share`; \"shared\" is refused here.\n")
	b.WriteString("[modes]\n")
	subfolders := make([]string, 0, len(c.Modes))
	for subfolder := range c.Modes {
		subfolders = append(subfolders, subfolder)
	}
	sort.Strings(subfolders)
	for _, subfolder := range subfolders {
		fmt.Fprintf(&b, "%q = %q\n", subfolder, c.Modes[subfolder])
	}
	b.WriteString("\n# The R2-Explorer backdoor (`folder-sync publish --viewer`).\n")
	b.WriteString("[viewer]\n")
	fmt.Fprintf(&b, "access_team = %q\n", c.Viewer.AccessTeam)
	fmt.Fprintf(&b, "domain = %q\n", c.Viewer.Domain)
	fmt.Fprintf(&b, "worker_name = %q\n", c.Viewer.WorkerName)
	return b.String()
}

// Write writes <folder>/.folder-sync.toml.
func Write(folder string, c Config) error {
	return os.WriteFile(filepath.Join(folder, FileName), []byte(Render(c)), 0o644)
}
