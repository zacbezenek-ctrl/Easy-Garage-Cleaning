import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { previewSeed, PASSWORD } from './knock-dev-server.mjs';
import { KNOCK_COLLECTIONS } from '../functions/_lib/knock-store.js';

// Canvassing against the real Firestore emulator and the real firestore.rules:
//   EGC_FIREBASE_EMULATOR_TEST=1 node scripts/emulator-exec.mjs --project demo-egc-knock "node --test tests/knock-emulator.test.mjs"
const enabled = process.env.EGC_FIREBASE_EMULATOR_TEST === '1';
const project = () => (/^demo-[a-z0-9-]+$/.test(process.env.GCLOUD_PROJECT || '') ? process.env.GCLOUD_PROJECT : 'demo-egc-knock');
const modules = () => (process.env.EGC_FIREBASE_TEST_MODULES ? createRequire(resolve(process.env.EGC_FIREBASE_TEST_MODULES, 'package.json')) : createRequire(new URL('../package.json', import.meta.url)));

test('no phone, rep, lead or admin SDK session can read or write any canvassing collection', { skip: !enabled, timeout: 120000 }, async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST || '';
  assert.match(host, /^(?:127\.0\.0\.1|localhost):\d{2,5}$/, 'This test may only connect to a loopback Firestore emulator.');
  const require = modules();
  const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing');
  require('firebase/firestore').setLogLevel('silent');
  const [hostname, port] = host.split(':');
  const rules = await readFile(new URL('../firestore.rules', import.meta.url), 'utf8');
  const environment = await initializeTestEnvironment({ projectId: project(), firestore: { host: hostname, port: Number(port), rules } });
  const claims = (username, role, business = false) => ({ username, role, business_access: business, assignment_version: 1, assignment_identities: [username], assignment_keys: [username] });
  const id = `rules-${randomUUID().slice(0, 8)}`;
  try {
    await environment.withSecurityRulesDisabled(async context => {
      for (const collection of KNOCK_COLLECTIONS) await context.firestore().doc(`${collection}/${id}`).set({ repKey: 'rep.one', customer: { name: 'Synthetic' } });
    });
    const sessions = [
      ['signed out', environment.unauthenticatedContext()],
      ['rep', environment.authenticatedContext('rep-one', claims('rep.one', 'sales'))],
      ['crew lead', environment.authenticatedContext('lead-one', claims('lead.one', 'crew_lead'))],
      ['owner', environment.authenticatedContext('owner', claims('zacb', 'owner', true))],
    ];
    for (const [name, context] of sessions) {
      const db = context.firestore();
      for (const collection of KNOCK_COLLECTIONS) {
        await assertFails(db.doc(`${collection}/${id}`).get(), `${name} read ${collection}`);
        await assertFails(db.collection(collection).where('repKey', '==', 'rep.one').get(), `${name} query ${collection}`);
        await assertFails(db.doc(`${collection}/${id}-new`).set({ repKey: 'rep.one' }), `${name} write ${collection}`);
      }
    }
  } finally { await environment.cleanup(); }
});

test('through the API on the emulator a rep reads and writes only their own work; admins read every customer', { skip: !enabled, timeout: 180000 }, async () => {
  const { startEmulatorHarness } = await import('./helpers/emulator-harness.mjs');
  const NOW = '2026-10-06T17:00:00.000Z';
  const hub = await startEmulatorHarness({ projectId: project(), password: PASSWORD, now: NOW,
    users: [['ZacB', 'Zac', 'owner'], ['Rep.One', 'Rep One', 'sales'], ['Rep.Two', 'Rep Two', 'sales'], ['Lead.One', 'Lead One', 'sales']] });
  try {
    const seed = previewSeed();
    // Rep Two works only Canyon Wren Ct; Rep One the whole neighborhood.
    seed['knock_reps/rep.two'] = { ...seed['knock_reps/rep.two'], status: 'active', permitListed: true };
    seed['knock_assignments/rep.two__english-ranch__canyon-wren-ct'] = { repKey: 'rep.two', neighborhoodId: 'english-ranch', street: 'CANYON WREN CT', active: true, assignedAt: NOW };
    await hub.seed(db => Promise.all(Object.entries(seed).map(([path, data]) => db.doc(path).set(data))));
    const json = async response => ({ status: response.status, body: await response.json() });
    const at = minutes => new Date(Date.parse(NOW) + minutes * 60000).toISOString();
    const shiftId = randomUUID(), knockId = randomUUID(), saleId = randomUUID();
    const synced = await json(await hub.api('/api/knock-sync', { user: 'Rep.One', body: { events: [
      { id: randomUUID(), type: 'shift.start', shiftId, cityKey: 'fort-collins', at: at(-30) },
      { id: randomUUID(), type: 'knock', shiftId, houseId: 'h-2900-blue-leaf-dr', outcome: 'no_answer', at: at(-20) },
      { id: knockId, type: 'knock', shiftId, houseId: 'h-2902-blue-leaf-dr', outcome: 'sold', at: at(-10) },
      { id: saleId, type: 'sale', knockId, houseId: 'h-2902-blue-leaf-dr', at: at(-9), ticket: 1600, package: 'Quick Clear',
        customer: { name: 'Synthetic Emulator', phone: '9705550100', email: 'synthetic@example.com' },
        checklist: { contractSigned: true, noticesHanded: true, rightToCancelTold: true }, jobDate: '2026-10-10', textConsent: false },
    ] } }));
    assert.equal(synced.status, 200, JSON.stringify(synced.body));
    assert.deepEqual(synced.body.results.map(r => r.status), ['applied', 'applied', 'applied', 'applied'], JSON.stringify(synced.body));
    assert.equal((await hub.readDoc(`knock_sales/${saleId}`)).cancelDeadlineDate, '2026-10-09');
    assert.equal((await hub.readDoc('knock_houses/h-2902-blue-leaf-dr')).summary.lastOutcome, 'sold');

    const mine = await json(await hub.api('/api/knock-reports?view=my-sales', { user: 'Rep.One' }));
    assert.equal(mine.body.sales[0].customer.name, 'Synthetic Emulator');
    const theirs = await json(await hub.api('/api/knock-reports?view=my-sales', { user: 'Rep.Two' }));
    assert.deepEqual(theirs.body.sales, [], 'another rep never sees the customer');
    const territory = await json(await hub.api('/api/knock-territory', { user: 'Rep.Two' }));
    assert.ok(territory.body.houses.length > 0 && territory.body.houses.every(house => house.street === 'CANYON WREN CT'), 'a street assignment shows only that street');
    const outside = await json(await hub.api('/api/knock-sync', { user: 'Rep.Two', body: { events: [
      { id: randomUUID(), type: 'shift.start', shiftId: randomUUID(), cityKey: 'fort-collins', at: at(-5) },
    ] } }));
    const twoShift = outside.body.results[0].status;
    assert.equal(twoShift, 'applied');
    const voidOthers = await json(await hub.api('/api/knock-sync', { user: 'Rep.Two', body: { events: [
      { id: randomUUID(), type: 'knock.void', target: knockId, houseId: 'h-2902-blue-leaf-dr', at: at(-1) },
    ] } }));
    assert.equal(voidOthers.body.results[0].code, 'knock_target_missing', 'a rep cannot change another rep\'s door');

    assert.equal((await hub.api('/api/knock-admin?view=sales', { user: 'Rep.One' })).status, 403);
    assert.equal((await hub.api('/api/knock-admin', { user: 'Rep.One', body: { action: 'settings.update', settings: {} } })).status, 403);
    assert.equal((await hub.api('/api/knock-admin?view=export&kind=commission', { user: 'Lead.One' })).status, 403);
    const sales = await json(await hub.api('/api/knock-admin?view=sales', { user: 'ZacB' }));
    assert.equal(sales.body.sales[0].customer.email, 'synthetic@example.com');
    assert.deepEqual(hub.serverErrors, []);
  } finally { await hub.close(); }
});

test('native form source guards and receipts commit against real Firestore without provider writes', { skip: !enabled, timeout: 120000 }, async () => {
  const { startEmulatorHarness } = await import('./helpers/emulator-harness.mjs');
  const { createKnockStore, write } = await import('../functions/_lib/knock-store.js');
  const { DEFAULT_SETTINGS } = await import('../crew/knock-settings.js');
  const { nativeFormConfig } = await import('../functions/_lib/knock-form-config.js');
  const { nativeFormContext, createNativeFormHandoff, verifyNativeFormReceipt } = await import('../functions/_lib/knock-form-handoff.js');
  const now = '2026-10-15T20:00:00.000Z', later = '2026-10-15T20:01:00.000Z';
  const hub = await startEmulatorHarness({ projectId: project(), now });
  const rep = { repKey: 'rep.one', role: 'knocker', status: 'active' }, quoteId = randomUUID();
  try {
    await hub.seed(db => Promise.all(Object.entries({
      'knock_neighborhoods/native-area': { name: 'Native test', tier: 'Volume', status: 'open', cityKey: 'fort-collins' },
      'knock_assignments/native-assignment': { repKey: rep.repKey, neighborhoodId: 'native-area', active: true },
      'knock_houses/native-house': { neighborhoodId: 'native-area', number: '123', street: 'SYNTHETIC ST' },
      [`knock_events/${quoteId}`]: { type: 'knock', outcome: 'look', houseId: 'native-house', repKey: rep.repKey, at: now, quotedAmount: 1600 },
    }).map(([path, data]) => db.doc(path).set(data))));
    const store = createKnockStore(hub.env);
    const forms = Object.fromEntries(['direct_sale', 'walkthrough_request'].map((channel, index) => {
      const form = { formId: `syntheticForm${index}`, url: `https://links.easygaragecleaning.com/widget/form/syntheticForm${index}`,
        referenceFieldId: `syntheticField${index}`, referenceQueryKey: 'handoff_ref' };
      return [channel, { ...form, acceptance: { ...form, locationId: 'syntheticLocation', prefillVerified: true,
        submissionReadVerified: true, formsReadonlyVerified: true, verifiedBy: 'synthetic-test', verifiedAt: now, evidence: 'synthetic-only' } }];
    }));
    const config = nativeFormConfig({ enabled: true, locationId: 'syntheticLocation', forms }, { HIGHLEVEL_LOCATION_ID: 'syntheticLocation', HIGHLEVEL_API_KEY: 'synthetic-only' }, Date.parse(now));
    const context = await nativeFormContext(store, rep, DEFAULT_SETTINGS, 'native-house', config);
    const body = { action: 'create', houseId: 'native-house', channel: 'walkthrough_request', source: context.sources[0] };
    const created = await createNativeFormHandoff(store, rep, DEFAULT_SETTINGS, body, config, now);
    assert.equal(created.handoff.status, 'awaiting_submission');
    assert.equal((await createNativeFormHandoff(store, rep, DEFAULT_SETTINGS, body, config, now)).duplicate, true);
    const receiptBody = { action: 'verify', reference: created.handoff.reference, contactId: 'syntheticContact', submissionId: 'syntheticSubmission' };
    const reader = async () => ({ row: { id: receiptBody.submissionId, formId: forms.walkthrough_request.formId,
      contactId: receiptBody.contactId, createdAt: later, others: { syntheticField1: created.handoff.reference } },
      contact: { id: receiptBody.contactId, locationId: 'syntheticLocation' } });
    const verified = await verifyNativeFormReceipt(store, rep, DEFAULT_SETTINGS, receiptBody, config, later, reader);
    assert.equal(verified.handoff.states.submissionVerified, true);
    assert.equal(verified.handoff.states.walkthroughLinked, false);
    assert.equal((await verifyNativeFormReceipt(store, rep, DEFAULT_SETTINGS, receiptBody, config, later, reader)).duplicate, true);
    await store.commit([write.set('knock_form_revisions', 'native-house', { revision: randomUUID() })]);
    await assert.rejects(verifyNativeFormReceipt(store, rep, DEFAULT_SETTINGS, receiptBody, config, later, reader), { code: 'knock_form_revision' });
    assert.equal((await store.list('knock_sales')).length, 0);
    assert.equal((await store.list('knock_setters')).length, 0);
    assert.equal((await store.list('knock_payouts')).length, 0);
  } finally { await hub.close(); }
});

test('shared native form recovery revokes old receipts and permits only an explicit new request on real Firestore', { skip: !enabled, timeout: 120000 }, async () => {
  const { startEmulatorHarness } = await import('./helpers/emulator-harness.mjs');
  const { createKnockStore } = await import('../functions/_lib/knock-store.js');
  const { DEFAULT_SETTINGS } = await import('../crew/knock-settings.js');
  const { nativeFormConfig, FORM_CHANNEL_VALUES } = await import('../functions/_lib/knock-form-config.js');
  const { nativeFormContext, createNativeFormHandoff, discoverNativeFormReceipt, openNativeFormHandoff } = await import('../functions/_lib/knock-form-handoff.js');
  const { recoverNativeFormClaim, nativeRecoveryContext } = await import('../functions/_lib/knock-form-recovery.js');
  const now = '2026-10-15T20:00:00.000Z', later = '2026-10-15T20:01:00.000Z';
  const hub = await startEmulatorHarness({ projectId: project(), now });
  const rep = { repKey: 'rep.one', role: 'knocker', status: 'active' }, quoteId = randomUUID();
  try {
    await hub.seed(db => Promise.all(Object.entries({
      'knock_neighborhoods/recovery-area': { name: 'Recovery test', tier: 'Volume', status: 'open', cityKey: 'fort-collins' },
      'knock_assignments/recovery-assignment': { repKey: rep.repKey, neighborhoodId: 'recovery-area', active: true },
      'knock_houses/recovery-house': { neighborhoodId: 'recovery-area', number: '123', street: 'SYNTHETIC ST' },
      [`knock_events/${quoteId}`]: { type: 'knock', outcome: 'look', houseId: 'recovery-house', repKey: rep.repKey, at: now },
    }).map(([path, data]) => db.doc(path).set(data))));
    const store = createKnockStore(hub.env);
    const forms = Object.fromEntries(Object.entries(FORM_CHANNEL_VALUES).map(([channel, channelValue]) => {
      const form = { formId: 'syntheticShared', url: 'https://links.easygaragecleaning.com/widget/form/syntheticShared',
        referenceFieldId: 'syntheticRef', referenceQueryKey: 'handoff_ref', channelFieldId: 'syntheticChannel', channelValue };
      return [channel, { ...form, acceptance: { ...form, locationId: 'syntheticLocation', prefillVerified: true,
        submissionReadVerified: true, formsReadonlyVerified: true, channelSubmissionVerified: true, verifiedBy: 'synthetic-test', verifiedAt: now, evidence: 'synthetic-only' } }];
    }));
    const config = nativeFormConfig({ enabled: true, locationId: 'syntheticLocation', forms }, { HIGHLEVEL_LOCATION_ID: 'syntheticLocation', HIGHLEVEL_API_KEY: 'synthetic-only' }, Date.parse(now));
    assert.equal(config.enabled, true);
    const source = (await nativeFormContext(store, rep, DEFAULT_SETTINGS, 'recovery-house', config)).sources[0];
    const body = { action: 'create', houseId: 'recovery-house', channel: 'direct_sale', source };
    const old = (await createNativeFormHandoff(store, rep, DEFAULT_SETTINGS, body, config, now)).handoff;
    const recovery = await recoverNativeFormClaim(store, { user: 'ZacB', businessAccess: true }, { action: 'release', houseId: 'recovery-house',
      expectedGeneration: 0, expectedSnapshot: (await nativeRecoveryContext(store, { user: 'ZacB', businessAccess: true }, 'recovery-house')).snapshot,
      requestId: randomUUID(), reason: 'Synthetic abandoned request only.', confirmation: 'release_abandoned_forms' }, later);
    assert.deepEqual(recovery.recovery.revokedReferences, [old.reference]);
    await assert.rejects(openNativeFormHandoff(store, rep, DEFAULT_SETTINGS, { action: 'open', reference: old.reference }, config, later), { code: 'knock_form_revoked' });
    const next = (await createNativeFormHandoff(store, rep, DEFAULT_SETTINGS, { ...body, channel: 'walkthrough_request' }, config, later)).handoff;
    const verified = await discoverNativeFormReceipt(store, rep, DEFAULT_SETTINGS, { action: 'discover', reference: next.reference }, config, later,
      async () => ({ row: { id: 'syntheticSubmission', contactId: 'syntheticContact', formId: 'syntheticShared', createdAt: later,
        others: { syntheticRef: next.reference, syntheticChannel: 'Walkthrough request' } }, contact: { id: 'syntheticContact', locationId: 'syntheticLocation' } }));
    assert.equal(verified.handoff.states.submissionVerified, true);
    assert.equal((await store.list('knock_form_handoffs')).length, 2);
    for (const name of ['knock_sales', 'knock_setters', 'knock_payouts']) assert.deepEqual(await store.list(name), []);
  } finally { await hub.close(); }
});

test('the Larimer import stores a neighborhood on the emulator and reads its count back', { skip: !enabled, timeout: 120000 }, async () => {
  const { startEmulatorHarness } = await import('./helpers/emulator-harness.mjs');
  const { buildHouses, storeNeighborhood } = await import('../scripts/knock-import-larimer.mjs');
  const { seedNeighborhoodDocs } = await import('../functions/_lib/knock-seed.js');
  const { createKnockStore } = await import('../functions/_lib/knock-store.js');
  const hub = await startEmulatorHarness({ projectId: project(), password: PASSWORD });
  try {
    const nbhd = seedNeighborhoodDocs('2026-10-06T16:00:00.000Z').find(n => n.id === 'kechter-farm');
    const points = Array.from({ length: 12 }, (_, i) => ({ attributes: { OBJECTID: i + 1, FULLADDRESS: `${6101 + i * 2} SPEARMINT CT`, ADDRESSNUM: String(6101 + i * 2), IS_INCORPORATED_NAME: 'FORT COLLINS' }, geometry: { x: -105.022 - i / 1e4, y: 40.5026 } }));
    const imported = buildHouses(nbhd, points, '2026-10-06T16:00:00.000Z');
    const store = createKnockStore(hub.env);
    await storeNeighborhood(store, nbhd, { ...imported, center: { lat: 40.5026, lng: -105.0226 }, bbox: null }, '2026-10-06T16:00:00.000Z');
    const back = await store.query('knock_houses', { where: [['neighborhoodId', '==', 'kechter-farm']], select: ['neighborhoodId'] });
    assert.equal(back.length, 12);
    assert.equal((await hub.readDoc('knock_neighborhoods/kechter-farm')).importedCount, 12);
  } finally { await hub.close(); }
});
