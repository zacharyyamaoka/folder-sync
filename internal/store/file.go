package store

import (
	"crypto/md5"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"folder-sync/internal/s3"
)

// FileStore answers Objects over a directory: a key is a path under Root. It is the file:// store, for tests, a NAS or a
// mounted disk; rclone's local backend moves the files, this answers the manifest, history and request calls.
//
// What it does, against S3's semantics:
//   - ETag is the quoted MD5 of the content (what S3 answers for a single-part upload), so object_etag in a manifest
//     means the same thing on every store.
//   - A write is a temp file renamed into place, so a reader never sees half an object.
//   - A create-once PUT (If-None-Match: *) is a hard link: atomic across processes.
//   - If-Match on a PUT, a COPY source or a ranged GET is checked, then acted on: not atomic. WHY accepted: the objects
//     these guard have one writer by design (a host writes its own files, a request's outcome is written by the host it
//     names), and the history copy's version is verified by sha256 afterwards. docs/STORAGE.md's capability table says so.
type FileStore struct {
	Root string
}

// NewFile returns the file store for spec (a file:// URL).
func NewFile(spec Spec) *FileStore { return &FileStore{Root: filepath.FromSlash(spec.Bucket)} }

const tmpDirName = ".folder-sync-tmp"

// Windows cannot hold these characters in a name; rclone's local backend stores them as the fullwidth look-alikes, and
// so does this, so a key written by either is read by both.
var (
	toDiskNames = strings.NewReplacer(":", "：", "<", "＜", ">", "＞", `"`, "＂", "*", "＊", "?", "？", "|", "｜")
	toKeyNames  = strings.NewReplacer("：", ":", "＜", "<", "＞", ">", "＂", `"`, "＊", "*", "？", "?", "｜", "|")
)

func diskName(key string) string {
	if runtime.GOOS == "windows" {
		return toDiskNames.Replace(key)
	}
	return key
}

func keyName(name string) string {
	if runtime.GOOS == "windows" {
		return toKeyNames.Replace(name)
	}
	return name
}

// path is the file for key. A key that could leave Root is refused.
func (f *FileStore) path(key string) (string, error) {
	if key == "" || strings.HasPrefix(key, "/") || strings.Contains(key, "\\") {
		return "", fmt.Errorf("file store: key %q", key)
	}
	for _, segment := range strings.Split(key, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return "", fmt.Errorf("file store: key %q has an empty or relative segment", key)
		}
	}
	return filepath.Join(f.Root, filepath.FromSlash(diskName(key))), nil
}

func (f *FileStore) HeadBucket(string) error {
	info, err := os.Stat(f.Root)
	if err != nil || !info.IsDir() {
		// WHY not created: an unmounted NAS is an absent directory, and creating it would sync onto the local disk under the mount point
		return fmt.Errorf("directory %q does not exist: create it, or mount the disk (folder-sync never creates a file store's directory)", f.Root)
	}
	return nil
}

func (f *FileStore) ListOne(bucket, prefix string) error { return f.HeadBucket(bucket) }

// etagOf is the quoted MD5 of the file. WHY a cache: List answers an ETag per object and hashing every listed file each
// time is the whole store's bytes; an unchanged (size, mtime) is the same content, except in the last two seconds, when
// a coarse filesystem clock cannot tell two writes apart.
var etagCache sync.Map // path -> cachedETag

type cachedETag struct {
	size  int64
	mtime time.Time
	etag  string
}

func etagOf(path string, info fs.FileInfo) (string, error) {
	if hit, ok := etagCache.Load(path); ok {
		c := hit.(cachedETag)
		if c.size == info.Size() && c.mtime.Equal(info.ModTime()) {
			return c.etag, nil
		}
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	sum := md5.New()
	if _, err := io.Copy(sum, file); err != nil {
		return "", err
	}
	etag := `"` + hex.EncodeToString(sum.Sum(nil)) + `"`
	if time.Since(info.ModTime()) > 2*time.Second {
		etagCache.Store(path, cachedETag{size: info.Size(), mtime: info.ModTime(), etag: etag})
	}
	return etag, nil
}

// stat answers a regular file's info, or s3.ErrNotFound.
func (f *FileStore) stat(key string) (string, fs.FileInfo, error) {
	path, err := f.path(key)
	if err != nil {
		return "", nil, err
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", nil, fmt.Errorf("%s: %w", key, s3.ErrNotFound)
	}
	return path, info, nil
}

func (f *FileStore) Head(bucket, key string) (string, bool, error) {
	path, info, err := f.stat(key)
	if errors.Is(err, s3.ErrNotFound) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	etag, err := etagOf(path, info)
	return etag, err == nil, err
}

func (f *FileStore) HeadObject(bucket, key string) (s3.Stat, error) {
	path, info, err := f.stat(key)
	if err != nil {
		return s3.Stat{}, err
	}
	etag, err := etagOf(path, info)
	if err != nil {
		return s3.Stat{}, err
	}
	return s3.Stat{ETag: etag, LastModified: info.ModTime().UTC().Truncate(time.Second), Size: info.Size()}, nil
}

func sameETag(a, b string) bool { return strings.Trim(a, `"`) == strings.Trim(b, `"`) }

func (f *FileStore) GetIfNoneMatch(bucket, key, etag string) (s3.GetResult, error) {
	path, info, err := f.stat(key)
	if errors.Is(err, s3.ErrNotFound) {
		return s3.GetResult{NotFound: true}, nil
	}
	if err != nil {
		return s3.GetResult{}, err
	}
	got, err := etagOf(path, info)
	if err != nil {
		return s3.GetResult{}, err
	}
	if etag != "" && sameETag(got, etag) {
		return s3.GetResult{NotModified: true, ETag: etag}, nil
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return s3.GetResult{}, err
	}
	return s3.GetResult{ETag: got, Body: body}, nil
}

// writeAtomic puts content in a temp file under Root and renames it to path (mtime is set before the rename, so no
// reader sees the object with another time). With createOnce the rename is a hard link that fails if path exists.
func (f *FileStore) writeAtomic(path string, write func(io.Writer) error, mtime time.Time, createOnce bool) error {
	tmpDir := filepath.Join(f.Root, tmpDirName)
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(tmpDir, "put-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := write(tmp); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chtimes(tmp.Name(), mtime, mtime); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if !createOnce {
		return os.Rename(tmp.Name(), path)
	}
	err = os.Link(tmp.Name(), path)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, fs.ErrExist):
		return fmt.Errorf("%s: %w", filepath.Base(path), s3.ErrPreconditionFailed)
	}
	// a filesystem without hard links (FAT, some NAS shares): create the name exclusively, then copy in
	dst, openErr := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if errors.Is(openErr, fs.ErrExist) {
		return fmt.Errorf("%s: %w", filepath.Base(path), s3.ErrPreconditionFailed)
	}
	if openErr != nil {
		return err
	}
	src, err := os.Open(tmp.Name())
	if err != nil {
		dst.Close()
		return err
	}
	defer src.Close()
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		os.Remove(path)
		return err
	}
	if err := dst.Close(); err != nil {
		return err
	}
	return os.Chtimes(path, mtime, mtime)
}

func (f *FileStore) Put(bucket, key string, body []byte, contentType, ifNoneMatch, ifMatch string) (string, error) {
	return f.put(key, body, ifNoneMatch, ifMatch, time.Now())
}

func (f *FileStore) PutFile(bucket, key string, body []byte, mtime time.Time) (string, error) {
	return f.put(key, body, "", "", mtime)
}

func (f *FileStore) put(key string, body []byte, ifNoneMatch, ifMatch string, mtime time.Time) (string, error) {
	path, err := f.path(key)
	if err != nil {
		return "", err
	}
	if ifNoneMatch != "" && ifNoneMatch != "*" {
		return "", fmt.Errorf("file store: If-None-Match %q: only * (create once) is supported", ifNoneMatch)
	}
	if ifMatch != "" {
		etag, found, err := f.Head("", key)
		if err != nil {
			return "", err
		}
		if !found || !sameETag(etag, ifMatch) {
			return "", fmt.Errorf("PUT %s: %w", key, s3.ErrPreconditionFailed)
		}
	}
	err = f.writeAtomic(path, func(w io.Writer) error { _, err := w.Write(body); return err }, mtime, ifNoneMatch == "*")
	if err != nil {
		return "", err
	}
	sum := md5.Sum(body)
	return `"` + hex.EncodeToString(sum[:]) + `"`, nil
}

func (f *FileStore) Copy(bucket, srcKey, dstKey, ifMatch string) error {
	src, info, err := f.stat(srcKey)
	if err != nil {
		return fmt.Errorf("COPY %s: %w", srcKey, err)
	}
	if ifMatch != "" {
		etag, err := etagOf(src, info)
		if err != nil {
			return err
		}
		if !sameETag(etag, ifMatch) {
			return fmt.Errorf("COPY %s: %w", srcKey, s3.ErrPreconditionFailed)
		}
	}
	dst, err := f.path(dstKey)
	if err != nil {
		return err
	}
	return f.writeAtomic(dst, func(w io.Writer) error {
		in, err := os.Open(src)
		if err != nil {
			return err
		}
		defer in.Close()
		_, err = io.Copy(w, in)
		return err
	}, time.Now(), false)
}

func (f *FileStore) Delete(bucket, key string) error {
	path, err := f.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

func (f *FileStore) List(bucket, prefix, delimiter string) (s3.ListResult, error) {
	var out s3.ListResult
	dir := f.Root
	if i := strings.LastIndex(prefix, "/"); i >= 0 {
		dir = filepath.Join(f.Root, filepath.FromSlash(diskName(prefix[:i])))
	}
	prefixes := map[string]bool{}
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		rel, _ := filepath.Rel(f.Root, path)
		key := keyName(filepath.ToSlash(rel))
		if d.IsDir() {
			if key == tmpDirName {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasPrefix(key, prefix) || !d.Type().IsRegular() {
			return nil
		}
		if delimiter != "" {
			if i := strings.Index(key[len(prefix):], delimiter); i >= 0 {
				prefixes[key[:len(prefix)+i+len(delimiter)]] = true
				return nil
			}
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		etag, err := etagOf(path, info)
		if err != nil {
			return nil
		}
		out.Objects = append(out.Objects, s3.Object{Key: key, LastModified: info.ModTime().UTC(), ETag: etag, Size: info.Size()})
		return nil
	})
	if err != nil {
		return out, fmt.Errorf("LIST %s: %w", prefix, err)
	}
	sort.Slice(out.Objects, func(i, j int) bool { return out.Objects[i].Key < out.Objects[j].Key })
	for p := range prefixes {
		out.Prefixes = append(out.Prefixes, p)
	}
	sort.Strings(out.Prefixes)
	return out, nil
}

func (f *FileStore) GetToFile(bucket, key, dest string) error {
	src, _, err := f.stat(key)
	if err != nil {
		return fmt.Errorf("GET %s: %w", key, err)
	}
	return copyRange(src, dest, 0, -1)
}

func (f *FileStore) GetRangeToFile(bucket, key, dest string, from, to int64, ifMatch string) error {
	src, info, err := f.stat(key)
	if err != nil {
		return fmt.Errorf("GET %s: %w", key, err)
	}
	if ifMatch != "" {
		etag, err := etagOf(src, info)
		if err != nil {
			return err
		}
		if !sameETag(etag, ifMatch) {
			return fmt.Errorf("GET %s: %w", key, s3.ErrPreconditionFailed)
		}
	}
	if to >= info.Size() {
		return fmt.Errorf("GET %s: the object is %d bytes, the range asked for bytes %d-%d", key, info.Size(), from, to)
	}
	return copyRange(src, dest, from, to-from+1)
}

// copyRange writes length bytes of src from offset (all of it when length < 0) to dest, created or truncated.
func copyRange(src, dest string, offset, length int64) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if _, err := in.Seek(offset, io.SeekStart); err != nil {
		return err
	}
	out, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	var reader io.Reader = in
	if length >= 0 {
		reader = io.LimitReader(in, length)
	}
	if _, err := io.Copy(out, reader); err != nil {
		out.Close()
		os.Remove(dest)
		return err
	}
	return out.Close()
}
