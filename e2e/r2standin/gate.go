package main

// The gate: every request must be signed; a request signed with a temporary credential (an
// X-Amz-Security-Token) may do only what its claims allow, on only the keys its paths allow. Then it is
// forwarded, unchanged but for the auth headers, to the storage (`rclone serve s3` with no keys of its own).
//
// The rules, from Cloudflare's temporary-credentials page:
//   - scope object-read-only: read and list objects; object-read-write: read, write and list objects
//     (admin-* add bucket settings, which the stand-in has none of); or an explicit actions list.
//   - paths: "prefixPaths: keys starting with any listed prefix", "objectPaths: exact object keys";
//     omitted, the whole bucket.
// What the page does not spell out, and the stand-in therefore decides conservatively (so a client that
// passes here asks R2 for no more than it was given; scripts/check-r2-temp checks real R2 for each):
//   - a LIST is allowed only when its `prefix` starts with a listed prefix (an empty prefix is the bucket);
//   - a COPY needs the source key in scope as well as the destination;
//   - a multi-object DELETE needs every key in scope;
//   - HeadBucket and bucket-level calls need the parent key (no path-scoped credential gets them).

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// Refusal is an S3 error answer.
type Refusal struct {
	Status int
	Code   string
	Why    string
}

func refuse(status int, code, why string) *Refusal { return &Refusal{Status: status, Code: code, Why: why} }

func (r *Refusal) write(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(r.Status)
	fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>%s</Code><Message>%s</Message></Error>`,
		xmlEscape(r.Code), xmlEscape(r.Why))
}

func xmlEscape(s string) string {
	var b bytes.Buffer
	xml.EscapeText(&b, []byte(s))
	return b.String()
}

var readOps = []string{"HeadObject", "GetObject", "GetBucketLocation", "ListObjectsV1", "ListObjectsV2", "ListMultipartUploads", "ListParts"}
var writeOps = []string{"PutObject", "DeleteObject", "DeleteObjects", "CopyObject"}
var multipartOps = []string{"CreateMultipartUpload", "UploadPart", "UploadPartCopy", "AbortMultipartUpload", "CompleteMultipartUpload"}

var knownAction = func() map[string]bool {
	out := map[string]bool{}
	for _, list := range [][]string{readOps, writeOps, multipartOps} {
		for _, op := range list {
			out[op] = true
		}
	}
	return out
}()

func set(lists ...[]string) map[string]bool {
	out := map[string]bool{}
	for _, list := range lists {
		for _, op := range list {
			out[op] = true
		}
	}
	return out
}

var scopeOps = map[string]map[string]bool{
	"object-read-only":  set(readOps),
	"object-read-write": set(readOps, writeOps, multipartOps),
	"admin-read-only":   set(readOps, []string{"HeadBucket"}),
	"admin-read-write":  set(readOps, writeOps, multipartOps, []string{"HeadBucket"}),
}

// Operation is what a request asks the bucket to do.
type Operation struct {
	Name       string
	Bucket     string
	Key        string // object operations
	ListPrefix string // list operations
	IsList     bool
	CopyBucket string
	CopyKey    string
	DeleteKeys []string // DeleteObjects
}

// Classify names a path-style request's operation. rawPath is as sent; query is parsed from it.
func Classify(method, rawPath string, query url.Values, header http.Header, body []byte) (Operation, *Refusal) {
	path, err := url.PathUnescape(strings.TrimPrefix(rawPath, "/"))
	if err != nil {
		return Operation{}, refuse(400, "InvalidURI", "the path is not URL-encoded correctly")
	}
	bucket, key, _ := strings.Cut(path, "/")
	if bucket == "" {
		return Operation{}, refuse(403, "AccessDenied", "listing buckets needs the parent key")
	}
	op := Operation{Bucket: bucket, Key: key}
	has := func(name string) bool { _, ok := query[name]; return ok }
	if key == "" {
		switch {
		case method == http.MethodGet && has("location"):
			op.Name = "GetBucketLocation"
		case method == http.MethodGet && has("uploads"):
			op.Name, op.IsList, op.ListPrefix = "ListMultipartUploads", true, query.Get("prefix")
		case method == http.MethodGet && query.Get("list-type") == "2":
			op.Name, op.IsList, op.ListPrefix = "ListObjectsV2", true, query.Get("prefix")
		case method == http.MethodGet:
			op.Name, op.IsList, op.ListPrefix = "ListObjectsV1", true, query.Get("prefix")
		case method == http.MethodPost && has("delete"):
			op.Name = "DeleteObjects"
			var doc struct {
				Objects []struct {
					Key string `xml:"Key"`
				} `xml:"Object"`
			}
			if err := xml.Unmarshal(body, &doc); err != nil {
				return Operation{}, refuse(400, "MalformedXML", "the delete list is not XML")
			}
			for _, object := range doc.Objects {
				op.DeleteKeys = append(op.DeleteKeys, object.Key)
			}
		case method == http.MethodHead:
			op.Name = "HeadBucket"
		default:
			op.Name = "BucketOperation:" + method
		}
		return op, nil
	}
	source := header.Get("X-Amz-Copy-Source")
	switch {
	case method == http.MethodGet && has("uploadId"):
		op.Name = "ListParts"
	case method == http.MethodGet:
		op.Name = "GetObject"
	case method == http.MethodHead:
		op.Name = "HeadObject"
	case method == http.MethodPut && has("uploadId") && source != "":
		op.Name = "UploadPartCopy"
	case method == http.MethodPut && has("uploadId"):
		op.Name = "UploadPart"
	case method == http.MethodPut && source != "":
		op.Name = "CopyObject"
	case method == http.MethodPut:
		op.Name = "PutObject"
	case method == http.MethodDelete && has("uploadId"):
		op.Name = "AbortMultipartUpload"
	case method == http.MethodDelete:
		op.Name = "DeleteObject"
	case method == http.MethodPost && has("uploads"):
		op.Name = "CreateMultipartUpload"
	case method == http.MethodPost && has("uploadId"):
		op.Name = "CompleteMultipartUpload"
	default:
		op.Name = "ObjectOperation:" + method
	}
	if source != "" {
		decoded, err := url.PathUnescape(strings.SplitN(source, "?", 2)[0])
		if err != nil {
			return Operation{}, refuse(400, "InvalidArgument", "x-amz-copy-source is not URL-encoded correctly")
		}
		op.CopyBucket, op.CopyKey, _ = strings.Cut(strings.TrimPrefix(decoded, "/"), "/")
	}
	return op, nil
}

func keyInScope(key string, p *Paths) bool {
	if p == nil {
		return true
	}
	for _, prefix := range p.PrefixPaths {
		if prefix != "" && strings.HasPrefix(key, prefix) {
			return true
		}
	}
	for _, object := range p.ObjectPaths {
		if key == object {
			return true
		}
	}
	return false
}

func listInScope(prefix string, p *Paths) bool {
	if p == nil {
		return true
	}
	for _, allowed := range p.PrefixPaths {
		if allowed != "" && strings.HasPrefix(prefix, allowed) {
			return true
		}
	}
	return false
}

// Authorize decides an operation for a temporary credential's claims (nil claims: the parent key).
func Authorize(op Operation, c *Claims) *Refusal {
	if c == nil {
		return nil // the parent key: the whole bucket
	}
	allowed := scopeOps[c.Scope]
	if c.hasActions {
		allowed = set(c.Actions)
	}
	if !allowed[op.Name] {
		return refuse(403, "AccessDenied", fmt.Sprintf("this credential may not %s", op.Name))
	}
	switch {
	case op.IsList:
		if !listInScope(op.ListPrefix, c.Paths) {
			return refuse(403, "AccessDenied", fmt.Sprintf("this credential may not list prefix %q", op.ListPrefix))
		}
	case op.Name == "DeleteObjects":
		for _, key := range op.DeleteKeys {
			if !keyInScope(key, c.Paths) {
				return refuse(403, "AccessDenied", fmt.Sprintf("this credential may not delete %q", key))
			}
		}
	case op.Name == "GetBucketLocation":
	default:
		if !keyInScope(op.Key, c.Paths) {
			return refuse(403, "AccessDenied", fmt.Sprintf("this credential may not touch %q", op.Key))
		}
	}
	if op.CopyKey != "" || op.CopyBucket != "" {
		if op.CopyBucket != op.Bucket {
			return refuse(403, "AccessDenied", "a temporary credential is bound to one bucket")
		}
		if !keyInScope(op.CopyKey, c.Paths) {
			return refuse(403, "AccessDenied", fmt.Sprintf("this credential may not read the copy source %q", op.CopyKey))
		}
	}
	return nil
}

// Gate is the HTTP handler.
type Gate struct {
	Account string
	Parents map[string]string // access key id -> secret
	Backend string            // host:port of the storage
	Now     func() time.Time
	Log     io.Writer
	logMu   sync.Mutex
	client  *http.Client
}

// Entry is one line of the gate's log: what was asked, and the decision. Never a secret or a token.
type Entry struct {
	T          string   `json:"t"`
	Key        string   `json:"key_id"` // the last 4 characters
	Temporary  bool     `json:"temporary"`
	Prefixes   []string `json:"prefixes,omitempty"`
	Op         string   `json:"op"`
	Bucket     string   `json:"bucket,omitempty"`
	Object     string   `json:"object,omitempty"`
	ListPrefix string   `json:"list_prefix,omitempty"`
	CopyFrom   string   `json:"copy_from,omitempty"`
	Allowed    bool     `json:"allowed"`
	Why        string   `json:"why,omitempty"`
	Status     int      `json:"status"`
}

func (g *Gate) now() time.Time {
	if g.Now != nil {
		return g.Now()
	}
	return time.Now()
}

func (g *Gate) log(e Entry) {
	if g.Log == nil {
		return
	}
	e.T = g.now().UTC().Format(time.RFC3339Nano)
	line, _ := json.Marshal(e)
	g.logMu.Lock()
	defer g.logMu.Unlock()
	g.Log.Write(append(line, '\n'))
}

func last4(id string) string {
	if len(id) <= 4 {
		return "…"
	}
	return "…" + id[len(id)-4:]
}

func (g *Gate) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rawPath, rawQuery, _ := strings.Cut(r.RequestURI, "?")
	body, err := io.ReadAll(io.LimitReader(r.Body, 256<<20))
	if err != nil {
		refuse(400, "IncompleteBody", "the body could not be read").write(w)
		return
	}
	entry := Entry{}
	decided := func(refusal *Refusal) {
		entry.Allowed = false
		entry.Why = refusal.Code + ": " + refusal.Why
		entry.Status = refusal.Status
		g.log(entry)
		refusal.write(w)
	}
	auth, refusal := ParseAuthorization(r.Header.Get("Authorization"))
	if refusal != nil {
		entry.Op = "unsigned"
		decided(refusal)
		return
	}
	entry.Key = last4(auth.AccessKeyID)
	parentSecret, known := g.Parents[auth.AccessKeyID]
	if !known {
		entry.Op = "unknown-key"
		decided(refuse(403, "InvalidAccessKeyId", "no such access key"))
		return
	}
	query, _ := url.ParseQuery(rawQuery)
	op, refusal := Classify(r.Method, rawPath, query, r.Header, body)
	if refusal != nil {
		entry.Op = "unclassified"
		decided(refusal)
		return
	}
	entry.Op, entry.Bucket, entry.Object, entry.ListPrefix = op.Name, op.Bucket, op.Key, op.ListPrefix
	if op.CopyKey != "" {
		entry.CopyFrom = op.CopyBucket + "/" + op.CopyKey
	}
	secret := parentSecret
	var claims *Claims
	if token := r.Header.Get("X-Amz-Security-Token"); token != "" {
		entry.Temporary = true
		jwt, err := DecodeSessionToken(token)
		if err != nil {
			decided(refuse(400, "InvalidToken", err.Error()))
			return
		}
		parsed, err := VerifyJWT(jwt, parentSecret)
		if err != nil {
			decided(refuse(403, "InvalidToken", err.Error()))
			return
		}
		if parsed.Paths != nil {
			entry.Prefixes = parsed.Paths.PrefixPaths
		}
		if refusal := ValidateClaims(parsed, g.Account, auth.AccessKeyID, r.Host, op.Bucket, g.now()); refusal != nil {
			decided(refusal)
			return
		}
		claims, secret = &parsed, TempSecret(jwt)
	}
	if refusal := VerifySigV4(r, rawPath, rawQuery, auth, secret, g.now()); refusal != nil {
		decided(refusal)
		return
	}
	if refusal := Authorize(op, claims); refusal != nil {
		decided(refusal)
		return
	}
	status := g.forward(w, r, body)
	entry.Allowed, entry.Status = true, status
	g.log(entry)
}

// forward sends the request to the storage without its auth headers and copies the answer back.
func (g *Gate) forward(w http.ResponseWriter, r *http.Request, body []byte) int {
	if g.client == nil {
		g.client = &http.Client{Timeout: 5 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}}
	}
	out, err := http.NewRequest(r.Method, "http://"+g.Backend+r.RequestURI, bytes.NewReader(body))
	if err != nil {
		refuse(500, "InternalError", err.Error()).write(w)
		return 500
	}
	for name, values := range r.Header {
		switch strings.ToLower(name) {
		case "authorization", "x-amz-security-token", "host", "content-length":
			continue
		}
		out.Header[name] = values
	}
	out.ContentLength = int64(len(body))
	answer, err := g.client.Do(out)
	if err != nil {
		refuse(502, "InternalError", "the storage did not answer").write(w)
		return 502
	}
	defer answer.Body.Close()
	for name, values := range answer.Header {
		w.Header()[name] = values
	}
	w.WriteHeader(answer.StatusCode)
	io.Copy(w, answer.Body)
	return answer.StatusCode
}

// openLog appends to path, or discards when path is empty.
func openLog(path string) (io.Writer, error) {
	if path == "" {
		return nil, nil
	}
	return os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
}
