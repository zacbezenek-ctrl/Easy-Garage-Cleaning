import test from 'node:test';
import assert from 'node:assert/strict';
import * as employeeHub from '../functions/api/employee-hub.js';
import { PAY_FIELDS, PAY_WRITE_FIELDS, assertNoOthersPay, payHidden, seesOthersPay, staffPayOwnerOnly, visiblePay } from '../functions/_lib/pay-visibility.js';
import { opaqueId, open } from '../functions/_lib/employee-vault.js';
import { vaultFirestore, staffEnv, cookieFor, seedAccount, login, jsonRequest } from './helpers/vault-fixture.mjs';

// PRICE-SCRUB: other employees' pay (payType, hourlyRate, timecard grossEstimate, bonus and
// tips) reaches the owner only. Managers keep hours and approvals; everyone keeps their own
// pay. EGC_STAFF_PAY_OWNER_ONLY=false restores the older rule. PAY-TIMESHEETS: a save carrying
// pay, or moving a timecard, that the caller may not make is refused (403 pay_owner_only).
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
  assert.deepEqual(visiblePay(MANAGER, {}, 'announcements', { id: 'a', bonus: 'not pay' }), { id: 'a', bonus: 'not pay' }, 'only profiles, timecards and time-off requests carry pay');
  assert.deepEqual(payHidden('timeEntries', { history: [null, { changes: null }] }), { history: [null, { changes: null }] });
});

// PAY-TIMESHEETS second review: a read hides every key the write guard treats as pay (PAY_WRITE_FIELDS), on time-off
// requests too, so a rate-like key the owner (or a manager under the older rules) stored is not handed to a manager.
test('another employee\'s profile, timecard or time-off request loses every rate-like pay key; the owner, the employee and the flag-off rule keep them', () => {
  const rates = Object.fromEntries(PAY_WRITE_FIELDS.map((key, index) => [key, 700 + index]));
  const rows = {
    profiles: { username: 'Crew.One', jobTitle: 'Crew', ...rates },
    timeEntries: { ...card, ...rates, history: [{ action: 'owner_update', changes: { ptoRate: { before: null, after: 704 }, hours: { before: 3, after: 4 } } }] },
    requests: { id: 'request-1', employee: 'Crew.One', type: 'time_off', status: 'approved', paidHoursPerDay: 8, paidWeekends: false, ...rates },
  };
  for (const [collection, row] of Object.entries(rows)) {
    const hidden = visiblePay(MANAGER, {}, collection, row);
    for (const key of new Set([...PAY_FIELDS, ...PAY_WRITE_FIELDS])) assert.equal(key in hidden, false, `${collection} ${key}`);
    assert.doesNotMatch(JSON.stringify(hidden), /"7\d\d"|:7\d\d\b/, `no canary rate in ${collection}`);
    assert.equal(visiblePay(OWNER, {}, collection, row), row);
    assert.equal(visiblePay({ ...CREW, user: 'crew.one' }, {}, collection, row), row, 'the employee sees their own');
    assert.equal(visiblePay(MANAGER, { EGC_STAFF_PAY_OWNER_ONLY: 'false' }, collection, row), row);
  }
  assert.deepEqual(visiblePay(MANAGER, {}, 'requests', rows.requests), { id: 'request-1', employee: 'Crew.One', type: 'time_off', status: 'approved', paidHoursPerDay: 8, paidWeekends: false }, 'paid time-off hours are hours, not pay, and stay');
  assert.deepEqual(visiblePay(MANAGER, {}, 'timeEntries', rows.timeEntries).history[0].changes, { hours: { before: 3, after: 4 } });
  assert.equal(visiblePay(MANAGER, {}, 'requests', { ...rows.requests, employee: 'tylerg' }).ptoRate, rates.ptoRate, 'a manager\'s own request keeps its pay');
});

test('a save to another employee\'s record by someone who cannot see its pay may carry no pay and may not move a timecard or time-off request; the owner and the flag-off rule may', () => {
  const incoming = { approvalStatus: 'approved', hourlyRate: 99, bonus: 999, tips: 5, grossEstimate: 1, payType: 'salary' };
  const refused = { status: 403, code: 'pay_owner_only' };
  assert.throws(() => assertNoOthersPay(MANAGER, {}, 'timeEntries', incoming), refused, 'pay on another employee\'s timecard');
  assert.throws(() => assertNoOthersPay(MANAGER, {}, 'profiles', { username: 'Crew.One', hourlyRate: 99, jobTitle: 'Lead' }), refused);
  assert.throws(() => assertNoOthersPay(MANAGER, {}, 'profiles', { username: 'Crew.One', hourlyRate: 21 }), refused, 'even the stored rate: the answer never depends on it');
  assert.throws(() => assertNoOthersPay(MANAGER, {}, 'requests', { employee: 'Crew.One', ptoRate: 30 }), refused);
  for (const key of PAY_WRITE_FIELDS) assert.throws(() => assertNoOthersPay(CREW, {}, 'timeEntries', { [key]: 1 }), refused, key);
  assert.doesNotThrow(() => assertNoOthersPay(MANAGER, {}, 'timeEntries', { approvalStatus: 'approved', grossEstimate: 1 }), 'hours and approvals only (grossEstimate is recomputed, never set)');
  assert.doesNotThrow(() => assertNoOthersPay(MANAGER, {}, 'requests', { status: 'approved', paidHoursPerDay: 8, paidWeekends: true }), 'paid time-off hours are hours, not a rate');
  // A stored timecard cannot change hands, whichever direction and whether or not the save carries pay.
  assert.throws(() => assertNoOthersPay(MANAGER, {}, 'timeEntries', { employee: 'TylerG', hourlyRate: 99 }, { moved: true }), refused, 'another employee\'s shift onto the manager');
  assert.throws(() => assertNoOthersPay(MANAGER, {}, 'timeEntries', { employee: 'TylerG' }, { moved: true }), refused);
  assert.throws(() => assertNoOthersPay(MANAGER, {}, 'timeEntries', { employee: 'Crew.One' }, { moved: true }), refused, 'nor the manager\'s own shift onto someone else');
  assert.throws(() => assertNoOthersPay(CREW, {}, 'timeEntries', { employee: 'Other' }, { moved: true }), refused);
  // Fourth check: a stored time-off request cannot change hands either (its pay and approved paid hours go with it).
  assert.throws(() => assertNoOthersPay(MANAGER, {}, 'requests', { employee: 'TylerG' }, { moved: true }), refused, 'another employee\'s time off onto the manager');
  assert.throws(() => assertNoOthersPay(MANAGER, {}, 'requests', { employee: 'Crew.One', status: 'approved', paidHoursPerDay: 8 }, { moved: true }), refused, 'nor the manager\'s own time off onto someone else');
  assert.throws(() => assertNoOthersPay(CREW, {}, 'requests', { employee: 'Other' }, { moved: true }), refused);
  assert.doesNotThrow(() => assertNoOthersPay(MANAGER, {}, 'profiles', { username: 'Crew.One' }, { moved: true }), 'a profile does not carry its pay to another employee (the handler refuses a rename onto another username itself)');
  // The owner, and everyone with the flag off, may do both.
  for (const [session, env] of [[OWNER, {}], [MANAGER, { EGC_STAFF_PAY_OWNER_ONLY: 'false' }], [CREW, { EGC_STAFF_PAY_OWNER_ONLY: 'false' }]]) {
    assert.doesNotThrow(() => assertNoOthersPay(session, env, 'timeEntries', incoming));
    assert.doesNotThrow(() => assertNoOthersPay(session, env, 'timeEntries', { employee: 'TylerG', hourlyRate: 99 }, { moved: true }));
    assert.doesNotThrow(() => assertNoOthersPay(session, env, 'requests', { employee: 'TylerG', ptoRate: 30 }, { moved: true }));
  }
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
  // PAY-TIMESHEETS: an approval that carries pay is refused whole (nothing is written); the approval without pay is saved.
  const before = s.fire.snapshot();
  const refused = await s.send(s.manager, 'timeEntries', 'shift-1', { approvalStatus: 'approved', hourlyRate: 99, bonus: 999, tips: 0 });
  assert.deepEqual([refused.status, (await refused.json()).code], [403, 'pay_owner_only']);
  assert.equal(s.fire.snapshot(), before, 'a refused approval writes nothing');
  const approved = await s.post(s.manager, 'timeEntries', 'shift-1', { approvalStatus: 'approved' });
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
// one between people in either direction; with the flag off they still can, as before. PAY-TIMESHEETS
// gives every pay refusal one code, pay_owner_only.
const refusedMove = async response => {
  assert.equal(response.status, 403, await response.clone().text());
  const body = await response.json();
  assert.deepEqual([body.ok, body.code], [false, 'pay_owner_only']);
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
  // The same person spelled differently is not a move, but it is still another employee's timecard: pay on it is refused,
  // and without pay the save goes through and still hides the pay.
  const withPay = await s.send(s.manager, 'timeEntries', 'shift-1', { employee: 'crew.account', bonus: 500 });
  assert.deepEqual([withPay.status, (await withPay.json()).code], [403, 'pay_owner_only']);
  assert.equal(s.fire.snapshot(), before, 'nothing was written');
  const respelled = await s.post(s.manager, 'timeEntries', 'shift-1', { employee: 'crew.account' });
  for (const field of PAY_FIELDS) assert.equal(field in respelled, false, field);
  assert.deepEqual([(await s.stored()).data.employee, (await s.stored()).data.bonus], ['crew.account', 15]);
});

test('HTTP: a manager cannot move their own timecard, or pay they set on it, onto a crew member', async t => {
  const s = await shift(t);
  // PAY-TIMESHEETS: with the flag on a manager cannot set their own pay either. A bonus on their own new timecard is refused;
  // the rate the form sends is replaced by the server rate (the Hub configuration's 30), as a crew clock-in snapshots it.
  const shiftTwo = { employee: 'TylerG', clockInAt: '2026-09-22T14:00:00.000Z', clockOutAt: '2026-09-22T18:00:00.000Z', status: 'submitted', approvalStatus: 'pending' };
  const bonus = await s.send(s.manager, 'timeEntries', 'shift-2', { ...shiftTwo, hourlyRate: 99, bonus: 500 });
  assert.deepEqual([bonus.status, (await bonus.json()).code], [403, 'pay_owner_only']);
  const own = await s.post(s.manager, 'timeEntries', 'shift-2', { ...shiftTwo, hourlyRate: 99 });
  assert.deepEqual([own.employee, own.hourlyRate, own.bonus, own.grossEstimate], ['TylerG', 30, undefined, 120], 'the manager\'s own new timecard carries the server rate');
  const before = s.fire.snapshot();
  await refusedMove(await s.send(s.manager, 'timeEntries', 'shift-2', { employee: 'Crew.Account', bonus: 500, hourlyRate: 99 }));
  await refusedMove(await s.send(s.manager, 'timeEntries', 'shift-2', { employee: 'Crew.Account' }));
  assert.equal(s.fire.snapshot(), before, 'nothing was written');
  const saved = await s.stored('shift-2');
  assert.deepEqual([saved.data.employee, saved.data.hourlyRate, saved.data.bonus], ['TylerG', 30, undefined]);
  const crewView = (await s.get(s.crew)).collections.timeEntries.map(row => row.id);
  assert.deepEqual(crewView, ['shift-1'], 'the crew member has no timecard carrying the manager\'s pay');
  const ownerView = (await s.get(s.owner)).collections.timeEntries.find(row => row.id === 'shift-1');
  assert.deepEqual([ownerView.employee, ownerView.hourlyRate, ownerView.bonus, ownerView.grossEstimate], ['Crew.Account', 21, 15, 84], 'the crew member\'s pay is unchanged');
});

// PRICE-SCRUB asserted "nor a shift with no stored employee" on its incomingPay helper; that helper is gone, so the same
// rule is checked here end to end: claiming a timecard nobody owns is a move, and its pay would move with it.
test('HTTP: a manager cannot claim a timecard with no employee, or read the pay the owner stored on it', async t => {
  const s = await shift(t);
  // Canaries no hour count, id or timestamp contains.
  const RATE = 44.47, BONUS = 12.37;
  const orphan = await s.post(s.owner, 'timeEntries', 'orphan', { employeeName: 'Synthetic nobody', clockInAt: '2026-09-21T14:00:00.000Z', clockOutAt: '2026-09-21T18:00:00.000Z', status: 'submitted', approvalStatus: 'pending', hourlyRate: RATE, bonus: BONUS });
  assert.deepEqual([orphan.employee, orphan.hourlyRate, orphan.bonus], [undefined, RATE, BONUS], 'precondition: the owner stored pay on a timecard with no employee');
  const before = s.fire.snapshot();
  for (const employee of ['TylerG', ' tylerg ']) {
    const response = await s.send(s.manager, 'timeEntries', 'orphan', { employee });
    const text = await response.clone().text();
    await refusedMove(response);
    for (const value of [RATE, BONUS]) assert.equal(text.includes(String(value)), false, `${JSON.stringify(employee)}: ${value} is not in the answer`);
  }
  assert.equal(s.fire.snapshot(), before, 'nothing was written');
  const saved = await s.stored('orphan');
  assert.deepEqual([saved.data.employee, saved.data.hourlyRate, saved.data.bonus], [undefined, RATE, BONUS]);
  const seen = (await s.get(s.manager)).collections.timeEntries.find(row => row.id === 'orphan');
  assert.ok(seen, 'the manager still sees the timecard\'s hours');
  for (const field of PAY_FIELDS) assert.equal(field in seen, false, field);
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
