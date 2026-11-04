// One deployment per app (docs/NEW-APP.md): two accounts Workers share the one sync bucket, and a Better Auth id is
// only unique inside its own D1, so the same id can be two different people. ROOT_PREFIX gives each app its own root
// (apps/robotparts/users/<id>/) and the default "" keeps the existing deployment's keys (users/<id>/) unchanged.
//
// Two Workers on one MemoryS3, the SAME user id in both, each with its own store (its own D1): what they write, list,
// sign and count must never meet.

import assert from "node:assert/strict";
import { test } from "node:test";
import { handle, type Deps, type Env, type Person } from "../src/app.ts";
import { claimsOf, mint, rootPrefixOf, userRoot } from "../src/creds.ts";
import { MemoryS3 } from "./memory-s3.ts";
import { MemoryStore } from "./memory-store.ts";

const SITE = "https://robotparts.dev";
const ENDPOINT = "https://acct0123.r2.cloudflarestorage.com";
const BUCKET = "folder-sync";
const APP_ROOT = "apps/robotparts/";
// WHY one id for both: the collision the prefix exists for (two D1s can mint the same id for two different people)
const SAME_ID: Person = { userId: "sameIdABC123", email: "someone@example.com", name: "Someone", image: null, sessionId: "sess-browser", sessionToken: "token-laptop" };

function env(extra: Partial<Env> = {}): Env {
	return {
		ENVIRONMENT: "production",
		PUBLIC_URL: "https://accounts.example.test",
		R2_ACCOUNT_ID: "acct0123",
		R2_PARENT_ACCESS_KEY_ID: "parent-key-id",
		R2_PARENT_SECRET_ACCESS_KEY: "parent-secret-fixture",
		SYNC_BUCKET: BUCKET,
		...extra,
	};
}

/** One deployment: its own store (D1), the shared bucket, a browser cookie and a machine's bearer for the same id. */
function deployment(s3: MemoryS3, extra: Partial<Env> = {}) {
	const store = new MemoryStore();
	const deps: Deps = {
		async auth() { return new Response("{}", { headers: { "Content-Type": "application/json" } }); },
		async person(request, via) {
			if (via === "bearer") return /bearer token-laptop/i.test(request.headers.get("Authorization") || "") ? { ...SAME_ID, sessionId: "sess-laptop" } : null;
			return /(?:^|;\s*)s=sess-browser/.test(request.headers.get("Cookie") || "") ? SAME_ID : null;
		},
		async signOut() { return []; },
		store,
		s3: s3.fetch,
		now: () => Date.parse("2026-11-04T12:00:00Z"),
		uuid: () => "3f1c2a9e-5b7d-4c11-8e2f-0a1b2c3d4e5f",
	};
	const e = env(extra);
	const go = (path: string, init: RequestInit = {}) => handle(new Request(`${SITE}${path}`, init), e, deps);
	const write = (path: string, body: string) => go(path, { method: "PUT", headers: { Cookie: "s=sess-browser", Origin: SITE, "X-Folder-Sync": "1", "X-Folder-Sync-User": SAME_ID.userId }, body });
	return { e, deps, store, go, write };
}

/** Waits for the folder's queue (and the change records it writes after answering): a read settles through it. */
async function drain(d: ReturnType<typeof deployment>) {
	await d.go("/fs/v1/folders/robotparts", { headers: { Cookie: "s=sess-browser" } });
}

test("a root is <ROOT_PREFIX>users/<id>/: empty keeps users/<id>/, a malformed prefix is refused", () => {
	assert.equal(userRoot(SAME_ID.userId), `users/${SAME_ID.userId}/`);
	assert.equal(userRoot(SAME_ID.userId, {}), `users/${SAME_ID.userId}/`);
	assert.equal(userRoot(SAME_ID.userId, { ROOT_PREFIX: "" }), `users/${SAME_ID.userId}/`);
	assert.equal(userRoot(SAME_ID.userId, { ROOT_PREFIX: APP_ROOT }), `${APP_ROOT}users/${SAME_ID.userId}/`);
	assert.equal(rootPrefixOf({ ROOT_PREFIX: "a/b/c/d/" }), "a/b/c/d/");
	for (const bad of ["apps", "/apps/", "apps//x/", "../x/", "apps/../x/", "./", "apps/ x/", "users", "a/b/c/d/e/", "apps\\x/"]) {
		assert.throws(() => rootPrefixOf({ ROOT_PREFIX: bad }), bad);
		assert.throws(() => userRoot(SAME_ID.userId, { ROOT_PREFIX: bad }), bad);
	}
});

test("mint signs for this deployment's root only: the other app's root and a bare users/ root are refused", async () => {
	const now = Date.parse("2026-11-04T12:00:00Z");
	const mine = userRoot(SAME_ID.userId, { ROOT_PREFIX: APP_ROOT });
	const minted = await mint(env({ ROOT_PREFIX: APP_ROOT }), mine, "object-read-only", 60, now);
	assert.equal(minted.Prefix, mine);
	assert.deepEqual((claimsOf(minted.SessionToken).paths as { prefixPaths: string[] }).prefixPaths, [mine]);
	await mint(env({ ROOT_PREFIX: APP_ROOT }), `${mine}robotparts/`, "object-read-only", 60, now);
	await assert.rejects(mint(env({ ROOT_PREFIX: APP_ROOT }), userRoot(SAME_ID.userId), "object-read-only", 60, now), /one person's root or folder/);
	await assert.rejects(mint(env(), mine, "object-read-only", 60, now), /one person's root or folder/);
	await assert.rejects(mint(env({ ROOT_PREFIX: APP_ROOT }), APP_ROOT, "object-read-only", 60, now), /one person's root or folder/);
	await assert.rejects(mint(env({ ROOT_PREFIX: APP_ROOT }), `${APP_ROOT}users/`, "object-read-only", 60, now));
	await assert.rejects(mint(env({ ROOT_PREFIX: "../x/" }), "../x/users/sameIdABC123/", "object-read-only", 60, now));
});

test("two deployments, one bucket, the same user id: their keys, folders, credentials and usage never meet", async () => {
	const s3 = new MemoryS3(ENDPOINT, BUCKET);
	const original = deployment(s3); // the existing deployment: no ROOT_PREFIX
	const robot = deployment(s3, { ROOT_PREFIX: APP_ROOT });

	assert.equal((await original.write("/fs/v1/folders/robotparts/web/notes/a.txt", "from the original\n")).status, 200);
	assert.equal((await robot.write("/fs/v1/folders/robotparts/web/notes/a.txt", "from the new app\n")).status, 200);
	await drain(original);
	await drain(robot);

	// 1. every key is under exactly one deployment's root, and the bytes under each are that deployment's own
	const keys = [...s3.objects.keys()];
	const oldRoot = `users/${SAME_ID.userId}/`;
	const newRoot = `${APP_ROOT}users/${SAME_ID.userId}/`;
	const old = keys.filter((k) => k.startsWith(oldRoot));
	const fresh = keys.filter((k) => k.startsWith(newRoot));
	assert.ok(old.length && fresh.length, `both wrote: ${keys.join(", ")}`);
	assert.deepEqual(keys.filter((k) => !k.startsWith(oldRoot) && !k.startsWith(newRoot)), [], "nothing outside the two roots");
	assert.ok(old.every((k) => !k.startsWith(APP_ROOT)), "the original's keys do not start with the app root");
	assert.ok(!old.some((k) => s3.text(k).includes("new app")), "no new-app byte under the original's root");
	assert.ok(!fresh.some((k) => s3.text(k).includes("original")), "no original byte under the new app's root");

	// 2. each reads its own bytes back through its own routes
	for (const [d, want, other] of [[original, "from the original", "new app"], [robot, "from the new app", "original"]] as const) {
		const bundle = await (await d.go("/fs/v1/folders/robotparts/bundle?prefix=notes/", { headers: { Cookie: "s=sess-browser" } })).json();
		assert.deepEqual(bundle.files.map((f: { text: string }) => f.text), [`${want}\n`], "its own bytes, and only those");
		void other;
		const me = await (await d.go("/fs/v1/me", { headers: { Cookie: "s=sess-browser" } })).json();
		assert.equal(me.root, d === original ? oldRoot : newRoot);
		const access = await (await d.go("/fs/v1/access?project=robotparts", { headers: { Cookie: "s=sess-browser" } })).json();
		assert.equal(access.root, d === original ? oldRoot : newRoot);
	}

	// 3. a machine's credentials cover its own deployment's root, and R2 refuses the other's keys
	const fetched: Record<string, { Prefix: string; SessionToken: string }> = {};
	for (const [name, d] of [["original", original], ["robot", robot]] as const) {
		const answer = await d.go("/fs/v1/credentials", { method: "POST", headers: { Authorization: "Bearer token-laptop" } });
		assert.equal(answer.status, 200, name);
		fetched[name] = await answer.json();
	}
	assert.equal(fetched.original.Prefix, oldRoot);
	assert.equal(fetched.robot.Prefix, newRoot);
	assert.deepEqual((claimsOf(fetched.robot.SessionToken).paths as { prefixPaths: string[] }).prefixPaths, [newRoot]);
	const probe = async (token: string, key: string) => (await s3.fetch(new Request(`${ENDPOINT}/${BUCKET}/${key}`, { headers: { "X-Amz-Security-Token": token } }))).status;
	assert.equal(await probe(fetched.robot.SessionToken, fresh[0]), 200, "the app's own key");
	assert.equal(await probe(fetched.robot.SessionToken, old[0]), 403, "the original's key with the app's credentials");
	assert.equal(await probe(fetched.original.SessionToken, old[0]), 200, "the original's own key");
	assert.equal(await probe(fetched.original.SessionToken, fresh[0]), 403, "the app's key with the original's credentials");

	// 4. usage is counted for the id in each deployment's own store, not for the prefix
	assert.ok((original.store.usageRows.get(SAME_ID.userId)?.objects ?? 0) > 0, "the original counted its own write");
	assert.ok((robot.store.usageRows.get(SAME_ID.userId)?.objects ?? 0) > 0, "the app counted its own write under the bare id");
	assert.deepEqual([...robot.store.usageRows.keys()], [SAME_ID.userId], "usage rows are keyed by the account id, never by a root");
});

test("a malformed ROOT_PREFIX answers 503 on every route that would touch storage", async () => {
	const s3 = new MemoryS3(ENDPOINT, BUCKET);
	for (const bad of ["apps", "../x/", "/apps/", "apps//x/"]) {
		const d = deployment(s3, { ROOT_PREFIX: bad });
		const credentials = await d.go("/fs/v1/credentials", { method: "POST", headers: { Authorization: "Bearer token-laptop" } });
		assert.equal(credentials.status, 503, `credentials with ROOT_PREFIX ${bad}`);
		const folders = await d.go("/fs/v1/folders", { headers: { Cookie: "s=sess-browser" } });
		assert.equal(folders.status, 503, `folders with ROOT_PREFIX ${bad}`);
		const write = await d.write("/fs/v1/folders/robotparts/web/a.txt", "x");
		assert.equal(write.status, 503, `web write with ROOT_PREFIX ${bad}`);
	}
	assert.equal(s3.objects.size, 0, "nothing was written");
});
