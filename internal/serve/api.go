package serve

// The routes (docs/API.md "Routes", the serve column). `…` is /fs/v1/folders/:project.

import (
	"net/http"
	"net/url"
	"strings"
)

func (s *Server) api(w http.ResponseWriter, r *http.Request) {
	segments, ok := splitPath(strings.TrimPrefix(r.URL.EscapedPath(), "/fs/v1/"))
	if !ok {
		writeError(w, fail(http.StatusBadRequest, "bad_path", "A file's path follows the contract's path rules."))
		return
	}
	if len(segments) == 1 && segments[0] == "folders" {
		if r.Method != http.MethodGet {
			writeError(w, errMethod)
			return
		}
		writeJSON(w, http.StatusOK, s.foldersBody())
		return
	}
	if len(segments) < 3 || segments[0] != "folders" {
		writeError(w, errNotFound)
		return
	}
	project, route, rest := segments[1], segments[2], segments[3:]
	method := map[string]string{"status": http.MethodGet, "activity": http.MethodGet, "deleted": http.MethodGet, "restore": http.MethodPost, "history": http.MethodGet, "files": http.MethodGet}[route]
	if route == "history" && len(rest) == 1 && rest[0] == "purge" {
		method = http.MethodPost
	}
	underPath := route == "history" || route == "files"
	if method == "" || (!underPath && len(rest) > 0) || (underPath && len(rest) == 0) {
		writeError(w, errNotFound)
		return
	}
	// a live file also answers HEAD, as online (PEP 0003 §3.3)
	if r.Method != method && !(route == "files" && r.Method == http.MethodHead) {
		writeError(w, errMethod)
		return
	}
	if route == "history" && method == http.MethodPost {
		// WHY online only: freeing space deletes history for good, which only the folder's object does (it keeps
		// the usage figure honest as it goes)
		writeError(w, fail(http.StatusNotImplemented, "online_only", "Free up space from the folder's page online."))
		return
	}
	f, err := s.folderFor(r, project)
	if err != nil {
		writeError(w, err)
		return
	}
	switch route {
	case "status":
		writeJSON(w, http.StatusOK, s.status(f))
	case "activity":
		body, err := s.activity(r, f)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, body)
	case "history":
		s.history(w, r, f, rest)
	case "files":
		s.file(w, r, f, rest)
	case "deleted":
		body, err := s.deleted(r, f)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, body)
	case "restore":
		body, err := s.restore(r, f)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, body)
	}
}

// splitPath unescapes each segment of an escaped path on its own, so an encoded "/" inside one never makes two.
func splitPath(escaped string) ([]string, bool) {
	parts := strings.Split(escaped, "/")
	out := make([]string, len(parts))
	for i, part := range parts {
		segment, err := url.PathUnescape(part)
		if err != nil || strings.Contains(segment, "/") {
			return nil, false
		}
		out[i] = segment
	}
	return out, true
}

type folderEntry struct {
	Project string `json:"project"`
	Folder  string `json:"folder"`
}

// foldersBody is GET /fs/v1/folders on the machine: the folders it syncs, each with its folder (readable is always
// empty here: schema/view-api.schema.json#/$defs/folders).
func (s *Server) foldersBody() any {
	list := []folderEntry{}
	for _, f := range s.folders() {
		list = append(list, folderEntry{Project: f.reg.Project, Folder: f.reg.Folder})
	}
	return map[string]any{"folders": list, "readable": []any{}}
}
