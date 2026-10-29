#!/usr/bin/env python3
"""The Fast Folder Sync report (PEP 0008): one self-contained HTML page from the bench's own files.

    python3 bench/fast/build_report.py --tag 20261028 --notes bench/fast/report-notes-20261028.json \
        --hero-push results/raw/hero-push.mp4 --hero-poll results/raw/hero-poll.mp4 \
        --out /home/bam/folder-sync/reports/media/fast-folder-sync-bench-2026-10-28.html

Reads results/summary-<tag>.json (analyse.py), published.json, competitors/tools.lock.json, the hero videos (+ their
.gif and .json readouts) and a notes file with the verdict and decision surface written by a person or agent after
reading the numbers. Every table and chart is drawn from the summary; nothing is typed in by hand except the notes.
"""
import argparse
import base64
import html
import json
import math
import os
import shutil

MEDIA_DIR = None

HERE = os.path.dirname(os.path.abspath(__file__))
DIRS = ["m2m", "m2w", "w2m", "m2a", "offline"]
DTITLE = {"m2m": "Machine → machine", "m2w": "Machine → web", "w2m": "Web → machine", "m2a": "Machine → agent / CLI",
          "offline": "Offline catch-up"}
WORKLOADS = ["1k", "100k", "10m", "200m", "many100", "storm"]
WTITLE = {"1k": "1 KB JSON", "100k": "100 KB", "10m": "10 MB", "200m": "200 MB", "many100": "100 × 1 KB", "storm": "save storm (20 × 50 ms)"}
FS_ORDER = ["head", "push", "push-optimal", "poll"]
FS_NAME = {"head": "folder-sync head (v0 now: push + history)", "push": "folder-sync push (lane/fast-sync)",
           "push-optimal": "folder-sync tuned (push, debounce 50 ms, reconnect cap 1 s, safety poll 300 s)", "poll": "folder-sync poll (v0 before push)"}

e = html.escape


def ms(v):
    if v is None:
        return "–"
    if v >= 10000:
        return f"{v / 1000:.1f} s"
    if v >= 1000:
        return f"{v / 1000:.2f} s"
    return f"{v:.0f} ms"


def short(series):
    s = series.replace("folder-sync ", "fs ")
    return s.replace("fs push-optimal", "fs tuned")


def is_fs(series):
    return series.startswith("folder-sync")


# ------------------------------------------------------------------------------------------------ charts

def scatter(points, xkey, xlabel, xfmt, xticks, xmap, title, frontier):
    """A latency-vs-x scatter (log y), folder-sync in the accent colour, the frontier as a step line."""
    W, H, L, R, T, B = 520, 300, 58, 16, 30, 44
    ys = [p["y"] for p in points if p["y"]]
    if not ys:
        return ""
    ylo = 10 ** math.floor(math.log10(max(1, min(ys))))
    yhi = 10 ** math.ceil(math.log10(max(ys)))
    if yhi == ylo:
        yhi *= 10

    def Y(v):
        return T + (H - T - B) * (1 - (math.log10(v) - math.log10(ylo)) / (math.log10(yhi) - math.log10(ylo)))

    x0, x1 = xmap(xticks[0]), xmap(xticks[-1])

    def X(v):
        return L + (W - L - R) * (xmap(v) - x0) / (x1 - x0)

    out = [f'<svg viewBox="0 0 {W} {H}" class="chart" role="img" aria-label="{e(title)}">',
           f'<text x="{L}" y="18" class="ct">{e(title)}</text>']
    d = ylo
    while d <= yhi:
        y = Y(d)
        out.append(f'<line x1="{L}" x2="{W - R}" y1="{y:.1f}" y2="{y:.1f}" class="grid"/>'
                   f'<text x="{L - 6}" y="{y + 4:.1f}" class="tick" text-anchor="end">{e(ms(d))}</text>')
        d *= 10
    for t in xticks:
        x = X(t)
        out.append(f'<line x1="{x:.1f}" x2="{x:.1f}" y1="{T}" y2="{H - B}" class="grid"/>'
                   f'<text x="{x:.1f}" y="{H - B + 15}" class="tick" text-anchor="middle">{e(xfmt(t))}</text>')
    out.append(f'<text x="{(L + W - R) / 2}" y="{H - 8}" class="axis" text-anchor="middle">{e(xlabel)}</text>')
    out.append(f'<text x="14" y="{(T + H - B) / 2}" class="axis" text-anchor="middle" transform="rotate(-90 14 {(T + H - B) / 2})">p50 latency (log)</text>')
    fr = sorted((p for p in points if p["series"] in frontier and p[xkey] is not None), key=lambda p: p[xkey])
    if len(fr) > 1:
        path = []
        for i, p in enumerate(fr):
            x, y = X(max(p[xkey], xticks[0])), Y(p["y"])
            if i == 0:
                path.append(f"M{x:.1f},{y:.1f}")
            else:
                path.append(f"H{x:.1f}V{y:.1f}")
        out.append(f'<path d="{" ".join(path)}" class="front"/>')
    placed = []
    for p in sorted(points, key=lambda p: (is_fs(p["series"]), p["y"])):
        if p[xkey] is None:
            continue
        x, y = X(max(p[xkey], xticks[0])), Y(p["y"])
        cls = "pfs" if is_fs(p["series"]) else "pco"
        if not p["correct"]:
            cls += " bad"
        out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{5 if is_fs(p["series"]) else 4}" class="{cls}"><title>{e(p["series"])}: {e(ms(p["y"]))} p50, {e(ms(p.get("p95")))} p95</title></circle>')
        ly = y + 4
        while any(abs(ly - q[1]) < 11 and abs(x - q[0]) < 90 for q in placed):
            ly += 11
        placed.append((x, ly))
        anchor = "end" if x > W - 140 else "start"
        dx = -8 if anchor == "end" else 8
        out.append(f'<text x="{x + dx:.1f}" y="{ly:.1f}" class="pl {"lfs" if is_fs(p["series"]) else ""}" text-anchor="{anchor}">{e(short(p["series"]))}</text>')
    out.append("</svg>")
    return "".join(out)


def usd_map(v):
    return math.log10(1 + v)


def cpu_map(v):
    return math.log10(max(v, 0.0005))


# ------------------------------------------------------------------------------------------------ tables

def cell_index(cells):
    idx = {}
    for c in cells:
        idx[(c["series"], c["direction"], c["workload"], c["fault"])] = c
    return idx


def fmt_cell(c):
    if c is None:
        return '<td class="na">not run</td>'
    if c["status"] == "n/a":
        return f'<td class="na" title="{e(c.get("note") or "")}">n/a</td>'
    if c["n"] == 0:
        why = "; ".join(c.get("error_notes") or []) or f'{c["timeouts"]} timeouts'
        return f'<td class="fail" title="{e(why)}">failed</td>'
    flags = []
    if c["timeouts"]:
        flags.append(f'{c["timeouts"]} timeout')
    if c["errors"]:
        flags.append(f'{c["errors"]} error')
    if c["conflicts"]:
        flags.append(f'{c["conflicts"]} conflict')
    if c["lost"]:
        flags.append(f'{c["lost"]} lost')
    if c["sha256_fail"]:
        flags.append(f'{c["sha256_fail"]} bad hash')
    flag = f'<span class="flag">{e(", ".join(flags))}</span>' if flags else ""
    first = f'<span class="sub">first {ms(c["first_p50"])}</span>' if c.get("first_p50") is not None and c["workload"] == "many100" else ""
    return (f'<td class="{"warn" if flags else ""}"><b>{ms(c["p50"])}</b><span class="sub">p95 {ms(c["p95"])} · n {c["n"]}</span>'
            f'{first}{flag}</td>')


def direction_table(summary, d, series):
    idx = cell_index(summary["cells"])
    if d == "offline":
        cols = [("1k", "drop"), ("1k", "sleep")]
        heads = ["network drop (20 s)", "sleep / wake (20 s)"]
    else:
        cols = [(w, None) for w in WORKLOADS if not (d == "m2a" and w == "200m")]
        heads = [WTITLE[w] for w, _ in cols]
    rows = []
    for s in series:
        if all(idx.get((s, d, w, f)) is None for w, f in cols) and idx.get((s, d, None, None)) is None:
            continue
        na = idx.get((s, d, None, None))
        if na is not None and na["status"] == "n/a":
            tds = f'<td class="na" colspan="{len(cols)}">n/a: {e(na.get("note") or "")}</td>'
        else:
            tds = "".join(fmt_cell(idx.get((s, d, w, f))) for w, f in cols)
        rows.append(f'<tr class="{"fsrow" if is_fs(s) else ""}"><th>{e(short(s))}</th>{tds}</tr>')
    return (f'<div class="tw"><table class="grid-t"><thead><tr><th></th>{"".join(f"<th>{e(h)}</th>" for h in heads)}</tr></thead>'
            f'<tbody>{"".join(rows)}</tbody></table></div>')


def embed(path, mime):
    with open(path, "rb") as f:
        return f"data:{mime};base64,{base64.b64encode(f.read()).decode()}"


def hero_block(mp4, label):
    if not mp4 or not os.path.exists(mp4):
        return ""
    gif = mp4[:-4] + ".gif"
    js = mp4[:-4] + ".json"
    readouts = ""
    if os.path.exists(js):
        data = json.load(open(js))
        items = data.get("readouts") or data.get("steps") or []
        lis = []
        for r in items:
            name = f'{r.get("direction", "")} {r.get("label") or r.get("id") or ""}'.strip()
            val = r.get("ms")
            extra = " (after the clip ends)" if r.get("in_video") is False else ""
            lis.append(f"<li>{e(str(name))}: <b>{ms(val)}</b>{e(extra)}</li>")
        readouts = f'<ul class="readouts">{"".join(lis)}</ul>' if lis else ""
    fallback = ""
    if os.path.exists(gif) and MEDIA_DIR:
        # WHY a sibling file, not a data URI: two GIFs inline would push the page past the desktop preview's ~1.9 MB
        os.makedirs(MEDIA_DIR, exist_ok=True)
        name = os.path.basename(gif)
        shutil.copyfile(gif, os.path.join(MEDIA_DIR, name))
        fallback = f'<img src="{e(os.path.basename(MEDIA_DIR))}/{e(name)}" alt="{e(label)}" class="gif">'

    return (f'<figure class="hero"><video autoplay muted loop playsinline controls src="{embed(mp4, "video/mp4")}">{fallback}</video>'
            f'<figcaption>{e(label)}{readouts}</figcaption></figure>')


# ------------------------------------------------------------------------------------------------ page

CSS = """
:root{--bg:#fbfbfa;--fg:#1d1d1b;--mut:#6b6b66;--line:#e4e3df;--card:#fff;--acc:#0b7a52;--acc2:#e8f4ee;--co:#5b6b8c;--bad:#b42318;--warn:#fff4e5;--na:#f3f3f1}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#151514;--fg:#ecebe7;--mut:#a3a29c;--line:#2e2e2b;--card:#1d1d1b;--acc:#4cc38a;--acc2:#16301f;--co:#93a4c8;--bad:#f97066;--warn:#3a2a10;--na:#232321}}
:root[data-theme="dark"]{--bg:#151514;--fg:#ecebe7;--mut:#a3a29c;--line:#2e2e2b;--card:#1d1d1b;--acc:#4cc38a;--acc2:#16301f;--co:#93a4c8;--bad:#f97066;--warn:#3a2a10;--na:#232321}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 Inter,system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1180px;margin:0 auto;padding:28px 16px 80px}h1{font-size:28px;margin:0 0 6px}h2{font-size:20px;margin:40px 0 10px;border-top:1px solid var(--line);padding-top:22px}
h3{font-size:16px;margin:22px 0 8px}.mut{color:var(--mut)}.verdict{font-size:19px;font-weight:600;margin:14px 0}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin:14px 0}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.card .k{font-size:12px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}.card .v{font-size:22px;font-weight:650}.card .s{font-size:13px;color:var(--mut)}
.tw{overflow-x:auto;margin:8px 0}table{border-collapse:collapse;font-size:13.5px;min-width:100%}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
thead th{font-size:12px;color:var(--mut);font-weight:600}td b{font-variant-numeric:tabular-nums}.sub{display:block;font-size:11.5px;color:var(--mut)}
.flag{display:block;font-size:11.5px;color:var(--bad);font-weight:600}td.warn{background:var(--warn)}td.na{background:var(--na);color:var(--mut);font-size:12.5px}td.fail{color:var(--bad);font-weight:600}
tr.fsrow th{color:var(--acc)}.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px}.chart{width:100%;height:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
.chart .ct{font-size:13px;font-weight:650;fill:var(--fg)}.chart .tick{font-size:10px;fill:var(--mut)}.chart .axis{font-size:11px;fill:var(--mut)}.chart .grid{stroke:var(--line)}
.chart .pfs{fill:var(--acc)}.chart .pco{fill:var(--co)}.chart .bad{fill:none;stroke:var(--bad);stroke-width:2}.chart .pl{font-size:10.5px;fill:var(--mut)}.chart .lfs{fill:var(--acc);font-weight:650}
.chart .front{fill:none;stroke:var(--acc);stroke-width:1.5;stroke-dasharray:4 3;opacity:.7}
.hero{margin:16px 0;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px}.hero video,.hero img{width:100%;border-radius:8px;display:block}
.hero figcaption{font-size:13px;color:var(--mut);margin-top:8px}.readouts{columns:2;margin:6px 0 0;padding-left:18px}.heros{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:12px}
code,pre{font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;overflow-x:auto;white-space:pre-wrap}
.pill{display:inline-block;font-size:11.5px;padding:1px 7px;border-radius:99px;background:var(--acc2);color:var(--acc);font-weight:600}.pill.sim{background:var(--na);color:var(--mut)}
ul.tight li{margin:3px 0}details{margin:8px 0}summary{cursor:pointer;font-weight:600}
@media (max-width:560px){.heros{grid-template-columns:1fr}.readouts{columns:1}h1{font-size:23px}}
"""


def build(a):
    global MEDIA_DIR
    MEDIA_DIR = os.path.splitext(a.out)[0]
    summary = json.load(open(os.path.join(HERE, "results", f"summary-{a.tag}.json")))
    notes = json.load(open(a.notes)) if a.notes else {}
    published = json.load(open(os.path.join(HERE, "published.json")))
    tools = json.load(open(os.path.join(HERE, "competitors", "tools.lock.json")))
    cells = summary["cells"]
    head_series = [s for s in summary["folder_sync_variants"]]
    fs_main = [f"folder-sync {v}" for v in FS_ORDER if f"folder-sync {v}" in head_series]
    others = sorted({c["series"] for c in cells if not is_fs(c["series"])})
    series = fs_main + others

    parts = [f"<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
             f"<title>Fast Folder Sync</title><style>{CSS}</style></head><body><main>"]
    parts.append(f'<h1>Fast Folder Sync: measured, not tabled</h1><p class="mut">PEP 0008 · branch <code>lane/sync-bench</code> @ <code>{e(summary["bench_code"])}</code> · '
                 f'run {e(a.tag)} · generated {e(summary["generated"])} · every number below was measured on this machine '
                 f'<span class="pill">real · local loopback</span> unless it says <span class="pill sim">modelled</span> or <span class="pill sim">published, not run</span></p>')
    parts.append(f'<p class="verdict">{e(notes.get("verdict", ""))}</p>')
    if notes.get("verdict_points"):
        parts.append('<ul class="tight">' + "".join(f"<li>{p}</li>" for p in notes["verdict_points"]) + "</ul>")

    # headline cards
    cards = []
    hl = summary["headline"]
    best = summary["best_competitor"]
    main_v = notes.get("headline_variant", "head")
    for d in DIRS:
        h = (hl.get(main_v) or {}).get(d) or {}
        b = best.get(d)
        ratio = h.get("ratio")
        vs = f'vs {short(b["series"])} {ms(b["p50"])}' if b else "no off-the-shelf tool has this path"
        r = f" · ×{ratio}" if ratio is not None else ""
        cards.append(f'<div class="card"><div class="k">{e(DTITLE[d])}</div><div class="v">{ms(h.get("p50"))}</div>'
                     f'<div class="s">p95 {ms(h.get("p95"))}{e(r)}<br>{e(vs)}</div></div>')
    parts.append(f'<div class="cards">{"".join(cards)}</div><p class="mut" style="font-size:13px">Cards: {e(FS_NAME.get(main_v, main_v))}, 1 KB file (offline: network drop), p50. ×ratio = folder-sync ÷ the best networked off-the-shelf tool (below 1 = faster).</p>')

    # hero
    heros = []
    if a.hero_push:
        heros.append(hero_block(a.hero_push, "folder-sync push: two machines on this computer, every save and the web write measured live (sha256 on arrival)"))
    if a.hero_poll:
        heros.append(hero_block(a.hero_poll, "The same scene on folder-sync poll (v0 before push, 10 s rounds): the wait is the timer"))
    if heros:
        parts.append(f'<h2>Two machines, side by side</h2><div class="heros">{"".join(heros)}</div>')

    # frontier
    parts.append('<h2>The frontier: latency against cost and idle CPU</h2>'
                 '<p>One chart per direction. Each dot is a tool (and setting) on the 1 KB workload; green is folder-sync, blue the off-the-shelf tools, a red ring a tool that lost, conflicted or timed out in that cell. The dashed line joins the configurations nothing else beats on both axes. Cost is <span class="pill sim">modelled</span> from measured request rates (section “Cost and idle”); peer-to-peer tools sit at $0 because they have no cloud copy at all.</p>')
    charts = []
    for d in DIRS:
        p = summary["pareto"][d]
        if not p["points"]:
            continue
        charts.append(scatter(p["points"], "x", "$ / month at Zach's scale (log 1+x)", lambda v: f"${v:g}", [0, 1, 5, 20, 100, 500], usd_map, f"{DTITLE[d]}: latency vs cost", p["frontier_cost"]))
        charts.append(scatter([{**q, "cpu": q.get("cpu")} for q in p["points"]], "cpu", "idle CPU per machine, % of a core (log)", lambda v: f"{v:g}%", [0.001, 0.01, 0.1, 1, 5], cpu_map, f"{DTITLE[d]}: latency vs idle CPU", p["frontier_cpu"]))
    parts.append(f'<div class="charts">{"".join(charts)}</div>')

    # rank
    rk = []
    for d in DIRS:
        lst = summary["ranks"][d]
        pos = [i + 1 for i, r in enumerate(lst) if r["series"] == f"folder-sync {main_v}"]
        rk.append(f'<tr><th>{e(DTITLE[d])}</th><td>{pos[0] if pos else "–"} of {len(lst)}</td><td>' + ", ".join(f'{e(short(r["series"]))} {ms(r["p50"])}' for r in lst[:8]) + "</td></tr>")
    parts.append(f'<h3>Where folder-sync sits ({e(FS_NAME.get(main_v, main_v))}, 1 KB p50, correct cells only)</h3><div class="tw"><table><thead><tr><th>Direction</th><th>Rank</th><th>Order (fastest first)</th></tr></thead><tbody>{"".join(rk)}</tbody></table></div>')

    # per direction tables
    parts.append('<h2>Every measured cell, per direction</h2><p class="mut">p50 (bold), p95, n trials. Amber cells had a timeout, error, conflict copy, lost write or hash mismatch. n/a = the tool has no such path.</p>')
    for d in DIRS:
        parts.append(f"<h3>{e(DTITLE[d])}</h3>" + direction_table(summary, d, series))

    # idle + cost
    rows = []
    for s in series:
        i = summary["idle"].get(s)
        c = summary["cost"].get(s)
        if not i and not c:
            continue
        req = (i or {}).get("requests_per_min_per_host") or {}
        rows.append(f'<tr class="{"fsrow" if is_fs(s) else ""}"><th>{e(short(s))}</th><td>{(i or {}).get("cpu_pct_per_host", "–")}</td><td>{(i or {}).get("wakeups_per_min_per_host", "–")}</td>'
                    f'<td>{(i or {}).get("net_bytes_per_min_per_host", "–")}</td><td>{req.get("class_a", "–")} / {req.get("class_b", "–")} / {req.get("worker", "–")}</td>'
                    f'<td>{(i or {}).get("window_s", "–")} s</td><td><b>{"$%.2f" % c["usd"] if c else "–"}</b><span class="sub">{e((c or {}).get("basis", ""))}</span></td></tr>')
    m = summary["cost_model"]
    parts.append('<h2>Cost and idle</h2>'
                 f'<p>Idle: each machine’s whole process tree from its cgroup over the window. Wakeups are context switches of the live processes, a battery <i>proxy</i>. Cost <span class="pill sim">modelled</span>: {m["people"]} people × {m["devices_per_person"]} devices + {m["pages"]} pages, {m["changes_per_day"]:,} changes/day; R2 class A ${m["r2_class_a_per_m"]}/M after {m["r2_class_a_free_m"]:g}M free, class B ${m["r2_class_b_per_m"]}/M after {m["r2_class_b_free_m"]:g}M, Workers ${m["workers_req_per_m"]}/M after {m["workers_req_free_m"]:g}M (+$5 plan), DO ${m["do_req_per_m"]}/M after {m["do_req_free_m"]:g}M (hub load: the fast-sync report’s pessimistic {m["do_req_month_push"]:,}/month, since the local hub logs nothing).</p>'
                 f'<div class="tw"><table><thead><tr><th></th><th>CPU % / machine</th><th>wakeups / min</th><th>net B / min</th><th>S3 A / B / Worker req per min</th><th>window</th><th>$ / month</th></tr></thead><tbody>{"".join(rows)}</tbody></table></div>')

    # sweep
    sw = summary["sweep"]
    if sw:
        keys = [("m2m_1k", "m2m 1 KB"), ("m2w_1k", "m2w 1 KB"), ("w2m_1k", "w2m 1 KB"), ("m2m_storm", "m2m storm"), ("m2m_many100", "m2m 100 files"), ("offline_1k_drop", "offline drop")]
        trs = []
        for r in sw:
            cfg = {k: v for k, v in (r.get("config") or {}).items() if k not in ("code", "patched")}
            trs.append(f'<tr class="{"fsrow" if r["series"] in notes.get("best_series", []) else ""}"><th>{e(short(r["series"]))}<span class="sub">{e(", ".join(f"{k}={v}" for k, v in cfg.items()))}</span></th>'
                       + "".join(f"<td>{ms(r.get(k))}</td>" for k, _ in keys)
                       + f'<td>{r.get("idle_cpu_pct", "–")}</td><td>{"$%.2f" % r["usd_month"] if r.get("usd_month") is not None else "–"}</td><td>{"yes" if r["correct"] else "<b class=flag>no</b>"}</td></tr>')
        parts.append('<h2>Optimising folder-sync: the tunables sweep</h2><p>One knob at a time around push’s defaults (debounce 100 ms, reconnect cap 30 s, safety poll 60 s), then the best combination, measured end to end. Poll’s interval for comparison. p50 shown.</p>'
                     f'<div class="tw"><table><thead><tr><th>Config</th>{"".join(f"<th>{e(t)}</th>" for _, t in keys)}<th>idle CPU %</th><th>$ / mo</th><th>correct</th></tr></thead><tbody>{"".join(trs)}</tbody></table></div>')
    if notes.get("optimized"):
        parts.append("<h3>The optimised configuration</h3>" + notes["optimized"])

    # not run
    nr = []
    for t in published["not_run"]:
        raw = t.get("latency")
        if isinstance(raw, str):
            lat = e(raw)
        else:
            lat = "; ".join(f'<b>{e(x["value"])}</b>: {e(x["what"])} (<a href="{e(x["source"])}">{e(x.get("kind", "source"))}</a>)' for x in raw or []) or "not published"
        nr.append(f'<tr><th>{e(t["tool"])}</th><td>{e(t["status"])}</td><td>{lat}</td></tr>')
    parts.append(f'<h2>Not run (published numbers only)</h2><p class="mut">These need a paid or online account, so the bench never ran them; the numbers are the sources’ own, accessed {e(published["accessed"])}, and are not comparable one-to-one with the measured rows.</p>'
                 f'<div class="tw"><table><tbody>{"".join(nr)}</tbody></table></div>')
    tl = "".join(f'<tr><th>{e(t["name"])}</th><td>{e(t["version"])}</td><td><code>{e(t["sha256"][:16])}…</code></td><td>{e(t.get("verification", ""))}</td></tr>' for t in tools["tools"])
    parts.append(f'<h3>What ran, and how it was verified</h3><div class="tw"><table><thead><tr><th>Tool</th><th>Version</th><th>sha256</th><th>Verification</th></tr></thead><tbody>{tl}</tbody></table></div>')

    if notes.get("method_limits"):
        parts.append("<h2>Method and its limits</h2><ul class=tight>" + "".join(f"<li>{x}</li>" for x in notes["method_limits"]) + "</ul>")
    for key, title in [("done", "Done and proved"), ("left", "Left"), ("needs_zach", "Needs you"), ("not_done", "Deliberately not done")]:
        if notes.get(key):
            parts.append(f"<h2>{e(title)}</h2><ul class=tight>" + "".join(f"<li>{x}</li>" for x in notes[key]) + "</ul>")
    parts.append('<h2>Re-run it</h2><pre>systemd-run --user --scope -p MemoryMax=16G -- bash /home/bam/folder-sync/.claude/worktrees/bench/bench/fast/run_all.sh</pre>'
                 '<p class="mut">One run at a time: folder-sync poll / push / head, the five off-the-shelf tools, the tunables sweep, then <code>analyse.py</code> (summary + the Vibe Tracks producer <code>~/vt/zach/producers/folder-sync-bench</code>). About 5–6 hours on this machine; <code>run_all.sh TAG base</code> runs one phase. Contract: <code>bench/fast/CONTRACT.md</code>; problem: <code>docs/peps/0008-fast-folder-sync-bench.md</code>.</p>')
    parts.append("</main></body></html>")
    with open(a.out, "w") as f:
        f.write("".join(parts))
    print(a.out, os.path.getsize(a.out))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", required=True)
    ap.add_argument("--notes")
    ap.add_argument("--hero-push")
    ap.add_argument("--hero-poll")
    ap.add_argument("--out", required=True)
    build(ap.parse_args())
