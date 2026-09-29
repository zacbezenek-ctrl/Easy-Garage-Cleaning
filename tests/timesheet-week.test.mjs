process.env.TZ = 'Asia/Tokyo';
import test from 'node:test';
import assert from 'node:assert/strict';
import { OVERTIME_POLICIES, computeTimesheetWeek, computeTimesheetWeeks, denverWorkDate, overtimePolicy, payAmount, ptoFromRequests, timecardPayState, timecardWorkIntervals, timesheetWeekStart } from '../functions/_lib/timesheet-week.js';
import { timecardWorkDate } from '../functions/_lib/employee-timecards.js';

// September 2026 is MDT (UTC-6); the workweek under test runs Monday 2026-09-21 through Sunday 2026-09-27.
const AFTER = '2026-10-05T18:00:00.000Z';
const at = (date, time, offset = '-06:00') => `${date}T${time}:00${offset}`;
const shift = (id, clockInAt, clockOutAt, extra = {}) => ({ id, employee: 'Crew.One', employeeName: 'Crew One', payType: 'hourly', hourlyRate: 20, clockInAt, clockOutAt, status: 'submitted', approvalStatus: 'approved', breaks: [], ...extra });
const day = (id, date, from, to, extra) => shift(id, at(date, from), at(date, to), extra);
const week = (timecards, options = {}) => computeTimesheetWeek({ timecards, weekStart: '2026-09-21', now: AFTER, ...options });
const only = result => { assert.equal(result.employees.length, 1); return result.employees[0]; };

test('Colorado pays daily overtime over 12 hours even when the week stays under 40', () => {
  const cards = [day('mon', '2026-09-21', '06:00', '20:00'), day('tue', '2026-09-22', '06:00', '20:00'), day('wed', '2026-09-23', '08:00', '12:00')];
  const row = only(week(cards));
  assert.deepEqual([row.workedHours, row.regularHours, row.overtimeHours, row.doubleTimeHours], [32, 28, 4, 0]);
  assert.equal(row.overtimeBasis, 'daily'); assert.equal(row.dailyOvertimeHours, 4); assert.equal(row.weeklyOvertimeHours, 0);
  assert.deepEqual([row.regularRate, row.straightPay, row.overtimePremium, row.grossPay], [20, 640, 40, 680]);
  assert.deepEqual(row.days.slice(0, 3).map(item => [item.date, item.workedHours, item.dailyOvertimeHours]), [['2026-09-21', 14, 2], ['2026-09-22', 14, 2], ['2026-09-23', 4, 0]]);
  const federal = only(week(cards, { policy: 'federal' }));
  assert.deepEqual([federal.regularHours, federal.overtimeHours, federal.overtimePremium, federal.grossPay], [32, 0, 0, 640]);
});

test('weekly and daily overtime take the greater calculation and are never added together', () => {
  const long = ['2026-09-21', '2026-09-22', '2026-09-23'].map((date, index) => day(`long-${index}`, date, '06:00', '20:00'));
  const mixed = only(week([...long, day('short', '2026-09-24', '08:00', '12:00')]));
  assert.deepEqual([mixed.workedHours, mixed.dailyOvertimeHours, mixed.weeklyOvertimeHours, mixed.overtimeHours, mixed.regularHours], [46, 6, 6, 6, 40]);
  const thirteen = only(week(['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'].map((date, index) => day(`d${index}`, date, '06:00', '19:00'))));
  assert.deepEqual([thirteen.workedHours, thirteen.dailyOvertimeHours, thirteen.weeklyOvertimeHours, thirteen.overtimeHours, thirteen.overtimeBasis], [52, 4, 12, 12, 'weekly']);
  assert.equal(thirteen.overtimePremium, 120); assert.equal(thirteen.grossPay, 1160);
  const nine = only(week(['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'].map((date, index) => day(`n${index}`, date, '07:00', '16:00'))));
  assert.deepEqual([nine.workedHours, nine.overtimeHours, nine.overtimeBasis, nine.overtimePremium], [45, 5, 'weekly', 50]);
});

test('cross-midnight shifts belong to their clock-in workDate and 12 consecutive hours span separate timecards', () => {
  const overnight = only(week([shift('night', at('2026-09-21', '18:00'), at('2026-09-22', '08:00'))]));
  assert.deepEqual(overnight.days.slice(0, 2).map(item => [item.workedHours, item.dailyOvertimeHours]), [[14, 2], [0, 0]]);
  assert.equal(overnight.overtimeHours, 2);
  const evening = shift('evening', at('2026-09-21', '17:00'), at('2026-09-21', '23:30'));
  const joined = only(week([evening, shift('early', at('2026-09-22', '00:00'), at('2026-09-22', '07:00'))]));
  assert.deepEqual([joined.workedHours, joined.dailyOvertimeHours, joined.overtimeHours], [13.5, 1.5, 1.5]);
  assert.deepEqual(joined.timecards.map(item => [item.id, item.workDate, item.dailyOvertimeHours]), [['evening', '2026-09-21', 0], ['early', '2026-09-22', 1.5]]);
  assert.equal(only(week([evening, shift('early', at('2026-09-22', '00:30'), at('2026-09-22', '07:30'))])).overtimeHours, 0, 'an hour off restarts the consecutive count');
  assert.equal(only(week([evening, shift('early', at('2026-09-22', '00:00'), at('2026-09-22', '07:00'))], { policy: 'federal' })).overtimeHours, 0);
});

test('consecutive hours crossing the workweek boundary are attributed to the later timecard’s week', () => {
  const cards = [shift('sunday', at('2026-09-27', '18:00'), at('2026-09-27', '23:50')), shift('monday', at('2026-09-28', '00:00'), at('2026-09-28', '08:00'))];
  const first = only(week(cards)), second = only(computeTimesheetWeek({ timecards: cards, weekStart: '2026-09-28', now: AFTER }));
  assert.deepEqual([first.workedHours, first.overtimeHours], [5.833, 0]);
  assert.deepEqual([second.workedHours, second.overtimeHours, second.overtimeBasis], [8, 1.833, 'daily']);
});

test('paid rest breaks count as work while meal and legacy breaks are unpaid, without double counting daily and consecutive time', () => {
  const breaks = [{ startAt: at('2026-09-21', '09:00'), endAt: at('2026-09-21', '09:10'), kind: 'rest' }, { startAt: at('2026-09-21', '12:00'), endAt: at('2026-09-21', '12:30'), kind: 'meal' }, { startAt: at('2026-09-21', '15:00'), endAt: at('2026-09-21', '15:10'), kind: 'rest' }];
  const paid = only(week([day('rest', '2026-09-21', '06:00', '19:00', { breaks })]));
  assert.deepEqual([paid.workedHours, paid.overtimeHours, paid.timecards[0].paidRestHours, paid.timecards[0].unpaidBreakHours], [12.5, 0.5, 0.333, 0.5]);
  const legacy = only(week([day('legacy', '2026-09-21', '06:00', '19:00', { breaks: breaks.map(({ kind, ...item }) => item) })]));
  assert.deepEqual([legacy.workedHours, legacy.overtimeHours], [12.167, 0.167]);
  assert.deepEqual(timecardWorkIntervals(day('x', '2026-09-21', '06:00', '07:00', { breaks: [{ startAt: at('2026-09-21', '06:00'), endAt: at('2026-09-21', '07:00') }] })), { reason: 'no_work_time' });
});

test('different snapshotted rates use a weighted regular rate for the overtime premium', () => {
  const cards = [...['2026-09-21', '2026-09-22', '2026-09-23'].map((date, index) => day(`a${index}`, date, '06:00', '16:00')),
    day('b1', '2026-09-24', '06:00', '14:00', { hourlyRate: 26 }), day('b2', '2026-09-25', '06:00', '13:00', { hourlyRate: 26 })];
  const row = only(week(cards));
  assert.deepEqual([row.workedHours, row.overtimeHours, row.straightPay, row.regularRate, row.overtimePremium, row.grossPay], [45, 5, 990, 22, 55, 1045]);
  assert.deepEqual(row.flags, ['multiple_rates']);
  const doubled = only(week(cards, { policy: { ...OVERTIME_POLICIES.colorado, multiplier: 2 } }));
  assert.equal(doubled.overtimePremium, 110);
  assert.throws(() => week(cards, { policy: { ...OVERTIME_POLICIES.colorado, multiplier: 1.2 } }), { code: 'timesheet_policy_invalid' });
  assert.throws(() => week(cards, { policy: 'california' }), { code: 'timesheet_policy_invalid' });
});

test('pending timecards are excluded unless requested while open and rejected shifts never pay', () => {
  const cards = [day('approved', '2026-09-21', '08:00', '16:00'), day('pending', '2026-09-22', '08:00', '16:00', { approvalStatus: 'pending' }),
    shift('open', at('2026-09-23', '08:00'), '', { status: 'active', approvalStatus: 'open' }), day('rejected', '2026-09-24', '08:00', '16:00', { approvalStatus: 'rejected' })];
  assert.deepEqual(cards.map(timecardPayState), ['approved', 'pending', 'open', 'rejected']);
  const approvedOnly = week(cards), row = only(approvedOnly);
  assert.deepEqual([row.workedHours, row.approvedTimecards, row.pendingTimecards, row.pendingExcludedTimecards, row.openShifts], [8, 1, 0, 1, 1]);
  assert.deepEqual(approvedOnly.excluded, { pending: 1, open: 1, rejected: 1 });
  assert.deepEqual(approvedOnly.coverage, { complete: false, weekEnded: true, asOf: AFTER, reasons: ['open_shifts', 'pending_timecards'] });
  const projected = week(cards, { includePending: true }), included = only(projected);
  assert.deepEqual([included.workedHours, included.approvedTimecards, included.pendingTimecards, included.flags], [16, 1, 1, ['includes_pending']]);
  assert.deepEqual(projected.coverage.reasons, ['open_shifts']);
  const complete = week([cards[0], cards[3]]);
  assert.equal(complete.coverage.complete, true);
  assert.deepEqual(week([cards[0]], { now: '2026-09-24T18:00:00.000Z' }).coverage.reasons, ['week_in_progress']);
});

test('approved paid PTO is a separate non-overtime category while unpaid, pending and legacy time off pays nothing', () => {
  const cards = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-26'].map((date, index) => day(`w${index}`, date, '06:00', '16:00'));
  const requests = [
    { id: 'pto-paid', type: 'time_off', status: 'approved', employee: 'Crew.One', startDate: '2026-09-24', endDate: '2026-09-25', paidHoursPerDay: 8, hourlyRate: 999 },
    { id: 'pto-legacy', type: 'time_off', status: 'approved', employee: 'Crew.One', startDate: '2026-09-27', endDate: '2026-09-27' },
    { id: 'pto-pending', type: 'time_off', status: 'pending', employee: 'Crew.One', startDate: '2026-09-27', paidHoursPerDay: 8 },
    { id: 'shift-change', type: 'shift_change', status: 'approved', employee: 'Crew.One', startDate: '2026-09-27', paidHoursPerDay: 8 },
    { id: 'pto-other', type: 'time_off', status: 'approved', employee: 'Crew.Two', startDate: '2026-09-21', paidHoursPerDay: 4 },
  ];
  const pto = ptoFromRequests(requests);
  assert.deepEqual(pto.map(entry => [entry.id, entry.date, entry.hours, entry.hourlyRate]), [['pto-paid', '2026-09-24', 8, undefined], ['pto-paid', '2026-09-25', 8, undefined], ['pto-other', '2026-09-21', 4, undefined]]);
  const result = week(cards, { pto }), crew = result.employees.find(row => row.employee === 'crew.one'), other = result.employees.find(row => row.employee === 'crew.two');
  assert.deepEqual([crew.workedHours, crew.overtimeHours, crew.ptoHours, crew.totalPaidHours], [40, 0, 16, 56]);
  assert.deepEqual([crew.straightPay, crew.ptoPay, crew.grossPay], [800, 320, 1120]);
  assert.deepEqual(crew.days.map(item => item.ptoHours), [0, 0, 0, 8, 8, 0, 0]);
  assert.deepEqual([other.ptoHours, other.ptoPay, other.flags], [4, 0, ['missing_pto_rate']]);
  const invalid = week(cards, { pto: ptoFromRequests([{ ...requests[0], paidHoursPerDay: 30 }, { ...requests[0], id: 'pto-string', paidHoursPerDay: '8' }, { ...requests[0], id: 'pto-range', endDate: '2026-12-31' }]) });
  assert.deepEqual(invalid.needsReview.map(item => [item.id, item.reason]), [['pto-paid', 'invalid_pto'], ['pto-paid', 'invalid_pto'], ['pto-string', 'invalid_pto'], ['pto-string', 'invalid_pto'], ['pto-range', 'invalid_pto']]);
  assert.equal(invalid.coverage.complete, false);
});

test('paid time off skips Saturday and Sunday unless a manager also sets paidWeekends', () => {
  const request = { id: 'trip', type: 'time_off', status: 'approved', employee: 'Crew.One', startDate: '2026-09-25', endDate: '2026-09-28', paidHoursPerDay: 8 };
  assert.deepEqual(ptoFromRequests([request]).map(entry => entry.date), ['2026-09-25', '2026-09-28']);
  assert.deepEqual(ptoFromRequests([{ ...request, paidWeekends: true }]).map(entry => entry.date), ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28']);
  assert.deepEqual(ptoFromRequests([{ ...request, paidWeekends: 'yes' }]).length, 2);
  const vacation = week([day('before', '2026-09-14', '08:00', '16:00', { hourlyRate: 20 })], { pto: ptoFromRequests([{ ...request, startDate: '2026-09-21', endDate: '2026-09-27' }]) });
  assert.deepEqual([only(vacation).ptoHours, only(vacation).ptoPay, only(vacation).days.map(item => item.ptoHours)], [40, 800, [8, 8, 8, 8, 8, 0, 0]]);
});

test('workflow approvals pay their recorded paid days, win over older pay fields, and send unreadable terms to review', () => {
  // A workflow approval: its approve decision's by/at are the request's reviewedBy/reviewedAt.
  const at = '2026-09-20T15:00:00.000Z', base = { type: 'time_off', status: 'approved', employee: 'Crew.One', startDate: '2026-09-25', endDate: '2026-09-28', reviewedBy: 'zacb', reviewedAt: at, decisions: [{ action: 'approve', status: 'approved', by: 'zacb', at }] };
  const paid = request => ptoFromRequests([request]).map(entry => [entry.id, entry.date, entry.hours, entry.hourlyRate]);
  // The same fields without that decision (an employee wrote them into an older request) pay only by the older rule.
  assert.deepEqual(paid({ ...base, id: 'unbound', decisions: [], paid: true, hoursPerDay: 12, paidDates: ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28'] }), []);
  assert.deepEqual(paid({ ...base, id: 'unbound-older', reviewedAt: '2026-09-21T00:00:00.000Z', paid: true, hoursPerDay: 4, paidDates: ['2026-09-26'], paidHoursPerDay: 8 }), [['unbound-older', '2026-09-25', 8, undefined], ['unbound-older', '2026-09-28', 8, undefined]]);
  // The manager's paid days, weekend days included only when chosen; without them, the requested weekdays.
  assert.deepEqual(paid({ ...base, id: 'chosen', paid: true, hoursPerDay: 8, paidDates: ['2026-09-26', '2026-09-28'], hourlyRate: 999 }), [['chosen', '2026-09-26', 8, undefined], ['chosen', '2026-09-28', 8, undefined]]);
  assert.deepEqual(paid({ ...base, id: 'default', paid: true, hoursPerDay: 7.5 }), [['default', '2026-09-25', 7.5, undefined], ['default', '2026-09-28', 7.5, undefined]]);
  // A request carrying both shapes pays by the workflow fields alone.
  assert.deepEqual(paid({ ...base, id: 'both', paid: true, hoursPerDay: 4, paidDates: ['2026-09-25'], paidHoursPerDay: 8, paidWeekends: true }), [['both', '2026-09-25', 4, undefined]]);
  assert.deepEqual(paid({ ...base, id: 'unpaid', paid: false, hoursPerDay: null, paidHoursPerDay: 8, paidWeekends: true }), []);
  // An early end pays only the days before the first day back, in either shape.
  assert.deepEqual(paid({ ...base, id: 'ended', paid: true, hoursPerDay: 8, paidDates: ['2026-09-25', '2026-09-26', '2026-09-28'], endedEarlyFrom: '2026-09-26' }), [['ended', '2026-09-25', 8, undefined]]);
  assert.deepEqual(paid({ ...base, id: 'older-ended', paidHoursPerDay: 8, endedEarlyFrom: '2026-09-28' }), [['older-ended', '2026-09-25', 8, undefined]]);
  for (const status of ['pending', 'denied', 'cancelled', '']) assert.deepEqual(paid({ ...base, id: 'not-approved', status, paid: true, hoursPerDay: 8, paidDates: ['2026-09-25'] }), []);
  const result = week([day('mon', '2026-09-21', '08:00', '16:00')], { pto: ptoFromRequests([{ ...base, id: 'chosen', paid: true, hoursPerDay: 8, paidDates: ['2026-09-25', '2026-09-26', '2026-09-28'] }]) }), row = only(result);
  assert.deepEqual([row.workedHours, row.ptoHours, row.ptoPay, row.totalPaidHours, row.days.map(item => item.ptoHours)], [8, 16, 320, 24, [0, 0, 0, 0, 8, 8, 0]]);
  // Unreadable workflow terms are reviewed, never paid as 0.
  const invalid = week([], { pto: ptoFromRequests([{ ...base, id: 'hours', paid: true, hoursPerDay: 13, paidDates: ['2026-09-25'] }, { ...base, id: 'range', paid: true, hoursPerDay: 8, endDate: '2026-12-31' }, { ...base, id: 'list', paid: true, hoursPerDay: 8, paidDates: '2026-09-25' }]) });
  assert.deepEqual(invalid.needsReview.map(item => [item.id, item.reason, item.workDate]), [['hours', 'invalid_pto', '2026-09-25'], ['range', 'invalid_pto', '2026-09-25'], ['list', 'invalid_pto', '2026-09-25']]);
  assert.equal(invalid.coverage.complete, false);
});

test('invalid, overlapping and unidentified timecards need review and never enter pay totals', () => {
  const cards = [
    day('valid', '2026-09-25', '08:00', '12:00'),
    day('outside-break', '2026-09-21', '08:00', '12:00', { breaks: [{ startAt: at('2026-09-21', '11:30'), endAt: at('2026-09-21', '12:30') }] }),
    day('open-break', '2026-09-22', '08:00', '12:00', { breaks: [{ startAt: at('2026-09-22', '10:00'), endAt: '' }] }),
    day('overlap-a', '2026-09-23', '06:00', '12:00'), day('overlap-b', '2026-09-23', '11:00', '14:00'),
    day('backwards', '2026-09-24', '12:00', '08:00'),
    { ...day('nobody', '2026-09-24', '08:00', '09:00'), employee: '' },
    shift('garbled', 'yesterday', at('2026-09-24', '09:00')),
    day('other-week', '2026-09-30', '12:00', '08:00'),
  ];
  const result = week(cards), row = only(result);
  assert.deepEqual(result.needsReview.map(item => [item.id, item.reason]).sort(), [['backwards', 'invalid_shift_times'], ['garbled', 'invalid_shift_times'], ['nobody', 'missing_identity'], ['open-break', 'open_break'], ['outside-break', 'invalid_breaks'], ['overlap-a', 'overlapping_timecards'], ['overlap-b', 'overlapping_timecards']]);
  assert.deepEqual([row.workedHours, row.approvedTimecards], [4, 1]);
  assert.deepEqual(result.coverage.reasons, ['needs_review']);
});

test('elapsed time, not wall time, is paid across Denver daylight-saving changes', () => {
  const fallBack = computeTimesheetWeek({ timecards: [shift('fall', at('2026-10-31', '20:00'), at('2026-11-01', '08:00', '-07:00'))], weekStart: '2026-10-28', now: '2026-11-10T12:00:00Z' });
  assert.equal(fallBack.weekStart, '2026-10-26');
  assert.deepEqual([only(fallBack).workedHours, only(fallBack).overtimeHours, only(fallBack).days[5].date], [13, 1, '2026-10-31']);
  const springForward = computeTimesheetWeek({ timecards: [shift('spring', at('2026-03-07', '20:00', '-07:00'), at('2026-03-08', '08:00'))], weekStart: '2026-03-02', now: '2026-03-20T12:00:00Z' });
  assert.deepEqual([only(springForward).workedHours, only(springForward).overtimeHours], [11, 0]);
});

test('missing rates and non-hourly pay types are flagged for payroll review and block complete coverage', () => {
  const flagged = week([day('rate', '2026-09-21', '08:00', '12:00', { hourlyRate: undefined, payType: 'salary' })]), row = only(flagged);
  assert.deepEqual([row.straightPay, row.flags], [0, ['missing_rate', 'non_hourly_pay_type']]);
  assert.deepEqual(flagged.coverage, { complete: false, weekEnded: true, asOf: AFTER, reasons: ['missing_rate', 'non_hourly_pay_type'] });
  // One unrated 10-hour day in a 50-hour week: unrated hours stay out of the regular rate instead of diluting it.
  const cards = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'].map((date, index) => day(`w${index}`, date, '06:00', '16:00'));
  const unrated = week([...cards, day('unrated', '2026-09-25', '06:00', '16:00', { hourlyRate: 0 })]), partial = only(unrated);
  assert.deepEqual([partial.workedHours, partial.overtimeHours, partial.regularRate, partial.straightPay, partial.overtimePremium, partial.flags], [50, 10, 20, 800, 100, ['missing_rate', 'multiple_rates']]);
  assert.deepEqual(unrated.coverage.reasons, ['missing_rate']);
  // The Hub reads a manager-typed '25' as 25, so the engine does too; anything else is missing.
  const typed = only(week([day('typed', '2026-09-21', '08:00', '12:00', { hourlyRate: '25' })]));
  assert.deepEqual([typed.straightPay, typed.flags, typed.timecards[0].hourlyRate], [100, [], 25]);
  for (const value of ['25/hr', -5, Number.NaN, {}, '1e3']) assert.deepEqual(only(week([day('odd', '2026-09-21', '08:00', '12:00', { hourlyRate: value })])).flags, ['missing_rate'], String(value));
  assert.deepEqual([payAmount(undefined), payAmount(''), payAmount(' 12.50 '), payAmount(7)], [0, 0, 12.5, 7]);
  assert.ok([payAmount('-1'), payAmount(-1), payAmount('abc'), payAmount(Infinity)].every(Number.isNaN));
});

test('timecard bonus and tips are paid through, and a bonus raises the regular rate while tips do not', () => {
  const cards = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'].map((date, index) => day(`b${index}`, date, '07:00', '16:00'));
  cards[0].bonus = 90; cards[1].tips = '20';
  const row = only(week(cards));
  assert.deepEqual([row.workedHours, row.overtimeHours, row.straightPay, row.bonus, row.tips, row.regularRate, row.overtimePremium, row.grossPay], [45, 5, 900, 90, 20, 22, 55, 1065]);
  assert.deepEqual(row.flags, ['bonus_or_tips']);
  assert.deepEqual(row.timecards.slice(0, 2).map(item => [item.bonus, item.tips]), [[90, 0], [0, 20]]);
  const single = only(week([day('one', '2026-09-21', '08:00', '16:00', { bonus: 50, tips: 20 })]));
  assert.equal(single.grossPay, 230, 'matches the Hub pay card: 8h x $20 + $50 bonus + $20 tips');
  const invalid = week([day('odd', '2026-09-21', '08:00', '16:00', { bonus: 'a lot' }), day('neg', '2026-09-22', '08:00', '16:00', { tips: -5 })]);
  assert.deepEqual([invalid.employees.length, invalid.needsReview.map(item => [item.id, item.reason]), invalid.coverage.reasons], [0, [['odd', 'invalid_bonus_or_tips'], ['neg', 'invalid_bonus_or_tips']], ['needs_review']]);
});

test('unapproved time just before the workweek marks a consecutive-hours week incomplete until it is settled', () => {
  const monday = shift('monday', at('2026-09-28', '00:00'), at('2026-09-28', '08:00'));
  const second = (cards, options = {}) => computeTimesheetWeek({ timecards: cards, weekStart: '2026-09-28', now: AFTER, ...options });
  const sunday = shift('sunday', at('2026-09-27', '18:00'), at('2026-09-27', '23:50'), { approvalStatus: 'pending' });
  const pending = second([sunday, monday]), row = only(pending);
  assert.deepEqual([row.overtimeHours, row.flags, pending.coverage.reasons], [0, ['adjacent_unapproved_time'], ['adjacent_unapproved_time']]);
  const approved = second([{ ...sunday, approvalStatus: 'approved' }, monday]);
  assert.deepEqual([only(approved).overtimeHours, approved.coverage.complete], [1.833, true]);
  assert.deepEqual(only(second([sunday, monday], { includePending: true })).overtimeHours, 1.833);
  const open = shift('open', at('2026-09-27', '18:00'), '', { status: 'active', approvalStatus: 'open' });
  const broken = { ...sunday, approvalStatus: 'approved', breaks: [{ startAt: at('2026-09-27', '20:00'), endAt: '' }] };
  for (const card of [open, broken]) assert.deepEqual(second([card, monday]).coverage.reasons, ['adjacent_unapproved_time'], card.id);
  // Unapproved time that could only chain through an approved Sunday shift is still found.
  const chained = second([shift('early-sunday', at('2026-09-27', '10:00'), at('2026-09-27', '16:30'), { approvalStatus: 'pending' }), shift('late-sunday', at('2026-09-27', '17:00'), at('2026-09-27', '23:50')), monday]);
  assert.deepEqual(chained.coverage.reasons, ['adjacent_unapproved_time']);
  const rested = second([{ ...sunday, clockOutAt: at('2026-09-27', '22:00') }, shift('late-monday', at('2026-09-28', '06:00'), at('2026-09-28', '14:00'))]);
  assert.deepEqual(rested.coverage.complete, true, 'a gap of an hour or more restarts the consecutive count');
  assert.equal(second([sunday, monday], { policy: 'federal' }).coverage.complete, true);
  const stale = shift('stale', at('2026-08-20', '08:00'), '', { status: 'active', approvalStatus: 'open' });
  assert.equal(second([stale, monday]).coverage.complete, true, 'a shift longer than 31 days cannot reach this week');
});

test('records without a readable date are listed once as unattributed while a readable clock-out still dates them', () => {
  const cards = [day('good', '2026-09-21', '08:00', '12:00'), shift('no-in', '', at('2026-09-28', '01:00'), { approvalStatus: 'pending' }), shift('no-dates', 'soon', 'later')];
  const weeks = computeTimesheetWeeks({ timecards: cards, pto: ptoFromRequests([{ id: 'pto-bad', type: 'time_off', status: 'approved', employee: 'Crew.One', startDate: 'next week', paidHoursPerDay: 8 }]), weekStarts: ['2026-09-21', '2026-09-28', '2026-10-05'], now: '2026-10-20T18:00:00Z' });
  // The clock-out on Monday 01:00 could belong to a Sunday overnight shift, so both weeks review it.
  assert.deepEqual([...weeks.values()].map(result => result.needsReview.map(item => [item.id, item.reason, item.workDate])), [[['no-in', 'invalid_shift_times', '']], [['no-in', 'invalid_shift_times', '']], []]);
  for (const result of weeks.values()) {
    assert.deepEqual(result.unattributed.map(item => [item.id, item.employee, item.reason]), [['no-dates', 'crew.one', 'invalid_shift_times'], ['pto-bad', 'crew.one', 'invalid_pto']]);
    assert.ok(result.coverage.reasons.includes('unattributed_records'));
  }
  assert.deepEqual(weeks.get('2026-10-05').coverage.reasons, ['unattributed_records']);
});

test('workweeks start on Monday in Denver and the policy comes from EGC_OVERTIME_POLICY', () => {
  assert.equal(timesheetWeekStart('2026-09-27'), '2026-09-21');
  assert.equal(timesheetWeekStart('2026-09-21'), '2026-09-21');
  assert.equal(timesheetWeekStart('2027-01-01'), '2026-12-28');
  for (const value of ['2026-02-30', '09/21/2026', '', undefined]) assert.throws(() => timesheetWeekStart(value), { code: 'timesheet_week_invalid', status: 400 });
  const result = week([], { weekStart: '2026-09-24' });
  assert.deepEqual([result.weekStart, result.weekEnd, result.dates.length, result.employees.length, result.timeZone], ['2026-09-21', '2026-09-27', 7, 0, 'America/Denver']);
  assert.equal(overtimePolicy({}).name, 'colorado');
  assert.equal(overtimePolicy({ EGC_OVERTIME_POLICY: ' Federal ' }).name, 'federal');
  for (const value of ['california', '__proto__', 'constructor']) assert.throws(() => overtimePolicy({ EGC_OVERTIME_POLICY: value }), { code: 'timesheet_policy_invalid', status: 503 });
  assert.deepEqual(OVERTIME_POLICIES.colorado, { name: 'colorado', weeklyHours: 40, dailyHours: 12, consecutiveHours: 12, consecutiveGapMinutes: 60, multiplier: 1.5 });
  assert.throws(() => computeTimesheetWeek({ timecards: null, weekStart: '2026-09-21', now: AFTER }), { code: 'timesheet_records_invalid' });
});

test('the shared Denver work-date formatter matches the timecard work date exactly', () => {
  const values = ['2026-09-28T05:30:00Z', '2026-09-28T06:00:00Z', '2026-03-08T06:59:00Z', '2026-11-01T07:30:00Z', '2026-11-01T08:30:00Z', '2026-12-31T23:59:59.999-07:00', '2026-09-22T24:00:00Z', '2026-02-30T18:00:00Z', 'invalid', '', null, 42];
  for (const value of values) assert.equal(denverWorkDate(value), timecardWorkDate(value), String(value));
});

test('computing several weeks in one pass gives the same result as each week alone', () => {
  const cards = [shift('sunday', at('2026-09-27', '18:00'), at('2026-09-27', '23:50')), shift('monday', at('2026-09-28', '00:00'), at('2026-09-28', '08:00')),
    day('pending', '2026-09-22', '08:00', '16:00', { approvalStatus: 'pending' }), shift('garbled', 'bad', at('2026-09-24', '09:00'))];
  const pto = [{ id: 'p', employee: 'Crew.One', date: '2026-09-29', hours: 8 }, { id: 'bad-pto', employee: 'Crew.One', date: 'soon', hours: 8 }];
  const both = computeTimesheetWeeks({ timecards: cards, pto, weekStarts: ['2026-09-23', '2026-09-30', '2026-09-21'], now: AFTER });
  assert.deepEqual([...both.keys()], ['2026-09-21', '2026-09-28']);
  for (const weekStart of both.keys()) assert.deepEqual(both.get(weekStart), computeTimesheetWeek({ timecards: cards, pto, weekStart, now: AFTER }));
  // 'garbled' is dated by its clock-out; 'bad-pto' has no readable date and is unattributed in every week.
  assert.deepEqual([both.get('2026-09-21').needsReview.map(item => item.id), both.get('2026-09-28').needsReview.map(item => item.id)], [['garbled'], []]);
  assert.deepEqual([...both.values()].map(result => result.unattributed.map(item => item.id)), [['bad-pto'], ['bad-pto']]);
  assert.deepEqual(computeTimesheetWeeks({ timecards: cards, weekStarts: [], now: AFTER }).size, 0);
});

test('employees are separated by normalized username and the week totals add up', () => {
  const cards = [day('a', '2026-09-21', '06:00', '20:00'), day('b', '2026-09-21', '08:00', '12:00', { employee: 'crew.two', employeeName: 'Alex Two', hourlyRate: 30 }), day('c', '2026-09-22', '08:00', '10:00', { employee: ' CREW.ONE ' })];
  const result = week(cards);
  assert.deepEqual(result.employees.map(row => [row.employee, row.name, row.workedHours, row.overtimeHours]), [['crew.two', 'Alex Two', 4, 0], ['crew.one', 'Crew One', 16, 2]]);
  assert.deepEqual(result.totals, { employees: 2, workedHours: 20, regularHours: 18, overtimeHours: 2, doubleTimeHours: 0, ptoHours: 0, totalPaidHours: 20, straightPay: 440, overtimePremium: 20, ptoPay: 0, bonus: 0, tips: 0, grossPay: 460 });
});
