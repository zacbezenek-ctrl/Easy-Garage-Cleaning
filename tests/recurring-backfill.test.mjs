import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BACKFILL_ACTOR, backfillPlanId, parseArgs, planRecurringBackfill, runRecurringBackfill } from '../scripts/backfill-recurring-plans.mjs';
import { extendHorizon, occurrenceRequestId } from '../functions/_lib/recurring-plan-service.js';
import { NOW, manager, recurringFixture } from './helpers/recurring-fixture.mjs';

const visit = (id, date, extra = {}) => ({ id, revision:`${id}-r1`, type:'job', customerId:'c1', customer:'Synthetic Customer', address:'100 Synthetic Street', date, time:'08:00', endDate:date, endTime:'10:00', status:'scheduled', recurrence:'weekly', assignedCrew:['crew1'], crewLead:'crew1', ...extra });
const child = (id, root, date, extra = {}) => visit(id, date, { sourceTemplateJobId:root, recurrenceParentId:root, ...extra });
const JOBS = () => [
  // A: clean weekly series; the 10/07 visit was cancelled, so 09/30 anchors the plan.
  visit('a0', '2026-09-09', { status:'completed' }), child('a1', 'a0', '2026-09-16', { status:'completed' }), child('a2', 'a0', '2026-09-23'), child('a3', 'a0', '2026-09-30', { assignedCrew:['crew1', 'gone'], crewId:'crew-a', vehicleId:'van-gone' }), child('a4', 'a0', '2026-10-07', { status:'cancelled' }),
  // B: visits for two customers; C: visits disagree on the interval; F: no customer.
  visit('b0', '2026-09-24', { recurrence:'monthly' }), child('b1', 'b0', '2026-10-24', { recurrence:'monthly', customerId:'c2' }),
  visit('c0', '2026-09-25'), child('c1', 'c0', '2026-10-09', { recurrence:'biweekly' }),
  visit('f0', '2026-09-26', { customerId:'' }),
  // D: ended in the past; E: already a plan's template.
  visit('d0', '2026-08-01', { recurrence:'biweekly' }), child('d1', 'd0', '2026-08-15', { recurrence:'biweekly' }),
  visit('e0', '2026-09-28'), child('e1', 'e0', '2026-10-05'),
  // G: monthly on the 31st; H: the root no longer repeats but its visits do.
  visit('g0', '2026-10-31', { recurrence:'monthly', time:'13:00', endTime:'15:00', notify:false, crewId:'crew-gone', vehicleId:'van-1' }),
  visit('h0', '2026-09-10', { recurrence:'none', status:'completed' }), child('h1', 'h0', '2026-10-01', { recurrence:'quarterly' }),
  // Never part of a series.
  visit('one-off', '2026-09-29', { recurrence:'none' }), visit('walk', '2026-09-29', { type:'walkthrough' }), { id:'_egc_schedule_lock_2026-09-23', type:'job', recurrence:'weekly' }, visit('plan-visit', '2026-10-02', { recurrence:'none', recurringPlanId:'plan_x' }),
  child('orphan-x', 'x-parent', '2026-10-02', { recurrence:'weekly', sourceTemplateJobId:'y-parent', recurrenceParentId:'x-parent' }),
];
const PLANS = [{ id:'plan_existing', recordType:'recurring_plan', templateJobId:'e1', occurrences:{} }];
const CUSTOMERS = [{ id:'c1' }, { id:'c2' }];
const ROSTER = [{ id:'crew1', name:'Synthetic Crew One', role:'crew' }];
const RESOURCES = [{ id:'crew-a', recordType:'crew', name:'Synthetic Crew A', memberIds:['crew1'], leadId:'crew1', status:'active' }, { id:'crew-gone', recordType:'crew', name:'Synthetic Old Crew', memberIds:[], status:'inactive' },
  { id:'van-1', recordType:'vehicle', name:'Synthetic Van', status:'available' }, { id:'van-gone', recordType:'vehicle', name:'Synthetic Old Van', status:'retired' }];

test('the dry-run plan groups legacy series and reports every ambiguous or ended one without converting it', async () => {
  const { creates, report } = await planRecurringBackfill({ jobs:JOBS(), plans:PLANS, customers:CUSTOMERS, roster:ROSTER, resources:RESOURCES }, NOW);
  assert.deepEqual({ scanned:report.scanned, repeating:report.repeating, series:report.series }, { scanned:22, repeating:17, series:9 });
  assert.deepEqual(report.converted.map(row => [row.rootJobId, row.templateJobId, row.cadence, row.startDate, row.time, row.endTime, row.skipDates, row.notifyCustomer, row.reminderCandidate, row.crewDropped, row.crewIdDropped, row.vehicleDropped]), [
    ['a0', 'a3', 'weekly', '2026-09-30', '08:00', '10:00', ['2026-10-07'], false, true, true, false, true],
    ['g0', 'g0', 'monthly', '2026-10-31', '13:00', '15:00', [], false, false, false, true, false],
    ['h0', 'h1', 'quarterly', '2026-10-01', '08:00', '10:00', [], false, true, false, false, false],
    ['x-parent', 'orphan-x', 'weekly', '2026-10-02', '08:00', '10:00', [], false, true, false, false, false],
  ]);
  assert.deepEqual(report.converted[0].jobIds, ['a0', 'a1', 'a2', 'a3', 'a4']); assert.deepEqual(report.converted[2].jobIds, ['h0', 'h1']);
  assert.deepEqual(report.ambiguous.map(row => [row.rootJobId, row.reason]), [['b0', 'customer_mismatch'], ['c0', 'cadence_mismatch'], ['f0', 'customer_missing']]);
  assert.deepEqual(report.ended.map(row => [row.rootJobId, row.lastDate]), [['d0', '2026-08-15']]);
  assert.deepEqual(report.alreadyPlanned.map(row => row.rootJobId), ['e0']);
  const a = creates.find(row => row.rootJobId === 'a0');
  assert.equal(a.planId, await backfillPlanId('a0')); assert.equal(a.requestId, await occurrenceRequestId(a.planId, '2026-09-30', 'backfill'));
  assert.deepEqual({ ...a.plan, source:undefined }, { id:a.planId, recordType:'recurring_plan', version:1, status:'paused', customerId:'c1', customer:'Synthetic Customer', address:'100 Synthetic Street', templateJobId:'a3',
    cadence:{ frequency:'weekly' }, startDate:'2026-09-30', time:'08:00', endTime:'10:00', spanDays:0, endsOn:null, count:null, skipDates:['2026-10-07'], horizonDays:56,
    assignment:{ assignedCrew:['crew1'], crewLead:'crew1', crewId:'crew-a', vehicleId:null }, notifyCustomer:false, occurrences:{ '2026-09-30':{ jobId:'a3', state:'template', createdAt:NOW } },
    warnings:[{ code:'template_crew_inactive', message:'Some employees on the template job are no longer active and were not added to the plan.' }, { code:'template_resource_unavailable', message:'The template job\u2019s crew or vehicle is no longer available and was not added to the plan.' }], lastRun:null, source:undefined,
    pausedAt:NOW, pausedBy:BACKFILL_ACTOR, createdAt:NOW, createdBy:BACKFILL_ACTOR, updatedAt:NOW, updatedBy:BACKFILL_ACTOR, planRequestId:a.requestId });
  assert.deepEqual(creates.find(row => row.rootJobId === 'g0').plan.cadence, { frequency:'monthly', monthlyBy:'day_of_month', dayOfMonth:31 });
  // Reminders always start off; the anchor's available vehicle is kept and its inactive crew dropped.
  assert.ok(creates.every(row => row.plan.notifyCustomer === false));
  assert.deepEqual(creates.find(row => row.rootJobId === 'g0').plan.assignment, { assignedCrew:['crew1'], crewLead:'crew1', crewId:null, vehicleId:'van-1' });
  await assert.rejects(planRecurringBackfill({ jobs:[], plans:[], customers:[], roster:[] }, NOW), error => error.code === 'recurring_backfill_input_invalid', 'the crew and vehicle list is required');
  // Nothing identifying beyond ids, dates and times is reported.
  assert.equal(/Synthetic|Street|555/.test(JSON.stringify(report)), false);
  await assert.rejects(planRecurringBackfill({ jobs:null }, NOW), error => error.code === 'recurring_backfill_input_invalid');
  await assert.rejects(planRecurringBackfill({ jobs:[] }, 'not a time'), error => error.code === 'recurring_backfill_input_invalid');
});

function seeded() {
  const f = recurringFixture();
  for (const job of JOBS()) f.rows.set('jobs/' + job.id, structuredClone(job));
  f.rows.set('recurringPlans/plan_existing', { ...PLANS[0], revision:'p1', status:'active' });
  for (const row of RESOURCES) f.rows.set('dispatchResources/' + row.id, { ...structuredClone(row), revision:row.id + '-r1' });
  f.rows.set('jobs/a3', { ...f.rows.get('jobs/a3'), estimate:{ amount:145, number:'EST-A3' } });
  return f;
}

test('a dry run reads everything and writes nothing', async () => {
  const f = seeded(), before = structuredClone([...f.rows]);
  const report = await runRecurringBackfill(f.store, { now:NOW, runId:'synthetic-run' });
  assert.equal(report.mode, 'dry_run'); assert.equal(report.writes.planned, 4); assert.deepEqual(report.writes.committed, []);
  assert.deepEqual(report.series.converted.map(row => [row.rootJobId, row.priceCandidateCents]), [['a0', 14500], ['g0', null], ['h0', null], ['x-parent', null]]);
  assert.equal(f.commits.length, 0); assert.deepEqual([...f.rows], before);
});

test('apply creates paused plans with receipts once, and a resumed plan books only after its anchor', async () => {
  const f = seeded(), runId = randomUUID(), jobsBefore = structuredClone(f.all('jobs'));
  const applied = await runRecurringBackfill(f.store, { apply:true, now:NOW, runId });
  assert.equal(applied.mode, 'apply'); assert.equal(applied.aborted, undefined);
  const ids = await Promise.all(['a0', 'g0', 'h0', 'x-parent'].map(backfillPlanId));
  assert.deepEqual(applied.writes.committed, ids);
  for (const id of ids) {
    const plan = f.saved(id), receipt = f.rows.get('recurringPlanOperations/' + plan.planRequestId.toLowerCase());
    assert.equal(plan.status, 'paused'); assert.equal(plan.createdBy, BACKFILL_ACTOR);
    assert.deepEqual([receipt.action, receipt.planId, receipt.runId, receipt.actorId], ['backfill', id, runId, BACKFILL_ACTOR]);
  }
  assert.deepEqual(f.all('jobs'), jobsBefore, 'no job is changed');
  assert.equal(f.all('dispatchOperations').length, 0);
  // A rerun finds the plans and writes nothing.
  const commits = f.commits.length, rerun = await runRecurringBackfill(f.store, { apply:true, now:NOW });
  assert.equal(rerun.writes.planned, 0); assert.equal(f.commits.length, commits);
  assert.deepEqual(rerun.series.alreadyPlanned.map(row => row.rootJobId), ['a0', 'e0', 'g0', 'h0', 'x-parent']);
  // Paused plans book nothing until a manager resumes one.
  assert.deepEqual((await extendHorizon(f.store, manager, { now:NOW })).plans.filter(row => ids.includes(row.planId)), []);
  const plan = f.saved(ids[0]);
  const resumed = await f.plan({ action:'resume', planId:plan.id, expectedRevision:plan.revision });
  assert.equal(f.saved(ids[0]).updatedBy, 'zacb', 'the resuming manager becomes accountable');
  const run = await extendHorizon(f.store, manager, { now:NOW, planId:resumed.plan.id });
  assert.deepEqual(run.plans[0].created.map(job => job.date), ['2026-10-14', '2026-10-21', '2026-10-28', '2026-11-04', '2026-11-11'], 'starts after the last live legacy visit and skips the cancelled one');
  assert.deepEqual([...new Set(run.plans[0].created.map(job => `${job.crewId}|${job.vehicleId}|${job.notify}`))], ['crew-a|null|false'], 'the kept crew goes on every visit; no reminders until a manager turns them on');
});

test('a lost create response is proven by the receipt and a pre-existing plan is left untouched', async () => {
  const f = seeded(), runId = randomUUID(), commit = f.store.commit;
  let calls = 0;
  f.store.commit = async writes => { await commit(writes); if (calls++ === 0) throw Object.assign(new Error('lost'), { code:'dispatch_outcome_unknown', status:503 }); };
  const first = await runRecurringBackfill(f.store, { apply:true, now:NOW, runId });
  assert.equal(first.writes.committed.length, 4); assert.equal(first.aborted, undefined);
  const g = seeded(), existing = await backfillPlanId('g0');
  g.rows.set('recurringPlans/' + existing, { id:existing, revision:'keep', status:'ended' });
  const second = await runRecurringBackfill(g.store, { apply:true, now:NOW });
  assert.deepEqual(second.writes.alreadyExisted, [existing]); assert.equal(g.saved(existing).revision, 'keep');
  const h = seeded();
  h.store.commit = async () => { throw Object.assign(new Error('down'), { code:'dispatch_storage_unavailable', status:503 }); };
  const aborted = await runRecurringBackfill(h.store, { apply:true, now:NOW });
  assert.equal(aborted.aborted.code, 'dispatch_storage_unavailable'); assert.deepEqual(aborted.writes.committed, []);
});

test('arguments default to a dry run', () => {
  assert.deepEqual(parseArgs([]), { apply:false, report:'', help:false });
  assert.deepEqual(parseArgs(['--apply', '--report', 'out.json']), { apply:true, report:'out.json', help:false });
  assert.throws(() => parseArgs(['--apply', '--dry-run']), /either/); assert.throws(() => parseArgs(['--force']), /Unknown/); assert.throws(() => parseArgs(['--report']), /incomplete/);
});
