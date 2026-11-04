package syncer

// PEP 0009's three forms of a kept version, end to end through whole rounds against memStore: the pointer for an
// append, the zstd keyframe, the plain copy; the restore of each, byte for byte; the pin; a rewrite between the hash
// and the upload; and the pruner's anchors. The ruler is the bytes the test itself wrote: each version's content is kept
// here and compared with what comes back.

import (
	"bytes"
	"errors"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"folder-sync/internal/config"
	"folder-sync/internal/history"
	"folder-sync/internal/synclog"
)

// recorded is every version a world wrote, by id, with the bytes it had.
type recorded map[string][]byte

// note remembers the bytes of path as the manifest now lists them.
func (w *world) note(into recorded, path string) string {
	w.t.Helper()
	entry, ok := w.p.publishedEntry(path)
	if !ok {
		w.t.Fatalf("%s is not in the manifest", path)
	}
	id, err := history.VersionID(entry.WrittenAt, entry.SHA256)
	if err != nil {
		w.t.Fatal(err)
	}
	into[id] = append([]byte(nil), w.read(path)...)
	return id
}

// kinds is the form of every object kept for path, by version id.
func (w *world) kinds(path string) map[string]history.Kind {
	w.t.Helper()
	objects, err := w.p.versionObjects(testHost, path)
	if err != nil {
		w.t.Fatal(err)
	}
	out := map[string]history.Kind{}
	for _, v := range objects {
		out[v.Version] = v.Kind
	}
	return out
}

// fetch reads version id of path back the way a restore does.
func (w *world) fetch(path, id string) ([]byte, error) {
	w.t.Helper()
	dest := filepath.Join(w.t.TempDir(), "out")
	etag := ""
	if e, ok := w.p.publishedEntry(path); ok {
		etag = e.ObjectETag
	}
	if err := w.p.FetchVersion(w.t.Context(), testHost, path, id, dest, etag); err != nil {
		return nil, err
	}
	return os.ReadFile(dest)
}

func compressible(gen *rand.Rand, n int, at time.Time) []byte { return jsonlLines(gen, n, at) }

// TestEveryKeptFormRestoresByteIdentical: a pointer resting on a keyframe, a pointer resting on the live file, a
// keyframe, a plain copy, and the pin's keyframe: each comes back as exactly the bytes that version had.
func TestEveryKeptFormRestoresByteIdentical(t *testing.T) {
	t0 := time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC)
	w := newWorld(t, t0, nil)
	gen := rand.New(rand.NewSource(7))
	want := recorded{}
	const log = "events/day.jsonl"
	min := func(n int) time.Duration { return time.Duration(n) * time.Minute } //nolint

	w.write(log, compressible(gen, 20_000, w.clock))
	w.write("notes/small.txt", []byte("one\n"))
	w.push()
	v1 := w.note(want, log)
	small1 := w.note(want, "notes/small.txt")

	w.advance(min(10)) // v1 lived 10 min: kept; the new bytes are v1 and a tail, so a pointer
	w.appendTo(log, compressible(gen, 3_000, w.clock))
	w.write("notes/small.txt", []byte("two\n"))
	w.push()
	v2 := w.note(want, log)

	w.advance(min(10)) // a rewrite: v2 is kept, and as a zstd keyframe from the copy made when it was hashed
	w.write(log, compressible(gen, 20_000, w.clock))
	w.push()
	v3 := w.note(want, log)

	w.advance(min(10)) // v3 lived 10 min and is appended to: a pointer again, now resting on the live file
	w.appendTo(log, compressible(gen, 3_000, w.clock))
	w.push()
	v4 := w.note(want, log)

	kinds := w.kinds(log)
	if kinds[v1] != history.KindPrefix || kinds[v2] != history.KindZst || kinds[v3] != history.KindPrefix || len(kinds) != 3 {
		t.Fatalf("forms of %s: %v (want v1 prefix, v2 zst, v3 prefix)", log, kinds)
	}
	if small := w.kinds("notes/small.txt"); small[small1] != history.KindFull {
		t.Fatalf("a 4-byte file is not worth a keyframe: %v", small)
	}

	// the pin: v4 is replaced by a rewrite one minute later while v3's pointer rests on it, so v4 is kept whole though
	// the throttle would drop it
	w.advance(min(1))
	w.write(log, compressible(gen, 20_000, w.clock))
	w.push()
	w.note(want, log)
	kinds = w.kinds(log)
	if kinds[v4] != history.KindZst {
		t.Fatalf("the pin did not keep v4 as a keyframe: %v", kinds)
	}

	for _, id := range []string{v1, v2, v3, v4} {
		got, err := w.fetch(log, id)
		if err != nil || !bytes.Equal(got, want[id]) {
			t.Errorf("%s: %d bytes back, want %d: %v", id, len(got), len(want[id]), err)
		}
	}
	if got, err := w.fetch("notes/small.txt", small1); err != nil || !bytes.Equal(got, want[small1]) {
		t.Errorf("the plain copy: %q %v", got, err)
	}
	if _, err := w.fetch(log, "2026-11-04T09:00:00.000Z_0000000000000000"); !errors.Is(err, ErrVersionGone) {
		t.Errorf("a version that was never kept: %v", err)
	}

	// the listing shows every version with its own size, whatever its form
	versions, err := w.p.Versions(testHost, log)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range versions {
		if int(v.Size) != len(want[v.Version]) {
			t.Errorf("%s (%s) lists %d bytes, it had %d", v.Version, v.Kind, v.Size, len(want[v.Version]))
		}
	}
}

// TestAPointerNeverRestsOnBytesTheEngineDidNotUpload (PEP 0009 §1.4, §4.1, §4.3): the file is rewritten after the engine
// hashed it and before the bytes reach the bucket.
func TestAPointerNeverRestsOnBytesTheEngineDidNotUpload(t *testing.T) {
	const log = "events/day.jsonl"
	min := func(n int) time.Duration { return time.Duration(n) * time.Minute } //nolint
	setup := func(t *testing.T) (*world, recorded, string) {
		w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), nil)
		gen := rand.New(rand.NewSource(11))
		w.write(log, compressible(gen, 20_000, w.clock))
		w.push()
		want := recorded{}
		v1 := w.note(want, log)
		w.advance(min(10))
		w.appendTo(log, compressible(gen, 3_000, w.clock))
		return w, want, v1
	}

	t.Run("a native upload sends the bytes that were hashed", func(t *testing.T) {
		w, want, v1 := setup(t)
		appended := append([]byte(nil), w.read(log)...)
		rewritten := []byte("somebody rewrote the whole file at this moment\n")
		w.store.onPut = func(key string) {
			if key == w.liveKey(log) {
				w.write(log, rewritten) // the rewrite lands while the upload is in flight
			}
		}
		w.push()
		w.store.onPut = nil
		// the manifest lists the appended bytes: the sha256 that was hashed, whatever the disk holds now
		entry, _ := w.p.publishedEntry(log)
		v2, _ := history.VersionID(entry.WrittenAt, entry.SHA256)
		want[v2] = appended
		if live := w.store.get(w.liveKey(log)); !bytes.Equal(live, appended) {
			t.Fatalf("the object in the bucket is not the bytes that were hashed: %d bytes, want %d", len(live), len(appended))
		}
		if got, err := w.fetch(log, v1); err != nil || !bytes.Equal(got, want[v1]) {
			t.Fatalf("v1 through its pointer: %d bytes, %v", len(got), err)
		}
		// the next round sees the rewrite; v2 leaves inside the throttle's window while v1's pointer rests on it: the pin
		w.advance(30 * time.Second)
		w.push()
		if got, err := w.fetch(log, v1); err != nil || !bytes.Equal(got, want[v1]) {
			t.Fatalf("v1 after the rewrite: %d bytes, %v", len(got), err)
		}
		if got, err := w.fetch(log, v2); err != nil || !bytes.Equal(got, want[v2]) {
			t.Fatalf("v2 after the rewrite: %d bytes, %v", len(got), err)
		}
	})

	t.Run("an upload rclone makes may carry other bytes, so no pointer is written for it", func(t *testing.T) {
		w, want, v1 := setup(t)
		defer func(old int64) { maxNativeAppend = old }(maxNativeAppend)
		maxNativeAppend = 1 << 10 // too large for a native upload: rclone sends it, reading the file again after the hash
		rewritten := filepath.Join(t.TempDir(), "with")
		os.WriteFile(rewritten, []byte("rewritten between the hash and rclone's read\n"), 0o644)
		t.Setenv("FAKE_RCLONE_REWRITE_PATH", filepath.Join(w.folder, filepath.FromSlash(log)))
		t.Setenv("FAKE_RCLONE_REWRITE_WITH", rewritten)
		w.push()
		if live := string(w.store.get(w.liveKey(log))); !strings.HasPrefix(live, "rewritten between") {
			t.Fatalf("the fake rclone did not race the upload: %q", live)
		}
		if kind := w.kinds(log)[v1]; kind == history.KindPrefix || kind == "" {
			t.Fatalf("v1 was kept as %q: a pointer on bytes rclone uploaded", kind)
		}
		if got, err := w.fetch(log, v1); err != nil || !bytes.Equal(got, want[v1]) {
			t.Fatalf("v1 is lost: %d bytes, %v", len(got), err)
		}
	})
}

// TestTheLostStateMakesNothingDroppable (PEP 0009 §4.3, "with no record at all, nothing is dropped, as today"): without
// history.json the throttle has nothing to throttle with, so a rewrite keeps the version it replaces.
func TestTheLostStateMakesNothingDroppable(t *testing.T) {
	const log = "events/day.jsonl"
	w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), nil)
	gen := rand.New(rand.NewSource(3))
	want := recorded{}
	w.write(log, compressible(gen, 20_000, w.clock))
	w.push()
	v1 := w.note(want, log)
	w.advance(10 * time.Minute)
	w.appendTo(log, compressible(gen, 3_000, w.clock))
	w.push() // v1 is a pointer now
	v2 := w.note(want, log)
	os.Remove(w.p.statePath("history.json"))
	w.advance(time.Second)
	w.write(log, compressible(gen, 20_000, w.clock)) // a rewrite one second later: v2 lived 1 s
	w.push()
	for _, id := range []string{v1, v2} {
		if got, err := w.fetch(log, id); err != nil || !bytes.Equal(got, want[id]) {
			t.Errorf("%s: %d bytes, %v", id, len(got), err)
		}
	}
}

// TestPrunerKeepsAnchorsAndRestoreStillWorks: a pointer in one day, its keyframe in the next, a newer version after the
// keyframe in that day (so the schedule alone would drop the keyframe). After the prune the pointer still restores.
func TestPrunerKeepsAnchorsAndRestoreStillWorks(t *testing.T) {
	const log = "events/day.jsonl"
	w := newWorld(t, time.Date(2026, 11, 4, 22, 0, 0, 0, time.UTC), nil)
	gen := rand.New(rand.NewSource(5))
	want := recorded{}
	w.write(log, compressible(gen, 20_000, w.clock))
	w.push()
	v1 := w.note(want, log)
	w.advance(30 * time.Minute) // 22:30: v1 becomes a pointer (left 22:30, day 4)
	w.appendTo(log, compressible(gen, 3_000, w.clock))
	w.push()
	v2 := w.note(want, log)
	w.advance(3 * time.Hour) // 01:30 on the 5th: v2 is a keyframe (a rewrite follows)
	w.write(log, compressible(gen, 20_000, w.clock))
	w.push()
	v3 := w.note(want, log)
	w.advance(4 * time.Hour) // 05:30: v3 is kept too, and is newer than v2 in the same day
	w.write(log, compressible(gen, 20_000, w.clock))
	w.push()
	w.note(want, log)
	if kinds := w.kinds(log); kinds[v1] != history.KindPrefix || kinds[v2] != history.KindZst || kinds[v3] != history.KindZst {
		t.Fatalf("setup: %v", kinds)
	}

	w.advance(3 * 24 * time.Hour)
	var result Result
	if _, err := w.p.Prune(&result); err != nil {
		t.Fatal(err)
	}
	kinds := w.kinds(log)
	if _, ok := kinds[v2]; !ok {
		t.Fatalf("the keyframe v1's pointer rests on was pruned: %v", kinds)
	}
	if _, ok := kinds[v1]; !ok {
		t.Fatalf("the pointer (the newest of its day) was pruned: %v", kinds)
	}
	if _, ok := kinds[v3]; !ok {
		t.Fatalf("v3 (the newest of its day) was pruned: %v", kinds)
	}
	for _, id := range []string{v1, v2, v3} {
		if got, err := w.fetch(log, id); err != nil || !bytes.Equal(got, want[id]) {
			t.Errorf("%s after the prune: %d bytes, %v", id, len(got), err)
		}
	}
	for _, ev := range result.Events {
		if ev.Event == "history_lost" {
			t.Errorf("nothing was lost: %+v", ev)
		}
	}

	// 40 days on, everything is past keep_days; pointers go first, and none of it was lost
	w.advance(40 * 24 * time.Hour)
	deleted, err := w.p.Prune(&result)
	if err != nil || deleted == 0 {
		t.Fatalf("pruned %d: %v", deleted, err)
	}
	if left := w.store.keysUnder(worldRoot + "_history/"); len(left) != 0 {
		t.Errorf("left after 40 days: %v", left)
	}
}

// TestADanglingPointerIsDroppedAndReported: a pointer with no full object after it and no live file (an over-quota delete
// job, a purge, an object deleted outside folder-sync) has lost its bytes already; the pruner says so and removes it.
func TestADanglingPointerIsDroppedAndReported(t *testing.T) {
	w := newWorld(t, time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC), nil)
	id := "2026-11-04T11:40:00.000Z_ffffffffffffffff"
	sha := strings.Repeat("ff", 32)
	key := history.KeyOf(worldRoot, worldProject, testHost, "logs/gone.jsonl", id, history.KindPrefix, 2000)
	body := history.PrefixBody{Schema: history.PrefixSchema, Size: 2000, SHA256: sha}.Marshal()
	if _, err := w.p.S3.Put("bkt", key, body, "application/json", "*", ""); err != nil {
		t.Fatal(err)
	}
	w.advance(10 * time.Minute)
	var result Result
	if _, err := w.p.Prune(&result); err != nil {
		t.Fatal(err)
	}
	if got := w.store.keysUnder(worldRoot + "_history/"); len(got) != 0 {
		t.Errorf("the dangling pointer stays: %v", got)
	}
	var lost []synclog.Event
	for _, ev := range result.Events {
		if ev.Event == "history_lost" {
			lost = append(lost, ev)
		}
	}
	if len(lost) != 1 || lost[0].Level != "warn" || lost[0].Path != "logs/gone.jsonl" || lost[0].From != id {
		t.Fatalf("history_lost events: %+v", lost)
	}
}

// TestHistoryEveryIsTheFolders: a folder that asks for 30 s keeps what the default 5 minutes would throttle.
func TestHistoryEveryIsTheFolders(t *testing.T) {
	keptAfterBursts := func(every string) int {
		w := newWorld(t, time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC), func(c *config.Config) { c.HistoryEvery = every })
		w.write("a.md", []byte("v0\n"))
		w.push()
		for i := 1; i <= 10; i++ {
			w.advance(40 * time.Second) // each version lives 40 s: past 30 s, short of 5 minutes
			w.write("a.md", []byte(strings.Repeat("v", i)+"\n"))
			w.push()
		}
		return len(w.kinds("a.md"))
	}
	if every5, every30 := keptAfterBursts("5m"), keptAfterBursts("30s"); every5 >= every30 || every30 != 10 || every5 > 3 {
		t.Fatalf("versions kept: %d with 5m, %d with 30s", every5, every30)
	}
}
