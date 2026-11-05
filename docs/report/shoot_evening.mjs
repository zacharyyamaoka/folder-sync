// Screenshots and measurements for the evening section of the Nov 4 report (docs/report/build_nov4.py --earlier ...):
// the live landing page at desktop and phone width, with its sideways overflow measured, and the dev view rendered from the
// real KPI series (scripts/status --out <dir>). Headless Chromium; nothing is shown on screen.
//
//   node docs/report/shoot_evening.mjs <dev-view index.html> <out dir> [<landing URL>] [<package.json whose node_modules has playwright>]
//
// Writes <out>/evening-shots.json beside the PNGs. WHY a JSON: the report states "no sideways scroll at 390 px" and the
// download links as measured facts, so the builder reads them from this run instead of the prose asserting them.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [devView, out, landing = "https://zacharyyamaoka.github.io/folder-sync/", pkg = resolve(here, "../../ui/package.json")] = process.argv.slice(2);
if (!devView || !out) {
	console.error("usage: node docs/report/shoot_evening.mjs <dev-view index.html> <out dir> [<landing URL>] [<ui/package.json>]");
	process.exit(2);
}
const { chromium } = createRequire(pkg)("playwright");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const facts = { landing: { url: landing, widths: {} }, devView: { page: resolve(devView) } };

// the widest element that reaches past the viewport and is not inside its own sideways-scrolling box
const measure = () => {
	const cw = document.documentElement.clientWidth;
	const inScroller = (e) => {
		for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
			const ox = getComputedStyle(p).overflowX;
			if (ox === "auto" || ox === "scroll" || ox === "hidden") return true;
		}
		return false;
	};
	const wide = [...document.querySelectorAll("body *")]
		.filter((e) => e.getBoundingClientRect().right > cw + 1 && !inScroller(e))
		.slice(0, 5)
		.map((e) => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${e.className && typeof e.className === "string" ? "." + e.className.split(" ")[0] : ""}`);
	return { scrollWidth: document.documentElement.scrollWidth, clientWidth: cw, wide };
};

for (const [name, width, height, scheme] of [["desktop", 1280, 860, "light"], ["phone", 390, 844, "light"], ["phone-dark", 390, 844, "dark"]]) {
	const tab = await browser.newPage({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 1 });
	const response = await tab.goto(landing, { waitUntil: "networkidle" });
	facts.landing.status = response ? response.status() : null;
	await tab.waitForTimeout(1200);
	// the hero videos autoplay; pause them on a set frame so two runs give the same picture, and wait until that frame is painted
	await tab.evaluate(() => Promise.all([...document.querySelectorAll("video")].map((v) => new Promise((done) => {
		v.pause();
		const settle = () => setTimeout(done, 300);
		if (!(v.duration > 0)) { v.addEventListener("loadedmetadata", () => { v.currentTime = Math.min(6, v.duration); }, { once: true }); }
		v.addEventListener("seeked", settle, { once: true });
		try { if (v.duration > 0) v.currentTime = Math.min(6, v.duration); } catch (e) { /* not seekable yet */ }
		setTimeout(done, 4000);
	}))));
	facts.landing.widths[name] = await tab.evaluate(measure);
	if (name === "desktop") {
		facts.landing.downloads = await tab.evaluate(() => [...document.querySelectorAll("a[href*='/releases/download/desktop-v']")].map((a) => ({ text: a.textContent.trim().replace(/\s+/g, " "), href: a.href })));
		facts.landing.gatesLine = await tab.evaluate(() => (document.body.innerText.match(/\d+ of 12 gates pass/) || [null])[0]);
		facts.landing.journeyVideo = await tab.evaluate(() => [...document.querySelectorAll("video")].map((v) => v.currentSrc || v.src).filter((s) => /desktop-journey/.test(s)));
	}
	await tab.screenshot({ path: `${out}/landing-${name}-top.png` });
	// WHY a clip of the full page, not an element screenshot: scrolling the section into view puts the sticky header over
	// its heading; on the full page the header stays at the top
	const box = await tab.evaluate(() => { const e = document.getElementById("desktop"); if (!e) return null; const r = e.getBoundingClientRect(); return { y: r.top + window.scrollY, h: r.height }; });
	if (box) await tab.screenshot({ path: `${out}/landing-${name}-desktop.png`, fullPage: true, clip: { x: 0, y: box.y, width, height: box.h } });
	await tab.close();
	console.log(`landing ${name}: ${JSON.stringify(facts.landing.widths[name])}`);
}

// the dev view on the real series: the overview (live bar, cards, gates, gate history) and O1's charts
for (const [name, hash, scheme] of [["top", "", "light"], ["o1", "#o1", "light"], ["top-dark", "", "dark"]]) {
	const tab = await browser.newPage({ viewport: { width: 1100, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1 });
	await tab.goto(`file://${resolve(devView)}${hash}`);
	await tab.waitForTimeout(1500);
	if (hash) {
		const box = await tab.evaluate((id) => { const e = document.getElementById(id); if (!e) return null; const r = e.getBoundingClientRect(); return { y: r.top + window.scrollY, h: r.height }; }, hash.slice(1));
		facts.devView[name] = box;
		if (box) await tab.screenshot({ path: `${out}/devreal-${name}.png`, fullPage: true, clip: { x: 0, y: box.y, width: 1100, height: Math.min(box.h, 1500) } });
	} else {
		await tab.screenshot({ path: `${out}/devreal-${name}.png`, fullPage: true });
	}
	facts.devView.builtLine = await tab.evaluate(() => (document.body.innerText.match(/Built [^\n]*/) || [null])[0]);
	await tab.close();
	console.log(`dev view ${name}`);
}
facts.shotAt = new Date().toISOString();
writeFileSync(`${out}/evening-shots.json`, JSON.stringify(facts, null, 2));
await browser.close();
console.log(`${out}/evening-shots.json`);
