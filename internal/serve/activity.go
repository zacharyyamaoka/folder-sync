package serve

// GET …/activity?before=&limit=&level=&host= on the machine (docs/API.md "activity"): this machine's whole local
// log, plus the others' published events, newest first. The others' are their change records, read by key counting
// down from the seq of the manifest this machine last pulled (no listing), and their pull records, from one listing
// of each one's pulls/. Records are written once and never change, so each is fetched when first asked for and then
// kept (docs/peps/0007 §4: "fetched when asked and then cached"). With no network the local log still answers.
//
// The cursor (`next`, opaque) is the last event a page returned: the next page is every event older than it.

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"folder-sync/internal/history"
	"folder-sync/internal/syncer"
	"folder-sync/internal/synclog"
)

const (
	// missesInARow ends a host's count down: a run of missing change records ("not recorded", or pruned).
	missesInARow = 5
	// readsPerPage bounds the records one page fetches from the bucket (cached ones are free).
	readsPerPage = 300
	// missingFor is how long a record found missing is not asked for again (a failed PUT is retried next round).
	missingFor = time.Minute
	// pullsFor is how long a host's pulls/ listing is kept.
	pullsFor = 30 * time.Second
	// activityLimit is limit's default, and its largest.
	activityLimit, activityMax = 200, 500
)

// recordCache is one change or pull record: its events, or that it was missing when asked for.
type recordCache struct {
	events  []event
	missing time.Time
}

// listingCache is a host's pulls/ listing: each record's at (its key), newest first.
type listingCache struct {
	at   time.Time
	keys []string
}

// event is one event as it goes out, with what the merge sorts by.
type event struct {
	raw   json.RawMessage
	at    time.Time
	atRaw string
	tie   string // host, seq, event and path: the order of two events in the same millisecond
	level string
	host  string
}

func eventOf(raw json.RawMessage, ev synclog.Event, at time.Time) event {
	seq := ""
	if ev.Seq > 0 {
		seq = fmt.Sprintf("%012d", ev.Seq)
	}
	return event{raw: raw, at: at, atRaw: ev.At, tie: ev.Host + "\x00" + seq + "\x00" + ev.Event + "\x00" + ev.Path, level: ev.Level, host: ev.Host}
}

// newer orders newest first: by instant, then as written, then the tiebreak.
func newer(a, b event) bool {
	if !a.at.Equal(b.at) {
		return a.at.After(b.at)
	}
	if a.atRaw != b.atRaw {
		return a.atRaw > b.atRaw
	}
	return a.tie > b.tie
}

type cursor struct {
	T [3]string `json:"t"` // the last event returned: its instant (ns), its at as written, its tiebreak
}

func encodeCursor(e event) string {
	data, _ := json.Marshal(cursor{T: [3]string{strconv.FormatInt(e.at.UnixNano(), 10), e.atRaw, e.tie}})
	return base64.RawURLEncoding.EncodeToString(data)
}

func decodeCursor(text string) (event, bool) {
	data, err := base64.RawURLEncoding.DecodeString(text)
	if err != nil {
		return event{}, false
	}
	var c cursor
	if json.Unmarshal(data, &c) != nil {
		return event{}, false
	}
	ns, err := strconv.ParseInt(c.T[0], 10, 64)
	if err != nil {
		return event{}, false
	}
	return event{at: time.Unix(0, ns).UTC(), atRaw: c.T[1], tie: c.T[2]}, true
}

type activityQuery struct {
	limit  int
	level  string
	host   string
	before *event
}

func (q activityQuery) wanted(e event) bool {
	level := e.level
	if level == "" {
		level = "info"
	}
	switch {
	case q.level == "warn" && level != "warn" && level != "error", q.level == "error" && level != "error":
		return false
	case q.before != nil && !newer(*q.before, e):
		return false
	}
	return true
}

func parseActivityQuery(r *http.Request) (activityQuery, error) {
	v := r.URL.Query()
	q := activityQuery{limit: activityLimit, level: v.Get("level"), host: v.Get("host")}
	if text := v.Get("limit"); text != "" {
		n, err := strconv.Atoi(text)
		if err != nil || n < 1 || n > activityMax {
			return q, fail(http.StatusBadRequest, "bad_request", "limit is 1 to 500.")
		}
		q.limit = n
	}
	if q.level != "" && q.level != "warn" && q.level != "error" {
		return q, fail(http.StatusBadRequest, "bad_request", "level is warn or error.")
	}
	if q.host != "" && !hostID.MatchString(q.host) {
		return q, fail(http.StatusBadRequest, "bad_host", "A host is its lowercase UUID.")
	}
	if text := v.Get("before"); text != "" {
		before, ok := decodeCursor(text)
		if !ok {
			return q, fail(http.StatusBadRequest, "bad_request", "before is the next cursor of the page before.")
		}
		q.before = &before
	}
	return q, nil
}

type activityBody struct {
	Events []json.RawMessage `json:"events"`
	Next   *string           `json:"next"`
}

func (s *Server) activity(r *http.Request, f folder) (activityBody, error) {
	q, err := parseActivityQuery(r)
	if err != nil {
		return activityBody{}, err
	}
	me := s.this(f)
	var all []event
	exhausted := true
	if q.host == "" || q.host == me.ID {
		for _, line := range s.localLog(f) {
			raw := line.raw
			if line.ev.Host == "" || line.ev.HostName == "" {
				raw = withHost(raw, me.ID, me.Name, 0)
				line.ev.Host = me.ID
			}
			if e := eventOf(raw, line.ev, line.at); q.wanted(e) {
				all = append(all, e)
			}
		}
	}
	var others []string
	known := s.manifests(f)
	for id := range known {
		if id != me.ID && (q.host == "" || q.host == id) {
			others = append(others, id)
		}
	}
	sort.Strings(others)
	if len(others) > 0 {
		// WHY the others only: this machine's own published events are in its local log already, with what never
		// leaves it (skips, conflicts, failed restores)
		if p, err := s.cfg.Open(f.reg.Folder); err == nil {
			reads := 0
			for _, id := range others {
				m := known[id]
				events, done := s.changeEvents(p, id, m.HostName, m.Seq, q, &reads)
				all = append(all, events...)
				exhausted = exhausted && done
				events, done = s.pullEvents(p, id, m.HostName, q, &reads)
				all = append(all, events...)
				exhausted = exhausted && done
			}
			p.Close()
		}
	}
	sort.SliceStable(all, func(i, j int) bool { return newer(all[i], all[j]) })
	body := activityBody{Events: []json.RawMessage{}}
	page := all
	if len(page) > q.limit {
		page = page[:q.limit]
	}
	for _, e := range page {
		body.Events = append(body.Events, e.raw)
	}
	if len(page) > 0 && (len(all) > len(page) || !exhausted) {
		next := encodeCursor(page[len(page)-1])
		body.Next = &next
	}
	return body, nil
}

// withHost fills in host, host_name and (for a change record's event) seq where an event lacks them.
func withHost(raw json.RawMessage, id, name string, seq int64) json.RawMessage {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return raw
	}
	changed := false
	set := func(key string, value any) {
		if _, ok := fields[key]; !ok {
			data, _ := json.Marshal(value)
			fields[key], changed = data, true
		}
	}
	set("host", id)
	set("host_name", name)
	if seq > 0 {
		set("seq", seq)
	}
	if !changed {
		return raw // as its writer wrote it
	}
	out, err := json.Marshal(fields)
	if err != nil {
		return raw
	}
	return out
}

// changeEvents are host's upload, delete and restore events older than the cursor, counting down from seq until
// there are more than a page of them, a run of missing records, or the page's reads are spent (done is false then).
func (s *Server) changeEvents(p *syncer.Project, host, name string, seq int64, q activityQuery, reads *int) ([]event, bool) {
	var out []event
	misses := 0
	for ; seq >= 1 && len(out) <= q.limit && misses < missesInARow; seq-- {
		key := history.ChangesKey(p.Root, p.Config.Project, host, seq)
		events, found, ok := s.record(p, key, host, name, seq, changeKinds, reads)
		if !ok {
			return out, false
		}
		if !found {
			misses++
			continue
		}
		misses = 0
		for _, e := range events {
			if q.wanted(e) {
				out = append(out, e)
			}
		}
	}
	return out, true
}

// pullEvents are host's download and remove_copy events older than the cursor, from its pull records, newest first.
func (s *Server) pullEvents(p *syncer.Project, host, name string, q activityQuery, reads *int) ([]event, bool) {
	prefix := history.ChangesPrefix(p.Root, p.Config.Project, host) + "pulls/"
	now := s.cfg.Now()
	s.mu.Lock()
	listing, ok := s.pulls[prefix]
	s.mu.Unlock()
	if !ok || now.Sub(listing.at) >= pullsFor {
		listed, err := p.S3.List(p.Config.Bucket, prefix, "")
		if err != nil {
			return nil, false
		}
		listing = listingCache{at: now}
		for _, obj := range listed.Objects {
			if at, isJSON := strings.CutSuffix(strings.TrimPrefix(obj.Key, prefix), ".json"); isJSON && !strings.Contains(at, "/") {
				listing.keys = append(listing.keys, at)
			}
		}
		sort.Sort(sort.Reverse(sort.StringSlice(listing.keys)))
		s.mu.Lock()
		s.pulls[prefix] = listing
		s.mu.Unlock()
	}
	var out []event
	for _, at := range listing.keys {
		if len(out) > q.limit {
			return out, true
		}
		events, _, ok := s.record(p, prefix+at+".json", host, name, 0, pullKinds, reads)
		if !ok {
			return out, false
		}
		for _, e := range events {
			if q.wanted(e) {
				out = append(out, e)
			}
		}
	}
	return out, true
}

var (
	changeKinds = map[string]bool{"upload": true, "delete": true, "restore": true}
	pullKinds   = map[string]bool{"download": true, "remove_copy": true}
)

// record is one record's events of the kinds it carries (cached), each with host, host_name and seq filled in. ok
// is false when the bucket did not answer or this page's reads are spent.
func (s *Server) record(p *syncer.Project, key, host, name string, seq int64, kinds map[string]bool, reads *int) (events []event, found, ok bool) {
	now := s.cfg.Now()
	s.mu.Lock()
	cached, seen := s.records[key]
	s.mu.Unlock()
	if seen && (cached.missing.IsZero() || now.Sub(cached.missing) < missingFor) {
		return cached.events, cached.missing.IsZero(), true
	}
	if *reads >= readsPerPage {
		return nil, false, false
	}
	*reads++
	got, err := p.S3.GetIfNoneMatch(p.Config.Bucket, key, "")
	if err != nil {
		return nil, false, false
	}
	if got.NotFound {
		s.mu.Lock()
		s.records[key] = recordCache{missing: now}
		s.mu.Unlock()
		return nil, false, true
	}
	var doc struct {
		HostName string            `json:"host_name"`
		Events   []json.RawMessage `json:"events"`
	}
	if json.Unmarshal(got.Body, &doc) == nil {
		if doc.HostName != "" {
			name = doc.HostName
		}
		for _, raw := range doc.Events {
			var ev synclog.Event
			if json.Unmarshal(raw, &ev) != nil || !kinds[ev.Event] {
				continue
			}
			at, err := time.Parse(time.RFC3339Nano, ev.At)
			if err != nil {
				continue
			}
			raw = withHost(raw, host, name, seq)
			if ev.Host == "" {
				ev.Host = host
			}
			if ev.Seq == 0 {
				ev.Seq = seq
			}
			events = append(events, eventOf(raw, ev, at))
		}
	}
	s.mu.Lock()
	s.records[key] = recordCache{events: events}
	s.mu.Unlock()
	return events, true, true
}
