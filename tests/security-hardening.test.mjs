import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import {sourceFiles} from './source-files.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = path => readFileSync(join(root, path), 'utf8');

function files(dir = root) {
  return sourceFiles(dir).map(entry=>join(entry.parentPath,entry.name));
}

test('all generated JSON-LD remains valid JSON', () => {
  for (const path of files().filter(path => path.endsWith('.html'))) {
    const html = readFileSync(path, 'utf8');
    for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => JSON.parse(match[1]), `Invalid JSON-LD in ${relative(root, path)}`);
    }
  }
});

test('every indexable HTML document has one clear search and page identity', () => {
  const failures = [];
  for (const path of files().filter(path => path.endsWith('.html'))) {
    const html = readFileSync(path, 'utf8');
    if (/<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i.test(html)) continue;
    const rel = relative(root, path);
    const titles = [...html.matchAll(/<title>([^<]+)<\/title>/gi)];
    const headings = [...html.matchAll(/<h1(?:\s[^>]*)?>([\s\S]*?)<\/h1>/gi)];
    const descriptions = [...html.matchAll(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/gi)];
    const canonicals = [...html.matchAll(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/gi)];
    if (titles.length !== 1 || !titles[0]?.[1]?.trim()) failures.push(`${rel}: title=${titles.length}`);
    if (headings.length !== 1 || !headings[0]?.[1]?.replace(/<[^>]+>/g, '').trim()) failures.push(`${rel}: h1=${headings.length}`);
    if (descriptions.length !== 1) failures.push(`${rel}: descriptions=${descriptions.length}`);
    if (canonicals.length !== 1 || !/^https:\/\/easygaragecleaning\.com\//.test(canonicals[0]?.[1] || '')) failures.push(`${rel}: canonicals=${canonicals.length}`);
    if (!/<html[^>]+lang=["']en["']/i.test(html)) failures.push(`${rel}: language`);
  }
  assert.deepEqual(failures, []);
});

test('structured data no longer advertises the retired photo-quote flow', () => {
  const failures = [];
  for (const file of files().filter(path => path.endsWith('.html'))) {
    const html = readFileSync(file, 'utf8');
    for (const [, json] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      if (/photo quotes?|5[- ]min(?:ute)? quote|flat[- ]rate from (?:your )?photos/i.test(json)) {
        failures.push(relative(root, file));
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('confidential artifacts are removed and source paths are denied at the edge', async () => {
  for (const path of ['sop.html', 'tyler-contract.html', 'contracts/tyler-lead-setter-agreement.html', 'EGC-Lead-System-SOP.pdf']) {
    assert.equal(existsSync(join(root, path)), false, `${path} must not ship`);
  }
  const { onRequest } = await import('../functions/_middleware.js');
  for (const path of ['/_generate_site.py', '/docs/EGC-OPERATIONS-AUDIT.md', '/tests/operations-suite.test.mjs', '/package.json', '/firestore.rules', '/contracts/old.html', '/auth-verifier', '/auth-verifier/src/index.js', '/auth-verifier/wrangler.jsonc']) {
    let continued = false;
    const response = await onRequest({ request: new Request(`https://easygaragecleaning.com${path}`), next: async () => { continued = true; return new Response('leak'); } });
    assert.equal(response.status, 404, path);
    assert.equal(continued, false, path);
  }
});

async function edge(path) {
  const { onRequest } = await import('../functions/_middleware.js');
  let continued = false;
  const response = await onRequest({ request: new Request(`https://easygaragecleaning.com${path}`), env: {}, next: async () => { continued = true; return new Response('public', { headers: { 'Content-Type': 'text/plain' } }); } });
  return { response, continued };
}

test('private source trees, tooling and deploy configs return a noindex 404 at the edge', async () => {
  const blocked = [
    '/egc-platform', '/egc-platform/', '/egc-platform/package.json', '/egc-platform/pnpm-workspace.yaml', '/egc-platform/apps/api/src/server.ts',
    '/functions', '/functions/_middleware.js', '/functions/_lib/firebase-service-account.js', '/functions/api/employee-hub.js',
    '/tools/', '/tools/gallery/publish-links.py', '/tools/gallery/showcase-browser.cjs', '/tools/gallery/simple-import.json',
    '/.github/workflows/egc-firestore-ci.yml', '/.claude/settings.json', '/.claude/worktrees/unit/employee.html',
    '/node_modules/@noble/hashes/package.json', '/node_modules/.pnpm/tslib@2.8.1/node_modules/tslib/tslib.html',
    '/firebase.json', '/firebase.emulator.json', '/firebase.field-day.json', '/pnpm-lock.yaml', '/pnpm-workspace.yaml',
    '/_finalize_urls.py', '/_services_data.py', '/__pycache__/_services_data.cpython-312.pyc', '/blog/generator.py', '/images/any.PY', '/deep/nested/tool.py/',
    '/FUNCTIONS/_lib/hub-session.js', '/.GitHub/workflows/egc-platform-ci.yml', '/Firebase.Emulator.json',
    '/%66unctions/_lib/hub-session.js', '/functions%2F_lib%2Fhub-session.js', '//functions/_lib/hub-session.js', '/%2Ffunctions/_lib/hub-session.js',
    '/images/..%2Ffunctions/_lib/hub-session.js', '/crew/%2e%2e%2Ftools/gallery/simple-import.json', '/images%5C..%5Cegc-platform%5Cpackage.json', '/%E0%A4%A',
  ];
  for (const path of blocked) {
    const { response, continued } = await edge(path);
    assert.equal(response.status, 404, path);
    assert.equal(continued, false, path);
    assert.match(response.headers.get('x-robots-tag') || '', /noindex/, path);
    assert.equal(response.headers.get('cache-control'), 'no-store', path);
    assert.doesNotMatch(await response.text(), /public/, path);
  }
});

test('public pages, crew tools and gallery data still reach the site after the private-path deny list', async () => {
  const allowed = [
    '/', '/crew/hub-auth.js', '/employee-suite.js', '/gallery-showcase.json', '/gallery-simple.json', '/before-after',
    '/gallery-preview-assets/gallery.js', '/crew/', '/crew/postjob.html', '/employee', '/employee-dispatch.js', '/business-hub.js',
    '/.well-known/security.txt', '/api/firebase-session', '/api/dispatch', '/projects/', '/images/logo.png', '/blog/',
    '/toolshed', '/functions-of-a-garage', '/node_modules_guide', '/pricing.pyramid', '/firebase-setup', '/python-garage.html',
  ];
  for (const path of allowed) {
    const { response, continued } = await edge(path);
    assert.equal(continued, true, path);
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), 'public', path);
  }
});

// Same-site paths a file references, resolved against the file's own URL, so relative
// references from nested pages ('../tools/x.json' in /crew/page.html) are checked too.
function siteReferences(text, path) {
  const targets = [];
  for (const match of text.matchAll(/\b(?:href|src|action)=["']([^"']+)["']|url\(\s*["']?([^"')\s]+)|["'`](\/[\w.~%-][^"'`\s]*)["'`]|https:\/\/(?:www\.)?easygaragecleaning\.com(\/[^"'`\s<>)]*)/g)) {
    let url;
    try { url = new URL(match.slice(1).find(Boolean) || '', `https://easygaragecleaning.com${path}`); } catch { continue; }
    if (/^https:\/\/(?:www\.)?easygaragecleaning\.com$/.test(url.origin)) targets.push(url.pathname);
  }
  return targets;
}

test('the reference scan resolves relative, root-relative and absolute same-site URLs', async () => {
  const cases = [
    ['/crew/postjob.html', '<a href="../tools/gallery/simple-import.json">x</a>', ['/tools/gallery/simple-import.json']],
    ['/blog/2026/post.html', '<script src="../../functions/_lib/hub-session.js"></script>', ['/functions/_lib/hub-session.js']],
    ['/crew/index.html', '<img src="./../node_modules/x/a.png?v=1#top" alt="">', ['/node_modules/x/a.png']],
    ['/css/site.css', 'body{background:url(../.github/banner.png)}', ['/.github/banner.png']],
    ['/crew/index.html', '<form action="../_generate_site.py"></form>', ['/_generate_site.py']],
    ['/crew/index.html', '<link href="https://www.easygaragecleaning.com/egc-platform/package.json">', ['/egc-platform/package.json']],
    ['/crew/index.html', "fetch('/firebase.emulator.json')", ['/firebase.emulator.json']],
    ['/crew/index.html', '<a href="hub-auth.js">x</a>', ['/crew/hub-auth.js']],
    ['/crew/index.html', '<a href="mailto:a@example.invalid">m</a><a href="//cdn.example.invalid/tools/x.js">c</a><a href="https://example.invalid/functions/x">e</a><img src="data:image/png;base64,AA" alt="">', []],
  ];
  for (const [path, text, expected] of cases) {
    assert.deepEqual(siteReferences(text, path), expected, text);
    for (const target of expected.filter(target => !target.startsWith('/crew/'))) assert.equal((await edge(target)).continued, false, target);
  }
  assert.equal((await edge('/crew/hub-auth.js')).continued, true);
});

test('no servable page or script references a path the edge now refuses', async () => {
  const failures = [], served = new Map(), scanned = new Set();
  const passes = async path => {
    if (!served.has(path)) served.set(path, (await edge(path)).continued);
    return served.get(path);
  };
  for (const file of files()) {
    const path = '/' + relative(root, file).split(/[\\/]/).join('/');
    if (!/\.(?:html|js|css|json|webmanifest)$/.test(path) || !(await passes(path))) continue;
    scanned.add(path);
    for (const target of siteReferences(readFileSync(file, 'utf8'), path)) {
      if (!(await passes(target))) failures.push(`${path} -> ${target}`);
    }
  }
  for (const page of ['/index.html', '/employee.html', '/crew/index.html', '/before-after.html', '/employee-suite.js']) assert.ok(scanned.has(page), page);
  for (const asset of ['/crew/hub-auth.js', '/employee-suite.js', '/styles.css', '/gallery-simple.js']) assert.equal(served.get(asset), true, asset);
  assert.deepEqual([...new Set(failures)].sort(), []);
});

test('edge middleware adds browser security headers and a real explicit 404', async () => {
  const { onRequest } = await import('../functions/_middleware.js');
  const response = await onRequest({ request: new Request('https://easygaragecleaning.com/'), next: async () => new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } }) });
  assert.match(response.headers.get('content-security-policy') || '', /frame-ancestors/);
  assert.match(response.headers.get('strict-transport-security') || '', /max-age=31536000/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const missing = await onRequest({ request: new Request('https://easygaragecleaning.com/404'), next: async () => new Response(read('404.html')) });
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('x-robots-tag') || '', /noindex/);
});

test('sensitive APIs do not trust arbitrary subdomains as same-origin callers', () => {
  const apiSource=files(join(root,'functions','api')).filter(path=>path.endsWith('.js')).map(path=>readFileSync(path,'utf8')).join('\n');
  assert.doesNotMatch(apiSource,/\(\^\|\\\.\)easygaragecleaning\\\.com/);
  assert.doesNotMatch(apiSource,/\[a-z0-9-\]\+\\\.\)\*easygaragecleaning\\\.com/);
  assert.match(apiSource,/www\\\.easygaragecleaning\\\.com/);
  assert.match(apiSource,/easy-garage-cleaning\\\.pages\\\.dev/);
});

test('Garage Guard scrubs Stripe bearer tokens before analytics initializes', () => {
  const page=read('garage-guard.html');
  const scrub=page.indexOf("sessionStorage.setItem('egc_gg_checkout_session'");
  const loader=page.indexOf('/analytics-loader.js');
  assert.ok(scrub >= 0 && loader > scrub);
  assert.match(page,/<script src="\/analytics-loader\.js[^>]+defer>/);
  assert.match(page,/history\.replaceState\(null,''/);
});

test('Hub audit entries are written only from manager sessions and carry the signed-in username', () => {
  const html = read('employee.html');
  // P1-02: business identity comes only from the server profile (/api/hub-auth sign-in and session restore) and
  // there is no client-side staff list. The Hub's check is a UX guard; the Firestore rules below are the enforcement.
  assert.doesNotMatch(html, /const ADMINS|BUSINESS_USERS/);
  const slice = (start, end) => {
    const from = html.indexOf(start), to = html.indexOf(end, from);
    assert.ok(from >= 0 && to > from, start);
    return html.slice(from, to);
  };
  const source = slice('function canRunBusiness()', 'async function ensureFirebaseSession(') + slice('function addAuditLog(', 'function renderAuditLog(');
  assert.doesNotMatch(source, /BUSINESS_USERS|ADMINS|localStorage|egc_owner|egc_role/);
  const run = (me, businessAccess, call = `addAuditLog('mark_dead', 'Lead: Synthetic Lead');`) => {
    const writes = [];
    const context = vm.createContext({
      me, console,
      sessionStorage: { getItem: key => key === 'egc_business_access' && businessAccess !== undefined ? String(businessAccess) : null },
      db: { collection: name => ({ add: entry => { writes.push({ name, entry }); return Promise.resolve(); } }) },
      firebase: { firestore: { FieldValue: { serverTimestamp: () => ({ sentinel: 'serverTimestamp' }) } } },
      Date: class { toISOString() { return '2026-09-22T12:00:00.000Z'; } },
    });
    vm.runInContext(`${source}\n${call}`, context);
    return JSON.parse(JSON.stringify(writes));
  };
  const serverAt = { sentinel: 'serverTimestamp' };
  assert.deepEqual(run('ZacB', true), [{ name: 'audit_log', entry: { action: 'mark_dead', detail: 'Lead: Synthetic Lead', by: 'ZacB', at: '2026-09-22T12:00:00.000Z', serverAt } }]);
  // No write unless the server profile granted business access ('true' exactly) and a user is signed in.
  for (const businessAccess of [false, 'false', 'TRUE', '1', 'yes', '', undefined]) {
    assert.deepEqual(run('ZacB', businessAccess), [], String(businessAccess));
    assert.deepEqual(run('crew.one', businessAccess), [], String(businessAccess));
  }
  for (const signedOut of [null, undefined, '']) assert.deepEqual(run(signedOut, true), [], String(signedOut));
  // 'by' is always the signed-in username, never a label or a hard-coded manager. Whether that username may
  // write at all is decided by the rules from the Hub-minted token, not by the browser (see below).
  for (const user of ['TylerG', 'alexk', 'crew.one']) assert.deepEqual(run(user, true).map(write => write.entry.by), [user]);
  // Oversized values are clipped to the rules' 200/2000 UTF-16-unit bounds (Rules string.size()) instead of
  // being rejected, and a clip never splits a surrogate pair.
  const [clipped] = run('ZacB', true, `addAuditLog('a'.repeat(250), 'Lead: x' + '\\u{1F697}'.repeat(2100));`);
  assert.equal(clipped.entry.action, 'a'.repeat(200));
  assert.equal(clipped.entry.detail, 'Lead: x' + '\u{1F697}'.repeat(996));
  assert.equal(clipped.entry.detail.length, 1999);
  assert.equal(run('ZacB', true, `addAuditLog('\\u{1F697}'.repeat(101), 'x'.repeat(2000));`)[0].entry.action, '\u{1F697}'.repeat(100));
  assert.deepEqual(run('ZacB', true, `addAuditLog('login');`)[0].entry, { action: 'login', detail: '', by: 'ZacB', at: '2026-09-22T12:00:00.000Z', serverAt });

  // The crew-refusal guarantee lives in firestore.rules, keyed to claims the server mints from the Hub session:
  // business_access = hasBusinessAccess(session) and username = session.user. A crew account that tampers with
  // sessionStorage or 'me' still holds a non-business token, so its create is denied; a manager cannot forge 'by'.
  // tests/firestore-emulator.test.mjs proves both against the real rules with the real addAuditLog source.
  const rules = read('firestore.rules');
  const block = name => rules.match(new RegExp(`function ${name}\\(\\) \\{([\\s\\S]*?)\\n    \\}`))?.[1] || '';
  assert.match(block('businessUser'), /request\.auth\.token\.business_access == true/);
  assert.match(block('auditEntryIsSafe'), /entry\.by == request\.auth\.token\.username &&/);
  const audit = rules.match(/match \/audit_log\/\{documentId\} \{([\s\S]*?)\n    \}/)?.[1] || '';
  assert.match(audit, /allow read: if businessUser\(\);/);
  assert.match(audit, /allow create: if businessUser\(\) && auditEntryIsSafe\(\);/);
  assert.match(audit, /allow update, delete: if false;/);
  assert.equal([...audit.matchAll(/allow /g)].length, 3);
  const minted = read('functions/api/firebase-session.js');
  assert.match(minted, /const businessAccess = hasBusinessAccess\(session\);/);
  assert.match(minted, /business_access: businessAccess,/);
  assert.match(minted, /username: String\(session\.user \|\| ''\)\.slice\(0, 80\),/);
  const emulator = read('tests/firestore-emulator.test.mjs');
  assert.match(emulator, /the audit trail is append-only and attributed to the signed-in manager/);
  assert.match(emulator, /a crew session that tampers with its client business flag is still refused by the rules/);
});

test('Firestore requires a Hub-minted Firebase session and server calls use service authentication', () => {
  for (const path of ['employee.html', 'copilot.html', 'crew/index.html', 'crew/gameplan.html', 'crew/prejob.html', 'crew/postjob.html']) {
    const html = read(path);
    assert.match(html, /firebase-auth-compat\.js/, path);
  }
  assert.match(read('employee.html'), /\/api\/firebase-session/);
  assert.match(read('crew/hub-auth.js'), /signInWithCustomToken/);
  assert.match(read('functions/api/firebase-session.js'), /hasBusinessAccess\(session\)/);
  assert.doesNotMatch(read('functions/api/firebase-session.js'), /\['zacb', 'tylerg', 'alexk'\]/);
  assert.doesNotMatch(read('functions/_lib/firestore-job.js'), /\?key=/);
  assert.doesNotMatch(read('functions/_lib/employee-accounts.js'), /\?key=/);
  assert.doesNotMatch(read('functions/api/employee-hub.js'), /\?key=/);
  assert.match(read('firestore.rules'), /request\.auth != null/);
  assert.doesNotMatch(read('firestore.rules'), /match \/jobs\/\{documentId\}[\s\S]*?allow read, write: if signedIn\(\)/);
  assert.match(read('firestore.rules'), /assignedToUser\(resource\.data\)/);
  assert.match(read('crew/index.html'), /\/api\/crew-jobs/);
  assert.match(read('employee.html'), /if \(!canRunBusiness\(\)\) \{\s*void refreshCrewSchedule\(\)/);
  assert.match(read('employee.html'), /function refreshCrewSchedule\(\)[\s\S]*?\/api\/crew-jobs/);
  assert.match(read('firestore.rules'), /match \/\{document=\*\*\}[\s\S]*allow read, write: if false/);
  assert.doesNotMatch(read('functions/_lib/hub-session.js'), /[a-f0-9]{64}/i);
  assert.doesNotMatch(read('functions/_lib/hub-session.js'), /HIGHLEVEL_API_KEY|GHL_API_KEY/);
});

test('model output is escaped before the field copilot renders its limited markup', () => {
  const copilot = read('copilot.html');
  assert.match(copilot, /const withPills = esc\(trimmed\)/);
  assert.match(copilot, /const safeScript = esc\(script\)/);
  assert.doesNotMatch(copilot, /const withPills = trimmed\s*\.replace/);
});

test('privileged actions honor signed session claims instead of a lookalike username', async () => {
  const env = { HUB_SESSION_SECRET: 'lookalike-test', FIREBASE_API_KEY: 'firebase-test-lookalike' };
  const cookie = (await createHubSessionCookie(env, 'ZacB', {
    user: 'ZacB', displayName: 'Not the owner', role: 'crew', businessAccess: false, source: 'employee-account',
  })).split(';')[0];
  const headers = { Cookie: cookie, Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' };

  const relay = await import('../functions/api/operations-event.js');
  const relayResponse = await relay.onRequestPost({
    request: new Request('https://easygaragecleaning.com/api/operations-event', { method: 'POST', headers, body: JSON.stringify({ event: 'booking', payload: {} }) }),
    env,
  });
  assert.equal(relayResponse.status, 401);

  const accounts = await import('../functions/api/employee-accounts.js');
  const reviewResponse = await accounts.onRequestPost({
    request: new Request('https://easygaragecleaning.com/api/employee-accounts', { method: 'POST', headers, body: JSON.stringify({ action: 'review', username: 'someone', decision: 'approved' }) }),
    env,
  });
  assert.equal(reviewResponse.status, 401);
});

test('crew schedule API excludes unassigned customer jobs and redacts open shifts', async () => {
  const route = await import('../functions/api/crew-jobs.js');
  const env = { HUB_SESSION_SECRET: 'crew-jobs-test', FIREBASE_API_KEY: 'firebase-test-crew-jobs', HUB_AUTH_USERS_JSON: JSON.stringify({ Crewtest: { passwordHash: 'test', displayName: 'Crew Test', role: 'crew' } }) };
  const cookie = (await createHubSessionCookie(env, 'Crewtest', { displayName: 'Crew Test' })).split(';')[0];
  // The schedule is read as the complete paginated jobs collection (not a
  // truncated runQuery), so the fake Firestore serves a collection list page.
  const document = (id, data) => ({
    name: `projects/x/databases/(default)/documents/jobs/${id}`,
    fields: encodeFirestoreFields(data), updateTime: '2026-09-22T12:00:00.000000Z',
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ documents: [
    document('mine', { type: 'job', assignedCrew: ['Crewtest'], customer: 'Assigned Customer', address: '1 Assigned Way' }),
    document('private', { type: 'job', assignedCrew: ['SomeoneElse'], customer: 'Private Customer', address: '2 Private Way' }),
    document('open', { type: 'job', openShift: true, shiftPickupEnabled: true, customer: 'Open Customer', address: '3 Private Way', serviceType: 'Garage cleanout', crewNeeded: 'not-a-number' }),
  ] }), { status: 200 });
  try {
    const response = await route.onRequestGet({ request: new Request('https://easygaragecleaning.com/api/crew-jobs', { headers: { Cookie: cookie } }), env });
    assert.equal(response.status, 200);
    const jobs = (await response.json()).jobs;
    assert.equal(jobs.find(job => job.id === 'mine').customer, 'Assigned Customer');
    assert.equal(jobs.some(job => job.id === 'private'), false);
    assert.equal(jobs.find(job => job.id === 'open').customer, 'Open shift');
    assert.equal(jobs.find(job => job.id === 'open').address, '');
    assert.deepEqual(jobs.find(job => job.id === 'open').assignedCrew, []);
    assert.equal(jobs.find(job => job.id === 'open').assignedTo, '');
    assert.equal(jobs.find(job => job.id === 'open').crewNeeded, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('open shifts cannot be read directly and are claimed with an authenticated atomic server write', async () => {
  const rules = read('firestore.rules');
  assert.doesNotMatch(rules, /allow read:[^;]*openShift/);
  assert.doesNotMatch(rules, /openShiftAssignmentOnly/);

  const route = await import('../functions/api/crew-jobs.js');
  const env = { HUB_SESSION_SECRET: 'crew-claim-test', FIREBASE_API_KEY: 'firebase-test-crew-claim', HUB_AUTH_USERS_JSON: JSON.stringify({ Crewtest: { passwordHash: 'test', displayName: 'Crew Test', role: 'crew' } }) };
  const cookie = (await createHubSessionCookie(env, 'Crewtest', { displayName: 'Crew Test' })).split(';')[0];
  const originalFetch = globalThis.fetch;
  const calls = [];
  let revision=0;
  const root='projects/egcw-1ec83/databases/(default)/documents/';
  const documents=new Map([['jobs/open-job',{name:root+'jobs/open-job',updateTime:'initial',fields:encodeFirestoreFields({type:'job',status:'scheduled',date:'2099-09-08',time:'10:00',endTime:'11:00',openShift:true,shiftPickupEnabled:true,assignedCrew:[],crewNeeded:2,estimate:{total:1000},opsNotes:'Private manager note'})}]]);
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes(':runQuery')) return new Response('[]', { status: 200 });
    if (String(url).includes(':commit')) {
      const writes=JSON.parse(options.body).writes;
      for(const write of writes){const existing=documents.get(write.update.name.slice(root.length));if(write.currentDocument?.exists===false&&existing||write.currentDocument?.updateTime&&write.currentDocument.updateTime!==existing?.updateTime)return Response.json({}, {status:412});}
      for(const write of writes){const key=write.update.name.slice(root.length),existing=documents.get(key);documents.set(key,{name:write.update.name,fields:{...existing?.fields,...write.update.fields},updateTime:'revision-'+(++revision)});}
      return Response.json({writeResults:[]});
    }
    const path=new URL(url).pathname.split('/documents/')[1];
    if (!path.includes('/')) return Response.json({documents:[...documents.entries()].filter(([key])=>key.startsWith(path+'/')).map(([,value])=>value)});
    return documents.has(path)?Response.json(documents.get(path)):Response.json({}, {status:404});
  };
  try {
    const request = new Request('https://easygaragecleaning.com/api/crew-jobs', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'claim', jobId: 'open-job',requestId:crypto.randomUUID() }),
    });
    const response = await route.onRequestPost({ request, env });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.job.assignedCrew, ['crewtest']);
    assert.equal(result.job.estimate,undefined);assert.equal(result.job.opsNotes,undefined);
    const commit = calls.find(call => call.url.includes(':commit'));
    assert.ok(commit);
    const writes=JSON.parse(commit.options.body).writes;
    assert.equal(writes.find(write=>write.update.name.endsWith('/jobs/open-job')).currentDocument.updateTime,'initial');
    assert.ok(writes.some(write=>write.update.name.endsWith('/dispatchState/revision')));
    assert.ok(writes.some(write=>write.update.name.includes('/dispatchOperations/')));
    assert.ok(!calls.some(call=>call.options.method==='PATCH'));
    assert.match(read('employee-suite.js'), /window\.opsClaimShift=id=>changeShift\(id,'claim'\)/);
  } finally { globalThis.fetch = originalFetch; }
});

test('crew job rules limit assigned staff to operational fields', () => {
  const rules = read('firestore.rules');
  assert.match(rules, /affectedKeys\(\)\.hasOnly\(\[/);
  assert.match(rules, /'preJobProgress'/);
  assert.match(rules, /'postJobChecklist'/);
  const assignedRule = rules.match(/function assignedUpdateIsSafe\(\) \{([\s\S]*?)\n    \}/)?.[1] || '';
  assert.doesNotMatch(assignedRule, /'customer'|'address'|'priceQuoted'|'total'/);
  assert.match(rules, /ownAvailabilityCreateIsSafe/);
  assert.match(rules, /assignedCustomerCloseoutIsSafe/);
  assert.match(rules, /assignedCustomerPaymentSummaryIsSafe/);
  assert.match(rules, /assignedPaymentUpdateIsSafe/);
  assert.match(rules, /assignedInvoiceUpdateIsSafe/);
  assert.match(rules, /assignedStageUpdateIsSafe/);
  assert.match(rules, /request\.resource\.data\.payment == resource\.data\.payment/);
  assert.match(rules, /preservesVerifiedPaid/);
  assert.match(rules, /resource\.data\.payment\.verified == true/);
  assert.match(rules, /lastPaymentStatus == 'paid'[\s\S]*?job\.payment\.verified == true/);
  assert.match(read('functions/api/job-payment.js'), /recordStripePayment/);
  assert.match(read('functions/api/job-payment.js'), /Payment exceeds the current job balance/);
  assert.doesNotMatch(read('crew/postjob.html'), /verificationSource:'crew_attestation'|verifiedPaidInFull/);
  assert.match(read('crew/postjob.html'), /Completing job work never records a payment/);
  assert.match(read('crew/postjob.html'), /result\.jobId!==ACTIVE\.jobId/);
  assert.match(read('functions/api/quo-send.js'), /readJob\(env, jobId\)/);
  assert.match(read('functions/api/quo-send.js'), /await assignedToJob\(job, session, env\)/);
  assert.match(read('crew/prejob.html'), /job_id:ACTIVE\.jobId/);
});

test('public conversion and machine-readable content match the walkthrough flow', () => {
  const publicText = files().filter(path => path.endsWith('.html')).map(path => readFileSync(path, 'utf8')).join('\n');
  assert.doesNotMatch(publicText, /normalized to E\.164 for Zapier\/Firestore|Google reviews widget goes here|Review slot \d|Add team \/ truck photo|owner to add VIDEO_ID/i);
  assert.doesNotMatch(publicText, /746 Star Grass/i);
  assert.match(read('book.html'), /Please choose a preferred walkthrough window/);
  assert.doesNotMatch(read('book.html'), /name="Preferred timing"/);
  assert.match(read('reviews.html'), /Verified feedback, <em>at the source<\/em>/);
  assert.match(read('404.html'), /name="robots" content="noindex, nofollow"/);
  const llms = read('llms.txt');
  assert.doesNotMatch(llms, /\/(?:employee|crew|copilot|customer-portal|contracts|sop|tyler-contract)(?:\/|\b)/i);
  assert.doesNotMatch(read('ai.txt'), /flat_rate_photo_quote/i);
});

test('site-wide generation remains idempotent and lightweight', () => {
  for (const path of files().filter(path => path.endsWith('.html'))) {
    const html = readFileSync(path, 'utf8');
    const copies = html.match(/\.mobile-quote-sheet\{/g)?.length || 0;
    assert.ok(copies <= 1, `${relative(root, path)} contains ${copies} copies of the mobile-sheet CSS`);
  }
  assert.equal(existsSync(join(root, 'llms-full.txt')), false, 'stale llms-full.txt should remain retired');
  assert.match(read('_redirects'), /\/llms-full\.txt\s+\/llms\.txt\s+301/);
});

test('standalone lead forms expose programmatic field names', () => {
  for (const path of ['estate-cleanout-fort-collins.html', 'fort-collins-junk-removal.html']) {
    const html = read(path);
    for (const name of ['name', 'phone']) {
      const input = html.match(new RegExp(`<input[^>]+name="${name}"[^>]*>`, 'i'))?.[0] || '';
      assert.ok(input, `${path} is missing ${name}`);
      const inputIndex = html.indexOf(input);
      const prefix = html.slice(Math.max(0, inputIndex - 120), inputIndex);
      assert.match(prefix, /<label(?:\s|>)[\s\S]*$/i, `${path} ${name} is not associated with a label`);
    }
  }
});

test('public copy excludes retired seeded stories, placeholders, and unsupported response-time claims', () => {
  const publicText = files()
    .filter(path => path.endsWith('.html') || path.endsWith('.xml') || path.endsWith('.txt'))
    .filter(path => !relative(root, path).split(/[\\/]/).some(part => ['crew', 'contracts', 'functions', 'tests'].includes(part)))
    .map(path => readFileSync(path, 'utf8'))
    .join('\n');
  assert.doesNotMatch(publicText, /response within 5 minutes|respond in 5 minutes|reply within 5 minutes|5[- ]min(?:ute)? response|locked flat-rate quote in about 5 minutes/i);
  assert.doesNotMatch(publicText, /YOUR_CODE|TODO\(GADS\)|Before\/after placeholder|placeholder until owner uploads/i);
  assert.doesNotMatch(publicText, /projects\/(?:fort-collins-garage-cleanout-old-town|loveland-storage-unit-cleanout|windsor-garage-junk-removal)/i);
  for (const path of [
    'projects/fort-collins-garage-cleanout-old-town.html',
    'projects/loveland-storage-unit-cleanout.html',
    'projects/windsor-garage-junk-removal.html',
  ]) assert.equal(existsSync(join(root, path)), false, path);
});

test('internal links on public pages resolve to a page, asset, API route, or redirect', () => {
  const redirectSources = new Set(read('_redirects').split(/\r?\n/)
    .map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    .map(line => line.split(/\s+/)[0]));
  const failures = [];
  const excluded = new Set(['employee.html', 'employee-signup.html', 'copilot.html', 'customer-portal.html']);
  const publicFiles = files().filter(path => {
    if (!path.endsWith('.html')) return false;
    const rel = relative(root, path);
    return !excluded.has(rel) && !rel.split(/[\\/]/).some(part => ['crew', 'contracts'].includes(part));
  });
  for (const path of publicFiles) {
    const html = readFileSync(path, 'utf8');
    for (const match of html.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)) {
      const raw = match[1];
      if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/api/')) continue;
      const pathname = raw.split(/[?#]/)[0] || '/';
      if (redirectSources.has(pathname)) continue;
      let local;
      try { local = decodeURIComponent(pathname).replace(/^\//, ''); }
      catch { failures.push(`${relative(root, path)} -> ${pathname}`); continue; }
      const candidates = local ? [local, `${local}.html`, join(local, 'index.html')] : ['index.html'];
      if (!candidates.some(candidate => existsSync(join(root, candidate)))) failures.push(`${relative(root, path)} -> ${pathname}`);
    }
  }
  assert.deepEqual([...new Set(failures)].sort(), []);
});

test('sitemap includes every live indexable standalone service page', () => {
  const sitemap = read('sitemap.xml');
  for (const slug of ['estate-cleanout-fort-collins', 'flat-rate-junk-removal-fort-collins-co', 'garage-cleanouts-laporte-co', 'garage-cleanouts-severance-co', 'garage-guard', 'garage-turnaround-fort-collins-co']) {
    assert.match(sitemap, new RegExp(`https://easygaragecleaning\\.com/${slug}<`), slug);
  }
  assert.doesNotMatch(sitemap, /projects\/(?:fort-collins-garage-cleanout-old-town|loveland-storage-unit-cleanout|windsor-garage-junk-removal)/);
});
