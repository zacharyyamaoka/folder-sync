// Each person's storage ceiling (PEP 0003 §3.7, review r1 #7). Anyone may sign up (SIGN_UP_EMAILS=*), and an account
// is a prefix of the operator's bucket, so each person gets at most QUOTA_BYTES and QUOTA_OBJECTS under users/<id>/.
//
// WHY enforced where it is: a machine writes to R2 directly with its temporary credential, and R2's credentials scope
// a prefix, never a size; so once the person is over, the Worker issues read-only keys (deletes then go through it,
// app.ts machineDelete) and refuses web writes, measured by listing their root at most once every QUOTA_RECHECK_S and
// cached in D1. The bound is honest, not exact: past the line a machine keeps the read-write keys it holds until they
// expire (SYNC_CREDENTIAL_TTL_S, 300 s by default), and the
// measurement can be QUOTA_RECHECK_S old, so one person can go over by what they upload in about ten minutes.

import type { Store } from "./store.ts";

export interface QuotaEnv {
	/** Bytes per person (default 1 GiB). */
	QUOTA_BYTES?: string;
	/** Objects per person, _trash/ included (default 100 000). */
	QUOTA_OBJECTS?: string;
	/** How old a measurement may be before it is taken again, in seconds (default 300). */
	QUOTA_RECHECK_S?: string;
}

export interface Quota {
	bytes: number;
	objects: number;
	recheckS: number;
}

export interface Usage {
	bytes: number;
	objects: number;
	measured_at: string;
}

function positive(value: string | undefined, fallback: number): number {
	const n = Number(value);
	return value && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function quotaOf(env: QuotaEnv): Quota {
	return { bytes: positive(env.QUOTA_BYTES, 1024 ** 3), objects: positive(env.QUOTA_OBJECTS, 100_000), recheckS: positive(env.QUOTA_RECHECK_S, 300) };
}

/** No measurement can be had yet: another is under way, or the last one failed less than a minute ago (503). */
export class Measuring extends Error {}

/** How long a measurement's claim lasts: one measurement per person in that time, and a failed one is not retried
 *  sooner (review r2 #8). */
export const CLAIM_MS = 60_000;

/** The person's usage: the cached measurement while it is fresh, else `measure()` (stored for next time). WHY a claim
 *  in D1 first: thirty machines refreshing at once must cost one listing of the root (up to a hundred pages), not
 *  thirty; and a listing that fails is not repeated by every request behind it. Without the claim, the last
 *  measurement serves while there is one, else Measuring. */
export async function usageOf(store: Store, owner: string, quota: Quota, now: number, measure: () => Promise<{ bytes: number; objects: number }>): Promise<Usage> {
	const cached = await store.usage(owner);
	const known = cached && cached.measured_at ? cached : null;
	if (known && now - Date.parse(known.measured_at) < quota.recheckS * 1000) return known;
	if (!(await store.claimMeasurement(owner, now, now + CLAIM_MS))) {
		if (known) return known;
		throw new Measuring("this account's storage is being measured (or could not be, just now); try again in a minute");
	}
	let counted: { bytes: number; objects: number };
	try {
		counted = await measure();
	} catch (error) {
		if (known) return known;
		throw new Measuring(`this account's storage could not be measured (${error instanceof Error ? error.message : String(error)}); try again in a minute`);
	}
	const measured = { ...counted, measured_at: new Date(now).toISOString() };
	await store.setUsage(owner, measured.bytes, measured.objects, measured.measured_at);
	return measured;
}

/** Why `usage` plus what is about to be added is over `quota`, or null when it is not. */
export function overQuota(usage: { bytes: number; objects: number }, quota: Quota, addBytes = 0, addObjects = 0): string | null {
	const gib = (n: number) => `${(n / 1024 ** 3).toFixed(2)} GiB`;
	if (usage.bytes + addBytes > quota.bytes) return `this account holds ${usage.bytes} bytes (${gib(usage.bytes)}) of its ${quota.bytes} (${gib(quota.bytes)}): delete files, or ask the operator for more`;
	if (usage.objects + addObjects > quota.objects) return `this account holds ${usage.objects} files of its ${quota.objects}: delete files, or ask the operator for more`;
	return null;
}
