// Screenshots of the dev view (scripts/status's index.html) for the Nov 4 report (docs/report/build_nov4.py):
// the overview in light and dark, a gate's drill-down (#g4), and phone width. Headless Chromium; nothing is shown on screen.
//
//   node docs/report/shoot_dev_view.mjs <dev-view index.html> <out dir> [<package.json whose node_modules has playwright>]
//
// WHY the third argument: playwright lives in ui/node_modules (npm --prefix ui ci); a report built from another checkout
// points at that checkout's ui/package.json instead of installing a second copy.
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [page, out, pkg = resolve(here, "../../ui/package.json")] = process.argv.slice(2);
if (!page || !out) {
	console.error("usage: node docs/report/shoot_dev_view.mjs <index.html> <out dir> [<ui/package.json>]");
	process.exit(2);
}
const { chromium } = createRequire(pkg)("playwright");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const views = [
	["top", 1100, "light", ""],
	["dark", 1100, "dark", ""],
	["g4", 1100, "light", "#g4"],
	["phone", 390, "light", ""],
];
for (const [name, width, scheme, hash] of views) {
	const tab = await browser.newPage({ viewport: { width, height: 860 }, colorScheme: scheme });
	await tab.goto(`file://${resolve(page)}${hash}`);
	await tab.waitForTimeout(600);
	const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	if (overflow > 0) console.error(`${name}: ${overflow}px of sideways scroll`);
	await tab.screenshot({ path: `${out}/dev-${name}.png` });
	await tab.close();
	console.log(`${out}/dev-${name}.png`);
}
await browser.close();
