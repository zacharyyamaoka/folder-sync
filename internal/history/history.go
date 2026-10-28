// Package history is PEP 0007's version history as the bucket holds it (docs/CONTRACT.md "Deletions and history"):
// the keys and version ids of _history/, the rule that decides whether a leaving version is kept (the burst rule and
// no_history), the staggered schedule that prunes kept versions, and the change records, pull records and restore
// requests beside them. It does no I/O: internal/syncer makes the calls. The design is docs/peps/0007 §3.
package history

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"folder-sync/internal/ignore"
)

const (
	// Burst is the write-time rule's window: a version that lived less is kept at most once per Burst per path.
	Burst = 30 * time.Second
	// KeepDays is how long anything under _history/, _changes/, _requests/ and legacy _trash/ is kept.
	KeepDays = 30
	// MaxKeyBytes is R2's key limit: a path whose history key would be longer is published but never kept.
	MaxKeyBytes = 1024
)

// Why a leaving version was not kept (the event's was.why).
const (
	WhyBurst      = "burst"
	WhyNoHistory  = "no_history"
	WhyKeyTooLong = "key_too_long"
	WhyPermanent  = "permanent"
)

// Ops a leaving version leaves by.
const (
	OpReplace = "replace"
	OpDelete  = "delete"
	OpRestore = "restore"
)

// Unlisted ends the id of a version that was not the one the manifest listed.
const Unlisted = "unlisted"

// versionID is exactly the contract's pattern (schema/history.schema.json#/$defs/version_id).
var versionID = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)_([0-9a-f]{16}|unlisted)$`)

var (
	projectName = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,62}$`)
	hostID      = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	rootSegment = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	sha256Hex   = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// msLayout is RFC 3339 UTC to the millisecond, the first half of a version id.
const msLayout = "2006-01-02T15:04:05.000Z"

// FormatMs writes t as RFC 3339 UTC, truncated (never rounded) to the millisecond.
func FormatMs(t time.Time) string { return t.UTC().Truncate(time.Millisecond).Format(msLayout) }

// VersionID is a listed version's id: its manifest entry's written_at truncated to the millisecond, then the first 16
// hex digits of its sha256 (docs/CONTRACT.md "Bucket layout").
func VersionID(writtenAt, sha256 string) (string, error) {
	t, err := time.Parse(time.RFC3339Nano, writtenAt)
	if err != nil {
		return "", fmt.Errorf("written_at %q: %w", writtenAt, err)
	}
	if !sha256Hex.MatchString(sha256) {
		return "", fmt.Errorf("sha256 %q is not 64 lowercase hex digits", sha256)
	}
	return FormatMs(t) + "_" + sha256[:16], nil
}

// UnlistedID is the id of an object kept although it was not the version the manifest listed: its LastModified.
func UnlistedID(lastModified time.Time) string { return FormatMs(lastModified) + "_" + Unlisted }

// ValidVersionID reports whether id is a version id.
func ValidVersionID(id string) bool { return versionID.MatchString(id) }

// SplitVersionID answers a version id's two halves: its time, and its sha16 ("" for an unlisted version).
func SplitVersionID(id string) (at time.Time, sha16 string, unlisted bool, err error) {
	m := versionID.FindStringSubmatch(id)
	if m == nil {
		return time.Time{}, "", false, fmt.Errorf("%q is not a version id (<written_at to the ms>_<sha16>, or …_unlisted)", id)
	}
	at, err = time.Parse(time.RFC3339Nano, m[1])
	if err != nil {
		return time.Time{}, "", false, fmt.Errorf("%q: %w", id, err)
	}
	if m[2] == Unlisted {
		return at, "", true, nil
	}
	return at, m[2], false, nil
}

// Prefix is <root>_history/<project>/<host>/: every kept version of one host.
func Prefix(root, project, host string) string {
	return root + "_history/" + project + "/" + host + "/"
}

// PathPrefix is <root>_history/<project>/<host>/<path>/: one file's versions, as one delimiter listing.
func PathPrefix(root, project, host, path string) string {
	return Prefix(root, project, host) + path + "/"
}

// Key is a kept version's key.
func Key(root, project, host, path, version string) string {
	return PathPrefix(root, project, host, path) + version
}

// Version is one kept version, as a reader parses it from a listing (schema/history.schema.json).
type Version struct {
	Key       string    `json:"key"`
	Root      string    `json:"root"`
	Project   string    `json:"project"`
	Host      string    `json:"host"`
	Path      string    `json:"path"`
	Version   string    `json:"version"`
	WrittenAt string    `json:"written_at,omitempty"`
	SHA16     string    `json:"sha16,omitempty"`
	Unlisted  bool      `json:"unlisted,omitempty"`
	LeftAt    time.Time `json:"left_at"` // the object's LastModified
	Size      int64     `json:"size"`
}

// ParseKey reads a history key into its parts. LeftAt and Size come from the listing, not the key.
func ParseKey(key string) (Version, error) {
	bad := func(why string) (Version, error) {
		return Version{}, fmt.Errorf("%q is not a history key: %s", key, why)
	}
	if len(key) > MaxKeyBytes {
		return bad("longer than 1,024 bytes")
	}
	segments := strings.Split(key, "/")
	at := -1
	for i, segment := range segments {
		if segment == "_history" {
			at = i
			break
		}
		if !rootSegment.MatchString(segment) {
			return bad("the account root is not segments of [A-Za-z0-9][A-Za-z0-9._-]*")
		}
	}
	if at < 0 || at > 8 {
		return bad("no _history/ after an account root of at most 8 segments")
	}
	// _history / project / host / path… / version
	rest := segments[at+1:]
	if len(rest) < 4 {
		return bad("it needs a project, a host, a path and a version")
	}
	project, host, version := rest[0], rest[1], rest[len(rest)-1]
	path := strings.Join(rest[2:len(rest)-1], "/")
	if !projectName.MatchString(project) {
		return bad("the project is not ^[a-z0-9][a-z0-9._-]{0,62}$")
	}
	if !hostID.MatchString(host) {
		return bad("the host is not a lowercase UUID v4")
	}
	if err := checkPath(path); err != nil {
		return bad(err.Error())
	}
	written, sha16, unlisted, err := SplitVersionID(version)
	if err != nil {
		return bad(err.Error())
	}
	v := Version{Key: key, Root: strings.Join(segments[:at], "/"), Project: project, Host: host, Path: path, Version: version}
	if v.Root != "" {
		v.Root += "/"
	}
	if unlisted {
		v.Unlisted = true
	} else {
		v.WrittenAt, v.SHA16 = FormatMs(written), sha16
	}
	return v, nil
}

// checkPath is the contract's published-path rule (schema/event.schema.json#/$defs/path).
func checkPath(path string) error {
	switch {
	case path == "":
		return fmt.Errorf("the path is empty")
	case strings.Contains(path, ":"):
		return fmt.Errorf("a published path never holds ':'")
	case strings.Contains(path, `\`):
		return fmt.Errorf("the path holds a backslash")
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return fmt.Errorf("the path has an empty, . or .. segment")
		}
	}
	return nil
}

// Matcher answers whether a path matches no_history's gitignore patterns (last match wins; a pattern without a slash
// matches a name at any depth; a trailing "/" matches only a folder, and so everything in it). WHY its own matcher:
// the ignore rules are applied by rclone, which never sees no_history; this reads the same syntax (internal/ignore).
type Matcher struct {
	rules []matcherRule
}

type matcherRule struct {
	re     *regexp.Regexp
	negate bool
}

// NewMatcher parses no_history's patterns.
func NewMatcher(patterns []string) (*Matcher, error) {
	rules, err := ignore.Parse(patterns)
	if err != nil {
		return nil, err
	}
	m := &Matcher{}
	for _, rule := range rules {
		pattern := strings.TrimPrefix(rule.Pattern, "**/")
		body := globRegexp(pattern)
		lead := `(^|.*/)`
		if rule.Anchored {
			lead = `^`
		}
		tail := `(/.*)?$`
		if rule.DirOnly {
			tail = `/.*$`
		}
		re, err := regexp.Compile(lead + body + tail)
		if err != nil {
			return nil, fmt.Errorf("no_history %q: %w", rule.Source, err)
		}
		m.rules = append(m.rules, matcherRule{re: re, negate: rule.Negate})
	}
	return m, nil
}

// Match reports whether path keeps no history.
func (m *Matcher) Match(path string) bool {
	if m == nil {
		return false
	}
	matched := false
	for _, rule := range m.rules {
		if rule.re.MatchString(path) {
			matched = !rule.negate
		}
	}
	return matched
}

// globRegexp turns one gitignore glob into a regular expression: * and ? never cross a "/", ** does.
func globRegexp(glob string) string {
	var b strings.Builder
	for i := 0; i < len(glob); i++ {
		ch := glob[i]
		switch {
		case strings.HasPrefix(glob[i:], "**/"):
			b.WriteString(`(.*/)?`)
			i += 2
		case strings.HasPrefix(glob[i:], "/**"):
			b.WriteString(`/.*`)
			i += 2
		case strings.HasPrefix(glob[i:], "**"):
			b.WriteString(`.*`)
			i++
		case ch == '*':
			b.WriteString(`[^/]*`)
		case ch == '?':
			b.WriteString(`[^/]`)
		case ch == '\\' && i+1 < len(glob):
			b.WriteString(regexp.QuoteMeta(glob[i+1 : i+2]))
			i++
		case ch == '[':
			if end := strings.IndexByte(glob[i+1:], ']'); end >= 0 {
				class := glob[i+1 : i+1+end]
				if strings.HasPrefix(class, "!") {
					class = "^" + class[1:]
				}
				b.WriteString("[" + class + "]")
				i += end + 1
				continue
			}
			b.WriteString(`\[`)
		default:
			b.WriteString(regexp.QuoteMeta(string(ch)))
		}
	}
	return b.String()
}

// Keep is the write-time rule (docs/CONTRACT.md "What is kept"): whether the version of path that leaves at t by op,
// whose manifest entry was written at writtenAt, is copied to _history/. lastKept is when this writer last kept a
// version of this path (zero for never). The first rule that matches decides; why says which one when it is not kept.
func Keep(op, path string, writtenAt, t, lastKept time.Time, noHistory *Matcher) (keep bool, why string) {
	switch {
	case noHistory.Match(path):
		return false, WhyNoHistory
	case op == OpDelete || op == OpRestore:
		return true, ""
	case t.Sub(writtenAt) >= Burst:
		return true, ""
	case !lastKept.IsZero() && lastKept.After(t.Add(-Burst)):
		return false, WhyBurst
	}
	return true, ""
}

// Prune is the schedule (docs/CONTRACT.md "What is kept", "When the pruner runs"): of the kept versions of one
// (host, path), the ones to keep and the ones to delete at now. Buckets are UTC clock hours and days of left_at, so a
// prune is idempotent and two pruners never disagree.
func Prune(versions []Version, now time.Time, keepDays int) (keep, drop []Version) {
	if keepDays <= 0 {
		keepDays = KeepDays
	}
	maxAge := time.Duration(keepDays) * 24 * time.Hour
	newest := map[string]int{} // tier + bucket -> index of its newest version
	tierOf := make([]string, len(versions))
	for i, v := range versions {
		age := now.Sub(v.LeftAt)
		switch {
		case age >= maxAge:
			tierOf[i] = "drop"
			continue
		case age < time.Hour:
			tierOf[i] = "keep"
			continue
		case age < 24*time.Hour:
			tierOf[i] = "h" + v.LeftAt.UTC().Format("2006-01-02T15")
		default:
			tierOf[i] = "d" + v.LeftAt.UTC().Format("2006-01-02")
		}
		if j, seen := newest[tierOf[i]]; !seen || newer(v, versions[j]) {
			newest[tierOf[i]] = i
		}
	}
	for i, v := range versions {
		switch tier := tierOf[i]; {
		case tier == "keep":
			keep = append(keep, v)
		case tier == "drop":
			drop = append(drop, v)
		case newest[tier] == i:
			keep = append(keep, v)
		default:
			drop = append(drop, v)
		}
	}
	return keep, drop
}

// newer: the larger left_at, then the larger version id.
func newer(a, b Version) bool {
	if !a.LeftAt.Equal(b.LeftAt) {
		return a.LeftAt.After(b.LeftAt)
	}
	return a.Version > b.Version
}

// ByPath groups versions by path, each group oldest first (version ids sort oldest first).
func ByPath(versions []Version) map[string][]Version {
	out := map[string][]Version{}
	for _, v := range versions {
		out[v.Path] = append(out[v.Path], v)
	}
	for _, group := range out {
		sort.Slice(group, func(i, j int) bool { return group[i].Version < group[j].Version })
	}
	return out
}
