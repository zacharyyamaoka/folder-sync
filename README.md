# folder-sync landing page

This branch (`gh-pages`) holds only the landing page for [folder-sync](https://github.com/zacharyyamaoka/folder-sync): one static `index.html` with inline CSS and a few lines of script (the platform tabs and the theme button), and its media. `.nojekyll` tells GitHub Pages to serve it as is.

The source of the project is on the other branches. Edit `index.html` here and push this branch to update the page. Every number on the page has its source in an HTML comment beside it.

## The objectives and gates block is generated

`index.html` carries the three objectives with their current values and the G1..G12 strip between `<!-- status:begin -->` and `<!-- status:end -->`. Do not edit between them. `tools/update-status` rewrites that block from the hourly KPI series (`~/vt/zach/producers/folder-sync/kpi_series.jsonl`) and the last gate run (`reports/status/gates.json` in the main checkout) with `scripts/readme-status` from a checkout of folder-sync's main work (`FOLDER_SYNC_REPO`, default `~/folder-sync`); `tools/update-status --check` exits 1 when the page is stale. The same script writes the block in the main README.

## Media

- `media/demo.mp4`, `media/demo.webm` (muted, about 30 s, 1280x720), `media/demo.gif` (fallback) and `media/demo-poster.png`: recorded 2026-11-04 by `ui/scripts/record-demo.mjs` on the main branch, from the real local stack (the real CLI and the real Files page), not mocked. Copy them from `docs/media/` there when the recording is redone.
- `tools/record_hero.py`, `tools/setup.mjs`, `tools/stage.html` and `tools/hero-run.json` are the earlier (2026-10-28) hero recorder, kept for history; the page no longer uses its media.
