// folder-sync demo page (PEP 0007 §6): signed in, your own folders, their files by device, recent activity with how
// long each sync took, and "Write a test file". Everything it reads and writes goes through this origin's /fs/ mount,
// the routes every app has (docs/API.md, PEP 0003 §3.3); <folder-sync-status> does the rest (history, deleted, restore).
//
// Sync times are the events' own measures (CONTRACT "Sync times"): `up_ms` on upload / delete (disk to online, one
// clock), `down_ms` on download / remove_copy (online to disk, two clocks: shown as measured, never clamped).

const POLL_MS = 10_000;
const CHART_BARS = 40;
const FILES_PER_DEVICE = 50;
const ACTIVITY_SHOWN = 60;

const $ = (id) => document.getElementById(id);
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let me = null;
let project = "";
let loading = 0;

/** A same-origin JSON call. A write carries the CSRF headers the accounts Worker asks of a cookie (docs/API.md "Auth"). */
async function call(path, { method = "GET", body, type } = {}) {
	const headers = { Accept: "application/json" };
	if (method !== "GET") {
		headers["X-Folder-Sync"] = "1";
		if (me) headers["X-Folder-Sync-User"] = me.user.id;
		if (type) headers["Content-Type"] = type;
	}
	const res = await fetch(path, { method, body, headers, credentials: "same-origin" });
	const data = await res.json().catch(() => null);
	if (!res.ok) {
		const error = new Error((data && data.why) || `The server answered HTTP ${res.status}.`);
		error.status = res.status;
		error.code = data && data.error;
		throw error;
	}
	return data;
}

/** 420 ms, 1.3 s, 2 min 5 s: always the measured value, sign included. */
export function took(ms) {
	const a = Math.abs(ms);
	if (a < 1000) return `${ms} ms`;
	if (a < 60_000) return `${(ms / 1000).toFixed(1)} s`;
	const s = Math.round(a / 1000);
	return `${ms < 0 ? "-" : ""}${Math.floor(s / 60)} min ${s % 60} s`;
}

export function median(values) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function clock(at) {
	const d = new Date(at);
	return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function ago(at) {
	const s = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000));
	if (!Number.isFinite(s)) return "";
	if (s < 60) return `${s} s ago`;
	if (s < 3600) return `${Math.round(s / 60)} min ago`;
	if (s < 86400) return `${Math.round(s / 3600)} h ago`;
	return `${Math.round(s / 86400)} d ago`;
}

function size(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ------------------------------------------------------------------------------------------------ signed in or out

async function start() {
	try {
		me = await call("/fs/v1/me");
	} catch (error) {
		me = null;
		if (error.status !== 401) return failed(error);
	}
	$("loading").hidden = true;
	$("sign-in").hidden = !!me;
	$("sign-out").hidden = !me;
	$("signed-out").hidden = !!me;
	$("signed-in").hidden = !me;
	if (!me) return;
	let folders = [];
	try {
		folders = (await call("/fs/v1/folders")).folders || [];
	} catch (error) {
		return failed(error);
	}
	const pick = $("pick");
	pick.innerHTML = folders.map((f) => `<option value="${esc(f.project)}">${esc(f.project)}</option>`).join("");
	$("pick-wrap").hidden = folders.length < 2;
	$("no-folders").hidden = folders.length > 0;
	$("folder").hidden = folders.length === 0;
	commands(folders[0] ? folders[0].project : "notes");
	if (folders.length) choose(folders[0].project);
}

function failed(error) {
	$("loading").hidden = false;
	$("loading").innerHTML = `<p>Could not reach folder-sync: ${esc(error.message)}</p>`;
}

function choose(name) {
	project = name;
	$("pick").value = name;
	$("folder-name").textContent = name;
	$("pill").hidden = false;
	$("pill").querySelector("folder-sync-status").setAttribute("project", name);
	commands(name);
	load();
}

/** "Put it on another computer": the three commands, for this origin and this folder. */
function commands(name) {
	const lines = [
		`folder-sync login --server ${location.origin}`,
		`mkdir -p ~/${name} && folder-sync init --project ${name} --dir ~/${name}`,
		`folder-sync sync --watch --dir ~/${name}`,
	];
	$("commands").innerHTML = lines.map((line) => `<div class="cmd"><code>${esc(line)}</code><button class="copy" data-copy="${esc(line)}">Copy</button></div>`).join("");
}

// ------------------------------------------------------------------------------------------------ the folder

async function load() {
	if (!project) return;
	const asked = project;
	const seq = ++loading;
	let view, activity;
	try {
		[view, activity] = await Promise.all([
			call(`/fs/v1/folders/${encodeURIComponent(asked)}`),
			call(`/fs/v1/folders/${encodeURIComponent(asked)}/activity?limit=200`),
		]);
	} catch (error) {
		if (seq === loading) $("activity").innerHTML = `<li class="empty">Could not read this folder: ${esc(error.message)}</li>`;
		return;
	}
	// WHY dropped: a slower answer for an earlier folder, or for someone who signed in meanwhile in another tab
	if (seq !== loading || asked !== project || (view.owner && view.owner !== me.user.id)) return;
	const events = activity.events || [];
	$("who").textContent = `Signed in as ${me.user.email} · ${view.hosts.length} device${view.hosts.length === 1 ? "" : "s"}`;
	times("up", events.filter((e) => typeof e.up_ms === "number").map((e) => ({ ms: e.up_ms, e })));
	times("down", events.filter((e) => typeof e.down_ms === "number").map((e) => ({ ms: e.down_ms, e })));
	files(view);
	lines(events);
}

/** One direction's figures: the median and the last over what activity loaded, and a bar per recent sync. */
function times(dir, all) {
	const box = document.querySelector(`.time[data-dir="${dir}"]`);
	const mid = median(all.map((t) => t.ms));
	box.querySelector('[data-k="median"]').textContent = mid === null ? "–" : took(mid);
	box.querySelector('[data-k="last"]').textContent = all.length ? took(all[0].ms) : "–";
	box.querySelector('[data-k="count"]').textContent = all.length ? `over ${all.length} sync${all.length === 1 ? "" : "s"}` : "no syncs yet";
	box.dataset.median = mid === null ? "" : String(mid);
	box.dataset.last = all.length ? String(all[0].ms) : "";
	const recent = all.slice(0, CHART_BARS).reverse(); // oldest left, newest right
	const svg = box.querySelector('[data-k="chart"]');
	if (!recent.length) {
		svg.innerHTML = `<line class="base" x1="0" x2="300" y1="47" y2="47"/><text class="empty" x="0" y="30">Nothing timed yet</text>`;
		return;
	}
	const values = recent.map((t) => t.ms);
	const hi = Math.max(0, ...values), lo = Math.min(0, ...values);
	const y = (v) => 2 + (hi - v) / (hi - lo || 1) * 44;
	const step = 300 / CHART_BARS;
	const x0 = 300 - recent.length * step;
	svg.innerHTML = `<line class="base" x1="0" x2="300" y1="${y(0)}" y2="${y(0)}"/>` + recent.map((t, i) => {
		const top = Math.min(y(0), y(t.ms)), h = Math.max(1, Math.abs(y(t.ms) - y(0)));
		const label = `${t.e.path || ""}: ${took(t.ms)} at ${clock(t.e.at)}`;
		return `<rect class="bar${t.ms < 0 ? " neg" : ""}${i === recent.length - 1 ? " newest" : ""}" x="${(x0 + i * step + 1).toFixed(1)}" y="${top.toFixed(1)}" width="${(step - 2).toFixed(1)}" height="${h.toFixed(1)}"><title>${esc(label)}</title></rect>`;
	}).join("");
}

/** The folder's files, by device, newest first. A path opens its versions in the element. */
function files(view) {
	const out = [];
	for (const host of view.hosts) {
		const mine = view.files.filter((f) => f.host === host.id).sort((a, b) => String(b.writtenAt).localeCompare(String(a.writtenAt)));
		const shown = mine.slice(0, FILES_PER_DEVICE);
		const label = host.web ? "web" : host.name;
		const what = host.web ? "pages like this one" : "a computer";
		out.push(`<div class="device" data-device="${esc(label)}"><b>${esc(label)}</b> <span class="muted small">${esc(what)} · ${mine.length} file${mine.length === 1 ? "" : "s"} · updated ${esc(ago(host.generatedAt))}</span>
<ul class="files">${shown.map((f) => `<li data-path="${esc(f.path)}" data-size="${f.size}"><button class="link path" data-host="${esc(host.id)}" data-path="${esc(f.path)}">${esc(f.path)}</button><span class="meta">${esc(size(f.size))} · ${esc(ago(f.writtenAt))}</span></li>`).join("") || `<li class="empty">No files.</li>`}</ul>
${mine.length > shown.length ? `<p class="muted small">and ${mine.length - shown.length} more</p>` : ""}</div>`);
	}
	$("files").innerHTML = out.join("") || `<p class="muted">No devices have synced this folder yet.</p>`;
}

function sentence(e) {
	const who = e.host_name || "a device";
	switch (e.event) {
		case "upload": return `${who} ${e.op === "add" ? "added" : "edited"} ${e.path}`;
		case "delete": return `${who} deleted ${e.path}${e.permanent ? " for good" : ""}`;
		case "restore": return `${who} restored ${e.path}`;
		case "download": return `${who} got ${e.path} from ${e.peer_name || "a peer"}`;
		case "remove_copy": return `${who} removed its copy of ${e.path} (gone from ${e.peer_name || "a peer"})`;
		default: return `${who}: ${e.event}${e.path ? ` ${e.path}` : ""}`;
	}
}

/** Recent activity, newest first, each sync's time beside it. */
function lines(events) {
	const shown = events.slice(0, ACTIVITY_SHOWN);
	$("activity").innerHTML = shown.map((e) => {
		const up = typeof e.up_ms === "number", down = typeof e.down_ms === "number";
		const ms = up ? e.up_ms : down ? e.down_ms : null;
		const badge = up ? `<span class="took up" title="disk to online">↑ ${esc(took(e.up_ms))}</span>`
			: down ? `<span class="took down" title="online to disk (two clocks)">↓ ${esc(took(e.down_ms))}</span>` : "<span></span>";
		return `<li data-event="${esc(e.event)}" data-path="${esc(e.path || "")}" data-host-name="${esc(e.host_name || "")}"${ms === null ? "" : ` data-ms="${ms}"`}><time datetime="${esc(e.at)}" title="${esc(e.at)}">${esc(clock(e.at))}</time><span class="what">${esc(sentence(e))}</span>${badge}</li>`;
	}).join("") || `<li class="empty">Nothing yet. Edit a file in the folder, or write a test file above.</li>`;
}

// ------------------------------------------------------------------------------------------------ actions

/** "Write a test file": folder-sync-demo/<time>.txt into the folder's web host, the call a page makes to save. */
async function write() {
	const button = $("write");
	const now = new Date();
	// WHY no ':' in the name: the contract refuses it in a path (Windows cannot hold it)
	const path = `folder-sync-demo/${now.toISOString().replace(/[:.]/g, "-")}.txt`;
	button.disabled = true;
	try {
		await call(`/fs/v1/folders/${encodeURIComponent(project)}/web/${path}`, {
			method: "PUT", type: "text/plain; charset=utf-8", body: `Written by the folder-sync demo at ${now.toISOString()}.\n`,
		});
		$("wrote").textContent = `Wrote ${path} at ${clock(now)}. Your computers pull it on their next sync.`;
	} catch (error) {
		$("wrote").textContent = error.message;
	}
	button.disabled = false;
	load();
}

async function signOut() {
	try {
		await call("/fs/v1/sign-out", { method: "POST" });
	} catch { /* signed out already */ }
	location.reload();
}

document.addEventListener("click", async (event) => {
	const target = event.target.closest("button");
	if (!target) return;
	const pill = $("pill").querySelector("folder-sync-status");
	if (target.dataset.copy) {
		try {
			await navigator.clipboard.writeText(target.dataset.copy);
			target.textContent = "Copied";
		} catch {
			target.textContent = "Select it";
		}
		setTimeout(() => { target.textContent = "Copy"; }, 1500);
	} else if (target.dataset.open) {
		pill.open(target.dataset.open);
	} else if (target.dataset.host && target.dataset.path) {
		pill.open("history", { host: target.dataset.host, path: target.dataset.path });
	}
});
$("write").addEventListener("click", write);
$("sign-out").addEventListener("click", signOut);
$("pick").addEventListener("change", (event) => choose(event.target.value));
// WHY these three: the element reads status on the hub's `changed` and every 10 s, and tells us when it changes (a new
// manifest); a machine's pull record changes no manifest, so the page also reads activity every 10 s while visible
document.addEventListener("folder-sync:status", () => load());
document.addEventListener("folder-sync:restored", () => load());
setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });

start();
