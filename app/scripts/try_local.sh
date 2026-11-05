#!/usr/bin/env bash
# Try the built desktop app on this desktop against this repo's LOCAL accounts stack (never production): starts the stack
# (accounts/scripts/dev.mjs: wrangler dev, the R2 stand-in, rclone's S3 store; ports 4981-4984), runs the AppImage with its own
# HOME under ~/.cache/folder-sync-desktop-try (so your ~/folder-sync, autostart folder and ~/.folder-sync stay untouched), and
# stops the stack when the app quits (tray -> Quit folder-sync).
# Sign in: the browser opens the device page; enter any email (maker@example.com), then the code from the mailbox URL printed
# below. Then Create new folder, drop files in it, and Open online. The session goes into this desktop's keychain under
# dev.folder-sync.desktop / session@http://127.0.0.1:4983 (a local test value; Sign out removes it).
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$APP/.." && pwd)"
TRY="${FOLDER_SYNC_TRY_HOME:-$HOME/.cache/folder-sync-desktop-try}"
APPIMAGE="$(ls "$APP"/src-tauri/target/release/bundle/appimage/folder-sync_*_amd64.AppImage 2>/dev/null | tail -n 1 || true)"
SITE="http://127.0.0.1:4983"
[ -n "$APPIMAGE" ] && [ -x "$APPIMAGE" ] || { echo "no AppImage yet: run $APP/scripts/build.sh" >&2; exit 1; }
mkdir -p "$TRY/home"
export RCLONE="$REPO/.tools/rclone" FS_STANDIN_PORT=4981 FS_STORE_PORT=4982 FS_ACCOUNTS_PORT=4983 FS_INSPECTOR_PORT=4984
node "$REPO/accounts/scripts/dev.mjs" up --state-dir "$TRY/stack" >/dev/null
trap 'node "$REPO/accounts/scripts/dev.mjs" down --state-dir "$TRY/stack" >/dev/null 2>&1 || true' EXIT
echo "files page (local): $SITE/fs/files"
echo "sign-in codes:      $SITE/fs/dev/mailbox?email=maker@example.com"
HOME="$TRY/home" XDG_CONFIG_HOME="$TRY/home/.config" XDG_DATA_HOME="$TRY/home/.local/share" XDG_CACHE_HOME="$TRY/home/.cache" \
  APPIMAGE_EXTRACT_AND_RUN=1 FOLDER_SYNC_SERVER="$SITE" FOLDER_SYNC_RCLONE="$REPO/.tools/rclone" "$APPIMAGE"
