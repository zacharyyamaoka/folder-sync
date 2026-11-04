// The four switches of a deployment (accounts/src/features.ts, docs/NEW-APP.md): online file storage (the web host),
// local file sync (the device flow and scoped keys), payments and bring-your-own-tokens. Each app's wrangler env sets
// them; turning one off hides its UI and refuses its routes.
//
// Run against the real accounts layer (test/real-auth.ts: Better Auth over node:sqlite), so a refusal is the router's and
// not a stand-in's. Defaults: storage and sync on, payments and BYO off.

import assert from "node:assert/strict";
import { test } from "node:test";
import { featuresOf, FEATURES } from "../src/features.ts";
import { realStack } from "./real-auth.ts";

const EMAIL = "maker@example.com";

async function refused(answer: Response, feature: string): Promise<void> {
	assert.equal(answer.status, 404, `${answer.url}: ${answer.status}`);
	const body = await answer.json();
	assert.equal(body.error, "feature_off", JSON.stringify(body));
	assert.match(body.why, new RegExp(feature, "i"));
}

test("defaults: storage and sync on; payments and bring-your-own off", () => {
	assert.deepEqual(featuresOf({}), { storage: true, sync: true, payments: false, byo: false });
	assert.deepEqual([...FEATURES], ["storage", "sync", "payments", "byo"]);
});

test("each switch reads on/off (and true/false, 1/0) in any case; an unrecognised value is off, never silently on", () => {
	assert.equal(featuresOf({ FEATURE_PAYMENTS: "on" }).payments, true);
	assert.equal(featuresOf({ FEATURE_PAYMENTS: " TRUE " }).payments, true);
	assert.equal(featuresOf({ FEATURE_BYO: "1" }).byo, true);
	assert.equal(featuresOf({ FEATURE_STORAGE: "off" }).storage, false);
	assert.equal(featuresOf({ FEATURE_SYNC: "0" }).sync, false);
	assert.equal(featuresOf({ FEATURE_SYNC: "False" }).sync, false);
	// WHY off: a typo in a wrangler var must not turn payments on, and a deployment that wrote something for
	// storage meant to say something about it
	assert.equal(featuresOf({ FEATURE_PAYMENTS: "yess" }).payments, false);
	assert.equal(featuresOf({ FEATURE_STORAGE: "enabled" }).storage, false);
	assert.equal(featuresOf({ FEATURE_STORAGE: "" }).storage, true, "an empty var is unset: the default");
});

test("storage off: the web host's writes, its trash purge and the Files page are refused; storage on: they work", async () => {
	const on = await realStack();
	const a = await on.browser(EMAIL);
	const written = await on.call("/fs/v1/folders/notes/web/a.txt", { method: "PUT", headers: a.page, body: "hello\n" });
	assert.equal(written.status, 200, await written.text());
	assert.equal((await on.call("/fs/files", { headers: { Cookie: a.cookie } })).status, 200);
	assert.match(await (await on.call("/fs/account", { headers: { Cookie: a.cookie } })).text(), /data-testid="fs-files-link"/);

	const off = await realStack({ FEATURE_STORAGE: "off" });
	const b = await off.browser(EMAIL);
	await refused(await off.call("/fs/v1/folders/notes/web/a.txt", { method: "PUT", headers: b.page, body: "hello\n" }), "online file storage");
	await refused(await off.call("/fs/v1/folders/notes/web/a.txt", { method: "DELETE", headers: b.page }), "online file storage");
	await refused(await off.call("/fs/v1/folders/notes/web-trash/purge", { method: "POST", headers: b.page }), "online file storage");
	await refused(await off.call("/fs/files", { headers: { Cookie: b.cookie } }), "online file storage");
	const page = await (await off.call("/fs/account", { headers: { Cookie: b.cookie } })).text();
	assert.doesNotMatch(page, /fs-files-link|Browse your files|\/fs\/files/, "its UI is hidden");
	assert.match(page, /data-testid="fs-devices"/, "the rest of the page stands");
	// nothing was written
	assert.equal([...off.s3.objects.keys()].filter((k) => k.includes("/notes/")).length, 0);
});

test("sync off: the device flow, a machine's keys and its deletes are refused; a browser still signs in", async () => {
	const s = await realStack();
	const a = await s.browser(EMAIL);
	const laptop = await s.machine(a.cookie);
	const bearer = { Authorization: `Bearer ${laptop.token}` };
	assert.equal((await s.call("/fs/v1/credentials", { method: "POST", headers: bearer })).status, 200);
	assert.equal((await s.call("/fs/device", { headers: { Cookie: a.cookie } })).status, 200);

	s.env.FEATURE_SYNC = "off";
	await refused(await s.call("/fs/v1/credentials", { method: "POST", headers: bearer }), "local file sync");
	await refused(await s.call("/fs/v1/folders/notes/hosts/b55e9683-7854-4121-a56a-9bae7c3ab1da/delete", { method: "POST", headers: { ...bearer, "Content-Type": "application/json" }, body: "{}" }), "local file sync");
	await refused(await s.call("/fs/device", { headers: { Cookie: a.cookie } }), "local file sync");
	await refused(await s.post("/fs/api/auth/device/code", { client_id: "folder-sync" }), "local file sync");
	await refused(await s.post("/fs/api/auth/device/approve", { userCode: "ABCD-EFGH" }, { Cookie: a.cookie }), "local file sync");
	await refused(await s.post("/fs/api/auth/device/token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "x", client_id: "folder-sync" }), "local file sync");
	// a browser is still known and signed in
	assert.equal((await s.call("/fs/v1/me", { headers: { Cookie: a.cookie } })).status, 200);
	const page = await (await s.call("/fs/account", { headers: { Cookie: a.cookie } })).text();
	assert.doesNotMatch(page, /Machine|Waiting to sign in|\/fs\/device/, "the machine UI is hidden");
	assert.match(page, /data-testid="fs-devices"/, "browsers are still listed and revocable");
});

test("payments off: Better Auth's Stripe routes, the billing API and the plan section are refused or absent", async () => {
	const s = await realStack({ STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: "whsec_fixture" });
	const a = await s.browser(EMAIL);
	await refused(await s.post("/fs/api/auth/subscription/upgrade", { plan: "plus" }, a.page), "payments");
	await refused(await s.call("/fs/api/auth/stripe/webhook", { method: "POST", body: "{}", headers: { "Stripe-Signature": "t=1,v1=00" } }), "payments");
	await refused(await s.call("/fs/v1/billing", { headers: { Cookie: a.cookie } }), "payments");
	await refused(await s.post("/fs/v1/billing/checkout", { plan: "plus" }, a.page), "payments");
	await refused(await s.post("/fs/v1/billing/portal", {}, a.page), "payments");
	const page = await (await s.call("/fs/account", { headers: { Cookie: a.cookie } })).text();
	assert.doesNotMatch(page, /fs-plan|Upgrade|Manage billing/i);
});

test("payments off: a subscription row in the database changes nobody's quota (QUOTA_BYTES stands)", async () => {
	const s = await realStack({ QUOTA_BYTES: "1000", PLANS: JSON.stringify({ plus: { title: "Plus", bytes: 5000, lookupKey: "k" } }) });
	const a = await s.browser(EMAIL);
	s.db.prepare('INSERT INTO "subscription" ("id", "plan", "referenceId", "status") VALUES (?, ?, ?, ?)').run("sub1", "plus", a.userId, "active");
	const usage = await (await s.call("/fs/v1/usage", { headers: { Cookie: a.cookie } })).json();
	assert.equal(usage.quota.bytes, 1000);
});

test("bring-your-own off: its routes are refused, its section is absent, and a stored bucket is not handed to a machine", async () => {
	const s = await realStack({ BYO_ENCRYPTION_KEY: "byo-key-for-tests-0123456789abcdef0123456789" });
	const a = await s.browser(EMAIL);
	await refused(await s.call("/fs/v1/byo", { headers: { Cookie: a.cookie } }), "bring your own");
	await refused(await s.call("/fs/v1/byo", { method: "PUT", headers: { ...a.page, "Content-Type": "application/json" }, body: "{}" }), "bring your own");
	await refused(await s.call("/fs/v1/byo", { method: "DELETE", headers: a.page }), "bring your own");
	const page = await (await s.call("/fs/account", { headers: { Cookie: a.cookie } })).text();
	assert.doesNotMatch(page, /fs-byo|your own bucket/i);
	// a row from before the switch went off is ignored: the machine gets the service's keys
	s.db.prepare('INSERT INTO "byo_store" ("owner_id", "endpoint", "bucket", "prefix", "key_hint", "sealed", "created_at", "updated_at") VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(a.userId, "https://s3.byo.example.test", "mine", "", "1234", "v1.x.y", "2026-11-04T00:00:00Z", "2026-11-04T00:00:00Z");
	const laptop = await s.machine(a.cookie);
	const keys = await (await s.call("/fs/v1/credentials", { method: "POST", headers: { Authorization: `Bearer ${laptop.token}` } })).json();
	assert.equal(keys.AccessKeyId, "parent-key-id");
	assert.equal(keys.Endpoint, "https://acct0123.r2.cloudflarestorage.com");
});

test("every switch on at once: the pages and routes of all four exist", async () => {
	const s = await realStack({ FEATURE_PAYMENTS: "on", FEATURE_BYO: "on" });
	const a = await s.browser(EMAIL);
	const page = await (await s.call("/fs/account", { headers: { Cookie: a.cookie } })).text();
	assert.match(page, /data-testid="fs-files-link"/);
	assert.match(page, /data-testid="fs-devices"/);
	assert.match(page, /data-testid="fs-plan"/);
	assert.match(page, /data-testid="fs-byo"/);
});
