import test from 'node:test';
import assert from 'node:assert/strict';
import { knockMeHandlers } from '../functions/api/knock-me.js';
import { knockAdminHandlers } from '../functions/api/knock-admin.js';
import { call, cookieFor, get, knockEnv, knockWorld, post, uuid } from './helpers/knock-fixture.mjs';

const NOW = new Date('2026-10-06T16:00:00Z');

async function setup() {
  const env = knockEnv();
  const world = knockWorld();
  const me = knockMeHandlers({ storage: world.storage, now: () => NOW });
  const admin = knockAdminHandlers({ storage: world.storage, now: () => NOW });
  const cookies = { zac: await cookieFor(env, 'ZacB'), rep: await cookieFor(env, 'Rep.One'), lead: await cookieFor(env, 'Lead.One') };
  return { env, world, me, admin, cookies };
}

test('a new rep is pending and can do nothing until an admin approves them', async () => {
  const { env, world, me, admin, cookies } = await setup();
  assert.equal((await call(me.get, get('/api/knock-me'), env)).status, 401);
  const first = await call(me.get, get('/api/knock-me', cookies.rep), env);
  assert.equal(first.status, 200);
  assert.equal(first.body.rep.status, 'pending');
  assert.equal(first.body.eligibility.ok, false);
  assert.equal(first.body.territory, undefined, 'a pending rep sees no territory');
  assert.equal(world.fake.get('knock_reps/rep.one').status, 'pending');

  // Reps cannot use admin views or actions.
  assert.equal((await call(admin.get, get('/api/knock-admin?view=reps', cookies.rep), env)).status, 403);
  assert.equal((await call(admin.post, post('/api/knock-admin', { action: 'rep.update', repKey: 'rep.one', changes: { status: 'active' } }, cookies.rep), env)).status, 403);

  // The owner (a Hub business user) is an active admin on first visit.
  const owner = await call(me.get, get('/api/knock-me', cookies.zac), env);
  assert.deepEqual([owner.body.rep.role, owner.body.rep.status, owner.body.viewer.admin], ['admin', 'active', true]);

  const approve = await call(admin.post, post('/api/knock-admin', { action: 'rep.update', repKey: 'rep.one', changes: { status: 'active' } }, cookies.zac), env);
  assert.equal(approve.status, 200);
  const approved = await call(me.get, get('/api/knock-me', cookies.rep), env);
  assert.equal(approved.body.rep.status, 'active');
  assert.equal(approved.body.eligibility.ok, false, 'still needs the City permit list');
  assert.match(approved.body.eligibility.reason, /permit/);

  await call(admin.post, post('/api/knock-admin', { action: 'rep.update', repKey: 'rep.one', changes: { permitListed: true, premiumCleared: true } }, cookies.zac), env);
  assert.equal((await call(me.get, get('/api/knock-me', cookies.rep), env)).body.eligibility.ok, true);

  // One tap deactivates.
  await call(admin.post, post('/api/knock-admin', { action: 'rep.update', repKey: 'rep.one', changes: { status: 'inactive' } }, cookies.zac), env);
  const off = await call(me.get, get('/api/knock-me', cookies.rep), env);
  assert.equal(off.body.rep.status, 'inactive');
  assert.equal(off.body.eligibility.ok, false);
  assert.ok(world.fake.get('knock_reps/rep.one').deactivatedAt);
});

test('admins cannot be granted to reps, leads must be active leads, and cross-site posts are refused', async () => {
  const { env, me, admin, cookies } = await setup();
  await call(me.get, get('/api/knock-me', cookies.rep), env);
  await call(me.get, get('/api/knock-me', cookies.lead), env);
  const badRole = await call(admin.post, post('/api/knock-admin', { action: 'rep.update', repKey: 'rep.one', changes: { role: 'admin' } }, cookies.zac), env);
  assert.equal(badRole.body.code, 'knock_invalid_role');
  const notLead = await call(admin.post, post('/api/knock-admin', { action: 'rep.update', repKey: 'rep.one', changes: { leadKey: 'lead.one' } }, cookies.zac), env);
  assert.equal(notLead.body.code, 'knock_invalid_lead');
  await call(admin.post, post('/api/knock-admin', { action: 'rep.update', repKey: 'lead.one', changes: { status: 'active', role: 'lead' } }, cookies.zac), env);
  const ok = await call(admin.post, post('/api/knock-admin', { action: 'rep.update', repKey: 'rep.one', changes: { leadKey: 'lead.one' } }, cookies.zac), env);
  assert.equal(ok.body.leadKey, 'lead.one');
  const crossSite = await call(admin.post, post('/api/knock-admin', { action: 'rep.update', repKey: 'rep.one', changes: { status: 'active' } }, cookies.zac, { origin: 'https://evil.example' }), env);
  assert.equal(crossSite.status, 403);
});

test('training minutes are logged once per request and kept separate from knocking time', async () => {
  const { env, world, me, admin, cookies } = await setup();
  await call(me.get, get('/api/knock-me', cookies.rep), env);
  const requestId = uuid();
  const body = { action: 'training.add', requestId, repKey: 'rep.one', date: '2026-10-05', minutes: 90, note: 'Door script' };
  assert.equal((await call(admin.post, post('/api/knock-admin', body, cookies.zac), env)).body.duplicate, false);
  assert.equal((await call(admin.post, post('/api/knock-admin', body, cookies.zac), env)).body.duplicate, true);
  assert.equal(world.fake.get('knock_reps/rep.one').trainingMinutes, 90);
  const bad = await call(admin.post, post('/api/knock-admin', { ...body, requestId: uuid(), minutes: 0 }, cookies.zac), env);
  assert.equal(bad.body.code, 'knock_invalid_minutes');
  const view = await call(admin.get, get('/api/knock-admin?view=reps', cookies.zac), env);
  assert.deepEqual(view.body.training.map(t => [t.repKey, t.minutes]), [['rep.one', 90]]);
});

test('settings are validated before they are saved and every number comes back to the phone', async () => {
  const { env, me, admin, cookies } = await setup();
  const view = await call(admin.get, get('/api/knock-admin?view=settings', cookies.zac), env);
  const settings = view.body.settings;
  settings.commission.rate = 0.27;
  settings.cities['fort-collins'].warnMinutes = 20;
  assert.equal((await call(admin.post, post('/api/knock-admin', { action: 'settings.update', settings }, cookies.zac), env)).status, 200);
  const saved = await call(me.get, get('/api/knock-me', cookies.zac), env);
  assert.equal(saved.body.settings.commission.rate, 0.27);
  assert.equal(saved.body.settings.cities['fort-collins'].warnMinutes, 20);
  const bad = await call(admin.post, post('/api/knock-admin', { action: 'settings.update', settings: { ...settings, gate: { ...settings.gate, goPerHour: 10 } } }, cookies.zac), env);
  assert.equal(bad.status, 400);
  assert.match(bad.body.details.problems.join(' '), /goPerHour/);
});

test('the 24 neighborhoods seed once, with Premium and Hold locks applied to reps', async () => {
  const { env, world, me, admin, cookies } = await setup();
  const seeded = await call(admin.post, post('/api/knock-admin', { action: 'territory.seed' }, cookies.zac), env);
  assert.equal(seeded.body.created.length, 24);
  assert.equal((await call(admin.post, post('/api/knock-admin', { action: 'territory.seed' }, cookies.zac), env)).body.created.length, 0);
  assert.equal(world.fake.get('knock_neighborhoods/kechter-farm').plattedCount, 416);
  assert.equal(world.fake.get('knock_neighborhoods/harmony-club').status, 'hold');

  await call(me.get, get('/api/knock-me', cookies.rep), env);
  await call(admin.post, post('/api/knock-admin', { action: 'rep.update', repKey: 'rep.one', changes: { status: 'active', permitListed: true } }, cookies.zac), env);
  for (const neighborhoodId of ['kechter-farm', 'english-ranch', 'timnath-ranch']) {
    await call(admin.post, post('/api/knock-admin', { action: 'assignment.set', repKey: 'rep.one', neighborhoodId }, cookies.zac), env);
  }
  const home = (await call(me.get, get('/api/knock-me', cookies.rep), env)).body.territory.neighborhoods;
  assert.deepEqual(home.map(n => [n.id, n.locked]), [['english-ranch', false], ['kechter-farm', true], ['timnath-ranch', true]]);
  assert.match(home.find(n => n.id === 'kechter-farm').lockReason, /Premium/);
  assert.match(home.find(n => n.id === 'timnath-ranch').lockReason, /hold/i);

  await call(admin.post, post('/api/knock-admin', { action: 'rep.update', repKey: 'rep.one', changes: { premiumCleared: true } }, cookies.zac), env);
  await call(admin.post, post('/api/knock-admin', { action: 'neighborhood.update', id: 'timnath-ranch', changes: { status: 'open' } }, cookies.zac), env);
  const after = (await call(me.get, get('/api/knock-me', cookies.rep), env)).body.territory.neighborhoods;
  assert.equal(after.find(n => n.id === 'kechter-farm').locked, false);
  assert.match(after.find(n => n.id === 'timnath-ranch').lockReason, /No knocking rules/, 'Timnath has no city rule yet');
});
