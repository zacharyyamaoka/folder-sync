#!/usr/bin/env python3
"""A one-page form for an app deployment's remaining secrets: paste each value, press Save, done.

    python3 accounts/scripts/set-secrets.py --env robotparts

It serves http://127.0.0.1:<port>/ with one box per missing secret and a link to the page where that value lives,
then pipes each value into `wrangler secret put <NAME> --env <env>` and exits once every secret is set.
WHY a local page, not a terminal prompt (Zach, 2026-11-04, /rate bad): "I don't want to have to think about this at
all" — he copies a value, pastes it into a box, and nothing else. Values go from the form to wrangler's stdin only;
they are never printed, logged or written to disk.
"""
import argparse
import html
import json
import os
import subprocess
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

ACCOUNT_ID = "c2747ee6a8842e150e38acc3d044adde"
GOOGLE_PROJECT = "982318096136"
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # accounts/

# Where each value is found, in the order to fill them. The R2 pair comes from one new token, shown once.
SOURCES = {
    "GOOGLE_CLIENT_SECRET": (
        "Google OAuth client secret",
        f"https://console.cloud.google.com/auth/clients?project={GOOGLE_PROJECT}",
        "Open the client used by robotparts.dev and vibetracks.dev. If the secret is hidden, press "
        "<b>Add secret</b> and copy the new one (the old one keeps working).",
    ),
    "R2_PARENT_ACCESS_KEY_ID": (
        "R2 Access Key ID",
        f"https://dash.cloudflare.com/{ACCOUNT_ID}/r2/api-tokens",
        "Press <b>Create Account API token</b>: name <code>folder-sync-accounts-robotparts</code>, permission "
        "<b>Object Read &amp; Write</b>, buckets <code>folder-sync</code> and <code>folder-sync-downloads</code>, then "
        "<b>Create</b>. Copy <b>Access Key ID</b> here and <b>Secret Access Key</b> into the next box.",
    ),
    "R2_PARENT_SECRET_ACCESS_KEY": (
        "R2 Secret Access Key",
        None,
        "From the same token page as the box above (it is shown only once).",
    ),
}


def wrangler(args, value=None):
    return subprocess.run(["npx", "wrangler", *args], cwd=HERE, input=value, capture_output=True, text=True)


def missing(env, wanted):
    out = wrangler(["secret", "list", "--env", env, "--format", "json"])
    try:
        have = {s["name"] for s in json.loads(out.stdout)}
    except (ValueError, KeyError, TypeError):
        have = set()
    return [name for name in wanted if name not in have]


PAGE = """<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Set secrets · {env}</title>
<style>
:root{{--bg:#fff;--fg:#1d1d1f;--muted:#6e6e73;--line:#e5e5ea;--accent:#0a66d8;--ok:#1f8a3b}}
@media (prefers-color-scheme:dark){{:root{{--bg:#1c1c1e;--fg:#f2f2f7;--muted:#a1a1a6;--line:#38383a;--accent:#4c9bff;--ok:#4cc46a}}}}
body{{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}}
main{{max-width:640px;margin:32px auto;padding:0 16px}}
h1{{font-size:20px;margin:0 0 4px}} p.sub{{color:var(--muted);margin:0 0 24px}}
.row{{border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:0 0 12px}}
.row label{{font-weight:600;display:block}} .hint{{color:var(--muted);font-size:13px;margin:4px 0 8px}}
.line{{display:flex;gap:8px}} input{{flex:1;font:14px ui-monospace,monospace;padding:8px;border:1px solid var(--line);
border-radius:6px;background:transparent;color:var(--fg)}}
a.open{{white-space:nowrap;padding:8px 12px;border:1px solid var(--line);border-radius:6px;color:var(--accent);text-decoration:none}}
button{{font:inherit;padding:10px 18px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}}
.done{{color:var(--ok);font-weight:600}} .err{{color:#c0392b}}
</style>
<main><h1>Three values for {env}</h1>
<p class=sub>Copy each value from the page its button opens and paste it here. Save stores them in Cloudflare.</p>
{body}</main>"""


def form(env, names, message=""):
    rows = []
    for name in names:
        label, url, hint = SOURCES.get(name, (name, None, ""))
        link = f'<a class=open href="{url}" target=_blank rel=noopener>Open page ↗</a>' if url else ""
        rows.append(f'<div class=row><label for={name}>{html.escape(label)}</label><div class=hint>{hint}</div>'
                    f'<div class=line><input id={name} name={name} type=password autocomplete=off spellcheck=false>{link}</div></div>')
    return PAGE.format(env=html.escape(env), body=f'{message}<form method=post>{"".join(rows)}<button>Save</button></form>')


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--env", required=True)
    parser.add_argument("--names", nargs="*", default=list(SOURCES))
    parser.add_argument("--port", type=int, default=0)
    opts = parser.parse_args()

    todo = missing(opts.env, opts.names)
    if not todo:
        print(f"every secret for --env {opts.env} is already set")
        return

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # WHY silent: a request line must never carry or echo a value
            pass

        def send(self, body, status=200):
            data = body.encode()
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self.send(form(opts.env, missing(opts.env, opts.names)))

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            fields = urllib.parse.parse_qs(self.rfile.read(length).decode(), keep_blank_values=True)
            failed = []
            for name in missing(opts.env, opts.names):
                value = (fields.get(name) or [""])[0].strip()
                if not value:
                    continue
                if wrangler(["secret", "put", name, "--env", opts.env], value).returncode != 0:
                    failed.append(name)
            left = missing(opts.env, opts.names)
            if not left:
                self.send(PAGE.format(env=html.escape(opts.env), body='<p class=done>All set. You can close this tab.</p>'))
                print(f"all secrets for --env {opts.env} are set")
                self.server.done = True
                return
            note = f'<p class=err>Could not save: {", ".join(failed)}.</p>' if failed else ""
            self.send(form(opts.env, left, note))

    server = HTTPServer(("127.0.0.1", opts.port), Handler)
    server.done = False
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"open {url}", flush=True)
    opener = "/home/bam/.local/bin/open"  # Zach's focus-safe opener; elsewhere the printed URL is enough
    if os.path.exists(opener):
        subprocess.Popen([opener, url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    while not server.done:
        server.handle_request()


if __name__ == "__main__":
    sys.exit(main())
