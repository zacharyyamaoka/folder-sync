// folder-sync's demo site (PEP 0007 §6): one static page, and /fs/* forwarded to the accounts Worker through a service
// binding, exactly as every app does it (PEP 0003 §3.2, §3.6). It holds no auth, storage or write code of its own.
//
// WHY forwarded unchanged (method, body, cookies, Origin): the accounts Worker names the app by the request's own
// origin (apps.json "demo"), its CSRF rule reads the Origin and X-Folder-Sync, and its sign-in callback reads the
// cookies; the session cookie stays host-only on this origin, so the page calls only its own origin.

type Fetcher = { fetch(request: Request): Promise<Response> };

interface Env {
	ASSETS: Fetcher; // site/ (wrangler.toml [assets])
	FOLDER_SYNC: Fetcher; // the folder-sync-accounts Worker (wrangler.toml [[services]])
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (new URL(request.url).pathname.startsWith("/fs/")) return env.FOLDER_SYNC.fetch(request);
		// WHY a fallback here too: run_worker_first sends only /fs/* to this code, but a request that reaches it any
		// other way still gets the static page, never an error
		return env.ASSETS.fetch(request);
	},
};
