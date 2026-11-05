#!/usr/bin/env python3
"""Builds reports/media/folder-sync-2026-11-04.html: the final review page of the Nov 4 "finish folder-sync" project (Waves 1-3).

One self-contained page: every image, the video, the charts and the styles are inline (data URIs, inline SVG and CSS), so it
opens with no server or network. Numbers that come from a measurement are read at build time from their source (the KPI
series, the dev view's model, gates.json, git); the prose around them is written here.

    python3 docs/report/build_nov4.py \\
        --status <dir>/status.json          # scripts/status --out <dir>: the dev view's model (objectives, slices, gates)
        --dev-shots <dir>                   # node docs/report/shoot_dev_view.mjs <dir>/index.html <dir>
        --demo <docs/media/demo.mp4> --demo-json <docs/media/demo.json>
        [--kpi ~/vt/zach/producers/folder-sync/kpi_series.jsonl] [--gates reports/status/gates.json]
        [--media reports/media] [--work <cache dir>] [--out reports/media/folder-sync-2026-11-04.html]

Needs python3 with Pillow, and ffmpeg with libvpx-vp9.
WHY WebM/VP9 for the hero and WebP for the stills: the page must stay under ~1.9 MB to open in the desktop preview
(feedback_show_dont_tell), and headless Chromium, which renders this page for checking, plays VP9 but not H.264.

The evening page (the current one): a new top section, "Evening, Nov 4", over the 15:30 page's body, unchanged.

    python3 docs/report/build_nov4.py \\
        --earlier reports/media/folder-sync-2026-11-04-1530.html   # the 15:30 page, kept beside this one
        --evening-status <dir>/status.json   # scripts/status --out <dir>, on the real series
        --evening-shots <dir>                # node docs/report/shoot_evening.mjs <dir>/index.html <dir>
        [--media reports/media] [--work <cache dir>] [--out reports/media/folder-sync-2026-11-04.html]

WHY the afternoon is read from the 15:30 page and not rebuilt: its numbers, gate states and live checks were true at 15:12
and its prose says so (Wave 3 "not merged", G4 "not built"). Rebuilt from today's series and gates.json it would print
evening numbers under afternoon words. The builder above still makes that page from its own inputs; this mode keeps it
byte for byte and puts the evening on top. Sources continue the numbering: the afternoon keeps 1-21, the evening is 22 on.
"""
import argparse
import base64
import html
import json
import math
import os
import re
import subprocess
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from PIL import Image

REPO = "/home/bam/folder-sync"
LOCAL = timezone(timedelta(hours=-7))  # this machine's clock (git and the dispatcher's times); KPI points carry mixed offsets


def args():
    p = argparse.ArgumentParser()
    # the afternoon page (15:12): all four are needed when --earlier is not given
    p.add_argument("--status")
    p.add_argument("--dev-shots")
    p.add_argument("--demo")
    p.add_argument("--demo-json")
    p.add_argument("--kpi", default=os.path.expanduser("~/vt/zach/producers/folder-sync/kpi_series.jsonl"))
    p.add_argument("--gates", default=f"{REPO}/reports/status/gates.json")
    # the evening page
    p.add_argument("--earlier", help="the 15:30 page; when given, build the evening page over its body")
    p.add_argument("--evening-status", help="status.json from scripts/status --out <dir>, on the real series")
    p.add_argument("--evening-shots", help="the dir shoot_evening.mjs wrote (evening-shots.json and its PNGs)")
    p.add_argument("--media", default=f"{REPO}/reports/media")
    p.add_argument("--work", default="/tmp/folder-sync-report-nov4")
    p.add_argument("--out", default=f"{REPO}/reports/media/folder-sync-2026-11-04.html")
    parsed = p.parse_args()
    if parsed.earlier:
        if not (parsed.evening_status and parsed.evening_shots):
            p.error("--earlier needs --evening-status and --evening-shots")
    elif not all((parsed.status, parsed.dev_shots, parsed.demo, parsed.demo_json)):
        p.error("the afternoon page needs --status, --dev-shots, --demo and --demo-json")
    return parsed


A = args()
os.makedirs(A.work, exist_ok=True)


def esc(text):
    return html.escape(str(text), quote=True)


def cite(*numbers):
    return "<sup class=cite>" + ",".join(f'<a href="#s{n}">{n}</a>' for n in numbers) + "</sup>"


def git(*argv):
    return subprocess.run(["git", "-C", REPO, *argv], capture_output=True, text=True, check=True).stdout.strip()


def local(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(LOCAL)


def hhmm(iso):
    return local(iso).strftime("%H:%M")


# ------------------------------------------------------------------------------------------------------------ media
def data_uri(path, mime):
    with open(path, "rb") as handle:
        return f"data:{mime};base64,{base64.b64encode(handle.read()).decode()}"


def webp(src, name, width, crop=None, quality=78):
    """Crop (left, top, right, bottom) and scale to `width`, as WebP in the work dir; returns a data URI."""
    out = os.path.join(A.work, name + ".webp")
    image = Image.open(src).convert("RGB")
    if crop:
        image = image.crop(crop)
    if image.width > width:
        image = image.resize((width, round(image.height * width / image.width)), Image.LANCZOS)
    image.save(out, "WEBP", quality=quality, method=6)
    return data_uri(out, "image/webp"), image.width, image.height


def hero_video():
    out = os.path.join(A.work, "hero.webm")
    if not os.path.exists(out):
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", A.demo, "-vf", "scale=1120:-2", "-c:v", "libvpx-vp9", "-b:v", "0",
                        "-crf", "42", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", "-an", out], check=True)
    poster_png = os.path.join(A.work, "poster.png")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "11", "-i", A.demo, "-frames:v", "1", "-vf", "scale=1120:-2", poster_png], check=True)
    poster, _, _ = webp(poster_png, "poster", 1120, quality=70)
    return data_uri(out, "video/webm"), poster, os.path.getsize(out)


def img(uri, w, h, alt, klass=""):
    k = f' class="{klass}"' if klass else ""
    return f'<img{k} loading="lazy" src="{uri}" width="{w}" height="{h}" alt="{esc(alt)}">'


# ------------------------------------------------------------------------------------------------------------ data
# The afternoon page's inputs. The evening page never reads them: its afternoon comes from the 15:30 page (see the docstring).
if not A.earlier:
    STATUS = json.load(open(A.status))
    GATES = json.load(open(A.gates))
    DEMO = json.load(open(A.demo_json))
    POINTS = [json.loads(line) for line in open(A.kpi) if line.strip()]
    OBJ = {o["id"]: o for o in STATUS["objectives"]}


def metric(oid, kpi):
    return next(m for m in OBJ[oid]["metrics"] if m["kpi"] == kpi)


def headline(oid, kpi, env):
    return metric(oid, kpi)["env"][env]


OPS = ["add", "edit", "delete", "rename", "mixed"]
DIRECTIONS = ["machine->machine", "machine->web", "web->machine"]


def o1_slices():
    """Latest p50 and p95 per (env, direction, op), the engine's own slices only (no competitor tool, no legacy facet)."""
    out = defaultdict(dict)
    for kpi in ("propagation_p50_ms", "propagation_p95_ms"):
        for series in metric("O1", kpi)["series"]:
            s = series["slice"]
            if set(s) != {"direction", "op"} or s["op"] not in OPS:
                continue
            out[(series["env"], s["direction"], s["op"])][kpi] = series["latest"]
    return out


def prod_runs():
    """Each production propagation run: when, how many slices failed, the worst p50 and p95 it measured."""
    runs = defaultdict(lambda: {"failed": 0, "p50": [], "p95": []})
    for p in POINTS:
        s = p.get("slice") or {}
        if s.get("env") != "prod" or not p["kpi"].startswith("propagation_p") or set(s) != {"env", "direction", "op"}:
            continue
        run = runs[p["t"]]
        if p["status"] != "measured":
            run["failed"] += 1
        else:
            run["p50" if p["kpi"] == "propagation_p50_ms" else "p95"].append(p["value"])
    return sorted(runs.items(), key=lambda kv: local(kv[0]))


def h_samples():
    return [p for p in POINTS if p["kpi"] == "storage_efficiency_h" and p["status"] == "measured"]


def cost_latest():
    """The newest cost_per_person_month_usd per (env, provider)."""
    out = {}
    for p in POINTS:
        if p["kpi"] != "cost_per_person_month_usd" or p["status"] != "measured":
            continue
        key = (p["slice"]["env"], p["slice"]["provider"])
        if key not in out or local(p["t"]) >= local(out[key]["t"]):
            out[key] = p
    return out


def http_status(url):
    """The status code a GET answers with, redirects not followed; None when it cannot be reached."""
    import urllib.error
    import urllib.request

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    try:
        return urllib.request.build_opener(NoRedirect).open(url, timeout=15).status
    except urllib.error.HTTPError as error:
        return error.code
    except Exception:
        return None


CHECKED_AT = datetime.now(LOCAL).strftime("%H:%M")
if not A.earlier:
    LIVE = {path: http_status(f"https://vibetracks.dev{path}") for path in ("/fs/api/auth/ok", "/fs/account", "/fs/v1/usage", "/fs/files")}
    PAGES = http_status("https://zacharyyamaoka.github.io/folder-sync/")
    SECRETS_PAGE = http_status("http://127.0.0.1:33163/")


def sync_state():
    """Each of your folders' last round, from ~/.folder-sync/projects/*/last-sync.json."""
    import glob
    rounds = {}
    for path in glob.glob(os.path.expanduser("~/.folder-sync/projects/*/last-sync.json")):
        d = json.load(open(path))
        rounds[d["project"]] = (d.get("ok"), d.get("round_finished"))
    return rounds


def mb(n):
    return f"{n / 1e9:,.1f} GB" if n >= 1e9 else f"{n / 1e6:,.1f} MB"


def ms(value):
    return f"{value:.0f} ms" if value < 999.5 else f"{value / 1000:.1f} s"


# ------------------------------------------------------------------------------------------------------------ charts
# WHY HTML tracks, not one SVG: a dot on a %-positioned track keeps its labels at reading size on a phone; an SVG viewBox
# shrinks its text with the page.
def lin(lo, hi):
    return lambda v: round(max(0, min(100, (v - lo) / (hi - lo) * 100)), 2)


def logscale(lo, hi):
    a, b = math.log10(lo), math.log10(hi)
    return lambda v: round(max(0, min(100, (math.log10(v) - a) / (b - a) * 100)), 2)


def track_row(label, value, marks, gate=None, stretch=None):
    """marks: dicts with pos, cls (s1/s2/s3/bad), title, optional seg_to (a line to a second position), ring (hollow)."""
    parts = []
    for m in marks:
        if m.get("seg_to") is not None:
            left, right = sorted((m["pos"], m["seg_to"]))
            parts.append(f'<span class="seg {m["cls"]}" style="left:{left}%;width:{round(right - left, 2)}%"></span>')
    for m in marks:
        ring = " ring" if m.get("ring") else ""
        parts.append(f'<span class="dot {m["cls"]}{ring}" style="left:{m["pos"]}%" title="{esc(m["title"])}"></span>')
    style = []
    if gate is not None:
        style.append(f"--gate:{gate}%")
    if stretch is not None:
        style.append(f"--stretch:{stretch}%")
    klass = "trk" + (" has-gate" if gate is not None else "") + (" has-stretch" if stretch is not None else "")
    return (f'<div class="trow"><div class="tlabel"><span>{label}</span><span class="tval">{value}</span></div>'
            f'<div class="{klass}" style="{";".join(style)}">{"".join(parts)}</div></div>')


def axis(scale, ticks):
    return '<div class="taxis">' + "".join(f'<span style="left:{scale(v)}%">{t}</span>' for v, t in ticks) + "</div>"


def o1_chart():
    scale = lin(0, 5000)
    slices = o1_slices()
    rows = []
    arrow = {"machine->machine": "machine → machine", "machine->web": "machine → web", "web->machine": "web → machine"}
    for direction in DIRECTIONS:
        rows.append(f'<div class="tgroup">{arrow[direction]}</div>')
        for op in OPS:
            t, p = slices.get(("test", direction, op), {}), slices.get(("prod", direction, op), {})
            marks = []
            for env, v, cls in (("test", t, "s1"), ("production", p, "s2")):
                if "propagation_p50_ms" in v:
                    marks.append({"pos": scale(v["propagation_p50_ms"]), "cls": cls, "seg_to": scale(v.get("propagation_p95_ms", v["propagation_p50_ms"])),
                                  "title": f"{env} {direction} {op}: p50 {ms(v['propagation_p50_ms'])}"})
                    if "propagation_p95_ms" in v:
                        marks.append({"pos": scale(v["propagation_p95_ms"]), "cls": cls, "ring": True,
                                      "title": f"{env} {direction} {op}: p95 {ms(v['propagation_p95_ms'])}"})
            value = f'{ms(t.get("propagation_p50_ms", float("nan")))} · <b>{ms(p.get("propagation_p50_ms", float("nan")))}</b>'
            rows.append(track_row(op, value, marks, gate=scale(1000), stretch=scale(3000)))
    ticks = axis(scale, [(0, "0"), (1000, "1 s"), (2000, "2 s"), (3000, "3 s"), (4000, "4 s"), (5000, "5 s")])
    return f"""
<figure class="chart" aria-label="O1 propagation per direction and operation, test and production">
  <div class="legend"><span><i class="dot s1 inline"></i>test (local stack)</span><span><i class="dot s2 inline"></i>production (your account, real R2)</span><span><i class="dot s1 inline ring"></i>p95, end of the line</span><span><i class="gate-key"></i>p50 target 1 s</span><span><i class="stretch-key"></i>p95 target 3 s</span></div>
  {''.join(rows)}
  {ticks}
  <figcaption>The latest run per slice: save on one side to the bytes on the other. Values right: test p50 · <b>production p50</b>. Test {hhmm(headline('O1','propagation_p50_ms','test')['t'])}, production {hhmm(headline('O1','propagation_p50_ms','prod')['t'])}.{cite(3)}</figcaption>
</figure>"""


def h_chart():
    scale = logscale(0.01, 100)
    rows = []
    for p in h_samples():
        env = p["slice"]["env"]
        lab = p["labels"]
        if env == "prod":
            note = f'production {hhmm(p["t"])} · history {mb(lab["history_bytes"])} / live {mb(lab["live_bytes"])}'
        else:
            note = f'test {hhmm(p["t"])} · CI workload, {lab["rounds"]} rounds'
        rows.append(track_row(esc(note), f'{p["value"]:.3g}', [{"pos": scale(p["value"]), "cls": "s2" if env == "prod" else "s1", "title": f'{note}: H {p["value"]:.3g}'}],
                              gate=scale(1.0), stretch=scale(0.25)))
    # PEP 0009 "As built", TestThirtyDayStorageEfficiency: the same 30-day workload with and without the PEP.
    for note, value, cls in (("30-day test run, whole copies only (before PEP 0009)", 6.07, "bad"),
                             ("30-day test run, PEP 0009 (versions)", 0.21, "s3"),
                             ("30-day test run, PEP 0009 + a real day's change records", 0.47, "s3")):
        rows.append(track_row(esc(note), f"{value:.2f}", [{"pos": scale(value), "cls": cls, "title": f"{note}: H {value}"}], gate=scale(1.0), stretch=scale(0.25)))
    ticks = axis(scale, [(0.01, "0.01"), (0.1, "0.1"), (0.25, "0.25"), (1, "1"), (10, "10"), (100, "100")])
    return f"""
<figure class="chart" aria-label="O2 storage efficiency H, production samples, test sample and the PEP 0009 30-day run, log scale">
  <div class="legend"><span><i class="dot s2 inline"></i>production</span><span><i class="dot s1 inline"></i>test</span><span><i class="dot s3 inline"></i>PEP 0009's 30-day run</span><span><i class="gate-key"></i>target ≤ 1.0</span><span><i class="stretch-key"></i>stretch ≤ 0.25</span></div>
  {''.join(rows)}
  {ticks}
  <figcaption>H = history bytes ÷ live bytes, log scale; lower is better. The {sum(1 for p in h_samples() if p['slice']['env'] == 'prod')} production samples are every one taken so far.{cite(3, 6)}</figcaption>
</figure>"""


PROVIDERS = [("r2", "Cloudflare R2"), ("s3", "AWS S3"), ("gcs", "Google Cloud Storage"), ("b2", "Backblaze B2"), ("wasabi", "Wasabi")]


def cost_chart():
    scale = logscale(0.1, 10)
    latest = cost_latest()
    rows = []
    for key, name in PROVIDERS:
        t, p = latest.get(("test", key)), latest.get(("prod", key))
        tag = ' <span class="tag">your folders</span>' if key == "r2" else ""
        if key == "wasabi":
            tag = ' <span class="tag muted">1 TB minimum</span>'
        marks = []
        for point, cls, env in ((t, "s1", "test, 10 GB reference"), (p, "s2", "production, your account")):
            if point:
                marks.append({"pos": scale(point["value"]), "cls": cls, "title": f"{name}, {env}: ${point['value']:.2f} a person-month"})
        value = f'${t["value"]:.2f} · <b>${p["value"]:.2f}</b>'
        rows.append(track_row(f"{name}{tag}", value, marks, gate=scale(0.5)))
    ticks = axis(scale, [(0.1, "$0.10"), (0.5, "$0.50"), (1, "$1"), (5, "$5"), (10, "$10")])
    return f"""
<figure class="chart" aria-label="O3 cost per person-month by storage provider, test and production, log scale">
  <div class="legend"><span><i class="dot s1 inline"></i>test: the 10 GB reference person</span><span><i class="dot s2 inline"></i>production: your account as it is</span><span><i class="gate-key"></i>target ≤ $0.50</span></div>
  {''.join(rows)}
  {ticks}
  <figcaption>Cost per person-month on each provider, from the same measured request counts and list prices, log scale. Values right: test · <b>production</b>.{cite(3, 4)}</figcaption>
</figure>"""


def pep9_chart():
    scale = logscale(0.0001, 1000)
    rows = [
        track_row("before PEP 0009: a whole copy kept each round", "230", [{"pos": scale(230), "cls": "bad", "title": "A = 230"}], gate=scale(0.1)),
        track_row("PEP 0009: a 125-byte pointer per kept version", "0.0006", [{"pos": scale(0.0006), "cls": "s3", "title": "A = 0.0006"}], gate=scale(0.1)),
    ]
    ticks = axis(scale, [(0.0001, "0.0001"), (0.01, "0.01"), (0.1, "0.1"), (1, "1"), (100, "100"), (1000, "1000")])
    return f"""
<figure class="chart" aria-label="PEP 0009 append workload: history bytes per changed byte, before and after, log scale">
  <div class="legend"><span><i class="gate-key"></i>PEP 0009's gate A ≤ 0.1</span></div>
  {''.join(rows)}
  {ticks}
  <figcaption>A = history bytes written ÷ bytes that changed, for a log that grows for an hour (the full workload: a 4 MiB log, 1.2 KB every 2 s, 1,800 rounds). Before: 678.9 MB of history for 2.95 MB changed. After: 12 pointers, 1,488 bytes, for 2.46 MB changed, throttle on.{cite(5)}</figcaption>
</figure>"""


# ------------------------------------------------------------------------------------------------------------ gates
GATE_PROOF = {
    "G1": "Randomized soak: 700 steps over 310 rounds with kills mid-sync, offline spells, renames and two people on one file; converged, 0 lost versions, 37 of 37 peer edits kept. A shared-tree soak runs beside it.",
    "G2": "<code>TestGateVersionHistory30Days</code>: every version from 30 days back restores byte for byte; edits 5 minutes apart are all kept.",
    "G3": "Short-lived keys keep two people apart end to end; four deliberate Worker bugs (a root taken from the request, a root without its trailing slash, …) each turn the test red.",
    "G4": "The CI matrix passed on <code>lane/ci-matrix</code> @ <code>7487eb1</code> (Oct 29, not this code). On <code>29b6e83</code> the installers built and installed on all three OSes, but <code>go test</code> went red on all three; the fixes are on <code>lane/ci-green</code>, not pushed.",
    "G5": "Command line: the two-machine journey. Web: the Files page against the real Worker. Desktop: the shell over the real engine, “welcome.md version 2 is online 0.3 s after the save”.",
    "G6": "<code>TestGateHeadlessFreshMachine</code>: a fresh machine syncs from a script, with no prompt and no browser, in 1.1 s.",
    "G7": "One journey (sync, edit, rename, delete, restore) passes on the R2 stand-in, on MinIO, on MinIO with every fallback forced, and on a plain folder.",
    "G8": "16 lines: 2 in the page, 11 in the Worker, 3 for the binding. The timed trial (a fresh agent adds sync in 30 minutes) is not built and does not count yet.",
    "G9": "Gitignore-style rules match git's own answers; OS junk is ignored by default; NFC and NFD spellings stay two exact names.",
    "G10": "Google and email-code sign-in, one deployment per app; production never offers email codes.",
    "G11": "Linux: install to first file in 6.7 s (sign-in 5.2 s of it). The macOS and Windows timers never ran: their CI jobs stopped at <code>go test</code>.",
    "G12": "<code>TestGateRestoreWithinFiveSeconds</code>: a restore in 1.6 s.",
}
STATUS_WORD = {"pass": "pass", "fail": "FAIL", "not_built": "not built", "skipped": "left out", "unknown": "no result"}


def gates_strip():
    tiles = []
    for g in GATES["gates"]:
        tiles.append(f'<a class="gtile {g["status"]}" href="#gate-{g["id"]}"><b>{g["id"]}</b><span>{esc(g["name"])}</span><i>{STATUS_WORD[g["status"]]}</i></a>')
    return f'<div class="gstrip">{"".join(tiles)}</div>'


def gates_table():
    rows = []
    for g in GATES["gates"]:
        tally = esc(re.split(r"\. (?:Missing|Left out)", g.get("summary", ""))[0])
        rows.append(f'<tr id="gate-{g["id"]}"><td><b>{g["id"]}</b> {esc(g["name"])}</td><td><span class="gword {g["status"]}">{STATUS_WORD[g["status"]]}</span><br><span class="small muted">{tally}</span></td><td>{GATE_PROOF[g["id"]]}</td></tr>')
    return f'<div class="tbl"><table><thead><tr><th>Gate</th><th>Status</th><th>Proof</th></tr></thead><tbody>{"".join(rows)}</tbody></table></div>'


# ------------------------------------------------------------------------------------------------------------ the parts diagram (option B, unchanged since the morning version of this page)
PARTS_SVG = """
<svg class="diagram" viewBox="0 0 760 470" role="img" aria-labelledby="partsTitle partsDesc" xmlns="http://www.w3.org/2000/svg">
  <title id="partsTitle">Option B: four parts, three seams</title>
  <desc id="partsDesc">core on the left and server-cloudflare on the right meet only through three seams: the bucket layout and manifest, the credential process, and /fs/v1 HTTP. ui sits above both; desktop sits below and runs the core as a sidecar.</desc>
  <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrowhead"/></marker></defs>
  <rect class="part" x="250" y="14" width="260" height="78" rx="10"/>
  <text class="pname" x="380" y="44" text-anchor="middle">ui</text>
  <text class="ppath" x="380" y="66" text-anchor="middle">ui/ · app/ui/</text>
  <text class="pnote" x="380" y="83" text-anchor="middle">&lt;folder-sync-status&gt;, the one sync view</text>
  <rect class="part core" x="16" y="160" width="232" height="170" rx="10"/>
  <text class="pname" x="132" y="190" text-anchor="middle">core</text>
  <text class="ppath" x="132" y="214" text-anchor="middle">cmd/ internal/ e2e/</text>
  <text class="ppath" x="132" y="232" text-anchor="middle">schema/ readers/ testdata/</text>
  <text class="pnote" x="132" y="258" text-anchor="middle">Go CLI + engine; works</text>
  <text class="pnote" x="132" y="274" text-anchor="middle">alone on any store URL</text>
  <text class="ptest" x="132" y="318" text-anchor="middle">seam test 1: check-core-alone</text>
  <rect class="part" x="512" y="160" width="232" height="170" rx="10"/>
  <text class="pname" x="628" y="190" text-anchor="middle">server-cloudflare</text>
  <text class="ppath" x="628" y="214" text-anchor="middle">accounts/ demo/</text>
  <text class="pnote" x="628" y="240" text-anchor="middle">Worker: Better Auth, D1,</text>
  <text class="pnote" x="628" y="256" text-anchor="middle">Durable Objects, the pruner</text>
  <text class="pnote" x="628" y="282" text-anchor="middle">identity only via auth.ts</text>
  <text class="ptest" x="628" y="318" text-anchor="middle">seam test 2: identity-seam</text>
  <rect class="part" x="250" y="380" width="260" height="82" rx="10"/>
  <text class="pname" x="380" y="406" text-anchor="middle">desktop</text>
  <text class="ppath" x="380" y="428" text-anchor="middle">app/src-tauri/ · app/scripts/</text>
  <text class="ppath" x="380" y="446" text-anchor="middle">app/release/ (the Tauri shell)</text>
  <line class="seam" x1="248" y1="196" x2="512" y2="196"/><line class="seam" x1="248" y1="245" x2="512" y2="245"/><line class="seam" x1="248" y1="294" x2="512" y2="294"/>
  <rect class="seamlabel-bg" x="282" y="178" width="196" height="36" rx="6"/>
  <text class="seamname" x="380" y="194" text-anchor="middle">bucket layout + manifest</text>
  <text class="seamref" x="380" y="208" text-anchor="middle">docs/CONTRACT.md, schema/</text>
  <rect class="seamlabel-bg" x="282" y="227" width="196" height="36" rx="6"/>
  <text class="seamname" x="380" y="243" text-anchor="middle">credential process</text>
  <text class="seamref" x="380" y="257" text-anchor="middle">PEP 0002, AWS credential_process</text>
  <rect class="seamlabel-bg" x="282" y="276" width="196" height="36" rx="6"/>
  <text class="seamname" x="380" y="292" text-anchor="middle">/fs/v1 HTTP</text>
  <text class="seamref" x="380" y="306" text-anchor="middle">docs/API.md, view-api schema</text>
  <path class="edge" d="M200,160 C200,118 222,90 248,70" marker-end="url(#arr)"/>
  <text class="edgelabel" x="22" y="118">embeds ui/v1 at build:</text>
  <text class="edgelabel strong" x="22" y="134">the core's one edge out</text>
  <path class="edge" d="M560,160 C560,118 538,90 512,70" marker-end="url(#arr)"/>
  <text class="edgelabel" x="590" y="126">symlinks ui/v1</text>
  <path class="edge" d="M250,420 C180,420 132,390 132,334" marker-end="url(#arr)"/>
  <text class="edgelabel" x="22" y="384">runs the binary</text>
  <text class="edgelabel" x="22" y="400">as a sidecar</text>
  <path class="edge" d="M510,420 H748 V40 H514" marker-end="url(#arr)"/>
  <text class="edgelabel" x="600" y="410">loads app/ui/</text>
</svg>"""

# ------------------------------------------------------------------------------------------------------------ styles
CSS = r"""
:root{
  color-scheme: light;
  --bg:#f7f7f5; --surface:#ffffff; --surface-2:#f1f0ec; --ink:#1a1a19; --ink-2:#52514e; --ink-3:#7d7c76;
  --line:#e4e3de; --line-2:#d3d2cc; --accent:#1f6fd0; --code:#f3f2ee; --code-ink:#2b2b29;
  --warn-bg:#fbf1df; --warn-line:#ecd2a2; --warn-ink:#7a4f00;
  --ok:#17783f; --bad:#b03a2e; --muted-st:#7d7c76;
  --s1:#2a78d6; --s2:#eb6834; --s3:#6f6e68; --pass-zone:#eef4fc; --term-bg:#1c1c1b; --term-ink:#e6e5df; --term-dim:#9c9b94; --term-red:#ff8a80; --term-green:#8fd19e;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    color-scheme: dark;
    --bg:#151514; --surface:#1d1d1c; --surface-2:#252524; --ink:#ecebe6; --ink-2:#bdbcb4; --ink-3:#8e8d86;
    --line:#2f2f2d; --line-2:#3c3c39; --accent:#6aa6f2; --code:#252523; --code-ink:#e2e1db;
    --warn-bg:#2c2416; --warn-line:#5a4720; --warn-ink:#e9c27a;
    --ok:#5cc48a; --bad:#f08a7e; --muted-st:#8e8d86;
    --s1:#3987e5; --s2:#d95926; --s3:#a3a29b; --pass-zone:#1b2533; --term-bg:#0f0f0e;
  }
}
:root[data-theme="dark"]{
  color-scheme: dark;
  --bg:#151514; --surface:#1d1d1c; --surface-2:#252524; --ink:#ecebe6; --ink-2:#bdbcb4; --ink-3:#8e8d86;
  --line:#2f2f2d; --line-2:#3c3c39; --accent:#6aa6f2; --code:#252523; --code-ink:#e2e1db;
  --warn-bg:#2c2416; --warn-line:#5a4720; --warn-ink:#e9c27a;
  --ok:#5cc48a; --bad:#f08a7e; --muted-st:#8e8d86;
  --s1:#3987e5; --s2:#d95926; --s3:#a3a29b; --pass-zone:#1b2533; --term-bg:#0f0f0e;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15.5px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",Ubuntu,sans-serif;overflow-wrap:break-word}
.wrap{max-width:980px;margin:0 auto;padding:28px 16px 80px}
header.top{padding:8px 0 18px;border-bottom:1px solid var(--line);margin-bottom:28px}
.eyebrow{font-size:12.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);margin:0 0 6px}
h1{font-size:28px;line-height:1.25;margin:0 0 8px;font-weight:650;letter-spacing:-.01em}
.meta{color:var(--ink-2);font-size:14px;margin:0}
h2{font-size:21px;line-height:1.3;margin:0 0 12px;font-weight:650;letter-spacing:-.005em}
h3{font-size:16.5px;margin:26px 0 8px;font-weight:650}
section{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:24px 24px 20px;margin:0 0 22px}
section > .lead{font-size:16.5px;margin:0 0 14px}
p{margin:0 0 12px}
ul,ol{margin:0 0 12px;padding-left:22px}
li{margin:3px 0}
li > ul{margin:4px 0 6px}
a{color:var(--accent);text-decoration-thickness:1px;text-underline-offset:2px}
code{font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;background:var(--code);color:var(--code-ink);padding:1px 5px;border-radius:5px;overflow-wrap:anywhere}
sup.cite{font-size:11px;line-height:0;margin-left:1px;font-variant-numeric:tabular-nums}
sup.cite a{text-decoration:none;color:var(--ink-3)}
sup.cite a:hover{color:var(--accent)}
.verdict{font-size:18px;line-height:1.45;font-weight:650;margin:0 0 14px}
.alert{background:var(--warn-bg);border:1px solid var(--warn-line);color:var(--ink);border-radius:10px;padding:12px 16px;margin:14px 0 4px}
.alert strong{color:var(--warn-ink)}
nav.jump{display:flex;flex-wrap:wrap;gap:6px 8px;margin:4px 0 26px}
nav.jump a{font-size:13.5px;text-decoration:none;color:var(--ink-2);background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:4px 11px}
nav.jump a:hover{color:var(--accent);border-color:var(--line-2)}
.tbl{overflow-x:auto;margin:8px 0 14px;border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;vertical-align:top;padding:8px 12px;border-bottom:1px solid var(--line)}
th{font-weight:600;color:var(--ink-2);background:var(--surface-2);font-size:13px}
tr:last-child td{border-bottom:0}
td.num{font-variant-numeric:tabular-nums;white-space:nowrap}
figure{margin:0}
.hero{margin:6px 0 4px}
.hero video{display:block;width:100%;height:auto;border-radius:10px;border:1px solid var(--line);background:#000}
figcaption{font-size:13.5px;color:var(--ink-2);margin-top:7px;line-height:1.5}
.shot img{display:block;width:100%;height:auto;border-radius:8px;border:1px solid var(--line)}
.shot{margin:14px 0 10px}
.gallery{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin:14px 0 10px}
.gallery figure img{display:block;width:100%;height:auto;border-radius:8px;border:1px solid var(--line)}
.trio{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:14px 0 10px;align-items:start}
.trio img{display:block;width:100%;height:auto;border-radius:8px;border:1px solid var(--line)}
@media (max-width:640px){.gallery,.trio{grid-template-columns:1fr}}
pre{margin:8px 0 14px;overflow-x:auto;border-radius:10px;font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
pre.term{background:var(--term-bg);color:var(--term-ink);padding:12px 14px}
pre.term .p{color:var(--term-dim)}
pre.term .r{color:var(--term-red)}
pre.term .g{color:var(--term-green)}
pre.cmd{background:var(--code);color:var(--code-ink);padding:10px 14px}
.callout{border-left:3px solid var(--accent);background:var(--surface-2);border-radius:0 10px 10px 0;padding:12px 16px;margin:14px 0}
.callout p:last-child,.callout ul:last-child{margin-bottom:0}
.diagram{display:block;width:100%;height:auto}
.diagram .part{fill:var(--surface-2);stroke:var(--line-2);stroke-width:1.2}
.diagram .part.core{stroke:var(--accent);stroke-width:1.6}
.diagram .pname{fill:var(--ink);font:650 16px ui-sans-serif,system-ui,sans-serif}
.diagram .ppath{fill:var(--ink-2);font:12.5px ui-monospace,Menlo,Consolas,monospace}
.diagram .pnote{fill:var(--ink-2);font:13px ui-sans-serif,system-ui,sans-serif}
.diagram .ptest{fill:var(--ok);font:600 12.5px ui-sans-serif,system-ui,sans-serif}
.diagram .seam{stroke:var(--accent);stroke-width:2}
.diagram .seamlabel-bg{fill:var(--surface);stroke:var(--accent);stroke-width:1}
.diagram .seamname{fill:var(--ink);font:600 13px ui-sans-serif,system-ui,sans-serif}
.diagram .seamref{fill:var(--ink-3);font:11px ui-sans-serif,system-ui,sans-serif}
.diagram .edge{fill:none;stroke:var(--ink-3);stroke-width:1.4;stroke-dasharray:5 4}
.diagram .arrowhead{fill:var(--ink-3)}
.diagram .edgelabel{fill:var(--ink-2);font:12px ui-sans-serif,system-ui,sans-serif}
.diagram .edgelabel.strong{fill:var(--ink);font-weight:600}
.diagram-wrap{overflow-x:auto;margin:10px 0 6px}
.ladder{list-style:none;padding:0;margin:12px 0 14px;counter-reset:step}
.ladder li{position:relative;padding:10px 14px 10px 50px;border:1px solid var(--line);border-radius:10px;margin:0 0 8px;background:var(--surface)}
.ladder li::before{counter-increment:step;content:counter(step);position:absolute;left:14px;top:10px;width:24px;height:24px;border-radius:50%;background:var(--surface-2);border:1px solid var(--line-2);color:var(--ink-2);font-size:12.5px;font-weight:650;display:flex;align-items:center;justify-content:center}
.ladder li b{display:block}
.ladder li span{color:var(--ink-2);font-size:14.5px}
/* charts: a dot per value on a %-positioned track */
.chart{margin:14px 0 16px;padding:14px 16px;border:1px solid var(--line);border-radius:10px}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:13px;color:var(--ink-2);margin-bottom:10px}
.legend span{display:inline-flex;align-items:center;gap:6px}
.tgroup{font-size:12.5px;font-weight:650;color:var(--ink-2);letter-spacing:.02em;margin:10px 0 2px}
.trow{margin:0 0 8px}
.tlabel{display:flex;flex-wrap:wrap;justify-content:space-between;gap:2px 12px;font-size:13.5px;margin-bottom:2px}
.tval{font-variant-numeric:tabular-nums;color:var(--ink-2);white-space:nowrap}
.trk{position:relative;height:16px;border-radius:4px}
.trk.has-gate{background:linear-gradient(90deg,var(--pass-zone) 0,var(--pass-zone) var(--gate),transparent var(--gate))}
.trk.has-gate::before{content:"";position:absolute;top:-2px;bottom:-2px;left:var(--gate);border-left:2px solid var(--ink-2)}
.trk.has-stretch::after{content:"";position:absolute;top:-2px;bottom:-2px;left:var(--stretch);border-left:1.5px dashed var(--ink-3)}
.seg{position:absolute;top:7px;height:2px;opacity:.55}
.seg.s1{background:var(--s1)} .seg.s2{background:var(--s2)} .seg.s3{background:var(--s3)} .seg.bad{background:var(--bad)}
.dot{position:absolute;top:3px;width:10px;height:10px;margin-left:-5px;border-radius:50%;box-shadow:0 0 0 2px var(--surface);cursor:default;z-index:1}
.dot.s1{background:var(--s1)} .dot.s2{background:var(--s2)} .dot.s3{background:var(--s3)} .dot.bad{background:var(--bad)}
.dot.ring{background:var(--surface)!important;border:2px solid currentColor}
.dot.s1.ring{color:var(--s1)} .dot.s2.ring{color:var(--s2)}
.dot.inline{position:static;display:inline-block;margin:0;box-shadow:none}
.gate-key{display:inline-block;width:0;height:12px;border-left:2px solid var(--ink-2)}
.stretch-key{display:inline-block;width:0;height:12px;border-left:1.5px dashed var(--ink-3)}
.taxis{position:relative;height:18px;margin-top:4px;font-size:12px;color:var(--ink-3);font-variant-numeric:tabular-nums}
.taxis span{position:absolute;transform:translateX(-50%);white-space:nowrap}
.taxis span:first-child{transform:none}
.taxis span:last-child{transform:translateX(-100%)}
.tag{font-size:11.5px;font-weight:600;color:var(--s2);border:1px solid currentColor;border-radius:999px;padding:0 6px;margin-left:4px}
.tag.muted{color:var(--ink-3)}
/* objective verdicts */
.ok{color:var(--ok);font-weight:600}
.miss{color:var(--bad);font-weight:600}
.na{color:var(--ink-3)}
/* gates */
.gstrip{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin:12px 0 16px}
.gtile{display:flex;flex-direction:column;gap:1px;text-decoration:none;color:var(--ink);border:1px solid var(--line);border-top:4px solid var(--ok);border-radius:8px;padding:8px 10px;background:var(--surface);font-size:13px;line-height:1.3}
.gtile b{font-size:13.5px}
.gtile i{font-style:normal;font-size:12px;color:var(--ok);font-weight:600;margin-top:2px}
.gtile.not_built{border-top:4px dashed var(--muted-st);background:var(--surface-2)}
.gtile.not_built i{color:var(--ink-3)}
.gtile.fail{border-top-color:var(--bad)} .gtile.fail i{color:var(--bad)}
@media (max-width:640px){.gstrip{grid-template-columns:repeat(3,minmax(0,1fr))}}
.gword{font-weight:650;font-size:13.5px;color:var(--ok)}
.gword.not_built{color:var(--ink-3)}
.gword.fail{color:var(--bad)}
.decisions{list-style:none;padding:0;margin:8px 0 0;counter-reset:dec}
.decisions > li{border:1px solid var(--line);border-radius:12px;padding:12px 16px 10px 52px;margin:0 0 10px;position:relative;background:var(--surface)}
.decisions > li::before{counter-increment:dec;content:counter(dec);position:absolute;left:16px;top:12px;width:24px;height:24px;border-radius:50%;background:var(--ink);color:var(--surface);font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center}
.decisions h3{margin:0 0 4px;font-size:15.5px}
.decisions p{margin:0 0 6px;font-size:14.5px}
.undo{font-size:13.5px;color:var(--ink-2)}
.muted{color:var(--ink-3)}
.small{font-size:13.5px}
.sources ol{padding-left:26px;font-size:13.5px;color:var(--ink-2)}
.sources li{margin:5px 0}
.sources li:target{background:var(--warn-bg);border-radius:6px}
footer{color:var(--ink-3);font-size:12.5px;text-align:center;margin-top:30px}
.swipe-hint{display:none}
@media (max-width:640px){
  .tbl{border:0;overflow:visible}
  .tbl table,.tbl tbody,.tbl tr,.tbl td{display:block;width:100%}
  .tbl thead{display:none}
  .tbl tr{border:1px solid var(--line);border-radius:10px;margin:0 0 10px;padding:6px 0;background:var(--surface)}
  .tbl td{border:0;padding:3px 12px}
  .tbl td::before{content:attr(data-label);display:block;font-size:11.5px;letter-spacing:.03em;text-transform:uppercase;color:var(--ink-3)}
  .tbl td.num{white-space:normal}
  .diagram{min-width:640px}
  .swipe-hint{display:block}
  section{padding:18px 16px 14px;border-radius:12px}
  h1{font-size:23px}
  h2{font-size:19px}
  .verdict{font-size:16.5px}
}
"""


def label_cells(page):
    """Give every <td> a data-label from its column's <th>, so a phone shows each row as a card."""

    def one_table(match):
        table = match.group(0)
        heads = [re.sub(r"<[^>]+>", "", h).strip() for h in re.findall(r"<th>(.*?)</th>", table, flags=re.S)]
        if not heads:
            return table

        def one_row(row_match):
            row = row_match.group(0)
            index = iter(range(1000))
            return re.sub(r"<td(?=[ >])", lambda m: f'<td data-label="{esc(heads[next(index) % len(heads)])}"', row)

        return re.sub(r"<tr[^>]*>(?:(?!</tr>).)*?<td.*?</tr>", one_row, table, flags=re.S)

    return re.sub(r"<table.*?</table>", one_table, page, flags=re.S)


# ------------------------------------------------------------------------------------------------------------ the page
def build():
    M = A.media
    hero, poster, hero_bytes = hero_video()
    # stills
    files = [(n, *webp(f"{M}/files-page-2026-11-04-{n}.png", f"files-{n}", 880)) for n in ("1-browse", "2-text-readonly", "5-uploaded", "10-dark")]
    storage = webp(f"{M}/storage-view-2026-10-29-1-answer.png", "storage-answer", 880)
    acct = [webp(f"{M}/account-page-2026-11-04-{n}-1000.png", f"acct-{n}", 440, crop=(205, 0, 795, h))
            for n, h in (("free-dark", 1100), ("plus-light", 1164), ("bucket-form-light", 1577))]
    dev_top = webp(f"{A.dev_shots}/dev-top.png", "dev-top", 1100, quality=80)
    dev_g4 = webp(f"{A.dev_shots}/dev-g4.png", "dev-g4", 1100, crop=(0, 395, 1100, 770), quality=80)
    land_top = webp(f"{M}/landing-2026-11-04-desktop-light.png", "land-top", 880, crop=(0, 0, 1280, 760))
    land_obj = webp(f"{M}/landing-2026-11-04-desktop-light.png", "land-obj", 880, crop=(0, 1560, 1280, 2960))
    land_phone = webp(f"{M}/landing-2026-11-04-phone-dark.png", "land-phone", 300, crop=(0, 0, 780, 1690))

    # headline numbers, from the dev view's model
    o1p50t, o1p50p = headline("O1", "propagation_p50_ms", "test"), headline("O1", "propagation_p50_ms", "prod")
    o1p95t, o1p95p = headline("O1", "propagation_p95_ms", "test"), headline("O1", "propagation_p95_ms", "prod")
    h30t, h30p = headline("O2", "storage_efficiency_h_30d_max", "test"), headline("O2", "storage_efficiency_h_30d_max", "prod")
    hlatest = headline("O2", "storage_efficiency_h", "prod")
    pm_t, pm_p = headline("O3", "cost_per_person_month_usd", "test"), headline("O3", "cost_per_person_month_usd", "prod")
    gb_t, gb_p = headline("O3", "cost_per_gb_month_usd", "test"), headline("O3", "cost_per_gb_month_usd", "prod")
    cpu_t = headline("O3", "idle_cpu_pct", "test")
    ops_t = headline("O3", "idle_ops_per_hour", "test")
    summary = STATUS["gateSummary"]

    slices = o1_slices()
    test50 = [v["propagation_p50_ms"] for (env, _, _), v in slices.items() if env == "test" and "propagation_p50_ms" in v]
    prod50 = {(d, o): v["propagation_p50_ms"] for (env, d, o), v in slices.items() if env == "prod" and "propagation_p50_ms" in v}
    best_prod, worst_prod = min(prod50.items(), key=lambda kv: kv[1]), max(prod50.items(), key=lambda kv: kv[1])
    runs = prod_runs()
    runs_today = [(t, r) for t, r in runs if local(t).date() == datetime(2026, 11, 4).date()]
    failed_run = next((t, r) for t, r in runs_today if r["failed"])
    measured = [(t, r) for t, r in runs_today if r["p50"]]

    hs = h_samples()
    h_prod = [p for p in hs if p["slice"]["env"] == "prod"]
    h_first, h_last = h_prod[0], h_prod[-1]
    h_test = next(p for p in hs if p["slice"]["env"] == "test")
    age_out = (local(h_first["t"]) + timedelta(days=30)).strftime("%b %-d")

    costs = cost_latest()
    b2t, b2p = costs[("test", "b2")]["value"], costs[("prod", "b2")]["value"]
    r2t, r2p = costs[("test", "r2")], costs[("prod", "r2")]
    prod_labels = r2p["labels"]

    gated_sha = GATES["code_sha"][:7]
    run_at = hhmm(GATES["run_at"])
    heads = {b: git("rev-parse", "--short", b) for b in ("lane/readme-landing", "lane/gh-pages-landing", "lane/ci-green", "lane/final-report", "gh-pages")}
    stat = {b: git("diff", "--shortstat", f"{base}...{b}") for b, base in (("lane/readme-landing", "claude/folder-sync-v0"), ("lane/ci-green", "claude/folder-sync-v0"), ("lane/gh-pages-landing", "gh-pages"), ("lane/final-report", "claude/folder-sync-v0"))}

    def short(s):
        m = re.match(r"\s*(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?", s)
        return f"{m.group(1)} files, +{m.group(2) or 0} −{m.group(3) or 0}" if m else s

    demo_at = hhmm(DEMO["recorded_at"])
    rounds = sync_state()
    mine = {k: v for k, v in rounds.items() if k in ("zach", "vibetracks", "bam")}
    all_ok = all(ok for ok, _ in mine.values()) and len(mine) == 3
    synced_at = hhmm(min(t for _, t in mine.values())) if mine else "?"
    dev_at = datetime.fromtimestamp(os.path.getmtime(f"{A.dev_shots}/dev-top.png"), LOCAL).strftime("%H:%M")
    live = ", ".join(f"<code>{path}</code> {code or 'unreachable'}" for path, code in LIVE.items())
    prod_range = f"{ms(best_prod[1])}–{ms(worst_prod[1])}"
    arrow = lambda d: d.replace("->", " → ")
    prod95_ok = [f"{arrow(d)} {o}" for d in DIRECTIONS for o in OPS if slices.get(("prod", d, o), {}).get("propagation_p95_ms", 1e9) < 3000]

    page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Folder Sync Nov 4</title>
<meta name="description" content="folder-sync, Nov 4 2026, Waves 1-3: the three objectives in test and production, the twelve gates, what each lane built, what was decided, and what is left.">
<style>{CSS}</style>
</head>
<body>
<div class="wrap">

<header class="top">
  <p class="eyebrow">folder-sync · review packet · 2026-11-04 · Waves 1–3, final</p>
  <h1>folder-sync, finished for now: three objectives measured in test and production, {summary['pass']} of 12 gates green</h1>
  <p class="meta">This page replaces its 10:29 version (kept, linked under Sources). The objectives, the gates, git and the live checks are read when the page is built ({CHECKED_AT}); GitHub and <code>wrangler</code> were read between 14:50 and 15:10. Where a number could not be checked, it says so. Times are this machine's clock (UTC−7).</p>
</header>

<section id="verdict">
  <h2>Verdict</h2>
  <p class="verdict">Everything in your Nov 4 brief is built. Waves 1 and 2 are on <code>claude/folder-sync-v0</code> @ <code>29b6e83</code>, pushed, and live on vibetracks.dev as Worker <code>0a0f5357</code>. Wave 3 (the README, the landing page, the CI fixes and this report) sits on four lanes, not merged. {summary['pass']} of 12 gates pass; G4 and G11 wait for a green macOS and Windows CI run.{cite(1, 2, 9, 10)}</p>
  <ul>
    <li><b>O1 Fast:</b> <span class="ok">met in test</span> (p50 {ms(o1p50t['value'])}, p95 {ms(o1p95t['value'])}), <span class="miss">missed in production</span> (p50 {ms(o1p50p['value'])}, p95 {ms(o1p95p['value'])}, targets 1 s and 3 s). Production had never been measured on this bench before today's quota fix: the {hhmm(failed_run[0])} run timed out on all {failed_run[1]['failed'] // 2} slices.{cite(3)}</li>
    <li><b>O2 Storage efficient:</b> production's H is <b>{hlatest['value']:.2f}</b> now; it was {h_first['value']:.0f} while the legacy trash existed. But the target is the worst of 30 days, so production reads <span class="miss">{h30p['value']:.0f}</span> until that sample ages out around {age_out}. Test reads <span class="miss">{h30t['value']:.2f}</span> on a {h_test['labels']['rounds']}-round CI workload; PEP 0009's 30-day run is 0.21.{cite(3, 5)}</li>
    <li><b>O3 Cost per GB:</b> <span class="ok">met only on Backblaze B2</span> (${b2t:.2f} test, ${b2p:.2f} production, per person-month). On R2, where your folders are, it is <span class="miss">${pm_t['value']:.2f}</span> and <span class="miss">${pm_p['value']:.2f}</span> against $0.50. The cost there is request charges, not stored bytes.{cite(3, 4)}</li>
    <li><b>Your own syncs:</b> <code>zach</code>, <code>vibetracks</code> and <code>bam</code> {"all finished their last round ok" if all_ok else "did NOT all finish their last round ok"} (the oldest of the three at {synced_at}), on CLI <code>v0-29b6e83</code>. The account held {h_last['labels']['used_bytes'] / 1e6:.0f} MB against its 12 GiB at {hhmm(h_last['t'])}.{cite(11)}</li>
  </ul>
  <div class="alert"><strong>The README and the new landing page say O3 is met. That uses the cheapest provider, not the one your folders are on.</strong>
    <ul>
      <li><code>lane/ci-green</code> (<code>929b4a1</code>) changes the dev view to show the folder's own provider: R2, ${pm_t['value']:.2f} in test and ${pm_p['value']:.2f} in production, both missing the target.</li>
      <li>I merged <code>lane/readme-landing</code> and <code>lane/ci-green</code> in memory (<code>git merge-tree</code>, nothing written) and regenerated the README from that. Its row still says “cheapest provider” beside R2's ${pm_t['value']:.2f} and ${pm_p['value']:.2f}.</li>
      <li>So when the two land, the row's words need changing too. They are <code>METRIC_TEXT</code> in <code>scripts/readme-status.mjs</code>.{cite(16, 17)}</li>
    </ul>
  </div>
</section>

<nav class="jump" aria-label="Sections">
  <a href="#demo">Demo</a><a href="#lanes">Where it lives</a><a href="#objectives">Objectives</a><a href="#gates">Gates</a><a href="#built">What was built</a><a href="#decided">Decided for you</a><a href="#needs">Needs you</a><a href="#next">Left and next</a><a href="#notdone">Not done</a><a href="#sources">Sources</a>
</nav>

<section id="demo">
  <h2>The demo, recorded from the real stack</h2>
  <figure class="hero">
    <video autoplay muted loop playsinline controls preload="auto" poster="{poster}" aria-label="folder-sync demo: a save on the laptop appears in the browser, a browser upload lands on the laptop, version history restores an earlier text">
      <source src="{hero}" type="video/webm">
      <img src="{poster}" alt="folder-sync demo, a frame from the middle: the terminal on the left, the Files page on the right">
    </video>
    <figcaption>{DEMO['seconds']:.1f} s, muted, looping. Recorded at {demo_at} by <code>ui/scripts/record-demo.mjs</code> (on <code>lane/readme-landing</code>) from the real local stack: the real command line on the left, the real Files page on the right.
      <ul>
        <li>A save on the laptop showed in the browser <b>{DEMO['measured_ms']['toBrowser'] / 1000:.2f} s</b> later.</li>
        <li>A file added in the browser was on the laptop's disk <b>{DEMO['measured_ms']['toDisk'] / 1000:.2f} s</b> later.</li>
        <li>Then version history restores the earlier text. The restore is in the browser at once; the laptop picks it up at its next sync, as the last caption in the video says.</li>
        <li>Re-encoded here to VP9 at 1120 px ({hero_bytes / 1024:.0f} KB). The original is <code>docs/media/demo.mp4</code>.{cite(14)}</li>
      </ul>
    </figcaption>
  </figure>
</section>

<section id="lanes">
  <h2>Where the work lives</h2>
  <div class="tbl"><table>
    <thead><tr><th>Wave</th><th>Branch</th><th>State</th><th>What it holds</th></tr></thead>
    <tbody>
      <tr><td>1</td><td><code>track/finish</code>, merged as <code>3ff5e9f</code> (12:17)</td><td>on v0, pushed, live</td><td>Option B parts, the Files page, the Storage view, one accounts deployment per app, PEP 0009 built, PEP 0010 accepted, the KPI measurements, the gates harness, the dev view</td></tr>
      <tr><td>2</td><td><code>track/wave2</code>, merged as <code>29b6e83</code> (13:57)</td><td>on v0, pushed, live</td><td>Swappable storage (G7), the PEP 0010 shared tree, the account product, the cross-platform CI</td></tr>
      <tr><td>3</td><td><code>lane/readme-landing</code> @ <code>{heads['lane/readme-landing']}</code></td><td>not merged</td><td>The README rewrite, <code>scripts/readme-status</code>, the demo video and its recorder ({short(stat['lane/readme-landing'])})</td></tr>
      <tr><td>3</td><td><code>lane/gh-pages-landing</code> @ <code>{heads['lane/gh-pages-landing']}</code></td><td>not merged; a fast-forward of <code>gh-pages</code></td><td>The landing page, with the demo and the generated objectives and gates ({short(stat['lane/gh-pages-landing'])})</td></tr>
      <tr><td>3</td><td><code>lane/ci-green</code> @ <code>{heads['lane/ci-green']}</code></td><td>not merged</td><td>The first CI run's reds, fixed on all three OSes. O3 cost follows each folder's own store. G1 re-reads a manifest that comes back cut short. ({short(stat['lane/ci-green'])})</td></tr>
      <tr><td>3</td><td><code>lane/final-report</code> @ <code>{heads['lane/final-report']}</code></td><td>not merged</td><td>This page's builder, <code>docs/report/build_nov4.py</code>, and <code>shoot_dev_view.mjs</code> ({short(stat['lane/final-report'])})</td></tr>
    </tbody>
  </table></div>
  <ul class="small">
    <li><b>Since this morning:</b> 44 commits from the morning's base <code>770a9a2</code> to <code>29b6e83</code>, touching 231 files, +36,808 −868.</li>
    <li><b>Wave 3 merges cleanly:</b> its three code lanes merge with one another with no conflict (<code>git merge-tree</code> exit 0), and <code>lane/gh-pages-landing</code> is a fast-forward of <code>gh-pages</code>.</li>
    <li><b>The public landing page is still the old one.</b> <a href="https://zacharyyamaoka.github.io/folder-sync/">zacharyyamaoka.github.io/folder-sync</a> answered {PAGES or "nothing"} at {CHECKED_AT}, serving the Oct 28 page (<code>gh-pages</code> @ <code>{heads['gh-pages']}</code>).{cite(1, 10)}</li>
  </ul>
</section>

<section id="objectives">
  <h2>Objectives: three numbers you keep chasing</h2>
  <p class="lead">Your Nov 4 rule: <b>only Fast, Storage efficient and Cost per GB are objectives</b>, measured in test and in production; everything else is a gate.{cite(13)}</p>
  <ul>
    <li><b>Test</b> is the local stack, with the R2 stand-in.</li>
    <li><b>Production</b> is your own account on vibetracks.dev, against real R2.</li>
    <li>Both are measured every hour.</li>
  </ul>
  <div class="tbl"><table>
    <thead><tr><th>Objective</th><th>Target</th><th>Test</th><th>Production</th></tr></thead>
    <tbody>
      <tr><td><b>O1 Fast</b>, p50</td><td class="num">≤ 1 s</td><td class="num"><span class="ok">{ms(o1p50t['value'])} ✓</span></td><td class="num"><span class="miss">{ms(o1p50p['value'])} ✕</span></td></tr>
      <tr><td><b>O1 Fast</b>, p95</td><td class="num">≤ 3 s</td><td class="num"><span class="ok">{ms(o1p95t['value'])} ✓</span></td><td class="num"><span class="miss">{ms(o1p95p['value'])} ✕</span></td></tr>
      <tr><td><b>O2 Storage efficient</b>: H, worst of 30 days</td><td class="num">≤ 1.0 (stretch 0.25)</td><td class="num"><span class="miss">{h30t['value']:.2f} ✕</span></td><td class="num"><span class="miss">{h30p['value']:.0f} ✕</span><br><span class="small muted">latest {hlatest['value']:.2f}</span></td></tr>
      <tr><td><b>O3 Cost</b>: per person-month</td><td class="num">≤ $0.50</td><td class="num">R2 <span class="miss">${pm_t['value']:.2f} ✕</span><br>B2 <span class="ok">${b2t:.2f} ✓</span></td><td class="num">R2 <span class="miss">${pm_p['value']:.2f} ✕</span><br>B2 <span class="ok">${b2p:.2f} ✓</span></td></tr>
      <tr><td><b>O3 Cost</b>: per GB-month</td><td class="num">none set</td><td class="num">R2 ${gb_t['value']:.3f}<br>B2 ${gb_t['cheapest']['value']:.3f}</td><td class="num">R2 ${gb_p['value']:.2f}<br>B2 ${gb_p['cheapest']['value']:.2f}</td></tr>
      <tr><td><b>O3 Cost</b>: CPU when idle</td><td class="num">&lt; 0.1 %</td><td class="num"><span class="ok">{cpu_t['value']:.3f} % ✓</span></td><td class="num"><span class="na">not measured</span></td></tr>
    </tbody>
  </table></div>
  <p class="small muted">From <code>scripts/status</code>'s model, as built from <code>lane/readme-landing</code> and <code>lane/ci-green</code> merged (so O3 shows the folder's provider, R2, with B2 as the cheapest).{cite(3, 16)}</p>

  <h3>O1 Fast: under {ms(max(test50))} in test, {prod_range} in production</h3>
  {o1_chart()}
  <ul>
    <li><b>Test:</b> all 15 slices are at or under {ms(max(test50))} at p50 (from {ms(min(test50))}).</li>
    <li><b>Production:</b> from {ms(best_prod[1])} ({best_prod[0][0].replace('->', ' → ')} {best_prod[0][1]}) to {ms(worst_prod[1])} ({worst_prod[0][0].replace('->', ' → ')} {worst_prod[0][1]}). At p95, {len(prod95_ok)} of 15 production slices are under 3 s: {', '.join(prod95_ok) or 'none'}.</li>
    <li><b>Production's first day:</b>
      <ul>
        <li>{hhmm(failed_run[0])}: every slice timed out. The account was over quota, so every push was held.</li>
        {''.join(f"<li>{hhmm(t)}: {'the first measurement. Worst' if i == 0 else 'worst'} p50 {ms(max(r['p50']))}, worst p95 {ms(max(r['p95']))}.</li>" for i, (t, r) in enumerate(measured))}
        <li>{len(measured)} measured runs are not yet a trend.{cite(3)}</li>
      </ul></li>
    <li><b>Not broken down yet:</b> where the seconds go in production (R2 round trips, the Worker's push, the poll). That is O1's next step.</li>
  </ul>

  <h3>O2 Storage efficient: {hlatest['value']:.2f} now, but the 30-day worst still remembers the trash</h3>
  {h_chart()}
  <ul>
    <li><b>What moved it:</b> the R2 expiry rule on your legacy <code>_trash/</code>, set when you said go at about 10:28. History went from {h_first['labels']['history_bytes'] / 1e9:.1f} GB ({hhmm(h_first['t'])}) to {h_prod[1]['labels']['history_bytes'] / 1e6:.1f} MB ({hhmm(h_prod[1]['t'])}) and {h_last['labels']['history_bytes'] / 1e6:.1f} MB ({hhmm(h_last['t'])}), against about {h_last['labels']['live_bytes'] / 1e6:.0f} MB of live files.{cite(3, 12)}</li>
    <li><b>Why it still reads {h30p['value']:.0f}:</b> the target is the worst of 30 days. The {hhmm(h_first['t'])} sample stays in the window until about {age_out}. The README and the dev view show the latest value beside it.</li>
    <li><b>Test's {h_test['value']:.2f} is not a 30-day number.</b> It comes from a CI workload of {h_test['labels']['rounds']} rounds over {h_test['labels']['files']} files, and the point itself is flagged <code>not_a_30_day_replay</code>. PEP 0009's 30-day test run is the comparable figure: 0.21 for versions, 0.47 with a real day's change records, and 6.07 with whole copies only.{cite(3, 5)}</li>
  </ul>

  <h3>O3 Cost per GB: the bill on R2 is requests</h3>
  {cost_chart()}
  <ul>
    <li><b>R2 charges for every request.</b> An idle machine makes {ops_t['value']:.0f} requests an hour (39 writes and lists, 72 reads, 12 to the Worker). Each change costs the writer 2.9 writes and each other machine 0.9.
      <ul>
        <li>Lowering H from 1.5 to 0.25 saves $0.19 a month.</li>
        <li>Halving idle polling saves about as much.{cite(4)}</li>
      </ul></li>
    <li><b>B2 meets the target because its requests are free.</b> Wasabi's 1 TB minimum makes one person cost about $8.{cite(4)}</li>
    <li><b>Production is your real account:</b> {prod_labels['live_gb']:.2f} GB live, {prod_labels['machines']} machines, {prod_labels['changes_per_day']:,} changes a day. That is why its per-GB figure on R2 (${gb_p['value']:.2f}) is so high: the requests are spread over very few bytes.{cite(3)}</li>
    <li><b>Idle CPU in production was not measured.</b> No <code>sync --watch</code> daemon runs on this machine; Vibe Tracks runs <code>sync --once</code> on each tick.{cite(3)}</li>
    <li><b>For scale:</b> Obsidian Sync Plus is $8–10 and Dropbox Plus $9.99 for 10 GB.{cite(4)}</li>
  </ul>
</section>

<section id="gates">
  <h2>Gates: {summary['pass']} pass, {summary['not_built']} not built</h2>
  <p class="lead">A gate is pass or fail, and it never passes without its proof.</p>
  <ul>
    <li><b>The last full run:</b> {run_at} on <code>{gated_sha}</code>, the same tree as <code>29b6e83</code>.</li>
    <li><b>G4 and G11 are “not built”:</b> each still needs a proof that only a macOS or Windows machine can give.{cite(2)}</li>
  </ul>
  {gates_strip()}
  {gates_table()}
  <h3>What GitHub said about <code>29b6e83</code></h3>
  <p>This is the first run on all three OSes without your computer: <a href="https://github.com/zacharyyamaoka/folder-sync/actions/runs/41912241285">run 41912241285</a>.{cite(8)}</p>
  <ul>
    <li><b>Green:</b>
      <ul>
        <li>the core with no server;</li>
        <li>the UI;</li>
        <li>the installers, built and silently installed on Linux, macOS and Windows (<code>desktop / smoke</code>);</li>
        <li>the cross-OS pair: written on Linux, pulled on macOS and on Windows.</li>
      </ul></li>
    <li><b>Red:</b> <code>test</code> on all three OSes (at <code>go test</code>), <code>server-cloudflare</code> (<code>npm test</code>) and <code>gates (linux)</code>. G11's macOS and Windows timers were skipped, because they run after <code>go test</code>.</li>
    <li><b>Why, per <code>lane/ci-green</code></b> (<code>7e70d3e</code>):
      <ul>
        <li><code>npm ci</code> ran after <code>go test</code>, which needs it;</li>
        <li>Windows built <code>file://C:/x</code>, which names a host called <code>C:</code>;</li>
        <li><code>set-secrets.py</code> needs Python 3.11, and the runner had 3.10;</li>
        <li>a one-commit-deep checkout;</li>
        <li>MinIO answered 503 just after reporting ready.</li>
      </ul></li>
    <li><b>Not yet proven:</b> those fixes can only be proven on GitHub, and they get there with the next push.{cite(8, 17)}</li>
  </ul>
  <figure class="shot">{img(*dev_top, alt="The dev view: three objective cards with test and production side by side, then the twelve gates")}
    <figcaption><b>The dev view</b> (<code>scripts/dev-view</code>): one card per objective, test beside production, then the 12 gates. Click any of them for the drill-down. Rendered headless at {dev_at} from the real KPI series and <code>gates.json</code>, with the scripts as they will be once Wave 3 lands.{cite(15)}</figcaption></figure>
  <figure class="shot">{img(*dev_g4, alt="The dev view's G4 drill-down: each test, its status, duration and detail")}
    <figcaption>A gate's drill-down: G4's five tests and the one proof it is missing.</figcaption></figure>
</section>

<section id="built">
  <h2>What was built</h2>
  <p class="lead">One subsection per piece of work, oldest first. Each says which lane built it.</p>

  <h3>Wave 1 · The Files page <span class="muted small"><code>lane/files-page</code></span></h3>
  <p>A Files tab, and a <code>/fs/files</code> page around it. It shows every device's files in one list and opens each with the browser's own preview. Web files can be uploaded, renamed and deleted.</p>
  <ul>
    <li><b>Live:</b> on vibetracks.dev, <code>/fs/files</code> sends a signed-out visitor to sign in ({LIVE['/fs/files'] or 'unreachable'} at {CHECKED_AT}).</li>
    <li><b>Proven on the real stack:</b> G5's web journey.{cite(10, 15)}</li>
  </ul>
  <div class="gallery">
    <figure>{img(*files[0][1:], alt="Files page: browse every device's files")}<figcaption>Browse: every device's files, grouped by device.</figcaption></figure>
    <figure>{img(*files[1][1:], alt="Files page: a device's text file, read-only")}<figcaption>A device's file opens read-only: “Written by bam-GPU; edit it there.”</figcaption></figure>
    <figure>{img(*files[2][1:], alt="Files page: two files uploaded to Web")}<figcaption>Upload: “Added 2 files to Web”. Only web files can be renamed or deleted.</figcaption></figure>
    <figure>{img(*files[3][1:], alt="Files page in dark, list dragged wider")}<figcaption>Dark, with the list dragged wider; the width is remembered.</figcaption></figure>
  </div>

  <h3>Wave 1 · The Storage view <span class="muted small"><code>lane/storage-view</code></span></h3>
  <p>The Storage tab gives one answer first, then a bar, suggestions that each say why, and a table you open one level at a time. It reports each person's own quota (<code>quotaOf</code>).</p>
  <ul>
    <li>Its “Free up” buttons are still disabled (“coming next”).</li>
    <li>This still is from a seeded fixture on Oct 29.{cite(15)}</li>
  </ul>
  <figure class="shot">{img(*storage, alt="Storage view: the answer, the bar and Free up space suggestions")}</figure>

  <h3>Wave 1 · Option B: four parts, three seams <span class="muted small"><code>lane/parts</code></span></h3>
  <p>One repo, four named parts. They meet only at the three blue seams, and two tests pin those seams; both went red on a deliberate violation before they were committed.</p>
  <ul>
    <li><code>scripts/check-core-alone</code> runs the core with the server deleted.</li>
    <li><code>identity-seam</code> lets only <code>auth.ts</code> import Better Auth.</li>
    <li>Wave 2 added the store URL, so the core now works on any store, not only R2.{cite(20)}</li>
  </ul>
  <div class="diagram-wrap">{PARTS_SVG}</div>
  <p class="small muted swipe-hint">On a phone, swipe the diagram sideways.</p>

  <h3>Wave 1 · PEP 0009: history that costs what changed <span class="muted small"><code>lane/history-0009</code>, Accepted-Implemented</span></h3>
  <p>An append keeps a ~125-byte pointer instead of a copy. Each path keeps at most one version per 5 minutes (<code>history_every</code>). Older kept versions become zstd copies. A pointer only ever rests on bytes the engine itself uploaded.{cite(5)}</p>
  {pep9_chart()}
  <ul>
    <li><b>30 days:</b> on the 30-day workload, with the engine's own daily prune, H peaks at <b>0.21</b>. The same run with whole copies only peaks at <b>6.07</b>.</li>
    <li><b>Restores:</b> all 166 kept versions restored byte-identical from their sha256.</li>
    <li><b>Not verified:</b> R2's real answers to a native PUT's ETag and to a ranged GET with <code>If-Match</code>. <code>scripts/check-r2</code> checks them, but it has not run against a real bucket.{cite(5)}</li>
  </ul>

  <h3>Wave 1 · KPIs, gates and the dev view <span class="muted small"><code>lane/kpi</code>, <code>lane/gates</code>, <code>lane/dev-view</code></span></h3>
  <ul>
    <li><b>The hourly measurement:</b>
      <ul>
        <li>O1 propagation in 3 directions × 5 operations;</li>
        <li>H from <code>/fs/v1/usage</code>;</li>
        <li>a cost model over measured request counts and a sourced price table (<code>docs/PRICES.md</code>).</li>
      </ul>
      Everything goes to <code>~/vt/zach/producers/folder-sync/kpi_series.jsonl</code>, which held {len(POINTS)} points when this page was built.</li>
    <li><b>The gates:</b> <code>scripts/gates</code> runs G1–G12 and writes <code>gates.json</code>; the soak is G1's proof.</li>
    <li><b>The dev view:</b> <code>scripts/dev-view</code> renders both, as in the screenshots above.{cite(2, 3)}</li>
  </ul>

  <h3>Wave 1 · One accounts deployment per app <span class="muted small"><code>43566dd</code>, <code>lane/app-accounts</code></span></h3>
  <ul>
    <li>Each app gets its own Worker, D1 database and bucket prefix (<code>ROOT_PREFIX</code>, <code>[env.robotparts]</code>). The recipe is <code>docs/NEW-APP.md</code>.</li>
    <li>vibetracks.dev keeps the current deployment, so none of your data moved.</li>
    <li>robotparts.dev has its own deployment, waiting on its secrets (see Needs you).</li>
    <li>Secrets are handed back as a local page with one paste box per value: <code>accounts/scripts/set-secrets.py</code>.{cite(18)}</li>
  </ul>

  <h3>Wave 2 · Swappable storage, G7 <span class="muted small"><code>lane/storage-backends</code></span></h3>
  <p>A folder's store is one URL in <code>.folder-sync.toml</code>. The engine probes once for what the store can do, and falls back where it can't.{cite(7)}</p>
  <div class="tbl"><table>
    <thead><tr><th>What the engine asks of a store</th><th>R2</th><th>AWS S3</th><th>MinIO</th><th><code>file://</code></th><th>When missing</th></tr></thead>
    <tbody>
      <tr><td>create once (<code>If-None-Match: *</code>)</td><td>yes</td><td>yes, not run here</td><td><b>measured: yes</b></td><td><b>measured: yes</b>, atomic</td><td>HEAD first; keys are named by content, so a second writer writes the same bytes</td></tr>
      <tr><td>put if match</td><td>yes</td><td>yes, not run here</td><td><b>measured: yes</b></td><td><b>measured: yes</b></td><td>HEAD, compare the ETag, then put</td></tr>
      <tr><td>copy if match</td><td>yes</td><td>yes, not run here</td><td><b>measured: yes</b></td><td><b>measured: yes</b></td><td>HEAD the source, compare, then copy</td></tr>
      <tr><td>ranged get if match</td><td>yes</td><td>yes</td><td><b>measured: yes</b></td><td><b>measured: yes</b></td><td>HEAD, compare, then read; the sha256 check catches a race</td></tr>
    </tbody>
  </table></div>
  <ul class="small">
    <li><b>The store kinds:</b> <code>r2://</code> (the default, and the only one the accounts Worker serves), <code>s3://</code> for AWS and any S3-compatible service (B2, Wasabi, MinIO), <code>gs://</code> through an HMAC key, and <code>file://</code> for a disk or a NAS.</li>
    <li><b>Not run:</b> B2, Wasabi and GCS have not been run here, for lack of keys; <code>init</code> measures them on first use.{cite(7)}</li>
  </ul>

  <h3>Wave 2 · PEP 0010: a shared tree <span class="muted small"><code>lane/shared-tree-0010</code>, Accepted-Implemented</span></h3>
  <p>Every device can edit every file. The folder's Durable Object orders the changes, and a change arrives with its base: the version it was made from.{cite(6)}</p>
  <ol class="ladder">
    <li><b>The base is still current: accept.</b><span>The bytes are written, then the manifest, with <code>If-Match</code>.</span></li>
    <li><b>Both sides only appended whole lines: keep both tails.</b><span>The earlier change's tail goes first. This covers JSONL logs, which git's own merge would call a conflict.</span></li>
    <li><b>Other text up to 4 MiB: a three-way merge by lines.</b><span>It uses node-diff3, with git merge-file's rules. A <code>.json</code>, <code>.jsonl</code>, YAML or TOML result must still parse.</span></li>
    <li><b>Anything else: a conflicted copy, with Obsidian's own name.</b><span>The path keeps the first change, and the later one becomes a copy. Conflict markers are never written into a file.</span></li>
  </ol>
  <pre class="cmd">notes/plan (Conflicted copy bam-Air 202611040907).md
img/photo (Conflicted copy bam-Air 202611040908).png
plan (Conflicted copy bam-laptop-2 202611040908) 2.md</pre>
  <p class="small muted">Names asserted by <code>accounts/test/shared.test.ts</code>. A second copy in the same minute gets “ 2” after the parenthesis.{cite(6)}</p>
  <ul>
    <li><b>An edit beats a delete</b> (<code>edit_won</code>): the deleted file comes back.</li>
    <li><b>Both inputs of a merge are kept in history.</b></li>
    <li><b>Proven:</b> G1's shared-tree soak and <code>TestSharedTree</code> against the real Worker.</li>
    <li><b>Not in v1:</b>
      <ul>
        <li><code>history</code> and <code>restore</code> for a shared path from the command line (the Files page's Restore does it);</li>
        <li>changing <code>private</code> after sharing;</li>
        <li>turning sharing off;</li>
        <li>files over 64 MiB.{cite(6)}</li>
      </ul></li>
  </ul>

  <h3>Wave 2 · The account product, G10 <span class="muted small"><code>lane/account-product</code></span></h3>
  <p>A stock account page at <code>/fs/account</code>. Each app has four switches: storage, sync, payments, and bring-your-own-bucket.{cite(15, 19)}</p>
  <ul>
    <li><b>Payments:</b> Stripe plans set the quota, in test mode.</li>
    <li><b>Bring your own bucket:</b> any S3-compatible bucket; its key is stored encrypted.</li>
    <li><b>Off by default:</b> payments and bring-your-own-bucket are off for every app until you switch them on.</li>
    <li><b>How the screenshots were made:</b> the journey test drives the Worker's own router with real Better Auth, a Stripe fixture and a fixture S3. Nothing was deployed for it.</li>
  </ul>
  <div class="trio">
    <figure>{img(*acct[0], alt="Account page, Free plan, dark")}<figcaption>Free plan, dark: storage as a bar and in words, Upgrade, the bucket form folded.</figcaption></figure>
    <figure>{img(*acct[1], alt="Account page after upgrading to Plus")}<figcaption>After Upgrade: Stripe's signed webhook arrived, the page shows Plus and Manage billing.</figcaption></figure>
    <figure>{img(*acct[2], alt="Account page, attaching your own bucket")}<figcaption>Attaching your own bucket: the Worker tries it before saving.</figcaption></figure>
  </div>

  <h3>Wave 2 · Platforms <span class="muted small"><code>lane/platforms</code></span></h3>
  <ul>
    <li>A Linux, macOS and Windows CI matrix, and the installer smoke test, called on every push.</li>
    <li>The desktop journey, which made G5 pass.</li>
    <li><code>scripts/first-sync-timer</code>, which fails anything over 2 minutes: 6.7 s on Linux.</li>
    <li>macOS and Windows numbers come from CI; see the GitHub run above.{cite(2, 8)}</li>
  </ul>

  <h3>Wave 3 · README, demo and landing page <span class="muted small"><code>lane/readme-landing</code>, <code>lane/gh-pages-landing</code></span></h3>
  <ul>
    <li><b>The README:</b> overview, philosophy, goals, and an Objectives &amp; Gates block that <code>scripts/readme-status</code> writes from the KPI series and <code>gates.json</code>, never by hand. The demo video sits under the first paragraph.</li>
    <li><b>The landing page:</b> the same, as HTML, with dark mode.</li>
    <li><b>Not live yet:</b> both are unmerged, and GitHub Pages still serves Oct 28.{cite(14, 15)}</li>
  </ul>
  <div class="gallery">
    <figure>{img(*land_top, alt="Landing page hero: Your folder, on every computer and online")}<figcaption>The top of the landing page.</figcaption></figure>
    <figure>{img(*land_obj, alt="Landing page objectives table, generated")}<figcaption>Its objectives table, generated. O3 here still says “met” on the cheapest provider (see the Verdict).</figcaption></figure>
  </div>
  <figure class="shot" style="max-width:300px;margin-left:auto;margin-right:auto">{img(*land_phone, alt="Landing page at phone width in dark")}<figcaption>Phone width (390 px), dark.</figcaption></figure>
</section>

<section id="decided">
  <h2>Decided for you</h2>
  <p class="lead">Each was reversible, so it was done rather than asked. Each has its undo.</p>
  <ol class="decisions">
    <li><h3>Merged Wave 1 into v0: <code>track/finish</code> as <code>3ff5e9f</code> (12:17)</h3>
      <p>The Files page, the parts, the Storage view, per-app accounts, PEP 0009 built, the KPIs, the gates and the dev view.</p>
      <p>One test change rode along: a UI test now waits for the preview before reading its colours (<code>01244d4</code>). It had raced; it then passed 3 of 3 full runs.{cite(12)}</p>
      <p class="undo">Undo: <code>git revert -m1 3ff5e9f</code></p></li>
    <li><h3>Accepted PEP 0010 with its four recommended defaults (<code>bee12bb</code>, 12:16), then built it</h3>
      <p>The tree lives at <code>hosts/&lt;shared-id&gt;/</code>; conflict copies use Obsidian's name; v1 needs the accounts server; nothing is private by default.</p>
      <p class="undo">Undo: <code>git revert bee12bb</code> reverts the status line. The build itself came in with <code>29b6e83</code>.</p></li>
    <li><h3>Merged Wave 2 into v0: <code>track/wave2</code> as <code>29b6e83</code> (13:57)</h3>
      <p>After the merge: the Go suite with e2e green, 333 of 333 accounts tests, and the core-alone check green.{cite(12)}</p>
      <p>Re-run for this report on the same code (this lane adds only the report's builder): <code>go build</code>, <code>go vet</code>, <code>go test ./...</code> with e2e required and nothing quarantined, <code>check-core-alone</code>, 70 of 70 schema fixtures, 333 of 333 accounts tests, and 84 UI tests passed with 14 skipped. All green.{cite(21)}</p>
      <p class="undo">Undo: <code>git revert -m1 29b6e83</code></p></li>
    <li><h3>Deployed the accounts Worker three times: <code>678d7532</code> and <code>abb82d50</code> at 12:19, then <code>0a0f5357</code> at 14:00</h3>
      <p>The first two went out 36 s apart (Wave 1, then the 12 GiB quota); the third is Wave 2. Before the session, the live version was <code>05a6d0b1</code> (08:46).</p>
      <p>Checked live at {CHECKED_AT}, without a session: {live}.{cite(9, 10)}</p>
      <p class="undo">Undo, run it yourself from <code>/home/bam/folder-sync/accounts</code>: <code>npx wrangler rollback 05a6d0b1-136e-4a84-922b-59847813e34f</code>. That also brings back the 10 GiB quota.</p></li>
    <li><h3>Applied three D1 migrations before <code>0a0f5357</code>: 0011 billing, 0012 byo_store, 0013 shared_tree</h3>
      <p>They only add three tables and one column; nothing was dropped or rewritten. The database was exported first.</p>
      <p class="undo">Backup: <code>~/.local/share/folder-sync-backups/d1-folder-sync-accounts-2026-11-04-pre-0011.sql</code>. A Worker rollback leaves the new tables in place, unused while payments and bring-your-own-bucket are off.{cite(19)}</p></li>
    <li><h3>Raised your quota to 12 GiB (<code>2118ca0</code>) until the legacy trash expired</h3>
      <p>Without it, every push was held. The trash has now gone: the account held {h_last['labels']['used_bytes'] / 1e6:.0f} MB at {hhmm(h_last['t'])}. So the quota can go back to 10 GiB now; that is listed under Left and next.{cite(3, 18)}</p>
      <p class="undo">Undo: <code>git revert 2118ca0</code>, then deploy.</p></li>
    <li><h3>Installed CLI <code>v0-29b6e83</code> as <code>~/.local/bin/folder-sync</code> (14:01)</h3>
      <p>The Vibe Tracks session swapped its own copy, <code>~/.vibetracks/bin/folder-sync</code>, to the identical build.{cite(11, 12)}</p>
      <p class="undo">Undo: <code>mv ~/.local/bin/folder-sync.oct25-backup ~/.local/bin/folder-sync</code>. That brings back the Oct 25 engine, the one that filled your quota with full copies.</p></li>
    <li><h3>Pushed <code>claude/folder-sync-v0</code> to the public repo (14:02)</h3>
      <p>The point was macOS and Windows CI without your computer. The 8.7 MB push was checked first: the only secret-looking strings were fake keys inside tests. The old remote tip is tagged <code>archive/origin-v0-pre-wave</code> (<code>0719a86</code>, Oct 28).{cite(1, 12)}</p>
      <p class="undo">Undo: <code>git -C /home/bam/folder-sync push --force-with-lease origin archive/origin-v0-pre-wave:claude/folder-sync-v0</code>. What was public stays seen.</p></li>
  </ol>
  <p class="small muted"><b>Done on your go, and not undoable:</b> the R2 expiry rule <code>zach-legacy-trash-2026-11-04</code> deleted your legacy <code>_trash/</code> (9.86 GiB, 35,173 objects, old full copies from the Oct 25 engine). You said go at about 10:27.{cite(12)}</p>
</section>

<section id="needs">
  <h2>Needs you</h2>
  <ol class="decisions">
    <li><h3>robotparts.dev: press Save on the secrets page</h3>
      <p>The page is at <code>http://127.0.0.1:33163/</code> (<code>set-secrets.py --env robotparts</code>, in your terminal tab 1). {"It answered " + str(SECRETS_PAGE) + f" at {CHECKED_AT}." if SECRETS_PAGE else f"It was not answering at {CHECKED_AT}."} Paste four values and press Save once:</p>
      <ul>
        <li>the new Google OAuth client's ID and secret;</li>
        <li>a Cloudflare R2 token pair.</li>
      </ul>
      <p>Until then the robotparts Worker has 3 of its 5 secrets, and robotparts.dev is not switched over.{cite(12, 18)}</p>
      <p class="undo">Recommendation: do it when you have five minutes. A watcher picks it up and has robotparts.dev switched over and sign-in tested. Nothing else waits on it.</p></li>
    <li><h3>Stripe test keys, only if you want payments on</h3>
      <p>Payments are off for every app (<code>FEATURE_PAYMENTS = "off"</code>). The flow is proven against a Stripe fixture, not against Stripe.{cite(19)}</p>
      <p class="undo">Recommendation: leave payments off until someone besides you uses it. That is also the default if you say nothing.</p></li>
    <li><h3>vibetracks.dev sends its sign-in email as “Robot Parts”</h3>
      <p><code>EMAIL_FROM = "Robot Parts &lt;signin@robotparts.dev&gt;"</code> (<code>accounts/wrangler.toml</code> line 92). It predates this session, from the original go-live config.{cite(18)}</p>
      <p class="undo">Recommendation: tell me whether vibetracks.dev can send mail. If it can, the fix is a one-line change plus a deploy. Until then it stays as it is.</p></li>
  </ol>
</section>

<section id="next">
  <h2>Left, and next</h2>
  <ol>
    <li><b>Land Wave 3</b> (the dispatcher's step, next):
      <ul>
        <li>merge <code>lane/readme-landing</code>, <code>lane/ci-green</code> and <code>lane/final-report</code> into v0, and change the README's O3 row words in the same merge;</li>
        <li>fast-forward <code>gh-pages</code> to <code>lane/gh-pages-landing</code>, then push.</li>
      </ul>
      That publishes the landing page and reruns CI with <code>lane/ci-green</code>'s fixes on all three OSes.</li>
    <li><b>G4 and G11:</b> they turn green once that CI run is green, and the gate run collects its results.
      <ul>
        <li>A local <code>scripts/gates</code> run also looks for <code>desktop-smoke.yml</code> on the default branch.</li>
        <li><code>origin/main</code> is still Oct 28 (<code>0719a86</code>), so landing v0 on <code>main</code> is the other half.{cite(2, 8)}</li>
      </ul></li>
    <li><b>Quota back to 10 GiB:</b> the trash is gone, so this can happen now: <code>git revert 2118ca0</code>, then deploy. The R2 expiry rule can stay, since v0 never writes <code>_trash/</code>.</li>
    <li><b>O1 in production:</b> {prod_range} at p50 against 1 s. Break down where the time goes before changing anything.</li>
    <li><b>O3 on R2:</b> requests, not bytes. Two ways forward:
      <ul>
        <li>cut idle polling first (39 writes and lists an hour per machine);</li>
        <li>or put the bytes on B2, which would mean a non-R2 store for the accounts Worker (today it serves only <code>r2://</code>).{cite(4, 7)}</li>
      </ul></li>
    <li><b>O2's 30-day worst</b> reads {h30p['value']:.0f} until about {age_out}, whatever happens before then.</li>
    <li><b>Unmeasured in production:</b> idle CPU and idle requests. They need a <code>sync --watch</code> daemon on this machine, and a Cloudflare analytics token for the request counts.</li>
    <li><b>G8's timed trial:</b> a fresh agent adds sync to a new app in 30 minutes. It has never been run.</li>
    <li><b>Smaller items still open from this morning:</b>
      <ul>
        <li>the Storage view's “Free up” buttons;</li>
        <li>no Files tab on a machine (<code>serve</code> has no listing route);</li>
        <li>PDF preview never seen rendered;</li>
        <li><code>scripts/check-r2</code> never run against real R2.</li>
      </ul></li>
  </ol>
</section>

<section id="notdone">
  <h2>What was deliberately not done</h2>
  <ul>
    <li><b>No merge, push or deploy from this lane.</b> The dispatcher does those.</li>
    <li><b>The README's O3 wording was not changed here.</b> It lives on <code>lane/readme-landing</code>, and a second lane editing that file would collide; it is flagged above instead.</li>
    <li><b>No audit was run.</b> That happens only when you ask.</li>
    <li><b>In this page:</b>
      <ul>
        <li>No GIF fallback for the demo (the GIF is 1.3 MB); its poster frame stands in.</li>
        <li>The morning version's Files-page video was dropped for size; four of its stills stay.</li>
        <li>Every still was re-encoded to WebP.</li>
      </ul></li>
    <li><b>The dev view and the objective table use the scripts of two unmerged lanes</b>, merged in memory. v0's own scripts would show O1's test p50 as 15.1 s, because they counted a competitor's (lsyncd's) slice as folder-sync's. <code>lane/readme-landing</code> fixes that.{cite(16)}</li>
  </ul>
</section>

<section id="sources" class="sources">
  <h2>Source index</h2>
  <ol>
    <li id="s1"><code>git -C /home/bam/folder-sync</code>: <code>log --merges</code> for the two waves, <code>diff --shortstat 770a9a2 29b6e83</code>, <code>rev-list --count</code> (44), <code>merge-tree --write-tree lane/readme-landing lane/ci-green</code> (exit 0, tree <code>254c7f5</code>), <code>merge-base --is-ancestor gh-pages lane/gh-pages-landing</code>, <code>reflog refs/remotes/origin/claude/folder-sync-v0</code> (0719a86 → 29b6e83 at 14:02), <code>tag archive/origin-v0-pre-wave</code>.</li>
    <li id="s2"><code>/home/bam/folder-sync/reports/status/gates.json</code>: run {GATES['run_at']} on <code>{GATES['code_sha'][:12]}</code> (<code>{GATES['branch']}</code>), every gate's tests and details; evidence <code>soak-ci.json</code> (700 steps, 310 rounds, 0 lost), <code>first-sync-linux.json</code> (6.669 s).</li>
    <li id="s3"><code>~/vt/zach/producers/folder-sync/kpi_series.jsonl</code> ({len(POINTS)} points), read through <code>scripts/status</code>'s model (<code>status.json</code>, built {STATUS['generated_at']}) and directly for the production runs, the H samples and the per-provider costs.</li>
    <li id="s4"><code>docs/KPI.md</code> (the O3 reading: “the requests, not the history”) and <code>docs/PRICES.md</code> (list prices accessed 2026-11-04; requests per change and per idle hour; Obsidian Sync and Dropbox prices).</li>
    <li id="s5">PEP 0009, <code>docs/peps/0009-storage-efficient-history.md</code>, “As built”: A = 0.0006 vs 230; H 0.206 / 0.221 / 0.47 vs 6.07; 166 restores; what is not verified.</li>
    <li id="s6">PEP 0010, <code>docs/peps/0010-shared-tree.md</code>: Status (Accepted-Implemented), §4 ladder, “As built”; conflict names from <code>accounts/test/shared.test.ts</code> lines 217, 240, 254–255.</li>
    <li id="s7"><code>docs/STORAGE.md</code>: “The four kinds” and the capability table.</li>
    <li id="s8"><code>gh run view 41912241285 --repo zacharyyamaoka/folder-sync</code> (jobs and failed steps) and <code>gh run list</code>; <code>scripts/gates-lib.cjs</code> lines 363–399 (how G4 finds the installer smoke).</li>
    <li id="s9"><code>npx wrangler deployments list</code> in <code>accounts/</code>: 05a6d0b1 (15:46Z), 678d7532 (19:19:15Z), abb82d50 (19:19:51Z), 0a0f5357 (21:00:40Z).</li>
    <li id="s10">GETs at build time ({CHECKED_AT}, redirects not followed): vibetracks.dev {live}; zacharyyamaoka.github.io/folder-sync {PAGES}; <code>origin/gh-pages</code> @ {git("rev-parse", "--short", "origin/gh-pages")}.</li>
    <li id="s11"><code>~/.local/bin/folder-sync version</code> → v0-29b6e83; <code>go version -m</code> → vcs.revision 29b6e830; <code>~/.folder-sync/projects/*/last-sync.json</code> at build time: {", ".join(f"{k} {'ok' if ok else 'NOT ok'} {hhmm(t)}" for k, (ok, t) in sorted(rounds.items()) if t)}.</li>
    <li id="s12">The dispatcher's session 80d64b1e, its messages at 17:28Z (the expiry rule, 9.86 GiB, 35,173 objects; Oct 25 binary kept), 19:22Z (Wave 1 decisions, the test fix, the quota) and 21:03Z (Wave 2 decisions, migrations, push check, CI run), and the Vibe Tracks session's replies (its copy swapped to v0-29b6e83).</li>
    <li id="s13">Vault: <a href="obsidian://open?path=%2Fhome%2Fbam%2Fzach_brain%2FPROJECT%20-%20Folder%20Sync.md">PROJECT - Folder Sync</a>, “Nov 4 - Final Objectives for Now” and the Nov 4 prompt (README, objectives and gates with current values, demo video, GitHub Pages, testing on mac/windows without your computer).</li>
    <li id="s14"><code>lane/readme-landing</code>: <code>docs/media/demo.mp4</code> and <code>demo.json</code> (recorded {DEMO['recorded_at']}, toBrowser {DEMO['measured_ms']['toBrowser']} ms, toDisk {DEMO['measured_ms']['toDisk']} ms), <code>ui/scripts/record-demo.mjs</code>, <code>README.md</code>.</li>
    <li id="s15">Screenshots in <code>/home/bam/folder-sync/reports/media/</code>: <code>files-page-2026-11-04-*</code> (the real-stack journey, 09:56), <code>storage-view-2026-10-29-*</code> (seeded fixture), <code>account-page-2026-11-04-*</code> (<code>accounts/test/account-journey.mjs</code>, 12:48), <code>landing-2026-11-04-*</code> (14:27); the dev view rendered for this page by <code>docs/report/shoot_dev_view.mjs</code>. Each was looked at before use.</li>
    <li id="s16"><code>scripts/status</code> and <code>scripts/readme-status</code> from tree <code>254c7f5</code> (<code>lane/readme-landing</code> + <code>lane/ci-green</code>), run on the real series: README O3 row “cheapest provider … $1.69, missed … $4.75, missed”. v0's own <code>scripts/status</code> gives O1 test p50 15,102 ms (lsyncd's slice).</li>
    <li id="s17"><code>git show 7e70d3e 929b4a1 2df1305</code> (<code>lane/ci-green</code>): the CI diagnosis, the O3 provider change, the manifest re-read.</li>
    <li id="s18"><code>accounts/wrangler.toml</code> (line 92 <code>EMAIL_FROM</code>; <code>QUOTA_BY_OWNER</code> from <code>git show 2118ca0</code>); <code>ps</code> at 15:00: <code>set-secrets.py --env robotparts</code> running since about 11:00; <code>127.0.0.1:33163</code> answered {SECRETS_PAGE} at {CHECKED_AT}.</li>
    <li id="s19"><code>accounts/migrations/0011_billing.sql</code>, <code>0012_byo_store.sql</code>, <code>0013_shared_tree.sql</code>; <code>~/.local/share/folder-sync-backups/</code>; <code>accounts/test/account-journey.mjs</code> header; <code>FEATURE_PAYMENTS</code> / <code>FEATURE_BYO</code> in <code>wrangler.toml</code>.</li>
    <li id="s20">The 10:29 version of this page, <a href="folder-sync-2026-11-04-1029.html">folder-sync-2026-11-04-1029.html</a> (option B's seam tests and their red runs, the Files page journey, the PEP drafts); <code>PARTS.md</code>.</li>
    <li id="s21">The full gate on <code>lane/final-report</code>'s base <code>29b6e83</code>, run 14:58–15:07 for this report: every step exit 0; <code># pass 70</code> (schema), <code># pass 333 # fail 0</code> (accounts), <code>84 passed, 14 skipped</code> (ui). The lane's own commit adds only <code>docs/report/build_nov4.py</code> and <code>shoot_dev_view.mjs</code>, which no test reads.</li>
  </ol>
</section>

<footer>Built {datetime.now(LOCAL).strftime('%Y-%m-%d %H:%M')} by <code>docs/report/build_nov4.py</code> on <code>lane/final-report</code>. Self-contained: no network, no server.</footer>
</div>
</body>
</html>
"""
    page = label_cells(page)
    with open(A.out, "w", encoding="utf-8") as handle:
        handle.write(page)
    print(A.out, os.path.getsize(A.out))


# ============================================================================================================ the evening page
EV_FIRST_SOURCE = 22  # the afternoon's Source index ends at 21; the evening's sources continue from here
GH_REPO = "zacharyyamaoka/folder-sync"
EV_DATE = datetime(2026, 11, 4).date()


def sh(*argv, timeout=90):
    """A command's stdout, or None when it is missing, fails or times out."""
    try:
        done = subprocess.run(list(argv), capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return done.stdout.strip() if done.returncode == 0 else None


def sh_json(*argv, timeout=90):
    out = sh(*argv, timeout=timeout)
    try:
        return json.loads(out) if out else None
    except json.JSONDecodeError:
        return None


def rev(ref):
    return sh("git", "-C", REPO, "rev-parse", "--short", ref)


def remote_head(ref):
    """What the remote holds now (git ls-remote, read only), short."""
    out = sh("git", "-C", REPO, "ls-remote", "origin", ref, timeout=30)
    return out.split()[0] if out else None


def strip_ansi(text):
    return re.sub(r"\x1b\[[0-9;]*m", "", text or "")


# Read by hand for this page, 19:00-19:30, and not re-read at build time (wrangler and D1 need a login and a round trip).
BY_HAND = {
    "worker_live": "bed0a34c",            # npx wrangler deployments list (accounts/): 22:32:40Z, 100%
    "worker_revert_first": "939afe92",    # 22:17:55Z: the quota revert's first deploy; QUOTA_BY_OWNER 10737418240 (versions view)
    "worker_12gib": "0a0f5357-6279-4e71-909b-6a43ab1dc61a",  # versions view: QUOTA_BY_OWNER 12884901888, the Wave 2 version
    "robotparts_live": "e16f68d0",        # --env robotparts: 23:03:43Z, 100%
    "robotparts_d1": "1 user, 1 Google account, 1 session (created 00:08Z, 17:08 here)",  # read-only COUNT query on folder-sync-accounts-robotparts
    "flake_local": "30 of 30",            # go test -run 'TestWatcherSignalsOnceAfterABurst$' -count=30 ./internal/push: ok, 12.2 s
    "ui_flake_local": "1 of 30",          # 19:29, npx playwright test test/files.spec.mjs -g "on a machine the tab says" --repeat-each 30 --workers 4: 29 passed, 1 failed (repeat 27, the same assertion)
}

RUN_NOTES = {
    41926097553: "G1 red: <code>TestSoakNothingLost</code>, a <code>sync --once</code> that exited non-zero under load. The job kept only the failure's last 30 lines, so the cause was not in it.",
    41931254703: "G1 red again, the same test.",
    41934416132: "The first all-green run: the <code>lane/g1-soak</code> merge. Its 12 of 12 is what <code>reports/status/gates.json</code> holds.",
    41936156828: "The same commit on <code>main</code>.",
    41949468638: "Attempt 1: <code>TestWatcherSignalsOnceAfterABurst</code> (“a burst of writes signalled twice”) failed <code>core, no server</code>. G4 reads that job, so <code>gates</code> said 11 pass, 1 fail. Attempt 2: every job green, 12 pass.",
    41951804190: "<code>desktop-release</code>, started by the tag: built the five installers and published <code>desktop-v0.2.0</code>.",
    41952712798: "The current tip on the branch: every job green, 12 pass.",
    41952714897: "The same tip on <code>main</code>: <code>ui (linux)</code> failed one test, <code>files.spec.mjs:210</code> (a machine's menu still showed “Files”), so G4 read red: 11 pass. A second timing flake: it failed 1 of 30 times here.",
}


def ev_runs(tip_sha):
    """The CI runs this section names, as GitHub has them now, plus whatever runs on the current tip."""
    rows = []
    for run_id in RUN_NOTES:
        r = sh_json("gh", "run", "view", str(run_id), "-R", GH_REPO, "--json", "databaseId,headSha,headBranch,conclusion,status,attempt,createdAt,workflowName,url,jobs")
        rows.append((run_id, r))
    tip = sh_json("gh", "run", "list", "-R", GH_REPO, "--commit", tip_sha or "", "-L", "10", "--json", "databaseId,headSha,headBranch,conclusion,status,createdAt,workflowName,url") or []
    return rows, tip


def ev_journey_lines():
    """The macOS journey job's own step lines from run 41949468638."""
    jobs = sh_json("gh", "api", f"repos/{GH_REPO}/actions/runs/41949468638/attempts/2/jobs")
    if not jobs:
        return None, []
    job = next((j for j in jobs["jobs"] if j["name"] == "desktop journey (macos)"), None)
    if not job:
        return None, []
    log = strip_ansi(sh("gh", "api", "--allow-escape-sequences", f"repos/{GH_REPO}/actions/jobs/{job['id']}/logs", timeout=60))
    lines = [re.sub(r"^\S+Z ok\s+", "", line) for line in log.splitlines() if re.match(r"^\S+Z ok  \S", line)]
    return job, lines


def ev_stall():
    """The timer's state and its first and newest runs, from systemd and the journal."""
    enabled = sh("systemctl", "--user", "is-enabled", "folder-sync-stall.timer")
    active = sh("systemctl", "--user", "is-active", "folder-sync-stall.timer")
    journal = sh("journalctl", "--user", "-u", "folder-sync-stall.service", "--no-pager", "-o", "short-iso") or ""
    runs = [(m.group(1), m.group(2)) for m in re.finditer(r"^(\S+) \S+ node\[\d+\]: (folders: .*)$", journal, flags=re.M)]
    return {"enabled": enabled, "active": active, "first": runs[0] if runs else None, "last": runs[-1] if runs else None, "count": len(runs)}


def ev_installed():
    import hashlib

    def sha(path):
        if not os.path.exists(path):
            return None
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for block in iter(lambda: handle.read(1 << 20), b""):
                digest.update(block)
        return digest.hexdigest()

    appimage = os.path.expanduser("~/.local/opt/folder-sync/folder-sync-desktop-0.2.0.AppImage")
    local_build = f"{A.media}/folder-sync_0.2.0_amd64.AppImage"
    menu = os.path.expanduser("~/.local/share/applications/folder-sync.desktop")
    menu_exec = None
    if os.path.exists(menu):
        menu_exec = next((line.split("=", 1)[1] for line in open(menu) if line.startswith("Exec=")), None)
    cli = os.path.expanduser("~/.local/bin/folder-sync")
    return {
        "appimage": appimage, "appimage_bytes": os.path.getsize(appimage) if os.path.exists(appimage) else None,
        "appimage_sha": sha(appimage), "local_build_sha": sha(local_build),
        "menu": menu if os.path.exists(menu) else None, "menu_exec": menu_exec,
        "cli_version": (sh(cli, "version") or "").split(",")[0].split(" (")[0],
        "cli_backup": os.path.exists(cli + ".v0-29b6e83-backup"),
    }


def readme_by_size():
    """The README's "By size" table: [(size, {column: value})], read from the generated block."""
    text = open(f"{REPO}/README.md", encoding="utf-8").read()
    after = text[text.index("By size:"):].splitlines()[1:]
    first = next(i for i, line in enumerate(after) if line.startswith("|"))
    lines = []
    for line in after[first:]:  # the table is the run of "|" lines right after the "By size:" paragraph
        if not line.startswith("|"):
            break
        lines.append(line)
    rows = []
    head = [c.strip() for c in lines[0].strip("|").split("|")]
    for line in lines[2:]:
        cells = [c.strip().strip("*") for c in line.strip("|").split("|")]
        if len(cells) != len(head):
            break
        rows.append((cells[0], dict(zip(head[1:], cells[1:]))))
    return head, rows


def money(text):
    return float(text.replace("$", "")) if text and text.startswith("$") else None


def competitor_rows():
    """bench/cost/competitors.json, one row per plan with its yearly and monthly prices side by side."""
    data = json.load(open(f"{REPO}/bench/cost/competitors.json"))
    plans = {}
    for item in data["items"]:
        key = (item["vendor"], item["plan"])
        plan = plans.setdefault(key, {"vendor": item["vendor"], "plan": item["plan"], "gb": item["storage_gb"], "source": item["source_url"], "accessed": item["accessed"]})
        plan[item["billing"]] = item["price_usd_month"]
        if item["billing"] == "monthly":
            plan["per_gb"] = item["per_gb_month_usd"]
        plan.setdefault("per_gb", item["per_gb_month_usd"])
    return data["as_of"], list(plans.values())


def gb_text(gb):
    return f"{gb / 1000:g} TB" if gb >= 1000 else f"{gb:g} GB"


def svg_uri(path):
    with open(path, "rb") as handle:
        return "data:image/svg+xml;base64," + base64.b64encode(handle.read()).decode()


def ev_hero(mp4):
    """The desktop journey clip as VP9 (and the original H.264 beside it), and a poster frame."""
    out = os.path.join(A.work, "ev-hero.webm")
    if not os.path.exists(out) or os.path.getmtime(out) < os.path.getmtime(mp4):
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", mp4, "-vf", "scale=1120:-2", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "40",
                        "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", "-an", out], check=True)
    poster_png = os.path.join(A.work, "ev-poster.png")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "9", "-i", mp4, "-frames:v", "1", "-vf", "scale=1120:-2", poster_png], check=True)
    poster, _, _ = webp(poster_png, "ev-poster", 1120, quality=70)
    return data_uri(out, "video/webm"), os.path.getsize(out), data_uri(mp4, "video/mp4"), os.path.getsize(mp4), poster


EV_CSS = r"""
.part{margin:34px 0 16px;padding:0 2px}
.part .eyebrow{margin-bottom:4px}
.part-title{font-size:24px;line-height:1.25;margin:0 0 6px;font-weight:700;letter-spacing:-.01em}
.part p{color:var(--ink-2);margin:0 0 8px}
.five{list-style:none;padding:0;margin:4px 0 6px;counter-reset:five}
.five li{position:relative;padding:9px 0 9px 36px;border-top:1px solid var(--line);margin:0;font-size:15.5px}
.five li:first-child{border-top:0}
.five li::before{counter-increment:five;content:counter(five);position:absolute;left:0;top:10px;width:24px;height:24px;border-radius:50%;background:var(--surface-2);border:1px solid var(--line-2);color:var(--ink-2);font-size:12.5px;font-weight:650;display:flex;align-items:center;justify-content:center}
.five li.good::before{background:var(--ok);border-color:var(--ok);color:var(--surface)}
.five li.mixed::before{background:var(--warn-bg);border-color:var(--warn-line);color:var(--warn-ink)}
.windows{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:14px 0 10px;align-items:start}
.windows img{display:block;width:100%;height:auto;border-radius:10px;border:1px solid var(--line);box-shadow:0 1px 3px rgba(0,0,0,.08)}
.phones{display:grid;grid-template-columns:repeat(2,minmax(0,280px));gap:18px;justify-content:center;margin:14px 0 10px;align-items:start}
.phones img{display:block;width:100%;height:auto;border-radius:12px;border:1px solid var(--line)}
.sparks{display:flex;flex-wrap:wrap;gap:10px 22px;align-items:center;margin:10px 0 14px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:#fbfbf9}
.sparks figure{display:flex;align-items:center;gap:8px;font-size:13px;color:#52514e}
.sparks img{display:block;height:36px;width:auto}
.sparks img.gh{height:76px}
.since{margin:10px 0 0}
.tag.ok-tag{color:var(--ok)} .tag.bad-tag{color:var(--bad)} .tag.run-tag{color:var(--ink-3)}
.earlier{font-size:14.5px}
pre.term.wrap{white-space:pre-wrap;overflow-wrap:anywhere}
#afternoon{border-top:2px solid var(--line-2);padding-top:26px;margin-top:40px}
.tag.need{color:var(--warn-ink);border-color:var(--warn-line);background:var(--warn-bg)}
@media (max-width:640px){
  .windows{grid-template-columns:repeat(2,minmax(0,1fr))}
  .phones{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
  .part-title{font-size:21px}
}
"""


def build_evening():
    M = A.media
    shots_dir = A.evening_shots
    SHOTS = json.load(open(f"{shots_dir}/evening-shots.json"))
    EV = json.load(open(A.evening_status))
    EOBJ = {o["id"]: o for o in EV["objectives"]}

    def ev_headline(oid, kpi, env):
        return next(m for m in EOBJ[oid]["metrics"] if m["kpi"] == kpi)["env"][env]

    gates_now = json.load(open(A.gates))
    history = [json.loads(line) for line in open(f"{REPO}/reports/status/gates-history.jsonl") if line.strip()]
    n = iter(range(EV_FIRST_SOURCE, 100))
    S = {key: next(n) for key in ("git", "ci", "gates", "g1", "release", "desktop", "installed", "stall", "cost", "status", "wrangler", "robotparts", "secrets", "landing", "devview", "flake", "brief")}

    # ---- facts read now
    refs = {name: rev(name) for name in ("claude/folder-sync-v0", "origin/main", "origin/claude/folder-sync-v0", "main", "origin/gh-pages", "archive/origin-main-pre-v0-land", "archive/origin-gh-pages-pre-wave3", "desktop-v0.2.0^{commit}")}
    remote_full = {name: remote_head(name) for name in ("refs/heads/main", "refs/heads/claude/folder-sync-v0", "refs/heads/gh-pages")}
    remote = {name: (sha[:7] if sha else None) for name, sha in remote_full.items()}
    tip = remote["refs/heads/main"] or refs["origin/main"]
    # gh run list --commit wants the full sha
    runs, tip_runs = ev_runs(remote_full["refs/heads/main"] or sh("git", "-C", REPO, "rev-parse", "origin/main"))
    release = sh_json("gh", "release", "view", "desktop-v0.2.0", "-R", GH_REPO, "--json", "tagName,name,isPrerelease,isDraft,publishedAt,url,targetCommitish,assets")
    journey_job, journey_lines = ev_journey_lines()
    stall = ev_stall()
    inst = ev_installed()
    head, by_size = readme_by_size()
    as_of, plans = competitor_rows()
    vault_note = "/home/bam/zach_brain/Sources/Notes/folder-sync — Sync Service Pricing vs Dropbox, Google Drive and Obsidian Sync (2026-11-04).md"
    vault_ok = os.path.exists(vault_note)
    real_window = json.load(open(f"{M}/desktop-real-window-2026-11-04.json"))
    rw = {s["step"]: s for s in real_window["steps"]}
    files_online_s = next((s["seconds"] for s in real_window["steps"] if "rows on the Files page" in s["step"]), None)

    run_by_id = {run_id: r for run_id, r in runs}
    green = run_by_id.get(41949468638) or {}
    green_jobs = [j for j in green.get("jobs", [])]
    green_ok = sum(1 for j in green_jobs if j.get("conclusion") == "success")
    summary_now = sum(1 for g in gates_now["gates"] if g["status"] == "pass")

    o1p, o1t = ev_headline("O1", "propagation_p50_ms", "prod"), ev_headline("O1", "propagation_p50_ms", "test")
    o1p95 = ev_headline("O1", "propagation_p95_ms", "prod")
    o3p = ev_headline("O3", "cost_per_person_month_usd", "prod")
    o3t = ev_headline("O3", "cost_per_person_month_usd", "test")
    health = EV.get("health", {})

    # ---- media
    hero, hero_bytes, hero_mp4, mp4_bytes, poster = ev_hero(f"{M}/desktop-journey-2026-11-04.mp4")
    win = {name: webp(f"{M}/desktop-2026-11-04-{name}.png", f"ev-win-{name}", 460, quality=80)
           for name in ("picker-light", "picker-dark", "synced-with-files-dark", "picker-online-light", "download-light", "downloaded-light")}
    web_files = webp(f"{M}/desktop-2026-11-04-web-files.png", "ev-web-files", 832, quality=78)
    dev_top = webp(f"{shots_dir}/devreal-top.png", "ev-devtop", 880, crop=(0, 0, 1100, 1330), quality=74)
    dev_o1 = webp(f"{shots_dir}/devreal-o1.png", "ev-devo1", 880, crop=(0, 0, 1100, 425), quality=74)
    fx_bar = webp(f"{M}/history-2026-11-04-light-live-stalled.png", "ev-fx-bar", 880, crop=(0, 56, 1100, 116), quality=78)
    fx_panel = webp(f"{M}/history-2026-11-04-light-live-stalled.png", "ev-fx-panel", 880, crop=(0, 1212, 1100, 1536), quality=74)
    land_top = webp(f"{shots_dir}/landing-desktop-top.png", "ev-land-top", 880, crop=(0, 0, 1280, 760), quality=74)
    land_dl = webp(f"{shots_dir}/landing-desktop-desktop.png", "ev-land-dl", 880, crop=(0, 60, 1280, 800), quality=74)
    land_phone_top = webp(f"{shots_dir}/landing-phone-dark-top.png", "ev-land-phone-top", 300, quality=74)
    land_phone_dl = webp(f"{shots_dir}/landing-phone-desktop.png", "ev-land-phone-dl", 300, quality=74)
    sec_google = webp(f"{REPO}/accounts/scripts/set-secrets/google-create-client.png", "ev-sec-google", 400, quality=74)
    sec_cf = webp(f"{REPO}/accounts/scripts/set-secrets/cloudflare-token-form.png", "ev-sec-cf", 620, quality=72)
    sec_cf_list = webp(f"{REPO}/accounts/scripts/set-secrets/cloudflare-token-list.png", "ev-sec-cf-list", 620, quality=72)
    sparks = {k: svg_uri(f"{REPO}/docs/status/{k}.svg") for k in ("spark-o1", "spark-o2", "spark-o3", "gate-history")}

    # ---- pieces
    def run_row(run_id, r):
        if not r:
            return f'<tr><td><a href="https://github.com/{GH_REPO}/actions/runs/{run_id}">{run_id}</a></td><td colspan="3"><span class="muted">not read at build time</span></td><td>{RUN_NOTES[run_id]}</td></tr>'
        result = r.get("conclusion") or r.get("status")
        cls = "ok" if result == "success" else ("miss" if result == "failure" else "na")
        attempt = f" (attempt {r['attempt']})" if r.get("attempt", 1) > 1 else ""
        return (f'<tr><td><a href="{r["url"]}">{run_id}</a></td><td><code>{r["headSha"][:7]}</code><br><span class="small muted">{esc(r["headBranch"])}</span></td>'
                f'<td class="num">{hhmm(r["createdAt"])}</td><td><span class="{cls}">{esc(result)}</span>{attempt}</td><td>{RUN_NOTES[run_id]}</td></tr>')

    tip_line = ", ".join(f'<a href="{r["url"]}">{esc(r["workflowName"])} {r["databaseId"]}</a> on <code>{esc(r["headBranch"])}</code>: {esc(r.get("conclusion") or r.get("status"))}' for r in tip_runs) or "none found"

    hist_cols = []
    for h in history:
        gates = h.get("gates") or {}
        passing = sum(1 for g in gates.values() if g["status"] == "pass")
        failing = [gid for gid, g in gates.items() if g["status"] == "fail"]
        open_ = [gid for gid, g in gates.items() if g["status"] not in ("pass", "fail")]
        if not gates:
            word = "no gates file (its gates job never ran)"
        else:
            word = f"{passing} pass" + (f"; red: {', '.join(failing)}" if failing else "") + (f"; not built: {', '.join(open_)}" if open_ else "")
        where = "CI on main" if h.get("branch") == "main" and h["source"] == "ci" else ("CI" if h["source"] == "ci" else "local")
        hist_cols.append(f"<li>{hhmm(h['t'])} <code>{h['sha'][:7]}</code>, {where}: {word}</li>")

    plan_rows = []
    for p in plans:
        yearly = f"${p['annual']:.2f}" if "annual" in p else "–"
        monthly = f"${p['monthly']:.2f}" if "monthly" in p else "–"
        per_gb = f"${p['per_gb']:.4f}".rstrip("0").rstrip(".") if p["per_gb"] else "$0"
        host = re.sub(r"^https?://(www\.)?", "", p["source"]).split("/")[0]
        plan_rows.append(f'<tr><td><b>{esc(p["vendor"])}</b> {esc(p["plan"])}</td><td class="num">{gb_text(p["gb"])}</td><td class="num">{monthly}</td><td class="num">{yearly}</td>'
                         f'<td class="num">{per_gb}</td><td><a href="{esc(p["source"])}">{esc(host)}</a>, {esc(p["accessed"])}</td></tr>')

    size_rows = "".join("<tr><td><b>{}</b></td>{}</tr>".format(esc(size), "".join(
        f'<td class="num">{"<b>" + esc(v) + "</b>" if k.startswith("folder-sync") else esc(v)}</td>' for k, v in cols.items())) for size, cols in by_size)
    size_head = "".join(f"<th>{esc(h)}</th>" for h in head)
    bs = {size: cols for size, cols in by_size}
    tb1, tb2, gb10, gb100 = bs.get("1 TB", {}), bs.get("2 TB", {}), bs.get("10 GB", {}), bs.get("100 GB", {})

    assets = (release or {}).get("assets", [])

    def asset_size(fragment):
        a = next((a for a in assets if fragment in a["name"]), None)
        return f"{a['size'] / 1e6:.1f} MB" if a else "?"

    asset_list = "".join(f"<li><code>{esc(a['name'])}</code> ({a['size'] / 1e6:.1f} MB)</li>" for a in assets if a["name"] != "SHA256SUMS")
    appimage_release = next((a["size"] for a in assets if a["name"].endswith(".AppImage")), None)
    same_bytes = inst["appimage_sha"] and inst["appimage_sha"] == inst["local_build_sha"]
    widths = SHOTS["landing"]["widths"]
    phone_w = widths.get("phone", {})
    phone_dark_w = widths.get("phone-dark", {})
    no_sideways = all(w.get("scrollWidth") == w.get("clientWidth") and not w.get("wide") for w in (phone_w, phone_dark_w))
    shot_at = hhmm(SHOTS["shotAt"])
    downloads = SHOTS["landing"].get("downloads", [])
    first_stall, last_stall = stall["first"], stall["last"]

    def jt(iso):
        return datetime.fromisoformat(iso).astimezone(LOCAL).strftime("%H:%M")

    evening = f"""
<div class="part" id="evening">
  <p class="eyebrow">New this evening</p>
  <h2 class="part-title">Evening, Nov 4: the desktop app, live sync check, cost by size</h2>
  <p>Everything here was read when the page was built ({CHECKED_AT}), unless it says “read by hand”. The afternoon's page follows it unchanged.</p>
</div>

<section id="ev-verdict">
  <h2>Verdict</h2>
  <ol class="five">
    <li class="mixed"><b>v0 is on <code>main</code>, pushed.</b> <code>origin/main</code> = <code>claude/folder-sync-v0</code> @ <code>{tip}</code>. CI run 41949468638 on <code>{(green.get('headSha') or '?')[:7]}</code> is green on {green_ok} of {len(green_jobs)} jobs after one rerun of a known timing flake. But the tip's own run on <code>main</code> went red on a second flake, in a UI test (1 failure in 30 runs here); the same commit's branch run is all green.{cite(S['git'], S['ci'], S['flake'])}</li>
    <li class="good"><b>{summary_now} of 12 gates pass.</b> G1 turned green with <code>lane/g1-soak</code>: under load, 2 failures in 94 seeds before the fix, 0 in 85 after.{cite(S['gates'], S['g1'])}</li>
    <li class="good"><b>The desktop app 0.2.0 is a public, unsigned pre-release</b> for macOS, Windows and Linux. Your journey test passes in CI on a real Mac (there, Node stands in for the window's Rust shell; the real app ran the journey on this machine). It is installed here; you have not opened it yet.{cite(S['release'], S['desktop'], S['installed'])}</li>
    <li class="good"><b>A passive stall check runs every 5 minutes</b>: no network requests, nothing written to your folders. Its first run{(' at ' + jt(first_stall[0])) if first_stall else ''}: 0 stalled, 1 pending, 2 idle of 3.{cite(S['stall'])}</li>
    <li class="mixed"><b>Cost by size:</b> pennies at 10–100 GB; at 1–2 TB Google's {tb1.get('Google', '?')} and Dropbox's {tb1.get('Dropbox', '?')} beat R2's {tb1.get('folder-sync on R2', '?')} and {tb2.get('folder-sync on R2', '?')}. Still missed: production O1 at {ms(o1p['value'])} (target 1 s) and O3 on R2 at ${o3p['value']:.2f} a person-month (target $0.50).{cite(S['cost'], S['status'])}</li>
  </ol>
</section>

<nav class="jump" aria-label="Evening sections">
  <a href="#ev-status">Status and CI</a><a href="#ev-desktop">Desktop app</a><a href="#ev-stall">Stall check</a><a href="#ev-history">History</a><a href="#ev-cost">Cost by size</a><a href="#ev-robotparts">robotparts.dev</a><a href="#ev-landing">Landing page</a><a href="#ev-decided">Decided for you</a><a href="#ev-left">Left</a><a href="#afternoon">Afternoon (15:30 page)</a><a href="#sources">Sources</a>
</nav>

<section id="ev-status">
  <h2>Status: on main, 12 of 12, two timing flakes left</h2>
  <ul>
    <li><b>Branches, as GitHub has them now</b> (<code>git ls-remote</code>): <code>main</code> {remote['refs/heads/main'] or '?'}, <code>claude/folder-sync-v0</code> {remote['refs/heads/claude/folder-sync-v0'] or '?'}, <code>gh-pages</code> {remote['refs/heads/gh-pages'] or '?'}. The tag <code>desktop-v0.2.0</code> is on <code>{refs['desktop-v0.2.0^{commit}'] or '?'}</code>.{cite(S['git'])}</li>
    <li><b>This checkout's own <code>main</code> branch is stale:</b> it still points at <code>{refs['main'] or '?'}</code> (Oct 20). <code>origin/main</code> is the truth; nothing here reads the local one.</li>
    <li><b>The current tip <code>{tip}</code></b> (the landing page's size table scrolls in its own box at phone width): {tip_line}. Both are in the table below.{cite(S['ci'])}</li>
  </ul>
  <div class="tbl"><table>
    <thead><tr><th>CI run</th><th>Commit</th><th>Started</th><th>Result</th><th>What it says</th></tr></thead>
    <tbody>{''.join(run_row(run_id, r) for run_id, r in runs)}</tbody>
  </table></div>

  <h3>G1: what the fix changed</h3>
  <p>Run 41926097553 went red on the soak. Run under load (8 to 16 soaks at once, some on 2 or 4 CPUs, 94 seeds), it failed twice, two different ways.{cite(S['g1'])}</p>
  <ol class="ladder">
    <li><b>A manifest read that a racing write broke is now read again.</b><span>Seed 4: a pull read a peer's manifest while the peer was rewriting it, and got “unexpected EOF”. Over about 166k reads a probe saw 681 short bodies, 283 cut in transit and 622 “try again” answers. Now all three are read again; a 4xx or an unreachable store still fails at once, so offline stays offline.</span></li>
    <li><b>The lock is never seen without its pid.</b><span>Seed 81: the lock file was created first and its pid written after, so a kill in between left an empty lock that blocked the folder for 30 minutes. Now the pid is written to its own file and hard-linked into place. Before the fix, a test saw the lock empty 17,766 times in 47,875 reads.</span></li>
  </ol>
  <ul>
    <li><b>Under the same load after the fix:</b> 85 seeds, 0 failures. A deliberately broken merge (<code>keepLocalEdit</code> made to delete) still turns the soak red.{cite(S['g1'])}</li>
    <li><b>The flake that needed the rerun:</b> <code>TestWatcherSignalsOnceAfterABurst</code> in <code>internal/push</code>. Re-run here for this page: {BY_HAND['flake_local']} pass. It is still in the code; it is listed under Left.{cite(S['ci'], S['flake'])}</li>
    <li><b>The full gate history</b> is <code>reports/status/gates-history.jsonl</code>, {len(history)} runs:
      <ul class="small">{''.join(hist_cols)}</ul>
      Run 41949468638 is not in that file yet; its gates job log reads “12 pass”.{cite(S['gates'])}</li>
  </ul>
</section>

<section id="ev-desktop">
  <h2>Desktop app 0.2.0: pick a folder like an Obsidian vault</h2>
  <figure class="hero">
    <video autoplay muted loop playsinline controls preload="auto" poster="{poster}" aria-label="The folder-sync desktop app: create a folder, it syncs, Open online shows its three files on the web Files page">
      <source src="{hero}" type="video/webm">
      <source src="{hero_mp4}" type="video/mp4">
      <img src="{poster}" alt="The desktop app synced beside the web Files page with three files">
    </video>
    <figcaption>{real_window['steps'][-1].get('seconds', 0):.1f} s, muted, looping. <b>The real app</b>: the Tauri binary with its engine, on an invisible display on this machine, beside Chrome on the web Files page (<code>app/scripts/real_window.mjs</code>). It ran against the local stack on 127.0.0.1 as a test person, not your account.
      <ul>
        <li>Create new folder; the window says Synced.</li>
        <li>Three files dropped in the folder were rows on the Files page <b>{files_online_s} s</b> later.</li>
        <li>VP9 here ({hero_bytes / 1024:.0f} KB), with the original MP4 ({mp4_bytes / 1024:.0f} KB) as a fallback: <code>reports/media/desktop-journey-2026-11-04.mp4</code>.{cite(S['desktop'])}</li>
      </ul>
    </figcaption>
  </figure>

  <h3>The first run, and the second computer</h3>
  <div class="windows">
    <figure>{img(*win['picker-light'], alt="First run: Create new folder, Open existing folder, Your folders online")}<figcaption>First run: create new, open existing, or “Your folders online”.</figcaption></figure>
    <figure>{img(*win['picker-dark'], alt="The same picker in dark")}<figcaption>The same, dark. The sign-in survived a relaunch.</figcaption></figure>
    <figure>{img(*win['synced-with-files-dark'], alt="Machine 1: Synced, folder ~/folder-sync/journey-notes")}<figcaption>Machine 1 after Create folder: Synced.</figcaption></figure>
    <figure>{img(*win['picker-online-light'], alt="Machine 2: Your folders online lists journey-notes")}<figcaption>Machine 2: “Your folders online” lists it.</figcaption></figure>
    <figure>{img(*win['download-light'], alt="Machine 2: download journey-notes into ~/folder-sync/journey-notes")}<figcaption>Download, with the place it goes.</figcaption></figure>
    <figure>{img(*win['downloaded-light'], alt="Machine 2: Synced, 1 other machine")}<figcaption>Machine 2 synced: “1 other machine”.</figcaption></figure>
  </div>
  <figure class="shot" style="max-width:620px">{img(*web_files, alt="The web Files page: ideas.md, todo.md, welcome.md, shared, synced from a device")}<figcaption>“Open online”: the web Files page with the three files.{cite(S['desktop'])}</figcaption></figure>

  <h3>Your success criterion, as an automated test</h3>
  <p>The journey (<code>app/test/journey.mjs</code>) ran in CI as <b>desktop journey (macos)</b> on a GitHub Apple-silicon runner{(', job ' + str(journey_job['id']) + ', ' + esc(journey_job['conclusion'])) if journey_job else ''}. Its own lines:{cite(S['ci'], S['desktop'])}</p>
  {('<pre class="term wrap">' + ''.join(f'<span class="g">ok</span>  {esc(line)}' + chr(10) for line in journey_lines) + '</pre>') if journey_lines else '<p class="muted">The job log could not be read at build time.</p>'}
  <ul>
    <li><b>What is real in that test:</b> the app's page in Chromium, the folder-sync engine, the local accounts stack (<code>wrangler dev</code>, the R2 stand-in) and the web Files page.</li>
    <li><b>What is stood in:</b> the Rust shell around the page (keychain, tray, native dialog), played by <code>app/test/shell.mjs</code>. Its own tests check it says and does what <code>core.rs</code> does.</li>
    <li><b>What proves the Rust:</b> the real-window run above (Linux), and <code>desktop / smoke</code>, which builds the installers and installs them on Linux, macOS and Windows on every push.</li>
    <li><b>Sign-in:</b> the app signs in to vibetracks.dev by default. Every run above used a local stack; none used your account.</li>
  </ul>

  <h3>Downloads, and this machine</h3>
  <ul>
    <li><b>Release:</b> <a href="{esc((release or {}).get('url', 'https://github.com/' + GH_REPO + '/releases/tag/desktop-v0.2.0'))}">desktop-v0.2.0</a>, {'a public pre-release' if (release or {}).get('isPrerelease') else 'NOT marked pre-release'}, published {hhmm(release['publishedAt']) if release else '?'}. The installers are not signed, so macOS and Windows ask you to confirm the first time.{cite(S['release'])}
      <ul class="small">{asset_list}</ul></li>
    <li><b>Installed here</b> as <code>{esc(inst['appimage'])}</code>{', with the menu entry “folder-sync”' if inst['menu'] else ', but the menu entry is MISSING'}. You have not run it yet.{cite(S['installed'], S['brief'])}
      <ul class="small">
        <li>It is the AppImage built on this machine ({inst['appimage_bytes'] / 1e6 if inst['appimage_bytes'] else 0:.1f} MB{', the same bytes as <code>reports/media/folder-sync_0.2.0_amd64.AppImage</code>' if same_bytes else ''}), not the release's ({appimage_release / 1e6 if appimage_release else 0:.1f} MB), which CI built.</li>
        <li>It signs in to vibetracks.dev: your real account.</li>
      </ul></li>
  </ul>
</section>

<section id="ev-stall">
  <h2>The passive stall check, live</h2>
  <p class="lead">Your ask after the canary file: watch the changes you make anyway, and stay quiet when nothing changes. <code>bench/kpi/stall.mjs</code> runs from the systemd user timer <code>folder-sync-stall</code> every 5 minutes: {esc(stall['enabled'] or '?')}, {esc(stall['active'] or '?')}.{cite(S['stall'])}</p>
  <ul>
    <li><b>Passive:</b> it makes no network requests and writes nothing to any folder. It compares what is on disk with what the last push holds, using the engine's own test.</li>
    <li><b>Stalled</b> means a change seen on disk that is still unpushed after 10 minutes while this machine is online.</li>
    <li><b>The cause is named</b> from the engine's state: a held lock with its pid and age, quota, signed out, held deletes, a failing round with its error, or no engine at all.</li>
    <li><b>The alert:</b> one <code>notify-send</code> per episode (no window, no focus taken) and a red bar in the dev view. Offline is never red.</li>
    <li><b>Real use becomes data:</b> each push it sees is a propagation sample with op “real”. Those stay out of O1's headline, because they measure save → pushed, not save → the other disk.</li>
  </ul>
  <pre class="term wrap"><span class="p">journalctl --user -u folder-sync-stall.service</span>
{esc(jt(first_stall[0])) if first_stall else '?'}  {esc(first_stall[1]) if first_stall else 'no run found'}
<span class="p">… {max(stall['count'] - 2, 0)} more …</span>
{esc(jt(last_stall[0])) if last_stall else '?'}  {esc(last_stall[1]) if last_stall else ''}</pre>
  <p class="small muted">The first line is its first live run; the last is the newest at build time. The dev view's own reading: {esc(str(health.get('folders', {}).get('checked', '?')))} folders watched, {esc(str(health.get('folders', {}).get('pending', '?')))} with a change on its way, {len(health.get('folders', {}).get('stalled', []) or [])} stalled.</p>
  <figure class="shot">{img(*fx_bar, alt="Dev view red bar: Sync stalled, zach: 1 changed file not pushed for 14 min; a lock held by pid 4242 for 14 min")}{img(*fx_panel, alt="Is it syncing? panel: 1 stalled of 3, recent points, the stopped folder with its cause")}
    <figcaption><b>What red looks like</b>, on the dev view's seeded fixture (pid 4242 is made up). Nothing has been red for real; the live view is green, in History below.{cite(S['devview'])}</figcaption></figure>
</section>

<section id="ev-history">
  <h2>History: every KPI over time, every gate by run</h2>
  <ul>
    <li><b>The dev view</b> (<code>scripts/dev-view</code>) now draws a Chart.js line per KPI slice, test and production, against time or against commits, with the target dashed. Chart.js 4.4.7 is vendored and inlined, so the page is still one file.</li>
    <li><b>The gate grid</b> shows G1–G12 for each of the last 8 runs; the top edge of each column says CI on the branch, CI on main or local.</li>
    <li><b>Below, rendered for this page from your real series</b> ({esc(SHOTS['devView'].get('builtLine') or '')}). The screenshots in <code>reports/media/history-2026-11-04-*.png</code> are the same views on the seeded fixture.{cite(S['devview'])}</li>
  </ul>
  <figure class="shot">{img(*dev_top, alt="Dev view on the real series: sync bar green, O1 584 ms test and 3.2 s production, O2, O3, twelve gates passing, the gate history grid")}
    <figcaption>The overview: the stall check's bar, the three objectives, the 12 gates and the gate grid. In the grid, G1 is red on <code>29b6e83</code>, <code>aca22dd</code> and <code>29dac21</code>, and green from <code>0c9c02b</code> on.</figcaption></figure>
  <figure class="shot">{img(*dev_o1, alt="Dev view O1 detail: propagation p50 over time per slice, production orange above the dashed 1 s target, test blue under it")}
    <figcaption>O1's detail, its first row of charts (machine → machine add, delete, edit): production (orange) at 2–3 s since its first runs, test (blue) under the dashed 1 s line.</figcaption></figure>
  <h3>The README and the landing page carry the same, small</h3>
  <div class="sparks">
    <figure><span>O1</span><img src="{sparks['spark-o1']}" alt="O1 p50 sparkline, last 30 days"></figure>
    <figure><span>O2</span><img src="{sparks['spark-o2']}" alt="O2 sparkline, last 30 days"></figure>
    <figure><span>O3</span><img src="{sparks['spark-o3']}" alt="O3 sparkline, last 30 days"></figure>
    <figure><span>Gates</span><img class="gh" src="{sparks['gate-history']}" alt="Gate history strip, the last 7 runs"></figure>
  </div>
  <p class="small muted"><code>docs/status/*.svg</code>, written by <code>scripts/readme-status</code>, embedded here as they are: blue test, orange production, dashed the target; the strip is G1 (top) to G12 by run, oldest left.</p>
</section>

<section id="ev-cost">
  <h2>Cost by size: pennies to 100 GB, retail wins at 1–2 TB</h2>
  <p class="lead">The cheapest monthly plan of each service that holds each size, beside what keeping that much costs folder-sync. Storage only: no requests.{cite(S['cost'])}</p>
  <div class="tbl"><table>
    <thead><tr>{size_head}</tr></thead>
    <tbody>{size_rows}</tbody>
  </table></div>
  <ul>
    <li><b>10 GB and 100 GB:</b> {gb10.get('folder-sync on R2', '?')} and {gb100.get('folder-sync on R2', '?')} a month on R2 ({gb10.get('folder-sync on B2', '?')} and {gb100.get('folder-sync on B2', '?')} on B2), against up to {gb10.get('Dropbox', '?')} for a plan.</li>
    <li><b>1 TB and 2 TB:</b> Google's {tb1.get('Google', '?')} and Dropbox's {tb1.get('Dropbox', '?')} beat R2's {tb1.get('folder-sync on R2', '?')} and {tb2.get('folder-sync on R2', '?')}. B2 is about level: {tb1.get('folder-sync on B2', '?')} at 1 TB (under both), {tb2.get('folder-sync on B2', '?')} at 2 TB (over both).</li>
    <li><b>Storage is not the whole bill.</b> On R2 most of it is requests: production O3 is ${o3p['value']:.2f} a person-month at 10 GB (test ${o3t['value']:.2f}), against the {gb10.get('folder-sync on R2', '?')} the table shows for storage.{cite(S['status'])}</li>
  </ul>
  <h3>The prices behind it</h3>
  <div class="tbl"><table>
    <thead><tr><th>Plan</th><th>Storage</th><th>Monthly</th><th>Yearly, per month</th><th>Per GB-month</th><th>Source, accessed</th></tr></thead>
    <tbody>{''.join(plan_rows)}</tbody>
  </table></div>
  <ul class="small">
    <li><code>bench/cost/competitors.json</code>, as of {esc(as_of)}. dropbox.com and one.google.com show CA$ from this machine; the USD figures are the same pages as a US index serves them, and Google's were checked against the CA$ prices.</li>
    <li>The write-up is in your vault: <a href="obsidian://open?path={esc(vault_note.replace(' ', '%20'))}">folder-sync — Sync Service Pricing vs Dropbox, Google Drive and Obsidian Sync (2026-11-04)</a>{'' if vault_ok else ' (NOT FOUND at build time)'}.{cite(S['cost'])}</li>
  </ul>
</section>

<section id="ev-robotparts">
  <h2>robotparts.dev: its own accounts, and you signed in</h2>
  <ul>
    <li><b>Its own Worker:</b> <code>folder-sync-accounts-robotparts</code>, live version <code>{BY_HAND['robotparts_live']}</code> (16:03), with its own Google client and its own D1 database. Payments and bring-your-own-bucket are off there too.{cite(S['wrangler'])}</li>
    <li><b>You signed in.</b> Its database holds {BY_HAND['robotparts_d1']}: read by hand with a read-only count.{cite(S['robotparts'])}</li>
    <li><b>The set-secrets page</b> (<code>accounts/scripts/set-secrets.py</code>) now shows a full-resolution annotated screenshot for every site, numbered like its steps; click one to enlarge it.{cite(S['secrets'])}</li>
  </ul>
  <div class="gallery">
    <figure>{img(*sec_google, alt="Google Cloud: create an OAuth client, steps 1 to 5 marked")}<figcaption>Google: the new OAuth client, five numbered steps.</figcaption></figure>
    <figure>{img(*sec_cf, alt="Cloudflare: create an R2 account token, steps 2 to 5 marked")}<figcaption>Cloudflare: the R2 token, Object Read &amp; Write on chosen buckets.</figcaption></figure>
  </div>
  <figure class="shot" style="max-width:620px">{img(*sec_cf_list, alt="Cloudflare: the Account API tokens list, Create Account API token marked 1")}<figcaption>Cloudflare, step 1. The list already shows the robotparts token, issued Nov 4.</figcaption></figure>
</section>

<section id="ev-landing">
  <h2>The landing page is live</h2>
  <p class="lead"><a href="{esc(SHOTS['landing']['url'])}">zacharyyamaoka.github.io/folder-sync</a> answered {SHOTS['landing'].get('status')} at {shot_at}: the download buttons, “{esc(SHOTS['landing'].get('gatesLine') or '? of 12 gates pass')}” and the journey video{' (<code>media/desktop-journey.mp4</code>)' if SHOTS['landing'].get('journeyVideo') else ''}.{cite(S['landing'])}</p>
  <ul>
    <li><b>Download buttons:</b> {', '.join(esc(d['text']) for d in downloads)}, each to the <code>desktop-v0.2.0</code> release.</li>
    <li><b>No sideways scroll at 390 px:</b> {'measured, light and dark: the page is ' + str(phone_w.get('scrollWidth')) + ' px wide in a ' + str(phone_w.get('clientWidth')) + ' px window, and no element reaches past the edge outside its own scrolling box.' if no_sideways else 'FAILED: ' + esc(json.dumps(phone_w))}</li>
  </ul>
  <div class="gallery">
    <figure>{img(*land_top, alt="Landing page at 1280 px: Your folder, on every computer and online, Download the app")}<figcaption>Desktop width (1280 px), the top.</figcaption></figure>
    <figure>{img(*land_dl, alt="Landing page at 1280 px: the Desktop app section with the download buttons and the journey video")}<figcaption>Its desktop-app section: downloads and the journey video.</figcaption></figure>
  </div>
  <div class="phones">
    <figure>{img(*land_phone_top, alt="Landing page at 390 px, dark: the top")}<figcaption>Phone width (390 px), dark.</figcaption></figure>
    <figure>{img(*land_phone_dl, alt="Landing page at 390 px: the download buttons and the journey video")}<figcaption>Phone width, the downloads.</figcaption></figure>
  </div>
  <p class="small muted">Shot headless at {shot_at} by <code>docs/report/shoot_evening.mjs</code>, the video paused at 6 s. One small thing seen: the desktop-app heading sits right on its paragraph, with no gap.</p>
</section>

<section id="ev-decided">
  <h2>Decided for you this evening</h2>
  <p class="lead">Each was reversible, so it was done rather than asked. Each has its undo; run any of them yourself.</p>
  <ol class="decisions">
    <li><h3>Landed v0 on <code>main</code></h3>
      <p><code>main</code> on GitHub is now <code>claude/folder-sync-v0</code> @ <code>{tip}</code>. Before today it was <code>{refs['archive/origin-main-pre-v0-land'] or '?'}</code> (Oct 28), tagged <code>archive/origin-main-pre-v0-land</code>.{cite(S['git'])}</p>
      <p class="undo">Undo: <code>git push --force-with-lease origin archive/origin-main-pre-v0-land:main</code>, or revert single merges.</p></li>
    <li><h3>Published the desktop pre-release <code>desktop-v0.2.0</code></h3>
      <p>Public, marked pre-release, unsigned. Pushing the tag started the release workflow.{cite(S['release'])}</p>
      <p class="undo">Undo: <code>gh release delete desktop-v0.2.0 -R {GH_REPO}</code>, then delete the tag (<code>git push origin :refs/tags/desktop-v0.2.0</code>). What was public stays seen.</p></li>
    <li><h3>Pushed <code>gh-pages</code>: the new landing page</h3>
      <p>Now <code>{remote['refs/heads/gh-pages'] or refs['origin/gh-pages'] or '?'}</code>; the earlier tip is tagged <code>archive/origin-gh-pages-pre-wave3</code> (<code>{refs['archive/origin-gh-pages-pre-wave3'] or '?'}</code>).{cite(S['git'])}</p>
      <p class="undo">Undo: <code>git push --force-with-lease origin archive/origin-gh-pages-pre-wave3:gh-pages</code></p></li>
    <li><h3>Replaced the command line: <code>~/.local/bin/folder-sync</code> is now <code>{esc(inst['cli_version'].replace('folder-sync ', '')) or '?'}</code></h3>
      <p>The previous one (<code>v0-29b6e83</code>) is kept beside it{'' if inst['cli_backup'] else ' (NOT FOUND at build time)'}.{cite(S['installed'])}</p>
      <p class="undo">Undo: <code>mv ~/.local/bin/folder-sync.v0-29b6e83-backup ~/.local/bin/folder-sync</code></p></li>
    <li><h3>Quota back to 10 GiB</h3>
      <p><code>bb4282e</code> reverts the temporary 12 GiB (<code>2118ca0</code>). It first went out as Worker <code>{BY_HAND['worker_revert_first']}</code> at 15:17; the live version is <code>{BY_HAND['worker_live']}</code> (15:32), also 10 GiB. Read by hand.{cite(S['wrangler'])}</p>
      <p class="undo">Undo: <code>git revert bb4282e</code>, then deploy. A bare <code>wrangler rollback</code> is not enough: it goes to <code>{BY_HAND['worker_revert_first']}</code>, which is 10 GiB too. <code>npx wrangler rollback {BY_HAND['worker_12gib']}</code> gives 12 GiB back but also drops the Worker changes since 14:00.</p></li>
    <li><h3>Enabled the stall timer</h3>
      <p><code>folder-sync-stall.timer</code>, every 5 minutes, since {jt(first_stall[0]) if first_stall else '?'}.{cite(S['stall'])}</p>
      <p class="undo">Undo: <code>systemctl --user disable --now folder-sync-stall.timer</code></p></li>
    <li><h3>Applied the robotparts D1 migrations</h3>
      <p>They only add; nothing was dropped or rewritten. The database was exported first.{cite(S['wrangler'])}</p>
      <p class="undo">Backup: <code>~/.local/share/folder-sync-backups/d1-folder-sync-accounts-robotparts-2026-11-04-pre-0011.sql</code></p></li>
  </ol>
</section>

<section id="ev-left">
  <h2>Left, and what needs you</h2>
  <ol>
    <li><b>O1 in production:</b> {ms(o1p['value'])} at p50 ({hhmm(o1p['t'])}) and {ms(o1p95['value'])} at p95, against 1 s and 3 s. Test is {ms(o1t['value'])}. Where the production seconds go is still not broken down.{cite(S['status'])}</li>
    <li><b>O3 on R2:</b> ${o3p['value']:.2f} a person-month in production ({hhmm(o3p['t'])}), mostly request charges, against $0.50.{cite(S['status'])}</li>
    <li><b>Payments and bring-your-own-bucket are off</b> and need Stripe test keys. <span class="tag need">needs you</span> only if you want them on; the default is off.</li>
    <li><b>The installers are unsigned.</b> Signing means an Apple Developer account and a Windows code-signing certificate, both paid. <span class="tag need">needs you</span> Recommendation: stay unsigned while you are the only user.</li>
    <li><b>The dirty-connection retry is still missing:</b> 4 in about 166k reads in the G1 probe broke on a dirty connection, and those are not read again yet.{cite(S['g1'])}</li>
    <li><b>The burst-watcher flake is still there:</b> <code>TestWatcherSignalsOnceAfterABurst</code>, red once in CI, {BY_HAND['flake_local']} here.{cite(S['flake'])}</li>
    <li><b>A second flake, new tonight:</b> <code>ui/test/files.spec.mjs:210</code> (“on a machine the tab says to browse online … and is not in the menu”) failed on <code>main</code> @ <code>{tip}</code> (run 41952714897) and {BY_HAND['ui_flake_local']} times here: the “Files” item is sometimes still in the menu after the reload. That run reads G4 red until it is rerun or the test is fixed.{cite(S['ci'], S['flake'])}</li>
    <li><b>Open the desktop app once</b> (menu: “folder-sync”). It is your first real run, on your own account. <span class="tag need">needs you</span></li>
    <li><b>Carried over from the afternoon:</b> vibetracks.dev still sends its sign-in mail as “Robot Parts” (<code>accounts/wrangler.toml</code> line 90).</li>
  </ol>
  <h3>Deliberately not done for this page</h3>
  <ul class="small">
    <li>No commit, push or deploy. The builder change (<code>docs/report/build_nov4.py</code>, <code>shoot_evening.mjs</code>) is uncommitted on <code>claude/folder-sync-v0</code>.</li>
    <li>The afternoon's text is not edited: it is history, true at 15:12. What changed since is listed under its heading.</li>
    <li>The fixture history screenshots are used once, for what red looks like; the charts shown are a fresh render from your real series.</li>
    <li>No GIF fallback for the video: the original MP4 rides beside the VP9 instead. No audit was run.</li>
  </ul>
</section>
"""
    evening = label_cells(evening)

    # ---- the afternoon, from the 15:30 page
    earlier = open(A.earlier, encoding="utf-8").read()
    start, sources_at = earlier.index('<section id="verdict">'), earlier.index('<section id="sources" class="sources">')
    afternoon = earlier[start:sources_at]
    sources_end = earlier.index("</section>", sources_at)
    afternoon_ol = re.search(r"<ol>.*</ol>", earlier[sources_at:sources_end], flags=re.S).group(0)
    earlier_name = os.path.basename(A.earlier)

    since = f"""
<div class="part" id="afternoon">
  <p class="eyebrow">The 15:30 page, unchanged</p>
  <h2 class="part-title">Afternoon, Nov 4: Waves 1–3, as of 15:12</h2>
  <p>Below is the earlier page's body as it was, numbers and all. Since then:</p>
  <ul class="since">
    <li>Wave 3 landed on <code>claude/folder-sync-v0</code> at 15:13, and v0 is now <code>main</code> on GitHub.</li>
    <li>G4 and G11 pass: {summary_now} of 12 gates. Its “not built” and “waits for a green macOS and Windows run” are history.</li>
    <li>The README's O3 row names the provider that holds your folders (<code>4fe6938</code>), so its warning below is resolved.</li>
    <li>The landing page it calls “still the old one” is live with the new content.</li>
    <li>The quota is back to 10 GiB, robotparts.dev has its secrets and your sign-in, and the command line is <code>{esc(inst['cli_version'].replace('folder-sync ', '')) or '?'}</code>.</li>
  </ul>
</div>
"""

    ev_sources = [
        ("git", f"<code>git -C /home/bam/folder-sync</code> at build time: <code>ls-remote origin</code> (main {remote['refs/heads/main']}, claude/folder-sync-v0 {remote['refs/heads/claude/folder-sync-v0']}, gh-pages {remote['refs/heads/gh-pages']}), <code>rev-parse</code> of <code>main</code> ({refs['main']}), <code>desktop-v0.2.0</code>, <code>archive/origin-main-pre-v0-land</code> ({refs['archive/origin-main-pre-v0-land']}), <code>archive/origin-gh-pages-pre-wave3</code> ({refs['archive/origin-gh-pages-pre-wave3']}); <code>git log</code> for <code>bb4282e</code>, <code>4fe6938</code>, <code>2ea3f2a</code>."),
        ("ci", f"<code>gh run view</code> for runs {', '.join(str(r) for r in RUN_NOTES)} and <code>gh run list --commit {tip}</code>, at build time; run 41949468638 attempt 1's job logs (read by hand 19:03): <code>push_test.go:52: a burst of writes signalled twice</code>, then G4 “CI job core-alone, this run: needs.core-alone.result = failure”, “11 pass, 1 fail”; the macOS journey job's log at build time."),
        ("gates", f"<code>reports/status/gates.json</code> (run {esc(gates_now['run_at'])} on <code>{gates_now['code_sha'][:7]}</code>, {summary_now} pass) and <code>reports/status/gates-history.jsonl</code> ({len(history)} runs); run 41949468638 attempt 2's <code>gates (linux)</code> log: “12 pass”."),
        ("g1", "Commit <code>419c2ff</code> (<code>lane/g1-soak</code>, merged as <code>0c9c02b</code>): the two failure shapes (seeds 4 and 81), the probe counts (681 / 283 / 622 / 4 per ~166k reads), 17,766 empty-lock sightings before the fix, 85 seeds 0 failures after, the <code>keepLocalEdit</code> mutation."),
        ("release", f"<code>gh release view desktop-v0.2.0</code> at build time: pre-release {(release or {}).get('isPrerelease')}, published {(release or {}).get('publishedAt')}, target <code>{((release or {}).get('targetCommitish') or '')[:7]}</code>, {len(assets)} assets; <code>.github/workflows/desktop-release.yml</code> (tag-triggered, always <code>--prerelease</code> while unsigned)."),
        ("desktop", "<code>reports/media/desktop-2026-11-04-*.png</code>, <code>desktop-journey-2026-11-04.mp4</code> and <code>desktop-real-window-2026-11-04.json</code> (written by <code>app/scripts/real_window.mjs</code>: the Tauri binary on Xvfb, a local stack, the test person desktop-real@example.com); <code>app/test/journey.mjs</code> header and lines 256–263 (edits both ways); <code>.github/workflows/test.yml</code> job <code>desktop-journey</code>. Each image was looked at before use."),
        ("installed", f"At build time: <code>{esc(inst['appimage'])}</code> sha256 {(inst['appimage_sha'] or '?')[:16]}… ({'equal to' if same_bytes else 'NOT equal to'} <code>reports/media/folder-sync_0.2.0_amd64.AppImage</code>); <code>~/.local/share/applications/folder-sync.desktop</code> Exec {esc(inst['menu_exec'] or 'missing')}; <code>~/.local/bin/folder-sync version</code> → {esc(inst['cli_version'])}; the <code>.v0-29b6e83-backup</code> beside it."),
        ("stall", f"<code>bench/kpi/stall.mjs</code> header; <code>systemctl --user is-enabled / is-active folder-sync-stall.timer</code> and <code>journalctl --user -u folder-sync-stall.service</code> at build time ({stall['count']} runs logged); commit <code>2ea3f2a</code> (O1's headline leaves out real-use samples)."),
        ("cost", f"<code>bench/cost/competitors.json</code> (as of {esc(as_of)}, every row's source URL and access date); the README's generated “By size” table; vault note <code>{esc(vault_note)}</code>."),
        ("status", f"<code>scripts/status --out</code> on the real series at {hhmm(EV['generated_at'])}: O1 production p50 {ms(o1p['value'])} at {hhmm(o1p['t'])}, p95 {ms(o1p95['value'])}; O3 R2 production ${o3p['value']:.2f}, test ${o3t['value']:.2f} a person-month."),
        ("wrangler", f"Read by hand 19:05–19:12: <code>npx wrangler deployments list</code> in <code>accounts/</code> (… 939afe92 22:17:55Z, bed0a34c 22:32:40Z) and with <code>--env robotparts</code> (e16f68d0 23:03:43Z); <code>wrangler versions view</code>: QUOTA_BY_OWNER 10 GiB on 939afe92 and bed0a34c, 12 GiB on 0a0f5357; <code>accounts/wrangler.toml</code> <code>[env.robotparts]</code>; <code>~/.local/share/folder-sync-backups/</code>."),
        ("robotparts", "Read by hand 19:11: <code>wrangler d1 execute folder-sync-accounts-robotparts --env robotparts --remote</code>, one read-only <code>SELECT COUNT(*)</code> over user, account (provider google) and session."),
        ("secrets", "<code>accounts/scripts/set-secrets/google-create-client.png</code>, <code>cloudflare-token-form.png</code>, <code>cloudflare-token-list.png</code>; commit <code>29dac21</code>. Looked at before use; no secret value is visible in them."),
        ("landing", f"<code>docs/report/shoot_evening.mjs</code> at {shot_at}: headless Chromium on {esc(SHOTS['landing']['url'])} at 1280 px light and 390 px light and dark; <code>scrollWidth</code> against <code>clientWidth</code> and every element's right edge; the download links and the gates line read from the page; <code>origin/gh-pages</code> commit <code>234ed8c</code>."),
        ("devview", "The dev view rendered for this page by <code>scripts/status --out</code> on the real series and shot by <code>shoot_evening.mjs</code>; the seeded-fixture views in <code>reports/media/history-2026-11-04-*.png</code> (their prices read “Fixture Drive A” and the like); <code>scripts/dev-view-vendor/README.md</code> (Chart.js 4.4.7, inlined)."),
        ("flake", "Read by hand 19:20: <code>go test -run 'TestWatcherSignalsOnceAfterABurst$' -count=30 ./internal/push</code> → <code>ok folder-sync/internal/push 12.150s</code>. 19:29: <code>npx playwright test test/files.spec.mjs -g \"on a machine the tab says\" --repeat-each 30 --workers 4</code> in <code>ui/</code> → 29 passed, 1 failed, on the same assertion as run 41952714897's (<code>files.spec.mjs:217</code>, “Files” menuitem: expected 0, received 1)."),
        ("brief", "The dispatcher's evening brief (19:00): that you have not run the desktop app yet, and the list of reversible steps it took. Each step's state was checked against git, GitHub, wrangler or the file system as cited beside it."),
    ]
    ev_ol = "".join(f'<li id="s{S[key]}">{text}</li>' for key, text in ev_sources)

    sources = f"""
<section id="sources" class="sources">
  <h2>Source index</h2>
  <h3>Afternoon, 1–21 (unchanged)</h3>
  {afternoon_ol}
  <h3>Evening, {EV_FIRST_SOURCE}–{EV_FIRST_SOURCE + len(ev_sources) - 1}</h3>
  <ol start="{EV_FIRST_SOURCE}">{ev_ol}</ol>
</section>

<section id="earlier-versions" class="earlier">
  <h2>Earlier versions of this page</h2>
  <ul>
    <li><a href="{esc(earlier_name)}">{esc(earlier_name)}</a>: the 15:30 version (built 15:12), before the evening section. The afternoon part above is its body, unchanged.</li>
    <li><a href="folder-sync-2026-11-04-1029.html">folder-sync-2026-11-04-1029.html</a>: the 10:29 version, the morning's.</li>
  </ul>
</section>
"""

    page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Folder Sync Nov 4</title>
<meta name="description" content="folder-sync, Nov 4 2026: the evening (v0 on main, 12 of 12 gates, desktop app 0.2.0, the passive stall check, cost by size) over the afternoon's Waves 1-3 review.">
<style>{CSS}{EV_CSS}</style>
</head>
<body>
<div class="wrap">

<header class="top">
  <p class="eyebrow">folder-sync · review packet · 2026-11-04 · evening, over Waves 1–3</p>
  <h1>folder-sync v0 is on main with {summary_now} of 12 gates, and the desktop app is out as a pre-release; two timing flakes are left</h1>
  <p class="meta">The evening section is new; the afternoon below it is the 15:30 page, unchanged (linked at the bottom). Built {CHECKED_AT}. Times are this machine's clock (UTC−7).</p>
</header>
{evening}
{since}
{afternoon}
{sources}
<footer>Built {datetime.now(LOCAL).strftime('%Y-%m-%d %H:%M')} by <code>docs/report/build_nov4.py --earlier {esc(earlier_name)}</code>. Self-contained: no network, no server.</footer>
</div>
</body>
</html>
"""
    with open(A.out, "w", encoding="utf-8") as handle:
        handle.write(page)
    print(A.out, os.path.getsize(A.out))


if __name__ == "__main__":
    build_evening() if A.earlier else build()
