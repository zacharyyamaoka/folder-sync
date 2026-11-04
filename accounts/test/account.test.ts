// The stock account page (/fs/account, src/devices.ts + src/account.ts): profile, sign-in methods, storage against the
// quota with a way to the Storage view, the plan (payments on), bring-your-own (BYO on), devices and Sign out. One server-rendered page,
// no script (it is where a person goes when something is wrong), calm, light and dark, usable at phone width.
//
// WHY not Better Auth's own UI kit: @daveyplate/better-auth-ui (the maintained kit) is React + shadcn/Radix components,
// and Better Auth ships no plain-HTML account page; this page has to work on a Worker with JavaScript off. The data
// still comes from Better Auth (sessions, device grants, linked accounts, the Stripe plugin's subscription rows).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { realStack } from "./real-auth.ts";

const EMAIL = "maker@example.com";

test("signed out: the page says so and offers Sign in, back to the account page", async () => {
	const s = await realStack();
	const page = await (await s.call("/fs/account")).text();
	assert.match(page, /You're not signed in here/);
	assert.match(page, /href="\/fs\/signin\?return=\/fs\/account"/);
	assert.doesNotMatch(page, /data-testid="fs-profile"/);
});

test("profile and sign-in methods: who, and every way in this account can use (email code; Google once linked)", async () => {
	const s = await realStack();
	const a = await s.browser(EMAIL);
	const page = async () => (await s.call("/fs/account", { headers: { Cookie: a.cookie } })).text();
	const first = await page();
	assert.match(first, /data-testid="fs-profile"/);
	assert.match(first, /maker@example\.com/);
	assert.match(first, /data-testid="fs-methods"/);
	assert.match(first, /Email code/);
	assert.doesNotMatch(first, /Google/);
	s.db.prepare('INSERT INTO "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)').run("acc1", "g-123", "google", a.userId, "2026-11-04T00:00:00Z", "2026-11-04T00:00:00Z");
	const linked = await page();
	assert.match(linked, /Google/);
	assert.doesNotMatch(linked, /g-123/, "a provider's own id is not shown");
	assert.doesNotMatch(linked, /accessToken|refreshToken/);
});

test("storage: used against the quota as a bar and as words; over the quota the bar says so; a way to the Storage view", async () => {
	const s = await realStack({ QUOTA_BYTES: "2000", QUOTA_OBJECTS: "50" });
	const a = await s.browser(EMAIL);
	s.s3.put(`users/${a.userId}/notes/hosts/h/a.bin`, new Uint8Array(500));
	const page = async () => (await s.call("/fs/account", { headers: { Cookie: a.cookie } })).text();
	const quarter = await page();
	assert.match(quarter, /data-testid="fs-usage"[^>]*>[^<]*500 bytes of 2\.0 KiB/);
	assert.match(quarter, /data-testid="fs-quota"[^>]*role="progressbar"[^>]*aria-valuenow="25"|data-testid="fs-quota"[^>]*aria-valuenow="25"[^>]*role="progressbar"/);
	assert.match(quarter, /href="\/fs\/files\?view=storage"/);
	assert.doesNotMatch(quarter, /fs-over/);
	s.s3.put(`users/${a.userId}/notes/hosts/h/b.bin`, new Uint8Array(2500));
	s.clock.now += 400_000; // past QUOTA_RECHECK_S: measured again
	const over = await page();
	assert.match(over, /data-testid="fs-over"/);
	assert.match(over, /aria-valuenow="100"/, "the bar stops at full");
	assert.match(over, /class="fs-bar fs-bar-over"/);
});

test("no script on the page, and its stylesheet has light and dark tokens and a phone layout", async () => {
	const s = await realStack({ FEATURE_PAYMENTS: "on", FEATURE_BYO: "on", BYO_ENCRYPTION_KEY: "k".repeat(40) });
	const a = await s.browser(EMAIL);
	const page = await (await s.call("/fs/account", { headers: { Cookie: a.cookie } })).text();
	assert.doesNotMatch(page, /<script/i);
	assert.match(page, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
	const css = readFileSync(new URL("../site/account.css", import.meta.url), "utf8");
	assert.match(css, /@media \(prefers-color-scheme: dark\)/);
	assert.match(css, /@media \(max-width: \d+px\)/);
	assert.match(css, /color-scheme: light dark/);
	// WHY: an auto grid column is as wide as its widest unbreakable line (a long device name), so the card overflowed a phone
	assert.match(css, /grid-template-columns: minmax\(0, 1fr\)/);
	// every control a person presses is a form or a link: nothing needs a script
	assert.doesNotMatch(page, /\sonclick=|javascript:/i);
});

test("the sections come in a fixed calm order: profile, storage, plan, your own bucket, devices, sign out", async () => {
	const s = await realStack({ FEATURE_PAYMENTS: "on", FEATURE_BYO: "on", BYO_ENCRYPTION_KEY: "k".repeat(40) });
	const a = await s.browser(EMAIL);
	const page = await (await s.call("/fs/account", { headers: { Cookie: a.cookie } })).text();
	const order = ["fs-profile", "fs-storage", "fs-plan", "fs-byo", "fs-devices", "fs-signout"].map((id) => page.indexOf(`data-testid="${id}"`));
	assert.ok(order.every((at) => at > 0), `missing a section: ${order}`);
	assert.deepEqual([...order].sort((x, y) => x - y), order);
});

test("a person whose bucket is their own is told the quota is not theirs to fill", async () => {
	const s = await realStack({ FEATURE_BYO: "on", BYO_ENCRYPTION_KEY: "k".repeat(40) });
	const a = await s.browser(EMAIL);
	s.db.prepare('INSERT INTO "byo_store" ("owner_id", "endpoint", "bucket", "prefix", "key_hint", "sealed", "created_at", "updated_at") VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(a.userId, "https://s3.byo.example.test", "mine", "", "1234", "v1.x.y", "2026-11-04T00:00:00Z", "2026-11-04T00:00:00Z");
	const page = await (await s.call("/fs/account", { headers: { Cookie: a.cookie } })).text();
	assert.match(page, /data-testid="fs-byo-note"/);
	assert.match(page, /your machines sync to your own bucket/i);
});
