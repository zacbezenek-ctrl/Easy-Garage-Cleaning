import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { issueMcpGrant, mcpGrantConfiguration, mcpGrantReceiptId, MCP_GRANT_COLLECTION } from '../functions/_lib/mcp-grant-assertion.js';
import { mcpGrantHandlers } from '../functions/api/mcp-grant.js';
import { onRequest as middleware } from '../functions/_middleware.js';
import { MCP_GRANT, mcpGrantLabel, servicePublicKeySet, signServiceAssertion, signServiceRequest, verifyMcpGrant, verifyServiceAssertion, verifyServiceRequest } from '../egc-platform/services/operations/src/service-auth.ts';

const NOW = '2026-09-22T12:00:00.000Z', NOW_MS = Date.parse(NOW);
const HUB = 'https://easygaragecleaning.com', MCP = 'https://egc-mcp.example.invalid';
const env = {
  HUB_SESSION_SECRET: 'synthetic-mcp-grant-hub-session-root-0123456789', EGC_MCP_PUBLIC_ORIGIN: MCP,
  HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'test', role: 'owner' }, TylerG: { passwordHash: 'test', role: 'manager' }, Crew: { passwordHash: 'test', role: 'crew' }, Casey: { passwordHash: 'test', role: 'manager' }, AlexK: { passwordHash: 'test', role: 'owner' } }),
};
const cookie = async user => (await createHubSessionCookie(env, user)).split(';')[0];
const owner = await cookie('ZacB'), manager = await cookie('TylerG'), crew = await cookie('Crew'), outsider = await cookie('Casey'), secondOwner = await cookie('AlexK');
const hubKey = (await servicePublicKeySet({ service: 'hub', rootSecret: env.HUB_SESSION_SECRET, workspace: 'egc' })).keys[0];
const resolveKey = async (service, workspace, kid) => { assert.equal(service, 'hub'); assert.equal(workspace, 'egc'); assert.equal(kid, hubKey.kid); return hubKey; };
const grantNonce = () => randomBytes(32).toString('base64url');
const payloadOf = token => JSON.parse(Buffer.from(token.split('.')[0], 'base64url'));
const assertionIn = body => body.match(/name="assertion" value="([^"]+)"/)?.[1];

function memoryStore({ outage = false } = {}) {
  const rows = new Map(), commits = [];
  let revision = 0;
  return { rows, commits, async commit(writes) {
    commits.push(structuredClone(writes));
    if (outage) throw Object.assign(new Error('synthetic private storage detail'), { code: 'dispatch_outcome_unknown', status: 503 });
    const keys = writes.map(write => `${write.collection}/${write.id}`);
    assert.equal(new Set(keys).size, keys.length, 'one write per document per commit');
    for (const [index, write] of writes.entries()) if (write.revision ? rows.get(keys[index])?.revision !== write.revision : rows.has(keys[index])) throw Object.assign(new Error('conflict'), { code: 'dispatch_revision_conflict', status: 409 });
    writes.forEach((write, index) => rows.set(keys[index], { ...structuredClone(write.patch), revision: `r${++revision}` }));
    return {};
  } };
}
const handlers = (store, now = NOW) => mcpGrantHandlers({ storage: () => store, now: () => new Date(now) });
function approve(fields, { session, origin = HUB, site = 'same-origin', type = 'application/x-www-form-urlencoded', body } = {}) {
  const headers = { 'Content-Type': type };
  if (origin) headers.Origin = origin;
  if (site) headers['Sec-Fetch-Site'] = site;
  if (session) headers.Cookie = session;
  return new Request(`${HUB}/api/mcp-grant`, { method: 'POST', headers, body: body ?? new URLSearchParams(fields).toString() });
}

test('configuration requires a bare MCP origin and the existing signed service keys', () => {
  assert.equal(mcpGrantConfiguration(env).configured, true);
  assert.equal(mcpGrantConfiguration({ ...env, EGC_MCP_PUBLIC_ORIGIN: 'http://127.0.0.1:4200' }).configured, true);
  for (const change of [{ EGC_MCP_PUBLIC_ORIGIN: '' }, { EGC_MCP_PUBLIC_ORIGIN: `${MCP}/mcp` }, { EGC_MCP_PUBLIC_ORIGIN: 'http://egc-mcp.example.invalid' }, { EGC_MCP_PUBLIC_ORIGIN: 'https://user:pass@egc-mcp.example.invalid' }, { EGC_OPERATIONS_SERVICE_AUTH: 'legacy' }, { EGC_OPERATIONS_ENABLED: 'false' }, { HUB_SESSION_SECRET: 'short' }])
    assert.equal(mcpGrantConfiguration({ ...env, ...change }).configured, false, JSON.stringify(change));
});

test('the approval page is a same-origin form that escapes the self-declared client name and keeps its referrer same-origin', async () => {
  const grant = grantNonce(), page = handlers(memoryStore());
  const url = new URL(`${HUB}/api/mcp-grant`);
  url.search = new URLSearchParams({ grant, client: '<img src=x onerror=alert(1)> Claude (claude.ai)', scope: 'egc:read egc:write' }).toString();
  const response = await page.get({ request: new Request(url, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), env });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(response.headers.get('Content-Security-Policy'), /form-action 'self'/);
  assert.doesNotMatch(response.headers.get('Content-Security-Policy'), /script-src/);
  // Under no-referrer a browser sends the approval POST with `Origin: null`; same-origin keeps the real Origin and still sends nothing cross-origin.
  assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(response.headers.get('X-Frame-Options'), 'DENY'); assert.equal(response.headers.get('Referrer-Policy'), 'same-origin');
  assert.match(body, /<meta name="referrer" content="same-origin">/); assert.doesNotMatch(body, /content="no-referrer"/);
  assert.ok(!body.includes('<img'), 'client text is escaped'); assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt; Claude/);
  // The link's client name is anyone's text, so it is shown only as an unverified label, never as the subject of the sentence.
  assert.match(body, /<p>An AI assistant wants to connect to Easy Garage Cleaning as you\.<\/p>/);
  assert.match(body, /Name in this approval link \(not verified by the Hub\): <strong>&lt;img src=x onerror=alert\(1\)&gt; Claude \(claude\.ai\)<\/strong>/);
  assert.match(body, /<form method="post" action="\/api\/mcp-grant">/); assert.match(body, new RegExp(`name="grant" value="${grant}"`));
  assert.match(body, /egc-mcp\.example\.invalid/); assert.match(body, /changes listed on the connector page/); assert.match(body, /<a href="\/employee" target="_blank" rel="noopener noreferrer">/); assert.match(body, /min-height:48px/);
  const invalid = await page.get({ request: new Request(`${HUB}/api/mcp-grant?grant=short`), env });
  assert.equal(invalid.status, 400); assert.equal(invalid.headers.get('Referrer-Policy'), 'no-referrer'); assert.match(await invalid.text(), /<meta name="referrer" content="no-referrer">/);
  assert.equal((await page.get({ request: new Request(`${HUB}/api/mcp-grant?grant=${grant}`), env: { ...env, EGC_MCP_PUBLIC_ORIGIN: '' } })).status, 503);
});

test('approval requires a same-origin form post from a signed-in business owner or manager', async () => {
  const store = memoryStore(), page = handlers(store), grant = grantNonce();
  const refused = [
    [approve({ grant }, { session: owner, site: 'cross-site' }), 403],
    [approve({ grant }, { session: owner, site: 'same-site' }), 403],
    [approve({ grant }, { session: owner, origin: null }), 403],
    [approve({ grant }, { session: owner, origin: 'https://evil.example' }), 403],
    [approve({ grant }, { session: owner, origin: 'null', site: 'cross-site' }), 403],
    [approve({ grant }, { session: owner, origin: 'null', site: 'same-site' }), 403],
    [approve({ grant }, { session: owner, origin: 'null', site: null }), 403],
    [approve({ grant }, { session: owner, origin: 'https://evil.example', site: null }), 403],
    [approve({ grant }, { session: owner, type: 'application/json', body: JSON.stringify({ grant }) }), 415],
    [approve({ grant }, { session: owner, body: `grant=${grant}&pad=${'x'.repeat(5000)}` }), 413],
    [approve({ grant }), 401],
    [approve({ grant }, { session: crew }), 403],
    [approve({ grant }, { session: outsider }), 403],
    [approve({ grant: 'not-a-grant' }, { session: owner }), 400],
  ];
  for (const [request, status] of refused) {
    const response = await page.post({ request, env });
    assert.equal(response.status, status, `${request.headers.get('Sec-Fetch-Site')} ${request.headers.get('Origin')} ${status}`);
    assert.equal(assertionIn(await response.text()), undefined);
  }
  assert.equal(store.commits.length, 0, 'no refused request claims the grant');
  const signIn = await page.post({ request: approve({ grant, client: 'Claude (claude.ai)', scope: 'egc:read egc:write' }), env });
  const again = await signIn.text();
  assert.match(again, /Sign in to the Employee Hub in this browser/); assert.match(again, /<form method="post" action="\/api\/mcp-grant">/);
  for (const session of [owner, manager]) {
    const response = await page.post({ request: approve({ grant: grantNonce() }, { session }), env });
    assert.equal(response.status, 200);
    assert.ok(assertionIn(await response.text()));
  }
  // A browser that sends no Origin detail (`null`) is accepted only when it marks the request same-origin itself; so is one without Sec-Fetch-Site that sends the exact Origin.
  for (const headers of [{ origin: 'null', site: 'same-origin' }, { origin: HUB, site: null }]) {
    const response = await page.post({ request: approve({ grant: grantNonce() }, { session: owner, ...headers }), env });
    assert.equal(response.status, 200, JSON.stringify(headers)); assert.ok(assertionIn(await response.text()));
  }
});

test('the assertion names the approving user, binds audience, MCP and nonce, and expires after 60 seconds', async () => {
  const store = memoryStore(), grant = grantNonce();
  const response = await handlers(store).post({ request: approve({ grant, client: 'ChatGPT (chatgpt.com)', scope: 'egc:read egc:write offline_access' }, { session: manager }), env });
  const assertion = assertionIn(await response.text());
  const claims = await verifyMcpGrant(assertion, { resource: MCP, now: NOW_MS, resolveKey });
  assert.deepEqual(claims, { hubUser: 'tylerg', role: 'manager', businessAccess: true, grantNonce: grant, resource: MCP, scope: 'egc:read egc:write', client: 'ChatGPT (chatgpt.com)' });
  const signed = payloadOf(assertion);
  assert.equal(signed.aud, 'egc-mcp'); assert.equal(signed.typ, 'egc-mcp-grant'); assert.equal(signed.iss, HUB); assert.equal(signed.exp - signed.iat, 60);
  assert.equal(signed.iat, NOW_MS / 1000); assert.equal(MCP_GRANT.ttlSeconds, 60);
  assert.ok(await verifyMcpGrant(assertion, { resource: MCP, now: NOW_MS + 59_000, resolveKey }));
  await assert.rejects(verifyMcpGrant(assertion, { resource: MCP, now: NOW_MS + 60_000, resolveKey }), { code: 'service_assertion_expired' });
  await assert.rejects(verifyMcpGrant(assertion, { resource: 'https://other-mcp.example.invalid', now: NOW_MS, resolveKey }), { code: 'invalid_mcp_grant' });
  // Proof of what the Hub once signed never skips the signature check.
  assert.equal((await verifyMcpGrant(assertion, { now: NOW_MS + 86_400_000, resolveKey, allowExpired: true })).hubUser, 'tylerg');
  const otherKey = (await servicePublicKeySet({ service: 'hub', rootSecret: `${env.HUB_SESSION_SECRET}-rotated`, workspace: 'egc' })).keys[0];
  await assert.rejects(verifyMcpGrant(assertion, { resource: MCP, now: NOW_MS, resolveKey: async () => ({ ...otherKey, kid: hubKey.kid }) }), { code: 'invalid_service_assertion' });
  const tampered = Buffer.from(JSON.stringify({ ...signed, claims: { ...signed.claims, role: 'owner' } })).toString('base64url') + '.' + assertion.split('.')[1];
  await assert.rejects(verifyMcpGrant(tampered, { resource: MCP, now: NOW_MS, resolveKey }), { code: 'invalid_service_assertion' });
  const wrongAudience = await signServiceAssertion({ service: 'hub', rootSecret: env.HUB_SESSION_SECRET, workspace: 'egc', typ: MCP_GRANT.typ, aud: 'egc-other', ttlSeconds: 60, claims: signed.claims, now: NOW_MS });
  await assert.rejects(verifyMcpGrant(wrongAudience, { resource: MCP, now: NOW_MS, resolveKey }), { code: 'invalid_service_assertion' });
});

test('assertions and service requests signed by the same key can never stand in for each other', async () => {
  const assertion = await signServiceAssertion({ service: 'hub', rootSecret: env.HUB_SESSION_SECRET, workspace: 'egc', ...MCP_GRANT, claims: { hubUser: 'zacb', role: 'owner', businessAccess: true, grantNonce: grantNonce(), resource: MCP, scope: 'egc:read', client: 'Claude (claude.ai)' }, now: NOW_MS });
  const request = await signServiceRequest({ service: 'hub', rootSecret: env.HUB_SESSION_SECRET, workspace: 'egc', path: '/operations/rpc', actor: { id: 'zacb', kind: 'human', role: 'owner', workspace: 'egc' }, request: { requestId: '3f6c1c2e-8a4b-4d7e-9f10-2b3c4d5e6f70', body: { command: 'status' } }, now: NOW_MS });
  await assert.rejects(verifyServiceRequest(assertion, { service: 'api', workspace: 'egc', path: '/operations/rpc', now: NOW_MS, resolveKey, consumeNonce: async () => true }));
  await assert.rejects(verifyServiceAssertion(request, { issuer: 'hub', workspace: 'egc', ...MCP_GRANT, now: NOW_MS, resolveKey }));
  // Re-labelling a request payload as an assertion still fails: the signed bytes differ by protocol prefix.
  const relabelled = Buffer.from(JSON.stringify({ v: 1, alg: 'EdDSA', typ: MCP_GRANT.typ, kid: hubKey.kid, iss: HUB, aud: MCP_GRANT.aud, workspace: 'egc', iat: NOW_MS / 1000, exp: NOW_MS / 1000 + 60, claims: {} })).toString('base64url') + '.' + request.split('.')[1];
  await assert.rejects(verifyServiceAssertion(relabelled, { issuer: 'hub', workspace: 'egc', ...MCP_GRANT, now: NOW_MS, resolveKey }), { code: 'invalid_service_assertion' });
  await assert.rejects(signServiceAssertion({ service: 'hub', rootSecret: env.HUB_SESSION_SECRET, workspace: 'egc', typ: MCP_GRANT.typ, aud: MCP_GRANT.aud, ttlSeconds: 3600, claims: {} }), { code: 'invalid_service_assertion' });
});

test('the assertion signs exactly the client label and access the approval page showed', async () => {
  const unescape = text => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[name]));
  const fieldsOf = body => Object.fromEntries([...body.matchAll(/<input type="hidden" name="([a-z]+)" value="([^"]*)">/g)].map(([, name, value]) => [name, unescape(value)]));
  const page = handlers(memoryStore());
  for (const [client, scope, write] of [['  Claude\u202e\u0000  (claude.ai) ', 'egc:read offline_access', false], ['ChatGPT (chatgpt.com)', 'egc:read egc:write', true], [`"Quoted" <Tool> & ${'x'.repeat(200)}`, 'egc:write', true], ['', '', false]]) {
    const url = new URL(`${HUB}/api/mcp-grant`), grant = grantNonce();
    url.search = new URLSearchParams({ grant, client, scope }).toString();
    const body = await (await page.get({ request: new Request(url), env })).text();
    const shown = mcpGrantLabel(client);
    assert.equal(body.includes('make the changes listed on the connector page'), write, client);
    if (shown) assert.ok(body.includes(`(not verified by the Hub): <strong>${shown.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</strong>`), client);
    else assert.ok(!body.includes('<strong>') && !body.includes('not verified by the Hub'), 'no label line without a client name');
    const fields = fieldsOf(body);
    assert.deepEqual(fields, { grant, client: shown, scope: write ? 'egc:read egc:write' : 'egc:read' });
    const response = await page.post({ request: approve(fields, { session: owner }), env });
    const claims = await verifyMcpGrant(assertionIn(await response.text()), { resource: MCP, now: NOW_MS, resolveKey });
    assert.deepEqual({ client: claims.client, scope: claims.scope }, { client: shown, scope: fields.scope }, client);
  }
  // The library signs only the two access levels the page can show.
  for (const scope of ['egc:write', 'egc:read egc:write offline_access', 'admin'])
    await assert.rejects(issueMcpGrant(env, memoryStore(), { user: 'zacb', role: 'owner', businessAccess: true }, { grant: grantNonce(), scope }, NOW), { code: 'mcp_grant_invalid' }, scope);
});

test('each grant nonce is approved once, by one user, with its audit entry in the same create-only commit', async () => {
  const store = memoryStore(), page = handlers(store), grant = grantNonce();
  const first = await page.post({ request: approve({ grant, client: 'Claude (claude.ai)' }, { session: owner }), env });
  assert.equal(first.status, 200);
  assert.equal(store.commits.length, 1);
  const [receipt, audit] = store.commits[0];
  assert.equal(receipt.collection, MCP_GRANT_COLLECTION); assert.equal(receipt.id, await mcpGrantReceiptId(grant)); assert.equal(receipt.revision, undefined, 'create-only');
  assert.deepEqual(receipt.patch, { hubUser: 'zacb', role: 'owner', mcp: MCP, approvedAt: NOW, expiresAt: '2026-09-22T12:01:00.000Z' });
  assert.equal(audit.collection, 'hub_audit'); assert.equal(audit.revision, undefined); assert.equal(audit.patch.action, 'mcp.grant.approve'); assert.deepEqual(audit.patch.actor, { id: 'zacb', kind: 'human', role: 'owner' });
  assert.deepEqual(JSON.parse(audit.patch.after), { mcp: MCP, role: 'owner', scope: 'egc:read', client: 'Claude (claude.ai)' });
  const stored = JSON.stringify([...store.rows.values()]);
  assert.ok(!stored.includes(grant), 'the raw nonce is never stored'); assert.ok(!stored.includes(assertionIn(await first.text()).split('.')[1]), 'the assertion is never stored');
  const replay = await page.post({ request: approve({ grant }, { session: manager }), env });
  assert.equal(replay.status, 409); assert.match(await replay.text(), /already approved/);
  assert.equal(store.rows.get(`${MCP_GRANT_COLLECTION}/${receipt.id}`).hubUser, 'zacb');
  const contested = grantNonce();
  const results = await Promise.all([owner, manager].map(session => page.post({ request: approve({ grant: contested }, { session }), env })));
  assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
  const winner = results.find(response => response.status === 200);
  const claims = await verifyMcpGrant(assertionIn(await winner.text()), { resource: MCP, now: NOW_MS, resolveKey });
  assert.equal(store.rows.get(`${MCP_GRANT_COLLECTION}/${await mcpGrantReceiptId(contested)}`).hubUser, claims.hubUser);
});

test('only the Hub owner account delegates as owner; another business user configured as owner delegates as a manager', async () => {
  const store = memoryStore(), page = handlers(store);
  const asOwner = await verifyMcpGrant(assertionIn(await (await page.post({ request: approve({ grant: grantNonce() }, { session: owner }), env })).text()), { resource: MCP, now: NOW_MS, resolveKey });
  const asOther = await verifyMcpGrant(assertionIn(await (await page.post({ request: approve({ grant: grantNonce() }, { session: secondOwner }), env })).text()), { resource: MCP, now: NOW_MS, resolveKey });
  assert.deepEqual([asOwner.hubUser, asOwner.role], ['zacb', 'owner']);
  assert.deepEqual([asOther.hubUser, asOther.role], ['alexk', 'manager']);
  assert.equal(store.commits[1][0].patch.role, 'manager');
  assert.deepEqual(store.commits[1][1].patch.actor, { id: 'alexk', kind: 'human', role: 'owner' }, 'the audit keeps the Hub role that approved');
});

test('a storage failure never issues an assertion or leaks storage detail', async () => {
  const response = await handlers(memoryStore({ outage: true })).post({ request: approve({ grant: grantNonce() }, { session: owner }), env });
  const body = await response.text();
  assert.equal(response.status, 503); assert.equal(assertionIn(body), undefined);
  assert.match(body, /Nothing was connected/); assert.ok(!body.includes('synthetic private storage detail'));
  await assert.rejects(issueMcpGrant(env, memoryStore(), { user: 'zacb', role: 'owner', businessAccess: true }, { grant: grantNonce() }, 'not-a-time'), { code: 'mcp_grant_invalid' });
  await assert.rejects(issueMcpGrant({ ...env, EGC_MCP_PUBLIC_ORIGIN: '' }, memoryStore(), { user: 'zacb', role: 'owner', businessAccess: true }, { grant: grantNonce() }, NOW), { code: 'mcp_grant_not_configured' });
});

test('the relay page posts the assertion only to the configured MCP callback, under its own CSP without form-action', async () => {
  const grant = grantNonce(), response = await handlers(memoryStore()).post({ request: approve({ grant }, { session: owner }), env });
  const copy = response.clone(), body = await response.text(), csp = response.headers.get('Content-Security-Policy');
  const nonce = csp.match(/script-src 'nonce-([^']+)'/)?.[1];
  assert.ok(nonce); assert.match(body, new RegExp(`<script nonce="${nonce.replace(/[+/=]/g, '\\$&')}">document\\.forms\\[0\\]\\.submit\\(\\)</script>`));
  // The MCP callback redirects on to the AI client's own callback, and browsers apply form-action to that redirect.
  assert.doesNotMatch(csp, /form-action/); assert.match(csp, /^default-src 'none'; script-src 'nonce-/); assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /base-uri 'none'/); assert.doesNotMatch(csp, /unsafe-eval|'self' 'unsafe-inline' https/);
  assert.match(body, new RegExp(`<form method="post" action="${MCP}/oauth/hub-callback">`)); assert.match(body, new RegExp(`name="grant" value="${grant}"`));
  assert.match(body, /<noscript><button type="submit">Finish connecting<\/button><\/noscript>/);
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  const relayed = await middleware({ request: new Request(`${HUB}/api/mcp-grant`, { method: 'POST' }), env: {}, next: async () => copy });
  assert.equal(relayed.headers.get('Content-Security-Policy'), csp, 'the site-wide CSP (form-action self) must not replace the relay policy');
  assert.equal(relayed.headers.get('X-Frame-Options'), 'DENY'); assert.equal(relayed.headers.get('Referrer-Policy'), 'no-referrer'); assert.equal(relayed.headers.get('Cache-Control'), 'no-store');
  // Through the middleware the approval page keeps same-origin; nothing else on these relay routes can ask for it.
  const approvalPage = await handlers(memoryStore()).get({ request: new Request(`${HUB}/api/mcp-grant?grant=${grantNonce()}`), env });
  const served = await middleware({ request: new Request(`${HUB}/api/mcp-grant`), env: {}, next: async () => approvalPage });
  assert.equal(served.headers.get('Referrer-Policy'), 'same-origin'); assert.match(served.headers.get('Content-Security-Policy'), /form-action 'self'/); assert.equal(served.headers.get('X-Frame-Options'), 'DENY');
  for (const [path, policy] of [['/api/mcp-grant', 'unsafe-url'], ['/api/mcp-grant', null], ['/api/gusto-auth', 'same-origin']]) {
    const upstream = new Response('', { headers: policy ? { 'Referrer-Policy': policy } : {} });
    assert.equal((await middleware({ request: new Request(HUB + path), env: {}, next: async () => upstream })).headers.get('Referrer-Policy'), 'no-referrer', `${path} ${policy}`);
  }
  const other = await middleware({ request: new Request(`${HUB}/api/dispatch`), env: {}, next: async () => new Response('{}', { headers: { 'Content-Security-Policy': "form-action https://evil.example" } }) });
  assert.match(other.headers.get('Content-Security-Policy'), /form-action 'self' https:\/\/api\.web3forms\.com/, 'other routes cannot opt out of the site CSP');
});

test('Hub grant receipts are declared server-only in firestore.rules', () => {
  // Pinned security invariant; tests/firestore-emulator.test.mjs proves it against real rules.
  assert.match(readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), /match \/mcp_grant_nonces\/\{documentId\} \{\s*allow read, write: if false;\s*\}/);
});
