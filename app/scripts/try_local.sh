#!/usr/bin/env bash
# Try the built desktop app on this desktop against robotparts' LOCAL accounts stack (never production):
# starts the stack (robotparts lane/fast-sync tools/accounts_demo.py, ports 4970-4979), runs the AppImage with its own
# HOME under ~/.cache/folder-sync-desktop-try (so ~/robotparts, ~/.config/autostart and ~/.folder-sync stay untouched),
# and stops the stack when the app quits (tray → Quit folder-sync).
# Sign in: the browser opens the device page; enter maker@example.com, then the code from the mailbox URL printed below.
# The session goes into this desktop's keychain under dev.folder-sync.desktop / session@http://127.0.0.1:4973 (a local
# test value; Sign out removes it).
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$APP/.." && pwd)"
ROBOTPARTS="${ROBOTPARTS_LANE:-/home/bam/robotparts/.claude/worktrees/lane-fast-sync}"
TRY="${FOLDER_SYNC_TRY_HOME:-$HOME/.cache/folder-sync-desktop-try}"
APPIMAGE="$APP/src-tauri/target/release/bundle/appimage/folder-sync_0.1.0_amd64.AppImage"
SITE="http://127.0.0.1:4973"
[ -x "$APPIMAGE" ] || { echo "no AppImage yet: run $APP/scripts/build.sh" >&2; exit 1; }
mkdir -p "$TRY/home"
demo() { ROBOTPARTS_DEMO_BASE=4970 ROBOTPARTS_DEMO_STATE="$TRY/demo" FOLDER_SYNC_REPO="$REPO" RCLONE="$REPO/.tools/rclone" \
  python3 "$ROBOTPARTS/tools/accounts_demo.py" "$@"; }
demo up >/dev/null
trap 'demo down >/dev/null 2>&1 || true' EXIT
echo "robotparts (local): $SITE/saved/"
echo "sign-in codes:      $SITE/fs/dev/mailbox?email=maker@example.com"
HOME="$TRY/home" XDG_CONFIG_HOME="$TRY/home/.config" XDG_DATA_HOME="$TRY/home/.local/share" XDG_CACHE_HOME="$TRY/home/.cache" \
  APPIMAGE_EXTRACT_AND_RUN=1 FOLDER_SYNC_SERVER="$SITE" FOLDER_SYNC_RCLONE="$REPO/.tools/rclone" "$APPIMAGE"
