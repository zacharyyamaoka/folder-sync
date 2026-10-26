package main

// R2's locally signed temporary credentials, as Cloudflare documents them
// (developers.cloudflare.com/r2/api/s3/temporary-credentials/, "Locally (client-side signing)",
// and r2/examples/authenticate-r2-temp-credentials/, read 2026-10-25):
//
//   - the session token is base64("jwt/" + <JWT>), the JWT signed HS256 with the PARENT key's secret;
//   - its claims: bucket, exactly one of scope or actions, optional paths {prefixPaths, objectPaths},
//     sub = the account id, iss = the parent access key id, aud = the endpoint's host, iat, exp;
//   - the temporary secret access key is the lowercase hex SHA-256 of the JWT string;
//   - the access key id is the parent's.
//
// This file is the stand-in's own reading of that page, written apart from the code under test (the
// vibetracks.dev Worker mints, this verifies), so the two can only agree by both following the page.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Paths is the optional path scope of a temporary credential.
type Paths struct {
	PrefixPaths []string `json:"prefixPaths"`
	ObjectPaths []string `json:"objectPaths"`
}

// Claims is a temporary credential's JWT payload.
type Claims struct {
	Bucket  string    `json:"bucket"`
	Scope   string    `json:"scope,omitempty"`
	Actions []string  `json:"actions,omitempty"`
	Paths   *Paths    `json:"paths,omitempty"`
	Sub     string    `json:"sub"`
	Iss     string    `json:"iss"`
	Aud     audiences `json:"aud"`
	Iat     int64     `json:"iat"`
	Exp     int64     `json:"exp"`
	Nbf     int64     `json:"nbf,omitempty"`
	// hasScope/hasActions record whether the keys were present at all (an empty string still counts as set).
	hasScope, hasActions bool
}

// audiences accepts aud as one string or a list (RFC 7519 §4.1.3).
type audiences []string

func (a *audiences) UnmarshalJSON(data []byte) error {
	var one string
	if err := json.Unmarshal(data, &one); err == nil {
		*a = audiences{one}
		return nil
	}
	var many []string
	if err := json.Unmarshal(data, &many); err != nil {
		return errors.New("aud is neither a string nor a list of strings")
	}
	*a = many
	return nil
}

func (a audiences) has(host string) bool {
	for _, value := range a {
		if value == host {
			return true
		}
	}
	return false
}

var b64url = base64.RawURLEncoding

// DecodeSessionToken returns the JWT inside a session token: base64("jwt/" + jwt).
func DecodeSessionToken(token string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(token)
	if err != nil {
		if raw, err = base64.RawStdEncoding.DecodeString(token); err != nil {
			return "", errors.New("the session token is not base64")
		}
	}
	text := string(raw)
	if !strings.HasPrefix(text, "jwt/") {
		return "", errors.New(`the session token does not start with "jwt/"`)
	}
	return strings.TrimPrefix(text, "jwt/"), nil
}

// VerifyJWT checks an HS256 JWT against the parent secret and returns its claims. It checks the signature
// and the token's shape only; ValidateClaims checks what the claims say.
func VerifyJWT(jwt, parentSecret string) (Claims, error) {
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		return Claims{}, errors.New("not a JWT (three dot-separated parts)")
	}
	var header struct {
		Alg string `json:"alg"`
	}
	headerJSON, err := b64url.DecodeString(parts[0])
	if err != nil || json.Unmarshal(headerJSON, &header) != nil {
		return Claims{}, errors.New("the JWT header is not base64url JSON")
	}
	if header.Alg != "HS256" {
		return Claims{}, fmt.Errorf("the JWT's alg is %q, not HS256", header.Alg)
	}
	mac := hmac.New(sha256.New, []byte(parentSecret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	want := mac.Sum(nil)
	got, err := b64url.DecodeString(parts[2])
	if err != nil || !hmac.Equal(got, want) {
		return Claims{}, errors.New("the JWT's signature does not verify with the parent key")
	}
	payload, err := b64url.DecodeString(parts[1])
	if err != nil {
		return Claims{}, errors.New("the JWT payload is not base64url")
	}
	var claims Claims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return Claims{}, fmt.Errorf("the JWT payload is not the claims object: %v", err)
	}
	var keys map[string]json.RawMessage
	json.Unmarshal(payload, &keys)
	_, claims.hasScope = keys["scope"]
	_, claims.hasActions = keys["actions"]
	return claims, nil
}

// TempSecret is the temporary secret access key: the lowercase hex SHA-256 of the JWT string.
func TempSecret(jwt string) string {
	sum := sha256.Sum256([]byte(jwt))
	return hex.EncodeToString(sum[:])
}

// ValidateClaims checks the claims for a request to bucket on host at now. A failure is a refusal.
func ValidateClaims(c Claims, account, parentID, host, bucket string, now time.Time) *Refusal {
	switch {
	case c.hasScope && c.hasActions:
		return refuse(400, "InvalidArgument", "a temporary credential sets both scope and actions")
	case !c.hasScope && !c.hasActions:
		return refuse(400, "InvalidArgument", "a temporary credential sets neither scope nor actions")
	case c.hasScope && !knownScope(c.Scope):
		return refuse(400, "InvalidArgument", fmt.Sprintf("unknown scope %q", c.Scope))
	case c.hasActions && len(c.Actions) == 0:
		return refuse(400, "InvalidArgument", "actions is empty")
	case c.Iss != parentID:
		return refuse(403, "InvalidToken", "the JWT's iss is not this access key id")
	case c.Sub != account:
		return refuse(403, "InvalidToken", "the JWT's sub is not this account")
	case !c.Aud.has(host):
		return refuse(403, "InvalidToken", fmt.Sprintf("the JWT's aud is not %s", host))
	case c.Exp == 0 || now.Unix() >= c.Exp:
		return refuse(400, "ExpiredToken", "the temporary credential has expired")
	case c.Nbf != 0 && now.Unix() < c.Nbf:
		return refuse(403, "InvalidToken", "the temporary credential is not valid yet")
	case c.Iat != 0 && c.Iat > now.Add(time.Minute).Unix():
		return refuse(403, "InvalidToken", "the temporary credential was issued in the future")
	case c.Bucket != bucket:
		return refuse(403, "AccessDenied", fmt.Sprintf("this credential is for bucket %q, not %q", c.Bucket, bucket))
	}
	for _, action := range c.Actions {
		if !knownAction[action] {
			return refuse(400, "InvalidArgument", fmt.Sprintf("unknown action %q", action))
		}
	}
	return nil
}

func knownScope(scope string) bool {
	_, ok := scopeOps[scope]
	return ok
}

// Mint signs a temporary credential the way Cloudflare's example helper does. The stand-in uses it for
// folder-sync's own end-to-end test; the Vibe Tracks proof mints with the Worker instead.
func Mint(account, parentID, parentSecret, endpointHost, bucket string, claims map[string]any, ttl time.Duration, now time.Time) (accessKeyID, secret, sessionToken string, expires time.Time) {
	header := b64url.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	body := map[string]any{"bucket": bucket, "sub": account, "iss": parentID, "aud": endpointHost,
		"iat": now.Unix(), "exp": now.Add(ttl).Unix()}
	for key, value := range claims {
		body[key] = value
	}
	payloadJSON, _ := json.Marshal(body)
	payload := b64url.EncodeToString(payloadJSON)
	mac := hmac.New(sha256.New, []byte(parentSecret))
	mac.Write([]byte(header + "." + payload))
	jwt := header + "." + payload + "." + b64url.EncodeToString(mac.Sum(nil))
	return parentID, TempSecret(jwt), base64.StdEncoding.EncodeToString([]byte("jwt/" + jwt)), time.Unix(now.Add(ttl).Unix(), 0).UTC()
}
