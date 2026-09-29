import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ACCOUNTS, NOW, OPS_SECRET, PROBES, memoryStore, seedDirectoryTarget, staffSessions } from './helpers/auth-roles-harness.mjs';
import { ORIGIN, staffEnv, cookieFor } from './helpers/vault-fixture.mjs';
import { ACCESS_CAPABILITIES, OWNER_CAPABILITIES, ROLE_CAPABILITIES, STAFF_CAPABILITIES, can, capabilityMatrix, capabilityMode, capabilityNames, staffCapabilities } from '../functions/_lib/staff-roles.js';
import { getHubSession, getHubUserProfile, hasBusinessAccess, isHubOwner, listHubAccessProfiles, listHubUserProfiles } from '../functions/_lib/hub-session.js';
import { ROLE_DENIAL, changesCrew } from '../functions/_lib/dispatch-booking.js';
import { FIREBASE_REVOCATION_ADMIT_EXCHANGE_MS, FIREBASE_REVOCATION_PROBE_UID, createFirebaseRevocationService, decodeFirebaseRevocationState } from '../functions/_lib/firebase-revocation.js';
import { runHubCommand } from '../functions/_lib/operations-hub-commands.js';
import { RECURRING_HORIZON_ACTOR, planManagerSession } from '../functions/_lib/recurring-horizon-command.js';
import { staffDirectoryStorage } from '../functions/_lib/staff-directory-storage.js';
import { staffDirectoryHandlers } from '../functions/api/staff-directory.js';
import { WALKTHROUGH_DENIAL, quoteAuthorAccess } from '../functions/_lib/quote-permissions.js';
import { saveWalkthroughHandoff } from '../functions/_lib/walkthrough-handoff.js';
import { recordWalkthroughVisit } from '../functions/_lib/walkthrough-visit.js';
import { verifyOperationsEnvelope } from '../functions/_lib/operations-envelope.js';
import { staffPageGateEnabled, staffPageGateState } from '../functions/_lib/staff-page-gate.js';
import { dispatchHandlers } from '../functions/api/dispatch.js';
import { moneyHandlers } from '../functions/api/money.js';
import { customerResolveHandler } from '../functions/api/customer-resolve.js';
import { handoffHandlers } from '../functions/api/walkthrough-handoff.js';
import { integrationStatusHandlers } from '../functions/api/integration-status.js';
import { firebaseSessionHandlers, onRequestGet as firebaseSession } from '../functions/api/firebase-session.js';
import * as operations from '../functions/api/operations.js';
import * as hubAuth from '../functions/api/hub-auth.js';

// AUTH-ROLES: business access and booking rights from owner-set roles (EGC_STAFF_ROLE_ACCESS).
// Synthetic data only; the clock is fixed. tests/auth-roles-flag-off.test.mjs pins the flag-off
// responses byte for byte against the code before this unit.
const ACCESS = { EGC_STAFF_ROLE_ACCESS: 'true' };
const MANAGER = ROLE_CAPABILITIES.manager, SALES = ROLE_CAPABILITIES.sales, PHONE = ROLE_CAPABILITIES.phone;
const get = (cookie, path) => new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie } });
const post = (cookie, path, body) => new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
const json = async response => ({ status: response.status, body: await response.json() });

test('capabilities: the role-access capabilities exist only with the flag on, and never carry pay, cost or owner money', () => {
  const employee = staffRoles => ({ user: 'Staff.Account', displayName: 'Synthetic Staff', role: 'crew', businessAccess: false, source: 'employee-account', ...(staffRoles ? { staffRoles } : {}) });
  assert.deepEqual(capabilityNames({}), STAFF_CAPABILITIES); assert.deepEqual(capabilityMatrix({}), ROLE_CAPABILITIES);
  assert.deepEqual(capabilityNames(ACCESS), [...STAFF_CAPABILITIES, 'schedule.book', 'walkthrough.perform']);
  assert.deepEqual(capabilityMatrix(ACCESS), { owner: [...STAFF_CAPABILITIES, ...ACCESS_CAPABILITIES], manager: [...MANAGER, ...ACCESS_CAPABILITIES], crew_lead: [], crew: [], sales: [...SALES, ...ACCESS_CAPABILITIES], phone: [...PHONE, 'schedule.book'] });
  for (const flags of [{}, { EGC_STAFF_ROLE_PERMISSIONS: 'true' }, { EGC_STAFF_ROLE_ACCESS: 'TRUE' }, { EGC_STAFF_ROLE_ACCESS: ' true' }]) {
    for (const capability of ACCESS_CAPABILITIES) assert.equal(can({ user: 'ZacB', role: 'owner', businessAccess: true }, capability, flags), false, `${capability} ${JSON.stringify(flags)}`);
  }
  assert.deepEqual(staffCapabilities(employee(['sales']), ACCESS), [...SALES, ...ACCESS_CAPABILITIES]);
  assert.deepEqual(staffCapabilities(employee(['phone']), ACCESS), [...PHONE, 'schedule.book']);
  assert.deepEqual(staffCapabilities(employee(['manager']), ACCESS), [...MANAGER, ...ACCESS_CAPABILITIES]);
  for (const roles of [['crew'], ['crew_lead'], ['owner'], [], undefined]) assert.deepEqual(staffCapabilities(employee(roles), ACCESS), [], JSON.stringify(roles));
  // Sales and phone never reach dispatch.write (money: requireMoneyManager), pay, cost or owner money.
  for (const roles of [['sales'], ['phone'], ['sales', 'phone', 'crew_lead']]) {
    for (const capability of ['dispatch.write', 'time.approve', ...OWNER_CAPABILITIES]) assert.equal(can(employee(roles), capability, ACCESS), false, `${roles} ${capability}`);
  }
  // Only the configured business users without stored roles keep the legacy checks.
  const tyler = { user: 'TylerG', role: 'manager', businessAccess: true }, alex = { user: 'AlexK', role: 'crew_lead', businessAccess: true };
  assert.equal(capabilityMode(tyler, ACCESS), 'legacy'); assert.equal(capabilityMode(employee(), ACCESS), 'staff_roles');
  assert.deepEqual(staffCapabilities(tyler, ACCESS), [...MANAGER, ...ACCESS_CAPABILITIES]);
  assert.deepEqual(staffCapabilities(alex, ACCESS), [...MANAGER.filter(capability => capability !== 'dispatch.write'), 'walkthrough.perform'], 'business access runs walkthroughs; only a dispatcher books');
  // A signed sales invitation (role sales) without stored roles acts as sales; a claimed role never does.
  assert.deepEqual(staffCapabilities({ ...employee(), role: 'sales' }, ACCESS), [...SALES, ...ACCESS_CAPABILITIES]);
  assert.throws(() => can(employee(['sales']), 'schedule.delete', ACCESS), TypeError);
  for (const session of [null, 'zacb', {}, { user: ' ' }]) for (const capability of ACCESS_CAPABILITIES) assert.equal(can(session, capability, ACCESS), false);
});

test('business access: stored manager roles grant it only with the flag on, only through a signed profile, and never the owner', () => {
  const users = { 'Config.Manager': { passwordHash: 'unused', role: 'crew', displayName: 'Synthetic Config Manager', staffRoles: ['manager'] }, 'Config.Owner': { passwordHash: 'unused', role: 'owner', displayName: 'Synthetic Claimed Owner', staffRoles: ['owner', 'manager'] } };
  const off = staffEnv({}, users), on = staffEnv(ACCESS, users);
  assert.deepEqual([getHubUserProfile(off, 'Config.Manager').businessAccess, hasBusinessAccess(getHubUserProfile(off, 'Config.Manager'))], [false, false]);
  const manager = getHubUserProfile(on, 'Config.Manager');
  assert.deepEqual([manager.businessAccess, manager.role, hasBusinessAccess(manager), hasBusinessAccess({ ...manager }), isHubOwner(manager)], [true, 'manager', true, true, false]);
  const claimed = getHubUserProfile(on, 'Config.Owner');
  assert.deepEqual([hasBusinessAccess(claimed), isHubOwner(claimed), can(claimed, 'pay.manage', on), can(claimed, 'dispatch.write', on)], [true, false, false, true], 'a stored owner role is only the configured owner\'s');
  // A copied field, a JSON round trip or a stored row never carries the grant.
  for (const forged of [JSON.parse(JSON.stringify(manager)), structuredClone(manager), { user: 'Config.Manager', role: 'manager', businessAccess: true, staffRoles: ['manager'] }]) assert.equal(hasBusinessAccess(forged), false);
  assert.equal(hasBusinessAccess(getHubUserProfile(on, 'Crew.Static')), false);
  assert.equal(hasBusinessAccess(getHubUserProfile(on, 'TylerG')), true);
});

test('the owner is never locked out: whatever roles are stored, the owner keeps business access and every owner capability', async t => {
  for (const staffRoles of [[], ['crew'], ['crew_lead'], ['sales'], ['phone'], ['manager'], ['owner']]) {
    const env = staffEnv({ ...ACCESS, EGC_OPERATIONS_ENABLED: 'false' }, { ZacB: { passwordHash: 'unused', role: 'owner', displayName: 'Synthetic Owner', payType: 'owner', staffRoles } });
    const cookie = await cookieFor(env, 'ZacB'), { body } = await json(await hubAuth.onRequestGet({ request: get(cookie, '/api/hub-auth'), env }));
    assert.deepEqual([body.businessAccess, body.owner, body.roleAccess], [true, true, true], JSON.stringify(staffRoles));
    assert.deepEqual(body.capabilities, [...STAFF_CAPABILITIES, ...ACCESS_CAPABILITIES], JSON.stringify(staffRoles));
    assert.equal((await dispatchHandlers({ storage: memoryStore, now: () => new Date(NOW) }).get({ request: get(cookie, '/api/dispatch'), env })).status, 200);
    assert.equal((await operations.onRequestGet({ request: get(cookie, '/api/operations'), env })).status, 200);
  }
  // With the flag off an explicit ['manager'] is still honored (DISPATCH-RULES), as before this unit.
  const env = { EGC_STAFF_ROLE_PERMISSIONS: 'true' }, owner = { user: 'ZacB', role: 'owner', businessAccess: true, staffRoles: ['manager'] };
  assert.deepEqual([can(owner, 'pay.manage', env), can(owner, 'pay.manage', { ...env, ...ACCESS })], [false, true]);
});

// The server decision each probe must match, from the capabilities /api/hub-auth reported.
const any = (...names) => caps => names.some(name => caps.includes(name));
const EXPECT = {
  'hub-auth GET': () => true, 'staff-roles GET': () => true,
  'dispatch GET board': any('dispatch.write', 'schedule.book'), 'dispatch GET customers': any('dispatch.write', 'schedule.book'), 'dispatch-openings GET': any('dispatch.write', 'schedule.book'),
  'dispatch-search GET': any('dispatch.write', 'schedule.book'), 'dispatch-travel GET': any('dispatch.write', 'schedule.book'),
  'dispatch POST walkthrough': any('dispatch.write', 'schedule.book'), 'dispatch POST job': any('dispatch.write', 'schedule.book'),
  'dispatch POST reschedule': any('dispatch.write', 'schedule.book'), 'dispatch POST cancel': any('dispatch.write', 'schedule.book'),
  'dispatch POST job with crew': any('dispatch.write'), 'dispatch POST blocked': any('dispatch.write'), 'dispatch POST crew.save': any('dispatch.write'), 'dispatch POST recrew': any('dispatch.write'),
  'timesheets GET': any('time.approve'), 'operations GET': any('followups.own'), 'operations POST': any('followups.own'),
  'walkthrough-handoff GET': any('walkthrough.perform'), 'customer-resolve POST': any('walkthrough.perform', 'schedule.book'), 'money GET': any('dispatch.write'),
  'walkthrough-visit viewer': any('walkthrough.perform', 'schedule.book'),
  // The fixture walkthrough is assigned to someone else: a performer sees and records only their own, so only a
  // manager or a booker opens it and records its no-show.
  'walkthrough-visit state': any('dispatch.write', 'schedule.book'), 'walkthrough-visit no_show': any('dispatch.write', 'schedule.book'),
  // Everyone sees at least their own staff record; only the owner changes roles (accounts.approve).
  'staff-directory GET': () => true, 'staff-directory POST set_roles': any('accounts.approve'), 'staff-directory POST set_roles replay': any('accounts.approve'),
};
const EXPECTED_CAPABILITIES = {
  ZacB: [...STAFF_CAPABILITIES, ...ACCESS_CAPABILITIES], TylerG: [...MANAGER, ...ACCESS_CAPABILITIES], AlexK: [...MANAGER.filter(name => name !== 'dispatch.write'), 'walkthrough.perform'], 'Crew.Static': [],
  'Config.Manager': [...MANAGER, ...ACCESS_CAPABILITIES], 'Config.Phone': [...PHONE, 'schedule.book'], 'Mgr.Account': [...MANAGER, ...ACCESS_CAPABILITIES], 'Sales.Account': [...SALES, ...ACCESS_CAPABILITIES],
  'Phone.Account': [...PHONE, 'schedule.book'], 'Lead.Account': [], 'Crew.Account': [], 'Legacy.Sales': [...SALES, ...ACCESS_CAPABILITIES], 'Owner.Claim': [],
};
const BUSINESS = new Set(['ZacB', 'TylerG', 'AlexK', 'Config.Manager', 'Mgr.Account']);

test('authz matrix: with the flag on, every endpoint decides exactly what /api/hub-auth reports for every role', async t => {
  const { env: base, cookies, fire } = await staffSessions(t);
  await seedDirectoryTarget(base, fire);
  for (const flags of [ACCESS, { ...ACCESS, EGC_STAFF_ROLE_PERMISSIONS: 'true' }, { ...ACCESS, EGC_STAFF_ROLE_PERMISSIONS: 'false' }]) {
    const env = { ...base, ...flags };
    for (const user of ACCOUNTS) {
      const { body: profile } = await json(await hubAuth.onRequestGet({ request: get(cookies[user], '/api/hub-auth'), env }));
      assert.deepEqual(profile.capabilities, EXPECTED_CAPABILITIES[user], `${user} capabilities`);
      assert.equal(profile.businessAccess, BUSINESS.has(user), `${user} business access`);
      assert.equal(profile.roleAccess, true);
      for (const [label, run] of PROBES) {
        const response = await run(cookies[user], env), body = await response.clone().json(), allowed = EXPECT[label](profile.capabilities);
        const granted = response.status === 200 || label === 'operations POST' && response.status === 503 && body.error === 'operations_not_enabled';
        assert.equal(granted, allowed, `${user} ${label}: ${response.status} ${JSON.stringify(body).slice(0, 300)}`);
        if (!allowed) assert.equal(response.status, 403, `${user} ${label} is refused, not failed`);
      }
    }
  }
});

test('a stored manager reaches dispatch, timesheets, operations and job money; sales and phone get no pay, cost or money', async t => {
  const { env: base, cookies } = await staffSessions(t), env = { ...base, ...ACCESS };
  const profile = (await json(await hubAuth.onRequestGet({ request: get(cookies['Mgr.Account'], '/api/hub-auth'), env }))).body;
  assert.deepEqual([profile.role, profile.businessAccess, profile.capabilityMode], ['manager', true, 'staff_roles']);
  const operationsView = (await json(await operations.onRequestGet({ request: get(cookies['Mgr.Account'], '/api/operations'), env }))).body;
  assert.deepEqual(operationsView.actor, { id: 'Mgr.Account', role: 'manager', kind: 'human', workspace: 'egc' });
  const byLabel = Object.fromEntries(PROBES);
  for (const label of ['dispatch POST job with crew', 'timesheets GET', 'money GET']) assert.equal((await byLabel[label](cookies['Mgr.Account'], env)).status, 200, label);
  for (const label of ['dispatch POST job with crew', 'timesheets GET', 'money GET']) assert.equal((await byLabel[label](cookies['Mgr.Account'], base)).status, 403, `${label} with the flag off`);
  for (const user of ['Sales.Account', 'Phone.Account', 'Config.Phone', 'Legacy.Sales']) {
    for (const label of ['timesheets GET', 'money GET']) {
      const { status, body } = await json(await byLabel[label](cookies[user], env));
      assert.equal(status, 403, `${user} ${label}`);
      if (label === 'timesheets GET') assert.equal(body.error, 'Timesheets need the Manager role. Ask the owner.');
    }
    const write = await moneyHandlers({ storage: memoryStore, now: () => new Date(NOW) }).post({ request: post(cookies[user], '/api/money', { action: 'costs.save', requestId: randomUUID(), jobId: 'job-costed', expectedRevision: 'mr1', costs: { laborCents: 100 } }), env: { ...env, MONEY_API_ENABLED: 'true' } });
    assert.equal(write.status, 403, `${user} money write`);
  }
});

function bookingDesk(t) {
  const store = memoryStore(ACCESS);
  store.rows.set('jobs/job-today', { id: 'job-today', revision: 'tr1', type: 'job', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', address: '100 Fixture Lane', date: '2026-09-22', endDate: '2026-09-22', time: '09:00', endTime: '11:00', assignedCrew: [], crewNeeded: 1, jobInstructions: 'Synthetic scope' });
  store.rows.set('jobs/block-1', { id: 'block-1', revision: 'br1', type: 'blocked', title: 'Unavailable', status: 'scheduled', pipelineStatus: 'scheduled', date: '2026-09-29', endDate: '2026-09-29', time: '08:00', endTime: '12:00', assignedCrew: [] });
  const handlers = dispatchHandlers({ storage: () => store, now: () => new Date(NOW) });
  const send = async (cookie, env, body) => json(await handlers.post({ request: post(cookie, '/api/dispatch', { requestId: randomUUID(), ...body }), env }));
  const rev = id => store.rows.get(`jobs/${id}`).revision;
  return { store, handlers, send, rev };
}

test('sales and phone book, reschedule, cancel, restore and no-show walkthroughs and jobs; crew fields, blocks and resources get 403', async t => {
  const { env: base, cookies } = await staffSessions(t), env = { ...base, ...ACCESS };
  for (const user of ['Sales.Account', 'Phone.Account']) {
    const desk = bookingDesk(t), cookie = cookies[user], id = user.toLowerCase();
    const walk = await desk.send(cookie, env, { action: 'schedule.create', customerId: 'c1', kind: 'walkthrough', changes: { date: '2026-09-24', time: '13:00', endTime: '14:00', title: 'Synthetic walkthrough' } });
    assert.equal(walk.status, 200, JSON.stringify(walk.body));
    const walkId = walk.body.job.id, saved = desk.store.rows.get(`jobs/${walkId}`);
    assert.deepEqual([saved.type, saved.status, saved.createdBy, saved.assignedCrew], ['walkthrough', 'scheduled', user, []]);
    const moved = await desk.send(cookie, env, { action: 'schedule.update', jobId: walkId, expectedRevision: desk.rev(walkId), changes: { date: '2026-09-25', time: '15:00', endTime: '16:00' }, reasonCode: 'customer_request', initiatedBy: 'customer' });
    assert.equal(moved.status, 200, JSON.stringify(moved.body)); assert.deepEqual([moved.body.job.date, moved.body.job.time], ['2026-09-25', '15:00']);
    const cancelled = await desk.send(cookie, env, { action: 'schedule.cancel', jobId: walkId, expectedRevision: desk.rev(walkId), reasonCode: 'customer_changed_plans', initiatedBy: 'customer', cancellationReason: 'Synthetic caller cancelled' });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body)); assert.equal(desk.store.rows.get(`jobs/${walkId}`).status, 'cancelled');
    const restored = await desk.send(cookie, env, { action: 'schedule.restore', jobId: walkId, expectedRevision: desk.rev(walkId) });
    assert.equal(restored.status, 200, JSON.stringify(restored.body)); assert.equal(desk.store.rows.get(`jobs/${walkId}`).restoredBy, user);
    // Owner decision (2026-09-29): service jobs too, the same as a manager for scheduling.
    const job = await desk.send(cookie, env, { action: 'schedule.create', customerId: 'c1', kind: 'job', sourceJobId: 'job-crewed', changes: { date: '2026-09-26', time: '08:00', endTime: '10:00', jobInstructions: 'Synthetic scope', crewNeeded: 2, assignedCrew: [], crewLead: null, vehicleId: '', shiftPickupEnabled: false } });
    assert.equal(job.status, 200, JSON.stringify(job.body)); assert.deepEqual([job.body.job.type, job.body.job.assignedCrew, job.body.job.crewNeeded], ['job', [], 2]);
    const noShow = await desk.send(cookie, env, { action: 'schedule.no_show', jobId: 'job-today', expectedRevision: desk.rev('job-today'), reasonCode: 'customer_not_home' });
    assert.equal(noShow.status, 200, JSON.stringify(noShow.body)); assert.equal(desk.store.rows.get('jobs/job-today').noShowBy, user);
    // A reschedule that sends the saved crew back is a booking; any crew change is not.
    const echo = await desk.send(cookie, env, { action: 'schedule.update', jobId: 'job-crewed', expectedRevision: desk.rev('job-crewed'), changes: { date: '2026-09-25', time: '12:00', endTime: '14:00', assignedCrew: ['crew.one'], crewLead: null } });
    assert.equal(echo.status, 200, JSON.stringify(echo.body)); assert.deepEqual(desk.store.rows.get('jobs/job-crewed').assignedCrew, ['crew.one']);
    const before = desk.store.rows.size;
    for (const [label, body] of [
      ['assign crew on create', { action: 'schedule.create', customerId: 'c1', kind: 'walkthrough', changes: { date: '2026-09-27', time: '09:00', endTime: '10:00', assignedCrew: ['crew.one'] } }],
      ['crew lead', { action: 'schedule.create', customerId: 'c1', kind: 'job', sourceJobId: 'job-crewed', changes: { date: '2026-09-27', time: '09:00', endTime: '10:00', crewLead: 'crew.one' } }],
      ['vehicle', { action: 'schedule.create', customerId: 'c1', kind: 'job', sourceJobId: 'job-crewed', changes: { date: '2026-09-27', time: '09:00', endTime: '10:00', vehicleId: 'truck-1' } }],
      ['crew resource', { action: 'schedule.create', customerId: 'c1', kind: 'job', sourceJobId: 'job-crewed', changes: { date: '2026-09-27', time: '09:00', endTime: '10:00', crewId: 'crew-a' } }],
      ['open shift', { action: 'schedule.create', customerId: 'c1', kind: 'job', sourceJobId: 'job-crewed', changes: { date: '2026-09-27', time: '09:00', endTime: '10:00', shiftPickupEnabled: true } }],
      ['segments', { action: 'schedule.create', customerId: 'c1', kind: 'job', sourceJobId: 'job-crewed', changes: { assignmentSegments: [{ id: 's1', date: '2026-09-27', time: '09:00', endDate: '2026-09-27', endTime: '10:00', assignedCrew: ['crew.one'] }] } }],
      ['reassign crew', { action: 'schedule.update', jobId: 'job-crewed', expectedRevision: desk.rev('job-crewed'), changes: { assignedCrew: ['zacb'] } }],
      ['unassign crew', { action: 'schedule.update', jobId: 'job-crewed', expectedRevision: desk.rev('job-crewed'), changes: { assignedCrew: [] } }],
    ]) {
      const refused = await desk.send(cookie, env, body);
      assert.deepEqual([refused.status, refused.body.code, refused.body.error], [403, 'dispatch_forbidden', ROLE_DENIAL.crew], `${user} ${label}`);
    }
    for (const [label, body] of [
      ['company block', { action: 'schedule.create', kind: 'blocked', changes: { date: '2026-09-28', time: '08:00', endTime: '12:00' } }],
      ['edit a block', { action: 'schedule.update', jobId: 'block-1', expectedRevision: 'br1', changes: { time: '09:00' } }],
      ['cancel a block', { action: 'schedule.cancel', jobId: 'block-1', expectedRevision: 'br1', reasonCode: 'other', initiatedBy: 'company' }],
      ['crew', { action: 'crew.save', changes: { name: 'Synthetic Crew', memberIds: ['crew.one'], status: 'active' } }],
      ['vehicle', { action: 'vehicle.save', changes: { name: 'Synthetic Truck', status: 'available' } }],
      ['time off', { action: 'availability.save', changes: { employeeId: 'crew.one', date: '2026-09-28', endDate: '2026-09-28', allDay: true, reason: 'Synthetic time off' } }],
    ]) {
      const refused = await desk.send(cookie, env, body);
      assert.deepEqual([refused.status, refused.body.code, refused.body.error], [403, 'dispatch_forbidden', ROLE_DENIAL.action], `${user} ${label}`);
    }
    assert.equal(desk.store.rows.size, before, 'a refused change writes nothing');
    // Invalid input is still answered by dispatch itself, and a replay returns the saved booking.
    assert.equal((await desk.send(cookie, env, { action: 'schedule.create', customerId: 'c1', kind: 'garage', changes: {} })).status, 400);
    const again = { action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'walkthrough', changes: { date: '2026-09-30', time: '09:00', endTime: '10:00' } };
    assert.equal((await desk.send(cookie, env, again)).status, 200);
    const replay = await desk.send(cookie, env, again);
    assert.deepEqual([replay.status, replay.body.replayed], [200, true]);
    // Flag off: the booker is refused as before this unit.
    const off = await desk.send(cookie, base, { action: 'schedule.create', customerId: 'c1', kind: 'walkthrough', changes: { date: '2026-09-24', time: '10:00', endTime: '11:00' } });
    assert.deepEqual([off.status, off.body.code, off.body.error], [403, 'dispatch_forbidden', 'Only an operations manager or owner can change dispatch.']);
    assert.ok(id);
  }
  // Crew and business users without a booking role get the role-based refusal.
  const desk = bookingDesk(t);
  for (const user of ['Crew.Account', 'Lead.Account', 'AlexK']) {
    const refused = await desk.send(cookies[user], env, { action: 'schedule.create', customerId: 'c1', kind: 'walkthrough', changes: { date: '2026-09-24', time: '10:00', endTime: '11:00' } });
    assert.deepEqual([refused.status, refused.body.error], [403, ROLE_DENIAL.schedule], user);
  }
});

test('a booker sees when an employee is away on the board, never the time-off note', async t => {
  const { env: base, cookies } = await staffSessions(t), env = { ...base, ...ACCESS };
  const board = async user => {
    const store = memoryStore(env);
    store.rows.set('jobs/away-1', { id: 'away-1', revision: 'ar1', type: 'availability', recordType: 'crew_availability', employee: 'crew.one', date: '2026-09-23', endDate: '2026-09-23', time: '00:00', endTime: '23:59', allDay: true, reason: 'Synthetic private appointment', status: 'active', createdBy: 'crew.one' });
    const { status, body } = await json(await dispatchHandlers({ storage: () => store, now: () => new Date(NOW) }).get({ request: get(cookies[user], '/api/dispatch?startDate=2026-09-22&endDate=2026-09-29'), env }));
    assert.equal(status, 200, user);
    return body.availability.find(row => row.id === 'away-1');
  };
  for (const user of ['Sales.Account', 'Phone.Account']) {
    const row = await board(user);
    assert.deepEqual([row.employeeId, row.date, row.allDay, row.status], ['crew.one', '2026-09-23', true, 'active'], user);
    assert.equal(JSON.stringify(row).includes('Synthetic private appointment'), false, user);
  }
  for (const user of ['ZacB', 'Mgr.Account']) assert.equal((await board(user)).reason, 'Synthetic private appointment', user);
});

test('crew-field check: a field counts as a change only when it differs from the saved value (or from none on a new visit)', () => {
  const saved = { assignedCrew: ['crew.one', 'zacb'], crewLead: 'crew.one', crewId: null, vehicleId: 'truck-1', shiftPickupEnabled: false, assignmentSegments: null };
  assert.equal(changesCrew({ assignedCrew: ['ZacB', 'Crew.One'], crewLead: 'Crew.One', crewId: '', vehicleId: 'truck-1', shiftPickupEnabled: false }, saved), false);
  for (const change of [{ assignedCrew: ['crew.one'] }, { assignedCrew: [] }, { crewLead: null }, { crewId: 'crew-a' }, { vehicleId: null }, { shiftPickupEnabled: true }, { assignmentSegments: [{ id: 's1' }] }]) assert.equal(changesCrew(change, saved), true, JSON.stringify(change));
  assert.equal(changesCrew({ assignedCrew: [], crewLead: '', crewId: null, vehicleId: '', shiftPickupEnabled: false, assignmentSegments: [], date: '2026-09-30' }), false);
  assert.equal(changesCrew({ date: '2026-09-30', title: 'Synthetic' }, saved), false);
  assert.equal(changesCrew(null, saved), false);
  // The crew Dispatch shows: a legacy assignedTo name resolved against the roster.
  const roster = [{ id: 'crew.one', name: 'Synthetic Crew One' }, { id: 'zacb', name: 'Synthetic Owner' }], legacy = { id: 'legacy', assignedTo: 'Synthetic Crew One' };
  assert.equal(changesCrew({ assignedCrew: ['crew.one'] }, legacy, roster, NOW), false);
  assert.equal(changesCrew({ assignedCrew: ['zacb'] }, legacy, roster, NOW), true);
  // A split job: each segment's crew, lead, crew and vehicle; never its dates, times or notes.
  const segment = (id, extra = {}) => ({ id, date: '2026-09-25', time: '09:00', endDate: '2026-09-25', endTime: '11:00', assignedCrew: ['crew.one'], crewLead: 'crew.one', crewId: null, vehicleId: null, notes: '', ...extra });
  const split = { id: 'split', type: 'job', assignmentSegments: [segment('s1'), segment('s2', { date: '2026-09-26', endDate: '2026-09-26', assignedCrew: ['zacb'], crewLead: null })] };
  assert.equal(changesCrew({ assignmentSegments: [segment('s1', { time: '13:00', endTime: '15:00', notes: 'Synthetic gate code' }), segment('s2', { date: '2026-09-27', endDate: '2026-09-27', assignedCrew: ['ZacB'], crewLead: null })] }, split, roster, NOW), false);
  for (const assignmentSegments of [[segment('s1'), segment('s2', { date: '2026-09-26', endDate: '2026-09-26', crewLead: null })], [segment('s1')], [segment('s1'), segment('s2', { assignedCrew: ['zacb'], crewLead: null }), segment('s3')],
    [segment('s1', { vehicleId: 'truck-1' }), segment('s2', { assignedCrew: ['zacb'], crewLead: null })], [segment('s1', { crewLead: null }), segment('s2', { assignedCrew: ['zacb'], crewLead: null })], []]) {
    assert.equal(changesCrew({ assignmentSegments }, split, roster, NOW), true, JSON.stringify(assignmentSegments));
  }
  // On a job offered for pickup, crew size and required skills decide who may assign themselves.
  const pickup = { id: 'pickup', type: 'job', assignedCrew: ['crew.one'], crewNeeded: 2, shiftPickupEnabled: true };
  assert.deepEqual([changesCrew({ crewNeeded: 3 }, pickup, roster, NOW), changesCrew({ requiredSkills: ['shelving'] }, pickup, roster, NOW), changesCrew({ crewNeeded: 2, requiredSkills: [] }, pickup, roster, NOW)], [true, true, false]);
  assert.deepEqual([changesCrew({ crewNeeded: 3 }, { ...pickup, shiftPickupEnabled: false }, roster, NOW), changesCrew({ crewNeeded: 3 }, null, roster, NOW)], [false, false]);
});

const plan = (logistics = {}) => ({ client: { name: 'Synthetic Customer', phone: '9705550100', email: 'synthetic.customer@example.invalid', address: '100 Fixture Lane' }, quote: { title: 'Garage reset', total: 1400, deposit: 700, job_date: '2026-09-24', start_time: '09:00', end_time: '12:00', estimated_duration_min: 180 }, acceptance: { accepted_at: '2026-09-22T14:45:00.000Z', accepted_by: 'Synthetic Customer', signature_captured: true, method: 'in_person_signature', terms_version: '2026-09-deposit50' }, signature: 'data:image/png;base64,iVBORw0KGgo=', terms_version: '2026-09-deposit50', terms_accepted: true, photos: { before: 2 }, scope: { keep_items: 'Synthetic bicycle' }, discovery: { success: 'Park the car' }, logistics: { crew_size: 2, ...logistics }, internal_notes: 'Synthetic brief', client_checklists: { preJob: [], postJob: [] }, notes: '' });

test('a sales handoff saves unassigned and flagged "Sold: needs crew"; its crew names are ignored with the flag on and refused with it off', async t => {
  const { env: base, cookies } = await staffSessions(t);
  const handoff = async (user, env, logistics) => {
    const store = memoryStore(env);
    store.rows.set('projects/project_walk-1', { id: 'project_walk-1', revision: 'pr1', customerId: 'c1', sourceRecordId: 'walk-1', sourceWalkthroughId: 'walk-1', authority: 'employee_hub' });
    store.rows.delete('jobs/job-costed'); // one account root, so the sold job's lineage is unambiguous
    const session = await getHubSession(get(cookies[user], '/api/walkthrough-handoff'), env);
    const input = { requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'walk-1', sourceRevision: 'wr1', plan: plan(logistics) };
    try { return { store, result: await saveWalkthroughHandoff(store, session, input, NOW, { env }) }; } catch (error) { return { store, error }; }
  };
  for (const user of ['Sales.Account', 'Legacy.Sales']) {
    const { store, result, error } = await handoff(user, { ...base, ...ACCESS }, { assigned_to: 'Synthetic Crew One' });
    assert.ok(result, `${user}: ${error?.code} ${error?.message} ${JSON.stringify(error?.details || null)}`);
    const job = store.rows.get(`jobs/${result.job.id}`);
    assert.deepEqual([job.assignedCrew, job.estimate.status, job.createdBy, job.soldNeedsCrew.by], [[], 'accepted', user, user], user);
    assert.deepEqual(result.job.assignedCrew, []);
    const codes = result.warnings.map(warning => warning.code);
    assert.ok(codes.includes('crew_assignment_ignored') && codes.includes('sold_needs_crew'), JSON.stringify(result.warnings));
    assert.equal(result.warnings.find(warning => warning.code === 'sold_needs_crew').message, 'Sold: needs crew. A manager assigns the crew in Dispatch.');
    // The job waits in Dispatch (To schedule) with the flag until a manager staffs it.
    const board = await dispatchHandlers({ storage: () => store, now: () => new Date(NOW) }).get({ request: get(cookies.ZacB, '/api/dispatch?startDate=2026-09-22&endDate=2026-09-29'), env: { ...base, ...ACCESS } });
    const { body } = await json(board);
    assert.ok(body.warnings.some(warning => warning.code === 'sold_needs_crew' && warning.jobId === job.id));
    const staffed = await dispatchHandlers({ storage: () => store, now: () => new Date(NOW) }).post({ request: post(cookies.ZacB, '/api/dispatch', { action: 'schedule.update', requestId: randomUUID(), jobId: job.id, expectedRevision: store.rows.get(`jobs/${job.id}`).revision, changes: { assignedCrew: ['crew.one'] } }), env: { ...base, ...ACCESS } });
    assert.equal(staffed.status, 200);
    assert.ok(!(await json(staffed)).body.warnings.some(warning => warning.code === 'sold_needs_crew'), 'staffed, the flag clears');
  }
  // A manager's handoff still assigns crew, and is never flagged.
  const managed = await handoff('Mgr.Account', { ...base, ...ACCESS }, { assigned_to: 'Synthetic Crew One' });
  assert.deepEqual([managed.result.job.assignedCrew, managed.store.rows.get(`jobs/${managed.result.job.id}`).soldNeedsCrew], [['crew.one'], undefined]);
  // Flag off: sales with stored-role permissions keep QUOTE-DRAFT's refusal of crew names; phone cannot hand off.
  const refused = await handoff('Sales.Account', { ...base, EGC_STAFF_ROLE_PERMISSIONS: 'true' }, { assigned_to: 'Synthetic Crew One' });
  assert.equal(refused.error.code, 'handoff_crew_assignment_forbidden');
  const phone = await handoff('Phone.Account', { ...base, ...ACCESS }, {});
  assert.deepEqual([phone.error.code, phone.error.message], ['quote_forbidden', WALKTHROUGH_DENIAL]);
});

test('walkthrough.perform opens the handoff; customer-resolve also serves bookers, masked; denials name the role', async t => {
  const { env: base, cookies } = await staffSessions(t), env = { ...base, ...ACCESS };
  const handoff = user => handoffHandlers({ storage: memoryStore, now: () => new Date(NOW) }).get({ request: get(cookies[user], '/api/walkthrough-handoff'), env });
  const resolve = user => customerResolveHandler({ storage: memoryStore })({ request: post(cookies[user], '/api/customer-resolve', { requestId: randomUUID(), customer: { name: 'Synthetic Caller', phone: '9705550177' } }), env });
  for (const user of ['Sales.Account', 'Legacy.Sales', 'AlexK', 'Mgr.Account']) assert.equal((await handoff(user)).status, 200, user);
  for (const user of ['Phone.Account', 'Crew.Account', 'Lead.Account']) assert.deepEqual(await json(await handoff(user)), { status: 403, body: { ok: false, code: 'quote_forbidden', error: WALKTHROUGH_DENIAL } }, user);
  const phone = await json(await resolve('Phone.Account'));
  assert.equal(phone.status, 200); assert.notEqual(phone.body.customer.phone, '9705550177', 'a booker sees the masked customer');
  const dispatcher = await json(await resolve('Mgr.Account'));
  assert.equal(dispatcher.body.customer.phone, '9705550177');
  assert.deepEqual(await json(await resolve('Crew.Account')), { status: 403, body: { ok: false, code: 'quote_forbidden', error: 'Customer lookups need the Sales or Phone role. Ask the owner.' } });
  // Quote authoring follows the same capability: a stored manager is a dispatcher, sales an author.
  const session = async user => getHubSession(get(cookies[user], '/'), env);
  assert.deepEqual(quoteAuthorAccess(await session('Mgr.Account'), env), { dispatcher: true, author: true });
  assert.deepEqual(quoteAuthorAccess(await session('Sales.Account'), env), { dispatcher: false, author: true });
  assert.deepEqual(quoteAuthorAccess(await session('Phone.Account'), env), { dispatcher: false, author: false });
});

test('a booker records a walkthrough no-show like a manager; only walkthrough performers start one', async t => {
  const { env: base, cookies } = await staffSessions(t), env = { ...base, ...ACCESS };
  const run = async (user, input, roleEnv = env) => {
    const store = memoryStore(roleEnv), session = await getHubSession(get(cookies[user], '/'), roleEnv);
    try { return { store, result: await recordWalkthroughVisit(store, session, { visitId: 'walk-1', requestId: randomUUID(), expectedRevision: 'wr1', ...input }, NOW) }; } catch (error) { return { store, error }; }
  };
  for (const user of ['Phone.Account', 'Sales.Account', 'Config.Phone']) {
    const { store, result } = await run(user, { action: 'no_show', reasonCode: 'unreachable' });
    assert.equal(result.action, 'no_show', user);
    assert.deepEqual([store.rows.get('jobs/walk-1').walkthroughOutcome.outcome, store.rows.get('jobs/walk-1').walkthroughOutcome.performedBy], ['customer_no_show', user.toLowerCase()]);
  }
  const start = await run('Phone.Account', { action: 'start', skipTimecard: true, recordingStatus: 'recorded' });
  assert.deepEqual([start.error.code, start.error.message], ['walkthrough_visit_forbidden', WALKTHROUGH_DENIAL]);
  const notMine = await run('Sales.Account', { action: 'start', skipTimecard: true, recordingStatus: 'recorded' });
  assert.equal(notMine.error.code, 'walkthrough_visit_not_assigned', 'a performer still starts only the walkthroughs assigned to them');
  const off = await run('Phone.Account', { action: 'no_show', reasonCode: 'unreachable' }, { ...base, EGC_STAFF_ROLE_PERMISSIONS: 'true' });
  assert.deepEqual([off.error.code, off.error.message], ['walkthrough_visit_forbidden', 'Only sales reps, managers and the owner can record walkthrough visits.']);
});

test('the Action Center admits followups.own holders and tells the platform their role: sales and phone act as sales', async t => {
  const { env: base, cookies } = await staffSessions(t, { EGC_OPERATIONS_ENABLED: 'true', EGC_OPERATIONS_SERVICE_AUTH: 'legacy', EGC_OPERATIONS_PORTAL_SIGNING_SECRET: OPS_SECRET, EGC_OPERATIONS_API_ORIGIN: 'https://operations.example.invalid' });
  const firestore = globalThis.fetch, seen = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    if (new URL(input).hostname !== 'operations.example.invalid') return firestore(input, init);
    // The platform's own verifier: signature, audience, freshness and a role it accepts.
    const { envelope } = JSON.parse(init.body), claims = await verifyOperationsEnvelope(envelope, OPS_SECRET, 'egc-operations', Date.parse(NOW));
    seen.push(claims.actor);
    return Response.json({ ok: true }, { headers: { 'Content-Type': 'application/json' } });
  });
  const expected = { ZacB: 'owner', TylerG: 'manager', 'Mgr.Account': 'manager', 'Config.Manager': 'manager', 'Sales.Account': 'sales', 'Legacy.Sales': 'sales', 'Phone.Account': 'sales', 'Config.Phone': 'sales' };
  for (const [user, role] of Object.entries(expected)) {
    seen.length = 0;
    const response = await operations.onRequestPost({ request: post(cookies[user], '/api/operations', { requestId: randomUUID(), body: { command: 'tasks.list' } }), env: { ...base, ...ACCESS } });
    assert.equal(response.status, 200, user);
    assert.deepEqual([seen.length, seen[0]?.id, seen[0]?.role], [1, user, role], user);
  }
  for (const user of ['Crew.Account', 'Lead.Account', 'Owner.Claim']) assert.equal((await operations.onRequestPost({ request: post(cookies[user], '/api/operations', { requestId: randomUUID(), body: {} }), env: { ...base, ...ACCESS } })).status, 403, user);
  // Flag off: business access only, and the session role as before.
  assert.equal((await operations.onRequestPost({ request: post(cookies['Phone.Account'], '/api/operations', { requestId: randomUUID(), body: {} }), env: base })).status, 403);
});

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = JSON.stringify({ type: 'service_account', project_id: 'egcw-1ec83', client_email: 'synthetic-claims@egcw-1ec83.iam.gserviceaccount.com', private_key: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }) });

test('a stored manager\'s Firebase session carries the business access and role the Hub gives it', async t => {
  const { env: base, cookies } = await staffSessions(t, { FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccount });
  const claims = async (user, env) => {
    const response = await firebaseSession({ env, request: get(cookies[user], '/api/firebase-session') });
    assert.equal(response.status, 200);
    return JSON.parse(Buffer.from((await response.json()).token.split('.')[1], 'base64url')).claims;
  };
  const on = await claims('Mgr.Account', { ...base, ...ACCESS }), off = await claims('Mgr.Account', base);
  assert.deepEqual([on.business_access, on.role, on.caps.includes('dispatch.write'), on.caps.includes('pay.manage')], [true, 'manager', true, false]);
  assert.deepEqual([off.business_access, off.role, off.caps], [false, 'crew', undefined]);
  const phone = await claims('Phone.Account', { ...base, ...ACCESS });
  assert.deepEqual([phone.business_access, phone.caps], [false, [...PHONE, 'schedule.book']]);
});

test('the staff page gate accepts "on" or "true" in any case with spaces trimmed, and /api/integration-status reports it', async () => {
  for (const value of ['on', 'true', 'TRUE', ' on ', 'On', ' True\n']) assert.equal(staffPageGateEnabled({ EGC_STAFF_PAGE_GATE: value }), true, JSON.stringify(value));
  for (const value of [undefined, '', 'off', 'false', 'yes', '1', 'o n', 'enabled', 7]) assert.equal(staffPageGateEnabled({ EGC_STAFF_PAGE_GATE: value }), false, JSON.stringify(value));
  assert.deepEqual([staffPageGateState({ EGC_STAFF_PAGE_GATE: ' TRUE ' }), staffPageGateState({ EGC_STAFF_PAGE_GATE: 'OFF' }), staffPageGateState({ EGC_STAFF_PAGE_GATE: 'yes' })],
    [{ enabled: true, recognized: true }, { enabled: false, recognized: true }, { enabled: false, recognized: false }]);
  const status = async (viewer, env) => (await (await integrationStatusHandlers({ session: async () => viewer, revocations: () => null, scheduleSync: async () => false, now: () => new Date(NOW) }).get({ request: new Request(`${ORIGIN}/api/integration-status`), env })).json()).status;
  const owner = { user: 'ZacB', role: 'owner', businessAccess: true }, crew = { user: 'Crew.Account', role: 'crew', businessAccess: false };
  assert.equal('staffPageGate' in await status(owner, {}), false, 'unset: nothing new is reported');
  assert.deepEqual((await status(owner, { EGC_STAFF_PAGE_GATE: 'TRUE' })).staffPageGate, { enabled: true, recognized: true });
  assert.deepEqual((await status(owner, { EGC_STAFF_PAGE_GATE: ' yes ' })).staffPageGate, { enabled: false, recognized: false, value: 'yes' });
  assert.deepEqual((await status(crew, { EGC_STAFF_PAGE_GATE: 'yes' })).staffPageGate, { enabled: false, recognized: false }, 'only business users see the value');
});

function crewClient(profile) {
  const store = () => { const map = new Map(); return { getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) }; };
  const context = { sessionStorage: store(), localStorage: store(), fetch: async () => { throw new Error('offline'); }, document: { readyState: 'loading', querySelector: () => null, getElementById: () => null }, location: { pathname: '/crew/' }, addEventListener() {}, dispatchEvent() {}, Event: class {}, console };
  context.window = context;
  vm.runInNewContext(readFileSync(new URL('../crew/hub-auth.js', import.meta.url), 'utf8'), context);
  for (const [key, value] of Object.entries(profile)) context.sessionStorage.setItem(key, value);
  return context;
}

test('the crew home names the role a refused walkthrough needs once role access is on, and keeps its old note otherwise', async () => {
  const page = readFileSync(new URL('../crew/index.html', import.meta.url), 'utf8');
  const line = page.split(/\r?\n/).find(row => row.startsWith('async function openCrewHome('));
  const open = async profile => {
    const nodes = new Map(), node = id => { if (!nodes.has(id)) nodes.set(id, { id, hidden: false, textContent: id === 'access-note' ? 'Walkthrough is a business tool for Zac, Tyler, and Alex. Your pre-job and closeout steps are in each assigned job’s field workflow.' : '', dataset: { businessHref: '/crew/prejob' }, setAttribute() {} }); return nodes.get(id); };
    const context = vm.createContext({ document: { getElementById: node }, location: { search: '?notice=walkthrough-restricted' }, URLSearchParams, Date, Promise, EGCHubAuth: { profile: () => profile, canRunBusiness: () => false, mountCrewNav() {} }, loadEmployeeData: async () => {}, loadAssignedJobs: async () => {} });
    vm.runInContext(line, context);
    await vm.runInContext('openCrewHome()', context);
    return node('access-note');
  };
  const roleBased = await open({ user: 'Phone.Account', displayName: 'Synthetic Phone', roleAccess: true });
  assert.deepEqual([roleBased.hidden, roleBased.textContent], [false, 'Walkthroughs need the Sales role. Ask the owner.']);
  const before = await open({ user: 'Crew.Account', displayName: 'Synthetic Crew' });
  assert.match(before.textContent, /^Walkthrough is a business tool/, 'flag off: the page is unchanged');
});

test('the gameplan asks a non-dispatcher for no crew names once role access is on; dispatchers and the flag-off page keep the field', () => {
  const gameplan = readFileSync(new URL('../crew/gameplan.html', import.meta.url), 'utf8');
  const line = prefix => gameplan.split(/\r?\n/).find(row => row.startsWith(prefix)) || assert.fail(prefix);
  const lines = ['const $=id=>', 'const money=', 'const addOn=', 'const hazardLabel=', 'const pricingNote=', 'function input(', 'function area(', 'function quoteLinesMarkup(', 'function depositSummary(', 'function durationText(',
    'function scheduleScreen(', 'function slotResults(', 'function recommend(', 'function estimatedJobMinutes(', 'function signedLines(', 'function readyToSend(', 'function slotSignature('];
  const screen = auth => {
    const context = vm.createContext({ PRICING: null, PRICING_ERROR: 'Pricing unavailable offline', walkthroughReady: true, SLOT_LOADING: false, SLOT_ERROR: '', SLOT_OPTIONS: [], SLOT_SIGNATURE: '', document: { getElementById: () => null }, validateStep: () => [], render() {}, save() {},
      buildJobInstructions: () => ({}), buildClientChecklists: () => ({ preJob: [], postJob: [] }), PHOTO_COUNT: 3, EGCHubAuth: auth, window: {} });
    vm.runInContext(line('const freshState='), context);
    context.S = Object.assign(vm.runInContext('freshState()', context), { name: 'Synthetic Customer', jobDate: '2026-10-01', startTime: '08:00', endTime: '13:00' });
    vm.runInContext(lines.map(line).join('\n'), context);
    return context.scheduleScreen();
  };
  const note = 'A manager assigns the crew in Dispatch after the sale.', help = 'Enter the crew or lead before refreshing';
  const sales = screen({ profile: () => ({ user: 'Sales.Account', roleAccess: true }), can: capability => capability === 'walkthrough.perform' });
  assert.ok(sales.includes(note)); assert.doesNotMatch(sales, /id="f-assignedTo"/);
  assert.ok(!sales.includes(help), 'no crew to enter, so no crew help');
  for (const auth of [{ profile: () => ({ user: 'Mgr.Account', roleAccess: true }), can: capability => capability === 'dispatch.write' }, { profile: () => ({ user: 'zacb' }) }]) {
    const page = screen(auth);
    assert.match(page, /id="f-assignedTo"/); assert.ok(!page.includes(note)); assert.ok(page.includes(help));
  }
});

test('the crew client opens the walkthrough exactly for walkthrough.perform once the server reports role access', async () => {
  const signedIn = (caps, extra = {}) => ({ egc_u: 'Synthetic.User', egc_business_access: 'false', egc_capabilities: JSON.stringify(caps), ...extra });
  assert.equal(crewClient(signedIn(['walkthrough.perform'], { egc_role_access: 'true' })).EGCHubAuth.canRunWalkthrough(), true);
  assert.equal(crewClient(signedIn(['dispatch.write', 'quotes.author'], { egc_business_access: 'true', egc_role_access: 'true' })).EGCHubAuth.canRunWalkthrough(), false, 'business access alone no longer opens it');
  assert.equal(crewClient(signedIn(['quotes.author'], { egc_role_access: 'true' })).EGCHubAuth.canRunWalkthrough(), false);
  assert.equal(crewClient(signedIn(['walkthrough.perform'], { egc_role_access: 'true' })).EGCHubAuth.canRunWalkthrough('someone.else'), false);
  // Without role access the P2-12 rule is unchanged.
  assert.equal(crewClient(signedIn(['quotes.author'])).EGCHubAuth.canRunWalkthrough(), true);
  assert.equal(crewClient(signedIn([], { egc_business_access: 'true' })).EGCHubAuth.canRunWalkthrough(), true);
  assert.equal(crewClient(signedIn(['walkthrough.perform'])).EGCHubAuth.canRunWalkthrough(), false);
  // The sign-in response sets or clears role access, and sign-out clears it.
  const context = crewClient({}), responses = [{ ok: true, user: 'Sales.Account', capabilities: ['walkthrough.perform'], roleAccess: true }, { ok: true, user: 'Sales.Account', capabilities: ['quotes.author'] }];
  context.fetch = async url => new Response(JSON.stringify(String(url).includes('firebase-session') ? { ok: true, token: 'synthetic-token' } : responses[0]), { status: 200 });
  context.firebase = { auth: () => ({ signInWithCustomToken: async () => {}, signOut: async () => {} }) };
  assert.equal(await context.EGCHubAuth.session(), 'Sales.Account');
  assert.equal(context.EGCHubAuth.profile().roleAccess, true);
  responses.shift();
  await context.EGCHubAuth.session();
  assert.equal(context.EGCHubAuth.profile().roleAccess, undefined);
  assert.equal(context.sessionStorage.getItem('egc_role_access'), null);
});

test('the owner\'s crew-size rule stays a warning for a booker, who cannot staff a visit; a manager is still blocked by it', async t => {
  const { env: base, cookies } = await staffSessions(t), env = { ...base, ...ACCESS };
  const blocked = () => { const desk = bookingDesk(t); desk.store.rows.set('dispatchSettings/current', { id: 'current', revision: 'settings-r1', blockCrewShort: true }); return desk; };
  const walkthrough = { action: 'schedule.create', customerId: 'c1', kind: 'walkthrough', changes: { date: '2026-09-24', time: '13:00', endTime: '14:00', title: 'Synthetic walkthrough' } };
  const job = { action: 'schedule.create', customerId: 'c1', kind: 'job', sourceJobId: 'job-crewed', changes: { date: '2026-09-26', time: '08:00', endTime: '10:00', jobInstructions: 'Synthetic scope', crewNeeded: 2 } };
  const move = desk => ({ action: 'schedule.update', jobId: 'job-today', expectedRevision: desk.rev('job-today'), changes: { date: '2026-09-23', time: '09:00', endTime: '11:00' }, reasonCode: 'customer_request', initiatedBy: 'customer' });
  for (const user of ['Sales.Account', 'Phone.Account']) {
    const desk = blocked();
    for (const body of [walkthrough, job, move(desk)]) {
      const saved = await desk.send(cookies[user], env, body);
      assert.equal(saved.status, 200, `${user} ${JSON.stringify(saved.body)}`);
      const short = saved.body.warnings.find(warning => warning.code === 'crew_size_short');
      assert.ok(short && !short.blocking, `${user}: the crew-size rule is reported, not enforced`);
    }
    assert.equal(desk.store.rows.get('jobs/job-today').date, '2026-09-23');
  }
  for (const user of ['Mgr.Account', 'ZacB']) {
    const desk = blocked();
    for (const body of [walkthrough, job, move(desk)]) {
      const refused = await desk.send(cookies[user], env, body);
      assert.deepEqual([refused.status, refused.body.code], [409, 'dispatch_conflict'], `${user} ${JSON.stringify(body.changes)}`);
      assert.ok(refused.body.details.conflicts.some(conflict => conflict.code === 'crew_size_short'), user);
    }
  }
});

test('a booker reschedules a legacy crew row and moves a split job\'s segments; crew and pickup crew-size changes stay a manager\'s', async t => {
  const { env: base, cookies } = await staffSessions(t), env = { ...base, ...ACCESS };
  const segment = (id, date, time, endTime, assignedCrew, crewLead = null) => ({ id, date, time, endDate: date, endTime, assignedCrew, crewLead, crewId: null, vehicleId: null, notes: '' });
  const desk = () => {
    const d = bookingDesk(t), job = { type: 'job', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', address: '100 Fixture Lane', jobInstructions: 'Synthetic scope', crewNeeded: 1 };
    d.store.segmentsEnabled = true;
    d.store.rows.set('jobs/job-legacy', { ...job, id: 'job-legacy', revision: 'lr1', date: '2026-09-24', endDate: '2026-09-24', time: '09:00', endTime: '11:00', assignedTo: 'Synthetic Crew One' });
    d.store.rows.set('jobs/job-split', { ...job, id: 'job-split', revision: 'sr1', date: '2026-09-25', endDate: '2026-09-26', time: '13:00', endTime: '11:00', assignedCrew: ['crew.one', 'zacb'], assignedTo: 'crew.one, zacb', crewLead: 'crew.one',
      assignmentSegments: [segment('s1', '2026-09-25', '13:00', '15:00', ['crew.one'], 'crew.one'), segment('s2', '2026-09-26', '09:00', '11:00', ['zacb'])] });
    d.store.rows.set('jobs/job-pickup', { ...job, id: 'job-pickup', revision: 'pr1', date: '2026-09-28', endDate: '2026-09-28', time: '09:00', endTime: '11:00', assignedCrew: ['crew.one'], assignedTo: 'crew.one', crewNeeded: 2, shiftPickupEnabled: true, openShift: true });
    return d;
  };
  const legacyMove = d => ({ action: 'schedule.update', jobId: 'job-legacy', expectedRevision: d.rev('job-legacy'), changes: { date: '2026-09-24', time: '13:00', endTime: '15:00', assignedCrew: ['crew.one'], crewLead: null } });
  const splitMove = (d, s2 = {}) => ({ action: 'schedule.update', jobId: 'job-split', expectedRevision: d.rev('job-split'), changes: { assignmentSegments: [segment('s1', '2026-09-25', '13:00', '15:00', ['crew.one'], 'crew.one'), { ...segment('s2', '2026-09-27', '10:00', '12:00', ['zacb']), notes: 'Synthetic gate code', ...s2 }] } });
  const pickup = (d, changes) => ({ action: 'schedule.update', jobId: 'job-pickup', expectedRevision: d.rev('job-pickup'), changes });
  // The owner (the control) and a booker get the same answer for the form's echo of the crew Dispatch shows.
  for (const user of ['ZacB', 'Sales.Account', 'Phone.Account']) {
    const d = desk();
    const legacy = await d.send(cookies[user], env, legacyMove(d));
    assert.equal(legacy.status, 200, `${user} ${JSON.stringify(legacy.body)}`); assert.deepEqual(d.store.rows.get('jobs/job-legacy').assignedCrew, ['crew.one']);
    const split = await d.send(cookies[user], env, splitMove(d));
    assert.equal(split.status, 200, `${user} ${JSON.stringify(split.body)}`);
    assert.deepEqual(d.store.rows.get('jobs/job-split').assignmentSegments.map(row => [row.id, row.date, row.time, row.assignedCrew, row.notes]), [['s1', '2026-09-25', '13:00', ['crew.one'], ''], ['s2', '2026-09-27', '10:00', ['zacb'], 'Synthetic gate code']]);
    const echo = await d.send(cookies[user], env, pickup(d, { date: '2026-09-28', time: '10:00', endTime: '12:00', crewNeeded: 2, requiredSkills: [], shiftPickupEnabled: true, assignedCrew: ['crew.one'] }));
    assert.equal(echo.status, 200, `${user} ${JSON.stringify(echo.body)}`);
  }
  for (const user of ['Sales.Account', 'Phone.Account']) {
    const d = desk(), before = JSON.stringify([...d.store.rows]);
    for (const [label, body] of [
      ['legacy recrew', { ...legacyMove(d), changes: { ...legacyMove(d).changes, assignedCrew: ['zacb'] } }],
      ['segment recrew', splitMove(d, { assignedCrew: ['crew.one'] })],
      ['segment lead', splitMove(d, { crewLead: 'zacb' })],
      ['segment vehicle', splitMove(d, { vehicleId: 'truck-1' })],
      ['add a segment', { ...splitMove(d), changes: { assignmentSegments: [...splitMove(d).changes.assignmentSegments, segment('s3', '2026-09-30', '09:00', '11:00', [])] } }],
      ['unsplit', { ...splitMove(d), changes: { assignmentSegments: [] } }],
      ['pickup crew size', pickup(d, { crewNeeded: 3 })],
      ['pickup skills', pickup(d, { requiredSkills: ['shelving'] })],
    ]) {
      const refused = await d.send(cookies[user], env, body);
      assert.deepEqual([refused.status, refused.body.code, refused.body.error], [403, 'dispatch_forbidden', ROLE_DENIAL.crew], `${user} ${label}`);
    }
    assert.equal(JSON.stringify([...d.store.rows]), before, 'a refused change writes nothing');
    // Crew size is a booking detail on a visit nobody can pick up.
    const sized = await d.send(cookies[user], env, { action: 'schedule.update', jobId: 'job-crewed', expectedRevision: d.rev('job-crewed'), changes: { crewNeeded: 2 } });
    assert.equal(sized.status, 200, `${user} ${JSON.stringify(sized.body)}`);
  }
});

// The injected Identity Toolkit call: never the real provider.
function revocationDesk() {
  const store = memoryStore(), calls = [];
  const service = createFirebaseRevocationService({ store, revoke: async (uid, validSince) => { calls.push({ uid, validSince }); return 'revoked'; } });
  const state = () => { const row = store.rows.get('firebaseSessionRevocations/state'); return row ? { intents: row.intents || [], pending: row.pending || [], revoked: row.revoked || [], staticRoster: row.staticRoster || null } : null; };
  return { service, calls, state, staff: () => calls.filter(call => call.uid !== FIREBASE_REVOCATION_PROBE_UID) };
}
const second = iso => Math.floor(Date.parse(iso) / 1000);

test('demoting a stored manager in the staff directory ends their Firebase data sessions; a refused change settles its intent, a lost one still revokes', async t => {
  const { env: base, cookies } = await staffSessions(t, { FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccount, EGC_STAFF_DIRECTORY_ENABLED: 'true' }), env = { ...base, ...ACCESS };
  const claims = async cookie => JSON.parse(Buffer.from((await (await firebaseSession({ env, request: get(cookie, '/api/firebase-session') })).json()).token.split('.')[1], 'base64url')).claims;
  assert.equal((await claims(cookies['Mgr.Account'])).business_access, true, 'the stored manager holds Firebase business access');
  const setRoles = async (desk, staffRoles, storage) => {
    const handlers = staffDirectoryHandlers({ now: () => new Date(NOW), revocations: () => desk.service, ...(storage ? { storage } : {}) });
    const listed = (await json(await handlers.get({ request: get(cookies.ZacB, '/api/staff-directory?username=Mgr.Account'), env }))).body.people[0];
    return json(await handlers.post({ request: post(cookies.ZacB, '/api/staff-directory', { action: 'set_roles', requestId: randomUUID(), username: 'Mgr.Account', expectedRevision: listed.revision, staffRoles }), env }));
  };
  // A commit refused by a racing change: the intent is settled and nobody is revoked.
  const refusedDesk = revocationDesk();
  const conflict = await setRoles(refusedDesk, ['crew'], e => ({ ...staffDirectoryStorage(e), commit: async () => { throw Object.assign(new Error('changed'), { code: 'staff_directory_revision_conflict', status: 409 }); } }));
  assert.equal(conflict.status, 409);
  assert.deepEqual([refusedDesk.staff(), refusedDesk.state().intents], [[], []]);
  // A lost commit may have landed: its intent is revoked at once.
  const lostDesk = revocationDesk();
  const lost = await setRoles(lostDesk, ['crew'], e => ({ ...staffDirectoryStorage(e), commit: async () => { throw Object.assign(new Error('lost'), { code: 'staff_directory_outcome_unknown', status: 503 }); } }));
  assert.equal(lost.status, 503);
  assert.deepEqual([lostDesk.staff(), lostDesk.state().intents], [[{ uid: 'hub:mgr.account', validSince: second(NOW) + 1 }], []]);
  // The demotion itself.
  const desk = revocationDesk(), demoted = await setRoles(desk, ['crew']);
  assert.equal(demoted.status, 200, JSON.stringify(demoted.body));
  assert.deepEqual([demoted.body.sessionsRevoked, demoted.body.firebaseRevocation], [true, { status: 'revoked' }]);
  assert.deepEqual(desk.staff(), [{ uid: 'hub:mgr.account', validSince: second(NOW) + 1 }], 'sessions minted before the saved change end with it');
  assert.deepEqual([desk.state().intents, desk.state().pending, desk.state().revoked.map(entry => entry.uid)], [[], [], ['hub:mgr.account']]);
  assert.equal(await getHubSession(get(cookies['Mgr.Account'], '/'), env), null, 'the Hub session ended too');
  const { login } = await import('./helpers/vault-fixture.mjs');
  const fresh = await login(env, 'Mgr.Account');
  assert.deepEqual([fresh.profile.businessAccess, (await claims(fresh.cookie)).business_access], [false, false]);
  // Saving the same roles again changes nothing and revokes nothing.
  const again = await setRoles(desk, ['crew']);
  assert.deepEqual([again.body.unchanged, again.body.firebaseRevocation, desk.staff().length], [true, undefined, 1]);
});

test('turning role access off ends every stored manager\'s Firebase data sessions through the staff roster; off from the start reads no account', async t => {
  const { env: base, cookies, fire } = await staffSessions(t), env = { ...base, ...ACCESS };
  // Flag off: exactly the configured users, and no employee account is read.
  const reads = fire.requests.length;
  assert.deepEqual(await listHubAccessProfiles(base), listHubUserProfiles(base));
  assert.equal(fire.requests.length, reads);
  const on = await listHubAccessProfiles(env);
  assert.deepEqual(on.filter(profile => !listHubUserProfiles(env).some(configured => configured.user === profile.user)).map(profile => [profile.user, profile.role, hasBusinessAccess(profile)]), [['Mgr.Account', 'manager', true]], 'only stored managers join, with business access');
  const desk = revocationDesk();
  const status = async (flags, minutes) => (await json(await integrationStatusHandlers({ revocations: () => desk.service, scheduleSync: async () => false, now: () => new Date(Date.parse(NOW) + minutes * 60000) })
    .get({ request: get(cookies.ZacB, '/api/integration-status'), env: flags }))).body.status;
  const on1 = await status(env, 0);
  assert.equal(on1.firebaseRevocationState, 'verified');
  assert.deepEqual(desk.state().staticRoster.filter(entry => ['hub:mgr.account', 'hub:config.manager'].includes(entry.uid)), [{ uid: 'hub:config.manager', fingerprint: 'manager|true' }, { uid: 'hub:mgr.account', fingerprint: 'manager|true' }]);
  assert.deepEqual(desk.staff(), [], 'gaining access revokes nobody');
  // Rollback: the stored manager leaves the roster and the configured one loses business access.
  const at = new Date(Date.parse(NOW) + 60000).toISOString();
  assert.equal((await status(base, 1)).firebaseRevocationState, 'verified');
  assert.deepEqual(desk.staff(), [{ uid: 'hub:config.manager', validSince: second(at) }, { uid: 'hub:mgr.account', validSince: second(at) }]);
  assert.equal(desk.state().staticRoster.some(entry => entry.uid === 'hub:mgr.account'), false);
  // A preview deployment never reconciles the production roster.
  const preview = revocationDesk();
  await (await integrationStatusHandlers({ revocations: () => preview.service, scheduleSync: async () => false, now: () => new Date(NOW) }).get({ request: new Request('https://preview.easy-garage-cleaning.pages.dev/api/integration-status', { headers: { Cookie: cookies.ZacB } }), env })).json();
  assert.equal(preview.state()?.staticRoster ?? null, null);
});

// set_roles on Mgr.Account through the real staff directory API, as the owner.
async function setStaffRoles(cookies, env, staffRoles, handlerOptions) {
  const handlers = staffDirectoryHandlers({ now: () => new Date(NOW), ...handlerOptions });
  const listed = (await json(await handlers.get({ request: get(cookies.ZacB, '/api/staff-directory?username=Mgr.Account'), env }))).body.people[0];
  return json(await handlers.post({ request: post(cookies.ZacB, '/api/staff-directory', { action: 'set_roles', requestId: randomUUID(), username: 'Mgr.Account', expectedRevision: listed.revision, staffRoles }), env }));
}

test('a demotion the server account is not allowed to sign out is saved, answered revocation_pending and queued for Integrations', async t => {
  const { env: base, cookies } = await staffSessions(t, { FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccount, EGC_STAFF_DIRECTORY_ENABLED: 'true' }), env = { ...base, ...ACCESS };
  const store = memoryStore(), calls = [];
  // The Identity Toolkit answer without the Firebase Authentication Admin role (identityToolkitRevoker's 401/403).
  const service = createFirebaseRevocationService({ store, revoke: async (uid, validSince) => { calls.push({ uid, validSince }); throw Object.assign(new Error('denied'), { code: 'firebase_revocation_permission_denied' }); } });
  const demoted = await setStaffRoles(cookies, env, ['crew'], { revocations: () => service });
  assert.equal(demoted.status, 200, JSON.stringify(demoted.body));
  assert.equal(demoted.body.sessionsRevoked, true, 'the Hub sessions still ended');
  assert.deepEqual([demoted.body.firebaseRevocation.status, demoted.body.firebaseRevocation.error], ['revocation_pending', 'permission_denied']);
  assert.match(demoted.body.firebaseRevocation.message, /Firebase Authentication Admin role/);
  assert.deepEqual(calls, [{ uid: 'hub:mgr.account', validSince: second(NOW) + 1 }]);
  const state = store.rows.get('firebaseSessionRevocations/state');
  assert.deepEqual(state.pending.map(entry => [entry.uid, entry.reason, entry.requestedAt, entry.attempts, entry.lastError]), [['hub:mgr.account', 'account_status', new Date((second(NOW) + 1) * 1000).toISOString(), 1, 'permission_denied']]);
  assert.deepEqual(state.intents, [], 'the queued failure settles the intent recorded before the change');
  // Integrations shows it pending, naming the missing permission.
  const status = (await json(await integrationStatusHandlers({ revocations: () => service, scheduleSync: async () => false, now: () => new Date(NOW) })
    .get({ request: get(cookies.ZacB, '/api/integration-status'), env }))).body.status;
  assert.deepEqual([status.firebaseRevocation, status.firebaseRevocationState, status.firebaseRevocationPending, status.firebaseRevocationError], [false, 'revocation_pending', 1, 'permission_denied']);
});

test('with role access off a staff role change records and revokes nothing and answers without firebaseRevocation, as before AUTH-ROLES', async t => {
  const { env: base, cookies } = await staffSessions(t, { FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccount, EGC_STAFF_DIRECTORY_ENABLED: 'true' });
  let turn = 0;
  for (const flags of [{}, { EGC_STAFF_ROLE_PERMISSIONS: 'true' }, { EGC_STAFF_ROLE_ACCESS: 'TRUE' }, { EGC_STAFF_ROLE_ACCESS: '1' }, { EGC_STAFF_ROLE_ACCESS: 'false', EGC_STAFF_ROLE_PERMISSIONS: 'true' }]) {
    const desk = revocationDesk();
    let asked = 0;
    const changed = await setStaffRoles(cookies, { ...base, ...flags }, turn++ % 2 ? ['manager'] : ['crew'], { revocations: () => { asked += 1; return desk.service; } });
    assert.equal(changed.status, 200, `${JSON.stringify(flags)} ${JSON.stringify(changed.body)}`);
    assert.equal(changed.body.sessionsRevoked, true, 'the Hub sessions end on a role change, as before');
    assert.equal(Object.hasOwn(changed.body, 'firebaseRevocation'), false, JSON.stringify(flags));
    assert.deepEqual([asked, desk.calls, desk.state()], [0, [], null], `${JSON.stringify(flags)}: no intent, no Identity Toolkit call, no state`);
  }
});

test('a stored manager is in the Firebase staff roster before their session is minted, so turning role access off revokes it with no Hub load in between', async t => {
  const { env: base, cookies } = await staffSessions(t, { FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccount }), env = { ...base, ...ACCESS };
  const desk = revocationDesk();
  let clock = Date.parse(NOW);
  const at = () => new Date(clock);
  const mint = async (user, flags, service = desk.service) => json(await firebaseSessionHandlers({ revocations: () => service, now: at }).get({ env: flags, request: get(cookies[user], '/api/firebase-session') }));
  const claims = minted => JSON.parse(Buffer.from(minted.body.token.split('.')[1], 'base64url')).claims;
  const status = async flags => (await json(await integrationStatusHandlers({ revocations: () => desk.service, scheduleSync: async () => false, now: at })
    .get({ request: get(cookies.ZacB, '/api/integration-status'), env: flags }))).body.status;
  const entry = uid => desk.state().staticRoster.find(row => row.uid === uid) ?? null;
  // The production Hub was last loaded before role access was turned on.
  await status(base);
  assert.deepEqual([entry('hub:mgr.account'), entry('hub:config.manager')], [null, { uid: 'hub:config.manager', fingerprint: 'crew|false' }]);
  // Role access on: the stored managers work only from /crew/, which mints without an integration-status load.
  for (const user of ['Mgr.Account', 'Config.Manager']) {
    const minted = await mint(user, env);
    assert.equal(minted.status, 200, `${user} ${JSON.stringify(minted.body)}`);
    assert.deepEqual([claims(minted).business_access, claims(minted).role], [true, 'manager'], user);
  }
  // Each entry carries the admit's time (at), so a reconciliation revokes from after the latest admit.
  assert.deepEqual([entry('hub:mgr.account'), entry('hub:config.manager')], [{ uid: 'hub:mgr.account', fingerprint: 'manager|true', at: NOW }, { uid: 'hub:config.manager', fingerprint: 'manager|true', at: NOW }]);
  // A session recorded at the same instant, the configured business users and anyone without business access write nothing.
  const recorded = JSON.stringify(desk.state());
  for (const user of ['Mgr.Account', 'ZacB', 'TylerG', 'Crew.Account', 'Sales.Account', 'Phone.Account']) assert.equal((await mint(user, env)).status, 200, user);
  for (const user of ['Mgr.Account', 'Config.Manager']) assert.equal(claims(await mint(user, base)).business_access, false, `${user} flag off`);
  assert.equal(JSON.stringify(desk.state()), recorded);
  assert.deepEqual(desk.staff(), [], 'recording a session revokes nobody');
  // Role access off: the next production Hub load ends both managers' sessions.
  clock += 60000;
  assert.equal((await status(base)).firebaseRevocationState, 'verified');
  const off = second(at().toISOString());
  assert.deepEqual(desk.staff(), [{ uid: 'hub:config.manager', validSince: off }, { uid: 'hub:mgr.account', validSince: off }]);
  assert.deepEqual([entry('hub:mgr.account'), entry('hub:config.manager')], [null, { uid: 'hub:config.manager', fingerprint: 'crew|false' }]);
  // A stored manager whose session cannot be recorded gets none; a configured business user is unaffected.
  const down = createFirebaseRevocationService({ store: { read: async () => { throw Object.assign(new Error('down'), { code: 'dispatch_unavailable' }); }, commit: async () => { throw new Error('never reached'); } }, revoke: async () => 'revoked' });
  const refused = await mint('Mgr.Account', env, down);
  assert.deepEqual([refused.status, refused.body.code, refused.body.token], [503, 'FIREBASE_AUTH_UNAVAILABLE', undefined]);
  assert.equal(claims(await mint('ZacB', env, down)).business_access, true);
});

// Times on the fixed test day, for the reconciliation races below.
const clockAt = hms => `2026-09-22T${hms}.000Z`;
const OWNER_PROFILE = { user: 'ZacB', role: 'owner', businessAccess: true }, MANAGER_PROFILE = { user: 'Mgr.Account', role: 'manager', businessAccess: true };

test('a stored manager admitted while a reconciliation is in flight is revoked from after the admit, never dropped untracked', async () => {
  // The admitted session begins at the browser's sign-in right after the admit; the queued time covers that.
  const after = (hms, ms = FIREBASE_REVOCATION_ADMIT_EXCHANGE_MS) => new Date((Math.floor((Date.parse(clockAt(hms)) + ms) / 1000) + 1) * 1000).toISOString();
  assert.equal(after('16:00:05'), clockAt('16:00:36'));
  const roster = desk => desk.state().staticRoster;
  // 1. Role access turns off. The new deployment's Hub load reads state at 16:00:00; in the same seconds a request still on
  //    the old deployment admits Mgr.Account, whose entry already matches, and mints at 16:00:05.
  const desk = revocationDesk();
  await desk.service.maintain([OWNER_PROFILE, MANAGER_PROFILE], clockAt('15:00:00'));
  const known = await desk.service.read();
  await desk.service.admit(MANAGER_PROFILE, clockAt('16:00:05'));
  assert.deepEqual(roster(desk).find(entry => entry.uid === 'hub:mgr.account'), { uid: 'hub:mgr.account', fingerprint: 'manager|true', at: clockAt('16:00:05') }, 'a matching entry is re-stamped, so the admit is written');
  const offLoad = await desk.service.maintain([OWNER_PROFILE], clockAt('16:00:00'), known);
  assert.deepEqual(desk.staff(), [{ uid: 'hub:mgr.account', validSince: second(clockAt('16:00:00')) }], 'sessions from before the Hub load end at once');
  assert.deepEqual(desk.state().pending, [{ uid: 'hub:mgr.account', reason: 'static_removed', requestedAt: after('16:00:05'), attempts: 0, lastAttemptAt: '', lastError: '' }], 'the admitted session is queued, not lost');
  assert.equal(roster(desk).some(entry => entry.uid === 'hub:mgr.account'), false);
  assert.deepEqual([offLoad.firebaseRevocationState, offLoad.firebaseRevocationPending], ['revocation_pending', 1]);
  // A pass before the queued time never sends validSince ahead of itself; the next one after it ends the session.
  const early = await desk.service.maintain([OWNER_PROFILE], clockAt('16:00:20'));
  assert.deepEqual([desk.staff().length, early.firebaseRevocationState], [1, 'revocation_pending']);
  const later = await desk.service.maintain([OWNER_PROFILE], clockAt('17:00:00'));
  assert.deepEqual(desk.staff(), [{ uid: 'hub:mgr.account', validSince: second(clockAt('16:00:00')) }, { uid: 'hub:mgr.account', validSince: second(after('16:00:05')) }]);
  assert.ok(second(after('16:00:05')) > second(new Date(Date.parse(clockAt('16:00:05')) + FIREBASE_REVOCATION_ADMIT_EXCHANGE_MS - 1).toISOString()), 'a sign-in within the exchange window after the admit is revoked');
  assert.deepEqual([desk.state().pending, later.firebaseRevocationState], [[], 'verified']);
  assert.equal((await desk.service.maintain([OWNER_PROFILE], clockAt('18:00:00'))).firebaseRevocationState, 'verified');
  assert.equal(desk.staff().length, 2, 'nothing more to revoke');

  // 2. A promotion lands between a Hub load's staff listing and its save: the listing still shows Mgr.Account without
  //    business access, and the save (another person was removed) drops the admitted entry. It is queued from after the admit.
  const promoted = revocationDesk();
  const leaver = { user: 'Synthetic.Leaver', role: 'crew', businessAccess: false };
  await promoted.service.maintain([OWNER_PROFILE, leaver], clockAt('15:00:00'));
  const listed = await promoted.service.read();
  await promoted.service.admit(MANAGER_PROFILE, clockAt('16:00:05'));
  await promoted.service.maintain([OWNER_PROFILE], clockAt('16:00:00'), listed);
  assert.deepEqual(promoted.staff(), [{ uid: 'hub:synthetic.leaver', validSince: second(clockAt('16:00:00')) }]);
  assert.deepEqual(promoted.state().pending.map(entry => [entry.uid, entry.reason, entry.requestedAt]), [['hub:mgr.account', 'static_removed', after('16:00:05')]]);
  await promoted.service.maintain([OWNER_PROFILE], clockAt('17:00:00'));
  assert.deepEqual(promoted.staff().at(-1), { uid: 'hub:mgr.account', validSince: second(after('16:00:05')) });
  assert.deepEqual(promoted.state().pending, []);

  // 3. An entry admitted long before the change is revoked at the Hub load, as before; nothing is queued.
  const settled = revocationDesk();
  await settled.service.admit(MANAGER_PROFILE, clockAt('09:00:00'));
  await settled.service.maintain([OWNER_PROFILE, MANAGER_PROFILE], clockAt('15:00:00'));
  assert.deepEqual(roster(settled).find(entry => entry.uid === 'hub:mgr.account'), { uid: 'hub:mgr.account', fingerprint: 'manager|true', at: clockAt('09:00:00') }, 'a reconciliation that lists the person keeps the stamp');
  await settled.service.maintain([OWNER_PROFILE], clockAt('16:00:00'));
  assert.deepEqual([settled.staff(), settled.state().pending], [[{ uid: 'hub:mgr.account', validSince: second(clockAt('16:00:00')) }], []]);
});

test('an admit keeps the latest stamp, and the roster stamp is optional and validated when the state is read', async () => {
  const desk = revocationDesk();
  await desk.service.admit(MANAGER_PROFILE, clockAt('16:00:10'));
  const written = desk.state();
  // A slower request stamped earlier keeps the later time and writes nothing.
  await desk.service.admit(MANAGER_PROFILE, clockAt('16:00:07'));
  assert.equal(JSON.stringify(desk.state()), JSON.stringify(written));
  assert.deepEqual(written.staticRoster, [{ uid: 'hub:mgr.account', fingerprint: 'manager|true', at: clockAt('16:00:10') }]);
  const base = { pending: [], intents: [], revoked: [], verifiedAt: '', probedAt: '', probeError: '' };
  assert.deepEqual(decodeFirebaseRevocationState({ ...base, staticRoster: [{ uid: 'hub:a', fingerprint: 'crew|false' }] }).staticRoster, [{ uid: 'hub:a', fingerprint: 'crew|false' }], 'a record from before the stamp still reads');
  assert.deepEqual(decodeFirebaseRevocationState({ ...base, staticRoster: [{ uid: 'hub:a', fingerprint: 'manager|true', at: clockAt('16:00:10') }] }).staticRoster, [{ uid: 'hub:a', fingerprint: 'manager|true', at: clockAt('16:00:10') }]);
  for (const at of ['soon', 5, null, '']) assert.throws(() => decodeFirebaseRevocationState({ ...base, staticRoster: [{ uid: 'hub:a', fingerprint: 'manager|true', at }] }), error => error.code === 'firebase_revocation_state_unreadable', String(at));
});

test('a stored manager reaches Action Center Hub commands and recurring plans through the operations bridge; sales, phone and the flag-off account do not', async t => {
  const { env: base } = await staffSessions(t), env = { ...base, ...ACCESS };
  const run = (flags, id, role) => runHubCommand(flags, { id, role, kind: 'human', workspace: 'egc' }, { command: 'hub.dispatch.overview', view: 'schedule', startDate: '2026-09-22', endDate: '2026-09-29' }, { storage: () => memoryStore(flags), now: () => new Date(NOW) });
  for (const user of ['Mgr.Account', 'Config.Manager', 'TylerG']) {
    const result = await run(env, user, 'manager');
    assert.deepEqual([result.ok, result.command, result.actedAs.user], [true, 'hub.dispatch.overview', user], user);
    assert.ok(result.jobs.some(job => job.id === 'job-crewed'), user);
  }
  for (const [flags, user, role, code] of [[base, 'Mgr.Account', 'manager', 'hub_actor_unknown'], [base, 'Config.Manager', 'manager', 'hub_actor_role_forbidden'],
    [env, 'Sales.Account', 'sales', 'hub_role_forbidden'], [env, 'Phone.Account', 'sales', 'hub_role_forbidden'], [env, 'Lead.Account', 'manager', 'hub_actor_unknown']]) {
    await assert.rejects(run(flags, user, role), error => error.code === code, `${user} ${code}`);
  }
  // A recurring plan a stored manager saved keeps running as them.
  const worker = { id: RECURRING_HORIZON_ACTOR, kind: 'integration', role: 'integration' }, people = await listHubAccessProfiles(env);
  for (const user of ['Mgr.Account', 'Config.Manager']) assert.equal(hasBusinessAccess(planManagerSession({ updatedBy: user }, people, worker)), true, user);
  for (const user of ['Mgr.Account', 'Config.Manager']) assert.throws(() => planManagerSession({ updatedBy: user }, listHubUserProfiles(base), worker), error => error.code === 'recurring_plan_manager_inactive', user);
});
