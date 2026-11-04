// A Stripe API on a local port, for the payments tests: the handful of endpoints @better-auth/stripe calls, answering
// with the shapes Stripe documents (docs.stripe.com/api), and signed webhook events made with the official SDK's own
// test helper. TEST MODE ONLY, by construction: nothing here reaches api.stripe.com and every key is a made-up fixture.
//
// WHY not stripe-mock: it is a downloaded binary (or a container) and this lane may not fetch one; the Worker takes
// STRIPE_API_URL, so pointing it at stripe-mock (http://127.0.0.1:12111) instead of this file needs no code change.
// What this file keeps honest is the Worker's side: which calls it makes (`calls`) and what it does with the answers.

import { createServer, type Server } from "node:http";
import Stripe from "stripe";

export const WEBHOOK_SECRET = "whsec_fixture_for_tests_0123456789";
export const SECRET_KEY = "sk_test_fixture_for_tests_0123456789";

export interface Call {
	method: string;
	path: string;
	query: URLSearchParams;
	form: URLSearchParams;
}

export interface FakeStripe {
	url: string;
	calls: Call[];
	/** Subscriptions GET /v1/subscriptions/:id answers, by id. */
	subscriptions: Map<string, Record<string, unknown>>;
	/** Test hook: makes the next POST /v1/checkout/sessions fail the way Stripe refuses a bad request. */
	failCheckout: boolean;
	close(): Promise<void>;
}

const list = (data: unknown[], url: string) => ({ object: "list", data, has_more: false, url });

export async function fakeStripe(): Promise<FakeStripe> {
	const calls: Call[] = [];
	const subscriptions = new Map<string, Record<string, unknown>>();
	let customers = 0;
	let sessions = 0;
	const state = { failCheckout: false };
	const server: Server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://stripe.test");
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		const call: Call = { method: request.method ?? "GET", path: url.pathname, query: url.searchParams, form: new URLSearchParams(Buffer.concat(chunks).toString("utf8")) };
		calls.push(call);
		const send = (status: number, body: unknown) => {
			response.writeHead(status, { "Content-Type": "application/json", "Request-Id": `req_${calls.length}` });
			response.end(JSON.stringify(body));
		};
		const key = request.headers.authorization ?? "";
		if (!/^Bearer sk_test_/.test(key)) return send(401, { error: { type: "invalid_request_error", message: "test keys only" } });
		const { method, path } = call;
		if (method === "GET" && (path === "/v1/customers/search" || path === "/v1/customers")) return send(200, list([], path));
		if (method === "POST" && path === "/v1/customers") {
			customers += 1;
			return send(200, { id: `cus_test_${customers}`, object: "customer", email: call.form.get("email"), name: call.form.get("name"), livemode: false });
		}
		if (method === "GET" && path === "/v1/prices") {
			const keys = [...url.searchParams.entries()].filter(([name]) => name.startsWith("lookup_keys")).map(([, value]) => value);
			return send(200, list(keys.map((lookup) => ({ id: `price_${lookup}`, object: "price", lookup_key: lookup, livemode: false, recurring: { interval: "month" } })), path));
		}
		if (method === "GET" && path === "/v1/subscriptions") return send(200, list([], path));
		const one = /^\/v1\/subscriptions\/([^/]+)$/.exec(path);
		if (method === "GET" && one) {
			const found = subscriptions.get(one[1]);
			return found ? send(200, found) : send(404, { error: { type: "invalid_request_error", message: `No such subscription: '${one[1]}'`, code: "resource_missing" } });
		}
		if (method === "POST" && path === "/v1/checkout/sessions") {
			if (state.failCheckout) {
				state.failCheckout = false;
				return send(400, { error: { type: "invalid_request_error", message: "Invalid request (fixture)" } });
			}
			sessions += 1;
			return send(200, { id: `cs_test_${sessions}`, object: "checkout.session", mode: "subscription", livemode: false, url: `https://checkout.stripe.test/c/pay/cs_test_${sessions}`, client_reference_id: call.form.get("client_reference_id") });
		}
		if (method === "POST" && path === "/v1/billing_portal/sessions") {
			return send(200, { id: "bps_test_1", object: "billing_portal.session", livemode: false, url: `https://billing.stripe.test/p/session/bps_test_1?customer=${call.form.get("customer")}` });
		}
		return send(404, { error: { type: "invalid_request_error", message: `fixture has no ${method} ${path}`, code: "resource_missing" } });
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const port = (server.address() as { port: number }).port;
	return {
		url: `http://127.0.0.1:${port}`,
		calls,
		subscriptions,
		get failCheckout() {
			return state.failCheckout;
		},
		set failCheckout(value: boolean) {
			state.failCheckout = value;
		},
		close: () => new Promise<void>((done) => {
			server.closeAllConnections();
			server.close(() => done());
		}),
	};
}

/** A subscription as Stripe returns it, with one item priced by `lookupKey`. */
export function subscription(id: string, customer: string, lookupKey: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	const start = Math.floor(Date.parse("2026-11-04T12:00:00Z") / 1000);
	return {
		id, object: "subscription", customer, status, livemode: false, cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null,
		trial_start: null, trial_end: null, schedule: null, metadata: {},
		items: { object: "list", data: [{ id: `si_${id}`, object: "subscription_item", quantity: 1, current_period_start: start, current_period_end: start + 30 * 86400, price: { id: `price_${lookupKey}`, object: "price", lookup_key: lookupKey, recurring: { interval: "month" } } }] },
		...extra,
	};
}

/** A webhook event body and the Stripe-Signature header the official SDK would verify (secret = the endpoint's whsec_). */
export function signedEvent(type: string, object: Record<string, unknown>, secret = WEBHOOK_SECRET): { payload: string; signature: string } {
	const payload = JSON.stringify({ id: `evt_test_${type.replace(/\W/g, "_")}`, object: "event", type, livemode: false, api_version: "2026-10-28", created: 1793000000, data: { object } });
	const signature = new Stripe(SECRET_KEY).webhooks.generateTestHeaderString({ payload, secret });
	return { payload, signature };
}
