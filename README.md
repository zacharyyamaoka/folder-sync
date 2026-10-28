# folder-sync landing page

This branch (`gh-pages`) holds only the landing page for [folder-sync](https://github.com/zacharyyamaoka/folder-sync): one static `index.html` with inline CSS and a few lines of script (the platform tabs and the theme button), and its media. `.nojekyll` tells GitHub Pages to serve it as is.

The source of the project is on the other branches. Edit `index.html` here and push this branch to update the page. Every number on the page has its source in an HTML comment beside it.

## Media

- `media/hero.mp4` (H.264 constrained baseline, 1280x720, 16 s, muted), `media/hero.gif` (fallback) and `media/hero-poster.png`, plus `media/still-*.png`: recorded 2026-10-28 from the real product, not mocked.
- `tools/record_hero.py` records them: `tools/setup.mjs` stands up main's accounts Worker on loopback (`accounts/scripts/dev.mjs`: `wrangler dev`, a local D1, `rclone serve s3` behind the R2 stand-in) and signs two machines (two HOMEs) in to one test person; the stage (`tools/stage.html`) runs the CLI, writes files into machine A's folder, reads machine B's folder and the Worker's public folder API, and Playwright's headless Chromium records it. Each caption's time is measured in that run: a write on disk until the Worker serves the same bytes (polled every 25 ms), and until machine B's disk holds them (every 10 ms). `tools/hero-run.json` is the run the published video came from.

```bash
node tools/setup.mjs up --repo <checkout of main> --work <empty dir> --cli <folder-sync binary> > setup.json
uv run --with playwright==1.55.0 python tools/record_hero.py --setup setup.json --cli <folder-sync binary> --out <dir>
node tools/setup.mjs down --repo <checkout of main> --work <same dir>
```

`setup.mjs` needs `RCLONE` (the pinned rclone) and, if the defaults are taken, `FS_STANDIN_PORT`, `FS_STORE_PORT`, `FS_ACCOUNTS_PORT` and `FS_INSPECTOR_PORT`. `record_hero.py` points Playwright at a local Chromium build (`CHROME`); ffmpeg turns the recording into the MP4, GIF and poster.
