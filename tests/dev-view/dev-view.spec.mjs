// The generated page in Chromium: at-a-glance values, one drill-down per kind, phone width, light and dark.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "./pw.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const NOW = "2026-11-04T19:00:00Z";
let page_url;
let empty_url;

test.beforeAll(() => {
	const make = (kpi, gates) => {
		const out = mkdtempSync(join(tmpdir(), "devview-pw-"));
		execFileSync(join(root, "scripts/status"), ["--kpi", kpi, "--gates", gates, "--out", out, "--now", NOW]);
		return "file://" + join(out, "index.html");
	};
	page_url = make(join(root, "tests/fixtures/dev-view/kpi-series.jsonl"), join(root, "tests/fixtures/dev-view/gates.json"));
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

test("drill into an objective: small charts per slice and a table", async ({ page }) => {
	await page.goto(page_url);
	await page.locator("#card-o1").click();
	const detail = page.locator("#o1");
	await expect(detail).toBeVisible();
	await expect(detail.locator(".chart")).not.toHaveCount(0);
	await expect(detail.getByRole("heading", { name: /Propagation p50/ })).toBeVisible();
	const row = detail.locator("tr", { hasText: "machine->web" }).filter({ hasText: "edit" }).first();
	await expect(row).toContainText("test");
	await expect(row).toContainText("1.2 s");
	await expect(detail).toContainText("legacy");
	await detail.locator(".chart circle.hit").first().hover();
	await expect(page.locator("#tip")).toBeVisible();
	await page.locator("#o1 a.close").click();
	await expect(detail).toBeHidden();
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
	const shot = async (name, hash) => {
		await page.goto(page_url + (hash ?? ""));
		await page.screenshot({ path: join(dir, `dev-view-2026-11-04-${name}.png`), fullPage: true });
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
});
