package e2e

// Gates G2 and G12, through the public path only (`folder-sync history`, `restore`, `deleted`): what a person types, never the
// engine's packages, so the tests keep passing when PEP 0009 changes the kinds of object a kept version can be.
//
//	G2  Version history: any version kept in the last 30 days restores byte-identical, with a fake clock; edits 5 minutes
//	    apart are all kept; a deleted file restores for 30 days and not for 31.
//	G12 Trusted restore: a restore takes 5 seconds or less, on the stand-in.
//
// The fake clock: the pruner ages a kept version by its object's LastModified, which the stand-in takes from the
// X-Amz-Meta-Mtime of the PUT (w.put). So a test plants versions "left N days ago" and lets the real engine prune and restore.
//
// WHAT "5-minute resolution" is, in this contract (docs/CONTRACT.md "What is kept"; PEP 0009 raises the write-time throttle from
// 30 s to 5 min and leaves the pruner alone): when an edit is saved, the version it replaces is kept unless one was kept in the
// last 30 s (5 min under 0009); the pruner then thins what is older than an hour to one per UTC hour, and older than a day to one
// per UTC day. So every edit is restorable at 5-minute resolution for the last hour, and at hourly, then daily, resolution
// beyond. The subtest below pins that shape; whether the gate means 5 minutes all the way back is Zach's question (docs/GATES.md).

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"folder-sync/internal/history"
)

// historyJSON runs `folder-sync history <path> --json` (or `deleted --json`) and parses the versions it prints.
func historyJSON(t *testing.T, w *world, m *machine, args ...string) []history.Version {
	t.Helper()
	out := w.must(m, args...)
	start := strings.Index(out, "[")
	if start < 0 {
		t.Fatalf("folder-sync %s printed no JSON list:\n%s", strings.Join(args, " "), out)
	}
	var versions []history.Version
	if err := json.Unmarshal([]byte(out[start:]), &versions); err != nil {
		t.Fatalf("folder-sync %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return versions
}

func versionName(left time.Time, content string) string {
	return left.Add(-time.Minute).UTC().Format("2006-01-02T15:04:05.000Z") + "_" + sha16(content)
}

// duePrune makes the next `sync --once` prune this machine's history: never pruned, and a reconcile due (as TestHistory does).
func duePrune(t *testing.T, m *machine) {
	t.Helper()
	state := stateDir(t, m)
	os.Remove(filepath.Join(state, "prune.json"))
	var last map[string]any
	data, _ := os.ReadFile(filepath.Join(state, "last-sync.json"))
	json.Unmarshal(data, &last)
	last["last_reconcile"] = ""
	data, _ = json.Marshal(last)
	if err := os.WriteFile(filepath.Join(state, "last-sync.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestGateVersionHistory30Days(t *testing.T) {
	w, a, _ := historyWorld(t)
	idA := hostID(t, a)
	now := time.Now().UTC()

	writeFile(t, filepath.Join(a.folder, "notes", "aged.md"), "the live version\n", time.Time{})
	writeFile(t, filepath.Join(a.folder, "keep-alive.md"), "so the folder is never empty\n", time.Time{})
	w.must(a, "sync", "--once")

	// versions that left the folder at these ages, each the only one of its hour or day, so the schedule keeps every one
	type planted struct {
		age     time.Duration
		content string
		id      string
	}
	var versions []planted
	add := func(age time.Duration) {
		left := now.Add(-age)
		content := fmt.Sprintf("version that left %s ago\n", age)
		versions = append(versions, planted{age, content, versionName(left, content)})
	}
	for minutes := 5; minutes <= 55; minutes += 5 {
		add(time.Duration(minutes) * time.Minute) // the last hour, every 5 minutes
	}
	for hours := 2; hours <= 22; hours += 5 {
		add(time.Duration(hours)*time.Hour + 17*time.Minute) // yesterday and today, hour by hour
	}
	for days := 2; days <= 28; days += 3 {
		add(time.Duration(days)*24*time.Hour + 5*time.Hour + 3*time.Minute)
	}
	add(29*24*time.Hour + 23*time.Hour) // the last hour before the 30 days are up
	for _, v := range versions {
		w.put(t, "_history/"+project+"/"+idA+"/notes/aged.md/"+v.id, v.content, now.Add(-v.age))
	}
	// a file deleted 29 days 20 hours ago (restorable) and one 30 days 1 hour ago (gone)
	recent := now.Add(-(29*24 + 20) * time.Hour)
	expired := now.Add(-(30*24 + 1) * time.Hour)
	w.put(t, "_history/"+project+"/"+idA+"/gone/recent.md/"+versionName(recent, "recently deleted\n"), "recently deleted\n", recent)
	w.put(t, "_history/"+project+"/"+idA+"/gone/expired.md/"+versionName(expired, "long deleted\n"), "long deleted\n", expired)

	duePrune(t, a)
	w.must(a, "sync", "--once")

	t.Run("every version in the last 30 days is listed after the prune", func(t *testing.T) {
		listed := map[string]bool{}
		for _, v := range historyJSON(t, w, a, "history", "notes/aged.md", "--json") {
			listed[v.Version] = true
		}
		for _, v := range versions {
			if !listed[v.id] {
				t.Errorf("the version that left %s ago was pruned: it is within 30 days and alone in its hour or day", v.age)
			}
		}
	})

	t.Run("each tier's versions restore byte-identical", func(t *testing.T) {
		// the newest, the oldest, and one from each tier boundary: the last hour, yesterday, the last month
		for _, i := range []int{0, 5, 10, 11, 14, 15, 20, len(versions) - 1} {
			v := versions[i%len(versions)]
			writeFile(t, filepath.Join(a.folder, "notes", "aged.md"), "an edit made after the version was planted\n", time.Time{})
			out := w.must(a, "restore", "notes/aged.md", "--version", v.id)
			if got, _ := os.ReadFile(filepath.Join(a.folder, "notes", "aged.md")); string(got) != v.content {
				t.Errorf("restoring the version that left %s ago: disk holds %q, want %q\n%s", v.age, got, v.content, out)
			}
			if live, _ := w.object(project + "/hosts/" + idA + "/notes/aged.md"); live != v.content {
				t.Errorf("the restore of the version that left %s ago was not published: %q", v.age, live)
			}
		}
	})

	t.Run("a file deleted 29 days ago restores; one deleted 31 days ago is gone", func(t *testing.T) {
		deleted := map[string]bool{}
		for _, v := range historyJSON(t, w, a, "deleted", "--json") {
			deleted[v.Path] = true
		}
		if !deleted["gone/recent.md"] {
			t.Errorf("a file deleted 29 days 20 hours ago is not listed as deleted: %v", deleted)
		}
		if deleted["gone/expired.md"] {
			t.Errorf("a file deleted 30 days 1 hour ago is still listed")
		}
		w.must(a, "deleted", "--restore", "gone/")
		if got, _ := os.ReadFile(filepath.Join(a.folder, "gone", "recent.md")); string(got) != "recently deleted\n" {
			t.Errorf("deleted --restore put back %q", got)
		}
		if _, err := os.Stat(filepath.Join(a.folder, "gone", "expired.md")); err == nil {
			t.Error("a file deleted more than 30 days ago came back")
		}
	})

	t.Run("resolution: 5 minutes in the last hour, then one version per hour, then one per day", func(t *testing.T) {
		// five edits 5 minutes apart, two hours ago, all in one UTC clock hour: the schedule keeps the newest of them
		base := now.Truncate(time.Hour).Add(-3 * time.Hour)
		var ids []string
		for i := 0; i < 5; i++ {
			left := base.Add(time.Duration(i*5) * time.Minute)
			content := fmt.Sprintf("edit %d\n", i)
			id := versionName(left, content)
			ids = append(ids, id)
			w.put(t, "_history/"+project+"/"+idA+"/notes/resolution.md/"+id, content, left)
		}
		duePrune(t, a)
		w.must(a, "sync", "--once")
		var got []string
		for _, v := range historyJSON(t, w, a, "history", "notes/resolution.md", "--json") {
			got = append(got, v.Version)
		}
		sort.Strings(got)
		if len(got) != 1 || got[0] != ids[4] {
			t.Errorf("five edits 5 minutes apart in one clock hour, three hours ago: kept %v, want just the newest %s", got, ids[4])
		}
	})
}

// TestGateEditsFiveMinutesApartAreAllKept: the write-time half of "5-minute resolution". An edit that lived a while is kept, and
// a burst is thinned; edits 5 minutes apart are never thinned by the throttle (30 s today, 5 min under PEP 0009).
func TestGateEditsFiveMinutesApartAreAllKept(t *testing.T) {
	noHistory, err := history.NewMatcher([]string{"*.log"})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 11, 4, 9, 0, 0, 0, time.UTC)
	var lastKept time.Time
	for i := 0; i < 50; i++ {
		written := start.Add(time.Duration(i) * 5 * time.Minute)
		left := written.Add(5 * time.Minute) // each version lived 5 minutes
		keep, why := history.Keep(history.OpReplace, "notes/plan.md", written, left, lastKept, noHistory)
		if !keep {
			t.Fatalf("the edit saved %d times 5 minutes apart: save %d was dropped (%s)", i+1, i+1, why)
		}
		lastKept = left
	}
	// the other end of the dial: saves a second apart are a burst, and one version per burst is enough
	kept := 0
	lastKept = time.Time{}
	for i := 0; i < 60; i++ {
		written := start.Add(time.Duration(i) * time.Second)
		left := written.Add(time.Second)
		if keep, _ := history.Keep(history.OpReplace, "notes/plan.md", written, left, lastKept, noHistory); keep {
			kept++
			lastKept = left
		}
	}
	if kept > 3 {
		t.Errorf("60 saves in a minute kept %d versions; a burst keeps about one per throttle window", kept)
	}
}

// TestGateRestoreWithinFiveSeconds is G12: from the command to the bytes back on disk and published, 5 seconds at most, for
// a file of a size people keep (2 MB) with a long history. The stand-in is local, so this is the engine's own cost (starting,
// one listing, one GET, one publish); a real bucket adds its round trips, which the production probe measures.
func TestGateRestoreWithinFiveSeconds(t *testing.T) {
	w, a, _ := historyWorld(t)
	idA := hostID(t, a)
	now := time.Now().UTC()
	big := strings.Repeat("a line of a 2 MB document, long enough to matter\n", 50_000)[:2<<20]
	writeFile(t, filepath.Join(a.folder, "docs", "big.md"), big, time.Time{})
	writeFile(t, filepath.Join(a.folder, "keep-alive.md"), "x\n", time.Time{})
	w.must(a, "sync", "--once")
	var wanted string
	for i := 0; i < 60; i++ { // 60 kept versions, one per half hour back to a day and a half
		left := now.Add(-time.Duration(i+1) * 30 * time.Minute)
		content := fmt.Sprintf("%d\n%s", i, big[:1<<20])
		id := versionName(left, content)
		w.put(t, "_history/"+project+"/"+idA+"/docs/big.md/"+id, content, left)
		if i == 59 {
			wanted = id
		}
	}
	writeFile(t, filepath.Join(a.folder, "docs", "big.md"), "an edit made after\n", time.Time{})
	started := time.Now()
	w.must(a, "restore", "docs/big.md", "--version", wanted)
	took := time.Since(started)
	t.Logf("restore of a 1 MB version out of 60: %s", took)
	if got, _ := os.ReadFile(filepath.Join(a.folder, "docs", "big.md")); !strings.HasPrefix(string(got), "59\n") || len(got) != 1<<20+3 {
		t.Fatalf("the restored file is %d bytes starting %q", len(got), got[:min(len(got), 10)])
	}
	if took > 5*time.Second {
		t.Errorf("restore took %s, the gate allows 5 s", took)
	}

	// deleted files too: delete, then bring all of them back
	os.Remove(filepath.Join(a.folder, "docs", "big.md"))
	w.must(a, "sync", "--once")
	started = time.Now()
	w.must(a, "deleted", "--restore", "docs/")
	took = time.Since(started)
	t.Logf("deleted --restore of one file: %s", took)
	if took > 5*time.Second {
		t.Errorf("deleted --restore took %s, the gate allows 5 s", took)
	}
	if _, err := os.Stat(filepath.Join(a.folder, "docs", "big.md")); err != nil {
		t.Errorf("deleted --restore left no file: %v", err)
	}
}
