// Screenshots of every view, light and dark, for the review report: FS_SHOTS=<dir> npx playwright test screens.
// Skipped without FS_SHOTS. Each picture is the element over the frozen fixtures, as test/view.spec.mjs drives it.
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { GPU, startStub } from "./stub.mjs";

const OUT = process.env.FS_SHOTS;
const NOW = new Date("2026-10-28T21:12:00Z");

test.skip(!OUT, "set FS_SHOTS=<dir> to write the screenshots");

for (const scheme of ["light", "dark"]) {
	test.describe(scheme, () => {
		test.use({ colorScheme: scheme });
		let stub = null;
		test.afterEach(async () => { if (stub) await stub.close(); stub = null; });

		const shot = (page, name) => page.screenshot({ path: `${OUT}/chromium-${scheme}-${name}.png` });
		async function load(page, scenario, { query = "", before } = {}) {
			mkdirSync(OUT, { recursive: true });
			stub = await startStub({ scenario });
			if (before) before(stub);
			await page.clock.install({ time: NOW });
			await page.goto(`${stub.url}/app.html${query}`);
			await page.waitForFunction(() => document.querySelector("folder-sync-status")?.shadowRoot?.querySelector(".pill:not([data-state='unknown']), .panel .body[data-view]"));
		}
		const el = (page, css) => page.locator(`folder-sync-status ${css}`);
		const openMenu = async (page) => { await el(page, ".pill").click(); await expect(el(page, "#menu")).toBeVisible(); };
		const openView = async (page, label) => { await openMenu(page); await el(page, "#menu").getByRole("menuitem", { name: label }).click(); await expect(el(page, ".panel")).toBeVisible(); };

		test("online: pill, menu, activity, history, deleted, restore, free up space", async ({ page }) => {
			await load(page, "online", { before: (s) => s.route("POST", (u) => u.pathname.endsWith("/history/purge"), "purge-older", "purge-version") });
			await shot(page, "01-pill");
			await openMenu(page);
			await shot(page, "02-menu-online");
			await el(page, "#menu").getByRole("button", { name: "Free up space" }).click();
			await shot(page, "03-menu-free-up-ask");
			await el(page, "#menu").getByRole("button", { name: "Delete" }).click();
			await expect(el(page, "#menu")).toContainText("Freed");
			await shot(page, "04-menu-freed");
			await el(page, "#menu").getByRole("menuitem", { name: "Activity log" }).click();
			await expect(el(page, ".log .row").first()).toBeVisible();
			await shot(page, "05-activity-online");
			await el(page, ".log .row").filter({ hasText: "Edited notes/plan.md" }).getByRole("button", { name: "notes/plan.md" }).click();
			await el(page, ".versions button").nth(1).click();
			await expect(el(page, ".versions button").nth(1)).toHaveAttribute("aria-current", "true");
			await expect(el(page, "pre[data-diff] .add")).toHaveCount(2);
			await shot(page, "06-history-diff");
			await el(page, "#changes").uncheck();
			await shot(page, "07-history-plain");
			await el(page, "#changes").check();
			await el(page, ".versions button").nth(2).click();
			await expect(el(page, "pre[data-diff] .add")).toHaveCount(1);
			await el(page, "[data-act=restore-version]").click();
			await expect(el(page, "[data-restore=failed]")).toBeVisible();
			await shot(page, "08-history-restored");
			await el(page, "[role=tab]").filter({ hasText: "Version history" }).click();
			await el(page, "[data-act=pick-file]").click();
			await expect(el(page, ".files li").first()).toBeVisible();
			await shot(page, "09-history-pick-file");
			await el(page, "[role=tab]").filter({ hasText: "Deleted files" }).click();
			await el(page, "tbody tr").nth(0).locator("input").check();
			await el(page, "tbody tr").nth(2).locator("input").check();
			await shot(page, "10-deleted-selected");
			await el(page, "[data-act=restore-picked]").click();
			await expect(el(page, "[data-restore=requested]")).toBeVisible();
			await shot(page, "11-deleted-restored");
		});

		test("the split, dragged wider", async ({ page }) => {
			await load(page, "online");
			await page.evaluate((host) => document.querySelector("folder-sync-status").open("history", { host, path: "notes/plan.md" }), GPU);
			await expect(el(page, "#content pre")).toBeVisible();
			const h = await el(page, "#handle").boundingBox();
			await page.mouse.move(h.x + 3, h.y + 60);
			await page.mouse.down();
			await page.mouse.move(h.x + 123, h.y + 60, { steps: 6 });
			await page.mouse.up();
			await shot(page, "12-history-split-dragged");
		});

		test("serve: menu, activity filtered to errors, offline", async ({ page }) => {
			await load(page, "serve");
			await openMenu(page);
			await shot(page, "13-menu-serve");
			await el(page, "#menu").getByRole("menuitem", { name: "Activity log" }).click();
			await expect(el(page, ".log .row").first()).toBeVisible();
			await shot(page, "14-activity-serve");
			await el(page, "[data-filter=errors]").click();
			await shot(page, "15-activity-serve-errors");
			await el(page, "[data-filter=skipped]").click();
			await shot(page, "16-activity-serve-skipped");
			await stub.close();
			await load(page, "offline");
			await openMenu(page);
			await shot(page, "17-menu-offline");
		});

		test("errors: signed out, no token, reader", async ({ page }) => {
			await load(page, "online", { before: (s) => s.route("GET", (u) => u.pathname.endsWith("/status"), "error-signed-out") });
			await openMenu(page);
			await shot(page, "18-menu-signed-out");
			await stub.close();
			await load(page, "serve", { before: (s) => s.route("GET", (u) => u.pathname.endsWith("/status"), "error-serve-no-token") });
			await openMenu(page);
			await shot(page, "19-menu-no-token");
			await stub.close();
			await load(page, "reader", { query: "?owner=AbC123" });
			await openMenu(page);
			await shot(page, "20-menu-reader");
			await stub.close();
			await load(page, "online", { before: (s) => s.route("GET", (u) => (u.searchParams.get("version") || "").endsWith("1b2c3d4e5f607182"), "error-pruned") });
			await page.evaluate((host) => document.querySelector("folder-sync-status").open("history", { host, path: "notes/plan.md" }), GPU);
			await el(page, ".versions button").nth(4).click();
			await expect(el(page, "[data-error=pruned]")).toBeVisible();
			await shot(page, "21-history-pruned");
		});

		test("inline (view=) and themed by the app", async ({ page }) => {
			await load(page, "serve", { query: "?view=history" });
			await shot(page, "22-inline-view");
			await stub.close();
			await load(page, "online", { query: `?theme=${encodeURIComponent("--fs-accent: #8250df; --fs-bg: #fbf7ef; --fs-fg: #3b2f1e; --fs-muted: #8a7a63; --fs-font: Georgia, serif; --fs-radius: 3px")}` });
			await page.evaluate(() => document.querySelector("folder-sync-status").open("deleted"));
			await el(page, "#pick-all").check();
			await shot(page, "23-themed-by-app");
		});
	});
}
