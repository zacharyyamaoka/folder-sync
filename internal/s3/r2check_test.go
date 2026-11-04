package s3

// TestR2HistoryCalls is scripts/check-r2's third check, against a real bucket: the S3 calls version history makes
// (docs/peps/0007 §3.1), through this package's own client, where the stand-in cannot answer for R2 (it ignores
// x-amz-copy-source-if-match and If-None-Match, and lists a copy's LastModified as its source's). It runs only when
// scripts/check-r2 sets FOLDER_SYNC_CHECK_R2=1, writes only under _checks/<stamp>/, and deletes what it wrote.

import (
	"crypto/md5"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestR2HistoryCalls(t *testing.T) {
	if os.Getenv("FOLDER_SYNC_CHECK_R2") != "1" {
		t.Skip("scripts/check-r2 runs this against a real bucket")
	}
	endpoint := os.Getenv("FOLDER_SYNC_ENDPOINT")
	if endpoint == "" {
		endpoint = "https://" + os.Getenv("FOLDER_SYNC_ACCOUNT_ID") + ".r2.cloudflarestorage.com"
	}
	bucket := os.Getenv("FOLDER_SYNC_CHECK_BUCKET")
	region := os.Getenv("FOLDER_SYNC_REGION")
	if region == "" {
		region = "auto"
	}
	c := &Client{Endpoint: endpoint, Region: region, AccessKeyID: os.Getenv("FOLDER_SYNC_ACCESS_KEY_ID"),
		SecretAccessKey: os.Getenv("FOLDER_SYNC_SECRET_ACCESS_KEY"), SessionToken: os.Getenv("FOLDER_SYNC_SESSION_TOKEN")}
	base := os.Getenv("FOLDER_SYNC_CHECK_PREFIX") + "_checks/" + time.Now().UTC().Format("20060102T150405Z") + "-history/"
	src := base + "hosts/h/notes/a b.md"
	version := "2026-10-28T20:31:00.117Z_9f2c1a3b4c5d6e7f"
	listed := base + "_history/notes/a b.md/" + version
	unlisted := base + "_history/notes/a b.md/2026-10-28T20:31:01.000Z_unlisted"
	deeper := base + "_history/notes/a b.md/deeper/" + version
	request := base + "_requests/req.json"
	written := []string{src, listed, unlisted, deeper, request}
	t.Cleanup(func() {
		for _, key := range written {
			c.Delete(bucket, key)
		}
	})
	pass := func(format string, args ...any) { fmt.Printf("PASS  "+format+"\n", args...) }

	etag, err := c.Put(bucket, src, []byte("version 1\n"), "text/markdown", "", "")
	if err != nil {
		t.Fatalf("PUT the source: %v", err)
	}
	time.Sleep(1500 * time.Millisecond) // so the copy's LastModified is visibly later than the source's

	// 1. the conditional copy: the right ETag copies, a wrong one is 412 and writes nothing
	if err := c.Copy(bucket, src, listed, etag); err != nil {
		t.Errorf("FAIL  CopyObject with x-amz-copy-source-if-match on the current ETag: %v", err)
	} else {
		pass("CopyObject with x-amz-copy-source-if-match on the current ETag copies")
	}
	if err := c.Copy(bucket, src, unlisted, `"0123456789abcdef0123456789abcdef"`); !errors.Is(err, ErrPreconditionFailed) {
		t.Errorf("FAIL  CopyObject with a stale x-amz-copy-source-if-match must answer 412, got: %v", err)
	} else if _, err := c.HeadObject(bucket, unlisted); !errors.Is(err, ErrNotFound) {
		t.Errorf("FAIL  a refused conditional copy wrote its destination (HEAD: %v)", err)
	} else {
		pass("CopyObject with a stale x-amz-copy-source-if-match answers 412 and writes nothing")
	}
	got := filepath.Join(t.TempDir(), "copy")
	if err := c.GetToFile(bucket, listed, got); err != nil {
		t.Errorf("FAIL  GET the copy: %v", err)
	} else if data, _ := os.ReadFile(got); string(data) != "version 1\n" {
		t.Errorf("FAIL  the copy holds %q", data)
	} else {
		pass("the copy holds the source's exact bytes")
	}

	// 2. a listing: the copy's LastModified is when it was copied (left_at), versions are objects, deeper paths prefixes
	c.Put(bucket, deeper, []byte("deeper\n"), "", "", "")
	page, err := c.List(bucket, base+"_history/notes/a b.md/", "/")
	if err != nil {
		t.Fatalf("FAIL  a delimiter listing: %v", err)
	}
	all, _ := c.List(bucket, base+"hosts/", "")
	var copied, source time.Time
	for _, obj := range page.Objects {
		if obj.Key == listed {
			copied = obj.LastModified
		}
	}
	for _, obj := range all.Objects {
		if obj.Key == src {
			source = obj.LastModified
		}
	}
	switch {
	case len(page.Objects) != 1 || page.Objects[0].Key != listed || len(page.Prefixes) != 1 || page.Prefixes[0] != base+"_history/notes/a b.md/deeper/":
		t.Errorf("FAIL  the delimiter listing of a path's versions: objects %v, prefixes %v", page.Objects, page.Prefixes)
	default:
		pass("a delimiter listing shows a path's versions as objects (':' intact) and deeper paths as prefixes")
	}
	if copied.IsZero() || source.IsZero() || !copied.After(source.Add(time.Second)) {
		t.Errorf("FAIL  the copy's LastModified %s is not its copy time (the source's is %s): retention reads it as left_at", copied, source)
	} else {
		pass("the copy's LastModified is when it was copied (%s; the source's %s)", copied.Format(time.RFC3339Nano), source.Format(time.RFC3339Nano))
	}

	// 3. conditional PUTs as change records and restore requests use them
	reqETag, err := c.Put(bucket, request, []byte(`{"v":1}`), "application/json", "*", "")
	if err != nil {
		t.Errorf("FAIL  PutObject If-None-Match: * on a new key: %v", err)
	}
	if _, err := c.Put(bucket, request, []byte(`{"v":2}`), "application/json", "*", ""); !errors.Is(err, ErrPreconditionFailed) {
		t.Errorf("FAIL  PutObject If-None-Match: * on an existing key must answer 412, got: %v", err)
	} else {
		pass("PutObject If-None-Match: * creates once, then answers 412")
	}
	if _, err := c.Put(bucket, request, []byte(`{"v":3}`), "application/json", "", "0123456789abcdef0123456789abcdef"); !errors.Is(err, ErrPreconditionFailed) {
		t.Errorf("FAIL  PutObject If-Match on a stale ETag must answer 412, got: %v", err)
	} else if _, err := c.Put(bucket, request, []byte(`{"v":4}`), "application/json", "", strings.Trim(reqETag, `"`)); err != nil {
		t.Errorf("FAIL  PutObject If-Match on the current ETag: %v", err)
	} else {
		pass("PutObject If-Match writes only over the ETag it read (a request's outcome)")
	}

	// 4. a delete, and a delete of a deleted key
	if err := c.Delete(bucket, listed); err != nil {
		t.Errorf("FAIL  DeleteObject: %v", err)
	} else if err := c.Delete(bucket, listed); err != nil {
		t.Errorf("FAIL  DeleteObject of a deleted key: %v", err)
	} else {
		pass("DeleteObject, and again on the deleted key (a no-op)")
	}

	// 5. PEP 0009 (docs/peps/0009 §14, "what was not verified"): the engine's own upload of an append, and a pointer's reads
	log := base + "hosts/h/logs/events.jsonl"
	pointerKey := base + "_history/notes/e/" + version + ".1800.prefix"
	written = append(written, log, pointerKey)
	body := []byte(strings.Repeat("a line of the log, appended to all day\n", 50))
	sum := md5.Sum(body)
	put, err := c.PutFile(bucket, log, body, time.Unix(1730000000, 123456789))
	switch {
	case err != nil:
		t.Errorf("FAIL  a native PUT of an append: %v", err)
	case strings.Trim(put, `"`) != hex.EncodeToString(sum[:]):
		t.Errorf("FAIL  a single PUT's ETag %s is not the MD5 of its body %x: object_etag cannot be recorded from it", put, sum)
	default:
		pass("a native PUT answers the MD5 of its body as its ETag (the engine records it as object_etag)")
	}
	head := filepath.Join(t.TempDir(), "head")
	if err := c.GetRangeToFile(bucket, log, head, 0, 99, strings.Trim(put, `"`)); err != nil {
		t.Errorf("FAIL  a Range GET with If-Match on the current ETag: %v", err)
	} else if data, _ := os.ReadFile(head); string(data) != string(body[:100]) {
		t.Errorf("FAIL  the ranged read holds %q", data)
	} else {
		pass("a Range GET with If-Match on the current ETag returns exactly the bytes asked for")
	}
	if err := c.GetRangeToFile(bucket, log, head, 0, 99, "0123456789abcdef0123456789abcdef"); !errors.Is(err, ErrPreconditionFailed) {
		t.Errorf("FAIL  a Range GET with a stale If-Match must answer 412, got: %v", err)
	} else {
		pass("a Range GET with a stale If-Match answers 412 (a pointer on a rewritten live file is noticed)")
	}
	pointer := []byte(`{"schema":"folder-sync-prefix/1","size":1800,"sha256":"` + strings.Repeat("ab", 32) + `"}`)
	if _, err := c.Put(bucket, pointerKey, pointer, "application/json", "*", ""); err != nil {
		t.Errorf("FAIL  creating a pointer: %v", err)
	} else if _, err := c.Put(bucket, pointerKey, pointer, "application/json", "*", ""); !errors.Is(err, ErrPreconditionFailed) {
		t.Errorf("FAIL  a pointer is created once: the second PUT must answer 412, got: %v", err)
	} else if listing, err := c.List(bucket, base+"_history/notes/e/", "/"); err != nil || len(listing.Objects) != 1 || listing.Objects[0].Key != pointerKey || listing.Objects[0].Size != int64(len(pointer)) {
		t.Errorf("FAIL  a pointer's name lists as one object of its own size: %+v %v", listing.Objects, err)
	} else {
		pass("a pointer is created once, and lists under <version>.<size>.prefix at its own (small) size")
	}
}
