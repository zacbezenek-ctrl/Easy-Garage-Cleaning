process.env.TZ = 'Asia/Tokyo';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { GUSTO_HOURS_COLUMNS, GUSTO_NOT_INCLUDED_HEADER, gustoHoursCsv, gustoHoursFile, gustoHoursFilename, gustoHoursRows, payrollCsv } from '../functions/_lib/payroll-export.js';
import { computeTimesheetWeek, ptoFromRequests } from '../functions/_lib/timesheet-week.js';
import { DIRECTORY_PROFILE_FIELDS, createStaffDirectoryService, gustoPayrollProfiles, legacyProfileInput, legacyProfileView } from '../functions/_lib/staff-directory.js';
import { listHubUserProfiles } from '../functions/_lib/hub-session.js';
import { gustoConfiguration, gustoStatus } from '../functions/_lib/gusto-client.js';
import { opaqueId, open, writeOne } from '../functions/_lib/employee-vault.js';
import { timesheetHandlers, onRequestGet as timesheetsGet } from '../functions/api/timesheets.js';
import { staffDirectoryHandlers } from '../functions/api/staff-directory.js';
import * as employeeHub from '../functions/api/employee-hub.js';
import { cookieFor, jsonRequest, login, seedAccount, staffEnv, vaultFirestore } from './helpers/vault-fixture.mjs';

// Every week here is injected: fixed timecards and requests, a fixed "now" after the week, and the handler's reads.
const NOW = new Date('2026-10-05T18:00:00.000Z');
// Denver is UTC-6 in September: hour `hour` (fractions allowed) of Denver date `date`.
const at = (date, hour) => new Date(Date.parse(`${date}T00:00:00Z`) + (hour + 6) * 3600000).toISOString();
const shift = (id, employee, name, date, from, to, extra = {}) => ({ id, employee, employeeName: name, payType: 'hourly', hourlyRate: 22, clockInAt: at(date, from), clockOutAt: at(date, to), status: 'submitted', approvalStatus: 'approved', breaks: [], ...extra });
const meal = (date, from) => [{ startAt: at(date, from + 4), endAt: at(date, from + 4.5) }];
// The two payroll audit weeks (OPS-13). 56.5 h: six shifts with a 30-minute unpaid meal each, 13 h on Monday (1 h over
// 12 that day) and 56.5 h in the week, so weekly overtime (16.5 h) pays more than daily. 57 h: Monday to Friday
// 06:00-17:00, Thursday to 19:00 (13 h), no breaks: weekly overtime 17 h, daily 1 h.
const AUDIT_56_5 = [['2026-09-14', 5, 18.5], ['2026-09-15', 6, 16], ['2026-09-16', 6, 16], ['2026-09-17', 6, 16], ['2026-09-18', 6, 16], ['2026-09-19', 8, 14]]
  .map(([date, from, to]) => shift(`maria-${date}`, 'Maria.Synthetic', 'Synthetic Maria', date, from, to, { breaks: meal(date, from) }));
const AUDIT_57 = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'].map(date => shift(`crew-${date}`, 'Crew.One', 'Synthetic Crew One', date, 6, date === '2026-09-24' ? 19 : 17));
// What the handler reads from the staff directory's profiles (gustoPayrollProfiles): username to its Gusto fields.
const gusto = (gustoEmployeeId, extra = {}) => ({ gustoEmployeeId, gustoExcluded: false, displayName: null, ...extra });
const IDS = new Map([['maria.synthetic', gusto('gusto-syn-1001')], ['crew.one', gusto('gusto-syn-1002')], ['crew.two', gusto('gusto-syn-1003')], ['crew.three', gusto('gusto-syn-1004', { displayName: 'Synthetic Crew Three' })]]);
const ROLE = {
  owner: { user: 'ZacB', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true },
  manager: { user: 'TylerG', displayName: 'Synthetic Manager', role: 'manager', businessAccess: true },
  crew_lead: { user: 'AlexK', displayName: 'Synthetic Lead', role: 'crew_lead', businessAccess: true },
  crew: { user: 'Crew.One', displayName: 'Synthetic Crew One', role: 'crew' },
};
const parse = csv => csv.trimEnd().split('\r\n').map(line => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map(match => match[1].replaceAll('""', '"')));
const request = query => new Request(`https://easygaragecleaning.com/api/timesheets${query}`);
// The handler with injected session, records, Gusto IDs and clock; counts every read so refusals can prove they read nothing.
function exporter({ session = ROLE.owner, timecards = AUDIT_57, requests = [], ids = IDS, now = NOW } = {}) {
  const calls = { read: 0, ids: 0 };
  const handler = timesheetHandlers({ session: async () => session, read: async () => { calls.read++; return { timecards, requests }; }, gustoProfiles: async () => { calls.ids++; return ids; }, now: () => now }).get;
  const get = async (query, env = {}) => { const response = await handler({ request: request(query), env }); return { response, text: await response.text() }; };
  return { get, calls };
}
const refusal = async (result, status, code) => {
  assert.equal(result.response.status, status, result.text);
  const body = JSON.parse(result.text);
  assert.deepEqual([body.ok, body.code], [false, code]);
  assert.equal(result.response.headers.get('Cache-Control'), 'no-store');
  return body;
};
// Hours the payroll engine gives a row, to the hundredth, as the payroll CSV lists them to the thousandth.
const csvRow = (week, employee) => parse(payrollCsv(week)).find(row => row[1] === employee);

test('the column layout is the one exported constant, and the file is written from it alone', () => {
  assert.deepEqual(GUSTO_HOURS_COLUMNS.map(([header]) => header), ['Gusto employee ID', 'Employee name', 'Regular hours', 'Overtime hours', 'Double overtime hours', 'Paid time off hours']);
  assert.ok(Object.isFrozen(GUSTO_HOURS_COLUMNS) && GUSTO_HOURS_COLUMNS.every(Object.isFrozen));
  const week = computeTimesheetWeek({ timecards: AUDIT_57, weekStart: '2026-09-21', now: NOW.toISOString() });
  const rows = gustoHoursRows(week, IDS), csv = parse(gustoHoursCsv(week, IDS));
  assert.deepEqual(csv[0], GUSTO_HOURS_COLUMNS.map(([header]) => header));
  assert.deepEqual(csv.slice(1), rows.map(row => GUSTO_HOURS_COLUMNS.map(([, field]) => row[field])), 'every cell comes from the constant\'s field for its column');
  assert.equal(gustoHoursFilename(week), 'egc-gusto-hours-2026-09-21-to-2026-09-27.csv');
});

const golden = name => new URL(`./snapshots/gusto-hours-${name}.csv`, import.meta.url);
for (const [name, label, timecards, weekStart, employee] of [['57h', '57 h', AUDIT_57, '2026-09-21', 'crew.one'], ['56_5h', '56.5 h', AUDIT_56_5, '2026-09-14', 'maria.synthetic']]) {
  test(`golden file: the ${label} audit week, from the payroll engine's Colorado overtime`, async () => {
    const { get, calls } = exporter({ timecards });
    const { response, text } = await get(`?view=week&start=${weekStart}&format=gusto`);
    assert.equal(response.status, 200, text);
    assert.deepEqual([response.headers.get('Content-Type'), response.headers.get('Cache-Control'), response.headers.get('X-Content-Type-Options'), response.headers.get('Content-Disposition')],
      ['text/csv; charset=utf-8', 'no-store', 'nosniff', `attachment; filename="egc-gusto-hours-${weekStart}-to-${computeTimesheetWeek({ timecards, weekStart, now: NOW.toISOString() }).weekEnd}.csv"`]);
    assert.ok(text.endsWith('\r\n') && !/[^\r]\n/.test(text), 'CRLF rows only');
    // The golden file is kept with LF line ends (the repository's whitespace checks flag CR); the file sent is compared with it
    // byte for byte once its rows are CRLF again, whatever line ends a checkout gave it.
    if (process.env.UPDATE_SNAPSHOTS === '1') { mkdirSync(new URL('./snapshots/', import.meta.url), { recursive: true }); writeFileSync(golden(name), text.replaceAll('\r\n', '\n')); }
    assert.equal(text, readFileSync(golden(name), 'utf8').replace(/\r?\n/g, '\r\n'));
    assert.deepEqual(calls, { read: 1, ids: 1 });
    // The hours are the engine's own: the same week's regular, overtime, double-time and PTO in the payroll CSV.
    const week = computeTimesheetWeek({ timecards, weekStart, now: NOW.toISOString() }), row = week.employees[0], line = parse(text)[1], payroll = csvRow(week, employee);
    assert.deepEqual([row.workedHours, row.regularHours, row.overtimeHours, row.overtimeBasis], label === '57 h' ? [57, 40, 17, 'weekly'] : [56.5, 40, 16.5, 'weekly']);
    assert.deepEqual(line.slice(2).map(Number), payroll.slice(5, 9).map(Number));
    assert.deepEqual(line.slice(0, 2), [IDS.get(employee).gustoEmployeeId, row.name]);
    assert.equal(response.headers.get(GUSTO_NOT_INCLUDED_HEADER), null, 'nobody was left out');
  });
}

test('overtime follows the payroll engine\'s policy (Colorado daily over 12, weekly over 40) and is never recomputed', async () => {
  // Three 14-hour days: Colorado pays 6 h of daily overtime (more than 2 h weekly); federal pays the 2 h weekly only.
  const long = ['2026-09-21', '2026-09-22', '2026-09-23'].map(date => shift(`long-${date}`, 'Crew.Two', 'Synthetic Crew Two', date, 6, 20));
  const { get } = exporter({ timecards: long });
  const colorado = parse((await get('?view=week&start=2026-09-21&format=gusto')).text)[1], federal = parse((await get('?view=week&start=2026-09-21&format=gusto', { EGC_OVERTIME_POLICY: 'federal' })).text)[1];
  assert.deepEqual(colorado, ['gusto-syn-1003', 'Synthetic Crew Two', '36.00', '6.00', '0.00', '0.00']);
  assert.deepEqual(federal, ['gusto-syn-1003', 'Synthetic Crew Two', '40.00', '2.00', '0.00', '0.00']);
  for (const [policy, line] of [['colorado', colorado], ['federal', federal]]) {
    const week = computeTimesheetWeek({ timecards: long, weekStart: '2026-09-21', policy, now: NOW.toISOString() });
    assert.deepEqual(line.slice(2).map(Number), csvRow(week, 'crew.two').slice(5, 9).map(Number), policy);
  }
  // A policy the engine refuses stops the file too.
  assert.equal((await refusal(await get('?view=week&start=2026-09-21&format=gusto', { EGC_OVERTIME_POLICY: 'california' }), 503, 'timesheet_policy_invalid')).ok, false);
});

test('hours are hundredths: overtime rounds half up and regular is the rounded worked total less overtime, so a row adds up', () => {
  // Monday 12 h 0 min 18 s (0.005 h over 12) and Tuesday 8 h 0 min 18 s: 20.010 h worked, 0.005 h overtime, 20.005 h regular.
  const cards = [shift('mon', 'Crew.One', 'Synthetic Crew One', '2026-09-21', 6, 18.005), shift('tue', 'Crew.One', 'Synthetic Crew One', '2026-09-22', 6, 14.005)];
  const week = computeTimesheetWeek({ timecards: cards, weekStart: '2026-09-21', now: NOW.toISOString() }), row = week.employees[0];
  assert.deepEqual([row.workedHours, row.overtimeHours, row.regularHours], [20.01, 0.005, 20.005]);
  const [line] = gustoHoursRows(week, IDS);
  assert.deepEqual([line.regularHours, line.overtimeHours, line.doubleTimeHours], ['20.00', '0.01', '0.00']);
  assert.equal((Number(line.regularHours) + Number(line.overtimeHours)).toFixed(2), row.workedHours.toFixed(2), 'the columns add up to the worked hours');
});

test('paid time off is the approved PTO the payroll engine pays; unpaid, pending and other weeks\' time off is not', async () => {
  const approval = { reviewedBy: 'zacb', reviewedAt: '2026-09-20T15:00:00.000Z', decisions: [{ action: 'approve', status: 'approved', by: 'zacb', at: '2026-09-20T15:00:00.000Z' }] };
  const requests = [
    { id: 'pto-crew', type: 'time_off', status: 'approved', employee: 'Crew.One', startDate: '2026-09-26', endDate: '2026-09-29', paid: true, hoursPerDay: 7.5, paidDates: ['2026-09-26', '2026-09-28'], ...approval },
    { id: 'pto-only', type: 'time_off', status: 'approved', employee: 'Crew.Three', startDate: '2026-09-24', endDate: '2026-09-25', paidHoursPerDay: 8 },
    { id: 'pto-pending', type: 'time_off', status: 'pending', employee: 'Crew.Two', startDate: '2026-09-24', endDate: '2026-09-24', paid: true, hoursPerDay: 8 },
    { id: 'pto-unpaid', type: 'time_off', status: 'approved', employee: 'Crew.Two', startDate: '2026-09-25', endDate: '2026-09-25', paid: false, ...approval },
  ];
  const timecards = [...AUDIT_57, shift('two', 'Crew.Two', 'Synthetic Crew Two', '2026-09-23', 8, 12)];
  const { get } = exporter({ timecards, requests });
  // Crew Three has only time off, so no timecard rate to pay it at: flagged, as in the payroll CSV, until acknowledged.
  assert.deepEqual((await refusal(await get('?view=week&start=2026-09-21&format=gusto'), 409, 'timesheet_incomplete')).details.acknowledgeable, ['missing_pto_rate']);
  const { text, response } = await get('?view=week&start=2026-09-21&format=gusto&acknowledge=missing_pto_rate');
  assert.equal(response.status, 200, text);
  const rows = parse(text).slice(1);
  // Crew Three has only time off, so the week knows only the username: the file names them by their profile's display name.
  assert.equal(computeTimesheetWeek({ timecards, pto: ptoFromRequests(requests), weekStart: '2026-09-21', now: NOW.toISOString() }).employees.find(row => row.employee === 'crew.three').name, 'Crew.Three');
  assert.deepEqual(rows, [
    ['gusto-syn-1004', 'Synthetic Crew Three', '0.00', '0.00', '0.00', '16.00'],
    ['gusto-syn-1002', 'Synthetic Crew One', '40.00', '17.00', '0.00', '7.50'],
    ['gusto-syn-1003', 'Synthetic Crew Two', '4.00', '0.00', '0.00', '0.00'],
  ]);
  const week = computeTimesheetWeek({ timecards, pto: ptoFromRequests(requests), weekStart: '2026-09-21', now: NOW.toISOString() });
  for (const [employee, id] of [['crew.one', 'gusto-syn-1002'], ['crew.two', 'gusto-syn-1003'], ['crew.three', 'gusto-syn-1004']]) {
    assert.equal(Number(rows.find(row => row[0] === id)[5]), week.employees.find(row => row.employee === employee).ptoHours, employee);
  }
  // Without a display name on the profile the username stays; a timecard's own name is never replaced.
  const plain = new Map([...IDS, ['crew.three', gusto('gusto-syn-1004')], ['crew.one', gusto('gusto-syn-1002', { displayName: 'Profile Name' })]]);
  const names = gustoHoursRows(week, plain).map(row => [row.gustoEmployeeId, row.name]);
  assert.deepEqual(names, [['gusto-syn-1004', 'Crew.Three'], ['gusto-syn-1002', 'Synthetic Crew One'], ['gusto-syn-1003', 'Synthetic Crew Two']]);
});

test('an unsettled week is refused like the payroll CSV, before any Gusto ID is read', async () => {
  const pending = [...AUDIT_57, shift('late', 'Crew.Two', 'Synthetic Crew Two', '2026-09-26', 8, 12, { approvalStatus: 'pending' })];
  const open = [...AUDIT_57, shift('open', 'Crew.Two', 'Synthetic Crew Two', '2026-09-26', 8, 12, { clockOutAt: '', status: 'active', approvalStatus: 'pending' })];
  const needsReview = [...AUDIT_57, shift('bad', 'Crew.Two', 'Synthetic Crew Two', '2026-09-26', 8, 12, { breaks: [{ startAt: at('2026-09-26', 9) }] })];
  for (const [label, options, reason] of [['week in progress', { now: new Date('2026-09-24T18:00:00Z') }, 'week_in_progress'], ['pending timecard', { timecards: pending }, 'pending_timecards'],
    ['open shift', { timecards: open }, 'open_shifts'], ['timecard to review', { timecards: needsReview }, 'needs_review']]) {
    const { get, calls } = exporter(options), body = await refusal(await get('?view=week&start=2026-09-21&format=gusto'), 409, 'timesheet_incomplete');
    assert.ok(body.details.blocking.includes(reason), label);
    assert.deepEqual(body.details.acknowledgeable, [], `${label}: nothing to acknowledge, it has to be settled`);
    assert.equal(calls.ids, 0, `${label}: no Gusto ID read`);
  }
  // Pending time is never included in the Gusto file, even on request.
  const pendingExport = exporter({ timecards: pending });
  await refusal(await pendingExport.get('?view=week&start=2026-09-21&format=gusto&includePending=1'), 400, 'timesheet_query_invalid');
  assert.deepEqual(pendingExport.calls, { read: 0, ids: 0 });
  // Pay-review flags stop it until acknowledged by name, as for the payroll CSV.
  const unrated = exporter({ timecards: AUDIT_57.map(card => ({ ...card, hourlyRate: undefined })) });
  const flagged = await refusal(await unrated.get('?view=week&start=2026-09-21&format=gusto'), 409, 'timesheet_incomplete');
  assert.deepEqual([flagged.details.blocking, flagged.details.acknowledgeable], [['missing_rate'], ['missing_rate']]);
  const acknowledged = await unrated.get('?view=week&start=2026-09-21&format=gusto&acknowledge=missing_rate');
  assert.equal(acknowledged.response.status, 200);
  assert.deepEqual(parse(acknowledged.text)[1], ['gusto-syn-1002', 'Synthetic Crew One', '40.00', '17.00', '0.00', '0.00'], 'a missing rate changes no hours');
  for (const query of ['?view=week&start=2026-09-21&format=gusto&acknowledge=pending_timecards', '?view=week&start=2026-09-21&acknowledge=missing_rate', '?view=week&start=2026-09-21&format=gusto&format=csv', '?view=week&start=2026-09-21&format=GUSTO']) {
    await refusal(await unrated.get(query), 400, 'timesheet_query_invalid');
  }
});

test('a missing Gusto employee ID stops the file and names each employee; so does one ID on two employees', async () => {
  const timecards = [...AUDIT_57, shift('two', 'Crew.Two', 'Synthetic Crew Two', '2026-09-23', 8, 12), shift('maria', 'Maria.Synthetic', 'Synthetic Maria', '2026-09-23', 8, 12)];
  // Maria's profile has no ID (her entry is there with none); Crew Two has no profile at all.
  const missing = new Map([['crew.one', gusto('gusto-syn-1002')], ['maria.synthetic', gusto(null, { displayName: 'Synthetic Maria' })]]);
  const off = await refusal(await exporter({ timecards, ids: missing }).get('?view=week&start=2026-09-21&format=gusto'), 409, 'timesheet_gusto_id_missing');
  assert.equal(off.error, 'Add the Gusto employee ID for Synthetic Crew Two (crew.two), Synthetic Maria (maria.synthetic) in the staff directory (Team), or mark them not paid through Gusto there, before downloading the Gusto hours file. Former employees are listed under Former staff at the end of the directory. The staff directory is off: the owner turns it on with EGC_STAFF_DIRECTORY_ENABLED=true.');
  assert.deepEqual(off.details.missing, [{ employee: 'crew.two', name: 'Synthetic Crew Two' }, { employee: 'maria.synthetic', name: 'Synthetic Maria' }]);
  const on = await refusal(await exporter({ timecards, ids: missing }).get('?view=week&start=2026-09-21&format=gusto', { EGC_STAFF_DIRECTORY_ENABLED: 'true' }), 409, 'timesheet_gusto_id_missing');
  assert.doesNotMatch(on.error, /staff directory is off/);
  assert.doesNotMatch(off.error + JSON.stringify(off.details), /gusto-syn/, 'the refusal never repeats the IDs that are set');
  const shared = new Map([['crew.one', gusto('GUSTO-SYN-7')], ['crew.two', gusto('gusto-syn-7')], ['maria.synthetic', gusto('gusto-syn-8')]]);
  const conflict = await refusal(await exporter({ timecards, ids: shared }).get('?view=week&start=2026-09-21&format=gusto'), 409, 'timesheet_gusto_id_conflict');
  assert.match(conflict.error, /^Synthetic Crew One \(crew\.one\), Synthetic Crew Two \(crew\.two\) have the same Gusto employee ID\./);
  assert.deepEqual(conflict.details.shared.map(row => row.employee), ['crew.one', 'crew.two']);
});

test('the Gusto hours file is the owner\'s: managers and business leads get 403 with the pay flag on or off, crew never reach it', async () => {
  for (const env of [{}, { EGC_STAFF_PAY_OWNER_ONLY: 'false' }, { EGC_STAFF_ROLE_PERMISSIONS: 'true' }]) {
    const owner = exporter();
    assert.equal((await owner.get('?view=week&start=2026-09-21&format=gusto', env)).response.status, 200);
    for (const session of [ROLE.manager, ROLE.crew_lead, { ...ROLE.manager, role: 'owner' }]) {
      const { get, calls } = exporter({ session }), body = await refusal(await get('?view=week&start=2026-09-21&format=gusto', env), 403, 'pay_owner_only');
      assert.equal(body.error, 'Only the owner can download the Gusto hours file. Managers review hours and approvals here.');
      assert.deepEqual(calls, { read: 0, ids: 0 }, `${session.user}: refused before any record or Gusto ID is read`);
    }
    const crew = exporter({ session: ROLE.crew });
    await refusal(await crew.get('?view=week&start=2026-09-21&format=gusto', env), 403, 'timesheet_forbidden');
    const nobody = exporter({ session: null });
    await refusal(await nobody.get('?view=week&start=2026-09-21&format=gusto', env), 401, 'timesheet_sign_in_required');
    assert.deepEqual([crew.calls, nobody.calls], [{ read: 0, ids: 0 }, { read: 0, ids: 0 }]);
  }
  // With the flag off a manager still gets the payroll CSV (PAY-TIMESHEETS), just not the Gusto file.
  assert.equal((await exporter({ session: ROLE.manager }).get('?view=week&start=2026-09-21&format=csv', { EGC_STAFF_PAY_OWNER_ONLY: 'false' })).response.status, 200);
});

test('the default reader fails closed: unconfigured storage and an unreadable profile read are 503s that leak nothing', async () => {
  const get = async gustoProfiles => {
    const response = await timesheetHandlers({ session: async () => ROLE.owner, read: async () => ({ timecards: AUDIT_57, requests: [] }), ...(gustoProfiles ? { gustoProfiles } : {}), now: () => NOW }).get({ request: request('?view=week&start=2026-09-21&format=gusto'), env: {} });
    return { response, text: await response.text() };
  };
  await refusal(await get(), 503, 'timesheet_storage_unconfigured');
  const leaked = await get(async () => { throw new Error('secret vault detail 42'); });
  await refusal(leaked, 503, 'timesheet_unavailable');
  assert.doesNotMatch(leaked.text, /secret/);
});

test('Gusto fields come from the profile the staff directory writes, under the username key before a legacy key', () => {
  const profiles = gustoPayrollProfiles([
    { id: 'crew.one', username: 'Crew.One', gustoEmployeeId: 'gusto-a', displayName: ' Synthetic Crew One ' },
    { id: 'crew-one', username: 'Crew.One', gustoEmployeeId: 'gusto-legacy', gustoExcluded: true },
    { id: 'crewtwo', username: 'Crew.Two', gustoEmployeeId: 'gusto-b', gustoExcluded: true },
    { id: 'stray', username: 'Crew.Three', gustoEmployeeId: 'gusto-stray' },
    { id: 'crew.four', username: 'Crew.Four', gustoEmployeeId: '=HYPERLINK("x")', gustoExcluded: 'yes' },
    { id: 'crew.five', username: 'Crew.Five', gustoEmployeeId: null },
    { id: 'crew.six', username: 'Crew.Six' },
    null, 'junk',
  ]);
  assert.deepEqual([...profiles], [
    ['crew.one', { gustoEmployeeId: 'gusto-a', gustoExcluded: false, displayName: 'Synthetic Crew One' }],
    ['crew.two', { gustoEmployeeId: 'gusto-b', gustoExcluded: true, displayName: null }],
    ['crew.four', { gustoEmployeeId: null, gustoExcluded: false, displayName: null }],
    ['crew.five', { gustoEmployeeId: null, gustoExcluded: false, displayName: null }],
    ['crew.six', { gustoEmployeeId: null, gustoExcluded: false, displayName: null }],
  ], 'an unreadable ID is none, only true marks someone not paid through Gusto, and a stray record under an unrecognized id is not read');
  assert.deepEqual([...gustoPayrollProfiles(undefined)], []);
  assert.deepEqual([...gustoPayrollProfiles([{ id: 'crew-one', username: 'Crew.One', gustoEmployeeId: 'gusto-legacy' }, { id: 'crew.one', username: 'Crew.One' }])], [['crew.one', { gustoEmployeeId: null, gustoExcluded: false, displayName: null }]], 'the key record wins even without an ID');
});

// The staff directory's owner-only Gusto employee ID (set_gusto_id), over an in-memory store with revision preconditions.
const people = Object.fromEntries(listHubUserProfiles(staffEnv()).map(profile => [profile.user, profile]));
const account = (username, extra = {}) => ({ username, displayName: `Synthetic ${username}`, status: 'approved', role: 'crew', payType: 'hourly', hourlyRate: 21, businessAccess: false, ...extra });
function memory({ accounts = [], profiles = [] } = {}) {
  let revision = 0;
  const next = () => `rev-${++revision}`, rows = new Map(profiles.map(data => [data.id, { documentId: `doc_${data.id}`, updateTime: next(), data: structuredClone(data) }]));
  const receipts = new Map(), commits = [], env = staffEnv();
  return { rows, commits, configured: () => true, readOnly: () => false,
    async staff() { return { configured: listHubUserProfiles(env), accounts: accounts.map(item => structuredClone(item)) }; },
    async profiles() { return [...rows.values()].map(row => structuredClone(row)); },
    async readAccount() { return null; },
    async readReceipt(id) { return structuredClone(receipts.get(id) ?? null); },
    async fingerprint(text) { return createHash('sha256').update(text).digest('hex'); },
    async commit(plan) {
      if ((rows.get(plan.profile.id)?.updateTime || '') !== (plan.profile.revision || '') || receipts.has(plan.receipt.id)) throw Object.assign(new Error('changed'), { code: 'staff_directory_revision_conflict', status: 409 });
      const updateTime = next();
      rows.set(plan.profile.id, { documentId: rows.get(plan.profile.id)?.documentId || `doc_${plan.profile.id}`, updateTime, data: structuredClone(plan.profile.data) });
      receipts.set(plan.receipt.id, { ...structuredClone(plan.receipt.data), id: plan.receipt.id });
      commits.push(structuredClone(plan));
      return { profileRevision: updateTime };
    } };
}
const directoryFor = store => createStaffDirectoryService({ store, env: staffEnv(), now: () => NOW });
const setId = (username, revision, gustoEmployeeId, extra = {}) => ({ action: 'set_gusto_id', requestId: randomUUID(), username, expectedRevision: revision, gustoEmployeeId, ...extra });
const rejects = (promise, code, status) => assert.rejects(promise, error => error.code === code && error.status === status);
const crewSession = user => ({ user, displayName: `Synthetic ${user}`, role: 'crew', payType: 'hourly', hourlyRate: 21, businessAccess: false });

test('only the owner sets a Gusto employee ID; it is checked, unique, clearable and audited without the ID', async () => {
  const store = memory({ accounts: [account('Crew.One'), account('Crew.Two')], profiles: [{ id: 'crew.one', username: 'Crew.One', hourlyRate: 21 }, { id: 'crew.two', username: 'Crew.Two', gustoEmployeeId: 'gusto-syn-2' }] });
  const directory = directoryFor(store), revision = () => store.rows.get('crew.one').updateTime;
  for (const session of [people.TylerG, people.AlexK, crewSession('Crew.One')]) {
    await rejects(directory.mutate(session, setId('Crew.One', revision(), 'gusto-syn-1')), 'staff_directory_forbidden', 403);
  }
  for (const value of ['has space', '-leading-dash', 'x'.repeat(65), '=cmd', 42, null]) await rejects(directory.mutate(people.ZacB, setId('Crew.One', revision(), value)), 'staff_directory_invalid_gusto_id', 400);
  await rejects(directory.mutate(people.ZacB, setId('Crew.One', revision(), 'GUSTO-SYN-2')), 'staff_directory_gusto_id_in_use', 409);
  await rejects(directory.mutate(people.ZacB, setId('Crew.One', revision(), 'gusto-syn-1', { hourlyRate: 99 })), 'staff_directory_invalid_request', 400);
  assert.equal(store.commits.length, 0);
  const saved = await directory.mutate(people.ZacB, setId('Crew.One', revision(), '  gusto-syn-1  ', { reason: 'Synthetic setup' }));
  assert.equal(saved.person.gustoEmployeeId, 'gusto-syn-1');
  assert.equal(store.rows.get('crew.one').data.gustoEmployeeId, 'gusto-syn-1');
  assert.equal(store.rows.get('crew.one').data.hourlyRate, 21, 'other profile fields are kept');
  const entry = store.rows.get('crew.one').data.history.at(-1);
  // The ID is kept in the sealed, owner-only profile history; only the plaintext audit entry leaves it out.
  assert.deepEqual([entry.action, entry.scope, entry.actor, entry.reason, entry.changes], ['set_gusto_id', 'gusto', 'ZacB', 'Synthetic setup', { before: { gustoEmployeeId: null, gustoExcluded: false }, after: { gustoEmployeeId: 'gusto-syn-1', gustoExcluded: false } }]);
  const audit = store.commits.at(-1).audit.patch;
  assert.deepEqual([audit.action, audit.visibility, JSON.parse(audit.after)], ['staff_directory.set_gusto_id', 'owner', { gustoEmployeeIdSet: true, gustoExcluded: false }]);
  assert.doesNotMatch(JSON.stringify(store.commits.at(-1).audit), /gusto-syn/, 'the plaintext audit entry never carries the ID');
  const same = await directory.mutate(people.ZacB, setId('Crew.One', saved.person.revision, 'gusto-syn-1'));
  assert.equal(same.unchanged, true); assert.equal(store.commits.length, 1);
  const cleared = await directory.mutate(people.ZacB, setId('Crew.One', saved.person.revision, ''));
  assert.equal(cleared.person.gustoEmployeeId, null); assert.equal(store.rows.get('crew.one').data.gustoEmployeeId, null);
  // Configured Hub users have one too (their pay lives in the Hub configuration, their Gusto ID here).
  const tyler = await directory.mutate(people.ZacB, setId('TylerG', '', 'gusto-syn-9'));
  assert.equal(tyler.person.gustoEmployeeId, 'gusto-syn-9');
  assert.deepEqual([...gustoPayrollProfiles([...store.rows.values()].map(row => row.data))].filter(([, entry]) => entry.gustoEmployeeId).map(([key, entry]) => [key, entry.gustoEmployeeId]), [['crew.two', 'gusto-syn-2'], ['tylerg', 'gusto-syn-9']]);
});

test('the Gusto employee ID is never shown to crew or managers: not in their directory view, its history or the legacy profile read', async () => {
  const store = memory({ accounts: [account('Crew.One')], profiles: [{ id: 'crew.one', username: 'Crew.One', hourlyRate: 21 }] }), directory = directoryFor(store);
  await directory.mutate(people.ZacB, setId('Crew.One', store.rows.get('crew.one').updateTime, 'gusto-syn-canary'));
  const owner = await directory.list(people.ZacB);
  assert.equal(owner.people.find(person => person.username === 'Crew.One').gustoEmployeeId, 'gusto-syn-canary');
  assert.ok(owner.people.every(person => Object.hasOwn(person, 'gustoEmployeeId')), 'the owner sees every ID, null where unset');
  assert.equal(owner.people.find(person => person.username === 'Crew.One').history.at(-1).action, 'set_gusto_id');
  for (const session of [crewSession('Crew.One'), people.TylerG, people.AlexK]) {
    const view = await directory.list(session), text = JSON.stringify(view);
    assert.doesNotMatch(text, /gusto-syn-canary|gustoEmployeeId|gustoExcluded|set_gusto_id|formerStaff/, session.user);
    assert.ok(view.people.length > 0);
  }
  // The legacy /api/employee-hub profile view and save never carry or set it.
  const stored = store.rows.get('crew.one').data;
  assert.equal(legacyProfileView(stored, NOW.toISOString()).gustoEmployeeId, undefined);
  assert.ok(DIRECTORY_PROFILE_FIELDS.includes('gustoEmployeeId'));
  assert.equal(Object.hasOwn(legacyProfileInput({ gustoEmployeeId: 'forged', jobTitle: 'x' }), 'gustoEmployeeId'), false);
});

test('HTTP end to end: the owner saves a Gusto ID in the staff directory and the default reader keys the Gusto file by it; crew never see it', async t => {
  const fire = vaultFirestore(t), env = staffEnv({ EGC_STAFF_DIRECTORY_ENABLED: 'true' });
  t.mock.timers.enable({ apis: ['Date'], now: NOW.getTime() });
  await seedAccount(env, 'Crew.Account');
  await writeOne(env, 'profiles', 'crew.account', { username: 'Crew.Account', hourlyRate: 21 }, { data: null }, NOW.toISOString());
  const directory = staffDirectoryHandlers({ now: () => NOW }), owner = await cookieFor(env, 'ZacB'), manager = await cookieFor(env, 'TylerG');
  const list = async cookie => { const response = await directory.get({ env, request: jsonRequest('/api/staff-directory', undefined, cookie) }); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  const person = (await list(owner)).people.find(item => item.username === 'Crew.Account');
  assert.equal(person.gustoEmployeeId, null);
  const managerSet = await directory.post({ env, request: jsonRequest('/api/staff-directory', setId('Crew.Account', person.revision, 'gusto-syn-e2e'), manager) });
  assert.deepEqual([managerSet.status, (await managerSet.json()).code], [403, 'staff_directory_forbidden']);
  const saved = await directory.post({ env, request: jsonRequest('/api/staff-directory', setId('Crew.Account', person.revision, 'gusto-syn-e2e'), owner) });
  assert.equal(saved.status, 200, await saved.clone().text());
  const documentId = await opaqueId(env, 'profiles', 'crew.account'), doc = fire.documents.get(`jobs/${documentId}`);
  assert.doesNotMatch(JSON.stringify(doc), /gusto-syn-e2e/, 'the ID is sealed in the vault');
  assert.equal((await open(env, documentId, doc.fields.sealedIv.stringValue, doc.fields.sealedPayload.stringValue)).gustoEmployeeId, 'gusto-syn-e2e');
  // Crew and managers: not in the directory, not in the legacy /api/employee-hub read.
  const { cookie: crew } = await login(env, 'Crew.Account');
  for (const cookie of [crew, manager]) {
    assert.doesNotMatch(JSON.stringify(await list(cookie)), /gusto-syn-e2e|gustoEmployeeId/);
    const hub = await employeeHub.onRequestGet({ env, request: jsonRequest('/api/employee-hub', undefined, cookie) });
    assert.equal(hub.status, 200, await hub.clone().text());
    assert.doesNotMatch(await hub.text(), /gusto-syn-e2e|gustoEmployeeId/);
  }
  // A forged legacy profile save by a manager cannot change it.
  const forged = await employeeHub.onRequestPost({ env, request: jsonRequest('/api/employee-hub', { collection: 'profiles', id: 'crew.account', data: { username: 'Crew.Account', jobTitle: 'Synthetic', gustoEmployeeId: 'forged' } }, manager) });
  assert.equal(forged.status, 200, await forged.clone().text());
  assert.doesNotMatch(await forged.text(), /gusto-syn-e2e|forged"/);
  const after = fire.documents.get(`jobs/${documentId}`);
  assert.equal((await open(env, documentId, after.fields.sealedIv.stringValue, after.fields.sealedPayload.stringValue)).gustoEmployeeId, 'gusto-syn-e2e');
  // The owner's Gusto file, read through the real vault: approved timecards saved by the owner and the saved ID.
  const hubPost = (data, id) => employeeHub.onRequestPost({ env, request: jsonRequest('/api/employee-hub', { collection: 'timeEntries', id, data }, owner) });
  for (const card of AUDIT_57) {
    const { id, ...data } = card, response = await hubPost({ ...data, employee: 'Crew.Account', employeeName: 'Synthetic Crew.Account' }, `e2e-${id}`);
    assert.equal(response.status, 200, await response.clone().text());
  }
  const file = await timesheetsGet({ env, request: jsonRequest('/api/timesheets?view=week&start=2026-09-21&format=gusto', undefined, owner) });
  assert.equal(file.status, 200, await file.clone().text());
  assert.deepEqual(parse(await file.text()), [GUSTO_HOURS_COLUMNS.map(([header]) => header), ['gusto-syn-e2e', 'Synthetic Crew.Account', '40.00', '17.00', '0.00', '0.00']]);
  const refused = await timesheetsGet({ env, request: jsonRequest('/api/timesheets?view=week&start=2026-09-21&format=gusto', undefined, manager) });
  assert.deepEqual([refused.status, (await refused.json()).code], [403, 'pay_owner_only']);
});

test('Connect Gusto is offered only once Gusto has approved production access', async () => {
  const demo = { GUSTO_ENVIRONMENT: 'demo', GUSTO_COMPANY_UUID: '11111111-1111-4111-8111-111111111111', GUSTO_CLIENT_ID: 'synthetic-client', GUSTO_CLIENT_SECRET: 'synthetic-secret',
    GUSTO_REDIRECT_URI: 'https://easygaragecleaning.com/api/gusto-auth', EMPLOYEE_HUB_DATA_SECRET: 'synthetic-gusto-vault', FIREBASE_API_KEY: 'firebase-test-gusto-export' };
  assert.deepEqual([gustoConfiguration(demo).configured, gustoConfiguration(demo).productionApproved], [true, false]);
  assert.equal(gustoConfiguration({ ...demo, GUSTO_PRODUCTION_APPROVED: 'true' }).productionApproved, true);
  assert.equal(gustoConfiguration({ ...demo, GUSTO_PRODUCTION_APPROVED: 'TRUE' }).productionApproved, false, 'exactly "true"');
  assert.deepEqual([gustoConfiguration({}).configured, gustoConfiguration({}).productionApproved], [false, false]);
  assert.equal((await gustoStatus({})).productionApproved, false);
});

// Review finding: someone no longer in the active directory (rejected at termination, or a configured user removed) with
// approved hours in the week blocked the whole Gusto file, and set_gusto_id answered 404 for them.
test('former staff: the owner sets the Gusto fields of a rejected account or a leftover profile, and nothing else about them', async () => {
  const store = memory({
    accounts: [account('Crew.One'), account('Gone.Crew', { status: 'rejected' }), account('Never.Worked', { status: 'rejected' }), account('Applicant.Pending', { status: 'pending' })],
    profiles: [{ id: 'crew.one', username: 'Crew.One', hourlyRate: 21 }, { id: 'gone.crew', username: 'Gone.Crew', displayName: 'Synthetic Gone Crew', hourlyRate: 21, gustoEmployeeId: 'gusto-syn-old', skills: [] },
      { id: 'left.static', username: 'Left.Static', displayName: 'Synthetic Left Static' }, { id: 'stray-9', username: 'Stray.Crew' }],
  });
  const directory = directoryFor(store), revision = key => store.rows.get(key)?.updateTime || '';
  const owner = await directory.list(people.ZacB);
  assert.deepEqual(owner.formerStaff.map(person => [person.username, person.displayName, person.source, person.accountStatus ?? null, person.gustoEmployeeId, person.gustoExcluded, person.profileNeedsReview]), [
    ['Stray.Crew', 'Stray.Crew', 'former', null, null, false, true],
    ['Gone.Crew', 'Synthetic Gone.Crew', 'former', 'rejected', 'gusto-syn-old', false, false],
    ['Left.Static', 'Synthetic Left Static', 'former', null, null, false, false],
    ['Never.Worked', 'Synthetic Never.Worked', 'former', 'rejected', null, false, false],
  ], 'a stored profile or a rejected account; a pending applicant is not former staff');
  assert.deepEqual(Object.keys(owner.formerStaff[1]).sort(), ['accountStatus', 'displayName', 'gustoEmployeeId', 'gustoExcluded', 'history', 'profileNeedsReview', 'revision', 'source', 'username'], 'Gusto fields only: no pay, roles or skills');
  assert.equal(owner.people.some(person => ['Gone.Crew', 'Never.Worked', 'Left.Static', 'Applicant.Pending'].includes(person.username)), false, 'they stay out of the active directory');
  assert.equal(Object.hasOwn(await directory.list(people.ZacB, { username: 'Crew.One' }), 'formerStaff'), false, 'a one-person read has no former staff');
  for (const session of [people.TylerG, people.AlexK, crewSession('Crew.One')]) assert.equal(Object.hasOwn(await directory.list(session), 'formerStaff'), false, session.user);
  // Only the owner, only the Gusto fields, only for someone with a profile or a rejected account.
  await rejects(directory.mutate(people.TylerG, setId('Gone.Crew', revision('gone.crew'), 'gusto-syn-77')), 'staff_directory_forbidden', 403);
  await rejects(directory.mutate(people.ZacB, { action: 'set_skills', requestId: randomUUID(), username: 'Gone.Crew', expectedRevision: revision('gone.crew'), skills: [] }), 'staff_directory_not_found', 404);
  await rejects(directory.mutate(people.ZacB, { action: 'set_availability', requestId: randomUUID(), username: 'Gone.Crew', expectedRevision: revision('gone.crew'), weeklyAvailability: {} }), 'staff_directory_not_found', 404);
  await rejects(directory.mutate(people.ZacB, setId('Applicant.Pending', '', 'gusto-syn-78')), 'staff_directory_not_found', 404);
  await rejects(directory.mutate(people.ZacB, setId('Nobody.Here', '', 'gusto-syn-79')), 'staff_directory_not_found', 404);
  await rejects(directory.mutate(people.ZacB, setId('Stray.Crew', '', 'gusto-syn-80')), 'staff_directory_profile_ambiguous', 409);
  await rejects(directory.mutate(people.ZacB, setId('Gone.Crew', 'rev-stale', 'gusto-syn-77')), 'staff_directory_revision_conflict', 409);
  // An ID a former employee still holds is caught when it is saved on someone else.
  await assert.rejects(directory.mutate(people.ZacB, setId('Crew.One', revision('crew.one'), 'GUSTO-SYN-OLD')), error => error.code === 'staff_directory_gusto_id_in_use' && /Synthetic Gone\.Crew/.test(error.message));
  assert.equal(store.commits.length, 0);
  const input = setId('Gone.Crew', revision('gone.crew'), 'gusto-syn-77', { reason: 'Final paycheck' });
  const saved = await directory.mutate(people.ZacB, input);
  assert.deepEqual([saved.person.source, saved.person.username, saved.person.gustoEmployeeId, saved.person.revision], ['former', 'Gone.Crew', 'gusto-syn-77', revision('gone.crew')]);
  const stored = store.rows.get('gone.crew').data;
  assert.deepEqual([stored.gustoEmployeeId, stored.hourlyRate, stored.displayName, stored.history.at(-1).scope], ['gusto-syn-77', 21, 'Synthetic Gone Crew', 'gusto'], 'the rest of the profile is kept');
  assert.equal(store.commits.at(-1).account, null, 'the rejected account is not touched: no Hub access comes back');
  assert.equal((await directory.mutate(people.ZacB, input)).replayed, true, 'a retry of the same request replays the saved result');
  // A rejected account with no profile gets one, created (no revision), holding only the Gusto fields and the directory's bookkeeping.
  await directory.mutate(people.ZacB, setId('Never.Worked', '', 'gusto-syn-81'));
  assert.equal(store.commits.at(-1).profile.revision, '');
  assert.deepEqual(Object.keys(store.rows.get('never.worked').data).sort(), ['directoryRequestId', 'directoryUpdatedAt', 'directoryUpdatedBy', 'gustoEmployeeId', 'gustoExcluded', 'history', 'id', 'updatedAt', 'username']);
  assert.deepEqual([...gustoPayrollProfiles([...store.rows.values()].map(row => row.data))].filter(([, entry]) => entry.gustoEmployeeId).map(([key, entry]) => [key, entry.gustoEmployeeId]), [['gone.crew', 'gusto-syn-77'], ['never.worked', 'gusto-syn-81']]);
});

test('HTTP end to end: a rejected account with approved hours in the week blocks the Gusto file until the owner gives it a Gusto ID', async t => {
  const fire = vaultFirestore(t), env = staffEnv({ EGC_STAFF_DIRECTORY_ENABLED: 'true' });
  t.mock.timers.enable({ apis: ['Date'], now: NOW.getTime() });
  await seedAccount(env, 'Gone.Crew', { status: 'rejected' });
  await writeOne(env, 'profiles', 'gone.crew', { username: 'Gone.Crew', displayName: 'Synthetic Gone Crew', hourlyRate: 21, status: 'active' }, { data: null }, NOW.toISOString());
  const owner = await cookieFor(env, 'ZacB'), manager = await cookieFor(env, 'TylerG'), directory = staffDirectoryHandlers({ now: () => NOW });
  for (const card of AUDIT_57) {
    const { id, ...data } = card, response = await employeeHub.onRequestPost({ env, request: jsonRequest('/api/employee-hub', { collection: 'timeEntries', id: `gone-${id}`, data: { ...data, employee: 'Gone.Crew', employeeName: 'Synthetic Gone Crew' } }, owner) });
    assert.equal(response.status, 200, await response.clone().text());
  }
  const exportFile = cookie => timesheetsGet({ env, request: jsonRequest('/api/timesheets?view=week&start=2026-09-21&format=gusto', undefined, cookie) });
  const blocked = await exportFile(owner);
  assert.equal(blocked.status, 409);
  const refusalBody = await blocked.json();
  assert.equal(refusalBody.code, 'timesheet_gusto_id_missing');
  assert.match(refusalBody.error, /Synthetic Gone Crew \(gone\.crew\).*Former employees are listed under Former staff/);
  // The owner finds them under former staff (managers never do) and saves the ID: 200 where it was 404.
  const list = async cookie => (await directory.get({ env, request: jsonRequest('/api/staff-directory', undefined, cookie) })).json();
  const gone = (await list(owner)).formerStaff.find(person => person.username === 'Gone.Crew');
  assert.deepEqual([gone.accountStatus, gone.gustoEmployeeId], ['rejected', null]);
  assert.equal(Object.hasOwn(await list(manager), 'formerStaff'), false);
  const refused = await directory.post({ env, request: jsonRequest('/api/staff-directory', setId('Gone.Crew', gone.revision, 'gusto-syn-gone'), manager) });
  assert.deepEqual([refused.status, (await refused.json()).code], [403, 'staff_directory_forbidden']);
  const saved = await directory.post({ env, request: jsonRequest('/api/staff-directory', setId('Gone.Crew', gone.revision, 'gusto-syn-gone'), owner) });
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal((await saved.json()).person.gustoEmployeeId, 'gusto-syn-gone');
  const file = await exportFile(owner);
  assert.equal(file.status, 200, await file.clone().text());
  assert.deepEqual(parse(await file.text()).slice(1), [['gusto-syn-gone', 'Synthetic Gone Crew', '40.00', '17.00', '0.00', '0.00']]);
  // The account is still rejected: saving the ID gave no Hub access back.
  const signIn = await (await import('../functions/api/hub-auth.js')).onRequestPost({ env, request: jsonRequest('/api/hub-auth', { username: 'Gone.Crew', password: 'Synthetic-Staff-Password-904' }) });
  assert.notEqual(signIn.status, 200);
  const documentId = await opaqueId(env, 'profiles', 'gone.crew');
  assert.doesNotMatch(JSON.stringify(fire.documents.get(`jobs/${documentId}`)), /gusto-syn-gone/, 'the ID is sealed');
});

// Review finding: someone not paid through Gusto (the owner's own field time, a 1099 worker) stopped the file until the
// owner made up an ID.
test('someone marked not paid through Gusto is left out of the file and named in its header; the marker is the owner\'s alone', async () => {
  const store = memory({ accounts: [account('Crew.One'), account('Crew.Contract')], profiles: [{ id: 'crew.one', username: 'Crew.One', gustoEmployeeId: 'gusto-syn-1002' }, { id: 'crew.contract', username: 'Crew.Contract', displayName: 'Synthetic Contractor' }] });
  const directory = directoryFor(store), revision = key => store.rows.get(key)?.updateTime || '';
  await rejects(directory.mutate(people.ZacB, setId('Crew.Contract', revision('crew.contract'), '', { gustoExcluded: 'yes' })), 'staff_directory_invalid_gusto_id', 400);
  await rejects(directory.mutate(people.TylerG, setId('Crew.Contract', revision('crew.contract'), '', { gustoExcluded: true })), 'staff_directory_forbidden', 403);
  const marked = await directory.mutate(people.ZacB, setId('Crew.Contract', revision('crew.contract'), '', { gustoExcluded: true, reason: 'Synthetic 1099' }));
  assert.deepEqual([marked.person.gustoEmployeeId, marked.person.gustoExcluded], [null, true]);
  assert.deepEqual(store.rows.get('crew.contract').data.history.at(-1).changes, { before: { gustoEmployeeId: null, gustoExcluded: false }, after: { gustoEmployeeId: null, gustoExcluded: true } });
  assert.deepEqual(JSON.parse(store.commits.at(-1).audit.patch.after), { gustoEmployeeIdSet: false, gustoExcluded: true });
  // Left out, the marker stays; the same values are no change.
  assert.equal((await directory.mutate(people.ZacB, setId('Crew.Contract', revision('crew.contract'), ''))).unchanged, true);
  assert.equal((await directory.mutate(people.ZacB, setId('Crew.Contract', revision('crew.contract'), '', { gustoExcluded: true }))).unchanged, true);
  assert.equal(store.commits.length, 1);
  // Owner only: not in a manager's view, the legacy read or a legacy save.
  assert.doesNotMatch(JSON.stringify(await directory.list(people.TylerG)), /gustoExcluded/);
  assert.equal(legacyProfileView(store.rows.get('crew.contract').data, NOW.toISOString()).gustoExcluded, undefined);
  assert.equal(Object.hasOwn(legacyProfileInput({ gustoExcluded: false }), 'gustoExcluded'), false);
  assert.ok(DIRECTORY_PROFILE_FIELDS.includes('gustoExcluded'));
  // The file: Crew.Contract's approved hours are left out (with no ID, that stops nothing) and named in the header.
  const timecards = [...AUDIT_57, shift('contract', 'Crew.Contract', 'Crew.Contract', '2026-09-23', 8, 12)];
  const { get } = exporter({ timecards, ids: gustoPayrollProfiles([...store.rows.values()].map(row => row.data)) });
  const { response, text } = await get('?view=week&start=2026-09-21&format=gusto');
  assert.equal(response.status, 200, text);
  assert.deepEqual(parse(text).slice(1), [['gusto-syn-1002', 'Synthetic Crew One', '40.00', '17.00', '0.00', '0.00']]);
  assert.deepEqual(JSON.parse(decodeURIComponent(response.headers.get(GUSTO_NOT_INCLUDED_HEADER))), [{ employee: 'crew.contract', name: 'Synthetic Contractor' }], 'named by the profile, the timecards having only the username');
  const week = computeTimesheetWeek({ timecards, weekStart: '2026-09-21', now: NOW.toISOString() });
  assert.ok(parse(payrollCsv(week)).some(row => row[1] === 'crew.contract'), 'the payroll CSV still has their hours');
  // A marked employee's ID never conflicts inside the file, and one left out of every row still leaves a valid file.
  const both = new Map([['crew.one', gusto('gusto-syn-7')], ['crew.contract', gusto('gusto-syn-7', { gustoExcluded: true })]]);
  assert.deepEqual(gustoHoursFile(week, both).notInGusto, [{ employee: 'crew.contract', name: 'Crew.Contract' }]);
  const nobody = gustoHoursFile(week, new Map([['crew.one', gusto(null, { gustoExcluded: true })], ['crew.contract', gusto(null, { gustoExcluded: true })]]));
  assert.deepEqual([parse(nobody.csv).length, nobody.notInGusto.map(row => row.employee)], [1, ['crew.contract', 'crew.one']]);
});
