// folder-sync's accounts (PEP 0003 §2-3): Better Auth on this Worker, its users and sessions in D1. Moved from Vibe
// Tracks' worker/src/auth.ts (PEP 0011b), with one change: one Better Auth instance per registered origin.
//
// - People sign in with Google (production) or a 6-digit email code (ENVIRONMENT=dev, the local proof only).
// - A machine signs in with the device authorization grant (RFC 8628, Better Auth's deviceAuthorization plugin):
//   `folder-sync login` shows a code, the person approves it at /fs/device while signed in, and the machine receives a
//   session of its own, used as a bearer token (the bearer plugin). That session IS the revocable device grant:
//   deleting it (`folder-sync logout`) stops the machine at its next credentials refresh.
// - Sessions last 90 days and renew while used, so a machine that syncs never has to sign in again.
//
// WHY one instance per origin (§2: "Many apps" loses 3 points for it): Better Auth's baseURL is per host, and each
// app's pages call /fs/ on their own domain, so the cookie is host-only there and Google's callback returns to
// https://<app>/fs/api/auth/callback/google. Every instance shares one D1 and one secret, so a person is one user
// everywhere and a machine's bearer token works on any of them. Simple Hosted Files v2.9 does the same.

import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { bearer, deviceAuthorization, emailOTP } from "better-auth/plugins";
import type { App } from "./apps.ts";
import type { Deps, Env, Person, Via } from "./app.ts";
import { signUpAllowed } from "./signup.ts";
import { d1Store, type D1Like } from "./store.ts";
import { webHostName } from "./webhost.ts";

const DAY_S = 24 * 60 * 60;
export const CLIENT_ID = "folder-sync";
export const BASE_PATH = "/fs/api/auth";

/** Dev only: the last code sent to each email, read by the local proof at /fs/dev/mailbox. */
const mailbox = new Map<string, string>();

export function createAuth(env: Env, origin: string) {
	const dev = env.ENVIRONMENT === "dev";
	const google = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
		? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, prompt: "select_account" as const }
		: null;
	return betterAuth({
		appName: "folder-sync",
		baseURL: origin,
		basePath: BASE_PATH,
		secret: env.BETTER_AUTH_SECRET,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		database: env.DB as any,
		trustedOrigins: [origin],
		session: { expiresIn: 90 * DAY_S, updateAge: DAY_S },
		// Dev signs many people in from one address, so the limiter is off there; in production it is counted in D1,
		// because Workers memory is per isolate.
		rateLimit: { enabled: !dev, storage: "database" },
		advanced: {
			// WHY a prefix of our own: an app on the same domain may run Better Auth too (Vibe Tracks does), and its
			// better-auth.session_token must never be mistaken for ours or overwritten by ours
			cookiePrefix: "folder-sync",
			ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
			// WHY: Better Auth awaits a schema check before its first request, and on Workers a cancelled first request
			// can leave it hanging (better-auth #11651, met by Simple Hosted Files); migrations/0001 is the schema.
			database: { validateSchema: false },
		},
		socialProviders: google && !dev ? { google } : {},
		databaseHooks: {
			user: {
				create: {
					// fs-mutation: the sign-up list. WHY: an account is storage; only invited emails get one (signup.ts).
					// WHY throw: Better Auth then answers 403 with this message (and Google's callback lands on the page's
					// errorCallbackURL), where returning false leaves a bare 500
					before: async (user: { email?: string }) => {
						if (!signUpAllowed(user.email, env.SIGN_UP_EMAILS)) {
							throw new APIError("FORBIDDEN", { code: "SIGN_UP_INVITE_ONLY", message: "Sign-up is invite-only here for now" });
						}
						return undefined;
					},
				},
			},
		},
		plugins: [
			deviceAuthorization({
				expiresIn: "15m",
				interval: "5s",
				// relative: Better Auth resolves it against this origin, so an app's own mount approves its own machines
				verificationUri: "/fs/device",
				// WHY one client: the only thing that signs a machine in is folder-sync; any other client id is refused
				validateClient: (clientId: string) => clientId === CLIENT_ID,
			}),
			bearer(),
			...(dev
				? [emailOTP({
					otpLength: 6,
					expiresIn: 300,
					sendVerificationOTP: async ({ email, otp }: { email: string; otp: string }) => {
						mailbox.set(email.toLowerCase(), otp);
					},
				})]
				: []),
		],
	});
}

type Auth = ReturnType<typeof createAuth>;
const cache = new WeakMap<object, Map<string, Auth>>();

function authFor(env: Env, origin: string): Auth {
	let byOrigin = cache.get(env);
	if (!byOrigin) {
		byOrigin = new Map();
		cache.set(env, byOrigin);
	}
	let auth = byOrigin.get(origin);
	if (!auth) {
		auth = createAuth(env, origin);
		byOrigin.set(origin, auth);
	}
	return auth;
}

function ownOrigin(env: Env): string {
	return new URL(env.PUBLIC_URL!).origin;
}

/** The live accounts layer, or null while the Worker has no database or secret (every account route then says so). */
export function liveDeps(env: Env): Deps | null {
	if (!env.DB || !env.BETTER_AUTH_SECRET || !env.PUBLIC_URL) return null;
	// The instance of the origin the request came in on (a bearer from an unlisted origin: this Worker's own)
	const instance = (request: Request, app: App | null) => authFor(env, app ? new URL(request.url).origin : ownOrigin(env));
	const sent = (request: Request, via: Via): Headers | null => {
		const out = new Headers();
		if (via === "bearer") {
			const authorization = request.headers.get("Authorization");
			if (!authorization || !/^bearer\s+\S/i.test(authorization)) return null;
			out.set("Authorization", authorization);
		} else {
			// WHY the cookie alone: a page request never authenticates through a bearer it was handed
			const cookie = request.headers.get("Cookie");
			if (!cookie) return null;
			out.set("Cookie", cookie);
		}
		const ua = request.headers.get("User-Agent");
		if (ua) out.set("User-Agent", ua);
		return out;
	};
	return {
		// the router only calls this for a registered origin, so the request's own origin is an app's
		auth: (request) => authFor(env, new URL(request.url).origin).handler(request),
		async person(request, via, app): Promise<Person | null> {
			const headers = sent(request, via);
			if (!headers) return null;
			const found = await instance(request, app).api.getSession({ headers });
			if (!found?.user?.id || !found.session?.id) return null;
			return {
				userId: found.user.id,
				email: found.user.email,
				name: found.user.name || null,
				image: found.user.image || null,
				sessionId: found.session.id,
				sessionToken: found.session.token,
			};
		},
		async signOut(request, via, app, person): Promise<string[]> {
			const auth = instance(request, app);
			const ctx = await auth.$context;
			await ctx.internalAdapter.deleteSession(person.sessionToken);
			if (via === "bearer") return [];
			// the browser's cookies, cleared the way Better Auth names them on this origin
			const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
			return [ctx.authCookies.sessionToken.name, ctx.authCookies.sessionData.name, ctx.authCookies.dontRememberToken.name].map(
				(name) => `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`,
			);
		},
		store: d1Store(env.DB as D1Like),
		s3: (request) => fetch(request),
		now: () => Date.now(),
		uuid: () => crypto.randomUUID(),
		mailbox: env.ENVIRONMENT === "dev" ? (email) => mailbox.get(email.toLowerCase()) ?? null : undefined,
		// WHY never this isolate's own queue: two isolates would each have one, and two writers again (review r1 #3)
		webHost: async (op) => {
			const objects = env.WEB_HOST;
			if (!objects) return { status: 503, body: { error: "not_configured", why: "the web host's Durable Object (WEB_HOST) is not bound on this Worker" } };
			return objects.get(objects.idFromName(webHostName(op.owner, op.project))).run(op);
		},
	};
}
