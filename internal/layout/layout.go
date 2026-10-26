// Package layout says where folder-sync keeps everything on a machine.
//
// Everything lives under ~/.folder-sync/ (docs/peps/0001 §7). WHY: rclone's own
// defaults are %APPDATA% and %LOCALAPPDATA% on Windows, and Claude Desktop's MSIX
// package silently virtualizes writes there, so they are visible only to the
// writing process tree. The home directory is therefore resolved from HOME /
// USERPROFILE only, never from APPDATA, LOCALAPPDATA or os.UserConfigDir.
package layout

import (
	"errors"
	"strings"
)

// DirName is the one directory folder-sync owns in the user's home.
const DirName = ".folder-sync"

// Layout is every path folder-sync writes outside a project folder.
type Layout struct {
	GOOS        string
	Home        string // the user's home directory
	Root        string // ~/.folder-sync
	Bin         string // ~/.folder-sync/bin
	Rclone      string // ~/.folder-sync/bin/rclone[.exe]
	RcloneConf  string // ~/.folder-sync/rclone.conf (passed as --config, holds no secrets)
	Cache       string // ~/.folder-sync/cache (--cache-dir)
	Tmp         string // ~/.folder-sync/tmp (--temp-dir)
	Work        string // ~/.folder-sync/work (--workdir, bisync only, v1)
	Logs        string // ~/.folder-sync/logs
	Projects    string // ~/.folder-sync/projects/<key>/ (state per project folder)
	Service     string // ~/.folder-sync/service (systemd unit / task XML; the macOS plist goes to ~/Library/LaunchAgents)
	Viewer      string // ~/.folder-sync/viewer/<project>/ (R2-Explorer config)
	Conflicts   string // ~/.folder-sync/conflicts (local edits to peer copies, kept)
	HostFile    string // ~/.folder-sync/host.json
	Credentials string // ~/.folder-sync/credentials.json
	Session     string // ~/.folder-sync/session.json (the credential process's cached keys, mode 0600)
	Account     string // ~/.folder-sync/account.json (`folder-sync login`'s session, mode 0600; PEP 0003)
}

// Getenv is os.Getenv, injectable so tests can pose as another OS.
type Getenv func(string) string

// HomeDir resolves the home directory for goos from the environment.
// Windows: USERPROFILE, else HOMEDRIVE+HOMEPATH. Everything else: HOME.
// It never consults APPDATA or LOCALAPPDATA.
func HomeDir(goos string, getenv Getenv) (string, error) {
	if goos == "windows" {
		if home := getenv("USERPROFILE"); home != "" {
			return home, nil
		}
		if drive, path := getenv("HOMEDRIVE"), getenv("HOMEPATH"); drive != "" && path != "" {
			return drive + path, nil
		}
		return "", errors.New("cannot find the home directory: USERPROFILE is not set")
	}
	if home := getenv("HOME"); home != "" {
		return home, nil
	}
	return "", errors.New("cannot find the home directory: HOME is not set")
}

// Separator is the path separator for goos.
func Separator(goos string) string {
	if goos == "windows" {
		return `\`
	}
	return "/"
}

// Join joins path elements with goos's separator, without touching the host OS.
func Join(goos string, elem ...string) string {
	sep := Separator(goos)
	out := ""
	for _, e := range elem {
		if e == "" {
			continue
		}
		if out == "" {
			out = e
			continue
		}
		out = strings.TrimRight(out, `/\`) + sep + strings.TrimLeft(e, `/\`)
	}
	return out
}

// For builds the layout for goos from the environment.
func For(goos string, getenv Getenv) (Layout, error) {
	home, err := HomeDir(goos, getenv)
	if err != nil {
		return Layout{}, err
	}
	root := Join(goos, home, DirName)
	exe := ""
	if goos == "windows" {
		exe = ".exe"
	}
	return Layout{
		GOOS:        goos,
		Home:        home,
		Root:        root,
		Bin:         Join(goos, root, "bin"),
		Rclone:      Join(goos, root, "bin", "rclone"+exe),
		RcloneConf:  Join(goos, root, "rclone.conf"),
		Cache:       Join(goos, root, "cache"),
		Tmp:         Join(goos, root, "tmp"),
		Work:        Join(goos, root, "work"),
		Logs:        Join(goos, root, "logs"),
		Projects:    Join(goos, root, "projects"),
		Service:     Join(goos, root, "service"),
		Viewer:      Join(goos, root, "viewer"),
		Conflicts:   Join(goos, root, "conflicts"),
		HostFile:    Join(goos, root, "host.json"),
		Credentials: Join(goos, root, "credentials.json"),
		Session:     Join(goos, root, "session.json"),
		Account:     Join(goos, root, "account.json"),
	}, nil
}

// All lists every path in the layout, for checks that none escapes Root.
func (l Layout) All() []string {
	return []string{l.Bin, l.Rclone, l.RcloneConf, l.Cache, l.Tmp, l.Work, l.Logs,
		l.Projects, l.Service, l.Viewer, l.Conflicts, l.HostFile, l.Credentials, l.Session, l.Account}
}

// Dirs lists the directories to create on first use.
func (l Layout) Dirs() []string {
	return []string{l.Root, l.Bin, l.Cache, l.Tmp, l.Work, l.Logs, l.Projects, l.Service, l.Viewer, l.Conflicts}
}
