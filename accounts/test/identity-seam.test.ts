// Seam 2 of PARTS.md: the server reaches identity only through one small function, `deps.person(request, via, app)`
// (the port: "whoIs(request) -> person | null"), and Better Auth sits behind it in one file, the identity adapter
// accounts/src/auth.ts. Swapping Better Auth for a company's SSO means rewriting that file and nothing else.
//
// Two checks, both static (a read of the source, no Worker started):
// - no file of the server part but the adapter imports better-auth (or any better-auth/* subpath);
// - no file of the server part but the Worker entry (index.ts, which wires liveDeps into the router) imports the adapter,
//   so a route cannot reach createAuth or Better Auth's handler around the port.
// `scan` is a pure function of the files' text, so the last test can show it goes red on a violation.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ACCOUNTS = fileURLToPath(new URL("..", import.meta.url));
const REPO = join(ACCOUNTS, "..");
/** The identity adapter: the one file that may import better-auth. */
const ADAPTER = "accounts/src/auth.ts";
/** The one file that may import the adapter: it hands liveDeps to the router. */
const WIRING = "accounts/src/index.ts";
/** The server part's source: the accounts Worker and the demo Worker. node_modules and tests are not source. */
const SOURCE_DIRS = ["accounts/src", "demo"];
const SOURCE_FILE = /\.(ts|mts|js|mjs)$/;
const SKIP_DIRS = new Set(["node_modules", "site", "test", "vendor"]);

const IMPORTS_BETTER_AUTH = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'`]better-auth(?:\/[^"'`]*)?["'`]/;
const IMPORTS_ADAPTER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'`]\.\/auth(?:\.ts|\.js)?["'`]/;

function sources(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
		const path = `${dir}/${entry.name}`;
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) out.push(...sources(path));
		} else if (SOURCE_FILE.test(entry.name)) out.push(path);
	}
	return out;
}

/** Which of these files import better-auth, and which import the adapter. */
function scan(files: Record<string, string>): { betterAuth: string[]; adapter: string[] } {
	const betterAuth: string[] = [];
	const adapter: string[] = [];
	for (const [path, text] of Object.entries(files)) {
		if (IMPORTS_BETTER_AUTH.test(text)) betterAuth.push(path);
		if (IMPORTS_ADAPTER.test(text)) adapter.push(path);
	}
	return { betterAuth: betterAuth.sort(), adapter: adapter.sort() };
}

function serverSource(): Record<string, string> {
	return Object.fromEntries(SOURCE_DIRS.flatMap(sources).map((path) => [path, readFileSync(join(REPO, path), "utf8")]));
}

test("only the identity adapter imports better-auth", () => {
	const found = scan(serverSource());
	assert.deepEqual(found.betterAuth, [ADAPTER], "reach identity through deps.person (accounts/src/app.ts Deps), not through Better Auth");
});

test("only the Worker entry imports the identity adapter", () => {
	const found = scan(serverSource());
	assert.deepEqual(found.adapter, [WIRING], "a route takes a Person from deps.person; it never builds or calls the adapter itself");
});

test("the scan can fail: a route that imports better-auth, or the adapter, is caught", () => {
	const clean = { [ADAPTER]: 'import { betterAuth } from "better-auth";', [WIRING]: 'import { liveDeps } from "./auth.ts";', "accounts/src/app.ts": "export const x = 1;" };
	assert.deepEqual(scan(clean), { betterAuth: [ADAPTER], adapter: [WIRING] });
	for (const bad of ['import { getSessionFromCtx } from "better-auth/api";', "const { betterAuth } = await import('better-auth');", 'const a = require("better-auth/plugins");', 'import "better-auth";']) {
		assert.deepEqual(scan({ ...clean, "accounts/src/view.ts": bad }).betterAuth, [ADAPTER, "accounts/src/view.ts"], bad);
	}
	assert.deepEqual(scan({ ...clean, "accounts/src/view.ts": 'import { createAuth } from "./auth.ts";' }).adapter, ["accounts/src/index.ts", "accounts/src/view.ts"]);
	// a comment or a string that only names the package is not an import
	assert.deepEqual(scan({ "accounts/src/x.ts": '// better-auth #11651\nconst name = "better-auth.session_token";' }), { betterAuth: [], adapter: [] });
});
