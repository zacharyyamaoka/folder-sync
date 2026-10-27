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
	usage(owner: string): Promise<{ bytes: number; objects: number; measured_at: string } | null>;
	setUsage(owner: string, bytes: number, objects: number, measuredAt: string): Promise<void>;
	/** Adds what the web host just wrote to the last measurement (none yet: nothing to add to). */
	addUsage(owner: string, bytes: number, objects: number): Promise<void>;
	/** Claims the person's next measurement until `until` (ms): true for exactly one caller while no claim is live. */
	claimMeasurement(owner: string, now: number, until: number): Promise<boolean>;
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
		usage: (owner) => one<{ bytes: number; objects: number; measured_at: string }>('SELECT bytes, objects, measured_at FROM "usage" WHERE owner_id = ?', owner),
		async setUsage(owner, bytes, objects, measuredAt) {
			await run(
				'INSERT INTO "usage" (owner_id, bytes, objects, measured_at) VALUES (?, ?, ?, ?) ON CONFLICT (owner_id) DO UPDATE SET bytes = excluded.bytes, objects = excluded.objects, measured_at = excluded.measured_at',
				owner, bytes, objects, measuredAt,
			);
		},
		async addUsage(owner, bytes, objects) {
			await run('UPDATE "usage" SET bytes = bytes + ?, objects = objects + ? WHERE owner_id = ?', bytes, objects, owner);
		},
		async claimMeasurement(owner, now, until) {
			// one statement: a first claim inserts an unmeasured row (measured_at ''), a later one moves an expired claim
			const done = await run(
				'INSERT INTO "usage" (owner_id, bytes, objects, measured_at, claimed_until) VALUES (?, 0, 0, \'\', ?) ON CONFLICT (owner_id) DO UPDATE SET claimed_until = excluded.claimed_until WHERE "usage".claimed_until < ?',
				owner, until, now,
			);
			return (done.meta?.changes ?? 0) > 0;
		},
	};
	return store;
}
