process.env.TZ = 'Asia/Tokyo';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { csvCell, payrollCsv, payrollCsvFilename } from '../functions/_lib/payroll-export.js';
import { computeTimesheetWeek } from '../functions/_lib/timesheet-week.js';
import { paidTimeOffHours, projectPtoRequest } from '../functions/_lib/employee-pto.js';
import { timesheetHandlers, onRequestGet as timesheetsGet } from '../functions/api/timesheets.js';
import { onRequestGet as hubGet, onRequestPost as hubPost } from '../functions/api/employee-hub.js';
import { onRequestGet as ptoGet, onRequestPost as ptoPost } from '../functions/api/employee-pto.js';
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

test('the payroll CSV and the timesheet week view pay the same PTO hours for either request shape', async () => {
  const older = { id: 'pto-older', type: 'time_off', status: 'approved', employee: 'Crew.One', startDate: '2026-09-24', endDate: '2026-09-28', paidHoursPerDay: 8 };
  const approval = { reviewedBy: 'zacb', reviewedAt: '2026-09-20T15:00:00.000Z', decisions: [{ action: 'approve', status: 'approved', by: 'zacb', at: '2026-09-20T15:00:00.000Z' }] };
  const approved = { id: 'pto-workflow', type: 'time_off', status: 'approved', employee: 'crew.two', startDate: '2026-09-24', endDate: '2026-09-27', paid: true, hoursPerDay: 6, paidDates: ['2026-09-24', '2026-09-26'], paidHours: 12, ...approval };
  const both = { ...approved, id: 'pto-both', employee: 'crew.three', paidHoursPerDay: 8, paidWeekends: true };
  const people = [shift('crew-three', '2026-09-21', '08:00', '12:00', { employee: 'crew.three', employeeName: 'Crew Three' })];
  const expected = { 'crew.one': 16, 'crew.two': 12, 'crew.three': 12 };
  for (const requests of [[older], [approved], [both], [older, approved, both]]) {
    const get = format => handler({ read: async () => ({ timecards: [...cards, ...people], requests }) })({ request: request(`?view=week&start=2026-09-21${format}`), env: {} });
    const json = await (await get('')).json(), csv = parse(await (await get('&format=csv')).text());
    for (const pto of requests) {
      const employee = pto.employee.toLowerCase(), row = json.employees.find(item => item.employee === employee), line = csv.find(item => item[1] === employee);
      assert.equal(row.ptoHours, expected[employee], pto.id);
      assert.deepEqual([line[8], line[13]], [row.ptoHours.toFixed(3), row.ptoPay.toFixed(2)], pto.id);
      // The request board and the per-day PTO view count the same hours in this week.
      assert.equal(projectPtoRequest(pto).paidDays.filter(day => day.date <= '2026-09-27').reduce((total, day) => total + day.hours, 0), row.ptoHours, pto.id);
      assert.equal(paidTimeOffHours([pto], '2026-09-21', '2026-09-28').totals[0].hours, row.ptoHours, pto.id);
    }
  }
});

// End-to-end through the real encrypted Employee Hub vault, the request workflow and dispatch
// storage, with an emulated Firestore REST API (document reads and PATCH, queries, collection
// scans and the transaction commit that fences the sealed request).
function firestore(t) {
  const documents = new Map(); let revision = 0;
  const stamp = () => `2026-10-05T18:00:00.${String(++revision).padStart(9, '0')}Z`;
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), body = options.body ? JSON.parse(options.body) : null;
    assert.equal(url.hostname, 'firestore.googleapis.com');
    if (url.pathname.endsWith('/documents:runQuery')) return Response.json([...documents.values()].filter(doc => doc.name.includes('/documents/jobs/') && matchesWhere(doc, body.structuredQuery.where)).map(document => ({ document })));
    if (url.pathname.endsWith('/documents:beginTransaction')) return Response.json({ transaction: 'synthetic-transaction' });
    if (url.pathname.endsWith('/documents:rollback')) return Response.json({});
    if (url.pathname.endsWith('/documents:batchGet')) return Response.json(body.documents.map(name => documents.has(name) ? { found: documents.get(name) } : { missing: name }));
    if (url.pathname.endsWith('/documents:commit')) {
      if (body.writes.some(({ update, currentDocument }) => currentDocument.exists === false ? documents.has(update.name) : documents.get(update.name)?.updateTime !== currentDocument.updateTime)) return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 409 });
      for (const { update } of body.writes) documents.set(update.name, { name: update.name, fields: { ...documents.get(update.name)?.fields, ...update.fields }, updateTime: stamp() });
      return Response.json({ writeResults: body.writes.map(() => ({})) });
    }
    const name = decodeURIComponent(url.pathname.replace(/^\/v1\//, ''));
    if (options.method === 'PATCH') {
      const current = documents.get(name), exists = url.searchParams.get('currentDocument.exists'), updateTime = url.searchParams.get('currentDocument.updateTime');
      if (exists === 'false' && current || updateTime && current?.updateTime !== updateTime) return Response.json({}, { status: 412 });
      documents.set(name, { name, ...body, updateTime: stamp() });
    }
    if (documents.has(name)) return Response.json(documents.get(name));
    // A collection path lists the documents directly under it.
    if (name.split('/').length % 2 === 0) return Response.json({ documents: [...documents.values()].filter(doc => doc.name.startsWith(name + '/') && !doc.name.slice(name.length + 1).includes('/')) });
    return Response.json({}, { status: 404 });
  });
  return documents;
}

test('the default reader decrypts vault timecards and paid PTO a manager approved through the request workflow while employees cannot pre-fill paid hours', async t => {
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
  const pto = async (who, body, status = 200) => {
    const response = await ptoPost({ env, request: new Request('https://easygaragecleaning.com/api/employee-pto', { method: 'POST', headers: { Cookie: cookie[who], Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), ...body }) }) });
    assert.equal(response.status, status, await response.clone().text());
    return response.json();
  };
  for (const card of cards.slice(0, 3)) {
    const { id, ...data } = card;
    await post('zac', 'timeEntries', id, data);
  }
  // Requests and their pay change only through the request workflow: the generic record write refuses them from
  // crew and managers alike, and the workflow refuses the older pay fields from anyone.
  for (const who of ['crew', 'zac']) {
    const response = await hubPost({ env, request: new Request('https://easygaragecleaning.com/api/employee-hub', { method: 'POST', headers: { Cookie: cookie[who], Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ collection: 'requests', id: 'request-pto', data: { type: 'time_off', startDate: '2026-09-24', endDate: '2026-09-24', status: 'approved', paidHoursPerDay: 24, paidWeekends: true } }) }) });
    assert.deepEqual([response.status, (await response.json()).code], [403, 'EMPLOYEE_HUB_REQUEST_WORKFLOW_REQUIRED']);
  }
  const ask = { action: 'request', type: 'time_off', startDate: '2026-09-24', endDate: '2026-09-24', reason: 'Family' };
  assert.equal((await pto('crew', { ...ask, paidHoursPerDay: 24, paidWeekends: true }, 400)).code, 'pto_invalid_request');
  // The employee may ask for paid hours; only the manager's approval decides what payroll pays.
  const { request: requested } = await pto('crew', { ...ask, paid: true, hoursPerDay: 12 });
  assert.deepEqual([requested.status, requested.paidHours, Object.hasOwn(requested, 'paidHoursPerDay'), Object.hasOwn(requested, 'paidWeekends')], ['pending', 12, false, false]);
  const { request: approved } = await pto('zac', { action: 'approve', id: requested.id, paid: true, hoursPerDay: 8 });
  assert.deepEqual([approved.status, approved.paidHours, approved.paidDays, approved.availabilityIds.length], ['approved', 8, [{ date: '2026-09-24', hours: 8 }], 1]);
  assert.ok([...documents.values()].every(doc => !JSON.stringify(doc).includes('Crew.One')), 'vault rows stay encrypted');
  const crewView = await timesheetsGet({ env, request: new Request('https://easygaragecleaning.com/api/timesheets?view=week&start=2026-09-21', { headers: { Cookie: cookie.crew } }) });
  assert.equal(crewView.status, 403);
  const response = await timesheetsGet({ env, request: new Request('https://easygaragecleaning.com/api/timesheets?view=week&start=2026-09-21', { headers: { Cookie: cookie.zac } }) });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json(), row = body.employees[0];
  assert.deepEqual([row.employee, row.workedHours, row.overtimeHours, row.ptoHours, row.ptoPay, row.grossPay, body.asOf], ['crew.one', 32, 4, 8, 160, 840, NOW.toISOString()]);
  const csv = await timesheetsGet({ env, request: new Request('https://easygaragecleaning.com/api/timesheets?view=week&start=2026-09-21&format=csv', { headers: { Cookie: cookie.zac } }) });
  assert.equal(csv.status, 200, await csv.clone().text());
  assert.deepEqual(parse(await csv.text()).find(line => line[1] === 'crew.one').slice(8, 17), ['8.000', '40.000', '20.0000', '640.00', '40.00', '160.00', '0.00', '0.00', '840.00']);
  // The approval is stored in the one pay model (paid, hoursPerDay, paidDates), never the older paidHoursPerDay.
  const hub = await (await hubGet({ env, request: new Request('https://easygaragecleaning.com/api/employee-hub', { headers: { Cookie: cookie.zac } }) })).json(), stored = hub.collections.requests[0];
  assert.deepEqual([stored.paid, stored.hoursPerDay, stored.paidDates, stored.paidHours, Object.hasOwn(stored, 'paidHoursPerDay')], [true, 8, ['2026-09-24'], 8, false]);
  // A manager corrects the pay later through the same workflow (crew cannot), and payroll reads the new terms.
  assert.equal((await pto('crew', { action: 'amend', id: requested.id, paid: true, hoursPerDay: 12 }, 403)).code, 'pto_forbidden');
  const { request: amended } = await pto('zac', { action: 'amend', id: requested.id, paid: true, hoursPerDay: 4, note: 'Half day' });
  assert.deepEqual([amended.paidHours, amended.payModel, amended.decisions.map(entry => [entry.action, entry.previousPaidHours])], [4, 'workflow', [['request', undefined], ['approve', undefined], ['amend', 8]]]);
  const after = await (await timesheetsGet({ env, request: new Request('https://easygaragecleaning.com/api/timesheets?view=week&start=2026-09-21', { headers: { Cookie: cookie.zac } }) })).json();
  assert.deepEqual([after.employees[0].ptoHours, after.employees[0].ptoPay], [4, 80]);
});

// Canary for P1-06 merged with PRICE-SCRUB. With EGC_STAFF_PAY_OWNER_ONLY on (the default), PTO pay terms are hours: a
// manager approves and changes them. The rate PTO is paid at is the employee's timecard rate, which only the owner sets
// and sees, and the PTO pay it gives appears to nobody else in /api/employee-hub or /api/employee-pto. No request field
// can carry a rate, and crew never reach the timesheets or the payroll CSV.
test('owner-only pay: a manager or crew member cannot read or set another employee\'s PTO pay or rate through the Employee Hub, the request workflow or the timesheets', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW.getTime() });
  firestore(t);
  const RATE = 37.13, CANARY = /37\.13|297\.04|"(?:ptoRate|payRate|rate)"/, hash = await createHubCredentialHash('Synthetic payroll test password 904!');
  const user = (displayName, role, extra = {}) => ({ passwordHash: hash, displayName, role, ...extra });
  const env = { HUB_SESSION_SECRET: 'payroll-tests-session', EMPLOYEE_HUB_DATA_SECRET: 'payroll-tests-vault', FIREBASE_API_KEY: 'firebase-test-payroll',
    HUB_AUTH_USERS_JSON: JSON.stringify({ 'Crew.One': user('Crew One', 'crew', { hourlyRate: RATE }), 'Crew.Two': user('Crew Two', 'crew', { hourlyRate: 19 }), TylerG: user('Tyler', 'manager'), ZacB: user('Zac', 'owner') }) };
  const cookie = {};
  for (const [who, name] of [['crew', 'Crew.One'], ['crew2', 'Crew.Two'], ['manager', 'TylerG'], ['owner', 'ZacB']]) cookie[who] = (await createHubSessionCookie(env, name)).split(';')[0];
  const send = (handler, who, path, body, hubEnv = env) => handler({ env: hubEnv, request: new Request(`https://easygaragecleaning.com${path}`, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers: { Cookie: cookie[who], Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' } }) });
  const pto = async (who, body, status = 200) => {
    const response = await send(ptoPost, who, '/api/employee-pto', { requestId: randomUUID(), ...body });
    assert.equal(response.status, status, await response.clone().text());
    return response.json();
  };
  const read = async (handler, who, path, hubEnv) => { const response = await send(handler, who, path, undefined, hubEnv); assert.equal(response.status, 200, await response.clone().text()); return response.text(); };
  for (const card of cards.slice(0, 3)) {
    const { id, ...data } = card;
    assert.equal((await send(hubPost, 'owner', '/api/employee-hub', { collection: 'timeEntries', id, data: { ...data, hourlyRate: RATE } })).status, 200);
  }
  // No request field carries a rate: the workflow refuses one from crew and managers, and the generic write refuses requests.
  const ask = { action: 'request', type: 'time_off', startDate: '2026-09-24', endDate: '2026-09-24', reason: 'Family', paid: true, hoursPerDay: 8 };
  for (const field of ['hourlyRate', 'ptoRate', 'rate', 'ptoPay']) assert.equal((await pto('crew', { ...ask, [field]: 99 }, 400)).code, 'pto_invalid_request', field);
  const { request: requested } = await pto('crew', ask);
  for (const field of ['hourlyRate', 'ptoRate', 'rate']) {
    assert.equal((await pto('manager', { action: 'approve', id: requested.id, paid: true, hoursPerDay: 8, [field]: 99 }, 400)).code, 'pto_invalid_request', field);
  }
  // A manager decides paid days and hours, which are hours, not pay.
  const { request: approved } = await pto('manager', { action: 'approve', id: requested.id, paid: true, hoursPerDay: 8 });
  assert.deepEqual([approved.status, approved.paidHours, approved.reviewedBy], ['approved', 8, 'tylerg']);
  assert.equal((await pto('manager', { action: 'amend', id: requested.id, paid: true, hoursPerDay: 8, hourlyRate: 99 }, 400)).code, 'pto_invalid_request');
  for (const who of ['crew', 'crew2', 'manager']) {
    const response = await send(hubPost, who, '/api/employee-hub', { collection: 'requests', id: requested.id, data: { ...approved, ptoRate: 99, hourlyRate: 99 } });
    assert.deepEqual([response.status, (await response.json()).code], [403, 'EMPLOYEE_HUB_REQUEST_WORKFLOW_REQUIRED'], who);
  }
  // PTO pays at the timecard rate. A manager's save of another employee's timecard never sets or shows that rate: PRICE-SCRUB
  // drops the rate from the save (200, reply without pay), and the stricter PAY-TIMESHEETS rule refuses it (403 pay_owner_only).
  // The owner's timesheet below proves the stored rate is unchanged either way.
  const saved = await send(hubPost, 'manager', '/api/employee-hub', { collection: 'timeEntries', id: 'mon', data: { hourlyRate: 99, approvalStatus: 'approved' } }), reply = await saved.json();
  assert.ok(saved.status === 200 ? !('hourlyRate' in reply.record) : saved.status === 403 && reply.code === 'pay_owner_only', JSON.stringify(reply));
  assert.doesNotMatch(JSON.stringify(reply), CANARY);
  assert.equal((await send(hubPost, 'crew2', '/api/employee-hub', { collection: 'timeEntries', id: 'mon', data: { hourlyRate: 99 } })).status, 403);
  // Reads: the manager keeps the PTO hours, and nobody but the owner and the employee gets the rate or the PTO pay.
  const managerHub = await read(hubGet, 'manager', '/api/employee-hub'), managerPto = await read(ptoGet, 'manager', '/api/employee-pto?startDate=2026-09-21&endDate=2026-09-28');
  assert.doesNotMatch(managerHub, CANARY); assert.doesNotMatch(managerPto, CANARY);
  const request = JSON.parse(managerHub).collections.requests.find(row => row.id === requested.id);
  assert.deepEqual([request.paid, request.hoursPerDay, request.paidHours], [true, 8, 8]);
  assert.deepEqual(JSON.parse(managerPto).paidTimeOff.totals, [{ employee: 'crew.one', hours: 8 }]);
  for (const [handler, path] of [[hubGet, '/api/employee-hub'], [ptoGet, '/api/employee-pto?startDate=2026-09-21&endDate=2026-09-28']]) {
    const text = await read(handler, 'crew2', path);
    assert.doesNotMatch(text, CANARY, path); assert.doesNotMatch(text, new RegExp(requested.id), path);
  }
  for (const who of ['crew', 'crew2']) for (const format of ['', '&format=csv']) {
    const response = await send(timesheetsGet, who, `/api/timesheets?view=week&start=2026-09-21${format}`);
    const text = await response.text();
    assert.deepEqual([response.status, JSON.parse(text).code], [403, 'timesheet_forbidden'], `${who}${format}`);
    assert.doesNotMatch(text, CANARY);
  }
  // With PAY-TIMESHEETS the manager's timesheet week keeps the PTO hours but not the rate or the PTO pay, and the payroll
  // CSV (which is all pay) is the owner's alone.
  const managerWeek = await read(timesheetsGet, 'manager', '/api/timesheets?view=week&start=2026-09-21');
  assert.doesNotMatch(managerWeek, CANARY);
  const week = JSON.parse(managerWeek), hidden = week.employees.find(row => row.employee === 'crew.one');
  assert.deepEqual([hidden.ptoHours, hidden.payHidden, Object.hasOwn(hidden, 'ptoPay'), Object.hasOwn(hidden, 'regularRate'), week.totals.ptoPay, week.payVisibility], [8, true, false, false, null, 'own']);
  const managerCsv = await send(timesheetsGet, 'manager', '/api/timesheets?view=week&start=2026-09-21&format=csv'), refusedCsv = await managerCsv.text();
  assert.deepEqual([managerCsv.status, JSON.parse(refusedCsv).code], [403, 'pay_owner_only']);
  assert.doesNotMatch(refusedCsv, CANARY);
  // The canary is live: the owner, and a manager with the flag off, read the rate; PTO still pays 8 hours at the owner's rate.
  assert.match(await read(hubGet, 'manager', '/api/employee-hub', { ...env, EGC_STAFF_PAY_OWNER_ONLY: 'false' }), /37\.13/);
  assert.match(await read(timesheetsGet, 'manager', '/api/timesheets?view=week&start=2026-09-21', { ...env, EGC_STAFF_PAY_OWNER_ONLY: 'false' }), /297\.04/);
  const owner = JSON.parse(await read(timesheetsGet, 'owner', '/api/timesheets?view=week&start=2026-09-21')).employees.find(row => row.employee === 'crew.one');
  assert.deepEqual([owner.ptoHours, owner.ptoPay, owner.regularRate], [8, 297.04, RATE]);
  const line = parse(await read(timesheetsGet, 'owner', '/api/timesheets?view=week&start=2026-09-21&format=csv')).find(row => row[1] === 'crew.one');
  assert.deepEqual([line[8], line[10], line[13]], ['8.000', '37.1300', '297.04']);
});
