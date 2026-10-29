// A folder's activity online (PEP 0007 §4, docs/API.md "activity"): every host's published upload / delete / restore
// events, read from its change records by key, counting down from its manifest's seq (no listing), and its pulled
// download / remove_copy events, from one listing of its pull records; merged newest first, a page at a time.
//
// The cursor (`next`, opaque to the page) holds the last event it returned and, per host, where to read on from, so
// the next page reads only older records. Records missing in a run of seqs ("not recorded", or pruned after 30 days)
// end a host's count down after MISSES_IN_A_ROW, so a host whose old records are gone costs a few reads, not its seq.

import { changesKey, pullsPrefix } from "./history.ts";

/** One host's records as the reader needs them: its manifest's seq (0 when it has none) and its name. */
export interface ActivityHost {
	id: string;
	name: string;
	seq: number;
}

/** What activity reads with (s3-bucket.ts S3Bucket): GETs by key and one listing of each host's pulls/. */
export interface ActivityBucket {
	get(key: string): Promise<{ arrayBuffer?: () => Promise<ArrayBuffer> } | null>;
	objects(prefix: string, options?: { cursor?: string; max?: number }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
}

export interface ActivityQuery {
	limit: number;
	level: "warn" | "error" | null;
	host: string | null;
	before: string | null;
}

type Event = Record<string, unknown> & { at: string; event: string };

/** A run of missing change records this long ends a host's count down. */
export const MISSES_IN_A_ROW = 5;
/** At most this many record reads per page (a request's subrequests are bounded). */
export const READS_PER_PAGE = 300;
/** At most this many pages of a host's pulls/ listing (1000 keys a page). */
const PULL_PAGES = 5;

interface Cursor {
	/** The last event returned: its instant (ms), its instant as written, and its tiebreak. */
	t: [number, string, string];
	/** Per host: the seq to read on from (0: none left). */
	s: Record<string, number>;
	/** Per host: the newest pull record's at (key) still to read; "" none left. */
	p: Record<string, string>;
}

function encode(cursor: Cursor): string {
	return btoa(JSON.stringify(cursor)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(text: string): Cursor | null {
	try {
		const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
		const cursor = JSON.parse(raw) as Cursor;
		if (!Array.isArray(cursor.t) || cursor.t.length !== 3 || typeof cursor.t[0] !== "number" || typeof cursor.t[1] !== "string" || typeof cursor.t[2] !== "string") return null;
		if (!cursor.s || typeof cursor.s !== "object" || !cursor.p || typeof cursor.p !== "object") return null;
		return cursor;
	} catch {
		return null;
	}
}

function tiebreak(e: Event): string {
	return `${e.host ?? ""}\u0000${String(e.seq ?? "").padStart(12, "0")}\u0000${e.event}\u0000${e.path ?? ""}`;
}

/** Newest first: by instant, then as written, then the tiebreak (all descending). */
function newer(a: [number, string, string], b: [number, string, string]): number {
	if (a[0] !== b[0]) return b[0] - a[0];
	if (a[1] !== b[1]) return a[1] < b[1] ? 1 : -1;
	return a[2] < b[2] ? 1 : a[2] > b[2] ? -1 : 0;
}

function keyOf(e: Event): [number, string, string] {
	return [Date.parse(e.at), e.at, tiebreak(e)];
}

function wanted(e: Event, query: ActivityQuery): boolean {
	const level = (e.level as string | undefined) ?? "info";
	if (query.level === "warn" && level !== "warn" && level !== "error") return false;
	if (query.level === "error" && level !== "error") return false;
	return true;
}

async function json(bucket: ActivityBucket, key: string): Promise<Record<string, unknown> | null> {
	const object = await bucket.get(key);
	if (!object?.arrayBuffer) return null;
	try {
		const doc = JSON.parse(new TextDecoder().decode(await object.arrayBuffer()));
		return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : null;
	} catch {
		return null;
	}
}

/** The events a record holds, each with its host, host_name (and seq, for a change record) filled in when missing;
 *  only well-formed events of the kinds the record carries. */
function eventsOf(doc: Record<string, unknown> | null, host: ActivityHost, kinds: Set<string>, seq?: number): Event[] {
	if (!doc || !Array.isArray(doc.events)) return [];
	const out: Event[] = [];
	for (const item of doc.events) {
		if (!item || typeof item !== "object" || typeof item.at !== "string" || !Number.isFinite(Date.parse(item.at)) || !kinds.has(item.event)) continue;
		const e: Event = { ...item };
		if (e.host === undefined) e.host = host.id;
		if (e.host_name === undefined) e.host_name = typeof doc.host_name === "string" ? doc.host_name : host.name;
		if (seq !== undefined && e.seq === undefined) e.seq = seq;
		out.push(e);
	}
	return out;
}

const CHANGE_KINDS = new Set(["upload", "delete", "restore"]);
const PULL_KINDS = new Set(["download", "remove_copy"]);

/** One page of a folder's activity. */
export async function activity(bucket: ActivityBucket, root: string, project: string, hosts: ActivityHost[], query: ActivityQuery): Promise<{ events: Event[]; next: string | null } | null> {
	const cursor = query.before ? decodeCursor(query.before) : null;
	if (query.before && !cursor) return null;
	const after = cursor?.t ?? null;
	const older = (e: Event) => !after || newer(after, keyOf(e)) < 0;
	const chosen = hosts.filter((h) => !query.host || h.id === query.host);
	let reads = 0;
	// each source, read newest first until it holds `limit` events older than the cursor (or runs out): its events, and
	// the position of each record read, so the next cursor knows where to read on from
	const read: { host: string; kind: "seq" | "pull"; at: number | string; events: Event[]; marker?: boolean }[] = [];
	const exhausted = new Map<string, boolean>();
	await Promise.all(chosen.map(async (host) => {
		// change records, by key, counting down
		let seq = cursor ? (cursor.s[host.id] ?? 0) : host.seq;
		let found = 0;
		let misses = 0;
		while (seq >= 1 && found < query.limit && misses < MISSES_IN_A_ROW && reads < READS_PER_PAGE) {
			reads += 1;
			const doc = await json(bucket, changesKey(root, project, host.id, seq));
			if (!doc) misses += 1;
			else {
				misses = 0;
				const events = eventsOf(doc, host, CHANGE_KINDS, seq).filter((e) => older(e) && wanted(e, query));
				found += events.length;
				read.push({ host: host.id, kind: "seq", at: seq, events });
			}
			seq -= 1;
		}
		exhausted.set(`s:${host.id}`, seq < 1 || misses >= MISSES_IN_A_ROW);
		if (!exhausted.get(`s:${host.id}`)) read.push({ host: host.id, kind: "seq", at: seq, events: [], marker: true }); // read on from here
		// pull records: one listing (their keys are their at), newest first
		const keys: string[] = [];
		const prefix = pullsPrefix(root, project, host.id);
		let listing: string | undefined;
		let pages = 0;
		do {
			const page = await bucket.objects(prefix, { cursor: listing, max: 1000 });
			for (const { key } of page.objects) if (key.endsWith(".json")) keys.push(key.slice(prefix.length, -".json".length));
			listing = page.truncated ? page.cursor : undefined;
		} while (listing && ++pages < PULL_PAGES);
		keys.sort().reverse();
		const from = cursor ? (cursor.p[host.id] ?? "") : (keys[0] ?? "");
		let pulled = 0;
		let i = from ? keys.indexOf(from) : keys.length;
		if (i < 0) i = keys.findIndex((k) => k < from);
		if (i < 0) i = keys.length;
		for (; i < keys.length && pulled < query.limit && reads < READS_PER_PAGE; i++) {
			reads += 1;
			const events = eventsOf(await json(bucket, `${prefix}${keys[i]}.json`), host, PULL_KINDS).filter((e) => older(e) && wanted(e, query));
			pulled += events.length;
			read.push({ host: host.id, kind: "pull", at: keys[i], events });
		}
		exhausted.set(`p:${host.id}`, i >= keys.length);
		if (i < keys.length) read.push({ host: host.id, kind: "pull", at: keys[i], events: [], marker: true });
	}));
	const all = read.flatMap((r) => r.events.map((e) => ({ e, r })));
	all.sort((a, b) => newer(keyOf(a.e), keyOf(b.e)));
	const page = all.slice(0, query.limit);
	const left = all.length > page.length || [...exhausted.values()].some((done) => !done);
	// WHY no cursor after an empty page: nothing older was found within this page's reads, so there is nothing to page to
	if (!left || !page.length) return { events: page.map((x) => x.e), next: null };
	// where each source reads on from: the newest record still holding an event this page did not return, else where
	// its reading stopped, else nothing
	const last = keyOf(page[page.length - 1].e);
	const next: Cursor = { t: last, s: {}, p: {} };
	const from = (host: string, kind: "seq" | "pull") => {
		const records = read.filter((r) => r.host === host && r.kind === kind);
		const holding = records.filter((r) => r.events.some((e) => newer(last, keyOf(e)) < 0));
		return holding.length ? holding : records.filter((r) => r.marker);
	};
	for (const host of chosen) {
		const seqs = from(host.id, "seq").map((r) => r.at as number);
		next.s[host.id] = seqs.length ? Math.max(...seqs) : 0;
		const pulls = from(host.id, "pull").map((r) => r.at as string).sort();
		next.p[host.id] = pulls.length ? pulls[pulls.length - 1] : "";
	}
	return { events: page.map((x) => x.e), next: encode(next) };
}
