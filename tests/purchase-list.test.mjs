import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { purchaseListHandlers } from '../functions/api/purchase-list.js';
import { PURCHASE_LIST_FIELDS, purchaseListStorage } from '../functions/_lib/purchase-list.js';

const ON = { EGC_JOB_MATERIALS: 'true' };
const NOW = new Date('2026-10-17T16:00:00.000Z');
const ORIGIN = 'https://hub.example.invalid';
const manager = { user: 'AlexK', role: 'manager', businessAccess: true, displayName: 'Alex' };
const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Owner' };
const crew = { user: 'Crew.One', role: 'crew', businessAccess: false, source: 'employee-account', displayName: 'Synthetic Crew' };
const sales = { user: 'Sales.Rep', role: 'sales', businessAccess: false, source: 'employee-account', displayName: 'Synthetic Sales Rep' };
const shelf = (quantity, extra = {}) => ({ id: 'quote-shelving', name: 'Metal shelving unit', quantity, source: 'buy', purchaseState: 'to_buy', productUrl: 'https://www.homedepot.com/p/100', category: 'shelving', ...extra });

function fixture(extraJobs = []) {
  const rows = new Map([
    ['job-a', { id: 'job-a', type: 'job', date: '2026-10-20', time: '09:30', status: 'scheduled', customer: 'Customer A', materials: [shelf(2), { id: 'kit-dolly', name: 'Dolly', quantity: 1, source: 'stock' }, 'Legacy tarp'], estimate: { amount: 1400 } }],
    ['job-b', { id: 'job-b', type: 'job', date: '2026-10-24', time: '13:00', status: 'scheduled', customer: 'Customer B', materials: [shelf(3)] }],
    ['job-later', { id: 'job-later', type: 'job', date: '2026-11-20', status: 'scheduled', customer: 'Later', materials: [shelf(9)] }],
    ['walk-1', { id: 'walk-1', type: 'walkthrough', date: '2026-10-20', materials: [shelf(1)] }],
    ...extraJobs.map(job => [job.id, job]),
  ].map(([id, row]) => [id, { ...row, __updateTime: `${id}-t0` }]));
  const events = new Map(), calls = { list: [], reads: 0, commits: [] };
  let conflicts = 0;
  const store = {
    async listJobs(start, end) { calls.list.push([start, end]); return [...rows.values()].filter(job => job.date >= start && job.date <= end).map(job => structuredClone(job)); },
    async readJob(id) { calls.reads++; return structuredClone(rows.get(id) || null); },
    async readEvent(id, requestId) { return structuredClone(events.get(`${id}/${requestId}`) || null); },
    async commit(job, patch, event) {
      calls.commits.push({ jobId: job.id, patch: structuredClone(patch), event: structuredClone(event) });
      const current = rows.get(job.id);
      if (conflicts > 0) { conflicts--; current.__updateTime = `${job.id}-other-${calls.commits.length}`; }
      if (current.__updateTime !== job.__updateTime) throw Object.assign(new Error('changed'), { code: 'FIELD_REVISION_CONFLICT', status: 409 });
      if (events.has(`${job.id}/${event.id}`)) throw Object.assign(new Error('exists'), { code: 'FIELD_REVISION_CONFLICT', status: 409 });
      Object.assign(current, structuredClone(patch), { __updateTime: `${job.id}-t${calls.commits.length}` });
      events.set(`${job.id}/${event.id}`, structuredClone(event));
    },
  };
  return { rows, events, calls, store, conflict: n => { conflicts = n; } };
}
function api(actor, f, env = ON) {
  const handlers = purchaseListHandlers({ session: async () => actor, storage: () => f.store, now: () => NOW });
  return {
    async get(query = '') { const response = await handlers.get({ request: new Request(`${ORIGIN}/api/purchase-list${query}`), env }); return { status: response.status, body: await response.json(), headers: response.headers }; },
    async post(body, headers = {}) {
      const response = await handlers.post({ request: new Request(`${ORIGIN}/api/purchase-list`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }), env });
      return { status: response.status, body: await response.json() };
    },
  };
}

test('switched off, the purchase list answers 404 and reads nothing', async () => {
  for (const env of [{}, { EGC_JOB_MATERIALS: 'false' }, { EGC_JOB_MATERIALS: 'TRUE' }]) {
    const handlers = purchaseListHandlers({ session: async () => { throw new Error('no session read'); }, storage: () => { throw new Error('no storage'); }, now: () => NOW });
    for (const response of [await handlers.get({ request: new Request(`${ORIGIN}/api/purchase-list`), env }), await handlers.post({ request: new Request(`${ORIGIN}/api/purchase-list`, { method: 'POST', body: '{}' }), env })]) {
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { ok: false, code: 'purchase_list_disabled', error: 'The purchase list is not switched on for this Hub.' });
    }
  }
});

test('only dispatch.write or field-manager (business) access opens or changes the purchase list', async () => {
  for (const [actor, env, status, code] of [[null, ON, 401, 'purchase_sign_in_required'], [crew, ON, 403, 'purchase_forbidden'], [sales, { ...ON, EGC_STAFF_ROLE_ACCESS: 'true' }, 403, 'purchase_forbidden'], [{ ...sales, staffRoles: ['sales'] }, { ...ON, EGC_STAFF_ROLE_PERMISSIONS: 'true' }, 403, 'purchase_forbidden']]) {
    const f = fixture(), client = api(actor, f, env);
    const read = await client.get(), write = await client.post({ requestId: randomUUID(), jobId: 'job-a', materialIds: ['quote-shelving'], state: 'purchased' });
    assert.deepEqual([read.status, read.body.code, write.status, write.body.code], [status, code, status, code], actor?.user || 'signed out');
    assert.deepEqual([f.calls.list.length, f.calls.reads, f.calls.commits.length], [0, 0, 0], 'a refused viewer reads and writes nothing');
  }
  for (const actor of [manager, owner]) assert.equal((await api(actor, fixture()).get()).status, 200, actor.user);
});

test('the list reads one bounded date range and sums buy materials across jobs by store and product', async () => {
  const f = fixture(), { status, body, headers } = await api(manager, f).get();
  assert.equal(status, 200);
  assert.equal(headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(f.calls.list, [['2026-10-17', '2026-10-30']], 'today (Denver) and the next 13 days, in one query');
  assert.deepEqual([body.start, body.end, body.lines, body.jobs, body.generatedAt], ['2026-10-17', '2026-10-30', 2, 2, NOW.toISOString()]);
  assert.deepEqual(body.stores.map(store => store.store), ['Home Depot']);
  const [product] = body.stores[0].products;
  assert.deepEqual([product.name, product.quantity, product.toBuy, product.byState], ['Metal shelving unit', 5, 5, { to_buy: 5, ordered: 0, purchased: 0, loaded: 0 }]);
  assert.deepEqual(product.jobs.map(job => [job.jobId, job.customer, job.quantity, job.href]), [['job-a', 'Customer A', 2, '/crew/job.html?jobId=job-a'], ['job-b', 'Customer B', 3, '/crew/job.html?jobId=job-b']]);
  assert.doesNotMatch(JSON.stringify(body), /1400|estimate|Dolly|Legacy tarp|walk-1|Later/);
  const custom = fixture(), ranged = await api(owner, custom).get('?start=2026-10-21&end=2026-11-20');
  assert.equal(ranged.status, 200); assert.deepEqual(custom.calls.list, [['2026-10-21', '2026-11-20']]);
  assert.deepEqual(ranged.body.stores[0].products[0].jobs.map(job => job.jobId), ['job-b', 'job-later']);
  for (const query of ['?start=2026-10-01&end=2026-11-01', '?start=2026-10-20&end=2026-10-19', '?start=2026-13-01', '?days=7', '?start=2026-10-20&start=2026-10-21&x=1']) {
    const g = fixture(), refused = await api(manager, g).get(query);
    assert.deepEqual([refused.status, refused.body.code], [400, 'purchase_range_invalid'], query);
    assert.equal(g.calls.list.length, 0, `${query}: nothing is read`);
  }
  const crowded = fixture([...Array(501)].map((_, i) => ({ id: `bulk-${i}`, type: 'job', date: '2026-10-18', status: 'scheduled', materials: [] })));
  const refused = await api(manager, crowded).get();
  assert.deepEqual([refused.status, refused.body.code], [400, 'purchase_range_too_large']);
});

test('a manager marks a job\'s materials purchased under the job revision, with an audit event and an idempotent replay', async () => {
  const f = fixture(), client = api(manager, f), requestId = randomUUID();
  const saved = await client.post({ requestId, jobId: 'job-a', materialIds: ['quote-shelving'], state: 'purchased', expectedUser: 'alexk' });
  assert.deepEqual([saved.status, saved.body], [200, { ok: true, alreadyApplied: false, jobId: 'job-a', changed: [{ id: 'quote-shelving', name: 'Metal shelving unit', from: 'to_buy', to: 'purchased' }] }]);
  const job = f.rows.get('job-a');
  assert.deepEqual(job.materials, [shelf(2, { purchaseState: 'purchased', purchaseUpdatedAt: NOW.toISOString(), purchaseUpdatedBy: 'AlexK' }), { id: 'kit-dolly', name: 'Dolly', quantity: 1, source: 'stock' }, 'Legacy tarp']);
  assert.deepEqual(Object.keys(f.calls.commits[0].patch), ['materials', 'updatedAt'], 'only the materials list and its timestamp are written');
  const event = f.events.get(`job-a/${requestId}`);
  assert.deepEqual({ ...event, fingerprint: typeof event.fingerprint }, { id: requestId, action: 'purchase_state', actorId: 'AlexK', actorName: 'Alex', createdAt: NOW.toISOString(), state: 'applied', visibility: 'management', fingerprint: 'string', summary: 'Metal shelving unit: to buy → purchased', purchaseState: 'purchased', changed: saved.body.changed });
  const replay = await client.post({ requestId, jobId: 'job-a', materialIds: ['quote-shelving'], state: 'purchased' });
  assert.deepEqual([replay.status, replay.body.alreadyApplied, f.calls.commits.length], [200, true, 1], 'a retried request changes nothing twice');
  const reused = await client.post({ requestId, jobId: 'job-a', materialIds: ['quote-shelving'], state: 'ordered' });
  assert.deepEqual([reused.status, reused.body.code], [409, 'purchase_idempotency_conflict']);
  const listed = await client.get();
  assert.deepEqual(listed.body.stores[0].products[0].byState, { to_buy: 3, ordered: 0, purchased: 2, loaded: 0 });
});

test('a mark on a job Dispatch has since cancelled or closed is refused and writes nothing; an earlier mark still replays', async () => {
  const f = fixture(), client = api(manager, f), requestId = randomUUID();
  const saved = await client.post({ requestId, jobId: 'job-b', materialIds: ['quote-shelving'], state: 'ordered' });
  assert.equal(saved.status, 200);
  for (const [field, value] of [['status', 'cancelled'], ['pipelineStatus', 'completed'], ['pipelineStatus', 'no_show']]) {
    const row = f.rows.get('job-b'), before = structuredClone(row);
    Object.assign(row, { status: 'scheduled', pipelineStatus: 'scheduled', [field]: value });
    const commits = f.calls.commits.length, events = f.events.size;
    const refused = await client.post({ requestId: randomUUID(), jobId: 'job-b', materialIds: ['quote-shelving'], state: 'purchased' });
    assert.deepEqual([refused.status, refused.body.code, f.calls.commits.length, f.events.size], [409, 'purchase_job_closed', commits, events], `${field}=${value}`);
    assert.equal(f.rows.get('job-b').materials[0].purchaseState, 'ordered');
    const replay = await client.post({ requestId, jobId: 'job-b', materialIds: ['quote-shelving'], state: 'ordered' });
    assert.deepEqual([replay.status, replay.body.alreadyApplied], [200, true], 'a lost response for the earlier mark is still answered');
    Object.assign(row, before);
  }
});

test('a mark retries a revision race on the latest job, and refuses stock, missing or non-job records', async () => {
  const f = fixture(), client = api(owner, f);
  f.conflict(1);
  const raced = await client.post({ requestId: randomUUID(), jobId: 'job-b', materialIds: ['quote-shelving'], state: 'ordered' });
  assert.deepEqual([raced.status, raced.body.alreadyApplied, f.calls.commits.length, f.rows.get('job-b').materials[0].purchaseState], [200, false, 2, 'ordered']);
  f.conflict(3);
  const lost = await client.post({ requestId: randomUUID(), jobId: 'job-b', materialIds: ['quote-shelving'], state: 'purchased' });
  assert.deepEqual([lost.status, lost.body.code], [409, 'purchase_revision_conflict']);
  for (const [body, status, code] of [
    [{ requestId: randomUUID(), jobId: 'job-a', materialIds: ['kit-dolly'], state: 'purchased' }, 409, 'purchase_material_missing'],
    [{ requestId: randomUUID(), jobId: 'job-a', materialIds: ['quote-shelving'], state: 'lost' }, 400, 'purchase_state_invalid'],
    [{ requestId: randomUUID(), jobId: 'job-a', materialIds: ['quote-shelving'], state: 'loaded' }, 400, 'purchase_state_invalid'],
    [{ requestId: randomUUID(), jobId: 'walk-1', materialIds: ['quote-shelving'], state: 'ordered' }, 404, 'purchase_job_missing'],
    [{ requestId: randomUUID(), jobId: 'nope', materialIds: ['quote-shelving'], state: 'ordered' }, 404, 'purchase_job_missing'],
    [{ requestId: 'not-a-uuid', jobId: 'job-a', materialIds: ['quote-shelving'], state: 'ordered' }, 400, 'purchase_request_invalid'],
    [{ requestId: randomUUID(), jobId: 'job-a', materialIds: ['quote-shelving'], state: 'ordered', costCents: 100 }, 400, 'purchase_request_invalid'],
    [{ requestId: randomUUID(), jobId: 'job-a', materialIds: ['quote-shelving'], state: 'ordered', expectedUser: 'someone-else' }, 401, 'purchase_account_changed'],
    ['{not json', 400, 'purchase_request_invalid'],
  ]) {
    const result = await client.post(body);
    assert.deepEqual([result.status, result.body.code], [status, code], JSON.stringify(body).slice(0, 80));
  }
  assert.equal(f.rows.get('job-a').materials[0].purchaseState, 'to_buy');
  const crossSite = await client.post({ requestId: randomUUID(), jobId: 'job-a', materialIds: ['quote-shelving'], state: 'ordered' }, { Origin: 'https://elsewhere.example' });
  assert.deepEqual([crossSite.status, crossSite.body.code], [403, 'purchase_origin_forbidden']);
  const text = await client.post('{}', { 'Content-Type': 'text/plain' });
  assert.deepEqual([text.status, text.body.code], [415, 'purchase_json_required']);
});

test('the storage reads jobs dated inside the range with the purchase field mask in one bounded query', async () => {
  const sent = [];
  const fetcher = async (env, url, options = {}) => {
    sent.push({ url: String(url), body: JSON.parse(options.body) });
    return new Response(JSON.stringify([{ readTime: '2026-10-17T16:00:00Z', document: { name: 'projects/egcw-1ec83/databases/(default)/documents/jobs/job-a', updateTime: '2026-10-17T15:00:00Z', fields: { date: { stringValue: '2026-10-20' }, type: { stringValue: 'job' } } } }]), { status: 200 });
  };
  const rows = await purchaseListStorage({}, fetcher).listJobs('2026-10-17', '2026-10-30');
  assert.deepEqual(rows, [{ date: '2026-10-20', type: 'job', id: 'job-a', __updateTime: '2026-10-17T15:00:00Z' }]);
  assert.equal(sent.length, 1); assert.match(sent[0].url, /:runQuery$/);
  const query = sent[0].body.structuredQuery;
  assert.deepEqual(query.where, { compositeFilter: { op: 'AND', filters: [
    { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: '2026-10-17' } } },
    { fieldFilter: { field: { fieldPath: 'date' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: '2026-10-30' } } }] } });
  assert.equal(query.limit, 501);
  assert.deepEqual(query.select.fields.map(field => field.fieldPath), [...PURCHASE_LIST_FIELDS]);
  for (const field of ['estimate', 'total', 'costs', 'payment', 'acceptance', 'phone', 'address']) assert.equal(PURCHASE_LIST_FIELDS.includes(field), false, field);
  const broken = purchaseListStorage({}, async () => new Response('{}', { status: 200 }));
  await assert.rejects(broken.listJobs('2026-10-17', '2026-10-30'), error => error.code === 'purchase_storage_incomplete' && error.status === 503);
  const down = purchaseListStorage({}, async () => new Response('', { status: 500 }));
  await assert.rejects(down.listJobs('2026-10-17', '2026-10-30'), error => error.code === 'purchase_storage_unavailable');
});
