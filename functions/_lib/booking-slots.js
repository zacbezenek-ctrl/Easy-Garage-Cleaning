import { addDays, denverToday, validDate } from './dispatch-time.js';
import { holidayOn } from './funnel-calendar.js';
import { funnelDefinitions } from './funnel-definitions.js';

/* SALES-BOOKING (BOOK-25): the walkthrough windows /book offers, from the Denver
   clock and the FUN-01 business calendar (business hours and holidays). A window
   is offered while its start is still ahead on a day the business is open for the
   whole window; a booking_slot is stored as an explicit 'YYYY-MM-DD AM|PM'. The public /book page and
   /api/web-lead use this only with EGC_BOOKING_EXPLICIT_SLOTS=true (booking-slots-flag.js).
   booking-slots.js (the /book page) mirrors bookingSlots() for the browser, and
   tests/booking-slots.test.mjs keeps the two and the calendar in step.
   Pure: every function takes its instant (ISO string, Date or epoch ms). */

export const BOOKING_WINDOWS = Object.freeze({
  AM: Object.freeze({ start: '08:00', end: '12:00', label: 'morning', time: '09:00', endTime: '10:00' }),
  PM: Object.freeze({ start: '12:00', end: '17:00', label: 'afternoon', time: '13:00', endTime: '14:00' }),
});
export const BOOKING_SLOT_COUNT = 4;
export const BOOKING_SLOT_SCAN_DAYS = 21;
export const BOOKING_SLOT_PATTERN = /^(\d{4}-\d{2}-\d{2}) (AM|PM)$/;
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const wall = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const minutes = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5));
const at = now => { const date = now instanceof Date ? now : new Date(now); if (!Number.isFinite(date.getTime())) throw Object.assign(new Error('The booking clock must be a valid instant.'), { code: 'booking_slot_clock_invalid', status: 400 }); return date; };
const wallMinutes = date => { const parts = Object.fromEntries(wall.formatToParts(date).map(part => [part.type, part.value])); return Number(parts.hour) * 60 + Number(parts.minute); };
const dayName = date => DAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()];

/** Whether the business is open on a Denver date for the whole window (business hours, no holiday). */
export function windowOpen(date, window) {
  const hours = funnelDefinitions().calendar.businessHours[dayName(date)] || [], spec = BOOKING_WINDOWS[window];
  return Boolean(spec) && !holidayOn(date) && hours.some(([start, end]) => minutes(start) <= minutes(spec.start) && minutes(spec.end) <= minutes(end));
}

/** 'Today afternoon', 'Tomorrow morning' or 'Wed, Sep 30 morning', relative to the Denver date `today`. */
export function bookingSlotLabel(date, window, today) {
  const day = date === today ? 'Today' : date === addDays(today, 1) ? 'Tomorrow' : new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${date}T12:00:00Z`));
  return `${day} ${BOOKING_WINDOWS[window].label}`;
}

/** The next `count` open windows after `now`: [{value, date, window, label}]. */
export function bookingSlots(now, { count = BOOKING_SLOT_COUNT } = {}) {
  const current = at(now), today = denverToday(current), minute = wallMinutes(current), out = [];
  for (let offset = 0; offset < BOOKING_SLOT_SCAN_DAYS && out.length < count; offset += 1) {
    const date = addDays(today, offset);
    for (const window of Object.keys(BOOKING_WINDOWS)) {
      if (out.length >= count) break;
      if (offset === 0 && minute >= minutes(BOOKING_WINDOWS[window].start)) continue;
      if (windowOpen(date, window)) out.push({ value: `${date} ${window}`, date, window, label: bookingSlotLabel(date, window, today) });
    }
  }
  return out;
}

/** {date, window} for an explicit 'YYYY-MM-DD AM|PM', else null. */
export function parseBookingSlot(value) {
  const match = BOOKING_SLOT_PATTERN.exec(String(value ?? '').trim());
  return match && validDate(match[1]) ? { date: match[1], window: match[2] } : null;
}

/**
 * Why a window cannot be booked as asked at `now`: 'started' once its start has
 * passed on the Denver clock (a page left open, or 'Today afternoon' sent at 9 PM),
 * 'closed' when the business calendar is closed for it, else ''.
 */
export function bookingSlotProblem(slot, now) {
  const current = at(now), today = denverToday(current);
  if (slot.date < today || slot.date === today && wallMinutes(current) >= minutes(BOOKING_WINDOWS[slot.window].start)) return 'started';
  return windowOpen(slot.date, slot.window) ? '' : 'closed';
}

/**
 * The booking_slot a lead stores, resolved at `now` (the moment the lead arrived):
 * an explicit 'YYYY-MM-DD AM|PM' is kept, the older relative choices ('Today PM',
 * 'Tomorrow AM', 'Tomorrow PM') become that explicit date, and anything else
 * ('This week', 'Flexible', '') is kept as the customer's words. Returns
 * {slot, choice, problem}: choice is the customer's original words when they differ,
 * problem is bookingSlotProblem() for a dated window (kept as sent, and flagged).
 */
export function normalizeBookingSlot(value, now) {
  const text = String(value ?? '').trim().slice(0, 80), explicit = parseBookingSlot(text);
  if (explicit) return { slot: `${explicit.date} ${explicit.window}`, choice: '', problem: bookingSlotProblem(explicit, now) };
  const relative = /^(today|tomorrow)\s*(am|pm)$/i.exec(text);
  if (!relative) return { slot: text, choice: '', problem: '' };
  const date = addDays(denverToday(at(now)), relative[1].toLowerCase() === 'today' ? 0 : 1), window = relative[2].toUpperCase();
  return { slot: `${date} ${window}`, choice: text, problem: bookingSlotProblem({ date, window }, now) };
}

/**
 * The lead fields with booking_slot resolved at `now`; booking_slot_choice keeps the customer's words when they
 * changed, and booking_slot_problem ('started' or 'closed') flags a window that could not be booked as asked.
 */
export function bookingSlotLead(flat, now) {
  if (!flat?.booking_slot) return flat;
  const { slot, choice, problem } = normalizeBookingSlot(flat.booking_slot, now);
  return { ...flat, booking_slot: slot, ...(choice ? { booking_slot_choice: choice } : {}), ...(problem ? { booking_slot_problem: problem } : {}) };
}

/** The note's words for a booking_slot_problem. */
export const BOOKING_SLOT_PROBLEMS = Object.freeze({ started: 'sent after this window had started', closed: 'EGC is closed then' });

/**
 * An explicit window in the customer's words for the automatic text-back relay: 'Tomorrow morning',
 * 'Thu, Oct 1 afternoon', relative to the Denver date at `now`. '' when the value is not an explicit window.
 */
export function bookingSlotWords(value, now) {
  const slot = parseBookingSlot(value);
  return slot ? bookingSlotLabel(slot.date, slot.window, denverToday(at(now))) : '';
}

const LEAD_NOTE = /^EGC WEBSITE LEAD DETAILS\b/;
const line = (body, label) => { const found = new RegExp(`^${label}: (.*)$`, 'm').exec(body)?.[1]?.trim() || ''; return found === '—' ? '' : found; };
const noteTime = note => { const ms = Date.parse(note?.dateAdded || note?.createdAt || ''); return Number.isFinite(ms) ? ms : null; };

/**
 * What the newest website-lead detail note (web-lead-intake.js syncHighLevelDetails)
 * says, for the Hub's Book walkthrough: {service, location, email, requestedSlot,
 * requestedSlotText}. requestedSlot is {date, window} (with closed:true on a day or
 * window the business calendar is closed) or null; a legacy relative slot resolves
 * against the time the note was written. null when no note is one.
 */
export function leadDetailsFromNotes(notes) {
  const rows = (Array.isArray(notes) ? notes : []).filter(note => typeof note?.body === 'string' && LEAD_NOTE.test(note.body));
  if (!rows.length) return null;
  const note = rows.slice().sort((left, right) => (noteTime(right) ?? -Infinity) - (noteTime(left) ?? -Infinity))[0], body = note.body;
  const text = line(body, 'Requested slot').replace(/\s*\([^()]*\)$/, '');
  const written = noteTime(note), resolved = written === null ? parseBookingSlot(text) : parseBookingSlot(normalizeBookingSlot(text, written).slot);
  const requestedSlot = resolved && !windowOpen(resolved.date, resolved.window) ? { ...resolved, closed: true } : resolved;
  return { service: line(body, 'Service'), location: line(body, 'Location'), email: line(body, 'Email'), requestedSlot, requestedSlotText: text };
}
