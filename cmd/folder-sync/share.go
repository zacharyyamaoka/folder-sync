package main

// `folder-sync share`: the owner opts a folder into a shared tree (docs/peps/0010 §7). The accounts server mints the tree's
// id once and writes its empty manifest with the private rule; every machine of the folder learns it at its next round and
// moves its non-private files into the tree. Shared folders need the accounts server in v1.

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"time"

	"folder-sync/internal/account"
	"folder-sync/internal/config"
)

// patterns is a repeatable flag.
type patterns []string

func (p *patterns) String() string     { return fmt.Sprint([]string(*p)) }
func (p *patterns) Set(v string) error { *p = append(*p, v); return nil }

func cmdShare(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("share", flag.ContinueOnError)
	var private patterns
	fs.Var(&private, "private", "a gitignore pattern for files that stay on each machine's own host (repeatable); none by default")
	dir := folderFlag(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	folder, err := findFolder(*dir)
	if err != nil {
		return err
	}
	cfg, err := config.Load(folder)
	if err != nil {
		return err
	}
	if fs.NArg() > 1 || (fs.NArg() == 1 && fs.Arg(0) != cfg.Project) {
		return fmt.Errorf("this folder is the project %q: run `folder-sync share [--private PATTERN]...` in it", cfg.Project)
	}
	l := mustLayout()
	a, client, err := signedIn(l)
	if err != nil {
		return fmt.Errorf("a shared folder needs the accounts server (docs/peps/0010 §13.2); run `folder-sync login` first: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var rule []string
	if len(private) > 0 {
		rule = []string(private)
	}
	tree, err := client.Share(ctx, a.Token, cfg.Project, rule)
	if err != nil {
		var refused *account.ServerError
		if errors.As(err, &refused) && refused.Code == "already_shared" {
			return fmt.Errorf("%s: the private rule cannot change after the share in this version", refused.Why)
		}
		return err
	}
	p, err := openProject(folder, io.Discard)
	if err != nil {
		return err
	}
	defer p.Close()
	lock, err := p.AcquireLock()
	if err != nil {
		return err
	}
	defer lock.Release()
	if err := p.AdoptShared(tree.Host, tree.Private); err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	verb := "is already shared"
	if tree.Created {
		verb = "is now shared"
	}
	data, _ := json.Marshal(tree.Private)
	fmt.Fprintf(out, "%s %s: the shared tree is %s; private (stays on each machine's own host): %s\n", cfg.Project, verb, tree.Host, string(data))
	fmt.Fprintf(out, "Each machine moves its files into the tree at its next sync; run `folder-sync sync --once` here to move this one's now.\n")
	return nil
}
