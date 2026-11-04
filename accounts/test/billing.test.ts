// Payments, TEST MODE only (accounts/src/billing.ts, auth.ts's @better-auth/stripe, docs/PAYMENTS.md): a plan sets a
// person's storage quota; QUOTA_BY_OWNER stays the operator's override over it.
//
// What must hold:
// - with payments off nothing here exists (test/features.test.ts); with them on, a person without a subscription has the
//   free quota (QUOTA_BYTES / QUOTA_OBJECTS), and an active or trialing subscription to a configured plan has that plan's;
// - the plan comes from a signed Stripe webhook, never from the page or the request; a bad signature changes nothing;
// - a canceled or unpaid subscription falls back to free; one person's plan is never another's;
// - a live key is refused (this build takes Stripe TEST keys only), and with the keys missing payments say so (503);
// - the quota the plan sets is the one the key broker enforces: over the free quota, read-only keys; under the plan's,
//   read-write.
// Stripe is a local fixture (test/stripe-fixture.ts) answering the shapes Stripe documents; the webhooks are signed with
// the official SDK's test helper.

import assert from "node:assert/strict";
import { test } from "node:test";
import { handle } from "../src/app.ts";
import { OWN, realStack } from "./real-auth.ts";
import { fakeStripe, SECRET_KEY, signedEvent, subscription, WEBHOOK_SECRET, type FakeStripe } from "./stripe-fixture.ts";

const PLANS = JSON.stringify({
	plus: { title: "Plus", bytes: 20_000, objects: 1_000, lookupKey: "folder-sync-plus" },
	pro: { title: "Pro", bytes: 200_000, objects: 10_000, lookupKey: "folder-sync-pro" },
});
const EMAIL = "maker@example.com";

async function payments(extra: Record<string, string> = {}) {
	const stripe = await fakeStripe();
	const s = await realStack({
		FEATURE_PAYMENTS: "on",
		STRIPE_SECRET_KEY: SECRET_KEY,
		STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
		STRIPE_API_URL: stripe.url,
		QUOTA_BYTES: "2000",
		QUOTA_OBJECTS: "50",
		PLANS,
		...extra,
	});
	/** Stripe's call to this Worker: no cookie, no Origin, a signed body. */
	const webhook = (payload: string, signature: string) =>
		handle(new Request(`${OWN}/fs/api/auth/stripe/webhook`, { method: "POST", body: payload, headers: { "Content-Type": "application/json", "Stripe-Signature": signature } }), s.env, s.deps);
	/** A person subscribes: checkout, then the webhook Stripe sends when they have paid. */
	async function subscribe(who: { page: Record<string, string>; userId: string }, plan: "plus" | "pro", status = "active") {
		const checkout = await s.post("/fs/v1/billing/checkout", { plan }, who.page);
		assert.equal(checkout.status, 200, await checkout.clone().text());
		const row = s.db.prepare('SELECT "id", "stripeCustomerId" AS customer FROM "subscription" WHERE "referenceId" = ? ORDER BY rowid DESC').get(who.userId) as { id: string };
		const customer = s.db.prepare('SELECT "stripeCustomerId" AS customer FROM "user" WHERE "id" = ?').get(who.userId) as { customer: string };
		const subId = `sub_${who.userId}`;
		stripe.subscriptions.set(subId, subscription(subId, customer.customer, `folder-sync-${plan}`, status));
		const { payload, signature } = signedEvent("checkout.session.completed", { id: "cs_test_x", object: "checkout.session", mode: "subscription", subscription: subId, client_reference_id: who.userId, metadata: { userId: who.userId, subscriptionId: row.id, referenceId: who.userId } });
		const answer = await webhook(payload, signature);
		assert.equal(answer.status, 200, await answer.clone().text());
		return { subId, customer: customer.customer, rowId: row.id };
	}
	return { stripe, s, webhook, subscribe };
}

async function quotaOf(s: Awaited<ReturnType<typeof realStack>>, cookie: string): Promise<{ bytes: number; objects: number }> {
	return (await (await s.call("/fs/v1/usage", { headers: { Cookie: cookie } })).json()).quota;
}

test("a person with no subscription has the free quota; the plans on offer are listed with what each gives", async () => {
	const { stripe, s } = await payments();
	try {
		const a = await s.browser(EMAIL);
		assert.deepEqual(await quotaOf(s, a.cookie), { bytes: 2000, objects: 50 });
		const billing = await (await s.call("/fs/v1/billing", { headers: { Cookie: a.cookie } })).json();
		assert.equal(billing.owner, a.userId);
		assert.deepEqual(billing.plan, { id: "free", title: "Free", bytes: 2000, objects: 50, source: "free" });
		assert.deepEqual(billing.plans.map((p: { id: string }) => p.id), ["free", "plus", "pro"]);
		assert.deepEqual(billing.plans.find((p: { id: string }) => p.id === "plus"), { id: "plus", title: "Plus", bytes: 20_000, objects: 1_000, current: false, purchasable: true });
		assert.equal(billing.subscription, null);
		assert.equal(billing.configured, true);
		assert.equal(stripe.calls.length, 0, "signing in and looking at plans never calls Stripe");
	} finally {
		await stripe.close();
	}
});

test("plan -> quota: checkout, then a signed webhook; the plan's bytes and files replace the free quota", async () => {
	const { stripe, s, subscribe } = await payments();
	try {
		const a = await s.browser(EMAIL);
		const checkout = await s.post("/fs/v1/billing/checkout", { plan: "plus" }, a.page);
		assert.equal(checkout.status, 200);
		const { url } = await checkout.json();
		assert.match(url, /^https:\/\/checkout\.stripe\.test\/c\/pay\/cs_test_1$/);
		const made = stripe.calls.find((c) => c.method === "POST" && c.path === "/v1/checkout/sessions")!;
		assert.equal(made.form.get("line_items[0][price]"), "price_folder-sync-plus", "the plan's lookup key resolves to its price");
		assert.equal(made.form.get("mode"), "subscription");
		assert.equal(made.form.get("client_reference_id"), a.userId);
		assert.match(decodeURIComponent(made.form.get("success_url")!), /^https:\/\/accounts\.example\.test\/fs\/api\/auth\/subscription\/success\?callbackURL=https:\/\/accounts\.example\.test\/fs\/account/, "back to the account page");
		// paying has not happened yet: still free
		assert.deepEqual(await quotaOf(s, a.cookie), { bytes: 2000, objects: 50 });

		const { subId } = await subscribe(a, "plus");
		assert.ok(subId);
		assert.deepEqual(await quotaOf(s, a.cookie), { bytes: 20_000, objects: 1_000 });
		const billing = await (await s.call("/fs/v1/billing", { headers: { Cookie: a.cookie } })).json();
		assert.equal(billing.plan.id, "plus");
		assert.equal(billing.plan.source, "subscription");
		assert.equal(billing.plans.find((p: { id: string }) => p.id === "plus").current, true);
		assert.equal(billing.subscription.status, "active");
		// the usage figure the pages show carries the same ceiling
		assert.equal((await (await s.call("/fs/v1/usage", { headers: { Cookie: a.cookie } })).json()).quota.bytes, 20_000);
	} finally {
		await stripe.close();
	}
});

test("the quota a plan sets is the one the key broker enforces: read-only over the free quota, read-write under the plan's", async () => {
	const { stripe, s, subscribe } = await payments();
	try {
		const a = await s.browser(EMAIL);
		const laptop = await s.machine(a.cookie);
		const bearer = { Authorization: `Bearer ${laptop.token}` };
		s.s3.put(`users/${a.userId}/notes/hosts/h/big.bin`, new Uint8Array(3000)); // 3000 bytes: over free (2000), under plus (20000)
		const free = await (await s.call("/fs/v1/credentials", { method: "POST", headers: bearer })).json();
		assert.equal(free.ReadOnly, true, "over the free quota");
		await subscribe(a, "plus");
		const plus = await (await s.call("/fs/v1/credentials", { method: "POST", headers: bearer })).json();
		assert.equal(plus.ReadOnly, undefined, `under Plus: ${JSON.stringify(plus)}`);
	} finally {
		await stripe.close();
	}
});

test("QUOTA_BY_OWNER stays the operator's override over the plan; the plan fills what the override leaves out", async () => {
	const { stripe, s, subscribe } = await payments();
	try {
		// bytes overridden, objects left to the plan (ids are random per stack, so the override names whoever signed in)
		const a = await s.browser(EMAIL);
		s.env.QUOTA_BY_OWNER = JSON.stringify({ [a.userId]: { bytes: 777 } });
		await subscribe(a, "pro");
		assert.deepEqual(await quotaOf(s, a.cookie), { bytes: 777, objects: 10_000 }, "the override's bytes, the plan's files");
		const billing = await (await s.call("/fs/v1/billing", { headers: { Cookie: a.cookie } })).json();
		assert.equal(billing.plan.id, "pro", "the plan is still the person's; only the ceiling is the operator's");
		assert.equal(billing.plan.bytes, 777);
		assert.equal(billing.plan.source, "operator");
	} finally {
		await stripe.close();
	}
});

test("a canceled, unpaid or past-due subscription is free again; trialing counts; one person's plan is not another's", async () => {
	const { stripe, s, webhook, subscribe } = await payments();
	try {
		const a = await s.browser(EMAIL);
		const b = await s.browser("other@example.com");
		const { subId, customer } = await subscribe(a, "pro");
		assert.equal((await quotaOf(s, a.cookie)).bytes, 200_000);
		assert.equal((await quotaOf(s, b.cookie)).bytes, 2000, "the other person is untouched");
		const update = async (status: string) => {
			const { payload, signature } = signedEvent("customer.subscription.updated", subscription(subId, customer, "folder-sync-pro", status));
			assert.equal((await webhook(payload, signature)).status, 200);
		};
		await update("past_due");
		assert.equal((await quotaOf(s, a.cookie)).bytes, 2000, "past due is not paid up");
		await update("trialing");
		assert.equal((await quotaOf(s, a.cookie)).bytes, 200_000);
		await update("unpaid");
		assert.equal((await quotaOf(s, a.cookie)).bytes, 2000);
		await update("active");
		const { payload, signature } = signedEvent("customer.subscription.deleted", subscription(subId, customer, "folder-sync-pro", "canceled"));
		assert.equal((await webhook(payload, signature)).status, 200);
		assert.equal((await quotaOf(s, a.cookie)).bytes, 2000, "canceled");
	} finally {
		await stripe.close();
	}
});

test("an upgrade moves the quota to the new plan (customer.subscription.updated with another price)", async () => {
	const { stripe, s, webhook, subscribe } = await payments();
	try {
		const a = await s.browser(EMAIL);
		const { subId, customer } = await subscribe(a, "plus");
		assert.equal((await quotaOf(s, a.cookie)).bytes, 20_000);
		const { payload, signature } = signedEvent("customer.subscription.updated", subscription(subId, customer, "folder-sync-pro", "active"));
		assert.equal((await webhook(payload, signature)).status, 200);
		assert.equal((await quotaOf(s, a.cookie)).bytes, 200_000);
	} finally {
		await stripe.close();
	}
});

test("a webhook with a bad or missing signature changes nothing", async () => {
	const { stripe, s, webhook, subscribe } = await payments();
	try {
		const a = await s.browser(EMAIL);
		const { subId, customer } = await subscribe(a, "plus");
		const forged = signedEvent("customer.subscription.deleted", subscription(subId, customer, "folder-sync-plus", "canceled"), "whsec_somebody_elses");
		assert.equal((await webhook(forged.payload, forged.signature)).status, 400);
		const unsigned = await handle(new Request(`${OWN}/fs/api/auth/stripe/webhook`, { method: "POST", body: forged.payload, headers: { "Content-Type": "application/json" } }), s.env, s.deps);
		assert.equal(unsigned.status, 400);
		assert.equal((await quotaOf(s, a.cookie)).bytes, 20_000, "still on Plus");
	} finally {
		await stripe.close();
	}
});

test("checkout is a signed-in browser's own write (CSRF header and user), for a configured plan only", async () => {
	const { stripe, s } = await payments();
	try {
		const a = await s.browser(EMAIL);
		assert.equal((await s.post("/fs/v1/billing/checkout", { plan: "plus" }, { Cookie: a.cookie })).status, 403, "no CSRF header");
		assert.equal((await s.post("/fs/v1/billing/checkout", { plan: "plus" }, { ...a.page, "X-Folder-Sync-User": "someoneelse1" })).status, 409, "a page showing someone else");
		assert.equal((await s.post("/fs/v1/billing/checkout", { plan: "plus" })).status, 401, "signed out");
		for (const plan of ["free", "enterprise", "", "PLUS "]) {
			const refused = await s.post("/fs/v1/billing/checkout", { plan }, a.page);
			assert.equal(refused.status, 400, `plan ${JSON.stringify(plan)}`);
			assert.equal((await refused.json()).error, "bad_plan");
		}
		assert.equal(stripe.calls.length, 0, "nothing reached Stripe");
	} finally {
		await stripe.close();
	}
});

test("a Stripe failure is a 502 with a reason, not a stack trace or a half-made subscription claim on the quota", async () => {
	const { stripe, s } = await payments();
	try {
		const a = await s.browser(EMAIL);
		stripe.failCheckout = true;
		const refused = await s.post("/fs/v1/billing/checkout", { plan: "plus" }, a.page);
		assert.equal(refused.status, 502);
		const body = await refused.json();
		assert.equal(body.error, "billing_unavailable");
		assert.doesNotMatch(JSON.stringify(body), /sk_test|whsec_/);
		assert.equal((await quotaOf(s, a.cookie)).bytes, 2000);
	} finally {
		await stripe.close();
	}
});

test("the billing portal: a person who has paid is sent to Stripe's page for their own customer; one who has not is refused", async () => {
	const { stripe, s, subscribe } = await payments();
	try {
		const a = await s.browser(EMAIL);
		const before = await s.post("/fs/v1/billing/portal", {}, a.page);
		assert.equal(before.status, 400);
		assert.equal((await before.json()).error, "no_customer");
		const { customer } = await subscribe(a, "plus");
		const portal = await s.post("/fs/v1/billing/portal", {}, a.page);
		assert.equal(portal.status, 200);
		assert.match((await portal.json()).url, new RegExp(`^https://billing\\.stripe\\.test/p/session/bps_test_1\\?customer=${customer}$`));
	} finally {
		await stripe.close();
	}
});

test("TEST MODE ONLY: a live secret key is refused; missing keys say not configured; the plugin is not loaded either way", async () => {
	const stripe = await fakeStripe();
	try {
		for (const extra of [{ STRIPE_SECRET_KEY: "sk_live_0123456789abcdef" }, { STRIPE_SECRET_KEY: "" }, { STRIPE_WEBHOOK_SECRET: "" }]) {
			const s = await realStack({ FEATURE_PAYMENTS: "on", STRIPE_SECRET_KEY: SECRET_KEY, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_API_URL: stripe.url, PLANS, ...extra });
			const a = await s.browser(EMAIL);
			const checkout = await s.post("/fs/v1/billing/checkout", { plan: "plus" }, a.page);
			assert.equal(checkout.status, 503, JSON.stringify(extra));
			const body = await checkout.json();
			assert.equal(body.error, "not_configured");
			assert.doesNotMatch(JSON.stringify(body), /sk_live_0123/, "a key is never echoed");
			const billing = await (await s.call("/fs/v1/billing", { headers: { Cookie: a.cookie } })).json();
			assert.equal(billing.configured, false);
			assert.deepEqual(billing.plans.filter((p: { purchasable: boolean }) => p.purchasable), [], "nothing can be bought");
			const { payload, signature } = signedEvent("customer.subscription.deleted", subscription("sub_x", "cus_x", "folder-sync-plus", "canceled"));
			const hook = await handle(new Request(`${OWN}/fs/api/auth/stripe/webhook`, { method: "POST", body: payload, headers: { "Stripe-Signature": signature } }), s.env, s.deps);
			assert.equal(hook.status, 503);
		}
		assert.equal(stripe.calls.length, 0);
	} finally {
		await stripe.close();
	}
});

test("without PLANS the defaults are Free, Plus (10 GiB) and Pro (100 GiB), bought by the lookup keys folder-sync-plus / folder-sync-pro", async () => {
	const stripe = await fakeStripe();
	try {
		const s = await realStack({ FEATURE_PAYMENTS: "on", STRIPE_SECRET_KEY: SECRET_KEY, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_API_URL: stripe.url });
		const a = await s.browser(EMAIL);
		const billing = await (await s.call("/fs/v1/billing", { headers: { Cookie: a.cookie } })).json();
		assert.deepEqual(billing.plans.map((p: { id: string; bytes: number }) => [p.id, p.bytes]), [["free", 1024 ** 3], ["plus", 10 * 1024 ** 3], ["pro", 100 * 1024 ** 3]]);
		assert.equal((await s.post("/fs/v1/billing/checkout", { plan: "pro" }, a.page)).status, 200);
		assert.equal(stripe.calls.find((c) => c.path === "/v1/checkout/sessions")!.form.get("line_items[0][price]"), "price_folder-sync-pro");
	} finally {
		await stripe.close();
	}
});

test("a malformed PLANS is ignored for the defaults, never a crash", async () => {
	const stripe = await fakeStripe();
	try {
		const s = await realStack({ FEATURE_PAYMENTS: "on", STRIPE_SECRET_KEY: SECRET_KEY, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_API_URL: stripe.url, PLANS: "{not json" });
		const a = await s.browser(EMAIL);
		const billing = await (await s.call("/fs/v1/billing", { headers: { Cookie: a.cookie } })).json();
		assert.deepEqual(billing.plans.map((p: { id: string }) => p.id), ["free", "plus", "pro"]);
	} finally {
		await stripe.close();
	}
});

test("the account page: a free person is offered the plans, a paying one 'Manage billing'; the forms work without a script", async () => {
	const { stripe, s, subscribe } = await payments();
	try {
		const a = await s.browser(EMAIL);
		const page = async () => (await s.call("/fs/account", { headers: { Cookie: a.cookie } })).text();
		const free = await page();
		assert.match(free, /data-testid="fs-plan"/);
		assert.match(free, /Free/);
		assert.match(free, /<form method="post" action="\/fs\/account\/plan">/);
		assert.match(free, /name="plan" value="plus"/);
		assert.doesNotMatch(free, /Manage billing/);
		// the Upgrade form: a page that takes the browser on to Stripe's (never a 303: the page's form-action 'self' blocks a
		// redirect to another site in Chrome, found by test/account-journey.mjs)
		const form = (path: string, body: Record<string, string>, origin = OWN) =>
			handle(new Request(`${OWN}${path}`, { method: "POST", redirect: "manual", headers: { Cookie: a.cookie, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() }), s.env, s.deps);
		const sent = await form("/fs/account/plan", { plan: "plus", user: a.userId });
		assert.equal(sent.status, 200);
		const html = await sent.text();
		assert.match(html, /<meta http-equiv="refresh" content="0;url=https:\/\/checkout\.stripe\.test\/c\/pay\/cs_test_1">/);
		assert.match(html, /<a href="https:\/\/checkout\.stripe\.test\/c\/pay\/cs_test_1" data-testid="fs-go">/);
		assert.doesNotMatch(html, /<script/i);
		assert.match(sent.headers.get("Content-Security-Policy") || "", /form-action 'self'/);
		assert.equal((await form("/fs/account/plan", { plan: "plus", user: a.userId }, "https://evil.example")).status, 403, "a form from another site");
		assert.match((await form("/fs/account/plan", { plan: "plus", user: "someoneelse1" })).headers.get("Location")!, /done=wrong-user/);
		assert.match((await form("/fs/account/plan", { plan: "nope", user: a.userId })).headers.get("Location")!, /done=bad-plan/);

		await subscribe(a, "plus");
		const paid = await page();
		assert.match(paid, /Plus/);
		assert.match(paid, /Manage billing/);
		assert.match(paid, /data-testid="fs-quota"/);
		const manage = await form("/fs/account/billing", { user: a.userId });
		assert.equal(manage.status, 200);
		assert.match(await manage.text(), /content="0;url=https:\/\/billing\.stripe\.test\//);
	} finally {
		await stripe.close();
	}
});
