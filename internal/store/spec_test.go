package store

import (
	"strings"
	"testing"

	"folder-sync/internal/testtools"
)

// The tests build file:// URLs from t.TempDir(). On Windows that is C:\Users\..., and "file://" + "C:/Users/..." names the host
// "C:" (the first CI run: "use an absolute path, not a host"), so every test goes through testtools.FileURL.
func TestFileURLOfADirectoryOnAnyOS(t *testing.T) {
	for dir, want := range map[string]string{
		"/srv/nas/hub":     "/srv/nas/hub",
		"C:/Users/BAM/hub": "C:/Users/BAM/hub",
		"D:/a/_temp/hub":   "D:/a/_temp/hub",
	} {
		raw := testtools.FileURL(dir)
		spec, err := Parse(raw)
		if err != nil {
			t.Errorf("%s -> %s: %v", dir, raw, err)
			continue
		}
		if spec.Kind != File || spec.Bucket != want {
			t.Errorf("%s -> %s parsed as %+v, want the directory %s", dir, raw, spec, want)
		}
	}
}

func TestParse(t *testing.T) {
	cases := []struct {
		raw  string
		want Spec
	}{
		{"r2://folder-sync", Spec{Kind: R2, Bucket: "folder-sync"}},
		{"r2://folder-sync/team/", Spec{Kind: R2, Bucket: "folder-sync", Prefix: "team/"}},
		{"s3://my-bucket", Spec{Kind: S3, Bucket: "my-bucket"}},
		{"s3://my-bucket/a/b", Spec{Kind: S3, Bucket: "my-bucket", Prefix: "a/b/"}},
		{"s3://fs-test?endpoint=http://127.0.0.1:9000&region=eu-1&provider=Minio",
			Spec{Kind: S3, Bucket: "fs-test", Endpoint: "http://127.0.0.1:9000", Region: "eu-1", Provider: "Minio"}},
		{"gs://notes/vault", Spec{Kind: GS, Bucket: "notes", Prefix: "vault/"}},
		{"file:///srv/nas/folder-sync", Spec{Kind: File, Bucket: "/srv/nas/folder-sync"}},
		{"file:///C:/Users/BAM/hub", Spec{Kind: File, Bucket: "C:/Users/BAM/hub"}},
	}
	for _, c := range cases {
		got, err := Parse(c.raw)
		if err != nil {
			t.Errorf("Parse(%q): %v", c.raw, err)
			continue
		}
		got.Raw = ""
		if got != c.want {
			t.Errorf("Parse(%q) = %+v, want %+v", c.raw, got, c.want)
		}
	}
}

func TestParseRejects(t *testing.T) {
	cases := map[string]string{
		"":                           "empty",
		"folder-sync":                "scheme",
		"ftp://host/x":               "scheme",
		"s3://":                      "bucket",
		"s3://UPPER":                 "bucket",
		"s3://ab":                    "bucket",
		"s3://my-bucket/../x":        "prefix",
		"s3://my-bucket//x":          "prefix",
		"s3://my-bucket?bogus=1":     "bogus",
		"s3://my-bucket?endpoint=ht": "endpoint",
		"r2://has_underscore":        "bucket",
		"file://relative/dir":        "absolute",
		"file:///":                   "directory",
		"gs://notes/x?endpoint=a":    "endpoint",
	}
	for raw, want := range cases {
		_, err := Parse(raw)
		if err == nil {
			t.Errorf("Parse(%q) succeeded", raw)
		} else if !strings.Contains(err.Error(), want) {
			t.Errorf("Parse(%q): %v does not mention %q", raw, err, want)
		}
	}
}

func TestStringRoundTrips(t *testing.T) {
	for _, raw := range []string{"r2://folder-sync", "s3://b-1/a/b/", "s3://b-1?endpoint=http://127.0.0.1:9000&region=eu-1", "gs://notes", "file:///srv/nas/x"} {
		spec, err := Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		again, err := Parse(spec.String())
		if err != nil {
			t.Fatalf("%s -> %s: %v", raw, spec.String(), err)
		}
		spec.Raw, again.Raw = "", ""
		if spec != again {
			t.Errorf("%s -> %s -> %+v, want %+v", raw, spec.String(), again, spec)
		}
	}
}

// The provider a store is costed at (bench/cost/prices.json ids) and the one rclone's s3 backend is told.
func TestProviders(t *testing.T) {
	cases := []struct {
		raw, cost, rclone, endpoint string
	}{
		{"r2://x-bucket", "r2", "Cloudflare", ""},
		{"s3://x-bucket", "s3", "AWS", "https://s3.us-east-1.amazonaws.com"},
		{"s3://x-bucket?region=eu-west-1", "s3", "AWS", "https://s3.eu-west-1.amazonaws.com"},
		{"s3://x-bucket?endpoint=https://s3.us-west-004.backblazeb2.com&region=us-west-004", "b2", "Other", "https://s3.us-west-004.backblazeb2.com"},
		{"s3://x-bucket?endpoint=https://s3.wasabisys.com", "wasabi", "Wasabi", "https://s3.wasabisys.com"},
		{"s3://x-bucket?endpoint=http://127.0.0.1:9000", "", "Other", "http://127.0.0.1:9000"},
		{"s3://x-bucket?endpoint=http://127.0.0.1:9000&provider=Minio", "", "Minio", "http://127.0.0.1:9000"},
		{"gs://x-bucket", "gcs", "GCS", "https://storage.googleapis.com"},
		{"file:///srv/nas", "", "", ""},
	}
	for _, c := range cases {
		spec, err := Parse(c.raw)
		if err != nil {
			t.Fatal(err)
		}
		if got := spec.CostProvider(); got != c.cost {
			t.Errorf("%s: CostProvider = %q, want %q", c.raw, got, c.cost)
		}
		if got := spec.RcloneProvider(); got != c.rclone {
			t.Errorf("%s: RcloneProvider = %q, want %q", c.raw, got, c.rclone)
		}
		if got := spec.EndpointOrDefault(); got != c.endpoint {
			t.Errorf("%s: EndpointOrDefault = %q, want %q", c.raw, got, c.endpoint)
		}
	}
}

func TestRegionDefaults(t *testing.T) {
	for raw, want := range map[string]string{
		"r2://x-bucket":                        "auto",
		"s3://x-bucket":                        "us-east-1",
		"s3://x-bucket?region=ap-south-1":      "ap-south-1",
		"gs://x-bucket":                        "us-east-1",
		"s3://x-bucket?endpoint=http://h:9000": "us-east-1",
		"file:///srv/nas":                      "",
	} {
		spec, _ := Parse(raw)
		if got := spec.RegionOrDefault(); got != want {
			t.Errorf("%s: RegionOrDefault = %q, want %q", raw, got, want)
		}
	}
}
