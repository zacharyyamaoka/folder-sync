"""Collect the evidence the v0 report shows, by running the real things.

    python3 docs/report/collect.py <out-dir>

Writes <out-dir>/evidence.json (+ e2e-steps.json from the end-to-end test).
Runs: the Go unit and end-to-end tests, the two reader test suites, the Windows
cross-compile, `folder-sync --help`, and scripts/check-r2 against the stand-in.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
GO = str(Path.home() / ".local" / "go" / "bin" / "go")
NODE = "/usr/bin/node"


def run(args: list[str], env: dict | None = None, cwd: Path = REPO) -> tuple[int, str]:
    result = subprocess.run(args, cwd=cwd, env={**os.environ, **(env or {})},
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return result.returncode, result.stdout


def go_tests(out_dir: Path) -> dict:
    env = {"PATH": f"{Path(GO).parent}:{os.environ['PATH']}", "FOLDER_SYNC_E2E_ARTIFACTS": str(out_dir)}
    code, text = run([GO, "test", "-count=1", "-json", "./..."], env)
    packages: dict[str, dict] = {}
    tests = []
    for line in text.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        package = event.get("Package", "").replace("folder-sync/", "")
        if event.get("Action") in ("pass", "fail", "skip") and event.get("Test"):
            tests.append({"package": package, "test": event["Test"], "result": event["Action"], "seconds": event.get("Elapsed", 0)})
        if event.get("Action") in ("pass", "fail", "skip") and not event.get("Test"):
            packages[package] = {"result": event["Action"], "seconds": event.get("Elapsed", 0)}
    return {"exit": code, "packages": packages, "tests": tests}


def windows_build() -> dict:
    out = {}
    dist = REPO / "dist"
    dist.mkdir(exist_ok=True)
    builds = []
    for goos, arch in (("windows", "amd64"), ("windows", "arm64"), ("darwin", "arm64"), ("linux", "amd64")):
        name = f"folder-sync-{goos}-{arch}" + (".exe" if goos == "windows" else "")
        code, text = run([GO, "build", "-trimpath", "-o", str(dist / name), "./cmd/folder-sync"],
                         {"GOOS": goos, "GOARCH": arch, "CGO_ENABLED": "0"})
        entry = {"target": f"{goos}/{arch}", "file": f"dist/{name}", "exit": code, "output": text.strip()}
        if code == 0:
            data = (dist / name).read_bytes()
            entry["bytes"] = len(data)
            entry["sha256"] = hashlib.sha256(data).hexdigest()
            entry["file_type"] = run(["file", "-b", str(dist / name)])[1].strip()
        builds.append(entry)
    out["builds"] = builds
    code, text = run([GO, "vet", "./..."], {"GOOS": "windows", "GOARCH": "amd64"})
    out["vet"] = {"exit": code, "output": text.strip()}
    compiled = []
    _, listing = run([GO, "list", "./..."])
    for package in listing.split():
        code, text = run([GO, "test", "-c", "-o", os.devnull, package], {"GOOS": "windows", "GOARCH": "amd64"})
        compiled.append({"package": package.replace("folder-sync/", ""), "exit": code, "output": text.strip()})
    out["test_binaries"] = compiled
    code, text = run([GO, "test", "-count=1", "-v", "-run",
                      "Windows|AppData|TestJoin|TestCheck|TestCaseTwins|TestLint|TestTaskScheduler|TestEveryCallPins",
                      "./internal/layout/", "./internal/names/", "./internal/service/", "./internal/rclone/"])
    out["windows_unit_tests"] = {"exit": code, "lines": [l for l in text.splitlines() if l.startswith(("--- ", "ok", "FAIL"))]}
    return out


def main() -> int:
    out_dir = Path(sys.argv[1]).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    evidence: dict = {}
    code, version = run([GO, "version"])
    evidence["go_version"] = version.strip()
    code, version = run([str(REPO / ".tools" / "rclone"), "version"])
    evidence["rclone_version"] = version.splitlines()[0] if version else ""
    code, version = run([NODE, "--version"])
    evidence["node_version"] = version.strip()
    evidence["python_version"] = sys.version.split()[0]
    code, sha = run(["git", "-C", str(REPO), "rev-parse", "--short", "HEAD"])
    evidence["head"] = sha.strip()
    code, branch = run(["git", "-C", str(REPO), "rev-parse", "--abbrev-ref", "HEAD"])
    evidence["branch"] = branch.strip()

    binary = REPO / "dist" / "folder-sync"
    run([GO, "build", "-o", str(binary), "./cmd/folder-sync"])
    evidence["help"] = run([str(binary), "--help"])[1]

    evidence["go_tests"] = go_tests(out_dir)
    code, text = run([sys.executable, "-m", "unittest", "discover", "-s", "readers/python", "-v"])
    evidence["python_reader"] = {"exit": code, "output": text}
    code, text = run([NODE, "--test", "readers/worker/test/reader.test.ts"])
    evidence["worker_reader"] = {"exit": code, "output": text}
    evidence["windows"] = windows_build()
    code, text = run([str(REPO / "scripts" / "check-r2-standin")])
    evidence["check_r2_standin"] = {"exit": code, "output": text}
    (out_dir / "evidence.json").write_text(json.dumps(evidence, indent=1))
    failed = [t for t in evidence["go_tests"]["tests"] if t["result"] == "fail"]
    print(f"go: {len(evidence['go_tests']['tests'])} tests, {len(failed)} failed; python exit {evidence['python_reader']['exit']}; "
          f"node exit {evidence['worker_reader']['exit']}; check-r2 stand-in exit {code}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
