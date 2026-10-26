package rclone

import (
	"strings"
	"testing"

	"folder-sync/internal/creds"
)

func TestEnvCarriesTheSessionTokenOnlyWhenThereIsOne(t *testing.T) {
	c := creds.Creds{AccessKeyID: "id", SecretAccessKey: "secret", Endpoint: "https://a.r2.cloudflarestorage.com", Provider: "Cloudflare", Region: "auto"}
	has := func(env []string, want string) bool {
		for _, kv := range env {
			if kv == want {
				return true
			}
		}
		return false
	}
	// A stale token in the caller's environment must not survive either way.
	base := []string{"PATH=/bin", "RCLONE_CONFIG_FSREMOTE_SESSION_TOKEN=stale"}

	c.SessionToken = "tok-session-abcdef"
	if env := (Runner{Creds: c}).Env(base); !has(env, "RCLONE_CONFIG_FSREMOTE_SESSION_TOKEN=tok-session-abcdef") || strings.Contains(strings.Join(env, "\n"), "stale") {
		t.Fatalf("%q", env)
	}
	c.SessionToken = ""
	if env := (Runner{Creds: c}).Env(base); strings.Contains(strings.Join(env, "\n"), "SESSION_TOKEN") {
		t.Fatalf("no token, no SESSION_TOKEN: %q", env)
	}
}
