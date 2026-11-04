// GET /fs/files: the standalone Files page (docs/API.md "The Files tab"). The page is a shell: the element
// <folder-sync-status view="files"> (ui/v1) does the work, mounted by /fs/site/files.js, so the page and the tab an app
// embeds are one piece of code and speak the same routes (listing, bytes, web PUT and DELETE, history).
//
// WHY its own policy and not PAGE_POLICY: that one is for pages that hold a session and show nothing of anyone's files;
// this one shows the person's own files, so a preview needs `media-src` (audio, video), `frame-src` (a PDF) and the
// element's own inline styles (Shadow DOM `<style>` and `style=` attributes: `style-src 'unsafe-inline'`, styles cannot
// run script). Nothing else is loosened: scripts, connections, frames of other origins and forms stay 'self' or 'none'.
// The files themselves come from /fs/v1/folders/…/files/…, typed by suffix, nosniff, and `sandbox` for .html and .svg.

import type { App } from "./apps.ts";
import { escapeAttr, headers, session, type Deps, type Env } from "./app.ts";

export const FILES_POLICY = [
	"default-src 'none'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	"media-src 'self'",
	"frame-src 'self'",
	"connect-src 'self'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
	"object-src 'none'",
].join("; ");

export async function filesPage(request: Request, deps: Deps | null, app: App, head: boolean): Promise<Response> {
	if (!deps) return new Response(JSON.stringify({ error: "not_configured", why: "accounts are not set up on this Worker yet" }), { status: 503, headers: headers({ "Content-Type": "application/json; charset=utf-8" }) });
	const who = await session(request, deps, app);
	if (!who) {
		// signed out: sign in, then straight back (the same page and project)
		const url = new URL(request.url);
		return new Response(null, { status: 303, headers: headers({ Location: `/fs/signin?return=${encodeURIComponent(url.pathname + url.search)}` }) });
	}
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Files · ${escapeAttr(app.name)}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/fs/site/files.css">
</head>
<body>
<header class="fsf-top"><b class="fsf-title">Files</b><span class="fsf-app">${escapeAttr(app.name)}</span><span class="fsf-grow"></span><span class="fsf-who">${escapeAttr(who.person.email)}</span><a href="/fs/account">Account</a></header>
<main id="files" data-user="${escapeAttr(who.person.userId)}"><p class="fsf-note">Loading your files…</p></main>
<script src="/fs/site/files.js"></script>
</body>
</html>
`;
	const out = headers({ "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": FILES_POLICY, "X-Frame-Options": "DENY" });
	// WHY same-origin: the element's own writes are same-origin fetches, which send Origin whatever the policy; kept the
	// account page's value so one rule covers both pages
	out.set("Referrer-Policy", "same-origin");
	return new Response(head ? null : html, { status: 200, headers: out });
}
