// Package rclone runs the pinned rclone with folder-sync's fixed flags.
//
// docs/peps/0001 §7: every rclone call passes --config and --cache-dir under
// ~/.folder-sync/, never rclone's %APPDATA%/%LOCALAPPDATA% defaults. --temp-dir
// is added too, because rclone's default temp dir is %TEMP%, which on Windows
// sits under %LOCALAPPDATA%. (--workdir is a bisync-only flag; rclone rejects it
// on copy/move, so it is passed only to bisync, which is v1.)
//
// The bucket key reaches rclone through RCLONE_CONFIG_<REMOTE>_* environment
// variables, never through argv (visible in ps) or a config file.
package rclone

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"folder-sync/internal/creds"
	"folder-sync/internal/layout"
	"folder-sync/internal/trace"
)

// Remote is the rclone remote name folder-sync defines through the environment.
const Remote = "fsremote"

// EnvBinary overrides the rclone binary (development and tests use the repo's .tools/rclone).
const EnvBinary = "FOLDER_SYNC_RCLONE"

// Runner runs rclone for one bucket key.
type Runner struct {
	Bin    string
	Layout layout.Layout
	Creds  creds.Creds
	Log    io.Writer     // rclone's stderr, scrubbed of the key
	Debug  bool          // -vv instead of NOTICE-level logging
	Trace  *trace.Writer // per-process timing (FOLDER_SYNC_TRACE); nil = off
	// FailFast trims rclone's own retries (`sync --watch`): a call against a storage server that is down then fails
	// in seconds instead of minutes. WHY only for --watch: its loop runs the next round anyway, and a person (the
	// desktop app's tray) must see "offline" while it is true, not "syncing" for minutes; a one-off `sync --once`
	// from cron keeps rclone's full retries.
	FailFast bool
}

// FailFastFlags are added to every call when FailFast is set.
var FailFastFlags = []string{"--retries", "1", "--low-level-retries", "2", "--contimeout", "5s"}

// GlobalFlags are passed to every rclone call.
func (r Runner) GlobalFlags() []string {
	level := "NOTICE"
	if r.Debug {
		level = "DEBUG"
	}
	flags := []string{
		"--config", r.Layout.RcloneConf,
		"--cache-dir", r.Layout.Cache,
		"--temp-dir", r.Layout.Tmp,
		"--log-level", level,
	}
	if r.FailFast {
		flags = append(flags, FailFastFlags...)
	}
	return flags
}

// Env is the process environment for rclone: the caller's, minus any RCLONE_*
// variable (so a user's own rclone settings never leak in), plus the remote.
func (r Runner) Env(base []string) []string {
	var env []string
	for _, kv := range base {
		if !strings.HasPrefix(strings.ToUpper(kv), "RCLONE_") {
			env = append(env, kv)
		}
	}
	prefix := "RCLONE_CONFIG_" + strings.ToUpper(Remote) + "_"
	if r.Creds.SessionToken != "" {
		env = append(env, prefix+"SESSION_TOKEN="+r.Creds.SessionToken)
	}
	env = append(env,
		prefix+"TYPE=s3",
		prefix+"PROVIDER="+r.Creds.Provider,
		prefix+"ACCESS_KEY_ID="+r.Creds.AccessKeyID,
		prefix+"SECRET_ACCESS_KEY="+r.Creds.SecretAccessKey,
		prefix+"ENDPOINT="+r.Creds.Endpoint,
		prefix+"REGION="+r.Creds.Region,
		// A bucket-scoped R2 token cannot create buckets; never try.
		prefix+"NO_CHECK_BUCKET=true",
		prefix+"ACL=private",
	)
	return env
}

// Path is an rclone path inside the bucket.
func Path(bucket, key string) string {
	return Remote + ":" + bucket + "/" + strings.TrimLeft(key, "/")
}

// Run runs rclone with the global flags and returns its stdout.
func (r Runner) Run(ctx context.Context, args ...string) ([]byte, error) {
	full := append(append([]string{}, args[:1]...), append(r.GlobalFlags(), args[1:]...)...)
	cmd := exec.CommandContext(ctx, r.Bin, full...)
	cmd.Env = r.Env(os.Environ())
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	started := time.Now()
	err := cmd.Run()
	r.Trace.Since("rclone", started, map[string]any{"verb": args[0]})
	scrubbed := r.Creds.Scrub(stderr.String())
	if r.Log != nil && scrubbed != "" {
		fmt.Fprintf(r.Log, "rclone %s\n%s", args[0], scrubbed)
	}
	if err != nil {
		tail := strings.TrimSpace(scrubbed)
		if len(tail) > 800 {
			tail = "…" + tail[len(tail)-800:]
		}
		return stdout.Bytes(), fmt.Errorf("rclone %s failed: %v: %s", args[0], err, tail)
	}
	return stdout.Bytes(), nil
}

// Version returns the first line of `rclone version`, or an error that says
// what to check when the binary cannot run at all (antivirus on Windows).
// WHY: it passes the same global flags as every other call, because even
// `rclone version` creates ~/.config/rclone when it is not told where its config is.
func Version(bin string, l layout.Layout) (string, error) {
	out, err := exec.Command(bin, append([]string{"version"}, Runner{Layout: l}.GlobalFlags()...)...).Output()
	if err != nil {
		return "", fmt.Errorf("cannot run %s (%v). On Windows, Defender or Smart App Control may be blocking it: "+
			"adding an exclusion is your call, not folder-sync's; init stops here", bin, err)
	}
	line, _, _ := strings.Cut(string(out), "\n")
	return strings.TrimSpace(line), nil
}
