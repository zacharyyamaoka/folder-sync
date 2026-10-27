// folder-sync's own rows in D1 (migrations/0001_accounts.sql, 0002_usage.sql): who may read a folder, each folder's web
// host, and each person's measured storage.
// The routes (app.ts) see only the Store interface, so the unit tests run it in memory (test/memory-store.ts) and
// the proof runs this file against wrangler dev's local D1.

export type Visibility = "private" | "public";

/** The folder row, as PATCH answers it. */
export interface FolderRow {
	owner_id: string;
	project: string;
	visibility: Visibility;
	updated_at: string;
}

export interface Store {
	folder(owner: string, project: string): Promise<FolderRow | null>;
	/** Every row of one owner's folders (published or shared). */
	folders(owner: string): Promise<FolderRow[]>;
	setVisibility(owner: string, project: string, visibility: Visibility, now: string): Promise<FolderRow>;
	readers(owner: string, project: string): Promise<string[]>;
	isReader(owner: string, project: string, email: string): Promise<boolean>;
	/** Grants read; makes the folder row (private) when it has none yet. */
	addReader(owner: string, project: string, email: string, now: string): Promise<void>;
	removeReader(owner: string, project: string, email: string): Promise<boolean>;
	/** The other people's folders this email may read. */
	readable(email: string): Promise<{ owner: string; project: string }[]>;
	webHost(owner: string, project: string): Promise<string | null>;
	/** The folder's web host id: `candidate` if this call made the row, else the one already there. */
	ensureWebHost(owner: string, project: string, candidate: string, now: string): Promise<string>;
	/** The person's storage as last measured (quota.ts), or null before the first measurement. */
	usage(owner: string): Promise<{ bytes: number; objects: number; measured_at: string; partial?: boolean; stale?: boolean } | null>;
	/** Stores a measurement; with `token`, only while that claim is still the person's (review r3 #7): false when a
	 *  newer claim has taken over, and nothing is written. */
	setUsage(owner: string, bytes: number, objects: number, measuredAt: string, token?: string, partial?: boolean): Promise<boolean>;
	/** Adds what the web host just wrote to the last measurement (none yet: nothing to add to). A credit (anything
	 *  negative) is never subtracted: it marks the measurement stale and counts a mutation, so the next request measures
	 *  again (review r5 #2: a credit landing after a complete measurement would count the deletion twice). */
	addUsage(owner: string, bytes: number, objects: number): Promise<void>;
	/** Claims the person's next measurement until `until` (ms), as `token`: true for exactly one caller while no claim
	 *  is live. */
	claimMeasurement(owner: string, now: number, until: number, token: string): Promise<boolean>;
}

/** The subset of Cloudflare's D1Database binding used here. */
export interface D1Like {
	prepare(sql: string): {
		bind(...values: unknown[]): {
			first<T = Record<string, unknown>>(): Promise<T | null>;
			all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
			run(): Promise<{ meta?: { changes?: number } }>;
		};
	};
}

export function d1Store(db: D1Like): Store {
	const one = <T>(sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values).first<T>();
	const all = async <T>(sql: string, ...values: unknown[]) => (await db.prepare(sql).bind(...values).all<T>()).results;
	const run = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values).run();
	const store: Store = {
		folder: (owner, project) => one<FolderRow>('SELECT owner_id, project, visibility, updated_at FROM "folder" WHERE owner_id = ? AND project = ?', owner, project),
		folders: (owner) => all<FolderRow>('SELECT owner_id, project, visibility, updated_at FROM "folder" WHERE owner_id = ? ORDER BY project', owner),
		async setVisibility(owner, project, visibility, now) {
			await run(
				'INSERT INTO "folder" (owner_id, project, visibility, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (owner_id, project) DO UPDATE SET visibility = excluded.visibility, updated_at = excluded.updated_at',
				owner, project, visibility, now,
			);
			return { owner_id: owner, project, visibility, updated_at: now };
		},
		async readers(owner, project) {
			return (await all<{ reader_email: string }>('SELECT reader_email FROM "folder_reader" WHERE owner_id = ? AND project = ? ORDER BY reader_email', owner, project)).map((r) => r.reader_email);
		},
		async isReader(owner, project, email) {
			return !!(await one('SELECT 1 AS yes FROM "folder_reader" WHERE owner_id = ? AND project = ? AND reader_email = ?', owner, project, email));
		},
		async addReader(owner, project, email, now) {
			await run('INSERT INTO "folder" (owner_id, project, visibility, updated_at) VALUES (?, ?, \'private\', ?) ON CONFLICT (owner_id, project) DO NOTHING', owner, project, now);
			await run('INSERT INTO "folder_reader" (owner_id, project, reader_email, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', owner, project, email, now);
		},
		async removeReader(owner, project, email) {
			const done = await run('DELETE FROM "folder_reader" WHERE owner_id = ? AND project = ? AND reader_email = ?', owner, project, email);
			return (done.meta?.changes ?? 0) > 0;
		},
		async readable(email) {
			return (await all<{ owner_id: string; project: string }>('SELECT owner_id, project FROM "folder_reader" WHERE reader_email = ? ORDER BY owner_id, project', email)).map((r) => ({ owner: r.owner_id, project: r.project }));
		},
		async webHost(owner, project) {
			return (await one<{ host_id: string }>('SELECT host_id FROM "web_host" WHERE owner_id = ? AND project = ?', owner, project))?.host_id ?? null;
		},
		async ensureWebHost(owner, project, candidate, now) {
			// WHY insert-then-read: two first writes at once both try; the primary key keeps exactly one host
			await run('INSERT INTO "web_host" (owner_id, project, host_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (owner_id, project) DO NOTHING', owner, project, candidate, now);
			const id = await store.webHost(owner, project);
			if (!id) throw new Error("the web host row did not stick");
			return id;
		},
		async usage(owner) {
			const row = await one<{ bytes: number; objects: number; measured_at: string; partial: number; stale: number }>('SELECT bytes, objects, measured_at, partial, stale FROM "usage" WHERE owner_id = ?', owner);
			return row ? { bytes: row.bytes, objects: row.objects, measured_at: row.measured_at, partial: !!row.partial, stale: !!row.stale } : null;
		},
		async setUsage(owner, bytes, objects, measuredAt, token, partial = false) {
			if (token !== undefined) {
				// stale when a deletion crossed this measurement (its mutation count moved since the claim): measured again.
				// WHY plus what was charged since the claim (review r6 #2): a write that landed after the listing is not in
				// it, so its charge stays (one that landed before is counted twice: high until the next measurement, never low).
				// The claim is released: a stale figure may be measured again at once (a failed listing keeps its minute)
				const done = await run('UPDATE "usage" SET bytes = ? + charged_bytes, objects = ? + charged_objects, measured_at = ?, partial = ?, stale = CASE WHEN mutations = claim_mutations THEN 0 ELSE 1 END, claimed_until = 0 WHERE owner_id = ? AND claim_token = ?', bytes, objects, measuredAt, partial ? 1 : 0, owner, token);
				return (done.meta?.changes ?? 0) > 0;
			}
			await run(
				'INSERT INTO "usage" (owner_id, bytes, objects, measured_at, partial) VALUES (?, ?, ?, ?, ?) ON CONFLICT (owner_id) DO UPDATE SET bytes = excluded.bytes, objects = excluded.objects, measured_at = excluded.measured_at, partial = excluded.partial, stale = 0',
				owner, bytes, objects, measuredAt, partial ? 1 : 0,
			);
			return true;
		},
		async addUsage(owner, bytes, objects) {
			if (bytes < 0 || objects < 0) {
				await run('UPDATE "usage" SET stale = 1, mutations = mutations + 1 WHERE owner_id = ?', owner);
				return;
			}
			await run('UPDATE "usage" SET bytes = bytes + ?, objects = objects + ?, charged_bytes = charged_bytes + ?, charged_objects = charged_objects + ? WHERE owner_id = ?', bytes, objects, bytes, objects, owner);
		},
		async claimMeasurement(owner, now, until, token) {
			// one statement: a first claim inserts an unmeasured row (measured_at ''), a later one moves an expired claim
			const done = await run(
				'INSERT INTO "usage" (owner_id, bytes, objects, measured_at, claimed_until, claim_token) VALUES (?, 0, 0, \'\', ?, ?) ON CONFLICT (owner_id) DO UPDATE SET claimed_until = excluded.claimed_until, claim_token = excluded.claim_token, claim_mutations = "usage".mutations, charged_bytes = 0, charged_objects = 0 WHERE "usage".claimed_until < ?',
				owner, until, token, now,
			);
			return (done.meta?.changes ?? 0) > 0;
		},
	};
	return store;
}
