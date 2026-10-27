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

	readonly usageRows = new Map<string, { bytes: number; objects: number; measured_at: string; partial?: boolean; stale?: boolean }>();
	readonly mutations = new Map<string, number>();

	async usage(owner: string) {
		return this.usageRows.get(owner) ?? null;
	}

	async setUsage(owner: string, bytes: number, objects: number, measuredAt: string, token?: string, partial = false) {
		const claim = this.claims.get(owner);
		if (token !== undefined && claim?.token !== token) return false;
		const crossed = token !== undefined && (this.mutations.get(owner) ?? 0) !== claim!.mutations;
		this.usageRows.set(owner, { bytes, objects, measured_at: measuredAt, partial, stale: crossed });
		if (token !== undefined) this.claims.set(owner, { ...claim!, until: 0 });
		return true;
	}

	async addUsage(owner: string, bytes: number, objects: number) {
		const row = this.usageRows.get(owner);
		if (bytes < 0 || objects < 0) {
			if (row) {
				this.usageRows.set(owner, { ...row, stale: true });
				this.mutations.set(owner, (this.mutations.get(owner) ?? 0) + 1);
			}
			return;
		}
		if (row) this.usageRows.set(owner, { ...row, bytes: row.bytes + bytes, objects: row.objects + objects });
	}

	readonly claims = new Map<string, { until: number; token: string; mutations: number }>();

	async claimMeasurement(owner: string, now: number, until: number, token: string) {
		if ((this.claims.get(owner)?.until ?? 0) >= now) return false;
		this.claims.set(owner, { until, token, mutations: this.mutations.get(owner) ?? 0 });
		if (!this.usageRows.has(owner)) this.usageRows.set(owner, { bytes: 0, objects: 0, measured_at: "" });
		return true;
	}

	async ensureWebHost(owner: string, project: string, candidate: string) {
		const key = this.k(owner, project);
		if (!this.webHosts.has(key)) this.webHosts.set(key, candidate);
		return this.webHosts.get(key)!;
	}
}
