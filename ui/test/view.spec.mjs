// <folder-sync-status> in Chromium, driven over the frozen testdata/view-api/ fixtures through test/stub.mjs.
// What lane/view must prove (PEP 0007 §7): every fixture the element reads rendered, the error codes, keyboard and
// focus, no CSS leak either way, light and dark theming, no request off its origin, docs/API.md "The element"
// verbatim, and the resizable split measured with getBoundingClientRect.
import { expect, test } from "@playwright/test";
import { BYTES, GPU, LAPTOP, WEB, fixtures, served, startStub } from "./stub.mjs";

const NOW = new Date("2026-10-28T21:12:00Z");
const PLAN_9F2C = "2026-10-28T20:31:00.117Z_9f2c1a3b4c5d6e7f";
let stub = null;
const clocked = new WeakSet();

test.afterEach(async () => {
	if (stub) await stub.close();
	stub = null;
});

/** Loads the host page with the element over a fresh stub, the clock pinned to NOW. */
async function load(page, { scenario = "online", first = [], query = "", before } = {}) {
	stub = await startStub({ scenario, first });
	if (before) await before(stub);
	if (!clocked.has(page)) await page.clock.install({ time: NOW });
	clocked.add(page);
	await page.goto(`${stub.url}/app.html${query}`);
	await page.waitForFunction(() => {
		const el = document.querySelector("folder-sync-status");
		return el && el.shadowRoot && el.shadowRoot.querySelector(".pill:not([data-state='unknown']), .panel .body[data-view]");
	});
	return stub;
}

const pill = (page) => page.locator("folder-sync-status .pill");
const menu = (page) => page.locator("folder-sync-status #menu");
const panel = (page) => page.locator("folder-sync-status .panel");
const rows = (page) => page.locator("folder-sync-status .log .row");
const box = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; });
const active = (page) => page.evaluate(() => { const a = document.querySelector("folder-sync-status").shadowRoot.activeElement; return a ? (a.id || a.dataset.open || a.dataset.act || a.textContent.trim()) : null; });
const requests = (method, part) => stub.requests.filter((r) => r.method === method && r.path.includes(part));

async function openMenu(page) {
	await pill(page).click();
	await expect(menu(page)).toBeVisible();
}

async function openView(page, label) {
	await openMenu(page);
	await menu(page).getByRole("menuitem", { name: label }).click();
	await expect(panel(page)).toBeVisible();
}

async function openPlanHistory(page) {
	await page.evaluate((host) => document.querySelector("folder-sync-status").open("history", { host, path: "notes/plan.md" }), GPU);
	await expect(page.locator("folder-sync-status .versions button")).toHaveCount(5);
	await expect(page.locator("folder-sync-status #content pre")).toBeVisible();
}

test.describe("docs/API.md \"The element\", verbatim", () => {
	test("tag, attributes, methods, parts", async ({ page }) => {
		await load(page);
		const api = await page.evaluate(() => {
			const C = customElements.get("folder-sync-status"), el = document.querySelector("folder-sync-status");
			const parts = [...el.shadowRoot.querySelectorAll("[part]")].map((n) => n.getAttribute("part")).sort();
			return { attrs: C.observedAttributes, methods: ["open", "close", "refresh"].map((m) => typeof el[m]), parts };
		});
		expect(api.attrs).toEqual(["project", "owner", "base", "view"]);
		expect(api.methods).toEqual(["function", "function", "function"]);
		expect(api.parts).toEqual(["menu", "panel", "pill"]);
	});

	test("open(view, {host, path}), close() and refresh()", async ({ page }) => {
		await load(page);
		await page.evaluate((host) => document.querySelector("folder-sync-status").open("history", { host, path: "notes/old-ideas.md" }), GPU);
		await expect(panel(page)).toBeVisible();
		await expect(page.locator("folder-sync-status .versions button")).toHaveCount(1);
		await page.evaluate(() => document.querySelector("folder-sync-status").close());
		await expect(panel(page)).toBeHidden();
		const before = requests("GET", "/status").length;
		await page.evaluate(() => document.querySelector("folder-sync-status").refresh());
		expect(requests("GET", "/status").length).toBe(before + 1);
	});

	test("folder-sync:status fires with the status body, once per change", async ({ page }) => {
		await load(page);
		await page.evaluate(() => document.querySelector("folder-sync-status").refresh());
		let events = await page.evaluate(() => window.__events);
		expect(events.map((e) => e.name)).toEqual(["folder-sync:status"]);
		expect(events[0].detail).toEqual(fixtures["status-owner"].response.body);
		stub.route("GET", (u) => u.pathname.endsWith("/status"), "status-public");
		await page.evaluate(() => document.querySelector("folder-sync-status").refresh());
		events = await page.evaluate(() => window.__events);
		expect(events.length).toBe(2);
		expect(events[1].detail.role).toBe("public");
	});

	test("hidden hides the pill, and the app can still open a panel", async ({ page }) => {
		await load(page);
		await page.evaluate(() => { document.querySelector("folder-sync-status").hidden = true; });
		await expect(pill(page)).toBeHidden();
		await page.evaluate(() => document.querySelector("folder-sync-status").open("activity"));
		await expect(panel(page)).toBeVisible();
		await expect(rows(page)).toHaveCount(13);
	});

	test("view= opens that panel at once and shows no pill", async ({ page }) => {
		await load(page, { query: "?view=activity" });
		await expect(pill(page)).toHaveCount(0);
		await expect(page.locator("folder-sync-status div.panel")).toBeVisible();
		await expect(rows(page)).toHaveCount(13);
		await page.locator("folder-sync-status [role=tab]", { hasText: "Deleted files" }).click();
		await expect(page.locator("folder-sync-status tbody tr")).toHaveCount(3);
	});
});

test.describe("the pill and the menu", () => {
	test("owner online: headline, warnings in amber, devices, the three views, storage, the account link", async ({ page }) => {
		await load(page);
		await expect(pill(page)).toHaveAttribute("data-state", "attention");
		await expect(pill(page)).toContainText("2 things need you");
		await openMenu(page);
		const status = fixtures["status-owner"].response.body;
		for (const w of status.warnings) await expect(menu(page).locator(`[data-warning="${w.kind}"]`)).toHaveText(w.text);
		const amber = await menu(page).locator("[data-warning]").first().evaluate((el) => getComputedStyle(el).color);
		expect(amber).toBe("rgb(154, 103, 0)");
		await expect(menu(page).locator(".devices li")).toHaveCount(3);
		await expect(menu(page).locator(".devices")).toContainText("bam-laptop");
		await expect(menu(page).locator(".devices")).toContainText("6 d ago");
		for (const label of ["Activity log", "Version history", "Deleted files", "Devices and sharing"]) await expect(menu(page).getByRole("menuitem", { name: label })).toBeVisible();
		await expect(menu(page).getByRole("menuitem", { name: "Devices and sharing" })).toHaveAttribute("href", "/fs/account");
		await expect(menu(page).locator("[data-storage]")).toContainText("15.1 MB of 1.00 GB");
		await expect(menu(page).locator("[data-storage]")).toContainText("history 2.2 MB");
		await expect(menu(page).getByRole("button", { name: "Free up space" })).toBeVisible();
	});

	test("the menu opens above a bottom pill and below a top one, always on screen", async ({ page }) => {
		await load(page);
		await openMenu(page);
		let m = await box(menu(page)), p = await box(pill(page));
		expect(m.bottom).toBeLessThanOrEqual(p.top);
		expect(m.top).toBeGreaterThanOrEqual(0);
		expect(Math.abs(m.right - p.right)).toBeLessThan(2);
		await stub.close();
		await load(page, { query: "?bar=top" });
		await openMenu(page);
		m = await box(menu(page));
		p = await box(pill(page));
		expect(m.top).toBeGreaterThanOrEqual(p.bottom);
		expect(m.bottom).toBeLessThanOrEqual(700);
	});

	test("keyboard: Enter opens the menu on its first item, arrows move, Escape returns to the pill", async ({ page }) => {
		await load(page);
		await pill(page).focus();
		await page.keyboard.press("Enter");
		await expect(menu(page)).toBeVisible();
		await expect.poll(() => active(page)).toBe("activity");
		await page.keyboard.press("ArrowDown");
		expect(await active(page)).toBe("history");
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("ArrowUp");
		expect(await active(page)).toBe("Devices and sharing");
		await page.keyboard.press("Escape");
		await expect(menu(page)).toBeHidden();
		expect(await page.evaluate(() => document.querySelector("folder-sync-status").shadowRoot.activeElement.className)).toBe("pill");
	});

	test("keyboard: the dialog traps focus, tabs move with arrows, Escape closes it and focus returns to the pill", async ({ page }) => {
		await load(page);
		await openView(page, "Activity log");
		await expect.poll(() => active(page)).toBe("tab-activity");
		await page.keyboard.press("ArrowRight");
		await expect(page.locator("folder-sync-status .body")).toHaveAttribute("data-view", "history");
		for (let i = 0; i < 12; i++) {
			await page.keyboard.press("Tab");
			expect(await page.evaluate(() => { const el = document.querySelector("folder-sync-status"); return el.shadowRoot.querySelector("dialog").contains(el.shadowRoot.activeElement); })).toBe(true);
		}
		await page.keyboard.press("Escape");
		await expect(panel(page)).toBeHidden();
		await expect.poll(() => page.evaluate(() => document.querySelector("folder-sync-status").shadowRoot.activeElement?.className)).toBe("pill");
	});

	test("serve: this device first, its engine, the storage as last measured, nothing online-only, no hub", async ({ page }) => {
		const sockets = [];
		page.on("websocket", (ws) => sockets.push(ws.url()));
		await load(page, { scenario: "serve" });
		await expect(pill(page)).toHaveAttribute("data-state", "synced");
		await expect(pill(page)).toHaveText("Synced");
		await openMenu(page);
		await expect(menu(page).locator(".devices li").first()).toContainText("bam-GPU (this device)");
		await expect(menu(page).locator(".devices li").first()).toContainText("watching · last round 2 min ago");
		await expect(menu(page).locator(".head")).toContainText("/home/bam/notes");
		await expect(menu(page).locator("[data-storage]")).toContainText("measured 7 min ago");
		await expect(menu(page).getByRole("button", { name: "Free up space" })).toHaveCount(0);
		await expect(menu(page).getByRole("menuitem", { name: "Devices and sharing" })).toHaveCount(0);
		await expect(menu(page).locator("[data-warning]")).toHaveCount(0);
		expect(sockets).toEqual([]);
	});

	test("offline is never red: a dashed grey ring and the reason, quietly", async ({ page }) => {
		await load(page, { scenario: "offline" });
		await expect(pill(page)).toHaveAttribute("data-state", "offline");
		await expect(pill(page)).toHaveText("Offline · last synced 12 min ago");
		const ring = await pill(page).locator(".ring").evaluate((el) => { const s = getComputedStyle(el); return [s.borderTopStyle, s.borderTopColor, s.backgroundColor]; });
		expect(ring).toEqual(["dashed", "rgb(101, 109, 118)", "rgba(0, 0, 0, 0)"]);
		await openMenu(page);
		await expect(menu(page).locator(".note.info")).toContainText("does not answer (dial tcp: i/o timeout)");
		await expect(menu(page).locator(".note.error, .note.warn")).toHaveCount(0);
	});

	test("the server going away reads as offline, not as an error", async ({ page }) => {
		await load(page, { scenario: "serve" });
		await stub.close();
		await page.clock.runFor(10_000);
		await expect(pill(page)).toHaveAttribute("data-state", "offline");
		await expect(pill(page)).toHaveText("Offline");
	});

	test("a reader sees the pill and the devices only, and owner-only routes answer not_found", async ({ page }) => {
		await load(page, { scenario: "reader", query: "?owner=AbC123" });
		expect(stub.requests.find((r) => r.path.includes("/status")).path).toBe("/fs/v1/folders/notes/status?owner=AbC123");
		await expect(pill(page)).toHaveText("Synced");
		await openMenu(page);
		await expect(menu(page).locator(".devices li")).toHaveCount(3);
		await expect(menu(page).getByRole("menuitem")).toHaveCount(0);
		await expect(menu(page).locator("[data-storage]")).toHaveCount(0);
		await page.evaluate((host) => document.querySelector("folder-sync-status").open("history", { host, path: "notes/plan.md" }), GPU);
		await expect(page.locator("folder-sync-status [data-error=not_found]")).toHaveText(fixtures["error-reader-history"].response.body.why);
		expect(stub.requests.filter((r) => /activity|deleted/.test(r.path))).toEqual([]);
	});

	test("public: the pill and the devices only", async ({ page }) => {
		await load(page, { scenario: "public", query: "?owner=AbC123" });
		await expect(pill(page)).toHaveText("Synced");
		await openMenu(page);
		await expect(menu(page).locator(".devices li")).toHaveCount(3);
		await expect(menu(page).getByRole("menuitem")).toHaveCount(0);
	});

	test("free up space: asks first, calls again while more, then says what it freed", async ({ page }) => {
		await load(page, { before: (s) => s.route("POST", (u) => u.pathname.endsWith("/history/purge"), "purge-older", "purge-version") });
		await openMenu(page);
		await menu(page).getByRole("button", { name: "Free up space" }).click();
		await expect(menu(page)).toContainText("Delete history older than 7 days? This cannot be undone.");
		expect(requests("POST", "/history/purge")).toEqual([]);
		await menu(page).getByRole("button", { name: "Delete" }).click();
		await expect(menu(page)).toContainText("Freed 46.0 MB (1001 old versions).");
		const posts = requests("POST", "/history/purge");
		expect(posts.map((r) => r.body)).toEqual([{ older_than_days: 7 }, { older_than_days: 7 }]);
		expect(posts[0].headers["x-folder-sync"]).toBe("1");
	});
});

test.describe("the error codes, each where the element meets it", () => {
	for (const [name, label, state] of [
		["error-signed-out", "Signed out", "attention"],
		["error-serve-no-token", "Sync status unavailable", "error"],
		["error-serve-wrong-host", "Sync status unavailable", "error"],
		["error-serve-ambiguous", "Pick a folder", "attention"],
	]) {
		test(`status answers ${name}`, async ({ page }) => {
			await load(page, { scenario: "serve", before: (s) => s.route("GET", (u) => u.pathname.endsWith("/status"), name) });
			await expect(pill(page)).toHaveAttribute("data-state", state);
			await expect(pill(page)).toHaveText(label);
			await openMenu(page);
			await expect(menu(page).locator(".note")).toHaveText(fixtures[name].response.body.why);
			await expect(menu(page).locator(`.note.${state === "error" ? "error" : "warn"}`)).toHaveCount(1);
			if (name === "error-signed-out") await expect(menu(page).getByRole("menuitem", { name: "Sign in" })).toHaveAttribute("href", "/fs/signin?return=%2Fapp.html");
		});
	}

	test("activity answers signed_out: the reason and Sign in, amber", async ({ page }) => {
		await load(page, { before: (s) => s.route("GET", (u) => u.pathname.endsWith("/activity"), "error-signed-out") });
		await openView(page, "Activity log");
		const note = page.locator("folder-sync-status [data-error=signed_out]");
		await expect(note).toContainText(fixtures["error-signed-out"].response.body.why);
		await expect(note).toHaveClass(/warn/);
		await expect(note.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/fs/signin?return=%2Fapp.html");
	});

	test("a pruned version: the reason, and no Restore", async ({ page }) => {
		await load(page, { before: (s) => s.route("GET", (u) => (u.searchParams.get("version") || "").endsWith("1b2c3d4e5f607182"), "error-pruned") });
		await openPlanHistory(page);
		await page.locator("folder-sync-status .versions button").nth(4).click();
		await expect(page.locator("folder-sync-status [data-error=pruned]")).toHaveText(fixtures["error-pruned"].response.body.why);
		await expect(page.locator("folder-sync-status [data-act=restore-version]")).toBeDisabled();
	});

	test("a version id that is not one: bad_version", async ({ page }) => {
		await load(page, { before: (s) => s.route("GET", (u) => (u.searchParams.get("version") || "").endsWith("_unlisted"), "error-bad-version") });
		await openPlanHistory(page);
		await page.locator("folder-sync-status .versions button").nth(3).click();
		await expect(page.locator("folder-sync-status [data-error=bad_version]")).toHaveText(fixtures["error-bad-version"].response.body.why);
	});

	test("a restore refused as csrf shows why, in red", async ({ page }) => {
		await load(page, { before: (s) => s.route("POST", (u) => u.pathname.endsWith("/restore"), "error-csrf") });
		await openView(page, "Deleted files");
		await page.locator("folder-sync-status [data-restore-one]").first().click();
		const note = page.locator("folder-sync-status [data-error=csrf]");
		await expect(note).toHaveText(fixtures["error-csrf"].response.body.why);
		await expect(note).toHaveClass(/error/);
	});

	test("purge answering online_only shows why", async ({ page }) => {
		await load(page, { before: (s) => s.route("POST", (u) => u.pathname.endsWith("/history/purge"), "error-serve-online-only") });
		await openMenu(page);
		await menu(page).getByRole("button", { name: "Free up space" }).click();
		await menu(page).getByRole("button", { name: "Delete" }).click();
		await expect(menu(page).locator(".err")).toHaveText(fixtures["error-serve-online-only"].response.body.why);
	});
});

test.describe("Activity log", () => {
	test("online: every host's published changes and pulls, each with its sync time", async ({ page }) => {
		await load(page);
		await openView(page, "Activity log");
		const events = fixtures["activity-online"].response.body.events;
		await expect(rows(page)).toHaveCount(events.length);
		await expect(rows(page).first()).toContainText("20:50:00");
		await expect(rows(page).first()).toContainText("Restored hearts/clamp-24.json to the version of Oct 28, 19:02");
		const plan = rows(page).filter({ hasText: "Edited notes/plan.md" });
		await expect(plan.locator(".ms")).toHaveText("↑ 0.4 s");
		await expect(rows(page).filter({ hasText: "Received notes/plan.md from bam-GPU" }).locator(".ms")).toHaveText("↓ 1.4 s");
		await expect(rows(page).filter({ hasText: "Edited notes/scratch.md" })).toContainText("old version not kept (inside a burst)");
		await expect(rows(page).filter({ hasText: "logs/agent.log" })).toContainText("no history for this file");
	});

	test("serve: filters, search and Copy sync log", async ({ page, context }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await load(page, { scenario: "serve" });
		await openView(page, "Activity log");
		await expect(rows(page)).toHaveCount(fixtures["activity-serve"].response.body.events.length);
		const filter = (label) => page.locator("folder-sync-status [data-filter]", { hasText: label }).click();
		await filter("Errors");
		await expect(rows(page)).toHaveCount(1);
		await expect(rows(page)).toHaveClass(/error/);
		await expect(rows(page)).toContainText("Could not restore notes/very-old.md: that version is gone");
		expect(await rows(page).locator(".what").evaluate((el) => getComputedStyle(el).color)).toBe("rgb(207, 34, 46)");
		await filter("Skipped");
		await expect(rows(page)).toHaveCount(2);
		await expect(rows(page).first()).toContainText("Held 73 deletes: more than max_delete at once");
		await filter("Conflicts");
		await expect(rows(page)).toHaveCount(1);
		await page.locator("folder-sync-status [data-act=copy-log]").click();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("20:48:02  bam-GPU  Your edit to bam-laptop's notes/plan.md was kept aside");
		await filter("All");
		await page.locator("folder-sync-status #search").fill("laptop");
		await expect(rows(page)).toHaveCount(3);
		await page.locator("folder-sync-status #search").fill("zzz");
		await expect(page.locator("folder-sync-status .log")).toHaveText("Nothing matches.");
	});

	test("warnings only (activity-warn)", async ({ page }) => {
		await load(page, { scenario: "serve", before: (s) => s.route("GET", (u) => u.pathname.endsWith("/activity"), "activity-warn") });
		await openView(page, "Activity log");
		await expect(rows(page)).toHaveCount(4);
		await expect(page.locator("folder-sync-status .log .row.warn")).toHaveCount(3);
		await expect(page.locator("folder-sync-status .log .row.error")).toHaveCount(1);
	});

	test("a page with more before it: Load older sends its cursor", async ({ page }) => {
		await load(page, { before: (s) => s.route("GET", (u) => u.pathname.endsWith("/activity"), "activity-page", "activity-online") });
		await openView(page, "Activity log");
		await expect(rows(page)).toHaveCount(1);
		await page.locator("folder-sync-status [data-act=older]").click();
		await expect(rows(page)).toHaveCount(14);
		expect(requests("GET", "/activity").at(-1).path).toBe("/fs/v1/folders/notes/activity?limit=200&before=c1");
		await expect(page.locator("folder-sync-status [data-act=older]")).toHaveCount(0);
	});

	test("a file in the log opens its version history", async ({ page }) => {
		await load(page);
		await openView(page, "Activity log");
		await rows(page).filter({ hasText: "Edited notes/plan.md" }).getByRole("button", { name: "notes/plan.md" }).click();
		await expect(page.locator("folder-sync-status .body")).toHaveAttribute("data-view", "history");
		await expect(page.locator("folder-sync-status .versions button")).toHaveCount(5);
		expect(requests("GET", "/history/").at(0).path).toBe(`/fs/v1/folders/notes/history/${GPU}/notes/plan.md`);
	});
});

test.describe("Version history", () => {
	test("versions newest first; Show changes is jsdiff's line diff against the version before", async ({ page }) => {
		await load(page);
		await openPlanHistory(page);
		const items = page.locator("folder-sync-status .versions button");
		await expect(items.nth(0)).toContainText("Current");
		await expect(items.nth(3)).toContainText("unlisted");
		await expect(page.locator("folder-sync-status [data-act=restore-version]")).toBeHidden();
		await items.nth(2).click();
		await expect(items.nth(2)).toHaveAttribute("aria-current", "true");
		await expect(page.locator("folder-sync-status pre[data-diff] .add")).toHaveText(["+ - write up the latency numbers"]);
		await expect(page.locator("folder-sync-status pre[data-diff] .del")).toHaveCount(0);
		await items.nth(1).click();
		await expect(page.locator("folder-sync-status pre[data-diff] .add")).toHaveText(["+ - print the bracket v3", "+ - test the wrist camera at 30 fps"]);
		await expect(page.locator("folder-sync-status pre[data-diff] .del")).toHaveText(["- - print the bracket v2", "- - test the wrist camera"]);
		await page.locator("folder-sync-status #changes").uncheck();
		await expect(page.locator("folder-sync-status #content pre")).toHaveText(BYTES[`${GPU}/notes/plan.md@2026-10-28T20:41:00.410Z_7e3b9d0a1c2f4e5d`].replace(/\n$/, "\n"));
		await expect(page.locator("folder-sync-status pre[data-diff]")).toHaveCount(0);
		const asked = requests("GET", "?version=").map((r) => decodeURIComponent(r.path.split("version=")[1]));
		expect(asked).toContain("2026-10-28T20:00:00.000Z_unlisted");
		expect(requests("GET", "/files/").at(0).path).toBe(`/fs/v1/folders/notes/files/${GPU}/notes/plan.md`);
	});

	test("Copy and Download give that version's bytes", async ({ page, context }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await load(page);
		await openPlanHistory(page);
		await page.locator("folder-sync-status .versions button").nth(2).click();
		await expect(page.locator("folder-sync-status pre[data-diff]")).toBeVisible();
		await page.locator("folder-sync-status [data-act=copy-version]").click();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(BYTES[`${GPU}/notes/plan.md@${PLAN_9F2C}`]);
		const [download] = await Promise.all([page.waitForEvent("download"), page.locator("folder-sync-status #download").click()]);
		expect(download.suggestedFilename()).toBe("plan.md.2026-10-28T20-31-00.117Z");
		expect(new URL(download.url()).searchParams.get("version")).toBe(PLAN_9F2C);
	});

	test("Restore online: X-Folder-Sync and the owner id on the POST, then each outcome said plainly", async ({ page }) => {
		await load(page);
		await openPlanHistory(page);
		await page.locator("folder-sync-status .versions button").nth(2).click();
		await page.locator("folder-sync-status [data-act=restore-version]").click();
		await expect(page.locator("folder-sync-status [data-restore=failed]")).toBeVisible();
		const [post] = requests("POST", "/restore");
		expect(post.path).toBe("/fs/v1/folders/notes/restore");
		expect(post.headers["x-folder-sync"]).toBe("1");
		expect(post.headers["x-folder-sync-user"]).toBe("AbC123");
		expect(post.headers["content-type"]).toBe("application/json");
		expect(post.body).toEqual({ items: [{ host: GPU, path: "notes/plan.md", version: PLAN_9F2C }] });
		await expect(page.locator("folder-sync-status [data-restore=applied]")).toHaveText("Restored hearts/clamp-24.json as a new version.");
		await expect(page.locator("folder-sync-status [data-restore=requested]")).toHaveText("Waiting for bam-laptop: it restores 2 files when it next syncs. Download is the way to have them now.");
		await expect(page.locator("folder-sync-status [data-restore=failed]")).toHaveText("hearts/arm-1.json was not restored: that version is gone.");
		const restored = (await page.evaluate(() => window.__events)).filter((e) => e.name === "folder-sync:restored");
		expect(restored.map((e) => e.detail)).toEqual([fixtures["restore-online"].response.body]);
	});

	test("Restore on the machine: its own file waits for its engine, a peer's for that peer", async ({ page }) => {
		await load(page, { scenario: "serve" });
		await openPlanHistory(page);
		await page.locator("folder-sync-status .versions button").nth(2).click();
		await page.locator("folder-sync-status [data-act=restore-version]").click();
		await expect(page.locator("folder-sync-status [data-restore=requested]")).toHaveText([
			"This computer restores the file in its next round.",
			"Waiting for bam-laptop: it restores the file when it next syncs. Download is the way to have it now.",
		]);
	});

	test("a deleted file's versions: no Current, Restore offered", async ({ page }) => {
		await load(page);
		await page.evaluate((host) => document.querySelector("folder-sync-status").open("history", { host, path: "notes/old-ideas.md" }), GPU);
		await expect(page.locator("folder-sync-status .versions button")).toHaveCount(1);
		await expect(page.locator("folder-sync-status .side")).toContainText("bam-GPU · deleted");
		await expect(page.locator("folder-sync-status #content pre")).toContainText("a cable-driven wrist");
		await expect(page.locator("folder-sync-status [data-act=restore-version]")).toBeVisible();
	});

	test("Version history from the menu: pick one of the recently changed files", async ({ page }) => {
		await load(page);
		await openView(page, "Version history");
		const files = page.locator("folder-sync-status .files li button");
		await expect(files).toHaveCount(7);
		await page.locator(`folder-sync-status .files [data-host="${GPU}"][data-path="notes/plan.md"]`).click();
		await expect(page.locator("folder-sync-status .versions button")).toHaveCount(5);
		await page.locator("folder-sync-status [data-act=pick-file]").click();
		await expect(files).toHaveCount(7);
	});

	test("the split between the versions and the text is resizable and remembered (measured)", async ({ page }) => {
		await load(page);
		await openPlanHistory(page);
		const side = page.locator("folder-sync-status #side"), main = page.locator("folder-sync-status .split > .main"), handle = page.locator("folder-sync-status #handle");
		const s0 = await box(side), m0 = await box(main), h = await box(handle);
		await page.mouse.move(h.left + h.width / 2, h.top + 40);
		await page.mouse.down();
		for (let dx = 20; dx <= 120; dx += 20) await page.mouse.move(h.left + h.width / 2 + dx, h.top + 40);
		await page.mouse.up();
		const s1 = await box(side), m1 = await box(main);
		expect(Math.abs(s1.width - (s0.width + 120))).toBeLessThanOrEqual(1);
		expect(Math.abs(m1.left - (m0.left + 120))).toBeLessThanOrEqual(1);
		await handle.focus();
		await page.keyboard.press("ArrowLeft");
		const s2 = await box(side);
		expect(Math.abs(s2.width - (s1.width - 16))).toBeLessThanOrEqual(1);
		await page.reload();
		await page.waitForFunction(() => document.querySelector("folder-sync-status")?.shadowRoot?.querySelector(".pill:not([data-state='unknown'])"));
		await openPlanHistory(page);
		const s3 = await box(side);
		expect(Math.abs(s3.width - s2.width)).toBeLessThanOrEqual(1);
	});
});

test.describe("Deleted files", () => {
	test("every host's, newest first; restore one or many in one request", async ({ page }) => {
		await load(page);
		await openView(page, "Deleted files");
		const files = fixtures.deleted.response.body.files;
		const trs = page.locator("folder-sync-status tbody tr");
		await expect(trs).toHaveCount(3);
		for (const [i, f] of files.entries()) await expect(trs.nth(i)).toContainText(f.path);
		await expect(trs.nth(2)).toContainText("bam-laptop");
		await expect(trs.nth(2)).toContainText("2.7 MB");
		const restore = page.locator("folder-sync-status [data-act=restore-picked]");
		await expect(restore).toBeDisabled();
		await trs.nth(0).locator("input").check();
		await trs.nth(2).locator("input").check();
		await expect(restore).toHaveText("Restore 2 selected");
		await restore.click();
		await expect(page.locator("folder-sync-status [data-restore=requested]")).toBeVisible();
		expect(requests("POST", "/restore").at(-1).body).toEqual({ items: [files[0], files[2]].map((f) => ({ host: f.host, path: f.path, version: f.version })) });
		await page.locator("folder-sync-status #pick-all").check();
		await expect(restore).toHaveText("Restore 3 selected");
		await page.locator("folder-sync-status [data-restore-one]").nth(1).click();
		await expect(page.locator("folder-sync-status [data-restore=applied]")).toBeVisible();
		expect(requests("POST", "/restore").at(-1).body).toEqual({ items: [{ host: WEB, path: "hearts/arm-17.json", version: files[1].version }] });
	});

	test("one host's (deleted-one-host)", async ({ page }) => {
		await load(page, { before: (s) => s.route("GET", (u) => u.pathname.endsWith("/deleted"), "deleted-one-host") });
		await openView(page, "Deleted files");
		await expect(page.locator("folder-sync-status tbody tr")).toHaveCount(1);
		await expect(page.locator("folder-sync-status tbody tr")).toContainText("photos/IMG_2231.jpg");
		await page.locator("folder-sync-status tbody [data-host]").click();
		await expect(page.locator("folder-sync-status .body")).toHaveAttribute("data-view", "history");
		expect(requests("GET", "/history/").at(-1).path).toBe(`/fs/v1/folders/notes/history/${LAPTOP}/photos/IMG_2231.jpg`);
	});
});

test.describe("freshness", () => {
	test("status every 10 s while visible, none while hidden, at once when shown again", async ({ page }) => {
		await load(page);
		const count = () => requests("GET", "/status").length;
		const n0 = count();
		await page.clock.runFor(10_000);
		await expect.poll(count).toBe(n0 + 1);
		await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
		await page.clock.runFor(60_000);
		expect(count()).toBe(n0 + 1);
		await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); });
		await expect.poll(count).toBe(n0 + 2);
	});

	test("online, the hub's changed and a stale hello refetch; ping every 30 s", async ({ page }) => {
		let hub = null;
		const sent = [];
		await page.routeWebSocket(/\/fs\/v1\/folders\/notes\/events$/, (ws) => { hub = ws; ws.onMessage((m) => sent.push(m)); });
		await load(page);
		await expect.poll(() => hub !== null).toBe(true);
		const count = () => requests("GET", "/status").length;
		const n0 = count();
		hub.send(JSON.stringify({ type: "hello", cursor: 7, hosts: { [GPU]: { seq: 46 }, [WEB]: { seq: 7 }, [LAPTOP]: { seq: 12 } } }));
		await page.clock.runFor(500);
		expect(count()).toBe(n0);
		hub.send(JSON.stringify({ type: "changed", cursor: 8, host: WEB, seq: 8, web: true }));
		await page.clock.runFor(500);
		await expect.poll(count).toBe(n0 + 1);
		hub.send(JSON.stringify({ type: "hello", cursor: 9, hosts: { [GPU]: { seq: 47 } } }));
		await page.clock.runFor(500);
		await expect.poll(count).toBe(n0 + 2);
		await page.clock.runFor(30_000);
		await expect.poll(() => sent).toContain("ping");
	});
});

test.describe("isolation and theming", () => {
	test("no CSS leak either way: the page's hostile rules stay out, ours stay in", async ({ page }) => {
		await load(page);
		const p = await pill(page).evaluate((el) => { const s = getComputedStyle(el); return [s.backgroundColor, s.fontFamily, s.fontSize]; });
		expect(p[0]).not.toBe("rgb(255, 105, 180)");
		expect(p[1]).not.toContain("Georgia");
		expect(p[2]).toBe("13px");
		const own = await page.locator("#page-button").evaluate((el) => { const s = getComputedStyle(el); return [s.backgroundColor, s.display, s.fontSize]; });
		expect(own).toEqual(["rgb(255, 105, 180)", "inline-block", "22px"]);
		await openView(page, "Deleted files");
		expect(await panel(page).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 255, 255)");
		expect(await page.locator("folder-sync-status [data-restore-one]").first().evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgb(255, 105, 180)");
	});

	test("light and dark follow prefers-color-scheme", async ({ page }) => {
		await load(page);
		await openView(page, "Activity log");
		const colors = () => panel(page).evaluate((el) => { const s = getComputedStyle(el); return [s.backgroundColor, s.color]; });
		expect(await colors()).toEqual(["rgb(255, 255, 255)", "rgb(31, 35, 40)"]);
		await page.emulateMedia({ colorScheme: "dark" });
		expect(await colors()).toEqual(["rgb(13, 17, 23)", "rgb(230, 237, 243)"]);
	});

	test("--fs-* on an ancestor win in both schemes, and ::part reaches the pill", async ({ page }) => {
		await load(page, { query: `?theme=${encodeURIComponent("--fs-accent: rgb(200, 0, 100); --fs-bg: rgb(250, 240, 230); --fs-fg: rgb(40, 20, 10); --fs-radius: 3px")}` });
		await page.addStyleTag({ content: "folder-sync-status::part(pill) { outline: 3px solid rgb(1, 2, 3); }" });
		expect(await pill(page).evaluate((el) => getComputedStyle(el).outlineColor)).toBe("rgb(1, 2, 3)");
		await openView(page, "Deleted files");
		for (const scheme of ["light", "dark"]) {
			await page.emulateMedia({ colorScheme: scheme });
			expect(await panel(page).evaluate((el) => { const s = getComputedStyle(el); return [s.backgroundColor, s.color, s.borderTopLeftRadius]; })).toEqual(["rgb(250, 240, 230)", "rgb(40, 20, 10)", "5px"]);
			expect(await page.locator("folder-sync-status [data-act=restore-picked]").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(200, 0, 100)");
		}
	});
});

test("no request leaves the page's origin, through every view", async ({ page, context }) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const seen = [];
	page.on("request", (r) => seen.push(r.url()));
	page.on("websocket", (ws) => seen.push(ws.url()));
	await load(page);
	await openView(page, "Activity log");
	await page.locator("folder-sync-status [data-act=copy-log]").click();
	await rows(page).filter({ hasText: "Edited notes/plan.md" }).getByRole("button", { name: "notes/plan.md" }).click();
	await page.locator("folder-sync-status .versions button").nth(2).click();
	await expect(page.locator("folder-sync-status pre[data-diff]")).toBeVisible();
	await page.locator("folder-sync-status [data-act=restore-version]").click();
	await page.locator("folder-sync-status [role=tab]", { hasText: "Deleted files" }).click();
	await page.locator("folder-sync-status [data-restore-one]").first().click();
	await expect(page.locator("folder-sync-status [data-restore=applied]")).toBeVisible();
	const origin = new URL(stub.url).host;
	expect(seen.length).toBeGreaterThan(8);
	expect(seen.filter((u) => new URL(u).host !== origin)).toEqual([]);
	expect(seen.some((u) => u.startsWith(`ws://${origin}/fs/v1/folders/notes/events`))).toBe(true);
});

test("every testdata/view-api/ fixture the element reads was rendered by this suite", () => {
	// usage and folders-serve are not the element's: storage reaches it inside status, and the folders list is
	// serve's own /fs/ page (one element per folder). purge-version is the per-version purge's answer, used above as
	// the last page of Free up space.
	const notTheElements = ["usage", "folders-serve"];
	const missing = Object.keys(fixtures).filter((n) => !notTheElements.includes(n) && !served.has(n));
	expect(missing).toEqual([]);
});
