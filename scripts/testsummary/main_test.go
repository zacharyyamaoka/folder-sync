package main

import (
	"bytes"
	"strings"
	"testing"
)

const stream = `{"Action":"run","Package":"folder-sync/e2e","Test":"TestTwoMachines"}
{"Action":"run","Package":"folder-sync/e2e","Test":"TestTwoMachines/init"}
{"Action":"output","Package":"folder-sync/e2e","Test":"TestTwoMachines/init","Output":"=== RUN   TestTwoMachines/init\n"}
{"Action":"pass","Package":"folder-sync/e2e","Test":"TestTwoMachines/init"}
{"Action":"output","Package":"folder-sync/e2e","Test":"TestTwoMachines/watch","Output":"    e2e_test.go:346: node ≥ 22.18 not found\n"}
{"Action":"output","Package":"folder-sync/e2e","Test":"TestTwoMachines/watch","Output":"--- SKIP: TestTwoMachines/watch (0.00s)\n"}
{"Action":"skip","Package":"folder-sync/e2e","Test":"TestTwoMachines/watch"}
{"Action":"pass","Package":"folder-sync/e2e","Test":"TestTwoMachines"}
{"Action":"fail","Package":"folder-sync/e2e","Test":"TestBroken"}
{"Action":"fail","Package":"folder-sync/e2e"}
{"Action":"pass","Package":"folder-sync/internal/names","Test":"TestLint"}
{"Action":"skip","Package":"folder-sync/internal/names","Test":"TestQ"}
this line is not json
`

func TestSummaryCountsRanAndSkippedAndKeepsTheReason(t *testing.T) {
	sum := Parse(strings.NewReader(stream))
	e2e := sum.Packages["folder-sync/e2e"]
	if e2e.Pass != 1 || e2e.Fail != 1 || e2e.SubPass != 1 || e2e.SubSkip != 1 {
		t.Errorf("e2e counts: %+v", *e2e)
	}
	var out bytes.Buffer
	Render(&out, sum, "go test on Linux", "folder-sync/e2e")
	text := out.String()
	for _, want := range []string{
		"**e2e: 2 tests ran, 0 skipped; 1 subtests ran, 1 skipped; 1 failed**",
		"| folder-sync/internal/names | 1 | 1 | 0 | 1 | 0 | 0 |",
		"`e2e` `TestTwoMachines/watch`: node ≥ 22.18 not found",
		"- `folder-sync/e2e TestBroken`",
		"- `folder-sync/e2e (package)`",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("summary lacks %q:\n%s", want, text)
		}
	}
}

func TestFailuresShowWhatTheFailedTestPrinted(t *testing.T) {
	in := `{"Action":"output","Package":"p","Test":"TestA","Output":"    a_test.go:9: boom\n"}
{"Action":"fail","Package":"p","Test":"TestA"}
{"Action":"output","Package":"q","Output":"build failed: no such file\n"}
{"Action":"fail","Package":"q"}
`
	var out bytes.Buffer
	PrintFailures(&out, Parse(strings.NewReader(in)))
	for _, want := range []string{"::group::FAILED p TestA", "a_test.go:9: boom", "::group::FAILED q", "build failed: no such file"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("failures lack %q:\n%s", want, out.String())
		}
	}
}

func TestSummaryWithoutTheE2ESaysSo(t *testing.T) {
	var out bytes.Buffer
	Render(&out, Parse(strings.NewReader("")), "go test", "folder-sync/e2e")
	if !strings.Contains(out.String(), "no tests were reported") {
		t.Errorf("an empty run must not look like a pass:\n%s", out.String())
	}
}
