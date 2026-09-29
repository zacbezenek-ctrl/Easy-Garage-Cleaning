import test from 'node:test';
import assert from 'node:assert/strict';
import { canDispatch } from '../functions/_lib/dispatch-permissions.js';
import { dispatchOverview, requireDispatcher } from '../functions/_lib/dispatch-service.js';
import { dispatchHandlers } from '../functions/api/dispatch.js';
import { dispatchOpeningsHandlers } from '../functions/api/dispatch-openings.js';
import { dispatchRoster } from '../functions/_lib/dispatch-storage.js';
import { hasBusinessAccess } from '../functions/_lib/hub-session.js';
import { writeOne } from '../functions/_lib/employee-vault.js';
import { vaultFirestore, staffEnv, cookieFor, seedAccount, login, ORIGIN } from './helpers/vault-fixture.mjs';
import { messageSendHandlers } from '../functions/api/message-sends.js';
import { stripeReviewHandlers } from '../functions/api/stripe-reviews.js';
import { garageGuardMemberHandlers } from '../functions/api/garage-guard-members.js';
import { funnelDimensionsHandlers } from '../functions/api/funnel-dimensions.js';
import { customerLifecycleHandlers } from '../functions/api/customer-lifecycle.js';
import { moneyHandlers } from '../functions/api/money.js';
import { jobLaborCostsHandlers } from '../functions/api/job-labor-costs.js';
import { employeePtoHandlers } from '../functions/api/employee-pto.js';
import { dispatchSettingsHandlers } from '../functions/api/dispatch-settings.js';
import { STAFF_CAPABILITIES, can, sanitizeStaffRoles } from '../functions/_lib/staff-roles.js';

const NOW = new Date('2026-09-22T12:00:00.000Z');
const legacyDispatcher = session => Boolean(session) && hasBusinessAccess(session) && ['owner', 'manager'].includes(session.role);
function memoryStore() {
  return { jobs: async () => [], resources: async () => [], customers: async () => [], roster: async () => [{ id: 'zacb', name: 'Synthetic Owner', role: 'owner' }], read: async () => null, commit: async () => { throw new Error('Reads never write.'); } };
}
const get = (cookie, env, path = '/api/dispatch?startDate=2026-09-23&endDate=2026-09-24') => new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie } });

test('dispatch permission matrix across the six staff roles, with stored staff roles off (default) and on', async t => {
  vaultFirestore(t);
  const base = staffEnv();
  await seedAccount(base, 'Mgr.Account', { extra: { staffRoles: ['manager'] } });
  await seedAccount(base, 'Lead.Account', { extra: { staffRoles: ['crew_lead'] } });
  await seedAccount(base, 'Crew.Account');
  await seedAccount(base, 'Sales.Account', { sales: true });
  await seedAccount(base, 'Phone.Account', { extra: { staffRoles: ['phone'] } });
  const cookies = {};
  for (const user of ['ZacB', 'TylerG', 'AlexK', 'Crew.Static']) cookies[user] = await cookieFor(base, user);
  for (const user of ['Mgr.Account', 'Lead.Account', 'Crew.Account', 'Sales.Account', 'Phone.Account']) cookies[user] = (await login(base, user)).cookie;
  // owner, manager, crew_lead (business access but not a dispatcher role), crew, sales, phone.
  const matrix = {
    ZacB: [200, 200], TylerG: [200, 200], AlexK: [403, 403], 'Crew.Static': [403, 403],
    'Mgr.Account': [403, 200], 'Lead.Account': [403, 403], 'Crew.Account': [403, 403], 'Sales.Account': [403, 403], 'Phone.Account': [403, 403],
  };
  for (const [index, flags] of [{}, { EGC_STAFF_ROLE_PERMISSIONS: 'true' }].entries()) {
    const env = { ...base, ...flags }, handlers = dispatchHandlers({ storage: memoryStore, now: () => NOW }), openings = dispatchOpeningsHandlers({ storage: memoryStore, now: () => NOW });
    for (const [user, statuses] of Object.entries(matrix)) {
      const response = await handlers.get({ request: get(cookies[user], env), env });
      assert.equal(response.status, statuses[index], `${user} ${JSON.stringify(flags)}`);
      if (response.status === 403) assert.equal((await response.json()).code, 'dispatch_forbidden');
      const probe = await openings.get({ request: get(cookies[user], env, '/api/dispatch-openings?employeeIds=zacb'), env });
      assert.equal(probe.status === 403, statuses[index] === 403, `openings follow the same permission for ${user}`);
    }
  }
  assert.equal((await dispatchHandlers({ storage: memoryStore }).get({ request: get('', base), env: base })).status, 401);
  // A configured manager whose stored roles say crew loses dispatch only with the flag on.
  const demoted = staffEnv({}, { TylerG: { passwordHash: 'unused', role: 'manager', displayName: 'Synthetic Manager', staffRoles: ['crew'] } });
  const cookie = await cookieFor(demoted, 'TylerG');
  assert.equal((await dispatchHandlers({ storage: memoryStore, now: () => NOW }).get({ request: get(cookie, demoted), env: demoted })).status, 200);
  const on = { ...demoted, EGC_STAFF_ROLE_PERMISSIONS: 'true' };
  assert.equal((await dispatchHandlers({ storage: memoryStore, now: () => NOW }).get({ request: get(cookie, on), env: on })).status, 403);
});

test('canDispatch is today\'s check without env, and a handler-verified session carries through the library calls of its request', async () => {
  const on = { EGC_STAFF_ROLE_PERMISSIONS: 'true' };
  const sessions = [
    { user: 'ZacB', role: 'owner', businessAccess: true }, { user: 'TylerG', role: 'manager', businessAccess: true }, { user: 'AlexK', role: 'crew_lead', businessAccess: true },
    { user: 'TylerG', role: 'manager', businessAccess: false }, { user: 'Someone', role: 'manager', businessAccess: true }, { user: 'Crew.Account', role: 'crew', businessAccess: false, source: 'employee-account', staffRoles: ['manager'] }, null, 'zacb',
  ];
  for (const session of sessions) {
    assert.equal(canDispatch(session), legacyDispatcher(session), JSON.stringify(session));
    assert.equal(canDispatch(session, {}), legacyDispatcher(session), JSON.stringify(session));
  }
  const employee = { user: 'Crew.Account', displayName: 'Synthetic Crew', role: 'crew', businessAccess: false, source: 'employee-account', staffRoles: ['manager'] };
  assert.throws(() => requireDispatcher(employee), error => error.code === 'dispatch_forbidden' && error.status === 403);
  assert.throws(() => requireDispatcher(null), error => error.code === 'dispatch_sign_in_required' && error.status === 401);
  const denied = { ...employee, staffRoles: ['crew'] };
  assert.throws(() => requireDispatcher(denied, on), error => error.code === 'dispatch_forbidden');
  assert.throws(() => requireDispatcher(denied), error => error.code === 'dispatch_forbidden', 'a denied check is never remembered as a grant');
  requireDispatcher(employee, on);
  const result = await dispatchOverview(memoryStore(), employee, { startDate: '2026-09-23', endDate: '2026-09-24' }, NOW);
  assert.equal(result.ok, true, 'the library call for the verified session needs no env');
  await assert.rejects(dispatchOverview(memoryStore(), { ...employee }, {}, NOW), error => error.code === 'dispatch_forbidden', 'a copy of a session is checked afresh');
  assert.throws(() => requireDispatcher(Object.freeze({ ...employee, staffRoles: ['sales'] }), on), error => error.code === 'dispatch_forbidden');
});

test('a session allowed under one env is checked again under an explicit env that denies it', async () => {
  const on = { EGC_STAFF_ROLE_PERMISSIONS: 'true' }, off = {};
  const promoted = { user: 'Crew.Account', displayName: 'Synthetic Crew', role: 'crew', businessAccess: false, source: 'employee-account', staffRoles: ['manager'] };
  assert.equal(canDispatch(promoted, on), true, 'stored roles grant dispatch with the flag on');
  assert.equal(canDispatch(promoted), true, 'the library calls of that request carry the grant');
  assert.equal(canDispatch(promoted, off), false, 'the same object under an explicit env with the flag off is denied, not remembered as allowed');
  assert.throws(() => requireDispatcher(promoted, off), error => error.code === 'dispatch_forbidden' && error.status === 403);
  assert.equal(canDispatch(promoted), false, 'the denial replaces the earlier grant for later calls without env');
  await assert.rejects(dispatchOverview(memoryStore(), promoted, { startDate: '2026-09-23', endDate: '2026-09-24' }, NOW), error => error.code === 'dispatch_forbidden');
  assert.equal(canDispatch(promoted, on), true, 'an allowing env grants it again');
});

test('the enriched dispatch roster carries roles, skills and weekly hours but never pay, phone or contact data', async t => {
  vaultFirestore(t);
  const env = staffEnv();
  await seedAccount(env, 'Crew.Account', { extra: { staffRoles: ['crew_lead'] } });
  await writeOne(env, 'profiles', 'crew.account', { username: 'Crew.Account', hourlyRate: 27.5, payRates: [{ effectiveFrom: '2026-01-01', hourlyRate: 27.5, payType: 'hourly', overtimeMultiplier: 1.5 }], phone: '970-555-0199', email: 'crew.account@example.invalid', skills: [{ id: 'truck_driving', level: 'lead', verifiedBy: 'zacb', verifiedAt: '2026-09-01T12:00:00.000Z' }], weeklyAvailability: { mon: [{ start: '08:00', end: '16:00' }] } }, { data: null }, '2026-09-22T12:00:00.000Z');
  const roster = await dispatchRoster({ ...env, EGC_STAFF_DIRECTORY_ENABLED: 'true' });
  const row = roster.find(person => person.id === 'crew.account');
  assert.deepEqual(Object.keys(row).sort(), ['id', 'name', 'role', 'skills', 'staffRoles', 'weeklyAvailability']);
  assert.deepEqual(row.skills, [{ id: 'truck_driving', level: 'lead' }]);
  assert.equal(row.role, 'crew_lead');
  const text = JSON.stringify(roster);
  for (const secret of ['hourlyRate', 'payRates', '27.5', '970-555-0199', '9705550142', 'example.invalid', 'payType', 'verifiedBy', 'passwordHash']) assert.equal(text.includes(secret), false, secret);
});

test('owner decision F19: with the staff directory on, an office-only owner or manager is marked fieldWork:false; stored crew roles clear it', async t => {
  vaultFirestore(t);
  const env = staffEnv({}, {
    // Configured users who also work in the field record it as crew roles in the Hub user configuration.
    'Field.Manager': { passwordHash: 'unused', role: 'manager', displayName: 'Synthetic Field Manager', staffRoles: ['manager', 'crew'] },
    'Office.Manager': { passwordHash: 'unused', role: 'manager', displayName: 'Synthetic Office Manager', staffRoles: ['manager'], takesFieldWork: true },
  });
  await seedAccount(env, 'Mgr.Account', { extra: { staffRoles: ['manager'] } });
  await seedAccount(env, 'Mgr.Lead', { extra: { staffRoles: ['manager', 'crew_lead'] } });
  await seedAccount(env, 'Crew.Account');
  const on = Object.fromEntries((await dispatchRoster({ ...env, EGC_STAFF_DIRECTORY_ENABLED: 'true' })).map(person => [person.id, person]));
  const marked = Object.values(on).filter(person => 'fieldWork' in person).map(person => [person.id, person.fieldWork]).sort();
  assert.deepEqual(marked, [['mgr.account', false], ['office.manager', false], ['tylerg', false], ['zacb', false]], 'only office-only owners and managers carry the marker; an unknown config key changes nothing');
  for (const id of ['field.manager', 'mgr.lead', 'alexk', 'crew.static', 'crew.account']) assert.equal(on[id].fieldWork, undefined, id);
  assert.deepEqual([on['field.manager'].role, on['mgr.lead'].role], ['manager', 'manager'], 'field work does not change the role');
  // With the directory off (the default) the roster is unchanged: no marker on anyone.
  const off = await dispatchRoster(env);
  assert.ok(off.every(person => JSON.stringify(Object.keys(person)) === '["id","name","role"]'));
});

test('manager endpoints added on the integration branch follow stored staff roles when the flag is on, in the handler and in their library checks', async () => {
  const on = { EGC_STAFF_ROLE_PERMISSIONS: 'true' }, off = {};
  // A configured manager whose stored roles were lowered to crew. Each request gets its own session object.
  const lowered = () => ({ user: 'TylerG', displayName: 'Synthetic Manager', role: 'manager', businessAccess: true, staffRoles: ['crew'] });
  // A permitted request is sent with an invalid query or body, so it stops at validation (400) and never reads storage.
  const untouched = () => new Proxy({}, { get(target, key) { if (key === 'then') return undefined; throw new Error(`storage was read: ${String(key)}`); } });
  const deps = { session: async () => lowered(), storage: untouched, now: () => NOW };
  const url = path => `${ORIGIN}${path}`, headers = { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin' };
  const cases = [
    ['message sends', messageSendHandlers(deps).get, new Request(url('/api/message-sends?x=1'), { headers }), 'messaging_invalid_query'],
    ['stripe reviews', stripeReviewHandlers(deps).get, new Request(url('/api/stripe-reviews?x=1'), { headers }), 'stripe_review_invalid_query'],
    ['garage guard overview', garageGuardMemberHandlers(deps).get, new Request(url('/api/garage-guard-members?bad=1'), { headers }), 'garage_guard_invalid_query'],
    ['garage guard action (library check)', garageGuardMemberHandlers(deps).post, () => new Request(url('/api/garage-guard-members'), { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'not_an_action' }) }), 'garage_guard_action_invalid'],
    ['funnel dimensions', funnelDimensionsHandlers(deps).get, new Request(url('/api/funnel-dimensions?a=1&a=2'), { headers }), 'funnel_dimensions_query_invalid'],
    ['customer lifecycle', customerLifecycleHandlers(deps).get, new Request(url('/api/customer-lifecycle'), { headers }), 'lifecycle_query_invalid'],
    ['money', moneyHandlers(deps).get, new Request(url('/api/money?bogus=1'), { headers }), 'money_query_invalid'],
    ['job labor costs', jobLaborCostsHandlers(deps).get, new Request(url('/api/job-labor-costs?x=1'), { headers }), 'job_labor_query_invalid'],
  ];
  for (const [name, handle, request, invalid] of cases) {
    const fresh = () => typeof request === 'function' ? request() : request.clone();
    const refused = await handle({ request: fresh(), env: on }), allowed = await handle({ request: fresh(), env: off });
    assert.equal(refused.status, 403, `${name}: stored roles refuse with the flag on`);
    assert.match((await refused.json()).code, /forbidden/, name);
    assert.deepEqual([allowed.status, (await allowed.json()).code], [400, invalid], `${name}: the older owner-or-manager check still allows with the flag off`);
  }
  // PTO decisions are made in the library (mutatePto), after the handler records the env answer.
  const vault = () => ({ readOnly: false, read: async () => null, list: async () => [] });
  const roster = () => ({ roster: async () => [{ id: 'tylerg', name: 'Synthetic Manager', role: 'manager' }] });
  const pto = employeePtoHandlers({ ...deps, storage: roster, vault });
  const approve = () => new Request(url('/api/employee-pto'), { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve', requestId: '00000000-0000-4000-8000-000000000071', id: 'pto_synthetic' }) });
  const denied = await pto.post({ request: approve(), env: on });
  assert.deepEqual([denied.status, (await denied.json()).code], [403, 'pto_forbidden'], 'the library does not fall back to the older check');
  const passed = await pto.post({ request: approve(), env: off });
  assert.deepEqual([passed.status, (await passed.json()).code], [404, 'pto_not_found'], 'with the flag off the manager reaches the request lookup, as before');
  // The remembered answer is the handler's, a denial included.
  const session = lowered();
  assert.equal(canDispatch(session), true, 'with no env check yet, the older check answers');
  assert.equal(canDispatch(session, on), false);
  assert.equal(canDispatch(session), false, 'a denial under env is what the library calls of that request see');
  assert.throws(() => requireDispatcher(session), error => error.code === 'dispatch_forbidden');
});

test('the configured owner keeps the owner role when stored roles name no management role, so turning stored roles on never locks the owner out', async t => {
  vaultFirestore(t);
  const settingsStore = () => ({ read: async () => null });
  for (const staffRoles of [['crew_lead'], []]) {
    const env = staffEnv({}, { ZacB: { passwordHash: 'unused', role: 'owner', displayName: 'Synthetic Owner', payType: 'owner', staffRoles } }), on = { ...env, EGC_STAFF_ROLE_PERMISSIONS: 'true' };
    const owner = { user: 'ZacB', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner', staffRoles };
    // The stored roles are shown as stored; only can() (the flag-on capability path) acts as the owner.
    assert.deepEqual(sanitizeStaffRoles(staffRoles, owner), staffRoles, JSON.stringify(staffRoles));
    for (const capability of STAFF_CAPABILITIES) assert.equal(can(owner, capability, on), true, `${capability} ${JSON.stringify(staffRoles)}`);
    const cookie = await cookieFor(env, 'ZacB');
    for (const flags of [env, on]) {
      assert.equal((await dispatchHandlers({ storage: memoryStore, now: () => NOW }).get({ request: get(cookie, flags), env: flags })).status, 200, `dispatch ${JSON.stringify(staffRoles)}`);
      assert.equal((await dispatchSettingsHandlers({ storage: settingsStore, now: () => NOW }).get({ request: get(cookie, flags, '/api/dispatch-settings'), env: flags })).status, 200, `dispatch rules screen ${JSON.stringify(staffRoles)}`);
    }
    // F19: the roster shows the stored roles as stored (a stored crew_lead keeps the owner on the field roster),
    // whatever the roles flag says; the owner's dispatch and settings access above come from can() alone.
    const zacb = (await dispatchRoster({ ...on, EGC_STAFF_DIRECTORY_ENABLED: 'true' })).find(person => person.id === 'zacb');
    assert.deepEqual([zacb.role, zacb.staffRoles, zacb.fieldWork], [staffRoles.length ? 'crew_lead' : 'crew', staffRoles, undefined]);
  }
  // An explicit ['manager'] is honored: the owner then acts as a manager (PAY-TIMESHEETS keeps pay owner-only for it).
  const asManager = { user: 'ZacB', role: 'owner', businessAccess: true, staffRoles: ['manager'] }, on = { EGC_STAFF_ROLE_PERMISSIONS: 'true' };
  assert.deepEqual(sanitizeStaffRoles(asManager.staffRoles, asManager), ['manager']);
  assert.deepEqual([can(asManager, 'dispatch.write', on), can(asManager, 'settings.manage', on)], [true, false]);
  // Nobody else gains the owner role from stored roles.
  const impostor = { user: 'TylerG', role: 'manager', businessAccess: true, staffRoles: ['owner'] };
  assert.deepEqual(sanitizeStaffRoles(impostor.staffRoles, impostor), []);
  assert.equal(can(impostor, 'settings.manage', { EGC_STAFF_ROLE_PERMISSIONS: 'true' }), false);
});

// Flag-off byte identity: the owner's stored staffRoles reach the dispatch roster (and the staff directory,
// which reads the same sanitizeStaffRoles) exactly as before DISPATCH-RULES, with the staff directory off and
// on. These rows are the integration branch's output before this unit (eadc88f); the roster never reads the
// roles flag, so turning EGC_STAFF_ROLE_PERMISSIONS on changes nothing here either.
test('with stored roles off, the owner\'s dispatch roster row is unchanged for stored crew_lead, [] and sales roles', async t => {
  vaultFirestore(t);
  const expected = {
    '["crew_lead"]': { id: 'zacb', name: 'Synthetic Owner', role: 'crew_lead' },
    '[]': { id: 'zacb', name: 'Synthetic Owner', role: 'crew' },
    '["sales"]': { id: 'zacb', name: 'Synthetic Owner', role: 'sales' },
  };
  for (const staffRoles of [['crew_lead'], [], ['sales']]) {
    const owner = { user: 'ZacB', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner', staffRoles };
    assert.deepEqual(sanitizeStaffRoles(staffRoles, owner), staffRoles);
    for (const directory of [false, true]) {
      const env = staffEnv(directory ? { EGC_STAFF_DIRECTORY_ENABLED: 'true' } : {}, { ZacB: { passwordHash: 'unused', role: 'owner', displayName: 'Synthetic Owner', payType: 'owner', staffRoles } });
      const roster = await dispatchRoster(env), row = roster.find(person => person.id === 'zacb');
      const want = directory ? { ...expected[JSON.stringify(staffRoles)], staffRoles, skills: [], weeklyAvailability: null } : expected[JSON.stringify(staffRoles)];
      assert.equal(JSON.stringify(row), JSON.stringify(want), `${JSON.stringify(staffRoles)} directory ${directory}`);
      assert.equal(JSON.stringify(await dispatchRoster({ ...env, EGC_STAFF_ROLE_PERMISSIONS: 'true' })), JSON.stringify(roster), 'the roster does not read the roles flag');
      assert.equal(JSON.stringify(await dispatchRoster({ ...env, EGC_STAFF_ROLE_PERMISSIONS: 'false' })), JSON.stringify(roster));
    }
    // Flag off: capabilities are today's hard-coded checks. Flag on: the configured owner is never locked out.
    for (const capability of STAFF_CAPABILITIES) {
      assert.equal(can(owner, capability, {}), true, `${capability} off`);
      assert.equal(can(owner, capability, { EGC_STAFF_ROLE_PERMISSIONS: 'true' }), true, `${capability} on`);
    }
  }
});

test('the time-off list follows stored staff roles with the flag on: a lowered manager sees only their own requests, a stored-role manager sees everyone\'s', async () => {
  const on = { EGC_STAFF_ROLE_PERMISSIONS: 'true' }, off = {};
  const records = [{ id: 'pto_a', type: 'time_off', employee: 'tylerg', status: 'pending', startDate: '2026-10-01', endDate: '2026-10-02', createdAt: '2026-09-20T00:00:00.000Z' }, { id: 'pto_b', type: 'time_off', employee: 'crew.one', status: 'pending', startDate: '2026-10-03', endDate: '2026-10-04', createdAt: '2026-09-21T00:00:00.000Z' }];
  const vault = () => ({ readOnly: false, read: async () => null, list: async () => structuredClone(records) });
  const storage = () => ({ roster: async () => [{ id: 'tylerg', name: 'Synthetic Manager', role: 'manager' }, { id: 'mgr.account', name: 'Synthetic Stored Manager', role: 'manager' }, { id: 'crew.one', name: 'Crew One', role: 'crew' }] });
  const view = async (session, env) => { const body = await (await employeePtoHandlers({ session: async () => session(), storage, vault, now: () => NOW }).get({ request: new Request(`${ORIGIN}/api/employee-pto`), env })).json(); return [body.employee, body.requests.map(row => row.id).sort()]; };
  const lowered = () => ({ user: 'TylerG', displayName: 'Synthetic Manager', role: 'manager', businessAccess: true, staffRoles: ['crew'] });
  const stored = () => ({ user: 'Mgr.Account', displayName: 'Synthetic Stored Manager', role: 'crew', businessAccess: false, source: 'employee-account', staffRoles: ['manager'] });
  assert.deepEqual(await view(lowered, off), [null, ['pto_a', 'pto_b']], 'flag off: business access shows everyone, as before');
  assert.deepEqual(await view(lowered, on), ['tylerg', ['pto_a']], 'flag on: stored crew roles show only their own requests');
  assert.deepEqual(await view(stored, off), ['mgr.account', []], 'flag off: an employee account sees only its own requests');
  assert.deepEqual(await view(stored, on), [null, ['pto_a', 'pto_b']], 'flag on: the stored manager who may approve also sees what to approve');
  // A configured manager without stored roles keeps today's view with the flag on.
  assert.deepEqual(await view(() => ({ user: 'TylerG', displayName: 'Synthetic Manager', role: 'manager', businessAccess: true }), on), [null, ['pto_a', 'pto_b']]);
});
