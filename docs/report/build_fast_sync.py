#!/usr/bin/env python3
"""Builds the fast-sync review report (PEP 0004) from the measured JSON and the recorded clips.

    python3 docs/report/build_fast_sync.py [--media DIR] [--out FILE]

Inputs (DIR, default /home/bam/folder-sync/reports/media/fast-sync-2026-10-26/): before-ab.json, after.json,
after2.json (robotparts tools/sync_bench.py), idle-*.json, online-only.txt, push.* and polling.* (tools/sync_video.py).
Out: one self-contained page beside DIR (media referenced relatively), default
/home/bam/folder-sync/reports/media/fast-sync-2026-10-26.html.
"""

from __future__ import annotations

import argparse
import html
import json
import pathlib
import re
import statistics

MEDIA = pathlib.Path("/home/bam/folder-sync/reports/media/fast-sync-2026-10-26")


def load(media, name):
    return json.loads((media / name).read_text())


def mean(values):
    values = [v for v in values if v is not None]
    return round(statistics.mean(values)) if values else 0


def stages_site_to_disk(run, push=False):
    put, wait, pull = [], [], []
    for t in run["site_to_disk"]:
        tr = t["machines"]["laptop"]["trace"]
        put.append(t["put_done"] - t["t0"])
        if tr:
            wait.append(tr["step"]["start"] - t["put_done"])
            pull.append(tr["step"]["ms"])
    return [("Page PUT → Worker → R2", mean(put), "work"),
            ("Hub tells the machine → its round starts" if push else "Waiting for the next round", mean(wait), "work" if push else "wait"),
            ("Pull: manifest GET + rclone copy", mean(pull), "work")]


def stages_disk_to_page(run, push):
    notice, work, hop, fetch, render = [], [], [], [], []
    for t in run["disk_to_site"]:
        tr = t.get("push")
        if not tr or not t.get("page"):
            continue
        step = tr["step"]
        end = step["start"] + step["ms"]
        fetches = t.get("page_fetches") or ([t["page_fetch"]] if t.get("page_fetch") else [])
        f = next((f for f in fetches if f and f["start"] >= end - 1 and f.get("end")), None)
        if not f:
            continue
        notice.append(step["start"] - t["t0"])
        work.append(step["ms"])
        hop.append(f["start"] - end)
        fetch.append(f["end"] - f["start"])
        render.append(t["page"] - f["end"])
    return [("Noticing the edit" + (" (100 ms debounce)" if push else " (waiting for the 2 s round)"), mean(notice), "work" if push else "wait"),
            ("Push: scan + rclone copy + manifest", mean(work), "work"),
            ("Hub broadcast → page asks" if push else "Waiting for the page's 10 s re-read", mean(hop), "work" if push else "wait"),
            ("Page reads the bundle", mean(fetch), "work"), ("Render", mean(render), "work")], len(notice)


def waterfall(rows, scale_ms, width=760):
    """rows: [(label, [(stage, ms, kind)])] -> an SVG of stacked bars on one time axis."""
    bar_h, gap, left = 26, 30, 150
    height = len(rows) * (bar_h + gap) + 40
    usable = width - left - 20
    px = usable / scale_ms
    out = [f'<svg viewBox="0 0 {width} {height}" class="wf" role="img">']
    for tick in range(0, scale_ms + 1, 1000 if scale_ms > 3000 else 250):
        x = left + tick * px
        out.append(f'<line x1="{x:.1f}" y1="10" x2="{x:.1f}" y2="{height - 22}" class="grid"/>')
        out.append(f'<text x="{x:.1f}" y="{height - 6}" class="tick" text-anchor="middle">{tick / 1000:g} s</text>')
    y = 14
    for label, stages in rows:
        total = sum(ms for _s, ms, _k in stages)
        out.append(f'<text x="{left - 8}" y="{y + bar_h * 0.68:.1f}" class="lab" text-anchor="end">{html.escape(label)}</text>')
        x = left
        for stage, ms, kind in stages:
            w = max(ms * px, 1.5)
            out.append(f'<rect x="{x:.1f}" y="{y}" width="{w:.1f}" height="{bar_h}" class="{kind}"><title>{html.escape(stage)}: {ms} ms</title></rect>')
            if w > 64:
                out.append(f'<text x="{x + 5:.1f}" y="{y + bar_h * 0.68:.1f}" class="in">{ms} ms</text>')
            x += w
        out.append(f'<text x="{x + 6:.1f}" y="{y + bar_h * 0.68:.1f}" class="tot">{total / 1000:.2f} s</text>')
        y += bar_h + gap
    out.append("</svg>")
    return "".join(out)


def legend(stages):
    return "<ol class='leg'>" + "".join(f"<li class='{k}'><b>{ms} ms</b> {html.escape(s)}</li>" for s, ms, k in stages) + "</ol>"


def s(summary, a, b):
    return summary[a][b]["mean"] / 1000


CSS = """
:root { --bg:#ffffff; --fg:#1d2228; --mut:#5d6670; --line:#e3e6ea; --card:#f6f7f9; --wait:#d9534f; --work:#3a7bd5; --ok:#2e7d32; --code:#f1f3f5; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#111418; --fg:#e4e7eb; --mut:#9aa3ad; --line:#2a2f36; --card:#181c21; --wait:#e06763; --work:#5b9bf0; --ok:#66bb6a; --code:#1c2127; } }
:root[data-theme="dark"] { --bg:#111418; --fg:#e4e7eb; --mut:#9aa3ad; --line:#2a2f36; --card:#181c21; --wait:#e06763; --work:#5b9bf0; --ok:#66bb6a; --code:#1c2127; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1060px; margin: 0 auto; padding: 28px 16px 80px; }
h1 { font-size: 26px; margin: 0 0 6px; } h2 { font-size: 19px; margin: 40px 0 10px; border-top: 1px solid var(--line); padding-top: 22px; }
h3 { font-size: 15.5px; margin: 22px 0 6px; }
.verdict { background: var(--card); border-left: 4px solid var(--ok); padding: 14px 16px; border-radius: 6px; }
.verdict p { margin: 6px 0; } .mut { color: var(--mut); } code { background: var(--code); padding: 1px 4px; border-radius: 3px; font-size: 13px; }
table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 13.5px; } th, td { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
th { background: var(--card); } td.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; } .win { color: var(--ok); font-weight: 700; }
.scroll { overflow-x: auto; }
video, img { max-width: 100%; border: 1px solid var(--line); border-radius: 6px; display:block; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; } @media (max-width: 760px) { .two { grid-template-columns: 1fr; } }
figure { margin: 10px 0 18px; } figcaption { color: var(--mut); font-size: 13px; margin-top: 4px; }
svg.wf { width: 100%; height: auto; } .wf .grid { stroke: var(--line); } .wf .tick, .wf .lab, .wf .tot { fill: var(--fg); font-size: 12px; }
.wf .tot { font-weight: 700; } .wf .wait { fill: var(--wait); } .wf .work { fill: var(--work); } .wf .in { fill: #fff; font-size: 11px; }
.leg { display: flex; flex-wrap: wrap; gap: 4px 16px; padding: 0; list-style: none; font-size: 12.5px; margin: 2px 0 14px; }
.leg li::before { content: ""; display: inline-block; width: 10px; height: 10px; margin-right: 5px; border-radius: 2px; background: var(--work); } .leg li.wait::before { background: var(--wait); }
.key span { display:inline-block; width:10px; height:10px; border-radius:2px; margin: 0 4px 0 10px; } .key .w { background: var(--wait);} .key .k { background: var(--work);}
ul.tight li { margin: 3px 0; }
.diagram { width: 100%; height: auto; } .diagram text { fill: var(--fg); font-size: 12.5px; } .diagram .box { fill: var(--card); stroke: var(--mut); } .diagram .hub { fill: var(--card); stroke: var(--ok); stroke-width: 2; }
.diagram .arrow { stroke: var(--work); stroke-width: 2; fill: none; marker-end: url(#ah); } .diagram .data { stroke: var(--mut); stroke-dasharray: 4 3; stroke-width: 1.5; fill: none; marker-end: url(#ahm); }
"""


def build(media: pathlib.Path) -> str:
    before = load(media, "before-ab.json")
    after = load(media, "after.json")
    after2 = load(media, "after2.json")
    first = load(media, "before-final.json")
    smoke = load(media, "smoke.json")["summary"]
    idle_b, idle_a = load(media, "idle-before.json"), load(media, "idle-after.json")
    online = json.loads((media / "online-only.txt").read_text().strip().splitlines()[-1])["browser_to_browser_ms"]
    push_clip, poll_clip = load(media, "push.json"), load(media, "polling.json")
    sb, sa, sa2 = before["summary"], after["summary"], after2["summary"]

    s2d_b, s2d_a = stages_site_to_disk(before), stages_site_to_disk(after2, True)
    d2p_b, nb = stages_disk_to_page(before, False)
    d2p_a, na = stages_disk_to_page(after2, True)
    wf_page = waterfall([("Polling", d2p_b), ("Push", d2p_a)], 7000)
    wf_page_zoom = waterfall([("Push", d2p_a)], 1000)
    wf_site = waterfall([("Polling", s2d_b), ("Push", s2d_a)], 1250)

    rows = [
        ("Page write → laptop disk", s(sb, "site_to_disk", "laptop"), s(sa, "site_to_disk", "laptop")),
        ("Page write → desktop disk", s(sb, "site_to_disk", "desktop"), s(sa, "site_to_disk", "desktop")),
        ("Laptop disk → served at <code>/fs/</code>", s(sb, "disk_to_site", "served"), s(sa, "disk_to_site", "served")),
        ("Laptop disk → the open page", s(sb, "disk_to_site", "page"), s(sa, "disk_to_site", "page")),
        ("Laptop disk → desktop disk", s(sb, "disk_to_site", "desktop"), s(sa, "disk_to_site", "desktop")),
        ("A new machine joins → laptop has its file", before["join"]["ms"] / 1000, after["join"]["ms"] / 1000),
    ]
    numbers = "".join(f"<tr><td>{a}</td><td class='n'>{b:.2f} s</td><td class='n win'>{c:.2f} s</td><td class='n'>{b / c:.0f}×</td></tr>" for a, b, c in rows)
    numbers += (f"<tr><td>Browser → browser, no machine running</td><td class='n'>≈5 s (10 s poll)</td><td class='n win'>{online['mean'] / 1000:.2f} s</td><td class='n'></td></tr>"
                f"<tr><td>Idle, per machine, 60 s</td><td class='n'>{idle_b['rounds']} rounds · {idle_b['rclone']} rclone · {idle_b['cpu_pct']} % core</td>"
                f"<td class='n win'>{idle_a['rounds']} round · {idle_a['rclone']} rclone · {idle_a['cpu_pct']} % core</td><td class='n'>{idle_b['cpu_pct'] / max(idle_a['cpu_pct'], 0.01):.0f}×</td></tr>")

    diagram = """<svg viewBox="0 0 900 300" class="diagram" role="img" aria-label="push sync architecture">
<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#3a7bd5"/></marker>
<marker id="ahm" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#888"/></marker></defs>
<rect x="340" y="18" width="220" height="74" rx="8" class="hub"/><text x="450" y="44" text-anchor="middle" font-weight="700">FolderHub (Durable Object)</text>
<text x="450" y="62" text-anchor="middle">one per (person, project)</text><text x="450" y="79" text-anchor="middle">hibernating WebSockets · cursor + seq per host</text>
<rect x="340" y="212" width="220" height="64" rx="8" class="box"/><text x="450" y="238" text-anchor="middle" font-weight="700">R2 bucket (unchanged)</text><text x="450" y="256" text-anchor="middle">manifests + files, single writer per host</text>
<rect x="20" y="120" width="190" height="64" rx="8" class="box"/><text x="115" y="146" text-anchor="middle" font-weight="700">laptop: sync --watch</text><text x="115" y="164" text-anchor="middle">fsnotify → round → announce</text>
<rect x="690" y="120" width="190" height="64" rx="8" class="box"/><text x="785" y="146" text-anchor="middle" font-weight="700">desktop: sync --watch</text><text x="785" y="164" text-anchor="middle">"changed" → pull now</text>
<rect x="355" y="120" width="190" height="64" rx="8" class="box"/><text x="450" y="146" text-anchor="middle" font-weight="700">page + accounts Worker</text><text x="450" y="164" text-anchor="middle">web host writes, then notifies</text>
<path d="M150,120 C170,70 260,55 338,55" class="arrow"/><text x="182" y="78">changed {host, seq}</text>
<path d="M562,55 C650,55 740,70 760,118" class="arrow"/><text x="650" y="78">changed → everyone else</text>
<path d="M450,118 L450,94" class="arrow"/>
<path d="M115,186 C130,240 250,245 338,244" class="data"/><text x="160" y="232">rclone push</text>
<path d="M562,244 C660,244 770,240 785,188" class="data"/><text x="680" y="232">GET manifest + file</text>
<path d="M450,186 L450,210" class="data"/>
</svg>"""

    options = """<table><tr><th>Option</th><th>Each way</th><th>Online only / local+online / multi-machine</th><th>Offline</th><th>Conflicts</th><th>Cloudflare $/mo at Zach's scale</th><th>Effort</th><th>Risk</th><th>Folder is the database</th></tr>
<tr><td>(a) tune polling (0.5 s rounds, discover each round, 1 s page poll)</td><td>0.3–1.5 s</td><td>yes / yes / yes</td><td>unchanged</td><td>unchanged</td><td>grows with devices × hosts ÷ interval: ≈$10 at 2 s, ≈$95 for a 15-device team project; more at 0.5 s</td><td>low</td><td>cost and idle CPU scale the wrong way (3.3 % of a core at 2 s, measured)</td><td>yes</td></tr>
<tr class="pick"><td><b>(b) watcher + Durable Object hub — built</b></td><td><b>0.24–0.75 s measured</b></td><td>yes / yes / yes (all proved)</td><td>unchanged; catch-up from hello + 60 s safety poll</td><td>unchanged (single writer; peer edits → conflicts/)</td><td><b>$0</b> beyond the $5 Workers Paid plan (≈15 % of request and ≈2 % of duration allowance)</td><td>medium (done: ≈1,000 lines + ≈1,000 lines of tests)</td><td>hub is a hint only; WebSocket through app mounts proved locally</td><td>yes</td></tr>
<tr><td>(c) R2 event notifications → Queue → DO</td><td>seconds (Queue batches 1–5 s; R2 latency unpublished)</td><td>yes / yes / yes</td><td>unchanged</td><td>unchanged</td><td>$0–1</td><td>medium</td><td>slower than (b); no local stand-in to test with</td><td>yes</td></tr>
<tr><td>(d) replace rclone with native S3 calls / own protocol</td><td>(b) minus ≈150 ms</td><td>yes / yes / yes</td><td>must be rebuilt</td><td>must be rebuilt</td><td>$0</td><td>high</td><td>rewrites the tested engine</td><td>yes</td></tr>
<tr><td>(e) off-the-shelf engine (Syncthing, Replicache/Zero, Electric, PowerSync)</td><td>sub-second</td><td>Syncthing: no online copy; others: a database, not files</td><td>varies</td><td>their own</td><td>$0–49+</td><td>high</td><td>a second source of truth</td><td>no (Syncthing yes)</td></tr></table>"""

    prior = """<table><tr><th>System</th><th>Push mechanism</th><th>Latency</th><th>Offline</th><th>Conflicts</th><th>Multi-device</th><th>Cost at Zach's scale</th></tr>
<tr><td>Obsidian Sync</td><td>WebSocket; server pushes file metadata, client pulls content by id</td><td>not published; forum: near-instant to ~10 s</td><td>full vault, replay since last version</td><td>markdown: diff-match-patch merge; others: last modified; settings JSON merged</td><td>hub; 1 or 10 vaults</td><td>$4–5 / $8–10 per user/mo; no web view or API</td></tr>
<tr><td>Dropbox</td><td>long-poll to a notification server → <code>list</code> by cursor → 4 MB blocks; LAN sync</td><td>not published ("up to 2×" with Streaming Sync)</td><td>full</td><td>conflicted copy</td><td>yes</td><td>CA$12.99/mo</td></tr>
<tr><td>Syncthing</td><td>peer to peer: IndexUpdate then block requests; local + global discovery; relays</td><td>watcher waits 10 s; hourly rescan</td><td>full</td><td><code>.sync-conflict</code> copy</td><td>mesh</td><td>free; no cloud copy</td></tr>
<tr><td>iCloud (CloudKit)</td><td>silent APNs push → scheduled fetch</td><td>"usually within a few seconds"</td><td>deferred</td><td>—</td><td>Apple only</td><td>per user</td></tr>
<tr><td>Google Drive</td><td><code>changes.watch</code> webhook (empty body) → <code>changes.list</code></td><td>not published</td><td>desktop client</td><td>—</td><td>no Linux client</td><td>per user</td></tr>
<tr><td>Logseq DB sync (2026)</td><td>Worker + SQLite DO per graph, hibernating WebSockets, R2, D1</td><td>not published</td><td>offline rebase</td><td>server order + rebase</td><td>yes, E2EE</td><td>paid; self-host</td></tr>
<tr><td>tldraw sync</td><td>one DO per room, WebSocket</td><td>not published</td><td>—</td><td>server authoritative</td><td>yes</td><td>own Cloudflare bill</td></tr>
<tr><td>Figma / Linear</td><td>WebSocket, server authoritative / delta packets by sync id</td><td>not published</td><td>re-applied / queued</td><td>LWW per property / server order</td><td>yes</td><td>—</td></tr>
<tr><td>Replicache / Zero</td><td>contentless "poke" → pull / persistent connection to zero-cache</td><td>Zero: next frame locally</td><td>reads yes</td><td>server + rebase</td><td>yes</td><td>needs Postgres</td></tr>
<tr><td>ElectricSQL / PowerSync</td><td>HTTP long-poll or SSE / HTTP/2 or WebSocket stream</td><td>PowerSync "&lt; 1 s" (vendor)</td><td>local DB</td><td>your backend</td><td>yes</td><td>Electric Cloud winding down; PowerSync Pro $49+</td></tr>
<tr><td>Yjs / Automerge / Liveblocks</td><td>WebSocket relay / hosted rooms</td><td>not published</td><td>full local doc</td><td>CRDT merge</td><td>yes</td><td>self-host / $25–30</td></tr>
<tr><td><b>folder-sync + PEP 0004</b></td><td>hub "changed {host, seq}" over hibernating WebSocket → GET from R2</td><td><b>0.24–0.75 s (measured, local)</b></td><td>files are the truth; catch-up</td><td>single writer per host</td><td>machines + browsers</td><td>$0 inside allowances</td></tr></table>
<p class="mut">Sources with URLs and access dates: the vault note <i>C - Fast file sync (prior art)</i> (Source Index, 2026-10-26).</p>"""

    first_note = (f"An earlier baseline on the pre-rebase build (first run, 10 trials) agreed: page write → laptop disk "
                  f"{first['summary']['site_to_disk']['laptop']['mean'] / 1000:.2f} s, disk → page {first['summary']['disk_to_site']['page']['mean'] / 1000:.2f} s, "
                  f"a new machine {first['join']['ms'] / 1000:.0f} s. Zach's 9.6 s was this same page wait, sampled at one phase of the 10 s timer.")

    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fast folder sync</title><style>{CSS}</style></head><body><main>
<h1>Fast folder sync: push instead of poll</h1>
<p class="mut">folder-sync PEP 0004 · prototype on <code>lane/fast-sync</code> (folder-sync and robotparts), not merged · measured 2026-10-26 on the local stack (2 machines + a page, R2 stand-in, wrangler dev)</p>
<div class="verdict">
<p><b>Copy Obsidian's model: a tiny "host H is now at seq N" push over one hibernating WebSocket per folder, then fetch as today. Built and measured: an agent's edit now reaches the open page in {s(sa, 'disk_to_site', 'page'):.2f} s instead of {s(sb, 'disk_to_site', 'page'):.1f} s, a page write reaches every machine in {s(sa, 'site_to_disk', 'laptop'):.2f} s instead of {s(sb, 'site_to_disk', 'laptop'):.1f} s, and a new machine is seen in {after['join']['ms'] / 1000:.2f} s instead of {before['join']['ms'] / 1000:.0f} s.</b></p>
<p>Cost: <b>$0 extra</b> on Cloudflare at this scale (inside Workers Paid's $5 plan), and <b>less</b> compute: an idle machine went from {idle_b['cpu_pct']} % of a core to {idle_a['cpu_pct']} %. Works online only (browser → browser {online['mean'] / 1000:.2f} s with no machine running), local + online, and across machines. Qualification: local stack only — real R2 and the Cloudflare edge are not measured yet, and nothing is deployed.</p>
</div>

<h2>See it</h2>
<div class="two">
<figure><video src="fast-sync-2026-10-26/push.mp4" autoplay muted loop playsinline controls poster="fast-sync-2026-10-26/push-step1-pane.png"></video>
<figcaption><b>Push (PEP 0004)</b>, real time. Step 1: an agent writes a heart on the laptop → desktop disk <b>{push_clip['step1']['desktop_ms']} ms</b>, open page <b>{push_clip['step1']['page_ms']} ms</b>. Step 2: un-heart on the page → both disks <b>{push_clip['step2']['laptop_ms']} ms</b>. <a href="fast-sync-2026-10-26/push.gif">GIF</a></figcaption></figure>
<figure><video src="fast-sync-2026-10-26/polling.mp4" muted loop playsinline controls poster="fast-sync-2026-10-26/polling-step1-pane.png"></video>
<figcaption><b>Polling (same build, <code>--no-push</code>)</b>, real time, same script: desktop disk <b>{poll_clip['step1']['desktop_ms']} ms</b>, open page <b>{poll_clip['step1']['page_ms']} ms</b>; page → laptop <b>{poll_clip['step2']['laptop_ms']} ms</b>, desktop <b>{poll_clip['step2']['desktop_ms']} ms</b>. <a href="fast-sync-2026-10-26/polling.gif">GIF</a></figcaption></figure>
</div>

<h2>Before and after (same build, push on vs off)</h2>
<div class="scroll"><table><tr><th>Path (mean of 10, random phase)</th><th>Polling</th><th>Push</th><th>Faster</th></tr>{numbers}</table></div>
<p class="mut">{first_note} A second push run gave {s(sa2, 'site_to_disk', 'laptop'):.2f} s page → disk and {s(sa2, 'disk_to_site', 'page'):.2f} s disk → page; the table keeps the slower first run. After the final rebase onto <code>lane/accounts</code>'s review-r2 fixes, a 5-trial smoke run still pushes: {s(smoke, 'site_to_disk', 'laptop'):.2f} s page → disk, {s(smoke, 'disk_to_site', 'page'):.2f} s disk → page, a new machine in 0.36 s — about 0.15 s slower than before those fixes; that extra time is not broken down yet.</p>

<h2>Where each second goes</h2>
<p class="key">Waterfalls, means per stage from each machine's <code>FOLDER_SYNC_TRACE</code> and the page's own fetch stamps.<span class="w"></span>waiting on a timer<span class="k"></span>doing work</p>
<h3>Laptop disk → the open page</h3>
{wf_page}
<p class="mut">Polling ({nb} trials):</p>{legend(d2p_b)}
<p class="mut">Push ({na} trials), zoomed to 1 s:</p>{wf_page_zoom}{legend(d2p_a)}
<h3>Page write → laptop disk</h3>
{wf_site}
<p class="mut">Polling:</p>{legend(s2d_b)}<p class="mut">Push:</p>{legend(s2d_a)}

<h3>The causes, named</h3>
<ul class="tight">
<li><b>The page's 10 s re-read</b> — the biggest: ≈4.8 s average wait (0–10 s). Gone: the page re-reads on the hub's message (≈0.1 s after the push).</li>
<li><b>The 2 s round</b> (the demo's setting; the committed default is 10 s, i.e. 5× worse) — ≈0.8–1 s average wait on each side. Gone: fsnotify starts the writer's round 100 ms after an edit; the hub starts the reader's round at once.</li>
<li><b>Host discovery every 5 minutes</b> — a new machine or a new web host waited up to 300 s (measured 144–185 s). Gone: an unknown host in a hub message triggers a discover in that round, and <code>sync --once</code> announces itself.</li>
<li><b>rclone process start-up</b> — ≈55 ms per call, three per pushing round, one per idle round (the folder scan). Still there; it is now the largest remaining piece (option d).</li>
<li><b>R2 list consistency</b> — not a cause: R2 is strongly consistent, and readers never LIST on the hot path (manifest GET with <code>If-None-Match</code>, ≈2 ms when unchanged).</li>
</ul>

<h2>How it works</h2>
{diagram}
<ul class="tight">
<li><b>Machines</b> (<code>internal/push</code>): an fsnotify watcher (recursive, ignores <code>hosts/</code> and temp files, 100 ms debounce) and a hub client (<code>coder/websocket</code>, bearer from <code>account.json</code>, 30 s ping, backoff reconnect). A round runs on a change; after a manifest write it sends <code>changed</code>. The timer stays as a 60 s safety net while both are live, else the configured interval. <code>--no-push</code> is the old loop exactly.</li>
<li><b>Hub</b> (<code>accounts/src/hub.ts</code>): <code>GET /fs/v1/folders/&lt;project&gt;/events</code>, same auth as reads (+ an Origin check for cookie sockets), hibernation API, <code>ping</code> auto-answered without waking it. Only owner machines may announce; seq moves forward only; the sender doesn't hear its own echo.</li>
<li><b>Web host</b>: after each web write the Worker notifies the hub in <code>ctx.waitUntil</code>, so the write never waits for it.</li>
<li><b>Page</b> (<code>site/static/account.js</code>): one WebSocket on its own origin; re-reads on <code>hello</code>/<code>changed</code>; 10 s poll only while the socket is down, 60 s safety otherwise.</li>
<li><b>The hub is a hint.</b> The manifests in R2 stay the truth; a lost message costs one safety interval, never data.</li>
</ul>

<h2>Online only, and two machines</h2>
<div class="two"><figure><img src="fast-sync-2026-10-26/online-a.png" alt="browser A part page with heart"><figcaption>Browser A hearts the part…</figcaption></figure>
<figure><img src="fast-sync-2026-10-26/online-b.png" alt="browser B saved page"><figcaption>…browser B's /saved/ shows it: {online['mean']} ms mean over {online['n']} hearts and un-hearts, with <b>no machine running</b>.</figcaption></figure></div>
<div class="two"><figure><img src="fast-sync-2026-10-26/push-step2-pane.png" alt="both machines' folders"><figcaption>Both machines' real folders after step 2: the laptop's own <code>saved/</code> file, the desktop's copy of it, and the web host's un-heart on both.</figcaption></figure>
<figure><img src="fast-sync-2026-10-26/push-step1-page.png" alt="saved page row"><figcaption>The page after step 1: the agent's heart, shown without a reload.</figcaption></figure></div>

<h2>Options and cost</h2>
<div class="scroll">{options}</div>
<p><b>Recommendation: (b), built.</b> Cloudflare cost at 5 people × 3 devices + 3 pages, 2,000 changes/day, fan-out 4, pessimistic (30 s heartbeats billed, 24 reconnects/socket/day, 1 s per wake): ≈151k DO requests/month (1M included), ≈9,100 GB-s (400k included), outgoing messages free, R2 ≈120k Class A / 480k Class B (1M / 10M free) → <b>$0 beyond the $5/month Workers Paid plan</b>. Without hibernation the same load would be ≈$25/month; polling R2 every 2 s is ≈$10/month for 15 devices and ≈$95 for a 15-device team project. Prices: developers.cloudflare.com durable-objects, r2, workers and queues pricing pages (accessed 2026-10-26).</p>

<h2>Prior art</h2>
<div class="scroll">{prior}</div>

<h2>The Obsidian-like app</h2>
<p>PEP 0005 (draft, not built): <b>Tauri 2</b> with the folder-sync Go binary as its sidecar (scored 88 vs Electron 82 vs a no-shell service + tray 85). Sign-in opens the system browser on the existing device grant's <code>verification_uri_complete</code>, so it is one click on <i>Approve</i>, no code typed (RFC 8252); the app creates <code>~/robotparts</code>, runs <code>sync --watch</code> in the background with login autostart and a tray, and shows robotparts.dev in its window. Reuse: ClaudeParty's per-user install, sha256 update manifest and rollback; stable_preview_switcher's channels. Needs from folder-sync: <code>login --json</code> and hub/watcher state in <code>status --json</code>; later a local <code>serve</code> for offline.</p>

<h2>Decision surface</h2>
<h3>Done and proved</h3>
<ul class="tight"><li>Latency broken down from real traces (above); A/B on one build, 10 trials per path.</li>
<li>Hub: 55 node tests + a live proof against wrangler dev (23 checks, incl. 101 through robotparts' <code>/fs/</code> forwarder). Go: <code>go test ./...</code> green incl. e2e; watcher, hub client, one-shot announce tested. robotparts: 21 account tests green.</li>
<li>Two machines + a page, online-only browsers, and a joining machine — each measured.</li></ul>
<h3>Left</h3>
<ul class="tight"><li>Real R2 + a deployed Worker: same benchmark against the edge (blocked on deploy, which is Zach's).</li>
<li>Option (d): native S3 calls instead of rclone processes and pulling only the named host (next ≈150–250 ms).</li>
<li>Show hub/watcher state in <code>folder-sync status --json</code> (for the app's tray).</li></ul>
<h3>Needs Zach</h3>
<ul class="tight"><li><b>Merge?</b> Recommend: review PEP 0004, then merge folder-sync <code>lane/fast-sync</code> after <code>lane/accounts</code> lands. Default if silent: it stays on its branch, rebased on <code>lane/accounts</code>.</li>
<li><b>Desktop app shell:</b> recommend Tauri, with the no-shell service + tray as the first tracer. Default if silent: nothing is built until asked.</li></ul>
<h3>Deliberately not done</h3>
<ul class="tight"><li>No deploy, no real credentials, no production bucket (test values from the dev stack only).</li>
<li>No merge into <code>lane/accounts</code> or <code>main</code>. No desktop app code (design only, as asked).</li>
<li>Kept <code>--no-push</code> and every poll as a fallback rather than removing them.</li></ul>
<p class="mut">Built by docs/report/build_fast_sync.py on folder-sync lane/fast-sync from the JSON in fast-sync-2026-10-26/.</p>
</main></body></html>"""


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--media", default=str(MEDIA))
    parser.add_argument("--out", default=str(MEDIA.parent / "fast-sync-2026-10-26.html"))
    args = parser.parse_args()
    page = build(pathlib.Path(args.media))
    pathlib.Path(args.out).write_text(page)
    print(args.out, len(page))


if __name__ == "__main__":
    main()
