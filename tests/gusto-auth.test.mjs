import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { readGustoRecord, writeGustoRecord } from '../functions/_lib/gusto-store.js';
import { gustoConfiguration, gustoStatus, gustoRequest, gustoList } from '../functions/_lib/gusto-client.js';
import { onRequestGet, onRequestPost } from '../functions/api/gusto-auth.js';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const EMPLOYEE = '22222222-2222-4222-8222-222222222222';
const endpoint = 'https://easygaragecleaning.com/api/gusto-auth';
const env = {
  GUSTO_ENVIRONMENT: 'demo', GUSTO_COMPANY_UUID: COMPANY, GUSTO_CLIENT_ID: 'synthetic-client-id', GUSTO_CLIENT_SECRET: 'synthetic-client-secret', GUSTO_REDIRECT_URI: endpoint,
  FIREBASE_API_KEY: 'firebase-test-gusto-auth', EMPLOYEE_HUB_DATA_SECRET: 'synthetic-gusto-vault-secret', HUB_SESSION_SECRET: 'synthetic-gusto-session-secret',
  HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'test', role: 'owner' }, TylerG: { passwordHash: 'test', role: 'manager' }, Crew: { passwordHash: 'test', role: 'crew' } }),
};
const ownerCookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
const managerCookie = (await createHubSessionCookie(env, 'TylerG')).split(';')[0];

function fixture(t) {
  const docs = new Map(), calls = [], patches = [];
  let revision = 0;
  const context = { docs, calls, patches, handler: async url => {
    if (url.pathname === '/oauth/token') return Response.json({ access_token: 'synthetic-new-access', refresh_token: 'synthetic-new-refresh', token_type: 'bearer', expires_in: 7200 });
    if (url.pathname === '/v1/token_info') return Response.json({ resource: { type: 'Company', uuid: COMPANY }, resource_owner: { type: 'CompanyAdmin', uuid: EMPLOYEE } });
    return Response.json([]);
  } };
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    if (url.hostname === 'firestore.googleapis.com') {
      assert.ok(url.pathname.includes('/documents/gusto_integrations/'), 'tokens and ledgers never go in browser-writable jobs');
      const id = url.pathname.split('/').pop();
      if (method === 'PATCH') {
        const expected = url.searchParams.get('currentDocument.updateTime'), absent = url.searchParams.get('currentDocument.exists');
        patches.push({ id, expected, absent, body: JSON.parse(options.body) });
        if ((absent === 'false' && docs.has(id)) || (expected && docs.get(id)?.updateTime !== expected)) return Response.json({ error: { status: 'FAILED_PRECONDITION', message: 'synthetic-secret-not-for-client' } }, { status: 412 });
        assert.ok(absent === 'false' || expected, 'every write uses CAS');
        docs.set(id, { ...JSON.parse(options.body), updateTime: `2026-09-09T12:00:00.${String(++revision).padStart(9, '0')}Z` });
      }
      return docs.has(id) ? Response.json(docs.get(id)) : Response.json({}, { status: 404 });
    }
    assert.ok(['api.gusto-demo.com', 'api.gusto.com'].includes(url.hostname), 'all transport is mocked and fixed to Gusto');
    calls.push({ url: url.href, method, options });
    assert.equal(new Headers(options.headers).get('X-Gusto-API-Version'), '2026-06-15');
    return context.handler(url, options);
  });
  return context;
}
const tokens = (overrides = {}) => ({ state: 'connected', accessToken: 'synthetic-old-access', refreshToken: 'synthetic-old-refresh', expiresAt: Date.now() + 7200000, connectedAt: '2026-09-09T00:00:00Z', ...overrides });
const seed = (value = tokens()) => writeGustoRecord(env, 'oauth-tokens', value, null);
const employeePath = `/v1/companies/${COMPANY}/employees`;
function ownerRequest(url = endpoint, cookie = ownerCookie) { return new Request(url, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' } }); }
async function start() {
  const response = await onRequestGet({ env, request: ownerRequest() });
  assert.equal(response.status, 302);
  const auth = new URL(response.headers.get('Location'));
  return { response, auth, state: auth.searchParams.get('state'), cookie: response.headers.get('Set-Cookie').split(';')[0] };
}
function finish(started, extra = {}) {
  const { code = 'synthetic-authorization-code', state = started.state, cookie = `${ownerCookie}; ${started.cookie}`, origin = 'https://easygaragecleaning.com' } = extra;
  return onRequestPost({ env, request: new Request(endpoint, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, state }) }) });
}

test('Gusto is off without explicit complete configuration and production approval', () => {
  assert.equal(gustoConfiguration(env).configured, true);
  for (const change of [ { GUSTO_ENVIRONMENT: '' }, { GUSTO_ENVIRONMENT: 'production' }, { GUSTO_COMPANY_UUID: 'bad' }, { GUSTO_CLIENT_SECRET: '' }, { GUSTO_REDIRECT_URI: 'https://evil.example/api/gusto-auth' }, { GUSTO_REDIRECT_URI: 'https://easygaragecleaning.com/api/gusto-auth?extra=1' }, { EMPLOYEE_HUB_LEGACY_KEY_SOURCE: 'HIGHLEVEL_API_KEY' } ]) assert.equal(gustoConfiguration({ ...env, ...change }).configured, false);
  assert.equal(gustoConfiguration({ ...env, GUSTO_ENVIRONMENT: 'production', GUSTO_PRODUCTION_APPROVED: 'true' }).configured, true);
  assert.equal(gustoConfiguration({ ...env, GUSTO_REDIRECT_URI: 'http://localhost:8788/api/gusto-auth' }).configured, true);
  assert.equal(gustoConfiguration({ ...env, GUSTO_ENVIRONMENT: 'production', GUSTO_PRODUCTION_APPROVED: 'true', GUSTO_REDIRECT_URI: 'http://localhost:8788/api/gusto-auth' }).configured, false);
});

test('encrypted server-only records use stable namespace IDs, authenticated data and CAS', async t => {
  const store = fixture(t);
  const initial = await readGustoRecord(env, 'employee-map');
  assert.equal(initial.data, null);
  const saved = await writeGustoRecord(env, 'employee-map', { secret: 'synthetic-private-value' }, initial);
  assert.equal((await readGustoRecord(env, 'employee-map')).data.secret, 'synthetic-private-value');
  assert.ok(!JSON.stringify([...store.docs]).includes('synthetic-private-value'));
  assert.match(saved.id, /^gusto_sync_v1_[a-f0-9]{64}$/);
  assert.notEqual((await readGustoRecord({ ...env, GUSTO_ENVIRONMENT: 'production' }, 'employee-map')).id, saved.id);
  await assert.rejects(writeGustoRecord(env, 'employee-map', { replacement: true }, initial), { code: 'GUSTO_WRITE_CONFLICT' });
  const newer = await writeGustoRecord(env, 'employee-map', { updated: true }, saved);
  await assert.rejects(writeGustoRecord(env, 'employee-map', { stale: true }, saved), { code: 'GUSTO_WRITE_CONFLICT' });
  await assert.rejects(writeGustoRecord(env, 'employee-map', { invalid: true }), { code: 'GUSTO_STORAGE_INVALID' });
  await assert.rejects(writeGustoRecord(env, 'another-key', { invalid: true }, newer), { code: 'GUSTO_STORAGE_INVALID' });
});

test('storage key rotation cannot silently replace unreadable existing credentials', async t => {
  const store = fixture(t), saved = await seed(), count = store.patches.length;
  const rotated = { ...env, EMPLOYEE_HUB_DATA_SECRET: 'synthetic-rotated-key' };
  await assert.rejects(readGustoRecord(rotated, 'oauth-tokens'), { code: 'GUSTO_STORAGE_UNREADABLE' });
  await assert.rejects(writeGustoRecord(rotated, 'oauth-tokens', tokens(), saved), { code: 'GUSTO_STORAGE_UNREADABLE' });
  await assert.rejects(writeGustoRecord(rotated, 'oauth-tokens', tokens(), null), { code: 'GUSTO_WRITE_CONFLICT' });
  assert.equal(store.docs.size, 1);
  assert.equal(store.patches.length, count + 1);
  assert.equal((await readGustoRecord(env, 'oauth-tokens')).data.accessToken, 'synthetic-old-access');
});

test('missing record version and corrupt ciphertext fail without overwriting', async t => {
  const store = fixture(t), saved = await seed();
  const doc = store.docs.get(saved.id);
  delete doc.updateTime;
  await assert.rejects(readGustoRecord(env, 'oauth-tokens'), { code: 'GUSTO_STORAGE_UNREADABLE' });
  doc.updateTime = saved.version;
  doc.fields.ciphertext.stringValue = 'bad';
  await assert.rejects(readGustoRecord(env, 'oauth-tokens'), { code: 'GUSTO_STORAGE_UNREADABLE' });
});

test('only the EGC owner with business access can start OAuth', async t => {
  const store = fixture(t);
  assert.equal((await onRequestGet({ env, request: ownerRequest(endpoint, '') })).status, 401);
  assert.equal((await onRequestGet({ env, request: ownerRequest(endpoint, managerCookie) })).status, 403);
  assert.equal((await onRequestGet({ env, request: new Request(endpoint, { headers: { Cookie: ownerCookie, Origin: 'https://evil.example' } }) })).status, 403);
  assert.equal(store.calls.length, 0);
  const begun = await start();
  assert.equal(begun.auth.origin, 'https://api.gusto-demo.com');
  assert.equal(begun.auth.searchParams.get('client_secret'), null);
  assert.match(begun.response.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Lax/);
});

test('OAuth callback relays Strict-cookie sessions and consumes state once', async t => {
  const store = fixture(t), begun = await start();
  const get = await onRequestGet({ env, request: new Request(`${endpoint}?code=synthetic-authorization-code&state=${begun.state}`, { headers: { Cookie: begun.cookie, 'Sec-Fetch-Site': 'cross-site' } }) });
  assert.equal(get.status, 200);
  assert.ok((await get.text()).includes('method="post"'));
  assert.equal(store.calls.length, 0, 'no exchange until the owner session is revalidated');
  const callback = await finish(begun);
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('Location'), '/employee?view=timesheets&gusto=connected');
  assert.equal((await gustoStatus(env)).connected, true);
  assert.equal((await readGustoRecord(env, 'oauth-tokens')).data.refreshToken, 'synthetic-new-refresh');
  const replay = await finish(begun);
  assert.equal(replay.headers.get('Location'), '/employee?view=timesheets&gusto=invalid-state');
  assert.equal(store.calls.filter(call => call.url.endsWith('/oauth/token')).length, 1);
  assert.ok(!JSON.stringify(await gustoStatus(env)).includes('synthetic-new-'));
});

test('OAuth requires the original owner session, cookie state and same origin', async t => {
  const store = fixture(t), begun = await start();
  const otherOwnerSession = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  // Ensure the second token is distinct even when the millisecond clock ties.
  const badCookie = otherOwnerSession === ownerCookie ? ownerCookie.replace(/.$/, 'x') : otherOwnerSession;
  const checks = [
    await finish(begun, { cookie: begun.cookie }),
    await finish(begun, { cookie: `${managerCookie}; ${begun.cookie}` }),
    await finish(begun, { cookie: `${badCookie}; ${begun.cookie}` }),
    await finish(begun, { state: 'a'.repeat(64) }),
    await finish(begun, { origin: 'https://evil.example' }),
  ];
  assert.ok(checks.every(response => response.status !== 303 || response.headers.get('Location').endsWith('invalid-state')));
  assert.equal(store.calls.length, 0);
  assert.equal((await finish(begun)).headers.get('Location'), '/employee?view=timesheets&gusto=connected');
});

test('OAuth rejects another company and does not expose Gusto response secrets', async t => {
  const store = fixture(t), begun = await start(), original = store.handler;
  store.handler = async (url, options) => url.pathname === '/v1/token_info' ? Response.json({ resource: { type: 'Company', uuid: EMPLOYEE }, resource_owner: { type: 'CompanyAdmin' }, secret: 'synthetic-raw-gusto-secret' }) : original(url, options);
  const callback = await finish(begun);
  assert.equal(callback.headers.get('Location'), '/employee?view=timesheets&gusto=wrong-company');
  assert.equal((await readGustoRecord(env, 'oauth-tokens')).data, null);
  assert.ok(!(await callback.text()).includes('synthetic-'));
});

test('simultaneous expired-token requests exchange each refresh token only once', async t => {
  const store = fixture(t);
  await seed(tokens({ expiresAt: Date.now() - 1 }));
  const original = store.handler;
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  store.handler = async (url, options) => { if (url.pathname === '/oauth/token') { started(); await gate; } return original(url, options); };
  const first = gustoRequest(env, employeePath);
  await ready;
  await assert.rejects(gustoRequest(env, employeePath), { code: 'GUSTO_BUSY' });
  release();
  assert.deepEqual(await first, []);
  assert.equal(store.calls.filter(call => call.url.endsWith('/oauth/token')).length, 1);
  const saved = await readGustoRecord(env, 'oauth-tokens');
  assert.equal(saved.data.refreshToken, 'synthetic-new-refresh');
  assert.equal(saved.data.state, 'connected');
});

test('an uncertain refresh requires reconnect and never retries the spent token', async t => {
  const store = fixture(t);
  await seed(tokens({ expiresAt: Date.now() - 1 }));
  store.handler = async () => { throw new Error('synthetic-secret-transport-error'); };
  await assert.rejects(gustoRequest(env, employeePath), { code: 'GUSTO_RECONNECT_REQUIRED' });
  await assert.rejects(gustoRequest(env, employeePath), { code: 'GUSTO_RECONNECT_REQUIRED' });
  assert.equal(store.calls.length, 1);
  assert.equal((await readGustoRecord(env, 'oauth-tokens')).data.state, 'reconnect-required');
  assert.equal((await gustoStatus(env)).connected, false);
});

test('an abandoned durable refresh lease cannot be reused', async t => {
  const store = fixture(t);
  await seed(tokens({ state: 'refreshing', leaseId: 'abandoned', leaseExpiresAt: Date.now() - 1 }));
  await assert.rejects(gustoRequest(env, employeePath), { code: 'GUSTO_RECONNECT_REQUIRED' });
  assert.equal(store.calls.length, 0);
});

test('401 requires reconnection without exposing or blindly refreshing tokens', async t => {
  const store = fixture(t);
  await seed();
  store.handler = async () => Response.json({ error: 'synthetic-raw-token-secret' }, { status: 401 });
  await assert.rejects(gustoRequest(env, employeePath), error => error.code === 'GUSTO_RECONNECT_REQUIRED' && !error.message.includes('synthetic'));
  assert.equal(store.calls.length, 1);
  const saved = await readGustoRecord(env, 'oauth-tokens');
  assert.equal(saved.data.accessToken, undefined);
  assert.equal(saved.data.refreshToken, undefined);
});

test('API paths forbid payroll submission, arbitrary hosts and other companies', async t => {
  const store = fixture(t);
  await seed();
  for (const path of ['https://evil.example/v1/employees', `//api.gusto.com/v1/companies/${COMPANY}/employees`, `/v1/companies/${EMPLOYEE}/employees`, `/v1/companies/${COMPANY}/payrolls`, `/v1/employees/${EMPLOYEE}/jobs?access_token=leak`]) await assert.rejects(gustoRequest(env, path), { code: 'GUSTO_PATH_FORBIDDEN' });
  await assert.rejects(gustoRequest(env, employeePath, { method: 'POST', body: {} }), { code: 'GUSTO_PATH_FORBIDDEN' });
  assert.equal(store.calls.length, 0);
});

test('write transport and server failures are marked uncertain without raw errors', async t => {
  const store = fixture(t);
  await seed();
  store.handler = async () => Response.json({ error: 'synthetic-raw-secret' }, { status: 500 });
  await assert.rejects(gustoRequest(env, `/v1/companies/${COMPANY}/time_tracking/time_sheets`, { method: 'POST', body: {} }), error => error.code === 'GUSTO_REQUEST_UNCERTAIN' && !error.message.includes('synthetic'));
  store.handler = async () => Response.json({ error: 'synthetic-raw-secret' }, { status: 422 });
  await assert.rejects(gustoRequest(env, `/v1/companies/${COMPANY}/time_tracking/time_sheets`, { method: 'POST', body: {} }), { code: 'GUSTO_API_ERROR', status: 422 });
});

test('list pagination validates arrays and detects inconsistent duplicate pages', async t => {
  const store = fixture(t);
  await seed();
  store.handler = async url => Response.json([{ uuid: url.searchParams.get('page') === '1' ? COMPANY : EMPLOYEE }], { headers: { 'X-Total-Pages': '2' } });
  assert.equal((await gustoList(env, employeePath)).length, 2);
  store.handler = async () => Response.json({ employees: [] });
  await assert.rejects(gustoList(env, employeePath), { code: 'GUSTO_API_ERROR' });
  store.handler = async () => Response.json([{ uuid: EMPLOYEE }], { headers: { 'X-Total-Pages': '2' } });
  await assert.rejects(gustoList(env, employeePath), { code: 'GUSTO_API_ERROR' });
});

test('time sheet listing accepts official plural entity_uuids filter', async t => {
  const store = fixture(t);
  await seed();
  const path = `/v1/companies/${COMPANY}/time_tracking/time_sheets?entity_type=Employee&entity_uuids=${EMPLOYEE}`;
  assert.deepEqual(await gustoList(env, path), []);
  assert.equal(new URL(store.calls[0].url).searchParams.get('entity_uuids'), EMPLOYEE);
  assert.equal(new URL(store.calls[0].url).searchParams.get('entity_type'), 'Employee');
});
