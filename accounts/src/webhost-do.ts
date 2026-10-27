// The web host's one writer per folder (PEP 0003 §3.4, review r1 #3): a Durable Object per (person, project), named
// webHostName(owner, project). Every web-host write and delete of that folder runs here, one at a time, with its
// journal in the object's own storage, so a write cut off by a restart is settled by the folder's next one.
//
// WHY a Durable Object: it is the one place Cloudflare guarantees a single instance per name, so the queue holds
// across every isolate and colo. WHY still a queue inside it: an object takes a new call whenever the current one
// awaits a fetch (input gates only hold during storage calls), and one web-host write is several fetches.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./app.ts";
import { runWebOp, Serial, type Journal, type Pending, type WebAnswer, type WebOp } from "./webhost.ts";

export class WebHostObject extends DurableObject<Env> {
	private readonly serial = new Serial();

	private journal(): Journal {
		const storage = this.ctx.storage;
		return {
			get: async () => (await storage.get<Pending>("pending")) ?? null,
			put: (pending) => storage.put("pending", pending),
			delete: async () => {
				await storage.delete("pending");
			},
		};
	}

	/** One write or delete of this folder's web host, after every earlier one has finished. */
	run(op: WebOp): Promise<WebAnswer> {
		return this.serial.run("", () => runWebOp(this.env, (request) => fetch(request), op, this.journal(), () => Date.now()));
	}
}
