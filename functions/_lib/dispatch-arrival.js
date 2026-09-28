import { localInstant } from './operations-portal-records.js';
import { DISPATCH_TIME_ZONE } from './dispatch-contract.js';

/** Customer arrival windows for scheduled Hub visits.
 * arrivalWindowStart/arrivalWindowEnd are optional Denver wall-clock HH:MM values
 * on the job's start date; null means "no explicit window". When
 * settings.defaultArrivalWindowEnabled is true, such jobs get a default window
 * from the start time for settings.defaultArrivalWindowMinutes (60). The saved
 * `arrivalWindow` label ('9:00 AM – 10:00 AM') is what crew and customer
 * surfaces display; null keeps their previous (legacy) text.
 *
 * The derived default label is MATERIALIZED when a job is saved (dispatch or the
 * operations bridge); readers never compute it. Enabling the setting therefore
 * affects jobs as they are next saved, and disabling it does not remove labels
 * already saved. scripts/backfill-arrival-windows.mjs previews (and, with
 * --apply, writes) the derived label for future scheduled jobs that lack one.
 */
export const DEFAULT_ARRIVAL_WINDOW_MINUTES = 60;
export const ARRIVAL_KEYS = Object.freeze(['arrivalWindowStart','arrivalWindowEnd']);
const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const minute = value => Number(value.slice(0,2)) * 60 + Number(value.slice(3));

export function arrivalWindowMinutes(settings) {
  const value = Number(settings?.defaultArrivalWindowMinutes);
  return Number.isInteger(value) && value >= 15 && value <= 480 ? value : DEFAULT_ARRIVAL_WINDOW_MINUTES;
}

// Until dispatch settings have their own record, they come from env. Derived
// windows change what customers see, so they stay off unless enabled.
export function arrivalSettings(env = {}) {
  const raw = String(env.EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_MINUTES ?? '').trim();
  return { defaultArrivalWindowEnabled: String(env.EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_ENABLED ?? '').trim().toLowerCase() === 'true',
    defaultArrivalWindowMinutes: arrivalWindowMinutes({ defaultArrivalWindowMinutes: /^\d+$/.test(raw) ? Number(raw) : undefined }) };
}

export function arrivalClock(value) {
  if (typeof value !== 'string' || !HHMM.test(value)) return '';
  const hour = Number(value.slice(0,2));
  return `${hour % 12 || 12}:${value.slice(3)} ${hour < 12 ? 'AM' : 'PM'}`;
}

export function formatArrivalWindow(start, end) {
  const from = arrivalClock(start), to = arrivalClock(end);
  return from && to ? `${from} – ${to}` : '';
}

function denverWallClock(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: DISPATCH_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

// Elapsed minutes, not wall-clock arithmetic, so DST days get the real duration.
export function defaultArrivalWindow(date, time, minutes = DEFAULT_ARRIVAL_WINDOW_MINUTES) {
  const startAt = localInstant(date, time);
  if (!startAt) return null;
  const end = denverWallClock(Date.parse(startAt) + arrivalWindowMinutes({ defaultArrivalWindowMinutes: minutes }) * 60000);
  const endTime = end.date === date ? end.time : '23:59';
  // Clamping a late start (e.g. 23:59) to the day's end would give a zero-length
  // range; no window is better than a customer-facing '11:59 PM – 11:59 PM'.
  return minute(endTime) > minute(time) ? { start: time, end: endTime } : null;
}

/** The non-secret part of the settings that dispatch UIs need for help text. */
export function arrivalDefaults(settings) {
  return { enabled: settings?.defaultArrivalWindowEnabled === true, minutes: arrivalWindowMinutes(settings) };
}

/** '' when the job's explicit window is absent or valid for its saved start. */
export function arrivalWindowProblem(job) {
  const start = job?.arrivalWindowStart ?? null, end = job?.arrivalWindowEnd ?? null;
  if (start === null && end === null) return '';
  if (start === null || end === null) return 'Enter both arrival window times, or clear both.';
  if (typeof start !== 'string' || typeof end !== 'string' || !HHMM.test(start) || !HHMM.test(end)) return 'Arrival window times must use HH:MM.';
  if (!localInstant(job.date, job.time)) return 'Schedule a valid start time before setting an arrival window.';
  if (minute(start) >= minute(end)) return 'The arrival window must end after it starts.';
  if (minute(start) > minute(job.time) || minute(job.time) > minute(end)) return 'The arrival window must include the scheduled start time.';
  if (!localInstant(job.date, start) || !localInstant(job.date, end)) return 'Arrival window times must occur exactly once in Mountain Time on the job date. Adjust them around the daylight-saving change.';
  return '';
}

/** Stored arrival fields implied by a job's schedule. Missing or invalid times
 * clear the window rather than showing a customer a stale range. */
export function arrivalWindowFields(job, settings) {
  const scheduled = Boolean(localInstant(job?.date, job?.time));
  if (!scheduled) return { arrivalWindowStart: null, arrivalWindowEnd: null, arrivalWindow: null };
  if (job.arrivalWindowStart && job.arrivalWindowEnd && !arrivalWindowProblem(job)) return { arrivalWindowStart: job.arrivalWindowStart, arrivalWindowEnd: job.arrivalWindowEnd, arrivalWindow: formatArrivalWindow(job.arrivalWindowStart, job.arrivalWindowEnd) };
  const fallback = settings?.defaultArrivalWindowEnabled === true ? defaultArrivalWindow(job.date, job.time, arrivalWindowMinutes(settings)) : null;
  return { arrivalWindowStart: null, arrivalWindowEnd: null, arrivalWindow: fallback ? formatArrivalWindow(fallback.start, fallback.end) : null };
}

function arrivalInput(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !HHMM.test(value)) throw fail('dispatch_arrival_window_invalid', 'Arrival window times must use HH:MM, or be empty.');
  return value;
}

/** Dispatch patch for a saved schedule. Submitted windows must be valid. A saved
 * window that no longer contains a changed start time is cleared (the default,
 * if enabled, applies) and reported, so customers never see a stale range. */
export function arrivalWindowPatch(current, next, changes, settings) {
  const candidate = { ...next }, submitted = ARRIVAL_KEYS.filter(key => key in changes);
  for (const key of submitted) candidate[key] = arrivalInput(changes[key]);
  const problem = arrivalWindowProblem(candidate);
  if (problem && submitted.length) throw fail('dispatch_arrival_window_invalid', problem);
  if (problem) Object.assign(candidate, { arrivalWindowStart: null, arrivalWindowEnd: null });
  const fields = arrivalWindowFields(candidate, settings);
  return { patch: Object.fromEntries(Object.entries(fields).filter(([key, value]) => (current?.[key] ?? null) !== value)), reset: Boolean(problem) && Boolean(localInstant(next.date, next.time)) };
}
