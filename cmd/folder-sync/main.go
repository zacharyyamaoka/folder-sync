// Command folder-sync: point it at any folder; that folder is on every machine
// you use, and readable online. The design is docs/peps/0001-wrap-rclone-and-r2.md;
// the bucket contract apps read is docs/CONTRACT.md.
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"

	"folder-sync/internal/config"
	"folder-sync/internal/creds"
	"folder-sync/internal/host"
	"folder-sync/internal/layout"
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
  folder-sync login                                                  store the bucket key in ~/.folder-sync/
  folder-sync sync    [--once | --watch] [--install-service] [--dir PATH]
                                                                     push this machine's changes, pull peers'
  folder-sync publish [--viewer] [--dir PATH]                        bring the manifest up to date; --viewer writes
                                                                     the R2-Explorer config and prints its deploy command
  folder-sync status  [--dir PATH]                                   last push, pull and clean run, per project
  folder-sync version

The key comes from FOLDER_SYNC_ACCESS_KEY_ID, FOLDER_SYNC_SECRET_ACCESS_KEY and
FOLDER_SYNC_ACCOUNT_ID (or FOLDER_SYNC_ENDPOINT), else from ~/.folder-sync/credentials.json.
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
	case "sync":
		err = cmdSync(args[1:], stdout)
	case "publish":
		err = cmdPublish(args[1:], stdout)
	case "status":
		err = cmdStatus(args[1:], stdout)
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
		if errors.As(err, &shared) {
			return 3
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

	var cfg config.Config
	if _, statErr := os.Stat(filepath.Join(folder, config.FileName)); statErr == nil {
		cfg, err = config.Load(folder)
		if err != nil {
			return err
		}
		if (*project != "" && *project != cfg.Project) || (*bucket != "" && *bucket != cfg.Bucket) {
			return fmt.Errorf("%s is already project %q in bucket %q; edit %s to change it", folder, cfg.Project, cfg.Bucket, config.FileName)
		}
		fmt.Fprintf(out, "config: %s already exists (project %q, bucket %q)\n", config.FileName, cfg.Project, cfg.Bucket)
	} else {
		name := *project
		if name == "" {
			name = config.ProjectFromFolder(folder)
		}
		b := *bucket
		if b == "" {
			b = config.DefaultBucket
		}
		cfg = config.New(name, b)
		if err := cfg.Validate(); err != nil {
			return err
		}
		if err := config.Write(folder, cfg); err != nil {
			return err
		}
		fmt.Fprintf(out, "config: wrote %s (project %q, bucket %q)\n", filepath.Join(folder, config.FileName), cfg.Project, cfg.Bucket)
	}
	stateDir := filepath.Join(l.Projects, syncer.StateKey(cfg.Project, folder))
	if err := syncer.EnsureRegistered(l, stateDir, syncer.Registration{Project: cfg.Project, Bucket: cfg.Bucket, Folder: folder, HostID: h.ID}); err != nil {
		return err
	}

	c, err := creds.Load(l.Credentials, os.Getenv)
	if err != nil {
		fmt.Fprintf(out, "key:    none yet. Next: set the key in the environment, or run `folder-sync login`\n")
		return nil
	}
	client := &s3.Client{Endpoint: c.Endpoint, Region: c.Region, AccessKeyID: c.AccessKeyID, SecretAccessKey: c.SecretAccessKey}
	if err := client.HeadBucket(cfg.Bucket); err != nil {
		return fmt.Errorf("key check: %w", err)
	}
	fmt.Fprintf(out, "key:    %s can reach bucket %q (one HEAD)\n", c.Redacted(), cfg.Bucket)
	fmt.Fprintf(out, "Next:   folder-sync sync --once   (or --watch, or --install-service)\n")
	return nil
}

func cmdLogin(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("login", flag.ContinueOnError)
	if err := fs.Parse(args); err != nil {
		return err
	}
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
	return syncer.Open(folder, l, os.Getenv, bin, out)
}

func cmdSync(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("sync", flag.ContinueOnError)
	once := fs.Bool("once", false, "run one round and exit (the default)")
	watch := fs.Bool("watch", false, "run a round every `interval` (from .folder-sync.toml) until stopped")
	install := fs.Bool("install-service", false, "write the autostart definition for `sync --watch` and print how to enable it")
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
	p, err := openProject(*dir, out)
	if err != nil {
		return err
	}
	defer p.Close()
	if !*watch {
		result, err := p.Round(context.Background(), syncer.Options{})
		if err != nil {
			return err
		}
		printResult(out, p, result)
		return nil
	}
	return watchLoop(p, out)
}

func watchLoop(p *syncer.Project, out io.Writer) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	interval := p.Config.IntervalDuration()
	fmt.Fprintf(out, "Watching %s every %s (project %q, host %s). Stop with Ctrl-C.\n", p.Folder, interval, p.Config.Project, p.Host.ID)
	opts := syncer.Options{ForceReconcile: true} // docs/peps/0001 §4: reconcile at start, then hourly
	for {
		result, err := p.Round(ctx, opts)
		opts.ForceReconcile = false
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			fmt.Fprintf(out, "%s round failed: %v\n", time.Now().Format("15:04:05"), err)
		} else if len(result.Uploaded)+len(result.Deleted)+fetched(result) > 0 || result.Reconciled {
			printResult(out, p, result)
		}
		select {
		case <-ctx.Done():
			fmt.Fprintln(out, "Stopped.")
			return nil
		case <-time.After(interval):
		}
	}
	fmt.Fprintln(out, "Stopped.")
	return nil
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
	file, err := service.Generate(service.Spec{GOOS: runtime.GOOS, Exe: exe, Folder: folder, Project: cfg.Project,
		StateKey: syncer.StateKey(cfg.Project, folder), User: user, Layout: l})
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
	fmt.Fprintf(out, "Its log: %s\n", filepath.Join(l.Logs, syncer.StateKey(cfg.Project, folder)+".log"))
	return nil
}

func cmdPublish(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("publish", flag.ContinueOnError)
	withViewer := fs.Bool("viewer", false, "write the R2-Explorer viewer config and print its deploy command")
	dir := folderFlag(fs)
	if err := fs.Parse(args); err != nil {
		return err
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

func cmdStatus(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	dir := fs.String("dir", "", "show only this synced folder")
	if err := fs.Parse(args); err != nil {
		return err
	}
	l := mustLayout()
	h, err := host.Load(l.HostFile)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "host %s (%s), state in %s\n", h.ID, h.Name, l.Root)
	only := ""
	if *dir != "" {
		if only, err = findFolder(*dir); err != nil {
			return err
		}
	}
	regs, lasts := syncer.AllStates(l)
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
