import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { onRequestGet as highLevelGet } from '../functions/api/highlevel.js';
import { dispatchHandlers } from '../functions/api/dispatch.js';
import { webLeadHandlers } from '../functions/api/web-lead.js';
import { WEB_LEAD_RECEIPTS, openWebLead } from '../functions/_lib/web-lead-intake.js';
import { getHubSession } from '../functions/_lib/hub-session.js';
import { staffEnv, cookieFor, ORIGIN } from './helpers/vault-fixture.mjs';
import { memoryStore } from './helpers/auth-roles-harness.mjs';
import { hubPage, createDocument, storage } from './helpers/hub-dom.mjs';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';

// SALES-BOOKING: the phone person's booking tools. Synthetic data only; HighLevel and the Zapier hook are faked on
// globalThis.fetch (reads only: nothing here writes to HighLevel), and every clock is injected.
const NOW = '2026-09-22T15:00:00.000Z';
const HL = { HIGHLEVEL_API_KEY: 'synthetic-highlevel-key', HIGHLEVEL_LOCATION_ID: 'location-synthetic' };
const STAFF = {
  'Config.Phone': { passwordHash: 'unused-synthetic-phone-hash', role: 'crew', displayName: 'Synthetic Phone', staffRoles: ['phone'] },
  'Config.Sales': { passwordHash: 'unused-synthetic-sales-hash', role: 'crew', displayName: 'Synthetic Sales', staffRoles: ['sales'] },
  'Config.Crew': { passwordHash: 'unused-synthetic-crew-hash', role: 'crew', displayName: 'Synthetic Crew', staffRoles: ['crew'] },
};
const LEAD_NOTE = ['EGC WEBSITE LEAD DETAILS', 'Service: Garage Cleanout', 'Job size: Medium garage', 'Email: synthetic.lead@example.invalid', 'Location: Fort Collins 80525',
  'Requested slot: 2026-09-24 PM (chosen as "Thursday afternoon")', 'Form path: walkthrough'].join('\n');
const OPPORTUNITY = { id: 'opp-1', name: 'Synthetic Lead — Garage cleanout', status: 'open', source: 'Website', pipelineId: 'pipe-1', pipelineStageId: 'stage-1', createdAt: '2026-09-21T15:00:00.000Z',
  monetaryValue: 2250, assignedTo: 'user-synthetic', contactId: 'contact-1', contact: { id: 'contact-1', name: 'Synthetic Lead', phone: '+19705550111', email: 'synthetic.lead@example.invalid', tags: ['internal-tag'] } };

function highLevel(t, overrides = {}) {
  const calls = [];
  const routes = {
    '/opportunities/pipelines': () => Response.json({ pipelines: [{ id: 'pipe-1', stages: [{ id: 'stage-1', name: 'New lead' }] }] }),
    '/opportunities/search': () => Response.json({ opportunities: [OPPORTUNITY] }),
    '/contacts/': () => Response.json({ contacts: [{ id: 'contact-1', name: 'Synthetic Lead', phone: '+19705550111', email: 'synthetic.lead@example.invalid', address1: '123 Synthetic Way', city: 'Fort Collins', state: 'CO', source: 'synthetic-source', tags: ['egc-invoice-overdue'] }] }),
    '/contacts/contact-1': () => Response.json({ contact: { id: 'contact-1', locationId: 'location-synthetic', name: 'Synthetic Lead', phone: '+19705550111', email: 'synthetic.lead@example.invalid', address1: '123 Synthetic Way', city: 'Fort Collins', state: 'CO', tags: ['internal-tag'] } }),
    '/contacts/contact-1/notes': () => Response.json({ notes: [{ id: 'note-1', body: LEAD_NOTE, dateAdded: '2026-09-21T15:00:05.000Z' }, { id: 'note-2', body: 'Called, left a voicemail.', dateAdded: '2026-09-22T14:00:00.000Z' }] }),
    ...overrides,
  };
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.hostname, 'services.leadconnectorhq.com', 'only HighLevel is reachable here');
    calls.push({ method: options.method || 'GET', path: url.pathname });
    const route = routes[url.pathname];
    return route ? route(url) : Response.json({ message: 'synthetic missing route' }, { status: 404 });
  });
  return calls;
}
async function sessions(t, extra = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const env = staffEnv({ ...HL, ...extra }, STAFF), cookies = {};
  for (const user of ['ZacB', 'Config.Phone', 'Config.Sales', 'Config.Crew']) cookies[user] = await cookieFor(env, user);
  return { env, cookies };
}
const get = async (env, cookie, query) => {
  const response = await highLevelGet({ env, request: new Request(`${ORIGIN}/api/highlevel?${query}`, { headers: { Cookie: cookie } }) });
  return { status: response.status, body: await response.json() };
};

test('flag off: a Sales or Phone account still cannot open the lead feed, the contact search or a lead; business access is unchanged', async t => {
  const { env, cookies } = await sessions(t), calls = highLevel(t);
  for (const user of ['Config.Phone', 'Config.Sales'])
    for (const query of ['view=command', 'view=contacts&q=Synthetic', 'view=lead&contactId=contact-1']) {
      const answer = await get(env, cookies[user], query);
      assert.deepEqual([answer.status, answer.body.code], [403, 'BUSINESS_ACCESS_REQUIRED'], `${user} ${query}`);
    }
  assert.deepEqual(calls, [], 'a refused request never reaches HighLevel');
  const owner = await get(env, cookies.ZacB, 'view=command');
  assert.equal(owner.status, 200);
  assert.equal(owner.body.projection, undefined);
  assert.equal(owner.body.opportunities[0].monetaryValue, 2250, 'a business user keeps the full opportunity');
  const search = await get(env, cookies.ZacB, 'view=contacts&q=Synthetic');
  assert.deepEqual([search.body.contacts[0].tags, search.body.contacts[0].source], [['egc-invoice-overdue'], 'synthetic-source'], 'a business user keeps the full contact search');
});

test('flag on: a booker reads the lead feed without opportunity values, the contact search and one lead; other CRM views stay business-only', async t => {
  const { env, cookies } = await sessions(t, { EGC_STAFF_ROLE_ACCESS: 'true' }), calls = highLevel(t);
  for (const user of ['Config.Phone', 'Config.Sales']) {
    const feed = await get(env, cookies[user], 'view=command');
    assert.equal(feed.status, 200, user);
    assert.deepEqual([feed.body.projection, feed.body.locationId], ['booker', 'location-synthetic']);
    assert.deepEqual(feed.body.opportunities, [{ id: 'opp-1', name: 'Synthetic Lead — Garage cleanout', status: 'open', source: 'Website', pipelineId: 'pipe-1', pipelineStageId: 'stage-1',
      createdAt: '2026-09-21T15:00:00.000Z', contactId: 'contact-1', contact: { id: 'contact-1', name: 'Synthetic Lead', phone: '+19705550111', email: 'synthetic.lead@example.invalid' } }]);
    assert.doesNotMatch(JSON.stringify(feed.body), /2250|monetaryValue|user-synthetic|internal-tag/);
    const found = await get(env, cookies[user], 'view=contacts&q=Synthetic');
    assert.equal(found.status, 200);
    assert.deepEqual(found.body.contacts, [{ id: 'contact-1', name: 'Synthetic Lead', phone: '+19705550111', email: 'synthetic.lead@example.invalid', address: '123 Synthetic Way, Fort Collins, CO' }],
      'a booker\'s contact search carries no tags (money status) and no source, like the lead feed');
    assert.doesNotMatch(JSON.stringify(found.body), /egc-invoice-overdue|synthetic-source/);
    for (const query of ['view=walkthroughs&date=2026-09-22', 'view=schedule&start=2026-09-22&end=2026-09-29']) assert.equal((await get(env, cookies[user], query)).status, 403, `${user} ${query}`);
  }
  // A crew account holds no booking right.
  assert.equal((await get(env, cookies['Config.Crew'], 'view=command')).status, 403);
  assert.ok(calls.every(call => call.method === 'GET'), 'the Hub only reads HighLevel here');
});

test('one lead: the contact and the requested window from its newest website-lead note', async t => {
  const { env, cookies } = await sessions(t, { EGC_STAFF_ROLE_ACCESS: 'true' }), calls = highLevel(t);
  const answer = await get(env, cookies['Config.Phone'], 'view=lead&contactId=contact-1');
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { ok: true, locationId: 'location-synthetic', notesRead: true, lead: { contactId: 'contact-1', name: 'Synthetic Lead', phone: '+19705550111', email: 'synthetic.lead@example.invalid',
    address: '123 Synthetic Way, Fort Collins, CO', service: 'Garage Cleanout', requestedSlot: { date: '2026-09-24', window: 'PM' }, requestedSlotText: '2026-09-24 PM' } });
  assert.deepEqual(calls.map(call => `${call.method} ${call.path}`).sort(), ['GET /contacts/contact-1', 'GET /contacts/contact-1/notes']);
  assert.equal((await get(env, cookies['Config.Phone'], 'view=lead&contactId=../contacts')).status, 400);
});

test('one lead: unreadable notes leave the window out, an unknown or foreign contact is not found', async t => {
  const { env, cookies } = await sessions(t, { EGC_STAFF_ROLE_ACCESS: 'true' });
  let location = 'location-synthetic';
  highLevel(t, { '/contacts/contact-1/notes': () => Response.json({ message: 'synthetic outage' }, { status: 503 }),
    '/contacts/contact-1': () => Response.json({ contact: { id: 'contact-1', locationId: location, name: 'Synthetic Lead', phone: '+19705550111', address1: '123 Synthetic Way', city: 'Fort Collins', state: 'CO' } }) });
  const partial = await get(env, cookies['Config.Phone'], 'view=lead&contactId=contact-1');
  assert.deepEqual([partial.status, partial.body.notesRead, partial.body.lead.requestedSlot, partial.body.lead.address], [200, false, null, '123 Synthetic Way, Fort Collins, CO']);
  const missing = await get(env, cookies['Config.Phone'], 'view=lead&contactId=contact-2');
  assert.deepEqual([missing.status, missing.body.ok], [404, false]);
  location = 'another-location';
  assert.equal((await get(env, cookies['Config.Phone'], 'view=lead&contactId=contact-1')).status, 404, 'a contact of another HighLevel location is never shown');
  location = undefined;
  assert.equal((await get(env, cookies['Config.Phone'], 'view=lead&contactId=contact-1')).status, 404, 'a contact whose location cannot be confirmed is not shown (the customer-resolution rule)');
});

test('outage wording: not configured is 501, a HighLevel failure is 502 without provider detail for a booker', async t => {
  const { env, cookies } = await sessions(t, { EGC_STAFF_ROLE_ACCESS: 'true' });
  highLevel(t, { '/opportunities/pipelines': () => Response.json({ message: 'synthetic provider detail' }, { status: 503 }) });
  const booker = await get(env, cookies['Config.Phone'], 'view=command');
  assert.deepEqual([booker.status, booker.body], [502, { ok: false, error: 'HighLevel is unreachable' }]);
  const owner = await get(env, cookies.ZacB, 'view=command');
  assert.equal(owner.status, 502);
  assert.match(owner.body.detail, /synthetic provider detail/, 'business users keep the diagnostic detail as before');
  const unconfigured = await get({ ...env, HIGHLEVEL_API_KEY: '' }, cookies['Config.Phone'], 'view=command');
  assert.deepEqual([unconfigured.status, unconfigured.body.code], [501, 'HIGHLEVEL_NOT_CONFIGURED']);
});

test('the dispatch board reports each booker’s walkthrough right while flag-off viewers stay unchanged', async t => {
  const { env: on, cookies } = await sessions(t, { EGC_STAFF_ROLE_ACCESS: 'true' });
  const off = staffEnv(HL, STAFF);
  const board = async (env, cookie) => {
    const session = await getHubSession(new Request(`${ORIGIN}/api/dispatch`, { headers: { Cookie: cookie } }), env);
    const response = await dispatchHandlers({ session: async () => session, storage: memoryStore, now: () => new Date(NOW) }).get({ env, request: new Request(`${ORIGIN}/api/dispatch?startDate=2026-09-22&endDate=2026-09-29`) });
    return { status: response.status, body: await response.json() };
  };
  const phone = await board(on, cookies['Config.Phone']);
  assert.equal(phone.status, 200);
  assert.deepEqual(phone.body.viewer, { id: 'Config.Phone', booker: true, canPerformWalkthrough: false });
  assert.deepEqual((await board(on, cookies['Config.Sales'])).body.viewer, { id: 'Config.Sales', booker: true, canPerformWalkthrough: true });
  assert.deepEqual((await board(on, cookies.ZacB)).body.viewer, { id: 'ZacB', canPerformWalkthrough: true });
  assert.deepEqual((await board(off, cookies.ZacB)).body.viewer, { id: 'ZacB' });
  assert.equal((await board(off, cookies['Config.Phone'])).status, 403);
});

// WT-OUTCOME after SALES-BOOKING: the Hub Walkthroughs screen also opens for a Sales or Phone booker and reads GET
// /api/dispatch as one. The walkthrough outcome fields reach them; a price, deposit, estimate, private note or performer never does.
test('a booker reads walkthrough outcomes from the dispatch board with no money, notes or performer', async t => {
  const { env, cookies } = await sessions(t, { EGC_STAFF_ROLE_ACCESS: 'true' });
  const outcome = (value, extra = {}) => ({ outcome: value, reasonCode: null, finishedAt: '2026-09-22T15:40:00.000Z', performedBy: 'synthetic.secret.rep', typedNotes: ['SYNTHETIC-PRIVATE-NOTE'], ...extra });
  const walk = (id, extra) => ({ id, revision: id + '-r1', type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', address: '100 Fixture Lane',
    date: '2026-09-23', endDate: '2026-09-23', time: '09:00', endTime: '10:00', assignedCrew: ['crew.one'], scheduleSource: 'egc_hub', estimate: { status: 'accepted', amount: 98765, depositRequired: 43210 },
    internalNotes: 'SYNTHETIC-PRIVATE-NOTE', ...extra });
  const seeded = e => {
    const store = memoryStore(e);
    store.rows.set('jobs/walk-sold', walk('walk-sold', { convertedJobId: 'job-crewed', walkthroughOutcome: outcome('sold_on_site'), walkthroughCompletedAt: '2026-09-22T15:40:00.000Z' }));
    store.rows.set('jobs/walk-noshow', walk('walk-noshow', { time: '11:00', endTime: '12:00', walkthroughOutcome: outcome('customer_no_show', { reasonCode: 'customer_not_home' }) }));
    return store;
  };
  for (const user of ['Config.Sales', 'Config.Phone']) {
    const session = await getHubSession(new Request(`${ORIGIN}/api/dispatch`, { headers: { Cookie: cookies[user] } }), env);
    const response = await dispatchHandlers({ session: async () => session, storage: seeded, now: () => new Date(NOW) }).get({ env, request: new Request(`${ORIGIN}/api/dispatch?startDate=2026-09-22&endDate=2026-09-29&includeUnscheduled=true`) });
    assert.equal(response.status, 200, user);
    const body = await response.json(), text = JSON.stringify(body), dto = id => body.jobs.find(job => job.id === id);
    assert.deepEqual(body.viewer, { id: user, booker: true, canPerformWalkthrough: user === 'Config.Sales' });
    assert.deepEqual([dto('walk-sold').walkthroughBadge, dto('walk-sold').convertedJobId, dto('walk-noshow').walkthroughState, dto('walk-noshow').walkthroughBadge], ['Sold \u2192 open job', 'job-crewed', 'no_show', 'No-show \u00b7 rebook']);
    for (const secret of ['98765', '43210', 'SYNTHETIC-PRIVATE-NOTE', 'synthetic.secret.rep']) assert.equal(text.includes(secret), false, `${user}: ${secret}`);
    assert.doesNotMatch(text, /"(?:moneyReady|depositRequiredCents|depositDueCents|hasApprovedPrice|estimate|total|typedNotes|performedBy)"/, user);
    assert.notEqual(body.ghlTagRetry, true, `${user}: no HighLevel Retry for a booker`);
  }
});

// web-lead, with EGC_BOOKING_EXPLICIT_SLOTS=true: the requested window is stored as an explicit Denver date resolved as the
// lead arrives. With the flag off, tests/booking-slots-flag-off.test.mjs pins every output to the code before SALES-BOOKING.
function ledgerStore() {
  const rows = new Map(), commits = [];
  let n = 0;
  return {
    rows, commits,
    async read(collection, id) { const row = rows.get(`${collection}/${id}`); return row ? structuredClone(row) : null; },
    async commit(writes) {
      commits.push(structuredClone(writes));
      for (const write of writes) { const key = `${write.collection}/${write.id}`; if (write.revision ? rows.get(key)?.revision !== write.revision : rows.has(key)) throw Object.assign(new Error('Conflict'), { code: 'web_lead_revision_conflict', status: 409 }); }
      for (const write of writes) { const key = `${write.collection}/${write.id}`; rows.set(key, { ...(write.revision ? rows.get(key) : {}), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` }); }
    },
  };
}
function leadProviders(t) {
  const notes = [], relays = [];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const href = String(input);
    if (href.startsWith('https://hooks.example.test/lead')) { relays.push(JSON.parse(options.body)); return new Response('{}', { status: 200 }); }
    const url = new URL(href);
    assert.equal(url.hostname, 'services.leadconnectorhq.com', href);
    if (url.pathname === '/contacts/upsert') return Response.json({ contact: { id: 'contact-web' }, new: true });
    if (url.pathname === '/contacts/contact-web/notes') { notes.push({ body: JSON.parse(options.body).body, key: options.headers?.['Idempotency-Key'] }); return Response.json({}); }
    if (url.pathname.startsWith('/opportunities/pipelines')) return Response.json({ pipelines: [{ id: 'pipe-1', stages: [{ id: 'stage-new' }] }] });
    if (url.pathname === '/opportunities/upsert') return Response.json({ opportunity: { id: 'opp-web' } });
    return Response.json({});
  });
  return { notes, relays };
}
const LEAD_ENV = { ...HL, HIGHLEVEL_PIPELINE_ID: 'pipe-1', WEBSITE_LEAD_HOOK_URL: 'https://hooks.example.test/lead', FIREBASE_API_KEY: 'firebase-test-sales-booking', HUB_SESSION_SECRET: 'synthetic-sales-booking-session-secret-0123456789' };
const SLOTS_ON = { EGC_BOOKING_EXPLICIT_SLOTS: 'true' };
const submit = (handler, env, body) => handler.post({ env, request: new Request(`${ORIGIN}/api/web-lead`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
const websiteLead = overrides => ({ name: 'Synthetic Walkthrough', phone: '(970) 555-0101', email: 'walkthrough@example.invalid', service_type: 'Garage Cleanout', city: 'Fort Collins', serviceZip: '80525',
  flow_type: 'walkthrough', sms_consent: 'yes', source: 'Website', page_url: 'https://easygaragecleaning.com/book', inquiry_id: randomUUID(), ...overrides });

test('flag on: web-lead stores the explicit booking_slot date in the receipt and the HighLevel note; the Zapier relay keeps the customer\'s words', async t => {
  // Tuesday 2026-09-29 20:55 in Denver: "Tomorrow AM" is Wednesday 2026-09-30.
  const at = new Date('2026-09-30T02:55:00.000Z'), store = ledgerStore(), { notes, relays } = leadProviders(t);
  const env = { ...LEAD_ENV, ...SLOTS_ON, WEB_LEAD_RECEIPTS_ENABLED: 'true' }, body = websiteLead({ booking_slot: 'Tomorrow AM' });
  const response = await submit(webLeadHandlers({ storage: () => store, now: () => at }), env, body);
  assert.equal(response.status, 200, await response.clone().text());
  const receipt = store.commits[0].find(write => write.collection === WEB_LEAD_RECEIPTS).patch;
  const sealed = await openWebLead(env, body.inquiry_id, receipt.sealedPayload);
  assert.deepEqual([sealed.booking_slot, sealed.booking_slot_choice], ['2026-09-30 AM', 'Tomorrow AM'], 'the receipt keeps the date the customer meant, so a late retry cannot move it');
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /^Requested slot: 2026-09-30 AM \(chosen as "Tomorrow AM"\)$/m);
  assert.equal(relays.length, 1);
  assert.equal(relays[0].booking_slot, 'Tomorrow AM', 'the automatic text relay is byte-identical to before');
});

test('flag on: web-lead keeps an explicit window as sent, flags one that has started or falls on a closed day, and the legacy (no receipt) path writes the same explicit note', async t => {
  // Tuesday 2026-09-29 20:55 in Denver.
  const at = new Date('2026-09-30T02:55:00.000Z'), { notes, relays } = leadProviders(t);
  const synced = [];
  const handler = webLeadHandlers({ now: () => at, storage: () => assert.fail('no ledger without the flag'), sync: async (env, lead) => { synced.push(lead); const { syncHighLevelLead } = await import('../functions/_lib/web-lead-intake.js'); return syncHighLevelLead(env, lead); } });
  // A /book window, 'Today afternoon' from a page without booking-slots.js at 9 PM, a stale /book tab, a Sunday, and Flexible.
  for (const slot of ['2026-10-01 PM', 'Today PM', '2026-09-29 AM', '2026-10-04 AM', 'Flexible']) assert.equal((await submit(handler, { ...LEAD_ENV, ...SLOTS_ON }, websiteLead({ booking_slot: slot }))).status, 200, slot);
  assert.deepEqual(synced.map(lead => [lead.booking_slot, lead.booking_slot_choice, lead.booking_slot_problem]), [['2026-10-01 PM', undefined, undefined], ['2026-09-29 PM', 'Today PM', 'started'],
    ['2026-09-29 AM', undefined, 'started'], ['2026-10-04 AM', undefined, 'closed'], ['Flexible', undefined, undefined]]);
  assert.deepEqual(notes.map(note => /^Requested slot: (.*)$/m.exec(note.body)[1]), ['2026-10-01 PM', '2026-09-29 PM (chosen as "Today PM"; sent after this window had started)',
    '2026-09-29 AM (sent after this window had started)', '2026-10-04 AM (EGC is closed then)', 'Flexible']);
  // The relay feeds the automatic text-back: a dated window goes out in words, with the date beside it; anything else exactly as sent.
  assert.deepEqual(relays.map(relay => [relay.booking_slot, relay.booking_slot_date]), [['Thu, Oct 1 afternoon', '2026-10-01 PM'], ['Today PM', undefined], ['Today morning', '2026-09-29 AM'], ['Sun, Oct 4 morning', '2026-10-04 AM'], ['Flexible', undefined]]);
  assert.ok(relays.every(relay => !/\d{4}-\d{2}-\d{2}/.test(relay.booking_slot)), 'the text-back never quotes a raw YYYY-MM-DD window');
});

test('flag on: web-lead relays tomorrow\'s /book window as "Tomorrow morning" in the body and the query, with the ledger on', async t => {
  const at = new Date('2026-09-30T02:55:00.000Z'), store = ledgerStore(), queries = [], { notes, relays } = leadProviders(t);
  const fetcher = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input, options) => { if (String(input).startsWith('https://hooks.example.test/lead')) queries.push(new URL(input).searchParams); return fetcher(input, options); });
  const env = { ...LEAD_ENV, ...SLOTS_ON, WEB_LEAD_RECEIPTS_ENABLED: 'true' }, body = websiteLead({ booking_slot: '2026-09-30 AM' });
  assert.equal((await submit(webLeadHandlers({ storage: () => store, now: () => at }), env, body)).status, 200);
  const sealed = await openWebLead(env, body.inquiry_id, store.commits[0].find(write => write.collection === WEB_LEAD_RECEIPTS).patch.sealedPayload);
  assert.deepEqual([sealed.booking_slot, sealed.booking_slot_choice, sealed.booking_slot_problem], ['2026-09-30 AM', undefined, undefined]);
  assert.match(notes[0].body, /^Requested slot: 2026-09-30 AM$/m);
  assert.deepEqual([relays.length, relays[0].booking_slot, relays[0].booking_slot_date], [1, 'Tomorrow morning', '2026-09-30 AM']);
  assert.deepEqual([queries[0].get('booking_slot'), queries[0].get('booking_slot_date')], ['Tomorrow morning', '2026-09-30 AM']);
});

// The Hub shell: navigation by the server's capabilities, the lead card and the HighLevel status wording.
const SALES_CAPS = ['customer.send', 'followups.own', 'quotes.author', 'schedule.book', 'walkthrough.perform'];
const PHONE_CAPS = ['customer.send', 'followups.own', 'schedule.book'];
const MANAGER_CAPS = ['dispatch.write', 'time.approve', 'accounts.approve', 'customer.send', 'followups.own', 'quotes.author', 'schedule.book', 'walkthrough.perform'];
const EMPLOYEE_VIEWS = ['my_day', 'my_shifts', 'open_shifts', 'earnings', 'crew_chat', 'availability', 'requests', 'training', 'safety', 'onboarding', 'crew_alerts'];
// Recorded from the suite before SALES-BOOKING (merge base b04a617) with tests/helpers/hub-dom.mjs.
const BASE_NAV = {
  owner: [...EMPLOYEE_VIEWS, 'today', 'action_center', 'schedule', 'timesheets', 'people', 'walkthroughs', 'delivery', 'dispatch_rules', 'reviews', 'staff', 'customers', 'finance', 'communications', 'invoicing', 'pipeline', 'scorecard', 'proof', 'playbook', 'ad_spend', 'settings', 'followup_settings', 'catalog', 'message_templates', 'stocked_costs'],
  manager: [...EMPLOYEE_VIEWS, 'today', 'action_center', 'schedule', 'timesheets', 'people', 'walkthroughs', 'delivery', 'reviews', 'staff', 'customers', 'finance', 'communications', 'invoicing', 'pipeline', 'scorecard', 'proof', 'playbook', 'settings', 'message_templates', 'stocked_costs'],
  employee: EMPLOYEE_VIEWS,
};
const PROFILES = {
  owner: [{}, 'owner'], manager: [{ user: 'AlexK', business: true, role: 'manager' }, 'manager'], crew: [{ user: 'Synthetic.Crew', business: false, role: 'crew' }, 'employee'],
  sales: [{ user: 'Synthetic.Sales', business: false, role: 'sales', caps: SALES_CAPS }, 'employee'], phone: [{ user: 'Synthetic.Phone', business: false, role: 'phone', caps: PHONE_CAPS }, 'employee'],
  storedManager: [{ user: 'Synthetic.Manager', business: true, role: 'manager', caps: MANAGER_CAPS }, 'manager'], narrowedBusiness: [{ user: 'TylerG', business: true, role: 'manager', caps: SALES_CAPS }, 'employee'],
  crewRoles: [{ user: 'Synthetic.Crew', business: false, role: 'crew', caps: [] }, 'employee'],
};
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
function shell(profile, { roleAccess = false, fetcher, before } = {}) {
  return hubPage({ ...profile, fetcher, before: context => {
    if (profile.caps) { context.sessionStorage.setItem('egc_capabilities', JSON.stringify(profile.caps)); context.sessionStorage.setItem('egc_capability_mode', 'staff_roles'); }
    if (roleAccess) context.sessionStorage.setItem('egc_role_access', 'true');
    before?.(context);
  } });
}
const views = page => Array.from(page.api.visibleNav(), item => item[1]);
// (SALES-BOOKING after MOBILE-HUB) MOBILE-HUB deliberately lists RUN THE BUSINESS first for business users. The recorded base
// order is kept within each part: the business group's views first, then every other view, each in the recorded order.
const businessFirst = (page, ids) => {
  const group = new Map(Array.from(page.api.visibleNav(), item => [item[1], item[0]])), business = id => group.get(id) === 'RUN THE BUSINESS';
  return Array.from(page.api.hubCapabilities()).includes('business') ? [...ids.filter(business), ...ids.filter(id => !business(id))] : ids;
};
const baseNav = (page, base) => businessFirst(page, BASE_NAV[base]);

test('with EGC_STAFF_ROLE_ACCESS off (no roleAccess from /api/hub-auth), navigation is identical to before for every kind of account', () => {
  for (const [name, [profile, base]] of Object.entries(PROFILES)) { const page = shell(profile); assert.deepEqual(views(page), baseNav(page, base), name); }
});

test('with roleAccess, Sales and Phone see leads, walkthroughs, the team schedule and the Action Center, as their server capabilities allow', () => {
  const booker = [...EMPLOYEE_VIEWS, 'action_center', 'schedule', 'walkthroughs', 'pipeline'];
  for (const name of ['sales', 'phone']) {
    const page = shell(PROFILES[name][0], { roleAccess: true });
    assert.deepEqual(views(page), booker, name);
    for (const view of ['today', 'customers', 'finance', 'timesheets', 'people', 'delivery', 'communications', 'staff']) assert.equal(page.api.canView(view), false, `${name} ${view}`);
    assert.deepEqual(Array.from(page.api.hubCapabilities()), ['crew'], 'business screens stay closed');
  }
  // The Action Center follows followups.own alone; the booking views follow schedule.book alone.
  assert.deepEqual(views(shell({ user: 'Synthetic.Follow', business: false, role: 'sales', caps: ['followups.own'] }, { roleAccess: true })), [...EMPLOYEE_VIEWS, 'action_center']);
  assert.deepEqual(views(shell({ user: 'Synthetic.Book', business: false, role: 'phone', caps: ['schedule.book'] }, { roleAccess: true })), [...EMPLOYEE_VIEWS, 'schedule', 'walkthroughs', 'pipeline']);
  // A crew account, a manager and the owner are exactly as they were.
  for (const name of ['crew', 'crewRoles', 'owner', 'manager', 'storedManager']) { const page = shell(PROFILES[name][0], { roleAccess: true }); assert.deepEqual(views(page), baseNav(page, PROFILES[name][1]), name); }
  // A deep link opens a booker's view; one they cannot open lands on My day.
  for (const [search, active] of [['?view=action_center', 'action_center'], ['?view=pipeline', 'pipeline'], ['?view=finance', 'my_day']]) {
    const page = shell(PROFILES.phone[0], { roleAccess: true, before: context => { context.location.search = search; context.location.href += search; } });
    page.api.install();
    assert.equal(page.api.S.active, active, search);
  }
});

const feed = (overrides = {}) => ({ ok: true, projection: 'booker', locationId: 'location-synthetic', leadResetAt: '2026-09-03T00:00:00.000Z', pipelines: [{ id: 'pipe-1', stages: [{ id: 'stage-1', name: 'New lead' }] }],
  opportunities: [{ id: 'opp-1', name: 'Synthetic Lead — Garage cleanout', status: 'open', source: 'Website', pipelineStageId: 'stage-1', contactId: 'contact-1', contact: { id: 'contact-1', name: 'Synthetic Lead', phone: '(970) 555-0111', email: 'synthetic.lead@example.invalid' } }], ...overrides });
function bookerShell(highLevelAnswer, { dispatch = [], roleAccess = true, profile = PROFILES.phone[0] } = {}) {
  const fetcher = async url => {
    if (url.startsWith('/api/highlevel?view=command')) return highLevelAnswer(url);
    if (url.startsWith('/api/highlevel?view=lead')) return json({ ok: true, locationId: 'location-synthetic', notesRead: true, lead: { contactId: 'contact-1', name: 'Synthetic Lead', phone: '(970) 555-0111', email: 'synthetic.lead@example.invalid',
      address: '123 Synthetic Way, Fort Collins, CO', service: 'Garage Cleanout', requestedSlot: { date: '2026-09-24', window: 'PM' }, requestedSlotText: '2026-09-24 PM' } });
    if (url.startsWith('/api/employee-hub')) return json({ ok: true, collections: {}, accounts: [] });
    if (url.startsWith('/api/integration-status')) return json({ ok: true, status: { highlevel: true } });
    return json({ ok: false, error: 'Synthetic service unavailable' }, 503);
  };
  const page = shell(profile, { roleAccess, fetcher, before: context => {
    context.EGCDispatch = { mount() {}, unmount() {}, refresh() {}, canLeave: () => true, book: detail => dispatch.push(structuredClone(detail)) };
  } });
  page.api.S.peopleState.loaded = true;
  return page;
}

test('the lead card calls the lead, opens their HighLevel contact and books the walkthrough; there is no sms: link and no value for a booker', async () => {
  const booked = [], page = bookerShell(() => json(feed()), { dispatch: booked });
  page.api.install();
  await page.flush();
  page.api.go('pipeline');
  await page.flush();
  const card = page.main().querySelector('.ops-pipeline article'), links = card.querySelectorAll('a');
  assert.deepEqual(links.map(link => [link.textContent, link.getAttribute('href')]), [['Call', 'tel:+19705550111'], ['Open in HighLevel', 'https://app.gohighlevel.com/v2/location/location-synthetic/contacts/detail/contact-1']]);
  assert.equal(links[1].getAttribute('target'), '_blank');
  assert.equal(links[1].getAttribute('rel'), 'noopener');
  assert.doesNotMatch(page.main().innerHTML, /sms:/, 'customer texts stay in HighLevel');
  assert.doesNotMatch(card.textContent, /\$/, 'a booker sees no opportunity value');
  const book = card.querySelector('[data-ops-book-lead]');
  assert.equal(book.textContent, 'Book walkthrough');
  page.document.dispatch({ type: 'click', target: book, preventDefault() {} });
  await page.flush();
  assert.equal(page.api.S.active, 'schedule');
  assert.deepEqual(booked, [{ kind: 'walkthrough', name: 'Synthetic Lead', phone: '(970) 555-0111', email: 'synthetic.lead@example.invalid', highlevelContactId: 'contact-1', address: '123 Synthetic Way, Fort Collins, CO',
    service: 'Garage Cleanout', requestedSlot: { date: '2026-09-24', window: 'PM' }, requestedSlotText: '2026-09-24 PM' }]);
  assert.deepEqual(page.calls.filter(call => call.url.startsWith('/api/highlevel?view=lead')).map(call => call.url), ['/api/highlevel?view=lead&contactId=contact-1']);
});

test('an unusable contact id or location builds no HighLevel link; a missing phone builds no Call', async () => {
  const page = bookerShell(() => json(feed({ locationId: 'bad location', opportunities: [{ id: 'opp-2', status: 'open', pipelineStageId: 'stage-1', contactId: 'contact/../x', contact: { name: 'Synthetic No Phone', email: 'x@example.invalid' } }] })));
  page.api.install();
  await page.flush();
  page.api.go('pipeline');
  await page.flush();
  const card = page.main().querySelector('.ops-pipeline article');
  assert.deepEqual(card.querySelectorAll('a').map(link => link.textContent), []);
  assert.equal(card.querySelector('[data-ops-book-lead]').textContent, 'Book walkthrough');
});

test('HighLevel status wording: not configured, an outage with the time it failed (retried every minute), and no silent zero', async () => {
  let answer = () => json({ ok: false, code: 'HIGHLEVEL_NOT_CONFIGURED', error: 'HighLevel needs an API key and location ID' }, 501);
  const page = bookerShell(url => answer(url));
  page.api.install();
  await page.flush();
  page.api.go('pipeline');
  await page.flush();
  assert.match(page.main().textContent, /Add a HighLevel private-integration token and location ID/);
  answer = () => json({ ok: false, error: 'HighLevel is unreachable' }, 502);
  await page.api.loadGhl();
  const text = page.main().textContent;
  assert.match(text, /HighLevel unavailable, retrying/);
  assert.match(text, /could not be loaded at 12:00 PM\. The Hub tries again every minute/, 'the failed load is timed in Denver (18:00Z is noon)');
  assert.doesNotMatch(text, /private-integration token|New leads: 0/);
  assert.ok(page.main().querySelector('[data-ops-lead-retry]'));
  answer = () => json(feed());
  page.document.dispatch({ type: 'click', target: page.main().querySelector('[data-ops-lead-retry]'), preventDefault() {} });
  await page.flush();
  assert.match(page.main().textContent, /Synthetic Lead/);
  answer = () => json({ ok: false, code: 'BUSINESS_ACCESS_REQUIRED', error: 'Business access is required' }, 403);
  await page.api.loadGhl();
  assert.match(page.main().textContent, /The lead feed is not open to this account/);
});

test('a failed HighLevel contact search in the booking form says so instead of showing no results', async () => {
  let answer = () => json({ ok: false, error: 'HighLevel is unreachable' }, 502);
  const page = hubPage({ fetcher: async url => url.startsWith('/api/highlevel?view=contacts') ? answer() : json({ ok: false, error: 'Synthetic service unavailable' }, 503) });
  page.api.S.peopleState.loaded = true;
  page.api.install();
  await page.flush();
  page.timers.length = 0;
  page.context.opsOpenBooking('2026-09-22');
  page.context.opsLookupContacts('synthetic');
  await page.runTimers();
  assert.equal(page.document.querySelector('.ops-contact-error').textContent, 'HighLevel search unavailable. Check HighLevel before creating a new contact.');
  assert.equal(page.document.querySelector('.ops-contact-error').getAttribute('role'), 'alert');
  answer = () => json({ ok: true, contacts: [{ id: 'contact-1', name: 'Synthetic Customer', phone: '9705550100' }] });
  page.context.opsLookupContacts('synthetic c');
  await page.runTimers();
  assert.equal(page.document.querySelector('.ops-contact-error'), null);
  assert.match(page.document.querySelector('.ops-contact-results').textContent, /Synthetic Customer/);
});

test('an action\'s Book opens dispatch with its customer and kind for anyone who can schedule, and does nothing otherwise', async () => {
  const booked = [], page = bookerShell(() => json(feed()), { dispatch: booked });
  page.api.install();
  await page.flush();
  const detail = { kind: 'job', customerId: 'customer-1', name: 'Synthetic Customer', phone: '9705550100', address: '100 Synthetic Lane' };
  for (const listener of page.events['egc:book'] || []) listener({ type: 'egc:book', detail });
  assert.equal(page.api.S.active, 'schedule');
  assert.deepEqual(booked, [detail]);
  const crewBooked = [], crew = bookerShell(() => json(feed()), { dispatch: crewBooked, profile: PROFILES.crew[0] });
  crew.api.install();
  await crew.flush();
  for (const listener of crew.events['egc:book'] || []) listener({ type: 'egc:book', detail });
  assert.deepEqual([crew.api.S.active, crewBooked], ['my_day', []]);
});

// employee-dispatch.js in a vm realm on the small DOM, with its own fixed clock and a routed /api/dispatch.
const BOARD = { ok: true, viewer: { id: 'Synthetic.Phone', booker: true }, timeZone: 'America/Denver', jobs: [], roster: [], crews: [], vehicles: [], availability: [], warnings: [], coverage: { complete: true, asOf: NOW } };
const NOON = '2026-09-22T18:00:00.000Z';
function dispatchPage({ now = NOON } = {}) {
  const document = createDocument(), intervals = [], clock = { now: Date.parse(now) }, page = { answer: () => json(BOARD), requests: 0 };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return clock.now; } }
  Object.defineProperty(document.Element.prototype, 'parentElement', { configurable: true, get() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; } });
  Object.assign(document.Element.prototype, {
    prepend(...nodes) { const first = this.childNodes[0] || null; for (const node of nodes) this.insertBefore(node, first); },
    showModal() { this.open = true; }, close() { this.open = false; }, getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0 }),
  });
  const context = { console, URL, URLSearchParams, Intl, Promise, Set, Map, Error, JSON, Object, Array, Math, AbortController, structuredClone, crypto, queueMicrotask,
    Date: Clock, Node: document.Node, document, sessionStorage: storage(), Event: class { constructor(type) { this.type = type; } },
    setTimeout: () => 0, clearTimeout() {}, setInterval: callback => intervals.push(callback), clearInterval() {}, addEventListener() {},
    fetch: async url => { assert.match(url, /^\/api\/dispatch\?/); page.requests++; return page.answer(); } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../employee-dispatch.js', import.meta.url), 'utf8').replace(/\}\)\(\);\s*$/, 'window.__sales={S,requestedWindow};})();'), context, { filename: 'employee-dispatch.js' });
  const host = document.createElement('main');
  document.body.append(host);
  const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
  const dialog = () => document.querySelector('dialog');
  const value = name => dialog().querySelectorAll('input').find(input => input.name === name)?.value;
  return Object.assign(page, { document, host, intervals, clock, flush, dialog, value, dispatch: context.EGCDispatch, internals: context.__sales, context });
}
const LEAD_BOOK = { kind: 'walkthrough', name: 'Synthetic Lead', phone: '(970) 555-0111', highlevelContactId: 'contact-1' };

test('Book walkthrough judges the requested window by the Denver clock: a same-day window that has passed or started is not prefilled', async () => {
  // Tuesday 2026-09-22 at noon in Denver (18:00Z): this morning has passed and this afternoon has started.
  const cases = [
    [{ date: '2026-09-22', window: 'AM' }, 'The customer asked for Tue, Sep 22 morning, which has passed. Agree a new time with them.', null],
    [{ date: '2026-09-22', window: 'PM' }, 'The customer asked for Tue, Sep 22 afternoon, which has already started. Agree a time with them.', null],
    [{ date: '2026-09-21', window: 'PM' }, 'The customer asked for Mon, Sep 21 afternoon, which has passed. Agree a new time with them.', null],
    [{ date: '2026-09-27', window: 'AM', closed: true }, 'The customer asked for Sun, Sep 27 morning, when EGC is closed. Agree a new time with them.', null],
    [{ date: '2026-09-23', window: 'AM' }, 'The customer asked for Wed, Sep 23 morning. Confirm the exact time with them.', ['2026-09-23', '09:00', '10:00']],
  ];
  for (const [requestedSlot, said, prefilled] of cases) {
    const page = dispatchPage();
    page.dispatch.mount(page.host);
    await page.flush();
    page.dispatch.book({ ...LEAD_BOOK, requestedSlot });
    await page.flush();
    assert.ok(page.dialog()?.open, JSON.stringify(requestedSlot));
    assert.ok(page.dialog().textContent.includes(said), `${JSON.stringify(requestedSlot)}: ${page.dialog().textContent.slice(0, 200)}`);
    const times = [page.value('date'), page.value('time'), page.value('endTime')];
    if (prefilled) assert.deepEqual(times, prefilled);
    else assert.deepEqual(times, ['2026-09-22', '08:00', '10:00'], 'the plain Create job defaults (the board day), not the requested hour');
  }
  // 08:30 in Denver is 14:30Z: the morning has started (read as UTC it would already be over), the afternoon is ahead.
  const early = dispatchPage({ now: '2026-09-22T14:30:00.000Z' }), window = slot => JSON.parse(JSON.stringify(early.internals.requestedWindow(slot)));
  assert.equal(window({ date: '2026-09-22', window: 'AM' }).state, 'started');
  assert.deepEqual(window({ date: '2026-09-22', window: 'PM' }), { date: '2026-09-22', time: '13:00', endTime: '14:00', label: 'Tue, Sep 22 afternoon', state: '' });
  // 20:55 on Tuesday in Denver is Wednesday in UTC: Wednesday morning is still ahead, Tuesday afternoon has passed.
  early.clock.now = Date.parse('2026-09-23T02:55:00.000Z');
  assert.deepEqual([window({ date: '2026-09-23', window: 'AM' }).state, window({ date: '2026-09-22', window: 'PM' }).state], ['', 'passed']);
  for (const bad of [null, {}, { date: '2026-09-23', window: 'EVENING' }, { date: 'soon', window: 'AM' }]) assert.equal(early.internals.requestedWindow(bad), null);
});

test('a Book that arrives while the board cannot load is dropped with a notice, so a later refresh never opens it unprompted', async () => {
  const page = dispatchPage();
  let release;
  page.answer = () => new Promise(resolve => { release = () => resolve(json({ ok: false, error: 'Synthetic dispatch outage' }, 503)); });
  page.dispatch.mount(page.host);
  await page.flush();
  // Book while the first load is still in flight; that load then fails.
  page.dispatch.book({ ...LEAD_BOOK, requestedSlot: { date: '2026-09-23', window: 'AM' } });
  await page.flush();
  assert.ok(page.internals.S.pendingBook, 'kept only until this load completes');
  release();
  await page.flush();
  assert.equal(page.internals.S.pendingBook, null);
  assert.match(page.host.textContent, /Synthetic dispatch outage The booking form did not open: book again once the schedule loads\./);
  assert.equal(page.dialog(), null);
  // The minute refresh then succeeds: the board shows, and no Create job pops open.
  page.answer = () => json(BOARD);
  await page.intervals[0]();
  await page.flush();
  assert.equal(page.internals.S.error, '');
  assert.equal(page.dialog(), null);
  // Booking again now opens at once.
  page.dispatch.book({ ...LEAD_BOOK, requestedSlot: { date: '2026-09-23', window: 'AM' } });
  await page.flush();
  assert.ok(page.dialog()?.open);
  assert.equal(page.value('time'), '09:00');
});

test('a Book on a board that already failed loads it now: a success opens the form, another failure drops the Book', async () => {
  const page = dispatchPage();
  page.answer = () => json({ ok: false, error: 'Synthetic dispatch outage' }, 503);
  page.dispatch.mount(page.host);
  await page.flush();
  const before = page.requests;
  page.answer = () => json(BOARD);
  page.dispatch.book({ ...LEAD_BOOK, requestedSlot: { date: '2026-09-23', window: 'PM' } });
  await page.flush();
  assert.equal(page.requests, before + 1, 'Book retried the board instead of waiting a minute for the refresh');
  assert.ok(page.dialog()?.open);
  assert.equal(page.value('time'), '13:00');
  const failing = dispatchPage();
  failing.answer = () => json({ ok: false, error: 'Synthetic dispatch outage' }, 503);
  failing.dispatch.mount(failing.host);
  await failing.flush();
  failing.dispatch.book(LEAD_BOOK);
  await failing.flush();
  assert.equal(failing.internals.S.pendingBook, null);
  failing.answer = () => json(BOARD);
  await failing.intervals[0]();
  await failing.flush();
  assert.equal(failing.dialog(), null);
});
