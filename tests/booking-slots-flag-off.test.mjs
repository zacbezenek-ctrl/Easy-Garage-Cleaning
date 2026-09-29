import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import { onRequest as middleware } from '../functions/_middleware.js';
import { webLeadHandlers } from '../functions/api/web-lead.js';
import { WEB_LEAD_RECEIPTS, openWebLead, syncHighLevelLead } from '../functions/_lib/web-lead-intake.js';
import { createDocument } from './helpers/hub-dom.mjs';

// SALES-BOOKING: with EGC_BOOKING_EXPLICIT_SLOTS anything but exactly "true", the public outputs the unit changed are
// byte-identical to before it: (a) /book's time choices and the values they post (the served fieldset, the root
// middleware's /book response and rewrite, and booking-slots.js left alone), (b) the HighLevel calls and the
// website-lead note, (c) the Zapier relay body and query, plus /api/web-lead's answer, its receipt and the lead it
// seals. The snapshot was recorded with UPDATE_SNAPSHOTS=1 by running this file alone, and nothing else of
// SALES-BOOKING, on the integration branch at the unit's merge base (88514f8, where booking-slots.js does not
// exist). Never re-record it on a tree that has SALES-BOOKING. Every instant and id here is fixed.
const OFF = { unset: {}, false: { EGC_BOOKING_EXPLICIT_SLOTS: 'false' }, upper: { EGC_BOOKING_EXPLICIT_SLOTS: 'TRUE' }, spaced: { EGC_BOOKING_EXPLICIT_SLOTS: ' true' }, one: { EGC_BOOKING_EXPLICIT_SLOTS: '1' }, empty: { EGC_BOOKING_EXPLICIT_SLOTS: '' } };
const snapshot = new URL('./snapshots/booking-slots-flag-off.snap', import.meta.url);
const ORIGIN = 'https://easygaragecleaning.com';
const ENV = { HIGHLEVEL_API_KEY: 'synthetic-highlevel-key', HIGHLEVEL_LOCATION_ID: 'location-synthetic', HIGHLEVEL_PIPELINE_ID: 'pipe-1', HIGHLEVEL_USER_ID: 'user-synthetic',
  WEBSITE_LEAD_HOOK_URL: 'https://hooks.example.test/lead?zap=synthetic', FIREBASE_API_KEY: 'firebase-test-booking-slots-flag', HUB_SESSION_SECRET: 'synthetic-booking-slots-flag-session-secret-0123456789' };
// Tuesday 20:55 and 09:30 in Denver (MDT), a Sunday morning, and the repeated 01:30 of the fall-back night.
const CLOCKS = ['2026-09-30T02:55:00.000Z', '2026-09-29T15:30:00.000Z', '2026-09-27T16:00:00.000Z', '2026-11-01T08:30:00.000Z'];
// Every choice the static /book form (and the other lead forms) can post, a free-typed variant, the time fields of the
// older forms, and explicit windows no pre-SALES-BOOKING form sends (still passed through untouched when off).
const SLOTS = [['Today PM'], ['Tomorrow AM'], ['Tomorrow PM'], ['This week'], ['Flexible'], [''], [undefined], [' tomorrow pm '], ['2026-09-30 AM'], ['2026-10-04 PM'],
  [undefined, { preferred_date: '2026-10-02', preferred_timing: 'Morning' }]];
const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
function render(rows) {
  const bodies = new Map(), index = [];
  for (const [label, body] of rows) { bodies.set(sha(body), body); index.push(`${label} | ${sha(body)}`); }
  return `${index.join('\n')}\n${[...bodies].sort(([a], [b]) => a.localeCompare(b)).map(([hash, body]) => `======== ${hash}\n${body}\n`).join('')}`;
}

// (a) /book: the fieldset as served, what the middleware does with a /book request (what it asks the asset server
// for and the caching headers it answers with), and the choices once every rewrite handler it registers and
// booking-slots.js (when the tree has it) have run, on load and when the page is shown again.
const bookHtml = readFileSync(new URL('../book.html', import.meta.url), 'utf8');
const pageScript = new URL('../booking-slots.js', import.meta.url);
const FIELDSET = /<fieldset class="booking-slots"[\s\S]*?<\/fieldset>/;
async function viaMiddleware(env, method, path, headers) {
  const handlers = [], asked = [];
  globalThis.HTMLRewriter = class { on(selector, handler) { handlers.push([selector, handler]); return this; } transform(response) { return response; } };
  try {
    const next = async (...args) => {
      asked.push(args.map(arg => arg instanceof Request ? { method: arg.method, url: arg.url, headers: [...arg.headers].sort() } : String(arg)));
      return new Response(method === 'HEAD' ? null : bookHtml, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ETag: '"synthetic-book-etag"', 'Last-Modified': 'Tue, 22 Sep 2026 12:00:00 GMT', 'Cache-Control': 'public, max-age=0, must-revalidate' } });
    };
    const response = await middleware({ request: new Request(ORIGIN + path, { method, headers }), env, next, data: {} });
    // What decides whether a browser reuses a copy; every rewrite handler is applied to the fieldset in pageChoices().
    const kept = ['cache-control', 'content-type', 'etag', 'last-modified'];
    return { handlers, record: { asked, status: response.status, headers: [...response.headers].filter(([name]) => kept.includes(name)).sort() } };
  } finally { delete globalThis.HTMLRewriter; }
}
function pageChoices(handlers) {
  const document = createDocument(), out = [];
  document.readyState = 'interactive';
  const holder = document.createElement('div');
  holder.innerHTML = FIELDSET.exec(bookHtml)[0];
  document.body.append(holder);
  const fieldset = holder.querySelector('fieldset.booking-slots');
  // Apply the middleware's element handlers to what they select in the served fieldset.
  for (const [selector, handler] of handlers) for (const node of document.querySelectorAll(selector)) handler.element?.({ setAttribute: (name, value) => node.setAttribute(name, value), getAttribute: name => node.getAttribute(name), hasAttribute: name => node.hasAttribute(name), removeAttribute: name => node.removeAttribute(name), before() {}, after() {}, append() {}, prepend() {} });
  const shown = step => out.push([step, fieldset.getAttributeNames ? fieldset.getAttributeNames().sort() : [...fieldset.attributes.keys()].sort(), fieldset.querySelectorAll('.booking-slot').map(label => [label.querySelector('input').value, label.textContent, label.querySelector('input').checked])]);
  // The visitor picks the static 'Tomorrow AM' (a page that re-rendered no longer offers it: the rows then differ).
  const pick = () => { const input = fieldset.querySelectorAll('input').find(input => input.value === 'Tomorrow AM'); if (input) input.checked = true; };
  shown('served');
  if (existsSync(pageScript)) {
    const clock = { now: Date.parse(CLOCKS[0]) }, events = {};
    class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return clock.now; } }
    const context = { Intl, Date: Clock, Number, Object, String, Math, JSON, Array, document, addEventListener: (name, listener) => { (events[name] ||= []).push(listener); } };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(readFileSync(pageScript, 'utf8'), context, { filename: 'booking-slots.js' });
    shown('loaded at Tuesday 20:55 Denver');
    pick();
    for (const [at, step] of [[CLOCKS[2], 'visible on a Sunday'], [CLOCKS[3], 'visible on the fall-back night']]) { clock.now = Date.parse(at); document.visibilityState = 'visible'; document.dispatch({ type: 'visibilitychange' }); shown(step); }
    clock.now = Date.parse(CLOCKS[1]);
    for (const listener of events.pageshow || []) listener({ type: 'pageshow', persisted: true });
    shown('restored from the back-forward cache');
  } else {
    // The tree before SALES-BOOKING has no page script: what is served is what shows, at every step.
    for (const step of ['loaded at Tuesday 20:55 Denver', 'visible on a Sunday', 'visible on the fall-back night', 'restored from the back-forward cache']) {
      if (step === 'visible on a Sunday') pick();
      shown(step);
    }
  }
  return out;
}
async function bookRows(extra) {
  const rows = [['book.html fieldset', FIELDSET.exec(bookHtml)[0]]];
  const requests = [['GET', '/book', {}], ['GET', '/book', { 'If-None-Match': '"synthetic-book-etag"', 'If-Modified-Since': 'Tue, 22 Sep 2026 12:00:00 GMT' }], ['GET', '/book.html', {}], ['GET', '/book/', {}], ['HEAD', '/book', { 'If-None-Match': '"synthetic-book-etag"' }]];
  for (const [method, path, headers] of requests) {
    const { handlers, record } = await viaMiddleware({ ...ENV, ...extra }, method, path, headers);
    rows.push([`middleware ${method} ${path}${Object.keys(headers).length ? ' conditional' : ''}`, JSON.stringify(record)]);
    if (method === 'GET') rows.push([`choices ${method} ${path}${Object.keys(headers).length ? ' conditional' : ''}`, JSON.stringify(pageChoices(handlers))]);
  }
  return rows;
}

// (b), (c): /api/web-lead with HighLevel and the Zapier hook faked, on the legacy path and through the receipt ledger.
function ledgerStore() {
  const rows = new Map(), commits = [];
  let n = 0;
  return {
    commits,
    async read(collection, id) { const row = rows.get(`${collection}/${id}`); return row ? structuredClone(row) : null; },
    async commit(writes) {
      commits.push(structuredClone(writes));
      for (const write of writes) { const key = `${write.collection}/${write.id}`; if (write.revision ? rows.get(key)?.revision !== write.revision : rows.has(key)) throw Object.assign(new Error('Conflict'), { code: 'web_lead_revision_conflict', status: 409 }); }
      for (const write of writes) { const key = `${write.collection}/${write.id}`; rows.set(key, { ...(write.revision ? rows.get(key) : {}), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` }); }
    },
  };
}
function providers(t) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const href = String(input), url = new URL(href);
    if (url.hostname === 'hooks.example.test') { calls.push({ to: 'zapier', method: options.method, query: url.search, contentType: options.headers?.['Content-Type'], body: options.body }); return new Response('{}', { status: 200 }); }
    assert.equal(url.hostname, 'services.leadconnectorhq.com', href);
    calls.push({ to: 'highlevel', method: options.method || 'GET', path: url.pathname + url.search, headers: Object.entries(options.headers || {}).filter(([name]) => name !== 'Authorization').sort(), body: options.body ?? null });
    if (url.pathname === '/contacts/upsert') return Response.json({ contact: { id: 'contact-web' }, new: true });
    if (url.pathname.startsWith('/opportunities/pipelines')) return Response.json({ pipelines: [{ id: 'pipe-1', stages: [{ id: 'stage-new' }] }] });
    if (url.pathname === '/opportunities/search') return Response.json({ opportunities: [], meta: { total: 0 } });
    if (url.pathname === '/opportunities/upsert') return Response.json({ opportunity: { id: 'opp-web' } });
    return Response.json({});
  });
  return calls;
}
const lead = (slot, extra, n) => ({ name: 'Synthetic Walkthrough', phone: '(970) 555-0101', email: 'walkthrough@example.invalid', service_type: 'Garage Cleanout', job_size: 'Medium garage', city: 'Fort Collins', serviceZip: '80525',
  flow_type: 'walkthrough', sms_consent: 'yes', source: 'Website', page_url: 'https://easygaragecleaning.com/book', utm_source: 'synthetic', inquiry_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  ...(slot === undefined ? {} : { booking_slot: slot }), ...extra });
async function ledgerRecord(env, store) {
  const out = [];
  for (const writes of store.commits) {
    const rows = [];
    for (const write of writes) {
      const patch = { ...write.patch };
      // The receipt and its sealed lead; the inquiry.received funnel event beside it is FUN-13's, untouched by SALES-BOOKING.
      if (write.collection !== WEB_LEAD_RECEIPTS) continue;
      if ('sealedPayload' in patch) patch.sealedPayload = patch.sealedPayload ? { opened: await openWebLead(env, write.id, patch.sealedPayload) } : null;
      if (typeof patch.claimId === 'string') patch.claimId = '<claim>';
      rows.push({ collection: write.collection, id: write.id, revision: write.revision ?? null, patch });
    }
    out.push(rows);
  }
  return out;
}
async function webLeadRows(calls, extra) {
  const rows = [];
  let n = 0;
  const paths = [['legacy', {}, {}], ['ledger', { WEB_LEAD_RECEIPTS_ENABLED: 'true' }, {}], ['no sms consent', {}, { sms_consent: 'no' }]];
  for (const [path, pathEnv, pathLead] of paths) for (const at of path === 'no sms consent' ? CLOCKS.slice(0, 1) : CLOCKS.slice(0, 3)) for (const [slot, slotExtra] of SLOTS) {
    const env = { ...ENV, ...pathEnv, ...extra }, store = ledgerStore(), body = lead(slot, { ...pathLead, ...slotExtra }, ++n);
    calls.length = 0;
    const response = await webLeadHandlers({ storage: () => store, now: () => new Date(at) }).post({ env, request: new Request(`${ORIGIN}/api/web-lead`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    rows.push([`web-lead ${path} ${at} ${JSON.stringify(slot ?? null)}${slotExtra ? ' +preferred' : ''}`, JSON.stringify({ status: response.status, headers: [...response.headers].sort(), answer: await response.text(), calls, ledger: await ledgerRecord(env, store) })]);
  }
  // The cron's late sync of a sealed lead, and leads sealed while the flag was on (with the customer's words and a
  // problem), synced after it was turned off: the note's slot line is exactly as the code before SALES-BOOKING wrote it.
  const sealed = [lead('Tomorrow AM', {}, 900), lead('2026-09-30 AM', { booking_slot_choice: 'Tomorrow AM' }, 901), lead('2026-09-29 PM', { booking_slot_choice: 'Today PM', booking_slot_problem: 'started' }, 902), lead('2026-10-04 AM', { booking_slot_problem: 'closed' }, 903)];
  for (const value of sealed) for (const delayed of [false, true]) {
    calls.length = 0;
    const result = await syncHighLevelLead({ ...ENV, ...extra }, { ...value, phone: '+19705550101' }, undefined, { delayed, createdContactId: delayed ? 'contact-web' : '' });
    rows.push([`sync ${value.inquiry_id.slice(-3)} ${delayed ? 'delayed' : 'on time'}`, JSON.stringify({ result, calls })]);
  }
  return rows;
}

test('with EGC_BOOKING_EXPLICIT_SLOTS anything but exactly "true", /book, /api/web-lead, the HighLevel note and the Zapier relay are byte-identical to before SALES-BOOKING', async t => {
  const texts = {}, calls = providers(t);
  for (const [mode, extra] of Object.entries(OFF)) texts[mode] = render([...await bookRows(extra), ...await webLeadRows(calls, extra)]);
  if (process.env.UPDATE_SNAPSHOTS === '1') { mkdirSync(new URL('./snapshots/', import.meta.url), { recursive: true }); writeFileSync(snapshot, texts.unset); }
  assert.ok(existsSync(snapshot), 'the baseline snapshot was recorded from the code before SALES-BOOKING');
  const baseline = readFileSync(snapshot, 'utf8');
  for (const [mode, text] of Object.entries(texts)) assert.equal(text, baseline, `a flag-off output changed (${mode})`);
});
