import test from 'node:test';
import assert from 'node:assert/strict';
import { knockSyncHandlers } from '../functions/api/knock-sync.js';
import { knockAdminHandlers } from '../functions/api/knock-admin.js';
import { knockReportsHandlers } from '../functions/api/knock-reports.js';
import { knockTerritoryHandlers } from '../functions/api/knock-territory.js';
import { customerMessage, startStripeDeposit } from '../functions/_lib/knock-handoff.js';
import { approvedKnockSettings, call, cookieFor, get, knockEnv, knockWorld, post, uuid } from './helpers/knock-fixture.mjs';
import { fakeGhl } from './helpers/messaging-fixture.mjs';

// Tuesday 2026-10-06, 11:00 am in Fort Collins.
const NOW = Date.parse('2026-10-06T17:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
const MIN = 60000;
const CHECKLIST = { contractSigned: true, noticesHanded: true, rightToCancelTold: true };

function seed() {
  return {
    'knock_neighborhoods/english-ranch': { name: 'English Ranch', tier: 'Volume', status: 'open', cityKey: 'fort-collins', holdReason: '' },
    'knock_reps/rep.one': { repKey: 'rep.one', username: 'Rep.One', displayName: 'Rep One', role: 'knocker', status: 'active', permitListed: true, premiumCleared: false, leadKey: 'lead.one' },
    'knock_reps/rep.two': { repKey: 'rep.two', username: 'Rep.Two', displayName: 'Rep Two', role: 'knocker', status: 'active', permitListed: true, premiumCleared: false },
    'knock_assignments/rep.one__english-ranch__all': { repKey: 'rep.one', neighborhoodId: 'english-ranch', street: '', active: true },
    'knock_assignments/rep.two__english-ranch__all': { repKey: 'rep.two', neighborhoodId: 'english-ranch', street: '', active: true },
    'knock_houses/h-2900-blue-leaf-dr': { neighborhoodId: 'english-ranch', street: 'BLUE LEAF DR', number: '2900', unit: '', lat: 40.55, lng: -105.03, updatedAt: '2026-10-01T00:00:00.000Z' },
    'knock_houses/h-2902-blue-leaf-dr': { neighborhoodId: 'english-ranch', street: 'BLUE LEAF DR', number: '2902', unit: '', lat: 40.55, lng: -105.03, updatedAt: '2026-10-01T00:00:00.000Z' },
  };
}

// Stripe and HighLevel are answered by fakes; nothing leaves the test.
function fakeProviders() {
  const calls = { stripe: [] };
  const ghl = fakeGhl({ contacts: { 'contact-1': { id: 'contact-1', locationId: 'location-1', phone: '+19705550100', email: 'pat@example.com', dnd: false, tags: [] } } });
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === 'api.stripe.com') {
      calls.stripe.push({ path: url.pathname, method: init.method || 'GET', body: init.body ? String(init.body) : '', headers: init.headers });
      if ((init.method || 'GET') === 'POST') return Response.json({ id: 'cs_test_synthetic', url: 'https://checkout.stripe.com/c/pay/cs_test_synthetic' });
      return Response.json({ id: 'cs_test_synthetic', status: 'complete', payment_status: 'paid', amount_total: calls.depositCents ?? 40000, client_reference_id: calls.saleId, metadata: { sale_id: calls.saleId } });
    }
    if (url.hostname === 'services.leadconnectorhq.com') return ghl.fetcher(url.href, init);
    return original(input, init);
  };
  return { calls, ghl, restore: () => { globalThis.fetch = original; } };
}

// integrations: what Admin > Settings chose (manual by default); env: server settings to override.
async function setup({ integrations = null, settingsDoc = null, env: extra = {} } = {}) {
  const env = knockEnv({ STRIPE_SECRET_KEY: 'sk_test_syntheticKnockKey', HIGHLEVEL_API_KEY: 'ghl-synthetic-key', HIGHLEVEL_LOCATION_ID: 'location-1', ...extra });
  const world = knockWorld({ ...seed(), ...(settingsDoc ? { 'knock_settings/current': settingsDoc } : {}), ...(integrations ? { 'knock_settings/current': { settings: { integrations } } } : {}) });
  let clock = NOW;
  const now = () => new Date(clock);
  const sync = knockSyncHandlers({ storage: world.storage, now });
  const admin = knockAdminHandlers({ storage: world.storage, now });
  const reports = knockReportsHandlers({ storage: world.storage, now });
  const territory = knockTerritoryHandlers({ storage: world.storage, now });
  const cookies = { rep: await cookieFor(env, 'Rep.One'), two: await cookieFor(env, 'Rep.Two'), zac: await cookieFor(env, 'ZacB') };
  const send = (events, cookie = cookies.rep) => call(sync.post, post('/api/knock-sync', { events }, cookie), env);
  const act = body => call(admin.post, post('/api/knock-admin', body, cookies.zac), env);
  return { env, world, sync, admin, reports, territory, cookies, send, act, setClock: v => { clock = v; } };
}

function saleBatch(overrides = {}) {
  const shiftId = uuid(), knockId = uuid(), saleId = uuid();
  return {
    shiftId, knockId, saleId,
    events: [
      { id: uuid(), type: 'shift.start', shiftId, cityKey: 'fort-collins', at: iso(NOW - 30 * MIN) },
      { id: knockId, type: 'knock', shiftId, houseId: 'h-2900-blue-leaf-dr', outcome: 'sold', quotedAmount: 1600, carOutside: true, at: iso(NOW - 5 * MIN) },
      { id: saleId, type: 'sale', knockId, houseId: 'h-2900-blue-leaf-dr', at: iso(NOW - 4 * MIN), ticket: 1600, package: 'The Works',
        customer: { name: 'Pat Synthetic', phone: '(970) 555-0100', email: 'Pat@Example.com' }, checklist: CHECKLIST,
        jobDate: '2026-10-10', jobStartTime: '08:30', textConsent: true, ...overrides },
    ],
  };
}

test('a new sale records the deadline, the 25% deposit and the customer only on the sale', async () => {
  const { world, send } = await setup();
  const { saleId, events } = saleBatch();
  const result = await send(events);
  assert.deepEqual(result.body.results.map(r => r.status), ['applied', 'applied', 'applied'], JSON.stringify(result.body));
  const sale = world.fake.get(`knock_sales/${saleId}`);
  assert.deepEqual([sale.saleDate, sale.cancelDeadlineDate, sale.cancelEndsAt, sale.earliestJobDate], ['2026-10-06', '2026-10-09', '2026-10-10T06:00:00.000Z', '2026-10-10']);
  assert.deepEqual([sale.ticket, sale.depositRate, sale.depositAmount, sale.status], [1600, 0.25, 400, 'booked']);
  assert.equal(sale.handoff.deposit.amount, 400);
  assert.deepEqual([sale.handoff.deposit.mode, sale.handoff.text.mode, sale.handoff.job.mode], ['manual', 'manual', 'manual']);
  assert.deepEqual(sale.customer, { name: 'Pat Synthetic', phone: '+19705550100', email: 'pat@example.com' });
  assert.deepEqual([sale.leadKey, sale.address.number, sale.neighborhoodId], ['lead.one', '2900', 'english-ranch']);
  const stored = world.fake.get(`knock_events/${saleId}`);
  assert.deepEqual(Object.keys(stored).filter(k => !['fingerprint', 'receivedAt', 'repKey', 'day', 'revision'].includes(k)).sort(), ['at', 'houseId', 'knockId', 'type']);
  const houses = [...world.fake.documents.keys()].filter(p => p.startsWith('knock_houses/') || p.startsWith('knock_events/')).map(p => JSON.stringify(world.fake.get(p)));
  assert.equal(houses.some(text => /Pat Synthetic|555-0100|example\.com/.test(text)), false, 'houses and events never hold customer details');
  assert.equal(world.fake.get('knock_days/rep.one_2026-10-06').bookedRevenue, 1600);
  assert.equal(sale.commissionTerms, null, 'unconfigured sales never inherit default compensation as approved terms');
});

test('a rep cannot supply their own approved commission terms', async () => {
  const { world, send } = await setup();
  const batch = saleBatch({ commissionTerms: { contract: 'knock-v1', approvedAt: '2026-01-01T00:00:00Z', policy: { rate: 1 } } });
  await send(batch.events);
  assert.equal(world.fake.get(`knock_sales/${batch.saleId}`).commissionTerms, null);
});

test('booking freezes approved server terms and later scope approval preserves the earned amount', async () => {
  const settingsDoc = approvedKnockSettings();
  const { world, send, act, setClock, reports, cookies, env } = await setup({ settingsDoc });
  const { events, saleId } = saleBatch({ commissionTerms: { policy: { rate: 1 } } });
  await send(events);
  assert.deepEqual(world.fake.get(`knock_sales/${saleId}`).commissionTerms.policy, settingsDoc.settings.commission);
  setClock(Date.parse('2026-10-20T18:00:00Z'));
  await act({ action: 'sale.status', saleId, status: 'completed' });
  await act({ action: 'sale.collection', saleId, collectedAmount: 1600 });
  const changed = approvedKnockSettings();
  changed.compensationApproval.scope.garageOnlyPackages = ['Garage Transformation'];
  world.fake.put('knock_settings/current', changed);
  const result = await call(reports.get, get('/api/knock-reports?view=my-money', cookies.rep), env);
  assert.equal(result.body.sales[0].commission.amount, 400);
  assert.equal(result.body.periods[0].commissionPaid, 0, 'customer collection never implies a rep payment');
  assert.equal(result.body.periods[0].commissionSettled, null);
});

test('current sale earns on full collection while job completion remains separate', async () => {
  const { world, send, act, reports, cookies, env } = await setup({ settingsDoc: approvedKnockSettings() });
  const { events, saleId } = saleBatch();
  await send(events);
  await act({ action: 'sale.collection', saleId, collectedAmount: 1600 });
  assert.equal(world.fake.get(`knock_sales/${saleId}`).status, 'booked');
  assert.equal(world.fake.get(`knock_sales/${saleId}`).completedAt, null);
  const result = await call(reports.get, get('/api/knock-reports?view=my-money', cookies.rep), env);
  assert.equal(result.body.sales[0].commission.state, 'earned');
  assert.equal(result.body.sales[0].commission.amount, 400);
  assert.equal(result.body.sales[0].commission.earnedAt, new Date(NOW).toISOString());
  assert.equal(result.body.periods[0].commissionPaid, 0);
});

test('booking uses approved service scope, ignores client eligibility and holds mixed work', async () => {
  for (const [packageName, state, amount] of [['Quick Clear', 'excluded', 0], ['Full Property Reset', 'review_required', null]]) {
    const settingsDoc = approvedKnockSettings();
    settingsDoc.compensationApproval.scope.garageOnlyPackages = ['Garage Transformation'];
    settingsDoc.compensationApproval.scope.junkRemovalPackages = ['Quick Clear'];
    const { send, act, setClock, reports, cookies, env, world } = await setup({ settingsDoc });
    const { events, saleId } = saleBatch({ package: packageName, commissionTerms: { contract: 'knock-garage-v2', policy: { rate: 1 } }, eligibility: 'garage' });
    await send(events);
    assert.equal(world.fake.get(`knock_sales/${saleId}`).commissionTerms.policy.rate, 0.25);
    setClock(Date.parse('2026-10-20T18:00:00Z'));
    await act({ action: 'sale.status', saleId, status: 'completed' });
    await act({ action: 'sale.collection', saleId, collectedAmount: 1600 });
    const { body } = await call(reports.get, get('/api/knock-reports?view=my-money', cookies.rep), env);
    assert.deepEqual(body.sales[0].commission, { state, amount });
    assert.equal(body.periods[0].customerCollectedRevenue, 1600);
    assert.equal(body.periods[0].commissionPaid, 0);
  }
});

test('a sale needs the checklist, a job date after the deadline, contact details and a sold door', async () => {
  const { send } = await setup();
  const cases = [
    [{ checklist: { ...CHECKLIST, noticesHanded: false } }, 'knock_sale_checklist'],
    [{ jobDate: '2026-10-09' }, 'knock_sale_job_date'],
    [{ customer: { name: 'Pat', phone: '555-0100', email: 'pat@example.com' } }, 'knock_sale_customer'],
    [{ customer: { name: 'Pat', phone: '9705550100', email: 'not-an-email' } }, 'knock_sale_customer'],
    [{ package: 'Something Else' }, 'knock_sale_package'],
    [{ ticket: 0 }, 'knock_sale_ticket'],
  ];
  for (const [overrides, code] of cases) {
    const { events } = saleBatch(overrides);
    const result = await send(events);
    assert.equal(result.body.results[2].code, code, JSON.stringify(overrides));
  }
  const { events } = saleBatch();
  const noAnswer = events.map(e => e.type === 'knock' ? { ...e, outcome: 'no_answer' } : e);
  assert.equal((await send(noAnswer)).body.results[2].code, 'knock_sale_invalid');
});

test('jobs start at 9:30 or later on and after 2026-10-15: 9:29 is refused, 9:30 accepted, a stored 8:00 default reads as 9:30', async () => {
  // A stored settings copy saved before the rule keeps 8:00; it still loads (no settings are lost) and is read as 9:30.
  const stored = { settings: { sale: { defaultJobStartTime: '08:00' } }, updatedAt: '2026-10-01T12:00:00Z', updatedBy: 'test-owner' };
  const { world, send, act } = await setup({ settingsDoc: stored });
  const early = saleBatch({ jobDate: '2026-10-19', jobStartTime: '09:29' });
  assert.deepEqual((await send(early.events)).body.results.map(r => r.code || r.status), ['applied', 'applied', 'knock_sale_job_time']);
  const exact = saleBatch({ jobDate: '2026-10-19', jobStartTime: '09:30' });
  await send(exact.events, undefined);
  assert.equal(world.fake.get(`knock_sales/${exact.saleId}`).jobStartTime, '09:30');
  const omitted = saleBatch({ jobDate: '2026-10-19', jobStartTime: undefined });
  await send(omitted.events);
  assert.equal(world.fake.get(`knock_sales/${omitted.saleId}`).jobStartTime, '09:30', 'the 8:00 default never books an 8:00 job on a policy date');
  const before = saleBatch({ jobDate: '2026-10-12', jobStartTime: undefined });
  await send(before.events);
  assert.equal(world.fake.get(`knock_sales/${before.saleId}`).jobStartTime, '08:00', 'dates before the policy keep the saved default');
  // Admin date moves: an explicit early start is refused; a kept early start is raised to 9:30 and noted.
  assert.equal((await act({ action: 'sale.jobDate', saleId: before.saleId, jobDate: '2026-10-20', jobStartTime: '09:00' })).body.code, 'knock_sale_job_time');
  const moved = await act({ action: 'sale.jobDate', saleId: before.saleId, jobDate: '2026-10-20' });
  assert.deepEqual([moved.body.sale.jobDate, moved.body.sale.jobStartTime], ['2026-10-20', '09:30']);
  assert.match(moved.body.sale.statusHistory.at(-1).note, /start 09:30 \(jobs start at 9:30 or later\)/);
});

test('a sold door with a sale cannot be undone or edited by the rep, and one door gets one sale', async () => {
  const { send } = await setup();
  const { events, knockId } = saleBatch();
  await send(events);
  const undo = await send([{ id: uuid(), type: 'knock.void', target: knockId, houseId: 'h-2900-blue-leaf-dr', at: iso(NOW) }]);
  assert.equal(undo.body.results[0].code, 'knock_sold_locked');
  const again = await send([{ ...events[2], id: uuid() }]);
  assert.equal(again.body.results[0].code, 'knock_sale_exists');
});

test('admins move a sale through completed, paid and cancelled, and booked revenue follows', async () => {
  const { world, send, act } = await setup();
  const { events, saleId } = saleBatch();
  await send(events);
  assert.equal((await act({ action: 'sale.status', saleId, status: 'completed' })).body.sale.status, 'completed');
  assert.equal((await act({ action: 'sale.status', saleId, status: 'paid', collectedAmount: '1550' })).body.code, 'knock_partial_collection');
  const partial = await act({ action: 'sale.collection', saleId, collectedAmount: '1550' });
  assert.deepEqual([partial.body.sale.status, partial.body.sale.collectedAmount], ['completed', 1550]);
  const paid = await act({ action: 'sale.collection', saleId, collectedAmount: '1600' });
  assert.deepEqual([paid.body.sale.status, paid.body.sale.collectedAmount], ['paid', 1600]);
  assert.ok(world.fake.get(`knock_sales/${saleId}`).paidAt);
  const cancelled = await act({ action: 'sale.status', saleId, status: 'cancelled' });
  assert.equal(cancelled.body.sale.status, 'cancelled');
  assert.equal(world.fake.get('knock_days/rep.one_2026-10-06').bookedRevenue, 0, 'a cancelled sale is not booked revenue');
  assert.equal((await act({ action: 'sale.status', saleId, status: 'paid' })).body.code, 'knock_invalid_transition');
  assert.equal((await act({ action: 'sale.status', saleId, status: 'booked' })).body.sale.status, 'booked');
  assert.equal((await act({ action: 'sale.jobDate', saleId, jobDate: '2026-10-08' })).body.code, 'knock_sale_job_date');
  assert.equal((await act({ action: 'sale.jobDate', saleId, jobDate: '2026-10-20' })).body.sale.jobDate, '2026-10-20');
});

test('hand-offs: job and deposit can be marked by hand; Stripe makes one deposit link and confirms payment', async t => {
  const providers = fakeProviders();
  t.after(providers.restore);
  const manual = await setup();
  const first = saleBatch();
  await manual.send(first.events);
  assert.equal((await manual.act({ action: 'sale.handoff', saleId: first.saleId, kind: 'deposit', op: 'start' })).body.code, 'knock_stripe_off', 'Stripe stays off until Settings choose it');
  assert.equal(providers.calls.stripe.length, 0);

  const { world, send, act } = await setup({ integrations: { deposit: 'stripe' } });
  const { events, saleId } = saleBatch();
  providers.calls.saleId = saleId;
  await send(events);
  await act({ action: 'sale.handoff', saleId, kind: 'job', op: 'mark', ref: 'HUB-123' });
  assert.deepEqual([world.fake.get(`knock_sales/${saleId}`).handoff.job.status, world.fake.get(`knock_sales/${saleId}`).handoff.job.ref], ['created', 'HUB-123']);
  const link = await act({ action: 'sale.handoff', saleId, kind: 'deposit', op: 'start' });
  assert.equal(link.body.sale.handoff.deposit.url, 'https://checkout.stripe.com/c/pay/cs_test_synthetic');
  const create = providers.calls.stripe[0];
  assert.equal(create.path, '/v1/checkout/sessions');
  assert.match(create.body, /unit_amount%5D=40000/);
  assert.match(new URLSearchParams(create.body).get('line_items[0][price_data][product_data][description]'), /^25% deposit/);
  assert.match(create.body, /metadata%5Bkind%5D=egc_knock_deposit/);
  assert.equal(create.headers['Idempotency-Key'], `egc-knock-deposit-${saleId}`);
  const checked = await act({ action: 'sale.handoff', saleId, kind: 'deposit', op: 'refresh' });
  assert.deepEqual([checked.body.sale.handoff.deposit.status, checked.body.sale.handoff.deposit.collectedAmount, checked.body.sale.handoff.deposit.verifiedBy], ['collected', 400, 'stripe']);
});

test('saved 20% deposits keep their amount and Stripe description after settings change', async t => {
  const providers = fakeProviders();
  t.after(providers.restore);
  const settingsDoc = { settings: { sale: { depositRate: 0.2 }, integrations: { deposit: 'stripe' } } };
  const { world, send, act } = await setup({ settingsDoc });
  const { events, saleId } = saleBatch();
  await send(events);
  const saved = world.fake.get(`knock_sales/${saleId}`);
  assert.deepEqual([saved.depositRate, saved.depositAmount], [0.2, 320]);
  world.fake.put('knock_settings/current', { settings: { sale: { depositRate: 0.25 }, integrations: { deposit: 'stripe' } } });
  providers.calls.saleId = saleId;
  providers.calls.depositCents = 32000;
  await act({ action: 'sale.handoff', saleId, kind: 'deposit', op: 'start' });
  const body = new URLSearchParams(providers.calls.stripe[0].body);
  assert.equal(body.get('line_items[0][price_data][unit_amount]'), '32000');
  assert.match(body.get('line_items[0][price_data][product_data][description]'), /^20% deposit/);
  const checked = await act({ action: 'sale.handoff', saleId, kind: 'deposit', op: 'refresh' });
  assert.deepEqual([checked.body.sale.depositRate, checked.body.sale.depositAmount, checked.body.sale.handoff.deposit.collectedAmount], [0.2, 320, 320]);
});

test('Stripe does not invent a percentage for historical sales with missing or invalid saved rates', async () => {
  for (const depositRate of [undefined, null, '0.2', NaN, -0.2, 1.2]) {
    let body;
    await startStripeDeposit({ STRIPE_SECRET_KEY: 'sk_test_syntheticKnockKey' }, {
      id: 'legacy-rate', package: 'The Works', ticket: 1600, depositAmount: 320, depositRate, cancelDeadlineDate: '2026-10-09',
    }, { request: async (_secret, _path, options) => {
      body = options.body;
      return { id: 'cs_test_synthetic', url: 'https://checkout.stripe.com/c/pay/cs_test_synthetic' };
    } });
    assert.equal(body.get('line_items[0][price_data][unit_amount]'), '32000');
    assert.match(body.get('line_items[0][price_data][product_data][description]'), /^Deposit on/);
  }
});

test('one customer, one text: HighLevel sends once, a refusal can be retried, an unclear answer cannot', async t => {
  const providers = fakeProviders();
  t.after(providers.restore);
  const { world, send, act } = await setup({ integrations: { text: 'highlevel' } });
  const { events, saleId } = saleBatch();
  await send(events);
  const sent = await act({ action: 'sale.handoff', saleId, kind: 'text', op: 'send' });
  const text = sent.body.sale.handoff.text;
  assert.deepEqual([text.status, text.mode, text.contactId, text.messageId], ['sent', 'highlevel', 'contact-1', 'message-1'], JSON.stringify(sent.body));
  const upsert = providers.ghl.calls.find(c => c.path === '/contacts/upsert');
  assert.deepEqual([upsert.body.locationId, upsert.body.phone, upsert.body.email, upsert.body.name, upsert.headers.Authorization], ['location-1', '+19705550100', 'pat@example.com', 'Pat Synthetic', 'Bearer ghl-synthetic-key']);
  const [message] = providers.ghl.sends();
  assert.deepEqual([message.body.type, message.body.contactId, message.body.toNumber, message.headers['Idempotency-Key']], ['SMS', 'contact-1', '+19705550100', `egc-knock-sale-text-${saleId}-1`]);
  assert.match(message.body.message, /^Hi Pat, thanks for booking Easy Garage Cleaning: The Works, \$1,600/);
  assert.match(message.body.message, /cancel for a full refund until midnight Friday, October 9/);
  assert.equal((await act({ action: 'sale.handoff', saleId, kind: 'text', op: 'send' })).body.code, 'knock_text_already');
  assert.equal(providers.ghl.sends().length, 1, 'never a second message');

  const second = saleBatch();
  second.events[1].houseId = second.events[2].houseId = 'h-2902-blue-leaf-dr';
  await send(second.events);
  providers.ghl.state.sendStatus = 400;
  const refused = await act({ action: 'sale.handoff', saleId: second.saleId, kind: 'text', op: 'send' });
  assert.deepEqual([refused.body.code, refused.body.error], ['knock_text_rejected', 'HighLevel refused the text (400). Nothing was sent.']);
  providers.ghl.state.sendStatus = 503;
  assert.equal((await act({ action: 'sale.handoff', saleId: second.saleId, kind: 'text', op: 'send' })).body.code, 'knock_text_uncertain');
  assert.equal(providers.ghl.sends().at(-1).headers['Idempotency-Key'], `egc-knock-sale-text-${second.saleId}-2`, 'each allowed attempt has its own key');
  providers.ghl.state.sendStatus = 200;
  assert.equal((await act({ action: 'sale.handoff', saleId: second.saleId, kind: 'text', op: 'send' })).body.code, 'knock_text_already', 'an unclear send is never retried automatically');
  assert.equal(providers.ghl.sends().length, 3);
  assert.deepEqual([world.fake.get(`knock_receipts/text_${second.saleId}`).outcome, world.fake.get(`knock_receipts/text_${second.saleId}`).attempts], ['uncertain', 2]);
  assert.equal((await act({ action: 'sale.handoff', saleId: second.saleId, kind: 'text', op: 'mark' })).body.sale.handoff.text.status, 'sent');
});

test('HighLevel texts only when Settings choose it and the server is set up, and never past Do Not Disturb', async t => {
  const providers = fakeProviders();
  t.after(providers.restore);
  const manual = await setup();
  const a = saleBatch();
  await manual.send(a.events);
  assert.equal((await manual.act({ action: 'sale.handoff', saleId: a.saleId, kind: 'text', op: 'send' })).body.code, 'knock_text_off');
  const unset = await setup({ integrations: { text: 'highlevel' }, env: { HIGHLEVEL_API_KEY: '' } });
  const b = saleBatch();
  await unset.send(b.events);
  assert.equal((await unset.act({ action: 'sale.handoff', saleId: b.saleId, kind: 'text', op: 'send' })).body.code, 'knock_highlevel_unavailable');
  const unsetView = await call(unset.admin.get, get('/api/knock-admin?view=sales', unset.cookies.zac), unset.env);
  assert.deepEqual(unsetView.body.integrations.text, { mode: 'highlevel', available: ['manual'] });
  assert.equal(providers.ghl.calls.length, 0, 'HighLevel is never called when it is off or not set up');

  const { world, send, act, admin, cookies, env } = await setup({ integrations: { text: 'highlevel' } });
  const view = await call(admin.get, get('/api/knock-admin?view=sales', cookies.zac), env);
  assert.deepEqual(view.body.integrations.text, { mode: 'highlevel', available: ['manual', 'highlevel'] });
  const c = saleBatch();
  await send(c.events);
  providers.ghl.state.contacts['contact-1'].dndSettings = { SMS: { status: 'active' } };
  const blocked = await act({ action: 'sale.handoff', saleId: c.saleId, kind: 'text', op: 'send' });
  assert.equal(blocked.body.code, 'knock_text_rejected');
  assert.match(blocked.body.error, /Do Not Disturb.*Nothing was sent/);
  assert.equal(providers.ghl.sends().length, 0, 'Do Not Disturb stops the text before it is sent');
  assert.deepEqual([world.fake.get(`knock_receipts/text_${c.saleId}`).outcome, world.fake.get(`knock_sales/${c.saleId}`).handoff.text.reason], ['rejected', 'contact_dnd_sms']);
  providers.ghl.state.contacts['contact-1'].dndSettings = { SMS: { status: 'inactive' } };
  assert.equal((await act({ action: 'sale.handoff', saleId: c.saleId, kind: 'text', op: 'send' })).body.sale.handoff.text.status, 'sent', 'nothing went out, so a retry is allowed');
  assert.equal(providers.ghl.sends().length, 1);
});

test('no text without consent, and a rep sees only their own sales while admins see all with the message', async () => {
  const { send, act, reports, cookies, env } = await setup();
  const { events, saleId } = saleBatch({ textConsent: false });
  await send(events);
  assert.equal((await act({ action: 'sale.handoff', saleId, kind: 'text', op: 'send' })).body.code, 'knock_text_no_consent');
  const mine = await call(reports.get, get('/api/knock-reports?view=my-sales', cookies.rep), env);
  assert.deepEqual(mine.body.sales.map(s => s.id), [saleId]);
  assert.equal(mine.body.sales[0].refund, 'Deposit fully refundable until midnight Friday, October 9 (right to cancel).');
  const theirs = await call(reports.get, get('/api/knock-reports?view=my-sales', cookies.two), env);
  assert.deepEqual(theirs.body.sales, []);
  const all = await call((await setup()).admin.get, get('/api/knock-admin?view=sales', cookies.zac), env);
  assert.equal(all.status, 200);
  const repView = await call((await setup()).admin.get, get('/api/knock-admin?view=sales', cookies.rep), env);
  assert.equal(repView.status, 403, 'only admins read every customer');
});

test('the refund rule: full refund in the cancel window, then until 24 hours before the job', async () => {
  const { refundSummary } = await import('../functions/_lib/knock-handoff.js');
  const sale = { cancelDeadlineDate: '2026-10-09', cancelEndsAt: '2026-10-10T06:00:00.000Z', jobDate: '2026-10-20', jobStartTime: '08:00', refundCutoffHours: 24 };
  assert.equal(refundSummary(sale, Date.parse('2026-10-09T20:00:00Z')), 'Deposit fully refundable until midnight Friday, October 9 (right to cancel).');
  assert.equal(refundSummary(sale, Date.parse('2026-10-12T20:00:00Z')), 'Deposit refundable until 8:00 am Monday, October 19 (24 hours before the job).');
  assert.equal(refundSummary(sale, Date.parse('2026-10-19T15:00:00Z')), 'Deposit not refundable: inside 24 hours of the job.');
});

test('the customer message names the package, price, deposit link and the cancel deadline', () => {
  const text = customerMessage({ customer: { name: 'Pat Synthetic' }, package: 'Quick Clear', ticket: 1234.5, depositAmount: 246.9, jobDate: '2026-10-20', cancelDeadlineDate: '2026-10-14', handoff: { deposit: { url: 'https://checkout.stripe.com/x' } } });
  assert.equal(text, 'Hi Pat, thanks for booking Easy Garage Cleaning: Quick Clear, $1,234.50, on Tuesday, October 20. Your $246.90 deposit: https://checkout.stripe.com/x You can cancel for a full refund until midnight Wednesday, October 14. Questions? Reply here.');
});
