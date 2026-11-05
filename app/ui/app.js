// The window: drawn from the app's Snapshot (src-tauri/src/core.rs), every button is one `action` or one of the picker's commands.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const show = (id, on) => { $(id).hidden = !on; };
const text = (id, value) => { $(id).textContent = value; };

// What the page itself remembers between snapshots: the typed name, the chosen places, the online folder being downloaded.
const page = { parent: null, parentShown: "", joinParent: null, joinParentShown: "", joining: null, busy: false, last: null };

function say(id, message) {
  text(id, message || "");
  show(id, Boolean(message));
}

function renderOnline(s) {
  const list = $("online-list");
  const online = s.online || { state: "idle" };
  const names = online.state === "ready" ? online.folders : [];
  list.replaceChildren(...names.map((name) => {
    const item = document.createElement("li");
    item.dataset.testid = `online-${name}`;
    const label = document.createElement("span");
    label.textContent = name;
    const button = document.createElement("button");
    button.textContent = "Download…";
    button.dataset.testid = `download-${name}`;
    button.disabled = page.busy;
    button.addEventListener("click", () => {
      page.joining = name;
      renderJoin();
    });
    item.append(label, button);
    return item;
  }));
  const note = {
    idle: "",
    loading: "Looking for your folders online…",
    failed: `Could not look just now: ${online.why}`,
    ready: names.length ? "" : "None yet. Folders you sync from another computer show up here.",
  }[online.state];
  text("online-note", note || "");
  show("online-note", Boolean(note));
  if (page.joining && online.state === "ready" && !names.includes(page.joining)) page.joining = null;
  renderJoin();
}

function renderJoin() {
  show("join-form", Boolean(page.joining));
  if (!page.joining) return;
  text("join-name", page.joining);
  text("join-path", `${page.joinParentShown}/${page.joining}`);
}

function render(s) {
  page.last = s;
  const state = s.status.state;
  $("status-card").dataset.state = state;
  text("headline", s.headline);
  text("detail", s.detail || "");
  show("detail", Boolean(s.detail));
  text("who", s.email ? `Signed in as ${s.email}` : "");
  show("who", Boolean(s.email));
  text("server", s.server.replace(/^https?:\/\//, ""));
  text("code", s.status.code || "");
  text("folder", s.folder || "");
  if (page.parent === null) {
    page.parent = s.default_parent_path;
    page.parentShown = s.default_parent;
    page.joinParent = s.default_parent_path;
    page.joinParentShown = s.default_parent;
  }
  text("new-parent", page.parentShown);

  const signedOut = state === "signed_out" || state === "sign_in_failed";
  show("step-signin", state === "signed_out");
  show("step-waiting", state === "signing_in");
  show("step-failed", state === "sign_in_failed");
  show("advanced", signedOut);
  const server = $("server-input");
  if (document.activeElement !== server) server.value = s.server;
  server.disabled = s.server_locked;
  $("server-save").disabled = s.server_locked;
  text("server-note", s.server_locked ? "FOLDER_SYNC_SERVER decides the server in this run." : "");
  show("server-note", s.server_locked);

  show("step-folder", s.signed_in && s.picking);
  // WHY Cancel only when there is a folder: the first run has nothing to go back to
  show("picker-cancel", Boolean(s.folder));
  show("step-running", Boolean(s.signed_in && s.folder) && !s.picking);
  show("sign-out", s.signed_in);
  const pause = $("pause");
  pause.dataset.action = s.paused ? "resume" : "pause";
  pause.textContent = s.paused ? "Resume sync" : "Pause sync";
  $("autostart").checked = s.autostart;
  renderOnline(s);
  document.title = `folder-sync: ${s.headline}`;
}

/** Runs one picker command with the buttons held, and shows its refusal (the engine's own words) under the buttons. */
async function working(button, doing, command, args) {
  if (page.busy) return false;
  page.busy = true;
  const label = button.textContent;
  button.textContent = doing;
  for (const b of document.querySelectorAll("#step-folder button")) b.disabled = true;
  say("picker-error", "");
  try {
    const answer = await invoke(command, args);
    return answer === undefined || answer === null ? true : answer;
  } catch (why) {
    say("picker-error", String(why));
    return false;
  } finally {
    page.busy = false;
    button.textContent = label;
    for (const b of document.querySelectorAll("#step-folder button")) b.disabled = false;
    if (page.last) renderOnline(page.last);
  }
}

$("create-folder").addEventListener("click", (e) => {
  working(e.currentTarget, "Creating…", "create_folder", { name: $("new-name").value, parent: page.parent });
});
$("open-existing").addEventListener("click", (e) => {
  working(e.currentTarget, "Opening…", "open_existing", {});
});
$("new-choose").addEventListener("click", async () => {
  const picked = await invoke("pick_location", { start: page.parent });
  if (picked) { page.parent = picked; page.parentShown = picked; text("new-parent", picked); }
});
$("join-choose").addEventListener("click", async () => {
  const picked = await invoke("pick_location", { start: page.joinParent });
  if (picked) { page.joinParent = picked; page.joinParentShown = picked; renderJoin(); }
});
$("join-go").addEventListener("click", (e) => {
  working(e.currentTarget, "Downloading…", "join_folder", { project: page.joining, parent: page.joinParent });
});
$("join-cancel").addEventListener("click", () => { page.joining = null; renderJoin(); });

$("server-save").addEventListener("click", async () => {
  say("server-error", "");
  try {
    await invoke("set_server", { server: $("server-input").value });
  } catch (why) {
    say("server-error", String(why));
  }
});

document.addEventListener("click", (e) => {
  const button = e.target.closest("button[data-action]");
  if (button) invoke("action", { id: button.dataset.action });
});
$("autostart").addEventListener("change", (e) => invoke("action", { id: "autostart", on: e.target.checked }));

// WHY listen first, then ask for the snapshot: an update that lands between the two is otherwise missed, and the window stays on
// what it first drew (the real run's second computer showed "Looking for your folders online..." for good)
listen("state", (e) => render(e.payload)).then(() => invoke("snapshot")).then(render);
