package push

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func signalled(w *Watcher, within time.Duration) bool {
	select {
	case <-w.Changed:
		return true
	case <-time.After(within):
		return false
	}
}

func TestIgnored(t *testing.T) {
	for rel, want := range map[string]bool{
		"notes/a.md": false, "a.md": false, "hosts/abc/x.md": true, "hosts": true, ".folder-sync.toml": true,
		"notes/a.md~": true, "notes/.a.md.swp": true, "x.tmp": true, "hostsx/a": false,
	} {
		if got := Ignored(rel, "hosts"); got != want {
			t.Errorf("Ignored(%q) = %v, want %v", rel, got, want)
		}
	}
}

func TestWatcherSignalsOnceAfterABurst(t *testing.T) {
	dir := t.TempDir()
	w := Watch(dir, "hosts")
	defer w.Close()
	if !w.Healthy() {
		t.Fatal("watcher not healthy")
	}
	for i := 0; i < 5; i++ {
		os.WriteFile(filepath.Join(dir, "a.md"), []byte(strings.Repeat("x", i)), 0o644)
	}
	if !signalled(w, time.Second) {
		t.Fatal("no signal after a write")
	}
	if signalled(w, 3*Debounce) {
		t.Fatal("a burst of writes signalled twice")
	}
}

func TestWatcherIgnoresPeersDir(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "hosts", "peer"), 0o755)
	w := Watch(dir, "hosts")
	defer w.Close()
	os.WriteFile(filepath.Join(dir, "hosts", "peer", "x.md"), []byte("x"), 0o644)
	if signalled(w, 4*Debounce) {
		t.Fatal("a pull into hosts/ started a round")
	}
}

func TestWatcherFollowsNewDirectories(t *testing.T) {
	dir := t.TempDir()
	w := Watch(dir, "hosts")
	defer w.Close()
	os.MkdirAll(filepath.Join(dir, "saved"), 0o755)
	signalled(w, time.Second) // the mkdir itself
	os.WriteFile(filepath.Join(dir, "saved", "p.json"), []byte("{}"), 0o644)
	if !signalled(w, time.Second) {
		t.Fatal("a file in a new directory did not signal")
	}
}

func TestNextWait(t *testing.T) {
	if got := NextWait(true, true, 2*time.Second); got != Fallback {
		t.Fatal(got)
	}
	if got := NextWait(false, true, 2*time.Second); got != 2*time.Second {
		t.Fatal(got)
	}
	if got := NextWait(true, false, 2*time.Second); got != 2*time.Second {
		t.Fatal(got)
	}
	if got := NextWait(true, true, 5*time.Minute); got != 5*time.Minute {
		t.Fatal(got)
	}
}

func TestEventsURL(t *testing.T) {
	got, _ := EventsURL("https://robotparts.dev/", "robotparts")
	if got != "wss://robotparts.dev/fs/v1/folders/robotparts/events" {
		t.Fatal(got)
	}
	got, _ = EventsURL("http://127.0.0.1:4933", "p")
	if got != "ws://127.0.0.1:4933/fs/v1/folders/p/events" {
		t.Fatal(got)
	}
}

// fakeHub is an in-process hub: it records what clients send and lets the test push messages.
type fakeHub struct {
	mu       sync.Mutex
	auth     []string
	received []string
	conns    []*websocket.Conn
}

func (f *fakeHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	f.mu.Lock()
	f.auth = append(f.auth, r.Header.Get("Authorization"))
	f.conns = append(f.conns, conn)
	f.mu.Unlock()
	conn.Write(r.Context(), websocket.MessageText, []byte(`{"type":"hello","cursor":3,"hosts":{"h1":{"seq":4}}}`))
	for {
		_, data, err := conn.Read(r.Context())
		if err != nil {
			return
		}
		f.mu.Lock()
		f.received = append(f.received, string(data))
		f.mu.Unlock()
	}
}

func (f *fakeHub) last() *websocket.Conn {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.conns[len(f.conns)-1]
}

func next(t *testing.T, h *Hub) Event {
	t.Helper()
	select {
	case ev := <-h.Events:
		return ev
	case <-time.After(3 * time.Second):
		t.Fatal("no event")
	}
	return Event{}
}

func TestHubClient(t *testing.T) {
	fake := &fakeHub{}
	srv := httptest.NewServer(fake)
	defer srv.Close()
	u, _ := EventsURL(srv.URL, "robotparts")
	u = strings.Replace(u, "/fs/v1/folders/robotparts/events", "", 1)
	h := NewHub(u, "tok123", "folder-sync/test")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go h.Run(ctx)

	hello := next(t, h)
	if !hello.Hello || hello.Hosts["h1"] != 4 {
		t.Fatalf("hello: %+v", hello)
	}
	if !h.Connected() {
		t.Fatal("not connected after hello")
	}
	fake.mu.Lock()
	if fake.auth[0] != "Bearer tok123" {
		t.Fatalf("Authorization %q", fake.auth[0])
	}
	fake.mu.Unlock()

	fake.last().Write(ctx, websocket.MessageText, []byte(`{"type":"changed","cursor":4,"host":"h2","seq":9,"web":true}`))
	ev := next(t, h)
	if ev.Host != "h2" || ev.Seq != 9 || !ev.Web {
		t.Fatalf("changed: %+v", ev)
	}
	fake.last().Write(ctx, websocket.MessageText, []byte("pong")) // not an event

	h.Announce("me", 7)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		fake.mu.Lock()
		n := len(fake.received)
		fake.mu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	fake.mu.Lock()
	var sent map[string]any
	if len(fake.received) == 0 || json.Unmarshal([]byte(fake.received[0]), &sent) != nil ||
		sent["type"] != "changed" || sent["host"] != "me" || sent["seq"] != float64(7) {
		t.Fatalf("announce sent %v", fake.received)
	}
	fake.mu.Unlock()

	// the server drops the socket: the client reconnects and gets a fresh hello
	fake.last().CloseNow()
	if ev := next(t, h); !ev.Hello {
		t.Fatalf("after reconnect: %+v", ev)
	}
}

func TestParseEventIgnoresJunk(t *testing.T) {
	for _, junk := range []string{"pong", "{}", `{"type":"changed"}`, `{"type":"other"}`, "[1]"} {
		if _, ok := ParseEvent([]byte(junk)); ok {
			t.Errorf("%q parsed as an event", junk)
		}
	}
}
