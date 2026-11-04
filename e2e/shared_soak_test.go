//go:build !windows

package e2e

// Gate G1 for the shared tree (docs/peps/0010 §11): the nothing-lost soak, with one tree that three machines and a page edit.
// The real accounts Worker (the tree's one writer), the real binary on three machines, a browser. A seeded RNG drives appends,
// inserted lines, new files, deletes, renames, saves by a page that works from a version that may be stale, syncs, syncs that
// run at the same moment, syncs killed in the middle of a commit, and machines that stay offline for a while. When the
// editing stops the machines sync until nothing changes, and then every claim is checked:
//
//   - every machine's folder holds exactly the tree's files, byte for byte, and the tree's manifest lists them;
//   - every token anybody wrote (a unique line) is in a live file, in a kept version in history, or in a conflict copy: an
//     edit is in the file, in a conflict copy, or in history, never nowhere;
//   - every version a change record says it kept is in history, opens, and has the bytes its name says (pointers included);
//   - every version a merge kept of the device's own bytes opens too;
//   - every conflict copy a record names is in the tree or restorable.
//
// Profiles (FOLDER_SYNC_SOAK) and the seed (FOLDER_SYNC_SOAK_SEED) are the nothing-lost soak's: unset is the smoke run every
// `go test ./...` makes; a failure prints the seed that reproduces it. WHY the edits only add (append, insert, create): a line
// that is rewritten leaves its old token nowhere by design, and the claim is about what was kept, not what was replaced.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

var sharedSoakPaths = []string{"a.md", "b.md", "notes/c.md", "notes/deep/d.txt", "logs/e.jsonl", "logs/f.jsonl", "g.bin", "docs/h.md", "x y/i.md", "caf\u00e9.md"}

type sharedSoak struct {
	t       *testing.T
	s       *stack
	br      *browser
	p       *sharedFolder
	c       *node
	rng     *rand.Rand
	nodes   []*node
	dirty   map[*node]map[string]bool // paths written since that machine's last successful sync
	offline map[*node]int             // steps until a machine syncs again
	tokens  map[string]string         // token -> who wrote it
	next    int
	seen    map[string]pageView // what the page last looked at
	log     []string
	ops     map[string]int
	step    int
}

type pageView struct {
	version string
	content string
}

func (r *sharedSoak) note(format string, args ...any) {
	r.log = append(r.log, fmt.Sprintf(format, args...))
}

func (r *sharedSoak) token(who string) string {
	r.next++
	tok := fmt.Sprintf("tok%04d-%s", r.next, who)
	r.tokens[tok] = who
	return tok
}

func isBinary(path string) bool { return strings.HasSuffix(path, ".bin") }

// line is one line carrying a token, shaped for the file's format.
func (r *sharedSoak) line(path, who string) string {
	tok := r.token(who)
	if strings.HasSuffix(path, ".jsonl") {
		return fmt.Sprintf(`{"t":%q}`, tok) + "\n"
	}
	return "line " + tok + "\n"
}

// treeVersionOf is the version id of a path in the tree now, and its bytes; "" when it is not there.
func (r *sharedSoak) treeVersionOf(path string) (version, content string) {
	return r.s.treeVersion(r.br.userID, r.p.name, r.p.tree, path)
}

func (r *sharedSoak) mark(n *node, path string) {
	if r.dirty[n] == nil {
		r.dirty[n] = map[string]bool{}
	}
	r.dirty[n][path] = true
}

func (r *sharedSoak) syncOne(n *node, killAfter time.Duration) {
	var out string
	var code int
	if killAfter > 0 {
		out, code = n.runKilled(killAfter, "sync", "--once")
		r.note("%s sync (killed after %s)", n.name, killAfter)
		return
	}
	out, code = n.run("sync", "--once", "--discover")
	r.note("%s sync", n.name)
	if code != 0 {
		r.t.Fatalf("seed %s: %s's sync --once exited %d: %s (it must succeed, even after a kill); its output:\n%s\n\nops so far:\n%s", os.Getenv("FOLDER_SYNC_SOAK_SEED"), n.name, code, lastLine(out), out, strings.Join(r.log, "\n"))
	}
	r.dirty[n] = map[string]bool{}
}

func (r *sharedSoak) doStep() {
	r.step++
	n := r.nodes[r.rng.IntN(len(r.nodes))]
	offline := r.offline[n] > r.step
	own := n.folderFiles()
	switch roll := r.rng.IntN(100); {
	case roll < 38: // a machine adds a line, inserts one, or creates a file
		path := sharedSoakPaths[r.rng.IntN(len(sharedSoakPaths))]
		if isBinary(path) {
			content := make([]byte, 20+r.rng.IntN(200))
			for i := range content {
				content[i] = byte(r.rng.IntN(256))
			}
			n.writeBytes(path, content)
			r.ops["write binary"]++
			r.note("%s write %s (binary)", n.name, path)
		} else {
			old, exists := own[path]
			var content string
			switch {
			case !exists:
				content = r.line(path, n.name)
				for i := r.rng.IntN(5); i > 0; i-- {
					content += r.line(path, n.name)
				}
			case r.rng.IntN(5) == 0:
				lines := strings.SplitAfter(old, "\n")
				at := r.rng.IntN(len(lines))
				content = strings.Join(lines[:at], "") + r.line(path, n.name) + strings.Join(lines[at:], "")
			default:
				if old != "" && !strings.HasSuffix(old, "\n") {
					old += "\n"
				}
				content = old + r.line(path, n.name)
			}
			n.write(path, content)
			r.ops["write"]++
			r.note("%s write %s (%d bytes)", n.name, path, len(content))
		}
		r.mark(n, path)
	case roll < 46 && len(own) > 1: // delete a file whose bytes the tree already has
		path := sortedKeys(own)[r.rng.IntN(len(own))]
		if r.dirty[n][path] || isBinary(path) && false {
			return
		}
		os.Remove(n.path(path))
		r.ops["delete"]++
		r.note("%s delete %s", n.name, path)
	case roll < 52 && len(own) > 1: // rename
		from := sortedKeys(own)[r.rng.IntN(len(own))]
		to := sharedSoakPaths[r.rng.IntN(len(sharedSoakPaths))]
		if _, taken := own[to]; taken || to == from || r.dirty[n][from] {
			return
		}
		os.MkdirAll(filepath.Dir(n.path(to)), 0o755)
		if err := os.Rename(n.path(from), n.path(to)); err == nil {
			r.mark(n, to)
			r.ops["rename"]++
			r.note("%s rename %s -> %s", n.name, from, to)
		}
	case roll < 62: // a page saves a file, working from what it last looked at (maybe stale)
		path := sharedSoakPaths[r.rng.IntN(len(sharedSoakPaths))]
		if isBinary(path) {
			return
		}
		view, looked := r.seen[path]
		current, content := r.treeVersionOf(path)
		if !looked || r.rng.IntN(2) == 0 {
			view = pageView{current, content}
			r.seen[path] = view
		}
		next := view.content
		if next != "" && !strings.HasSuffix(next, "\n") {
			next += "\n"
		}
		next += r.line(path, "page")
		headers := map[string]string{}
		if view.version != "" {
			headers["X-Folder-Sync-Base"] = view.version
		}
		status, data := r.br.do("PUT", "/fs/v1/folders/"+r.p.name+"/shared/"+path, []byte(next), headers)
		if status != 200 {
			delete(r.tokens, "tok"+fmt.Sprintf("%04d", r.next)+"-page") // the token never made it: not a claim
			if status != 412 && status != 409 {
				r.t.Fatalf("seed %s: page PUT %s: %d %s", os.Getenv("FOLDER_SYNC_SOAK_SEED"), path, status, data)
			}
		}
		r.ops["page write"]++
		r.note("page write %s (base %s) -> %d", path, view.version, status)
	case roll < 72 && !offline:
		r.syncOne(n, 0)
		r.ops["sync"]++
	case roll < 80: // two or three machines sync at the same moment
		var wg sync.WaitGroup
		results := make([]string, len(r.nodes))
		codes := make([]int, len(r.nodes))
		for i, m := range r.nodes {
			if r.offline[m] > r.step {
				continue
			}
			wg.Add(1)
			go func() {
				defer wg.Done()
				results[i], codes[i] = m.run("sync", "--once")
			}()
		}
		wg.Wait()
		for i, m := range r.nodes {
			if r.offline[m] > r.step {
				continue
			}
			if codes[i] != 0 && codes[i] != 75 { // 75: another round holds the lock
				r.t.Fatalf("seed %s: %s's concurrent sync exited %d: %s; its output:\n%s", os.Getenv("FOLDER_SYNC_SOAK_SEED"), m.name, codes[i], lastLine(results[i]), results[i])
			}
			if codes[i] == 0 {
				r.dirty[m] = map[string]bool{}
			}
		}
		r.ops["concurrent sync"]++
		r.note("concurrent sync")
	case roll < 88 && !offline: // a sync killed in the middle of a commit
		r.syncOne(n, time.Duration(100+r.rng.IntN(900))*time.Millisecond)
		r.ops["killed sync"]++
	case roll < 94: // a machine goes offline for a few steps
		r.offline[n] = r.step + 2 + r.rng.IntN(4)
		r.ops["offline"]++
		r.note("%s offline until step %d", n.name, r.offline[n])
	default: // the page looks at everything again
		for _, path := range sharedSoakPaths {
			if v, c := r.treeVersionOf(path); v != "" {
				r.seen[path] = pageView{v, c}
			}
		}
		r.note("page refresh")
	}
}

// tokensIn finds every token in text.
var tokenPattern = regexp.MustCompile(`tok\d{4}-[A-Za-z-]+`)

func TestSoakSharedNothingLost(t *testing.T) {
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
	steps := map[string]int{"smoke": 30, "ci": 90, "long": 100000}[profile.name]
	s := startStack(t)
	br := s.browser("soak@example.com")
	br.signIn()
	p := s.newFolder(br, "soak")
	c := s.machine("bam-Pi", br)
	c.init("soak")
	r := &sharedSoak{t: t, s: s, br: br, p: p, c: c, rng: rand.New(rand.NewPCG(seed, seed*7919)), nodes: []*node{p.a, p.b, c},
		dirty: map[*node]map[string]bool{}, offline: map[*node]int{}, tokens: map[string]string{}, seen: map[string]pageView{}, ops: map[string]int{}}
	started := time.Now()
	// a file everyone has, so no folder ever looks empty to the unmounted-disk guard
	p.a.write("anchor.md", "anchor\n")
	for _, n := range r.nodes {
		n.must("sync", "--once", "--discover")
	}
	p.a.must("sync", "--once")
	t.Logf("seed %d, %d steps", seed, steps)
	deadline := time.Duration(profile.seconds) * time.Second
	for i := 0; i < steps && time.Since(started) < deadline; i++ {
		r.doStep()
	}
	// the editing stops; every machine syncs, in turn, until nothing changes
	var last string
	for pass := 0; ; pass++ {
		if pass == 12 {
			t.Fatalf("seed %d: the folder did not settle in 12 passes:\n%s\n\nops:\n%s", seed, last, strings.Join(r.log, "\n"))
		}
		for _, n := range r.nodes {
			n.must("sync", "--once", "--discover")
		}
		now := r.view()
		if now == last {
			break
		}
		last = now
	}
	problems := r.check()
	var summary []string
	for k, v := range r.ops {
		summary = append(summary, fmt.Sprintf("%s %d", k, v))
	}
	sort.Strings(summary)
	t.Logf("%d steps in %s (%s); %d tokens written", r.step, time.Since(started).Round(time.Second), strings.Join(summary, ", "), len(r.tokens))
	if report := os.Getenv("FOLDER_SYNC_SOAK_SHARED_REPORT"); report != "" {
		data, _ := json.MarshalIndent(map[string]any{"seed": seed, "profile": profile.name, "steps": r.step, "ops": r.ops, "tokens": len(r.tokens), "problems": problems}, "", "  ")
		os.WriteFile(report, data, 0o644)
	}
	if len(problems) > 0 {
		t.Fatalf("seed %d: %d problems (FOLDER_SYNC_SOAK_SEED=%d go test ./e2e -run TestSoakSharedNothingLost reproduces):\n  %s\n\nops:\n%s",
			seed, len(problems), seed, strings.Join(problems, "\n  "), strings.Join(r.log, "\n"))
	}
}

// view is what the machines and the tree hold, for "nothing changed".
func (r *sharedSoak) view() string {
	var b strings.Builder
	for _, n := range r.nodes {
		files := n.folderFiles()
		for _, k := range sortedKeys(files) {
			fmt.Fprintf(&b, "%s %s %s\n", n.name, k, sha(files[k]))
		}
	}
	tree := r.s.treeOnDisk(r.br.userID, r.p.name, r.p.tree)
	for _, k := range sortedKeys(tree) {
		fmt.Fprintf(&b, "tree %s %s\n", k, sha(tree[k]))
	}
	return b.String()
}

func (r *sharedSoak) check() []string {
	var problems []string
	add := func(format string, args ...any) { problems = append(problems, fmt.Sprintf(format, args...)) }
	tree := r.s.treeOnDisk(r.br.userID, r.p.name, r.p.tree)
	// convergence: every machine holds the tree
	for _, n := range r.nodes {
		got := n.folderFiles()
		for path, want := range tree {
			if have, ok := got[path]; !ok {
				add("%s lacks %s", n.name, path)
			} else if have != want {
				add("%s: %s differs from the tree (%d bytes, the tree has %d)", n.name, path, len(have), len(want))
			}
		}
		for path := range got {
			if _, ok := tree[path]; !ok {
				add("%s has %s, which the tree does not", n.name, path)
			}
		}
	}
	// the manifest lists exactly the tree's files, each with the bytes it names
	m := r.s.sharedManifestFull(r.br.userID, r.p.name, r.p.tree)
	listed := map[string]bool{}
	for _, f := range m.Files {
		listed[f.Path] = true
		if want, ok := tree[f.Path]; !ok || sha(want) != f.SHA256 {
			add("the manifest lists %s with a sha256 its object does not have", f.Path)
		}
	}
	for path := range tree {
		if !listed[path] {
			add("%s is in the bucket but not in the manifest", path)
		}
	}
	// the change records: every kept version opens with the bytes its name says
	histRoot := filepath.Join(r.s.data, "users", r.br.userID, "_history", r.p.name, r.p.tree)
	records, _ := filepath.Glob(filepath.Join(r.s.data, "users", r.br.userID, "_changes", r.p.name, r.p.tree, "*.json"))
	open := func(path, version string) (string, bool) {
		status, body := r.br.json("GET", "/fs/v1/folders/"+r.p.name+"/history/"+r.p.tree+"/"+escapePath(path)+"?version="+url.QueryEscape(version), nil)
		return string(body), status == 200
	}
	checkVersion := func(where, path, version string) {
		body, ok := open(path, version)
		if !ok {
			add("%s: version %s of %s does not open", where, version, path)
			return
		}
		sum := sha256.Sum256([]byte(body))
		if cut := strings.LastIndex(version, "_"); cut >= 0 && !strings.HasSuffix(version, "_unlisted") && !strings.HasPrefix(hex.EncodeToString(sum[:]), version[cut+1:]) {
			add("%s: version %s of %s has other bytes than its name says", where, version, path)
		}
	}
	type record struct {
		Seq    int `json:"seq"`
		Events []struct {
			Event  string `json:"event"`
			Path   string `json:"path"`
			KeptAt string `json:"kept_at"`
			Was    *struct {
				Kept *string `json:"kept"`
			} `json:"was"`
			Merge *struct {
				Yours *string `json:"yours"`
			} `json:"merge"`
		} `json:"events"`
	}
	kept, yours, conflicts := 0, 0, 0
	for _, file := range records {
		data, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		var rec record
		if json.Unmarshal(data, &rec) != nil {
			add("%s is not JSON", filepath.Base(file))
			continue
		}
		for _, ev := range rec.Events {
			where := fmt.Sprintf("record %d", rec.Seq)
			if ev.Was != nil && ev.Was.Kept != nil {
				kept++
				checkVersion(where, ev.Path, *ev.Was.Kept)
			}
			if ev.Merge != nil && ev.Merge.Yours != nil {
				yours++
				checkVersion(where+" (merge)", ev.Path, *ev.Merge.Yours)
			}
			if ev.Event == "conflict" {
				conflicts++
				if _, live := tree[ev.KeptAt]; !live && len(historyFor(histRoot, ev.KeptAt)) == 0 {
					add("%s: the conflict copy %s is neither in the tree nor in history", where, ev.KeptAt)
				}
			}
		}
	}
	// no token is nowhere: in a live file, a kept whole version, or a conflict copy
	haystack := &bytes.Buffer{}
	for _, content := range tree {
		haystack.WriteString(content)
		haystack.WriteByte('\n')
	}
	filepath.WalkDir(r.s.data, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.Contains(path, "_history") && !strings.Contains(path, "conflicts") {
			return nil
		}
		if strings.HasSuffix(path, ".prefix") { // a pointer holds the start of a later object, scanned on its own
			return nil
		}
		if data, err := os.ReadFile(path); err == nil && len(data) < 1<<20 {
			haystack.Write(data)
			haystack.WriteByte('\n')
		}
		return nil
	})
	for _, n := range r.nodes {
		filepath.WalkDir(filepath.Join(n.home, ".folder-sync", "conflicts"), func(path string, d os.DirEntry, err error) error {
			if err == nil && !d.IsDir() {
				if data, err := os.ReadFile(path); err == nil {
					haystack.Write(data)
				}
			}
			return nil
		})
	}
	found := map[string]bool{}
	for _, tok := range tokenPattern.FindAllString(haystack.String(), -1) {
		found[tok] = true
	}
	var lost []string
	for tok, who := range r.tokens {
		if !found[tok] {
			lost = append(lost, tok+" ("+who+")")
		}
	}
	sort.Strings(lost)
	if len(lost) > 0 {
		add("%d of %d edits are nowhere (not in a file, a conflict copy or history): %s", len(lost), len(r.tokens), strings.Join(lost[:min(len(lost), 8)], ", "))
	}
	r.t.Logf("checked: %d kept versions, %d merge inputs, %d conflict copies, %d files in the tree", kept, yours, conflicts, len(tree))
	return problems
}

// historyFor lists the objects kept for a path of the tree.
func historyFor(root, path string) []string {
	entries, err := os.ReadDir(filepath.Join(root, filepath.FromSlash(path)))
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out
}

// sharedManifestFull is the tree's manifest with each entry's written_at.
func (s *stack) sharedManifestFull(userID, project, tree string) (m struct {
	Seq   int64 `json:"seq"`
	Files []struct {
		Path      string `json:"path"`
		SHA256    string `json:"sha256"`
		WrittenAt string `json:"written_at"`
	} `json:"files"`
}) {
	data, err := os.ReadFile(filepath.Join(s.data, "users", userID, project, "hosts", tree, "manifest.json"))
	if err != nil {
		s.t.Fatal(err)
	}
	json.Unmarshal(data, &m)
	return m
}
