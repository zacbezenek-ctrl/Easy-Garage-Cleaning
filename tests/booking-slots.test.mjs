import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { BOOKING_WINDOWS, bookingSlotProblem, bookingSlots, bookingSlotLead, bookingSlotWords, leadDetailsFromNotes, normalizeBookingSlot, parseBookingSlot } from '../functions/_lib/booking-slots.js';
import { funnelDefinitions } from '../functions/_lib/funnel-definitions.js';
import { BOOKING_SLOTS_MARKER, bookingExplicitSlotsEnabled } from '../functions/_lib/booking-slots-flag.js';
import { onRequest as middleware } from '../functions/_middleware.js';
import { createDocument } from './helpers/hub-dom.mjs';

// SALES-BOOKING (BOOK-25): /book's walkthrough windows come from the Denver clock, never the device's zone, and a lead
// stores the window it chose as an explicit 'YYYY-MM-DD AM|PM'. Every instant here is injected; nothing reads the clock.
const values = at => bookingSlots(at).map(slot => slot.value);
const labels = at => bookingSlots(at).map(slot => slot.label);
const source = readFileSync(new URL('../booking-slots.js', import.meta.url), 'utf8');
// The page script runs in its own realm with an injected clock (Date.now and new Date() read clock.now), and window
// events ('pageshow') go to `events`.
function browser(document, { clock = { now: Date.parse('2026-09-30T02:55:00.000Z') }, events = {} } = {}) {
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return clock.now; } }
  const context = { Intl, Date: Clock, Number, Object, String, Math, JSON, Array, addEventListener: (name, listener) => { (events[name] ||= []).push(listener); } };
  if (document) context.document = document;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'booking-slots.js' });
  return context.EGCBookingSlots;
}

test('at 20:55 in Denver the evening windows are gone and the next open morning comes first', () => {
  // Tuesday 2026-09-29 20:55 MDT (UTC-6).
  const at = '2026-09-30T02:55:00.000Z';
  assert.deepEqual(values(at), ['2026-09-30 AM', '2026-09-30 PM', '2026-10-01 AM', '2026-10-01 PM']);
  assert.deepEqual(labels(at), ['Tomorrow morning', 'Tomorrow afternoon', 'Thu, Oct 1 morning', 'Thu, Oct 1 afternoon']);
  assert.ok(labels(at).every(label => !label.startsWith('Today')), 'no "Today afternoon" at 9 PM');
  // The same instant read as UTC would be Wednesday 02:55: the Denver date is what counts.
  assert.equal(bookingSlots(at)[0].date, '2026-09-30');
});

test('a window is offered only while its start is ahead, by Denver wall time', () => {
  assert.deepEqual(values('2026-09-29T13:59:00.000Z').slice(0, 2), ['2026-09-29 AM', '2026-09-29 PM'], '07:59 MDT keeps this morning');
  assert.deepEqual(values('2026-09-29T14:00:00.000Z').slice(0, 1), ['2026-09-29 PM'], '08:00 MDT: the morning has started');
  assert.deepEqual(labels('2026-09-29T17:59:00.000Z').slice(0, 2), ['Today afternoon', 'Tomorrow morning'], '11:59 MDT');
  assert.deepEqual(values('2026-09-29T18:00:00.000Z').slice(0, 1), ['2026-09-30 AM'], 'noon: the afternoon has started');
});

test('Sunday is closed: a Sunday or a Saturday night offers Monday first', () => {
  // Sunday 2026-09-27 10:00 MDT.
  assert.deepEqual(values('2026-09-27T16:00:00.000Z'), ['2026-09-28 AM', '2026-09-28 PM', '2026-09-29 AM', '2026-09-29 PM']);
  assert.deepEqual(labels('2026-09-27T16:00:00.000Z').slice(0, 2), ['Tomorrow morning', 'Tomorrow afternoon']);
  // Saturday 2026-09-26 20:55 MDT skips Sunday entirely.
  assert.deepEqual(values('2026-09-27T02:55:00.000Z').slice(0, 2), ['2026-09-28 AM', '2026-09-28 PM']);
  assert.deepEqual(labels('2026-09-27T02:55:00.000Z').slice(0, 1), ['Mon, Sep 28 morning']);
  for (const at of ['2026-09-26T15:00:00.000Z', '2026-09-27T16:00:00.000Z', '2026-10-03T20:00:00.000Z'])
    assert.ok(bookingSlots(at, { count: 12 }).every(slot => new Date(`${slot.date}T12:00:00Z`).getUTCDay() !== 0), at);
});

test('the fall-back day (Sunday 2026-11-01) resolves both 01:30s to Denver dates, and Monday counts from wall time', () => {
  // 01:30 MDT (first) and 01:30 MST (repeated): both are Sunday, closed, so Monday is "tomorrow".
  for (const at of ['2026-11-01T07:30:00.000Z', '2026-11-01T08:30:00.000Z']) {
    assert.deepEqual(values(at), ['2026-11-02 AM', '2026-11-02 PM', '2026-11-03 AM', '2026-11-03 PM'], at);
    assert.deepEqual(labels(at).slice(0, 2), ['Tomorrow morning', 'Tomorrow afternoon'], at);
  }
  // Saturday 2026-10-31 20:55 MDT: Sunday is skipped by calendar date, not by adding 24 hours across the change.
  assert.deepEqual(values('2026-11-01T02:55:00.000Z').slice(0, 1), ['2026-11-02 AM']);
  assert.deepEqual(labels('2026-11-01T02:55:00.000Z').slice(0, 1), ['Mon, Nov 2 morning']);
  // Monday 2026-11-02 is on MST (UTC-7): 07:59 MST keeps the morning, 12:00 MST drops the afternoon.
  assert.deepEqual(values('2026-11-02T14:59:00.000Z').slice(0, 1), ['2026-11-02 AM']);
  assert.deepEqual(values('2026-11-02T19:00:00.000Z').slice(0, 1), ['2026-11-03 AM']);
  // 20:55 MST on Monday.
  assert.deepEqual(labels('2026-11-03T03:55:00.000Z').slice(0, 1), ['Tomorrow morning']);
});

test('business-calendar holidays are closed days', () => {
  // Wednesday before Thanksgiving (2026-11-26) at 20:55 MST: Friday comes next.
  assert.deepEqual(values('2026-11-26T03:55:00.000Z').slice(0, 2), ['2026-11-27 AM', '2026-11-27 PM']);
  // New Year's Eve evening skips New Year's Day, across the year boundary.
  assert.deepEqual(values('2027-01-01T03:55:00.000Z').slice(0, 1), ['2027-01-02 AM']);
  assert.throws(() => bookingSlots('not a time'), { code: 'booking_slot_clock_invalid' });
});

test('a lead stores its window as an explicit date resolved when it arrived; other words are kept', () => {
  const tuesdayNight = '2026-09-30T02:55:00.000Z';
  assert.deepEqual(normalizeBookingSlot('Tomorrow AM', tuesdayNight), { slot: '2026-09-30 AM', choice: 'Tomorrow AM', problem: '' });
  // 'Today afternoon' sent at 20:55 (a form page without booking-slots.js) resolves to today and is flagged.
  assert.deepEqual(normalizeBookingSlot('Today PM', tuesdayNight), { slot: '2026-09-29 PM', choice: 'Today PM', problem: 'started' });
  assert.deepEqual(normalizeBookingSlot(' tomorrow pm ', tuesdayNight), { slot: '2026-09-30 PM', choice: 'tomorrow pm', problem: '' });
  assert.deepEqual(normalizeBookingSlot('2026-10-01 AM', tuesdayNight), { slot: '2026-10-01 AM', choice: '', problem: '' });
  for (const kept of ['This week', 'Flexible', '', '2026-02-30 AM', '2026-10-01 EVENING']) assert.deepEqual(normalizeBookingSlot(kept, tuesdayNight), { slot: kept, choice: '', problem: '' });
  assert.equal(parseBookingSlot('2026-02-30 AM'), null);
  assert.deepEqual(parseBookingSlot('2026-10-01 PM'), { date: '2026-10-01', window: 'PM' });
  // Across the fall-back night the calendar date decides "tomorrow".
  assert.equal(normalizeBookingSlot('Tomorrow AM', '2026-11-01T08:30:00.000Z').slot, '2026-11-02 AM');
  const flat = { name: 'Synthetic Lead', booking_slot: 'Tomorrow PM' };
  assert.deepEqual(bookingSlotLead(flat, tuesdayNight), { name: 'Synthetic Lead', booking_slot: '2026-09-30 PM', booking_slot_choice: 'Tomorrow PM' });
  assert.equal(bookingSlotLead({ name: 'x' }, tuesdayNight).booking_slot, undefined);
  assert.deepEqual(bookingSlotLead({ booking_slot: '2026-10-01 AM' }, tuesdayNight), { booking_slot: '2026-10-01 AM' });
  assert.deepEqual(bookingSlotLead({ booking_slot: '2026-10-04 PM' }, tuesdayNight), { booking_slot: '2026-10-04 PM', booking_slot_problem: 'closed' }, 'a Sunday is kept as sent and flagged');
});

test('an explicit window that has started, or that the business calendar closes, is flagged by the Denver clock', () => {
  const window = (date, window) => ({ date, window });
  // Tuesday 2026-09-29: 07:59 MDT keeps this morning; 08:00 starts it; noon starts the afternoon.
  assert.equal(bookingSlotProblem(window('2026-09-29', 'AM'), '2026-09-29T13:59:00.000Z'), '');
  assert.equal(bookingSlotProblem(window('2026-09-29', 'AM'), '2026-09-29T14:00:00.000Z'), 'started');
  assert.equal(bookingSlotProblem(window('2026-09-29', 'PM'), '2026-09-29T17:59:00.000Z'), '');
  assert.equal(bookingSlotProblem(window('2026-09-29', 'PM'), '2026-09-29T18:00:00.000Z'), 'started');
  // Read as UTC, 20:55 MDT on Tuesday is already Wednesday: the Denver date keeps Wednesday ahead.
  assert.equal(bookingSlotProblem(window('2026-09-30', 'AM'), '2026-09-30T02:55:00.000Z'), '');
  assert.equal(bookingSlotProblem(window('2026-09-28', 'PM'), '2026-09-30T02:55:00.000Z'), 'started');
  // A Sunday and Thanksgiving are closed.
  assert.equal(bookingSlotProblem(window('2026-10-04', 'AM'), '2026-09-30T02:55:00.000Z'), 'closed');
  assert.equal(bookingSlotProblem(window('2026-11-26', 'PM'), '2026-09-30T02:55:00.000Z'), 'closed');
});

test('the text-back relay gets an explicit window in words, relative to the Denver date it arrives', () => {
  const tuesdayNight = '2026-09-30T02:55:00.000Z';
  assert.equal(bookingSlotWords('2026-09-30 AM', tuesdayNight), 'Tomorrow morning');
  assert.equal(bookingSlotWords('2026-10-01 PM', tuesdayNight), 'Thu, Oct 1 afternoon');
  assert.equal(bookingSlotWords('2026-09-29 PM', tuesdayNight), 'Today afternoon');
  for (const other of ['Tomorrow AM', 'Flexible', 'This week', '', '2026-02-30 AM', undefined]) assert.equal(bookingSlotWords(other, tuesdayNight), '', String(other));
});

test('the Hub reads the requested window from the newest website-lead note, resolving an older relative one against the note time', () => {
  const note = (body, dateAdded) => ({ id: dateAdded, body, dateAdded });
  const detail = slot => `EGC WEBSITE LEAD DETAILS\nService: Garage Cleanout\nJob size: Medium garage\nEmail: synthetic.lead@example.invalid\nLocation: Fort Collins 80525\nRequested slot: ${slot}\nForm path: walkthrough`;
  assert.deepEqual(leadDetailsFromNotes([note('Called, left a voicemail.', '2026-09-30T16:00:00.000Z'), note(detail('2026-10-01 AM (chosen as "Tomorrow AM")'), '2026-09-30T02:55:10.000Z'), note(detail('2026-09-20 PM'), '2026-09-19T15:00:00.000Z')]),
    { service: 'Garage Cleanout', location: 'Fort Collins 80525', email: 'synthetic.lead@example.invalid', requestedSlot: { date: '2026-10-01', window: 'AM' }, requestedSlotText: '2026-10-01 AM' });
  // A note written before explicit dates: 'Tomorrow AM' written Tuesday 20:55 Denver means Wednesday.
  assert.deepEqual(leadDetailsFromNotes([note(detail('Tomorrow AM'), '2026-09-30T02:55:10.000Z')]).requestedSlot, { date: '2026-09-30', window: 'AM' });
  assert.deepEqual(leadDetailsFromNotes([note(detail('This week'), '2026-09-30T02:55:10.000Z')]), { service: 'Garage Cleanout', location: 'Fort Collins 80525', email: 'synthetic.lead@example.invalid', requestedSlot: null, requestedSlotText: 'This week' });
  assert.equal(leadDetailsFromNotes([note(detail('—'), '2026-09-30T02:55:10.000Z')]).requestedSlotText, '');
  // The note's remarks (the customer's words, a started or closed window) are left off, and a closed window says so.
  assert.deepEqual(leadDetailsFromNotes([note(detail('2026-09-29 PM (chosen as "Today PM"; sent after this window had started)'), '2026-09-30T02:55:10.000Z')]).requestedSlot, { date: '2026-09-29', window: 'PM' });
  const sunday = leadDetailsFromNotes([note(detail('2026-10-04 AM (EGC is closed then)'), '2026-09-30T02:55:10.000Z')]);
  assert.deepEqual([sunday.requestedSlot, sunday.requestedSlotText], [{ date: '2026-10-04', window: 'AM', closed: true }, '2026-10-04 AM']);
  assert.equal(leadDetailsFromNotes([note('Called, left a voicemail.', '2026-09-30T16:00:00.000Z')]), null);
  assert.equal(leadDetailsFromNotes(null), null);
});

test('booking-slots.js (the /book page) computes the same windows as the server over DST changes, holidays and every hour', () => {
  const page = browser();
  const starts = ['2026-03-06T00:00:00.000Z', '2026-09-26T00:00:00.000Z', '2026-10-29T00:00:00.000Z', '2026-11-24T00:00:00.000Z', '2026-12-29T00:00:00.000Z'];
  let checked = 0;
  for (const start of starts) for (let minutes = 0; minutes < 6 * 24 * 60; minutes += 37) {
    const at = Date.parse(start) + minutes * 60000;
    assert.deepEqual(JSON.parse(JSON.stringify(page.slots(at))), bookingSlots(at), new Date(at).toISOString());
    checked++;
  }
  assert.ok(checked > 1000);
  assert.deepEqual(JSON.parse(JSON.stringify(page.slots(NaN))), []);
});

test('the page keeps a copy of the business calendar and the windows that must match the server', () => {
  const page = browser(), calendar = funnelDefinitions().calendar;
  assert.deepEqual(JSON.parse(JSON.stringify(page.CALENDAR.businessHours)), calendar.businessHours);
  assert.deepEqual(JSON.parse(JSON.stringify(page.CALENDAR.holidays)), calendar.holidays.rules);
  for (const window of ['AM', 'PM']) assert.deepEqual({ ...page.WINDOWS[window] }, { start: BOOKING_WINDOWS[window].start, end: BOOKING_WINDOWS[window].end, label: BOOKING_WINDOWS[window].label });
});

// The /book fieldset as served; marked is what the root middleware adds with EGC_BOOKING_EXPLICIT_SLOTS=true.
function bookPage(clock, events, { marked = true, document = createDocument() } = {}) {
  document.readyState = 'complete';
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'booking-slots';
  if (marked) fieldset.setAttribute(BOOKING_SLOTS_MARKER, '');
  fieldset.innerHTML = '<legend class="sr-only">Walkthrough time options</legend><label class="booking-slot"><input type="radio" name="booking_slot_choice" value="Today PM"> Today afternoon</label><label class="booking-slot"><input type="radio" name="booking_slot_choice" value="Flexible"> Flexible</label>';
  document.body.append(fieldset);
  const page = browser(document, { clock, events });
  const shown = () => fieldset.querySelectorAll('.booking-slot').map(label => [label.querySelector('input').value, label.textContent.trim(), label.querySelector('input').checked]);
  return { document, fieldset, page, shown };
}

test('flag on (marked): the page replaces the static choices with explicit windows plus Flexible from the Denver clock as it loads, keeping the legend', () => {
  // Loading at Tuesday 20:55 in Denver (the injected clock) renders at once.
  const { fieldset, page, shown } = bookPage({ now: Date.parse('2026-09-30T02:55:00.000Z') });
  assert.deepEqual(shown(), [['2026-09-30 AM', 'Tomorrow morning', false], ['2026-09-30 PM', 'Tomorrow afternoon', false], ['2026-10-01 AM', 'Thu, Oct 1 morning', false], ['2026-10-01 PM', 'Thu, Oct 1 afternoon', false], ['Flexible', 'Flexible', false]]);
  const choices = fieldset.querySelectorAll('.booking-slot');
  assert.deepEqual(choices.map(label => [label.querySelector('input').getAttribute('type'), label.querySelector('input').getAttribute('name')]), Array(5).fill(['radio', 'booking_slot_choice']));
  assert.equal(fieldset.querySelector('legend').textContent, 'Walkthrough time options');
  assert.equal(fieldset.hasAttribute('data-slots-rendered'), true);
  assert.deepEqual([...page.render(fieldset, Date.parse('2026-09-29T13:59:00.000Z'))], ['2026-09-29 AM', '2026-09-29 PM', '2026-09-30 AM', '2026-09-30 PM', 'Flexible'], 'render takes its instant');
});

test('flag on (marked): a page shown again later re-renders changed windows and keeps a choice that is still offered', () => {
  const clock = { now: Date.parse('2026-09-30T02:55:00.000Z') }, events = {}, { document, fieldset, shown } = bookPage(clock, events);
  const pageshow = persisted => { for (const listener of events.pageshow || []) listener({ type: 'pageshow', persisted }); };
  const visible = state => { document.visibilityState = state; document.dispatch({ type: 'visibilitychange' }); };
  fieldset.querySelectorAll('input').find(input => input.value === '2026-10-01 AM').checked = true;
  // Back to the tab on Wednesday 07:00 in Denver: the same windows, but "Tomorrow" is now "Today"; the choice stays.
  clock.now = Date.parse('2026-09-30T13:00:00.000Z');
  visible('hidden');
  assert.equal(shown()[0][1], 'Tomorrow morning', 'a hidden page is left alone');
  visible('visible');
  assert.deepEqual(shown(), [['2026-09-30 AM', 'Today morning', false], ['2026-09-30 PM', 'Today afternoon', false], ['2026-10-01 AM', 'Tomorrow morning', true], ['2026-10-01 PM', 'Tomorrow afternoon', false], ['Flexible', 'Flexible', false]]);
  // Nothing changed: the choices are not rebuilt.
  const before = fieldset.querySelectorAll('.booking-slot');
  visible('visible');
  assert.ok(fieldset.querySelectorAll('.booking-slot').every((label, index) => label === before[index]));
  // Thursday 09:00: the chosen morning has started. A normal load's pageshow is ignored; a page restored from the
  // back-forward cache drops the started window and the choice with it.
  clock.now = Date.parse('2026-10-01T15:00:00.000Z');
  pageshow(false);
  assert.equal(shown()[0][0], '2026-09-30 AM');
  pageshow(true);
  assert.deepEqual(shown(), [['2026-10-01 PM', 'Today afternoon', false], ['2026-10-02 AM', 'Tomorrow morning', false], ['2026-10-02 PM', 'Tomorrow afternoon', false], ['2026-10-03 AM', 'Sat, Oct 3 morning', false], ['Flexible', 'Flexible', false]]);
});

test('/book loads booking-slots.js by its content hash before site-forms.js binds the choices, and keeps the no-script choices', () => {
  const book = readFileSync(new URL('../book.html', import.meta.url), 'utf8'), headers = readFileSync(new URL('../_headers', import.meta.url), 'utf8');
  const version = createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex').slice(0, 12);
  const slots = book.indexOf(`<script src="/booking-slots.js?v=${version}" defer></script>`), forms = book.indexOf('<script src="/site-forms.js?v=');
  assert.ok(slots > 0, 'book.html loads the current booking-slots.js (rebuild with the recorded EGC_SITE_BUILD_DATE)');
  assert.ok(slots < forms, 'the windows render before site-forms.js attaches its change listeners');
  assert.equal(book.match(/booking-slots\.js/g).length, 1);
  assert.match(book, /<input type="radio" name="booking_slot_choice" value="Tomorrow AM"> Tomorrow morning/, 'without JavaScript (or with the flag off) the static choices stay; with the flag on web-lead resolves them to dates');
  assert.match(headers, /^\/booking-slots\.js\n {2}Cache-Control: public, max-age=31536000, immutable$/m);
});

// EGC_BOOKING_EXPLICIT_SLOTS: the root middleware decides, the page only renders when told.
const STATIC = [['Today PM', 'Today afternoon', false], ['Flexible', 'Flexible', false]];

test('flag off (unmarked): the page never touches the static choices, on load, when shown again or from the back-forward cache', () => {
  const clock = { now: Date.parse('2026-09-30T02:55:00.000Z') }, events = {}, { document, fieldset, page, shown } = bookPage(clock, events, { marked: false });
  const before = fieldset.querySelectorAll('.booking-slot');
  assert.deepEqual(shown(), STATIC, 'the static choices at Tuesday 20:55 in Denver, "Today afternoon" included, exactly as before');
  assert.equal(fieldset.hasAttribute('data-slots-rendered'), false);
  fieldset.querySelectorAll('input').find(input => input.value === 'Today PM').checked = true;
  clock.now = Date.parse('2026-10-01T15:00:00.000Z');
  document.visibilityState = 'visible'; document.dispatch({ type: 'visibilitychange' });
  for (const listener of events.pageshow || []) listener({ type: 'pageshow', persisted: true });
  page.refresh(clock.now);
  assert.deepEqual(shown(), [['Today PM', 'Today afternoon', true], ['Flexible', 'Flexible', false]]);
  assert.ok(fieldset.querySelectorAll('.booking-slot').every((label, index) => label === before[index]), 'the same nodes: nothing was rebuilt');
  assert.equal(fieldset.hasAttribute('data-slots-rendered'), false);
});

test('flag on (marked): a failure while rendering leaves the static choices (fails closed)', () => {
  // The served choices are parsed, not created; the page script's first new choice fails to build.
  const document = createDocument(), create = document.createElement.bind(document);
  document.createElement = tag => { if (tag === 'label') throw new Error('synthetic render failure'); return create(tag); };
  const { fieldset, shown } = bookPage({ now: Date.parse('2026-09-30T02:55:00.000Z') }, {}, { document });
  assert.deepEqual(shown(), STATIC, 'the page keeps the choices it was served');
  assert.equal(fieldset.hasAttribute('data-slots-rendered'), false);
  // The same marked page renders once nothing fails.
  document.createElement = create;
  assert.equal(bookPage({ now: Date.parse('2026-09-30T02:55:00.000Z') }, {}, { document }).shown().length, 5);
});

// The root middleware with a stand-in HTMLRewriter that records its handlers; the asset server is faked by next().
async function edge(env, path, { method = 'GET', headers = {} } = {}) {
  const handlers = [], asked = [];
  globalThis.HTMLRewriter = class { on(selector, handler) { handlers.push([selector, handler]); return this; } transform(response) { return response; } };
  try {
    const response = await middleware({ request: new Request(`https://easygaragecleaning.com${path}`, { method, headers }), env, data: {}, next: async (...args) => {
      asked.push(args);
      return new Response('<fieldset class="booking-slots"></fieldset>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ETag: '"synthetic-etag"', 'Last-Modified': 'Tue, 22 Sep 2026 12:00:00 GMT' } });
    } });
    const marker = handlers.find(([selector]) => selector === 'fieldset.booking-slots');
    const attributes = {};
    marker?.[1].element({ setAttribute: (name, value) => { attributes[name] = value; } });
    return { response, asked, marked: Boolean(marker), attributes };
  } finally { delete globalThis.HTMLRewriter; }
}

test('the flag is on only for exactly "true"', () => {
  assert.equal(bookingExplicitSlotsEnabled({ EGC_BOOKING_EXPLICIT_SLOTS: 'true' }), true);
  for (const value of [undefined, '', 'false', 'TRUE', 'True', ' true', 'true ', '1', 'yes', true]) assert.equal(bookingExplicitSlotsEnabled({ EGC_BOOKING_EXPLICIT_SLOTS: value }), false, String(value));
  for (const env of [undefined, null, {}]) assert.equal(bookingExplicitSlotsEnabled(env), false);
});

test('flag on: the middleware marks /book for booking-slots.js, always fetches it whole and serves it without validators', async () => {
  const on = { EGC_BOOKING_EXPLICIT_SLOTS: 'true' };
  for (const path of ['/book', '/book.html', '/book/']) {
    const { response, asked, marked, attributes } = await edge(on, path, { headers: { 'If-None-Match': '"synthetic-etag"', 'If-Modified-Since': 'Tue, 22 Sep 2026 12:00:00 GMT', Accept: 'text/html' } });
    assert.equal(marked, true, path);
    assert.deepEqual(attributes, { [BOOKING_SLOTS_MARKER]: '' });
    // A copy cached under the other flag state is never revalidated (304) back into use.
    assert.equal(asked.length, 1);
    assert.ok(asked[0][0] instanceof Request, 'the asset server is asked with a rewritten request');
    assert.equal(asked[0][0].headers.get('If-None-Match'), null);
    assert.equal(asked[0][0].headers.get('If-Modified-Since'), null);
    assert.equal(asked[0][0].headers.get('Accept'), 'text/html', 'other headers are kept');
    assert.equal(new URL(asked[0][0].url).pathname, path);
    assert.equal(response.headers.get('ETag'), null);
    assert.equal(response.headers.get('Last-Modified'), null);
  }
  assert.equal((await edge(on, '/book', { method: 'HEAD' })).marked, true);
  // Every other page, and a non-GET, is left as it was.
  for (const [path, method] of [['/', 'GET'], ['/garage-cleaning', 'GET'], ['/booking', 'GET'], ['/book', 'POST']]) {
    const { response, asked, marked } = await edge(on, path, { method, headers: { 'If-None-Match': '"synthetic-etag"' } });
    assert.equal(marked, false, `${method} ${path}`);
    assert.deepEqual(asked, [[]], `${method} ${path}`);
    assert.equal(response.headers.get('ETag'), '"synthetic-etag"');
  }
});

test('flag off: the middleware serves /book exactly as before: no marker, the request passed on untouched, validators kept', async () => {
  for (const value of [undefined, '', 'false', 'TRUE', ' true', '1']) {
    const { response, asked, marked } = await edge(value === undefined ? {} : { EGC_BOOKING_EXPLICIT_SLOTS: value }, '/book', { headers: { 'If-None-Match': '"synthetic-etag"' } });
    assert.equal(marked, false, String(value));
    assert.deepEqual(asked, [[]], 'next() is called exactly as before');
    assert.equal(response.headers.get('ETag'), '"synthetic-etag"');
    assert.equal(response.headers.get('Last-Modified'), 'Tue, 22 Sep 2026 12:00:00 GMT');
  }
});
