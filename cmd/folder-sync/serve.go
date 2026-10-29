package main

// `folder-sync serve [--port N]`: the sync view on this machine (docs/API.md "On the machine", docs/peps/0007 §5.2):
// the same API as the accounts Worker over this machine's own state and the bucket, the element's files, and a page
// at /fs/, on 127.0.0.1 only with a token new for every start. It prints the page's URL and writes
// ~/.folder-sync/serve.json for the apps on this machine that forward /fs/* to it; it removes it when stopped.
// WHY a command of its own and not part of `sync --watch`: vt runs `sync --once` per pass while the desktop app runs
// --watch, and a reader of the state directory serves both.

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"folder-sync/internal/account"
	"folder-sync/internal/serve"
	"folder-sync/internal/syncer"
	"folder-sync/ui"
)

func cmdServe(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	port := fs.Int("port", 0, "listen on this port of 127.0.0.1 (default: one the OS gives)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("serve takes no arguments: folder-sync serve [--port N]")
	}
	l := mustLayout()
	if err := ensureDirs(l); err != nil {
		return err
	}
	getenv := credentialEnv(l, os.Getenv, os.Executable)
	srv, err := serve.New(serve.Config{
		Layout: l,
		UI:     ui.Files,
		Open: func(folder string) (*syncer.Project, error) {
			return syncer.Open(folder, l, getenv, rcloneBinary(l), io.Discard)
		},
		Account: func() (account.Account, error) {
			a, _, err := signedIn(l)
			return a, err
		},
		UserAgent: userAgent(l),
	})
	if err != nil {
		return err
	}
	ln, err := srv.Listen(*port)
	if err != nil {
		return err
	}
	info := serve.InfoPath(l)
	if err := srv.WriteInfo(info); err != nil {
		ln.Close()
		return err
	}
	defer srv.RemoveInfo(info)
	server := &http.Server{Handler: srv, ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	done := make(chan error, 1)
	go func() { done <- server.Serve(ln) }()
	fmt.Fprintf(out, "folder-sync serve: open %s\n", srv.PageURL())
	fmt.Fprintf(out, "Apps on this machine read %s for the address and the token. Stop with Ctrl-C.\n", info)
	select {
	case err = <-done:
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err = server.Shutdown(shutdown)
		cancel()
	}
	srv.Close()
	if errors.Is(err, http.ErrServerClosed) {
		err = nil
	}
	fmt.Fprintln(out, "Stopped.")
	return err
}
