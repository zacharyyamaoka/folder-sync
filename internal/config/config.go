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
)

// FileName is the project config's name, at the root of the synced folder.
const FileName = ".folder-sync.toml"

// Subfolder modes. v0 implements only ModePush.
const (
	ModePush   = "push"   // this machine's files, published under hosts/<host-id>/ (v0)
	ModeShared = "shared" // two-way under shared/, with a lease and bisync (v1, refused)
)

// Viewer is the R2-Explorer backdoor's settings (publish --viewer).
type Viewer struct {
	AccessTeam string `toml:"access_team"` // Cloudflare Access team name (Zero Trust → Settings → Team domain)
	Domain     string `toml:"domain"`      // custom domain the viewer Worker serves, e.g. files.example.com
	WorkerName string `toml:"worker_name"` // defaults to folder-sync-<project>
}

// Config is .folder-sync.toml.
type Config struct {
	Project   string            `toml:"project"`
	Bucket    string            `toml:"bucket"`
	PeersDir  string            `toml:"peers_dir"`
	Interval  string            `toml:"interval"`
	MaxDelete int               `toml:"max_delete"`
	Ignore    []string          `toml:"ignore"`
	NoHistory []string          `toml:"no_history"`
	Modes     map[string]string `toml:"modes"`
	Viewer    Viewer            `toml:"viewer"`
}

// Defaults for a new project.
const (
	DefaultBucket    = "folder-sync"
	DefaultPeersDir  = "hosts"
	DefaultInterval  = "10s"
	DefaultMaxDelete = 50
)

// DefaultNoHistory is no_history when .folder-sync.toml does not set it: paths whose replaced or deleted versions are
// never kept in _history/ (docs/peps/0007 §3.2). WHY *.log (Zach, 2026-10-28, PEP 0007 §10.6): an appended log copied
// whole on every round is the fastest way to fill a quota, and each old version is only the start of the current one.
var DefaultNoHistory = []string{"*.log"}

var projectName = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,62}$`)
var bucketName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`)

// ValidateProject checks a project name; it becomes the bucket prefix.
// A leading "_" is reserved for _trash/ and _leases/.
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
	}
}

// Validate checks every field, including the v0 refusal of shared folders.
func (c *Config) Validate() error {
	if err := ValidateProject(c.Project); err != nil {
		return err
	}
	if err := ValidateBucket(c.Bucket); err != nil {
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
	subfolders := make([]string, 0, len(c.Modes))
	for subfolder := range c.Modes {
		subfolders = append(subfolders, subfolder)
	}
	sort.Strings(subfolders)
	for _, subfolder := range subfolders {
		switch mode := c.Modes[subfolder]; mode {
		case ModePush:
		case ModeShared:
			return ErrSharedIsV1{Subfolder: subfolder}
		default:
			return fmt.Errorf("modes.%q = %q: the modes are %q (v0) and %q (v1)", subfolder, mode, ModePush, ModeShared)
		}
	}
	return nil
}

// ErrSharedIsV1 is the clear refusal of two-way folders in v0.
type ErrSharedIsV1 struct{ Subfolder string }

func (e ErrSharedIsV1) Error() string {
	return fmt.Sprintf("modes.%q = \"shared\" is not available in v0: two-way folders need the lease in "+
		"_leases/<project>.json and rclone bisync (docs/peps/0001 §6), which ship in v1. "+
		"In v0 every machine publishes only its own files under hosts/<host-id>/; remove the line to continue", e.Subfolder)
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
	fmt.Fprintf(&b, "bucket = %q\n", c.Bucket)
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
	b.WriteString("]\n\n")
	b.WriteString("# Subfolder modes. v0 has one: every file is this machine's (\"push\").\n")
	b.WriteString("# \"shared\" (two-way, under a lease) is v1 and is refused today.\n")
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
