#!/usr/bin/env python3
"""The off-the-shelf competitors' side of the Fast Folder Sync bench (bench/fast/CONTRACT.md, PEP 0008).

Runs Syncthing, Unison, Mutagen, rclone bisync and lsyncd as two "hosts" on this machine (separate HOMEs, separate
process trees, each in its own `systemd-run --user --scope`), reaching each other and the store only through
bench/fast/tcpproxy.mjs, and writes fast-folder-sync-trial/1, -idle/1 and -ops/1 rows to
bench/fast/results/raw/<run_id>{,.idle,.ops}.jsonl.

    python3 bench/fast/competitors/bench_competitors.py run --tool syncthing [--variants default,tuned]
        [--config k=v,...] [--directions m2m,offline] [--workloads 1k,100k,10m,200m,many100,storm]
        [--faults drop,sleep] [--trials N] [--run-id ID] [--idle-s 120]
    python3 bench/fast/competitors/bench_competitors.py check     # leftovers: our processes, ports 5200-5239

Tools come from bench/fast/competitors/.tools/ (fetch_tools.sh). Python 3 standard library only.
"""
import argparse
import atexit
import copy
import datetime
import hashlib
import hmac
import json
import os
import random
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
FAST = HERE.parent
REPO = FAST.parent.parent
TOOLS = HERE / ".tools"
RAW = FAST / "results" / "raw"
TCPPROXY = FAST / "tcpproxy.mjs"
LOOP = HERE / "bisync_loop.py"

SYNCTHING = TOOLS / "syncthing-v2.1.7" / "syncthing"
UNISON_BIN = TOOLS / "unison-v2.54.0" / "unison-2.54.0-ubuntu-22.04-x86_64-static" / "bin"
MUTAGEN = TOOLS / "mutagen-v0.18.1" / "mutagen"
LSYNCD_ROOT = TOOLS / "lsyncd-2.2.3-1" / "root"
RCLONE = next((p for p in (REPO / ".tools" / "rclone", Path("/home/bam/folder-sync/.tools/rclone")) if p.exists()), None)

# CONTRACT.md: the competitors' harness owns 127.0.0.1:5200-5239; 4950-4953, 4973 and 5100-5139 are someone else's.
PORTS = range(5200, 5240)
DIRECTIONS = ["m2m", "m2w", "w2m", "m2a", "offline"]
WORKLOADS = ["1k", "100k", "10m", "200m", "many100", "storm"]
FAULTS = ["drop", "sleep"]
BIG_ONLY = {"m2m", "m2w", "w2m"}  # CONTRACT.md: 200m is m2m, m2w and w2m only
# CONTRACT.md: the offline faults write 10 x 1 KB files; the row says workload "1k", as bench/fast/fs_bench.mjs does.
OFFLINE_WORKLOAD = "1k"
TIMEOUT_S = {"1k": 90, "100k": 90, "10m": 150, "200m": 600, "many100": 150, "storm": 90}
OFFLINE_TIMEOUT_S = int(os.environ.get("FSBENCH_OFFLINE_TIMEOUT_S", 180))
DISK_POLL_S = 0.010
WEB_POLL_S = 0.025
CUT_S = 20.0


def now_iso():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def load1():
    return float(Path("/proc/loadavg").read_text().split()[0])


def log(*parts):
    print(f"[{time.strftime('%H:%M:%S')}]", *parts, file=sys.stderr, flush=True)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


# --- process bookkeeping ---------------------------------------------------------------------------------------------


class Proc:
    def __init__(self, name, popen, unit):
        self.name, self.popen, self.unit, self.pid = name, popen, unit, popen.pid
        self.cgroup = None
        if unit:
            for _ in range(100):
                cg = subprocess.run(["systemctl", "--user", "show", "-p", "ControlGroup", "--value", f"{unit}.scope"],
                                    capture_output=True, text=True).stdout.strip()
                if cg:
                    self.cgroup = Path("/sys/fs/cgroup") / cg.lstrip("/")
                    break
                time.sleep(0.02)

    def pids(self):
        pids = set()
        if self.cgroup and (self.cgroup / "cgroup.procs").exists():
            try:
                pids |= {int(x) for x in (self.cgroup / "cgroup.procs").read_text().split()}
            except OSError:
                pass
        if self.popen.poll() is None:
            pids.add(self.pid)
        return pids

    def alive(self):
        return self.popen.poll() is None

    def cpu_usec(self):
        try:
            for line in (self.cgroup / "cpu.stat").read_text().splitlines():
                if line.startswith("usage_usec "):
                    return int(line.split()[1])
        except (OSError, TypeError):
            pass
        return None


class Procs:
    """Every process this run starts, so each one is stopped by the PID recorded here (atexit, signals, finally)."""

    def __init__(self):
        self.items = []
        self.lock = threading.Lock()

    def spawn(self, name, cmd, env, log_path, unit=None, mem="4G", cwd=None, stdout=None):
        if unit:
            cmd = ["systemd-run", "--user", "--scope", "--quiet", "--collect", "--unit", unit, "-p", f"MemoryMax={mem}", "--"] + cmd
        out = open(log_path, "ab")
        popen = subprocess.Popen(cmd, env=env, cwd=cwd, stdin=subprocess.DEVNULL, stdout=stdout or out, stderr=out,
                                 start_new_session=True)
        out.close()
        proc = Proc(name, popen, unit)
        with self.lock:
            self.items.append(proc)
        return proc

    def stop(self, proc, grace=8.0):
        pids = proc.pids()
        for pid in pids:
            try:
                os.kill(pid, signal.SIGCONT)
            except ProcessLookupError:
                pass
        if proc.alive():
            try:
                os.kill(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                proc.popen.wait(grace)
            except subprocess.TimeoutExpired:
                pass
        # Children left in this run's own scope (fsmonitor, rclone runs) are ours by construction.
        for pid in proc.pids() | ({proc.pid} if proc.alive() else set()):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            proc.popen.wait(5)
        except subprocess.TimeoutExpired:
            pass
        with self.lock:
            if proc in self.items:
                self.items.remove(proc)

    def stop_all(self):
        for proc in reversed(list(self.items)):
            try:
                self.stop(proc, grace=5.0)
            except Exception as exc:  # cleanup keeps going
                log("stop failed", proc.name, exc)


class Ports:
    def __init__(self):
        self.used = set()

    def take(self):
        for port in PORTS:
            if port in self.used:
                continue
            with socket.socket() as s:
                try:
                    s.bind(("127.0.0.1", port))
                except OSError:
                    continue
            self.used.add(port)
            return port
        raise RuntimeError("no free port left in 127.0.0.1:5200-5239")


class Proxy:
    """One bench/fast/tcpproxy.mjs: counts bytes and can cut a host off (the `drop` fault)."""

    def __init__(self, run, name, target_port):
        self.name = name
        self.listen, self.control = run.ports.take(), run.ports.take()
        self.proc = run.procs.spawn(f"proxy-{name}", ["node", str(TCPPROXY), "--listen", str(self.listen), "--target",
                                                      f"127.0.0.1:{target_port}", "--control", str(self.control)],
                                    os.environ.copy(), run.scratch / f"proxy-{name}.log", stdout=subprocess.PIPE)
        line = self.proc.popen.stdout.readline()
        if not line:
            raise RuntimeError(f"tcpproxy {name} did not start; see {run.scratch / f'proxy-{name}.log'}")
        info = json.loads(line)
        if info["pid"] != self.proc.pid:
            raise RuntimeError(f"tcpproxy {name} reported pid {info['pid']}, started {self.proc.pid}")

    def call(self, method, path):
        req = urllib.request.Request(f"http://127.0.0.1:{self.control}{path}", method=method)
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read())

    def stats(self):
        return self.call("GET", "/stats")

    def bytes(self):
        s = self.stats()
        return s["bytes_in"] + s["bytes_out"]

    def cut(self):
        self.call("POST", "/cut")

    def restore(self):
        self.call("POST", "/restore")


class Host:
    """One bench host: a HOME, a synced folder (maybe none), and the processes of its own systemd scope."""

    def __init__(self, run, name, folder=True):
        self.run, self.name = run, name
        self.root = run.scratch / name
        self.home = self.root / "home"
        self.folder = self.root / "folder" if folder else None
        self.tmp = self.root / "tmp"  # write-then-rename stages here, outside the synced folder, on the same filesystem
        for d in (self.home, self.tmp) + ((self.folder,) if folder else ()):
            d.mkdir(parents=True, exist_ok=True)
        self.procs = []
        self.extra_ctx = []  # callables returning context switches of exited children (bisync_loop's rusage)
        self.stopped = False

    @property
    def unit(self):
        return f"fsbench-{self.run.slug}-{self.run.tool_name}-{self.name.lower()}"

    def env(self, **extra):
        env = {
            "HOME": str(self.home), "XDG_CONFIG_HOME": str(self.home / ".config"), "XDG_DATA_HOME": str(self.home / ".local/share"),
            "XDG_CACHE_HOME": str(self.home / ".cache"), "XDG_STATE_HOME": str(self.home / ".local/state"),
            "TMPDIR": str(self.tmp), "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
        }
        if "XDG_RUNTIME_DIR" in os.environ:  # systemd-run --user finds the user manager through it
            env["XDG_RUNTIME_DIR"] = os.environ["XDG_RUNTIME_DIR"]
        if "DBUS_SESSION_BUS_ADDRESS" in os.environ:
            env["DBUS_SESSION_BUS_ADDRESS"] = os.environ["DBUS_SESSION_BUS_ADDRESS"]
        env.update({k: str(v) for k, v in extra.items()})
        return env

    def spawn(self, name, cmd, env, mem="4G", cwd=None):
        unit = self.unit if not self.procs else f"{self.unit}-{len(self.procs)}"
        proc = self.run.procs.spawn(f"{self.name}-{name}", cmd, env, self.root / f"{name}.log", unit=unit, mem=mem, cwd=cwd)
        self.procs.append(proc)
        return proc

    def pids(self):
        out = set()
        for p in self.procs:
            out |= p.pids()
        return out

    def cpu_usec(self):
        vals = [p.cpu_usec() for p in self.procs]
        return sum(v for v in vals if v is not None) if any(v is not None for v in vals) else None

    def ctx_switches(self):
        total = 0
        for pid in self.pids():
            for task in Path(f"/proc/{pid}/task").glob("*"):
                try:
                    for line in (task / "status").read_text().splitlines():
                        if line.startswith(("voluntary_ctxt_switches", "nonvoluntary_ctxt_switches")):
                            total += int(line.split()[1])
                except OSError:
                    pass
        return total + sum(f() for f in self.extra_ctx)

    def sigstop(self):
        for pid in self.pids():
            try:
                os.kill(pid, signal.SIGSTOP)
            except ProcessLookupError:
                pass
        self.stopped = True

    def sigcont(self):
        for pid in self.pids():
            try:
                os.kill(pid, signal.SIGCONT)
            except ProcessLookupError:
                pass
        self.stopped = False


def write_atomic(host, rel, data):
    """As an editor saves: write a temp file outside the synced folder, then rename it into place."""
    dest = host.folder / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = host.tmp / f".{rel.replace('/', '_')}.{os.getpid()}.{random.getrandbits(32):08x}"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, dest)


class DiskProbe:
    """sha256 of a file on a host's disk, re-hashed only when its inode, size or times change."""

    def __init__(self, folder):
        self.folder, self.cache = folder, {}

    def __call__(self, rel):
        path = self.folder / rel
        try:
            st = os.stat(path)
        except FileNotFoundError:
            return None
        key = (st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
        hit = self.cache.get(rel)
        if hit and hit[0] == key:
            return hit[1]
        try:
            with open(path, "rb") as f:
                digest = hashlib.file_digest(f, "sha256").hexdigest()
        except FileNotFoundError:
            return None
        self.cache[rel] = (key, digest)
        return digest


class Watch(threading.Thread):
    """Polls a reader until it holds every expected sha256; records when each one first matched."""

    def __init__(self, probe, expected, interval):
        super().__init__(daemon=True)
        self.probe, self.expected, self.interval = probe, dict(expected), interval
        self.hits, self.done, self.halt = {}, threading.Event(), threading.Event()
        self.errors = 0

    def run(self):
        while not self.halt.is_set():
            for rel, want in list(self.expected.items()):
                if rel in self.hits:
                    continue
                try:
                    got = self.probe(rel)
                except Exception:
                    self.errors += 1
                    got = None
                if got == want:
                    self.hits[rel] = time.perf_counter()
            if len(self.hits) == len(self.expected):
                self.done.set()
                return
            self.halt.wait(self.interval)

    def stop(self):
        self.halt.set()
        self.join(30)


# --- S3 (rclone serve s3): SigV4 presigning in the standard library --------------------------------------------------


def presign(method, host, path, access_key, secret_key, region="us-east-1", expires=3600):
    t = datetime.datetime.now(datetime.timezone.utc)
    amz_date, day = t.strftime("%Y%m%dT%H%M%SZ"), t.strftime("%Y%m%d")
    scope = f"{day}/{region}/s3/aws4_request"
    query = {"X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": f"{access_key}/{scope}", "X-Amz-Date": amz_date,
             "X-Amz-Expires": str(expires), "X-Amz-SignedHeaders": "host"}
    q = "&".join(f"{urllib.parse.quote(k, safe='-_.~')}={urllib.parse.quote(v, safe='-_.~')}" for k, v in sorted(query.items()))
    uri = urllib.parse.quote(path, safe="/-_.~")
    canonical = f"{method}\n{uri}\n{q}\nhost:{host}\n\nhost\nUNSIGNED-PAYLOAD"
    to_sign = f"AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{sha256(canonical.encode())}"
    key = ("AWS4" + secret_key).encode()
    for part in (day, region, "s3", "aws4_request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    return f"http://{host}{uri}?{q}&X-Amz-Signature={signature}"


# --- the tools -------------------------------------------------------------------------------------------------------

CONFLICT_RE = {
    "syncthing": re.compile(r"\.sync-conflict-"),
    "rclone-bisync": re.compile(r"\.conflict\d*|\.\.path[12]"),
}


def scan_conflicts(folders, pattern):
    """Distinct conflict copies by path relative to each root, so one copy synced to every replica counts once."""
    seen = set()
    for folder in folders:
        for dirpath, _, files in os.walk(folder):
            for f in files:
                if pattern.search(f):
                    seen.add(os.path.relpath(os.path.join(dirpath, f), folder))
    return len(seen)


class Tool:
    name = ""
    presets = {"default": {}}
    directions = {"m2m", "offline"}
    faults = {"drop", "sleep"}
    na = {
        "m2w": "no web or bucket copy: the tool syncs disk to disk only",
        "w2m": "no web or bucket copy: the tool syncs disk to disk only",
        "m2a": "no web or bucket copy: an agent without the daemon has nothing to read",
    }
    p2p = True  # no cloud store: class_a = class_b = 0

    def __init__(self, run, variant, config):
        self.run, self.variant, self.config = run, variant, config
        self.applied = dict(config)
        self.proxies = []
        self.notes = []

    # Hosts the idle row averages over; the writer A and the reader B.
    hosts = ()
    A = B = None

    def phase_max(self):
        return 2.2  # watcher tools: 0.2-2.2 s (CONTRACT.md: one polling interval + 0.2 s)

    def start(self):
        raise NotImplementedError

    def health(self):
        dead = [p.name for h in self.hosts for p in h.procs if not p.alive()]
        return f"process exited: {', '.join(dead)}" if dead else None

    def cut_b(self):
        raise NotImplementedError

    def restore_b(self):
        raise NotImplementedError

    def sleep_b(self):
        self.B.sigstop()

    def wake_b(self):
        self.B.sigcont()

    def conflicts(self):
        return 0

    def host_net_bytes(self, host):
        """Bytes through the proxies that carry this host's traffic (both ways)."""
        return sum(p.bytes() for p in self.proxies)

    def requests(self):
        return None

    def fault_na(self, fault):
        return None

    def revive(self):
        return None

    def quiesce_s(self):
        """How long after the canary until nothing the setup did is still queued inside the tool."""
        return 2.0

    def fault_note(self, fault):
        if fault == "drop":
            return f"cut: {self.cut_what} for 20 s; A wrote one file every 2 s"
        return f"SIGSTOP of {self.sleep_what} for 20 s, then SIGCONT; A wrote one file every 2 s"

    cut_what = "B's proxy"
    sleep_what = "every process in B's scope"


class Syncthing(Tool):
    name = "syncthing"
    # WHY two variants: Syncthing's documented fsWatcherDelayS default is 10 s, which dominates any latency number;
    # "tuned" is the smallest delay a user can set, rescanIntervalS left at its default.
    presets = {"default": {}, "tuned": {"fsWatcherDelayS": 1}}
    cut_what = "both proxies (A dials B through B's, B dials A through A's), so B has no path to A"

    def start(self):
        run = self.run
        self.A, self.B = Host(run, "A"), Host(run, "B")
        self.hosts = (self.A, self.B)
        listen = {h.name: run.ports.take() for h in self.hosts}
        proxy = {h.name: Proxy(run, f"st-{h.name.lower()}", listen[h.name]) for h in self.hosts}
        self.proxies = list(proxy.values())
        self.proxy = proxy
        gui = {h.name: run.ports.take() for h in self.hosts}
        self.apikey = {h.name: f"fsbench{random.getrandbits(128):032x}" for h in self.hosts}
        ids = {}
        for h in self.hosts:
            h.st_home = h.home / "syncthing"
            env = h.env(STNOUPGRADE=1)
            subprocess.run([str(SYNCTHING), "generate", f"--home={h.st_home}", "--no-port-probing"], env=env, check=True,
                           capture_output=True)
            ids[h.name] = subprocess.run([str(SYNCTHING), "device-id", f"--home={h.st_home}"], env=env, check=True,
                                         capture_output=True, text=True).stdout.strip()
            (h.folder / ".stfolder").mkdir(exist_ok=True)
        self.ids = ids
        folder_cfg = {"fsWatcherDelayS": 10, "rescanIntervalS": 3600, "fsWatcherEnabled": "true"}
        folder_cfg.update(self.config)
        self.applied = dict(folder_cfg)
        for h in self.hosts:
            peer = self.B if h is self.A else self.A
            self._configure(h, listen[h.name], gui[h.name], ids[h.name], ids[peer.name], proxy[peer.name].listen, folder_cfg)
        for h in self.hosts:
            h.gui = gui[h.name]
            h.spawn("syncthing", [str(SYNCTHING), "serve", f"--home={h.st_home}", "--no-browser", "--no-restart",
                                  "--no-upgrade", f"--gui-address=http://127.0.0.1:{gui[h.name]}",
                                  f"--gui-apikey={self.apikey[h.name]}"], h.env(STNOUPGRADE=1))
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                if all(self._connected(h) for h in self.hosts):
                    break
            except (urllib.error.URLError, OSError, KeyError, ValueError):
                pass
            time.sleep(0.25)
        else:
            raise RuntimeError("syncthing devices did not connect within 60 s")
        cfg = self.rest(self.A, "GET", "/rest/config/folders/bench")
        self.applied = {k: cfg[k] for k in ("fsWatcherEnabled", "fsWatcherDelayS", "rescanIntervalS", "pullerDelayS") if k in cfg}
        self.applied["reconnectionIntervalS"] = self.rest(self.A, "GET", "/rest/config/options")["reconnectionIntervalS"]

    def _configure(self, h, listen, gui, own_id, peer_id, peer_port, folder_cfg):
        path = h.st_home / "config.xml"
        tree = ET.parse(path)
        root = tree.getroot()
        opts = root.find("options")
        settings = {
            "listenAddress": f"tcp://127.0.0.1:{listen}", "globalAnnounceEnabled": "false", "localAnnounceEnabled": "false",
            "relaysEnabled": "false", "natEnabled": "false", "urAccepted": "-1", "crashReportingEnabled": "false",
            "autoUpgradeIntervalH": "0", "startBrowser": "false", "announceLANAddresses": "false",
        }
        for key, value in settings.items():
            node = opts.find(key)
            if node is None:
                node = ET.SubElement(opts, key)
            node.text = value
        g = root.find("gui")
        g.find("address").text = f"127.0.0.1:{gui}"
        g.find("apikey").text = self.apikey[h.name]
        own = next(d for d in root.findall("device") if d.get("id") == own_id)
        own.set("name", h.name)
        peer = copy.deepcopy(own)
        peer.set("id", peer_id)
        peer.set("name", "B" if h.name == "A" else "A")
        peer.find("address").text = f"tcp://127.0.0.1:{peer_port}"
        root.insert(list(root).index(own) + 1, peer)
        folder = copy.deepcopy(root.find("defaults/folder"))
        folder.set("id", "bench")
        folder.set("label", "bench")
        folder.set("path", str(h.folder))
        for key, value in folder_cfg.items():
            folder.set(key, str(value))
        for d in folder.findall("device"):
            folder.remove(d)
        for dev_id in (own_id, peer_id):
            d = ET.Element("device", {"id": dev_id, "introducedBy": ""})
            ET.SubElement(d, "encryptionPassword")
            folder.insert(0, d)
        root.insert(0, folder)
        tree.write(path)

    def rest(self, h, method, path, body=None):
        req = urllib.request.Request(f"http://127.0.0.1:{h.gui}{path}", method=method,
                                     headers={"X-API-Key": self.apikey[h.name], "Content-Type": "application/json"},
                                     data=json.dumps(body).encode() if body is not None else None)
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None

    def _connected(self, h):
        peer = self.B if h is self.A else self.A
        return self.rest(h, "GET", "/rest/system/connections")["connections"][self.ids[peer.name]]["connected"]

    def cut_b(self):
        for p in self.proxies:  # every path to or from B: A dials B through B's proxy and B dials A through A's
            p.cut()

    def restore_b(self):
        for p in self.proxies:
            p.restore()

    def conflicts(self):
        return scan_conflicts([self.A.folder, self.B.folder], CONFLICT_RE["syncthing"])


class Unison(Tool):
    name = "unison"
    # WHY "supervised": a bare `unison -repeat watch` client exits on "Lost connection with the server" and never
    # reconnects, so the way people run it is under a restarting supervisor (systemd Restart=always); restart_s=1 is that.
    presets = {"default": {}, "supervised": {"restart_s": 1}}
    cut_what = "B's proxy (the client on A reaches the server on B only through it)"
    sleep_what = "the unison server on B and its fsmonitor"

    def start(self):
        run = self.run
        self.A, self.B = Host(run, "A"), Host(run, "B")
        self.hosts = (self.A, self.B)
        port = run.ports.take()
        self.proxies = [Proxy(run, "unison-b", port)]
        self.path = f"{UNISON_BIN}:/usr/bin:/bin"  # unison-fsmonitor from the same release, on both sides
        self.B.spawn("unison-server", [str(UNISON_BIN / "unison"), "-socket", str(port), "-listen", "127.0.0.1"],
                     self.B.env(UNISON=self.B.home / ".unison", PATH=self.path))
        for _ in range(100):
            with socket.socket() as s:
                if s.connect_ex(("127.0.0.1", port)) == 0:
                    break
            time.sleep(0.05)
        self.client_log = self.A.root / "unison-actions.log"  # -logfile; stdout goes to unison-client.log
        self._client()
        self.applied = {"repeat": "watch", "client": "A", "server": "B (unison -socket)", "batch": True,
                        "restart_s": self.config.get("restart_s")}

    def _client(self):
        # WHY the client runs on A: Unison is client/server and one side must drive; the writer drives here.
        cmd = [str(UNISON_BIN / "unison"), str(self.A.folder), f"socket://127.0.0.1:{self.proxies[0].listen}/{self.B.folder}",
               "-batch", "-auto", "-repeat", "watch", "-ui", "text", "-logfile", str(self.client_log), "-confirmbigdel=false"]
        if self.config.get("restart_s"):
            cmd = ["/bin/sh", "-c", f'while :; do "$@"; sleep {float(self.config["restart_s"])}; done', "unison-supervisor", *cmd]
        self.client = self.A.spawn("unison-client", cmd, self.A.env(UNISON=self.A.home / ".unison", PATH=self.path))

    def revive(self):
        """A dead bare client (it never reconnects) is restarted before the next trial, so one fault cannot void the rest."""
        if self.client.alive():
            return None
        self.run.procs.stop(self.client)
        self.A.procs.remove(self.client)
        self._client()
        time.sleep(2.0)
        return "the harness restarted the unison client, which had exited in an earlier trial"

    def health(self):
        msg = super().health()
        if msg:
            errors = []
            for path in (self.client_log, self.A.root / "unison-client.log"):
                try:
                    errors += [l for l in path.read_text(errors="replace").splitlines() if l.startswith("Error")]
                except FileNotFoundError:
                    pass
            if errors:
                msg += f" ({errors[-1].strip()}; unison has no reconnect)"
        return msg

    def cut_b(self):
        self.proxies[0].cut()

    def restore_b(self):
        self.proxies[0].restore()

    def conflicts(self):
        try:
            text = self.client_log.read_text(errors="replace")
        except FileNotFoundError:
            return 0
        return len(re.findall(r"<-\?->|[Cc]onflict", text))


class Mutagen(Tool):
    name = "mutagen"
    faults = {"sleep"}
    sleep_what = "the one mutagen daemon (it serves both endpoints)"

    def fault_na(self, fault):
        if fault == "drop":
            return "local alpha->beta session in one daemon: no network between the two folders to cut"
        return None

    def start(self):
        run = self.run
        self.M = Host(run, "M", folder=False)
        self.hosts = (self.M,)
        self.A = Host(run, "A")
        self.B = Host(run, "B")
        real = self.M.home / "mutagen-data"
        real.mkdir(parents=True)
        # WHY a short symlink: the daemon's unix socket lives in the data dir, and sun_path is 108 bytes at most.
        short = Path(os.environ.get("XDG_RUNTIME_DIR") or "/tmp")
        self.link = short / f"fsbench-mu-{os.getpid()}-{random.getrandbits(24):06x}"
        self.link.symlink_to(real)
        self.data = self.link
        # WHY MUTAGEN_DISABLE_AUTOSTART: a CLI call must never fork a daemon outside this run's scope (or into ~/.mutagen).
        self.menv = self.M.env(MUTAGEN_DATA_DIRECTORY=self.data, MUTAGEN_DISABLE_AUTOSTART=1)
        self.daemon = self.M.spawn("mutagen-daemon", [str(MUTAGEN), "daemon", "run"], self.menv)
        for _ in range(200):
            if subprocess.run([str(MUTAGEN), "sync", "list"], env=self.menv, capture_output=True).returncode == 0:
                break
            time.sleep(0.05)
        else:
            raise RuntimeError("mutagen daemon did not come up")
        extra = [f"--{k}={v}" for k, v in self.config.items()]
        subprocess.run([str(MUTAGEN), "sync", "create", "--name=bench", *extra, str(self.A.folder), str(self.B.folder)],
                       env=self.menv, check=True, capture_output=True)
        self.applied = {"mode": "two-way-safe (default)", "watch_mode": "portable (default)", **self.config}
        self.notes.append("local alpha->beta in one daemon: no network, so net bytes are null and `drop` is n/a; "
                          "`sleep` SIGSTOPs the one daemon (both endpoints)")

    def host_net_bytes(self, host):
        return None

    def sleep_b(self):
        self.M.sigstop()

    def wake_b(self):
        self.M.sigcont()

    def mcli(self, *args):
        return subprocess.run([str(MUTAGEN), *args], env=self.menv, capture_output=True, text=True, timeout=30)

    def conflicts(self):
        out = self.mcli("sync", "list", "--template", "{{ json . }}")
        try:
            sessions = json.loads(out.stdout)
        except ValueError:
            return 0
        return sum(len(s.get("conflicts") or []) for s in sessions)

    def shutdown(self):
        # WHY: terminate the session and stop the daemon through its own data dir before the PID kill.
        try:
            self.mcli("sync", "terminate", "--all")
            self.mcli("daemon", "stop")
            self.daemon.popen.wait(10)
        except Exception:
            pass
        finally:
            if getattr(self, "link", None) and self.link.is_symlink():
                self.link.unlink()


class RcloneBisync(Tool):
    name = "rclone-bisync"
    directions = {"m2m", "m2w", "w2m", "m2a", "offline"}
    p2p = False
    # WHY a loop: rclone has no watcher for bisync, so each host reruns it after a sleep; 2 s and 10 s are both measured.
    presets = {"default": {"interval_s": 2}, "interval10": {"interval_s": 10}}
    BUCKET = "bench"
    PREFIX = "folder"
    cut_what = "B's proxy to the S3 store (A keeps uploading)"
    sleep_what = "B's bisync loop and any rclone run it has in flight"

    def phase_max(self):
        return float(self.config.get("interval_s", 2)) + 0.2

    def start(self):
        run = self.run
        self.interval = float(self.config.get("interval_s", 2))
        self.store_dir = run.scratch / "store"
        (self.store_dir / self.BUCKET).mkdir(parents=True)
        self.port = run.ports.take()
        self.ak, self.sk = f"fsbench{random.getrandbits(64):016x}", f"{random.getrandbits(256):064x}"
        self.store_log = run.scratch / "store-s3.log"
        self.store = run.procs.spawn("rclone-store", [str(RCLONE), "serve", "s3", "--config", "/dev/null", "--addr",
                                                      f"127.0.0.1:{self.port}", "--auth-key", f"{self.ak},{self.sk}", "-vv",
                                                      "--log-file", str(self.store_log), str(self.store_dir)],
                                     os.environ.copy(), run.scratch / "store-stdout.log",
                                     unit=f"fsbench-{run.slug}-{run.tool_name}-store", mem="4G")
        for _ in range(200):
            with socket.socket() as s:
                if s.connect_ex(("127.0.0.1", self.port)) == 0:
                    break
            time.sleep(0.05)
        self.A, self.B = Host(run, "A"), Host(run, "B")
        self.hosts = (self.A, self.B)
        self.agent_conf = run.scratch / "agent-rclone.conf"
        self._conf(self.agent_conf, self.port)
        bisync_flags = ["--resilient", "--recover", "--max-lock", "2m", "-v"]
        self.applied = {"interval_s": self.interval, "bisync_flags": bisync_flags, "trigger": "loop (rclone has no watcher)",
                        "store": "rclone serve s3 on a local dir"}
        for i in range(20):  # seed files, so a later delete never trips bisync's default --max-delete 50%
            write_atomic(self.A, f"seed/{i:02d}.json", json.dumps({"seed": i}).encode())
        for h in self.hosts:
            px = Proxy(run, f"rclone-{h.name.lower()}", self.port)
            self.proxies.append(px)
            h.proxy = px
            h.conf = h.home / "rclone.conf"
            self._conf(h.conf, px.listen)
            h.bisync = [str(RCLONE), "--config", str(h.conf), "bisync", str(h.folder), f"s3:{self.BUCKET}/{self.PREFIX}",
                        "--workdir", str(h.home / "bisync"), *bisync_flags]
            h.loop_log = h.root / "bisync.log"
            r = subprocess.run(h.bisync + ["--resync", "--log-file", str(h.root / "resync.log")], env=h.env(),
                               capture_output=True, text=True, timeout=120)
            if r.returncode != 0:
                raise RuntimeError(f"rclone bisync --resync on {h.name} failed: {r.stderr[-500:]}")
        for h in self.hosts:
            h.stats = h.root / "loop-stats.json"
            h.spawn("bisync-loop", [sys.executable, "-I", str(LOOP), "--interval", str(self.interval), "--stats", str(h.stats),
                                    "--", *h.bisync, "--log-file", str(h.loop_log)], h.env())
            h.extra_ctx.append(lambda h=h: self._loop_ctx(h))

    @staticmethod
    def _loop_ctx(h):
        try:
            s = json.loads(h.stats.read_text())
            return s["nvcsw"] + s["nivcsw"]
        except (OSError, ValueError, KeyError):
            return 0

    def _conf(self, path, port):
        path.write_text(f"[s3]\ntype = s3\nprovider = Rclone\nendpoint = http://127.0.0.1:{port}\n"
                        f"access_key_id = {self.ak}\nsecret_access_key = {self.sk}\n")

    def key(self, rel):
        return f"{self.PREFIX}/{rel}"

    def url(self, method, rel):
        return presign(method, f"127.0.0.1:{self.port}", f"/{self.BUCKET}/{self.key(rel)}", self.ak, self.sk)

    def web_get(self, rel):
        try:
            with urllib.request.urlopen(self.url("GET", rel), timeout=60) as resp:
                return sha256(resp.read())
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return None
            raise

    def web_put(self, rel, data):
        req = urllib.request.Request(self.url("PUT", rel), data=data, method="PUT",
                                     headers={"Content-Length": str(len(data)), "Content-Type": "application/octet-stream"})
        with urllib.request.urlopen(req, timeout=300) as resp:
            resp.read()

    def agent_cat(self, rel):
        """m2a: a fresh `rclone cat` process per attempt, no daemon and no synced folder."""
        r = subprocess.run([str(RCLONE), "--config", str(self.agent_conf), "cat", f"s3:{self.BUCKET}/{self.key(rel)}"],
                           capture_output=True, timeout=120, env={"PATH": "/usr/bin:/bin", "HOME": str(self.run.scratch / "agent")})
        return sha256(r.stdout) if r.returncode == 0 else None

    def cut_b(self):
        self.B.proxy.cut()

    def restore_b(self):
        self.B.proxy.restore()

    def host_net_bytes(self, host):
        return host.proxy.bytes()

    def conflicts(self):
        return scan_conflicts([self.A.folder, self.B.folder, self.store_dir / self.BUCKET / self.PREFIX],
                              CONFLICT_RE["rclone-bisync"])

    OP_RE = re.compile(rb"serve s3: ([A-Z][A-Z ]*[A-Z])\b")

    def requests(self):
        """(class A, class B, other) S3 requests the store has logged so far, as R2 bills them."""
        counts = {"a": 0, "b": 0, "other": 0}
        try:
            data = self.store_log.read_bytes()
        except FileNotFoundError:
            return counts
        for m in self.OP_RE.finditer(data):
            op = m.group(1).decode()
            if op.startswith(("GET", "HEAD")):
                counts["b"] += 1
            elif "DELETE" in op:
                counts["other"] += 1  # R2 does not bill DeleteObject
            else:
                counts["a"] += 1  # PUT/POST/COPY/LIST and CREATE (PutObject), multipart
        return counts

    def op_histogram(self):
        hist = {}
        try:
            for m in self.OP_RE.finditer(self.store_log.read_bytes()):
                hist[m.group(1).decode()] = hist.get(m.group(1).decode(), 0) + 1
        except FileNotFoundError:
            pass
        return hist

    def health(self):
        msg = super().health()
        if msg:
            return msg
        if not self.store.alive():
            return "rclone serve s3 exited"
        return None


class Lsyncd(Tool):
    name = "lsyncd"
    # lsyncd's documented default delay is 15 s (it batches events that long); "tuned" sets 1 s.
    presets = {"default": {}, "tuned": {"delay": 1}}
    cut_what = "B's proxy (lsyncd's rsync on A reaches B's rsync daemon only through it)"
    sleep_what = "B's rsync daemon"

    def quiesce_s(self):
        # WHY: the startup rsync carries the canary, but its inotify event still sits in lsyncd's delay queue and would
        # be flushed together with (and so shorten) the first trial's write.
        return float(self.config.get("delay", 15)) + 3.0

    def start(self):
        run = self.run
        self.A, self.B = Host(run, "A"), Host(run, "B")
        self.hosts = (self.A, self.B)
        port = run.ports.take()
        conf = self.B.home / "rsyncd.conf"
        conf.write_text(f"use chroot = no\npid file = {self.B.home / 'rsyncd.pid'}\nlog file = {self.B.root / 'rsyncd.log'}\n"
                        f"[bench]\n    path = {self.B.folder}\n    read only = no\n")
        self.B.spawn("rsyncd", ["/usr/bin/rsync", "--daemon", "--no-detach", "--address=127.0.0.1", f"--port={port}",
                                f"--config={conf}"], self.B.env())
        for _ in range(100):
            with socket.socket() as s:
                if s.connect_ex(("127.0.0.1", port)) == 0:
                    break
            time.sleep(0.05)
        self.proxies = [Proxy(run, "lsyncd-b", port)]
        lua = self.A.home / "lsyncd.conf.lua"
        delay = f"delay = {int(self.config['delay'])}," if "delay" in self.config else ""
        lua.write_text(
            "settings {\n"
            f"  logfile = \"{self.A.root / 'lsyncd-file.log'}\",\n"
            f"  statusFile = \"{self.A.root / 'lsyncd.status'}\",\n"
            "  nodaemon = true,\n  insist = true,\n}\n"
            "sync {\n  default.rsync,\n"
            f"  source = \"{self.A.folder}\",\n"
            f"  target = \"rsync://127.0.0.1:{self.proxies[0].listen}/bench/\",\n"
            f"  {delay}\n"
            "  rsync = { binary = \"/usr/bin/rsync\", archive = true },\n}\n")
        lib = LSYNCD_ROOT / "usr" / "lib" / "x86_64-linux-gnu"
        self.A.spawn("lsyncd", [str(LSYNCD_ROOT / "usr" / "bin" / "lsyncd"), str(lua)], self.A.env(LD_LIBRARY_PATH=lib))
        self.applied = {"delay_s": self.config.get("delay", "15 (lsyncd default)"), "engine": "rsync to an rsync daemon on B",
                        "direction": "one-way A->B"}
        self.notes.append("one-way A->B (lsyncd + rsync): no conflicts are possible by construction")

    def cut_b(self):
        self.proxies[0].cut()

    def restore_b(self):
        self.proxies[0].restore()


TOOL_CLASSES = {c.name: c for c in (Syncthing, Unison, Mutagen, RcloneBisync, Lsyncd)}


# --- the run ---------------------------------------------------------------------------------------------------------


class Run:
    def __init__(self, args, tool_name):
        self.args, self.tool_name = args, tool_name
        self.run_id = args.run_id or f"competitors-{tool_name}-{time.strftime('%Y%m%dT%H%M%S')}"
        self.slug = re.sub(r"[^a-z0-9]+", "-", self.run_id.lower())[-40:].strip("-")
        base = args.scratch or os.environ.get("FSBENCH_SCRATCH") or None
        self.base = Path(tempfile.mkdtemp(prefix=f"fsbench-{tool_name}-", dir=base))
        self.scratch = self.base  # each variant runs in its own subdir (run_tool)
        self.procs, self.ports = Procs(), Ports()
        RAW.mkdir(parents=True, exist_ok=True)
        self.trial_path = RAW / f"{self.run_id}.jsonl"
        self.idle_path = RAW / f"{self.run_id}.idle.jsonl"
        self.ops_path = RAW / f"{self.run_id}.ops.jsonl"

    def emit(self, path, row):
        with open(path, "a") as f:
            f.write(json.dumps(row) + "\n")

    def cleanup(self):
        self.procs.stop_all()
        if not self.args.keep_scratch and self.base.exists():
            shutil.rmtree(self.base, ignore_errors=True)


def make_files(workload, tag):
    """[(rel, bytes)] for one trial. Names are unique per trial, so trials never see each other's files."""
    def blob(n):
        return os.urandom(n)

    def json_1k():
        body = {"tag": tag, "pad": ""}
        base = len(json.dumps(body))
        body["pad"] = os.urandom(512).hex()[: 1024 - base]
        return json.dumps(body).encode()

    if workload == "1k":
        return [(f"{tag}.json", json_1k())]
    if workload == "100k":
        return [(f"{tag}.bin", blob(100 * 1024))]
    if workload == "10m":
        return [(f"{tag}.bin", blob(10 * 1024 * 1024))]
    if workload == "200m":
        return [(f"{tag}.bin", blob(200 * 1024 * 1024))]
    if workload == "many100":
        return [(f"{tag}/{i:03d}.bin", blob(1024)) for i in range(100)]
    if workload == "storm":
        raise ValueError("storm builds its own writes")
    raise ValueError(workload)


class Trials:
    def __init__(self, run, tool):
        self.run, self.tool = run, tool

    def base_row(self, direction, workload, fault, trial):
        return {"schema": "fast-folder-sync-trial/1", "run_id": self.run.run_id, "tool": self.tool.name,
                "variant": self.tool.variant, "config": self.tool.applied, "direction": direction, "workload": workload,
                "fault": fault, "trial": trial, "status": None, "ms": None, "first_ms": None, "put_ms": None,
                "cold_read_ms": None, "bytes": None, "sha256_ok": None, "conflicts": 0, "lost": 0, "real": True,
                "env": "local-loopback", "load1": load1(), "t": now_iso(), "note": None}

    def na_row(self, direction, note, workload=None, fault=None):
        row = self.base_row(direction, workload, fault, None)
        row.update(status="n/a", note=note, conflicts=None, lost=None)
        self.run.emit(self.run.trial_path, row)

    def reader(self, direction):
        tool = self.tool
        if direction in ("m2m", "offline"):
            return DiskProbe(tool.B.folder), DISK_POLL_S
        if direction == "w2m":
            return DiskProbe(tool.A.folder), DISK_POLL_S
        if direction == "m2w":
            return tool.web_get, WEB_POLL_S
        if direction == "m2a":
            return tool.agent_cat, 0.0
        raise ValueError(direction)

    def phase(self):
        time.sleep(random.uniform(0.2, self.tool.phase_max()))

    def one(self, direction, workload, trial):
        tool, run = self.tool, self.run
        revived = tool.revive()
        row = self.base_row(direction, workload, None, trial)
        tag = f"{direction}-{workload}-t{trial}-{random.getrandbits(24):06x}"
        before_conflicts = tool.conflicts()
        req_before = tool.requests()
        probe, interval = self.reader(direction)
        if workload == "storm":
            versions = [make_files("1k", f"{tag}-v{i}")[0][1] for i in range(20)]
            rel = f"{tag}.json"
            files = [(rel, versions[-1])]
        else:
            files = make_files(workload, tag)
        expected = {rel: sha256(data) for rel, data in files}
        row["bytes"] = sum(len(d) for _, d in files) if workload != "storm" else len(versions[-1])
        self.phase()
        watch = Watch(probe, expected, interval)
        put_ms = None
        if workload == "storm":
            watch_started = False
            for i, data in enumerate(versions):
                if i == len(versions) - 1:
                    t0 = time.perf_counter()
                    watch.start()
                    watch_started = True
                self.write(direction, rel, data)
                if i < len(versions) - 1:
                    time.sleep(0.05)
            assert watch_started
        else:
            watch.start()
            t0 = time.perf_counter()
            for rel_i, data in files:
                tw = time.perf_counter()
                self.write(direction, rel_i, data)
                if direction == "w2m" and len(files) == 1:
                    put_ms = (time.perf_counter() - tw) * 1000
        watch.done.wait(TIMEOUT_S[workload])
        watch.stop()
        hits = sorted(watch.hits.values())
        if len(watch.hits) == len(expected):
            row.update(status="ok", ms=round((hits[-1] - t0) * 1000, 1), sha256_ok=True)
            if workload == "many100":
                row["first_ms"] = round((hits[0] - t0) * 1000, 1)
        else:
            row.update(status="timeout", sha256_ok=False, lost=len(expected) - len(watch.hits))
            if hits and workload == "many100":
                row["first_ms"] = round((hits[0] - t0) * 1000, 1)
            row["note"] = f"{len(watch.hits)}/{len(expected)} matched within {TIMEOUT_S[workload]} s" + (
                f"; {tool.health()}" if tool.health() else "")
        row["put_ms"] = round(put_ms, 1) if put_ms is not None else None
        if revived:
            row["note"] = "; ".join(filter(None, [revived, row["note"]]))
        if direction == "m2a" and row["status"] == "ok":
            tc = time.perf_counter()
            got = tool.agent_cat(files[0][0])
            row["cold_read_ms"] = round((time.perf_counter() - tc) * 1000, 1)
            if got != expected[files[0][0]]:
                row["note"] = "cold one-shot read returned different bytes"
        if row["status"] == "ok" and direction == "m2m":
            self.ops(workload, trial, t0, req_before)
        time.sleep(1.0)
        row["conflicts"] = tool.conflicts() - before_conflicts
        run.emit(run.trial_path, row)
        log(tool.name, tool.variant, direction, workload, trial, row["status"], row["ms"], f"conflicts={row['conflicts']}")
        if workload in ("10m", "200m"):
            self.remove(direction, files)
        return row

    def ops(self, workload, trial, t0, req_before):
        tool, run = self.tool, self.run
        base = {"schema": "fast-folder-sync-ops/1", "run_id": run.run_id, "tool": tool.name, "variant": tool.variant,
                "workload": workload, "direction": "m2m", "trial": trial, "worker": 0, "do_msgs": 0}
        if tool.p2p:
            run.emit(run.ops_path, {**base, "class_a": 0, "class_b": 0, "note": "no cloud store"})
            return
        # WHY net of the idle rate: both hosts' bisync loops keep listing the bucket whether or not anything changed,
        # so a change costs the requests in its window minus what the loops would have made anyway.
        settle = tool.interval + 3.0
        time.sleep(settle)
        after = tool.requests()
        window_s = time.perf_counter() - t0
        rate = getattr(tool, "idle_rate", None)
        a = after["a"] - req_before["a"]
        b = after["b"] - req_before["b"]
        row = {**base, "class_a_raw": a, "class_b_raw": b, "window_s": round(window_s, 2)}
        if rate:
            row["class_a"] = round(max(0.0, a - rate["a"] * window_s), 1)
            row["class_b"] = round(max(0.0, b - rate["b"] * window_s), 1)
            row["note"] = "requests seen by the store in the change's window minus the idle loop rate x window"
        else:
            row["class_a"], row["class_b"] = a, b
            row["note"] = "raw requests in the window (no idle rate measured, includes the loops' idle polling)"
        run.emit(run.ops_path, row)

    def write(self, direction, rel, data):
        if direction == "w2m":
            self.tool.web_put(rel, data)
        else:
            write_atomic(self.tool.A, rel, data)

    def remove(self, direction, files):
        """Big files are deleted after their trial (disk budget) and the delete is waited out, so it never overlaps."""
        tool = self.tool
        for rel, _ in files:
            try:
                (tool.A.folder / rel).unlink()
            except FileNotFoundError:
                pass
        deadline = time.time() + 90
        while time.time() < deadline and any((tool.B.folder / rel).exists() for rel, _ in files):
            time.sleep(0.2)

    def offline(self, fault, trial):
        tool, run = self.tool, self.run
        revived = tool.revive()
        row = self.base_row("offline", OFFLINE_WORKLOAD, fault, trial)
        tag = f"offline-{fault}-t{trial}-{random.getrandbits(24):06x}"
        files = [(f"{tag}/{i:02d}.json", make_files("1k", f"{tag}-{i}")[0][1]) for i in range(10)]
        expected = {rel: sha256(data) for rel, data in files}
        row["bytes"] = sum(len(d) for _, d in files)
        before_conflicts = tool.conflicts()
        self.phase()
        watch = Watch(DiskProbe(tool.B.folder), expected, DISK_POLL_S)
        (tool.cut_b if fault == "drop" else tool.sleep_b)()
        t_cut = time.perf_counter()
        watch.start()
        try:
            for i, (rel, data) in enumerate(files):  # one write every 2 s through the 20 s cut-off (as fs_bench.mjs)
                time.sleep(max(0.0, t_cut + 2.0 * i - time.perf_counter()))
                write_atomic(tool.A, rel, data)
            time.sleep(max(0.0, t_cut + CUT_S - time.perf_counter()))
        finally:
            (tool.restore_b if fault == "drop" else tool.wake_b)()
        t0 = time.perf_counter()
        early = sum(1 for t in watch.hits.values() if t < t0)
        watch.done.wait(OFFLINE_TIMEOUT_S)
        watch.stop()
        hits = sorted(watch.hits.values())
        notes = []
        if early:
            notes.append(f"{early} file(s) reached B during the cut-off: the fault leaked")
        if hits:
            row["first_ms"] = round(max(0.0, hits[0] - t0) * 1000, 1)
        if len(hits) == len(expected):
            row.update(status="ok", ms=round(max(0.0, hits[-1] - t0) * 1000, 1), sha256_ok=True)
        else:
            row.update(status="timeout", sha256_ok=False, lost=len(expected) - len(hits))
            notes.append(f"{len(hits)}/{len(expected)} on B within {OFFLINE_TIMEOUT_S} s of restore")
            if tool.health():
                notes.append(tool.health())
        time.sleep(1.0)
        row["conflicts"] = tool.conflicts() - before_conflicts
        notes.insert(0, tool.fault_note(fault))
        if revived:
            notes.append(revived)
        row["note"] = "; ".join(notes)
        run.emit(run.trial_path, row)
        log(tool.name, tool.variant, "offline", fault, trial, row["status"], row["ms"], row["note"] or "")
        return row


def canary(tool):
    """One m2m file before anything is measured: proves the pair is syncing at all."""
    data = json.dumps({"canary": random.getrandbits(64)}).encode()
    rel = f"canary-{random.getrandbits(24):06x}.json"
    write_atomic(tool.A, rel, data)
    watch = Watch(DiskProbe(tool.B.folder), {rel: sha256(data)}, DISK_POLL_S)
    watch.start()
    ok = watch.done.wait(120)
    watch.stop()
    if not ok:
        raise RuntimeError(f"{tool.name}: canary did not reach B within 120 s ({tool.health() or 'processes alive'})")
    time.sleep(tool.quiesce_s())


def idle(run, tool, window_s):
    time.sleep(5.0)
    hosts = tool.hosts
    c0 = {h.name: h.cpu_usec() for h in hosts}
    x0 = {h.name: h.ctx_switches() for h in hosts}
    n0 = {h.name: tool.host_net_bytes(h) for h in hosts}
    r0 = tool.requests()
    t0 = time.perf_counter()
    time.sleep(window_s)
    elapsed = time.perf_counter() - t0
    c1 = {h.name: h.cpu_usec() for h in hosts}
    x1 = {h.name: h.ctx_switches() for h in hosts}
    n1 = {h.name: tool.host_net_bytes(h) for h in hosts}
    r1 = tool.requests()
    per_min = 60.0 / elapsed
    per_host = {}
    for h in hosts:
        cpu = None if c0[h.name] is None or c1[h.name] is None else (c1[h.name] - c0[h.name]) / (elapsed * 1e6) * 100
        net = None if n0[h.name] is None else (n1[h.name] - n0[h.name]) * per_min
        per_host[h.name] = {"cpu_pct": None if cpu is None else round(cpu, 4),
                            "wakeups_per_min": round((x1[h.name] - x0[h.name]) * per_min, 1),
                            "net_bytes_per_min": None if net is None else round(net, 1)}

    def mean(key):
        vals = [v[key] for v in per_host.values() if v[key] is not None]
        return round(sum(vals) / len(vals), 4) if vals else None

    reqs = {"class_a": 0, "class_b": 0, "worker": 0}
    if r0 is not None:
        reqs = {"class_a": round((r1["a"] - r0["a"]) * per_min / len(hosts), 2),
                "class_b": round((r1["b"] - r0["b"]) * per_min / len(hosts), 2), "worker": 0}
        tool.idle_rate = {"a": (r1["a"] - r0["a"]) / elapsed, "b": (r1["b"] - r0["b"]) / elapsed}
    notes = ["wakeups = voluntary + involuntary context switches of the host's live threads (a battery proxy)"]
    if tool.p2p:
        notes.append("no cloud store: class_a = class_b = 0")
    if tool.name == "syncthing":
        notes.append("net per host = bytes on the A<->B link (both proxies): each host is one end of the one link")
    if tool.name == "rclone-bisync":
        notes.append("requests are the store's per-host share (both hosts' loops / 2); wakeups include the exited rclone "
                     "runs' rusage")
    notes += tool.notes
    row = {"schema": "fast-folder-sync-idle/1", "run_id": run.run_id, "tool": tool.name, "variant": tool.variant,
           "config": tool.applied, "window_s": round(elapsed, 1), "hosts": len(hosts), "cpu_pct_per_host": mean("cpu_pct"),
           "wakeups_per_min_per_host": mean("wakeups_per_min"), "net_bytes_per_min_per_host": mean("net_bytes_per_min"),
           "requests_per_min_per_host": reqs, "real": True, "env": "local-loopback", "per_host": per_host,
           "load1": load1(), "t": now_iso(), "note": "; ".join(notes)}
    run.emit(run.idle_path, row)
    log(tool.name, tool.variant, "idle", json.dumps(per_host), json.dumps(reqs))


def parse_kv(text):
    out = {}
    for part in filter(None, (text or "").split(",")):
        k, _, v = part.partition("=")
        try:
            out[k.strip()] = json.loads(v)
        except ValueError:
            out[k.strip()] = v
    return out


def run_tool(args, tool_name):
    cls = TOOL_CLASSES[tool_name]
    variants = args.variants.split(",") if args.variants else list(cls.presets)
    overrides = parse_kv(args.config)
    directions = args.directions.split(",")
    workloads = args.workloads.split(",")
    faults = args.faults.split(",") if args.faults else []
    run = Run(args, tool_name)
    log("run", run.run_id, "scratch", run.base)
    atexit.register(run.cleanup)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda s, f: sys.exit(128 + s))
    try:
        for variant in variants:
            config = dict(cls.presets.get(variant, {}))
            config.update(overrides)
            name = variant if (variant in cls.presets and not overrides) else (args.variant or f"{variant}+custom")
            run.scratch = run.base / re.sub(r"[^A-Za-z0-9_.-]+", "_", name)
            run.scratch.mkdir()
            tool = cls(run, name, config)
            trials = Trials(run, tool)
            try:
                tool.start()
                canary(tool)
                if args.idle_s > 0:
                    idle(run, tool, args.idle_s)
                for direction in directions:
                    if direction not in tool.directions:
                        trials.na_row(direction, tool.na.get(direction, "no path for this direction"))
                        continue
                    if direction == "offline":
                        for fault in faults:
                            note = tool.fault_na(fault)
                            if note:
                                trials.na_row("offline", note, workload=OFFLINE_WORKLOAD, fault=fault)
                                continue
                            for t in range(1, args.trials + 1):
                                trials.offline(fault, t)
                        continue
                    for workload in workloads:
                        if workload == "200m" and direction not in BIG_ONLY:
                            continue
                        for t in range(1, args.trials + 1):
                            trials.one(direction, workload, t)
                if isinstance(tool, RcloneBisync):
                    log("store ops seen:", json.dumps(tool.op_histogram()))
            except Exception as exc:
                log("ERROR", tool_name, name, repr(exc))
                row = trials.base_row(None, None, None, None)
                row.update(status="error", note=f"{type(exc).__name__}: {exc}"[:500], conflicts=None, lost=None)
                run.emit(run.trial_path, row)
            finally:
                if hasattr(tool, "shutdown"):
                    tool.shutdown()
                run.procs.stop_all()
                run.ports = Ports()
                if not args.keep_scratch:
                    shutil.rmtree(run.scratch, ignore_errors=True)
    finally:
        run.cleanup()
    log("wrote", run.trial_path, run.idle_path if run.idle_path.exists() else "", run.ops_path if run.ops_path.exists() else "")
    return run


def check():
    """Leftovers of this harness: processes running our tools or proxies, and anything bound on 5200-5239."""
    # Ours = our tool binaries, our loop helper, or anything on our ports (the folder-sync harness uses 5100-5139).
    ours = re.compile(r"competitors/\.tools/|bisync_loop\.py|127\.0\.0\.1:52[0-3]\d|--(listen|control|port[= ]) ?52[0-3]\d|fsbench-(syncthing|unison|mutagen|rclone-bisync|lsyncd)-")
    rows = subprocess.run(["ps", "-eo", "pid,args"], capture_output=True, text=True).stdout.splitlines()[1:]
    me = os.getpid()
    procs = [r.strip() for r in rows if ours.search(r) and int(r.split()[0]) != me and "bench_competitors.py check" not in r]
    busy = []
    for port in PORTS:
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                busy.append(port)
    print(json.dumps({"processes": procs, "ports_in_use_5200_5239": busy}, indent=2))
    return 0 if not procs and not busy else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--tool", required=True, help="comma list of: " + ", ".join(TOOL_CLASSES))
    r.add_argument("--variants", help="presets to run (default: all of the tool's presets)")
    r.add_argument("--variant", help="variant name to record when --config overrides a preset")
    r.add_argument("--config", help="k=v,... applied on top of every preset")
    r.add_argument("--directions", default=",".join(DIRECTIONS))
    r.add_argument("--workloads", default=",".join(WORKLOADS))
    r.add_argument("--faults", default=",".join(FAULTS))
    r.add_argument("--trials", type=int, default=10)
    r.add_argument("--run-id")
    r.add_argument("--idle-s", type=float, default=120)
    r.add_argument("--scratch", help="parent dir for the run's temp dirs (default: $FSBENCH_SCRATCH or the system temp dir)")
    r.add_argument("--keep-scratch", action="store_true")
    sub.add_parser("check")
    args = parser.parse_args()
    if args.cmd == "check":
        return check()
    for name in args.tool.split(","):
        if name not in TOOL_CLASSES:
            parser.error(f"unknown tool {name}")
    missing = [p for p in (SYNCTHING, UNISON_BIN / "unison", MUTAGEN, LSYNCD_ROOT / "usr/bin/lsyncd") if not p.exists()]
    if missing or RCLONE is None:
        parser.error(f"tools missing ({', '.join(map(str, missing)) or 'rclone'}): run bench/fast/competitors/fetch_tools.sh")
    for name in args.tool.split(","):
        if args.run_id and "," in args.tool:
            args_one = copy.copy(args)
            args_one.run_id = f"{args.run_id}-{name}"
            run_tool(args_one, name)
        else:
            run_tool(args, name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
