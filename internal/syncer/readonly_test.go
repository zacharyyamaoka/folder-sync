package syncer

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"folder-sync/internal/config"
	"folder-sync/internal/creds"
	"folder-sync/internal/host"
	"folder-sync/internal/manifest"
)

// readOnlyProject is a project whose keys are read-only (over quota), with its published manifest at seq and a
// RemoteDelete that answers every job from answers and counts the calls.
func readOnlyProject(t *testing.T, seq int64, answers map[string]DeleteAnswer) (*Project, *int) {
	t.Helper()
	p := &Project{
		Config:   config.New("demo", "folder-sync"),
		Host:     host.Host{ID: hostID, Name: "box"},
		StateDir: t.TempDir(),
		Creds:    creds.Creds{ReadOnly: true, Reason: "over quota (test)"},
		Now:      time.Now,
	}
	m := manifest.Manifest{Schema: manifest.Schema, Project: "demo", HostID: hostID, HostName: "box", Seq: seq, GeneratedAt: "2026-10-27T12:00:00Z",
		Files: []manifest.Entry{{Path: "keep.md", Size: 1, MTime: "2026-10-27T12:00:00Z", SHA256: "0000000000000000000000000000000000000000000000000000000000000000", WrittenAt: "2026-10-27T12:00:00Z"}}}
	if err := manifest.Save(filepath.Join(p.StateDir, "manifest.json"), m); err != nil {
		t.Fatal(err)
	}
	calls := 0
	p.RemoteDelete = func(ctx context.Context, job string, fromSeq int64, paths []string) (DeleteAnswer, error) {
		calls++
		return answers[job], nil
	}
	return p, &calls
}

// Review r4 #4: job 3→4 committed, manifest 4 kept locally, then a restart before delete-job.json went (or a read-only
// reconcile adopted manifest 4 first). The replay's answer is manifest 4: right for the job, and already this
// machine's. It must retire the job, not fail it against the local seq + 1 forever.
func TestReplayOfAnAdoptedDeleteJobRetiresIt(t *testing.T) {
	m4 := manifest.Manifest{Schema: manifest.Schema, Project: "demo", HostID: hostID, HostName: "box", Seq: 4, GeneratedAt: "2026-10-27T12:00:01Z",
		Files: []manifest.Entry{{Path: "keep.md", Size: 1, MTime: "2026-10-27T12:00:00Z", SHA256: "0000000000000000000000000000000000000000000000000000000000000000", WrittenAt: "2026-10-27T12:00:00Z"}}}
	job := "6f9b2c1e-3d4a-4b5c-8d7e-9f0a1b2c3d4e"
	p, _ := readOnlyProject(t, 4, map[string]DeleteAnswer{job: {Seq: 4, Deleted: []string{"gone.md"}, Manifest: m4}})
	data, _ := json.Marshal(deleteJob{Job: job, FromSeq: 3, Paths: []string{"gone.md"}})
	jobPath := filepath.Join(p.StateDir, "delete-job.json")
	os.WriteFile(jobPath, data, 0o600)
	prev, err := p.ownManifest()
	if err != nil {
		t.Fatal(err)
	}
	var result Result
	if err := p.pushReadOnly(context.Background(), prev, nil, nil, &result); err != nil {
		t.Fatalf("a replay whose result is already this machine's must not fail: %v", err)
	}
	if _, err := os.Stat(jobPath); err == nil {
		t.Fatal("the job is still there: every later delete stays blocked behind it")
	}
	// and a delete after it goes, from seq 4
	m5 := m4
	m5.Seq, m5.Files = 5, nil
	p2, calls := readOnlyProject(t, 4, nil)
	p2.RemoteDelete = func(ctx context.Context, j string, fromSeq int64, paths []string) (DeleteAnswer, error) {
		*calls++
		if fromSeq != 4 {
			t.Fatalf("the next delete names seq %d, not 4", fromSeq)
		}
		return DeleteAnswer{Seq: 5, Deleted: paths, Manifest: m5}, nil
	}
	os.WriteFile(filepath.Join(p2.StateDir, "delete-job.json"), data, 0o600)
	prev2, _ := p2.ownManifest()
	if err := p2.pushReadOnly(context.Background(), prev2, nil, []string{"keep.md"}, &result); err != nil || *calls != 1 {
		t.Fatalf("after the retired job, the next delete: %v, %d calls", err, *calls)
	}
}

// The ordinary replay (the answer was lost before the machine kept it) is still checked against the job's own base.
func TestReplayOfALostAnswerIsCheckedAgainstTheJobsBase(t *testing.T) {
	m4 := manifest.Manifest{Schema: manifest.Schema, Project: "demo", HostID: hostID, HostName: "box", Seq: 4, GeneratedAt: "2026-10-27T12:00:01Z", Files: nil}
	job := "6f9b2c1e-3d4a-4b5c-8d7e-9f0a1b2c3d4f"
	p, calls := readOnlyProject(t, 3, map[string]DeleteAnswer{job: {Seq: 4, Deleted: []string{"keep.md"}, Manifest: m4}})
	data, _ := json.Marshal(deleteJob{Job: job, FromSeq: 3, Paths: []string{"keep.md"}})
	os.WriteFile(filepath.Join(p.StateDir, "delete-job.json"), data, 0o600)
	prev, _ := p.ownManifest()
	var result Result
	if err := p.pushReadOnly(context.Background(), prev, nil, nil, &result); err != nil || *calls != 1 {
		t.Fatalf("%v, %d calls", err, *calls)
	}
	if kept, _ := p.ownManifest(); kept.Seq != 4 {
		t.Fatalf("the answer's manifest is kept: seq %d", kept.Seq)
	}
}

// longPaths are n distinct paths of about 711 bytes (seven 99-byte segments), as in review r5 #3.
func longPaths(n int) []string {
	segment := strings.Repeat("s", 99)
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("%s/%s/%s/%s/%s/%s/%s/f%04d.md", segment, segment, segment, segment, segment, segment, segment, i)
	}
	return out
}

// deleteBodySize is the request body folder-sync's accounts client sends for one delete job.
func deleteBodySize(job string, fromSeq int64, paths []string) int {
	data, _ := json.Marshal(map[string]any{"job": job, "from_seq": fromSeq, "paths": paths})
	return len(data)
}

// Review r5 #3: 400 long paths are a 285 KB request, over the server's 256 KiB; every request must fit, by bytes as
// well as by count, and every path still goes.
func TestDeletesAreBatchedByBytesAsWellAsCount(t *testing.T) {
	paths := longPaths(400)
	p, _ := readOnlyProject(t, 3, nil)
	prev, _ := p.ownManifest()
	for _, path := range paths {
		prev.Files = append(prev.Files, manifest.Entry{Path: path, Size: 1, MTime: "2026-10-27T12:00:00Z", SHA256: strings.Repeat("0", 64), WrittenAt: "2026-10-27T12:00:00Z"})
	}
	prev.Sort()
	if err := manifest.Save(filepath.Join(p.StateDir, "manifest.json"), prev); err != nil {
		t.Fatal(err)
	}
	var sizes []int
	sent := 0
	current := prev
	p.RemoteDelete = func(ctx context.Context, job string, fromSeq int64, batch []string) (DeleteAnswer, error) {
		size := deleteBodySize(job, fromSeq, batch)
		sizes = append(sizes, size)
		if size > 256*1024 {
			return DeleteAnswer{}, fmt.Errorf("413 too_large: a delete is a list of paths, at most 256 KiB")
		}
		gone := map[string]bool{}
		for _, path := range batch {
			gone[path] = true
		}
		next := current
		next.Seq, next.Files = current.Seq+1, nil
		for _, e := range current.Files {
			if !gone[e.Path] {
				next.Files = append(next.Files, e)
			}
		}
		current = next
		sent += len(batch)
		return DeleteAnswer{Seq: next.Seq, Deleted: batch, Manifest: next}, nil
	}
	var result Result
	if err := p.pushReadOnly(context.Background(), prev, nil, paths, &result); err != nil {
		t.Fatalf("every batch must fit (sizes %v): %v", sizes, err)
	}
	for _, size := range sizes {
		if size > 256*1024 {
			t.Fatalf("a request of %d bytes (the review saw 285,669): %v", size, sizes)
		}
	}
	if sent != len(paths) {
		t.Fatalf("%d of %d paths deleted", sent, len(paths))
	}
}

// Review r5 #3: a job kept from before the byte limit (400 long paths) is refused 413 every time it is asked again; it
// must be split into jobs that fit, not retried unchanged for good.
func TestAKeptJobTooLargeIsSplit(t *testing.T) {
	paths := longPaths(400)
	p, _ := readOnlyProject(t, 3, nil)
	prev, _ := p.ownManifest()
	for _, path := range paths {
		prev.Files = append(prev.Files, manifest.Entry{Path: path, Size: 1, MTime: "2026-10-27T12:00:00Z", SHA256: strings.Repeat("0", 64), WrittenAt: "2026-10-27T12:00:00Z"})
	}
	prev.Sort()
	manifest.Save(filepath.Join(p.StateDir, "manifest.json"), prev)
	data, _ := json.Marshal(deleteJob{Job: "6f9b2c1e-3d4a-4b5c-8d7e-9f0a1b2c3d4e", FromSeq: 3, Paths: paths})
	jobPath := filepath.Join(p.StateDir, "delete-job.json")
	os.WriteFile(jobPath, data, 0o600)
	current := prev
	sent := 0
	p.RemoteDelete = func(ctx context.Context, job string, fromSeq int64, batch []string) (DeleteAnswer, error) {
		if deleteBodySize(job, fromSeq, batch) > 256*1024 {
			return DeleteAnswer{}, fmt.Errorf("%w: 413", ErrTooLarge)
		}
		gone := map[string]bool{}
		for _, path := range batch {
			gone[path] = true
		}
		next := current
		next.Seq, next.Files = current.Seq+1, nil
		for _, e := range current.Files {
			if !gone[e.Path] {
				next.Files = append(next.Files, e)
			}
		}
		current = next
		sent += len(batch)
		return DeleteAnswer{Seq: next.Seq, Deleted: batch, Manifest: next}, nil
	}
	var result Result
	if err := p.pushReadOnly(context.Background(), prev, nil, paths, &result); err != nil {
		t.Fatalf("a kept job refused as too large must be split: %v", err)
	}
	if sent != len(paths) {
		t.Fatalf("%d of %d paths deleted", sent, len(paths))
	}
	if _, err := os.Stat(jobPath); err == nil {
		t.Fatal("the job file is still there")
	}
}
