import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dispatchOverview, mutateDispatch, mutateDispatchSelfAssignment } from '../functions/_lib/dispatch-service.js';
import { dispatchOpenings } from '../functions/_lib/dispatch-openings.js';
import { capacityIndex, crewSizeShort, dayPieces, employeeDailyCapacity, minutesByDay, missingSkills, offeredForPickup, outsideWorkingHours, requiredSkillsOf, ruleWarnings, skillMissing, validateRequiredSkills, workingWindows } from '../functions/_lib/dispatch-rules.js';
import { DISPATCH_SETTINGS_DEFAULTS } from '../functions/_lib/dispatch-settings.js';
import { dispatchTravelRoutes, travelEstimator } from '../functions/_lib/dispatch-travel.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { scheduleInterval } from '../functions/_lib/dispatch-time.js';
import { legacyDispatchScenario } from './helpers/dispatch-legacy-scenario.mjs';
import { definitionsHash, funnelDefinitions } from '../functions/_lib/funnel-definitions.js';

const owner = { user: 'zacb', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
const NOW = '2026-09-22T12:00:00.000Z', now = new Date(NOW);
const FC = '100 Synthetic Oak Street, Fort Collins, CO 80525', LOVELAND = '200 Synthetic Elm Avenue, Loveland, CO 80537';
const WEEKDAY = { mon: [{ start: '08:00', end: '12:00' }, { start: '12:00', end: '17:00' }], tue: [{ start: '08:00', end: '17:00' }], wed: [{ start: '08:00', end: '17:00' }], thu: [{ start: '08:00', end: '17:00' }], fri: [{ start: '08:00', end: '17:00' }], sat: [], sun: [] };
const settings = changes => ({ ...DISPATCH_SETTINGS_DEFAULTS, ...changes });
const noNetwork = () => { throw new Error('Synthetic rules tests never call a provider.'); };

function fixture({ rules = null, roster } = {}) {
  const rows = new Map([
    ['customers/c1', { id: 'c1', name: 'Synthetic Customer One', phone: '970-555-0101', address: FC, revision: 'c1r' }],
    ['customers/c2', { id: 'c2', name: 'Synthetic Customer Two', phone: '970-555-0102', address: LOVELAND, revision: 'c2r' }],
  ]);
  if (rules) rows.set('dispatchSettings/current', { id: 'current', revision: 'settings-r1', ...rules });
  let revision = 0;
  const clone = value => structuredClone(value), all = collection => [...rows.entries()].filter(([key]) => key.startsWith(collection + '/')).map(([, value]) => clone(value));
  const people = roster || [
    { id: 'zacb', name: 'Synthetic Owner', role: 'owner' },
    { id: 'crew1', name: 'Synthetic Crew One', role: 'crew', skills: [{ id: 'truck_driving', level: 'proficient' }, { id: 'shelving', level: 'trainee' }], weeklyAvailability: WEEKDAY },
    { id: 'crew2', name: 'Synthetic Crew Two', role: 'crew', skills: [{ id: 'shelving', level: 'lead' }], weeklyAvailability: WEEKDAY },
    { id: 'crew3', name: 'Synthetic Crew Three', role: 'crew' },
  ];
  const store = {
    jobs: async () => all('jobs'), resources: async () => all('dispatchResources'), customers: async () => all('customers'), roster: async () => clone(people),
    read: async (collection, id) => clone(rows.get(`${collection}/${id}`) || null),
    readMany: async (collection, ids) => ids.map(id => rows.get(`${collection}/${id}`)).filter(Boolean).map(clone),
    commit: async writes => {
      const seen = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = rows.get(key);
        assert.ok(!seen.has(key), 'No duplicate writes per document'); seen.add(key);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...clone(write.patch), id: write.id, revision: `r${++revision}` });
    },
  };
  const job = (id, changes = {}) => { const row = { id, type: 'job', customerId: 'c1', customer: 'Synthetic Customer One', address: FC, jobInstructions: 'Synthetic scope', status: 'scheduled', date: '2026-09-23', time: '09:00', endDate: '2026-09-23', endTime: '11:00', assignedCrew: ['crew1'], crewLead: null, travelBufferMinutes: 0, revision: 'rev-' + id, ...changes }; rows.set('jobs/' + id, row); return row; };
  // An undefined change is left out of the request (the server default applies).
  const create = (changes = {}, extra = {}) => ({ action: 'schedule.create', requestId: randomUUID(), customerId: 'c2', kind: 'job', changes: Object.fromEntries(Object.entries({ date: '2026-09-23', time: '13:00', endTime: '15:00', assignedCrew: ['crew1'], jobInstructions: 'Synthetic scope', travelBufferMinutes: 0, ...changes }).filter(([, value]) => value !== undefined)), ...extra });
  const edit = (saved, changes) => ({ action: 'schedule.update', requestId: randomUUID(), jobId: saved.id, expectedRevision: saved.revision, changes });
  const mutate = (input, options = {}) => mutateDispatch(store, owner, input, NOW, options);
  const setRules = changes => rows.set('dispatchSettings/current', { ...(rows.get('dispatchSettings/current') || { id: 'current', revision: 'settings-r1' }), ...changes, revision: `settings-r${++revision}` });
  return { rows, store, people, job, create, edit, mutate, setRules };
}
const codes = warnings => warnings.map(warning => warning.code);
// The body employee-dispatch.js submits when a job editor is saved: every field, from the dispatch DTO.
const formSave = (dto, changes = {}) => ({ action: 'schedule.update', requestId: randomUUID(), jobId: dto.id, expectedRevision: dto.revision, changes: {
  date: dto.date, time: dto.time, endDate: dto.endDate || dto.date, endTime: dto.endTime, serviceType: dto.serviceType || '', address: dto.address || '',
  assignedCrew: dto.assignedCrew, crewId: dto.crewId || null, crewLead: dto.crewLead || null, vehicleId: dto.vehicleId || null, crewNeeded: dto.crewNeeded || 1,
  travelBufferMinutes: dto.travelBufferMinutes ?? 20, jobInstructions: dto.jobInstructions || '', accessInstructions: dto.accessInstructions || '', customerInstructions: dto.customerInstructions || '',
  opsNotes: dto.opsNotes || '', requiredEquipment: dto.requiredEquipment || [], materials: dto.materials || [], arrivalWindowStart: dto.arrivalWindowStart || null, arrivalWindowEnd: dto.arrivalWindowEnd || null,
  ...(dto.requiredSkills?.length ? { requiredSkills: dto.requiredSkills } : {}), ...changes } });
// A row saved before dispatch kept endDate, assignedCrew or crewNeeded: one assignedTo display name.
const legacyRow = (f, id, changes = {}) => { const row = f.job(id, { serviceType: 'Synthetic garage cleanout', assignedTo: 'Synthetic Crew One', ...changes }); delete row.endDate; delete row.assignedCrew; delete row.crewLead; return row; };
const editorDto = async (f, id) => (await dispatchOverview(f.store, owner, { view: 'job', jobId: id }, now)).job;
const rejectsConflict = (promise, code) => assert.rejects(promise, error => error.code === 'dispatch_conflict' && error.status === 409 && error.details.conflicts.some(row => row.code === code && row.blocking === true));

test('pure rule helpers: required skills, qualified levels, working windows and Denver day pieces', () => {
  assert.deepEqual(requiredSkillsOf({ requiredSkills: ['shelving', 'shelving', 7, 'Bad Id', 'truck_driving'] }), ['shelving', 'truck_driving']);
  assert.deepEqual(requiredSkillsOf({}), []);
  assert.deepEqual(validateRequiredSkills(['truck_driving', 'shelving']), ['shelving', 'truck_driving']);
  assert.equal(validateRequiredSkills(['forklift']), null, 'only catalog skills can be added');
  assert.deepEqual(validateRequiredSkills(['forklift', 'shelving'], ['forklift']), ['forklift', 'shelving'], 'a retired skill already on the job may be kept');
  assert.equal(validateRequiredSkills('shelving'), null);
  const roster = fixture().people;
  assert.deepEqual(missingSkills(['crew1'], roster, ['truck_driving', 'shelving']), ['shelving'], 'a trainee is not qualified');
  assert.deepEqual(missingSkills(['crew1', 'crew2'], roster, ['truck_driving', 'shelving']), []);
  assert.deepEqual(missingSkills(['crew3'], roster, ['shelving']), ['shelving']);
  assert.deepEqual(workingWindows(roster[1], '2026-09-28'), [{ start: 480, end: 1020 }], 'adjacent windows merge (Monday)');
  assert.deepEqual(workingWindows(roster[1], '2026-09-27'), [], 'no windows on Sunday');
  assert.equal(workingWindows(roster[3], '2026-09-28'), null, 'no recorded hours is unknown, not unavailable');
  assert.deepEqual(dayPieces({ date: '2026-09-23', time: '16:00', endDate: '2026-09-24', endTime: '09:00' }), [{ date: '2026-09-23', start: 960, end: 1440 }, { date: '2026-09-24', start: 0, end: 540 }]);
  assert.deepEqual(dayPieces({ date: '2026-09-23', time: '16:00', endDate: '2026-09-24', endTime: '00:00' }), [{ date: '2026-09-23', start: 960, end: 1440 }], 'midnight releases the next day');
  // Elapsed hours, not wall-clock hours, on DST days.
  assert.deepEqual([...minutesByDay({ date: '2026-11-01', time: '00:00', endDate: '2026-11-02', endTime: '00:00' })], [['2026-11-01', 1500]]);
  assert.deepEqual([...minutesByDay({ date: '2026-03-08', time: '00:00', endDate: '2026-03-09', endTime: '00:00' })], [['2026-03-08', 1380]]);
  assert.deepEqual([...minutesByDay({ date: 'bad' })], []);
});

// A job-level shift that crew can really pick up, and look-alikes that carry the pickup flag but are never offered.
const OPEN = { id: 'j1', type: 'job', status: 'scheduled', date: '2026-09-23', time: '09:00', endDate: '2026-09-23', endTime: '11:00', crewNeeded: 3, shiftPickupEnabled: true };
const NOT_OFFERED = [
  ['a walkthrough', { ...OPEN, type: 'walkthrough' }],
  ['a segmented job', { ...OPEN, assignmentSegments: [{ id: 'a', date: '2026-09-23', time: '09:00', endTime: '11:00', assignedCrew: ['crew1'] }] }],
  ['a job without valid times', { ...OPEN, date: '', time: '', endDate: '', endTime: '', status: 'unscheduled' }],
  ['a job already under way', { ...OPEN, status: 'in_progress' }],
];

test('crew_size_short keeps its legacy shape by default, blocks only when set, and never blocks a job offered for pickup', () => {
  const job = { ...OPEN, shiftPickupEnabled: false }, block = settings({ blockCrewShort: true });
  assert.deepEqual(crewSizeShort(job, 1), { code: 'crew_size_short', jobId: 'j1', message: 'Requires 3 crew members; 1 assigned.' });
  assert.equal(crewSizeShort(job, 3), null);
  assert.equal(crewSizeShort(job, 1, block).blocking, true);
  assert.equal(offeredForPickup(OPEN, 1), true);
  assert.equal(crewSizeShort(OPEN, 1, block).blocking, undefined);
  assert.equal(offeredForPickup(OPEN, 3), false, 'a full crew has no seat to offer');
  // The pickup flag alone is not an offer (finding: a walkthrough or split job was exempt).
  for (const [label, row] of NOT_OFFERED) {
    assert.equal(offeredForPickup(row, 1), false, label);
    assert.equal(crewSizeShort(row, 1, block).blocking, true, label);
  }
});

test('skill_missing is per schedule row, explains unrecorded skills and honours the block setting', () => {
  const { people: roster } = fixture(), crew = row => row.assignedCrew;
  const job = { id: 'j1', requiredSkills: ['shelving'] };
  assert.deepEqual(skillMissing(job, [{ id: 'j1', assignedCrew: [] }], { crew, roster }), [], 'unassigned work is reported by the unassigned warning instead');
  const [warning] = skillMissing(job, [{ id: 'j1', assignedCrew: ['crew1'] }], { crew, roster });
  assert.deepEqual(warning, { code: 'skill_missing', jobId: 'j1', message: 'No assigned employee is qualified for Shelving install.', missingSkills: ['shelving'] });
  assert.deepEqual(skillMissing(job, [{ id: 'j1', assignedCrew: ['crew2'] }], { crew, roster }), []);
  const [unknown] = skillMissing(job, [{ id: 'j1', assignedCrew: ['crew3'] }], { crew, roster, settings: settings({ blockSkillMissing: true }) });
  assert.equal(unknown.unverified, true); assert.equal(unknown.blocking, true); assert.match(unknown.message, /not fully recorded/);
  const split = skillMissing(job, [{ id: 'j1', segmentId: 'a', assignedCrew: ['crew2'] }, { id: 'j1', segmentId: 'b', assignedCrew: ['crew1'] }], { crew, roster });
  assert.deepEqual(split.map(row => row.segmentId), ['b'], 'each crew segment needs its own qualified employee');
  const block = settings({ blockSkillMissing: true }), open = { ...OPEN, ...job, crewNeeded: 2 };
  const [seatOpen] = skillMissing(open, [{ id: 'j1', assignedCrew: ['crew1'] }], { crew, roster, settings: block });
  assert.equal(seatOpen.code, 'skill_missing'); assert.equal(seatOpen.blocking, undefined, 'a qualified employee may still claim the open seat');
  assert.equal(skillMissing(open, [{ id: 'j1', assignedCrew: ['crew1', 'crew3'] }], { crew, roster, settings: block })[0].blocking, true, 'a full crew without the skill blocks');
  assert.equal(skillMissing({ ...open, shiftPickupEnabled: false }, [{ id: 'j1', assignedCrew: ['crew1'] }], { crew, roster, settings: block })[0].blocking, true, 'a short crew not offered for pickup blocks');
  assert.equal(skillMissing(open, [{ id: 'j1', segmentId: 'a', assignedCrew: ['crew1'] }], { crew, roster, settings: block })[0].blocking, true, 'a crew segment is never offered for pickup');
  for (const [label, row] of NOT_OFFERED) assert.equal(skillMissing({ ...row, requiredSkills: ['shelving'] }, [{ id: 'j1', assignedCrew: ['crew1'] }], { crew, roster, settings: block })[0].blocking, true, label);
});

test('outside_working_hours checks only recorded weekly hours, per Denver day of the job', () => {
  const { people: roster } = fixture(), crew = row => row.assignedCrew;
  const inside = { id: 'j', date: '2026-09-23', time: '09:00', endDate: '2026-09-23', endTime: '17:00', assignedCrew: ['crew1', 'crew3'] };
  assert.deepEqual(outsideWorkingHours(inside, [inside], { crew, roster }), []);
  const early = { ...inside, time: '07:00' };
  const [warning] = outsideWorkingHours(early, [early], { crew, roster, settings: settings({ blockOutsideHours: true }) });
  assert.deepEqual(warning, { code: 'outside_working_hours', jobId: 'j', employeeId: 'crew1', date: '2026-09-23', message: 'Synthetic Crew One is not scheduled to work Wednesday 7:00 AM – 5:00 PM (2026-09-23).', blocking: true });
  const weekend = { ...inside, date: '2026-09-26', endDate: '2026-09-26', assignedCrew: ['crew2'] };
  assert.match(outsideWorkingHours(weekend, [weekend], { crew, roster })[0].message, /does not work on Saturdays/);
  const overnight = { ...inside, time: '16:00', endDate: '2026-09-24', endTime: '09:00', assignedCrew: ['crew1'] };
  assert.deepEqual(outsideWorkingHours(overnight, [overnight], { crew, roster }).map(row => row.date), ['2026-09-23', '2026-09-24']);
  const split = { ...inside, time: '11:00', endTime: '13:00' };
  assert.deepEqual(outsideWorkingHours(split, [split], { crew, roster: roster.map(person => person.id === 'crew1' ? { ...person, weeklyAvailability: { ...WEEKDAY, wed: [{ start: '08:00', end: '12:00' }, { start: '12:30', end: '17:00' }] } } : person) }).length, 1, 'a lunch gap between windows is outside the hours');
});

test('employee_daily_capacity counts other work once, replaces this job\'s saved rows and uses elapsed hours', () => {
  const { people: roster } = fixture(), crew = row => row.assignedCrew;
  const saved = [
    { id: 'a', type: 'job', date: '2026-09-23', time: '08:00', endDate: '2026-09-23', endTime: '12:00', assignedCrew: ['crew1'] },
    { id: 'b', type: 'job', date: '2026-09-23', time: '13:00', endDate: '2026-09-23', endTime: '15:00', assignedCrew: ['crew1', 'crew2'] },
    { id: 'block', type: 'blocked', date: '2026-09-23', time: '00:00', endDate: '2026-09-24', endTime: '00:00', assignedCrew: [] },
  ];
  const index = capacityIndex(saved, crew);
  assert.deepEqual([...index.get('crew1|2026-09-23')], [['a', 240], ['b', 120]]);
  const next = { id: 'c', type: 'job', date: '2026-09-23', time: '16:00', endDate: '2026-09-23', endTime: '17:00', assignedCrew: ['crew1', 'crew2'] };
  assert.deepEqual(employeeDailyCapacity(next, [next], { crew, roster, index }), [], 'no limits by default');
  const [warning, ...rest] = employeeDailyCapacity(next, [next], { crew, roster, index, settings: settings({ maxJobsPerEmployeePerDay: 2 }) });
  assert.equal(rest.length, 0, 'crew2 has only two jobs');
  assert.deepEqual(warning, { code: 'employee_daily_capacity', jobId: 'c', employeeId: 'crew1', date: '2026-09-23', jobCount: 3, scheduledHours: 7, maxJobsPerEmployeePerDay: 2, maxHoursPerEmployeePerDay: null, message: 'Synthetic Crew One would have 3 jobs (7 hours) on 2026-09-23; the daily limit is 2 jobs.' });
  assert.equal(employeeDailyCapacity(next, [next], { crew, roster, index, settings: settings({ maxHoursPerEmployeePerDay: 7 }) }).length, 0, 'exactly at the hour limit is allowed');
  assert.equal(employeeDailyCapacity(next, [next], { crew, roster, index, settings: settings({ maxHoursPerEmployeePerDay: 6.75, blockOverCapacity: true }) })[0].blocking, true);
  const moved = { ...saved[0], time: '09:00' };
  assert.deepEqual(employeeDailyCapacity(moved, [moved], { crew, roster, index, settings: settings({ maxJobsPerEmployeePerDay: 2 }) }), [], 'an edit counts the job once at its new time');
  assert.deepEqual(ruleWarnings(next, [next], { crew, roster, index, settings: settings({ maxJobsPerEmployeePerDay: 2, blockOverCapacity: true }), enforce: () => false }).map(row => row.blocking), [undefined], 'enforce(false) keeps the warning without blocking');
});

test('with no saved settings every rule is only a warning, and new jobs keep the 20 minute travel buffer', async () => {
  const f = fixture();
  const saved = await f.mutate(f.create({ requiredSkills: ['shelving'], time: '06:00', endTime: '07:00', crewNeeded: 2 }));
  assert.deepEqual(codes(saved.warnings).sort(), ['crew_size_short', 'outside_working_hours', 'skill_missing']);
  assert.ok(saved.warnings.every(row => row.blocking === undefined));
  assert.deepEqual(saved.job.requiredSkills, ['shelving']);
  assert.equal(f.rows.get('jobs/' + saved.job.id).travelBufferMinutes, 0);
  const legacy = await f.mutate(f.create({ time: '09:00', endTime: '10:00', travelBufferMinutes: undefined }, { customerId: 'c1' }));
  assert.equal(f.rows.get('jobs/' + legacy.job.id).travelBufferMinutes, 20, 'new jobs keep the 20 minute default');
  assert.deepEqual(legacy.warnings, []);
  const view = await dispatchOverview(f.store, owner, { startDate: '2026-09-23', endDate: '2026-09-24' }, now);
  assert.deepEqual(view.dispatchRules.blocking, { crewShort: false, skillMissing: false, travelShort: false, overCapacity: false, outsideHours: false });
  assert.equal(view.dispatchRules.workdayStart, '08:00'); assert.equal(view.dispatchRules.defaultTravelBufferMinutes, 20);
  assert.ok(view.dispatchRules.skills.some(skill => skill.id === 'shelving' && skill.label === 'Shelving install'));
  assert.deepEqual(codes(view.warnings.filter(row => row.jobId === saved.job.id)).sort(), ['crew_size_short', 'outside_working_hours', 'skill_missing']);
  await assert.rejects(f.mutate(f.create({ requiredSkills: ['forklift'] })), error => error.code === 'dispatch_skills_invalid' && error.status === 400);
  await assert.rejects(f.mutate(f.create({ requiredSkills: 'shelving' })), error => error.code === 'dispatch_skills_invalid');
});

test('with no saved settings and the staff directory off, saves, receipts and job documents match the output from before this unit byte for byte', async () => {
  // The snapshot is the same scenario run on dispatch code without DISPATCH-RULES
  // (the integration tip 4196ca5); see tests/helpers/dispatch-legacy-scenario.mjs. It covers creates, the
  // editor's full-form save of a legacy row, a move and a crew claim with drive
  // estimates, a cancellation, then the board, the job view and openings.
  const before = JSON.parse(readFileSync(new URL('./snapshots/dispatch-legacy-output.json', import.meta.url), 'utf8'));
  const after = await legacyDispatchScenario({ mutateDispatch, mutateDispatchSelfAssignment, dispatchOverview, dispatchOpenings, travelEstimator });
  // Funnel events carry the live funnel definitions stamp. A later unit that bumps the
  // definitions (FUN-33: 2026-09-28.6 -> .7) changes only that stamp, not dispatch output,
  // so the snapshot's events take the current stamp in place (same keys, same order).
  const stamp = { definitionsVersion: funnelDefinitions().definitionsVersion, definitionsHash: definitionsHash() };
  const snapshotEvents = Object.entries(before.documents).filter(([path]) => path.startsWith('funnelEvents/'));
  assert.ok(snapshotEvents.length > 0 && snapshotEvents.every(([, doc]) => Object.keys(stamp).every(key => typeof doc[key] === 'string')), 'the snapshot\'s funnel events carry a definitions stamp');
  for (const [, doc] of snapshotEvents) Object.assign(doc, stamp);
  assert.equal(before.saves.length, 7);
  assert.ok(before.saves.some(save => save.warnings.some(row => row.code === 'travel_buffer_short' && row.estimateSource === 'offline_zip')) && before.saves.some(save => save.action === 'claim'), 'the snapshot exercises drive estimates and a claim');
  assert.equal(JSON.stringify(after.saves), JSON.stringify(before.saves), 'every save response, warnings included');
  assert.equal(JSON.stringify(after.documents), JSON.stringify(before.documents), 'every stored document: jobs, day locks, receipts, projects and the dispatch guard');
  // Reads only gain documented fields: dispatchRules on GET /api/dispatch, and
  // the search mode and each candidate's employees on openings.
  const { dispatchRules, ...board } = after.board, { dispatchRules: jobRules, ...jobView } = after.jobView;
  assert.equal(JSON.stringify(board), JSON.stringify(before.board));
  assert.equal(JSON.stringify(jobView), JSON.stringify(before.jobView));
  assert.deepEqual(dispatchRules.blocking, { crewShort: false, skillMissing: false, travelShort: false, overCapacity: false, outsideHours: false });
  assert.deepEqual(jobRules, dispatchRules);
  const { requiredSkills, mode, searchedEmployeeIds, ...constraints } = after.openings.constraints;
  assert.deepEqual([requiredSkills, mode, searchedEmployeeIds], [[], 'together', ['crew1']]);
  assert.ok(before.openings.candidates.length > 0 && after.openings.candidates.every(candidate => JSON.stringify(candidate.employeeIds) === '["crew1"]'));
  assert.equal(JSON.stringify({ ...after.openings, constraints, candidates: after.openings.candidates.map(({ employeeIds, ...candidate }) => candidate) }), JSON.stringify(before.openings));
});

test('blocking rules turn their warning into a 409 only for changes to what the rule reads', async () => {
  const f = fixture({ rules: { blockSkillMissing: true, blockOutsideHours: true, blockCrewShort: true } });
  await rejectsConflict(f.mutate(f.create({ requiredSkills: ['shelving'] })), 'skill_missing');
  await rejectsConflict(f.mutate(f.create({ time: '17:00', endTime: '18:00' })), 'outside_working_hours');
  await rejectsConflict(f.mutate(f.create({ crewNeeded: 2 })), 'crew_size_short');
  const open = await f.mutate(f.create({ crewNeeded: 2, shiftPickupEnabled: true }));
  assert.equal(open.job.openShift, true, 'an open shift offered for pickup may be short');
  assert.ok(open.warnings.some(row => row.code === 'crew_size_short' && row.blocking === undefined));
  const unscheduled = await f.mutate(f.create({ date: '', time: '', endTime: '', requiredSkills: ['shelving'] }));
  assert.equal(unscheduled.job.status, 'unscheduled', 'backlog without a time is never blocked');
  const qualified = await f.mutate(f.create({ requiredSkills: ['shelving'], assignedCrew: ['crew2'], time: '15:00', endTime: '16:00' }));
  // A saved job that is short of a rule (the owner blocked it later) still takes unrelated edits.
  f.job('legacy', { requiredSkills: ['shelving'], time: '06:00', endTime: '07:00' });
  const legacy = await f.mutate(f.edit(f.rows.get('jobs/legacy'), { opsNotes: 'Synthetic gate code updated' }));
  assert.deepEqual(codes(legacy.warnings).filter(code => ['skill_missing', 'outside_working_hours'].includes(code)).sort(), ['outside_working_hours', 'skill_missing']);
  assert.ok(legacy.warnings.every(row => row.blocking === undefined));
  await rejectsConflict(f.mutate(f.edit(f.rows.get('jobs/legacy'), { time: '06:30' })), 'outside_working_hours');
  await rejectsConflict(f.mutate(f.edit(f.rows.get('jobs/' + qualified.job.id), { assignedCrew: ['crew1'] })), 'skill_missing');
  await rejectsConflict(f.mutate(f.edit(f.rows.get('jobs/' + qualified.job.id), { requiredSkills: ['shelving', 'heavy_lifting'] })), 'skill_missing');
  f.setRules({ blockSkillMissing: false });
  const allowed = await f.mutate(f.edit(f.rows.get('jobs/' + qualified.job.id), { assignedCrew: ['crew1'] }));
  assert.ok(allowed.warnings.some(row => row.code === 'skill_missing' && row.blocking === undefined), 'the owner can turn a block back into a warning');
});

test('only a job really offered for pickup escapes the crew-size and skill blocks: a walkthrough or a split job with the pickup flag gets 409', async () => {
  const f = fixture({ rules: { blockCrewShort: true } });
  f.store.segmentsEnabled = true;
  const walkthrough = (changes = {}) => f.create({ crewNeeded: 2, shiftPickupEnabled: true, ...changes }, { kind: 'walkthrough' });
  const split = (changes = {}) => f.create({ date: undefined, time: undefined, endTime: undefined, assignedCrew: undefined, assignmentSegments: [{ id: 'a', date: '2026-09-23', time: '15:00', endTime: '16:00', assignedCrew: ['crew1'] }], crewNeeded: 2, shiftPickupEnabled: true, ...changes });
  await rejectsConflict(f.mutate(walkthrough()), 'crew_size_short');
  await rejectsConflict(f.mutate(split()), 'crew_size_short');
  const open = await f.mutate(f.create({ crewNeeded: 2, shiftPickupEnabled: true, time: '09:00', endTime: '10:00' }));
  assert.equal(open.job.openShift, true, 'a job-level shift is offered');
  assert.ok(open.warnings.some(row => row.code === 'crew_size_short' && row.blocking === undefined));
  f.setRules({ blockCrewShort: false, blockSkillMissing: true });
  await rejectsConflict(f.mutate(walkthrough({ requiredSkills: ['shelving'] })), 'skill_missing');
  await rejectsConflict(f.mutate(split({ requiredSkills: ['shelving'] })), 'skill_missing');
  // With the blocks off the same saves go through, and the server never offered them.
  f.setRules({ blockSkillMissing: false });
  const savedWalkthrough = await f.mutate(walkthrough({ requiredSkills: ['shelving'] })), savedSplit = await f.mutate(split({ requiredSkills: ['shelving'] }));
  assert.deepEqual([savedWalkthrough.job.openShift, savedSplit.job.openShift], [false, false]);
  assert.ok(savedSplit.job.assignmentSegments.length === 1 && savedSplit.warnings.some(row => row.code === 'crew_size_short'));
});

test('the dispatch editor\'s full-form save of a legacy row is blocked only when it changes what a rule reads', async () => {
  const f = fixture({ rules: { blockSkillMissing: true, blockOutsideHours: true, blockCrewShort: true } });
  legacyRow(f, 'legacy', { requiredSkills: ['shelving'], time: '06:00', endTime: '07:00' });
  const dto = await editorDto(f, 'legacy');
  assert.deepEqual([dto.endDate, dto.assignedCrew, dto.crewNeeded], ['2026-09-23', ['crew1'], 1], 'the editor is filled with the computed legacy values');
  const saved = await f.mutate(formSave(dto, { opsNotes: 'Synthetic gate code updated' }));
  assert.equal(f.rows.get('jobs/legacy').opsNotes, 'Synthetic gate code updated');
  assert.deepEqual(codes(saved.warnings).filter(code => ['skill_missing', 'outside_working_hours'].includes(code)).sort(), ['outside_working_hours', 'skill_missing']);
  assert.ok(saved.warnings.every(row => row.blocking === undefined), 'the form re-sending endDate, assignedCrew and crewNeeded 1 is not a change');
  const again = await editorDto(f, 'legacy');
  await rejectsConflict(f.mutate(formSave(again, { time: '06:30' })), 'outside_working_hours');
  await rejectsConflict(f.mutate(formSave(again, { assignedCrew: ['crew3'] })), 'skill_missing');
  await rejectsConflict(f.mutate(formSave(again, { crewNeeded: 2 })), 'crew_size_short');
  // The same holds for an owner drive-time block on a stop that is already short.
  const g = fixture({ rules: { blockTravelShort: true } }), travel = () => travelEstimator({ env: { EGC_DISPATCH_TRAVEL_ESTIMATES: 'offline' }, store: g.store, fetcher: noNetwork, now: () => now });
  g.job('fc', { time: '08:00', endTime: '09:00' }); legacyRow(g, 'lv', { address: LOVELAND, customerId: 'c2', time: '09:20', endTime: '10:20' });
  const stop = await editorDto(g, 'lv');
  const notes = await g.mutate(formSave(stop, { accessInstructions: 'Synthetic side door' }), { travel: travel() });
  assert.equal(notes.job.accessInstructions, 'Synthetic side door');
  assert.ok(notes.warnings.some(row => row.code === 'travel_buffer_short' && row.estimatedMinutes === 30 && row.blocking === undefined));
  await rejectsConflict(g.mutate(formSave(await editorDto(g, 'lv'), { time: '09:25', endTime: '10:25' }), { travel: travel() }), 'travel_buffer_short');
});

test('a manager may publish an open shift whose first assignee lacks a required skill; the seat that completes the crew needs it', async () => {
  const f = fixture({ rules: { blockSkillMissing: true } });
  const open = await f.mutate(f.create({ requiredSkills: ['shelving'], crewNeeded: 2, shiftPickupEnabled: true }));
  assert.equal(open.job.openShift, true);
  assert.ok(open.warnings.some(row => row.code === 'skill_missing' && row.blocking === undefined));
  await rejectsConflict(f.mutate(f.create({ requiredSkills: ['shelving'], crewNeeded: 2, shiftPickupEnabled: true, assignedCrew: ['crew1', 'crew3'], crewLead: 'crew1', time: '15:00', endTime: '16:00' })), 'skill_missing');
  await rejectsConflict(f.mutate(f.edit(f.rows.get('jobs/' + open.job.id), { crewNeeded: 1 })), 'skill_missing');
  const filled = await mutateDispatchSelfAssignment(f.store, { user: 'crew2' }, { action: 'claim', jobId: open.job.id, requestId: randomUUID() }, NOW);
  assert.deepEqual(filled.job.assignedCrew, ['crew1', 'crew2'], 'a qualified employee claims the open seat');
});

test('daily capacity limits warn or block across jobs, and an edit is not counted twice', async () => {
  const f = fixture({ rules: { maxJobsPerEmployeePerDay: 2 } });
  // Saved work for a customer with no other visits, so new bookings need no account-lineage choice.
  f.job('first', { customerId: 'c9', time: '08:00', endTime: '09:00' }); f.job('second', { customerId: 'c9', time: '10:00', endTime: '11:00' });
  const third = await f.mutate(f.create({ time: '12:00', endTime: '13:00' }));
  assert.deepEqual(third.warnings.filter(row => row.code === 'employee_daily_capacity').map(row => [row.employeeId, row.jobCount, row.blocking]), [['crew1', 3, undefined]]);
  f.setRules({ blockOverCapacity: true, maxJobsPerEmployeePerDay: 3, maxHoursPerEmployeePerDay: 3.5 });
  await rejectsConflict(f.mutate(f.create({ time: '14:00', endTime: '15:00' }, { customerId: 'c1' })), 'employee_daily_capacity');
  const moved = await f.mutate(f.edit(f.rows.get('jobs/second'), { time: '10:30', endTime: '11:30' }));
  assert.ok(!moved.warnings.some(row => row.code === 'employee_daily_capacity'), 'moving a job within the day is not a fourth job');
  const view = await dispatchOverview(f.store, owner, { startDate: '2026-09-23', endDate: '2026-09-24' }, now);
  assert.equal(view.warnings.filter(row => row.code === 'employee_daily_capacity').length, 0, 'three jobs and three hours fit the limits');
  const other = await f.mutate(f.create({ time: '14:00', endTime: '15:00', assignedCrew: ['crew2'] }, { customerId: 'c1' }));
  assert.equal(other.job.assignedCrew[0], 'crew2', 'another employee has their own daily capacity');
});

test('settings supply the new-job travel buffer, the arrival window length and blockTravelShort (with drive estimates)', async () => {
  const f = fixture({ rules: { defaultTravelBufferMinutes: 35, defaultArrivalWindowMinutes: 90 } });
  const created = await f.mutate(f.create({ travelBufferMinutes: undefined }));
  assert.equal(f.rows.get('jobs/' + created.job.id).travelBufferMinutes, 35);
  f.store.settings = async () => ({ defaultArrivalWindowEnabled: true, defaultArrivalWindowMinutes: 60 });
  const windowed = await f.mutate(f.create({ time: '09:00', endTime: '10:00' }, { customerId: 'c1' }));
  assert.equal(windowed.job.arrivalWindow, '9:00 AM – 10:30 AM', 'the owner window length replaces the env default');
  assert.deepEqual((await dispatchOverview(f.store, owner, {}, now)).arrivalDefaults, { enabled: true, minutes: 90 });
  const g = fixture({ rules: { blockTravelShort: true } }), travel = () => travelEstimator({ env: { EGC_DISPATCH_TRAVEL_ESTIMATES: 'offline' }, store: g.store, fetcher: noNetwork, now: () => now });
  g.job('fc', { time: '08:00', endTime: '09:00' }); g.job('fc2', { date: '2026-09-24', endDate: '2026-09-24', time: '08:00', endTime: '09:00' });
  const warned = await g.mutate(g.create({ time: '09:20', endTime: '10:20' }));
  assert.ok(warned.warnings.every(row => row.code !== 'travel_buffer_short'), 'without drive estimates the setting has nothing to block');
  // Fort Collins to Loveland is about 30 minutes; a 20 minute gap is short.
  await rejectsConflict(g.mutate(g.create({ date: '2026-09-24', time: '09:20', endTime: '10:20' }), { travel: travel() }), 'travel_buffer_short');
  // The board, the job view and the drive-time API report the owner block, so the Rules view never calls a block a warning.
  g.job('lv2', { address: LOVELAND, customerId: 'c2', date: '2026-09-24', endDate: '2026-09-24', time: '09:20', endTime: '10:20' });
  const board = await dispatchOverview(g.store, owner, { startDate: '2026-09-24', endDate: '2026-09-25' }, now, { travel: travel() });
  assert.ok(board.warnings.some(row => row.code === 'travel_buffer_short' && row.jobId === 'lv2' && row.blocking === true));
  const single = await dispatchOverview(g.store, owner, { view: 'job', jobId: 'lv2' }, now, { travel: travel() });
  assert.ok(single.warnings.some(row => row.code === 'travel_buffer_short' && row.blocking === true));
  assert.ok((await dispatchOverview(g.store, owner, { startDate: '2026-09-24', endDate: '2026-09-25' }, now)).warnings.every(row => row.code !== 'travel_buffer_short' || row.blocking === undefined), 'without estimates nothing blocks');
  assert.equal((await dispatchTravelRoutes(g.store, owner, { date: '2026-09-24' }, now, { travel: travel() })).travel.blockTravelShort, true);
  g.setRules({ blockTravelShort: false });
  assert.equal((await dispatchTravelRoutes(g.store, owner, { date: '2026-09-24' }, now, { travel: travel() })).travel.blockTravelShort, false);
  assert.ok((await dispatchOverview(g.store, owner, { startDate: '2026-09-24', endDate: '2026-09-25' }, now, { travel: travel() })).warnings.some(row => row.code === 'travel_buffer_short' && row.jobId === 'lv2' && row.blocking === undefined));
  g.rows.delete('jobs/lv2');
  const allowed = await g.mutate(g.create({ date: '2026-09-24', time: '09:20', endTime: '10:20' }), { travel: travel() });
  assert.ok(allowed.warnings.some(row => row.code === 'travel_buffer_short' && row.estimatedMinutes === 30 && row.blocking === undefined));
});

test('crew shift claims use drive estimates and answer only for the claimer\'s own rules', async () => {
  const f = fixture({ rules: { blockTravelShort: true, blockOverCapacity: true, maxJobsPerEmployeePerDay: 2, blockSkillMissing: true } });
  const travel = () => travelEstimator({ env: { EGC_DISPATCH_TRAVEL_ESTIMATES: 'offline' }, store: f.store, fetcher: noNetwork, now: () => now });
  const claim = (user, id, options = { travel: travel() }) => mutateDispatchSelfAssignment(f.store, { user }, { action: 'claim', jobId: id, requestId: randomUUID() }, NOW, options);
  const shift = (id, changes = {}) => f.job(id, { address: LOVELAND, customerId: 'c2', time: '09:20', endTime: '10:20', assignedCrew: [], crewNeeded: 1, shiftPickupEnabled: true, openShift: true, ...changes });
  f.job('crew2-fc', { assignedCrew: ['crew2'], time: '08:00', endTime: '09:00' }); f.job('crew2-late', { assignedCrew: ['crew2'], time: '16:00', endTime: '17:00' });
  shift('near-crew2', { assignedCrew: ['crew2'], crewNeeded: 2 });
  const picked = await claim('crew1', 'near-crew2');
  assert.deepEqual(picked.job.assignedCrew, ['crew2', 'crew1'], 'another employee\'s drive shortfall and daily limit do not block this claim');
  f.job('crew3-fc', { assignedCrew: ['crew3'], date: '2026-09-24', endDate: '2026-09-24', time: '08:00', endTime: '09:00' });
  shift('near-crew3', { date: '2026-09-24', endDate: '2026-09-24' });
  await assert.rejects(claim('crew3', 'near-crew3'), error => error.code === 'dispatch_conflict' && error.details.conflicts.some(row => row.code === 'travel_buffer_short' && row.estimateSource === 'offline_zip' && row.blocking === true), 'the claimer\'s own short drive blocks (P1-07 gap)');
  const notice = await claim('crew3', 'near-crew3', {});
  assert.deepEqual(notice.job.assignedCrew, ['crew3'], 'without drive estimates the manual buffer applies, as before');
  f.job('crew1-noon', { time: '12:00', endTime: '13:00' });
  shift('third-today', { time: '15:00', endTime: '16:00', address: FC, customerId: 'c1' });
  await assert.rejects(claim('crew1', 'third-today'), error => error.details?.conflicts?.some(row => row.code === 'employee_daily_capacity' && row.employeeId === 'crew1' && row.jobCount === 3));
  shift('skilled', { date: '2026-09-25', endDate: '2026-09-25', requiredSkills: ['shelving'], address: FC, customerId: 'c1' });
  await assert.rejects(claim('crew1', 'skilled'), error => error.details?.conflicts?.some(row => row.code === 'skill_missing'), 'completing a crew without the skill is blocked');
  const partial = shift('skilled-pair', { date: '2026-09-25', endDate: '2026-09-25', time: '13:00', endTime: '14:00', crewNeeded: 2, requiredSkills: ['shelving'], address: FC, customerId: 'c1' });
  const first = await claim('crew1', partial.id);
  assert.equal(first.job.openShift, true, 'a claim that leaves seats open is not blocked by the missing skill');
  const second = await claim('crew2', partial.id);
  assert.deepEqual(second.job.assignedCrew, ['crew1', 'crew2']);
});

test('a refused crew claim says the shift was not added and names each rule; manager saves keep the dispatch wording', async () => {
  const f = fixture({ rules: { blockOverCapacity: true, maxJobsPerEmployeePerDay: 1 } });
  f.job('crew1-morning', { time: '08:00', endTime: '09:00' });
  f.job('open-seat', { address: FC, customerId: 'c1', time: '15:00', endTime: '16:00', assignedCrew: [], crewNeeded: 1, shiftPickupEnabled: true, openShift: true });
  const refused = await mutateDispatchSelfAssignment(f.store, { user: 'crew1' }, { action: 'claim', jobId: 'open-seat', requestId: randomUUID() }, NOW).then(() => null, error => error);
  assert.equal(refused?.code, 'dispatch_conflict'); assert.equal(refused.status, 409);
  assert.equal(refused.message, 'This shift cannot be added to your schedule.', 'a crew member cannot choose another time, crew or vehicle');
  assert.deepEqual(refused.details.conflicts.map(row => [row.code, row.employeeId, row.blocking]), [['employee_daily_capacity', 'crew1', true]]);
  assert.match(refused.details.conflicts[0].message, /the daily limit is 1 job\.$/);
  const manager = await f.mutate(f.create({ time: '11:00', endTime: '12:00' })).then(() => null, error => error);
  assert.equal(manager?.message, 'This change conflicts with scheduled work or employee availability. Choose a different time, crew, or vehicle.');
});

test('the production jobs scan reads requiredSkills', async () => {
  const masks = [];
  const store = dispatchStorage({}, async (env, url) => { masks.push(new URL(url).searchParams.getAll('mask.fieldPaths')); return new Response(JSON.stringify({ documents: [] }), { status: 200 }); });
  await store.jobs();
  assert.ok(masks[0].includes('requiredSkills'));
  assert.ok(masks[0].includes('assignedCrew'), 'the existing mask is kept');
  assert.equal(new Set(masks[0]).size, masks[0].length);
});

test('rule checks build one capacity index per request, and history outside the board range adds no capacity warnings', async () => {
  // capacityIndex() is the only rule step that visits every stored row, and it reads
  // each row's `type` once per build. Counting those reads on 300 history rows, with
  // the daily limits on and off and with 20 or 40 jobs on the board, shows the index
  // is built exactly once per request, however many jobs are checked against it.
  const limits = { maxJobsPerEmployeePerDay: 50, maxHoursPerEmployeePerDay: 24 };
  const run = async (rules, count, query = { startDate: '2026-09-23', endDate: '2026-09-24' }) => {
    const f = fixture({ rules });
    for (let i = 0; i < 300; i++) f.job(`history_${i}`, { date: '2025-01-01', endDate: '2025-01-01' });
    for (let i = 0; i < count; i++) f.job(`current_${i}`, { time: `${String(8 + (i % 8)).padStart(2, '0')}:00`, endTime: `${String(8 + (i % 8)).padStart(2, '0')}:30`, assignedCrew: [`crew${1 + (i % 2)}`] });
    let reads = 0;
    const jobs = f.store.jobs, spy = row => new Proxy(row, { get(target, key, receiver) { if (key === 'type') reads++; return Reflect.get(target, key, receiver); } });
    f.store.jobs = async () => (await jobs()).map(row => row.id.startsWith('history_') ? spy(row) : row);
    const result = await dispatchOverview(f.store, owner, query, now);
    return { result, readsPerRow: reads / 300, rows: await jobs() };
  };
  const off = await run(null, 20), on = await run(limits, 20), busier = await run(limits, 40);
  assert.equal(on.readsPerRow - off.readsPerRow, 1, 'the limits add one pass over the stored rows');
  assert.equal(busier.readsPerRow, on.readsPerRow, 'twice the jobs on the board, still one pass');
  assert.deepEqual([on.result.jobs.length, busier.result.jobs.length], [20, 40]);
  assert.ok(scheduleInterval(on.result.jobs[0]));
  // The history day is far over the limit (300 jobs) and is indexed, but no board
  // job shares its date, so it adds no warning; the job view of a history row does.
  assert.equal(capacityIndex(on.rows, row => row.assignedCrew).get('crew1|2025-01-01').size, 300);
  assert.equal(on.result.warnings.filter(row => row.code === 'employee_daily_capacity').length, 0);
  const history = await run(limits, 20, { view: 'job', jobId: 'history_0' });
  assert.equal(history.readsPerRow - (await run(null, 20, { view: 'job', jobId: 'history_0' })).readsPerRow, 1, 'the job view builds the index once too');
  assert.deepEqual(history.result.warnings.filter(row => row.code === 'employee_daily_capacity').map(row => [row.employeeId, row.date, row.jobCount]), [['crew1', '2025-01-01', 300]]);
});
