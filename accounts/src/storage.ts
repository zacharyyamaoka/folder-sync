// GET /fs/v1/usage/breakdown: what is in this account, for the sync view's Storage tab (docs/API.md "Storage").
//
// The person's own root is listed with a read-only credential (the same listing the quota is measured with, quota.ts
// measureRoot), and every object is filed by its key into a kind:
//
//   <project>/hosts/<host>/<path>                                  live      the files themselves
//   _history/<project>/<host>/<path>/<written_at>_<sha16>          history   kept versions (PEP 0007 §3.1)
//   _trash/<project>/<host>/<YYYYMMDDTHHMMSSZ-…>/<path>            trash     the layout before version history
//   _changes/<project>/<host>/…   _requests/<project>/<host>/…     changes, requests
//   anything else                                                  other
//
// It never writes, and it only ever reads the session's own root: ?owner= is not a way to ask for anyone else's.
// WHY a fresh listing and not the cached usage figure: the cache keeps totals (a live/history split), not the keys, and
// a page that opens this tab wants the answer now; it is one listing, at most BREAKDOWN_MAX_PAGES pages (default 100,
// the most the quota's own measurement reads), and a longer root is cut and marked `partial`.
// WHY suggestions are display-only data (title, why, bytes): they say what a person could free; nothing here frees it.

import type { App } from "./apps.ts";
import { bucketFor, fail, json, READ_TTL_S, session, type Deps, type Env } from "./app.ts";
import { userRoot } from "./creds.ts";
import { parseName, parseVersion } from "./history.ts";
import { overQuota, quotaOf } from "./quota.ts";
import type { S3Bucket } from "./s3-bucket.ts";

export interface BreakdownEnv {
	/** Listing pages (1,000 objects each) read at most (default 100). */
	BREAKDOWN_MAX_PAGES?: string;
}

export const KINDS = ["live", "history", "trash", "changes", "requests", "other"] as const;
export type Kind = (typeof KINDS)[number];

const DAY_MS = 86_400_000;
/** What the suggestions call "old": the same seven days as the menu's Free up space (ui FREE_UP_DAYS). */
export const OLD_DAYS = 7;
/** A file's old copies are worth a suggestion from this many copies and this many bytes. */
const COPIES_MIN = 5;
const COPIES_BYTES_MIN = 1024 ** 2;
const FILE_SUGGESTIONS = 3;
const TOP = 10;
/** A folder is named by at most this many path segments (a/b/c). */
const FOLDER_DEPTH = 3;
/** Manifests read for a device's name, and the largest one read. */
const NAMED_MAX = 30;
const MANIFEST_MAX = 2 * 1024 ** 2;
const PAGES_DEFAULT = 100;
const STAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-.*)?$/;

interface Listed {
	key: string;
	size: number;
	lastModified: number;
}

export interface Listing {
	objects(prefix: string, options?: { cursor?: string; max?: number }): Promise<{ objects: Listed[]; truncated: boolean; cursor?: string }>;
}

/** One object, filed: its kind, where it belongs, and the time its key carries (or null). */
interface Item {
	kind: Kind;
	project: string;
	host: string | null;
	path: string;
	size: number;
	/** ms from the key, else null. */
	keyed: number | null;
	modified: number;
}

function classify({ key, size, lastModified }: Listed, root: string): Item {
	const parts = key.slice(root.length).split("/");
	const base = { size, modified: lastModified, keyed: null as number | null };
	const [top, project, host] = parts;
	if (top === "_history" && parts.length >= 5) {
		// WHY the name, not the id: an object may be <version>.<size>.zst or .prefix (PEP 0009); its id is what carries the time
		const name = parseName(parts[parts.length - 1]);
		const version = name ? parseVersion(name.id) : null;
		return { ...base, kind: "history", project, host, path: parts.slice(3, -1).join("/"), keyed: version?.written_at ? Date.parse(version.written_at) : null };
	}
	const stamp = parts.length >= 5 ? STAMP.exec(parts[3]) : null;
	if (top === "_trash" && stamp) {
		return { ...base, kind: "trash", project, host, path: parts.slice(4).join("/"), keyed: Date.UTC(+stamp[1], +stamp[2] - 1, +stamp[3], +stamp[4], +stamp[5], +stamp[6]) };
	}
	if ((top === "_changes" || top === "_requests") && parts.length >= 4) return { ...base, kind: top === "_changes" ? "changes" : "requests", project, host, path: "" };
	if (!top.startsWith("_") && parts[1] === "hosts" && parts.length >= 4) {
		return { ...base, kind: "live", project: top, host: parts[2], path: parts.slice(3).join("/") };
	}
	// outside the layout: filed under its project when it has one, else under none
	const inProject = !top.startsWith("_") && parts.length >= 2;
	return { ...base, kind: "other", project: inProject ? top : "", host: null, path: parts.slice(inProject ? 1 : 0).join("/") };
}

interface Tally {
	bytes: number;
	objects: number;
	oldest: number | null;
	newest: number | null;
}

const tally = (): Tally => ({ bytes: 0, objects: 0, oldest: null, newest: null });

function add(into: Tally, item: Item): void {
	into.bytes += item.size;
	into.objects += 1;
	const at = item.keyed ?? item.modified;
	into.oldest = into.oldest === null ? at : Math.min(into.oldest, at);
	into.newest = into.newest === null ? at : Math.max(into.newest, at);
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
/** Where a kind's timestamps come from: the key for the two that carry one, else the store's LastModified. */
const clockOf = (kind: Kind): "key" | "modified" => (kind === "history" || kind === "trash" ? "key" : "modified");

/** "9.3 MiB", "1.03 GiB", "10 GiB": the same units as the menu's storage line, trimmed of a trailing zero. */
export function sized(n: number): string {
	const trim = (x: number, digits: number) => String(Number(x.toFixed(digits)));
	if (n < 1024) return `${n} B`;
	if (n < 1024 ** 2) return `${trim(n / 1024, 1)} KiB`;
	if (n < 1024 ** 3) return `${trim(n / 1024 ** 2, 1)} MiB`;
	return `${trim(n / 1024 ** 3, 2)} GiB`;
}

/** Everything under `root`, a page at a time, stopped after `maxPages`; `complete` is false when it was cut. */
export async function listAll(bucket: Listing, root: string, maxPages: number): Promise<{ items: Item[]; complete: boolean }> {
	const items: Item[] = [];
	let cursor: string | undefined;
	let pages = 0;
	do {
		const page = await bucket.objects(root, { cursor, max: 1000 });
		pages += 1;
		for (const listed of page.objects) items.push(classify(listed, root));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor && pages < maxPages);
	return { items, complete: !cursor };
}

interface FileCopies {
	live: number | null;
	liveBytes: number;
	oldBytes: number;
	copies: { at: number; size: number }[];
}

export interface Suggestion {
	id: string;
	title: string;
	why: string;
	bytes: number;
	objects: number;
}

/** The breakdown of `items` (names: "<project>\0<host>" to the host's name from its manifest). Pure: no clock but `now`. */
export function breakdownOf(items: Item[], names: Map<string, string>, now: number) {
	const totals = new Map<Kind, Tally>();
	const projects = new Map<string, { total: Tally; kinds: Map<Kind, { tally: Tally; hosts: Map<string, { bytes: number; objects: number }> }> }>();
	const folders = new Map<string, { project: string; host: string; folder: string; live: number; old: number; objects: number }>();
	const files = new Map<string, { project: string; host: string; path: string } & FileCopies>();
	let bytes = 0;
	let objects = 0;
	const cutTrash = { bytes: 0, objects: 0 };
	const cutHistory = { bytes: 0, objects: 0 };
	const cutoff = now - OLD_DAYS * DAY_MS;
	const nameOf = (project: string, host: string | null) => (host === null ? "" : (names.get(`${project}\0${host}`) ?? ""));

	for (const item of items) {
		bytes += item.size;
		// the quota counts a change record's bytes but never an object (quota.ts measureRoot)
		if (item.kind !== "changes") objects += 1;
		add(totals.get(item.kind) ?? totals.set(item.kind, tally()).get(item.kind)!, item);
		const project = projects.get(item.project) ?? projects.set(item.project, { total: tally(), kinds: new Map() }).get(item.project)!;
		add(project.total, item);
		const kind = project.kinds.get(item.kind) ?? project.kinds.set(item.kind, { tally: tally(), hosts: new Map() }).get(item.kind)!;
		add(kind.tally, item);
		if (item.host !== null) {
			const host = kind.hosts.get(item.host) ?? kind.hosts.set(item.host, { bytes: 0, objects: 0 }).get(item.host)!;
			host.bytes += item.size;
			host.objects += 1;
		}
		if (item.kind === "live" || item.kind === "history" || item.kind === "trash") {
			const folder = item.path.split("/").slice(0, -1).slice(0, FOLDER_DEPTH).join("/");
			const folderKey = `${item.project}\0${item.host}\0${folder}`;
			const row = folders.get(folderKey) ?? folders.set(folderKey, { project: item.project, host: item.host!, folder, live: 0, old: 0, objects: 0 }).get(folderKey)!;
			row.objects += 1;
			if (item.kind === "live") row.live += item.size;
			else row.old += item.size;
			const fileKey = `${item.project}\0${item.host}\0${item.path}`;
			const file = files.get(fileKey) ?? files.set(fileKey, { project: item.project, host: item.host!, path: item.path, live: null, liveBytes: 0, oldBytes: 0, copies: [] }).get(fileKey)!;
			if (item.kind === "live") {
				file.live = item.size;
				file.liveBytes += item.size;
			} else {
				file.oldBytes += item.size;
				file.copies.push({ at: item.keyed ?? item.modified, size: item.size });
			}
		}
		if (item.kind === "trash" && (item.keyed ?? item.modified) < cutoff) {
			cutTrash.bytes += item.size;
			cutTrash.objects += 1;
		}
		// history ages by when a version left its folder (LastModified), as the pruner's and Free up space's days do
		if (item.kind === "history" && item.modified < cutoff) {
			cutHistory.bytes += item.size;
			cutHistory.objects += 1;
		}
	}

	const byBytes = <T extends { bytes: number }>(a: T, b: T) => b.bytes - a.bytes;
	const kinds = (map: Map<Kind, Tally>) => KINDS.filter((k) => map.has(k)).map((k) => ({ kind: k, bytes: map.get(k)!.bytes, objects: map.get(k)!.objects, oldest: iso(map.get(k)!.oldest), newest: iso(map.get(k)!.newest), clock: clockOf(k) }));

	const projectRows = [...projects].map(([project, p]) => ({
		project,
		bytes: p.total.bytes,
		objects: p.total.objects,
		kinds: KINDS.filter((k) => p.kinds.has(k)).map((k) => {
			const entry = p.kinds.get(k)!;
			return {
				kind: k, bytes: entry.tally.bytes, objects: entry.tally.objects, oldest: iso(entry.tally.oldest), newest: iso(entry.tally.newest), clock: clockOf(k),
				hosts: [...entry.hosts].map(([host, h]) => ({ host, host_name: nameOf(project, host), bytes: h.bytes, objects: h.objects })).sort((a, b) => byBytes(a, b) || (a.host < b.host ? -1 : 1)),
			};
		}),
	})).sort((a, b) => byBytes(a, b) || (a.project < b.project ? -1 : 1));

	const folderRows = [...folders.values()].map((f) => ({ project: f.project, host: f.host, host_name: nameOf(f.project, f.host), folder: f.folder, bytes: f.live + f.old, objects: f.objects, live_bytes: f.live, old_bytes: f.old }))
		.sort((a, b) => byBytes(a, b) || (`${a.project}/${a.host}/${a.folder}` < `${b.project}/${b.host}/${b.folder}` ? -1 : 1)).slice(0, TOP);
	const fileRows = [...files.values()].map((f) => ({ project: f.project, host: f.host, host_name: nameOf(f.project, f.host), path: f.path, bytes: f.liveBytes + f.oldBytes, live_bytes: f.liveBytes, old_bytes: f.oldBytes, copies: f.copies.length }))
		.sort((a, b) => byBytes(a, b) || (`${a.project}/${a.host}/${a.path}` < `${b.project}/${b.host}/${b.path}` ? -1 : 1)).slice(0, TOP);

	const suggestions: Suggestion[] = [];
	if (cutTrash.bytes > 0) {
		suggestions.push({ id: "trash-old", title: `Empty trash older than ${OLD_DAYS} days`, bytes: cutTrash.bytes, objects: cutTrash.objects, why: "Copies of replaced and deleted files from before version history; nothing lists them any more, and they go 30 days after their date anyway." });
	}
	if (cutHistory.bytes > 0) {
		suggestions.push({ id: "history-old", title: `Delete history older than ${OLD_DAYS} days`, bytes: cutHistory.bytes, objects: cutHistory.objects, why: `Earlier versions of files that left their folders over ${OLD_DAYS} days ago; the last ${OLD_DAYS} days stay restorable.` });
	}
	const heavy = [...files.values()].filter((f) => f.copies.length >= COPIES_MIN && f.oldBytes >= COPIES_BYTES_MIN).map((f) => {
		const copies = [...f.copies].sort((a, b) => a.at - b.at || a.size - b.size);
		const sizes = [...copies.map((c) => c.size), ...(f.live === null ? [] : [f.live])];
		// WHY sizes only: the bytes are not read (the listing has none); a file whose every save is at least as big as the
		// one before, ending bigger than it began, is what an append-only log looks like from outside
		const appendOnly = sizes.every((size, i) => i === 0 || size >= sizes[i - 1]) && sizes[sizes.length - 1] > sizes[0];
		const newest = copies[copies.length - 1];
		return { f, count: copies.length, appendOnly, freed: f.oldBytes - newest.size };
	}).sort((a, b) => b.freed - a.freed || (a.f.path < b.f.path ? -1 : 1)).slice(0, FILE_SUGGESTIONS);
	for (const { f, count, appendOnly, freed } of heavy) {
		suggestions.push({
			id: `${appendOnly ? "log" : "file"}:${f.project}/${f.host}/${f.path}`,
			title: appendOnly ? `${f.path} is an append-only log replaced ${count} times` : `${f.path} has ${count} old copies`,
			bytes: freed, objects: count - 1,
			why: `Its ${count} old copies use ${sized(f.oldBytes)}; keeping only the newest copy frees ${sized(freed)}.`,
		});
	}
	suggestions.sort((a, b) => b.bytes - a.bytes || (a.id < b.id ? -1 : 1));

	return { used: { bytes, objects }, kinds: kinds(totals), projects: projectRows, folders: folderRows, files: fileRows, suggestions };
}

/** Device names from the manifests of the largest hosts (a host with no manifest, or too big a one, has none). */
async function namesOf(bucket: S3Bucket, root: string, items: Item[]): Promise<Map<string, string>> {
	const sizes = new Map<string, number>();
	const manifests = new Map<string, number>();
	for (const item of items) {
		if (item.host === null) continue;
		const key = `${item.project}\0${item.host}`;
		sizes.set(key, (sizes.get(key) ?? 0) + item.size);
		if (item.kind === "live" && item.path === "manifest.json") manifests.set(key, item.size);
	}
	const wanted = [...manifests].filter(([, size]) => size <= MANIFEST_MAX).map(([key]) => key).sort((a, b) => sizes.get(b)! - sizes.get(a)! || (a < b ? -1 : 1)).slice(0, NAMED_MAX);
	const names = new Map<string, string>();
	await Promise.all(wanted.map(async (key) => {
		const [project, host] = key.split("\0");
		try {
			const object = await bucket.get(`${root}${project}/hosts/${host}/manifest.json`);
			if (!object || !("arrayBuffer" in object)) return;
			const doc = JSON.parse(new TextDecoder().decode(await object.arrayBuffer()));
			if (doc && typeof doc.host_name === "string") names.set(key, doc.host_name);
		} catch {
			// no name: the page shows the device's id
		}
	}));
	return names;
}

function pagesOf(env: BreakdownEnv): number {
	const n = Number(env.BREAKDOWN_MAX_PAGES);
	return Number.isInteger(n) && n > 0 ? n : PAGES_DEFAULT;
}

/** GET /fs/v1/usage/breakdown: the signed-in person's own storage, by project, kind and device. */
export async function storageBreakdown(request: Request, env: Env, deps: Deps, app: App | null): Promise<Response> {
	const who = await session(request, deps, app);
	if (!who) return fail(401, "signed_out", "not signed in");
	// WHY the session's id and nothing from the URL: this lists a whole root, so it is only ever the caller's own
	const owner = who.person.userId;
	const root = userRoot(owner, env);
	const bucket = await bucketFor(env, deps, root, "object-read-only", READ_TTL_S);
	let listed: Awaited<ReturnType<typeof listAll>>;
	try {
		listed = await listAll(bucket as unknown as Listing, root, pagesOf(env as Env & BreakdownEnv));
	} catch (error) {
		return fail(503, "unavailable", `The storage could not be listed just now (${error instanceof Error ? error.message : String(error)}); try again in a minute.`);
	}
	const names = await namesOf(bucket, root, listed.items);
	const now = deps.now();
	const answer = breakdownOf(listed.items, names, now);
	const quota = quotaOf(env, owner);
	return json(200, {
		owner,
		measured_at: new Date(now).toISOString(),
		used: answer.used,
		quota: { bytes: quota.bytes, objects: quota.objects },
		// a cut listing is a lower bound: it can say over, never under
		over: overQuota(answer.used, quota),
		partial: !listed.complete,
		kinds: answer.kinds,
		projects: answer.projects,
		folders: answer.folders,
		files: answer.files,
		suggestions: answer.suggestions,
	});
}
