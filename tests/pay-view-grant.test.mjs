// PAY-VIEW-GRANT: EGC_STAFF_PAY_VIEWERS lets the owner show other employees' pay to named business accounts while pay
// stays owner-only for everyone else. Viewing only: setting pay, moving pay, the payroll CSV, the Gusto file and job labor
// dollars stay the owner's. Synthetic accounts and canary rates only.
process.env.TZ = 'Asia/Tokyo';
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoOthersPay, assertPayUnchanged, canSetPay, payViewGranted, seesLaborCost, seesOthersPay, timesheetPayView, visiblePay } from '../functions/_lib/pay-visibility.js';
import { computeTimesheetWeek, ptoFromRequests } from '../functions/_lib/timesheet-week.js';
import { timesheetHandlers } from '../functions/api/timesheets.js';
import { createHubSessionToken, verifyHubSessionToken } from '../functions/_lib/hub-session.js';
import { staffEnv } from './helpers/vault-fixture.mjs';

// A signed-in account outside the configured business users, as the Hub builds it: owner-set staff roles in the user
// list, verified through a real session token. With the Manager role it has business access (EGC_STAFF_ROLE_ACCESS).
const ROLE_ACCESS = { EGC_STAFF_ROLE_ACCESS: 'true' };
async function signedIn(user, staffRoles) {
  const env = staffEnv(ROLE_ACCESS, { [user]: { passwordHash: 'unused-synthetic-hash', role: 'crew', displayName: `Synthetic ${user}`, staffRoles } });
  return verifyHubSessionToken(env, await createHubSessionToken(env, user));
}

const OWNER = { user: 'ZacB', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
const LEAD = await signedIn('Pay.Viewer', ['manager']);
const OTHER = { user: 'AlexK', displayName: 'Synthetic Manager', role: 'crew_lead', businessAccess: true };
const CREW = { user: 'Crew.One', displayName: 'Synthetic Crew', role: 'crew' };
const GRANT = { ...ROLE_ACCESS, EGC_STAFF_PAY_VIEWERS: ' pay.viewer , crew.one ' };
const NOW = new Date('2026-10-05T18:00:00.000Z');
const at = (date, time) => `${date}T${time}:00-06:00`;
const card = (id, employee, date, rate) => ({ id, employee, employeeName: `Synthetic ${employee}`, payType: 'hourly', hourlyRate: rate, clockInAt: at(date, '08:00'), clockOutAt: at(date, '12:00'), status: 'submitted', approvalStatus: 'approved', breaks: [] });
const CARDS = [card('a', 'Crew.One', '2026-09-21', 37.13), card('b', 'Pay.Viewer', '2026-09-22', 41.23), card('c', 'AlexK', '2026-09-23', 43.29)];
const week = () => computeTimesheetWeek({ timecards: CARDS, pto: ptoFromRequests([]), weekStart: '2026-09-21', now: NOW.toISOString() });
const get = async (session, query, env) => {
  const response = await timesheetHandlers({ session: async () => session, read: async () => ({ timecards: CARDS, requests: [] }), now: () => NOW }).get({ request: new Request(`https://easygaragecleaning.com/api/timesheets${query}`), env });
  return { status: response.status, text: await response.text() };
};

test('a listed business account sees other employees\' pay; unlisted managers, unlisted names and crew do not', () => {
  assert.equal(payViewGranted(LEAD, GRANT), true, 'names are matched without case or spaces');
  assert.equal(seesOthersPay(LEAD, GRANT), true);
  assert.equal(seesOthersPay(OTHER, GRANT), false, 'another manager keeps the owner-only rule');
  assert.equal(seesOthersPay(CREW, GRANT), false, 'a listed account without business access gets nothing');
  assert.equal(seesOthersPay(LEAD, {}), false, 'unset: only the owner');
  assert.equal(payViewGranted(LEAD, { ...GRANT, EGC_STAFF_PAY_OWNER_ONLY: 'false' }), false, 'the list does nothing with the flag off');
  const timecard = card('x', 'Crew.One', '2026-09-21', 37.13);
  assert.equal(visiblePay(LEAD, GRANT, 'timeEntries', timecard).hourlyRate, 37.13);
  assert.equal(visiblePay(OTHER, GRANT, 'timeEntries', timecard).hourlyRate, undefined);
});

test('the grant is viewing only: no pay change, no pay move, no labor dollars', () => {
  assert.equal(canSetPay(LEAD, GRANT), false);
  assert.equal(seesLaborCost(LEAD, GRANT), false, 'job labor dollars stay with whoever sets pay');
  assert.throws(() => assertNoOthersPay(LEAD, GRANT, 'timeEntries', { hourlyRate: 50 }), { code: 'pay_owner_only' });
  assert.throws(() => assertNoOthersPay(LEAD, GRANT, 'timeEntries', { approvalStatus: 'approved' }, { moved: true }), { code: 'pay_owner_only' });
  assert.throws(() => assertPayUnchanged(LEAD, GRANT, { hourlyRate: 99 }, { hourlyRate: 41.23 }), { code: 'pay_owner_only' });
  assert.equal(canSetPay(OWNER, GRANT), true, 'the owner is unchanged');
});

test('/api/timesheets: the listed account gets the owner\'s week, but never the payroll CSV or the Gusto file', async () => {
  const owner = await get(OWNER, '?view=week&start=2026-09-21', GRANT), lead = await get(LEAD, '?view=week&start=2026-09-21', GRANT), other = await get(OTHER, '?view=week&start=2026-09-21', GRANT);
  assert.equal(lead.status, 200);
  assert.deepEqual(JSON.parse(lead.text), { ...JSON.parse(owner.text), payVisibility: 'view' }, 'the same week the owner sees, pay included, marked view-only');
  assert.equal(JSON.parse(owner.text).payVisibility, undefined, 'the owner\'s answer is unchanged');
  assert.deepEqual(JSON.parse(lead.text), { ok: true, ...timesheetPayView(LEAD, GRANT, week()) });
  assert.equal(JSON.parse(other.text).payVisibility, 'own', 'an unlisted manager still sees only their own pay');
  for (const query of ['?view=week&start=2026-09-21&format=csv', '?view=week&start=2026-09-21&format=gusto']) {
    const refused = await get(LEAD, query, GRANT);
    assert.deepEqual([refused.status, JSON.parse(refused.text).code], [403, 'pay_owner_only'], query);
  }
});

test('the grant needs the Manager role as well as business access: a listed crew lead or sales account sees no one else\'s pay', async () => {
  // AlexK is a configured business user acting as crew_lead in this fixture; Sales.Viewer holds a stored sales role.
  const listed = { ...GRANT, EGC_STAFF_PAY_VIEWERS: 'pay.viewer,alexk,sales.viewer' };
  for (const session of [OTHER, await signedIn('Sales.Viewer', ['sales'])]) {
    assert.equal(payViewGranted(session, listed), false, session.user);
    assert.equal(seesOthersPay(session, listed), false, session.user);
  }
  assert.equal(payViewGranted(LEAD, listed), true);
});

// The real /api/employee-hub over the encrypted vault, for a stored-role manager (outside the configured business
// users) named in the list, a listed stored crew lead, and the owner: pay on timecards and profiles, the accounts list,
// and the paySet bit that tells the Hub whether to offer rate fields.
test('/api/employee-hub: a listed stored-role manager reads everyone\'s pay with paySet false; a listed crew lead and the accounts list follow the rules', async t => {
  const { vaultFirestore, cookieFor, seedAccount } = await import('./helpers/vault-fixture.mjs');
  const { writeOne } = await import('../functions/_lib/employee-vault.js');
  const { onRequestGet } = await import('../functions/api/employee-hub.js');
  vaultFirestore(t);
  const env = staffEnv({ ...ROLE_ACCESS, EGC_STAFF_PAY_VIEWERS: 'pay.viewer,lead.viewer', EGC_STAFF_PASSWORD_RESET: 'true', EGC_STAFF_MANAGER_GRANTS: 'accounts.approve' }, {
    'Pay.Viewer': { passwordHash: 'unused-synthetic-hash', role: 'crew', displayName: 'Synthetic Pay Viewer', staffRoles: ['manager'] },
    'Lead.Viewer': { passwordHash: 'unused-synthetic-hash', role: 'crew', displayName: 'Synthetic Lead Viewer', staffRoles: ['crew_lead'] } });
  const stamp = '2026-10-05T18:00:00.000Z';
  await writeOne(env, 'timeEntries', 'crew-card', card('crew-card', 'Crew.Static', '2026-09-21', 37.13), null, stamp);
  await writeOne(env, 'profiles', 'crew.static', { username: 'Crew.Static', displayName: 'Synthetic Static Crew', hourlyRate: 37.13, payType: 'hourly' }, null, stamp);
  await seedAccount(env, 'Signup.Pending', { status: 'pending' });
  const read = async (user, query = '') => (await onRequestGet({ env, request: new Request(`https://easygaragecleaning.com/api/employee-hub${query}`, { headers: { Cookie: await cookieFor(env, user) } }) })).json();

  const viewer = await read('Pay.Viewer');
  assert.deepEqual([viewer.ok, viewer.payVisibility, viewer.paySet], [true, 'all', false]);
  assert.equal(viewer.collections.timeEntries.find(row => row.id === 'crew-card').hourlyRate, 37.13);
  assert.equal(viewer.collections.profiles.find(row => row.username === 'Crew.Static').hourlyRate, 37.13);
  const accounts = await read('Pay.Viewer', '?include=accounts');
  assert.equal(accounts.ok, true, JSON.stringify(accounts).slice(0, 200));
  assert.ok(accounts.accounts.some(row => row.username === 'Signup.Pending' && row.hourlyRate === 21), 'the accounts list shows pay to a listed viewer');

  const lead = await read('Lead.Viewer');
  assert.equal(lead.paySet, false);
  assert.notEqual(lead.payVisibility, 'all', 'a listed crew lead is not a manager');
  assert.equal(JSON.stringify(lead).includes('37.13'), false, 'and sees no one else\'s pay');

  const owner = await read('ZacB');
  assert.deepEqual([owner.payVisibility, owner.paySet], ['all', true]);
});

test('with staff-role permissions on, stored roles decide: a business account configured as manager but stored as crew_lead gets no grant', () => {
  const roles = { ...GRANT, EGC_STAFF_ROLE_PERMISSIONS: 'true', EGC_STAFF_PAY_VIEWERS: 'tylerg' };
  const storedLead = { user: 'TylerG', displayName: 'Synthetic Manager', role: 'manager', businessAccess: true, staffRoles: ['crew_lead'] };
  assert.equal(payViewGranted(storedLead, roles), false, 'stored roles, not the configured role, decide');
  assert.equal(seesOthersPay(storedLead, roles), false);
  assert.equal(payViewGranted({ ...storedLead, staffRoles: ['manager'] }, roles), true, 'the same account stored as a manager is granted');
});
