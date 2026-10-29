// Restore requests (PEP 0007 §3.3, docs/CONTRACT.md "Restore requests"): how a page asks a machine to restore its
// own files. `<root>_requests/<project>/<host>/<id>.json`, created once (If-None-Match: *) here, applied only by the
// host it names, which writes `outcome` into it in place; the folder's pruner deletes it 30 days on.
//
// WHY a request and not the Worker writing the old bytes into the machine's prefix: that would break the one-writer
// rule, and the machine's next reconcile would move the object to history as a stray.

import { requestsPrefix } from "./history.ts";

export const RESTORE = "folder-sync-restore/1";

export interface RestoreRequest {
	schema: typeof RESTORE;
	id: string;
	project: string;
	host: string;
	at: string;
	by: { kind: "web" | "machine"; name: string; host?: string };
	items: { path: string; version: string }[];
	outcome?: { at: string; seq?: number; results: unknown[] };
}

export function requestKey(root: string, project: string, host: string, id: string): string {
	return `${requestsPrefix(root, project, host)}${id}.json`;
}

/** What requests are written and read with (s3-bucket.ts S3Bucket). */
export interface RequestBucket {
	put(key: string, body: Uint8Array, options?: { ifNoneMatch?: "*"; contentType?: string }): Promise<{ ok: boolean; status: number }>;
	get(key: string): Promise<{ arrayBuffer?: () => Promise<ArrayBuffer> } | null>;
	objects(prefix: string, options?: { cursor?: string; max?: number }): Promise<{ objects: { key: string; lastModified: number }[]; truncated: boolean; cursor?: string }>;
}

/** Creates the request, once: false when its id is taken (a 412), which a fresh id never is. */
export async function writeRequest(bucket: RequestBucket, root: string, request: RestoreRequest): Promise<boolean> {
	const answer = await bucket.put(requestKey(root, request.project, request.host, request.id), new TextEncoder().encode(`${JSON.stringify(request)}\n`), { ifNoneMatch: "*", contentType: "application/json" });
	return answer.ok;
}

/** How many requests a status reads (newest first, by when each was last written): the rest wait for the next. */
export const WAITING_READS = 50;

/** The folder's requests no host has answered yet (no `outcome`), newest first. */
export async function waitingRequests(bucket: RequestBucket, root: string, project: string): Promise<RestoreRequest[]> {
	const listed: { key: string; lastModified: number }[] = [];
	let cursor: string | undefined;
	let pages = 0;
	do {
		const page = await bucket.objects(requestsPrefix(root, project), { cursor, max: 1000 });
		listed.push(...page.objects.filter((o) => o.key.endsWith(".json")));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor && ++pages < 10);
	listed.sort((a, b) => b.lastModified - a.lastModified || (a.key < b.key ? -1 : 1));
	const out: RestoreRequest[] = [];
	for (const { key } of listed.slice(0, WAITING_READS)) {
		const object = await bucket.get(key);
		if (!object?.arrayBuffer) continue;
		let doc: RestoreRequest;
		try {
			doc = JSON.parse(new TextDecoder().decode(await object.arrayBuffer()));
		} catch {
			continue;
		}
		if (!doc || doc.schema !== RESTORE || doc.outcome || !Array.isArray(doc.items) || !doc.items.length) continue;
		if (key !== requestKey(root, project, doc.host, doc.id)) continue; // a request names the host and id its key does
		out.push(doc);
	}
	return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
