// The Storage tab of <folder-sync-status> (GET /fs/v1/usage/breakdown), in Chromium over test/stub.mjs. The breakdown
// is fixtures/storage-breakdown.json, which accounts/test/storage.test.ts pins to what the Worker really answers for the
// realistic account (a project with ~4 MB append-only logs replaced many times into _trash), so this test and the
// Worker agree on the shape. FS_SHOTS=<dir> also writes screenshots (FS_SHOT_PREFIX names them, default storage-view).
import { mkdirSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { startStub } from "./stub.mjs";

const NOW = new Date("2026-10-28T21:15:00Z");
const BREAKDOWN = JSON.parse(readFileSync(new URL("./fixtures/storage-breakdown.json", import.meta.url), "utf8"));
const SHOTS = process.env.FS_SHOTS;
const PREFIX = process.env.FS_SHOT_PREFIX || "storage-view";
let stub = null;

test.afterEach(async () => {
	if (stub) await stub.close();
	stub = null;
});

/** Opens the Storage panel on a stub whose breakdown answer is `answer` ({ status, body }), or the fixture's. */
async function load(page, { scenario = "online", answer = { status: 200, body: BREAKDOWN }, query = "" } = {}) {
	stub = await startStub({ scenario });
	await page.route("**/fs/v1/usage/breakdown", (route) => {
		stub.requests.push({ method: route.request().method(), path: "/fs/v1/usage/breakdown" });
		return route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) });
	});
	await page.clock.install({ time: NOW });
	await page.goto(`${stub.url}/app.html${query}`);
	await page.waitForFunction(() => document.querySelector("folder-sync-status")?.shadowRoot?.querySelector(".pill:not([data-state='unknown'])"));
	await page.locator("folder-sync-status .pill").click();
	await page.locator("folder-sync-status #menu").getByRole("menuitem", { name: "Storage" }).click();
	await expect(page.locator("folder-sync-status .panel")).toBeVisible();
}

const el = (page, css) => page.locator(`folder-sync-status ${css}`);
const box = (locator) => locator.evaluate((e) => { const r = e.getBoundingClientRect(); return { left: r.left, width: r.width, height: r.height }; });
/** A screenshot of the page as it is, with the tab scrolled to `css` first (the panel's body scrolls). */
const shot = async (page, name, css) => {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	if (css) await el(page, css).first().evaluate((e) => e.scrollIntoView({ block: "start" }));
	await page.screenshot({ path: `${SHOTS}/${PREFIX}-${name}.png` });
};

test("one calm answer first: used of quota, and what most of it is", async ({ page }) => {
	await load(page);
	await expect(el(page, "[data-answer]")).toHaveText("919.7 MiB of 10 GiB · 94% is old copies in trash");
	await expect(el(page, ".tabs [role=tab][aria-selected=true]")).toHaveText("Storage");
	await expect(el(page, "[data-storage-view]")).toContainText("296 of 100,000 files");
	// nothing amber or red while under quota (calm UI)
	await expect(el(page, "[data-storage-view] .err, [data-storage-view] .warn, [data-storage-view] .note.warn, [data-storage-view] .note.error")).toHaveCount(0);
	await shot(page, "1-answer");
});

test("the bar is each kind's share of the quota, measured", async ({ page }) => {
	await load(page);
	const bar = await box(el(page, ".sbar"));
	const slices = await el(page, ".sbar i").evaluateAll((all) => all.map((i) => i.getBoundingClientRect().width));
	expect(slices).toHaveLength(BREAKDOWN.kinds.length);
	BREAKDOWN.kinds.forEach((k, i) => {
		// each slice is at least a visible 2px, otherwise bytes / quota of the bar
		expect(Math.abs(slices[i] - Math.max(2, (bar.width * k.bytes) / BREAKDOWN.quota.bytes))).toBeLessThanOrEqual(1);
	});
	expect(slices.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(bar.width + 0.5);
	await expect(el(page, ".legend")).toContainText("Trash 866.9 MiB");
});

test("suggestions say how much they free and why, and none of them can be pressed yet", async ({ page }) => {
	await load(page);
	const items = el(page, "[data-suggestion]");
	await expect(items).toHaveCount(BREAKDOWN.suggestions.length);
	await expect(items.first()).toContainText("Empty trash older than 7 days");
	await expect(items.first()).toContainText("frees 600.1 MiB");
	await expect(el(page, '[data-suggestion^="log:"]').first()).toContainText("logs/agent.log is an append-only log replaced 150 times");
	await expect(el(page, '[data-suggestion^="log:"]').first()).toContainText("keeping only the newest copy frees 539 MiB");
	await expect(el(page, "[data-storage-view]")).toContainText("their amounts do not add up");
	for (const button of await el(page, "[data-suggestion] button").all()) {
		await expect(button).toBeDisabled();
		await expect(button).toHaveText("Free up");
	}
	await expect(items.first()).toContainText("coming next");
	await button_click_sends_nothing(page);
	await shot(page, "2-suggestions", ".sec");
});

async function button_click_sends_nothing(page) {
	await el(page, "[data-suggestion] button").first().click({ force: true });
	expect(stub.requests.filter((r) => r.method !== "GET")).toEqual([]);
}

test("the table opens a level at a time: project, then kind, then device", async ({ page }) => {
	await load(page);
	const first = el(page, "details.proj").first();
	await expect(first).toHaveAttribute("data-project", "robotparts");
	await expect(first).toHaveJSProperty("open", true);
	await expect(el(page, "details.proj").nth(1)).toHaveJSProperty("open", false);
	const kinds = first.locator("tr.kind");
	await expect(kinds).toHaveCount(5);
	await expect(kinds.nth(0)).toContainText("Files");
	await expect(first.locator('tr.kind[data-kind="trash"]')).toContainText("Oct 3 – Oct 28");
	// a device is named where its manifest gave a name
	await expect(first.locator("tr.host").filter({ hasText: "bam-GPU" }).first()).toBeVisible();
	await expect(first.locator("tr.host").filter({ hasText: "bam-laptop" }).first()).toBeVisible();
	await expect(first.locator("tr.host").filter({ hasText: "web" }).first()).toBeVisible();
	await el(page, "details.proj").nth(1).locator("summary").click();
	await expect(el(page, "details.proj").nth(1).locator("tr.host")).not.toHaveCount(0);
	await shot(page, "3-table", "details.proj");
});

test("the biggest folders and files are behind a click, with their old copies", async ({ page }) => {
	await load(page);
	const folders = el(page, 'details[data-biggest="folders"]'), files = el(page, 'details[data-biggest="files"]');
	await expect(folders).toHaveJSProperty("open", false);
	await folders.locator("summary").click();
	await files.locator("summary").click();
	await expect(folders.locator("tbody tr")).toHaveCount(BREAKDOWN.folders.length);
	await expect(files.locator("tbody tr")).toHaveCount(BREAKDOWN.files.length);
	await expect(folders.locator("tbody tr").first()).toContainText("robotparts · bam-GPU · logs");
	await expect(files.locator("tbody tr").first()).toContainText("logs/agent.log");
	await expect(files.locator("tbody tr").first()).toContainText("150 old");
	await shot(page, "4-biggest", "[data-biggest=folders]");
	// a file opens its version history
	await files.locator("tbody tr").first().getByRole("button", { name: "logs/agent.log" }).click();
	await expect(el(page, ".tabs [role=tab][aria-selected=true]")).toHaveText("Version history");
});

test("over quota is the one time it is red, and it says why", async ({ page }) => {
	const over = { ...BREAKDOWN, quota: { bytes: 800 * 1048576, objects: 100000 }, over: "this account holds 964415870 bytes (0.90 GiB) of its 838860800 (0.78 GiB): delete files, or ask the operator for more" };
	await load(page, { answer: { status: 200, body: over } });
	await expect(el(page, "[data-over]")).toContainText("919.7 MiB of 800 MiB");
	await expect(el(page, "[data-answer]")).toContainText("over by 119.7 MiB");
	expect(await el(page, "[data-over]").evaluate((e) => getComputedStyle(e).color)).toBe("rgb(207, 34, 46)");
	await expect(el(page, "[data-over-why]")).toContainText("delete files, or ask the operator for more");
	await shot(page, "5-over-quota");
});

test("a cut listing says its figures are a lower bound", async ({ page }) => {
	await load(page, { answer: { status: 200, body: { ...BREAKDOWN, partial: true } } });
	await expect(el(page, "[data-partial]")).toContainText("lower bound");
});

test("an empty account says so", async ({ page }) => {
	await load(page, { answer: { status: 200, body: { ...BREAKDOWN, used: { bytes: 0, objects: 0 }, kinds: [], projects: [], folders: [], files: [], suggestions: [] } } });
	await expect(el(page, "[data-storage-view]")).toContainText("Nothing is stored in this account yet");
});

test("signed out is the sign-in link, not a blank tab", async ({ page }) => {
	await load(page, { answer: { status: 401, body: { error: "signed_out", why: "not signed in" } } });
	await expect(el(page, "[data-error=signed_out]")).toContainText("Sign in");
});

test("Refresh asks again", async ({ page }) => {
	await load(page);
	const asked = () => stub.requests.filter((r) => r.path === "/fs/v1/usage/breakdown").length;
	const before = asked();
	await el(page, '[data-act="storage-refresh"]').click();
	await expect.poll(asked).toBe(before + 1);
});

test("the tab is reachable by keyboard like the others", async ({ page }) => {
	await load(page);
	// WHY wait: opening Storage from the menu focuses its tab once the view has rendered, which can land after load() returns
	await expect(el(page, "#tab-storage")).toBeFocused();
	await el(page, "#tab-deleted").focus();
	await page.keyboard.press("ArrowRight");
	await expect(el(page, ".body")).toHaveAttribute("data-view", "storage");
	await page.keyboard.press("ArrowRight");
	await expect(el(page, ".body")).toHaveAttribute("data-view", "files");
});

test("on a machine and for a reader it explains, and asks nothing", async ({ page }) => {
	await load(page, { scenario: "serve" });
	await expect(el(page, "[data-storage-note=online]")).toBeVisible();
	expect(stub.requests.filter((r) => r.path === "/fs/v1/usage/breakdown")).toEqual([]);
	await stub.close();
	stub = null;
	const reader = await startStub({ scenario: "reader" });
	stub = reader;
	await page.route("**/fs/v1/usage/breakdown", (route) => { reader.requests.push({ method: "GET", path: "/fs/v1/usage/breakdown" }); return route.abort(); });
	await page.goto(`${reader.url}/app.html?view=storage`);
	await expect(el(page, "[data-storage-note=owner]")).toBeVisible();
	expect(reader.requests.filter((r) => r.path === "/fs/v1/usage/breakdown")).toEqual([]);
});

for (const scheme of ["light", "dark"]) {
	test(`${scheme}: the tab in three scrolls, for the eye`, async ({ page }) => {
		test.skip(!SHOTS, "set FS_SHOTS=<dir> to write the screenshots");
		await page.emulateMedia({ colorScheme: scheme });
		await load(page);
		await expect(el(page, "[data-answer]")).toBeVisible();
		await shot(page, `${scheme}-1-top`);
		await el(page, 'details[data-biggest="folders"] summary').click();
		await shot(page, `${scheme}-2-table`, "details.proj");
		await shot(page, `${scheme}-3-biggest`, "[data-biggest=folders]");
	});
}
