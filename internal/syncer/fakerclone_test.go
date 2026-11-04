package syncer

// A stand-in for the rclone binary, for the tests that run whole rounds against memStore: the test binary runs itself
// as rclone (TestMain) and does the three things a push asks of it. WHY not the real rclone: a workload of thousands
// of rounds would spend its time starting processes; the real rclone's side of a push is the e2e suite's
// (e2e/history_test.go). What this one does differently is stated, not hidden: it uploads a file's bytes as they are
// when `copy` runs, which is what rclone does (it reads the file again after the engine hashed it).

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"folder-sync/internal/config"
	"folder-sync/internal/creds"
	"folder-sync/internal/host"
	"folder-sync/internal/rclone"
	"folder-sync/internal/s3"
)

const fakeRcloneEnv = "FOLDER_SYNC_FAKE_RCLONE"

// fakeRcloneArgsEnv names a file the fake appends each call's arguments to.
const fakeRcloneArgsEnv = "FOLDER_SYNC_FAKE_RCLONE_ARGS"

func TestMain(m *testing.M) {
	if os.Getenv(fakeRcloneEnv) != "" {
		if err := runFakeRclone(os.Args[1:], os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "fake rclone:", err)
			os.Exit(1)
		}
		return
	}
	os.Exit(m.Run())
}

// valueFlags are the flags a push passes with a value; every other --flag is a switch.
var valueFlags = map[string]bool{"--config": true, "--cache-dir": true, "--temp-dir": true, "--log-level": true,
	"--filter-from": true, "--files-from-raw": true, "--max-delete": true, "--retries": true, "--low-level-retries": true, "--contimeout": true}

func runFakeRclone(args []string, stdout io.Writer) error {
	command := args[0]
	// a test that wants to see the command line rclone was given names a file; one line per call
	if path := os.Getenv(fakeRcloneArgsEnv); path != "" {
		if f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
			fmt.Fprintln(f, strings.Join(args, " "))
			f.Close()
		}
	}
	flags := map[string]string{}
	var positional []string
	for i := 1; i < len(args); i++ {
		switch {
		case valueFlags[args[i]]:
			flags[args[i]] = args[i+1]
			i++
		case strings.HasPrefix(args[i], "-"):
		default:
			positional = append(positional, args[i])
		}
	}
	client := &s3.Client{Endpoint: os.Getenv("RCLONE_CONFIG_FSREMOTE_ENDPOINT"), Region: "auto",
		AccessKeyID: os.Getenv("RCLONE_CONFIG_FSREMOTE_ACCESS_KEY_ID"), SecretAccessKey: os.Getenv("RCLONE_CONFIG_FSREMOTE_SECRET_ACCESS_KEY")}
	put := func(remote, local string) error {
		bucket, key, _ := strings.Cut(strings.TrimPrefix(remote, rclone.Remote+":"), "/")
		data, err := os.ReadFile(local)
		if err != nil {
			return err
		}
		_, err = client.Put(bucket, key, data, "", "", "")
		return err
	}
	switch command {
	case "lsjson":
		folder := positional[len(positional)-1]
		items := []lsjsonItem{}
		filepath.WalkDir(folder, func(path string, d os.DirEntry, err error) error {
			rel, _ := filepath.Rel(folder, path)
			rel = filepath.ToSlash(rel)
			if err != nil || d.IsDir() || rel == config.FileName || strings.HasPrefix(rel, "hosts/") || strings.HasPrefix(filepath.Base(rel), restoreTempPrefix) {
				return nil
			}
			info, _ := d.Info()
			items = append(items, lsjsonItem{Path: rel, Size: info.Size(), ModTime: info.ModTime().UTC().Format(time.RFC3339Nano)})
			return nil
		})
		sort.Slice(items, func(i, j int) bool { return items[i].Path < items[j].Path })
		return json.NewEncoder(stdout).Encode(items)
	case "copy":
		// a pull (the remote is the source): the fake lands no files; the e2e suite's pulls do (names_test.go)
		if strings.HasPrefix(positional[0], rclone.Remote+":") {
			return nil
		}
		// a test that rewrites a file between the engine's hash and this upload says so in the environment
		if target := os.Getenv("FAKE_RCLONE_REWRITE_PATH"); target != "" {
			if with, err := os.ReadFile(os.Getenv("FAKE_RCLONE_REWRITE_WITH")); err == nil {
				os.WriteFile(target, with, 0o644)
			}
		}
		list, err := os.ReadFile(flags["--files-from-raw"])
		if err != nil {
			return err
		}
		for _, rel := range strings.Split(strings.TrimSpace(string(list)), "\n") {
			if rel == "" {
				continue
			}
			if err := put(positional[1]+"/"+rel, filepath.Join(positional[0], filepath.FromSlash(rel))); err != nil {
				return err
			}
		}
		return nil
	case "copyto":
		return put(positional[1], positional[0])
	}
	return fmt.Errorf("the fake rclone does not run %q", command)
}

// world is one machine's folder syncing into a memStore on a fake clock.
type world struct {
	t      *testing.T
	p      *Project
	store  *memStore
	folder string
	clock  time.Time
}

const (
	worldRoot    = "users/AbC123/"
	worldProject = "notes"
)

// newWorld opens a Project for a fresh folder. Its clock starts at start and moves only when a test says so.
func newWorld(t *testing.T, start time.Time, edit func(*config.Config)) *world {
	t.Helper()
	w := &world{t: t, clock: start, folder: t.TempDir()}
	store, server := newMemStore(t, "bkt", func() time.Time { return w.clock })
	w.store = store
	cfg := config.New(worldProject, "bkt")
	if edit != nil {
		edit(&cfg)
	}
	l := testLayout(t)
	c := creds.Creds{AccessKeyID: "key", SecretAccessKey: "secret", Endpoint: server.URL, Region: "auto", Provider: "Other", Prefix: worldRoot, Bucket: "bkt"}
	t.Setenv(fakeRcloneEnv, "1")
	w.p = &Project{Folder: w.folder, Config: cfg, Layout: l, Host: host.Host{ID: testHost, Name: "bam-GPU"}, Creds: c, Root: worldRoot,
		Rclone:   rclone.Runner{Bin: os.Args[0], Layout: l, Creds: c},
		S3:       &s3.Client{Endpoint: server.URL, Region: "auto", AccessKeyID: "key", SecretAccessKey: "secret", HTTP: &http.Client{Timeout: time.Minute}},
		StateDir: t.TempDir(), Now: func() time.Time { return w.clock }}
	return w
}

// write puts content at path in the folder, with mtime = the fake clock (so the push sees a change).
func (w *world) write(path string, content []byte) {
	w.t.Helper()
	full := filepath.Join(w.folder, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		w.t.Fatal(err)
	}
	if err := os.WriteFile(full, content, 0o644); err != nil {
		w.t.Fatal(err)
	}
	os.Chtimes(full, w.clock, w.clock)
}

// appendTo adds tail to the end of path.
func (w *world) appendTo(path string, tail []byte) {
	w.t.Helper()
	full := filepath.Join(w.folder, filepath.FromSlash(path))
	f, err := os.OpenFile(full, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		w.t.Fatal(err)
	}
	f.Write(tail)
	f.Close()
	os.Chtimes(full, w.clock, w.clock)
}

func (w *world) read(path string) []byte {
	w.t.Helper()
	data, err := os.ReadFile(filepath.Join(w.folder, filepath.FromSlash(path)))
	if err != nil {
		w.t.Fatal(err)
	}
	return data
}

// push runs one push at the current fake time.
func (w *world) push() Result {
	w.t.Helper()
	var result Result
	if err := w.p.Push(w.t.Context(), Stamp(w.clock), &result); err != nil {
		w.t.Fatalf("push at %s: %v", w.clock.Format(time.RFC3339), err)
	}
	return result
}

// liveKey is a path's object key in the bucket.
func (w *world) liveKey(path string) string { return w.p.HostPrefix(testHost) + "/" + path }

func (w *world) advance(d time.Duration) { w.clock = w.clock.Add(d) }
