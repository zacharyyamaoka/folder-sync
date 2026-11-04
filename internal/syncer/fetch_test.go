package syncer

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestZstdFramesFixture: testdata/zstd/frames.json, the frames the engine writes as keyframes, decode (here with
// klauspost, in the Worker with fzstd) to exactly their plain bytes; a pointer's read of the start of a keyframe stops
// after the bytes it asks for; a frame that opens to another size is refused.
func TestZstdFramesFixture(t *testing.T) {
	_, here, _, _ := runtime.Caller(0)
	data, err := os.ReadFile(filepath.Join(filepath.Dir(here), "..", "..", "testdata", "zstd", "frames.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Frames []struct {
			Name        string `json:"name"`
			PlainSize   int64  `json:"plain_size"`
			PlainSHA256 string `json:"plain_sha256"`
			FrameB64    string `json:"frame_b64"`
		} `json:"frames"`
	}
	if err := json.Unmarshal(data, &doc); err != nil || len(doc.Frames) < 2 {
		t.Fatalf("%v (%d frames)", err, len(doc.Frames))
	}
	dir := t.TempDir()
	for _, f := range doc.Frames {
		frame, err := base64.StdEncoding.DecodeString(f.FrameB64)
		if err != nil {
			t.Fatal(err)
		}
		src, dest := filepath.Join(dir, "frame.zst"), filepath.Join(dir, "plain")
		os.WriteFile(src, frame, 0o600)
		if err := decodeFile(src, dest, -1, f.PlainSize, f.PlainSHA256[:16]); err != nil {
			t.Errorf("%s: %v", f.Name, err)
			continue
		}
		if got, _ := os.ReadFile(dest); fmt.Sprintf("%x", sha256.Sum256(got)) != f.PlainSHA256 {
			t.Errorf("%s: decoded to other bytes", f.Name)
		}
		if err := decodeFile(src, dest, 100, -1, ""); err != nil {
			t.Errorf("%s: the first 100 bytes: %v", f.Name, err)
		} else if got, _ := os.ReadFile(dest); len(got) != 100 {
			t.Errorf("%s: asked for 100 bytes, got %d", f.Name, len(got))
		}
		if err := decodeFile(src, dest, -1, f.PlainSize+1, ""); err == nil {
			t.Errorf("%s: a keyframe that opens to another size than its name says is accepted", f.Name)
		}
		if err := decodeFile(src, dest, -1, f.PlainSize, "0000000000000000"); err == nil {
			t.Errorf("%s: a keyframe whose bytes hash to another sha16 than its name is accepted", f.Name)
		}
	}
}
