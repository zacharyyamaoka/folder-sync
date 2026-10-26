// Package account signs this machine in to folder-sync's accounts Worker (docs/peps/0003 §3.5) and keeps the
// session in ~/.folder-sync/account.json (schema folder-sync-account/1, mode 0600).
//
// `folder-sync login` is the device authorization grant (RFC 8628, Better Auth's deviceAuthorization plugin): the
// machine shows a code and <server>/fs/device?user_code=…, the person approves it in a browser where they are signed
// in, and the machine receives a session of its own, a bearer token. `folder-sync credentials` trades that token for
// short-lived R2 keys (POST /fs/v1/credentials); deleting the session (`folder-sync logout`) stops the machine at its
// next refresh. The token is a secret: it is never printed or logged, and it goes to the one server it came from
// (redirects are not followed).
package account

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Schema names account.json.
const Schema = "folder-sync-account/1"

// ClientID is the one device-grant client the accounts Worker accepts.
const ClientID = "folder-sync"

// EnvServer overrides DefaultServer: the accounts Worker, or an app's own /fs/ mount (https://robotparts.dev).
const EnvServer = "FOLDER_SYNC_SERVER"

// DefaultServer is the accounts Worker's own host. A placeholder until Zach's first deploy names it.
const DefaultServer = "https://folder-sync-accounts.example.workers.dev"

const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code"

// maxBody caps any answer read from the server.
const maxBody = 1 << 20

// ErrNotSignedIn: no account.json on this machine.
var ErrNotSignedIn = errors.New("this machine is not signed in: run `folder-sync login`")

// ErrSignedOut: the server no longer knows this machine's session (signed out or revoked), a 401.
var ErrSignedOut = errors.New("this machine's session has ended (signed out or revoked): run `folder-sync login` again")

// User is the person a session belongs to.
type User struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name,omitempty"`
}

// Account is ~/.folder-sync/account.json.
type Account struct {
	Schema   string `json:"schema"`
	Server   string `json:"server"`
	Token    string `json:"token"`
	User     User   `json:"user"`
	SignedIn string `json:"signed_in_at"`
}

// Load reads account.json; ErrNotSignedIn when there is none.
func Load(path string) (Account, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Account{}, ErrNotSignedIn
	}
	if err != nil {
		return Account{}, err
	}
	var a Account
	if err := json.Unmarshal(data, &a); err != nil {
		return Account{}, fmt.Errorf("%s: not valid JSON", path) // never echo the content: it holds the token
	}
	if a.Schema != Schema || a.Server == "" || a.Token == "" || a.User.ID == "" {
		return Account{}, fmt.Errorf("%s is not a %s file: run `folder-sync login` again", path, Schema)
	}
	return a, nil
}

// Save writes account.json with owner-only permissions, atomically.
func Save(path string, a Account) error {
	a.Schema = Schema
	data, err := json.MarshalIndent(a, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	// WHY 0600 from the first byte: the token is the machine's whole sign-in
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// Server is --server, else $FOLDER_SYNC_SERVER, else DefaultServer, checked: https, or http on this machine only.
func Server(flagValue string, getenv func(string) string) (string, error) {
	server := flagValue
	if server == "" {
		server = getenv(EnvServer)
	}
	if server == "" {
		server = DefaultServer
	}
	return CheckServer(server)
}

// CheckServer returns the server's origin (no path, no trailing slash). WHY http only on loopback: the token
// travels in every request, so it never crosses a network in the clear.
func CheckServer(server string) (string, error) {
	u, err := url.Parse(strings.TrimRight(server, "/"))
	if err != nil || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("%q is not a server address like https://robotparts.dev", server)
	}
	switch u.Scheme {
	case "https":
	case "http":
		if host := u.Hostname(); host != "localhost" && !isLoopback(host) {
			return "", fmt.Errorf("%s: http is only for this machine (127.0.0.1, localhost); use https", server)
		}
	default:
		return "", fmt.Errorf("%s: use https", server)
	}
	return u.Scheme + "://" + u.Host, nil
}

func isLoopback(host string) bool {
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

var unsafeHeader = regexp.MustCompile(`[^A-Za-z0-9._ -]`)

// UserAgent is "folder-sync/<version> (<host name>; <os>)" on every request. WHY: Better Auth stores the device-token
// request's User-Agent on the session it creates, so an account page can name each machine.
func UserAgent(version, hostName, goos string) string {
	name := unsafeHeader.ReplaceAllString(hostName, "?") // a header is one latin-1 line
	if len(name) > 64 {
		name = name[:64]
	}
	if name == "" {
		name = "host"
	}
	return fmt.Sprintf("folder-sync/%s (%s; %s)", version, name, goos)
}

// Client talks to one accounts server.
type Client struct {
	Server    string // an origin from CheckServer
	UserAgent string
	HTTP      *http.Client
}

// NewClient builds a Client that never follows a redirect (the bearer token goes to the one server).
func NewClient(server, userAgent string) *Client {
	return &Client{Server: server, UserAgent: userAgent, HTTP: &http.Client{
		Timeout:       30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

// ServerError is an answer the client could not use: the server's own { error, why }, or its status.
type ServerError struct {
	Status int
	Code   string
	Why    string
}

func (e *ServerError) Error() string {
	switch {
	case e.Why != "":
		return e.Why
	case e.Code != "":
		return fmt.Sprintf("%s (HTTP %d)", e.Code, e.Status)
	}
	return fmt.Sprintf("HTTP %d", e.Status)
}

// call sends one JSON request and returns the status and the raw body.
func (c *Client) call(ctx context.Context, method, path string, body any, token string) (int, []byte, error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		reader = bytes.NewReader(data)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.Server+path, reader)
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("User-Agent", c.UserAgent)
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	answer, err := c.HTTP.Do(request)
	if err != nil {
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			err = urlErr.Err // the URL is already in the message below
		}
		return 0, nil, fmt.Errorf("%s did not answer (%v)", c.Server, err)
	}
	defer answer.Body.Close()
	data, err := io.ReadAll(io.LimitReader(answer.Body, maxBody))
	if err != nil {
		return 0, nil, fmt.Errorf("%s: reading the answer: %v", c.Server, err)
	}
	return answer.StatusCode, data, nil
}

func serverError(status int, data []byte) *ServerError {
	var parsed struct {
		Error       string `json:"error"`
		Why         string `json:"why"`
		Description string `json:"error_description"`
		Message     string `json:"message"`
	}
	json.Unmarshal(data, &parsed)
	why := parsed.Why
	if why == "" {
		why = parsed.Description
	}
	if why == "" {
		why = parsed.Message
	}
	return &ServerError{Status: status, Code: parsed.Error, Why: why}
}

// Device is a pending device grant.
type Device struct {
	DeviceCode string `json:"device_code"`
	UserCode   string `json:"user_code"`
	URI        string `json:"verification_uri"`
	URIFull    string `json:"verification_uri_complete"`
	ExpiresIn  int    `json:"expires_in"`
	Interval   int    `json:"interval"`
}

// Shown is the user code as a person reads it: ABCD-EFGH.
func (d Device) Shown() string {
	if len(d.UserCode) == 8 {
		return d.UserCode[:4] + "-" + d.UserCode[4:]
	}
	return d.UserCode
}

// Link is where the person approves: the complete URI (code filled in), else the bare one.
func (d Device) Link() string {
	if d.URIFull != "" {
		return d.URIFull
	}
	return d.URI
}

// StartDevice asks for a device code (POST /fs/api/auth/device/code).
func (c *Client) StartDevice(ctx context.Context) (Device, error) {
	status, data, err := c.call(ctx, http.MethodPost, "/fs/api/auth/device/code", map[string]string{"client_id": ClientID}, "")
	if err != nil {
		return Device{}, err
	}
	var d Device
	if status != http.StatusOK || json.Unmarshal(data, &d) != nil || d.DeviceCode == "" || d.UserCode == "" || d.Link() == "" {
		return Device{}, fmt.Errorf("%s did not start a sign-in: %v", c.Server, serverError(status, data))
	}
	if d.Interval <= 0 {
		d.Interval = 5
	}
	if d.ExpiresIn <= 0 {
		d.ExpiresIn = 900
	}
	return d, nil
}

// AwaitApproval polls POST /fs/api/auth/device/token until the person approves, and returns the session token.
// sleep is injectable for tests; it returns early with ctx's error when ctx ends.
func (c *Client) AwaitApproval(ctx context.Context, d Device, sleep func(context.Context, time.Duration) error) (string, error) {
	interval := time.Duration(d.Interval) * time.Second
	deadline := time.Now().Add(time.Duration(d.ExpiresIn) * time.Second)
	unreachable := 0
	for time.Now().Before(deadline) {
		if err := sleep(ctx, interval); err != nil {
			return "", err
		}
		status, data, err := c.call(ctx, http.MethodPost, "/fs/api/auth/device/token",
			map[string]string{"grant_type": deviceGrant, "device_code": d.DeviceCode, "client_id": ClientID}, "")
		if err != nil {
			if unreachable++; unreachable >= 5 {
				return "", err
			}
			continue
		}
		unreachable = 0
		var answer struct {
			AccessToken string `json:"access_token"`
			Error       string `json:"error"`
		}
		json.Unmarshal(data, &answer)
		if status == http.StatusOK && answer.AccessToken != "" {
			return answer.AccessToken, nil
		}
		switch answer.Error {
		case "authorization_pending":
			continue
		case "slow_down":
			interval += 5 * time.Second
			continue
		case "access_denied":
			return "", errors.New("the sign-in was denied in the browser")
		case "expired_token", "invalid_grant":
			return "", errors.New("the code expired before it was approved: run `folder-sync login` again")
		}
		return "", fmt.Errorf("%s refused the sign-in: %v", c.Server, serverError(status, data))
	}
	return "", errors.New("the code expired before it was approved: run `folder-sync login` again")
}

// Sleep waits d or until ctx ends.
func Sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// Me is the person a token belongs to (GET /fs/v1/me); ErrSignedOut on a 401.
func (c *Client) Me(ctx context.Context, token string) (User, string, error) {
	status, data, err := c.call(ctx, http.MethodGet, "/fs/v1/me", nil, token)
	if err != nil {
		return User{}, "", err
	}
	if status == http.StatusUnauthorized {
		return User{}, "", ErrSignedOut
	}
	var answer struct {
		User User   `json:"user"`
		Root string `json:"root"`
	}
	if status != http.StatusOK || json.Unmarshal(data, &answer) != nil || answer.User.ID == "" {
		return User{}, "", fmt.Errorf("%s did not say who this is: %v", c.Server, serverError(status, data))
	}
	return answer.User, answer.Root, nil
}

// Credentials trades the token for short-lived keys (POST /fs/v1/credentials): the credential-process JSON, as sent.
// ErrSignedOut on a 401.
func (c *Client) Credentials(ctx context.Context, token string) ([]byte, error) {
	status, data, err := c.call(ctx, http.MethodPost, "/fs/v1/credentials", nil, token)
	if err != nil {
		return nil, err
	}
	if status == http.StatusUnauthorized {
		return nil, ErrSignedOut
	}
	var keys struct {
		Version         int    `json:"Version"`
		AccessKeyID     string `json:"AccessKeyId"`
		SecretAccessKey string `json:"SecretAccessKey"`
	}
	if status != http.StatusOK || json.Unmarshal(data, &keys) != nil || keys.Version != 1 || keys.AccessKeyID == "" || keys.SecretAccessKey == "" {
		return nil, fmt.Errorf("%s gave no storage keys: %v", c.Server, serverError(status, data))
	}
	return data, nil
}

// SignOut deletes this token's session on the server (POST /fs/v1/sign-out). A 401 means it is already gone.
func (c *Client) SignOut(ctx context.Context, token string) error {
	status, data, err := c.call(ctx, http.MethodPost, "/fs/v1/sign-out", map[string]any{}, token)
	if err != nil {
		return err
	}
	if status == http.StatusOK || status == http.StatusUnauthorized {
		return nil
	}
	return serverError(status, data)
}

// Folder is the folder row PATCH answers.
type Folder struct {
	Owner      string `json:"owner_id"`
	Project    string `json:"project"`
	Visibility string `json:"visibility"`
	UpdatedAt  string `json:"updated_at"`
}

// SetVisibility makes a project "public" or "private" (PATCH /fs/v1/folders/<project>).
func (c *Client) SetVisibility(ctx context.Context, token, project, visibility string) (Folder, error) {
	status, data, err := c.call(ctx, http.MethodPatch, "/fs/v1/folders/"+url.PathEscape(project), map[string]string{"visibility": visibility}, token)
	if err != nil {
		return Folder{}, err
	}
	if status == http.StatusUnauthorized {
		return Folder{}, ErrSignedOut
	}
	var row Folder
	if status != http.StatusOK || json.Unmarshal(data, &row) != nil || row.Visibility != visibility {
		return Folder{}, fmt.Errorf("%s did not change the folder: %v", c.Server, serverError(status, data))
	}
	return row, nil
}
