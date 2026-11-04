// folder-sync's accounts Worker (PEP 0003): one account across Zach's apps, mounted at /fs/ on each app's own domain
// (the app's Worker forwards /fs/* here through a service binding) and on this Worker's own host for the CLI.
//
//   *    /fs/api/auth/*                           Better Auth: Google sign-in, sessions, the device grant, sign-out
//   GET  /fs/signin?return=<path>                 the sign-in page; back to <path> signed in
//   GET  /fs/device[?user_code=…]                 approve a machine that ran `folder-sync login` (RFC 8628)
//   GET  /fs/handoff?to=<url>                     a listed loopback channel's sign-in (§3.10); then /fs/handoff/redeem
//   GET  /fs/dev/mailbox?email=                   dev + loopback only: the last sign-in code
//   GET  /fs/v1/me                                the session's person, root and app
//   GET  /fs/v1/usage                             the session's storage, its quota, and whether it is over
//   GET  /fs/v1/usage/breakdown                   what is in it: by project, kind and device, the biggest, what to free (storage.ts)
//   GET  /fs/v1/devices, POST …/devices/revoke    the person's sessions (machines, browsers); revoke one (devices.ts)
//   GET  /fs/account, POST …/revoke | …/sign-out  the account page, no script (devices.ts)
//   GET  /fs/files[?project=]                     the Files page: browse, open, upload, rename and delete (files-page.ts)
//   POST /fs/v1/sign-out                          ends this session
//   GET  /fs/v1/folders                           my folders and the ones I may read
//   GET  /fs/v1/folders/:project[?owner=]         the union view of a folder's hosts
//   GET  /fs/v1/folders/:project/bundle?prefix=   a folder's small UTF-8 files in one answer
//   GET  /fs/v1/folders/:project/files/:host/<p>  one file's bytes, sha256-checked; Range: one range -> 206 (ranges.ts)
//   PUT|DELETE /fs/v1/folders/:project/web/<p>    the folder's web host (§3.4); X-Folder-Sync-Keep-Newest: <field>
//   POST /fs/v1/folders/:project/share {private}   the owner opts the folder into a shared tree (PEP 0010); idempotent
//   POST /fs/v1/folders/:project/shared {changes}  a device's commit to the shared tree: accepted, merged, conflict or edit_won per path
//   PUT|DELETE /fs/v1/folders/:project/shared/<p>  a page's write to the shared tree; X-Folder-Sync-Base: <version>, X-Folder-Sync-Merge: never
//   GET  /fs/v1/folders/:project/events           WebSocket upgrade: the folder's hub says "host H is at seq N" (PEP 0005)
//   PATCH /fs/v1/folders/:project {visibility}    public or private
//   POST /fs/v1/folders/:project/readers {email}, DELETE …/readers/:email
//   GET  /fs/v1/access?project=&owner=            for an app's own server
//   POST /fs/v1/credentials                       a machine's bearer session -> R2 keys for users/<id>/ (5 min);
//                                                 over quota: read-only, with ReadOnly and Reason
//   POST /fs/v1/folders/:project/hosts/:host/delete  a machine's deletes while its keys are read-only (bearer)
//   GET  /fs/v1/folders/:project/{status,activity,deleted}, GET …/history/:host/<p>[?version=],
//   POST …/restore, POST …/history/purge          the sync view's data API (PEP 0007, docs/API.md; view.ts)
//   GET  /fs/ui/v1/<file>                         <folder-sync-status>'s files (view.ts ui)
//
// The table in PEP 0003 §3.3 is the contract (another app builds against it); errors are
// { "error": "<code>", "why": "<sentence>" }.
//
// WHY the separation is R2's: each person's files live under users/<their account id>/ in the one bucket, and every
// key this Worker hands out or uses is a temporary credential R2 itself scopes to one person's root or folder. The
// root is only ever the session's (or, for a read, the owner's once access is decided), never a URL's, body's or
// header's.
//
// This file imports no npm module: Better Auth lives behind `Deps` (auth.ts), so the unit tests run on bare Node.

import { appFor, apps, OWN_APP, type App } from "./apps.ts";
import { folderPrefix, mint, NotConfigured, PROJECT, ttlOf, USER_ID, userRoot, type CredsEnv } from "./creds.ts";
import { checkPath, ContractError, Project, SCHEMA, validateManifest, type Manifest, type ManifestEntry } from "../../readers/worker/src/folder-sync-read.ts";
import { Measuring, overQuota, quotaFor, TooOld, usageOf, type QuotaEnv } from "./quota.ts";
import { featureOff, featuresOf, type FeatureEnv } from "./features.ts";
import type { PlanEnv } from "./plans.ts";
import { billingRoute, stripeReady, type BillingEnv, type BillingPort } from "./billing.ts";
import { byoRoute, handoff as byoHandoff, type ByoEnv } from "./byo.ts";
import { Denied, S3Bucket, type FetchLike } from "./s3-bucket.ts";
import type { Store, Visibility } from "./store.ts";
import { localWebHost, NEWEST_FIELD, type WebAnswer, type WebOp } from "./webhost.ts";
import { checkPrivate, type SharedChange } from "./shared.ts";
import type { EmailEnv } from "./email.ts";
import { accountRoute, devicesApi, signInReturn, type GrantRow, type SessionRow } from "./devices.ts";
import { downloadRoute, type DownloadsBucket } from "./download.ts";
import { handoffRoute } from "./handoff.ts";
import { servedFile } from "./ranges.ts";
import { parseVersion } from "./history.ts";
import type { CloseOrder } from "./hub.ts";
import { activityRoute, browserOf, deleted, history, purge, restore, status, ui } from "./view.ts";
import { storageBreakdown } from "./storage.ts";
import { filesPage } from "./files-page.ts";

export interface Env extends CredsEnv, QuotaEnv, EmailEnv, FeatureEnv, PlanEnv, BillingEnv, ByoEnv {
	/** "production" (the committed value) or "dev" (a local proof: email codes instead of Google). */
	ENVIRONMENT?: string;
	/** This Worker's own host (the CLI's server, the account pages). */
	PUBLIC_URL?: string;
	DB?: unknown;
	ASSETS?: { fetch(request: Request): Promise<Response> };
	BETTER_AUTH_SECRET?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	/** Who may create an account (signup.ts): listed emails, "*" = anyone, unset = nobody new. A secret: real emails. */
	SIGN_UP_EMAILS?: string;
	/** The web host's one writer per folder: a Durable Object namespace of webhost-do.ts's WebHostObject. */
	WEB_HOST?: { idFromName(name: string): unknown; get(id: unknown): { run(op: WebOp): Promise<WebAnswer> } };
	/** The folder's hub (PEP 0005): a Durable Object namespace of hub.ts's FolderHub. Absent, /events answers 503. */
	HUB?: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
	/** The desktop installers' bucket (download.ts), read only. Absent, /fs/download says nothing is published yet. */
	DOWNLOADS?: DownloadsBucket;
}

/** A signed-in person, as a session proves them. */
export interface Person {
	userId: string;
	email: string;
	name: string | null;
	image: string | null;
	sessionId: string;
	sessionToken: string;
}

export type Via = "cookie" | "bearer";

/** What the routes need from the accounts layer (auth.ts builds the live one over Better Auth and D1). */
export interface Deps {
	/** Keeps work running after the answer is sent (the Worker's ctx.waitUntil); absent in tests, which then await it. */
	waitUntil?: (work: Promise<unknown>) => void;
	/** Better Auth's handler for this app's origin (baseURL = that origin, basePath /fs/api/auth). */
	auth(request: Request, app: App): Promise<Response>;
	/** The person whose session this request carries: by its cookie (a browser) or its bearer token (a machine).
	 *  WHY: this is the identity port, `whoIs(request) -> person | null` (PARTS.md, seam 2). Every route asks it, here and in
	 *  handoff.ts, and only auth.ts answers it; test/identity-seam.test.ts fails if anything else reaches Better Auth. */
	person(request: Request, via: Via, app: App | null): Promise<Person | null>;
	/** A one-minute, one-use token for this browser's session; null when it has none (§3.10). */
	handoffToken?(request: Request, app: App): Promise<string | null>;
	/** That token's session as Set-Cookie headers for whoever redeems it; null when it is used, forged or expired. */
	handoffRedeem?(request: Request, app: App, token: string): Promise<string[] | null>;
	/** Ends that session; the Set-Cookie headers that clear a browser's cookie. */
	signOut(request: Request, via: Via, app: App | null, person: Person): Promise<string[]>;
	store: Store;
	/** Requests to the S3 endpoint (tests and the proof answer them locally). */
	s3: FetchLike;
	now(): number;
	/** A new lowercase UUID v4 (a web host's id). */
	uuid(): string;
	/** Dev only: the last sign-in code sent to an email. */
	mailbox?(email: string): string | null;
	/** Runs one web-host write or delete in its folder's queue (§3.4: one writer per host). Live, the folder's Durable
	 *  Object (auth.ts, webhost-do.ts); absent, a queue in this isolate (the unit tests). */
	webHost?(op: WebOp): Promise<WebAnswer>;
	/** This person's sessions, never their tokens (devices.ts). */
	sessions?(userId: string): Promise<SessionRow[]>;
	/** Deletes this person's session `id`; false when they hold none by that id (another person's included). */
	revokeSession?(userId: string, id: string): Promise<boolean>;
	/** This person's approved, not yet redeemed device grants whose approving session still lives (devices.ts). */
	grants?(userId: string): Promise<GrantRow[]>;
	/** Deletes this person's pending grant `id`; false when they have none by that id. */
	revokeGrant?(userId: string, id: string): Promise<boolean>;
	/** The sign-in providers this person has linked ("google"), never their tokens (account.ts). Email codes need no link. */
	signInMethods?(userId: string): Promise<string[]>;
	/** Stripe, behind the identity adapter like the rest of Better Auth (billing.ts). Present only when payments are on and
	 *  Stripe is set up with a TEST-mode key (billing.ts stripeReady). */
	billing?: BillingPort;
}

export const READ_TTL_S = 300;
/** §3.3: the bundle's limits. */
const BUNDLE_FILE_MAX = 256 * 1024;
const BUNDLE_TOTAL_MAX = 2 * 1024 * 1024;
/** The largest file the web host takes in one PUT (the body is held in memory to hash it). */
const WEB_FILE_MAX = 32 * 1024 * 1024;
const EMAIL = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]{1,255}$/;
const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** What a folder's file is served as; anything else is application/octet-stream. */
export const TYPES: Record<string, string> = {
	".json": "application/json; charset=utf-8",
	".jsonl": "application/x-ndjson; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".csv": "text/csv; charset=utf-8",
	".yaml": "text/plain; charset=utf-8",
	".yml": "text/plain; charset=utf-8",
	".toml": "text/plain; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".pdf": "application/pdf",
	".stl": "model/stl",
	".step": "application/step",
	".stp": "application/step",
	".log": "text/plain; charset=utf-8",
	".mp4": "video/mp4",
	// WHY video/mp4: an .m4v is an MPEG-4 file, and video/x-m4v is no registered type
	".m4v": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	// WHY these (the Files page's preview): an <audio> or <img> on the page's own origin plays what the type says it is
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".oga": "audio/ogg",
	".opus": "audio/ogg",
	".m4a": "audio/mp4",
	".flac": "audio/flac",
	".aac": "audio/aac",
	".avif": "image/avif",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
};
export const ACTIVE = new Set([".html", ".htm", ".svg"]);
const SITE_FILES: Record<string, string> = { "signin.js": "text/javascript; charset=utf-8", "device.js": "text/javascript; charset=utf-8", "account.css": "text/css; charset=utf-8", "files.js": "text/javascript; charset=utf-8", "files.css": "text/css; charset=utf-8" };

// ------------------------------------------------------------------------------------------------ answers

export function headers(extra: Record<string, string> = {}): Headers {
	const out = new Headers(extra);
	out.set("Referrer-Policy", "no-referrer");
	out.set("X-Content-Type-Options", "nosniff");
	if (!out.has("Cache-Control")) out.set("Cache-Control", "no-store");
	return out;
}

export function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: headers({ "Content-Type": "application/json; charset=utf-8", ...extra }) });
}

export function fail(status: number, error: string, why: string, extra: Record<string, string> = {}): Response {
	return json(status, { error, why }, extra);
}

// ------------------------------------------------------------------------------------------------ the path

/** The path exactly as sent: no URL parser has resolved dot segments or decoded anything yet. */
export function rawPath(url: string): string {
	const afterHost = url.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/, "");
	return afterHost.split(/[?#]/, 1)[0] || "/";
}

/** The path's segments, each percent-decoded exactly once; null when any is refused. A trailing "" means a folder. */
export function segments(raw: string): string[] | null {
	if (!raw.startsWith("/")) return null;
	const parts = raw.slice(1).split("/");
	const out: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		const piece = parts[i];
		const last = i === parts.length - 1;
		if (piece === "") {
			if (last) {
				out.push("");
				continue;
			}
			return null; // an empty segment inside the path
		}
		let decoded: string;
		try {
			decoded = decodeURIComponent(piece);
		} catch {
			return null;
		}
		// WHY all of these: ".." or "%2e%2e" would climb out of a prefix; an encoded "/" or "\" would split a
		// segment after the check; a control character has no business in a file name.
		if (decoded === "." || decoded === ".." || /[\/\\\u0000-\u001f\u007f]/.test(decoded)) return null;
		out.push(decoded);
	}
	return out;
}

/** A file path made of the URL's remaining segments, under the contract's rules; null when refused. */
function filePath(rest: string[]): string | null {
	if (rest.length === 0 || rest.includes("")) return null;
	const path = rest.join("/");
	try {
		checkPath(path);
	} catch {
		return null;
	}
	return path;
}

// ------------------------------------------------------------------------------------------------ sessions

function loopback(request: Request): boolean {
	const host = new URL(request.url).hostname;
	return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

/** The request's session: a bearer token when one is sent (a machine, an app's server), else the cookie, and the
 *  cookie only on a registered origin. */
export async function session(request: Request, deps: Deps, app: App | null): Promise<{ person: Person; via: Via } | null> {
	const authorization = request.headers.get("Authorization");
	if (authorization) {
		if (!/^bearer\s+\S/i.test(authorization)) return null;
		const person = await deps.person(request, "bearer", app);
		return person ? { person, via: "bearer" } : null;
	}
	if (!app) return null; // an origin no app lists gets no cookie routes
	const person = await deps.person(request, "cookie", app);
	return person ? { person, via: "cookie" } : null;
}

/** CSRF (§3.3): a cookie-authenticated write needs X-Folder-Sync: 1 and its own origin. A cross-site form can set
 *  neither, and a cross-site fetch can't set the header without a preflight this Worker refuses. */
export function csrfOk(request: Request, app: App | null): boolean {
	const origin = request.headers.get("Origin");
	return request.headers.get("X-Folder-Sync") === "1" && !!app && !!origin && origin === new URL(request.url).origin && app.origins.includes(origin); // fs-mutation: the CSRF rule
}

/** The session a write needs, or the answer refusing it. */
/** Whether `person`'s session is still live (store.sessionAlive: one direct read). A stand-in without it (a unit test's
 *  store, which cannot revoke) says yes. */
export async function stillSignedIn(deps: Pick<Deps, "store" | "now">, person: Person, now = deps.now()): Promise<boolean> {
	return !deps.store.sessionAlive || deps.store.sessionAlive(person.userId, person.sessionId, now);
}

export async function writer(request: Request, deps: Deps, app: App | null): Promise<{ person: Person; via: Via } | Response> {
	const who = await session(request, deps, app);
	if (!who) return fail(401, "signed_out", "sign in first");
	if (who.via === "cookie" && !csrfOk(request, app)) return fail(403, "csrf", "a browser's write must carry X-Folder-Sync: 1 from this site's own pages");
	// WHY (review r1 #2): one browser has one cookie, so a tab opened as A writes with B's session once B signs in
	// elsewhere; the page names the user it shows, and a write for anyone else is refused, never put in B's folder
	if (who.via === "cookie" && request.headers.get("X-Folder-Sync-User") !== who.person.userId) {
		return fail(409, "wrong_user", "this page is signed in as someone else (or does not say who): reload it");
	}
	return who;
}

// ------------------------------------------------------------------------------------------------ storage

export function bucketFor(env: Env, deps: Deps, prefix: string, scope: "object-read-only" | "object-read-write", ttl: number): Promise<S3Bucket> {
	return mint(env, prefix, scope, ttl, deps.now()).then((creds) => new S3Bucket(creds, deps.s3));
}

type Role = "owner" | "reader" | "public";

/** Who may read owner's project: decided from the session and the folder's rows, never from the request's say-so.
 *  The folder's hub asks it again for each announcement (hub.ts stillOwner). */
export async function decide(deps: Pick<Deps, "store">, person: Person | null, project: string, ownerParam: string | null): Promise<{ owner: string; role: Role; visibility: Visibility } | Response> {
	const owner = ownerParam ?? person?.userId ?? null;
	if (!owner) return fail(401, "signed_out", "sign in, or name the folder's owner (?owner=) of a public folder");
	if (!USER_ID.test(owner)) return fail(400, "bad_owner", "owner is not an account id");
	const row = await deps.store.folder(owner, project);
	const visibility: Visibility = row?.visibility === "public" ? "public" : "private";
	if (person && person.userId === owner) return { owner, role: "owner", visibility };
	if (person && (await deps.store.isReader(owner, project, person.email.toLowerCase()))) return { owner, role: "reader", visibility };
	if (visibility === "public") return { owner, role: "public", visibility }; // fs-mutation: public is readable signed out
	// WHY 404 to a signed-in stranger: a private folder's existence is not theirs to learn
	return person ? fail(404, "not_found", "no such folder, or it is not shared with you") : fail(401, "signed_out", "sign in to read this folder"); // fs-mutation: private stays private
}

/** Why the person may not add `addBytes` / `addObjects` now (§3.7, review r1 #7), or null. Measured by listing their
 *  root with a read-only credential when the cached measurement is stale. */
async function quotaRefusal(env: Env, deps: Deps, owner: string, addBytes = 0, addObjects = 0): Promise<string | null> {
	const quota = await quotaFor(env, deps.store, owner);
	const root = userRoot(owner, env);
	// WHY signed before usageOf: only the listing's own failures are a measurement's (Measuring); a credential that
	// cannot be signed is a fault, not a 503 to try again
	const bucket = await bucketFor(env, deps, root, "object-read-only", READ_TTL_S);
	const seen = new Set<string>();
	const usage = await usageOf(deps.store, owner, quota, deps.now(), () => bucket.measure(root, { bytes: quota.bytes, objects: quota.objects }, seen));
	await wake(env, deps, owner, seen);
	return overQuota(usage, quota, addBytes, addObjects);
}

/** The folders a measurement passed wake their objects, whose alarm prunes each daily (PEP 0007 §3.2): a machine-only
 *  folder no page reads is still pruned once its keys are refreshed. Best effort, and bounded. */
async function wake(env: Env, deps: Deps, owner: string, projects: Set<string>): Promise<void> {
	if (!projects.size) return;
	const work = Promise.all([...projects].filter((p) => PROJECT.test(p)).slice(0, 50).map((project) =>
		webHostOf(env, deps)({ method: "TOUCH", owner, project, hostId: "", path: "" }).catch(() => undefined))).then(() => undefined);
	// WHY never awaited: a folder's queue may be busy with the very write this measurement admits
	if (deps.waitUntil) deps.waitUntil(work);
	else void work;
}

/** Before a read: the folder's web host settles any change a crash or a failed undo left journalled, so a reader
 *  (a page, a machine's pull through /fs/) never waits for another write to see the file again (review r2 #2). A
 *  folder that cannot be settled yet is a 503 recovering, never a snapshot with the file missing (review r3 #4). */
export async function settledFirst(env: Env, deps: Deps, owner: string, project: string): Promise<Response | null> {
	// WHY either host: the folder's object journals a cut-off change of the web host or of the shared tree (PEP 0010) in one
	// place, and settles whichever it finds
	const hostId = (await deps.store.webHost(owner, project)) ?? (await deps.store.sharedTree(owner, project));
	if (!hostId) return null;
	const answer = await webHostOf(env, deps)({ method: "SETTLE", owner, project, hostId, path: "" });
	return answer.status === 200 ? null : json(answer.status, answer.body, answer.headers ?? {});
}

async function readProject(env: Env, deps: Deps, owner: string, project: string): Promise<Project | Response> {
	const unsettled = await settledFirst(env, deps, owner, project);
	if (unsettled) return unsettled;
	// WHY a read-only credential for exactly this folder: whatever a route below does with a path, R2 lets this
	// request read users/<owner>/<project>/ and nothing else (a public folder's read too)
	const bucket = await bucketFor(env, deps, folderPrefix(owner, project, env), "object-read-only", READ_TTL_S); // fs-mutation: the read scope
	return new Project(bucket, project, userRoot(owner, env));
}

// ------------------------------------------------------------------------------------------------ routes

async function me(request: Request, env: Env, deps: Deps, app: App | null): Promise<Response> {
	const who = await session(request, deps, app);
	if (!who) return fail(401, "signed_out", "not signed in");
	const { person } = who;
	return json(200, {
		user: { id: person.userId, email: person.email, name: person.name, image: person.image },
		root: userRoot(person.userId, env),
		app: app && app.id !== OWN_APP ? { id: app.id, project: app.project } : null,
	});
}

/** A person's storage against their quota (§3.7), split into live and history (PEP 0007 §3.5: history counts
 *  _history/, _changes/, _requests/ and legacy _trash/, and used = live + history). */
export async function usageFigure(env: Env, deps: Deps, owner: string): Promise<{ used: Amount; live: Amount; history: Amount; quota: Amount; over: string | null; partial: boolean }> {
	const quota = await quotaFor(env, deps.store, owner);
	const root = userRoot(owner, env);
	const bucket = await bucketFor(env, deps, root, "object-read-only", READ_TTL_S);
	let used: { bytes: number; objects: number; partial?: boolean; history?: Amount };
	let over: string | null;
	const seen = new Set<string>();
	try {
		used = await usageOf(deps.store, owner, quota, deps.now(), () => bucket.measure(root, { bytes: quota.bytes, objects: quota.objects }, seen));
		over = overQuota(used, quota);
	} catch (error) {
		if (!(error instanceof Measuring)) throw error;
		const known = await deps.store.usage(owner);
		used = known ?? { bytes: 0, objects: 0 };
		over = error instanceof TooOld ? error.message : null;
	}
	await wake(env, deps, owner, seen);
	// WHY clamped: history is charged with the totals, so it never passes them; a figure read mid-update still never shows
	// a negative live share
	const history = { bytes: Math.min(used.history?.bytes ?? 0, used.bytes), objects: Math.min(used.history?.objects ?? 0, used.objects) };
	return {
		used: { bytes: used.bytes, objects: used.objects },
		live: { bytes: used.bytes - history.bytes, objects: used.objects - history.objects },
		history,
		quota: { bytes: quota.bytes, objects: quota.objects },
		over,
		partial: !!used.partial,
	};
}

type Amount = { bytes: number; objects: number };

/** GET /fs/v1/usage: the person's storage against their quota (§3.7), so a page can offer the ways back under
 *  (permanent delete, free up space) when it is over. `over` is the reason, as read-only keys' Reason says it. */
async function usage(request: Request, env: Env, deps: Deps, app: App | null): Promise<Response> {
	const who = await session(request, deps, app);
	if (!who) return fail(401, "signed_out", "not signed in");
	const figure = await usageFigure(env, deps, who.person.userId);
	// owner: whose figures these are (review r5 #1), so a page drops an answer for someone who signed in meanwhile
	return json(200, { owner: who.person.userId, ...figure });
}

async function signOut(request: Request, env: Env, deps: Deps, app: App | null): Promise<Response> {
	const who = await writer(request, deps, app);
	if (who instanceof Response) return who;
	const cookies = await deps.signOut(request, who.via, app, who.person);
	await sessionEnded(env, deps, who.person, who.person.sessionId);
	const answer = json(200, { ok: true });
	for (const cookie of cookies) answer.headers.append("Set-Cookie", cookie);
	return answer;
}

async function credentials(request: Request, env: Env, deps: Deps, app: App | null): Promise<Response> {
	// WHY a bearer only: these are a machine's keys; a browser's cookie never gets storage credentials
	if (!/^bearer\s+\S/i.test(request.headers.get("Authorization") || "")) return fail(401, "signed_out", "a machine signs in with folder-sync login");
	const person = await deps.person(request, "bearer", app); // fs-mutation: the bearer session
	if (!person) return fail(401, "signed_out", "this machine is signed out (signed out or revoked): run folder-sync login");
	// WHY before the quota: a person's own bucket is theirs (byo.ts), so the service's quota never applies to it
	if (featuresOf(env).byo) {
		const own = await byoHandoff(env, deps, person);
		if (own) return own;
	}
	// WHY here: a machine writes to R2 directly and R2 scopes a prefix, never a size, so an account over its quota
	// gets read-only keys (review r1 #7, r2 #7): it can still pull, its uploads wait, and its deletes go through
	// POST …/hosts/<host>/delete, which lowers the usage; the read-write keys it holds run out within the TTL
	let over: string | null;
	try {
		over = await quotaRefusal(env, deps, person.userId);
	} catch (error) {
		// a measurement too old to admit writes on (review r3 #7): read-only keys, so it can still pull and delete
		if (!(error instanceof TooOld)) throw error;
		over = error.message;
	}
	// WHY the session read again, with the keys' clock started BEFORE that read (judge r1 #1, r2 #2): the quota work
	// above takes a while, and so can the read itself; a device revoked meanwhile gets no keys, and the keys signed below
	// end by `authorizedAt` + the TTL, a moment at or before the read saw the session alive, however slow D1 answers.
	const authorizedAt = deps.now();
	if (!(await stillSignedIn(deps, person, authorizedAt))) return fail(401, "signed_out", "this machine is signed out (signed out or revoked): run folder-sync login");
	if (deps.now() >= authorizedAt + ttlOf(env) * 1000) return fail(503, "too_slow", "this request took longer than its keys would live: ask again", { "Retry-After": "1" });
	// from here on this request's clock stands at `authorizedAt` (the marked mint lines below read deps.now())
	deps = { ...deps, now: () => authorizedAt };
	if (over) return json(200, { ...(await mint(env, userRoot(person.userId, env), "object-read-only", ttlOf(env), deps.now())), ReadOnly: true, Reason: over });
	const minted = await mint(env, userRoot(person.userId, env), "object-read-write", ttlOf(env), deps.now()); // fs-mutation: the session's root
	return json(200, minted);
}

async function access(request: Request, env: Env, deps: Deps, app: App | null): Promise<Response> {
	const who = await session(request, deps, app);
	if (!who) return fail(401, "signed_out", "not signed in");
	const query = new URL(request.url).searchParams;
	const project = query.get("project") || "";
	if (!PROJECT.test(project)) return fail(400, "bad_project", "project must match ^[a-z0-9][a-z0-9._-]{0,62}$");
	const decided = await decide(deps, who.person, project, query.get("owner"));
	if (decided instanceof Response) {
		if (decided.status === 400) return decided;
		return json(200, { allowed: false, role: null, root: null });
	}
	return json(200, { allowed: true, role: decided.role, root: userRoot(decided.owner, env) });
}

/** The projects under a person's root in the bucket. */
async function projectNames(bucket: S3Bucket, root: string): Promise<Set<string>> {
	const names = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix: root, delimiter: "/", cursor });
		for (const p of page.delimitedPrefixes) {
			const name = p.slice(root.length).replace(/\/$/, "");
			if (PROJECT.test(name)) names.add(name); // a leading "_" (the trash) never matches
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return names;
}

async function folders(request: Request, env: Env, deps: Deps, app: App | null): Promise<Response> {
	const who = await session(request, deps, app);
	if (!who) return fail(401, "signed_out", "not signed in");
	const owner = who.person.userId;
	const root = userRoot(owner, env);
	const bucket = await bucketFor(env, deps, root, "object-read-only", READ_TTL_S);
	const names = await projectNames(bucket, root);
	const rows = new Map((await deps.store.folders(owner)).map((r) => [r.project, r]));
	for (const project of rows.keys()) names.add(project);
	const out = [];
	for (const project of [...names].sort()) {
		const hosts = await new Project(bucket, project, root).hosts();
		out.push({ project, visibility: rows.get(project)?.visibility === "public" ? "public" : "private", hosts });
	}
	const readable = (await deps.store.readable(who.person.email.toLowerCase())).filter((r) => r.owner !== owner).map((r) => ({ ...r, role: "reader" as const }));
	return json(200, { folders: out, readable });
}

async function folderView(request: Request, env: Env, deps: Deps, app: App | null, project: string): Promise<Response> {
	const who = await session(request, deps, app);
	const decided = await decide(deps, who?.person ?? null, project, new URL(request.url).searchParams.get("owner"));
	if (decided instanceof Response) return decided;
	const reader = await readProject(env, deps, decided.owner, project);
	if (reader instanceof Response) return reader;
	const web = await deps.store.webHost(decided.owner, project);
	const hosts = [];
	const files = [];
	for (const id of await reader.hosts()) {
		const manifest = await reader.manifest(id);
		if (!manifest) continue;
		hosts.push({ id, name: manifest.host_name, seq: manifest.seq, generatedAt: manifest.generated_at, web: id === web });
		for (const e of manifest.files) files.push({ host: id, path: e.path, size: e.size, sha256: e.sha256, mtime: e.mtime, writtenAt: e.written_at });
	}
	return json(200, { project, owner: decided.owner, visibility: decided.visibility, hosts, files }, cacheFor(decided.visibility));
}

function cacheFor(visibility: Visibility): Record<string, string> {
	return { "Cache-Control": visibility === "public" ? "public, max-age=60" : "private, no-store" };
}

async function bundle(request: Request, env: Env, deps: Deps, app: App | null, project: string): Promise<Response> {
	const query = new URL(request.url).searchParams;
	const prefix = query.get("prefix") ?? "";
	if (prefix && (prefix.startsWith("/") || prefix.includes("\\") || prefix.split("/").some((s, i, all) => s === "." || s === ".." || (s === "" && i < all.length - 1)))) {
		return fail(400, "bad_prefix", "prefix is a relative path like saved/ (no '.', '..' or backslash)");
	}
	const who = await session(request, deps, app);
	const decided = await decide(deps, who?.person ?? null, project, query.get("owner"));
	if (decided instanceof Response) return decided;
	const reader = await readProject(env, deps, decided.owner, project);
	if (reader instanceof Response) return reader;
	const out = [];
	const skipped: { host: string; path: string }[] = [];
	let total = 0;
	const utf8 = new TextDecoder("utf-8", { fatal: true });
	for (const f of await reader.files()) {
		if (!f.path.startsWith(prefix) || f.size > BUNDLE_FILE_MAX || total + f.size > BUNDLE_TOTAL_MAX) continue;
		let data: ArrayBuffer;
		try {
			data = await reader.read(f.hostId, f.path); // sha256-checked against the manifest, re-read once on a race
		} catch (error) {
			// changed or deleted since the manifest was read (a machine's upload in flight): named, never silently dropped
			if (error instanceof ContractError) {
				skipped.push({ host: f.hostId, path: f.path });
				continue;
			}
			throw error;
		}
		let text: string;
		try {
			text = utf8.decode(data);
		} catch {
			continue; // not UTF-8: read it by its own URL
		}
		total += data.byteLength;
		out.push({ host: f.hostId, path: f.path, mtime: f.mtime, sha256: f.sha256, text });
	}
	// WHY the owner (review r2 #1): one browser has one cookie, so a page's read can come back for another person
	// who signed in meanwhile; the page drops any answer whose owner is not the person it shows
	return json(200, { owner: decided.owner, files: out, skipped }, cacheFor(decided.visibility));
}

async function file(request: Request, env: Env, deps: Deps, app: App | null, project: string, host: string, rest: string[], head: boolean): Promise<Response> {
	const path = filePath(rest);
	if (!HOST_ID.test(host) || path === null) return fail(400, "bad_path", "a file is /files/<host id>/<path> under the contract's path rules");
	const who = await session(request, deps, app);
	const decided = await decide(deps, who?.person ?? null, project, new URL(request.url).searchParams.get("owner"));
	if (decided instanceof Response) return decided;
	const reader = await readProject(env, deps, decided.owner, project);
	if (reader instanceof Response) return reader;
	const entry = (await reader.manifest(host))?.files.find((e) => e.path === path); // exact: never a prefix, never a trashed version
	if (!entry) return fail(404, "not_found", "that host does not publish that file");
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	const suffix = dot > 0 ? name.slice(dot).toLowerCase() : "";
	const base: Record<string, string> = { "Content-Type": TYPES[suffix] || "application/octet-stream", "Accept-Ranges": "bytes", ...cacheFor(decided.visibility) };
	// WHY sandboxed: a folder's .html or .svg is someone's file, never this site's page
	if (ACTIVE.has(suffix)) base["Content-Security-Policy"] = "sandbox";
	// the ETag, 304, Range and the body: from the manifest's version, streamed, or the whole sha256-checked bytes (ranges.ts)
	return servedFile(request, reader, host, entry, base, head);
}

/** This isolate's web-host queue for deps without one (the unit tests): one per Deps, so tests never share it; each
 *  operation runs with its own request's Env (a test's quota). */
const localHosts = new WeakMap<Deps, (op: WebOp, env: Env) => Promise<WebAnswer>>();

export function webHostOf(env: Env, deps: Deps): (op: WebOp) => Promise<WebAnswer> {
	if (deps.webHost) return (op) => deps.webHost!(op);
	let local = localHosts.get(deps);
	if (!local) {
		local = localWebHost(deps.s3, () => deps.now(), deps.store);
		localHosts.set(deps, local);
	}
	return (op) => local!(op, env);
}

async function web(request: Request, env: Env, deps: Deps, app: App | null, project: string, rest: string[], method: string): Promise<Response> {
	// up_ms (PEP 0007, CONTRACT "Sync times"): for the web host, from the Worker receiving the write to its manifest
	const receivedAt = deps.now();
	const who = await writer(request, deps, app);
	if (who instanceof Response) return who;
	const path = filePath(rest);
	if (path === null) return fail(400, "bad_path", "the path breaks the contract's path rules");
	const owner = who.person.userId; // fs-mutation: the web host's root. WHY: the session's, never a URL's, a body's or a header's
	let op: WebOp;
	if (method === "PUT") {
		const declared = Number(request.headers.get("Content-Length") || 0);
		if (declared > WEB_FILE_MAX) return fail(413, "too_large", `the web host takes files up to ${WEB_FILE_MAX >> 20} MiB`);
		const data = new Uint8Array(await request.arrayBuffer());
		if (data.byteLength > WEB_FILE_MAX) return fail(413, "too_large", `the web host takes files up to ${WEB_FILE_MAX >> 20} MiB`);
		const keepNewest = request.headers.get("X-Folder-Sync-Keep-Newest") || undefined;
		if (keepNewest !== undefined && !NEWEST_FIELD.test(keepNewest)) return fail(400, "bad_header", "X-Folder-Sync-Keep-Newest names one JSON field, like at");
		const tiePrefers = request.headers.get("X-Folder-Sync-Tie-Prefers") || undefined;
		if (tiePrefers !== undefined && !NEWEST_FIELD.test(tiePrefers)) return fail(400, "bad_header", "X-Folder-Sync-Tie-Prefers names one JSON field, like saved");
		// WHY again after the body (judge r2 #5): a slow upload can outlast a revoke; it writes nothing then
		if (!(await stillSignedIn(deps, who.person))) return fail(401, "signed_out", "this device was signed out while it sent this file");
		const hostId = await deps.store.ensureWebHost(owner, project, deps.uuid(), new Date(deps.now()).toISOString());
		op = { method: "PUT", owner, project, hostId, path, data, keepNewest, tiePrefers, sessionId: who.person.sessionId, via: browserOf(request, who.via), receivedAt };
	} else {
		const hostId = await deps.store.webHost(owner, project);
		if (!hostId) return fail(404, "not_found", "this folder has no web host yet");
		// ?permanent=1: no trash copy, the usage lowered at once (review r3 #3: how a person gets under their quota)
		op = { method: "DELETE", owner, project, hostId, path, permanent: new URL(request.url).searchParams.get("permanent") === "1", sessionId: who.person.sessionId, via: browserOf(request, who.via), receivedAt };
	}
	// WHY through the folder's queue: one writer per web host, so no two writes interleave their file and manifest
	// steps (review r1 #3)
	// WHY the quota is admitted and charged in there too: one at a time, by what the change really adds (review r2 #6)
	const answer = await webHostOf(env, deps)(op);
	if (answer.status === 200) {
		// WHY after the answer (PEP 0005): telling the hub must not add its round trip to the page's write
		const told = notifyHub(env, owner, project, answer.body);
		if (deps.waitUntil) deps.waitUntil(told);
		else await told;
	}
	return json(answer.status, answer.body, answer.headers ?? {});
}


// ------------------------------------------------------------------------------------------------ the shared tree (PEP 0010)

/** The most a commit holds, and the most bytes it carries inline (a bigger file is staged by the machine, PEP 0010 §5). */
const COMMIT_CHANGES_MAX = 100;
const INLINE_FILE_MAX = 1024 * 1024;
const COMMIT_BYTES_MAX = 8 * 1024 * 1024;
const COMMIT_BODY_MAX = 14 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function fromBase64(text: string): Uint8Array | null {
	if (!BASE64.test(text) || text.length % 4 === 1) return null;
	try {
		const binary = atob(text);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
		return out;
	} catch {
		return null;
	}
}

/** Tells the hub that the shared tree moved, after the answer, as a web write does. */
async function announce(env: Env, deps: Deps, owner: string, project: string, answer: WebAnswer): Promise<void> {
	if (answer.status !== 200) return;
	const told = notifyHub(env, owner, project, answer.body);
	if (deps.waitUntil) deps.waitUntil(told);
	else await told;
}

/** POST …/share {private?}: the owner opts the folder into a shared tree (PEP 0010 §7). Idempotent: the tree's id is minted
 *  once, and asking again returns it (a different `private` rule is a 409: it cannot change after the share in v1). */
async function share(request: Request, env: Env, deps: Deps, app: App | null, project: string): Promise<Response> {
	const who = await writer(request, deps, app);
	if (who instanceof Response) return who;
	const owner = who.person.userId; // the session's, never a body's
	const raw = await request.arrayBuffer();
	if (raw.byteLength > 64 * 1024) return fail(413, "too_large", "a share is a list of patterns, at most 64 KiB");
	let doc: Record<string, unknown> = {};
	if (raw.byteLength) {
		try {
			doc = JSON.parse(new TextDecoder().decode(raw));
		} catch {
			return fail(400, "bad_request", "the body is not JSON");
		}
		if (!doc || typeof doc !== "object" || Array.isArray(doc) || Object.keys(doc).some((k) => k !== "private")) return fail(400, "bad_request", "the body is { private: [pattern, …] } or empty");
	}
	let priv: string[] | undefined;
	try {
		priv = doc.private === undefined ? undefined : checkPrivate(doc.private);
	} catch {
		return fail(400, "bad_private", "private is a list of up to 200 single-line gitignore patterns");
	}
	if (!(await stillSignedIn(deps, who.person))) return fail(401, "signed_out", "this device was signed out before its share could start");
	const hostId = await deps.store.ensureSharedTree(owner, project, deps.uuid(), new Date(deps.now()).toISOString());
	const answer = await webHostOf(env, deps)({ method: "SHARE", owner, project, hostId, path: "", private: priv, sessionId: who.person.sessionId });
	if (answer.status === 200 && (answer.body as { created?: boolean }).created) await announce(env, deps, owner, project, { status: 200, body: { host: hostId, seq: (answer.body as { seq: number }).seq } });
	return json(answer.status, answer.body, answer.headers ?? {});
}

/** POST …/shared: a device's commit (PEP 0010 §5). `{ device, host?, max_delete?, changes: [{ path, base: {version, sha256?} | null,
 *  sha256, size, body (base64) | staged | delete: true, at_local }] }`. The folder's object answers each path: accepted, merged,
 *  conflict or edit_won. WHY owner only: a reader may read the tree, never write it. */
async function sharedCommitRoute(request: Request, env: Env, deps: Deps, app: App | null, project: string): Promise<Response> {
	const receivedAt = deps.now();
	const who = await writer(request, deps, app);
	if (who instanceof Response) return who;
	const owner = who.person.userId;
	if (Number(request.headers.get("Content-Length") || 0) > COMMIT_BODY_MAX) return fail(413, "too_large", "a commit carries at most 8 MiB of files; stage the big ones");
	const raw = await request.arrayBuffer();
	if (raw.byteLength > COMMIT_BODY_MAX) return fail(413, "too_large", "a commit carries at most 8 MiB of files; stage the big ones");
	let doc: Record<string, unknown>;
	try {
		doc = JSON.parse(new TextDecoder().decode(raw));
	} catch {
		return fail(400, "bad_request", "the body is not JSON");
	}
	if (!doc || typeof doc !== "object" || Array.isArray(doc) || Object.keys(doc).some((k) => !["device", "host", "max_delete", "changes"].includes(k))) {
		return fail(400, "bad_request", "the body is { device, host?, max_delete?, changes: [...] } and nothing else");
	}
	const list = doc.changes;
	if (!Array.isArray(list) || !list.length || list.length > COMMIT_CHANGES_MAX) return fail(400, "bad_request", `changes is a list of 1 to ${COMMIT_CHANGES_MAX} paths`);
	const host = doc.host;
	if (host !== undefined && (typeof host !== "string" || !HOST_ID.test(host))) return fail(400, "bad_host", "host is the committing machine's lowercase UUID");
	const device = typeof doc.device === "string" && doc.device.trim() ? doc.device.slice(0, 128) : (browserOf(request, who.via) ?? "a machine");
	const maxDelete = doc.max_delete === undefined ? 50 : doc.max_delete;
	if (typeof maxDelete !== "number" || !Number.isInteger(maxDelete) || maxDelete < 0) return fail(400, "bad_request", "max_delete is a whole number");
	const changes: SharedChange[] = [];
	let carried = 0;
	for (const item of list) {
		if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((k) => !["path", "base", "sha256", "size", "body", "staged", "delete", "at_local"].includes(k))) {
			return fail(400, "bad_request", "each change is { path, base, sha256, size, body | staged | delete, at_local }");
		}
		const c = item as Record<string, unknown>;
		if (typeof c.path !== "string" || filePath(c.path.split("/")) === null) return fail(400, "bad_path", "the path breaks the contract's path rules");
		let base: SharedChange["base"] = null;
		if (c.base !== null && c.base !== undefined) {
			const b = c.base as Record<string, unknown>;
			if (typeof b !== "object" || typeof b.version !== "string" || !parseVersion(b.version) || (b.sha256 !== undefined && (typeof b.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(b.sha256)))) return fail(400, "bad_base", "base is null or { version, sha256? }");
			base = { version: b.version, ...(b.sha256 ? { sha256: b.sha256 } : {}) };
		}
		if (c.sha256 !== undefined && (typeof c.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(c.sha256))) return fail(400, "bad_request", "sha256 is lowercase hex");
		if (c.at_local !== undefined && (typeof c.at_local !== "string" || c.at_local.length > 40)) return fail(400, "bad_request", "at_local is the device's local time, RFC 3339");
		const change: SharedChange = { path: c.path, base, sha256: c.sha256 as string | undefined, at_local: c.at_local as string | undefined };
		const kinds = [c.body !== undefined, c.staged !== undefined, c.delete === true].filter(Boolean).length;
		if (kinds !== 1 || (c.delete !== undefined && c.delete !== true)) return fail(400, "bad_request", `${c.path}: exactly one of body, staged, delete: true`);
		if (c.delete === true) change.delete = true;
		else if (c.staged !== undefined) {
			if (typeof c.staged !== "string" || !HOST_ID.test(c.staged) || !host) return fail(400, "bad_staged", "staged is the uuid of an object uploaded to _incoming/<project>/<host>/, and host says whose");
			change.staged = c.staged;
		} else {
			const data = typeof c.body === "string" ? fromBase64(c.body) : null;
			if (!data) return fail(400, "bad_request", `${c.path}: body is base64`);
			if (data.byteLength > INLINE_FILE_MAX) return fail(413, "too_large", `${c.path}: a file over 1 MiB is staged, not sent inline`);
			carried += data.byteLength;
			if (carried > COMMIT_BYTES_MAX) return fail(413, "too_large", "a commit carries at most 8 MiB of files; stage the big ones");
			change.data = data;
		}
		changes.push(change);
	}
	const hostId = await deps.store.sharedTree(owner, project);
	if (!hostId) return fail(409, "not_shared", "this folder has no shared tree: run folder-sync share");
	// WHY again after the body (judge r2 #5): a device revoked while it sent this writes nothing
	if (!(await stillSignedIn(deps, who.person))) return fail(401, "signed_out", "this device was signed out while it sent this commit");
	const answer = await webHostOf(env, deps)({
		method: "SHARED_COMMIT", owner, project, hostId, path: "", sessionId: who.person.sessionId, via: browserOf(request, who.via), receivedAt,
		commit: { device, host: host as string | undefined, via: browserOf(request, who.via), maxDelete, changes, receivedAt },
	});
	if (answer.status === 200 && (answer.body as { changed?: boolean }).changed) await announce(env, deps, owner, project, answer);
	return json(answer.status, answer.body, answer.headers ?? {});
}

/** PUT|DELETE …/shared/<path>: a page's write to the shared tree, through the same commit. The version it was made from
 *  is `X-Folder-Sync-Base` (absent for a new file; a delete needs it); `X-Folder-Sync-Merge: never` makes a mismatch a 412
 *  for an app that merges its own data. */
async function sharedPage(request: Request, env: Env, deps: Deps, app: App | null, project: string, rest: string[], method: string): Promise<Response> {
	const receivedAt = deps.now();
	const who = await writer(request, deps, app);
	if (who instanceof Response) return who;
	const path = filePath(rest);
	if (path === null) return fail(400, "bad_path", "the path breaks the contract's path rules");
	const owner = who.person.userId;
	const version = request.headers.get("X-Folder-Sync-Base");
	if (version !== null && !parseVersion(version)) return fail(400, "bad_base", "X-Folder-Sync-Base is a version id, <written_at>_<sha16>, as the history lists it");
	const never = request.headers.get("X-Folder-Sync-Merge");
	if (never !== null && never !== "never") return fail(400, "bad_header", "X-Folder-Sync-Merge is never, or absent");
	const hostId = await deps.store.sharedTree(owner, project);
	if (!hostId) return fail(409, "not_shared", "this folder has no shared tree: run folder-sync share");
	const change: SharedChange = { path, base: version ? { version } : null, ...(never ? { never: true } : {}) };
	if (method === "PUT") {
		const declared = Number(request.headers.get("Content-Length") || 0);
		if (declared > WEB_FILE_MAX) return fail(413, "too_large", `the shared tree takes a page's files up to ${WEB_FILE_MAX >> 20} MiB`);
		const data = new Uint8Array(await request.arrayBuffer());
		if (data.byteLength > WEB_FILE_MAX) return fail(413, "too_large", `the shared tree takes a page's files up to ${WEB_FILE_MAX >> 20} MiB`);
		change.data = data;
	} else {
		if (!version) return fail(400, "bad_base", "a delete names the version it was made from in X-Folder-Sync-Base");
		change.delete = true;
	}
	if (!(await stillSignedIn(deps, who.person))) return fail(401, "signed_out", "this device was signed out while it sent this file");
	const via = browserOf(request, who.via);
	const answer = await webHostOf(env, deps)({
		method: "SHARED_COMMIT", owner, project, hostId, path: "", sessionId: who.person.sessionId, via, receivedAt,
		commit: { device: via ?? "a browser", via, maxDelete: 50, changes: [change], receivedAt },
	});
	if (answer.status !== 200) return json(answer.status, answer.body, answer.headers ?? {});
	await announce(env, deps, owner, project, answer);
	const done = answer.body as { host: string; seq: number; results: unknown[] };
	return json(200, { host: done.host, seq: done.seq, ...(done.results[0] as object) });
}

/** The largest body POST …/hosts/<host>/delete takes: a list of paths, nothing else. */
const DELETE_BODY_MAX = 256 * 1024;

/** A machine's deletes while its keys are read-only (over quota, §3.7, review r2 #7). The machine sends a job id, the
 *  seq of the manifest it last published and the paths it drops, and nothing else (review r3 #1: a manifest from the
 *  caller would be an upload channel past the quota). The folder's Durable Object runs it as a job (webhost.ts
 *  WebHostCore.hostDelete, review r3 #2): it builds the next manifest from the stored one, commits it (If-Match),
 *  deletes the files permanently (no trash copy: the trash still counts) and lowers the usage, each step once, and
 *  finishes a cleanup that failed on a replay of the same job id or on its alarm. WHY bearer only: a machine's host. */
async function machineDelete(request: Request, env: Env, deps: Deps, app: App | null, project: string, host: string): Promise<Response> {
	if (!/^bearer\s+\S/i.test(request.headers.get("Authorization") || "")) return fail(401, "signed_out", "a machine deletes with its own session (folder-sync login)");
	const person = await deps.person(request, "bearer", app);
	if (!person) return fail(401, "signed_out", "this machine is signed out (signed out or revoked): run folder-sync login");
	if (!HOST_ID.test(host)) return fail(400, "bad_host", "a host is its lowercase UUID");
	if (Number(request.headers.get("Content-Length") || 0) > DELETE_BODY_MAX) return fail(413, "too_large", "a delete is a list of paths, at most 256 KiB");
	const raw = await request.arrayBuffer();
	if (raw.byteLength > DELETE_BODY_MAX) return fail(413, "too_large", "a delete is a list of paths, at most 256 KiB");
	if ((await deps.store.webHost(person.userId, project)) === host) return fail(400, "web_host", "the web host's files are deleted with DELETE …/web/<path>");
	if ((await deps.store.sharedTree(person.userId, project)) === host) return fail(400, "shared_tree", "the shared tree's files are deleted with a commit (POST …/shared) or DELETE …/shared/<path>");
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(new TextDecoder().decode(raw));
	} catch {
		return fail(400, "bad_request", "the body is not JSON");
	}
	if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "job" && k !== "from_seq" && k !== "paths")) {
		return fail(400, "bad_request", "the body is { job, from_seq, paths } and nothing else: the server builds the manifest");
	}
	const paths = body.paths;
	if (!Array.isArray(paths) || !paths.length || paths.length > 400 || paths.some((p) => typeof p !== "string") || new Set(paths).size !== paths.length) {
		return fail(400, "bad_paths", "paths is a list of 1 to 400 distinct file paths");
	}
	if (!Number.isSafeInteger(body.from_seq)) return fail(400, "bad_seq", "from_seq is the seq of the manifest this machine last published");
	if (typeof body.job !== "string" || !HOST_ID.test(body.job)) return fail(400, "bad_job", "job is a lowercase UUID v4 the machine keeps until it has the answer");
	// WHY the session's owner: the root is never the request's
	const answer = await webHostOf(env, deps)({ method: "HOST_DELETE", owner: person.userId, project, hostId: host, path: "", job: body.job, fromSeq: body.from_seq as number, paths: paths as string[], sessionId: person.sessionId });
	return json(answer.status, answer.body, answer.headers ?? {});
}

/** POST …/web-trash/purge: the folder's web host's trash deleted for good, a page at a time (review r3 #3). */
async function purgeWebTrash(request: Request, env: Env, deps: Deps, app: App | null, project: string): Promise<Response> {
	const who = await writer(request, deps, app);
	if (who instanceof Response) return who;
	const owner = who.person.userId; // the session's, never the request's
	const hostId = await deps.store.webHost(owner, project);
	if (!hostId) return json(200, { purged: 0, bytes: 0, more: false });
	const answer = await webHostOf(env, deps)({ method: "PURGE_TRASH", owner, project, hostId, path: "", sessionId: who.person.sessionId });
	return json(answer.status, answer.body, answer.headers ?? {});
}

// ------------------------------------------------------------------------------------------------ the hub (PEP 0005)

/** The name of a folder's hub (a Durable Object of its own namespace, so it may share webHostName's spelling). */
function hubName(owner: string, project: string): string {
	return `${owner}/${project}`;
}

/** How long a web write waits for the hub before giving up on telling it. */
const NOTIFY_MS = 1500;

/** Tells the folder's hub that the web host moved. WHY best effort and bounded: the write already succeeded and
 *  every client still catches up by polling, so a failed or slow notify must never fail or hold the write. */
async function notifyHub(env: Env, owner: string, project: string, body: unknown): Promise<void> {
	const hub = env.HUB;
	const { host, seq } = (body ?? {}) as { host?: unknown; seq?: unknown };
	if (!hub || typeof host !== "string" || typeof seq !== "number") return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const send = hub.get(hub.idFromName(hubName(owner, project))).fetch(new Request("https://hub/notify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ host, seq, web: true }),
		}));
		send.catch(() => undefined);
		await Promise.race([send, new Promise((done) => { timer = setTimeout(done, NOTIFY_MS); })]);
	} catch {
		// ignored on purpose
	} finally {
		clearTimeout(timer);
	}
}

/** Runs `work` after the answer when the Worker can (ctx.waitUntil), else before it (the tests). */
async function after(deps: Deps, work: Promise<void>): Promise<void> {
	if (deps.waitUntil) deps.waitUntil(work);
	else await work;
}

/** Asks each named hub to close the sockets `order` names (hub.ts POST /close), in parallel. WHY best effort and
 *  bounded, as notifyHub: the session (or the reader row) has already ended here, so a hub that fails or hangs must
 *  never fail or hold the revoke; the hub checks every announcement again anyway (hub.ts stillOwner). */
async function closeInHubs(env: Env, names: Iterable<string>, order: CloseOrder): Promise<void> {
	const hub = env.HUB;
	if (!hub) return;
	await Promise.all([...names].map(async (name) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const send = hub.get(hub.idFromName(name)).fetch(new Request("https://hub/close", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(order) }));
			send.catch(() => undefined);
			await Promise.race([send, new Promise((done) => { timer = setTimeout(done, NOTIFY_MS); })]);
		} catch {
			// ignored on purpose
		} finally {
			clearTimeout(timer);
		}
	}));
}

/** Every hub a session of `person` may hold a socket in: one per folder of theirs (their projects in the bucket and
 *  their folder rows, as GET /fs/v1/folders lists them) and one per folder shared with them. What can't be listed now
 *  (storage down) is skipped: the hub's per-announcement check stands behind it. */
async function hubsOf(env: Env, deps: Deps, person: Person): Promise<Set<string>> {
	const names = new Set<string>();
	const owner = person.userId;
	const root = userRoot(owner, env);
	await Promise.all([
		bucketFor(env, deps, root, "object-read-only", READ_TTL_S).then((bucket) => projectNames(bucket, root)).then((projects) => { for (const p of projects) names.add(hubName(owner, p)); }),
		deps.store.folders(owner).then((rows) => { for (const r of rows) names.add(hubName(owner, r.project)); }),
		deps.store.readable(person.email.toLowerCase()).then((rows) => { for (const r of rows) names.add(hubName(r.owner, r.project)); }),
	].map((listing) => listing.catch(() => undefined)));
	return names;
}

/** After `person`'s session `sessionId` ended (revoked, signed out): its sockets close (hub.ts SIGNED_OUT). WHY
 *  (post-rebase review): the Worker checks a socket's session only when it opens, so without this a revoked machine or
 *  a signed-out browser keeps hearing the folder's changes. */
export async function sessionEnded(env: Env, deps: Deps, person: Person, sessionId: string): Promise<void> {
	if (!env.HUB) return;
	await after(deps, hubsOf(env, deps, person).then((names) => closeInHubs(env, names, { session: sessionId })).catch(() => undefined));
}

/** GET …/events with Upgrade: websocket: who may connect is decided here (the hub trusts what this forwards). */
async function events(request: Request, env: Env, deps: Deps, app: App | null, project: string): Promise<Response> {
	if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return fail(426, "upgrade_required", "this route is a WebSocket: send Upgrade: websocket", { Upgrade: "websocket" });
	const who = await session(request, deps, app);
	// WHY the Origin check (PEP 0005 §3): a browser sends its cookie on a WebSocket upgrade from any site, and a socket
	// is not bound by CORS; so a cookie session connects only from this site's own pages. A bearer can't be attached by
	// a page, and a signed-out reader has no ambient credential to hijack.
	if (who?.via === "cookie") {
		const origin = request.headers.get("Origin");
		if (!app || !origin || origin !== new URL(request.url).origin || !app.origins.includes(origin)) return fail(403, "origin", "a browser's socket must come from this site's own pages");
	}
	const decided = await decide(deps, who?.person ?? null, project, new URL(request.url).searchParams.get("owner"));
	if (decided instanceof Response) return decided;
	const hub = env.HUB;
	if (!hub) return fail(503, "not_configured", "the folder hub (HUB) is not bound on this Worker");
	// WHY the credentials stay here: the hub needs only who the person is to this folder, never a cookie or a token
	const forwarded = new Headers(request.headers);
	forwarded.delete("Cookie");
	forwarded.delete("Authorization");
	// WHY every X-Hub-* of the client's dropped: the hub trusts these headers, so only this Worker may name them
	for (const name of [...forwarded.keys()]) if (name.toLowerCase().startsWith("x-hub-")) forwarded.delete(name);
	forwarded.set("X-Hub-Role", decided.role);
	forwarded.set("X-Hub-Kind", who?.via === "bearer" ? "machine" : "page");
	// who the socket is, so a revoke, a sign-out or a reader's removal can close it and an announcement be checked again
	// (hub.ts Identity); the email percent-encoded, as a header carries bytes only
	if (who) {
		forwarded.set("X-Hub-Owner", decided.owner);
		forwarded.set("X-Hub-Project", project);
		forwarded.set("X-Hub-User", who.person.userId);
		forwarded.set("X-Hub-Email", encodeURIComponent(who.person.email));
		forwarded.set("X-Hub-Session", who.person.sessionId);
	}
	return hub.get(hub.idFromName(hubName(decided.owner, project))).fetch(new Request(request, { headers: forwarded }));
}

export async function jsonBody(request: Request): Promise<Record<string, unknown> | Response> {
	if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) return fail(415, "json_only", "send Content-Type: application/json");
	try {
		const body = await request.json();
		if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "bad_request", "the body is one JSON object");
		return body as Record<string, unknown>;
	} catch {
		return fail(400, "bad_request", "the body is not JSON");
	}
}

async function patchFolder(request: Request, deps: Deps, app: App | null, project: string): Promise<Response> {
	const who = await writer(request, deps, app);
	if (who instanceof Response) return who;
	const body = await jsonBody(request);
	if (body instanceof Response) return body;
	if (body.visibility !== "public" && body.visibility !== "private") return fail(400, "bad_visibility", 'visibility is "public" or "private"');
	return json(200, await deps.store.setVisibility(who.person.userId, project, body.visibility, new Date(deps.now()).toISOString()));
}

async function readers(request: Request, env: Env, deps: Deps, app: App | null, project: string, rest: string[], method: string): Promise<Response> {
	const who = await writer(request, deps, app);
	if (who instanceof Response) return who;
	const owner = who.person.userId;
	if (method === "POST" && rest.length === 0) {
		const body = await jsonBody(request);
		if (body instanceof Response) return body;
		const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
		if (!EMAIL.test(email)) return fail(400, "bad_email", "email is one address");
		await deps.store.addReader(owner, project, email, new Date(deps.now()).toISOString());
		return json(200, { project, readers: await deps.store.readers(owner, project) });
	}
	if (method === "DELETE" && rest.length === 1) {
		const email = rest[0].trim().toLowerCase();
		if (!EMAIL.test(email)) return fail(400, "bad_email", "email is one address");
		if (!(await deps.store.removeReader(owner, project, email))) return fail(404, "not_found", "that email is not a reader of this folder");
		// WHY (post-rebase review): their open sockets on this folder were let in as a reader; they close (hub.ts NOT_A_READER)
		await after(deps, closeInHubs(env, [hubName(owner, project)], { reader: email }));
		return json(200, { project, readers: await deps.store.readers(owner, project) });
	}
	return fail(405, "method", "POST …/readers {email} or DELETE …/readers/<email>");
}

// ------------------------------------------------------------------------------------------------ pages

/** The policy of the pages that hold a session: this Worker's own code only, never framed, nothing else. */
export const PAGE_POLICY = [
	"default-src 'none'",
	"script-src 'self'",
	"style-src 'self'",
	"img-src 'self' data:",
	"connect-src 'self'",
	"base-uri 'none'",
	"form-action 'self'",
	"frame-ancestors 'none'",
	"object-src 'none'",
].join("; ");

/** Whether this Worker sends sign-in codes by email: dev (to its mailbox), or production with Resend set up. */
export function emailCodes(env: Env): boolean {
	return env.ENVIRONMENT === "dev" || (!!env.RESEND_API_KEY && !!env.EMAIL_FROM);
}

/** The ways in the sign-in page offers, space-separated: "google", "email", both, or "none". */
function signInMethod(env: Env): string {
	if (env.ENVIRONMENT === "dev") return "email";
	const ways = [env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? "google" : "", emailCodes(env) ? "email" : ""].filter(Boolean);
	return ways.join(" ") || "none";
}

export function escapeAttr(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** `return` as a same-origin path, else "/". WHY: an open redirect would hand a signed-in tab to another site. */
export function returnPath(value: string | null): string {
	if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\") || /[\u0000-\u001f\u007f]/.test(value)) return "/";
	return value;
}

function page(env: Env, app: App, origin: string, title: string, script: string, back: string, head: boolean): Response {
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeAttr(title)} · ${escapeAttr(app.name)}</title>
<link rel="icon" href="data:,">
<meta name="fs-signin" content="${signInMethod(env)}">${env.ENVIRONMENT === "dev" ? '\n<meta name="fs-local" content="1">' : ""}
<meta name="fs-app" content="${escapeAttr(app.name)}">
<meta name="fs-origin" content="${escapeAttr(origin)}">
<meta name="fs-return" content="${escapeAttr(back)}">
<link rel="stylesheet" href="/fs/site/account.css">
</head>
<body>
<main class="fs-cover" data-testid="fs-page"><div class="fs-card" role="status"><p class="fs-small">Loading…</p></div></main>
<script src="/fs/site/signin.js"></script>
${script ? `<script src="/fs/site/${script}"></script>\n` : ""}</body>
</html>
`;
	return new Response(head ? null : html, {
		status: 200,
		headers: headers({ "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PAGE_POLICY, "X-Frame-Options": "DENY" }),
	});
}

async function site(env: Env, name: string, head: boolean): Promise<Response> {
	const type = SITE_FILES[name];
	if (!type || !env.ASSETS) return fail(404, "not_found", "no such file");
	const answer = await env.ASSETS.fetch(new Request(new URL(`/${name}`, "https://assets.invalid/")));
	if (!answer.ok) return fail(404, "not_found", "no such file");
	return new Response(head ? null : answer.body, { status: 200, headers: headers({ "Content-Type": type, "Cache-Control": "no-cache" }) });
}

// ------------------------------------------------------------------------------------------------ CORS

function cors(request: Request, registered: Map<string, App>): Record<string, string> {
	const origin = request.headers.get("Origin");
	// an origin no app lists gets no CORS at all
	if (!origin || !appFor(origin, registered)) return {};
	return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
}

// ------------------------------------------------------------------------------------------------ the router

export async function handle(request: Request, env: Env, deps: Deps | null): Promise<Response> {
	const registered = apps(env.PUBLIC_URL, undefined, env.ENVIRONMENT === "dev");
	const allowed = cors(request, registered);
	const answer = await route(request, env, deps, registered, allowed).catch((error) => {
		if (error instanceof NotConfigured) return fail(503, "not_configured", "folder storage is not set up on this Worker yet");
		if (error instanceof Denied) return fail(404, "not_found", "no such file");
		if (error instanceof ContractError) return fail(502, "bad_manifest", "a host's manifest breaks the contract");
		if (error instanceof Measuring) return fail(503, "measuring", error.message, { "Retry-After": "60" });
		throw error;
	});
	// WHY a 101 is returned as it is: re-wrapping it would drop its webSocket, and a handshake needs no CORS headers
	if (answer.status === 101 || !allowed["Access-Control-Allow-Origin"]) return answer;
	const out = new Response(answer.body, answer);
	for (const [key, value] of Object.entries(allowed)) out.headers.set(key, value);
	return out;
}

async function route(request: Request, env: Env, deps: Deps | null, registered: Map<string, App>, allowed: Record<string, string>): Promise<Response> {
	const method = request.method.toUpperCase();
	const parts = segments(rawPath(request.url));
	if (parts === null) return fail(400, "bad_path", "an empty, '.' or '..' segment (encoded or not), a backslash or an encoded slash");
	if (parts[0] !== "fs") return fail(404, "not_found", "folder-sync answers under /fs/ only");
	const app = appFor(new URL(request.url).origin, registered);
	const head = method === "HEAD";
	const read = method === "GET" || head;
	const [, first, ...rest] = parts;
	const features = featuresOf(env);

	if (method === "OPTIONS") {
		if (!allowed["Access-Control-Allow-Origin"]) return fail(403, "cors", "this origin is not a registered app");
		return new Response(null, {
			status: 204,
			headers: headers({ ...allowed, "Access-Control-Allow-Methods": "GET, HEAD, PUT, PATCH, POST, DELETE", "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Folder-Sync, X-Folder-Sync-User, X-Folder-Sync-Keep-Newest, X-Folder-Sync-Tie-Prefers, X-Folder-Sync-Base, X-Folder-Sync-Merge", "Access-Control-Max-Age": "600" }),
		});
	}
	if (first === "api" && rest[0] === "auth") {
		if (!app) return fail(404, "unknown_origin", "this origin is not a registered app: no sign-in here");
		if (!deps) return fail(503, "not_configured", "sign-in is not set up on this Worker yet");
		// WHY a second guard: the email-code plugin is loaded in dev, or in production once Resend is set up (review r3
		// #8); without it a request for it is a 404 here even if a config mistake loaded the plugin
		if (!emailCodes(env) && rest.some((p) => p.includes("email-otp"))) return fail(404, "not_found", "no email codes here");
		// WHY here and not only in the pages: Better Auth's own routes are the other way in to a switched-off feature
		if (!features.sync && rest[1] === "device") return featureOff("sync");
		if (rest[1] === "stripe" || rest[1] === "subscription") {
			if (!features.payments) return featureOff("payments");
			if (!deps.billing) return fail(503, "not_configured", "payments are on but Stripe is not set up here (a test-mode STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET)");
		}
		return deps.auth(request, app);
	}
	if (first === "dev" && rest[0] === "mailbox" && rest.length === 1) {
		// the local proof reads its sign-in codes here; production has no mailbox (and no email codes) at all
		if (env.ENVIRONMENT !== "dev" || !loopback(request) || !deps?.mailbox) return fail(404, "not_found", "no mailbox here");
		const email = new URL(request.url).searchParams.get("email") || "";
		return json(200, { email, code: deps.mailbox(email) });
	}
	if (first === "site" && rest.length === 1) return read ? site(env, rest[0], head) : fail(405, "method", "GET only", { Allow: "GET, HEAD" });
	if (first === "ui") return read ? ui(env, rest, head) : fail(405, "method", "GET only", { Allow: "GET, HEAD" });
	if ((first === "signin" || first === "device") && rest.length === 0) {
		if (!read) return fail(405, "method", "GET only", { Allow: "GET, HEAD" });
		if (!app) return fail(404, "unknown_origin", "this origin is not a registered app: no sign-in here");
		if (first === "device" && !features.sync) return featureOff("sync");
		const back = first === "signin" ? signInReturn(app, returnPath(new URL(request.url).searchParams.get("return"))) : "/fs/device";
		const origin = new URL(request.url).origin;
		return first === "signin" ? page(env, app, origin, "Sign in", "", back, head) : page(env, app, origin, "Sign in a machine", "device.js", back, head);
	}
	if (first === "handoff") return handoffRoute(request, deps, app, rest, method);
	if (first === "account") {
		if ((rest[0] === "plan" || rest[0] === "billing") && !features.payments) return featureOff("payments");
		if (rest[0] === "byo" && !features.byo) return featureOff("byo");
		return accountRoute(request, env, deps, app, rest, method);
	}
	if (first === "files" && rest.length === 0) {
		if (!features.storage) return featureOff("storage");
		if (!read) return fail(405, "method", "GET only", { Allow: "GET, HEAD" });
		if (!app) return fail(404, "unknown_origin", "this origin is not a registered app: no files page here");
		return filesPage(request, deps, app, head);
	}
	// public, no session: the desktop installers (PEP 0006), on every app's /fs/ and this Worker's own host
	if (first === "download") return downloadRoute(request, env, app, rest, method);
	if (first !== "v1") return fail(404, "not_found", "no such route");
	if (!deps) return fail(503, "not_configured", "accounts are not set up on this Worker yet");
	const [what, project, sub, ...more] = rest;

	if (what === "me" && rest.length === 1) return read ? me(request, env, deps, app) : fail(405, "method", "GET only", { Allow: "GET, HEAD" });
	if (what === "usage" && rest.length === 1) return read ? usage(request, env, deps, app) : fail(405, "method", "GET only", { Allow: "GET, HEAD" });
	if (what === "usage" && rest.length === 2 && project === "breakdown") return read ? storageBreakdown(request, env, deps, app) : fail(405, "method", "GET only", { Allow: "GET, HEAD" });
	if (what === "sign-out" && rest.length === 1) return method === "POST" ? signOut(request, env, deps, app) : fail(405, "method", "POST only", { Allow: "POST" });
	if (what === "credentials" && rest.length === 1) {
		if (!features.sync) return featureOff("sync");
		return method === "POST" ? credentials(request, env, deps, app) : fail(405, "method", "POST only", { Allow: "POST" });
	}
	if (what === "devices") return devicesApi(request, env, deps, app, rest.slice(1), method);
	if (what === "billing") return features.payments ? billingRoute(request, env, deps, app, rest.slice(1), method) : featureOff("payments");
	if (what === "byo") return features.byo ? byoRoute(request, env, deps, app, rest.slice(1), method) : featureOff("byo");
	if (what === "access" && rest.length === 1) return read ? access(request, env, deps, app) : fail(405, "method", "GET only", { Allow: "GET, HEAD" });
	if (what !== "folders") return fail(404, "not_found", "no such route");
	if (rest.length === 1) return read ? folders(request, env, deps, app) : fail(405, "method", "GET only", { Allow: "GET, HEAD" });
	if (!PROJECT.test(project)) return fail(400, "bad_project", "project must match ^[a-z0-9][a-z0-9._-]{0,62}$");
	if (sub === undefined) {
		if (read) return folderView(request, env, deps, app, project);
		if (method === "PATCH") return patchFolder(request, deps, app, project);
		return fail(405, "method", "GET or PATCH", { Allow: "GET, HEAD, PATCH" });
	}
	if (sub === "events" && more.length === 0) return method === "GET" ? events(request, env, deps, app, project) : fail(405, "method", "GET only", { Allow: "GET" });
	if (sub === "bundle" && more.length === 0) return read ? bundle(request, env, deps, app, project) : fail(405, "method", "GET only", { Allow: "GET, HEAD" });
	if (sub === "files" && more.length >= 2) return read ? file(request, env, deps, app, project, more[0], more.slice(1), head) : fail(405, "method", "GET only", { Allow: "GET, HEAD" });
	if (sub === "web" && more.length >= 1) {
		if (!features.storage) return featureOff("storage");
		return method === "PUT" || method === "DELETE" ? web(request, env, deps, app, project, more, method) : fail(405, "method", "PUT or DELETE", { Allow: "PUT, DELETE" });
	}
	if (sub === "share" && more.length === 0) return method === "POST" ? share(request, env, deps, app, project) : fail(405, "method", "POST only", { Allow: "POST" });
	if (sub === "shared" && more.length === 0) return method === "POST" ? sharedCommitRoute(request, env, deps, app, project) : fail(405, "method", "POST only", { Allow: "POST" });
	if (sub === "shared" && more.length >= 1) {
		return method === "PUT" || method === "DELETE" ? sharedPage(request, env, deps, app, project, more, method) : fail(405, "method", "PUT or DELETE", { Allow: "PUT, DELETE" });
	}
	if (sub === "readers") return readers(request, env, deps, app, project, more, method);
	if (sub === "web-trash" && more.length === 1 && more[0] === "purge") {
		if (!features.storage) return featureOff("storage");
		return method === "POST" ? purgeWebTrash(request, env, deps, app, project) : fail(405, "method", "POST only", { Allow: "POST" });
	}
	if (sub === "hosts" && more.length === 2 && more[1] === "delete") {
		if (!features.sync) return featureOff("sync");
		return method === "POST" ? machineDelete(request, env, deps, app, project, more[0]) : fail(405, "method", "POST only", { Allow: "POST" });
	}
	// the sync view's data API (PEP 0007, docs/API.md)
	if (sub === "status" && more.length === 0) return read ? status(request, env, deps, app, project) : fail(405, "method", "GET only", { Allow: "GET, HEAD" });
	if (sub === "activity" && more.length === 0) return read ? activityRoute(request, env, deps, app, project) : fail(405, "method", "GET only", { Allow: "GET, HEAD" });
	if (sub === "deleted" && more.length === 0) return read ? deleted(request, env, deps, app, project) : fail(405, "method", "GET only", { Allow: "GET, HEAD" });
	if (sub === "restore" && more.length === 0) return method === "POST" ? restore(request, env, deps, app, project) : fail(405, "method", "POST only", { Allow: "POST" });
	if (sub === "history" && more.length === 1 && more[0] === "purge") return method === "POST" ? purge(request, env, deps, app, project) : fail(405, "method", "POST only", { Allow: "POST" });
	if (sub === "history" && more.length >= 2) return read ? history(request, env, deps, app, project, more[0], more.slice(1), head) : fail(405, "method", "GET only", { Allow: "GET, HEAD" });
	return fail(404, "not_found", "no such route");
}
