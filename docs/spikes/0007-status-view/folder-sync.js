// PEP 0007 spike: is ONE framework-free custom element enough for every app's sync view? Not the implementation.
//
//   <script type="module" src="/fs/ui/v1/folder-sync.js"></script>
//   <folder-sync-status project="notes"></folder-sync-status>
//
// The pill opens a menu (the `popover` attribute); each menu item opens the panel (a native <dialog>) on one of its
// four views: Activity, History, Deleted, Settings. Everything is in Shadow DOM, so an app's CSS cannot break it; the
// app themes it with CSS custom properties (--fs-*) and ::part(). Data comes only from same-origin /fs/v1/... (the
// accounts Worker online, `folder-sync serve` on the machine); this spike answers from window.FOLDER_SYNC_FIXTURES.
// The real one vendors jsdiff for "Show changes"; the spike's line diff is a 20-line LCS.

const css = `
:host { --fs-font: system-ui, -apple-system, "Segoe UI", sans-serif; --fs-fg: #1f2328; --fs-muted: #656d76;
  --fs-line: #d8dee4; --fs-bg: #fff; --fs-soft: #f6f8fa; --fs-accent: #0969da; --fs-warn: #9a6700; --fs-warn-bg: #fff8c5;
  --fs-error: #cf222e; --fs-add: #dafbe1; --fs-del: #ffebe9; font: 13px/1.45 var(--fs-font); color: var(--fs-fg); }
@media (prefers-color-scheme: dark) { :host { --fs-fg: #e6edf3; --fs-muted: #8d96a0; --fs-line: #30363d; --fs-bg: #0d1117;
  --fs-soft: #161b22; --fs-accent: #4493f8; --fs-warn: #d29922; --fs-warn-bg: #2e2a1f; --fs-error: #f85149;
  --fs-add: #12261e; --fs-del: #2d1517; } }
* { box-sizing: border-box; }
button { font: inherit; color: inherit; background: none; border: 1px solid var(--fs-line); border-radius: 6px;
  padding: 3px 10px; cursor: pointer; } button:hover { background: var(--fs-soft); }
button.primary { background: var(--fs-accent); border-color: var(--fs-accent); color: #fff; }
.pill { display: inline-flex; align-items: center; gap: 6px; border: 0; padding: 2px 8px; color: var(--fs-muted); }
.dot { width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--fs-muted); flex: none; }
[data-state="syncing"] .dot { border-color: var(--fs-accent); border-right-color: transparent; animation: spin 1s linear infinite; }
[data-state="attention"] .dot { border-color: var(--fs-warn); background: var(--fs-warn); }
[data-state="error"] .dot { border-color: var(--fs-error); background: var(--fs-error); }
[data-state="paused"] .dot, [data-state="offline"] .dot { border-style: dashed; }
@keyframes spin { to { transform: rotate(360deg); } }
[popover] { margin: 0; inset: auto; border: 1px solid var(--fs-line); border-radius: 8px; padding: 4px; min-width: 230px; max-width: 340px;
  background: var(--fs-bg); color: var(--fs-fg); box-shadow: 0 8px 24px rgba(0,0,0,.12); }
.menu button { display: flex; width: 100%; border: 0; text-align: left; padding: 6px 10px; gap: 8px; }
.menu .head { padding: 8px 10px 6px; } .menu .head b { display: block; } .sep { border-top: 1px solid var(--fs-line); margin: 4px 0; }
.muted { color: var(--fs-muted); } .warn { color: var(--fs-warn); } .err { color: var(--fs-error); }
dialog { border: 1px solid var(--fs-line); border-radius: 10px; padding: 0; width: min(920px, 94vw); height: min(620px, 90vh);
  background: var(--fs-bg); color: var(--fs-fg); } dialog::backdrop { background: rgba(0,0,0,.25); }
.panel { display: grid; grid-template-rows: auto 1fr; height: 100%; }
.tabs { display: flex; gap: 2px; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--fs-line); }
.tabs button { border: 0; } .tabs button[aria-selected="true"] { background: var(--fs-soft); font-weight: 600; }
.tabs .grow { flex: 1; } .body { overflow: auto; padding: 12px 14px; }
.tools { display: flex; gap: 6px; margin-bottom: 10px; align-items: center; } input[type=search] { font: inherit;
  flex: 1; padding: 4px 8px; border: 1px solid var(--fs-line); border-radius: 6px; background: var(--fs-bg); color: inherit; }
.log { font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; } .log div { display: grid;
  grid-template-columns: 76px 92px 1fr; gap: 8px; } .log time, .log .who { color: var(--fs-muted); }
.split { display: grid; grid-template-columns: 250px 1fr; gap: 12px; height: 100%; }
.versions { border-right: 1px solid var(--fs-line); padding-right: 8px; overflow: auto; }
.versions button { display: block; width: 100%; text-align: left; border: 0; padding: 6px 8px; }
.versions button[aria-selected="true"] { background: var(--fs-soft); }
pre.diff { margin: 0; font: 12px/1.55 ui-monospace, Menlo, monospace; white-space: pre-wrap; }
.diff .add { background: var(--fs-add); } .diff .del { background: var(--fs-del); text-decoration: line-through; opacity: .85; }
.row { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--fs-line); }
.row > div:first-child { flex: 1; } .row small { display: block; color: var(--fs-muted); }
.bar { height: 6px; border-radius: 3px; background: var(--fs-soft); overflow: hidden; display: flex; width: 220px; }
.bar i { display: block; background: var(--fs-accent); } .bar i + i { background: var(--fs-muted); }
.note { background: var(--fs-warn-bg); color: var(--fs-warn); border-radius: 6px; padding: 6px 10px; margin: 0 0 10px; }
table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: 6px 4px; border-bottom: 1px solid var(--fs-line); }
th { font-weight: 600; color: var(--fs-muted); }
`;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ago = (iso, now) => {
	const s = Math.max(0, (now - Date.parse(iso)) / 1000);
	return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
const bytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
const hhmm = (iso) => new Date(iso).toISOString().slice(11, 19);

/** Line diff by longest common subsequence: enough for a spike ("Show changes"). */
function lineDiff(a, b) {
	const x = a.split("\n"), y = b.split("\n"), n = x.length, m = y.length;
	const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
	const out = [];
	let i = 0, j = 0;
	while (i < n && j < m) {
		if (x[i] === y[j]) { out.push(["", x[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push(["del", x[i++]]); else out.push(["add", y[j++]]);
	}
	while (i < n) out.push(["del", x[i++]]);
	while (j < m) out.push(["add", y[j++]]);
	return out;
}

class FolderSyncStatus extends HTMLElement {
	static observedAttributes = ["project"];

	constructor() {
		super();
		this.root = this.attachShadow({ mode: "open" });
		this.view = "activity";
		this.filter = "all";
		this.query = "";
		this.picked = new Set();
		this.version = 0;
	}

	get base() { return this.getAttribute("base") || "/fs"; }
	get project() { return this.getAttribute("project") || ""; }
	get now() { return Date.parse(this.getAttribute("now") || new Date().toISOString()); }

	/** GET <base>/v1/folders/<project>/<path>. WHY same-origin only: the session cookie is host-only on the app's
	 *  domain (PEP 0003 §3.2), and on a machine the page is the daemon's own; no CORS, no token in page script. */
	async get(path) {
		const url = `${this.base}/v1/folders/${encodeURIComponent(this.project)}/${path}`;
		const fixtures = window.FOLDER_SYNC_FIXTURES;
		if (fixtures) return structuredClone(fixtures[path]);
		const res = await fetch(url, { headers: { Accept: "application/json" }, credentials: "same-origin" });
		if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
		return res.json();
	}

	async connectedCallback() {
		this.status = await this.get("status");
		this.render();
	}

	render() {
		const s = this.status;
		const warn = s.warnings.length ? `<span class="warn">· ${s.warnings.length} to look at</span>` : "";
		this.root.innerHTML = `<style>${css}</style>
<button class="pill" part="pill" data-state="${esc(s.state)}" popovertarget="menu" aria-label="Sync: ${esc(s.headline)}">
  <span class="dot"></span><span>${esc(s.headline)}</span>${warn}</button>
<div id="menu" class="menu" popover part="menu">
  <div class="head"><b>${esc(s.headline)}</b><span class="muted">${esc(s.project)} · ${s.devices.length} devices · ${esc(s.this_device.name)}</span></div>
  ${s.warnings.map((w) => `<div class="head ${w.level === "error" ? "err" : "warn"}">${esc(w.text)}</div>`).join("")}
  <div class="sep"></div>
  <button data-act="pause">${s.this_device.paused ? "Resume" : "Pause"} sync on this device</button>
  <button data-open="history">Version history</button>
  <button data-open="activity">Activity log</button>
  <button data-open="deleted">Deleted files</button>
  <button data-open="settings">Settings</button>
</div>
<dialog part="panel"><div class="panel"><div class="tabs" role="tablist">
  ${["activity", "history", "deleted", "settings"].map((v) => `<button role="tab" data-open="${v}" aria-selected="${v === this.view}">${v[0].toUpperCase() + v.slice(1)}</button>`).join("")}
  <span class="grow"></span><button data-act="close" aria-label="Close">Close</button></div><div class="body" id="body"></div></div></dialog>`;
		this.root.addEventListener("click", (e) => this.onClick(e));
		// WHY placed by script: CSS anchor positioning is not in every engine the apps run in (WebKitGTK in the
		// desktop app); the menu opens above the pill, its right edge on the pill's, whatever the host's layout
		const menu = this.root.getElementById("menu"), pill = this.root.querySelector(".pill");
		menu.addEventListener("toggle", (e) => {
			if (e.newState !== "open") return;
			const r = pill.getBoundingClientRect();
			Object.assign(menu.style, { position: "fixed", left: "auto", top: "auto",
				right: `${Math.max(8, innerWidth - r.right)}px`, bottom: `${Math.max(8, innerHeight - r.top + 6)}px` });
		});
	}

	onClick(e) {
		const t = e.target.closest("button");
		if (!t) return;
		if (t.dataset.open) return this.open(t.dataset.open);
		if (t.dataset.act === "close") return this.root.querySelector("dialog").close();
		if (t.dataset.filter) { this.filter = t.dataset.filter; return this.open("activity"); }
		if (t.dataset.version) { this.version = Number(t.dataset.version); return this.open("history"); }
	}

	async open(view) {
		this.view = view;
		this.root.getElementById("menu").hidePopover?.();
		const dialog = this.root.querySelector("dialog");
		if (!dialog.open) dialog.showModal();
		this.root.querySelectorAll(".tabs [role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.open === view)));
		const body = this.root.getElementById("body");
		body.innerHTML = await this[view]();
	}

	async activity() {
		const { events } = await this.get("activity");
		const pick = { all: () => true, errors: (e) => e.level === "error", skipped: (e) => e.event === "skip" || e.event === "hold", conflicts: (e) => e.event === "conflict" }[this.filter];
		const say = (e) => ({
			upload: `Uploaded ${e.path} (${bytes(e.size)})`, download: `Downloaded ${e.path} from ${e.peer_name}`, delete: `Deleted ${e.path}${e.was?.kept ? " · kept in history" : ""}`,
			skip: `Skipped ${e.path}: ${e.why}`, conflict: `Your edit to ${e.peer_name}'s ${e.path} was kept aside`, synced: "Fully synced",
			round: `Round: ${e.uploaded || 0} up, ${e.fetched || 0} down · ${e.ms} ms`, offline: `Offline: ${e.why}`, restore: `Restored ${e.path} from ${e.version}`,
		})[e.event] || e.event;
		// WHY offline is muted, never red: it waits on the network and asks nothing of the person (calm UI: amber and red
		// only for what needs them)
		const rows = events.filter(pick).map((e) => `<div class="${e.level === "error" ? "err" : e.level === "warn" ? "warn" : e.event === "offline" ? "muted" : ""}"><time>${hhmm(e.at)}</time><span class="who">${esc(e.host_name)}</span><span>${esc(say(e))}</span></div>`);
		return `<div class="tools">${["all", "errors", "skipped", "conflicts"].map((f) => `<button data-filter="${f}" class="${f === this.filter ? "primary" : ""}">${f[0].toUpperCase() + f.slice(1)}</button>`).join("")}
<input type="search" placeholder="Filter by file or device" aria-label="Filter"><button>Copy sync log</button></div><div class="log">${rows.join("")}</div>`;
	}

	async history() {
		const h = await this.get("history/b55e9683-7854-4121-a56a-9bae7c3ab1da/notes/plan.md");
		const all = [{ id: "live", saved_at: h.live.written_at, size: h.live.size, text: h.live.text, live: true }, ...h.versions];
		const v = all[this.version] || all[0], older = all[this.version + 1];
		const diff = older ? lineDiff(older.text, v.text) : v.text.split("\n").map((l) => ["", l]);
		return `<div class="split"><div class="versions"><div class="muted" style="padding:0 8px 6px">${esc(h.path)} · ${all.length} versions · ${esc(h.host_name)}</div>
${all.map((x, i) => `<button data-version="${i}" aria-selected="${i === this.version}"><b>${x.live ? "Current" : ago(x.saved_at, this.now)}</b><br><span class="muted">${bytes(x.size)}</span></button>`).join("")}</div>
<div><div class="tools"><label><input type="checkbox" checked> Show changes</label><span class="grow" style="flex:1"></span><button>Copy</button><button>Download</button>${v.live ? "" : `<button class="primary">Restore this version</button>`}</div>
<pre class="diff">${diff.map(([k, l]) => `<span class="${k}">${esc(l) || " "}</span>`).join("\n")}</pre></div></div>`;
	}

	async deleted() {
		const { files } = await this.get("deleted");
		return `<div class="tools"><span class="muted">Kept 30 days after they were deleted. Restore puts a file back on the device that owns it.</span><span style="flex:1"></span><button class="primary">Restore 2 selected</button></div>
<table><tr><th></th><th>File</th><th>Device</th><th>Deleted</th><th>Size</th></tr>${files.map((f, i) => `<tr><td><input type="checkbox" ${i < 2 ? "checked" : ""}></td><td>${esc(f.path)}</td><td class="muted">${esc(f.host_name)}</td><td class="muted">${ago(f.deleted_at, this.now)}</td><td class="muted">${bytes(f.size)}</td></tr>`).join("")}</table>`;
	}

	async settings() {
		const s = this.status, st = s.storage, live = st.used - st.history;
		const pct = (n) => `${Math.max(0.5, (100 * n) / st.quota).toFixed(1)}%`;
		const row = (name, sub, right) => `<div class="row"><div>${name}<small>${sub}</small></div>${right}</div>`;
		return `${s.warnings.map((w) => `<p class="note">${esc(w.text)}</p>`).join("")}
${row("Folder online", `${esc(s.project)} · ${esc(s.owner.email)}`, `<button>Manage</button><button>Disconnect this device</button>`)}
${row("Sync on this device", `${esc(s.headline)} · ${esc(s.this_device.name)}`, `<button>${s.this_device.paused ? "Resume" : "Pause"}</button>`)}
${row("Device name", "How this computer is named in every device's activity log", `<button>${esc(s.this_device.name)}</button>`)}
${row("Edits to other devices' files", "Each device writes only its own files; an edit to another device's copy is kept aside, never merged", `<span class="muted">0 kept aside</span>`)}
${row("Deleted files", "Restore one, or several at once", `<button data-open="deleted">View</button>`)}
${row("Activity log", "Every upload, download and problem, on every device", `<button data-open="activity">View</button>`)}
${row("Storage", `${bytes(st.used)} of ${bytes(st.quota)} · history ${bytes(st.history)}`, `<div class="bar" title="files ${bytes(live)}, history ${bytes(st.history)}"><i style="width:${pct(live)}"></i><i style="width:${pct(st.history)}"></i></div>`)}
${row("Help", "Engine version, folder, devices and the last 50 log lines; never a key or a token", `<button>Copy debug info</button>`)}`;
	}
}

customElements.define("folder-sync-status", FolderSyncStatus);
