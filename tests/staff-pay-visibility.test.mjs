import test from 'node:test';
import assert from 'node:assert/strict';
import * as employeeHub from '../functions/api/employee-hub.js';
import { PAY_FIELDS, incomingPay, payHidden, seesOthersPay, staffPayOwnerOnly, visiblePay } from '../functions/_lib/pay-visibility.js';
import { opaqueId, open } from '../functions/_lib/employee-vault.js';
import { vaultFirestore, staffEnv, cookieFor, seedAccount, login, jsonRequest } from './helpers/vault-fixture.mjs';

// PRICE-SCRUB: other employees' pay (payType, hourlyRate, timecard grossEstimate, bonus and
// tips) reaches the owner only. Managers keep hours and approvals; everyone keeps their own
// pay. EGC_STAFF_PAY_OWNER_ONLY=false restores the older rule.
const NOW = '2026-09-22T14:00:00.000Z';
const OWNER = { user: 'ZacB', role: 'owner', businessAccess: true }, MANAGER = { user: 'TylerG', role: 'manager', businessAccess: true }, CREW = { user: 'Crew.One', role: 'crew', businessAccess: false };
const card = { id: 'shift-1', employee: 'Crew.One', clockInAt: NOW, hours: 4, approvalStatus: 'pending', payType: 'hourly', hourlyRate: 21, grossEstimate: 84, bonus: 15, tips: 10,
  history: [{ action: 'manager_timecard_update', actor: 'ZacB', at: NOW, changes: { bonus: { before: null, after: 15 }, approvalStatus: { before: 'open', after: 'pending' } } }] };

test('the rule: owner-only by default, the pay.manage capability decides, and the flag restores manager pay', () => {
  assert.equal(staffPayOwnerOnly({}), true);
  assert.equal(staffPayOwnerOnly({ EGC_STAFF_PAY_OWNER_ONLY: 'true' }), true);
  assert.equal(staffPayOwnerOnly({ EGC_STAFF_PAY_OWNER_ONLY: 'False' }), true, 'only exactly "false" opens pay to managers');
  assert.deepEqual([seesOthersPay(OWNER, {}), seesOthersPay(MANAGER, {}), seesOthersPay(CREW, {})], [true, false, false]);
  assert.deepEqual([seesOthersPay(MANAGER, { EGC_STAFF_PAY_OWNER_ONLY: 'false' }), seesOthersPay({ ...MANAGER, staffRoles: ['owner'] }, { EGC_STAFF_ROLE_PERMISSIONS: 'true' })], [true, false], 'stored roles cannot grant the owner\'s pay capability');
  assert.deepEqual(PAY_FIELDS, ['payType', 'hourlyRate', 'grossEstimate', 'bonus', 'tips']);
});

test('another employee\'s timecard keeps its hours and approval but loses every pay figure, including the audit history', () => {
  const hidden = visiblePay(MANAGER, {}, 'timeEntries', card);
  for (const field of PAY_FIELDS) assert.equal(field in hidden, false, field);
  assert.deepEqual([hidden.hours, hidden.approvalStatus, hidden.clockInAt], [4, 'pending', NOW]);
  assert.deepEqual(hidden.history[0].changes, { approvalStatus: { before: 'open', after: 'pending' } });
  assert.equal(card.history[0].changes.bonus.after, 15, 'the stored record is not modified');
  assert.equal(visiblePay(OWNER, {}, 'timeEntries', card), card);
  assert.equal(visiblePay({ ...CREW, user: 'crew.one' }, {}, 'timeEntries', card), card, 'the employee sees their own pay');
  assert.equal(visiblePay(MANAGER, { EGC_STAFF_PAY_OWNER_ONLY: 'false' }, 'timeEntries', card), card);
  assert.deepEqual(visiblePay(MANAGER, {}, 'profiles', { username: 'Crew.One', hourlyRate: 21, payType: 'hourly', jobTitle: 'Crew' }), { username: 'Crew.One', jobTitle: 'Crew' });
  assert.deepEqual(visiblePay(MANAGER, {}, 'profiles', { username: 'tylerg', hourlyRate: 30 }), { username: 'tylerg', hourlyRate: 30 });
  assert.deepEqual(visiblePay(MANAGER, {}, 'announcements', { id: 'a', bonus: 'not pay' }), { id: 'a', bonus: 'not pay' }, 'only profiles and timecards carry pay');
  assert.deepEqual(payHidden('timeEntries', { history: [null, { changes: null }] }), { history: [null, { changes: null }] });
});

test('a save by someone who cannot see another employee\'s pay cannot set it; their own and the owner\'s saves are unchanged', () => {
  const incoming = { approvalStatus: 'approved', hourlyRate: 99, bonus: 999, tips: 5, grossEstimate: 1, payType: 'salary' };
  assert.deepEqual(incomingPay(MANAGER, {}, 'timeEntries', incoming, card), { approvalStatus: 'approved' });
  assert.deepEqual(incomingPay(MANAGER, {}, 'profiles', { username: 'Crew.One', hourlyRate: 99, jobTitle: 'Lead' }, null), { username: 'Crew.One', jobTitle: 'Lead' });
  assert.equal(incomingPay(MANAGER, {}, 'profiles', incoming, { username: 'TylerG' }), incoming);
  assert.equal(incomingPay(MANAGER, {}, 'timeEntries', incoming, { employee: 'tylerg' }), incoming);
  assert.equal(incomingPay(OWNER, {}, 'timeEntries', incoming, card), incoming);
  assert.equal(incomingPay(MANAGER, { EGC_STAFF_PAY_OWNER_ONLY: 'false' }, 'timeEntries', incoming, card), incoming);
  // The stored owner and the owner after the save both decide, and a stored timecard cannot change hands.
  const moved = { status: 403, code: 'EMPLOYEE_HUB_PAY_OWNER_ONLY' };
  assert.throws(() => incomingPay(MANAGER, {}, 'timeEntries', { employee: 'TylerG', hourlyRate: 99 }, card), moved, 'another employee\'s shift cannot be moved onto the manager');
  assert.throws(() => incomingPay(MANAGER, {}, 'timeEntries', { employee: 'TylerG' }, card), moved);
  assert.throws(() => incomingPay(MANAGER, {}, 'timeEntries', { employee: 'Crew.One', bonus: 500 }, { employee: 'TylerG' }), moved, 'nor the manager\'s own shift onto someone else');
  assert.throws(() => incomingPay(MANAGER, {}, 'timeEntries', { employee: 'TylerG' }, { hourlyRate: 21 }), moved, 'nor a shift with no stored employee');
  assert.throws(() => incomingPay(CREW, {}, 'timeEntries', { employee: 'Other' }, card), moved);
  assert.deepEqual(incomingPay(MANAGER, {}, 'timeEntries', { employee: ' crew.one ', hourlyRate: 99 }, card), { employee: ' crew.one ' }, 'the same person in another spelling is not a move');
  assert.equal(incomingPay(OWNER, {}, 'timeEntries', { employee: 'TylerG', hourlyRate: 99 }, card).hourlyRate, 99, 'the owner may move a timecard');
  assert.equal(incomingPay(MANAGER, { EGC_STAFF_PAY_OWNER_ONLY: 'false' }, 'timeEntries', { employee: 'TylerG', hourlyRate: 99 }, card).hourlyRate, 99);
  assert.deepEqual(incomingPay(MANAGER, {}, 'timeEntries', { employee: 'Crew.One', hourlyRate: 99 }, null), { employee: 'Crew.One' }, 'a new timecard for someone else carries no pay');
  assert.deepEqual(incomingPay(MANAGER, {}, 'timeEntries', { hourlyRate: 99 }, null), {}, 'nor a new timecard for nobody');
  const own = { employee: 'tylerg', hourlyRate: 30 };
  assert.equal(incomingPay(MANAGER, {}, 'timeEntries', own, null), own);
  assert.deepEqual(incomingPay(MANAGER, {}, 'profiles', { username: 'Crew.One', hourlyRate: 99 }, { username: 'TylerG' }), { username: 'Crew.One' }, 'a profile save counts as the user\'s own only if it stays theirs');
});

async function shift(t) {
  const fire = vaultFirestore(t), env = staffEnv();
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-22T14:00:00.000Z') });
  await seedAccount(env, 'Crew.Account');
  const { cookie: crew } = await login(env, 'Crew.Account'), owner = await cookieFor(env, 'ZacB'), manager = await cookieFor(env, 'TylerG');
  const send = (cookie, collection, id, data, hubEnv = env) => employeeHub.onRequestPost({ env: hubEnv, request: jsonRequest('/api/employee-hub', { collection, id, data }, cookie) });
  const post = async (cookie, collection, id, data, hubEnv = env) => {
    const response = await send(cookie, collection, id, data, hubEnv);
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).record;
  };
  const get = async (cookie, hubEnv = env) => {
    const response = await employeeHub.onRequestGet({ env: hubEnv, request: jsonRequest('/api/employee-hub', undefined, cookie) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  await post(crew, 'timeEntries', 'shift-1', { locationTracking: true, lastLocation: { lat: 40.58, lng: -105.08, accuracy: 5 } });
  t.mock.timers.setTime(Date.parse('2026-09-22T18:00:00.000Z'));
  await post(crew, 'timeEntries', 'shift-1', { clockOutAt: 'now', status: 'submitted' });
  await post(owner, 'timeEntries', 'shift-1', { bonus: 15, tips: 10 });
  const stored = async (id = 'shift-1') => { const documentId = await opaqueId(env, 'timeEntries', id), doc = fire.documents.get(`jobs/${documentId}`); return { data: await open(env, documentId, doc.fields.sealedIv.stringValue, doc.fields.sealedPayload.stringValue) }; };
  return { env, fire, crew, owner, manager, send, post, get, stored };
}

test('HTTP: the owner and the employee read the pay; a manager reads the same shift and profile without it', async t => {
  const s = await shift(t);
  const owner = await s.get(s.owner), manager = await s.get(s.manager), crew = await s.get(s.crew);
  assert.deepEqual([owner.payVisibility, manager.payVisibility, crew.payVisibility], ['all', 'own', 'own']);
  const entry = body => body.collections.timeEntries.find(row => row.id === 'shift-1');
  for (const body of [owner, crew]) assert.deepEqual([entry(body).hourlyRate, entry(body).grossEstimate, entry(body).bonus, entry(body).tips], [21, 84, 15, 10]);
  const seen = entry(manager);
  assert.deepEqual([seen.hours, seen.approvalStatus, seen.employee], [4, 'pending', 'Crew.Account'], 'hours and approval stay visible');
  for (const field of PAY_FIELDS) assert.equal(field in seen, false, field);
  assert.ok(seen.history.length > 0);
  assert.doesNotMatch(JSON.stringify(seen.history), /"(?:bonus|tips|hourlyRate|grossEstimate)"/);
  const profile = body => body.collections.profiles.find(row => row.username === 'Crew.Account');
  assert.equal(profile(owner).hourlyRate, 21);
  assert.equal('hourlyRate' in profile(manager) || 'payType' in profile(manager), false);
  assert.equal(manager.collections.profiles.find(row => row.username === 'TylerG').hourlyRate, 30, 'a manager still sees their own pay');
  assert.doesNotMatch(JSON.stringify(manager.collections.timeEntries.filter(row => row.employee !== 'TylerG')), /"(?:bonus|tips|hourlyRate|grossEstimate|payType)"/);
});

test('HTTP: a manager approves another employee\'s time without seeing or changing its pay', async t => {
  const s = await shift(t);
  const approved = await s.post(s.manager, 'timeEntries', 'shift-1', { approvalStatus: 'approved', hourlyRate: 99, bonus: 999, tips: 0 });
  assert.equal(approved.approvalStatus, 'approved');
  for (const field of PAY_FIELDS) assert.equal(field in approved, false, `the reply hides ${field}`);
  const saved = await s.stored();
  assert.deepEqual([saved.data.approvalStatus, saved.data.approvedBy, saved.data.hourlyRate, saved.data.bonus, saved.data.tips, saved.data.grossEstimate], ['approved', 'TylerG', 21, 15, 10, 84]);
});

test('HTTP: with EGC_STAFF_PAY_OWNER_ONLY=false managers see and set other employees\' pay as before', async t => {
  const s = await shift(t), legacy = { ...s.env, EGC_STAFF_PAY_OWNER_ONLY: 'false' };
  const body = await s.get(s.manager, legacy);
  assert.equal(body.payVisibility, 'all');
  assert.equal(body.collections.timeEntries.find(row => row.id === 'shift-1').bonus, 15);
  assert.equal((await s.post(s.manager, 'timeEntries', 'shift-1', { bonus: 20 }, legacy)).bonus, 20);
  assert.equal((await s.stored()).data.bonus, 20);
});

// Second review: stored pay follows a timecard, so a manager without pay visibility cannot move
// one between people in either direction; with the flag off they still can, as before.
const refusedMove = async response => {
  assert.equal(response.status, 403, await response.clone().text());
  const body = await response.json();
  assert.deepEqual([body.ok, body.code], [false, 'EMPLOYEE_HUB_PAY_OWNER_ONLY']);
  assert.doesNotMatch(JSON.stringify(body), /"(?:bonus|tips|hourlyRate|grossEstimate|payType)"/);
};

test('HTTP: a manager cannot move another employee\'s timecard onto themselves to read its pay', async t => {
  const s = await shift(t), before = s.fire.snapshot();
  await refusedMove(await s.send(s.manager, 'timeEntries', 'shift-1', { employee: 'TylerG' }));
  await refusedMove(await s.send(s.manager, 'timeEntries', 'shift-1', { employee: 'tylerg', approvalStatus: 'approved' }));
  assert.equal(s.fire.snapshot(), before, 'nothing was written');
  const seen = (await s.get(s.manager)).collections.timeEntries.find(row => row.id === 'shift-1');
  assert.equal(seen.employee, 'Crew.Account');
  for (const field of PAY_FIELDS) assert.equal(field in seen, false, field);
  assert.doesNotMatch(JSON.stringify(seen.history), /"(?:bonus|tips|hourlyRate|grossEstimate)"/);
  const saved = await s.stored();
  assert.deepEqual([saved.data.employee, saved.data.hourlyRate, saved.data.bonus, saved.data.tips, saved.data.grossEstimate], ['Crew.Account', 21, 15, 10, 84]);
  // The same person spelled differently is not a move: the save goes through and still hides the pay.
  const respelled = await s.post(s.manager, 'timeEntries', 'shift-1', { employee: 'crew.account', bonus: 500 });
  for (const field of PAY_FIELDS) assert.equal(field in respelled, false, field);
  assert.deepEqual([(await s.stored()).data.employee, (await s.stored()).data.bonus], ['crew.account', 15]);
});

test('HTTP: a manager cannot move their own timecard, or pay they set on it, onto a crew member', async t => {
  const s = await shift(t);
  const own = await s.post(s.manager, 'timeEntries', 'shift-2', { employee: 'TylerG', clockInAt: '2026-09-22T14:00:00.000Z', clockOutAt: '2026-09-22T18:00:00.000Z', status: 'submitted', approvalStatus: 'pending', hourlyRate: 99, bonus: 500 });
  assert.deepEqual([own.employee, own.hourlyRate, own.bonus, own.grossEstimate], ['TylerG', 99, 500, 396], 'the manager\'s own timecard follows the older rules');
  const before = s.fire.snapshot();
  await refusedMove(await s.send(s.manager, 'timeEntries', 'shift-2', { employee: 'Crew.Account', bonus: 500, hourlyRate: 99 }));
  await refusedMove(await s.send(s.manager, 'timeEntries', 'shift-2', { employee: 'Crew.Account' }));
  assert.equal(s.fire.snapshot(), before, 'nothing was written');
  const saved = await s.stored('shift-2');
  assert.deepEqual([saved.data.employee, saved.data.hourlyRate, saved.data.bonus], ['TylerG', 99, 500]);
  const crewView = (await s.get(s.crew)).collections.timeEntries.map(row => row.id);
  assert.deepEqual(crewView, ['shift-1'], 'the crew member has no timecard carrying the manager\'s pay');
  const ownerView = (await s.get(s.owner)).collections.timeEntries.find(row => row.id === 'shift-1');
  assert.deepEqual([ownerView.employee, ownerView.hourlyRate, ownerView.bonus, ownerView.grossEstimate], ['Crew.Account', 21, 15, 84], 'the crew member\'s pay is unchanged');
});

test('HTTP: the owner may move a timecard, and with EGC_STAFF_PAY_OWNER_ONLY=false a manager still may', async t => {
  const s = await shift(t), legacy = { ...s.env, EGC_STAFF_PAY_OWNER_ONLY: 'false' };
  const moved = await s.post(s.manager, 'timeEntries', 'shift-1', { employee: 'TylerG' }, legacy);
  assert.deepEqual([moved.employee, moved.hourlyRate, moved.bonus], ['TylerG', 21, 15], 'today\'s behaviour with the flag off');
  const back = await s.post(s.owner, 'timeEntries', 'shift-1', { employee: 'Crew.Account', bonus: 20 });
  assert.deepEqual([back.employee, back.bonus], ['Crew.Account', 20]);
  const saved = await s.stored();
  assert.deepEqual([saved.data.employee, saved.data.hourlyRate, saved.data.bonus], ['Crew.Account', 21, 20]);
});
