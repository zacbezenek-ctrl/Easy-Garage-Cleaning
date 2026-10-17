import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { projectDispatchJob } from '../functions/_lib/dispatch-service.js';
import { JOB_FIELDS } from '../functions/_lib/dispatch-storage.js';
import { D2D_DAY_LIMIT, D2D_JOB_FIELDS, D2D_SALE_FIELDS, canViewD2dDay, d2dDayDate, d2dDaySummary, d2dJobReader, d2dMarker, loadD2dDay } from '../functions/_lib/d2d-day.js';
import { d2dDayHandlers } from '../functions/api/d2d-day.js';

// D2D-BOARD: GET /api/d2d-day, the door-to-door day on the Hub schedule board. Synthetic reps and customers only; the
// clock is fixed at Monday 2026-10-19 10:00 Mountain Time (16:00 UTC).
const NOW = new Date('2026-10-19T16:00:00.000Z'), DAY = '2026-10-19';
const ORIGIN = 'https://easygaragecleaning.com';
const person = (user, extra = {}) => ({ user, displayName: `Synthetic ${user}`, role: 'crew', businessAccess: false, source: 'employee-account', ...extra });
const SESSIONS = {
  owner: { user: 'zacb', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true },
  manager: { user: 'TylerG', displayName: 'Synthetic Manager', role: 'manager', businessAccess: true },
  eli: person('eli.team', { staffRoles: ['team_lead'] }),
  crew: person('ben.crew'), crewLead: person('fay.lead', { staffRoles: ['crew_lead'] }),
  sales: person('gus.sales', { role: 'sales', staffRoles: ['sales'] }), phone: person('hal.phone', { staffRoles: ['phone'] }),
  knocker: person('kim.knock', { staffRoles: ['crew'] }),
};
// The customer, money and address fields sit on the stored rows on purpose: none may leave.
const PRIVATE = { customer: { name: 'Synthetic Customer Person', phone: '+19705550142', email: 'synthetic.customer@example.invalid' }, ticket: 1850, depositAmount: 462.5, address: { number: '100', street: 'Fixture Lane', unit: '' },
  commissionTerms: { rate: 0.25 }, quotedAmount: 1850 };
const shift = (id, repKey, startedAt, extra = {}) => ({ id, repKey, day: DAY, startedAt, endedAt: null, endReason: null, breaks: [], lastDoorAt: null, lastNeighborhoodId: null, doors: 0, ...extra });
const sale = (id, repKey, extra = {}) => ({ id, repKey, saleDate: DAY, soldAt: '2026-10-19T15:40:00.000Z', status: 'booked', package: 'Synthetic Reset', jobDate: '2026-10-23', jobStartTime: '09:30', neighborhoodId: 'nb_park', ...PRIVATE, ...extra });
const RECORDS = {
  settings: { settings: { shift: { idleAutoEndHours: 4 } } },
  shifts: [
    shift('shift-ana', 'ana.rep', '2026-10-19T15:05:00.000Z', { lastDoorAt: '2026-10-19T15:55:00.000Z', lastNeighborhoodId: 'nb_park', doors: 38 }),
    shift('shift-bo', 'bo.rep', '2026-10-19T13:00:00.000Z', { endedAt: '2026-10-19T15:00:00.000Z', endReason: 'manual', doors: 12, lastNeighborhoodId: 'nb_hill' }),
    // Started at 5:00 and idle since its first door: auto-ended after four hours of no activity.
    shift('shift-cy', 'cy.rep', '2026-10-19T11:00:00.000Z', { lastDoorAt: '2026-10-19T11:01:00.000Z', doors: 1 }),
  ],
  sales: [sale('sale-1', 'ana.rep'), sale('sale-2', 'ana.rep', { status: 'cancelled', package: 'Synthetic Basic' }), sale('sale-3', 'bo.rep', { neighborhoodId: 'nb_hill' })],
  assignments: [
    { id: 'ana.rep__nb_park__all', repKey: 'ana.rep', neighborhoodId: 'nb_park', active: true, source: 'self' },
    { id: 'ana.rep__nb_lake__all', repKey: 'ana.rep', neighborhoodId: 'nb_lake', active: true, source: 'admin' },
    { id: 'zed.rep__nb_far__all', repKey: 'zed.rep', neighborhoodId: 'nb_far', active: true, source: 'self' },
  ],
  reps: { 'ana.rep': { displayName: 'Ana Synthetic Rep' }, 'bo.rep': { displayName: 'Bo Synthetic Rep' }, 'cy.rep': { username: 'cy.rep' }, 'dee.rep': { displayName: 'Dee Synthetic Rep' } },
  days: { 'ana.rep_2026-10-19': { doors: 40, answers: 14, looks: 5, sales: 1, bookedRevenue: 1850, byNeighborhood: { nb_park: { doors: 40 } } } },
  neighborhoods: { nb_park: { name: 'Synthetic Park' }, nb_lake: { name: 'Synthetic Lake' }, nb_hill: { name: 'Synthetic Hill' } },
  // Hub jobs: booked today from D2D, made today by D2D (a sale and a walkthrough set), made today by the office, and a
  // sale's job made yesterday (found by sale id).
  booked: [{ id: 'job_today', type: 'job', date: DAY, time: '13:00', status: 'scheduled', source: 'door_to_door', d2d: { repKey: 'dee.rep', saleId: 'sale-old', kind: 'sale' }, createdAt: '2026-10-14T18:00:00.000Z', customer: 'Synthetic Customer Person', phone: '9705550142' }],
  created: [
    { id: 'job_sale1', type: 'job', date: '2026-10-23', time: '09:30', status: 'scheduled', source: 'door_to_door', d2d: { repKey: 'ana.rep', saleId: 'sale-1', kind: 'sale' }, createdAt: '2026-10-19T15:41:00.000Z' },
    { id: 'walk_set', type: 'walkthrough', date: '2026-10-21', time: '10:00', status: 'scheduled', source: 'door_to_door', d2d: { repKey: 'ana.rep', setterEventId: 'event-9', kind: 'walkthrough' }, createdAt: '2026-10-19T15:50:00.000Z' },
    { id: 'office_job', type: 'job', date: '2026-10-22', time: '09:30', status: 'scheduled', source: 'hub', createdAt: '2026-10-19T14:00:00.000Z' },
  ],
  forSales: [{ id: 'job_sale3', type: 'job', date: '2026-10-24', time: '10:00', status: 'scheduled', source: 'door_to_door', d2d: { repKey: 'bo.rep', saleId: 'sale-3', kind: 'sale' }, createdAt: '2026-10-18T22:00:00.000Z' }],
};

function fixture({ records = RECORDS, failKnock = false, failJobs = false, failAreas = false, shiftsOverride = null } = {}) {
  const calls = [];
  const rows = (collection, list) => list.map(row => structuredClone(row));
  const store = {
    async get(collection, id) { calls.push(['get', collection, id]); if (failKnock) throw Object.assign(new Error('Synthetic outage'), { code: 'knock_storage_unavailable' }); return collection === 'knock_settings' && id === 'current' ? structuredClone(records.settings) : null; },
    async getMany(collection, ids) {
      calls.push(['getMany', collection, [...ids].sort()]);
      const source = { knock_reps: records.reps, knock_days: records.days, knock_neighborhoods: records.neighborhoods }[collection] || {};
      return new Map(ids.filter(id => source[id]).map(id => [id, { ...structuredClone(source[id]), id }]));
    },
    async query(collection, options) {
      calls.push(['query', collection, structuredClone(options)]);
      if (failAreas && collection === 'knock_assignments') throw Object.assign(new Error('Synthetic index'), { code: 'knock_storage_unavailable' });
      const source = { knock_shifts: shiftsOverride || records.shifts, knock_sales: records.sales, knock_assignments: records.assignments }[collection];
      if (!source) throw new Error('unexpected query ' + collection);
      // Equality and IN filters only (no range on a Knock collection, so no composite index).
      for (const [, op, value] of options.where) { assert.ok(['==', 'in'].includes(op)); if (op === 'in') assert.ok(Array.isArray(value) && value.length >= 1 && value.length <= 30); }
      const match = row => options.where.every(([field, op, value]) => op === 'in' ? value.includes(row[field]) : row[field] === value);
      // The store applies the field mask, as Firestore does.
      return rows(collection, source).filter(match).slice(0, options.limit).map(row => options.select ? Object.fromEntries(Object.entries(row).filter(([key]) => key === 'id' || options.select.includes(key))) : row);
    },
    async list(collection) { calls.push(['list', collection]); throw new Error('no whole-collection reads'); },
  };
  const jobs = {
    async bookedOn(date) { calls.push(['jobs.bookedOn', date]); if (failJobs) throw new Error('index'); return { rows: structuredClone(records.booked), truncated: false }; },
    async createdBetween(from, to) { calls.push(['jobs.createdBetween', from, to]); if (failJobs) throw new Error('index'); return { rows: structuredClone(records.created), truncated: false }; },
    async forSales(ids) { calls.push(['jobs.forSales', [...ids].sort()]); return { rows: structuredClone(records.forSales).filter(row => ids.includes(row.d2d.saleId)), truncated: false }; },
  };
  const handlers = d2dDayHandlers({ session: async request => SESSIONS[request.headers.get('X-Synthetic-Session')] || null, knockStore: () => store, jobReader: () => jobs, configured: () => true, now: () => NOW });
  const get = async (who, query = `?date=${DAY}`, env = {}) => {
    const response = await handlers.get({ request: new Request(`${ORIGIN}/api/d2d-day${query}`, { headers: who ? { 'X-Synthetic-Session': who } : {} }), env });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { get, calls, store, jobs };
}

test('only the owner, managers and team leads read the door-to-door day; the switch answers before any read', async () => {
  for (const who of ['owner', 'manager', 'eli']) {
    const { get } = fixture(), result = await get(who);
    assert.equal(result.status, 200, `${who}: ${JSON.stringify(result.body)}`);
    assert.equal(result.headers.get('Cache-Control'), 'private, no-store');
  }
  for (const who of ['crew', 'crewLead', 'sales', 'phone', 'knocker']) {
    const { get, calls } = fixture(), result = await get(who);
    assert.deepEqual([result.status, result.body.code], [403, 'd2d_day_forbidden'], who);
    assert.deepEqual(calls, [], `${who}: refused before any read`);
  }
  // Seeing the day never depends on the role-access flags (schedule.view needs none).
  for (const env of [{ EGC_STAFF_ROLE_ACCESS: 'true' }, { EGC_STAFF_ROLE_PERMISSIONS: 'true' }]) {
    assert.equal((await fixture().get('eli', `?date=${DAY}`, env)).status, 200);
    assert.equal((await fixture().get('sales', `?date=${DAY}`, env)).status, 403);
  }
  const anonymous = fixture(), signedOut = await anonymous.get(null);
  assert.deepEqual([signedOut.status, signedOut.body.code, anonymous.calls], [401, 'd2d_day_sign_in_required', []]);
  const off = fixture(), disabled = await off.get('owner', `?date=${DAY}`, { EGC_D2D_BOARD: 'false' });
  assert.deepEqual([disabled.status, disabled.body.code, off.calls], [404, 'd2d_day_disabled', []]);
  assert.equal((await fixture().get('owner', `?date=${DAY}`, { EGC_D2D_BOARD: 'true' })).status, 200, 'only exactly "false" turns it off');
  assert.equal(canViewD2dDay(null), false);
  assert.equal(canViewD2dDay(SESSIONS.eli), true);
});

test('the date is a Denver day from 62 days back to 31 ahead, and nothing else is accepted', async () => {
  const params = query => new URLSearchParams(query);
  assert.equal(d2dDayDate(params(''), NOW), DAY, 'no date is today in Denver');
  assert.equal(d2dDayDate(params('date=2026-08-18'), NOW), '2026-08-18');
  assert.equal(d2dDayDate(params('date=2026-11-19'), NOW), '2026-11-19');
  for (const query of ['date=2026-08-17', 'date=2026-11-20', 'date=2026-10-32', 'date=yesterday', 'date=2026-10-19&rep=ana.rep'])
    assert.throws(() => d2dDayDate(params(query), NOW), error => error.code === 'd2d_day_date_invalid' && error.status === 400, query);
  const { get, calls } = fixture(), bad = await get('owner', '?date=2027-01-01');
  assert.deepEqual([bad.status, bad.body.code, calls], [400, 'd2d_day_date_invalid', []]);
  const unconfigured = d2dDayHandlers({ session: async () => SESSIONS.owner, configured: () => false, now: () => NOW });
  const response = await unconfigured.get({ request: new Request(`${ORIGIN}/api/d2d-day?date=${DAY}`), env: {} });
  assert.deepEqual([response.status, (await response.json()).code], [503, 'd2d_day_storage_unavailable']);
});

test('every read is bounded by the day: equality queries, capped, masked, and batch gets for the named records', async () => {
  const { get, calls } = fixture(), result = await get('owner');
  assert.equal(result.status, 200);
  assert.equal(calls.some(call => call[0] === 'list'), false, 'no whole-collection read');
  const queries = calls.filter(call => call[0] === 'query').map(([, collection, options]) => [collection, options.where, options.limit, options.select]);
  // Areas only for the reps who worked that day (never every active assignment in the territory).
  assert.deepEqual(queries, [
    ['knock_shifts', [['day', '==', DAY]], D2D_DAY_LIMIT + 1, ['repKey', 'day', 'startedAt', 'endedAt', 'endReason', 'breaks', 'lastDoorAt', 'lastNeighborhoodId', 'doors']],
    ['knock_sales', [['saleDate', '==', DAY]], D2D_DAY_LIMIT + 1, [...D2D_SALE_FIELDS]],
    ['knock_assignments', [['repKey', 'in', ['ana.rep', 'bo.rep', 'cy.rep']], ['active', '==', true]], D2D_DAY_LIMIT + 1, ['repKey', 'neighborhoodId', 'active', 'source']],
  ]);
  assert.ok(!D2D_SALE_FIELDS.some(field => ['customer', 'ticket', 'depositAmount', 'address', 'commissionTerms', 'quotedAmount', 'street'].includes(field)), 'the sale mask has no customer or money field');
  // Denver midnight to midnight (MDT, UTC-6) for the jobs made that day; the sale whose job was made earlier is found by its id.
  assert.deepEqual(calls.filter(call => call[0].startsWith('jobs.')), [['jobs.bookedOn', DAY], ['jobs.createdBetween', '2026-10-19T06:00:00.000Z', '2026-10-20T06:00:00.000Z'], ['jobs.forSales', ['sale-2', 'sale-3']]]);
  assert.deepEqual(calls.filter(call => call[0] === 'getMany'), [
    ['getMany', 'knock_reps', ['ana.rep', 'bo.rep', 'cy.rep', 'dee.rep']],
    ['getMany', 'knock_days', ['ana.rep_2026-10-19', 'bo.rep_2026-10-19', 'cy.rep_2026-10-19']],
    ['getMany', 'knock_neighborhoods', ['nb_hill', 'nb_lake', 'nb_park']],
  ]);
  assert.deepEqual(calls.filter(call => call[0] === 'get'), [['get', 'knock_settings', 'current']]);
});

test('the answer: reps on shift with their areas, doors, sales and walkthroughs set, and the D2D jobs as links, with no customer or money', async () => {
  const { body } = await fixture().get('eli');
  assert.deepEqual([body.ok, body.authority, body.date, body.timeZone], [true, 'employee_hub', DAY, 'America/Denver']);
  assert.deepEqual(body.reps.map(rep => [rep.repKey, rep.name, rep.onShift]), [['ana.rep', 'Ana Synthetic Rep', true], ['bo.rep', 'Bo Synthetic Rep', false], ['cy.rep', 'cy.rep', false]], 'on shift first, then by name');
  const ana = body.reps[0], bo = body.reps[1], cy = body.reps[2];
  assert.deepEqual(ana.shifts, [{ startedAt: '2026-10-19T15:05:00.000Z', endedAt: null, autoEnded: false }]);
  assert.equal(ana.knockingMinutes, 55);
  assert.deepEqual(ana.areas, [{ id: 'nb_park', name: 'Synthetic Park', claim: 'self', worked: true }, { id: 'nb_lake', name: 'Synthetic Lake', claim: 'admin', worked: false }], 'held areas, worked first; another rep\'s claim is not listed');
  assert.deepEqual([ana.doors, ana.answers, ana.looks, ana.sales, ana.walkthroughsSet], [40, 14, 5, 1, 1], 'a cancelled sale does not count');
  assert.deepEqual(ana.saleList, [{ id: 'sale-1', status: 'booked', package: 'Synthetic Reset', jobDate: '2026-10-23', jobStartTime: '09:30', jobId: 'job_sale1' }, { id: 'sale-2', status: 'cancelled', package: 'Synthetic Basic', jobDate: '2026-10-23', jobStartTime: '09:30', jobId: null }]);
  assert.deepEqual(ana.jobs, [{ id: 'walk_set', kind: 'walkthrough', type: 'walkthrough', date: '2026-10-21', time: '10:00', status: 'scheduled' }, { id: 'job_sale1', kind: 'sale', type: 'job', date: '2026-10-23', time: '09:30', status: 'scheduled' }]);
  assert.deepEqual([bo.doors, bo.sales, bo.shifts[0].endedAt, bo.areas], [12, 1, '2026-10-19T15:00:00.000Z', [{ id: 'nb_hill', name: 'Synthetic Hill', claim: null, worked: true }]], 'no day summary yet: the shift doors count');
  assert.deepEqual(bo.saleList.map(row => row.jobId), ['job_sale3'], 'a sale whose job was made on another day still links');
  assert.deepEqual([cy.onShift, cy.shifts[0].autoEnded, cy.shifts[0].endedAt], [false, true, '2026-10-19T11:01:00.000Z'], 'an idle shift ends at its last door');
  assert.deepEqual(body.totals, { reps: 3, onShift: 1, doors: 53, sales: 2, walkthroughsSet: 1 });
  assert.deepEqual(body.jobs.map(row => [row.id, row.kind, row.repKey, row.repName, row.bookedToday, row.createdToday]), [
    ['job_today', 'sale', 'dee.rep', 'Dee Synthetic Rep', true, false], ['walk_set', 'walkthrough', 'ana.rep', 'Ana Synthetic Rep', false, true],
    ['job_sale1', 'sale', 'ana.rep', 'Ana Synthetic Rep', false, true], ['job_sale3', 'sale', 'bo.rep', 'Bo Synthetic Rep', false, false]], 'the office\'s own job is not a D2D job');
  for (const row of body.jobs) assert.deepEqual(Object.keys(row).filter(key => key !== 'saleId').sort(), ['bookedToday', 'createdToday', 'date', 'id', 'kind', 'repKey', 'repName', 'status', 'time', 'type']);
  assert.deepEqual(body.coverage, { complete: true, truncated: [], missing: [], asOf: NOW.toISOString() });
  const text = JSON.stringify(body);
  for (const secret of ['Synthetic Customer Person', 'Person', '9705550142', 'example.invalid', 'Fixture Lane', '1850', '462', 'bookedRevenue', 'commission', 'ticket', 'deposit', 'quoted', 'phone', 'email', 'nb_far', 'zed.rep'])
    assert.ok(!text.includes(secret), `${secret} must not leave`);
});

test('a capped query or unreadable Hub jobs is said, never shown as a complete day; a Knock outage is a 503', async () => {
  const many = Array.from({ length: D2D_DAY_LIMIT + 5 }, (_, index) => shift(`s${index}`, `rep${String(index).padStart(3, '0')}`, '2026-10-19T15:00:00.000Z'));
  const capped = await fixture({ shiftsOverride: many }).get('owner');
  assert.equal(capped.status, 200);
  assert.deepEqual([capped.body.coverage.complete, capped.body.coverage.truncated], [false, ['shifts']]);
  assert.equal(capped.body.reps.length, D2D_DAY_LIMIT + 2, 'the capped shifts plus the two reps with sales');
  const jobsDown = fixture({ failJobs: true }), partial = await jobsDown.get('owner');
  assert.equal(partial.status, 200);
  assert.deepEqual([partial.body.coverage.complete, partial.body.coverage.missing, partial.body.jobs], [false, ['jobs'], []]);
  assert.equal(jobsDown.calls.some(call => call[0] === 'jobs.forSales'), false, 'no sale lookup once the jobs read failed');
  assert.equal(partial.body.reps[0].doors, 40, 'the Knock day still shows');
  const down = await fixture({ failKnock: true }).get('owner');
  assert.deepEqual([down.status, down.body.code], [503, 'd2d_day_storage_unavailable']);
  // Pure summary: an empty day.
  const empty = d2dDaySummary({ date: DAY, settings: {}, now: NOW });
  assert.deepEqual([empty.reps, empty.jobs, empty.totals, empty.coverage.complete], [[], [], { reps: 0, onShift: 0, doors: 0, sales: 0, walkthroughsSet: 0 }, true]);
});

test('a job is door-to-door only with the bridge\'s d2d record (or source); the record is read defensively', () => {
  assert.deepEqual(d2dMarker({ type: 'job', d2d: { repKey: 'ana.rep', saleId: 'sale-1', kind: 'sale' } }), { repKey: 'ana.rep', kind: 'sale', saleId: 'sale-1' });
  assert.deepEqual(d2dMarker({ type: 'walkthrough', d2d: { repKey: 'ana.rep', setterEventId: 'e1' } }), { repKey: 'ana.rep', kind: 'walkthrough', saleId: '' });
  for (const job of [{}, { d2d: null }, { d2d: [] }, { d2d: { repKey: '../x' } }, { d2d: 'ana.rep' }]) assert.equal(d2dMarker(job), null);
  const summary = d2dDaySummary({ date: DAY, settings: {}, now: NOW, jobs: [{ id: 'bad id', source: 'door_to_door' }, { id: 'lock', recordType: 'schedule_lock', source: 'door_to_door' }, { id: 'ok_1', source: 'door_to_door', type: 'job', date: DAY }] });
  assert.deepEqual(summary.jobs.map(row => [row.id, row.kind, row.repKey]), [['ok_1', 'sale', '']]);
});

test('the Hub jobs reader asks Firestore for bounded, masked queries and fails closed on a malformed answer', async () => {
  const sent = [];
  const document = (id, fields) => ({ document: { name: `projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`, fields: encodeFirestoreFields(fields), updateTime: '2026-10-19T00:00:00Z' }, readTime: '2026-10-19T00:00:00Z' });
  let answer = () => [document('job_1', { date: DAY, source: 'door_to_door', d2d: { repKey: 'ana.rep', saleId: 'sale-1', kind: 'sale' } })];
  const fetcher = async (env, url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, json: async () => answer() }; };
  const reader = d2dJobReader({}, fetcher);
  const booked = await reader.bookedOn(DAY);
  assert.deepEqual(booked.rows.map(row => [row.id, row.d2d.repKey]), [['job_1', 'ana.rep']]);
  assert.equal(booked.truncated, false);
  const [first] = sent;
  assert.match(first.url, /documents:runQuery$/);
  assert.deepEqual(first.body.structuredQuery.select.fields.map(field => field.fieldPath), [...D2D_JOB_FIELDS]);
  assert.ok(!D2D_JOB_FIELDS.some(field => ['customer', 'phone', 'address', 'estimate', 'total', 'notes'].includes(field)));
  assert.deepEqual(first.body.structuredQuery.where.compositeFilter.filters.map(filter => [filter.fieldFilter.field.fieldPath, filter.fieldFilter.op]), [['date', 'EQUAL'], ['source', 'EQUAL']]);
  assert.equal(first.body.structuredQuery.limit, D2D_DAY_LIMIT + 1);
  assert.equal(first.body.structuredQuery.orderBy, undefined, 'equality only: no composite index');
  await reader.createdBetween('2026-10-19T06:00:00.000Z', '2026-10-20T06:00:00.000Z');
  const range = sent[1].body.structuredQuery;
  // Only the door-to-door jobs made that day, through the declared jobs source+createdAt index; never every job of the day.
  assert.deepEqual(range.where.compositeFilter.filters.map(filter => [filter.fieldFilter.field.fieldPath, filter.fieldFilter.op, filter.fieldFilter.value.stringValue]), [['source', 'EQUAL', 'door_to_door'], ['createdAt', 'GREATER_THAN_OR_EQUAL', '2026-10-19T06:00:00.000Z'], ['createdAt', 'LESS_THAN', '2026-10-20T06:00:00.000Z']]);
  assert.deepEqual(range.orderBy.map(order => order.field.fieldPath), ['createdAt', '__name__']);
  const indexes = JSON.parse(readFileSync(new URL('../firestore.indexes.json', import.meta.url), 'utf8')).indexes;
  assert.ok(indexes.some(index => index.collectionGroup === 'jobs' && index.queryScope === 'COLLECTION' && index.fields.map(field => `${field.fieldPath}:${field.order}`).join() === 'source:ASCENDING,createdAt:ASCENDING'), 'the composite index the range query needs is declared');
  const ids = Array.from({ length: 31 }, (_, index) => `sale-${index}`);
  await reader.forSales(ids);
  assert.deepEqual(sent.slice(2).map(call => [call.body.structuredQuery.where.fieldFilter.field.fieldPath, call.body.structuredQuery.where.fieldFilter.op, call.body.structuredQuery.where.fieldFilter.value.arrayValue.values.length]), [['d2d.saleId', 'IN', 30], ['d2d.saleId', 'IN', 1]]);
  answer = () => Array.from({ length: D2D_DAY_LIMIT + 1 }, (_, index) => document(`job_${index}`, { date: DAY }));
  const full = await reader.bookedOn(DAY);
  assert.deepEqual([full.rows.length, full.truncated], [D2D_DAY_LIMIT, true]);
  answer = () => [];
  await assert.rejects(reader.bookedOn(DAY), error => error.code === 'd2d_day_storage_unavailable', 'an empty array without a readTime is not an empty result');
  answer = () => [{ readTime: '2026-10-19T00:00:00Z' }];
  assert.deepEqual((await reader.bookedOn(DAY)).rows, []);
  const failing = d2dJobReader({}, async () => ({ ok: false, json: async () => ({}) }));
  await assert.rejects(failing.bookedOn(DAY), error => error.code === 'd2d_day_storage_unavailable');
  const offline = d2dJobReader({}, async () => { throw new Error('offline'); });
  await assert.rejects(offline.createdBetween('a', 'b'), error => error.status === 503);
});

test('loadD2dDay reads nothing more for a quiet day', async () => {
  const quiet = { ...RECORDS, shifts: [], sales: [], booked: [], created: [], forSales: [] };
  const { calls, store, jobs } = fixture({ records: quiet });
  const records = await loadD2dDay({ store, jobs, date: DAY });
  assert.deepEqual([records.shifts, records.sales, records.jobs, records.truncated, records.missing], [[], [], [], [], []]);
  assert.equal(calls.filter(call => call[0] === 'getMany').length, 0, 'no reps, days or areas to read');
});

test('a walkthrough set that day by a rep with no shift or sale that day still counts, on a row for that rep', async () => {
  // A phone that synced after its shift: the walkthrough job reached the Hub today, and the rep has no shift today.
  const late = { id: 'walk_late', type: 'walkthrough', date: '2026-10-22', time: '11:00', status: 'scheduled', source: 'door_to_door', d2d: { repKey: 'eve.rep', setterEventId: 'event-late', kind: 'walkthrough' }, createdAt: '2026-10-19T14:10:00.000Z' };
  const records = { ...RECORDS, shifts: [], sales: [], booked: [], forSales: [], created: [late], reps: { 'eve.rep': { displayName: 'Eve Synthetic Rep' } },
    assignments: [{ id: 'eve.rep__nb_park__all', repKey: 'eve.rep', neighborhoodId: 'nb_park', active: true, source: 'self' }, ...RECORDS.assignments] };
  const { get, calls } = fixture({ records }), { body } = await get('owner');
  assert.deepEqual(body.reps.map(rep => [rep.repKey, rep.name, rep.onShift, rep.shifts, rep.walkthroughsSet]), [['eve.rep', 'Eve Synthetic Rep', false, [], 1]]);
  assert.deepEqual(body.reps[0].jobs, [{ id: 'walk_late', kind: 'walkthrough', type: 'walkthrough', date: '2026-10-22', time: '11:00', status: 'scheduled' }]);
  assert.deepEqual(body.reps[0].areas, [{ id: 'nb_park', name: 'Synthetic Park', claim: 'self', worked: false }]);
  assert.equal(body.totals.walkthroughsSet, 1);
  assert.deepEqual(calls.filter(call => call[0] === 'query' && call[1] === 'knock_assignments').map(call => call[2].where), [[['repKey', 'in', ['eve.rep']], ['active', '==', true]]]);
  assert.deepEqual(calls.find(call => call[0] === 'getMany' && call[1] === 'knock_days'), ['getMany', 'knock_days', ['eve.rep_2026-10-19']]);
  // The pure summary agrees: the totals count every walkthrough set that day.
  const summary = d2dDaySummary({ date: DAY, settings: {}, now: NOW, jobs: [late] });
  assert.deepEqual([summary.reps.map(rep => rep.repKey), summary.totals.walkthroughsSet, summary.totals.reps], [['eve.rep'], 1, 1]);
  // A D2D job booked today but made on another day is a link, not a rep row.
  const booked = d2dDaySummary({ date: DAY, settings: {}, now: NOW, jobs: [{ ...late, id: 'walk_old', date: DAY, createdAt: '2026-10-12T14:10:00.000Z' }] });
  assert.deepEqual([booked.reps, booked.totals.walkthroughsSet, booked.jobs.map(row => [row.id, row.bookedToday, row.createdToday])], [[], 0, [['walk_old', true, false]]]);
});

test('more than 30 working reps read their areas in IN chunks of 30, each capped', async () => {
  const many = Array.from({ length: 31 }, (_, index) => shift(`s${index}`, `rep${String(index).padStart(2, '0')}`, '2026-10-19T15:00:00.000Z'));
  const { get, calls } = fixture({ records: { ...RECORDS, shifts: many, sales: [], created: [], booked: [], forSales: [] } });
  assert.equal((await get('owner')).status, 200);
  const chunks = calls.filter(call => call[0] === 'query' && call[1] === 'knock_assignments').map(call => [call[2].where[0][2].length, call[2].where[1], call[2].limit]);
  assert.deepEqual(chunks, [[30, ['active', '==', true], D2D_DAY_LIMIT + 1], [1, ['active', '==', true], D2D_DAY_LIMIT + 1]]);
});

test('the dispatch schedule carries a door-to-door job\'s mark, and nothing else of its D2D record', () => {
  assert.ok(JOB_FIELDS.includes('source') && JOB_FIELDS.includes('d2d.kind'), 'the dispatch scan reads the mark');
  assert.ok(!JOB_FIELDS.some(field => field === 'd2d' || (field.startsWith('d2d.') && field !== 'd2d.kind')), 'never the rep, house or sale behind it');
  const base = { id: 'job_d2d', revision: 'r1', type: 'job', date: DAY, time: '09:30', endDate: DAY, endTime: '11:30', status: 'scheduled', assignedCrew: [] };
  const marked = projectDispatchJob({ ...base, source: 'door_to_door', d2d: { kind: 'sale', repKey: 'ana.rep', saleId: 'sale-1', houseId: 'house-9' } });
  assert.deepEqual([marked.source, marked.d2d], ['door_to_door', { kind: 'sale' }]);
  assert.deepEqual(projectDispatchJob({ ...base, type: 'walkthrough', source: 'door_to_door', d2d: { kind: 'walkthrough' } }).d2d, { kind: 'walkthrough' });
  for (const other of [{ source: 'hub' }, { source: 'jobber' }, {}, { d2d: { kind: 'other' } }]) {
    const plain = projectDispatchJob({ ...base, ...other });
    assert.deepEqual(['source' in plain, 'd2d' in plain], [false, false], JSON.stringify(other));
  }
});

test('held areas that cannot be read are said, and the rest of the day still shows', async () => {
  const { body, status } = await fixture({ failAreas: true }).get('owner');
  assert.equal(status, 200);
  assert.deepEqual([body.coverage.complete, body.coverage.missing, body.coverage.truncated], [false, ['areas'], []]);
  const ana = body.reps.find(rep => rep.repKey === 'ana.rep');
  assert.deepEqual([ana.doors, ana.sales, ana.areas], [40, 1, [{ id: 'nb_park', name: 'Synthetic Park', claim: null, worked: true }]], 'areas worked that day still show, without their claim');
});
