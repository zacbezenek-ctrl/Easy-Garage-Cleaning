import test from 'node:test';
import assert from 'node:assert/strict';
import { cadenceLabel, horizonRange, nextOccurrences, normalizeCadence, normalizeRecurringSchedule, occurrenceDates, occurrenceSchedule } from '../functions/_lib/recurring-plans.js';

const plan = (startDate, cadence, extra = {}) => ({ startDate, cadence: normalizeCadence(cadence, startDate), ...extra });
const between = (row, startDate, endDate) => occurrenceDates(row, { startDate, endDate });

test('weekly, biweekly and every-N-week cadences repeat from the first visit on Denver calendar dates', () => {
  assert.deepEqual(between(plan('2026-10-27', { frequency:'weekly' }), '2026-10-01', '2026-11-18'), ['2026-10-27', '2026-11-03', '2026-11-10', '2026-11-17']);
  assert.deepEqual(between(plan('2026-12-24', { frequency:'biweekly' }), '2026-12-01', '2027-02-01'), ['2026-12-24', '2027-01-07', '2027-01-21']);
  assert.deepEqual(between(plan('2026-09-22', { frequency:'every_n_weeks', intervalWeeks:3 }), '2026-10-01', '2026-12-01'), ['2026-10-13', '2026-11-03', '2026-11-24']);
  assert.deepEqual(between(plan('2026-09-22', { frequency:'weekly' }), '2026-09-22', '2026-09-29'), ['2026-09-22'], 'endDate is exclusive');
  assert.deepEqual(between(plan('2026-09-22', { frequency:'weekly' }), '2026-01-01', '2026-09-22'), [], 'nothing before the first visit');
});

test('monthly day-of-month clamps to month end without drifting, including leap years', () => {
  const row = plan('2027-12-31', { frequency:'monthly' });
  assert.deepEqual(row.cadence, { frequency:'monthly', monthlyBy:'day_of_month', dayOfMonth:31 });
  assert.deepEqual(between(row, '2027-12-01', '2028-06-01'), ['2027-12-31', '2028-01-31', '2028-02-29', '2028-03-31', '2028-04-30', '2028-05-31']);
  assert.deepEqual(between(plan('2026-01-30', { frequency:'monthly', dayOfMonth:30 }), '2026-01-01', '2026-04-01'), ['2026-01-30', '2026-02-28', '2026-03-30']);
  assert.deepEqual(between(plan('2026-09-20', { frequency:'monthly', dayOfMonth:15 }), '2026-09-01', '2026-12-01'), ['2026-10-15', '2026-11-15'], 'a day before the start waits for the next month');
});

test('monthly nth weekday and last weekday follow the calendar, and quarterly repeats every three months', () => {
  const second = plan('2026-09-08', { frequency:'monthly', monthlyBy:'nth_weekday' });
  assert.deepEqual(second.cadence, { frequency:'monthly', monthlyBy:'nth_weekday', nth:2, weekday:2 });
  assert.deepEqual(between(second, '2026-09-01', '2027-01-01'), ['2026-09-08', '2026-10-13', '2026-11-10', '2026-12-08']);
  const last = plan('2026-10-30', { frequency:'monthly', monthlyBy:'nth_weekday' });
  assert.equal(last.cadence.nth, -1, 'a fifth weekday becomes the last weekday');
  assert.deepEqual(between(last, '2026-10-01', '2027-03-01'), ['2026-10-30', '2026-11-27', '2026-12-25', '2027-01-29', '2027-02-26']);
  assert.deepEqual(between(plan('2026-11-30', { frequency:'quarterly' }), '2026-11-01', '2027-12-01'), ['2026-11-30', '2027-02-28', '2027-05-30', '2027-08-30', '2027-11-30']);
  assert.deepEqual(between(plan('2026-09-01', { frequency:'quarterly', monthlyBy:'nth_weekday', nth:1, weekday:1 }), '2026-09-01', '2027-07-01'), ['2026-09-07', '2026-12-07', '2027-03-01', '2027-06-07']);
});

test('skipDates remove single visits without extending count; endsOn is inclusive', () => {
  const row = plan('2026-09-22', { frequency:'weekly' }, { count:4, skipDates:['2026-09-29'] });
  assert.deepEqual(between(row, '2026-09-01', '2027-01-01'), ['2026-09-22', '2026-10-06', '2026-10-13']);
  assert.deepEqual(between(row, '2026-10-01', '2027-01-01'), ['2026-10-06', '2026-10-13'], 'count positions are anchored to the first visit');
  assert.deepEqual(between(plan('2026-09-22', { frequency:'weekly' }, { endsOn:'2026-10-13' }), '2026-09-01', '2027-01-01'), ['2026-09-22', '2026-09-29', '2026-10-06', '2026-10-13']);
  assert.deepEqual(occurrenceDates(plan('2026-09-22', { frequency:'weekly' }), { startDate:'2026-09-01', endDate:'2030-01-01', limit:2 }), ['2026-09-22', '2026-09-29']);
});

test('horizon and next occurrences use the injected clock in Denver time', () => {
  assert.deepEqual(horizonRange(new Date('2026-09-23T05:59:59Z'), 7), { startDate:'2026-09-22', endDate:'2026-09-30' });
  assert.deepEqual(horizonRange('2026-09-23T06:00:00Z', 7), { startDate:'2026-09-23', endDate:'2026-10-01' });
  assert.throws(() => horizonRange('not a time', 7), error => error.code === 'recurring_clock_invalid');
  const row = plan('2026-09-22', { frequency:'every_n_weeks', intervalWeeks:2 });
  assert.deepEqual(nextOccurrences(row, { now:new Date('2026-10-06T07:00:00Z'), limit:3 }), ['2026-10-06', '2026-10-20', '2026-11-03']);
  assert.deepEqual(occurrenceSchedule({ time:'22:00', endTime:'02:00', spanDays:1 }, '2026-12-31'), { date:'2026-12-31', time:'22:00', endDate:'2027-01-01', endTime:'02:00' });
});

test('cadence validation rejects unsupported or contradictory patterns', () => {
  const code = input => { try { normalizeCadence(input, '2026-09-22'); return 'ok'; } catch (error) { return error.code; } };
  assert.equal(code({ frequency:'daily' }), 'recurring_cadence_invalid');
  assert.equal(code({ frequency:'weekly', intervalWeeks:2 }), 'recurring_cadence_invalid');
  assert.equal(code({ frequency:'every_n_weeks' }), 'recurring_field_invalid');
  assert.equal(code({ frequency:'every_n_weeks', intervalWeeks:53 }), 'recurring_field_invalid');
  assert.equal(code({ frequency:'monthly', dayOfMonth:32 }), 'recurring_field_invalid');
  assert.equal(code({ frequency:'monthly', dayOfMonth:5, weekday:2 }), 'recurring_cadence_invalid');
  assert.equal(code({ frequency:'monthly', monthlyBy:'nth_weekday', nth:5 }), 'recurring_cadence_invalid');
  assert.equal(code({ frequency:'monthly', monthlyBy:'nth_weekday', dayOfMonth:3 }), 'recurring_cadence_invalid');
  assert.equal(code({ frequency:'quarterly', other:true }), 'recurring_field_invalid');
  assert.equal(code(null), 'recurring_field_invalid');
});

test('schedule normalization requires valid Mountain wall times and bounded limits', () => {
  const base = { cadence:{ frequency:'weekly' }, startDate:'2026-09-22', time:'08:00', endTime:'10:00' };
  assert.deepEqual(normalizeRecurringSchedule({ ...base, skipDates:['2026-10-06', '2026-09-29', '2026-10-06'] }), { ...base, spanDays:0, endsOn:null, count:null, skipDates:['2026-09-29', '2026-10-06'], horizonDays:56 });
  const code = input => { try { normalizeRecurringSchedule({ ...base, ...input }); return 'ok'; } catch (error) { return error.code; } };
  assert.equal(code({ startDate:'2026-03-08', time:'02:15', endTime:'04:00' }), 'recurring_time_invalid', 'missing DST hour');
  assert.equal(code({ startDate:'2026-11-01', time:'01:15', endTime:'03:00' }), 'recurring_time_invalid', 'repeated DST hour');
  assert.equal(code({ endTime:'07:00' }), 'recurring_time_invalid');
  assert.equal(code({ endTime:'07:00', spanDays:1 }), 'ok');
  assert.equal(code({ time:'8:00' }), 'recurring_time_invalid');
  assert.equal(code({ endsOn:'2026-09-21' }), 'recurring_end_invalid');
  assert.equal(code({ count:0 }), 'recurring_field_invalid');
  assert.equal(code({ skipDates:['2026-02-30'] }), 'recurring_skip_invalid');
  assert.equal(code({ horizonDays:400 }), 'recurring_field_invalid');
  assert.equal(code({ startDate:'2026-02-30' }), 'recurring_start_invalid');
  assert.equal(code({ customerId:'c1' }), 'recurring_field_invalid');
});

test('cadence labels describe the saved pattern for managers', () => {
  assert.equal(cadenceLabel({ frequency:'weekly' }), 'Every week');
  assert.equal(cadenceLabel({ frequency:'biweekly' }), 'Every 2 weeks');
  assert.equal(cadenceLabel({ frequency:'every_n_weeks', intervalWeeks:6 }), 'Every 6 weeks');
  assert.equal(cadenceLabel({ frequency:'monthly', monthlyBy:'day_of_month', dayOfMonth:31 }), 'Monthly on day 31 (last day in shorter months)');
  assert.equal(cadenceLabel({ frequency:'quarterly', monthlyBy:'nth_weekday', nth:-1, weekday:5 }), 'Every 3 months on the last Friday');
});
