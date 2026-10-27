// The web host's one writer per folder (PEP 0003 §3.4, review r1 #3): a Durable Object per (person, project), named
// webHostName(owner, project). Every web-host write, delete and pre-read settle of that folder runs here, one at a
// time, through WebHostCore (webhost.ts), with its journal in the object's own storage and an alarm that settles a
// change a restart or a failed undo left journalled, even when no other request comes (review r2 #2).
//
// WHY a Durable Object: it is the one place Cloudflare guarantees a single instance per name, so the queue holds
// across every isolate and colo. WHY still a queue inside it: an object takes a new call whenever the current one
// awaits a fetch (input gates only hold during storage calls), and one web-host write is several fetches.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./app.ts";
import { d1Store, type D1Like } from "./store.ts";
import { WebHostCore, type WebAnswer, type WebOp } from "./webhost.ts";

export class WebHostObject extends DurableObject<Env> {
	private readonly core: WebHostCore;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.core = new WebHostCore(env, (request) => fetch(request), ctx.storage, () => Date.now(), d1Store(env.DB as D1Like));
	}

	/** One write, delete or settle of this folder's web host, after every earlier one has finished. */
	run(op: WebOp): Promise<WebAnswer> {
		return this.core.run(op);
	}

	async alarm(): Promise<void> {
		await this.core.alarm();
	}
}
