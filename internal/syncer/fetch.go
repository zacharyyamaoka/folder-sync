package syncer

// Reading a kept version's bytes back, whatever form it is stored in (docs/peps/0009 §4.3): a whole copy is one GET; a
// zstd keyframe is one GET and a decode; a prefix pointer is one Range GET of the object it rests on (the oldest full
// object of the path after it, or the live file), decoded first when that is a keyframe. Whatever comes out is checked
// against the sha256 the pointer holds and the sha16 in the name, so a version is never handed back as bytes it is not.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"

	"github.com/klauspost/compress/zstd"

	"folder-sync/internal/history"
	"folder-sync/internal/s3"
)

var (
	// ErrVersionGone: the version is not in the listing (thinned out by the schedule, or past 30 days), or the bytes
	// its pointer rests on are gone.
	ErrVersionGone = errors.New("that version is gone from the history")
	// ErrVersionMismatch: the bytes read are not the ones the version's name (or its pointer) says.
	ErrVersionMismatch = errors.New("the stored bytes are not the version's")
)

// versionObjects lists every object under one path's history on host, in any form, oldest first (one delimiter listing).
func (p *Project) versionObjects(host, path string) ([]history.Version, error) {
	listed, err := p.Objects().List(p.Config.Bucket, history.PathPrefix(p.Root, p.Config.Project, host, path), "/")
	if err != nil {
		return nil, err
	}
	return parseVersions(listed.Objects), nil
}

// FetchVersion writes the bytes of version id of host's path to dest, whatever form the bucket holds it in. liveETag is
// the object_etag of the live file in host's manifest ("" when it has none): a pointer that rests on the live file reads
// it with If-Match, so a file rewritten since the listing is noticed, and the listing is read again once.
// ErrVersionGone and ErrVersionMismatch are its two refusals.
func (p *Project) FetchVersion(ctx context.Context, host, path, id, dest, liveETag string) error {
	for attempt := 0; ; attempt++ {
		objects, err := p.versionObjects(host, path)
		if err != nil {
			return err
		}
		var forms []history.Version
		for _, v := range objects {
			if v.Version == id {
				forms = append(forms, v)
			}
		}
		if len(forms) == 0 {
			return ErrVersionGone
		}
		sort.SliceStable(forms, func(i, j int) bool { return formOrder(forms[i].Kind) < formOrder(forms[j].Kind) })
		err = p.fetchForm(ctx, host, path, forms[0], objects, dest, liveETag)
		if errors.Is(err, s3.ErrPreconditionFailed) && attempt == 0 {
			// the live file moved on after the manifest this ETag came from; a pin has made a newer keyframe since
			liveETag = ""
			continue
		}
		return err
	}
}

func formOrder(k history.Kind) int {
	switch k {
	case history.KindPrefix:
		return 2
	case history.KindZst:
		return 1
	}
	return 0
}

func (p *Project) fetchForm(ctx context.Context, host, path string, v history.Version, objects []history.Version, dest, liveETag string) error {
	bucket := p.Config.Bucket
	notFound := func(err error) error {
		if errors.Is(err, s3.ErrNotFound) {
			return ErrVersionGone
		}
		return err
	}
	switch v.Kind {
	case history.KindZst:
		tmp := dest + ".zst"
		defer os.Remove(tmp)
		if err := notFound(p.Objects().GetToFile(bucket, v.Key, tmp)); err != nil {
			return err
		}
		return decodeFile(tmp, dest, -1, v.Size, v.SHA16)
	case history.KindPrefix:
		got, err := p.Objects().GetIfNoneMatch(bucket, v.Key, "")
		if err != nil {
			return err
		}
		if got.NotFound {
			return ErrVersionGone
		}
		body, err := history.ParsePrefixBody(got.Body)
		if err != nil {
			return fmt.Errorf("%w: %v", ErrVersionMismatch, err)
		}
		if body.Size != v.Size || body.SHA256[:16] != v.SHA16 {
			return fmt.Errorf("%w: the pointer says %d bytes of %s…, its name %d bytes of %s…", ErrVersionMismatch, body.Size, body.SHA256[:16], v.Size, v.SHA16)
		}
		anchor, rests := history.Anchor(objects, v.Version)
		switch {
		case !rests:
			// WHY If-Match: the live file is the only bytes that can move under a pointer
			err = p.Objects().GetRangeToFile(bucket, p.HostPrefix(host)+"/"+path, dest, 0, body.Size-1, liveETag)
		case anchor.Kind == history.KindZst:
			tmp := dest + ".zst"
			defer os.Remove(tmp)
			if err = p.Objects().GetToFile(bucket, anchor.Key, tmp); err == nil {
				err = decodeFile(tmp, dest, body.Size, -1, "")
			}
		default:
			err = p.Objects().GetRangeToFile(bucket, anchor.Key, dest, 0, body.Size-1, "")
		}
		if err != nil {
			return notFound(err)
		}
		sum, err := HashFile(dest)
		if err != nil {
			return err
		}
		if sum != body.SHA256 {
			return fmt.Errorf("%w: the %d bytes it rests on hash to %s…, not %s…", ErrVersionMismatch, body.Size, sum[:16], body.SHA256[:16])
		}
		return nil
	}
	if err := notFound(p.Objects().GetToFile(bucket, v.Key, dest)); err != nil {
		return err
	}
	if v.Unlisted {
		return nil
	}
	sum, err := HashFile(dest)
	if err != nil {
		return err
	}
	if sum[:16] != v.SHA16 {
		return fmt.Errorf("%w: its bytes hash to %s, not %s", ErrVersionMismatch, sum[:16], v.SHA16)
	}
	return nil
}

// decodeFile decompresses the zstd frame in src into dest: its first limit bytes (limit >= 0: a pointer reading the
// start of a keyframe), or all of it, which must be wantSize bytes and, when sha16 is set, hash to it.
func decodeFile(src, dest string, limit, wantSize int64, sha16 string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	dec, err := zstd.NewReader(in, zstd.WithDecoderMaxWindow(32<<20), zstd.WithDecoderConcurrency(1))
	if err != nil {
		return err
	}
	defer dec.Close()
	if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
		return err
	}
	out, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	var n int64
	if limit >= 0 {
		n, err = io.CopyN(out, dec, limit)
	} else {
		n, err = io.Copy(out, dec)
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(dest)
		return fmt.Errorf("%w: decoding: %v", ErrVersionMismatch, err)
	}
	if limit < 0 && n != wantSize {
		os.Remove(dest)
		return fmt.Errorf("%w: the keyframe opens to %d bytes, its name says %d", ErrVersionMismatch, n, wantSize)
	}
	if sha16 != "" {
		sum, err := HashFile(dest)
		if err != nil {
			return err
		}
		if sum[:16] != sha16 {
			os.Remove(dest)
			return fmt.Errorf("%w: its bytes hash to %s, not %s", ErrVersionMismatch, sum[:16], sha16)
		}
	}
	return nil
}
