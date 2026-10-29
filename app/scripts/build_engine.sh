#!/usr/bin/env bash
# Build the folder-sync Go engine as Tauri's sidecar for one Rust target triple:
#   app/src-tauri/binaries/folder-sync-<triple>[.exe]   (the name Tauri's bundle.externalBin looks for)
# Usage: app/scripts/build_engine.sh [<rust target triple>] [<version>]   (default: this machine's host triple)
# universal-apple-darwin builds darwin/arm64 and darwin/amd64 and joins them with lipo (macOS only).
# WHY cross-compiled with CGO off: the engine is pure Go, so one runner can build any target, and the binary needs no
# libc of a particular age (the AppImage then runs on any glibc Linux).
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$APP/.." && pwd)"
GO="${GO:-$(command -v go || echo "$HOME/.local/go/bin/go")}"
TRIPLE="${1:-$(rustc -vV | sed -n 's/^host: //p')}"
VERSION="${2:-desktop-$(git -C "$REPO" rev-parse --short HEAD)}"
OUT_DIR="$APP/src-tauri/binaries"
mkdir -p "$OUT_DIR"

go_build() { # <goos> <goarch> <output>
  echo "engine: GOOS=$1 GOARCH=$2 ($VERSION) -> ${3#"$APP/"}"
  CGO_ENABLED=0 GOOS="$1" GOARCH="$2" "$GO" -C "$REPO" build -trimpath \
    -ldflags "-s -w -X main.version=$VERSION" -o "$3" ./cmd/folder-sync
}

case "$TRIPLE" in
  x86_64-unknown-linux-gnu)  go_build linux amd64 "$OUT_DIR/folder-sync-$TRIPLE" ;;
  aarch64-unknown-linux-gnu) go_build linux arm64 "$OUT_DIR/folder-sync-$TRIPLE" ;;
  x86_64-apple-darwin)       go_build darwin amd64 "$OUT_DIR/folder-sync-$TRIPLE" ;;
  aarch64-apple-darwin)      go_build darwin arm64 "$OUT_DIR/folder-sync-$TRIPLE" ;;
  universal-apple-darwin)
    go_build darwin arm64 "$OUT_DIR/folder-sync-aarch64-apple-darwin"
    go_build darwin amd64 "$OUT_DIR/folder-sync-x86_64-apple-darwin"
    lipo -create -output "$OUT_DIR/folder-sync-$TRIPLE" \
      "$OUT_DIR/folder-sync-aarch64-apple-darwin" "$OUT_DIR/folder-sync-x86_64-apple-darwin"
    lipo -info "$OUT_DIR/folder-sync-$TRIPLE" ;;
  x86_64-pc-windows-msvc)    go_build windows amd64 "$OUT_DIR/folder-sync-$TRIPLE.exe" ;;
  aarch64-pc-windows-msvc)   go_build windows arm64 "$OUT_DIR/folder-sync-$TRIPLE.exe" ;;
  *) echo "build_engine.sh: no Go target for $TRIPLE" >&2; exit 2 ;;
esac
