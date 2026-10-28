package s3

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestCopyIsConditionalAndBare: a copy names its source URL-encoded, asks for no metadata on the copy, sends the
// manifest's ETag as x-amz-copy-source-if-match (quoted), and a 412 is ErrPreconditionFailed.
func TestCopyIsConditionalAndBare(t *testing.T) {
	var got http.Header
	var path string
	status := http.StatusOK
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, path = r.Header.Clone(), r.URL.EscapedPath()
		w.WriteHeader(status)
		if status == http.StatusOK {
			io.WriteString(w, `<CopyObjectResult><ETag>"x"</ETag></CopyObjectResult>`)
		}
	}))
	defer server.Close()
	client := &Client{Endpoint: server.URL, Region: "auto", AccessKeyID: "key", SecretAccessKey: "secret"}
	dst := "_history/demo/h/a b.md/2026-10-28T20:31:00.117Z_9f2c1a3b4c5d6e7f"
	if err := client.Copy("bkt", "demo/hosts/h/a b.md", dst, "0123abcd"); err != nil {
		t.Fatal(err)
	}
	if path != "/bkt/_history/demo/h/a%20b.md/2026-10-28T20%3A31%3A00.117Z_9f2c1a3b4c5d6e7f" {
		t.Errorf("path %s", path)
	}
	if got.Get("X-Amz-Copy-Source") != "/bkt/demo/hosts/h/a%20b.md" || got.Get("X-Amz-Copy-Source-If-Match") != `"0123abcd"` ||
		got.Get("X-Amz-Metadata-Directive") != "REPLACE" {
		t.Errorf("headers %v", got)
	}
	if !strings.Contains(got.Get("Authorization"), "x-amz-copy-source;x-amz-copy-source-if-match;") {
		t.Errorf("the copy headers must be signed: %s", got.Get("Authorization"))
	}
	client.Copy("bkt", "a", "b", "")
	if _, sent := got["X-Amz-Copy-Source-If-Match"]; sent {
		t.Error("no ETag, no condition")
	}
	status = http.StatusPreconditionFailed
	if err := client.Copy("bkt", "a", "b", `"0123abcd"`); !errors.Is(err, ErrPreconditionFailed) {
		t.Errorf("412: %v", err)
	}
	status = http.StatusNotFound
	if err := client.Copy("bkt", "a", "b", ""); !errors.Is(err, ErrNotFound) {
		t.Errorf("404: %v", err)
	}
}

func TestPutConditions(t *testing.T) {
	var got http.Header
	var body string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		data, _ := io.ReadAll(r.Body)
		body = string(data)
		if r.Header.Get("If-None-Match") == "*" && strings.HasSuffix(r.URL.Path, "/exists.json") {
			w.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		w.Header().Set("ETag", `"new"`)
	}))
	defer server.Close()
	client := &Client{Endpoint: server.URL, Region: "auto", AccessKeyID: "key", SecretAccessKey: "secret"}
	etag, err := client.Put("bkt", "_requests/p/h/new.json", []byte(`{"a":1}`), "application/json", "*", "")
	if err != nil || etag != `"new"` || body != `{"a":1}` || got.Get("Content-Type") != "application/json" {
		t.Fatalf("%q %v %q %v", etag, err, body, got)
	}
	if got.Get("X-Amz-Content-Sha256") != sha256Hex([]byte(`{"a":1}`)) {
		t.Error("the payload is signed by its hash")
	}
	if _, err := client.Put("bkt", "_requests/p/h/exists.json", nil, "", "*", ""); !errors.Is(err, ErrPreconditionFailed) {
		t.Errorf("If-None-Match: * on an existing key: %v", err)
	}
	client.Put("bkt", "k", nil, "", "", "abc")
	if got.Get("If-Match") != `"abc"` {
		t.Errorf("If-Match %q", got.Get("If-Match"))
	}
}

// TestListPagesAndDelimits: List follows continuation tokens and returns common prefixes; the query is signed as sent.
func TestListPagesAndDelimits(t *testing.T) {
	var queries []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		queries = append(queries, r.URL.RawQuery)
		if r.URL.Query().Get("continuation-token") == "" {
			fmt.Fprint(w, `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t2</NextContinuationToken>`+
				`<Contents><Key>_history/p/h/a b.md/2026-10-28T20:31:00.117Z_9f2c1a3b4c5d6e7f</Key><LastModified>2026-10-28T20:41:00.402Z</LastModified><ETag>"e1"</ETag><Size>7</Size></Contents>`+
				`</ListBucketResult>`)
			return
		}
		fmt.Fprint(w, `<ListBucketResult><IsTruncated>false</IsTruncated><CommonPrefixes><Prefix>_history/p/h/a b.md/deeper/</Prefix></CommonPrefixes></ListBucketResult>`)
	}))
	defer server.Close()
	client := &Client{Endpoint: server.URL, Region: "auto", AccessKeyID: "key", SecretAccessKey: "secret"}
	got, err := client.List("bkt", "_history/p/h/a b.md/", "/")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Objects) != 1 || got.Objects[0].Size != 7 || !got.Objects[0].LastModified.Equal(time.Date(2026, 10, 28, 20, 41, 0, 402e6, time.UTC)) ||
		len(got.Prefixes) != 1 || got.Prefixes[0] != "_history/p/h/a b.md/deeper/" {
		t.Fatalf("%+v", got)
	}
	if len(queries) != 2 || !strings.Contains(queries[0], "prefix=_history%2Fp%2Fh%2Fa%20b.md%2F") || !strings.Contains(queries[0], "delimiter=%2F") ||
		!strings.Contains(queries[1], "continuation-token=t2") {
		t.Fatalf("queries %q", queries)
	}
}

func TestDeleteAndGetToFile(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodDelete && strings.HasSuffix(r.URL.Path, "/gone"):
			w.WriteHeader(http.StatusNotFound)
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		case strings.HasSuffix(r.URL.Path, "/missing"):
			w.WriteHeader(http.StatusNotFound)
		default:
			io.WriteString(w, "the bytes")
		}
	}))
	defer server.Close()
	client := &Client{Endpoint: server.URL, Region: "auto", AccessKeyID: "key", SecretAccessKey: "secret"}
	if err := client.Delete("bkt", "a"); err != nil {
		t.Fatal(err)
	}
	if err := client.Delete("bkt", "gone"); err != nil {
		t.Fatalf("deleting a deleted key is a no-op: %v", err)
	}
	out := filepath.Join(t.TempDir(), "v")
	if err := client.GetToFile("bkt", "v", out); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(out); string(data) != "the bytes" {
		t.Fatalf("%q", data)
	}
	if err := client.GetToFile("bkt", "missing", out); !errors.Is(err, ErrNotFound) {
		t.Fatalf("404: %v", err)
	}
}

// TestBusyAnswersAreSentAgain: a 5xx is sent again, body and all, and a 4xx is not.
func TestBusyAnswersAreSentAgain(t *testing.T) {
	var bodies []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		bodies = append(bodies, string(data))
		switch {
		case strings.HasSuffix(r.URL.Path, "/denied"):
			w.WriteHeader(http.StatusForbidden)
		case len(bodies) == 1:
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer server.Close()
	client := &Client{Endpoint: server.URL, Region: "auto", AccessKeyID: "key", SecretAccessKey: "secret"}
	if _, err := client.Put("bkt", "k", []byte("record"), "", "", ""); err != nil {
		t.Fatal(err)
	}
	if len(bodies) != 2 || bodies[1] != "record" {
		t.Fatalf("bodies %q", bodies)
	}
	bodies = nil
	if err := client.Delete("bkt", "denied"); err == nil || len(bodies) != 1 {
		t.Fatalf("a 403 is final: %v, %d requests", err, len(bodies))
	}
}
