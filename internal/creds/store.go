package creds

// Keys for a store that is not R2 (docs/STORAGE.md). The store URL says where the bytes are; this says how a machine
// proves it may touch them: folder-sync's own variables first, then the standard AWS ones every S3 tool reads
// (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, the shared credentials file and AWS_PROFILE), or a
// credential process: AWS's own `aws configure export-credentials --format process` prints exactly the shape
// FOLDER_SYNC_CREDENTIAL_PROCESS reads. A file:// store needs no key.

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"folder-sync/internal/store"
)

// The standard AWS variables, read for s3:// and gs:// stores only (gs:// takes a Google HMAC key in the same two).
const (
	EnvAWSAccessKeyID     = "AWS_ACCESS_KEY_ID"
	EnvAWSSecretAccessKey = "AWS_SECRET_ACCESS_KEY"
	EnvAWSSessionToken    = "AWS_SESSION_TOKEN"
	EnvAWSRegion          = "AWS_REGION"
	EnvAWSDefaultRegion   = "AWS_DEFAULT_REGION"
	EnvAWSProfile         = "AWS_PROFILE"
	EnvAWSCredentialsFile = "AWS_SHARED_CREDENTIALS_FILE"
)

// usesOtherStore reports whether the resolver's store is s3:// or gs:// (r2:// and an unset store keep the R2 rules).
func (r *Resolver) usesOtherStore() bool { return r.Store.Kind == store.S3 || r.Store.Kind == store.GS }

// currentForStore is Current for a store that is not R2 and not behind a credential process.
func (r *Resolver) currentForStore() (Creds, error) {
	if r.Store.Kind == store.File {
		return Creds{Schema: Schema, Source: "file"}, nil
	}
	c, ok, err := r.storeKeyFromEnv()
	if err != nil {
		return Creds{}, err
	}
	if !ok {
		return Creds{}, fmt.Errorf("no key for %s: set %s and %s, or the standard %s and %s (or a profile in ~/.aws/credentials), "+
			"or %s to a program that prints keys (`aws configure export-credentials --format process` does)",
			r.Store.String(), EnvAccessKeyID, EnvSecretAccessKey, EnvAWSAccessKeyID, EnvAWSSecretAccessKey, EnvCredentialProcess)
	}
	r.applyStore(&c)
	return c, nil
}

func (r *Resolver) storeKeyFromEnv() (Creds, bool, error) {
	get := r.Getenv
	id, secret := get(EnvAccessKeyID), get(EnvSecretAccessKey)
	if id != "" || secret != "" {
		if id == "" || secret == "" {
			return Creds{}, false, fmt.Errorf("set both %s and %s", EnvAccessKeyID, EnvSecretAccessKey)
		}
		return Creds{Schema: Schema, AccessKeyID: id, SecretAccessKey: secret, Source: "env"}, true, nil
	}
	id, secret = get(EnvAWSAccessKeyID), get(EnvAWSSecretAccessKey)
	if id != "" || secret != "" {
		if id == "" || secret == "" {
			return Creds{}, false, fmt.Errorf("set both %s and %s", EnvAWSAccessKeyID, EnvAWSSecretAccessKey)
		}
		return Creds{Schema: Schema, AccessKeyID: id, SecretAccessKey: secret, SessionToken: get(EnvAWSSessionToken), Source: "env"}, true, nil
	}
	path := get(EnvAWSCredentialsFile)
	if path == "" {
		home := get("HOME")
		if home == "" {
			home = get("USERPROFILE")
		}
		if home == "" {
			return Creds{}, false, nil
		}
		path = filepath.Join(home, ".aws", "credentials")
	}
	profile := get(EnvAWSProfile)
	explicit := profile != ""
	if profile == "" {
		profile = "default"
	}
	file, err := os.Open(path)
	if err != nil {
		return Creds{}, false, nil
	}
	defer file.Close()
	section := ""
	values := map[string]string{}
	found := false
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		switch {
		case line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";"):
		case strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]"):
			section = strings.TrimSpace(strings.TrimPrefix(strings.Trim(line, "[]"), "profile "))
			found = found || section == profile
		case section == profile:
			if key, value, ok := strings.Cut(line, "="); ok {
				values[strings.ToLower(strings.TrimSpace(key))] = strings.TrimSpace(value)
			}
		}
	}
	if !found {
		if explicit {
			return Creds{}, false, fmt.Errorf("%s has no profile %q (%s)", path, profile, EnvAWSProfile)
		}
		return Creds{}, false, nil
	}
	if values["aws_access_key_id"] == "" || values["aws_secret_access_key"] == "" {
		return Creds{}, false, fmt.Errorf("%s: profile %q has no aws_access_key_id and aws_secret_access_key", path, profile)
	}
	return Creds{Schema: Schema, AccessKeyID: values["aws_access_key_id"], SecretAccessKey: values["aws_secret_access_key"],
		SessionToken: values["aws_session_token"], Source: path}, true, nil
}

// applyStore fills what the store URL decides, once, in the order: the environment (FOLDER_SYNC_ENDPOINT, _REGION,
// _PROVIDER: this machine's override), the URL's options, what the keys came with (a credential process), the AWS
// region variables, the kind's default. The URL's prefix goes in front of the keys' own (the engine's Root).
// WHY the environment beats the URL: a .folder-sync.toml is copied between machines, and a MinIO on the LAN has another
// address from each.
func (r *Resolver) applyStore(c *Creds) {
	if !r.usesOtherStore() && r.Store.Prefix == "" {
		return
	}
	if r.usesOtherStore() {
		switch {
		case r.Getenv(EnvRegion) != "":
			c.Region = r.Getenv(EnvRegion)
		case r.Store.Region != "":
			c.Region = r.Store.Region
		case c.Region == "":
			c.Region = firstNonEmpty(r.Getenv(EnvAWSRegion), r.Getenv(EnvAWSDefaultRegion))
		}
		effective := r.Store
		effective.Region = c.Region
		switch {
		case r.Getenv(EnvEndpoint) != "":
			c.Endpoint = r.Getenv(EnvEndpoint)
		case r.Store.Endpoint != "":
			c.Endpoint = r.Store.Endpoint
		case c.Endpoint == "":
			c.Endpoint = effective.EndpointOrDefault()
		}
		effective.Endpoint, effective.Region = c.Endpoint, effective.RegionOrDefault()
		c.Region = effective.Region
		switch {
		case r.Getenv(EnvProvider) != "":
			c.Provider = r.Getenv(EnvProvider)
		case r.Store.Provider != "":
			c.Provider = r.Store.Provider
		case c.Provider == "":
			c.Provider = effective.RcloneProvider()
		}
		c.Endpoint = strings.TrimRight(c.Endpoint, "/")
	}
	c.Prefix = r.Store.Prefix + c.Prefix
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
