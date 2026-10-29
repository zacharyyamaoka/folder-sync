package testtools

import (
	"runtime"
	"strings"
	"testing"
)

// fakeT records what Missing did, since a real t.Fatalf/t.Skipf would end this test.
type fakeT struct {
	testing.TB
	failed, skipped string
}

func (f *fakeT) Helper()                           {}
func (f *fakeT) Fatalf(format string, args ...any) { f.failed = format; panic(f) }
func (f *fakeT) Skipf(format string, args ...any)  { f.skipped = format; panic(f) }

func missing(t *testing.T) (f *fakeT) {
	f = &fakeT{}
	defer func() { recover() }()
	Missing(f, "no tool")
	return f
}

func TestMissingSkipsLocallyAndFailsWhenRequired(t *testing.T) {
	t.Setenv(RequireEnv, "")
	if f := missing(t); f.skipped == "" || f.failed != "" {
		t.Errorf("without %s a missing tool skips: %+v", RequireEnv, f)
	}
	t.Setenv(RequireEnv, "0")
	if f := missing(t); f.skipped == "" || f.failed != "" {
		t.Errorf("%s=0 is off: %+v", RequireEnv, f)
	}
	t.Setenv(RequireEnv, "1")
	if f := missing(t); f.failed == "" || f.skipped != "" || !strings.Contains(f.failed, RequireEnv) {
		t.Errorf("with %s=1 a missing tool fails, naming the switch: %+v", RequireEnv, f)
	}
}

func TestPinnedRcloneHasTheExecutableSuffix(t *testing.T) {
	want := "rclone"
	if runtime.GOOS == "windows" {
		want = "rclone.exe"
	}
	if got := PinnedRcloneIn("/repo"); !strings.HasSuffix(got, want) || !strings.Contains(got, ".tools") {
		t.Errorf("PinnedRcloneIn = %s", got)
	}
}

func TestMissingPinnedRcloneFailsWhenRequired(t *testing.T) {
	empty := t.TempDir() // a checkout where scripts/dev-tools was never run
	run := func() (f *fakeT) {
		f = &fakeT{}
		defer func() { recover() }()
		PinnedRclone(f, empty)
		return f
	}
	t.Setenv(RequireEnv, "")
	if f := run(); f.skipped == "" || f.failed != "" {
		t.Errorf("locally a missing rclone skips: %+v", f)
	}
	t.Setenv(RequireEnv, "1")
	if f := run(); f.failed == "" || f.skipped != "" {
		t.Errorf("in CI a missing rclone fails: %+v", f)
	}
}
