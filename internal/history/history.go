// Package history is PEP 0007's version history as the bucket holds it (docs/CONTRACT.md "Deletions and history"):
// the keys and version ids of _history/, the rule that decides whether a leaving version is kept (the throttle, the pin
// and no_history), the staggered schedule that prunes kept versions (with PEP 0009's anchors), and the change records,
// pull records and restore requests beside them. It does no I/O: internal/syncer makes the calls. The design is
// docs/peps/0007 §3 and docs/peps/0009.
package history

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"folder-sync/internal/ignore"
)

const (
	// DefaultEvery is the write-time rule's window when .folder-sync.toml sets no history_every: a version that lived
	// less is kept at most once per window per path (Zach, 2026-11-04: "every X min? (5 by default)", PEP 0009 §5).
	DefaultEvery = 5 * time.Minute
	// MinEvery is the least history_every: PEP 0007's 30 s.
	MinEvery = 30 * time.Second
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

// Kind is the form of the object a kept version is stored as (PEP 0009).
type Kind string

const (
	// KindFull is the file's exact bytes under the version id alone: PEP 0007's form, and the only one an `_unlisted`
	// version, the web host and a legacy reader know.
	KindFull Kind = "full"
	// KindZst is <version>.<size>.zst: one zstd frame of exactly the version's bytes (a keyframe).
	KindZst Kind = "zst"
	// KindPrefix is <version>.<size>.prefix: a pointer (PrefixBody) whose bytes are the start of the path's next full object.
	KindPrefix Kind = "prefix"
)

// objectName is a name under …/<path>/: a version id, then for a keyframe or a pointer .<size>.<form>. WHY no leading
// zero in the size: one number, one spelling.
var objectName = regexp.MustCompile(`^(.+?)(?:\.(0|[1-9][0-9]*)\.(zst|prefix))?$`)

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

// Key is a whole kept version's key.
func Key(root, project, host, path, version string) string {
	return PathPrefix(root, project, host, path) + version
}

// Name is an object's name under …/<path>/: the version id, then .<size>.zst or .<size>.prefix. size is the version's
// own size, so a listing shows every version's true size without a GET.
func Name(version string, kind Kind, size int64) string {
	switch kind {
	case KindZst, KindPrefix:
		return fmt.Sprintf("%s.%d.%s", version, size, kind)
	}
	return version
}

// KeyOf is the key of a version stored as kind.
func KeyOf(root, project, host, path, version string, kind Kind, size int64) string {
	return PathPrefix(root, project, host, path) + Name(version, kind, size)
}

// ParseName reads an object's name: its version id, its form, and for .zst and .prefix the version's size.
func ParseName(name string) (version string, kind Kind, size int64, err error) {
	m := objectName.FindStringSubmatch(name)
	if m == nil || !versionID.MatchString(m[1]) {
		return "", "", 0, fmt.Errorf("%q is not a version name (<written_at to the ms>_<sha16>, then optionally .<size>.zst or .<size>.prefix)", name)
	}
	if m[3] == "" {
		return m[1], KindFull, 0, nil
	}
	if strings.HasSuffix(m[1], "_"+Unlisted) {
		return "", "", 0, fmt.Errorf("%q: an unlisted version is always a whole copy", name)
	}
	n, err := strconv.ParseInt(m[2], 10, 64)
	if err != nil {
		return "", "", 0, fmt.Errorf("%q: size: %w", name, err)
	}
	return m[1], Kind(m[3]), n, nil
}

// PrefixSchema is the schema field of a pointer's body (schema/prefix.schema.json).
const PrefixSchema = "folder-sync-prefix/1"

// PrefixBody is a .prefix object's body: this version is the first Size bytes of the path's next full object, and
// those bytes hash to SHA256.
type PrefixBody struct {
	Schema string `json:"schema"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// Marshal is the body as the engine writes it, compact: about 125 bytes.
func (b PrefixBody) Marshal() []byte {
	return []byte(fmt.Sprintf(`{"schema":%q,"size":%d,"sha256":%q}`, PrefixSchema, b.Size, b.SHA256))
}

// ParsePrefixBody reads and checks a pointer's body.
func ParsePrefixBody(data []byte) (PrefixBody, error) {
	var b PrefixBody
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&b); err != nil {
		return PrefixBody{}, fmt.Errorf("a prefix pointer: %w", err)
	}
	switch {
	case b.Schema != PrefixSchema:
		return PrefixBody{}, fmt.Errorf("a prefix pointer: schema %q, want %q", b.Schema, PrefixSchema)
	case b.Size < 1:
		return PrefixBody{}, fmt.Errorf("a prefix pointer: size %d", b.Size)
	case !sha256Hex.MatchString(b.SHA256):
		return PrefixBody{}, fmt.Errorf("a prefix pointer: sha256 %q is not 64 lowercase hex digits", b.SHA256)
	}
	return b, nil
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
	// Size is the version's own size: the object's size for a whole version (the listing fills it), the <size> in the
	// name for a .zst and a .prefix.
	Size int64 `json:"size"`
	// Kind is the form of the object (PEP 0009). WHY not in the JSON: the view API shows a version, never its form.
	Kind Kind `json:"-"`
	// Stored is the object's own size in the bucket, the listing's: what the version costs.
	Stored int64 `json:"-"`
}

// Pointer reports whether the version is a prefix pointer.
func (v Version) Pointer() bool { return v.Kind == KindPrefix }

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
	id, kind, size, err := ParseName(version)
	if err != nil {
		return bad(err.Error())
	}
	written, sha16, unlisted, err := SplitVersionID(id)
	if err != nil {
		return bad(err.Error())
	}
	v := Version{Key: key, Root: strings.Join(segments[:at], "/"), Project: project, Host: host, Path: path, Version: id, Kind: kind}
	if kind != KindFull {
		v.Size = size
	}
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

// Write is one version leaving the folder, as the write-time rule reads it.
type Write struct {
	Op        string // OpReplace | OpDelete | OpRestore
	Path      string
	WrittenAt time.Time // the leaving version's manifest written_at
	At        time.Time // when it leaves
	LastKept  time.Time // when this writer last kept a version of this path (zero for never)
	Every     time.Duration
	// NewestKeptIsPointer is the pin's first half: the newest version this writer kept of the path is a prefix pointer,
	// so it rests on the live file.
	NewestKeptIsPointer bool
	// AppendUploaded is its second half: the new bytes are an append that this writer uploads itself, by one native PUT
	// of the bytes it hashed, so the pointer's bytes stay the start of what is live.
	AppendUploaded bool
}

// Keep is the write-time rule (docs/CONTRACT.md "What is kept"): whether the version of w.Path that leaves is copied to
// _history/. The first rule that matches decides; why says which one when it is not kept.
func Keep(w Write, noHistory *Matcher) (keep bool, why string) {
	every := w.Every
	if every <= 0 {
		every = DefaultEvery
	}
	switch {
	case noHistory.Match(w.Path):
		return false, WhyNoHistory
	case w.Op == OpDelete || w.Op == OpRestore:
		return true, ""
	// WHY before the throttle (PEP 0009 §4.3): a pointer rests on the live file, and a rewrite, or an append rclone
	// uploads, could replace it with bytes that do not start with the pointer's. Dropping this version would lose the
	// only copy that does.
	case w.NewestKeptIsPointer && !w.AppendUploaded:
		return true, ""
	case w.At.Sub(w.WrittenAt) >= every:
		return true, ""
	case !w.LastKept.IsZero() && w.LastKept.After(w.At.Add(-every)):
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

// Anchor is the full object a pointer rests on: the oldest version of its path newer than it, in version order, that
// is not itself a pointer (a keyframe or a whole copy). ok is false when there is none: the pointer then rests on the
// live file, or, when the path is gone, on nothing. versions may hold any forms, in any order.
func Anchor(versions []Version, pointer string) (Version, bool) {
	var best Version
	found := false
	for _, v := range versions {
		if v.Kind == KindPrefix || v.Version <= pointer {
			continue
		}
		if !found || v.Version < best.Version || (v.Version == best.Version && formRank(v.Kind) < formRank(best.Kind)) {
			best, found = v, true
		}
	}
	return best, found
}

// formRank orders the forms of one version: the whole copy is the version, a keyframe is the next best, a pointer last.
func formRank(k Kind) int {
	switch k {
	case KindPrefix:
		return 2
	case KindZst:
		return 1
	}
	return 0
}

// Plan is what a prune does to one (host, path).
type Plan struct {
	Keep []Version
	// DropPointers are deleted first, then Drop: a prune cut off halfway never strands a pointer (PEP 0009 §7.3).
	DropPointers []Version
	Drop         []Version
	// Lost are the pointers in DropPointers dropped because their bytes are gone: no full object after them and no
	// live file. Their versions are reported (history_lost).
	Lost []Version
}

// PruneGroup is the schedule with PEP 0009's anchors, for the versions of one (host, path) in any form: the schedule
// decides by version id, a keyframe stays while a kept pointer rests on it, a pointer beside a whole copy of the same
// version goes, and a pointer with nothing to rest on is dropped and reported lost. live says the path is in the
// host's manifest, so the live file is the bytes a last pointer rests on.
func PruneGroup(versions []Version, now time.Time, keepDays int, live bool) Plan {
	byID := map[string][]Version{}
	var ids []string
	for _, v := range versions {
		if _, seen := byID[v.Version]; !seen {
			ids = append(ids, v.Version)
		}
		byID[v.Version] = append(byID[v.Version], v)
	}
	sort.Strings(ids)
	rep := map[string]Version{}
	var reps []Version
	for _, id := range ids {
		forms := byID[id]
		best := forms[0]
		for _, f := range forms[1:] {
			if formRank(f.Kind) < formRank(best.Kind) {
				best = f
			}
		}
		rep[id] = best
		reps = append(reps, best)
	}
	scheduled, _ := Prune(reps, now, keepDays)
	keepID := map[string]bool{}
	for _, v := range scheduled {
		keepID[v.Version] = true
	}
	lost := map[string]bool{}
	for _, id := range ids {
		if !keepID[id] || rep[id].Kind != KindPrefix {
			continue
		}
		if anchor, ok := Anchor(reps, id); ok {
			keepID[anchor.Version] = true // the keyframe stays while this pointer does, however the schedule sees it
		} else if !live {
			lost[id] = true
		}
	}
	var plan Plan
	for _, id := range ids {
		for _, v := range byID[id] {
			switch {
			case lost[id]:
				plan.DropPointers = append(plan.DropPointers, v)
				plan.Lost = append(plan.Lost, v)
			case !keepID[id] && v.Kind == KindPrefix:
				plan.DropPointers = append(plan.DropPointers, v)
			case !keepID[id]:
				plan.Drop = append(plan.Drop, v)
			case v.Kind == KindPrefix && rep[id].Kind != KindPrefix:
				plan.DropPointers = append(plan.DropPointers, v) // the whole copy is the version
			default:
				plan.Keep = append(plan.Keep, v)
			}
		}
	}
	return plan
}
