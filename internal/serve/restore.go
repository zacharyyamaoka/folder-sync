package serve

// POST …/restore on the machine (docs/API.md "restore"; docs/peps/0007 §3.3): only the host that owns a file
// restores it. This machine's own items become one local request, which its engine applies in its next round
// (`where: local`); another machine's become one restore request in the bucket (`where: bucket`); the web host's
// are forwarded to the accounts server with this machine's session, whose folder object writes them at once
// (`applied`). Nothing is written here that is not a request.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"folder-sync/internal/history"
	"folder-sync/internal/syncer"
)

type restoreItem struct {
	Host    string `json:"host"`
	Path    string `json:"path"`
	Version string `json:"version"`
}

type appliedItem struct {
	Host    string `json:"host"`
	Path    string `json:"path"`
	Version string `json:"version"`
	Seq     int64  `json:"seq"`
}

type requestedHost struct {
	Host     string `json:"host"`
	HostName string `json:"host_name"`
	Request  string `json:"request"`
	Items    int    `json:"items"`
	Where    string `json:"where"`
}

type failedItem struct {
	Host    string `json:"host"`
	Path    string `json:"path"`
	Version string `json:"version"`
	Error   string `json:"error"`
}

type restoreBody struct {
	Applied   []appliedItem   `json:"applied"`
	Requested []requestedHost `json:"requested"`
	Failed    []failedItem    `json:"failed"`
}

func (s *Server) restore(r *http.Request, f folder) (restoreBody, error) {
	var doc map[string]json.RawMessage
	if err := readBody(r, &doc); err != nil {
		return restoreBody{}, err
	}
	var items []map[string]json.RawMessage
	if len(doc) != 1 || doc["items"] == nil || json.Unmarshal(doc["items"], &items) != nil || len(items) == 0 {
		return restoreBody{}, fail(http.StatusBadRequest, "bad_request", "The body is { items: [{ host, path, version }] }.")
	}
	if len(items) > history.MaxItems {
		return restoreBody{}, fail(http.StatusRequestEntityTooLarge, "too_large", "A restore takes at most 1,000 items.")
	}
	var asked []restoreItem
	for _, fields := range items {
		var it restoreItem
		strs := map[string]*string{"host": &it.Host, "path": &it.Path, "version": &it.Version}
		for key, raw := range fields {
			target, ok := strs[key]
			if !ok || json.Unmarshal(raw, target) != nil {
				return restoreBody{}, fail(http.StatusBadRequest, "bad_request", "Each item is { host, path, version }.")
			}
		}
		switch {
		case !hostID.MatchString(it.Host):
			return restoreBody{}, fail(http.StatusBadRequest, "bad_host", "A host is its lowercase UUID.")
		case !validPath(it.Path):
			return restoreBody{}, fail(http.StatusBadRequest, "bad_path", "A file's path follows the contract's path rules.")
		case !history.ValidVersionID(it.Version):
			return restoreBody{}, fail(http.StatusBadRequest, "bad_version", "A version is <written_at>_<sha16>, as the history lists it.")
		}
		asked = append(asked, it)
	}

	me := s.this(f)
	known := s.manifests(f)
	var order []string
	byHost := map[string][]history.RequestItem{}
	for _, it := range asked {
		if _, seen := byHost[it.Host]; !seen {
			order = append(order, it.Host)
		}
		byHost[it.Host] = append(byHost[it.Host], history.RequestItem{Path: it.Path, Version: it.Version})
	}
	body := restoreBody{Applied: []appliedItem{}, Requested: []requestedHost{}, Failed: []failedItem{}}
	failAll := func(host, code string) {
		for _, it := range byHost[host] {
			body.Failed = append(body.Failed, failedItem{Host: host, Path: it.Path, Version: it.Version, Error: code})
		}
	}
	now := s.cfg.Now().UTC().Format(time.RFC3339Nano)
	var project *syncer.Project
	defer func() {
		if project != nil {
			project.Close()
		}
	}()
	for _, host := range order {
		list := byHost[host]
		req := history.Request{Schema: history.RestoreSchema, ID: syncer.NewRequestID(), Project: f.reg.Project, Host: host, At: now,
			By: history.RequestBy{Kind: "machine", Name: me.Name, Host: me.ID}, Items: list}
		m, isKnown := known[host]
		switch {
		case host == me.ID:
			// WHY a local request and not a round here: the engine that holds the folder applies it, after it has
			// published what is on disk, so a restore never loses an edit
			if err := syncer.WriteLocalRequest(f.stateDir, req); err != nil {
				failAll(host, history.ErrFailed)
				continue
			}
			body.Requested = append(body.Requested, requestedHost{Host: host, HostName: me.Name, Request: req.ID, Items: len(list), Where: "local"})
		case !isKnown:
			failAll(host, "not_found")
		case m.HostName == webHostName:
			applied, failed, err := s.forwardRestore(f.reg.Project, host, list)
			if err != nil {
				failAll(host, history.ErrFailed)
				continue
			}
			body.Applied = append(body.Applied, applied...)
			body.Failed = append(body.Failed, failed...)
		default:
			if project == nil {
				p, err := s.cfg.Open(f.reg.Folder)
				if err != nil {
					failAll(host, history.ErrFailed)
					continue
				}
				project = p
			}
			if err := project.AskRestore(req); err != nil {
				failAll(host, history.ErrFailed)
				continue
			}
			body.Requested = append(body.Requested, requestedHost{Host: host, HostName: m.HostName, Request: req.ID, Items: len(list), Where: "bucket"})
		}
	}
	// in the order they were asked for
	rank := map[string]int{}
	for i, it := range asked {
		key := it.Host + "\x00" + it.Path + "\x00" + it.Version
		if _, seen := rank[key]; !seen {
			rank[key] = i
		}
	}
	of := func(host, path, version string) int { return rank[host+"\x00"+path+"\x00"+version] }
	sort.SliceStable(body.Applied, func(i, j int) bool {
		a, b := body.Applied[i], body.Applied[j]
		return of(a.Host, a.Path, a.Version) < of(b.Host, b.Path, b.Version)
	})
	sort.SliceStable(body.Failed, func(i, j int) bool {
		a, b := body.Failed[i], body.Failed[j]
		return of(a.Host, a.Path, a.Version) < of(b.Host, b.Path, b.Version)
	})
	return body, nil
}

// forwardRestore sends the web host's items to the accounts server's POST …/restore with this machine's session
// (docs/API.md "On the machine"): the folder's object writes them at once.
func (s *Server) forwardRestore(project, host string, list []history.RequestItem) ([]appliedItem, []failedItem, error) {
	a, err := s.cfg.Account()
	if err != nil {
		return nil, nil, err
	}
	items := make([]restoreItem, len(list))
	for i, it := range list {
		items[i] = restoreItem{Host: host, Path: it.Path, Version: it.Version}
	}
	data, err := json.Marshal(map[string]any{"items": items})
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	u := strings.TrimRight(a.Server, "/") + "/fs/v1/folders/" + url.PathEscape(project) + "/restore"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(data))
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+a.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if s.cfg.UserAgent != "" {
		req.Header.Set("User-Agent", s.cfg.UserAgent)
	}
	resp, err := s.cfg.HTTP.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("the accounts server answered %s", resp.Status)
	}
	var answer struct {
		Applied []appliedItem `json:"applied"`
		Failed  []failedItem  `json:"failed"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&answer); err != nil {
		return nil, nil, err
	}
	var applied []appliedItem
	var failed []failedItem
	for _, it := range answer.Applied {
		if it.Host == host {
			applied = append(applied, it)
		}
	}
	for _, it := range answer.Failed {
		if it.Host == host {
			failed = append(failed, it)
		}
	}
	return applied, failed, nil
}
