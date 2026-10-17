/* Sale timing rules: the 3-business-day right to cancel, the earliest job date and the deposit
   refund window. Business days exclude Sundays and federal holidays and include Saturdays.
   When a fixed-date holiday falls on a weekend, BOTH the actual date and the federally observed
   weekday are skipped, which can only lengthen the customer's cancellation window. */
import { addDays, validDate, weekday, zonedInstant, zonedDate } from './knock-time.js';

function nthWeekday(year, month, dow, n) {
  // month 1-12, dow 0=Sun..6=Sat, n=1..5 or -1 for last
  if (n > 0) {
    const first = `${year}-${String(month).padStart(2, '0')}-01`;
    const shift = (dow - weekday(first) + 7) % 7;
    return addDays(first, shift + (n - 1) * 7);
  }
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const last = addDays(next, -1);
  return addDays(last, -((weekday(last) - dow + 7) % 7));
}

function observed(date) {
  const dow = weekday(date);
  if (dow === 6) return addDays(date, -1);
  if (dow === 0) return addDays(date, 1);
  return null;
}

const fixed = (year, mmdd) => `${year}-${mmdd}`;

// Federal holidays (5 U.S.C. 6103) for a year: [{ date, name, observedFor? }].
export function federalHolidays(year) {
  const list = [
    { date: fixed(year, '01-01'), name: "New Year's Day", fixedDate: true },
    { date: nthWeekday(year, 1, 1, 3), name: 'Martin Luther King Jr. Day' },
    { date: nthWeekday(year, 2, 1, 3), name: "Washington's Birthday" },
    { date: nthWeekday(year, 5, 1, -1), name: 'Memorial Day' },
    { date: fixed(year, '06-19'), name: 'Juneteenth', fixedDate: true },
    { date: fixed(year, '07-04'), name: 'Independence Day', fixedDate: true },
    { date: nthWeekday(year, 9, 1, 1), name: 'Labor Day' },
    { date: nthWeekday(year, 10, 1, 2), name: 'Columbus Day' },
    { date: fixed(year, '11-11'), name: 'Veterans Day', fixedDate: true },
    { date: nthWeekday(year, 11, 4, 4), name: 'Thanksgiving Day' },
    { date: fixed(year, '12-25'), name: 'Christmas Day', fixedDate: true },
  ];
  const result = [];
  for (const holiday of list) {
    result.push({ date: holiday.date, name: holiday.name });
    const moved = holiday.fixedDate ? observed(holiday.date) : null;
    if (moved) result.push({ date: moved, name: `${holiday.name} (observed)` });
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

export function holidaySet(year, extraHolidays = []) {
  const dates = new Set();
  // New Year's Day on a Saturday is observed on Dec 31 of the prior year, so look one year ahead too.
  for (const y of [year - 1, year, year + 1]) for (const h of federalHolidays(y)) dates.add(h.date);
  for (const extra of extraHolidays || []) if (validDate(extra)) dates.add(extra);
  return dates;
}

export function isBusinessDay(date, extraHolidays = []) {
  if (!validDate(date)) return false;
  if (weekday(date) === 0) return false;
  return !holidaySet(Number(date.slice(0, 4)), extraHolidays).has(date);
}

/* The right to cancel ends at midnight at the end of the Nth business day after the sale date.
   Returns { deadlineDate, cancelEndsAt (ms, the instant the window closes), earliestJobDate, skipped }. */
export function cancellationWindow(saleDate, { businessDays = 3, extraHolidays = [], timeZone = 'America/Denver' } = {}) {
  if (!validDate(saleDate)) return null;
  let date = saleDate, counted = 0;
  const skipped = [];
  while (counted < businessDays) {
    date = addDays(date, 1);
    if (isBusinessDay(date, extraHolidays)) counted += 1;
    else skipped.push(date);
  }
  const earliestJobDate = addDays(date, 1);
  return {
    deadlineDate: date,
    cancelEndsAt: zonedInstant(earliestJobDate, '00:00', timeZone),
    earliestJobDate,
    skipped,
  };
}

export function saleDateOf(soldAt, timeZone = 'America/Denver') {
  return zonedDate(soldAt, timeZone);
}

export function jobDateAllowed(jobDate, saleDate, options = {}) {
  const window = cancellationWindow(saleDate, options);
  return Boolean(window && validDate(jobDate) && jobDate >= window.earliestJobDate);
}

/* Job start (owner rule, functions/_lib/job-start-policy.js): job work starts at 9:30 am or later in America/Denver
   for job dates on and after 2026-10-15, and the job day ends at 5:00 pm. The phone and the server read these copies
   (the browser cannot import functions/); tests/knock-sales.test.mjs checks they match the dispatch policy. */
export const JOB_START_POLICY_DATE = '2026-10-15';
export const JOB_START_MINIMUM = '09:30';
export const JOB_DAY_END = '17:00';

// The earliest start for a job on this date, or null when the date is before the policy.
export const jobStartFloor = jobDate => (validDate(jobDate) && jobDate >= JOB_START_POLICY_DATE ? JOB_START_MINIMUM : null);

export function jobStartAllowed(jobDate, time) {
  const floor = jobStartFloor(jobDate);
  return !floor || String(time || '') >= floor;
}

// The start a sale takes when the rep gave none: the settings default, never before the 9:30 floor.
export function defaultJobStart(settings, jobDate) {
  const stored = settings?.sale?.defaultJobStartTime || JOB_START_MINIMUM, floor = jobStartFloor(jobDate);
  return floor && stored < floor ? floor : stored;
}

/* KNOCK-BRIDGE: how long a door sale's crew job is booked for, by package (minutes). These are planning defaults the
   office adjusts in Dispatch; every one fits a 9:30 to 5:00 job day. Unknown packages take DEFAULT_JOB_MINUTES. */
export const PACKAGE_JOB_MINUTES = Object.freeze({ 'Quick Clear': 180, 'Garage Transformation': 360, 'The Works': 420, 'Full Property Reset': 450 });
export const DEFAULT_JOB_MINUTES = 360;
export const jobMinutes = pkg => PACKAGE_JOB_MINUTES[pkg] || DEFAULT_JOB_MINUTES;

// The offline choice when no slot list could load: morning or afternoon, and the start the server tries first.
export const DAY_PARTS = Object.freeze({ am: Object.freeze({ label: 'Morning', start: '09:30' }), pm: Object.freeze({ label: 'Afternoon', start: '13:00' }) });
export const dayPartOf = time => (String(time || '') < '12:00' ? 'am' : 'pm');

export function depositAmount(ticket, depositRate = 0.25) {
  const value = Number(ticket);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * depositRate * 100) / 100;
}

/* Deposit refund status at `now`:
   'full_cancel_right' - inside the legal cancellation window: fully refundable, no questions
   'refundable'        - after the window, until refundCutoffHours before the job start
   'non_refundable'    - inside the cutoff (EGC rule) */
export function depositRefundStatus({ cancelEndsAt, jobDate, jobStartTime = JOB_START_MINIMUM, refundCutoffHours = 24, timeZone = 'America/Denver' }, now = Date.now()) {
  if (now < cancelEndsAt) return { status: 'full_cancel_right', until: cancelEndsAt };
  const jobStart = validDate(jobDate) ? zonedInstant(jobDate, jobStartTime, timeZone) : null;
  if (jobStart == null) return { status: 'refundable', until: null };
  const cutoff = jobStart - refundCutoffHours * 3600000;
  return now < cutoff ? { status: 'refundable', until: cutoff } : { status: 'non_refundable', until: null };
}
