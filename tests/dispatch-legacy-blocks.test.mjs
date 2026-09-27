import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { legacyBlockMode, legacyBlockedDays, legacyBlockRow } from '../functions/_lib/dispatch-legacy-blocks.js';
import { mutateDispatch, mutateDispatchSelfAssignment, dispatchOverview } from '../functions/_lib/dispatch-service.js';
import { dispatchOpenings } from '../functions/_lib/dispatch-openings.js';
import { dispatchHandlers } from '../functions/api/dispatch.js';
import { mutateScheduledVisit, schedulingStorage } from '../functions/_lib/operations-scheduling.js';
import { scheduleInterval, occupiedDays } from '../functions/_lib/dispatch-time.js';

const NOW = '2026-09-22T12:00:00.000Z';
const manager = { user: 'zacb', displayName: 'Owner', role: 'owner', businessAccess: true };
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';

function fixture(mode = 'warn', blocked = ['2026-09-23']) {
  const rows = new Map([
    ['customers/c1', { id: 'c1', name: 'Test Customer', phone: '9705550100', address: '100 Test Street', revision: 'c1r' }],
    ...blocked.map(date => [`blocked_days/${date}`, { id: date, blockedBy: 'zacb', blockedAt: '2026-09-01T00:00:00.000Z', revision: 'legacy-r' }]),
  ]);
  const roster = [{ id: 'zacb', name: 'Owner', role: 'owner' }, { id: 'crew1', name: 'Crew One', role: 'crew' }, { id: 'crew2', name: 'Crew Two', role: 'crew' }];
  const all = collection => [...rows.entries()].filter(([key]) => key.startsWith(collection + '/')).map(([, value]) => structuredClone(value));
  const legacyReads = [], commits = [];
  let revision = 0;
  const store = {
    jobs: async () => all('jobs'), resources: async () => all('dispatchResources'), customers: async () => all('customers'), roster: async () => structuredClone(roster),
    read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null),
    legacyBlockMode: mode,
    legacyBlockedDays: async dates => { legacyReads.push(dates); return dates.filter(date => rows.has(`blocked_days/${date}`)); },
    commit: async writes => {
      for (const write of writes) {
        const old = rows.get(`${write.collection}/${write.id}`);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      commits.push(writes.map(write => `${write.collection}/${write.id}`));
      for (const write of writes) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...structuredClone(write.patch), id: write.id, revision: `r${++revision}` });
    },
  };
  const create = (changes = {}, extra = {}) => ({ action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'job', changes: { date: '2026-09-23', time: '08:00', endTime: '10:00', assignedCrew: ['crew1'], jobInstructions: 'Clean garage', ...changes }, ...extra });
  const edit = (id, changes = {}, action = 'schedule.update') => ({ action, requestId: randomUUID(), jobId: id, expectedRevision: rows.get('jobs/' + id).revision, changes });
  const mutate = input => mutateDispatch(store, manager, input, NOW);
  return { rows, store, legacyReads, commits, create, edit, mutate };
}
const legacyCommitted = f => f.commits.flat().some(key => key.startsWith('blocked_days/'));

test('the legacy block mode defaults to off; warn and enforce are explicit opt-ins', () => {
  assert.equal(legacyBlockMode({}), 'off');
  assert.equal(legacyBlockMode(undefined), 'off');
  assert.equal(legacyBlockMode({ EGC_DISPATCH_LEGACY_BLOCKED_DAYS: '' }), 'off');
  assert.equal(legacyBlockMode({ EGC_DISPATCH_LEGACY_BLOCKED_DAYS: ' Enforce ' }), 'enforce');
  assert.equal(legacyBlockMode({ EGC_DISPATCH_LEGACY_BLOCKED_DAYS: 'warn' }), 'warn');
  assert.equal(legacyBlockMode({ EGC_DISPATCH_LEGACY_BLOCKED_DAYS: 'off' }), 'off');
  assert.equal(legacyBlockMode({ EGC_DISPATCH_LEGACY_BLOCKED_DAYS: 'strict' }), 'off', 'an unknown value never turns the reads on');
  const row = legacyBlockRow('2026-09-23');
  assert.equal(row.type, 'blocked'); assert.deepEqual(row.assignedCrew, []);
  assert.deepEqual(occupiedDays(row), ['2026-09-23'], 'a legacy block covers exactly one Denver day');
  assert.equal(scheduleInterval(row).startAt, '2026-09-23T06:00:00.000Z'); assert.equal(scheduleInterval(row).endAt, '2026-09-24T06:00:00.000Z');
});

test('storage reads blocked_days documents read-only and fails closed on unreadable or mismatched records', async () => {
  const calls = [];
  const fetcher = async (_env, input, init = {}) => {
    const url = new URL(input), date = decodeURIComponent(url.pathname.split('/').pop());
    calls.push({ url, method: init.method || 'GET' });
    if (date === '2026-09-23') return Response.json({ name: `${ROOT}/blocked_days/${date}`, fields: encodeFirestoreFields({ blockedAt: NOW }), updateTime: '2026-09-01T00:00:00.000000Z' });
    if (date === '2026-09-26') return Response.json({}, { status: 500 });
    if (date === '2026-09-27') return Response.json({ name: `${ROOT}/blocked_days/2026-09-28`, updateTime: '2026-09-01T00:00:00.000000Z' });
    return Response.json({}, { status: 404 });
  };
  const store = dispatchStorage({ EGC_DISPATCH_LEGACY_BLOCKED_DAYS: 'enforce' }, fetcher);
  assert.equal(store.legacyBlockMode, 'enforce');
  assert.deepEqual(await store.legacyBlockedDays(['2026-09-23', '2026-09-24']), ['2026-09-23']);
  assert.ok(calls.every(call => call.method === 'GET' && call.url.pathname.includes('/documents/blocked_days/') && call.url.searchParams.get('mask.fieldPaths') === 'blockedAt'));
  await assert.rejects(store.legacyBlockedDays(['2026-09-26']), error => error.code === 'dispatch_storage_unavailable');
  await assert.rejects(store.legacyBlockedDays(['2026-09-27']), error => error.code === 'dispatch_storage_incomplete');
  const off = await legacyBlockedDays({ legacyBlockMode: 'off', legacyBlockedDays: async () => { throw new Error('must not read'); } }, ['2026-09-23']);
  assert.deepEqual(off, { mode: 'off', rows: [] });
  assert.deepEqual(await legacyBlockedDays({ legacyBlockedDays: async () => { throw new Error('must not read'); } }, ['2026-09-23']), { mode: 'off', rows: [] }, 'a reader without an explicit mode stays off');
  assert.deepEqual(await legacyBlockedDays({ read: async () => null }, ['2026-09-23']), { mode: 'off', rows: [] }, 'stores without the reader keep legacy behavior');
  assert.deepEqual((await legacyBlockedDays({ legacyBlockMode: 'warn', legacyBlockedDays: async dates => dates }, ['bad', '2026-09-23', '2026-09-23'])).rows.map(row => row.date), ['2026-09-23']);
  await assert.rejects(legacyBlockedDays({ legacyBlockMode: 'warn', legacyBlockedDays: async () => null }, ['2026-09-23']), error => error.code === 'dispatch_storage_incomplete');
});

test('with the env flag unset, production storage performs zero blocked_days reads and dispatch is unchanged', async () => {
  const reads = [];
  const fetcher = async (_env, input) => { reads.push(String(input)); return Response.json({ name: `${ROOT}/blocked_days/2026-09-23`, updateTime: '2026-09-01T00:00:00.000000Z' }); };
  for (const env of [{}, { EGC_DISPATCH_LEGACY_BLOCKED_DAYS: 'unexpected' }]) {
    const store = dispatchStorage(env, fetcher);
    assert.equal(store.legacyBlockMode, 'off');
    assert.deepEqual(await legacyBlockedDays(store, ['2026-09-23', '2026-09-24']), { mode: 'off', rows: [] });
    assert.equal(schedulingStorage(env, fetcher).legacyBlockMode, 'off');
  }
  assert.deepEqual(reads, [], 'no blocked_days document is requested by default');

  // The same blocked day that warn/enforce honor below is invisible by default.
  const f = fixture(legacyBlockMode({}));
  const result = await f.mutate(f.create());
  assert.equal(result.job.status, 'scheduled');
  assert.equal(result.warnings.some(row => row.code === 'legacy_blocked_day'), false);
  const openings = await dispatchOpenings(f.store, manager, { startDate: '2026-09-23', endDate: '2026-09-25', employeeIds: 'crew2', durationMinutes: '60', travelBufferMinutes: '0' }, new Date(NOW));
  assert.deepEqual(openings.candidates.map(row => row.date), ['2026-09-23', '2026-09-24'], 'openings are unchanged');
  assert.equal(openings.warnings.some(row => row.code === 'legacy_blocked_day'), false);
  f.rows.delete('blocked_days/2026-09-23');
  const shift = await f.mutate(f.create({ date: '2026-09-24', assignedCrew: [], crewNeeded: 1, shiftPickupEnabled: true }));
  f.rows.set('blocked_days/2026-09-24', { id: '2026-09-24', revision: 'legacy-r' });
  const claim = await mutateDispatchSelfAssignment(f.store, { user: 'crew1' }, { action: 'claim', jobId: shift.job.id, requestId: randomUUID() }, NOW);
  assert.equal(claim.warnings.some(row => row.code === 'legacy_blocked_day'), false);
  assert.deepEqual(f.legacyReads, [], 'the default performs zero legacy reads');
});

test('warn mode saves work on a legacy blocked day with an explicit warning and never writes the legacy record', async () => {
  const f = fixture('warn'), input = f.create(), result = await f.mutate(input);
  assert.equal(result.job.status, 'scheduled');
  assert.deepEqual(result.warnings.filter(row => row.code === 'legacy_blocked_day').map(row => [row.jobId, row.date]), [[result.job.id, '2026-09-23']]);
  assert.ok(f.rows.get('dispatchOperations/' + input.requestId).warnings.some(row => row.code === 'legacy_blocked_day'), 'the receipt replays the warning');
  assert.equal(legacyCommitted(f), false);
  const clear = await f.mutate(f.create({ date: '2026-09-24' }));
  assert.equal(clear.warnings.some(row => row.code === 'legacy_blocked_day'), false);
});

test('enforce mode rejects placing work on a blocked day but keeps existing work editable and cancellable', async () => {
  const f = fixture('enforce');
  const before = f.commits.length;
  await assert.rejects(f.mutate(f.create()), error => error.code === 'dispatch_conflict' && error.status === 409 && error.details.conflicts[0].code === 'legacy_blocked_day' && error.details.conflicts[0].date === '2026-09-23');
  assert.equal(f.commits.length, before, 'a rejected placement commits nothing');

  const other = await f.mutate(f.create({ date: '2026-09-24' }));
  await assert.rejects(f.mutate(f.edit(other.job.id, { date: '2026-09-23' })), error => error.code === 'dispatch_conflict');
  await assert.rejects(f.mutate(f.create({ date: '2026-09-22', endDate: '2026-09-24', time: '20:00', endTime: '06:00' }, { customerId: 'c1' })), error => error.details.conflicts.some(row => row.date === '2026-09-23'), 'multi-day work cannot span a blocked day');

  // Work booked before the legacy toggle stays editable, cancellable and restorable only off the day.
  f.rows.delete('blocked_days/2026-09-23');
  const existing = await f.mutate(f.create({ date: '2026-09-23', time: '12:00', endTime: '13:00' }));
  f.rows.set('blocked_days/2026-09-23', { id: '2026-09-23', revision: 'legacy-r' });
  const noted = await f.mutate(f.edit(existing.job.id, { notes: 'Bring extra bins', assignedCrew: ['crew2'] }));
  assert.equal(noted.job.notes, 'Bring extra bins');
  const cancelled = await f.mutate(f.edit(existing.job.id, {}, 'schedule.cancel'));
  assert.equal(cancelled.job.status, 'cancelled');
  await assert.rejects(f.mutate(f.edit(existing.job.id, {}, 'schedule.restore')), error => error.code === 'dispatch_conflict');

  const block = await f.mutate({ action: 'schedule.create', requestId: randomUUID(), kind: 'blocked', changes: { date: '2026-09-23', time: '00:00', endDate: '2026-09-24', endTime: '00:00' } });
  assert.equal(block.job.type, 'blocked', 'a native block may be placed on a legacy blocked day');
  assert.equal(legacyCommitted(f), false);
});

test('off mode performs no legacy reads and keeps prior behavior', async () => {
  const f = fixture('off'), result = await f.mutate(f.create());
  assert.equal(result.job.status, 'scheduled');
  assert.equal(result.warnings.some(row => row.code === 'legacy_blocked_day'), false);
  assert.deepEqual(f.legacyReads, []);
});

test('shift pickup on a blocked day is rejected only when enforced', async () => {
  for (const mode of ['warn', 'enforce']) {
    const f = fixture(mode);
    f.rows.delete('blocked_days/2026-09-23');
    const created = await f.mutate(f.create({ assignedCrew: [], crewNeeded: 1, shiftPickupEnabled: true }));
    f.rows.set('blocked_days/2026-09-23', { id: '2026-09-23', revision: 'legacy-r' });
    const claim = mutateDispatchSelfAssignment(f.store, { user: 'crew1' }, { action: 'claim', jobId: created.job.id, requestId: randomUUID() }, NOW);
    if (mode === 'enforce') {
      await assert.rejects(claim, error => error.code === 'dispatch_conflict' && error.details.conflicts[0].code === 'legacy_blocked_day');
      assert.deepEqual(f.rows.get('jobs/' + created.job.id).assignedCrew, []);
    } else {
      const result = await claim;
      assert.deepEqual(result.job.assignedCrew, ['crew1']);
      assert.ok(result.warnings.some(row => row.code === 'legacy_blocked_day'));
    }
  }
});

test('capacity suggestions skip legacy blocked days in warn and enforce modes', async () => {
  const query = { startDate: '2026-09-23', endDate: '2026-09-25', employeeIds: 'crew1', durationMinutes: '60', travelBufferMinutes: '0' };
  for (const mode of ['warn', 'enforce']) {
    const f = fixture(mode), result = await dispatchOpenings(f.store, manager, query, new Date(NOW));
    assert.equal(result.candidates.some(row => row.date === '2026-09-23'), false);
    assert.deepEqual(result.candidates.map(row => [row.date, row.time, row.endTime, row.gapMinutes]), [['2026-09-24', '08:00', '09:00', 540]]);
    assert.deepEqual(result.warnings.filter(row => row.code === 'legacy_blocked_day').map(row => row.date), ['2026-09-23']);
    assert.equal(result.coverage.complete, true);
  }
  const off = await dispatchOpenings(fixture('off').store, manager, query, new Date(NOW));
  assert.deepEqual(off.candidates.map(row => row.date), ['2026-09-23', '2026-09-24']);
});

test('the dispatch overview never lists synthetic legacy rows as editable jobs', async () => {
  const f = fixture('enforce'), overview = await dispatchOverview(f.store, manager, { startDate: '2026-09-22', endDate: '2026-09-29' }, new Date(NOW));
  assert.deepEqual(overview.jobs, []);
});

test('the dispatch API returns the enforced legacy conflict as a structured 409', async () => {
  const f = fixture('enforce'), handlers = dispatchHandlers({ session: async () => manager, storage: () => f.store, now: () => new Date(NOW) });
  const response = await handlers.post({ env: {}, request: new Request('https://easygaragecleaning.com/api/dispatch', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(f.create()) }) });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, 'dispatch_conflict');
  assert.equal(body.details.conflicts[0].code, 'legacy_blocked_day');
  assert.match(body.error, /blocked on the Hub calendar/);
});

test('the dispatch API threads its injected clock into reads (Date) and mutations (ISO string)', async () => {
  const f = fixture('warn'), handlers = dispatchHandlers({ session: async () => manager, storage: () => f.store, now: () => new Date(NOW) });
  const input = f.create();
  const saved = await handlers.post({ env: {}, request: new Request('https://easygaragecleaning.com/api/dispatch', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) });
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.equal(body.job.updatedAt, NOW);
  assert.equal(f.rows.get('dispatchOperations/' + input.requestId).createdAt, NOW);
  assert.ok(body.warnings.some(row => row.code === 'legacy_blocked_day'));
  const overview = await (await handlers.get({ env: {}, request: new Request('https://easygaragecleaning.com/api/dispatch') })).json();
  assert.equal(overview.coverage.asOf, NOW);
  assert.deepEqual([overview.startDate, overview.endDate], ['2026-09-22', '2026-09-29'], 'the default window starts on the injected Denver day');
  assert.deepEqual(overview.jobs.map(job => job.id), [body.job.id]);
});

test('the operations scheduler honors enforced legacy blocks and skips the read otherwise', async () => {
  for (const mode of ['warn', 'enforce']) {
    const f = fixture(mode);
    f.rows.set('customers/customer-a', { id: 'customer-a', name: 'Synthetic customer', highlevelContactId: 'contact-a', revision: 'customer-r1' });
    const store = { ...f.store, day: async date => [...f.rows.entries()].filter(([k, v]) => k.startsWith('jobs/') && v.date === date).map(([, v]) => structuredClone(v)) };
    const actor = { id: 'verified-grant', kind: 'integration', role: 'integration', workspace: 'egc' };
    const visit = mutateScheduledVisit(store, actor, { command: 'schedule.mutate', requestId: randomUUID(), mode: 'create', portalCustomerId: 'customer-a', kind: 'walkthrough', changes: { date: '2026-09-23', time: '10:00', endTime: '11:00' } }, NOW);
    if (mode === 'enforce') await assert.rejects(visit, /schedule_slot_conflict/);
    else { assert.equal((await visit).ok, true); assert.deepEqual(f.legacyReads, []); }
  }
  const failing = schedulingStorage({ EGC_DISPATCH_LEGACY_BLOCKED_DAYS: 'enforce' }, async () => Response.json({}, { status: 500 }));
  assert.equal(failing.legacyBlockMode, 'enforce');
  await assert.rejects(failing.legacyBlockedDays(['2026-09-23']), error => error.code === 'dispatch_storage_unavailable');
});
