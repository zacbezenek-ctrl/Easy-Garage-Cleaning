process.env.TZ = 'Asia/Tokyo';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as payVisibility from '../functions/_lib/pay-visibility.js';
import { PAY_FIELDS, PAY_WRITE_FIELDS, assertNoOthersPay, canSeePay, canSetPay, changedPay, payChangeRefused, payOwnerField, payOwnerOnly, payWriteFields, samePay, seesOthersPay, staffPayOwnerOnly, timesheetPayView, visiblePay, withoutPayWrites } from '../functions/_lib/pay-visibility.js';
import { computeTimesheetWeek, ptoFromRequests } from '../functions/_lib/timesheet-week.js';
import { payrollCsv } from '../functions/_lib/payroll-export.js';
import { timesheetHandlers } from '../functions/api/timesheets.js';
import * as employeeHub from '../functions/api/employee-hub.js';
import * as employeePto from '../functions/api/employee-pto.js';
import { opaqueId, open, readOne, writeOne } from '../functions/_lib/employee-vault.js';
import { vaultFirestore, staffEnv, cookieFor, jsonRequest } from './helpers/vault-fixture.mjs';

const NOW = new Date('2026-10-05T18:00:00.000Z');
const at = (date, time) => `${date}T${time}:00-06:00`;
// Canary pay: rates, bonus and tips no hour count can equal, so any leaked amount is recognizable.
const card = (id, employee, name, date, from, to, extra = {}) => ({ id, employee, employeeName: name, payType: 'hourly', clockInAt: at(date, from), clockOutAt: at(date, to), status: 'submitted', approvalStatus: 'approved', breaks: [], ...extra });
const CARDS = [
  card('crew-mon', 'Crew.One', 'Synthetic Crew', '2026-09-21', '06:00', '20:00', { hourlyRate: 37.13, bonus: 11.17, tips: 13.19 }),
  card('crew-tue', 'Crew.One', 'Synthetic Crew', '2026-09-22', '08:00', '16:30', { hourlyRate: 37.13 }),
  card('tyler-wed', 'TylerG', 'Synthetic Manager', '2026-09-23', '08:00', '12:00', { hourlyRate: 41.23 }),
  card('alex-thu', 'AlexK', 'Synthetic Lead', '2026-09-24', '09:00', '13:00', { hourlyRate: 43.29 }),
  card('sales-thu', 'Sales.One', 'Synthetic Sales', '2026-09-24', '10:00', '14:00', { hourlyRate: 29.71, tips: 7.77 }),
];
const REQUESTS = [{ id: 'pto-fri', type: 'time_off', status: 'approved', employee: 'Crew.One', startDate: '2026-09-25', endDate: '2026-09-25', paidHoursPerDay: 8 }];
const ROLE = {
  owner: { user: 'ZacB', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true },
  manager: { user: 'TylerG', displayName: 'Synthetic Manager', role: 'manager', businessAccess: true },
  crew_lead: { user: 'AlexK', displayName: 'Synthetic Lead', role: 'crew_lead', businessAccess: true },
  crew_lead_field: { user: 'Lead.One', displayName: 'Synthetic Field Lead', role: 'crew_lead' },
  crew: { user: 'Crew.One', displayName: 'Synthetic Crew', role: 'crew' },
  sales: { user: 'Sales.One', displayName: 'Synthetic Sales', role: 'sales' },
};
const OFF = { EGC_STAFF_PAY_OWNER_ONLY: 'false' };
const ROW_PAY = ['regularRate', 'straightPay', 'overtimePremium', 'ptoPay', 'bonus', 'tips', 'grossPay'];
const week = (options = {}) => computeTimesheetWeek({ timecards: CARDS, pto: ptoFromRequests(REQUESTS), weekStart: '2026-09-21', now: NOW.toISOString(), ...options });
const request = query => new Request(`https://easygaragecleaning.com/api/timesheets${query}`);
const get = async (session, query, env = {}, read = async () => ({ timecards: CARDS, requests: REQUESTS })) => {
  const response = await timesheetHandlers({ session: async () => session, read, now: () => NOW }).get({ request: request(query), env });
  return { response, text: await response.text() };
};
const numbers = value => Array.isArray(value) ? value.flatMap(numbers) : value && typeof value === 'object' ? Object.values(value).flatMap(numbers) : typeof value === 'number' ? [value] : [];
// Every nonzero pay amount of employees other than `viewer`, as the owner sees them.
function canaries(viewer) {
  const full = week(), values = new Set();
  for (const row of full.employees.filter(row => row.employee !== viewer.toLowerCase())) {
    for (const key of ROW_PAY) if (row[key]) values.add(row[key]);
    for (const item of row.timecards) for (const key of ['hourlyRate', 'bonus', 'tips']) if (item[key]) values.add(item[key]);
  }
  for (const key of ['straightPay', 'overtimePremium', 'ptoPay', 'bonus', 'tips', 'grossPay']) if (full.totals[key]) values.add(full.totals[key]);
  return values;
}
function assertNoCanary(text, viewer, label) {
  const secret = canaries(viewer), parsed = (() => { try { return JSON.parse(text); } catch { return null; } })();
  for (const value of secret) assert.equal(text.includes(String(value)), false, `${label}: ${value} leaked`);
  if (parsed) assert.deepEqual(numbers(parsed).filter(value => secret.has(value)), [], label);
}

test('the flag is on unless exactly "false", and only the owner sees and sets everyone\'s pay', () => {
  for (const value of [undefined, '', 'true', 'FALSE', 'False', '0', 'off', 'no', ' false']) assert.equal(payOwnerOnly({ EGC_STAFF_PAY_OWNER_ONLY: value }), true, String(value));
  assert.equal(payOwnerOnly(OFF), false); assert.equal(payOwnerOnly(undefined), true); assert.equal(staffPayOwnerOnly, payOwnerOnly);
  for (const [name, session] of Object.entries(ROLE)) {
    const owner = name === 'owner';
    assert.deepEqual([seesOthersPay(session, {}), canSetPay(session, {}), canSeePay(session, {}, 'crew.two')], [owner, owner, owner], name);
    assert.deepEqual([seesOthersPay(session, OFF), canSetPay(session, OFF), canSeePay(session, OFF, 'crew.two')], [true, true, true], `${name} with the flag off`);
    assert.equal(canSeePay(session, {}, ` ${session.user.toUpperCase()} `), true, `${name} always sees their own pay`);
  }
  assert.equal(canSeePay(ROLE.manager, {}, ''), false, 'a record without an employee is not the viewer\'s');
  assert.equal(canSeePay(null, {}, 'tylerg'), false);
  // Stored staff roles never grant pay.manage to anyone but the configured owner.
  const roles = { EGC_STAFF_ROLE_PERMISSIONS: 'true' };
  assert.equal(seesOthersPay({ ...ROLE.manager, staffRoles: ['owner', 'manager'] }, roles), false);
  assert.equal(seesOthersPay({ ...ROLE.owner, staffRoles: ['owner'] }, roles), true);
  assert.equal(seesOthersPay({ ...ROLE.owner, staffRoles: ['manager'] }, roles), false, 'an owner account stored as a manager keeps only manager capabilities');
  // One refusal for every pay rule (a pay change, a timecard move, the payroll export): 403 pay_owner_only. PRICE-SCRUB's
  // incomingPay (dropping pay silently) and its EMPLOYEE_HUB_PAY_OWNER_ONLY move refusal are gone.
  assert.equal(['incomingPay', 'payOwnerOnlyError'].some(name => Object.hasOwn(payVisibility, name)), false);
  const refusal = payChangeRefused('Synthetic refusal');
  assert.deepEqual([refusal instanceof Error, refusal.code, refusal.status, refusal.message], [true, 'pay_owner_only', 403, 'Synthetic refusal']);
  assert.equal(payChangeRefused().code, 'pay_owner_only');
});

test('pay-change detection treats values payroll pays alike as unchanged', () => {
  assert.deepEqual(changedPay({ hourlyRate: '25', bonus: 0, tips: '', payType: 'hourly', jobTitle: 'x' }, { hourlyRate: 25, payType: undefined }), []);
  assert.deepEqual(changedPay({ hourlyRate: 26, bonus: 1, payType: 'salary' }, { hourlyRate: 25 }), ['payType', 'hourlyRate', 'bonus']);
  assert.deepEqual(changedPay({ hourlyRate: 30 }, { hourlyRate: 28 }, { hourlyRate: 30 }), [], 'equal to one baseline is unchanged');
  assert.deepEqual(changedPay({ hourlyRate: 'abc', tips: { value: 1 }, ptoRate: 5 }, null), ['hourlyRate', 'ptoRate', 'tips']);
  assert.deepEqual(changedPay({ paidHoursPerDay: 8, paidWeekends: true, hours: 9 }, null), [], 'paid hours are hours, not a rate');
  assert.deepEqual([samePay('hourlyRate', undefined, 0), samePay('payType', '', 'hourly'), samePay('payType', 'Hourly', 'hourly'), samePay('bonus', NaN, NaN)], [true, true, false, false]);
});

test('another employee\'s record: any pay field is refused whatever its value, and a stored timecard or time-off request never moves', () => {
  const refused = fn => { try { fn(); return null; } catch (error) { return [error.code, error.status, error.message]; } };
  const PAY = ['pay_owner_only', 403, payChangeRefused().message];
  // Every value is refused alike, so the answer cannot confirm a guess: the stored pay is not an input at all.
  for (const value of [19, '19', 0, '', null, 'hourly', [19], { value: 19 }]) for (const key of PAY_WRITE_FIELDS) {
    assert.deepEqual(refused(() => assertNoOthersPay(ROLE.manager, {}, 'timeEntries', { approvalStatus: 'approved', [key]: value })), PAY, `${key}=${JSON.stringify(value)}`);
    assert.deepEqual(refused(() => assertNoOthersPay(ROLE.crew_lead, {}, 'profiles', { username: 'Crew.Two', [key]: value })), PAY);
  }
  // Rate-like keys no reader pays from today are pay too.
  for (const key of ['overtimeMultiplier', 'payRates', 'rate', 'paidRate']) assert.ok(PAY_WRITE_FIELDS.includes(key), key);
  // Hours, approvals and paid time-off hours are not pay; the derived gross is recomputed by the timecard rules.
  for (const input of [{ approvalStatus: 'approved', notes: 'x' }, { status: 'approved', paidHoursPerDay: 8, paidWeekends: true }, { grossEstimate: 9999 }, {}]) assert.equal(refused(() => assertNoOthersPay(ROLE.manager, {}, 'requests', input)), null, JSON.stringify(input));
  const moved = refused(() => assertNoOthersPay(ROLE.manager, {}, 'timeEntries', { employee: 'TylerG' }, { moved: true }));
  assert.deepEqual(moved, ['pay_owner_only', 403, 'Only the owner can move a timecard to another employee, because its pay moves with it.']);
  // Fourth check: a time-off request carries its pay and approved paid hours when it moves, so it cannot move either.
  assert.deepEqual(refused(() => assertNoOthersPay(ROLE.manager, {}, 'requests', { employee: 'TylerG' }, { moved: true })), ['pay_owner_only', 403, 'Only the owner can move a time-off request to another employee, because its paid time off moves with it.']);
  assert.deepEqual(refused(() => assertNoOthersPay(ROLE.crew_lead, {}, 'requests', { status: 'approved', paidHoursPerDay: 8 }, { moved: true }))?.slice(0, 2), ['pay_owner_only', 403]);
  assert.equal(refused(() => assertNoOthersPay(ROLE.manager, {}, 'profiles', {}, { moved: true })), null, 'a profile does not carry its pay when it moves');
  // The owner, and everyone with the flag off, keep today's writes.
  for (const [session, flags] of [[ROLE.owner, {}], [ROLE.manager, OFF], [ROLE.crew, OFF]]) for (const collection of ['timeEntries', 'requests']) assert.equal(refused(() => assertNoOthersPay(session, flags, collection, { hourlyRate: 55 }, { moved: true })), null, collection);
  assert.deepEqual([payOwnerField('profiles'), payOwnerField('timeEntries'), payOwnerField('requests'), payOwnerField('training'), payOwnerField('constructor')], ['username', 'employee', 'employee', null, null]);
  assert.deepEqual(payWriteFields({ jobTitle: 'x', tips: 0, hourlyRate: undefined, rate: 1 }), ['hourlyRate', 'tips', 'rate']);
  assert.deepEqual(withoutPayWrites({ jobTitle: 'x', tips: 0, hourlyRate: 19, payRates: [], paidHoursPerDay: 8 }), { jobTitle: 'x', paidHoursPerDay: 8 });
  assert.deepEqual([payWriteFields(null), withoutPayWrites(null)], [[], null]);
});

test('timesheetPayView strips every other employee\'s pay, keeps hours and flags, and never turns hidden pay into 0', () => {
  const full = week(), view = timesheetPayView(ROLE.manager, {}, full);
  assert.equal(timesheetPayView(ROLE.owner, {}, full), full, 'the owner gets the same object');
  assert.equal(timesheetPayView(ROLE.manager, OFF, full), full, 'flag off: the same object');
  assert.deepEqual([view.payHidden, view.payVisibility, view.totals.payHidden], [true, 'own', true]);
  for (const key of ['straightPay', 'overtimePremium', 'ptoPay', 'bonus', 'tips', 'grossPay']) assert.equal(view.totals[key], null, key);
  for (const key of ['employees', 'workedHours', 'regularHours', 'overtimeHours', 'ptoHours', 'totalPaidHours']) assert.equal(view.totals[key], full.totals[key], key);
  for (const row of view.employees) {
    const original = full.employees.find(item => item.employee === row.employee);
    if (row.employee === 'tylerg') { assert.deepEqual(row, original, 'a manager sees their own pay'); continue; }
    assert.equal(row.payHidden, true);
    for (const key of ROW_PAY) assert.equal(Object.hasOwn(row, key), false, `${row.employee}.${key}`);
    for (const key of ['workedHours', 'regularHours', 'overtimeHours', 'ptoHours', 'totalPaidHours', 'overtimeBasis', 'flags', 'days', 'approvedTimecards', 'pendingTimecards']) assert.deepEqual(row[key], original[key], `${row.employee}.${key}`);
    assert.deepEqual(row.timecards.map(item => Object.keys(item).filter(key => ['hourlyRate', 'bonus', 'tips'].includes(key))).flat(), []);
    assert.deepEqual(row.timecards.map(item => [item.id, item.workedHours, item.approvalStatus]), original.timecards.map(item => [item.id, item.workedHours, item.approvalStatus]));
  }
  assert.deepEqual(full.employees.find(row => row.employee === 'crew.one').flags, ['bonus_or_tips'], 'flags stay');
  // A viewer whose only row is their own sees every row's pay, so totals stay numbers, but the export stays the owner's.
  const own = timesheetPayView(ROLE.manager, {}, week({ timecards: CARDS.filter(item => item.employee === 'TylerG'), pto: [] }));
  assert.deepEqual([own.payHidden, own.payVisibility, own.totals.grossPay], [undefined, 'own', 164.92]);
});

test('HTTP role matrix: /api/timesheets JSON never gives a manager, crew lead, crew or sales viewer another employee\'s pay', async () => {
  const today = JSON.stringify({ ok: true, ...week() });
  const owner = await get(ROLE.owner, '?view=week&start=2026-09-21');
  assert.equal(owner.response.status, 200);
  assert.equal(owner.text, today, 'the owner\'s response is byte-identical to the pre-change response');
  const parsedOwner = JSON.parse(owner.text);
  assert.deepEqual(parsedOwner.employees.map(row => [row.employee, row.grossPay]), week().employees.map(row => [row.employee, row.grossPay]));
  // Precondition: the owner's response carries every canary, so the checks below can see a leak.
  for (const value of canaries('TylerG')) assert.ok(numbers(parsedOwner).includes(value), `canary ${value} is in the owner view`);
  for (const [name, session] of Object.entries(ROLE).filter(([name]) => name !== 'owner')) {
    const on = await get(session, '?view=week&start=2026-09-21'), off = await get(session, '?view=week&start=2026-09-21', OFF);
    if (!session.businessAccess) {
      for (const result of [on, off]) { assert.equal(result.response.status, 403, name); assert.equal(JSON.parse(result.text).code, 'timesheet_forbidden'); assertNoCanary(result.text, session.user, name); }
      continue;
    }
    assert.equal(on.response.status, 200, name);
    assertNoCanary(on.text, session.user, `${name} JSON`);
    const body = JSON.parse(on.text), mine = body.employees.find(row => row.employee === session.user.toLowerCase());
    assert.deepEqual(mine, week().employees.find(row => row.employee === session.user.toLowerCase()), `${name} still sees their own pay`);
    assert.deepEqual([body.payHidden, body.payVisibility, body.totals.grossPay, body.totals.payHidden], [true, 'own', null, true]);
    assert.equal(body.employees.filter(row => row.payHidden).length, 3);
    assert.equal(on.response.headers.get('Cache-Control'), 'no-store');
    // Flag off: byte-identical to today's response, pay included.
    assert.equal(off.text, today, `${name} with the flag off`);
  }
  // Staff-role mode never lifts the rule for a manager.
  const roles = await get({ ...ROLE.manager, staffRoles: ['owner', 'manager'] }, '?view=week&start=2026-09-21', { EGC_STAFF_ROLE_PERMISSIONS: 'true' });
  assert.equal(roles.response.status, 200);
  assertNoCanary(roles.text, 'TylerG', 'manager with stored roles');
});

test('HTTP role matrix: the payroll CSV is the owner\'s with the flag on, and unchanged for every business user with it off', async () => {
  let reads = 0;
  const read = async () => { reads++; return { timecards: CARDS, requests: REQUESTS }; };
  const csv = payrollCsv(week());
  const owner = await get(ROLE.owner, '?view=week&start=2026-09-21&format=csv', {}, read);
  assert.equal(owner.response.status, 200);
  assert.equal(owner.text, csv, 'every existing payroll number is unchanged for the owner');
  const headers = response => ['Content-Type', 'Content-Disposition', 'Cache-Control', 'X-Content-Type-Options'].map(name => response.headers.get(name));
  assert.deepEqual(headers(owner.response), ['text/csv; charset=utf-8', 'attachment; filename="egc-payroll-2026-09-21-to-2026-09-27.csv"', 'no-store', 'nosniff']);
  for (const [name, session] of Object.entries(ROLE).filter(([name]) => name !== 'owner')) {
    reads = 0;
    const on = await get(session, '?view=week&start=2026-09-21&format=csv', {}, read);
    assert.equal(on.response.status, 403, name);
    assert.equal(JSON.parse(on.text).code, session.businessAccess ? 'pay_owner_only' : 'timesheet_forbidden', name);
    assertNoCanary(on.text, session.user, `${name} CSV`);
    assert.equal(reads, 0, `${name}: a refused export never opens the employee vault`);
    const off = await get(session, '?view=week&start=2026-09-21&format=csv', OFF, read);
    if (!session.businessAccess) { assert.equal(off.response.status, 403); continue; }
    assert.equal(off.response.status, 200, `${name} with the flag off`);
    assert.equal(off.text, owner.text); assert.deepEqual(headers(off.response), headers(owner.response));
  }
  // The flag is checked after the query: a malformed export request is still a 400.
  const invalid = await get(ROLE.manager, '?view=week&start=2026-09-21&format=csv&acknowledge=pending_timecards');
  assert.deepEqual([invalid.response.status, JSON.parse(invalid.text).code], [400, 'timesheet_query_invalid']);
  // An incomplete week's 409 (with its review details) is byte-identical for a manager with the flag off and the owner.
  const pending = async () => ({ timecards: [...CARDS, card('late', 'Crew.One', 'Synthetic Crew', '2026-09-26', '08:00', '12:00', { approvalStatus: 'pending', hourlyRate: 37.13 })], requests: REQUESTS });
  const ownerBlocked = await get(ROLE.owner, '?view=week&start=2026-09-21&format=csv', {}, pending), managerBlocked = await get(ROLE.manager, '?view=week&start=2026-09-21&format=csv', OFF, pending);
  assert.equal(ownerBlocked.response.status, 409); assert.equal(managerBlocked.text, ownerBlocked.text);
  const refused = await get(ROLE.manager, '?view=week&start=2026-09-21&format=csv', {}, pending);
  assert.deepEqual([refused.response.status, JSON.parse(refused.text).code], [403, 'pay_owner_only']);
});

// ---- Writes through /api/employee-hub with the real encrypted vault ----
const env = staffEnv({}, {
  'Lead.One': { passwordHash: 'unused-synthetic-field-lead-hash', role: 'crew_lead', displayName: 'Synthetic Field Lead', hourlyRate: 24 },
  'Sales.One': { passwordHash: 'unused-synthetic-sales-hash', role: 'sales', displayName: 'Synthetic Sales', hourlyRate: 18 },
});
const WRITE_NOW = '2026-09-22T18:00:00.000Z';
const decrypt = async (fire, collection, id) => {
  const documentId = await opaqueId(env, collection, id), doc = fire.documents.get(`jobs/${documentId}`);
  return doc ? open(env, documentId, doc.fields.sealedIv.stringValue, doc.fields.sealedPayload.stringValue) : null;
};
async function vault(t) {
  const fire = vaultFirestore(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(WRITE_NOW) });
  const cookies = Object.fromEntries(await Promise.all(['ZacB', 'TylerG', 'AlexK', 'Lead.One', 'Crew.Static', 'Sales.One'].map(async user => [user, await cookieFor(env, user)])));
  const post = async (hubEnv, user, collection, id, data) => {
    const response = await employeeHub.onRequestPost({ env: hubEnv, request: jsonRequest('/api/employee-hub', { collection, id, data }, cookies[user]) });
    const body = await response.json();
    return { status: response.status, code: body.code, body };
  };
  const get = async (hubEnv, user) => {
    const response = await employeeHub.onRequestGet({ env: hubEnv, request: jsonRequest('/api/employee-hub', undefined, cookies[user]) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  // Time-off requests are created, approved, changed and closed only through the request workflow (P1-06); the generic
  // record write above answers every requests write with 403 EMPLOYEE_HUB_REQUEST_WORKFLOW_REQUIRED.
  const pto = async (hubEnv, user, input) => {
    const response = await employeePto.onRequestPost({ env: hubEnv, request: jsonRequest('/api/employee-pto', { requestId: randomUUID(), ...input }, cookies[user]) });
    const body = await response.json();
    return { status: response.status, code: body.code, body };
  };
  const ptoList = async (hubEnv, user) => {
    const response = await employeePto.onRequestGet({ env: hubEnv, request: jsonRequest('/api/employee-pto?startDate=2026-09-21&endDate=2026-09-28', undefined, cookies[user]) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  // Pay keys the owner stored on a request before the workflow (when the generic write took any field from them): no
  // endpoint stores one now, so the test writes it into the vault as that older save left it.
  const legacy = async (collection, id, changes) => {
    const found = await readOne(env, collection, id);
    assert.ok(found.data, `${collection}/${id} exists`);
    await writeOne(env, collection, id, { ...found.data, ...changes }, found, WRITE_NOW);
  };
  return { fire, post, get, pto, ptoList, legacy, read: (collection, id) => decrypt(fire, collection, id) };
}
const WORKFLOW = [403, 'EMPLOYEE_HUB_REQUEST_WORKFLOW_REQUIRED'];
const UNSUPPORTED = [400, 'pto_invalid_request'];
const outcome = result => [result.status, result.code];
const ask = (startDate, extra = {}) => ({ action: 'request', type: 'time_off', startDate, endDate: startDate, reason: 'Synthetic', ...extra });
const shift = (employee, extra = {}) => ({ employee, employeeName: `Synthetic ${employee}`, clockInAt: '2026-09-21T14:00:00.000Z', clockOutAt: '2026-09-21T18:00:00.000Z', status: 'submitted', approvalStatus: 'pending', breaks: [], ...extra });
const FLAGS = [['on', env], ['off', { ...env, ...OFF }]];
const refusedOn = (flag, result, label) => flag === 'on' ? assert.deepEqual([result.status, result.code], [403, 'pay_owner_only'], label) : assert.equal(result.status, 200, `${label}: ${JSON.stringify(result.body)}`);

test('HTTP writes: without pay.manage a timecard pay change is refused, including self-approved and manager-created timecards', async t => {
  const { fire, post, read } = await vault(t);
  for (const [flag, hubEnv] of FLAGS) for (const user of ['TylerG', 'AlexK']) {
    const id = name => `${flag}-${user}-${name}`.toLowerCase(), label = name => `${flag}/${user}/${name}`;
    assert.equal((await post(env, 'ZacB', 'timeEntries', id('crew'), shift('Crew.Static', { hourlyRate: 19 }))).status, 200);
    const before = fire.snapshot();
    // Another employee's rate, bonus and tips, and moving their card (and its pay) to yourself.
    for (const [name, change] of [['rate', { hourlyRate: 55 }], ['bonus', { bonus: 500 }], ['tips', { tips: '40' }], ['type', { payType: 'salary' }], ['reassign', { employee: user, employeeName: user }]]) {
      const result = await post(hubEnv, user, 'timeEntries', id('crew'), change);
      refusedOn(flag, result, label(name));
      if (flag === 'on') assert.equal(fire.snapshot(), before, `${label(name)} writes nothing`);
      else assert.equal(fire.snapshot() === before, false);
      if (flag === 'off') assert.equal((await post(env, 'ZacB', 'timeEntries', id('crew'), { employee: 'Crew.Static', employeeName: 'Synthetic Crew.Static', hourlyRate: 19, bonus: 0, tips: 0, payType: 'hourly' })).status, 200);
    }
    // An approval that sends the stored rate back is refused like any other pay on another employee's timecard (so the
    // answer never depends on the stored pay); flag off, it saves as today.
    refusedOn(flag, await post(hubEnv, user, 'timeEntries', id('crew'), { approvalStatus: 'approved', hourlyRate: 19 }), label('approve with the stored rate'));
    // Approving hours is the manager's: the approval (without pay, as the timesheet board sends it; a forged gross is
    // recomputed from the stored rate) saves.
    const approved = await post(hubEnv, user, 'timeEntries', id('crew'), { approvalStatus: 'approved', grossEstimate: 9999 });
    assert.equal(approved.status, 200, label('approve'));
    const saved = await read('timeEntries', id('crew'));
    assert.deepEqual([saved.approvalStatus, saved.approvedBy, saved.hourlyRate, saved.grossEstimate], ['approved', user, 19, 76]);
    // A manager-created timecard for someone else cannot carry a rate; without pay it saves.
    refusedOn(flag, await post(hubEnv, user, 'timeEntries', id('made'), shift('Crew.Static', { hourlyRate: 55 })), label('create rate'));
    assert.equal((await read('timeEntries', id('made')))?.hourlyRate, flag === 'on' ? undefined : 55);
    assert.equal((await post(hubEnv, user, 'timeEntries', id('made-hours'), shift('Crew.Static'))).status, 200);
    assert.equal(Object.hasOwn(await read('timeEntries', id('made-hours')), 'hourlyRate'), false);
    // Your own new timecard snapshots the server rate (as a crew clock-in does); bonus and tips are the owner's.
    const own = await post(hubEnv, user, 'timeEntries', id('own'), shift(user, { hourlyRate: 99, payType: 'salary' }));
    assert.equal(own.status, 200, label('own'));
    const ownCard = await read('timeEntries', id('own'));
    assert.deepEqual([ownCard.hourlyRate, ownCard.payType], flag === 'on' ? [user === 'TylerG' ? 30 : 0, 'hourly'] : [99, 'salary'], label('own snapshot'));
    refusedOn(flag, await post(hubEnv, user, 'timeEntries', id('own-bonus'), shift(user, { bonus: 50 })), label('own bonus'));
    // Self-approval: the hours can be approved, a rate change alongside it cannot.
    refusedOn(flag, await post(hubEnv, user, 'timeEntries', id('own'), { approvalStatus: 'approved', hourlyRate: 120 }), label('self-approve with a raise'));
    const selfApproved = await post(hubEnv, user, 'timeEntries', id('own'), { approvalStatus: 'approved' });
    assert.equal(selfApproved.status, 200);
    assert.deepEqual([(await read('timeEntries', id('own'))).approvedBy, (await read('timeEntries', id('own'))).hourlyRate], [user, flag === 'on' ? (user === 'TylerG' ? 30 : 0) : 120]);
  }
  // The owner sets pay on anyone's timecard with the flag on.
  assert.equal((await post(env, 'ZacB', 'timeEntries', 'owner-card', shift('Crew.Static', { hourlyRate: 22, bonus: 15 }))).status, 200);
  assert.equal((await post(env, 'ZacB', 'timeEntries', 'owner-card', { hourlyRate: 23, tips: 4 })).status, 200);
  const ownerCard = await read('timeEntries', 'owner-card');
  assert.deepEqual([ownerCard.hourlyRate, ownerCard.bonus, ownerCard.tips], [23, 15, 4]);
});

test('HTTP writes: crew, field-lead and sales clock-ins and edits never set pay, with the flag on or off', async t => {
  const { post, read } = await vault(t);
  const location = { lat: 40.58, lng: -105.08, accuracy: 5 };
  for (const [flag, hubEnv] of FLAGS) for (const [user, rate] of [['Crew.Static', 19], ['Lead.One', 24], ['Sales.One', 18]]) {
    const id = `${flag}-${user}`.toLowerCase();
    const clockIn = await post(hubEnv, user, 'timeEntries', id, { locationTracking: true, lastLocation: location, hourlyRate: 99, payType: 'salary', bonus: 500, tips: 60 });
    assert.equal(clockIn.status, 200, JSON.stringify(clockIn.body));
    const edit = await post(hubEnv, user, 'timeEntries', id, { hourlyRate: 99, bonus: 5, notes: 'Synthetic note' });
    assert.equal(edit.status, 200);
    const saved = await read('timeEntries', id);
    assert.deepEqual([saved.hourlyRate, saved.payType, saved.bonus, saved.tips, saved.notes], [rate, 'hourly', undefined, undefined, 'Synthetic note'], `${flag}/${user}`);
    assert.equal((await post(hubEnv, user, 'timeEntries', id, { clockOutAt: WRITE_NOW, status: 'submitted', grossEstimate: 9999 })).status, 200);
    assert.equal((await read('timeEntries', id)).grossEstimate, 0, 'the server computes gross from the saved rate');
    // Their own profile keeps the server's pay whatever the form sent.
    const profile = await post(hubEnv, user, 'profiles', user.toLowerCase(), { hourlyRate: 99, payType: 'salary', preferredName: 'Synthetic' });
    assert.equal(profile.status, 200);
    assert.deepEqual([(await read('profiles', user.toLowerCase())).hourlyRate, (await read('profiles', user.toLowerCase())).payType], [rate, 'hourly']);
  }
});

test('HTTP writes: profile pay (the Hub staff directory form) is the owner\'s, on another employee\'s profile and your own', async t => {
  const { fire, post, read } = await vault(t);
  assert.equal((await post(env, 'ZacB', 'profiles', 'crew.static', { username: 'Crew.Static', jobTitle: 'Synthetic crew', payType: 'hourly', hourlyRate: 19.5 })).status, 200);
  for (const [flag, hubEnv] of FLAGS) for (const user of ['TylerG', 'AlexK']) {
    const before = fire.snapshot();
    refusedOn(flag, await post(hubEnv, user, 'profiles', 'crew.static', { username: 'Crew.Static', hourlyRate: 26 }), `${flag}/${user} raise`);
    for (const cut of [{ hourlyRate: 0 }, { hourlyRate: '' }, { payType: 'salary' }]) {
      refusedOn(flag, await post(hubEnv, user, 'profiles', 'crew.static', { username: 'Crew.Static', ...cut }), `${flag}/${user} ${JSON.stringify(cut)}`);
      if (flag === 'off') assert.equal((await post(env, 'ZacB', 'profiles', 'crew.static', { username: 'Crew.Static', hourlyRate: 19.5, payType: 'hourly' })).status, 200);
    }
    if (flag === 'on') assert.equal(fire.snapshot(), before);
    // Sending back the pay the board showed is refused like any other pay on another employee's profile (the answer
    // never depends on the stored pay); flag off, it saves as today. The team board's save leaves pay out unless the
    // rate was edited, and that saves with the stored pay untouched.
    assert.equal((await post(env, 'ZacB', 'profiles', 'crew.static', { username: 'Crew.Static', hourlyRate: 19.5 })).status, 200);
    refusedOn(flag, await post(hubEnv, user, 'profiles', 'crew.static', { username: 'Crew.Static', payType: 'hourly', hourlyRate: '19.50' }), `${flag}/${user} echo`);
    const edit = await post(hubEnv, user, 'profiles', 'crew.static', { username: 'Crew.Static', jobTitle: `Synthetic ${flag}` });
    assert.equal(edit.status, 200);
    assert.deepEqual([(await read('profiles', 'crew.static')).jobTitle, (await read('profiles', 'crew.static')).hourlyRate], [`Synthetic ${flag}`, flag === 'on' ? 19.5 : '19.50']);
  }
  // A roster entry not saved as a profile yet: any pay is refused, the pay the board shows for it (the Hub configuration's
  // 24) included; without pay the save goes through.
  refusedOn('on', await post(env, 'TylerG', 'profiles', 'lead.one', { username: 'Lead.One', hourlyRate: 30 }), 'unsaved roster raise');
  refusedOn('on', await post(env, 'TylerG', 'profiles', 'lead.one', { username: 'Lead.One', jobTitle: 'Synthetic lead', payType: 'hourly', hourlyRate: 24 }), 'unsaved roster echo');
  assert.equal((await post(env, 'TylerG', 'profiles', 'lead.one', { username: 'Lead.One', jobTitle: 'Synthetic lead' })).status, 200);
  assert.deepEqual([(await read('profiles', 'lead.one')).jobTitle, Object.hasOwn(await read('profiles', 'lead.one'), 'hourlyRate')], ['Synthetic lead', false]);
  // A manager's own profile: the Hub configuration's pay (what ensureOwnProfile sends) saves; any other rate is refused.
  refusedOn('on', await post(env, 'TylerG', 'profiles', 'tylerg', { username: 'TylerG', payType: 'hourly', hourlyRate: 45, lastSeenAt: WRITE_NOW }), 'own raise');
  refusedOn('on', await post(env, 'TylerG', 'profiles', 'tylerg', { username: 'TylerG', payType: 'salary', hourlyRate: 30 }), 'own pay type');
  assert.equal((await post(env, 'TylerG', 'profiles', 'tylerg', { username: 'TylerG', displayName: 'Synthetic Manager', role: 'manager', payType: 'hourly', hourlyRate: 30, lastSeenAt: WRITE_NOW })).status, 200);
  assert.deepEqual([(await read('profiles', 'tylerg')).hourlyRate, (await read('profiles', 'tylerg')).lastSeenAt], [30, WRITE_NOW]);
  refusedOn('off', await post({ ...env, ...OFF }, 'TylerG', 'profiles', 'tylerg', { username: 'TylerG', hourlyRate: 45 }), 'own raise with the flag off');
  assert.equal((await read('profiles', 'tylerg')).hourlyRate, 45);
  // The owner sets anyone's pay.
  assert.equal((await post(env, 'ZacB', 'profiles', 'crew.static', { username: 'Crew.Static', hourlyRate: 21, payType: 'hourly' })).status, 200);
  assert.equal((await read('profiles', 'crew.static')).hourlyRate, 21);
});

test('HTTP writes: a right guess and a wrong guess of another employee\'s pay get the same answer, and none writes', async t => {
  const { fire, post, pto, legacy } = await vault(t);
  // Canary pay the owner set: a timecard, a saved profile, a roster entry with no saved profile (Lead.One's Hub
  // configuration says 24) and a time-off request (sent through the request workflow; its rate is an older owner save).
  assert.equal((await post(env, 'ZacB', 'timeEntries', 'guess-card', shift('Crew.Static', { hourlyRate: 23.75, bonus: 41, tips: 7 }))).status, 200);
  assert.equal((await post(env, 'ZacB', 'timeEntries', 'unpaid-card', shift('Crew.Static', { hourlyRate: 0 }))).status, 200);
  assert.equal((await post(env, 'ZacB', 'profiles', 'crew.static', { username: 'Crew.Static', payType: 'hourly', hourlyRate: 27.5 })).status, 200);
  const requested = await pto(env, 'Crew.Static', ask('2026-09-24'));
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  const guessPto = requested.body.request.id;
  await legacy('requests', guessPto, { ptoRate: 31 });
  const before = fire.snapshot(), answer = result => JSON.stringify([result.status, result.body]);
  const PAY = JSON.stringify([403, { ok: false, code: 'pay_owner_only', error: payChangeRefused().message }]);
  const hubGuesses = new Set(), ptoGuesses = new Set();
  for (const user of ['TylerG', 'AlexK']) {
    for (const [collection, id, base, key, right, wrongs] of [
      ['timeEntries', 'guess-card', {}, 'hourlyRate', 23.75, [23.5, 24, '23.7', 0, null]],
      ['timeEntries', 'guess-card', { approvalStatus: 'approved' }, 'hourlyRate', ' 23.750 ', [15]],
      ['timeEntries', 'guess-card', {}, 'bonus', 41, [40, 42, 0, '']],
      ['timeEntries', 'guess-card', {}, 'tips', 7, [6, 8]],
      ['timeEntries', 'guess-card', {}, 'payType', 'hourly', ['salary', null]],
      ['timeEntries', 'unpaid-card', {}, 'hourlyRate', 0, [1, '']],
      ['profiles', 'crew.static', { username: 'Crew.Static' }, 'hourlyRate', 27.5, [27, 28, '27.49']],
      ['profiles', 'crew.static', { username: 'Crew.Static', jobTitle: 'Synthetic guess' }, 'payType', 'hourly', ['salary', '']],
      ['profiles', 'lead.one', { username: 'Lead.One' }, 'hourlyRate', 24, [23, 25]],
    ]) {
      const expected = answer(await post(env, user, collection, id, { ...base, [key]: right }));
      assert.equal(expected, PAY, `${user} ${collection}/${id}.${key}: the right guess`);
      for (const wrong of wrongs) assert.equal(answer(await post(env, user, collection, id, { ...base, [key]: wrong })), expected, `${user} ${collection}/${id}.${key}=${JSON.stringify(wrong)}`);
    }
    // The time-off request's stored ptoRate: the generic write refuses every requests write before it reads one, and the
    // request workflow refuses a pay key on every action before it reads the request, so the right guess (31) and the
    // wrong ones get one answer on each endpoint.
    for (const guess of [31, 30, 32, '31', 0, null]) {
      hubGuesses.add(answer(await post(env, user, 'requests', guessPto, { ptoRate: guess })));
      for (const action of ['approve', 'amend', 'deny', 'cancel', 'end']) ptoGuesses.add(answer(await pto(env, user, { action, id: guessPto, ptoRate: guess })));
    }
  }
  assert.deepEqual([...hubGuesses].map(text => JSON.parse(text)).map(([status, body]) => [status, body.code]), [WORKFLOW]);
  assert.deepEqual([...ptoGuesses].map(text => JSON.parse(text)).map(([status, body]) => [status, body.code]), [UNSUPPORTED]);
  // The second review's probe: sweeping every rate from $15 to $30 in 25-cent steps gets one answer for all of them.
  const answers = new Set();
  for (let cents = 1500; cents <= 3000; cents += 25) answers.add(answer(await post(env, 'TylerG', 'timeEntries', 'guess-card', { hourlyRate: cents / 100 })));
  for (let cents = 1500; cents <= 3000; cents += 50) answers.add(answer(await post(env, 'TylerG', 'profiles', 'crew.static', { username: 'Crew.Static', hourlyRate: cents / 100 })));
  assert.deepEqual([...answers], [PAY]);
  assert.equal(fire.snapshot(), before, 'no guess writes anything');
  // A move is refused whatever pay the timecard carries (none included), to yourself or from yourself.
  const moves = new Set();
  for (const id of ['guess-card', 'unpaid-card']) moves.add(answer(await post(env, 'TylerG', 'timeEntries', id, { employee: 'TylerG', employeeName: 'Synthetic Manager' })));
  assert.equal((await post(env, 'TylerG', 'timeEntries', 'tyler-own', shift('TylerG'))).status, 200);
  const own = fire.snapshot();
  moves.add(answer(await post(env, 'TylerG', 'timeEntries', 'tyler-own', { employee: 'Crew.Static' })));
  assert.deepEqual([...moves].map(text => JSON.parse(text)[1].code), ['pay_owner_only']);
  assert.equal(moves.size, 1);
  assert.equal(fire.snapshot(), own, 'a refused move writes nothing');
  assert.notEqual(before, own, 'precondition: a save changes the snapshot, so the equalities above can see a write');
  // The owner, and every manager with the flag off, keep today's moves.
  assert.equal((await post({ ...env, ...OFF }, 'TylerG', 'timeEntries', 'unpaid-card', { employee: 'TylerG', employeeName: 'Synthetic Manager' })).status, 200);
  assert.equal((await post(env, 'ZacB', 'timeEntries', 'guess-card', { employee: 'Lead.One', employeeName: 'Synthetic Field Lead' })).status, 200);
});

test('HTTP writes: unchanged pay on your own records is accepted but never stored as sent, and rate-like keys are pay', async t => {
  const { fire, post, pto, read } = await vault(t);
  // The owner set the pay on the manager's approved timecard; the manager's note carries the same pay spelled otherwise.
  assert.equal((await post(env, 'ZacB', 'timeEntries', 'own-echo', shift('TylerG', { hourlyRate: 30, payType: 'hourly', approvalStatus: 'approved' }))).status, 200);
  const stored = await read('timeEntries', 'own-echo');
  const echo = await post(env, 'TylerG', 'timeEntries', 'own-echo', { notes: 'Synthetic note', hourlyRate: ' 30.000 ', payType: null, bonus: 0, tips: '' });
  assert.equal(echo.status, 200, JSON.stringify(echo.body));
  const saved = await read('timeEntries', 'own-echo');
  assert.deepEqual([saved.hourlyRate, saved.payType, Object.hasOwn(saved, 'bonus'), Object.hasOwn(saved, 'tips'), saved.notes, saved.approvalStatus], [30, 'hourly', false, false, 'Synthetic note', 'approved'], 'the stored pay stays exactly as it was, and the approval stands');
  const added = saved.history.slice(stored.history.length);
  assert.deepEqual(added.map(entry => Object.keys(entry.changes)), [['notes']], 'the audit history records the note, not a pay change');
  // A crew member's own new request goes through the request workflow, which takes no pay key at all: pay equal to none
  // is refused there too (stricter than the timecard echo above), the generic write refuses the request itself, and no
  // refused request is stored. Without pay it saves, pending and with no pay key.
  const hubRequest = { type: 'time_off', startDate: '2026-09-24', endDate: '2026-09-24', reason: 'Synthetic' };
  const quiet = fire.snapshot();
  assert.deepEqual(outcome(await post(env, 'Crew.Static', 'requests', 'own-pto', { ...hubRequest, bonus: 0, rate: '', hourlyRate: null })), WORKFLOW, 'crew hub request with pay equal to none');
  assert.deepEqual(outcome(await pto(env, 'Crew.Static', ask('2026-09-24', { bonus: 0, rate: '', hourlyRate: null }))), UNSUPPORTED, 'crew request with pay equal to none');
  for (const key of ['rate', 'paidRate', 'overtimeMultiplier']) {
    assert.deepEqual(outcome(await post(env, 'Crew.Static', 'requests', `own-pto-${key}`, { ...hubRequest, [key]: 50 })), WORKFLOW, `crew hub request ${key}`);
    assert.deepEqual(outcome(await pto(env, 'Crew.Static', ask('2026-09-24', { [key]: 50 }))), UNSUPPORTED, `crew request ${key}`);
  }
  assert.equal(fire.snapshot(), quiet, 'no refused request is stored');
  const sent = await pto(env, 'Crew.Static', ask('2026-09-24'));
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const ownRequest = await read('requests', sent.body.request.id);
  assert.deepEqual([ownRequest.status, PAY_WRITE_FIELDS.filter(key => Object.hasOwn(ownRequest, key))], ['pending', []]);
  // Rate-like keys no reader pays from today, on another employee's timecard or request. A timecard's are refused with
  // the flag on and saved as today with it off. A request's are refused with the flag on or off: the generic write takes
  // no request, and the workflow's approve and amend take no pay key, not even beside paid hours.
  const crewPto = (await pto(env, 'Crew.Static', ask('2026-09-25'))).body.request.id;
  for (const [flag, hubEnv] of FLAGS) {
    assert.equal((await post(env, 'ZacB', 'timeEntries', `${flag}-rates`, shift('Crew.Static', { hourlyRate: 19 }))).status, 200);
    for (const [collection, id, data] of [['timeEntries', `${flag}-rates`, { overtimeMultiplier: 3 }], ['timeEntries', `${flag}-rates`, { payRates: [{ effectiveFrom: '2026-01-01', hourlyRate: 99 }] }]]) {
      refusedOn(flag, await post(hubEnv, 'TylerG', collection, id, data), `${flag} ${collection} ${Object.keys(data)[0]}`);
    }
    for (const data of [{ rate: 50 }, { paidRate: 50 }]) {
      const label = `${flag} requests ${Object.keys(data)[0]}`;
      assert.deepEqual(outcome(await post(hubEnv, 'TylerG', 'requests', crewPto, data)), WORKFLOW, label);
      for (const action of ['approve', 'amend']) assert.deepEqual(outcome(await pto(hubEnv, 'TylerG', { action, id: crewPto, paid: true, hoursPerDay: 8, ...data })), UNSUPPORTED, `${label} ${action}`);
    }
    const card = await read('timeEntries', `${flag}-rates`), request = await read('requests', crewPto);
    assert.deepEqual([card.overtimeMultiplier, card.payRates?.length, request.rate, request.paidRate, request.status], flag === 'on' ? [undefined, undefined, undefined, undefined, 'pending'] : [3, 1, undefined, undefined, 'pending'], flag);
  }
});

test('HTTP writes: a manager approves time off and sets paid hours, but never a rate, and PTO pays at the timecard rate', async t => {
  const { fire, post, pto, read } = await vault(t);
  for (const [flag, hubEnv] of FLAGS) {
    // One day per flag: the workflow refuses a second pending or approved request over the same day.
    const day = flag === 'on' ? '2026-09-24' : '2026-09-23', label = name => `${flag} ${name}`;
    // An employee request cannot carry pay or pre-fill what payroll pays: the generic write refuses requests, and the
    // workflow refuses a rate, the manager-only paidHoursPerDay and paidWeekends, and more than 12 paid hours a day.
    const quiet = fire.snapshot();
    assert.deepEqual(outcome(await post(hubEnv, 'Crew.Static', 'requests', `${flag}-pto-rate`, { type: 'time_off', startDate: day, endDate: day, reason: 'Synthetic', hourlyRate: 99 })), WORKFLOW, label('crew hub request with a rate'));
    assert.deepEqual(outcome(await post(hubEnv, 'Crew.Static', 'requests', `${flag}-pto`, { type: 'time_off', startDate: day, endDate: day, reason: 'Synthetic', paidHoursPerDay: 24 })), WORKFLOW, label('crew hub request with paid hours'));
    for (const extra of [{ hourlyRate: 99 }, { paidHoursPerDay: 24 }, { paidWeekends: true }]) assert.deepEqual(outcome(await pto(hubEnv, 'Crew.Static', ask(day, extra))), UNSUPPORTED, label(`crew request ${JSON.stringify(extra)}`));
    assert.deepEqual(outcome(await pto(hubEnv, 'Crew.Static', ask(day, { paid: true, hoursPerDay: 24 }))), [400, 'pto_invalid_hours'], label('crew request for 24 paid hours a day'));
    assert.equal(fire.snapshot(), quiet, label('no refused request is stored'));
    // The employee may ask for paid hours, but a pending request pays nothing, and neither the employee nor a crew lead
    // can approve it: paid hours are an operations manager's decision.
    const asked = await pto(hubEnv, 'Crew.Static', ask(day, { paid: true, hoursPerDay: 12 }));
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    const id = asked.body.request.id;
    assert.deepEqual(ptoFromRequests([await read('requests', id)]), [], label('a pending request pays nothing'));
    for (const user of ['Crew.Static', 'AlexK']) assert.deepEqual(outcome(await pto(hubEnv, user, { action: 'approve', id, paid: true, hoursPerDay: 12 })), [403, 'pto_forbidden'], label(`${user} approves`));
    // Nobody but the owner sets a rate, and the owner no longer sets one on a request either.
    for (const user of ['TylerG', 'AlexK', 'ZacB']) {
      assert.deepEqual(outcome(await post(hubEnv, user, 'requests', id, { ptoRate: 55 })), WORKFLOW, label(`${user} hub PTO rate`));
      for (const action of ['approve', 'amend']) assert.deepEqual(outcome(await pto(hubEnv, user, { action, id, paid: true, hoursPerDay: 8, ptoRate: 55 })), UNSUPPORTED, label(`${user} ${action} with a PTO rate`));
    }
    // The manager approves and sets the paid hours and days (hours, not a rate), replacing what the employee asked for.
    const approved = await pto(hubEnv, 'TylerG', { action: 'approve', id, paid: true, hoursPerDay: 8, paidDates: [day] });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const saved = await read('requests', id);
    assert.deepEqual([saved.status, saved.paid, saved.hoursPerDay, saved.paidDates, saved.paidHours, saved.reviewedBy, PAY_WRITE_FIELDS.filter(key => Object.hasOwn(saved, key))], ['approved', true, 8, [day], 8, 'tylerg', []], label('approved'));
    // Whatever a request carries, payroll pays PTO at the employee's snapshotted timecard rate.
    const paidTimeOff = ptoFromRequests([{ ...saved, hourlyRate: 99, ptoRate: 55 }]);
    const paid = computeTimesheetWeek({ timecards: [card('rate-source', 'Crew.Static', 'Synthetic', '2026-09-22', '08:00', '12:00', { hourlyRate: 19 })], pto: paidTimeOff, weekStart: '2026-09-21', now: NOW.toISOString() });
    assert.deepEqual([paid.employees[0].ptoHours, paid.employees[0].ptoPay], [8, 152], label('paid at the timecard rate'));
  }
});

test('HTTP writes: a save answers a manager without another employee\'s pay; the owner, their own records and the flag off keep it', async t => {
  const { post } = await vault(t);
  // Canary pay no hour count, id or timestamp contains.
  const RATE = 19.37, BONUS = 12.71, TIPS = 8.53, PROFILE_RATE = 21.43;
  const leaks = (body, secret) => { const text = JSON.stringify(body); return [...secret].filter(value => text.includes(String(value)) || numbers(body).includes(value)); };
  for (const [flag, hubEnv] of FLAGS) {
    const id = `${flag}-reply`;
    const created = await post(env, 'ZacB', 'timeEntries', id, shift('Crew.Static', { hourlyRate: RATE, bonus: BONUS, tips: TIPS }));
    assert.equal(created.status, 200);
    const secret = new Set([RATE, BONUS, TIPS, created.body.record.grossEstimate, PROFILE_RATE]);
    // Precondition: the owner's answer carries the canaries, so the checks below can see a leak.
    assert.deepEqual([created.body.record.hourlyRate, created.body.record.bonus, created.body.record.tips, created.body.record.grossEstimate], [RATE, BONUS, TIPS, 77.48]);
    const profile = await post(env, 'ZacB', 'profiles', 'crew.static', { username: 'Crew.Static', jobTitle: 'Synthetic crew', payType: 'hourly', hourlyRate: PROFILE_RATE });
    assert.equal(profile.body.record.hourlyRate, PROFILE_RATE);
    for (const user of ['TylerG', 'AlexK']) {
      const label = `${flag}/${user}`;
      // Approving another employee's hours: the approval saves and answers with the hours, not the pay.
      const approved = await post(hubEnv, user, 'timeEntries', id, { approvalStatus: user === 'TylerG' ? 'approved' : 'rejected' });
      assert.equal(approved.status, 200, label);
      assert.deepEqual([approved.body.record.id, approved.body.record.approvedBy, approved.body.record.clockOutAt], [id, user, '2026-09-21T18:00:00.000Z'], label);
      // The team board's profile save (without pay: the board leaves it out unless the rate was edited).
      const edit = await post(hubEnv, user, 'profiles', 'crew.static', { username: 'Crew.Static', jobTitle: `Synthetic ${label}` });
      assert.equal(edit.status, 200, label);
      assert.equal(edit.body.record.jobTitle, `Synthetic ${label}`);
      for (const [name, result] of [['approval', approved], ['profile save', edit]]) {
        if (flag === 'on') {
          assert.deepEqual(leaks(result.body, secret), [], `${label} ${name}`);
          assert.deepEqual(PAY_FIELDS.filter(key => Object.hasOwn(result.body.record, key)), [], `${label} ${name}`);
        } else assert.ok(leaks(result.body, secret).length, `${label} ${name}: with the flag off the answer is unchanged, pay included`);
      }
      // Your own records answer with your own pay.
      const own = await post(hubEnv, user, 'profiles', user.toLowerCase(), { username: user, jobTitle: 'Synthetic own' });
      assert.equal(own.status, 200);
      assert.equal(Object.hasOwn(own.body.record, 'hourlyRate'), true, `${label} own profile`);
    }
  }
  const ownCard = await post(env, 'Crew.Static', 'timeEntries', 'crew-own', { locationTracking: true, lastLocation: { lat: 40.58, lng: -105.08, accuracy: 5 } });
  assert.deepEqual([ownCard.status, ownCard.body.record.hourlyRate], [200, PROFILE_RATE], 'a crew clock-in answers with its own rate, snapshotted from the profile the owner set');
  // The shared filter: another employee's profile or timecard (and a timecard's audit history) loses pay; nothing else changes.
  const row = { id: 'x', employee: 'Crew.Static', hourlyRate: RATE, history: [{ action: 'edit', changes: { hourlyRate: { before: 1, after: RATE }, notes: { before: '', after: 'n' } } }] };
  assert.deepEqual(visiblePay(ROLE.manager, {}, 'timeEntries', row), { id: 'x', employee: 'Crew.Static', history: [{ action: 'edit', changes: { notes: { before: '', after: 'n' } } }] });
  assert.equal(visiblePay(ROLE.owner, {}, 'timeEntries', row), row);
  assert.equal(visiblePay(ROLE.manager, OFF, 'timeEntries', row), row);
  assert.equal(visiblePay({ user: 'crew.static' }, {}, 'timeEntries', row), row);
  // A time-off request keeps its paid hours (hours, not pay); since the second review a rate-like key stored on another
  // employee's request is hidden too, and the owner and the flag-off rule still get the stored object itself.
  const requestRow = { id: 'r', employee: 'Crew.Static', paidHoursPerDay: 8 };
  assert.deepEqual(visiblePay(ROLE.manager, {}, 'requests', requestRow), requestRow);
  const ratedRequest = { ...requestRow, ptoRate: RATE, paidRate: RATE, overtimeMultiplier: 1.5 };
  assert.deepEqual(visiblePay(ROLE.manager, {}, 'requests', ratedRequest), requestRow);
  assert.deepEqual(leaks(visiblePay(ROLE.manager, {}, 'requests', ratedRequest), new Set([RATE])), []);
  for (const [session, hubEnv] of [[ROLE.owner, {}], [ROLE.manager, OFF], [{ user: 'crew.static' }, {}]]) assert.equal(visiblePay(session, hubEnv, 'requests', ratedRequest), ratedRequest);
});

// Second review: a read hides every key the write guard treats as pay. The owner (or a manager while every business user
// could write pay) may have stored a rate-like key on another employee's profile, timecard or time-off request; no reader
// pays from those keys, but a manager's GET must not hand them out either.
test('HTTP reads: rate-like pay keys on another employee\'s profile, timecard or time-off request never reach a manager; the owner, the employee and the flag off see them', async t => {
  const { post, get, pto, ptoList, legacy, read } = await vault(t);
  // Canaries no hour count, id or timestamp contains, one per rate-like key.
  const RATES = { regularRate: 31.97, overtimeRate: 47.93, ptoRate: 27.83, payRate: 29.41, overtimeMultiplier: 1.37, rate: 23.19, paidRate: 33.61 };
  assert.equal((await post(env, 'ZacB', 'profiles', 'crew.static', { username: 'Crew.Static', jobTitle: 'Synthetic crew', ...RATES })).status, 200);
  assert.equal((await post(env, 'ZacB', 'timeEntries', 'rated-card', shift('Crew.Static', { hourlyRate: 19, ...RATES }))).status, 200);
  // The time off is sent and approved through the request workflow; the owner's rate-like keys on it are an older save.
  const requested = await pto(env, 'Crew.Static', ask('2026-09-24', { paid: true, hoursPerDay: 8 }));
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  const ratedPto = requested.body.request.id;
  assert.equal((await pto(env, 'ZacB', { action: 'approve', id: ratedPto })).status, 200);
  await legacy('requests', ratedPto, RATES);
  // Precondition: every canary is stored on all three records, so a leak would show.
  for (const [collection, id] of [['profiles', 'crew.static'], ['timeEntries', 'rated-card'], ['requests', ratedPto]]) {
    const stored = await read(collection, id);
    assert.deepEqual(Object.keys(RATES).map(key => stored[key]), Object.values(RATES), `${collection} stored`);
  }
  const rows = body => ({
    profiles: body.collections.profiles.find(row => row.username === 'Crew.Static'),
    timeEntries: body.collections.timeEntries.find(row => row.id === 'rated-card'),
    requests: body.collections.requests.find(row => row.id === ratedPto),
  });
  const canaries = Object.values(RATES);
  for (const user of ['TylerG', 'AlexK']) {
    const body = await get(env, user);
    assert.equal(body.payVisibility, 'own', user);
    for (const [collection, row] of Object.entries(rows(body))) {
      assert.ok(row, `${user} still sees the ${collection} record`);
      assert.deepEqual(PAY_WRITE_FIELDS.filter(key => Object.hasOwn(row, key)), [], `${user} ${collection}`);
    }
    assert.deepEqual([rows(body).requests.hoursPerDay, rows(body).requests.paidHours], [8, 8], 'paid time-off hours are hours, not pay, and stay');
    assert.equal(rows(body).requests.status, 'approved');
    assert.deepEqual(numbers(body).filter(value => canaries.includes(value)), [], `${user}: no canary anywhere in the response`);
    // The request workflow's list keeps the paid hours and hands out no rate-like key either.
    const list = await ptoList(env, user), row = list.requests.find(item => item.id === ratedPto);
    assert.deepEqual([row.employee, row.status, row.hoursPerDay, row.paidHours], ['crew.static', 'approved', 8, 8], `${user} /api/employee-pto`);
    assert.deepEqual(PAY_WRITE_FIELDS.filter(key => Object.hasOwn(row, key)), [], `${user} /api/employee-pto`);
    assert.deepEqual(numbers(list).filter(value => canaries.includes(value)), [], `${user}: no canary in the request workflow's list`);
  }
  // The owner, the employee (their own records) and every business user with the flag off get the keys as stored.
  for (const [label, hubEnv, user] of [['owner', env, 'ZacB'], ['employee', env, 'Crew.Static'], ['flag off', { ...env, ...OFF }, 'TylerG']]) {
    const found = rows(await get(hubEnv, user));
    for (const [collection, row] of Object.entries(found)) assert.deepEqual(Object.keys(RATES).map(key => row?.[key]), Object.values(RATES), `${label} ${collection}`);
  }
});

// Fourth check: a time-off request carries the pay the owner stored on it and its approved paid hours, so moving it onto
// yourself would hand you both (the GET shows your own records unfiltered). With the flag on only the owner moved one
// through the generic write. Since the request workflow (P1-06) nobody moves one, in either direction, with the flag on or
// off and the owner included: the generic write refuses every requests write, and no workflow action names an employee.
// A refused move writes nothing, and a manager still changes the paid hours in place.
test('HTTP writes: a manager or crew lead cannot move another employee\'s time-off request (its pay and paid hours) onto themselves; since the request workflow nobody moves one, with the flag off or as the owner', async t => {
  const { fire, post, get, pto, ptoList, legacy, read } = await vault(t);
  // Canaries no hour count, id or timestamp contains.
  const PTO_RATE = 52.19, PAID_RATE = 48.71;
  const canary = body => { const text = JSON.stringify(body); return [PTO_RATE, PAID_RATE].filter(value => text.includes(String(value)) || numbers(body).includes(value)); };
  const requested = await pto(env, 'Crew.Static', ask('2026-09-24', { paid: true, hoursPerDay: 8 }));
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  const crewPto = requested.body.request.id, approved = await pto(env, 'ZacB', { action: 'approve', id: crewPto });
  assert.deepEqual([approved.status, approved.body.request.status, approved.body.request.paidHours], [200, 'approved', 8]);
  // The owner's canary pay on the request is an older save (no endpoint stores one now).
  await legacy('requests', crewPto, { ptoRate: PTO_RATE, paidRate: PAID_RATE });
  const kept = async (label, hours = 8) => {
    const saved = await read('requests', crewPto);
    assert.deepEqual([saved.employee, saved.status, saved.hoursPerDay, saved.paidHours, saved.ptoRate, saved.paidRate], ['crew.static', 'approved', hours, hours, PTO_RATE, PAID_RATE], label);
  };
  // Precondition: the stored request carries the canaries, so the checks below can see a leak.
  await kept('stored');
  for (const [flag, hubEnv] of FLAGS) for (const user of ['TylerG', 'AlexK']) {
    const before = fire.snapshot();
    for (const [name, data] of [['move', { employee: user }], ['respelled move', { employee: ` ${user.toLowerCase()} ` }], ['move with approval', { employee: user, status: 'approved', paidHoursPerDay: 8 }]]) {
      const label = `${flag}/${user} ${name}`, moved = await post(hubEnv, user, 'requests', crewPto, data);
      assert.deepEqual([moved.status, moved.code, moved.body.ok], [...WORKFLOW, false], label);
      assert.deepEqual(canary(moved.body), [], `${label}: no canary in the answer`);
      assert.equal(Object.hasOwn(moved.body, 'record'), false, label);
      for (const action of ['approve', 'amend', 'end', 'cancel', 'deny']) {
        const workflow = await pto(hubEnv, user, { action, id: crewPto, employee: data.employee });
        assert.deepEqual(outcome(workflow), UNSUPPORTED, `${label} through ${action}`);
        assert.deepEqual(canary(workflow.body), [], `${label} through ${action}: no canary in the answer`);
        assert.equal(Object.hasOwn(workflow.body, 'request'), false, `${label} through ${action}`);
      }
    }
    assert.equal(fire.snapshot(), before, `${flag}/${user}: a refused move writes nothing`);
    await kept(`${flag}/${user}`);
    // The request is still the crew member's in the refused user's views, with its paid hours and (flag on) without its pay.
    if (flag === 'on') {
      const body = await get(env, user), row = body.collections.requests.find(item => item.id === crewPto);
      assert.deepEqual([row.employee, row.status, row.hoursPerDay, row.paidHours], ['crew.static', 'approved', 8, 8], user);
      assert.deepEqual(canary(body), [], `${user}: no canary in the GET`);
    }
    const list = await ptoList(hubEnv, user), row = list.requests.find(item => item.id === crewPto);
    assert.deepEqual([row.employee, row.status, row.paidHours], ['crew.static', 'approved', 8], `${flag}/${user} /api/employee-pto`);
    assert.deepEqual(canary(list), [], `${flag}/${user}: no canary in the request workflow's list`);
  }
  // Nor the other way: the manager's own request cannot be moved onto a crew member, nor sent in their name.
  const own = await pto(env, 'TylerG', ask('2026-09-25'));
  assert.equal(own.status, 200, JSON.stringify(own.body));
  const tylerPto = own.body.request.id, before = fire.snapshot();
  assert.deepEqual(outcome(await post(env, 'TylerG', 'requests', tylerPto, { employee: 'Crew.Static' })), WORKFLOW);
  for (const action of ['amend', 'cancel']) assert.deepEqual(outcome(await pto(env, 'TylerG', { action, id: tylerPto, employee: 'Crew.Static' })), UNSUPPORTED, action);
  assert.deepEqual(outcome(await pto(env, 'TylerG', ask('2026-09-26', { employee: 'Crew.Static' }))), UNSUPPORTED, 'a request in another employee\'s name');
  assert.equal(fire.snapshot(), before);
  assert.equal((await read('requests', tylerPto)).employee, 'tylerg');
  // Changing the crew member's paid hours in place still works (hours, not pay), and its answer carries no pay.
  const amended = await pto(env, 'TylerG', { action: 'amend', id: crewPto, paid: true, hoursPerDay: 6 });
  assert.equal(amended.status, 200, JSON.stringify(amended.body));
  assert.deepEqual([amended.body.request.employee, amended.body.request.paidHours], ['crew.static', 6]);
  assert.deepEqual(canary(amended.body), []);
  await kept('changed in place', 6);
  // The owner, who moved one through the generic write before the workflow, cannot either.
  const ownerBefore = fire.snapshot();
  assert.deepEqual(outcome(await post(env, 'ZacB', 'requests', crewPto, { employee: 'ZacB' })), WORKFLOW, 'owner');
  assert.deepEqual(outcome(await pto(env, 'ZacB', { action: 'amend', id: crewPto, paid: true, hoursPerDay: 6, employee: 'ZacB' })), UNSUPPORTED, 'owner');
  assert.equal(fire.snapshot(), ownerBefore);
  await kept('never moved', 6);
});

test('the payroll week card is loaded as its own file, before the suite that mounts it, and builds its DOM without innerHTML', () => {
  const html = readFileSync(new URL('../employee.html', import.meta.url), 'utf8'), suite = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8'), module = readFileSync(new URL('../employee-payroll-week.js', import.meta.url), 'utf8');
  const script = html.indexOf('<script src="employee-payroll-week.js?v='), css = html.indexOf('<link rel="stylesheet" href="employee-payroll-week.css?v=');
  assert.ok(script > 0 && css > 0 && script < html.indexOf('<script src="employee-suite.js?v='));
  // Updated deliberately (GUSTO-EXPORT): the card also gets the owner grant, which shows its Gusto hours button (the server
  // still refuses anyone but the owner).
  assert.match(suite, /if\(isManager\(\)&&host\)window\.EGCPayrollWeek\?\.mount\(host,\{startDate:range\.startDate,identity:employeeIdentity\(\),owner:isOwnerAccount\(\),timecards:S\.people\.timeEntries,requests:S\.people\.requests\}\);/);
  // Security invariant: server data only reaches the page through textContent (the h() helper).
  assert.doesNotMatch(module, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
});
