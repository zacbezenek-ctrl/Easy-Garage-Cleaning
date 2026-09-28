import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { OWNER_CAPABILITIES, ROLE_CAPABILITIES, STAFF_CAPABILITIES, STAFF_ROLES, can, capabilityMode, defaultStaffRoles, primaryStaffRole, sanitizeStaffRoles, staffCapabilities } from '../functions/_lib/staff-roles.js';
import { getHubUserProfile, hasBusinessAccess, isHubOwner, listHubUserProfiles, authenticateHubCredential, getHubSession } from '../functions/_lib/hub-session.js';
import { requireDispatcher } from '../functions/_lib/dispatch-service.js';
import { employeeInvitationStore } from '../functions/_lib/employee-accounts.js';
import { decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { onRequestGet as firebaseSession } from '../functions/api/firebase-session.js';
import * as hubAuth from '../functions/api/hub-auth.js';
import { staffRolesHandlers } from '../functions/api/staff-roles.js';
import { staffDirectoryHandlers } from '../functions/api/staff-directory.js';
import { vaultFirestore, staffEnv, cookieFor, seedAccount, login, jsonRequest, PASSWORD } from './helpers/vault-fixture.mjs';

const MANAGER = ['dispatch.write', 'time.approve', 'customer.send', 'followups.own', 'quotes.author', 'mcp.write', 'b2b.manage'];
const dispatcher = session => { try { requireDispatcher(session); return true; } catch { return false; } };
// Today's hard-coded checks, independent of staff-roles.js.
const legacy = (session, capability) => OWNER_CAPABILITIES.includes(capability) ? isHubOwner(session) : capability === 'dispatch.write' ? dispatcher(session) : hasBusinessAccess(session);

test('capability matrix: roles map only to known capabilities and owner-only capabilities stay with the owner role', () => {
  assert.deepEqual(STAFF_ROLES, ['owner', 'manager', 'crew_lead', 'crew', 'sales', 'phone']);
  assert.deepEqual(OWNER_CAPABILITIES, ['pay.manage', 'accounts.approve', 'money.refund', 'money.charge_stored_card', 'catalog.manage', 'settings.manage']);
  assert.deepEqual(Object.keys(ROLE_CAPABILITIES), STAFF_ROLES);
  assert.deepEqual(ROLE_CAPABILITIES, {
    owner: STAFF_CAPABILITIES, manager: MANAGER, crew_lead: [], crew: [],
    sales: ['customer.send', 'followups.own', 'quotes.author'], phone: ['customer.send', 'followups.own'],
  });
  for (const [role, capabilities] of Object.entries(ROLE_CAPABILITIES)) {
    assert.ok(capabilities.every(capability => STAFF_CAPABILITIES.includes(capability)), role);
    if (role !== 'owner') assert.ok(capabilities.every(capability => !OWNER_CAPABILITIES.includes(capability)), `${role} never carries an owner capability`);
    assert.throws(() => { capabilities.push('settings.manage'); }, TypeError, 'the matrix is frozen');
  }
});

async function realSessions(t, env) {
  vaultFirestore(t);
  await seedAccount(env, 'Crew.Account');
  await seedAccount(env, 'Sales.Account', { sales: true });
  await seedAccount(env, 'Forged.Sales', { extra: { role: 'sales' } });
  const employees = await Promise.all(['Crew.Account', 'Sales.Account', 'Forged.Sales'].map(user => authenticateHubCredential(env, user, PASSWORD)));
  return [...listHubUserProfiles(env), ...employees];
}

test('with EGC_STAFF_ROLE_PERMISSIONS off, can() reproduces today\'s access for configured users and employee accounts exactly', async t => {
  const env = staffEnv(), sessions = await realSessions(t, env);
  assert.deepEqual(sessions.map(session => session.user), ['ZacB', 'TylerG', 'AlexK', 'Crew.Static', 'Crew.Account', 'Sales.Account', 'Forged.Sales']);
  assert.equal(sessions.find(session => session.user === 'Sales.Account').role, 'sales');
  for (const flags of [{}, { EGC_STAFF_ROLE_PERMISSIONS: 'false' }, { EGC_STAFF_ROLE_PERMISSIONS: 'TRUE' }, { EGC_STAFF_ROLE_PERMISSIONS: 'true' }]) {
    // With the flag on, sessions without stored staffRoles keep the same defaults.
    for (const session of sessions) {
      for (const capability of STAFF_CAPABILITIES) assert.equal(can(session, capability, { ...env, ...flags }), legacy(session, capability), `${session.user} ${capability} ${JSON.stringify(flags)}`);
      assert.equal(capabilityMode(session, { ...env, ...flags }), 'legacy');
    }
  }
  const caps = Object.fromEntries(sessions.map(session => [session.user, staffCapabilities(session, env)]));
  assert.deepEqual(caps.ZacB, [...STAFF_CAPABILITIES]);
  assert.deepEqual(caps.TylerG, MANAGER);
  assert.deepEqual(caps.AlexK, MANAGER.filter(capability => capability !== 'dispatch.write'), 'business access without a dispatcher role');
  for (const user of ['Crew.Static', 'Crew.Account', 'Sales.Account', 'Forged.Sales']) assert.deepEqual(caps[user], [], user);
  assert.equal(can(sessions[0], 'time.approve'), true, 'env defaults to legacy');
});

test('stored staff roles apply only with the flag on and never grant owner capabilities to anyone but the owner', () => {
  const on = { EGC_STAFF_ROLE_PERMISSIONS: 'true' };
  const employee = staffRoles => ({ user: 'Crew.Account', displayName: 'Crew', role: 'crew', businessAccess: false, source: 'employee-account', staffRoles });
  assert.equal(can(employee(['manager']), 'dispatch.write', {}), false);
  assert.equal(can(employee(['manager']), 'dispatch.write', on), true);
  assert.deepEqual(staffCapabilities(employee(['manager']), on), MANAGER);
  assert.deepEqual(staffCapabilities(employee(['owner', 'manager']), on), MANAGER, 'owner is stripped from a non-owner');
  assert.deepEqual(staffCapabilities(employee(['owner']), on), []);
  assert.deepEqual(staffCapabilities(employee(['sales']), on), ['customer.send', 'followups.own', 'quotes.author']);
  assert.deepEqual(staffCapabilities(employee(['phone', 'crew']), on), ['customer.send', 'followups.own']);
  assert.deepEqual(staffCapabilities(employee(['crew_lead', 'unknown', 7]), on), []);
  assert.equal(capabilityMode(employee(['sales']), on), 'staff_roles');
  const env = staffEnv(on, { TylerG: { passwordHash: 'unused', role: 'manager', displayName: 'Manager', staffRoles: ['crew'] }, ZacB: { passwordHash: 'unused', role: 'owner', staffRoles: ['owner'] } });
  const owner = getHubUserProfile(env, 'ZacB'), manager = getHubUserProfile(env, 'TylerG');
  assert.deepEqual(manager.staffRoles, ['crew']);
  assert.deepEqual(staffCapabilities(manager, env), [], 'configured roles are authoritative with the flag on');
  assert.deepEqual(staffCapabilities(manager, staffEnv({}, { TylerG: { passwordHash: 'unused', role: 'manager', staffRoles: ['crew'] } })), MANAGER, 'ignored with the flag off');
  assert.deepEqual(staffCapabilities(owner, env), [...STAFF_CAPABILITIES]);
  const impostor = { ...manager, staffRoles: ['owner'] };
  for (const capability of OWNER_CAPABILITIES) assert.equal(can(impostor, capability, env), false);
});

test('can() fails closed on unknown capabilities, bare usernames and malformed sessions', () => {
  assert.throws(() => can({ user: 'ZacB', businessAccess: true }, 'dispatch.delete'), TypeError);
  for (const session of ['zacb', 'ZacB', null, undefined, [], { user: '' }, { user: '  ' }, { businessAccess: true }]) {
    for (const capability of STAFF_CAPABILITIES) assert.equal(can(session, capability, { EGC_STAFF_ROLE_PERMISSIONS: 'true' }), false);
  }
  assert.equal(can({ user: 'zacb', businessAccess: false, role: 'owner' }, 'pay.manage'), false, 'business access is required');
  assert.deepEqual(sanitizeStaffRoles(['phone', 'sales', 'phone', 'owner', 'x'], { user: 'Crew' }), ['sales', 'phone']);
  assert.equal(sanitizeStaffRoles(undefined), null);
  assert.deepEqual(defaultStaffRoles({ user: 'ZacB', businessAccess: true, role: 'owner' }), ['owner']);
  assert.deepEqual(defaultStaffRoles({ user: 'TylerG', businessAccess: true, role: 'manager' }), ['manager']);
  assert.deepEqual(defaultStaffRoles({ user: 'Imposter', businessAccess: true, role: 'manager' }), ['crew']);
  assert.deepEqual(defaultStaffRoles({ role: 'sales' }), ['sales']);
  assert.equal(primaryStaffRole(['crew', 'phone', 'sales']), 'sales');
  assert.equal(primaryStaffRole([]), 'crew');
});

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = JSON.stringify({ type: 'service_account', project_id: 'egcw-1ec83', client_email: 'synthetic-claims@egcw-1ec83.iam.gserviceaccount.com', private_key: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }) });
async function claims(env, user) {
  const response = await firebaseSession({ env, request: new Request('https://easygaragecleaning.com/api/firebase-session', { headers: { Cookie: await cookieFor(env, user) } }) });
  assert.equal(response.status, 200);
  return JSON.parse(Buffer.from((await response.json()).token.split('.')[1], 'base64url')).claims;
}

test('Firebase custom-token claims are unchanged with the flag off and gain caps only with it on', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('configured users need no roster lookup'); });
  const env = staffEnv({ FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccount });
  assert.deepEqual(await claims(env, 'ZacB'), { role: 'owner', business_access: true, username: 'ZacB', display_name: 'Synthetic Owner', assignment_identities: ['ZacB'], assignment_keys: ['zacb'], assignment_version: 1 });
  assert.deepEqual(Object.keys(await claims(env, 'Crew.Static')).sort(), ['assignment_identities', 'assignment_keys', 'assignment_version', 'business_access', 'display_name', 'role', 'username']);
  const on = { ...env, EGC_STAFF_ROLE_PERMISSIONS: 'true' };
  assert.deepEqual(await claims(on, 'ZacB'), { role: 'owner', business_access: true, username: 'ZacB', display_name: 'Synthetic Owner', assignment_identities: ['ZacB'], assignment_keys: ['zacb'], assignment_version: 1, caps: [...STAFF_CAPABILITIES], caps_v: 1 });
  const manager = await claims(on, 'TylerG');
  assert.deepEqual(manager.caps, MANAGER); assert.equal(manager.caps_v, 1);
  const crew = await claims(on, 'Crew.Static');
  assert.deepEqual(crew.caps, []); assert.equal(crew.caps_v, 1);
});

test('/api/hub-auth and /api/staff-roles report the capabilities the server enforces', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('no storage needed'); });
  const env = staffEnv();
  for (const [user, expected] of [['ZacB', [...STAFF_CAPABILITIES]], ['TylerG', MANAGER], ['Crew.Static', []]]) {
    const cookie = await cookieFor(env, user);
    const body = await (await hubAuth.onRequestGet({ env, request: new Request('https://easygaragecleaning.com/api/hub-auth', { headers: { Cookie: cookie } }) })).json();
    assert.equal(body.user, user); assert.deepEqual(body.capabilities, expected);
    const roles = await (await staffRolesHandlers().get({ env, request: new Request('https://easygaragecleaning.com/api/staff-roles', { headers: { Cookie: cookie } }) })).json();
    assert.deepEqual(roles.viewer.capabilities, expected); assert.equal(roles.viewer.mode, 'legacy'); assert.deepEqual(roles.matrix, ROLE_CAPABILITIES);
  }
  assert.equal((await staffRolesHandlers().get({ env, request: new Request('https://easygaragecleaning.com/api/staff-roles') })).status, 401);
});

function browser(fetcher) {
  const store = () => { const map = new Map(); return { getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key), map }; };
  const context = { sessionStorage: store(), localStorage: store(), fetch: fetcher, console,
    document: { readyState: 'loading', querySelector: () => null, getElementById: () => null, createElement: () => ({}) },
    location: { pathname: '/crew/' }, firebase: { auth: () => ({ signInWithCustomToken: async () => {}, signOut: async () => {} }) },
    addEventListener() {}, dispatchEvent() {}, Event: class {}, Error, Promise, JSON, Number, String, Array, Math };
  context.window = context;
  vm.runInNewContext(readFileSync(new URL('../crew/hub-auth.js', import.meta.url), 'utf8'), context);
  return context;
}

test('the crew sign-in client keeps server capabilities for display and clears them on sign-out', async () => {
  const response = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const context = browser(async url => response(String(url).includes('firebase-session') ? { ok: true, token: 'synthetic-token' } : { ok: true, user: 'TylerG', displayName: 'Manager', role: 'manager', businessAccess: true, capabilities: ['dispatch.write', 'time.approve', 7] }));
  assert.equal(await context.EGCHubAuth.session(), 'TylerG');
  assert.deepEqual([...context.EGCHubAuth.profile().capabilities], ['dispatch.write', 'time.approve']);
  assert.equal(context.EGCHubAuth.can('dispatch.write'), true);
  assert.equal(context.EGCHubAuth.can('pay.manage'), false);
  await context.EGCHubAuth.signOut();
  assert.equal(context.EGCHubAuth.can('dispatch.write'), false);
  assert.equal(context.sessionStorage.getItem('egc_capabilities'), null);
  context.sessionStorage.setItem('egc_u', 'x'); context.sessionStorage.setItem('egc_capabilities', '{not json');
  assert.deepEqual([...context.EGCHubAuth.profile().capabilities], []);
});

test('only the owner changes roles; a change revokes the employee session, keeps unknown account fields and new sessions carry the roles', async t => {
  const env = staffEnv({ EGC_STAFF_DIRECTORY_ENABLED: 'true' }), fire = vaultFirestore(t);
  await seedAccount(env, 'Phone.Person', { extra: { futureAccountField: { keep: true } } });
  const before = await employeeInvitationStore(env).read('Phone.Person');
  const { cookie, profile } = await login(env, 'Phone.Person');
  assert.deepEqual(profile.capabilities, []); assert.equal(profile.staffRoles, undefined);
  assert.ok(await getHubSession(new Request('https://easygaragecleaning.com/', { headers: { Cookie: cookie } }), env));
  const handlers = staffDirectoryHandlers({ now: () => new Date('2026-09-22T18:00:00.000Z') });
  const change = (actorCookie, staffRoles, extra = {}) => handlers.post({ env, request: jsonRequest('/api/staff-directory', { action: 'set_roles', requestId: crypto.randomUUID(), username: 'Phone.Person', expectedRevision: '', staffRoles, ...extra }, actorCookie) });
  for (const actor of ['TylerG', 'AlexK', 'Crew.Static']) {
    const denied = await change(await cookieFor(env, actor), ['phone']);
    assert.equal(denied.status, 403, actor); assert.equal((await denied.json()).code, 'staff_directory_forbidden');
  }
  assert.equal((await change(cookie, ['phone'])).status, 403, 'an employee cannot change their own roles');
  const owner = await cookieFor(env, 'ZacB');
  assert.equal((await change(owner, ['owner'])).status, 403);
  assert.equal((await change(owner, ['phone', 'wizard'])).status, 400);
  assert.equal(fire.commits.length, 0);
  const saved = await change(owner, ['phone', 'crew'], { reason: 'Synthetic phone coverage' });
  const body = await saved.json();
  assert.equal(saved.status, 200, JSON.stringify(body));
  assert.equal(body.sessionsRevoked, true); assert.deepEqual(body.person.staffRoles, ['crew', 'phone']); assert.equal(body.person.staffRolesSource, 'account');
  assert.equal(fire.commits.length, 1);
  assert.deepEqual(fire.commits[0].map(write => write.update.name.split('/documents/')[1].split('/')[0]), ['jobs', 'jobs', 'staffDirectoryOperations', 'hub_audit'], 'profile, account, receipt and audit entry commit together');
  const audit = decodeFirestoreFields(fire.commits[0][3].update.fields);
  assert.deepEqual([audit.action, audit.visibility, audit.reason, audit.actor.id, audit.entity.id], ['staff_directory.set_roles', 'business', 'Synthetic phone coverage', 'zacb', 'phone.person']);
  assert.deepEqual([JSON.parse(audit.before), JSON.parse(audit.after), audit.changedKeys], [{ staffRoles: ['crew'] }, { staffRoles: ['crew', 'phone'] }, ['staffRoles']]);
  assert.equal(await getHubSession(new Request('https://easygaragecleaning.com/', { headers: { Cookie: cookie } }), env), null, 'the old session is revoked');
  const after = await employeeInvitationStore(env).read('Phone.Person');
  assert.deepEqual(after.account.futureAccountField, { keep: true });
  assert.deepEqual(after.account.staffRoles, ['crew', 'phone']);
  assert.notEqual(after.account.sessionVersion, before.account.sessionVersion);
  for (const field of ['passwordHash', 'passwordSalt', 'status', 'email', 'role', 'hourlyRate', 'appliedAt']) assert.deepEqual(after.account[field], before.account[field], field);
  assert.equal(after.account.rolesUpdatedBy, 'ZacB'); assert.equal(after.account.rolesUpdatedAt, '2026-09-22T18:00:00.000Z');
  const fresh = await login(env, 'Phone.Person');
  assert.deepEqual(fresh.profile.staffRoles, ['crew', 'phone']);
  assert.deepEqual(fresh.profile.capabilities, [], 'stored roles are inert until the flag is on');
  const enabled = await login({ ...env, EGC_STAFF_ROLE_PERMISSIONS: 'true' }, 'Phone.Person');
  assert.deepEqual(enabled.profile.capabilities, ['customer.send', 'followups.own']);
  assert.equal(enabled.profile.role, 'crew', 'the legacy session role is unchanged');
});
