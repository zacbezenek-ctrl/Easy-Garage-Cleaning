import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MON, NOW, MIN, busy, bridgeWorld, saleBatch } from './helpers/knock-bridge-fixture.mjs';
import { readMeter, readsOf } from './helpers/read-meter.mjs';
import { firestoreRest } from './helpers/firestore-rest-queries.mjs';
import { staffEnv, vaultFirestore } from './helpers/vault-fixture.mjs';
import { addDays } from '../functions/_lib/dispatch-time.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { mutateDispatch } from '../functions/_lib/dispatch-service.js';
import { windowFloor } from '../functions/_lib/dispatch-window-reads.js';
import { dispatchHandlers } from '../functions/api/dispatch.js';
import { crewScheduleHandlers, leadNames } from '../functions/api/crew-schedule.js';
import { createEmployeeApplication, reviewEmployeeApplication } from '../functions/_lib/employee-accounts.js';
import { REP_WALKTHROUGH_LIMIT } from '../functions/_lib/knock-walkthroughs.js';

// READ-BUDGET (review findings read-budget-perf-1, -3, -4 and -6): the owner pays per Firestore read on a tight daily
// budget. Each test counts the reads an action is billed for (helpers/read-meter.mjs) and checks the answer is what the
// longer read gave. Synthetic data only.

const WINDOWED = { EGC_DISPATCH_WINDOWED_READS: 'true' };
const TODAY = '2026-10-20';
const weekend = date => [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
const lock = date => ({ recordType: 'schedule_lock', date, entries: [], updatedAt: '2026-10-01T00:00:00.000Z' });
// A working schedule: every weekday both crews are out 13:00-15:00 and the estimator 11:00-12:00, a day lock each day,
// from `back` days ago to `ahead` days on, and the dispatch guard a live Hub always has.
function history({ back = 60, ahead = 21 } = {}) {
  const seed = { 'dispatchState/revision': { updatedAt: '2026-10-19T00:00:00.000Z', lastRequestId: 'synthetic-seed' } };
  for (let offset = -back; offset <= ahead; offset++) {
    const date = addDays(TODAY, offset);
    seed[`jobs/_egc_schedule_lock_${date}`] = lock(date);
    if (weekend(date)) { seed[`jobs/we_${date}`] = busy(date, ['crew.c1'], { time: '10:00', endTime: '12:00', crewId: 'crew_three' }); continue; }
    seed[`jobs/a_${date}`] = busy(date, ['crew.a1', 'crew.a2'], { time: '13:00', endTime: '15:00', crewId: 'crew_one' });
    seed[`jobs/b_${date}`] = busy(date, ['crew.b1', 'crew.b2'], { time: '13:00', endTime: '15:00', crewId: 'crew_two' });
    seed[`jobs/w_${date}`] = busy(date, ['est.alex'], { type: 'walkthrough', time: '11:00', endTime: '12:00' });
  }
  return seed;
}
// Rows a ranged or unbounded jobs read returns from a seed (jobs/ documents only).
const jobRows = seed => Object.entries(seed).filter(([path]) => path.startsWith('jobs/')).map(([, row]) => row);
const startingIn = (seed, from, to) => jobRows(seed).filter(row => typeof row.date === 'string' && row.date >= from && row.date <= to).length;
const unbounded = (seed, floor) => jobRows(seed).filter(row => typeof row.endDate === 'string' && row.endDate >= floor).length + jobRows(seed).filter(row => typeof row.date === 'string' && row.date >= floor).length;
const body = response => ({ ...response.body, serverTime: undefined });
const QUICK = `?from=${MON}&days=7&package=${encodeURIComponent('Quick Clear')}`, WORKS = `?from=${MON}&days=7&package=${encodeURIComponent('The Works')}`;

test('Knock crew slots: one bounded jobs read, then the snapshot is reused while nothing changed; a save, a lock or five minutes read again', async () => {
  const seed = history(), w = await bridgeWorld({ env: WINDOWED, seed }), meter = readMeter(w.world.fake);
  const first = await meter.measure(() => w.crewSlots(QUICK));
  assert.equal(first.result.status, 200, JSON.stringify(first.result.body));
  assert.ok(first.result.body.slots.some(slot => slot.date === MON && slot.crewLabel === 'Crew 1'), 'Crew 1 is free Monday morning');
  // The window read: rows starting from 35 days before the search to its end (one range, single-field index), the rows
  // running into it from before then (one query on the jobs(endDate, date) index: none here, billed as one read), plus
  // the four undated and availability queries; no endDate pass and no later booking.
  const floor = windowFloor(MON), end = addDays(MON, 7);
  assert.equal(readsOf(first.byKey, 'query:jobs:date+date'), startingIn(seed, floor, end));
  assert.equal(first.byKey['query:jobs:endDate'], undefined, 'no endDate pass');
  assert.equal(first.byKey['query:jobs:endDate+date'], 1);
  assert.equal(readsOf(first.byKey, 'query:jobs'), startingIn(seed, floor, end) + 5);
  assert.ok(readsOf(first.byKey, 'query:jobs') < unbounded(seed, floor), `bounded ${readsOf(first.byKey, 'query:jobs')} vs before ${unbounded(seed, floor)}`);

  // Another package on the same form (or another rep's form): the guard and day locks are unchanged, so the jobs and
  // crews are not read again; the roster (configured users here) and the rules are.
  const again = await meter.measure(() => w.crewSlots(WORKS));
  assert.deepEqual(again.byKey, { 'get:knock_reps': 1, 'get:knock_settings': 1, 'get:dispatchState': 1, 'get:jobs:lock': 7, 'get:dispatchSettings': 1 });
  const fresh = await bridgeWorld({ env: WINDOWED, seed });
  assert.deepEqual(body(again.result), body(await fresh.crewSlots(WORKS)), 'the same answer a world with no snapshot gives');
  assert.deepEqual(body((await meter.measure(() => w.crewSlots(QUICK))).result), body(first.result));

  // The older operations scheduler books Crew 1 all Monday: it writes the day lock, not the guard. Read again.
  w.fake.put(`jobs/_egc_schedule_lock_${MON}`, { ...lock(MON), entries: [{ id: 'synthetic_older_visit', type: 'job', start: '09:00', end: '17:00', status: 'scheduled', assignedCrew: ['crew.a1', 'crew.a2'], assignmentKnown: true }] });
  const locked = await meter.measure(() => w.crewSlots(QUICK));
  assert.ok(readsOf(locked.byKey, 'query:jobs') > 0, 'a changed day lock reads the window again');
  assert.ok(!locked.result.body.slots.some(slot => slot.date === MON && slot.crewLabel === 'Crew 1'), 'and the answer follows it');
  assert.equal(readsOf((await meter.measure(() => w.crewSlots(QUICK))).byKey, 'query:jobs'), 0);
  // Any dispatch save touches the guard: read again.
  w.fake.put('dispatchState/revision', { updatedAt: '2026-10-20T16:00:00.000Z', lastRequestId: 'synthetic-save' });
  assert.ok(readsOf((await meter.measure(() => w.crewSlots(QUICK))).byKey, 'query:jobs') > 0);
  // Five minutes on, read again whatever changed.
  assert.equal(readsOf((await meter.measure(() => w.crewSlots(QUICK))).byKey, 'query:jobs'), 0);
  w.setClock(NOW + 5 * MIN);
  assert.ok(readsOf((await meter.measure(() => w.crewSlots(QUICK))).byKey, 'query:jobs') > 0);
});

test('Knock walkthrough slots reuse the snapshot too, and a booking reuses the form\'s search with no alternatives search', async () => {
  const seed = history(), w = await bridgeWorld({ env: WINDOWED, seed }), meter = readMeter(w.world.fake);
  const slots = await meter.measure(() => w.walkSlots());
  assert.equal(slots.result.status, 200);
  assert.ok(readsOf(slots.byKey, 'query:jobs') > 0);
  const repeat = await meter.measure(() => w.walkSlots());
  assert.deepEqual(repeat.byKey, { 'get:knock_reps': 1, 'get:dispatchState': 1, 'get:jobs:lock': 10, 'get:dispatchSettings': 1 });
  assert.deepEqual(body(repeat.result), body(slots.result));

  // A 7-hour job: no crew is free for it all week, so it is saved without a crew (Sold: needs crew). Before, the booking
  // searched the week, then the save read its window, then the alternatives searched the same week again.
  await meter.measure(() => w.crewSlots(WORKS));
  const { saleId, events } = saleBatch({ sale: { package: 'The Works' } });
  assert.equal((await w.send(events)).status, 200);
  const booked = await meter.measure(() => w.book('sale', saleId));
  assert.deepEqual([booked.result.body.booking.status, booked.result.body.booking.date, booked.result.body.booking.time], ['needs_crew', MON, '09:30']);
  // The booking's search reused the form's snapshot (no range query). The save read its own window once: every row
  // starting from the floor on (a malformed later date is still conflict evidence: review reads-bounded-1), the rows
  // running into it (one indexed query) and the undated '' and null queries (one read each here); no endDate pass.
  assert.equal(booked.byKey['query:jobs:date+date'], undefined);
  assert.equal(booked.byKey['query:jobs:date'], startingIn(seed, windowFloor(MON), '9999-12-31') + 2);
  assert.equal(booked.byKey['query:jobs:endDate+date'], 1);
  assert.equal(booked.byKey['query:jobs:endDate'], undefined);
  assert.equal(readsOf(booked.byKey, 'list:dispatchResources'), 3, 'one crew read: the save\'s own');
  assert.equal(booked.byKey['get:dispatchState'], 2, 'the search\'s guard check and the save\'s guard');
});

// Review reads-bounded-1: the save that commits a crew reads every start from the floor (a malformed date string
// sorting after any bound is conflict evidence in the complete scan), but never the endDate pass, which read every row twice.
test('a dated windowed save reads its conflict evidence once: no endDate pass, every start from the floor, one indexed query for rows running into it', async () => {
  const seed = { ...history({ back: 50, ahead: 40 }), 'customers/c1': { name: 'Synthetic Customer', phone: '9705550100', address: '1 Fixture Way' } };
  const fs = firestoreRest(seed), meter = readMeter(fs);
  const store = { ...dispatchStorage(WINDOWED, fs.fetcher), roster: async () => [{ id: 'crew.a1', name: 'Andy Alpha', role: 'crew' }, { id: 'crew.a2', name: 'Abe Alpha', role: 'crew' }] };
  const owner = { user: 'zacb', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
  const saved = await meter.measure(() => mutateDispatch(store, owner, { action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'job',
    changes: { date: MON, time: '09:30', endTime: '12:00', assignedCrew: ['crew.a1', 'crew.a2'], crewLead: 'crew.a1', jobInstructions: 'Synthetic scope', address: '1 Fixture Way' } }, new Date(NOW).toISOString()));
  assert.equal(saved.result.job.date, MON);
  const floor = windowFloor(MON);
  assert.equal(saved.byKey['query:jobs:endDate'], undefined, 'no endDate pass');
  assert.equal(saved.byKey['query:jobs:endDate+date'], 1, 'no row runs into the window from before the floor: one read');
  assert.equal(saved.byKey['query:jobs:date'], startingIn(seed, floor, '9999-12-31') + 2, 'every start from the floor, and the undated \'\' and null queries');
  assert.ok(readsOf(saved.byKey, 'query:jobs') < unbounded(seed, floor), `${readsOf(saved.byKey, 'query:jobs')} vs before ${unbounded(seed, floor)}`);
  const queries = fs.queries('jobs').map(call => call.body.structuredQuery);
  assert.ok(queries.some(item => JSON.stringify(item.where) === JSON.stringify({ fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: floor } } })));
  const spans = queries.find(item => item.where.compositeFilter);
  assert.deepEqual(spans.where.compositeFilter.filters.map(item => [item.fieldFilter.field.fieldPath, item.fieldFilter.op, item.fieldFilter.value.stringValue]),
    [['endDate', 'GREATER_THAN_OR_EQUAL', floor], ['date', 'LESS_THAN', floor]]);
  assert.deepEqual(spans.orderBy.map(item => item.field.fieldPath), ['endDate', 'date', '__name__']);
});

// POST /api/dispatch (bookers and dispatchers) never shows a no-free-crew answer's alternatives: none are searched.
test('a booker\'s no-free-crew save searches no alternatives; a caller that shows them still gets them', async () => {
  const crew = (id, name, memberIds, priority) => ({ recordType: 'crew', name, memberIds, leadId: memberIds[0], status: 'active', priority, serviceDays: ['mon', 'tue', 'wed', 'thu', 'fri'], code: `crew-${priority}` });
  const seed = { 'dispatchState/revision': { updatedAt: '2026-10-19T00:00:00.000Z' }, 'customers/c1': { name: 'Synthetic One', phone: '9705550100', address: '1 Fixture Way' }, 'customers/c2': { name: 'Synthetic Two', phone: '9705550101', address: '2 Fixture Way' },
    'dispatchResources/crew_one': crew('crew_one', 'Crew 1', ['c1a', 'c1b'], 1), 'dispatchResources/crew_two': crew('crew_two', 'Crew 2', ['c2a', 'c2b'], 2),
    'jobs/out_one': busy(MON, ['c1a', 'c1b'], { time: '09:30', endTime: '17:00', crewId: 'crew_one' }), 'jobs/out_two': busy(MON, ['c2a', 'c2b'], { time: '09:30', endTime: '17:00', crewId: 'crew_two' }) };
  const roster = ['zacb', 'c1a', 'c1b', 'c2a', 'c2b'].map(id => ({ id, name: `Synthetic ${id}`, role: id === 'zacb' ? 'owner' : 'crew' }));
  const env = { ...WINDOWED, EGC_STAFF_ROLE_ACCESS: 'true', EGC_DISPATCH_CREW_AUTO_ASSIGN: 'true' };
  const world = () => { const fs = firestoreRest(seed); return { fs, meter: readMeter(fs), store: () => ({ ...dispatchStorage(env, fs.fetcher), roster: async () => structuredClone(roster) }) }; };
  const create = customerId => ({ action: 'schedule.create', requestId: randomUUID(), customerId, kind: 'job', changes: { date: MON, time: '10:00', endTime: '12:00', jobInstructions: 'Synthetic garage reset' } });
  const sales = { user: 'Sales.Account', displayName: 'Synthetic Sales', role: 'crew', businessAccess: false, source: 'employee-account', staffRoles: ['sales'] };
  const booking = world();
  const posted = await booking.meter.measure(async () => {
    const response = await dispatchHandlers({ session: async () => sales, storage: booking.store, now: () => new Date(NOW) }).post({ env, request: new Request('https://egc.test/api/dispatch', { method: 'POST', headers: { Origin: 'https://egc.test', 'Content-Type': 'application/json' }, body: JSON.stringify(create('c1')) }) });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(posted.result.status, 200, JSON.stringify(posted.result.body));
  assert.deepEqual(posted.result.body.job.assignedCrew, []);
  assert.deepEqual(posted.result.body.warnings.find(warning => warning.code === 'no_crew_available')?.code, 'no_crew_available');
  assert.equal(Object.hasOwn(posted.result.body, 'autoCrew') ? Object.hasOwn(posted.result.body.autoCrew, 'alternatives') : false, false, 'no alternatives key');
  assert.equal(posted.byKey['get:dispatchState'], 1, 'only the save\'s guard: no openings snapshot');
  // The default (the walkthrough handoff shows them): the alternatives search runs, at the bounded window's cost.
  const shown = world(), owner = { user: 'zacb', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
  const handoff = await shown.meter.measure(() => mutateDispatch(shown.store(), owner, create('c2'), new Date(NOW).toISOString(), { autoCrew: true }));
  assert.equal(handoff.result.autoCrew.status, 'unassigned');
  assert.ok(handoff.result.autoCrew.alternatives.length > 0);
  assert.equal(handoff.byKey['get:dispatchState'], 3, 'the save\'s guard and the snapshot\'s two');
  assert.ok(handoff.total > posted.total);
});

// ---------- crew schedule (read-budget-perf-3) ----------

const CREWS = {
  'dispatchResources/crew_one': { recordType: 'crew', name: 'Crew 1', priority: 1, memberIds: ['ana.lead', 'ben.crew'], leadId: 'ana.lead', status: 'active' },
  'dispatchResources/crew_two': { recordType: 'crew', name: 'Crew 2', priority: 2, memberIds: ['cara.crew'], leadId: 'cara.crew', status: 'active' },
};
const visit = (date, endDate, crewId, members, extra = {}) => ({ type: 'job', status: 'scheduled', pipelineStatus: 'scheduled', customer: 'Synthetic Person', address: '1 Fixture Way, Fort Collins, CO 80525', serviceType: 'Garage cleanout',
  date, ...(endDate === undefined ? {} : { endDate }), time: '09:30', endTime: '12:00', crewId, assignedCrew: members, crewLead: members[0], crewNeeded: 1, ...extra });
function scheduleSeed() {
  const seed = { ...CREWS };
  for (let offset = -60; offset <= 30; offset++) {
    const date = addDays('2026-10-16', offset);
    seed[`jobs/_egc_schedule_lock_${date}`] = lock(date);
    if (weekend(date)) continue;
    seed[`jobs/one_${date}`] = visit(date, date, 'crew_one', ['ben.crew']);
    seed[`jobs/two_${date}`] = visit(date, date, 'crew_two', ['cara.crew'], { time: '13:00', endTime: '15:00' });
  }
  Object.assign(seed, {
    'jobs/span_three_days': visit('2026-10-14', '2026-10-17', 'crew_one', ['ben.crew'], { endTime: '15:00' }),
    'jobs/span_long': visit('2026-09-20', '2026-10-16', 'crew_one', ['ana.lead'], { endTime: '08:00' }),
    'jobs/ended_before': visit('2026-10-10', '2026-10-15', 'crew_one', ['ben.crew']),
    'jobs/legacy_no_end': visit('2026-10-16', undefined, 'crew_two', ['cara.crew'], { time: '16:00', endTime: '17:00' }),
  });
  return seed;
}
const SCHEDULE_NOW = new Date('2026-10-16T15:00:00.000Z');
async function schedule(storage, who, query) {
  const sessions = { ben: { user: 'ben.crew', displayName: 'Synthetic Ben', role: 'crew', businessAccess: false }, tyler: { user: 'TylerG', displayName: 'Synthetic Manager', role: 'manager', businessAccess: true } };
  const handlers = crewScheduleHandlers({ session: async () => sessions[who], storage, names: async (env, ids) => Object.fromEntries([...ids].map(id => [id, `Name of ${id}`])), now: () => SCHEDULE_NOW });
  const response = await handlers.get({ request: new Request(`https://easygaragecleaning.com/api/crew-schedule${query}`), env: { FIREBASE_API_KEY: 'firebase-test-crew-schedule' } });
  return { status: response.status, body: await response.json() };
}

test('the crew schedule reads its own days plus the multi-day work running into them, not 32 days of starts', async () => {
  const seed = scheduleSeed();
  for (const [who, query] of [['ben', '?from=2026-10-16&to=2026-10-16'], ['ben', '?from=2026-10-16&to=2026-10-22'], ['tyler', '?from=2026-10-16&to=2026-10-22&scope=all']]) {
    const exact = firestoreRest(seed), lookback = firestoreRest(seed), exactMeter = readMeter(exact), lookbackMeter = readMeter(lookback);
    const now = await exactMeter.measure(() => schedule(env => dispatchStorage(env, exact.fetcher), who, query));
    // Before: the same handler without the multi-day query (as before this change, and until the index is deployed).
    const before = await lookbackMeter.measure(() => schedule(env => ({ ...dispatchStorage(env, lookback.fetcher), spanningJobs: undefined }), who, query));
    assert.equal(now.result.status, 200, JSON.stringify(now.result.body));
    assert.deepEqual(now.result.body, before.result.body, `${who} ${query}: the same schedule`);
    const [from, to] = [query.match(/from=([\d-]+)/)[1], query.match(/to=([\d-]+)/)[1]];
    const spanning = jobRows(seed).filter(row => typeof row.endDate === 'string' && row.endDate >= from && row.date < from).length;
    assert.equal(readsOf(now.byKey, 'query:jobs'), startingIn(seed, from, to) + Math.max(1, spanning), `${who} ${query}`);
    assert.equal(readsOf(before.byKey, 'query:jobs'), startingIn(seed, addDays(from, -32), to));
    assert.ok(readsOf(now.byKey, 'query:jobs') * 3 < readsOf(before.byKey, 'query:jobs'), `${readsOf(now.byKey, 'query:jobs')} vs ${readsOf(before.byKey, 'query:jobs')}`);
  }
  const today = await schedule(env => dispatchStorage(env, firestoreRest(seed).fetcher), 'ben', '?from=2026-10-16&to=2026-10-16');
  assert.ok(today.body.groups[0].jobs.some(row => row.id === 'span_three_days'), 'a job started two days ago still shows');
  // The multi-day query: ranges on endDate and date (the composite index in firestore.indexes.json), masked.
  const fs = firestoreRest(seed);
  await schedule(env => dispatchStorage(env, fs.fetcher), 'ben', '?from=2026-10-16&to=2026-10-16');
  const spanning = fs.queries('jobs').map(call => call.body.structuredQuery).find(query => query.where.compositeFilter.filters.some(item => item.fieldFilter.field.fieldPath === 'endDate'));
  assert.deepEqual(spanning.where.compositeFilter.filters.map(item => [item.fieldFilter.field.fieldPath, item.fieldFilter.op, item.fieldFilter.value.stringValue]), [['endDate', 'GREATER_THAN_OR_EQUAL', '2026-10-16'], ['date', 'LESS_THAN_OR_EQUAL', '2026-10-15']]);
  assert.deepEqual(spanning.orderBy.map(item => item.field.fieldPath), ['endDate', 'date', '__name__']);
  assert.ok(spanning.select.fields.length > 2 && !spanning.select.fields.some(field => ['total', 'phone', 'notes'].includes(field.fieldPath)));
});

test('until the multi-day index is deployed the schedule reads the 32-day range as before; paging and bad rows fail closed', async () => {
  const seed = scheduleSeed(), fs = firestoreRest(seed);
  // The multi-day query is the one filtering on endDate (every schedule query masks endDate in).
  const multiDay = (url, options) => String(url).endsWith(':runQuery') && (JSON.parse(options.body).structuredQuery.where.compositeFilter?.filters || []).some(item => item.fieldFilter?.field.fieldPath === 'endDate');
  let refusals = 0;
  const refusing = async (env, url, options = {}) => multiDay(url, options) && ++refusals
    ? new Response(JSON.stringify([{ error: { code: 400, status: 'FAILED_PRECONDITION', message: 'The query requires an index.' } }]), { status: 400 }) : fs.fetcher(env, url, options);
  const refused = await schedule(env => dispatchStorage(env, refusing), 'ben', '?from=2026-10-16&to=2026-10-22');
  const lookback = await schedule(env => ({ ...dispatchStorage(env, firestoreRest(seed).fetcher), spanningJobs: undefined }), 'ben', '?from=2026-10-16&to=2026-10-22');
  assert.equal(refused.status, 200);
  assert.deepEqual(refused.body, lookback.body);
  assert.ok(fs.queries('jobs').some(call => call.body.structuredQuery.where.compositeFilter.filters[0].fieldFilter.value.stringValue === '2026-09-14'), 'the 32-day range');
  const meter = readMeter(fs), second = await meter.measure(() => schedule(env => dispatchStorage(env, refusing), 'ben', '?from=2026-10-16&to=2026-10-22'));
  assert.deepEqual(second.result.body, lookback.body);
  assert.equal(refusals, 1, 'a refused index is not asked again on the next read (it is retried after ten minutes)');
  assert.equal(readsOf(second.byKey, 'query:jobs'), startingIn(seed, '2026-09-14', '2026-10-22'), 'exactly the reads before this change, none twice');
  // Any other failure is not hidden: no partial schedule.
  const broken = async (env, url, options = {}) => multiDay(url, options) ? new Response('{}', { status: 503 }) : fs.fetcher(env, url, options);
  assert.equal((await schedule(env => dispatchStorage(env, broken), 'ben', '?from=2026-10-16&to=2026-10-16')).status, 503);
  // 501 multi-day rows: two pages, every row once.
  const many = {};
  for (let index = 0; index < 501; index++) many[`jobs/span_${String(index).padStart(3, '0')}`] = visit('2026-10-14', '2026-10-17', 'crew_one', ['ben.crew']);
  const paged = firestoreRest(many), rows = await dispatchStorage({}, paged.fetcher).spanningJobs('2026-10-16', ['type', 'date', 'endDate']);
  assert.equal(new Set(rows.map(row => row.id)).size, 501);
  assert.equal(paged.queries('jobs').length, 2);
  const wrong = firestoreRest({ 'jobs/odd': visit('2026-10-16', '2026-10-17', 'crew_one', ['ben.crew']) });
  const lying = async (env, url, options) => { const response = await wrong.fetcher(env, url, options); if (!String(url).endsWith(':runQuery')) return response; return new Response(JSON.stringify([{ document: { name: 'projects/egcw-1ec83/databases/(default)/documents/jobs/odd', updateTime: '2026-10-01T00:00:00Z', fields: { date: { stringValue: '2026-10-16' }, endDate: { stringValue: '2026-10-17' } } } }]), { status: 200 }); };
  await assert.rejects(dispatchStorage({}, lying).spanningJobs('2026-10-16', ['date', 'endDate']), { code: 'dispatch_storage_incomplete' }, 'a row starting on the day fails closed');
  await assert.rejects(dispatchStorage({}, paged.fetcher).spanningJobs('2026-10-16', ['date']), { code: 'dispatch_storage_mask_required' });
});

test('a lead who is an employee account costs one document read for their name, never every account', async t => {
  const store = vaultFirestore(t), env = staffEnv();
  for (const [firstName, username, approved] of [['Lea', 'Lea.Lead', true], ['Cam', 'Cam.Crew', true], ['Dot', 'Dot.Two', true], ['Pat', 'Pat.Pending', false]]) {
    const application = await createEmployeeApplication(env, { firstName, lastName: 'Synthetic', username, email: `${username.toLowerCase()}@example.com`, phone: '9705550100', password: 'Synthetic password 904!', confirmPassword: 'Synthetic password 904!' });
    if (approved) await reviewEmployeeApplication(env, application.username, 'approved', 'ZacB');
  }
  store.requests.length = 0;
  const names = await leadNames(env, new Set(['lea.lead', 'pat.pending', 'crew.static']));
  assert.deepEqual(names, { 'lea.lead': 'Lea Synthetic', 'crew.static': 'Synthetic Static Crew' }, 'a pending account is not named; a configured user costs nothing');
  assert.deepEqual(store.requests.map(request => request.method).sort(), ['GET', 'GET'], 'one document read per lead who is not a configured user');
  assert.ok(!store.requests.some(request => request.url.pathname.endsWith(':runQuery')), 'never the query over every account');
});

// ---------- the rep's own screens (read-budget-perf-6) ----------

test('My money reads the Hub jobs of the sales it lists this pay period, not every bridged sale of the season', async () => {
  const w = await bridgeWorld(), meter = readMeter(w.world.fake);
  const { saleId, events } = saleBatch();
  await w.send(events);
  assert.equal((await w.book('sale', saleId)).body.booking.status, 'booked');
  // Earlier in the season: twelve more bridged sales of the same shape, sold in August.
  const sale = w.fake.get(`knock_sales/${saleId}`);
  for (let index = 0; index < 12; index++) {
    const { revision, ...row } = sale;
    w.fake.put(`knock_sales/old-${index}`, { ...row, saleDate: `2026-08-${String(index + 3).padStart(2, '0')}`, soldAt: `2026-08-${String(index + 3).padStart(2, '0')}T17:00:00.000Z` });
  }
  const money = await meter.measure(() => w.report('my-money'));
  assert.equal(money.result.status, 200, JSON.stringify(money.result.body));
  assert.equal(readsOf(money.byKey, 'batchGet:jobs'), 1, 'only this period\'s sale (before: thirteen)');
  const line = money.result.body.sales.find(row => row.id === saleId);
  assert.deepEqual(line.job.live, { status: 'scheduled', date: MON, time: '09:30', crewLabel: 'Crew 1' }, 'the listed line still reads the Hub live');
  const old = money.result.body.sales.find(row => row.id === 'old-0');
  assert.deepEqual([old.job.status, Object.hasOwn(old.job, 'live')], ['booked', false], 'an earlier sale keeps its booking view');
});

test('My sales lists the rep\'s newest walkthroughs with one bounded query; before the index is deployed it reads them all as before', async () => {
  const w = await bridgeWorld(), meter = readMeter(w.world.fake), extra = 12;
  const record = (index, repKey = 'rep.one') => ({ repKey, leadKey: '', knockId: `knock-${index}`, houseId: 'h-2900-blue-leaf-dr', neighborhoodId: 'english-ranch', street: 'BLUE LEAF DR',
    address: { number: '2900', street: 'BLUE LEAF DR', unit: '', city: 'Fort Collins', state: 'CO', zip: '' }, customer: { name: `Synthetic ${index}`, phone: '+19705550100', email: '' }, textConsent: false,
    requested: { date: MON, time: null, part: 'am', estimatorRef: null, source: 'preference' }, note: '', setAt: new Date(NOW - (index + 1) * 3600000).toISOString(), status: 'booked',
    booking: { status: 'booked', jobId: `visit-${index}`, date: MON, time: '10:00', endTime: '11:00', estimator: 'Alex', message: '' }, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' });
  for (let index = 0; index < REP_WALKTHROUGH_LIMIT + extra; index++) w.fake.put(`knock_walkthroughs/wt-${String(index).padStart(3, '0')}`, record(index));
  w.fake.put('knock_walkthroughs/other-rep', record(0, 'rep.two'));
  const mine = await meter.measure(() => w.report('my-sales'));
  assert.equal(mine.result.status, 200, JSON.stringify(mine.result.body));
  assert.equal(mine.byKey['query:knock_walkthroughs:repKey'], REP_WALKTHROUGH_LIMIT, `the newest ${REP_WALKTHROUGH_LIMIT}, not all ${REP_WALKTHROUGH_LIMIT + extra}`);
  assert.equal(mine.byKey['query:knock_walkthroughs:repKey+status'], 1, 'and the rep\'s walkthroughs still booking: none here, one read');
  assert.deepEqual(mine.result.body.walkthroughs.map(row => row.id), Array.from({ length: REP_WALKTHROUGH_LIMIT }, (_, index) => `wt-${String(index).padStart(3, '0')}`), 'newest first');
  const query = w.fake.queries('knock_walkthroughs').filter(call => call.body.structuredQuery.orderBy.some(item => item.field.fieldPath === 'setAt')).at(-1).body.structuredQuery;
  assert.deepEqual([query.orderBy.map(item => [item.field.fieldPath, item.direction]), query.limit], [[['setAt', 'DESCENDING'], ['__name__', 'ASCENDING']], REP_WALKTHROUGH_LIMIT]);
  // Firestore without the index refuses the ordered query: the full read, as before, showing the same newest ones.
  const inner = w.world.fake.fetcher;
  w.world.fake.fetcher = async (env, url, options = {}) => String(url).endsWith(':runQuery') && String(options.body || '').includes('"setAt"')
    ? new Response(JSON.stringify([{ error: { code: 400, status: 'FAILED_PRECONDITION', message: 'The query requires an index.' } }]), { status: 400 }) : inner(env, url, options);
  const fallback = await meter.measure(() => w.report('my-sales'));
  assert.equal(fallback.result.status, 200);
  assert.equal(readsOf(fallback.byKey, 'query:knock_walkthroughs'), REP_WALKTHROUGH_LIMIT + extra + 1);
  assert.deepEqual(fallback.result.body.walkthroughs, mine.result.body.walkthroughs);
});

// Review reads-mysales-1: My sales puts a walkthrough still booking back in the phone's booking queue (crew/knock-sale.js
// mySalesScreen), the way one whose phone lost its queue gets booked. One older than the rep's newest 50 is still listed.
test('My sales still lists a walkthrough waiting to book that is older than the rep\'s newest 50, with or without the index', async () => {
  const w = await bridgeWorld(), meter = readMeter(w.world.fake), count = REP_WALKTHROUGH_LIMIT + 5;
  const record = (index, booking) => ({ repKey: 'rep.one', leadKey: '', knockId: `knock-${index}`, houseId: `h-${3000 + index}-blue-leaf-dr`, neighborhoodId: 'english-ranch', street: 'BLUE LEAF DR',
    address: { number: String(3000 + index), street: 'BLUE LEAF DR', unit: '', city: 'Fort Collins', state: 'CO', zip: '' }, customer: { name: `Synthetic ${index}`, phone: '+19705550100', email: '' }, textConsent: false,
    requested: { date: MON, time: null, part: 'am', estimatorRef: null, source: 'preference' }, note: '', setAt: new Date(NOW - (count - index) * 3600000).toISOString(),
    status: booking.status === 'booked' ? 'booked' : 'set', booking, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' });
  for (let index = 0; index < count; index++) w.fake.put(`knock_walkthroughs/wt-${String(index).padStart(3, '0')}`, record(index, index === 0
    ? { status: 'retry', jobId: '', code: 'dispatch_storage_unavailable', attempts: 1, retryAfter: new Date(NOW - 3600000).toISOString() }
    : { status: 'booked', jobId: `visit-${index}`, date: MON, time: '10:00', endTime: '11:00', estimator: 'Alex', message: '' }));
  // What mySalesScreen puts back in the booking queue.
  const requeued = body => body.walkthroughs.filter(row => ['pending', 'retry'].includes(row.booking?.status || 'pending') && row.status === 'set').map(row => row.id);
  const mine = await meter.measure(() => w.report('my-sales'));
  assert.equal(mine.result.status, 200, JSON.stringify(mine.result.body));
  assert.equal(mine.result.body.walkthroughs.length, REP_WALKTHROUGH_LIMIT + 1, 'the newest 50 and the older one still booking');
  assert.equal(mine.result.body.walkthroughs.at(-1).id, 'wt-000', 'newest first: the old one last');
  assert.deepEqual(requeued(mine.result.body), ['wt-000']);
  assert.deepEqual([mine.byKey['query:knock_walkthroughs:repKey'], mine.byKey['query:knock_walkthroughs:repKey+status']], [REP_WALKTHROUGH_LIMIT, 1], 'still two bounded queries');
  const open = w.fake.queries('knock_walkthroughs').at(-1).body.structuredQuery;
  assert.deepEqual([open.where.compositeFilter.filters.map(item => [item.fieldFilter.field.fieldPath, item.fieldFilter.op, item.fieldFilter.value.stringValue]), open.orderBy.map(item => item.field.fieldPath), open.limit],
    [[['repKey', 'EQUAL', 'rep.one'], ['status', 'EQUAL', 'set']], ['__name__'], REP_WALKTHROUGH_LIMIT], 'equality only: no composite index');
  // Before the index is deployed: the full read, the same list.
  const inner = w.world.fake.fetcher;
  w.world.fake.fetcher = async (env, url, options = {}) => String(url).endsWith(':runQuery') && String(options.body || '').includes('"setAt"')
    ? new Response(JSON.stringify([{ error: { code: 400, status: 'FAILED_PRECONDITION', message: 'The query requires an index.' } }]), { status: 400 }) : inner(env, url, options);
  const fallback = await w.report('my-sales');
  assert.deepEqual(fallback.body.walkthroughs, mine.result.body.walkthroughs);
});
