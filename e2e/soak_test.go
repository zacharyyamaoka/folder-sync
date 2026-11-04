//go:build !windows

package e2e

// Gate G1, nothing lost: a randomized soak. Three machines and the web host share one folder through the stand-in. A seeded
// RNG drives edits, deletes, renames, directory moves, kills in the middle of a sync, offline periods, rounds that run at the
// same time on two or three machines, and a second person editing another machine's copy of a file. When the editing stops
// the machines sync until they settle, and then every claim is checked against the disk:
//
//   - each machine's published manifest lists exactly its folder, and every listed object holds those bytes;
//   - every machine's copy of every other host (the web host included) is byte-identical to that host's own files;
//   - no version was lost: every delete a change record shows kept the file's last bytes, every kept version is in
//     _history/ with the bytes its name says, and every file deleted at the end is restorable from `folder-sync deleted`;
//   - every edit made to a peer's copy is still somewhere: where it was made, or in ~/.folder-sync/conflicts/.
//
// Profiles (FOLDER_SYNC_SOAK): unset is the smoke run every `go test ./...` makes (about 30 s); "ci" is the gates job's run
// (at most 3 minutes); "long" is the local run (30 minutes, FOLDER_SYNC_SOAK_SECONDS to change it). FOLDER_SYNC_SOAK_SEED
// picks the sequence (default 1); a failure prints the seed that reproduces it. FOLDER_SYNC_SOAK_REPORT=<file> writes a JSON
// summary (scripts/gates keeps it as G1's evidence).
//
// WHY the web host is the test's own writer: the real one is the accounts Worker's Durable Object, covered by
// accounts/test; what a machine needs from it is the bucket contract (objects, then the manifest), which the stand-in
// writer follows. The core's e2e must work with no server at all (scripts/check-core-alone).

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"folder-sync/internal/host"
	"folder-sync/internal/manifest"
	"folder-sync/internal/s3"
)

type soakProfile struct {
	name    string
	seconds int // how long the editing runs; the settling after it is extra
	maxStep int
}

func soakProfileFromEnv(t *testing.T) soakProfile {
	profile := map[string]soakProfile{
		"":     {"smoke", 20, 40},
		"ci":   {"ci", 90, 700},
		"long": {"long", 1800, 100000},
	}[os.Getenv("FOLDER_SYNC_SOAK")]
	if profile.name == "" {
		t.Fatalf("FOLDER_SYNC_SOAK=%q: use ci or long (or leave it unset for the smoke run)", os.Getenv("FOLDER_SYNC_SOAK"))
	}
	if v := os.Getenv("FOLDER_SYNC_SOAK_SECONDS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			t.Fatalf("FOLDER_SYNC_SOAK_SECONDS=%q", v)
		}
		profile.seconds = n
	}
	return profile
}

// soakWeb is the web host's stand-in: it owns hosts/<id>/ and writes objects, then the manifest.
type soakWeb struct {
	id     string
	client *s3.Client
	files  map[string]string
	seq    int64
}

func (web *soakWeb) publish(t *testing.T) {
	t.Helper()
	m := manifest.Manifest{Schema: manifest.Schema, Project: project, HostID: web.id, HostName: "web (soak)", Seq: web.seq,
		GeneratedAt: manifest.FormatTime(time.Now())}
	for path, content := range web.files {
		sum := sha256.Sum256([]byte(content))
		now := manifest.FormatTime(time.Now())
		m.Files = append(m.Files, manifest.Entry{Path: path, Size: int64(len(content)), MTime: now, SHA256: hex.EncodeToString(sum[:]), WrittenAt: now})
	}
	m.Sort()
	if _, err := web.client.Put(bucket, project+"/hosts/"+web.id+"/"+manifest.FileName, manifest.Marshal(m), "", "", ""); err != nil {
		t.Fatal(err)
	}
}

// write is a web edit: the object first, then a manifest that lists it (docs/CONTRACT.md "Consistency").
func (web *soakWeb) write(t *testing.T, path, content string) {
	t.Helper()
	if content == "" {
		content = "\n" // the client sends a zero-length body as chunked, which the stand-in refuses (411); the machines cover empty files
	}
	if _, err := web.client.Put(bucket, project+"/hosts/"+web.id+"/"+path, []byte(content), "", "", ""); err != nil {
		t.Fatal(err)
	}
	web.files[path] = content
	web.seq++
	web.publish(t)
}

func (web *soakWeb) remove(t *testing.T, path string) {
	t.Helper()
	delete(web.files, path)
	web.seq++
	web.publish(t) // the manifest first: a path missing from it is deleted, the object may follow
	if err := web.client.Delete(bucket, project+"/hosts/"+web.id+"/"+path); err != nil {
		t.Fatal(err)
	}
}

type soakRun struct {
	t       *testing.T
	w       *world
	rng     *rand.Rand
	rounds  int
	ops     map[string]int
	web     *soakWeb
	edits   []peerEdit
	pending map[*machine]bool // machines whose last round did not finish (offline or killed): the next one must heal
	offline map[*machine]int  // machines with no network until this step: they edit but do not sync
	stepNo  int
	mu      sync.Mutex
	log     []string
}

type peerEdit struct{ on, of, path, content string }

var soakDirs = []string{"", "notes/", "notes/deep/x/", "src/", "unicode/", "space dir/", "a b/c d/"}

// soakNames mix plain names with the two spellings of the same accented name, which are two files (names.go).
var soakNames = []string{"alpha.md", "beta.txt", "gamma.bin", "delta.md", "eps ilon.txt", "caf\u00e9.txt", "cafe\u0301.txt", "zeta.json", "eta.md", "theta.txt", "iota.md", "kappa.txt"}

func (r *soakRun) note(format string, args ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.log = append(r.log, fmt.Sprintf(format, args...))
}

func (r *soakRun) content() string {
	var size int
	switch roll := r.rng.IntN(100); {
	case roll < 5:
		size = 0
	case roll < 65:
		size = 1 + r.rng.IntN(200)
	case roll < 95:
		size = 200 + r.rng.IntN(8000)
	default:
		size = 100_000 + r.rng.IntN(300_000)
	}
	var b strings.Builder
	for b.Len() < size {
		fmt.Fprintf(&b, "%08x line %d\n", r.rng.Uint32(), b.Len())
	}
	return b.String()[:size]
}

func (r *soakRun) pickPath() string {
	return soakDirs[r.rng.IntN(len(soakDirs))] + soakNames[r.rng.IntN(len(soakNames))]
}

// ownTree is the files a machine publishes: its folder without the peers' copies and its config.
func ownTree(t *testing.T, folder string) map[string]string {
	t.Helper()
	return readTree(t, folder, func(rel string) bool {
		return rel == "hosts" || strings.HasPrefix(rel, "hosts/") || rel == ".folder-sync.toml"
	})
}

func readTree(t *testing.T, root string, skip func(rel string) bool) map[string]string {
	t.Helper()
	out := map[string]string{}
	filepathWalk(t, root, func(rel string, isDir bool) bool {
		if skip(rel) {
			return false
		}
		if !isDir {
			data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
			if err != nil {
				t.Fatal(err)
			}
			out[rel] = string(data)
		}
		return true
	})
	return out
}

func filepathWalk(t *testing.T, root string, visit func(rel string, isDir bool) bool) {
	t.Helper()
	var walk func(dir string)
	walk = func(dir string) {
		entries, err := os.ReadDir(filepath.Join(root, filepath.FromSlash(dir)))
		if err != nil {
			if os.IsNotExist(err) {
				return
			}
			t.Fatal(err)
		}
		for _, entry := range entries {
			rel := strings.TrimPrefix(dir+"/"+entry.Name(), "/")
			if visit(rel, entry.IsDir()) && entry.IsDir() {
				walk(rel)
			}
		}
	}
	walk("")
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// run runs folder-sync on m. killAfter > 0 kills the whole process group (folder-sync and its rclone) that long after the
// start, as a power cut does. offline points the machine at an address nothing listens on.
func (r *soakRun) run(m *machine, killAfter time.Duration, offline bool, args ...string) (string, int) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, r.w.bin, args...)
	cmd.Env = m.env
	if offline {
		cmd.Env = append(append([]string{}, m.env...), "FOLDER_SYNC_ENDPOINT=http://127.0.0.1:1")
	}
	cmd.Dir = m.folder
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var out lockedBuffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Start(); err != nil {
		r.t.Fatal(err)
	}
	if killAfter > 0 {
		timer := time.AfterFunc(killAfter, func() { syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) })
		defer timer.Stop()
	}
	err := cmd.Wait()
	// anything the group left behind (an rclone that outlived a killed parent) is stopped here, by the group id we made
	syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	code := 0
	if exitErr, ok := err.(*exec.ExitError); ok {
		code = exitErr.ExitCode()
	} else if err != nil {
		r.t.Fatal(err)
	}
	return out.String(), code
}

// round is one ordinary sync: it must succeed, and it heals whatever a killed or offline round left.
func (r *soakRun) round(m *machine, discover bool) {
	args := []string{"sync", "--once"}
	if discover {
		args = append(args, "--discover")
	}
	out, code := r.run(m, 0, false, args...)
	r.rounds++
	if code != 0 {
		r.t.Fatalf("seed %s: %s's sync --once exited %d (it must succeed, even right after a kill or an offline round):\n%s\n\nops so far:\n%s",
			os.Getenv("FOLDER_SYNC_SOAK_SEED"), m.name, code, out, strings.Join(r.log, "\n"))
	}
	delete(r.pending, m)
}

func (r *soakRun) isOffline(m *machine) bool { return r.offline[m] > r.stepNo }

func (r *soakRun) step(machines []*machine) {
	r.stepNo++
	began := time.Now()
	defer func() {
		if took := time.Since(began); took > 3*time.Second {
			r.note("   (that step took %s)", took.Round(time.Millisecond))
		}
	}()
	m := machines[r.rng.IntN(len(machines))]
	own := ownTree(r.t, m.folder)
	delete(own, "anchor.md")
	switch roll := r.rng.IntN(100); {
	case roll < 22: // write: a new file, or an edit
		path := r.pickPath()
		content := r.content()
		if _, exists := own[path]; exists && r.rng.IntN(5) == 0 {
			content = own[path] // saved again with no change
		}
		writeFile(r.t, filepath.Join(m.folder, filepath.FromSlash(path)), content, time.Time{})
		r.ops["write"]++
		r.note("%s write %s (%d bytes)", m.name, path, len(content))
	case roll < 32 && len(own) > 0: // delete
		path := sortedKeys(own)[r.rng.IntN(len(own))]
		os.Remove(filepath.Join(m.folder, filepath.FromSlash(path)))
		r.ops["delete"]++
		r.note("%s delete %s", m.name, path)
	case roll < 42 && len(own) > 0: // rename
		from := sortedKeys(own)[r.rng.IntN(len(own))]
		to := r.pickPath()
		if _, taken := own[to]; taken || to == from {
			return
		}
		os.MkdirAll(filepath.Dir(filepath.Join(m.folder, filepath.FromSlash(to))), 0o755)
		if err := os.Rename(filepath.Join(m.folder, filepath.FromSlash(from)), filepath.Join(m.folder, filepath.FromSlash(to))); err == nil {
			r.ops["rename"]++
			r.note("%s rename %s -> %s", m.name, from, to)
		}
	case roll < 47: // move a directory
		from := strings.TrimSuffix(soakDirs[1+r.rng.IntN(len(soakDirs)-1)], "/")
		to := "moved-" + strconv.Itoa(r.rng.IntN(3))
		if _, err := os.Stat(filepath.Join(m.folder, filepath.FromSlash(from))); err != nil {
			return
		}
		if _, err := os.Stat(filepath.Join(m.folder, to)); err == nil {
			return
		}
		if err := os.Rename(filepath.Join(m.folder, filepath.FromSlash(from)), filepath.Join(m.folder, to)); err == nil {
			r.ops["move-dir"]++
			r.note("%s move dir %s -> %s", m.name, from, to)
		}
	case roll < 52: // the web host edits or deletes
		if len(r.web.files) > 0 && r.rng.IntN(3) == 0 {
			path := sortedKeys(r.web.files)[r.rng.IntN(len(r.web.files))]
			r.web.remove(r.t, path)
			r.ops["web-delete"]++
			r.note("web delete %s", path)
			return
		}
		path := r.pickPath()
		r.web.write(r.t, path, r.content())
		r.ops["web-write"]++
		r.note("web write %s", path)
	case roll < 58: // a second person edits this machine's copy of another host's file
		mirrors := readTree(r.t, m.folder, func(rel string) bool { return rel != "hosts" && !strings.HasPrefix(rel, "hosts/") })
		var copies []string
		for rel := range mirrors {
			if parts := strings.SplitN(rel, "/", 3); len(parts) == 3 {
				copies = append(copies, rel)
			}
		}
		if len(copies) == 0 {
			return
		}
		sort.Strings(copies)
		rel := copies[r.rng.IntN(len(copies))]
		parts := strings.SplitN(rel, "/", 3)
		edit := fmt.Sprintf("a second person's edit %d on %s\n", r.rng.Uint32(), m.name)
		writeFile(r.t, filepath.Join(m.folder, filepath.FromSlash(rel)), edit, time.Time{})
		r.edits = append(r.edits, peerEdit{on: m.name, of: parts[1], path: parts[2], content: edit})
		r.ops["edit-peer-copy"]++
		r.note("%s edits its copy of %s/%s", m.name, parts[1], parts[2])
	case roll < 66: // a sync killed part way
		if r.isOffline(m) {
			return
		}
		after := time.Duration(r.rng.IntN(700)) * time.Millisecond
		r.run(m, after, false, "sync", "--once")
		r.pending[m] = true
		r.ops["kill-mid-sync"]++
		r.note("%s sync killed after %s", m.name, after)
	case roll < 72: // goes offline for a few steps, and tries one round against an address nothing listens on
		// WHY the round is cut off after 3 s: against a dead address rclone retries for a minute before it gives up, which is
		// right for a laptop and too slow for a test; what is tested is that the cut-off leaves nothing half done
		r.run(m, 3*time.Second, true, "sync", "--once")
		r.pending[m] = true
		r.offline[m] = r.stepNo + 2 + r.rng.IntN(5)
		r.ops["offline-period"]++
		r.note("%s goes offline until step %d (a round against a dead address was cut off)", m.name, r.offline[m])
	case roll < 80: // two or three machines sync at the same moment
		var online []int
		for i, mm := range machines {
			if !r.isOffline(mm) {
				online = append(online, i)
			}
		}
		if len(online) < 2 {
			return
		}
		r.rng.Shuffle(len(online), func(i, j int) { online[i], online[j] = online[j], online[i] })
		group := online[:2+r.rng.IntN(len(online)-1)]
		var wg sync.WaitGroup
		failed := make(chan string, len(group))
		for _, i := range group {
			wg.Add(1)
			go func(mm *machine) {
				defer wg.Done()
				if out, code := r.run(mm, 0, false, "sync", "--once", "--discover"); code != 0 {
					failed <- fmt.Sprintf("%s exited %d:\n%s", mm.name, code, out)
				}
			}(machines[i])
		}
		wg.Wait()
		close(failed)
		for msg := range failed {
			r.t.Fatalf("seed %s: concurrent sync: %s\n\nops so far:\n%s", os.Getenv("FOLDER_SYNC_SOAK_SEED"), msg, strings.Join(r.log, "\n"))
		}
		for _, i := range group {
			delete(r.pending, machines[i])
		}
		r.rounds += len(group)
		r.ops["concurrent-rounds"]++
		r.note("concurrent rounds on %d machines", len(group))
	default: // an ordinary round
		if r.isOffline(m) {
			return
		}
		r.round(m, r.rng.IntN(4) == 0)
		r.ops["round"]++
		r.note("%s sync", m.name)
	}
}

func TestSoakNothingLost(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the soak kills process groups")
	}
	profile := soakProfileFromEnv(t)
	seed := uint64(1)
	if v := os.Getenv("FOLDER_SYNC_SOAK_SEED"); v != "" {
		n, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			t.Fatalf("FOLDER_SYNC_SOAK_SEED=%q", v)
		}
		seed = n
	}
	os.Setenv("FOLDER_SYNC_SOAK_SEED", strconv.FormatUint(seed, 10))

	w, a, b := historyWorld(t)
	c := w.newMachine("C", true)
	w.must(c, "init", "--project", project, "--bucket", bucket)
	machines := []*machine{a, b, c}
	webID, err := host.NewID()
	if err != nil {
		t.Fatal(err)
	}
	r := &soakRun{t: t, w: w, rng: rand.New(rand.NewPCG(seed, 0x9e3779b97f4a7c15)), ops: map[string]int{}, pending: map[*machine]bool{}, offline: map[*machine]int{},
		web: &soakWeb{id: webID, client: &s3.Client{Endpoint: "http://" + standInAddr, Region: "auto", AccessKeyID: w.keyID, SecretAccessKey: w.secret}, files: map[string]string{}, seq: 1}}
	for _, m := range machines {
		// WHY an anchor file: a machine whose folder looks empty refuses to push (an unmounted disk), and the soak deletes freely
		writeFile(t, filepath.Join(m.folder, "anchor.md"), "anchor of "+m.name+"\n", time.Time{})
	}
	r.web.write(t, "web-start.md", "the web host starts with a file\n")
	t.Logf("seed %d, profile %s: %d s of editing, at most %d steps", seed, profile.name, profile.seconds, profile.maxStep)
	started := time.Now()
	for _, m := range machines {
		r.round(m, true)
	}

	steps := 0
	for ; steps < profile.maxStep && time.Since(started) < time.Duration(profile.seconds)*time.Second; steps++ {
		r.step(machines)
	}
	editing := time.Since(started)

	// settle: every machine syncs, in turn, until nothing changes anywhere
	var problems []string
	settled := 0
	for pass := 1; pass <= 8; pass++ {
		for _, m := range machines {
			r.round(m, true)
		}
		if problems = r.check(machines); len(problems) == 0 {
			settled = pass
			break
		}
	}
	if len(problems) > 0 {
		t.Fatalf("seed %d: %d machines did not converge after 8 passes (reproduce: FOLDER_SYNC_SOAK_SEED=%d FOLDER_SYNC_SOAK=%s go test ./e2e -run TestSoakNothingLost):\n  %s\n\nops:\n%s",
			seed, len(machines), seed, profile.name, strings.Join(problems, "\n  "), strings.Join(r.log, "\n"))
	}
	lost := r.lostVersions(machines)
	kept := r.editsKept(machines)
	report := map[string]any{
		"schema": "folder-sync-soak/1", "seed": seed, "profile": profile.name, "steps": steps, "rounds": r.rounds, "ops": r.ops,
		"editing_seconds": int(editing.Seconds()), "total_seconds": int(time.Since(started).Seconds()), "settle_passes": settled,
		"converged": true, "lost_versions": len(lost), "peer_edits": len(r.edits), "peer_edits_kept": kept,
	}
	t.Logf("soak: %+v", report)
	if path := os.Getenv("FOLDER_SYNC_SOAK_REPORT"); path != "" {
		data, _ := json.MarshalIndent(report, "", "  ")
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Errorf("cannot write the soak report: %v", err)
		}
	}
	if len(lost) > 0 {
		t.Errorf("seed %d: %d lost versions:\n  %s", seed, len(lost), strings.Join(lost, "\n  "))
	}
	if kept != len(r.edits) {
		t.Errorf("seed %d: %d of %d edits to peer copies are nowhere (neither in place nor in conflicts/)", seed, len(r.edits)-kept, len(r.edits))
	}
}

// check answers what is still wrong about the settled state, empty when everything the gate promises holds.
func (r *soakRun) check(machines []*machine) []string {
	t := r.t
	var problems []string
	owners := map[string]map[string]string{}
	ids := map[string]*machine{}
	for _, m := range machines {
		id := hostID(t, m)
		ids[id] = m
		owners[id] = ownTree(t, m.folder)
	}
	owners[r.web.id] = r.web.files
	for id, tree := range owners {
		label := id[:8]
		if m := ids[id]; m != nil {
			label = m.name
		}
		// the bucket: the manifest lists exactly the files, and each object holds its bytes
		var mf manifest.Manifest
		data, ok := r.w.object(project + "/hosts/" + id + "/" + manifest.FileName)
		if !ok {
			problems = append(problems, label+": no manifest in the bucket")
			continue
		}
		parsed, err := manifest.Parse([]byte(data))
		if err != nil {
			problems = append(problems, label+": manifest: "+err.Error())
			continue
		}
		mf = parsed
		listed := map[string]string{}
		for _, e := range mf.Files {
			object, found := r.w.object(project + "/hosts/" + id + "/" + e.Path)
			sum := sha256.Sum256([]byte(object))
			switch {
			case !found:
				problems = append(problems, fmt.Sprintf("%s: the manifest lists %s but the bucket lacks it", label, e.Path))
			case hex.EncodeToString(sum[:]) != e.SHA256:
				problems = append(problems, fmt.Sprintf("%s: the object %s does not match its manifest entry", label, e.Path))
			}
			listed[e.Path] = object
		}
		for path, content := range tree {
			if got, ok := listed[path]; !ok {
				problems = append(problems, fmt.Sprintf("%s: %s is on disk but not in its manifest", label, path))
			} else if got != content {
				problems = append(problems, fmt.Sprintf("%s: %s differs between disk and bucket", label, path))
			}
		}
		for path := range listed {
			if _, ok := tree[path]; !ok {
				problems = append(problems, fmt.Sprintf("%s: the manifest lists %s, which is not on disk", label, path))
			}
		}
		// every other machine's copy
		for _, m := range machines {
			if id == hostID(t, m) {
				continue
			}
			mirror := readTree(t, filepath.Join(m.folder, "hosts", id), func(string) bool { return false })
			for path, content := range tree {
				if got, ok := mirror[path]; !ok {
					problems = append(problems, fmt.Sprintf("%s's copy of %s lacks %s", m.name, label, path))
				} else if got != content && !r.editedHere(m.name, id, path, got) {
					problems = append(problems, fmt.Sprintf("%s's copy of %s differs at %s", m.name, label, path))
				}
			}
			for path := range mirror {
				if _, ok := tree[path]; !ok {
					problems = append(problems, fmt.Sprintf("%s's copy of %s still has %s, which %s deleted", m.name, label, path, label))
				}
			}
		}
	}
	sort.Strings(problems)
	if len(problems) > 12 {
		problems = append(problems[:12], fmt.Sprintf("… and %d more", len(problems)-12))
	}
	return problems
}

// editedHere: the copy holds a second person's edit, which stays on disk until that host's next manifest replaces it (and then
// moves to conflicts/). Not a divergence: editsKept proves the edit is not lost.
func (r *soakRun) editedHere(machine, hostID, path, got string) bool {
	for _, edit := range r.edits {
		if edit.on == machine && edit.of == hostID && edit.path == path && edit.content == got {
			return true
		}
	}
	return false
}

// lostVersions reads every machine's change records and checks the versions they say were kept.
func (r *soakRun) lostVersions(machines []*machine) []string {
	t := r.t
	var lost []string
	for _, m := range machines {
		id := hostID(t, m)
		for _, key := range r.w.objects("_changes/" + project + "/" + id + "/") {
			if strings.Contains(strings.TrimPrefix(key, "_changes/"+project+"/"+id+"/"), "/") {
				continue // pulls/
			}
			var record changeRecord
			r.w.jsonObject(t, key, &record)
			for _, e := range record.Events {
				if e.Was == nil {
					continue // an add
				}
				switch {
				case e.Was.Kept != nil:
					content, ok := r.w.object("_history/" + project + "/" + id + "/" + e.Path + "/" + *e.Was.Kept)
					if !ok || !strings.HasSuffix(*e.Was.Kept, "_"+sha16(content)) {
						lost = append(lost, fmt.Sprintf("%s: seq %d says %s was kept as %s, but history has found=%v and bytes with sha16 %s",
							m.name, record.Seq, e.Path, *e.Was.Kept, ok, sha16(content)))
					}
				case e.Event == "delete":
					lost = append(lost, fmt.Sprintf("%s: seq %d deleted %s and kept nothing (why %q)", m.name, record.Seq, e.Path, e.Was.Why))
				case e.Was.Why != "burst":
					lost = append(lost, fmt.Sprintf("%s: seq %d replaced %s and kept nothing (why %q); only burst is a reason", m.name, record.Seq, e.Path, e.Was.Why))
				}
			}
		}
	}
	sort.Strings(lost)
	return lost
}

// editsKept counts the edits made to a peer's copy that can still be found: in place, or in the machine's conflicts/ folder.
func (r *soakRun) editsKept(machines []*machine) int {
	t := r.t
	var kept int
	for _, edit := range r.edits {
		var m *machine
		for _, candidate := range machines {
			if candidate.name == edit.on {
				m = candidate
			}
		}
		found := false
		for _, root := range []string{m.folder, filepath.Join(m.home, ".folder-sync", "conflicts")} {
			for _, content := range readTree(t, root, func(string) bool { return false }) {
				found = found || content == edit.content
			}
		}
		if found {
			kept++
		} else {
			r.note("LOST EDIT on %s: %q", edit.on, bytes.TrimSpace([]byte(edit.content)))
		}
	}
	return kept
}
