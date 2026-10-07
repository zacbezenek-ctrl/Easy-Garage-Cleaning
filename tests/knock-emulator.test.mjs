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
