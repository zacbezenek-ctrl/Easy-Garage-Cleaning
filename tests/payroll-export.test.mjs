process.env.TZ = 'Asia/Tokyo';
import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, payrollCsv, payrollCsvFilename } from '../functions/_lib/payroll-export.js';
import { computeTimesheetWeek } from '../functions/_lib/timesheet-week.js';
import { timesheetHandlers, onRequestGet as timesheetsGet } from '../functions/api/timesheets.js';
import { onRequestGet as hubGet, onRequestPost as hubPost } from '../functions/api/employee-hub.js';
import { createHubCredentialHash, createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { matchesWhere } from './helpers/firestore-query.mjs';

const NOW = new Date('2026-10-05T18:00:00.000Z');
const at = (date, time) => `${date}T${time}:00-06:00`;
const shift = (id, date, from, to, extra = {}) => ({ id, employee: 'Crew.One', employeeName: 'Crew One', payType: 'hourly', hourlyRate: 20, clockInAt: at(date, from), clockOutAt: at(date, to), status: 'submitted', approvalStatus: 'approved', breaks: [], ...extra });
const manager = { user: 'ZacB', displayName: 'Zac', role: 'owner', businessAccess: true };
const crew = { user: 'Crew.One', displayName: 'Crew One', role: 'crew' };
const cards = [shift('mon', '2026-09-21', '06:00', '20:00'), shift('tue', '2026-09-22', '06:00', '20:00'), shift('wed', '2026-09-23', '08:00', '12:00'),
  shift('alex', '2026-09-21', '08:00', '12:00', { employee: 'crew.two', employeeName: '=HYPERLINK("https://evil.example","Alex")', hourlyRate: 30 })];
const parse = csv => csv.trimEnd().split('\r\n').map(line => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map(match => match[1].replaceAll('""', '"')));

test('CSV cells neutralize spreadsheet formulas and escape quotes like the Hub csvCell', () => {
  assert.equal(csvCell('=SUM(A1)'), `"'=SUM(A1)"`);
  for (const value of ['+1', '-2', '@cmd', '\tTAB', '\rCR']) assert.equal(csvCell(value), `"'${value}"`);
  assert.equal(csvCell('He said "hi"'), '"He said ""hi"""');
  assert.equal(csvCell(null), '""'); assert.equal(csvCell(undefined), '""'); assert.equal(csvCell(12.5), '"12.5"');
  assert.equal(csvCell('Crew = One'), '"Crew = One"');
});

test('payroll CSV has one guarded row per employee-week whose pay columns add up', () => {
  const week = computeTimesheetWeek({ timecards: cards, weekStart: '2026-09-21', now: NOW.toISOString() }), csv = payrollCsv(week), rows = parse(csv);
  assert.ok(csv.endsWith('\r\n'));
  assert.equal(payrollCsvFilename(week), 'egc-payroll-2026-09-21-to-2026-09-27.csv');
  assert.deepEqual(rows[0], ['Employee name', 'Employee username', 'Week start', 'Week end', 'Overtime policy', 'Regular hours', 'Overtime hours', 'Double-time hours', 'Paid time off hours', 'Total paid hours',
    'Regular rate', 'Straight-time pay', 'Overtime premium', 'Paid time off pay', 'Bonus', 'Tips', 'Gross pay', 'Overtime basis', 'Approved timecards', 'Pending timecards included', 'Review flags']);
  const crewRow = rows.find(row => row[1] === 'crew.one'), alexRow = rows.find(row => row[1] === 'crew.two');
  assert.deepEqual(crewRow, ['Crew One', 'crew.one', '2026-09-21', '2026-09-27', 'colorado', '28.000', '4.000', '0.000', '0.000', '32.000', '20.0000', '640.00', '40.00', '0.00', '0.00', '0.00', '680.00', 'daily', '3', '0', '']);
  assert.equal(alexRow[0], `'=HYPERLINK("https://evil.example","Alex")`);
  assert.deepEqual(alexRow.slice(5, 17), ['4.000', '0.000', '0.000', '0.000', '4.000', '30.0000', '120.00', '0.00', '0.00', '0.00', '0.00', '120.00']);
  for (const row of rows.slice(1)) assert.equal(row.slice(11, 16).reduce((total, value) => total + Number(value), 0).toFixed(2), row[16]);
  assert.equal(rows.length, 3);
  const extras = parse(payrollCsv(computeTimesheetWeek({ timecards: [shift('paid', '2026-09-21', '08:00', '16:00', { bonus: 50, tips: '20' })], weekStart: '2026-09-21', now: NOW.toISOString() })))[1];
  assert.deepEqual([extras[14], extras[15], extras[16], extras[20]], ['50.00', '20.00', '230.00', 'bonus_or_tips']);
});

const session = user => async () => user;
const request = (query, headers = {}) => new Request(`https://easygaragecleaning.com/api/timesheets${query}`, { headers });
const handler = (options = {}) => timesheetHandlers({ session: session(manager), read: async () => ({ timecards: cards, requests: [] }), now: () => NOW, ...options }).get;

test('timesheets API is manager-only and validates the week query strictly', async () => {
  let reads = 0;
  const read = async () => { reads++; return { timecards: cards, requests: [] }; };
  const expect = async (response, status, code) => { assert.equal(response.status, status); const body = await response.json(); assert.equal(body.ok, false); assert.equal(body.code, code); assert.equal(response.headers.get('Cache-Control'), 'no-store'); };
  await expect(await handler({ session: session(null), read })({ request: request('?view=week&start=2026-09-21'), env: {} }), 401, 'timesheet_sign_in_required');
  await expect(await handler({ session: session(crew), read })({ request: request('?view=week&start=2026-09-21'), env: {} }), 403, 'timesheet_forbidden');
  await expect(await handler({ session: session({ user: 'ZacB', role: 'owner' }), read })({ request: request('?view=week&start=2026-09-21'), env: {} }), 403, 'timesheet_forbidden');
  for (const query of ['', '?view=day&start=2026-09-21', '?view=week&start=2026-09-21&start=2026-09-28', '?view=week&start=2026-09-21&employee=crew.one', '?view=week&start=2026-09-21&format=xlsx', '?view=week&start=2026-09-21&includePending=yes']) {
    await expect(await handler({ read })({ request: request(query), env: {} }), 400, 'timesheet_query_invalid');
  }
  await expect(await handler({ read })({ request: request('?view=week&start=2026-02-30'), env: {} }), 400, 'timesheet_week_invalid');
  await expect(await handler({ read })({ request: request('?view=week&start=2026-09-21'), env: { EGC_OVERTIME_POLICY: 'california' } }), 503, 'timesheet_policy_invalid');
  assert.equal(reads, 0, 'invalid requests never open the employee vault');
});

test('timesheets API returns the Denver week as JSON and exports CSV only for a complete week', async () => {
  const json = await handler()({ request: request('?view=week&start=2026-09-24'), env: {} });
  assert.equal(json.status, 200); assert.equal(json.headers.get('X-Content-Type-Options'), 'nosniff');
  const body = await json.json();
  assert.deepEqual([body.ok, body.weekStart, body.weekEnd, body.policy.name, body.asOf, body.coverage.complete], [true, '2026-09-21', '2026-09-27', 'colorado', NOW.toISOString(), true]);
  assert.equal(body.employees.find(row => row.employee === 'crew.one').overtimeHours, 4);
  const federal = await (await handler()({ request: request('?view=week&start=2026-09-21'), env: { EGC_OVERTIME_POLICY: 'federal' } })).json();
  assert.equal(federal.employees.find(row => row.employee === 'crew.one').overtimeHours, 0);
  const csv = await handler()({ request: request('?view=week&start=2026-09-21&format=csv'), env: {} });
  assert.equal(csv.status, 200);
  assert.equal(csv.headers.get('Content-Type'), 'text/csv; charset=utf-8');
  assert.equal(csv.headers.get('Content-Disposition'), 'attachment; filename="egc-payroll-2026-09-21-to-2026-09-27.csv"');
  assert.equal(csv.headers.get('Cache-Control'), 'no-store');
  assert.equal(parse(await csv.text()).length, 3);
  const pending = [...cards, shift('late', '2026-09-26', '08:00', '12:00', { approvalStatus: 'pending' })];
  const blocked = await handler({ read: async () => ({ timecards: pending, requests: [] }) })({ request: request('?view=week&start=2026-09-21&format=csv'), env: {} });
  assert.equal(blocked.status, 409);
  const reason = await blocked.json();
  assert.deepEqual([reason.code, reason.details.reasons, reason.details.excluded.pending], ['timesheet_incomplete', ['pending_timecards'], 1]);
  const included = await handler({ read: async () => ({ timecards: pending, requests: [] }) })({ request: request('?view=week&start=2026-09-21&format=csv&includePending=1'), env: {} });
  assert.equal(included.status, 200);
  assert.equal(parse(await included.text()).find(row => row[1] === 'crew.one')[19], '1');
  const inProgress = await handler({ now: () => new Date('2026-09-24T18:00:00Z') })({ request: request('?view=week&start=2026-09-21&format=csv'), env: {} });
  assert.equal(inProgress.status, 409);
  assert.deepEqual((await inProgress.json()).details.reasons, ['week_in_progress']);
});

test('pay-review flags block the payroll CSV until each is fixed or explicitly acknowledged', async () => {
  const unrated = [...cards, shift('unrated', '2026-09-24', '08:00', '12:00', { hourlyRate: undefined, payType: 'salary' })];
  const read = async () => ({ timecards: unrated, requests: [] }), get = query => handler({ read })({ request: request(query), env: {} });
  const blocked = await get('?view=week&start=2026-09-21&format=csv');
  assert.equal(blocked.status, 409);
  const body = await blocked.json();
  assert.deepEqual([body.code, body.details.reasons, body.details.blocking, body.details.acknowledgeable], ['timesheet_incomplete', ['missing_rate', 'non_hourly_pay_type'], ['missing_rate', 'non_hourly_pay_type'], ['missing_rate', 'non_hourly_pay_type']]);
  assert.match(body.error, /acknowledge=missing_rate,non_hourly_pay_type/);
  assert.equal((await get('?view=week&start=2026-09-21&format=csv&acknowledge=missing_rate')).status, 409, 'every flag must be named');
  const exported = await get('?view=week&start=2026-09-21&format=csv&acknowledge=missing_rate,non_hourly_pay_type');
  assert.equal(exported.status, 200);
  assert.equal(parse(await exported.text()).find(row => row[1] === 'crew.one')[20], 'missing_rate multiple_rates non_hourly_pay_type');
  for (const query of ['?view=week&start=2026-09-21&acknowledge=missing_rate', '?view=week&start=2026-09-21&format=csv&acknowledge=pending_timecards', '?view=week&start=2026-09-21&format=csv&acknowledge=']) {
    const response = await get(query);
    assert.deepEqual([response.status, (await response.json()).code], [400, 'timesheet_query_invalid'], query);
  }
  const pending = [...unrated, shift('late', '2026-09-26', '08:00', '12:00', { approvalStatus: 'pending' })];
  const stillBlocked = await handler({ read: async () => ({ timecards: pending, requests: [] }) })({ request: request('?view=week&start=2026-09-21&format=csv&acknowledge=missing_rate,non_hourly_pay_type'), env: {} });
  assert.equal(stillBlocked.status, 409);
  assert.deepEqual((await stillBlocked.json()).details.blocking, ['pending_timecards'], 'an acknowledgement never covers unapproved time');
});

test('an undated record blocks payroll with a 409 that names it and the manager fix', async () => {
  const undated = [...cards, shift('lost-card', '2026-09-22', '08:00', '12:00', { clockInAt: 'unknown', clockOutAt: '', status: 'submitted' })];
  const response = await handler({ read: async () => ({ timecards: undated, requests: [] }) })({ request: request('?view=week&start=2026-09-21&format=csv'), env: {} });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.match(body.error, /no readable date and could belong to this week: lost-card\./);
  assert.match(body.error, /reject or correct each one/);
  assert.deepEqual([body.details.blocking, body.details.unattributed.map(item => [item.id, item.employee, item.reason])], [['unattributed_records'], [['lost-card', 'crew.one', 'invalid_shift_times']]]);
  const json = await (await handler({ read: async () => ({ timecards: undated, requests: [] }) })({ request: request('?view=week&start=2026-09-21'), env: {} })).json();
  assert.deepEqual([json.needsReview, json.unattributed.map(item => item.id)], [[], ['lost-card']]);
});

test('timesheets API fails closed without leaking storage errors', async () => {
  const leaked = await handler({ read: async () => { throw new Error('secret firestore detail 42'); } })({ request: request('?view=week&start=2026-09-21'), env: {} });
  assert.equal(leaked.status, 503);
  const body = await leaked.json();
  assert.equal(body.code, 'timesheet_unavailable'); assert.equal(JSON.stringify(body).includes('secret'), false);
  const partial = await handler({ read: async () => ({ timecards: cards }) })({ request: request('?view=week&start=2026-09-21'), env: {} });
  assert.equal(partial.status, 503); assert.equal((await partial.json()).code, 'timesheet_records_invalid');
  const unconfigured = await timesheetHandlers({ session: session(manager), now: () => NOW }).get({ request: request('?view=week&start=2026-09-21'), env: {} });
  assert.equal(unconfigured.status, 503); assert.equal((await unconfigured.json()).code, 'timesheet_storage_unconfigured');
});

// End-to-end through the real encrypted Employee Hub vault with an emulated Firestore REST API.
function firestore(t) {
  const documents = new Map(); let revision = 0;
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), body = options.body ? JSON.parse(options.body) : null;
    if (url.pathname.endsWith('/documents:runQuery')) return Response.json([...documents.values()].filter(doc => doc.name.includes('/documents/jobs/') && matchesWhere(doc, body.structuredQuery.where)).map(document => ({ document })));
    const name = decodeURIComponent(url.pathname.replace(/^\/v1\//, ''));
    if (options.method === 'PATCH') {
      const current = documents.get(name), exists = url.searchParams.get('currentDocument.exists'), updateTime = url.searchParams.get('currentDocument.updateTime');
      if (exists === 'false' && current || updateTime && current?.updateTime !== updateTime) return Response.json({}, { status: 412 });
      documents.set(name, { name, ...body, updateTime: `2026-10-05T18:00:00.${String(++revision).padStart(9, '0')}Z` });
    }
    return documents.has(name) ? Response.json(documents.get(name)) : Response.json({}, { status: 404 });
  });
  return documents;
}

test('the default reader decrypts vault timecards and manager-set paid PTO while employees cannot pre-fill paid hours', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW.getTime() });
  const documents = firestore(t), hash = await createHubCredentialHash('Synthetic payroll test password 904!');
  const env = { HUB_SESSION_SECRET: 'payroll-tests-session', EMPLOYEE_HUB_DATA_SECRET: 'payroll-tests-vault', FIREBASE_API_KEY: 'firebase-test-payroll',
    HUB_AUTH_USERS_JSON: JSON.stringify({ 'Crew.One': { passwordHash: hash, displayName: 'Crew One', role: 'crew', hourlyRate: 20 }, ZacB: { passwordHash: hash, displayName: 'Zac', role: 'owner' } }) };
  const cookie = { crew: (await createHubSessionCookie(env, 'Crew.One')).split(';')[0], zac: (await createHubSessionCookie(env, 'ZacB')).split(';')[0] };
  const post = async (who, collection, id, data) => {
    const response = await hubPost({ env, request: new Request('https://easygaragecleaning.com/api/employee-hub', { method: 'POST', headers: { Cookie: cookie[who], Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ collection, id, data }) }) });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).record;
  };
  for (const card of cards.slice(0, 3)) {
    const { id, ...data } = card;
    await post('zac', 'timeEntries', id, data);
  }
  const requested = await post('crew', 'requests', 'request-pto', { type: 'time_off', startDate: '2026-09-24', endDate: '2026-09-24', reason: 'Family', paidHoursPerDay: 24, paidWeekends: true });
  assert.deepEqual([Object.hasOwn(requested, 'paidHoursPerDay'), Object.hasOwn(requested, 'paidWeekends')], [false, false]);
  await post('zac', 'requests', 'request-pto', { status: 'approved', reviewedBy: 'ZacB', paidHoursPerDay: 8 });
  assert.ok([...documents.values()].every(doc => !JSON.stringify(doc).includes('Crew.One')), 'vault rows stay encrypted');
  const crewView = await timesheetsGet({ env, request: new Request('https://easygaragecleaning.com/api/timesheets?view=week&start=2026-09-21', { headers: { Cookie: cookie.crew } }) });
  assert.equal(crewView.status, 403);
  const response = await timesheetsGet({ env, request: new Request('https://easygaragecleaning.com/api/timesheets?view=week&start=2026-09-21', { headers: { Cookie: cookie.zac } }) });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json(), row = body.employees[0];
  assert.deepEqual([row.employee, row.workedHours, row.overtimeHours, row.ptoHours, row.ptoPay, row.grossPay, body.asOf], ['crew.one', 32, 4, 8, 160, 840, NOW.toISOString()]);
  const hub = await (await hubGet({ env, request: new Request('https://easygaragecleaning.com/api/employee-hub', { headers: { Cookie: cookie.zac } }) })).json();
  assert.equal(hub.collections.requests[0].paidHoursPerDay, 8);
});
