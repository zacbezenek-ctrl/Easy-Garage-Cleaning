import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ORIGIN, PASSWORD, cookieFor, jsonRequest, login, seedAccount, staffEnv, vaultFirestore } from './helpers/vault-fixture.mjs';
import { employeeAccountsHandlers } from '../functions/api/employee-accounts.js';
import { staffDirectoryHandlers } from '../functions/api/staff-directory.js';
import { staffDirectoryStorage } from '../functions/_lib/staff-directory-storage.js';
import { denverToday } from '../functions/_lib/dispatch-time.js';
import { readTimesheetRecords, timesheetHandlers } from '../functions/api/timesheets.js';
import { handleStaffSetup } from '../functions/api/staff-setup.js';
import { onRequestPost as hubAuthPost } from '../functions/api/hub-auth.js';
import { onRequestGet as employeeHubGet } from '../functions/api/employee-hub.js';
import { STAFF_RESET_HOURS, createStaffInvitationService, parseStaffResetInvite, staffResetInvite } from '../functions/_lib/staff-invitation-service.js';
import { staffResetStore } from '../functions/_lib/staff-access.js';
import { authenticateEmployeeAccount, employeeInvitationStore } from '../functions/_lib/employee-accounts.js';
import { getHubSession, listHubUserProfiles } from '../functions/_lib/hub-session.js';
import { ROLE_CAPABILITIES, STAFF_CAPABILITIES, can, capabilityMatrix, capabilityNames, managerGrants, staffCapabilities } from '../functions/_lib/staff-roles.js';
import { createFirebaseRevocationService } from '../functions/_lib/firebase-revocation.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { opaqueId, open, readCollectionRecords, writeOne } from '../functions/_lib/employee-vault.js';
import { decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { recordPayrollWeekExport } from '../functions/_lib/payroll-week-exports.js';
import { VAULT_MIGRATIONS } from '../functions/_lib/employee-vault-migrate.js';

// Every business decision here runs on an injected clock (the Denver date, the reset link's 24 hours, audit times).
// Hub session cookies are minted and checked by the real session code, which reads the process clock for their
// 12-hour lifetime only; the suite also passes with that clock shifted (tests/helpers/shift-clock.mjs).
const START = Date.parse('2026-09-24T15:00:00.000Z');
const ON = { EGC_STAFF_PASSWORD_RESET: 'true' };
const people = Object.fromEntries(listHubUserProfiles(staffEnv()).map(profile => [profile.user, profile]));
const NEW_PASSWORD = 'Fresh-Synthetic-Pass-2026';

// The real Firebase revocation service on the emulated Firestore, with Identity Toolkit replaced by a recorder.
function firebase(mode = 'ok') {
  const calls = [];
  const revocations = env => createFirebaseRevocationService({ store: dispatchStorage(env), revoke: async (uid, validSince) => {
    calls.push({ uid, validSince });
    if (mode === 'denied') throw Object.assign(new Error('synthetic denied'), { code: 'firebase_revocation_permission_denied' });
    return 'revoked';
  } });
  return { calls, revocations };
}
function harness(t, extra = {}) {
  const fire = vaultFirestore(t), env = staffEnv({ ...ON, ...extra });
  let clock = START;
  const fb = firebase(extra.__firebase), now = () => new Date(clock);
  const accounts = employeeAccountsHandlers({ now, revocations: fb.revocations });
  const directory = staffDirectoryHandlers({ now, revocations: fb.revocations });
  const setupService = () => createStaffInvitationService({ store: employeeInvitationStore(env), manifests: [], now: () => clock, resets: staffResetStore(env) });
  return { fire, env, fb, now, accounts, directory, setupService, advance: ms => { clock += ms; }, at: iso => { clock = Date.parse(iso); } };
}
const post = async (handler, env, path, body, cookie, headers) => {
  const response = await handler.post({ env, request: jsonRequest(path, body, cookie, headers) });
  return { status: response.status, headers: response.headers, body: await response.json() };
};
const get = async (handler, env, path, cookie) => {
  const response = await handler.get({ env, request: jsonRequest(path, undefined, cookie) });
  return { status: response.status, body: await response.json() };
};
const setupRequest = body => new Request(`${ORIGIN}/api/staff-setup`, { method: 'POST', headers: { Origin: ORIGIN, 'X-EGC-Staff-Setup': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const setup = async (service, body) => { const response = await handleStaffSetup(setupRequest(body), service); return { status: response.status, body: await response.json() }; };
const sessionOf = (env, cookie) => getHubSession(new Request(`${ORIGIN}/api/hub-auth`, { headers: { Cookie: cookie } }), env);
const signIn = async (env, username, password) => {
  const response = await hubAuthPost({ env, request: new Request(`${ORIGIN}/api/hub-auth`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) }) });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
};
const audits = fire => [...fire.documents].filter(([key]) => key.startsWith('hub_audit/')).map(([, doc]) => decodeFirestoreFields(doc.fields));
const receipts = fire => [...fire.documents].filter(([key]) => key.startsWith('staffAccessOperations/')).map(([, doc]) => decodeFirestoreFields(doc.fields));
const accountOf = async (env, username) => (await employeeInvitationStore(env).read(username))?.account;
const sealed = async (env, fire, collection, id) => {
  const documentId = await opaqueId(env, collection, id), doc = fire.documents.get(`jobs/${documentId}`);
  return doc ? open(env, documentId, doc.fields.sealedIv.stringValue, doc.fields.sealedPayload.stringValue) : null;
};
const reset = (username, extra = {}) => ({ action: 'reset_signin', requestId: randomUUID(), username, ...extra });
const inviteOf = link => decodeURIComponent(link.split('#invite=')[1]);

test('capabilities: accounts.reset and password.change exist only with the flag; the owner grants managers reset and approve, never pay', () => {
  const env = staffEnv(), crew = { user: 'Crew.One', displayName: 'Synthetic Crew', role: 'crew', businessAccess: false, source: 'employee-account' };
  const grants = { EGC_STAFF_MANAGER_GRANTS: 'accounts.reset,accounts.approve,pay.manage' };
  for (const flags of [{}, grants, { EGC_STAFF_PASSWORD_RESET: 'false', ...grants }, { EGC_STAFF_PASSWORD_RESET: 'TRUE', ...grants }]) {
    const off = { ...env, ...flags };
    assert.deepEqual(capabilityNames(off), STAFF_CAPABILITIES); assert.deepEqual(capabilityMatrix(off), ROLE_CAPABILITIES); assert.deepEqual(managerGrants(off), []);
    for (const session of [people.ZacB, people.TylerG, crew]) {
      assert.equal(can(session, 'accounts.reset', off), false); assert.equal(can(session, 'password.change', off), false);
      assert.deepEqual(staffCapabilities(session, off), staffCapabilities(session, env), `${session.user} ${JSON.stringify(flags)}`);
    }
    assert.equal(can(people.TylerG, 'accounts.approve', off), false, 'flag off: approval stays the owner\'s');
  }
  const on = { ...env, ...ON };
  assert.deepEqual(capabilityNames(on), [...STAFF_CAPABILITIES, 'accounts.reset', 'password.change']);
  assert.equal(can(people.ZacB, 'accounts.reset', on), true); assert.equal(can(people.ZacB, 'accounts.approve', on), true);
  assert.equal(can(people.TylerG, 'accounts.reset', on), false, 'managers need the owner\'s grant');
  assert.equal(can(people.TylerG, 'accounts.approve', on), false);
  assert.equal(can(crew, 'password.change', on), true); assert.equal(can(people.ZacB, 'password.change', on), false, 'configured users keep the Hub configuration');
  const granted = { ...on, ...grants };
  assert.deepEqual(managerGrants(granted), ['accounts.reset', 'accounts.approve'], 'pay.manage is never grantable');
  assert.equal(can(people.TylerG, 'accounts.reset', granted), true); assert.equal(can(people.TylerG, 'accounts.approve', granted), true);
  assert.equal(can(people.TylerG, 'pay.manage', granted), false);
  for (const user of ['AlexK', 'Crew.Static']) for (const capability of ['accounts.reset', 'accounts.approve', 'pay.manage']) assert.equal(can(people[user], capability, granted), false, `${user} ${capability}`);
  assert.equal(can(crew, 'accounts.reset', granted), false);
  assert.deepEqual(capabilityMatrix(granted).manager.slice(-2), ['accounts.reset', 'accounts.approve']);
  assert.ok(capabilityMatrix(granted).owner.includes('accounts.reset'));
  // With stored staff roles the grant follows the manager role, not a name.
  const roles = { ...granted, EGC_STAFF_ROLE_PERMISSIONS: 'true' };
  assert.equal(can({ ...people.TylerG, staffRoles: ['crew_lead'] }, 'accounts.reset', roles), false);
  assert.equal(can({ ...people.TylerG, staffRoles: ['manager'] }, 'accounts.reset', roles), true);
});

test('reset link: single use, 24 hours on the injected clock, ends Hub and Firebase sessions, locks the old password, is audited and sent nowhere', async t => {
  const h = harness(t);
  await seedAccount(h.env, 'Crew.Reset');
  const first = await login(h.env, 'Crew.Reset'), second = await login(h.env, 'Crew.Reset');
  assert.ok(await sessionOf(h.env, first.cookie)); assert.ok(await sessionOf(h.env, second.cookie));
  const owner = await cookieFor(h.env, 'ZacB'), before = h.fire.requests.length;
  const issued = await post(h.accounts, h.env, '/api/employee-accounts', reset('Crew.Reset', { reason: 'Synthetic forgotten password' }), owner);
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  assert.match(issued.body.link, /^https:\/\/easygaragecleaning\.com\/staff-setup#invite=reset-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.body.expiresAt, new Date(START + STAFF_RESET_HOURS * 3600000).toISOString());
  assert.deepEqual([issued.body.sent, issued.body.linkShown, issued.body.sessionsRevoked, issued.body.firebaseRevocation.status], [false, true, true, 'revoked']);
  // Nothing left the Hub: every request after the reset went to Firestore (the fixture refuses any other host).
  assert.ok(h.fire.requests.slice(before).every(request => request.url.hostname === 'firestore.googleapis.com'));
  assert.deepEqual(h.fb.calls.map(call => call.uid), ['hub:crew.reset']);
  assert.equal(h.fb.calls[0].validSince, Math.floor(START / 1000) + 1, 'Firebase sessions from before the reset second end');
  assert.equal(await sessionOf(h.env, first.cookie), null); assert.equal(await sessionOf(h.env, second.cookie), null);
  const locked = await signIn(h.env, 'Crew.Reset', PASSWORD);
  assert.equal(locked.status, 401); assert.equal(locked.body.code, 'EMPLOYEE_ACCOUNT_RESET_PENDING'); assert.equal(locked.cookie, '');
  const invite = inviteOf(issued.body.link), token = invite.split('.')[1];
  assert.deepEqual(parseStaffResetInvite(invite), { username: 'crew.reset', token });
  assert.equal(h.fire.snapshot().includes(token), false, 'only the token digest is stored');
  const [audit] = audits(h.fire);
  assert.deepEqual([audit.action, audit.actor.id, audit.entity.id, audit.visibility, audit.at, audit.reason], ['staff_access.reset_signin', 'zacb', 'crew.reset', 'business', new Date(START).toISOString(), 'Synthetic forgotten password']);
  assert.deepEqual(JSON.parse(audit.after), { signInResetPending: true, expiresAt: issued.body.expiresAt, sessionsEnded: true, sent: false });
  assert.equal(JSON.stringify(audit).includes(token), false);
  const listed = await get(h.accounts, h.env, '/api/employee-accounts', owner);
  const row = listed.body.accounts.find(account => account.username === 'Crew.Reset');
  assert.deepEqual([row.signInResetPending, row.signInResetExpiresAt, row.signInReset, row.passwordHash], [true, issued.body.expiresAt, undefined, undefined]);
  // A replay confirms the saved reset without a second link; a changed body under the same id is a conflict.
  const body = reset('Crew.Reset'), replayRun = await post(h.accounts, h.env, '/api/employee-accounts', body, owner);
  const replay = await post(h.accounts, h.env, '/api/employee-accounts', body, owner);
  assert.deepEqual([replay.status, replay.body.replayed, replay.body.linkShown, replay.body.link], [200, true, false, undefined]);
  assert.equal((await post(h.accounts, h.env, '/api/employee-accounts', { ...body, reason: 'different' }, owner)).body.code, 'staff_access_idempotency_conflict');
  // Only the newest link works.
  assert.equal((await setup(h.setupService(), { action: 'inspect', invite })).status, 410);
  const newest = inviteOf(replayRun.body.link);
  const inspected = await setup(h.setupService(), { action: 'inspect', invite: newest });
  assert.deepEqual([inspected.status, inspected.body.kind, inspected.body.username, inspected.body.expiresAt], [200, 'reset', 'Crew.Reset', replayRun.body.expiresAt]);
  assert.equal((await setup(h.setupService(), { action: 'reset', invite: newest, password: 'short', confirmPassword: 'short' })).status, 400);
  assert.equal((await setup(h.setupService(), { action: 'reset', invite: newest, password: NEW_PASSWORD, confirmPassword: 'Different-Synthetic-9' })).status, 400);
  assert.equal((await setup(h.setupService(), { action: 'redeem', invite: newest, email: 'crew.reset@example.invalid', password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD })).status, 410, 'a reset link is not an invitation');
  h.advance(STAFF_RESET_HOURS * 3600000 - 1);
  const used = await setup(h.setupService(), { action: 'reset', invite: newest, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
  assert.deepEqual([used.status, used.body.reset, used.body.username, used.body.loginUrl], [200, true, 'Crew.Reset', '/staff-login']);
  assert.equal((await setup(h.setupService(), { action: 'reset', invite: newest, password: 'Another-Synthetic-Pass-1', confirmPassword: 'Another-Synthetic-Pass-1' })).status, 410, 'single use');
  assert.equal((await setup(h.setupService(), { action: 'inspect', invite: newest })).status, 410);
  assert.equal((await signIn(h.env, 'Crew.Reset', PASSWORD)).status, 401);
  const fresh = await signIn(h.env, 'Crew.Reset', NEW_PASSWORD);
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body)); assert.ok(await sessionOf(h.env, fresh.cookie));
  assert.ok(audits(h.fire).some(entry => entry.action === 'staff_access.reset_redeemed' && entry.actor.id === 'crew.reset'));
  assert.equal(h.fire.snapshot().includes(NEW_PASSWORD), false);
});

test('reset link: an unused link expires at 24 hours on the injected clock and changes nothing', async t => {
  const h = harness(t);
  await seedAccount(h.env, 'Crew.Late');
  const issued = await post(h.accounts, h.env, '/api/employee-accounts', reset('Crew.Late'), await cookieFor(h.env, 'ZacB'));
  const invite = inviteOf(issued.body.link), stored = await accountOf(h.env, 'Crew.Late');
  h.advance(STAFF_RESET_HOURS * 3600000);
  assert.equal((await setup(h.setupService(), { action: 'inspect', invite })).status, 410);
  assert.equal((await setup(h.setupService(), { action: 'reset', invite, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD })).status, 410);
  assert.deepEqual(await accountOf(h.env, 'Crew.Late'), stored);
  assert.equal((await signIn(h.env, 'Crew.Late', NEW_PASSWORD)).status, 401);
  assert.equal((await signIn(h.env, 'Crew.Late', PASSWORD)).body.code, 'EMPLOYEE_ACCOUNT_RESET_PENDING', 'an expired link keeps the old password locked');
  // A forged token for the same account never works.
  const forged = staffResetInvite('Crew.Late', 'A'.repeat(43));
  h.at(new Date(START).toISOString());
  assert.equal((await setup(h.setupService(), { action: 'inspect', invite: forged })).status, 410);
});

test('reset permissions: owner by default, managers only with the grant, never their own or a manager\'s account; pending shown without the IAM role', async t => {
  const h = harness(t, { __firebase: 'denied' });
  await seedAccount(h.env, 'Crew.One');
  await seedAccount(h.env, 'Stored.Manager', { extra: { staffRoles: ['manager'] } });
  await seedAccount(h.env, 'Crew.Pending', { status: 'pending' });
  const manager = await cookieFor(h.env, 'TylerG'), owner = await cookieFor(h.env, 'ZacB');
  const refused = await post(h.accounts, h.env, '/api/employee-accounts', reset('Crew.One'), manager);
  assert.deepEqual([refused.status, refused.body.code], [403, 'staff_access_forbidden']);
  assert.equal((await post(h.accounts, h.env, '/api/employee-accounts', reset('Crew.One'), await cookieFor(h.env, 'AlexK'))).status, 403);
  const crew = await login(h.env, 'Crew.One');
  assert.equal((await post(h.accounts, h.env, '/api/employee-accounts', reset('Crew.One'), crew.cookie)).status, 403);
  assert.equal((await post(h.accounts, h.env, '/api/employee-accounts', reset('TylerG'), owner)).body.code, 'staff_access_configured_account');
  assert.equal((await post(h.accounts, h.env, '/api/employee-accounts', reset('Crew.Pending'), owner)).status, 404);
  assert.equal((await post(h.accounts, h.env, '/api/employee-accounts', reset('Nobody.Here'), owner)).status, 404);
  assert.equal((await post(h.accounts, h.env, '/api/employee-accounts', reset('Crew.One'), owner, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(h.accounts, h.env, '/api/employee-accounts', reset('Crew.One'), owner, { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal(h.fire.commits.length, 0);
  const grantedEnv = { ...h.env, EGC_STAFF_MANAGER_GRANTS: 'accounts.reset' };
  const granted = await post(h.accounts, grantedEnv, '/api/employee-accounts', reset('Crew.One'), manager);
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.equal(granted.body.firebaseRevocation.status, 'revocation_pending');
  assert.match(granted.body.firebaseRevocation.message, /Firebase Authentication Admin role/);
  assert.equal(await sessionOf(h.env, crew.cookie), null, 'the Hub session ends even while Firebase is pending');
  const managerTarget = await post(h.accounts, grantedEnv, '/api/employee-accounts', reset('Stored.Manager'), manager);
  assert.deepEqual([managerTarget.status, managerTarget.body.code], [403, 'staff_access_forbidden']);
  assert.equal((await post(h.accounts, h.env, '/api/employee-accounts', reset('Stored.Manager'), owner)).status, 200, 'the owner resets a manager');
});

test('change password: checks the current one, keeps this browser signed in and ends every other Hub and Firebase session', async t => {
  const h = harness(t);
  await seedAccount(h.env, 'Crew.Change');
  const here = await login(h.env, 'Crew.Change'), phone = await login(h.env, 'Crew.Change');
  const change = (extra = {}) => ({ action: 'change_password', requestId: randomUUID(), currentPassword: PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD, ...extra });
  const wrong = await post(h.accounts, h.env, '/api/employee-accounts', change({ currentPassword: 'Not-The-Password-1' }), here.cookie);
  assert.deepEqual([wrong.status, wrong.body.code, wrong.headers.get('set-cookie')], [400, 'staff_access_password_incorrect', null]);
  for (const extra of [{ confirmPassword: 'Mismatch-Synthetic-1' }, { newPassword: 'alllowercase1', confirmPassword: 'alllowercase1' }, { newPassword: PASSWORD, confirmPassword: PASSWORD }, { username: 'Crew.Other' }]) {
    assert.equal((await post(h.accounts, h.env, '/api/employee-accounts', change(extra), here.cookie)).status, 400, JSON.stringify(extra));
  }
  assert.ok(await sessionOf(h.env, phone.cookie)); assert.equal(h.fire.commits.length, 0); assert.equal(h.fb.calls.length, 0);
  const changed = await post(h.accounts, h.env, '/api/employee-accounts', change(), here.cookie);
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual([changed.body.passwordChanged, changed.body.otherSessionsEnded, changed.body.firebaseRevocation.status, changed.body.profile], [true, true, 'revoked', undefined]);
  const cookie = changed.headers.get('set-cookie');
  assert.match(cookie, /^egc_hub_session=.+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200$/);
  assert.equal((await sessionOf(h.env, cookie.split(';')[0])).user, 'Crew.Change', 'this browser stays signed in');
  assert.equal(await sessionOf(h.env, here.cookie), null); assert.equal(await sessionOf(h.env, phone.cookie), null);
  assert.deepEqual(h.fb.calls.map(call => call.uid), ['hub:crew.change']);
  assert.equal((await signIn(h.env, 'Crew.Change', PASSWORD)).status, 401);
  assert.equal((await signIn(h.env, 'Crew.Change', NEW_PASSWORD)).status, 200);
  const snapshot = h.fire.snapshot();
  assert.equal(snapshot.includes(NEW_PASSWORD) || snapshot.includes(PASSWORD), false, 'no password is stored in the clear, not even in the receipt');
  assert.deepEqual(receipts(h.fire).map(row => [row.action, row.actor, row.target]), [['change_password', 'crew.change', 'crew.change']]);
  assert.ok(audits(h.fire).some(entry => entry.action === 'staff_access.change_password' && entry.at === new Date(START).toISOString()));
  // Configured Hub users change nothing here; their passwords live in the Hub configuration.
  const owner = await post(h.accounts, h.env, '/api/employee-accounts', change(), await cookieFor(h.env, 'ZacB'));
  assert.deepEqual([owner.status, owner.body.code], [403, 'staff_access_forbidden']);
});

test('approval: the owner must set a role and a starting rate; a granted manager sets the role only and gets 403 on pay', async t => {
  const h = harness(t);
  await seedAccount(h.env, 'New.Hire', { status: 'pending', extra: { hourlyRate: 0, reviewedAt: '', reviewedBy: '' } });
  await seedAccount(h.env, 'Second.Hire', { status: 'pending', extra: { hourlyRate: 0, reviewedAt: '', reviewedBy: '' } });
  const owner = await cookieFor(h.env, 'ZacB'), manager = await cookieFor(h.env, 'TylerG');
  const review = (username, extra = {}) => ({ action: 'review', requestId: randomUUID(), username, decision: 'approved', staffRoles: ['crew'], ...extra });
  assert.equal((await post(h.accounts, h.env, '/api/employee-accounts', review('New.Hire'), owner)).body.code, 'staff_access_invalid_pay', 'the owner\'s approval needs a starting rate');
  assert.equal((await post(h.accounts, h.env, '/api/employee-accounts', review('New.Hire', { staffRoles: undefined, hourlyRate: 22 }), owner)).body.code, 'staff_access_invalid_roles');
  assert.equal((await post(h.accounts, h.env, '/api/employee-accounts', review('New.Hire', { hourlyRate: 0 }), owner)).body.code, 'staff_access_invalid_pay');
  assert.equal((await post(h.accounts, h.env, '/api/employee-accounts', review('New.Hire', { hourlyRate: 22, staffRoles: ['owner'] }), owner)).status, 403);
  assert.equal(h.fire.commits.length, 0);
  const approved = await post(h.accounts, h.env, '/api/employee-accounts', review('New.Hire', { hourlyRate: 23.5, staffRoles: ['crew_lead'] }), owner);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.deepEqual([approved.body.account.status, approved.body.account.staffRoles, approved.body.startingRateSet, approved.body.payPending, approved.body.account.passwordHash], ['approved', ['crew_lead'], true, false, undefined]);
  const account = await accountOf(h.env, 'New.Hire');
  assert.deepEqual([account.hourlyRate, account.reviewedBy, account.reviewedAt], [23.5, 'ZacB', new Date(START).toISOString()]);
  const profile = await sealed(h.env, h.fire, 'profiles', 'new.hire');
  assert.deepEqual(profile.payRates.map(rate => [rate.effectiveFrom, rate.hourlyRate]), [['2000-01-01', 0], ['2026-09-24', 23.5]]);
  assert.equal(profile.hourlyRate, 23.5); assert.deepEqual(profile.staffRoles, ['crew_lead']);
  const [audit] = audits(h.fire);
  assert.deepEqual([audit.action, audit.visibility], ['employee_account.review', 'owner']);
  assert.equal(JSON.stringify(audit).includes('23.5'), false, 'the audit entry names the rate change, never the amount');
  // A manager without the grant cannot review; with it, sets the role and leaves pay pending for the owner.
  assert.equal((await post(h.accounts, h.env, '/api/employee-accounts', review('Second.Hire'), manager)).status, 403);
  assert.equal((await get(h.accounts, h.env, '/api/employee-accounts', manager)).status, 403);
  const granted = { ...h.env, EGC_STAFF_MANAGER_GRANTS: 'accounts.approve' };
  const listed = await get(h.accounts, granted, '/api/employee-accounts', manager);
  assert.equal(listed.status, 200); assert.deepEqual(listed.body.staffAccess, { setsPay: false, roles: ['crew_lead', 'crew', 'sales', 'phone'], resets: false });
  assert.ok(listed.body.accounts.length && listed.body.accounts.every(account => !('hourlyRate' in account) && !('payType' in account)), 'a granted manager never sees account pay');
  // The Team page reads the same list through /api/employee-hub?include=accounts: the grant opens it, still without pay.
  const hub = async env => { const response = await employeeHubGet({ env, request: jsonRequest('/api/employee-hub?include=accounts', undefined, manager) }); return { status: response.status, body: await response.json() }; };
  assert.equal((await hub(h.env)).status, 403, 'without the grant the account list stays the owner\'s');
  const teamList = await hub(granted);
  assert.equal(teamList.status, 200); assert.ok(teamList.body.accounts.some(account => account.username === 'Second.Hire'));
  assert.ok(teamList.body.accounts.every(account => !('hourlyRate' in account) && !('payType' in account)));
  const pay = await post(h.accounts, granted, '/api/employee-accounts', review('Second.Hire', { hourlyRate: 40 }), manager);
  assert.deepEqual([pay.status, pay.body.code], [403, 'pay_owner_only']);
  assert.equal((await post(h.accounts, granted, '/api/employee-accounts', review('Second.Hire', { payType: 'salary' }), manager)).body.code, 'pay_owner_only');
  assert.equal((await post(h.accounts, granted, '/api/employee-accounts', review('Second.Hire', { staffRoles: ['manager'] }), manager)).body.code, 'staff_access_owner_role_reserved');
  const roleOnly = await post(h.accounts, granted, '/api/employee-accounts', review('Second.Hire', { staffRoles: ['sales'] }), manager);
  assert.equal(roleOnly.status, 200, JSON.stringify(roleOnly.body));
  assert.deepEqual([roleOnly.body.account.status, roleOnly.body.account.staffRoles, roleOnly.body.payPending, roleOnly.body.startingRateSet, 'hourlyRate' in roleOnly.body.account], ['approved', ['sales'], true, false, false]);
  assert.equal((await accountOf(h.env, 'Second.Hire')).hourlyRate, 0);
  assert.equal(await sealed(h.env, h.fire, 'profiles', 'second.hire'), null, 'no pay is written by a manager');
  // The staff directory's pay stays owner-only for the same manager.
  const enabled = { ...granted, EGC_STAFF_DIRECTORY_ENABLED: 'true' };
  const setPay = await post(h.directory, enabled, '/api/staff-directory', { action: 'set_pay', requestId: randomUUID(), username: 'Second.Hire', expectedRevision: '', effectiveFrom: '2026-09-24', hourlyRate: 40 }, manager);
  assert.deepEqual([setPay.status, setPay.body.code], [403, 'staff_directory_forbidden']);
  // The managed role set: a granted manager may change roles, never to or from manager.
  const list = await get(h.directory, enabled, '/api/staff-directory?username=Second.Hire', manager);
  const toManager = await post(h.directory, enabled, '/api/staff-directory', { action: 'set_roles', requestId: randomUUID(), username: 'Second.Hire', expectedRevision: list.body.people[0].revision, staffRoles: ['manager'] }, manager);
  assert.deepEqual([toManager.status, toManager.body.code], [403, 'staff_directory_owner_role_reserved']);
  // Rejection sets nothing else; a replay answers from the saved account.
  const body = { action: 'review', requestId: randomUUID(), username: 'New.Hire', decision: 'rejected' };
  const rejected = await post(h.accounts, h.env, '/api/employee-accounts', body, owner);
  assert.equal(rejected.body.account.status, 'rejected');
  const replay = await post(h.accounts, h.env, '/api/employee-accounts', body, owner);
  assert.deepEqual([replay.status, replay.body.replayed, replay.body.account.status], [200, true, 'rejected']);
  assert.equal((await post(h.accounts, h.env, '/api/employee-accounts', { ...body, decision: 'approved', staffRoles: ['crew'], hourlyRate: 20 }, owner)).body.code, 'staff_access_idempotency_conflict');
});

test('review: a granted manager reviews pending requests only and never a manager\'s account; refusals record nothing and the owner still can', async t => {
  for (const extra of [{}, { EGC_STAFF_ROLE_PERMISSIONS: 'true' }]) {
    const h = harness(t, { EGC_STAFF_MANAGER_GRANTS: 'accounts.approve,accounts.reset', EGC_STAFF_DIRECTORY_ENABLED: 'true', ...extra });
    await seedAccount(h.env, 'Stored.Mgr', { extra: { staffRoles: ['manager'] } });
    await seedAccount(h.env, 'Peer.Mgr', { extra: { staffRoles: ['manager', 'sales'] } });
    await seedAccount(h.env, 'Former.Mgr', { status: 'rejected', extra: { staffRoles: ['manager'] } });
    await seedAccount(h.env, 'Crew.Approved', { extra: { staffRoles: ['crew'] } });
    await seedAccount(h.env, 'Crew.Rejected', { status: 'rejected' });
    await seedAccount(h.env, 'Crew.New', { status: 'pending', extra: { hourlyRate: 0 } });
    const manager = await cookieFor(h.env, 'TylerG'), owner = await cookieFor(h.env, 'ZacB');
    const review = (username, decision = 'approved', more = {}) => ({ action: 'review', requestId: randomUUID(), username, decision, ...(decision === 'approved' ? { staffRoles: ['crew'] } : {}), ...more });
    const names = ['Stored.Mgr', 'Peer.Mgr', 'Former.Mgr', 'Crew.Approved', 'Crew.Rejected'], before = {};
    for (const name of names) before[name] = await accountOf(h.env, name);
    for (const [body, code] of [
      [review('Stored.Mgr'), 'staff_access_owner_role_reserved'], [review('Stored.Mgr', 'rejected'), 'staff_access_owner_role_reserved'],
      [review('Former.Mgr'), 'staff_access_owner_role_reserved'], [review('Crew.Approved', 'approved', { staffRoles: ['sales'] }), 'staff_access_forbidden'],
      [review('Crew.Approved', 'rejected'), 'staff_access_forbidden'], [review('Crew.Rejected'), 'staff_access_forbidden'],
    ]) {
      const refused = await post(h.accounts, h.env, '/api/employee-accounts', body, manager);
      assert.deepEqual([refused.status, refused.body.code], [403, code], `${JSON.stringify(extra)} ${body.username} ${body.decision}`);
    }
    for (const name of names) assert.deepEqual(await accountOf(h.env, name), before[name], name);
    assert.equal(h.fire.commits.length, 0, 'no Firebase intent, receipt or audit is written for a refusal'); assert.equal(h.fb.calls.length, 0);
    // So the demote-then-reset takeover of a peer manager is closed: the reset stays refused.
    assert.equal((await post(h.accounts, h.env, '/api/employee-accounts', reset('Stored.Mgr'), manager)).body.code, 'staff_access_forbidden');
    // In the staff directory the same manager never changes a manager's roles either (nor gives the manager role).
    const directoryPerson = async name => (await get(h.directory, h.env, `/api/staff-directory?username=${name}`, owner)).body.people[0];
    const peer = await directoryPerson('Peer.Mgr');
    for (const staffRoles of [['manager'], ['sales']]) {
      const roles = await post(h.directory, h.env, '/api/staff-directory', { action: 'set_roles', requestId: randomUUID(), username: 'Peer.Mgr', expectedRevision: peer.revision, staffRoles }, manager);
      assert.deepEqual([roles.status, roles.body.code], [403, 'staff_directory_owner_role_reserved'], JSON.stringify(staffRoles));
    }
    assert.deepEqual((await accountOf(h.env, 'Peer.Mgr')).staffRoles, ['manager', 'sales']);
    // A pending request is still the granted manager's to review.
    const approved = await post(h.accounts, h.env, '/api/employee-accounts', review('Crew.New'), manager);
    assert.equal(approved.status, 200, JSON.stringify(approved.body)); assert.equal((await accountOf(h.env, 'Crew.New')).status, 'approved');
    // The owner re-reviews, demotes and deactivates as before.
    const demoted = await post(h.accounts, h.env, '/api/employee-accounts', review('Stored.Mgr', 'approved', { hourlyRate: 25 }), owner);
    assert.equal(demoted.status, 200, JSON.stringify(demoted.body)); assert.deepEqual((await accountOf(h.env, 'Stored.Mgr')).staffRoles, ['crew']);
    assert.equal((await post(h.accounts, h.env, '/api/employee-accounts', review('Crew.Approved', 'rejected'), owner)).status, 200);
    assert.equal((await post(h.accounts, h.env, '/api/employee-accounts', review('Crew.Rejected', 'approved', { hourlyRate: 20 }), owner)).status, 200);
    assert.deepEqual((await Promise.all(['Crew.Approved', 'Crew.Rejected'].map(name => accountOf(h.env, name)))).map(account => account.status), ['rejected', 'approved']);
  }
});

test('set_roles race: the owner makes someone a manager between a granted manager\'s directory read and account read; the stale change is refused and no reset follows', async t => {
  for (const extra of [{}, { EGC_STAFF_ROLE_ACCESS: 'true' }]) {
    const h = harness(t, { EGC_STAFF_MANAGER_GRANTS: 'accounts.approve,accounts.reset', EGC_STAFF_DIRECTORY_ENABLED: 'true', ...extra });
    await seedAccount(h.env, 'Soon.Mgr', { extra: { staffRoles: ['crew'], hourlyRate: 20 } });
    const manager = await cookieFor(h.env, 'TylerG'), owner = await cookieFor(h.env, 'ZacB'), today = denverToday(h.now());
    const person = async () => (await get(h.directory, h.env, '/api/staff-directory?username=Soon.Mgr', owner)).body.people[0];
    // Today's rate is on the schedule, so the owner's promotion at that same rate leaves the profile (and its revision) as is.
    const pay = await post(h.directory, h.env, '/api/staff-directory', { action: 'set_pay', requestId: randomUUID(), username: 'Soon.Mgr', expectedRevision: (await person()).revision, effectiveFrom: today, hourlyRate: 20 }, owner);
    assert.equal(pay.status, 200, JSON.stringify(pay.body));
    const opened = await person();
    assert.deepEqual(opened.staffRoles, ['crew']);
    // The owner's account review lands after the manager's directory (roster) read and before its account read.
    let promotion = null, settled = null;
    const storage = env => {
      const base = staffDirectoryStorage(env);
      return { ...base, readAccount: async username => {
        if (!promotion) {
          promotion = await post(h.accounts, h.env, '/api/employee-accounts', { action: 'review', requestId: randomUUID(), username: 'Soon.Mgr', decision: 'approved', staffRoles: ['manager'], hourlyRate: 20 }, owner);
          settled = { commits: h.fire.commits.length, calls: h.fb.calls.length };
        }
        return base.readAccount(username);
      } };
    };
    const racing = staffDirectoryHandlers({ now: h.now, revocations: h.fb.revocations, storage });
    const requestId = randomUUID();
    const demote = await post(racing, h.env, '/api/staff-directory', { action: 'set_roles', requestId, username: 'Soon.Mgr', expectedRevision: opened.revision, staffRoles: ['crew_lead'] }, manager);
    assert.equal(promotion?.status, 200, JSON.stringify(promotion?.body));
    assert.equal(promotion.body.startingRateSet, true);
    assert.deepEqual([demote.status, demote.body.code], [409, 'staff_directory_revision_conflict'], JSON.stringify(extra));
    // The refused change wrote nothing after the promotion (no role change, receipt, audit or Firebase intent) and revoked nothing.
    assert.deepEqual({ commits: h.fire.commits.length, calls: h.fb.calls.length }, settled);
    assert.equal(audits(h.fire).some(entry => entry.action === 'staff_directory.set_roles'), false);
    assert.equal(h.fire.documents.has(`staffDirectoryOperations/${requestId}`), false);
    const promoted = await accountOf(h.env, 'Soon.Mgr');
    assert.deepEqual(promoted.staffRoles, ['manager']);
    const refreshed = await person();
    assert.equal(refreshed.revision, opened.revision, 'the profile fence alone would not have caught the race');
    assert.deepEqual(refreshed.staffRoles, ['manager']);
    // Refreshed, the manager still cannot change a manager's roles, and cannot reset the new manager's sign-in.
    const retried = await post(h.directory, h.env, '/api/staff-directory', { action: 'set_roles', requestId: randomUUID(), username: 'Soon.Mgr', expectedRevision: refreshed.revision, staffRoles: ['crew_lead'] }, manager);
    assert.deepEqual([retried.status, retried.body.code], [403, 'staff_directory_owner_role_reserved']);
    const takeover = await post(h.accounts, h.env, '/api/employee-accounts', reset('Soon.Mgr'), manager);
    assert.deepEqual([takeover.status, takeover.body.code], [403, 'staff_access_forbidden']);
    assert.deepEqual(await accountOf(h.env, 'Soon.Mgr'), promoted, 'the account is exactly as the owner left it');
  }
});

test('first approval day: stamped once and kept, so a re-review never moves the first rate floor', async t => {
  const h = harness(t, { EGC_STAFF_DIRECTORY_ENABLED: 'true', EGC_STAFF_MANAGER_GRANTS: 'accounts.approve' });
  await seedAccount(h.env, 'Late.Pay', { status: 'pending', extra: { hourlyRate: 0, reviewedAt: '', reviewedBy: '' } });
  await seedAccount(h.env, 'Re.Reviewed', { extra: { hourlyRate: 0, approvedAt: '2026-09-19T16:00:00.000Z', reviewedAt: '2026-09-22T16:00:00.000Z' } });
  const owner = await cookieFor(h.env, 'ZacB'), manager = await cookieFor(h.env, 'TylerG');
  const review = (cookie, more = {}) => post(h.accounts, h.env, '/api/employee-accounts', { action: 'review', requestId: randomUUID(), username: 'Late.Pay', decision: 'approved', staffRoles: ['crew'], ...more }, cookie);
  // A granted manager approves on Monday; pay stays pending for the owner.
  h.at('2026-09-21T15:00:00.000Z');
  const first = await review(manager);
  assert.deepEqual([first.status, first.body.payPending], [200, true]);
  assert.equal((await accountOf(h.env, 'Late.Pay')).approvedAt, '2026-09-21T15:00:00.000Z');
  for (const row of [card('late-1', 'Late.Pay', '2026-09-21', 4), card('late-2', 'Late.Pay', '2026-09-22', 3)]) await writeOne(h.env, 'timeEntries', row.id, row, { data: null }, row.updatedAt);
  // Wednesday: the floor is Monday, and the owner's re-review with the starting rate keeps it.
  h.at('2026-09-23T15:00:00.000Z');
  assert.equal((await get(h.directory, h.env, '/api/staff-directory?username=Late.Pay', owner)).body.people[0].pay.firstRateFrom, '2026-09-21');
  const again = await review(owner, { staffRoles: ['crew_lead'], hourlyRate: 24 });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual([again.body.startingRateSet, again.body.startingRateFrom, again.body.payPending], [true, '2026-09-21', false]);
  const account = await accountOf(h.env, 'Late.Pay');
  assert.deepEqual([account.approvedAt, account.reviewedAt, account.staffRoles], ['2026-09-21T15:00:00.000Z', '2026-09-23T15:00:00.000Z', ['crew_lead']], 'the re-review moves reviewedAt, never approvedAt');
  const profile = await sealed(h.env, h.fire, 'profiles', 'late.pay');
  assert.deepEqual(profile.payRates.map(rate => [rate.effectiveFrom, rate.hourlyRate]), [['2000-01-01', 0], ['2026-09-21', 24]], 'the starting rate takes effect the first approval day');
  const audit = audits(h.fire).filter(entry => entry.action === 'employee_account.review').at(-1);
  assert.equal(JSON.parse(audit.after).startingRateFrom, '2026-09-21');
  // So Apply rate pays Monday's and Tuesday's $0 shifts.
  const plan = (await post(h.directory, h.env, '/api/staff-directory', { action: 'preview_apply_rate', username: 'Late.Pay' }, owner)).body;
  assert.deepEqual(plan.weeks.map(week => [week.weekStart, week.timecards, week.rates, week.pay]), [['2026-09-21', 2, [24], 168]]);
  // A later rejection keeps the first approval day too.
  h.at('2026-09-24T15:00:00.000Z');
  assert.equal((await post(h.accounts, h.env, '/api/employee-accounts', { action: 'review', requestId: randomUUID(), username: 'Late.Pay', decision: 'rejected' }, owner)).status, 200);
  assert.equal((await accountOf(h.env, 'Late.Pay')).approvedAt, '2026-09-21T15:00:00.000Z');
  // The directory reads approvedAt before reviewedAt.
  assert.equal((await get(h.directory, h.env, '/api/staff-directory?username=Re.Reviewed', owner)).body.people[0].pay.firstRateFrom, '2026-09-19');
});

test('first rate: a schedule holding only $0 entries (the migrated legacy baseline, or a $0 set_pay) still takes the backdated first rate', async t => {
  const h = harness(t, { EGC_STAFF_DIRECTORY_ENABLED: 'true' });
  const owner = await cookieFor(h.env, 'ZacB');
  const migration = VAULT_MIGRATIONS['staff-profile-pay-roles-v1'];
  for (const username of ['Zero.Migrated', 'Zero.SetPay']) {
    await seedAccount(h.env, username, { extra: { hourlyRate: 0, reviewedAt: '2026-09-20T16:00:00.000Z' } });
    const base = { id: username.toLowerCase(), username, displayName: `Synthetic ${username}`, role: 'crew', status: 'active', payType: 'hourly', hourlyRate: 0, updatedAt: '2026-09-21T12:00:00.000Z' };
    const migrated = { ...base, ...migration.transform(base, { now: '2026-09-21T12:00:00.000Z', id: migration.id, configuredUsers: new Set() }) };
    await writeOne(h.env, 'profiles', base.id, username === 'Zero.Migrated' ? migrated : base, { data: null }, base.updatedAt);
  }
  const person = async username => (await get(h.directory, h.env, `/api/staff-directory?username=${username}`, owner)).body.people[0];
  const setPay = async (username, effectiveFrom, hourlyRate) => post(h.directory, h.env, '/api/staff-directory', { action: 'set_pay', requestId: randomUUID(), username, expectedRevision: (await person(username)).revision, effectiveFrom, hourlyRate }, owner);
  const zero = await person('Zero.Migrated');
  assert.deepEqual(zero.pay.schedule.map(rate => [rate.effectiveFrom, rate.hourlyRate]), [['2000-01-01', 0]]);
  assert.equal(zero.pay.firstRateFrom, '2026-09-20');
  // A $0 set_pay leaves the floor in place.
  assert.equal((await setPay('Zero.SetPay', '2026-09-24', 0)).status, 200);
  assert.equal((await person('Zero.SetPay')).pay.firstRateFrom, '2026-09-20');
  const saved = await setPay('Zero.Migrated', '2026-09-20', 22);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.person.pay.schedule.map(rate => [rate.effectiveFrom, rate.hourlyRate]), [['2000-01-01', 0], ['2026-09-20', 22]]);
  assert.equal(saved.body.person.pay.firstRateFrom, undefined, 'a rate above $0 ends the floor');
  assert.equal((await setPay('Zero.Migrated', '2026-09-21', 23)).body.code, 'staff_directory_invalid_pay');
});

// Denver is UTC-6 in September: hour `hour` of Denver date `date`.
const at = (date, hour) => new Date(Date.parse(`${date}T00:00:00Z`) + (hour + 6) * 3600000).toISOString();
const card = (id, employee, date, hours, extra = {}) => ({ id, employee, employeeName: `Synthetic ${employee}`, payType: 'hourly', hourlyRate: 0, clockInAt: at(date, 8), clockOutAt: at(date, 8 + hours), hours, grossEstimate: 0, status: 'submitted', approvalStatus: 'approved', breaks: [], updatedAt: at(date, 8 + hours), ...extra });

test('first rate: backdated to the approval date only, and only while it is the first rate', async t => {
  const h = harness(t, { EGC_STAFF_DIRECTORY_ENABLED: 'true' });
  await seedAccount(h.env, 'First.Rate', { extra: { hourlyRate: 0, reviewedAt: '2026-09-20T16:00:00.000Z' } });
  const owner = await cookieFor(h.env, 'ZacB');
  const person = (await get(h.directory, h.env, '/api/staff-directory?username=First.Rate', owner)).body.people[0];
  assert.equal(person.pay.firstRateFrom, '2026-09-20');
  const setPay = (effectiveFrom, env = h.env, revision = person.revision) => post(h.directory, env, '/api/staff-directory', { action: 'set_pay', requestId: randomUUID(), username: 'First.Rate', expectedRevision: revision, effectiveFrom, hourlyRate: 24 }, owner);
  const early = await setPay('2026-09-19');
  assert.deepEqual([early.status, early.body.code], [400, 'staff_directory_invalid_pay']); assert.match(early.body.error, /2026-09-20/);
  const off = { ...h.env, EGC_STAFF_PASSWORD_RESET: 'false' };
  assert.equal((await get(h.directory, off, '/api/staff-directory?username=First.Rate', owner)).body.people[0].pay.firstRateFrom, undefined);
  assert.equal((await setPay('2026-09-20', off)).body.code, 'staff_directory_invalid_pay', 'flag off: no backdating');
  const saved = await setPay('2026-09-20');
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.person.pay.current.hourlyRate, 24); assert.equal(saved.body.person.pay.firstRateFrom, undefined, 'the floor is only for the first rate');
  const later = await setPay('2026-09-21', h.env, saved.body.person.revision);
  assert.equal(later.body.code, 'staff_directory_invalid_pay', 'a second rate starts today at the earliest');
});

test('apply rate: only $0 timecards in open weeks change, fenced and audited; exported weeks never; the owner only', async t => {
  const h = harness(t, { EGC_STAFF_DIRECTORY_ENABLED: 'true', EGC_STAFF_MANAGER_GRANTS: 'accounts.reset,accounts.approve' });
  await seedAccount(h.env, 'Crew.Rate', { extra: { hourlyRate: 0, reviewedAt: '2026-09-19T16:00:00.000Z' } });
  const owner = await cookieFor(h.env, 'ZacB'), manager = await cookieFor(h.env, 'TylerG');
  const person = (await get(h.directory, h.env, '/api/staff-directory?username=Crew.Rate', owner)).body.people[0];
  assert.equal((await post(h.directory, h.env, '/api/staff-directory', { action: 'set_pay', requestId: randomUUID(), username: 'Crew.Rate', expectedRevision: person.revision, effectiveFrom: '2026-09-20', hourlyRate: 22.5 }, owner)).status, 200);
  const cards = [
    card('tc-before', 'Crew.Rate', '2026-09-19', 4),
    card('tc-exported', 'Crew.Rate', '2026-09-20', 5),
    card('tc-open-1', 'Crew.Rate', '2026-09-21', 4),
    card('tc-open-2', 'crew.rate', '2026-09-22', 3, { approvalStatus: 'pending' }),
    card('tc-paid', 'Crew.Rate', '2026-09-22', 2, { hourlyRate: 18, grossEstimate: 36 }),
    card('tc-other', 'Crew.Other', '2026-09-22', 6),
    card('tc-salary', 'Crew.Rate', '2026-09-23', 2, { payType: 'salary' }),
  ];
  for (const row of cards) await writeOne(h.env, 'timeEntries', row.id, row, { data: null }, row.updatedAt);
  await recordPayrollWeekExport(dispatchStorage(h.env), { weekStart: '2026-09-14', weekEnd: '2026-09-20', format: 'gusto', actor: 'ZacB', now: '2026-09-21T15:00:00.000Z' });
  const preview = await post(h.directory, h.env, '/api/staff-directory', { action: 'preview_apply_rate', username: 'Crew.Rate' }, owner);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(preview.body.weeks, [
    { weekStart: '2026-09-14', weekEnd: '2026-09-20', exported: true, exportedAt: '2026-09-21T15:00:00.000Z', timecards: 1, hours: 5, rates: [22.5], pay: 112.5 },
    { weekStart: '2026-09-21', weekEnd: '2026-09-27', exported: false, timecards: 2, hours: 7, rates: [22.5], pay: 157.5 },
  ]);
  assert.deepEqual(preview.body.skipped, { beforeRate: 1, notHourly: 1, unreadable: 0 });
  // Nobody but the owner, whatever the owner granted.
  for (const action of [{ action: 'preview_apply_rate', username: 'Crew.Rate' }, { action: 'apply_rate', requestId: randomUUID(), username: 'Crew.Rate', expectedRevision: preview.body.expectedRevision, planDigest: preview.body.planDigest, weeks: ['2026-09-21'] }]) {
    const refused = await post(h.directory, h.env, '/api/staff-directory', action, manager);
    assert.deepEqual([refused.status, refused.body.code], [403, 'pay_owner_only']);
  }
  const apply = weeks => ({ action: 'apply_rate', requestId: randomUUID(), username: 'Crew.Rate', expectedRevision: preview.body.expectedRevision, planDigest: preview.body.planDigest, weeks, reason: 'Synthetic first rate' });
  const exported = await post(h.directory, h.env, '/api/staff-directory', apply(['2026-09-14']), owner);
  assert.deepEqual([exported.status, exported.body.code], [409, 'staff_access_week_exported']);
  assert.equal((await post(h.directory, h.env, '/api/staff-directory', { ...apply(['2026-09-21']), planDigest: '0'.repeat(64) }, owner)).body.code, 'staff_access_revision_conflict');
  const commits = h.fire.commits.length, body = apply(['2026-09-21']);
  const applied = await post(h.directory, h.env, '/api/staff-directory', body, owner);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.deepEqual(applied.body.applied, { weeks: ['2026-09-21'], timecards: 2 });
  assert.equal(h.fire.commits.length, commits + 1, 'one atomic commit');
  const writes = h.fire.commits.at(-1);
  assert.ok(writes.every(write => write.currentDocument && (write.currentDocument.updateTime || write.currentDocument.exists === false)), 'every write is revision-fenced or create-only');
  const read = async id => (await readCollectionRecords(h.env, 'timeEntries')).find(row => row.data.id === id).data;
  for (const [id, hours] of [['tc-open-1', 4], ['tc-open-2', 3]]) {
    const saved = await read(id);
    assert.deepEqual([saved.hourlyRate, saved.grossEstimate, saved.history.at(-1).action, saved.history.at(-1).changes.hourlyRate, saved.updatedAt], [22.5, hours * 22.5, 'apply_rate', { before: 0, after: 22.5 }, new Date(START).toISOString()]);
  }
  assert.equal((await read('tc-open-1')).approvalStatus, 'approved', 'approval and hours are kept');
  assert.equal((await read('tc-open-2')).approvalStatus, 'pending');
  for (const [id, rate] of [['tc-before', 0], ['tc-exported', 0], ['tc-paid', 18], ['tc-other', 0], ['tc-salary', 0]]) assert.equal((await read(id)).hourlyRate, rate, id);
  const audit = audits(h.fire).find(entry => entry.action === 'staff_access.apply_rate');
  assert.deepEqual([audit.visibility, audit.actor.id, audit.reason, JSON.parse(audit.after)], ['owner', 'zacb', 'Synthetic first rate', { weeks: ['2026-09-21'], timecards: 2 }]);
  const week = decodeFirestoreFields(h.fire.documents.get('payrollWeekExports/2026-09-21').fields);
  assert.deepEqual([week.exportedAt, week.rateAppliedBy, week.rateAppliedRequestId], [undefined, 'ZacB', body.requestId.toLowerCase()]);
  const replay = await post(h.directory, h.env, '/api/staff-directory', body, owner);
  assert.deepEqual([replay.status, replay.body.replayed, replay.body.applied], [200, true, { weeks: ['2026-09-21'], timecards: 2 }]);
  assert.equal(h.fire.commits.length, commits + 1);
  const again = await post(h.directory, h.env, '/api/staff-directory', { action: 'preview_apply_rate', username: 'Crew.Rate' }, owner);
  assert.deepEqual(again.body.weeks.map(row => [row.weekStart, row.timecards]), [['2026-09-14', 1]], 'nothing is left at $0 in the open week');
});

test('apply rate is revision-fenced: a timecard or an export that lands after the preview refuses the whole change', async t => {
  const h = harness(t, { EGC_STAFF_DIRECTORY_ENABLED: 'true' });
  await seedAccount(h.env, 'Crew.Fence', { extra: { hourlyRate: 0, reviewedAt: '2026-09-21T16:00:00.000Z' } });
  const owner = await cookieFor(h.env, 'ZacB');
  const person = (await get(h.directory, h.env, '/api/staff-directory?username=Crew.Fence', owner)).body.people[0];
  await post(h.directory, h.env, '/api/staff-directory', { action: 'set_pay', requestId: randomUUID(), username: 'Crew.Fence', expectedRevision: person.revision, effectiveFrom: '2026-09-21', hourlyRate: 20 }, owner);
  for (const row of [card('fence-1', 'Crew.Fence', '2026-09-21', 4), card('fence-2', 'Crew.Fence', '2026-09-22', 4)]) await writeOne(h.env, 'timeEntries', row.id, row, { data: null }, row.updatedAt);
  const preview = async () => (await post(h.directory, h.env, '/api/staff-directory', { action: 'preview_apply_rate', username: 'Crew.Fence' }, owner)).body;
  const apply = plan => ({ action: 'apply_rate', requestId: randomUUID(), username: 'Crew.Fence', expectedRevision: plan.expectedRevision, planDigest: plan.planDigest, weeks: ['2026-09-21'] });
  const records = () => readCollectionRecords(h.env, 'timeEntries');
  // A timecard saved between the preview and the commit.
  let plan = await preview();
  h.fire.hooks.beforeCommit = async () => { const row = (await records()).find(item => item.data.id === 'fence-2'); await writeOne(h.env, 'timeEntries', 'fence-2', { ...row.data, approvalStatus: 'approved', updatedAt: 'raced' }, row, 'raced'); };
  const raced = await post(h.directory, h.env, '/api/staff-directory', apply(plan), owner);
  assert.deepEqual([raced.status, raced.body.code], [409, 'staff_access_revision_conflict']);
  assert.deepEqual((await records()).map(row => row.data.hourlyRate), [0, 0], 'nothing was applied');
  // A payroll export recorded after the preview.
  plan = await preview();
  await recordPayrollWeekExport(dispatchStorage(h.env), { weekStart: '2026-09-21', weekEnd: '2026-09-27', format: 'csv', actor: 'ZacB', now: new Date(START).toISOString() });
  const late = await post(h.directory, h.env, '/api/staff-directory', apply(plan), owner);
  assert.deepEqual([late.status, late.body.code], [409, 'staff_access_revision_conflict']);
  const fresh = await preview();
  assert.equal(fresh.weeks[0].exported, true);
  assert.equal((await post(h.directory, h.env, '/api/staff-directory', apply(fresh), owner)).body.code, 'staff_access_week_exported');
  // An export racing the commit on the same week record.
  await writeOne(h.env, 'timeEntries', 'fence-3', card('fence-3', 'Crew.Fence', '2026-09-29', 4), { data: null }, 'seed');
  plan = await preview();
  h.fire.hooks.beforeCommit = () => recordPayrollWeekExport(dispatchStorage(h.env), { weekStart: '2026-09-28', weekEnd: '2026-10-04', format: 'gusto', actor: 'ZacB', now: new Date(START).toISOString() });
  const exportRace = await post(h.directory, h.env, '/api/staff-directory', { ...apply(plan), weeks: ['2026-09-28'] }, owner);
  assert.deepEqual([exportRace.status, exportRace.body.code], [409, 'staff_access_revision_conflict']);
  assert.equal((await records()).find(row => row.data.id === 'fence-3').data.hourlyRate, 0);
});

test('payroll exports are recorded before the file is handed over, only with the flag on, on the week record read before the timecards', async t => {
  const week = [card('x-1', 'Crew.One', '2026-09-21', 8, { hourlyRate: 22, grossEstimate: 176 })];
  const owner = { user: 'ZacB', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
  let calls = [];
  // A fake export store: the order of the week-record read, the timecard read and the commit is what matters.
  const exportStore = ({ current = null, commit = async () => {}, read = async () => current } = {}) => () => ({
    read: async (collection, id) => { calls.push(['read', collection, id]); return read(); },
    commit: async writes => { calls.push(['commit', writes]); await commit(); },
  });
  const handler = (store, env, format = 'csv') => { calls = []; return timesheetHandlers({ session: async () => owner, read: async () => { calls.push(['timecards']); return { timecards: week, requests: [] }; },
    gustoProfiles: async () => new Map([['crew.one', { gustoEmployeeId: 'gusto-syn-1', gustoExcluded: false, displayName: null }]]), now: () => new Date('2026-10-05T18:00:00.000Z'), exportStore: store })
    .get({ env, request: new Request(`${ORIGIN}/api/timesheets?view=week&start=2026-09-21&format=${format}`) }); };
  const off = await handler(exportStore(), {});
  assert.equal(off.status, 200); assert.deepEqual(calls, [['timecards']], 'flag off: nothing is read or recorded');
  assert.equal((await handler(exportStore(), ON, 'json')).status, 200); assert.deepEqual(calls, [['timecards']], 'the weekly view records nothing');
  const on = await handler(exportStore(), ON);
  assert.equal(on.status, 200);
  assert.deepEqual(calls.map(call => call[0]), ['read', 'timecards', 'commit'], 'the week record is read before the timecards');
  assert.deepEqual(calls[0], ['read', 'payrollWeekExports', '2026-09-21']);
  assert.deepEqual(calls[2][1], [{ collection: 'payrollWeekExports', id: '2026-09-21', patch: { weekStart: '2026-09-21', weekEnd: '2026-09-27', formats: ['csv'], exportedAt: '2026-10-05T18:00:00.000Z', exportedBy: 'ZacB',
    lastExportedAt: '2026-10-05T18:00:00.000Z', lastExportedBy: 'ZacB', exportCount: 1 } }], 'no record yet: created only if still absent');
  const seen = { weekStart: '2026-09-21', weekEnd: '2026-09-27', rateAppliedAt: '2026-10-04T18:00:00.000Z', revision: 'rev-week-1' };
  assert.equal((await handler(exportStore({ current: seen }), ON, 'gusto')).status, 200);
  assert.deepEqual([calls[2][1][0].revision, calls[2][1][0].patch.formats], ['rev-week-1', ['gusto']], 'recorded on the revision read before the timecards');
  // A change to the week record after that read (Apply rate) refuses the file; any other failure hands nothing over either.
  const changed = await handler(exportStore({ commit: async () => { throw Object.assign(new Error('synthetic'), { code: 'dispatch_revision_conflict' }); } }), ON);
  const refused = await changed.json();
  assert.deepEqual([changed.status, refused.code, changed.headers.get('content-disposition')], [409, 'timesheet_export_changed', null]); assert.match(refused.error, /Retry the download/);
  const failed = await handler(exportStore({ commit: async () => { throw new Error('synthetic storage down'); } }), ON);
  assert.equal(failed.status, 503); const body = await failed.json();
  assert.equal(body.code, 'timesheet_export_unrecorded'); assert.doesNotMatch(JSON.stringify(body), /Crew\.One|22|synthetic/);
  const unread = await handler(exportStore({ read: async () => { throw new Error('synthetic read down'); } }), ON);
  assert.deepEqual([unread.status, (await unread.json()).code, calls.map(call => call[0])], [503, 'timesheet_export_unrecorded', ['read']], 'the timecards are never read');
  // The real record: first export kept, a later one counted; a stale observed record is refused, never retried.
  const fire = vaultFirestore(t), env = staffEnv(ON), store = dispatchStorage(env);
  await recordPayrollWeekExport(store, { weekStart: '2026-09-21', weekEnd: '2026-09-27', format: 'csv', actor: 'ZacB', now: '2026-10-05T18:00:00.000Z' }, null);
  await assert.rejects(recordPayrollWeekExport(store, { weekStart: '2026-09-21', weekEnd: '2026-09-27', format: 'gusto', actor: 'ZacB', now: '2026-10-06T18:00:00.000Z' }, null), { code: 'dispatch_revision_conflict' });
  const saved = await recordPayrollWeekExport(store, { weekStart: '2026-09-21', weekEnd: '2026-09-27', format: 'gusto', actor: 'ZacB', now: '2026-10-06T18:00:00.000Z' }, await store.read('payrollWeekExports', '2026-09-21'));
  assert.deepEqual([saved.exportedAt, saved.lastExportedAt, saved.formats, saved.exportCount], ['2026-10-05T18:00:00.000Z', '2026-10-06T18:00:00.000Z', ['csv', 'gusto'], 2]);
  assert.equal(fire.commits.length, 2);
});

test('an export and Apply rate racing on one week: whichever commits second is refused, and the retried download pays the rate', async t => {
  const h = harness(t, { EGC_STAFF_DIRECTORY_ENABLED: 'true' });
  await seedAccount(h.env, 'Crew.Race', { extra: { hourlyRate: 0, reviewedAt: '2026-09-20T16:00:00.000Z' } });
  const owner = await cookieFor(h.env, 'ZacB');
  const person = (await get(h.directory, h.env, '/api/staff-directory?username=Crew.Race', owner)).body.people[0];
  assert.equal((await post(h.directory, h.env, '/api/staff-directory', { action: 'set_pay', requestId: randomUUID(), username: 'Crew.Race', expectedRevision: person.revision, effectiveFrom: '2026-09-21', hourlyRate: 20 }, owner)).status, 200);
  for (const row of [card('race-1', 'Crew.Race', '2026-09-21', 4), card('race-2', 'Crew.Race', '2026-09-22', 3), card('race-3', 'Crew.Race', '2026-09-29', 5)]) await writeOne(h.env, 'timeEntries', row.id, row, { data: null }, row.updatedAt);
  const preview = async () => (await post(h.directory, h.env, '/api/staff-directory', { action: 'preview_apply_rate', username: 'Crew.Race' }, owner)).body;
  const apply = (plan, weekStart) => post(h.directory, h.env, '/api/staff-directory', { action: 'apply_rate', requestId: randomUUID(), username: 'Crew.Race', expectedRevision: plan.expectedRevision, planDigest: plan.planDigest, weeks: [weekStart] }, owner);
  const weekRecord = weekStart => { const doc = h.fire.documents.get(`payrollWeekExports/${weekStart}`); return doc ? decodeFirestoreFields(doc.fields) : null; };
  // The real timesheet handler on the same storage; its read() runs Apply rate part-way through, after the $0 snapshot.
  let race = null, applied = null;
  const timesheets = timesheetHandlers({ session: async () => people.ZacB, now: () => new Date('2026-10-12T18:00:00.000Z'),
    read: async env => { const records = await readTimesheetRecords(env); if (race) { const run = race; race = null; applied = await run(); } return records; } });
  const download = async (start, acknowledge) => { const response = await timesheets.get({ env: h.env, request: new Request(`${ORIGIN}/api/timesheets?view=week&start=${start}&format=csv${acknowledge ? '&acknowledge=' + acknowledge : ''}`) }); return { status: response.status, text: await response.text() }; };
  // Apply rate lands while the export is building its file from the $0 timecards: the export is refused.
  const plan = await preview();
  race = () => apply(plan, '2026-09-21');
  const stale = await download('2026-09-21', 'missing_rate');
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(stale.status, 409, 'the export built from the $0 snapshot is refused'); assert.equal(JSON.parse(stale.text).code, 'timesheet_export_changed');
  assert.deepEqual([Boolean(weekRecord('2026-09-21').rateAppliedAt), weekRecord('2026-09-21').exportedAt], [true, undefined], 'exactly one side landed: the rate');
  // The retried download reads the applied rate: no $0 flag is left to acknowledge.
  const fresh = await download('2026-09-21');
  assert.equal(fresh.status, 200, fresh.text); assert.match(fresh.text, /Crew\.Race/);
  assert.ok(weekRecord('2026-09-21').exportedAt);
  // An export that lands after the Apply rate preview: Apply rate is refused and the exported timecard keeps $0.
  const later = await preview();
  assert.equal((await download('2026-09-28', 'missing_rate')).status, 200);
  const refused = await apply(later, '2026-09-28');
  assert.deepEqual([refused.status, refused.body.code], [409, 'staff_access_revision_conflict']);
  assert.equal((await readCollectionRecords(h.env, 'timeEntries')).find(row => row.data.id === 'race-3').data.hourlyRate, 0);
  assert.equal(weekRecord('2026-09-28').rateAppliedAt, undefined, 'exactly one side landed: the export');
});

test('flag off: accounts, sign-in, setup, timesheets and the directory answer exactly as before and nothing new is written', async t => {
  const fire = vaultFirestore(t), env = staffEnv({ EGC_STAFF_MANAGER_GRANTS: 'accounts.reset,accounts.approve', EGC_STAFF_DIRECTORY_ENABLED: 'true' });
  const accounts = employeeAccountsHandlers({ now: () => new Date(START), revocations: firebase().revocations });
  await seedAccount(env, 'Crew.Off');
  await seedAccount(env, 'Pending.Off', { status: 'pending' });
  const owner = await cookieFor(env, 'ZacB'), manager = await cookieFor(env, 'TylerG'), crew = await login(env, 'Crew.Off');
  for (const action of ['reset_signin', 'change_password']) {
    const response = await post(accounts, env, '/api/employee-accounts', { action, requestId: randomUUID(), username: 'Crew.Off', currentPassword: PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD }, owner);
    assert.deepEqual([response.status, response.body], [400, { ok: false, error: 'Unsupported employee account action' }]);
  }
  assert.deepEqual(await get(accounts, env, '/api/employee-accounts', manager), { status: 403, body: { ok: false, error: 'Only Zac can approve employee accounts' } });
  const listed = await get(accounts, env, '/api/employee-accounts', owner);
  assert.deepEqual(Object.keys(listed.body), ['ok', 'accounts']);
  const review = await post(accounts, env, '/api/employee-accounts', { action: 'review', username: 'Pending.Off', decision: 'approved', staffRoles: ['manager'], hourlyRate: 99 }, owner);
  assert.equal(review.status, 200); assert.deepEqual(Object.keys(review.body), ['ok', 'account', 'firebaseRevocation']);
  const approved = await accountOf(env, 'Pending.Off');
  assert.deepEqual([approved.status, approved.hourlyRate, approved.staffRoles, approved.reviewRequestId], ['approved', 21, undefined, undefined], 'the old review ignores role and pay fields');
  const wrong = await signIn(env, 'Crew.Off', 'Wrong-Password-000');
  assert.deepEqual([wrong.status, wrong.body], [401, { ok: false, error: 'Incorrect username or password' }]);
  // A reset record left from a time the flag was on does not lock the password once it is off.
  const stored = await employeeInvitationStore(env).read('Crew.Off');
  await employeeInvitationStore(env).save({ ...stored.account, signInReset: { kind: 'staff_reset_v1', id: randomUUID(), tokenHash: '0'.repeat(64), issuedAt: new Date(START).toISOString(), expiresAt: new Date(START + 86400000).toISOString(), issuedBy: 'ZacB', consumedAt: '' } }, stored.version);
  assert.equal((await authenticateEmployeeAccount(env, 'Crew.Off', PASSWORD)).user, 'Crew.Off');
  assert.ok(await sessionOf(env, crew.cookie));
  assert.equal((await authenticateEmployeeAccount({ ...env, ...ON }, 'Crew.Off', PASSWORD).catch(error => error.code)), 'EMPLOYEE_ACCOUNT_RESET_PENDING');
  // Setup without the reset store: a reset-shaped link is invalid and the reset action does not exist.
  const service = createStaffInvitationService({ store: employeeInvitationStore(env), manifests: [], now: () => START });
  const invite = staffResetInvite('Crew.Off', 'A'.repeat(43));
  assert.equal((await setup(service, { action: 'inspect', invite })).status, 410);
  assert.deepEqual(await setup(service, { action: 'reset', invite, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD }), { status: 400, body: { error: 'Invalid request fields' } });
  // The directory has no first-rate floor or Apply rate.
  const directory = staffDirectoryHandlers({ now: () => new Date(START) });
  const person = (await get(directory, env, '/api/staff-directory?username=Crew.Off', owner)).body.people[0];
  assert.equal(person.pay.firstRateFrom, undefined);
  const preview = await post(directory, env, '/api/staff-directory', { action: 'preview_apply_rate', username: 'Crew.Off' }, owner);
  assert.deepEqual([preview.status, preview.body.code], [400, 'staff_directory_invalid_request']);
  const keys = [...fire.documents.keys()];
  // (The old review keeps recording its Firebase revocation state, as it did before this unit.)
  assert.equal(keys.some(key => /^(staffAccessOperations|payrollWeekExports|hub_audit)\//.test(key)), false, JSON.stringify(keys));
});
