// The window: drawn from the app's Snapshot (src-tauri/src/core.rs), every button is one `action`.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const show = (id, on) => { $(id).hidden = !on; };

function render(s) {
  const state = s.status.state;
  $("status-card").dataset.state = state;
  $("headline").textContent = s.headline;
  $("detail").textContent = s.detail || "";
  show("detail", Boolean(s.detail));
  $("who").textContent = s.email ? `Signed in as ${s.email}` : "";
  show("who", Boolean(s.email));
  $("server").textContent = s.server.replace(/^https?:\/\//, "");
  $("default-folder").textContent = s.default_folder;
  $("code").textContent = s.status.code || "";
  $("folder").textContent = s.folder || "";
  show("step-signin", state === "signed_out");
  show("step-waiting", state === "signing_in");
  show("step-folder", state === "needs_folder");
  show("step-running", Boolean(s.email && s.folder) && state !== "needs_folder");
  show("sign-out", Boolean(s.email));
  const pause = $("pause");
  pause.dataset.action = s.paused ? "resume" : "pause";
  pause.textContent = s.paused ? "Resume sync" : "Pause sync";
  $("autostart").checked = s.autostart;
  document.title = `folder-sync: ${s.headline}`;
}

document.addEventListener("click", (e) => {
  const button = e.target.closest("button[data-action]");
  if (button) invoke("action", { id: button.dataset.action });
});
$("autostart").addEventListener("change", (e) => invoke("action", { id: "autostart", on: e.target.checked }));

listen("state", (e) => render(e.payload));
invoke("snapshot").then(render);
