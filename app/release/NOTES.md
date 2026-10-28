**folder-sync {version}**: a folder you can throw anything into and open on any of your computers.

These builds are **not signed** yet, so your computer warns the first time you open the app. That is expected. The
SHA-256 of every file is below and in `SHA256SUMS`.

## Install

**Mac** (`…-macos-universal.dmg`, Apple silicon and Intel, macOS 11+)
1. Open the `.dmg` and drag **folder-sync** into **Applications**.
2. Open it from Applications. macOS says it "cannot verify" the developer. Click **Done** (not Move to Trash).
3. Open **System Settings → Privacy & Security**, scroll down to *"folder-sync" was blocked*, and click **Open Anyway**.
   Confirm with your password. (On macOS 14 and older you can instead right-click the app → **Open** → **Open**.)
4. If macOS instead says the app "is damaged", run this once in Terminal, then open it again:
   `xattr -dr com.apple.quarantine /Applications/folder-sync.app`

**Windows** (`…-windows-x64-setup.exe`; the `.msi` is the same app for an all-users install)
1. Run the `-setup.exe`. It installs for you only and needs no admin rights.
2. SmartScreen says *"Windows protected your PC"*. Click **More info → Run anyway**.
3. folder-sync starts in the tray (bottom right; it may be under the **^** arrow).

**Linux** (`…-linux-x86_64.AppImage` or `…-linux-amd64.deb`)
- AppImage: `chmod +x folder-sync-*.AppImage`, then run it. It needs a tray (GNOME: the AppIndicator extension).
- Debian/Ubuntu: `sudo apt install ./folder-sync-*-linux-amd64.deb`, then open **folder-sync** from your apps.

## First run

1. Click **Sign in**. Your browser opens the approval page; sign in there and click **Approve**.
2. Click **Create folder** (`~/robotparts`; on Windows `Documents\robotparts`).
3. Drop a file in. It shows up on your other computers and online.

Each download is checked against its SHA-256: `shasum -a 256 <file>` (Mac), `Get-FileHash <file>` (Windows
PowerShell), `sha256sum <file>` (Linux).
