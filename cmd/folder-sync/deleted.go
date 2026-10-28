package main

// `folder-sync deleted [--restore <prefix>]` (docs/peps/0007 §3.3): this machine's deleted files, the paths with a
// kept version and no entry in its manifest (one listing per 1,000 versions); --restore puts back every one whose
// path starts with the prefix, each at its newest version, as one restore.

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"strings"
	"time"

	"folder-sync/internal/history"
)

func cmdDeleted(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("deleted", flag.ContinueOnError)
	restore := fs.String("restore", "", "restore every deleted file whose path starts with this prefix (\"\" for all)")
	asJSON := fs.Bool("json", false, "print the deleted files as JSON (schema/history.schema.json, newest deletion first)")
	dir := folderFlag(fs)
	rest, err := parseInterspersed(fs, args)
	if err != nil {
		return err
	}
	if len(rest) > 0 {
		return fmt.Errorf("deleted takes no path: use --restore <prefix>")
	}
	restoring := false
	fs.Visit(func(f *flag.Flag) { restoring = restoring || f.Name == "restore" })
	p, err := openProject(*dir, out)
	if err != nil {
		return err
	}
	defer p.Close()
	deleted, err := p.Deleted()
	if err != nil {
		return err
	}
	if restoring {
		var items []history.RequestItem
		for _, v := range deleted {
			if strings.HasPrefix(v.Path, *restore) {
				items = append(items, history.RequestItem{Path: v.Path, Version: v.Version})
			}
		}
		if len(items) == 0 {
			return fmt.Errorf("no deleted file of this machine starts with %q", *restore)
		}
		return restoreOwn(p, items, out)
	}
	if *asJSON {
		if deleted == nil {
			deleted = []history.Version{}
		}
		data, err := json.MarshalIndent(deleted, "", "  ")
		if err != nil {
			return err
		}
		fmt.Fprintln(out, string(data))
		return nil
	}
	fmt.Fprintf(out, "%s deleted on %s, newest deletion first (kept up to 30 days)\n", plural(len(deleted), "file"), hostLabel(p, p.Host.ID))
	for _, v := range deleted {
		fmt.Fprintf(out, "  %s  deleted %s  %s  %s\n", v.Path, when(v.LeftAt.Format(time.RFC3339Nano)), byteSize(v.Size), v.Version)
	}
	if len(deleted) > 0 {
		fmt.Fprintln(out, "Restore with: folder-sync deleted --restore <prefix>   (or folder-sync restore <path>)")
	}
	return nil
}
