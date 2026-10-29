package e2e

// The cross-OS pair (Zach, 2026-10-29: test every place the app touches the OS, on every OS). Hosted runners cannot
// reach each other's 127.0.0.1, so the two halves meet in a file:
//
//	TestCrossOSWrite  (Linux job)         writes an awkward tree with a real folder-sync push into `rclone serve s3`, asserts what
//	                                      the push landed or refused, and saves the bucket as stage1.tar.gz / stage2.tar.gz in
//	                                      $FOLDER_SYNC_XOS_OUT. Names the push refuses are added to the saved bucket by hand, as a
//	                                      peer without the lint would have written them, so the pull side's own defence is tried.
//	TestCrossOSPull   (Windows, macOS)    loads those files into an in-memory stand-in and pulls with folder-sync, asserting per OS
//	                                      that each name lands correctly or is refused with a clear message.
//	TestCrossOSRoundTrip (Linux, local)   both halves in one process, with no artifact: what `go test ./...` runs.
//
// WHY the bucket travels as a tar and is served from memory: a Windows folder cannot hold CON.txt or a:b, so the stand-in's
// storage folder cannot be unpacked there. `rclone serve s3 :memory:` keeps any key.
//
// The rule being tested: a name either lands intact or is refused with a message that says why. A name that does neither is
// a bug; its case id goes in FOLDER_SYNC_QUARANTINE (and knownBugs says what is wrong) until it is fixed. A case id or its group ("junk-files",
// "unicode-normalization") quarantines it; a quarantined case is a t.Skip that starts "QUARANTINED", which the CI summary lists.

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"folder-sync/internal/manifest"
	"folder-sync/internal/s3"
	"folder-sync/internal/testtools"
)

const (
	envXOSOut        = "FOLDER_SYNC_XOS_OUT"
	envXOSIn         = "FOLDER_SYNC_XOS_IN"
	envXOSReport     = "FOLDER_SYNC_XOS_REPORT"
	envQuarantine    = "FOLDER_SYNC_QUARANTINE"
	xosHostsPrefix   = project + "/hosts/"
	xosForgedWritten = "2026-10-01T10:20:30Z"
)

// How a name fares when folder-sync pushes it from Linux.
type pushKind int

const (
	pushLands   pushKind = iota // in the bucket with its content
	pushRefused                 // not in the bucket; status names it with pushWhy
	pushIgnored                 // not in the bucket, and not an error
)

// How a name fares when folder-sync pulls it onto an OS.
type pullKind int

const (
	pullLands         pullKind = iota // on disk with its own content
	pullRefused                       // not on disk; status names it with the case's pullWhy
	pullAbsent                        // never in the bucket, so nowhere on disk
	pullLandsOrRefuse                 // the rule itself: one or the other, never neither and never someone else's content
)

func (k pullKind) String() string {
	return [...]string{"land", "refuse+message", "absent", "land or refuse"}[k]
}

type xosCase struct {
	id      string
	path    string // slash-separated, inside the host's tree
	content string
	mtime   time.Time // zero: now
	push    pushKind
	pushWhy string              // refused: part of the reason status shows
	forge   bool                // the push refuses it, so the saved bucket gets it by hand for the pull side
	pull    map[string]pullKind // by GOOS
	pullWhy string              // refused: part of the reason status shows
}

func everywhere(kind pullKind) map[string]pullKind {
	return map[string]pullKind{"linux": kind, "darwin": kind, "windows": kind}
}

// knownBugs are the cases a run found failing: what is wrong, so FOLDER_SYNC_QUARANTINE=<id> says why it skips.
var knownBugs = map[string]string{
	"junk-files":            "the default ignore list (internal/ignore Defaults) has no .DS_Store, Thumbs.db or desktop.ini, so they upload and sync to every machine",
	"unicode-normalization": "a folder holding café as NFC and as NFD lists both in the manifest, but rclone's copy treats the two names as one and uploads only one (--no-unicode-normalization is off), so the manifest names an object the bucket lacks",
}

var preciseMtime = time.Date(2026, 10, 1, 10, 20, 30, 123456789, time.UTC)

var longDir = strings.Repeat("a-long-directory-name-", 2) + "x" // 45 characters

// xosCases is the tree. WHY these names: each is a place a path meets an OS rule (README.md: docs/peps/0001 "Safety rules"
// and internal/names; the research note "Cross-Platform Testing from Linux" lists them).
var xosCases = func() []xosCase {
	windowsRefuses := map[string]pullKind{"linux": pullLands, "darwin": pullLands, "windows": pullRefused}
	return []xosCase{
		{id: "plain", path: "plain/hello.txt", content: "hello\n", push: pushLands, pull: everywhere(pullLands)},
		// A case-twin pair: Linux can hold both, Windows and macOS cannot, so the push refuses both and neither travels.
		{id: "case-twin-upper", path: "twins/README.md", content: "twin 1\n", push: pushRefused, pushWhy: "case-only twins", pull: everywhere(pullAbsent)},
		{id: "case-twin-lower", path: "twins/readme.md", content: "twin 2\n", push: pushRefused, pushWhy: "case-only twins", pull: everywhere(pullAbsent)},
		// é as one code point (NFC) and as e + combining accent (NFD): two files on Linux, one name to macOS (APFS ignores the
		// difference), two names to Windows (NTFS keeps both).
		{id: "unicode-nfc", path: "unicode/caf\u00e9.txt", content: "nfc\n", push: pushLands,
			pull: map[string]pullKind{"linux": pullLands, "darwin": pullLandsOrRefuse, "windows": pullLands}},
		{id: "unicode-nfd", path: "unicode/cafe\u0301.txt", content: "nfd\n", push: pushLands,
			pull: map[string]pullKind{"linux": pullLands, "darwin": pullLandsOrRefuse, "windows": pullLands}},
		{id: "reserved-con", path: "win/CON.txt", content: "con\n", push: pushRefused, pushWhy: "reserved device name", forge: true,
			pull: windowsRefuses, pullWhy: "reserved device name"},
		{id: "reserved-aux", path: "win/aux", content: "aux\n", push: pushRefused, pushWhy: "reserved device name", forge: true,
			pull: windowsRefuses, pullWhy: "reserved device name"},
		{id: "colon", path: "win/a:b", content: "colon\n", push: pushRefused, pushWhy: "is reserved on Windows", forge: true,
			pull: windowsRefuses, pullWhy: "is reserved on Windows"},
		{id: "trailing-dot", path: "win/trailing-dot.", content: "dot\n", push: pushRefused, pushWhy: "trailing dot or space", forge: true,
			pull: windowsRefuses, pullWhy: "trailing dot or space"},
		{id: "trailing-space", path: "win/trailing-space ", content: "space\n", push: pushRefused, pushWhy: "trailing dot or space", forge: true,
			pull: windowsRefuses, pullWhy: "trailing dot or space"},
		// 45 + 1 + ... > 260 characters in the tree alone, before the runner's temp folder is added
		{id: "long-path", path: strings.Join([]string{longDir, longDir, longDir, longDir, longDir, longDir, "file-with-a-long-name.txt"}, "/"),
			content: "deep\n", push: pushLands, pull: everywhere(pullLands)},
		{id: "subsecond-mtime", path: "time/subsecond.txt", content: "t1\n", mtime: preciseMtime, push: pushLands, pull: everywhere(pullLands)},
		{id: "subsecond-mtime-edge", path: "time/edge.txt", content: "t2\n", mtime: time.Date(2026, 10, 1, 10, 20, 30, 999999999, time.UTC), push: pushLands, pull: everywhere(pullLands)},
		// A symlink is not a file: rclone does not follow it, so it never reaches the bucket (and is no error).
		{id: "symlink", path: "link/alias.txt", content: "", push: pushIgnored, pull: everywhere(pullAbsent)},
		{id: "junk-ds-store", path: ".DS_Store", content: "mac junk\n", push: pushIgnored, pull: everywhere(pullAbsent)},
		{id: "junk-thumbs-db", path: "pictures/Thumbs.db", content: "windows junk\n", push: pushIgnored, pull: everywhere(pullAbsent)},
		{id: "junk-desktop-ini", path: "desktop.ini", content: "windows junk\n", push: pushIgnored, pull: everywhere(pullAbsent)},
	}
}()

// quarantine skips the case when FOLDER_SYNC_QUARANTINE lists its id or its group ("junk-files" covers the junk-* cases).
func quarantine(t *testing.T, id string) {
	t.Helper()
	group := id
	switch {
	case strings.HasPrefix(id, "junk-"):
		group = "junk-files"
	case strings.HasPrefix(id, "unicode-"):
		group = "unicode-normalization"
	}
	for _, listed := range strings.Split(os.Getenv(envQuarantine), ",") {
		if listed = strings.TrimSpace(listed); listed != "" && (listed == id || listed == group) {
			t.Skipf("QUARANTINED %s: %s", listed, knownBugs[listed])
		}
	}
}

func TestCrossOSWrite(t *testing.T) {
	out := os.Getenv(envXOSOut)
	if out == "" {
		t.Skip(envXOSOut + " is not set: the Linux job of .github/workflows/test.yml sets it")
	}
	xosWrite(t, out)
}

func TestCrossOSPull(t *testing.T) {
	in := os.Getenv(envXOSIn)
	if in == "" {
		t.Skip(envXOSIn + " is not set: the Windows and macOS jobs of .github/workflows/test.yml set it")
	}
	xosPull(t, in)
}

// TestCrossOSRoundTrip is both halves on this machine, so a Linux `go test ./...` runs the pair too.
func TestCrossOSRoundTrip(t *testing.T) {
	if os.Getenv(envXOSOut) != "" || os.Getenv(envXOSIn) != "" {
		t.Skip("the pair jobs run the halves apart")
	}
	if runtime.GOOS != "linux" {
		t.Skip("Linux writes the tree (it is the one OS that can hold every name); Windows and macOS pull it in the pair jobs")
	}
	dir := t.TempDir()
	t.Run("write", func(t *testing.T) { xosWrite(t, dir) })
	t.Run("pull", func(t *testing.T) { xosPull(t, dir) })
}

// --- the Linux half ------------------------------------------------------------------

func xosWrite(t *testing.T, out string) {
	if runtime.GOOS != "linux" {
		t.Skip("the tree is written on Linux")
	}
	w, a, _ := historyWorld(t)
	mtimeNow := time.Now().UTC().Truncate(time.Second)
	linkTarget := filepath.Join(a.folder, "link", "target.txt")
	for _, c := range xosCases {
		if c.id == "symlink" {
			continue
		}
		mtime := c.mtime
		if mtime.IsZero() {
			mtime = mtimeNow
		}
		writeFile(t, filepath.Join(a.folder, filepath.FromSlash(c.path)), c.content, mtime)
	}
	writeFile(t, linkTarget, "the link points here\n", mtimeNow)
	if err := os.Symlink("target.txt", filepath.Join(a.folder, "link", "alias.txt")); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(a.folder, "rename", "Report.md"), "# report\n", mtimeNow)

	w.must(a, "sync", "--once")
	status := w.must(a, "status")
	prefix := xosHostsPrefix + hostID(t, a) + "/"
	for _, c := range xosCases {
		c := c
		t.Run("push/"+c.id, func(t *testing.T) {
			quarantine(t, c.id)
			content, inBucket := w.object(prefix + c.path)
			switch c.push {
			case pushLands:
				if !inBucket || content != c.content {
					t.Errorf("%s should be in the bucket with its content: found=%v content=%q", c.path, inBucket, content)
				}
			case pushRefused:
				if inBucket {
					t.Errorf("%s was uploaded, but %q makes it unportable", c.path, c.pushWhy)
				}
				if !strings.Contains(status, c.path) || !strings.Contains(status, c.pushWhy) {
					t.Errorf("status must name %s and say %q:\n%s", c.path, c.pushWhy, status)
				}
			case pushIgnored:
				if inBucket {
					t.Errorf("%s was uploaded", c.path)
				}
			}
		})
	}
	t.Run("push/sub-second mtimes survive into the manifest", func(t *testing.T) {
		m, err := manifest.Parse([]byte(mustObject(t, w, prefix+manifest.FileName)))
		if err != nil {
			t.Fatal(err)
		}
		for _, id := range []string{"subsecond-mtime", "subsecond-mtime-edge"} {
			c := caseByID(id)
			entry, ok := m.Index()[c.path]
			if !ok || entry.MTime != manifest.FormatTime(c.mtime) {
				t.Errorf("%s: manifest mtime %q, want %q", c.path, entry.MTime, manifest.FormatTime(c.mtime))
			}
		}
	})
	if _, ok := w.object(prefix + "link/target.txt"); !ok {
		t.Error("link/target.txt, the symlink's target, should upload as a plain file")
	}
	stage1 := bucketSnapshot(t, w, a)

	// stage 2: a rename that changes only the case. Linux holds both names, so the rename is real here; on Windows and macOS
	// the pull must turn Report.md into report.md without losing the file.
	if err := os.Rename(filepath.Join(a.folder, "rename", "Report.md"), filepath.Join(a.folder, "rename", "report.md")); err != nil {
		t.Fatal(err)
	}
	w.must(a, "sync", "--once")
	t.Run("push/a case-only rename replaces the old name", func(t *testing.T) {
		if got, ok := w.object(prefix + "rename/report.md"); !ok || got != "# report\n" {
			t.Errorf("rename/report.md: found=%v content=%q", ok, got)
		}
		if _, ok := w.object(prefix + "rename/Report.md"); ok {
			t.Error("rename/Report.md is still in the bucket after the rename")
		}
	})
	stage2 := bucketSnapshot(t, w, a)

	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, snapshot := range map[string][]byte{"stage1.tar.gz": stage1, "stage2.tar.gz": stage2} {
		if err := os.WriteFile(filepath.Join(out, name), snapshot, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("saved %s and %s to %s", "stage1.tar.gz", "stage2.tar.gz", out)
}

func caseByID(id string) xosCase {
	for _, c := range xosCases {
		if c.id == id {
			return c
		}
	}
	panic("no case " + id)
}

func mustObject(t *testing.T, w *world, key string) string {
	t.Helper()
	data, ok := w.object(key)
	if !ok {
		t.Fatalf("the bucket has no %s", key)
	}
	return data
}

// bucketSnapshot is the project's hosts/ tree as a tar.gz, plus the forged names added to A's manifest.
func bucketSnapshot(t *testing.T, w *world, a *machine) []byte {
	t.Helper()
	prefix := xosHostsPrefix + hostID(t, a) + "/"
	objects := map[string][]byte{}
	for _, key := range w.objects(xosHostsPrefix) {
		content, _ := w.object(key)
		objects[key] = []byte(content)
	}
	m, err := manifest.Parse(objects[prefix+manifest.FileName])
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range xosCases {
		if !c.forge {
			continue
		}
		sum := sha256.Sum256([]byte(c.content))
		m.Files = append(m.Files, manifest.Entry{Path: c.path, Size: int64(len(c.content)), MTime: manifest.FormatTime(preciseMtime),
			SHA256: hex.EncodeToString(sum[:]), WrittenAt: xosForgedWritten})
		objects[prefix+c.path] = []byte(c.content)
	}
	m.Seq++
	objects[prefix+manifest.FileName] = manifest.Marshal(m)
	if _, err := manifest.Parse(objects[prefix+manifest.FileName]); err != nil {
		t.Fatalf("the forged manifest is invalid: %v", err)
	}
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	keys := make([]string, 0, len(objects))
	for key := range objects {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if err := tw.WriteHeader(&tar.Header{Name: key, Mode: 0o644, Size: int64(len(objects[key])), Format: tar.FormatPAX}); err != nil {
			t.Fatal(err)
		}
		tw.Write(objects[key])
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

// --- the half that runs on any OS ----------------------------------------------------

// memoryStandIn serves any key from memory (rclone serve s3 :memory:), on standInAddr, and returns a client for it.
func memoryStandIn(t *testing.T, rcloneBin, keyID, secret string) *s3.Client {
	t.Helper()
	if conn, err := net.DialTimeout("tcp", standInAddr, 200*time.Millisecond); err == nil {
		conn.Close()
		t.Fatalf("%s is busy: stop whatever holds it", standInAddr)
	}
	work := t.TempDir()
	logFile := filepath.Join(work, "stand-in.log")
	cmd := exec.Command(rcloneBin, "serve", "s3", "--addr", standInAddr, "--auth-key", keyID+","+secret, "--config", testtools.NoConfig(t),
		"--cache-dir", filepath.Join(work, "cache"), "-vv", "--log-file", logFile, ":memory:")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		testtools.Terminate(cmd.Process)
		done := make(chan struct{})
		go func() { cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			cmd.Process.Kill()
		}
	})
	for i := 0; ; i++ {
		if conn, err := net.DialTimeout("tcp", standInAddr, 100*time.Millisecond); err == nil {
			conn.Close()
			break
		}
		if i == 50 {
			data, _ := os.ReadFile(logFile)
			t.Fatalf("the memory stand-in did not start:\n%s", data)
		}
		time.Sleep(100 * time.Millisecond)
	}
	client := &s3.Client{Endpoint: "http://" + standInAddr, Region: "auto", AccessKeyID: keyID, SecretAccessKey: secret}
	req, _ := http.NewRequest(http.MethodPut, client.Endpoint+"/"+bucket, nil)
	s3.Sign(req, keyID, secret, "auto", time.Now(), s3.EmptySHA256)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("creating bucket %s on the memory stand-in: %s", bucket, resp.Status)
	}
	return client
}

// loadSnapshot makes the writer's host tree in the bucket exactly the snapshot's, and returns the writer's host id.
func loadSnapshot(t *testing.T, client *s3.Client, path string) string {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	gz, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	want := map[string][]byte{}
	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(tr)
		want[header.Name] = data
	}
	// the writer's host only: the puller's own objects (it publishes a manifest too) stay
	hostPrefix := xosHostsPrefix + hostIDOf(t, want) + "/"
	listed, err := client.List(bucket, hostPrefix, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, object := range listed.Objects {
		if _, keep := want[object.Key]; !keep {
			if err := client.Delete(bucket, object.Key); err != nil {
				t.Fatal(err)
			}
		}
	}
	for key, data := range want {
		if _, err := client.Put(bucket, key, data, "", "", ""); err != nil {
			t.Fatalf("loading %q into the stand-in: %v", key, err)
		}
	}
	return hostIDOf(t, want)
}

func hostIDOf(t *testing.T, objects map[string][]byte) string {
	t.Helper()
	for key := range objects {
		if strings.HasSuffix(key, "/"+manifest.FileName) {
			return strings.Split(strings.TrimPrefix(key, xosHostsPrefix), "/")[0]
		}
	}
	t.Fatal("the snapshot has no manifest")
	return ""
}

type xosObserved struct{ id, expected, observed string }

func xosPull(t *testing.T, in string) {
	rcloneBin := testtools.PinnedRclone(t, repo)
	work := t.TempDir()
	bin := filepath.Join(work, testtools.Exe("folder-sync"))
	goBuild(t, bin, "./cmd/folder-sync")
	keyID, secret := "xos"+randomHex(8), randomHex(20)
	client := memoryStandIn(t, rcloneBin, keyID, secret)
	w := &world{t: t, bin: bin, rclone: rcloneBin, keyID: keyID, secret: secret, ops: &opLog{}}
	p := w.newMachine("P", false)
	p.env = append(p.env, "FOLDER_SYNC_ACCESS_KEY_ID="+keyID, "FOLDER_SYNC_SECRET_ACCESS_KEY="+secret, "FOLDER_SYNC_ENDPOINT=http://"+standInAddr)
	// WHY a file of its own: an empty folder next to a peer is refused as "unmounted" (see TestTwoMachines)
	writeFile(t, filepath.Join(p.folder, "pulled-by.txt"), "this machine's own file\n", time.Time{})
	var seen []xosObserved
	defer func() { writeXOSReport(t, seen) }()

	hostA := loadSnapshot(t, client, filepath.Join(in, "stage1.tar.gz"))
	w.must(p, "init", "--project", project, "--bucket", bucket)
	out := w.must(p, "sync", "--once")
	status := w.must(p, "status")
	peerDir := filepath.Join(p.folder, "hosts", hostA)
	t.Logf("first pull:\n%s", out)

	for _, c := range xosCases {
		c := c
		kind := c.pull[runtime.GOOS]
		t.Run("pull/"+c.id, func(t *testing.T) {
			quarantine(t, c.id)
			seen = append(seen, xosObserved{c.id + " (" + elide(c.path, 48) + ")", kind.String(), checkPull(t, c, kind, peerDir, status)})
		})
	}

	t.Run("pull/sub-second mtimes land on the file", func(t *testing.T) {
		for _, id := range []string{"subsecond-mtime", "subsecond-mtime-edge"} {
			c := caseByID(id)
			info, err := os.Stat(filepath.Join(peerDir, filepath.FromSlash(c.path)))
			if err != nil {
				t.Errorf("%s: %v", c.path, err)
				continue
			}
			if got := info.ModTime(); got.Sub(c.mtime).Abs() >= mtimeGranularity {
				t.Errorf("%s: mtime %s, want %s (the filesystem keeps %s)", c.path, got.UTC().Format(time.RFC3339Nano), c.mtime.Format(time.RFC3339Nano), mtimeGranularity)
			}
		}
	})

	t.Run("pull/a case-only rename keeps the file under its new name", func(t *testing.T) {
		loadSnapshot(t, client, filepath.Join(in, "stage2.tar.gz"))
		out := w.must(p, "sync", "--once")
		var names []string
		entries, _ := os.ReadDir(filepath.Join(peerDir, "rename"))
		for _, entry := range entries {
			names = append(names, entry.Name()) // the spelling the directory itself reports, not the one asked for
		}
		data, _ := os.ReadFile(filepath.Join(peerDir, "rename", "report.md"))
		ok := len(names) == 1 && names[0] == "report.md" && string(data) == "# report\n"
		seen = append(seen, xosObserved{"case-only rename (rename/Report.md -> report.md)", "report.md, with its content", fmt.Sprintf("%q %q", names, data)})
		if !ok {
			t.Errorf("after Report.md became report.md the folder holds %q with content %q, want exactly [report.md] and %q\nsync said:\n%s",
				names, data, "# report\n", out)
		}
	})
}

// reporter is the part of *testing.T checkPull uses, so a test can watch what it reports.
type reporter interface {
	Helper()
	Errorf(format string, args ...any)
}

// checkPull asserts one case against the pulled tree and returns what it saw, for the report.
func checkPull(t reporter, c xosCase, kind pullKind, peerDir, status string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(peerDir, filepath.FromSlash(c.path)))
	onDisk := err == nil
	reported := strings.Contains(status, c.path) && (c.pullWhy == "" || strings.Contains(status, c.pullWhy))
	// WHY the directory listing too: a name a filesystem folds (NFD to NFC, a trailing dot dropped) still opens, as another file
	spelled := false
	if entries, err := os.ReadDir(filepath.Dir(filepath.Join(peerDir, filepath.FromSlash(c.path)))); err == nil {
		for _, entry := range entries {
			spelled = spelled || entry.Name() == filepath.Base(filepath.FromSlash(c.path))
		}
	}
	saw := fmt.Sprintf("on disk=%v (spelled as sent=%v), reported=%v", onDisk, spelled, reported)
	switch kind {
	case pullLands:
		if !onDisk || !spelled || string(data) != c.content {
			t.Errorf("%s should land intact: %s, content %q", c.path, saw, data)
		}
	case pullRefused:
		if onDisk {
			t.Errorf("%s should be refused here but landed: %s", c.path, saw)
		}
		if !reported {
			t.Errorf("%s was not landed, and status does not say why (want a reason containing %q):\n%s", c.path, c.pullWhy, status)
		}
	case pullAbsent:
		if onDisk {
			t.Errorf("%s should never have reached this machine: %s", c.path, saw)
		}
	case pullLandsOrRefuse:
		landed := onDisk && spelled && string(data) == c.content
		if !landed && !reported {
			t.Errorf("%s neither landed with its own content nor was refused with a reason: %s, content %q\n%s", c.path, saw, data, status)
		}
	}
	return saw
}

// elide shortens a long path in the middle with an explicit ellipsis (the report shows it, the test uses the full one).
func elide(path string, max int) string {
	runes := []rune(path)
	if len(runes) <= max {
		return path
	}
	return string(runes[:max/2]) + "…" + string(runes[len(runes)-max/2:])
}

// writeXOSReport appends a Markdown table of expected against observed to $FOLDER_SYNC_XOS_REPORT (the job summary).
func writeXOSReport(t *testing.T, seen []xosObserved) {
	path := os.Getenv(envXOSReport)
	if path == "" || len(seen) == 0 {
		return
	}
	var b strings.Builder
	fmt.Fprintf(&b, "\n### Cross-OS names, pulled on %s\n\n| name | expected | observed |\n|---|---|---|\n", runtime.GOOS)
	for _, row := range seen {
		fmt.Fprintf(&b, "| `%s` | %s | %s |\n", strings.ReplaceAll(row.id, "|", "\\|"), row.expected, row.observed)
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		t.Logf("cannot write the report: %v", err)
		return
	}
	defer file.Close()
	file.WriteString(b.String())
}

// --- Windows only: a file held open during a sync ------------------------------------

// TestWindowsFileHeldOpenDuringSync: Word, Excel and antivirus scanners hold files open with no sharing, so folder-sync's
// own read of one fails with "used by another process". The rule: the round ends (never hangs), says which file, uploads
// nothing wrong in its place, and the next round, once the file is free, uploads it whole.
func TestWindowsFileHeldOpenDuringSync(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("an exclusive lock is a Windows thing: Linux and macOS let the sync read the file")
	}
	w, a, _ := historyWorld(t)
	held, free := filepath.Join(a.folder, "held", "open.docx"), filepath.Join(a.folder, "held", "free.txt")
	writeFile(t, held, "the document being edited\n", time.Time{})
	writeFile(t, free, "an ordinary file beside it\n", time.Time{})
	release, err := holdExclusive(held)
	if err != nil {
		t.Fatal(err)
	}
	released := false
	defer func() {
		if !released {
			release()
		}
	}()

	type result struct {
		out  string
		code int
	}
	finished := make(chan result, 1)
	go func() {
		out, code := w.run(a, "sync", "--once")
		finished <- result{out, code}
	}()
	var first result
	select {
	case first = <-finished:
	case <-time.After(90 * time.Second):
		t.Fatal("sync --once did not end within 90 s with a file held open")
	}
	t.Logf("while held: exit %d\n%s", first.code, first.out)
	prefix := project + "/hosts/" + hostID(t, a) + "/"
	if got, ok := w.object(prefix + "held/open.docx"); ok && got != "the document being edited\n" {
		t.Errorf("a held file reached the bucket as %q", got)
	}
	if first.code != 0 && !strings.Contains(first.out, "open.docx") {
		t.Errorf("the round failed (exit %d) without naming the held file:\n%s", first.code, first.out)
	}

	release()
	released = true
	out := w.must(a, "sync", "--once")
	for path, want := range map[string]string{"held/open.docx": "the document being edited\n", "held/free.txt": "an ordinary file beside it\n"} {
		if got, ok := w.object(prefix + path); !ok || got != want {
			t.Errorf("after the lock was released, %s: found=%v content=%q\n%s", path, ok, got, out)
		}
	}
}

// recorder is a reporter that keeps what it was told.
type recorder struct{ errors []string }

func (r *recorder) Helper() {}
func (r *recorder) Errorf(format string, args ...any) {
	r.errors = append(r.errors, fmt.Sprintf(format, args...))
}

// TestPullAssertionsTellRefusedFromLanded drives checkPull over folders made by hand, so the Windows branches (refused, with
// a reason) are proved on any OS before a Windows runner exists.
func TestPullAssertionsTellRefusedFromLanded(t *testing.T) {
	con := caseByID("reserved-con")
	status := "  skipped:         1\n    hosts/abc/win/CON.txt  \"win/CON.txt\": \"CON.txt\" is a reserved device name on Windows\n"
	check := func(kind pullKind, landed bool, status string) []string {
		dir := t.TempDir()
		if landed {
			writeFile(t, filepath.Join(dir, "win", "CON.txt"), con.content, time.Time{})
		}
		r := &recorder{}
		checkPull(r, con, kind, dir, status)
		return r.errors
	}
	if errs := check(pullRefused, false, status); len(errs) != 0 {
		t.Errorf("refused and reported is what Windows should do: %v", errs)
	}
	if errs := check(pullRefused, true, status); len(errs) != 1 || !strings.Contains(errs[0], "landed") {
		t.Errorf("a refused name that landed must fail: %v", errs)
	}
	if errs := check(pullRefused, false, "  skipped:         0\n"); len(errs) != 1 || !strings.Contains(errs[0], "does not say why") {
		t.Errorf("a name that neither landed nor was explained must fail: %v", errs)
	}
	if errs := check(pullLands, false, status); len(errs) != 1 {
		t.Errorf("a name that should land but did not must fail: %v", errs)
	}
	if errs := check(pullLandsOrRefuse, false, "nothing here\n"); len(errs) != 1 || !strings.Contains(errs[0], "neither") {
		t.Errorf("the rule itself: neither landed nor refused must fail: %v", errs)
	}
	if errs := check(pullLandsOrRefuse, false, status); len(errs) != 0 {
		t.Errorf("refused with a reason satisfies the rule: %v", errs)
	}
	if elide(strings.Repeat("x", 100), 10) != "xxxxx…xxxxx" || elide("short", 10) != "short" {
		t.Error("elide")
	}
}
