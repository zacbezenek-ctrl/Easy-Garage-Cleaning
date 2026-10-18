import test from 'node:test';
import assert from 'node:assert/strict';
import { knockAdminHandlers } from '../functions/api/knock-admin.js';
import { knockTerritoryHandlers } from '../functions/api/knock-territory.js';
import { knockSyncHandlers } from '../functions/api/knock-sync.js';
import { knockFailure } from '../functions/_lib/knock-store.js';
import { loadSettings } from '../functions/_lib/knock-access.js';
import { DEFAULT_SETTINGS, mergeSettings, validateSettings } from '../crew/knock-settings.js';
import { approvedKnockSettings, call, cookieFor, get, knockEnv, knockWorld, post, uuid } from './helpers/knock-fixture.mjs';

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

test('a delta sync sends only changed houses, and still works before the knock_houses index exists', async () => {
  const { act, cookies, env, world } = await setup();
  await act({ action: 'assignment.set', repKey: 'rep.one', neighborhoodId: 'english-ranch' });
  await act({ action: 'house.exclude', houseIds: ['h-2-a-st'], excluded: false });
  const delta = async storage => {
    const handler = knockTerritoryHandlers({ storage, now: () => new Date(NOW + 60000) });
    return (await call(handler.get, get(`/api/knock-territory?since=${encodeURIComponent(new Date(NOW).toISOString())}`, cookies.rep), env)).body;
  };
  const queries = [];
  const noIndex = envArg => {
    const store = world.storage(envArg);
    return { ...store, query: (collection, q = {}) => {
      queries.push(collection);
      return q.where?.some(([field]) => field === 'updatedAt') ? Promise.reject(knockFailure('Canvassing storage is waiting for an index.', 503, 'knock_index_required')) : store.query(collection, q);
    } };
  };
  const withIndex = await delta(world.storage);
  assert.deepEqual([withIndex.full, withIndex.houses.map(h => h.id)], [false, ['h-2-a-st']]);
  const without = await delta(noIndex);
  assert.deepEqual([without.full, without.houses.map(h => h.id)], [false, ['h-2-a-st']], 'the same delta without the index');
  assert.equal(queries.filter(c => c === 'knock_houses').length, 2, 'one failed indexed read, then one plain read');
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

/* ---- Reps choosing their own neighborhood (settings.territory) ---- */

function claimSeed() {
  const docs = {
    'knock_neighborhoods/english-ranch': { name: 'English Ranch', tier: 'Volume', status: 'open', cityKey: 'fort-collins', holdReason: '', importedCount: 3, center: { lat: 40.556, lng: -105.036 }, bbox: [40.555, -105.037, 40.557, -105.035] },
    'knock_neighborhoods/rigden-farm': { name: 'Rigden Farm', tier: 'Volume', status: 'open', cityKey: 'fort-collins', holdReason: '', importedCount: 2 },
    'knock_neighborhoods/kechter-farm': { name: 'Kechter Farm', tier: 'Premium', status: 'open', cityKey: 'fort-collins', holdReason: '', importedCount: 1, center: { lat: 40.5, lng: -105.0 } },
    'knock_neighborhoods/harmony-club': { name: 'Harmony Club', tier: 'Volume', status: 'hold', cityKey: 'fort-collins', holdReason: 'Access not confirmed', importedCount: 1 },
    'knock_neighborhoods/timnath-ranch': { name: 'Timnath Ranch', tier: 'Volume', status: 'open', cityKey: 'timnath', holdReason: '', importedCount: 1 },
    'knock_neighborhoods/maple-hill': { name: 'Maple Hill', tier: 'Volume', status: 'open', cityKey: 'fort-collins', holdReason: '', importedCount: 0 },
    'knock_neighborhoods/trail-head': { name: 'Trail Head', tier: 'Volume', status: 'open', cityKey: 'fort-collins', holdReason: '', importedCount: 1, center: { lat: 40.6, lng: -105.0 } },
    'knock_reps/rep.one': { repKey: 'rep.one', username: 'Rep.One', displayName: 'Rep One', role: 'knocker', status: 'active', permitListed: true, premiumCleared: false },
    'knock_reps/rep.two': { repKey: 'rep.two', username: 'Rep.Two', displayName: 'Rep Two', role: 'knocker', status: 'active', permitListed: true, premiumCleared: false },
    'knock_reps/lead.one': { repKey: 'lead.one', username: 'Lead.One', displayName: 'Lead One', role: 'lead', status: 'active', permitListed: true, premiumCleared: true },
    'knock_assignments/lead.one__trail-head__all': { repKey: 'lead.one', neighborhoodId: 'trail-head', street: '', active: true, assignedAt: '2026-10-01T00:00:00.000Z', assignedBy: 'ZacB', endedAt: null },
  };
  const add = (id, nbhd, street, number, lat, lng) => { docs[`knock_houses/${id}`] = { neighborhoodId: nbhd, street, number, unit: '', hasUnit: false, lat, lng, updatedAt: '2026-10-01T00:00:00.000Z' }; };
  add('h-1-a-st', 'english-ranch', 'A ST', '1', 40.5555, -105.0365);
  add('h-2-a-st', 'english-ranch', 'A ST', '2', 40.5556, -105.0362);
  add('h-3-b-st', 'english-ranch', 'B ST', '3', 40.5565, -105.0355);
  add('h-9-z-st', 'rigden-farm', 'Z ST', '9', 40.53, -105.04);
  add('h-11-z-st', 'rigden-farm', 'Z ST', '11', 40.54, -105.04);
  add('h-5-p-ct', 'kechter-farm', 'P CT', '5', 40.5, -105.0);
  add('h-7-hold-ln', 'harmony-club', 'HOLD LN', '7', 40.52, -105.0);
  add('h-8-town-rd', 'timnath-ranch', 'TOWN RD', '8', 40.51, -104.98);
  add('h-4-trail-ct', 'trail-head', 'TRAIL CT', '4', 40.6, -105.0);
  return docs;
}

async function claimSetup({ storage = null, extra = {} } = {}) {
  const env = knockEnv();
  const world = knockWorld({ ...claimSeed(), ...extra });
  const now = () => new Date(NOW);
  const store = storage ? storage(world) : world.storage;
  const admin = knockAdminHandlers({ storage: store, now });
  const territory = knockTerritoryHandlers({ storage: store, now });
  const cookies = { zac: await cookieFor(env, 'ZacB'), rep: await cookieFor(env, 'Rep.One'), two: await cookieFor(env, 'Rep.Two'), lead: await cookieFor(env, 'Lead.One') };
  const claim = (cookie, neighborhoodId) => call(territory.post, post('/api/knock-territory', { action: 'claim', neighborhoodId }, cookie), env);
  const release = (cookie, neighborhoodId) => call(territory.post, post('/api/knock-territory', { action: 'release', neighborhoodId }, cookie), env);
  const available = async cookie => call(territory.get, get('/api/knock-territory?view=available', cookie), env);
  const houses = async cookie => (await call(territory.get, get('/api/knock-territory', cookie), env)).body;
  const act = body => call(admin.post, post('/api/knock-admin', body, cookies.zac), env);
  return { env, world, admin, territory, cookies, claim, release, available, houses, act };
}

const settingsDoc = territory => ({ 'knock_settings/current': { settings: { ...structuredClone(DEFAULT_SETTINGS), territory }, updatedAt: '2026-10-01T12:00:00Z', updatedBy: 'test-owner' } });

test('the available view lists the rep\'s areas and the ones they may claim, places each one and never names another rep', async () => {
  const { available, world, cookies } = await claimSetup();
  const view = await available(cookies.rep);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.deepEqual(view.body.neighborhoods.map(n => [n.id, n.claim]), [['english-ranch', 'open'], ['rigden-farm', 'open']]);
  assert.deepEqual(view.body.hidden, { hold: 1, town: 1, premium: 1, taken: 1, empty: 1 });
  assert.deepEqual(view.body.selfClaim, { enabled: true, max: 2, used: 0 });
  const er = view.body.neighborhoods[0];
  assert.deepEqual([er.center, er.bbox, er.importedCount, er.locked], [{ lat: 40.556, lng: -105.036 }, [40.555, -105.037, 40.557, -105.035], 3, false]);
  // Rigden Farm had no center: placed once from its houses and stored, so the next read scans no houses.
  assert.deepEqual(view.body.neighborhoods[1].center, { lat: 40.535, lng: -105.04 });
  assert.deepEqual([world.fake.get('knock_neighborhoods/rigden-farm').centerSource, world.fake.get('knock_neighborhoods/rigden-farm').bbox], ['sample', [40.53, -105.04, 40.54, -105.04]]);
  const scans = world.fake.queries('knock_houses').length;
  assert.equal(scans, 1, 'only the neighborhood without a center reads houses, once');
  await available(cookies.rep);
  assert.equal(world.fake.queries('knock_houses').length, scans, 'a stored center is never recomputed');
  assert.equal(JSON.stringify(view.body).match(/lead|Lead|street|number|h-\d/g), null, 'no other rep, street or house in the list');

  const lead = await available(cookies.lead);
  assert.deepEqual(lead.body.neighborhoods.map(n => [n.id, n.claim, n.source || '']), [['trail-head', 'mine', 'admin'], ['english-ranch', 'open', ''], ['kechter-farm', 'open', ''], ['rigden-farm', 'open', '']], 'Premium shows once cleared');
  assert.deepEqual(lead.body.hidden, { hold: 1, town: 1, premium: 0, taken: 0, empty: 1 });
});

test('a rep claims an open neighborhood: its houses download, it is theirs alone, and an admin sees and can remove the claim', async () => {
  const { claim, available, houses, act, admin, env, world, cookies } = await claimSetup();
  const claimed = await claim(cookies.rep, 'english-ranch');
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.deepEqual([claimed.body.claimed, claimed.body.used, claimed.body.max], [true, 1, 2]);
  const stored = world.fake.get('knock_assignments/rep.one__english-ranch__all');
  assert.deepEqual([stored.active, stored.source, stored.assignedBy, stored.street, stored.assignedAt], [true, 'self', 'Rep.One', '', new Date(NOW).toISOString()]);
  const mine = await houses(cookies.rep);
  assert.deepEqual(mine.houses.map(h => h.id).sort(), ['h-1-a-st', 'h-2-a-st', 'h-3-b-st']);
  assert.deepEqual([mine.neighborhoods[0].source, mine.neighborhoods[0].center], ['self', { lat: 40.556, lng: -105.036 }]);
  assert.deepEqual((await available(cookies.rep)).body.selfClaim.used, 1);
  assert.deepEqual((await claim(cookies.rep, 'english-ranch')).body.already, true, 'claiming twice is harmless');

  const two = await available(cookies.two);
  assert.deepEqual([two.body.neighborhoods.map(n => n.id), two.body.hidden.taken], [['rigden-farm'], 2]);
  const taken = await claim(cookies.two, 'english-ranch');
  assert.deepEqual([taken.status, taken.body.code], [409, 'knock_neighborhood_taken']);
  assert.equal(taken.body.error.includes('Rep One'), false, 'the other rep is not named');

  const view = await call(admin.get, get('/api/knock-admin?view=territory', cookies.zac), env);
  assert.deepEqual(view.body.assignments.filter(a => a.neighborhoodId === 'english-ranch').map(a => [a.repKey, a.source]), [['rep.one', 'self']]);
  const removed = await act({ action: 'assignment.set', repKey: 'rep.one', neighborhoodId: 'english-ranch', active: false });
  assert.equal(removed.status, 200);
  assert.deepEqual((await houses(cookies.rep)).houses, [], 'an admin removing the claim takes its houses off the phone');
  assert.equal((await claim(cookies.two, 'english-ranch')).status, 200, 'and frees it for another rep');
  // An admin assigning a whole neighborhood a rep picked makes it the admin's assignment.
  await act({ action: 'assignment.set', repKey: 'rep.two', neighborhoodId: 'english-ranch' });
  assert.equal(world.fake.get('knock_assignments/rep.two__english-ranch__all').source, 'admin');
  assert.deepEqual((await available(cookies.two)).body.selfClaim.used, 0);
});

test('claims respect holds, Premium clearance, town rules, imported houses, the per-rep limit and the setting', async () => {
  const { claim, cookies, act } = await claimSetup();
  const refused = async (id, code, pattern = null) => {
    const result = await claim(cookies.rep, id);
    assert.deepEqual([result.status >= 400, result.body.code], [true, code], `${id}: ${JSON.stringify(result.body)}`);
    if (pattern) assert.match(result.body.error, pattern);
    return result;
  };
  await refused('harmony-club', 'knock_locked', /On hold: Access not confirmed/);
  await refused('kechter-farm', 'knock_locked', /Premium/);
  await refused('timnath-ranch', 'knock_locked', /No knocking rules/);
  await refused('maple-hill', 'knock_neighborhood_empty');
  await refused('trail-head', 'knock_neighborhood_taken');
  assert.equal((await refused('nowhere', 'knock_neighborhood_missing')).status, 404);
  await refused('../x', 'knock_invalid_neighborhood');
  assert.equal((await claim(cookies.lead, 'kechter-farm')).status, 200, 'a Premium-cleared rep may claim Premium');

  assert.equal((await claim(cookies.rep, 'english-ranch')).status, 200);
  assert.equal((await claim(cookies.rep, 'rigden-farm')).status, 200);
  await act({ action: 'neighborhood.update', id: 'timnath-ranch', changes: { cityKey: 'fort-collins' } });
  const limit = await refused('timnath-ranch', 'knock_claim_limit', /2 neighborhoods at a time/);
  assert.deepEqual(limit.body.details, { max: 2, used: 2 });
  // An admin's assignment does not count against the rep's own claims.
  await act({ action: 'assignment.set', repKey: 'rep.one', neighborhoodId: 'rigden-farm' });
  assert.equal((await claim(cookies.rep, 'timnath-ranch')).status, 200);

  const off = await claimSetup({ extra: settingsDoc({ selfClaim: false, maxSelfClaims: 2 }) });
  const blocked = await off.claim(off.cookies.rep, 'english-ranch');
  assert.deepEqual([blocked.status, blocked.body.code], [403, 'knock_self_claim_off']);
  assert.deepEqual((await off.available(off.cookies.rep)).body.selfClaim, { enabled: false, max: 2, used: 0 });
  const one = await claimSetup({ extra: settingsDoc({ selfClaim: true, maxSelfClaims: 1 }) });
  assert.equal((await one.claim(one.cookies.rep, 'english-ranch')).status, 200);
  assert.equal((await one.claim(one.cookies.rep, 'rigden-farm')).body.code, 'knock_claim_limit');
});

// Holds every claim commit until `parties` claims reach it, so their reads all happen before any write. It has no time
// limit: a 2 s fallback timer once let the first claim commit alone when the other lagged (a stalled runner), and the
// expected knock_claim_conflict became knock_neighborhood_taken. It opens once; later commits pass straight through.
// `events` records each claim's arrival at the barrier and its write; `arrived(n)` resolves once n claims are waiting.
function racing(parties) {
  let waiting = [];
  const events = [], watchers = [];
  const storage = world => env => {
    const store = world.storage(env);
    return { ...store, async commit(writes) {
      if (waiting && writes.some(w => w.update?.name?.includes('/knock_assignments/'))) {
        events.push('wait');
        await new Promise(resolve => {
          waiting.push(resolve);
          watchers.filter(w => w.n <= waiting.length).forEach(w => w.resolve());
          if (waiting.length === parties) { const go = waiting; waiting = null; go.forEach(release => release()); }
        });
        events.push('write');
      }
      return store.commit(writes);
    } };
  };
  const arrived = n => new Promise(resolve => { if (!waiting || waiting.length >= n) resolve(); else watchers.push({ n, resolve }); });
  return Object.assign(storage, { events, arrived });
}

test('two reps claiming the same neighborhood at the same moment: exactly one gets it', async () => {
  const race = racing(2);
  const { claim, cookies, world } = await claimSetup({ storage: race });
  const results = await Promise.all([claim(cookies.rep, 'english-ranch'), claim(cookies.two, 'english-ranch')]);
  assert.deepEqual(race.events, ['wait', 'wait', 'write', 'write'], 'both claims read before either wrote');
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409], JSON.stringify(results.map(r => r.body)));
  assert.equal(results.find(r => r.status === 409).body.code, 'knock_claim_conflict');
  const holders = [...world.fake.documents.keys()].filter(path => path.startsWith('knock_assignments/') && path.includes('english-ranch') && world.fake.get(path).active);
  assert.equal(holders.length, 1, holders.join());
});

test('a claim that reached its commit first waits for the other however late it arrives, so the race result never depends on timing', async t => {
  const race = racing(2);
  const { claim, cookies, world } = await claimSetup({ storage: race });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = claim(cookies.rep, 'english-ranch');
  await race.arrived(1);
  // Rep Two's request is a minute late (a stalled runner); no timer lets Rep One's claim write alone meanwhile.
  t.mock.timers.tick(60000);
  assert.deepEqual(race.events, ['wait']);
  const results = await Promise.all([first, claim(cookies.two, 'english-ranch')]);
  assert.deepEqual(race.events, ['wait', 'wait', 'write', 'write']);
  assert.deepEqual(results.map(r => [r.status, r.body.code]), [[200, undefined], [409, 'knock_claim_conflict']], JSON.stringify(results.map(r => r.body)));
  const holders = [...world.fake.documents.keys()].filter(path => path.startsWith('knock_assignments/') && path.includes('english-ranch') && world.fake.get(path).active);
  assert.deepEqual(holders, ['knock_assignments/rep.one__english-ranch__all']);
});

test('one rep claiming two neighborhoods at once cannot pass the limit', async () => {
  const race = racing(2);
  const { claim, cookies, world } = await claimSetup({ storage: race, extra: settingsDoc({ selfClaim: true, maxSelfClaims: 1 }) });
  const results = await Promise.all([claim(cookies.rep, 'english-ranch'), claim(cookies.rep, 'rigden-farm')]);
  assert.deepEqual(race.events, ['wait', 'wait', 'write', 'write'], 'both claims read before either wrote');
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409], JSON.stringify(results.map(r => r.body)));
  const active = [...world.fake.documents.keys()].filter(path => path.startsWith('knock_assignments/rep.one__') && world.fake.get(path).active);
  assert.equal(active.length, 1);
});

test('a rep releases only their own claim, and the endpoint checks origin, action and approval', async () => {
  const { claim, release, houses, available, cookies, env, territory, world } = await claimSetup();
  await claim(cookies.rep, 'english-ranch');
  const released = await release(cookies.rep, 'english-ranch');
  assert.deepEqual([released.status, released.body.released], [200, true]);
  const ended = world.fake.get('knock_assignments/rep.one__english-ranch__all');
  assert.deepEqual([ended.active, ended.endedAt, ended.endedBy, ended.source], [false, new Date(NOW).toISOString(), 'Rep.One', 'self']);
  assert.deepEqual((await houses(cookies.rep)).houses, []);
  assert.deepEqual((await release(cookies.rep, 'english-ranch')).body.released, false, 'releasing twice is harmless');
  assert.deepEqual((await available(cookies.two)).body.neighborhoods.map(n => n.id), ['english-ranch', 'rigden-farm'], 'open again for everyone');
  const adminOwned = await release(cookies.lead, 'trail-head');
  assert.deepEqual([adminOwned.status, adminOwned.body.code], [409, 'knock_assigned_by_admin']);
  assert.equal(world.fake.get('knock_assignments/lead.one__trail-head__all').active, true);

  const crossSite = await call(territory.post, post('/api/knock-territory', { action: 'claim', neighborhoodId: 'english-ranch' }, cookies.rep, { origin: 'https://evil.example' }), env);
  assert.deepEqual([crossSite.status, crossSite.body.code], [403, 'knock_origin_forbidden']);
  assert.equal((await call(territory.post, post('/api/knock-territory', { action: 'grab' }, cookies.rep), env)).body.code, 'knock_unknown_action');
  assert.equal((await call(territory.get, get('/api/knock-territory?view=everything', cookies.rep), env)).status, 404);
  assert.equal((await call(territory.post, post('/api/knock-territory', { action: 'claim', neighborhoodId: 'english-ranch' }, null), env)).status, 401);
  world.fake.put('knock_reps/rep.two', { ...world.fake.get('knock_reps/rep.two'), status: 'pending' });
  assert.deepEqual([(await claim(cookies.two, 'english-ranch')).body.code, (await available(cookies.two)).status], ['knock_rep_pending', 403]);
});

test('territory settings: defaults, validation, and an older saved copy without them still verifies', async () => {
  assert.deepEqual(DEFAULT_SETTINGS.territory, { selfClaim: true, maxSelfClaims: 2 });
  assert.deepEqual(validateSettings(structuredClone(DEFAULT_SETTINGS)), []);
  const bad = { ...structuredClone(DEFAULT_SETTINGS), territory: { selfClaim: 'yes', maxSelfClaims: 0 } };
  assert.deepEqual(validateSettings(bad), ['territory.selfClaim must be true or false', 'territory.maxSelfClaims must be a whole number from 1 to 10']);
  assert.deepEqual(validateSettings({ ...structuredClone(DEFAULT_SETTINGS), territory: { selfClaim: false, maxSelfClaims: 11 } }), ['territory.maxSelfClaims must be a whole number from 1 to 10']);
  assert.deepEqual(validateSettings({ ...structuredClone(DEFAULT_SETTINGS), territory: { selfClaim: false, maxSelfClaims: 1.5 } }), ['territory.maxSelfClaims must be a whole number from 1 to 10']);
  assert.deepEqual(mergeSettings({ territory: { maxSelfClaims: 3 } }).territory, { selfClaim: true, maxSelfClaims: 3 });
  assert.deepEqual(mergeSettings({ territory: { maxSelfClaims: 99 } }).territory, DEFAULT_SETTINGS.territory, 'an out-of-range copy falls back to the defaults');

  const older = approvedKnockSettings();
  delete older.settings.territory;
  assert.deepEqual(validateSettings(older.settings), [], 'a copy saved before territory settings is still valid');
  const { storage } = knockWorld({ 'knock_settings/current': older });
  const settings = await loadSettings(storage(knockEnv()));
  assert.deepEqual([settings.commission.verified, settings.territory], [true, DEFAULT_SETTINGS.territory]);
});
