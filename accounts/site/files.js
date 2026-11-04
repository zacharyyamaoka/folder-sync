/* folder-sync accounts · the Files page (/fs/files, src/files-page.ts). Plain DOM, no bundle: asks who is signed in and
   which folders they have, then mounts the sync view's Files tab (the element, /fs/ui/v1/folder-sync.js) on one.

     GET /fs/v1/me         401 -> back to sign-in, then back here
     GET /fs/v1/folders    { folders: [{ project }] }: ?project= if it is one of them, else the first
     <folder-sync-status view="files" project="…">   the browsing itself; its folder picker fires folder-sync:project,
                                                     which keeps ?project= in the address so a reload comes back to it */
(function () {
  'use strict';
  const root = document.getElementById('files');
  if (!root) return;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const say = (html) => { root.innerHTML = `<p class="fsf-note">${html}</p>`; };
  const signIn = () => location.replace(`/fs/signin?return=${encodeURIComponent(location.pathname + location.search)}`);

  async function get(path) {
    const r = await fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
    if (r.status === 401) { signIn(); return null; }
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error((data && data.why) || `HTTP ${r.status}`);
    return data;
  }

  async function boot() {
    try {
      const me = await get('/fs/v1/me');
      if (!me) return;
      const listed = await get('/fs/v1/folders');
      if (!listed) return;
      const names = listed.folders.map((f) => f.project);
      if (!names.length) return say('No folders yet. Sync a folder from a computer with the folder-sync app, then it shows up here.');
      const asked = new URLSearchParams(location.search).get('project');
      const project = names.includes(asked) ? asked : names[0];
      await import('/fs/ui/v1/folder-sync.js');
      root.textContent = '';
      const view = document.createElement('folder-sync-status');
      view.setAttribute('view', 'files');
      view.setAttribute('project', project);
      view.addEventListener('folder-sync:project', (e) => {
        const next = new URL(location.href);
        next.searchParams.set('project', e.detail.project);
        history.replaceState(null, '', next);
      });
      root.append(view);
    } catch (e) {
      say(`Your files could not be loaded: ${esc((e && e.message) || e)}. <a href="">Try again</a>`);
    }
  }
  boot();
})();
