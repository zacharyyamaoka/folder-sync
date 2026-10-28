/* folder-sync accounts · approve a machine (PEP 0003 §3.5): the verification page of the device authorization grant
   (RFC 8628). A machine (the desktop app, coming; `folder-sync login` for developers) shows a code and this address;
   the person signs in here and approves. Better Auth's
   own endpoints, on this origin's /fs/ mount (moved from Vibe Tracks' worker/site/device.js):

     GET  /fs/api/auth/device?user_code=…     claims the pending code for the signed-in person; its status
     POST /fs/api/auth/device/approve|deny    {userCode}

   WHY the code is shown again and the warning: a device code is phishable (someone else's code, sent to you, would
   sign THEIR machine into YOUR account), so the page asks the person to approve only a code on their own screen. */
(function () {
  'use strict';
  if (!window.FSSignIn) return;
  const { render, post, esc, session, AUTH } = window.FSSignIn;
  const box = document.querySelector('[data-testid="fs-page"] .fs-card');
  const params = new URLSearchParams(location.search);
  const tidy = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const shown = (code) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);
  // WHY the CLI only behind a disclosure (review r3 #9): a person with a browser never meets a terminal; syncing a
  // folder to a computer is the desktop app's (coming), and the command line is for developers and cloud agents
  const DESKTOP = '<p class="fs-small">To sync your folder to a computer, use the folder-sync desktop app (coming).</p>';
  const DEVELOPERS = '<details class="fs-small"><summary>For developers</summary><p>A machine without the app signs in with '
    + '<code>folder-sync login</code>, which shows a code to enter here; run it again for a new code.</p></details>';

  function askCode(note) {
    box.innerHTML = '<h1>Sign in a machine</h1><p>Enter the code your machine shows.</p>'
      + '<input data-testid="fs-device-code" autocomplete="off" spellcheck="false" placeholder="ABCD-EFGH">'
      + '<button class="fs-primary" data-testid="fs-device-continue">Continue</button>'
      + (note ? `<p class="fs-error">${esc(note)}</p>` : '') + DESKTOP + DEVELOPERS;
    const input = box.querySelector('[data-testid="fs-device-code"]');
    const go = () => { const code = tidy(input.value); if (code) step(code); };
    box.querySelector('[data-testid="fs-device-continue"]').onclick = go;
    input.onkeydown = (ev) => { if (ev.key === 'Enter') go(); };
    input.focus();
  }

  async function step(code, user) {
    let status;
    try {
      const r = await fetch(`${AUTH}/device?user_code=${encodeURIComponent(code)}`, { credentials: 'same-origin', cache: 'no-store' });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error((data && (data.error_description || data.message)) || `HTTP ${r.status}`);
      status = data.status;
    } catch (e) {
      return askCode(`That code didn't work: ${(e && e.message) || e}. Codes last 15 minutes; ask the machine for a new one.`);
    }
    if (status === 'approved') return done('This machine is already signed in.');
    if (status === 'denied') return askCode('That request was denied. Ask the machine for a new code.');
    box.innerHTML = '<h1>Sign in a machine?</h1>'
      + `<p>A machine asks to sync your folders${user ? ` as <b>${esc(user.email)}</b>` : ''}. Its code:</p>`
      + `<p class="fs-device-code" data-testid="fs-device-shown">${esc(shown(code))}</p>`
      + '<p class="fs-small">Approve only if this exact code is on your own machine\'s screen right now. Someone else\'s code would sign their machine into your account.</p>'
      + '<button class="fs-primary" data-testid="fs-device-approve">Approve</button>'
      + '<button data-testid="fs-device-deny">Deny</button><p class="fs-error" data-testid="fs-device-error" hidden></p>';
    const fail = (e) => {
      const el = box.querySelector('[data-testid="fs-device-error"]');
      el.hidden = false;
      if (!(e && e.code === 'SIGN_IN_AGAIN')) { el.textContent = (e && e.message) || String(e); return; }
      // a sign-in from before machine approval existed (judge r3 #5): say why, and offer the way out; the reload lands on
      // the sign-in with this code kept, and a fresh sign-in approves it
      el.innerHTML = `${esc(e.message)} <button data-testid="fs-device-sign-out">Sign out</button>`;
      box.querySelector('[data-testid="fs-device-sign-out"]').onclick = async () => {
        await fetch('/fs/v1/sign-out', { method: 'POST', credentials: 'same-origin', headers: { 'X-Folder-Sync': '1', 'X-Folder-Sync-User': user.id } }).catch(() => null);
        location.reload();
      };
    };
    box.querySelector('[data-testid="fs-device-approve"]').onclick = async () => {
      try { await post(`${AUTH}/device/approve`, { userCode: code }); done('Done. The machine is signed in. You can close this tab.'); } catch (e) { fail(e); }
    };
    box.querySelector('[data-testid="fs-device-deny"]').onclick = async () => {
      try { await post(`${AUTH}/device/deny`, { userCode: code }); done('Denied. Nothing was signed in.'); } catch (e) { fail(e); }
    };
  }

  function done(text) {
    box.innerHTML = `<h1>folder-sync</h1><p data-testid="fs-device-done">${esc(text)}</p>`;
  }

  async function boot() {
    const code = tidy(params.get('user_code'));
    const current = await session();
    if (!current || !current.user) {
      return render(box, { lead: code ? `Sign in to approve the machine showing <b>${esc(shown(code))}</b>.` : 'Sign in to approve a machine.', back: location.href });
    }
    if (!code) return askCode();
    return step(code, current.user);
  }
  boot();
})();
