import test from 'node:test';
import assert from 'node:assert/strict';
import { activeJobSegment, employeeJobTime, ownJobTimeProjection } from '../functions/_lib/employee-job-time.js';
import { authorizeTimecard } from '../functions/_lib/employee-timecards.js';
const session = { user: 'Crew.One', displayName: 'Crew One' }, minute = 60000;
const at = hour => `2026-09-22T${hour}:00.000Z`;
const open = () => authorizeTimecard({ session, manager: false, id: 'shift', incoming: { locationTracking: true, lastLocation: { lat: 40.5, lng: -105 }, jobId: 'legacy-associated-job' }, now: at('14:00'), hourlyRate: 25 });
const update = (entry, incoming, now) => authorizeTimecard({ session, manager: false, id: entry.id, existing: entry, incoming, now });
const action = (entry, jobId, kind = 'work') => ({ jobAction: { requestId: crypto.randomUUID(), expectedSegmentId: activeJobSegment(entry)?.id || '', jobId, kind } });

test('explicit switches preserve earlier jobs and subtract break overlap across work and travel', () => {
  let entry = open();
  entry = update(entry, action(entry, 'job-a', 'travel'), at('14:30'));
  entry = update(entry, action(entry, 'job-a'), at('15:00'));
  entry = update(entry, { breaks: [{ startAt: 'browser-time' }] }, at('16:00'));
  entry = update(entry, action(entry, 'job-b'), at('16:15'));
  entry = update(entry, { breaks: [{ ...entry.breaks[0], endAt: 'browser-time' }] }, at('16:30'));
  entry = update(entry, action(entry, '', 'general'), at('17:30'));
  entry = update(entry, { clockOutAt: 'browser-time', status: 'submitted' }, at('18:00'));
  const summary = employeeJobTime(entry, at('22:00'));
  assert.equal(entry.jobId, 'legacy-associated-job');
  assert.equal(entry.hours, 3.5);
  assert.deepEqual(summary.jobs.map(row => [row.jobId, row.workMs / minute, row.travelMs / minute]), [['job-a', 60, 30], ['job-b', 60, 0]]);
  assert.equal(summary.generalMs, 60 * minute);
  assert.equal(summary.totalRecordedMs, 210 * minute);
  assert.equal(summary.untrackedMs, 0);
  assert.equal(summary.needsReview, false);
  assert.equal(activeJobSegment(entry), null);
  assert.equal(entry.jobTracking.segments.at(-1).endedAt, at('18:00'));
  assert.equal(entry.history.filter(row => row.action === 'job_time_switch').length, 4);
});

test('stable action IDs retry without reopening segments or relabeling later work', () => {
  let entry = open(); const first = action(entry, 'job-a');
  entry = update(entry, first, at('14:30'));
  assert.strictEqual(update(entry, first, at('15:00')), entry);
  entry = update(entry, action(entry, 'job-b'), at('15:30'));
  assert.strictEqual(update(entry, first, at('16:00')), entry);
  entry = update(entry, { clockOutAt: 'browser-time', status: 'submitted' }, at('18:00'));
  assert.strictEqual(update(entry, first, at('20:00')), entry);
  assert.throws(() => update(entry, { jobAction: { ...first.jobAction, jobId: 'forged-job' } }, at('20:00')), /different work/);
  assert.equal(entry.jobTracking.segments[1].startedAt, at('14:30'));
  assert.equal(entry.jobTracking.segments[1].endedAt, at('15:30'));
});

test('stale segment, another employee and forged segment histories cannot change work', () => {
  let entry = open(); const stale = action(entry, 'job-b'); entry = update(entry, action(entry, 'job-a'), at('14:30'));
  assert.throws(() => update(entry, stale, at('15:00')), /active job changed/);
  assert.throws(() => authorizeTimecard({ session: { user: 'Other' }, manager: true, id: entry.id, existing: entry, incoming: action(entry, 'job-a'), now: at('15:00') }), /own active shift/);
  assert.throws(() => update(entry, { jobTracking: { segments: [] } }, at('15:00')), /cannot be replaced/);
  assert.throws(() => update(entry, { jobId: 'job-b' }, at('15:00')), /earlier shift hours/);
  assert.throws(() => update(entry, { ...action(entry, 'job-b'), hours: 100 }, at('15:00')), /separately/);
});

test('legacy active shift coverage starts now and historical completed shift associations are not invented labor', () => {
  const entry = open(); delete entry.jobTracking;
  const legacy = employeeJobTime(entry, at('16:00'));
  assert.equal(legacy.recorded, false); assert.equal(legacy.untrackedMs, 120 * minute); assert.deepEqual(legacy.jobs, []);
  const tracked = update(entry, action(entry, 'job-a'), at('16:00'));
  const summary = employeeJobTime(tracked, at('17:00'));
  assert.equal(summary.partialHistory, true); assert.equal(summary.untrackedMs, 120 * minute);
  assert.equal(summary.jobs[0].workMs, 60 * minute);
});

test('net work uses UTC elapsed time through DST and malformed records require review', () => {
  const entry = { id: 'dst', employee: session.user, clockInAt: '2026-11-01T00:30:00-06:00', clockOutAt: '2026-11-01T02:30:00-07:00', breaks: [{ startAt: '2026-11-01T01:00:00-06:00', endAt: '2026-11-01T01:30:00-07:00' }], jobTracking: { version: 1, segments: [{ id: 'one', kind: 'work', jobId: 'job-a', startedAt: '2026-11-01T00:30:00-06:00', endedAt: '2026-11-01T02:30:00-07:00' }] } };
  assert.equal(employeeJobTime(entry).jobs[0].workMs, 90 * minute);
  assert.equal(employeeJobTime({ ...entry, breaks: {} }).needsReview, true);
  assert.equal(employeeJobTime({ ...entry, jobTracking: { version: 1, segments: [null] } }).needsReview, true);
  assert.equal(employeeJobTime({ ...entry, jobTracking: { version: 1, segments: [...entry.jobTracking.segments, ...entry.jobTracking.segments] } }).needsReview, true);
});

test('malformed imported time records show review state instead of breaking the field page', () => {
  const entry = open();
  for (const breaks of [{}, [null], ['invalid']]) {
    const projected = ownJobTimeProjection({ ...entry, breaks }, at('16:00'));
    assert.equal(projected.summary.needsReview, true);
    assert.equal(projected.current, null);
    assert.equal(projected.currentSegmentId, '');
  }
  for (const startedAt of ['2026-02-30T14:00:00Z', '2026-09-22T24:00:00Z']) {
    assert.equal(employeeJobTime({ ...entry, clockInAt: startedAt }, at('16:00')).needsReview, true);
  }
  const missingId = { ...entry, jobTracking: { version: 1, segments: [{ kind: 'work', jobId: 'job-a', startedAt: at('14:00') }] } };
  assert.equal(ownJobTimeProjection(missingId, at('16:00')).summary.needsReview, true);
  assert.throws(() => update(missingId, action(missingId, 'job-b'), at('16:00')), /manager review/);
});

test('closed shifts with unfinished segments or breaks are excluded rather than assuming an end', () => {
  let entry = open();
  entry = update(entry, action(entry, 'job-a'), at('14:30'));
  const unfinished = { ...entry, clockOutAt: at('16:00'), status: 'submitted' };
  assert.equal(employeeJobTime(unfinished).needsReview, true);
  const finished = update(entry, { clockOutAt: 'browser-time', status: 'submitted' }, at('16:00'));
  assert.equal(employeeJobTime(finished).needsReview, false);
  assert.equal(employeeJobTime({ ...finished, breaks: [{ startAt: at('15:00') }] }).needsReview, true);
});
