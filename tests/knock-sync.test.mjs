import test from 'node:test';
import assert from 'node:assert/strict';
import { knockSyncHandlers } from '../functions/api/knock-sync.js';
import { knockTerritoryHandlers } from '../functions/api/knock-territory.js';
import { knockMeHandlers } from '../functions/api/knock-me.js';
import { call, cookieFor, get, knockEnv, knockWorld, post, uuid } from './helpers/knock-fixture.mjs';

// 11:00 am in Fort Collins on Tuesday 2026-10-06; sunset is 6:34 pm.
const NOW = Date.parse('2026-10-06T17:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
const MIN = 60000;

function seed() {
  const houses = {};
  for (const n of [2900, 2902, 2904, 2906, 2908]) {
    houses[`knock_houses/h-${n}-blue-leaf-dr`] = { neighborhoodId: 'english-ranch', street: 'BLUE LEAF DR', number: String(n), lat: 40.53 + n / 1e6, lng: -105.02, updatedAt: '2026-10-01T00:00:00.000Z' };
  }
  houses['knock_houses/h-10-premium-ct'] = { neighborhoodId: 'kechter-farm', street: 'PREMIUM CT', number: '10', lat: 40.5, lng: -105.0, updatedAt: '2026-10-01T00:00:00.000Z' };
  houses['knock_houses/h-1-other-st'] = { neighborhoodId: 'westchase', street: 'OTHER ST', number: '1', lat: 40.5, lng: -105.0, updatedAt: '2026-10-01T00:00:00.000Z' };
  return {
    'knock_neighborhoods/english-ranch': { name: 'English Ranch', tier: 'Volume', status: 'open', cityKey: 'fort-collins', holdReason: '' },
    'knock_neighborhoods/kechter-farm': { name: 'Kechter Farm', tier: 'Premium', status: 'open', cityKey: 'fort-collins', holdReason: '' },
    'knock_neighborhoods/westchase': { name: 'Westchase', tier: 'Premium', status: 'open', cityKey: 'fort-collins', holdReason: '' },
    'knock_reps/rep.one': { repKey: 'rep.one', username: 'Rep.One', displayName: 'Rep One', role: 'knocker', status: 'active', permitListed: true, premiumCleared: false, leadKey: '' },
    'knock_assignments/rep.one__english-ranch__all': { repKey: 'rep.one', neighborhoodId: 'english-ranch', street: '', active: true, assignedAt: '2026-10-01T00:00:00.000Z' },
    'knock_assignments/rep.one__kechter-farm__all': { repKey: 'rep.one', neighborhoodId: 'kechter-farm', street: '', active: true, assignedAt: '2026-10-01T00:00:00.000Z' },
    ...houses,
  };
}

async function setup({ now = NOW } = {}) {
  const env = knockEnv();
  const world = knockWorld(seed());
  let clock = now;
  const sync = knockSyncHandlers({ storage: world.storage, now: () => new Date(clock) });
  const territory = knockTerritoryHandlers({ storage: world.storage, now: () => new Date(clock) });
  const me = knockMeHandlers({ storage: world.storage, now: () => new Date(clock) });
  const cookie = await cookieFor(env, 'Rep.One');
  const send = events => call(sync.post, post('/api/knock-sync', { events }, cookie), env);
  return { env, world, sync, territory, me, cookie, send, setClock: value => { clock = value; } };
}

const shiftStart = (shiftId, at = NOW) => ({ id: uuid(), type: 'shift.start', shiftId, cityKey: 'fort-collins', at: iso(at) });
const knock = (shiftId, n, outcome, at, extra = {}) => ({ id: uuid(), type: 'knock', shiftId, houseId: `h-${n}-blue-leaf-dr`, outcome, at: iso(at), carOutside: false, ...extra });

test('a shift and five doors sync once, update the houses, the shift and the day, and replay as duplicates', async () => {
  const { world, send } = await setup();
  const shiftId = uuid();
  const batch = [
    shiftStart(shiftId),
    knock(shiftId, 2900, 'no_answer', NOW + 2 * MIN),
    knock(shiftId, 2902, 'not_interested', NOW + 4 * MIN, { carOutside: true }),
    knock(shiftId, 2904, 'come_back', NOW + 6 * MIN, { comeBackAt: '2026-10-07T00:30:00.000Z' }),
    knock(shiftId, 2906, 'look', NOW + 8 * MIN, { quotedAmount: 1450, carOutside: true }),
    knock(shiftId, 2908, 'skipped_sign', NOW + 10 * MIN),
  ];
  const first = await send(batch);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.results.map(r => r.status), Array(6).fill('applied'));
  assert.equal(first.body.houses.length, 5);
  assert.equal(world.fake.get('knock_houses/h-2906-blue-leaf-dr').summary.lastOutcome, 'look');
  assert.equal(world.fake.get('knock_houses/h-2906-blue-leaf-dr').summary.quotedAmount, 1450);
  assert.equal(world.fake.get('knock_houses/h-2904-blue-leaf-dr').summary.comeBackAt, '2026-10-07T00:30:00.000Z');
  assert.deepEqual(world.fake.get('knock_houses/h-2908-blue-leaf-dr').noKnock.source, 'sign', 'a no-soliciting sign blocks the house for good');
  const shift = world.fake.get(`knock_shifts/${shiftId}`);
  assert.deepEqual([shift.doors, shift.lastHouseId, shift.endedAt], [4, 'h-2908-blue-leaf-dr', null]);
  assert.equal(first.body.shift.id, shiftId);
  const day = world.fake.get('knock_days/rep.one_2026-10-06');
  assert.deepEqual([day.doors, day.answers, day.looks, day.sales, day.skipped], [4, 3, 1, 0, 1]);
  assert.deepEqual([day.car.answers, day.car.looks, day.noCar.answers], [2, 1, 1]);

  const events = [...world.fake.documents.keys()].filter(path => path.startsWith('knock_events/')).length;
  const again = await send(batch);
  assert.deepEqual(again.body.results.map(r => r.status), Array(6).fill('duplicate'));
  assert.equal([...world.fake.documents.keys()].filter(path => path.startsWith('knock_events/')).length, events, 'knocks are append-only and never stored twice');

  const tampered = await send([{ ...batch[1], outcome: 'sold' }]);
  assert.equal(tampered.body.results[0].code, 'knock_event_conflict');
});

test('a full batch of 25 doors on 25 houses stays far under the per-request storage call budget', async () => {
  const { world, send } = await setup();
  for (let n = 3000; n < 3050; n += 2) world.fake.put(`knock_houses/h-${n}-blue-leaf-dr`, { neighborhoodId: 'english-ranch', street: 'BLUE LEAF DR', number: String(n), lat: 40.53, lng: -105.02, updatedAt: '2026-10-01T00:00:00.000Z' });
  const shiftId = uuid();
  await send([shiftStart(shiftId)]);
  const before = world.fake.calls.length;
  const doors = Array.from({ length: 25 }, (_, i) => knock(shiftId, 3000 + i * 2, i % 3 ? 'no_answer' : 'not_interested', NOW + (i + 1) * 20000));
  const result = await send(doors);
  assert.deepEqual(result.body.results.map(r => r.status), Array(25).fill('applied'));
  assert.equal(result.body.houses.length, 25);
  const calls = world.fake.calls.length - before;
  assert.ok(calls <= 30, `a 25-door sync used ${calls} storage calls (Cloudflare's smallest plan allows 50 subrequests)`);
  assert.equal(world.fake.get('knock_days/rep.one_2026-10-06').doors, 25);
});

test('doors need a shift, an assignment and an unlocked neighborhood', async () => {
  const { send } = await setup();
  const noShift = await send([knock(uuid(), 2900, 'no_answer', NOW)]);
  assert.equal(noShift.body.results[0].code, 'knock_shift_missing');
  const shiftId = uuid();
  const result = await send([
    shiftStart(shiftId),
    { id: uuid(), type: 'knock', shiftId, houseId: 'h-1-other-st', outcome: 'no_answer', at: iso(NOW + MIN) },
    { id: uuid(), type: 'knock', shiftId, houseId: 'h-10-premium-ct', outcome: 'no_answer', at: iso(NOW + 2 * MIN) },
    { id: uuid(), type: 'knock', shiftId, houseId: 'h-404-nowhere', outcome: 'no_answer', at: iso(NOW + 3 * MIN) },
    { id: uuid(), type: 'knock', shiftId, houseId: 'h-2900-blue-leaf-dr', outcome: 'maybe', at: iso(NOW + 4 * MIN) },
    { id: uuid(), type: 'knock', shiftId, houseId: 'h-2900-blue-leaf-dr', outcome: 'no_answer', at: iso(NOW + 30 * MIN) },
  ]);
  assert.deepEqual(result.body.results.map(r => r.code || r.status), ['applied', 'knock_not_assigned', 'knock_locked', 'knock_house_missing', 'knock_outcome_invalid', 'knock_event_future']);
});

test('after sunset a finishing door is flagged for the admin, and a door after the grace is flagged outside hours', async () => {
  const sunset = Date.parse('2026-10-07T00:34:00.000Z');
  const { world, send, setClock } = await setup({ now: sunset - 30 * MIN });
  const shiftId = uuid();
  await send([shiftStart(shiftId, sunset - 30 * MIN), knock(shiftId, 2900, 'no_answer', sunset - 10 * MIN)]);
  setClock(sunset + 30 * MIN);
  const late = await send([knock(shiftId, 2902, 'look', sunset + 5 * MIN, { afterEnd: true }), knock(shiftId, 2904, 'no_answer', sunset + 20 * MIN)]);
  assert.deepEqual(late.body.results.map(r => r.flags), [['after_sunset'], ['outside_hours']]);
  const stored = [...world.fake.documents.keys()].filter(p => p.startsWith('knock_events/')).map(p => world.fake.get(p)).filter(e => e.type === 'knock');
  assert.deepEqual(stored.map(e => e.flags).filter(f => f.length), [['after_sunset'], ['outside_hours']]);
  assert.equal(world.fake.get('knock_days/rep.one_2026-10-06').flaggedDoors, 2);
});

test('admins see flagged doors to review, newest first, with the rep and the address', async () => {
  const { knockAdminHandlers } = await import('../functions/api/knock-admin.js');
  const sunset = Date.parse('2026-10-07T00:34:00.000Z');
  const { world, send, setClock, env } = await setup({ now: sunset - 30 * MIN });
  const shiftId = uuid();
  await send([shiftStart(shiftId, sunset - 30 * MIN), knock(shiftId, 2900, 'no_answer', sunset - 10 * MIN)]);
  setClock(sunset + 30 * MIN);
  await send([knock(shiftId, 2902, 'look', sunset + 5 * MIN, { afterEnd: true }), knock(shiftId, 2904, 'no_answer', sunset + 20 * MIN)]);
  const admin = knockAdminHandlers({ storage: world.storage, now: () => new Date(sunset + 30 * MIN) });
  const view = await call(admin.get, get('/api/knock-admin?view=flags', await cookieFor(env, 'ZacB')), env);
  assert.deepEqual(view.body.flags.map(f => [f.address, f.flags, f.rep]), [['2904 BLUE LEAF DR', ['outside_hours'], 'Rep One'], ['2902 BLUE LEAF DR', ['after_sunset'], 'Rep One']]);
  assert.equal((await call(admin.get, get('/api/knock-admin?view=flags', await cookieFor(env, 'Rep.One')), env)).status, 403);
});

test('undo appends a void, edit appends a replacement, and both rebuild the house, shift and day', async () => {
  const { world, send } = await setup();
  const shiftId = uuid();
  const first = knock(shiftId, 2900, 'not_interested', NOW + MIN);
  const sign = knock(shiftId, 2902, 'skipped_sign', NOW + 2 * MIN);
  await send([shiftStart(shiftId), first, sign]);
  assert.equal(world.fake.get('knock_houses/h-2902-blue-leaf-dr').noKnock.source, 'sign');

  const edit = await send([{ id: uuid(), type: 'knock.edit', target: first.id, houseId: first.houseId, outcome: 'come_back', comeBackAt: '2026-10-08T23:00:00.000Z', carOutside: true, at: iso(NOW + 3 * MIN) }]);
  assert.equal(edit.body.results[0].status, 'applied');
  const edited = world.fake.get('knock_houses/h-2900-blue-leaf-dr').summary;
  assert.deepEqual([edited.lastOutcome, edited.comeBackAt, edited.carOutside], ['come_back', '2026-10-08T23:00:00.000Z', true]);

  const undo = await send([{ id: uuid(), type: 'knock.void', target: sign.id, houseId: sign.houseId, at: iso(NOW + 4 * MIN) }]);
  assert.equal(undo.body.results[0].status, 'applied');
  assert.equal(world.fake.get('knock_houses/h-2902-blue-leaf-dr').noKnock, null, 'undoing a mistaken sign tap makes the house knockable again');
  assert.equal(world.fake.get('knock_houses/h-2902-blue-leaf-dr').summary.lastOutcome, null);
  assert.equal(world.fake.get(`knock_shifts/${shiftId}`).doors, 1);
  const day = world.fake.get('knock_days/rep.one_2026-10-06');
  assert.deepEqual([day.doors, day.answers, day.skipped], [1, 1, 0]);

  const editSold = await send([{ id: uuid(), type: 'knock.edit', target: first.id, houseId: first.houseId, outcome: 'sold', at: iso(NOW + 5 * MIN) }]);
  assert.equal(editSold.body.results[0].code, 'knock_edit_sold');
  const strangers = await send([{ id: uuid(), type: 'knock.void', target: uuid(), houseId: first.houseId, at: iso(NOW + 5 * MIN) }]);
  assert.equal(strangers.body.results[0].code, 'knock_target_missing');
});

test('breaks are excluded from knocking time, and a new shift ends one left open', async () => {
  const { world, send, setClock } = await setup();
  const shiftId = uuid();
  setClock(NOW + 55 * MIN);
  await send([
    shiftStart(shiftId),
    knock(shiftId, 2900, 'no_answer', NOW + 10 * MIN),
    { id: uuid(), type: 'shift.break_start', shiftId, at: iso(NOW + 20 * MIN) },
    { id: uuid(), type: 'shift.break_end', shiftId, at: iso(NOW + 50 * MIN) },
  ]);
  const later = uuid();
  setClock(NOW + 85 * MIN);
  const result = await send([{ id: uuid(), type: 'shift.end', shiftId, at: iso(NOW + 60 * MIN) }]);
  assert.equal(result.body.results[0].status, 'applied');
  const ended = world.fake.get(`knock_shifts/${shiftId}`);
  assert.deepEqual([ended.endedAt, ended.endReason, ended.breaks.length], [iso(NOW + 60 * MIN), 'manual', 1]);
  assert.equal(world.fake.get('knock_days/rep.one_2026-10-06').knockingMs, 30 * MIN);

  const open = uuid();
  await send([shiftStart(open, NOW + 70 * MIN), knock(open, 2902, 'no_answer', NOW + 75 * MIN)]);
  const replacing = await send([shiftStart(later, NOW + 80 * MIN)]);
  assert.equal(replacing.body.results[0].status, 'applied');
  assert.deepEqual([world.fake.get(`knock_shifts/${open}`).endReason, world.fake.get(`knock_shifts/${open}`).endedAt], ['replaced', iso(NOW + 75 * MIN)]);
});

test('an inactive or unpermitted rep cannot sync or start a shift, and the territory API serves only assigned unlocked houses', async () => {
  const { world, send, territory, cookie, env } = await setup();
  const houses = await call(territory.get, get('/api/knock-territory', cookie), env);
  assert.deepEqual(houses.body.houses.map(h => h.id).sort(), ['h-2900-blue-leaf-dr', 'h-2902-blue-leaf-dr', 'h-2904-blue-leaf-dr', 'h-2906-blue-leaf-dr', 'h-2908-blue-leaf-dr']);
  assert.equal(houses.body.neighborhoods.find(n => n.id === 'kechter-farm').locked, true);
  assert.equal(JSON.stringify(houses.body).includes('owner'), false, 'houses carry addresses and outcomes only');

  world.fake.put('knock_reps/rep.one', { ...world.fake.get('knock_reps/rep.one'), permitListed: false });
  const unpermitted = await send([shiftStart(uuid())]);
  assert.equal(unpermitted.body.results[0].code, 'knock_shift_not_allowed');
  world.fake.put('knock_reps/rep.one', { ...world.fake.get('knock_reps/rep.one'), status: 'inactive' });
  const inactive = await send([shiftStart(uuid())]);
  assert.deepEqual([inactive.status, inactive.body.code], [403, 'knock_rep_inactive']);
  assert.equal((await call(territory.get, get('/api/knock-territory', cookie), env)).status, 403);
});
