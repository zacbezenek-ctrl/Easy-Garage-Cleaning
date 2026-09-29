// DISPATCH-RULES x DISPATCH-SCALE: owner rule blocks (daily capacity, skills)
// read the same evidence under EGC_DISPATCH_WINDOWED_READS=true and 'shadow' as
// under the complete scan. Runs the real dispatchStorage (field masks included)
// against the Firestore REST fake, with a fixed clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchStorage, JOB_FIELDS } from '../functions/_lib/dispatch-storage.js';
import { dispatchOverview, mutateDispatch, mutateDispatchSelfAssignment } from '../functions/_lib/dispatch-service.js';
import { dispatchOpenings } from '../functions/_lib/dispatch-openings.js';
import { firestoreRest } from './helpers/firestore-rest-queries.mjs';

const NOW = new Date('2026-09-22T12:00:00.000Z');
const owner = { user: 'zacb', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
const ROSTER = [
  { id: 'zacb', name: 'Synthetic Owner', role: 'owner', skills: [] },
  { id: 'crew1', name: 'Synthetic Crew One', role: 'crew', skills: [{ id: 'shelving', level: 'proficient' }] },
  { id: 'crew2', name: 'Synthetic Crew Two', role: 'crew', skills: [] },
  { id: 'crew3', name: 'Synthetic Crew Three', role: 'crew', skills: [] },
  { id: 'crew4', name: 'Synthetic Crew Four', role: 'crew', skills: [] },
];
// EGC_DISPATCH_WINDOWED_READS values: unset is the complete scan, 'true' windowed, 'shadow' both.
const MODES = { full: undefined, shadow: 'shadow', windowed: 'true' };
const visit = (date, time, endDate, endTime, crew, extra = {}) => ({ type: 'job', status: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', address: '100 Synthetic Way, Fort Collins, CO 80525', jobInstructions: 'Synthetic scope', date, time, endDate, endTime, assignedCrew: crew, crewLead: crew[0] || null, crewNeeded: crew.length || 1, travelBufferMinutes: 20, ...extra });

function seed() {
  const rows = {
    'customers/c1': { name: 'Synthetic Customer', phone: '(970) 555-0100', address: '100 Synthetic Way' },
    'customers/c2': { name: 'Second Synthetic', phone: '(970) 555-0111', address: '200 Synthetic Way' },
    'dispatchSettings/current': { blockOverCapacity: true, maxJobsPerEmployeePerDay: 1, blockSkillMissing: true, updatedAt: '2026-09-21T12:00:00.000Z', updatedBy: 'zacb' },
    // crew1's only job on 2026-09-23. Its id sorts after 520 old history rows, so the
    // complete scan reaches it only on its second page; the windowed reads never load that history.
    'jobs/zz-same-day': visit('2026-09-23', '13:00', '2026-09-23', '14:00', ['crew1']),
    // crew2's multi-day job started three days before the window and runs into 2026-09-23.
    'jobs/prior-multi': visit('2026-09-20', '08:00', '2026-09-23', '17:00', ['crew2']),
    // crew3 is over the limit on 2026-09-22 (the board shows it) through another multi-day job.
    'jobs/prior-multi-3': visit('2026-09-19', '08:00', '2026-09-22', '12:00', ['crew3']),
    'jobs/zz-crew3-evening': visit('2026-09-22', '18:00', '2026-09-22', '19:00', ['crew3']),
    // Required skills must survive the windowed field mask: crew4 cannot do shelving.
    'jobs/zz-needs-shelving': visit('2026-09-24', '09:00', '2026-09-24', '11:00', ['crew4'], { requiredSkills: ['shelving'] }),
    // An open seat on 2026-09-23 that crew1 could claim if not for the daily limit.
    'jobs/zz-open-seat': visit('2026-09-23', '15:00', '2026-09-23', '16:00', ['crew4'], { crewNeeded: 2, shiftPickupEnabled: true, openShift: true }),
  };
  for (let index = 0; index < 520; index++) rows[`jobs/a-history-${String(index).padStart(4, '0')}`] = visit('2025-03-01', '08:00', '2025-03-01', '09:00', [`crew${index % 4 + 1}`], { status: 'completed' });
  return rows;
}
function stores() {
  const logs = [], log = { info: line => logs.push(JSON.parse(line)), warn: line => logs.push(JSON.parse(line)) };
  const build = mode => { const fs = firestoreRest(seed()); return { fs, store: { ...dispatchStorage({ EGC_DISPATCH_WINDOWED_READS: MODES[mode] }, fs.fetcher), roster: async () => structuredClone(ROSTER), log } }; };
  return { logs, byMode: { full: build('full'), shadow: build('shadow'), windowed: build('windowed') } };
}
const outcome = promise => promise.then(result => ({ result: { ok: result.ok, jobId: result.job?.id, assignedCrew: result.job?.assignedCrew, warnings: result.warnings } }), error => ({ error: { code: error.code, status: error.status, conflicts: (error.details?.conflicts || []).map(row => [row.code, row.employeeId || null, row.date || null, row.blocking === true]) } }));
const create = (n, changes) => ({ action: 'schedule.create', requestId: `00000000-0000-4000-8000-0000000003${n}`, customerId: 'c2', kind: 'job', changes: { jobInstructions: 'Synthetic scope', ...changes } });

test('requiredSkills is in the frozen dispatch field mask that the scans and windowed queries share', () => {
  assert.ok(Object.isFrozen(JOB_FIELDS), 'JOB_FIELDS stays frozen (RECUR-CRON)');
  assert.ok(JOB_FIELDS.includes('requiredSkills'));
  assert.equal(new Set(JOB_FIELDS).size, JOB_FIELDS.length, 'each field once');
});

test('windowed and shadow saves, claims, the board, the job view and openings enforce daily limits and skills from the same evidence as the complete scan', async () => {
  const { logs, byMode } = stores(), results = {};
  for (const [mode, { store, fs }] of Object.entries(byMode)) {
    const claimer = { user: 'crew1', displayName: 'Synthetic Crew One', role: 'crew' };
    results[mode] = {
      // crew1 already works 2026-09-23 (zz-same-day, second page of the complete scan).
      sameDay: await outcome(mutateDispatch(store, owner, create('01', { date: '2026-09-23', time: '09:00', endTime: '11:00', assignedCrew: ['crew1'] }), NOW.toISOString())),
      // crew2's multi-day job that began before the window covers 2026-09-23.
      multiDay: await outcome(mutateDispatch(store, owner, create('02', { date: '2026-09-23', time: '18:00', endTime: '19:00', assignedCrew: ['crew2'] }), NOW.toISOString())),
      // Nobody else works 2026-09-25: the same save for crew4 is allowed.
      free: await outcome(mutateDispatch(store, owner, create('03', { date: '2026-09-25', time: '09:00', endTime: '11:00', assignedCrew: ['crew4'] }), NOW.toISOString())),
      // A skill block needs requiredSkills from the rows the save reads.
      skills: await outcome(mutateDispatch(store, owner, create('04', { date: '2026-09-26', time: '09:00', endTime: '11:00', assignedCrew: ['crew3'], requiredSkills: ['shelving'] }), NOW.toISOString())),
      claim: await outcome(mutateDispatchSelfAssignment(store, claimer, { action: 'claim', jobId: 'zz-open-seat', requestId: '00000000-0000-4000-8000-000000000399', expectedRevision: fs.get('jobs/zz-open-seat').revision }, NOW.toISOString())),
      board: await dispatchOverview(store, owner, { startDate: '2026-09-22', endDate: '2026-09-29' }, NOW),
      job: await dispatchOverview(store, owner, { view: 'job', jobId: 'zz-needs-shelving' }, NOW),
      openingsBusy: await dispatchOpenings(store, owner, { startDate: '2026-09-23', endDate: '2026-09-24', employeeIds: 'crew1', durationMinutes: '60' }, NOW),
      openingsMulti: await dispatchOpenings(store, owner, { startDate: '2026-09-23', endDate: '2026-09-24', employeeIds: 'crew2', durationMinutes: '60' }, NOW),
    };
    if (mode === 'windowed') {
      assert.equal(fs.scans('jobs').length, 0, 'windowed mode never runs the complete jobs scan (store.jobs())');
      assert.ok(fs.queries('jobs').length > 0, 'windowed mode reads through jobsNear/jobsWhere');
    } else if (mode === 'full') assert.equal(fs.queries('jobs').length, 0, 'the default mode issues no window queries');
    else assert.ok(fs.scans('jobs').length > 0 && fs.queries('jobs').length > 0, 'shadow runs both and answers from the scan');
  }
  // Saves and claims return the same result in every mode (job DTOs' clock-stamped fields are left out above).
  for (const key of ['sameDay', 'multiDay', 'free', 'skills', 'claim']) {
    assert.deepEqual(results.windowed[key], results.full[key], key);
    assert.deepEqual(results.shadow[key], results.full[key], key);
  }
  const { sameDay, multiDay, free, skills, claim } = results.windowed;
  assert.equal(sameDay.error?.code, 'dispatch_conflict'); assert.equal(sameDay.error.status, 409);
  assert.deepEqual(sameDay.error.conflicts, [['employee_daily_capacity', 'crew1', '2026-09-23', true]]);
  assert.deepEqual(multiDay.error?.conflicts, [['employee_daily_capacity', 'crew2', '2026-09-23', true]], 'the multi-day job that started before the window is counted');
  assert.equal(free.result?.ok, true);
  assert.deepEqual(skills.error?.conflicts, [['skill_missing', null, null, true]]);
  assert.deepEqual(claim.error?.conflicts, [['employee_daily_capacity', 'crew1', '2026-09-23', true]], "a claim answers for the claimer's own daily limit");
  // Reads: identical answers, and the rule inputs came through the windowed mask.
  for (const key of ['board', 'job', 'openingsBusy', 'openingsMulti']) {
    assert.deepEqual(results.windowed[key], results.full[key], key);
    assert.deepEqual(results.shadow[key], results.full[key], key);
  }
  const rule = (warnings, code, jobId) => warnings.filter(row => row.code === code && row.jobId === jobId).map(row => [row.employeeId || null, row.date || null, row.blocking === true]);
  const { board, job, openingsBusy, openingsMulti } = results.windowed;
  assert.deepEqual(rule(board.warnings, 'employee_daily_capacity', 'zz-crew3-evening'), [['crew3', '2026-09-22', true]], 'the board counts the multi-day job that began before the window');
  assert.deepEqual(rule(board.warnings, 'skill_missing', 'zz-needs-shelving'), [[null, null, true]], 'requiredSkills survives the windowed field mask');
  assert.deepEqual(rule(job.warnings, 'skill_missing', 'zz-needs-shelving'), [[null, null, true]]);
  assert.equal(board.dispatchRules.blocking.overCapacity, true); assert.equal(board.dispatchRules.maxJobsPerEmployeePerDay, 1);
  for (const [openings, id] of [[openingsBusy, 'crew1'], [openingsMulti, 'crew2']]) {
    assert.deepEqual(openings.candidates, [], `${id} has no openings on a day the limit blocks`);
    assert.ok(openings.warnings.some(row => row.code === 'employee_daily_capacity' && row.employeeId === id && row.date === '2026-09-23' && row.blocking === true), id);
  }
  // Shadow compared every windowed read with the complete scan and found no missing row.
  const shadow = logs.filter(line => line.event === 'dispatch_window_shadow');
  assert.ok(shadow.length > 0 && shadow.every(line => line.match === true), JSON.stringify(shadow.find(line => !line.match)));
  assert.deepEqual(new Set(shadow.map(line => line.label)), new Set(['save', 'shift', 'board', 'job', 'openings']));
});
