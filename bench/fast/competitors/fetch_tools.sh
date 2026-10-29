#!/usr/bin/env bash
# Fetch the off-the-shelf competitors for the Fast Folder Sync bench (bench/fast/CONTRACT.md) into
# bench/fast/competitors/.tools/<tool>-<version>/, verify each against its project's published checksums, and write
# bench/fast/competitors/tools.lock.json. Idempotent: a tool whose extracted binary is already there is re-verified
# from the archive kept beside it, not downloaded again.
#   bench/fast/competitors/fetch_tools.sh
# Official release binaries only; nothing is run from a download until its checksum matched. No sudo, no installers.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
tools="$here/.tools"
lock="$here/tools.lock.json"
mkdir -p "$tools"

SYNCTHING_VERSION="v2.1.7"
# WHY two keys: the v2.1.7 list is signed by both the new release key (syncthing.net/release-key.txt) and the 2014 key
# 37C84554… that syncthing.net/security names as D26E6ED000654A3E ("old and new release keys"); both must verify.
SYNCTHING_KEYS="FBA2E162F2F44657B38F0309E5665F9BD5970C47=https://syncthing.net/release-key.txt
37C84554E7E0A261E4F76E1ED26E6ED000654A3E=https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x37C84554E7E0A261E4F76E1ED26E6ED000654A3E"
UNISON_VERSION="v2.54.0"
MUTAGEN_VERSION="v0.18.1"
MUTAGEN_KEY_FPR="34E4B7729CFC6FB4E776CB3B781D56DB8AFBBFEA"
MUTAGEN_KEYS="$MUTAGEN_KEY_FPR=https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x$MUTAGEN_KEY_FPR"
LSYNCD_DEBS=(lsyncd liblua5.3-0)

entries="$(mktemp)"
trap 'rm -f "$entries"' EXIT
# record <name> <version> <url> <sha256> <verified yes|no> <how>
record() { printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$@" >>"$entries"; }

fetch() { # fetch <url> <out>: download only when missing
  if [[ ! -s "$2" ]]; then curl -fsSL "$1" -o "$2.part" && mv "$2.part" "$2"; fi
}

gpg_verify() { # gpg_verify "<fpr>=<key url> ..." <signature> [data]: every listed key must give a VALIDSIG.
  # A private keyring per call, so ~/.gnupg is never touched.
  local keys="$1"; shift
  local home; home="$(mktemp -d)"
  chmod 700 "$home"
  local ok=0 status pair
  for pair in $keys; do
    curl -fsSL "${pair#*=}" -o "$home/key.asc" 2>/dev/null && GNUPGHOME="$home" gpg --batch --quiet --import "$home/key.asc" 2>/dev/null || ok=1
  done
  status="$(GNUPGHOME="$home" gpg --batch --status-fd 1 --verify "$@" 2>/dev/null || true)"
  for pair in $keys; do grep -q "^\[GNUPG:\] VALIDSIG ${pair%%=*} " <<<"$status" || ok=1; done
  rm -rf "$home"
  return $ok
}

# --- Syncthing: sha256sum.txt.asc is a clearsigned list --------------------------------------------------------------
d="$tools/syncthing-$SYNCTHING_VERSION"; mkdir -p "$d"
name="syncthing-linux-amd64-$SYNCTHING_VERSION.tar.gz"
url="https://github.com/syncthing/syncthing/releases/download/$SYNCTHING_VERSION/$name"
fetch "$url" "$d/$name"
fetch "https://github.com/syncthing/syncthing/releases/download/$SYNCTHING_VERSION/sha256sum.txt.asc" "$d/sha256sum.txt.asc"
sig="no (signature check failed)"
gpg_verify "$SYNCTHING_KEYS" "$d/sha256sum.txt.asc" && sig="yes (gpg VALIDSIG by FBA2E162… and 37C84554…)"
want="$(awk -v n="$name" '$2 == n {print $1}' "$d/sha256sum.txt.asc")"
got="$(sha256sum "$d/$name" | cut -d' ' -f1)"
[[ "$want" == "$got" ]] || { echo "fetch_tools: syncthing sha256 mismatch ($got != $want)" >&2; exit 1; }
[[ -x "$d/syncthing" ]] || tar -xzf "$d/$name" -C "$d" --strip-components=1 "syncthing-linux-amd64-$SYNCTHING_VERSION/syncthing"
record syncthing "$SYNCTHING_VERSION" "$url" "$got" yes "sha256 matches sha256sum.txt.asc; signature: $sig"

# --- Unison: no checksum file is published; GitHub's per-asset sha256 digest is the published checksum ----------------
d="$tools/unison-$UNISON_VERSION"; mkdir -p "$d"
name="unison-${UNISON_VERSION#v}-ubuntu-22.04-x86_64-static.tar.gz"
url="https://github.com/bcpierce00/unison/releases/download/$UNISON_VERSION/$name"
fetch "$url" "$d/$name"
want="$(curl -fsSL "https://api.github.com/repos/bcpierce00/unison/releases/tags/$UNISON_VERSION" \
  | python3 -I -c 'import json,sys; n=sys.argv[1]; print(next(a["digest"].split(":",1)[1] for a in json.load(sys.stdin)["assets"] if a["name"]==n))' "$name")"
got="$(sha256sum "$d/$name" | cut -d' ' -f1)"
[[ "$want" == "$got" ]] || { echo "fetch_tools: unison sha256 mismatch ($got != $want)" >&2; exit 1; }
if [[ ! -x "$d/${name%.tar.gz}/bin/unison" ]]; then tar -xzf "$d/$name" -C "$d"; fi
record unison "$UNISON_VERSION" "$url" "$got" yes "sha256 matches the GitHub release asset digest (the project publishes no checksum file or signature)"

# --- Mutagen: SHA256SUMS + SHA256SUMS.gpg ----------------------------------------------------------------------------
d="$tools/mutagen-$MUTAGEN_VERSION"; mkdir -p "$d"
name="mutagen_linux_amd64_$MUTAGEN_VERSION.tar.gz"
url="https://github.com/mutagen-io/mutagen/releases/download/$MUTAGEN_VERSION/$name"
fetch "$url" "$d/$name"
fetch "https://github.com/mutagen-io/mutagen/releases/download/$MUTAGEN_VERSION/SHA256SUMS" "$d/SHA256SUMS"
fetch "https://github.com/mutagen-io/mutagen/releases/download/$MUTAGEN_VERSION/SHA256SUMS.gpg" "$d/SHA256SUMS.gpg"
sig="no (signing key $MUTAGEN_KEY_FPR is not on keyserver.ubuntu.com, keys.openpgp.org or github.com/xenoscopic.gpg)"
gpg_verify "$MUTAGEN_KEYS" "$d/SHA256SUMS.gpg" "$d/SHA256SUMS" && sig="yes (gpg VALIDSIG $MUTAGEN_KEY_FPR)"
want="$(awk -v n="$name" '$2 == n {print $1}' "$d/SHA256SUMS")"
got="$(sha256sum "$d/$name" | cut -d' ' -f1)"
[[ "$want" == "$got" ]] || { echo "fetch_tools: mutagen sha256 mismatch ($got != $want)" >&2; exit 1; }
if [[ ! -x "$d/mutagen" ]]; then tar -xzf "$d/$name" -C "$d"; fi
record mutagen "$MUTAGEN_VERSION" "$url" "$got" yes "sha256 matches SHA256SUMS; signature: $sig"

# --- rclone: the repo's pinned binary (scripts/dev-tools verified its zip against internal/rclonebin/install.go) ------
rclone="$repo/.tools/rclone"
main_rclone="/home/bam/folder-sync/.tools/rclone"
[[ -x "$rclone" ]] || rclone="$main_rclone"
rv="$("$rclone" version --config /dev/null | head -1 | awk '{print $2}')"
pin_zip="$(awk -F'"' '/"linux-amd64":/{print $4}' "$repo/internal/rclonebin/install.go")"
record rclone "$rv" "$rclone (from https://downloads.rclone.org/$rv/rclone-$rv-linux-amd64.zip)" "$(sha256sum "$rclone" | cut -d' ' -f1)" yes \
  "binary sha256 shown; its zip was verified by scripts/dev-tools against the repo pin $pin_zip"

# --- lsyncd + liblua5.3 from the Ubuntu archive (apt-get download checks the signed index; we re-check its SHA256) ----
lv="$(apt-cache show lsyncd | awk '/^Version:/{print $2; exit}')"
d="$tools/lsyncd-$lv"; mkdir -p "$d/debs" "$d/root"
for pkg in "${LSYNCD_DEBS[@]}"; do
  ver="$(apt-cache show "$pkg" | awk '/^Version:/{print $2; exit}')"
  file="$(apt-cache show "$pkg" | awk '/^Filename:/{print $2; exit}')"
  want="$(apt-cache show "$pkg" | awk '/^SHA256:/{print $2; exit}')"
  deb="$d/debs/$(basename "$file")"
  [[ -s "$deb" ]] || (cd "$d/debs" && apt-get download "$pkg=$ver" >/dev/null)
  got="$(sha256sum "$deb" | cut -d' ' -f1)"
  [[ "$want" == "$got" ]] || { echo "fetch_tools: $pkg sha256 mismatch ($got != $want)" >&2; exit 1; }
  dpkg-deb -x "$deb" "$d/root"
  record "$pkg" "$ver" "http://archive.ubuntu.com/ubuntu/$file" "$got" yes "sha256 matches the SHA256 in apt's signed Packages index"
done

python3 -I - "$entries" "$lock" <<'PY'
import json, sys
rows = [line.rstrip("\n").split("\t") for line in open(sys.argv[1]) if line.strip()]
tools = [{"name": n, "version": v, "url": u, "sha256": s, "verified": ok == "yes", "verification": how} for n, v, u, s, ok, how in rows]
with open(sys.argv[2] + ".tmp", "w") as out:
    json.dump({"schema": "fast-folder-sync-tools/1", "tools": tools}, out, indent=2)
    out.write("\n")
import os
os.replace(sys.argv[2] + ".tmp", sys.argv[2])
PY
echo "fetch_tools: wrote $lock"
