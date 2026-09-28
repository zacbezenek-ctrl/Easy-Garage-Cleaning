import { addDays, denverToday, validDate } from './dispatch-time.js';
import { localInstant } from './operations-portal-records.js';
import { funnelDefinitions } from './funnel-definitions.js';

// FUN-01 business calendar and Denver periods over funnelDefinitions().calendar.
// Pure: every function takes its instant; nothing here reads the clock except
// webLeadTiming's legacy default. Instants are ISO strings, Dates or epoch ms;
// dates are Denver 'YYYY-MM-DD'; ranges use an exclusive end. Denver midnight
// never falls in a DST transition (02:00), so period boundaries use
// localInstant; other wall times (business hours, in-progress truncation)
// follow the calendar's nonexistent/ambiguous rules via wallClockInstant.

const TIME_ZONE = 'America/Denver';
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WALL_TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const HOUR = 3600000, DAY = 86400000, MAX_SCAN_DAYS = 3700;
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const wallFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

/** Epoch ms for an ISO instant (Z or offset), Date or finite ms; null when invalid. */
export function instantMs(value) {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : typeof value === 'string' && ISO_INSTANT.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? ms : null;
}

function requireMs(value, label = 'time') {
  const ms = instantMs(value);
  if (ms === null) throw fail('funnel_calendar_invalid', `The ${label} must be a valid instant.`);
  return ms;
}

// Denver wall clock of an instant as UTC-style epoch ms (offsets are whole minutes, so ms carry over).
function wallMs(ms) {
  const parts = Object.fromEntries(wallFormat.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) + (((ms % 1000) + 1000) % 1000);
}

/** Denver calendar date of an instant. */
export const denverDate = at => denverToday(new Date(requireMs(at)));

/** The Monday on or before a Denver date (weeks are Monday–Sunday). */
export function denverWeekStart(date) {
  if (!validDate(date)) throw fail('funnel_calendar_invalid', 'Use a YYYY-MM-DD date.');
  return addDays(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));
}

/** The instant a Denver date begins (Denver midnight is never inside a DST change). */
export function denverDayStart(date) {
  const instant = validDate(date) ? localInstant(date, '00:00') : null;
  if (!instant) throw fail('funnel_calendar_invalid', 'Use a YYYY-MM-DD date.');
  return instant;
}

/**
 * Converts a Denver wall-clock date and time ('HH:MM', 'HH:MM:SS' or
 * 'HH:MM:SS.mmm') to an ISO instant. A time skipped by the spring change
 * resolves to the first instant after the gap; a repeated fall-back time
 * resolves to the earlier instant (calendar.periods rules).
 */
export function wallClockInstant(date, time) {
  const match = WALL_TIME.exec(String(time || ''));
  if (!validDate(date) || !match) throw fail('funnel_calendar_invalid', 'Use a YYYY-MM-DD date and an HH:MM time.');
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, Number(match[1]), Number(match[2]), Number(match[3] || 0), Number((match[4] || '0').padEnd(3, '0')));
  const candidates = [...new Set([wall + 6 * HOUR, wall + 7 * HOUR].map(guess => wall - (wallMs(guess) - guess)))].filter(ms => wallMs(ms) === wall).sort((a, b) => a - b);
  if (candidates.length) return new Date(candidates[0]).toISOString();
  // Spring-forward gap: the earliest instant whose wall clock is at or after the requested time.
  let low = wall + 5 * HOUR, high = wall + 8 * HOUR;
  while (high - low > 1) { const mid = Math.floor((low + high) / 2); if (wallMs(mid) >= wall) high = mid; else low = mid; }
  return new Date(high).toISOString();
}

const minutesOf = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5));

const holidayCache = new Map();
/** US federal holidays (calendar.holidays) for a year, observed on their actual date: [{date, id}]. */
export function holidaysForYear(year) {
  if (!Number.isInteger(year) || year < 1970 || year > 9999) throw fail('funnel_calendar_invalid', 'Choose a year from 1970.');
  if (holidayCache.has(year)) return holidayCache.get(year);
  const rules = funnelDefinitions().calendar.holidays.rules;
  const list = rules.map(rule => {
    const month = String(rule.month).padStart(2, '0');
    if (rule.day !== undefined) return { date: `${year}-${month}-${String(rule.day).padStart(2, '0')}`, id: rule.id };
    const target = DAY_NAMES.indexOf(rule.weekday);
    if (rule.nth > 0) {
      const first = new Date(Date.UTC(year, rule.month - 1, 1, 12)).getUTCDay();
      return { date: addDays(`${year}-${month}-01`, (target - first + 7) % 7 + (rule.nth - 1) * 7), id: rule.id };
    }
    const last = new Date(Date.UTC(year, rule.month, 0, 12)), lastDate = last.toISOString().slice(0, 10);
    return { date: addDays(lastDate, -((last.getUTCDay() - target + 7) % 7)), id: rule.id };
  }).filter(item => validDate(item.date)).sort((a, b) => a.date.localeCompare(b.date));
  const frozen = Object.freeze(list.map(item => Object.freeze(item)));
  holidayCache.set(year, frozen);
  return frozen;
}

/** The holiday id on a Denver date, or null. */
export function holidayOn(date) {
  if (!validDate(date)) throw fail('funnel_calendar_invalid', 'Use a YYYY-MM-DD date.');
  return holidaysForYear(Number(date.slice(0, 4))).find(item => item.date === date)?.id || null;
}

// Open business intervals of one Denver date as [startMs, endMs) pairs.
function openIntervals(date, holidays) {
  if (holidays && holidayOn(date)) return [];
  const day = DAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()];
  return funnelDefinitions().calendar.businessHours[day].map(([start, end]) => [Date.parse(wallClockInstant(date, start)), Date.parse(wallClockInstant(date, end))]);
}

/** Whether an instant is inside business hours (Mon–Sat 07:00–19:00 Denver by default), optionally ignoring holidays. */
export function isBusinessTime(at, { holidays = true } = {}) {
  const wall = new Date(wallMs(requireMs(at)));
  if (holidays && holidayOn(wall.toISOString().slice(0, 10))) return false;
  const minute = wall.getUTCHours() * 60 + wall.getUTCMinutes();
  return funnelDefinitions().calendar.businessHours[DAY_NAMES[wall.getUTCDay()]].some(([start, end]) => minute >= minutesOf(start) && minute < minutesOf(end));
}

/** Business minutes in [from, to): fractional when the instants carry seconds. 0 when to <= from. */
export function businessMinutesBetween(from, to, { holidays = true } = {}) {
  const start = requireMs(from, 'start'), end = requireMs(to, 'end');
  if (end <= start) return 0;
  if (end - start > MAX_SCAN_DAYS * DAY) throw fail('funnel_calendar_range_invalid', 'Business time can be measured over at most ten years.');
  let total = 0;
  for (let date = denverDate(start), last = denverDate(end); date <= last; date = addDays(date, 1)) {
    for (const [open, close] of openIntervals(date, holidays)) total += Math.max(0, Math.min(close, end) - Math.max(open, start));
  }
  return total / 60000;
}

/** The instant `minutes` business minutes after `at` (FUN-09 due times). A start outside hours waits for the next opening. */
export function addBusinessMinutes(at, minutes, { holidays = true } = {}) {
  const start = requireMs(at);
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) throw fail('funnel_calendar_invalid', 'Business minutes must be zero or more.');
  let remaining = minutes * 60000;
  for (let date = denverDate(start), days = 0; days <= MAX_SCAN_DAYS; date = addDays(date, 1), days += 1) {
    for (const [open, close] of openIntervals(date, holidays)) {
      const from = Math.max(open, start);
      if (from >= close) continue;
      if (from + remaining <= close) return new Date(from + remaining).toISOString();
      remaining -= close - from;
    }
  }
  throw fail('funnel_calendar_range_invalid', 'The business calendar has no opening in the next ten years.');
}

/**
 * The web-lead relay's `lead_timing`: 'in-hours' or 'out-of-hours' from the
 * shared business hours. Holidays are not applied (calendar.webLeadTiming), so
 * the Zap receives exactly the legacy value; any failure answers 'in-hours'.
 */
export function webLeadTiming(now = new Date()) {
  try {
    const rules = funnelDefinitions().calendar.webLeadTiming;
    return isBusinessTime(now, { holidays: rules.applyHolidays }) ? rules.inHours : rules.outOfHours;
  } catch { return 'in-hours'; }
}

const PERIOD_UNITS = { today: 'day', yesterday: 'day', wtd: 'week', last_week: 'week', mtd: 'month', last_month: 'month', qtd: 'quarter', last_quarter: 'quarter', ytd: 'year' };

function addMonths(date, months) {
  const [y, m] = date.split('-').map(Number), total = y * 12 + (m - 1) + months;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String(total % 12 + 1).padStart(2, '0')}-01`;
}

// Same month and day in another year; Feb 29 becomes Feb 28.
function shiftYears(date, years) {
  const y = Number(date.slice(0, 4)) + years, candidate = `${String(y).padStart(4, '0')}${date.slice(4)}`;
  return validDate(candidate) ? candidate : `${String(y).padStart(4, '0')}-02-28`;
}

function unitStart(unit, date) {
  if (unit === 'day') return date;
  if (unit === 'week') return denverWeekStart(date);
  if (unit === 'month') return `${date.slice(0, 7)}-01`;
  if (unit === 'quarter') return `${date.slice(0, 5)}${String(Math.floor((Number(date.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
  return `${date.slice(0, 4)}-01-01`;
}

function unitShift(unit, date, count) {
  if (unit === 'day') return addDays(date, count);
  if (unit === 'week') return addDays(date, count * 7);
  if (unit === 'month') return addMonths(date, count);
  if (unit === 'quarter') return addMonths(date, count * 3);
  return addMonths(date, count * 12);
}

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY);

function range(fields, asOfMs) {
  const startAt = denverDayStart(fields.from), endAt = denverDayStart(fields.to), start = Date.parse(startAt), end = Date.parse(endAt);
  return { ...fields, timeZone: TIME_ZONE, startAt, endAt, inProgress: asOfMs >= start && asOfMs < end, asOf: new Date(asOfMs).toISOString(), elapsedThrough: new Date(Math.min(Math.max(asOfMs, start), end)).toISOString() };
}

/**
 * A pulse period in Denver time: today, yesterday, wtd, last_week, mtd,
 * last_month, qtd, last_quarter, ytd, or custom {from, to} with an exclusive
 * `to` (at most calendar.periods.custom.maxDays). Returns {period, from, to,
 * timeZone, startAt, endAt, inProgress, asOf, elapsedThrough}; metrics count
 * [startAt, elapsedThrough), so an in-progress period stops at `now`.
 */
export function funnelPeriod(period, now, { from, to } = {}) {
  const asOf = requireMs(now, 'current time'), today = denverDate(asOf), rules = funnelDefinitions().calendar.periods;
  if (period === 'custom') {
    if (!validDate(from) || !validDate(to) || to <= from) throw fail('funnel_period_invalid', 'A custom period needs YYYY-MM-DD from and a later exclusive to date.');
    if (daysBetween(from, to) > rules.custom.maxDays) throw fail('funnel_period_invalid', `A custom period can cover at most ${rules.custom.maxDays} days.`);
    return range({ period, from, to }, asOf);
  }
  const unit = PERIOD_UNITS[period];
  if (!unit) throw fail('funnel_period_invalid', 'Choose today, yesterday, wtd, last_week, mtd, last_month, qtd, last_quarter, ytd or custom.');
  const current = unitStart(unit, today), start = rules.inProgress.includes(period) ? current : unitShift(unit, current, -1);
  return range({ period, from: start, to: unitShift(unit, start, 1) }, asOf);
}

/**
 * The comparison for a funnelPeriod() result: 'previous_period',
 * 'same_period_last_year' or 'none' (null). Last year follows
 * calendar.periods.sameLastYearAlignment: day and week periods move back
 * weekdayAlignedShiftDays (364, 52 weeks) so a Monday is compared with a Monday
 * and a Monday–Sunday week with one; month, quarter, year and custom periods
 * keep the calendar date (Feb 29 becomes Feb 28). When the period is in
 * progress the comparison is truncated to the same elapsed day and Denver
 * wall-clock time (a shorter prior period is compared whole), so "month to
 * date" is never compared with a full month.
 */
export function comparisonPeriod(current, compare) {
  if (compare === 'none') return null;
  if (!current || !validDate(current.from) || !validDate(current.to) || current.to <= current.from) throw fail('funnel_period_invalid', 'Compare a period returned by funnelPeriod().');
  const asOf = requireMs(current.asOf, 'period asOf');
  let from, to;
  if (compare === 'previous_period') {
    const unit = PERIOD_UNITS[current.period];
    if (unit) { from = unitShift(unit, current.from, -1); to = current.from; }
    else { from = addDays(current.from, -daysBetween(current.from, current.to)); to = current.from; }
  } else if (compare === 'same_period_last_year') {
    const rules = funnelDefinitions().calendar.periods, days = rules.weekdayAlignedShiftDays;
    if (rules.sameLastYearAlignment[PERIOD_UNITS[current.period] || 'custom'] === 'same_weekday') { from = addDays(current.from, -days); to = addDays(current.to, -days); }
    else { from = shiftYears(current.from, -1); to = shiftYears(current.to, -1); }
  } else throw fail('funnel_period_invalid', 'Compare with previous_period, same_period_last_year or none.');
  const startAt = denverDayStart(from), endAt = denverDayStart(to);
  let through = Date.parse(endAt), truncated = false;
  if (current.inProgress) {
    const today = denverDate(asOf), offset = daysBetween(current.from, today), day = addDays(from, offset);
    if (day < to) {
      const wall = new Date(wallMs(asOf)).toISOString().slice(11, 23);
      through = Math.min(Math.max(Date.parse(wallClockInstant(day, wall)), Date.parse(startAt)), Date.parse(endAt));
      truncated = true;
    }
  }
  return { period: current.period, compare, from, to, timeZone: TIME_ZONE, startAt, endAt, inProgress: false, truncated, asOf: current.asOf, elapsedThrough: new Date(through).toISOString() };
}
