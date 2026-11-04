// The four switches of one deployment (docs/NEW-APP.md, PEP 0003 §3.11): each app's wrangler env turns each of these on or
// off with a var, and a switch that is off hides its UI and refuses its routes (feature_off, 404: the route does not exist
// on this app).
//
//   FEATURE_STORAGE   online file storage: the web host (browser writes and deletes of a folder's files) and the Files page.
//                     Default on.
//   FEATURE_SYNC      local file sync: the device flow (`folder-sync login`) and the scoped storage keys a machine
//                     gets. Default on.
//   FEATURE_PAYMENTS  plans that set the storage quota, bought through Stripe in test mode (billing.ts). Default OFF.
//   FEATURE_BYO       a person's own S3-compatible bucket, handed to their machines instead of the service's (byo.ts).
//                     Default OFF.
//
// WHY storage and sync default on and the other two off: an existing deployment sets none of these vars and must keep
// working as it does; a new app (docs/NEW-APP.md) gets storage and sync, and asks for payments and bring-your-own.
// WHY an unrecognised value is off: a typo ("yess") must never switch payments on, and for the two default-on switches it
// is the loud side of the mistake; an empty var is unset, so it keeps the default.

export const FEATURES = ["storage", "sync", "payments", "byo"] as const;
export type Feature = (typeof FEATURES)[number];

export interface FeatureEnv {
	FEATURE_STORAGE?: string;
	FEATURE_SYNC?: string;
	FEATURE_PAYMENTS?: string;
	FEATURE_BYO?: string;
}

const VAR: Record<Feature, keyof FeatureEnv> = { storage: "FEATURE_STORAGE", sync: "FEATURE_SYNC", payments: "FEATURE_PAYMENTS", byo: "FEATURE_BYO" };
const DEFAULT: Record<Feature, boolean> = { storage: true, sync: true, payments: false, byo: false };
/** What each switch is called to a person, for the refusal. */
export const FEATURE_NAME: Record<Feature, string> = { storage: "online file storage", sync: "local file sync", payments: "payments", byo: "bring your own storage" };

export function featuresOf(env: FeatureEnv): Record<Feature, boolean> {
	const out = { ...DEFAULT };
	for (const feature of FEATURES) {
		const raw = env[VAR[feature]]?.trim().toLowerCase();
		if (!raw) continue;
		out[feature] = raw === "on" || raw === "true" || raw === "1";
	}
	return out;
}

/** 404 { error: "feature_off" }: this deployment has the feature switched off. */
export function featureOff(feature: Feature): Response {
	const why = `${FEATURE_NAME[feature]} is switched off on this app (${VAR[feature]})`;
	return new Response(JSON.stringify({ error: "feature_off", why }), {
		status: 404,
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" },
	});
}
