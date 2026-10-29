package serve

// GET …/status on the machine (docs/API.md "status"): this device's engine first, from its state directory and
// local log alone, so it answers with no network; the storage figure as last measured online; and every warning
// saying what to do.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"folder-sync/internal/config"
	"folder-sync/internal/history"
	"folder-sync/internal/manifest"
	"folder-sync/internal/syncer"
)

const (
	// watchStale is how long after its last round a `sync --watch` still counts as watching. WHY: it runs a round
	// at least every minute (its fallback timer), so ten quiet minutes mean it is gone (a crash writes no `stopped`).
	watchStale = 10 * time.Minute
	// lockStale is the engine's own: a lock file older than this was left by a crashed round.
	lockStale = 30 * time.Minute
	// usageEvery is how often the storage figure is asked for again, and usageRetry how soon after a failed ask.
	usageEvery = 15 * time.Minute
	usageRetry = time.Minute
	// waitingEvery is how often the bucket's unanswered restore requests are listed again (one listing, then a GET
	// for each new one).
	waitingEvery = time.Minute
)

type statusBody struct {
	Project    string       `json:"project"`
	Owner      owner        `json:"owner"`
	Role       string       `json:"role"`
	State      string       `json:"state"`
	Headline   string       `json:"headline"`
	Devices    []device     `json:"devices"`
	ThisDevice thisDevice   `json:"this_device"`
	Warnings   []warning    `json:"warnings"`
	Waiting    []waiting    `json:"waiting"`
	Storage    *usageFigure `json:"storage"`
}

type owner struct {
	ID    string `json:"id"`
	Email string `json:"email,omitempty"`
}

type device struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Kind       string  `json:"kind"`
	Seq        int64   `json:"seq"`
	LastChange *string `json:"last_change"`
	ThisDevice bool    `json:"this_device,omitempty"`
}

type thisDevice struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Folder    string     `json:"folder"`
	State     string     `json:"state"`
	Engine    string     `json:"engine"`
	LastRound *lastRound `json:"last_round"`
}

type lastRound struct {
	At   string `json:"at"`
	OK   bool   `json:"ok"`
	Kind string `json:"kind,omitempty"`
	Why  string `json:"why,omitempty"`
}

type warning struct {
	Kind  string `json:"kind"`
	Level string `json:"level"`
	Text  string `json:"text"`
	Host  string `json:"host,omitempty"`
	Path  string `json:"path,omitempty"`
	Count int    `json:"count,omitempty"`
}

type waiting struct {
	Request  string `json:"request"`
	Host     string `json:"host"`
	HostName string `json:"host_name"`
	At       string `json:"at"`
	Items    int    `json:"items"`
}

type amount struct {
	Bytes   int64 `json:"bytes"`
	Objects int64 `json:"objects"`
}

// usageFigure is GET /fs/v1/usage's answer as status shows it, with when it was measured (schema storage).
type usageFigure struct {
	Used       amount  `json:"used"`
	Live       amount  `json:"live"`
	History    amount  `json:"history"`
	Quota      amount  `json:"quota"`
	Over       *string `json:"over"`
	Partial    bool    `json:"partial"`
	MeasuredAt string  `json:"measured_at"`
}

// localOwner is the owner a machine with no sign-in shows (a bucket key of its own: no account, no id).
const localOwner = "local"

func (s *Server) status(f folder) statusBody {
	now := s.cfg.Now()
	me := s.this(f)
	known := s.manifests(f)
	body := statusBody{Project: f.reg.Project, Owner: owner{ID: localOwner}, Role: "owner", Devices: []device{}, Warnings: []warning{}, Waiting: []waiting{}}
	if a, err := s.cfg.Account(); err == nil && a.User.ID != "" {
		body.Owner = owner{ID: a.User.ID, Email: a.User.Email}
	}
	// devices: this machine always, then every host it has pulled, newest change first
	for id, m := range known {
		d := device{ID: id, Name: m.HostName, Kind: "machine", Seq: m.Seq}
		if m.GeneratedAt != "" {
			at := m.GeneratedAt
			d.LastChange = &at
		}
		if id == me.ID {
			d.ThisDevice = true
			if me.Name != "" {
				d.Name = me.Name
			}
		} else if m.HostName == webHostName {
			d.Kind = "web"
		}
		body.Devices = append(body.Devices, d)
	}
	if _, ok := known[me.ID]; !ok {
		body.Devices = append(body.Devices, device{ID: me.ID, Name: me.Name, Kind: "machine", ThisDevice: true})
	}
	sort.Slice(body.Devices, func(i, j int) bool {
		a, b := body.Devices[i], body.Devices[j]
		at, bt := "", ""
		if a.LastChange != nil {
			at = *a.LastChange
		}
		if b.LastChange != nil {
			bt = *b.LastChange
		}
		if at != bt {
			return at > bt
		}
		return a.ID < b.ID
	})

	// this device: its engine and its last round, from the local log (last-sync.json when the log has none)
	lines := s.localLog(f)
	last, _ := syncer.LoadLastSync(f.stateDir)
	engine := engineOf(lines, now, lockHeld(f, now))
	round, lastOK := lastRoundOf(lines, last)
	body.ThisDevice = thisDevice{ID: me.ID, Name: me.Name, Folder: f.reg.Folder, Engine: engine, LastRound: round}

	body.Warnings = append(body.Warnings, localWarnings(f, last, round)...)
	body.Waiting = s.waitingOf(f, known, me.ID, now)
	perHost := map[string]int{}
	var hosts []string
	for _, w := range body.Waiting {
		if perHost[w.Host] == 0 {
			hosts = append(hosts, w.Host)
		}
		perHost[w.Host] += w.Items
	}
	for _, id := range hosts {
		count, name, seen := perHost[id], "a device", ""
		if m, ok := known[id]; ok {
			name = m.HostName
			if t, err := time.Parse(time.RFC3339Nano, m.GeneratedAt); err == nil {
				seen = " (last seen " + ago(now.Sub(t)) + ")"
			}
		}
		if id == me.ID {
			name, seen = "this computer's engine", ""
		}
		it, files := "it", "1 file waits"
		if count != 1 {
			it, files = "them", fmt.Sprintf("%d files wait", count)
		}
		body.Warnings = append(body.Warnings, warning{Kind: "waiting_restore", Level: "warn", Host: id, Count: count,
			Text: fmt.Sprintf("%s for %s%s. Download %s to have %s now.", files, name, seen, it, it)})
	}
	body.Storage = s.storage(now)
	if body.Storage != nil && body.Storage.Over != nil && (round == nil || round.Kind != "over_quota") {
		body.Warnings = append(body.Warnings, warning{Kind: "over_quota", Level: "warn",
			Text: fmt.Sprintf("Storage is full and sync has stopped: history uses %d MB. Free up space online to sync again.", body.Storage.History.Bytes/1_000_000)})
	}

	// one headline: offline is never red, and waits on the network rather than on the person
	state, headline := "synced", "Synced"
	errors := 0
	for _, w := range body.Warnings {
		if w.Level == "error" {
			errors++
		}
	}
	switch {
	case round == nil:
		state, headline = "unknown", "Not synced yet"
	case !round.OK && round.Kind == "offline":
		state, headline = "offline", "Offline"
		if !lastOK.IsZero() {
			headline = "Offline · last synced " + ago(now.Sub(lastOK))
		}
	case errors > 0:
		state, headline = "error", needs(len(body.Warnings))
	case len(body.Warnings) > 0:
		state, headline = "attention", needs(len(body.Warnings))
	case lockHeld(f, now):
		state, headline = "syncing", "Syncing"
	}
	body.State, body.Headline, body.ThisDevice.State = state, headline, state
	return body
}

func needs(n int) string {
	if n == 1 {
		return "1 thing needs you"
	}
	return fmt.Sprintf("%d things need you", n)
}

// ago is "just now", "12 min ago", "3 h ago", "6 days ago".
func ago(d time.Duration) string {
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%d min ago", int(d/time.Minute))
	case d < 24*time.Hour:
		return fmt.Sprintf("%d h ago", int(d/time.Hour))
	case d < 48*time.Hour:
		return "1 day ago"
	}
	return fmt.Sprintf("%d days ago", int(d/(24*time.Hour)))
}

// lockHeld reports whether a round holds the folder's lock now (syncer.AcquireLock's file, not yet stale).
func lockHeld(f folder, now time.Time) bool {
	info, err := os.Stat(filepath.Join(f.stateDir, "lock"))
	return err == nil && now.Sub(info.ModTime()) <= lockStale
}

// engineOf is watching when the log's newest watching/stopped is a `watching`, and its engine has run a round
// lately (or runs one now); else idle.
func engineOf(lines []localLine, now time.Time, running bool) string {
	var started, lastRound time.Time
	for i := len(lines) - 1; i >= 0 && started.IsZero(); i-- {
		switch lines[i].ev.Event {
		case "stopped":
			return "idle"
		case "watching":
			started = lines[i].at
		case "round", "round_start":
			if lastRound.IsZero() {
				lastRound = lines[i].at
			}
		}
	}
	if started.IsZero() {
		return "idle"
	}
	if running || now.Sub(lastRound) <= watchStale || now.Sub(started) <= watchStale {
		return "watching"
	}
	return "idle"
}

// lastRoundOf is the newest round's outcome, and when the newest round that went through finished.
func lastRoundOf(lines []localLine, last syncer.LastSync) (*lastRound, time.Time) {
	var round *lastRound
	var ok time.Time
	for i := len(lines) - 1; i >= 0 && ok.IsZero(); i-- {
		ev := lines[i].ev
		if ev.Event != "round" || ev.OK == nil {
			continue
		}
		if round == nil {
			round = &lastRound{At: ev.At, OK: *ev.OK}
			if !*ev.OK {
				round.Kind, round.Why = ev.Kind, ev.Why
				if round.Kind == "" {
					round.Kind = "error"
				}
			}
		}
		if *ev.OK {
			ok = lines[i].at
		}
	}
	if round == nil && last.RoundFinished != "" {
		round = &lastRound{At: last.RoundFinished, OK: last.OK}
		if !last.OK {
			round.Kind, round.Why = "error", last.Error
		}
	}
	if ok.IsZero() && last.LastCleanRun != "" {
		ok, _ = time.Parse(time.RFC3339Nano, last.LastCleanRun)
	}
	return round, ok
}

// localWarnings are what this machine's state says needs the person: skipped names, held deletes, edits kept aside
// (while the kept copy is still there), a folder that looks unmounted, and a round that is failing.
func localWarnings(f folder, last syncer.LastSync, round *lastRound) []warning {
	var out []warning
	if round != nil && !round.OK {
		switch round.Kind {
		case "signed_out":
			out = append(out, warning{Kind: "signed_out", Level: "warn", Text: "This computer is signed out: run folder-sync login to sync again."})
		case "over_quota":
			why := strings.TrimSuffix(round.Why, ".")
			if why == "" {
				why = "storage is full"
			}
			out = append(out, warning{Kind: "over_quota", Level: "warn", Text: upper(why) + ". Free up space online to sync again."})
		case "error":
			if strings.Contains(round.Why, "looks empty or unmounted") {
				out = append(out, warning{Kind: "unmounted", Level: "warn", Text: f.reg.Folder + " looks empty or unmounted: mount it again. Nothing was deleted online."})
				break
			}
			why := strings.TrimSuffix(round.Why, ".")
			if why == "" {
				why = "the last round failed"
			}
			out = append(out, warning{Kind: "failing", Level: "error", Text: "Sync is failing: " + why + ". Run folder-sync sync --once in the folder to see it."})
		}
	}
	for _, skipped := range last.Skipped {
		if !validPath(skipped.Path) {
			continue
		}
		// WHY the rename: every warning says what to do, and a name that cannot exist on every OS syncs once renamed
		text := upper(strings.TrimSuffix(skipped.Reason, "."))
		if !strings.Contains(strings.ToLower(text), "rename") {
			text += ": rename it to sync it"
		}
		out = append(out, warning{Kind: "skipped", Level: "warn", Path: skipped.Path, Text: text + "."})
	}
	if n := len(last.HeldDeletes); n > 0 {
		max := config.DefaultMaxDelete
		if cfg, err := config.Load(f.reg.Folder); err == nil && cfg.MaxDelete > 0 {
			max = cfg.MaxDelete
		}
		out = append(out, warning{Kind: "held_deletes", Level: "warn", Count: n,
			Text: fmt.Sprintf("%d deletes are held: more than max_delete (%d) at once. Raise max_delete in %s to let them go, or put the files back.", n, max, config.FileName)})
	}
	for _, c := range last.Conflicts {
		if _, err := os.Stat(c.KeptAt); err != nil || !validPath(c.Path) || !hostID.MatchString(c.Peer) {
			continue
		}
		out = append(out, warning{Kind: "conflict", Level: "warn", Host: c.Peer, Path: c.Path,
			Text: fmt.Sprintf("Your edit to another machine's %s was kept aside at %s: move it into your own files to keep it.", c.Path, c.KeptAt)})
	}
	return out
}

func upper(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// storage is the figure last measured online (GET /fs/v1/usage with this machine's session), asked for again in
// the background every usageEvery (usageRetry after a failed ask); nil when this machine is not signed in or has
// never reached the accounts server. WHY in the background: status must answer at once, offline too.
func (s *Server) storage(now time.Time) *usageFigure {
	s.mu.Lock()
	figure, tried := s.usage, s.usageTry
	due := (figure == nil || now.Sub(parseTime(figure.MeasuredAt)) >= usageEvery) && now.Sub(tried) >= usageRetry
	if due {
		s.usageTry = now
	}
	s.mu.Unlock()
	if due {
		s.later("usage", func() {
			if got, err := s.fetchUsage(s.cfg.Now()); err == nil {
				s.mu.Lock()
				s.usage = got
				s.mu.Unlock()
			}
		})
	}
	return figure
}

func (s *Server) fetchUsage(now time.Time) (*usageFigure, error) {
	a, err := s.cfg.Account()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(a.Server, "/")+"/fs/v1/usage", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+a.Token)
	req.Header.Set("Accept", "application/json")
	if s.cfg.UserAgent != "" {
		req.Header.Set("User-Agent", s.cfg.UserAgent)
	}
	resp, err := s.cfg.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET /fs/v1/usage answered %s", resp.Status)
	}
	var figure usageFigure
	if err := json.NewDecoder(resp.Body).Decode(&figure); err != nil {
		return nil, err
	}
	figure.MeasuredAt = history.FormatMs(now)
	return &figure, nil
}

func parseTime(s string) time.Time {
	t, _ := time.Parse(time.RFC3339Nano, s)
	return t
}

// waitingCache is one folder's last listing of the bucket's unanswered restore requests, and every request it has
// read, by key, with the ETag it was read at (a request is read again only when it changed).
type waitingCache struct {
	at   time.Time
	list []waiting
	read map[string]readRequest
}

type readRequest struct {
	etag string
	w    *waiting // nil: answered, or not a request
}

// waitingOf is the restore requests no host has answered: this machine's local ones (a folder read), and the
// bucket's, as last listed (again in the background every waitingEvery).
func (s *Server) waitingOf(f folder, known map[string]manifest.Manifest, me string, now time.Time) []waiting {
	name := func(id string) string {
		if m, ok := known[id]; ok {
			return m.HostName
		}
		return ""
	}
	out := []waiting{}
	entries, _ := os.ReadDir(syncer.LocalRequestsDir(f.stateDir))
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(syncer.LocalRequestsDir(f.stateDir), entry.Name()))
		if err != nil {
			continue
		}
		var req history.Request
		if json.Unmarshal(data, &req) != nil || req.Outcome != nil || req.Check(f.reg.Project, me) != nil {
			continue
		}
		out = append(out, waiting{Request: req.ID, Host: me, HostName: name(me), At: req.At, Items: len(req.Items)})
	}
	s.mu.Lock()
	cached := s.waiting[f.stateDir]
	due := now.Sub(cached.at) >= waitingEvery
	if due {
		cached.at = now
		s.waiting[f.stateDir] = cached
	}
	s.mu.Unlock()
	if due {
		s.later("waiting "+f.stateDir, func() { s.listWaiting(f) })
	}
	for _, w := range cached.list {
		if w.Host == me {
			continue // this machine's own are local requests (above), never the bucket's
		}
		w.HostName = name(w.Host)
		out = append(out, w)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At > out[j].At })
	return out
}

// listWaiting lists <root>_requests/<project>/ and reads each request that is new or changed since it was read.
func (s *Server) listWaiting(f folder) {
	p, err := s.cfg.Open(f.reg.Folder)
	if err != nil {
		return
	}
	defer p.Close()
	prefix := p.Root + "_requests/" + p.Config.Project + "/"
	listed, err := p.S3.List(p.Config.Bucket, prefix, "")
	if err != nil {
		return
	}
	s.mu.Lock()
	before := s.waiting[f.stateDir].read
	s.mu.Unlock()
	read := map[string]readRequest{}
	var list []waiting
	for _, obj := range listed.Objects {
		rest, isJSON := strings.CutSuffix(strings.TrimPrefix(obj.Key, prefix), ".json")
		hostPart, idPart, cut := strings.Cut(rest, "/")
		if !isJSON || !cut || !hostID.MatchString(hostPart) || !hostID.MatchString(idPart) {
			continue
		}
		if seen, ok := before[obj.Key]; ok && seen.etag == obj.ETag {
			read[obj.Key] = seen
		} else {
			got, err := p.S3.GetIfNoneMatch(p.Config.Bucket, obj.Key, "")
			if err != nil {
				return
			}
			seen := readRequest{etag: obj.ETag}
			var req history.Request
			if !got.NotFound && json.Unmarshal(got.Body, &req) == nil && req.Outcome == nil && req.ID == idPart && req.Check(p.Config.Project, hostPart) == nil {
				seen.w = &waiting{Request: req.ID, Host: req.Host, At: req.At, Items: len(req.Items)}
			}
			read[obj.Key] = seen
		}
		if w := read[obj.Key].w; w != nil {
			list = append(list, *w)
		}
	}
	s.mu.Lock()
	s.waiting[f.stateDir] = waitingCache{at: s.waiting[f.stateDir].at, list: list, read: read}
	s.mu.Unlock()
}
