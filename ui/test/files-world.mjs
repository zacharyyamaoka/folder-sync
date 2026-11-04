// A folder's files for the Files tab's tests: the answers of the Worker's listing, bytes, web PUT and DELETE routes
// (PEP 0003 §3.3), kept in memory and installed on a page with page.route. Everything the tab does not ask this world
// (status, activity, history, deleted files) falls through to test/stub.mjs and its frozen fixtures, so the tab runs
// exactly as embedded. The shapes are the Worker's: accounts/test/files-page.test.ts pins them against the real handle.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { GPU, LAPTOP, WEB, fixtures } from "./stub.mjs";

export const OWNER_ID = "AbC123zz9yX8";
const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
export const PLAN = "# Plan\n\n- order the clamp\n- print the bracket v3\n- test the wrist camera at 30 fps\n- write up the latency numbers\n";
export const TYPES = {
	".md": "text/markdown; charset=utf-8", ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8",
	".png": "image/png", ".pdf": "application/pdf", ".webm": "video/webm", ".wav": "audio/wav", ".step": "application/step",
};

/** Folder `project`'s files. `visibility` is what the listing says; `owner` its owner's id. */
export function world({ project = "notes", visibility = "private" } = {}) {
	const hosts = [
		{ id: GPU, name: "bam-GPU", seq: 46, generatedAt: "2026-11-04T10:00:00.000Z", web: false },
		{ id: WEB, name: "web", seq: 7, generatedAt: "2026-11-04T09:30:00.000Z", web: true },
		{ id: LAPTOP, name: "bam-laptop", seq: 12, generatedAt: "2026-11-02T14:05:00.000Z", web: false },
	];
	const files = new Map();
	const requests = [];
	const add = (host, path, data, mtime) => files.set(`${host}\n${path}`, { host, path, data: Buffer.from(data), mtime });
	add(GPU, "notes/plan.md", PLAN, "2026-11-04T09:58:00.000Z");
	add(GPU, "notes/todo.json", '{\n  "todo": ["clamp", "bracket"]\n}\n', "2026-11-03T18:00:00.000Z");
	add(GPU, "photos/lab.png", fixture("tiny.png"), "2026-11-01T12:00:00.000Z");
	add(GPU, "docs/spec.pdf", fixture("tiny.pdf"), "2026-10-30T12:00:00.000Z");
	add(GPU, "clips/demo.webm", fixture("tiny.webm"), "2026-10-29T12:00:00.000Z");
	add(GPU, "audio/beep.wav", fixture("tiny.wav"), "2026-10-28T12:00:00.000Z");
	add(GPU, "cad/bracket.step", "ISO-10303-21;\nEND-ISO-10303-21;\n", "2026-10-27T12:00:00.000Z");
	add(GPU, "logs/agent.log", "line of a long log\n".repeat(60_000), "2026-11-04T09:59:00.000Z");
	add(LAPTOP, "readme.md", "# bam-laptop\n\nthe laptop's own notes\n", "2026-11-02T14:00:00.000Z");
	add(WEB, "hearts/clamp-24.json", '{"part": "clamp-24", "saved": true}\n', "2026-11-04T09:30:00.000Z");
	add(WEB, "welcome.md", "# Welcome\n\nAdded on the web.\n", "2026-11-03T09:30:00.000Z");

	const sha = (data) => createHash("sha256").update(data).digest("hex");
	const listing = () => ({
		project, owner: OWNER_ID, visibility, hosts,
		files: [...files.values()].map((f) => ({ host: f.host, path: f.path, size: f.data.length, sha256: sha(f.data), mtime: f.mtime, writtenAt: f.mtime })),
	});
	let seq = 7;
	const clock = { now: () => new Date().toISOString() };

	/** Installs the routes on `page`. `fixturesStub` is the stub whose requests list the tab's other calls land in. */
	async function install(page) {
		await page.route((url) => /^\/fs\/v1\/folders(\/|$)/.test(url.pathname), async (route) => {
			const request = route.request(), url = new URL(request.url());
			const match = url.pathname.match(/^\/fs\/v1\/folders(?:\/([^/]+)(?:\/(.*))?)?$/);
			if (!match) return route.fallback();
			const [, name, tail = ""] = match;
			const [kind, ...more] = tail.split("/");
			const rest = more.join("/");
			if (kind !== "files" && kind !== "web" && kind !== "") return name === "robotparts" && kind === "status" ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...fixtures["status-owner"].response.body, project: "robotparts" }) }) : route.fallback();
			const json = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
			if (!name) return json(200, { folders: [{ project, visibility, hosts: hosts.map((h) => h.id) }, { project: "robotparts", visibility: "private", hosts: [] }], readable: [] });
			if (name === "robotparts" && !kind && request.method() === "GET") return json(200, { project: "robotparts", owner: OWNER_ID, visibility: "private", hosts: [], files: [] });
			if (name !== project) return route.fallback();
			if (!kind) return request.method() === "GET" ? (requests.push({ method: "GET", path: "list" }), json(200, listing())) : route.fallback();
			const parts = rest.split("/").map(decodeURIComponent);
			if (kind === "files") {
				const host = parts.shift(), path = parts.join("/"), f = files.get(`${host}\n${path}`);
				requests.push({ method: request.method(), path: `files/${host}/${path}` });
				if (!f) return json(404, { error: "not_found", why: "that host does not publish that file" });
				const type = TYPES[extname(path)] || "application/octet-stream";
				const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range || "");
				if (range) {
					const from = Number(range[1]), to = Math.min(f.data.length - 1, range[2] ? Number(range[2]) : f.data.length - 1);
					return route.fulfill({ status: 206, headers: { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": `bytes ${from}-${to}/${f.data.length}` }, body: f.data.subarray(from, to + 1) });
				}
				return route.fulfill({ status: 200, headers: { "Content-Type": type, "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff" }, body: f.data });
			}
			// the web host: PUT and DELETE …/web/<path> (a cookie write needs the CSRF headers and the user the page shows)
			const path = parts.join("/"), headers = request.headers();
			requests.push({ method: request.method(), path: `web/${path}`, headers, body: request.postDataBuffer() || undefined });
			if (headers["x-folder-sync"] !== "1") return json(403, { error: "csrf", why: "a browser's write must carry X-Folder-Sync: 1 from this site's own pages" });
			if (headers["x-folder-sync-user"] !== OWNER_ID) return json(409, { error: "wrong_user", why: "this page is signed in as someone else (or does not say who): reload it" });
			if (request.method() === "PUT") {
				const data = request.postDataBuffer() || Buffer.alloc(0);
				if (path === "manifest.json") return json(400, { error: "bad_path", why: "manifest.json at the root of a folder is the manifest's own key" });
				files.set(`${WEB}\n${path}`, { host: WEB, path, data, mtime: clock.now() });
				return json(200, { host: WEB, path, sha256: sha(data), seq: ++seq });
			}
			if (request.method() === "DELETE") {
				if (!files.delete(`${WEB}\n${path}`)) return json(404, { error: "not_found", why: "that path is not in the web host" });
				return json(200, { host: WEB, path, seq: ++seq });
			}
			return json(405, { error: "method", why: "PUT or DELETE" });
		});
	}

	return { hosts, files, requests, install, listing, has: (host, path) => files.has(`${host}\n${path}`), read: (host, path) => files.get(`${host}\n${path}`)?.data };
}
