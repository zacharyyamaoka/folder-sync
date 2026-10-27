/* folder-sync accounts · the sign-in card (PEP 0003 §3.3), shared by /fs/signin and /fs/device. Plain DOM, Better
   Auth's endpoints called directly on this origin's /fs/ mount (no SDK bundle on the page). Moved from Vibe Tracks'
   worker/site/signin.js:

     Google (production)   POST /fs/api/auth/sign-in/social {provider: "google", callbackURL} -> {url}; the tab goes there
     email code (dev only) POST /fs/api/auth/email-otp/send-verification-otp, then POST /fs/api/auth/sign-in/email-otp

   /fs/signin?return=<path> sends the tab back to <path> (a same-origin path the Worker already checked) once signed in. */
(function () {
  'use strict';
  const AUTH = '/fs/api/auth';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const meta = (name) => { const el = document.querySelector(`meta[name="${name}"]`); return el ? el.getAttribute('content') : null; };

  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Folder-Sync': '1' }, body: JSON.stringify(body || {}) });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error((data && (data.why || data.message || data.error_description || data.error)) || `HTTP ${r.status}`);
    return data;
  }

  async function session() {
    try {
      const r = await fetch(`${AUTH}/get-session`, { credentials: 'same-origin', cache: 'no-store' });
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  }

  const REFUSED = 'Sign-in was refused: sign-up is invite-only here for now. Ask the owner to add your email.';
  /** Where Google sends the person back when sign-in fails (an email not on the sign-up list): the same page, marked. */
  const refusedURL = (back) => `${back}${back.includes('?') ? '&' : '?'}signin=refused`;

  /** Draws the sign-in into `box`; `lead` is the line above the buttons; `back` is where the tab returns. */
  function render(box, { lead, back, error }) {
    const method = meta('fs-signin') || 'none';
    const app = meta('fs-app') || 'folder-sync';
    const params = new URLSearchParams(location.search);
    if (!error && (params.get('signin') === 'refused' || params.get('error'))) error = REFUSED;
    back = (back || location.href).replace(/[?&]signin=refused/, '').replace(/[?&]error=[^&]*/, '');
    // the ways in, space-separated (google, email, both, or none): production offers email codes once Resend is set up
    const ways = method.split(/\s+/);
    const local = meta('fs-local') === '1';
    let body = '';
    if (ways.includes('google')) {
      body += '<button class="fs-primary" data-testid="fs-signin-google">Continue with Google</button>';
    }
    if (ways.includes('email')) {
      body += `<label class="fs-small" for="fs-signin-email">${ways.includes('google') ? 'Or sign in with a code by email' : 'Email'}${local ? ' (local test sign-in)' : ''}</label>`
        + '<input id="fs-signin-email" data-testid="fs-signin-email" type="email" autocomplete="email">'
        + '<button class="fs-primary" data-testid="fs-signin-send">Send a code</button>'
        + '<div data-testid="fs-signin-code-step" hidden><input data-testid="fs-signin-code" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code">'
        + '<button class="fs-primary" data-testid="fs-signin-verify">Sign in</button></div>';
    }
    if (!body) body = '<p data-testid="fs-signin-closed">Sign-in isn\'t switched on here yet.</p>';
    box.innerHTML = `<h1>${esc(app)}</h1><p>${lead}</p>${body}`
      + `<p class="fs-error" data-testid="fs-signin-error"${error ? '' : ' hidden'}>${esc(error || '')}</p>`
      + '<p class="fs-foot">One account for your folders, on every machine and online.</p>';
    const fail = (e) => { const el = box.querySelector('[data-testid="fs-signin-error"]'); el.hidden = false; el.textContent = (e && e.message) || String(e); };
    const google = box.querySelector('[data-testid="fs-signin-google"]');
    if (google) {
      google.onclick = async () => {
        google.disabled = true;
        try {
          const answer = await post(`${AUTH}/sign-in/social`, { provider: 'google', callbackURL: back, errorCallbackURL: refusedURL(back) });
          if (answer && answer.url) location.assign(answer.url); else throw new Error('Google sign-in did not start');
        } catch (e) { google.disabled = false; fail(e); }
      };
    }
    const send = box.querySelector('[data-testid="fs-signin-send"]');
    if (send) {
      const email = () => box.querySelector('[data-testid="fs-signin-email"]').value.trim();
      send.onclick = async () => {
        try {
          await post(`${AUTH}/email-otp/send-verification-otp`, { email: email(), type: 'sign-in' });
          box.querySelector('[data-testid="fs-signin-code-step"]').hidden = false;
          box.querySelector('[data-testid="fs-signin-code"]').focus();
        } catch (e) { fail(e); }
      };
      box.querySelector('[data-testid="fs-signin-verify"]').onclick = async () => {
        try {
          await post(`${AUTH}/sign-in/email-otp`, { email: email(), otp: box.querySelector('[data-testid="fs-signin-code"]').value.trim() });
          location.replace(back);
        } catch (e) { fail(/invite|user|create/i.test((e && e.message) || '') ? new Error(REFUSED) : e); }
      };
    }
  }

  window.FSSignIn = { render, post, esc, session, AUTH };

  // /fs/signin itself (the device page draws its own card with device.js)
  const box = document.querySelector('[data-testid="fs-page"] .fs-card');
  if (box && !document.querySelector('script[src="/fs/site/device.js"]')) {
    const back = meta('fs-return') || '/';
    session().then((current) => {
      if (current && current.user) return location.replace(back);
      render(box, { lead: 'Sign in to continue.', back: new URL(back, location.origin).href });
    });
  }
})();
