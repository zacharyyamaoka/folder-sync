package main

// The engine side of the desktop app (docs/peps/0006): the session from an account process instead of account.json,
// `login --json --print-token`, and `sync --events`' error kinds.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"folder-sync/internal/account"
	"folder-sync/internal/creds"
)

// accountProcess writes a program that prints the given sign-in (or exits with code) and names it in the environment.
func accountProcess(t *testing.T, server string, exitCode int) {
	t.Helper()
	dir := t.TempDir()
	doc, _ := json.Marshal(account.Account{Schema: account.Schema, Server: server, Token: "tok-machine",
		User: account.User{ID: "ownerABC123", Email: "owner@example.com"}})
	script := filepath.Join(dir, "account-process")
	body := fmt.Sprintf("#!/bin/sh\nprintf '%%s' '%s'\n", doc)
	if exitCode != 0 {
		body = fmt.Sprintf("#!/bin/sh\necho 'not signed in' >&2\nexit %d\n", exitCode)
	}
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	argv, _ := json.Marshal([]string{script})
	t.Setenv(account.EnvAccountProcess, string(argv))
}

func TestAccountProcessStandsInForAccountJSON(t *testing.T) {
	l, _ := sandbox(t)
	fake := &accountsServer{}
	srv := fake.start(t)
	accountProcess(t, srv.URL, 0)

	code, out, errOut := runCmd("whoami")
	if code != 0 || !strings.Contains(out, "owner@example.com") {
		t.Fatalf("whoami through the account process: %d %q %q", code, out, errOut)
	}
	code, out, errOut = runCmd("credentials")
	if code != 0 || !strings.Contains(out, `"AccessKeyId":"parent-id"`) {
		t.Fatalf("credentials through the account process: %d %q %q", code, out, errOut)
	}
	if _, err := os.Stat(l.Account); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("account.json must never be written: %v", err)
	}
	// folder-sync is its own credential process once the account process says it is signed in
	env := credentialEnv(l, os.Getenv, func() (string, error) { return "/opt/folder-sync", nil })
	var argv []string
	json.Unmarshal([]byte(env(creds.EnvCredentialProcess)), &argv)
	if len(argv) != 4 || argv[1] != "credentials" || argv[3] != "ownerABC123@"+srv.URL {
		t.Fatalf("credential process argv %q", argv)
	}
	// and logout ends the session on the server through it
	if code, _, errOut := runCmd("logout"); code != 0 || fake.signedOf != "Bearer tok-machine" {
		t.Fatalf("logout: %d %q signed out %q", code, errOut, fake.signedOf)
	}
}

func TestAccountProcessExit3IsSignedOut(t *testing.T) {
	l, _ := sandbox(t)
	accountProcess(t, "http://127.0.0.1:1", 3)
	if code, _, errOut := runCmd("credentials"); code != creds.ExitSignedOut {
		t.Fatalf("credentials: %d %q, want %d", code, errOut, creds.ExitSignedOut)
	}
	if code, _, _ := runCmd("whoami"); code != 3 {
		t.Fatalf("whoami: %d, want 3", code)
	}
	if _, err := account.Current(l.Account, os.Getenv); !errors.Is(err, account.ErrNotSignedIn) {
		t.Fatalf("Current: %v", err)
	}
}

func TestAccountProcessNeverEchoesItsOutput(t *testing.T) {
	l, _ := sandbox(t)
	dir := t.TempDir()
	script := filepath.Join(dir, "bad")
	os.WriteFile(script, []byte("#!/bin/sh\necho 'tok-secret not json'\n"), 0o700)
	argv, _ := json.Marshal([]string{script})
	t.Setenv(account.EnvAccountProcess, string(argv))
	_, err := account.Current(l.Account, os.Getenv)
	if err == nil || strings.Contains(err.Error(), "tok-secret") {
		t.Fatalf("garbage must fail without echoing stdout: %v", err)
	}
	t.Setenv(account.EnvAccountProcess, `["relative/path"]`)
	if _, err := account.Current(l.Account, os.Getenv); err == nil || !strings.Contains(err.Error(), "absolute") {
		t.Fatalf("relative argv[0]: %v", err)
	}
}

func TestLoginJSONPrintTokenWritesNoAccountJSON(t *testing.T) {
	l, _ := sandbox(t)
	fake := &accountsServer{}
	srv := fake.start(t)
	os.WriteFile(l.Session, []byte(`{"schema":"folder-sync-session/1"}`), 0o600)
	code, out, errOut := runCmd("login", "--server", srv.URL, "--json", "--print-token")
	if code != 0 {
		t.Fatalf("code %d %q", code, errOut)
	}
	var events []loginEvent
	scanner := bufio.NewScanner(strings.NewReader(out))
	for scanner.Scan() {
		var ev loginEvent
		if err := json.Unmarshal(scanner.Bytes(), &ev); err != nil {
			t.Fatalf("not a JSON line: %q", scanner.Text())
		}
		if ev.Schema != LoginSchema {
			t.Fatalf("schema %q", ev.Schema)
		}
		events = append(events, ev)
	}
	if len(events) != 2 || events[0].Event != "device" || events[0].Link != srv.URL+"/fs/device?user_code=WXYZ2345" || events[0].Code != "WXYZ-2345" {
		t.Fatalf("device event: %+v", events)
	}
	last := events[1]
	if last.Event != "signed_in" || last.Account == nil || last.Account.Token != "tok-machine" || last.Account.Schema != account.Schema || last.Root != "users/ownerABC123/" {
		t.Fatalf("signed_in event: %+v", last)
	}
	if _, err := os.Stat(l.Account); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("--print-token wrote account.json: %v", err)
	}
	if _, err := os.Stat(l.Session); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the previous sign-in's cached keys survived")
	}
}

func TestLoginPrintTokenNeedsJSONAndJSONSavesWithoutToken(t *testing.T) {
	l, _ := sandbox(t)
	fake := &accountsServer{}
	srv := fake.start(t)
	if code, _, errOut := runCmd("login", "--server", srv.URL, "--print-token"); code == 0 || !strings.Contains(errOut, "--json") {
		t.Fatalf("--print-token alone: %d %q", code, errOut)
	}
	code, out, _ := runCmd("login", "--server", srv.URL, "--json")
	if code != 0 || strings.Contains(out, "tok-machine") {
		t.Fatalf("--json without --print-token must not print the token: %d %q", code, out)
	}
	if _, err := account.Load(l.Account); err != nil {
		t.Fatalf("--json alone saves account.json: %v", err)
	}
}

func TestLoginJSONReportsAnError(t *testing.T) {
	sandbox(t)
	code, out, _ := runCmd("login", "--server", "http://127.0.0.1:1", "--json")
	if code == 0 || !strings.Contains(out, `"event":"error"`) {
		t.Fatalf("an unreachable server: %d %q", code, out)
	}
}

func TestCredentialsNamesOverQuota(t *testing.T) {
	sandbox(t)
	why := "this account holds 1073741900 bytes (1.00 GiB) of its 1073741824 (1.00 GiB): delete files, or ask the operator for more"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(403)
		fmt.Fprintf(w, `{"error":"over_quota","why":%q}`, why)
	}))
	t.Cleanup(srv.Close)
	accountProcess(t, srv.URL, 0)
	code, _, errOut := runCmd("credentials")
	if code != 1 || !strings.Contains(errOut, account.OverQuotaPrefix+why) {
		t.Fatalf("credentials over quota: %d %q", code, errOut)
	}
	// the round's error carries that stderr line (internal/creds); classify reads it back
	kind, got := classify(fmt.Errorf("credential process failed: %s", strings.TrimSpace(errOut)))
	if kind != KindOverQuota || got != why {
		t.Fatalf("classify: %q %q", kind, got)
	}
}

func TestClassifyRoundErrors(t *testing.T) {
	for _, c := range []struct {
		err  error
		kind string
	}{
		{&creds.SignedOutError{Message: "signed out"}, KindSignedOut},
		{account.ErrNotSignedIn, KindSignedOut},
		{&account.OverQuotaError{Why: "full"}, KindOverQuota},
		{errors.New("credential process failed: folder-sync credentials: http://127.0.0.1:4933 did not answer (dial tcp 127.0.0.1:4933: connect: connection refused)"), KindOffline},
		{errors.New("rclone: Get \"http://127.0.0.1:4930/\": dial tcp: lookup r2.example: no such host"), KindOffline},
		{errors.New("manifest seq went backwards"), KindError},
	} {
		if kind, _ := classify(c.err); kind != c.kind {
			t.Errorf("classify(%v) = %q, want %q", c.err, kind, c.kind)
		}
	}
}

func TestEventWriterLinesAreJSON(t *testing.T) {
	var buf bytes.Buffer
	w := &eventWriter{out: &buf, now: func() time.Time { return time.Date(2026, 10, 27, 1, 2, 3, 0, time.UTC) }}
	w.emit(syncEvent{Event: "round", OK: boolPtr(true), Uploaded: 2})
	w.emit(syncEvent{Event: "round", OK: boolPtr(false), Kind: KindOffline, Why: "x"})
	var nilWriter *eventWriter
	nilWriter.emit(syncEvent{Event: "dropped"}) // a nil writer is silent
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("lines %q", lines)
	}
	var first map[string]any
	json.Unmarshal([]byte(lines[0]), &first)
	if first["schema"] != EventSchema || first["ok"] != true || first["uploaded"] != float64(2) || first["at"] != "2026-10-27T01:02:03Z" {
		t.Fatalf("first %v", first)
	}
	if !strings.Contains(lines[1], `"ok":false`) || !strings.Contains(lines[1], `"kind":"offline"`) {
		t.Fatalf("second %q", lines[1])
	}
	_ = io.Discard
}

func TestSyncEventsNeedsWatch(t *testing.T) {
	sandbox(t)
	if code, _, errOut := runCmd("sync", "--events"); code == 0 || !strings.Contains(errOut, "--watch") {
		t.Fatalf("--events without --watch: %d %q", code, errOut)
	}
}

func TestAFailedRoundAgainstADownServerIsOffline(t *testing.T) {
	// a port nothing listens on: bind one, note it, close it
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	down := "http://" + l.Addr().String()
	l.Close()
	up := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	t.Cleanup(up.Close)
	rcloneSaid := errors.New(`push: rclone copy failed: exit status 1: CRITICAL: Failed to create file system for "fsremote:x": is a file not a directory`)
	if kind, why := classifyRound(rcloneSaid, down, up.URL); kind != KindOffline || !strings.Contains(why, "does not answer") {
		t.Fatalf("storage down: %q %q", kind, why)
	}
	if kind, _ := classifyRound(rcloneSaid, up.URL, ""); kind != KindError {
		t.Fatalf("everything answers: the error stays an error, got %q", kind)
	}
	if kind, _ := classifyRound(&account.OverQuotaError{Why: "full"}, down); kind != KindOverQuota {
		t.Fatalf("a known kind is not re-sorted by the probe: %q", kind)
	}
}

