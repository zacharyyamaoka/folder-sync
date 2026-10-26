// The Worker's entry: the routes are app.ts, the accounts layer auth.ts (PEP 0003). Deploy config (wrangler.toml):
// vars ENVIRONMENT, PUBLIC_URL, R2_ACCOUNT_ID, SYNC_BUCKET, R2_ENDPOINT, SYNC_CREDENTIAL_TTL_S; secrets
// BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, R2_PARENT_ACCESS_KEY_ID, R2_PARENT_SECRET_ACCESS_KEY,
// SIGN_UP_EMAILS; the D1 database DB; the ASSETS binding (site/). Until the secrets and the database are there, every
// account route answers 503 and nothing can be read: no data is ever served signed out.

import { handle, type Env } from "./app.ts";
import { liveDeps } from "./auth.ts";

export type { Env } from "./app.ts";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		return handle(request, env, liveDeps(env));
	},
};
