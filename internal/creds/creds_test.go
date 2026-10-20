package creds

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func env(vars map[string]string) func(string) string {
	return func(key string) string { return vars[key] }
}

func TestEnvComesFirstAndBuildsTheR2Endpoint(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	Save(path, Creds{AccessKeyID: "fileKEY1234", SecretAccessKey: "file-secret", Endpoint: "https://file.example"})
	c, err := Load(path, env(map[string]string{EnvAccessKeyID: "envKEY5678", EnvSecretAccessKey: "env-secret", EnvAccountID: "abc123"}))
	if err != nil {
		t.Fatal(err)
	}
	if c.AccessKeyID != "envKEY5678" || c.Endpoint != "https://abc123.r2.cloudflarestorage.com" || c.Provider != "Cloudflare" || c.Region != "auto" || c.Source != "env" {
		t.Fatalf("%+v", c)
	}
}

func TestEnvNeedsBothHalves(t *testing.T) {
	if _, _, err := FromEnv(env(map[string]string{EnvAccessKeyID: "x"})); err == nil {
		t.Fatal("a key id without a secret must be an error")
	}
	if _, _, err := FromEnv(env(map[string]string{EnvAccessKeyID: "x", EnvSecretAccessKey: "y"})); err == nil {
		t.Fatal("no account id and no endpoint must be an error")
	}
}

func TestSaveIsOwnerOnlyAndLoadable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "credentials.json")
	if err := Save(path, Creds{AccessKeyID: "AKIDEXAMPLE", SecretAccessKey: "s3cr3t-value", Endpoint: "http://127.0.0.1:4801/", Provider: "Other"}); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(path)
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("mode %v", info.Mode().Perm())
		}
	}
	c, err := Load(path, env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.Endpoint != "http://127.0.0.1:4801" || c.Provider != "Other" || c.Source != path {
		t.Fatalf("%+v", c)
	}
	if _, err := Load(filepath.Join(t.TempDir(), "none.json"), env(nil)); err == nil || !strings.Contains(err.Error(), "folder-sync login") {
		t.Fatal(err)
	}
}

func TestSecretsNeverShow(t *testing.T) {
	c := Creds{AccessKeyID: "AKIDEXAMPLE1234", SecretAccessKey: "very-secret-value", Endpoint: "https://x", Provider: "Cloudflare", Source: "env"}
	if r := c.Redacted(); strings.Contains(r, "very-secret") || strings.Contains(r, "AKIDEXAMPLE") || !strings.Contains(r, "…1234") {
		t.Fatal(r)
	}
	if s := c.Scrub("auth very-secret-value for AKIDEXAMPLE1234"); strings.Contains(s, "very-secret") || strings.Contains(s, "AKIDEXAMPLE1234") {
		t.Fatal(s)
	}
	bad := filepath.Join(t.TempDir(), "c.json")
	os.WriteFile(bad, []byte("not json very-secret-value"), 0o600)
	if _, err := Load(bad, env(nil)); err == nil || strings.Contains(err.Error(), "very-secret") {
		t.Fatalf("a broken file's error must not echo its content: %v", err)
	}
}
