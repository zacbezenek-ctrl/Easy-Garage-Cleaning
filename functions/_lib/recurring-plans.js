/** Pure recurring-plan date generator. No storage, no network and no ambient
 * clock: every "today" is derived from an injected instant. Dates are Denver
 * calendar dates (YYYY-MM-DD); calendar math uses UTC noon like dispatch-time.
 *
 * cadence:{frequency:'weekly'|'biweekly'} repeats from startDate.
 * cadence:{frequency:'every_n_weeks',intervalWeeks:1..52}
 * cadence:{frequency:'monthly'|'quarterly',monthlyBy:'day_of_month',dayOfMonth:1..31}
 *   clamps to the last day of shorter months without drifting (31 → 28 → 31).
 * cadence:{frequency:'monthly'|'quarterly',monthlyBy:'nth_weekday',nth:1..4|-1,weekday:0..6}
 *   nth -1 is the last matching weekday; weekday 0 is Sunday.
 * count limits series positions from startDate. skipDates remove individual
 * positions and do not extend the series (RFC 5545 EXDATE semantics). endsOn is
 * the inclusive last calendar date. Query ranges use an exclusive endDate. */
import { validDate, addDays, denverToday, scheduleInterval } from './dispatch-time.js';

export const RECURRING_FREQUENCIES = Object.freeze(['weekly','biweekly','every_n_weeks','monthly','quarterly']);
export const RECURRING_LIMITS = Object.freeze({ intervalWeeks:52, spanDays:30, count:520, skipDates:200, horizonMin:7, horizonMax:366, horizonDefault:56 });
const MAX_POSITIONS = 20000, LAST_DATE = '2200-01-01';
const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const ORDINALS = {1:'1st',2:'2nd',3:'3rd',4:'4th','-1':'last'};
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code: `recurring_${code}`, status });
const keys = (value, allowed, label) => { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail('field_invalid', `${label} contains unsupported fields. Refresh the form and try again.`); };
const integer = (value, label, min, max) => { if (!Number.isInteger(value) || value < min || value > max) throw fail('field_invalid', `${label} must be a whole number from ${min} to ${max}.`); return value; };
const parts = date => date.split('-').map(Number);
const iso = (year, month, day) => `${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
const lastDay = (year, month) => new Date(Date.UTC(year, month, 0, 12)).getUTCDate();
export const weekdayOf = date => new Date(date + 'T12:00:00Z').getUTCDay();
function shiftMonth(year, month, count) { const index = year * 12 + month - 1 + count; return [Math.floor(index / 12), index % 12 + 1]; }
function nthWeekday(year, month, weekday, nth) {
  if (nth === -1) { const end = lastDay(year, month); return iso(year, month, end - (weekdayOf(iso(year, month, end)) - weekday + 7) % 7); }
  return iso(year, month, 1 + (weekday - weekdayOf(iso(year, month, 1)) + 7) % 7 + (nth - 1) * 7);
}

export function normalizeCadence(input, startDate) {
  if (!validDate(startDate)) throw fail('start_invalid', 'Choose a valid first visit date.');
  keys(input, ['frequency','intervalWeeks','monthlyBy','dayOfMonth','nth','weekday'], 'The repeat pattern');
  const { frequency } = input, extra = name => Object.keys(input).filter(key => key !== 'frequency' && key !== name);
  if (!RECURRING_FREQUENCIES.includes(frequency)) throw fail('cadence_invalid', 'Choose weekly, every 2 weeks, every N weeks, monthly or quarterly.');
  if (['weekly','biweekly','every_n_weeks'].includes(frequency)) {
    if (extra(frequency === 'every_n_weeks' ? 'intervalWeeks' : '').length) throw fail('cadence_invalid', 'Weekly patterns repeat from the first visit date.');
    return frequency === 'every_n_weeks' ? { frequency, intervalWeeks: integer(input.intervalWeeks, 'Weeks between visits', 1, RECURRING_LIMITS.intervalWeeks) } : { frequency };
  }
  const monthlyBy = input.monthlyBy ?? 'day_of_month', day = parts(startDate)[2];
  if ('intervalWeeks' in input || !['day_of_month','nth_weekday'].includes(monthlyBy)) throw fail('cadence_invalid', 'Choose a day of the month or a weekday of the month.');
  if (monthlyBy === 'day_of_month') {
    if ('nth' in input || 'weekday' in input) throw fail('cadence_invalid', 'A day-of-month pattern cannot also choose a weekday.');
    return { frequency, monthlyBy, dayOfMonth: integer(input.dayOfMonth ?? day, 'Day of the month', 1, 31) };
  }
  if ('dayOfMonth' in input) throw fail('cadence_invalid', 'A weekday-of-month pattern cannot also choose a day number.');
  const nth = input.nth ?? (Math.ceil(day / 7) > 4 ? -1 : Math.ceil(day / 7));
  if (![1,2,3,4,-1].includes(nth)) throw fail('cadence_invalid', 'Choose the 1st, 2nd, 3rd, 4th or last weekday of the month.');
  return { frequency, monthlyBy, nth, weekday: integer(input.weekday ?? weekdayOf(startDate), 'Weekday', 0, 6) };
}

export function cadenceLabel(cadence) {
  const weeks = { weekly:1, biweekly:2 }[cadence?.frequency] || cadence?.intervalWeeks;
  if (['weekly','biweekly','every_n_weeks'].includes(cadence?.frequency)) return weeks === 1 ? 'Every week' : `Every ${weeks} weeks`;
  const prefix = cadence?.frequency === 'quarterly' ? 'Every 3 months' : 'Monthly';
  if (cadence?.monthlyBy === 'nth_weekday') return `${prefix} on the ${ORDINALS[cadence.nth]} ${WEEKDAYS[cadence.weekday]}`;
  return `${prefix} on day ${cadence?.dayOfMonth}${cadence?.dayOfMonth > 28 ? ' (last day in shorter months)' : ''}`;
}

function* series({ cadence, startDate }) {
  if (['weekly','biweekly','every_n_weeks'].includes(cadence.frequency)) {
    const step = 7 * ({ weekly:1, biweekly:2 }[cadence.frequency] || cadence.intervalWeeks);
    for (let index = 0; ; index++) yield addDays(startDate, index * step);
  }
  const [year, month] = parts(startDate), months = cadence.frequency === 'quarterly' ? 3 : 1;
  for (let index = 0; ; index++) {
    const [y, m] = shiftMonth(year, month, index * months);
    const date = cadence.monthlyBy === 'nth_weekday' ? nthWeekday(y, m, cadence.weekday, cadence.nth) : iso(y, m, Math.min(cadence.dayOfMonth, lastDay(y, m)));
    if (date >= startDate) yield date;
  }
}

/** Occurrence dates within [startDate, endDate). Series positions are always
 * counted from plan.startDate so count/endsOn are stable for any window. */
export function occurrenceDates(plan, { startDate, endDate, limit = Infinity }) {
  if (!validDate(startDate) || !validDate(endDate)) throw fail('range_invalid', 'Choose a valid date range. The end date is exclusive.');
  if (!validDate(plan?.startDate) || !object(plan.cadence)) throw fail('plan_invalid', 'This recurring plan has no valid schedule.');
  const skip = new Set(Array.isArray(plan.skipDates) ? plan.skipDates : []), output = [];
  let position = 0;
  for (const date of series(plan)) {
    if (!date || date >= endDate || date >= LAST_DATE || position >= MAX_POSITIONS || output.length >= limit) break;
    if (Number.isInteger(plan.count) && position >= plan.count) break;
    if (plan.endsOn && date > plan.endsOn) break;
    position++;
    if (date >= startDate && !skip.has(date)) output.push(date);
  }
  return output;
}

export function horizonRange(now, horizonDays = RECURRING_LIMITS.horizonDefault) {
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw fail('clock_invalid', 'A valid current time is required.');
  const startDate = denverToday(instant);
  return { startDate, endDate: addDays(startDate, integer(horizonDays, 'Scheduling horizon', 1, RECURRING_LIMITS.horizonMax) + 1) };
}

export function nextOccurrences(plan, { now, limit = 6 }) {
  const { startDate } = horizonRange(now, 1);
  return occurrenceDates(plan, { startDate, endDate: LAST_DATE, limit });
}

export function occurrenceSchedule(plan, date) {
  return { date, time: plan.time, endDate: addDays(date, plan.spanDays || 0), endTime: plan.endTime };
}

/** Validates the complete schedule half of a plan. Assignment and template
 * identity are verified by the service against canonical records. */
export function normalizeRecurringSchedule(input) {
  keys(input, ['cadence','startDate','time','endTime','spanDays','endsOn','count','skipDates','horizonDays'], 'The recurring schedule');
  const { startDate, time, endTime } = input;
  const cadence = normalizeCadence(input.cadence, startDate);
  if (!TIME.test(time || '') || !TIME.test(endTime || '')) throw fail('time_invalid', 'Choose a start and end time for each visit.');
  const spanDays = integer(input.spanDays ?? 0, 'Visit length in days', 0, RECURRING_LIMITS.spanDays);
  if (!scheduleInterval({ date:startDate, time, endDate:addDays(startDate, spanDays), endTime })) throw fail('time_invalid', 'Choose valid Mountain Time start and end times. The end must be after the start, and missing or repeated daylight-saving hours cannot be used.');
  const endsOn = input.endsOn ?? null, count = input.count ?? null;
  if (endsOn !== null && (!validDate(endsOn) || endsOn < startDate)) throw fail('end_invalid', 'The last date must be on or after the first visit.');
  if (count !== null) integer(count, 'Number of visits', 1, RECURRING_LIMITS.count);
  const skipDates = input.skipDates ?? [];
  if (!Array.isArray(skipDates) || skipDates.length > RECURRING_LIMITS.skipDates || skipDates.some(date => !validDate(date))) throw fail('skip_invalid', `Enter at most ${RECURRING_LIMITS.skipDates} valid skipped dates.`);
  const horizonDays = integer(input.horizonDays ?? RECURRING_LIMITS.horizonDefault, 'Scheduling horizon', RECURRING_LIMITS.horizonMin, RECURRING_LIMITS.horizonMax);
  return { cadence, startDate, time, endTime, spanDays, endsOn, count, skipDates: [...new Set(skipDates)].sort(), horizonDays };
}
