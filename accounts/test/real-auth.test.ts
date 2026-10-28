// Devices against the real accounts layer (test/real-auth.ts: Better Auth and its D1 adapter over node:sqlite, every
// migration applied): the judge's round-2 repros of lane/devices, kept as tests.
//
// What must hold (PEP 0003 §3.3):
// - only a browser session approves a device code, decided from what the server recorded when it made the session;
//   an approved grant not yet redeemed is listed, revocable, and dies with the session that approved it;
// - a key refresh's keys end by the moment its session was last known good plus the TTL, however slow D1 is;
// - every session is listed and revocable, the 101st as much as the first;
// - a web write sent before a revoke and still being read, or still queued behind another, writes nothing after it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { realStack } from "./real-auth.ts";

const EMAIL = "maker@example.com";

test("judge r2 #1: a machine's bearer cannot approve a device code; only a browser session can", async () => {
	const s = await realStack();
	const a = await s.browser(EMAIL);
	const laptop = await s.machine(a.cookie);
	const code = await s.deviceCode();
	const byBearer = await s.approve(code.user_code, { Authorization: `Bearer ${laptop.token}` });
	assert.notEqual(byBearer.approved, 200, `a machine approved a grant: ${byBearer.body}`);
	assert.equal((await s.redeem(code.device_code)).token, null, "the grant it tried to approve gives no token");
	// the same code, approved by the person's browser, still works (lastPolledAt cleared: the CLI waits its 5 s interval)
	assert.equal((await s.approve(code.user_code, { Cookie: a.cookie })).approved, 200);
	s.db.prepare('UPDATE "deviceCode" SET "lastPolledAt" = NULL').run();
	assert.ok((await s.redeem(code.device_code)).token);
});

test("judge r2 #1: an approved, unredeemed grant is listed, and dies with the session that approved it", async () => {
	const s = await realStack();
	const a = await s.browser(EMAIL);
	const other = await s.browser(EMAIL); // a second browser of the same person: the one that approves
	const code = await s.deviceCode();
	assert.equal((await s.approve(code.user_code, { Cookie: other.cookie })).approved, 200);
	const list = await (await s.call("/fs/v1/devices", { headers: { Cookie: a.cookie } })).json();
	assert.equal(list.pending?.length, 1, `the approved grant is listed: ${JSON.stringify(list)}`);
	assert.equal(list.pending[0].approvedBy, other.sessionId);
	// the approving browser is revoked (stolen with the laptop, say): the grant it approved gives no token
	const revoked = await s.post("/fs/v1/devices/revoke", { id: other.sessionId }, a.page);
	assert.equal(revoked.status, 200);
	const redeemed = await s.redeem(code.device_code);
	assert.equal(redeemed.token, null, `redeemed after its approver was revoked: ${JSON.stringify(redeemed.body)}`);
	assert.equal((await (await s.call("/fs/v1/devices", { headers: { Cookie: a.cookie } })).json()).pending.length, 0);
});

test("judge r2 #1: a pending grant is revoked from the list and from the account page, and then gives no token", async () => {
	const s = await realStack();
	const a = await s.browser(EMAIL);
	for (const how of ["api", "page"] as const) {
		const code = await s.deviceCode();
		assert.equal((await s.approve(code.user_code, { Cookie: a.cookie })).approved, 200);
		const pending = (await (await s.call("/fs/v1/devices", { headers: { Cookie: a.cookie } })).json()).pending;
		assert.equal(pending.length, 1);
		const id = pending[0].id as string;
		if (how === "api") {
			const answer = await s.post("/fs/v1/devices/revoke", { id }, a.page);
			assert.equal(answer.status, 200);
			assert.equal((await answer.json()).revoked, id);
		} else {
			const html = await (await s.call("/fs/account", { headers: { Cookie: a.cookie } })).text();
			assert.match(html, new RegExp(`data-grant="${id}"[\\s\\S]*?name="id" value="${id}"[\\s\\S]*?>Revoke</button>`));
			const form = await s.call("/fs/account/revoke", { method: "POST", headers: { Cookie: a.cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ id, user: a.userId }).toString() });
			assert.equal(form.headers.get("Location"), "/fs/account?done=revoked");
		}
		assert.equal((await s.redeem(code.device_code)).token, null, `${how}: the revoked grant still redeemed`);
	}
	// another person never sees, nor revokes, them
	const b = await s.browser("stranger@example.com");
	const code = await s.deviceCode();
	await s.approve(code.user_code, { Cookie: a.cookie });
	const mine = (await (await s.call("/fs/v1/devices", { headers: { Cookie: a.cookie } })).json()).pending[0].id;
	assert.equal((await (await s.call("/fs/v1/devices", { headers: { Cookie: b.cookie } })).json()).pending.length, 0);
	assert.equal((await s.post("/fs/v1/devices/revoke", { id: mine }, b.page)).status, 404);
	assert.ok((await s.redeem(code.device_code)).token);
});

test("judge r2 #2: a refresh whose final session read is delayed past the revoke gets 401, never keys past revoke + TTL", async () => {
	const s = await realStack();
	const a = await s.browser(EMAIL);
	const laptop = await s.machine(a.cookie);
	// the first session read after the refresh's quota listing is held after SQLite answered it
	let armed = false;
	let held = false;
	let release!: () => void;
	let reached!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const atHold = new Promise<void>((r) => (reached = r));
	const s3 = s.deps.s3;
	s.deps.s3 = async (request) => {
		if (new URL(request.url).searchParams.get("list-type") === "2" && !held) armed = true;
		return s3(request);
	};
	s.d1.hold = async (sql) => {
		if (!armed || held || !/from\s+"?session"?(\s|$)/i.test(sql)) return;
		held = true;
		reached();
		await gate;
	};
	const pending = s.call("/fs/v1/credentials", { method: "POST", headers: { Authorization: `Bearer ${laptop.token}` } });
	await atHold;
	assert.equal((await s.post("/fs/v1/devices/revoke", { id: laptop.sessionId }, a.page)).status, 200);
	const revokedAt = s.clock.now;
	s.clock.now += 301_000;
	release();
	const answer = await pending;
	const body = await answer.json();
	// no keys at all (401, or 503 too_slow: the deadline passed while D1 answered), or keys that end by revoke + TTL
	assert.ok(!body.SessionToken || Date.parse(body.Expiration) <= revokedAt + 300_000, `answered ${answer.status}, keys until ${body.Expiration}, revoked at ${new Date(revokedAt).toISOString()}`);
});

test("judge r2 #4: the 101st session is listed, revocable, and gets keys", async () => {
	const s = await realStack();
	const a = await s.browser(EMAIL);
	for (let i = 0; i < 99; i++) await s.browser(EMAIL);
	const laptop = await s.machine(a.cookie); // the newest of 101
	assert.equal((await s.call("/fs/v1/credentials", { method: "POST", headers: { Authorization: `Bearer ${laptop.token}` } })).status, 200);
	const list = await (await s.call("/fs/v1/devices", { headers: { Authorization: `Bearer ${laptop.token}` } })).json();
	assert.equal(list.devices.length, 101);
	assert.ok(list.devices.some((d: { id: string; current: boolean }) => d.id === laptop.sessionId && d.current));
	assert.equal((await s.post("/fs/v1/devices/revoke", { id: laptop.sessionId }, a.page)).status, 200);
	assert.equal((await s.call("/fs/v1/credentials", { method: "POST", headers: { Authorization: `Bearer ${laptop.token}` } })).status, 401);
});

/** A PUT body that waits for `gate` before its bytes arrive. */
function slowBody(text: string, gate: Promise<void>): ReadableStream<Uint8Array> {
	return new ReadableStream({
		async pull(controller) {
			await gate;
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

const written = (s: Awaited<ReturnType<typeof realStack>>, path: string) => [...s.s3.objects.keys()].filter((k) => k.endsWith(`/${path}`) && !k.includes("/_trash/"));

test("judge r2 #5: a web PUT whose body is still arriving when its device is revoked writes nothing", async () => {
	const s = await realStack();
	const a = await s.browser(EMAIL);
	const laptop = await s.machine(a.cookie);
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const pending = s.call("/fs/v1/folders/notes/web/late.txt", { method: "PUT", headers: { Authorization: `Bearer ${laptop.token}` }, body: slowBody("written after the revoke\n", gate), duplex: "half" } as RequestInit);
	await new Promise((r) => setTimeout(r, 20));
	assert.equal((await s.post("/fs/v1/devices/revoke", { id: laptop.sessionId }, a.page)).status, 200);
	s.clock.now += 301_000;
	release();
	const answer = await pending;
	assert.equal(answer.status, 401, await answer.text());
	assert.deepEqual(written(s, "late.txt"), []);
});

test("judge r2 #5: a web PUT queued behind another when its device is revoked writes nothing", async () => {
	const s = await realStack();
	const a = await s.browser(EMAIL);
	const laptop = await s.machine(a.cookie);
	// the browser's write holds the folder's queue at its first storage write
	let release!: () => void;
	let reached!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const atHold = new Promise<void>((r) => (reached = r));
	let holding = true;
	const s3 = s.deps.s3;
	s.deps.s3 = async (request) => {
		if (holding && request.method === "PUT") {
			holding = false;
			reached();
			await gate;
		}
		return s3(request);
	};
	const first = s.call("/fs/v1/folders/notes/web/first.txt", { method: "PUT", headers: a.page, body: "the browser's\n" });
	await atHold;
	const second = s.call("/fs/v1/folders/notes/web/queued.txt", { method: "PUT", headers: { Authorization: `Bearer ${laptop.token}` }, body: "queued before the revoke\n" });
	await new Promise((r) => setTimeout(r, 20));
	assert.equal((await s.post("/fs/v1/devices/revoke", { id: laptop.sessionId }, a.page)).status, 200);
	release();
	assert.equal((await first).status, 200);
	const answer = await second;
	assert.equal(answer.status, 401, await answer.text());
	assert.deepEqual(written(s, "queued.txt"), []);
});

// ------------------------------------------------------------------------------------------------ judge round 3

test("judge r3 #1: a redemption whose approver check is answered before a revoke lands, and delivered after it, creates no session", async () => {
	const s = await realStack();
	const a = await s.browser(EMAIL);
	const other = await s.browser(EMAIL); // the browser that approves, then is revoked (stolen with the laptop)
	const code = await s.deviceCode();
	assert.equal((await s.approve(code.user_code, { Cookie: other.cookie })).approved, 200);
	// the redemption's read of its approver is held after SQLite answered it (alive), as the judge paused it
	let release!: () => void;
	let reached!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const atHold = new Promise<void>((r) => (reached = r));
	let held = false;
	s.d1.hold = async (sql, values) => {
		if (held || !/from\s+"?session"?(\s|$)/i.test(sql) || !values.includes(other.sessionId)) return;
		held = true;
		reached();
		await gate;
	};
	const pending = s.redeem(code.device_code);
	await atHold;
	s.d1.hold = null;
	assert.equal((await s.post("/fs/v1/devices/revoke", { id: other.sessionId }, a.page)).status, 200);
	s.clock.now += 301_000;
	release();
	const redeemed = await pending;
	assert.equal(redeemed.token, null, `a grant redeemed across its approver's revoke: ${JSON.stringify(redeemed.body)}`);
	const machines = s.db.prepare(`SELECT COUNT(*) AS n FROM "session" WHERE "kind" = 'machine'`).get() as { n: number };
	assert.equal(machines.n, 0, "no machine session was created");
});

test("judge r3 #1: a machine session is created only beside a live approver, by the database itself", async () => {
	const s = await realStack();
	const a = await s.browser(EMAIL);
	const laptop = await s.machine(a.cookie);
	const row = s.db.prepare(`SELECT "kind", "approvedBy" FROM "session" WHERE "id" = ?`).get(laptop.sessionId) as { kind: string; approvedBy: string };
	assert.deepEqual({ ...row }, { kind: "machine", approvedBy: a.sessionId });
	// a direct insert naming a revoked approver is refused by SQLite (the trigger), whoever tries it
	const now = new Date().toISOString();
	const insert = (approver: string) => s.db.prepare(`INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId", "kind", "approvedBy") VALUES (?, ?, ?, ?, ?, ?, 'machine', ?)`)
		.run(`direct-${approver}`, new Date(Date.now() + 86_400_000).toISOString(), `tok-${approver}`, now, now, a.userId, approver);
	assert.throws(() => insert("no-such-session"), /approver_ended/);
	assert.doesNotThrow(() => insert(a.sessionId));
});

test("judge r3 #3: a refused approval leaves the grant as it was; only the approving owner's pending -> approved binds it", async () => {
	const s = await realStack();
	const a = await s.browser(EMAIL);
	const a2 = await s.browser(EMAIL);
	const b = await s.browser("stranger@example.com");
	const code = await s.deviceCode();
	assert.equal((await s.approve(code.user_code, { Cookie: a.cookie })).approved, 200);
	const bound = () => (s.db.prepare(`SELECT "approvedSessionId" FROM "deviceCode" WHERE "deviceCode" = ?`).get(code.device_code) as { approvedSessionId: string }).approvedSessionId;
	assert.equal(bound(), a.sessionId);
	const byB = await s.post("/fs/api/auth/device/approve", { userCode: code.user_code }, { Cookie: b.cookie });
	assert.notEqual(byB.status, 200);
	assert.equal(bound(), a.sessionId, "another person's refused approval rebound the grant");
	const again = await s.post("/fs/api/auth/device/approve", { userCode: code.user_code }, { Cookie: a2.cookie });
	assert.notEqual(again.status, 200);
	assert.equal(bound(), a.sessionId, "a second approval of an approved grant rebound it");
	const list = await (await s.call("/fs/v1/devices", { headers: { Cookie: a.cookie } })).json();
	assert.equal(list.pending.length, 1);
	assert.ok((await s.redeem(code.device_code)).token, "A's grant still redeems");
});

test("judge r3 #5: a sign-in from before machine approval existed is told to sign out and in again, on the device API and the account page", async () => {
	const s = await realStack();
	const a = await s.browser(EMAIL);
	s.db.prepare(`UPDATE "session" SET "kind" = NULL WHERE "id" = ?`).run(a.sessionId); // as a pre-0008 session reads
	const code = await s.deviceCode();
	const tried = await s.approve(code.user_code, { Cookie: a.cookie });
	assert.equal(tried.approved, 403);
	const said = JSON.parse(tried.body);
	assert.equal(said.code, "SIGN_IN_AGAIN");
	assert.equal(said.message, "This sign-in is from before machine approval was added. Sign out and sign in again to approve a machine.");
	const page = await (await s.call("/fs/account", { headers: { Cookie: a.cookie } })).text();
	assert.match(page, /This sign-in is from before machine approval was added\. Sign out and sign in again to approve a machine\./);
	assert.match(page, /<form method="post" action="\/fs\/account\/sign-out">/);
	// a fresh sign-in approves
	const fresh = await s.browser(EMAIL);
	assert.equal((await s.approve(code.user_code, { Cookie: fresh.cookie })).approved, 200);
	assert.doesNotMatch(await (await s.call("/fs/account", { headers: { Cookie: fresh.cookie } })).text(), /before machine approval was added/);
});
