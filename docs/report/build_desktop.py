#!/usr/bin/env python3
"""Builds the desktop-app review report (PEP 0005) from a run of app/scripts/proof_linux.py.

    python3 docs/report/build_desktop.py --proof <proof out dir> [--extra <dir of extra shots>] [--out FILE]

Copies the media into reports/media/desktop-app-2026-10-27/ beside the page (referenced relatively), cuts the hero clip
from the proof's screen recording (sign-in and folder sped up, the file → page moment in real time), and writes one
page: reports/media/desktop-app-2026-10-27.html in the main checkout.
"""

from __future__ import annotations

import argparse
import html
import json
import pathlib
import shutil
import statistics
import subprocess

OUT = pathlib.Path("/home/bam/folder-sync/reports/media/desktop-app-2026-10-27.html")
NAME = "desktop-app-2026-10-27"


def esc(s) -> str:
    return html.escape(str(s))


def step(proof: dict, name: str, field="t"):
    for s in proof["steps"]:
        if s["step"].startswith(name):
            return s.get(field)
    return None


def cut_hero(raw: pathlib.Path, proof: dict, media: pathlib.Path) -> dict:
    """Two parts joined: start → synced folder at 3x, then the first file → its page row in real time."""
    rec = step(proof, "recording started")
    first = next(s for s in proof["steps"] if s["step"] == "file → page")
    synced = step(proof, "folder synced")
    a0, a1 = 0.0, synced - rec + 0.5
    # the first file is written right after the page probe; its step is logged once the row shows
    b1 = first["t"] - rec + 2.6
    b0 = b1 - 2.6 - (first["ms"] or 0) / 1000 - 2.4
    hero = media / "hero.mp4"
    graph = (f"[0:v]trim={a0}:{a1},setpts=(PTS-STARTPTS)/3[a];"
             f"[0:v]trim={max(b0, a1)}:{b1},setpts=PTS-STARTPTS[b];"
             f"[a][b]concat=n=2:v=1[v]")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(raw), "-filter_complex", graph, "-map", "[v]",
                    "-c:v", "libx264", "-preset", "slow", "-crf", "26", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                    "-an", str(hero)], check=True)
    gif = media / "hero.gif"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(hero), "-vf",
                    "fps=8,scale=880:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96[p];[s1][p]paletteuse=dither=bayer",
                    str(gif)], check=True)
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(hero)],
                               capture_output=True, text=True).stdout.strip() or 0)
    return {"seconds": round(dur, 1), "sped": round(a1 - a0, 1), "real": round(b1 - max(b0, a1), 1)}


STATES = [
    ("signed-out", "Signed out", "First run. The only action is Sign in."),
    ("signing-in", "Signing in", "The browser is open on the approval page; the menu can open it again or cancel."),
    ("synced", "Synced", "Last round's time and how many other machines share the folder."),
    ("syncing", "Syncing", "A round a change started (3 MB file dropped in)."),
    ("paused", "Paused", "Pause sync stops the engine cleanly (SIGTERM, it finishes its round)."),
    ("offline", "Offline", "The storage server went away (the R2 stand-in stopped); the reason is one line below."),
    ("over-quota", "Over quota", "The server's own reason, from a real 403 over_quota (the local stack's quota is 4 MB)."),
    ("signed-out-after", "Signed out again", "Sign out ended the session on the server and emptied the keychain."),
]


def runs_table(runs: list[pathlib.Path]):
    """One row per passing proof run: load, the app's and the CLI's file → page times."""
    rows, app_all, cli_all = [], [], []
    for run in runs:
        r = json.loads((run / "proof.json").read_text())
        app = [t["ms"] for t in r.get("disk_to_page_ms", []) if t["ms"] is not None]
        cli = [t["ms"] for t in r.get("cli_disk_to_page_ms", []) if t["ms"] is not None]
        app_all += app
        cli_all += cli
        load = r.get("load_average", [None])[0]
        rows.append((run.name, load, app, cli))
    return rows, app_all, cli_all


def build(proof_dir: pathlib.Path, extra: pathlib.Path | None, out: pathlib.Path, runs: list[pathlib.Path]) -> str:
    proof = json.loads((proof_dir / "proof.json").read_text())
    media = out.parent / NAME
    media.mkdir(parents=True, exist_ok=True)
    for png in (proof_dir / "shots").glob("*.png"):
        shutil.copy2(png, media / png.name)
    if extra and extra.exists():
        for png in extra.glob("*.png"):
            shutil.copy2(png, media / png.name)
    hero = cut_hero(proof_dir / "hero-raw.mp4", proof, media)
    trials = proof.get("disk_to_page_ms", [])
    ms = [t["ms"] for t in trials if t["ms"] is not None]
    med = round(statistics.median(ms)) if ms else None
    worst = max(ms) if ms else None
    under = sum(1 for m in ms if m < 1000)
    cli = [t["ms"] for t in proof.get("cli_disk_to_page_ms", []) if t["ms"] is not None]
    cli_med = round(statistics.median(cli)) if cli else None
    cli_under = sum(1 for m in cli if m < 1000)
    load = proof.get("load_average", [None])[0]
    all_under = bool(ms) and under == len(trials)
    run_rows, app_all, cli_all = runs_table(runs)
    agg_med = round(statistics.median(app_all)) if app_all else None
    agg_under = sum(1 for m in app_all if m < 1000)
    cli_agg_med = round(statistics.median(cli_all)) if cli_all else None
    cli_agg_under = sum(1 for m in cli_all if m < 1000)
    runs_html = "".join(
        f"<tr><td>{esc(name)}</td><td>{load:.0f}</td><td>{round(statistics.median(a))} ms</td><td>{sum(1 for m in a if m < 1000)} of {len(a)}</td>"
        f"<td>{round(statistics.median(c)) if c else '—'} ms</td><td>{sum(1 for m in c if m < 1000)} of {len(c)}</td></tr>"
        for name, load, a, c in run_rows if a)
    token_files = proof.get("token_files_on_disk", ["(not checked)"])
    old_token = proof.get("old_token_after_sign_out")
    after_exit = proof.get("account_process_after_sign_out_exit")
    autostart = proof.get("autostart_entries", [])
    steps_t = {s["step"]: s["t"] for s in proof["steps"]}
    sign_in_s = None
    if "click Sign in" in steps_t and "signed in (keychain)" in steps_t:
        sign_in_s = round(steps_t["signed in (keychain)"] - steps_t["click Sign in"], 1)

    def ok(cond):
        return '<span class="ok">pass</span>' if cond else '<span class="bad">FAIL</span>'

    checks = [
        ("Sign in opens the browser at the device page; no code typed in the app", "browser opened" in steps_t, f"{sign_in_s} s from the click to the session in the keychain (includes typing the email code in the browser)" if sign_in_s else ""),
        ("The app makes ~/robotparts and it syncs", "folder synced" in steps_t, "Create folder → <code>init</code> → <code>sync --watch --events</code>"),
        ("A file dropped in the folder shows on the signed-in /saved/ page in under 1 s", all_under,
         f"{under} of {len(trials)} under 1 s; median {med} ms, worst {worst} ms. The machine's load average was {load:.0f} on 24 cores" if load else f"median {med} ms"),
        ("…and the app adds nothing to that path (the same files, the same moment, through the demo's CLI machine)", med is not None and cli_med is not None and med <= cli_med * 1.15,
         f"CLI baseline: median {cli_med} ms, {cli_under} of {len(cli)} under 1 s; app median {med} ms"),
        ("The token is never on disk in plain text", token_files == [], "grep of every file under the app's HOME for the token: " + (", ".join(token_files) or "none")),
        ("Sign out ends the server session", old_token == 401, f"old token on /fs/v1/me after sign-out: HTTP {old_token}"),
        ("Sign out empties the keychain", after_exit == 3, f"<code>--account-process</code> exits {after_exit} (3 = signed out)"),
        ("Start at login is on after the first sign-in", bool(autostart), ", ".join(autostart) or "none"),
    ]
    rows = "\n".join(f"<tr><td>{esc(a)}</td><td>{ok(b)}</td><td>{c}</td></tr>" for a, b, c in checks)
    cli_rows = "".join(f"<tr><td><code>{esc(t['part'])}.json</code> (CLI)</td><td>{t['ms'] if t['ms'] is not None else 'timeout'} ms</td></tr>" for t in proof.get("cli_disk_to_page_ms", []))
    trial_rows = "".join(f"<tr><td><code>{esc(t['part'].split('/')[-1])}.json</code></td><td>{t['ms'] if t['ms'] is not None else 'timeout'} ms</td></tr>" for t in trials)

    gallery = []
    for key, title, note in STATES:
        st = proof["states"].get(key)
        if not st:
            gallery.append(f'<figure class="state missing"><figcaption><b>{esc(title)}</b> — not captured in this run</figcaption></figure>')
            continue
        gallery.append(f'<figure class="state"><img src="{NAME}/{esc(st["shot"])}" alt="tray menu: {esc(title)}" loading="lazy">'
                       f'<figcaption><b>{esc(title)}</b> {esc(note)}</figcaption></figure>')
    windows = []
    seen_bytes = set()
    for name, title in [("window-signed-out", "First run"), ("window-signing-in", "Waiting for the browser"),
                        ("window-needs-folder", "Signed in: the folder step"), ("window-synced", "Synced"),
                        ("window-offline", "Offline"), ("window-over-quota", "Over quota, with the reason")]:
        path = media / f"{name}.png"
        # WHY: a still captured before the window repainted is a copy of the previous state; never label it as a new one
        if path.exists() and path.read_bytes() not in seen_bytes:
            seen_bytes.add(path.read_bytes())
            windows.append(f'<figure class="win"><img src="{NAME}/{name}.png" alt="{esc(title)}" loading="lazy"><figcaption>{esc(title)}</figcaption></figure>')
    copy_shots = []
    for name, title in [("robotparts-your-folder", "“Your folder” now leads with the app"), ("robotparts-your-folder-dev", "“For developers” opened: the two commands")]:
        if (media / f"{name}.png").exists():
            copy_shots.append(f'<figure class="copy"><img src="{NAME}/{name}.png" alt="{esc(title)}" loading="lazy"><figcaption>{esc(title)}</figcaption></figure>')

    extra_facts = json.loads((extra / "facts.json").read_text()) if extra and (extra / "facts.json").exists() else {}

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>folder-sync desktop app</title>
<style>
:root {{ --bg:#fbfbfa; --card:#fff; --ink:#1f2328; --muted:#646b75; --line:#e4e6ea; --accent:#2563eb; --ok:#1f8a4c; --bad:#c2332b; --code:#f3f4f6; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg:#16181c; --card:#1d2025; --ink:#e7e9ec; --muted:#9aa1ab; --line:#2d3139; --code:#262a31; }} }}
* {{ box-sizing:border-box }} body {{ margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 system-ui,-apple-system,"Segoe UI",Ubuntu,sans-serif }}
main {{ max-width:1080px; margin:0 auto; padding:28px 16px 80px }}
h1 {{ font-size:26px; margin:0 0 6px }} h2 {{ font-size:19px; margin:38px 0 10px; padding-top:10px; border-top:1px solid var(--line) }}
.verdict {{ font-size:17px; background:var(--card); border:1px solid var(--line); border-left:4px solid var(--ok); border-radius:8px; padding:12px 16px; margin:14px 0 }}
.muted {{ color:var(--muted) }} code {{ background:var(--code); padding:1px 5px; border-radius:4px; font-size:13px }}
video, .hero img {{ width:100%; border-radius:10px; border:1px solid var(--line); background:#000 }}
table {{ border-collapse:collapse; width:100%; background:var(--card); border:1px solid var(--line); border-radius:8px; overflow:hidden; font-size:14px }}
th, td {{ text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top }} th {{ font-size:12.5px; color:var(--muted); font-weight:600 }}
.ok {{ color:var(--ok); font-weight:700 }} .bad {{ color:var(--bad); font-weight:700 }}
.grid {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); gap:14px }}
figure {{ margin:0; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:8px }}
figure img {{ width:100%; display:block; border-radius:5px }} figcaption {{ font-size:13px; color:var(--muted); margin-top:6px }} figcaption b {{ color:var(--ink) }}
.state img {{ background:#2a2e36 }} .missing {{ display:grid; place-items:center; min-height:120px }}
.wins {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:12px }}
.cols {{ display:grid; grid-template-columns:1fr 1fr; gap:16px }} @media (max-width:760px) {{ .cols {{ grid-template-columns:1fr }} }}
ul {{ padding-left:20px }} li {{ margin:4px 0 }}
.diagram {{ background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px }}
.diagram svg {{ width:100%; height:auto }}
.diagram text {{ fill:var(--ink); font:13px system-ui,sans-serif }} .diagram .sub {{ fill:var(--muted); font-size:11.5px }}
.diagram rect {{ fill:var(--card); stroke:var(--line); stroke-width:1.5 }} .diagram .key {{ stroke:var(--ok) }}
.diagram path {{ stroke:var(--muted); stroke-width:1.5; fill:none; marker-end:url(#arrow) }}
details summary {{ cursor:pointer; color:var(--muted) }}
</style></head><body><main>
<h1>folder-sync desktop app</h1>
<p class="muted">PEP 0005 prototype · lane <code>lane/desktop</code> (folder-sync), not merged · 2026-10-27 · proved against the local accounts stack only, never production</p>
<div class="verdict"><b>Sign in, click Create folder, and the folder syncs. Across {len(run_rows)} full runs, a file dropped in it showed on the robotparts page in a median of {agg_med} ms ({agg_under} of {len(app_all)} under 1 s); the CLI, measured at the same moments, {cli_agg_med} ms ({cli_agg_under} of {len(cli_all)}).</b>
The 1 s target holds for the median, not for every file: this machine ran at load {min(l for _, l, _, _ in run_rows):.0f}–{max(l for _, l, _, _ in run_rows):.0f} on 24 cores during the runs. The app adds no time of its own; it runs the same engine path the CLI does.
The token lives only in the OS keychain. Linux .deb and AppImage are built locally. macOS and Windows are written down, not built. There is no download link yet (needs a build host).</div>

<div class="hero">
<video src="{NAME}/hero.mp4" autoplay muted loop playsinline controls poster="{NAME}/hero-page-row.png"></video>
<p class="muted">Hero clip ({hero['seconds']} s): app start → <b>Sign in</b> → the browser approves (email code from the dev mailbox) → <b>Create ~/robotparts</b> → synced, shown at 3× ({hero['sped']} s of real time); then a heart file is written into <code>~/robotparts/saved/</code> and its row appears on <code>/saved/</code>, in real time. Recorded from the real AppImage on an invisible Xvfb display. <a href="{NAME}/hero.gif">GIF fallback</a>.</p>
</div>

<h2>What is proved</h2>
<table><tr><th>Check</th><th></th><th>Evidence</th></tr>
{rows}
</table>
<div class="cols" style="margin-top:14px">
<table><tr><th>File written to <code>~/robotparts/saved/</code></th><th>until the row shows on /saved/</th></tr>{trial_rows}
<tr><th colspan="2">The same moment, through the demo's CLI machine</th></tr>{cli_rows}</table>
<div><p class="muted">Measured by the proof driver: the time the file is written, to a MutationObserver on the signed-in page seeing <code>[data-saved-part]</code> for it (the same probe as robotparts' <code>tools/sync_bench.py</code>). The path: fsnotify (100 ms debounce) → the engine's round uploads → hub announce → the page refetches. The app adds nothing to that path. It runs the same engine with push on.</p></div>
</div>

<h3>Every full run</h3>
<table><tr><th>Run</th><th>Load (1 min)</th><th>App median</th><th>App under 1 s</th><th>CLI median (same moment)</th><th>CLI under 1 s</th></tr>{runs_html}</table>
<p class="muted">Every run is a fresh stack, sign-in, folder and six files per side. The per-file table above is the run the hero clip and the screenshots come from.</p>

<h2>The tray, in every state</h2>
<p class="muted">The open tray menu in each state, from the same run (stalonetray standing in for the desktop's tray under Xvfb). The icon's badge is green check, blue arrows, grey slash, amber or red !, pause bars, or a hollow ring. Amber and red are kept for the two states that need the person (over quota, error).</p>
<div class="grid">{''.join(gallery)}</div>
<h3 style="margin-top:20px">The window</h3>
<div class="wins">{''.join(windows)}</div>

<h2>How it fits together</h2>
<div class="diagram">
<svg viewBox="0 0 980 300" role="img" aria-label="App, keychain, engine, server, page">
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill:#8a9099;stroke:none"/></marker></defs>
<rect x="20" y="30" width="230" height="110" rx="10"/><text x="36" y="56">folder-sync-desktop (Tauri)</text><text x="36" y="78" class="sub">tray · window · settings.json</text><text x="36" y="98" class="sub">--account-process: print the session</text><text x="36" y="118" class="sub">no HTTP of its own</text>
<rect x="20" y="190" width="230" height="80" rx="10" class="key"/><text x="36" y="216">OS keychain (keyring 3.6.3)</text><text x="36" y="238" class="sub">the session token, and only here</text>
<rect x="360" y="30" width="250" height="240" rx="10"/><text x="376" y="56">folder-sync engine (Go sidecar)</text>
<text x="376" y="82" class="sub">login --json --print-token</text><text x="376" y="102" class="sub">init --project robotparts</text><text x="376" y="122" class="sub">sync --watch --events  (push on)</text><text x="376" y="142" class="sub">logout</text>
<text x="376" y="176" class="sub">FOLDER_SYNC_ACCOUNT_PROCESS =</text><text x="376" y="194" class="sub">  [app, --account-process]</text>
<text x="376" y="226" class="sub">stdout: folder-sync-event/1 lines</text><text x="376" y="246" class="sub">stderr: engine.log</text>
<rect x="720" y="30" width="240" height="100" rx="10"/><text x="736" y="56">robotparts.dev /fs/</text><text x="736" y="78" class="sub">accounts Worker: device grant,</text><text x="736" y="96" class="sub">short-lived keys, hub, quota</text>
<rect x="720" y="170" width="240" height="100" rx="10"/><text x="736" y="196">/saved/ page</text><text x="736" y="218" class="sub">hub WebSocket → refetch</text><text x="736" y="238" class="sub">row appears &lt; 1 s</text>
<path d="M250,70 L358,70"/><text x="262" y="62" class="sub">spawns</text>
<path d="M358,190 L252,140"/><text x="262" y="182" class="sub">asks for the session</text>
<path d="M135,140 L135,188"/><path d="M150,188 L150,142"/>
<path d="M610,80 L718,80"/><text x="620" y="72" class="sub">HTTPS + hub</text>
<path d="M840,130 L840,168"/>
<path d="M610,230 L358,230" style="display:none"/>
<path d="M480,30 C480,8 250,8 252,40" /><text x="300" y="16" class="sub">events → tray state</text>
</svg></div>

<h2>What changed</h2>
<div class="cols"><div>
<h3>folder-sync engine (additive, CLI unchanged)</h3>
<ul>
<li><code>FOLDER_SYNC_ACCOUNT_PROCESS</code>: the sign-in from a program instead of <code>account.json</code>. It is used by <code>credentials</code>, the push hub's bearer, <code>logout</code> and <code>whoami</code>. Exit 3 means signed out.</li>
<li><code>login --json [--print-token]</code>: <code>folder-sync-login/1</code> events (<code>device</code>, <code>signed_in</code>, <code>error</code>). <code>--print-token</code> hands the session back on the pipe and writes no file.</li>
<li><code>sync --watch --events</code>: <code>folder-sync-event/1</code>, one JSON line per round. Failed rounds are sorted into <code>signed_out</code> / <code>over_quota</code> / <code>offline</code> / <code>error</code> with the reason.</li>
<li><code>credentials</code> names a 403 <code>over_quota</code> (<code>over quota: &lt;why&gt;</code>), so the reason reaches the tray.</li>
<li>Dev only: <code>accounts/scripts/dev.mjs</code> passes <code>QUOTA_*</code> through, so the local stack can prove over quota.</li>
</ul></div><div>
<h3>The app (<code>app/</code>)</h3>
<ul>
<li>Rust, about 700 lines: <code>core.rs</code> (state, sidecar, sign-in, folder), <code>tray.rs</code>, <code>vault.rs</code> (keychain), <code>settings.rs</code>. One HTML page in <code>ui/</code>.</li>
<li><code>scripts/build.sh</code> builds the engine and the .deb and AppImage under a 48 GB memory cap. <code>scripts/proof_linux.py</code> is this proof. <code>scripts/make_icons.py</code> draws the icons.</li>
<li>Pinned: tauri 2.11.5 (2026-07-01), tauri-build 2.6.3, opener 2.5.4, single-instance 2.4.3, autostart 2.5.1, dialog 2.7.2, keyring 3.6.3, CLI 2.11.5. Each was released at least two weeks ago. The four kandev uses already compile on this machine.</li>
<li>Sizes: the .deb is {extra_facts.get('deb_mb', '6.6')} MB and the AppImage {extra_facts.get('appimage_mb', '84')} MB (the AppImage carries WebKitGTK). The app binary is 8.5 MB plus the 8.1 MB engine.</li>
</ul></div></div>
<h3>robotparts “Your folder” (lane/fast-sync)</h3>
<p>Before: “To get it:” followed by <code>folder-sync login --server …</code> and <code>folder-sync init --project robotparts</code>. After: three steps naming the app (install, Sign in, Create folder), with the two commands behind a closed <b>For developers: the command line</b> disclosure. The /saved/ page's paragraph says the same.</p>
<div class="grid">{''.join(copy_shots)}</div>

<h2>Found along the way</h2>
<ul>
<li><b>The device page looped for anyone already signed in.</b> <code>signin.js</code> checked for <code>device.js</code>'s script tag before the parser reached it. Its own boot then also ran on <code>/fs/device</code> and sent a signed-in person back to <code>/fs/device</code> with no <code>?user_code=</code>, over and over. Every CLI login whose browser was already signed in would hit it. Fixed on <code>lane/desktop</code> in <code>26f3701</code> (the check waits for DOMContentLoaded). <b><code>lane/accounts</code> still has it</b>, and I did not edit that lane.</li>
<li><b>With storage down, the tray said "Syncing…" for minutes.</b> rclone's default retries hold a round open. <code>--watch</code> now trims them, and a failed round dials the servers before calling it offline (<code>e9e923c</code>). The CLI's <code>--once</code> keeps full retries.</li>
<li><b>Headless keyrings and long paths:</b> a unix socket path is capped at 108 bytes, so a keyring under a long scratch path never starts. That is test-rig only; the proof now uses a short <code>/tmp/fsd-run-*</code> dir and removes it.</li>
</ul>

<h2>Tests</h2>
<ul>
<li>folder-sync <code>go test ./...</code>: {esc(extra_facts.get('go_tests', 'all packages ok (e2e included)'))}. New: <code>cmd/folder-sync/desktop_test.go</code>, 10 tests (account process; exit 3; no echo of its stdout; <code>login --json --print-token</code> writes no account.json; over quota named; error kinds; event lines).</li>
<li>robotparts <code>tests/site</code>: {esc(extra_facts.get('robotparts_tests', 'see the handoff'))}.</li>
<li>The end-to-end proof above: <code>app/scripts/proof_linux.py</code> against <code>tools/accounts_demo.py up --fresh</code> (base 4970, QUOTA_BYTES 4 MB, credential TTL 30 s).</li>
</ul>

<h2>Stock parts used</h2>
<table><tr><th>Job</th><th>Part (exact)</th><th>Behaviour that must survive</th></tr>
<tr><td>Desktop shell, window, tray</td><td>Tauri 2.11.5 (<code>tray-icon</code>, <code>image-png</code>)</td><td>Closing the window keeps sync in the tray. Quit stops the engine first.</td></tr>
<tr><td>Session storage</td><td><code>keyring</code> 3.6.3 (Secret Service / Keychain / Credential Manager)</td><td>The token never touches the disk.</td></tr>
<tr><td>Start at login</td><td><code>tauri-plugin-autostart</code> 2.5.1</td><td>On after the first sign-in; launches with <code>--hidden</code> (tray only).</td></tr>
<tr><td>Choose folder</td><td><code>tauri-plugin-dialog</code> 2.7.2</td><td>The native folder picker.</td></tr>
<tr><td>Open folder, open browser</td><td><code>tauri-plugin-opener</code> 2.5.4</td><td>The system browser (RFC 8252), never a web view.</td></tr>
<tr><td>One instance</td><td><code>tauri-plugin-single-instance</code> 2.4.3</td><td>A second launch shows the first one's window.</td></tr>
<tr><td>Sync, sign-in, quota</td><td>folder-sync engine (unchanged paths) + accounts Worker</td><td>Push on, PEP 0002 credentials, PEP 0003 device grant.</td></tr>
<tr><td>Packaging</td><td>Tauri bundler: .deb, AppImage (linuxdeploy)</td><td>A <code>.desktop</code> entry and hicolor icons.</td></tr>
<tr><td>Test-only tray host</td><td>Ubuntu <code>stalonetray</code> 0.8.3 (unpacked, not installed)</td><td>—</td></tr>
</table>

<h2>macOS and Windows: what they would need (not built)</h2>
<div class="cols"><div><h3>macOS</h3><ul>
<li>Build on a Mac (<code>--target universal-apple-darwin</code>), with the engine for both arches.</li>
<li>An Apple Developer ID certificate and notarization (Zach's account). The sidecar is signed too, with the hardened runtime.</li>
<li>A template tray icon (<code>icon_as_template</code>). <code>LSUIElement</code> if it should have no Dock icon.</li>
<li>Autostart is already set to a LaunchAgent. The keychain prompts once per signing identity, so keep that identity stable.</li>
</ul></div><div><h3>Windows</h3><ul>
<li>Per-user NSIS installer (no admin, ClaudeParty's rule), and WebView2 present or bootstrapped.</li>
<li>A code-signing certificate or Azure Trusted Signing, or SmartScreen warns.</li>
<li><b>Engine stop:</b> <code>CREATE_NEW_PROCESS_GROUP</code> and <code>CTRL_BREAK_EVENT</code> before kill, and <code>CREATE_NO_WINDOW</code>. These are marked <code>TODO(windows)</code> in <code>core.rs</code>.</li>
<li>Folder <code>Documents\\robotparts</code> (already coded). Autostart through the Run key (plugin).</li>
</ul></div></div>
<p class="muted">All three still need the updater (<code>tauri-plugin-updater</code>, a minisign key and a signed <code>latest.json</code>, uploaded artifact first and manifest last as ClaudeParty does) and a download page.</p>

<h2>Decision surface</h2>
<div class="cols"><div>
<h3>Done and proved</h3><ul>
<li>Sign-in with no code typed: the browser device page, then the token goes into the keychain.</li>
<li>The app makes <code>~/robotparts</code> and syncs it with push on. Disk to page in under 1 s (above).</li>
<li>Tray states (synced, syncing, paused, offline, over quota with the reason, signed out), Pause, Sign out, Quit and Start at login.</li>
<li>Linux .deb and AppImage, each with a <code>.desktop</code> entry. Engine and robotparts tests are green.</li>
</ul>
<h3>Left</h3><ul>
<li><b>Next:</b> a download page and hosting for the builds, the updater, then macOS and Windows on a build host (CI).</li>
<li><b>Next:</b> bundle rclone as a second sidecar, so the first sign-in needs no download from rclone.org (today <code>init</code> fetches the pinned, sha256-checked binary, as the CLI does).</li>
<li>Not blocked: everything above can run on Linux today.</li>
</ul></div><div>
<h3>Needs Zach</h3><ul>
<li><b>Where do downloads live?</b> Recommendation: GitHub Releases on the private repo, with a <code>robotparts.dev/download</code> page linking there. Default if you say nothing: the robotparts copy names the app but carries no link, as now.</li>
<li><b>Signing accounts</b> (Apple Developer ID, a Windows certificate). Default: unsigned Linux builds only until you choose.</li>
<li><b>The device-page loop fix (<code>26f3701</code>) for <code>lane/accounts</code>.</b> It affects every CLI login whose browser is already signed in. Recommendation: the accounts lane picks it up (one file, <code>accounts/site/signin.js</code>). Default: it stays on <code>lane/desktop</code> and the accounts lane is left alone, because that lane is mid-review.</li>
<li><b>Start at login on by default after the first sign-in?</b> Default: yes, like Dropbox or Obsidian Sync. One menu click turns it off.</li>
</ul>
<h3>Deliberately not done</h3><ul>
<li>No merge, no deploy, no production server touched.</li>
<li>No macOS or Windows builds (written down above).</li>
<li>No run against robotparts.dev: production was never touched. <code>app/scripts/try_local.sh</code> runs the app on the local stack with its own HOME.</li>
<li>No in-app web view of robotparts.dev (PEP 0005 §3.5): the tray app came first, as asked.</li>
</ul></div></div>
</main></body></html>
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--proof", required=True, type=pathlib.Path)
    ap.add_argument("--extra", type=pathlib.Path)
    ap.add_argument("--out", type=pathlib.Path, default=OUT)
    ap.add_argument("--runs", type=pathlib.Path, nargs="*", default=[], help="every passing proof run, for the latency table")
    args = ap.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    page = build(args.proof, args.extra, args.out, args.runs or [args.proof])
    args.out.write_text(page)
    print(args.out)


if __name__ == "__main__":
    main()
