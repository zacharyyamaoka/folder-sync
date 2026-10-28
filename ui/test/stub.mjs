// A stub of the view API for <folder-sync-status>'s tests: it answers from the frozen fixtures in testdata/view-api/
// (read, never written) and serves the element's own files at /fs/ui/v1/, so the element runs exactly as embedded.
//
//   node ui/test/stub.mjs [--scenario online|serve|reader|public|offline] [--status <fixture>]   prints {"url"} and serves
//                                                                                                 until stopped
//   import { startStub } from "./stub.mjs"                                                        the tests
//
// A scenario is a list of fixture names. A request is answered by the first fixture in the list whose request has the
// same method and path (query included), else the same method and path without its query. A version's or a live
// file's bytes are not JSON fixtures; they come from BYTES below, and only for versions the history fixtures list.
// It listens on 127.0.0.1 on a port the OS picks.

import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = resolve(HERE, "..", "v1");
const FIXTURES = resolve(HERE, "..", "..", "testdata", "view-api");

export const fixtures = Object.fromEntries(readdirSync(FIXTURES).filter((f) => f.endsWith(".json"))
	.map((f) => [f.replace(/\.json$/, ""), { ...JSON.parse(readFileSync(join(FIXTURES, f), "utf8")), name: f.replace(/\.json$/, "") }]));

/** Every fixture any stub in this process answered with (the suite checks that each one was rendered). */
export const served = new Set();

export const GPU = "b55e9683-7854-4121-a56a-9bae7c3ab1da";
export const WEB = "e2a0b1c2-d3e4-4f50-9a1b-2c3d4e5f6a7b";
export const LAPTOP = "7c1d2e3f-0a1b-4c2d-8e3f-405162738495";

const PLAN = {
	v1402: "# Plan\n\n- order the clamp\n- print the bracket v2\n",
	unlisted: "# Plan\n\n- order the clamp\n- print the bracket v2\n- test the wrist camera\n",
	v1980: "# Plan\n\n- order the clamp\n- print the bracket v2\n- test the wrist camera\n- write up the latency numbers\n",
	v2140: "# Plan\n\n- order the clamp\n- print the bracket v3\n- test the wrist camera at 30 fps\n- write up the latency numbers\n",
};

/** The bytes the element reads besides JSON: `<host>/<path>` with `@<version id>`, or `@live` for the files route. */
export const BYTES = {
	[`${GPU}/notes/plan.md@live`]: PLAN.v1980,
	[`${GPU}/notes/plan.md@2026-10-28T20:41:00.410Z_7e3b9d0a1c2f4e5d`]: PLAN.v2140,
	[`${GPU}/notes/plan.md@2026-10-28T20:31:00.117Z_9f2c1a3b4c5d6e7f`]: PLAN.v1980,
	[`${GPU}/notes/plan.md@2026-10-28T20:00:00.000Z_unlisted`]: PLAN.unlisted,
	[`${GPU}/notes/plan.md@2026-10-28T18:02:41.502Z_1b2c3d4e5f607182`]: PLAN.v1402,
	[`${GPU}/notes/old-ideas.md@2026-10-21T09:12:44.500Z_5555666677778888`]: "# Old ideas\n\n- a cable-driven wrist\n- QDD everywhere\n",
};

export const SCENARIOS = {
	online: ["status-owner", "activity-online", "history", "history-deleted", "deleted", "restore-online", "purge-older", "error-pruned", "error-bad-version", "usage"],
	serve: ["status-serve", "activity-serve", "history", "history-deleted", "deleted", "restore-serve", "error-serve-online-only", "error-pruned", "error-bad-version", "folders-serve"],
	offline: ["status-serve-offline", "activity-serve", "history", "deleted", "restore-serve", "error-serve-online-only"],
	reader: ["status-reader", "error-reader-history"],
	public: ["status-public"],
};

const TYPES = { ".js": "text/javascript; charset=utf-8", ".html": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".json": "application/json" };

const APP = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>An app that syncs a folder</title>
<style>
  /* the host app's own CSS, deliberately hostile (PEP 0007 §11 spike): none of it may reach inside the element */
  body { margin: 0; font: 15px Georgia, serif; background: #fbfaf7; color: #222; }
  button { background: hotpink !important; font-size: 22px; color: #111 !important; }
  dialog, [popover] { background: lime !important; }
  .app { display: grid; grid-template-rows: 1fr 30px; height: 100vh; } .app.top { grid-template-rows: 30px 1fr; }
  main { padding: 28px 36px; overflow: auto; } h1 { font-weight: 400; margin: 0 0 8px; }
  footer { display: flex; justify-content: flex-end; align-items: center; padding: 0 10px; border-top: 1px solid #e4e1da; background: #f3f1ec; }
  footer.top { order: -1; border-top: 0; border-bottom: 1px solid #e4e1da; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #ddd; } footer { background: #1a1a1a; border-color: #333; } }
</style></head>
<body><div class="app"><main><h1>An app that syncs a folder</h1><p>Its own page, its own fonts, a hostile <code>button</code>
rule. The sync view is one element in its status bar.</p><p><button class="pill ring" id="page-button">The page's own button</button></p></main>
<footer id="bar"></footer></div>
<script>
  const q = new URLSearchParams(location.search), el = document.createElement("folder-sync-status");
  el.setAttribute("project", q.get("project") || "notes");
  for (const a of ["owner", "base", "view"]) if (q.has(a)) el.setAttribute(a, q.get(a));
  if (q.has("theme")) document.querySelector(".app").setAttribute("style", q.get("theme"));
  if (q.get("bar") === "top") { document.getElementById("bar").className = "top"; document.querySelector(".app").classList.add("top"); }
  (q.has("view") ? document.querySelector("main") : document.getElementById("bar")).append(el);
  window.__events = [];
  for (const name of ["folder-sync:status", "folder-sync:restored"]) document.addEventListener(name, (e) => window.__events.push({ name, detail: e.detail }));
</script>
<script type="module" src="/fs/ui/v1/folder-sync.js"></script>
</body></html>`;

/** Starts a stub on 127.0.0.1:<free port>. `scenario` is a SCENARIOS key or a list of fixture names; `first` puts
 *  fixtures ahead of it (e.g. an error answer for status). */
export function startStub({ scenario = "online", first = [] } = {}) {
	let names = [...first, ...(Array.isArray(scenario) ? scenario : SCENARIOS[scenario])];
	const requests = [], routes = [];
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const body = Buffer.concat(chunks).toString("utf8");
		const url = new URL(req.url, "http://stub.invalid");
		requests.push({ method: req.method, path: url.pathname + url.search, headers: req.headers, body: body ? safeJson(body) : undefined });
		const send = (status, data, type = "application/json") => {
			res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
			res.end(type === "application/json" ? JSON.stringify(data) : data);
		};
		if (url.pathname === "/" || url.pathname === "/app.html") return send(200, APP, TYPES[".html"]);
		if (url.pathname.startsWith("/fs/ui/v1/")) {
			const file = resolve(UI, url.pathname.slice("/fs/ui/v1/".length));
			if (!file.startsWith(UI + "/")) return send(404, { error: "not_found", why: "No such file." });
			try { return send(200, readFileSync(file), TYPES[extname(file)] || "application/octet-stream"); } catch { return send(404, { error: "not_found", why: "No such file." }); }
		}
		for (const r of routes) {
			if (r.method !== req.method || !r.match(url)) continue;
			const name = r.answers.length > 1 ? r.answers.shift() : r.answers[0];
			served.add(name);
			return send(fixtures[name].response.status, fixtures[name].response.body);
		}
		const folder = url.pathname.match(/^\/fs\/v1\/folders\/notes\/(files|history)\/([^/]+)\/(.+)$/);
		const version = url.searchParams.get("version");
		if (folder && (folder[1] === "files" || version)) {
			const key = `${folder[2]}/${decodeURIComponent(folder[3])}@${folder[1] === "files" ? "live" : version}`;
			if (key in BYTES) return send(200, BYTES[key], TYPES[extname(folder[3])] || "application/octet-stream");
		}
		const pick = (match) => names.map((n) => fixtures[n]).find((f) => f && f.request.method === req.method && match(f.request.path));
		const own = (p) => p.replace(/[?&]owner=[^&]*/, "").replace(/\?$/, "");
		const full = url.pathname + url.search, bare = url.pathname;
		const fixture = pick((p) => p === full) || pick((p) => own(p) === own(full)) || pick((p) => p.split("?")[0] === bare && !version);
		if (!fixture) return send(404, { error: "not_found", why: "No such folder." });
		served.add(fixture.name);
		send(fixture.response.status, fixture.response.body);
	});
	return new Promise((ready) => server.listen(0, "127.0.0.1", () => {
		const url = `http://127.0.0.1:${server.address().port}`;
		ready({
			url, requests, server,
			use(next) { names = Array.isArray(next) ? next : SCENARIOS[next]; },
			prepend(...more) { names = [...more, ...names]; },
			/** Answers `method` requests whose URL passes `match` with these fixtures in turn (the last one repeats). */
			route(method, match, ...answers) { routes.push({ method, match, answers }); },
			close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
		});
	}));
}

function safeJson(s) { try { return JSON.parse(s); } catch { return s; } }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
	const status = arg("--status");
	const stub = await startStub({ scenario: arg("--scenario", "online"), first: status ? [status] : [] });
	console.log(JSON.stringify({ url: stub.url, pid: process.pid }));
	const stop = () => stub.close().then(() => process.exit(0));
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}
