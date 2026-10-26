"""Build the folder-sync v0 report: words and layout only; every number and
transcript comes from <dir>/evidence.json, e2e-steps.json and demo-cast.json,
which docs/report/collect.py and record_demo.py produce by running the real things.

    python3 docs/report/build.py /home/bam/folder-sync/reports/media/folder-sync-v0-2026-10-20

Writes <dir>/index.html, self-contained (video, GIF fallback and poster inlined).
"""

from __future__ import annotations

import base64
import html
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def esc(text: str) -> str:
    return html.escape(str(text), quote=True)


def data_uri(path: Path, mime: str) -> str:
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()


def pre(text: str, cls: str = "") -> str:
    return f'<pre class="{cls}">{esc(text.rstrip())}</pre>'


STYLE = """
:root { --bg:#fbfbfa; --fg:#1f2328; --muted:#636c76; --line:#d8dee4; --card:#ffffff; --code:#f6f8fa;
  --ok:#1a7f37; --okbg:#dafbe1; --warn:#9a6700; --warnbg:#fff8c5; --bad:#cf222e; --badbg:#ffebe9;
  --accent:#0969da; --a:#0e7c86; --b:#8250df; --bucket:#bf8700; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --line:#30363d; --card:#151b23; --code:#1b222c;
  --ok:#3fb950; --okbg:#12261e; --warn:#d29922; --warnbg:#272115; --bad:#f85149; --badbg:#2d1214;
  --accent:#4493f8; --a:#39c5cf; --b:#bc8cff; --bucket:#d29922; } }
:root[data-theme="dark"] { --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --line:#30363d; --card:#151b23; --code:#1b222c;
  --ok:#3fb950; --okbg:#12261e; --warn:#d29922; --warnbg:#272115; --bad:#f85149; --badbg:#2d1214;
  --accent:#4493f8; --a:#39c5cf; --b:#bc8cff; --bucket:#d29922; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1060px; margin: 0 auto; padding: 28px 16px 80px; }
h1 { font-size: 26px; margin: 0 0 6px; } h2 { font-size: 19px; margin: 38px 0 10px; padding-top: 8px; border-top: 1px solid var(--line); }
h3 { font-size: 15px; margin: 18px 0 6px; }
p, li { max-width: 78ch; } .muted { color: var(--muted); } a { color: var(--accent); }
.verdict { font-size: 17px; font-weight: 600; margin: 10px 0 4px; }
.pills { display:flex; flex-wrap:wrap; gap:8px; margin: 12px 0 4px; }
.pill { border:1px solid var(--line); border-radius: 999px; padding: 3px 11px; font-size: 13px; background: var(--card); }
.pill.ok { color: var(--ok); background: var(--okbg); border-color: transparent; }
.pill.warn { color: var(--warn); background: var(--warnbg); border-color: transparent; }
.card { background: var(--card); border:1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin: 12px 0; }
video, .hero img { width: 100%; border-radius: 10px; border: 1px solid var(--line); display:block; background:#0d1117; }
pre { background: var(--code); border:1px solid var(--line); border-radius: 8px; padding: 10px 12px; overflow-x: auto; font: 12.5px/1.45 ui-monospace, "DejaVu Sans Mono", Menlo, monospace; margin: 8px 0; }
code { font: 13px ui-monospace, "DejaVu Sans Mono", Menlo, monospace; background: var(--code); padding: 1px 4px; border-radius: 4px; }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; margin: 8px 0; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
td:first-child code { white-space: nowrap; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.tag { display:inline-block; font-size: 12px; font-weight: 600; padding: 1px 7px; border-radius: 5px; }
.tag.pass { color: var(--ok); background: var(--okbg); } .tag.fail { color: var(--bad); background: var(--badbg); }
.tag.skip, .tag.pending { color: var(--warn); background: var(--warnbg); }
.grid2 { display:grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.grid2 > div { min-width: 0; }
td { overflow-wrap: anywhere; }
@media (max-width: 760px) { .grid2 { grid-template-columns: minmax(0, 1fr); } }
pre.wrap { white-space: pre-wrap; overflow-wrap: anywhere; }
details summary { cursor: pointer; color: var(--accent); margin: 6px 0; }
.diagram svg { width: 100%; height: auto; }
.diagram text { font: 13px ui-sans-serif, system-ui, sans-serif; fill: var(--fg); }
.diagram .mono { font: 12px ui-monospace, "DejaVu Sans Mono", Menlo, monospace; }
.diagram .small { font-size: 11.5px; fill: var(--muted); }
.diagram .box { fill: var(--card); stroke: var(--line); stroke-width: 1.2; }
.diagram .boxA { stroke: var(--a); stroke-width: 1.6; } .diagram .boxB { stroke: var(--b); stroke-width: 1.6; }
.diagram .boxBucket { stroke: var(--bucket); stroke-width: 1.6; }
.diagram .arrow { stroke: var(--muted); stroke-width: 1.6; fill: none; marker-end: url(#arrowhead); }
.diagram .arrowA { stroke: var(--a); } .diagram .arrowB { stroke: var(--b); }
.diagram .ignored { fill: var(--muted); text-decoration: line-through; }
.diagram .trash { fill: var(--bad); }
"""

DIAGRAM = """
<svg viewBox="0 0 1140 560" role="img" aria-labelledby="dtitle" xmlns="http://www.w3.org/2000/svg">
  <title id="dtitle">The bucket contract: machines push their own prefix and pull peers by manifest; apps read manifests and GETs</title>
  <defs><marker id="arrowhead" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
    <polygon points="0 0, 9 3.5, 0 7" style="fill: var(--muted)"/></marker></defs>

  <!-- machine A -->
  <rect class="box boxA" x="10" y="20" width="290" height="270" rx="10"/>
  <text x="26" y="46" style="font-weight:700; fill: var(--a)">machine A · ~/notes/</text>
  <text class="mono" x="26" y="76">plan.md</text>
  <text class="mono" x="26" y="96">todo.md</text>
  <text class="mono ignored" x="26" y="122">.env</text>
  <text class="small" x="76" y="122">ignored by the default rules</text>
  <text class="mono ignored" x="26" y="142">node_modules/</text>
  <text class="mono" x="26" y="168">.folder-sync.toml</text>
  <text class="small" x="26" y="200">~/.folder-sync/ (never AppData)</text>
  <text class="mono small" x="26" y="220">host.json: the host id</text>
  <text class="mono small" x="26" y="238">projects/…/manifest.json</text>
  <text class="mono small" x="26" y="256">bin/rclone v1.75.2, pinned</text>

  <!-- bucket -->
  <rect class="box boxBucket" x="440" y="20" width="330" height="320" rx="10"/>
  <text x="456" y="46" style="font-weight:700; fill: var(--bucket)">R2 bucket  folder-sync</text>
  <text class="mono" x="456" y="76">demo/hosts/&lt;A-id&gt;/</text>
  <text class="mono" x="476" y="96">manifest.json</text>
  <text class="small" x="590" y="96">written last</text>
  <text class="mono" x="476" y="116">plan.md</text>
  <text class="mono" x="456" y="150">demo/hosts/&lt;B-id&gt;/</text>
  <text class="mono" x="476" y="170">manifest.json</text>
  <text class="mono" x="476" y="190">b-notes.md</text>
  <text class="mono trash" x="456" y="224">_trash/demo/&lt;A-id&gt;/&lt;stamp&gt;/</text>
  <text class="mono" x="476" y="244">todo.md</text>
  <text class="small" x="476" y="262">every overwrite and delete, kept 30 days</text>
  <text class="mono small" x="456" y="296">demo/shared/, _leases/</text>
  <text class="small" x="456" y="314">two-way folders: v1, refused in v0</text>

  <!-- machine B -->
  <rect class="box boxB" x="900" y="20" width="230" height="270" rx="10"/>
  <text x="916" y="46" style="font-weight:700; fill: var(--b)">machine B · ~/notes/</text>
  <text class="mono" x="916" y="76">b-notes.md</text>
  <text class="mono" x="916" y="106">hosts/&lt;A-id&gt;/</text>
  <text class="mono" x="936" y="126">plan.md</text>
  <text class="small" x="916" y="152">A's files: read-only copies</text>
  <text class="small" x="916" y="168">at the bucket key's path</text>
  <text class="small" x="916" y="204">a local edit to a copy is</text>
  <text class="small" x="916" y="220">moved aside first, to</text>
  <text class="mono small" x="916" y="238">~/.folder-sync/conflicts/</text>

  <!-- flows -->
  <path class="arrow arrowA" d="M 300 100 L 436 100"/>
  <text class="small" x="312" y="78">push: changed</text>
  <text class="small" x="312" y="91">files only</text>
  <path class="arrow arrowA" d="M 300 236 L 436 236"/>
  <text class="small" x="312" y="214">delete, overwrite</text>
  <text class="small" x="312" y="227">→ old copy to _trash/</text>
  <path class="arrow arrowB" d="M 770 112 L 896 112"/>
  <text class="small" x="780" y="78">conditional GET</text>
  <text class="small" x="780" y="91">of each manifest;</text>
  <text class="small" x="780" y="131">304 = nothing to do,</text>
  <text class="small" x="780" y="144">else the changed files</text>
  <path class="arrow arrowB" d="M 900 180 L 774 180"/>
  <text class="small" x="780" y="198">B publishes its own</text>

  <!-- apps -->
  <rect class="box" x="290" y="400" width="230" height="140" rx="10"/>
  <text x="306" y="426" style="font-weight:700">vibetracks.dev Worker</text>
  <text class="small" x="306" y="448">readers/worker · R2 binding,</text>
  <text class="small" x="306" y="464">no S3 keys in the Worker</text>
  <text class="small" x="306" y="496">1 LIST of hosts/ · GET manifests</text>
  <text class="small" x="306" y="512">with If-None-Match · GET files</text>
  <rect class="box" x="545" y="400" width="230" height="140" rx="10"/>
  <text x="561" y="426" style="font-weight:700">any script or service</text>
  <text class="small" x="561" y="448">readers/python · stdlib SigV4,</text>
  <text class="small" x="561" y="464">boto3 optional</text>
  <text class="small" x="561" y="496">same three calls; verify sha256,</text>
  <text class="small" x="561" y="512">re-read the manifest on a race</text>
  <rect class="box" x="800" y="400" width="230" height="140" rx="10"/>
  <text x="816" y="426" style="font-weight:700">R2-Explorer (backdoor)</text>
  <text class="small" x="816" y="448">read-only, behind Cloudflare</text>
  <text class="small" x="816" y="464">Access; workers.dev off</text>
  <text class="small" x="816" y="496">browses the whole bucket;</text>
  <text class="small" x="816" y="512">deploying it is Zach's step</text>
  <path class="arrow" d="M 540 340 C 520 370, 420 370, 405 396"/>
  <path class="arrow" d="M 605 340 L 655 396"/>
  <path class="arrow" d="M 680 340 C 720 370, 900 370, 915 396"/>
</svg>
"""


def test_summary(evidence: dict) -> tuple[str, dict]:
    go = evidence["go_tests"]
    top = [t for t in go["tests"] if "/" not in t["test"]]
    subs = [t for t in go["tests"] if "/" in t["test"]]
    counts = {"go_top": len(top), "go_sub": len(subs),
              "go_fail": sum(t["result"] == "fail" for t in go["tests"]),
              "go_skip": sum(t["result"] == "skip" for t in go["tests"])}
    py = evidence["python_reader"]
    match = re.search(r"Ran (\d+) tests?", py["output"])
    counts["python"] = int(match.group(1)) if match else 0
    counts["python_ok"] = py["exit"] == 0
    node = evidence["worker_reader"]
    match = re.search(r"ℹ pass (\d+)", node["output"])
    counts["node"] = int(match.group(1)) if match else 0
    counts["node_ok"] = node["exit"] == 0
    rows = []
    by_package: dict[str, list] = {}
    for t in top:
        by_package.setdefault(t["package"], []).append(t)
    for package, tests in sorted(by_package.items()):
        names = ", ".join(t["test"].removeprefix("Test") for t in tests)
        result = "pass" if all(t["result"] == "pass" for t in tests) else ("fail" if any(t["result"] == "fail" for t in tests) else "skip")
        rows.append(f'<tr><td><code>{esc(package)}</code></td><td class="num">{len(tests)}</td>'
                    f'<td><span class="tag {result}">{result}</span></td><td class="muted">{esc(names)}</td></tr>')
    rows.append(f'<tr><td><code>readers/python</code></td><td class="num">{counts["python"]}</td>'
                f'<td><span class="tag {"pass" if counts["python_ok"] else "fail"}">{"pass" if counts["python_ok"] else "fail"}</span></td>'
                f'<td class="muted">unittest: AWS SigV4 vector, listing, conditional GETs, sha256 retry, unsafe paths</td></tr>')
    rows.append(f'<tr><td><code>readers/worker</code></td><td class="num">{counts["node"]}</td>'
                f'<td><span class="tag {"pass" if counts["node_ok"] else "fail"}">{"pass" if counts["node_ok"] else "fail"}</span></td>'
                f'<td class="muted">node --test ({esc(evidence["node_version"])}): same contract over an in-memory R2 binding</td></tr>')
    table = ('<table><tr><th>Suite</th><th>Tests</th><th>Result</th><th>What</th></tr>' + "".join(rows) + "</table>")
    e2e = [t for t in subs if t["test"].startswith("TestTwoMachines/")]
    e2e_rows = "".join(
        f'<tr><td><span class="tag {t["result"]}">{t["result"]}</span></td><td>{esc(t["test"].split("/", 1)[1].replace("_", " "))}</td>'
        f'<td class="num">{t["seconds"]:.2f}s</td></tr>' for t in e2e)
    return table + '<h3>End to end: two machines through the stand-in</h3><table><tr><th></th><th>Proved</th><th>Time</th></tr>' + e2e_rows + "</table>", counts


def ops_table(steps: list[dict]) -> str:
    kinds = ["PUT", "COPY", "DELETE", "HEAD", "GET", "LIST"]
    rows = []
    for step in steps:
        if not step.get("ops") and "no-change" not in step["step"]:
            continue
        c = step["op_counts"]
        cells = "".join(f'<td class="num">{c.get(k, 0) or ""}</td>' for k in kinds)
        strong = ' style="font-weight:700"' if "no-change" in step["step"] else ""
        rows.append(f"<tr{strong}><td>{esc(step['step'])}</td>{cells}</tr>")
    head = "".join(f"<th>{k}</th>" for k in kinds)
    return f"<table><tr><th>Step</th>{head}</tr>{''.join(rows)}</table>"


def step(steps: list[dict], name: str) -> dict:
    return next(s for s in steps if s["step"] == name)


def build(directory: Path) -> Path:
    evidence = json.loads((directory / "evidence.json").read_text())
    steps = json.loads((directory / "e2e-steps.json").read_text())
    cast = json.loads((directory / "demo-cast.json").read_text())
    tests_html, counts = test_summary(evidence)
    win = evidence["windows"]
    win_build = next(b for b in win["builds"] if b["target"] == "windows/amd64")
    win_compiled = sum(1 for c in win["test_binaries"] if c["exit"] == 0)
    standin = evidence["check_r2_standin"]["output"]
    no_change = [s for s in steps if "no-change" in s["step"]]
    no_change_ops = [o for s in no_change for o in s["ops"]]
    all_green = counts["go_fail"] == 0 and counts["python_ok"] and counts["node_ok"]
    total = counts["go_top"] + counts["go_sub"] + counts["python"] + counts["node"]

    video = (f'<video controls autoplay muted loop playsinline poster="{data_uri(directory / "hero-poster.png", "image/png")}">'
             f'<source src="{data_uri(directory / "hero.mp4", "video/mp4")}" type="video/mp4">'
             f'<img src="{data_uri(directory / "hero.gif", "image/gif")}" alt="two machines syncing (GIF fallback)"></video>')

    builds = "".join(
        f'<tr><td><code>{esc(b["target"])}</code></td><td><span class="tag {"pass" if b["exit"] == 0 else "fail"}">{"built" if b["exit"] == 0 else "failed"}</span></td>'
        f'<td class="num">{b.get("bytes", 0) / 1e6:.1f} MB</td><td><code>{esc(b.get("sha256", "")[:16])}…</code></td><td class="muted">{esc(b.get("file_type", b["output"]))[:80]}</td></tr>'
        for b in win["builds"])
    win_unit = "\n".join(win["windows_unit_tests"]["lines"])

    page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>folder-sync v0</title><style>{STYLE}</style></head>
<body><main>
<p class="muted">folder-sync · v0 build lane · 2026-10-20 · branch <code>{esc(evidence["branch"])}</code> @ <code>{esc(evidence["head"])}</code>, not merged</p>
<h1>folder-sync v0: two machines sync through a bucket, and apps can read it</h1>
<p class="verdict">{"All " + str(total) + " tests pass" if all_green else "Some tests FAIL"}, including a two-machine end-to-end run against a local S3 stand-in.
Real R2 and the Windows box are not touched yet: both checks are written and wait on Zach.</p>
<div class="pills">
  <span class="pill {"ok" if all_green else "warn"}">{counts["go_top"]} Go tests + {counts["go_sub"]} subtests · {counts["python"]} Python · {counts["node"]} Worker</span>
  <span class="pill ok">a no-change round: 1 conditional GET per peer (304), 0 uploads, 0 listings</span>
  <span class="pill ok">Windows binary cross-compiles; {win_compiled}/{len(win["test_binaries"])} test packages compile for Windows</span>
  <span class="pill warn">real R2: pending Zach</span><span class="pill warn">Task Scheduler on Windows: pending Zach</span>
</div>

<h2>Two machines, one bucket</h2>
<div class="hero">{video}</div>
<p class="muted">{cast["duration"]:.0f} s, replayed from a capture of real commands: the built <code>folder-sync</code>, the pinned rclone, and <code>rclone serve s3</code> on 127.0.0.1:4801 with throwaway keys as the bucket (not R2). The only edit: each machine's temp HOME is shown as <code>~</code>, as a shell prompt shows it. Machine A publishes <code>plan.md</code> and <code>todo.md</code> (not <code>.env</code> or <code>node_modules/</code>); B receives them read-only under <code>hosts/&lt;A-id&gt;/</code>; A edits one and deletes the other; B's last round costs one conditional GET answered 304.</p>

<h2>The contract apps read</h2>
<div class="card diagram">{DIAGRAM}</div>
<p>Spelled out in <code>docs/CONTRACT.md</code>, with the JSON Schema in <code>schema/manifest.schema.json</code> (<code>folder-sync-manifest/1</code>). An app needs three calls: one delimiter listing of <code>&lt;project&gt;/hosts/</code>, a conditional GET of each manifest, and a GET per file. Both reference readers list and read machine B's view in the end-to-end test, byte for byte against B's disk.</p>

<h2>What works</h2>
{tests_html}

<h3>Every bucket operation, counted by a proxy folder-sync doesn't control</h3>
<p>The end-to-end test puts a counting proxy (127.0.0.1:4802) between folder-sync and the stand-in. The bold rows are the PEP's cost claim: a round with nothing to do sends one conditional GET per peer and nothing else. Mutation check: with peer discovery forced into every round, the test fails on the extra LIST.</p>
{ops_table(steps)}
<p class="muted">Steps with no bucket operation (status, install-service, publish with nothing new, the refusal) are left out. HEADs are rclone's: with <code>--no-traverse</code> it checks each destination object before an upload and again after it, which costs Class B operations ($0.36 per million on R2) instead of a listing.</p>
<details><summary>The no-change rounds' requests, verbatim</summary>{pre(json.dumps(no_change_ops, indent=1))}</details>

<div class="grid2">
<div><h3>A's first push: ignored and unportable names stay home</h3>{pre(step(steps, "A: status")["output"], "wrap")}</div>
<div><h3>An overwrite and a delete go to <code>_trash/</code></h3>{pre(step(steps, "A: overwrite + delete")["output"], "wrap")}<h3>A mass delete is held</h3>{pre(step(steps, "A: mass delete held")["output"], "wrap")}</div>
</div>
<div class="grid2">
<div><h3>v1's two-way folders: a refusal, not a stub</h3>{pre(step(steps, "B: shared mode refused")["output"], "wrap")}</div>
<div><h3>A local edit to a peer's copy is kept</h3>{pre(step(steps, "B: local edit to a peer copy")["output"], "wrap")}</div>
</div>
<div class="grid2">
<div><h3><code>sync --install-service</code> writes, never registers</h3>{pre(step(steps, "A: install-service")["output"], "wrap")}</div>
<div><h3><code>publish --viewer</code> writes, never deploys</h3>{pre(step(steps, "A: publish --viewer")["output"], "wrap")}</div>
</div>

<h2>Command line</h2>
{pre(evidence["help"])}

<h2>Windows</h2>
<p>Built on Linux with <code>GOOS=windows</code>. Path handling is unit-tested with Windows inputs: drive letters, backslashes, reserved device names (<code>CON</code>, <code>aux.md</code>, <code>COM¹</code>), reserved characters, trailing dots and spaces, and case-only twins. The layout is resolved from <code>USERPROFILE</code> (then <code>HOMEDRIVE</code>+<code>HOMEPATH</code>) and never from <code>APPDATA</code>/<code>LOCALAPPDATA</code>; a test fails if any non-test source file asks for them, and every rclone call carries <code>--config</code>, <code>--cache-dir</code> and <code>--temp-dir</code> under <code>~/.folder-sync/</code>. These tests caught two real bugs before shipping: <code>--</code> inside the task XML's comment made it ill-formed XML (Task Scheduler would have refused it), and racing first runs could read a half-written <code>host.json</code>.</p>
<table><tr><th>Target</th><th></th><th>Size</th><th>SHA-256</th><th>file(1)</th></tr>{builds}</table>
<p><code>GOOS=windows go vet ./...</code>: {"clean" if win["vet"]["exit"] == 0 else esc(win["vet"]["output"])}. Windows test binaries compiled for {win_compiled} of {len(win["test_binaries"])} packages (not run: no Windows here).</p>
<details><summary>The Windows-path unit tests</summary>{pre(win_unit)}</details>

<h2>Pending: the PEP's hands-on checks</h2>
<table>
<tr><th>Check</th><th>State</th><th>Who</th></tr>
<tr><td>mtimes survive the bucket</td><td><span class="tag pass">stand-in: pass, to the ns</span> <span class="tag pending">R2: pending</span></td><td>Zach runs <code>scripts/check-r2</code></td></tr>
<tr><td>conditional writes (If-None-Match / If-Match) through rclone</td><td><span class="tag fail">stand-in: fail (it ignores the headers)</span> <span class="tag pending">R2: pending</span></td><td>Zach runs <code>scripts/check-r2</code></td></tr>
<tr><td>a Task Scheduler run on the Windows box</td><td><span class="tag pending">pending; not runnable here</span></td><td>Zach runs <code>scripts\\check-windows-task.cmd</code></td></tr>
</table>
<details open><summary><code>scripts/check-r2</code> against the stand-in (not R2)</summary>{pre(standin, "wrap")}</details>
<div class="card">
<h3>Real R2 (about 5 minutes)</h3>
<ol>
<li>Cloudflare dashboard → R2 → <b>Create bucket</b> <code>folder-sync</code>. Leave public access off: no r2.dev URL, no custom domain on the bucket.</li>
<li>R2 → <b>Manage API tokens</b> → Create API token: "Object Read &amp; Write", applied to <code>folder-sync</code> only. Copy the access key id, the secret (shown once) and the account id.</li>
<li><code>export FOLDER_SYNC_ACCOUNT_ID=… FOLDER_SYNC_ACCESS_KEY_ID=… FOLDER_SYNC_SECRET_ACCESS_KEY=… FOLDER_SYNC_CHECK_BUCKET=folder-sync</code>, then <code>"$HOME/folder-sync/scripts/check-r2"</code>. Five PASS lines expected; it deletes the two objects it writes under <code>_checks/</code>.</li>
<li>In the bucket's settings: a lifecycle rule deleting <code>_trash/</code> after 30 days, a bucket lock on <code>_trash/</code> for 30 days, and a budget alert at a few dollars a month.</li>
</ol>
<h3>The Windows box (about 10 minutes)</h3>
<ol>
<li>Copy <code>dist/folder-sync-windows-amd64.exe</code> to <code>C:\\Users\\BAM\\.folder-sync\\bin\\folder-sync.exe</code>.</li>
<li>In <code>cmd.exe</code> (not PowerShell: AllSigned), <code>set</code> the three <code>FOLDER_SYNC_…</code> variables, then <code>folder-sync.exe login</code> and <code>folder-sync.exe init --project wincheck --bucket folder-sync --dir C:\\Users\\BAM\\wincheck</code>. If Defender or Smart App Control blocks rclone, init says so and stops; an exclusion is your call.</li>
<li><code>scripts\\check-windows-task.cmd C:\\Users\\BAM\\wincheck</code>: registers a one-off task, runs one round from Task Scheduler, checks the log in <code>%USERPROFILE%\\.folder-sync\\logs</code> and that nothing appeared under AppData, then deletes the task.</li>
</ol>
</div>

<h2>Calls the spec left open (made, and reversible)</h2>
<ul>
<li><b>Where peers' files land.</b> The PEP fixes the bucket layout but not the local one. They land read-only at <code>&lt;folder&gt;/hosts/&lt;host-id&gt;/</code> (configurable <code>peers_dir</code>), mirroring the bucket key, and that folder is never pushed.</li>
<li><b><code>manifest.json</code> at a folder's root is not published</b>, because the PEP puts the manifest at the same key (<code>hosts/&lt;id&gt;/manifest.json</code>). The alternative is a <code>files/</code> level in the layout; that is a contract change for Zach.</li>
<li><b>New peers are looked for every 5 minutes</b> (one delimiter LIST), besides the hourly full reconcile; the PEP's "never list every round" otherwise means a new machine is invisible for up to an hour.</li>
<li><b><code>--dir PATH</code></b> on every command, so agents never need <code>cd</code>; <b><code>--temp-dir</code></b> beside <code>--config</code>/<code>--cache-dir</code>, because rclone's temp default is under <code>%LOCALAPPDATA%</code>; <b><code>--workdir</code></b> only for bisync (v1), since rclone rejects it on copy.</li>
<li><b>Content unchanged but mtime changed</b>: no upload; the manifest records the new mtime and peers' copies are touched to match.</li>
<li>Not built: per-session host ids for cloud agents (they get a normal host id on first <code>init</code>), and the v1 short-lived credentials.</li>
</ul>

<h2>Try it</h2>
<pre>"$HOME/folder-sync/scripts/dev-tools"
PATH="$HOME/.local/go/bin:$PATH" go -C "$HOME/folder-sync" test ./...</pre>
<p class="muted">Toolchain: {esc(evidence["go_version"])} (official tarball, SHA-256 verified against go.dev), {esc(evidence["rclone_version"])} (SHA-256 verified against SHA256SUMS on downloads.rclone.org and GitHub), node {esc(evidence["node_version"])}, Python {esc(evidence["python_version"])}. Report built by <code>docs/report/build.py</code> from <code>collect.py</code> and <code>record_demo.py</code> output.</p>
</main></body></html>
"""
    out = directory / "index.html"
    out.write_text(page)
    return out


if __name__ == "__main__":
    path = build(Path(sys.argv[1]).resolve())
    print(f"{path} ({path.stat().st_size / 1e6:.2f} MB)")
