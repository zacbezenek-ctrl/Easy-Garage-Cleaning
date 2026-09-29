import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moneyHandlers } from '../functions/api/money.js';
import { csvCell, listMoney, moneyCsv } from '../functions/_lib/money-reports.js';
import { createHubSessionCookie, hashHubCredential } from '../functions/_lib/hub-session.js';

const NOW = '2026-09-22T18:00:00.000Z'; // noon in Denver on 2026-09-22
const URL_BASE = 'https://easygaragecleaning.com/api/money';
const ENABLED = { MONEY_API_ENABLED: 'true' };
const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const crew = { user: 'crew1', role: 'crew', businessAccess: false, displayName: 'Synthetic Crew' };
const LINES = [{ id: 'line-1', kind: 'service', name: 'Garage cleanout', description: 'Synthetic', quantity: 1, unitCents: 90000 }];

function fixture(jobs = {}) {
  const docs = new Map([
    ['jobs/job-abc123', { id: 'job-abc123', revision: 'r0', type: 'job', customerId: 'c1', customer: 'Synthetic Customer', phone: '9705550100', serviceType: 'Garage transformation', date: '2026-09-24', status: 'scheduled' }],
    ...Object.entries(jobs).map(([id, row]) => [`jobs/${id}`, { revision: `${id}-r`, type: 'job', ...row, id }]),
  ]);
  let n = 0, fault = null;
  const store = {
    read: async (collection, id) => { if (fault) throw fault; return structuredClone(docs.get(`${collection}/${id}`) ?? null); },
    jobs: async () => { if (fault) throw fault; return [...docs].filter(([key]) => key.startsWith('jobs/')).map(([, row]) => structuredClone(row)); },
    async commit(writes) {
      for (const write of writes) { const old = docs.get(`${write.collection}/${write.id}`); if (write.revision ? old?.revision !== write.revision : old) throw Object.assign(new Error('Conflict'), { code: 'money_revision_conflict', status: 409 }); }
      for (const write of writes) { const key = `${write.collection}/${write.id}`; docs.set(key, { ...(write.revision ? docs.get(key) : {}), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` }); }
    },
  };
  return { docs, store, fail: error => { fault = error; }, job: (id = 'job-abc123') => docs.get(`jobs/${id}`) };
}
const handlers = (f, actor = owner) => moneyHandlers({ session: async () => actor, storage: () => f.store, now: () => new Date(NOW) });
const post = (body, headers = {}) => new Request(URL_BASE, { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const get = (query = '', headers = {}) => new Request(`${URL_BASE}${query}`, { headers: { 'Sec-Fetch-Site': 'same-origin', ...headers } });
const save = (f, extra = {}) => ({ action: 'estimate.save', requestId: randomUUID(), jobId: 'job-abc123', expectedRevision: f.job().revision, lineItems: LINES, scope: 'Clear and reset the garage.', validUntil: '2026-10-06', ...extra });
const json = async response => ({ status: response.status, body: await response.json(), headers: response.headers });

test('POST refuses cross-site and foreign-origin requests before reading the session or the store', async () => {
  const f = fixture();
  let sessions = 0;
  const api = moneyHandlers({ session: async () => { sessions++; return owner; }, storage: () => f.store, now: () => new Date(NOW) });
  for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'https://evil.example' }, { Origin: '', Referer: 'https://easygaragecleaning.com.evil.example/x' }, { Origin: 'null' }]) {
    const response = await json(await api.post({ request: post(save(f), headers), env: ENABLED }));
    assert.equal(response.status, 403, JSON.stringify(headers)); assert.equal(response.body.code, 'money_origin_forbidden');
  }
  assert.equal(sessions, 0); assert.equal(f.job().estimate, undefined);
  const request = new Request(URL_BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(save(f)) });
  assert.equal((await api.post({ request, env: ENABLED })).status, 200, 'a missing Origin is allowed only because the session cookie is SameSite=Strict');
});

test('POST stays off unless MONEY_API_ENABLED is exactly true, so the browser keeps its current writes', async () => {
  const f = fixture();
  for (const env of [{}, { MONEY_API_ENABLED: 'TRUE' }, { MONEY_API_ENABLED: '1' }, { MONEY_API_ENABLED: 'false' }]) {
    const response = await json(await handlers(f).post({ request: post(save(f)), env }));
    assert.equal(response.status, 404); assert.equal(response.body.code, 'money_api_disabled');
  }
  assert.equal(f.job().estimate, undefined);
});

test('only signed-in owners and managers can read or change money through the API', async () => {
  const f = fixture();
  const signedOut = await json(await handlers(f, null).post({ request: post(save(f)), env: ENABLED }));
  assert.deepEqual([signedOut.status, signedOut.body.code], [401, 'money_sign_in_required']);
  for (const actor of [crew, { user: 'sales1', role: 'manager', businessAccess: false }, { user: 'zacb', role: 'crew', businessAccess: true }]) {
    const write = await json(await handlers(f, actor).post({ request: post(save(f)), env: ENABLED }));
    assert.deepEqual([write.status, write.body.code], [403, 'money_forbidden']);
    const read = await json(await handlers(f, actor).get({ request: get('?jobId=job-abc123'), env: ENABLED }));
    assert.deepEqual([read.status, read.body.code], [403, 'money_forbidden']);
    const list = await handlers(f, actor).get({ request: get('?view=invoices&format=csv'), env: ENABLED });
    assert.equal(list.status, 403); assert.match(list.headers.get('Content-Type'), /application\/json/);
  }
  assert.equal(f.job().estimate, undefined);
});

test('POST requires JSON within the size limit', async () => {
  const f = fixture(), api = handlers(f);
  const wrongType = await json(await api.post({ request: post(save(f), { 'Content-Type': 'text/plain' }), env: ENABLED }));
  assert.deepEqual([wrongType.status, wrongType.body.code], [415, 'money_json_required']);
  const declared = await json(await api.post({ request: post(save(f), { 'Content-Length': '64001' }), env: ENABLED }));
  assert.deepEqual([declared.status, declared.body.code], [413, 'money_request_too_large']);
  const actual = await json(await api.post({ request: post(save(f, { scope: 'x'.repeat(64001) })), env: ENABLED }));
  assert.deepEqual([actual.status, actual.body.code], [413, 'money_request_too_large']);
  const broken = await json(await api.post({ request: post('{"action":'), env: ENABLED }));
  assert.deepEqual([broken.status, broken.body.code], [400, 'money_json_invalid']);
  assert.equal(f.job().estimate, undefined);
});

test('a saved change replays identically, and a different payload or a stale revision is a 409', async () => {
  const f = fixture(), api = handlers(f), body = save(f);
  const first = await json(await api.post({ request: post(body), env: ENABLED }));
  assert.equal(first.status, 200); assert.equal(first.body.ok, true); assert.equal(first.body.replayed, false);
  assert.equal(first.headers.get('Cache-Control'), 'no-store'); assert.equal(first.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(first.body.job.totals.quoteCents, 90000); assert.equal(JSON.stringify(first.body).includes('9705550100'), false);
  const replay = await json(await api.post({ request: post(body), env: ENABLED }));
  assert.equal(replay.status, 200); assert.deepEqual({ ...replay.body, replayed: false }, first.body);
  const conflict = await json(await api.post({ request: post({ ...body, scope: 'Something else.' }), env: ENABLED }));
  assert.deepEqual([conflict.status, conflict.body.code], [409, 'money_idempotency_conflict']);
  const stale = await json(await api.post({ request: post(save(f, { expectedRevision: 'r0' })), env: ENABLED }));
  assert.deepEqual([stale.status, stale.body.code], [409, 'money_revision_conflict']);
  const invalid = await json(await api.post({ request: post(save(f, { lineItems: [] })), env: ENABLED }));
  assert.deepEqual([invalid.status, invalid.body.code], [400, 'money_invalid_line_items']);
});

test('unknown storage failures become a generic retryable 503 that never leaks internals', async () => {
  const f = fixture(), api = handlers(f);
  f.fail(new Error('connect ECONNREFUSED 10.0.0.1 secret-internal-detail'));
  for (const response of [await api.post({ request: post(save(f)), env: ENABLED }), await api.get({ request: get('?jobId=job-abc123'), env: ENABLED })]) {
    const { status, body } = await json(response);
    assert.equal(status, 503); assert.equal(body.code, 'money_unavailable'); assert.equal(JSON.stringify(body).includes('secret-internal-detail'), false);
    assert.match(body.error, /retry/i);
  }
});

test('GET returns one job money projection and refuses cross-site reads and unsupported queries', async () => {
  const f = fixture({ walk: { type: 'walkthrough', total: 100 } }), api = handlers(f);
  const view = await json(await api.get({ request: get('?jobId=job-abc123'), env: {} }));
  assert.equal(view.status, 200); assert.equal(view.body.enabled, false, 'reads work while writes are off'); assert.deepEqual(view.body.viewer, { id: 'zacb' });
  assert.equal(view.body.job.id, 'job-abc123'); assert.equal(view.body.job.revision, 'r0'); assert.equal(view.body.asOf, NOW);
  assert.equal(JSON.stringify(view.body).includes('9705550100'), false);
  assert.equal((await json(await api.get({ request: get('?jobId=job-abc123'), env: ENABLED }))).body.enabled, true);
  assert.equal((await json(await api.get({ request: get('?jobId=walk'), env: {} }))).status, 404);
  assert.equal((await json(await api.get({ request: get('?jobId=missing'), env: {} }))).body.code, 'money_job_not_found');
  for (const query of ['?jobId=job-abc123&jobId=job-abc123', '?jobId=job-abc123&view=payments', '?bogus=1', '?jobId=_egc_schedule_lock_2026-09-22', '?view=invoices&view=payments']) {
    const response = await json(await api.get({ request: get(query), env: {} }));
    assert.deepEqual([response.status, response.body.code], [400, 'money_query_invalid'], query);
  }
  for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Referer: 'https://evil.example/' }]) {
    const response = await json(await api.get({ request: get('?jobId=job-abc123', headers), env: {} }));
    assert.deepEqual([response.status, response.body.code], [403, 'money_origin_forbidden']);
  }
});

const LISTED = {
  'job-a': { customerId: 'c1', customer: 'Synthetic Alpha', date: '2026-09-20', total: 500, invoice: { number: 'INV-AAAAAA', status: 'issued', amount: 500, issuedAt: '2026-09-23T05:30:00.000Z', dueDate: '2026-09-30' } },
  'job-b': { customerId: 'c2', customer: '=HYPERLINK("https://evil.example")', date: '2026-09-21', total: 300, invoice: { number: '+INV-B', status: 'issued', amount: 300, issuedAt: '2026-09-21T18:00:00.000Z', dueDate: '2026-09-21', customerReference: '@PO "7"' } },
  'job-c': { customerId: 'c1', customer: 'Synthetic Charlie', date: '2026-09-10', total: 800, invoice: { number: 'INV-CCCCCC', status: 'paid', amount: 800, issuedAt: '2026-09-11T18:00:00.000Z' },
    payment: { amount: 800, verified: true, method: 'stripe', stripeSessions: [{ sessionId: 'cs_test_c', paymentIntentId: 'pi_c', amount: 500, purpose: 'deposit', verifiedAt: '2026-09-09T18:00:00.000Z' }] } },
  'job-d': { customerId: 'c3', customer: 'Synthetic Delta', total: 900, invoice: { number: 'INV-DDDDDD', status: 'void', amount: 900, issuedAt: '2026-09-15T18:00:00.000Z', voidReason: 'Synthetic' } },
  'job-e': { customerId: 'c3', customer: 'Synthetic Echo', total: 900 },
  walk: { type: 'walkthrough', invoice: { number: 'INV-WALK', status: 'issued', amount: 100, issuedAt: '2026-09-15T18:00:00.000Z' } },
};

test('the invoice list filters by effective status, Denver issue date (exclusive end) and customer, newest first with pages', async () => {
  const f = fixture(LISTED);
  const all = await listMoney(f.store, {}, NOW);
  assert.deepEqual(all.items.map(row => row.number), ['INV-AAAAAA', '+INV-B', 'INV-DDDDDD', 'INV-CCCCCC']);
  assert.deepEqual(all.items.map(row => row.status), ['issued', 'overdue', 'void', 'paid']);
  assert.equal(all.items[0].issuedDate, '2026-09-22', '05:30 UTC on the 23rd is still the 22nd in Denver');
  assert.deepEqual(all.coverage, { complete: true, asOf: NOW });
  assert.deepEqual((await listMoney(f.store, { startDate: '2026-09-22', endDate: '2026-09-23' }, NOW)).items.map(row => row.jobId), ['job-a']);
  assert.deepEqual((await listMoney(f.store, { endDate: '2026-09-22' }, NOW)).items.map(row => row.jobId), ['job-b', 'job-d', 'job-c']);
  assert.deepEqual((await listMoney(f.store, { status: 'overdue' }, NOW)).items.map(row => row.jobId), ['job-b']);
  assert.deepEqual((await listMoney(f.store, { customerId: 'c1' }, NOW)).items.map(row => row.jobId), ['job-a', 'job-c']);
  const page = await listMoney(f.store, { limit: '2', offset: '2' }, NOW);
  assert.deepEqual([page.items.length, page.total, page.nextOffset], [2, 4, null]);
  assert.equal((await listMoney(f.store, { limit: '2' }, NOW)).nextOffset, 2);
  const paid = all.items.find(row => row.jobId === 'job-c');
  assert.deepEqual([paid.amountCents, paid.paidCents, paid.balanceCents], [80000, 80000, 0]);
  for (const query of [{ view: 'quotes' }, { status: 'bogus' }, { view: 'payments', status: 'paid' }, { startDate: '2026-02-30' }, { startDate: '2026-09-22', endDate: '2026-09-22' }, { customerId: 'secure_x' }, { limit: '0' }, { limit: '201' }, { offset: '-1' }, { format: 'xml' }])
    await assert.rejects(listMoney(f.store, query, NOW), error => error.code === 'money_query_invalid' && error.status === 400, JSON.stringify(query));
  f.fail(Object.assign(new Error('partial'), { code: 'money_storage_incomplete', status: 503 }));
  await assert.rejects(listMoney(f.store, {}, NOW), error => error.code === 'money_storage_incomplete');
});

test('the payments list itemizes the ledger per job with Denver received dates', async () => {
  const f = fixture(LISTED), page = await listMoney(f.store, { view: 'payments' }, NOW);
  assert.deepEqual(page.items.map(row => [row.jobId, row.entryId, row.kind, row.amountCents, row.receivedDate, row.source]), [
    ['job-c', 'stripe:cs_test_c', 'deposit', 50000, '2026-09-09', 'stripe_session'],
    ['job-c', 'legacy:manual', 'offline', 30000, null, 'legacy_aggregate'],
  ]);
  assert.deepEqual((await listMoney(f.store, { view: 'payments', startDate: '2026-09-01', endDate: '2026-09-30' }, NOW)).items.map(row => row.entryId), ['stripe:cs_test_c'], 'undated legacy money is never placed in a date range');
});

test('CSV exports escape formula-leading cells, double quotes and use CRLF rows', async () => {
  assert.equal(csvCell('=1+1'), `"'=1+1"`); assert.equal(csvCell('+1'), `"'+1"`); assert.equal(csvCell('-1'), `"'-1"`); assert.equal(csvCell('@SUM(A1)'), `"'@SUM(A1)"`);
  assert.equal(csvCell('say "hi"'), '"say ""hi"""'); assert.equal(csvCell(null), '""'); assert.equal(csvCell(12.5), '"12.5"');
  const f = fixture(LISTED), response = await handlers(f).get({ request: get('?view=invoices&format=csv'), env: {} });
  assert.equal(response.status, 200); assert.match(response.headers.get('Content-Type'), /^text\/csv/);
  assert.equal(response.headers.get('Content-Disposition'), 'attachment; filename="egc-invoices-2026-09-22.csv"'); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const text = await response.text(), rows = text.split('\r\n');
  assert.equal(rows.at(-1), ''); assert.equal(rows.length, 6); assert.equal(text.includes('\n') && !text.replaceAll('\r\n', '').includes('\n'), true);
  assert.match(rows[0], /^"Invoice number","Status","Customer"/);
  const hostile = rows.find(row => row.includes('HYPERLINK'));
  assert.ok(hostile.startsWith(`"'+INV-B","overdue","'=HYPERLINK(""https://evil.example"")"`), hostile);
  assert.ok(hostile.endsWith(`"'@PO ""7"""`), hostile);
  const payments = await handlers(f).get({ request: get('?view=payments&format=csv&startDate=2026-09-01'), env: {} });
  assert.equal(payments.headers.get('Content-Disposition'), 'attachment; filename="egc-payments-2026-09-22.csv"');
  assert.match(await payments.text(), /"2026-09-09","2026-09-09T18:00:00.000Z","Synthetic Charlie","c1","job-c","deposit","card","500.00","pi_c"/);
  assert.equal(moneyCsv('payments', []).split('\r\n').length, 2);
  const listed = await json(await handlers(f).get({ request: get('?view=invoices&limit=1'), env: {} }));
  assert.equal(listed.body.items.length, 1); assert.equal(listed.body.rows, undefined, 'JSON pages never carry the full export rows');
});

test('integration-status surfaces the money API flag to signed-in Hub users only', async () => {
  const { onRequestGet } = await import('../functions/api/integration-status.js');
  const env = { HUB_SESSION_SECRET: 'synthetic-money-flag-secret', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: await hashHubCredential('ZacB', 'synthetic password') }) };
  const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  const read = async extra => (await onRequestGet({ request: new Request('https://easygaragecleaning.com/api/integration-status', { headers: { Cookie: cookie } }), env: { ...env, ...extra } })).json();
  // FUN-36 added the lifecycleApi flag (tests/customer-lifecycle-api.test.mjs); the money flag is independent of it.
  assert.deepEqual((await read({})).flags, { moneyApi: false, lifecycleApi: false });
  assert.deepEqual((await read({ MONEY_API_ENABLED: 'true' })).flags, { moneyApi: true, lifecycleApi: false });
  assert.deepEqual((await read({ MONEY_API_ENABLED: 'yes' })).flags, { moneyApi: false, lifecycleApi: false });
  const anonymous = await onRequestGet({ request: new Request('https://easygaragecleaning.com/api/integration-status'), env: { ...env, MONEY_API_ENABLED: 'true' } });
  assert.equal(anonymous.status, 401); assert.equal((await anonymous.json()).flags, undefined);
});
