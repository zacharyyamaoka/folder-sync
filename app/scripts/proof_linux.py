#!/usr/bin/env python3
"""The desktop app's first-run proof on Linux, headless (docs/peps/0006 §6.3).

    /home/bam/psu-atlas/.venv/bin/python app/scripts/proof_linux.py --app <AppImage or binary> --out <dir>

What it does, all of it invisible (an Xvfb display, a private D-Bus session, a throwaway keyring, a scratch HOME):

1. starts robotparts' local accounts stack (`tools/accounts_demo.py up --fresh`, robotparts lane/fast-sync) on the
   4970 base with its state in <out>/demo, and a small quota so the over-quota path is real;
2. starts Xvfb, gnome-keyring (unlocked with a test password, in <out>/home), stalonetray (an XEmbed tray: libayatana
   falls back to it when no StatusNotifier host is on the bus), a headed Chromium standing in for the system browser,
   and ffmpeg recording the screen;
3. runs the app: Sign in → the "browser" opens the device page → email code from the dev mailbox → Approve → the app
   stores the session in the keychain → Create ~/robotparts → a heart file dropped in the folder → measured until the
   signed-in /saved/ page shows its row;
4. walks the tray through its states (synced, syncing, paused, offline, over quota, signed out), screenshotting the
   open menu each time, and checks that the token is nowhere on disk in plain text;
5. stops everything it started, by pid, and writes <out>/proof.json.

Test values only: the person is robotparts' demo person (maker@example.com), the keyring password is a constant made
up here, and nothing leaves 127.0.0.1.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import random
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request

ROBOTPARTS = pathlib.Path(os.environ.get("ROBOTPARTS_LANE") or "/home/bam/robotparts/.claude/worktrees/lane-fast-sync")
REPO = pathlib.Path(__file__).resolve().parents[2]
BASE = 4970
SITE = f"http://127.0.0.1:{BASE + 3}"
STANDIN_PORT = BASE
W, H = 1360, 800
APP_POS = (24, 70)
BROWSER_POS = (468, 24)
KEYRING_PASSWORD = "proof-only-keyring"  # a throwaway keyring in the scratch HOME
PART = "actuator/aifitlab-8541438771336"


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


class Proof:
    def __init__(self, app: pathlib.Path, out: pathlib.Path, display: int):
        self.app = app
        self.out = out
        self.display = f":{display}"
        self.home = out / "home"
        # the bus's own runtime dir (main() sets it before dbus-run-session): one dir, so one keyring control socket
        self.runtime = pathlib.Path(os.environ["XDG_RUNTIME_DIR"])
        self.shots = out / "shots"
        self.procs: dict[str, subprocess.Popen] = {}
        self.result: dict = {"app": str(app), "site": SITE, "steps": [], "states": {}}
        self.t0 = time.time()

    # ---------------------------------------------------------------- plumbing
    def step(self, name: str, **extra):
        rec = {"t": round(time.time() - self.t0, 2), "step": name, **extra}
        self.result["steps"].append(rec)
        log(name, extra or "")

    def env(self, **extra) -> dict:
        e = {k: v for k, v in os.environ.items() if not k.startswith(("FOLDER_SYNC_", "XDG_", "GNOME_KEYRING", "SSH_AUTH"))}
        e.update({
            "HOME": str(self.home), "DISPLAY": self.display, "XDG_RUNTIME_DIR": str(self.runtime),
            "XDG_CONFIG_HOME": str(self.home / ".config"), "XDG_DATA_HOME": str(self.home / ".local/share"),
            "XDG_CACHE_HOME": str(self.home / ".cache"), "GDK_BACKEND": "x11", "NO_AT_BRIDGE": "1",
            "WEBKIT_DISABLE_COMPOSITING_MODE": "1", "WEBKIT_DISABLE_DMABUF_RENDERER": "1", "LANG": "C.UTF-8",
            "GIO_USE_VFS": "local", "GTK_USE_PORTAL": "0",
        })
        e.update(extra)
        return e

    def spawn(self, name: str, argv: list[str], env: dict | None = None, **kw) -> subprocess.Popen:
        logf = open(self.out / "logs" / f"{name}.log", "ab")
        p = subprocess.Popen(argv, env=env or self.env(), stdout=kw.pop("stdout", logf), stderr=logf, **kw)
        self.procs[name] = p
        return p

    def stop(self, name: str, sig=signal.SIGTERM, timeout=15):
        p = self.procs.pop(name, None)
        if not p or p.poll() is not None:
            return
        try:
            p.send_signal(sig)
            p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait()

    def x(self, *args: str) -> str:
        return subprocess.run(["xdotool", *args], env=self.env(), capture_output=True, text=True).stdout.strip()

    def shot(self, name: str, region=None) -> pathlib.Path:
        path = self.shots / f"{name}.png"
        raw = self.out / "logs" / "screen.xwd"
        subprocess.run(["xwd", "-root", "-silent", "-display", self.display, "-out", str(raw)], check=True)
        crop = []
        if region:
            x, y, w, h = region
            crop = ["-vf", f"crop={w}:{h}:{x}:{y}"]
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(raw), *crop, str(path)], check=True)
        return path

    def pixels(self):
        from PIL import Image
        raw = self.out / "logs" / "px.png"
        tmp = self.out / "logs" / "px.xwd"
        subprocess.run(["xwd", "-root", "-silent", "-display", self.display, "-out", str(tmp)], check=True)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(tmp), str(raw)], check=True)
        return Image.open(raw).convert("RGB")

    def find_color(self, rgb, region, tol=18):
        """Centre of the pixels of one colour inside region (x, y, w, h): how the app's primary button is found."""
        img = self.pixels()
        x0, y0, w, h = region
        xs, ys = [], []
        px = img.load()
        for y in range(y0, y0 + h, 2):
            for x in range(x0, x0 + w, 2):
                r, g, b = px[x, y]
                if abs(r - rgb[0]) < tol and abs(g - rgb[1]) < tol and abs(b - rgb[2]) < tol:
                    xs.append(x)
                    ys.append(y)
        if len(xs) < 20:
            return None
        return (sorted(xs)[len(xs) // 2], sorted(ys)[len(ys) // 2])

    def click(self, x, y):
        self.x("mousemove", str(x), str(y))
        time.sleep(0.25)
        self.x("click", "1")

    def app_region(self):
        return (APP_POS[0], APP_POS[1], 420, 560)

    def click_primary(self, what: str, timeout=20):
        until = time.time() + timeout
        while time.time() < until:
            at = self.find_color((37, 99, 235), self.app_region())
            if at:
                self.step(f"click {what}", at=at)
                self.click(*at)
                return
            time.sleep(0.3)
        raise SystemExit(f"no primary button for {what}")

    def settings(self) -> dict:
        p = self.home / ".config" / "dev.folder-sync.desktop" / "settings.json"
        return json.loads(p.read_text()) if p.exists() else {}

    def engine_log(self) -> str:
        p = self.home / ".local/share/dev.folder-sync.desktop/engine.log"
        return p.read_text(errors="replace") if p.exists() else ""

    def wait_status(self, words: str, timeout=60) -> float:
        """Wait until the engine log records a status line containing words (core.rs logs each change)."""
        until = time.time() + timeout
        while time.time() < until:
            lines = [l for l in self.engine_log().splitlines() if "status:" in l]
            if lines and words.lower() in lines[-1].lower():
                return time.time()
            time.sleep(0.1)
        raise SystemExit(f"status never became {words!r}; last: {lines[-1:] if lines else None}")

    # ---------------------------------------------------------------- the stack
    def demo(self, verb: str, **env):
        e = {**os.environ, "ROBOTPARTS_DEMO_BASE": str(BASE), "ROBOTPARTS_DEMO_STATE": str(self.out / "demo"),
             "FOLDER_SYNC_REPO": str(REPO), "RCLONE": str(REPO / ".tools" / "rclone"), **env}
        args = [sys.executable if verb == "x" else "python3", str(ROBOTPARTS / "tools" / "accounts_demo.py"), verb]
        if verb == "up":
            args.append("--fresh")
        r = subprocess.run(args, cwd=ROBOTPARTS, env=e, capture_output=True, text=True, timeout=600)
        (self.out / "logs" / f"demo-{verb}.log").write_text(r.stdout + r.stderr)
        if r.returncode:
            raise SystemExit(f"accounts_demo {verb} failed: {r.stderr[-2000:]}")
        return r.stdout

    def standin_pid(self) -> int:
        rec = json.loads((self.out / "demo" / "demo.json").read_text())
        # dev.mjs names its processes store, gate and accounts; the gate answers on the storage endpoint (BASE)
        return rec["pids"]["fs-gate"]

    # ---------------------------------------------------------------- the desktop
    def desktop(self):
        for d in (self.home, self.runtime, self.shots, self.out / "logs"):
            d.mkdir(parents=True, exist_ok=True)
        os.chmod(self.runtime, 0o700)
        # WHY first: anything that asks for org.freedesktop.secrets before this (a portal, the browser) would bus-activate
        # a second, locked gnome-keyring with no collection, and the app's first keychain write would fail
        keyring = self.spawn("keyring", ["gnome-keyring-daemon", "--foreground", "--unlock", "--components=secrets"],
                             stdin=subprocess.PIPE)
        keyring.stdin.write(KEYRING_PASSWORD.encode())
        keyring.stdin.close()
        until = time.time() + 15
        while time.time() < until:
            names = subprocess.run(["dbus-send", "--session", "--print-reply", "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus",
                                    "org.freedesktop.DBus.ListNames"], env=self.env(), capture_output=True, text=True).stdout
            if "org.freedesktop.secrets" in names:
                break
            time.sleep(0.2)
        else:
            raise SystemExit("the test keyring never took org.freedesktop.secrets")
        self.step("test keyring ready")
        self.spawn("xvfb", ["Xvfb", self.display, "-screen", "0", f"{W}x{H}x24", "-nolisten", "tcp"], env=os.environ.copy())
        for _ in range(100):
            if os.path.exists(f"/tmp/.X11-unix/X{self.display[1:]}"):
                break
            time.sleep(0.05)
        # a plain backdrop so the clip reads like a desktop
        subprocess.run(["xsetroot", "-solid", "#3b4250"], env=self.env())
        tray = os.environ.get("STALONETRAY") or shutil.which("stalonetray")
        self.spawn("tray", [tray, "--geometry", "5x1-0+0", "--icon-size", "40", "--kludges", "force_icons_size",
                            "-bg", "#232731", "--window-strut", "none", "--grow-gravity", "E", "--icon-gravity", "E"])
        hook = self.out / "open-url"
        hook.write_text(f"#!/bin/sh\necho \"$1\" >> '{self.out / 'opened.txt'}'\n")
        hook.chmod(0o700)
        self.opened = self.out / "opened.txt"

    def record(self, name: str):
        self.video = self.out / f"{name}.mp4"
        self.spawn("ffmpeg", ["ffmpeg", "-loglevel", "error", "-y", "-f", "x11grab", "-video_size", f"{W}x{H}", "-framerate", "20",
                              "-i", self.display, "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p",
                              str(self.video)], env=self.env(), stdin=subprocess.PIPE)
        self.step("recording started", video=self.video.name)

    def stop_record(self):
        p = self.procs.pop("ffmpeg", None)
        if p:
            p.stdin.write(b"q")
            p.stdin.close()
            p.wait(timeout=30)

    def start_app(self):
        env = self.env(FOLDER_SYNC_SERVER=SITE, FOLDER_SYNC_RCLONE=str(REPO / ".tools" / "rclone"),
                       FOLDER_SYNC_DESKTOP_OPEN_URL=str(self.out / "open-url"), APPIMAGE_EXTRACT_AND_RUN="1",
                       FOLDER_SYNC_TRACE=str(self.home / "trace.jsonl"))
        self.spawn("app", [str(self.app)], env=env)
        until = time.time() + 60
        wid = ""
        while time.time() < until and not wid:
            wid = self.x("search", "--onlyvisible", "--name", "^folder-sync$").split("\n")[0]
            time.sleep(0.3)
        if not wid:
            raise SystemExit("the app window never showed")
        self.app_wid = wid
        self.x("windowmove", wid, str(APP_POS[0]), str(APP_POS[1]))
        time.sleep(1.0)
        self.step("app window", wid=wid)

    def tray_icon_at(self):
        # stalonetray grows from the right edge (east gravity): the app's icon is its rightmost slot
        return (W - 24, 22)

    def tray_menu(self, name: str, keep_open=False):
        """Open the tray menu, screenshot it (and the tray), close it."""
        self.click(*self.tray_icon_at())
        time.sleep(0.9)
        path = self.shot(f"tray-{name}", region=(W - 520, 0, 520, 420))
        self.result["states"][name] = {"shot": path.name, "t": round(time.time() - self.t0, 2)}
        if not keep_open:
            self.x("key", "Escape")
            time.sleep(0.4)
        return path

    def tray_choose(self, downs: int):
        """Open the menu and pick the n-th enabled item by keyboard (GTK skips disabled ones)."""
        self.click(*self.tray_icon_at())
        time.sleep(0.8)
        self.x("key", "--delay", "120", *(["Down"] * downs), "Return")
        time.sleep(0.5)

    # ---------------------------------------------------------------- the browser (a stand-in for the system one)
    def browser(self, pw):
        self.chrome = pw.chromium.launch(headless=False, env=self.env(), args=[
            f"--window-position={BROWSER_POS[0]},{BROWSER_POS[1]}", f"--window-size={W - BROWSER_POS[0] - 16},{H - 40}",
            "--no-first-run", "--no-default-browser-check", "--disable-features=Translate"])
        self.ctx = self.chrome.new_context(no_viewport=True)
        self.page = self.ctx.new_page()
        self.page.set_content("<body style='font:15px system-ui;color:#555;display:grid;place-items:center;height:90vh'>"
                              "<p>The system browser opens here.</p></body>")

    def wait_opened(self, timeout=30) -> str:
        until = time.time() + timeout
        while time.time() < until:
            if self.opened.exists() and self.opened.read_text().strip():
                url = self.opened.read_text().strip().splitlines()[-1]
                self.opened.write_text("")
                return url
            time.sleep(0.1)
        raise SystemExit("the app never opened a URL")

    def approve_in_browser(self, url: str, email: str):
        p = self.page
        p.goto(url)
        p.wait_for_selector('[data-testid="fs-signin-email"]', timeout=20000)
        p.type('[data-testid="fs-signin-email"]', email, delay=35)
        p.click('[data-testid="fs-signin-send"]')
        p.wait_for_selector('[data-testid="fs-signin-code"]', state="visible", timeout=20000)
        code = json.loads(urllib.request.urlopen(f"{SITE}/fs/dev/mailbox?email={email}", timeout=10).read())["code"]
        p.type('[data-testid="fs-signin-code"]', code, delay=60)
        p.click('[data-testid="fs-signin-verify"]')
        p.wait_for_selector('[data-testid="fs-device-approve"]', timeout=20000)
        time.sleep(0.8)
        p.click('[data-testid="fs-device-approve"]')
        p.wait_for_selector('[data-testid="fs-device-done"]', timeout=20000)
        self.step("approved in the browser")

    # ---------------------------------------------------------------- checks
    def token_on_disk(self) -> list[str]:
        """Files under the scratch HOME holding the session token in plain text (must be none)."""
        tokens = []
        for line in (self.out / "logs" / "tokens.txt").read_text().splitlines() if (self.out / "logs" / "tokens.txt").exists() else []:
            tokens.append(line.strip())
        hits = []
        for root in (self.home,):
            for path in root.rglob("*"):
                if path.is_file() and path.stat().st_size < 50_000_000:
                    data = path.read_bytes()
                    for t in tokens:
                        if t and t.encode() in data:
                            hits.append(str(path))
        return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", required=True, type=pathlib.Path)
    ap.add_argument("--out", required=True, type=pathlib.Path)
    ap.add_argument("--display", type=int, default=0)
    args = ap.parse_args()
    if os.environ.get("FS_PROOF_INNER") != "1":
        # a private session bus for the keyring, the tray and the app; nothing reaches the person's own session
        os.environ["FS_PROOF_INNER"] = "1"
        # WHY a scratch runtime dir before the bus starts: services the bus activates (portals, gvfs) inherit the
        # bus's environment, and must never reach the person's own /run/user/<uid>
        # WHY /tmp and a short name: unix sockets (the keyring's control socket, the bus) are capped at 108 bytes, and
        # a scratch path is longer; bind() then fails as "Address already in use" and the keychain silently never works
        runtime = tempfile.mkdtemp(prefix="fsd-run-", dir="/tmp")
        os.environ["XDG_RUNTIME_DIR"] = runtime
        os.environ["GIO_USE_VFS"] = "local"
        os.environ["GTK_USE_PORTAL"] = "0"
        # WHY a child and not exec: services the bus activated (the document portal) recreate files in the runtime dir
        # until dbus-run-session itself has exited, so only this outer process can remove it for good
        try:
            code = subprocess.run(["dbus-run-session", "--", sys.executable, *sys.argv]).returncode
        finally:
            # the private bus's document portal may still have <runtime>/doc mounted for a moment after the bus exits
            for _ in range(40):
                shutil.rmtree(runtime, ignore_errors=True)
                if not os.path.exists(runtime):
                    break
                time.sleep(0.25)
            else:
                print(f"note: could not remove {runtime}", file=sys.stderr)
        sys.exit(code)
    display = args.display or next(n for n in range(140, 200) if not os.path.exists(f"/tmp/.X11-unix/X{n}"))
    out = args.out.resolve()
    marker = out / ".proof_linux"
    if out.exists():
        # WHY the marker: scratch dirs are shared with other sessions; only ever delete a dir this script made
        if not marker.exists():
            raise SystemExit(f"{out} exists and was not made by this script: pick another --out")
        shutil.rmtree(out)
    out.mkdir(parents=True)
    marker.write_text("made by app/scripts/proof_linux.py\n")
    proof = Proof(args.app.resolve(), out, display)
    from playwright.sync_api import sync_playwright
    try:
        (out / "logs").mkdir(exist_ok=True)
        proof.step("stack up")
        proof.demo("up", QUOTA_BYTES="4000000", QUOTA_RECHECK_S="1", SYNC_CREDENTIAL_TTL_S="30")
        rec = json.loads((out / "demo" / "demo.json").read_text())
        email = rec["email"]
        proof.desktop()
        with sync_playwright() as pw:
            proof.browser(pw)
            proof.record("hero-raw")
            proof.start_app()
            time.sleep(1.5)
            proof.tray_menu("signed-out")
            proof.shot("window-signed-out", region=proof.app_region())

            # 1. sign in: one click; the browser does the rest
            proof.click_primary("Sign in")
            url = proof.wait_opened()
            proof.step("browser opened", url=url)
            proof.wait_status("Signing in")
            proof.shot("window-signing-in", region=proof.app_region())
            proof.tray_menu("signing-in")
            proof.approve_in_browser(url, email)
            proof.wait_status("choose your folder")
            proof.step("signed in (keychain)")
            proof.shot("window-needs-folder", region=proof.app_region())

            # 2. the folder makes itself
            proof.click_primary("Create ~/robotparts")
            proof.wait_status("Synced", timeout=90)
            folder = proof.home / "robotparts"
            proof.step("folder synced", exists=folder.is_dir(), config=(folder / ".folder-sync.toml").exists())
            proof.shot("window-synced", region=proof.app_region())

            # 3. the robotparts page, signed in as the same person (the browser's own cookie)
            proof.page.goto(f"{SITE}/saved/")
            proof.page.wait_for_function("!!document.querySelector('#saved-root h2#parts')", timeout=30000)
            proof.page.evaluate("""() => { window.__seen = {}; const root = document.getElementById('saved-root');
              const check = () => { for (const row of root.querySelectorAll('[data-saved-part]')) { const id = row.getAttribute('data-saved-part');
                if (id && !window.__seen[id]) window.__seen[id] = Date.now(); } };
              new MutationObserver(check).observe(root, { childList: true, subtree: true }); check(); }""")
            time.sleep(2.0)
            trials = []
            for n in range(6):
                part = PART if n == 0 else f"{PART}-proof{n}"
                body = json.dumps({"part": part, "saved": True, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}) + "\n"
                target = folder / "saved" / f"{part.split('/')[-1]}.json"
                target.parent.mkdir(parents=True, exist_ok=True)
                written = time.time() * 1000
                target.write_text(body)
                seen = None
                until = time.time() + 20
                while time.time() < until:
                    seen = proof.page.evaluate(f"window.__seen[{json.dumps(part)}] || null")
                    if seen:
                        break
                    time.sleep(0.02)
                ms = round(seen - written) if seen else None
                trials.append({"part": part, "ms": ms})
                proof.step("file → page", part=part, ms=ms)
                if n == 0:
                    time.sleep(2.5)  # the hero clip holds on the first row
                    proof.shot("hero-page-row")
                time.sleep(random.uniform(0.8, 2.0))
            proof.result["disk_to_page_ms"] = trials
            # the same moment, the same page, through the demo's own CLI machine (`folder-sync sync --watch`): the
            # baseline that says what the app adds, on a machine this loaded
            cli_folder = pathlib.Path(rec["folder"])
            baseline = []
            for n in range(6):
                part = f"cli-baseline-{n}"
                target = cli_folder / "saved" / f"{part}.json"
                target.parent.mkdir(parents=True, exist_ok=True)
                written = time.time() * 1000
                target.write_text(json.dumps({"part": part, "saved": True, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}) + "\n")
                seen = None
                until = time.time() + 20
                while time.time() < until:
                    seen = proof.page.evaluate(f"window.__seen[{json.dumps(part)}] || null")
                    if seen:
                        break
                    time.sleep(0.02)
                ms = round(seen - written) if seen else None
                baseline.append({"part": part, "ms": ms})
                proof.step("CLI file → page", part=part, ms=ms)
                time.sleep(random.uniform(0.8, 2.0))
            proof.result["cli_disk_to_page_ms"] = baseline
            try:
                proof.result["load_average"] = os.getloadavg()
            except OSError:
                pass
            proof.stop_record()

            # 4. the tray's states
            proof.tray_menu("synced")
            big = folder / "big-upload.bin"
            big.write_bytes(os.urandom(3_000_000))
            proof.wait_status("Syncing", timeout=10)
            proof.tray_menu("syncing")
            proof.wait_status("Synced", timeout=60)
            proof.tray_choose(3)  # Open folder, Open robotparts.dev, Pause sync
            proof.wait_status("Paused", timeout=20)
            proof.tray_menu("paused")
            proof.shot("window-paused", region=proof.app_region())
            proof.tray_choose(3)  # … Resume sync
            proof.wait_status("Synced", timeout=60)

            # offline: the storage stand-in goes away (its exact command is kept to bring it back)
            pid = proof.standin_pid()
            cmdline = pathlib.Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")[:-1]
            environ = dict(kv.split(b"=", 1) for kv in pathlib.Path(f"/proc/{pid}/environ").read_bytes().split(b"\0") if b"=" in kv)
            cwd = os.readlink(f"/proc/{pid}/cwd")
            os.kill(pid, signal.SIGTERM)
            time.sleep(1.0)
            (folder / "saved" / "while-offline.json").write_text('{"part":"while-offline","saved":true}\n')
            proof.wait_status("Offline", timeout=60)
            proof.tray_menu("offline")
            proof.shot("window-offline", region=proof.app_region())
            restarted = subprocess.Popen([c.decode() for c in cmdline], cwd=cwd, env={k.decode(): v.decode() for k, v in environ.items()},
                                         stdout=open(out / "logs" / "standin-restarted.log", "ab"), stderr=subprocess.STDOUT, start_new_session=True)
            proof.procs["standin-restarted"] = restarted
            time.sleep(2.0)
            (folder / "saved" / "back-online.json").write_text('{"part":"back-online","saved":true}\n')
            proof.wait_status("Synced", timeout=90)
            proof.step("back online")

            # over quota: past 4 MB (the stack's QUOTA_BYTES), the next keys are refused with the server's reason
            (folder / "over-quota.bin").write_bytes(os.urandom(2_500_000))
            until = time.time() + 120
            while time.time() < until:
                try:
                    proof.wait_status("Over quota", timeout=6)
                    break
                except SystemExit:
                    (folder / "saved" / "nudge.json").write_text(json.dumps({"part": "nudge", "at": time.time()}) + "\n")
            proof.wait_status("Over quota", timeout=1)
            proof.tray_menu("over-quota")
            proof.shot("window-over-quota", region=proof.app_region())

            # sign out: the server session ends and the keychain forgets it
            settings = proof.settings()
            proof.step("settings.json keys", keys=sorted(settings))
            # the token itself, read back from the keychain only to check that no file on disk holds it
            doc = subprocess.run([str(proof.app), "--account-process"], env=proof.env(APPIMAGE_EXTRACT_AND_RUN="1", FOLDER_SYNC_SERVER=SITE), capture_output=True, text=True)
            token = json.loads(doc.stdout)["token"] if doc.returncode == 0 else ""
            proof.result["keychain_has_session"] = bool(token)
            (out / "logs" / "tokens.txt").write_text(token + "\n")
            proof.result["token_files_on_disk"] = proof.token_on_disk()
            (out / "logs" / "tokens.txt").unlink()
            n_items = 4 + 3  # Open folder, Open site, Pause, Change folder…, Show window, Start at login, Sign out
            proof.tray_choose(n_items)
            proof.wait_status("Signed out", timeout=30)
            proof.tray_menu("signed-out-after")
            proof.shot("window-signed-out-after", region=proof.app_region())
            after = subprocess.run([str(proof.app), "--account-process"], env=proof.env(APPIMAGE_EXTRACT_AND_RUN="1", FOLDER_SYNC_SERVER=SITE), capture_output=True, text=True)
            proof.result["account_process_after_sign_out_exit"] = after.returncode
            # the server no longer accepts the old token
            req = urllib.request.Request(f"{SITE}/fs/v1/me", headers={"Authorization": f"Bearer {token}"})
            try:
                status = urllib.request.urlopen(req, timeout=10).status
            except urllib.error.HTTPError as e:
                status = e.code
            proof.result["old_token_after_sign_out"] = status
            autostart = proof.home / ".config" / "autostart"
            proof.result["autostart_entries"] = sorted(p.name for p in autostart.glob("*.desktop")) if autostart.exists() else []
            proof.chrome.close()
    finally:
        proof.result["engine_log_tail"] = proof.engine_log().splitlines()[-40:]
        # the app first (so its engine finishes), then everything else this run started
        try:
            subprocess.run(["xdotool", "key", "Escape"], env=proof.env(), capture_output=True)
        except Exception:
            pass
        proof.stop_record()
        for name in ["app", "standin-restarted", "tray", "keyring", "xvfb"]:
            proof.stop(name)
        for name in list(proof.procs):
            proof.stop(name)
        try:
            proof.demo("down")
        except SystemExit as e:
            log("demo down:", e)
        (out / "proof.json").write_text(json.dumps(proof.result, indent=1))
        log("wrote", out / "proof.json")


if __name__ == "__main__":
    main()
