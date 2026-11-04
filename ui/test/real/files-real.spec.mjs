// The Files page against the REAL accounts Worker: wrangler dev (Better Auth on a local D1, the Worker's own `handle`),
// folder-sync's R2 stand-in in front of rclone's S3 store, and this checkout's /fs/ui/v1 served by that Worker. Nothing
// is stubbed: a person signs in with an email code on the real sign-in page, lands on /fs/files under the page's real
// Content-Security-Policy, and browses, previews, uploads, renames and deletes through the Worker's real routes.
//
// It runs only when FS_STACK holds the stack's JSON (`node accounts/scripts/dev.mjs up`'s last line); ui/scripts/files-real.mjs
// starts the stack, runs this and stops exactly what it started. It talks to the stack over HTTP and, to give a person
// machine files to browse, puts two machines' manifests and files in their folder as docs/CONTRACT.md lays them out (it
// needs RCLONE, the pinned rclone). FS_SHOTS=<dir> writes screenshots (FS_SHOT_PREFIX names them) and FS_HERO=<file.webm>
// records the browse -> open -> upload journey.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "@playwright/test";
import { GPU, LAPTOP } from "../stub.mjs";
import { PLAN, SEED } from "../files-world.mjs";

const STACK = process.env.FS_STACK ? JSON.parse(process.env.FS_STACK) : null;
const SHOTS = process.env.FS_SHOTS;
const PREFIX = process.env.FS_SHOT_PREFIX || "files-real-";
const HERO = process.env.FS_HERO;
test.skip(!STACK, "set FS_STACK to the dev stack's JSON (ui/scripts/files-real.mjs does)");
test.describe.configure({ mode: "serial" });

const BASE = STACK?.accounts;
// WHY a new address per run: a person's files persist in the stack's store, so a rerun on the same stack starts clean
const RUN = Date.now().toString(36);
const address = (name) => `${name}-${RUN}@example.com`;
const sha = (data) => createHash("sha256").update(data).digest("hex");
const el = (page, css) => page.locator(`folder-sync-status ${css}`);
const row = (page, path) => el(page, `.frow[title="${path}"]`);
const box = (locator) => locator.evaluate((e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, width: r.width }; });
const shot = async (page, name) => {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: join(SHOTS, `${PREFIX}${name}.png`) });
};
const open = async (page, path) => {
	await row(page, path).click();
	await expect(el(page, ".ftitle b")).toHaveText(path.split("/").pop());
};

/** Signs in on the real page with an email code (the dev stack's mailbox), and lands on `back`. */
async function signIn(page, email, back = "/fs/files") {
	await page.goto(`${BASE}${back}`);
	await expect(page).toHaveURL(/\/fs\/signin\?return=/);
	await page.getByTestId("fs-signin-email").fill(email);
	await page.getByTestId("fs-signin-send").click();
	await expect(page.getByTestId("fs-signin-code-step")).toBeVisible();
	const mail = await (await page.request.get(`${BASE}/fs/dev/mailbox?email=${encodeURIComponent(email)}`)).json();
	await page.getByTestId("fs-signin-code").fill(mail.code);
	await page.getByTestId("fs-signin-verify").click();
	await page.waitForURL(`${BASE}${back}**`);
}

/** Two machines' files in the person's folder `notes`, put where R2 would hold them (docs/CONTRACT.md): written the way a
 *  machine's sync does, with rclone's S3 client through the stack's R2 stand-in, signed with the stack's own test key.
 *  WHY not straight into the store's directory: rclone's S3 server caches its listings, so files dropped there are not seen. */
function seedMachines(userId) {
	const scratch = mkdtempSync(join(tmpdir(), "files-seed-"));
	for (const [host, name] of [[GPU, "bam-GPU"], [LAPTOP, "bam-laptop"]]) {
		const mine = SEED.filter(([h]) => h === host);
		mkdirSync(join(scratch, host), { recursive: true });
		for (const [, path, data] of mine) {
			mkdirSync(join(scratch, host, path, ".."), { recursive: true });
			writeFileSync(join(scratch, host, path), data);
		}
		writeFileSync(join(scratch, host, "manifest.json"), JSON.stringify({
			schema: "folder-sync-manifest/1", project: "notes", host_id: host, host_name: name, seq: 5, generated_at: new Date().toISOString(),
			files: mine.map(([, path, data, mtime]) => ({ path, size: Buffer.from(data).length, mtime, sha256: sha(Buffer.from(data)), written_at: mtime })),
		}));
	}
	const keys = JSON.parse(readFileSync(join(STACK.stateDir, "keys.json"), "utf8"));
	const sent = spawnSync(process.env.RCLONE, ["copy", scratch, `:s3:${STACK.bucket}/users/${userId}/notes/hosts`, "--config", "/dev/null", "--s3-provider", "Other", "--s3-endpoint", STACK.endpoint,
		"--s3-access-key-id", keys.parentKeyId, "--s3-secret-access-key", keys.parentSecret, "--s3-no-check-bucket"], { encoding: "utf8" });
	if (sent.status !== 0) throw new Error(`seeding the stack's store failed: ${sent.stderr || sent.error}`);
	return scratch;
}

/** Every file under `dir` with its hash: what "the machine's files did not change" is measured on. */
const ofMachines = (all) => Object.fromEntries(Object.entries(all).filter(([key]) => key.startsWith(`/${GPU}/`) || key.startsWith(`/${LAPTOP}/`)));
function tree(dir, base = dir, out = {}) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) tree(full, base, out);
		else out[full.slice(base.length)] = sha(readFileSync(full));
	}
	return out;
}

test("the whole journey on the real Worker: sign in, browse, preview every kind, read-only devices, upload, rename, delete, history, isolation", async ({ page, browser }) => {
	const problems = [];
	page.on("console", (m) => { if (m.type() === "error" || /Content Security Policy|Refused to/.test(m.text())) problems.push(m.text()); });
	page.on("pageerror", (e) => problems.push(String(e)));
	await signIn(page, address("maker"));
	const me = await (await page.request.get(`${BASE}/fs/v1/me`)).json();
	const userId = me.user.id;
	seedMachines(userId);
	// the machines' objects as the store holds them, to compare after everything the page does
	const machines = join(STACK.stateDir, "s3", STACK.bucket, "users", userId, "notes", "hosts");
	const seeded = tree(machines);

	const served = page.waitForResponse((r) => r.url() === `${BASE}/fs/files` && r.status() === 200);
	await page.reload();
	const headers = (await served).headers();
	expect(headers["content-security-policy"]).toContain("media-src 'self'");
	expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
	expect(headers["x-frame-options"]).toBe("DENY");

	// browse: the machines' files grouped by device, nothing on the web yet
	await expect(el(page, ".body")).toHaveAttribute("data-view", "files");
	await expect(el(page, ".fgroup h3")).toHaveText(["bam-GPU · synced from a device", "bam-laptop · synced from a device"]);
	await expect(el(page, ".frow")).toHaveCount(9);
	await expect(row(page, "notes/plan.md").locator(".fmeta")).toContainText(`${PLAN.length} B`);
	await expect(row(page, "notes/plan.md").locator(".fmeta")).toContainText("bam-GPU");
	await expect(page).toHaveTitle("Files · folder-sync");
	await shot(page, "1-browse");

	// open each kind with the browser's own preview, through the real file route and the page's real policy
	await open(page, "notes/plan.md");
	await expect(el(page, "pre[data-preview=text]")).toHaveText(PLAN.trimEnd());
	await expect(el(page, "[data-readonly]")).toContainText("Written by bam-GPU; edit it there.");
	await expect(el(page, ".factions button, .factions a")).toHaveText(["Download", "Version history"]);
	await shot(page, "2-text-readonly");
	await open(page, "notes/todo.json");
	await expect(el(page, "pre[data-preview=text]")).toContainText('"todo": ["clamp", "bracket"]');
	await open(page, "photos/lab.png");
	await expect.poll(() => el(page, "img[data-preview=image]").evaluate((i) => i.complete && i.naturalWidth)).toBe(48);
	await shot(page, "3-image");
	const pdf = page.waitForResponse((r) => r.url().endsWith("/docs/spec.pdf"));
	await open(page, "docs/spec.pdf");
	const pdfAnswer = await pdf;
	expect(pdfAnswer.status()).toBe(200);
	expect(pdfAnswer.headers()["content-type"]).toBe("application/pdf");
	expect(pdfAnswer.headers()["x-content-type-options"]).toBe("nosniff");
	await expect(el(page, "iframe[data-preview=pdf]")).toBeVisible();
	await open(page, "clips/demo.webm");
	await expect.poll(() => el(page, "video[data-preview=video]").evaluate((v) => v.readyState >= 1 && v.duration)).toBeGreaterThan(0.5);
	await shot(page, "4-video");
	await open(page, "audio/beep.wav");
	await expect.poll(() => el(page, "audio[data-preview=audio]").evaluate((a) => a.readyState >= 1 && a.duration)).toBeGreaterThan(0.3);
	await open(page, "cad/bracket.step");
	await expect(el(page, "[data-nopreview] a")).toHaveAttribute("download", "bracket.step");
	await open(page, "logs/agent.log");
	await expect(el(page, "[data-nopreview]")).toContainText("too big to show here");
	await open(page, "readme.md");
	await expect(el(page, "[data-readonly]")).toContainText("Written by bam-laptop; edit it there.");

	// upload: the button, then a drop; both land in the web host, and open
	await el(page, "#upload-input").setInputFiles({ name: "hello.md", mimeType: "text/markdown", buffer: Buffer.from("# Hello from the web\n\nuploaded in a browser\n") });
	await expect(el(page, "[data-note=info]")).toHaveText("Added hello.md to Web.");
	await expect(el(page, ".fgroup h3").first()).toHaveText("Web · you can change these here");
	await expect(el(page, ".ftitle b")).toHaveText("hello.md");
	await expect(el(page, "pre[data-preview=text]")).toContainText("uploaded in a browser");
	await expect(el(page, "[data-readonly]")).toHaveCount(0);
	await expect(el(page, ".factions button, .factions a")).toHaveText(["Download", "Version history", "Rename", "Delete"]);
	const dt = await page.evaluateHandle(() => { const d = new DataTransfer(); d.items.add(new File([new Uint8Array([1, 2, 3])], "dropped.bin")); d.items.add(new File(["dropped\n"], "dropped.txt")); return d; });
	await el(page, "#fview").dispatchEvent("dragenter", { dataTransfer: dt });
	await expect(el(page, "#fview.dropping")).toHaveCount(1);
	await el(page, "#fview").dispatchEvent("drop", { dataTransfer: dt });
	await expect(el(page, "[data-note=info]")).toHaveText("Added 2 files to Web.");
	await expect(el(page, ".fgroup").first().locator(".frow")).toHaveCount(3);
	const listed = await (await page.request.get(`${BASE}/fs/v1/folders/notes`)).json();
	const web = listed.hosts.find((h) => h.web);
	expect(listed.files.filter((f) => f.host === web.id).map((f) => f.path).sort()).toEqual(["dropped.bin", "dropped.txt", "hello.md"]);
	expect(Buffer.from(await (await page.request.get(`${BASE}/fs/v1/folders/notes/files/${web.id}/dropped.bin`)).body())).toEqual(Buffer.from([1, 2, 3]));
	await shot(page, "5-uploaded");

	// replace keeps the old bytes: Version history of the web file
	await el(page, "#upload-input").setInputFiles({ name: "hello.md", mimeType: "text/markdown", buffer: Buffer.from("# Hello again\n") });
	await expect(el(page, "[data-note=info]")).toHaveText("Added hello.md to Web.");
	await el(page, "[data-act=file-history]").click();
	await expect(el(page, ".body")).toHaveAttribute("data-view", "history");
	await expect(el(page, ".versions button")).toHaveCount(2);
	await expect(el(page, ".versions button").first().locator("b")).toHaveText("Current");
	await el(page, "#tab-files").click();
	await expect(el(page, ".ftitle b")).toHaveText("hello.md");

	// rename, then delete
	await el(page, "[data-act=file-rename]").click();
	await el(page, "#rename-input").fill("docs/hello-web.md");
	await el(page, "[data-act=rename-save]").click();
	await expect(el(page, "[data-note=info]")).toHaveText("Renamed to docs/hello-web.md.");
	await expect(el(page, "pre[data-preview=text]")).toHaveText("# Hello again");
	await expect(row(page, "hello.md")).toHaveCount(0);
	await shot(page, "6-renamed");
	await el(page, "[data-act=file-delete]").click();
	await shot(page, "7-delete-ask");
	await el(page, "[data-act=delete-confirm]").click();
	await expect(el(page, "[data-note=info]")).toContainText("Deleted docs/hello-web.md. It stays in Deleted files for 30 days.");
	await el(page, "#tab-deleted").click();
	await expect(el(page, "table")).toContainText("docs/hello-web.md");
	await shot(page, "8-deleted-files");
	await el(page, "#tab-files").click();
	await expect(row(page, "docs/hello-web.md")).toHaveCount(0);

	// the machines' files are exactly as they were (the web host's own objects are beside them, and changed): nothing the page did reached them
	expect(ofMachines(tree(machines))).toEqual(ofMachines(seeded));
	expect(Object.keys(tree(machines)).some((key) => !key.startsWith(`/${GPU}/`) && !key.startsWith(`/${LAPTOP}/`))).toBe(true);
	// one folder: its name, no picker
	await expect(el(page, "#fview .where")).toHaveText("notes");

	// the list is resizable (measured) and remembers its width
	const side = el(page, "#side"), main = el(page, "#fmain"), handle = el(page, "#handle");
	const s0 = await box(side), m0 = await box(main), h = await box(handle);
	await page.mouse.move(h.left + h.width / 2, h.top + 60);
	await page.mouse.down();
	for (let dx = 25; dx <= 125; dx += 25) await page.mouse.move(h.left + h.width / 2 + dx, h.top + 60);
	await page.mouse.up();
	const s1 = await box(side), m1 = await box(main);
	expect(Math.abs(s1.width - (s0.width + 125))).toBeLessThanOrEqual(1);
	expect(Math.abs(m1.left - (m0.left + 125))).toBeLessThanOrEqual(1);
	await page.reload();
	await expect(el(page, ".frow").first()).toBeVisible();
	expect(Math.abs((await box(el(page, "#side"))).width - s1.width)).toBeLessThanOrEqual(1);
	await page.setViewportSize({ width: 375, height: 760 });
	await open(page, "notes/plan.md");
	await expect(el(page, "#side")).toBeHidden();
	expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
	await shot(page, "9-phone");
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.emulateMedia({ colorScheme: "dark" });
	await expect(el(page, "pre[data-preview=text]")).toBeVisible();
	await shot(page, "10-dark");
	await page.emulateMedia({ colorScheme: "light" });

	// another person: their own empty account, and no way to this folder's files
	const other = await browser.newContext();
	const stranger = await other.newPage();
	await signIn(stranger, address("stranger"));
	await expect(stranger.locator("#files .fsf-note")).toContainText("No folders yet");
	const theirs = await stranger.request.get(`${BASE}/fs/v1/folders/notes?owner=${userId}`);
	expect(theirs.status()).toBe(404);
	expect((await stranger.request.get(`${BASE}/fs/v1/folders/notes/files/${GPU}/notes/plan.md?owner=${userId}`)).status()).toBe(404);
	expect((await stranger.request.get(`${BASE}/fs/v1/folders/notes`)).status()).toBe(200);
	await other.close();
	const signedOut = await browser.newContext();
	expect((await (await signedOut.newPage()).request.get(`${BASE}/fs/v1/folders/notes`)).status()).toBe(401);
	const redirected = await signedOut.request.get(`${BASE}/fs/files`, { maxRedirects: 0 });
	expect(redirected.status()).toBe(303);
	await signedOut.close();

	expect(problems, "no console error, no Content-Security-Policy refusal").toEqual([]);
});

test("hero: browse, open, upload (recorded)", async ({ browser }) => {
	test.skip(!HERO, "set FS_HERO=<file.webm> to record it");
	const setup = await browser.newContext({ viewport: { width: 1180, height: 720 } });
	const first = await setup.newPage();
	await signIn(first, address("hero"));
	const userId = (await (await first.request.get(`${BASE}/fs/v1/me`)).json()).user.id;
	seedMachines(userId);
	const state = await setup.storageState();
	await setup.close();

	const dir = mkdtempSync(join(tmpdir(), "files-hero-"));
	const context = await browser.newContext({ viewport: { width: 1180, height: 720 }, storageState: state, recordVideo: { dir, size: { width: 1180, height: 720 } } });
	// a visible pointer, so the recording shows what is being pressed
	await context.addInitScript(() => {
		addEventListener("DOMContentLoaded", () => {
			const dot = document.createElement("div");
			dot.style.cssText = "position:fixed;z-index:2147483647;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;background:rgba(235,64,52,.55);border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.3);pointer-events:none;left:-40px;top:-40px";
			document.body.append(dot);
			addEventListener("mousemove", (e) => { dot.style.left = `${e.clientX}px`; dot.style.top = `${e.clientY}px`; }, true);
		});
	});
	const page = await context.newPage();
	const beat = (ms = 1100) => page.waitForTimeout(ms);
	await page.goto(`${BASE}/fs/files`);
	await expect(el(page, ".frow").first()).toBeVisible();
	await page.mouse.move(600, 300);
	await beat(1400);
	await open(page, "notes/plan.md");
	await beat();
	await open(page, "photos/lab.png");
	await beat();
	await open(page, "clips/demo.webm");
	await el(page, "video[data-preview=video]").evaluate((v) => { v.muted = true; return v.play(); });
	await beat(1500);
	await open(page, "notes/todo.json");
	await beat(1000);
	await page.mouse.move(1100, 100, { steps: 12 });
	await el(page, "#upload-input").setInputFiles({ name: "trip-notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Trip notes\n\n- shot the lab on Monday\n- uploaded from the browser\n") });
	await expect(el(page, "[data-note=info]")).toHaveText("Added trip-notes.md to Web.");
	await beat(1600);
	await expect(el(page, ".fgroup h3").first()).toHaveText("Web · you can change these here");
	await beat(1400);
	const video = page.video();
	await context.close();
	await video.saveAs(HERO);
	rmSync(dir, { recursive: true, force: true });
});
