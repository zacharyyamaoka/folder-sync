'use strict';
// The gates (G1..G12, docs/GATES.md): what proves each one, how a proof's output becomes a status, and the file the dev view
// reads. scripts/gates is the command; this file holds everything a test can reach without running a single proof.
//
// A gate is pass/fail and satisficing. Its status is:
//   fail       a proof ran and failed
//   not_built  a proof the gate needs does not exist yet (or cannot run here: a runner we do not have), and none failed
//   skipped    a proof exists but was left out of this run (a profile, a missing tool), and none failed
//   pass       every proof the gate needs ran, and all passed
// WHY never a fake pass: a gate whose proof is missing says so in its summary, with what is missing.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SCHEMA = 'folder-sync-gates/1';
const GATE_IDS = Array.from({ length: 12 }, (_, i) => `G${i + 1}`);

// --- proofs ------------------------------------------------------------------------------------------------------------
// { kind: 'go', pkg, tests: [top-level Test names] | all: true, env }    go test -json, each named test must run
// { kind: 'node', cwd, file, pattern? }                                   node --test --test-reporter=tap
// { kind: 'cmd', name, argv, cwd, needs: 'web' }                          exit 0 is pass
// { kind: 'inline', name, fn }                                            a function of the context returning tests
// { kind: 'missing', name, reason }                                       the proof does not exist: the gate is not_built
// { advisory: true } on any proof: its result is shown but cannot make the gate pass or fail it

function definitions(ctx) {
  const soakReport = path.join('evidence', `soak-${ctx.soakProfile}.json`);
  const NODE_ACCOUNTS = { kind: 'node', cwd: 'accounts' };
  return [
    {
      id: 'G1', name: 'Nothing lost',
      target: 'A randomized soak (edits, deletes, renames, moves, kills mid-sync, offline periods, concurrent rounds, a second person editing a peer copy; three machines and the web host) ends 100% converged with 0 lost versions.',
      proofs: [
        { kind: 'go', pkg: './e2e', tests: ['TestSoakNothingLost'],
          env: { FOLDER_SYNC_SOAK: ctx.soakProfile === 'smoke' ? '' : ctx.soakProfile, FOLDER_SYNC_SOAK_SEED: String(ctx.soakSeed), FOLDER_SYNC_SOAK_REPORT: path.join(ctx.outDir, soakReport) },
          evidence: [soakReport] },
      ],
    },
    {
      id: 'G2', name: 'Version history',
      target: 'Any version kept in the last 30 days restores byte-identical (edits 5 minutes apart are all kept; hourly then daily beyond the first hour); a deleted file restores for 30 days and not for 31.',
      proofs: [
        { kind: 'go', pkg: './e2e', tests: ['TestGateVersionHistory30Days', 'TestGateEditsFiveMinutesApartAreAllKept', 'TestHistory'] },
        { kind: 'go', pkg: './internal/history', all: true },
        { ...NODE_ACCOUNTS, file: 'test/history.test.ts' },
      ],
    },
    {
      id: 'G3', name: 'Private',
      target: 'No one can read another account\'s files: short-lived keys scoped to the person\'s prefix, and a cross-account test (403/404, never the other\'s bytes).',
      proofs: [
        { kind: 'go', pkg: './e2e', tests: ['TestScopedCredentialsKeepPeopleApart'] },
        { ...NODE_ACCOUNTS, file: 'test/worker.test.ts', pattern: 'two people:|mutation: a root|mutation: a private folder|mutation: storage keys' },
        { ...NODE_ACCOUNTS, file: 'test/storage.test.ts', pattern: 'nobody sees another account' },
        { ...NODE_ACCOUNTS, file: 'test/app-root.test.ts', pattern: 'two deployments, one bucket' },
      ],
    },
    {
      id: 'G4', name: 'Cross-platform',
      target: 'The Linux/macOS/Windows CI matrix and the installer smoke test are green.',
      // WHY a leg proof when ctx.leg is set: scripts/gates --os-leg <os> runs inside one OS's CI job and writes gates-<os>.json,
      // whose G4 says whether that OS's test job passed; the gates job then reads the three files back (ci4)
      proofs: ctx.leg ? [{ kind: 'inline', name: 'leg', fn: leg4 }] : [
        { kind: 'cmd', name: 'workflows: actionlint over .github/workflows (scripts/gates-actionlint, pinned)', argv: ['bash', 'scripts/gates-actionlint'] },
        { kind: 'inline', name: 'ci', fn: ci4 },
      ],
    },
    {
      id: 'G5', name: 'Three surfaces',
      target: 'The CLI, the desktop app and the web app each pass one end-to-end journey.',
      proofs: [
        { kind: 'go', pkg: './e2e', tests: ['TestTwoMachines'] },
        { kind: 'cmd', name: 'web: the Files page against the real accounts Worker (ui/scripts/files-real.mjs)', argv: ['node', 'ui/scripts/files-real.mjs'], needs: 'web' },
        { kind: 'cmd', name: 'desktop: open the folder, see its files, edit one, see it synced (app/test/journey.mjs: the shell\'s page in Chromium over the real engine)', argv: ['node', 'app/test/journey.mjs'], needs: 'web' },
      ],
    },
    {
      id: 'G6', name: 'Headless',
      target: 'A fresh machine syncs from a script: no terminal, no prompt, no browser.',
      proofs: [{ kind: 'go', pkg: './e2e', tests: ['TestGateHeadlessFreshMachine'] }],
    },
    {
      id: 'G7', name: 'Storage provider swappable',
      target: 'The core e2e passes against R2, another S3 store and a file:// folder.',
      proofs: [
        { kind: 'missing', name: 'the core e2e against a second S3 store (MinIO or Backblaze B2)', reason: 'the e2e runs only on rclone serve s3 and the R2 stand-in; no second store is wired (wave 2, the storage-agnostic lane)' },
        { kind: 'missing', name: 'the core e2e on a file:// folder', reason: 'storage is S3-only today (internal/creds, internal/rclone build an s3 remote); a file:// hub is the storage-agnostic lane' },
      ],
    },
    {
      id: 'G8', name: 'Drop-in',
      target: 'An app gets sync, accounts and the sync view in 20 lines of app code or fewer, with no new server; and in 30 minutes of agent time or less.',
      proofs: [
        { kind: 'inline', name: 'dropin', fn: dropIn8 },
        { kind: 'missing', advisory: true, name: 'a fresh agent adds sync to a new app in 30 minutes or less', reason: 'needs a timed agent trial on a scratch app; none has been run' },
      ],
    },
    {
      id: 'G9', name: 'Ignore rules',
      target: 'gitignore-style ignore rules; OS junk (.DS_Store, Thumbs.db, desktop.ini, ._*) ignored by default and overridable; NFC and NFD names land exactly once under the spelling their writer used.',
      proofs: [
        { kind: 'go', pkg: './internal/ignore', tests: ['TestDefaultsKeepOSJunkOut', 'TestOSJunkDefaultsAreOverridable', 'TestGitignoreStyleRules', 'TestMatchesGit', 'TestDefaultsAreFirstAndOverridable'] },
        { kind: 'go', pkg: './internal/syncer', tests: ['TestTwinGroupsFindNamesThatAreOneFileOnThisDisk'] },
        { kind: 'go', pkg: './e2e', tests: ['TestCrossOSRoundTrip', 'TestNormalizationOneFileTwoSpellings', 'TestNormalizationRespelledFileKeepsItsBytes'] },
      ],
    },
    {
      id: 'G10', name: 'Accounts',
      target: 'Google and email-code sign-in; one deployment per app.',
      proofs: [
        { ...NODE_ACCOUNTS, file: 'test/worker.test.ts', pattern: 'production never offers email codes|review r3 #8, production email codes|the pages: sign-in and device|sign-up: the list|me: the session|the registry' },
        { ...NODE_ACCOUNTS, file: 'test/app-root.test.ts' },
        { ...NODE_ACCOUNTS, file: 'test/real-auth.test.ts' },
        { ...NODE_ACCOUNTS, file: 'test/identity-seam.test.ts' },
      ],
    },
    {
      id: 'G11', name: 'Easy to start',
      target: 'From a fresh machine to the first sync in 2 minutes or less, on Linux, macOS and Windows.',
      proofs: ctx.leg ? [{ kind: 'inline', name: 'timer', fn: timer11 }] : [
        { kind: 'go', pkg: './e2e', tests: ['TestGateFirstSyncWithinTwoMinutes'], env: { FOLDER_SYNC_G11_OUT: path.join(ctx.outDir, 'evidence', 'g11-local.json') }, evidence: ['evidence/g11-local.json'] },
        { kind: 'inline', name: 'platforms', fn: platforms11 },
        // the whole walk on a clean HOME: install, sign in, add a folder, first file read back (scripts/first-sync-timer)
        { kind: 'inline', name: 'timer', fn: timer11 },
      ],
    },
    {
      id: 'G12', name: 'Trusted restore',
      target: 'A restore takes 5 seconds or less.',
      proofs: [{ kind: 'go', pkg: './e2e', tests: ['TestGateRestoreWithinFiveSeconds'] }],
    },
  ];
}

// --- parsing -----------------------------------------------------------------------------------------------------------

// parseGoJson turns `go test -json` output into one entry per top-level test, and the build/package failure if there is one.
function parseGoJson(text) {
  const tests = new Map();
  const output = [];
  let packageFailed = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) { if (line.trim()) output.push(line); continue; }
    let ev;
    try { ev = JSON.parse(line); } catch { output.push(line); continue; }
    if (!ev.Test) {
      if (ev.Action === 'fail') packageFailed = true;
      if (ev.Action === 'output' && ev.Output) output.push(ev.Output.replace(/\n$/, ''));
      continue;
    }
    const top = ev.Test.split('/')[0];
    const entry = tests.get(top) || { name: top, status: null, duration_ms: 0, lines: [] };
    tests.set(top, entry);
    if (ev.Action === 'output' && ev.Output) entry.lines.push(ev.Output.replace(/\n$/, ''));
    if (ev.Test === top && (ev.Action === 'pass' || ev.Action === 'fail' || ev.Action === 'skip')) {
      entry.status = ev.Action === 'pass' ? 'pass' : ev.Action === 'fail' ? 'fail' : 'skip';
      entry.duration_ms = Math.round((ev.Elapsed || 0) * 1000);
    }
  }
  return { tests: [...tests.values()], output, packageFailed };
}

function tail(lines, n) {
  const kept = lines.filter((l) => !/^\s*(=== |--- )/.test(l)).map((l) => l.trimEnd());
  return kept.slice(-n).join('\n').trim();
}

// parseTap reads node --test's TAP output: the tests at indent 0 and their duration_ms.
function parseTap(text) {
  const tests = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/.exec(lines[i]);
    if (!m) continue;
    const entry = { name: m[2], status: m[1] === 'ok' ? 'pass' : 'fail', duration_ms: 0, detail: '' };
    if (m[3] === 'SKIP') entry.status = 'skip';
    const block = [];
    if (/^\s+---$/.test(lines[i + 1] || '')) {
      for (let j = i + 2; j < lines.length && !/^\s+\.\.\.$/.test(lines[j]); j++) block.push(lines[j]);
    }
    const dur = block.map((l) => /duration_ms: ([\d.]+)/.exec(l)).find(Boolean);
    if (dur) entry.duration_ms = Math.round(parseFloat(dur[1]));
    if (entry.status === 'fail') entry.detail = block.filter((l) => !/duration_ms|type:/.test(l)).join('\n').trim().slice(0, 1500);
    tests.push(entry);
  }
  return tests;
}

// --- status -------------------------------------------------------------------------------------------------------------

// aggregate answers a gate's status and one-line summary from its proofs' results.
// results: [{ tests: [{name,status,...}], notBuilt: [{name, reason}], advisory }]
function aggregate(results) {
  let pass = 0, fail = 0, skip = 0;
  const missing = [];
  const failing = [];
  const skipped = [];
  for (const r of results) {
    for (const t of r.tests) {
      if (r.advisory) continue;
      if (t.status === 'pass') pass++;
      else if (t.status === 'fail') { fail++; failing.push(t.name); }
      else { skip++; skipped.push(t.name); }
    }
    if (!r.advisory) for (const m of r.notBuilt || []) missing.push(m);
  }
  const counts = `${pass} passed${fail ? `, ${fail} failed` : ''}${skip ? `, ${skip} skipped` : ''}${missing.length ? `, ${missing.length} proof${missing.length > 1 ? 's' : ''} not built` : ''}`;
  if (fail) return { status: 'fail', summary: `${counts}. Failing: ${failing.join('; ')}` };
  if (missing.length) return { status: 'not_built', summary: `${counts}. Missing: ${missing.map((m) => `${m.name} (${m.reason})`).join('; ')}` };
  if (skip) return { status: 'skipped', summary: `${counts}. Left out: ${skipped.join('; ')}` };
  if (!pass) return { status: 'not_built', summary: 'no proof ran' };
  return { status: 'pass', summary: counts };
}

// validate checks a gates document against the frozen shape (folder-sync-gates/1).
function validate(doc) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };
  need(doc && doc.schema === SCHEMA, `schema must be ${SCHEMA}`);
  need(typeof doc.run_at === 'string' && !Number.isNaN(Date.parse(doc.run_at)), 'run_at must be an ISO time');
  need(typeof doc.code_sha === 'string' && doc.code_sha.length > 0, 'code_sha');
  need(typeof doc.branch === 'string', 'branch');
  need(Array.isArray(doc.gates) && doc.gates.length === 12, 'gates must hold G1..G12');
  (doc.gates || []).forEach((g, i) => {
    need(g.id === GATE_IDS[i], `gate ${i} must be ${GATE_IDS[i]}`);
    need(typeof g.name === 'string' && g.name, `${g.id}: name`);
    need(['pass', 'fail', 'not_built', 'skipped'].includes(g.status), `${g.id}: status ${g.status}`);
    need(typeof g.summary === 'string' && g.summary, `${g.id}: summary`);
    need(Array.isArray(g.tests), `${g.id}: tests`);
    need(Array.isArray(g.evidence), `${g.id}: evidence`);
    for (const t of g.tests || []) {
      need(typeof t.name === 'string' && ['pass', 'fail', 'skip'].includes(t.status), `${g.id}: test ${t.name} status ${t.status}`);
      need(Number.isFinite(t.duration_ms), `${g.id}: test ${t.name} duration_ms`);
      need(typeof t.detail === 'string', `${g.id}: test ${t.name} detail`);
    }
  });
  return problems;
}

// --- inline proofs ------------------------------------------------------------------------------------------------------

function sh(argv, opts = {}) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd: opts.cwd || REPO, encoding: 'utf8', timeout: opts.timeout || 60000, env: { ...process.env, ...(opts.env || {}) } });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

function gh(args) {
  const r = sh(['gh', ...args], { timeout: 30000 });
  if (r.error || r.status !== 0) return { error: (r.stderr || (r.error && r.error.message) || 'gh failed').trim().split('\n')[0] };
  try { return { json: JSON.parse(r.stdout) }; } catch { return { error: 'gh printed no JSON' }; }
}

function entry(name, status, detail, duration_ms = 0) { return { name, status, duration_ms, detail: detail || '' }; }

// The three OS legs of the CI matrix, by the name the matrix and gates-<os>.json use; GOOS spells macOS "darwin".
const LEGS = ['linux', 'macos', 'windows'];
const GOOS_OF_LEG = { linux: 'linux', macos: 'darwin', windows: 'windows' };

// readLegs reads the gates-<os>.json files each OS's job uploaded (`scripts/gates --os-leg`), from a directory of downloaded
// artifacts (actions/download-artifact puts each in a folder of its own; `gh run download` too): { linux: {doc, file}|null, ... }.
function readLegs(dir) {
  const found = Object.fromEntries(LEGS.map((name) => [name, null]));
  for (const file of walk(dir)) {
    const m = /gates-(linux|macos|windows)\.json$/.exec(file);
    if (!m) continue;
    try { found[m[1]] = { doc: JSON.parse(fs.readFileSync(file, 'utf8')), file }; } catch { found[m[1]] = { doc: null, file }; }
  }
  return found;
}

// leg4: inside one OS's CI job, G4 is that job's own result (scripts/gates --os-leg <os> --job-status ${{ job.status }}, run as the
// job's last step with `if: always()`). The gates job reads the three files back and passes G4 only when all three passed.
function leg4(ctx) {
  const { os: legOs, jobStatus } = ctx.leg;
  return { tests: [entry(`${legOs}: the test job (vet, the Go suite with the e2e, schema fixtures, first sync)`, jobStatus === 'success' ? 'pass' : 'fail', `job.status = ${jobStatus}`)], notBuilt: [] };
}

// legTests turns the downloaded gates-<os>.json files into G4 entries: pass only when that leg's own G4 passed, and only for
// this commit (a green from another commit is a skip, never a pass).
function legTests(ctx) {
  const tests = [];
  const notBuilt = [];
  const legs = readLegs(ctx.osResults);
  for (const name of LEGS) {
    const found = legs[name];
    if (!found) { notBuilt.push({ name: `CI leg ${name}`, reason: `no gates-${name}.json in ${ctx.osResults}: that OS's job has not uploaded one` }); continue; }
    const doc = found.doc;
    const problems = doc ? lintLeg(doc, name) : ['not JSON'];
    if (problems.length) { tests.push(entry(`CI leg ${name} (gates-${name}.json)`, 'fail', `unreadable: ${problems.join('; ')}`)); continue; }
    const g4 = doc.gates.find((g) => g.id === 'G4');
    const sha = String(doc.code_sha).replace(/\+dirty$/, '');
    const where = `${doc.leg.runner || name}, ${doc.leg.arch || '?'}`;
    if (ctx.sha && sha !== ctx.sha) tests.push(entry(`CI leg ${name} (${where}) on ${sha.slice(0, 7)}, not this commit ${ctx.sha.slice(0, 7)}`, 'skip', g4 ? g4.summary : ''));
    else tests.push(entry(`CI leg ${name} (${where})`, g4 && g4.status === 'pass' ? 'pass' : 'fail', g4 ? g4.summary : 'the file has no G4'));
  }
  return { tests, notBuilt };
}

function lintLeg(doc, name) {
  const problems = validate(doc);
  if (!doc.leg || doc.leg.os !== name) problems.push(`leg.os is ${doc.leg && doc.leg.os}, the file says ${name}`);
  if (!doc.gates || !doc.gates.find((g) => g.id === 'G4')) problems.push('no G4');
  return problems;
}

// ci4: the three OS legs (the gates-<os>.json each job uploaded, else the workflow's own `needs`, else the latest run GitHub has)
// and the installer smoke.
function ci4(ctx) {
  const tests = [];
  const notBuilt = [];
  const wanted = ['test (linux)', 'test (macos)', 'test (windows)'];
  if (ctx.needs) {
    const result = (name) => (ctx.needs[name] && ctx.needs[name].result) || null;
    const matrix = result('test');
    tests.push(entry('CI matrix: test (linux, macos, windows), this run', matrix === 'success' ? 'pass' : matrix ? 'fail' : 'skip', `needs.test.result = ${matrix}`));
    for (const job of ['core-alone', 'server-cloudflare', 'ui', 'pair-pull']) {
      if (ctx.needs[job]) tests.push(entry(`CI job ${job}, this run`, result(job) === 'success' ? 'pass' : 'fail', `needs.${job}.result = ${result(job)}`));
    }
  } else if (ctx.osResults) {
    // the legs below are the matrix
  } else if (ctx.noGh) {
    notBuilt.push({ name: 'CI matrix status', reason: 'not read: --no-gh' });
  } else {
    const found = latestRun('test.yml', ctx);
    if (found.error) notBuilt.push({ name: 'CI matrix status', reason: found.error });
    else {
      for (const name of wanted) {
        const job = found.jobs.find((j) => j.name === name);
        tests.push(entry(`${name} on ${found.where}`, !job ? 'skip' : job.conclusion === 'success' ? 'pass' : job.conclusion === 'failure' ? 'fail' : 'skip', job ? `${job.conclusion || job.status}: ${found.url}` : `no job named ${name} in ${found.url}`));
      }
    }
  }
  if (ctx.osResults) {
    const legs = legTests(ctx);
    tests.push(...legs.tests);
    notBuilt.push(...legs.notBuilt);
  } else if (ctx.needs) {
    notBuilt.push({ name: 'CI legs (gates-<os>.json)', reason: 'the gates job was not given --os-results, so which OS passed is unread' });
  }
  // the installer smoke: this run's own `desktop` job in CI (test.yml calls desktop-smoke.yml), else the latest run GitHub has
  if (ctx.needs && ctx.needs.desktop) {
    const r = ctx.needs.desktop.result;
    tests.push(entry('installer smoke (desktop-smoke.yml: linux, macos, windows), this run', r === 'success' ? 'pass' : r === 'skipped' ? 'skip' : 'fail', `needs.desktop.result = ${r}`));
  } else {
    const smoke = installerSmoke(ctx);
    tests.push(...smoke.tests);
    notBuilt.push(...smoke.notBuilt);
  }
  return { tests, notBuilt };
}

// latestRun finds the newest completed run of a workflow: on this branch, else the default branch, else on any branch (a
// lane's push is the only run there may be), and says which commit it was, so a green on another commit is never read as ours.
function latestRun(workflow, ctx) {
  for (const b of [ctx.branch, ctx.defaultBranch, null]) {
    const args = ['run', 'list', '--workflow', workflow, '--status', 'completed', '--limit', '1', '--json', 'databaseId,headSha,headBranch,conclusion,url'];
    if (b) args.push('--branch', b);
    const list = gh(args);
    if (list.error) return { error: `gh: ${list.error}` };
    if (list.json.length) {
      const run = list.json[0];
      const view = gh(['run', 'view', String(run.databaseId), '--json', 'jobs']);
      if (view.error) return { error: `gh: ${view.error}` };
      return { jobs: view.json.jobs, url: run.url, conclusion: run.conclusion, sha: run.headSha, where: `${run.headBranch}@${run.headSha.slice(0, 7)}${run.headSha === ctx.sha ? '' : ' (not this commit)'}` };
    }
  }
  return { error: `GitHub has no completed run of ${workflow}` };
}

function installerSmoke(ctx) {
  if (ctx.noGh) return { tests: [], notBuilt: [{ name: 'installer smoke status', reason: 'not read: --no-gh' }] };
  const list = gh(['run', 'list', '--workflow', 'desktop-smoke.yml', '--status', 'completed', '--limit', '1', '--json', 'databaseId,headSha,conclusion,url,headBranch']);
  if (list.error) return { tests: [], notBuilt: [{ name: 'installer smoke (desktop-smoke.yml)', reason: /404/.test(list.error) ? 'GitHub has no workflow named desktop-smoke.yml yet (it is not on the default branch)' : `gh: ${list.error}` }] };
  if (!list.json.length) return { tests: [], notBuilt: [{ name: 'installer smoke (desktop-smoke.yml)', reason: 'it has never run (it runs on changes to app/**)' }] };
  const run = list.json[0];
  return { tests: [entry(`installer smoke (desktop-smoke.yml) on ${run.headBranch}@${run.headSha.slice(0, 7)}`, run.conclusion === 'success' ? 'pass' : 'fail', `${run.conclusion}: ${run.url}`)], notBuilt: [] };
}

// dropIn8 counts the lines an app writes to adopt folder-sync: the page's two snippet lines (docs/API.md), the app Worker's
// own file, and the service binding. Conservative: every non-blank, non-comment line of demo/worker.ts counts, whether or not
// an app needs it.
function dropIn8() {
  const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
  const codeLines = (text, comment) => text.split('\n').map((l) => l.trim()).filter((l) => l && !comment.test(l));
  const api = read('docs/API.md');
  const fence = /```html\n([\s\S]*?)```/.exec(api.slice(api.indexOf('## The element')));
  const snippet = fence ? codeLines(fence[1], /^$/) : [];
  const worker = codeLines(read('demo/worker.ts'), /^(\/\/|\/\*|\*)/);
  const toml = read('demo/wrangler.toml');
  const binding = /\[\[services\]\]\n(?:[^\n\[]+\n?)+/.exec(toml);
  const bindingLines = binding ? codeLines(binding[0], /^#/) : [];
  const page = read('demo/site/index.html');
  const total = snippet.length + worker.length + bindingLines.length;
  const tests = [
    entry(`drop-in is 20 lines or fewer (${snippet.length} page + ${worker.length} Worker + ${bindingLines.length} binding = ${total})`, total <= 20 ? 'pass' : 'fail',
      `page snippet (docs/API.md "The element"): ${snippet.join(' | ')}; Worker: demo/worker.ts; binding: demo/wrangler.toml [[services]]`),
    // the script line verbatim, and the element (its attributes are the app's own: a project name, a test id)
    entry('the demo page embeds the documented snippet', snippet.length === 2 && page.includes(snippet[0]) && page.includes('<folder-sync-status') ? 'pass' : 'fail',
      `demo/site/index.html must hold ${snippet[0]} and a <folder-sync-status>`),
    entry('the app holds no server of its own: the Worker only forwards /fs/* and serves assets', /env\.FOLDER_SYNC\.fetch\(request\)/.test(read('demo/worker.ts')) && !/(R2|D1|KV|DurableObject|secret)/i.test(worker.join('\n')) ? 'pass' : 'fail', 'demo/worker.ts'),
  ];
  return { tests, notBuilt: [] };
}

// platforms11: the first-sync times the matrix jobs uploaded (--collect <dir> holds g11-<os>.json files)
function platforms11(ctx) {
  const tests = [];
  const notBuilt = [];
  const found = {};
  if (ctx.collect) {
    for (const file of walk(ctx.collect).filter((f) => /g11-[a-z]+\.json$/.test(f))) {
      try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); found[d.os] = d; } catch { /* ignored: reported below as missing */ }
    }
  }
  for (const [osName, label] of [['darwin', 'macOS'], ['windows', 'Windows']]) {
    const d = found[osName];
    if (d) tests.push(entry(`first sync on ${label} in 2 minutes or less (${d.seconds.toFixed(1)} s)`, d.seconds <= 120 ? 'pass' : 'fail', d.measures || '', Math.round(d.seconds * 1000)));
    else notBuilt.push({ name: `first sync on ${label}`, reason: 'measured by the CI matrix job (FOLDER_SYNC_G11_OUT), not on this machine' });
  }
  return { tests, notBuilt };
}

// timer11: the first-sync-<os>.json files scripts/first-sync-timer wrote (install, sign in, add a folder, first file read back, on
// a clean HOME), one per OS: from --collect (the CI jobs upload them) and from this run's evidence folder. On a host with none,
// --with-web runs the timer here. A platform with no file is not built, never passed.
function timer11(ctx) {
  const tests = [];
  const notBuilt = [];
  const found = {};
  const dirs = [ctx.collect, ctx.outDir && path.join(ctx.outDir, 'evidence')].filter(Boolean);
  const read = () => {
    for (const dir of dirs) {
      for (const file of walk(dir).filter((f) => /first-sync-(linux|darwin|windows)\.json$/.test(f))) {
        try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (d.schema === 'folder-sync-first-sync/1' && !found[d.os]) found[d.os] = d; } catch { /* reported below as missing */ }
      }
    }
  };
  read();
  const host = process.platform === 'win32' ? 'windows' : process.platform;
  const wanted = ctx.leg ? [GOOS_OF_LEG[ctx.leg.os]] : ['linux', 'darwin', 'windows'];
  if (!found[host] && ctx.withWeb && wanted.includes(host) && ctx.outDir) {
    const out = path.join(ctx.outDir, 'evidence', `first-sync-${host}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    sh([process.execPath, path.join(REPO, 'scripts', 'first-sync-timer'), '--out', out], { timeout: 15 * 60 * 1000 });
    read();
  }
  const labels = { linux: 'Linux', darwin: 'macOS', windows: 'Windows' };
  for (const name of wanted) {
    const d = found[name];
    const detail = d ? (d.steps || []).map((s) => `${s.name} ${s.seconds.toFixed(1)} s`).join(', ') + (d.why ? ` (${d.why})` : '') : '';
    if (d) tests.push(entry(`first sync on ${labels[name]}/${d.arch} in ${d.limit_seconds} s or less, install to first file (${d.seconds.toFixed(1)} s)`, d.ok && d.seconds <= d.limit_seconds ? 'pass' : 'fail', detail, Math.round(d.seconds * 1000)));
    else notBuilt.push({ name: `first-sync-timer on ${labels[name]}`, reason: ctx.collect ? `no first-sync-${name}.json in ${ctx.collect}: that OS's job has not uploaded one` : 'not run here: scripts/gates --with-web runs it on this machine; the other OSes come from the CI jobs (--collect)' });
  }
  return { tests, notBuilt };
}

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

module.exports = { REPO, SCHEMA, GATE_IDS, LEGS, GOOS_OF_LEG, definitions, readLegs, parseGoJson, parseTap, aggregate, validate, tail, entry, sh, dropIn8, walk };
