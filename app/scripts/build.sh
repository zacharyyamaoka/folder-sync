#!/usr/bin/env bash
# Build the folder-sync desktop app for this Linux machine: the Go engine as Tauri's sidecar, then the .deb and the
# AppImage. Usage: app/scripts/build.sh [--no-bundle]   (from anywhere; outputs under app/src-tauri/target/release/)
# WHY under a memory-capped scope: the machine runs many agents; a Rust release build must not take the others down.
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$APP/.." && pwd)"
GO="${GO:-$(command -v go || echo "$HOME/.local/go/bin/go")}"
TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
cd "$APP"
mkdir -p "$APP/src-tauri/binaries"
VERSION="desktop-$(git -C "$REPO" rev-parse --short HEAD)"
echo "engine: $GO build ($VERSION) -> src-tauri/binaries/folder-sync-$TRIPLE"
CGO_ENABLED=0 "$GO" -C "$REPO" build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o "$APP/src-tauri/binaries/folder-sync-$TRIPLE" ./cmd/folder-sync
if [ ! -x "$APP/node_modules/.bin/tauri" ]; then
  npm --prefix "$APP" install --no-audit --no-fund
fi
CAP=(systemd-run --user --scope -q -p MemoryMax=48G -p OOMPolicy=continue --)
if [ "${1:-}" = "--no-bundle" ]; then
  "${CAP[@]}" "$APP/node_modules/.bin/tauri" build --no-bundle --config "$APP/src-tauri/tauri.conf.json"
else
  # WHY NO_STRIP: linuxdeploy's bundled strip is too old for the newer ELF sections Rust emits (a known AppImage
  # failure); the release profile already strips.
  NO_STRIP=true "${CAP[@]}" "$APP/node_modules/.bin/tauri" build
fi
ls -la "$APP/src-tauri/target/release/bundle/"*/ 2>/dev/null || true
