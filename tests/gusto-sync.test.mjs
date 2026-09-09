import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedTimecard, createGustoTimecardService, gustoDateRange } from '../functions/_lib/gusto-timecards.js';
import { createGustoSyncHandlers, onRequestGet as syncGet, onRequestPost as syncPost } from '../functions/api/gusto-sync.js';
import { onRequestPost as hubPost } from '../functions/api/employee-hub.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { writeGustoRecord } from '../functions/_lib/gusto-store.js';

const company = '11111111-1111-4111-8111-111111111111', employee = '22222222-2222-4222-8222-222222222222', job = '33333333-3333-4333-8333-333333333333';
const otherEmployee = '44444444-4444-4444-8444-444444444444', otherJob = '55555555-5555-4555-8555-555555555555';
const card = overrides => ({ id: 'shift-1', employee: 'Crew.Test', employeeName: 'Crew Test', status: 'submitted', approvalStatus: 'approved', approvedBy: 'ZacB', approvedAt: '2026-09-09T23:00:00Z', clockInAt: '2026-09-09T14:00:00Z', clockOutAt: '2026-09-09T22:30:00Z', breaks: [{ startAt: '2026-09-09T18:00:00Z', endAt: '2026-09-09T18:30:00Z' }], ...overrides });
const clone = value => structuredClone(value);
function fixture(t) {
  // All Gusto and Firestore work in this suite uses explicit in-memory dependencies.
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected live network request in Gusto sync test'); });
  const records = new Map(), sheets = new Map(), calls = [], writes = [];
  let revision = 0, clock = Date.parse('2026-09-10T00:00:00Z'), writeHook = null, requestHook = null, afterRequestHook = null;
  const cards = [card()];
  const employees = [{ uuid: employee, first_name: 'Crew', last_name: 'Test', email: 'crew@example.test', company_uuid: company, ssn: 'SECRET', jobs: [{ uuid: job, title: 'Crew', employee_uuid: employee, rate: 'SECRET' }] }, { uuid: otherEmployee, first_name: 'Other', last_name: 'Person', email: 'other@example.test', jobs: [{ uuid: otherJob, title: 'Driver', employee_uuid: otherEmployee }] }];
  const dependencies = {
    readTimecards: async () => clone(cards),
    readRecord: async (_env, key) => clone(records.get(key) || { data: null, version: null, id: key }),
    writeRecord: async (_env, key, data, expected) => {
      if ((records.get(key)?.version || null) !== (expected?.version || null)) throw Object.assign(new Error('Synthetic storage conflict'), { status: 409, code: 'GUSTO_WRITE_CONFLICT' });
      const stored = { data: clone(data), version: String(++revision), id: key }; records.set(key, stored); writes.push(clone(stored));
      if (writeHook) await writeHook(key, data);
      return clone(stored);
    },
    configuration: () => ({ configured: true, environment: 'demo', companyUuid: company }),
    status: async () => ({ configured: true, connected: true, environment: 'demo', companyUuid: company }),
    list: async (_env, path) => {
      calls.push({ method: 'GET', path });
      if (path.endsWith('/employees')) return clone(employees);
      assert.ok(path.startsWith(`/v1/companies/${company}/time_tracking/time_sheets?entity_type=Employee&entity_uuids=`));
      const entity = new URL(path, 'https://gusto.example.test').searchParams.get('entity_uuids');
      return clone([...sheets.values()].filter(sheet => sheet.entity_uuid === entity));
    },
    request: async (_env, path, options = {}) => {
      const method = options.method || 'GET'; calls.push({ method, path, body: clone(options.body) });
      if (requestHook) await requestHook(path, options);
      if (method === 'GET') return clone(sheets.get(path.split('/').at(-1)));
      assert.ok(!path.includes('payroll'), 'sync must never mutate or submit payroll');
      const uuid = method === 'PUT' ? path.split('/').at(-1) : crypto.randomUUID();
      if (method === 'PUT') assert.equal(options.body.version, sheets.get(uuid).version, 'corrections use current remote version');
      const sheet = { ...clone(options.body), uuid, company_uuid: company, version: String(++revision), synced_to_payroll_at: null };
      sheets.set(uuid, sheet);
      if (afterRequestHook) await afterRequestHook(sheet);
      return clone(sheet);
    },
    now: () => clock,
  };
  const service = createGustoTimecardService(dependencies);
  const review = async cardId => (await service.preview({}, '2026-09-01', '2026-09-30')).rows.find(row => row.id === cardId);
  const classify = async input => service.classify({}, { ...input, reviewToken: (await review(input.timecardId))?.reviewToken });
  const syncInput = async (ids = ['shift-1']) => {
    const rows = (await service.preview({}, '2026-09-01', '2026-09-30')).rows;
    return { timecardIds: ids, reviewTokens: Object.fromEntries(ids.map(cardId => [cardId, rows.find(row => row.id === cardId)?.transferToken || '0'.repeat(64)])) };
  };
  return { service, dependencies, records, cards, employees, sheets, calls, writes,
    writeHook: value => { writeHook = value; }, requestHook: value => { requestHook = value; }, afterRequestHook: value => { afterRequestHook = value; }, advance: ms => { clock += ms; },
    async ready() {
      await service.mapEmployee({}, { username: 'Crew.Test', employeeUuid: employee, jobUuid: job, confirmed: true });
      await classify({ timecardId: 'shift-1', regular: 7, overtime: 0.5, doubleOvertime: 0.5 });
    },
    sync: async ids => service.sync({}, await syncInput(ids)), classify, review, syncInput,
  };
}

test('server net hours use completed breaks, ignore browser totals, and emit the exact Gusto pay enums', async t => {
  const f = fixture(t); f.cards[0].hours = 10000; f.cards[0].grossEstimate = 1;
  await f.ready(); const result = await f.sync();
  assert.equal(result.results[0].status, 'synced');
  const posted = f.calls.find(call => call.method === 'POST').body;
  assert.deepEqual(posted.entries, [{ hours_worked: 7, pay_classification: 'Regular' }, { hours_worked: 0.5, pay_classification: 'Overtime' }, { hours_worked: 0.5, pay_classification: 'Double overtime' }]);
  assert.equal(posted.time_zone, 'America/Denver'); assert.equal(posted.shift_started_at, '2026-09-09T14:00:00.000Z');
  assert.equal(posted.entity_type, 'Employee'); assert.equal(posted.job_uuid, job);
  assert.match(posted.metadata.egc_content_hash, /^[a-f0-9]{64}$/);
  assert.equal(posted.metadata.egc_timecard_id, 'shift-1');
  assert.equal(JSON.stringify(posted).includes('grossEstimate'), false);
});

test('preview filters by Denver shift date and exposes only approved completed valid rows', async t => {
  const f = fixture(t);
  f.cards.push(card({ id: 'overnight', clockInAt: '2026-09-09T03:00:00Z', clockOutAt: '2026-09-09T04:00:00Z', breaks: [] }));
  f.cards.push(card({ id: 'pending', approvalStatus: 'pending' }), card({ id: 'active', status: 'active' }), card({ id: 'rejected', approvalStatus: 'rejected' }), card({ id: 'broken', breaks: [{ startAt: '2026-09-09T18:00:00Z' }] }));
  const result = await f.service.preview({}, '2026-09-08', '2026-09-08');
  assert.deepEqual(result.rows.map(row => row.id), ['overnight']); assert.equal(result.excluded[0].id, 'broken');
  assert.equal(result.rows[0].hours, 1); assert.equal(result.rows[0].classification, null); assert.equal(result.rows[0].mapping, null);
  assert.equal(result.rows[0].issues.length, 2); assert.equal('source' in result.rows[0], false);
});

test('break validation rejects incomplete, negative, overlapping, out-of-shift and nonfinite durations', () => {
  for (const breaks of [[{ startAt: 'bad', endAt: '2026-09-09T19:00:00Z' }], [{ startAt: '2026-09-09T19:00:00Z', endAt: '2026-09-09T18:00:00Z' }], [{ startAt: '2026-09-09T18:00:00Z' }], [{ startAt: '2026-09-09T18:00:00Z', endAt: '2026-09-09T20:00:00Z' }, { startAt: '2026-09-09T19:00:00Z', endAt: '2026-09-09T20:30:00Z' }], [{ startAt: '2026-09-09T13:00:00Z', endAt: '2026-09-09T15:00:00Z' }], 'garbage']) assert.throws(() => approvedTimecard(card({ breaks })));
  assert.throws(() => approvedTimecard(card({ clockOutAt: '2026-09-09T22:30:00' })), /invalid/);
});

test('date ranges are bounded, calendar-valid, inclusive and default to Denver dates', () => {
  assert.deepEqual(gustoDateRange(null, null, Date.parse('2026-09-09T03:00:00Z')), { start: '2026-09-02', end: '2026-09-08' });
  assert.deepEqual(gustoDateRange('2026-09-01', '2026-10-01'), { start: '2026-09-01', end: '2026-10-01' });
  for (const dates of [['2026-02-30', '2026-03-01'], ['2026-09-01', '2026-10-02'], ['2026-09-09', '2026-09-08'], [null, '2026-09-09']]) assert.throws(() => gustoDateRange(...dates));
});

test('roster whitelists identity/job fields and mappings verify confirmation, membership and uniqueness', async t => {
  const f = fixture(t), roster = await f.service.roster({});
  assert.deepEqual(Object.keys(roster[0]), ['uuid', 'name', 'email', 'jobs']); assert.deepEqual(Object.keys(roster[0].jobs[0]), ['uuid', 'title']);
  assert.equal(JSON.stringify(roster).includes('SECRET'), false);
  const valid = { username: 'Crew.Test', employeeUuid: employee, jobUuid: job, confirmed: true };
  await assert.rejects(f.service.mapEmployee({}, { ...valid, confirmed: false }), /Confirm/);
  await assert.rejects(f.service.mapEmployee({}, { ...valid, username: 'missing' }), /EGC timecard/);
  await assert.rejects(f.service.mapEmployee({}, { ...valid, jobUuid: otherJob }), /does not belong/);
  await f.service.mapEmployee({}, valid);
  f.cards.push(card({ id: 'shift-2', employee: 'Other' }));
  await assert.rejects(f.service.mapEmployee({}, { ...valid, username: 'Other' }), /already mapped/);
  f.employees[0].jobs[0].employee_uuid = otherEmployee;
  await assert.rejects(f.service.roster({}), /invalid employee job/);
});

test('classification requires three finite nonnegative categories summing to the current server hours', async t => {
  const f = fixture(t);
  for (const split of [{ regular: 8, overtime: 1, doubleOvertime: 0 }, { regular: 9, overtime: -1, doubleOvertime: 0 }, { regular: '8', overtime: 0, doubleOvertime: 0 }, { regular: Infinity, overtime: 0, doubleOvertime: 0 }, { regular: 7.9999, overtime: 0.0001, doubleOvertime: 0 }, { regular: 8 }]) await assert.rejects(f.service.classify({}, { timecardId: 'shift-1', ...split }));
  assert.equal(f.writes.length, 0);
  assert.equal((await f.sync()).results[0].status, 'error'); assert.equal(f.calls.some(call => call.method === 'POST'), false);
});

test('retrying the same successful content is a no-op; concurrent requests cannot create duplicates', async t => {
  const f = fixture(t); await f.ready();
  const results = await Promise.all([f.sync(), f.sync()]);
  assert.ok(results.some(result => result.results[0].status === 'synced'));
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal((await f.sync()).results[0].status, 'synced');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  const preview = await f.service.preview({}, '2026-09-09', '2026-09-09'); assert.equal(preview.rows[0].sync.status, 'synced');
});

test('approved timecard edits invalidate classification and a reviewed correction updates the stored UUID/version', async t => {
  const f = fixture(t); await f.ready(); await f.sync();
  const uuid = [...f.sheets.keys()][0]; f.cards[0].clockOutAt = '2026-09-09T23:30:00Z';
  assert.equal((await f.sync()).results[0].status, 'error');
  const preview = await f.service.preview({}, '2026-09-09', '2026-09-09'); assert.equal(preview.rows[0].sync.status, 'changed'); assert.equal(preview.rows[0].classification, null);
  await f.classify({ timecardId: 'shift-1', regular: 8, overtime: 1, doubleOvertime: 0 });
  assert.equal((await f.sync()).results[0].status, 'synced'); assert.deepEqual([...f.sheets.keys()], [uuid]);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
});

test('remote edits and hours already applied to payroll block corrections without overwriting Gusto', async t => {
  const f = fixture(t); await f.ready(); await f.sync();
  const remote = [...f.sheets.values()][0];
  await f.classify({ timecardId: 'shift-1', regular: 8, overtime: 0, doubleOvertime: 0 });
  remote.entries[0].hours_worked = 100;
  let result = await f.sync(); assert.match(result.results[0].message, /changed outside/);
  remote.entries[0].hours_worked = 7; remote.synced_to_payroll_at = '2026-09-10T00:00:00Z';
  result = await f.sync(); assert.match(result.results[0].message, /already been applied/);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
});

test('unchanged synced timecards are verified remotely before confirmation, including when applied to payroll', async t => {
  const f = fixture(t); await f.ready(); await f.sync();
  const remote = [...f.sheets.values()][0]; remote.synced_to_payroll_at = '2026-09-10T00:00:00Z';
  assert.equal((await f.sync()).results[0].status, 'synced');
  assert.ok(f.calls.some(call => call.method === 'GET' && call.path === `/v1/time_tracking/time_sheets/${remote.uuid}`));
  remote.entries[0].hours_worked = 100;
  let result = await f.sync(); assert.equal(result.results[0].status, 'error'); assert.match(result.results[0].message, /changed outside/);
  remote.entries[0].hours_worked = 7; f.sheets.delete(remote.uuid);
  result = await f.sync(); assert.equal(result.results[0].status, 'error'); assert.match(result.results[0].message, /missing/);
  f.requestHook(path => { if (path === `/v1/time_tracking/time_sheets/${remote.uuid}`) throw Object.assign(new Error('Synthetic missing sheet'), { status: 404, code: 'GUSTO_API_ERROR' }); });
  result = await f.sync(); assert.equal(result.results[0].status, 'error'); assert.match(result.results[0].message, /missing from Gusto/);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
});

test('a previously synced sheet cannot be reassigned to a different Gusto employee or job', async t => {
  const f = fixture(t); await f.ready(); await f.sync();
  await f.service.mapEmployee({}, { username: 'Crew.Test', employeeUuid: otherEmployee, jobUuid: otherJob, confirmed: true });
  await f.classify({ timecardId: 'shift-1', regular: 8, overtime: 0, doubleOvertime: 0 });
  let result = await f.sync(); assert.equal(result.results[0].status, 'error'); assert.match(result.results[0].message, /different Gusto employee or job/);
  const nextJob = '66666666-6666-4666-8666-666666666666'; f.employees[0].jobs.push({ uuid: nextJob, title: 'Second job', employee_uuid: employee });
  await f.service.mapEmployee({}, { username: 'Crew.Test', employeeUuid: employee, jobUuid: nextJob, confirmed: true });
  await f.classify({ timecardId: 'shift-1', regular: 8, overtime: 0, doubleOvertime: 0 });
  result = await f.sync(); assert.equal(result.results[0].status, 'error'); assert.match(result.results[0].message, /different Gusto employee or job/);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
});

test('a lost create response reconciles the exact remote metadata and payload without another POST', async t => {
  const f = fixture(t); await f.ready();
  f.afterRequestHook(() => { throw Object.assign(new Error('Synthetic lost response'), { status: 502, code: 'GUSTO_REQUEST_UNCERTAIN' }); });
  assert.equal((await f.sync()).results[0].status, 'uncertain');
  f.afterRequestHook(null);
  assert.equal((await f.sync()).results[0].status, 'synced');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('uncertain absence, ambiguous metadata and tampered remote contents never allow blind retry', async t => {
  const f = fixture(t); await f.ready();
  f.requestHook((_path, options) => { if (options.method === 'POST') throw Object.assign(new Error('Synthetic timeout'), { code: 'GUSTO_REQUEST_UNCERTAIN', status: 502 }); });
  assert.equal((await f.sync()).results[0].status, 'uncertain'); f.requestHook(null);
  assert.equal((await f.sync()).results[0].status, 'uncertain');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  const attempted = f.calls.find(call => call.method === 'POST').body;
  const recovered = { ...clone(attempted), uuid: crypto.randomUUID(), company_uuid: company, version: 'v1' }; recovered.entries[0].hours_worked = 100;
  f.sheets.set(recovered.uuid, recovered);
  assert.equal((await f.sync()).results[0].status, 'uncertain');
  recovered.entries[0].hours_worked = 7; const duplicate = { ...clone(recovered), uuid: crypto.randomUUID() }; f.sheets.set(duplicate.uuid, duplicate);
  assert.equal((await f.sync()).results[0].status, 'uncertain'); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('a final ledger persistence failure retains uncertainty and safely reconciles remote success', async t => {
  const f = fixture(t); await f.ready();
  let fail = true;
  const service = createGustoTimecardService({ ...f.dependencies, writeRecord: async (...args) => {
    if (fail && args[2].sync?.status === 'synced') throw Object.assign(new Error('Synthetic Firestore write failed'), { status: 400 });
    return f.dependencies.writeRecord(...args);
  } });
  assert.equal((await service.sync({}, await f.syncInput())).results[0].status, 'uncertain');
  fail = false;
  assert.equal((await service.sync({}, await f.syncInput())).results[0].status, 'synced');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('an explicit Gusto validation rejection can be retried without treating it as a successful sync', async t => {
  const f = fixture(t); await f.ready();
  f.requestHook((_path, options) => { if (options.method === 'POST') throw Object.assign(new Error('Synthetic rejected body'), { code: 'GUSTO_API_ERROR', status: 422 }); });
  assert.equal((await f.sync()).results[0].status, 'error'); assert.equal(f.sheets.size, 0);
  f.requestHook(null); assert.equal((await f.sync()).results[0].status, 'synced'); assert.equal(f.sheets.size, 1);
});

test('the final reread prevents sending a mapping changed while the lease was being acquired', async t => {
  const f = fixture(t); await f.ready();
  f.writeHook((key, data) => {
    if (data.sync?.status === 'sending') {
      const mapping = [...f.records.values()].find(value => value.data?.employees);
      mapping.data.employees['crew.test'].employeeUuid = otherEmployee; mapping.data.employees['crew.test'].jobUuid = otherJob;
    }
  });
  const result = await f.sync(); assert.equal(result.results[0].status, 'error'); assert.match(result.results[0].message, /mapping before syncing/);
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
});

test('a revoked approval or missing live Gusto job cannot sync even with previously saved mapping/classification', async t => {
  const f = fixture(t); await f.ready(); f.cards[0].approvalStatus = 'pending';
  assert.equal((await f.sync()).results[0].status, 'error');
  f.cards[0].approvalStatus = 'approved'; f.employees[0].jobs = [];
  assert.match((await f.sync()).results[0].message, /no longer available/); assert.equal(f.calls.some(call => call.method === 'POST'), false);
});

test('classification rejects a stale displayed review even when edited shift hours stay the same', async t => {
  const f = fixture(t); await f.ready();
  const before = await f.review('shift-1');
  f.cards[0].clockInAt = '2026-09-09T13:00:00Z'; f.cards[0].clockOutAt = '2026-09-09T21:30:00Z';
  await assert.rejects(f.service.classify({}, { timecardId: 'shift-1', regular: 8, overtime: 0, doubleOvertime: 0, reviewToken: before.reviewToken }), /changed since/);
  assert.equal((await f.review('shift-1')).classification, null);
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
});

test('remapping invalidates reviewed categories and stale sync confirmation cannot send new categories or mapping', async t => {
  const f = fixture(t); await f.ready(); const before = await f.syncInput();
  await f.classify({ timecardId: 'shift-1', regular: 8, overtime: 0, doubleOvertime: 0 });
  assert.match((await f.service.sync({}, before)).results[0].message, /changed since your sync review/);
  const splitReview = await f.review('shift-1');
  await f.service.mapEmployee({}, { username: 'Crew.Test', employeeUuid: otherEmployee, jobUuid: otherJob, confirmed: true });
  assert.equal((await f.review('shift-1')).classification, null);
  await assert.rejects(f.service.classify({}, { timecardId: 'shift-1', regular: 8, overtime: 0, doubleOvertime: 0, reviewToken: splitReview.reviewToken }), /changed since/);
  await f.classify({ timecardId: 'shift-1', regular: 8, overtime: 0, doubleOvertime: 0 });
  assert.match((await f.service.sync({}, before)).results[0].message, /changed since your sync review/);
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
});

test('missing transfer review tokens never authorize an outbound time-sheet write', async t => {
  const f = fixture(t); await f.ready();
  await assert.rejects(f.service.sync({}, { timecardIds: ['shift-1'] }), /review each selected transfer/);
  await assert.rejects(f.service.sync({}, { timecardIds: ['shift-1'], reviewTokens: { 'shift-1': 'bad' } }), /review each selected transfer/);
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
});

test('token refresh and connection preflight failures allow a safe later retry', async t => {
  const f = fixture(t); await f.ready();
  for (const code of ['GUSTO_BUSY', 'GUSTO_NOT_CONNECTED', 'GUSTO_STORAGE_ERROR', 'GUSTO_RECONNECT_REQUIRED']) {
    f.requestHook((_path, options) => { if (options.method === 'POST') throw Object.assign(new Error('Synthetic client preflight failure'), { status: 503, code }); });
    assert.equal((await f.sync()).results[0].status, 'error');
    assert.equal(f.sheets.size, 0);
  }
  f.requestHook(null); assert.equal((await f.sync()).results[0].status, 'synced'); assert.equal(f.sheets.size, 1);
});

test('batches report partial outcomes and reject unbounded, duplicate or malformed identifiers', async t => {
  const f = fixture(t); await f.ready();
  const result = await f.sync(['shift-1', 'missing']); assert.deepEqual(result.results.map(value => value.status), ['synced', 'error']);
  for (const ids of [[], ['shift-1', 'shift-1'], Array.from({ length: 26 }, (_, index) => String(index)), ['bad\u0000id'], [4]]) await assert.rejects(f.sync(ids));
});

test('API protects preview, roster and every mutation with owner identity plus business access', async () => {
  let calls = 0;
  for (const user of [null, { user: 'Crew.Test', businessAccess: false, role: 'crew' }, { user: 'TylerG', businessAccess: true, role: 'owner' }, { user: 'ZacB', businessAccess: false, role: 'owner' }, { user: 'ZacB', businessAccess: true, role: 'manager' }]) {
    const handlers = createGustoSyncHandlers({ session: async () => user, timecards: { roster: async () => { calls++; return []; }, sync: async () => { calls++; return {}; } } });
    const get = await handlers.onRequestGet({ env: {}, request: new Request('https://easygaragecleaning.com/api/gusto-sync?view=roster') });
    assert.equal(get.status, user ? 403 : 401);
    const post = await handlers.onRequestPost({ env: {}, request: new Request('https://easygaragecleaning.com/api/gusto-sync', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sync', timecardIds: ['shift-1'] }) }) });
    assert.equal(post.status, user ? 403 : 401);
  }
  assert.equal(calls, 0);
});

test('owner API enforces same-origin JSON body bounds and returns explicit partial results with no-store', async () => {
  let calls = 0;
  const handlers = createGustoSyncHandlers({ session: async () => ({ user: 'ZacB', businessAccess: true, role: 'owner' }), timecards: { sync: async () => { calls++; return { results: [{ id: 'shift-1', status: 'synced' }, { id: 'missing', status: 'error' }] }; } } });
  const post = (headers = {}, body = JSON.stringify({ action: 'sync', timecardIds: ['shift-1'] })) => handlers.onRequestPost({ env: {}, request: new Request('https://easygaragecleaning.com/api/gusto-sync', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json', ...headers }, body }) });
  assert.equal((await post({ Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ Origin: 'null' })).status, 403);
  assert.equal((await post({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post({ 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post({}, 'x'.repeat(16385))).status, 413);
  assert.equal((await post({}, '{')).status, 400);
  assert.equal((await post({}, '[]')).status, 400);
  const result = await post(); assert.equal(result.status, 200); assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual((await result.json()).results.map(value => value.status), ['synced', 'error']); assert.equal(calls, 1);
});

test('real API adapters read encrypted authoritative Hub timecards and persist encrypted CAS sync ledgers', async t => {
  const env = { GUSTO_ENVIRONMENT: 'demo', GUSTO_COMPANY_UUID: company, GUSTO_CLIENT_ID: 'synthetic-client', GUSTO_CLIENT_SECRET: 'synthetic-secret', GUSTO_REDIRECT_URI: 'https://easygaragecleaning.com/api/gusto-auth', FIREBASE_API_KEY: 'firebase-test-gusto-sync', EMPLOYEE_HUB_DATA_SECRET: 'synthetic-vault', HUB_SESSION_SECRET: 'synthetic-session', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { role: 'owner', passwordHash: 'test' } }) };
  const docs = new Map(), sheets = new Map(), outbound = []; let revision = 0;
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    if (url.hostname === 'firestore.googleapis.com') {
      if (url.pathname.endsWith('/documents:runQuery')) return Response.json([...docs.values()].filter(doc => doc.fields.recordType?.stringValue === 'employee_hub_v2').map(document => ({ document })));
      assert.match(url.pathname, /\/documents\/(jobs|gusto_integrations)\//);
      const path = url.pathname;
      if (method === 'PATCH') {
        const expected = url.searchParams.get('currentDocument.updateTime'), absent = url.searchParams.get('currentDocument.exists');
        if ((absent === 'false' && docs.has(path)) || (expected && docs.get(path)?.updateTime !== expected)) return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 412 });
        if (path.includes('/gusto_integrations/')) assert.ok(expected || absent === 'false', 'all integration persistence uses CAS');
        docs.set(path, { name: path.slice(4), ...JSON.parse(options.body), updateTime: `2026-09-09T00:00:00.${String(++revision).padStart(9, '0')}Z` });
      }
      return docs.has(path) ? Response.json(docs.get(path)) : Response.json({}, { status: 404 });
    }
    assert.equal(url.hostname, 'api.gusto-demo.com', 'real network is forbidden in this integration test');
    assert.equal(new Headers(options.headers).get('X-Gusto-API-Version'), '2026-06-15');
    assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer synthetic-access');
    if (url.pathname.endsWith('/employees')) return Response.json([{ uuid: employee, first_name: 'Crew', last_name: 'Test', email: 'crew@example.test', jobs: [{ uuid: job, title: 'Crew', employee_uuid: employee }], ssn: 'must-not-leak' }]);
    if (method === 'GET' && url.pathname.startsWith('/v1/time_tracking/time_sheets/')) return sheets.has(url.pathname.split('/').at(-1)) ? Response.json(sheets.get(url.pathname.split('/').at(-1))) : Response.json({}, { status: 404 });
    assert.equal(url.pathname, `/v1/companies/${company}/time_tracking/time_sheets`);
    if (method === 'GET') return Response.json([...sheets.values()]);
    assert.equal(method, 'POST'); outbound.push(JSON.parse(options.body));
    const sheet = { ...JSON.parse(options.body), uuid: crypto.randomUUID(), company_uuid: company, version: 'v1' }; sheets.set(sheet.uuid, sheet);
    return Response.json(sheet, { status: 201 });
  });
  const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  const postRequest = (path, body) => new Request(`https://easygaragecleaning.com/api/${path}`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const stored = await hubPost({ env, request: postRequest('employee-hub', { collection: 'timeEntries', id: 'shift-1', data: card({ hours: 999 }) }) }); assert.equal(stored.status, 200);
  await writeGustoRecord(env, 'oauth-tokens', { state: 'connected', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: Date.now() + 7200000, connectedAt: '2026-09-09T00:00:00Z' }, null);
  const post = async body => { const response = await syncPost({ env, request: postRequest('gusto-sync', body) }); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  const preview = async () => { const response = await syncGet({ env, request: new Request('https://easygaragecleaning.com/api/gusto-sync?start=2026-09-09&end=2026-09-09', { headers: { Cookie: cookie } }) }); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  await post({ action: 'map', username: 'Crew.Test', employeeUuid: employee, jobUuid: job, confirmed: true });
  const before = await preview(); assert.equal(before.rows[0].hours, 8);
  await post({ action: 'classify', timecardId: 'shift-1', regular: 8, overtime: 0, doubleOvertime: 0, reviewToken: before.rows[0].reviewToken });
  const reviewed = await preview();
  const input = { action: 'sync', timecardIds: ['shift-1'], reviewTokens: { 'shift-1': reviewed.rows[0].transferToken }, hours: 999 };
  assert.equal((await post(input)).results[0].status, 'synced'); assert.equal((await post(input)).results[0].status, 'synced');
  assert.equal(outbound.length, 1); assert.deepEqual(outbound[0].entries, [{ hours_worked: 8, pay_classification: 'Regular' }]);
  assert.equal((await preview()).rows[0].sync.status, 'synced');
  const integrations = [...docs.entries()].filter(([path]) => path.includes('/gusto_integrations/'));
  assert.ok(integrations.length >= 3); assert.equal(JSON.stringify(integrations).includes('synthetic-access'), false); assert.equal(JSON.stringify(integrations).includes('crew@example.test'), false);
});
