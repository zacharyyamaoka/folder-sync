// The plans of a deployment with payments on (PEP 0003 §3.11, docs/PAYMENTS.md): a plan is a storage ceiling, and a paid
// plan is also a Stripe price a person can buy. The free plan is no subscription at all: QUOTA_BYTES / QUOTA_OBJECTS.
//
// PLANS (a wrangler var, JSON): { "<plan id>": { "title", "bytes", "objects", "lookupKey" | "priceId" } }. The id is the plan's name
// to @better-auth/stripe (it stores it lower-cased in `subscription.plan`, which is what quota.ts reads back). A plan with
// neither a lookupKey nor a priceId cannot be bought and is left out. Unset, or not valid JSON of that shape, the defaults
// below stand; WHY defaults at all: the set-secrets guide tells Zach to make two products with these lookup keys, so a new
// app needs no PLANS var to sell them.

export interface PlanEnv {
	PLANS?: string;
	QUOTA_BYTES?: string;
	QUOTA_OBJECTS?: string;
}

export interface Plan {
	id: string;
	title: string;
	bytes: number;
	objects: number;
	/** Stripe: the price's lookup key (docs.stripe.com/products-prices/manage-prices#lookup-keys) or its id. */
	lookupKey?: string;
	priceId?: string;
}

const GIB = 1024 ** 3;

export const DEFAULT_PLANS: Plan[] = [
	{ id: "plus", title: "Plus", bytes: 10 * GIB, objects: 250_000, lookupKey: "folder-sync-plus" },
	{ id: "pro", title: "Pro", bytes: 100 * GIB, objects: 1_000_000, lookupKey: "folder-sync-pro" },
];

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const STRIPE_REF = /^[A-Za-z0-9_.-]{1,255}$/;

function whole(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/** The paid plans, in the order PLANS lists them (or the defaults). */
export function plansOf(env: PlanEnv): Plan[] {
	if (!env.PLANS) return DEFAULT_PLANS;
	let parsed: unknown;
	try {
		parsed = JSON.parse(env.PLANS);
	} catch {
		return DEFAULT_PLANS;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_PLANS;
	const out: Plan[] = [];
	for (const [id, raw] of Object.entries(parsed)) {
		const entry = (raw ?? {}) as Record<string, unknown>;
		const bytes = whole(entry.bytes);
		const objects = entry.objects === undefined ? 100_000 : whole(entry.objects);
		const lookupKey = typeof entry.lookupKey === "string" && STRIPE_REF.test(entry.lookupKey) ? entry.lookupKey : undefined;
		const priceId = typeof entry.priceId === "string" && STRIPE_REF.test(entry.priceId) ? entry.priceId : undefined;
		// WHY "free" is refused as an id: it is the name of having no subscription
		if (!ID.test(id) || id === "free" || bytes === null || bytes === 0 || objects === null || (!lookupKey && !priceId)) continue;
		out.push({ id, title: typeof entry.title === "string" && entry.title.trim() ? entry.title.trim().slice(0, 40) : id, bytes, objects, ...(lookupKey ? { lookupKey } : {}), ...(priceId ? { priceId } : {}) });
	}
	return out.length ? out : DEFAULT_PLANS;
}

/** The plan every account is on without a subscription. */
export function freePlan(env: PlanEnv): Plan {
	const bytes = Number(env.QUOTA_BYTES);
	const objects = Number(env.QUOTA_OBJECTS);
	return { id: "free", title: "Free", bytes: env.QUOTA_BYTES && Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : GIB, objects: env.QUOTA_OBJECTS && Number.isFinite(objects) && objects >= 0 ? Math.floor(objects) : 100_000 };
}
