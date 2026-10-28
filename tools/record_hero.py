"""Record the landing page's hero video from the real product on a local stack.

setup.mjs stands up main's accounts Worker (wrangler dev, local D1, the R2 stand-in) and signs two machines (two
HOMEs) in to one test person. This script serves stage.html and the small API it drives: run the CLI on machine A,
start `sync --watch` on A and B, write files into A's folder, read B's folder, and proxy the Worker's public folder
API (the stage is on another origin). For every write it measures, by polling, when the Worker serves the same bytes
(every 25 ms) and when they land on B's disk (every 10 ms). Headless Chromium (Playwright) records the stage and
screenshots the stills (still-4-end.png is the poster); ffmpeg makes the MP4 (H.264 baseline) and the GIF.

    uv run --with playwright==1.55.0 python record_hero.py --setup setup.json --cli PATH --out DIR [--port 4975]
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
CHROME = "/home/bam/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome"


def now_ms() -> float:
    return time.time() * 1000


class Harness:
    def __init__(self, setup: dict, cli: str, assets: Path):
        self.setup = setup
        self.cli = cli
        self.assets = assets
        self.server = setup["stack"]["accounts"]
        self.machines = setup["machines"]
        self.watchers: dict[str, subprocess.Popen] = {}
        self.logs: dict[str, list[str]] = {"a": [], "b": []}
        self.measures: dict[str, dict] = {}  # "<path>@<sha>" -> {write_ms, online_ms, peer_ms}
        self.marks: list[dict] = []
        self.lock = threading.Lock()

    def host(self, m: str) -> str:
        return json.loads(Path(self.machines[m]["home"], ".folder-sync", "host.json").read_text())["id"]

    def tilde(self, text: str, m: str) -> str:
        return text.replace(self.machines[m]["home"], "~")

    def run(self, m: str, args: list[str]) -> dict:
        machine = self.machines[m]
        done = subprocess.run([self.cli, *args], cwd=machine["folder"], env=machine["env"], capture_output=True, text=True, timeout=120)
        return {"code": done.returncode, "out": self.tilde(done.stdout + done.stderr, m)}

    def watch(self, m: str) -> None:
        machine = self.machines[m]
        child = subprocess.Popen([self.cli, "sync", "--watch", "--dir", machine["folder"]], cwd=machine["folder"], env=machine["env"],
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        self.watchers[m] = child

        def pump() -> None:
            for line in child.stdout:
                self.logs[m].append(self.tilde(line.rstrip("\n"), m))
        threading.Thread(target=pump, daemon=True).start()

    def stop(self) -> None:
        for child in self.watchers.values():
            child.terminate()
        for child in self.watchers.values():
            try:
                child.wait(10)
            except subprocess.TimeoutExpired:
                child.kill()

    def owner_url(self, rel: str) -> str:
        sep = "&" if "?" in rel else "?"
        return f"{self.server}/fs/v1/folders/notes{rel}{sep}owner={self.setup['userId']}"

    def get(self, url: str) -> tuple[int, bytes, str]:
        try:
            with urllib.request.urlopen(url, timeout=5) as answer:
                return answer.status, answer.read(), answer.headers.get("Content-Type", "")
        except urllib.error.HTTPError as error:
            return error.code, error.read(), error.headers.get("Content-Type", "")
        except Exception:
            return 0, b"", ""

    def token(self, m: str) -> str:
        return json.loads(Path(self.machines[m]["home"], ".folder-sync", "account.json").read_text())["token"]

    def write(self, m: str, path: str, data: bytes) -> dict:
        target = Path(self.machines[m]["folder"], path)
        sha = hashlib.sha256(data).hexdigest()
        key = f"{path}@{sha}"
        with self.lock:
            self.measures[key] = {"write_ms": now_ms()}
        target.write_bytes(data)  # a plain write, as an editor or agent saves
        t0 = self.measures[key]["write_ms"]
        host_a = self.host("a")
        auth = {"Authorization": f"Bearer {self.token(m)}"}

        def online() -> None:
            # the same check bench/latency makes: the Worker's /files route answers 200 with the same bytes
            url = f"{self.server}/fs/v1/folders/notes/files/{host_a}/{path}"
            until = time.time() + 60
            while time.time() < until:
                try:
                    with urllib.request.urlopen(urllib.request.Request(url, headers=auth), timeout=5) as answer:
                        if answer.status == 200 and answer.read() == data:
                            self.measures[key]["online_ms"] = round(now_ms() - t0)
                            return
                except Exception:
                    pass
                time.sleep(0.025)

        def peer() -> None:
            landed = Path(self.machines["b"]["folder"], "hosts", host_a, path)
            until = time.time() + 60
            while time.time() < until:
                try:
                    if landed.read_bytes() == data:
                        self.measures[key]["peer_ms"] = round(now_ms() - t0)
                        return
                except OSError:
                    pass
                time.sleep(0.01)
        threading.Thread(target=online, daemon=True).start()
        threading.Thread(target=peer, daemon=True).start()
        return {"sha": sha, "t": t0}

    def tree(self, m: str) -> dict:
        files = []
        if not Path(self.machines["a"]["home"], ".folder-sync", "host.json").exists():
            return {"files": files}  # A has not run init yet
        root = Path(self.machines[m]["folder"], "hosts", self.host("a"))
        if root.is_dir():
            for p in sorted(root.rglob("*")):
                if p.is_file() and not p.name.startswith("."):
                    data = p.read_bytes()
                    files.append({"path": str(p.relative_to(root)), "name": p.name, "size": len(data), "sha": hashlib.sha256(data).hexdigest(),
                                  "text": data.decode("utf8", "replace") if p.suffix in (".md", ".json", ".txt") else ""})
        return {"files": files}


def handler_for(h: Harness):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a) -> None:
            pass

        def send(self, code: int, body: bytes, kind: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", kind)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def json(self, value, code: int = 200) -> None:
            self.send(code, json.dumps(value).encode(), "application/json")

        def do_GET(self) -> None:
            u = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            if u.path == "/":
                return self.send(200, (HERE / "stage.html").read_bytes(), "text/html; charset=utf-8")
            if u.path == "/api/config":
                return self.json({"hostA": h.host("a") if Path(h.machines["a"]["home"], ".folder-sync", "host.json").exists() else None, "hostB": h.machines["b"]["hostId"], "serverHost": h.server.replace("http://", "")})
            if u.path == "/api/log":
                return self.send(200, "\n".join(h.logs[q["m"]]).encode(), "text/plain; charset=utf-8")
            if u.path == "/api/tree":
                return self.json(h.tree(q["m"]))
            if u.path == "/api/measure":
                return self.json(h.measures.get(f"{q['path']}@{q['sha']}", {}))
            if u.path == "/api/asset":
                data = (h.assets / q["name"]).read_bytes()
                return self.json({"b64": base64.b64encode(data).decode(), "size": len(data)})
            if u.path == "/api/online/listing":
                code, body, kind = h.get(h.owner_url(""))  # anonymous: the folder is public
                return self.send(code or 502, body, kind or "application/json")
            if u.path == "/api/online/file":
                code, body, kind = h.get(h.owner_url(f"/files/{h.host('a')}/{q['path']}"))
                return self.send(code or 502, body, kind or "application/octet-stream")
            self.send(404, b"no", "text/plain")

        def do_POST(self) -> None:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            if self.path == "/api/run":
                return self.json(h.run(body["m"], body["args"]))
            if self.path == "/api/watch":
                h.watch(body["m"])
                return self.json({"ok": True})
            if self.path == "/api/write":
                return self.json(h.write(body["m"], body["path"], base64.b64decode(body["b64"])))
            if self.path == "/api/mark":
                h.marks.append({"name": body["name"], "t": now_ms(), **({"result": body["result"]} if "result" in body else {})})
                return self.json({"ok": True})
            self.send(404, b"no", "text/plain")
    return Handler


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--setup", required=True)
    ap.add_argument("--cli", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--port", type=int, default=4975)
    o = ap.parse_args()
    out = Path(o.out)
    out.mkdir(parents=True, exist_ok=True)
    setup = json.loads(Path(o.setup).read_text())
    h = Harness(setup, o.cli, HERE / "assets")
    httpd = ThreadingHTTPServer(("127.0.0.1", o.port), handler_for(h))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    h.watch("b")  # the second machine is already running, as it would be
    while not any("Watching " in line for line in h.logs["b"]):
        time.sleep(0.05)

    from playwright.sync_api import sync_playwright
    stills = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=CHROME)
            context = browser.new_context(viewport={"width": 1280, "height": 720}, record_video_dir=str(out / "raw"), record_video_size={"width": 1280, "height": 720})
            t_context = now_ms()
            page = context.new_page()
            page.goto(f"http://127.0.0.1:{o.port}/")
            seen = set()
            until = time.time() + 120
            while time.time() < until:
                if page.evaluate("window.ERROR || null"):
                    raise SystemExit("stage error: " + page.evaluate("window.ERROR"))
                for mark in list(h.marks):
                    if mark["name"] in ("watching", "dropped", "edited") and mark["name"] not in seen:
                        seen.add(mark["name"])
                        shot = out / f"still-{len(seen)}-{mark['name']}.png"
                        page.screenshot(path=str(shot))
                        stills.append(str(shot))
                if page.evaluate("window.DONE === true"):
                    break
                time.sleep(0.05)
            page.screenshot(path=str(out / "still-4-end.png"))
            result = page.evaluate("window.RESULT")
            video = page.video.path()
            context.close()
            browser.close()
    finally:
        h.stop()
        httpd.shutdown()
    start = next(m["t"] for m in h.marks if m["name"] == "start")
    end = next(m["t"] for m in h.marks if m["name"] == "end")
    offset = max(0.0, (start - t_context) / 1000 - 0.2)
    length = (end - start) / 1000 + 0.4
    (out / "hero-run.json").write_text(json.dumps({"result": result, "marks": h.marks, "measures": h.measures, "video": video,
                                                   "offset_s": offset, "length_s": length, "hosts": {k: h.host(k) for k in h.machines},
                                                   "log_a": h.logs["a"], "log_b": h.logs["b"], "recorded": time.strftime("%Y-%m-%dT%H:%M:%S%z")}, indent=2))
    # The published cut (2026-10-28) was 0.2 s in, 16 s long: the stage is drawn by then, and the raw video's last
    # ~0.3 s is the final screenshot and the context closing.
    raw = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video], capture_output=True, text=True, check=True).stdout)
    cut = ["-ss", "0.2", "-i", video, "-t", f"{raw - 0.5:.2f}"]
    subprocess.run(["ffmpeg", "-v", "error", "-y", *cut, "-an", "-c:v", "libx264", "-profile:v", "baseline", "-level", "3.1", "-pix_fmt", "yuv420p",
                    "-r", "25", "-crf", "24", "-preset", "slow", "-movflags", "+faststart", str(out / "hero.mp4")], check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", *cut, "-vf", "fps=8,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];"
                    "[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", str(out / "hero.gif")], check=True)
    print(json.dumps({"result": result, "offset_s": offset, "length_s": length, "video": video}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
