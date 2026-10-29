"""<folder-sync-status> in WebKitGTK, the desktop app's engine on Linux (PEP 0006's Tauri webview), over the stub.

    xvfb-run -a python3 ui/test/webkitgtk.py <out dir> [light|dark]

Starts test/stub.mjs (the frozen testdata/view-api/ fixtures) on a free loopback port, opens the host page, and walks
the pill, the menu and every view: one PNG per step, one JSON line of measurements per step, then a verdict. It exits
non-zero when any check fails: the element defined, the native popover and <dialog> open on screen, the menu above the
pill, each view rendered with its rows, the diff shown, the split resized by keyboard and measured, the page's hostile
CSS kept out, and no script error. The stub is stopped by its PID when the run ends. Adapted from the PEP 0007 spike
(docs/spikes/0007-status-view/render.py).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GPU = "b55e9683-7854-4121-a56a-9bae7c3ab1da"

C = "const c = document.querySelector('folder-sync-status'), r = c.shadowRoot;"
STEPS = [
    ("closed", "null"),
    ("menu", "r.querySelector('.pill').click()"),
    ("activity", "r.querySelector('#menu [data-open=activity]').click()"),
    ("history", f"c.open('history', {{host: '{GPU}', path: 'notes/plan.md'}})"),
    ("history-diff", "r.querySelectorAll('.versions button')[1].click()"),
    ("split", "window.__w0 = r.getElementById('side').getBoundingClientRect().width;"
              " r.getElementById('handle').dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true, composed: true}))"),
    ("deleted", "r.querySelector('[role=tab][data-open=deleted]').click()"),
    ("deleted-picked", "r.querySelectorAll('tbody input')[0].click()"),
    ("deleted-restored", "r.querySelectorAll('tbody input')[2].click(); setTimeout(() => r.querySelector('[data-act=restore-picked]').click(), 150)"),
]

MEASURE = """(() => {
  const c = document.querySelector('folder-sync-status'), r = c.shadowRoot;
  const menu = r.getElementById('menu'), dialog = r.querySelector('dialog'), pill = r.querySelector('.pill');
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; };
  const open = (() => { try { return menu.matches(':popover-open'); } catch (e) { return 'unsupported'; } })();
  const body = r.getElementById('body'), side = r.getElementById('side');
  return JSON.stringify({
    defined: !!customElements.get('folder-sync-status'),
    popover_supported: typeof HTMLElement.prototype.showPopover === 'function',
    pill_state: pill.dataset.state, pill_text: pill.textContent.trim(),
    menu_open: open, menu_box: box(menu), pill_box: box(pill),
    dialog_open: dialog.open, dialog_box: box(dialog), viewport: [innerWidth, innerHeight],
    dialog_bg: getComputedStyle(dialog).backgroundColor,
    view: body.dataset.view || null,
    rows: r.querySelectorAll('.log .row').length, versions: r.querySelectorAll('.versions button').length,
    diff_added: r.querySelectorAll('pre[data-diff] .add').length, deleted_rows: r.querySelectorAll('tbody tr').length,
    restore_notes: [...r.querySelectorAll('[data-restore]')].map((n) => n.dataset.restore),
    side_width: side ? Math.round(side.getBoundingClientRect().width * 10) / 10 : null, side_before: window.__w0 || null,
    host_css_leaked: getComputedStyle(pill).backgroundColor === 'rgb(255, 105, 180)' || getComputedStyle(dialog).backgroundColor === 'rgb(0, 255, 0)',
    errors: window.__errors || [],
  });
})()"""

ERRORS = "window.__errors = []; addEventListener('error', (e) => window.__errors.push(String(e.message))); addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));"


def check(step: str, m: dict) -> list[str]:
    """What this step must show; each failure is one line."""
    fails = []
    want = lambda ok, what: fails.append(f"{step}: {what}") if not ok else None
    want(m.get("defined"), "element not defined")
    want(m.get("popover_supported"), "no native popover")
    want(not m.get("host_css_leaked"), "host CSS leaked in")
    want(not m.get("errors"), f"script errors {m.get('errors')}")
    want(m.get("pill_state") == "attention", f"pill state {m.get('pill_state')}")
    w, h = m["viewport"]
    if step == "menu":
        mb, pb = m["menu_box"], m["pill_box"]
        want(m["menu_open"] is True, "menu not open")
        want(mb[1] >= 0 and mb[3] <= pb[1] and mb[2] <= w, f"menu not above the pill on screen {mb} {pb}")
    if step not in ("closed", "menu"):
        db = m["dialog_box"]
        want(m["dialog_open"], "dialog not open")
        want(db[0] >= 0 and db[1] >= 0 and db[2] <= w and db[3] <= h, f"dialog off screen {db}")
    if step == "activity":
        want(m["view"] == "activity" and m["rows"] == 13, f"activity rows {m['rows']}")
    if step == "history":
        want(m["view"] == "history" and m["versions"] == 5, f"versions {m['versions']}")
    if step == "history-diff":
        want(m["diff_added"] == 2, f"diff added lines {m['diff_added']}")
    if step == "split":
        want(m["side_before"] and abs(m["side_width"] - (m["side_before"] + 16)) <= 1, f"split {m['side_before']} -> {m['side_width']}")
    if step == "deleted":
        want(m["view"] == "deleted" and m["deleted_rows"] == 3, f"deleted rows {m['deleted_rows']}")
    if step == "deleted-restored":
        want(m["restore_notes"] == ["applied", "requested", "failed"], f"restore notes {m['restore_notes']}")
    return fails


def run(url: str, out: Path, scheme: str) -> list[str]:
    import gi

    gi.require_version("Gtk", "3.0")
    gi.require_version("WebKit2", "4.1")
    from gi.repository import GLib, Gtk, WebKit2

    Gtk.Settings.get_default().set_property("gtk-application-prefer-dark-theme", scheme == "dark")
    window = Gtk.OffscreenWindow()
    window.set_default_size(1100, 700)
    view = WebKit2.WebView()
    window.add(view)
    window.show_all()
    loop = GLib.MainLoop()
    state = {"step": 0, "fails": []}
    version = f"{WebKit2.get_major_version()}.{WebKit2.get_minor_version()}.{WebKit2.get_micro_version()}"

    def run_js(script, then):
        def done(webview, result):
            try:
                value = webview.evaluate_javascript_finish(result)
                then(value.to_string() if value is not None else None)
            except Exception as err:  # a script error is a finding, not a crash
                then(json.dumps({"script_error": str(err)}))
        view.evaluate_javascript(script, -1, None, None, None, done)

    def snapshot(name, then):
        def done(webview, result):
            surface = webview.get_snapshot_finish(result)
            surface.write_to_png(str(out / f"webkitgtk-{scheme}-{name}.png"))
            then()
        view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, done)

    def step():
        if state["step"] >= len(STEPS):
            loop.quit()
            return
        name, js = STEPS[state["step"]]
        state["step"] += 1

        def after_click(_):
            def after_wait():
                def after_snap():
                    def measured(text):
                        data = json.loads(text) if text and text.startswith("{") else {"raw": text}
                        print(json.dumps({"engine": f"webkitgtk {version}", "scheme": scheme, "step": name, **data}))
                        state["fails"] += check(name, data) if "defined" in data else [f"{name}: {data}"]
                        GLib.idle_add(step)
                    run_js(MEASURE, measured)
                snapshot(name, after_snap)
                return False
            GLib.timeout_add(700, after_wait)
        run_js(f"(() => {{ {C} {js}; return 'ok'; }})()", after_click)

    def loaded(webview, event):
        if event == WebKit2.LoadEvent.FINISHED:
            run_js(ERRORS, lambda _: GLib.timeout_add(900, lambda: (step(), False)[1]))

    view.connect("load-changed", loaded)
    view.load_uri(f"{url}/app.html")
    GLib.timeout_add_seconds(60, lambda: (state["fails"].append("timeout"), loop.quit()))
    loop.run()
    return state["fails"]


if __name__ == "__main__":
    out_dir, scheme = Path(sys.argv[1]), (sys.argv[2] if len(sys.argv) > 2 else "light")
    out_dir.mkdir(parents=True, exist_ok=True)
    stub = subprocess.Popen(["node", str(HERE / "stub.mjs"), "--scenario", "online"], stdout=subprocess.PIPE, text=True)
    try:
        url = json.loads(stub.stdout.readline())["url"]
        fails = run(url, out_dir, scheme)
    finally:
        stub.terminate()
        stub.wait(timeout=10)
    print(json.dumps({"engine": "webkitgtk", "scheme": scheme, "steps": len(STEPS), "fails": fails}))
    sys.exit(1 if fails else 0)
