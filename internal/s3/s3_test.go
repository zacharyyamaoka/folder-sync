package s3

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestSignMatchesAWSExample checks SigV4 against AWS's published "GET Object" example
// (Amazon S3 API reference, "Signature Calculations for the Authorization Header").
func TestSignMatchesAWSExample(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "https://examplebucket.s3.amazonaws.com/test.txt", nil)
	req.Header.Set("Range", "bytes=0-9")
	Sign(req, "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1",
		time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC), EmptySHA256)
	want := "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
		"SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
		"Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
	if got := req.Header.Get("Authorization"); got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestEncodePath(t *testing.T) {
	if got := EncodePath("demo/hosts/x/a b+c/ü.md"); got != "demo/hosts/x/a%20b%2Bc/%C3%BC.md" {
		t.Fatal(got)
	}
}

func TestGetIfNoneMatch(t *testing.T) {
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.EscapedPath()+" inm="+r.Header.Get("If-None-Match"))
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=key/") {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/missing.json"):
			w.WriteHeader(http.StatusNotFound)
		case strings.HasSuffix(r.URL.Path, "/deaf.json"): // ignores If-None-Match
			w.Header().Set("ETag", `"v1"`)
			w.Write([]byte("{}"))
		case r.Header.Get("If-None-Match") == `"v1"`:
			w.WriteHeader(http.StatusNotModified)
		default:
			w.Header().Set("ETag", `"v1"`)
			w.Write([]byte(`{"a":1}`))
		}
	}))
	defer server.Close()
	client := &Client{Endpoint: server.URL, Region: "auto", AccessKeyID: "key", SecretAccessKey: "secret"}

	got, err := client.GetIfNoneMatch("bkt", "demo/hosts/h/manifest.json", "")
	if err != nil || got.NotModified || got.ETag != `"v1"` || string(got.Body) != `{"a":1}` {
		t.Fatalf("first GET: %+v %v", got, err)
	}
	got, err = client.GetIfNoneMatch("bkt", "demo/hosts/h/manifest.json", `"v1"`)
	if err != nil || !got.NotModified {
		t.Fatalf("conditional GET: %+v %v", got, err)
	}
	got, err = client.GetIfNoneMatch("bkt", "demo/hosts/h/deaf.json", `"v1"`)
	if err != nil || !got.NotModified {
		t.Fatalf("a server that ignores If-None-Match but returns the same ETag: %+v %v", got, err)
	}
	got, err = client.GetIfNoneMatch("bkt", "demo/missing.json", "")
	if err != nil || !got.NotFound {
		t.Fatalf("404: %+v %v", got, err)
	}
	if seen[0] != "GET /bkt/demo/hosts/h/manifest.json inm=" || seen[1] != `GET /bkt/demo/hosts/h/manifest.json inm="v1"` {
		t.Fatalf("requests: %q", seen)
	}
}

func TestHeadBucketErrors(t *testing.T) {
	status := http.StatusOK
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodHead || r.URL.Path != "/bkt" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(status)
	}))
	defer server.Close()
	client := &Client{Endpoint: server.URL, Region: "auto", AccessKeyID: "k", SecretAccessKey: "s"}
	if err := client.HeadBucket("bkt"); err != nil {
		t.Fatal(err)
	}
	status = http.StatusForbidden
	if err := client.HeadBucket("bkt"); err == nil || !strings.Contains(err.Error(), "bucket scope") {
		t.Fatal(err)
	}
	status = http.StatusNotFound
	if err := client.HeadBucket("bkt"); err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatal(err)
	}
}
