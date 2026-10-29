package serve

// The folders this machine syncs, and what their state directories say: the registrations, the manifests this
// machine published and pulled, last-sync.json and the local activity log (docs/CONTRACT.md "Not part of the
// contract": the files are private, and this package is the one reader that turns them into the API).

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"folder-sync/internal/config"
	"folder-sync/internal/host"
	"folder-sync/internal/manifest"
	"folder-sync/internal/syncer"
	"folder-sync/internal/synclog"
)

var (
	projectName = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,62}$`)
	hostID      = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	dayName     = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}\.jsonl$`)
)

// webHostName is the web host's manifest host_name (docs/CONTRACT.md "Who writes"): a browser's writes, made by the
// accounts Worker, whose restores serve forwards there.
const webHostName = "web"

// folder is one synced folder on this machine.
type folder struct {
	reg      syncer.Registration
	stateDir string
}

// folders lists the folders this machine syncs: the registered ones whose folder still holds its .folder-sync.toml,
// sorted by folder.
func (s *Server) folders() []folder {
	entries, _ := os.ReadDir(s.cfg.Layout.Projects)
	var out []folder
	for _, entry := range entries {
		dir := filepath.Join(s.cfg.Layout.Projects, entry.Name())
		reg, err := syncer.ReadRegistration(dir)
		if err != nil {
			continue
		}
		if _, err := os.Stat(filepath.Join(reg.Folder, config.FileName)); err != nil {
			continue
		}
		out = append(out, folder{reg: reg, stateDir: dir})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].reg.Folder != out[j].reg.Folder {
			return out[i].reg.Folder < out[j].reg.Folder
		}
		return out[i].stateDir < out[j].stateDir
	})
	return out
}

// folderFor is the one folder that syncs project, picked by ?folder= when two do (docs/API.md "Routes").
func (s *Server) folderFor(r *http.Request, project string) (folder, error) {
	if !projectName.MatchString(project) {
		return folder{}, fail(http.StatusBadRequest, "bad_project", "A project is ^[a-z0-9][a-z0-9._-]{0,62}$.")
	}
	want := r.URL.Query().Get("folder")
	var found []folder
	for _, f := range s.folders() {
		if f.reg.Project == project && (want == "" || f.reg.Folder == want) {
			found = append(found, f)
		}
	}
	switch {
	case len(found) == 0:
		return folder{}, errNotFound
	case len(found) > 1:
		return folder{}, fail(http.StatusConflict, "ambiguous_folder", "Two folders on this machine sync "+project+"; add ?folder=<path>.")
	}
	return found[0], nil
}

// this is this machine's host id and name.
func (s *Server) this(f folder) host.Host {
	h, err := host.Load(s.cfg.Layout.HostFile)
	if err != nil || h.ID != f.reg.HostID {
		return host.Host{ID: f.reg.HostID}
	}
	return h
}

// manifests are what this machine knows of each host of the folder, with no bucket call: the manifest it last
// published, and each peer's it last pulled.
func (s *Server) manifests(f folder) map[string]manifest.Manifest {
	out := map[string]manifest.Manifest{}
	if m, ok, err := manifest.Load(filepath.Join(f.stateDir, "manifest.json")); err == nil && ok {
		out[f.reg.HostID] = m
	}
	entries, _ := os.ReadDir(filepath.Join(f.stateDir, "peers"))
	for _, entry := range entries {
		id, isJSON := strings.CutSuffix(entry.Name(), ".json")
		if !isJSON || !hostID.MatchString(id) || id == f.reg.HostID {
			continue
		}
		if m, ok, err := manifest.Load(filepath.Join(f.stateDir, "peers", entry.Name())); err == nil && ok && m.HostID == id {
			out[id] = m
		}
	}
	return out
}

// open opens the folder with sync's credentials, for a route that reads the bucket: without them the bucket is out
// of reach too (503 unavailable).
func (s *Server) open(f folder) (*syncer.Project, error) {
	p, err := s.cfg.Open(f.reg.Folder)
	if err != nil {
		return nil, fail(http.StatusServiceUnavailable, "unavailable", "This machine could not open "+f.reg.Folder+": "+err.Error())
	}
	return p, nil
}

// offline is a bucket call that failed (503 unavailable): the old bytes and the others' records live in the bucket.
func offline(p *syncer.Project, err error) error {
	return fail(http.StatusServiceUnavailable, "unavailable", "This needs the network, and the bucket did not answer: "+p.Creds.Scrub(err.Error()))
}

// localLine is one line of the local activity log, kept as written, with the fields this package reads.
type localLine struct {
	raw json.RawMessage
	ev  synclog.Event
	at  time.Time
}

// dayFile is one parsed day file, re-read when its size or mtime moves.
type dayFile struct {
	size  int64
	mtime time.Time
	lines []localLine
}

// localLog is every line of the folder's local log (~/.folder-sync/projects/<key>/log/, 14 days), oldest day first.
// Lines that are not JSON events are skipped: the log is written whole lines at a time, but a crash can cut one.
func (s *Server) localLog(f folder) []localLine {
	dir := synclog.Dir(f.stateDir)
	entries, _ := os.ReadDir(dir)
	var names []string
	for _, entry := range entries {
		if dayName.MatchString(entry.Name()) && !entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	var out []localLine
	for _, name := range names {
		out = append(out, s.dayLines(filepath.Join(dir, name))...)
	}
	return out
}

func (s *Server) dayLines(path string) []localLine {
	info, err := os.Stat(path)
	if err != nil {
		return nil
	}
	s.mu.Lock()
	cached, ok := s.logs[path]
	s.mu.Unlock()
	if ok && cached.size == info.Size() && cached.mtime.Equal(info.ModTime()) {
		return cached.lines
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var lines []localLine
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 64<<10), 4<<20)
	for scanner.Scan() {
		raw := bytes.TrimSpace(scanner.Bytes())
		if len(raw) == 0 {
			continue
		}
		var ev synclog.Event
		if json.Unmarshal(raw, &ev) != nil || ev.Event == "" {
			continue
		}
		at, err := time.Parse(time.RFC3339Nano, ev.At)
		if err != nil {
			continue
		}
		lines = append(lines, localLine{raw: append(json.RawMessage(nil), raw...), ev: ev, at: at})
	}
	s.mu.Lock()
	s.logs[path] = dayFile{size: int64(len(data)), mtime: info.ModTime(), lines: lines}
	s.mu.Unlock()
	return lines
}

// validPath is the contract's published-path rule (schema/event.schema.json#/$defs/path).
func validPath(path string) bool {
	if path == "" || strings.HasPrefix(path, "/") || strings.HasSuffix(path, "/") || strings.ContainsAny(path, `\:`) || strings.Contains(path, "//") {
		return false
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == "." || segment == ".." {
			return false
		}
	}
	return true
}
