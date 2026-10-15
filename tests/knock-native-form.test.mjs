import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { nativeFormConfig } from '../functions/_lib/knock-form-config.js';
import { nativeFormReader } from '../functions/_lib/knock-form-provider.js';
import { nativeFormContext, createNativeFormHandoff, openNativeFormHandoff, verifyNativeFormReceipt } from '../functions/_lib/knock-form-handoff.js';
import { knockFormHandlers } from '../functions/api/knock-form-handoff.js';
import { knockSyncHandlers } from '../functions/api/knock-sync.js';
import { createKnockStore, write } from '../functions/_lib/knock-store.js';
import { formDigest } from '../functions/_lib/knock-form-claims.js';
import { createNativeFormSession, nativeLaunchUrl, nativeFrame } from '../crew/knock-native-form.js';
import { commissionEligibility, saleCommissions } from '../crew/knock-money.js';
import { DEFAULT_SETTINGS, PACKAGES } from '../crew/knock-settings.js';
import { call, cookieFor, get, knockEnv, knockWorld, post, uuid } from './helpers/knock-fixture.mjs';

const NOW = '2026-10-15T20:00:00.000Z';
const AFTER = '2026-10-15T20:01:00.000Z';
const REP = { repKey: 'rep.one', status: 'active', role: 'knocker' };
const ENV = knockEnv({ HIGHLEVEL_API_KEY: 'synthetic-existing-token', HIGHLEVEL_LOCATION_ID: 'syntheticLocation' });
// Deliberately synthetic test fixtures. None is an actual form ID or acceptance record.
function configDocument() {
  const forms = Object.fromEntries(['direct_sale', 'walkthrough_request'].map((channel, i) => {
    const form = { formId: `syntheticForm${i}`, referenceFieldId: `syntheticField${i}`, referenceQueryKey: 'handoff_ref',
      url: `https://links.easygaragecleaning.com/widget/form/syntheticForm${i}` };
    return [channel, { ...form, acceptance: { ...form, locationId: ENV.HIGHLEVEL_LOCATION_ID,
      prefillVerified: true, submissionReadVerified: true, formsReadonlyVerified: true,
      verifiedBy: 'synthetic-reviewer', verifiedAt: '2026-10-14T20:00:00Z', evidence: 'synthetic-test-only' } }];
  }));
  return { enabled: true, locationId: ENV.HIGHLEVEL_LOCATION_ID, forms };
}
function world(extra = {}) {
  const quoteId = uuid();
  const seed = {
    'knock_reps/rep.one': REP,
    'knock_reps/rep.two': { repKey: 'rep.two', status: 'active', role: 'knocker' },
    'knock_neighborhoods/area': { name: 'Synthetic neighborhood', tier: 'Volume', status: 'active', cityKey: 'fort-collins' },
    'knock_assignments/one': { repKey: 'rep.one', neighborhoodId: 'area', active: true },
    'knock_assignments/two': { repKey: 'rep.two', neighborhoodId: 'area', active: true },
    'knock_houses/house-one': { neighborhoodId: 'area', number: '123', street: 'SYNTHETIC ST', unit: '7' },
    [`knock_events/${quoteId}`]: { type: 'knock', outcome: 'look', repKey: 'rep.one', houseId: 'house-one', at: NOW, quotedAmount: 1600 },
    'knock_settings/native_forms': configDocument(), ...extra,
  };
  const { fake, storage } = knockWorld(seed);
  return { fake, storage, store: storage(ENV), quoteId, config: nativeFormConfig(seed['knock_settings/native_forms'], ENV, Date.parse(NOW)) };
}
async function requestFor(w, channel = 'direct_sale', kind = 'quote', id = w.quoteId) {
  const context = await nativeFormContext(w.store, REP, DEFAULT_SETTINGS, 'house-one', w.config);
  return { action: 'create', houseId: 'house-one', channel, source: context.sources.find(s => s.kind === kind && s.id === id) };
}
async function started(w = world(), channel = 'direct_sale') {
  const body = await requestFor(w, channel);
  const result = await createNativeFormHandoff(w.store, REP, DEFAULT_SETTINGS, body, w.config, NOW);
  return { ...w, body, handoff: result.handoff };
}
const verifyBody = handoff => ({ action: 'verify', reference: handoff.reference, contactId: 'syntheticContact', submissionId: 'syntheticSubmission' });
const evidence = (w, changes = {}) => ({
  row: { id: 'syntheticSubmission', contactId: 'syntheticContact', formId: w.config.forms[w.handoff.channel].formId, createdAt: AFTER,
    others: { [w.config.forms[w.handoff.channel].referenceFieldId]: w.handoff.reference }, ...changes.row },
  contact: { id: 'syntheticContact', locationId: ENV.HIGHLEVEL_LOCATION_ID, ...changes.contact },
});
const verify = (w, body = verifyBody(w.handoff), read = async () => evidence(w)) =>
  verifyNativeFormReceipt(w.store, REP, DEFAULT_SETTINGS, body, w.config, AFTER, read);

test('canonical source digest ignores map key order but preserves values and array order', async () => {
  assert.equal(await formDigest({ a: 1, b: { c: 2, d: 3 } }), await formDigest({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(await formDigest([1, 2]), await formDigest([2, 1]));
  assert.notEqual(await formDigest({ a: 1 }), await formDigest({ a: 2 }));
});

test('missing configuration stays disabled without writes or provider calls', async () => {
  const w = world({ 'knock_settings/native_forms': { enabled: false } });
  const handlers = knockFormHandlers({ storage: w.storage, now: () => new Date(NOW), reader: () => { throw Error('provider called'); } });
  const cookie = await cookieFor(ENV, 'Rep.One');
  const result = await call(handlers.get, get('/api/knock-form-handoff', cookie), ENV);
  assert.equal(result.body.setup.enabled, false);
  assert.ok(result.body.setup.blockers.includes('native_forms_disabled'));
  const before = w.fake.calls.filter(c => c.path === ':commit').length;
  const rejected = await call(handlers.post, post('/api/knock-form-handoff', { action: 'create' }, cookie), ENV);
  assert.equal(rejected.body.code, 'knock_form_setup');
  assert.equal(w.fake.calls.filter(c => c.path === ':commit').length, before);
});

test('configuration is bound to both actual form mappings, existing location and acceptance evidence', () => {
  assert.equal(nativeFormConfig(configDocument(), ENV, Date.parse(NOW)).enabled, true);
  for (const change of [
    d => { delete d.forms.direct_sale.referenceFieldId; },
    d => { d.forms.direct_sale.referenceFieldId = ''; },
    d => { d.forms.direct_sale.formId = 'DeiRNO6itxjLiTk3Nkj0'; },
    d => { d.forms.direct_sale.referenceQueryKey = 'constructor'; },
    d => { d.forms.direct_sale.url += '?phone=123'; },
    d => { d.forms.direct_sale.url = 'https://links.easygaragecleaning.com.evil.test/widget/form/syntheticForm0'; },
    d => { d.forms.direct_sale.acceptance.prefillVerified = false; },
    d => { d.forms.direct_sale.acceptance.formsReadonlyVerified = false; },
    d => { d.forms.direct_sale.acceptance.evidence = ''; },
    d => { d.forms.direct_sale.acceptance.verifiedAt = '2099-01-01'; },
    d => { d.locationId = 'foreignLocation'; },
    d => { d.forms.direct_sale.referenceFieldId = 'changedField'; },
    d => { d.forms.walkthrough_request = structuredClone(d.forms.direct_sale); },
  ]) { const doc = configDocument(); change(doc); assert.equal(nativeFormConfig(doc, ENV, Date.parse(NOW)).enabled, false); }
});

test('API requires an active authenticated rep and refuses cross-origin mutation', async () => {
  const w = world();
  const handlers = knockFormHandlers({ storage: w.storage, now: () => new Date(NOW) });
  assert.equal((await call(handlers.get, get('/api/knock-form-handoff'), ENV)).status, 401);
  const cookie = await cookieFor(ENV, 'Rep.One');
  assert.equal((await call(handlers.post, post('/api/knock-form-handoff', {}, cookie, { origin: 'https://evil.test' }), ENV)).status, 403);
  w.fake.put('knock_reps/rep.one', { ...REP, status: 'inactive' });
  assert.equal((await call(handlers.get, get('/api/knock-form-handoff', cookie), ENV)).body.code, 'knock_rep_inactive');
});

test('walkthrough and direct quote handoffs do not log Sold, start a sale, link a visit, or award money', async () => {
  for (const channel of ['walkthrough_request', 'direct_sale']) {
    const w = await started(world(), channel);
    assert.equal(w.handoff.status, 'awaiting_submission');
    assert.deepEqual(w.handoff.states, { hubSaved: true, submissionVerified: false, contactLinked: false, jobLinked: false,
      walkthroughLinked: false, collected: 'not_evaluated', commissionEligible: 'not_evaluated', commissionPayable: 'not_evaluated' });
    assert.equal((await w.store.list('knock_events')).length, 1);
    assert.equal(w.fake.get(`knock_events/${w.quoteId}`).outcome, 'look');
    for (const collection of ['knock_sales', 'knock_setters', 'knock_payouts', 'knock_days']) assert.equal((await w.store.list(collection)).length, 0);
  }
});

test('foreign rep, out-of-territory house, and hidden client attribution are rejected', async () => {
  const w = world(), body = await requestFor(w);
  await assert.rejects(createNativeFormHandoff(w.store, { ...REP, repKey: 'rep.two' }, DEFAULT_SETTINGS, body, w.config, NOW), { code: 'knock_form_source' });
  for (const field of ['repKey', 'setterKey', 'ticket', 'commissionRate', 'formId', 'url'])
    await assert.rejects(createNativeFormHandoff(w.store, REP, DEFAULT_SETTINGS, { ...body, [field]: 'tampered' }, w.config, NOW), { code: 'knock_form_fields' });
  w.fake.put('knock_assignments/one', { repKey: 'rep.one', neighborhoodId: 'area', active: false });
  await assert.rejects(createNativeFormHandoff(w.store, REP, DEFAULT_SETTINGS, body, w.config, NOW), { code: 'knock_form_house' });
});

test('missing, mismatched, edited and voided source revisions cannot open forms', async () => {
  const w = await started();
  for (const revision of [undefined, '0'.repeat(64)]) {
    await assert.rejects(createNativeFormHandoff(w.store, REP, DEFAULT_SETTINGS, { ...w.body, source: { ...w.body.source, revision } }, w.config, NOW), { code: 'knock_form_revision' });
  }
  w.fake.put(`knock_events/${uuid()}`, { type: 'knock.edit', target: w.quoteId, repKey: 'rep.one', houseId: 'house-one', quotedAmount: 2000, at: AFTER });
  await assert.rejects(openNativeFormHandoff(w.store, REP, DEFAULT_SETTINGS, { action: 'open', reference: w.handoff.reference }, w.config, AFTER), { code: 'knock_form_revision' });
  w.fake.put(`knock_events/${uuid()}`, { type: 'knock.void', target: w.quoteId, repKey: 'rep.one', houseId: 'house-one', at: AFTER });
  await assert.rejects(openNativeFormHandoff(w.store, REP, DEFAULT_SETTINGS, { action: 'open', reference: w.handoff.reference }, w.config, AFTER), { code: 'knock_form_source' });
});

test('create-only request claim recovers equivalent concurrent requests and lost responses', async () => {
  const w = world(), body = await requestFor(w);
  const rows = await Promise.all([1, 2].map(() => createNativeFormHandoff(w.store, REP, DEFAULT_SETTINGS, body, w.config, NOW)));
  assert.equal(rows[0].handoff.reference, rows[1].handoff.reference);
  assert.equal(rows.filter(row => row.duplicate).length, 1);
  assert.equal((await w.store.list('knock_form_handoffs')).length, 1);
  assert.equal((await createNativeFormHandoff(w.store, REP, DEFAULT_SETTINGS, body, w.config, NOW)).duplicate, true);
});

test('direct/setter channel claims cannot be stacked or reassigned across reps', async () => {
  const w = await started(world(), 'walkthrough_request');
  await assert.rejects(createNativeFormHandoff(w.store, REP, DEFAULT_SETTINGS, { ...w.body, channel: 'direct_sale' }, w.config, NOW), { code: 'knock_form_channel_conflict' });
  const id = uuid();
  w.fake.put(`knock_events/${id}`, { type: 'knock', outcome: 'look', repKey: 'rep.two', houseId: 'house-one', at: NOW });
  const context = await nativeFormContext(w.store, { ...REP, repKey: 'rep.two' }, DEFAULT_SETTINGS, 'house-one', w.config);
  await assert.rejects(createNativeFormHandoff(w.store, { ...REP, repKey: 'rep.two' }, DEFAULT_SETTINGS, { ...w.body, source: context.sources[0] }, w.config, NOW), { code: 'knock_form_channel_conflict' });
  const other = world({ 'knock_sales/existing-sale': { repKey: 'rep.one', houseId: 'house-one', status: 'booked' } });
  await assert.rejects(createNativeFormHandoff(other.store, REP, DEFAULT_SETTINGS, await requestFor(other, 'walkthrough_request'), other.config, NOW), { code: 'knock_form_channel_conflict' });
  await assert.rejects(createNativeFormHandoff(other.store, REP, DEFAULT_SETTINGS, await requestFor(other, 'walkthrough_request', 'sale', 'existing-sale'), other.config, NOW), { code: 'knock_form_channel' });
});

test('launch URLs contain only the opaque reference and strict provider origin/path', async () => {
  const w = await started();
  const result = await openNativeFormHandoff(w.store, REP, DEFAULT_SETTINGS, { action: 'open', reference: w.handoff.reference }, w.config, NOW);
  assert.equal(nativeLaunchUrl(result.launch, w.handoff.reference), result.launch.url);
  assert.deepEqual([...new URL(result.launch.url).searchParams], [['handoff_ref', w.handoff.reference]]);
  assert.doesNotMatch(result.launch.url, /123|SYNTHETIC|1600|rep.one|house-one|phone|email|price/);
  for (const suffix of ['&email=private', '#private']) assert.equal(nativeLaunchUrl({ ...result.launch, url: result.launch.url + suffix }, w.handoff.reference), null);
  assert.equal(nativeLaunchUrl({ ...result.launch, url: result.launch.url.replace('links.easygaragecleaning.com', 'links.easygaragecleaning.com.evil.test') }, w.handoff.reference), null);
});

test('verified receipt is create-only and idempotent; hidden rep fields cannot change ownership', async () => {
  const w = await started(); let reads = 0;
  const read = async () => { reads++; const value = evidence(w); value.row.others.repKey = 'rep.two'; value.row.others.commission = 25; return value; };
  const rows = await Promise.all([verify(w, undefined, read), verify(w, undefined, read)]);
  assert.equal(rows.filter(r => r.duplicate).length, 1);
  const firstReads = reads;
  assert.equal((await verify(w, undefined, read)).duplicate, true);
  assert.equal(reads, firstReads, 'durable receipt replay does not reread provider');
  const receipt = await w.store.get('knock_receipts', `native_ref_${w.handoff.reference}`);
  assert.equal(receipt.repKey, 'rep.one');
  assert.equal(receipt.commission, undefined);
  assert.equal(rows[0].handoff.states.submissionVerified, true);
  assert.equal(rows[0].handoff.states.jobLinked, false);
  for (const collection of ['knock_sales', 'knock_setters', 'knock_payouts']) assert.equal((await w.store.list(collection)).length, 0);
  await assert.rejects(verify(w, { ...verifyBody(w.handoff), submissionId: 'anotherSubmission' }), { code: 'knock_form_replay' });
});

test('foreign reference cannot open or verify even with valid-looking hidden fields', async () => {
  const w = await started(); const foreign = { ...REP, repKey: 'rep.two' };
  await assert.rejects(openNativeFormHandoff(w.store, foreign, DEFAULT_SETTINGS, { action: 'open', reference: w.handoff.reference }, w.config, NOW), { code: 'knock_form_owner' });
  await assert.rejects(verifyNativeFormReceipt(w.store, foreign, DEFAULT_SETTINGS, verifyBody(w.handoff), w.config, AFTER, () => { throw Error('must not read provider'); }), { code: 'knock_form_owner' });
});

test('mismatched form, location, submission, contact, time or reference never creates a receipt', async () => {
  for (const changes of [
    { row: { id: 'wrong' } }, { row: { formId: 'wrong' } }, { row: { contactId: 'wrong' } },
    { contact: { id: 'wrong' } }, { contact: { locationId: 'wrong' } }, { row: { locationId: 'wrong' } },
    { row: { createdAt: '2026-10-14T20:00:00Z' } }, { row: { createdAt: '2026-10-17T20:00:00Z' } },
    { row: { createdAt: '2026-10-15T20:02:00Z' } }, { row: { createdAt: 'invalid' } }, { row: { others: {} } },
    { row: { others: { syntheticField0: 'kf_' + '0'.repeat(32) } } },
  ]) {
    const w = await started();
    await assert.rejects(verify(w, undefined, async () => evidence(w, changes)), { code: 'knock_form_mismatch' });
    assert.equal(await w.store.get('knock_receipts', `native_ref_${w.handoff.reference}`), null);
  }
});

test('source mutation while provider reads fails the atomic revision precondition', async () => {
  const w = await started();
  await assert.rejects(verify(w, undefined, async () => {
    w.fake.put(`knock_events/${w.quoteId}`, { ...w.fake.get(`knock_events/${w.quoteId}`), quotedAmount: 3000 });
    return evidence(w);
  }), { code: 'knock_conflict' });
  assert.equal(await w.store.get('knock_receipts', `native_ref_${w.handoff.reference}`), null);
});

test('new edit/void events invalidate the receipt before the house summary is rebuilt', async () => {
  for (const type of ['knock.edit', 'knock.void']) {
    const w = await started();
    const houseBefore = w.fake.get('knock_houses/house-one');
    await assert.rejects(verify(w, undefined, async () => {
      await w.store.commit([write.create('knock_events', uuid(), { type, target: w.quoteId, houseId: 'house-one', repKey: 'rep.one', at: AFTER, quotedAmount: 2000 }),
        write.set('knock_form_revisions', 'house-one', { revision: uuid() })]);
      assert.deepEqual(w.fake.get('knock_houses/house-one'), houseBefore, 'summary deliberately has not rebuilt');
      return evidence(w);
    }), { code: 'knock_conflict' });
    assert.equal(await w.store.get('knock_receipts', `native_ref_${w.handoff.reference}`), null);
  }
});

test('transaction detects a new fence between guarded read and receipt commit; no wire verify operation', async () => {
  const w = await started(); let injected = false;
  const store = createKnockStore(ENV, async (env, url, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    if (url.endsWith(':commit') && body.transaction) {
      assert.ok(body.writes.every(item => !item.verify));
      if (!injected) { injected = true; w.fake.put('knock_form_revisions/house-one', { revision: uuid() }); }
    }
    return w.fake.fetcher(env, url, options);
  });
  await assert.rejects(verifyNativeFormReceipt(store, REP, DEFAULT_SETTINGS, verifyBody(w.handoff), w.config, AFTER, async () => evidence(w)), { code: 'knock_conflict' });
  assert.equal(injected, true);
  assert.equal(await w.store.get('knock_receipts', `native_ref_${w.handoff.reference}`), null);
});

test('a later direct sale blocks opening or verifying an existing walkthrough reference', async () => {
  const w = await started(world(), 'walkthrough_request');
  w.fake.put('knock_sales/later-sale', { repKey: 'rep.one', houseId: 'house-one', status: 'booked' });
  await assert.rejects(openNativeFormHandoff(w.store, REP, DEFAULT_SETTINGS, { action: 'open', reference: w.handoff.reference }, w.config, AFTER), { code: 'knock_form_channel_conflict' });
  await assert.rejects(verify(w, undefined, () => { throw Error('must not read'); }), { code: 'knock_form_channel_conflict' });
});

test('normal offline sync refuses Sold on a walkthrough-claimed house and atomically fences accepted edits', async () => {
  const w = await started(world(), 'walkthrough_request');
  w.fake.put('knock_reps/rep.one', { ...REP, permitListed: true });
  const sync = knockSyncHandlers({ storage: w.storage, now: () => new Date(AFTER) });
  const cookie = await cookieFor(ENV, 'Rep.One'), shiftId = uuid();
  const send = events => call(sync.post, post('/api/knock-sync', { events }, cookie), ENV);
  const start = await send([{ id: uuid(), type: 'shift.start', shiftId, cityKey: 'fort-collins', at: NOW }]);
  assert.equal(start.status, 200);
  const result = await send([{ id: uuid(), type: 'knock', shiftId, houseId: 'house-one', outcome: 'sold', at: AFTER }]);
  assert.equal(result.body.results[0].code, 'knock_form_channel_conflict');
  assert.equal((await w.store.list('knock_sales')).length, 0);
  const editSold = await send([{ id: uuid(), type: 'knock.edit', target: w.quoteId, houseId: 'house-one', outcome: 'sold', at: AFTER }]);
  assert.equal(editSold.body.results[0].code, 'knock_edit_sold');
  const edited = await send([{ id: uuid(), type: 'knock.edit', target: w.quoteId, houseId: 'house-one', outcome: 'look', quotedAmount: 2000, at: AFTER }]);
  assert.equal(edited.body.results[0].status, 'applied');
  const eventCommit = w.fake.calls.find(c => c.path === ':commit' && c.body.writes.some(item => item.update?.name.includes('/knock_form_revisions/')));
  assert.ok(eventCommit.body.writes.some(item => item.update?.name.includes('/knock_events/')));
  assert.ok(w.fake.get('knock_form_revisions/house-one').revision);
});

test('a GHL submission cannot replay across reps and handoffs', async () => {
  const w = await started(); await verify(w);
  const secondId = uuid();
  w.fake.put('knock_houses/house-two', { neighborhoodId: 'area', number: '999', street: 'SYNTHETIC ST' });
  w.fake.put(`knock_events/${secondId}`, { type: 'knock', outcome: 'look', repKey: 'rep.two', houseId: 'house-two', at: NOW });
  const rep = { ...REP, repKey: 'rep.two' };
  const context = await nativeFormContext(w.store, rep, DEFAULT_SETTINGS, 'house-two', w.config);
  const second = await createNativeFormHandoff(w.store, rep, DEFAULT_SETTINGS, { action: 'create', houseId: 'house-two', channel: 'direct_sale', source: context.sources[0] }, w.config, NOW);
  await assert.rejects(verifyNativeFormReceipt(w.store, rep, DEFAULT_SETTINGS, verifyBody(second.handoff), w.config, AFTER, () => { throw Error('must not reread'); }), { code: 'knock_form_replay' });
});

test('junk exclusion and saved direct-sale terms survive receipt verification without new earnings', async () => {
  const sale = { repKey: 'rep.one', houseId: 'house-one', status: 'booked', package: PACKAGES[1], ticket: 1600,
    customer: { phone: '+19705550100', email: 'synthetic@example.test' },
    commissionTerms: { contract: 'knock-collected-v3', package: PACKAGES[1], scope: { service: 'garage_only', channel: 'door_to_door', estimatorStacking: false, garageOnlyPackages: [PACKAGES[0]], junkRemovalPackages: [PACKAGES[1]] } } };
  const w = world({ 'knock_sales/sale-one': sale });
  const before = w.fake.get('knock_sales/sale-one');
  const result = await createNativeFormHandoff(w.store, REP, DEFAULT_SETTINGS, await requestFor(w, 'direct_sale', 'sale', 'sale-one'), w.config, NOW);
  w.handoff = result.handoff;
  const read = async () => evidence(w, { contact: { phone: sale.customer.phone, email: sale.customer.email } });
  await verify(w, undefined, read);
  assert.deepEqual(w.fake.get('knock_sales/sale-one'), before);
  assert.equal(commissionEligibility(sale), 'excluded');
  assert.deepEqual(saleCommissions([sale], DEFAULT_SETTINGS.commission), []);
  await assert.rejects(verifyNativeFormReceipt(w.store, REP, DEFAULT_SETTINGS, { ...verifyBody(w.handoff), submissionId: 'newSubmission' }, w.config, AFTER,
    async () => evidence(w, { contact: { phone: '+13035550111', email: 'other@example.test' } })), { code: 'knock_form_replay' });
});

test('saved sale requires the same verified contact email and phone', async () => {
  const w = world({ 'knock_sales/sale-one': { repKey: 'rep.one', houseId: 'house-one', status: 'booked', ticket: 1600,
    customer: { phone: '+19705550100', email: 'synthetic@example.test' } } });
  const result = await createNativeFormHandoff(w.store, REP, DEFAULT_SETTINGS, await requestFor(w, 'direct_sale', 'sale', 'sale-one'), w.config, NOW);
  w.handoff = result.handoff;
  await assert.rejects(verify(w, undefined, async () => evidence(w, { contact: { phone: '+13035550111', email: 'synthetic@example.test' } })), { code: 'knock_form_mismatch' });
});

test('provider adapter only performs bounded GETs and filters broad q results by exact IDs', async () => {
  const w = await started(), calls = [], ev = evidence(w);
  const reader = nativeFormReader(w.config.integration, { fetcher: async (input, options) => {
    const url = new URL(input); calls.push({ url, options });
    return Response.json(url.pathname === '/forms/submissions' ? { submissions: [{ ...ev.row, contactId: 'foreign' }, ev.row], meta: { nextPage: 2 } } : { contact: ev.contact });
  } });
  await verify(w, undefined, reader);
  assert.equal(calls.length, 2);
  for (const c of calls) { assert.equal(c.options.method, 'GET'); assert.equal(c.url.origin, 'https://services.leadconnectorhq.com'); assert.equal(c.options.redirect, 'error'); }
  assert.equal(calls[0].url.searchParams.get('formId'), w.config.forms.direct_sale.formId);
  assert.equal(calls[0].url.searchParams.get('q'), 'syntheticContact');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-existing-token');
});

test('missing exact provider result, duplicate result and forbidden scope fail closed', async () => {
  for (const response of [Response.json({ submissions: [] }), Response.json({ submissions: [1, 2] }), new Response('', { status: 403 })]) {
    const reader = nativeFormReader(nativeFormConfig(configDocument(), ENV).integration, { fetcher: async () => response });
    await assert.rejects(reader({ formId: 'syntheticForm0', contactId: 'contact', submissionId: 'submission', createdAt: NOW, expiresAt: AFTER }), { code: 'knock_form_provider_unavailable' });
  }
});

test('offline records never enter native form transport; explicit retry uses the same server request', async () => {
  const w = world(), body = await requestFor(w); let online = false, pending = false, calls = 0, loseOpen = true;
  const session = createNativeFormSession({ houseId: 'house-one', online: () => online, pending: () => pending,
    api: async (_path, options) => {
      calls++;
      if (options.body.action === 'create') return createNativeFormHandoff(w.store, REP, DEFAULT_SETTINGS, options.body, w.config, NOW);
      if (loseOpen) { loseOpen = false; throw Error('connection lost'); }
      return openNativeFormHandoff(w.store, REP, DEFAULT_SETTINGS, options.body, w.config, NOW);
    } });
  await assert.rejects(session.begin('direct_sale', body.source), /Offline/); assert.equal(calls, 0);
  online = true; pending = true;
  await assert.rejects(session.begin('direct_sale', body.source), /not been sent/); assert.equal(calls, 0);
  await assert.rejects(session.open('kf_' + '0'.repeat(32)), /not been sent/); assert.equal(calls, 0);
  await assert.rejects(session.verify('kf_' + '0'.repeat(32), 'contact', 'submission'), /not been sent/); assert.equal(calls, 0);
  pending = false;
  await assert.rejects(session.begin('direct_sale', body.source), /connection lost/);
  const retried = await session.begin('direct_sale', body.source);
  assert.ok(retried.launch.url); assert.equal((await w.store.list('knock_form_handoffs')).length, 1);
});

test('iframe load, error and timeout never mark submission and send no referrer', async () => {
  const w = await started(); const result = await openNativeFormHandoff(w.store, REP, DEFAULT_SETTINGS, { action: 'open', reference: w.handoff.reference }, w.config, NOW);
  let timeout;
  const doc = { createElement(tag) { return { tag, attrs: {}, events: {}, children: [], setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this[k]; }, addEventListener(k, v) { this.events[k] = v; }, append(...nodes) { this.children.push(...nodes); } }; } };
  const frame = nativeFrame(result.launch, w.handoff.reference, { document: doc, setTimer: fn => { timeout = fn; return 1; }, clearTimer() {} });
  const [status, iframe] = frame.element.children;
  assert.equal(iframe.attrs.referrerpolicy, 'no-referrer');
  iframe.events.load(); assert.match(status.textContent, /does not confirm submission/);
  timeout(); assert.match(status.textContent, /check its receipt/);
  iframe.events.error(); assert.match(status.textContent, /not been verified/);
  assert.deepEqual(Object.keys(iframe.events).sort(), ['error', 'load']);
  assert.equal(await w.store.get('knock_receipts', `native_ref_${w.handoff.reference}`), null);
  frame.dispose(); assert.equal(iframe.src, undefined);
});

test('native module is cached for the offline shell, separate from sale and setter ledgers', () => {
  const source = fs.readFileSync(new URL('../crew/knock-native-form.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /startSale|logSold|\.enqueue\(|postMessage|addEventListener\(['"]message/);
  assert.match(fs.readFileSync(new URL('../crew/sw.js', import.meta.url), 'utf8'), /'\/crew\/knock-native-form\.js'/);
  assert.match(fs.readFileSync(new URL('../crew/knock-app.js', import.meta.url), 'utf8'), /import\('\.\/knock-native-form\.js'\)/);
});
