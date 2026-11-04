// The accounts the storage breakdown's tests read (GET /fs/v1/usage/breakdown, accounts/src/storage.ts): `tiny`, small
// enough to check by hand, and `realistic`, the account the UI's screenshots and its Playwright test show (a project with ~4 MB
// append-only logs replaced many times into _trash). Both are plain MemoryS3 objects: nothing here calls the code under test.

import { MemoryS3 } from "./memory-s3.ts";
import { MemoryStore } from "./memory-store.ts";
import type { Person } from "../src/app.ts";

export const ENDPOINT = "https://acct0123.r2.cloudflarestorage.com";
export const BUCKET = "folder-sync";
export const NOW = Date.parse("2026-10-28T21:15:00.000Z");
export const OWNER: Person = { userId: "AbC123zz9yX8", email: "zach@example.com", name: "Zach", image: null, sessionId: "sess-owner", sessionToken: "tok-owner" };
export const OTHER: Person = { userId: "St4nger000001", email: "other@example.com", name: "Other", image: null, sessionId: "sess-other", sessionToken: "tok-other" };
export const ROOT = `users/${OWNER.userId}/`;
export const GPU = "b55e9683-7854-4121-a56a-9bae7c3ab1da";
export const WEB = "e2a0b1c2-d3e4-4f50-9a1b-2c3d4e5f6a7b";
export const LAPTOP = "7c1d2e3f-0a1b-4c2d-8e3f-405162738495";
export const HELPER = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";

/** `size` bytes without allocating them: a view of one shared buffer (the listing reads sizes only). */
const SHARED = new ArrayBuffer(8 * 1024 * 1024);
export const blob = (size: number): Uint8Array => new Uint8Array(SHARED, 0, size);

const manifest = (project: string, host: string, name: string) =>
	JSON.stringify({ schema: "folder-sync-manifest/1", project, host_id: host, host_name: name, seq: 1, generated_at: "2026-10-28T20:00:00.000Z", files: [] });

/** The `YYYYMMDDTHHMMSSZ` stamp of a legacy _trash key for an ISO instant. */
export const stamp = (iso: string): string => iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

export function accounts(): { s3: MemoryS3; store: MemoryStore } {
	const s3 = new MemoryS3(ENDPOINT, BUCKET);
	s3.now = () => NOW;
	return { s3, store: new MemoryStore() };
}

/** Small enough to add up by hand. The `notes` project: bam-GPU holds a 5 MB log whose six trashed copies grew as it
 *  did (append-only), 3 MB of photos five folders deep, and two versions of a note; the web host has one page. The
 *  `scratch` project's only host never published a manifest. */
export function tiny(s3: MemoryS3): void {
	const put = (key: string, data: string | Uint8Array, modified = "2026-10-28T20:00:00.000Z") => s3.put(`${ROOT}${key}`, data, Date.parse(modified));
	put(`notes/hosts/${GPU}/manifest.json`, manifest("notes", GPU, "bam-GPU"));
	put(`notes/hosts/${GPU}/notes/plan.md`, blob(2_000));
	put(`notes/hosts/${GPU}/logs/agent.log`, blob(5_000_000));
	put(`notes/hosts/${GPU}/photos/2026/trip/day1/IMG_1.jpg`, blob(3_000_000));
	put(`notes/hosts/${WEB}/manifest.json`, manifest("notes", WEB, "web"));
	put(`notes/hosts/${WEB}/site/index.html`, blob(700));
	for (const [at, size] of [["2026-10-05T12:00:00Z", 1_000_000], ["2026-10-10T12:00:00Z", 1_500_000], ["2026-10-15T12:00:00Z", 2_000_000], ["2026-10-20T12:00:00Z", 2_500_000], ["2026-10-22T12:00:00Z", 2_800_000], ["2026-10-26T18:00:00Z", 3_000_000]] as const) {
		put(`_trash/notes/${GPU}/${stamp(at)}-1a2b/logs/agent.log`, blob(size), at);
	}
	put(`_history/notes/${GPU}/notes/plan.md/2026-10-27T10:00:00.000Z_aaaaaaaaaaaaaaaa`, blob(1_800), "2026-10-27T11:00:00.000Z");
	put(`_history/notes/${GPU}/notes/plan.md/2026-10-01T10:00:00.000Z_bbbbbbbbbbbbbbbb`, blob(1_500), "2026-10-01T11:00:00.000Z");
	put(`_changes/notes/${GPU}/000000000001.json`, blob(300));
	put(`_changes/notes/${GPU}/pulls/2026-10-27T10:00:00.000Z.json`, blob(200), "2026-10-27T10:00:00.000Z");
	put(`_requests/notes/${WEB}/0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8.json`, blob(100));
	put(`scratch/hosts/${LAPTOP}/a.txt`, blob(10));
	put(`_trash/scratch/${LAPTOP}/20261027T000000Z-ffff/a.txt`, blob(10), "2026-10-27T00:00:00.000Z");
}

/** What the UI shows: ~1.03 GiB used of a 10 GiB quota, ~90% of it old copies of two append-only logs replaced many
 *  times into _trash, plus version history, change records and a second project. */
export function realistic(s3: MemoryS3, store: MemoryStore): void {
	const put = (key: string, data: string | Uint8Array, modified: string) => s3.put(`${ROOT}${key}`, data, Date.parse(modified));
	const day = 86_400_000;
	const iso = (ms: number) => new Date(ms).toISOString();
	put(`robotparts/hosts/${GPU}/manifest.json`, manifest("robotparts", GPU, "bam-GPU"), "2026-10-28T21:10:00.000Z");
	put(`robotparts/hosts/${LAPTOP}/manifest.json`, manifest("robotparts", LAPTOP, "bam-laptop"), "2026-10-27T18:00:00.000Z");
	put(`robotparts/hosts/${WEB}/manifest.json`, manifest("robotparts", WEB, "web"), "2026-10-28T20:50:00.000Z");
	const live: [string, string, number][] = [
		[GPU, "logs/agent.log", 4_300_000], [GPU, "logs/sim.log", 3_900_000], [GPU, "src/parts/catalog.json", 1_400_000],
		[GPU, "src/parts/mcmaster.py", 38_000], [GPU, "docs/notes/plan.md", 4_200], [GPU, "docs/notes/wrist-camera.md", 9_100],
		[LAPTOP, "photos/2026/lab/IMG_2231.jpg", 2_800_000], [LAPTOP, "photos/2026/lab/IMG_2232.jpg", 3_100_000], [LAPTOP, "photos/2026/trip/IMG_0007.jpg", 2_400_000],
		[LAPTOP, "cad/bracket-v3.step", 6_700_000], [WEB, "hearts/clamp-24.json", 233], [WEB, "hearts/arm-17.json", 241],
	];
	for (const [host, path, size] of live) put(`robotparts/hosts/${host}/${path}`, blob(size), "2026-10-28T20:00:00.000Z");
	// two append-only logs, each saved over about every 2.5 hours for 25 days into _trash/ (the layout before version history)
	for (const [path, from, to, every] of [["logs/agent.log", 3_300_000, 4_300_000, 4], ["logs/sim.log", 2_900_000, 3_900_000, 6]] as const) {
		const copies = Math.floor((25 * 24) / every);
		for (let n = 0; n < copies; n++) {
			const at = NOW - (copies - n) * every * 3_600_000;
			put(`_trash/robotparts/${GPU}/${stamp(iso(at))}-${(n * 7919).toString(16).padStart(4, "0").slice(-4)}/${path}`, blob(Math.round(from + ((to - from) * n) / copies)), iso(at));
		}
	}
	// version history of the sources and photos (the layout since version history)
	for (let n = 0; n < 9; n++) {
		const written = iso(NOW - (n + 1) * 2.7 * day);
		put(`_history/robotparts/${GPU}/src/parts/catalog.json/${written}_${(0xabc0 + n).toString(16).padStart(16, "0")}`, blob(1_150_000 + n * 20_000), iso(NOW - n * 2.7 * day));
	}
	for (let n = 0; n < 14; n++) {
		const written = iso(NOW - (n + 1) * 1.3 * day);
		put(`_history/robotparts/${GPU}/docs/notes/plan.md/${written}_${(0xdef0 + n).toString(16).padStart(16, "0")}`, blob(3_000 + n * 80), iso(NOW - n * 1.3 * day));
	}
	for (let n = 0; n < 3; n++) put(`_history/robotparts/${LAPTOP}/cad/bracket-v3.step/${iso(NOW - (n + 3) * 4 * day)}_${(0x1230 + n).toString(16).padStart(16, "0")}`, blob(6_400_000 + n * 100_000), iso(NOW - (n + 2) * 4 * day));
	for (let n = 1; n <= 120; n++) put(`_changes/robotparts/${GPU}/${String(n).padStart(12, "0")}.json`, blob(900 + (n % 7) * 40), iso(NOW - (121 - n) * 5 * 3_600_000));
	put(`_requests/robotparts/${WEB}/0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8.json`, blob(420), "2026-10-28T20:47:00.000Z");
	// a second, small project
	put(`notes/hosts/${HELPER}/manifest.json`, manifest("notes", HELPER, "mac-mini"), "2026-10-28T19:00:00.000Z");
	put(`notes/hosts/${HELPER}/ideas/old-ideas.md`, blob(5_121), "2026-10-21T09:00:00.000Z");
	put(`notes/hosts/${HELPER}/ideas/wrist.md`, blob(8_300), "2026-10-28T19:00:00.000Z");
	put(`_history/notes/${HELPER}/ideas/wrist.md/2026-10-27T10:00:00.000Z_0123456789abcdef`, blob(7_900), "2026-10-28T19:00:00.000Z");
	store.usageRows.set(OWNER.userId, { bytes: 0, objects: 0, measured_at: new Date(NOW).toISOString() });
}
