// src/store.ts's Store in memory, for the unit tests (the proof runs the D1 one under wrangler dev).

import type { FolderRow, Store, Visibility } from "../src/store.ts";

export class MemoryStore implements Store {
	readonly rows = new Map<string, FolderRow>();
	readonly readerRows = new Map<string, Set<string>>();
	readonly webHosts = new Map<string, string>();

	private k(owner: string, project: string): string {
		return `${owner}\u0000${project}`;
	}

	async folder(owner: string, project: string) {
		return this.rows.get(this.k(owner, project)) ?? null;
	}

	async folders(owner: string) {
		return [...this.rows.values()].filter((r) => r.owner_id === owner).sort((a, b) => (a.project < b.project ? -1 : 1));
	}

	async setVisibility(owner: string, project: string, visibility: Visibility, now: string) {
		const row = { owner_id: owner, project, visibility, updated_at: now };
		this.rows.set(this.k(owner, project), row);
		return row;
	}

	async readers(owner: string, project: string) {
		return [...(this.readerRows.get(this.k(owner, project)) ?? [])].sort();
	}

	async isReader(owner: string, project: string, email: string) {
		return this.readerRows.get(this.k(owner, project))?.has(email) ?? false;
	}

	async addReader(owner: string, project: string, email: string, now: string) {
		if (!this.rows.has(this.k(owner, project))) this.rows.set(this.k(owner, project), { owner_id: owner, project, visibility: "private", updated_at: now });
		const set = this.readerRows.get(this.k(owner, project)) ?? new Set<string>();
		set.add(email);
		this.readerRows.set(this.k(owner, project), set);
	}

	async removeReader(owner: string, project: string, email: string) {
		return this.readerRows.get(this.k(owner, project))?.delete(email) ?? false;
	}

	async readable(email: string) {
		const out: { owner: string; project: string }[] = [];
		for (const [key, set] of this.readerRows) {
			if (!set.has(email)) continue;
			const [owner, project] = key.split("\u0000");
			out.push({ owner, project });
		}
		return out;
	}

	async webHost(owner: string, project: string) {
		return this.webHosts.get(this.k(owner, project)) ?? null;
	}

	readonly usageRows = new Map<string, { bytes: number; objects: number; measured_at: string }>();

	async usage(owner: string) {
		return this.usageRows.get(owner) ?? null;
	}

	async setUsage(owner: string, bytes: number, objects: number, measuredAt: string) {
		this.usageRows.set(owner, { bytes, objects, measured_at: measuredAt });
	}

	async addUsage(owner: string, bytes: number, objects: number) {
		const row = this.usageRows.get(owner);
		if (row) this.usageRows.set(owner, { ...row, bytes: row.bytes + bytes, objects: row.objects + objects });
	}

	async ensureWebHost(owner: string, project: string, candidate: string) {
		const key = this.k(owner, project);
		if (!this.webHosts.has(key)) this.webHosts.set(key, candidate);
		return this.webHosts.get(key)!;
	}
}
