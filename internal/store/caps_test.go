package store_test

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"folder-sync/internal/s3"
	"folder-sync/internal/store"
	"folder-sync/internal/store/storetest"
)

func client(url string) *s3.Client {
	return &s3.Client{Endpoint: url, Region: "us-east-1", AccessKeyID: "key", SecretAccessKey: "secret"}
}

// A store that honours every conditional header measures as one, and the S3 client passes the shared suite on it.
func TestProbeFullySupportingStore(t *testing.T) {
	fake := &storetest.FakeS3{}
	c := client(fake.Start(t))
	caps, err := store.Probe(c, "bkt", "")
	if err != nil {
		t.Fatal(err)
	}
	if caps != store.AllCaps() {
		t.Fatalf("caps = %+v, want all", caps)
	}
	if keys := fake.Keys(); len(keys) != 0 {
		t.Errorf("the probe left %v behind", keys)
	}
	storetest.Run(t, c, "bkt", "suite/", caps)
}

func TestProbeFindsEachMissingFeature(t *testing.T) {
	cases := []struct {
		name string
		set  func(*storetest.FakeS3)
		want store.Capabilities
	}{
		{"ignores create-once", func(f *storetest.FakeS3) { f.IgnoreCreateOnce = true }, store.Capabilities{PutIfMatch: true, CopyIfMatch: true, GetIfMatch: true}},
		{"ignores put if-match", func(f *storetest.FakeS3) { f.IgnorePutIfMatch = true }, store.Capabilities{CreateOnce: true, CopyIfMatch: true, GetIfMatch: true}},
		{"ignores copy-source-if-match", func(f *storetest.FakeS3) { f.IgnoreCopyIfMatch = true }, store.Capabilities{CreateOnce: true, PutIfMatch: true, GetIfMatch: true}},
		{"ignores get if-match", func(f *storetest.FakeS3) { f.IgnoreGetIfMatch = true }, store.Capabilities{CreateOnce: true, PutIfMatch: true, CopyIfMatch: true}},
		{"rejects every conditional with 501", func(f *storetest.FakeS3) { f.RejectConditionals = true }, store.Capabilities{}},
		{"ignores all four", func(f *storetest.FakeS3) {
			f.IgnoreCreateOnce, f.IgnorePutIfMatch, f.IgnoreCopyIfMatch, f.IgnoreGetIfMatch = true, true, true, true
		}, store.Capabilities{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			fake := &storetest.FakeS3{}
			c.set(fake)
			caps, err := store.Probe(client(fake.Start(t)), "bkt", "users/x/")
			if err != nil {
				t.Fatal(err)
			}
			if caps != c.want {
				t.Errorf("caps = %+v, want %+v", caps, c.want)
			}
			if keys := fake.Keys(); len(keys) != 0 {
				t.Errorf("the probe left %v behind", keys)
			}
		})
	}
}

func TestProbeFailsWhenTheStoreCannotBeWritten(t *testing.T) {
	if _, err := store.Probe(client("http://127.0.0.1:1"), "bkt", ""); err == nil {
		t.Fatal("probing an unreachable store succeeded")
	}
}

// The guard gives a store without a feature the same answers by checking first, and never sends the header the
// store would ignore or reject.
func TestGuardFallsBackSafelyWhenAFeatureIsMissing(t *testing.T) {
	fake := &storetest.FakeS3{IgnoreCreateOnce: true, IgnorePutIfMatch: true, IgnoreCopyIfMatch: true, IgnoreGetIfMatch: true, RejectConditionals: false}
	c := client(fake.Start(t))
	guarded := store.Guard(c, store.Capabilities{})
	storetest.Run(t, guarded, "bkt", "suite/", store.AllCaps())
	// the guard never sends a header the store would ignore: no write carries a condition, no ranged read an If-Match
	for _, conditional := range []string{"If-None-Match", "If-Match", "X-Amz-Copy-Source-If-Match"} {
		if n := fake.SawMethod("PUT", conditional); n != 0 {
			t.Errorf("%d PUTs sent %s", n, conditional)
		}
	}
	if n := fake.SawMethod("GET", "If-Match"); n != 0 {
		t.Errorf("%d GETs sent If-Match", n)
	}
}

func TestGuardKeepsTheStoreWhenItIsFullyCapable(t *testing.T) {
	c := client("http://127.0.0.1:1")
	if got := store.Guard(c, store.AllCaps()); got != store.Objects(c) {
		t.Errorf("Guard wrapped a store that needs no help: %T", got)
	}
}

func TestGuardCreateOnceRefusesAnExistingKeyWithoutTheHeader(t *testing.T) {
	fake := &storetest.FakeS3{RejectConditionals: true}
	g := store.Guard(client(fake.Start(t)), store.Capabilities{})
	if _, err := g.Put("bkt", "k", []byte("a"), "", "*", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Put("bkt", "k", []byte("b"), "", "*", ""); !errors.Is(err, s3.ErrPreconditionFailed) {
		t.Fatalf("second create-once: %v", err)
	}
	if _, err := g.Put("bkt", "k", []byte("c"), "", "", `"00"`); !errors.Is(err, s3.ErrPreconditionFailed) {
		t.Fatalf("put with a wrong If-Match: %v", err)
	}
	dest := filepath.Join(t.TempDir(), "out")
	if err := g.GetRangeToFile("bkt", "k", dest, 0, 0, `"00"`); !errors.Is(err, s3.ErrPreconditionFailed) {
		t.Fatalf("ranged GET with a wrong If-Match: %v", err)
	}
	if data, _ := os.ReadFile(dest); len(data) != 0 {
		t.Errorf("a refused GET wrote %q", data)
	}
}

func TestCapsCacheRoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "store-caps.json")
	if _, ok := store.LoadCaps(path, "s3://b?endpoint=http://h"); ok {
		t.Fatal("a cache that was never written")
	}
	want := store.Capabilities{CreateOnce: true, GetIfMatch: true}
	if err := store.SaveCaps(path, "s3://b?endpoint=http://h", want); err != nil {
		t.Fatal(err)
	}
	if got, ok := store.LoadCaps(path, "s3://b?endpoint=http://h"); !ok || got != want {
		t.Errorf("LoadCaps = %+v, %v", got, ok)
	}
	if _, ok := store.LoadCaps(path, "s3://other"); ok {
		t.Error("a cache for another store was used")
	}
}

func TestParseCaps(t *testing.T) {
	for text, want := range map[string]store.Capabilities{
		"all":                          store.AllCaps(),
		"none":                         {},
		"create_once":                  {CreateOnce: true},
		"create_once, get_if_match":    {CreateOnce: true, GetIfMatch: true},
		" put_if_match,copy_if_match ": {PutIfMatch: true, CopyIfMatch: true},
	} {
		got, err := store.ParseCaps(text)
		if err != nil || got != want {
			t.Errorf("ParseCaps(%q) = %+v, %v; want %+v", text, got, err, want)
		}
	}
	for _, bad := range []string{"", "everything", "create_once,bogus"} {
		if _, err := store.ParseCaps(bad); err == nil {
			t.Errorf("ParseCaps(%q) succeeded", bad)
		}
	}
}
