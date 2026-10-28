#!/usr/bin/env python3
"""Turn the three platforms' Tauri bundles into one release: plain names, SHA256SUMS, the notes and latest.json.

Usage: app/scripts/release_assets.py --tag desktop-v0.1.0-rc1 --commit <sha> --bundles <dir> --out <dir>

<dir> of --bundles is whatever the CI jobs uploaded (searched recursively). Into --out it writes:
  folder-sync-<version>-<platform>.<ext>   one per installer (see KINDS)
  SHA256SUMS                               `sha256sum -c` format
  NOTES.md                                 app/release/NOTES.md for this version, plus the checksum table
  latest.json                              folder-sync-downloads/1: what /fs/download lists (accounts/src/download.ts)
It fails when any of the five installers is missing, so a release is never published with a platform short.
Standard library only.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import pathlib
import re
import shutil
import sys

# (glob over Tauri's bundle names, platform label in the new name, os, arch, kind, what a person reads)
# WHY renamed: Tauri names every platform's file after the bundle version (0.1.0), never the tag (0.1.0-rc1, which an
# MSI cannot carry), and leaves the OS out of a .dmg or .msi name; one plain scheme reads well on the download page.
KINDS = [
    ("*_universal.dmg", "macos-universal.dmg", "macos", "universal", "dmg", "Mac (Apple silicon and Intel)"),
    ("*_x64-setup.exe", "windows-x64-setup.exe", "windows", "x64", "exe", "Windows installer"),
    ("*_x64_en-US.msi", "windows-x64.msi", "windows", "x64", "msi", "Windows .msi (all users)"),
    ("*_amd64.AppImage", "linux-x86_64.AppImage", "linux", "x86_64", "AppImage", "Linux AppImage"),
    ("*_amd64.deb", "linux-amd64.deb", "linux", "x86_64", "deb", "Debian / Ubuntu .deb"),
]

TAG = re.compile(r"^desktop-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$")


def sha256_of(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--bundles", required=True, type=pathlib.Path)
    parser.add_argument("--out", required=True, type=pathlib.Path)
    parser.add_argument("--notes", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent.parent / "release" / "NOTES.md")
    args = parser.parse_args()

    matched = TAG.match(args.tag)
    if not matched:
        print(f"release_assets: tag {args.tag!r} is not desktop-v<semver>", file=sys.stderr)
        return 2
    version = matched.group(1)
    args.out.mkdir(parents=True, exist_ok=True)

    files = []
    missing = []
    for pattern, suffix, os_name, arch, kind, label in KINDS:
        found = sorted(p for p in args.bundles.rglob(pattern) if p.is_file())
        if not found:
            missing.append(pattern)
            continue
        if len(found) > 1:
            print(f"release_assets: {len(found)} files match {pattern}: {found}", file=sys.stderr)
            return 2
        name = f"folder-sync-{version}-{suffix}"
        target = args.out / name
        shutil.copyfile(found[0], target)
        files.append({
            "name": name,
            "os": os_name,
            "arch": arch,
            "kind": kind,
            "label": label,
            "size": target.stat().st_size,
            "sha256": sha256_of(target),
            "key": f"downloads/desktop/{args.tag}/{name}",
        })
    if missing:
        print(f"release_assets: missing installers: {', '.join(missing)}", file=sys.stderr)
        return 1

    (args.out / "SHA256SUMS").write_text("".join(f"{f['sha256']}  {f['name']}\n" for f in files))
    table = ["", "## SHA-256", "", "| File | Size | SHA-256 |", "|---|---:|---|"]
    table += [f"| `{f['name']}` | {f['size'] / 1e6:.1f} MB | `{f['sha256']}` |" for f in files]
    notes = args.notes.read_text().replace("{version}", version) + "\n".join(table) + f"\n\nBuilt from `{args.commit}`.\n"
    (args.out / "NOTES.md").write_text(notes)
    manifest = {
        "schema": "folder-sync-downloads/1",
        "tag": args.tag,
        "version": version,
        "commit": args.commit,
        "published": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "files": files,
    }
    (args.out / "latest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    for f in files:
        print(f"{f['sha256']}  {f['size']:>12}  {f['name']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
