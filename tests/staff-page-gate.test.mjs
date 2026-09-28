import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from './helpers/vm-realm.mjs';
import { onRequest } from '../functions/_middleware.js';
import { createHubSessionCookie, createHubSessionToken } from '../functions/_lib/hub-session.js';
import { privateStaffResponse, staffPageGate, staffPageGateEnabled, staffSignInLocation } from '../functions/_lib/staff-page-gate.js';
import { STAFF_GATED_PATHS, STAFF_PUBLIC_PATHS, safeStaffNext, staffGatedPath } from '../staff-paths.js';
import { sourceFiles } from './source-files.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = path => readFileSync(join(root, path), 'utf8');
const NOW = Date.parse('2026-09-28T16:00:00.000Z');
const HOURS_12 = 12 * 60 * 60 * 1000;
const ORIGIN = 'https://easygaragecleaning.com';
const USERS = {
  'synthetic.crew': { passwordHash: 'a'.repeat(64), displayName: 'Synthetic Crew', role: 'crew' },
  tylerg: { passwordHash: 'b'.repeat(64), displayName: 'Synthetic Manager', role: 'manager' },
};
const BASE_ENV = { HUB_SESSION_SECRET: 'synthetic-staff-gate-secret-0123456789abcdef', HUB_AUTH_USERS_JSON: JSON.stringify(USERS) };
const ON = { ...BASE_ENV, EGC_STAFF_PAGE_GATE: 'on' };
const HTML = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
const NAVIGATE = { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
const ASSET = { Accept: '*/*', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' };
// Some existing callers pass no env at all (tests/copilot-login.test.mjs); NO_ENV reproduces that context shape.
const NO_ENV = Symbol('no env');

async function edge(path, { env = ON, headers = {}, method = 'GET', upstream } = {}) {
  let continued = 0;
  const context = { request: new Request(ORIGIN + path, { method, headers }), next: async () => { continued += 1; return upstream ? upstream() : new Response('static body', { headers: { 'Content-Type': 'text/javascript', Vary: 'Accept-Encoding' } }); } };
  if (env !== NO_ENV) context.env = env;
  const response = await onRequest(context);
  return { response, continued, body: await response.text() };
}

async function snapshot(result) {
  return { status: result.response.status, headers: [...result.response.headers].sort(([a], [b]) => a.localeCompare(b)), body: result.body, continued: result.continued };
}

const posix = (base, entry) => '/' + relative(base, join(entry.parentPath, entry.name)).split(sep).join('/');
// The URLs Cloudflare Pages serves a file at: the file itself plus its extensionless or directory form.
function servedAt(file) {
  if (file.endsWith('/index.html')) return [file, file.slice(0, -'index.html'.length)];
  return file.endsWith('.html') ? [file, file.slice(0, -'.html'.length)] : [file];
}
// Every file in the families staff pages come from: the crew app folder and the root employee/dispatch/copilot/template files.
function staffScope(base) {
  return sourceFiles(base).map(entry => posix(base, entry)).filter(file => file.startsWith('/crew/') || /^\/(?:employee|dispatch|copilot|message-templates)[^/]*$/.test(file));
}
const PUBLIC = new Set(STAFF_PUBLIC_PATHS);
function unlisted(base) {
  const problems = [];
  for (const file of staffScope(base)) for (const url of servedAt(file)) {
    const gated = staffGatedPath(url), open = PUBLIC.has(url);
    if (gated === open) problems.push(`${url} is ${gated ? 'both gated and listed as public' : 'neither gated nor listed as public'}`);
  }
  return problems.sort();
}

const GATED_URLS = [...new Set([
  ...staffScope(root).flatMap(servedAt).filter(staffGatedPath),
  '/employee/', '/crew/job-photo-sharing.js', '/crew/job-photo-sharing.css',
])].sort();
const SPEC_GATED = ['/employee', '/employee.html', '/employee/', '/employee-suite.js', '/employee-suite.css', '/employee-dispatch.js', '/employee-operations.css',
  '/dispatch', '/dispatch.html', '/message-templates', '/message-templates.html', '/message-templates.js', '/message-templates.css', '/copilot', '/copilot.html',
  '/crew/gameplan', '/crew/gameplan.html', '/crew/prejob', '/crew/prejob.html', '/crew/postjob', '/crew/postjob.html', '/crew/job', '/crew/job.html', '/crew/job.js', '/crew/job.css',
  '/crew/gameplan-handoff.js', '/crew/field-expenses.js', '/crew/field-expenses.css', '/crew/job-photo-sharing.js'];
// The crew service worker installs and updates signed out, so it, the outbox it imports and the offline page stay public.
const SPEC_PUBLIC = ['/crew/', '/crew', '/crew/index.html', '/crew/hub-auth.js', '/crew/crew-brand.css', '/crew/manifest.webmanifest', '/crew/sw.js', '/crew/field-outbox.js', '/crew/offline', '/crew/offline.html', '/crew/sw-config.json',
  '/hub-login-setup', '/hub-login-setup.html', '/hub-login-setup.js', '/staff-login', '/staff-login.html', '/staff-login.js', '/staff-paths.js', '/employee-signup', '/employee-signup.html',
  '/api/hub-auth', '/api/employee-hub', '/api/dispatch', '/api/crew-jobs', '/api/firebase-session', '/business-hub', '/business-hub.html', '/business-hub.js', '/business-hub.css',
  '/', '/index.html', '/about', '/book', '/pricing', '/client-login', '/customer-portal', '/employees', '/employee-handbook-public', '/crew-leader', '/crewjob'];

function expectedLocation(path) {
  const url = new URL(ORIGIN + path);
  const next = safeStaffNext(url.pathname + url.search) || safeStaffNext(url.pathname);
  const page = /^\/crew\//i.test(url.pathname) ? '/crew/' : '/staff-login';
  return next ? `${page}?next=${encodeURIComponent(next)}` : page;
}

function assertPrivate(response, label) {
  assert.equal(response.headers.get('cache-control'), 'private, no-store', label);
  assert.ok(response.headers.get('vary').split(',').map(name => name.trim()).includes('Cookie'), label);
  assert.match(response.headers.get('x-robots-tag'), /noindex/, label);
}

test('the list covers the paths the audit found and never the public sign-in, API, business or marketing surfaces', () => {
  for (const path of SPEC_GATED) assert.equal(staffGatedPath(path), true, `${path} must be gated`);
  for (const path of SPEC_PUBLIC) assert.equal(staffGatedPath(path), false, `${path} must stay public`);
  for (const path of STAFF_PUBLIC_PATHS) assert.equal(staffGatedPath(path), false, `${path} is listed as public`);
  assert.ok(Object.isFrozen(STAFF_GATED_PATHS) && Object.isFrozen(STAFF_PUBLIC_PATHS));
  assert.ok(GATED_URLS.length >= 30, `found ${GATED_URLS.length} gated URLs`);
});

test('every employee-*, dispatch, copilot, template and crew file in the tree is either gated or explicitly public', () => {
  assert.deepEqual(unlisted(root), []);
  const scope = staffScope(root);
  for (const file of ['/employee.html', '/employee-suite.js', '/employee-signup.html', '/crew/gameplan.html', '/crew/index.html', '/crew/hub-auth.js', '/dispatch.html', '/message-templates.js']) assert.ok(scope.includes(file), file);
});

test('a new staff page or script that is neither gated nor allowlisted fails the completeness check', t => {
  const temp = mkdtempSync(join(tmpdir(), 'egc-staff-gate-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  for (const file of ['crew/index.html', 'crew/hub-auth.js', 'crew/new-tool.html', 'crew/new-tool.js', 'crew/job-photo-sharing.js', 'employee-reports.html', 'employee-reports.js', 'employee-signup.html', 'dispatch-board.js', 'about.html']) {
    mkdirSync(dirname(join(temp, file)), { recursive: true });
    writeFileSync(join(temp, file), '<p>Synthetic</p>');
  }
  assert.deepEqual(unlisted(temp), [
    '/crew/new-tool is neither gated nor listed as public', '/crew/new-tool.html is neither gated nor listed as public', '/crew/new-tool.js is neither gated nor listed as public',
    '/dispatch-board.js is neither gated nor listed as public', '/employee-reports is neither gated nor listed as public', '/employee-reports.html is neither gated nor listed as public',
  ]);
});

test('flag on: every gated path without a session is refused before the static file, as a redirect for pages and a 401 otherwise', async () => {
  for (const path of GATED_URLS) {
    for (const [label, headers, method] of [['html', HTML, 'GET'], ['navigate', NAVIGATE, 'GET'], ['head', HTML, 'HEAD']]) {
      const { response, continued, body } = await edge(path, { headers, method });
      assert.equal(response.status, 302, `${label} ${path}`);
      assert.equal(response.headers.get('location'), expectedLocation(path), `${label} ${path}`);
      assert.equal(continued, 0, `${label} ${path}`);
      assert.equal(body, '');
      assertPrivate(response, `${label} ${path}`);
    }
    for (const [label, headers, method] of [['asset', ASSET, 'GET'], ['no headers', {}, 'GET'], ['post', HTML, 'POST']]) {
      const { response, continued, body } = await edge(path, { headers, method });
      assert.equal(response.status, 401, `${label} ${path}`);
      assert.equal(continued, 0, `${label} ${path}`);
      assert.equal(body, 'Sign in required.\n');
      assert.equal(response.headers.get('location'), null);
      assert.match(response.headers.get('content-type'), /^text\/plain/);
      assertPrivate(response, `${label} ${path}`);
      assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/, 'refusals still carry the edge security headers');
    }
  }
  assert.equal((await edge('/employee', { headers: HTML })).response.headers.get('location'), '/staff-login?next=%2Femployee');
  assert.equal((await edge('/dispatch.html', { headers: NAVIGATE })).response.headers.get('location'), '/staff-login?next=%2Fdispatch.html');
  assert.equal((await edge('/crew/gameplan', { headers: HTML })).response.headers.get('location'), '/crew/?next=%2Fcrew%2Fgameplan');
  assert.equal((await edge('/crew/prejob?jobId=synthetic_job-1', { headers: HTML })).response.headers.get('location'), '/crew/?next=%2Fcrew%2Fprejob%3FjobId%3Dsynthetic_job-1');
  assert.equal((await edge('/employee?view=my_day', { headers: HTML })).response.headers.get('location'), '/staff-login?next=%2Femployee%3Fview%3Dmy_day');
});

test('flag on: encoded, doubled, dot-segment and differently cased staff paths are refused too', async () => {
  for (const path of ['/EMPLOYEE-SUITE.JS', '/Employee', '/employee%2Dsuite.js', '/%65mployee.html', '/employee.html/', '/employee-suite.js/', '/crew/%67ameplan.html', '//crew/gameplan.html',
    '/crew//prejob.html', '/Crew/GamePlan', '/crew/gameplan/', '/crew/%2e%2e/employee.html', '/crew/x%2F..%2Fpostjob.html', '/images/..%2Femployee-suite.js', '/crew%5Cjob.js', '/copilot.html?x=1']) {
    for (const headers of [HTML, ASSET]) {
      const { response, continued } = await edge(path, { headers });
      assert.equal(continued, 0, path);
      assert.equal(response.status, headers === HTML ? 302 : 401, path);
      assertPrivate(response, path);
      if (headers === HTML) assert.match(response.headers.get('location'), /^\/(?:staff-login|crew\/)(?:\?next=%2F[^/]*)?$/, path);
    }
  }
  assert.equal((await edge('/crew/%67ameplan.html', { headers: HTML })).response.headers.get('location'), '/crew/', 'an encoded path is never echoed into next');
  assert.equal((await edge('/Employee', { headers: HTML })).response.headers.get('location'), '/staff-login', 'next is exact-case only');
});

test('flag on: a valid Hub session reaches the file, and the response stays private per viewer', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const crew = (await createHubSessionCookie(ON, 'synthetic.crew')).split(';')[0];
  const manager = (await createHubSessionCookie(ON, 'tylerg')).split(';')[0];
  for (const path of GATED_URLS) {
    for (const [cookie, headers] of [[crew, HTML], [crew, ASSET], [manager, NAVIGATE]]) {
      const { response, continued, body } = await edge(path, { headers: { ...headers, Cookie: `theme=dark; ${cookie}` } });
      assert.equal(continued, 1, path);
      assert.equal(response.status, 200, path);
      assert.equal(body, 'static body', path);
      assert.equal(response.headers.get('cache-control'), 'private, no-store', path);
      assert.equal(response.headers.get('vary'), 'Accept-Encoding, Cookie', path);
      assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow', path);
    }
  }
  const varied = await edge('/employee', { headers: { ...HTML, Cookie: crew }, upstream: () => new Response('page', { headers: { 'Content-Type': 'text/html', Vary: 'cookie', 'Cache-Control': 'public, max-age=600' } }) });
  assert.equal(varied.response.headers.get('vary'), 'cookie');
  assert.equal(varied.response.headers.get('cache-control'), 'private, no-store');
  t.mock.timers.tick(HOURS_12 - 1);
  assert.equal((await edge('/employee-suite.js', { headers: { ...ASSET, Cookie: crew } })).continued, 1, 'still valid one millisecond before expiry');
});

test('flag on: expired, tampered, wrong-secret, unknown-user and malformed sessions are refused', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const cookie = (await createHubSessionCookie(ON, 'synthetic.crew')).split(';')[0];
  const [name, token] = cookie.split('=');
  const [payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const forged = Buffer.from(JSON.stringify({ ...claims, u: 'tylerg' })).toString('base64url');
  const longer = Buffer.from(JSON.stringify({ ...claims, exp: claims.exp + HOURS_12 * 30 })).toString('base64url');
  const flipped = signature.slice(0, -1) + (signature.at(-1) === 'A' ? 'B' : 'A');
  const otherSecret = (await createHubSessionCookie({ ...ON, HUB_SESSION_SECRET: 'synthetic-other-secret-0123456789abcdef' }, 'synthetic.crew')).split(';')[0];
  const refused = [
    ['tampered user', `${name}=${forged}.${signature}`], ['extended expiry', `${name}=${longer}.${signature}`], ['flipped signature', `${name}=${payload}.${flipped}`],
    ['wrong secret', otherSecret], ['no signature', `${name}=${payload}`], ['extra segment', `${cookie}.x`], ['garbage', `${name}=not-a-session`], ['empty', `${name}=`],
    ['other cookie name', `egc_hub_session_old=${token}`], ['customer cookie', `egc_customer_portal=${token}`],
  ];
  for (const [label, value] of refused) {
    for (const headers of [HTML, ASSET]) {
      const { response, continued } = await edge('/crew/gameplan.html', { headers: { ...headers, Cookie: value } });
      assert.equal(continued, 0, label);
      assert.equal(response.status, headers === HTML ? 302 : 401, label);
    }
  }
  const removed = { ...ON, HUB_AUTH_USERS_JSON: JSON.stringify({ tylerg: USERS.tylerg }) };
  assert.equal((await edge('/employee-suite.js', { env: removed, headers: { ...ASSET, Cookie: cookie } })).response.status, 401, 'a removed account loses access at once');
  assert.equal((await edge('/employee-suite.js', { env: { EGC_STAFF_PAGE_GATE: 'on' }, headers: { ...ASSET, Cookie: cookie } })).response.status, 401, 'no session secret fails closed');
  t.mock.timers.tick(HOURS_12);
  const expired = await edge('/employee', { headers: { ...HTML, Cookie: cookie } });
  assert.equal(expired.continued, 0);
  assert.equal(expired.response.headers.get('location'), '/staff-login?next=%2Femployee');
});

test('flag on: an employee-account session is re-checked against storage and refused when that check fails', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const env = { ...ON, FIREBASE_API_KEY: 'firebase-test-staff-gate', EMPLOYEE_HUB_DATA_SECRET: 'synthetic-employee-vault-secret-0123456789' };
  const token = await createHubSessionToken(env, 'synthetic.worker', Date.now(), { source: 'employee-account', user: 'synthetic.worker', displayName: 'Synthetic Worker', sessionVersion: 'synthetic-version', payType: 'hourly', hourlyRate: 0 });
  let calls = 0, status = 503;
  t.mock.method(globalThis, 'fetch', async input => {
    calls += 1;
    assert.equal(new URL(input instanceof Request ? input.url : input).hostname, 'firestore.googleapis.com');
    return new Response(JSON.stringify({ error: { status: 'UNAVAILABLE' } }), { status, headers: { 'Content-Type': 'application/json' } });
  });
  for (const outcome of [503, 404]) {
    status = outcome;
    const before = calls;
    const { response, continued } = await edge('/employee', { env, headers: { ...HTML, Cookie: `egc_hub_session=${token}` } });
    assert.equal(continued, 0, `storage ${outcome}`);
    assert.equal(response.status, 302, `storage ${outcome}`);
    assert.ok(calls > before, 'the account was re-read, not trusted from the cookie');
  }
});

test('flag on: a page load always runs the full check, and its scripts reuse an employee-account check for 45 s', async () => {
  let clock = NOW, calls = 0, answer = { user: 'synthetic.worker', source: 'employee-account', expiresAt: NOW + HOURS_12 };
  const memo = new Map(), gate = staffPageGate({ memo, now: () => clock, session: async () => { calls += 1; if (answer instanceof Error) throw answer; return answer; } });
  const allowed = async (path, headers, cookie = 'egc_hub_session=synthetic-v2-token') => (await gate(new Request(ORIGIN + path, { headers: { ...headers, Cookie: cookie } }), ON)).refusal === null;
  assert.equal(await allowed('/employee', HTML), true);
  assert.equal(calls, 1);
  answer = new Error('Synthetic Firestore read failed');
  for (const path of ['/employee-suite.js', '/employee-suite.css', '/employee-dispatch.js', '/employee-operations.css']) assert.equal(await allowed(path, ASSET), true, `${path} reuses the page's check`);
  assert.equal(calls, 1, 'a transient storage failure no longer half-loads the Hub');
  assert.equal(memo.size, 1);
  assert.doesNotMatch([...memo.keys()][0], /synthetic-v2-token/, 'the memo keeps a hash, never the cookie');
  assert.equal(await allowed('/employee', NAVIGATE), false, 'a page load never uses the memo');
  assert.equal(calls, 2);
  assert.equal(memo.size, 0, 'a failed full check drops the entry');
  assert.equal(await allowed('/employee-suite.js', ASSET), false);
  answer = { user: 'synthetic.worker', source: 'employee-account', expiresAt: NOW + HOURS_12 };
  assert.equal(await allowed('/employee', HTML), true);
  clock += 44999;
  assert.equal(await allowed('/employee-suite.js', ASSET), true);
  assert.equal(calls, 4);
  clock += 1;
  answer = null;
  assert.equal(await allowed('/employee-suite.js', ASSET), false, 'after 45 s a script runs the full check again');
  assert.equal(calls, 5);
  assert.equal(await allowed('/employee-suite.js', ASSET), false, 'a revoked account is not remembered');
  answer = { user: 'synthetic.worker', source: 'employee-account', expiresAt: clock + 1000 };
  assert.equal(await allowed('/employee', HTML), true);
  clock += 1000; answer = null;
  assert.equal(await allowed('/employee-suite.js', ASSET), false, 'never past the session expiry');
  answer = { user: 'synthetic.worker', source: 'employee-account', expiresAt: clock + HOURS_12 };
  assert.equal(await allowed('/employee', HTML), true);
  answer = null;
  assert.equal(await allowed('/employee-suite.js', ASSET, 'egc_hub_session=synthetic-other-token'), false, 'another cookie never matches the entry');
  assert.equal(await allowed('/employee-suite.js', ASSET, 'theme=dark'), false, 'no cookie, no memo');
  assert.equal(await gate(new Request(ORIGIN + '/about', { headers: { ...ASSET, Cookie: 'egc_hub_session=synthetic-v2-token' } }), ON), null, 'public paths are untouched');
  const before = calls;
  answer = { user: 'tylerg', businessAccess: true, expiresAt: clock + HOURS_12 };
  assert.equal(await allowed('/employee', HTML, 'egc_hub_session=synthetic-v1-token'), true);
  answer = null;
  assert.equal(await allowed('/employee-suite.js', ASSET, 'egc_hub_session=synthetic-v1-token'), false, 'built-in accounts need no storage, so they are always checked in full');
  assert.equal(calls, before + 2);
  answer = { user: 'synthetic.worker', source: 'employee-account', expiresAt: clock + HOURS_12 };
  for (let index = 0; index < 520; index++) await allowed('/employee', HTML, `egc_hub_session=synthetic-${index}`);
  assert.ok(memo.size <= 500, `the memo stays bounded (${memo.size})`);
});

test('flag on: public exceptions pass without a session and are byte-identical to the flag being off', async () => {
  const pages = [];
  for (const entry of sourceFiles(root)) {
    const file = posix(root, entry);
    if (!file.endsWith('.html')) continue;
    for (const url of servedAt(file)) if (!staffGatedPath(url) && (await edge(url, { env: {} })).continued) pages.push(url);
  }
  assert.ok(pages.length >= 100, `found ${pages.length} public page URLs`);
  for (const path of [...new Set([...SPEC_PUBLIC, ...pages])]) {
    for (const headers of [HTML, ASSET, {}]) {
      const on = await edge(path, { headers });
      assert.equal(on.continued, 1, path);
      assert.deepEqual(await snapshot(on), await snapshot(await edge(path, { env: BASE_ENV, headers })), path);
    }
  }
});

test('flag off (unset, "off" or anything but exactly "on"): gated paths behave exactly as before and no session is read', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const cookie = (await createHubSessionCookie(ON, 'synthetic.crew')).split(';')[0];
  const variants = [NO_ENV, {}, { ...BASE_ENV, EGC_STAFF_PAGE_GATE: 'off' }, { EGC_STAFF_PAGE_GATE: 'ON' }, { EGC_STAFF_PAGE_GATE: 'true' }, { EGC_STAFF_PAGE_GATE: ' on' }, { EGC_STAFF_PAGE_GATE: '' }];
  for (const path of [...GATED_URLS, '/crew/', '/staff-login', '/api/hub-auth']) {
    for (const headers of [HTML, ASSET, { ...HTML, Cookie: cookie }, { ...ASSET, Cookie: 'egc_hub_session=garbage' }]) {
      const baseline = await snapshot(await edge(path, { env: BASE_ENV, headers }));
      assert.equal(baseline.continued, 1, path);
      assert.equal(baseline.status, 200, path);
      for (const env of variants) assert.deepEqual(await snapshot(await edge(path, { env, headers })), baseline, `${path} ${JSON.stringify(env)}`);
    }
  }
  for (const env of [undefined, null, ...variants.slice(1)]) assert.equal(staffPageGateEnabled(env), false);
  assert.equal(staffPageGateEnabled({ EGC_STAFF_PAGE_GATE: 'on' }), true);
  const gate = staffPageGate({ session: () => { throw new Error('the session must not be read'); } });
  for (const env of variants) assert.equal(await gate(new Request(ORIGIN + '/employee-suite.js'), env === NO_ENV ? undefined : env), null);
  assert.equal(await gate(new Request(ORIGIN + '/about'), ON), null, 'public paths never read the session either');
  assert.equal((await gate(new Request(ORIGIN + '/employee-suite.js'), ON)).refusal.status, 401, 'a session lookup that throws fails closed');
});

test('next is honoured only for an exact same-origin gated path: never encoded, protocol-relative, backslash, absolute or public targets', () => {
  const accepted = [
    ['/employee', '/employee'], ['/employee.html', '/employee.html'], ['/employee/', '/employee/'], ['/employee?view=my_day', '/employee?view=my_day'], ['/dispatch', '/dispatch'],
    ['/crew/gameplan', '/crew/gameplan'], ['/crew/gameplan?walkthroughId=synthetic_walk-1', '/crew/gameplan?walkthroughId=synthetic_walk-1'], ['/crew/prejob?jobId=a1&x=b', '/crew/prejob?jobId=a1&x=b'],
    ['/crew/job.html?jobId=synthetic-1', '/crew/job.html?jobId=synthetic-1'], ['/message-templates', '/message-templates'], ['/copilot', '/copilot'], ['/employee?', '/employee'],
  ];
  for (const [value, expected] of accepted) assert.equal(safeStaffNext(value), expected, value);
  const refused = [
    '', ' ', null, undefined, 42, ['/employee'], { toString: () => '/employee' },
    '//evil.example', '//evil.example/employee', '///evil.example', '/\\evil.example', '\\\\evil.example', '\\/evil.example', '/\\/evil.example/employee',
    'https://evil.example/employee', 'http://easygaragecleaning.com/employee', 'https://easygaragecleaning.com/employee', 'javascript:alert(1)', 'data:text/html,x', 'employee', './employee', '../employee',
    '%2F%2Fevil.example', '/%2F%2Fevil.example', '/%2e%2e/employee', '/employee%2F..%2F..%2Fabout', '/%65mployee', '/crew/%67ameplan', '/employee%00', '/employee%0d%0aLocation:%20https://evil.example',
    '/crew/../employee', '/crew/./gameplan', '/employee/..', '/crew//gameplan', '/Employee', '/EMPLOYEE', '/employee ', ' /employee', '/employee\n', '/employee\t', '/employee#top', '/employee?next=//evil.example',
    '/employee?x=https://evil.example', '/employee?view=my day', '/employee?%2F%2Fevil', '/employee?a=<script>', '/employee?a=\\evil', `/employee?${'a'.repeat(600)}`,
    '/about', '/', '/index.html', '/api/hub-auth', '/staff-login', '/crew/', '/crew/index.html', '/crew', '/business-hub', '/employee-signup', '/hub-login-setup', '/crew/hub-auth.js',
  ];
  for (const value of refused) assert.equal(safeStaffNext(value), '', JSON.stringify(value));
  for (const value of accepted.map(([, expected]) => expected)) {
    const url = new URL(value, ORIGIN);
    assert.equal(url.origin, ORIGIN, value);
    assert.equal(staffGatedPath(url.pathname), true, value);
  }
});

test('the sign-in redirect only ever carries a safe next and never points off-site', async () => {
  const cases = [
    ['/employee', '/staff-login?next=%2Femployee'], ['/employee?next=//evil.example', '/staff-login?next=%2Femployee'], ['/employee?x=https://evil.example/', '/staff-login?next=%2Femployee'],
    ['/employee-suite.js', '/staff-login?next=%2Femployee-suite.js'], ['/crew/postjob.html?jobId=synthetic-2', '/crew/?next=%2Fcrew%2Fpostjob.html%3FjobId%3Dsynthetic-2'],
    ['/crew/gameplan?next=%2F%2Fevil.example', '/crew/?next=%2Fcrew%2Fgameplan'], ['/Employee.html', '/staff-login'], ['/crew/%67ameplan', '/crew/'], ['//crew/gameplan.html', '/crew/'],
  ];
  for (const [path, location] of cases) assert.equal(staffSignInLocation(new URL(ORIGIN + path)), location, path);
  for (const path of GATED_URLS) {
    const location = (await edge(path, { headers: HTML })).response.headers.get('location');
    const target = new URL(location, ORIGIN);
    assert.equal(target.origin, ORIGIN, path);
    assert.ok(['/staff-login', '/crew/'].includes(target.pathname), path);
    const next = target.searchParams.get('next');
    if (next !== null) assert.equal(safeStaffNext(next), next, path);
  }
});

test('private staff responses merge Cookie into Vary once', () => {
  const merged = headers => privateStaffResponse(new Response('x', { headers })).headers;
  assert.equal(merged({}).get('vary'), 'Cookie');
  assert.equal(merged({ Vary: 'Accept-Encoding' }).get('vary'), 'Accept-Encoding, Cookie');
  assert.equal(merged({ Vary: 'Accept-Encoding, COOKIE' }).get('vary'), 'Accept-Encoding, COOKIE');
  assert.equal(merged({ 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Robots-Tag': 'all' }).get('cache-control'), 'private, no-store');
  assert.equal(merged({ 'X-Robots-Tag': 'all' }).get('x-robots-tag'), 'noindex, nofollow');
});

test('public pages never load a gated script or stylesheet, so the marketing site and sign-in pages keep working with the gate on', async () => {
  const failures = [];
  for (const entry of sourceFiles(root)) {
    const file = posix(root, entry);
    if (!file.endsWith('.html') || staffGatedPath(file) || !(await edge(file, { env: {} })).continued) continue;
    const html = readFileSync(join(entry.parentPath, entry.name), 'utf8');
    for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
      if (/^<link/i.test(tag) && !/\brel=["']?(?:stylesheet|modulepreload|preload)\b/i.test(tag)) continue;
      const ref = /\b(?:src|href)=["']([^"']+)["']/i.exec(tag)?.[1];
      if (!ref) continue;
      const url = new URL(ref, ORIGIN + file);
      if (url.origin === ORIGIN && staffGatedPath(url.pathname)) failures.push(`${file} -> ${url.pathname}`);
    }
  }
  for (const [, ref] of read('staff-login.js').matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) assert.equal(staffGatedPath(new URL(ref, ORIGIN + '/staff-login.js').pathname), false, ref);
  assert.deepEqual(failures, []);
});

test('the staff sign-in page is private, mobile-ready and signs in through EGCHubAuth', async () => {
  const html = read('staff-login.html');
  assert.match(html, /<meta name="robots" content="noindex,nofollow,noarchive">/);
  assert.match(html, /<input id="user" name="username" type="text" autocomplete="username" autocapitalize="none"/);
  assert.match(html, /<input id="pass" name="password" type="password" autocomplete="current-password"/);
  assert.match(html, /<button type="submit" id="sl-submit" disabled/);
  assert.match(html, /font-size:16px/);
  assert.match(html, /min-height:52px/);
  assert.match(html, /<script src="\/crew\/hub-auth\.js\?v=[^"]+"><\/script>\s*<script type="module" src="\/staff-login\.js\?v=[^"]+"><\/script>/);
  assert.doesNotMatch(html, /analytics-loader|googletagmanager|fbevents|clarity|innerHTML/);
  assert.match(read('_headers'), /\/staff-login\*\n  X-Robots-Tag: noindex\n  Cache-Control: no-store\n  X-Frame-Options: DENY/);
  assert.match(read('_generate_site.py'), /"staff-login\.html"/);
  const { response } = await edge('/staff-login', { env: ON, headers: HTML, upstream: () => new Response(html, { headers: { 'Content-Type': 'text/html' } }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
});


// Load staff-login.js as a real module against a minimal DOM; each case gets a fresh module instance.
let moduleCase = 0;
const BROWSER_GLOBALS = ['window', 'location', 'document', 'firebase', 'EGCHubAuth', 'EGCStaffNext', 'fetch', 'sessionStorage'];
const ORIGINAL_GLOBALS = Object.fromEntries(BROWSER_GLOBALS.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
function restoreBrowserGlobals() {
  for (const key of BROWSER_GLOBALS) { if (ORIGINAL_GLOBALS[key]) Object.defineProperty(globalThis, key, ORIGINAL_GLOBALS[key]); else delete globalThis[key]; }
}
function tabStorage({ blocked = false } = {}) {
  const values = new Map(), guard = fn => (...args) => { if (blocked) throw new Error('SecurityError: storage is blocked'); return fn(...args); };
  return { values, getItem: guard(key => values.has(key) ? values.get(key) : null), setItem: guard((key, value) => { values.set(key, String(value)); }), removeItem: guard(key => { values.delete(key); }) };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

async function staffLogin(t, { search = '', form = true, session = 'none', storage = tabStorage(), signIn = async () => 'synthetic.crew' } = {}) {
  const replaced = [], initialized = [], signIns = [], checks = [];
  const nodes = {
    'login-error': { hidden: true, textContent: '' },
    'sl-submit': { disabled: true, textContent: 'Sign in', attributes: { 'aria-busy': 'true' }, setAttribute(name, value) { this.attributes[name] = value; } },
    'sl-next': { hidden: true, children: [], replaceChildren(...children) { this.children = children; } },
  };
  if (form) nodes['staff-login'] = { listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; }, elements: { username: { value: '  synthetic.crew ' }, password: { value: 'synthetic-password' } } };
  const globals = {
    window: globalThis, location: { search, replace: url => replaced.push(url) }, sessionStorage: storage,
    document: { getElementById: id => nodes[id] || null, createElement: tag => ({ tagName: tag.toUpperCase(), textContent: '' }) },
    firebase: { apps: [], initializeApp(config) { this.apps.push(config); initialized.push(config.projectId); } },
    EGCHubAuth: { signIn: (...args) => { signIns.push(args); return signIn(...args); } },
    fetch: async (url, init = {}) => {
      checks.push([url, init.method || 'GET', init.credentials, init.cache]);
      if (session === 'offline') throw new TypeError('Failed to fetch');
      return session === 'signed-in' ? Response.json({ ok: true, user: 'synthetic.crew' }) : Response.json({ ok: false, error: 'Sign in required' }, { status: 401 });
    },
  };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  t.after(restoreBrowserGlobals);
  await import(`${pathToFileURL(join(root, 'staff-login.js')).href}?case=${++moduleCase}`);
  await settle();
  const submit = async () => { let prevented = false; await nodes['staff-login'].listeners.submit({ preventDefault() { prevented = true; } }); return prevented; };
  return { nodes, replaced, initialized, signIns, checks, storage, submit };
}

test('staff sign-in returns to a safe next after EGCHubAuth.signIn and shows where it is going', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  let finish;
  const page = await staffLogin(t, { search: '?next=%2Fcrew%2Fprejob%3FjobId%3Dsynthetic-job-1', signIn: () => new Promise(resolve => { finish = resolve; }) });
  assert.deepEqual(page.initialized, ['egcw-1ec83']);
  assert.deepEqual(page.checks, [['/api/hub-auth', 'GET', 'same-origin', 'no-store']], 'the page first checks for an existing session');
  assert.equal(page.nodes['sl-submit'].disabled, false, 'the button unlocks once the check finishes');
  assert.equal(page.nodes['sl-submit'].attributes['aria-busy'], 'false');
  assert.equal(page.nodes['login-error'].hidden, true);
  assert.equal(page.nodes['sl-next'].hidden, false);
  assert.deepEqual(page.nodes['sl-next'].children.map(child => typeof child === 'string' ? child : `<${child.tagName}>${child.textContent}`), ['After signing in you will return to ', '<STRONG>/crew/prejob', '.']);
  const pending = page.submit();
  assert.equal(page.nodes['sl-submit'].disabled, true);
  assert.equal(page.nodes['sl-submit'].textContent, 'Signing in…');
  assert.deepEqual(page.signIns, [['synthetic.crew', 'synthetic-password']]);
  finish('synthetic.crew');
  assert.equal(await pending, true, 'the form never submits natively');
  assert.deepEqual(page.replaced, ['/crew/prejob?jobId=synthetic-job-1']);
  assert.equal(page.nodes['sl-submit'].disabled, true, 'stays locked while the next page opens');
  assert.deepEqual(JSON.parse(page.storage.values.get('egc.staffNext.v1')), { next: '/crew/prejob?jobId=synthetic-job-1', at: NOW });
});

test('staff sign-in ignores an unsafe next and falls back to the Hub', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  for (const next of ['https%3A%2F%2Fevil.example%2Femployee', '%2F%2Fevil.example', '%2F%5Cevil.example', '%2Fabout', 'javascript%3Aalert(1)', '%2Femployee%3Fnext%3D%2F%2Fevil.example']) {
    const page = await staffLogin(t, { search: `?next=${next}` });
    assert.equal(page.nodes['sl-next'].hidden, true, next);
    await page.submit();
    assert.deepEqual(page.replaced, ['/employee'], next);
    const signedIn = await staffLogin(t, { search: `?next=${next}`, session: 'signed-in' });
    assert.deepEqual(signedIn.replaced, ['/employee'], `an existing session also continues only to the Hub: ${next}`);
  }
  const plain = await staffLogin(t);
  await plain.submit();
  assert.deepEqual(plain.replaced, ['/employee']);
});

test('a failed staff sign-in shows the Hub error wording and lets the viewer retry', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const page = await staffLogin(t, { search: '?next=%2Fdispatch', signIn: async () => { throw new Error('Incorrect username or password'); } });
  await page.submit();
  assert.equal(page.nodes['login-error'].hidden, false);
  assert.equal(page.nodes['login-error'].textContent, 'Incorrect username or password');
  assert.equal(page.nodes['sl-submit'].disabled, false);
  assert.equal(page.nodes['sl-submit'].textContent, 'Sign in');
  assert.deepEqual(page.replaced, []);
  const silent = await staffLogin(t, { signIn: async () => { throw {}; } });
  await silent.submit();
  assert.equal(silent.nodes['login-error'].textContent, 'Unable to sign in. Check the connection and try again.');
  const offline = await staffLogin(t, { session: 'offline' });
  assert.equal(offline.nodes['sl-submit'].disabled, false, 'a failed session check still offers the form');
  assert.equal(offline.nodes['login-error'].hidden, true);
});

test('a viewer who is already signed in continues once, and a page that keeps refusing never causes a redirect loop', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const storage = tabStorage();
  const first = await staffLogin(t, { search: '?next=%2Fdispatch', session: 'signed-in', storage });
  assert.deepEqual(first.replaced, ['/dispatch'], 'a cross-site link arrives without the Strict cookie; the page continues on its own');
  assert.equal(first.nodes['sl-submit'].textContent, 'Opening…');
  t.mock.timers.tick(2000);
  const bounced = await staffLogin(t, { search: '?next=%2Fdispatch', session: 'signed-in', storage });
  assert.deepEqual(bounced.replaced, [], 'the edge refused again within seconds: stop and ask');
  assert.equal(bounced.nodes['login-error'].hidden, false);
  assert.equal(bounced.nodes['login-error'].textContent, 'Your session could not open that page. Sign in again to continue.');
  assert.equal(bounced.nodes['sl-submit'].disabled, false);
  const other = await staffLogin(t, { search: '?next=%2Fcrew%2Fprejob', session: 'signed-in', storage });
  assert.deepEqual(other.replaced, ['/crew/prejob'], 'the guard is per destination');
  t.mock.timers.tick(10000);
  const later = await staffLogin(t, { search: '?next=%2Fcrew%2Fprejob', session: 'signed-in', storage });
  assert.deepEqual(later.replaced, ['/crew/prejob'], 'the guard expires');
  const blocked = await staffLogin(t, { search: '?next=%2Fdispatch', session: 'signed-in', storage: tabStorage({ blocked: true }) });
  assert.deepEqual(blocked.replaced, [], 'without storage for the guard the page never forwards on its own');
  await blocked.submit();
  assert.deepEqual(blocked.replaced, ['/dispatch'], 'an explicit sign-in still continues');
});

test('on the crew sign-in the module only exposes the safe return and does not start its own form', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const page = await staffLogin(t, { form: false, search: '?next=%2Fcrew%2Fgameplan%3FwalkthroughId%3Dsynthetic-1', session: 'signed-in' });
  assert.deepEqual(page.initialized, [], 'crew/index.html initializes Firebase itself');
  assert.deepEqual(page.checks, [], 'crew/index.html checks its own session');
  assert.equal(globalThis.EGCStaffNext.target(), '/crew/gameplan?walkthroughId=synthetic-1');
  assert.equal(globalThis.EGCStaffNext.resume(), true);
  assert.deepEqual(page.replaced, ['/crew/gameplan?walkthroughId=synthetic-1']);
  assert.equal(globalThis.EGCStaffNext.resume(), false, 'a second automatic return inside the guard window is refused');
  assert.equal(globalThis.EGCStaffNext.go(), true, 'an explicit sign-in always returns');
  assert.deepEqual(page.replaced, ['/crew/gameplan?walkthroughId=synthetic-1', '/crew/gameplan?walkthroughId=synthetic-1']);
  assert.equal(globalThis.EGCStaffNext.target('?next=%2F%2Fevil.example'), '');
  globalThis.location.search = '?next=https%3A%2F%2Fevil.example';
  assert.equal(globalThis.EGCStaffNext.go(), false);
  assert.equal(globalThis.EGCStaffNext.resume(), false);
  assert.equal(page.replaced.length, 2);
});

test('the crew sign-in follows a safe next after signing in or on a restored session, and otherwise opens the crew home', async () => {
  const html = read('crew/index.html');
  assert.match(html, /<script src="\/crew\/hub-auth\.js\?v=[^"]+"><\/script>\n<script type="module" src="\/staff-login\.js\?v=[^"]+"><\/script>/);
  assert.match(html, /<div class="access-note" id="next-note" role="alert" hidden>Your session could not open that page\. Sign in again to continue\.<button type="button" id="next-signin">Sign in again<\/button><\/div>/);
  assert.match(html, /\.access-note button\{[^}]*min-height:44px/);
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(code => code.includes('async function gateLogin(){'));
  const cases = [
    ['safe next', { go: () => true, resume: () => true, target: () => '/crew/gameplan' }, { 'sign-in': 'next', restored: 'next' }],
    ['no next', { go: () => false, resume: () => false, target: () => '' }, { 'sign-in': 'home', restored: 'home' }],
    ['next keeps refusing', { go: () => true, resume: () => false, target: () => '/crew/gameplan' }, { 'sign-in': 'next', restored: 'notice' }],
    ['module missing', undefined, { 'sign-in': 'home', restored: 'home' }],
  ];
  for (const [label, staffNext, expected] of cases) {
    for (const path of ['sign-in', 'restored']) {
      const calls = [], listeners = {}, elements = {};
      const element = id => elements[id] ||= { value: ' synthetic.crew ', style: {}, textContent: '', disabled: false, hidden: true, classes: new Set(), listeners: {},
        classList: { add(name) { elements[id].classes.add(name); } }, addEventListener(type, listener) { this.listeners[type] = listener; } };
      const context = vm.createContext({
        document: { getElementById: element, querySelector: () => element('gate-button'), addEventListener: (type, listener) => { listeners[type] = listener; } },
        EGCHubAuth: { signIn: async (...args) => { calls.push(['signIn', ...args]); return 'synthetic.crew'; }, session: async () => 'synthetic.crew', signOut: async () => { calls.push(['signOut']); } },
        location: { reload: () => calls.push(['reload']) },
        openCrewHome: async () => { calls.push(['home']); },
      });
      context.window = context;
      if (staffNext) context.EGCStaffNext = staffNext;
      vm.runInContext(script, context);
      if (path === 'sign-in') {
        await vm.runInContext('gateLogin()', context);
        assert.deepEqual(calls[0], ['signIn', 'synthetic.crew', ' synthetic.crew '], label);
        assert.equal(element('gate-button').disabled, false, label);
      } else {
        listeners.DOMContentLoaded();
        await settle();
      }
      const outcome = expected[path], home = outcome !== 'next';
      assert.equal(calls.some(([name]) => name === 'home'), home, `${label} ${path}`);
      assert.equal(element('egc-gate').classes.has('off'), home, `${label} ${path}`);
      assert.equal(element('next-note').hidden, outcome !== 'notice', `${label} ${path}: the refused page is explained, not silently dropped`);
      if (outcome === 'notice') {
        await element('next-signin').listeners.click();
        assert.deepEqual(calls.slice(-2), [['signOut'], ['reload']], 'Sign in again signs out and reloads with the same next');
      }
    }
  }
});
