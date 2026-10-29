#!/usr/bin/env bash
# Silent-install smoke for the desktop installers (PEP 0006): install each one the way an IT department would, with no
# window, then run the engine it installed. A bundle that builds but does not install, or installs without the sidecar,
# fails here, before a release is published.
#   windows  msiexec /i <msi> /qn, then <name>-setup.exe /S; each is uninstalled before the next so they do not meet
#   macos    mount the .dmg, copy the .app out, unmount
# Usage: app/scripts/smoke_install.sh <windows|macos> <bundle dir>      (Git Bash on Windows; bash on macOS)
# Success is `folder-sync version` exiting 0 from the installed copy. (`status` exits 1 without an initialised folder, so
# it says nothing about the install.)
set -euo pipefail
os="${1:?usage: smoke_install.sh <windows|macos> <bundle dir>}"
bundle="${2:?usage: smoke_install.sh <windows|macos> <bundle dir>}"
bundle="$(cd "$bundle" && pwd)"
scratch="$(mktemp -d)"
home="$scratch/home" # WHY: the engine writes ~/.folder-sync; keep the runner's own home clean
mkdir -p "$home"
failed=0

# smoke_engine <label> <path to the installed folder-sync engine>
smoke_engine() {
  local label="$1" exe="$2" out
  [[ -f "$exe" ]] || { echo "::error::$label: no engine at $exe"; failed=1; return; }
  if ! out="$(HOME="$home" USERPROFILE="$(native "$home")" "$exe" version 2>&1)"; then
    echo "::error::$label: '$exe version' exited non-zero: $out"; failed=1; return
  fi
  case "$out" in
    "folder-sync "*) echo "ok  $label: $out" ;;
    *) echo "::error::$label: unexpected 'version' output: $out"; failed=1 ;;
  esac
}

native() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }

# powershell_run <file> <args...>: run, wait for it to finish, and return its exit code. WHY PowerShell: bash does not wait
# for the GUI-subsystem msiexec and installers, and Git Bash rewrites a bare /S or /qn into a path.
powershell_run() {
  local file="$1"; shift
  local list="" arg
  for arg in "$@"; do list+="'${arg//\'/\'\'}',"; done
  powershell.exe -NoProfile -NonInteractive -Command \
    "\$p = Start-Process -FilePath '$file' -ArgumentList ${list%,} -Wait -PassThru; exit \$p.ExitCode"
}

# find_engine <root>...: the first folder-sync.exe under any root (an installer picks its own folder)
find_engine() {
  local root
  for root in "$@"; do
    [[ -d "$root" ]] || continue
    find "$root" -maxdepth 3 -iname folder-sync.exe -print -quit
  done | head -1
}

case "$os" in
  windows)
    msi="$(ls "$bundle"/msi/*.msi | head -1)"
    setup="$(ls "$bundle"/nsis/*-setup.exe | head -1)"
    program_files="$(cygpath -u "${PROGRAMFILES:-C:\\Program Files}")"
    local_app_data="$(cygpath -u "${LOCALAPPDATA:?LOCALAPPDATA is not set}")"
    roots=("$program_files/folder-sync" "$local_app_data/folder-sync" "$local_app_data/Programs/folder-sync")

    echo "== MSI: msiexec /i $(basename "$msi") /qn"
    powershell_run msiexec.exe /i "\"$(native "$msi")\"" /qn /norestart /l*v "\"$(native "$scratch/msi.log")\"" || {
      echo "::error::msiexec /i exited $?"; tail -40 "$scratch/msi.log" 2>/dev/null || true; exit 1; }
    engine="$(find_engine "${roots[@]}")"
    if [[ -z "$engine" ]]; then
      echo "::error::the MSI installed without folder-sync.exe under: ${roots[*]}"
      ls -la "${roots[@]}" 2>&1 || true; exit 1
    fi
    smoke_engine "msi ($engine)" "$engine"
    powershell_run msiexec.exe /x "\"$(native "$msi")\"" /qn /norestart || { echo "::error::msiexec /x exited $?"; failed=1; }

    echo "== NSIS: $(basename "$setup") /S"
    powershell_run "$(native "$setup")" /S || { echo "::error::$(basename "$setup") /S exited $?"; exit 1; }
    engine="$(find_engine "${roots[@]}")"
    if [[ -z "$engine" ]]; then
      echo "::error::the NSIS installer finished without folder-sync.exe under: ${roots[*]}"
      ls -la "${roots[@]}" 2>&1 || true; exit 1
    fi
    smoke_engine "nsis ($engine)" "$engine"
    uninstaller="$(dirname "$engine")/uninstall.exe"
    [[ -f "$uninstaller" ]] && { powershell_run "$(native "$uninstaller")" /S || true; } ;;

  macos)
    dmg="$(ls "$bundle"/dmg/*.dmg | head -1)"
    mount="$scratch/mount"
    mkdir -p "$mount"
    echo "== DMG: mount $(basename "$dmg"), copy the .app"
    hdiutil attach -nobrowse -readonly -noverify -mountpoint "$mount" "$dmg" >/dev/null
    detach() { hdiutil detach "$mount" -force >/dev/null 2>&1 || true; }
    trap detach EXIT
    app="$(find "$mount" -maxdepth 1 -name '*.app' -print -quit)"
    [[ -n "$app" ]] || { echo "::error::no .app inside $(basename "$dmg"):"; ls -la "$mount"; exit 1; }
    mkdir -p "$scratch/Applications"
    ditto "$app" "$scratch/Applications/$(basename "$app")"
    detach
    smoke_engine "dmg ($(basename "$app"))" "$scratch/Applications/$(basename "$app")/Contents/MacOS/folder-sync" ;;

  *) echo "smoke_install.sh: no installer smoke for '$os'" >&2; exit 2 ;;
esac

exit "$failed"
