// A live proof of the folder hub (PEP 0005 §3) against a running dev stack: real workerd, a real Durable Object, real
// WebSockets. Exits non-zero on the first failed check.
//
//   FS_STANDIN_PORT=4960 FS_STORE_PORT=4961 FS_ACCOUNTS_PORT=4962 FS_INSPECTOR_PORT=4963 node accounts/scripts/dev.mjs up --state-dir /tmp/hubproof
//   FS_ACCOUNTS=http://127.0.0.1:4962 node accounts/test/hub-live.mjs
//   node accounts/scripts/dev.mjs down --state-dir /tmp/hubproof
//
// It signs two test people in by dev email code (the owner and a reader), gives the owner two machines (the device
// grant, as `folder-sync login` does), and opens: machine A, machine B, the owner's page (cookie) and the reader's page
// as WebSockets on /fs/v1/folders/robotparts/events. Then it shows: hello on connect; a web-host PUT and DELETE reach
// every socket with web:true; a machine's `changed` reaches everyone but its sender; a reader, a page and junk can not
// announce; ping answers pong; a cross-site cookie upgrade, a missing Upgrade and a stranger are refused.
//
// Test values only: the people are generated here for this dev stack. `ws` (a dependency of wrangler's miniflare, in
// accounts/node_modules) is used because the browser-style WebSocket can't set Authorization or Origin.

import { randomBytes, randomUUID } from "node:crypto";
import WebSocket from "ws";

const SITE = process.env.FS_ACCOUNTS || "http://127.0.0.1:4962";
const WS_SITE = SITE.replace(/^http/, "ws");
const EVENTS = "/fs/v1/folders/robotparts/events";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let failed = 0;
function check(what, ok, detail) {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : `\n       ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
	if (!ok) failed++;
}

// ------------------------------------------------------------------------------------------------ people

class Browser {
	constructor() {
		this.jar = new Map();
	}

	async fetch(path, { method = "GET", body, headers = {} } = {}) {
		const h = { ...headers };
		if (this.jar.size) h.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
		if (body !== undefined) {
			h["Content-Type"] = "application/json";
			body = JSON.stringify(body);
		}
		const answer = await fetch(`${SITE}${path}`, { method, body, headers: h, redirect: "manual" });
		for (const line of answer.headers.getSetCookie()) {
			const [pair] = line.split(";");
			const at = pair.indexOf("=");
			const name = pair.slice(0, at).trim();
			const value = pair.slice(at + 1).trim();
			if (/max-age=0/i.test(line) || value === "") this.jar.delete(name);
			else this.jar.set(name, value);
		}
		return answer;
	}

	/** A write from this site's own page: its Origin, the CSRF header and the user it shows. */
	write(path, init = {}) {
		const user = this.userId ? { "X-Folder-Sync-User": this.userId } : {};
		return this.fetch(path, { ...init, headers: { Origin: SITE, "X-Folder-Sync": "1", ...user, ...(init.headers || {}) } });
	}
}

async function signIn(email) {
	const browser = new Browser();
	const sent = await browser.write("/fs/api/auth/email-otp/send-verification-otp", { method: "POST", body: { email, type: "sign-in" } });
	if (!sent.ok) throw new Error(`send code for ${email}: ${sent.status} ${await sent.text()}`);
	const { code } = await (await fetch(`${SITE}/fs/dev/mailbox?email=${encodeURIComponent(email)}`)).json();
	const signed = await browser.write("/fs/api/auth/sign-in/email-otp", { method: "POST", body: { email, otp: code } });
	if (!signed.ok) throw new Error(`sign in ${email}: ${signed.status} ${await signed.text()}`);
	browser.userId = (await (await browser.fetch("/fs/v1/me")).json()).user?.id;
	return browser;
}

/** A machine's bearer token: the device grant, approved by `browser`'s session (what `folder-sync login` does). */
async function machineToken(browser) {
	const post = async (path, body) => {
		const answer = await fetch(`${SITE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
		return { status: answer.status, body: await answer.json().catch(() => ({})) };
	};
	const started = await post("/fs/api/auth/device/code", { client_id: "folder-sync" });
	const { device_code: deviceCode, user_code: userCode } = started.body;
	if (!deviceCode) throw new Error(`device code: ${JSON.stringify(started)}`);
	await browser.fetch(`/fs/api/auth/device?user_code=${encodeURIComponent(userCode)}`);
	const approved = await browser.write("/fs/api/auth/device/approve", { method: "POST", body: { userCode } });
	if (!approved.ok) throw new Error(`approve: ${approved.status} ${await approved.text()}`);
	for (let i = 0; i < 20; i++) {
		await sleep(5500); // the grant's polling interval is 5 s
		const polled = await post("/fs/api/auth/device/token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: "folder-sync" });
		if (polled.body.access_token) return polled.body.access_token;
		if (polled.body.error !== "authorization_pending" && polled.body.error !== "slow_down") throw new Error(`device token: ${JSON.stringify(polled)}`);
	}
	throw new Error("the device grant was not issued in time");
}

// ------------------------------------------------------------------------------------------------ sockets

class Client {
	constructor(name, path, headers) {
		this.name = name;
		this.received = [];
		this.raw = [];
		this.waiting = [];
		this.ws = new WebSocket(`${WS_SITE}${path}`, { headers });
		this.ws.on("message", (data) => {
			const text = data.toString();
			this.raw.push(text);
			let value = text;
			try { value = JSON.parse(text); } catch { /* pong */ }
			this.received.push(value);
			for (const w of [...this.waiting]) w();
		});
		this.opened = new Promise((done, fail) => {
			this.ws.once("open", done);
			this.ws.once("unexpected-response", (_req, res) => fail(new Error(`${name}: upgrade refused ${res.statusCode}`)));
			this.ws.once("error", fail);
		});
	}

	/** The next message after the first `skip` ones that matches `want`, within `ms`. */
	async next(want, ms = 5000, from = 0) {
		const until = Date.now() + ms;
		for (;;) {
			const hit = this.received.slice(from).find((m) => want(m));
			if (hit) return hit;
			if (Date.now() > until) return null;
			await new Promise((done) => {
				this.waiting.push(done);
				setTimeout(done, 50);
			}).finally(() => { this.waiting.length = 0; });
		}
	}

	send(text) {
		this.ws.send(typeof text === "string" ? text : JSON.stringify(text));
	}

	mark() {
		return this.received.length;
	}

	close() {
		this.ws.close();
	}
}

/** The HTTP status of a refused upgrade (or 101 if it was accepted). */
function upgradeStatus(path, headers) {
	return new Promise((done) => {
		const ws = new WebSocket(`${WS_SITE}${path}`, { headers });
		ws.once("open", () => { ws.close(); done(101); });
		ws.once("unexpected-response", (_req, res) => { res.resume(); done(res.statusCode); });
		ws.once("error", () => done(0));
	});
}

// ------------------------------------------------------------------------------------------------ the journey

const tag = randomBytes(4).toString("hex");
const ownerHost = randomUUID(); // a machine's host id: a lowercase UUID v4
const otherHost = randomUUID();

console.log(`hub live proof against ${SITE}`);
const owner = await signIn(`hubproof-owner-${tag}@example.test`);
const reader = await signIn(`hubproof-reader-${tag}@example.test`);
const stranger = await signIn(`hubproof-stranger-${tag}@example.test`);
check("two test people and a stranger signed in by email code", !!owner.userId && !!reader.userId && !!stranger.userId && new Set([owner.userId, reader.userId, stranger.userId]).size === 3);
const shared = await owner.write("/fs/v1/folders/robotparts/readers", { method: "POST", body: { email: `hubproof-reader-${tag}@example.test` } });
check("the owner shared robotparts with the reader", shared.ok, shared.status);
const [tokenA, tokenB] = await Promise.all([machineToken(owner), machineToken(owner)]);
check("two machines of the owner hold bearer tokens (device grant)", !!tokenA && !!tokenB && tokenA !== tokenB);

// 1. no Upgrade, cross-site cookie, stranger, signed out
const plain = await fetch(`${SITE}${EVENTS}`, { headers: { Authorization: `Bearer ${tokenA}` } });
check("GET /events without Upgrade: websocket is 426", plain.status === 426, plain.status);
const cookieOf = (b) => [...b.jar].map(([k, v]) => `${k}=${v}`).join("; ");
check("a cookie upgrade from another site's Origin is refused (403)", (await upgradeStatus(EVENTS, { Cookie: cookieOf(owner), Origin: "https://evil.example" })) === 403);
check("a cookie upgrade with no Origin is refused (403)", (await upgradeStatus(EVENTS, { Cookie: cookieOf(owner) })) === 403);
check("a signed-out upgrade on a private folder is refused (401)", (await upgradeStatus(EVENTS, {})) === 401);
check("a stranger's upgrade on the owner's private folder is refused (404)", (await upgradeStatus(`${EVENTS}?owner=${owner.userId}`, { Cookie: cookieOf(stranger), Origin: SITE })) === 404);

// 2. four sockets: machine A, machine B, the owner's page, the reader's page
const machineA = new Client("machine A", EVENTS, { Authorization: `Bearer ${tokenA}` });
const machineB = new Client("machine B", EVENTS, { Authorization: `Bearer ${tokenB}` });
const ownerPage = new Client("owner page", EVENTS, { Cookie: cookieOf(owner), Origin: SITE });
const readerPage = new Client("reader page", `${EVENTS}?owner=${owner.userId}`, { Cookie: cookieOf(reader), Origin: SITE });
const everyone = [machineA, machineB, ownerPage, readerPage];
await Promise.all(everyone.map((c) => c.opened));
check("four sockets upgraded (101): two machines (bearer), the owner's page and the reader's page (cookie + Origin)", true);
const hellos = await Promise.all(everyone.map((c) => c.next((m) => m.type === "hello")));
check("each got hello with a cursor and hosts", hellos.every((h) => h && Number.isInteger(h.cursor) && typeof h.hosts === "object"), hellos);
console.log(`     hello: ${JSON.stringify(hellos[0])}`);
const cursor0 = hellos[0].cursor;

// 3. a web-host PUT: every socket hears changed, web:true
const marks = everyone.map((c) => c.mark());
const t0 = Date.now();
const bytes = JSON.stringify({ at: new Date().toISOString(), note: "hub proof" });
const wrote = await fetch(`${SITE}/fs/v1/folders/robotparts/web/saved/hub-proof.json`, {
	method: "PUT",
	headers: { Cookie: cookieOf(owner), Origin: SITE, "X-Folder-Sync": "1", "X-Folder-Sync-User": owner.userId, "Content-Type": "application/json" },
	body: bytes,
});
const written = await wrote.json();
check("the owner's page PUT a web-host file (200)", wrote.status === 200 && !!written.host && written.seq >= 1, { status: wrote.status, written });
const heard = await Promise.all(everyone.map((c, i) => c.next((m) => m.type === "changed" && m.host === written.host && m.seq === written.seq, 5000, marks[i])));
check("PUT: all four sockets heard changed {web:true, host = the web host, seq = the manifest's}", heard.every((m) => m && m.web === true && m.cursor > cursor0), heard);
console.log(`     heard ${JSON.stringify(heard[0])} ${Date.now() - t0} ms after the PUT began`);
const webHost = written.host;
const webSeq = written.seq;

// 4. a web-host DELETE: seq moves on
const marks2 = everyone.map((c) => c.mark());
const gone = await fetch(`${SITE}/fs/v1/folders/robotparts/web/saved/hub-proof.json`, {
	method: "DELETE",
	headers: { Cookie: cookieOf(owner), Origin: SITE, "X-Folder-Sync": "1", "X-Folder-Sync-User": owner.userId },
});
const deleted = await gone.json();
const heard2 = await Promise.all(everyone.map((c, i) => c.next((m) => m.type === "changed" && m.host === webHost && m.seq === deleted.seq, 5000, marks2[i])));
check("DELETE: all four sockets heard changed with the next seq", gone.status === 200 && deleted.seq === webSeq + 1 && heard2.every((m) => m && m.web === true), { status: gone.status, deleted, heard2 });

// 5. a machine announces: everyone but the sender
const marks3 = everyone.map((c) => c.mark());
machineA.send({ type: "changed", host: ownerHost, seq: 41 });
const [b, op, rp] = await Promise.all([machineB, ownerPage, readerPage].map((c, i) => c.next((m) => m.type === "changed" && m.host === ownerHost, 5000, marks3[i + 1])));
check("machine A's changed reaches machine B, the owner's page and the reader's page with web:false", [b, op, rp].every((m) => m && m.seq === 41 && m.web === false), [b, op, rp]);
await sleep(400);
check("...and not machine A itself (the sender)", !machineA.received.slice(marks3[0]).some((m) => m.type === "changed" && m.host === ownerHost), machineA.received.slice(marks3[0]));
const cursorAfter = b.cursor;

// 6. forward-only: a repeat and a lower seq are not broadcast
const marks4 = everyone.map((c) => c.mark());
machineA.send({ type: "changed", host: ownerHost, seq: 41 });
machineA.send({ type: "changed", host: ownerHost, seq: 40 });
await sleep(600);
check("a repeated or lower seq for a known host is not broadcast", [machineB, ownerPage, readerPage].every((c, i) => c.received.length === marks4[i + 1]));
machineB.send({ type: "changed", host: ownerHost, seq: 42 });
const [forward] = await Promise.all([machineA, ownerPage, readerPage].map((c, i) => c.next((m) => m.type === "changed" && m.host === ownerHost && m.seq === 42, 5000, i === 0 ? marks4[0] : marks4[i + 1])));
check("a higher seq is: machine B's seq 42 reaches the others (machine A, both pages), cursor +1", !!forward && forward.cursor === cursorAfter + 1, forward);

// 7. who may not announce
const marks5 = everyone.map((c) => c.mark());
readerPage.send({ type: "changed", host: otherHost, seq: 1 });
ownerPage.send({ type: "changed", host: otherHost, seq: 1 });
machineB.send("not json");
machineB.send({ type: "changed", host: "NOT-A-UUID", seq: 5 });
machineB.send({ type: "changed", host: otherHost, seq: 0 });
machineB.send({ type: "changed", host: otherHost, seq: 1, pad: "x".repeat(2000) });
machineB.send({ type: "hello", host: otherHost, seq: 1 });
await sleep(800);
check("a reader's page, the owner's page, junk, a bad host, seq 0, an oversized and a wrong-type message are all ignored (nobody hears, nobody answers)", everyone.every((c, i) => c.received.length === marks5[i]), everyone.map((c, i) => c.received.slice(marks5[i])));
check("...and every socket is still open", everyone.every((c) => c.ws.readyState === WebSocket.OPEN));

// 8. ping -> pong
const mark6 = readerPage.mark();
readerPage.send("ping");
const pong = await readerPage.next((m) => m === "pong", 3000, mark6);
check("ping is answered pong", pong === "pong", readerPage.raw.slice(mark6));

// 9. a late joiner catches up from hello
const late = new Client("late machine", EVENTS, { Authorization: `Bearer ${tokenB}` });
await late.opened;
const lateHello = await late.next((m) => m.type === "hello");
check("a late socket's hello carries every host's seq (web host and both machine ids)", !!lateHello && lateHello.hosts[ownerHost]?.seq === 42 && lateHello.hosts[webHost]?.seq === deleted.seq, lateHello);
console.log(`     late hello: ${JSON.stringify(lateHello)}`);

for (const c of [...everyone, late]) c.close();
await sleep(200);
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
