package serve

// GET …/history/:host/<path>[?version=<id>] and GET …/deleted[?host=] on the machine (docs/API.md "history",
// "deleted"): the kept versions are in the bucket, read through the engine's own listings (syncer.Project.Versions,
// AllVersions) with sync's credentials; the live entries come from the manifests this machine published and pulled.

import (
	"errors"
	"io"
	"net/http"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"folder-sync/internal/history"
	"folder-sync/internal/s3"
	"folder-sync/internal/syncer"
)

const (
	// versionsMax is how many versions a history lists (more: true past it).
	versionsMax = 1000
	// deletedMax is how many versions one deleted call reads (more: true past it).
	deletedMax = 10000
)

// types is what a version's bytes are served as, by suffix (the accounts Worker's TYPES); anything else is
// application/octet-stream.
var types = map[string]string{
	".json": "application/json; charset=utf-8", ".jsonl": "application/x-ndjson; charset=utf-8",
	".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
	".yaml": "text/plain; charset=utf-8", ".yml": "text/plain; charset=utf-8", ".toml": "text/plain; charset=utf-8",
	".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".svg": "image/svg+xml",
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
	".pdf": "application/pdf", ".stl": "model/stl", ".step": "application/step", ".stp": "application/step",
	".log": "text/plain; charset=utf-8", ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm",
	".mov": "video/quicktime",
}

// active are the suffixes a browser would run: their old bytes are someone's file, never this page.
var active = map[string]bool{".html": true, ".htm": true, ".svg": true}

type keptVersion struct {
	ID        string `json:"id"`
	WrittenAt string `json:"written_at,omitempty"`
	SHA16     string `json:"sha16,omitempty"`
	Unlisted  bool   `json:"unlisted,omitempty"`
	LeftAt    string `json:"left_at"`
	Size      int64  `json:"size"`
}

type liveEntry struct {
	Size      int64  `json:"size"`
	SHA256    string `json:"sha256"`
	WrittenAt string `json:"written_at"`
}

type historyBody struct {
	Host     string        `json:"host"`
	HostName string        `json:"host_name"`
	Path     string        `json:"path"`
	Live     *liveEntry    `json:"live"`
	Versions []keptVersion `json:"versions"`
	More     bool          `json:"more"`
}

func kept(v history.Version) keptVersion {
	out := keptVersion{ID: v.Version, LeftAt: history.FormatMs(v.LeftAt), Size: v.Size}
	if v.Unlisted {
		out.Unlisted = true
	} else {
		out.WrittenAt, out.SHA16 = v.WrittenAt, v.SHA16
	}
	return out
}

// newestFirst: the larger left_at, then the larger id.
func newestFirst(versions []history.Version) {
	sort.Slice(versions, func(i, j int) bool {
		if !versions[i].LeftAt.Equal(versions[j].LeftAt) {
			return versions[i].LeftAt.After(versions[j].LeftAt)
		}
		return versions[i].Version > versions[j].Version
	})
}

func (s *Server) history(w http.ResponseWriter, r *http.Request, f folder, rest []string) {
	host, filePath := rest[0], strings.Join(rest[1:], "/")
	if !hostID.MatchString(host) {
		writeError(w, fail(http.StatusBadRequest, "bad_host", "A host is its lowercase UUID."))
		return
	}
	if len(rest) < 2 || !validPath(filePath) {
		writeError(w, fail(http.StatusBadRequest, "bad_path", "A file's path follows the contract's path rules."))
		return
	}
	version, asked := r.URL.Query()["version"]
	if asked && !history.ValidVersionID(version[0]) {
		writeError(w, fail(http.StatusBadRequest, "bad_version", "A version is <written_at>_<sha16>, as the history lists it."))
		return
	}
	p, err := s.open(f)
	if err != nil {
		writeError(w, err)
		return
	}
	defer p.Close()
	if asked {
		s.versionBytes(w, p, host, filePath, version[0])
		return
	}
	versions, err := p.Versions(host, filePath)
	if err != nil {
		writeError(w, offline(p, err))
		return
	}
	m, known := s.manifests(f)[host]
	var live *liveEntry
	if known {
		if e, ok := m.Index()[filePath]; ok {
			live = &liveEntry{Size: e.Size, SHA256: e.SHA256, WrittenAt: e.WrittenAt}
		}
	}
	if live == nil && len(versions) == 0 {
		writeError(w, fail(http.StatusNotFound, "not_found", "That host has no such file, now or in its history."))
		return
	}
	newestFirst(versions)
	body := historyBody{Host: host, HostName: m.HostName, Path: filePath, Live: live, Versions: []keptVersion{}, More: len(versions) > versionsMax}
	for i, v := range versions {
		if i == versionsMax {
			break
		}
		body.Versions = append(body.Versions, kept(v))
	}
	writeJSON(w, http.StatusOK, body)
}

// versionBytes answers one version's bytes, typed by suffix, never as this page (docs/API.md "history").
func (s *Server) versionBytes(w http.ResponseWriter, p *syncer.Project, host, filePath, version string) {
	tmp, err := os.CreateTemp(p.Layout.Tmp, "serve-version-")
	if err != nil {
		writeError(w, err)
		return
	}
	tmp.Close()
	defer os.Remove(tmp.Name())
	key := history.Key(p.Root, p.Config.Project, host, filePath, version)
	if err := p.S3.GetToFile(p.Config.Bucket, key, tmp.Name()); errors.Is(err, s3.ErrNotFound) {
		at, _, _, _ := history.SplitVersionID(version)
		why := "That version was thinned out of the history and is gone."
		if s.cfg.Now().Sub(at) >= history.KeepDays*24*time.Hour {
			why = "That version is older than 30 days and is gone."
		}
		writeError(w, fail(http.StatusGone, "pruned", why))
		return
	} else if err != nil {
		writeError(w, offline(p, err))
		return
	}
	file, err := os.Open(tmp.Name())
	if err != nil {
		writeError(w, err)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		writeError(w, err)
		return
	}
	suffix := strings.ToLower(path.Ext(filePath))
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	if t, ok := types[suffix]; ok {
		h.Set("Content-Type", t)
	}
	h.Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	h.Set("Cache-Control", "private, no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Folder-Sync-Version", version)
	if active[suffix] {
		h.Set("Content-Security-Policy", "sandbox")
	}
	w.WriteHeader(http.StatusOK)
	io.Copy(w, file)
}

type deletedFile struct {
	Host      string `json:"host"`
	HostName  string `json:"host_name"`
	Path      string `json:"path"`
	DeletedAt string `json:"deleted_at"`
	Size      int64  `json:"size"`
	Version   string `json:"version"`
}

type deletedBody struct {
	Files []deletedFile `json:"files"`
	More  bool          `json:"more"`
}

// deleted is every path with a kept version and no live entry, newest deletion first, each with its newest version:
// one delimiter listing finds the hosts with history, then one listing per host.
func (s *Server) deleted(r *http.Request, f folder) (deletedBody, error) {
	only := r.URL.Query().Get("host")
	if only != "" && !hostID.MatchString(only) {
		return deletedBody{}, fail(http.StatusBadRequest, "bad_host", "A host is its lowercase UUID.")
	}
	p, err := s.open(f)
	if err != nil {
		return deletedBody{}, err
	}
	defer p.Close()
	prefix := p.Root + "_history/" + p.Config.Project + "/"
	listed, err := p.S3.List(p.Config.Bucket, prefix, "/")
	if err != nil {
		return deletedBody{}, offline(p, err)
	}
	var hosts []string
	for _, pre := range listed.Prefixes {
		if id := strings.TrimSuffix(strings.TrimPrefix(pre, prefix), "/"); hostID.MatchString(id) && (only == "" || id == only) {
			hosts = append(hosts, id)
		}
	}
	sort.Strings(hosts)
	known := s.manifests(f)
	body := deletedBody{Files: []deletedFile{}}
	read := 0
	for _, id := range hosts {
		if read >= deletedMax {
			body.More = true
			break
		}
		all, err := p.AllVersions(id)
		if err != nil {
			return deletedBody{}, offline(p, err)
		}
		if read+len(all) > deletedMax {
			all, body.More = all[:deletedMax-read], true
		}
		read += len(all)
		m := known[id]
		live := m.Index()
		for filePath, group := range history.ByPath(all) {
			if _, ok := live[filePath]; ok {
				continue
			}
			if v, ok := syncer.Newest(group); ok {
				body.Files = append(body.Files, deletedFile{Host: id, HostName: m.HostName, Path: filePath, DeletedAt: history.FormatMs(v.LeftAt), Size: v.Size, Version: v.Version})
			}
		}
	}
	sort.Slice(body.Files, func(i, j int) bool {
		a, b := body.Files[i], body.Files[j]
		if a.DeletedAt != b.DeletedAt {
			return a.DeletedAt > b.DeletedAt
		}
		return a.Path < b.Path
	})
	return body, nil
}
