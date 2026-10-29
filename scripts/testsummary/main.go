// Command testsummary reads `go test -json` on stdin and prints a Markdown summary for the CI job summary:
// how many tests ran, passed, failed and skipped per package, with the e2e package first and every skip's reason.
//
//	go test -json ./... | go run ./scripts/testsummary -os "$RUNNER_OS" >> "$GITHUB_STEP_SUMMARY"
//	go run ./scripts/testsummary -failures < test.json     what every failed test printed (the log the -json stream hides)
//
// WHY: a skipped end-to-end test looks green and tests nothing. The summary puts "ran" and "skipped" side by side per
// OS, so a runner where the e2e quietly skipped is visible at a glance (test.yml also sets FOLDER_SYNC_E2E_REQUIRE=1,
// which turns a skip for a missing tool into a failure).
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
)

type event struct {
	Action  string `json:"Action"`
	Package string `json:"Package"`
	Test    string `json:"Test"`
	Output  string `json:"Output"`
}

// Counts is one package's tally of tests (top-level) and subtests (names with a "/").
type Counts struct {
	Pass, Fail, Skip          int
	SubPass, SubFail, SubSkip int
}

// Skip is a skipped test and the reason it printed.
type Skip struct{ Package, Test, Reason string }

// Summary is everything the report needs.
type Summary struct {
	Packages map[string]*Counts
	Skips    []Skip
	Failed   []string
	// FailedOutput is what each failed test (key "pkg test") or failed package (key "pkg") printed
	FailedOutput map[string][]string
}

// Parse reads a go test -json stream. Lines that are not JSON (a build failure printed raw) are ignored.
func Parse(r io.Reader) Summary {
	sum := Summary{Packages: map[string]*Counts{}, FailedOutput: map[string][]string{}}
	output := map[string][]string{} // package + "\x00" + test -> its output lines (test "" is the package's own)
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 1<<20), 64<<20)
	for scanner.Scan() {
		var ev event
		if json.Unmarshal(scanner.Bytes(), &ev) != nil || ev.Package == "" {
			continue
		}
		key := ev.Package + "\x00" + ev.Test
		if ev.Action == "output" {
			output[key] = append(output[key], ev.Output)
			continue
		}
		if ev.Test == "" || (ev.Action != "pass" && ev.Action != "fail" && ev.Action != "skip") {
			if ev.Test == "" && ev.Action == "fail" {
				sum.Failed = append(sum.Failed, ev.Package+" (package)")
				sum.FailedOutput[ev.Package] = output[key]
			}
			continue
		}
		c := sum.Packages[ev.Package]
		if c == nil {
			c = &Counts{}
			sum.Packages[ev.Package] = c
		}
		sub := strings.Contains(ev.Test, "/")
		switch ev.Action {
		case "pass":
			if sub {
				c.SubPass++
			} else {
				c.Pass++
			}
		case "fail":
			sum.Failed = append(sum.Failed, ev.Package+" "+ev.Test)
			sum.FailedOutput[ev.Package+" "+ev.Test] = output[key]
			if sub {
				c.SubFail++
			} else {
				c.Fail++
			}
		case "skip":
			sum.Skips = append(sum.Skips, Skip{ev.Package, ev.Test, skipReason(output[key])})
			if sub {
				c.SubSkip++
			} else {
				c.Skip++
			}
		}
	}
	sort.Slice(sum.Skips, func(i, j int) bool {
		return sum.Skips[i].Package+sum.Skips[i].Test < sum.Skips[j].Package+sum.Skips[j].Test
	})
	return sum
}

// skipReason is the message t.Skip printed: the output lines that are not the "=== RUN" / "--- SKIP" frame.
func skipReason(lines []string) string {
	var parts []string
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "=== ") || strings.HasPrefix(trimmed, "--- ") {
			continue
		}
		// "    e2e_test.go:346: node not found" -> "node not found"
		if i := strings.Index(trimmed, ": "); i > 0 && strings.Contains(trimmed[:i], ".go:") {
			trimmed = trimmed[i+2:]
		}
		parts = append(parts, trimmed)
	}
	return strings.Join(parts, " ")
}

func (c Counts) ran() int    { return c.Pass + c.Fail }
func (c Counts) subRan() int { return c.SubPass + c.SubFail }

// Render writes the Markdown. e2e is the package path whose line leads the summary.
func Render(w io.Writer, sum Summary, title, e2e string) {
	fmt.Fprintf(w, "### %s\n\n", title)
	if c := sum.Packages[e2e]; c != nil {
		fmt.Fprintf(w, "**e2e: %d tests ran, %d skipped; %d subtests ran, %d skipped; %d failed**\n\n",
			c.ran(), c.Skip, c.subRan(), c.SubSkip, c.Fail+c.SubFail)
	} else {
		fmt.Fprintf(w, "**e2e: no tests were reported (%s)**\n\n", e2e)
	}
	var names []string
	for name := range sum.Packages {
		names = append(names, name)
	}
	sort.Strings(names)
	fmt.Fprintln(w, "| package | ran | passed | failed | skipped | subtests ran | subtests skipped |")
	fmt.Fprintln(w, "|---|--:|--:|--:|--:|--:|--:|")
	var total Counts
	for _, name := range names {
		c := sum.Packages[name]
		fmt.Fprintf(w, "| %s | %d | %d | %d | %d | %d | %d |\n", name, c.ran(), c.Pass, c.Fail, c.Skip, c.subRan(), c.SubSkip)
		total.Pass += c.Pass
		total.Fail += c.Fail
		total.Skip += c.Skip
		total.SubPass += c.SubPass
		total.SubFail += c.SubFail
		total.SubSkip += c.SubSkip
	}
	fmt.Fprintf(w, "| **all** | %d | %d | %d | %d | %d | %d |\n\n", total.ran(), total.Pass, total.Fail, total.Skip, total.subRan(), total.SubSkip)
	if len(sum.Failed) > 0 {
		fmt.Fprintln(w, "Failed:")
		for _, name := range sum.Failed {
			fmt.Fprintf(w, "- `%s`\n", name)
		}
		fmt.Fprintln(w)
	}
	if len(sum.Skips) > 0 {
		fmt.Fprint(w, "<details><summary>Skipped tests and why</summary>\n\n")
		for _, s := range sum.Skips {
			reason := s.Reason
			if reason == "" {
				reason = "(no reason printed)"
			}
			quarantined := ""
			if strings.Contains(reason, "QUARANTINED") {
				quarantined = " **quarantined**"
			}
			fmt.Fprintf(w, "- `%s` `%s`%s: %s\n", strings.TrimPrefix(s.Package, "folder-sync/"), s.Test, quarantined, reason)
		}
		fmt.Fprintln(w, "\n</details>")
	}
}

// PrintFailures writes what the failed tests printed, so a red job's log says why without opening the JSON.
func PrintFailures(w io.Writer, sum Summary) {
	names := make([]string, 0, len(sum.FailedOutput))
	for name := range sum.FailedOutput {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		fmt.Fprintf(w, "::group::FAILED %s\n%s\n::endgroup::\n", name, strings.Join(sum.FailedOutput[name], ""))
	}
}

func main() {
	failures := flag.Bool("failures", false, "print what every failed test printed, instead of the summary")
	title := flag.String("os", "", "the runner's OS, for the heading")
	e2e := flag.String("e2e", "folder-sync/e2e", "the package whose counts lead the summary")
	flag.Parse()
	if *failures {
		PrintFailures(os.Stdout, Parse(os.Stdin))
		return
	}
	heading := "go test"
	if *title != "" {
		heading += " on " + *title
	}
	Render(os.Stdout, Parse(os.Stdin), heading, *e2e)
}
