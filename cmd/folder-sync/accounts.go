package main

// Accounts (docs/peps/0003 §3.5): `login` (the device grant), `logout`, `whoami`, `credentials`, and folder-sync
// using its own `credentials` as the credential process once this machine is signed in.

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"folder-sync/internal/account"
	"folder-sync/internal/creds"
	"folder-sync/internal/host"
	"folder-sync/internal/layout"
)

// credentialEnv is getenv, except that when this machine is signed in (account.json) and neither a credential
// process nor a key is set in the environment, FOLDER_SYNC_CREDENTIAL_PROCESS names this binary's own `credentials`.
// WHY through the credential process and not a second code path: PEP 0002's cache, refresh, exit codes and root rules
// then apply unchanged (internal/creds/process.go). WHY the environment's key still wins: PEP 0003 §3.5 keeps it
// first, so a cloud agent's explicit key is never overridden by a stale sign-in.
// WHY --account <who> in the argv (review r1 #1): session.json's cache is keyed by the argv, so the keys cached for
// A's sign-in are never handed out once account.json is B's; and `credentials` itself refuses an --account that is
// not account.json's (exit 3, which drops the cache).
func credentialEnv(l layout.Layout, getenv func(string) string, executable func() (string, error)) func(string) string {
	if getenv(creds.EnvCredentialProcess) != "" || getenv(creds.EnvAccessKeyID) != "" || getenv(creds.EnvSecretAccessKey) != "" {
		return getenv
	}
	if !account.SignedIn(l.Account, getenv) {
		return getenv
	}
	self, err := executable()
	if err != nil {
		return getenv
	}
	args := []string{self, "credentials"}
	if a, err := account.Current(l.Account, getenv); err == nil {
		args = append(args, "--account", a.Identity())
	}
	argv, err := json.Marshal(args)
	if err != nil {
		return getenv
	}
	return func(name string) string {
		if name == creds.EnvCredentialProcess {
			return string(argv)
		}
		return getenv(name)
	}
}

// userAgent is "folder-sync/<version> (<host name>; <os>)", the host name from host.json when there is one.
func userAgent(l layout.Layout) string {
	name := ""
	if h, err := host.Load(l.HostFile); err == nil {
		name = h.Name
	}
	if name == "" {
		name, _ = os.Hostname()
	}
	return account.UserAgent(version, name, runtime.GOOS)
}

// signedIn loads this machine's sign-in (the account process, else account.json) and a client for its server.
func signedIn(l layout.Layout) (account.Account, *account.Client, error) {
	a, err := account.Current(l.Account, os.Getenv)
	if err != nil {
		return account.Account{}, nil, err
	}
	server, err := account.CheckServer(a.Server)
	if err != nil {
		return account.Account{}, nil, fmt.Errorf("%s: %w", l.Account, err)
	}
	return a, account.NewClient(server, userAgent(l)), nil
}

// loginMode is how `login` talks: text for a person at a terminal, or folder-sync-login/1 events for an app.
type loginMode struct {
	json       bool // one JSON object per line on stdout
	printToken bool // the session goes to the caller in the last event; account.json is not written
}

// LoginSchema names `login --json`'s events.
const LoginSchema = "folder-sync-login/1"

// loginEvent is one line of `login --json`: "device" (open Link; Code is shown only as a cross-check), then
// "signed_in", or "error". Account is set only with --print-token.
type loginEvent struct {
	Schema    string           `json:"schema"`
	Event     string           `json:"event"`
	Link      string           `json:"link,omitempty"`
	Code      string           `json:"user_code,omitempty"`
	ExpiresIn int              `json:"expires_in,omitempty"`
	Server    string           `json:"server,omitempty"`
	User      *account.User    `json:"user,omitempty"`
	Root      string           `json:"root,omitempty"`
	Account   *account.Account `json:"account,omitempty"`
	Error     string           `json:"error,omitempty"`
}

func emit(out io.Writer, ev loginEvent) {
	ev.Schema = LoginSchema
	data, _ := json.Marshal(ev)
	out.Write(append(data, '\n'))
}

// loginDevice signs this machine in with the device grant and stores account.json (or, with --print-token, hands
// the session to the app that ran it: the desktop app keeps it in the OS keychain, docs/peps/0006).
func loginDevice(serverFlag string, out io.Writer, mode loginMode) (err error) {
	if mode.json {
		defer func() {
			if err != nil {
				emit(out, loginEvent{Event: "error", Error: err.Error()})
			}
		}()
	}
	l := mustLayout()
	if err := ensureDirs(l); err != nil {
		return err
	}
	server, err := account.Server(serverFlag, os.Getenv)
	if err != nil {
		return err
	}
	client := account.NewClient(server, userAgent(l))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	device, err := client.StartDevice(ctx)
	if err != nil {
		return err
	}
	if mode.json {
		emit(out, loginEvent{Event: "device", Link: device.Link(), Code: device.Shown(), ExpiresIn: device.ExpiresIn, Server: server})
	} else {
		minutes := (device.ExpiresIn + 59) / 60
		fmt.Fprintf(out, "To sign this machine in, open %s and approve the code %s (it expires in %d min).\n", device.Link(), device.Shown(), minutes)
		fmt.Fprintf(out, "Waiting for the approval…\n")
	}
	token, err := client.AwaitApproval(ctx, device, account.Sleep)
	if err != nil {
		return err
	}
	user, root, err := client.Me(ctx, token)
	if err != nil {
		return err
	}
	signed := account.Account{Schema: account.Schema, Server: server, Token: token, User: user, SignedIn: time.Now().UTC().Format(time.RFC3339)}
	// WHY: keys cached for whoever was signed in before are never this person's (review r1 #1)
	if err := os.Remove(l.Session); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if mode.printToken {
		// WHY no account.json: the caller keeps the session (the desktop app's OS keychain) and hands it back through
		// FOLDER_SYNC_ACCOUNT_PROCESS; a plain-text copy on disk would defeat that.
		emit(out, loginEvent{Event: "signed_in", Server: server, User: &user, Root: root, Account: &signed})
		return nil
	}
	if err := account.Save(l.Account, signed); err != nil {
		return err
	}
	if mode.json {
		emit(out, loginEvent{Event: "signed_in", Server: server, User: &user, Root: root})
		return nil
	}
	fmt.Fprintf(out, "Signed in as %s at %s (account root %s); kept in %s (mode 0600).\n", user.Email, server, root, l.Account)
	if _, ok, _ := creds.FromEnv(os.Getenv); ok {
		fmt.Fprintf(out, "Note: a bucket key is set in the environment; it still wins over this sign-in.\n")
	} else if _, err := os.Stat(l.Credentials); err == nil {
		fmt.Fprintf(out, "Note: the stored key in %s is no longer used while this machine is signed in.\n", l.Credentials)
	}
	fmt.Fprintf(out, "Next:   folder-sync init --project <name>   (in the folder to sync)\n")
	return nil
}

func cmdLogout(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("logout", flag.ContinueOnError)
	if err := fs.Parse(args); err != nil {
		return err
	}
	l := mustLayout()
	a, client, err := signedIn(l)
	if errors.Is(err, account.ErrNotSignedIn) {
		fmt.Fprintln(out, "This machine was not signed in.")
		return nil
	}
	remote := "its session on the server is deleted"
	if err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if signOutErr := client.SignOut(ctx, a.Token); signOutErr != nil {
			remote = fmt.Sprintf("the server could not end its session (%v); it ends when it expires", signOutErr)
		}
	} else {
		remote = fmt.Sprintf("account.json was unreadable (%v)", err)
	}
	if err := os.Remove(l.Account); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// the keys this sign-in cached go with it (review r1 #1)
	if err := os.Remove(l.Session); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	fmt.Fprintf(out, "Signed out: %s deleted, and %s.\n", l.Account, remote)
	return nil
}

func cmdWhoami(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("whoami", flag.ContinueOnError)
	if err := fs.Parse(args); err != nil {
		return err
	}
	l := mustLayout()
	a, client, err := signedIn(l)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	user, root, err := client.Me(ctx, a.Token)
	if errors.Is(err, account.ErrSignedOut) {
		return err
	}
	if err != nil {
		fmt.Fprintf(out, "%s (%s) at %s, as of the last sign-in; the server did not answer: %v\n", a.User.Email, a.User.ID, a.Server, err)
		return nil
	}
	fmt.Fprintf(out, "%s (%s) at %s, account root %s\n", user.Email, user.ID, a.Server, root)
	return nil
}

// cmdCredentials prints this machine's short-lived keys in the credential-process shape (PEP 0002): exit 0, or 3
// signed out or revoked, or 1 for anything transient. folder-sync runs it itself (credentialEnv), with --account
// naming the sign-in it expects: another one is exit 3 too.
func cmdCredentials(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("credentials", flag.ContinueOnError)
	fs.SetOutput(stderr)
	expected := fs.String("account", "", "only for this sign-in (<user id>@<server>); another one exits 3")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	l, err := layout.For(runtime.GOOS, os.Getenv)
	if err != nil {
		fmt.Fprintln(stderr, "folder-sync credentials:", err)
		return 1
	}
	a, client, err := signedIn(l)
	if err == nil && *expected != "" && *expected != a.Identity() {
		fmt.Fprintf(stderr, "folder-sync credentials: this machine is signed in as %s now, not %s: the cached keys are dropped\n", a.Identity(), *expected)
		return creds.ExitSignedOut
	}
	if err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		var keys []byte
		if keys, err = client.Credentials(ctx, a.Token); err == nil {
			stdout.Write(keys)
			if len(keys) == 0 || keys[len(keys)-1] != '\n' {
				io.WriteString(stdout, "\n")
			}
			return 0
		}
	}
	fmt.Fprintf(stderr, "folder-sync credentials: %v\n", err)
	if errors.Is(err, account.ErrNotSignedIn) || errors.Is(err, account.ErrSignedOut) {
		return creds.ExitSignedOut
	}
	return 1
}

// setVisibility is `publish --public | --private`: PATCH /fs/v1/folders/<project> with this machine's session.
func setVisibility(project, visibility string, out io.Writer) error {
	l := mustLayout()
	a, client, err := signedIn(l)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	row, err := client.SetVisibility(ctx, a.Token, project, visibility)
	if err != nil {
		return err
	}
	if row.Visibility == "public" {
		fmt.Fprintf(out, "%s is public: anyone can read it at %s/fs/v1/folders/%s?owner=%s\n", project, a.Server, project, row.Owner)
	} else {
		fmt.Fprintf(out, "%s is private: only you and the readers you added can read it online.\n", project)
	}
	return nil
}
