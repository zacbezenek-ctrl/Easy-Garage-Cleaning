process.env.TZ = 'Asia/Tokyo';
import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeTimecard, timecardCorrectionsEnabled, OPEN_SHIFT_ATTENTION_HOURS } from '../functions/_lib/employee-timecards.js';
import { employeeJobTime } from '../functions/_lib/employee-job-time.js';
import { computeTimesheetWeek } from '../functions/_lib/timesheet-week.js';
import { payrollCsv } from '../functions/_lib/payroll-export.js';
import { timesheetHandlers } from '../functions/api/timesheets.js';
import * as employeeHub from '../functions/api/employee-hub.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { payHidden } from '../functions/_lib/pay-visibility.js';
import { opaqueId, open, readOne, writeOne } from '../functions/_lib/employee-vault.js';
import { vaultFirestore, staffEnv, cookieFor, jsonRequest } from './helpers/vault-fixture.mjs';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { can } from '../functions/_lib/staff-roles.js';
import * as hubAuth from '../functions/api/hub-auth.js';

// TIME-CORRECT: a manager corrects a timecard or closes a forgotten shift. Every clock here is injected.
const ON = { EGC_TIMECARD_CORRECTIONS: 'true' };
const NOW = '2026-09-22T19:00:00.000Z';
const at = (date, time, offset = '-06:00') => `${date}T${time}:00${offset}`;
const iso = value => new Date(value).toISOString();
const plain = value => JSON.parse(JSON.stringify(value));
let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const OWNER = { user: 'ZacB', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
const MANAGER = { user: 'TylerG', displayName: 'Synthetic Manager', role: 'manager', businessAccess: true };
const CREW = { user: 'Crew.One', displayName: 'Crew One', role: 'crew', payType: 'hourly' };

// A shift Crew One forgot to clock out of: clocked in Monday 07:00 Denver, a lunch at noon, on general time until they
// started work on job-a at 08:00, and still open on Tuesday afternoon.
function forgotten(extra = {}) {
  const clockInAt = at('2026-09-21', '07:00');
  return { id: 'shift-open', employee: 'Crew.One', employeeName: 'Crew One', role: 'crew', payType: 'hourly', hourlyRate: 20, clockInAt, clockOutAt: '', status: 'active', approvalStatus: 'open', approvedBy: '', approvedAt: '',
    jobId: '', jobLabel: '', locationTracking: false, locationStatus: 'hub_single_fix', lastLocation: { lat: 40.58, lng: -105.08, accuracy: 5, capturedAt: clockInAt },
    breaks: [{ startAt: at('2026-09-21', '12:00'), endAt: at('2026-09-21', '12:30') }],
    jobTracking: { version: 1, coverageStartedAt: clockInAt, partialHistory: false, segments: [
      { id: 'clock-in:shift-open', kind: 'general', jobId: '', jobLabel: '', startedAt: clockInAt, endedAt: at('2026-09-21', '08:00'), actorId: 'Crew.One' },
      { id: 'seg-work', kind: 'work', jobId: 'job-a', jobLabel: 'Synthetic Johnson Garage', startedAt: at('2026-09-21', '08:00'), endedAt: '', actorId: 'Crew.One' }] },
    history: [{ action: 'clock_in', actor: 'Crew.One', actorName: 'Crew One', at: clockInAt, changes: {} }], createdAt: clockInAt, updatedAt: '2026-09-21T13:00:05.000Z', updatedBy: 'Crew.One', ...extra };
}
const save = (existing, incoming, { session = MANAGER, env = ON, now = NOW, jobLabel = null } = {}) => authorizeTimecard({ session, manager: session.businessAccess === true, id: existing?.id || 'missing', incoming, existing, now, env, jobLabel });
const closing = (existing, clockOutAt, meta = {}) => ({ correction: { requestId: uuid(), kind: 'close', reason: 'Forgot to clock out', expectedUpdatedAt: existing.updatedAt, ...meta }, clockOutAt });
const correcting = (existing, times, meta = {}) => ({ correction: { requestId: uuid(), kind: 'correct', reason: 'Synthetic correction', expectedUpdatedAt: existing.updatedAt, ...meta }, clockInAt: existing.clockInAt, clockOutAt: existing.clockOutAt, breaks: (existing.breaks || []).map(({ startAt, endAt, kind }) => ({ startAt, endAt, ...(kind ? { kind } : {}) })), ...times });
const refused = (status, code, pattern) => error => error.status === status && error.code === code && (!pattern || pattern.test(error.message));
const hoursOf = ms => Math.round(ms / 3600000 * 1000) / 1000;

test('the switch is off unless exactly "true", and an open shift needs attention after 14 hours', () => {
  for (const value of [undefined, '', 'false', 'TRUE ', 'yes', '1']) assert.equal(timecardCorrectionsEnabled({ EGC_TIMECARD_CORRECTIONS: value }), value === 'TRUE ');
  assert.equal(timecardCorrectionsEnabled({}), false);
  assert.equal(OPEN_SHIFT_ATTENTION_HOURS, 14);
});

test('closing a forgotten shift closes it at the chosen time, sets it pending, ends its job time there and audits the reason; a retry changes nothing', () => {
  const open = forgotten(), body = closing(open, at('2026-09-21', '16:00')), closed = save(open, body);
  assert.deepEqual([closed.clockOutAt, closed.status, closed.approvalStatus, closed.approvedBy, closed.approvedAt], [iso(at('2026-09-21', '16:00')), 'submitted', 'pending', '', '']);
  assert.deepEqual([closed.hours, closed.grossEstimate, closed.locationTracking, closed.locationStatus], [8.5, 170, false, 'stopped']);
  assert.deepEqual([closed.correctedBy, closed.correctedAt, closed.correctionReason, closed.updatedBy, closed.updatedAt], ['TylerG', NOW, 'Forgot to clock out', 'TylerG', NOW]);
  const entry = closed.history.at(-1);
  assert.equal(closed.history.length, 2);
  assert.deepEqual([entry.action, entry.actor, entry.at, entry.reason, entry.correctionRequestId], ['manager_shift_close', 'TylerG', NOW, 'Forgot to clock out', body.correction.requestId]);
  assert.deepEqual(plain(entry.changes.clockOutAt), { before: '', after: iso(at('2026-09-21', '16:00')) });
  assert.deepEqual(plain(entry.changes.approvalStatus), { before: 'open', after: 'pending' });
  assert.deepEqual(plain(entry.changes.status), { before: 'active', after: 'submitted' });
  // The running work segment ends at the new clock-out, so the card's job time is whole, not "needs manager review".
  const work = closed.jobTracking.segments.at(-1);
  assert.deepEqual([work.endedAt, work.endedBy, work.endReason, work.correctedBy], [iso(at('2026-09-21', '16:00')), 'TylerG', 'manager_close', 'TylerG']);
  assert.deepEqual(plain(entry.segments), [{ id: 'seg-work', kind: 'work', jobId: 'job-a', before: { startedAt: at('2026-09-21', '08:00'), endedAt: '' }, after: { startedAt: at('2026-09-21', '08:00'), endedAt: iso(at('2026-09-21', '16:00')) } }]);
  const time = employeeJobTime(closed, NOW);
  assert.deepEqual([time.needsReview, hoursOf(time.generalMs), hoursOf(time.jobs[0].workMs), time.untrackedMs], [false, 1, 7.5, 0]);
  // A retry of the same request (a lost reply) is the saved card, and so is a retry after a later save.
  assert.strictEqual(save(closed, body), closed);
  assert.strictEqual(save({ ...closed, updatedAt: '2026-09-22T19:30:00.000Z' }, body).updatedAt, '2026-09-22T19:30:00.000Z');
  assert.throws(() => save(closed, { ...body, clockOutAt: at('2026-09-21', '17:00') }), refused(409, 'EMPLOYEE_TIMECARD_IDEMPOTENCY_CONFLICT'));
  // A new request made from the card as it was before the close is refused: the card changed since it was shown.
  assert.throws(() => save(closed, correcting(open, { clockOutAt: at('2026-09-21', '15:00') })), refused(409, 'EMPLOYEE_TIMECARD_CHANGED'));
  // Close is only for an open shift.
  assert.throws(() => save(closed, closing(closed, at('2026-09-21', '15:00'))), refused(409, 'EMPLOYEE_TIMECARD_INVALID', /already closed/));
});

test('closing a shift ends an unfinished break at the clock-out and refuses a time before a recorded break', () => {
  const onBreak = forgotten({ breaks: [{ startAt: at('2026-09-21', '12:00'), endAt: at('2026-09-21', '12:30') }, { startAt: at('2026-09-21', '15:00'), endAt: '', startRequestId: '11111111-1111-4111-8111-111111111111' }] });
  const closed = save(onBreak, closing(onBreak, at('2026-09-21', '15:30')));
  assert.deepEqual(plain(closed.breaks.at(-1)), { startAt: at('2026-09-21', '15:00'), endAt: iso(at('2026-09-21', '15:30')), startRequestId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(closed.hours, 7.5);
  assert.throws(() => save(onBreak, closing(onBreak, at('2026-09-21', '14:00'))), refused(409, 'EMPLOYEE_TIMECARD_INVALID', /break was recorded after/));
  assert.throws(() => save(onBreak, closing(onBreak, at('2026-09-21', '06:00'))), refused(400, 'EMPLOYEE_TIMECARD_INVALID', /after the clock-in/));
});

test('only an owner or manager with the switch on corrects a card, and every correction names its reason, version and fields', () => {
  const open = forgotten(), body = closing(open, at('2026-09-21', '16:00'));
  assert.throws(() => save(open, body, { env: {} }), refused(403, 'EMPLOYEE_TIMECARD_CORRECTIONS_OFF'));
  assert.throws(() => save(open, body, { session: CREW }), refused(403, 'EMPLOYEE_TIMECARD_INVALID', /Only a manager or the owner/));
  assert.throws(() => save({ ...open, employee: 'Crew.One' }, body, { session: CREW }), refused(403, 'EMPLOYEE_TIMECARD_INVALID'), 'not on your own card either');
  // With staff roles on, it is time.approve that counts: a business user whose stored role is sales cannot correct.
  const roles = { ...ON, EGC_STAFF_ROLE_PERMISSIONS: 'true' };
  assert.throws(() => save(open, body, { env: roles, session: { ...MANAGER, staffRoles: ['sales'] } }), refused(403, 'EMPLOYEE_TIMECARD_INVALID'));
  assert.equal(save(open, body, { env: roles, session: { ...MANAGER, staffRoles: ['manager'] } }).approvalStatus, 'pending');
  assert.equal(save(open, body, { session: OWNER }).correctedBy, 'ZacB');
  assert.throws(() => save(null, body), refused(404, 'EMPLOYEE_TIMECARD_INVALID'));
  for (const bad of [{ reason: '  ' }, { reason: 'ok' }, { requestId: 'not-a-uuid' }, { kind: 'reopen' }, { expectedUpdatedAt: undefined }, { extra: true }]) {
    assert.throws(() => save(open, { ...body, correction: { ...body.correction, ...bad } }), refused(400, 'EMPLOYEE_TIMECARD_INVALID'), JSON.stringify(bad));
  }
  // A close sets only the clock-out; the correction's own fields cannot carry anything else (job segments, approval, pay).
  for (const extra of [{ clockInAt: at('2026-09-21', '06:00') }, { approvalStatus: 'approved' }, { jobTracking: open.jobTracking }, { employee: 'TylerG' }]) {
    assert.throws(() => save(open, { ...body, ...extra }), refused(400, 'EMPLOYEE_TIMECARD_INVALID'), JSON.stringify(extra));
  }
  assert.throws(() => save(open, { ...correcting(open, { clockOutAt: at('2026-09-21', '16:00') }), approvedBy: 'TylerG' }), refused(400, 'EMPLOYEE_TIMECARD_INVALID'));
});

test('a correction sets clock-in, clock-out and breaks inside a real shift, recomputes hours and returns an approved card to pending', () => {
  const closed = save(forgotten(), closing(forgotten(), at('2026-09-21', '16:00')));
  const approved = save(closed, { approvalStatus: 'approved' });
  assert.deepEqual([approved.approvalStatus, approved.approvedBy], ['approved', 'TylerG']);
  const body = correcting(approved, { clockInAt: at('2026-09-21', '06:30'), clockOutAt: at('2026-09-21', '16:30'), breaks: [{ startAt: at('2026-09-21', '10:00'), endAt: at('2026-09-21', '10:15'), kind: 'rest' }, { startAt: at('2026-09-21', '12:00'), endAt: at('2026-09-21', '12:45') }] }, { reason: 'Started early; lunch ran long' });
  const corrected = save(approved, body);
  assert.deepEqual([corrected.clockInAt, corrected.clockOutAt, corrected.approvalStatus, corrected.approvedBy, corrected.approvedAt], [iso(at('2026-09-21', '06:30')), iso(at('2026-09-21', '16:30')), 'pending', '', '']);
  assert.deepEqual(plain(corrected.breaks), [{ startAt: iso(at('2026-09-21', '10:00')), endAt: iso(at('2026-09-21', '10:15')), kind: 'rest' }, { startAt: at('2026-09-21', '12:00'), endAt: iso(at('2026-09-21', '12:45')) }]);
  // Hours on the card count every break out (as before); payroll pays the rest break (timesheet-week.js).
  assert.equal(corrected.hours, 9);
  const entry = corrected.history.at(-1);
  assert.deepEqual([entry.action, entry.reason, Object.keys(entry.changes).sort()], ['manager_time_correction', 'Started early; lunch ran long', ['approvalStatus', 'breaks', 'clockInAt', 'clockOutAt']]);
  // Segments are only ever trimmed, never stretched: the half hours before the first segment and after the work segment
  // (which ended at the old 16:00 clock-out) are time with no job segment, and the card needs no review.
  const time = employeeJobTime(corrected, NOW);
  assert.deepEqual([time.needsReview, hoursOf(time.jobs[0].workMs), hoursOf(time.generalMs), hoursOf(time.untrackedMs)], [false, 7, 1, 1]);
  // Invalid corrections are refused and change nothing.
  for (const [times, pattern] of [
    [{ clockOutAt: at('2026-09-21', '06:00') }, /after the clock-in/],
    [{ clockInAt: at('2026-09-20', '06:00'), clockOutAt: at('2026-09-21', '16:30') }, /at most 24 hours/],
    [{ clockInAt: at('2026-09-22', '10:00'), clockOutAt: at('2026-09-22', '18:00') }, /future/],
    [{ clockInAt: '2026-09-21 06:30' }, /valid clock-in/],
    [{ breaks: [{ startAt: at('2026-09-21', '05:00'), endAt: at('2026-09-21', '05:30') }] }, /inside the shift/],
    [{ breaks: [{ startAt: at('2026-09-21', '12:00'), endAt: at('2026-09-21', '12:45') }, { startAt: at('2026-09-21', '12:30'), endAt: at('2026-09-21', '13:00') }] }, /not overlapping/],
    [{ breaks: [{ startAt: at('2026-09-21', '12:00'), endAt: at('2026-09-21', '12:00') }] }, /end after it starts/],
    [{ breaks: [{ startAt: at('2026-09-21', '12:00'), endAt: at('2026-09-21', '12:30'), kind: 'nap' }] }, /rest break or an unpaid meal/],
    [{ breaks: [{ startAt: at('2026-09-21', '12:00'), endAt: at('2026-09-21', '12:30'), endRequestId: 'x' }] }, /start and an end/],
    [{ breaks: [{ startAt: at('2026-09-21', '06:30'), endAt: at('2026-09-21', '16:30') }] }, /work time outside its breaks/],
  ]) assert.throws(() => save(corrected, correcting(corrected, times)), error => error.status === 400 && pattern.test(error.message), JSON.stringify(times));
  assert.throws(() => save(corrected, correcting(corrected, {})), error => error.status === 400 && /Nothing changed/.test(error.message), 'the same times are not a correction');
});

test('a manager cannot change the rate; the owner can, and the pay is recomputed from it', () => {
  const closed = save(forgotten({ hourlyRate: 0 }), closing(forgotten({ hourlyRate: 0 }), at('2026-09-21', '16:00')));
  assert.deepEqual([closed.hourlyRate, closed.grossEstimate], [0, 0]);
  for (const hourlyRate of [22, 0, '22.00']) assert.throws(() => save(closed, correcting(closed, { hourlyRate })), refused(403, 'pay_owner_only'), `manager ${hourlyRate}`);
  const raised = save(closed, correcting(closed, { hourlyRate: '22.50' }, { reason: 'Rate was never set' }), { session: OWNER });
  assert.deepEqual([raised.hourlyRate, raised.hours, raised.grossEstimate, raised.approvalStatus], [22.5, 8.5, 191.25, 'pending']);
  assert.deepEqual(plain(raised.history.at(-1).changes.hourlyRate), { before: 0, after: 22.5 });
  // The request kept for replays names the rate that was sent (a replay with another rate is a conflict), and like the
  // rate change itself it never reaches a reader without pay access.
  assert.equal(raised.history.at(-1).request.hourlyRate, 22.5);
  assert.equal(JSON.stringify(payHidden('timeEntries', raised).history.at(-1)).includes('22.5'), false, 'a manager’s copy never repeats the rate');
  for (const hourlyRate of [-1, 1001, '22.555', 22.555, 0.001, 'twenty', null, NaN, Infinity]) assert.throws(() => save(raised, correcting(raised, { hourlyRate }), { session: OWNER }), refused(400, 'EMPLOYEE_TIMECARD_INVALID'), String(hourlyRate));
  assert.equal(save(raised, correcting(raised, { hourlyRate: 22.55 }), { session: OWNER }).hourlyRate, 22.55, 'a number with two decimals is a rate');
  // EGC_STAFF_PAY_OWNER_ONLY=false restores the older rule that every business user sets pay.
  assert.equal(save(closed, correcting(closed, { hourlyRate: 21 }), { env: { ...ON, EGC_STAFF_PAY_OWNER_ONLY: 'false' } }).hourlyRate, 21);
});

test('a replay is the same manager’s same request, rate included: another rate or another manager is a conflict, and a rate from a manager is refused before any replay is compared', () => {
  const closed = save(forgotten(), closing(forgotten(), at('2026-09-21', '16:00')));
  const body = correcting(closed, { hourlyRate: 23 }, { reason: 'Rate was wrong' }), raised = save(closed, body, { session: OWNER });
  assert.strictEqual(save(raised, body, { session: OWNER }), raised, 'the same request again is the saved card');
  assert.strictEqual(save(raised, { ...body, hourlyRate: '23.00' }, { session: OWNER }), raised, 'the same rate written another way');
  assert.throws(() => save(raised, { ...body, hourlyRate: 24 }, { session: OWNER }), refused(409, 'EMPLOYEE_TIMECARD_IDEMPOTENCY_CONFLICT'));
  const { hourlyRate, ...withoutRate } = body;
  assert.throws(() => save(raised, withoutRate, { session: OWNER }), refused(409, 'EMPLOYEE_TIMECARD_IDEMPOTENCY_CONFLICT'));
  // A manager who reads the owner's request ID in the history learns nothing about the rate from a replay: any rate is
  // refused as pay, whether it matches or not, and without one the ID is someone else's.
  for (const guess of [23, 24]) assert.throws(() => save(raised, { ...body, hourlyRate: guess }), refused(403, 'pay_owner_only'), String(guess));
  assert.throws(() => save(raised, withoutRate), refused(409, 'EMPLOYEE_TIMECARD_IDEMPOTENCY_CONFLICT'));
  // A manager's own close replayed by the owner is a conflict too.
  const open = forgotten(), close = closing(open, at('2026-09-21', '16:00')), shut = save(open, close);
  assert.strictEqual(save(shut, close), shut);
  assert.throws(() => save(shut, close, { session: OWNER }), refused(409, 'EMPLOYEE_TIMECARD_IDEMPOTENCY_CONFLICT'));
});

test('a correction moves the card to a scheduled job with its label, or to no job', () => {
  const closed = save(forgotten(), closing(forgotten(), at('2026-09-21', '16:00')));
  assert.throws(() => save(closed, correcting(closed, { jobId: 'job-b' })), refused(404, 'EMPLOYEE_TIMECARD_INVALID', /Choose a job/), 'no job found for it');
  for (const jobId of ['_egc_lock', 'secure_x', 'bad id', 7]) assert.throws(() => save(closed, correcting(closed, { jobId }), { jobLabel: 'Synthetic' }), refused(400, 'EMPLOYEE_TIMECARD_INVALID'), String(jobId));
  const moved = save(closed, correcting(closed, { jobId: 'job-b' }), { jobLabel: 'Synthetic Formula Co' });
  assert.deepEqual([moved.jobId, moved.jobLabel, moved.history.at(-1).changes.jobId.after], ['job-b', 'Synthetic Formula Co', 'job-b']);
  const cleared = save(moved, correcting(moved, { jobId: '' }));
  assert.deepEqual([cleared.jobId, cleared.jobLabel], ['', '']);
});

test('a card whose job segments needed review (clock-in moved after its first segment) is trimmed by a correction, and payroll splits it by job again', () => {
  // As CREW-TIME's golden test has it: the clock-in was moved to 08:30 after the crew member's segments started at 08:00.
  const card = { ...forgotten(), id: 'corrected', clockInAt: at('2027-03-18', '08:30'), clockOutAt: at('2027-03-18', '12:00'), status: 'submitted', approvalStatus: 'pending', breaks: [], updatedAt: '2027-03-18T19:00:00.000Z',
    jobTracking: { version: 1, coverageStartedAt: at('2027-03-18', '08:00'), partialHistory: false, segments: [
      { id: 'g', kind: 'general', jobId: '', jobLabel: '', startedAt: at('2027-03-18', '08:00'), endedAt: at('2027-03-18', '09:00'), actorId: 'Crew.One' },
      { id: 'w', kind: 'work', jobId: 'job-a', jobLabel: 'A', startedAt: at('2027-03-18', '09:00'), endedAt: at('2027-03-18', '12:00'), actorId: 'Crew.One' }] } };
  const weekOf = cards => computeTimesheetWeek({ timecards: cards, weekStart: '2027-03-15', now: '2027-04-30T12:00:00.000Z' });
  assert.equal(employeeJobTime(card, NOW).needsReview, true);
  const before = weekOf([{ ...card, approvalStatus: 'approved' }]).employees[0];
  assert.deepEqual(plain(before.jobTime), { jobs: [], generalHours: 0, untrackedHours: 0, reviewHours: 3.5 });
  // Keeping its times, the correction only trims the segments (that is its change) and records each one it moved.
  const fixed = save(card, correcting(card, {}, { reason: 'Clock-in was corrected earlier' }), { now: '2027-03-19T12:00:00.000Z' });
  assert.deepEqual(plain(fixed.jobTracking.segments.map(item => [item.id, item.startedAt, item.endedAt])), [['g', iso(at('2027-03-18', '08:30')), at('2027-03-18', '09:00')], ['w', at('2027-03-18', '09:00'), at('2027-03-18', '12:00')]]);
  assert.deepEqual(plain(fixed.history.at(-1).segments), [{ id: 'g', kind: 'general', jobId: '', before: { startedAt: at('2027-03-18', '08:00'), endedAt: at('2027-03-18', '09:00') }, after: { startedAt: iso(at('2027-03-18', '08:30')), endedAt: at('2027-03-18', '09:00') } }]);
  assert.equal(employeeJobTime(fixed, NOW).needsReview, false);
  const after = weekOf([{ ...fixed, approvalStatus: 'approved' }]), row = after.employees[0];
  assert.deepEqual(plain(row.jobTime), { jobs: [{ jobId: 'job-a', jobLabel: 'A', workHours: 3, travelHours: 0 }], generalHours: 0.5, untrackedHours: 0 });
  // The pay columns are what they were: only the Job time cell changes.
  const beforeCsv = payrollCsv(weekOf([{ ...card, approvalStatus: 'approved' }])).split('\r\n')[1], afterCsv = payrollCsv(after).split('\r\n')[1];
  assert.equal(afterCsv.slice(0, afterCsv.lastIndexOf(',"')), beforeCsv.slice(0, beforeCsv.lastIndexOf(',"')));
  assert.match(afterCsv, /,"A: work 3\.000 h; General company time 0\.500 h"$/);
  // A segment wholly outside the corrected shift is dropped (and listed), one crossing its end is trimmed.
  const shorter = save(fixed, correcting(fixed, { clockOutAt: at('2027-03-18', '08:50') }), { now: '2027-03-19T12:00:00.000Z' });
  assert.deepEqual(plain(shorter.jobTracking.segments.map(item => [item.id, item.startedAt, item.endedAt])), [['g', iso(at('2027-03-18', '08:30')), iso(at('2027-03-18', '08:50'))]]);
  assert.deepEqual(plain(shorter.history.at(-1).segments.map(item => [item.id, item.after])), [['g', { startedAt: iso(at('2027-03-18', '08:30')), endedAt: iso(at('2027-03-18', '08:50')) }], ['w', null]]);
});

test('corrected shifts across daylight saving and midnight pay their real length in the right week', () => {
  // Fall back, Nov 1 2026: 22:00 MDT to 06:00 MST is nine hours. Spring forward, Mar 14 2027: 22:00 MST to 06:00 MDT is seven.
  const fall = forgotten({ id: 'fall', clockInAt: at('2026-10-31', '22:00'), breaks: [], jobTracking: undefined, updatedAt: 'v1' });
  const fallClosed = save(fall, closing(fall, at('2026-11-01', '06:00', '-07:00')), { now: '2026-11-02T12:00:00.000Z' });
  assert.equal(fallClosed.hours, 9);
  const spring = forgotten({ id: 'spring', clockInAt: at('2027-03-13', '22:00', '-07:00'), breaks: [], jobTracking: undefined, updatedAt: 'v1' });
  const springClosed = save(spring, closing(spring, at('2027-03-14', '06:00')), { now: '2027-03-15T12:00:00.000Z' });
  assert.equal(springClosed.hours, 7);
  // A correction across midnight with a meal break over it.
  const night = save(springClosed, correcting(springClosed, { clockInAt: at('2027-03-13', '21:00', '-07:00'), breaks: [{ startAt: at('2027-03-13', '23:30', '-07:00'), endAt: at('2027-03-14', '00:30', '-07:00') }] }), { now: '2027-03-15T12:00:00.000Z' });
  assert.equal(night.hours, 7);
  const approve = card => ({ ...card, approvalStatus: 'approved' });
  const fallWeek = computeTimesheetWeek({ timecards: [approve(fallClosed)], weekStart: '2026-10-26', now: '2026-11-10T12:00:00.000Z' });
  assert.deepEqual([fallWeek.employees[0].workedHours, fallWeek.employees[0].days[5].date, fallWeek.employees[0].days[5].workedHours, fallWeek.totals.grossPay], [9, '2026-10-31', 9, 180]);
  const springWeek = computeTimesheetWeek({ timecards: [approve(night)], weekStart: '2027-03-08', now: '2027-04-30T12:00:00.000Z' });
  assert.deepEqual([springWeek.employees[0].workedHours, springWeek.employees[0].days[5].date, springWeek.totals.grossPay], [7, '2027-03-13', 140]);
});

test('the week keeps pending and open time out of its totals and lists it beside them; a 56-hour week pays the overtime engine’s gross', () => {
  // Maria: seven 8-hour days at $22 (the board used to show 56 h as $1,232 straight time) plus one pending day; Crew One
  // has a shift open for 33.8 hours as of now.
  const maria = [21, 22, 23, 24, 25, 26, 27].map(day => ({ id: `maria-${day}`, employee: 'Maria.Synthetic', employeeName: 'Maria Synthetic', payType: 'hourly', hourlyRate: 22, clockInAt: at(`2026-09-${day}`, '07:00'), clockOutAt: at(`2026-09-${day}`, '15:00'), status: 'submitted', approvalStatus: 'approved', breaks: [] }));
  const pending = { ...maria[0], id: 'maria-pending', clockInAt: at('2026-09-21', '16:00'), clockOutAt: at('2026-09-22', '00:00'), approvalStatus: 'pending' };
  const now = '2026-09-27T21:48:00.000Z', openShift = { id: 'crew-open', employee: 'Crew.One', employeeName: 'Crew One', payType: 'hourly', hourlyRate: 19, clockInAt: iso(Date.parse(now) - 33.8 * 3600000), clockOutAt: '', status: 'active', approvalStatus: 'open', breaks: [] };
  const week = computeTimesheetWeek({ timecards: [...maria, pending, openShift], weekStart: '2026-09-21', now });
  const row = week.employees.find(item => item.employee === 'maria.synthetic'), crew = week.employees.find(item => item.employee === 'crew.one');
  assert.deepEqual([row.workedHours, row.regularHours, row.overtimeHours, row.straightPay, row.overtimePremium, row.grossPay], [56, 40, 16, 1232, 176, 1408]);
  assert.deepEqual([row.pendingExcludedTimecards, row.pendingExcludedHours, row.openShifts, row.openHours], [1, 8, 0, 0]);
  assert.deepEqual([crew.workedHours, crew.grossPay, crew.openShifts, crew.openHours], [0, 0, 1, 33.8]);
  assert.deepEqual([week.totals.workedHours, week.totals.grossPay, plain(week.excludedHours), plain(week.excluded)], [56, 1408, { pending: 8, open: 33.8 }, { pending: 1, open: 1, rejected: 0 }]);
});

// ---- Through /api/employee-hub with the real encrypted vault, and the payroll CSV after it ----
const env = staffEnv(ON);
const decrypt = async (fire, collection, id) => {
  const documentId = await opaqueId(env, collection, id), doc = fire.documents.get(`jobs/${documentId}`);
  return doc ? open(env, documentId, doc.fields.sealedIv.stringValue, doc.fields.sealedPayload.stringValue) : null;
};
async function hub(t) {
  const fire = vaultFirestore(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-21T13:00:00.000Z') });
  // Sessions are signed at the (mocked) time of each request, as a signed-in browser's would be fresh.
  const post = async (user, id, data, hubEnv = env) => {
    const response = await employeeHub.onRequestPost({ env: hubEnv, request: jsonRequest('/api/employee-hub', { collection: 'timeEntries', id, data }, await cookieFor(env, user)) });
    const body = await response.json();
    return { status: response.status, code: body.code, body };
  };
  const list = async (user, hubEnv = env) => (await employeeHub.onRequestGet({ env: hubEnv, request: jsonRequest('/api/employee-hub', undefined, await cookieFor(env, user)) })).json();
  const payroll = async (session, query = '&format=csv') => {
    const response = await timesheetHandlers({ session: async () => session, now: () => new Date('2026-10-05T18:00:00.000Z') }).get({ request: new Request(`https://easygaragecleaning.com/api/timesheets?view=week&start=2026-09-21${query}`), env });
    return { status: response.status, text: await response.text() };
  };
  return { fire, post, list, payroll, read: id => decrypt(fire, 'timeEntries', id), setTime: value => t.mock.timers.setTime(Date.parse(value)) };
}

test('HTTP: a manager closes a crew member’s forgotten shift; the lock is released, a manager cannot set the rate, a retry writes nothing, and the payroll CSV then exports', async t => {
  const { fire, post, list, payroll, read, setTime } = await hub(t);
  assert.equal((await post('Crew.Static', 'forgot-1', { locationTracking: true, lastLocation: { lat: 40.58, lng: -105.08, accuracy: 5 } })).status, 200);
  setTime(NOW);
  const shown = (await list('TylerG')).collections.timeEntries.find(item => item.id === 'forgot-1');
  assert.equal((await list('TylerG')).timecardCorrections, true);
  assert.equal((await list('Crew.Static')).timecardCorrections, false, 'crew never get the correction tools');
  // Before: the week cannot be exported with the shift open.
  const blocked = await payroll(OWNER);
  assert.equal(blocked.status, 409);
  assert.ok(JSON.parse(blocked.text).details.reasons.includes('open_shifts'));
  // A manager's correction carrying a rate is refused before anything is written.
  const before = fire.snapshot(), body = { correction: { requestId: uuid(), kind: 'correct', reason: 'Forgot to clock out', expectedUpdatedAt: shown.updatedAt }, clockInAt: shown.clockInAt, clockOutAt: at('2026-09-21', '16:00'), breaks: [], hourlyRate: 25 };
  assert.deepEqual([(await post('TylerG', 'forgot-1', body)).status, (await post('TylerG', 'forgot-1', body)).code], [403, 'pay_owner_only']);
  assert.equal(fire.snapshot(), before, 'nothing written');
  assert.deepEqual([(await post('Crew.Static', 'forgot-1', closing(shown, at('2026-09-21', '16:00')))).status], [403], 'the crew member cannot close it this way');
  // The manager closes it at 16:00.
  const close = closing(shown, at('2026-09-21', '16:00')), saved = await post('TylerG', 'forgot-1', close);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.record.approvalStatus, saved.body.record.clockOutAt, saved.body.record.hours, saved.body.record.jobTime.needsReview], ['pending', iso(at('2026-09-21', '16:00')), 9, false]);
  assert.equal(Object.hasOwn(saved.body.record, 'hourlyRate'), false, 'the answer to a manager carries no crew pay');
  const stored = await read('forgot-1');
  assert.deepEqual([stored.status, stored.approvalStatus, stored.hourlyRate, stored.grossEstimate, stored.correctedBy, stored.history.at(-1).reason, stored.history.at(-1).actor], ['submitted', 'pending', 19, 171, 'TylerG', 'Forgot to clock out', 'TylerG']);
  assert.equal((await readOne(env, 'timeLocks', 'crew.static')).data.entryId, '', 'the crew member can clock in again');
  // A retry after a lost reply answers with the saved card and writes nothing.
  const writes = fire.writes().length, retry = await post('TylerG', 'forgot-1', close);
  assert.deepEqual([retry.status, fire.writes().length], [200, writes]);
  // The crew member sees the reason on their own card.
  assert.equal((await list('Crew.Static')).collections.timeEntries.find(item => item.id === 'forgot-1').history.at(-1).reason, 'Forgot to clock out');
  // Pending now (no longer open); once approved, the payroll CSV exports the corrected nine hours at the snapshotted rate.
  assert.deepEqual(JSON.parse((await payroll(OWNER)).text).details.reasons, ['pending_timecards']);
  assert.equal((await post('TylerG', 'forgot-1', { approvalStatus: 'approved' })).status, 200);
  const csv = await payroll(OWNER);
  assert.equal(csv.status, 200, csv.text);
  assert.match(csv.text.split('\r\n')[1], /^"Synthetic Static Crew","crew\.static","2026-09-21","2026-09-27","colorado","9\.000","0\.000","0\.000","0\.000","9\.000","19\.0000","171\.00","0\.00","0\.00","0\.00","0\.00","171\.00","none","1","0",""/);
});

test('HTTP: the owner sets the rate and moves the card to a scheduled job by its label; with the switch off every correction is refused and nothing is written', async t => {
  const { fire, post, list, read, setTime } = await hub(t);
  fire.documents.set('jobs/job-a', { name: 'projects/egcw-1ec83/databases/(default)/documents/jobs/job-a', fields: encodeFirestoreFields({ type: 'job', customer: 'Synthetic Johnson Garage', serviceType: 'Garage cleanout' }), updateTime: '2026-09-20T12:00:00.000000Z' });
  fire.documents.set('jobs/walk-a', { name: 'projects/egcw-1ec83/databases/(default)/documents/jobs/walk-a', fields: encodeFirestoreFields({ type: 'walkthrough', customer: 'Synthetic Lead' }), updateTime: '2026-09-20T12:00:00.000000Z' });
  assert.equal((await post('Crew.Static', 'forgot-2', { locationTracking: true, lastLocation: { lat: 40.58, lng: -105.08, accuracy: 5 } })).status, 200);
  setTime(NOW);
  const off = { ...env, EGC_TIMECARD_CORRECTIONS: '' }, shown = (await list('ZacB')).collections.timeEntries.find(item => item.id === 'forgot-2');
  assert.equal((await list('ZacB', off)).timecardCorrections, false);
  const before = fire.snapshot();
  assert.deepEqual([(await post('ZacB', 'forgot-2', closing(shown, at('2026-09-21', '16:00')), off)).code], ['EMPLOYEE_TIMECARD_CORRECTIONS_OFF']);
  assert.equal(fire.snapshot(), before);
  const correct = extra => ({ correction: { requestId: uuid(), kind: 'correct', reason: 'Owner correction', expectedUpdatedAt: shown.updatedAt }, clockInAt: shown.clockInAt, clockOutAt: at('2026-09-21', '15:00'), breaks: [{ startAt: at('2026-09-21', '11:30'), endAt: at('2026-09-21', '12:00') }], ...extra });
  const walk = await post('ZacB', 'forgot-2', correct({ jobId: 'walk-a' }));
  assert.deepEqual([walk.status, walk.code], [404, 'EMPLOYEE_TIMECARD_INVALID'], 'a walkthrough is not a job for a timecard');
  const saved = await post('ZacB', 'forgot-2', correct({ jobId: 'job-a', hourlyRate: 23.5 }));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const stored = await read('forgot-2');
  assert.deepEqual([stored.jobId, stored.jobLabel, stored.hourlyRate, stored.hours, stored.grossEstimate, stored.approvalStatus], ['job-a', 'Synthetic Johnson Garage', 23.5, 7.5, 176.25, 'pending']);
  assert.deepEqual(plain(stored.history.at(-1).changes.hourlyRate), { before: 19, after: 23.5 });
  // A manager reading the card sees the correction but not the rate change in its history.
  const managerView = (await list('TylerG')).collections.timeEntries.find(item => item.id === 'forgot-2');
  assert.equal(Object.hasOwn(managerView.history.at(-1).changes, 'hourlyRate'), false);
  assert.deepEqual([stored.history.at(-1).request.hourlyRate, Object.hasOwn(managerView.history.at(-1).request, 'hourlyRate')], [23.5, false], 'the rate the owner sent stays out of the manager’s copy');
  assert.equal(managerView.history.at(-1).reason, 'Owner correction');
});

test('HTTP: a new timecard ID is plain text; an ID with quotes or markup is refused before anything is written, and a card saved earlier under one stays savable', async t => {
  const { fire, post, list, read } = await hub(t);
  // Refused: whatever can end an HTML attribute or a JS string (quotes, backslash, backtick, < > &), control characters
  // and every whitespace but a plain space (a tab, a line break, a no-break space, a JS line separator).
  for (const id of [`x');alert(document.cookie);('`, 'time-crew"><img src=x>', "time-o'brien-mfq2x9z1", 'time-crew"-mfq2x9z1', 'time-<crew>-mfq2x9z1', 'time-crew<-mfq2x9z1', 'time-crew\\-mfq2x9z1',
    'time-crew`-mfq2x9z1', 'time-crew&amp;-mfq2x9z1', 'time\tcrew', 'time\ncrew', 'time crew', 'time crew', 'time-crew\u0000', 'time-crew\u007f', 'time-crew\u0085', 'x'.repeat(181), '']) {
    const before = fire.snapshot(), refusedClockIn = await post('Crew.Static', id, { locationTracking: true, lastLocation: { lat: 40.58, lng: -105.08, accuracy: 5 } });
    assert.deepEqual([refusedClockIn.status, refusedClockIn.code], [400, id && id.length <= 180 ? 'EMPLOYEE_TIMECARD_ID_INVALID' : undefined], id);
    assert.equal(fire.snapshot(), before, `nothing written for ${JSON.stringify(id)}`);
  }
  assert.equal((await post('Crew.Static', 'time-crew.static-mfq2x9z1', { locationTracking: true, lastLocation: { lat: 40.58, lng: -105.08, accuracy: 5 } })).status, 200, 'the Hub’s own IDs');
  // A card an older build saved under an ID with a quote is still read and approved.
  const legacy = "time-crew.static-o'brien";
  const clockInAt = at('2026-09-20', '07:00'), stored = { id: legacy, employee: 'crew.static', employeeName: 'Synthetic Static Crew', payType: 'hourly', hourlyRate: 19, clockInAt, clockOutAt: at('2026-09-20', '15:00'), status: 'submitted', approvalStatus: 'pending', breaks: [], history: [], createdAt: clockInAt, updatedAt: clockInAt, updatedBy: 'crew.static' };
  await writeOne(env, 'timeEntries', legacy, stored);
  assert.ok((await list('TylerG')).collections.timeEntries.some(item => item.id === legacy));
  const approved = await post('TylerG', legacy, { approvalStatus: 'approved' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal((await read(legacy)).approvalStatus, 'approved');
});

test('HTTP: the correction tools are offered only to whoever may correct: with staff roles on, a business user whose role is sales gets none', async t => {
  const { list } = await hub(t);
  const roles = staffEnv({ ...ON, EGC_STAFF_ROLE_PERMISSIONS: 'true' }, { AlexK: { passwordHash: 'unused-synthetic-lead-hash', role: 'crew_lead', displayName: 'Synthetic Business Lead', staffRoles: ['sales'] }, TylerG: { passwordHash: 'unused-synthetic-manager-hash', role: 'manager', displayName: 'Synthetic Manager', hourlyRate: 30, staffRoles: ['manager'] } });
  assert.equal((await list('AlexK', roles)).timecardCorrections, false, 'sales cannot approve time');
  assert.equal((await list('TylerG', roles)).timecardCorrections, true);
  assert.equal((await list('AlexK')).timecardCorrections, true, 'without staff roles every business user approves time, as before');
  assert.equal((await list('AlexK', { ...roles, EGC_TIMECARD_CORRECTIONS: '' })).timecardCorrections, false);
});

// ---- Another employee's card needs time.approve (EGC_STAFF_ROLE_PERMISSIONS); new timecard IDs from the crew app ----
const ALEX = { user: 'AlexK', displayName: 'Synthetic Business Lead', role: 'crew_lead', businessAccess: true };
const outcome = run => { try { return { saved: plain(run()) }; } catch (error) { return { refused: [error.status, error.code, error.message] }; } };

test('with staff roles off (the default), stored roles change nothing: every business user saves another employee’s card exactly as before', () => {
  const closed = save(forgotten(), closing(forgotten(), at('2026-09-21', '16:00')));
  const saves = {
    close: [forgotten(), { clockOutAt: at('2026-09-21', '16:00'), status: 'submitted' }],
    approve: [closed, { approvalStatus: 'approved', approvedBy: 'someone', approvedAt: NOW, updatedAt: NOW }],
    reject: [closed, { approvalStatus: 'rejected' }],
    time: [closed, { clockInAt: at('2026-09-21', '06:30'), breaks: [] }],
    create: [null, { employee: 'Crew.One', employeeName: 'Crew One', clockInAt: at('2026-09-21', '07:00'), clockOutAt: at('2026-09-21', '15:00'), status: 'submitted', approvalStatus: 'pending', breaks: [] }],
  };
  const run = (session, env, [existing, incoming]) => outcome(() => authorizeTimecard({ session, manager: true, id: existing?.id || 'time-entered', incoming, existing, now: NOW, env }));
  for (const person of [OWNER, MANAGER, ALEX]) {
    for (const [name, pair] of Object.entries(saves)) {
      const before = run(person, {}, pair);
      assert.ok(before.saved, `${person.user} ${name}: ${JSON.stringify(before.refused)}`);
      for (const staffRoles of [['sales'], ['phone'], ['crew'], ['crew_lead'], []]) {
        for (const flag of [undefined, '', 'false', 'TRUE', 'true ', '1', 'yes']) {
          const env = flag === undefined ? {} : { EGC_STAFF_ROLE_PERMISSIONS: flag }, session = { ...person, staffRoles };
          assert.equal(can(session, 'time.approve', env), true, `${person.user} ${JSON.stringify(staffRoles)} ${flag}`);
          assert.deepEqual(run(session, env, pair), before, `${person.user} ${name} ${JSON.stringify(staffRoles)} ${JSON.stringify(flag)}`);
        }
      }
      // With the switch on, the same save is refused to a stored role without time.approve and unchanged for a manager.
      const on = { EGC_STAFF_ROLE_PERMISSIONS: 'true' };
      if (person !== OWNER) for (const staffRoles of [['sales'], ['phone'], ['crew'], ['crew_lead'], ['sales', 'phone'], []]) {
        assert.deepEqual(run({ ...person, staffRoles }, on, pair).refused, [403, 'EMPLOYEE_TIMECARD_INVALID', 'Only a manager or the owner can change another employee’s timecard.'], `${person.user} ${name} ${JSON.stringify(staffRoles)}`);
      }
      assert.deepEqual(run({ ...person, staffRoles: ['manager'] }, on, pair), before, `${person.user} ${name} as manager`);
      assert.deepEqual(run({ ...person, staffRoles: ['sales', 'manager'] }, on, pair), before);
      assert.deepEqual(run(person, on, pair), before, 'no stored roles: as before');
    }
  }
  // The owner is never locked out: stored roles naming neither owner nor manager act as owner.
  for (const staffRoles of [['crew_lead'], ['sales'], []]) assert.deepEqual(run({ ...OWNER, staffRoles }, { EGC_STAFF_ROLE_PERMISSIONS: 'true' }, saves.approve), run(OWNER, {}, saves.approve));
});

test('with staff roles on, a sales business user’s own card is saved as before: clock-in, break, clock-out, and a replay changes nothing', () => {
  const sales = { ...ALEX, staffRoles: ['sales'] }, on = { EGC_STAFF_ROLE_PERMISSIONS: 'true' }, id = 'time-alexk-1', clockInAt = at('2026-09-22', '07:00');
  const clockIn = { employee: 'alexk', employeeName: 'Synthetic Business Lead', clockInAt, clockOutAt: '', status: 'active', approvalStatus: 'open', jobId: '', jobLabel: '', locationTracking: true, locationStatus: 'hub_single_fix', lastLocation: { lat: 40.58, lng: -105.08, accuracy: 5, capturedAt: clockInAt }, breaks: [], createdAt: clockInAt, updatedAt: clockInAt };
  const steps = [[null, clockIn, at('2026-09-22', '07:00')], ['open', { breaks: [{ startAt: at('2026-09-22', '10:00'), endAt: '' }], updatedAt: at('2026-09-22', '10:00') }, at('2026-09-22', '10:00')],
    ['open', { breaks: [{ startAt: at('2026-09-22', '10:00'), endAt: at('2026-09-22', '10:15') }], updatedAt: at('2026-09-22', '10:15') }, at('2026-09-22', '10:15')],
    ['open', { clockOutAt: at('2026-09-22', '12:00'), status: 'submitted', approvalStatus: 'pending', hours: 4.75, grossEstimate: 0, locationTracking: false, locationStatus: 'stopped', updatedAt: at('2026-09-22', '12:00') }, at('2026-09-22', '12:00')]];
  let legacy = null, staff = null;
  for (const [, incoming, now] of steps) {
    legacy = authorizeTimecard({ session: ALEX, manager: true, id, incoming, existing: legacy, now, env: {} });
    staff = authorizeTimecard({ session: sales, manager: true, id, incoming, existing: staff, now, env: on });
    assert.deepEqual(plain(staff), plain(legacy));
  }
  assert.deepEqual([staff.clockOutAt, staff.status, staff.approvalStatus, staff.hours], [at('2026-09-22', '12:00'), 'submitted', 'pending', 4.75]);
  assert.strictEqual(authorizeTimecard({ session: sales, manager: true, id, incoming: steps[3][1], existing: staff, now: at('2026-09-22', '12:05'), env: on, queued: true }), staff, 'a queued clock-out replay changes nothing');
  // Moving one's own card onto someone else makes it theirs, so that needs time.approve too.
  assert.throws(() => authorizeTimecard({ session: sales, manager: true, id, incoming: { employee: 'crew.static' }, existing: staff, now: at('2026-09-22', '12:05'), env: on }), refused(403, 'EMPLOYEE_TIMECARD_INVALID', /another employee/));
});

async function rolesHub(t, extraUsers = {}) {
  const h = await hub(t);
  const roleUsers = { AlexK: { passwordHash: 'unused-synthetic-lead-hash', role: 'crew_lead', displayName: 'Synthetic Business Lead', staffRoles: ['sales'] },
    TylerG: { passwordHash: 'unused-synthetic-manager-hash', role: 'manager', displayName: 'Synthetic Manager', hourlyRate: 30, staffRoles: ['manager'] },
    ZacB: { passwordHash: 'unused-synthetic-owner-hash', role: 'owner', displayName: 'Synthetic Owner', payType: 'owner', staffRoles: ['owner'] }, ...extraUsers };
  const on = staffEnv({ ...ON, EGC_STAFF_ROLE_PERMISSIONS: 'true' }, roleUsers), off = staffEnv(ON, roleUsers);
  const as = hubEnv => async (user, id, data) => {
    const response = await employeeHub.onRequestPost({ env: hubEnv, request: jsonRequest('/api/employee-hub', { collection: 'timeEntries', id, data }, await cookieFor(hubEnv, user)) });
    const body = await response.json();
    return { status: response.status, code: body.code, error: body.error, body };
  };
  // Crew.Static works one shift (07:00–15:00 Denver, clocked out) and forgets to clock out of the next one.
  const point = { lat: 40.58, lng: -105.08, accuracy: 5 };
  h.setTime('2026-09-21T13:00:00.000Z');
  assert.equal((await as(on)('Crew.Static', 'shift-done', { locationTracking: true, lastLocation: point })).status, 200);
  h.setTime('2026-09-21T21:00:00.000Z');
  assert.equal((await as(on)('Crew.Static', 'shift-done', { clockOutAt: '2026-09-21T21:00:00.000Z', status: 'submitted' })).status, 200);
  h.setTime('2026-09-22T13:00:00.000Z');
  assert.equal((await as(on)('Crew.Static', 'shift-open', { locationTracking: true, lastLocation: point })).status, 200);
  h.setTime(NOW);
  return { ...h, on: as(on), off: as(off), point };
}

test('HTTP: with staff roles on, a sales business user cannot close, approve, reject, retime or create another employee’s card (403, nothing written); a manager and the owner still can', async t => {
  const { fire, on, read } = await rolesHub(t);
  const closeOpen = { clockOutAt: at('2026-09-22', '15:00'), status: 'submitted' }, approve = { approvalStatus: 'approved', approvedBy: 'alexk', approvedAt: NOW, updatedAt: NOW };
  const attempts = [['shift-open', closeOpen], ['shift-open', { clockOutAt: at('2026-09-22', '15:00'), status: 'submitted', approvalStatus: 'pending', hours: 8, locationTracking: false, locationStatus: 'stopped', updatedAt: NOW }],
    ['shift-done', approve], ['shift-done', { approvalStatus: 'rejected' }], ['shift-done', { clockInAt: at('2026-09-21', '06:00') }], ['shift-done', { breaks: [] }], ['shift-done', { notes: 'Synthetic note' }],
    ['time-alexk-for-crew', { employee: 'crew.static', employeeName: 'Synthetic Static Crew', clockInAt: at('2026-09-20', '07:00'), clockOutAt: at('2026-09-20', '15:00'), status: 'submitted', approvalStatus: 'pending', breaks: [] }]];
  const before = fire.snapshot();
  for (const [id, data] of attempts) {
    const reply = await on('AlexK', id, data);
    assert.deepEqual([reply.status, reply.code], [403, 'EMPLOYEE_TIMECARD_INVALID'], `${id} ${JSON.stringify(data)}: ${reply.error}`);
  }
  assert.equal(fire.snapshot(), before, 'nothing written');
  assert.deepEqual([(await read('shift-open')).clockOutAt, (await read('shift-done')).approvalStatus, await read('time-alexk-for-crew')], ['', 'pending', null]);
  // A manager closes the forgotten shift and the owner approves both.
  const closed = await on('TylerG', 'shift-open', closeOpen);
  assert.equal(closed.status, 200, closed.error);
  assert.deepEqual([(await read('shift-open')).clockOutAt, (await read('shift-open')).status, (await read('shift-open')).updatedBy], [at('2026-09-22', '15:00'), 'submitted', 'TylerG']);
  for (const id of ['shift-done', 'shift-open']) {
    const approved = await on('ZacB', id, approve);
    assert.equal(approved.status, 200, approved.error);
    assert.deepEqual([(await read(id)).approvalStatus, (await read(id)).approvedBy], ['approved', 'ZacB']);
  }
  assert.equal((await on('TylerG', 'shift-done', { approvalStatus: 'rejected' })).status, 200, 'a manager may reject');
});

test('HTTP: with staff roles on, the sales business user still clocks in, takes a break and clocks out on their own card', async t => {
  const { on, read, setTime, point } = await rolesHub(t);
  setTime(at('2026-09-22', '08:00'));
  const now = () => new Date().toISOString(), id = 'time-alexk-mfq2x9z1';
  const clockIn = await on('AlexK', id, { employee: 'alexk', employeeName: 'Synthetic Business Lead', clockInAt: now(), clockOutAt: '', status: 'active', approvalStatus: 'open', jobId: '', jobLabel: '', locationTracking: true, locationConsentAt: now(), locationStatus: 'hub_single_fix', lastLocation: { ...point, capturedAt: now() }, locationUpdatedAt: now(), breaks: [], createdAt: now(), updatedAt: now() });
  assert.equal(clockIn.status, 200, clockIn.error);
  setTime(at('2026-09-22', '10:00'));
  assert.equal((await on('AlexK', id, { breaks: [{ startAt: now(), endAt: '' }], updatedAt: now() })).status, 200);
  setTime(at('2026-09-22', '10:15'));
  assert.equal((await on('AlexK', id, { breaks: [{ startAt: iso(at('2026-09-22', '10:00')), endAt: now() }], updatedAt: now() })).status, 200);
  setTime(at('2026-09-22', '12:00'));
  const clockOut = await on('AlexK', id, { clockOutAt: now(), status: 'submitted', approvalStatus: 'pending', hours: 3.75, grossEstimate: 0, locationTracking: false, locationStatus: 'stopped', updatedAt: now() });
  assert.equal(clockOut.status, 200, clockOut.error);
  const card = await read(id);
  assert.deepEqual([card.employee, card.clockOutAt, card.status, card.approvalStatus, card.hours, card.breaks.length], ['alexk', iso(at('2026-09-22', '12:00')), 'submitted', 'pending', 3.75, 1]);
});

test('HTTP: with staff roles off (the default), the same sales-stored business user closes and approves another employee’s card as before', async t => {
  const { off, read } = await rolesHub(t);
  const closed = await off('AlexK', 'shift-open', { clockOutAt: at('2026-09-22', '15:00'), status: 'submitted' });
  assert.equal(closed.status, 200, closed.error);
  const approved = await off('AlexK', 'shift-done', { approvalStatus: 'approved', approvedBy: 'alexk', approvedAt: NOW, updatedAt: NOW });
  assert.equal(approved.status, 200, approved.error);
  const [open, done] = [await read('shift-open'), await read('shift-done')];
  assert.deepEqual([open.clockOutAt, open.status, open.updatedBy, open.history.at(-1).action, done.approvalStatus, done.approvedBy, done.approvedAt], [at('2026-09-22', '15:00'), 'submitted', 'AlexK', 'manager_timecard_update', 'approved', 'AlexK', NOW]);
});

// The crew app (crew/job.js) names a new shift time-<signed-in username, lowercased>-<base36 time> and sends it through its
// outbox; the username is whatever HUB_AUTH_USERS_JSON configures, never validated.
const outboxSource = readFileSync(new URL('../crew/field-outbox.js', import.meta.url), 'utf8');
function crewPhone(hubEnv, user) {
  const context = vm.createContext({ console, setTimeout, clearTimeout, Promise, JSON, Date, URL, Error, TypeError, Map, Set, encodeURIComponent });
  context.self = context;
  vm.runInContext(outboxSource, context);
  const api = context.EGCFieldOutbox, sent = [];
  const fetchImpl = async (path, init = {}) => {
    const cookie = await cookieFor(hubEnv, user), body = init.body ? JSON.parse(init.body) : undefined;
    if (body) sent.push(body);
    const request = jsonRequest(path, body, cookie), route = new URL(request.url).pathname;
    if (route === '/api/hub-auth') return hubAuth.onRequestGet({ request, env: hubEnv });
    if (route === '/api/employee-hub') return body ? employeeHub.onRequestPost({ request, env: hubEnv }) : employeeHub.onRequestGet({ request, env: hubEnv });
    throw new Error(`Unexpected crew request ${path}`);
  };
  const box = api.create({ store: api.memoryStore() }), transport = api.httpTransport(fetchImpl);
  const clock = (op, entryId, extra = {}) => ({ requestId: crypto.randomUUID(), kind: 'clock', user, jobId: 'job-a', payload: { op, entryId, deviceCapturedAt: new Date().toISOString(), ...extra } });
  // Exactly as crew/job.js builds a clock-in's ID.
  const clockInId = () => `time-${user.trim().toLowerCase()}-${Date.now().toString(36)}`;
  return { api, box, transport, sent, clock, clockInId, flush: () => box.flush({ user, transport }), items: () => box.items(user) };
}

test('HTTP: configured usernames with a space, "@" or "+" clock in and out from the crew app’s outbox, and a replayed clock-in keeps its ID', async t => {
  const { fire, read, setTime } = await hub(t);
  const hubEnv = staffEnv(ON, { 'Crew Space': { passwordHash: 'unused-synthetic-space-hash', role: 'crew', displayName: 'Synthetic Space Crew', hourlyRate: 18 },
    'crew+one@example.invalid': { passwordHash: 'unused-synthetic-email-hash', role: 'crew', displayName: 'Synthetic Email Crew', hourlyRate: 18 } });
  const point = { lat: 40.58, lng: -105.08, accuracy: 5 };
  for (const [user, expected] of [['Crew Space', /^time-crew space-[0-9a-z]+$/], ['crew+one@example.invalid', /^time-crew\+one@example\.invalid-[0-9a-z]+$/]]) {
    setTime('2026-09-21T13:00:00.000Z');
    const phone = crewPhone(hubEnv, user), entryId = phone.clockInId();
    assert.match(entryId, expected);
    const clockIn = phone.clock('clock_in', entryId, { lastLocation: point });
    await phone.box.enqueue(clockIn);
    const first = await phone.flush();
    assert.deepEqual([first.applied.length, first.stopped, (await phone.items()).length], [1, null, 0], JSON.stringify(first.stopped?.error?.message));
    const card = await read(entryId);
    assert.deepEqual([card.id, card.employee, card.status, card.clockInAt, card.locationStatus], [entryId, user, 'active', '2026-09-21T13:00:00.000Z', 'job_page_single_fix']);
    // The same clock-in sent again (a phone that lost the reply, or a copy queued on an older build) answers with the card it
    // made and writes nothing.
    const writes = fire.writes().length;
    await phone.box.enqueue({ ...clockIn, requestId: crypto.randomUUID() });
    const replay = await phone.flush();
    assert.deepEqual([replay.applied.length, replay.stopped, fire.writes().length], [1, null, writes]);
    setTime('2026-09-21T21:00:00.000Z');
    await phone.box.enqueue(phone.clock('clock_out', entryId));
    const out = await phone.flush();
    assert.deepEqual([out.applied.length, out.stopped], [1, null], JSON.stringify(out.stopped?.error?.message));
    const closed = await read(entryId);
    assert.deepEqual([closed.clockOutAt, closed.status, closed.approvalStatus, closed.hours], ['2026-09-21T21:00:00.000Z', 'submitted', 'pending', 8]);
    assert.ok(phone.sent.every(body => body.id === entryId), 'every save names the ID the phone chose');
  }
});

test('HTTP: a crew-app clock-in whose ID has a quote or "<" is refused with 400 before anything is written, and the phone keeps it for review', async t => {
  const { fire, setTime } = await hub(t);
  const hubEnv = staffEnv(ON, { "Crew O'Synthetic": { passwordHash: 'unused-synthetic-quote-hash', role: 'crew', displayName: 'Synthetic Quote Crew' } });
  setTime('2026-09-21T13:00:00.000Z');
  const phone = crewPhone(hubEnv, "Crew O'Synthetic"), before = fire.snapshot();
  for (const entryId of [phone.clockInId(), 'time-crew<script>-mfq2x9z1']) {
    const direct = await employeeHub.onRequestPost({ env: hubEnv, request: jsonRequest('/api/employee-hub', { collection: 'timeEntries', id: entryId, data: { locationTracking: true, lastLocation: { lat: 40.58, lng: -105.08, accuracy: 5 } } }, await cookieFor(hubEnv, "Crew O'Synthetic")) });
    assert.deepEqual([direct.status, (await direct.json()).code], [400, 'EMPLOYEE_TIMECARD_ID_INVALID'], entryId);
  }
  await phone.box.enqueue(phone.clock('clock_in', phone.clockInId(), { lastLocation: { lat: 40.58, lng: -105.08, accuracy: 5 } }));
  const result = await phone.flush();
  assert.deepEqual([result.applied.length, result.stopped?.reason, result.stopped?.error?.status, result.stopped?.error?.code], [0, 'rejected', 400, 'EMPLOYEE_TIMECARD_ID_INVALID']);
  assert.deepEqual(plain((await phone.items()).map(item => [item.state, item.error?.status])), [['error', 400]], 'kept on the phone with the reason, never dropped silently');
  assert.equal(fire.snapshot(), before, 'nothing written');
});
