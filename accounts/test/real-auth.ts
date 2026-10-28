// The real accounts layer in one process, for tests: auth.ts's liveDeps (Better Auth 1.7.11 and its D1 adapter, the
// D1 store) over node:sqlite with every migration applied, the in-memory S3, and an injected clock. What the judge of
// lane/devices probed in memory (rounds 1-2), kept here: sessions, device grants and revocation exactly as production
// runs them, minus wrangler and the network.
//
// The D1 stand-in implements what the Kysely D1 dialect and store.ts use: prepare/bind/all/first/run/raw, batch, exec.
// `hold` pauses delivery of a query's result (after SQLite has answered it): how a slow D1 round trip is reproduced.

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handle, type Deps, type Env } from "../src/app.ts";
import { liveDeps } from "../src/auth.ts";
import { MemoryS3 } from "./memory-s3.ts";

export const OWN = "https://accounts.example.test";
export const ENDPOINT = "https://acct0123.r2.cloudflarestorage.com";
export const BUCKET = "folder-sync";
export const MACHINE_AGENT = "folder-sync/v0-test (lab-pc; linux)";
const MIGRATIONS = new URL("../migrations/", import.meta.url);

type Row = Record<string, unknown>;

function value(v: unknown): unknown {
	if (v instanceof Date) return v.toISOString();
	if (typeof v === "boolean") return v ? 1 : 0;
	return v === undefined ? null : v;
}

const READS = /^\s*(select|pragma|with)\b|\breturning\b/i;

export function d1Of(db: DatabaseSync) {
	const shim = {
		/** Awaited after a query has run and before its result is delivered: return a promise to pause it. */
		hold: null as null | ((sql: string, values: unknown[]) => Promise<void> | void),
		prepare(sql: string) {
			const statement = (values: unknown[]) => {
				const exec = async () => {
					const st = db.prepare(sql);
					let out: { results: Row[]; meta: { changes: number; last_row_id: number | null } };
					if (READS.test(sql)) out = { results: st.all(...(values as never[])) as Row[], meta: { changes: 0, last_row_id: null } };
					else {
						const done = st.run(...(values as never[]));
						out = { results: [], meta: { changes: Number(done.changes), last_row_id: Number(done.lastInsertRowid) } };
					}
					if (shim.hold) await shim.hold(sql, values);
					return out;
				};
				return {
					bind: (...vs: unknown[]) => statement(vs.map(value)),
					all: exec,
					run: exec,
					async first(column?: string) {
						const row = (await exec()).results[0] ?? null;
						return column && row ? row[column] : row;
					},
					async raw() {
						return (await exec()).results.map((r) => Object.values(r));
					},
					exec,
				};
			};
			return statement([]);
		},
		async batch(statements: { exec(): Promise<unknown> }[]) {
			const out = [];
			for (const s of statements) out.push(await s.exec());
			return out;
		},
		async exec(sql: string) {
			db.exec(sql);
			return { count: 1, duration: 0 };
		},
	};
	return shim;
}

/** A cookie jar line from a response's Set-Cookie headers (cleared ones dropped). */
function cookiesOf(answer: Response, jar = new Map<string, string>()): Map<string, string> {
	for (const line of answer.headers.getSetCookie()) {
		const [pair] = line.split(";");
		const at = pair.indexOf("=");
		const name = pair.slice(0, at).trim();
		const v = pair.slice(at + 1).trim();
		if (/max-age=0/i.test(line) || v === "") jar.delete(name);
		else jar.set(name, v);
	}
	return jar;
}

export async function realStack(extra: Partial<Env> = {}) {
	const db = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
	const d1 = d1Of(db);
	const s3 = new MemoryS3(ENDPOINT, BUCKET);
	const env: Env = {
		ENVIRONMENT: "dev",
		PUBLIC_URL: OWN,
		DB: d1,
		BETTER_AUTH_SECRET: "test-secret-for-the-real-auth-harness-0123456789",
		SIGN_UP_EMAILS: "*",
		R2_ACCOUNT_ID: "acct0123",
		R2_PARENT_ACCESS_KEY_ID: "parent-key-id",
		R2_PARENT_SECRET_ACCESS_KEY: "parent-secret-fixture",
		SYNC_BUCKET: BUCKET,
		...extra,
	};
	const clock = { now: Date.now() };
	// the folder queue in this isolate (no Durable Object binding here), over the real D1 store
	const deps: Deps = { ...liveDeps(env)!, s3: s3.fetch, now: () => clock.now, webHost: undefined };
	const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
		handle(new Request(`${OWN}${path}`, { redirect: "manual", ...init, headers: { Origin: OWN, ...(init.headers || {}) } }), env, deps);
	const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
		call(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } });

	/** A browser signed in by email code: its Cookie header, user id and session id. */
	async function browser(email: string) {
		const sent = await post("/fs/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
		if (!sent.ok) throw new Error(`send code: ${sent.status} ${await sent.text()}`);
		const signed = await post("/fs/api/auth/sign-in/email-otp", { email, otp: deps.mailbox!(email) }, { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0.0.0 Safari/537.36" });
		if (!signed.ok) throw new Error(`sign in: ${signed.status} ${await signed.text()}`);
		const jar = cookiesOf(signed);
		const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
		const me = await (await call("/fs/v1/me", { headers: { Cookie: cookie } })).json();
		const devices = await (await call("/fs/v1/devices", { headers: { Cookie: cookie } })).json();
		const sessionId = devices.devices.find((d: { current: boolean }) => d.current).id as string;
		/** A write from this browser's own page. */
		const page = { Cookie: cookie, "X-Folder-Sync": "1", "X-Folder-Sync-User": me.user.id as string };
		return { cookie, userId: me.user.id as string, sessionId, page };
	}

	/** Asks for a device code as `folder-sync login` does. */
	async function deviceCode() {
		const answer = await post("/fs/api/auth/device/code", { client_id: "folder-sync" }, { "User-Agent": MACHINE_AGENT });
		if (!answer.ok) throw new Error(`device code: ${answer.status} ${await answer.text()}`);
		return (await answer.json()) as { device_code: string; user_code: string };
	}

	/** Claims and approves `userCode` with `auth` (a Cookie or an Authorization header): the device page's two calls. */
	async function approve(userCode: string, auth: Record<string, string>) {
		const claimed = await call(`/fs/api/auth/device?user_code=${encodeURIComponent(userCode)}`, { headers: auth });
		const approved = await post("/fs/api/auth/device/approve", { userCode }, auth);
		return { claimed: claimed.status, approved: approved.status, body: await approved.text() };
	}

	/** Redeems a device code (the CLI's poll): the bearer token, or the error answer. */
	async function redeem(code: string) {
		const answer = await post("/fs/api/auth/device/token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: code, client_id: "folder-sync" }, { "User-Agent": MACHINE_AGENT });
		const body = await answer.json();
		return { status: answer.status, token: (body.access_token as string | undefined) ?? null, body };
	}

	/** A machine signed in through the whole device grant, approved by `cookie`: its bearer token and session id. */
	async function machine(cookie: string) {
		const code = await deviceCode();
		const ok = await approve(code.user_code, { Cookie: cookie });
		if (ok.approved !== 200) throw new Error(`approve: ${ok.approved} ${ok.body}`);
		const { token } = await redeem(code.device_code);
		if (!token) throw new Error("no token");
		const devices = await (await call("/fs/v1/devices", { headers: { Authorization: `Bearer ${token}` } })).json();
		return { token, sessionId: devices.devices.find((d: { current: boolean }) => d.current).id as string };
	}

	return { env, deps, s3, db, d1, clock, call, post, browser, deviceCode, approve, redeem, machine };
}
