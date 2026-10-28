// The folder's hub (PEP 0005 §3): one Durable Object per (person, project) that holds the hibernating WebSockets of
// that folder's machines and pages, and says "host H is now at seq N" to all of them the moment a manifest moves.
// It carries no content: a client that hears `changed` reads the manifests in the bucket as it always did, and one
// that missed it catches up from `hello` or its fallback poll.
//
// WHY hibernation (ctx.acceptWebSocket): an idle socket costs nothing and the keep-alive `ping` is answered by the
// runtime (setWebSocketAutoResponse) without waking this object; only a real `changed` or a connect runs code.
// WHY the Worker decides who may connect: this object trusts the X-Hub-Role / X-Hub-Kind headers the Worker sets
// after its own auth, and is reachable only through the Worker's binding.
// WHY a socket also records who it is (X-Hub-Owner / -Project / -User / -Email / -Session; post-rebase review): the
// Worker's check happens once, when the socket opens, and a socket can stay open for days. So the paths that end a
// session (a revoke, a sign-out) or a reader (removal) tell the hubs to close its sockets (POST /close), and each
// announcement is checked again against the session (devices' own rules: app.ts stillSignedIn, decide), so a revoke
// whose close never arrived still stops a machine moving a host's seq.
//
// The decisions (what a message must look like, who may announce, what moves the state, who hears it) are plain
// functions, so node --test covers them without workerd (test/hub.test.ts).

import { DurableObject } from "cloudflare:workers";
import { decide, stillSignedIn, type Env, type Person } from "./app.ts";
import { d1Store, type D1Like, type Store } from "./store.ts";

export type HubRole = "owner" | "reader" | "public";
/** machine = a bearer session (folder-sync on someone's computer), page = a browser (cookie) or a signed-out reader. */
export type HubKind = "machine" | "page";

/** Who a socket is: the folder it listens to and the session behind it. Never a credential (the Worker keeps those). */
export interface Identity {
	owner: string;
	project: string;
	userId: string;
	email: string;
	sessionId: string;
}

/** What a socket's attachment records (PEP 0005 §3), which survives the object's hibernation. `who` is absent for a
 *  signed-out socket (anyone on a public folder): it has no session to end. */
export interface Attachment {
	role: HubRole;
	kind: HubKind;
	who?: Identity;
}

/** The close a socket gets when its session has ended (revoked, signed out): 4401, the WebSocket twin of the 401 its
 *  next upgrade gets. folder-sync's client takes it as signed out and stops reconnecting (internal/push). */
export const SIGNED_OUT = { code: 4401, reason: "signed_out" } as const;
/** The close a reader's socket gets when the owner removes them: 4403. */
export const NOT_A_READER = { code: 4403, reason: "not_a_reader" } as const;

/** What POST /close names: the sockets of one session, or the reader sockets of one email. */
export type CloseOrder = { session: string } | { reader: string };

export interface HubState {
	/** +1 per change that moved a host. */
	cursor: number;
	hosts: Record<string, { seq: number }>;
}

/** A host id is a lowercase UUID v4 (the same rule as app.ts's HOST_ID). */
export const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** PEP 0005 §3: a message is at most 1 KB; anything longer is ignored unread. */
export const MESSAGE_MAX_BYTES = 1024;
/** WHY a cap: a host id is free to invent for the folder's own owner, and each one is a row in `hosts` and in every
 *  `hello`; a folder has a handful of machines, so this is generous and still bounds the object's storage. */
export const HOSTS_MAX = 256;

export function emptyState(): HubState {
	return { cursor: 0, hosts: {} };
}

/** The attachment for the Worker's role and kind headers (and identity, when it sent one), or null when either is
 *  missing or unknown. */
export function attachmentOf(role: string | null, kind: string | null, who: Identity | null = null): Attachment | null {
	if (role !== "owner" && role !== "reader" && role !== "public") return null;
	if (kind !== "machine" && kind !== "page") return null;
	return who ? { role, kind, who } : { role, kind };
}

/** The Worker's identity headers, or null when it sent none (a signed-out socket) or not all of them. The email is
 *  percent-encoded (a header carries bytes only). */
export function identityOf(headers: Headers): Identity | null {
	const [owner, project, userId, encoded, sessionId] = ["X-Hub-Owner", "X-Hub-Project", "X-Hub-User", "X-Hub-Email", "X-Hub-Session"].map((name) => headers.get(name));
	if (!owner || !project || !userId || !encoded || !sessionId) return null;
	let email: string;
	try {
		email = decodeURIComponent(encoded);
	} catch {
		return null;
	}
	return { owner, project, userId, email, sessionId };
}

/** POST /close's body, or null: exactly one of a session id or a reader's email. */
export function parseClose(value: unknown): CloseOrder | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const { session, reader } = value as Record<string, unknown>;
	if ((session === undefined) === (reader === undefined)) return null;
	if (typeof session === "string" && session) return { session };
	if (typeof reader === "string" && reader) return { reader };
	return null;
}

/** Whether `order` closes a socket: every socket of that session (any role); a removed reader's reader sockets only
 *  (WHY: the owner's own sockets, and a public one, never depended on the reader row). */
export function closes(attachment: Attachment | null, order: CloseOrder): boolean {
	const who = attachment?.who;
	if (!who) return false;
	if ("session" in order) return who.sessionId === order.session;
	return attachment!.role === "reader" && who.email.toLowerCase() === order.reader.toLowerCase();
}

/** Whether `who` may still announce: its session lives and devices' own rules still make it the folder's owner. */
export async function stillOwner(store: Store, who: Identity, now: number): Promise<boolean> {
	const person: Person = { userId: who.userId, email: who.email, name: null, image: null, sessionId: who.sessionId, sessionToken: "" };
	if (!(await stillSignedIn({ store, now: () => now }, person, now))) return false;
	const decided = await decide({ store }, person, who.project, who.owner);
	return !(decided instanceof Response) && decided.role === "owner";
}

/** WHY owner + machine only: a reader or a page must never be able to announce a change, or any reader could make
 *  every machine of the owner run rounds (and cost) at will; the owner's own page writes through the web host, which
 *  the Worker announces itself. */
export function mayAnnounce(attachment: Attachment | null): boolean {
	return !!attachment && attachment.role === "owner" && attachment.kind === "machine";
}

function validChange(host: unknown, seq: unknown): host is string {
	return typeof host === "string" && HOST_ID.test(host) && typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0;
}

/** A client's `changed` message, or null for anything else (not text, too long, not JSON, wrong type, bad host or seq). */
export function parseChanged(message: unknown): { host: string; seq: number } | null {
	if (typeof message !== "string") return null;
	// WHY the cheap bound first: a code unit is at least one UTF-8 byte, so a longer string is over 1 KB without
	// encoding it; the exact byte count settles the rest
	if (message.length > MESSAGE_MAX_BYTES || new TextEncoder().encode(message).byteLength > MESSAGE_MAX_BYTES) return null;
	let value: unknown;
	try {
		value = JSON.parse(message);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const { type, host, seq } = value as Record<string, unknown>;
	if (type !== "changed" || !validChange(host, seq)) return null;
	return { host, seq: seq as number };
}

/** A web-host notify from the Worker (`{host, seq, web: true}`), or null. */
export function parseNotify(value: unknown): { host: string; seq: number } | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const { host, seq, web } = value as Record<string, unknown>;
	if (web !== true || !validChange(host, seq)) return null;
	return { host, seq: seq as number };
}

/** The state after host reached seq, or null when that moves nothing (WHY: `hosts[h].seq` only moves forward, so a
 *  late or repeated announcement is neither stored nor broadcast, and the cursor counts real changes only). */
export function advance(state: HubState, host: string, seq: number): HubState | null {
	const known = state.hosts[host];
	if (known ? seq <= known.seq : Object.keys(state.hosts).length >= HOSTS_MAX) return null;
	return { cursor: state.cursor + 1, hosts: { ...state.hosts, [host]: { seq } } };
}

export function helloMessage(state: HubState): string {
	return JSON.stringify({ type: "hello", cursor: state.cursor, hosts: state.hosts });
}

export function changedMessage(cursor: number, host: string, seq: number, web: boolean): string {
	return JSON.stringify({ type: "changed", cursor, host, seq, web });
}

/** Everyone who hears a change: every socket except the one that sent it (it knows). */
export function recipients<T>(sockets: readonly T[], sender: T | null): T[] {
	return sockets.filter((socket) => socket !== sender);
}

// ------------------------------------------------------------------------------------------------ the object

export class FolderHub extends DurableObject<Env> {
	private state: HubState = emptyState();
	/** The accounts' D1 rows, for the per-announcement check; null in a stand-in without a database (the unit tests). */
	private readonly store: Store | null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.store = env.DB ? d1Store(env.DB as D1Like) : null;
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
		// WHY before any event: a message must never see the empty state of an object that was just woken
		ctx.blockConcurrencyWhile(async () => {
			const [cursor, hosts] = await Promise.all([ctx.storage.get<number>("cursor"), ctx.storage.get<HubState["hosts"]>("hosts")]);
			this.state = { cursor: cursor ?? 0, hosts: hosts ?? {} };
		});
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") return this.connect(request);
		if (request.method === "POST" && new URL(request.url).pathname === "/notify") return this.notify(request);
		if (request.method === "POST" && new URL(request.url).pathname === "/close") return this.close(request);
		return new Response("not found", { status: 404 });
	}

	private connect(request: Request): Response {
		const attachment = attachmentOf(request.headers.get("X-Hub-Role"), request.headers.get("X-Hub-Kind"), identityOf(request.headers));
		// WHY refused, not defaulted: the headers come from the Worker only; a missing one is a bug there, and a guess
		// here could hand a reader the right to announce
		if (!attachment) return new Response("the Worker names a role and a kind", { status: 400 });
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment(attachment);
		server.send(helloMessage(this.state));
		return new Response(null, { status: 101, webSocket: client });
	}

	/** The Worker, after a web-host write or delete succeeded. */
	private async notify(request: Request): Promise<Response> {
		let value: unknown;
		try {
			value = await request.json();
		} catch {
			return new Response("not JSON", { status: 400 });
		}
		const change = parseNotify(value);
		if (!change) return new Response("host, seq and web:true", { status: 400 });
		await this.record(change.host, change.seq, true, null);
		return new Response(null, { status: 204 });
	}

	/** The Worker, after a session or a reader ended (a revoke, a sign-out, a removal): closes the sockets it names. */
	private async close(request: Request): Promise<Response> {
		let value: unknown;
		try {
			value = await request.json();
		} catch {
			return new Response("not JSON", { status: 400 });
		}
		const order = parseClose(value);
		if (!order) return new Response("session or reader", { status: 400 });
		const why = "session" in order ? SIGNED_OUT : NOT_A_READER;
		let closed = 0;
		for (const socket of this.ctx.getWebSockets()) {
			if (!closes(socket.deserializeAttachment() as Attachment | null, order)) continue;
			end(socket, why);
			closed++;
		}
		return new Response(JSON.stringify({ closed }), { status: 200, headers: { "Content-Type": "application/json" } });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		// WHY silent: PEP 0005 §3 — anything that is not a valid announcement from an owner's machine is ignored, so a
		// client can't learn from an error which of the rules it broke
		const attachment = ws.deserializeAttachment() as Attachment | null;
		if (!mayAnnounce(attachment)) return;
		const change = parseChanged(message);
		if (!change) return;
		// WHY read again on every announcement (post-rebase review): the socket's session was checked when it opened, and
		// a revoke whose close never reached this object (a failed notify) must still not let it move a seq; a seq it
		// inflated would make this object ignore the host's real announcements until they caught up
		const still = await this.stillOwner(attachment!);
		if (still === false) end(ws, SIGNED_OUT);
		if (still) await this.record(change.host, change.seq, false, ws);
	}

	/** True when the socket may still announce, false when its session ended, null when that can't be read now (the
	 *  announcement is then ignored, like any other refused one, and the socket stays). */
	private async stillOwner(attachment: Attachment): Promise<boolean | null> {
		if (!this.store) return true; // a stand-in without a database: nothing there can be revoked
		if (!attachment.who) return false; // WHY refused: the Worker names every session's socket, so one without is a bug
		try {
			return await stillOwner(this.store, attachment.who, Date.now());
		} catch {
			return null;
		}
	}

	/** Stores the move (if it is one) and tells everyone but `sender`. */
	private async record(host: string, seq: number, web: boolean, sender: WebSocket | null): Promise<void> {
		const next = advance(this.state, host, seq);
		if (!next) return;
		// WHY stored before it is told: a `changed` a client has seen must survive the object's eviction
		await this.ctx.storage.put({ cursor: next.cursor, hosts: next.hosts });
		this.state = next;
		const text = changedMessage(next.cursor, host, seq, web);
		for (const socket of recipients(this.ctx.getWebSockets(), sender)) {
			try {
				socket.send(text);
			} catch {
				// a socket that is closing: its own close event removes it
			}
		}
	}

	async webSocketClose(ws: WebSocket, code: number): Promise<void> {
		// 1005 and 1006 are reports, not codes a close frame may carry
		try {
			ws.close(code === 1005 || code === 1006 ? 1000 : code);
		} catch {
			// already closed
		}
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		try {
			ws.close(1011);
		} catch {
			// already closed
		}
	}
}

/** Closes a socket with `why`, whatever state it is in. */
function end(socket: WebSocket, why: { code: number; reason: string }): void {
	try {
		socket.close(why.code, why.reason);
	} catch {
		// already closed
	}
}
