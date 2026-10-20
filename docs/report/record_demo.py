"""Record the report's hero screencast: two "machines" syncing through the stand-in.

Every command really runs (the built folder-sync, the pinned rclone, a local
`rclone serve s3` on 127.0.0.1:4801 with throwaway keys); its real output is
captured with timestamps into a two-pane cast, which docs/report/player.html
replays in xterm.js while headless Chromium (Playwright 1.55) records video.
The only edit to the output: the demo's temp HOME is shown as `~`, as a shell
prompt would show it.

    uv run --with playwright==1.55.0 python docs/report/record_demo.py <out-dir>

Writes <out-dir>/demo-cast.json, hero.webm, hero.mp4, hero.gif, hero-poster.png.
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
RCLONE = REPO / ".tools" / "rclone"
XTERM = REPO / ".tools" / "npm" / "package"
CHROME = "/home/bam/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome"
TYPE_DELAY = 0.022  # seconds per typed character
AFTER_OUTPUT = 0.55  # pause after a command's output before the next prompt


def wait_port(port: int) -> None:
    for _ in range(50):
        with socket.socket() as sock:
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.1)
    raise SystemExit(f"port {port} never opened")


def main() -> int:
    out_dir = Path(sys.argv[1]).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="fs-demo-"))
    binary = work / "folder-sync"
    go = Path.home() / ".local" / "go" / "bin" / "go"
    subprocess.run([str(go), "build", "-o", str(binary), "./cmd/folder-sync"], cwd=REPO, check=True)
    bin_dir = work / "bin"
    bin_dir.mkdir()
    (bin_dir / "folder-sync").symlink_to(binary)

    with socket.socket() as sock:
        if sock.connect_ex(("127.0.0.1", 4801)) == 0:
            raise SystemExit("port 4801 is busy")
    key_id, secret = "demo" + secrets.token_hex(6), secrets.token_hex(20)
    (work / "s3" / "fs-demo").mkdir(parents=True)
    stand_in = subprocess.Popen(
        [str(RCLONE), "serve", "s3", "--addr", "127.0.0.1:4801", "--auth-key", f"{key_id},{secret}",
         "--config", os.devnull, "--cache-dir", str(work / "cache"), "--log-file", str(work / "serve.log"),
         str(work / "s3")])
    print(f"stand-in pid {stand_in.pid}", file=sys.stderr)
    try:
        wait_port(4801)
        cast = run_demo(work, bin_dir, key_id, secret)
    finally:
        stand_in.send_signal(signal.SIGTERM)
        stand_in.wait(timeout=10)
    (out_dir / "demo-cast.json").write_text(json.dumps(cast, indent=1))
    record(out_dir, cast)
    shutil.rmtree(work, ignore_errors=True)
    return 0


def run_demo(work: Path, bin_dir: Path, key_id: str, secret: str) -> dict:
    machines = {}
    for name in ("A", "B"):
        home = work / f"machine-{name.lower()}"
        folder = home / "notes"
        folder.mkdir(parents=True)
        env = {k: v for k, v in os.environ.items() if not k.startswith(("FOLDER_SYNC_", "RCLONE_"))}
        env.update(HOME=str(home), PATH=f"{bin_dir}:{env['PATH']}", FOLDER_SYNC_RCLONE=str(RCLONE),
                   FOLDER_SYNC_ACCESS_KEY_ID=key_id, FOLDER_SYNC_SECRET_ACCESS_KEY=secret,
                   FOLDER_SYNC_ENDPOINT="http://127.0.0.1:4801")
        machines[name] = {"home": home, "folder": folder, "env": env}
    a = machines["A"]["folder"]
    (a / "plan.md").write_text("# Plan\n- wrap rclone\n")
    (a / "todo.md").write_text("- write the contract\n")
    (a / ".env").write_text("API_KEY=never-uploaded\n")
    (a / "node_modules" / "left-pad").mkdir(parents=True)
    (a / "node_modules" / "left-pad" / "index.js").write_text("module.exports = 1\n")

    script = [
        ("A", "ls -A"),
        ("A", "folder-sync init --project demo --bucket fs-demo"),
        ("A", "folder-sync sync --once"),
        ("B", "folder-sync init --project demo --bucket fs-demo"),
        ("B", "folder-sync sync --once"),
        ("B", "cat hosts/*/plan.md"),
        ("A", "echo '- ship v0' >> plan.md; rm todo.md"),
        ("A", "folder-sync sync --once"),
        ("B", "folder-sync sync --once"),
        ("B", "cat hosts/*/plan.md; ls hosts/*/"),
        ("B", "folder-sync sync --once"),
    ]
    events = []  # [seconds, pane, text]
    clock = 0.4
    for name in ("A", "B"):
        events.append([0.0, name, prompt(name)])
    for pane, command in script:
        machine = machines[pane]
        for ch in command:
            events.append([round(clock, 3), pane, ch])
            clock += TYPE_DELAY
        clock += 0.15
        events.append([round(clock, 3), pane, "\r\n"])
        started = time.monotonic()
        result = subprocess.run(["bash", "-c", command], cwd=machine["folder"], env=machine["env"],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        took = time.monotonic() - started
        output = result.stdout.replace(str(machine["home"]), "~")
        if secret in output:
            raise SystemExit("the secret appeared in demo output")
        clock += min(took, 0.6)
        if output:
            events.append([round(clock, 3), pane, output.replace("\n", "\r\n")])
        clock += AFTER_OUTPUT
        events.append([round(clock, 3), pane, prompt(pane)])
        print(f"[{pane}] $ {command}  ({took:.2f}s, exit {result.returncode})\n{output}", file=sys.stderr)
        if result.returncode != 0:
            raise SystemExit(f"demo command failed: {command}")
    clock += 1.5
    return {"duration": round(clock, 3), "events": events,
            "titles": {"A": "machine A  ·  ~/notes", "B": "machine B  ·  ~/notes"}}


def prompt(pane: str) -> str:
    color = "36" if pane == "A" else "35"
    return f"\x1b[1;{color}mmachine-{pane.lower()}\x1b[0m:\x1b[1;34m~/notes\x1b[0m$ "


def record(out_dir: Path, cast: dict) -> None:
    from playwright.sync_api import sync_playwright  # noqa: PLC0415

    page_dir = Path(tempfile.mkdtemp(prefix="fs-player-"))
    shutil.copy(REPO / "docs" / "report" / "player.html", page_dir / "player.html")
    shutil.copy(XTERM / "lib" / "xterm.js", page_dir / "xterm.js")
    shutil.copy(XTERM / "css" / "xterm.css", page_dir / "xterm.css")
    (page_dir / "cast.js").write_text("window.CAST = " + json.dumps(cast) + ";")
    width, height = 1280, 640
    video_dir = page_dir / "video"
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, headless=True)
        context = browser.new_context(viewport={"width": width, "height": height},
                                      record_video_dir=str(video_dir), record_video_size={"width": width, "height": height})
        page = context.new_page()
        video_started = time.monotonic()  # the recording starts with the page
        page.goto((page_dir / "player.html").as_uri())
        page.wait_for_function("window.PLAYER_READY === true")
        time.sleep(0.5)
        started = time.monotonic()
        page.evaluate("window.play()")
        page.wait_for_function("window.PLAYER_DONE === true", timeout=120_000)
        page.screenshot(path=str(out_dir / "hero-poster.png"))
        video_path = page.video.path()
        context.close()
        browser.close()
    print(f"played {time.monotonic() - started:.1f}s", file=sys.stderr)
    raw = out_dir / "hero.webm"
    shutil.move(video_path, raw)
    # Trim the page-load frames before play() (keeping 0.3 s of the empty prompts),
    # then encode MP4 (H.264) and a small GIF fallback.
    trim = max(0.0, started - video_started - 0.3)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{trim:.2f}", "-i", str(raw),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "30", "-preset", "slow",
                    "-movflags", "+faststart", "-an", str(out_dir / "hero.mp4")], check=True)
    palette = page_dir / "palette.png"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{trim:.2f}", "-i", str(raw),
                    "-vf", "fps=6,scale=800:-1:flags=lanczos,palettegen=max_colors=32", str(palette)], check=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{trim:.2f}", "-i", str(raw), "-i", str(palette),
                    "-lavfi", "fps=6,scale=800:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=none",
                    str(out_dir / "hero.gif")], check=True)
    shutil.rmtree(page_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
