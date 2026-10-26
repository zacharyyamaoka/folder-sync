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
func credentialEnv(l layout.Layout, getenv func(string) string, executable func() (string, error)) func(string) string {
	if getenv(creds.EnvCredentialProcess) != "" || getenv(creds.EnvAccessKeyID) != "" || getenv(creds.EnvSecretAccessKey) != "" {
		return getenv
	}
	if _, err := os.Stat(l.Account); err != nil {
		return getenv
	}
	self, err := executable()
	if err != nil {
		return getenv
	}
	argv, err := json.Marshal([]string{self, "credentials"})
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

// signedIn loads account.json and a client for its server.
func signedIn(l layout.Layout) (account.Account, *account.Client, error) {
	a, err := account.Load(l.Account)
	if err != nil {
		return account.Account{}, nil, err
	}
	server, err := account.CheckServer(a.Server)
	if err != nil {
		return account.Account{}, nil, fmt.Errorf("%s: %w", l.Account, err)
	}
	return a, account.NewClient(server, userAgent(l)), nil
}

// loginDevice signs this machine in with the device grant and stores account.json.
func loginDevice(serverFlag string, out io.Writer) error {
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
	minutes := (device.ExpiresIn + 59) / 60
	fmt.Fprintf(out, "To sign this machine in, open %s and approve the code %s (it expires in %d min).\n", device.Link(), device.Shown(), minutes)
	fmt.Fprintf(out, "Waiting for the approval…\n")
	token, err := client.AwaitApproval(ctx, device, account.Sleep)
	if err != nil {
		return err
	}
	user, root, err := client.Me(ctx, token)
	if err != nil {
		return err
	}
	if err := account.Save(l.Account, account.Account{Server: server, Token: token, User: user, SignedIn: time.Now().UTC().Format(time.RFC3339)}); err != nil {
		return err
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
// signed out or revoked, or 1 for anything transient. folder-sync runs it itself (credentialEnv).
func cmdCredentials(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("credentials", flag.ContinueOnError)
	fs.SetOutput(stderr)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	l, err := layout.For(runtime.GOOS, os.Getenv)
	if err != nil {
		fmt.Fprintln(stderr, "folder-sync credentials:", err)
		return 1
	}
	a, client, err := signedIn(l)
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
