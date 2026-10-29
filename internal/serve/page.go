package serve

// GET /fs/: a page with one <folder-sync-status> per folder this machine syncs; GET /fs/ui/<file>: the element's
// files, the same bytes the accounts Worker serves (ui.Files, embedded in the binary).
//
// The page gets its cookie the Jupyter way (docs/API.md "On the machine"): `folder-sync serve` prints
// /fs/?token=<token>, and that one request sets the cookie and answers 303 to /fs/, so the token leaves the address
// bar at once.

import (
	"html"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

func (s *Server) page(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, errMethod)
		return
	}
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Referrer-Policy", "no-referrer")
	if token, given := r.URL.Query()["token"]; given {
		if !s.isToken(token[0]) {
			h.Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusUnauthorized)
			io.WriteString(w, signedOutPage)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: CookieName, Value: s.token, Path: "/fs/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
		http.Redirect(w, r, "/fs/", http.StatusSeeOther)
		return
	}
	if _, ok := s.authorized(r); !ok {
		h.Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusUnauthorized)
		io.WriteString(w, signedOutPage)
		return
	}
	var b strings.Builder
	b.WriteString(pageHead)
	folders := s.folders()
	if len(folders) == 0 {
		b.WriteString(`<p class="muted">No synced folders yet: run <code>folder-sync init</code> in one.</p>`)
	}
	for _, f := range folders {
		project, dir := html.EscapeString(f.reg.Project), html.EscapeString(f.reg.Folder)
		// WHY folder= on every element: two folders on this machine may sync one project (409 ambiguous_folder)
		b.WriteString(`<section><div><h2>` + project + `</h2><p class="muted">` + dir + `</p></div>` +
			`<folder-sync-status project="` + project + `" folder="` + dir + `"></folder-sync-status></section>`)
	}
	b.WriteString(pageFoot)
	h.Set("Content-Type", "text/html; charset=utf-8")
	io.WriteString(w, b.String())
}

const pageHead = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>folder-sync on this computer</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0 auto; max-width: 760px; padding: 32px 20px; font: 15px/1.5 system-ui, sans-serif; background: Canvas; color: CanvasText; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; } h2 { font-size: 16px; font-weight: 600; margin: 0; }
  .muted { color: GrayText; margin: 0; }
  section { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 0; border-top: 1px solid color-mix(in srgb, CanvasText 15%, transparent); }
</style>
<script type="module" src="/fs/ui/v1/folder-sync.js"></script>
</head><body><h1>folder-sync on this computer</h1>
<p class="muted" style="margin-bottom:20px">The folders this computer syncs. Open one's menu for its activity, version history and deleted files.</p>
`

const pageFoot = `</body></html>
`

const signedOutPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>folder-sync</title></head>
<body style="font: 15px system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px">
<p>This page needs the link <code>folder-sync serve</code> printed (it carries this start's token). Open that link
again, or run <code>folder-sync serve</code> and open the one it prints.</p></body></html>
`

// uiFile serves /fs/ui/<file> from the element's files: files only, never a listing.
func (s *Server) uiFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, errMethod)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/fs/ui/")
	if s.cfg.UI == nil || name == "" || !fs.ValidPath(name) {
		writeError(w, errNotFound)
		return
	}
	data, err := fs.ReadFile(s.cfg.UI, name)
	if err != nil {
		writeError(w, errNotFound)
		return
	}
	h := w.Header()
	switch path.Ext(name) {
	case ".js":
		h.Set("Content-Type", "text/javascript; charset=utf-8")
	case ".css":
		h.Set("Content-Type", "text/css; charset=utf-8")
	default:
		h.Set("Content-Type", "text/plain; charset=utf-8")
	}
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Content-Type-Options", "nosniff")
	if r.Method == http.MethodHead {
		return
	}
	w.Write(data)
}
