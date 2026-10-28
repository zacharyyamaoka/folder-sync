// The desktop app's public download page (PEP 0006): /fs/download on every app that mounts /fs/, and on this Worker's
// own host. It lists the latest installers and serves them, all from the DOWNLOADS bucket that CI fills
// (.github/workflows/desktop-release.yml, app/scripts/release_assets.py):
//   downloads/desktop/latest.json              folder-sync-downloads/1, written last, so it only names files that exist
//   downloads/desktop/<tag>/<file>             each installer and its SHA256SUMS, never rewritten for a tag
// Routes: GET /fs/download (the page), /fs/download/latest.json, /fs/download/<tag>/<file>.
// WHY its own bucket, not a downloads/ prefix in the sync bucket: an R2 API token is scoped per bucket, never per
// prefix, so CI's upload token on the sync bucket could write every person's files. This bucket holds nothing private.
// WHY no sign-in: Zach installs on machines that have no session yet; the files are the app, nothing of anyone's.

import type { App } from "./apps.ts";
import { escapeAttr, fail, headers, json, PAGE_POLICY, type Env } from "./app.ts";

/** The slice of an R2 bucket binding this route reads (wrangler.toml's DOWNLOADS; a Map-backed stand-in in tests). */
export interface DownloadsBucket {
	get(key: string): Promise<{ body: ReadableStream | null; size: number; httpEtag?: string; text(): Promise<string> } | null>;
	head(key: string): Promise<{ size: number; httpEtag?: string } | null>;
}

export interface DownloadFile {
	name: string;
	os: "macos" | "windows" | "linux";
	arch: string;
	kind: string;
	label: string;
	size: number;
	sha256: string;
	key: string;
}

export interface DownloadManifest {
	schema: "folder-sync-downloads/1";
	tag: string;
	version: string;
	commit: string;
	published: string;
	files: DownloadFile[];
}

const LATEST = "downloads/desktop/latest.json";
const TAG = /^desktop-v[0-9A-Za-z.+-]{1,40}$/;
const NAME = /^[0-9A-Za-z][0-9A-Za-z._-]{0,120}$/;
const SHA = /^[0-9a-f]{64}$/;
const OS_NAMES: Record<DownloadFile["os"], string> = { macos: "Mac", windows: "Windows", linux: "Linux" };

/** latest.json, or null when nothing is published or it breaks the schema (then the page says so; it never guesses). */
export async function latest(bucket: DownloadsBucket | undefined): Promise<DownloadManifest | null> {
	if (!bucket) return null;
	const object = await bucket.get(LATEST);
	if (!object) return null;
	let value: unknown;
	try {
		value = JSON.parse(await object.text());
	} catch {
		return null;
	}
	return valid(value) ? value : null;
}

function valid(value: unknown): value is DownloadManifest {
	const m = value as DownloadManifest;
	if (!m || m.schema !== "folder-sync-downloads/1" || typeof m.tag !== "string" || !TAG.test(m.tag) || !Array.isArray(m.files)) return false;
	return m.files.every((f) => f && typeof f.name === "string" && NAME.test(f.name) && f.os in OS_NAMES && typeof f.size === "number" && SHA.test(f.sha256) && f.key === `downloads/desktop/${m.tag}/${f.name}`);
}

/** The visitor's OS from the User-Agent: which installer leads the page. Null: show all three equally. */
export function osOf(agent: string | null): DownloadFile["os"] | null {
	if (!agent) return null;
	if (/Windows NT/i.test(agent)) return "windows";
	if (/Macintosh|Mac OS X/i.test(agent) && !/iPhone|iPad/i.test(agent)) return "macos";
	if (/Linux|X11/i.test(agent) && !/Android/i.test(agent)) return "linux";
	return null;
}

export async function downloadRoute(request: Request, env: Env, app: App | null, rest: string[], method: string): Promise<Response> {
	if (method !== "GET" && method !== "HEAD") return fail(405, "method", "GET only", { Allow: "GET, HEAD" });
	const head = method === "HEAD";
	const bucket = env.DOWNLOADS;
	if (rest.length === 0 || (rest.length === 1 && rest[0] === "")) return page(app, await latest(bucket), osOf(request.headers.get("User-Agent")), head);
	if (rest.length === 1 && rest[0] === "latest.json") {
		const manifest = await latest(bucket);
		return manifest ? json(200, manifest, { "Cache-Control": "no-cache" }) : fail(404, "not_found", "no desktop release is published yet");
	}
	if (rest.length !== 2 || !TAG.test(rest[0]) || !NAME.test(rest[1]) || !bucket) return fail(404, "not_found", "no such download");
	const key = `downloads/desktop/${rest[0]}/${rest[1]}`;
	const object = head ? await bucket.head(key) : await bucket.get(key);
	if (!object) return fail(404, "not_found", "no such download");
	const text = rest[1] === "SHA256SUMS";
	const out = headers({
		"Content-Type": text ? "text/plain; charset=utf-8" : "application/octet-stream",
		"Content-Length": String(object.size),
		// WHY immutable: a tag's files are never rewritten (CI publishes a new tag instead)
		"Cache-Control": "public, max-age=31536000, immutable",
	});
	if (!text) out.set("Content-Disposition", `attachment; filename="${rest[1]}"`);
	if (object.httpEtag) out.set("ETag", object.httpEtag);
	return new Response(head ? null : (object as { body: ReadableStream | null }).body, { status: 200, headers: out });
}

function size(bytes: number): string {
	return `${(bytes / 1e6).toFixed(1)} MB`;
}

function link(manifest: DownloadManifest, file: DownloadFile): string {
	return `/fs/download/${encodeURIComponent(manifest.tag)}/${encodeURIComponent(file.name)}`;
}

/** The first-run steps for an unsigned build, per OS (the release notes say the same: app/release/NOTES.md). */
const STEPS: Record<DownloadFile["os"], string> = {
	macos: `<ol>
<li>Open the <code>.dmg</code> and drag <b>folder-sync</b> into Applications.</li>
<li>Open it. macOS says it cannot verify the developer: click <b>Done</b>.</li>
<li>System Settings → Privacy &amp; Security → <b>Open Anyway</b>. (macOS 14 and older: right-click the app → Open.)</li>
<li>If it says the app "is damaged": run <code>xattr -dr com.apple.quarantine /Applications/folder-sync.app</code> in Terminal, then open it again.</li>
</ol>`,
	windows: `<ol>
<li>Run the <code>-setup.exe</code> (installs for you only, no admin).</li>
<li>SmartScreen says "Windows protected your PC": click <b>More info → Run anyway</b>.</li>
<li>folder-sync starts in the tray, bottom right (maybe under the <b>^</b>).</li>
</ol>`,
	linux: `<ol>
<li>AppImage: <code>chmod +x</code> it, then run it. GNOME needs the AppIndicator extension for the tray.</li>
<li>Debian / Ubuntu: <code>sudo apt install ./folder-sync-…-linux-amd64.deb</code>.</li>
</ol>`,
};

function page(app: App | null, manifest: DownloadManifest | null, mine: DownloadFile["os"] | null, head: boolean): Response {
	const name = app?.name ?? "folder-sync";
	let inner: string;
	if (!manifest || manifest.files.length === 0) {
		inner = `<h1>Download folder-sync</h1>
<p data-testid="fs-download-none">No desktop release is published yet.</p>`;
	} else {
		const order: DownloadFile["os"][] = mine ? [mine, ...(["macos", "windows", "linux"] as const).filter((os) => os !== mine)] : ["macos", "windows", "linux"];
		const sections = order
			.map((os) => {
				const files = manifest.files.filter((f) => f.os === os);
				if (files.length === 0) return "";
				const rows = files
					.map((f, i) => `<li class="fs-device" data-file="${escapeAttr(f.name)}">
<div class="fs-device-text"><a class="fs-device-name" href="${escapeAttr(link(manifest, f))}">${escapeAttr(f.label)}</a>
<span class="fs-small fs-dl-file">${escapeAttr(f.name)} · ${size(f.size)}</span>
<code class="fs-sha" title="SHA-256">${escapeAttr(f.sha256)}</code></div>
<a class="fs-dl${os === mine && i === 0 ? " fs-dl-primary" : ""}" href="${escapeAttr(link(manifest, f))}">Download</a>
</li>`)
					.join("\n");
				const here = os === mine ? ' <span class="fs-tag">This computer</span>' : "";
				return `<h2 data-os="${os}">${OS_NAMES[os]}${here}</h2>
<ul class="fs-devices fs-dl-list">
${rows}
</ul>
<details class="fs-steps"${os === mine ? " open" : ""}><summary>First run on ${OS_NAMES[os]}</summary>
${STEPS[os]}
</details>`;
			})
			.join("\n");
		inner = `<h1>Download folder-sync</h1>
<p>A folder you can throw anything into and open on any of your computers. Version <b data-testid="fs-download-version">${escapeAttr(manifest.version)}</b>, published ${escapeAttr(manifest.published.slice(0, 10))}.</p>
<p class="fs-notice">These builds are not signed yet, so your computer warns the first time you open the app. The steps under each download get past it once.</p>
${sections}
<p class="fs-small">Check a download: <code>shasum -a 256</code> (Mac), <code>Get-FileHash</code> (Windows), <code>sha256sum</code> (Linux), against the SHA-256 above or <a href="${escapeAttr(`/fs/download/${encodeURIComponent(manifest.tag)}/SHA256SUMS`)}">SHA256SUMS</a>.</p>`;
	}
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Download folder-sync · ${escapeAttr(name)}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/fs/site/account.css">
</head>
<body>
<main class="fs-cover fs-dl-cover" data-testid="fs-download"><div class="fs-card fs-wide">
${inner}
<p class="fs-foot">One account for your folders, on every machine and online.</p>
</div></main>
</body>
</html>
`;
	// short cache: a new release shows up within a minute; the files themselves are immutable
	return new Response(head ? null : html, {
		status: 200,
		headers: headers({ "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PAGE_POLICY, "X-Frame-Options": "DENY", "Cache-Control": "public, max-age=60" }),
	});
}
