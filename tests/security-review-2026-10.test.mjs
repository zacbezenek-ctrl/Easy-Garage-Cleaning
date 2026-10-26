// Regression tests for the confirmed high findings in docs/security-review-2026-10.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { generateKeyPairSync } from 'node:crypto';
import { hashHubCredential } from '../functions/_lib/hub-session.js';
import { STAFF_SIGN_IN_LIMITS } from '../functions/_lib/staff-sign-in-limit.js';
import { onRequestPost as hubAuthPost } from '../functions/api/hub-auth.js';
import { firestoreMemory } from './helpers/firestore-memory.mjs';

const origin = 'https://easygaragecleaning.com';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account = { type: 'service_account', project_id: 'egcw-1ec83', client_email: 'synthetic-limit@egcw-1ec83.iam.gserviceaccount.com', private_key: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }) };
const env = {
  HUB_SESSION_SECRET: 'synthetic-session-secret-for-sign-in-limit-tests',
  FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(account),
  HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: await hashHubCredential('ZacB', 'correct horse battery'), role: 'owner' } }),
};

function useFirestore(t) {
  const memory = firestoreMemory({ fallback: async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'synthetic-access-token', expires_in: 3600 });
    throw new Error('External network refused: ' + url.hostname);
  } });
  t.mock.method(globalThis, 'fetch', memory.fetch);
  return memory;
}
const signIn = (password, { ip = '198.51.100.7', username = 'ZacB' } = {}) => hubAuthPost({ env, request: new Request(`${origin}/api/hub-auth`, {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify({ username, password }),
}) });

test('S-01: staff sign-in refuses an address after 10 failed guesses, even with the right password', async t => {
  const memory = useFirestore(t);
  for (let guess = 0; guess < STAFF_SIGN_IN_LIMITS.ip.limit; guess += 1) assert.equal((await signIn(`wrong guess ${guess}`)).status, 401);
  const blocked = await signIn('correct horse battery');
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).code, 'HUB_AUTH_RATE_LIMITED');
  assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
  assert.equal(blocked.headers.get('Set-Cookie'), null, 'a refused attempt never issues a session');
  const counters = [...memory.documents.keys()].filter(key => key.startsWith('rate_limits/'));
  assert.ok(counters.length >= 1 && counters.every(key => !JSON.stringify(memory.documents.get(key)).includes('198.51.100.7')), 'counters hold no raw address');
  // Another address still signs in.
  assert.equal((await signIn('correct horse battery', { ip: '203.0.113.9' })).status, 200);
});

test('S-01: a username is limited across addresses, and a successful sign-in uses no attempts', async t => {
  useFirestore(t);
  for (let ok = 0; ok < 12; ok += 1) assert.equal((await signIn('correct horse battery')).status, 200, 'successes give their attempts back');
  for (let guess = 0; guess < STAFF_SIGN_IN_LIMITS.username.limit; guess += 1) {
    assert.equal((await signIn(`wrong ${guess}`, { ip: `192.0.2.${guess + 1}` })).status, 401);
  }
  assert.equal((await signIn('correct horse battery', { ip: '203.0.113.50', username: 'zacb' })).status, 429, 'username casing does not reset the count');
});

test('S-01: a counter store outage refuses sign-in instead of allowing unlimited guesses', async t => {
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic-access-token', expires_in: 3600 });
    return Response.json({ error: { status: 'UNAVAILABLE' } }, { status: 503 });
  });
  const response = await signIn('correct horse battery');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'HUB_AUTH_LIMIT_UNAVAILABLE');
  assert.equal(response.headers.get('Set-Cookie'), null);
});

// S-02: the legacy Customers renderers in employee.html, run on a customer whose address came from a Knock sale city.
function hubFunctions(names) {
  const html = readFileSync(new URL('../employee.html', import.meta.url), 'utf8');
  return names.map(name => {
    const start = html.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    let depth = 0, index = html.indexOf('{', start);
    for (; index < html.length; index += 1) { if (html[index] === '{') depth += 1; else if (html[index] === '}' && --depth === 0) break; }
    return html.slice(start, index + 1);
  }).join('\n');
}
const PAYLOAD = '<img src=x onerror=alert(1)>';
const hostile = { id: 'customer_1', name: `${PAYLOAD} Doe`, phone: `+1970555${PAYLOAD}0100`, email: `${PAYLOAD}@a.co`, address: `12 Main St, ${PAYLOAD}, CO 80525` };
function render(source, call, globals = {}) {
  const nodes = {};
  const element = () => ({ innerHTML: '', className: '', classList: { remove() {}, contains: () => false }, appendChild(child) { this.innerHTML += child.innerHTML; } });
  const context = vm.createContext({
    document: { getElementById: id => (nodes[id] ||= element()), createElement: element },
    loadCustomers: () => [hostile], custsCache: [hostile], bk: { customer: null }, ...globals,
  });
  vm.runInContext(`${source}\n${call}`, context);
  return Object.values(nodes).map(node => node.innerHTML).join('');
}

test('S-02: customer phone, email, address and initials are escaped in every legacy Hub customer list', () => {
  const base = hubFunctions(['esc', 'initials', 'avatarBg']);
  const outputs = [
    render(`${base}\n${hubFunctions(['renderCustomersTab'])}`, 'renderCustomersTab()'),
    render(`${base}\n${hubFunctions(['renderCustList'])}`, "renderCustList('')", { leadsCache: [] }),
  ];
  for (const html of outputs) {
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the payload is shown as text');
    assert.doesNotMatch(html, /<img/i, 'no attacker element reaches innerHTML');
  }
  const source = readFileSync(new URL('../employee.html', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\[c\.phone,c\.email(?:,c\.address)?\]\.filter\(Boolean\)\.join/, 'no contact list joins unescaped values');
});

// C-01: the legacy single-SHA-256 credential format (hashes in it are in the public history) never signs anyone in.
test('C-01: a configured account stored in the legacy hash format is refused with the right password and the wrong one alike', async () => {
  const { createHash } = await import('node:crypto');
  const { authenticateHubCredential, hashHubCredential: currentHash } = await import('../functions/_lib/hub-session.js');
  const legacy = createHash('sha256').update('ZacB:synthetic legacy password:egc-salt-2026').digest('hex');
  const legacyEnv = { HUB_SESSION_SECRET: 'synthetic-session-secret-for-legacy-hash-tests', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: legacy, role: 'owner' } }) };
  for (const password of ['synthetic legacy password', 'a wrong guess']) {
    await assert.rejects(authenticateHubCredential(legacyEnv, 'ZacB', password), { code: 'HUB_AUTH_PASSWORD_RESET_REQUIRED', status: 403 });
  }
  const response = await hubAuthPost({ env: legacyEnv, request: new Request(`${origin}/api/hub-auth`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ZacB', password: 'synthetic legacy password' }) }) });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'HUB_AUTH_PASSWORD_RESET_REQUIRED');
  assert.equal(response.headers.get('Set-Cookie'), null, 'no session is issued');
  // The current salted format still signs in, and the helper only ever produces it.
  const current = await currentHash('ZacB', 'synthetic current password');
  assert.match(current, /^pbkdf2-sha256\$100000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  const currentEnv = { ...legacyEnv, HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: current, role: 'owner' } }) };
  assert.equal((await authenticateHubCredential(currentEnv, 'ZacB', 'synthetic current password')).user, 'ZacB');
  assert.equal(await authenticateHubCredential(currentEnv, 'ZacB', 'a wrong guess'), null);
});
