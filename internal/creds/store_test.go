package creds

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"folder-sync/internal/store"
)

func storeResolver(t *testing.T, url string, vars map[string]string) *Resolver {
	t.Helper()
	spec, err := store.Parse(url)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	r := NewResolver(filepath.Join(dir, "credentials.json"), filepath.Join(dir, "session.json"), env(vars))
	r.Store = spec
	return r
}

func TestS3StoreTakesTheAWSEnvironment(t *testing.T) {
	r := storeResolver(t, "s3://my-bucket/team", map[string]string{
		"AWS_ACCESS_KEY_ID": "AKIAEXAMPLE", "AWS_SECRET_ACCESS_KEY": "aws-secret", "AWS_SESSION_TOKEN": "aws-token", "AWS_REGION": "eu-west-2"})
	c, err := r.Current()
	if err != nil {
		t.Fatal(err)
	}
	if c.AccessKeyID != "AKIAEXAMPLE" || c.SecretAccessKey != "aws-secret" || c.SessionToken != "aws-token" ||
		c.Endpoint != "https://s3.eu-west-2.amazonaws.com" || c.Region != "eu-west-2" || c.Provider != "AWS" ||
		c.Prefix != "team/" || c.Source != "env" {
		t.Fatalf("%+v", c)
	}
}

func TestStoreOptionsAndOverridesHaveAnOrder(t *testing.T) {
	// FOLDER_SYNC_* beats AWS_*; the store URL's region beats AWS_REGION; FOLDER_SYNC_ENDPOINT beats the URL's endpoint
	r := storeResolver(t, "s3://my-bucket?endpoint=https://url.example&region=url-1", map[string]string{
		EnvAccessKeyID: "fsKEY1234", EnvSecretAccessKey: "fs-secret", "AWS_ACCESS_KEY_ID": "AKIA", "AWS_SECRET_ACCESS_KEY": "x", "AWS_REGION": "aws-1",
		EnvEndpoint: "http://127.0.0.1:9000"})
	c, err := r.Current()
	if err != nil {
		t.Fatal(err)
	}
	if c.AccessKeyID != "fsKEY1234" || c.Endpoint != "http://127.0.0.1:9000" || c.Region != "url-1" {
		t.Fatalf("%+v", c)
	}
	// the provider follows the endpoint finally used: a MinIO address is not AWS
	if c.Provider != "Other" {
		t.Errorf("provider = %q, want Other for an endpoint nobody priced", c.Provider)
	}
}

func TestMinIOEndpointFromTheEnvironment(t *testing.T) {
	r := storeResolver(t, "s3://fs-test", map[string]string{EnvAccessKeyID: "minioadmin", EnvSecretAccessKey: "minioadmin", EnvEndpoint: "http://127.0.0.1:9000"})
	c, err := r.Current()
	if err != nil {
		t.Fatal(err)
	}
	if c.Endpoint != "http://127.0.0.1:9000" || c.Region != "us-east-1" || c.Provider != "Other" || c.Prefix != "" {
		t.Fatalf("%+v", c)
	}
}

func TestGSStoreUsesGoogleInteroperability(t *testing.T) {
	r := storeResolver(t, "gs://notes/vault", map[string]string{"AWS_ACCESS_KEY_ID": "GOOGHMAC", "AWS_SECRET_ACCESS_KEY": "hmac-secret"})
	c, err := r.Current()
	if err != nil {
		t.Fatal(err)
	}
	if c.Endpoint != "https://storage.googleapis.com" || c.Provider != "GCS" || c.Prefix != "vault/" || c.Region != "us-east-1" {
		t.Fatalf("%+v", c)
	}
}

func TestSharedCredentialsFileAndProfile(t *testing.T) {
	file := filepath.Join(t.TempDir(), "credentials")
	os.WriteFile(file, []byte("# comment\n[default]\naws_access_key_id = DEFAULTKEY\naws_secret_access_key = default-secret\n\n"+
		"[work]\naws_access_key_id=WORKKEY1\naws_secret_access_key=work-secret\naws_session_token=work-token\n"), 0o600)
	for profile, want := range map[string]string{"": "DEFAULTKEY", "work": "WORKKEY1"} {
		r := storeResolver(t, "s3://my-bucket", map[string]string{"AWS_SHARED_CREDENTIALS_FILE": file, "AWS_PROFILE": profile})
		c, err := r.Current()
		if err != nil {
			t.Fatalf("profile %q: %v", profile, err)
		}
		if c.AccessKeyID != want {
			t.Errorf("profile %q: key %q, want %q", profile, c.AccessKeyID, want)
		}
		if profile == "work" && (c.SessionToken != "work-token" || c.SecretAccessKey != "work-secret") {
			t.Errorf("%+v", c)
		}
	}
	r := storeResolver(t, "s3://my-bucket", map[string]string{"AWS_SHARED_CREDENTIALS_FILE": file, "AWS_PROFILE": "nobody"})
	if _, err := r.Current(); err == nil || !strings.Contains(err.Error(), "nobody") {
		t.Errorf("an unknown profile: %v", err)
	}
}

func TestStoreWithoutAKeyNamesWhatToSet(t *testing.T) {
	r := storeResolver(t, "s3://my-bucket", map[string]string{})
	_, err := r.Current()
	if err == nil {
		t.Fatal("no key must be an error")
	}
	for _, want := range []string{"AWS_ACCESS_KEY_ID", EnvAccessKeyID, "s3://my-bucket", EnvCredentialProcess} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("%v does not mention %s", err, want)
		}
	}
}

// WHY: a key `login --key` saved is an R2 key; sending it to another provider's endpoint would hand a secret to the wrong party.
func TestStoredR2KeyIsNeverUsedForAnotherStore(t *testing.T) {
	r := storeResolver(t, "s3://my-bucket", map[string]string{})
	Save(r.CredentialsPath, Creds{AccessKeyID: "r2KEY1234", SecretAccessKey: "r2-secret", Endpoint: "https://acct.r2.cloudflarestorage.com"})
	if c, err := r.Current(); err == nil {
		t.Fatalf("used the stored R2 key for an s3 store: %+v", c)
	}
}

func TestFileStoreNeedsNoKey(t *testing.T) {
	r := storeResolver(t, "file:///srv/hub", map[string]string{})
	c, err := r.Current()
	if err != nil {
		t.Fatal(err)
	}
	if c.AccessKeyID != "" || c.Source != "file" || c.Prefix != "" || c.Bucket != "" {
		t.Fatalf("%+v", c)
	}
}

func TestR2StoreBehavesAsBefore(t *testing.T) {
	r := storeResolver(t, "r2://folder-sync", map[string]string{EnvAccessKeyID: "k1234567", EnvSecretAccessKey: "s", EnvAccountID: "abc123", "AWS_ACCESS_KEY_ID": "AKIA", "AWS_SECRET_ACCESS_KEY": "no"})
	c, err := r.Current()
	if err != nil {
		t.Fatal(err)
	}
	if c.Endpoint != "https://abc123.r2.cloudflarestorage.com" || c.Provider != "Cloudflare" || c.AccessKeyID != "k1234567" {
		t.Fatalf("%+v", c)
	}
	// and the AWS variables are not an R2 key
	r = storeResolver(t, "r2://folder-sync", map[string]string{"AWS_ACCESS_KEY_ID": "AKIA", "AWS_SECRET_ACCESS_KEY": "x"})
	if _, err := r.Current(); err == nil {
		t.Error("AWS_* variables must not be read for r2://")
	}
}

func TestProcessWithoutEndpointUnderAnS3Store(t *testing.T) {
	f := newFake(t)
	f.output(`{"Version":1,"AccessKeyId":"ASIAPROC1234","SecretAccessKey":"proc-secret","SessionToken":"proc-token","Expiration":"2026-10-25T12:15:00Z"}`)
	r := f.resolver(nil)
	spec, _ := store.Parse("s3://my-bucket/team?region=eu-north-1")
	r.Store = spec
	c, err := r.Current()
	if err != nil {
		t.Fatal(err)
	}
	if c.AccessKeyID != "ASIAPROC1234" || c.Endpoint != "https://s3.eu-north-1.amazonaws.com" || c.Prefix != "team/" || c.Provider != "AWS" {
		t.Fatalf("%+v", c)
	}
	// the cached copy is the same answer, with the prefix applied once
	again, err := r.Current()
	if err != nil || again.Prefix != "team/" || f.runs() != 1 {
		t.Fatalf("cached: %+v, %v, runs %d", again, err, f.runs())
	}
}

func TestProcessPrefixJoinsTheStorePrefix(t *testing.T) {
	f := newFake(t)
	r := f.resolver(nil)
	spec, _ := store.Parse("r2://folder-sync/shared")
	r.Store = spec
	c, err := r.Current()
	if err != nil {
		t.Fatal(err)
	}
	if c.Prefix != "shared/users/AbC123/" {
		t.Fatalf("prefix = %q", c.Prefix)
	}
}
