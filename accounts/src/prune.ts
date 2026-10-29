// The folder's daily prune (PEP 0007 §3.2, docs/CONTRACT.md "What is kept"): every host's history thinned by the
// staggered schedule, and change records, pull records, restore requests and legacy _trash/ deleted 30 days on. Run
// by the folder's Durable Object (webhost-do.ts, on its one alarm), so a machine that never comes back is pruned too;
// each engine also prunes its own host with the same rule (history.ts pruneVersions), and two pruners on one key are
// harmless: the rule is deterministic, and deleting a deleted key is a no-op.
//
// WHY by LastModified: an object under _history/ has no metadata, and its LastModified is when its version left the
// folder (left_at). A change record is written once, right after its manifest, so its LastModified is its `at` to
// within a round; a pull record's `at` is its key.
//
// WHY a restore request goes 30 days after its LastModified, not its `at`: an answered request was rewritten (its
// outcome) after `at`, so this can only keep it longer than 30 days, never shorter, and it costs no GET per request.
//
// WHY legacy _trash/ here (the lifecycle fix, PEP 0007 §1.4): an R2 lifecycle rule matches a literal prefix, so the
// README's `_trash/` rule never matched a signed-in person's users/<id>/_trash/; without this their trash grew until
// they hit their quota.

import { KEEP_DAYS, historyPrefix, parseVersion, pruneVersions, pullsPrefix, requestsPrefix, trashStampTime } from "./history.ts";

const DAY_MS = 24 * 3600_000;

/** What the pruner lists and deletes with (s3-bucket.ts S3Bucket). */
export interface PruneBucket {
	objects(prefix: string, options?: { cursor?: string; max?: number }): Promise<{ objects: { key: string; size: number; lastModified: number }[]; truncated: boolean; cursor?: string }>;
	deleteMany(keys: string[]): Promise<string[]>;
}

export interface Pruned {
	/** Objects deleted, and their bytes: history ones count toward the quota's objects, change records only bytes. */
	deleted: number;
	bytes: number;
	objects: number;
	/** The budget ran out with more to look at: run again soon. */
	more: boolean;
}

/** How many listing pages one prune reads, and how many objects it deletes, before it stops for the next alarm. WHY
 *  bounded: a Durable Object's alarm has the same subrequest limit as a request. */
export const PAGE_BUDGET = 200;
export const DELETE_BUDGET = 20_000;

async function* listed(bucket: PruneBucket, prefix: string, budget: { pages: number }): AsyncGenerator<{ key: string; size: number; lastModified: number }> {
	let cursor: string | undefined;
	do {
		if (budget.pages <= 0) throw new OutOfBudget();
		budget.pages -= 1;
		const page = await bucket.objects(prefix, { cursor, max: 1000 });
		yield* page.objects;
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}

class OutOfBudget extends Error {}

/** Prunes one folder (`<root>…/<project>/`) at `now`. */
export async function pruneFolder(bucket: PruneBucket, root: string, project: string, now: number, keepDays = KEEP_DAYS): Promise<Pruned> {
	const budget = { pages: PAGE_BUDGET };
	const out: Pruned = { deleted: 0, bytes: 0, objects: 0, more: false };
	const doomed: { key: string; size: number; counts: boolean }[] = [];
	const cutoff = now - keepDays * DAY_MS;
	const flush = async (force: boolean) => {
		while (doomed.length >= 1000 || (force && doomed.length)) {
			const batch = doomed.splice(0, 1000);
			const failed = new Set(await bucket.deleteMany(batch.map((d) => d.key)));
			for (const d of batch) {
				if (failed.has(d.key)) continue;
				out.deleted += 1;
				out.bytes += d.size;
				if (d.counts) out.objects += 1;
			}
		}
	};
	const doom = async (key: string, size: number, counts = true) => {
		if (out.deleted + doomed.length >= DELETE_BUDGET) throw new OutOfBudget();
		doomed.push({ key, size, counts });
		await flush(false);
	};
	try {
		// history: grouped by (host, path), which is the key without its last segment. WHY all groups first: a folder
		// named like a version's date ("2026-10-27T08/") sorts between that path's own versions, so one group's
		// versions need not arrive together
		const groups = new Map<string, { id: string; left_at: number; key: string; size: number }[]>();
		for await (const object of listed(bucket, historyPrefix(root, project), budget)) {
			const cut = object.key.lastIndexOf("/");
			const id = object.key.slice(cut + 1);
			if (!parseVersion(id)) continue; // not a version: never this pruner's to delete
			const dir = object.key.slice(0, cut);
			const versions = groups.get(dir) ?? [];
			versions.push({ id, left_at: object.lastModified, key: object.key, size: object.size });
			groups.set(dir, versions);
		}
		for (const versions of groups.values()) {
			const kept = pruneVersions(versions, now, keepDays);
			for (const v of versions) if (!kept.has(v.id)) await doom(v.key, v.size);
		}
		// change records and pull records (bytes only toward the quota: quota.ts measureRoot)
		for await (const object of listed(bucket, `${root}_changes/${project}/`, budget)) {
			const rest = object.key.slice(`${root}_changes/${project}/`.length).split("/");
			const pull = rest.length === 3 && rest[1] === "pulls" ? Date.parse(rest[2].replace(/\.json$/, "")) : NaN;
			const at = Number.isFinite(pull) && object.key.startsWith(pullsPrefix(root, project, rest[0])) ? pull : object.lastModified;
			if (at < cutoff) await doom(object.key, object.size, false);
		}
		for await (const object of listed(bucket, requestsPrefix(root, project), budget)) {
			if (object.lastModified < cutoff) await doom(object.key, object.size);
		}
		// legacy _trash/<project>/<host>/<UTC-stamp>/<path>: 30 days after its stamp
		for await (const object of listed(bucket, `${root}_trash/${project}/`, budget)) {
			const stamp = object.key.slice(`${root}_trash/${project}/`.length).split("/")[1] ?? "";
			const at = trashStampTime(stamp);
			if (at !== null && at < cutoff) await doom(object.key, object.size);
		}
	} catch (error) {
		if (!(error instanceof OutOfBudget)) throw error;
		out.more = true;
	}
	await flush(true);
	return out;
}
