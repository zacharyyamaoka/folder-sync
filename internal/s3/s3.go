// Package s3 is the few S3 requests folder-sync makes itself: a HEAD of the
// bucket to check the key at init, and the conditional GET of a peer's
// manifest (docs/peps/0001 §4: "a conditional GET of each other machine's
// manifest"). rclone moves every file; this package moves only manifests,
// because rclone has no conditional GET, and a 304 costs one Class B operation
// instead of a HEAD plus a GET. objects.go adds the calls version history needs
// (docs/peps/0007 §3.1): a conditional server-side copy, a delete, a conditional
// PUT, a delimiter listing and a GET into a file.
package s3

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// EmptySHA256 is the payload hash of an empty body.
const EmptySHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

// Client signs path-style requests to one S3-compatible endpoint.
type Client struct {
	Endpoint        string // e.g. https://<account>.r2.cloudflarestorage.com
	Region          string // "auto" for R2
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string // temporary credentials only; signed as x-amz-security-token
	HTTP            *http.Client
	Now             func() time.Time
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 60 * time.Second}
}

func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

// EncodePath URI-encodes each segment of an object path, keeping the slashes.
func EncodePath(p string) string {
	segments := strings.Split(p, "/")
	for i, segment := range segments {
		segments[i] = uriEncode(segment)
	}
	return strings.Join(segments, "/")
}

func uriEncode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if ('A' <= ch && ch <= 'Z') || ('a' <= ch && ch <= 'z') || ('0' <= ch && ch <= '9') ||
			ch == '-' || ch == '_' || ch == '.' || ch == '~' {
			b.WriteByte(ch)
		} else {
			fmt.Fprintf(&b, "%%%02X", ch)
		}
	}
	return b.String()
}

// Sign adds SigV4 headers (x-amz-date, x-amz-content-sha256, Authorization) to req.
// Every header already on req, plus host, is signed.
func Sign(req *http.Request, accessKeyID, secretAccessKey, region string, now time.Time, payloadHash string) {
	SignWithToken(req, accessKeyID, secretAccessKey, "", region, now, payloadHash)
}

// SignWithToken is Sign for temporary credentials: a non-empty sessionToken is
// added as x-amz-security-token and signed with the other headers (R2 and S3
// reject temporary keys whose token is unsigned or missing).
func SignWithToken(req *http.Request, accessKeyID, secretAccessKey, sessionToken, region string, now time.Time, payloadHash string) {
	if sessionToken != "" {
		req.Header.Set("x-amz-security-token", sessionToken)
	}
	amzDate := now.UTC().Format("20060102T150405Z")
	day := amzDate[:8]
	req.Header.Set("x-amz-date", amzDate)
	req.Header.Set("x-amz-content-sha256", payloadHash)

	headers := map[string]string{"host": req.Host}
	if headers["host"] == "" {
		headers["host"] = req.URL.Host
	}
	for name, values := range req.Header {
		headers[strings.ToLower(name)] = strings.TrimSpace(strings.Join(values, ","))
	}
	names := make([]string, 0, len(headers))
	for name := range headers {
		names = append(names, name)
	}
	sort.Strings(names)
	var canonicalHeaders strings.Builder
	for _, name := range names {
		canonicalHeaders.WriteString(name + ":" + headers[name] + "\n")
	}
	signedHeaders := strings.Join(names, ";")

	query := req.URL.Query()
	keys := make([]string, 0, len(query))
	for key := range query {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var canonicalQuery []string
	for _, key := range keys {
		values := query[key]
		sort.Strings(values)
		for _, value := range values {
			canonicalQuery = append(canonicalQuery, uriEncode(key)+"="+uriEncode(value))
		}
	}

	canonicalRequest := strings.Join([]string{
		req.Method,
		req.URL.EscapedPath(),
		strings.Join(canonicalQuery, "&"),
		canonicalHeaders.String(),
		signedHeaders,
		payloadHash,
	}, "\n")
	scope := day + "/" + region + "/s3/aws4_request"
	stringToSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + sha256Hex([]byte(canonicalRequest))
	key := hmacSHA256([]byte("AWS4"+secretAccessKey), day)
	key = hmacSHA256(key, region)
	key = hmacSHA256(key, "s3")
	key = hmacSHA256(key, "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(key, stringToSign))
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+accessKeyID+"/"+scope+
		", SignedHeaders="+signedHeaders+", Signature="+signature)
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func hmacSHA256(key []byte, data string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(data))
	return mac.Sum(nil)
}

func (c *Client) sign(req *http.Request) {
	SignWithToken(req, c.AccessKeyID, c.SecretAccessKey, c.SessionToken, c.Region, c.now(), EmptySHA256)
}

func (c *Client) newRequest(method, bucket, key string) (*http.Request, error) {
	u, err := url.Parse(strings.TrimRight(c.Endpoint, "/"))
	if err != nil {
		return nil, err
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/" + bucket
	u.RawPath = strings.TrimRight(u.RawPath, "/") + "/" + uriEncode(bucket)
	if key != "" {
		u.Path += "/" + key
		u.RawPath += "/" + EncodePath(key)
	}
	return http.NewRequest(method, u.String(), nil)
}

// HeadBucket checks that the key can reach the bucket (one HEAD).
func (c *Client) HeadBucket(bucket string) error {
	req, err := c.newRequest(http.MethodHead, bucket, "")
	if err != nil {
		return err
	}
	c.sign(req)
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		return nil
	case http.StatusNotFound:
		return fmt.Errorf("bucket %q does not exist (HEAD returned 404): create it in the R2 dashboard", bucket)
	case http.StatusForbidden, http.StatusUnauthorized:
		return fmt.Errorf("the key cannot read bucket %q (HEAD returned %d): check the token's bucket scope", bucket, resp.StatusCode)
	default:
		return fmt.Errorf("HEAD bucket %q returned %s", bucket, resp.Status)
	}
}

// ListOne lists at most one key under prefix: the cheapest request a
// prefix-scoped credential may make (it cannot HEAD the bucket). 200 means the
// key can read that prefix.
func (c *Client) ListOne(bucket, prefix string) error {
	req, err := c.newRequest(http.MethodGet, bucket, "")
	if err != nil {
		return err
	}
	query := url.Values{}
	query.Set("list-type", "2")
	query.Set("prefix", prefix)
	query.Set("max-keys", "1")
	req.URL.RawQuery = query.Encode()
	c.sign(req)
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		return nil
	case http.StatusNotFound:
		return fmt.Errorf("bucket %q does not exist (LIST returned 404)", bucket)
	case http.StatusForbidden, http.StatusUnauthorized:
		return fmt.Errorf("the key cannot list prefix %q in bucket %q (LIST returned %d): the credentials are expired or scoped to another prefix", prefix, bucket, resp.StatusCode)
	default:
		return fmt.Errorf("LIST prefix %q in bucket %q returned %s", prefix, bucket, resp.Status)
	}
}

// Head answers an object's ETag as the store sent it (quoted), and found=false when there is no such object.
func (c *Client) Head(bucket, key string) (etag string, found bool, err error) {
	req, err := c.newRequest(http.MethodHead, bucket, key)
	if err != nil {
		return "", false, err
	}
	c.sign(req)
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return "", false, err
	}
	resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		return resp.Header.Get("ETag"), true, nil
	case http.StatusNotFound:
		return "", false, nil
	default:
		return "", false, fmt.Errorf("HEAD %s returned %s", key, resp.Status)
	}
}

// GetResult is a conditional GET's outcome.
type GetResult struct {
	NotModified bool   // 304: the caller's copy is current
	NotFound    bool   // 404
	ETag        string // the object's ETag (on 200)
	Body        []byte // the object (on 200)
}

// GetIfNoneMatch fetches an object unless its ETag still equals etag.
func (c *Client) GetIfNoneMatch(bucket, key, etag string) (GetResult, error) {
	req, err := c.newRequest(http.MethodGet, bucket, key)
	if err != nil {
		return GetResult{}, err
	}
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	c.sign(req)
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return GetResult{}, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusNotModified:
		return GetResult{NotModified: true, ETag: etag}, nil
	case http.StatusNotFound:
		return GetResult{NotFound: true}, nil
	case http.StatusOK:
		body, err := io.ReadAll(io.LimitReader(resp.Body, 256<<20))
		if err != nil {
			return GetResult{}, err
		}
		got := resp.Header.Get("ETag")
		if etag != "" && got == etag { // a server that ignores If-None-Match
			return GetResult{NotModified: true, ETag: etag}, nil
		}
		return GetResult{ETag: got, Body: body}, nil
	default:
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return GetResult{}, fmt.Errorf("GET %s returned %s: %s", key, resp.Status, strings.TrimSpace(string(snippet)))
	}
}
