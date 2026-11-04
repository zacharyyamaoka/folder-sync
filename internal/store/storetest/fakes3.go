package storetest

import (
	"crypto/md5"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// FakeS3 is an in-memory S3 server for one bucket, path-style, that does not check signatures. Each Ignore flag makes it
// behave like a store that accepts a conditional header and does nothing with it (the quiet failure the probe exists to
// catch); Reject makes it answer 501 to the conditional header instead.
type FakeS3 struct {
	IgnoreCreateOnce, IgnorePutIfMatch, IgnoreCopyIfMatch, IgnoreGetIfMatch bool
	RejectConditionals                                                      bool

	mu      sync.Mutex
	objects map[string]fakeObject
	// Seen records every request as "METHOD<tab>key<tab>conditional headers it carried, comma-separated".
	Seen []string
}

type fakeObject struct {
	body     []byte
	modified time.Time
}

func etagOfBytes(body []byte) string {
	sum := md5.Sum(body)
	return `"` + hex.EncodeToString(sum[:]) + `"`
}

// Start serves f for bucket and returns its URL.
func (f *FakeS3) Start(t *testing.T) string {
	t.Helper()
	f.objects = map[string]fakeObject{}
	server := httptest.NewServer(f)
	t.Cleanup(server.Close)
	return server.URL
}

// Keys lists what is stored.
func (f *FakeS3) Keys() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var keys []string
	for key := range f.objects {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// Saw counts recorded requests containing text.
func (f *FakeS3) Saw(text string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, line := range f.Seen {
		if strings.Contains(line, text) {
			n++
		}
	}
	return n
}

// SawMethod counts recorded requests of one method that carried the named conditional header.
func (f *FakeS3) SawMethod(method, header string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, line := range f.Seen {
		fields := strings.SplitN(line, "\t", 3)
		if fields[0] == method {
			for _, field := range strings.Split(fields[2], ",") {
				if field == header {
					n++
				}
			}
		}
	}
	return n
}

func (f *FakeS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	parts := strings.SplitN(strings.TrimPrefix(r.URL.EscapedPath(), "/"), "/", 2)
	key := ""
	if len(parts) == 2 {
		key, _ = url.PathUnescape(parts[1])
	}
	var headers []string
	for _, h := range []string{"If-None-Match", "If-Match", "X-Amz-Copy-Source-If-Match"} {
		if r.Header.Get(h) != "" {
			headers = append(headers, h)
		}
	}
	f.Seen = append(f.Seen, r.Method+"\t"+key+"\t"+strings.Join(headers, ","))
	conditional := r.Header.Get("If-None-Match") != "" || r.Header.Get("If-Match") != "" || r.Header.Get("X-Amz-Copy-Source-If-Match") != ""
	if conditional && f.RejectConditionals {
		http.Error(w, "<Error><Code>NotImplemented</Code></Error>", http.StatusNotImplemented)
		return
	}
	fail := func() { http.Error(w, "<Error><Code>PreconditionFailed</Code></Error>", http.StatusPreconditionFailed) }
	notFound := func() { http.Error(w, "<Error><Code>NoSuchKey</Code></Error>", http.StatusNotFound) }
	switch {
	case key == "" && r.Method == http.MethodHead:
		w.WriteHeader(http.StatusOK)
	case key == "" && r.Method == http.MethodGet:
		f.list(w, r)
	case r.Method == http.MethodPut && r.Header.Get("X-Amz-Copy-Source") != "":
		src, _ := url.PathUnescape(strings.SplitN(strings.TrimPrefix(r.Header.Get("X-Amz-Copy-Source"), "/"), "/", 2)[1])
		obj, ok := f.objects[src]
		if !ok {
			notFound()
			return
		}
		if want := r.Header.Get("X-Amz-Copy-Source-If-Match"); want != "" && !f.IgnoreCopyIfMatch && want != etagOfBytes(obj.body) {
			fail()
			return
		}
		f.objects[key] = fakeObject{body: obj.body, modified: time.Now()}
		fmt.Fprint(w, "<CopyObjectResult><ETag>"+etagOfBytes(obj.body)+"</ETag></CopyObjectResult>")
	case r.Method == http.MethodPut:
		body, _ := io.ReadAll(r.Body)
		old, exists := f.objects[key]
		if r.Header.Get("If-None-Match") == "*" && exists && !f.IgnoreCreateOnce {
			fail()
			return
		}
		if want := r.Header.Get("If-Match"); want != "" && !f.IgnorePutIfMatch && (!exists || want != etagOfBytes(old.body)) {
			fail()
			return
		}
		f.objects[key] = fakeObject{body: body, modified: time.Now()}
		w.Header().Set("ETag", etagOfBytes(body))
	case r.Method == http.MethodDelete:
		delete(f.objects, key)
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodGet || r.Method == http.MethodHead:
		obj, ok := f.objects[key]
		if !ok {
			notFound()
			return
		}
		etag := etagOfBytes(obj.body)
		if want := r.Header.Get("If-Match"); want != "" && !f.IgnoreGetIfMatch && want != etag {
			fail()
			return
		}
		w.Header().Set("ETag", etag)
		w.Header().Set("Last-Modified", obj.modified.UTC().Format(http.TimeFormat))
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		body := obj.body
		status := http.StatusOK
		if spec := strings.TrimPrefix(r.Header.Get("Range"), "bytes="); spec != r.Header.Get("Range") {
			bounds := strings.SplitN(spec, "-", 2)
			from, _ := strconv.Atoi(bounds[0])
			to, _ := strconv.Atoi(bounds[1])
			if to >= len(body) {
				to = len(body) - 1
			}
			body, status = body[from:to+1], http.StatusPartialContent
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		w.WriteHeader(status)
		if r.Method == http.MethodGet {
			w.Write(body)
		}
	default:
		http.Error(w, "unsupported", http.StatusBadRequest)
	}
}

func (f *FakeS3) list(w http.ResponseWriter, r *http.Request) {
	prefix, delimiter := r.URL.Query().Get("prefix"), r.URL.Query().Get("delimiter")
	var keys []string
	for key := range f.objects {
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
	var result struct {
		XMLName        xml.Name `xml:"ListBucketResult"`
		Contents       []content
		CommonPrefixes []struct{ Prefix string }
		IsTruncated    bool
	}
	seen := map[string]bool{}
	for _, key := range keys {
		if delimiter != "" {
			if i := strings.Index(key[len(prefix):], delimiter); i >= 0 {
				common := key[:len(prefix)+i+len(delimiter)]
				if !seen[common] {
					seen[common] = true
					result.CommonPrefixes = append(result.CommonPrefixes, struct{ Prefix string }{common})
				}
				continue
			}
		}
		obj := f.objects[key]
		result.Contents = append(result.Contents, content{key, obj.modified.UTC().Format(time.RFC3339Nano), etagOfBytes(obj.body), len(obj.body)})
	}
	w.Header().Set("Content-Type", "application/xml")
	xml.NewEncoder(w).Encode(result)
}
