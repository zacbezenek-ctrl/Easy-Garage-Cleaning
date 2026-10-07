import test from 'node:test';
import assert from 'node:assert/strict';
import { knockAdminHandlers } from '../functions/api/knock-admin.js';
import { knockTerritoryHandlers } from '../functions/api/knock-territory.js';
import { knockSyncHandlers } from '../functions/api/knock-sync.js';
import { call, cookieFor, get, knockEnv, knockWorld, post, uuid } from './helpers/knock-fixture.mjs';

const NOW = Date.parse('2026-10-06T17:00:00.000Z');

function seed() {
  const docs = {
    'knock_neighborhoods/english-ranch': { name: 'English Ranch', tier: 'Volume', status: 'open', cityKey: 'fort-collins', holdReason: '', plattedCount: 558, importedCount: 5, unitCount: 2 },
    'knock_neighborhoods/rigden-farm': { name: 'Rigden Farm', tier: 'Volume', status: 'open', cityKey: 'fort-collins', holdReason: '', plattedCount: 686 },
    'knock_reps/rep.one': { repKey: 'rep.one', username: 'Rep.One', displayName: 'Rep One', role: 'knocker', status: 'active', permitListed: true, premiumCleared: false },
    'knock_reps/rep.two': { repKey: 'rep.two', username: 'Rep.Two', displayName: 'Rep Two', role: 'knocker', status: 'active', permitListed: true, premiumCleared: false },
  };
  const add = (id, nbhd, street, number, extra = {}) => { docs[`knock_houses/${id}`] = { neighborhoodId: nbhd, street, number, unit: '', hasUnit: false, lat: 40.55, lng: -105.03, updatedAt: '2026-10-01T00:00:00.000Z', ...extra }; };
  add('h-1-a-st', 'english-ranch', 'A ST', '1');
  add('h-2-a-st', 'english-ranch', 'A ST', '2');
  add('h-3-b-st', 'english-ranch', 'B ST', '3');
  add('h-4-c-ct-ua', 'english-ranch', 'C CT', '4', { unit: 'A', hasUnit: true });
  add('h-4-c-ct-ub', 'english-ranch', 'C CT', '4', { unit: 'B', hasUnit: true });
  add('h-9-z-st', 'rigden-farm', 'Z ST', '9');
  return docs;
}

async function setup() {
  const env = knockEnv();
  const world = knockWorld(seed());
  let clock = NOW;
  const now = () => new Date(clock);
  const admin = knockAdminHandlers({ storage: world.storage, now });
  const territory = knockTerritoryHandlers({ storage: world.storage, now });
  const sync = knockSyncHandlers({ storage: world.storage, now });
  const cookies = { zac: await cookieFor(env, 'ZacB'), rep: await cookieFor(env, 'Rep.One'), two: await cookieFor(env, 'Rep.Two') };
  const act = body => call(admin.post, post('/api/knock-admin', body, cookies.zac), env);
  const houses = async cookie => (await call(territory.get, get('/api/knock-territory', cookie), env)).body;
  return { env, world, admin, territory, sync, cookies, act, houses, setClock: v => { clock = v; } };
}

test('reps see only their assignment: a whole neighborhood or single streets', async () => {
  const { act, houses, cookies } = await setup();
  assert.deepEqual((await houses(cookies.rep)).houses, []);
  await act({ action: 'assignment.set', repKey: 'rep.one', neighborhoodId: 'english-ranch' });
  await act({ action: 'assignment.set', repKey: 'rep.two', neighborhoodId: 'english-ranch', street: 'b st' });
  assert.equal((await houses(cookies.rep)).houses.length, 5);
  const two = await houses(cookies.two);
  assert.deepEqual(two.houses.map(h => h.id), ['h-3-b-st']);
  assert.deepEqual(two.neighborhoods[0].streets, ['B ST']);
  await act({ action: 'assignment.set', repKey: 'rep.one', neighborhoodId: 'english-ranch', active: false });
  assert.deepEqual((await houses(cookies.rep)).houses, [], 'unassigning removes the houses from the phone');
  const typo = await act({ action: 'assignment.set', repKey: 'rep.two', neighborhoodId: 'english-ranch', street: 'B STREET' });
  assert.deepEqual([typo.status, typo.body.code], [400, 'knock_unknown_street'], 'a street with no imported houses is refused');
});

test('unit addresses can be excluded in one tap and come back individually', async () => {
  const { act, houses, cookies, world } = await setup();
  await act({ action: 'assignment.set', repKey: 'rep.one', neighborhoodId: 'english-ranch' });
  const excluded = await act({ action: 'neighborhood.excludeUnits', neighborhoodId: 'english-ranch', excluded: true });
  assert.equal(excluded.body.changed, 2);
  assert.deepEqual((await houses(cookies.rep)).houses.map(h => h.id).sort(), ['h-1-a-st', 'h-2-a-st', 'h-3-b-st']);
  await act({ action: 'house.exclude', houseIds: ['h-4-c-ct-ua'], excluded: false });
  assert.equal(world.fake.get('knock_houses/h-4-c-ct-ua').excluded, false);
  assert.equal((await houses(cookies.rep)).houses.length, 4);
});

test('the City no-solicitation list previews, applies and blocks those houses for good', async () => {
  const { act, houses, cookies, world } = await setup();
  await act({ action: 'assignment.set', repKey: 'rep.one', neighborhoodId: 'english-ranch' });
  const text = '1 A Street, Fort Collins, CO 80525\n4 C Ct\n77 Nowhere Rd';
  const preview = await act({ action: 'noknock.import', text, apply: false });
  assert.deepEqual([preview.body.matched, preview.body.unmatched], [3, ['77 Nowhere Rd']]);
  assert.equal(world.fake.get('knock_houses/h-1-a-st').noKnock, undefined, 'a preview changes nothing');
  const applied = await act({ action: 'noknock.import', text, apply: true, requestId: uuid() });
  assert.equal(applied.body.applied, true);
  const phone = (await houses(cookies.rep)).houses;
  assert.deepEqual(phone.filter(h => h.noKnock).map(h => [h.id, h.noKnock.source]).sort(), [['h-1-a-st', 'city'], ['h-4-c-ct-ua', 'city'], ['h-4-c-ct-ub', 'city']]);
  const cleared = await act({ action: 'noknock.clear', houseId: 'h-1-a-st' });
  assert.equal(cleared.status, 200);
  assert.equal(world.fake.get('knock_houses/h-1-a-st').noKnock, null);
});

test('hold locks a neighborhood for everyone until an admin clears it, and coverage shows who is there now', async () => {
  const { act, houses, cookies, env, sync, admin } = await setup();
  await act({ action: 'assignment.set', repKey: 'rep.one', neighborhoodId: 'english-ranch' });
  await act({ action: 'neighborhood.update', id: 'english-ranch', changes: { status: 'hold', holdReason: 'Testing hold' } });
  const held = await houses(cookies.rep);
  assert.deepEqual([held.houses.length, held.neighborhoods[0].locked, held.neighborhoods[0].lockReason], [0, true, 'On hold: Testing hold']);
  await act({ action: 'neighborhood.update', id: 'english-ranch', changes: { status: 'open' } });
  assert.equal((await houses(cookies.rep)).houses.length, 5);

  const shiftId = uuid();
  await call(sync.post, post('/api/knock-sync', { events: [
    { id: uuid(), type: 'shift.start', shiftId, cityKey: 'fort-collins', at: new Date(NOW - 20 * 60000).toISOString() },
    { id: uuid(), type: 'knock', shiftId, houseId: 'h-1-a-st', outcome: 'look', quotedAmount: 900, at: new Date(NOW - 10 * 60000).toISOString() },
    { id: uuid(), type: 'knock', shiftId, houseId: 'h-2-a-st', outcome: 'no_answer', at: new Date(NOW - 5 * 60000).toISOString() },
  ] }, cookies.rep), env);
  const view = await call(admin.get, get('/api/knock-admin?view=coverage', cookies.zac), env);
  const er = view.body.coverage.find(n => n.id === 'english-ranch');
  assert.deepEqual([er.total, er.knocked, er.percent, er.looks, er.hereNow], [5, 2, 40, 1, ['Rep One']]);
  assert.deepEqual(er.streets.find(s => s.street === 'A ST').hereNow, ['Rep One']);
  assert.equal(view.body.coverage.find(n => n.id === 'rigden-farm').knocked, 0);
  assert.equal((await call(admin.get, get('/api/knock-admin?view=coverage', cookies.rep), env)).status, 403, 'coverage is admin only');
});
