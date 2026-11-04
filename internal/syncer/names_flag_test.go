package syncer

// Every rclone copy the engine runs, up and down, must pass --no-unicode-normalization (exactNames). The e2e suite
// (e2e/names_test.go) proves the behaviour against the real rclone, but only where that is installed and only through a
// whole round; this holds the flag itself, so a refactor that drops it from either direction fails here, fast, and says which.
// WHY both directions: the push flag alone left the pull side open once already (a folder holding café as NFC and NFD
// pulled with rclone's default, which folds names to NFC, landed one of them with the other's bytes; mutation-tested
// in e2e: with the flag off the pull, TestNormalizationOneFileTwoSpellings and TestNormalizationRespelledFileKeepsItsBytes are red).

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"folder-sync/internal/manifest"
)

// copyCalls is the rclone `copy` calls recorded in log: pushes read upload.txt, pulls read fetch-<peer>.txt (round.go writeList).
func copyCalls(t *testing.T, log string) (pulls, pushes []string) {
	t.Helper()
	data, err := os.ReadFile(log)
	if err != nil {
		t.Fatalf("the fake rclone logged no calls: %v", err)
	}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		switch {
		case !strings.HasPrefix(line, "copy "):
		case strings.Contains(line, "fetch-"):
			pulls = append(pulls, line)
		case strings.Contains(line, "upload.txt"):
			pushes = append(pushes, line)
		}
	}
	return pulls, pushes
}

func TestEveryRcloneCopyKeepsNamesAsBytes(t *testing.T) {
	w := newWorld(t, time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC), nil)
	log := filepath.Join(t.TempDir(), "rclone-calls.log")
	t.Setenv(fakeRcloneArgsEnv, log)

	// the push: a file the engine uploads with `rclone copy <folder> <remote>`
	w.write("caf\u00e9.txt", []byte("NFC bytes\n"))
	w.advance(time.Second)
	w.push()

	// the pull: a peer's manifest names a file this machine does not have, so the engine runs `rclone copy <remote> <peer folder>`
	const peer = "0f1e2d3c-4b5a-4968-8776-655443322110"
	m := manifest.Manifest{Schema: manifest.Schema, Project: worldProject, HostID: peer, HostName: "bam-Air", Seq: 1, GeneratedAt: w.clock.UTC().Format(time.RFC3339Nano),
		Files: []manifest.Entry{{Path: "cafe\u0301.txt", Size: 10, MTime: manifest.FormatTime(w.clock), SHA256: strings.Repeat("a", 64), WrittenAt: manifest.FormatTime(w.clock)}}}
	w.store.store(worldRoot+worldProject+"/hosts/"+peer+"/"+manifest.FileName, manifest.Marshal(m))
	if err := w.p.savePeers(PeerState{Known: []string{peer}, ETags: map[string]string{}}); err != nil {
		t.Fatal(err)
	}
	var result Result
	if err := w.p.Pull(t.Context(), &result); err != nil {
		t.Fatalf("pull: %v", err)
	}

	pulls, pushes := copyCalls(t, log)
	if len(pushes) == 0 || len(pulls) == 0 {
		t.Fatalf("the round should have run one push copy and one pull copy, got %d and %d:\n%s", len(pushes), len(pulls), mustRead(t, log))
	}
	for _, line := range append(append([]string{}, pushes...), pulls...) {
		if !strings.Contains(line, " "+exactNames) {
			t.Errorf("an rclone copy without %s folds names to NFC and can drop or overwrite a file:\n  %s", exactNames, line)
		}
	}
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	data, _ := os.ReadFile(path)
	return string(data)
}
