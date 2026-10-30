// OFFICE (owner request 2026-10-30, "an office role to book photo-only removal"): the office staff role
// (functions/_lib/staff-roles.js), its removal-only photo quotes (functions/_lib/office-quotes.js, quote-permissions.js
// officeQuoteSession, /api/quote-draft) and its booking right, which needs EGC_STAFF_ROLE_PERMISSIONS (a launch default)
// and not EGC_STAFF_ROLE_ACCESS. Synthetic data only; every clock and id is injected; no test reaches another host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCESS_CAPABILITIES, OWNER_CAPABILITIES, ROLE_CAPABILITIES, can, capabilityMode, officeRole, staffCapabilities } from '../functions/_lib/staff-roles.js';
import { officeQuoteActor, officeQuoteSession, quoteAuthorAccess, requireCustomerResolver } from '../functions/_lib/quote-permissions.js';
import { officeQuoteJob } from '../functions/_lib/office-quotes.js';
import { applyLaunchDefaults } from '../functions/_lib/launch-defaults.js';
import { menuPrices, priceCompositeQuote } from '../functions/_lib/composite-quote.js';
import { PICKUP_MINIMUM_CENTS, PICKUP_MINIMUM_LINE_ID } from '../functions/_lib/pickup-minimum.js';
import { SENT_25_75 } from '../functions/_lib/quote-payment-policy.js';
import { saveQuoteDraft } from '../functions/_lib/quote-draft.js';
import { quoteDraftHandlers } from '../functions/api/quote-draft.js';
import { dispatchHandlers } from '../functions/api/dispatch.js';
import { customerResolveHandler } from '../functions/api/customer-resolve.js';
import { handoffHandlers } from '../functions/api/walkthrough-handoff.js';
import * as hubAuth from '../functions/api/hub-auth.js';
import { PROBES, staffSessions } from './helpers/auth-roles-harness.mjs';
import { ORIGIN, login, seedAccount, staffEnv, vaultFirestore, cookieFor } from './helpers/vault-fixture.mjs';
import { MON, NOW, ON_ENV, builderState, client, estimator, fixture, menuItem, owner, selection } from './helpers/estimator-fixture.mjs';
import { hubPage } from './helpers/hub-dom.mjs';

const PERMISSIONS = { EGC_STAFF_ROLE_PERMISSIONS: 'true' }, ACCESS = { EGC_STAFF_ROLE_ACCESS: 'true' };
const employee = (staffRoles, extra = {}) => ({ user: 'Office.Person', displayName: 'Synthetic Office', role: 'crew', businessAccess: false, source: 'employee-account', ...(staffRoles ? { staffRoles } : {}), ...extra });
const office = employee(['office']);
// Every capability the office role must never hold: dispatch, payroll, pay, money, staff admin, owner settings, MCP,
// business accounts, the walkthrough and walkthrough quotes, follow-up ownership and every crew's schedule.
const NEVER = ['dispatch.write', 'time.approve', ...OWNER_CAPABILITIES, 'followups.own', 'quotes.author', 'mcp.write', 'b2b.manage', 'walkthrough.perform', 'schedule.view'];

test('the office role: customer messages, removal quotes and booking with the launch defaults, and nothing that touches pay, money or staff', () => {
  assert.deepEqual(ROLE_CAPABILITIES.office, ['customer.send', 'quotes.removal']);
  const launch = applyLaunchDefaults({});
  assert.equal(launch.EGC_STAFF_ROLE_ACCESS, undefined, 'role access stays off by default');
  for (const flags of [launch, PERMISSIONS, ACCESS, { ...ACCESS, ...PERMISSIONS }]) {
    const at = JSON.stringify(flags);
    assert.equal(capabilityMode(office, flags), 'staff_roles', at);
    assert.equal(officeRole(office, flags), true, at);
    assert.deepEqual(staffCapabilities(office, flags), ['customer.send', 'quotes.removal', 'schedule.book'], at);
    for (const capability of NEVER) assert.equal(can(office, capability, flags), false, `${capability} ${at}`);
    // A person who is office and crew keeps both; the office part never adds a manager's rights.
    assert.deepEqual(staffCapabilities(employee(['crew', 'office']), flags), ['customer.send', 'quotes.removal', 'schedule.book'], at);
  }
  // With both role switches off the stored role acts on nothing (the account is crew, as before).
  assert.equal(capabilityMode(office, {}), 'legacy');
  assert.deepEqual(staffCapabilities(office, {}), []);
  assert.equal(officeRole(office, {}), false);
});

test('booking without EGC_STAFF_ROLE_ACCESS is the office role\'s alone: Sales, Phone and everyone else are unchanged', () => {
  for (const flags of [{}, PERMISSIONS, applyLaunchDefaults({})]) {
    for (const roles of [['sales'], ['phone'], ['manager'], ['team_lead'], ['crew_lead'], ['crew'], [], undefined]) {
      for (const capability of ACCESS_CAPABILITIES) assert.equal(can(employee(roles), capability, flags), false, `${JSON.stringify(roles)} ${capability} ${JSON.stringify(flags)}`);
      assert.ok(!staffCapabilities(employee(roles), flags).includes('schedule.book'), `${JSON.stringify(roles)} lists no booking`);
      assert.ok(!staffCapabilities(employee(roles), flags).includes('quotes.removal') || roles?.includes('manager'), `${JSON.stringify(roles)} quotes.removal`);
    }
    for (const configured of [{ user: 'ZacB', role: 'owner', businessAccess: true }, { user: 'TylerG', role: 'manager', businessAccess: true }]) assert.equal(can(configured, 'schedule.book', flags), false);
  }
  // A claimed account role is not a stored role.
  assert.equal(can({ ...employee(), role: 'office' }, 'schedule.book', PERMISSIONS), false);
  // Legacy business users: a dispatcher holds quotes.removal (the Photo quote screen); business access alone does not.
  assert.equal(can({ user: 'TylerG', role: 'manager', businessAccess: true }, 'quotes.removal', {}), true);
  assert.equal(can({ user: 'AlexK', role: 'crew_lead', businessAccess: true }, 'quotes.removal', {}), false);
});

test('only /api/quote-draft makes an office session a quote author, and only a removal-only one; every other author check refuses it', () => {
  for (const flags of [PERMISSIONS, ACCESS]) {
    assert.deepEqual(quoteAuthorAccess(office, flags), { dispatcher: false, author: false }, 'the role is not a quote author');
    const marked = officeQuoteSession(office, flags);
    assert.notEqual(marked, office);
    assert.equal(officeQuoteActor(marked), true);
    assert.deepEqual(quoteAuthorAccess(marked, flags), { dispatcher: false, author: true, removalOnly: true });
    // A browser cannot send the marker: a JSON copy, a structured clone or a hand-made field is an ordinary session.
    for (const forged of [JSON.parse(JSON.stringify(marked)), structuredClone(marked), { ...office, officeQuote: true }]) assert.equal(officeQuoteActor(forged), false);
    // A quote author keeps their own session (and full authorship); anyone without quotes.removal gets nothing.
    for (const session of [employee(['sales']), employee(['manager']), employee(['phone']), employee(['crew']), null]) assert.equal(officeQuoteSession(session, flags), session);
    assert.deepEqual(requireCustomerResolver(office, flags), { dispatcher: false, author: false }, 'office finds customers as a booker (masked, like Phone)');
  }
  assert.throws(() => requireCustomerResolver(office, {}), { code: 'quote_forbidden' }, 'with the role switches off the office role is crew');
});

// --- real signed sessions --------------------------------------------------------------------------------------------
const OFFICE_USERS = { 'Config.Office': { passwordHash: 'unused-synthetic-office-hash', role: 'crew', displayName: 'Synthetic Config Office', staffRoles: ['office'] } };
const get = (cookie, path) => new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie } });
const body = async response => ({ status: response.status, body: await response.json() });

test('/api/hub-auth: the office account reports its capabilities and gates on them alone; every other account is as before', async t => {
  const { env: base, cookies } = await staffSessions(t, {}, OFFICE_USERS);
  await seedAccount(base, 'Office.Account', { extra: { staffRoles: ['office'] } });
  cookies['Office.Account'] = (await login(base, 'Office.Account')).cookie;
  const env = applyLaunchDefaults({ ...base });
  for (const user of ['Config.Office', 'Office.Account']) {
    const { body: profile } = await body(await hubAuth.onRequestGet({ request: get(cookies[user], '/api/hub-auth'), env }));
    assert.deepEqual([profile.capabilities, profile.capabilityMode, profile.roleAccess, profile.businessAccess, profile.owner], [['customer.send', 'quotes.removal', 'schedule.book'], 'staff_roles', true, false, false], user);
  }
  for (const user of ['Phone.Account', 'Sales.Account', 'Mgr.Account', 'Crew.Account', 'TylerG', 'ZacB']) {
    const { body: profile } = await body(await hubAuth.onRequestGet({ request: get(cookies[user], '/api/hub-auth'), env }));
    assert.equal(profile.roleAccess, undefined, `${user}: no roleAccess with EGC_STAFF_ROLE_ACCESS off`);
    assert.ok(!profile.capabilities.includes('schedule.book'), `${user} does not book with role access off`);
  }
});

// Every endpoint the role model governs (tests/helpers/auth-roles-harness.mjs), for the office account: with the launch
// defaults and with role access on, it reads and books the schedule like a Phone booker, resolves customers, reads only
// its own staff record, and is refused (403) crew assignment, blocks, crews, payroll, the Action Center, the
// walkthrough, money and every role change.
const ALLOWED = new Set(['hub-auth GET', 'staff-roles GET', 'dispatch GET board', 'dispatch GET customers', 'dispatch-openings GET', 'dispatch-search GET', 'dispatch-travel GET',
  'dispatch POST walkthrough', 'dispatch POST job', 'dispatch POST reschedule', 'dispatch POST cancel', 'customer-resolve POST', 'walkthrough-visit viewer', 'walkthrough-visit state', 'walkthrough-visit no_show', 'staff-directory GET']);
test('the governed endpoints decide exactly what the office account is told it may do, with and without role access', async t => {
  const { env: base, cookies } = await staffSessions(t, {}, OFFICE_USERS);
  for (const flags of [applyLaunchDefaults({}), PERMISSIONS, ACCESS]) {
    const env = { ...base, ...flags, EGC_DISPATCH_CREW_AUTO_ASSIGN: 'false' };
    for (const [label, run] of PROBES) {
      if (label === 'staff-directory POST set_roles replay') continue;
      const response = await run(cookies['Config.Office'], env), answer = await response.clone().json(), allowed = ALLOWED.has(label);
      assert.equal(response.status === 200, allowed, `${label} ${JSON.stringify(flags)}: ${response.status} ${JSON.stringify(answer).slice(0, 240)}`);
      if (!allowed) assert.equal(response.status, 403, `${label} is refused, not failed`);
    }
    // Its own staff record only: no one else's pay or roles.
    const own = await (await PROBES.find(([label]) => label === 'staff-directory GET')[1](cookies['Config.Office'], env)).json();
    assert.deepEqual(own.people.map(person => person.username), ['Config.Office']);
  }
});

// Owner money, pay, commission administration, payroll, staff administration, owner economics, margins and costs, the
// audit log, invoicing and owner settings, called directly with the office account's signed session.
const REFUSED = [
  ['money', 'GET', '/api/money?jobId=job-1'], ['money', 'POST', '/api/money', { action: 'payment.record', requestId: '0b6f6c52-5a0d-4d2e-9a51-7d0e1c2a0099', jobId: 'job-1' }],
  ['invoice-batch', 'GET', '/api/invoice-batch'], ['invoice-batch', 'POST', '/api/invoice-batch', {}], ['stripe-reviews', 'GET', '/api/stripe-reviews'],
  ['owner-economics', 'GET', '/api/owner-economics'], ['owner-economics', 'POST', '/api/owner-economics', {}],
  ['job-actuals', 'GET', '/api/job-actuals'], ['job-actuals', 'POST', '/api/job-actuals', {}], ['job-costing', 'GET', '/api/job-costing?jobId=job-1'],
  ['job-labor-costs', 'GET', '/api/job-labor-costs?jobId=job-1'], ['job-labor-costs', 'POST', '/api/job-labor-costs', {}], ['standard-costs', 'GET', '/api/standard-costs'], ['standard-costs', 'POST', '/api/standard-costs', {}],
  ['timesheets', 'GET', '/api/timesheets?view=week&start=2026-10-26'], ['tip-allocation', 'GET', '/api/tip-allocation?jobId=job-1'], ['gusto-sync', 'GET', '/api/gusto-sync'],
  ['knock-admin', 'GET', '/api/knock-admin'], ['knock-admin', 'POST', '/api/knock-admin', {}],
  ['employee-accounts', 'GET', '/api/employee-accounts'], ['staff-directory', 'POST', '/api/staff-directory', { action: 'set_pay', requestId: '0b6f6c52-5a0d-4d2e-9a51-7d0e1c2a0098', username: 'Crew.Static', expectedRevision: '', effectiveFrom: '2026-11-01', hourlyRate: 40, payType: 'hourly' }],
  ['staff-directory', 'POST', '/api/staff-directory', { action: 'set_roles', requestId: '0b6f6c52-5a0d-4d2e-9a51-7d0e1c2a0097', username: 'Crew.Static', expectedRevision: '', staffRoles: ['manager'] }],
  ['hub-audit', 'GET', '/api/hub-audit'], ['catalog', 'GET', '/api/catalog'], ['catalog', 'POST', '/api/catalog', {}], ['dispatch-settings', 'GET', '/api/dispatch-settings'], ['dispatch-settings', 'POST', '/api/dispatch-settings', {}],
  ['crew-performance', 'GET', '/api/crew-performance'], ['open-quotes', 'GET', '/api/open-quotes'], ['held-jobs', 'POST', '/api/held-jobs', {}], ['job-signoff', 'GET', '/api/job-signoff'],
  ['operations-followup-settings', 'POST', '/api/operations-followup-settings', {}], ['portal-documents-admin', 'GET', '/api/portal-documents-admin'], ['operations', 'GET', '/api/operations'],
  ['walkthrough-handoff', 'GET', '/api/walkthrough-handoff'],
];
test('owner money, pay, commission administration, payroll, staff administration, owner economics, costs and the audit log refuse the office account', async t => {
  // (My commission, /api/estimator-commission, is every employee's own 7% and reads only the signed-in account's.)
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-30T15:00:00.000Z') });
  vaultFirestore(t);
  for (const flags of [applyLaunchDefaults({}), applyLaunchDefaults({ ...ACCESS })]) {
    const env = { ...staffEnv({ MONEY_API_ENABLED: 'true', ...flags }, OFFICE_USERS) }, cookie = await cookieFor(env, 'Config.Office');
    for (const [route, method, path, payload] of REFUSED) {
      const module = await import(`../functions/api/${route}.js`), handler = method === 'GET' ? module.onRequestGet || module.onRequest : module.onRequestPost || module.onRequest;
      const request = new Request(`${ORIGIN}${path}`, { method, headers: { Cookie: cookie, Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
      const response = await handler({ request, env, waitUntil() {}, params: {} });
      assert.ok([401, 403].includes(response.status), `${method} ${path} ${JSON.stringify(flags)}: ${response.status} ${(await response.text()).slice(0, 200)}`);
    }
  }
});

// --- the photo quote end to end --------------------------------------------------------------------------------------
const officeUser = { user: 'office.person', role: 'crew', businessAccess: false, displayName: 'Synthetic Office', source: 'employee-account', staffRoles: ['office'] };
// The owner's menu with every removal price approved (synthetic: the bundled menu's special items and access are drafts).
const approved = () => { const prices = {}; for (const [id, price] of menuPrices(builderState())) if (price.unitCents !== null) prices[id] = price.unitCents; return builderState(prices); };
const id = name => menuItem(name).id;
const removal = (items, extra = {}) => ({ ...selection({ removal: items, shelving: [], storage: [], labor: { manHours: null } }), ...extra });
let seq = 0;
const rid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const PHOTO_CUSTOMER = { name: 'Synthetic Photo Customer', phone: '9705550188', email: 'photo.customer@example.invalid', address: '500 Fixture Lane, Fort Collins, CO 80521' };
const client5 = { ...PHOTO_CUSTOMER, highlevel_contact_id: '' };

function office5(f, state, { actor = officeUser, env = ON_ENV } = {}) {
  const at = () => new Date(NOW), json = (path, method = 'GET', payload) => new Request(`${ORIGIN}${path}`, method === 'GET' ? {} : { method, headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const quotes = quoteDraftHandlers({ session: async () => actor, storage: () => f.store, now: at, compositeState: async () => state, stripe: () => null, delivery: () => ({ deliver: async () => ({ status: 'not_requested' }) }) });
  const dispatch = dispatchHandlers({ session: async () => actor, storage: () => f.store, now: at, ghlTags: () => {}, ghlMirror: async () => false });
  const resolve = customerResolveHandler({ session: async () => actor, storage: () => f.store, verifyContact: async () => { throw new Error('no CRM contact in this test'); } });
  return {
    get: async path => body(await quotes.get({ request: json(path), env })),
    post: async payload => body(await quotes.post({ request: json('/api/quote-draft', 'POST', payload), env })),
    dispatchGet: async path => body(await dispatch.get({ request: json(path), env })),
    dispatchPost: async payload => body(await dispatch.post({ request: json('/api/dispatch', 'POST', payload), env, waitUntil() {} })),
    resolve: async customer => body(await resolve({ request: json('/api/customer-resolve', 'POST', { requestId: rid(), customer: { highlevelContactId: '', email: '', ...customer } }), env })),
  };
}
const draftOf = (priced, extra = {}) => ({ client: client5, title: 'Junk removal', scope: 'Junk removal only.', line_items: priced.lineItems, valid_until: '2026-10-31', catalog_version: priced.menuVersion, composite_pricing: priced.compositePricing, ...extra });

test('photo quote end to end: the office finds the customer, prices removal only, saves on the sent-quote terms, books the day in Dispatch and sends', async () => {
  const f = fixture(), state = approved(), api = office5(f, state);
  // Customer: a new caller is added; the answer is masked (a booker, like Phone), and the id is the record's.
  const found = await api.resolve(PHOTO_CUSTOMER);
  assert.equal(found.status, 200, JSON.stringify(found.body));
  assert.deepEqual([found.body.created, found.body.customer.contactDetails, found.body.customer.phone], [true, 'masked', '(•••) •••-0188']);
  const customerId = found.body.customer.id;
  assert.equal(f.rows.get(`customers/${customerId}`).createdBy, 'office.person');
  // An existing customer by phone resolves to that record (no duplicate).
  assert.equal((await api.resolve({ name: client(2).name, phone: client(2).phone })).body.customer.id, 'c2');

  // The builder menu: sell prices only, no cost basis.
  const menu = await api.get('/api/quote-draft?view=builder');
  assert.equal(menu.status, 200);
  assert.equal(menu.body.viewer.internal, false);
  assert.doesNotMatch(JSON.stringify(menu.body), /retailPerPackCents|goodsMarkup|"internal":\{/);
  assert.deepEqual(menu.body.labor.haulingGroups, ['junk', 'special', 'access']);

  // Removal only: a half load, a sofa and a long carry (a truck on the job: junk-only, no Labor line).
  const chosen = removal([{ id: id('Half load'), quantity: 1 }, { id: id('Sofa / loveseat'), quantity: 1 }, { id: id('Long carry'), quantity: 1 }]);
  const preview = await api.post({ action: 'composite_preview', compositePricing: chosen });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.junkOnly, true);
  assert.equal(preview.body.lineItems.some(line => line.kind === 'labor'), false, 'junk-only: no Labor line');
  // Garage work is refused for the office: a cleaning base, shelving or storage.
  for (const refused of [removal([{ id: id('Two-car garage base'), quantity: 1 }, { id: id('Half load'), quantity: 1 }]), { ...selection(), labor: { manHours: null } }]) {
    const answer = await api.post({ action: 'composite_preview', compositePricing: refused });
    assert.deepEqual([answer.status, answer.body.code], [403, 'quote_draft_office_removal_only']);
  }

  // Save: the server's lines, no walkthrough, the sent-quote terms (25% on approval, 75% on the job day).
  const priced = priceCompositeQuote(state, chosen, { complete: true });
  const notes = { removeItems: 'Sofa by the side door ($70 on the menu), half a truck of boxes', accessNotes: 'Long carry from the back yard' };
  const saved = await api.post({ action: 'save', requestId: rid(), customerId, draft: draftOf(priced, { walkthrough_capture: notes }) });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const job = f.job(saved.body.job.id);
  assert.deepEqual([job.type, job.sourceWalkthroughId || '', job.status, job.date || '', job.serviceType], ['job', '', 'unscheduled', '', 'Junk removal']);
  assert.deepEqual(job.estimate.commercialPolicy, SENT_25_75);
  assert.deepEqual([job.estimate.amountCents, job.estimate.depositRequiredCents], [priced.totalCents, Math.round(priced.totalCents / 4)]);
  assert.equal(officeQuoteJob(job), true);
  // The crew's notes from the photos carry no price (crew-money.js).
  assert.equal(job.jobInstructions.accessNotes, notes.accessNotes);
  assert.doesNotMatch(job.jobInstructions.removeItems, /\$/);
  assert.match(job.jobInstructions.removeItems, /Sofa by the side door/);

  // Not sent before the job day is booked: the 75% is due that day.
  const early = await api.post({ action: 'send_preview', jobId: job.id, expectedRevision: job.revision });
  assert.deepEqual([early.status, early.body.code], [409, 'quote_draft_payment_dates_pending']);

  // Book: the office user is a Dispatch booker (crew auto-assign picks the crew); it cannot hand-pick people.
  const board = await api.dispatchGet('/api/dispatch?view=job&jobId=' + job.id);
  assert.equal(board.status, 200, JSON.stringify(board.body));
  assert.equal(board.body.viewer.booker, true);
  const crewPick = await api.dispatchPost({ action: 'schedule.update', requestId: rid(), jobId: job.id, expectedRevision: f.job(job.id).revision, changes: { date: MON, time: '09:30', endTime: '12:30', assignedCrew: ['c1a'] } });
  assert.deepEqual([crewPick.status, crewPick.body.code], [403, 'dispatch_forbidden']);
  const booked = await api.dispatchPost({ action: 'schedule.update', requestId: rid(), jobId: job.id, expectedRevision: f.job(job.id).revision, changes: { date: MON, time: '09:30', endTime: '12:30' } });
  assert.equal(booked.status, 200, JSON.stringify(booked.body));
  assert.deepEqual([f.job(job.id).date, f.job(job.id).time, f.job(job.id).crewId], [MON, '09:30', 'crew_one']);

  // Send: the preview names the terms; the send records the payment schedule (deposit on approval, rest on the job day).
  const sendPreview = await api.post({ action: 'send_preview', jobId: job.id, expectedRevision: f.job(job.id).revision });
  assert.equal(sendPreview.status, 200, JSON.stringify(sendPreview.body));
  const sent = await api.post({ action: 'send', requestId: rid(), jobId: job.id, expectedRevision: f.job(job.id).revision, confirmToken: sendPreview.body.confirmToken });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const after = f.job(job.id);
  assert.deepEqual([after.estimate.status, after.quoteStatus, after.estimate.sentBy], ['sent', 'sent', 'office.person']);
  assert.deepEqual([after.estimate.paymentSchedule.depositDueDate, after.estimate.paymentSchedule.remainderDueDate, after.estimate.paymentSchedule.depositCents + after.estimate.paymentSchedule.remainderCents], [null, MON, priced.totalCents]);
  assert.equal(after.estimate.paymentSchedule.sourceWalkthroughId, undefined);
  // And the office user can read the quote they sent.
  assert.equal((await api.get('/api/quote-draft?jobId=' + job.id)).status, 200);
});

test('a single sofa from photos keeps its Labor line and the $250 minimum; unapproved menu prices save but never send', async () => {
  const f = fixture(), api = office5(f, builderState());
  const sofa = removal([{ id: id('Sofa / loveseat'), quantity: 1 }]);
  const priced = priceCompositeQuote(builderState(), sofa, { complete: true });
  assert.equal(priced.junkOnly, false);
  assert.ok(priced.lineItems.some(line => line.kind === 'labor'), 'special items without a truck keep the Labor line');
  assert.equal(priced.totalCents, PICKUP_MINIMUM_CENTS);
  assert.ok(priced.lineItems.some(line => line.id === PICKUP_MINIMUM_LINE_ID));
  const customerId = (await api.resolve(PHOTO_CUSTOMER)).body.customer.id;
  const saved = await api.post({ action: 'save', requestId: rid(), customerId, draft: draftOf(priced) });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const job = f.job(saved.body.job.id);
  assert.equal((await api.dispatchPost({ action: 'schedule.update', requestId: rid(), jobId: job.id, expectedRevision: job.revision, changes: { date: MON, time: '09:30', endTime: '11:00' } })).status, 200);
  const refused = await api.post({ action: 'send_preview', jobId: job.id, expectedRevision: f.job(job.id).revision });
  assert.deepEqual([refused.status, refused.body.code], [409, 'quote_draft_composite_prices_unapproved'], 'a draft price (the sofa) is never sent');
});

test('the office role saves only builder-priced removal quotes with no walkthrough, and never reads, revises or sends anyone else\'s quote', async () => {
  const f = fixture(), state = approved(), api = office5(f, state);
  const chosen = removal([{ id: id('Full truck load'), quantity: 1 }]), priced = priceCompositeQuote(state, chosen, { complete: true });
  const customerId = (await api.resolve(PHOTO_CUSTOMER)).body.customer.id;
  const refusedSaves = [
    { requestId: rid(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: 'w1r', draft: { ...draftOf(priced), client: client(1) } },
    { requestId: rid(), customerId, draft: { ...draftOf(priced), composite_pricing: undefined, line_items: [{ id: 'hand', kind: 'service', name: 'Hand-priced haul', quantity: 1, unitCents: 100, totalCents: 100, optional: false, selected: true, taxable: false }] } },
    { requestId: rid(), customerId, draft: { ...draftOf(priced), composite_pricing: undefined, catalog_pricing: { catalogVersion: 1, settingsVersion: 'x', items: [] } } },
    { requestId: rid(), customerId, draft: draftOf(priceCompositeQuote(state, { ...selection(), labor: { manHours: null } }, { complete: true })) },
  ];
  for (const input of refusedSaves) {
    const answer = await api.post({ action: 'save', ...JSON.parse(JSON.stringify(input)) });
    assert.deepEqual([answer.status, answer.body.code], [403, 'quote_draft_office_removal_only'], JSON.stringify(answer.body));
  }
  assert.equal(f.calls.length, 1, 'only the customer was written');
  // An estimator's walkthrough quote with garage work: the office user can neither read, revise nor send it.
  const garage = priceCompositeQuote(state, selection(), { complete: true });
  const theirs = await saveQuoteDraft(f.store, estimator, { requestId: rid(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: 'w1r', draft: { client: client(1), title: 'Garage reset', scope: 'Garage reset.', line_items: garage.lineItems, valid_until: '2026-10-30', catalog_version: garage.menuVersion, composite_pricing: selection() } }, NOW, { env: ON_ENV, compositeState: async () => state, newQuotePaymentPolicy: SENT_25_75 });
  const job = f.job(theirs.job.id);
  for (const answer of [await api.get('/api/quote-draft?jobId=' + job.id), await api.post({ action: 'send_preview', jobId: job.id, expectedRevision: job.revision }),
    await api.post({ action: 'save', requestId: rid(), customerId: 'c1', jobId: job.id, expectedRevision: job.revision, draft: { ...draftOf(priced), client: client(1) } }),
    await api.post({ action: 'sync_capture', jobId: job.id, syncKey: 'x' }), await api.post({ action: 'catalog_preview', catalogPricing: { catalogVersion: 1, settingsVersion: 'x', items: [] } })]) {
    assert.deepEqual([answer.status, answer.body.code], [403, 'quote_draft_office_removal_only'], JSON.stringify(answer.body));
  }
  // The walkthrough and its signed handoff stay closed to the office role.
  const handoff = await handoffHandlers({ session: async () => officeUser, storage: () => f.store, now: () => new Date(NOW) }).get({ request: new Request(`${ORIGIN}/api/walkthrough-handoff?sourceWalkthroughId=w1`), env: ON_ENV });
  assert.equal(handoff.status, 403);
  // With the quote builder off the office user has no quote to build.
  const off = office5(fixture(), state, { env: { ...ON_ENV, EGC_QUOTE_BUILDER_ENABLED: 'false' } });
  const offSave = await off.post({ action: 'save', requestId: rid(), customerId: 'c1', draft: { ...draftOf(priced), client: client(1) } });
  assert.equal(offSave.status, 404);
});

test('the photo-quote exception is narrow: a quote with garage work and no walkthrough is still not sent, whoever saved it', async () => {
  const f = fixture(), state = approved();
  const garage = priceCompositeQuote(state, selection(), { complete: true });
  const saved = await saveQuoteDraft(f.store, owner, { requestId: rid(), customerId: 'c1', draft: { client: client(1), title: 'Garage reset', scope: 'Garage reset.', line_items: garage.lineItems, valid_until: '2026-10-30', catalog_version: garage.menuVersion, composite_pricing: selection() } }, NOW, { env: ON_ENV, compositeState: async () => state, newQuotePaymentPolicy: SENT_25_75 });
  const api = office5(f, state, { actor: owner });
  const job = f.job(saved.job.id);
  assert.equal(officeQuoteJob(job), false);
  assert.equal((await api.dispatchPost({ action: 'schedule.update', requestId: rid(), jobId: job.id, expectedRevision: job.revision, changes: { date: MON, time: '09:30', endTime: '12:30' } })).status, 200);
  const refused = await api.post({ action: 'send_preview', jobId: job.id, expectedRevision: f.job(job.id).revision });
  assert.deepEqual([refused.status, refused.body.code], [409, 'quote_draft_payment_dates_pending']);
  // The owner's own removal-only photo quote (the Photo quote screen) is sent like the office user's.
  const owners = await saveQuoteDraft(f.store, owner, { requestId: rid(), customerId: 'c2', draft: { ...draftOf(priceCompositeQuote(state, removal([{ id: id('Full truck load'), quantity: 1 }]), { complete: true })), client: client(2) } }, NOW, { env: ON_ENV, compositeState: async () => state, newQuotePaymentPolicy: SENT_25_75 });
  const photo = f.job(owners.job.id);
  assert.equal((await api.dispatchPost({ action: 'schedule.update', requestId: rid(), jobId: photo.id, expectedRevision: photo.revision, changes: { date: MON, time: '13:00', endTime: '15:00' } })).status, 200);
  assert.equal((await api.post({ action: 'send_preview', jobId: photo.id, expectedRevision: f.job(photo.id).revision })).status, 200);
});

// --- the Hub ------------------------------------------------------------------------------------------------------------
test('the Hub: an office account gets Photo quote, Customer messages and the booker\'s schedule, never a business screen', () => {
  const page = hubPage({ user: 'Office.Person', business: false, role: 'crew', before: context => {
    context.sessionStorage.setItem('egc_capabilities', JSON.stringify(['customer.send', 'quotes.removal', 'schedule.book']));
    context.sessionStorage.setItem('egc_capability_mode', 'staff_roles');
    context.sessionStorage.setItem('egc_role_access', 'true');
  } });
  const nav = Array.from(page.api.visibleNav(), item => item[1]);
  for (const view of ['photo_quote', 'customer_messages', 'schedule', 'pipeline', 'my_day']) assert.ok(nav.includes(view), view);
  for (const view of ['today', 'action_center', 'timesheets', 'people', 'finance', 'invoicing', 'job_actuals', 'staff', 'catalog', 'open_quotes', 'customers']) assert.equal(page.api.canView(view), false, view);
  assert.ok(Array.from(page.api.hubCapabilities()).includes('photo_quote'));
  // A crew account, and a Sales or Phone account with role access off, see no Photo quote.
  for (const caps of [[], ['customer.send', 'followups.own', 'quotes.author'], ['customer.send', 'followups.own']]) {
    const other = hubPage({ user: 'Synthetic.Crew', business: false, role: 'crew', before: context => { context.sessionStorage.setItem('egc_capabilities', JSON.stringify(caps)); context.sessionStorage.setItem('egc_capability_mode', 'staff_roles'); } });
    assert.equal(other.api.canView('photo_quote'), false, JSON.stringify(caps));
  }
});
