# Vendored for the dev view

- `chart.umd.js`: [Chart.js](https://www.chartjs.org) **4.4.7**, the unmodified `dist/chart.umd.js` of the npm package `chart.js@4.4.7` (MIT, `chart.js-LICENSE.md`). `scripts/status-render.mjs` inlines it into the page, so the page stays one self-contained file (no CDN).
- To change the version: `npm pack chart.js@<version>`, copy `package/dist/chart.umd.js` here, and update this line and the `CHART_JS_VERSION` in `scripts/status-render.mjs`.
