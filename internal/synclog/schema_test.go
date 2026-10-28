package synclog

// A strict validator for the subset of JSON Schema 2020-12 that schema/*.schema.json use, the Go twin of
// schema/fixtures.test.mjs's. WHY strict: any keyword it does not know fails the test, so a schema can never use a
// keyword these tests silently ignore. WHY not a library: go.mod has none, and the gate must not fetch one.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

var schemaDir = filepath.Join("..", "..", "schema")

var (
	dateTime    = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$`)
	annotations = map[string]bool{"$schema": true, "$id": true, "$comment": true, "$defs": true, "title": true, "description": true, "examples": true}
	keywords    = map[string]bool{"$ref": true, "type": true, "const": true, "enum": true, "pattern": true, "minLength": true,
		"maxLength": true, "format": true, "minimum": true, "maximum": true, "required": true, "properties": true,
		"additionalProperties": true, "items": true, "minItems": true, "maxItems": true, "uniqueItems": true, "allOf": true,
		"anyOf": true, "oneOf": true, "not": true, "if": true, "then": true, "else": true}
)

type validator struct {
	t     *testing.T
	files map[string]any
}

func newValidator(t *testing.T) *validator { return &validator{t: t, files: map[string]any{}} }

func decode(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return v, nil
}

func (v *validator) file(name string) any {
	if doc, ok := v.files[name]; ok {
		return doc
	}
	data, err := os.ReadFile(filepath.Join(schemaDir, name))
	if err != nil {
		v.t.Fatal(err)
	}
	doc, err := decode(data)
	if err != nil {
		v.t.Fatalf("%s: %v", name, err)
	}
	v.files[name] = doc
	return doc
}

func (v *validator) resolve(ref, file string) (any, string) {
	target, pointer, _ := strings.Cut(ref, "#")
	if target == "" {
		target = file
	}
	node := v.file(target)
	for _, part := range strings.Split(pointer, "/") {
		if part == "" {
			continue
		}
		obj, ok := node.(map[string]any)
		if !ok {
			v.t.Fatalf("unresolvable $ref %s in %s", ref, file)
		}
		if node, ok = obj[strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")]; !ok {
			v.t.Fatalf("unresolvable $ref %s in %s", ref, file)
		}
	}
	return node, target
}

func typeOf(value any) string {
	switch x := value.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case string:
		return "string"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	case json.Number:
		if _, err := x.Int64(); err == nil {
			return "integer"
		}
		return "number"
	}
	return fmt.Sprintf("%T", value)
}

func number(value any) float64 {
	f, _ := value.(json.Number).Float64()
	return f
}

func same(a, b any) bool {
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	return bytes.Equal(ja, jb)
}

// check is the errors of value against schema (a node of file), each "<json path>: <reason>"; none when valid.
func (v *validator) check(value, schema any, file, at string) []string {
	if b, ok := schema.(bool); ok {
		if b {
			return nil
		}
		return []string{at + ": no value is allowed here"}
	}
	s := schema.(map[string]any)
	for key := range s {
		if !keywords[key] && !annotations[key] {
			v.t.Fatalf("%s: keyword %s is not supported by this test", file, key)
		}
	}
	var errs []string
	t := typeOf(value)
	if ref, ok := s["$ref"].(string); ok {
		node, f := v.resolve(ref, file)
		errs = append(errs, v.check(value, node, f, at)...)
	}
	if want, ok := s["type"]; ok {
		types := []any{want}
		if list, ok := want.([]any); ok {
			types = list
		}
		match := false
		for _, w := range types {
			match = match || w == t || (w == "number" && t == "integer")
		}
		if !match {
			errs = append(errs, fmt.Sprintf("%s: is %s, want %v", at, t, want))
		}
	}
	if c, ok := s["const"]; ok && !same(value, c) {
		errs = append(errs, fmt.Sprintf("%s: is not %v", at, c))
	}
	if enum, ok := s["enum"].([]any); ok {
		match := false
		for _, e := range enum {
			match = match || same(value, e)
		}
		if !match {
			errs = append(errs, fmt.Sprintf("%s: %v is not one of %v", at, value, enum))
		}
	}
	if str, ok := value.(string); ok {
		if p, ok := s["pattern"].(string); ok && !regexp.MustCompile(p).MatchString(str) {
			errs = append(errs, fmt.Sprintf("%s: %q does not match %s", at, str, p))
		}
		n := float64(utf8.RuneCountInString(str))
		if m, ok := s["minLength"]; ok && n < number(m) {
			errs = append(errs, fmt.Sprintf("%s: shorter than %v", at, m))
		}
		if m, ok := s["maxLength"]; ok && n > number(m) {
			errs = append(errs, fmt.Sprintf("%s: longer than %v", at, m))
		}
		if f, ok := s["format"]; ok {
			if f != "date-time" {
				v.t.Fatalf("%s: format %v is not supported by this test", file, f)
			}
			_, err := time.Parse(time.RFC3339Nano, str)
			if !dateTime.MatchString(str) || err != nil {
				errs = append(errs, fmt.Sprintf("%s: %q is not an RFC 3339 date-time", at, str))
			}
		}
	}
	if t == "integer" || t == "number" {
		if m, ok := s["minimum"]; ok && number(value) < number(m) {
			errs = append(errs, fmt.Sprintf("%s: below %v", at, m))
		}
		if m, ok := s["maximum"]; ok && number(value) > number(m) {
			errs = append(errs, fmt.Sprintf("%s: above %v", at, m))
		}
	}
	if obj, ok := value.(map[string]any); ok {
		for _, key := range listOf(s["required"]) {
			if _, ok := obj[key.(string)]; !ok {
				errs = append(errs, fmt.Sprintf("%s: %s is required", at, key))
			}
		}
		props, _ := s["properties"].(map[string]any)
		for key, val := range obj {
			if sub, ok := props[key]; ok {
				errs = append(errs, v.check(val, sub, file, at+"."+key)...)
			} else if extra, ok := s["additionalProperties"]; ok {
				errs = append(errs, v.check(val, extra, file, at+"."+key)...)
			}
		}
	}
	if arr, ok := value.([]any); ok {
		if items, ok := s["items"]; ok {
			for i, item := range arr {
				errs = append(errs, v.check(item, items, file, fmt.Sprintf("%s[%d]", at, i))...)
			}
		}
		if m, ok := s["minItems"]; ok && float64(len(arr)) < number(m) {
			errs = append(errs, fmt.Sprintf("%s: fewer than %v items", at, m))
		}
		if m, ok := s["maxItems"]; ok && float64(len(arr)) > number(m) {
			errs = append(errs, fmt.Sprintf("%s: more than %v items", at, m))
		}
		if s["uniqueItems"] == true {
			seen := map[string]bool{}
			for _, item := range arr {
				j, _ := json.Marshal(item)
				if seen[string(j)] {
					errs = append(errs, at+": items are not unique")
					break
				}
				seen[string(j)] = true
			}
		}
	}
	for _, sub := range listOf(s["allOf"]) {
		errs = append(errs, v.check(value, sub, file, at)...)
	}
	if anyOf := listOf(s["anyOf"]); anyOf != nil {
		match := false
		for _, sub := range anyOf {
			match = match || len(v.check(value, sub, file, at)) == 0
		}
		if !match {
			errs = append(errs, at+": matches none of anyOf")
		}
	}
	if oneOf := listOf(s["oneOf"]); oneOf != nil {
		n := 0
		for _, sub := range oneOf {
			if len(v.check(value, sub, file, at)) == 0 {
				n++
			}
		}
		if n != 1 {
			errs = append(errs, fmt.Sprintf("%s: matches %d of oneOf, want exactly 1", at, n))
		}
	}
	if not, ok := s["not"]; ok && len(v.check(value, not, file, at)) == 0 {
		errs = append(errs, at+": matches a schema it must not")
	}
	if cond, ok := s["if"]; ok {
		branch, has := s["else"]
		if len(v.check(value, cond, file, at)) == 0 {
			branch, has = s["then"]
		}
		if has {
			errs = append(errs, v.check(value, branch, file, at)...)
		}
	}
	return errs
}

func listOf(x any) []any {
	list, _ := x.([]any)
	return list
}

// line is the errors of one JSON line against schema/event.schema.json.
func (v *validator) line(data []byte) []string {
	value, err := decode(data)
	if err != nil {
		return []string{"not JSON: " + err.Error()}
	}
	return v.check(value, v.file("event.schema.json"), "event.schema.json", "$")
}

// fixtureLines reads testdata/events/<name>, one JSON object per non-blank line.
func fixtureLines(t *testing.T, name string) [][]byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "events", name))
	if err != nil {
		t.Fatal(err)
	}
	var out [][]byte
	for _, l := range bytes.Split(data, []byte("\n")) {
		if len(bytes.TrimSpace(l)) > 0 {
			out = append(out, l)
		}
	}
	return out
}

// The ruler first: every shared fixture passes it, and lines that break the schema fail it, so a green result from
// it below means something.
func TestValidatorAgreesWithTheFixtures(t *testing.T) {
	v := newValidator(t)
	for _, name := range []string{"desktop.jsonl", "file-events.jsonl"} {
		for i, l := range fixtureLines(t, name) {
			if errs := v.line(l); len(errs) > 0 {
				t.Errorf("%s line %d: %v", name, i+1, errs)
			}
		}
	}
	for _, bad := range []string{
		`{"schema":"folder-sync-event/1","event":"round","at":"yesterday"}`,
		`{"schema":"folder-sync-event/2","event":"round","at":"2026-10-28T20:41:00Z"}`,
		`{"schema":"folder-sync-event/1","event":"upload","at":"2026-10-28T20:41:00Z","path":"a.md","size":1,"op":"add"}`,
		`{"schema":"folder-sync-event/1","event":"upload","at":"2026-10-28T20:41:00Z","path":"a.md","size":1,"sha256":"` + strings.Repeat("a", 64) + `","op":"edit"}`,
		`{"schema":"folder-sync-event/1","event":"skip","at":"2026-10-28T20:41:00Z","path":"CON","why":"x","level":"info"}`,
		`{"schema":"folder-sync-event/1","event":"truncated","at":"2026-10-28T20:41:00Z"}`,
		`{"schema":"folder-sync-event/1","event":"delete","at":"2026-10-28T20:41:00Z","path":"a.md","was":{"sha256":"` + strings.Repeat("a", 64) + `","size":1,"written_at":"2026-10-28T20:41:00Z","kept":null}}`,
		`{"schema":"folder-sync-event/1","event":"download","at":"2026-10-28T20:41:00Z","peer":"web","path":"a.md"}`,
		`{"schema":"folder-sync-event/1","event":"upload","at":"2026-10-28T20:41:00Z","path":"../a.md","size":1,"sha256":"` + strings.Repeat("a", 64) + `","op":"add"}`,
	} {
		if errs := v.line([]byte(bad)); len(errs) == 0 {
			t.Errorf("the validator passed a line the schema refuses: %s", bad)
		}
	}
}
