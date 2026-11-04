package e2e

// Gate G7, "storage provider swappable" (docs/STORAGE.md): the same sync journey (add, edit, rename, delete, history
// restore, on two machines) against three stores: the R2 stand-in (rclone serve s3, today's default), a MinIO server as
// "another S3 store", and a file:// directory. The journey is one function; only the store URL, the keys in the
// machines' environment and the way the test reads the bucket back differ.
//
// MinIO is the pinned build scripts/fetch-minio puts in .tools/. A real AWS S3, Google Cloud Storage or Backblaze B2 run
// is optional: set FOLDER_SYNC_E2E_S3_URL (and the keys in AWS_* or FOLDER_SYNC_*) and it runs the same journey.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"folder-sync/internal/s3"
	"folder-sync/internal/store"
	"folder-sync/internal/testtools"
)

// journeyStore is one store the journey runs against.
type journeyStore struct {
	name    string
	url     string        // what `init --store` is given
	env     []string      // what each machine's environment carries (keys, endpoint)
	objects store.Objects // how the test reads the bucket back, outside folder-sync
	bucket  string        // the bucket argument of objects
	root    string        // the prefix every key starts with ("" or "team/")
}

func TestStorageJourneyR2StandIn(t *testing.T) {
	rcloneBin := testtools.PinnedRclone(t, repo)
	work := t.TempDir()
	keyID, secret := "e2e"+randomHex(8), randomHex(20)
	data := filepath.Join(work, "s3")
	os.MkdirAll(filepath.Join(data, bucket), 0o755)
	startStandIn(t, rcloneBin, data, keyID, secret)
	endpoint := "http://" + standInAddr
	runJourney(t, rcloneBin, journeyStore{
		name: "r2-stand-in", url: "r2://" + bucket,
		env:     []string{"FOLDER_SYNC_ACCESS_KEY_ID=" + keyID, "FOLDER_SYNC_SECRET_ACCESS_KEY=" + secret, "FOLDER_SYNC_ENDPOINT=" + endpoint},
		objects: &s3.Client{Endpoint: endpoint, Region: "auto", AccessKeyID: keyID, SecretAccessKey: secret},
		bucket:  bucket,
	})
}

func TestStorageJourneyMinIO(t *testing.T) {
	rcloneBin := testtools.PinnedRclone(t, repo)
	endpoint, user, password := startMinIO(t)
	makeBucket(t, endpoint, user, password, bucket)
	runJourney(t, rcloneBin, journeyStore{
		name: "minio", url: "s3://" + bucket + "/team?endpoint=" + endpoint + "&provider=Minio",
		env:     []string{"FOLDER_SYNC_ACCESS_KEY_ID=" + user, "FOLDER_SYNC_SECRET_ACCESS_KEY=" + password},
		objects: &s3.Client{Endpoint: endpoint, Region: "us-east-1", AccessKeyID: user, SecretAccessKey: password},
		bucket:  bucket, root: "team/",
	})
}

// The same journey with the four conditional calls declared unsupported, so folder-sync checks each one itself (a HEAD,
// then the call without the header): the path a store that ignores If-None-Match would take, proved on a real server.
func TestStorageJourneyMinIOWithTheFallbacks(t *testing.T) {
	rcloneBin := testtools.PinnedRclone(t, repo)
	endpoint, user, password := startMinIO(t)
	makeBucket(t, endpoint, user, password, bucket)
	runJourney(t, rcloneBin, journeyStore{
		name: "minio-fallbacks", url: "s3://" + bucket + "?endpoint=" + endpoint + "&provider=Minio",
		env:     []string{"FOLDER_SYNC_ACCESS_KEY_ID=" + user, "FOLDER_SYNC_SECRET_ACCESS_KEY=" + password, "FOLDER_SYNC_STORE_CAPS=none"},
		objects: &s3.Client{Endpoint: endpoint, Region: "us-east-1", AccessKeyID: user, SecretAccessKey: password},
		bucket:  bucket,
	})
}

// startMinIO runs the pinned MinIO (scripts/fetch-minio) on a free port over a temp dir and stops it, by pid, when the
// test ends. It answers the endpoint and the root keys.
func startMinIO(t *testing.T) (endpoint, user, password string) {
	t.Helper()
	minio := filepath.Join(repo, ".tools", testtools.Exe("minio"))
	if _, err := os.Stat(minio); err != nil {
		// WHY its own switch and not FOLDER_SYNC_E2E_REQUIRE: MinIO is built from source (a few minutes) by scripts/fetch-minio,
		// which the G7 gate runs and then sets FOLDER_SYNC_E2E_MINIO=1 so a missing build there is a failure; the CI jobs
		// that do not fetch it skip these journeys instead of failing on a tool they were never asked to build.
		if v := os.Getenv("FOLDER_SYNC_E2E_MINIO"); v != "" && v != "0" {
			t.Fatalf("FOLDER_SYNC_E2E_MINIO is set, so a missing MinIO fails instead of skipping: run scripts/fetch-minio (no %s)", minio)
		}
		t.Skipf("no %s: run scripts/fetch-minio to run the MinIO journeys", filepath.Join(".tools", testtools.Exe("minio")))
	}
	user, password = "fsminio"+randomHex(4), randomHex(16)
	api, console := freeAddr(t), freeAddr(t)
	work := t.TempDir()
	cmd := exec.Command(minio, "server", filepath.Join(work, "data"), "--address", api, "--console-address", console, "--quiet")
	cmd.Env = append(baseEnv(), "MINIO_ROOT_USER="+user, "MINIO_ROOT_PASSWORD="+password, "MINIO_BROWSER=off", "MINIO_UPDATE=off")
	logFile, _ := os.Create(filepath.Join(work, "minio.log"))
	cmd.Stdout, cmd.Stderr = logFile, logFile
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Logf("another S3 store: minio on %s, pid %d", api, cmd.Process.Pid)
	t.Cleanup(func() {
		testtools.Terminate(cmd.Process)
		done := make(chan struct{})
		go func() { cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			cmd.Process.Kill()
		}
		logFile.Close()
	})
	waitHTTP(t, "http://"+api+"/minio/health/ready", 30*time.Second, func() string { data, _ := os.ReadFile(logFile.Name()); return string(data) })
	return "http://" + api, user, password
}

func TestStorageJourneyFileDirectory(t *testing.T) {
	rcloneBin := testtools.PinnedRclone(t, repo)
	hub := filepath.Join(t.TempDir(), "hub")
	os.MkdirAll(hub, 0o755)
	runJourney(t, rcloneBin, journeyStore{
		name: "file", url: "file://" + filepath.ToSlash(hub),
		objects: &store.FileStore{Root: hub},
		bucket:  hub,
	})
}

// An optional run against a real store: FOLDER_SYNC_E2E_S3_URL is a store URL (s3://my-test-bucket/ci-<random>, gs://…,
// or a B2 s3:// with its endpoint) and the keys come from the AWS_* variables or FOLDER_SYNC_*. It skips without them.
func TestStorageJourneyRealProvider(t *testing.T) {
	raw := os.Getenv("FOLDER_SYNC_E2E_S3_URL")
	if raw == "" {
		t.Skip("set FOLDER_SYNC_E2E_S3_URL (and the provider's keys) to run the journey against a real AWS S3, GCS or B2 bucket")
	}
	rcloneBin := testtools.PinnedRclone(t, repo)
	spec, err := store.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	// a fresh folder inside the test prefix, so a run never meets another's files
	spec.Prefix += "e2e-" + randomHex(4) + "/"
	var env []string
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "AWS_") || strings.HasPrefix(kv, "FOLDER_SYNC_ACCESS") || strings.HasPrefix(kv, "FOLDER_SYNC_SECRET") || strings.HasPrefix(kv, "FOLDER_SYNC_ENDPOINT") {
			env = append(env, kv)
		}
	}
	id, secret := os.Getenv("AWS_ACCESS_KEY_ID"), os.Getenv("AWS_SECRET_ACCESS_KEY")
	if id == "" {
		id, secret = os.Getenv("FOLDER_SYNC_ACCESS_KEY_ID"), os.Getenv("FOLDER_SYNC_SECRET_ACCESS_KEY")
	}
	endpoint := firstOf(os.Getenv("FOLDER_SYNC_ENDPOINT"), spec.EndpointOrDefault())
	runJourney(t, rcloneBin, journeyStore{
		name: "real-" + string(spec.Kind), url: spec.String(), env: env,
		objects: &s3.Client{Endpoint: endpoint, Region: spec.RegionOrDefault(), AccessKeyID: id, SecretAccessKey: secret, SessionToken: os.Getenv("AWS_SESSION_TOKEN")},
		bucket:  spec.Bucket, root: spec.Prefix,
	})
}

func firstOf(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// freeAddr is a 127.0.0.1 address nobody holds right now.
func freeAddr(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().String()
}

func waitHTTP(t *testing.T, url string, within time.Duration, log func() string) {
	t.Helper()
	for deadline := time.Now().Add(within); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
		if resp, err := http.Get(url); err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
	}
	t.Fatalf("%s did not answer within %s:\n%s", url, within, log())
}

// makeBucket creates a bucket with a signed PUT (the engine never does: a store's bucket is its owner's).
func makeBucket(t *testing.T, endpoint, key, secret, name string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPut, endpoint+"/"+name, nil)
	s3.Sign(req, key, secret, "us-east-1", time.Now(), s3.EmptySHA256)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create bucket %s: %s", name, resp.Status)
	}
}

var versionID = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z_([0-9a-f]{16}|unlisted)`)

// keptVersions lists a path's kept versions: version id -> the object names holding it.
func (s journeyStore) keptVersions(t *testing.T, host, path string) map[string][]string {
	t.Helper()
	prefix := s.root + "_history/" + project + "/" + host + "/" + path + "/"
	listed, err := s.objects.List(s.bucket, prefix, "/")
	if err != nil {
		t.Fatalf("list %s: %v", prefix, err)
	}
	out := map[string][]string{}
	for _, obj := range listed.Objects {
		name := strings.TrimPrefix(obj.Key, prefix)
		if id := versionID.FindString(name); id != "" {
			out[id] = append(out[id], name)
		}
	}
	return out
}

// versionOf is the id of the kept version whose bytes were content (a version's name ends in the first 16 hex of its sha256).
func (s journeyStore) versionOf(t *testing.T, host, path, content string) string {
	t.Helper()
	sum := sha256.Sum256([]byte(content))
	want := "_" + hex.EncodeToString(sum[:])[:16]
	var ids []string
	for id := range s.keptVersions(t, host, path) {
		if strings.HasSuffix(id, want) {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	if len(ids) == 0 {
		t.Fatalf("%s keeps no version of %s with %q; it keeps %v", s.name, path, content, s.keptVersions(t, host, path))
	}
	return ids[len(ids)-1]
}

// live reads a machine's live file back out of the store.
func (s journeyStore) live(t *testing.T, host, path string) (string, bool) {
	t.Helper()
	got, err := s.objects.GetIfNoneMatch(s.bucket, s.root+project+"/hosts/"+host+"/"+path, "")
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(got.Body), !got.NotFound
}

func runJourney(t *testing.T, rcloneBin string, s journeyStore) {
	work := t.TempDir()
	bin := filepath.Join(work, testtools.Exe("folder-sync"))
	goBuild(t, bin, "./cmd/folder-sync")
	w := &world{t: t, bin: bin, rclone: rcloneBin, ops: &opLog{}}
	newMachine := func(name string) *machine {
		m := w.newMachine(name, false)
		m.env = append(m.env, s.env...)
		return m
	}
	a, b := newMachine("A"), newMachine("B")
	var steps []map[string]any
	step := func(m *machine, what string, args ...string) string {
		t.Helper()
		started := time.Now()
		out := w.must(m, args...)
		steps = append(steps, map[string]any{"step": what, "machine": m.name, "command": "folder-sync " + strings.Join(args, " "), "ms": time.Since(started).Milliseconds(), "output": out})
		return out
	}
	defer func() {
		dir := os.Getenv("FOLDER_SYNC_E2E_ARTIFACTS")
		if dir == "" {
			return
		}
		os.MkdirAll(dir, 0o755)
		doc, _ := json.MarshalIndent(map[string]any{"store": s.name, "url": s.url, "steps": steps}, "", "  ")
		os.WriteFile(filepath.Join(dir, "storage-journey-"+s.name+".json"), doc, 0o644)
	}()

	// init: the store URL is the only thing that differs between providers
	out := step(a, "init", "init", "--project", project, "--store", s.url)
	step(b, "init", "init", "--project", project, "--store", s.url)
	// R2 is trusted as before and says nothing about its store; every other store says what it is
	if (s.name != "r2-stand-in" && !strings.Contains(out, "store:")) || strings.Contains(out, "secret") {
		t.Fatalf("init output:\n%s", out)
	}
	if strings.HasPrefix(s.name, "minio") || strings.HasPrefix(s.name, "real-") {
		// an S3-compatible store is measured at init (the four conditional calls); what it found is evidence, and the
		// journey below must pass whichever way it came out
		t.Logf("%s: %s", s.name, strings.TrimSpace(out[strings.Index(out, "store:"):]))
	}
	idA := hostID(t, a)

	plan := filepath.Join(a.folder, "notes", "plan.md")
	other := filepath.Join(a.folder, "docs", "a.txt")
	peerCopy := func(m *machine, path string) string {
		data, err := os.ReadFile(filepath.Join(m.folder, "hosts", idA, filepath.FromSlash(path)))
		if err != nil {
			return "<absent>"
		}
		return string(data)
	}

	// add
	writeFile(t, plan, "plan v1\n", time.Time{})
	writeFile(t, other, "other\n", time.Time{})
	step(a, "add: A syncs", "sync", "--once")
	step(b, "add: B syncs", "sync", "--once")
	if got := peerCopy(b, "notes/plan.md"); got != "plan v1\n" {
		t.Fatalf("add: B has %q", got)
	}
	if live, ok := s.live(t, idA, "notes/plan.md"); !ok || live != "plan v1\n" {
		t.Fatalf("add: the store holds %q (found %v)", live, ok)
	}

	// edit: the old version is kept, the peer follows
	writeFile(t, plan, "plan v2\n", time.Time{})
	step(a, "edit: A syncs", "sync", "--once")
	step(b, "edit: B syncs", "sync", "--once")
	if got := peerCopy(b, "notes/plan.md"); got != "plan v2\n" {
		t.Fatalf("edit: B has %q", got)
	}
	v1 := s.versionOf(t, idA, "notes/plan.md", "plan v1\n")

	// rename: a new name and a gone one, on both machines
	if err := os.Rename(other, filepath.Join(a.folder, "docs", "b.txt")); err != nil {
		t.Fatal(err)
	}
	step(a, "rename: A syncs", "sync", "--once")
	step(b, "rename: B syncs", "sync", "--once")
	if got := peerCopy(b, "docs/b.txt"); got != "other\n" {
		t.Fatalf("rename: B has docs/b.txt = %q", got)
	}
	if got := peerCopy(b, "docs/a.txt"); got != "<absent>" {
		t.Fatalf("rename: B still has docs/a.txt = %q", got)
	}
	if _, ok := s.live(t, idA, "docs/a.txt"); ok {
		t.Fatal("rename: the old name is still in the store")
	}
	s.versionOf(t, idA, "docs/a.txt", "other\n") // and its bytes are kept

	// delete: gone from the peer, restorable on the owner
	os.Remove(plan)
	step(a, "delete: A syncs", "sync", "--once")
	step(b, "delete: B syncs", "sync", "--once")
	if got := peerCopy(b, "notes/plan.md"); got != "<absent>" {
		t.Fatalf("delete: B still has %q", got)
	}
	if _, ok := s.live(t, idA, "notes/plan.md"); ok {
		t.Fatal("delete: the file is still live in the store")
	}
	if out := step(a, "deleted: A lists", "deleted"); !strings.Contains(out, "notes/plan.md") {
		t.Fatalf("deleted lists:\n%s", out)
	}
	step(a, "deleted --restore", "deleted", "--restore", "notes/")
	if data, _ := os.ReadFile(plan); string(data) != "plan v2\n" {
		t.Fatalf("deleted --restore: %q", data)
	}

	// history restore: an old version comes back byte for byte, and the peer follows it
	step(a, "restore v1", "restore", "notes/plan.md", "--version", v1)
	if data, _ := os.ReadFile(plan); string(data) != "plan v1\n" {
		t.Fatalf("restore --version %s: %q", v1, data)
	}
	step(a, "restore: A syncs", "sync", "--once")
	step(b, "restore: B syncs", "sync", "--once")
	if got := peerCopy(b, "notes/plan.md"); got != "plan v1\n" {
		t.Fatalf("restore: B has %q", got)
	}
	if out := step(a, "history", "history", "notes/plan.md"); !strings.Contains(out, v1) {
		t.Fatalf("history lacks %s:\n%s", v1, out)
	}

	// the store holds folder-sync's layout and nothing of its machinery
	listed, err := s.objects.List(s.bucket, s.root, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, obj := range listed.Objects {
		if strings.Contains(obj.Key, ".folder-sync-tmp") || strings.Contains(obj.Key, "_probe/") || strings.HasSuffix(obj.Key, ".partial") {
			t.Errorf("a stray object in the store: %s", obj.Key)
		}
	}
	if len(listed.Objects) == 0 {
		t.Fatal("the store is empty after the journey")
	}
	t.Logf("%s: the journey passed (%d objects in the store)", s.name, len(listed.Objects))
}
