// The folder hub on bare Node (node --test accounts/test/hub.test.ts; no workerd, no ports): PEP 0004 §3's rules.
//
// What must hold:
// - a `changed` is accepted from an owner's machine only, as text of at most 1 KB, with a lowercase UUID v4 host and a
//   positive integer seq; everything else is ignored without an answer;
// - `hosts[h].seq` only moves forward, and only a move is stored, counted by the cursor and broadcast;
// - a change is heard by every socket except the one that sent it; a web-host notify is heard by all;
// - state survives the object being evicted and woken (it reads storage), and `hello` carries it.
// hub.ts imports "cloudflare:workers", which exists only in workerd: a resolve hook gives it the one base class the
// hub needs, so the Durable Object itself runs here against a fake ctx.

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") {
			return { url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }", shortCircuit: true };
		}
		return next(specifier, context);
	},
});

const hub = await import("../src/hub.ts");
const { FolderHub } = hub;

const HOST = "b55e9683-7854-4121-a56a-9bae7c3ab1da";
const OTHER = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const WEB = "3f1c2a9e-5b7d-4c11-8e2f-0a1b2c3d4e5f";
const changed = (host: unknown, seq: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "changed", host, seq, ...extra });

// ------------------------------------------------------------------------------------------------ the pure rules

test("a changed message: text, at most 1 KB, type changed, a lowercase UUID v4 host, a positive integer seq", () => {
	assert.deepEqual(hub.parseChanged(changed(HOST, 13)), { host: HOST, seq: 13 });
	assert.deepEqual(hub.parseChanged(changed(HOST, 1, { cursor: 99, web: true, note: "ignored" })), { host: HOST, seq: 1 }, "extra keys are ignored");
	const refused: [string, unknown][] = [
		["binary", new TextEncoder().encode(changed(HOST, 1)).buffer],
		["not JSON", "changed"],
		["a JSON array", JSON.stringify([HOST, 1])],
		["null", "null"],
		["another type", JSON.stringify({ type: "hello", host: HOST, seq: 1 })],
		["no type", JSON.stringify({ host: HOST, seq: 1 })],
		["an uppercase host", changed(HOST.toUpperCase(), 1)],
		["a UUID v1", changed("b55e9683-7854-1121-a56a-9bae7c3ab1da", 1)],
		["a UUID with a bad variant", changed("b55e9683-7854-4121-c56a-9bae7c3ab1da", 1)],
		["a host with a suffix", changed(`${HOST}x`, 1)],
		["a host with a newline", changed(`${HOST}\n`, 1)],
		["a numeric host", changed(7, 1)],
		["seq 0", changed(HOST, 0)],
		["a negative seq", changed(HOST, -3)],
		["a fractional seq", changed(HOST, 1.5)],
		["a string seq", changed(HOST, "13")],
		["a seq past 2^53", changed(HOST, 2 ** 60)],
		["no seq", JSON.stringify({ type: "changed", host: HOST })],
	];
	for (const [what, message] of refused) assert.equal(hub.parseChanged(message), null, what);
	// 1 KB exactly is fine, one byte more is not; the limit is bytes, not characters
	const base = changed(HOST, 1, { pad: "" });
	const exact = changed(HOST, 1, { pad: "x".repeat(hub.MESSAGE_MAX_BYTES - base.length) });
	assert.equal(new TextEncoder().encode(exact).byteLength, hub.MESSAGE_MAX_BYTES);
	assert.deepEqual(hub.parseChanged(exact), { host: HOST, seq: 1 });
	assert.equal(hub.parseChanged(changed(HOST, 1, { pad: "x".repeat(hub.MESSAGE_MAX_BYTES - base.length + 1) })), null);
	assert.equal(hub.parseChanged(changed(HOST, 1, { pad: "é".repeat(hub.MESSAGE_MAX_BYTES / 2) })), null, "two bytes a character");
});

test("only an owner's machine may announce a change", () => {
	for (const role of ["owner", "reader", "public"] as const) {
		for (const kind of ["machine", "page"] as const) {
			assert.equal(hub.mayAnnounce({ role, kind }), role === "owner" && kind === "machine", `${role} ${kind}`);
		}
	}
	assert.equal(hub.mayAnnounce(null), false, "a socket without an attachment");
});

test("the Worker's role and kind headers: both known, else no socket", () => {
	assert.deepEqual(hub.attachmentOf("reader", "page"), { role: "reader", kind: "page" });
	for (const [role, kind] of [[null, "page"], ["owner", null], ["admin", "machine"], ["owner", "robot"], ["OWNER", "machine"], ["", ""]] as const) {
		assert.equal(hub.attachmentOf(role, kind), null, `${role} ${kind}`);
	}
});

test("a host's seq only moves forward; only a move changes the state and counts on the cursor", () => {
	let state = hub.emptyState();
	const steps: [string, number, boolean][] = [[HOST, 5, true], [HOST, 5, false], [HOST, 4, false], [HOST, 6, true], [OTHER, 1, true], [OTHER, 1, false], [HOST, 7, true]];
	for (const [host, seq, moves] of steps) {
		const next = hub.advance(state, host, seq);
		assert.equal(next !== null, moves, `${host.slice(0, 4)} @${seq}`);
		if (next) {
			assert.equal(next.cursor, state.cursor + 1);
			state = next;
		}
	}
	assert.deepEqual(state, { cursor: 4, hosts: { [HOST]: { seq: 7 }, [OTHER]: { seq: 1 } } });
	const before = JSON.stringify(state);
	hub.advance(state, HOST, 99);
	assert.equal(JSON.stringify(state), before, "advance does not mutate the state it was given");
});

test("a folder holds a bounded number of hosts: a new one past the cap is refused, a known one still moves", () => {
	let state = hub.emptyState();
	const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
	for (let n = 0; n < hub.HOSTS_MAX; n++) state = hub.advance(state, id(n), 1)!;
	assert.equal(hub.advance(state, id(hub.HOSTS_MAX), 1), null);
	assert.equal(hub.advance(state, id(0), 2)?.hosts[id(0)].seq, 2);
});

test("the broadcast set is every socket but the sender", () => {
	const [a, b, c] = [{ id: "a" }, { id: "b" }, { id: "c" }];
	assert.deepEqual(hub.recipients([a, b, c], b), [a, c]);
	assert.deepEqual(hub.recipients([a, b, c], null), [a, b, c], "a web notify has no sender");
	assert.deepEqual(hub.recipients([a], a), []);
});

test("the messages are the PEP's: hello with the cursor and hosts, changed with cursor, host, seq and web", () => {
	assert.deepEqual(JSON.parse(hub.helloMessage({ cursor: 7, hosts: { [HOST]: { seq: 12 } } })), { type: "hello", cursor: 7, hosts: { [HOST]: { seq: 12 } } });
	assert.deepEqual(JSON.parse(hub.changedMessage(8, HOST, 13, false)), { type: "changed", cursor: 8, host: HOST, seq: 13, web: false });
	assert.deepEqual(hub.parseNotify({ host: WEB, seq: 2, web: true }), { host: WEB, seq: 2 });
	for (const bad of [{ host: WEB, seq: 2 }, { host: WEB, seq: 2, web: false }, { host: "x", seq: 2, web: true }, { host: WEB, seq: 0, web: true }, null, [], "x"]) {
		assert.equal(hub.parseNotify(bad), null, JSON.stringify(bad));
	}
});

// ------------------------------------------------------------------------------------------------ the object, on a fake ctx

class FakeSocket {
	attachment: unknown = null;
	sent: string[] = [];
	closed: number | null = null;
	failOnSend = false;
	serializeAttachment(value: unknown) { this.attachment = value; }
	deserializeAttachment() { return this.attachment; }
	send(text: string) {
		if (this.failOnSend) throw new Error("closing");
		this.sent.push(text);
	}
	close(code: number) {
		if (this.closed !== null) throw new Error("already closed");
		this.closed = code;
	}
	heard() { return this.sent.map((s) => JSON.parse(s)); }
}

/** One storage that outlives objects, so a test can evict (drop) the object and wake a new one over it. */
function fakeCtx(storage: Map<string, unknown>) {
	const sockets: FakeSocket[] = [];
	let autoResponse: unknown = null;
	const ctx = {
		storage: {
			get: async (key: string) => storage.get(key),
			put: async (entries: Record<string, unknown>) => { for (const [k, v] of Object.entries(entries)) storage.set(k, structuredClone(v)); },
		},
		blockConcurrencyWhile: (work: () => Promise<void>) => { ctx.blocked = work(); },
		blocked: Promise.resolve() as Promise<void>,
		setWebSocketAutoResponse: (pair: unknown) => { autoResponse = pair; },
		acceptWebSocket: (ws: FakeSocket) => { sockets.push(ws); },
		getWebSockets: () => [...sockets],
	};
	return { ctx, sockets, autoResponse: () => autoResponse };
}

class FakePair {
	request: string;
	response: string;
	constructor(request: string, response: string) {
		this.request = request;
		this.response = response;
	}
}
(globalThis as Record<string, unknown>).WebSocketRequestResponsePair = FakePair;
// workerd answers an upgrade with status 101 and a webSocket; Node's Response refuses both, so this file's Response
// takes them and reports the 101
const NativeResponse = Response;
(globalThis as Record<string, unknown>).Response = class extends NativeResponse {
	webSocket?: unknown;
	constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
		if (init?.status !== 101) return super(body, init);
		super(null, { ...init, status: 200 });
		Object.defineProperty(this, "status", { value: 101 });
		this.webSocket = init.webSocket;
	}
};
(globalThis as Record<string, unknown>).WebSocketPair = class {
	0 = {};
	1 = new FakeSocket();
};

async function wake(storage = new Map<string, unknown>()) {
	const fake = fakeCtx(storage);
	const object = new FolderHub(fake.ctx, {});
	await fake.ctx.blocked;
	/** A connected socket with the role and kind the Worker would forward; its hello is dropped from `sent`. */
	const connect = async (role: string, kind: string) => {
		const answer = await object.fetch(new Request("https://hub/fs/v1/folders/robotparts/events", { headers: { Upgrade: "websocket", "X-Hub-Role": role, "X-Hub-Kind": kind } }));
		const socket = fake.sockets[fake.sockets.length - 1];
		return { answer, socket };
	};
	const notify = (body: unknown) => object.fetch(new Request("https://hub/notify", { method: "POST", body: JSON.stringify(body) }));
	return { object, fake, connect, notify };
}

test("the object auto-answers ping with pong (so a keep-alive never wakes it)", async () => {
	const { fake } = await wake();
	const pair = fake.autoResponse() as FakePair;
	assert.equal(pair.request, "ping");
	assert.equal(pair.response, "pong");
});

test("a socket gets hello with the state, and its role and kind in its attachment", async () => {
	const storage = new Map<string, unknown>([["cursor", 7], ["hosts", { [HOST]: { seq: 12 } }]]);
	const { connect } = await wake(storage);
	const { answer, socket } = await connect("reader", "page");
	assert.equal(answer.status, 101);
	assert.ok((answer as unknown as { webSocket: unknown }).webSocket, "the client end goes back to the Worker");
	assert.deepEqual(socket.attachment, { role: "reader", kind: "page" });
	assert.deepEqual(socket.heard(), [{ type: "hello", cursor: 7, hosts: { [HOST]: { seq: 12 } } }]);
});

test("a connection without the Worker's headers is refused", async () => {
	const { object, fake } = await wake();
	const answer = await object.fetch(new Request("https://hub/x", { headers: { Upgrade: "websocket" } }));
	assert.equal(answer.status, 400);
	assert.equal(fake.sockets.length, 0);
	assert.equal((await object.fetch(new Request("https://hub/anything"))).status, 404);
});

test("a machine's changed reaches every socket but its own; the cursor counts it; a repeat is silent", async () => {
	const { object, connect } = await wake();
	const laptop = (await connect("owner", "machine")).socket;
	const desktop = (await connect("owner", "machine")).socket;
	const page = (await connect("owner", "page")).socket;
	const reader = (await connect("reader", "page")).socket;
	for (const s of [laptop, desktop, page, reader]) s.sent.length = 0;
	await object.webSocketMessage(laptop, changed(HOST, 13));
	const expected = { type: "changed", cursor: 1, host: HOST, seq: 13, web: false };
	assert.deepEqual(laptop.heard(), [], "the sender is not told");
	for (const s of [desktop, page, reader]) assert.deepEqual(s.heard(), [expected]);
	await object.webSocketMessage(laptop, changed(HOST, 13));
	await object.webSocketMessage(laptop, changed(HOST, 12));
	for (const s of [laptop, desktop, page, reader]) assert.equal(s.sent.length, s === laptop ? 0 : 1, "a seq that did not advance is not broadcast");
	await object.webSocketMessage(desktop, changed(HOST, 14));
	assert.deepEqual(laptop.heard(), [{ type: "changed", cursor: 2, host: HOST, seq: 14, web: false }]);
	assert.equal(desktop.sent.length, 1, "the desktop heard only the first");
});

test("anyone else's changed is ignored silently: a reader, a public socket, a page, junk, binary", async () => {
	const { object, connect, fake } = await wake();
	const listener = (await connect("owner", "machine")).socket;
	const senders = [await connect("reader", "machine"), await connect("public", "page"), await connect("owner", "page"), await connect("reader", "page")].map((c) => c.socket);
	for (const s of [listener, ...senders]) s.sent.length = 0;
	for (const s of senders) await object.webSocketMessage(s, changed(HOST, 5));
	const owner = fake.sockets[0];
	await object.webSocketMessage(owner, "ping");
	await object.webSocketMessage(owner, changed("nope", 5));
	await object.webSocketMessage(owner, changed(HOST, 0));
	await object.webSocketMessage(owner, new TextEncoder().encode(changed(HOST, 5)).buffer);
	await object.webSocketMessage(owner, changed(HOST, 5, { pad: "x".repeat(2000) }));
	for (const s of [listener, ...senders]) assert.deepEqual(s.sent, [], "nothing was broadcast and nobody was answered");
	await object.webSocketMessage(new FakeSocket(), changed(HOST, 5));
	assert.deepEqual(listener.sent, [], "a socket with no attachment (never connected through the Worker)");
});

test("a web-host notify reaches every socket (it has no sender), flagged web:true; seq stays forward-only", async () => {
	const { connect, notify } = await wake();
	const sockets = [(await connect("owner", "machine")).socket, (await connect("reader", "page")).socket, (await connect("public", "page")).socket];
	for (const s of sockets) s.sent.length = 0;
	assert.equal((await notify({ host: WEB, seq: 3, web: true })).status, 204);
	for (const s of sockets) assert.deepEqual(s.heard(), [{ type: "changed", cursor: 1, host: WEB, seq: 3, web: true }]);
	assert.equal((await notify({ host: WEB, seq: 3, web: true })).status, 204, "a repeat is accepted");
	assert.equal((await notify({ host: WEB, seq: 2, web: true })).status, 204, "a late one too");
	for (const s of sockets) assert.equal(s.sent.length, 1);
	assert.equal((await notify({ host: WEB, seq: 4, web: false })).status, 400, "web:true is part of the message");
	assert.equal((await notify({ host: "not-a-host", seq: 4, web: true })).status, 400);
	assert.equal((await (async () => { const { object } = await wake(); return object.fetch(new Request("https://hub/notify", { method: "POST", body: "{" })); })()).status, 400);
	for (const s of sockets) assert.equal(s.sent.length, 1);
});

test("a dead socket does not stop the others hearing", async () => {
	const { object, connect } = await wake();
	const sender = (await connect("owner", "machine")).socket;
	const dead = (await connect("reader", "page")).socket;
	const live = (await connect("reader", "page")).socket;
	dead.failOnSend = true;
	live.sent.length = 0;
	await object.webSocketMessage(sender, changed(HOST, 2));
	assert.equal(live.sent.length, 1);
});

test("the state is stored before it is told, and a woken object carries on from storage", async () => {
	const storage = new Map<string, unknown>();
	const first = await wake(storage);
	const laptop = (await first.connect("owner", "machine")).socket;
	await first.object.webSocketMessage(laptop, changed(HOST, 9));
	await first.notify({ host: WEB, seq: 2, web: true });
	assert.deepEqual([storage.get("cursor"), storage.get("hosts")], [2, { [HOST]: { seq: 9 }, [WEB]: { seq: 2 } }]);
	// evicted: a new object over the same storage
	const second = await wake(storage);
	const page = (await second.connect("owner", "page")).socket;
	assert.deepEqual(page.heard(), [{ type: "hello", cursor: 2, hosts: { [HOST]: { seq: 9 }, [WEB]: { seq: 2 } } }]);
	const machine = (await second.connect("owner", "machine")).socket;
	await second.object.webSocketMessage(machine, changed(HOST, 9));
	assert.equal(page.sent.length, 1, "seq 9 is not news to the woken object either");
	await second.object.webSocketMessage(machine, changed(HOST, 10));
	assert.deepEqual(page.heard()[1], { type: "changed", cursor: 3, host: HOST, seq: 10, web: false });
});

test("close and error close the socket without throwing, even when it is already closed", async () => {
	const { object, connect } = await wake();
	const a = (await connect("reader", "page")).socket;
	await object.webSocketClose(a, 1005);
	assert.equal(a.closed, 1000, "1005 is a report, not a code to send");
	await object.webSocketClose(a, 1001);
	const b = (await connect("reader", "page")).socket;
	await object.webSocketClose(b, 1001);
	assert.equal(b.closed, 1001);
	const c = (await connect("reader", "page")).socket;
	await object.webSocketError(c);
	assert.equal(c.closed, 1011);
	await object.webSocketError(c);
});
