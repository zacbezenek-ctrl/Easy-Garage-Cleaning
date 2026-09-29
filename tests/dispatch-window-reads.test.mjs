import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { dispatchOverview, mutateDispatch, mutateDispatchSelfAssignment } from '../functions/_lib/dispatch-service.js';
import { dispatchOpenings } from '../functions/_lib/dispatch-openings.js';
import { dispatchTravelRoutes } from '../functions/_lib/dispatch-travel.js';
import { prepareHandoff } from '../functions/_lib/walkthrough-handoff.js';
import { dispatchHandlers } from '../functions/api/dispatch.js';
import { dispatchOpeningsHandlers } from '../functions/api/dispatch-openings.js';
import { dispatchReadMode, windowQueries, windowFloor, pagedQuery, windowRelevant, windowDiff, rowsWindow, aggregateCount, customerCoverage, scanOnlyReason, WINDOW_MARGIN_DAYS } from '../functions/_lib/dispatch-window-reads.js';
import { customerSearchFields, customerSearchKeys, SEARCH_KEYS_VERSION } from '../functions/_lib/customer-identity.js';
import { firestoreRest, ROOT } from './helpers/firestore-rest-queries.mjs';

const NOW = new Date('2026-09-22T12:00:00.000Z');
const START = '2026-09-22', END = '2026-09-29';
const manager = { user: 'zacb', displayName: 'Owner', role: 'owner', businessAccess: true };
const ROSTER = [{ id: 'zacb', name: 'Owner', role: 'owner' }, { id: 'crew1', name: 'Crew One', role: 'crew' }, { id: 'crew2', name: 'Crew Two', role: 'crew' }, { id: 'crew3', name: 'Crew Three', role: 'crew' }];
const MODES = { full: undefined, shadow: 'shadow', windowed: 'true' };
const visit = (date, time, endDate, endTime, crew = ['crew1'], extra = {}) => ({ type: 'job', status: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', address: '100 Synthetic Way, Fort Collins, CO 80525', jobInstructions: 'Synthetic scope', date, time, endDate, endTime, assignedCrew: crew, crewLead: crew[0] || null, crewNeeded: crew.length || 1, travelBufferMinutes: 20, ...extra });

// Rows the window starting 2026-09-22 must and must not read. Floor: 2026-08-18.
function scheduleSeed() {
  return {
    'customers/c1': { name: 'Synthetic Customer', phone: '(970) 555-0100', address: '100 Synthetic Way' },
    'customers/c2': { name: 'Second Synthetic', phone: '(970) 555-0111', address: '200 Synthetic Way' },
    'dispatchResources/truck-1': { recordType: 'vehicle', name: 'Synthetic Truck', status: 'available', notes: '' },
    'dispatchResources/off-crew2': { recordType: 'availability', employeeId: 'crew2', date: '2026-09-24', endDate: '2026-09-24', allDay: true, status: 'active', reason: '' },
    'jobs/prior-multi': visit('2026-09-19', '08:00', '2026-09-23', '17:00', ['crew1'], { vehicleId: 'truck-1' }),
    'jobs/long-31': visit('2026-08-22', '08:00', '2026-09-22', '08:00', ['crew3']),
    'jobs/legacy-no-end': (({ endDate, ...row }) => row)(visit('2026-09-24', '09:00', '', '11:00', ['crew2'])),
    'jobs/legacy-empty-end': visit('2026-09-25', '09:00', '', '11:00', ['crew1']),
    'jobs/legacy-null-end': visit('2026-09-26', '13:00', null, '15:00', ['crew1']),
    'jobs/same-day-a': visit('2026-09-22', '18:00', '2026-09-22', '19:00', ['crew2'], { address: '300 Synthetic Way, Loveland, CO 80537' }),
    'jobs/same-day-b': visit('2026-09-22', '19:10', '2026-09-22', '20:00', ['crew2'], { address: '400 Synthetic Way, Greeley, CO 80631', type: 'walkthrough' }),
    'jobs/split': visit('2026-09-20', '08:00', '2026-09-23', '12:00', ['crew1', 'crew3'], { assignmentSegments: [
      { id: 's1', date: '2026-09-20', time: '08:00', endDate: '2026-09-20', endTime: '12:00', assignedCrew: ['crew3'], crewLead: 'crew3', crewId: null, vehicleId: null, notes: '' },
      { id: 's2', date: '2026-09-23', time: '08:00', endDate: '2026-09-23', endTime: '12:00', assignedCrew: ['crew1'], crewLead: 'crew1', crewId: null, vehicleId: null, notes: '' }] }),
    'jobs/block': { type: 'blocked', title: 'Synthetic training', status: 'scheduled', date: '2026-09-27', time: '08:00', endDate: '2026-09-27', endTime: '12:00', assignedCrew: [] },
    'jobs/backlog-empty': visit('', '', '', '', [], { status: 'unscheduled', assignedCrew: [] }),
    'jobs/backlog-null': visit(null, '', null, '', [], { status: 'unscheduled', assignedCrew: [] }),
    'jobs/old-availability': { type: 'availability', recordType: 'crew_availability', employee: 'crew1', date: '2025-01-05', endDate: '2025-01-05', allDay: true, status: 'active' },
    'jobs/legacy-availability': { type: 'availability', employee: 'Crew Two', date: '2026-09-28', allDay: true, status: 'active' },
    'jobs/undated-availability': { type: 'availability', employee: 'Crew Three', status: 'active' },
    'jobs/history': visit('2026-08-10', '08:00', '2026-08-12', '17:00', ['crew1']),
    'jobs/history-done': visit('2025-03-01', '08:00', '2025-03-01', '10:00', ['crew1'], { status: 'completed' }),
    'jobs/at-floor': visit('2026-08-18', '08:00', '2026-08-18', '10:00', ['crew2']),
    'jobs/future': visit('2027-10-01', '08:00', '2027-10-01', '10:00', ['crew1']),
    'jobs/_egc_schedule_lock_2026-09-22': { recordType: 'schedule_lock', date: '2026-09-22', entries: [] },
  };
}
function stores(seed = scheduleSeed()) {
  const logs = [], log = { info: line => logs.push(JSON.parse(line)), warn: line => logs.push(JSON.parse(line)) };
  const build = mode => { const fs = firestoreRest(seed); return { fs, store: { ...dispatchStorage({ EGC_DISPATCH_WINDOWED_READS: MODES[mode] }, fs.fetcher), roster: async () => structuredClone(ROSTER), log } }; };
  return { logs, full: build('full'), shadow: build('shadow'), windowed: build('windowed') };
}
const modes = set => Object.entries({ full: set.full, shadow: set.shadow, windowed: set.windowed });
// The mutation response projects job time with the service clock; compare everything else.
const settled = outcome => { if (outcome.result?.job?.jobTime) delete outcome.result.job.jobTime.asOf; return outcome; };

test('EGC_DISPATCH_WINDOWED_READS defaults to complete scans; only exact values change reads', () => {
  for (const [value, mode] of [[undefined, 'full'], ['', 'full'], ['false', 'full'], ['yes', 'full'], ['1', 'full'], ['shadow', 'shadow'], [' Shadow ', 'shadow'], ['true', 'windowed'], ['TRUE', 'windowed']]) assert.equal(dispatchReadMode({ EGC_DISPATCH_WINDOWED_READS: value }), mode, String(value));
  assert.equal(dispatchStorage({}).windowedReads, 'full');
  assert.equal(WINDOW_MARGIN_DAYS >= 33, true, 'a 31-day job (32 calendar days across DST) plus one travel day must stay inside the margin');
  assert.equal(windowFloor(START), '2026-08-18');
});

test('window queries find prior-day multi-day, 31-day, legacy, undated and every availability row, and skip old history', async () => {
  const { windowed: { fs, store } } = stores();
  const rows = await store.jobsNear(START, END), ids = rows.map(row => row.id);
  assert.deepEqual(ids, ['_egc_schedule_lock_2026-09-22', 'at-floor', 'backlog-empty', 'backlog-null', 'block', 'future', 'legacy-availability', 'legacy-empty-end', 'legacy-no-end', 'legacy-null-end', 'long-31', 'old-availability', 'prior-multi', 'same-day-a', 'same-day-b', 'split', 'undated-availability']);
  assert.ok(!ids.includes('history') && !ids.includes('history-done'));
  assert.equal(rows.find(row => row.id === 'prior-multi').revision, fs.get('jobs/prior-multi').revision);
  assert.equal(fs.scans('jobs').length, 0, 'no complete jobs scan');
  const queries = fs.queries('jobs').map(call => call.body.structuredQuery);
  assert.deepEqual(queries.map(query => JSON.stringify(query.where)), windowQueries(START).map(spec => JSON.stringify(spec.op === 'IS_NULL' ? { unaryFilter: { op: 'IS_NULL', field: { fieldPath: spec.field } } } : { fieldFilter: { field: { fieldPath: spec.field }, op: spec.op, value: spec.op === 'IN' ? { arrayValue: { values: spec.value.map(stringValue => ({ stringValue })) } } : { stringValue: spec.value } } })));
  for (const query of queries) {
    const mask = query.select.fields.map(field => field.fieldPath);
    assert.ok(mask.includes('assignedCrew') && mask.includes('endDate') && mask.includes('assignmentSegments'));
    assert.ok(!mask.includes('payment') && !mask.includes('estimate') && !mask.includes('sealedPayload'));
  }
  assert.equal(fs.get('jobs/prior-multi').payment, undefined);
  await assert.rejects(store.jobsNear(END, START), error => error.code === 'dispatch_range_invalid');
});

test('window queries page with (field, document) cursors through ties and keep one row per job', async () => {
  const seed = {};
  for (let index = 0; index < 1100; index++) seed[`jobs/tie-${String(index).padStart(4, '0')}`] = visit('2026-09-23', '08:00', '2026-09-23', '09:00', [`crew${index % 3 + 1}`]);
  const fs = firestoreRest(seed), rows = await dispatchStorage({ EGC_DISPATCH_WINDOWED_READS: 'true' }, fs.fetcher).jobsNear(START, END);
  assert.equal(rows.length, 1100); assert.equal(new Set(rows.map(row => row.id)).size, 1100);
  const pages = fs.queries('jobs').filter(call => call.body.structuredQuery.where.fieldFilter?.field.fieldPath === 'endDate');
  assert.equal(pages.length, 3);
  assert.deepEqual(pages[1].body.structuredQuery.startAt, { values: [{ stringValue: '2026-09-23' }, { referenceValue: `${ROOT}/jobs/tie-0499` }], before: false });
  assert.deepEqual(pages[1].body.structuredQuery.orderBy.map(item => item.field.fieldPath), ['endDate', '__name__']);
});

test('window pagination fails closed on malformed pages, foreign rows, stalls, storage errors and oversized results', async () => {
  const seed = {};
  for (let index = 0; index < 600; index++) seed[`jobs/job-${String(index).padStart(4, '0')}`] = visit('2026-09-23', '08:00', '2026-09-23', '09:00');
  const expectFailure = async (tamper, code) => {
    const fs = firestoreRest(seed), fetcher = async (env, url, options = {}) => tamper(await fs.fetcher(env, url, options), options) ?? fs.fetcher(env, url, options);
    await assert.rejects(dispatchStorage({ EGC_DISPATCH_WINDOWED_READS: 'true' }, fetcher).jobsNear(START, END), error => error.code === code, code);
  };
  const runQuery = options => String(options.body || '').includes('structuredQuery');
  const body = value => new Response(JSON.stringify(value), { status: 200 });
  await expectFailure((_, options) => runQuery(options) ? body({ documents: [] }) : null, 'dispatch_storage_incomplete');
  // runQuery always answers with at least a readTime: [] or [{}] is never an empty result.
  await expectFailure((_, options) => runQuery(options) ? body([]) : null, 'dispatch_storage_incomplete');
  await expectFailure((_, options) => runQuery(options) ? body([{}]) : null, 'dispatch_storage_incomplete');
  await expectFailure((_, options) => runQuery(options) ? body([{ readTime: '' }]) : null, 'dispatch_storage_incomplete');
  await expectFailure((_, options) => runQuery(options) ? body([null]) : null, 'dispatch_storage_incomplete');
  await expectFailure((_, options) => runQuery(options) ? body([{ document: { name: `${ROOT}/jobs/history`, updateTime: 'r', fields: { endDate: { stringValue: '2020-01-01' }, date: { stringValue: '2020-01-01' }, type: { stringValue: 'availability' }, recordType: { stringValue: 'crew_availability' } } } }]) : null, 'dispatch_storage_incomplete');
  await expectFailure((_, options) => runQuery(options) ? body([{ document: { name: `${ROOT}/jobs/job-0001`, fields: { endDate: { stringValue: '2026-09-23' } } } }]) : null, 'dispatch_storage_incomplete');
  await expectFailure((_, options) => runQuery(options) ? body([{ document: { name: `${ROOT}/customers/job-0001`, updateTime: 'r', fields: {} } }]) : null, 'dispatch_storage_incomplete');
  await expectFailure((_, options) => runQuery(options) ? new Response('{}', { status: 503 }) : null, 'dispatch_storage_unavailable');
  await expectFailure((_, options) => { if (runQuery(options)) throw new Error('network'); return null; }, 'dispatch_storage_unavailable');
  // A server that ignores the cursor repeats the first page: never an endless or duplicate read.
  const fs = firestoreRest(seed), stalled = async (env, url, options = {}) => { if (runQuery(options)) { const request = JSON.parse(options.body); delete request.structuredQuery.startAt; options = { ...options, body: JSON.stringify(request) }; } return fs.fetcher(env, url, options); };
  await assert.rejects(dispatchStorage({ EGC_DISPATCH_WINDOWED_READS: 'true' }, stalled).jobsNear(START, END), error => error.code === 'dispatch_storage_incomplete');
  const documents = ['a', 'b', 'c'].map(id => ({ name: `${ROOT}/jobs/${id}`, updateTime: 'r', fields: { date: { stringValue: '' } } }));
  const decode = document => ({ id: document.name.split('/').pop(), revision: document.updateTime, date: '' });
  await assert.rejects(pagedQuery({ post: async () => documents.map(document => ({ document })), decode, collection: 'jobs', spec: { field: 'date', op: 'EQUAL', value: '' }, fields: ['date'], limit: 2 }), error => error.code === 'dispatch_storage_incomplete');
  assert.equal((await pagedQuery({ post: async () => documents.map(document => ({ document })), decode, collection: 'jobs', spec: { field: 'date', op: 'EQUAL', value: '' }, fields: ['date'], limit: 3 })).length, 3);
});

test('shadow mode equals the complete scan: board, job view, openings and routes are identical in all three modes', async () => {
  const { logs, ...byMode } = stores(), results = {};
  for (const [mode, { store }] of Object.entries(byMode)) {
    results[mode] = {
      board: await dispatchOverview(store, manager, { startDate: START, endDate: END, includeUnscheduled: 'true' }, NOW),
      week: await dispatchOverview(store, manager, { startDate: '2026-09-23', endDate: '2026-09-24' }, NOW),
      job: await dispatchOverview(store, manager, { view: 'job', jobId: 'prior-multi' }, NOW),
      split: await dispatchOverview(store, manager, { view: 'job', jobId: 'split' }, NOW),
      openings: await dispatchOpenings(store, manager, { startDate: START, endDate: END, employeeIds: 'crew1', durationMinutes: '60' }, NOW),
      routes: await dispatchTravelRoutes(store, manager, { date: '2026-09-22' }, NOW),
    };
  }
  assert.deepEqual(results.windowed, results.full);
  assert.deepEqual(results.shadow, results.full);
  const board = results.full.board, codes = new Set(board.warnings.map(warning => warning.code));
  for (const code of ['schedule_overlap', 'travel_buffer_short', 'employee_unavailable']) assert.ok(codes.has(code), code);
  assert.ok(board.warnings.some(warning => warning.code === 'schedule_overlap' && [warning.jobId, warning.otherJobId].includes('prior-multi')), 'the prior-day multi-day job is conflict evidence');
  assert.ok(board.jobs.some(job => job.id === 'legacy-no-end') && board.jobs.some(job => job.id === 'backlog-null') && !board.jobs.some(job => job.id === 'history'));
  assert.ok(board.availability.some(row => row.id === 'legacy-availability'));
  assert.deepEqual(Object.keys(results.windowed.board), Object.keys(board), 'the overview response shape is unchanged');
  assert.equal(byMode.windowed.fs.scans('jobs').length, 0, 'windowed reads never scan the complete jobs collection');
  assert.ok(byMode.full.fs.scans('jobs').length > 0); assert.equal(byMode.full.fs.queries('jobs').length, 0, 'default mode issues no new queries');
  assert.ok(logs.length >= 6 && logs.every(line => line.event === 'dispatch_window_shadow' && line.match === true), JSON.stringify(logs.find(line => !line.match)));
  assert.deepEqual(new Set(logs.map(line => line.label)), new Set(['board', 'job', 'openings', 'routes']));
});

test('saves read windowed conflict evidence that still includes every overlapping prior-day and legacy row', async () => {
  const outcomes = {};
  for (const [mode, { store, fs }] of modes(stores())) {
    const attempt = input => mutateDispatch(store, manager, input, NOW.toISOString()).then(result => settled({ result }), error => ({ error: { code: error.code, status: error.status, details: error.details } }));
    const create = (requestId, changes) => ({ action: 'schedule.create', requestId, customerId: 'c2', kind: 'job', changes: { jobInstructions: 'Synthetic scope', ...changes } });
    outcomes[mode] = {
      multiDay: await attempt(create('00000000-0000-4000-8000-000000000001', { date: '2026-09-22', time: '09:00', endTime: '10:00', assignedCrew: ['crew1'] })),
      legacy: await attempt(create('00000000-0000-4000-8000-000000000002', { date: '2026-09-24', time: '10:00', endTime: '12:00', assignedCrew: ['crew2'] })),
      split: await attempt(create('00000000-0000-4000-8000-000000000003', { date: '2026-09-20', time: '09:00', endTime: '10:00', assignedCrew: ['crew3'] })),
      free: await attempt(create('00000000-0000-4000-8000-000000000004', { date: '2026-10-05', time: '08:00', endTime: '10:00', assignedCrew: ['crew1'], vehicleId: 'truck-1' })),
    };
    // Saves in windowed mode never scan the complete jobs collection (review finding: the
    // pre-validation read used to scan on every save); the default mode issues no queries.
    if (mode === 'windowed') { assert.equal(fs.scans('jobs').length, 0); assert.ok(fs.queries('jobs').length > 0); }
    if (mode === 'full') assert.equal(fs.queries('jobs').length, 0);
  }
  assert.deepEqual(outcomes.windowed, outcomes.full); assert.deepEqual(outcomes.shadow, outcomes.full);
  const { multiDay, legacy, split, free } = outcomes.windowed;
  assert.equal(multiDay.error.code, 'dispatch_conflict'); assert.ok(multiDay.error.details.conflicts.some(conflict => conflict.otherJobId === 'prior-multi'));
  assert.equal(legacy.error.code, 'dispatch_conflict'); assert.ok(legacy.error.details.conflicts.some(conflict => conflict.otherJobId === 'legacy-no-end'));
  assert.equal(split.error.code, 'dispatch_conflict'); assert.ok(split.error.details.conflicts.some(conflict => conflict.otherJobId === 'split' && conflict.otherSegmentId === 's1'));
  assert.equal(free.result.job.status, 'scheduled');
});

test('windowed saves never scan the complete jobs collection and answer every check as the complete scan does', async () => {
  const seed = { ...scheduleSeed(),
    'jobs/c2-history': visit('2024-03-01', '08:00', '2024-03-01', '10:00', ['crew1'], { customerId: 'c2', customer: 'Second Synthetic', status: 'completed' }),
    'jobs/walk-open': visit('2026-09-10', '08:00', '2026-09-10', '09:00', ['crew1'], { type: 'walkthrough', customerId: 'c2', customer: 'Second Synthetic', status: 'completed' }),
    'jobs/walk-done': visit('2025-05-01', '08:00', '2025-05-01', '09:00', ['crew1'], { type: 'walkthrough', status: 'completed' }),
    'jobs/walk-done-job': visit('2025-05-10', '08:00', '2025-05-10', '12:00', ['crew1'], { sourceWalkthroughId: 'walk-done', status: 'completed' }),
    'jobs/future-truck': visit('2027-01-10', '08:00', '2027-01-10', '10:00', ['crew2'], { vehicleId: 'truck-1' }),
    'jobs/backlog-truck': visit('', '', '', '', [], { status: 'unscheduled', vehicleId: 'truck-1' }),
    'jobs/old-truck': visit('2025-01-01', '08:00', '2025-01-01', '10:00', ['crew1'], { vehicleId: 'truck-1' }) };
  const set = stores(seed), outcomes = {};
  for (const [mode, { store, fs }] of modes(set)) {
    const attempt = input => mutateDispatch(store, manager, input, NOW.toISOString()).then(result => settled({ result }), error => ({ error: { code: error.code, status: error.status, details: error.details } }));
    const revision = path => fs.get(path).revision;
    const id = n => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
    const create = (n, customerId, changes, extra = {}) => attempt({ action: 'schedule.create', requestId: id(n), customerId, kind: 'job', changes: { jobInstructions: 'Synthetic scope', ...changes }, ...extra });
    const results = {};
    results.datedUpdate = await attempt({ action: 'schedule.update', requestId: id(1), jobId: 'same-day-a', expectedRevision: revision('jobs/same-day-a'), changes: { time: '15:00', endTime: '16:00' } });
    results.undatedUpdate = await attempt({ action: 'schedule.update', requestId: id(2), jobId: 'backlog-empty', expectedRevision: revision('jobs/backlog-empty'), changes: { opsNotes: 'Synthetic note' } });
    results.cancel = await attempt({ action: 'schedule.cancel', requestId: id(3), jobId: 'future', expectedRevision: revision('jobs/future'), changes: {}, cancellationReason: 'Synthetic reason' });
    results.restore = await attempt({ action: 'schedule.restore', requestId: id(4), jobId: 'future', expectedRevision: revision('jobs/future'), changes: {} });
    results.duplicate = await create(5, 'c1', { date: '2026-08-10', time: '08:00', endTime: '09:00', assignedCrew: ['crew1'] });
    results.handoffExists = await create(6, 'c1', { date: '2026-10-06', time: '08:00', endTime: '09:00', assignedCrew: ['crew1'] }, { sourceWalkthroughId: 'walk-done' });
    results.handoff = await create(7, 'c2', { date: '2026-10-06', time: '08:00', endTime: '09:00', assignedCrew: ['crew1'] }, { sourceWalkthroughId: 'walk-open' });
    results.lineage = await create(8, 'c2', { date: '2026-10-07', time: '08:00', endTime: '10:00', assignedCrew: ['crew2'] });
    results.timeOff = await attempt({ action: 'availability.save', requestId: id(9), changes: { employeeId: 'crew1', date: '2026-09-23', endDate: '2026-09-23', allDay: true, reason: '' } });
    results.vehicle = await attempt({ action: 'vehicle.save', requestId: id(10), id: 'truck-1', expectedRevision: revision('dispatchResources/truck-1'), changes: { status: 'out_of_service' } });
    results.crew = await attempt({ action: 'crew.save', requestId: id(11), changes: { name: 'Synthetic Crew', memberIds: ['crew1'] } });
    outcomes[mode] = results;
    if (mode === 'windowed') {
      assert.equal(fs.scans('jobs').length, 0, 'no save scans every job');
      const where = fs.queries('jobs').map(call => call.body.structuredQuery.where.fieldFilter).filter(filter => filter?.op === 'EQUAL' && filter.field.fieldPath !== 'date' && filter.field.fieldPath !== 'type');
      // Each save reads a customer's jobs once (duplicates and lineage share it); no query has a date bound.
      assert.deepEqual(where.map(filter => [filter.field.fieldPath, filter.value.stringValue]), [['customerId', 'c1'], ['customerId', 'c1'], ['sourceWalkthroughId', 'walk-done'], ['customerId', 'c2'], ['sourceWalkthroughId', 'walk-open'], ['customerId', 'c2']]);
    } else assert.equal(fs.scans('jobs').length, 16, 'outside windowed mode: one scan before validating every save and one after the day locks of each dated save, as before');
    if (mode === 'full') assert.equal(fs.queries('jobs').length, 0, 'the default mode issues no queries');
  }
  assert.deepEqual(outcomes.windowed, outcomes.full); assert.deepEqual(outcomes.shadow, outcomes.full);
  const { datedUpdate, undatedUpdate, cancel, restore, duplicate, handoffExists, handoff, lineage, timeOff, vehicle, crew } = outcomes.windowed;
  assert.equal(datedUpdate.result.job.time, '15:00'); assert.ok(undatedUpdate.result.ok && cancel.result.job.status === 'cancelled' && restore.result.job.status === 'scheduled' && crew.result.ok);
  assert.equal(duplicate.error.code, 'dispatch_job_already_exists', 'a same-time visit weeks before the window is still found');
  assert.equal(handoffExists.error.code, 'dispatch_handoff_exists', 'a handoff saved long ago is still found');
  assert.equal(handoff.result.job.sourceWalkthroughId, 'walk-open');
  const saved = set.windowed.fs.get(`jobs/${lineage.result.job.id}`);
  assert.equal(saved.customerAccountOwnerJobId, 'c2-history', 'lineage finds the customer history outside the window');
  assert.deepEqual(timeOff.result.warnings.find(warning => warning.code === 'availability_conflicts').conflicts.map(row => row.jobId).sort(), ['prior-multi', 'split']);
  assert.deepEqual(vehicle.result.warnings.find(warning => warning.code === 'vehicle_assignments_need_review').jobIds.sort(), ['backlog-truck', 'future-truck', 'prior-multi']);
  const shadow = set.logs.filter(line => ['dispatch_save_query_shadow', 'dispatch_window_shadow'].includes(line.event));
  assert.ok(shadow.length && shadow.every(line => line.match === true), JSON.stringify(shadow.find(line => !line.match)));
  assert.deepEqual([...new Set(shadow.map(line => line.field || line.label))].sort(), ['availability', 'customerId', 'save', 'sourceWalkthroughId', 'vehicle']);
});

test('the walkthrough handoff lookup finds a handoff saved long ago without scanning every job', async () => {
  const set = stores({ ...scheduleSeed(), 'jobs/walk-done': visit('2025-05-01', '08:00', '2025-05-01', '09:00', ['crew1'], { type: 'walkthrough', status: 'completed' }),
    'jobs/walk-done-job': visit('2025-05-10', '08:00', '2025-05-10', '12:00', ['crew1'], { sourceWalkthroughId: 'walk-done', status: 'completed' }) }), results = {};
  for (const [mode, { store, fs }] of modes(set)) {
    results[mode] = await prepareHandoff(store, manager, { sourceWalkthroughId: 'walk-done' });
    assert.equal(fs.scans('jobs').length === 0, mode === 'windowed', mode);
  }
  assert.deepEqual(results.windowed, results.full); assert.deepEqual(results.shadow, results.full);
  assert.equal(results.full.jobId, 'walk-done-job');
  assert.deepEqual(set.logs.map(line => [line.event, line.field, line.match]), [['dispatch_save_query_shadow', 'sourceWalkthroughId', true]]);
});

test('open-shift claims and releases read windowed evidence, never the complete jobs scan', async () => {
  const shift = (date, time, endTime) => visit(date, time, date, endTime, ['crew1'], { crewNeeded: 2, shiftPickupEnabled: true, openShift: true });
  const set = stores({ ...scheduleSeed(), 'jobs/open-shift': shift('2026-09-30', '09:00', '11:00'), 'jobs/busy-shift': shift('2026-09-24', '10:00', '12:00') }), outcomes = {};
  const crew2 = { user: 'crew2', displayName: 'Crew Two', role: 'crew' };
  for (const [mode, { store, fs }] of modes(set)) {
    const attempt = (n, action, jobId) => mutateDispatchSelfAssignment(store, crew2, { action, jobId, requestId: `00000000-0000-4000-8000-0000000002${n}`, expectedRevision: fs.get(`jobs/${jobId}`).revision }, NOW.toISOString()).then(result => ({ result }), error => ({ error: { code: error.code, status: error.status } }));
    outcomes[mode] = { claim: await attempt('01', 'claim', 'open-shift'), busy: await attempt('02', 'claim', 'busy-shift'), release: await attempt('03', 'release', 'open-shift') };
    if (mode === 'windowed') assert.equal(fs.scans('jobs').length, 0);
  }
  assert.deepEqual(outcomes.windowed, outcomes.full); assert.deepEqual(outcomes.shadow, outcomes.full);
  assert.deepEqual(outcomes.full.claim.result.job.assignedCrew, ['crew1', 'crew2']);
  assert.equal(outcomes.full.busy.error.code, 'dispatch_conflict', 'the legacy job without an endDate and the time off are still evidence');
  assert.deepEqual(outcomes.full.release.result.job.assignedCrew, ['crew1']);
});

test('shadow mode answers from the complete scan and reports rows the window cannot find', async () => {
  const seed = { ...scheduleSeed(), 'jobs/malformed': visit('09/21/2026', '08:00', '', '10:00', ['crew1']), 'jobs/no-date-field': (({ date, ...row }) => row)(visit('', '', '', '', [], { status: 'unscheduled' })) };
  const { logs, full, shadow, windowed } = stores(seed);
  const query = { startDate: START, endDate: END, includeUnscheduled: 'true' };
  const expected = await dispatchOverview(full.store, manager, query, NOW);
  assert.deepEqual(await dispatchOverview(shadow.store, manager, query, NOW), expected);
  assert.ok(expected.jobs.some(job => job.id === 'malformed' && job.timeNeedsReview), 'the complete scan shows a malformed date on every board');
  const [line] = logs;
  assert.equal(line.event, 'dispatch_window_shadow'); assert.equal(line.match, false); assert.equal(line.missing, 2);
  assert.deepEqual(line.missingByReason, { unverifiable_date: 1, undated: 1 }); assert.deepEqual(line.sample.sort(), ['malformed', 'no-date-field']);
  const direct = await dispatchOverview(windowed.store, manager, query, NOW);
  assert.ok(!direct.jobs.some(job => job.id === 'malformed'), 'windowed mode cannot find it, which is why shadow runs first');
  // A failing window read is reported and never changes the answer.
  logs.length = 0;
  const broken = { ...shadow.store, jobsNear: async () => { throw Object.assign(new Error('x'), { code: 'dispatch_storage_incomplete' }); } };
  assert.deepEqual(await dispatchOverview(broken, manager, query, NOW), expected);
  assert.deepEqual([logs[0].match, logs[0].error], [false, 'dispatch_storage_incomplete']);
});

test('relevance and windows are segment-aware and conservative about malformed dates', () => {
  assert.equal(windowRelevant({ id: 'x', type: 'job', date: '2026-08-17', endDate: '2026-08-17' }, START), false);
  assert.equal(windowRelevant({ id: 'x', type: 'job', date: '2026-08-17', endDate: '2026-08-18' }, START), true);
  for (const row of [{ id: 'x', type: 'job', date: '' }, { id: 'x', type: 'job', date: '2026-13-01' }, { id: 'x', type: 'job', date: '2026-09-02', endDate: '2026-09-01' }, { id: 'x', type: 'availability', date: '2020-01-01' }, { id: 'x', recordType: 'crew_availability' }]) assert.equal(windowRelevant(row, START), true, JSON.stringify(row));
  for (const row of [{ id: '_egc_schedule_lock_2026-09-22', recordType: 'schedule_lock', date: '2026-09-22' }, { id: 'secure_x', type: 'job', date: '' }, { id: 'x', type: 'lead', date: '' }]) assert.equal(windowRelevant(row, START), false, row.id);
  assert.deepEqual(windowDiff([{ id: 'a', type: 'job', date: '', revision: '1' }, { id: 'b', type: 'job', date: '', revision: '1' }], [{ id: 'a', revision: '2' }, { id: 'c', revision: '1' }], START), { missing: [{ id: 'b', reason: 'undated' }], changed: ['a'], extra: ['c'] });
  const split = { id: 'j', date: '2026-09-25', endDate: '2026-09-26', assignmentSegments: [{ id: 's1', date: '2026-09-21', time: '08:00', endDate: '2026-09-21', endTime: '09:00', assignedCrew: [] }] };
  assert.deepEqual(rowsWindow([split], NOW), { startDate: '2026-09-21', endDate: '2026-09-27' });
  assert.deepEqual(rowsWindow([{ id: 'u', date: '' }, null], NOW), { startDate: '2026-09-22', endDate: '2026-09-23' });
});

test('openings treat an old lock entry for a job moved far away exactly as the complete scan does', async () => {
  const seed = { ...scheduleSeed(), 'jobs/moved-away': visit('2026-05-01', '09:00', '2026-05-01', '11:00', ['crew2']),
    'jobs/_egc_schedule_lock_2026-09-25': { recordType: 'schedule_lock', date: '2026-09-25', entries: [
      { id: 'moved-away', type: 'job', start: '09:00', end: '11:00', label: 'Moved', status: 'scheduled', assignedCrew: ['crew2'], assignmentKnown: true, vehicleId: null },
      { id: 'deleted-job', type: 'job', start: '13:00', end: '15:00', label: 'Gone', status: 'scheduled', assignedCrew: ['crew2'], assignmentKnown: true, vehicleId: null }] } };
  const results = {}, set = stores(seed), query = { startDate: '2026-09-25', endDate: '2026-09-26', employeeIds: 'crew2', durationMinutes: '60', travelBufferMinutes: '0' };
  for (const [mode, { store }] of modes(set)) results[mode] = await dispatchOpenings(store, manager, query, NOW);
  assert.deepEqual(results.windowed, results.full); assert.deepEqual(results.shadow, results.full);
  // One candidate per gap: 08:00-13:00 is unbroken because the saved job is
  // authoritative over its old 09:00 entry; the orphan 13:00-15:00 still reserves.
  assert.deepEqual(results.full.candidates.map(row => [row.time, row.gapMinutes]), [['08:00', 300], ['15:00', 120]]);
  const confirm = set.windowed.fs.calls.find(call => call.path === ':batchGet' && call.body.documents.includes(`${ROOT}/jobs/moved-away`));
  assert.deepEqual(confirm.body.mask, { fieldPaths: ['type'] }, 'confirming lock owners never reads job bodies');
  // Without confirming lock owners outside the window, the old entry would wrongly reserve 09:00-11:00.
  const unconfirmed = await dispatchOpenings({ ...set.windowed.store, readMany: undefined }, manager, query, NOW);
  assert.deepEqual(unconfirmed.candidates.map(row => [row.time, row.gapMinutes]), [['08:00', 60], ['11:00', 120], ['15:00', 120]]);
});

test('indexed customer search queries searchKeys, re-derives keys and keeps the response shape', async () => {
  const keyed = row => ({ ...row, ...customerSearchFields(row) });
  const seed = {
    'customers/c-john': keyed({ name: 'Synthetic John Smith', phone: '(970) 555-0100', email: 'john@example.invalid', address: '1 Synthetic Way' }),
    'customers/c-jose': keyed({ name: 'José Álvarez', phone: '970-555-0142', email: '', address: '2 Synthetic Way' }),
    'customers/c-stale': { name: 'Renamed Customer', phone: '', address: '3 Synthetic Way', searchKeys: customerSearchKeys({ name: 'Old John Name' }), searchKeysVersion: SEARCH_KEYS_VERSION },
  };
  const { logs, full, windowed, shadow } = stores(seed);
  const search = (store, q) => dispatchOverview(store, manager, { view: 'customers', q }, NOW);
  for (const [q, ids] of [['john', ['c-john']], ['JOHN smi', ['c-john']], ['jose alv', ['c-jose']], ['555-0142', ['c-jose']], ['0100', ['c-john']], ['john@example.invalid', ['c-john']], ['smith jose', []]]) {
    const result = await search(windowed.store, q);
    assert.deepEqual(result.customers.map(row => row.id), ids, q);
    assert.deepEqual(Object.keys(result), ['ok', 'customers', 'total']); assert.equal(result.total, ids.length);
  }
  assert.equal(windowed.fs.scans('customers').length, 0, 'indexed search never scans every customer');
  const query = windowed.fs.queries('customers')[0].body.structuredQuery;
  assert.deepEqual(query.where, { fieldFilter: { field: { fieldPath: 'searchKeys' }, op: 'ARRAY_CONTAINS', value: { stringValue: 'john' } } });
  // FUN-02 added crmLinked to the customer search rows; the indexed path keeps the same shape as the scan.
  assert.deepEqual(Object.keys((await search(windowed.store, 'john')).customers[0]), ['id', 'name', 'phone', 'email', 'address', 'crmLinked']);
  assert.deepEqual(Object.keys((await search(windowed.store, 'john')).customers[0]), Object.keys((await search(full.store, 'john')).customers[0]));
  // Word-prefix matching is the documented difference from the substring scan.
  assert.deepEqual((await search(full.store, 'mith')).customers.map(row => row.id), ['c-john']);
  assert.deepEqual((await search(windowed.store, 'mith')).customers.map(row => row.id), []);
  // Text the index cannot use still scans (one-letter words), with the old matching.
  assert.deepEqual((await search(windowed.store, 'j')).customers.map(row => row.id), (await search(full.store, 'j')).customers.map(row => row.id));
  // Shadow answers like the complete scan and compares the index with it.
  assert.deepEqual(await search(shadow.store, 'mith'), await search(full.store, 'mith'));
  const shadowLines = logs.filter(line => line.event === 'dispatch_customer_search_shadow');
  assert.equal(shadowLines.length, 1); assert.equal(shadowLines[0].match, true);
});

function searchSeed() {
  const keyed = row => ({ ...row, ...customerSearchFields(row) });
  return {
    'customers/c1': keyed({ name: 'Synthetic John Smith', phone: '+19705550100', email: 'john@example.invalid', address: '1 Synthetic Way' }),
    'customers/c2': keyed({ name: 'Ann Lee', phone: '+1 970-555-0111', email: 'ann.lee@example.invalid', address: '2 Synthetic Way' }),
    'customers/c3': keyed({ name: 'Synthetic Extension', phone: '(720) 555-1234 x12', email: '', address: '3 Synthetic Way' }),
    'customers/c4': keyed({ name: 'Mary Major', phone: '(303) 555-0199', email: 'mary@example.invalid', address: '4 Johnston Road' }),
  };
}

test('indexed search keeps what the scan found for a last initial, a typed leading 1, an extension and a partial email', async () => {
  const { full, windowed } = stores(searchSeed());
  const search = async (store, q) => (await dispatchOverview(store, manager, { view: 'customers', q }, NOW)).customers.map(row => row.id);
  for (const [q, ids] of [['john s', ['c1']], ['JOHN S', ['c1']], ['ann l', ['c2']], ['synthetic j', ['c1']], ['+1 970 555', ['c1', 'c2']], ['1970555', ['c1', 'c2']], ['1 (970) 555-0100', ['c1']], ['1234', ['c3']], ['555-1234', ['c3']], ['(720) 555', ['c3']], ['720-555-1234 x12', ['c3']], ['john@example', ['c1']], ['john@example.invalid', ['c1']], ['ann.lee@', ['c2']]]) {
    assert.deepEqual(await search(full.store, q), ids, `scan: ${q}`);
    assert.deepEqual(await search(windowed.store, q), ids, `index: ${q}`);
  }
  assert.equal(windowed.fs.scans('customers').length, 0);
  // A leading 1 is also tried without it, as one query per alternative.
  const alternatives = windowed.fs.queries('customers').filter(call => ['1970555', '970555'].includes(call.body.structuredQuery.where.fieldFilter.value.stringValue));
  assert.equal(alternatives.length, 4);
  // An email's local part picks the query key, not its shared domain.
  assert.ok(windowed.fs.queries('customers').some(call => call.body.structuredQuery.where.fieldFilter.value.stringValue === 'john'));
  assert.ok(!windowed.fs.queries('customers').some(call => call.body.structuredQuery.where.fieldFilter.value.stringValue === 'example'));
});

test('shadow compares the index with the scan the dispatcher gets and flags only undocumented differences', async () => {
  const { logs, full, shadow } = stores(searchSeed());
  const search = (store, q) => dispatchOverview(store, manager, { view: 'customers', q }, NOW);
  const line = async q => { assert.deepEqual(await search(shadow.store, q), await search(full.store, q), q); return logs.filter(entry => entry.event === 'dispatch_customer_search_shadow').at(-1); };
  let entry = await line('john s');
  assert.deepEqual([entry.match, entry.scanOnly, entry.unexpected], [true, 0, 0]);
  entry = await line('johnston road');
  assert.deepEqual([entry.match, entry.scanOnly, entry.scanOnlyByReason, entry.unexpected], [true, 1, { address: 1 }, 0], 'an address-only match is documented');
  entry = await line('mith');
  assert.deepEqual([entry.match, entry.scanOnlyByReason], [true, { partial: 1 }], 'the middle of a word is documented');
  entry = await line('555-01');
  assert.deepEqual([entry.match, entry.scanOnlyByReason], [true, { partial: 3 }], 'the middle of a phone number is documented');
  entry = await line('x12');
  assert.deepEqual([entry.match, entry.scanned, entry.indexed, entry.scanOnly, entry.scanOnlyByReason, entry.unexpected, entry.sample], [false, 1, 0, 1, { other: 1 }, 1, ['c3']], 'a scan match at a word start the index misses is a behaviour change');
  entry = await line('smith synthetic');
  assert.deepEqual([entry.match, entry.scanned, entry.indexOnly], [true, 0, 1], 'word order is free in the index');
  assert.ok(!JSON.stringify(logs).includes('555') && !JSON.stringify(logs).includes('example.invalid'), 'shadow lines hold counts and ids, never contact details');
  // The classifier works from the saved fields and the typed text alone.
  assert.equal(scanOnlyReason({ name: 'Synthetic John Smith' }, 'John S'), 'other');
  assert.equal(scanOnlyReason({ phone: '+19705550100' }, '+1 970 555'), 'other');
  assert.equal(scanOnlyReason({ phone: '(720) 555-1234 x12' }, '1234'), 'other');
  assert.equal(scanOnlyReason({ phone: '(970) 555-0100' }, '555'), 'partial');
  assert.equal(scanOnlyReason({ name: 'Mary', phone: '(970) 555-0100' }, 'john 970'), 'partial');
  assert.equal(scanOnlyReason({ name: 'Mary', address: '4 Johnston Road' }, 'johnston'), 'address');
});

test('customer search scans as before while any customer lacks current keys, and shadow reports it', async () => {
  const seed = { 'customers/c-john': { name: 'Synthetic John Smith', phone: '(970) 555-0100', ...customerSearchFields({ name: 'Synthetic John Smith', phone: '(970) 555-0100' }) }, 'customers/c-new': { name: 'Johnny Unkeyed', phone: '9705550177' } };
  const { logs, windowed, shadow } = stores(seed);
  const result = await dispatchOverview(windowed.store, manager, { view: 'customers', q: 'john' }, NOW);
  assert.deepEqual(result.customers.map(row => row.id), ['c-john', 'c-new']);
  assert.equal(windowed.fs.scans('customers').length, 1); assert.equal(windowed.fs.queries('customers').length, 0);
  assert.deepEqual(logs.at(-1), { event: 'dispatch_customer_index_unavailable', match: false, total: 2, keyed: 1 });
  await dispatchOverview(shadow.store, manager, { view: 'customers', q: 'john' }, NOW);
  assert.deepEqual([logs.at(-1).event, logs.at(-1).indexComplete], ['dispatch_customer_search_shadow', false]);
  const counted = count => [{ result: { aggregateFields: { count: { integerValue: String(count) } } }, readTime: '2026-09-22T10:00:00.123456789Z' }];
  assert.deepEqual(aggregateCount(counted(3)), { count: 3, readTime: '2026-09-22T10:00:00.123456Z' }, 'a readTime request accepts microseconds');
  for (const bad of [null, [], [{ readTime: 'r' }], [{ result: { aggregateFields: {} } }], [{ result: { aggregateFields: { count: { integerValue: '-1' } } } }], [{ result: { aggregateFields: { count: { doubleValue: 2 } } } }], [{ result: { aggregateFields: { count: { integerValue: '3' } } } }], [{ result: { aggregateFields: { count: { integerValue: '3' } } }, readTime: 'r' }]]) assert.throws(() => aggregateCount(bad), error => error.code === 'dispatch_storage_incomplete');
  // Keyed customers are counted first, each with its own plain count, and the
  // total is read at the keyed count's snapshot: a delete between the requests
  // cannot make coverage look complete.
  const bodies = [];
  assert.deepEqual(await customerCoverage(async body => { bodies.push(body); return aggregateCount(counted(bodies.length === 1 ? 4 : 5)); }), { total: 5, keyed: 4, complete: false });
  assert.deepEqual(bodies.map(body => [body.structuredAggregationQuery.aggregations, body.structuredAggregationQuery.structuredQuery.where?.fieldFilter.value, body.readTime]), [[[{ alias: 'count', count: {} }], { integerValue: String(SEARCH_KEYS_VERSION) }, undefined], [[{ alias: 'count', count: {} }], undefined, '2026-09-22T10:00:00.123456Z']]);
  const aggregations = windowed.fs.calls.filter(call => call.path === ':runAggregationQuery');
  assert.equal(aggregations.length, 2); assert.equal(aggregations[1].body.readTime, '2026-09-22T10:00:00Z');
  // An unreadable coverage count falls back to the complete scan instead of failing or guessing.
  const broken = { ...windowed.store, customerKeyCoverage: async () => { throw Object.assign(new Error('x'), { code: 'dispatch_storage_unavailable' }); } };
  assert.deepEqual((await dispatchOverview(broken, manager, { view: 'customers', q: 'john' }, NOW)).customers.map(row => row.id), ['c-john', 'c-new']);
});

test('the dispatch APIs take the mode from the Pages environment and answer identically', async () => {
  const bodies = {};
  for (const flag of [undefined, 'shadow', 'true']) {
    const fs = firestoreRest(scheduleSeed()), logs = [];
    const storage = env => ({ ...dispatchStorage(env, fs.fetcher), roster: async () => structuredClone(ROSTER), log: { info: line => logs.push(line), warn: line => logs.push(line) } });
    const deps = { session: async () => manager, storage, now: () => NOW };
    const env = flag === undefined ? {} : { EGC_DISPATCH_WINDOWED_READS: flag }, url = 'https://easygaragecleaning.com/api/';
    const board = await dispatchHandlers(deps).get({ request: new Request(url + 'dispatch?startDate=2026-09-22&endDate=2026-09-29&includeUnscheduled=true'), env });
    const openings = await dispatchOpeningsHandlers(deps).get({ request: new Request(url + 'dispatch-openings?startDate=2026-09-22&endDate=2026-09-29&employeeIds=crew1'), env });
    assert.equal(board.status, 200); assert.equal(openings.status, 200); assert.equal(board.headers.get('Cache-Control'), 'no-store');
    bodies[String(flag)] = { board: await board.json(), openings: await openings.json() };
    assert.equal(fs.scans('jobs').length === 0, flag === 'true', String(flag));
    assert.equal(logs.length, flag === 'shadow' ? 2 : 0);
  }
  assert.deepEqual(bodies.true, bodies.undefined); assert.deepEqual(bodies.shadow, bodies.undefined);
  assert.equal(bodies.true.board.viewer.id, 'zacb'); assert.equal(bodies.true.board.coverage.complete, true);
});
