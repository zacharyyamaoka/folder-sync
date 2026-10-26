// The app registry (PEP 0003 §3.1): apps.json, `{ "<app id>": { "name", "origins": [..], "project" } }`. An app's
// domain forwards /fs/* here through a service binding, so the request's own URL names the app; an origin no entry
// lists gets no CORS, no sign-in and no cookie routes.
//
// "folder-sync" is this Worker's own host (the CLI's default server and the account pages): PUBLIC_URL's origin
// always belongs to it, so a deploy or a local `wrangler dev` on another port needs no edit here. Its /fs/v1/me
// answers app: null, because the accounts service is not an app with a default folder.

import registry from "../apps.json" with { type: "json" };

export interface App {
	id: string;
	name: string;
	origins: string[];
	project: string | null;
}

export const OWN_APP = "folder-sync";

export function apps(publicUrl: string | undefined, raw: Record<string, unknown> = registry, dev = true): Map<string, App> {
	const out = new Map<string, App>();
	for (const [id, value] of Object.entries(raw)) {
		if (!value || typeof value !== "object") continue;
		const entry = value as { name?: unknown; origins?: unknown; project?: unknown };
		// WHY https only outside dev: apps.json lists an app's local demo origins (http://127.0.0.1:<port>) beside its
		// real ones; in production a page on someone's loopback port must never count as that app (sign-in, cookie
		// routes, CORS). PUBLIC_URL's own origin, below, is the operator's and always counts.
		const origins = Array.isArray(entry.origins)
			? entry.origins.filter((o): o is string => typeof o === "string" && (dev || o.startsWith("https://")))
			: [];
		out.set(id, { id, name: typeof entry.name === "string" ? entry.name : id, origins, project: typeof entry.project === "string" ? entry.project : null });
	}
	let own: string | null = null;
	try {
		own = publicUrl ? new URL(publicUrl).origin : null;
	} catch {
		own = null;
	}
	if (own) {
		const self = out.get(OWN_APP) ?? { id: OWN_APP, name: "folder-sync", origins: [], project: null };
		if (!self.origins.includes(own)) self.origins = [...self.origins, own];
		out.set(OWN_APP, self);
	}
	return out;
}

/** The app an exact origin (scheme, host and port) belongs to, or null. */
export function appFor(origin: string | null | undefined, registered: Map<string, App>): App | null {
	if (!origin) return null;
	for (const app of registered.values()) {
		if (app.origins.includes(origin)) return app;
	}
	return null;
}
