package serve

// GET …/files/:host/<path> on the machine: a live file's bytes, as the accounts Worker answers them online (PEP 0003
// §3.3), so Version history's "Current" reads one route on either server. The file is the one the manifest this
// machine published or last pulled names, read from the bucket with sync's credentials (as old versions are) and
// checked against that manifest's sha256 before anything about it is said. ETag "<sha256>", If-None-Match, If-Range,
// one Range and HEAD are net/http's ServeContent.

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path"
	"strings"
	"time"

	"folder-sync/internal/s3"
)

// errChanged is the Worker's answer when the bytes are not the manifest's: a newer upload, or the file went away.
var errChanged = fail(http.StatusNotFound, "not_found", "That file changed or went away while it was read.")

func (s *Server) file(w http.ResponseWriter, r *http.Request, f folder, rest []string) {
	host, filePath := rest[0], strings.Join(rest[1:], "/")
	if !hostID.MatchString(host) {
		writeError(w, fail(http.StatusBadRequest, "bad_host", "A host is its lowercase UUID."))
		return
	}
	if len(rest) < 2 || !validPath(filePath) {
		writeError(w, fail(http.StatusBadRequest, "bad_path", "A file's path follows the contract's path rules."))
		return
	}
	m, known := s.manifests(f)[host]
	entry, published := m.Index()[filePath] // exact: never a prefix, never a kept version
	if !known || !published {
		writeError(w, fail(http.StatusNotFound, "not_found", "That host does not publish that file."))
		return
	}
	p, err := s.open(f)
	if err != nil {
		writeError(w, err)
		return
	}
	defer p.Close()
	tmp, err := os.CreateTemp(p.Layout.Tmp, "serve-file-")
	if err != nil {
		writeError(w, err)
		return
	}
	tmp.Close()
	defer os.Remove(tmp.Name())
	if err := p.S3.GetToFile(p.Config.Bucket, p.HostPrefix(host)+"/"+filePath, tmp.Name()); errors.Is(err, s3.ErrNotFound) {
		writeError(w, errChanged)
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
	sum := sha256.New()
	if _, err := io.Copy(sum, file); err != nil {
		writeError(w, err)
		return
	}
	if hex.EncodeToString(sum.Sum(nil)) != entry.SHA256 {
		writeError(w, errChanged)
		return
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		writeError(w, err)
		return
	}
	suffix := strings.ToLower(path.Ext(filePath))
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	if t, ok := types[suffix]; ok {
		h.Set("Content-Type", t)
	}
	h.Set("ETag", `"`+entry.SHA256+`"`)
	h.Set("Cache-Control", "private, no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	if active[suffix] {
		h.Set("Content-Security-Policy", "sandbox")
	}
	http.ServeContent(w, r, "", time.Time{}, file)
}
