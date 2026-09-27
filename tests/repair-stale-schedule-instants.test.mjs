import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REPAIR_SCAN_FIELDS, inspectScheduleInstants, planScheduleInstantRepairs, repairedLockEntries,
  applyScheduleInstantRepair, runScheduleInstantRepair, formatScheduleRepairReport,
} from '../scripts/repair-stale-schedule-instants.mjs';

const NOW = '2026-09-22T12:00:00.000Z';
const TZ = 'America/Denver';
// Synthetic fixtures. September is MDT (UTC-6): 09:00 Denver is 15:00Z.
const job = (id, fields) => ({ id, type: 'job', status: 'scheduled', pipelineStatus: 'scheduled', revision: `${id}-r1`, customer: 'Synthetic Customer', ...fields });
const consistent = job('consistent', { date: '2026-09-23', time: '09:00', endDate: '2026-09-23', endTime: '11:00', startAt: '2026-09-23T15:00:00.000Z', endAt: '2026-09-23T17:00:00.000Z', timeZone: TZ });
// Bridge moved a dispatch-created 2026-09-20 13:00-15:00 visit to a later day.
const movedLater = job('moved-later', { date: '2026-09-23', time: '09:00', endTime: '11:00', endDate: '2026-09-20', startAt: '2026-09-20T19:00:00.000Z', endAt: '2026-09-20T21:00:00.000Z', timeZone: TZ });
// Bridge changed only the time on the same day.
const timeOnly = job('time-only', { date: '2026-09-23', time: '13:00', endTime: '15:00', endDate: '2026-09-23', startAt: '2026-09-23T15:00:00.000Z', endAt: '2026-09-23T17:00:00.000Z', timeZone: TZ });
// Bridge moved a 2026-09-25 13:00-15:00 visit to an earlier day; it now looks multi-day.
const movedEarlier = job('moved-earlier', { date: '2026-09-23', time: '09:00', endTime: '11:00', endDate: '2026-09-25', startAt: '2026-09-25T19:00:00.000Z', endAt: '2026-09-25T21:00:00.000Z', timeZone: TZ });
const bridgeAfter = { date: '2026-09-23', time: '09:00', endTime: '11:00' };

test('stale instants are recomputed from the Denver wall clock', () => {
  assert.equal(inspectScheduleInstants(consistent), null);
  assert.equal(inspectScheduleInstants({ ...consistent, startAt: '2026-09-23T15:00:00Z', endAt: '2026-09-23T11:00:00-06:00' }), null, 'equivalent instant spellings are not rewritten');

  const later = inspectScheduleInstants(movedLater);
  assert.equal(later.action, 'repair');
  assert.deepEqual(later.reasons, ['end_date_before_date', 'start_at_stale', 'end_at_stale']);
  assert.deepEqual(later.patch, { endDate: '2026-09-23', startAt: '2026-09-23T15:00:00.000Z', endAt: '2026-09-23T17:00:00.000Z', timeZone: TZ });
  assert.deepEqual(later.before, { endDate: '2026-09-20', startAt: '2026-09-20T19:00:00.000Z', endAt: '2026-09-20T21:00:00.000Z', timeZone: TZ });
  assert.deepEqual([later.id, later.revision, later.status], ['moved-later', 'moved-later-r1', 'scheduled']);

  const time = inspectScheduleInstants(timeOnly);
  assert.deepEqual(time.reasons, ['start_at_stale', 'end_at_stale']);
  assert.deepEqual(time.patch, { endDate: '2026-09-23', startAt: '2026-09-23T19:00:00.000Z', endAt: '2026-09-23T21:00:00.000Z', timeZone: TZ });

  assert.deepEqual(inspectScheduleInstants({ ...consistent, timeZone: 'UTC' }).reasons, ['time_zone_mismatch']);
});

test('a later endDate collapses only when the bridge wrote the current wall clock', () => {
  const evidenced = inspectScheduleInstants(movedEarlier, bridgeAfter);
  assert.deepEqual(evidenced.reasons, ['bridge_reschedule_kept_old_end_date', 'start_at_stale', 'end_at_stale']);
  assert.deepEqual(evidenced.patch, { endDate: '2026-09-23', startAt: '2026-09-23T15:00:00.000Z', endAt: '2026-09-23T17:00:00.000Z', timeZone: TZ });

  // Without that evidence endDate is an authoritative wall-clock field (for example a
  // manual multi-day edit), so it is kept and only the instants are recomputed.
  for (const evidence of [null, { ...bridgeAfter, date: '2026-09-22' }]) {
    const kept = inspectScheduleInstants(movedEarlier, evidence);
    assert.deepEqual(kept.reasons, ['start_at_stale', 'end_at_stale']);
    assert.deepEqual(kept.patch, { endDate: '2026-09-25', startAt: '2026-09-23T15:00:00.000Z', endAt: '2026-09-25T17:00:00.000Z', timeZone: TZ });
  }
  const overnight = job('overnight', { date: '2026-09-23', time: '20:00', endDate: '2026-09-24', endTime: '06:00', startAt: '2026-09-24T02:00:00.000Z', endAt: '2026-09-24T12:00:00.000Z', timeZone: TZ });
  assert.equal(inspectScheduleInstants(overnight, { date: '2026-09-23', time: '20:00', endTime: '06:00' }), null, 'consistent multi-day work is untouched');
  const blocked = job('blocked', { type: 'blocked', date: '2026-09-23', time: '00:00', endDate: '2026-09-24', endTime: '00:00', startAt: '2026-09-23T06:00:00.000Z', endAt: '2026-09-24T06:00:00.000Z', timeZone: TZ });
  assert.equal(inspectScheduleInstants(blocked), null);
});

test('out-of-scope, underived and unrepairable rows are skipped or sent to review', () => {
  const wall = { date: '2026-09-23', time: '09:00', endTime: '11:00', endDate: '2026-09-20', startAt: '2026-09-20T19:00:00.000Z' };
  for (const row of [
    job('_egc_schedule_lock_2026-09-23', { ...wall, recordType: 'schedule_lock' }), job('secure_x', wall), job('native-time-off', { ...wall, recordType: 'crew_availability', type: 'availability' }),
    job('legacy-time-off', { ...wall, type: 'availability' }), job('all-day', { ...wall, allDay: true }), job('unscheduled', { status: 'unscheduled', date: '', time: '', endTime: '' }),
    job('bridge-created', { date: '2026-09-23', time: '09:00', endTime: '11:00' }), job('no-end-time', { date: '2026-09-23', time: '09:00', startAt: '2026-09-20T19:00:00.000Z' }),
  ]) assert.equal(inspectScheduleInstants(row), null, row.id);

  const ambiguous = job('dst-ambiguous', { date: '2026-11-01', time: '01:30', endDate: '2026-11-01', endTime: '03:00', startAt: '2026-11-01T07:30:00.000Z' });
  assert.deepEqual([inspectScheduleInstants(ambiguous).action, inspectScheduleInstants(ambiguous).reason], ['review', 'wall_time_invalid']);
  assert.equal(inspectScheduleInstants({ ...ambiguous, startAt: undefined }), null, 'nothing stored disagrees');
  assert.equal(inspectScheduleInstants(job('bad-end', { date: '2026-09-23', time: '09:00', endTime: '11:00', endDate: 'soon' })).reason, 'end_date_invalid');
  const inverted = inspectScheduleInstants(job('inverted', { date: '2026-09-23', time: '22:00', endTime: '02:00', endDate: '2026-09-20' }));
  assert.deepEqual([inverted.action, inverted.reason, inverted.before.endDate], ['review', 'wall_time_invalid', '2026-09-20']);
});

test('the plan uses the latest bridge receipt per visit and never reports private rows', () => {
  const receipts = [
    { id: '_egc_schedule_op_old', recordType: 'schedule_operation', portalVisitId: 'moved-earlier', mode: 'update', after: { date: '2026-09-25', time: '13:00', endTime: '15:00' }, createdAt: '2026-09-01T00:00:00.000Z' },
    { id: '_egc_schedule_op_new', recordType: 'schedule_operation', portalVisitId: 'moved-earlier', mode: 'update', after: bridgeAfter, createdAt: '2026-09-10T00:00:00.000Z' },
  ];
  const ambiguous = job('dst-ambiguous', { date: '2026-11-01', time: '01:30', endDate: '2026-11-01', endTime: '03:00', startAt: '2026-11-01T07:30:00.000Z' });
  const plan = planScheduleInstantRepairs([consistent, movedLater, timeOnly, movedEarlier, ambiguous, ...receipts.reverse()]);
  assert.equal(plan.scanned, 7);
  assert.deepEqual(plan.repairs.map(row => row.id), ['moved-later', 'time-only', 'moved-earlier']);
  assert.equal(plan.repairs[2].patch.endDate, '2026-09-23', 'the newest receipt matches the current wall clock');
  assert.deepEqual(plan.review.map(row => [row.id, row.reason]), [['dst-ambiguous', 'wall_time_invalid']]);
  const report = formatScheduleRepairReport(plan).join('\n');
  assert.match(report, /DRY RUN/); assert.match(report, /REPAIR moved-later \[scheduled\] 2026-09-23 09:00-11:00/); assert.match(report, /endDate 2026-09-20 -> 2026-09-23/);
  assert.match(report, /REVIEW dst-ambiguous/); assert.doesNotMatch(report, /Synthetic Customer/);
});

test('lock entries for the repaired row are rewritten and malformed locks are never overwritten', () => {
  const fixed = { ...movedLater, endDate: '2026-09-23' };
  const other = { id: 'other', start: '12:00', end: '13:00', status: 'scheduled', assignedCrew: ['crew1'] };
  const lock = { id: '_egc_schedule_lock_2026-09-23', recordType: 'schedule_lock', revision: 'lock-r1', entries: [{ id: 'moved-later', start: '09:00', end: '24:00', status: 'scheduled', assignedCrew: [], assignmentKnown: false }, other] };
  assert.deepEqual(repairedLockEntries(lock, fixed, '2026-09-23'), [{ id: 'moved-later', start: '09:00', end: '11:00', status: 'scheduled', assignedCrew: [], assignmentKnown: false }, other]);
  assert.deepEqual(repairedLockEntries({ ...lock, entries: [lock.entries[0], other] }, fixed, '2026-09-25'), [other], 'a day the repaired row no longer occupies loses its entry');
  assert.equal(repairedLockEntries({ ...lock, entries: [{ ...lock.entries[0], end: '11:00' }, other] }, fixed, '2026-09-23'), null);
  assert.equal(repairedLockEntries(null, fixed, '2026-09-23'), null);
  assert.throws(() => repairedLockEntries({ recordType: 'schedule_lock', entries: 'bad' }, fixed, '2026-09-23'), error => error.code === 'repair_lock_unavailable');
});

function store(rows) {
  const data = new Map(rows.map(([key, value]) => [key, structuredClone(value)])), commits = [], scans = [];
  let revision = 0, failNext = false;
  return {
    data, commits, scans, failOnce: () => { failNext = true; },
    jobRecords: async fields => { scans.push(fields); return [...data.entries()].filter(([key]) => key.startsWith('jobs/')).map(([, value]) => structuredClone(value)); },
    read: async (collection, id) => structuredClone(data.get(`${collection}/${id}`) || null),
    commit: async writes => {
      if (failNext) { failNext = false; throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 }); }
      assert.equal(new Set(writes.map(write => `${write.collection}/${write.id}`)).size, writes.length, 'no duplicate writes per commit');
      for (const write of writes) {
        const old = data.get(`${write.collection}/${write.id}`);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      commits.push(structuredClone(writes));
      for (const write of writes) data.set(`${write.collection}/${write.id}`, { ...data.get(`${write.collection}/${write.id}`), ...structuredClone(write.patch), id: write.id, revision: `w${++revision}` });
    },
  };
}
const fixture = () => store([
  ['jobs/consistent', consistent], ['jobs/moved-later', { ...movedLater, acceptance: { signature: 'data:image/png;base64,synthetic' } }], ['jobs/time-only', timeOnly],
  ['jobs/_egc_schedule_lock_2026-09-23', { id: '_egc_schedule_lock_2026-09-23', recordType: 'schedule_lock', date: '2026-09-23', revision: 'lock-r1', entries: [{ id: 'moved-later', start: '09:00', end: '24:00', status: 'scheduled' }, { id: 'time-only', start: '13:00', end: '15:00', status: 'scheduled' }] }],
  ['dispatchState/revision', { id: 'revision', revision: 'guard-r1', updatedAt: '2026-09-01T00:00:00.000Z' }],
]);

test('the default run is read-only and scans through the schedule mask', async () => {
  const f = fixture(), lines = [];
  const result = await runScheduleInstantRepair({ store: f, now: NOW, log: line => lines.push(line) });
  assert.equal(result.apply, false); assert.deepEqual(result.applied, []);
  assert.deepEqual(result.repairs.map(row => row.id), ['moved-later', 'time-only']);
  assert.deepEqual(f.commits, [], 'a dry run writes nothing');
  assert.deepEqual(f.scans, [REPAIR_SCAN_FIELDS]);
  assert.ok(!REPAIR_SCAN_FIELDS.some(field => /^(acceptance|signature|customer|phone|email|address)/.test(field)));
  assert.match(lines[0], /DRY RUN/); assert.equal(lines.some(line => line.includes('Synthetic Customer')), false);
});

test('--apply writes each repair with revision preconditions, its lock entries and the dispatch guard', async () => {
  const f = fixture(), lines = [];
  const result = await runScheduleInstantRepair({ store: f, apply: true, now: NOW, log: line => lines.push(line) });
  assert.deepEqual(result.applied, [{ id: 'moved-later', outcome: 'repaired', lockDays: 1 }, { id: 'time-only', outcome: 'repaired', lockDays: 0 }]);
  assert.equal(f.commits.length, 2, 'one commit per repaired row');
  const [first, second] = f.commits;
  assert.deepEqual(first.map(write => [write.collection, write.id, write.revision]), [['jobs', 'moved-later', 'moved-later-r1'], ['jobs', '_egc_schedule_lock_2026-09-23', 'lock-r1'], ['dispatchState', 'revision', 'guard-r1']]);
  assert.deepEqual(first[0].patch, { endDate: '2026-09-23', startAt: '2026-09-23T15:00:00.000Z', endAt: '2026-09-23T17:00:00.000Z', timeZone: TZ,
    scheduleInstantsRepair: { at: NOW, reasons: ['end_date_before_date', 'start_at_stale', 'end_at_stale'], before: { endDate: '2026-09-20', startAt: '2026-09-20T19:00:00.000Z', endAt: '2026-09-20T21:00:00.000Z', timeZone: TZ } } });
  assert.deepEqual(first[1].patch.entries.map(entry => [entry.id, entry.start, entry.end]), [['moved-later', '09:00', '11:00'], ['time-only', '13:00', '15:00']]);
  assert.deepEqual(first[2].patch, { updatedAt: NOW });
  assert.deepEqual(second.map(write => [write.collection, write.id]), [['jobs', 'time-only'], ['dispatchState', 'revision']]);
  assert.equal(second[1].revision, 'w3', 'the guard precondition is re-read after the previous repair bumped it');
  const saved = f.data.get('jobs/moved-later');
  assert.deepEqual([saved.date, saved.endDate, saved.startAt, saved.endAt], ['2026-09-23', '2026-09-23', '2026-09-23T15:00:00.000Z', '2026-09-23T17:00:00.000Z']);
  assert.equal(saved.acceptance.signature, 'data:image/png;base64,synthetic', 'other fields are untouched');
  assert.match(lines.join('\n'), /REPAIRED moved-later \(1 lock day rewritten\)/);

  const again = await runScheduleInstantRepair({ store: f, apply: true, now: NOW, log: () => {} });
  assert.deepEqual([again.repairs, again.review, again.applied], [[], [], []], 'the repair is idempotent');
});

test('rows changed since the scan are skipped and a conflict does not stop later repairs', async () => {
  const f = fixture();
  const plan = planScheduleInstantRepairs(await f.jobRecords(REPAIR_SCAN_FIELDS));
  f.data.set('jobs/moved-later', { ...f.data.get('jobs/moved-later'), revision: 'someone-else' });
  assert.deepEqual(await applyScheduleInstantRepair(f, plan.repairs[0], NOW), { id: 'moved-later', outcome: 'changed_since_scan' });
  assert.deepEqual(f.commits, []);

  const g = fixture();
  g.failOnce();
  const result = await runScheduleInstantRepair({ store: g, apply: true, now: NOW, log: () => {} });
  assert.deepEqual(result.applied.map(row => [row.id, row.outcome, row.code]), [['moved-later', 'failed', 'dispatch_revision_conflict'], ['time-only', 'repaired', undefined]]);
  assert.equal(g.data.get('jobs/moved-later').endDate, '2026-09-20', 'the conflicting row is left for the next run');
});
