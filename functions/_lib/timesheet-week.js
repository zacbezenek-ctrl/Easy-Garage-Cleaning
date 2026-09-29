import { activeTimecard } from './employee-timecards.js';
import { addDays, validDate } from './dispatch-time.js';
import { ptoPaidDays } from './pto-pay.js';

export const TIMESHEET_TIME_ZONE = 'America/Denver';
const HOUR = 3600000;

// Colorado Overtime and Minimum Pay Standards Order (COMPS, 7 CCR 1103-1; written against COMPS Order #39 and NOT
// re-verified for 2026 - the owner checklist asks the accountant to confirm the current order before payroll relies on it):
// Rule 4.1.1 requires time and one-half of the regular rate for work over 40 hours per workweek, over 12 hours
// per workday, or over 12 consecutive hours without regard to the start and end of the workday (excluding
// duty-free meal periods), "whichever calculation results in the greater payment of wages" - daily and weekly
// overtime are never added together. Rule 5.2 paid rest periods count as time worked; duty-free meal periods do not.
// Source to confirm: https://cdle.colorado.gov/dlss (Colorado Division of Labor Standards and Statistics).
// Neither Colorado nor the FLSA requires double time, so doubleTime is always 0 and exists only for Gusto parity.
// EGC interpretations the owner must confirm: the workday is the Denver calendar day of clock-in, so a shift is paid
// entirely in the day and workweek it started in; consecutiveGapMinutes is an employee-favorable reading of
// "consecutive": off-duty gaps shorter than an hour (a clock-out lunch, a short meal break) do not restart the
// 12-hour count; longer gaps do. Timecard bonuses are treated as non-discretionary and enter the regular rate;
// tips are paid through but excluded from it (FLSA 29 CFR 531.60).
export const OVERTIME_POLICIES = Object.freeze({
  colorado: Object.freeze({ name: 'colorado', weeklyHours: 40, dailyHours: 12, consecutiveHours: 12, consecutiveGapMinutes: 60, multiplier: 1.5 }),
  // FLSA 29 U.S.C. 207(a): time and one-half of the regular rate over 40 hours in a workweek only.
  federal: Object.freeze({ name: 'federal', weeklyHours: 40, dailyHours: null, consecutiveHours: null, consecutiveGapMinutes: null, multiplier: 1.5 }),
});

const fail = (message, code, status = 400, details) => Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const personKey = value => String(value || '').trim().toLowerCase();
const hours = ms => Math.round(ms / HOUR * 1000) / 1000;
const cents = value => Math.round(value * 100) / 100;
/** A manager-edited money field: blank is 0, and a number or plain decimal string (the Hub reads both) is its value.
 * Anything else, including negatives, is NaN so it can be sent to review instead of silently paying 0. */
export const payAmount = value => value === undefined || value === null || value === '' ? 0
  : typeof value === 'number' ? Number.isFinite(value) && value >= 0 ? value : NaN
  : typeof value === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(value) ? Number(value) : NaN;
/** Snapshotted hourly rate, or 0 when it is missing, zero or unreadable (flagged as missing_rate). */
export const payRate = value => { const amount = payAmount(value); return amount > 0 ? amount : 0; };
// Ordered coverage reasons. The pay-review ones can be acknowledged for a payroll export; the others must be fixed.
export const PAY_REVIEW_REASONS = Object.freeze(['missing_rate', 'missing_pto_rate', 'non_hourly_pay_type']);
export const COVERAGE_REASONS = Object.freeze(['week_in_progress', 'needs_review', 'unattributed_records', 'open_shifts', 'pending_timecards', 'adjacent_unapproved_time', ...PAY_REVIEW_REASONS]);
const instant = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return NaN;
  const date = value.slice(0, 10), calendar = Date.parse(`${date}T12:00:00Z`);
  if (!Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 10) !== date || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59) return NaN;
  return Date.parse(value);
};
const DENVER_DATE = new Intl.DateTimeFormat('en-US', { timeZone: TIMESHEET_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Same result as timecardWorkDate, with one shared formatter so multi-year histories stay fast. */
export function denverWorkDate(value) {
  const time = instant(value);
  if (!Number.isFinite(time)) return '';
  const parts = Object.fromEntries(DENVER_DATE.formatToParts(new Date(time)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function overtimePolicy(env = {}) {
  const name = String(env.EGC_OVERTIME_POLICY ?? '').trim().toLowerCase() || 'colorado';
  if (!Object.hasOwn(OVERTIME_POLICIES, name)) throw fail('Set EGC_OVERTIME_POLICY to colorado or federal before reviewing payroll.', 'timesheet_policy_invalid', 503);
  return OVERTIME_POLICIES[name];
}

export function resolveOvertimePolicy(policy) {
  const base = typeof policy === 'string' ? Object.hasOwn(OVERTIME_POLICIES, policy) && OVERTIME_POLICIES[policy] : record(policy) && Object.hasOwn(OVERTIME_POLICIES, policy.name) && policy;
  const threshold = value => value === null || typeof value === 'number' && Number.isFinite(value) && value > 0;
  if (!base || !threshold(base.weeklyHours) || base.weeklyHours === null || !threshold(base.dailyHours) || !threshold(base.consecutiveHours) || !threshold(base.consecutiveGapMinutes) ||
      typeof base.multiplier !== 'number' || !Number.isFinite(base.multiplier) || base.multiplier < 1.5 || base.multiplier > 3) throw fail('Choose the colorado or federal overtime policy with a multiplier of at least 1.5.', 'timesheet_policy_invalid', 503);
  return base;
}

/** EGC workweeks run Monday 00:00 through Sunday 24:00 America/Denver, matching the Hub's timesheet week. */
export function timesheetWeekStart(date) {
  if (!validDate(date)) throw fail('Choose a valid week start date.', 'timesheet_week_invalid');
  return addDays(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));
}

export function timecardPayState(card) {
  if (card?.approvalStatus === 'rejected') return 'rejected';
  if (activeTimecard(card) || !card?.clockOutAt) return 'open';
  return card.approvalStatus === 'approved' ? 'approved' : 'pending';
}

/** Worked intervals are the shift minus unpaid breaks. Rest breaks (kind 'rest') are paid time worked;
 * meal and legacy breaks without a kind stay unpaid. Invalid records are returned for manager review. */
export function timecardWorkIntervals(card) {
  const start = instant(card?.clockInAt), end = instant(card?.clockOutAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 31 * 86400000) return { reason: 'invalid_shift_times' };
  if (card.breaks !== undefined && !Array.isArray(card.breaks)) return { reason: 'invalid_breaks' };
  const intervals = []; let cursor = start, previousEnd = start, restMs = 0, unpaidMs = 0;
  for (const item of card.breaks || []) {
    if (!item?.endAt) return { reason: 'open_break' };
    const from = instant(item.startAt), to = instant(item.endAt);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < previousEnd || to < from || to > end) return { reason: 'invalid_breaks' };
    previousEnd = to;
    if (item.kind === 'rest') { restMs += to - from; continue; }
    if (from > cursor) intervals.push({ start: cursor, end: from });
    cursor = to; unpaidMs += to - from;
  }
  if (end > cursor) intervals.push({ start: cursor, end });
  const workedMs = intervals.reduce((sum, item) => sum + item.end - item.start, 0);
  if (workedMs <= 0) return { reason: 'no_work_time' };
  return { start, end, intervals, workedMs, restMs, unpaidMs };
}

// Marks the portion of chronological work beyond `limit`; a gap of at least `gap` restarts the count.
function excess(intervals, limit, gap = Infinity) {
  const over = []; let total = 0, last = -Infinity;
  for (const item of intervals) {
    if (item.start - last >= gap) total = 0;
    const room = Math.max(0, limit - total);
    if (item.end - item.start > room) over.push({ card: item.card, start: item.start + room, end: item.end });
    total += item.end - item.start; last = item.end;
  }
  return over;
}

function measure(intervals) {
  let total = 0, end = -Infinity;
  for (const item of [...intervals].sort((a, b) => a.start - b.start)) {
    const from = Math.max(item.start, end);
    if (item.end > from) total += item.end - from;
    end = Math.max(end, item.end);
  }
  return total;
}

const group = (map, key, item) => { if (!map.has(key)) map.set(key, []); map.get(key).push(item); };

/** Expands approved time-off requests into paid PTO days through the one PTO pay model (pto-pay.js). An approval
 * made in the request workflow pays its recorded paidDates at hoursPerDay; those fields win whenever the request has
 * a boolean paid. An older approval pays only an explicit manager-set paidHoursPerDay, on Monday to Friday unless a
 * manager also set paidWeekends: true, so a Mon-Sun vacation at 8 hours pays 40. Requests with neither remain unpaid
 * time off, and pay terms or dates that cannot be read go to review instead of paying 0. PTO is paid at the
 * employee's latest snapshotted timecard rate, never a rate stored on the employee-authored request. */
export function ptoFromRequests(requests = []) {
  const entries = [];
  for (const request of Array.isArray(requests) ? requests : []) {
    const pay = record(request) && request.status === 'approved' ? ptoPaidDays(request) : null;
    if (!pay) continue;
    const base = { id: String(request.id || ''), employee: request.employee, hours: pay.hours };
    if (pay.review) { entries.push({ ...base, date: pay.date, hours: NaN }); continue; }
    for (const date of pay.dates) entries.push({ ...base, date });
  }
  return entries;
}

export function computeTimesheetWeek({ weekStart, ...options } = {}) {
  const first = timesheetWeekStart(weekStart);
  return computeTimesheetWeeks({ ...options, weekStarts: [first] }).get(first);
}

/** Computes several workweeks in one pass: timecards are parsed and daily/consecutive overtime is measured once
 * per employee, so costing a quarter never re-reads the whole timecard history for each week. */
export function computeTimesheetWeeks({ timecards = [], pto = [], policy = 'colorado', weekStarts = [], now = new Date().toISOString(), includePending = false } = {}) {
  const rules = resolveOvertimePolicy(policy);
  if (!Array.isArray(timecards) || !Array.isArray(pto) || !Array.isArray(weekStarts)) throw fail('Timecards could not be read as a complete list.', 'timesheet_records_invalid', 503);
  const weeks = new Map();
  for (const value of weekStarts) {
    const first = timesheetWeekStart(value);
    if (!weeks.has(first)) weeks.set(first, { first, dates: Array.from({ length: 7 }, (_, index) => addDays(first, index)), needsReview: [], excluded: { pending: 0, open: 0, rejected: 0 }, people: new Map() });
  }
  const everyWeek = [...weeks.values()], weekOf = date => validDate(date) && weeks.get(timesheetWeekStart(date)) || null, included = [], unattributed = [];
  // Unapproved time (excluded pending, open or needing review) per employee, for the cross-week consecutive-hours check.
  const loose = new Map(), unapproved = (card, workDate, state) => {
    const start = instant(card.clockInAt), end = state === 'open' ? NaN : instant(card.clockOutAt);
    if (Number.isFinite(start)) group(loose, personKey(card.employee), { workDate, start, end: Number.isFinite(end) ? end : Infinity });
  };
  const person = (week, employee, name) => {
    const key = personKey(employee);
    if (!week.people.has(key)) week.people.set(key, { employee: key, name: String(name || employee || key).slice(0, 180), cards: [], pto: [], flags: new Set(), pendingExcluded: 0, open: 0 });
    return week.people.get(key);
  };
  // A record goes to review in the weeks of its dates. A timecard whose clock-in cannot be read falls back to its
  // clock-out day and the day before; a record with no readable date at all is listed once as unattributed.
  const review = (item, reason, dates, name = item?.employeeName) => {
    const entry = { id: String(item?.id || '').slice(0, 180), employee: personKey(item?.employee), name: String(name || item?.employee || '').slice(0, 180), workDate: validDate(dates[0]) && dates.length === 1 ? dates[0] : '', reason };
    if (!dates.some(validDate)) { unattributed.push(entry); return; }
    for (const week of new Set(dates.map(weekOf).filter(Boolean))) week.needsReview.push({ ...entry });
  };
  const cardDates = (card, workDate) => {
    if (workDate) return [workDate];
    const out = denverWorkDate(card?.clockOutAt);
    return out ? [out, addDays(out, -1)] : [];
  };
  for (const card of timecards) {
    const state = timecardPayState(card), workDate = denverWorkDate(card?.clockInAt), week = weekOf(workDate);
    if (state === 'rejected') { if (week) week.excluded.rejected++; continue; }
    if (!record(card) || typeof card.id !== 'string' || !card.id || !personKey(card.employee)) { review(card, 'missing_identity', cardDates(card, workDate)); continue; }
    if (!workDate) { review(card, 'invalid_shift_times', cardDates(card, workDate)); continue; }
    if (state === 'open' || state === 'pending' && !includePending) {
      unapproved(card, workDate, state);
      if (!week) continue;
      const row = person(week, card.employee, card.employeeName);
      if (state === 'open') { week.excluded.open++; row.open++; } else { week.excluded.pending++; row.pendingExcluded++; }
      continue;
    }
    const work = timecardWorkIntervals(card);
    const reason = work.reason || (!Number.isFinite(payAmount(card.bonus)) || !Number.isFinite(payAmount(card.tips)) ? 'invalid_bonus_or_tips' : '');
    if (reason) { unapproved(card, workDate, state); review(card, reason, [workDate]); continue; }
    included.push({ card, state, workDate, week, key: personKey(card.employee), ...work });
  }
  const byPerson = new Map(), daily = new Map(), rated = new Map(), gap = rules.consecutiveHours ? rules.consecutiveGapMinutes * 60000 : null;
  for (const item of included) group(byPerson, item.key, item);
  for (const [key, cards] of byPerson) {
    cards.sort((a, b) => a.start - b.start || a.end - b.end);
    rated.set(key, cards.filter(item => payRate(item.card.hourlyRate)));
    // Overlapping shifts for one employee would pay the same minutes twice.
    const overlapping = new Set(); let latest = null;
    for (const item of cards) {
      if (latest && item.start < latest.end) { overlapping.add(item); overlapping.add(latest); }
      if (!latest || item.end > latest.end) latest = item;
    }
    for (const item of overlapping) { unapproved(item.card, item.workDate, item.state); if (item.week) review(item.card, 'overlapping_timecards', [item.workDate]); }
    const valid = cards.filter(item => !overlapping.has(item)), over = new Map(), mark = list => { for (const interval of list) group(over, interval.card, interval); };
    const tagged = list => list.flatMap(item => item.intervals.map(interval => ({ ...interval, card: item })));
    if (rules.dailyHours) {
      const days = new Map();
      for (const item of valid) group(days, item.workDate, item);
      for (const [, list] of days) mark(excess(tagged(list), rules.dailyHours * HOUR));
    }
    if (rules.consecutiveHours) {
      const intervals = tagged(valid);
      mark(excess(intervals, rules.consecutiveHours * HOUR, gap));
      // Where each card's consecutive run began, so earlier unapproved time that could extend it is detectable.
      let runStart = -Infinity, last = -Infinity;
      for (const interval of intervals) { if (interval.start - last >= gap) runStart = interval.start; interval.card.runStart ??= runStart; last = interval.end; }
    }
    for (const item of valid) {
      daily.set(item, measure(over.get(item) || []));
      if (item.week) person(item.week, item.card.employee, item.card.employeeName).cards.push(item);
    }
  }
  for (const entry of pto) {
    const date = entry?.date, valid = record(entry) && personKey(entry.employee) && validDate(date) && typeof entry.hours === 'number' && Number.isFinite(entry.hours) && entry.hours > 0 && entry.hours <= 24 && Number.isFinite(payAmount(entry.hourlyRate));
    if (!valid) { review(entry, 'invalid_pto', validDate(date) ? [date] : [], entry?.employee); continue; }
    const week = weekOf(date);
    if (week) person(week, entry.employee).pto.push(entry);
  }
  const today = denverWorkDate(now), results = new Map();
  for (const week of everyWeek) {
    const { first, dates } = week, last = dates[6], employees = [];
    for (const row of week.people.values()) {
      let workedMs = 0, ratedMs = 0, dailyMs = 0, straight = 0, bonus = 0, tips = 0;
      const paid = new Set(), days = new Map(dates.map(date => [date, { date, workedMs: 0, dailyOvertimeMs: 0, ptoHours: 0, timecards: 0 }]));
      row.cards.sort((a, b) => a.start - b.start);
      for (const item of row.cards) {
        const hourly = payRate(item.card.hourlyRate), day = days.get(item.workDate), overtime = daily.get(item) || 0;
        if (!hourly) row.flags.add('missing_rate');
        if (item.card.payType && item.card.payType !== 'hourly') row.flags.add('non_hourly_pay_type');
        if (item.state === 'pending') row.flags.add('includes_pending');
        paid.add(hourly); workedMs += item.workedMs; dailyMs += overtime; straight += item.workedMs / HOUR * hourly;
        if (hourly) ratedMs += item.workedMs;
        bonus += payAmount(item.card.bonus); tips += payAmount(item.card.tips);
        day.workedMs += item.workedMs; day.dailyOvertimeMs += overtime; day.timecards++;
      }
      if (paid.size > 1) row.flags.add('multiple_rates');
      if (bonus || tips) row.flags.add('bonus_or_tips');
      // Unapproved time from an earlier week that ends within the consecutive gap of this week's first run could
      // still move consecutive-hours overtime into this week once it is approved (a valid shift spans at most 31 days).
      const opening = row.cards[0], runStart = opening?.runStart ?? opening?.start;
      if (gap !== null && opening && (loose.get(row.employee) || []).some(item => item.workDate < first && item.end > runStart - gap && item.start > opening.start - 31 * 86400000)) row.flags.add('adjacent_unapproved_time');
      // Regular rate: straight-time earnings plus non-discretionary bonus over the hours that have a rate. Hours
      // without a rate are flagged and left out so they cannot dilute everyone's overtime premium.
      const weeklyMs = Math.max(0, workedMs - rules.weeklyHours * HOUR), overtimeMs = Math.max(weeklyMs, dailyMs);
      const regularRate = ratedMs ? (straight + bonus) / (ratedMs / HOUR) : 0, premium = overtimeMs / HOUR * regularRate * (rules.multiplier - 1);
      let ptoMs = 0, ptoPay = 0;
      for (const entry of row.pto) {
        // PTO without its own rate uses the latest snapshotted rate on or before the end of this week.
        const hourly = payRate(entry.hourlyRate) || payRate((rated.get(row.employee) || []).filter(item => item.workDate <= last).at(-1)?.card.hourlyRate);
        if (!hourly) row.flags.add('missing_pto_rate');
        ptoMs += entry.hours * HOUR; ptoPay += entry.hours * hourly; days.get(entry.date).ptoHours += entry.hours;
      }
      const workedHours = hours(workedMs), overtimeHours = hours(overtimeMs), pay = { straightPay: cents(straight), overtimePremium: cents(premium), ptoPay: cents(ptoPay), bonus: cents(bonus), tips: cents(tips) };
      employees.push({ employee: row.employee, name: row.name, workedHours, regularHours: Math.round((workedHours - overtimeHours) * 1000) / 1000, overtimeHours, doubleTimeHours: 0, ptoHours: hours(ptoMs),
        totalPaidHours: hours(workedMs + ptoMs), dailyOvertimeHours: hours(dailyMs), weeklyOvertimeHours: hours(weeklyMs), overtimeBasis: !overtimeMs ? 'none' : weeklyMs >= dailyMs ? 'weekly' : 'daily',
        regularRate: Math.round(regularRate * 10000) / 10000, ...pay, grossPay: cents(pay.straightPay + pay.overtimePremium + pay.ptoPay + pay.bonus + pay.tips),
        approvedTimecards: row.cards.filter(item => item.state === 'approved').length, pendingTimecards: row.cards.filter(item => item.state === 'pending').length,
        pendingExcludedTimecards: row.pendingExcluded, openShifts: row.open, flags: [...row.flags].sort(),
        days: [...days.values()].map(day => ({ date: day.date, workedHours: hours(day.workedMs), dailyOvertimeHours: hours(day.dailyOvertimeMs), ptoHours: Math.round(day.ptoHours * 1000) / 1000, timecards: day.timecards })),
        timecards: row.cards.map(item => ({ id: item.card.id, workDate: item.workDate, clockInAt: new Date(item.start).toISOString(), clockOutAt: new Date(item.end).toISOString(), workedHours: hours(item.workedMs),
          paidRestHours: hours(item.restMs), unpaidBreakHours: hours(item.unpaidMs), dailyOvertimeHours: hours(daily.get(item) || 0), hourlyRate: payRate(item.card.hourlyRate), bonus: cents(payAmount(item.card.bonus)), tips: cents(payAmount(item.card.tips)),
          approvalStatus: item.state, jobId: String(item.card.jobId || '').slice(0, 180) })) });
    }
    employees.sort((a, b) => a.name.localeCompare(b.name) || a.employee.localeCompare(b.employee));
    const sum = key => employees.reduce((total, row) => total + row[key], 0);
    const totals = { employees: employees.length, ...Object.fromEntries(['workedHours', 'regularHours', 'overtimeHours', 'doubleTimeHours', 'ptoHours', 'totalPaidHours'].map(key => [key, Math.round(sum(key) * 1000) / 1000])),
      ...Object.fromEntries(['straightPay', 'overtimePremium', 'ptoPay', 'bonus', 'tips', 'grossPay'].map(key => [key, cents(sum(key))])) };
    const weekEnded = today > last, found = new Set(employees.flatMap(row => row.flags));
    if (!weekEnded) found.add('week_in_progress');
    if (week.needsReview.length) found.add('needs_review');
    if (unattributed.length) found.add('unattributed_records');
    if (week.excluded.open) found.add('open_shifts');
    if (week.excluded.pending) found.add('pending_timecards');
    const reasons = COVERAGE_REASONS.filter(reason => found.has(reason));
    results.set(first, { policy: { ...rules }, timeZone: TIMESHEET_TIME_ZONE, weekStart: first, weekEnd: last, dates, includePending: includePending === true, asOf: now,
      employees, totals, needsReview: week.needsReview, unattributed: unattributed.map(item => ({ ...item })), excluded: week.excluded, coverage: { complete: !reasons.length, weekEnded, asOf: now, reasons } });
  }
  return results;
}
