import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { sourceFiles } from '../source-files.mjs';
import { FIXED_NOW, FIXTURE_APIS, FUNCTION_ROUTES, HARNESS, PRIVATE_PATH, READY_MESSAGE, ROOT, createPagesHandler, createPagesServer, headersFor, loadFixtures, parseHeadersFile } from './serve.mjs';

const NOW = '2026-09-22T15:00:00.000Z';
const config = createRequire(import.meta.url)('./lighthouserc.cjs');
const read = path => readFileSync(join(ROOT, path));
const handler = (options = {}) => createPagesHandler({ now: () => NOW, ...options });
const get = (handle, url, headers = {}) => handle({ method: 'GET', url, headers });
const json = response => JSON.parse(response.body.toString('utf8'));
const PHONE = /(?<!\d)(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?!\d)/g;

function strings(value, key = '', out = []) {
  if (typeof value === 'string') out.push([key, value]);
  else if (Array.isArray(value)) value.forEach(item => strings(item, key, out));
  else if (value && typeof value === 'object') for (const [name, item] of Object.entries(value)) strings(item, name, out);
  return out;
}

async function listen(t, options = {}) {
  const server = createPagesServer({ now: () => NOW, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

function tempRoot(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'egc-lighthouse-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), body); }
  return dir;
}

function call(base, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('extensionless paths serve the .html page and .html URLs redirect like Cloudflare Pages', () => {
  const handle = handler();
  for (const [url, file] of [['/book', 'book.html'], ['/pricing', 'pricing.html'], ['/garage-cleanouts-fort-collins-co', 'garage-cleanouts-fort-collins-co.html'], ['/crew/job', 'crew/job.html'], ['/', 'index.html']]) {
    const response = get(handle, url);
    assert.equal(response.status, 200, url);
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8', url);
    assert.deepEqual(response.body, read(file), url);
  }
  for (const [url, location] of [['/book.html', '/book'], ['/book.html?ref=lh', '/book?ref=lh'], ['/index.html', '/'], ['/about/', '/about'], ['/crew/job.html', '/crew/job']]) {
    const response = get(handle, url);
    assert.equal(response.status, 308, url);
    assert.equal(response.headers.location, location, url);
  }
  assert.equal(get(handle, '/styles.css').headers['content-type'], 'text/css; charset=utf-8');
  assert.deepEqual(get(handle, '/employee-field-today.js').body, read('employee-field-today.js'));
});

test('directory paths serve index.html only with the trailing slash', () => {
  const handle = handler(), blog = get(handle, '/blog/');
  assert.equal(blog.status, 200);
  assert.deepEqual(blog.body, read('blog/index.html'));
  assert.equal(get(handle, '/blog').status, 308);
  assert.equal(get(handle, '/blog').headers.location, '/blog/');
  assert.equal(get(handle, '/blog/index.html').headers.location, '/blog/');
  assert.equal(get(handle, '/crew/').status, 200);
  assert.deepEqual(get(handle, '/crew/').body, read('crew/index.html'));
});

test('missing and private paths return the real 404 page with a 404 status', () => {
  const handle = handler(), page = read('404.html');
  const dotFolder = '/.' + 'git/config';
  for (const url of ['/definitely-not-a-page', '/blog/not-a-post', '/missing.css', '/tests/lighthouse/pages/field-today.html', '/tests/lighthouse/serve.mjs', '/docs/lighthouse-ci.md', '/scripts/', '/package.json', '/_headers', '/_redirects', '/README.md', dotFolder, '/.github/workflows/egc-lighthouse.yml', '/node_modules/@noble/hashes/package.json', '/%2e%2e/%2e%2e/etc/passwd', '/field-today.html']) {
    const response = get(handle, url);
    assert.equal(response.status, 404, url);
    assert.deepEqual(response.body, page, url);
    assert.equal(response.headers['x-robots-tag'], 'noindex, nofollow', url);
    assert.equal(response.headers['cache-control'], 'no-store', url);
  }
  assert.equal(get(handle, '/.well-known/security.txt').status, 200);
  assert.equal(get(handle, '/404').status, 404, 'the middleware serves the explicit 404 page with a 404 status');
  assert.equal(get(handle, '/404.html').headers.location, '/404');
});

test('the local denial list blocks exactly what the production middleware blocks', async () => {
  const { onRequest } = await import('../../functions/_middleware.js');
  const samples = ['/', '/book', '/tests', '/tests/lighthouse/serve.mjs', '/TESTS/x', '/docs/a.md', '/scripts/x.mjs', '/contracts/x.html', '/auth-verifier/src/index.js', '/sop', '/sop.html', '/tyler-contract.html', '/EGC-Lead-System-SOP.pdf', '/package.json', '/package-lock.json', '/README.md', '/firebase.json', '/firestore.rules', '/.firebaserc', '/.env', '/.env.example', '/_generate_site.py', '/_headers', '/blog/', '/testsuite', '/docsite', '/crew/job', '/functions/_lib/catalog.js', '/functions/_data/garage-catalog.json', '/egc-platform/package.json', '/tools/gallery/publish-links.py', '/.github/workflows/egc-root-ci.yml', '/.claude/settings.json', '/node_modules/x/package.json', '/firebase.emulator.json', '/pnpm-lock.yaml', '/deep/tool.py', '/functional', '/toolshed'];
  for (const path of samples) {
    let continued = false;
    const response = await onRequest({ request: new Request(`https://easygaragecleaning.com${path}`), env: {}, next: async () => { continued = true; return new Response('ok', { headers: { 'Content-Type': 'text/plain' } }); } });
    assert.equal(PRIVATE_PATH.test(path), !continued && response.status === 404, path);
  }
  assert.ok(HARNESS['/field-today'].startsWith('tests/'), 'harness pages stay under the production-denied /tests tree');
});

test('a subset of _headers applies to matching paths', () => {
  const handle = handler();
  assert.equal(get(handle, '/styles.css').headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(get(handle, '/images/garage-after.webp').headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(get(handle, '/site-enhancements.js').headers['cache-control'], 'no-cache');
  assert.equal(get(handle, '/book').headers['cache-control'], 'public, max-age=0, must-revalidate');
  const portal = get(handle, '/customer-portal').headers;
  assert.equal(portal['cache-control'], 'no-store');
  assert.equal(portal['x-robots-tag'], 'noindex');
  assert.equal(portal['x-frame-options'], 'DENY');
  assert.equal(portal['referrer-policy'], 'no-referrer');
  assert.equal(get(handle, '/crew/job').headers['cache-control'], 'no-cache');
  assert.equal(get(handle, '/employee-field-today.css').headers['cache-control'], 'no-store');
  const rules = parseHeadersFile('# comment\n/a/*\n  X-One: 1\n  Cache-Control: no-cache\n\n/a/b\n  X-One: 2\n  Cache-Control: no-store\n/*.png\n  X-Png: yes\n');
  assert.deepEqual(headersFor(rules, '/a/b'), { 'x-one': '1, 2', 'cache-control': 'no-store' });
  assert.deepEqual(headersFor(rules, '/logo.png'), { 'x-png': 'yes' });
  assert.deepEqual(headersFor(rules, '/a'), {});
  assert.deepEqual(headersFor(rules, '/xa/b'), {});
});

test('text responses are compressed as Cloudflare serves them and decompress to the file', () => {
  const handle = handler(), html = read('index.html');
  const br = get(handle, '/', { 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(br.headers.vary, 'Accept-Encoding');
  assert.equal(Number(br.headers['content-length']), br.body.length);
  assert.ok(br.body.length < html.length / 2);
  assert.deepEqual(brotliDecompressSync(br.body), html);
  const gzip = get(handle, '/', { 'accept-encoding': 'gzip' });
  assert.equal(gzip.headers['content-encoding'], 'gzip');
  assert.deepEqual(gunzipSync(gzip.body), html);
  assert.equal(get(handle, '/').headers['content-encoding'], undefined);
  assert.equal(get(handle, '/images/garage-after.webp', { 'accept-encoding': 'br' }).headers['content-encoding'], undefined, 'images are already compressed');
  const head = handle({ method: 'HEAD', url: '/', headers: {} });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(Number(head.headers['content-length']), html.length);
});

// The real Hub business usernames: the shared functions/_lib/business-users.js module once P1-02 lands, else the older
// private Set inside hub-session.js.
async function realHubUsers() {
  const shared = join(ROOT, 'functions/_lib/business-users.js');
  if (existsSync(shared)) return [...(await import(pathToFileURL(shared).href)).BUSINESS_USERS];
  return [...readFileSync(join(ROOT, 'functions/_lib/hub-session.js'), 'utf8').match(/BUSINESS_USERS = new Set\(\[([^\]]+)\]\)/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
}

test('fixture APIs return only synthetic data', async () => {
  const handle = handler(), fixtures = loadFixtures();
  const realUsers = await realHubUsers();
  assert.ok(realUsers.length >= 3);
  const realPhones = new Set([...['index.html', 'business-hub.html', 'customer-portal.html'].map(file => read(file).toString('utf8')).join('\n').matchAll(PHONE)].map(match => match.slice(1).join('')));
  assert.ok(realPhones.has('9709991818') && realPhones.has('9709991403'), 'the business lines are part of the deny list');
  assert.deepEqual([...'tel:+19705550100 (970) 555-0101 970.555.0102 2026-09-22T13:40:00.000000Z'.matchAll(PHONE)].map(match => match.slice(1).join('')), ['9705550100', '9705550101', '9705550102']);
  const nameKeys = new Set(['name', 'firstName', 'customer', 'authorName', 'displayName', 'company', 'author', 'approvedBy', 'decisionMaker', 'payer', 'createdBy', 'onsiteContact', 'contact', 'crewName']);
  for (const path of FIXTURE_APIS) {
    const response = get(handle, `${path}?date=2026-09-22&days=2&status=all`);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers['cache-control'], 'no-store', path);
    const body = json(response), text = JSON.stringify(body);
    for (const user of realUsers) assert.doesNotMatch(text, new RegExp(`\\b${user}\\b`, 'i'), `${path} names real user ${user}`);
    assert.doesNotMatch(text, /zoe|zoll|easygaragecleaning\.com|https?:\/\//i, path);
    for (const [key, value] of strings(body)) {
      for (const match of value.matchAll(PHONE)) {
        assert.equal(match[2], '555', `${path} ${key} has a non-synthetic phone ${match[0]}`);
        assert.ok(!realPhones.has(match.slice(1).join('')), `${path} ${key} reuses a real phone`);
      }
      for (const match of value.matchAll(/[^\s@"]+@([^\s@"]+)/g)) assert.equal(match[1], 'example.invalid', `${path} ${key} email ${match[0]}`);
      if (nameKeys.has(key) && value) assert.match(value, /Synthetic/, `${path} ${key}="${value}" is not labeled synthetic`);
    }
  }
  assert.equal(fixtures.fieldJobs.jobs.every(job => /^Synthetic /.test(job.customer) && job.crewMembers.every(person => /^Synthetic /.test(person.name))), true);
});

test('fixtures carry the fields the real pages render', () => {
  const { customerPortal, businessHub, fieldJobs, hubAuth } = loadFixtures();
  assert.equal(customerPortal.ok, true);
  for (const key of ['customer', 'appointment', 'estimate', 'payment', 'photos', 'conversation', 'messaging', 'experience', 'viewer']) assert.ok(customerPortal[key], `portal ${key}`);
  for (const key of ['service', 'status', 'date', 'time', 'endTime', 'address']) assert.equal(typeof customerPortal.appointment[key], 'string', `appointment.${key}`);
  assert.ok(customerPortal.estimate.lineItems.length);
  assert.equal(customerPortal.estimate.lineItems.reduce((sum, item) => sum + item.amount, 0), customerPortal.estimate.amount);
  assert.equal(customerPortal.payment.total - customerPortal.payment.paid, customerPortal.payment.balance);
  for (const key of ['properties', 'requests', 'projects', 'members', 'messages']) assert.ok(Array.isArray(businessHub[key]), `business ${key}`);
  assert.ok(businessHub.account.company && businessHub.viewer.permissions.view && businessHub.coverage);
  for (const item of [...businessHub.properties, ...businessHub.requests, ...businessHub.members, ...businessHub.messages]) assert.match(item.id, /^[a-f0-9]{32}$/);
  assert.ok(businessHub.projects.every(project => businessHub.properties.some(property => property.id === project.propertyId)));
  assert.ok(fieldJobs.jobs.every(job => typeof job.id === 'string' && job.date && job.time && job.endTime));
  assert.ok(fieldJobs.jobs.some(job => job.status === 'in_progress'), 'the crew screen shows a current job');
  assert.equal(hubAuth.ok, true);
  assert.equal(hubAuth.businessAccess, false);
});

test('field jobs follow the requested Mountain date and otherwise the injected fixed clock', () => {
  const later = get(handler(), '/api/field-jobs?date=2026-11-02&days=2&status=all'), body = json(later);
  assert.equal(later.status, 200);
  assert.equal(body.date, '2026-11-02');
  assert.equal(body.endDate, '2026-11-03');
  assert.equal(body.generatedAt, NOW);
  assert.deepEqual(body.jobs.map(job => [job.id, job.date, job.endDate]), [['synthetic_field_3000', '2026-11-02', '2026-11-02'], ['synthetic_field_3001', '2026-11-02', '2026-11-02'], ['synthetic_field_3002', '2026-11-02', '2026-11-02'], ['synthetic_field_3003', '2026-11-02', '2026-11-02'], ['synthetic_field_3004', '2026-11-03', '2026-11-03']]);
  const oneDay = json(get(handler(), '/api/field-jobs?date=2026-11-02'));
  assert.equal(oneDay.jobs.length, 4);
  assert.deepEqual(json(get(handler(), '/api/field-jobs?date=2026-11-02&days=2&status=active')).jobs.map(job => job.id), ['synthetic_field_3001', 'synthetic_field_3002', 'synthetic_field_3003', 'synthetic_field_3004']);
  assert.deepEqual(json(get(handler(), '/api/field-jobs?date=2026-11-02&status=completed')).jobs.map(job => job.id), ['synthetic_field_3000']);
  // 03:00 UTC on Oct 1 is still Sep 30 in Denver.
  const clocked = json(get(handler({ now: () => '2026-10-01T03:00:00.000Z' }), '/api/field-jobs'));
  assert.equal(clocked.date, '2026-09-30');
  assert.equal(clocked.generatedAt, '2026-10-01T03:00:00.000Z');
  assert.equal(json(get(createPagesHandler(), '/api/field-jobs')).generatedAt, FIXED_NOW);
  for (const query of ['date=2026-02-30', 'date=09/22/2026', 'days=0', 'days=8', 'days=1.5', 'status=everything']) {
    const response = get(handler(), `/api/field-jobs?${query}`);
    assert.equal(response.status, 400, query);
    assert.equal(json(response).ok, false, query);
  }
  assert.equal(get(handler(), '/api/not-a-fixture').status, 404);
});

test('no write methods are accepted and the server never reaches the network', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (...args) => { calls.push(args); throw new Error('network is not allowed'); });
  const base = await listen(t), before = JSON.stringify(loadFixtures());
  for (const path of [...FIXTURE_APIS, '/api/web-lead', '/api/drive-upload', '/', '/customer-portal']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await call(base, path, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: '{"action":"send_message","body":"Synthetic"}' });
      assert.equal(response.status, 405, `${method} ${path}`);
      assert.equal(response.headers.allow, 'GET, HEAD', `${method} ${path}`);
      if (path.startsWith('/api/')) assert.equal(JSON.parse(response.body).code, 'LIGHTHOUSE_READ_ONLY');
    }
  }
  assert.equal(JSON.stringify(loadFixtures()), before);
  assert.equal((await call(base, '/api/customer-portal')).status, 200);
  assert.equal(calls.length, 0);
});

test('every configured Lighthouse URL returns 200 HTML through the real server', async t => {
  const base = await listen(t);
  assert.ok(config.paths.length >= 12);
  assert.deepEqual(config.ci.collect.url, config.paths.map(path => `http://127.0.0.1:${config.port}${path}`));
  for (const path of config.paths) {
    const response = await call(base, path, { headers: { 'Accept-Encoding': 'br' } });
    assert.equal(response.status, 200, path);
    assert.match(response.headers['content-type'], /^text\/html/, path);
    assert.doesNotMatch(brotliDecompressSync(response.body).toString('utf8'), /<title>Page Not Found/, path);
  }
  for (const path of ['/', '/garage-cleanouts-fort-collins-co', '/junk-removal-loveland-co', '/couch-removal-fort-collins-co', '/book', '/pricing', '/blog/how-much-does-garage-cleanout-cost-fort-collins', '/garage-turnaround-fort-collins-co', '/before-after', '/customer-portal', '/business-hub', '/field-today']) assert.ok(config.paths.includes(path), path);
  const clientLogin = config.clientLoginPath(ROOT);
  assert.equal(config.paths.some(path => /^\/client-login\/?$/.test(path)), clientLogin !== null);
  if (clientLogin) assert.ok(config.paths.includes(clientLogin));
  assert.deepEqual(config.pending, clientLogin ? [] : ['/client-login'], 'a missing Client Login stays visible in the job summary');
  assert.equal(clientLogin === null, !existsSync(join(ROOT, 'client-login.html')) && !existsSync(join(ROOT, 'client-login', 'index.html')) && !config.clientLoginFunction(ROOT));
});

test('Client Login is audited in every shape Cloudflare Pages serves it, and the server agrees with the URL list', async t => {
  const page = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Client Login</title></head><body><h1>Synthetic Client Login</h1></body></html>';
  const fn = body => `export const onRequestGet = async () => new Response(${JSON.stringify(body)}, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });\n`;
  const shapes = [
    ['static page', { 'client-login.html': page }, '/client-login', page],
    ['folder index', { 'client-login/index.html': page }, '/client-login/', page],
    ['Pages Function', { 'functions/client-login.js': fn('from function') }, '/client-login', 'from function'],
    ['function folder index', { 'functions/client-login/index.js': fn('from index function') }, '/client-login', 'from index function'],
    ['optional catch-all function', { 'functions/client-login/[[path]].js': fn('from catch-all') }, '/client-login', 'from catch-all'],
    ['function that defers to the static page', { 'client-login.html': page, 'functions/client-login.js': 'export const onRequestGet = [async ({ next }) => { const response = await next(); return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), \'x-synthetic-chain\': \'1\' } }); }];\n' }, '/client-login', page],
  ];
  for (const [label, files, path, body] of shapes) {
    const root = tempRoot(t, files);
    assert.equal(config.clientLoginPath(root), path, label);
    const base = await listen(t, { root }), response = await call(base, path);
    assert.equal(response.status, 200, label);
    assert.match(response.headers['content-type'], /^text\/html/, label);
    assert.equal(response.body.toString('utf8'), body, label);
    if (files['functions/client-login.js']?.includes('next()')) assert.equal(response.headers['x-synthetic-chain'], '1', label);
    assert.equal((await call(base, path, { method: 'HEAD' })).status, 200, `${label} HEAD`);
  }
  for (const [label, files] of [['nothing shipped', { 'index.html': page }], ['a different route', { 'functions/client-login-callback.js': fn('callback'), 'functions/client-login/[token].js': fn('token') }]]) {
    const root = tempRoot(t, files);
    assert.equal(config.clientLoginPath(root), null, label);
    assert.equal((await call(await listen(t, { root }), '/client-login')).status, 404, label);
  }
  const broken = tempRoot(t, { 'functions/client-login.js': "export const onRequestGet = ({ env }) => new Response(env.SYNTHETIC_SECRET.trim());\n" });
  const quiet = t.mock.method(console, 'error', () => {});
  assert.equal((await call(await listen(t, { root: broken }), '/client-login')).status, 500, 'a function that needs a real binding fails loudly');
  assert.equal(quiet.mock.callCount(), 1);
  assert.deepEqual(Object.keys(FUNCTION_ROUTES), ['/client-login'], '/before-after stays the committed static fallback');
});

test('local Lighthouse output stays out of git and out of every repo-wide source scan', t => {
  const ignored = readFileSync(join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).map(line => line.trim());
  for (const entry of ['.lighthouseci/', 'lighthouse-reports/', 'test-results/']) assert.ok(ignored.includes(entry), entry);
  assert.equal(config.reportDirFor({}), join(ROOT, 'test-results', 'lighthouse'), 'reports default under the gitignored test-results/');
  assert.equal(config.reportDirFor({ LIGHTHOUSE_REPORT_DIR: '/tmp/egc-lh-reports' }), resolve('/tmp/egc-lh-reports'));
  assert.equal(config.reportDirFor({ LIGHTHOUSE_REPORT_DIR: 'lighthouse-reports' }), resolve(process.cwd(), 'lighthouse-reports'));
  assert.equal(config.ci.upload.outputDir, config.reportDirFor(process.env));
  const report = '<!doctype html><html><head><title>Lighthouse Report</title><link rel="stylesheet" href="/styles.css?v=1"></head><body><h1>a</h1><h1>b</h1></body></html>';
  const root = tempRoot(t, { 'page.html': '<h1>page</h1>', '.lighthouseci/lhr-1758553200000.html': report, '.lighthouseci/lhr-1758553200000.json': '{}', 'lighthouse-reports/127_0_0_1-2026_09_22.report.html': report, 'test-results/lighthouse/manifest.json': '[]', 'blog/.lighthouseci/lhr-1.html': report });
  assert.deepEqual(sourceFiles(root).map(entry => join(entry.parentPath, entry.name)), [join(root, 'page.html')]);
  if (spawnSync('git', ['-C', ROOT, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).stdout?.trim() === 'true') {
    const check = spawnSync('git', ['-C', ROOT, 'check-ignore', '--no-index', '.lighthouseci/lhr-1.html', 'lighthouse-reports/manifest.json', 'test-results/lighthouse/manifest.json'], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    assert.equal(check.stdout.trim().split('\n').length, 3);
  }
});

test('the crew Today harness mounts the production module and its assets resolve', async t => {
  const base = await listen(t), html = (await call(base, '/field-today')).body.toString('utf8');
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(html, /<html lang="en">/);
  const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(match => match[1]);
  assert.ok(assets.includes('/employee-field-today.js') && assets.includes('/employee-field-today.css'));
  for (const asset of assets) assert.equal((await call(base, asset)).status, 200, asset);
  assert.match(html, /EGCFieldToday\.mount\(document\.getElementById\('ops-field-today'\)\)/);
  assert.match(html, /id="ops-field-today"/);
  // Crew screens never load marketing analytics, and the generator must not inject it into the harness (SITE-0 prunes tests/).
  assert.doesNotMatch(html, /analytics-loader|googletagmanager|gtag\(|fbevents|clarity/i);
  assert.doesNotMatch(read(HARNESS['/field-today']).toString('utf8'), /analytics-loader/);
});

test('Lighthouse settings are mobile 375x812 at DPR 3, simulated, and assert 0.9 as errors', () => {
  const { collect, assert: assertions, upload } = config.ci;
  assert.equal(collect.numberOfRuns, 3);
  assert.equal(collect.settings.formFactor, 'mobile');
  assert.deepEqual(collect.settings.screenEmulation, { mobile: true, width: 375, height: 812, deviceScaleFactor: 3, disabled: false });
  assert.equal(collect.settings.throttlingMethod, 'simulate');
  assert.deepEqual(collect.settings.onlyCategories, ['performance', 'accessibility']);
  for (const host of ['googletagmanager.com', 'connect.facebook.net', 'clarity.ms']) assert.ok(collect.settings.blockedUrlPatterns.some(pattern => pattern.includes(host)), host);
  assert.equal(config.minScore, 0.9);
  for (const category of ['performance', 'accessibility']) assert.deepEqual(assertions.assertions[`categories:${category}`], ['error', { minScore: 0.9, aggregationMethod: 'median' }]);
  assert.equal(upload.target, 'filesystem', 'reports stay in the private workflow artifact, never temporary public storage');
  assert.equal(collect.startServerReadyPattern, READY_MESSAGE);
  assert.match(collect.startServerCommand, /^node ".*tests\/lighthouse\/serve\.mjs"$/);
});

test('the server command that Lighthouse CI starts announces readiness and serves pages', async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./serve.mjs', import.meta.url))], { env: { ...process.env, LIGHTHOUSE_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGTERM'));
  const base = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; const match = new RegExp(`${READY_MESSAGE} (http://127\\.0\\.0\\.1:\\d+)`).exec(out); if (match) resolve(match[1]); });
    child.on('exit', code => reject(new Error(`server exited ${code}`)));
  });
  assert.equal((await call(base, '/book')).status, 200);
  assert.equal((await call(base, '/api/business-hub', { method: 'POST' })).status, 405);
});

test('the workflow keeps reports private, pins Lighthouse CI and gates enforcement on the repo variable', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/egc-lighthouse.yml'), 'utf8');
  assert.doesNotMatch(workflow, /temporary-public-storage/);
  assert.match(workflow, /@lhci\/cli@0\.15\.1/);
  assert.match(workflow, /npm install --prefix \/tmp\/egc-lighthouse-tools --no-save --no-package-lock --ignore-scripts [^\n]*@lhci\/cli@0\.15\.1\n/);
  for (const line of workflow.split('\n').filter(line => /\b(?:npm|pnpm) (?:install|i|ci)\b/.test(line))) assert.match(line, /--ignore-scripts/, line);
  assert.match(workflow, /vars\.LIGHTHOUSE_ENFORCE/);
  assert.match(workflow, /LIGHTHOUSE_ENFORCE" = "true"/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /permissions:\n {2}contents: read/);
  assert.doesNotMatch(workflow, /LIGHTHOUSE_REPORT_DIR/, 'reports use the config default under test-results/');
  assert.match(workflow, /path: \|\n\s+test-results\/\n\s+\.lighthouseci\//);
});

test('the workflow runs for every file that changes what Lighthouse measures, and checks the signed-in renders first', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/egc-lighthouse.yml'), 'utf8');
  const lists = [...workflow.matchAll(/^ {4}paths: \[(.*)\]$/gm)].map(match => match[1].split(',').map(item => item.trim().replace(/^'|'$/g, '')));
  assert.equal(lists.length, 2, 'push and pull_request');
  assert.deepEqual(lists[0], lists[1]);
  for (const path of ['images/**', 'styles.css', 'site-enhancements.js', 'analytics-loader.js', '*.html', '*.css', '*.js', 'crew/**', 'employee-field-today.*', 'client-login.*', 'client-login/**', 'functions/client-login*.js', 'functions/client-login/**', '_headers', 'tests/lighthouse/**', 'tests/browser/test_lighthouse_pages_ui.py', '.github/workflows/egc-lighthouse.yml']) assert.ok(lists[0].includes(path), path);
  const render = workflow.indexOf('python tests/browser/test_lighthouse_pages_ui.py'), collect = workflow.indexOf('lhci collect'), chrome = workflow.indexOf('CHROME_PATH=$chrome');
  assert.ok(chrome > 0 && render > chrome && collect > render, 'the render check uses the runner Chrome and runs before collect');
  assert.match(workflow, /PLAYWRIGHT_CHROMIUM_EXECUTABLE="\$CHROME_PATH" python tests\/browser\/test_lighthouse_pages_ui\.py/);
  assert.match(workflow, /pip install playwright==1\.57\.0/);
  assert.doesNotMatch(workflow, /playwright install/, 'the runner Chrome is used; no browser download');
  assert.ok(existsSync(join(ROOT, 'tests/browser/test_lighthouse_pages_ui.py')));
});
