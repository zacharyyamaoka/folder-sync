#!/usr/bin/env python3
"""Builds the desktop-installers review report (PEP 0006) from the evidence of one CI release and one Linux proof.

    python3 docs/report/build_installers.py --evidence <dir> --proof <proof_linux.py out dir> --branch-sha <sha> [--out FILE]

<dir> of --evidence holds what was collected from the run (scripts in the report's "how it was checked" section):
  run.json          gh run view <id> --json url,headSha,conclusion,createdAt,updatedAt,jobs
  release.json      gh release view <tag> --json url,tagName,name,isPrerelease,assets,body
  SHA256SUMS        the release's own, downloaded
  verify.txt        sha256sum -c SHA256SUMS over the downloaded assets
  listing-*.txt     each installer's contents (7z l / dpkg-deb -c / --appimage-extract), cut to the sidecar lines
  download-*.png    /fs/download on the local stack (robotparts' /fs/ mount), desktop and phone width
  download-check.txt  one installer fetched through /fs/download, its headers and SHA-256
Copies the media into reports/media/desktop-installers-2026-10-28/ beside the page and writes one page, by default
/home/bam/folder-sync/reports/media/desktop-installers-2026-10-28.html in the main checkout.
"""

from __future__ import annotations

import argparse
import html
import json
import pathlib
import shutil
import subprocess

OUT = pathlib.Path("/home/bam/folder-sync/reports/media/desktop-installers-2026-10-28.html")
NAME = "desktop-installers-2026-10-28"

OS_STEPS = {
    "Mac": [
        "Open <code>folder-sync-…-macos-universal.dmg</code>, drag <b>folder-sync</b> into Applications.",
        "Open it from Applications. macOS: <i>“folder-sync” cannot be opened because Apple cannot verify it…</i> → click <b>Done</b>.",
        "System Settings → Privacy &amp; Security → scroll to <i>“folder-sync” was blocked</i> → <b>Open Anyway</b> → password. (macOS 14 and older: right-click the app → <b>Open</b> → <b>Open</b>.)",
        "If it says the app <i>is damaged</i> instead: <code>xattr -dr com.apple.quarantine /Applications/folder-sync.app</code>, then open again.",
    ],
    "Windows": [
        "Run <code>folder-sync-…-windows-x64-setup.exe</code> (per-user, no admin; the <code>.msi</code> is the all-users variant).",
        "SmartScreen: <i>Windows protected your PC</i> → <b>More info</b> → <b>Run anyway</b>.",
        "The app starts in the tray, bottom right (maybe under <b>^</b>).",
    ],
    "Linux": [
        "<code>chmod +x folder-sync-…-linux-x86_64.AppImage</code> and run it (GNOME needs the AppIndicator extension for the tray), or",
        "<code>sudo apt install ./folder-sync-…-linux-amd64.deb</code> and open <b>folder-sync</b> from the app grid.",
    ],
}

TEST_SCRIPT = [
    ("Download and check", "On that machine, open the release (or <code>/fs/download</code> once deployed), download the installer for it, and compare its SHA-256 with the table below: <code>shasum -a 256 &lt;file&gt;</code> (Mac) or <code>Get-FileHash &lt;file&gt;</code> (Windows)."),
    ("Install past the warning", "Install it with the first-run steps above. Pass: the app opens and shows one button, <b>Sign in</b>, and a folder icon appears in the menu bar / tray."),
    ("Sign in", "Click <b>Sign in</b>. Your browser opens <code>robotparts.dev/fs/device</code>; approve it. Pass: the app says signed in as you, and the keychain prompt (Mac) is answered <b>Always Allow</b> once."),
    ("Create the folder and drop a file", "Click <b>Create folder</b> (<code>~/robotparts</code>, Windows <code>Documents\\robotparts</code>), drop any file in. Pass: tray says <b>Synced</b> and the file shows on robotparts.dev/saved/ and on your Linux box's <code>~/robotparts</code> within a few seconds. On Windows: no console window flashes up."),
    ("Survive a restart", "Quit from the tray, reopen the app (or log out and back in with <b>Start at login</b> on). Pass: it comes back synced without asking you to sign in, and a file added on another machine meanwhile is there."),
]


def esc(value) -> str:
    return html.escape(str(value))


def size(n: int) -> str:
    return f"{n / 1e6:.1f} MB"


def build(evidence: pathlib.Path, proof_dir: pathlib.Path, out: pathlib.Path, branch_sha: str) -> str:
    run = json.loads((evidence / "run.json").read_text())
    release = json.loads((evidence / "release.json").read_text())
    proof = json.loads((proof_dir / "proof.json").read_text()) if (proof_dir / "proof.json").exists() else {}
    sums = {line.split()[1]: line.split()[0] for line in (evidence / "SHA256SUMS").read_text().splitlines() if line.strip()}
    verify = (evidence / "verify.txt").read_text() if (evidence / "verify.txt").exists() else ""
    media = out.parent / NAME
    media.mkdir(parents=True, exist_ok=True)

    def copy(src: pathlib.Path, name: str | None = None) -> str:
        target = media / (name or src.name)
        shutil.copyfile(src, target)
        return f"{NAME}/{target.name}"

    jobs = "\n".join(
        f"<tr><td>{esc(j['name'])}</td><td class='{'ok' if j.get('conclusion') == 'success' else 'bad'}'>{esc(j.get('conclusion') or j.get('status'))}</td>"
        f"<td>{esc(j.get('startedAt', '')[11:19])} → {esc(j.get('completedAt', '')[11:19])} UTC</td></tr>"
        for j in run["jobs"]
    )
    verified_on = {"linux": "Installed and driven headlessly (below)", "macos": "NOT VERIFIED ON DEVICE", "windows": "NOT VERIFIED ON DEVICE"}
    rows = []
    for asset in release["assets"]:
        name = asset["name"]
        if name == "SHA256SUMS":
            continue
        os_key = "macos" if "macos" in name else "windows" if "windows" in name else "linux"
        status = verified_on[os_key]
        good = "ok" if os_key == "linux" else "warn"
        if os_key == "linux" and name.endswith(".deb"):
            status, good = "Built and listed; the proof ran the AppImage", "warn"
        rows.append(
            f"<tr><td><code>{esc(name)}</code></td><td class='num'>{size(asset['size'])}</td>"
            f"<td><code class='sha'>{esc(sums.get(name, '—'))}</code></td><td class='{good}'>{esc(status)}</td></tr>"
        )
    listings = []
    for path in sorted(evidence.glob("listing-*.txt")):
        listings.append(f"<h3>{esc(path.stem.removeprefix('listing-'))}</h3><pre>{esc(path.read_text().strip())}</pre>")

    shots = []
    for key, caption in [
        ("window-signed-out", "First open: one button, Sign in"),
        ("tray-signing-in", "Signing in: the browser has the device page"),
        ("window-needs-folder", "Signed in: Create ~/robotparts"),
        ("window-synced", "Synced"),
        ("tray-synced", "The tray menu, synced"),
        ("hero-page-row", "The dropped file on the signed-in /saved/ page"),
    ]:
        src = proof_dir / "shots" / f"{key}.png"
        if src.exists():
            shots.append(f"<figure><img src='{copy(src)}' alt='{esc(caption)}' loading='lazy'><figcaption>{esc(caption)}</figcaption></figure>")
    hero = ""
    raw = proof_dir / "hero-raw.mp4"
    if raw.exists():
        # the whole first run (sign in → folder → file on the page) at 4x, capped at 20 s, plus a GIF fallback
        clip, gif = media / "linux-first-run.mp4", media / "linux-first-run.gif"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(raw), "-t", "80", "-vf", "setpts=PTS/4,scale=1020:-2", "-an", "-c:v", "libx264", "-crf", "26", "-pix_fmt", "yuv420p", str(clip)], check=True)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(clip), "-vf", "fps=6,scale=640:-2:flags=lanczos", str(gif)], check=True)
        hero = (f"<video src='{NAME}/{clip.name}' controls muted loop playsinline autoplay poster=''>"
                f"<img src='{NAME}/{gif.name}' alt='Linux first run'></video>"
                f"<p class='cap'>The release's AppImage, first run at 4x: Sign in → approve in the browser → Create ~/robotparts → a file dropped in shows on the signed-in page. <a href='{NAME}/{gif.name}'>GIF</a></p>")
    downloads = "".join(
        f"<figure><img src='{copy(p)}' alt='{esc(p.stem)}' loading='lazy'><figcaption>{esc(p.stem.replace('download-', '/fs/download, '))}</figcaption></figure>"
        for p in sorted(evidence.glob("download-*.png"))
    )
    proof_steps = "\n".join(
        f"<tr><td>{esc(s['step'])}</td><td class='num'>{esc(s.get('t', ''))}</td><td><code>{esc(json.dumps({k: v for k, v in s.items() if k not in ('t', 'step')}) if len(s) > 2 else '')}</code></td></tr>" for s in proof.get("steps", [])
    )
    os_steps = "".join(f"<div class='os'><h3>{esc(os)}</h3><ol>{''.join(f'<li>{s}</li>' for s in steps)}</ol></div>" for os, steps in OS_STEPS.items())
    test_script = "".join(f"<li><b>{esc(t)}.</b> {body}</li>" for t, body in TEST_SCRIPT)

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Desktop installers</title>
<style>
:root {{ --bg:#fcfcfb; --fg:#151514; --muted:#66645f; --line:#e3e1dc; --ok:#1d7a3a; --warn:#9a6400; --bad:#a32020; --card:#fff; }}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ --bg:#141413; --fg:#efeee9; --muted:#a3a19b; --line:#2f2e2b; --ok:#6fd08f; --warn:#e6b45c; --bad:#f08c8c; --card:#1c1c1a; }} }}
body {{ margin:0; background:var(--bg); color:var(--fg); font:14px/1.55 system-ui,sans-serif; }}
main {{ max-width:1040px; margin:0 auto; padding:24px 16px 64px; }}
h1 {{ font-size:22px; margin:0 0 6px; }} h2 {{ font-size:16px; margin:32px 0 8px; border-top:1px solid var(--line); padding-top:18px; }} h3 {{ font-size:14px; margin:14px 0 4px; }}
.verdict {{ font-size:15px; padding:12px 14px; border-radius:8px; background:var(--card); border:1px solid var(--line); }}
table {{ border-collapse:collapse; width:100%; font-size:13px; }} td,th {{ border-bottom:1px solid var(--line); padding:6px 8px; text-align:left; vertical-align:top; }}
.num {{ text-align:right; white-space:nowrap; }} .ok {{ color:var(--ok); }} .warn {{ color:var(--warn); font-weight:600; }} .bad {{ color:var(--bad); font-weight:600; }}
code {{ font:12px ui-monospace,monospace; }} .sha {{ word-break:break-all; font-size:11px; }}
pre {{ background:var(--card); border:1px solid var(--line); border-radius:6px; padding:10px; overflow:auto; font-size:12px; }}
.grid {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }}
figure {{ margin:0; }} img,video {{ max-width:100%; border:1px solid var(--line); border-radius:6px; }} figcaption {{ color:var(--muted); font-size:12px; }}
.os {{ background:var(--card); border:1px solid var(--line); border-radius:8px; padding:4px 14px; margin:8px 0; }}
.scroll {{ overflow-x:auto; }} .cap {{ color:var(--muted); font-size:12px; margin-top:4px; }} a {{ color:inherit; }}
</style></head><body><main>
<h1>folder-sync desktop installers</h1>
<p class="verdict"><b>Unsigned installers for Mac, Windows and Linux build from one tag and land on a GitHub Release with SHA-256 sums</b>: on <code>lane/desktop-release</code> @ <code>{esc(branch_sha)}</code> (installers built from <code>{esc(run['headSha'][:7])}</code>; later commits touch only the proof script, the page's CSS and this report), not merged. Linux is installed and signed in end to end here; <b>Mac and Windows are NOT VERIFIED ON DEVICE</b> (their bundles are listed and contain the engine). <code>/fs/download</code> is written and tested locally, not deployed.</p>
<p>CI run: <a href="{esc(run['url'])}">{esc(run['url'])}</a> ({esc(run['conclusion'])}) · Release: <a href="{esc(release['url'])}">{esc(release['name'])}</a> (private repo: only you can open it)</p>
{hero}
<h2>Jobs</h2><div class="scroll"><table><tr><th>Job</th><th>Result</th><th>Time</th></tr>{jobs}</table></div>
<h2>Artifacts</h2><div class="scroll"><table><tr><th>File</th><th>Size</th><th>SHA-256</th><th>Verified</th></tr>{''.join(rows)}</table></div>
<p>Downloaded from the release and checked against its own <code>SHA256SUMS</code>:</p><pre>{esc(verify.strip())}</pre>
<h2>The engine is inside every bundle</h2>
<p>Each installer was opened here and its contents listed; these are the app and the Go engine (the Tauri sidecar <code>folder-sync</code>), the right architecture for each.</p>
{''.join(listings)}
<h2>Linux: installed and signed in, headless</h2>
<p>The release's AppImage, run under Xvfb with a private D-Bus, a throwaway keyring and a scratch HOME, against a local accounts stack (robotparts' demo person, never your account). Every process it started was stopped by pid at the end.</p>
<div class="grid">{''.join(shots)}</div>
<details><summary>Every proof step</summary><div class="scroll"><table><tr><th>Step</th><th>t (s)</th><th>Note</th></tr>{proof_steps}</table></div></details>
<h2>/fs/download (local stack, not deployed)</h2>
<p>The Worker's new page, served by the local accounts stack through robotparts' <code>/fs/</code> mount at <code>127.0.0.1:4973/fs/download</code>, with this release's <code>latest.json</code> and files put into its local R2 bucket. It leads with the visitor's OS; the files stream from the <code>folder-sync-downloads</code> bucket.</p>
<div class="grid">{downloads}</div>
<p>A real download through it, checked against the release:</p><pre>{esc((evidence / "download-check.txt").read_text().strip()) if (evidence / "download-check.txt").exists() else ""}</pre>
<h2>Install, per OS (first-run warnings for unsigned apps)</h2>{os_steps}
<h2>Your 5-step test on the Mac and on Windows</h2><ol>{test_script}</ol>
<h2>Found and fixed on the way</h2><ul>
<li><b>Over quota showed as “Sync error”</b> after the v0 merge: read-only keys (PEP 0003 §3.7) surface as <code>syncer.ReadOnlyError</code>, which the engine's event classifier didn't know. Failing-first cases in <code>TestClassifyRoundErrors</code>; the proof now reaches <i>Over quota</i>.</li>
<li><b>Times blank on Mac and Windows</b>: the app shelled out to <code>date</code> (none on Windows; BSD <code>date</code> has no <code>-d</code>). Now chrono, already in Tauri's tree.</li>
<li><b>A console window per sync on Windows</b>: the engine is now started with <code>CREATE_NO_WINDOW</code>.</li>
<li><b>“App is damaged” on Apple silicon</b> for unsigned bundles: ad-hoc signed (<code>signingIdentity "-"</code>) so the warning is the passable “cannot verify”.</li>
<li><b>macOS bundle had no icon type</b>: added <code>icon.icns</code>.</li>
<li><b>/fs/download first draft</b> turned the account page's <i>Sign in</i> button black-on-black and scrolled sideways on a phone; own classes now, 390 px measured, a CSS guard test.</li>
<li><b>Proof flake</b>: with no window manager the sign-in browser could stack over the tray; the proof raises the tray before each click.</li>
</ul>
<h2>What needs you</h2><ol>
<li><b>Test on the Mac and on Windows</b> with the 5 steps above (nothing else verifies those two).</li>
<li><b>Turn on the R2 copy</b> (default if you say nothing: GitHub Release only, the page stays “nothing published”). In Cloudflare → R2 → Manage API tokens → <i>Create User API token</i>: permission <b>Object Read &amp; Write</b>, <b>Apply to specific buckets only → folder-sync-downloads</b>, no expiry. Then the two <code>gh secret set</code> commands and one job re-run (in the handoff).</li>
<li><b>Deploy</b> is the Vibe Tracks session's: <code>lane/desktop-release</code> merged into <code>claude/folder-sync-v0</code> (your call), then <code>wrangler r2 bucket create folder-sync-downloads</code> once, then the usual deploy. Robotparts.dev/fs/download and vibetracks.dev/fs/download work from that deploy, no app change.</li>
</ol>
<h2>Not verified</h2><ul>
<li><b>Mac and Windows on a device</b>: not run on either (this box is Linux). The 5 steps above are the test.</li>
<li><b>Windows stop</b>: the engine is still killed on Quit (no CTRL_BREAK yet, <code>TODO(windows)</code> in core.rs), so a sync round in flight at Quit is cut and redone next start.</li>
<li><b>The R2 copy and the deployed page</b>: the CI step skips until the two secrets exist; the Worker deploy (with the new bucket binding) is the Vibe Tracks session's.</li>
<li><b>Signing</b>: none, by design for now (ad-hoc on Mac so the warning is “cannot verify”, not “damaged”).</li>
</ul>
</main></body></html>
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--evidence", required=True, type=pathlib.Path)
    parser.add_argument("--proof", required=True, type=pathlib.Path)
    parser.add_argument("--out", type=pathlib.Path, default=OUT)
    parser.add_argument("--branch-sha", required=True)
    args = parser.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(build(args.evidence, args.proof, args.out, args.branch_sha))
    print(args.out)


if __name__ == "__main__":
    main()
