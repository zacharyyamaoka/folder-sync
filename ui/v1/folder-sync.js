// <folder-sync-status>: the one sync view every app embeds (PEP 0007 §5, docs/API.md "The element").
//
//   <script type="module" src="/fs/ui/v1/folder-sync.js"></script>
//   <folder-sync-status project="notes"></folder-sync-status>
//
// Obsidian Sync's model: a pill with the folder's state; clicking it opens a menu (the native `popover`) with the
// status, an amber warning only when the person must act, the devices, Activity log, Version history, Deleted files,
// and online the storage and a link to /fs/account. Each opens a panel in a native <dialog> (or inline, with `view`).
// Everything is in Shadow DOM, so an app's CSS cannot reach in and ours cannot reach out; the app themes it with
// --fs-* custom properties and ::part(pill | menu | panel). Data comes only from this page's own origin, from the
// accounts Worker online or `folder-sync serve` on the machine, which answer the same routes (docs/API.md "Routes").
// "Show changes" is jsdiff's diffLines, vendored at ./vendor/diff.js and loaded the first time a diff is shown.

const POLL_MS = 10_000;
const HUB_PING_MS = 30_000;
const FREE_UP_DAYS = 7;
const TEXT_LIMIT = 1_048_576;
const SPLIT_KEY = "folder-sync-status/history-split";
const VIEWS = { activity: "Activity log", history: "Version history", deleted: "Deleted files" };
const FILTERS = { all: "All", errors: "Errors", skipped: "Skipped", conflicts: "Conflicts" };

// WHY every colour is var(--fs-x, default): a custom property set on :host would override one the app sets on an
// ancestor, so the defaults live in the fallback and the app's value, wherever it is set, always wins. The derived
// tones (lines, soft fills, diff colours) are mixed from the app's colours, so they follow its theme too.
const css = `
:host { display: inline-block; --_font: var(--fs-font, system-ui, -apple-system, "Segoe UI", sans-serif);
  --_fg: var(--fs-fg, #1f2328); --_bg: var(--fs-bg, #ffffff); --_muted: var(--fs-muted, #656d76);
  --_accent: var(--fs-accent, #0969da); --_warn: var(--fs-warn, #9a6700); --_error: var(--fs-error, #cf222e);
  --_radius: var(--fs-radius, 8px); font: 13px/1.45 var(--_font); color: var(--_fg); }
@media (prefers-color-scheme: dark) { :host { --_fg: var(--fs-fg, #e6edf3); --_bg: var(--fs-bg, #0d1117);
  --_muted: var(--fs-muted, #8d96a0); --_accent: var(--fs-accent, #4493f8); --_warn: var(--fs-warn, #d29922);
  --_error: var(--fs-error, #f85149); } }
:host([hidden]) { display: contents; } :host([hidden]) .pill { display: none; }
:host([view]) { display: block; }
* { box-sizing: border-box; }
.wrap { --_line: color-mix(in srgb, var(--_fg) 16%, var(--_bg)); --_soft: color-mix(in srgb, var(--_fg) 6%, var(--_bg));
  --_warn-bg: color-mix(in srgb, var(--_warn) 13%, var(--_bg)); --_err-bg: color-mix(in srgb, var(--_error) 11%, var(--_bg));
  --_add: color-mix(in srgb, #2da44e 18%, var(--_bg)); --_del: color-mix(in srgb, var(--_error) 15%, var(--_bg)); }
button, input, select { font: inherit; color: inherit; }
button, a.button { background: none; border: 1px solid var(--_line); border-radius: calc(var(--_radius) - 2px); padding: 3px 10px;
  cursor: pointer; } button:hover:not(:disabled), a.button:hover { background: var(--_soft); }
a.button { color: inherit; text-decoration: none; display: inline-block; } button:disabled { opacity: .5; cursor: default; }
button.primary { background: var(--_accent); border-color: var(--_accent); color: #fff; }
button.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--_accent) 88%, #000); }
button.link { border: 0; padding: 0; color: inherit; text-align: left; text-decoration: underline dotted var(--_muted);
  text-underline-offset: 2px; } button.link:hover { background: none; color: var(--_accent); }
:focus-visible { outline: 2px solid var(--_accent); outline-offset: 1px; }
a { color: var(--_accent); }
.pill { display: inline-flex; align-items: center; gap: 6px; border: 0; padding: 2px 8px; color: var(--_muted); white-space: nowrap; }
.pill .count { color: var(--_warn); }
.ring { width: 9px; height: 9px; border-radius: 50%; border: 1.5px solid var(--_muted); flex: none; }
[data-state="syncing"] .ring { border-color: var(--_accent); border-right-color: transparent; animation: spin 1s linear infinite; }
[data-state="attention"] .ring { border-color: var(--_warn); background: var(--_warn); }
[data-state="error"] .ring { border-color: var(--_error); background: var(--_error); }
[data-state="offline"] .ring, [data-state="unknown"] .ring { border-style: dashed; }
@media (prefers-reduced-motion: reduce) { [data-state="syncing"] .ring { animation: none; } }
@keyframes spin { to { transform: rotate(360deg); } }
.menu:not([data-placed]) { visibility: hidden; }
.menu { margin: 0; inset: auto; border: 1px solid var(--_line); border-radius: var(--_radius); padding: 4px; width: 300px;
  max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow: auto; background: var(--_bg); color: var(--_fg);
  box-shadow: 0 8px 24px rgba(0,0,0,.14); }
.menu .item { display: flex; width: 100%; border: 0; text-align: left; padding: 6px 10px; gap: 8px; text-decoration: none;
  color: inherit; border-radius: calc(var(--_radius) - 3px); } .menu a.item:hover { background: var(--_soft); }
.menu .head { padding: 8px 10px 6px; } .menu .head b { display: block; }
.sep { border-top: 1px solid var(--_line); margin: 4px 0; }
.note { border-radius: calc(var(--_radius) - 2px); padding: 6px 10px; margin: 4px 6px; }
.note.warn { background: var(--_warn-bg); color: var(--_warn); } .note.error { background: var(--_err-bg); color: var(--_error); }
.note.info { background: var(--_soft); }
.devices { list-style: none; margin: 0; padding: 2px 10px 6px; }
.devices li { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0 8px; padding: 2px 0; }
.devices li > span:first-child { overflow-wrap: anywhere; } .devices li > span:last-child { margin-left: auto; }
.storage { padding: 6px 10px; } .bar { height: 6px; border-radius: 3px; background: var(--_soft); overflow: hidden; display: flex; margin: 5px 0; }
.bar i { display: block; background: var(--_accent); } .bar i + i { background: var(--_muted); }
.confirm { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 6px; }
.muted { color: var(--_muted); } .warn { color: var(--_warn); } .err { color: var(--_error); } .grow { flex: 1; }
dialog.panel { border: 1px solid var(--_line); border-radius: calc(var(--_radius) + 2px); padding: 0;
  width: min(940px, 94vw); height: min(640px, 90vh); max-width: none; max-height: none; background: var(--_bg); color: var(--_fg); }
dialog.panel::backdrop { background: rgba(0,0,0,.28); }
div.panel { border: 1px solid var(--_line); border-radius: calc(var(--_radius) + 2px); background: var(--_bg); color: var(--_fg);
  height: max(480px, 70vh); }
.frame { display: grid; grid-template-rows: auto 1fr; height: 100%; min-height: 0; }
.tabs { display: flex; gap: 2px; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--_line); flex-wrap: wrap; }
.tabs [role="tab"] { border: 0; } .tabs [role="tab"][aria-selected="true"] { background: var(--_soft); font-weight: 600; }
.tabs .where { margin: 0 8px; }
.body { overflow: auto; padding: 12px 14px; min-height: 0; }
.tools { display: flex; gap: 6px; margin-bottom: 10px; align-items: center; flex-wrap: wrap; }
.seg { display: inline-flex; border: 1px solid var(--_line); border-radius: calc(var(--_radius) - 2px); overflow: hidden; }
.seg button { border: 0; border-radius: 0; } .seg button[aria-pressed="true"] { background: var(--_soft); font-weight: 600; }
input[type="search"] { flex: 1; min-width: 140px; padding: 4px 8px; border: 1px solid var(--_line); border-radius: calc(var(--_radius) - 2px);
  background: var(--_bg); }
.log { font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
.log .row { display: grid; grid-template-columns: 70px 110px 1fr auto; gap: 8px; padding: 1px 0; align-items: baseline; }
.log .row > * { min-width: 0; overflow-wrap: anywhere; } .log time, .log .who, .log .ms { color: var(--_muted); }
.log .ms { text-align: right; white-space: nowrap; } .log .day { color: var(--_muted); padding: 8px 0 2px; font-weight: 600; }
.log .row.warn span.what { color: var(--_warn); } .log .row.error span.what { color: var(--_error); }
.split { display: grid; grid-template-columns: var(--fs-split-w, 260px) 7px minmax(0, 1fr); height: 100%; min-height: 0; }
.split > .side { overflow: auto; min-width: 0; padding-right: 6px; }
.handle { cursor: col-resize; position: relative; touch-action: none; }
.handle::after { content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 1px; background: var(--_line); }
.handle:hover::after, .handle:focus-visible::after, .handle.dragging::after { left: 2px; width: 3px; background: var(--_accent); }
.split > .main { overflow: auto; min-width: 0; padding-left: 10px; display: flex; flex-direction: column; }
.versions { list-style: none; margin: 0; padding: 0; }
.versions button { display: block; width: 100%; text-align: left; border: 0; padding: 6px 8px; }
.versions button[aria-current="true"] { background: var(--_soft); }
.versions small, .files small { display: block; color: var(--_muted); }
.files { list-style: none; margin: 0; padding: 0; } .files li { padding: 5px 0; border-bottom: 1px solid var(--_line); }
pre.text { margin: 0; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
pre.text .add { background: var(--_add); display: block; } pre.text .del { background: var(--_del); display: block;
  text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--_error) 55%, transparent); }
pre.text .same { display: block; }
table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: 6px 6px; border-bottom: 1px solid var(--_line); vertical-align: middle; }
th { font-weight: 600; color: var(--_muted); } td.num { white-space: nowrap; }
.empty { color: var(--_muted); padding: 24px 0; text-align: center; }
`;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
const pad = (n) => String(n).padStart(2, "0");
const clock = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const when = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const ago = (iso) => {
	if (!iso) return "never";
	const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
	return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
// "↑ 0.4 s": each sync's own measure (CONTRACT "Sync times"). WHY never clamped: down_ms reads two clocks and may be
// negative under skew; it is shown as measured, and the title says so
const seconds = (ms) => `${ms < 0 ? "−" : ""}${(Math.abs(ms) / 1000).toFixed(1)} s`;
const encPath = (path) => path.split("/").map(encodeURIComponent).join("/");
const writtenOf = (version) => version.slice(0, version.lastIndexOf("_"));
const keyOf = (host, path) => `${host}\n${path}`;

/** A failed answer: the server's { error, why } when it sent one, else the HTTP status. */
class ViewError extends Error {
	constructor(status, code, why) {
		super(why);
		this.status = status;
		this.code = code;
	}
}

/** What one activity line says, or null for a line the log does not show (readers skip what they do not know). */
function say(e) {
	const kept = e.was && e.was.kept === null ? ` · old version not kept (${e.was.why === "burst" ? "inside a burst" : e.was.why === "no_history" ? "no history for this file" : "too long a name"})` : "";
	switch (e.event) {
		case "upload": return `${e.op === "add" ? "Added" : "Edited"} ${e.path}${kept}`;
		case "delete": return `Deleted ${e.path}${e.permanent ? " for good" : kept}`;
		case "restore": return e.error ? `Could not restore ${e.path}: ${e.error === "pruned" ? "that version is gone" : e.error}` : `Restored ${e.path} to the version of ${when(writtenOf(e.from))}`;
		case "download": return `Received ${e.path} from ${e.peer_name}`;
		case "remove_copy": return `Removed ${e.path}, deleted on ${e.peer_name}`;
		case "skip": return `Skipped ${e.path}: ${e.why}`;
		case "conflict": return `Your edit to ${e.peer_name}'s ${e.path} was kept aside`;
		case "hold": return e.why === "max_delete" ? `Held ${e.count} deletes: more than max_delete at once` : e.why === "over_quota" ? `Held ${e.count} uploads: storage is full` : `Held ${e.count} changes: the folder looks unmounted`;
		case "synced": return "Fully synced";
		case "truncated": return `Log truncated for today${e.why ? `: ${e.why}` : ""}`;
		case "watching": return `Watching ${e.folder || "the folder"}`;
		case "stopped": return "Stopped";
		case "round": return e.ok === false ? `Round failed${e.why ? `: ${e.why}` : ""}` : null;
		default: return null;
	}
}

/** The file an event is about, as (host, host_name, path): a pulled file belongs to its peer. */
function fileOf(e) {
	if (!e.path) return null;
	if (e.event === "download" || e.event === "remove_copy") return e.peer ? { host: e.peer, host_name: e.peer_name, path: e.path } : null;
	if (e.event === "upload" || e.event === "delete" || e.event === "restore") return e.host ? { host: e.host, host_name: e.host_name, path: e.path } : null;
	return null;
}

const FILTER_TEST = {
	all: () => true,
	errors: (e) => e.level === "error",
	skipped: (e) => e.event === "skip" || e.event === "hold",
	conflicts: (e) => e.event === "conflict",
};

class FolderSyncStatus extends HTMLElement {
	static observedAttributes = ["project", "owner", "base", "view"];

	constructor() {
		super();
		this.root = this.attachShadow({ mode: "open" });
		this.status = null;
		this.statusError = null;
		this.view = "activity";
		this.filter = "all";
		this.query = "";
		this.events = null;
		this.next = null;
		this.file = null;
		this.selected = null;
		this.showChanges = true;
		this.picked = new Set();
		this.deletedFiles = null;
		this.lastStatusJson = "";
		this.root.addEventListener("click", (e) => this.onClick(e));
		this.root.addEventListener("input", (e) => this.onInput(e));
		this.root.addEventListener("change", (e) => this.onChange(e));
		this.root.addEventListener("keydown", (e) => this.onKey(e));
		this.root.addEventListener("pointerdown", (e) => { if (e.target.id === "handle" && e.button === 0) this.startDrag(e); });
		this.onVisible = () => { if (!document.hidden) this.refresh(); };
	}

	get base() { return (this.getAttribute("base") || "/fs").replace(/\/+$/, ""); }
	get project() { return this.getAttribute("project") || ""; }
	get owner() { return this.getAttribute("owner") || ""; }
	get inline() { return VIEWS[this.getAttribute("view")] ? this.getAttribute("view") : null; }
	/** serve answers with this_device; the Worker never does. */
	get onMachine() { return !!(this.status && this.status.this_device); }
	get isOwner() { return !!(this.status && this.status.role === "owner"); }

	connectedCallback() {
		this.build();
		document.addEventListener("visibilitychange", this.onVisible);
		// WHY no poll while hidden: a background tab must cost nothing (docs/API.md); visibilitychange catches up
		this.timer = setInterval(() => { if (!document.hidden) this.refresh(); }, POLL_MS);
		this.refresh();
		if (this.inline) this.open(this.inline);
	}

	disconnectedCallback() {
		document.removeEventListener("visibilitychange", this.onVisible);
		clearInterval(this.timer);
		this.closeHub();
	}

	attributeChangedCallback(name, before, after) {
		if (before === after || !this.isConnected || !this.built) return;
		this.status = null;
		this.events = null;
		this.deletedFiles = null;
		this.file = null;
		this.lastStatusJson = "";
		this.closeHub();
		this.build();
		this.refresh();
		if (this.inline) this.open(this.inline);
	}

	/** A same-origin URL under <base>/v1/folders/<project>/, with ?owner= for a folder shared with this person. */
	url(route, params = {}) {
		const q = new URLSearchParams();
		for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, v);
		if (this.owner) q.set("owner", this.owner);
		const qs = q.toString();
		return `${this.base}/v1/folders/${encodeURIComponent(this.project)}/${route}${qs ? `?${qs}` : ""}`;
	}

	/** GET or POST JSON on this origin. WHY same-origin only: the session cookie is host-only on the app's domain
	 *  (PEP 0003 §3.2) and on a machine the page is serve's own; no CORS, and no token ever in page script. */
	async call(url, body) {
		const init = { credentials: "same-origin", headers: { Accept: "application/json" } };
		if (body !== undefined) {
			init.method = "POST";
			init.headers["Content-Type"] = "application/json";
			init.headers["X-Folder-Sync"] = "1";
			if (this.status && this.status.owner) init.headers["X-Folder-Sync-User"] = this.status.owner.id;
			init.body = JSON.stringify(body);
		}
		const res = await fetch(url, init);
		const data = await res.json().catch(() => null);
		if (!res.ok) throw new ViewError(res.status, data && data.error, (data && data.why) || `The server answered HTTP ${res.status}.`);
		return data;
	}

	build() {
		this.built = true;
		const inline = this.inline;
		const frame = `<div class="frame"><div class="tabs" role="tablist" aria-label="Sync">
  ${Object.entries(VIEWS).map(([v, label]) => `<button role="tab" id="tab-${v}" data-open="${v}" aria-selected="false" aria-controls="body" tabindex="-1">${label}</button>`).join("")}
  <span class="where muted" id="where"></span><span class="grow"></span>${inline ? "" : `<button data-act="close">Close</button>`}</div>
  <div class="body" id="body" role="tabpanel" tabindex="-1"></div></div>`;
		this.root.innerHTML = `<style>${css}</style><div class="wrap">${inline ? `<div class="panel" part="panel">${frame}</div>` : `
<button class="pill" part="pill" popovertarget="menu" data-state="unknown"><span class="ring"></span><span class="label">Checking sync…</span></button>
<div id="menu" class="menu" popover part="menu" role="menu" aria-label="Sync"></div>
<dialog class="panel" part="panel" aria-label="Sync">${frame}</dialog>`}</div>`;
		this.panel = this.root.querySelector(".panel");
		this.body = this.root.getElementById("body");
		const menu = this.root.getElementById("menu");
		if (menu) {
			// WHY placed by script: CSS anchor positioning is not in every engine the apps run in (WebKitGTK in the
			// desktop app). It opens above the pill when there is room, else below, its right edge on the pill's
			menu.addEventListener("beforetoggle", (e) => { if (e.newState === "open") this.renderMenu(); else delete menu.dataset.placed; });
			menu.addEventListener("toggle", (e) => {
				if (e.newState !== "open") return;
				this.placeMenu();
				menu.dataset.placed = "";
				const first = menu.querySelector(".item, button, a");
				if (first) first.focus();
			});
			this.panel.addEventListener("close", () => { const pill = this.root.querySelector(".pill"); if (pill) pill.focus(); });
		}
	}

	placeMenu() {
		const menu = this.root.getElementById("menu"), pill = this.root.querySelector(".pill");
		const r = pill.getBoundingClientRect(), h = menu.offsetHeight;
		const above = r.top - 6 >= h + 8 || r.top > innerHeight - r.bottom;
		Object.assign(menu.style, { position: "fixed", left: "auto", right: `${Math.max(8, innerWidth - r.right)}px`,
			top: above ? "auto" : `${Math.min(r.bottom + 6, innerHeight - 8 - h)}px`, bottom: above ? `${Math.max(8, innerHeight - r.top + 6)}px` : "auto" });
	}

	// ---- status: the pill and the menu ----

	/** Reads status now (docs/API.md: when shown, every 10 s while visible, and online on the hub's `changed`). */
	async refresh() {
		if (!this.project) return;
		const seq = (this.statusSeq = (this.statusSeq || 0) + 1);
		try {
			const status = await this.call(this.url("status"));
			if (seq !== this.statusSeq) return;
			this.status = status;
			this.statusError = null;
		} catch (err) {
			if (seq !== this.statusSeq) return;
			this.statusError = err;
		}
		this.renderPill();
		const json = this.status && !this.statusError ? JSON.stringify(this.status) : "";
		if (json && json !== this.lastStatusJson) {
			this.lastStatusJson = json;
			this.dispatchEvent(new CustomEvent("folder-sync:status", { detail: this.status, bubbles: true, composed: true }));
			const menu = this.root.getElementById("menu");
			if (menu && menu.matches(":popover-open") && !menu.contains(this.root.activeElement)) this.renderMenu();
		}
		if (this.status && !this.statusError && !this.onMachine) this.openHub();
		const where = this.root.getElementById("where");
		if (where) where.textContent = `${this.project} · ${this.headline().text}`;
	}

	/** One headline: the status's, or what a failed status read means (offline is never red). */
	headline() {
		const err = this.statusError;
		if (err) {
			if (!(err instanceof ViewError)) return { state: "offline", text: "Offline", why: "The server does not answer; status comes back when it does." };
			if (err.code === "signed_out") return { state: "attention", text: "Signed out", why: err.message };
			if (err.code === "ambiguous_folder") return { state: "attention", text: "Pick a folder", why: err.message };
			if (err.code === "recovering") return { state: "syncing", text: "Settling a change", why: err.message };
			return { state: "error", text: err.code === "not_found" ? "No such folder" : "Sync status unavailable", why: err.message, code: err.code };
		}
		if (!this.status) return { state: "unknown", text: "Checking sync…" };
		return { state: this.status.state, text: this.status.headline };
	}

	renderPill() {
		const pill = this.root.querySelector(".pill");
		if (!pill) return;
		const h = this.headline(), n = this.status && !this.statusError && this.status.warnings ? this.status.warnings.length : 0;
		pill.dataset.state = h.state;
		pill.setAttribute("aria-label", `Sync: ${h.text}${n ? `, ${n} to look at` : ""}`);
		pill.innerHTML = `<span class="ring"></span><span class="label">${esc(h.text)}</span>${n && h.state !== "attention" ? `<span class="count">· ${n} to look at</span>` : ""}`;
	}

	renderMenu() {
		const menu = this.root.getElementById("menu");
		if (!menu) return;
		const h = this.headline(), s = this.status;
		if (this.statusError || !s) {
			const signIn = this.statusError && this.statusError.code === "signed_out"
				? `<a class="item" role="menuitem" href="${esc(`${this.base}/signin?return=${encodeURIComponent(location.pathname + location.search)}`)}">Sign in</a>` : "";
			menu.innerHTML = `<div class="head"><b>${esc(h.text)}</b><span class="muted">${esc(this.project)}</span></div>
${h.why ? `<p class="note ${h.state === "error" ? "error" : h.state === "attention" ? "warn" : "info"}">${esc(h.why)}</p>` : ""}${signIn}
<button class="item" role="menuitem" data-act="retry">Try again</button>`;
			return;
		}
		const devices = [...s.devices].sort((a, b) => (b.this_device ? 1 : 0) - (a.this_device ? 1 : 0));
		const device = (d) => {
			let right = d.last_change ? `changed ${ago(d.last_change)}` : "nothing published";
			if (d.this_device && s.this_device) {
				const r = s.this_device.last_round;
				right = `${s.this_device.engine === "watching" ? "watching" : "idle"}${r ? ` · last round ${ago(r.at)}` : ""}`;
			}
			return `<li><span>${esc(d.name)}${d.this_device ? ' <span class="muted">(this device)</span>' : ""}${d.kind === "web" ? ' <span class="muted">(web)</span>' : ""}</span><span class="muted">${esc(right)}</span></li>`;
		};
		let html = `<div class="head"><b>${esc(s.headline)}</b><span class="muted">${esc(s.project)} · ${s.devices.length} device${s.devices.length === 1 ? "" : "s"}${s.this_device ? ` · ${esc(s.this_device.folder)}` : ""}</span></div>`;
		if (s.this_device && s.this_device.last_round && s.this_device.last_round.ok === false && s.this_device.last_round.why && s.state !== "attention") {
			html += `<p class="note ${s.state === "error" ? "error" : "info"}">${esc(s.this_device.last_round.why)}</p>`;
		}
		// WHY amber only here: a warning is something the person can act on, and each says what to do (calm UI)
		for (const w of s.warnings || []) html += `<p class="note ${w.level === "error" ? "error" : "warn"}" data-warning="${esc(w.kind)}">${esc(w.text)}</p>`;
		html += `<ul class="devices" aria-label="Devices">${devices.map(device).join("")}</ul>`;
		if (this.isOwner) {
			html += `<div class="sep"></div>${Object.entries(VIEWS).map(([v, label]) => `<button class="item" role="menuitem" data-open="${v}">${label}</button>`).join("")}`;
			if (s.storage) html += `<div class="sep"></div>${this.storageHtml(s.storage)}`;
			if (!this.onMachine) html += `<a class="item" role="menuitem" href="${esc(`${this.base}/account`)}">Devices and sharing</a>`;
		}
		menu.innerHTML = html;
	}

	storageHtml(st) {
		const quota = st.quota.bytes || 1, pct = (n) => `${Math.min(100, Math.max(n ? 0.5 : 0, (100 * n) / quota)).toFixed(1)}%`;
		const freeing = this.freeing;
		let action = "";
		// WHY online only: history lives in the bucket, and purging it is the accounts Worker's (serve: 501 online_only)
		if (!this.onMachine) {
			action = freeing === "ask"
				? `<div class="confirm"><span>Delete history older than ${FREE_UP_DAYS} days? This cannot be undone.</span><button class="primary" data-act="purge">Delete</button><button data-act="purge-cancel">Cancel</button></div>`
				: freeing === "busy" ? `<div class="confirm muted">Freeing up space…</div>`
				: `<div class="confirm">${typeof freeing === "string" ? `<span class="${this.freeingError ? "err" : "muted"}">${esc(freeing)}</span>` : ""}<span class="grow"></span><button data-act="free-up">Free up space</button></div>`;
		}
		return `<div class="storage" data-storage><div>Storage <span class="muted">· ${bytes(st.used.bytes)} of ${bytes(st.quota.bytes)}</span></div>
<div class="bar" role="img" aria-label="files ${bytes(st.live.bytes)}, history ${bytes(st.history.bytes)}"><i style="width:${pct(st.live.bytes)}"></i><i style="width:${pct(st.history.bytes)}"></i></div>
<div class="muted">Files ${bytes(st.live.bytes)} · history ${bytes(st.history.bytes)}${st.measured_at ? ` · measured ${ago(st.measured_at)}` : ""}</div>${st.over ? `<div class="warn">${esc(st.over)}</div>` : ""}${action}</div>`;
	}

	async freeUp() {
		this.freeing = "busy";
		this.freeingError = false;
		this.renderMenu();
		let purged = 0, freed = 0;
		try {
			// up to 1,000 objects a call; more: call again (docs/API.md "history/purge")
			for (let i = 0; i < 100; i++) {
				const r = await this.call(this.url("history/purge"), { older_than_days: FREE_UP_DAYS });
				purged += r.purged;
				freed += r.bytes;
				if (!r.more) break;
			}
			this.freeing = purged ? `Freed ${bytes(freed)} (${purged} old version${purged === 1 ? "" : "s"}).` : "Nothing older to delete.";
		} catch (err) {
			this.freeing = err.message;
			this.freeingError = true;
		}
		await this.refresh();
		this.renderMenu();
	}

	// ---- the hub: online, refetch on `changed` (PEP 0005 §3) ----

	openHub() {
		if (this.hub || this.hubWait || typeof WebSocket !== "function") return;
		const url = new URL(this.url("events"), location.href);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		let ws;
		try { ws = new WebSocket(url); } catch { return; }
		this.hub = ws;
		ws.addEventListener("open", () => { this.hubBackoff = 0; this.hubPing = setInterval(() => ws.readyState === 1 && ws.send("ping"), HUB_PING_MS); });
		ws.addEventListener("message", (m) => {
			let msg;
			try { msg = JSON.parse(m.data); } catch { return; }
			const seen = this.status ? Object.fromEntries(this.status.devices.map((d) => [d.id, d.seq])) : {};
			// a hint only: "read now". hello catches up any host whose seq differs from what this page holds
			const stale = msg.type === "changed" || (msg.type === "hello" && Object.entries(msg.hosts || {}).some(([h, v]) => seen[h] !== v.seq));
			if (stale) this.changed();
		});
		ws.addEventListener("close", () => {
			clearInterval(this.hubPing);
			if (this.hub !== ws) return;
			this.hub = null;
			if (!this.isConnected) return;
			// WHY backing off, never failing: the hub is a hint; the 10 s poll is the safety net while it is away
			this.hubBackoff = Math.min(300_000, (this.hubBackoff || 2500) * 2);
			this.hubWait = setTimeout(() => { this.hubWait = null; if (!document.hidden) this.openHub(); }, this.hubBackoff);
		});
	}

	closeHub() {
		clearTimeout(this.hubWait);
		clearInterval(this.hubPing);
		this.hubWait = null;
		const ws = this.hub;
		this.hub = null;
		if (ws) try { ws.close(); } catch { /* already closed */ }
	}

	changed() {
		clearTimeout(this.changedWait);
		this.changedWait = setTimeout(async () => {
			await this.refresh();
			if (this.isPanelOpen() && this.view === "activity") { this.events = null; this.renderBody(); }
			if (this.isPanelOpen() && this.view === "deleted") { this.deletedFiles = null; this.renderBody(); }
		}, 150);
	}

	// ---- the panel ----

	isPanelOpen() { return !!(this.panel && (this.inline || this.panel.open)); }

	/** Opens a panel: `activity`, `history` (with { host, path }, that file's versions) or `deleted`. */
	async open(view, target) {
		if (!VIEWS[view]) throw new TypeError(`folder-sync-status: no view "${view}" (activity, history or deleted)`);
		if (!this.built) this.build();
		this.view = view;
		if (view === "history") {
			if (target && target.host && target.path) {
				if (!this.file || this.file.host !== target.host || this.file.path !== target.path) this.selected = null;
				this.file = { host: target.host, path: target.path };
			}
		}
		const menu = this.root.getElementById("menu");
		if (menu && menu.matches(":popover-open")) menu.hidePopover();
		if (!this.inline && !this.panel.open) this.panel.showModal();
		for (const tab of this.root.querySelectorAll('[role="tab"]')) {
			const on = tab.dataset.open === view;
			tab.setAttribute("aria-selected", String(on));
			tab.tabIndex = on ? 0 : -1;
		}
		const where = this.root.getElementById("where");
		if (where) where.textContent = `${this.project} · ${this.headline().text}`;
		await this.renderBody();
		if (!this.inline && !this.panel.contains(this.root.activeElement)) this.root.getElementById(`tab-${view}`).focus();
	}

	close() {
		const menu = this.root.getElementById("menu");
		if (menu && menu.matches(":popover-open")) menu.hidePopover();
		if (this.panel && !this.inline && this.panel.open) this.panel.close();
	}

	async renderBody() {
		const view = this.view, ticket = (this.bodyTicket = (this.bodyTicket || 0) + 1);
		let html;
		try {
			html = await this[`${view}Html`]();
		} catch (err) {
			html = this.errorHtml(err);
		}
		if (ticket !== this.bodyTicket) return;
		this.body.innerHTML = html;
		this.body.dataset.view = view;
		if (view === "history") this.afterHistory();
	}

	errorHtml(err) {
		if (!(err instanceof ViewError)) return `<p class="note info" data-error="offline">The server does not answer. Try again when this computer is online.</p>`;
		const tone = err.status === 401 || err.status === 409 || err.status === 410 ? "warn" : "error";
		const action = err.code === "signed_out" ? ` <a href="${esc(`${this.base}/signin?return=${encodeURIComponent(location.pathname + location.search)}`)}">Sign in</a>` : "";
		return `<p class="note ${tone}" data-error="${esc(err.code || err.status)}">${esc(err.message)}${action}</p>`;
	}

	// Activity log: All / Errors / Skipped / Conflicts, a search over what is loaded, Copy (docs/API.md "activity")

	async loadEvents() {
		if (this.events) return;
		const page = await this.call(this.url("activity", { limit: 200 }));
		this.events = page.events;
		this.next = page.next;
	}

	shownEvents() {
		const q = this.query.trim().toLowerCase();
		return (this.events || []).map((e) => ({ e, text: say(e) })).filter(({ e, text }) => text !== null && FILTER_TEST[this.filter](e)
			&& (!q || [text, e.host_name, e.peer_name, e.path].some((s) => s && String(s).toLowerCase().includes(q))));
	}

	async activityHtml() {
		await this.loadEvents();
		return `<div class="tools"><div class="seg" role="group" aria-label="Show">${Object.entries(FILTERS).map(([f, label]) => `<button data-filter="${f}" aria-pressed="${f === this.filter}">${label}</button>`).join("")}</div>
<input type="search" id="search" placeholder="Search files and devices" aria-label="Search the activity log" value="${esc(this.query)}"><button data-act="copy-log">Copy sync log</button></div>
<div class="log" id="log" aria-live="polite">${this.logHtml()}</div>`;
	}

	logHtml() {
		const rows = this.shownEvents();
		if (!rows.length) return `<div class="empty">${this.events && this.events.length ? "Nothing matches." : "No activity yet."}</div>`;
		let html = "", lastDay = "";
		for (const { e, text } of rows) {
			const d = day(e.at);
			if (d !== lastDay) { html += `<div class="day">${esc(d)}</div>`; lastDay = d; }
			const f = fileOf(e), tone = e.level === "error" ? "error" : e.level === "warn" ? "warn" : "";
			const what = f ? esc(text).replace(esc(e.path), `<button class="link" data-host="${esc(f.host)}" data-path="${esc(f.path)}" title="Version history of ${esc(f.path)}">${esc(e.path)}</button>`) : esc(text);
			const ms = typeof e.up_ms === "number" ? `<span class="ms" title="Disk to online, on ${esc(e.host_name)}'s clock">↑ ${seconds(e.up_ms)}</span>`
				: typeof e.down_ms === "number" ? `<span class="ms" title="Online to disk: reads two clocks (${esc(e.peer_name || "the peer")}'s and ${esc(e.host_name)}'s), so it includes their difference">↓ ${seconds(e.down_ms)}</span>` : "<span></span>";
			html += `<div class="row ${tone}" data-event="${esc(e.event)}"><time datetime="${esc(e.at)}">${clock(e.at)}</time><span class="who">${esc(e.host_name)}</span><span class="what">${what}</span>${ms}</div>`;
		}
		if (this.next) html += `<div class="tools" style="margin-top:10px"><button data-act="older">Load older</button></div>`;
		return html;
	}

	async loadOlder() {
		const page = await this.call(this.url("activity", { limit: 200, before: this.next }));
		this.events = this.events.concat(page.events);
		this.next = page.next;
		this.root.getElementById("log").innerHTML = this.logHtml();
	}

	logText() {
		return this.shownEvents().map(({ e, text }) => `${clock(e.at)}  ${e.host_name}  ${text}${typeof e.up_ms === "number" ? `  ↑ ${seconds(e.up_ms)}` : typeof e.down_ms === "number" ? `  ↓ ${seconds(e.down_ms)}` : ""}`).join("\n");
	}

	// Version history: versions on the left; Show changes, Copy, Download and Restore on the right

	async historyHtml() {
		if (!this.file) return this.pickFileHtml();
		const f = this.file;
		const h = (this.historyBody = await this.call(this.url(`history/${encodeURIComponent(f.host)}/${encPath(f.path)}`)));
		const all = [];
		if (h.live) all.push({ id: "", live: true, at: h.live.written_at, size: h.live.size });
		for (const v of h.versions) all.push({ id: v.id, at: v.written_at || v.left_at, size: v.size, unlisted: v.unlisted, left_at: v.left_at });
		this.versions = all;
		if (!all.length) return `<p class="empty">No versions of ${esc(f.path)} are kept.</p>`;
		if (this.selected === null || !all.some((v) => v.id === this.selected)) this.selected = all[0].id;
		const items = all.map((v) => `<li><button data-version="${esc(v.id)}" aria-current="${v.id === this.selected}"><b>${v.live ? "Current" : esc(when(v.at))}</b>
<small>${v.live ? `${esc(when(v.at))} · ` : `${esc(ago(v.left_at))} replaced · `}${bytes(v.size)}${v.unlisted ? " · unlisted" : ""}</small></button></li>`).join("");
		return `<div class="split" id="split" style="--fs-split-w:${this.splitWidth()}px">
<div class="side" id="side"><div class="muted" style="padding:0 8px 6px"><button class="link" data-act="pick-file" title="Pick another file">${esc(f.path)}</button> · ${esc(h.host_name)}${h.live ? "" : " · deleted"}<br>${all.length} version${all.length === 1 ? "" : "s"}${h.more ? " (the newest 1,000)" : ""}</div>
<ul class="versions" aria-label="Versions">${items}</ul></div>
<div class="handle" id="handle" role="separator" aria-orientation="vertical" aria-label="Resize the versions list" tabindex="0" aria-valuenow="${this.splitWidth()}"></div>
<div class="main"><div class="tools"><label><input type="checkbox" id="changes" ${this.showChanges ? "checked" : ""}> Show changes</label><span class="grow"></span>
<button data-act="copy-version">Copy</button><a class="button" id="download" download>Download</a><button class="primary" data-act="restore-version">Restore this version</button></div>
<div id="result"></div><div id="content" class="muted">Loading…</div></div></div>`;
	}

	async pickFileHtml() {
		await this.loadEvents();
		const seen = new Map();
		for (const e of this.events) {
			const f = fileOf(e);
			if (f && !seen.has(keyOf(f.host, f.path))) seen.set(keyOf(f.host, f.path), { ...f, at: e.at });
		}
		const q = this.query.trim().toLowerCase();
		const files = [...seen.values()].filter((f) => !q || f.path.toLowerCase().includes(q) || String(f.host_name).toLowerCase().includes(q));
		return `<div class="tools"><span class="muted">Pick a file to see its versions. These changed recently; Deleted files lists the rest.</span></div>
<ul class="files">${files.map((f) => `<li><button class="link" data-host="${esc(f.host)}" data-path="${esc(f.path)}">${esc(f.path)}</button><small>${esc(f.host_name)} · changed ${esc(ago(f.at))}</small></li>`).join("") || `<li class="empty">No recent changes.</li>`}</ul>`;
	}

	versionUrl(id) {
		const f = this.file;
		return id ? this.url(`history/${encodeURIComponent(f.host)}/${encPath(f.path)}`, { version: id })
			: `${this.base}/v1/folders/${encodeURIComponent(this.project)}/files/${encodeURIComponent(f.host)}/${encPath(f.path)}${this.owner ? `?owner=${encodeURIComponent(this.owner)}` : ""}`;
	}

	/** One version's bytes as text, or null when they are not text (or too big to show). */
	async versionText(id) {
		const res = await fetch(this.versionUrl(id), { credentials: "same-origin" });
		if (!res.ok) {
			const data = await res.json().catch(() => null);
			throw new ViewError(res.status, data && data.error, (data && data.why) || `The server answered HTTP ${res.status}.`);
		}
		const buf = await res.arrayBuffer();
		if (buf.byteLength > TEXT_LIMIT) return null;
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
			return text.includes("\u0000") ? null : text;
		} catch { return null; }
	}

	async afterHistory() {
		if (!this.file || !this.versions || !this.versions.length) return;
		const i = this.versions.findIndex((v) => v.id === this.selected), v = this.versions[i], older = this.versions[i + 1];
		const content = this.root.getElementById("content");
		const name = this.file.path.split("/").pop();
		const download = this.root.getElementById("download");
		download.href = this.versionUrl(v.id);
		download.download = v.live ? name : `${name}.${v.at.replace(/[:]/g, "-")}`;
		const restore = this.root.querySelector('[data-act="restore-version"]');
		restore.hidden = !!v.live;
		restore.disabled = false;
		const ticket = this.bodyTicket;
		this.shownText = null;
		let html;
		try {
			const text = await this.versionText(v.id);
			let base = null;
			if (text !== null && this.showChanges && older) {
				try { base = await this.versionText(older.id); } catch { base = null; }
			}
			if (ticket !== this.bodyTicket) return;
			this.shownText = text;
			if (text === null) html = `<p class="empty">${esc(name)} is not text (${bytes(v.size)}). Download it to open it.</p>`;
			else if (base !== null) {
				const { diffLines } = await import("./vendor/diff.js");
				const parts = diffLines(base, text);
				const lines = (value, cls, mark) => value.replace(/\n$/, "").split("\n").map((l) => `<span class="${cls}">${mark}${esc(l) || " "}</span>`).join("");
				html = `<pre class="text" data-diff>${parts.map((p) => (p.added ? lines(p.value, "add", "+ ") : p.removed ? lines(p.value, "del", "- ") : lines(p.value, "same", "  "))).join("")}</pre>`;
			} else html = `<pre class="text">${esc(text)}</pre>`;
		} catch (err) {
			if (ticket !== this.bodyTicket) return;
			if (err instanceof ViewError && err.code === "pruned") restore.disabled = true;
			html = this.errorHtml(err);
		}
		content.className = "";
		content.innerHTML = html;
		this.root.querySelector('[data-act="copy-version"]').disabled = this.shownText === null;
	}

	splitWidth() {
		let w = 260;
		try { w = Number(localStorage.getItem(SPLIT_KEY)) || 260; } catch { /* storage blocked: the default */ }
		return Math.round(Math.min(Math.max(w, 160), 640));
	}

	setSplit(w, save) {
		const split = this.root.getElementById("split");
		if (!split) return;
		const max = Math.max(160, split.getBoundingClientRect().width - 260);
		w = Math.round(Math.min(Math.max(w, 160), max));
		split.style.setProperty("--fs-split-w", `${w}px`);
		this.root.getElementById("handle").setAttribute("aria-valuenow", String(w));
		// WHY remembered: every split pane keeps the width the person dragged it to (standing rule)
		if (save) try { localStorage.setItem(SPLIT_KEY, String(w)); } catch { /* storage blocked: not remembered */ }
	}

	startDrag(e) {
		const handle = e.target, split = this.root.getElementById("split"), side = this.root.getElementById("side");
		const left = split.getBoundingClientRect().left, offset = e.clientX - side.getBoundingClientRect().right;
		handle.setPointerCapture(e.pointerId);
		handle.classList.add("dragging");
		const move = (m) => this.setSplit(m.clientX - left - offset, false);
		const up = (u) => {
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", up);
			handle.classList.remove("dragging");
			this.setSplit(u.clientX - left - offset, true);
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", up);
		e.preventDefault();
	}

	// Deleted files: restore one or many at once

	async deletedHtml() {
		if (!this.deletedFiles) this.deletedFiles = await this.call(this.url("deleted"));
		const { files, more } = this.deletedFiles;
		if (!files.length) return `<p class="empty">No deleted files are kept.</p>`;
		const n = files.filter((f) => this.picked.has(keyOf(f.host, f.path))).length;
		return `<div class="tools"><span class="muted">Kept 30 days after they were deleted. Restore puts a file back on the device that owns it.</span><span class="grow"></span>
<button class="primary" data-act="restore-picked" ${n ? "" : "disabled"}>Restore ${n || ""} selected</button></div>
<div id="result"></div>${more ? `<p class="note info">More deleted files are kept than one listing covers; restore these, then look again.</p>` : ""}
<table><thead><tr><th><input type="checkbox" id="pick-all" aria-label="Select all" ${n === files.length ? "checked" : ""}></th><th>File</th><th>Device</th><th>Deleted</th><th>Size</th><th></th></tr></thead><tbody>
${files.map((f) => `<tr><td><input type="checkbox" data-pick="${esc(keyOf(f.host, f.path))}" aria-label="Select ${esc(f.path)}" ${this.picked.has(keyOf(f.host, f.path)) ? "checked" : ""}></td>
<td><button class="link" data-host="${esc(f.host)}" data-path="${esc(f.path)}" title="Version history of ${esc(f.path)}">${esc(f.path)}</button></td><td class="muted">${esc(f.host_name)}</td>
<td class="muted num" title="${esc(when(f.deleted_at))}">${esc(ago(f.deleted_at))}</td><td class="muted num">${bytes(f.size)}</td><td><button data-restore-one="${esc(keyOf(f.host, f.path))}">Restore</button></td></tr>`).join("")}
</tbody></table>`;
	}

	// Restore: the version a restore replaces is always kept first; a machine's file waits for that machine

	async restore(items) {
		const result = this.root.getElementById("result");
		if (result) result.innerHTML = `<p class="note info">Restoring…</p>`;
		let html;
		try {
			const r = await this.call(this.url("restore"), { items });
			this.dispatchEvent(new CustomEvent("folder-sync:restored", { detail: r, bubbles: true, composed: true }));
			const lines = [];
			if (r.applied.length) lines.push(`<p class="note info" data-restore="applied">Restored ${r.applied.length === 1 ? esc(r.applied[0].path) : `${r.applied.length} files`} as a new version.</p>`);
			for (const q of r.requested) {
				lines.push(`<p class="note info" data-restore="requested">${q.where === "local"
					? `This computer restores ${q.items === 1 ? "the file" : `${q.items} files`} in its next round.`
					: `Waiting for ${esc(q.host_name)}: it restores ${q.items === 1 ? "the file" : `${q.items} files`} when it next syncs. Download is the way to have ${q.items === 1 ? "it" : "them"} now.`}</p>`);
			}
			const failed = { pruned: "that version is gone", mismatch: "its bytes did not match the version", not_found: "no such file or version", over_quota: "storage is full", failed: "it failed" };
			for (const f of r.failed) lines.push(`<p class="note error" data-restore="failed">${esc(f.path)} was not restored: ${esc(failed[f.error] || f.error)}.</p>`);
			html = lines.join("");
			for (const it of items) this.picked.delete(keyOf(it.host, it.path));
			this.deletedFiles = null;
			this.events = null;
			this.refresh();
		} catch (err) {
			html = this.errorHtml(err);
		}
		if (this.view === "deleted") await this.renderBody();
		else if (this.view === "history") { this.selected = null; await this.renderBody(); }
		const box = this.root.getElementById("result");
		if (box) box.innerHTML = html;
	}

	// ---- events ----

	async copy(text, button) {
		const label = button.textContent;
		try {
			await navigator.clipboard.writeText(text);
			button.textContent = "Copied";
		} catch {
			button.textContent = "Copy failed";
		}
		setTimeout(() => { button.textContent = label; }, 1500);
	}

	onClick(e) {
		const t = e.target.closest("button, a");
		if (!t || !this.root.contains(t)) return;
		const d = t.dataset;
		if (d.open) return this.open(d.open);
		if (d.host && d.path) return this.open("history", { host: d.host, path: d.path });
		if (d.filter) {
			this.filter = d.filter;
			for (const b of this.root.querySelectorAll("[data-filter]")) b.setAttribute("aria-pressed", String(b.dataset.filter === this.filter));
			this.root.getElementById("log").innerHTML = this.logHtml();
			return;
		}
		if (d.version !== undefined) {
			// the list is already here: only the selection and the right-hand side change
			this.selected = d.version;
			this.bodyTicket++;
			for (const b of this.root.querySelectorAll("[data-version]")) b.setAttribute("aria-current", String(b.dataset.version === d.version));
			const result = this.root.getElementById("result");
			if (result) result.innerHTML = "";
			return this.afterHistory();
		}
		if (d.restoreOne) { const [host, path] = d.restoreOne.split("\n"); const f = this.deletedFiles.files.find((x) => x.host === host && x.path === path); return this.restore([{ host, path, version: f.version }]); }
		switch (d.act) {
			case "close": return this.close();
			case "retry": return this.refresh().then(() => this.renderMenu());
			case "copy-log": return this.copy(this.logText(), t);
			case "older": return this.loadOlder().catch((err) => { this.root.getElementById("log").insertAdjacentHTML("beforeend", this.errorHtml(err)); });
			case "pick-file": this.file = null; return this.renderBody();
			case "copy-version": return this.shownText !== null && this.copy(this.shownText, t);
			case "restore-version": return this.restore([{ host: this.file.host, path: this.file.path, version: this.selected }]);
			case "restore-picked": return this.restore(this.deletedFiles.files.filter((f) => this.picked.has(keyOf(f.host, f.path))).map((f) => ({ host: f.host, path: f.path, version: f.version })));
			case "free-up": this.freeing = "ask"; this.renderMenu(); return this.root.querySelector('[data-act="purge"]').focus();
			case "purge-cancel": this.freeing = null; this.renderMenu(); return this.root.querySelector('[data-act="free-up"]').focus();
			case "purge": return this.freeUp();
		}
	}

	onInput(e) {
		if (e.target.id !== "search") return;
		this.query = e.target.value;
		this.root.getElementById("log").innerHTML = this.logHtml();
	}

	onChange(e) {
		const t = e.target;
		if (t.id === "changes") { this.showChanges = t.checked; this.bodyTicket++; return this.afterHistory(); }
		if (t.id === "pick-all") {
			for (const f of this.deletedFiles.files) t.checked ? this.picked.add(keyOf(f.host, f.path)) : this.picked.delete(keyOf(f.host, f.path));
			return this.renderBody();
		}
		if (t.dataset.pick) {
			t.checked ? this.picked.add(t.dataset.pick) : this.picked.delete(t.dataset.pick);
			return this.renderBody().then(() => { const box = this.root.querySelector(`[data-pick="${CSS.escape(t.dataset.pick)}"]`); if (box) box.focus(); });
		}
	}

	onKey(e) {
		const t = e.target;
		const menu = this.root.getElementById("menu");
		if (e.key === "Escape" && menu && menu.matches(":popover-open")) {
			menu.hidePopover();
			this.root.querySelector(".pill").focus();
			return e.preventDefault();
		}
		// WHY a hand-made wrap: a modal <dialog> makes the page inert, but Tab still leaves it for the browser's own UI;
		// docs/API.md promises the dialog traps focus
		if (e.key === "Tab" && !this.inline && this.panel.open) {
			const all = [...this.panel.querySelectorAll('button, a[href], input, [tabindex="0"]')].filter((n) => !n.disabled && n.tabIndex >= 0 && n.getClientRects().length);
			const first = all[0], last = all[all.length - 1], here = this.root.activeElement;
			if (e.shiftKey ? here === first || !this.panel.contains(here) : here === last || !this.panel.contains(here)) {
				(e.shiftKey ? last : first).focus();
				return e.preventDefault();
			}
		}
		// the menu: arrows move between its items (the popover itself closes on Escape and returns focus)
		if (t.closest && t.closest("#menu") && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
			const items = [...this.root.getElementById("menu").querySelectorAll("button, a")];
			const i = items.indexOf(t);
			items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
			return e.preventDefault();
		}
		if (t.getAttribute && t.getAttribute("role") === "tab" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
			const views = Object.keys(VIEWS), i = views.indexOf(t.dataset.open);
			const v = views[(i + (e.key === "ArrowRight" ? 1 : -1) + views.length) % views.length];
			this.open(v).then(() => this.root.getElementById(`tab-${v}`).focus());
			return e.preventDefault();
		}
		if (t.id === "handle" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
			this.setSplit(this.root.getElementById("side").getBoundingClientRect().width + (e.key === "ArrowRight" ? 16 : -16), true);
			return e.preventDefault();
		}
	}
}

customElements.get("folder-sync-status") || customElements.define("folder-sync-status", FolderSyncStatus);
