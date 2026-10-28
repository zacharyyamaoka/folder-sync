"""PEP 0007 spike: render the shared sync view in the two engines the apps run in, and measure it.

    <playwright python> render.py chromium <out dir>      Chromium (vibetracks.dev, robotparts.dev, vt serve in Chrome)
    xvfb-run -a python3 render.py webkitgtk <out dir>     WebKitGTK (the Tauri desktop app on Linux, PEP 0006)

Each run opens index.html, then: the pill, the open menu, and the panel on each of its four views. It saves one PNG
per step and prints one JSON line of measurements per step: whether the menu and the dialog are open and on screen,
whether the host page's hostile `button` rule reached inside the component, and any script error. The page is served
over HTTP from this process (an ES module does not load from file://), on a free loopback port, and the server stops
with the run; nothing is left running.
"""

from __future__ import annotations

import functools
import http.server
import json
import sys
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
PAGE = ""


def serve() -> http.server.ThreadingHTTPServer:
    """This folder over HTTP on 127.0.0.1:<free port>, in a daemon thread of this process."""
    global PAGE
    quiet = type("Quiet", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *a: None})
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(quiet, directory=str(HERE)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    PAGE = f"http://127.0.0.1:{server.server_address[1]}/index.html"
    return server

STEPS = [
    ("closed", "null"),
    ("menu", "c.shadowRoot.querySelector('.pill').click()"),
    ("activity", "c.shadowRoot.querySelector('[data-open=activity]').click()"),
    ("history", "c.shadowRoot.querySelector('.tabs [data-open=history]').click()"),
    ("deleted", "c.shadowRoot.querySelector('.tabs [data-open=deleted]').click()"),
    ("settings", "c.shadowRoot.querySelector('.tabs [data-open=settings]').click()"),
]

MEASURE = """(() => {
  const c = document.querySelector('folder-sync-status'), r = c.shadowRoot;
  const menu = r.getElementById('menu'), dialog = r.querySelector('dialog'), pill = r.querySelector('.pill');
  const box = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; };
  const open = (() => { try { return menu.matches(':popover-open'); } catch (e) { return 'unsupported'; } })();
  return JSON.stringify({
    defined: !!customElements.get('folder-sync-status'),
    popover_supported: typeof HTMLElement.prototype.showPopover === 'function',
    menu_open: open, menu_box: box(menu), pill_box: box(pill),
    dialog_open: dialog.open, dialog_box: box(dialog), viewport: [innerWidth, innerHeight],
    host_css_leaked: getComputedStyle(pill).backgroundColor === 'rgb(255, 105, 180)',
    body_text: (r.getElementById('body') || {}).textContent ? r.getElementById('body').textContent.trim().slice(0, 80) : '',
    errors: window.__errors || [],
  });
})()"""

ERRORS = "window.__errors = []; addEventListener('error', (e) => window.__errors.push(String(e.message)));"


def chromium(out: Path) -> None:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1100, "height": 700})
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.add_init_script(ERRORS)
        page.goto(PAGE)
        page.wait_for_function("customElements.get('folder-sync-status') && document.querySelector('folder-sync-status').shadowRoot.querySelector('.pill')")
        for name, js in STEPS:
            page.evaluate(f"(() => {{ const c = document.querySelector('folder-sync-status'); {js}; }})()")
            page.wait_for_timeout(250)
            page.screenshot(path=str(out / f"chromium-{name}.png"))
            data = json.loads(page.evaluate(MEASURE))
            data["errors"] = data["errors"] + errors
            print(json.dumps({"engine": "chromium", "step": name, **data}))
        browser.close()


def webkitgtk(out: Path) -> None:
    import gi

    gi.require_version("Gtk", "3.0")
    gi.require_version("WebKit2", "4.1")
    from gi.repository import GLib, Gtk, WebKit2

    window = Gtk.OffscreenWindow()
    window.set_default_size(1100, 700)
    view = WebKit2.WebView()
    view.get_settings().set_allow_file_access_from_file_urls(True)
    view.get_settings().set_allow_universal_access_from_file_urls(True)
    window.add(view)
    window.show_all()
    loop = GLib.MainLoop()
    state = {"step": 0}
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
            surface.write_to_png(str(out / f"webkitgtk-{name}.png"))
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
                        print(json.dumps({"engine": f"webkitgtk {version}", "step": name, **data}))
                        GLib.idle_add(step)
                    run_js(MEASURE, measured)
                snapshot(name, after_snap)
                return False
            GLib.timeout_add(400, after_wait)
        run_js(f"(() => {{ const c = document.querySelector('folder-sync-status'); {js}; return 'ok'; }})()", after_click)

    def loaded(webview, event):
        if event == WebKit2.LoadEvent.FINISHED:
            run_js(ERRORS, lambda _: GLib.timeout_add(600, lambda: (step(), False)[1]))

    view.connect("load-changed", loaded)
    view.load_uri(PAGE)
    GLib.timeout_add_seconds(30, lambda: (print(json.dumps({"engine": "webkitgtk", "timeout": True})), loop.quit()))
    loop.run()


if __name__ == "__main__":
    engine, out_dir = sys.argv[1], Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    server = serve()
    try:
        {"chromium": chromium, "webkitgtk": webkitgtk}[engine](out_dir)
    finally:
        server.shutdown()
        server.server_close()
