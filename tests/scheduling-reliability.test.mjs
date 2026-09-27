import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { mutateDispatch, mutateDispatchSelfAssignment } from '../functions/_lib/dispatch-service.js';
import { scheduleDayEntry, scheduleLockConflict } from '../functions/_lib/dispatch-conflicts.js';
import { scheduleInterval } from '../functions/_lib/dispatch-time.js';
import { mutateScheduledVisit } from '../functions/_lib/operations-scheduling.js';

const NOW = '2026-09-22T12:00:00.000Z';
const manager = { user: 'zacb', displayName: 'Owner', role: 'owner', businessAccess: true };

function dispatchFixture() {
  const rows = new Map([['customers/c1', { id: 'c1', name: 'Test Customer', phone: '9705550100', address: '100 Test Street', revision: 'c1r' }]]);
  const roster = [{ id: 'zacb', name: 'Owner', role: 'owner' }, { id: 'crew1', name: 'Crew One', role: 'crew' }, { id: 'crew2', name: 'Crew Two', role: 'crew' }];
  const all = collection => [...rows.entries()].filter(([key]) => key.startsWith(collection + '/')).map(([, value]) => structuredClone(value));
  let revision = 0;
  const store = {
    jobs: async () => all('jobs'), resources: async () => all('dispatchResources'), customers: async () => all('customers'), roster: async () => structuredClone(roster),
    read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null),
    commit: async writes => {
      const seen = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = rows.get(key);
        assert.ok(!seen.has(key), 'No duplicate writes per document'); seen.add(key);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      for (const write of writes) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...structuredClone(write.patch), id: write.id, revision: `r${++revision}` });
    },
  };
  const openShift = async (changes = {}) => {
    const created = await mutateDispatch(store, manager, { action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'job', changes: { date: '2026-09-23', time: '08:00', endTime: '10:00', assignedCrew: [], crewNeeded: 2, shiftPickupEnabled: true, jobInstructions: 'Clean garage', ...changes } }, NOW);
    assert.equal(rows.get('jobs/' + created.job.id).openShift, true);
    return created.job.id;
  };
  return { rows, roster, store, openShift };
}

test('shift pickup and release rewrite day locks with the shared scheduleDayEntry contract', async () => {
  const f = dispatchFixture(), id = await f.openShift();
  const claim = await mutateDispatchSelfAssignment(f.store, { user: 'crew1' }, { action: 'claim', jobId: id, requestId: randomUUID() }, NOW);
  const saved = f.rows.get('jobs/' + id);
  assert.deepEqual(saved.assignedCrew, ['crew1']);
  const [entry] = f.rows.get('jobs/_egc_schedule_lock_2026-09-23').entries;
  assert.deepEqual(entry, scheduleDayEntry(saved, '2026-09-23', f.roster, NOW));
  assert.equal(entry.type, 'job'); assert.equal(entry.assignmentKnown, true); assert.deepEqual(entry.assignedCrew, ['crew1']);
  assert.equal(entry.status, 'scheduled'); assert.equal(entry.label, 'Test Customer'); assert.equal(entry.updatedAt, NOW);
  assert.deepEqual(claim.warnings, []);

  await mutateDispatchSelfAssignment(f.store, { user: 'crew1' }, { action: 'release', jobId: id, requestId: randomUUID() }, NOW);
  const released = f.rows.get('jobs/' + id), [after] = f.rows.get('jobs/_egc_schedule_lock_2026-09-23').entries;
  assert.deepEqual(after, scheduleDayEntry(released, '2026-09-23', f.roster, NOW));
  assert.deepEqual(after.assignedCrew, []); assert.equal(after.assignmentKnown, true, 'a native empty crew is known, not an unknown global reservation');
  assert.equal(scheduleLockConflict({ id: 'other', type: 'job', date: '2026-09-23', time: '09:00', endTime: '11:00', assignedCrew: ['crew2'] }, after, '2026-09-23', f.roster), false);
});

test('multi-day shift pickup writes each occupied day with local start and end boundaries', async () => {
  const f = dispatchFixture(), id = await f.openShift({ date: '2026-09-23', endDate: '2026-09-25', time: '15:00', endTime: '00:00' });
  await mutateDispatchSelfAssignment(f.store, { user: 'crew2' }, { action: 'claim', jobId: id, requestId: randomUUID() }, NOW);
  const saved = f.rows.get('jobs/' + id);
  assert.deepEqual(f.rows.get('jobs/_egc_schedule_lock_2026-09-23').entries.map(entry => [entry.start, entry.end, entry.type]), [['15:00', '24:00', 'job']]);
  assert.deepEqual(f.rows.get('jobs/_egc_schedule_lock_2026-09-24').entries, [scheduleDayEntry(saved, '2026-09-24', f.roster, NOW)]);
  assert.deepEqual(f.rows.get('jobs/_egc_schedule_lock_2026-09-24').entries[0].start, '00:00');
  assert.equal(f.rows.has('jobs/_egc_schedule_lock_2026-09-25'), false, 'an end at midnight releases the final day');
});

function visitFixture() {
  const rows = new Map([['customers/customer-a', { id: 'customer-a', name: 'Synthetic customer', highlevelContactId: 'contact-a', revision: 'customer-r1' }]]); let revision = 0;
  const store = {
    read: async (c, id) => structuredClone(rows.get(`${c}/${id}`) || null),
    day: async date => [...rows.entries()].filter(([k, v]) => k.startsWith('jobs/') && v.date === date).map(([, v]) => structuredClone(v)),
    commit: async writes => {
      for (const w of writes) { const prior = rows.get(`${w.collection}/${w.id}`); if (w.revision ? prior?.revision !== w.revision : Boolean(prior)) throw Object.assign(new Error('schedule_revision_conflict'), { status: 409 }); }
      for (const w of writes) rows.set(`${w.collection}/${w.id}`, { ...rows.get(`${w.collection}/${w.id}`), ...structuredClone(w.patch), id: w.id, revision: `r${++revision}` });
      return {};
    },
  };
  const actor = { id: 'verified-grant', kind: 'integration', role: 'integration', workspace: 'egc' };
  const input = (extra = {}) => ({ command: 'schedule.mutate', requestId: randomUUID(), mode: 'create', portalCustomerId: 'customer-a', kind: 'walkthrough', changes: { date: '2026-09-23', time: '10:00', endTime: '11:00' }, ...extra });
  const mutate = value => mutateScheduledVisit(store, actor, value, NOW);
  return { rows, store, input, mutate };
}
const derived = row => ({ date: row.date, endDate: row.endDate, startAt: row.startAt, endAt: row.endAt, timeZone: row.timeZone });

test('operations visit create, reschedule and cancel keep derived UTC instants in step with Denver wall time', async () => {
  const f = visitFixture(), created = await f.mutate(f.input()), id = created.visit.portalVisitId;
  assert.deepEqual(derived(f.rows.get('jobs/' + id)), { date: '2026-09-23', endDate: '2026-09-23', startAt: '2026-09-23T16:00:00.000Z', endAt: '2026-09-23T17:00:00.000Z', timeZone: 'America/Denver' });
  const interval = scheduleInterval(f.rows.get('jobs/' + id));
  assert.equal(interval.startAt, f.rows.get('jobs/' + id).startAt); assert.equal(interval.endAt, f.rows.get('jobs/' + id).endAt);

  // Standard time after the November change uses the -07:00 offset.
  const moved = await f.mutate(f.input({ mode: 'update', portalVisitId: id, expectedRevision: f.rows.get('jobs/' + id).revision, changes: { date: '2026-12-02', time: '13:30', endTime: '15:00' } }));
  assert.equal(moved.visit.startTime, '2026-12-02T20:30:00.000Z');
  assert.deepEqual(derived(f.rows.get('jobs/' + id)), { date: '2026-12-02', endDate: '2026-12-02', startAt: '2026-12-02T20:30:00.000Z', endAt: '2026-12-02T22:00:00.000Z', timeZone: 'America/Denver' });

  await f.mutate(f.input({ mode: 'cancel', portalVisitId: id, expectedRevision: f.rows.get('jobs/' + id).revision, changes: {} }));
  const cancelled = f.rows.get('jobs/' + id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.startAt, '2026-12-02T20:30:00.000Z'); assert.equal(cancelled.endDate, '2026-12-02');
});

test('a legacy single-day visit without derived fields gains them on its next operations update without breaking replay', async () => {
  const f = visitFixture();
  f.rows.set('jobs/legacy', { id: 'legacy', type: 'job', customerId: 'customer-a', highlevelContactId: 'contact-a', date: '2026-09-24', time: '09:00', endTime: '12:00', status: 'scheduled', startAt: '2026-01-01T00:00:00.000Z', revision: 'legacy-r1' });
  const request = f.input({ mode: 'update', portalVisitId: 'legacy', expectedRevision: 'legacy-r1', kind: 'job', changes: { title: 'Updated title' } });
  await f.mutate(request);
  assert.deepEqual(derived(f.rows.get('jobs/legacy')), { date: '2026-09-24', endDate: '2026-09-24', startAt: '2026-09-24T15:00:00.000Z', endAt: '2026-09-24T18:00:00.000Z', timeZone: 'America/Denver' });
  const replay = await f.mutate(request);
  assert.equal(replay.replayed, true, 'the receipt schedule hash is unchanged by the derived fields');
});

function suiteFixture() {
  const storage = { getItem: () => null };
  const context = { crypto, structuredClone, console: { log() {}, error() {} }, URLSearchParams, Date, Intl, Promise, Set, Map, Error, JSON, sessionStorage: storage, localStorage: storage, navigator: {}, location: { pathname: '/employee', search: '' }, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}, addEventListener() {}, jobsCache: [], document: { readyState: 'loading', hidden: false, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} } };
  context.window = context;
  const source = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8').replace(/\}\)\(\);\s*$/, 'globalThis.ui={syncPayload};})();');
  vm.runInNewContext(source, context);
  return context.ui;
}
const hubJob = (extra = {}) => ({ id: 'hub-synthetic', type: 'job', date: '2026-09-22', time: '16:00', endTime: '18:00', status: 'scheduled', customer: 'Synthetic', syncIdempotencyKey: 'schedule:synthetic:stable', ...extra });

test('calendar sync sends the real end instant of multi-day jobs and still rejects impossible spans', () => {
  const ui = suiteFixture();
  const overnight = ui.syncPayload(hubJob({ endDate: '2026-09-23', endTime: '09:00' }));
  assert.equal(overnight.start_time, '2026-09-22T22:00:00.000Z');
  assert.equal(overnight.end_time, '2026-09-23T15:00:00.000Z');
  const multiDay = ui.syncPayload(hubJob({ endDate: '2026-09-24', endTime: '18:00' }));
  assert.equal(multiDay.end_time, '2026-09-25T00:00:00.000Z');
  assert.equal(ui.syncPayload(hubJob()).end_time, '2026-09-23T00:00:00.000Z', 'single-day jobs are unchanged');
  assert.equal(ui.syncPayload(hubJob({ endDate: '' })).end_time, '2026-09-23T00:00:00.000Z', 'a blank legacy endDate falls back to the start date');
  assert.throws(() => ui.syncPayload(hubJob({ endDate: '2026-09-21' })), /unambiguous Mountain/);
});

test('game plan handoff quotes carry the multi-day end instant', () => {
  const ui = suiteFixture();
  const payload = ui.syncPayload(hubJob({ endDate: '2026-09-23', endTime: '12:00', sourceWalkthroughId: 'walk-1', internalNotes: 'Crew notes', acceptance: { acceptedAt: NOW, signatureCaptured: true } }));
  assert.equal(payload.tool, 'game_plan');
  assert.equal(payload.quote.start_at, '2026-09-22T22:00:00.000Z');
  assert.equal(payload.quote.end_at, '2026-09-23T18:00:00.000Z');
});
