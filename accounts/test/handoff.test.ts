// A loopback channel's sign-in (PEP 0003 §3.10), against the real accounts layer (test/real-auth.ts). The browser
// signs in on the app's own https origin; a proxied request reaches this Worker with that same origin, so `s.call`
// is both sides, and what differs is only which origin the browser keeps the answer's cookie on.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { apps } from "../src/apps.ts";
import { realStack } from "./real-auth.ts";

const APP = "https://robotparts.dev";
const PREVIEW = "http://127.0.0.1:4470";
const EMAIL = "maker@example.com";
const handoff = (to: string) => `/fs/handoff?to=${encodeURIComponent(to)}`;

function cookieOf(answer: Response): string {
	return answer.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");
}

test("robotparts lists Preview and Stable as loopback channels, and nobody else's page is one", () => {
	const raw = JSON.parse(readFileSync(new URL("../apps.json", import.meta.url), "utf8"));
	assert.deepEqual(apps(undefined, raw, false).get("robotparts")!.loopback.sort(), ["http://127.0.0.1:4470", "http://127.0.0.1:4471", "http://localhost:4470", "http://localhost:4471"]);
	assert.deepEqual(apps(undefined, { x: { origins: [], loopback: ["https://evil.example", "http://evil.example:4470", "http://127.0.0.1:4470/path", 7] } }, false).get("x")!.loopback, []);
	assert.ok(!apps(undefined, raw, false).get("robotparts")!.origins.includes(PREVIEW), "a channel never counts as the app's origin in production (cb5bca0)");
});

test("signed in on the app: a one-time link to the channel, and the channel gets a session of its own cookie", async () => {
	const s = await realStack({}, APP);
	const a = await s.browser(EMAIL);
	const out = await s.call(handoff(`${PREVIEW}/driver/moteus/?tab=buy#x`), { headers: { Cookie: a.cookie } });
	assert.equal(out.status, 303);
	const location = new URL(out.headers.get("Location")!);
	assert.equal(location.origin, PREVIEW);
	assert.equal(location.pathname, "/fs/handoff/redeem");
	assert.equal(location.searchParams.get("return"), "/driver/moteus/?tab=buy#x");
	assert.ok(location.searchParams.get("token"));
	assert.equal(out.headers.get("Set-Cookie"), null, "nothing is set on the app's own origin");

	const back = await s.call(location.pathname + location.search, { headers: {} });
	assert.equal(back.status, 303);
	assert.equal(back.headers.get("Location"), "/driver/moteus/?tab=buy#x", "relative: the tab stays on the channel");
	assert.equal(back.headers.get("Cache-Control"), "no-store");
	const cookie = cookieOf(back);
	assert.match(back.headers.getSetCookie()[0], /^__Secure-folder-sync\.session_token=.*HttpOnly.*Secure.*SameSite=Lax/i);
	const me = await (await s.call("/fs/v1/me", { headers: { Cookie: cookie } })).json();
	assert.equal(me.user.email, EMAIL);
	assert.equal(me.user.id, a.userId);
});

test("the link works once, and dies with the session it came from", async () => {
	const s = await realStack({}, APP);
	const a = await s.browser(EMAIL);
	const url = async () => { const u = new URL((await s.call(handoff(`${PREVIEW}/`), { headers: { Cookie: a.cookie } })).headers.get("Location")!); return u.pathname + u.search; };
	const once = await url();
	assert.equal((await s.call(once)).status, 303);
	assert.equal((await s.call(once)).status, 400, "a used token");
	assert.equal((await s.call("/fs/handoff/redeem?return=/")).status, 400, "no token");
	assert.equal((await s.call("/fs/handoff/redeem?token=forged&return=/")).status, 400, "a forged token");
	const pending = await url();
	assert.equal((await s.post("/fs/v1/sign-out", {}, a.page)).status, 200);
	assert.equal((await s.call(pending)).status, 400, "the session it stood for ended");
});

test("signed out: the app's own sign-in first, and back to the same handoff", async () => {
	const s = await realStack({}, APP);
	const out = await s.call(handoff(`${PREVIEW}/driver/moteus/`));
	assert.equal(out.status, 303);
	assert.equal(out.headers.get("Location"), `/fs/signin?return=${encodeURIComponent(handoff(`${PREVIEW}/driver/moteus/`))}`);
});

test("only a listed loopback origin, only a browser, only GET, only an app", async () => {
	const s = await realStack({}, APP);
	const a = await s.browser(EMAIL);
	for (const to of ["https://evil.example/", "http://127.0.0.1:4999/", "http://127.0.0.1:4470.evil.example/", "/relative", "javascript:alert(1)", ""]) {
		const answer = await s.call(handoff(to), { headers: { Cookie: a.cookie } });
		assert.equal(answer.status, 400, to);
		assert.equal(answer.headers.get("Location"), null, to);
	}
	const machine = await s.machine(a.cookie);
	const bearer = await s.call(handoff(`${PREVIEW}/`), { headers: { Authorization: `Bearer ${machine.token}` } });
	assert.equal(bearer.headers.get("Location")?.startsWith("/fs/signin"), true, "a machine's token is no browser sign-in");
	assert.equal((await s.call(handoff(`${PREVIEW}/`), { method: "POST" })).status, 405);
	const none = await realStack();
	assert.equal((await none.call(handoff(`${PREVIEW}/`))).status, 400, "an app with no channels has none to hand to");
});

test("a redeem's return stays a same-origin path", async () => {
	const s = await realStack({}, APP);
	const a = await s.browser(EMAIL);
	const out = new URL((await s.call(handoff(`${PREVIEW}/`), { headers: { Cookie: a.cookie } })).headers.get("Location")!);
	const back = await s.call(`/fs/handoff/redeem?token=${out.searchParams.get("token")}&return=${encodeURIComponent("//evil.example/")}`);
	assert.equal(back.headers.get("Location"), "/");
});

test("the sign-in page names the app's own origin, so it can tell it came through a proxy", async () => {
	const s = await realStack({}, APP);
	const html = await (await s.call("/fs/signin?return=/")).text();
	assert.match(html, /<meta name="fs-origin" content="https:\/\/robotparts\.dev">/);
	const script = readFileSync(new URL("../site/signin.js", import.meta.url), "utf8");
	assert.match(script, /\/fs\/handoff\?to=/, "the Google button hands off on a channel");
});
