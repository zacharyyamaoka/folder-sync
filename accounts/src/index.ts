// The Worker's entry: the routes are app.ts, the accounts layer auth.ts (PEP 0003). Deploy config (wrangler.toml):
// vars ENVIRONMENT, PUBLIC_URL, R2_ACCOUNT_ID, SYNC_BUCKET, R2_ENDPOINT, SYNC_CREDENTIAL_TTL_S, QUOTA_*, EMAIL_FROM;
// secrets BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, RESEND_API_KEY, R2_PARENT_ACCESS_KEY_ID,
// R2_PARENT_SECRET_ACCESS_KEY, SIGN_UP_EMAILS; the D1 database DB; the Durable Objects WEB_HOST (one web-host writer per
// folder) and HUB (one push hub per folder, PEP 0004); the ASSETS binding (site/). Until the secrets and the database
// are there, every account route answers 503 and nothing can be
// read: no data is ever served signed out.

import { handle, type Env } from "./app.ts";
import { liveDeps } from "./auth.ts";

export type { Env } from "./app.ts";
// the folder's one web-host writer (wrangler.toml's WEB_HOST binding)
export { WebHostObject } from "./webhost-do.ts";
// the folder's push hub (wrangler.toml's HUB binding)
export { FolderHub } from "./hub.ts";

export default {
	async fetch(request: Request, env: Env, ctx: { waitUntil(work: Promise<unknown>): void }): Promise<Response> {
		const deps = liveDeps(env);
		if (deps) deps.waitUntil = (work) => ctx.waitUntil(work);
		return handle(request, env, deps);
	},
};
