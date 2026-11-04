package syncer

// PEP 0009 §9.3, the append workload: the fixture whose gate (A <= 0.1) is tested red first on the code before the
// PEP and green on the code with it. A is write amplification (the C - Write Amplification note): the bytes written
// into _history/ divided by the bytes the user changed. The bytes written come from the store's own listing, not from
// anything the engine counts.

import (
	"crypto/sha256"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"folder-sync/internal/history"
)

// jsonlLines is n bytes or a little more of event-shaped lines from the seeded generator: a timestamp, a kind, ids and
// a free-text field of random words, so a line is neither all alike nor random noise.
func jsonlLines(gen *rand.Rand, n int, at time.Time) []byte {
	words := []string{"claim", "remember", "status", "pass", "fail", "track", "leg", "brief", "gate", "sync", "bench", "history"}
	var b strings.Builder
	for b.Len() < n {
		var text strings.Builder
		for text.Len() < 700 {
			text.WriteString(words[gen.Intn(len(words))])
			text.WriteByte(' ')
		}
		fmt.Fprintf(&b, `{"t":%q,"kind":%q,"id":"%016x%016x","track":"%08x","text":%q}`+"\n",
			at.Add(time.Duration(gen.Intn(1000))*time.Millisecond).Format(time.RFC3339Nano), words[gen.Intn(len(words))], gen.Uint64(), gen.Uint64(), gen.Uint32(), text.String())
	}
	return []byte(b.String())
}

// TestAppendWorkload: a JSONL log that grows for an hour writes at most a tenth of the bytes it changes into history.
// The PEP's workload is 1.2 KB every 2 s on a 4 MiB log (1,800 rounds); FOLDER_SYNC_WORKLOAD_FULL=1 runs exactly that.
// WHY the default is the same hour at a third of the rounds (3.6 KB every 6 s, a 1 MiB log): a round costs two process
// starts of the fake rclone, and A does not depend on either (a pointer is 125 bytes whatever the log's size, and an
// hour keeps about twelve of them). On the code before PEP 0009 each 30 s burst kept a whole copy: A of 230 on the
// full workload, 52 on -short; with a pointer per 5 minutes it is 0.0005.
func TestAppendWorkload(t *testing.T) {
	rounds, base, step, tailBytes := 600, 1<<20, 6*time.Second, 3600
	if testing.Short() {
		rounds = 100
	}
	if os.Getenv("FOLDER_SYNC_WORKLOAD_FULL") != "" {
		rounds, base, step, tailBytes = 1800, 4<<20, 2*time.Second, 1200
	}
	w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), nil)
	gen := rand.New(rand.NewSource(20261104))
	const path = "events/2026-11-04.jsonl"
	w.write(path, jsonlLines(gen, base, w.clock))
	w.push()
	var changed int64
	for i := 0; i < rounds; i++ {
		w.advance(step)
		tail := jsonlLines(gen, tailBytes, w.clock)
		changed += int64(len(tail))
		w.appendTo(path, tail)
		w.push()
	}
	bytes, objects := w.store.bytesUnder(worldRoot + "_history/")
	a := float64(bytes) / float64(changed)
	t.Logf("%d rounds, %d bytes changed, %d bytes in %d history objects: A = %.4f", rounds, changed, bytes, objects, a)
	if a > 0.1 {
		t.Fatalf("write amplification A = %.4f, want <= 0.1", a)
	}
}

// TestThirtyDayStorageEfficiency: H = history bytes / live bytes stays at or under 1.0 across 31 simulated days of a
// Vibe Tracks-shaped folder (PEP 0009 §9.2: day logs that are appended to all day, one old day log rewritten each day,
// a bundle whose counters change every round, a markdown note edited twice a day), with the engine's own daily prune
// and every kept version restored byte-for-byte at the end. WHY it is scaled: 12 rounds a day instead of the recorded
// 761, and day logs of 1 MiB instead of 4.3, so it runs in seconds; H is a ratio, and the change records, whose number
// follows the round rate, are added back at the recorded 761 a day from the size the engine actually wrote (the quota
// counts _changes/ as history). The PEP's replay of the real day predicts 0.47-0.90 (replay30.py).
func TestThirtyDayStorageEfficiency(t *testing.T) {
	days := 31
	if testing.Short() {
		days = 9
	}
	start := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	w := newWorld(t, start, nil)
	gen := rand.New(rand.NewSource(20261101))
	day := func(i int) string { return "events/" + start.AddDate(0, 0, i).Format("2006-01-02") + ".jsonl" }
	sums := map[string]string{} // version id -> sha256 of the bytes the test wrote, per path
	type key struct{ path, id string }
	truth := map[key]string{}
	record := func(path string, content []byte) {
		entry, ok := w.p.publishedEntry(path)
		if !ok {
			t.Fatalf("%s: no manifest entry", path)
		}
		id, err := history.VersionID(entry.WrittenAt, entry.SHA256)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(content)
		if hex := fmt.Sprintf("%x", sum); hex != entry.SHA256 {
			t.Fatalf("%s: the engine listed %s, the bytes written hash to %s", path, entry.SHA256, hex)
		}
		truth[key{path, id}] = entry.SHA256
		sums[path] = id
	}
	bundle := func(round int) []byte {
		var b strings.Builder
		b.WriteString("{\n")
		for i := 0; i < 1200; i++ { // 1,200 settled keys: identical every round
			fmt.Fprintf(&b, "  \"track-%04d\": {\"state\": \"%s\", \"note\": \"%016x\"},\n", i, []string{"idle", "claimed", "passed"}[i%3], uint64(i)*0x9e3779b97f4a7c15)
		}
		fmt.Fprintf(&b, "  \"counters\": {\"rounds\": %d, \"claims\": %d, \"passes\": %d, \"fails\": %d}\n}\n", round, round*3, round*2, round/5)
		return []byte(b.String())
	}
	note := func(edits int) []byte {
		var b strings.Builder
		for i := 0; i < 400; i++ {
			fmt.Fprintf(&b, "Line %03d of the planning note, as long as the lines Zach writes down in a day.\n", i)
		}
		out := []byte(b.String())
		copy(out[len(out)/2:], fmt.Sprintf("[edit %04d]", edits))
		return out
	}

	var maxH, maxVersions float64
	var live, history_ int64
	var recordBytes, recordCount int64
	round, edits := 0, 0
	for d := 0; d < days; d++ {
		for slot := 0; slot < 12; slot++ {
			w.advance(2 * time.Hour)
			round++
			// today's log grows
			tail := jsonlLines(gen, 87_000, w.clock)
			if _, err := os.Stat(filepath.Join(w.folder, filepath.FromSlash(day(d)))); err != nil {
				w.write(day(d), tail)
			} else {
				w.appendTo(day(d), tail)
			}
			w.write("bundle.json", bundle(round))
			written := map[string][]byte{day(d): w.read(day(d)), "bundle.json": bundle(round)}
			if slot == 6 && d >= 2 { // an old day log is rewritten, lines out of order, as Vibe Tracks' are
				old := strings.Split(string(w.read(day(d-2))), "\n")
				i, j := len(old)/7, len(old)/3
				old[i], old[j] = old[j], old[i]
				content := []byte(strings.Join(old, "\n"))
				w.write(day(d-2), content)
				written[day(d-2)] = content
			}
			if slot%6 == 3 {
				edits++
				w.write("notes/plan.md", note(edits))
				written["notes/plan.md"] = note(edits)
			}
			w.push()
			for path, content := range written {
				record(path, content)
			}
			if err := w.p.FlushRecords(); err != nil {
				t.Fatal(err)
			}
		}
		// the peak is just before the prune (PEP 0009 §9.1)
		w.advance(time.Hour)
		live, _ = w.store.bytesUnder(worldRoot + project0(w) + "hosts/")
		hist, _ := w.store.bytesUnder(worldRoot + "_history/")
		records, count := w.store.bytesUnder(worldRoot + "_changes/")
		recordBytes, recordCount = records, int64(count)
		history_ = hist
		if h := float64(hist) / float64(live); h > maxVersions {
			maxVersions = h
		}
		if h := float64(hist+records) / float64(live); h > maxH {
			maxH = h
		}
		if _, err := w.p.Prune(nil); err != nil {
			t.Fatal(err)
		}
	}
	// the records at the recorded round rate: 761 manifest versions a day for 30 days, against the live bytes of the
	// recorded folder (108 MiB)
	perRecord := float64(recordBytes) / float64(recordCount)
	projected := perRecord * 761 * 30
	recordedLive := float64(108 << 20)
	t.Logf("%d days, %d rounds: live %.1f MiB, history %.1f MiB; H(versions) max %.3f, H(versions+records) max %.3f; a record is %.0f bytes, so at 761 a day they add %.3f of H against 108 MiB",
		days, round, float64(live)/(1<<20), float64(history_)/(1<<20), maxVersions, maxH, perRecord, projected/recordedLive)
	if maxVersions > 1.0 || maxH > 1.0 {
		t.Fatalf("H = %.3f (versions alone %.3f), want <= 1.0", maxH, maxVersions)
	}
	if total := maxVersions + projected/recordedLive; total > 1.0 {
		t.Fatalf("with the records at 761 rounds a day H would be %.3f, want <= 1.0", total)
	}

	// and every version that is still kept restores to exactly what it was
	checked := 0
	for path := range sums {
		versions, err := w.p.Versions(testHost, path)
		if err != nil {
			t.Fatal(err)
		}
		for _, v := range versions {
			want, known := truth[key{path, v.Version}]
			if !known {
				t.Errorf("%s %s: a kept version the test never wrote", path, v.Version)
				continue
			}
			got, err := w.fetch(path, v.Version)
			if err != nil {
				t.Errorf("%s %s (%s): %v", path, v.Version, v.Kind, err)
				continue
			}
			if sum := sha256.Sum256(got); fmt.Sprintf("%x", sum) != want {
				t.Errorf("%s %s (%s): restored bytes differ", path, v.Version, v.Kind)
			}
			checked++
		}
	}
	if checked < 50 {
		t.Errorf("only %d kept versions to restore", checked)
	}
	t.Logf("%d kept versions restored byte-identical", checked)
}

// project0 is the world's project prefix in the bucket.
func project0(w *world) string { return worldProject + "/" }
