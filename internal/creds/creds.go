// Package creds holds the bucket key: environment variables first, then
// ~/.folder-sync/credentials.json (written by `folder-sync login`, mode 0600).
//
// v0 uses one bucket-scoped R2 key (docs/peps/0001 §9). v1 adds a credential
// process (process.go): a program folder-sync runs for short-lived keys limited
// to one account prefix. A secret or session token is never logged or printed;
// Redacted shows only the key id's last four characters.
package creds

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Environment variables a machine or cloud agent can set instead of logging in.
const (
	EnvAccessKeyID     = "FOLDER_SYNC_ACCESS_KEY_ID"
	EnvSecretAccessKey = "FOLDER_SYNC_SECRET_ACCESS_KEY"
	EnvAccountID       = "FOLDER_SYNC_ACCOUNT_ID" // the R2 endpoint is https://<account-id>.r2.cloudflarestorage.com
	EnvEndpoint        = "FOLDER_SYNC_ENDPOINT"   // overrides the account id (S3-compatible stand-ins)
	EnvProvider        = "FOLDER_SYNC_PROVIDER"   // rclone's s3 provider; default Cloudflare
	EnvRegion          = "FOLDER_SYNC_REGION"     // default auto (R2)
)

// Schema names the credentials file format.
const Schema = "folder-sync-credentials/1"

// Creds is a bucket key and where to use it.
type Creds struct {
	Schema          string `json:"schema"`
	AccessKeyID     string `json:"access_key_id"`
	SecretAccessKey string `json:"secret_access_key"`
	Endpoint        string `json:"endpoint"`
	Provider        string `json:"provider"`
	Region          string `json:"region"`
	Source          string `json:"-"` // "env", "process" or the file path

	// The fields below come only from a credential process (process.go) and are never stored in credentials.json.
	SessionToken string    `json:"-"` // signed as x-amz-security-token; rclone gets it as SESSION_TOKEN
	Expiration   time.Time `json:"-"` // zero: the process gave none
	Prefix       string    `json:"-"` // the account root every key starts with ("" or "users/AbC123/")
	Bucket       string    `json:"-"` // the only bucket these credentials can use ("" = any)
	// ReadOnly: the keys only read (an account over its storage quota, docs/peps/0003 §3.7): a round pulls, holds its
	// uploads and sends its deletes through the accounts server. Reason says why, for the person.
	ReadOnly bool   `json:"-"`
	Reason   string `json:"-"`
}

// FromEnv reads the key from the environment. ok is false when no key is set.
func FromEnv(getenv func(string) string) (c Creds, ok bool, err error) {
	id, secret := getenv(EnvAccessKeyID), getenv(EnvSecretAccessKey)
	if id == "" && secret == "" {
		return Creds{}, false, nil
	}
	if id == "" || secret == "" {
		return Creds{}, false, fmt.Errorf("set both %s and %s", EnvAccessKeyID, EnvSecretAccessKey)
	}
	c = Creds{Schema: Schema, AccessKeyID: id, SecretAccessKey: secret,
		Endpoint: getenv(EnvEndpoint), Provider: getenv(EnvProvider), Region: getenv(EnvRegion), Source: "env"}
	if c.Endpoint == "" {
		account := getenv(EnvAccountID)
		if account == "" {
			return Creds{}, false, fmt.Errorf("set %s (or %s for an S3-compatible stand-in)", EnvAccountID, EnvEndpoint)
		}
		c.Endpoint = "https://" + account + ".r2.cloudflarestorage.com"
	}
	c.fillDefaults()
	return c, true, nil
}

func (c *Creds) fillDefaults() {
	if c.Provider == "" {
		c.Provider = "Cloudflare"
	}
	if c.Region == "" {
		c.Region = "auto"
	}
	c.Endpoint = strings.TrimRight(c.Endpoint, "/")
}

// Load returns the environment's key if set, else the stored one.
func Load(path string, getenv func(string) string) (Creds, error) {
	if c, ok, err := FromEnv(getenv); err != nil || ok {
		return c, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Creds{}, fmt.Errorf("no bucket key: set %s and %s (plus %s), or run `folder-sync login`",
			EnvAccessKeyID, EnvSecretAccessKey, EnvAccountID)
	}
	if err != nil {
		return Creds{}, err
	}
	var c Creds
	if err := json.Unmarshal(data, &c); err != nil {
		return Creds{}, fmt.Errorf("%s: not valid JSON", path) // never echo the content
	}
	if c.AccessKeyID == "" || c.SecretAccessKey == "" || c.Endpoint == "" {
		return Creds{}, fmt.Errorf("%s is incomplete: run `folder-sync login` again", path)
	}
	c.fillDefaults()
	c.Source = path
	return c, nil
}

// Save writes the key with owner-only permissions.
func Save(path string, c Creds) error {
	c.Schema = Schema
	c.fillDefaults()
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Redacted describes the key without revealing it.
func (c Creds) Redacted() string {
	id := c.AccessKeyID
	if len(id) > 4 {
		id = "…" + id[len(id)-4:]
	} else {
		id = "…"
	}
	scope := ""
	if c.Prefix != "" {
		scope = ", prefix " + c.Prefix
	}
	if c.SessionToken != "" {
		scope += ", short-lived"
	}
	return fmt.Sprintf("key %s at %s (provider %s%s, from %s)", id, c.Endpoint, c.Provider, scope, c.Source)
}

// Scrub replaces the secret, the session token and the key id in text before it is logged or shown.
func (c Creds) Scrub(text string) string {
	for _, secret := range []string{c.SecretAccessKey, c.SessionToken, c.AccessKeyID} {
		if len(secret) >= 4 {
			text = strings.ReplaceAll(text, secret, "[redacted]")
		}
	}
	return text
}
