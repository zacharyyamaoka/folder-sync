package main

// `folder-sync history <path>`: a file's kept versions in the bucket (docs/peps/0007 §3.3, one delimiter listing).
// The helpers here are shared with `restore` and `deleted`.

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"folder-sync/internal/history"
	"folder-sync/internal/host"
	"folder-sync/internal/syncer"
)

func cmdHistory(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("history", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print the versions as JSON (schema/history.schema.json), oldest first")
	dir := folderFlag(fs)
	rest, err := parseInterspersed(fs, args)
	if err != nil {
		return err
	}
	if len(rest) != 1 {
		return fmt.Errorf("history takes one path: folder-sync history notes/plan.md (or %s/<host-id>/<path> for another machine's file)", "<peers_dir>")
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
	versions, err := p.Versions(owner, path)
	if err != nil {
		return err
	}
	if *asJSON {
		if versions == nil {
			versions = []history.Version{}
		}
		data, err := json.MarshalIndent(versions, "", "  ")
		if err != nil {
			return err
		}
		fmt.Fprintln(out, string(data))
		return nil
	}
	fmt.Fprintf(out, "%s on %s: %s kept, newest first\n", path, hostLabel(p, owner), plural(len(versions), "version"))
	sort.Slice(versions, func(i, j int) bool { return versions[i].Version > versions[j].Version })
	for _, v := range versions {
		fmt.Fprintf(out, "  %s  left %s  %s\n", v.Version, when(v.LeftAt.Format(time.RFC3339Nano)), byteSize(v.Size))
	}
	if len(versions) > 0 {
		fmt.Fprintf(out, "Restore one with: folder-sync restore %s --version <id>\n", rest[0])
	}
	return nil
}

// target reads a path argument as a file of this folder: relative to the current directory when it lands inside the
// folder, else to the folder's root. <peers_dir>/<host-id>/<path> is that machine's file.
func target(p *syncer.Project, arg string) (owner, path string, err error) {
	rel := filepath.ToSlash(arg)
	if abs, err := filepath.Abs(arg); err == nil {
		if r, err := filepath.Rel(p.Folder, abs); err == nil && r != "." && !strings.HasPrefix(r, "..") {
			rel = filepath.ToSlash(r)
		}
	}
	rel = strings.TrimPrefix(rel, "./")
	if peer, rest, ok := strings.Cut(strings.TrimPrefix(rel, p.Config.PeersDir+"/"), "/"); ok && strings.HasPrefix(rel, p.Config.PeersDir+"/") {
		if !host.IsID(peer) {
			return "", "", fmt.Errorf("%s: %s/ holds other machines' copies by host id, and %q is not one", arg, p.Config.PeersDir, peer)
		}
		return peer, rest, nil
	}
	if rel == "" || rel == "." || strings.HasPrefix(rel, "../") {
		return "", "", fmt.Errorf("%s is not a file of %s", arg, p.Folder)
	}
	return p.Host.ID, rel, nil
}

func hostLabel(p *syncer.Project, id string) string {
	if id == p.Host.ID {
		return fmt.Sprintf("this machine (%s, %s)", p.Host.Name, short(id))
	}
	return "machine " + short(id)
}

// parseInterspersed parses flags given before or after the positional arguments, and answers the positional ones.
func parseInterspersed(fs *flag.FlagSet, args []string) ([]string, error) {
	var rest []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		args = fs.Args()
		if len(args) == 0 {
			return rest, nil
		}
		rest = append(rest, args[0])
		args = args[1:]
	}
}

func byteSize(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.1f GB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d bytes", n)
}

// restoreOwn carries out a restore of this machine's own files in one round (it publishes what is on disk first, so
// nothing unsynced is lost). When another round holds the folder (a running `sync --watch`), it leaves the request
// for that round instead.
func restoreOwn(p *syncer.Project, items []history.RequestItem, out io.Writer) error {
	var failed int
	for start := 0; start < len(items); start += history.MaxItems {
		end := min(start+history.MaxItems, len(items))
		req := history.Request{Schema: history.RestoreSchema, ID: syncer.NewRequestID(), Project: p.Config.Project, Host: p.Host.ID,
			At: time.Now().UTC().Format(time.RFC3339Nano), By: history.RequestBy{Kind: "machine", Name: p.Host.Name, Host: p.Host.ID},
			Items: items[start:end]}
		result, err := p.Round(context.Background(), syncer.Options{PushOnly: true, Restore: &req})
		newEventWriter(p, nil).fileEvents(result)
		if errors.Is(err, syncer.ErrBusy) {
			if err := syncer.WriteLocalRequest(p.StateDir, req); err != nil {
				return err
			}
			fmt.Fprintf(out, "A sync is running for this folder: it applies it at its next round (request %s, %s).\n", req.ID, plural(len(req.Items), "file"))
			continue
		}
		if err != nil {
			return err
		}
		if result.Restore == nil {
			return fmt.Errorf("the round did not run the restore")
		}
		for _, r := range result.Restore.Results {
			switch {
			case r.OK:
				fmt.Fprintf(out, "restored %s to %s\n", r.Path, r.Version)
			default:
				failed++
				why := r.Error
				if r.Why != "" {
					why += ": " + r.Why
				}
				fmt.Fprintf(out, "not restored %s (%s): %s\n", r.Path, r.Version, why)
			}
		}
		if result.Restore.Seq > 0 {
			fmt.Fprintf(out, "Published as manifest seq %d; the version each one replaced is kept in history.\n", result.Restore.Seq)
		}
	}
	if failed > 0 {
		return fmt.Errorf("%s not restored", plural(failed, "file"))
	}
	return nil
}

// fileEvents writes a round's file events (upload, delete, restore, download, remove_copy, skip, conflict, hold,
// synced; docs/peps/0007 §4) through the activity log: the folder's local log, and stdout with --events. The tray's
// own events on stdout are unchanged (readers ignore event names they do not know).
func (w *eventWriter) fileEvents(r syncer.Result) {
	for _, ev := range r.Events {
		w.emit(ev)
	}
}
