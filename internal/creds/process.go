package creds

// The credential process: FOLDER_SYNC_CREDENTIAL_PROCESS names a program that
// prints short-lived keys, in the shape of AWS's credential_process plus the
// optional Endpoint, Bucket, Prefix, Region and Provider. folder-sync runs it
// before every round, so a long-lived `sync --watch` refreshes too and a
// revoked machine stops at its next refresh. The program's exit code 3 means
// signed out; any other failure is transient and the cached keys carry on
// while they are still valid.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"

	"folder-sync/internal/config"
)

// EnvCredentialProcess is a JSON array of strings: the argv of the program, argv[0] absolute.
const EnvCredentialProcess = "FOLDER_SYNC_CREDENTIAL_PROCESS"

// SessionSchema names session.json, the cache of the process's last output.
const SessionSchema = "folder-sync-session/1"

const (
	// ExitSignedOut is the credential process's exit code for "signed out or revoked".
	ExitSignedOut = 3
	// ProcessTimeout is how long the program may run before it is killed.
	ProcessTimeout = 60 * time.Second
	// MaxOutput caps the program's stdout.
	MaxOutput = 64 << 10
	// NoExpirationRefresh is how long keys without an Expiration are reused.
	NoExpirationRefresh = 15 * time.Minute
	// maxRefreshLead is the longest head start a refresh gets before Expiration.
	maxRefreshLead = 5 * time.Minute
	// minValid is how much life cached keys need left to be used after a failed refresh.
	minValid = 30 * time.Second
)

// segmentPattern is one segment of the account root.
var segmentPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// ValidatePrefix checks an account root: empty, or exactly the contract's
// ^([A-Za-z0-9][A-Za-z0-9._-]{0,127}/){1,8}$ .
// WHY strict: the root is spliced into every key and handed to rclone, so a
// `..`, an empty segment or a leading slash would reach outside the account.
// WHY not that regexp: Go's RE2 refuses nested repeats past 1000 ({0,127} inside
// {1,8}), so the same language is checked segment by segment.
func ValidatePrefix(prefix string) error {
	if prefix == "" {
		return nil
	}
	segments := strings.Split(prefix, "/")
	// "a/b/" splits to [a b ""]: the trailing empty element is the required final slash.
	if n := len(segments) - 1; n >= 1 && n <= 8 && segments[n] == "" {
		valid := true
		for _, segment := range segments[:n] {
			valid = valid && segmentPattern.MatchString(segment)
		}
		if valid {
			return nil
		}
	}
	return fmt.Errorf("account root %q: use 1-8 segments of letters, digits, '.', '_' or '-', each ending in '/' (like users/AbC123/)", prefix)
}

// SignedOutError is the credential process saying exit 3: signed out or revoked.
type SignedOutError struct{ Message string }

func (e *SignedOutError) Error() string {
	if e.Message == "" {
		return "signed out: the credential process says this machine is signed out"
	}
	return e.Message
}

// Is makes errors.Is(err, ErrSignedOut) true for any SignedOutError.
func (e *SignedOutError) Is(target error) bool { return target == ErrSignedOut }

// ErrSignedOut matches (errors.Is) the credential process's exit 3.
var ErrSignedOut = errors.New("signed out")

// processOutput is the program's stdout, and the "creds" object of session.json.
type processOutput struct {
	Version         int    `json:"Version"`
	AccessKeyID     string `json:"AccessKeyId"`
	SecretAccessKey string `json:"SecretAccessKey"`
	SessionToken    string `json:"SessionToken,omitempty"`
	Expiration      string `json:"Expiration,omitempty"`
	Endpoint        string `json:"Endpoint,omitempty"`
	Bucket          string `json:"Bucket,omitempty"`
	Prefix          string `json:"Prefix,omitempty"`
	Region          string `json:"Region,omitempty"`
	Provider        string `json:"Provider,omitempty"`
	ReadOnly        bool   `json:"ReadOnly,omitempty"` // the keys only read (over quota); Reason says why
	Reason          string `json:"Reason,omitempty"`
}

// sessionFile is ~/.folder-sync/session.json.
type sessionFile struct {
	Schema    string        `json:"schema"`
	Process   string        `json:"process"` // sha256 hex of the argv JSON: reused only for the same program
	FetchedAt string        `json:"fetched_at"`
	Creds     processOutput `json:"creds"`
}

// Resolver hands out the current credentials: from the environment or
// credentials.json as before, or from the credential process with a cache.
type Resolver struct {
	CredentialsPath string // ~/.folder-sync/credentials.json
	SessionPath     string // ~/.folder-sync/session.json
	Getenv          func(string) string
	Now             func() time.Time // injectable for tests; default time.Now
	Timeout         time.Duration    // injectable for tests; default ProcessTimeout
}

// NewResolver builds a Resolver over the process environment's lookup function.
func NewResolver(credentialsPath, sessionPath string, getenv func(string) string) *Resolver {
	return &Resolver{CredentialsPath: credentialsPath, SessionPath: sessionPath, Getenv: getenv}
}

func (r *Resolver) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

func (r *Resolver) timeout() time.Duration {
	if r.Timeout > 0 {
		return r.Timeout
	}
	return ProcessTimeout
}

// UsesProcess reports whether the credentials come from a credential process.
func (r *Resolver) UsesProcess() bool { return r.Getenv(EnvCredentialProcess) != "" }

// Current returns the credentials to use now, refreshing them when they are due.
func (r *Resolver) Current() (Creds, error) {
	raw := r.Getenv(EnvCredentialProcess)
	if raw == "" {
		return Load(r.CredentialsPath, r.Getenv)
	}
	if r.Getenv(EnvAccessKeyID) != "" || r.Getenv(EnvSecretAccessKey) != "" {
		return Creds{}, fmt.Errorf("set either %s or %s/%s, not both", EnvCredentialProcess, EnvAccessKeyID, EnvSecretAccessKey)
	}
	argv, err := parseArgv(raw)
	if err != nil {
		return Creds{}, err
	}
	sum := sha256.Sum256([]byte(raw))
	processID := hex.EncodeToString(sum[:])
	now := r.now()

	cached, fetchedAt, haveCache := r.readSession(processID)
	if haveCache && !refreshDue(cached, fetchedAt, now) {
		return cached, nil
	}

	stdout, runErr := r.runProcess(argv)
	var signedOut *SignedOutError
	if errors.As(runErr, &signedOut) {
		os.Remove(r.SessionPath) // never reuse keys the server has revoked
		return Creds{}, runErr
	}
	if runErr != nil {
		if haveCache && usable(cached, now) {
			return cached, nil // transient: the keys we have are still good
		}
		return Creds{}, runErr
	}
	var out processOutput
	if err := json.Unmarshal(stdout, &out); err != nil {
		return Creds{}, errors.New("credential process: stdout is not one JSON object") // never echo the content
	}
	c, err := r.build(out)
	if err != nil {
		return Creds{}, fmt.Errorf("credential process: %w", err)
	}
	r.writeSession(sessionFile{Schema: SessionSchema, Process: processID, FetchedAt: now.UTC().Format(time.RFC3339), Creds: out})
	return c, nil
}

func parseArgv(raw string) ([]string, error) {
	var argv []string
	if err := json.Unmarshal([]byte(raw), &argv); err != nil || len(argv) == 0 || argv[0] == "" {
		return nil, fmt.Errorf("%s must be a JSON array of strings, the program's argv (like [\"/usr/local/bin/vt\",\"sync\",\"credentials\"])", EnvCredentialProcess)
	}
	if !filepath.IsAbs(argv[0]) {
		return nil, fmt.Errorf("%s: argv[0] must be an absolute path", EnvCredentialProcess)
	}
	return argv, nil
}

// build validates the program's output and turns it into Creds.
func (r *Resolver) build(out processOutput) (Creds, error) {
	if out.Version != 1 {
		return Creds{}, fmt.Errorf("Version must be 1")
	}
	if out.AccessKeyID == "" || out.SecretAccessKey == "" {
		return Creds{}, fmt.Errorf("AccessKeyId and SecretAccessKey are required")
	}
	if err := ValidatePrefix(out.Prefix); err != nil {
		return Creds{}, err
	}
	if out.Bucket != "" {
		if err := config.ValidateBucket(out.Bucket); err != nil {
			return Creds{}, err
		}
	}
	c := Creds{Schema: Schema, AccessKeyID: out.AccessKeyID, SecretAccessKey: out.SecretAccessKey,
		SessionToken: out.SessionToken, Endpoint: out.Endpoint, Provider: out.Provider, Region: out.Region,
		Prefix: out.Prefix, Bucket: out.Bucket, Source: "process", ReadOnly: out.ReadOnly, Reason: printable(out.Reason)}
	if out.Expiration != "" {
		t, err := time.Parse(time.RFC3339, out.Expiration)
		if err != nil {
			return Creds{}, fmt.Errorf("Expiration %q is not RFC 3339", out.Expiration)
		}
		c.Expiration = t
	}
	if c.Endpoint == "" {
		c.Endpoint = r.Getenv(EnvEndpoint)
	}
	if c.Endpoint == "" {
		account := r.Getenv(EnvAccountID)
		if account == "" {
			return Creds{}, fmt.Errorf("no Endpoint in the output: set %s (or %s for an S3-compatible stand-in)", EnvAccountID, EnvEndpoint)
		}
		c.Endpoint = "https://" + account + ".r2.cloudflarestorage.com"
	}
	if c.Provider == "" {
		c.Provider = r.Getenv(EnvProvider)
	}
	if c.Region == "" {
		c.Region = r.Getenv(EnvRegion)
	}
	c.fillDefaults()
	return c, nil
}

// refreshDue: with an Expiration, refresh when less than min(5 min, a third of
// the lifetime) is left; without one, after 15 minutes.
func refreshDue(c Creds, fetchedAt, now time.Time) bool {
	if c.Expiration.IsZero() {
		return now.Sub(fetchedAt) >= NoExpirationRefresh
	}
	lead := c.Expiration.Sub(fetchedAt) / 3
	if lead > maxRefreshLead {
		lead = maxRefreshLead
	}
	return c.Expiration.Sub(now) < lead
}

// usable: cached keys may carry a failed refresh while more than 30 s are left.
func usable(c Creds, now time.Time) bool {
	return c.Expiration.IsZero() || c.Expiration.Sub(now) > minValid
}

func (r *Resolver) readSession(processID string) (c Creds, fetchedAt time.Time, ok bool) {
	data, err := os.ReadFile(r.SessionPath)
	if err != nil {
		return Creds{}, time.Time{}, false
	}
	var file sessionFile
	if json.Unmarshal(data, &file) != nil || file.Schema != SessionSchema || file.Process != processID {
		return Creds{}, time.Time{}, false
	}
	fetchedAt, err = time.Parse(time.RFC3339, file.FetchedAt)
	if err != nil {
		return Creds{}, time.Time{}, false
	}
	c, err = r.build(file.Creds)
	if err != nil {
		return Creds{}, time.Time{}, false
	}
	return c, fetchedAt, true
}

func (r *Resolver) writeSession(file sessionFile) {
	// WHY the failure is dropped: the keys in hand are good; a read-only home must not stop a round.
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(r.SessionPath), 0o700); err != nil {
		return
	}
	tmp := r.SessionPath + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return
	}
	if err := os.Rename(tmp, r.SessionPath); err != nil {
		os.Remove(tmp)
	}
}

// runProcess runs the program and returns its stdout. Exit 3 is a *SignedOutError;
// every other failure is an ordinary (transient) error carrying the last stderr line.
func (r *Resolver) runProcess(argv []string) ([]byte, error) {
	cmd := exec.Command(argv[0], argv[1:]...)
	stdout := &capped{max: MaxOutput}
	stderr := &tail{max: 4096}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	cmd.WaitDelay = 2 * time.Second // a killed script's orphaned child must not hold the pipes open
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("credential process: cannot start: %v", errorKind(err))
	}
	timer := time.AfterFunc(r.timeout(), func() { cmd.Process.Kill() })
	err := cmd.Wait()
	timedOut := !timer.Stop()
	last := stderr.lastLine()
	var exit *exec.ExitError
	switch {
	case timedOut:
		return nil, fmt.Errorf("credential process: no answer in %s, killed%s", r.timeout(), suffix(last))
	case errors.As(err, &exit) && exit.ExitCode() == ExitSignedOut:
		return nil, &SignedOutError{Message: last}
	case stdout.over:
		return nil, fmt.Errorf("credential process: output is over %d KiB", MaxOutput>>10)
	case err != nil:
		if last == "" {
			last = err.Error()
		}
		return nil, fmt.Errorf("credential process failed: %s", last)
	}
	return stdout.buf.Bytes(), nil
}

func suffix(last string) string {
	if last == "" {
		return ""
	}
	return ": " + last
}

// errorKind keeps a start failure's reason without echoing paths or arguments.
func errorKind(err error) string {
	var pathErr *os.PathError
	var execErr *exec.Error
	switch {
	case errors.Is(err, os.ErrNotExist):
		return "no such program"
	case errors.Is(err, os.ErrPermission):
		return "permission denied"
	case errors.As(err, &pathErr):
		return pathErr.Err.Error()
	case errors.As(err, &execErr):
		return execErr.Err.Error()
	}
	return "start failed"
}

// printable is a server's sentence as folder-sync prints it: control characters dropped, cut to 300 runes.
func printable(text string) string {
	text = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, strings.TrimSpace(text))
	if runes := []rune(text); len(runes) > 300 {
		text = string(runes[:300]) + "…"
	}
	return text
}

// capped is a stdout buffer that stops accepting bytes past max.
type capped struct {
	buf  bytes.Buffer
	max  int
	over bool
}

func (c *capped) Write(p []byte) (int, error) {
	if c.buf.Len()+len(p) > c.max {
		c.over = true
		return 0, errors.New("output too large")
	}
	return c.buf.Write(p)
}

// tail keeps the last max bytes of stderr.
type tail struct {
	buf []byte
	max int
}

func (t *tail) Write(p []byte) (int, error) {
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.max {
		t.buf = t.buf[len(t.buf)-t.max:]
	}
	return len(p), nil
}

// lastLine is the last non-empty stderr line, control characters dropped, cut to 300 runes.
func (t *tail) lastLine() string {
	lines := strings.Split(strings.ReplaceAll(string(t.buf), "\r", ""), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.Map(func(r rune) rune {
			if unicode.IsControl(r) {
				return -1
			}
			return r
		}, strings.TrimSpace(lines[i]))
		if line == "" {
			continue
		}
		if runes := []rune(line); len(runes) > 300 {
			line = string(runes[:300]) + "…"
		}
		return line
	}
	return ""
}
