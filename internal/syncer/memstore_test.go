package syncer

// An in-memory S3 for the history tests that need real bytes: PUT (with If-None-Match and If-Match), CopyObject (with
// x-amz-copy-source-if-match), HEAD, GET (with Range, If-Match and If-None-Match), DELETE and a delimiter LIST. Every
// object's LastModified is the fake clock's time when it was written, so a 30-day workload runs in seconds. WHY its own
// and not the e2e stand-in (rclone serve s3): the stand-in ignores the conditional headers PEP 0009 relies on, takes
// its LastModified from a file mtime, and is a process per round.

import (
	"crypto/md5"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type memObject struct {
	data     []byte
	etag     string
	modified time.Time
}

type memStore struct {
	mu      sync.Mutex
	bucket  string
	objects map[string]*memObject
	now     func() time.Time
	// onPut runs after a PUT's body is read and before it is stored, with the key: a test uses it to change a local
	// file at the moment an upload happens.
	onPut func(key string)
	// written counts the bytes PUT or copied into each top-level prefix (first path segment after the account root).
	written map[string]int64
	puts    int
	copies  int
	// short makes the next N whole-object GETs of a key answer 200 with the first half of the body, correctly framed (Content-Length
	// is the short length) and carrying the full object's ETag: what a store that serves an object while it is being replaced does.
	// A real S3 or R2 never does this; rclone serve s3 over a directory, the e2e stand-in, can.
	short map[string]int
	// cut makes the next N whole-object GETs of a key answer 200 with the whole object's Content-Length, send the first half of
	// the body and drop the connection: the client reads io.ErrUnexpectedEOF. What the stand-in does when the file under a GET is
	// truncated by a PUT, and what any network does when a connection breaks part way.
	cut map[string]int
	// busy makes the next N GETs of a key answer 500 InternalError, S3's "please try again" (the stand-in answers a GET that
	// races a PUT this way; R2 and S3 document it as a transient answer to retry).
	busy map[string]int
}

func newMemStore(t *testing.T, bucket string, now func() time.Time) (*memStore, *httptest.Server) {
	m := &memStore{bucket: bucket, objects: map[string]*memObject{}, now: now, written: map[string]int64{}, short: map[string]int{},
		cut: map[string]int{}, busy: map[string]int{}}
	server := httptest.NewServer(m)
	t.Cleanup(server.Close)
	return m, server
}

func quoteETag(sum [16]byte) string { return `"` + hex.EncodeToString(sum[:]) + `"` }

func (m *memStore) store(key string, data []byte) *memObject {
	obj := &memObject{data: data, etag: quoteETag(md5.Sum(data)), modified: m.now().UTC().Truncate(time.Millisecond)}
	m.objects[key] = obj
	m.written[topOf(key)] += int64(len(data))
	return obj
}

// topOf is the first segment of key that starts with "_" or, failing that, the second (after "users/AbC123/").
func topOf(key string) string {
	for _, part := range strings.Split(key, "/") {
		if strings.HasPrefix(part, "_") {
			return part
		}
	}
	return "live"
}

func (m *memStore) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimPrefix(r.URL.Path, "/"+m.bucket+"/")
	if r.URL.Path == "/"+m.bucket || r.URL.Path == "/"+m.bucket+"/" {
		m.list(w, r)
		return
	}
	switch r.Method {
	case http.MethodPut:
		if src := r.Header.Get("X-Amz-Copy-Source"); src != "" {
			m.copy(w, r, key, strings.TrimPrefix(src, "/"+m.bucket+"/"))
			return
		}
		body, _ := io.ReadAll(r.Body)
		if m.onPut != nil {
			m.onPut(key)
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		old, exists := m.objects[key]
		if r.Header.Get("If-None-Match") == "*" && exists {
			w.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		if want := r.Header.Get("If-Match"); want != "" && (!exists || old.etag != want) {
			w.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		m.puts++
		w.Header().Set("ETag", m.store(key, body).etag)
	case http.MethodHead, http.MethodGet:
		m.mu.Lock()
		defer m.mu.Unlock()
		obj, ok := m.objects[key]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if m.busy[key] > 0 && r.Method == http.MethodGet {
			m.busy[key]--
			w.Header().Set("Content-Type", "application/xml")
			w.WriteHeader(http.StatusInternalServerError)
			io.WriteString(w, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>InternalError</Code><Message>We encountered an internal error. Please try again.</Message></Error>`)
			return
		}
		if want := r.Header.Get("If-Match"); want != "" && want != obj.etag {
			w.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		if r.Method == http.MethodGet && r.Header.Get("If-None-Match") == obj.etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", obj.etag)
		w.Header().Set("Last-Modified", obj.modified.Format(http.TimeFormat))
		data := obj.data
		status := http.StatusOK
		if spec := r.Header.Get("Range"); spec != "" && r.Method == http.MethodGet {
			var from, to int64
			if _, err := fmt.Sscanf(spec, "bytes=%d-%d", &from, &to); err != nil || from > to || from >= int64(len(data)) {
				w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
				return
			}
			if to >= int64(len(data)) {
				to = int64(len(data)) - 1
			}
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", from, to, len(data)))
			data, status = data[from:to+1], http.StatusPartialContent
		}
		if m.short[key] > 0 && r.Method == http.MethodGet && status == http.StatusOK {
			m.short[key]--
			data = data[:len(data)/2]
		}
		if m.cut[key] > 0 && r.Method == http.MethodGet && status == http.StatusOK {
			m.cut[key]--
			w.Header().Set("Content-Length", strconv.Itoa(len(data)))
			w.WriteHeader(status)
			w.Write(data[:len(data)/2])
			w.(http.Flusher).Flush()
			panic(http.ErrAbortHandler) // the server drops the connection without logging; m.mu is released by the defer
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.WriteHeader(status)
		if r.Method == http.MethodGet {
			w.Write(data)
		}
	case http.MethodDelete:
		m.mu.Lock()
		delete(m.objects, key)
		m.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (m *memStore) copy(w http.ResponseWriter, r *http.Request, dst, src string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	obj, ok := m.objects[src]
	switch {
	case !ok:
		w.WriteHeader(http.StatusNotFound)
	case r.Header.Get("X-Amz-Copy-Source-If-Match") != "" && r.Header.Get("X-Amz-Copy-Source-If-Match") != obj.etag:
		w.WriteHeader(http.StatusPreconditionFailed)
	default:
		m.copies++
		m.store(dst, append([]byte(nil), obj.data...))
		w.Write([]byte(`<CopyObjectResult></CopyObjectResult>`))
	}
}

func (m *memStore) list(w http.ResponseWriter, r *http.Request) {
	prefix, delimiter := r.URL.Query().Get("prefix"), r.URL.Query().Get("delimiter")
	m.mu.Lock()
	defer m.mu.Unlock()
	var keys []string
	for key := range m.objects {
		if strings.HasPrefix(key, prefix) {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	type content struct {
		Key          string
		LastModified string
		ETag         string
		Size         int
	}
	var out struct {
		XMLName        xml.Name `xml:"ListBucketResult"`
		Contents       []content
		CommonPrefixes []struct{ Prefix string }
		IsTruncated    bool
	}
	seen := map[string]bool{}
	for _, key := range keys {
		rest := key[len(prefix):]
		if delimiter != "" {
			if i := strings.Index(rest, delimiter); i >= 0 {
				if common := prefix + rest[:i+1]; !seen[common] {
					seen[common] = true
					out.CommonPrefixes = append(out.CommonPrefixes, struct{ Prefix string }{common})
				}
				continue
			}
		}
		obj := m.objects[key]
		out.Contents = append(out.Contents, content{key, obj.modified.Format("2006-01-02T15:04:05.000Z"), obj.etag, len(obj.data)})
	}
	w.Header().Set("Content-Type", "application/xml")
	xml.NewEncoder(w).Encode(out)
}

// get is an object's bytes, or nil.
func (m *memStore) get(key string) []byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	if obj, ok := m.objects[key]; ok {
		return obj.data
	}
	return nil
}

// bytesUnder is the bytes stored under prefix now, and how many objects.
func (m *memStore) bytesUnder(prefix string) (bytes int64, objects int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for key, obj := range m.objects {
		if strings.HasPrefix(key, prefix) {
			bytes += int64(len(obj.data))
			objects++
		}
	}
	return bytes, objects
}

func (m *memStore) keysUnder(prefix string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var keys []string
	for key := range m.objects {
		if strings.HasPrefix(key, prefix) {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	return keys
}
