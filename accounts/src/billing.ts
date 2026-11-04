// Payments, TEST MODE ONLY (PEP 0003 §3.11, docs/PAYMENTS.md): plans set the storage quota. Stripe itself sits behind the
// identity adapter (auth.ts loads Better Auth's @better-auth/stripe plugin and answers the `billing` port below), so this file
// imports neither Better Auth nor Stripe; it is the routes, the plans on offer and the person's own state.
//
//   GET  /fs/v1/billing            { owner, enabled, configured, plan, plans, subscription, customer }
//   POST /fs/v1/billing/checkout   { plan } -> { url }: Stripe's hosted checkout for that plan (a browser's own write)
//   POST /fs/v1/billing/portal     {} -> { url }: Stripe's billing portal, for a person who has paid before
//   (the plugin's own routes, under /fs/api/auth/: subscription/* and stripe/webhook; the webhook is Stripe's call to us)
//   POST /fs/account/plan | /fs/account/billing   the account page's forms (devices.ts), the same two calls, 303 to the url
//
// WHY the plan comes from the webhook and nowhere else: Stripe tells the Worker (signed with STRIPE_WEBHOOK_SECRET, checked by
// the plugin) that a person's subscription is active; a page, a redirect back from Stripe or a request body never sets a
// plan. The webhook updates the plugin's `subscription` row, and quota.ts quotaFor reads that row back on every request.
// WHY test keys only: Zach, 2026-11-04: payments are built and proved in Stripe's test mode first. A live key (sk_live_,
// rk_live_) is refused outright, as if no key were set, so a mispasted secret cannot take real money.
// WHY customers are made at checkout and not at sign-up: signing in never calls Stripe, and only a person who buys becomes a
// Stripe customer (createCustomerOnSignUp is off in auth.ts).

import type { App } from "./apps.ts";
import { fail, json, jsonBody, session, writer, type Deps, type Env, type Person } from "./app.ts";
import { freePlan, plansOf, type Plan, type PlanEnv } from "./plans.ts";
import { ownerOverride, quotaFor } from "./quota.ts";

export interface BillingEnv {
	/** Stripe's secret key, TEST mode (sk_test_… or a restricted rk_test_…). Anything else is refused. */
	STRIPE_SECRET_KEY?: string;
	/** The webhook endpoint's signing secret (whsec_…). */
	STRIPE_WEBHOOK_SECRET?: string;
	/** Another Stripe API, like stripe-mock (http://127.0.0.1:12111). Unset: api.stripe.com. */
	STRIPE_API_URL?: string;
}

/** What the routes need from Stripe: a hosted page's address. Answered by auth.ts over Better Auth's Stripe plugin. */
export interface BillingPort {
	checkout(request: Request, app: App | null, person: Person, plan: Plan, urls: { success: string; cancel: string }): Promise<string>;
	portal(request: Request, app: App | null, person: Person, returnUrl: string): Promise<string>;
}

const TEST_KEY = /^(sk|rk)_test_[A-Za-z0-9_]{8,}$/;

/** Whether Stripe can be used here: both secrets are set and the key is a TEST-mode key. */
export function stripeReady(env: BillingEnv): boolean {
	return TEST_KEY.test(env.STRIPE_SECRET_KEY ?? "") && !!env.STRIPE_WEBHOOK_SECRET;
}

export interface PlanLine {
	id: string;
	title: string;
	bytes: number;
	objects: number;
	current: boolean;
	purchasable: boolean;
}

export interface BillingView {
	owner: string;
	enabled: true;
	configured: boolean;
	/** The person's plan: whose quota is it. `source` is where the ceiling comes from. */
	plan: { id: string; title: string; bytes: number; objects: number; source: "free" | "subscription" | "operator" };
	plans: PlanLine[];
	subscription: { plan: string; status: string; periodEnd: string | null; cancelAtPeriodEnd: boolean } | null;
	/** Whether they have bought before (the portal has something to show). */
	customer: boolean;
}

/** The person's plan, the plans on offer and their subscription: one read of the quota's own source. */
export async function billingView(env: Env, deps: Deps, owner: string): Promise<BillingView> {
	const quota = await quotaFor(env, deps.store, owner);
	const paid = plansOf(env);
	const held = (await deps.store.activePlans?.(owner).catch(() => [] as string[])) ?? [];
	const mine = paid.filter((plan) => held.includes(plan.id)).sort((a, b) => b.bytes - a.bytes)[0];
	const free = freePlan(env);
	const state = (await deps.store.billing?.(owner).catch(() => null)) ?? { customer: null, subscription: null };
	const configured = stripeReady(env) && !!deps.billing;
	const operator = ownerOverride(env, owner) !== null;
	const base = mine ?? free;
	const line = (plan: Plan): PlanLine => ({ id: plan.id, title: plan.title, bytes: plan.bytes, objects: plan.objects, current: plan.id === base.id, purchasable: configured && !!(plan.lookupKey || plan.priceId) && plan.id !== "free" });
	return {
		owner,
		enabled: true,
		configured,
		// WHY the operator's ceiling wins the figures but not the name: the person is still on their plan
		plan: { id: base.id, title: base.title, bytes: quota.bytes, objects: quota.objects, source: operator ? "operator" : mine ? "subscription" : "free" },
		plans: [free, ...paid].map(line),
		subscription: state.subscription,
		customer: !!state.customer,
	};
}

export type Started = { url: string } | { status: number; error: string; why: string };

/** Stripe's checkout page for `planId`, for the signed-in browser's person. */
export async function checkout(env: Env, deps: Deps, request: Request, app: App | null, person: Person, planId: unknown): Promise<Started> {
	// WHY an exact match: a plan is one of the ids PLANS lists, nothing a request can spell its way into
	const plan = typeof planId === "string" ? plansOf(env).find((p) => p.id === planId) : undefined;
	if (!plan) return { status: 400, error: "bad_plan", why: `plan is one of: ${plansOf(env).map((p) => p.id).join(", ")}` };
	if (!stripeReady(env) || !deps.billing) return { status: 503, error: "not_configured", why: "payments are on but Stripe is not set up on this server yet" };
	const origin = new URL(request.url).origin;
	try {
		const url = await deps.billing.checkout(request, app, person, plan, { success: `${origin}/fs/account?done=paid`, cancel: `${origin}/fs/account?done=checkout-canceled` });
		return { url };
	} catch (error) {
		// WHY nothing of the error in the answer: Stripe's own words can carry a key's tail or a customer's email; the log has it
		console.error("billing: checkout failed:", error instanceof Error ? error.message : String(error));
		return { status: 502, error: "billing_unavailable", why: "Stripe could not start that checkout just now; try again in a minute" };
	}
}

/** Stripe's billing portal for a person who has bought before. */
export async function portal(env: Env, deps: Deps, request: Request, app: App | null, person: Person): Promise<Started> {
	if (!stripeReady(env) || !deps.billing) return { status: 503, error: "not_configured", why: "payments are on but Stripe is not set up on this server yet" };
	const state = await deps.store.billing?.(person.userId);
	if (!state?.customer) return { status: 400, error: "no_customer", why: "there is nothing to manage yet: you have not bought a plan" };
	try {
		return { url: await deps.billing.portal(request, app, person, `${new URL(request.url).origin}/fs/account`) };
	} catch (error) {
		console.error("billing: portal failed:", error instanceof Error ? error.message : String(error));
		return { status: 502, error: "billing_unavailable", why: "Stripe could not open the billing page just now; try again in a minute" };
	}
}

export async function billingRoute(request: Request, env: Env, deps: Deps, app: App | null, rest: string[], method: string): Promise<Response> {
	const read = method === "GET" || method === "HEAD";
	if (rest.length === 0) {
		if (!read) return fail(405, "method", "GET only", { Allow: "GET, HEAD" });
		const who = await session(request, deps, app);
		if (!who) return fail(401, "signed_out", "not signed in");
		return json(200, await billingView(env, deps, who.person.userId));
	}
	if (rest.length === 1 && (rest[0] === "checkout" || rest[0] === "portal")) {
		if (method !== "POST") return fail(405, "method", "POST only", { Allow: "POST" });
		const who = await writer(request, deps, app);
		if (who instanceof Response) return who;
		let started: Started;
		if (rest[0] === "checkout") {
			const body = await jsonBody(request);
			if (body instanceof Response) return body;
			started = await checkout(env, deps, request, app, who.person, body.plan);
		} else {
			started = await portal(env, deps, request, app, who.person);
		}
		return "url" in started ? json(200, started) : fail(started.status, started.error, started.why);
	}
	return fail(404, "not_found", "no such route");
}

export type { PlanEnv };
