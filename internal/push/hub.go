package push

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// Event is what the hub said: a hello (Hosts set) or one host's change.
type Event struct {
	Hello bool
	Hosts map[string]int // hello: every host's seq
	Host  string         // changed
	Seq   int
	Web   bool
}

// Keep-alive (PEP 0004 §3): a text ping every PingEvery, answered "pong" by the hub's runtime without waking it.
const (
	PingEvery = 30 * time.Second
	DeadAfter = 75 * time.Second
)

// Hub is a reconnecting client of GET <server>/fs/v1/folders/<project>/events.
type Hub struct {
	Events <-chan Event
	URL    string

	token     string
	userAgent string
	events    chan Event
	connected atomic.Bool
	mu        sync.Mutex
	conn      *websocket.Conn
	pending   *Event // the last own change not yet sent (sent on reconnect)
	// OnState is called with "connected" or "closed" (tracing); may be nil.
	OnState func(state string)
}

// EventsURL is the hub's address for server (an accounts server or an app's /fs/ mount).
func EventsURL(server, project string) (string, error) {
	u, err := url.Parse(strings.TrimRight(server, "/"))
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	default:
		return "", fmt.Errorf("server %q: http or https only", server)
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/fs/v1/folders/" + url.PathEscape(project) + "/events"
	return u.String(), nil
}

// NewHub returns a client; Run connects it.
func NewHub(eventsURL, token, userAgent string) *Hub {
	ch := make(chan Event, 16)
	return &Hub{Events: ch, URL: eventsURL, token: token, userAgent: userAgent, events: ch}
}

// Connected reports whether a socket is open now.
func (h *Hub) Connected() bool { return h != nil && h.connected.Load() }

// Announce tells the hub this machine's manifest is at seq. Never blocks; while disconnected the latest
// announcement is kept and sent on reconnect (the hello catches peers up either way).
func (h *Hub) Announce(host string, seq int) {
	if h == nil {
		return
	}
	h.mu.Lock()
	h.pending = &Event{Host: host, Seq: seq}
	conn := h.conn
	h.mu.Unlock()
	if conn != nil {
		h.flush(conn)
	}
}

func (h *Hub) flush(conn *websocket.Conn) {
	h.mu.Lock()
	ev := h.pending
	h.pending = nil
	h.mu.Unlock()
	if ev == nil {
		return
	}
	msg, _ := json.Marshal(map[string]any{"type": "changed", "host": ev.Host, "seq": ev.Seq})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, msg); err != nil {
		h.mu.Lock()
		if h.pending == nil {
			h.pending = ev
		}
		h.mu.Unlock()
	}
}

// Run keeps a socket open until ctx ends, reconnecting with backoff (0.5 s doubling to 30 s, with jitter).
func (h *Hub) Run(ctx context.Context) {
	backoff := 500 * time.Millisecond
	for ctx.Err() == nil {
		started := time.Now()
		err := h.session(ctx)
		if ctx.Err() != nil {
			return
		}
		_ = err
		if time.Since(started) > time.Minute {
			backoff = 500 * time.Millisecond // it was up for a while: retry soon
		}
		wait := backoff/2 + time.Duration(rand.Int64N(int64(backoff)))
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		if backoff *= 2; backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
	}
}

func (h *Hub) setConn(conn *websocket.Conn) {
	h.mu.Lock()
	h.conn = conn
	h.mu.Unlock()
	h.connected.Store(conn != nil)
	if h.OnState != nil {
		if conn != nil {
			h.OnState("connected")
		} else {
			h.OnState("closed")
		}
	}
}

func (h *Hub) session(ctx context.Context) error {
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	header := http.Header{}
	header.Set("Authorization", "Bearer "+h.token)
	if h.userAgent != "" {
		header.Set("User-Agent", h.userAgent)
	}
	conn, resp, err := websocket.Dial(dialCtx, h.URL, &websocket.DialOptions{HTTPHeader: header})
	cancel()
	if err != nil {
		if resp != nil {
			return fmt.Errorf("hub answered %d", resp.StatusCode) // never the token
		}
		return fmt.Errorf("hub unreachable")
	}
	conn.SetReadLimit(1 << 16)
	sessionCtx, stop := context.WithCancel(ctx)
	defer stop()
	defer conn.CloseNow()
	h.setConn(conn)
	defer h.setConn(nil)
	h.flush(conn)

	var lastSeen atomic.Int64
	lastSeen.Store(time.Now().UnixNano())
	go func() {
		ticker := time.NewTicker(PingEvery)
		defer ticker.Stop()
		for {
			select {
			case <-sessionCtx.Done():
				return
			case <-ticker.C:
				if time.Since(time.Unix(0, lastSeen.Load())) > DeadAfter {
					conn.CloseNow()
					return
				}
				wctx, cancel := context.WithTimeout(sessionCtx, 5*time.Second)
				_ = conn.Write(wctx, websocket.MessageText, []byte("ping"))
				cancel()
			}
		}
	}()
	for {
		_, data, err := conn.Read(sessionCtx)
		if err != nil {
			return err
		}
		lastSeen.Store(time.Now().UnixNano())
		if ev, ok := ParseEvent(data); ok {
			select {
			case h.events <- ev:
			case <-sessionCtx.Done():
				return sessionCtx.Err()
			}
		}
	}
}

// ParseEvent reads one hub message; pong and anything unknown are not events.
func ParseEvent(data []byte) (Event, bool) {
	var msg struct {
		Type  string                       `json:"type"`
		Host  string                       `json:"host"`
		Seq   int                          `json:"seq"`
		Web   bool                         `json:"web"`
		Hosts map[string]struct{ Seq int } `json:"hosts"`
	}
	if json.Unmarshal(data, &msg) != nil {
		return Event{}, false
	}
	switch msg.Type {
	case "hello":
		hosts := map[string]int{}
		for id, h := range msg.Hosts {
			hosts[id] = h.Seq
		}
		return Event{Hello: true, Hosts: hosts}, true
	case "changed":
		if msg.Host == "" {
			return Event{}, false
		}
		return Event{Host: msg.Host, Seq: msg.Seq, Web: msg.Web}, true
	}
	return Event{}, false
}
