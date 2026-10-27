package creds

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

var clockStart = time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)

// goodOutput is a credential process's answer with every optional field and one unknown field.
const goodOutput = `{"Version":1,"AccessKeyId":"ASIAEXAMPLE1234","SecretAccessKey":"very-secret-value","SessionToken":"tok-session-abcdef",` +
	`"Expiration":"2026-10-25T12:15:00Z","Endpoint":"https://acct.r2.cloudflarestorage.com","Bucket":"folder-sync",` +
	`"Prefix":"users/AbC123/","Region":"auto","Provider":"Cloudflare","User":{"id":"AbC123","email":"a@b.c"}}`

// fakeProcess is a shell script in a temp dir. Its behaviour follows the file "mode"
// (ok, signedout, fail, hang) and every run appends a line to "runs".
type fakeProcess struct {
	dir    string
	script string
	now    time.Time
}

func newFake(t *testing.T) *fakeProcess {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fake credential process is a /bin/sh script")
	}
	home := t.TempDir()
	t.Setenv("HOME", home) // NEVER the real ~/.folder-sync
	t.Setenv("USERPROFILE", home)
	dir := t.TempDir()
	f := &fakeProcess{dir: dir, script: filepath.Join(dir, "cred-process"), now: clockStart}
	body := "#!/bin/sh\n" +
		"echo run >> " + dir + "/runs\n" +
		"mode=$(cat " + dir + "/mode 2>/dev/null || echo ok)\n" +
		"case \"$mode\" in\n" +
		"  ok) cat " + dir + "/out.json ;;\n" +
		"  signedout) echo 'chatter' >&2; echo 'this machine is signed out: run vt login' >&2; exit 3 ;;\n" +
		"  fail) echo 'network is down' >&2; exit 4 ;;\n" +
		"  hang) exec sleep 30 ;;\n" +
		"  big) head -c 70000 /dev/zero | tr '\\0' 'a' ;;\n" +
		"esac\n"
	if err := os.WriteFile(f.script, []byte(body), 0o755); err != nil {
		t.Skip("cannot write a fake credential process here:", err)
	}
	f.output(goodOutput)
	return f
}

func (f *fakeProcess) output(json string) {
	os.WriteFile(filepath.Join(f.dir, "out.json"), []byte(json), 0o600)
}
func (f *fakeProcess) mode(m string) { os.WriteFile(filepath.Join(f.dir, "mode"), []byte(m), 0o600) }
func (f *fakeProcess) runs() int {
	data, _ := os.ReadFile(filepath.Join(f.dir, "runs"))
	return strings.Count(string(data), "run")
}
func (f *fakeProcess) session() string { return filepath.Join(f.dir, "home", "session.json") }

func (f *fakeProcess) argv() string {
	data, _ := json.Marshal([]string{f.script})
	return string(data)
}

func (f *fakeProcess) resolver(extra map[string]string) *Resolver {
	vars := map[string]string{EnvCredentialProcess: f.argv()}
	for k, v := range extra {
		vars[k] = v
	}
	r := NewResolver(filepath.Join(f.dir, "home", "credentials.json"), f.session(), env(vars))
	r.Now = func() time.Time { return f.now }
	return r
}

func TestProcessSuccessCarriesEveryFieldAndCaches(t *testing.T) {
	f := newFake(t)
	r := f.resolver(nil)
	c, err := r.Current()
	if err != nil {
		t.Fatal(err)
	}
	if c.AccessKeyID != "ASIAEXAMPLE1234" || c.SecretAccessKey != "very-secret-value" || c.SessionToken != "tok-session-abcdef" ||
		c.Endpoint != "https://acct.r2.cloudflarestorage.com" || c.Bucket != "folder-sync" || c.Prefix != "users/AbC123/" ||
		c.Region != "auto" || c.Provider != "Cloudflare" || c.Source != "process" ||
		!c.Expiration.Equal(time.Date(2026, 10, 25, 12, 15, 0, 0, time.UTC)) {
		t.Fatalf("%+v", c)
	}
	info, err := os.Stat(f.session())
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("session.json mode %v", info.Mode().Perm())
	}
	var file struct {
		Schema    string `json:"schema"`
		Process   string `json:"process"`
		FetchedAt string `json:"fetched_at"`
	}
	data, _ := os.ReadFile(f.session())
	json.Unmarshal(data, &file)
	if file.Schema != "folder-sync-session/1" || len(file.Process) != 64 || file.FetchedAt != "2026-10-25T12:00:00Z" {
		t.Fatalf("%s", data)
	}
	// Still fresh: no second run.
	f.now = clockStart.Add(2 * time.Minute)
	if again, err := r.Current(); err != nil || again.SessionToken != c.SessionToken || f.runs() != 1 {
		t.Fatalf("runs=%d err=%v", f.runs(), err)
	}
}

func TestProcessCacheIsKeyedByArgv(t *testing.T) {
	f := newFake(t)
	if _, err := f.resolver(nil).Current(); err != nil {
		t.Fatal(err)
	}
	// Same script, one more argument: a different process, so the cache is not reused.
	data, _ := json.Marshal([]string{f.script, "other"})
	r := f.resolver(map[string]string{EnvCredentialProcess: string(data)})
	if _, err := r.Current(); err != nil || f.runs() != 2 {
		t.Fatalf("runs=%d err=%v", f.runs(), err)
	}
}

func TestProcessExit3IsSignedOutAndDropsTheCache(t *testing.T) {
	f := newFake(t)
	r := f.resolver(nil)
	if _, err := r.Current(); err != nil {
		t.Fatal(err)
	}
	f.mode("signedout")
	f.now = clockStart.Add(11 * time.Minute) // a refresh is due, and the old keys would still be valid
	_, err := r.Current()
	if !errors.Is(err, ErrSignedOut) {
		t.Fatalf("want signed out, got %v", err)
	}
	if err.Error() != "this machine is signed out: run vt login" {
		t.Fatalf("the message is the program's last stderr line, got %q", err)
	}
	if _, statErr := os.Stat(f.session()); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatal("session.json must be deleted on exit 3")
	}
	// And it is not coming back from a cache: the next call asks the program again.
	f.mode("fail")
	if _, err := r.Current(); err == nil || errors.Is(err, ErrSignedOut) {
		t.Fatalf("after exit 3 nothing is cached, a transient failure must fail: %v", err)
	}
}

func TestProcessTransientFailureUsesAValidCacheOnly(t *testing.T) {
	f := newFake(t)
	r := f.resolver(nil)
	first, err := r.Current()
	if err != nil {
		t.Fatal(err)
	}
	f.mode("fail")
	f.now = clockStart.Add(11 * time.Minute) // refresh due (under 5 min left), still valid (4 min left)
	got, err := r.Current()
	if err != nil || got.SessionToken != first.SessionToken || f.runs() != 2 {
		t.Fatalf("a valid cache must carry a transient failure: runs=%d err=%v", f.runs(), err)
	}
	f.now = clockStart.Add(14*time.Minute + 40*time.Second) // 20 s left: not usable
	_, err = r.Current()
	if err == nil || errors.Is(err, ErrSignedOut) || !strings.Contains(err.Error(), "network is down") {
		t.Fatalf("an expiring cache must fail with the last stderr line: %v", err)
	}
	f.now = clockStart.Add(20 * time.Minute) // expired
	if _, err := r.Current(); err == nil {
		t.Fatal("an expired cache must not be used")
	}
}

func TestProcessTimeoutKillsTheProgram(t *testing.T) {
	f := newFake(t)
	f.mode("hang")
	r := f.resolver(nil)
	r.Timeout = 300 * time.Millisecond
	start := time.Now()
	_, err := r.Current()
	if err == nil || !strings.Contains(err.Error(), "killed") {
		t.Fatalf("want a timeout error, got %v", err)
	}
	if took := time.Since(start); took > 10*time.Second {
		t.Fatalf("the program was not killed: took %s", took)
	}
}

func TestRefreshRule(t *testing.T) {
	at := func(d time.Duration) time.Time { return clockStart.Add(d) }
	minute := time.Minute
	cases := []struct {
		name     string
		lifetime time.Duration // 0: no Expiration
		elapsed  time.Duration
		wantDue  bool
	}{
		{"15 min life: fresh at 9 min", 15 * minute, 9 * minute, false},
		{"15 min life: due when under 5 min left", 15 * minute, 10*minute + time.Second, true},
		{"9 min life: lead is a third (3 min)", 9 * minute, 5 * minute, false},
		{"9 min life: due under 3 min left", 9 * minute, 6*minute + time.Second, true},
		{"1 h life: lead capped at 5 min", 60 * minute, 54 * minute, false},
		{"1 h life: due under 5 min left", 60 * minute, 55*minute + time.Second, true},
		{"no expiration: fresh at 14 min", 0, 14 * minute, false},
		{"no expiration: due at 15 min", 0, 15 * minute, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := Creds{}
			if tc.lifetime > 0 {
				c.Expiration = at(tc.lifetime)
			}
			if got := refreshDue(c, clockStart, at(tc.elapsed)); got != tc.wantDue {
				t.Fatalf("refreshDue = %v, want %v", got, tc.wantDue)
			}
		})
	}
}

func TestPrefixValidation(t *testing.T) {
	good := []string{"", "users/AbC123/", "a/", "a/b/c/d/e/f/g/h/", "users/a.b_c-d/", "0/"}
	bad := []string{"users/x", "/users/x/", "users//x/", "users/../x/", "../", "./", ".a/", "-a/", "users/x/ ", "a/b/c/d/e/f/g/h/i/", "users\\x/", "us ers/"}
	for _, p := range good {
		if err := ValidatePrefix(p); err != nil {
			t.Errorf("%q should be valid: %v", p, err)
		}
	}
	for _, p := range bad {
		if err := ValidatePrefix(p); err == nil {
			t.Errorf("%q should be rejected", p)
		}
	}
	if err := ValidatePrefix(strings.Repeat("a", 129) + "/"); err == nil {
		t.Error("a 129-character segment should be rejected")
	}
	// And the resolver refuses a bad prefix in the program's output.
	f := newFake(t)
	f.output(strings.Replace(goodOutput, "users/AbC123/", "users/x", 1))
	if _, err := f.resolver(nil).Current(); err == nil || !strings.Contains(err.Error(), "account root") {
		t.Fatalf("%v", err)
	}
}

func TestProcessOutputIsValidated(t *testing.T) {
	cases := []struct {
		name, output, want string
		extraEnv           map[string]string
	}{
		{"version", strings.Replace(goodOutput, `"Version":1`, `"Version":2`, 1), "Version", nil},
		{"no version", strings.Replace(goodOutput, `"Version":1,`, ``, 1), "Version", nil},
		{"no secret", strings.Replace(goodOutput, `"SecretAccessKey":"very-secret-value",`, ``, 1), "required", nil},
		{"bad bucket", strings.Replace(goodOutput, `"folder-sync"`, `"X"`, 1), "bucket name", nil},
		{"bad expiration", strings.Replace(goodOutput, `2026-10-25T12:15:00Z`, `tomorrow`, 1), "Expiration", nil},
		{"no endpoint anywhere", strings.Replace(goodOutput, `"Endpoint":"https://acct.r2.cloudflarestorage.com",`, ``, 1), "Endpoint", nil},
		{"not json", "AccessKeyId very-secret-value", "not one JSON object", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFake(t)
			f.output(tc.output)
			_, err := f.resolver(tc.extraEnv).Current()
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want an error mentioning %q, got %v", tc.want, err)
			}
			if strings.Contains(err.Error(), "very-secret-value") {
				t.Fatalf("the error echoes the secret: %v", err)
			}
		})
	}
	// The endpoint may come from the environment instead.
	f := newFake(t)
	f.output(strings.Replace(goodOutput, `"Endpoint":"https://acct.r2.cloudflarestorage.com",`, ``, 1))
	if c, err := f.resolver(map[string]string{EnvAccountID: "abc123"}).Current(); err != nil || c.Endpoint != "https://abc123.r2.cloudflarestorage.com" {
		t.Fatalf("%+v %v", c, err)
	}
}

func TestProcessOutputOverTheCapIsRefused(t *testing.T) {
	f := newFake(t)
	f.mode("big")
	if _, err := f.resolver(nil).Current(); err == nil || !strings.Contains(err.Error(), "64 KiB") {
		t.Fatalf("%v", err)
	}
}

func TestProcessAndStaticKeyTogetherIsAnError(t *testing.T) {
	f := newFake(t)
	for _, extra := range []map[string]string{{EnvAccessKeyID: "AKID"}, {EnvSecretAccessKey: "s"}} {
		if _, err := f.resolver(extra).Current(); err == nil || !strings.Contains(err.Error(), "not both") {
			t.Fatalf("%v", err)
		}
	}
	if f.runs() != 0 {
		t.Fatal("the program must not run when the configuration is contradictory")
	}
}

func TestProcessArgvMustBeAnAbsoluteJSONArray(t *testing.T) {
	f := newFake(t)
	for _, raw := range []string{`vt sync credentials`, `[]`, `["vt","sync"]`, `[""]`, `{"a":1}`} {
		if _, err := f.resolver(map[string]string{EnvCredentialProcess: raw}).Current(); err == nil || !strings.Contains(err.Error(), EnvCredentialProcess) {
			t.Errorf("%s: %v", raw, err)
		}
	}
}

func TestWithoutAProcessTheStaticKeyStillLoads(t *testing.T) {
	f := newFake(t)
	r := NewResolver(filepath.Join(f.dir, "credentials.json"), f.session(), env(map[string]string{
		EnvAccessKeyID: "envKEY5678", EnvSecretAccessKey: "env-secret", EnvAccountID: "abc123"}))
	c, err := r.Current()
	if err != nil || c.Source != "env" || c.Prefix != "" || c.SessionToken != "" {
		t.Fatalf("%+v %v", c, err)
	}
	if f.runs() != 0 {
		t.Fatal("no process is configured")
	}
}

func TestSessionTokenNeverShows(t *testing.T) {
	c := Creds{AccessKeyID: "AKIDEXAMPLE1234", SecretAccessKey: "very-secret-value", SessionToken: "tok-session-abcdef",
		Endpoint: "https://x", Provider: "Cloudflare", Prefix: "users/AbC123/", Source: "process"}
	if r := c.Redacted(); strings.Contains(r, "tok-session") || strings.Contains(r, "very-secret") || strings.Contains(r, "AKIDEXAMPLE") {
		t.Fatal(r)
	}
	if s := c.Scrub("rclone said tok-session-abcdef and very-secret-value for AKIDEXAMPLE1234"); strings.Contains(s, "tok-session") || strings.Contains(s, "very-secret") || strings.Contains(s, "AKIDEXAMPLE") {
		t.Fatal(s)
	}
}

// Review r2 #7: over its quota, an account's keys are read-only, and the process says so (ReadOnly, Reason); the
// cached copy says so too, so a round from the cache still holds its uploads.
func TestProcessReadOnlyKeysSaySoAndWhy(t *testing.T) {
	f := newFake(t)
	f.output(strings.Replace(goodOutput, `"Version":1,`, `"Version":1,"ReadOnly":true,"Reason":"this account holds 2 GiB of its 1 GiB",`, 1))
	r := f.resolver(nil)
	c, err := r.Current()
	if err != nil {
		t.Fatal(err)
	}
	if !c.ReadOnly || c.Reason != "this account holds 2 GiB of its 1 GiB" {
		t.Fatalf("read-only keys: %+v", c)
	}
	f.now = clockStart.Add(time.Minute)
	if again, err := r.Current(); err != nil || f.runs() != 1 || !again.ReadOnly || again.Reason != c.Reason {
		t.Fatalf("from the cache: %+v runs=%d %v", again, f.runs(), err)
	}
	f.output(goodOutput)
	f.now = clockStart.Add(14 * time.Minute) // refresh due
	if back, err := r.Current(); err != nil || back.ReadOnly || back.Reason != "" {
		t.Fatalf("back under the quota: %+v %v", back, err)
	}
}
