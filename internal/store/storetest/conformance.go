// Package storetest is what every store must do the same: a suite run against any store.Objects (a directory, MinIO,
// the R2 stand-in, AWS) and an in-memory S3 server whose preconditions can be switched off.
package storetest

import (
	"crypto/md5"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"folder-sync/internal/s3"
	"folder-sync/internal/store"
)

func etagOf(body string) string {
	sum := md5.Sum([]byte(body))
	return `"` + hex.EncodeToString(sum[:]) + `"`
}

// Run exercises o under prefix (a "dir/" the store may write: every key the suite makes starts with it). caps says
// which conditional calls the store honours: the suite asserts a refusal where caps promises one, and only the
// unconditional behaviour where it does not.
func Run(t *testing.T, o store.Objects, bucket, prefix string, caps store.Capabilities) {
	t.Helper()
	scratch := t.TempDir()
	must := func(what string, err error) {
		t.Helper()
		if err != nil {
			t.Fatalf("%s: %v", what, err)
		}
	}
	key := func(name string) string { return prefix + name }

	t.Run("put, head, get, list, delete", func(t *testing.T) {
		etag, err := o.Put(bucket, key("a/one.txt"), []byte("hello"), "text/plain", "", "")
		must("put", err)
		if etag != etagOf("hello") {
			t.Errorf("a single-part PUT answers the MD5 as its ETag: got %s, want %s", etag, etagOf("hello"))
		}
		head, found, err := o.Head(bucket, key("a/one.txt"))
		if err != nil || !found || head != etagOf("hello") {
			t.Errorf("Head = %q, %v, %v", head, found, err)
		}
		if _, found, err := o.Head(bucket, key("a/none.txt")); err != nil || found {
			t.Errorf("Head of a missing key: found=%v err=%v", found, err)
		}
		stat, err := o.HeadObject(bucket, key("a/one.txt"))
		if err != nil || stat.Size != 5 || stat.ETag != etagOf("hello") || time.Since(stat.LastModified) > time.Hour || time.Until(stat.LastModified) > time.Hour {
			t.Errorf("HeadObject = %+v, %v", stat, err)
		}
		if _, err := o.HeadObject(bucket, key("a/none.txt")); !errors.Is(err, s3.ErrNotFound) {
			t.Errorf("HeadObject of a missing key: %v", err)
		}
		got, err := o.GetIfNoneMatch(bucket, key("a/one.txt"), "")
		if err != nil || string(got.Body) != "hello" || got.ETag != etagOf("hello") {
			t.Errorf("GetIfNoneMatch = %+v, %v", got, err)
		}
		got, err = o.GetIfNoneMatch(bucket, key("a/one.txt"), etagOf("hello"))
		if err != nil || !got.NotModified {
			t.Errorf("GetIfNoneMatch with the current ETag should be not-modified: %+v, %v", got, err)
		}
		got, err = o.GetIfNoneMatch(bucket, key("a/one.txt"), `"0000"`)
		if err != nil || got.NotModified || string(got.Body) != "hello" {
			t.Errorf("GetIfNoneMatch with another ETag should fetch: %+v, %v", got, err)
		}
		if got, err := o.GetIfNoneMatch(bucket, key("a/none.txt"), ""); err != nil || !got.NotFound {
			t.Errorf("GetIfNoneMatch of a missing key: %+v, %v", got, err)
		}
		must("replace", func() error { _, err := o.Put(bucket, key("a/one.txt"), []byte("hello again"), "", "", ""); return err }())
		if got, _ := o.GetIfNoneMatch(bucket, key("a/one.txt"), ""); string(got.Body) != "hello again" {
			t.Errorf("an unconditional PUT replaces: %q", got.Body)
		}
		must("delete", o.Delete(bucket, key("a/one.txt")))
		must("delete again (a gone key is not an error)", o.Delete(bucket, key("a/one.txt")))
		if _, found, _ := o.Head(bucket, key("a/one.txt")); found {
			t.Error("deleted, but still there")
		}
	})

	t.Run("names are bytes", func(t *testing.T) {
		name := key("dir/ café:1 & 100%.txt")
		_, err := o.Put(bucket, name, []byte("odd"), "", "", "")
		must("put", err)
		listed, err := o.List(bucket, key("dir/"), "")
		must("list", err)
		if len(listed.Objects) != 1 || listed.Objects[0].Key != name {
			t.Errorf("listed %+v", listed.Objects)
		}
		dest := filepath.Join(scratch, "odd")
		must("get", o.GetToFile(bucket, name, dest))
		if data, _ := os.ReadFile(dest); string(data) != "odd" {
			t.Errorf("got %q", data)
		}
	})

	t.Run("list with and without a delimiter, in key order", func(t *testing.T) {
		for _, name := range []string{"l/b/2.txt", "l/b/1.txt", "l/a.txt", "l/c/d/3.txt"} {
			_, err := o.Put(bucket, key(name), []byte(name), "", "", "")
			must("put "+name, err)
		}
		flat, err := o.List(bucket, key("l/"), "")
		must("list", err)
		var keys []string
		for _, obj := range flat.Objects {
			keys = append(keys, strings.TrimPrefix(obj.Key, prefix))
			if obj.Size != int64(len(strings.TrimPrefix(obj.Key, prefix))) || obj.ETag == "" || obj.LastModified.IsZero() {
				t.Errorf("object %+v", obj)
			}
		}
		if got, want := strings.Join(keys, " "), "l/a.txt l/b/1.txt l/b/2.txt l/c/d/3.txt"; got != want {
			t.Errorf("flat listing %q, want %q", got, want)
		}
		grouped, err := o.List(bucket, key("l/"), "/")
		must("list /", err)
		var folders []string
		for _, p := range grouped.Prefixes {
			folders = append(folders, strings.TrimPrefix(p, prefix))
		}
		if len(grouped.Objects) != 1 || strings.TrimPrefix(grouped.Objects[0].Key, prefix) != "l/a.txt" || strings.Join(folders, " ") != "l/b/ l/c/" {
			t.Errorf("grouped listing: objects %+v prefixes %v", grouped.Objects, grouped.Prefixes)
		}
		none, err := o.List(bucket, key("nothing-here/"), "")
		if err != nil || len(none.Objects) != 0 {
			t.Errorf("an empty prefix lists nothing: %+v, %v", none, err)
		}
	})

	t.Run("ranged and whole reads into a file", func(t *testing.T) {
		body := "0123456789abcdef"
		_, err := o.Put(bucket, key("r/digits"), []byte(body), "", "", "")
		must("put", err)
		dest := filepath.Join(scratch, "range")
		must("range", o.GetRangeToFile(bucket, key("r/digits"), dest, 4, 9, ""))
		if data, _ := os.ReadFile(dest); string(data) != "456789" {
			t.Errorf("bytes 4-9 = %q", data)
		}
		must("range from the start with the current ETag", o.GetRangeToFile(bucket, key("r/digits"), dest, 0, 3, etagOf(body)))
		if data, _ := os.ReadFile(dest); string(data) != "0123" {
			t.Errorf("bytes 0-3 = %q", data)
		}
		whole := filepath.Join(scratch, "whole")
		must("whole", o.GetToFile(bucket, key("r/digits"), whole))
		if data, _ := os.ReadFile(whole); string(data) != body {
			t.Errorf("whole = %q", data)
		}
		if err := o.GetToFile(bucket, key("r/none"), filepath.Join(scratch, "none")); !errors.Is(err, s3.ErrNotFound) {
			t.Errorf("GET of a missing key: %v", err)
		}
		if err := o.GetRangeToFile(bucket, key("r/none"), filepath.Join(scratch, "none"), 0, 1, ""); !errors.Is(err, s3.ErrNotFound) {
			t.Errorf("ranged GET of a missing key: %v", err)
		}
	})

	t.Run("copy keeps the bytes and leaves the source", func(t *testing.T) {
		_, err := o.Put(bucket, key("c/src"), []byte("source bytes"), "", "", "")
		must("put", err)
		must("copy", o.Copy(bucket, key("c/src"), key("c/dst"), ""))
		must("copy with the current ETag", o.Copy(bucket, key("c/src"), key("c/dst2"), etagOf("source bytes")))
		for _, name := range []string{"c/src", "c/dst", "c/dst2"} {
			if got, _ := o.GetIfNoneMatch(bucket, key(name), ""); string(got.Body) != "source bytes" {
				t.Errorf("%s = %q", name, got.Body)
			}
		}
		if err := o.Copy(bucket, key("c/none"), key("c/x"), ""); !errors.Is(err, s3.ErrNotFound) {
			t.Errorf("COPY of a missing source: %v", err)
		}
	})

	if caps.CreateOnce {
		t.Run("create once: a second PUT with If-None-Match * is refused and changes nothing", func(t *testing.T) {
			_, err := o.Put(bucket, key("o/once"), []byte("first"), "", "*", "")
			must("first", err)
			if _, err := o.Put(bucket, key("o/once"), []byte("second"), "", "*", ""); !errors.Is(err, s3.ErrPreconditionFailed) {
				t.Errorf("second create-once PUT: %v", err)
			}
			if got, _ := o.GetIfNoneMatch(bucket, key("o/once"), ""); string(got.Body) != "first" {
				t.Errorf("the object is %q", got.Body)
			}
		})
	}
	if caps.PutIfMatch {
		t.Run("PUT with If-Match: the right ETag replaces, a wrong one is refused", func(t *testing.T) {
			etag, err := o.Put(bucket, key("m/doc"), []byte("v1"), "", "", "")
			must("v1", err)
			if _, err := o.Put(bucket, key("m/doc"), []byte("v-wrong"), "", "", `"00000000000000000000000000000000"`); !errors.Is(err, s3.ErrPreconditionFailed) {
				t.Errorf("PUT with a wrong If-Match: %v", err)
			}
			if _, err := o.Put(bucket, key("m/doc"), []byte("v2"), "", "", etag); err != nil {
				t.Errorf("PUT with the right If-Match: %v", err)
			}
			if got, _ := o.GetIfNoneMatch(bucket, key("m/doc"), ""); string(got.Body) != "v2" {
				t.Errorf("the object is %q", got.Body)
			}
		})
	}
	if caps.CopyIfMatch {
		t.Run("COPY with a source ETag that is not the object is refused and writes nothing", func(t *testing.T) {
			_, err := o.Put(bucket, key("x/src"), []byte("now"), "", "", "")
			must("put", err)
			if err := o.Copy(bucket, key("x/src"), key("x/dst"), `"00000000000000000000000000000000"`); !errors.Is(err, s3.ErrPreconditionFailed) {
				t.Errorf("COPY with a wrong ETag: %v", err)
			}
			if _, found, _ := o.Head(bucket, key("x/dst")); found {
				t.Error("a refused COPY wrote the destination")
			}
		})
	}
	if caps.GetIfMatch {
		t.Run("ranged GET with a wrong If-Match is refused", func(t *testing.T) {
			_, err := o.Put(bucket, key("g/doc"), []byte("0123456789"), "", "", "")
			must("put", err)
			err = o.GetRangeToFile(bucket, key("g/doc"), filepath.Join(scratch, "g"), 0, 3, `"00000000000000000000000000000000"`)
			if !errors.Is(err, s3.ErrPreconditionFailed) {
				t.Errorf("ranged GET with a wrong If-Match: %v", err)
			}
		})
	}
	// leave nothing under the prefix: the suite runs against real buckets too
	listed, err := o.List(bucket, prefix, "")
	if err == nil {
		for _, obj := range listed.Objects {
			o.Delete(bucket, obj.Key)
		}
	}
}
