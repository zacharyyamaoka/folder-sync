# folder-sync

Point it at any folder; that folder is now on every machine you use, and readable online.

- **Local files are the truth.** Any tool, editor or AI agent works on plain files in a plain folder. Nothing has to go through an app.
- **Sync across machines.** Linux, Windows and macOS, with one install command that an agent can finish unaided. It runs headless as a background service, or alongside an app.
- **Readable online.** Every synced folder can also be viewed on the web (read-only is fine), and an app's own web UI can read the same files. Vibe Tracks is the first user, through `vibetracks.dev`.
- **A drop-in for any project.** A folder plus a small config file, with ignore rules. Many projects per machine. A cloud agent joins by installing the CLI and logging in.

```text
folder-sync init      # this folder becomes a synced folder
folder-sync sync      # once, or as a background service
folder-sync publish   # make it readable online
```

## What it does not do (in the spirit of Unix)

- It does not understand what's in the files. Apps like Vibe Tracks do that.
- It does not reinvent a sync engine where a stock one is good enough. It wraps the engine and owns only the missing piece: one simple command line, a Windows-safe install, per-project config, and the online read view.

## Status

Started 2026-10-20 as a separate project, split out of Vibe Tracks (Zach: "clearly a separate functionality that I can get right once and then reuse").

Still pending is the adopt / wrap / build decision. It waits on the research note "Local-Online File Sync — What Exists and What to Build (2026-10-20)" in the vault. The first decision record (`docs/peps/0001`) will follow from it.

The name is literal on purpose, like `stable_preview_switcher`: a plain repo name, not a brand. An unrelated Android app is also called FolderSync (foldersync.io).
