package syncer

// What the engine learns from the one read of a changed file (docs/peps/0009 §4.1, §6): its sha256 and MD5, whether
// its bytes start with the old version's (an append), the bytes themselves when the engine will upload them, and a
// compressed copy kept for the day this version leaves. WHY one read: the file is read once to publish it, so the
// extra work is a hash of the old size's worth of bytes and one zstd pass, never a second read.

import (
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"

	"github.com/klauspost/compress/zstd"

	"folder-sync/internal/manifest"
)

// The limits are variables only so a test can lower them.
var (
	// maxNativeAppend is the largest file whose append the engine uploads itself (one native PUT of the bytes it
	// hashed); a larger one goes through rclone, and its old version is kept whole (PEP 0009 §4.1).
	maxNativeAppend int64 = 64 << 20
	// maxRoundBuffer is the most bytes held for native uploads in one round.
	maxRoundBuffer int64 = 256 << 20
	// maxShadowBytes is the largest file that gets a compressed copy.
	maxShadowBytes int64 = 64 << 20
)

const (
	// shadowWorthIt: a compressed copy is kept only when it is under this share of the file (PEP 0009 §6).
	shadowWorthIt = 0.9
	// zstdWindow bounds the encoder's window so the Worker's decoder (fzstd, 2^25) can read what it writes (§6).
	zstdWindow = 8 << 20
)

// hashed is what one read of a changed file found.
type hashed struct {
	SHA256, MD5 string
	Size        int64 // the bytes read: the size the sha256 and the MD5 belong to
	// Append: the bytes start with the old version's (the sha256 of their first old.Size bytes is old.SHA256) and are
	// longer.
	Append bool
	// Bytes are the file, kept for the engine's own upload when it is an append of up to maxNativeAppend and the
	// round's budget allows; nil otherwise.
	Bytes []byte
}

// shadowPath is where the compressed copy of the version with this sha256 lives.
func (p *Project) shadowPath(sha256 string) string {
	return filepath.Join(p.StateDir, "shadow", sha256+".zst")
}

// hashChange reads path once. old is the path's entry in the last manifest, nil for a new file. buffer says the round
// may hold this file's bytes for a native upload (the caller counts the budget).
func (p *Project) hashChange(path string, old *manifest.Entry, buffer bool) (hashed, error) {
	f, err := os.Open(path)
	if err != nil {
		return hashed{}, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return hashed{}, err
	}
	sum, md, prefix := sha256.New(), md5.New(), sha256.New()
	var oldSize int64
	if old != nil {
		oldSize = old.Size
	}
	size := info.Size()
	var held []byte
	if buffer && oldSize > 0 && size > oldSize && size <= maxNativeAppend {
		held = make([]byte, 0, size)
	}
	var shadow *shadowWriter
	if size > 0 && size <= maxShadowBytes {
		if shadow, err = p.newShadow(); err != nil {
			shadow = nil // a missing copy only means the plain CopyObject later
		}
	}
	defer func() {
		if shadow != nil {
			shadow.abort()
		}
	}()
	buf := make([]byte, 1<<20)
	var n int64
	for {
		read, rerr := f.Read(buf)
		if read > 0 {
			chunk := buf[:read]
			sum.Write(chunk)
			md.Write(chunk)
			if n < oldSize {
				head := min(int64(read), oldSize-n)
				prefix.Write(chunk[:head])
			}
			if held != nil {
				if n+int64(read) > maxNativeAppend {
					held = nil // it grew past the limit while it was read
				} else {
					held = append(held, chunk...)
				}
			}
			if shadow != nil {
				if n+int64(read) > maxShadowBytes || shadow.write(chunk) != nil {
					shadow.abort()
					shadow = nil
				}
			}
			n += int64(read)
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return hashed{}, rerr
		}
	}
	out := hashed{SHA256: hex.EncodeToString(sum.Sum(nil)), MD5: hex.EncodeToString(md.Sum(nil)), Size: n}
	if old != nil && oldSize > 0 && n > oldSize && hex.EncodeToString(prefix.Sum(nil)) == old.SHA256 {
		out.Append = true
		if held != nil && int64(len(held)) == n {
			out.Bytes = held
		}
	}
	if shadow != nil {
		s := shadow
		shadow = nil
		s.finish(p.shadowPath(out.SHA256), n)
	}
	return out, nil
}

// shadowWriter writes one compressed copy to a temporary file beside its final place.
type shadowWriter struct {
	file *os.File
	enc  *zstd.Encoder
}

func (p *Project) newShadow() (*shadowWriter, error) {
	dir := filepath.Join(p.StateDir, "shadow")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	file, err := os.CreateTemp(dir, "shadow-*.tmp")
	if err != nil {
		return nil, err
	}
	enc, err := zstd.NewWriter(file, zstd.WithEncoderLevel(zstd.SpeedDefault), zstd.WithWindowSize(zstdWindow),
		zstd.WithEncoderConcurrency(1), zstd.WithLowerEncoderMem(true))
	if err != nil {
		file.Close()
		os.Remove(file.Name())
		return nil, err
	}
	return &shadowWriter{file: file, enc: enc}, nil
}

func (s *shadowWriter) write(chunk []byte) error {
	_, err := s.enc.Write(chunk)
	return err
}

// abort drops the copy.
func (s *shadowWriter) abort() {
	s.enc.Close()
	s.file.Close()
	os.Remove(s.file.Name())
}

// finish keeps the copy at dest if it is worth it: under shadowWorthIt of the file's size.
func (s *shadowWriter) finish(dest string, original int64) {
	if err := s.enc.Close(); err != nil {
		s.file.Close()
		os.Remove(s.file.Name())
		return
	}
	info, err := s.file.Stat()
	s.file.Close()
	if err != nil || float64(info.Size()) >= shadowWorthIt*float64(original) {
		os.Remove(s.file.Name())
		return
	}
	if err := os.Rename(s.file.Name(), dest); err != nil {
		os.Remove(s.file.Name())
	}
}

// pruneShadows deletes every compressed copy whose version is not in entries: a copy lives while its version is the
// live one, and is dropped once it has left (PEP 0009 §6). A temporary file a crash left goes too.
func (p *Project) pruneShadows(entries []manifest.Entry) {
	dir := filepath.Join(p.StateDir, "shadow")
	listed, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	need := map[string]bool{}
	for _, e := range entries {
		need[e.SHA256+".zst"] = true
	}
	for _, entry := range listed {
		if !need[entry.Name()] {
			os.Remove(filepath.Join(dir, entry.Name()))
		}
	}
}
