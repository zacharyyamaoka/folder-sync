package main

// `folder-sync restore <path> [--version <id>]` (docs/peps/0007 §3.3): only the machine that owns a file restores it.
// This machine's own file is restored at once, after what is on disk is published (or, while a `sync --watch` holds
// the folder, left as a local request that its next round applies); another machine's file is a restore request in
// the bucket, which that machine applies at its next sync.

import (
	"flag"
	"fmt"
	"io"
	"time"

	"folder-sync/internal/history"
	"folder-sync/internal/syncer"
)

func cmdRestore(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("restore", flag.ContinueOnError)
	version := fs.String("version", "", "the kept version to put back (default: the newest kept); `folder-sync history <path>` lists them")
	dir := folderFlag(fs)
	rest, err := parseInterspersed(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return fmt.Errorf("restore takes one path: folder-sync restore notes/plan.md [--version <id>]; for many deleted files, folder-sync deleted --restore <prefix>")
	}
	p, err := openProject(*dir, out)
	if err != nil {
		return err
	}
	defer p.Close()
	owner, path, err := target(p, rest[0])
	if err != nil {
		return err
	}
	id := *version
	if id == "" {
		versions, err := p.Versions(owner, path)
		if err != nil {
			return err
		}
		newest, ok := syncer.Newest(versions)
		if !ok {
			return fmt.Errorf("%s has no kept version on %s", path, hostLabel(p, owner))
		}
		id = newest.Version
	} else if !history.ValidVersionID(id) {
		return fmt.Errorf("--version %q is not a version id (<written_at>_<sha16>, as `folder-sync history %s` lists them)", id, rest[0])
	}
	items := []history.RequestItem{{Path: path, Version: id}}
	if owner == p.Host.ID {
		return restoreOwn(p, items, out)
	}
	req := history.Request{Schema: history.RestoreSchema, ID: syncer.NewRequestID(), Project: p.Config.Project, Host: owner,
		At: time.Now().UTC().Format(time.RFC3339Nano), By: history.RequestBy{Kind: "machine", Name: p.Host.Name, Host: p.Host.ID},
		Items: items}
	if err := p.AskRestore(req); err != nil {
		return err
	}
	fmt.Fprintf(out, "Only the machine that owns a file restores it: asked %s to put %s back to %s (request %s).\n", hostLabel(p, owner), path, id, req.ID)
	fmt.Fprintf(out, "It applies it at its next sync (a running sync --watch within 5 minutes), and writes the outcome into the request.\n")
	return nil
}
