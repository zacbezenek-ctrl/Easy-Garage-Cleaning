import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { nativeFormConfig, FORM_CHANNEL_VALUES } from '../functions/_lib/knock-form-config.js';
import { nativeFormReader } from '../functions/_lib/knock-form-provider.js';
import { createNativeFormHandoff, nativeFormContext, openNativeFormHandoff, verifyNativeFormReceipt, discoverNativeFormReceipt } from '../functions/_lib/knock-form-handoff.js';
import { nativeRecoveryContext, recoverNativeFormClaim } from '../functions/_lib/knock-form-recovery.js';
import { knockRecoveryHandlers } from '../functions/api/knock-form-recovery.js';
import { knockFormHandlers } from '../functions/api/knock-form-handoff.js';
import { nativeHouseClaimId } from '../functions/_lib/knock-form-claims.js';
import { createNativeFormSession } from '../crew/knock-native-form.js';
import { DEFAULT_SETTINGS } from '../crew/knock-settings.js';
import { call, cookieFor, get, post, knockEnv, knockWorld, uuid } from './helpers/knock-fixture.mjs';

const NOW = '2026-10-15T20:00:00.000Z', AFTER = '2026-10-15T20:01:00.000Z', LATE = '2026-10-17T20:00:00.000Z';
const REP = { repKey: 'rep.one', status: 'active', role: 'knocker' }, ADMIN = { user: 'ZacB', businessAccess: true };
const ENV = knockEnv({ HIGHLEVEL_API_KEY: 'synthetic-token', HIGHLEVEL_LOCATION_ID: 'syntheticLocation' });
function document() {
  return { enabled: true, locationId: ENV.HIGHLEVEL_LOCATION_ID, forms: Object.fromEntries(Object.entries(FORM_CHANNEL_VALUES).map(([channel, channelValue]) => {
    const form = { formId: 'syntheticForm', referenceFieldId: 'syntheticRef', referenceQueryKey: 'handoff_ref',
      url: 'https://links.easygaragecleaning.com/widget/form/syntheticForm', channelFieldId: 'syntheticChannel', channelValue };
    return [channel, { ...form, acceptance: { ...form, locationId: ENV.HIGHLEVEL_LOCATION_ID, prefillVerified: true, formsReadonlyVerified: true,
      submissionReadVerified: true, channelSubmissionVerified: true, verifiedBy: 'synthetic-test', verifiedAt: NOW, evidence: 'synthetic-only' } }];
  })) };
}
function world() {
  const quoteId = uuid(), doc = document();
  const { fake, storage } = knockWorld({ 'knock_reps/rep.one': REP, 'knock_reps/rep.two': { ...REP, repKey: 'rep.two' },
    'knock_neighborhoods/area': { name: 'Test area', tier: 'Volume', status: 'open', cityKey: 'fort-collins' },
    'knock_assignments/one': { repKey: REP.repKey, neighborhoodId: 'area', active: true },
    'knock_assignments/two': { repKey: 'rep.two', neighborhoodId: 'area', active: true },
    'knock_houses/house': { neighborhoodId: 'area', number: '123', street: 'SYNTHETIC' },
    [`knock_events/${quoteId}`]: { type: 'knock', outcome: 'look', repKey: REP.repKey, houseId: 'house', at: NOW },
    'knock_settings/native_forms': doc });
  return { fake, storage, store: storage(ENV), quoteId, config: nativeFormConfig(doc, ENV, Date.parse(NOW)) };
}
async function start(w = world(), channel = 'direct_sale', rep = REP) {
  const source = (await nativeFormContext(w.store, rep, DEFAULT_SETTINGS, 'house', w.config)).sources[0];
  const body = { action: 'create', houseId: 'house', channel, source };
  const result = await createNativeFormHandoff(w.store, rep, DEFAULT_SETTINGS, body, w.config, NOW);
  return { ...w, handoff: result.handoff, createBody: body };
}
const evidence = w => ({ row: { id: 'submissionOne', contactId: 'contactOne', formId: 'syntheticForm', createdAt: AFTER,
  others: { syntheticRef: w.handoff.reference, syntheticChannel: FORM_CHANNEL_VALUES[w.handoff.channel] } },
  contact: { id: 'contactOne', locationId: ENV.HIGHLEVEL_LOCATION_ID } });
const verify = (w, ev = evidence(w), now = AFTER) => verifyNativeFormReceipt(w.store, REP, DEFAULT_SETTINGS,
  { action: 'verify', reference: w.handoff.reference, contactId: ev.row.contactId, submissionId: ev.row.id }, w.config, now, async () => ev);
const releaseBody = async (w, extra = {}) => ({ action: 'release', houseId: 'house', expectedGeneration: 0, requestId: uuid(),
  expectedSnapshot: (await nativeRecoveryContext(w.store, ADMIN, 'house')).snapshot,
  reason: 'Rep confirmed request was abandoned.', confirmation: 'release_abandoned_forms', ...extra });
const discover = (w, reader, now = AFTER, rep = REP) => discoverNativeFormReceipt(w.store, rep, DEFAULT_SETTINGS,
  { action: 'discover', reference: w.handoff.reference }, w.config, now, reader.discover);
function provider(w, pages) {
  const calls = [], ev = evidence(w);
  const read = nativeFormReader(w.config.integration, { fetcher: async (input, options) => {
    const url = new URL(input); calls.push({ url, options });
    return Response.json(url.pathname === '/forms/submissions' ? pages(Number(url.searchParams.get('page'))) : { contact: ev.contact });
  } });
  return { read, calls };
}
const page = (rows, total = rows.length, currentPage = 1, nextPage = null) => ({ submissions: rows, meta: { total, currentPage, nextPage, prevPage: currentPage > 1 ? currentPage - 1 : null } });

test('one form requires accepted exact channel values and shared correlation mapping', () => {
  assert.equal(world().config.enabled, true);
  for (const mutate of [
    d => { delete d.forms.direct_sale.channelFieldId; }, d => { d.forms.direct_sale.channelValue = 'Walkthrough request'; },
    d => { d.forms.walkthrough_request.channelFieldId = 'differentField'; }, d => { d.forms.direct_sale.acceptance.channelSubmissionVerified = false; },
    d => { d.forms.direct_sale.referenceFieldId = 'differentReference'; }, d => { d.forms.walkthrough_request.acceptance.channelValue = 'Direct D2D quote'; },
  ]) { const d = document(); mutate(d); assert.equal(nativeFormConfig(d, ENV, Date.parse(NOW)).enabled, false); }
});

test('tampered, missing and ambiguous submitted channels cannot verify or award anything', async () => {
  for (const value of [undefined, null, '', 'Walkthrough request', ['Direct D2D quote'], { value: 'Direct D2D quote' }]) {
    const w = await start(), ev = evidence(w); ev.row.others.syntheticChannel = value;
    await assert.rejects(verify(w, ev), { code: 'knock_form_mismatch' });
    for (const c of ['knock_sales', 'knock_setters', 'knock_payouts']) assert.deepEqual(await w.store.list(c), []);
    assert.equal(await w.store.get('knock_receipts', `native_ref_${w.handoff.reference}`), null);
  }
});

test('discovery scans all documented pages before accepting an exact reference and contact', async () => {
  const w = await start(), ev = evidence(w);
  const unrelated = Array.from({ length: 100 }, (_, i) => ({ ...ev.row, id: `unrelated${i}`, others: { syntheticRef: 'other' } }));
  const { read, calls } = provider(w, p => p === 1 ? page(unrelated, 101, 1, 2) : page([ev.row], 101, 2));
  const result = await discover(w, read);
  assert.equal(result.discovery, 'verified'); assert.equal(result.handoff.states.submissionVerified, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.filter(c => c.url.pathname === '/forms/submissions').map(c => c.url.searchParams.get('page')), ['1', '2']);
  for (const { url, options } of calls) {
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(url.origin, 'https://services.leadconnectorhq.com');
    assert.equal(url.searchParams.has('q'), false); assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
  }
  assert.equal((await discover(w, { discover: () => { throw Error('should reuse receipt'); } })).duplicate, true);
});

test('delayed visibility stays pending and can later verify an in-window submission after launch expiry', async () => {
  const w = await start(); let visible = false;
  const { read } = provider(w, () => page(visible ? [evidence(w).row] : []));
  const pending = await discover(w, read, LATE);
  assert.equal(pending.discovery, 'not_visible_yet'); assert.equal(pending.handoff.states.submissionVerified, false);
  visible = true;
  assert.equal((await discover(w, read, LATE)).discovery, 'verified');
  await assert.rejects(openNativeFormHandoff(w.store, REP, DEFAULT_SETTINGS, { action: 'open', reference: w.handoff.reference }, w.config, LATE), { code: 'knock_form_expired' });
});

test('missing, inconsistent, repeated and over-limit pagination fails closed', async () => {
  for (const make of [
    w => ({ submissions: [evidence(w).row] }),
    w => page([evidence(w).row], 501, 1, 2), w => page([evidence(w).row], 2, 1, 1),
    w => page([evidence(w).row], 2), w => page([], 2, 1, 2),
    w => p => page([{ ...evidence(w).row, id: 'same', others: {} }], 2, p, p === 1 ? 2 : null),
    w => p => page([{ ...evidence(w).row, id: `item${p}`, others: {} }], p === 1 ? 2 : 3, p, p === 1 ? 2 : null),
    w => p => page([{ ...evidence(w).row, id: `item${p}`, others: {} }], 6, p, p + 1),
  ]) {
    const w = await start(), data = make(w), { read, calls } = provider(w, typeof data === 'function' ? data : () => data);
    await assert.rejects(discover(w, read), { code: 'knock_form_search_incomplete' });
    assert.ok(calls.length <= 5); assert.equal(await w.store.get('knock_receipts', `native_ref_${w.handoff.reference}`), null);
  }
});

test('multiple references, a wrong form, an ambiguous reference and channel spoofing fail discovery', async () => {
  for (const [change, code] of [
    [rows => [...rows, { ...rows[0], id: 'second' }], 'knock_form_multiple_receipts'],
    [rows => [{ ...rows[0], formId: 'anotherForm' }], 'knock_form_mismatch'],
    [rows => [{ ...rows[0], others: { ...rows[0].others, syntheticRef: [rows[0].others.syntheticRef] } }], 'knock_form_mismatch'],
    [rows => [{ ...rows[0], others: { ...rows[0].others, syntheticChannel: 'Walkthrough request' } }], 'knock_form_mismatch'],
  ]) { const w = await start(), { read } = provider(w, () => page(change([evidence(w).row]))); await assert.rejects(discover(w, read), { code }); }
});

test('provider denial and oversized response do not mark submission', async () => {
  for (const response of [new Response('', { status: 403 }), new Response(' '.repeat(1048577))]) {
    const w = await start(), read = nativeFormReader(w.config.integration, { fetcher: async () => response });
    await assert.rejects(discover(w, read), { code: 'knock_form_provider_unavailable' });
  }
});

test('opaque reference never grants another authenticated rep access to discovery', async () => {
  const w = await start();
  await assert.rejects(discover(w, { discover: () => { throw Error('provider must not be called'); } }, AFTER, { ...REP, repKey: 'rep.two' }), { code: 'knock_form_owner' });
});

test('manager recovery requires server authorization, same origin and explicit confirmed reason', async () => {
  const w = await start(), handlers = knockRecoveryHandlers({ storage: w.storage, now: () => new Date(LATE) });
  const repCookie = await cookieFor(ENV, 'Rep.One'), adminCookie = await cookieFor(ENV, 'ZacB');
  assert.equal((await call(handlers.get, get('/api/knock-form-recovery'), ENV)).status, 401);
  assert.equal((await call(handlers.post, post('/api/knock-form-recovery', await releaseBody(w), repCookie), ENV)).status, 403);
  assert.equal((await call(handlers.post, post('/api/knock-form-recovery', await releaseBody(w), adminCookie, { origin: 'https://evil.test' }), ENV)).status, 403);
  for (const extra of [{ reason: '' }, { expectedGeneration: 4 }, { confirmation: '' }, { repKey: 'rep.two' }])
    assert.notEqual((await call(handlers.post, post('/api/knock-form-recovery', await releaseBody(w, extra), adminCookie), ENV)).status, 200);
  const queue = await call(handlers.get, get('/api/knock-form-recovery', adminCookie), ENV);
  assert.equal(queue.body.rows[0].houseId, 'house');
  assert.equal((await w.store.get('knock_receipts', await nativeHouseClaimId('house'))).state, 'active');
});

test('release is audited and idempotent, preserves handoff and invalidates every old reference', async () => {
  const w = await start(), original = w.fake.get(`knock_form_handoffs/${w.handoff.reference}`), body = await releaseBody(w);
  const result = await recoverNativeFormClaim(w.store, ADMIN, body, LATE);
  assert.equal(result.recovery.recordedBy, 'ZacB'); assert.equal(result.recovery.reason, body.reason);
  assert.deepEqual(result.recovery.revokedReferences, [w.handoff.reference]);
  assert.deepEqual(w.fake.get(`knock_form_handoffs/${w.handoff.reference}`), original);
  assert.equal((await recoverNativeFormClaim(w.store, ADMIN, body, LATE)).duplicate, true);
  await assert.rejects(recoverNativeFormClaim(w.store, ADMIN, { ...body, reason: 'Different recovery reason.' }, LATE), { code: 'knock_form_recovery_conflict' });
  await assert.rejects(openNativeFormHandoff(w.store, REP, DEFAULT_SETTINGS, { action: 'open', reference: w.handoff.reference }, w.config, LATE), { code: 'knock_form_revoked' });
  await assert.rejects(verify(w, evidence(w), LATE), { code: 'knock_form_revoked' });
  await assert.rejects(discover(w, { discover: () => { throw Error('must not read'); } }, LATE), { code: 'knock_form_revoked' });
  assert.equal((await nativeFormContext(w.store, REP, DEFAULT_SETTINGS, 'house', w.config)).handoffs[0].status, 'revoked');
  for (const c of ['knock_sales', 'knock_setters', 'knock_payouts']) assert.deepEqual(await w.store.list(c), []);
});

test('only a new explicit request may choose a different channel after release; old submission stays revoked', async () => {
  const w = await start(); await recoverNativeFormClaim(w.store, ADMIN, await releaseBody(w), LATE);
  assert.equal((await w.store.get('knock_receipts', await nativeHouseClaimId('house'))).state, 'released');
  const next = await createNativeFormHandoff(w.store, REP, DEFAULT_SETTINGS, { ...w.createBody, channel: 'walkthrough_request' }, w.config, LATE);
  assert.notEqual(next.handoff.reference, w.handoff.reference);
  const claim = await w.store.get('knock_receipts', await nativeHouseClaimId('house'));
  assert.equal(claim.generation, 1); assert.equal(claim.channel, 'walkthrough_request');
  await assert.rejects(verify(w, evidence(w), LATE), { code: 'knock_form_revoked' });
});

test('verified receipts and saved sales block release without changing history', async () => {
  for (const kind of ['receipt', 'sale']) {
    const w = await start();
    if (kind === 'receipt') await verify(w); else w.fake.put('knock_sales/sale', { houseId: 'house', repKey: REP.repKey, status: 'booked' });
    const before = w.fake.get(`knock_form_handoffs/${w.handoff.reference}`);
    const context = await nativeRecoveryContext(w.store, ADMIN, 'house'); assert.equal(context.recoverable, false);
    await assert.rejects(recoverNativeFormClaim(w.store, ADMIN, await releaseBody(w), LATE), { code: 'knock_form_recovery_conflict' });
    assert.deepEqual(w.fake.get(`knock_form_handoffs/${w.handoff.reference}`), before);
  }
});

test('release racing receipt verification prevents the old receipt from committing', async () => {
  const w = await start(), ev = evidence(w);
  await assert.rejects(verifyNativeFormReceipt(w.store, REP, DEFAULT_SETTINGS, { action: 'verify', reference: w.handoff.reference,
    contactId: ev.row.contactId, submissionId: ev.row.id }, w.config, AFTER, async () => {
    await recoverNativeFormClaim(w.store, ADMIN, await releaseBody(w), AFTER); return ev;
  }));
  assert.equal(await w.store.get('knock_receipts', `native_ref_${w.handoff.reference}`), null);
});

test('concurrent managers cannot both release the same generation', async () => {
  const w = await start();
  const results = await Promise.allSettled([recoverNativeFormClaim(w.store, ADMIN, await releaseBody(w), LATE), recoverNativeFormClaim(w.store, ADMIN, await releaseBody(w), LATE)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await w.store.list('knock_receipts')).filter(r => r.kind === 'native_form_recovery').length, 1);
});

test('discovery API uses the signed-in rep and client needs no provider IDs or offline transport', async () => {
  const w = await start(), { read } = provider(w, () => page([evidence(w).row]));
  const handlers = knockFormHandlers({ storage: w.storage, reader: () => read, now: () => new Date(AFTER) });
  const result = await call(handlers.post, post('/api/knock-form-handoff', { action: 'discover', reference: w.handoff.reference }, await cookieFor(ENV, 'Rep.One')), ENV);
  assert.equal(result.body.handoff.states.submissionVerified, true);
  let online = false, pending = false; const calls = [];
  const session = createNativeFormSession({ online: () => online, pending: () => pending, api: async (path, options) => calls.push({ path, options }), houseId: 'house' });
  await assert.rejects(session.discover(w.handoff.reference), /Offline/); online = true; pending = true;
  await assert.rejects(session.discover(w.handoff.reference), /Sync/); pending = false;
  await session.discover(w.handoff.reference);
  assert.deepEqual(calls[0].options.body, { action: 'discover', reference: w.handoff.reference });
  const source = fs.readFileSync(new URL('../crew/knock-native-form.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /placeholder: 'GHL (contact|submission) ID'/);
});

test('public manual verification cannot select one receipt to bypass discovery ambiguity', async () => {
  const w = await start(), ev = evidence(w), { read } = provider(w, () => page([ev.row, { ...ev.row, id: 'second', contactId: 'otherContact' }]));
  const handlers = knockFormHandlers({ storage: w.storage, reader: () => read, now: () => new Date(AFTER) });
  const cookie = await cookieFor(ENV, 'Rep.One');
  assert.equal((await call(handlers.post, post('/api/knock-form-handoff', { action: 'discover', reference: w.handoff.reference }, cookie), ENV)).body.code, 'knock_form_multiple_receipts');
  const manual = await call(handlers.post, post('/api/knock-form-handoff', { action: 'verify', reference: w.handoff.reference, contactId: ev.row.contactId, submissionId: ev.row.id }, cookie), ENV);
  assert.equal(manual.status, 400);
  assert.equal(await w.store.get('knock_receipts', `native_ref_${w.handoff.reference}`), null);
});

test('a stale manager snapshot cannot release a new handoff in the same generation', async () => {
  const w = await start(), body = await releaseBody(w), secondId = uuid();
  w.fake.put(`knock_events/${secondId}`, { type: 'knock', outcome: 'look', repKey: REP.repKey, houseId: 'house', at: AFTER });
  const source = (await nativeFormContext(w.store, REP, DEFAULT_SETTINGS, 'house', w.config)).sources.find(s => s.id === secondId);
  await createNativeFormHandoff(w.store, REP, DEFAULT_SETTINGS, { ...w.createBody, source }, w.config, AFTER);
  await assert.rejects(recoverNativeFormClaim(w.store, ADMIN, body, LATE), { code: 'knock_form_recovery_conflict' });
  assert.equal((await nativeRecoveryContext(w.store, ADMIN, 'house')).references.length, 2);
  assert.equal((await w.store.list('knock_receipts')).filter(r => r.kind === 'native_form_recovery').length, 0);
});

test('a stale manager snapshot cannot release a changed canonical source', async () => {
  const w = await start(), body = await releaseBody(w);
  w.fake.put(`knock_events/${w.quoteId}`, { ...w.fake.get(`knock_events/${w.quoteId}`), quotedAmount: 2700 });
  await assert.rejects(recoverNativeFormClaim(w.store, ADMIN, body, LATE), { code: 'knock_form_recovery_conflict' });
});

test('new handoff racing the recovery commit aborts release atomically', async () => {
  const w = await start(), body = await releaseBody(w), secondId = uuid();
  w.fake.put(`knock_events/${secondId}`, { type: 'knock', outcome: 'look', repKey: REP.repKey, houseId: 'house', at: AFTER });
  // Inspect after the source exists; only the new handoff is concurrent with commit.
  const currentBody = { ...body, ...await releaseBody(w), requestId: body.requestId };
  const source = (await nativeFormContext(w.store, REP, DEFAULT_SETTINGS, 'house', w.config)).sources.find(s => s.id === secondId);
  const racing = { ...w.store, commit: async writes => {
    await createNativeFormHandoff(w.store, REP, DEFAULT_SETTINGS, { ...w.createBody, source }, w.config, AFTER);
    return w.store.commit(writes);
  } };
  await assert.rejects(recoverNativeFormClaim(racing, ADMIN, currentBody, LATE));
  assert.equal((await w.store.list('knock_receipts')).filter(r => r.kind === 'native_form_recovery').length, 0);
  assert.equal((await w.store.get('knock_receipts', await nativeHouseClaimId('house'))).state, 'active');
});

test('all five documented pages may succeed at the 500-row cap', async () => {
  const w = await start(), ev = evidence(w), { read, calls } = provider(w, p => page(Array.from({ length: 100 }, (_, i) =>
    p === 5 && i === 99 ? ev.row : { ...ev.row, id: `page${p}row${i}`, others: {} }), 500, p, p < 5 ? p + 1 : null));
  assert.equal((await discover(w, read)).discovery, 'verified'); assert.equal(calls.length, 6);
});
