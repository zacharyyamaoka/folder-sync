// Package store is where a folder's bytes live, as a URL: r2://bucket (today's default), s3://bucket/prefix (AWS and
// any S3-compatible endpoint), gs://bucket/prefix (Google Cloud Storage's S3 interoperability API) or file:///dir (a
// local or mounted directory). rclone already speaks every one of them and moves the files; this package carries what
// rclone cannot: the parsed URL (spec.go), the engine's own object calls behind one interface (objects.go), a directory
// that answers them (file.go), and what each store's S3 dialect can do, measured (caps.go).
//
// WHY a URL and not a "provider" field: one string says where the folder lives, it is safe to commit (it holds no key),
// and the cost KPI reads the provider from it (docs/STORAGE.md). The Cloudflare-specific parts are r2:// and nothing
// else here; PARTS.md lists them.
package store

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// Kind is a store's scheme.
type Kind string

const (
	R2   Kind = "r2"   // Cloudflare R2: today's default, and the only store the accounts Worker serves
	S3   Kind = "s3"   // AWS S3 or any S3-compatible endpoint (Backblaze B2, Wasabi, MinIO)
	GS   Kind = "gs"   // Google Cloud Storage, through its S3-interoperable XML API with HMAC keys
	File Kind = "file" // a directory on this machine: local disk, a NAS mount, a test folder
)

// Spec is a parsed store URL.
type Spec struct {
	Kind Kind
	// Bucket is the bucket; for a file store it is the absolute directory in slash form ("/srv/nas/hub",
	// "C:/Users/BAM/hub"). WHY: rclone addresses "<remote>:<bucket>/<key>", so a directory in the bucket's place makes
	// every rclone path in the engine work unchanged on the local backend.
	Bucket string
	// Prefix is "" or "a/b/": a folder inside the bucket that holds everything. It joins the account root the
	// credentials carry (the engine's Root), in front of it.
	Prefix string
	// Endpoint, Region and Provider override what the environment and the kind would pick (?endpoint=&region=&provider=).
	Endpoint string
	Region   string
	Provider string
	// Raw is the text parsed, as written.
	Raw string
}

var (
	r2Bucket  = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`)
	s3Bucket  = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$`)
	segment   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	provider  = regexp.MustCompile(`^[A-Za-z0-9]{1,32}$`)
	driveRoot = regexp.MustCompile(`^/[A-Za-z]:/`)
)

// Parse reads a store URL.
func Parse(raw string) (Spec, error) {
	if strings.TrimSpace(raw) == "" {
		return Spec{}, fmt.Errorf("store: empty; use r2://bucket, s3://bucket/prefix, gs://bucket/prefix or file:///directory")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return Spec{}, fmt.Errorf("store %q: %v", raw, err)
	}
	spec := Spec{Kind: Kind(u.Scheme), Raw: raw}
	switch spec.Kind {
	case R2, S3, GS, File:
	default:
		return Spec{}, fmt.Errorf("store %q: scheme %q is not one of r2://, s3://, gs://, file://", raw, u.Scheme)
	}
	query := u.Query()
	for key := range query {
		switch key {
		case "endpoint", "region", "provider":
		default:
			return Spec{}, fmt.Errorf("store %q: unknown option %q (the options are endpoint, region and provider)", raw, key)
		}
	}
	if spec.Kind == File {
		if len(query) > 0 {
			return Spec{}, fmt.Errorf("store %q: a file:// store has no options", raw)
		}
		if u.Host != "" {
			return Spec{}, fmt.Errorf("store %q: use an absolute path (file:///srv/dir), not a host", raw)
		}
		dir := strings.TrimRight(u.Path, "/")
		if driveRoot.MatchString(dir + "/") {
			dir = dir[1:]
		}
		if dir == "" || dir == "C:" {
			return Spec{}, fmt.Errorf("store %q: name a directory, not the root of a disk", raw)
		}
		spec.Bucket = dir
		return spec, nil
	}
	spec.Bucket = u.Host
	pattern := s3Bucket
	if spec.Kind == R2 {
		pattern = r2Bucket
	}
	if !pattern.MatchString(spec.Bucket) {
		return Spec{}, fmt.Errorf("store %q: bucket %q: use 3-63 lowercase letters, digits and '-'%s", raw, spec.Bucket, map[bool]string{true: "", false: " ('.' and '_' too)"}[spec.Kind == R2])
	}
	if p := strings.TrimSuffix(strings.TrimPrefix(u.Path, "/"), "/"); p != "" {
		segments := strings.Split(p, "/")
		if len(segments) > 8 {
			return Spec{}, fmt.Errorf("store %q: prefix %q has more than 8 segments", raw, p)
		}
		for _, s := range segments {
			if !segment.MatchString(s) {
				return Spec{}, fmt.Errorf("store %q: prefix segment %q: use letters, digits, '.', '_' or '-' (no empty segment, no '..')", raw, s)
			}
		}
		spec.Prefix = p + "/"
	}
	spec.Endpoint = strings.TrimRight(query.Get("endpoint"), "/")
	if spec.Endpoint != "" {
		eu, err := url.Parse(spec.Endpoint)
		if err != nil || (eu.Scheme != "http" && eu.Scheme != "https") || eu.Host == "" {
			return Spec{}, fmt.Errorf("store %q: endpoint %q must be an http:// or https:// URL", raw, spec.Endpoint)
		}
	}
	spec.Region = query.Get("region")
	if strings.ContainsAny(spec.Region, "/ ") {
		return Spec{}, fmt.Errorf("store %q: region %q", raw, spec.Region)
	}
	spec.Provider = query.Get("provider")
	if spec.Provider != "" && !provider.MatchString(spec.Provider) {
		return Spec{}, fmt.Errorf("store %q: provider %q is a name like AWS, Minio or Wasabi (rclone's s3 provider list)", raw, spec.Provider)
	}
	return spec, nil
}

// R2Default is the store of a config that names only a bucket: today's behaviour.
func R2Default(bucket string) Spec {
	return Spec{Kind: R2, Bucket: bucket, Raw: "r2://" + bucket}
}

// String is the canonical URL.
func (s Spec) String() string {
	if s.Kind == File {
		if strings.HasPrefix(s.Bucket, "/") {
			return "file://" + s.Bucket
		}
		return "file:///" + s.Bucket
	}
	out := string(s.Kind) + "://" + s.Bucket
	if s.Prefix != "" {
		out += "/" + s.Prefix
	}
	var options []string
	for _, kv := range [][2]string{{"endpoint", s.Endpoint}, {"region", s.Region}, {"provider", s.Provider}} {
		if kv[1] != "" {
			options = append(options, kv[0]+"="+kv[1])
		}
	}
	if len(options) > 0 {
		out += "?" + strings.Join(options, "&")
	}
	return out
}

// IsS3Family reports whether the store speaks S3 on the wire (every kind but file).
func (s Spec) IsS3Family() bool { return s.Kind != File && s.Kind != "" }

func (s Spec) host() string {
	endpoint := s.Endpoint
	if endpoint == "" {
		return ""
	}
	u, err := url.Parse(endpoint)
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

func hostIs(host, suffix string) bool { return host == suffix || strings.HasSuffix(host, "."+suffix) }

// CostProvider is the id of the store's provider in bench/cost/prices.json ("r2", "s3", "gcs", "b2", "wasabi"), or ""
// when none is priced (a MinIO server, a NAS, a directory). WHY the host and not the scheme alone: s3:// also names
// Backblaze B2 and Wasabi, which cost very differently from AWS.
func (s Spec) CostProvider() string {
	switch s.Kind {
	case R2:
		return "r2"
	case GS:
		return "gcs"
	case File:
		return ""
	}
	host := s.host()
	switch {
	case host == "" || hostIs(host, "amazonaws.com"):
		return "s3"
	case hostIs(host, "backblazeb2.com"):
		return "b2"
	case hostIs(host, "wasabisys.com"):
		return "wasabi"
	case hostIs(host, "r2.cloudflarestorage.com"):
		return "r2"
	case hostIs(host, "googleapis.com"):
		return "gcs"
	}
	return ""
}

// RcloneProvider is the provider name rclone's s3 backend gets (it picks addressing and quirks by it); "" for a file
// store, which is not an s3 remote.
func (s Spec) RcloneProvider() string {
	switch s.Kind {
	case R2:
		return "Cloudflare"
	case GS:
		return "GCS"
	case File:
		return ""
	}
	if s.Provider != "" {
		return s.Provider
	}
	switch s.CostProvider() {
	case "s3":
		return "AWS"
	case "wasabi":
		return "Wasabi"
	case "r2":
		return "Cloudflare"
	case "gcs":
		return "GCS"
	}
	return "Other"
}

// RegionOrDefault is the signing region: the one given, else what the kind uses. WHY us-east-1 for gs://: rclone signs
// its GCS requests with it, and Google's S3 interoperability API accepts any region in the signature.
func (s Spec) RegionOrDefault() string {
	if s.Region != "" {
		return s.Region
	}
	switch s.Kind {
	case R2:
		return "auto"
	case S3, GS:
		return "us-east-1"
	}
	return ""
}

// EndpointOrDefault is the endpoint to talk to: the one given, else the kind's own (AWS's regional endpoint, Google's
// storage.googleapis.com). "" for r2 (the account id makes it: internal/creds) and for a file store.
func (s Spec) EndpointOrDefault() string {
	if s.Endpoint != "" {
		return s.Endpoint
	}
	switch s.Kind {
	case S3:
		return "https://s3." + s.RegionOrDefault() + ".amazonaws.com"
	case GS:
		return "https://storage.googleapis.com"
	}
	return ""
}
