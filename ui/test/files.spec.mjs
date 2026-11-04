// The Files tab of <folder-sync-status> in Chromium: browse every device's files, open each kind with the browser's own
// preview, upload (button and drop), rename and delete the web host's files, see another device's files as read-only,
// and the resizable list. Data comes from test/files-world.mjs (the Worker's listing, bytes, PUT and DELETE routes in
// memory) over test/stub.mjs (status, history). The same tab against the real Worker is e2e/files-real.spec.mjs.
// FS_SHOTS=<dir> also writes screenshots (FS_SHOT_PREFIX names them, default files).
import { mkdirSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { GPU, LAPTOP, WEB, startStub } from "./stub.mjs";
import { OWNER_ID, PLAN, world } from "./files-world.mjs";

const NOW = new Date("2026-11-04T10:30:00Z");
const SHOTS = process.env.FS_SHOTS;
const PREFIX = process.env.FS_SHOT_PREFIX || "files";
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
let stub = null;
let w = null;

test.afterEach(async () => {
	if (stub) await stub.close();
	stub = null;
});

/** Loads the host page with the Files tab open inline (`?view=files`), over a fresh world and stub. */
async function load(page, { scenario = "online", visibility = "private", query = "view=files" } = {}) {
	stub = await startStub({ scenario });
	w = world({ visibility });
	await w.install(page);
	await page.clock.install({ time: NOW });
	await page.goto(`${stub.url}/app.html?${query}`);
	if (query.includes("view=files")) await expect(page.locator("folder-sync-status .body")).toHaveAttribute("data-view", "files");
	else await expect(page.locator("folder-sync-status .pill:not([data-state='unknown'])")).toBeVisible();
}

const el = (page, css) => page.locator(`folder-sync-status ${css}`);
const row = (page, path) => el(page, `.frow[title="${path}"]`);
const box = (locator) => locator.evaluate((e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, width: r.width, height: r.height }; });
const shot = async (page, name) => {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: `${SHOTS}/${PREFIX}-${name}.png` });
};
const wrote = (method) => w.requests.filter((r) => r.method === method && r.path.startsWith("web/"));
const open = async (page, path) => {
	await row(page, path).click();
	await expect(el(page, ".ftitle b")).toHaveText(path.split("/").pop());
};

test.describe("browse", () => {
	test("every device's files, grouped by who wrote them, the web host first, with name, size, modified and device", async ({ page }) => {
		await load(page);
		await expect(el(page, ".fgroup h3")).toHaveText(["Web · you can change these here", "bam-GPU · synced from a device", "bam-laptop · synced from a device"]);
		await expect(el(page, ".fgroup[data-device='" + WEB + "'] .frow")).toHaveCount(2);
		await expect(el(page, ".fgroup[data-device='" + GPU + "'] .frow")).toHaveCount(8);
		await expect(el(page, ".fgroup[data-device='" + LAPTOP + "'] .frow")).toHaveCount(1);
		const plan = row(page, "notes/plan.md");
		await expect(plan.locator(".fdir")).toHaveText("notes/");
		await expect(plan.locator("b")).toHaveText("plan.md");
		await expect(plan.locator(".fmeta")).toHaveText(`${PLAN.length} B · 32 min ago · bam-GPU`);
		await expect(plan.locator("time")).toHaveAttribute("datetime", "2026-11-04T09:58:00.000Z");
		await expect(row(page, "logs/agent.log").locator(".fmeta")).toContainText("1.1 MiB");
		// sorted by name inside each group, case-blind
		const names = await el(page, ".fgroup[data-device='" + GPU + "'] .frow").evaluateAll((all) => all.map((n) => n.title));
		expect(names).toEqual(["audio/beep.wav", "cad/bracket.step", "clips/demo.webm", "docs/spec.pdf", "logs/agent.log", "notes/plan.md", "notes/todo.json", "photos/lab.png"]);
		await expect(el(page, "[data-files-placeholder]")).toHaveText("Select a file to open it.");
		await shot(page, "1-browse");
	});

	test("sort by modified and by size, and filter by name", async ({ page }) => {
		await load(page);
		const gpu = () => el(page, ".fgroup[data-device='" + GPU + "'] .frow").evaluateAll((all) => all.map((n) => n.title));
		await el(page, "#fsort").selectOption("modified");
		expect((await gpu()).slice(0, 3)).toEqual(["logs/agent.log", "notes/plan.md", "notes/todo.json"]);
		await el(page, "#fsort").selectOption("size");
		expect((await gpu()).slice(0, 2)).toEqual(["logs/agent.log", "clips/demo.webm"].slice(0, 1).concat((await gpu())[1]));
		expect((await gpu())[0]).toBe("logs/agent.log");
		await el(page, "#fquery").fill("PLAN");
		await expect(el(page, ".frow")).toHaveCount(1);
		await expect(row(page, "notes/plan.md")).toBeVisible();
		await expect(el(page, ".fgroup h3")).toHaveCount(1);
		await el(page, "#fquery").fill("zzz");
		await expect(el(page, "[data-files-empty]")).toHaveText("No file matches.");
		await el(page, "#fquery").fill("");
		await expect(el(page, ".frow")).toHaveCount(11);
		// the filter matches the path, so a folder name finds what is in it
		await el(page, "#fquery").fill("photos/");
		await expect(el(page, ".frow")).toHaveCount(1);
	});

	test("the tab is in the menu, first, and opens in the dialog; arrows move between files", async ({ page }) => {
		await load(page, { query: "" });
		await page.locator("folder-sync-status .pill").click();
		const items = el(page, "#menu .item");
		await expect(items.first()).toHaveText("Files");
		await items.first().click();
		await expect(el(page, ".panel")).toBeVisible();
		await expect(el(page, "[role=tab][aria-selected=true]")).toHaveText("Files");
		await expect(el(page, ".frow").first()).toBeVisible();
		await el(page, ".frow").first().focus();
		await page.keyboard.press("ArrowDown");
		expect(await page.evaluate(() => document.querySelector("folder-sync-status").shadowRoot.activeElement.title)).toBe("welcome.md");
		await page.keyboard.press("Enter");
		await expect(el(page, ".ftitle b")).toHaveText("welcome.md");
	});
});

test.describe("open a file with the browser's own preview", () => {
	test("text and markdown and JSON are plain text in a <pre>", async ({ page }) => {
		await load(page);
		await open(page, "notes/plan.md");
		await expect(el(page, "pre[data-preview=text]")).toHaveText(PLAN.trimEnd());
		expect(await el(page, "pre[data-preview=text]").evaluate((e) => e.textContent)).toBe(PLAN);
		await expect(el(page, ".ftitle .muted")).toContainText(`notes/ · ${PLAN.length} B`);
		await expect(el(page, ".ftitle .muted")).toContainText("bam-GPU");
		await open(page, "notes/todo.json");
		await expect(el(page, "pre[data-preview=text]")).toContainText('"todo": ["clamp", "bracket"]');
		// markup in a file is shown, never run
		w.files.set(`${WEB}\nevil.md`, { host: WEB, path: "evil.md", data: Buffer.from("<img src=x onerror=alert(1)><script>window.pwned=1</script>\n"), mtime: "2026-11-04T10:00:00Z" });
		await el(page, "#tab-files").click();
		await el(page, "#fquery").fill("evil");
		await open(page, "evil.md");
		await expect(el(page, "pre[data-preview=text]")).toContainText("<img src=x onerror=alert(1)>");
		expect(await page.evaluate(() => window.pwned)).toBeUndefined();
		expect(await el(page, "pre[data-preview=text] img, pre[data-preview=text] script").count()).toBe(0);
	});

	test("an image is an <img> that loaded", async ({ page }) => {
		await load(page);
		await open(page, "photos/lab.png");
		const img = el(page, "img[data-preview=image]");
		await expect(img).toBeVisible();
		await expect.poll(() => img.evaluate((i) => i.complete && i.naturalWidth)).toBe(48);
		await expect(img).toHaveAttribute("src", `/fs/v1/folders/notes/files/${GPU}/photos/lab.png`);
		await shot(page, "2-image");
	});

	test("a PDF is a frame on the file's own URL, served as a PDF", async ({ page }) => {
		await load(page);
		const served = page.waitForResponse((r) => r.url().endsWith("/docs/spec.pdf"));
		await open(page, "docs/spec.pdf");
		const frame = el(page, "iframe[data-preview=pdf]");
		await expect(frame).toBeVisible();
		await expect(frame).toHaveAttribute("src", `/fs/v1/folders/notes/files/${GPU}/docs/spec.pdf`);
		expect((await served).headers()["content-type"]).toBe("application/pdf");
		expect((await box(frame)).height).toBeGreaterThan(300);
	});

	test("video and audio are native players that load their metadata", async ({ page }) => {
		await load(page);
		await open(page, "clips/demo.webm");
		const video = el(page, "video[data-preview=video]");
		await expect(video).toBeVisible();
		await expect.poll(() => video.evaluate((v) => v.readyState >= 1 && v.duration)).toBeGreaterThan(0.5);
		expect(await video.evaluate((v) => v.controls)).toBe(true);
		expect(await video.evaluate((v) => [v.videoWidth, v.videoHeight])).toEqual([96, 64]);
		await open(page, "audio/beep.wav");
		const audio = el(page, "audio[data-preview=audio]");
		await expect(audio).toBeVisible();
		await expect.poll(() => audio.evaluate((a) => a.readyState >= 1 && a.duration)).toBeGreaterThan(0.3);
		expect(await el(page, "video").count()).toBe(0);
	});

	test("anything else, a file too big to show, and a file that is not text get Download and nothing else", async ({ page }) => {
		await load(page);
		await open(page, "cad/bracket.step");
		await expect(el(page, "[data-nopreview]")).toContainText("no preview for this kind of file");
		await expect(el(page, "[data-nopreview] a")).toHaveAttribute("download", "bracket.step");
		await expect(el(page, "[data-nopreview] a")).toHaveAttribute("href", `/fs/v1/folders/notes/files/${GPU}/cad/bracket.step`);
		expect(await el(page, "#fpreview pre, #fpreview img, #fpreview iframe, #fpreview video").count()).toBe(0);
		const before = w.requests.length;
		await open(page, "logs/agent.log");
		await expect(el(page, "[data-nopreview]")).toContainText("agent.log is 1.1 MiB, too big to show here");
		expect(w.requests.slice(before).filter((r) => r.path.endsWith("agent.log"))).toEqual([]);
		w.files.set(`${WEB}\nnotes.txt`, { host: WEB, path: "notes.txt", data: Buffer.from([0xff, 0xfe, 0x00, 0x41]), mtime: "2026-11-04T10:00:00Z" });
		await el(page, "#tab-files").click();
		await el(page, "#fquery").fill("notes.txt");
		await open(page, "notes.txt");
		await expect(el(page, "[data-nopreview]")).toContainText("notes.txt is not text");
		await expect(el(page, "#fdownload")).toHaveAttribute("download", "notes.txt");
	});
});

test.describe("another device's files are read-only", () => {
	test("a machine's file says who wrote it, offers Download and Version history, and no Rename or Delete", async ({ page }) => {
		await load(page);
		await open(page, "notes/plan.md");
		await expect(el(page, "[data-readonly]")).toContainText("Written by bam-GPU; edit it there.");
		await expect(el(page, ".factions button, .factions a")).toHaveText(["Download", "Version history"]);
		await shot(page, "3-readonly");
		await open(page, "readme.md");
		await expect(el(page, "[data-readonly]")).toContainText("Written by bam-laptop; edit it there.");
		await open(page, "welcome.md");
		await expect(el(page, "[data-readonly]")).toHaveCount(0);
		await expect(el(page, ".factions button, .factions a")).toHaveText(["Download", "Version history", "Rename", "Delete"]);
		expect(wrote("PUT").length + wrote("DELETE").length).toBe(0);
	});

	test("a reader sees the files, and nothing to change", async ({ page }) => {
		stub = await startStub({ scenario: "reader" });
		w = world();
		await w.install(page);
		await page.clock.install({ time: NOW });
		await page.goto(`${stub.url}/app.html?view=files`);
		await expect(el(page, ".frow").first()).toBeVisible();
		await expect(el(page, "[data-act=upload]")).toHaveCount(0);
		await open(page, "welcome.md");
		await expect(el(page, ".factions button, .factions a")).toHaveText(["Download"]);
		await expect(el(page, "[data-readonly]")).toHaveCount(0);
	});

	test("on a machine the tab says to browse online, asks for no listing, and is not in the menu", async ({ page }) => {
		await load(page, { scenario: "serve", query: "view=files" });
		await expect(el(page, "[data-files-note=online]")).toBeVisible();
		expect(w.requests).toEqual([]);
		await expect(el(page, "#tab-files")).toBeHidden();
		await page.goto(`${stub.url}/app.html`);
		await el(page, ".pill").click();
		await expect(el(page, "#menu").getByRole("menuitem", { name: "Files" })).toHaveCount(0);
		await expect(el(page, "#menu").getByRole("menuitem", { name: "Activity log" })).toBeVisible();
	});
});

test.describe("upload", () => {
	test("the Upload button puts the file in the web host, with the page's CSRF headers, and opens it", async ({ page }) => {
		await load(page);
		await el(page, "#upload-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("uploaded by hand\n") });
		await expect(el(page, "[data-note=info]")).toHaveText("Added notes.txt to Web.");
		const [put] = wrote("PUT");
		expect(put.path).toBe("web/notes.txt");
		expect(put.headers["x-folder-sync"]).toBe("1");
		expect(put.headers["x-folder-sync-user"]).toBe(OWNER_ID);
		expect(put.body.toString()).toBe("uploaded by hand\n");
		await expect(row(page, "notes.txt")).toBeVisible();
		await expect(el(page, ".fgroup[data-device='" + WEB + "'] .frow")).toHaveCount(3);
		await expect(el(page, ".ftitle b")).toHaveText("notes.txt");
		await expect(el(page, "pre[data-preview=text]")).toHaveText("uploaded by hand");
		await shot(page, "4-uploaded");
	});

	test("dropping files on the tab uploads them all, and only the owner's tab takes a drop", async ({ page }) => {
		await load(page);
		const dt = await page.evaluateHandle(() => {
			const d = new DataTransfer();
			d.items.add(new File(["dropped one\n"], "one.md", { type: "text/markdown" }));
			d.items.add(new File([new Uint8Array([137, 80, 78, 71])], "two.bin"));
			return d;
		});
		await el(page, "#fview").dispatchEvent("dragenter", { dataTransfer: dt });
		await expect(el(page, "#fview.dropping")).toHaveCount(1);
		await shot(page, "5-dropping");
		await el(page, "#fview").dispatchEvent("drop", { dataTransfer: dt });
		await expect(el(page, "[data-note=info]")).toHaveText("Added 2 files to Web.");
		await expect(el(page, "#fview.dropping")).toHaveCount(0);
		expect(wrote("PUT").map((r) => r.path)).toEqual(["web/one.md", "web/two.bin"]);
		expect(w.read(WEB, "two.bin")).toEqual(Buffer.from([137, 80, 78, 71]));
		await expect(row(page, "one.md")).toBeVisible();
		// a drag that carries text, not files, is the page's own business
		const text = await page.evaluateHandle(() => { const d = new DataTransfer(); d.setData("text/plain", "hello"); return d; });
		await el(page, "#fview").dispatchEvent("dragenter", { dataTransfer: text });
		await expect(el(page, "#fview.dropping")).toHaveCount(0);
	});

	test("a file over 32 MiB is refused before it is sent, a refused name says why, and the rest of the batch goes", async ({ page }) => {
		await load(page);
		await el(page, "#upload-input").setInputFiles([
			{ name: "huge.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(33 * 1024 * 1024) },
			{ name: "manifest.json", mimeType: "application/json", buffer: Buffer.from("{}") },
			{ name: "fine.txt", mimeType: "text/plain", buffer: Buffer.from("fine\n") },
		]);
		const note = el(page, "[data-note=error]");
		await expect(note).toContainText("huge.bin: the web folder takes files up to 32 MiB");
		await expect(note).toContainText("manifest.json: manifest.json at the root of a folder is the manifest's own key");
		await expect(note).toContainText("Added fine.txt to Web.");
		expect(wrote("PUT").map((r) => r.path)).toEqual(["web/manifest.json", "web/fine.txt"]);
		await expect(row(page, "fine.txt")).toBeVisible();
		await expect(row(page, "huge.bin")).toHaveCount(0);
	});
});

test.describe("rename and delete (the web host's files)", () => {
	test("rename writes the new path, then deletes the old one, and the file stays open under its new name", async ({ page }) => {
		await load(page);
		await open(page, "welcome.md");
		await el(page, "[data-act=file-rename]").click();
		const input = el(page, "#rename-input");
		await expect(input).toHaveValue("welcome.md");
		await expect(input).toBeFocused();
		await input.fill("notes/hello.md");
		const before = w.requests.length;
		await el(page, "[data-act=rename-save]").click();
		await expect(el(page, "[data-note=info]")).toHaveText("Renamed to notes/hello.md.");
		// read the bytes, write them at the new path, delete the old one, then list and open the new name
		await expect(el(page, "pre[data-preview=text]")).toContainText("Added on the web.");
		expect(w.requests.slice(before).map((r) => `${r.method} ${r.path}`)).toEqual(
			["GET files/" + WEB + "/welcome.md", "PUT web/notes/hello.md", "DELETE web/welcome.md", "GET list", "GET files/" + WEB + "/notes/hello.md"]);
		expect(w.read(WEB, "notes/hello.md").toString()).toBe("# Welcome\n\nAdded on the web.\n");
		expect(w.has(WEB, "welcome.md")).toBe(false);
		await expect(row(page, "welcome.md")).toHaveCount(0);
		await expect(el(page, ".ftitle b")).toHaveText("hello.md");
		await expect(el(page, "pre[data-preview=text]")).toContainText("Added on the web.");
		await shot(page, "6-renamed");
	});

	test("rename onto a name that exists is refused, Escape cancels, and nothing is written either time", async ({ page }) => {
		await load(page);
		await open(page, "welcome.md");
		await el(page, "[data-act=file-rename]").click();
		await el(page, "#rename-input").fill("hearts/clamp-24.json");
		await page.keyboard.press("Enter");
		await expect(el(page, "[data-note=warn]")).toContainText("hearts/clamp-24.json already exists here");
		expect(wrote("PUT").length + wrote("DELETE").length).toBe(0);
		await page.keyboard.press("Escape");
		await expect(el(page, "#rename-input")).toHaveCount(0);
		await expect(el(page, ".ftitle b")).toHaveText("welcome.md");
		expect(wrote("PUT").length + wrote("DELETE").length).toBe(0);
	});

	test("delete asks first, then removes the file; Cancel keeps it", async ({ page }) => {
		await load(page);
		await open(page, "welcome.md");
		await el(page, "[data-act=file-delete]").click();
		await expect(el(page, "[data-note=warn]")).toContainText("Delete welcome.md? It stays in Deleted files for 30 days.");
		await el(page, "[data-act=delete-cancel]").click();
		await expect(el(page, "[data-note]")).toHaveCount(0);
		expect(wrote("DELETE").length).toBe(0);
		await el(page, "[data-act=file-delete]").click();
		await el(page, "[data-act=delete-confirm]").click();
		await expect(el(page, "[data-note=info]")).toContainText("Deleted welcome.md. It stays in Deleted files for 30 days.");
		expect(wrote("DELETE").map((r) => r.path)).toEqual(["web/welcome.md"]);
		expect(w.has(WEB, "welcome.md")).toBe(false);
		await expect(row(page, "welcome.md")).toHaveCount(0);
		await expect(el(page, "[data-files-placeholder]")).toBeVisible();
	});

	test("a refused write shows the server's reason and changes nothing on screen", async ({ page }) => {
		await load(page);
		await open(page, "welcome.md");
		await page.route("**/fs/v1/folders/notes/web/welcome.md", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "wrong_user", why: "this page is signed in as someone else (or does not say who): reload it" }) }));
		await el(page, "[data-act=file-delete]").click();
		await el(page, "[data-act=delete-confirm]").click();
		await expect(el(page, "[data-note=error]")).toHaveText("this page is signed in as someone else (or does not say who): reload it");
		await expect(row(page, "welcome.md")).toBeVisible();
	});
});

test.describe("from a file", () => {
	test("Version history opens the history tab on that file", async ({ page }) => {
		await load(page);
		await open(page, "notes/plan.md");
		await el(page, "[data-act=file-history]").click();
		await expect(el(page, ".body")).toHaveAttribute("data-view", "history");
		await expect(el(page, ".versions button")).toHaveCount(5);
		await expect(el(page, ".side .link")).toHaveText("notes/plan.md");
		// back on Files the file is still open
		await el(page, "#tab-files").click();
		await expect(el(page, ".ftitle b")).toHaveText("plan.md");
	});

	test("Copy link exists only where a link works: a public folder's file, by owner", async ({ page, context }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await load(page);
		await open(page, "welcome.md");
		await expect(el(page, "[data-act=file-link]")).toHaveCount(0);
		await stub.close();
		await load(page, { visibility: "public" });
		await open(page, "welcome.md");
		await el(page, "[data-act=file-link]").click();
		await expect(el(page, "[data-act=file-link]")).toHaveText("Copied");
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${stub.url}/fs/v1/folders/notes/files/${WEB}/welcome.md?owner=${OWNER_ID}`);
	});

	test("the folder picker switches the element's folder, and says so", async ({ page }) => {
		await load(page);
		await expect(el(page, "#fproject option")).toHaveText(["notes", "robotparts"]);
		await page.evaluate(() => { window.__projects = []; document.addEventListener("folder-sync:project", (e) => window.__projects.push(e.detail.project)); });
		await el(page, "#fproject").selectOption("robotparts");
		await expect(el(page, "[data-files-empty]")).toBeVisible();
		await expect(page.locator("folder-sync-status")).toHaveAttribute("project", "robotparts");
		expect(await page.evaluate(() => window.__projects)).toEqual(["robotparts"]);
		await expect(el(page, ".body")).toHaveAttribute("data-view", "files");
		await expect(el(page, "#fproject")).toHaveValue("robotparts");
		await el(page, "#fproject").selectOption("notes");
		await expect(row(page, "notes/plan.md")).toBeVisible();
	});
});

test.describe("the list is resizable, and the page works small, light and dark", () => {
	test("dragging the handle resizes the list (measured) and the width is remembered", async ({ page }) => {
		await load(page);
		const side = el(page, "#side"), main = el(page, "#fmain"), handle = el(page, "#handle");
		const s0 = await box(side), m0 = await box(main), h = await box(handle);
		await page.mouse.move(h.left + h.width / 2, h.top + 40);
		await page.mouse.down();
		for (let dx = 20; dx <= 100; dx += 20) await page.mouse.move(h.left + h.width / 2 + dx, h.top + 40);
		await page.mouse.up();
		const s1 = await box(side), m1 = await box(main);
		expect(Math.abs(s1.width - (s0.width + 100))).toBeLessThanOrEqual(1);
		expect(Math.abs(m1.left - (m0.left + 100))).toBeLessThanOrEqual(1);
		expect(Math.abs(m1.right - m0.right)).toBeLessThanOrEqual(1);
		await handle.focus();
		await page.keyboard.press("ArrowLeft");
		expect(Math.abs((await box(side)).width - (s1.width - 16))).toBeLessThanOrEqual(1);
		const kept = await page.evaluate(() => localStorage.getItem("folder-sync-status/files-split"));
		expect(Number(kept)).toBeCloseTo(s1.width - 16, -1);
		// the Version history list keeps its own width
		expect(await page.evaluate(() => localStorage.getItem("folder-sync-status/history-split"))).toBeNull();
		await page.reload();
		await expect(el(page, ".frow").first()).toBeVisible();
		expect(Math.abs((await box(el(page, "#side"))).width - (s1.width - 16))).toBeLessThanOrEqual(1);
	});

	test("at phone width the list and the file take turns, with a way back, and nothing scrolls sideways", async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 760 });
		await load(page);
		const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
		await expect(el(page, "#side")).toBeVisible();
		await expect(el(page, "#fmain")).toBeHidden();
		await expect(el(page, "#handle")).toBeHidden();
		expect(await sideways()).toBeLessThanOrEqual(0);
		await shot(page, "7-phone-list");
		await open(page, "notes/plan.md");
		await expect(el(page, "#side")).toBeHidden();
		await expect(el(page, "pre[data-preview=text]")).toBeVisible();
		expect((await box(el(page, "pre[data-preview=text]"))).right).toBeLessThanOrEqual(375);
		expect(await sideways()).toBeLessThanOrEqual(0);
		await shot(page, "8-phone-file");
		await el(page, "[data-act=files-back]").click();
		await expect(el(page, "#side")).toBeVisible();
		await expect(el(page, "#fmain")).toBeHidden();
	});

	for (const scheme of ["light", "dark"]) {
		test(`${scheme}: the tab follows the colour scheme, text stays readable`, async ({ page }) => {
			await page.emulateMedia({ colorScheme: scheme });
			await load(page);
			await open(page, "notes/plan.md");
			const colors = await el(page, ".panel").evaluate((panel) => {
				const luminance = (css) => { const [r, g, b] = css.match(/\d+(\.\d+)?/g).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
				const bg = luminance(getComputedStyle(panel).backgroundColor), fg = luminance(getComputedStyle(panel.querySelector("pre")).color);
				return { bg, fg, contrast: (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05) };
			});
			if (scheme === "dark") expect(colors.bg).toBeLessThan(0.1); else expect(colors.bg).toBeGreaterThan(0.9);
			expect(colors.contrast).toBeGreaterThan(7);
			await shot(page, `${scheme}`);
		});
	}
});

test("no request leaves the page's origin through browse, preview, upload, rename and delete", async ({ page }) => {
	const outside = [];
	page.on("request", (r) => { const u = new URL(r.url()); if (!["data:", "blob:"].includes(u.protocol) && !r.url().startsWith("http://127.0.0.1")) outside.push(r.url()); });
	await load(page);
	await open(page, "photos/lab.png");
	await el(page, "#upload-input").setInputFiles({ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") });
	await expect(row(page, "a.txt")).toBeVisible();
	await el(page, "[data-act=file-rename]").click();
	await el(page, "#rename-input").fill("b.txt");
	await el(page, "[data-act=rename-save]").click();
	await expect(row(page, "b.txt")).toBeVisible();
	await el(page, "[data-act=file-delete]").click();
	await el(page, "[data-act=delete-confirm]").click();
	await expect(row(page, "b.txt")).toHaveCount(0);
	expect(outside).toEqual([]);
	for (const r of w.requests) expect(r.path).not.toMatch(/^https?:/);
});
