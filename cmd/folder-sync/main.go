// Command folder-sync: point it at any folder; that folder is on every machine
// you use, and readable online. The design is docs/peps/0001-wrap-rclone-and-r2.md;
// the bucket contract apps read is docs/CONTRACT.md.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"

	"folder-sync/internal/account"
	"folder-sync/internal/config"
	"folder-sync/internal/creds"
	"folder-sync/internal/host"
	"folder-sync/internal/layout"
	"folder-sync/internal/push"
	"folder-sync/internal/rclone"
	"folder-sync/internal/rclonebin"
	"folder-sync/internal/s3"
	"folder-sync/internal/service"
	"folder-sync/internal/syncer"
	"folder-sync/internal/viewer"
)

// version is set at build time with -ldflags "-X main.version=…".
var version = "v0-dev"

const usage = `folder-sync %s: this folder, on every machine you use, and readable online.

Usage:
  folder-sync init    [--project NAME] [--bucket NAME] [--dir PATH]   this folder becomes a synced folder
  folder-sync login   [--server URL] [--key]                         sign this machine in (a code you approve in a
                                                                     browser); --key stores a bucket key instead
  folder-sync logout                                                 end this machine's session, delete account.json
  folder-sync whoami                                                 who this machine is signed in as
  folder-sync credentials                                            the credential-process JSON (short-lived keys);
                                                                     exit 3 signed out or revoked
  folder-sync sync    [--once | --watch] [--discover] [--install-service] [--dir PATH]
                                                                     push this machine's changes, pull peers';
                                                                     --once exits 4 signed out, 75 round already running
  folder-sync publish [--viewer] [--dir PATH]                        bring the manifest up to date; --viewer writes
                                                                     the R2-Explorer config and prints its deploy command
  folder-sync publish --public | --private [--dir PATH]              make the folder readable by anyone online, or not
  folder-sync status  [--json] [--dir PATH]                          last push, pull and clean run, per project;
                                                                     --json prints folder-sync-status/1
  folder-sync projects [--json] [--bucket NAME]                      the projects under the key's account root
                                                                     (one LIST): what a new machine can join
  folder-sync version

The key comes from FOLDER_SYNC_ACCESS_KEY_ID, FOLDER_SYNC_SECRET_ACCESS_KEY and
FOLDER_SYNC_ACCOUNT_ID (or FOLDER_SYNC_ENDPOINT); else, signed in (~/.folder-sync/account.json), from
folder-sync's own short-lived keys; else from ~/.folder-sync/credentials.json.
Short-lived keys: FOLDER_SYNC_CREDENTIAL_PROCESS, a JSON array (the argv of a program) that prints them; see README.
The accounts server: --server, else FOLDER_SYNC_SERVER, else ` + account.DefaultServer + ` (docs/peps/0003).
Everything folder-sync keeps lives in ~/.folder-sync/, never in AppData.
Design: docs/peps/0001-wrap-rclone-and-r2.md. App contract: docs/CONTRACT.md.
`

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		fmt.Fprintf(stdout, usage, version)
		return 0
	}
	var err error
	switch args[0] {
	case "init":
		err = cmdInit(args[1:], stdout)
	case "login":
		err = cmdLogin(args[1:], stdout)
	case "logout":
		err = cmdLogout(args[1:], stdout)
	case "whoami":
		err = cmdWhoami(args[1:], stdout)
	case "credentials":
		return cmdCredentials(args[1:], stdout, stderr)
	case "sync":
		err = cmdSync(args[1:], stdout)
	case "publish":
		err = cmdPublish(args[1:], stdout)
	case "status":
		err = cmdStatus(args[1:], stdout)
	case "projects":
		err = cmdProjects(args[1:], stdout, stderr)
	case "version":
		l := mustLayout()
		v, _ := rclone.Version(rcloneBinary(l), l)
		fmt.Fprintf(stdout, "folder-sync %s (%s/%s), rclone pinned %s, found: %s\n", version, runtime.GOOS, runtime.GOARCH, rclonebin.Version, orNone(v))
	default:
		fmt.Fprintf(stderr, "folder-sync: unknown command %q\n\n", args[0])
		fmt.Fprintf(stderr, usage, version)
		return 2
	}
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		fmt.Fprintf(stderr, "folder-sync %s: %v\n", args[0], err)
		var shared config.ErrSharedIsV1
		switch {
		case errors.As(err, &shared):
			return 3
		case errors.Is(err, creds.ErrSignedOut):
			return 4 // the credential process said exit 3: signed out or revoked
		case errors.Is(err, syncer.ErrBusy):
			return 75 // EX_TEMPFAIL: another round holds this folder's lock; nothing was done
		case errors.Is(err, account.ErrNotSignedIn), errors.Is(err, account.ErrSignedOut):
			return 3 // signed out: the credential-process convention (PEP 0002), for whoami and publish too
		}
		return 1
	}
	return 0
}

func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}

func mustLayout() layout.Layout {
	l, err := layout.For(runtime.GOOS, os.Getenv)
	if err != nil {
		fmt.Fprintln(os.Stderr, "folder-sync:", err)
		os.Exit(1)
	}
	return l
}

func ensureDirs(l layout.Layout) error {
	for _, dir := range l.Dirs() {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	if _, err := os.Stat(l.RcloneConf); errors.Is(err, os.ErrNotExist) {
		// An empty config: rclone reads remotes from the environment and never looks in AppData.
		if err := os.WriteFile(l.RcloneConf, []byte("# folder-sync passes its remote through the environment; this file stays empty.\n"), 0o600); err != nil {
			return err
		}
	}
	return nil
}

// rcloneBinary is $FOLDER_SYNC_RCLONE, else ~/.folder-sync/bin/rclone.
func rcloneBinary(l layout.Layout) string {
	if bin := os.Getenv(rclone.EnvBinary); bin != "" {
		return bin
	}
	return l.Rclone
}

// ensureRclone installs the pinned rclone when it is missing and checks it runs.
func ensureRclone(l layout.Layout, out io.Writer) (string, error) {
	bin := rcloneBinary(l)
	if _, err := os.Stat(bin); errors.Is(err, os.ErrNotExist) {
		if os.Getenv(rclone.EnvBinary) != "" {
			return "", fmt.Errorf("%s=%s does not exist", rclone.EnvBinary, bin)
		}
		fmt.Fprintf(out, "Installing rclone %s into %s (checksum-pinned)…\n", rclonebin.Version, l.Bin)
		base := os.Getenv("FOLDER_SYNC_RCLONE_BASE_URL")
		if base == "" {
			base = rclonebin.BaseURL
		}
		if err := rclonebin.Install(base, runtime.GOOS, runtime.GOARCH, bin); err != nil {
			return "", err
		}
	}
	v, err := rclone.Version(bin, l)
	if err != nil {
		return "", err
	}
	if !rclonebin.AtLeast(v, rclonebin.Version) {
		return "", fmt.Errorf("%s is %q; folder-sync needs rclone ≥ %s", bin, v, rclonebin.Version)
	}
	return bin, nil
}

func folderFlag(fs *flag.FlagSet) *string {
	return fs.String("dir", ".", "the synced folder (default: the current directory)")
}

func findFolder(dir string) (string, error) {
	return config.Find(dir)
}

func cmdInit(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("init", flag.ContinueOnError)
	project := fs.String("project", "", "project name, the bucket prefix (default: the folder's name)")
	bucket := fs.String("bucket", "", "R2 bucket (default: "+config.DefaultBucket+")")
	dir := folderFlag(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	folder, err := filepath.Abs(*dir)
	if err != nil {
		return err
	}
	if info, err := os.Stat(folder); err != nil || !info.IsDir() {
		return fmt.Errorf("%s is not a folder", folder)
	}
	l := mustLayout()
	if err := ensureDirs(l); err != nil {
		return err
	}
	bin, err := ensureRclone(l, out)
	if err != nil {
		return err
	}
	v, _ := rclone.Version(bin, l)
	fmt.Fprintf(out, "rclone: %s (%s)\n", v, bin)

	h, minted, err := host.Ensure(l.HostFile)
	if err != nil {
		return err
	}
	if minted {
		fmt.Fprintf(out, "host:   minted %s (%s) in %s\n", h.ID, h.Name, l.HostFile)
	} else {
		fmt.Fprintf(out, "host:   %s (%s)\n", h.ID, h.Name)
	}

	resolver := creds.NewResolver(l.Credentials, l.Session, credentialEnv(l, os.Getenv, os.Executable))
	c, credsErr := resolver.Current()
	if credsErr != nil && resolver.UsesProcess() {
		return credsErr // a configured credential process that fails is an error, not "no key yet"
	}

	var cfg config.Config
	if _, statErr := os.Stat(filepath.Join(folder, config.FileName)); statErr == nil {
		cfg, err = config.Load(folder)
		if err != nil {
			return err
		}
		if (*project != "" && *project != cfg.Project) || (*bucket != "" && *bucket != cfg.Bucket) {
			return fmt.Errorf("%s is already project %q in bucket %q; edit %s to change it", folder, cfg.Project, cfg.Bucket, config.FileName)
		}
		if credsErr == nil {
			if err := syncer.CheckBucket(c, cfg.Bucket); err != nil {
				return err
			}
		}
		fmt.Fprintf(out, "config: %s already exists (project %q, bucket %q)\n", config.FileName, cfg.Project, cfg.Bucket)
	} else {
		name := *project
		if name == "" {
			name = config.ProjectFromFolder(folder)
		}
		b := *bucket
		if b == "" && credsErr == nil && c.Bucket != "" {
			b = c.Bucket // credentials bound to one bucket name it for us
		}
		if b == "" {
			b = config.DefaultBucket
		}
		cfg = config.New(name, b)
		if err := cfg.Validate(); err != nil {
			return err
		}
		if credsErr == nil {
			if err := syncer.CheckBucket(c, cfg.Bucket); err != nil {
				return err
			}
		}
		if err := config.Write(folder, cfg); err != nil {
			return err
		}
		fmt.Fprintf(out, "config: wrote %s (project %q, bucket %q)\n", filepath.Join(folder, config.FileName), cfg.Project, cfg.Bucket)
	}
	if credsErr != nil {
		// WHY no registration yet: it records the account root, which only a key can tell (`sync` registers it).
		fmt.Fprintf(out, "key:    none yet. Next: set the key in the environment, or run `folder-sync login`\n")
		return nil
	}
	stateDir := filepath.Join(l.Projects, syncer.StateKey(cfg.Project, folder, c.Prefix))
	if err := syncer.EnsureRegistered(l, stateDir, syncer.Registration{Project: cfg.Project, Bucket: cfg.Bucket, Folder: folder, HostID: h.ID, Root: c.Prefix}); err != nil {
		return err
	}
	client := &s3.Client{Endpoint: c.Endpoint, Region: c.Region, AccessKeyID: c.AccessKeyID, SecretAccessKey: c.SecretAccessKey, SessionToken: c.SessionToken}
	if c.Prefix != "" {
		// A prefix-scoped key may not HEAD the bucket; one LIST under its own root proves it works.
		if err := client.ListOne(cfg.Bucket, c.Prefix); err != nil {
			return fmt.Errorf("key check: %w", err)
		}
		fmt.Fprintf(out, "key:    %s can reach prefix %q in bucket %q (one LIST)\n", c.Redacted(), c.Prefix, cfg.Bucket)
	} else {
		if err := client.HeadBucket(cfg.Bucket); err != nil {
			return fmt.Errorf("key check: %w", err)
		}
		fmt.Fprintf(out, "key:    %s can reach bucket %q (one HEAD)\n", c.Redacted(), cfg.Bucket)
	}
	fmt.Fprintf(out, "Next:   folder-sync sync --once   (or --watch, or --install-service)\n")
	return nil
}

func cmdLogin(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("login", flag.ContinueOnError)
	server := fs.String("server", "", "the accounts server or an app's own mount (default: $"+account.EnvServer+", else "+account.DefaultServer+")")
	key := fs.Bool("key", false, "store a bucket-scoped R2 key instead (v0's login)")
	asJSON := fs.Bool("json", false, "print folder-sync-login/1 events, one JSON object per line, for an app to drive (docs/peps/0006)")
	printToken := fs.Bool("print-token", false, "with --json: hand the session to the caller in the last event instead of writing account.json")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *key {
		if *server != "" || *asJSON || *printToken {
			return fmt.Errorf("--key is exclusive with --server, --json and --print-token")
		}
		return loginKey(out)
	}
	if *printToken && !*asJSON {
		return fmt.Errorf("--print-token needs --json: it is for an app reading a pipe, never a terminal")
	}
	return loginDevice(*server, out, loginMode{json: *asJSON, printToken: *printToken})
}

// loginKey is v0's login: a bucket key from the environment, else asked for on the terminal.
func loginKey(out io.Writer) error {
	l := mustLayout()
	if err := ensureDirs(l); err != nil {
		return err
	}
	c, fromEnv, err := creds.FromEnv(os.Getenv)
	if err != nil {
		return err
	}
	if !fromEnv {
		if !term.IsTerminal(int(os.Stdin.Fd())) {
			return fmt.Errorf("no key in the environment and no terminal to ask on: set %s, %s and %s, then run login again",
				creds.EnvAccessKeyID, creds.EnvSecretAccessKey, creds.EnvAccountID)
		}
		reader := bufio.NewReader(os.Stdin)
		ask := func(prompt string) string {
			fmt.Fprint(out, prompt)
			line, _ := reader.ReadString('\n')
			return strings.TrimSpace(line)
		}
		account := ask("R2 account id (Cloudflare dashboard → R2 → Account details): ")
		id := ask("Access key id: ")
		fmt.Fprint(out, "Secret access key (not shown): ")
		secret, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprintln(out)
		if err != nil {
			return err
		}
		c = creds.Creds{AccessKeyID: id, SecretAccessKey: strings.TrimSpace(string(secret)),
			Endpoint: "https://" + account + ".r2.cloudflarestorage.com"}
		if account == "" || id == "" || c.SecretAccessKey == "" {
			return fmt.Errorf("account id, key id and secret are all needed")
		}
	}
	if err := creds.Save(l.Credentials, c); err != nil {
		return err
	}
	c.Source = l.Credentials
	fmt.Fprintf(out, "Stored %s (mode 0600).\n", c.Redacted())
	if a, err := account.Load(l.Account); err == nil {
		fmt.Fprintf(out, "Note: this machine is also signed in as %s, which takes precedence over a stored key; `folder-sync logout` to use this key.\n", a.User.Email)
	}
	return nil
}

func openProject(dir string, out io.Writer) (*syncer.Project, error) {
	folder, err := findFolder(dir)
	if err != nil {
		return nil, err
	}
	l := mustLayout()
	if err := ensureDirs(l); err != nil {
		return nil, err
	}
	bin, err := ensureRclone(l, out)
	if err != nil {
		return nil, err
	}
	p, err := syncer.Open(folder, l, credentialEnv(l, os.Getenv, os.Executable), bin, out)
	if err != nil {
		return nil, err
	}
	// signed in: the accounts server takes this machine's deletes while its keys are read-only (over quota, PEP 0003 §3.7)
	if a, client, err := signedIn(l); err == nil {
		p.RemoteDelete = func(ctx context.Context, job string, fromSeq int64, paths []string) (syncer.DeleteAnswer, error) {
			data, err := client.DeleteFiles(ctx, a.Token, p.Config.Project, p.Host.ID, job, fromSeq, paths)
			var refused *account.ServerError
			if errors.As(err, &refused) && refused.Code == "manifest_changed" {
				return syncer.DeleteAnswer{}, fmt.Errorf("%w: %v", syncer.ErrManifestChanged, err)
			}
			if errors.As(err, &refused) && refused.Status == 413 {
				return syncer.DeleteAnswer{}, fmt.Errorf("%w: %v", syncer.ErrTooLarge, err)
			}
			if err != nil {
				return syncer.DeleteAnswer{}, err
			}
			var answer syncer.DeleteAnswer
			if err := json.Unmarshal(data, &answer); err != nil {
				return syncer.DeleteAnswer{}, fmt.Errorf("the accounts server's answer is not JSON")
			}
			return answer, nil
		}
	}
	return p, nil
}

func cmdSync(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("sync", flag.ContinueOnError)
	once := fs.Bool("once", false, "run one round and exit (the default)")
	watch := fs.Bool("watch", false, "run a round every `interval` (from .folder-sync.toml) until stopped")
	install := fs.Bool("install-service", false, "write the autostart definition for `sync --watch` and print how to enable it")
	discover := fs.Bool("discover", false, "look for new machines this round (one LIST) instead of every 5 min")
	noPush := fs.Bool("no-push", false, "poll every `interval` only: no folder watcher, no hub, no announce after --once (docs/peps/0005)")
	events := fs.Bool("events", false, "with --watch: print folder-sync-event/1 JSON lines on stdout (human lines go to stderr), for an app's status")
	dir := folderFlag(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *once && *watch {
		return fmt.Errorf("--once and --watch are exclusive")
	}
	if *install {
		return installService(*dir, out)
	}
	if *events && !*watch {
		return fmt.Errorf("--events needs --watch")
	}
	var ev *eventWriter
	if *events {
		ev = &eventWriter{out: out}
		out = os.Stderr
	}
	p, err := openProject(*dir, out)
	if err != nil {
		return err
	}
	defer p.Close()
	if !*watch {
		result, err := p.Round(context.Background(), syncer.Options{ForceDiscover: *discover})
		if err != nil {
			return err
		}
		printResult(out, p, result)
		if result.ManifestWritten && !*noPush {
			announceOnce(p)
		}
		return nil
	}
	return watchLoop(p, out, *noPush, ev)
}

func watchLoop(p *syncer.Project, out io.Writer, noPush bool, ev *eventWriter) error {
	p.Rclone.FailFast = true // a down server shows as a failed round in seconds; the loop tries again (rclone.FailFast)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	interval := p.Config.IntervalDuration()

	// PEP 0005: a round starts when something changed (the folder watcher, the folder's hub), not only on a timer;
	// the timer stays as the safety net. --no-push is the old loop exactly.
	var watcher *push.Watcher
	var hub *push.Hub
	if !noPush {
		watcher = push.Watch(p.Folder, p.Config.PeersDir)
		defer watcher.Close()
		hub = startHub(ctx, p, ev)
	}
	{
		state := syncEvent{Event: "watching", Folder: p.Folder, Project: p.Config.Project, Host: p.Host.ID, Hub: "off"}
		if watcher != nil {
			state.Watcher = boolPtr(watcher.Healthy())
		}
		if hub != nil {
			state.Hub = "on"
		}
		ev.emit(state)
	}
	mode := "polling only (--no-push)"
	if !noPush {
		mode = fmt.Sprintf("folder watcher %s, hub %s", onOff(watcher.Healthy()), hubState(hub))
	}
	fmt.Fprintf(out, "Watching %s every %s (project %q, host %s); %s. Stop with Ctrl-C.\n", p.Folder, interval, p.Config.Project, p.Host.ID, mode)

	var fsChanged <-chan struct{}
	var hubEvents <-chan push.Event
	if watcher != nil {
		fsChanged = watcher.Changed
	}
	if hub != nil {
		hubEvents = hub.Events
	}
	opts := syncer.Options{ForceReconcile: true} // docs/peps/0001 §4: reconcile at start, then hourly
	source := "start"
	for {
		ev.emit(syncEvent{Event: "round_start", Source: source})
		started := time.Now()
		result, err := p.Round(ctx, opts)
		opts = syncer.Options{}
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			kind, why := classifyRound(err, p.Rclone.Creds.Endpoint, hubServer(p))
			ev.emit(syncEvent{Event: "round", OK: boolPtr(false), Kind: kind, Why: why, Ms: time.Since(started).Milliseconds()})
			fmt.Fprintf(out, "%s round failed: %v\n", time.Now().Format("15:04:05"), err)
		} else {
			ev.emit(syncEvent{Event: "round", OK: boolPtr(true), Uploaded: len(result.Uploaded), Deleted: len(result.Deleted),
				Fetched: fetched(result), Peers: len(result.Peers), Ms: time.Since(started).Milliseconds()})
			if result.ManifestWritten {
				hub.Announce(p.Host.ID, p.ManifestSeq())
			}
			if len(result.Uploaded)+len(result.Deleted)+fetched(result) > 0 || result.Reconciled {
				printResult(out, p, result)
			}
		}
		wait := push.NextWait(hub.Connected(), watcher.Healthy(), interval)
		if noPush {
			wait = interval
		}
		var discover, stopped bool
		source, discover, stopped = nextKick(ctx, p, fsChanged, hubEvents, wait)
		if stopped {
			ev.emit(syncEvent{Event: "stopped"})
			fmt.Fprintln(out, "Stopped.")
			return nil
		}
		opts.ForceDiscover = discover
		p.Trace.Event("kick", map[string]any{"source": source, "discover": discover})
	}
	ev.emit(syncEvent{Event: "stopped"})
	fmt.Fprintln(out, "Stopped.")
	return nil
}

// nextKick waits for the next reason to run a round: the folder changed, the hub named a host (a new one also asks
// for a discover), the hub said hello (catch up), or the fallback timer. Hub messages about this machine itself are
// echoes and are skipped.
func nextKick(ctx context.Context, p *syncer.Project, fsChanged <-chan struct{}, hubEvents <-chan push.Event, wait time.Duration) (source string, discover, stopped bool) {
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return "", false, true
		case <-fsChanged:
			return "fs", false, false
		case ev := <-hubEvents:
			known := p.KnownPeers()
			if ev.Hello {
				behind, unknown := false, false
				for id, seq := range ev.Hosts {
					if id == p.Host.ID {
						continue
					}
					have, ok := known[id]
					behind = behind || !ok || have < seq
					unknown = unknown || !ok
				}
				if behind {
					return "hello", unknown, false
				}
				continue // nothing new
			}
			if ev.Host == p.Host.ID {
				continue
			}
			if have, ok := known[ev.Host]; ok && have >= ev.Seq {
				continue // already have it
			} else {
				return "hub", !ok, false
			}
		case <-timer.C:
			return "timer", false, false
		}
	}
}

func onOff(b bool) string {
	if b {
		return "on"
	}
	return "off"
}

func hubState(h *push.Hub) string {
	if h == nil {
		return "off (not signed in to an account)"
	}
	return "on (" + h.URL + ")"
}

// announceOnce tells the folder's hub about this round's manifest (sync --once; PEP 0005), when signed in.
func announceOnce(p *syncer.Project) {
	server, token, ok := hubAccount(p)
	if !ok {
		return
	}
	u, err := push.EventsURL(server, p.Config.Project)
	if err != nil {
		return
	}
	if err := push.AnnounceOnce(context.Background(), u, token, userAgent(p.Layout), p.Host.ID, p.ManifestSeq(), 5*time.Second); err != nil {
		p.Trace.Event("hub", map[string]any{"state": "announce failed"})
	}
}

// hubServer is the account server this machine syncs through, or "" (for the offline probe of a failed round).
func hubServer(p *syncer.Project) string {
	server, _, ok := hubAccount(p)
	if !ok {
		return ""
	}
	return server
}

// hubAccount is the account server and token the hub is reached with, when this machine syncs through its account.
func hubAccount(p *syncer.Project) (server, token string, ok bool) {
	if os.Getenv(creds.EnvCredentialProcess) != "" || os.Getenv(creds.EnvAccessKeyID) != "" || os.Getenv(creds.EnvSecretAccessKey) != "" {
		return "", "", false
	}
	a, err := account.Current(p.Layout.Account, os.Getenv)
	if err != nil || a.Server == "" || a.Token == "" {
		return "", "", false
	}
	return a.Server, a.Token, true
}

// startHub connects to the folder's hub when this machine syncs through its account (the same condition under which
// folder-sync is its own credential process): a stored key or a key in the environment has no account to ask.
func startHub(ctx context.Context, p *syncer.Project, ev *eventWriter) *push.Hub {
	server, token, ok := hubAccount(p)
	if !ok {
		return nil
	}
	u, err := push.EventsURL(server, p.Config.Project)
	if err != nil {
		return nil
	}
	hub := push.NewHub(u, token, userAgent(p.Layout))
	hub.OnState = func(state string) {
		p.Trace.Event("hub", map[string]any{"state": state})
		ev.emit(syncEvent{Event: "hub", Hub: state})
	}
	go hub.Run(ctx)
	return hub
}

func fetched(r syncer.Result) int {
	n := 0
	for _, peer := range r.Peers {
		n += peer.Fetched + peer.Removed
	}
	return n
}

func printResult(out io.Writer, p *syncer.Project, r syncer.Result) {
	stamp := time.Now().Format("15:04:05")
	fmt.Fprintf(out, "%s push: %d uploaded, %d deleted to _trash/", stamp, len(r.Uploaded), len(r.Deleted))
	if len(r.HeldDeletes) > 0 {
		fmt.Fprintf(out, ", %d deletes held (max_delete)", len(r.HeldDeletes))
	}
	if r.ManifestWritten {
		fmt.Fprint(out, ", manifest rewritten")
	}
	if r.Reconciled {
		fmt.Fprint(out, " (after a full reconcile)")
	}
	fmt.Fprintln(out)
	for _, path := range r.Uploaded {
		fmt.Fprintf(out, "  ↑ %s\n", path)
	}
	for _, path := range r.Deleted {
		fmt.Fprintf(out, "  ✗ %s → _trash/\n", path)
	}
	for _, peer := range r.Peers {
		state := fmt.Sprintf("%d fetched, %d removed", peer.Fetched, peer.Removed)
		if peer.NotModified {
			state = "unchanged (304)"
		}
		fmt.Fprintf(out, "%s pull: %s %s (%s): %s → %s/%s/\n", stamp, short(peer.ID), peer.Name, plural(peer.Files, "file"), state, p.Config.PeersDir, short(peer.ID))
	}
	if len(r.Peers) == 0 {
		fmt.Fprintf(out, "%s pull: no peers known yet (new machines are looked for every 5 min)\n", stamp)
	}
}

func short(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func plural(n int, word string) string {
	if n == 1 {
		return "1 " + word
	}
	return fmt.Sprintf("%d %ss", n, word)
}

func installService(dir string, out io.Writer) error {
	folder, err := findFolder(dir)
	if err != nil {
		return err
	}
	cfg, err := config.Load(folder)
	if err != nil {
		return err
	}
	l := mustLayout()
	if err := ensureDirs(l); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	user := ""
	if runtime.GOOS == "windows" {
		if domain, name := os.Getenv("USERDOMAIN"), os.Getenv("USERNAME"); name != "" {
			user = name
			if domain != "" {
				user = domain + `\` + name
			}
		}
	}
	key := syncer.StateKey(cfg.Project, folder, syncer.RegisteredRoot(l, cfg.Project, folder))
	file, err := service.Generate(service.Spec{GOOS: runtime.GOOS, Exe: exe, Folder: folder, Project: cfg.Project,
		StateKey: key, User: user, Layout: l})
	if err != nil {
		return err
	}
	if err := file.Write(); err != nil {
		return err
	}
	fmt.Fprintf(out, "Wrote %s\nfolder-sync does not register services itself. To start `sync --watch` at login, run:\n", file.Path)
	for _, command := range file.Commands {
		fmt.Fprintf(out, "  %s\n", command)
	}
	fmt.Fprintf(out, "Its log: %s\n", filepath.Join(l.Logs, key+".log"))
	return nil
}

func cmdPublish(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("publish", flag.ContinueOnError)
	withViewer := fs.Bool("viewer", false, "write the R2-Explorer viewer config and print its deploy command")
	public := fs.Bool("public", false, "make the folder readable by anyone online (signed in: folder-sync login)")
	private := fs.Bool("private", false, "make the folder readable online only by you and its readers")
	dir := folderFlag(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *public || *private {
		if *public && *private || *withViewer {
			return fmt.Errorf("--public, --private and --viewer are exclusive")
		}
		folder, err := findFolder(*dir)
		if err != nil {
			return err
		}
		cfg, err := config.Load(folder)
		if err != nil {
			return err
		}
		visibility := "private"
		if *public {
			visibility = "public"
		}
		return setVisibility(cfg.Project, visibility, out)
	}
	p, err := openProject(*dir, out)
	if err != nil {
		return err
	}
	defer p.Close()
	if *withViewer { // refuse before any upload if the viewer settings are incomplete
		if err := viewerSettings(p).Validate(); err != nil {
			return err
		}
	}
	result, err := p.Round(context.Background(), syncer.Options{PushOnly: true})
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "Manifest up to date: %s/hosts/%s/manifest.json (%d uploaded, %d deleted to _trash/, rewritten: %v)\n",
		p.Config.Project, p.Host.ID, len(result.Uploaded), len(result.Deleted), result.ManifestWritten)
	fmt.Fprintf(out, "Apps read it per docs/CONTRACT.md: bucket %q, prefix %s/hosts/.\n", p.Config.Bucket, p.Config.Project)
	if !*withViewer {
		return nil
	}
	settings := viewerSettings(p)
	viewerDir := filepath.Join(p.Layout.Viewer, p.Config.Bucket)
	commands, err := viewer.Write(viewerDir, settings)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "\nWrote the R2-Explorer %s viewer for bucket %q to %s\n", viewer.R2ExplorerVersion, p.Config.Bucket, viewerDir)
	fmt.Fprintf(out, "folder-sync does not deploy or create Cloudflare resources. Before deploying:\n")
	fmt.Fprintf(out, "  1. Zero Trust → Access → Applications → Add a self-hosted application for %s (team %q).\n", settings.Domain, settings.AccessTeam)
	fmt.Fprintf(out, "  2. Keep the bucket private: no r2.dev public URL and no custom domain on bucket %q.\n", p.Config.Bucket)
	fmt.Fprintf(out, "Then deploy with:\n")
	for _, command := range commands {
		fmt.Fprintf(out, "  %s\n", command)
	}
	fmt.Fprintf(out, "Viewer address (after deploy): https://%s/\n", settings.Domain)
	return nil
}

func viewerSettings(p *syncer.Project) viewer.Settings {
	name := p.Config.Viewer.WorkerName
	if name == "" {
		name = "folder-sync-viewer-" + p.Config.Bucket
	}
	return viewer.Settings{Bucket: p.Config.Bucket, AccessTeam: p.Config.Viewer.AccessTeam, Domain: p.Config.Viewer.Domain, WorkerName: name}
}

// StatusSchema names `status --json`.
const StatusSchema = "folder-sync-status/1"

type statusDoc struct {
	Schema   string          `json:"schema"`
	Host     statusHost      `json:"host"`
	Projects []statusProject `json:"projects"`
}

type statusHost struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type statusProject struct {
	Project string           `json:"project"`
	Bucket  string           `json:"bucket"`
	Root    string           `json:"root"`
	Folder  string           `json:"folder"`
	Last    *syncer.LastSync `json:"last"` // null before the first round
}

// ProjectsSchema names `projects --json`.
const ProjectsSchema = "folder-sync-projects/1"

// cmdProjects lists the projects under the credentials' account root (one delimiter LIST, nothing downloaded).
// WHY: an app that signs a person's second machine in needs to know which folders that person already syncs, so the
// machine joins them instead of starting empty ones of the same name (vibetracks PEP 0011b).
func cmdProjects(args []string, out, errOut io.Writer) error {
	fs := flag.NewFlagSet("projects", flag.ContinueOnError)
	bucket := fs.String("bucket", "", "the bucket (default: the one the credentials are bound to, else "+config.DefaultBucket+")")
	asJSON := fs.Bool("json", false, "print one folder-sync-projects/1 JSON document")
	if err := fs.Parse(args); err != nil {
		return err
	}
	l := mustLayout()
	if err := ensureDirs(l); err != nil {
		return err
	}
	// WHY progress to stderr under --json: on a new machine this is often the first command, so it installs rclone,
	// and an app parsing stdout must get exactly one JSON document
	progress := out
	if *asJSON {
		progress = errOut
	}
	bin, err := ensureRclone(l, progress)
	if err != nil {
		return err
	}
	c, err := creds.NewResolver(l.Credentials, l.Session, credentialEnv(l, os.Getenv, os.Executable)).Current()
	if err != nil {
		return err
	}
	b := *bucket
	if b == "" {
		b = c.Bucket
	}
	if b == "" {
		b = config.DefaultBucket
	}
	if err := syncer.CheckBucket(c, b); err != nil {
		return err
	}
	runner := rclone.Runner{Bin: bin, Layout: l, Creds: c}
	listed, err := runner.Run(context.Background(), "lsjson", "--dirs-only", "--no-mimetype", "--no-modtime",
		rclone.Path(b, strings.TrimSuffix(c.Prefix, "/")))
	if err != nil && !strings.Contains(err.Error(), "directory not found") {
		return err
	}
	var dirs []struct{ Path string }
	if len(listed) > 0 {
		if err := json.Unmarshal(listed, &dirs); err != nil {
			return fmt.Errorf("rclone lsjson: %w", err)
		}
	}
	names := []string{}
	for _, dir := range dirs {
		if !strings.HasPrefix(dir.Path, "_") && config.ValidateProject(dir.Path) == nil {
			names = append(names, dir.Path)
		}
	}
	sort.Strings(names)
	if *asJSON {
		data, err := json.MarshalIndent(map[string]any{"schema": ProjectsSchema, "bucket": b, "root": c.Prefix, "projects": names}, "", "  ")
		if err != nil {
			return err
		}
		fmt.Fprintln(out, string(data))
		return nil
	}
	for _, name := range names {
		fmt.Fprintln(out, name)
	}
	return nil
}

func cmdStatus(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	dir := fs.String("dir", "", "show only this synced folder")
	asJSON := fs.Bool("json", false, "print one folder-sync-status/1 JSON document")
	if err := fs.Parse(args); err != nil {
		return err
	}
	l := mustLayout()
	h, err := host.Load(l.HostFile)
	if err != nil {
		return err
	}
	only := ""
	if *dir != "" {
		if only, err = findFolder(*dir); err != nil {
			return err
		}
	}
	regs, lasts := syncer.AllStates(l)
	if *asJSON {
		doc := statusDoc{Schema: StatusSchema, Host: statusHost{ID: h.ID, Name: h.Name}, Projects: []statusProject{}}
		for i, reg := range regs {
			if only != "" && reg.Folder != only {
				continue
			}
			entry := statusProject{Project: reg.Project, Bucket: reg.Bucket, Root: reg.Root, Folder: reg.Folder}
			if lasts[i].Schema != "" {
				last := lasts[i]
				last.Root = reg.Root // a round from before roots existed has none; the registration is the truth
				entry.Last = &last
			}
			doc.Projects = append(doc.Projects, entry)
		}
		data, err := json.MarshalIndent(doc, "", "  ")
		if err != nil {
			return err
		}
		fmt.Fprintln(out, string(data))
		return nil
	}
	fmt.Fprintf(out, "host %s (%s), state in %s\n", h.ID, h.Name, l.Root)
	shown := 0
	for i, reg := range regs {
		if only != "" && reg.Folder != only {
			continue
		}
		shown++
		last := lasts[i]
		fmt.Fprintf(out, "\n%s  (bucket %s)\n  folder:          %s\n", reg.Project, reg.Bucket, reg.Folder)
		if last.RoundFinished == "" {
			fmt.Fprintf(out, "  no round yet:    run `folder-sync sync --once`\n")
			continue
		}
		result := "ok"
		if !last.OK {
			result = "FAILED: " + last.Error
		}
		fmt.Fprintf(out, "  last round:      %s %s\n", when(last.RoundFinished), result)
		fmt.Fprintf(out, "  last push:       %s\n", when(last.LastPush))
		fmt.Fprintf(out, "  last pull:       %s\n", when(last.LastPull))
		fmt.Fprintf(out, "  last clean run:  %s\n", when(last.LastCleanRun))
		fmt.Fprintf(out, "  last reconcile:  %s\n", when(last.LastReconcile))
		fmt.Fprintf(out, "  last peer scan:  %s\n", when(last.LastDiscover))
		fmt.Fprintf(out, "  peers:           %d\n", len(last.Peers))
		for _, peer := range last.Peers {
			fmt.Fprintf(out, "    %s %-16s %s, manifest seq %d\n", short(peer.ID), peer.Name, plural(peer.Files, "file"), peer.Seq)
		}
		fmt.Fprintf(out, "  skipped:         %d\n", len(last.Skipped))
		for _, s := range last.Skipped {
			fmt.Fprintf(out, "    %s: %s\n", s.Path, s.Reason)
		}
		if len(last.HeldDeletes) > 0 {
			fmt.Fprintf(out, "  held deletes:    %d (over max_delete)\n", len(last.HeldDeletes))
		}
		fmt.Fprintf(out, "  conflicts:       %d\n", len(last.Conflicts))
		for _, c := range last.Conflicts {
			fmt.Fprintf(out, "    %s/%s → kept at %s\n", short(c.Peer), c.Path, c.KeptAt)
		}
	}
	if shown == 0 {
		fmt.Fprintln(out, "\nNo synced folders yet: run `folder-sync init` in one.")
	}
	return nil
}

func when(stamp string) string {
	if stamp == "" {
		return "never"
	}
	t, err := time.Parse(time.RFC3339Nano, stamp)
	if err != nil {
		return stamp
	}
	ago := time.Since(t).Round(time.Second)
	return fmt.Sprintf("%s (%s ago)", t.Local().Format("2006-01-02 15:04:05"), ago)
}
