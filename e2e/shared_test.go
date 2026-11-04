//go:build !windows

package e2e

// The shared tree (docs/peps/0010), end to end: the real accounts Worker (its Durable Object is the tree's one writer), the
// real folder-sync binary on two or three machines, and a browser. Each case of PEP 0010 §11 is a subtest, on its own project
// of one person, so one Worker start serves them all.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

func sha(data string) string {
	sum := sha256.Sum256([]byte(data))
	return hex.EncodeToString(sum[:])
}

// sharedFolder is one folder of one person on two machines, shared.
type sharedFolder struct {
	s    *stack
	br   *browser
	name string
	a, b *node
	tree string
}

var treeID = regexp.MustCompile(`the shared tree is ([0-9a-f-]{36})`)

// newFolder makes two machines of one person in a folder that is shared with the given private patterns. Machine A shares it;
// B joins and learns it at its first round.
func (s *stack) newFolder(br *browser, name string, private ...string) *sharedFolder {
	s.t.Helper()
	p := &sharedFolder{s: s, br: br, name: name}
	if _, made := s.pair[br]; !made {
		s.pair[br] = [2]*node{s.machine("bam-GPU", br), s.machine("bam-Air", br)}
	}
	// WHY the same two machines for every case: a machine is a HOME, a host id and a session, and signing one in is a device
	// grant; each case is its own project, in its own folder on them
	p.a, p.b = s.pair[br][0].inFolder(name+"-gpu"), s.pair[br][1].inFolder(name+"-air")
	p.a.init(name)
	args := []string{"share"}
	for _, pattern := range private {
		args = append(args, "--private", pattern)
	}
	out := p.a.must(args...)
	m := treeID.FindStringSubmatch(out)
	if m == nil {
		s.t.Fatalf("share printed no tree id:\n%s", out)
	}
	p.tree = m[1]
	p.b.init(name)
	return p
}

// settle runs rounds on the machines in turn until a whole pass changes nothing (at most eight).
func (p *sharedFolder) settle() {
	p.s.t.Helper()
	machines := []*node{p.a, p.b}
	var last string
	for pass := 0; pass < 8; pass++ {
		for _, n := range machines {
			n.must("sync", "--once", "--discover")
		}
		now := p.view()
		if now == last {
			return
		}
		last = now
	}
	p.s.t.Fatalf("the folder did not settle in eight passes:\n%s", last)
}

// view is every machine's folder and the bucket's tree, as one string, for "nothing changed".
func (p *sharedFolder) view() string {
	var b strings.Builder
	for _, n := range []*node{p.a, p.b} {
		files := n.folderFiles()
		for _, k := range sortedKeys(files) {
			fmt.Fprintf(&b, "%s %s %s\n", n.name, k, sha(files[k]))
		}
	}
	tree := p.s.treeOnDisk(p.br.userID, p.name, p.tree)
	for _, k := range sortedKeys(tree) {
		fmt.Fprintf(&b, "tree %s %s\n", k, sha(tree[k]))
	}
	return b.String()
}

// converged fails unless both machines' folders hold exactly the tree's files.
func (p *sharedFolder) converged() map[string]string {
	p.s.t.Helper()
	tree := p.s.treeOnDisk(p.br.userID, p.name, p.tree)
	for _, n := range []*node{p.a, p.b} {
		got := n.folderFiles()
		if len(got) != len(tree) {
			p.s.t.Fatalf("%s holds %v, the tree %v", n.name, sortedKeys(got), sortedKeys(tree))
		}
		for path, want := range tree {
			if got[path] != want {
				p.s.t.Fatalf("%s: %s differs from the tree:\n%q\n%q", n.name, path, got[path], want)
			}
		}
	}
	return tree
}

type versionList struct {
	Versions []struct {
		ID   string `json:"id"`
		Size int    `json:"size"`
	} `json:"versions"`
}

// versions lists a shared file's kept versions through the view API, and reads each one's bytes.
func (p *sharedFolder) versions(path string) map[string]string {
	p.s.t.Helper()
	status, data := p.br.json("GET", "/fs/v1/folders/"+p.name+"/history/"+p.tree+"/"+escapePath(path), nil)
	if status == 404 {
		return nil
	}
	if status != 200 {
		p.s.t.Fatalf("history of %s: %d %s", path, status, data)
	}
	var list versionList
	json.Unmarshal(data, &list)
	out := map[string]string{}
	for _, v := range list.Versions {
		status, body := p.br.json("GET", "/fs/v1/folders/"+p.name+"/history/"+p.tree+"/"+escapePath(path)+"?version="+url.QueryEscape(v.ID), nil)
		if status != 200 {
			p.s.t.Fatalf("version %s of %s: %d %s", v.ID, path, status, body)
		}
		out[v.ID] = string(body)
	}
	return out
}

func (p *sharedFolder) has(texts map[string]string, want string) bool {
	for _, got := range texts {
		if got == want {
			return true
		}
	}
	return false
}

func TestSharedTree(t *testing.T) {
	s := startStack(t)
	br := s.browser("maker@example.com")
	br.signIn()

	t.Run("two machines editing different files converge", func(t *testing.T) {
		p := s.newFolder(br, "converge")
		p.a.write("a.md", "from the GPU\n")
		p.b.write("notes/b.md", "from the Air\n")
		p.settle()
		tree := p.converged()
		if tree["a.md"] != "from the GPU\n" || tree["notes/b.md"] != "from the Air\n" || len(tree) != 2 {
			t.Fatalf("tree %v", tree)
		}
		// the folder itself, not read-only copies under hosts/
		if _, ok := p.b.read("hosts/" + p.tree + "/a.md"); ok {
			t.Fatal("the shared tree must land in the folder, not under hosts/")
		}
	})

	t.Run("the same text file edited on two machines merges three-way, and both inputs are in history", func(t *testing.T) {
		p := s.newFolder(br, "merge")
		p.a.write("notes/plan.md", "# Plan\n\n- one\n- two\n- three\n- four\n")
		p.settle()
		// offline: each edits a different line
		p.a.write("notes/plan.md", "# Plan\n\n- ONE\n- two\n- three\n- four\n")
		p.b.write("notes/plan.md", "# Plan\n\n- one\n- two\n- three\n- FOUR\n")
		p.a.sync()
		p.b.sync()
		p.settle()
		tree := p.converged()
		want := "# Plan\n\n- ONE\n- two\n- three\n- FOUR\n"
		if tree["notes/plan.md"] != want {
			t.Fatalf("merged file %q, want %q", tree["notes/plan.md"], want)
		}
		if len(tree) != 1 {
			t.Fatalf("no conflict copy expected: %v", sortedKeys(tree))
		}
		versions := p.versions("notes/plan.md")
		for _, input := range []string{"# Plan\n\n- ONE\n- two\n- three\n- four\n", "# Plan\n\n- one\n- two\n- three\n- FOUR\n"} {
			if !p.has(versions, input) {
				t.Errorf("both inputs of a merge are restorable; %q is not in %d versions", input, len(versions))
			}
		}
	})

	t.Run("the same line edited on two machines: the first change stays, the second is a conflict copy with the exact name", func(t *testing.T) {
		p := s.newFolder(br, "collide")
		p.a.write("notes/plan.md", "# Plan\n\n- one\n- two\n- three\n")
		p.settle()
		p.a.write("notes/plan.md", "# Plan\n\n- one\n- two (the GPU)\n- three\n")
		p.b.write("notes/plan.md", "# Plan\n\n- one\n- two (the Air)\n- three\n")
		p.a.sync() // first to reach the folder's object
		before := time.Now()
		out := p.b.sync()
		after := time.Now()
		p.settle()
		tree := p.converged()
		if tree["notes/plan.md"] != "# Plan\n\n- one\n- two (the GPU)\n- three\n" {
			t.Fatalf("the path keeps the first change: %q", tree["notes/plan.md"])
		}
		var copyPath string
		for path := range tree {
			if strings.Contains(path, "Conflicted copy") {
				copyPath = path
			}
		}
		minutes := map[string]bool{before.Format("200601021504"): true, after.Format("200601021504"): true}
		match := regexp.MustCompile(`^notes/plan \(Conflicted copy bam-Air (\d{12})\)\.md$`).FindStringSubmatch(copyPath)
		if match == nil || !minutes[match[1]] {
			t.Fatalf("the conflict copy is %q, want notes/plan (Conflicted copy bam-Air %s).md\n%s", copyPath, before.Format("200601021504"), out)
		}
		if tree[copyPath] != "# Plan\n\n- one\n- two (the Air)\n- three\n" {
			t.Fatalf("the copy holds %q, not what the Air wrote", tree[copyPath])
		}
		if strings.Contains(tree["notes/plan.md"], "<<<<<<<") {
			t.Fatal("no conflict markers are written into a file")
		}
		if !strings.Contains(out, "conflict") {
			t.Fatalf("the round says so:\n%s", out)
		}
		status := p.b.must("status")
		if !strings.Contains(status, "notes/plan.md") && !strings.Contains(status, "onflict") {
			t.Logf("status:\n%s", status)
		}
	})

	t.Run("a binary file edited on both machines gives one conflict copy, both sha256-identical to what each wrote", func(t *testing.T) {
		p := s.newFolder(br, "binary")
		png := func(n byte) []byte { return []byte{0x89, 'P', 'N', 'G', 0, 1, 2, n, 255, 254} }
		p.a.writeBytes("img/photo.png", png(1))
		p.settle()
		p.a.writeBytes("img/photo.png", png(2))
		p.b.writeBytes("img/photo.png", png(3))
		p.a.sync()
		p.b.sync()
		p.settle()
		tree := p.converged()
		var copies []string
		for path := range tree {
			if strings.Contains(path, "Conflicted copy") {
				copies = append(copies, path)
			}
		}
		if len(copies) != 1 || !regexp.MustCompile(`^img/photo \(Conflicted copy bam-Air \d{12}\)\.png$`).MatchString(copies[0]) {
			t.Fatalf("one conflict copy expected: %v", copies)
		}
		if sha(tree["img/photo.png"]) != sha(string(png(2))) || sha(tree[copies[0]]) != sha(string(png(3))) {
			t.Fatal("the path keeps the first change and the copy the second, byte for byte")
		}
	})

	t.Run("an edit against a delete: the edit survives, in both orders", func(t *testing.T) {
		p := s.newFolder(br, "deletes")
		p.a.write("keep.md", "so the folder is not empty\n")
		p.a.write("one.md", "one\n")
		p.a.write("two.md", "two\n")
		p.settle()
		// one.md: A deletes, B edits (B's edit arrives second)
		os.Remove(p.a.path("one.md"))
		p.b.write("one.md", "one, edited\n")
		// two.md: B edits and reaches the folder's object first, A deletes after
		p.b.write("two.md", "two, edited\n")
		p.b.sync()
		os.Remove(p.a.path("two.md"))
		p.a.sync()
		p.settle()
		tree := p.converged()
		if tree["one.md"] != "one, edited\n" || tree["two.md"] != "two, edited\n" {
			t.Fatalf("an edit beats a delete: %v", tree)
		}
	})

	t.Run("a rename moves the file for everyone", func(t *testing.T) {
		p := s.newFolder(br, "rename")
		p.a.write("keep.md", "k\n")
		p.a.write("old/name.md", "body\n")
		p.settle()
		if err := os.MkdirAll(filepath.Dir(p.a.path("new/place.md")), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(p.a.path("old/name.md"), p.a.path("new/place.md")); err != nil {
			t.Fatal(err)
		}
		p.settle()
		tree := p.converged()
		if _, old := tree["old/name.md"]; old || tree["new/place.md"] != "body\n" {
			t.Fatalf("tree %v", sortedKeys(tree))
		}
		if _, err := os.Stat(p.b.path("old")); err == nil {
			t.Fatal("the emptied folder is gone from the other machine")
		}
	})

	t.Run("an offline machine catches up and merges what happened meanwhile", func(t *testing.T) {
		p := s.newFolder(br, "offline")
		lines := func(edits map[int]string) string {
			var b strings.Builder
			for i := 0; i < 10; i++ {
				if text, ok := edits[i]; ok {
					b.WriteString(text + "\n")
				} else {
					fmt.Fprintf(&b, "line %d\n", i)
				}
			}
			return b.String()
		}
		p.a.write("todo.md", lines(nil))
		p.settle()
		// the Air is away: the GPU edits and syncs three times
		for _, edit := range []map[int]string{{0: "zero"}, {0: "zero", 4: "four"}, {0: "zero", 4: "four", 8: "eight"}} {
			p.a.write("todo.md", lines(edit))
			p.a.sync()
		}
		p.b.write("todo.md", lines(map[int]string{2: "two", 6: "six"}))
		p.settle()
		tree := p.converged()
		if want := lines(map[int]string{0: "zero", 2: "two", 4: "four", 6: "six", 8: "eight"}); tree["todo.md"] != want {
			t.Fatalf("got %q\nwant %q", tree["todo.md"], want)
		}
	})

	t.Run("two machines appending to one JSONL: both tails, no conflict copy", func(t *testing.T) {
		p := s.newFolder(br, "appends")
		p.a.write("logs/events.jsonl", "{\"n\":1}\n{\"n\":2}\n")
		p.settle()
		p.a.write("logs/events.jsonl", "{\"n\":1}\n{\"n\":2}\n{\"n\":\"gpu\"}\n")
		p.b.write("logs/events.jsonl", "{\"n\":1}\n{\"n\":2}\n{\"n\":\"air\"}\n")
		p.a.sync()
		p.b.sync()
		p.settle()
		tree := p.converged()
		if len(tree) != 1 {
			t.Fatalf("no conflict copy: %v", sortedKeys(tree))
		}
		got := tree["logs/events.jsonl"]
		if !strings.HasPrefix(got, "{\"n\":1}\n{\"n\":2}\n") || !strings.Contains(got, `{"n":"gpu"}`) || !strings.Contains(got, `{"n":"air"}`) || strings.Count(got, "\n") != 4 {
			t.Fatalf("both tails, once: %q", got)
		}
	})

	t.Run("private files stay on each machine's own host; everything else is the folder", func(t *testing.T) {
		p := s.newFolder(br, "private", "events/", "*.sqlite")
		p.a.write("note.md", "shared\n")
		p.a.write("events/day.jsonl", "{\"a\":1}\n")
		p.a.write("data/app.sqlite", "binary-ish")
		p.settle()
		if got, ok := p.b.read("note.md"); !ok || got != "shared\n" {
			t.Fatalf("the shared file lands in B's folder: %q %v", got, ok)
		}
		for _, private := range []string{"events/day.jsonl", "data/app.sqlite"} {
			if _, ok := p.b.read(private); ok {
				t.Fatalf("%s is private: it must not land at B's folder root", private)
			}
			if got, ok := p.b.read("hosts/" + p.a.hostID() + "/" + private); !ok || got == "" {
				t.Fatalf("%s is A's own host's file: B reads it read-only under hosts/<A>/", private)
			}
		}
		tree := s.treeOnDisk(br.userID, p.name, p.tree)
		if len(tree) != 1 || tree["note.md"] == "" {
			t.Fatalf("the tree holds only the shared file: %v", sortedKeys(tree))
		}
		m := s.sharedManifest(br.userID, p.name, p.tree)
		if strings.Join(m.Shared.Private, ",") != "events/,*.sqlite" {
			t.Fatalf("the rule is in the tree's manifest: %v", m.Shared.Private)
		}
	})

	t.Run("migration: files already published from a machine's own host move into the tree, and are not deletes", func(t *testing.T) {
		name := "migrate"
		a := s.machine("bam-GPU", br)
		a.init(name)
		for i := 0; i < 8; i++ {
			a.write(fmt.Sprintf("old/%d.md", i), fmt.Sprintf("old file %d\n", i))
		}
		a.sync() // host-only, as before sharing
		// a low max_delete: moving eight files must not trip it
		cfg, _ := os.ReadFile(a.path(".folder-sync.toml"))
		os.WriteFile(a.path(".folder-sync.toml"), []byte(strings.Replace(string(cfg), "max_delete = 50", "max_delete = 2", 1)), 0o644)
		shared := treeID.FindStringSubmatch(a.must("share"))
		if shared == nil {
			t.Fatal("share printed no tree id")
		}
		out := a.sync()
		if strings.Contains(out, "holding") {
			t.Fatalf("moving files is not a delete:\n%s", out)
		}
		tree := s.treeOnDisk(br.userID, name, shared[1])
		if len(tree) != 8 {
			t.Fatalf("the tree holds %d files", len(tree))
		}
		if own := s.sharedManifestOf(br.userID, name, a.hostID()); len(own) != 0 {
			t.Fatalf("the own host keeps no shared file: %v", own)
		}
		for i := 0; i < 8; i++ {
			if got, _ := a.read(fmt.Sprintf("old/%d.md", i)); got != fmt.Sprintf("old file %d\n", i) {
				t.Fatalf("file %d left the folder: %q", i, got)
			}
		}
		// the old versions stay in the host's history
		historyDir := filepath.Join(s.data, "users", br.userID, "_history", name, a.hostID(), "old")
		if entries, err := os.ReadDir(historyDir); err != nil || len(entries) != 8 {
			t.Fatalf("history of the moved files: %v %v", entries, err)
		}
	})

	t.Run("a machine that has not been upgraded reads the shared tree read-only under hosts/", func(t *testing.T) {
		p := s.newFolder(br, "older")
		p.a.write("notes/a.md", "shared text\n")
		p.settle()
		// the engine as it was before the shared tree: this checkout's base commit
		old := oldEngine(t)
		c := s.machine("old-laptop", br)
		c.bin = old
		c.init("older")
		c.must("sync", "--once", "--discover")
		got, ok := c.read("hosts/" + p.tree + "/notes/a.md")
		if !ok || got != "shared text\n" {
			t.Fatalf("the older engine reads the tree under hosts/<tree>/: %q %v", got, ok)
		}
		// it publishes its own files from its own host, and edits to the read-only copy never reach the tree
		c.write("mine.md", "from the old machine\n")
		c.write("hosts/"+p.tree+"/notes/a.md", "an edit to a read-only copy\n")
		c.must("sync", "--once")
		p.settle()
		tree := s.treeOnDisk(br.userID, p.name, p.tree)
		if tree["notes/a.md"] != "shared text\n" || len(tree) != 1 {
			t.Fatalf("the older engine must not write the tree: %v", tree)
		}
		if got, ok := p.a.read("hosts/" + c.hostID() + "/mine.md"); !ok || got != "from the old machine\n" {
			t.Fatalf("the new engines read the old one's files as any peer's: %q %v", got, ok)
		}
	})

	t.Run("a save storm: one machine saves a file 20 times, 50 ms apart, while the other pulls: no conflict copy", func(t *testing.T) {
		p := s.newFolder(br, "storm")
		p.a.write("storm.md", "first\n")
		p.settle()
		done := make(chan struct{})
		go func() {
			defer close(done)
			for i := 1; i <= 20; i++ {
				p.a.write("storm.md", fmt.Sprintf("save %d\n", i))
				time.Sleep(50 * time.Millisecond)
			}
		}()
		for running := true; running; {
			select {
			case <-done:
				running = false
			default:
			}
			a, b := make(chan struct{}), make(chan struct{})
			go func() { p.a.runNoFail("sync", "--once"); close(a) }()
			go func() { p.b.runNoFail("sync", "--once"); close(b) }()
			<-a
			<-b
		}
		p.settle()
		tree := p.converged()
		for path := range tree {
			if strings.Contains(path, "Conflicted") {
				t.Fatalf("a conflict copy in a save storm: %s", path)
			}
		}
		if tree["storm.md"] != "save 20\n" {
			t.Fatalf("final bytes %q", tree["storm.md"])
		}
	})

	t.Run("a machine killed in the middle of a commit loses nothing and the next round finishes it", func(t *testing.T) {
		p := s.newFolder(br, "killed")
		for i := 0; i < 30; i++ {
			p.a.write(fmt.Sprintf("many/%02d.md", i), fmt.Sprintf("file %d\n", i))
		}
		p.a.runKilled(700*time.Millisecond, "sync", "--once")
		p.settle()
		tree := p.converged()
		if len(tree) != 30 {
			t.Fatalf("the tree holds %d of 30 files", len(tree))
		}
		for i := 0; i < 30; i++ {
			if tree[fmt.Sprintf("many/%02d.md", i)] != fmt.Sprintf("file %d\n", i) {
				t.Fatalf("file %d", i)
			}
		}
	})

	t.Run("a page's write goes through the same commit and reaches the machines", func(t *testing.T) {
		p := s.newFolder(br, "page")
		p.a.write("doc.md", "line 1\nline 2\nline 3\nline 4\nline 5\n")
		p.settle()
		seen, _ := s.treeVersion(br.userID, "page", p.tree, "doc.md")
		status, data := br.do("PUT", "/fs/v1/folders/page/shared/doc.md", []byte("line 1\nline 2\nline 3\nline 4\nline FIVE\n"), map[string]string{"X-Folder-Sync-Base": seen})
		var first struct{ Outcome, Version string }
		json.Unmarshal(data, &first)
		if status != 200 || first.Outcome != "accepted" {
			t.Fatalf("page PUT from the current version: %d %s", status, data)
		}
		// a machine edits meanwhile; the page then saves again from the version it saw before
		p.a.write("doc.md", "line 1\nline 2\nline 3\nline 4\nline FIVE\nline SIX\n")
		p.a.sync()
		status, _ = br.do("PUT", "/fs/v1/folders/page/shared/doc.md", []byte("stale\n"), map[string]string{"X-Folder-Sync-Base": first.Version, "X-Folder-Sync-Merge": "never"})
		if status != 412 {
			t.Fatalf("a stale page edit with Merge: never: %d", status)
		}
		status, data = br.do("PUT", "/fs/v1/folders/page/shared/doc.md", []byte("line ONE\nline 2\nline 3\nline 4\nline FIVE\n"), map[string]string{"X-Folder-Sync-Base": first.Version})
		var second struct{ Outcome string }
		json.Unmarshal(data, &second)
		if status != 200 || second.Outcome != "merged" {
			t.Fatalf("a stale page edit merges by default: %d %s", status, data)
		}
		p.settle()
		tree := p.converged()
		if tree["doc.md"] != "line ONE\nline 2\nline 3\nline 4\nline FIVE\nline SIX\n" {
			t.Fatalf("both edits: %q", tree["doc.md"])
		}
	})
}

// runNoFail runs a sync and ignores its result: in a storm a round may find the folder busy.
func (n *node) runNoFail(args ...string) { n.run(args...) }

// sharedManifestOf is a plain host's file list, from the store's directory.
func (s *stack) sharedManifestOf(userID, project, host string) []string {
	data, err := os.ReadFile(filepath.Join(s.data, "users", userID, project, "hosts", host, "manifest.json"))
	if err != nil {
		s.t.Fatal(err)
	}
	var m struct{ Files []struct{ Path string } }
	json.Unmarshal(data, &m)
	var out []string
	for _, f := range m.Files {
		out = append(out, f.Path)
	}
	sort.Strings(out)
	return out
}
