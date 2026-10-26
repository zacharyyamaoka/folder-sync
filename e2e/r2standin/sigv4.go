package main

// AWS Signature Version 4 in the Authorization header, verified the way an S3 server checks it
// (docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html): the canonical request is rebuilt
// from what arrived on the wire (the raw path as sent: S3 neither normalises nor double-encodes it), the
// signed headers the client named, and the payload hash it declared.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Authorization is the parsed `AWS4-HMAC-SHA256 Credential=…, SignedHeaders=…, Signature=…` header.
type Authorization struct {
	AccessKeyID   string
	Date          string // YYYYMMDD from the credential scope
	Region        string
	Service       string
	SignedHeaders []string
	Signature     string
}

// ParseAuthorization reads the header; a missing or malformed one is a refusal.
func ParseAuthorization(header string) (Authorization, *Refusal) {
	const scheme = "AWS4-HMAC-SHA256 "
	if !strings.HasPrefix(header, scheme) {
		return Authorization{}, refuse(403, "AccessDenied", "every request must be signed with AWS4-HMAC-SHA256 (no anonymous access)")
	}
	var a Authorization
	for _, part := range strings.Split(strings.TrimPrefix(header, scheme), ",") {
		key, value, _ := strings.Cut(strings.TrimSpace(part), "=")
		switch key {
		case "Credential":
			fields := strings.Split(value, "/")
			if len(fields) != 5 || fields[4] != "aws4_request" {
				return Authorization{}, refuse(403, "AuthorizationHeaderMalformed", "the Credential is not <id>/<date>/<region>/s3/aws4_request")
			}
			a.AccessKeyID, a.Date, a.Region, a.Service = fields[0], fields[1], fields[2], fields[3]
		case "SignedHeaders":
			a.SignedHeaders = strings.Split(value, ";")
		case "Signature":
			a.Signature = value
		}
	}
	if a.AccessKeyID == "" || len(a.SignedHeaders) == 0 || a.Signature == "" || a.Service != "s3" {
		return Authorization{}, refuse(403, "AuthorizationHeaderMalformed", "the Authorization header lacks Credential, SignedHeaders or Signature")
	}
	return a, nil
}

// awsEncode is AWS's URI encoding: unreserved characters stay, everything else is %XX (upper case).
func awsEncode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if ('A' <= ch && ch <= 'Z') || ('a' <= ch && ch <= 'z') || ('0' <= ch && ch <= '9') || ch == '-' || ch == '_' || ch == '.' || ch == '~' {
			b.WriteByte(ch)
		} else {
			fmt.Fprintf(&b, "%%%02X", ch)
		}
	}
	return b.String()
}

// canonicalQuery sorts the raw query's parameters by name, then value, each decoded once and re-encoded.
func canonicalQuery(raw string) string {
	type pair struct{ k, v string }
	var pairs []pair
	for _, piece := range strings.Split(raw, "&") {
		if piece == "" {
			continue
		}
		k, v, _ := strings.Cut(piece, "=")
		dk, err := url.PathUnescape(k)
		if err != nil {
			dk = k
		}
		dv, err := url.PathUnescape(v)
		if err != nil {
			dv = v
		}
		pairs = append(pairs, pair{awsEncode(dk), awsEncode(dv)})
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].k != pairs[j].k {
			return pairs[i].k < pairs[j].k
		}
		return pairs[i].v < pairs[j].v
	})
	out := make([]string, len(pairs))
	for i, p := range pairs {
		out[i] = p.k + "=" + p.v
	}
	return strings.Join(out, "&")
}

func headerValue(r *http.Request, name string) string {
	switch name {
	case "host":
		return r.Host
	case "content-length":
		if values := r.Header.Values("Content-Length"); len(values) > 0 {
			return strings.Join(values, ",")
		}
		return strconv.FormatInt(r.ContentLength, 10)
	}
	values := r.Header.Values(http.CanonicalHeaderKey(name))
	trimmed := make([]string, len(values))
	for i, value := range values {
		trimmed[i] = strings.Join(strings.Fields(value), " ")
	}
	return strings.Join(trimmed, ",")
}

// VerifySigV4 checks the signature with secret. rawPath is the path exactly as it arrived on the request line.
func VerifySigV4(r *http.Request, rawPath, rawQuery string, a Authorization, secret string, now time.Time) *Refusal {
	amzDate := r.Header.Get("X-Amz-Date")
	when, err := time.Parse("20060102T150405Z", amzDate)
	if err != nil {
		return refuse(403, "AccessDenied", "X-Amz-Date is missing or not YYYYMMDDTHHMMSSZ")
	}
	if amzDate[:8] != a.Date {
		return refuse(403, "SignatureDoesNotMatch", "the credential scope's date is not X-Amz-Date's")
	}
	if skew := now.Sub(when); skew > 15*time.Minute || skew < -15*time.Minute {
		return refuse(403, "RequestTimeTooSkewed", "X-Amz-Date is more than 15 minutes from now")
	}
	payload := r.Header.Get("X-Amz-Content-Sha256")
	if payload == "" {
		return refuse(400, "InvalidRequest", "X-Amz-Content-Sha256 is missing")
	}
	signed := map[string]bool{}
	var canonicalHeaders strings.Builder
	for _, name := range a.SignedHeaders {
		signed[name] = true
		canonicalHeaders.WriteString(name + ":" + headerValue(r, name) + "\n")
	}
	if !signed["host"] {
		return refuse(403, "AccessDenied", "the signature does not cover the host header")
	}
	if r.Header.Get("X-Amz-Security-Token") != "" && !signed["x-amz-security-token"] {
		return refuse(403, "AccessDenied", "the session token is not a signed header")
	}
	canonical := strings.Join([]string{r.Method, rawPath, canonicalQuery(rawQuery), canonicalHeaders.String(),
		strings.Join(a.SignedHeaders, ";"), payload}, "\n")
	digest := sha256.Sum256([]byte(canonical))
	scope := a.Date + "/" + a.Region + "/s3/aws4_request"
	toSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + hex.EncodeToString(digest[:])
	key := hmacSHA256([]byte("AWS4"+secret), a.Date)
	key = hmacSHA256(key, a.Region)
	key = hmacSHA256(key, "s3")
	key = hmacSHA256(key, "aws4_request")
	want := hex.EncodeToString(hmacSHA256(key, toSign))
	if !hmac.Equal([]byte(want), []byte(a.Signature)) {
		return refuse(403, "SignatureDoesNotMatch", "the request signature does not match")
	}
	return nil
}

func hmacSHA256(key []byte, data string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(data))
	return mac.Sum(nil)
}
