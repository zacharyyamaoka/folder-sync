// The sync view's data API online (PEP 0007 §5.2, docs/API.md): what <folder-sync-status> reads from every app's own
// /fs/ mount. `…` is /fs/v1/folders/:project.
//
//   GET  …/status                       the folder's state for its owner; readers and the public get state and devices
//   GET  …/activity?before=&limit=&level=&host=   every host's published changes and pulls, newest first (activity.ts)
//   GET  …/history/:host/<path>[?version=<id>]    a file's kept versions, or one version's bytes
//   GET  …/deleted[?host=]              paths with a kept version and no live entry
//   POST …/restore                      the web host's items at once, a machine's as a restore request (requests.ts)
//   POST …/history/purge                history deleted for good: one version, or older than N days
//   GET  /fs/ui/v1/<file>               the element's own files, served from the Worker's assets
//
// Every answer, success or error, has the shape testdata/view-api/ pins; history, activity, deleted files, restore and
// purge are the owner's only (WHY, PEP 0007 §5.2: a public folder's history would publish what its owner deleted on
// purpose), and a reader or the public gets the same 404 as an unknown folder. Every key read here is under the
// owner's own root, with a credential R2 scopes to it.

import { createHash } from "node:crypto";
import type { App } from "./apps.ts";
import { ACTIVE, bucketFor, csrfOk, decide, fail, headers, json, READ_TTL_S, session, settledFirst, stillSignedIn, TYPES, usageFigure, webHostOf, type Deps, type Env, type Person, type Via } from "./app.ts";
import { activity } from "./activity.ts";
import { userRoot } from "./creds.ts";
import { deviceOf } from "./devices.ts";
import { anchorOf, historyPath, historyPrefix, KEEP_DAYS, listedObject, parseName, parsePrefixBody, parseVersion, preferred, readOrder, type ListedObject } from "./history.ts";
import { RESTORE, waitingRequests, writeRequest, type RestoreRequest } from "./requests.ts";
import { Project, type Manifest } from "../../readers/worker/src/folder-sync-read.ts";
import type { S3Bucket } from "./s3-bucket.ts";
import { decompress } from "./vendor/fzstd.js";

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** docs/API.md: a POST body over this is 413 too_large. */
const BODY_MAX = 256 * 1024;
const ITEMS_MAX = 1000;
/** A file's versions listed at most (docs/API.md "history": `more` past it). */
const VERSIONS_MAX = 1000;
/** One host's history listed at most for deleted files (docs/API.md "deleted": `more` past it). */
const DELETED_LISTING_MAX = 10_000;
const DAY_MS = 24 * 3600_000;
/** The most bytes the Worker holds to open a version it has to decode or check (a keyframe, a pointer): a Worker has 128 MB
 *  and no streaming zstd or SHA-256 to check as it goes (PEP 0009 §4.3). A bigger one is restored from a machine. */
const CHECKED_MAX = 32 * 1024 * 1024;
const UI_TYPES: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

const notFound = () => fail(404, "not_found", "No such folder.");

type Who = { person: Person; via: Via };

/** The owner, or the answer refusing everyone else (docs/API.md "Auth"): signed out is 401, unless the request names
 *  an owner (?owner=), which only ever reads as "the public asking": 404, as for a reader or an unknown folder. */
async function owner(request: Request, deps: Deps, app: App | null, signedOut: string): Promise<Who | Response> {
	const who = await session(request, deps, app);
	const named = new URL(request.url).searchParams.get("owner");
	if (!who) return named ? notFound() : fail(401, "signed_out", signedOut);
	// fs-mutation: owner only. WHY the session's id, never the request's: ?owner= of someone else is a reader asking
	if (named !== null && named !== who.person.userId) return notFound();
	return who;
}

/** An owner's write from a page (docs/API.md "Auth"): X-Folder-Sync: 1 and its own origin, and the user it shows. */
async function ownerWrite(request: Request, deps: Deps, app: App | null): Promise<Who | Response> {
	const who = await owner(request, deps, app, "Sign in to change this folder's history.");
	if (who instanceof Response) return who;
	if (who.via === "cookie" && !csrfOk(request, app)) return fail(403, "csrf", "A write from a page must send X-Folder-Sync: 1 from this origin.");
	if (who.via === "cookie" && request.headers.get("X-Folder-Sync-User") !== who.person.userId) {
		return fail(409, "wrong_user", "this page is signed in as someone else (or does not say who): reload it");
	}
	return who;
}

/** The POST body as one JSON object, or the answer refusing it (415, 413, 400). */
async function body(request: Request): Promise<Record<string, unknown> | Response> {
	if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) return fail(415, "json_only", "Send the body as JSON (Content-Type: application/json).");
	if (Number(request.headers.get("Content-Length") || 0) > BODY_MAX) return fail(413, "too_large", "A body is at most 256 KiB.");
	const raw = await request.arrayBuffer();
	if (raw.byteLength > BODY_MAX) return fail(413, "too_large", "A body is at most 256 KiB.");
	try {
		const doc = JSON.parse(new TextDecoder().decode(raw));
		if (doc && typeof doc === "object" && !Array.isArray(doc)) return doc as Record<string, unknown>;
	} catch {
		// below
	}
	return fail(400, "bad_request", "The body is not one JSON object.");
}

/** The owner's root, read-only (or read-write for a restore request): every key here is under it. */
function rootBucket(env: Env, deps: Deps, ownerId: string, scope: "object-read-only" | "object-read-write" = "object-read-only"): Promise<S3Bucket> {
	return bucketFor(env, deps, userRoot(ownerId, env), scope, READ_TTL_S);
}

interface HostInfo {
	id: string;
	manifest: Manifest | null;
}

/** Every host of the folder that publishes a manifest, after the web host has settled (a read never sees a cut-off
 *  change: review r2 #2). */
async function hostsOf(env: Env, deps: Deps, bucket: S3Bucket, ownerId: string, project: string): Promise<HostInfo[] | Response> {
	const unsettled = await settledFirst(env, deps, ownerId, project);
	if (unsettled) return unsettled;
	const reader = new Project(bucket, project, userRoot(ownerId, env));
	const out: HostInfo[] = [];
	for (const id of await reader.hosts()) out.push({ id, manifest: await reader.manifest(id) });
	return out;
}

/** "6 days ago", "3 hours ago", "just now". */
function ago(ms: number): string {
	const say = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
	if (ms < 60_000) return "just now";
	if (ms < 3600_000) return say(Math.floor(ms / 60_000), "minute");
	if (ms < DAY_MS) return say(Math.floor(ms / 3600_000), "hour");
	return say(Math.floor(ms / DAY_MS), "day");
}

// ------------------------------------------------------------------------------------------------ status

/** GET …/status: one headline state; the owner also gets warnings (each saying what to do), the restore requests no
 *  host has answered, and storage. Online, a device is only what its manifest says (seq, last change). */
export async function status(request: Request, env: Env, deps: Deps, app: App | null, project: string): Promise<Response> {
	const who = await session(request, deps, app);
	const decided = await decide(deps, who?.person ?? null, project, new URL(request.url).searchParams.get("owner"));
	if (decided instanceof Response) return decided.status === 404 ? notFound() : decided;
	const isOwner = decided.role === "owner";
	// WHY a folder-scoped key for a reader's or the public's status: they see only what its manifests say
	const bucket = isOwner ? await rootBucket(env, deps, decided.owner) : await bucketFor(env, deps, `${userRoot(decided.owner, env)}${project}/`, "object-read-only", READ_TTL_S);
	const hosts = await hostsOf(env, deps, bucket, decided.owner, project);
	if (hosts instanceof Response) return hosts;
	const web = await deps.store.webHost(decided.owner, project);
	const devices = hosts.filter((h) => h.manifest).map(({ id, manifest }) => ({ id, name: manifest!.host_name, kind: id === web ? "web" : "machine", seq: manifest!.seq, last_change: manifest!.generated_at || null }));
	// newest change first
	devices.sort((a, b) => (a.last_change ?? "") < (b.last_change ?? "") ? 1 : (a.last_change ?? "") > (b.last_change ?? "") ? -1 : a.id < b.id ? -1 : 1);
	const base = { project, owner: isOwner ? { id: decided.owner, email: who!.person.email } : { id: decided.owner } };
	if (!isOwner) {
		const state = devices.length ? "synced" : "unknown";
		return json(200, { ...base, role: decided.role, state, headline: devices.length ? "Synced" : "Nothing synced yet", devices }, { "Cache-Control": "private, no-store" });
	}
	const names = new Map(devices.map((d) => [d.id, d]));
	const waiting = (await waitingRequests(bucket, userRoot(decided.owner, env), project)).map((r) => ({ request: r.id, host: r.host, host_name: names.get(r.host)?.name ?? "", at: r.at, items: r.items.length }));
	const warnings: Record<string, unknown>[] = [];
	const storage = await usageFigure(env, deps, decided.owner);
	if (storage?.over) {
		const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
		warnings.push({ kind: "over_quota", level: "warn", text: `Storage is full and sync has stopped: history uses ${mb(storage.history.bytes)}. Free up space to sync again.` });
	}
	const perHost = new Map<string, number>();
	for (const w of waiting) perHost.set(w.host, (perHost.get(w.host) ?? 0) + w.items);
	for (const [host, count] of perHost) {
		const device = names.get(host);
		const seen = device?.last_change ? ` (last seen ${ago(deps.now() - Date.parse(device.last_change))})` : "";
		warnings.push({ kind: "waiting_restore", level: "warn", text: `${count} file${count === 1 ? " waits" : "s wait"} for ${device?.name || "a device"}${seen}. Download ${count === 1 ? "it" : "them"} to have ${count === 1 ? "it" : "them"} now.`, host, count });
	}
	const state = warnings.some((w) => w.level === "error") ? "error" : warnings.length ? "attention" : devices.length ? "synced" : "unknown";
	const headline = warnings.length ? `${warnings.length} thing${warnings.length === 1 ? " needs" : "s need"} you` : devices.length ? "Synced" : "Nothing synced yet";
	await touch(env, deps, decided.owner, project);
	return json(200, { ...base, role: "owner", state, headline, devices, warnings, waiting, storage }, { "Cache-Control": "private, no-store" });
}

/** Wakes the folder's object, whose alarm prunes it daily (PEP 0007 §3.2: any request that touches the folder). */
async function touch(env: Env, deps: Deps, ownerId: string, project: string): Promise<void> {
	// best effort, and never awaited: the next request wakes it
	const work = webHostOf(env, deps)({ method: "TOUCH", owner: ownerId, project, hostId: "", path: "" }).then(() => undefined, () => undefined);
	if (deps.waitUntil) deps.waitUntil(work);
}

// ------------------------------------------------------------------------------------------------ activity

/** GET …/activity: newest first, `limit` 1-500 (200), `level` warn | error, `host`, `before` (the last page's next). */
export async function activityRoute(request: Request, env: Env, deps: Deps, app: App | null, project: string): Promise<Response> {
	const who = await owner(request, deps, app, "Sign in to see this folder's activity.");
	if (who instanceof Response) return who;
	const query = new URL(request.url).searchParams;
	const limit = query.has("limit") ? Number(query.get("limit")) : 200;
	if (!Number.isInteger(limit) || limit < 1 || limit > 500) return fail(400, "bad_request", "limit is a whole number from 1 to 500.");
	const level = query.get("level");
	if (level !== null && level !== "warn" && level !== "error") return fail(400, "bad_request", "level is warn or error.");
	const host = query.get("host");
	if (host !== null && !HOST_ID.test(host)) return fail(400, "bad_host", "A host is its lowercase UUID.");
	const ownerId = who.person.userId;
	const bucket = await rootBucket(env, deps, ownerId);
	const hosts = await hostsOf(env, deps, bucket, ownerId, project);
	if (hosts instanceof Response) return hosts;
	// hosts with records but no manifest (a machine that only pulls): one delimiter listing of the folder's records
	const known = new Map(hosts.filter((h) => h.manifest).map((h) => [h.id, { id: h.id, name: h.manifest!.host_name, seq: h.manifest!.seq }]));
	const root = userRoot(ownerId, env);
	let cursor: string | undefined;
	do {
		const page = await bucket.objects(`${root}_changes/${project}/`, { delimiter: "/", cursor });
		for (const prefix of page.prefixes) {
			const id = prefix.slice(`${root}_changes/${project}/`.length).replace(/\/$/, "");
			if (HOST_ID.test(id) && !known.has(id)) known.set(id, { id, name: "", seq: 0 });
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	const answer = await activity(bucket, root, project, [...known.values()], { limit, level: level as "warn" | "error" | null, host, before: query.get("before") });
	if (!answer) return fail(400, "bad_request", "before is the next of an earlier page.");
	await touch(env, deps, ownerId, project);
	return json(200, answer, { "Cache-Control": "private, no-store" });
}

// ------------------------------------------------------------------------------------------------ history

/** A kept version as history lists it (schema kept_version). */
function keptVersion(id: string, leftAt: number, size: number): Record<string, unknown> {
	const v = parseVersion(id)!;
	return v.unlisted ? { id, unlisted: true, left_at: new Date(leftAt).toISOString(), size } : { id, written_at: v.written_at, sha16: v.sha16, left_at: new Date(leftAt).toISOString(), size };
}

/** Every object directly under `prefix` (a delimiter listing: deeper paths are prefixes, never versions), in any form. */
async function objectsUnder(bucket: S3Bucket, prefix: string, cap: number): Promise<{ objects: ListedObject[]; more: boolean }> {
	const objects: ListedObject[] = [];
	let cursor: string | undefined;
	let pages = 0;
	let more = false;
	do {
		const page = await bucket.objects(prefix, { delimiter: "/", cursor });
		for (const o of page.objects) {
			const listed = listedObject(prefix, o);
			if (listed) objects.push(listed);
		}
		cursor = page.truncated ? page.cursor : undefined;
		if (cursor && ++pages >= Math.ceil(cap / 1000) + 50) {
			more = true;
			break;
		}
	} while (cursor);
	return { objects, more };
}

/** One version per id with its own size, whatever form it is stored in. */
async function versionsUnder(bucket: S3Bucket, prefix: string, cap: number): Promise<{ versions: { id: string; left_at: number; size: number }[]; more: boolean }> {
	const { objects, more } = await objectsUnder(bucket, prefix, cap);
	return { versions: preferred(objects).map((o) => ({ id: o.id, left_at: o.left_at, size: o.size })), more };
}

const newestFirst = (a: { id: string; left_at: number }, b: { id: string; left_at: number }) => b.left_at - a.left_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** GET …/history/:host/<path>: the live entry and every kept version, newest first; with ?version=, its bytes. */
export async function history(request: Request, env: Env, deps: Deps, app: App | null, project: string, host: string, rest: string[], head: boolean): Promise<Response> {
	const who = await owner(request, deps, app, "Sign in to see this folder's history.");
	if (who instanceof Response) return who;
	if (!HOST_ID.test(host)) return fail(400, "bad_host", "A host is its lowercase UUID.");
	const path = rest.length && !rest.includes("") ? rest.join("/") : "";
	if (!path || !historyPath(path)) return fail(400, "bad_path", "A file's path follows the contract's path rules.");
	const query = new URL(request.url).searchParams;
	const version = query.get("version");
	if (version !== null && !parseVersion(version)) return fail(400, "bad_version", "A version is <written_at>_<sha16>, as the history lists it.");
	const ownerId = who.person.userId;
	const root = userRoot(ownerId, env);
	const bucket = await rootBucket(env, deps, ownerId);
	if (version !== null) return versionBytes(bucket, root, project, host, path, version, deps.now(), head);
	const hosts = await hostsOf(env, deps, bucket, ownerId, project);
	if (hosts instanceof Response) return hosts;
	const manifest = hosts.find((h) => h.id === host)?.manifest ?? null;
	const { versions, more: listedMore } = await versionsUnder(bucket, historyPrefix(root, project, host, path), VERSIONS_MAX);
	const entry = manifest?.files.find((e) => e.path === path) ?? null;
	if (!entry && !versions.length) return fail(404, "not_found", "That host has no such file, now or in its history.");
	versions.sort(newestFirst);
	await touch(env, deps, ownerId, project);
	return json(200, {
		host, host_name: manifest?.host_name ?? "", path,
		live: entry ? { size: entry.size, sha256: entry.sha256, written_at: entry.written_at } : null,
		versions: versions.slice(0, VERSIONS_MAX).map((v) => keptVersion(v.id, v.left_at, v.size)),
		more: listedMore || versions.length > VERSIONS_MAX,
	}, { "Cache-Control": "private, no-store" });
}

/** One version's bytes (Download), typed by suffix as the files route is: never this site's page. A whole copy is
 *  streamed; a keyframe is decoded (fzstd) and a pointer is read from what it rests on, each checked against the
 *  version's name before a byte is sent (PEP 0009 §4.3). */
async function versionBytes(bucket: S3Bucket, root: string, project: string, host: string, path: string, version: string, now: number, head: boolean): Promise<Response> {
	const prefix = historyPrefix(root, project, host, path);
	const gone = () => {
		const at = Date.parse(version.slice(0, version.lastIndexOf("_")));
		return fail(410, "pruned", now - at >= KEEP_DAYS * DAY_MS ? "That version is older than 30 days and is gone." : "That version was thinned out of the history and is gone.");
	};
	const { objects } = await objectsUnder(bucket, prefix, VERSIONS_MAX);
	const forms = readOrder(objects.filter((o) => o.id === version));
	if (!forms.length) return gone();
	const form = forms[0];
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	const suffix = dot > 0 ? name.slice(dot).toLowerCase() : "";
	const out: Record<string, string> = { "Content-Type": TYPES[suffix] || "application/octet-stream", "Cache-Control": "private, no-store", "X-Folder-Sync-Version": version, "Content-Length": String(form.size) };
	// WHY sandboxed: an old .html or .svg is someone's file, never this site's page
	if (ACTIVE.has(suffix)) out["Content-Security-Policy"] = "sandbox";
	if (form.kind === "full") {
		const seen = await bucket.head(form.key);
		if (!seen) return gone();
		out["Content-Length"] = String(seen.size);
		if (head || seen.size === 0) return new Response(null, { status: 200, headers: headers(out) });
		const ranged = await bucket.getRange(form.key, 0, seen.size, seen.etag || undefined);
		if (!ranged) return fail(410, "pruned", "That version is gone.");
		return new Response(ranged.body, { status: 200, headers: headers(out) });
	}
	if (head) return new Response(null, { status: 200, headers: headers(out) });
	if (form.size > CHECKED_MAX) return fail(413, "too_large", "That version is too large to open in the browser (over 32 MiB); restore it from a machine, which checks it.");
	const opened = await openStored(bucket, root, project, host, path, form, objects);
	if (opened === "gone") return gone();
	if (opened === "too_large") return fail(413, "too_large", "That version is too large to open in the browser (over 32 MiB); restore it from a machine, which checks it.");
	if (opened === "corrupt") return fail(502, "corrupt", "The stored bytes are not that version's: something outside folder-sync changed the history.");
	return new Response(opened, { status: 200, headers: headers(out) });
}

const sha256Hex = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** A keyframe's or a pointer's bytes, checked: the version's own bytes, or why not. */
async function openStored(bucket: S3Bucket, root: string, project: string, host: string, path: string, form: ListedObject, all: ListedObject[]): Promise<Uint8Array | "gone" | "too_large" | "corrupt"> {
	const sha16 = parseVersion(form.id)?.sha16 ?? "";
	const decode = async (zst: ListedObject, limit: number): Promise<Uint8Array | "gone" | "too_large" | "corrupt"> => {
		if (zst.stored > CHECKED_MAX || zst.size > CHECKED_MAX) return "too_large";
		const got = await bucket.getBounded(zst.key, zst.stored);
		if (!got) return "gone";
		try {
			const plain = decompress(new Uint8Array(got.data));
			return plain.byteLength === zst.size ? plain.subarray(0, limit) : "corrupt";
		} catch {
			return "corrupt";
		}
	};
	if (form.kind === "zst") {
		const plain = await decode(form, form.size);
		if (typeof plain === "string") return plain;
		return sha256Hex(plain).startsWith(sha16) ? plain : "corrupt";
	}
	const object = await bucket.get(form.key);
	if (!object || !("arrayBuffer" in object)) return "gone";
	const body = parsePrefixBody(new TextDecoder().decode(await object.arrayBuffer()));
	if (!body || body.size !== form.size || !body.sha256.startsWith(sha16)) return "corrupt";
	const anchor = anchorOf(all, form.id);
	let bytes: Uint8Array | "gone" | "too_large" | "corrupt";
	if (!anchor) {
		// the live file: read with its manifest's object_etag when it has one, so a file rewritten since is noticed
		const etag = await liveETag(bucket, root, project, host, path);
		bytes = await rangeOf(bucket, `${root}${project}/hosts/${host}/${path}`, body.size, etag);
		if (bytes === "gone" && etag) bytes = await rangeOf(bucket, `${root}${project}/hosts/${host}/${path}`, body.size, undefined);
	} else if (anchor.kind === "zst") bytes = await decode(anchor, body.size);
	else bytes = await rangeOf(bucket, anchor.key, body.size, undefined);
	if (typeof bytes === "string") return bytes;
	return sha256Hex(bytes) === body.sha256 ? bytes : "corrupt";
}

/** The first `size` bytes of `key`, read whole into one buffer; "gone" when there is no such object (or another version). */
async function rangeOf(bucket: S3Bucket, key: string, size: number, ifMatch: string | undefined): Promise<Uint8Array | "gone" | "corrupt"> {
	const ranged = await bucket.getRange(key, 0, size, ifMatch);
	if (!ranged || !ranged.body) return "gone";
	const data = new Uint8Array(await new Response(ranged.body).arrayBuffer());
	return data.byteLength === size ? data : "corrupt";
}

/** The object_etag a host's manifest lists for `path`, or undefined. */
async function liveETag(bucket: S3Bucket, root: string, project: string, host: string, path: string): Promise<string | undefined> {
	try {
		const got = await bucket.get(`${root}${project}/hosts/${host}/manifest.json`);
		if (!got || !("arrayBuffer" in got)) return undefined;
		const doc = JSON.parse(new TextDecoder().decode(await got.arrayBuffer())) as { files?: { path?: string; object_etag?: string }[] };
		const etag = doc.files?.find((e) => e.path === path)?.object_etag;
		return typeof etag === "string" && /^[0-9A-Za-z-]{1,128}$/.test(etag) ? etag : undefined;
	} catch {
		return undefined;
	}
}

// ------------------------------------------------------------------------------------------------ deleted

/** GET …/deleted[?host=]: every path with a kept version and no live manifest entry, newest deletion first, each with
 *  the version to restore (its newest). One listing per host. */
export async function deleted(request: Request, env: Env, deps: Deps, app: App | null, project: string): Promise<Response> {
	const who = await owner(request, deps, app, "Sign in to see this folder's deleted files.");
	if (who instanceof Response) return who;
	const only = new URL(request.url).searchParams.get("host");
	if (only !== null && !HOST_ID.test(only)) return fail(400, "bad_host", "A host is its lowercase UUID.");
	const ownerId = who.person.userId;
	const root = userRoot(ownerId, env);
	const bucket = await rootBucket(env, deps, ownerId);
	const hosts = await hostsOf(env, deps, bucket, ownerId, project);
	if (hosts instanceof Response) return hosts;
	const manifests = new Map(hosts.map((h) => [h.id, h.manifest]));
	// the hosts with history: a delimiter listing of the folder's history
	const ids = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await bucket.objects(historyPrefix(root, project), { delimiter: "/", cursor });
		for (const prefix of page.prefixes) {
			const id = prefix.slice(historyPrefix(root, project).length).replace(/\/$/, "");
			if (HOST_ID.test(id)) ids.add(id);
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	const files: Record<string, unknown>[] = [];
	let more = false;
	for (const host of [...ids].sort()) {
		if (only && host !== only) continue;
		const manifest = manifests.get(host) ?? null;
		const live = new Set(manifest?.files.map((e) => e.path) ?? []);
		const prefix = historyPrefix(root, project, host);
		const newest = new Map<string, { id: string; left_at: number; size: number }>();
		let listing: string | undefined;
		let seen = 0;
		do {
			const page = await bucket.objects(prefix, { cursor: listing });
			for (const o of page.objects) {
				const cut = o.key.lastIndexOf("/");
				const name = parseName(o.key.slice(cut + 1));
				const path = o.key.slice(prefix.length, cut);
				if (!name || !historyPath(path) || live.has(path)) continue;
				const v = { id: name.id, left_at: o.lastModified, size: name.size ?? o.size };
				const best = newest.get(path);
				if (!best || newestFirst(v, best) < 0) newest.set(path, v);
			}
			seen += page.objects.length;
			listing = page.truncated ? page.cursor : undefined;
			if (listing && seen >= DELETED_LISTING_MAX) {
				more = true;
				break;
			}
		} while (listing);
		for (const [path, v] of newest) files.push({ host, host_name: manifest?.host_name ?? "", path, deleted_at: new Date(v.left_at).toISOString(), size: v.size, version: v.id });
	}
	files.sort((a, b) => (a.deleted_at as string) < (b.deleted_at as string) ? 1 : (a.deleted_at as string) > (b.deleted_at as string) ? -1 : (a.path as string) < (b.path as string) ? -1 : 1);
	await touch(env, deps, ownerId, project);
	return json(200, { files, more }, { "Cache-Control": "private, no-store" });
}

// ------------------------------------------------------------------------------------------------ restore

type Failed = { host: string; path: string; version: string; error: "pruned" | "mismatch" | "not_found" | "over_quota" | "failed" };

/** Who a restore request says asked: a browser by its User-Agent's name (as /fs/v1/devices names it), a machine by
 *  its host name. */
function askedBy(request: Request, via: Via): RestoreRequest["by"] {
	const device = deviceOf({ id: "", userAgent: request.headers.get("User-Agent"), createdAt: new Date(0), updatedAt: new Date(0) }, "");
	if (via === "bearer" && device.kind === "machine") return { kind: "machine", name: device.name ?? "a machine" };
	return { kind: "web", name: device.name ?? "a browser" };
}

/** The browser's name for a change record's `via`, or undefined for anything else. */
export function browserOf(request: Request, via: Via): string | undefined {
	if (via !== "cookie") return undefined;
	const by = askedBy(request, via);
	return by.name;
}

/** POST …/restore: up to 1,000 {host, path, version} items. The web host's are written now as new versions by the
 *  folder's object (applied); each other host gets one restore request in the bucket, which it applies when it next
 *  syncs (requested); what is refused before anything is written is failed. */
export async function restore(request: Request, env: Env, deps: Deps, app: App | null, project: string): Promise<Response> {
	const who = await ownerWrite(request, deps, app);
	if (who instanceof Response) return who;
	const doc = await body(request);
	if (doc instanceof Response) return doc;
	const items = doc.items;
	if (!Array.isArray(items) || !items.length || Object.keys(doc).some((k) => k !== "items")) return fail(400, "bad_request", "The body is { items: [{ host, path, version }] }.");
	if (items.length > ITEMS_MAX) return fail(413, "too_large", "A restore takes at most 1,000 items.");
	for (const item of items) {
		if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((k) => k !== "host" && k !== "path" && k !== "version")) return fail(400, "bad_request", "Each item is { host, path, version }.");
		if (typeof item.host !== "string" || !HOST_ID.test(item.host)) return fail(400, "bad_host", "A host is its lowercase UUID.");
		if (typeof item.path !== "string" || !historyPath(item.path)) return fail(400, "bad_path", "A file's path follows the contract's path rules.");
		if (typeof item.version !== "string" || !parseVersion(item.version)) return fail(400, "bad_version", "A version is <written_at>_<sha16>, as the history lists it.");
	}
	const ownerId = who.person.userId;
	const root = userRoot(ownerId, env);
	// WHY again after the body: a device revoked while it sent this writes nothing (judge r2 #5)
	if (!(await stillSignedIn(deps, who.person))) return fail(401, "signed_out", "This device was signed out before its restore could start.");
	const reading = await rootBucket(env, deps, ownerId);
	const hosts = await hostsOf(env, deps, reading, ownerId, project);
	if (hosts instanceof Response) return hosts;
	const manifests = new Map(hosts.map((h) => [h.id, h.manifest]));
	const web = await deps.store.webHost(ownerId, project);
	const shared = await deps.store.sharedTree(ownerId, project);
	const byHost = new Map<string, { path: string; version: string }[]>();
	for (const { host, path, version } of items as { host: string; path: string; version: string }[]) byHost.set(host, [...(byHost.get(host) ?? []), { path, version }]);
	const applied: { host: string; path: string; version: string; seq: number }[] = [];
	const requested: Record<string, unknown>[] = [];
	const failed: Failed[] = [];
	const via = browserOf(request, who.via);
	for (const [host, list] of byHost) {
		// WHY the shared tree too (PEP 0010): its writer is the folder's object, so no machine could answer a request
		if (host === web || host === shared) {
			const answer = await webHostOf(env, deps)({ method: host === shared ? "SHARED_RESTORE" : "RESTORE", owner: ownerId, project, hostId: host, path: "", items: list, sessionId: who.person.sessionId, via });
			if (answer.status !== 200) {
				if (answer.status === 401 || answer.status === 503) return json(answer.status, answer.body, answer.headers ?? {});
				for (const { path, version } of list) failed.push({ host, path, version, error: "failed" });
				continue;
			}
			const done = answer.body as { applied: typeof applied; failed: Failed[] };
			applied.push(...done.applied);
			failed.push(...done.failed);
			continue;
		}
		const manifest = manifests.get(host);
		if (!manifest) {
			for (const { path, version } of list) failed.push({ host, path, version, error: "not_found" });
			continue;
		}
		const id = deps.uuid();
		const asked: RestoreRequest = { schema: RESTORE, id, project, host, at: new Date(deps.now()).toISOString(), by: askedBy(request, who.via), items: list };
		const writing = await rootBucket(env, deps, ownerId, "object-read-write");
		let written = false;
		try {
			written = await writeRequest(writing, root, asked);
		} catch {
			written = false;
		}
		if (!written) {
			for (const { path, version } of list) failed.push({ host, path, version, error: "failed" });
			continue;
		}
		requested.push({ host, host_name: manifest.host_name, request: id, items: list.length, where: "bucket" });
	}
	// in the order they were asked for
	const order = new Map((items as { host: string; path: string; version: string }[]).map((it, i) => [`${it.host}\u0000${it.path}\u0000${it.version}`, i]));
	const rank = (x: { host: string; path: string; version: string }) => order.get(`${x.host}\u0000${x.path}\u0000${x.version}`) ?? 0;
	applied.sort((a, b) => rank(a) - rank(b));
	failed.sort((a, b) => rank(a) - rank(b));
	return json(200, { applied, requested, failed }, { "Cache-Control": "private, no-store" });
}

// ------------------------------------------------------------------------------------------------ purge

/** POST …/history/purge: one version ({host, path, version}: "I synced a secret") or everything older than
 *  `older_than_days` (0-30, optionally one host and path: "Free up space"); up to 1,000 objects a call. */
export async function purge(request: Request, env: Env, deps: Deps, app: App | null, project: string): Promise<Response> {
	const who = await ownerWrite(request, deps, app);
	if (who instanceof Response) return who;
	const doc = await body(request);
	if (doc instanceof Response) return doc;
	const keys = Object.keys(doc);
	if (keys.some((k) => !["older_than_days", "host", "path", "version"].includes(k))) return fail(400, "bad_request", "The body is { older_than_days } or { host, path, version }.");
	const { older_than_days: days, host, path, version } = doc as { older_than_days?: unknown; host?: unknown; path?: unknown; version?: unknown };
	if (host !== undefined && (typeof host !== "string" || !HOST_ID.test(host))) return fail(400, "bad_host", "A host is its lowercase UUID.");
	if (path !== undefined && (typeof path !== "string" || !historyPath(path))) return fail(400, "bad_path", "A file's path follows the contract's path rules.");
	if (version !== undefined && (typeof version !== "string" || !parseVersion(version))) return fail(400, "bad_version", "A version is <written_at>_<sha16>, as the history lists it.");
	const one = version !== undefined && host !== undefined && path !== undefined && days === undefined;
	const older = days !== undefined && version === undefined && Number.isInteger(days) && (days as number) >= 0 && (days as number) <= 30 && (path === undefined || host !== undefined);
	if (!one && !older) return fail(400, "bad_request", "Purge one version ({ host, path, version }) or what is older than older_than_days (0 to 30).");
	const ownerId = who.person.userId;
	if (!(await stillSignedIn(deps, who.person))) return fail(401, "signed_out", "This device was signed out before its purge could start.");
	const web = (await deps.store.webHost(ownerId, project)) ?? (await deps.store.sharedTree(ownerId, project));
	const answer = await webHostOf(env, deps)({
		method: "PURGE_HISTORY", owner: ownerId, project, hostId: web ?? "", path: "", sessionId: who.person.sessionId,
		purge: one ? { host: host as string, path: path as string, version: version as string } : { olderThanDays: days as number, host: host as string | undefined, path: path as string | undefined },
	});
	return json(answer.status, answer.body, { "Cache-Control": "private, no-store", ...(answer.headers ?? {}) });
}

// ------------------------------------------------------------------------------------------------ the element

/** GET /fs/ui/v1/<file>: <folder-sync-status>'s files, from the Worker's assets (accounts/site/ui/v1/, a link to the
 *  repository's ui/v1/, which wrangler follows), on every app's own origin, so the element only ever calls the origin
 *  it is on. */
export async function ui(env: Env, rest: string[], head: boolean): Promise<Response> {
	if (rest[0] !== "v1" || rest.length < 2 || rest.includes("")) return fail(404, "not_found", "No such file.");
	const name = rest[rest.length - 1];
	const dot = name.lastIndexOf(".");
	const type = dot > 0 ? UI_TYPES[name.slice(dot).toLowerCase()] : undefined;
	if (!type || !env.ASSETS) return fail(404, "not_found", "No such file.");
	const answer = await env.ASSETS.fetch(new Request(new URL(`/ui/${rest.map(encodeURIComponent).join("/")}`, "https://assets.invalid/")));
	if (!answer.ok) return fail(404, "not_found", "No such file.");
	// WHY no-cache: /fs/ui/v1/ takes fixes, and every page should get them on its next load
	return new Response(head ? null : answer.body, { status: 200, headers: headers({ "Content-Type": type, "Cache-Control": "no-cache" }) });
}
