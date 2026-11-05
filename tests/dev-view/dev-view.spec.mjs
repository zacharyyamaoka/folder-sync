// The generated page in Chromium: at-a-glance values, one drill-down per kind, phone width, light and dark.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "./pw.mjs";
import { healthLines } from "./health-lines.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const NOW = "2026-11-04T19:00:00Z";
let page_url;
let empty_url;
let ok_url;
let stalled_url;

test.beforeAll(() => {
	const fixtures = join(root, "tests/fixtures/dev-view");
	const make = (kpi, gates) => {
		const out = mkdtempSync(join(tmpdir(), "devview-pw-"));
		execFileSync(join(root, "scripts/status"), ["--kpi", kpi, "--gates", gates, "--history", gates.startsWith("/nonexistent") ? "/nonexistent/h.jsonl" : join(fixtures, "gates-history.jsonl"), "--competitors", gates.startsWith("/nonexistent") ? "/nonexistent/c.json" : join(fixtures, "competitors.json"), "--out", out, "--now", NOW]);
		return "file://" + join(out, "index.html");
	};
	// the same series with the live stall check's points appended: healthy, and stalled on a held lock
	const withHealth = (mode) => {
		const file = join(mkdtempSync(join(tmpdir(), "devview-kpi-")), `kpi-${mode}.jsonl`);
		writeFileSync(file, readFileSync(join(fixtures, "kpi-series.jsonl"), "utf8") + healthLines(mode));
		return file;
	};
	page_url = make(join(fixtures, "kpi-series.jsonl"), join(fixtures, "gates.json"));
	ok_url = make(withHealth("ok"), join(fixtures, "gates.json"));
	stalled_url = make(withHealth("stalled"), join(fixtures, "gates.json"));
	empty_url = make("/nonexistent/kpi.jsonl", "/nonexistent/gates.json");
});

test("at a glance: three objective cards with test and prod values, and the twelve gates", async ({ page }) => {
	await page.goto(page_url);
	const o1 = page.locator("#card-o1");
	await expect(o1).toContainText("Fast");
	await expect(o1.locator('[data-cell="propagation_p50_ms:test"]')).toContainText("1.2 s");
	await expect(o1.locator('[data-cell="propagation_p50_ms:test"]')).toHaveAttribute("data-status", "amber");
	await expect(o1.locator('[data-cell="propagation_p50_ms:prod"]')).toContainText("2.1 s");
	await expect(o1.locator('[data-cell="propagation_p50_ms:prod"]')).toHaveAttribute("data-status", "red");
	await expect(o1.locator('[data-cell="propagation_p95_ms:test"]')).toHaveAttribute("data-status", "ok");
	await expect(o1.locator("svg.spark")).toHaveCount(4);
	await expect(page.locator("#card-o2 [data-cell='storage_efficiency_h_30d_max:prod']")).toContainText("70");
	await expect(page.locator("#card-o3 [data-cell='cost_per_person_month_usd:prod']")).toContainText("$0.15");
	await expect(page.locator("#card-o3 [data-cell='idle_cpu_pct:prod']")).toContainText("not measured yet");
	const pills = page.locator("a.gate-pill");
	await expect(pills).toHaveCount(12);
	await expect(page.locator("#pill-g1")).toHaveAttribute("data-status", "pass");
	await expect(page.locator("#pill-g2")).toHaveAttribute("data-status", "fail");
	await expect(page.locator("#pill-g5")).toHaveAttribute("data-status", "not_built");
	await expect(page.locator("#pill-g12")).toHaveAttribute("data-status", "unknown");
	// nothing is open until asked for
	await expect(page.locator("#o1")).toBeHidden();
	await expect(page.locator("#g2")).toBeHidden();
});

test("drill into an objective: a Chart.js chart per slice with a hover tooltip, a table, and the x axis toggle", async ({ page }) => {
	await page.goto(page_url);
	await page.locator("#card-o1").click();
	const detail = page.locator("#o1");
	await expect(detail).toBeVisible();
	await expect(detail.locator(".chart canvas")).not.toHaveCount(0);
	await expect(detail.getByRole("heading", { name: /Propagation p50/ })).toBeVisible();
	const row = detail.locator("tr", { hasText: "machine->web" }).filter({ hasText: "edit" }).first();
	await expect(row).toContainText("test");
	await expect(row).toContainText("1.2 s");
	await expect(detail).toContainText("legacy");
	// the chart is drawn (Chart.js instance with a test line and a dashed target), and hovering its first point shows value, commit and time
	await expect.poll(() => page.evaluate(() => Object.keys(window.__devCharts).length)).toBeGreaterThan(0);
	const shape = await page.evaluate(() => { const c = window.__devCharts[0]; return { labels: c.data.datasets.map((d) => d.label), dash: c.data.datasets.at(-1).borderDash, x: c.options.scales.x.ticks.callback.name }; });
	expect(shape.labels).toEqual(["test", "target"]);
	expect(shape.dash).toEqual([4, 3]);
	await page.locator("#o1 canvas").first().scrollIntoViewIfNeeded();
	const at = await page.evaluate(() => { const c = window.__devCharts[0]; const p = c.getDatasetMeta(0).data.at(-1); const r = c.canvas.getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; });
	await page.mouse.move(at.x, at.y);
	await expect.poll(() => page.evaluate(() => window.__devCharts[0].tooltip.title?.[0] ?? "")).toMatch(/^[0-9a-f]{7} · 2026-11-04 \d\d:\d\d UTC$/);
	expect(await page.evaluate(() => window.__devCharts[0].tooltip.body[0].lines[0])).toBe("test: 640 ms");
	// commits on the x axis: the same points, one slot per commit, ticks are short shas
	await detail.getByRole("button", { name: "Commits" }).click();
	await expect(detail.getByRole("button", { name: "Commits" })).toHaveAttribute("aria-pressed", "true");
	const ticks = await page.evaluate(() => { const c = window.__devCharts[0]; c.update(); return c.scales.x.ticks.map((t) => t.label).filter(Boolean); });
	expect(ticks.length).toBeGreaterThan(0);
	expect(ticks.every((t) => /^[0-9a-f]{7}\+?$|^unknown$/.test(t))).toBe(true);
	await detail.getByRole("button", { name: "Time" }).click();
	await page.locator("#o1 a.close").click();
	await expect(detail).toBeHidden();
});

test("gate history: a grid of gates by runs, green red or grey, with a tooltip naming the commit, the date and the failing test", async ({ page }) => {
	await page.goto(page_url);
	const grid = page.locator(".hgrid");
	await expect(grid.locator("tbody tr")).toHaveCount(12);
	await expect(grid.locator("thead th.run")).toHaveCount(8);
	const g1 = grid.locator("tbody tr").first().locator(".hc");
	await expect(g1.first()).toHaveAttribute("data-status", "fail"); // the oldest run (local)
	await expect(g1.nth(5)).toHaveAttribute("data-status", "pass");
	await expect(g1.nth(2)).toHaveAttribute("data-status", "none"); // a CI run that uploaded no gates file
	await expect(grid.locator("tbody tr").nth(10).locator(".hc").first()).toHaveAttribute("data-status", "not_built");
	await g1.nth(1).hover();
	await expect(page.locator("#tip")).toBeVisible();
	await expect(page.locator("#tip")).toContainText("29b6e83");
	await expect(page.locator("#tip")).toContainText("2026-11-03 21:22 UTC");
	await expect(page.locator("#tip")).toContainText("go ./e2e TestSharedTree");
});

test("is it syncing: calm when ok, a red bar naming the cause when a check is stalled, the strip and the chart in the drill-down", async ({ page }) => {
	await page.goto(ok_url);
	await expect(page.locator(".alert")).toHaveCount(0);
	await expect(page.locator(".livebar")).toContainText("canary file online in");
	await expect(page.locator(".livebar")).toContainText("3 folders checked, none stalled");
	await page.goto(stalled_url);
	const alert = page.locator(".alert");
	await expect(alert).toBeVisible();
	await expect(alert).toContainText("Sync stalled");
	await expect(alert).toContainText("lock held by pid 4242");
	expect(await alert.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(208, 59, 59)");
	await alert.click();
	const live = page.locator("#live");
	await expect(live).toBeVisible();
	await expect(live.locator(".sc")).toHaveCount(40 + 3); // the strip and its three legend swatches
	await expect(live.locator(".strip .sc[data-result='stalled']")).toHaveCount(3);
	await expect(live.locator(".strip .sc[data-result='offline']")).toHaveCount(1);
	await expect(live.locator("tr", { hasText: "zach" })).toContainText("held lock");
	await expect(live.locator("canvas")).toHaveCount(1);
});

test("the live check that has not run for hours is not 'ok'; with no points it says not measured yet", async ({ page }) => {
	await page.goto(empty_url);
	await expect(page.locator(".livebar")).toContainText("not measured yet");
	await expect(page.locator(".livebar")).toHaveAttribute("data-live", "none");
});

test("competitor prices: one line under O3 and a table with folder-sync's own row", async ({ page }) => {
	await page.goto(page_url);
	await expect(page.locator("#card-o3 [data-competitors]")).toContainText("per person-month at 10 GB");
	await page.locator("#card-o3").click();
	const table = page.locator("#m-competitors table");
	await expect(table.locator("tr.own")).toContainText("folder-sync");
	await expect(table.locator("tbody tr")).toHaveCount(4);
	await expect(table).toContainText("FIXTURE");
});

test("drill into a gate: its tests with status, duration, detail, evidence", async ({ page }) => {
	await page.goto(page_url);
	await page.locator("#pill-g2").click();
	const g = page.locator("#g2");
	await expect(g).toBeVisible();
	await expect(g).toContainText("Version history");
	const failing = g.locator("tr", { hasText: "deleted file restorable" });
	await expect(failing).toContainText("fail");
	await expect(failing).toContainText("2.3 s");
	await expect(failing).toContainText("<script>alert(1)</script>"); // shown as text, not run
	await expect(g.locator("a[href^='https://']")).toHaveCount(0);
	await page.locator("#pill-g1").click();
	await expect(page.locator("#g1 a[href='https://example.com/runs/1234']")).toBeVisible();
});

test("nothing measured yet: the page still opens and says so", async ({ page }) => {
	await page.goto(empty_url);
	await expect(page.locator("#card-o1")).toContainText("not measured yet");
	await expect(page.locator("a.gate-pill")).toHaveCount(12);
	await expect(page.locator("#pill-g1")).toHaveAttribute("data-status", "unknown");
});

test("phone width: no sideways scroll, with a drill-down open", async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 800 });
	await page.goto(page_url);
	const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	expect(await overflow()).toBeLessThanOrEqual(0);
	await page.locator("#card-o1").click();
	expect(await overflow()).toBeLessThanOrEqual(0);
	await page.locator("#pill-g2").click();
	expect(await overflow()).toBeLessThanOrEqual(0);
	await page.goto(stalled_url + "#live");
	expect(await overflow()).toBeLessThanOrEqual(0);
});

test("dark scheme repaints the page; the theme attribute wins both ways", async ({ page }) => {
	await page.goto(page_url);
	const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
	const light = await bg();
	await page.emulateMedia({ colorScheme: "dark" });
	const dark = await bg();
	expect(dark).not.toBe(light);
	await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
	expect(await bg()).toBe(light);
});

test("screenshots: light, dark, phone (when DEV_VIEW_SHOTS is set)", async ({ page }) => {
	const dir = process.env.DEV_VIEW_SHOTS;
	test.skip(!dir, "set DEV_VIEW_SHOTS=<dir>");
	mkdirSync(dir, { recursive: true });
	const shot = async (name, hash, url = page_url) => {
		await page.goto(url + (hash ?? ""));
		await page.waitForTimeout(300);
		await page.screenshot({ path: join(dir, `${name.startsWith("history-") ? "" : "dev-view-2026-11-04-"}${name}.png`), fullPage: true });
	};
	await shot("light");
	await shot("light-objective", "#o1");
	await shot("light-gate", "#g2");
	await page.emulateMedia({ colorScheme: "dark" });
	await shot("dark");
	await shot("dark-objective", "#o3");
	await page.emulateMedia({ colorScheme: "light" });
	await page.setViewportSize({ width: 375, height: 800 });
	await shot("phone");
	await shot("phone-objective", "#o1");
	await page.setViewportSize({ width: 1100, height: 800 });
	await shot("history-2026-11-04-light-charts", "#o1", ok_url);
	await shot("history-2026-11-04-light-live-stalled", "#live", stalled_url);
	await page.emulateMedia({ colorScheme: "dark" });
	await shot("history-2026-11-04-dark-charts", "#o1", ok_url);
	await shot("history-2026-11-04-dark-live-stalled", "#live", stalled_url);
	await shot("history-2026-11-04-dark-o3-costs", "#o3", ok_url);
	await page.emulateMedia({ colorScheme: "light" });
	await shot("history-2026-11-04-light-o3-costs", "#o3", ok_url);
	await page.setViewportSize({ width: 375, height: 800 });
	await shot("history-2026-11-04-phone", "", stalled_url);
});
