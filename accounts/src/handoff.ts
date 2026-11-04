// A loopback channel's sign-in (PEP 0003 §3.10). An app's Stable and Preview run on http://127.0.0.1:<port> and forward
// /fs/* here, so this Worker sees an ordinary request on the app's own origin and the browser keeps the cookie on the
// channel's. Everything works through that proxy but Google: its callback is https://<app>/fs/api/auth/callback/google,
// so the session it makes lands on the app's domain and never on the channel's. The tab therefore signs in on the app
// as usual and comes back with a one-use token (Better Auth's one-time-token plugin), which the channel's own proxied
// request redeems for the session cookie.
//
// WHY a redirect to a fixed list (apps.json `loopback`) and not any `to`: the token is a session; it may only travel to
// a port the operator named, on the visitor's own machine.
// WHY not a channel as one of the app's origins: production counts https origins only (apps.ts, cb5bca0), and that
// stands. The channel gets no CORS and no route of its own; it gets a redirect.

import type { App } from "./apps.ts";
import { fail, headers, returnPath, type Deps } from "./app.ts";

function see(location: string, cookies: string[] = []): Response {
	const answer = new Response(null, { status: 303, headers: headers({ Location: location }) });
	for (const cookie of cookies) answer.headers.append("Set-Cookie", cookie);
	return answer;
}

/** The asked-for URL when its origin is one of the app's channels, else null. */
function channelUrl(app: App, to: string | null): URL | null {
	if (!to) return null;
	try {
		const url = new URL(to);
		return app.loopback.includes(url.origin) ? url : null;
	} catch {
		return null;
	}
}

/** GET /fs/handoff?to=<url> and GET /fs/handoff/redeem?token=&return=<path>. */
export async function handoffRoute(request: Request, deps: Deps | null, app: App | null, rest: string[], method: string): Promise<Response> {
	if (method !== "GET") return fail(405, "method", "GET only", { Allow: "GET" });
	if (!app) return fail(404, "unknown_origin", "this origin is not a registered app: no sign-in here");
	if (!deps?.handoffToken || !deps.handoffRedeem) return fail(503, "not_configured", "sign-in is not set up on this Worker yet");
	const params = new URL(request.url).searchParams;
	if (rest.length === 1 && rest[0] === "redeem") {
		const cookies = await deps.handoffRedeem(request, app, params.get("token") || "").catch(() => null);
		if (!cookies) return fail(400, "bad_token", "this sign-in link was used, or has expired: sign in again");
		return see(returnPath(params.get("return")), cookies);
	}
	if (rest.length !== 0) return fail(404, "not_found", "no such route");
	const to = channelUrl(app, params.get("to"));
	if (!to) return fail(400, "bad_target", "to is a URL on one of this app's local channels");
	const signIn = `/fs/signin?return=${encodeURIComponent(`/fs/handoff?to=${encodeURIComponent(to.href)}`)}`;
	const person = await deps.person(request, "cookie", app);
	if (!person) return see(signIn);
	const token = await deps.handoffToken(request, app);
	if (!token) return see(signIn);
	return see(`${to.origin}/fs/handoff/redeem?token=${encodeURIComponent(token)}&return=${encodeURIComponent(to.pathname + to.search + to.hash)}`);
}
