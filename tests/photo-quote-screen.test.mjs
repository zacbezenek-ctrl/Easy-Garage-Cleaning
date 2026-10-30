// OFFICE: the Hub's Photo quote screen (employee-photo-quote.js) on the real UI kit in a vm with a small DOM, talking to
// the real /api/customer-resolve, /api/quote-draft and /api/dispatch handlers over one in-memory store
// (tests/helpers/estimator-fixture.mjs) as the office role: customer, photos, removal items, review and save, book, send.
// Dispatch's own booking dialog (employee-dispatch.js openFor) is stood in for by a booking through /api/dispatch.
// Synthetic data only; every clock and id is injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDocument, storage } from './helpers/hub-dom.mjs';
import { menuPrices } from '../functions/_lib/composite-quote.js';
import { quoteDraftHandlers } from '../functions/api/quote-draft.js';
import { dispatchHandlers } from '../functions/api/dispatch.js';
import { customerResolveHandler } from '../functions/api/customer-resolve.js';
import { MON, NOW, ON_ENV, builderState, fixture } from './helpers/estimator-fixture.mjs';

const ORIGIN = 'https://easygaragecleaning.com';
const office = { user: 'office.person', role: 'crew', businessAccess: false, displayName: 'Synthetic Office', source: 'employee-account', staffRoles: ['office'] };
const approved = () => { const prices = {}; for (const [id, price] of menuPrices(builderState())) if (price.unitCents !== null) prices[id] = price.unitCents; return builderState(prices); };
class Fixed extends Date { constructor(...args) { super(...(args.length ? args : [Date.parse(NOW)])); } static now() { return Date.parse(NOW); } }

function page({ state = approved(), actor = office, session = storage({ egc_u: 'office.person' }), f = fixture() } = {}) {
  const at = () => new Date(NOW), calls = [], bookings = [];
  const quotes = quoteDraftHandlers({ session: async () => actor, storage: () => f.store, now: at, compositeState: async () => state, stripe: () => null, delivery: () => ({ deliver: async () => ({ status: 'not_requested' }) }) });
  const dispatch = dispatchHandlers({ session: async () => actor, storage: () => f.store, now: at, ghlTags: () => {}, ghlMirror: async () => false });
  const resolve = customerResolveHandler({ session: async () => actor, storage: () => f.store });
  const hubFetch = async (url, init = {}) => {
    const method = init.method || 'GET', request = new Request(ORIGIN + url, { method, headers: { Origin: ORIGIN, ...(init.headers || {}) }, ...(init.body ? { body: init.body } : {}) });
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : null });
    const path = new URL(ORIGIN + url).pathname;
    if (path === '/api/quote-draft') return method === 'GET' ? quotes.get({ request, env: ON_ENV }) : quotes.post({ request, env: ON_ENV });
    if (path === '/api/dispatch') return method === 'GET' ? dispatch.get({ request, env: ON_ENV }) : dispatch.post({ request, env: ON_ENV, waitUntil() {} });
    if (path === '/api/customer-resolve') return resolve({ request, env: ON_ENV });
    return Response.json({ ok: false, error: 'Not in this test' }, { status: 404 });
  };
  const document = createDocument();
  // Dispatch's Edit dialog, as a booker saves it: the date and time, the crew left to the server.
  const EGCDispatch = { openFor: async (job, action, { onClose }) => { bookings.push({ job, action, onClose }); return { opened: true }; } };
  const context = { console, URL, URLSearchParams, Intl, Promise, Map, Set, Error, JSON, Object, Array, Math, Number, String, AbortController, crypto, structuredClone, Date: Fixed, Node: document.Node, document,
    sessionStorage: session, setTimeout, clearTimeout, addEventListener() {}, location: { href: ORIGIN + '/employee' }, EGCDispatch };
  context.window = context;
  vm.createContext(context);
  for (const file of ['employee-ui-kit.js', 'employee-photo-quote.js']) vm.runInContext(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), context, { filename: file });
  const host = document.createElement('main');
  document.body.append(host);
  const ctx = Object.freeze({ identity: 'office.person', role: 'crew', capabilities: ['crew', 'customer_contact', 'photo_quote'], hubFetch, toast() {}, askAction: async () => null, go() {}, screen: 'photo_quote' });
  const mount = () => context.EGCPhotoQuote.mount(host, ctx);
  mount();
  const root = () => host.querySelector('.pq'), text = () => root()?.textContent || '';
  const button = label => { const found = root().querySelectorAll('button').find(node => node.textContent === label); assert.ok(found, `button ${label} in: ${text().slice(0, 400)}`); return found; };
  const field = label => { const found = root().querySelectorAll('label').find(node => node.querySelector('span')?.textContent === label); assert.ok(found, `field ${label}`); return found.querySelector('input,textarea,select'); };
  const type = (label, value) => { const node = field(label); node.value = value; node.dispatchEvent({ type: 'input', target: node }); };
  const step = () => root().querySelector('.pq-steps [aria-current="step"]')?.textContent || '';
  // Waits for the screen's request to finish (canLeave is false while one is in flight) and the menu to load.
  const flush = async () => { for (let index = 0; index < 2000; index++) { await new Promise(resolve => setTimeout(resolve, 2)); if (context.EGCPhotoQuote.canLeave() && !root()?.querySelector('.hub-skeleton')) return; } };
  return { flush, f, calls, bookings, root, text, button, field, type, step, context, session, mount, unmount: () => context.EGCPhotoQuote.unmount(), dispatch, at };
}

test('Photo quote: customer, photos, removal items, review and save, book in Dispatch, then send; every amount is the server\'s', async () => {
  const ui = page();
  assert.match(ui.step(), /Customer/);
  assert.equal(ui.calls.length, 0, 'nothing is requested before the office user acts');
  ui.type('Customer name', 'Synthetic Photo Customer');
  ui.type('Phone', '970-555-0188');
  ui.type('Service address', '500 Fixture Lane, Fort Collins, CO 80521');
  ui.button('Continue to photos').click(); await ui.flush();
  assert.match(ui.step(), /Photos/, ui.text());
  assert.equal(ui.calls[0].url, '/api/customer-resolve');
  assert.match(ui.text(), /not linked to a HighLevel contact/);
  ui.type('What to remove (from the photos)', 'Old couch by the side door, about a full truck of boxes');
  ui.button('Continue to removal items').click(); await ui.flush();
  assert.match(ui.step(), /Removal items/);
  assert.deepEqual(ui.calls.at(-1), { method: 'GET', url: '/api/quote-draft?view=builder', body: null });
  // Only removal groups are offered: truck loads, special-handling items and access charges; no shelving or storage.
  assert.match(ui.text(), /Truck loads/); assert.match(ui.text(), /Special-handling items/); assert.match(ui.text(), /Access charges/);
  assert.doesNotMatch(ui.text(), /Garage cleaning base|Shelving|Overhead storage|Two-car garage/);
  ui.button('Price the quote').click(); await ui.flush();
  assert.match(ui.text(), /Add at least one truck load/);
  ui.type('Full truck loads ($1,000.00 each)', '1');
  ui.button('Price the quote').click(); await ui.flush();
  assert.match(ui.step(), /Review/);
  const preview = ui.calls.at(-1);
  assert.deepEqual([preview.body.action, preview.body.compositePricing.removal.length, preview.body.compositePricing.shelving, preview.body.compositePricing.storage], ['composite_preview', 1, [], []]);
  assert.match(ui.text(), /Junk removal: full truck load/);
  assert.match(ui.text(), /\$1,000\.00/);
  assert.match(ui.text(), /25% when they approve the quote and the other 75% on the job day/);
  ui.button('Save quote').click(); await ui.flush(); 
  assert.match(ui.step(), /Book/, ui.text());
  const save = ui.calls.find(call => call.body?.action === 'save');
  assert.equal(save.body.sourceWalkthroughId, undefined);
  assert.deepEqual(save.body.draft.walkthrough_capture, { removeItems: 'Old couch by the side door, about a full truck of boxes' });
  const jobId = save && ui.f.writesTo('jobs').find(write => write.patch?.quoteDraft)?.id;
  assert.ok(jobId);
  assert.match(ui.text(), /25% on approval \$250\.00/);
  // The flow survives a reload: the saved quote and its step come back from this viewer's session draft.
  ui.unmount(); ui.mount();
  assert.match(ui.step(), /Book/);
  assert.match(ui.text(), /\$1,000\.00/);
  // Book: Dispatch's dialog opens on the saved job; the booker saves a day and time and the server picks the crew.
  ui.button('Book in Dispatch').click(); await ui.flush();
  assert.equal(ui.bookings.length, 1);
  assert.deepEqual([ui.bookings[0].action, ui.bookings[0].job.id], ['edit', jobId]);
  const job = ui.f.job(jobId), booked = await ui.dispatch.post({ request: new Request(ORIGIN + '/api/dispatch', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'schedule.update', requestId: '00000000-0000-4000-8000-000000000901', jobId, expectedRevision: job.revision, changes: { date: MON, time: '09:30', endTime: '12:30' } }) }), env: ON_ENV, waitUntil() {} });
  assert.equal(booked.status, 200);
  ui.bookings[0].onClose({ saved: 'Saved' }); await ui.flush();
  assert.match(ui.step(), /Send/, ui.text());
  assert.match(ui.text(), new RegExp(`Job day: ${MON} at 09:30`));
  ui.button('Preview the send').click(); await ui.flush();
  assert.match(ui.text(), /Send EST-/);
  ui.button('Send to the customer').click(); await ui.flush();
  assert.match(ui.text(), /Quote sent/);
  assert.deepEqual([ui.f.job(jobId).estimate.status, ui.f.job(jobId).estimate.paymentSchedule.remainderDueDate], ['sent', MON]);
  ui.button('Start another photo quote').click();
  assert.match(ui.step(), /Customer/);
  assert.equal(ui.session.getItem('egc.hub.draft.v1.photo_quote.office.person').includes(jobId), false);
});

test('Photo quote shows the server\'s refusal and keeps the office user\'s work', async () => {
  // A crew account (no office role) is refused at the customer step; nothing is saved and the typed details stay.
  const ui = page({ actor: { user: 'crew.person', role: 'crew', businessAccess: false, source: 'employee-account', staffRoles: ['crew'] } });
  ui.type('Customer name', 'Synthetic Photo Customer');
  ui.type('Email', 'photo.customer@example.invalid');
  ui.type('Service address', '500 Fixture Lane');
  ui.button('Continue to photos').click(); await ui.flush();
  assert.match(ui.step(), /Customer/);
  assert.match(ui.root().querySelector('[role="alert"]').textContent, /prepare quotes|access/);
  assert.equal(ui.field('Customer name').value, 'Synthetic Photo Customer');
  assert.equal(ui.f.calls.length, 0);
  // The send is offered only once the job day is booked.
  const office2 = page();
  office2.type('Customer name', 'Synthetic Photo Customer'); office2.type('Phone', '9705550188'); office2.type('Service address', '500 Fixture Lane');
  office2.button('Continue to photos').click(); await office2.flush();
  office2.button('Continue to removal items').click(); await office2.flush();
  office2.type('Full truck loads ($1,000.00 each)', '2');
  office2.button('Price the quote').click(); await office2.flush();
  office2.button('Save quote').click(); await office2.flush();
  office2.button('I booked it in Team schedule').click(); await office2.flush();
  assert.match(office2.step(), /Book/, 'no day yet: still on Book');
  assert.equal(office2.root().querySelectorAll('button').some(node => node.textContent === 'Continue to send'), false);
});
