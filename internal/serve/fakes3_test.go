package serve

// A bucket for the fixture tests: the part of the S3 API internal/s3 speaks (path-style GET, HEAD, PUT with
// If-None-Match / If-Match and x-amz-copy-source, DELETE, ListObjectsV2 with a delimiter), in memory, with each
// object's LastModified set by the test (a kept version's left_at). Signatures are not checked: the auth under test is
// serve's own. The end-to-end test runs on the real stand-in (rclone serve s3) instead.

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
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeObject struct {
	data     []byte
	modified time.Time
	etag     string
}

type fakeS3 struct {
	mu      sync.Mutex
	bucket  string
	objects map[string]fakeObject
	now     func() time.Time
	server  *httptest.Server
	calls   []string // "<METHOD> <key or ?prefix>", in order
}

func newFakeS3(t *testing.T, bucket string, now func() time.Time) *fakeS3 {
	f := &fakeS3{bucket: bucket, objects: map[string]fakeObject{}, now: now}
	f.server = httptest.NewServer(f)
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeS3) put(key string, data []byte, modified time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	sum := md5.Sum(data)
	f.objects[key] = fakeObject{data: data, modified: modified.UTC(), etag: `"` + hex.EncodeToString(sum[:]) + `"`}
}

func (f *fakeS3) get(key string) ([]byte, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	o, ok := f.objects[key]
	return o.data, ok
}

func (f *fakeS3) keys(prefix string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for k := range f.objects {
		if strings.HasPrefix(k, prefix) {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

type listResult struct {
	XMLName  xml.Name `xml:"ListBucketResult"`
	Contents []struct {
		Key          string `xml:"Key"`
		LastModified string `xml:"LastModified"`
		ETag         string `xml:"ETag"`
		Size         int64  `xml:"Size"`
	} `xml:"Contents"`
	CommonPrefixes []struct {
		Prefix string `xml:"Prefix"`
	} `xml:"CommonPrefixes"`
	IsTruncated bool `xml:"IsTruncated"`
}

func (f *fakeS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path, _ := url.PathUnescape(r.URL.EscapedPath())
	bucket, key, _ := strings.Cut(strings.TrimPrefix(path, "/"), "/")
	if bucket != f.bucket {
		http.Error(w, "<Error><Code>NoSuchBucket</Code></Error>", http.StatusNotFound)
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if key == "" && r.Method == http.MethodGet {
		q := r.URL.Query()
		prefix, delimiter := q.Get("prefix"), q.Get("delimiter")
		f.calls = append(f.calls, "LIST ?"+prefix)
		var res listResult
		seen := map[string]bool{}
		var keys []string
		for k := range f.objects {
			if strings.HasPrefix(k, prefix) {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		for _, k := range keys {
			rest := k[len(prefix):]
			if delimiter != "" {
				if i := strings.Index(rest, delimiter); i >= 0 {
					p := prefix + rest[:i+len(delimiter)]
					if !seen[p] {
						seen[p] = true
						res.CommonPrefixes = append(res.CommonPrefixes, struct {
							Prefix string `xml:"Prefix"`
						}{p})
					}
					continue
				}
			}
			o := f.objects[k]
			res.Contents = append(res.Contents, struct {
				Key          string `xml:"Key"`
				LastModified string `xml:"LastModified"`
				ETag         string `xml:"ETag"`
				Size         int64  `xml:"Size"`
			}{k, o.modified.Format("2006-01-02T15:04:05.000Z"), o.etag, int64(len(o.data))})
		}
		data, _ := xml.Marshal(res)
		w.Header().Set("Content-Type", "application/xml")
		w.Write(data)
		return
	}
	f.calls = append(f.calls, r.Method+" "+key)
	o, exists := f.objects[key]
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		if !exists {
			http.Error(w, "<Error><Code>NoSuchKey</Code></Error>", http.StatusNotFound)
			return
		}
		if inm := r.Header.Get("If-None-Match"); inm != "" && inm == o.etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", o.etag)
		w.Header().Set("Last-Modified", o.modified.Format(http.TimeFormat))
		w.Header().Set("Content-Length", fmt.Sprint(len(o.data)))
		w.WriteHeader(http.StatusOK)
		if r.Method == http.MethodGet {
			w.Write(o.data)
		}
	case http.MethodPut:
		if r.Header.Get("If-None-Match") == "*" && exists {
			http.Error(w, "<Error><Code>PreconditionFailed</Code></Error>", http.StatusPreconditionFailed)
			return
		}
		if im := r.Header.Get("If-Match"); im != "" && (!exists || im != o.etag) {
			http.Error(w, "<Error><Code>PreconditionFailed</Code></Error>", http.StatusPreconditionFailed)
			return
		}
		var data []byte
		if src := r.Header.Get("X-Amz-Copy-Source"); src != "" {
			srcPath, _ := url.PathUnescape(src)
			_, srcKey, _ := strings.Cut(strings.TrimPrefix(srcPath, "/"), "/")
			from, ok := f.objects[srcKey]
			if !ok {
				http.Error(w, "<Error><Code>NoSuchKey</Code></Error>", http.StatusNotFound)
				return
			}
			data = from.data
		} else {
			data, _ = io.ReadAll(r.Body)
		}
		sum := md5.Sum(data)
		etag := `"` + hex.EncodeToString(sum[:]) + `"`
		f.objects[key] = fakeObject{data: data, modified: f.now().UTC(), etag: etag}
		w.Header().Set("ETag", etag)
		w.WriteHeader(http.StatusOK)
	case http.MethodDelete:
		delete(f.objects, key)
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}
