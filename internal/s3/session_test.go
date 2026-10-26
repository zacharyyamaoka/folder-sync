package s3

import (
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// An independent SigV4 for one request with a session token: the canonical request is
// written out by hand, so a Sign that forgets to sign x-amz-security-token cannot agree with it.
func TestSignSignsTheSessionToken(t *testing.T) {
	now := time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)
	req, _ := http.NewRequest(http.MethodGet, "https://acct.r2.cloudflarestorage.com/bkt?list-type=2&max-keys=1&prefix=users%2FAbC123%2F", nil)
	SignWithToken(req, "ASIAEXAMPLE", "secret-key", "tok/en+1", "auto", now, EmptySHA256)

	auth := req.Header.Get("Authorization")
	if !strings.Contains(auth, "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,") {
		t.Fatalf("x-amz-security-token must be a signed header: %s", auth)
	}
	if got := req.Header.Get("x-amz-security-token"); got != "tok/en+1" {
		t.Fatalf("token header = %q", got)
	}
	canonical := strings.Join([]string{
		"GET",
		"/bkt",
		"list-type=2&max-keys=1&prefix=users%2FAbC123%2F",
		"host:acct.r2.cloudflarestorage.com\nx-amz-content-sha256:" + EmptySHA256 + "\nx-amz-date:20261025T120000Z\nx-amz-security-token:tok/en+1\n",
		"host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
		EmptySHA256,
	}, "\n")
	scope := "20261025/auto/s3/aws4_request"
	stringToSign := "AWS4-HMAC-SHA256\n20261025T120000Z\n" + scope + "\n" + sha256Hex([]byte(canonical))
	key := hmacSHA256([]byte("AWS4secret-key"), "20261025")
	key = hmacSHA256(key, "auto")
	key = hmacSHA256(key, "s3")
	key = hmacSHA256(key, "aws4_request")
	want := "AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE/" + scope + ", SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=" +
		hex.EncodeToString(hmacSHA256(key, stringToSign))
	if auth != want {
		t.Fatalf("got  %s\nwant %s", auth, want)
	}

	// Without a token nothing changes (the AWS example still passes) and no header appears.
	plain, _ := http.NewRequest(http.MethodGet, "https://acct.r2.cloudflarestorage.com/bkt", nil)
	Sign(plain, "ASIAEXAMPLE", "secret-key", "auto", now, EmptySHA256)
	if plain.Header.Get("x-amz-security-token") != "" || strings.Contains(plain.Header.Get("Authorization"), "x-amz-security-token") {
		t.Fatal("no token, no security-token header")
	}
}

func TestListOne(t *testing.T) {
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.Path+"?"+r.URL.Query().Encode())
		if r.Header.Get("x-amz-security-token") != "tok" || !strings.Contains(r.Header.Get("Authorization"), "x-amz-security-token") {
			t.Errorf("the session token must be sent and signed: %v", r.Header)
		}
		if strings.HasPrefix(r.URL.Query().Get("prefix"), "users/Other") {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Write([]byte(`<ListBucketResult/>`))
	}))
	defer server.Close()
	client := &Client{Endpoint: server.URL, Region: "auto", AccessKeyID: "key", SecretAccessKey: "secret", SessionToken: "tok"}
	if err := client.ListOne("folder-sync", "users/AbC123/"); err != nil {
		t.Fatal(err)
	}
	if want := "GET /folder-sync?list-type=2&max-keys=1&prefix=users%2FAbC123%2F"; len(seen) != 1 || seen[0] != want {
		t.Fatalf("%q", seen)
	}
	err := client.ListOne("folder-sync", "users/Other1/")
	if err == nil || !strings.Contains(err.Error(), `"users/Other1/"`) || !strings.Contains(err.Error(), "403") {
		t.Fatalf("a 403 must name the prefix: %v", err)
	}
}

func TestHeadAndGetSignTheSessionToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-amz-security-token") != "tok" || !strings.Contains(r.Header.Get("Authorization"), "x-amz-security-token") {
			t.Errorf("%s %s: the session token must be sent and signed", r.Method, r.URL.Path)
		}
		w.Write([]byte("{}"))
	}))
	defer server.Close()
	client := &Client{Endpoint: server.URL, Region: "auto", AccessKeyID: "key", SecretAccessKey: "secret", SessionToken: "tok"}
	if err := client.HeadBucket("folder-sync"); err != nil {
		t.Fatal(err)
	}
	if _, err := client.GetIfNoneMatch("folder-sync", "users/AbC123/demo/hosts/x/manifest.json", ""); err != nil {
		t.Fatal(err)
	}
}
