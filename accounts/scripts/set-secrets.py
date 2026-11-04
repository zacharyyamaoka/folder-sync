#!/usr/bin/env python3
"""A one-page guide for an app deployment's remaining secrets: follow the pictures, paste each value, press Save.

    python3 accounts/scripts/set-secrets.py --env robotparts

It serves http://127.0.0.1:<port>/ (and opens it): one section per website, each with an annotated screenshot,
numbered steps, a copy button for every value to type there, and the paste boxes for what that site gives back.
Values are piped into `wrangler secret put <NAME> --env <env>`; the page exits once every secret is set.
A Stripe section (test mode) appears only when the app's wrangler env sets FEATURE_PAYMENTS = "on"; with FEATURE_BYO = "on"
the encryption key for people's own buckets is generated and set for you (never asked for, never printed).
WHY (Zach, 2026-11-04, /rate): "I don't want to have to think about this at all" and "include annotated screen shots
with step by step instructions of what I need to do on each website". Values go from the form to wrangler's stdin
only; they are never printed, logged or written to disk.
"""
import argparse
import base64
import html
import json
import os
import secrets as randomness
import subprocess
import sys
import tomllib
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

ACCOUNT_ID = "c2747ee6a8842e150e38acc3d044adde"
GOOGLE_PROJECT = "vibe-tracks-513000"
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # accounts/
PICTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "set-secrets")


def worker_host(env):
    return f"folder-sync-accounts-{env}.zach-yamaoka.workers.dev"


def features_of(env):
    """The app's switches, read from its own [env.<app>] block of wrangler.toml (docs/NEW-APP.md; src/features.ts is the same
    rule): storage and sync default on, payments and bring-your-own default off, an unrecognised value is off."""
    out = {"storage": True, "sync": True, "payments": False, "byo": False}
    try:
        with open(os.path.join(HERE, "wrangler.toml"), "rb") as f:
            block = tomllib.load(f).get("env", {}).get(env, {}).get("vars", {})
    except (OSError, ValueError):
        block = {}
    for name in out:
        raw = str(block.get("FEATURE_" + name.upper(), "")).strip().lower()
        if raw:
            out[name] = raw in ("on", "true", "1")
    return out


def make_key():
    """32 random bytes, base64: what BYO_ENCRYPTION_KEY is (src/byo.ts derives its AES key from it)."""
    return base64.b64encode(randomness.token_bytes(32)).decode()


def generated(features):
    """Secrets this script makes itself instead of asking for, by name: only what the app's switches need."""
    return {"BYO_ENCRYPTION_KEY": make_key()} if (features or {}).get("byo") else {}


def sites(env, features=None):
    """Each website: where to go, what to do there (with values to copy), and which secrets it gives back.
    WHY its own Google client per app: a Google OAuth client holds at most two secrets, and the shared one is full;
    one client per app also matches "one account per app" (PEP 0003 §3.7)."""
    domain = f"{env}.dev"
    found = [
        {
            "title": "Google: create the sign-in client",
            "url": f"https://console.cloud.google.com/auth/clients/create?project={GOOGLE_PROJECT}",
            # WHY full-resolution PNGs, one per screen, numbers equal to the list's (Zach, /rate 2026-11-04: "low resolution
            # screen shot and no screen shot for the cloud flare"): a picture he has to squint at, or a site without one, is a step he has to work out
            "pictures": ["google-create-client.png"],
            "steps": [
                ("Application type: <b>Web application</b>.", []),
                ("Name:", [domain]),
                ("Under Authorized JavaScript origins, press Add URI once per line:",
                 [f"https://{domain}", f"https://www.{domain}", f"https://{worker_host(env)}"]),
                ("Under Authorized redirect URIs, press Add URI once per line:",
                 [f"https://{domain}/fs/api/auth/callback/google", f"https://www.{domain}/fs/api/auth/callback/google",
                  f"https://{worker_host(env)}/fs/api/auth/callback/google"]),
                ("Press <b>Create</b>. A box shows the Client ID and Client secret: paste both below.", []),
            ],
            "secrets": [("GOOGLE_CLIENT_ID", "Client ID"), ("GOOGLE_CLIENT_SECRET", "Client secret")],
        },
        {
            "title": "Cloudflare: create the storage key",
            "url": f"https://dash.cloudflare.com/{ACCOUNT_ID}/r2/api-tokens",
            "pictures": ["cloudflare-token-list.png", "cloudflare-token-form.png"],
            "note": "If asked, sign in with <b>Continue with Google</b> (zach.yamaoka@gmail.com).",
            "steps": [
                ("Press <b>Create Account API token</b>.", []),
                ("Token name:", [f"folder-sync-accounts-{env}"]),
                ("Permissions: <b>Object Read &amp; Write</b>.", []),
                ("Specify bucket(s): <b>Apply to specific buckets only</b>, then pick both:", ["folder-sync", "folder-sync-downloads"]),
                ("Press <b>Create Account API Token</b>. The next page shows the keys once: paste both below.", []),
            ],
            "secrets": [("R2_PARENT_ACCESS_KEY_ID", "Access Key ID"),
                        ("R2_PARENT_SECRET_ACCESS_KEY", "Secret Access Key")],
        },
    ]
    if (features or {}).get("payments"):
        found.append({
            "title": "Stripe: test-mode keys, products and webhook",
            "url": "https://dashboard.stripe.com/test/apikeys",
            "pictures": [],
            "steps": [
                ("Stay in <b>test mode</b> for every step (the Test mode / Sandbox switch at the top of the dashboard). "
                 "Real keys are refused by the Worker; payments here are rehearsal only.", []),
                ("On this page (Developers, API keys), copy the <b>Secret key</b> (starts with sk_test_) into the first box below.", []),
                ("Product catalog, Add product: one product per plan, a monthly recurring price, and under "
                 "Additional options set the <b>Lookup key</b>. Plus (10 GiB):", ["folder-sync-plus"]),
                ("A second product, Pro (100 GiB), lookup key:", ["folder-sync-pro"]),
                ("Developers, Webhooks, Add endpoint. Endpoint URL:", [f"https://{worker_host(env)}/fs/api/auth/stripe/webhook"]),
                ("Select these four events (search each, tick it):",
                 ["checkout.session.completed", "customer.subscription.created",
                  "customer.subscription.updated", "customer.subscription.deleted"]),
                ("Press <b>Add endpoint</b>, then reveal the <b>Signing secret</b> (starts with whsec_) and paste it into the second box below.", []),
            ],
            "secrets": [("STRIPE_SECRET_KEY", "Secret key (sk_test_…)"), ("STRIPE_WEBHOOK_SECRET", "Signing secret (whsec_…)")],
        })
    return found


def wrangler(args, value=None):
    return subprocess.run(["npx", "wrangler", *args], cwd=HERE, input=value, capture_output=True, text=True)


def have(env):
    out = wrangler(["secret", "list", "--env", env, "--format", "json"])
    try:
        return {s["name"] for s in json.loads(out.stdout)}
    except (ValueError, KeyError, TypeError):
        return set()


def picture(name):
    """One annotated screenshot at its native resolution; a click opens it full size."""
    path = os.path.join(PICTURES, name)
    if not os.path.exists(path):
        return ""
    with open(path, "rb") as f:
        data = base64.b64encode(f.read()).decode()
    kind = "png" if name.endswith(".png") else "jpeg"
    return (f'<figure><img alt="Annotated screenshot: the red numbers match the steps" '
            f'src="data:image/{kind};base64,{data}"><figcaption>Click to enlarge</figcaption></figure>')


PAGE = """<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Set secrets · {env}</title>
<style>
:root{{--bg:#fff;--fg:#1d1d1f;--muted:#6e6e73;--line:#e5e5ea;--accent:#0a66d8;--ok:#1f8a3b;--chip:#f2f2f7}}
@media (prefers-color-scheme:dark){{:root{{--bg:#1c1c1e;--fg:#f2f2f7;--muted:#a1a1a6;--line:#38383a;--accent:#4c9bff;--ok:#4cc46a;--chip:#2c2c2e}}}}
body{{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}}
main{{max-width:1120px;margin:28px auto;padding:0 16px}}
h1{{font-size:20px;margin:0 0 4px}} p.sub{{color:var(--muted);margin:0 0 20px}}
section{{border:1px solid var(--line);border-radius:12px;padding:16px;margin:0 0 16px}}
h2{{font-size:17px;margin:0 0 10px;display:flex;justify-content:space-between;align-items:center;gap:8px}}
a.open{{font-size:14px;font-weight:500;white-space:nowrap;padding:6px 12px;border-radius:6px;background:var(--accent);color:#fff;text-decoration:none}}
figure{{margin:0 0 14px}} figure img{{display:block;max-width:100%;height:auto;border-radius:8px;border:1px solid var(--line);cursor:zoom-in}}
figcaption{{color:var(--muted);font-size:12px;margin:4px 0 0}} p.note{{color:var(--muted);margin:0 0 10px}}
dialog{{padding:0;border:0;background:transparent;max-width:98vw;max-height:98vh}} dialog::backdrop{{background:rgba(0,0,0,.8)}}
dialog img{{display:block;max-width:98vw;max-height:98vh;cursor:zoom-out}}
ol{{padding-left:20px;margin:0 0 12px}} li{{margin:0 0 8px}}
.copy{{display:flex;gap:6px;align-items:center;margin:4px 0}} code{{background:var(--chip);padding:3px 6px;border-radius:5px;
font:13px ui-monospace,monospace;overflow-wrap:anywhere}}
button.c{{font:12px system-ui;padding:3px 8px;border:1px solid var(--line);border-radius:5px;background:transparent;color:var(--accent);cursor:pointer}}
.box{{clear:both;margin:8px 0 0}} .box label{{font-weight:600;display:block;margin:6px 0 2px}}
input{{width:100%;box-sizing:border-box;font:14px ui-monospace,monospace;padding:8px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--fg)}}
button.save{{font:inherit;padding:10px 22px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}}
.done{{color:var(--ok);font-weight:600}} .err{{color:#c0392b}} .set{{color:var(--ok);font-size:13px}}
</style>
<main><h1>{headline}</h1>
<p class=sub>For the <b>{env}</b> accounts Worker. Open each site, do the numbered steps (copy buttons hold every value to type),
paste what it gives back into the boxes, then press Save once at the bottom.</p>
{body}</main>
<script>
const zoom=document.createElement('dialog');document.body.append(zoom);zoom.onclick=()=>zoom.close()
document.querySelectorAll('figure img').forEach(i=>i.onclick=()=>{{zoom.innerHTML='';zoom.append(i.cloneNode());zoom.showModal()}})
document.querySelectorAll('button.c').forEach(b=>b.onclick=()=>{{navigator.clipboard.writeText(b.dataset.v);b.textContent='Copied';setTimeout(()=>b.textContent='Copy',1200)}})
</script>"""


def form(env, todo, message="", features=None):
    parts = [message, "<form method=post>"]
    shown = [s for s in sites(env, features) if any(n in todo for n, _ in s["secrets"])]
    for site in sites(env, features):
        wanted = [(n, l) for n, l in site["secrets"] if n in todo]
        if not wanted:
            continue
        steps = []
        for text, values in site["steps"]:
            chips = "".join(f'<div class=copy><code>{html.escape(v)}</code>'
                            f'<button type=button class=c data-v="{html.escape(v)}">Copy</button></div>' for v in values)
            steps.append(f"<li>{text}{chips}</li>")
        note = f'<p class=note>{site["note"]}</p>' if site.get("note") else ""
        boxes = "".join(f'<div class=box><label for={n}>{html.escape(l)}</label>'
                        f'<input id={n} name={n} type=password autocomplete=off spellcheck=false></div>' for n, l in wanted)
        parts.append(f'<section><h2>{html.escape(site["title"])}<a class=open href="{site["url"]}" target=_blank '
                     f'rel=noopener>Open page ↗</a></h2>{note}{"".join(picture(n) for n in site["pictures"])}<ol>{"".join(steps)}</ol>{boxes}</section>')
    parts.append("<button class=save>Save</button></form>")
    words = {1: "One website", 2: "Two websites", 3: "Three websites"}.get(len(shown), f"{len(shown)} websites")
    return PAGE.format(env=html.escape(env), headline=f"{words}, {len(todo)} value{'' if len(todo) == 1 else 's'}, one Save", body="".join(parts))


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--env", required=True)
    parser.add_argument("--replace", nargs="*", default=["GOOGLE_CLIENT_ID"],
                        help="secrets to ask for even if already set (default: GOOGLE_CLIENT_ID, since a new client replaces it)")
    parser.add_argument("--port", type=int, default=0)
    opts = parser.parse_args()

    features = features_of(opts.env)
    already = have(opts.env)
    # WHY made here and not asked for: a random key is nothing a person should type or see (Zach: "I don't want to have to
    # think about this at all"); it is piped to wrangler and never printed. An existing one stays: changing it would make
    # every attached bucket's keys unreadable.
    for name, value in generated(features).items():
        if name not in already:
            made = wrangler(["secret", "put", name, "--env", opts.env], value)
            print(f"{name}: {'set' if made.returncode == 0 else 'could not be set'}")
    names = [n for site in sites(opts.env, features) for n, _ in site["secrets"]]
    state = {"todo": [n for n in names if n not in already or n in opts.replace]}
    if not state["todo"]:
        print(f"every secret for --env {opts.env} is already set")
        return

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # WHY silent: a request line must never carry or echo a value
            pass

        def send(self, body):
            data = body.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self.send(form(opts.env, state["todo"], features=features))

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            fields = urllib.parse.parse_qs(self.rfile.read(length).decode(), keep_blank_values=True)
            failed = []
            for name in list(state["todo"]):
                value = (fields.get(name) or [""])[0].strip()
                if not value:
                    continue
                if wrangler(["secret", "put", name, "--env", opts.env], value).returncode == 0:
                    state["todo"].remove(name)
                else:
                    failed.append(name)
            if not state["todo"]:
                self.send(PAGE.format(env=html.escape(opts.env), headline="Done", body="<p class=done>All set. You can close this tab.</p>"))
                print(f"all secrets for --env {opts.env} are set")
                self.server.done = True
                return
            note = f'<p class=err>Could not save: {", ".join(failed)}.</p>' if failed else ""
            self.send(form(opts.env, state["todo"], note, features))

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
