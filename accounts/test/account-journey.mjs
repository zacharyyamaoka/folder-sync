// The account page, end to end in a real browser (Playwright, Chromium): the Worker's own router and the real Better Auth
// over node:sqlite (test/real-auth.ts) behind a plain http server on a free loopback port, a Stripe fixture standing in for
// api.stripe.com (test/stripe-fixture.ts, TEST MODE only) and a fixture S3 for a person's own bucket. No wrangler, no
// network beyond loopback, nothing deployed.
//
//   node accounts/test/account-journey.mjs [--shots <dir>] [--prefix <name->]     (npm --prefix accounts run journey)
//
// The journey, one line each (PASS / FAIL, exit 1 on any FAIL):
//  1 signs in on the sign-in page by email code and lands on /fs/account;
//  2 sees who they are, how they sign in, storage as a bar and in words, the Free plan, the bucket form, one device;
//  3 clicks Upgrade (Stripe's checkout page is a stub the browser is sent to), Stripe's signed webhook arrives, the page
//    then shows Plus, its bigger limit and Manage billing;
//  4 attaches a bucket of their own (the Worker tries it first), sees it without its secret, and a machine signed in
//    through the device flow is handed THAT bucket's keys; removes it, and the machine gets the service's keys again;
//  5 revokes the machine from the page (a plain form POST), and signs out.
// Screenshots (light, dark, phone width) go to --shots as <prefix><state>-<scheme>-<width>.png (prefix default account-page-2026-11-04-).

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { handle } from "../src/app.ts";
import { realStack } from "./real-auth.ts";
import { fakeStripe, SECRET_KEY, signedEvent, subscription, WEBHOOK_SECRET } from "./stripe-fixture.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(HERE, "..", "site");
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const SHOTS = resolve(arg("--shots") || join(HERE, "..", ".state", "journey-shots"));
const PREFIX = arg("--prefix") ?? "account-page-2026-11-04-";
mkdirSync(SHOTS, { recursive: true });

const results = [];
const step = async (name, run) => {
	try {
		await run();
		results.push([name, true]);
		console.log(`PASS  ${name}`);
	} catch (error) {
		results.push([name, false]);
		console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message.split("\n").join("\n      ") : error}`);
	}
};

const EMAIL = "maker@example.com";
const BYO = { host: "s3.byo.example.test", access: "AKIABYOJOURNEY0042", secret: "journeySECRET/for/the/browser/0123456789" };

// the person's own bucket, answering a listing signed with the right key id
const byoFetch = async (request) => {
	const id = /Credential=([^/,]+)\//.exec(request.headers.get("Authorization") ?? "")?.[1];
	return id === BYO.access
		? new Response('<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 })
		: new Response("<Error/>", { status: 403 });
};

const stripe = await fakeStripe();
let stack;
const server = createServer(async (req, res) => {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const body = chunks.length && !["GET", "HEAD"].includes(req.method) ? Buffer.concat(chunks) : undefined;
	const answer = await handle(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body, redirect: "manual" }), stack.env, stack.deps);
	const out = new Headers(answer.headers);
	const cookies = answer.headers.getSetCookie();
	out.delete("set-cookie");
	res.writeHead(answer.status, [...out.entries(), ...cookies.map((c) => ["set-cookie", c])]);
	res.end(Buffer.from(await answer.arrayBuffer()));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

stack = await realStack({
	PUBLIC_URL: origin,
	FEATURE_PAYMENTS: "on",
	FEATURE_BYO: "on",
	BYO_ENCRYPTION_KEY: "journey-key-0123456789abcdef0123456789abcdef",
	STRIPE_SECRET_KEY: SECRET_KEY,
	STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
	STRIPE_API_URL: stripe.url,
	QUOTA_BYTES: String(50 * 1024 * 1024),
	QUOTA_OBJECTS: "10000",
	ASSETS: { fetch: async (request) => {
		const file = new URL(request.url).pathname.slice(1);
		try { return new Response(readFileSync(join(SITE, file)), { status: 200 }); } catch { return new Response("", { status: 404 }); }
	} },
}, origin);
const hosted = stack.deps.s3;
stack.deps.s3 = (request) => (new URL(request.url).host === BYO.host ? byoFetch(request) : hosted(request));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1000, height: 900 }, locale: "en-US", timezoneId: "UTC" });
await context.route("https://checkout.stripe.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Stripe Checkout (fixture)</title><h1>Stripe Checkout (test mode fixture)</h1>" }));
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error)));
const text = () => page.locator("main").innerText();
const cookieHeader = async () => (await context.cookies(origin)).map((c) => `${c.name}=${c.value}`).join("; ");

/** Light, dark and a phone, of the page as it is now. */
async function shoot(state) {
	const url = page.url();
	for (const [scheme, width, height] of [["light", 1000, 1100], ["dark", 1000, 1100], ["light", 390, 1100], ["dark", 390, 1100]]) {
		await page.setViewportSize({ width, height });
		await page.emulateMedia({ colorScheme: scheme });
		await page.screenshot({ path: join(SHOTS, `${PREFIX}${state}-${scheme}-${width}.png`), fullPage: true });
	}
	// no sideways scroll at phone width: the page fits its screen
	await page.setViewportSize({ width: 390, height: 844 });
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	assert.ok(overflow <= 0, `${state}: the page scrolls sideways by ${overflow}px at phone width`);
	await page.setViewportSize({ width: 1000, height: 900 });
	await page.emulateMedia({ colorScheme: "light" });
	assert.equal(page.url(), url);
}

try {
	await step("1 signs in by email code and lands on the account page", async () => {
		await page.goto(`${origin}/fs/signin?return=/fs/account`);
		await page.getByTestId("fs-signin-email").fill(EMAIL);
		await page.getByTestId("fs-signin-send").click();
		await page.getByTestId("fs-signin-code-step").waitFor({ state: "visible" });
		const code = (await (await fetch(`${origin}/fs/dev/mailbox?email=${encodeURIComponent(EMAIL)}`)).json()).code;
		assert.match(code, /^\d{6}$/);
		await page.getByTestId("fs-signin-code").fill(code);
		await page.getByTestId("fs-signin-verify").click();
		await page.waitForURL(`${origin}/fs/account`);
	});

	const me = await (await fetch(`${origin}/fs/v1/me`, { headers: { Cookie: await cookieHeader() } })).json();
	// 12 MiB of 50: the bar has something to show
	stack.s3.put(`users/${me.user.id}/notes/hosts/laptop/data.bin`, new Uint8Array(12 * 1024 * 1024));
	stack.clock.now += 400_000; // past QUOTA_RECHECK_S (300 s): the page measures again
	await page.reload();

	await step("2 the page shows who they are, how they sign in, storage as a bar, the Free plan, the bucket form", async () => {
		const profile = page.getByTestId("fs-profile");
		assert.match(await profile.innerText(), /maker@example\.com/);
		assert.match(await page.getByTestId("fs-methods").innerText(), /Email code/);
		assert.match(await page.getByTestId("fs-usage").innerText(), /12 MiB of 50 MiB/);
		assert.equal(await page.getByTestId("fs-quota").getAttribute("aria-valuenow"), "24");
		assert.match(await page.getByTestId("fs-plan").innerText(), /Free/);
		assert.equal(await page.getByRole("button", { name: "Upgrade" }).count(), 2, "Plus and Pro are on offer");
		assert.ok(await page.getByText("Attach a bucket").isVisible());
		assert.equal(await page.getByTestId("fs-devices").locator("li").count(), 1, "this browser is the one device");
		assert.equal(await page.locator("script").count(), 0, "no script on the page");
		await shoot("free");
	});

	await step("3 Upgrade goes to Stripe's checkout; its signed webhook then makes the plan, the limit and Manage billing", async () => {
		await page.getByRole("button", { name: "Upgrade" }).first().click();
		await page.waitForURL(/checkout\.stripe\.test\/c\/pay\/cs_test_1/);
		assert.match(await page.locator("h1").innerText(), /Stripe Checkout/);
		const row = stack.db.prepare('SELECT "id" FROM "subscription" WHERE "referenceId" = ?').get(me.user.id);
		const customer = stack.db.prepare('SELECT "stripeCustomerId" AS c FROM "user" WHERE "id" = ?').get(me.user.id).c;
		stripe.subscriptions.set("sub_journey", subscription("sub_journey", customer, "folder-sync-plus", "active"));
		const { payload, signature } = signedEvent("checkout.session.completed", { id: "cs_test_x", object: "checkout.session", mode: "subscription", subscription: "sub_journey", client_reference_id: me.user.id, metadata: { userId: me.user.id, subscriptionId: row.id, referenceId: me.user.id } });
		const hook = await fetch(`${origin}/fs/api/auth/stripe/webhook`, { method: "POST", body: payload, headers: { "Content-Type": "application/json", "Stripe-Signature": signature } });
		assert.equal(hook.status, 200);
		await page.goto(`${origin}/fs/account?done=paid`);
		assert.match(await page.getByTestId("fs-plan").innerText(), /Plus[\s\S]*10 GiB/);
		assert.match(await page.getByTestId("fs-usage").innerText(), /12 MiB of 10 GiB/);
		assert.ok(await page.getByRole("button", { name: "Manage billing" }).isVisible());
		assert.match(await page.getByTestId("fs-notice").innerText(), /Thank you/);
		await shoot("plus");
	});

	await step("4 attaches a bucket of their own: tried, shown without its secret, and a machine gets its keys; Remove gives the service's back", async () => {
		await page.getByText("Attach a bucket").click();
		await page.locator('input[name="endpoint"]').fill(`https://${BYO.host}`);
		await page.locator('input[name="bucket"]').fill("my-bucket");
		await page.locator('input[name="prefix"]').fill("folder-sync");
		await page.locator('input[name="accessKeyId"]').fill(BYO.access);
		await page.locator('input[name="secretAccessKey"]').fill(BYO.secret);
		await shoot("bucket-form");
		await page.getByRole("button", { name: "Attach this bucket" }).click();
		await page.waitForURL(/done=byo-attached/);
		const shown = await text();
		assert.match(shown, /s3:\/\/my-bucket\/folder-sync\//);
		assert.ok(shown.includes(BYO.host) && shown.includes("0042"));
		assert.ok(!(await page.content()).includes(BYO.secret) && !shown.includes(BYO.access), "the secret and the whole key id are not on the page");
		const machine = await stack.machine(await cookieHeader());
		const keys = await (await fetch(`${origin}/fs/v1/credentials`, { method: "POST", headers: { Authorization: `Bearer ${machine.token}` } })).json();
		assert.equal(keys.AccessKeyId, BYO.access);
		assert.equal(keys.Store, "s3://my-bucket/folder-sync/");
		await shoot("bucket");
		await page.getByRole("button", { name: "Remove" }).click();
		await page.waitForURL(/done=byo-removed/);
		const back = await (await fetch(`${origin}/fs/v1/credentials`, { method: "POST", headers: { Authorization: `Bearer ${machine.token}` } })).json();
		assert.equal(back.AccessKeyId, "parent-key-id");
	});

	await step("5 revokes the machine from the page, then signs out", async () => {
		await page.goto(`${origin}/fs/account`);
		const devices = page.getByTestId("fs-devices").locator("li");
		assert.equal(await devices.count(), 2, "this browser and the machine");
		assert.match(await page.getByTestId("fs-devices").innerText(), /lab-pc/);
		await shoot("devices");
		await devices.filter({ hasText: "lab-pc" }).getByRole("button", { name: "Revoke" }).click();
		await page.waitForURL(/done=revoked/);
		assert.match(await page.getByTestId("fs-notice").innerText(), /Signed that device out/);
		assert.equal(await page.getByTestId("fs-devices").locator("li").count(), 1);
		await page.getByRole("button", { name: "Sign out" }).click();
		await page.waitForURL(/done=signed-out/);
		assert.match(await text(), /not signed in/);
		await shoot("signed-out");
	});

	await step("no page error was thrown in the browser", async () => {
		assert.deepEqual(pageErrors, []);
	});
} finally {
	await browser.close();
	await new Promise((done) => server.close(done));
	await stripe.close();
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed} of ${results.length} passed; screenshots in ${SHOTS}`);
process.exit(failed ? 1 : 0);
