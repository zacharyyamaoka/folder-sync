// The folder's hub (PEP 0004 §3): one Durable Object per (person, project) that holds the hibernating WebSockets of
// that folder's machines and pages, and says "host H is now at seq N" to all of them the moment a manifest moves.
// It carries no content: a client that hears `changed` reads the manifests in the bucket as it always did, and one
// that missed it catches up from `hello` or its fallback poll.
//
// WHY hibernation (ctx.acceptWebSocket): an idle socket costs nothing and the keep-alive `ping` is answered by the
// runtime (setWebSocketAutoResponse) without waking this object; only a real `changed` or a connect runs code.
// WHY the Worker decides who may connect: this object trusts the X-Hub-Role / X-Hub-Kind headers the Worker sets
// after its own auth, and is reachable only through the Worker's binding.
//
// The decisions (what a message must look like, who may announce, what moves the state, who hears it) are plain
// functions, so node --test covers them without workerd (test/hub.test.ts).

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./app.ts";

export type HubRole = "owner" | "reader" | "public";
/** machine = a bearer session (folder-sync on someone's computer), page = a browser (cookie) or a signed-out reader. */
export type HubKind = "machine" | "page";

/** What a socket's attachment records (PEP 0004 §3), which survives the object's hibernation. */
export interface Attachment {
	role: HubRole;
	kind: HubKind;
}

export interface HubState {
	/** +1 per change that moved a host. */
	cursor: number;
	hosts: Record<string, { seq: number }>;
}

/** A host id is a lowercase UUID v4 (the same rule as app.ts's HOST_ID). */
export const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** PEP 0004 §3: a message is at most 1 KB; anything longer is ignored unread. */
export const MESSAGE_MAX_BYTES = 1024;
/** WHY a cap: a host id is free to invent for the folder's own owner, and each one is a row in `hosts` and in every
 *  `hello`; a folder has a handful of machines, so this is generous and still bounds the object's storage. */
export const HOSTS_MAX = 256;

export function emptyState(): HubState {
	return { cursor: 0, hosts: {} };
}

/** The attachment for the Worker's role and kind headers, or null when either is missing or unknown. */
export function attachmentOf(role: string | null, kind: string | null): Attachment | null {
	if (role !== "owner" && role !== "reader" && role !== "public") return null;
	if (kind !== "machine" && kind !== "page") return null;
	return { role, kind };
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

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
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
		return new Response("not found", { status: 404 });
	}

	private connect(request: Request): Response {
		const attachment = attachmentOf(request.headers.get("X-Hub-Role"), request.headers.get("X-Hub-Kind"));
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

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		// WHY silent: PEP 0004 §3 — anything that is not a valid announcement from an owner's machine is ignored, so a
		// client can't learn from an error which of the rules it broke
		if (!mayAnnounce(ws.deserializeAttachment() as Attachment | null)) return;
		const change = parseChanged(message);
		if (change) await this.record(change.host, change.seq, false, ws);
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
