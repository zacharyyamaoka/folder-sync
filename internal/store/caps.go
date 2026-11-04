package store

// What a store's S3 dialect can do, measured, and what the engine does when it cannot.
//
// The engine leans on four conditional calls (docs/peps/0007 §3.1, 0009 §4, docs/CONTRACT.md "Deletions and history"):
//   - create once: PUT with If-None-Match: *  (a history keyframe or pointer, a change record, a restore request)
//   - put if match: PUT with If-Match         (a restore request's outcome)
//   - copy if match: x-amz-copy-source-if-match (a whole copy of the version the manifest listed)
//   - get if match: ranged GET with If-Match  (a pointer that rests on the live file)
// AWS S3, R2 and MinIO honour all four; Google's S3 interoperability API and some other S3 clones ignore or reject some.
// WHY measure and not look the provider up: versions differ (S3 gained conditional writes in 2024, MinIO before that),
// and a header that is ignored is worse than one that is refused: the write goes through unconditionally and nothing says so.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"folder-sync/internal/s3"
)

// Capabilities is which conditional calls a store honours (refuses with 412 when the condition fails).
type Capabilities struct {
	CreateOnce  bool `json:"create_once"`
	PutIfMatch  bool `json:"put_if_match"`
	CopyIfMatch bool `json:"copy_if_match"`
	GetIfMatch  bool `json:"get_if_match"`
}

// AllCaps is a store that honours everything: R2 (today's default, trusted as before), AWS S3, MinIO, and a file store.
func AllCaps() Capabilities {
	return Capabilities{CreateOnce: true, PutIfMatch: true, CopyIfMatch: true, GetIfMatch: true}
}

// Capabilities of a file store: it checks every condition. Only create-once is atomic across processes (a hard link);
// the others are check-then-write, safe because their objects have one writer (see FileStore).
func (f *FileStore) Capabilities() Capabilities { return AllCaps() }

// ParseCaps reads "all", "none" or a comma list of create_once, put_if_match, copy_if_match, get_if_match
// (FOLDER_SYNC_STORE_CAPS: what a store is declared to honour, instead of probing it).
func ParseCaps(text string) (Capabilities, error) {
	var caps Capabilities
	switch strings.TrimSpace(text) {
	case "all":
		return AllCaps(), nil
	case "none":
		return caps, nil
	}
	for _, name := range strings.Split(text, ",") {
		switch strings.TrimSpace(name) {
		case "create_once":
			caps.CreateOnce = true
		case "put_if_match":
			caps.PutIfMatch = true
		case "copy_if_match":
			caps.CopyIfMatch = true
		case "get_if_match":
			caps.GetIfMatch = true
		default:
			return Capabilities{}, fmt.Errorf("store capabilities %q: use all, none, or a list of create_once, put_if_match, copy_if_match, get_if_match", text)
		}
	}
	return caps, nil
}

// Probe measures c against bucket by what it does, not by what it is called: it writes a scratch object under
// prefix+"_probe/", makes each conditional call fail on purpose, and deletes what it wrote. A call that is refused with
// a 412 is honoured; one that succeeds (the header was ignored) or errors otherwise (rejected, 501) is not. An error
// from the first write is returned: the store cannot be used at all.
func Probe(o Objects, bucket, prefix string) (Capabilities, error) {
	nonce := make([]byte, 8)
	rand.Read(nonce)
	key := prefix + "_probe/" + hex.EncodeToString(nonce)
	copyKey := key + ".copy"
	defer o.Delete(bucket, key)
	defer o.Delete(bucket, copyKey)
	wrong := `"00000000000000000000000000000000"`

	if _, err := o.Put(bucket, key, []byte("probe-a"), "", "*", ""); err != nil {
		if errors.Is(err, s3.ErrPreconditionFailed) {
			return Capabilities{}, fmt.Errorf("probe: the scratch key %s already exists", key)
		}
		// a store that rejects If-None-Match outright: write plainly to learn whether it can be used at all
		if _, err := o.Put(bucket, key, []byte("probe-a"), "", "", ""); err != nil {
			return Capabilities{}, fmt.Errorf("probe: cannot write under %q: %w", prefix, err)
		}
	}
	var caps Capabilities
	_, err := o.Put(bucket, key, []byte("probe-b"), "", "*", "")
	caps.CreateOnce = errors.Is(err, s3.ErrPreconditionFailed)
	etag, found, err := o.Head(bucket, key)
	if err != nil || !found {
		return Capabilities{}, fmt.Errorf("probe: cannot read back %s: %v", key, err)
	}
	_, err = o.Put(bucket, key, []byte("probe-c"), "", "", wrong)
	caps.PutIfMatch = errors.Is(err, s3.ErrPreconditionFailed)
	if etag, _, _ = o.Head(bucket, key); etag == "" {
		return Capabilities{}, fmt.Errorf("probe: cannot read back %s", key)
	}
	err = o.Copy(bucket, key, copyKey, wrong)
	caps.CopyIfMatch = errors.Is(err, s3.ErrPreconditionFailed)
	tmp, terr := os.CreateTemp("", "folder-sync-probe-*")
	if terr != nil {
		return Capabilities{}, terr
	}
	tmp.Close()
	defer os.Remove(tmp.Name())
	err = o.GetRangeToFile(bucket, key, tmp.Name(), 0, 0, wrong)
	caps.GetIfMatch = errors.Is(err, s3.ErrPreconditionFailed)
	return caps, nil
}

// Guard returns o with the conditions caps does not honour checked by the engine instead: a HEAD first, then the call
// without the header the store would ignore or reject. The check and the write are two requests, so another writer can
// slip between them; the objects these calls guard have one writer by design, and a copy's version is verified by sha256
// when it is read back. docs/STORAGE.md's table says what each store does.
func Guard(o Objects, caps Capabilities) Objects {
	if caps == AllCaps() {
		return o
	}
	return guarded{Objects: o, caps: caps}
}

type guarded struct {
	Objects
	caps Capabilities
}

func (g guarded) Put(bucket, key string, body []byte, contentType, ifNoneMatch, ifMatch string) (string, error) {
	if ifNoneMatch == "*" && !g.caps.CreateOnce {
		if _, found, err := g.Objects.Head(bucket, key); err != nil {
			return "", err
		} else if found {
			return "", fmt.Errorf("PUT %s: %w", key, s3.ErrPreconditionFailed)
		}
		ifNoneMatch = ""
	}
	if ifMatch != "" && !g.caps.PutIfMatch {
		if etag, found, err := g.Objects.Head(bucket, key); err != nil {
			return "", err
		} else if !found || !sameETag(etag, ifMatch) {
			return "", fmt.Errorf("PUT %s: %w", key, s3.ErrPreconditionFailed)
		}
		ifMatch = ""
	}
	return g.Objects.Put(bucket, key, body, contentType, ifNoneMatch, ifMatch)
}

func (g guarded) Copy(bucket, srcKey, dstKey, ifMatch string) error {
	if ifMatch != "" && !g.caps.CopyIfMatch {
		stat, err := g.Objects.HeadObject(bucket, srcKey)
		if err != nil {
			return err
		}
		if !sameETag(stat.ETag, ifMatch) {
			return fmt.Errorf("COPY %s: %w", srcKey, s3.ErrPreconditionFailed)
		}
		ifMatch = ""
	}
	return g.Objects.Copy(bucket, srcKey, dstKey, ifMatch)
}

func (g guarded) GetRangeToFile(bucket, key, path string, from, to int64, ifMatch string) error {
	if ifMatch != "" && !g.caps.GetIfMatch {
		etag, found, err := g.Objects.Head(bucket, key)
		if err != nil {
			return err
		}
		if !found {
			return fmt.Errorf("GET %s: %w", key, s3.ErrNotFound)
		}
		if !sameETag(etag, ifMatch) {
			return fmt.Errorf("GET %s: %w", key, s3.ErrPreconditionFailed)
		}
		ifMatch = ""
	}
	return g.Objects.GetRangeToFile(bucket, key, path, from, to, ifMatch)
}

// capsFile is store-caps.json in a project's state dir: the last probe, reused until the store URL changes.
type capsFile struct {
	Schema   string       `json:"schema"`
	Store    string       `json:"store"`
	ProbedAt string       `json:"probed_at"`
	Caps     Capabilities `json:"caps"`
}

// CapsSchema names store-caps.json.
const CapsSchema = "folder-sync-store-caps/1"

// LoadCaps reads a cached probe for store (the key is the store URL plus its endpoint); ok is false when there is none.
func LoadCaps(path, storeKey string) (Capabilities, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Capabilities{}, false
	}
	var file capsFile
	if json.Unmarshal(data, &file) != nil || file.Schema != CapsSchema || file.Store != storeKey {
		return Capabilities{}, false
	}
	return file.Caps, true
}

// SaveCaps caches a probe.
func SaveCaps(path, storeKey string, caps Capabilities) error {
	data, err := json.MarshalIndent(capsFile{Schema: CapsSchema, Store: storeKey, ProbedAt: time.Now().UTC().Format(time.RFC3339), Caps: caps}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
