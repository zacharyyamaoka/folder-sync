// The pieces of the stock account page (/fs/account) beyond the devices: the profile and the ways in, the plan, the person's
// own bucket, and the page's forms for them. devices.ts composes the page and owns its two original forms (Revoke, Sign out);
// everything that depends on a switch (features.ts) is drawn here, and absent when its switch is off.
//
// WHY no script and no UI kit: see test/account.test.ts's header. Every control is a link or a form; the forms post to
// /fs/account/<what> (same-origin, checked by devices.ts formOk) and answer 303 back to the page with ?done=<code>, which
// the page turns into a sentence (`notice`). Nothing on the page ever holds a secret: a key is typed into a password field
// once and sealed on the server (byo.ts).

import { escapeAttr, emailCodes, headers, PAGE_POLICY, type Deps, type Env, type Person } from "./app.ts";
import type { App } from "./apps.ts";
import { billingView, checkout, portal, type BillingView } from "./billing.ts";
import { attach, BYO_ERRORS, shown } from "./byo.ts";
import { ttlOf } from "./creds.ts";
import { featuresOf } from "./features.ts";

/** "3 MiB", "512 bytes". */
export function size(bytes: number): string {
	if (bytes < 1024) return `${bytes} byte${bytes === 1 ? "" : "s"}`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`;
}

export const count = (n: number) => n.toLocaleString("en-US");

const day = (iso: string) => iso.slice(0, 10);

// ------------------------------------------------------------------------------------------------ profile

const PROVIDER_NAME: Record<string, string> = { google: "Google" };

/** The ways this person can sign in, by name: each linked provider, and email codes when this app sends them. */
export async function signInMethods(env: Env, deps: Deps, userId: string): Promise<string[]> {
	const linked = (await deps.signInMethods?.(userId).catch(() => [] as string[])) ?? [];
	const names = linked.filter((id) => PROVIDER_NAME[id]).map((id) => PROVIDER_NAME[id]);
	if (emailCodes(env)) names.push("Email code");
	return names;
}

export function profileSection(person: Person, methods: string[]): string {
	const initial = ([...(person.name || person.email)][0] ?? "?").toUpperCase();
	const ways = methods.length ? `\n<ul class="fs-methods" data-testid="fs-methods" aria-label="Ways you sign in">${methods.map((name) => `<li>${escapeAttr(name)}</li>`).join("")}</ul>` : "";
	return `<section class="fs-section fs-profile" data-testid="fs-profile">
<div class="fs-avatar" aria-hidden="true">${escapeAttr(initial)}</div>
<div class="fs-who">Signed in as <strong>${escapeAttr(person.email)}</strong>${person.name ? `<br><span class="fs-small">${escapeAttr(person.name)}</span>` : ""}${ways}</div>
</section>`;
}

// ------------------------------------------------------------------------------------------------ storage

/** The quota as a bar: a native <progress> (no inline style: the page's policy allows none). Full at or over the quota. */
export function quotaBar(used: number, quota: number, over: boolean): string {
	const percent = over || quota <= 0 ? 100 : Math.max(0, Math.min(100, Math.floor((used / quota) * 100)));
	return `<progress class="fs-bar${over ? " fs-bar-over" : ""}" data-testid="fs-quota" role="progressbar" aria-label="Storage used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" value="${percent}" max="100">${percent}%</progress>`;
}

// ------------------------------------------------------------------------------------------------ plan

function planLine(plan: { title: string; bytes: number; objects: number }): string {
	return `${escapeAttr(plan.title)}</strong> <span class="fs-small">· ${size(plan.bytes)} · ${count(plan.objects)} files</span>`;
}

export async function planSection(env: Env, deps: Deps, person: Person): Promise<string> {
	let view: BillingView;
	try {
		view = await billingView(env, deps, person.userId);
	} catch {
		// WHY a line and not an error: the page is where a person goes when something is wrong (devices.ts), whatever the database says
		return `<section class="fs-section" data-testid="fs-plan"><h2>Plan</h2><p class="fs-small">Your plan can't be read right now.</p></section>`;
	}
	const hidden = `<input type="hidden" name="user" value="${escapeAttr(person.userId)}">`;
	const sub = view.subscription;
	const paying = !!sub && (sub.status === "active" || sub.status === "trialing");
	const lines = [`<p class="fs-planline"><strong>${planLine(view.plan)}</p>`];
	if (view.plan.source === "operator") lines.push(`<p class="fs-small">Your storage limit was set for you by the operator.</p>`);
	if (sub && !paying) lines.push(`<p class="fs-error" role="status">Your ${escapeAttr(sub.plan)} subscription is ${escapeAttr(sub.status.replace("_", " "))}: your storage is back to the free allowance until it is paid. Manage billing to fix it.</p>`);
	if (paying && sub.periodEnd) lines.push(`<p class="fs-small">${sub.cancelAtPeriodEnd ? "Ends" : "Renews"} on ${escapeAttr(day(sub.periodEnd))}.</p>`);
	const offers = view.plans.filter((plan) => plan.id !== "free");
	const items = offers.map((plan) => {
		const buy = !sub && plan.purchasable ? `<form method="post" action="/fs/account/plan">${hidden}<input type="hidden" name="plan" value="${escapeAttr(plan.id)}"><button type="submit">Upgrade</button></form>` : plan.current ? '<span class="fs-tag">Current</span>' : "";
		return `<li class="fs-offer${plan.current ? " fs-offer-current" : ""}" data-plan="${escapeAttr(plan.id)}"><span class="fs-offer-text"><strong>${planLine(plan)}</span>${buy}</li>`;
	});
	const manage = view.customer ? `<form method="post" action="/fs/account/billing" class="fs-inline">${hidden}<button type="submit">Manage billing</button></form>` : "";
	const unavailable = view.configured ? "" : `<p class="fs-small">Plans can't be bought here yet.</p>`;
	return `<section class="fs-section" data-testid="fs-plan">
<h2>Plan</h2>
${lines.join("\n")}
${items.length ? `<ul class="fs-offers">\n${items.join("\n")}\n</ul>` : ""}
${manage}${unavailable}
<p class="fs-small">Payments run in Stripe's test mode for now: no real card is charged.</p>
</section>`;
}

// ------------------------------------------------------------------------------------------------ your own bucket

const FIELD = (name: string, label: string, type: string, hint: string, extra = "") =>
	`<label class="fs-field"><span>${label}</span><input name="${name}" type="${type}" autocomplete="off" spellcheck="false" ${extra}${hint ? ` placeholder="${escapeAttr(hint)}"` : ""}></label>`;

export async function byoSection(env: Env, deps: Deps, person: Person): Promise<string> {
	const keyed = !!env.BYO_ENCRYPTION_KEY && env.BYO_ENCRYPTION_KEY.length >= 32 && !!deps.store.setByo;
	const hidden = `<input type="hidden" name="user" value="${escapeAttr(person.userId)}">`;
	if (!keyed) return `<section class="fs-section" data-testid="fs-byo"><h2>Your own bucket</h2><p class="fs-small">Your own bucket isn't available on this app yet: it can't keep your storage keys safely.</p></section>`;
	const row = await deps.store.byo?.(person.userId).catch(() => null);
	const form = (open: boolean) => `<form method="post" action="/fs/account/byo">${hidden}
${FIELD("endpoint", "Endpoint", "url", "https://s3.us-west-002.backblazeb2.com", "required")}
${FIELD("bucket", "Bucket", "text", "my-bucket", "required")}
${FIELD("prefix", "Folder in the bucket (optional)", "text", "folder-sync")}
${FIELD("region", "Region (optional)", "text", "auto")}
${FIELD("accessKeyId", "Access key id", "text", "", "required")}
${FIELD("secretAccessKey", "Secret access key", "password", "", "required")}
<button type="submit">${open ? "Replace the keys" : "Attach this bucket"}</button>
</form>`;
	const warning = `<p class="fs-small">Your machines get these keys as they are, so use a key that can reach only this bucket. Removing the bucket stops new sign-ins using it within ${Math.round(ttlOf(env) / 60)} minutes; a machine that already holds the keys keeps them until then, and signing a device out can't take them back.</p>`;
	if (row) {
		const info = shown(person.userId, row) as { store: string; endpoint: string; keyHint: string; updated: string };
		return `<section class="fs-section" data-testid="fs-byo">
<h2>Your own bucket</h2>
<p class="fs-planline"><strong>${escapeAttr(info.store)}</strong><br><span class="fs-small">${escapeAttr(info.endpoint)} · key ending ${escapeAttr(info.keyHint)} · attached ${escapeAttr(day(info.updated))}</span></p>
<p class="fs-small">Your machines sync to your own bucket, not to this service's storage.</p>
<form method="post" action="/fs/account/byo/remove" class="fs-inline">${hidden}<button type="submit">Remove</button></form>
<details class="fs-steps"><summary>Replace the keys</summary>${form(true)}</details>
${warning}
</section>`;
	}
	return `<section class="fs-section" data-testid="fs-byo">
<h2>Your own bucket</h2>
<p class="fs-small">Sync your folders to a bucket you own (any S3-compatible storage) instead of this service's. Your files then count against your provider, not a plan here.</p>
<details class="fs-steps"><summary>Attach a bucket</summary>${form(false)}</details>
${warning}
</section>`;
}

/** The sentence under the storage line for a person whose machines sync to their own bucket, or "". */
export async function byoNote(env: Env, deps: Deps, userId: string): Promise<string> {
	if (!featuresOf(env).byo) return "";
	const row = await deps.store.byo?.(userId).catch(() => null);
	return row ? `<p class="fs-small" data-testid="fs-byo-note">Your machines sync to your own bucket (${escapeAttr(shown(userId, row).store as string)}), so the limit above doesn't apply to it.</p>` : "";
}

// ------------------------------------------------------------------------------------------------ notices and forms

/** The sentence for `?done=<code>` codes this file's forms (and Stripe's return) produce; undefined for any other. */
export function noticeFor(env: Env, done: string): string | undefined {
	const said: Record<string, string> = {
		paid: "Thank you. Your plan updates as soon as Stripe confirms the payment, usually within a few seconds: reload this page.",
		"checkout-canceled": "Checkout was canceled. Nothing was charged.",
		"bad-plan": "That isn't a plan you can choose here. Nothing changed.",
		"billing-unavailable": "Stripe didn't answer just now. Nothing changed: try again in a minute.",
		"billing-not-configured": "Payments aren't set up on this app yet. Nothing changed.",
		"no-customer": "There is nothing to manage yet: you haven't bought a plan.",
		"byo-attached": `Your bucket is attached. Your machines pick it up within ${Math.round(ttlOf(env) / 60)} minutes.`,
		"byo-removed": "Your bucket is removed. Your machines go back to this service's storage within a few minutes.",
	};
	if (said[done]) return said[done];
	const code = done.startsWith("byo-") ? done.slice(4) : "";
	return code && BYO_ERRORS[code] ? `Nothing changed. ${BYO_ERRORS[code]}` : undefined;
}

/** The page's plan, billing and bucket forms: where to send the browser next (the page, with ?done=, or Stripe's own page). */
export async function accountForm(what: "plan" | "billing" | "byo" | "byo/remove", fields: URLSearchParams, request: Request, env: Env, deps: Deps, app: App, person: Person): Promise<string> {
	if (what === "plan" || what === "billing") {
		const started = what === "plan" ? await checkout(env, deps, request, app, person, fields.get("plan")) : await portal(env, deps, request, app, person);
		if ("url" in started) return started.url;
		return `/fs/account?done=${{ bad_plan: "bad-plan", billing_unavailable: "billing-unavailable", not_configured: "billing-not-configured", no_customer: "no-customer" }[started.error] ?? "billing-unavailable"}`;
	}
	if (what === "byo/remove") {
		await deps.store.removeByo?.(person.userId);
		return "/fs/account?done=byo-removed";
	}
	const given = Object.fromEntries(["endpoint", "bucket", "prefix", "region", "accessKeyId", "secretAccessKey"].map((name) => [name, fields.get(name) ?? ""]));
	const done = await attach(env, deps, person.userId, given);
	return "row" in done ? "/fs/account?done=byo-attached" : `/fs/account?done=byo-${done.error}`;
}

/** The page that takes a browser on to Stripe's own: 200 with a meta refresh and a link, never a 303.
 *  WHY not a redirect: the account page's policy says form-action 'self', and Chrome applies it to where a form's redirect
 *  leads, so a 303 to checkout.stripe.com is blocked (found driving the page in Chromium, test/account-journey.mjs). A meta
 *  refresh is a navigation, not a form submission, and needs no allow-list of Stripe's hosts (which differ per Stripe API
 *  URL: stripe-mock, the tests' fixture). `url` is Stripe's answer; anything but https (or http on loopback, for a local
 *  stand-in) is refused here, so a `javascript:` address can never be put in a page. */
export function goTo(url: string, app: App): Response | null {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return null;
	}
	const local = target.hostname === "127.0.0.1" || target.hostname === "localhost";
	if (target.protocol !== "https:" && !(target.protocol === "http:" && local)) return null;
	const where = escapeAttr(target.href);
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0;url=${where}">
<title>Taking you to Stripe · ${escapeAttr(app.name)}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/fs/site/account.css">
</head>
<body>
<main class="fs-cover"><div class="fs-card"><p>Taking you to Stripe…</p><p class="fs-small">Not moving? <a href="${where}" data-testid="fs-go">Continue to Stripe</a>.</p></div></main>
</body>
</html>
`;
	const out = headers({ "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PAGE_POLICY, "X-Frame-Options": "DENY" });
	return new Response(html, { status: 200, headers: out });
}
