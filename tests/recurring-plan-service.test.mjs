import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mutateDispatch } from '../functions/_lib/dispatch-service.js';
import { extendHorizon, mutateRecurringPlan, occurrenceRequestId, recurringPlansOverview, runRecurringHorizon } from '../functions/_lib/recurring-plan-service.js';
import { recurringJobIndex } from '../functions/_lib/recurring-plan-service.js';
import { recurringPlanHandlers } from '../functions/api/recurring-plans.js';

const manager = { user:'zacb', displayName:'Owner', role:'owner', businessAccess:true };
const NOW = '2026-09-22T12:00:00.000Z';
const on = { enabled:true };

function fixture() {
  const rows = new Map([
    ['customers/c1', { id:'c1', name:'Test Customer', phone:'+1 (970) 555-0100', address:'100 Test Street', revision:'c1r' }],
    ['customers/c2', { id:'c2', name:'Other Customer', phone:'+1 (970) 555-0111', address:'200 Test Street', revision:'c2r' }],
  ]);
  let revision = 0;
  const commits = [], clone = value => structuredClone(value);
  const all = collection => [...rows.entries()].filter(([key]) => key.startsWith(collection + '/')).map(([, value]) => clone(value));
  const roster = [{ id:'zacb', name:'Owner', role:'owner' }, { id:'crew1', name:'Crew One', role:'crew' }, { id:'crew2', name:'Crew Two', role:'crew' }];
  const store = {
    jobs: async () => all('jobs'), resources: async () => all('dispatchResources'), customers: async () => all('customers'), recurringPlans: async () => all('recurringPlans'), roster: async () => clone(roster),
    read: async (collection, id) => clone(rows.get(`${collection}/${id}`) || null),
    commit: async writes => {
      const seen = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = rows.get(key);
        assert.ok(!seen.has(key), 'No duplicate writes per document'); seen.add(key);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code:'dispatch_revision_conflict', status:409 });
      }
      commits.push(writes.map(write => `${write.collection}/${write.id}`));
      for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...clone(write.patch), id:write.id, revision:`r${++revision}` });
    },
  };
  const book = async (changes = {}, extra = {}) => (await mutateDispatch(store, manager, { action:'schedule.create', requestId:randomUUID(), customerId:'c1', kind:'job', changes:{ date:'2026-09-23', time:'08:00', endTime:'10:00', assignedCrew:['crew1'], jobInstructions:'Reset the garage', ...changes }, ...extra }, NOW)).job;
  const plan = (input, now = NOW, options = on) => mutateRecurringPlan(store, manager, { requestId:randomUUID(), ...input }, now, options);
  const create = async (fields = {}) => { const template = await book(); return { template, result: await plan({ action:'create', plan:{ templateJobId:template.id, cadence:{ frequency:'weekly' }, horizonDays:28, ...fields } }) }; };
  const jobs = () => all('jobs').filter(row => row.type === 'job');
  const mutate = (input, now = NOW) => mutateDispatch(store, manager, { requestId:randomUUID(), changes:{}, ...input }, now);
  const job = id => rows.get('jobs/' + id);
  const overview = async (now = NOW) => (await recurringPlansOverview(store, manager, {}, new Date(now), on)).plans;
  return { rows, store, roster, commits, book, plan, create, jobs, mutate, job, overview };
}

test('a plan seeds its template visit and extendHorizon creates dated dispatch jobs through the canonical path', async () => {
  const f = fixture(), { template, result } = await f.create();
  assert.equal(result.plan.status, 'active'); assert.equal(result.plan.customerId, 'c1'); assert.equal(result.plan.time, '08:00'); assert.deepEqual([...result.plan.assignment.assignedCrew], ['crew1']);
  assert.deepEqual(result.plan.occurrences.map(row => [row.date, row.state, row.jobId]), [['2026-09-23', 'template', template.id]]);
  const run = await extendHorizon(f.store, manager, { now:NOW });
  assert.deepEqual(run.plans[0].created.map(job => job.date), ['2026-09-30', '2026-10-07', '2026-10-14']);
  assert.equal(run.complete, true);
  for (const job of run.plans[0].created) {
    const raw = f.rows.get('jobs/' + job.id), requestId = await occurrenceRequestId(result.plan.id, job.date);
    assert.equal(raw.recurringPlanId, result.plan.id); assert.equal(raw.occurrenceDate, job.date); assert.equal(raw.sourceTemplateJobId, template.id);
    assert.equal(raw.dispatchRequestId, requestId); assert.ok(f.rows.get('dispatchOperations/' + requestId)); assert.equal(raw.recurrence, 'none');
    assert.equal(raw.scheduleSource, 'egc_hub'); assert.equal(raw.startAt, job.date + 'T14:00:00.000Z'); assert.deepEqual(raw.assignedCrew, ['crew1']);
    assert.equal(raw.notify, false, 'generated visits send no customer reminders unless the plan opts in');
    assert.equal(f.rows.get(`jobs/_egc_schedule_lock_${job.date}`).entries.length, 1);
  }
  const saved = f.rows.get('recurringPlans/' + result.plan.id);
  assert.deepEqual(Object.keys(saved.occurrences).sort(), ['2026-09-23', '2026-09-30', '2026-10-07', '2026-10-14']);
  assert.equal(saved.lastRun.status, 'ok');
});

test('occurrence request IDs are deterministic UUIDs accepted by every dispatch guard', async () => {
  const a = await occurrenceRequestId('plan_x', '2026-10-01'), b = await occurrenceRequestId('plan_x', '2026-10-01');
  assert.equal(a, b); assert.notEqual(a, await occurrenceRequestId('plan_x', '2026-10-08')); assert.notEqual(a, await occurrenceRequestId('plan_x', '2026-10-01', 'unscheduled'));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('rerunning the horizon is idempotent: no new jobs, receipts or commits', async () => {
  const f = fixture(), { result } = await f.create();
  await extendHorizon(f.store, manager, { now:NOW });
  const before = { jobs:f.jobs().length, commits:f.commits.length };
  const again = await extendHorizon(f.store, manager, { now:NOW });
  assert.equal(again.plans[0].created.length, 0); assert.equal(again.complete, true);
  assert.equal(f.jobs().length, before.jobs); assert.equal(f.commits.length, before.commits);
  const later = await extendHorizon(f.store, manager, { now:'2026-09-29T12:00:00.000Z' });
  assert.deepEqual(later.plans[0].created.map(job => job.date), ['2026-10-21']);
  assert.equal(Object.keys(f.rows.get('recurringPlans/' + result.plan.id).occurrences).length, 5);
});

test('concurrent horizon runs by different actors never duplicate an occurrence', async () => {
  const f = fixture(), { result } = await f.create(), other = { user:'alexk', role:'manager', businessAccess:true };
  const runs = await Promise.allSettled([extendHorizon(f.store, manager, { now:NOW }), extendHorizon(f.store, other, { now:NOW }), extendHorizon(f.store, manager, { now:NOW })]);
  assert.ok(runs.some(run => run.status === 'fulfilled'));
  await extendHorizon(f.store, manager, { now:NOW });
  const dates = f.jobs().filter(job => job.recurringPlanId === result.plan.id).map(job => job.occurrenceDate).sort();
  assert.deepEqual(dates, ['2026-09-30', '2026-10-07', '2026-10-14']);
});

test('a lost commit response replays the deterministic request instead of duplicating', async () => {
  const f = fixture(), { result } = await f.create({ horizonDays:10 }), commit = f.store.commit;
  f.store.commit = async writes => { await commit(writes); if (writes.some(write => write.collection === 'recurringPlans')) throw new Error('Lost response'); };
  const run = await extendHorizon(f.store, manager, { now:NOW });
  f.store.commit = commit;
  assert.deepEqual(run.plans[0].created.map(job => job.date), ['2026-09-30']);
  assert.equal(f.jobs().filter(job => job.recurringPlanId === result.plan.id).length, 1);
});

test('a conflicting date becomes an unscheduled occurrence flagged recurrenceConflict with a plan warning', async () => {
  const f = fixture(), { result } = await f.create();
  const busy = await f.book({ date:'2026-10-07', time:'09:00', endTime:'11:00' }, { customerId:'c2' });
  const run = await extendHorizon(f.store, manager, { now:NOW });
  assert.deepEqual(run.plans[0].created.map(job => job.date || 'unscheduled'), ['2026-09-30', 'unscheduled', '2026-10-14']);
  assert.equal(run.plans[0].conflicts.length, 1); assert.equal(run.plans[0].conflicts[0].date, '2026-10-07'); assert.equal(run.plans[0].conflicts[0].code, 'dispatch_conflict');
  const conflict = f.rows.get('jobs/' + run.plans[0].conflicts[0].jobId);
  assert.equal(conflict.status, 'unscheduled'); assert.equal(conflict.date, ''); assert.equal(conflict.occurrenceDate, '2026-10-07');
  assert.equal(conflict.recurrenceConflict.date, '2026-10-07'); assert.equal(conflict.recurrenceConflict.time, '08:00'); assert.equal(conflict.recurrenceConflict.conflicts[0].otherJobId, busy.id);
  assert.match(conflict.opsNotes, /Recurring visit for 2026-10-07/);
  assert.equal(conflict.dispatchRequestId, await occurrenceRequestId(result.plan.id, '2026-10-07', 'unscheduled'));
  const saved = f.rows.get('recurringPlans/' + result.plan.id);
  assert.equal(saved.occurrences['2026-10-07'].state, 'conflict'); assert.equal(saved.warnings.at(-1).code, 'recurrence_conflict');
  const overview = await recurringPlansOverview(f.store, manager, {}, new Date(NOW), on);
  assert.deepEqual(overview.plans[0].attention.map(row => row.date), ['2026-10-07']);
  const before = f.jobs().length;
  assert.equal((await extendHorizon(f.store, manager, { now:NOW })).plans[0].created.length, 0); assert.equal(f.jobs().length, before);
});

test('invalid daylight-saving wall times are saved unscheduled for review instead of guessed', async () => {
  const f = fixture(), start = '2027-03-01T12:00:00.000Z';
  const template = (await mutateDispatch(f.store, manager, { action:'schedule.create', requestId:randomUUID(), customerId:'c1', kind:'job', changes:{ date:'2027-03-07', time:'02:30', endTime:'04:00', assignedCrew:['crew1'] } }, start)).job;
  const { plan } = await f.plan({ action:'create', plan:{ templateJobId:template.id, cadence:{ frequency:'weekly' }, horizonDays:14 } }, start);
  const run = await extendHorizon(f.store, manager, { now:start });
  assert.deepEqual(run.plans[0].conflicts.map(row => [row.date, row.code]), [['2027-03-14', 'dispatch_time_invalid']]);
  assert.equal(f.rows.get('recurringPlans/' + plan.id).occurrences['2027-03-14'].state, 'conflict');
});

test('an existing booking at the exact occurrence time is adopted rather than duplicated', async () => {
  const f = fixture(), { result } = await f.create();
  const existing = await f.book({ date:'2026-10-14', time:'08:00', endTime:'10:00' });
  const run = await extendHorizon(f.store, manager, { now:NOW });
  assert.deepEqual(run.plans[0].adopted, [{ date:'2026-10-14', jobId:existing.id }]);
  assert.equal(f.rows.get('recurringPlans/' + result.plan.id).occurrences['2026-10-14'].state, 'existing');
  assert.equal(f.jobs().filter(job => job.date === '2026-10-14').length, 1);
});

// Every future series date inside the horizon ends with a live visit for the customer or an attention row; never an adopted cancelled or null job.
async function assertServedOrFlagged(f, planId, dates) {
  const plan = (await f.overview()).find(row => row.id === planId), saved = f.rows.get('recurringPlans/' + planId);
  for (const [date, entry] of Object.entries(saved.occurrences)) if (entry.state === 'existing') { assert.ok(entry.jobId, `${date} adopted without a job`); assert.ok(!['cancelled','canceled'].includes(f.job(entry.jobId).status), `${date} adopted a cancelled job`); }
  for (const date of dates) {
    const live = f.jobs().some(job => job.customerId === plan.customerId && job.date === date && !['cancelled','canceled'].includes(job.status));
    assert.ok(live || plan.attention.some(row => row.date === date), `${date} has neither a live visit nor an attention row`);
  }
  return plan;
}

test('a cancelled booking still holding the slot becomes an unscheduled conflict, never an adopted visit', async () => {
  const f = fixture(), { result } = await f.create();
  const booked = await f.book({ date:'2026-10-14', time:'08:00', endTime:'10:00' });
  await f.mutate({ action:'schedule.cancel', jobId:booked.id, expectedRevision:booked.revision });
  const run = await extendHorizon(f.store, manager, { now:NOW });
  assert.deepEqual(run.plans[0].adopted, []); assert.equal(run.complete, true);
  assert.deepEqual(run.plans[0].conflicts.map(row => [row.date, row.code]), [['2026-10-14', 'recurring_slot_taken']]);
  const entry = f.rows.get('recurringPlans/' + result.plan.id).occurrences['2026-10-14'], held = f.job(entry.jobId);
  assert.equal(entry.state, 'conflict'); assert.notEqual(entry.jobId, booked.id);
  assert.equal(held.status, 'unscheduled'); assert.equal(held.date, ''); assert.equal(held.recurrenceConflict.code, 'recurring_slot_taken'); assert.match(held.opsNotes, /cancelled or moved booking still holds this time/);
  assert.equal(f.rows.get('recurringPlans/' + result.plan.id).warnings.at(-1).reason, 'recurring_slot_taken');
  const plan = await assertServedOrFlagged(f, result.plan.id, ['2026-09-30', '2026-10-07', '2026-10-14']);
  assert.deepEqual(plan.attention.map(row => [row.date, row.state, row.code]), [['2026-10-14', 'conflict', 'recurring_slot_taken']]);
  assert.equal(plan.upcoming.find(row => row.date === '2026-10-14').state, 'conflict');
  const before = f.jobs().length;
  assert.equal((await extendHorizon(f.store, manager, { now:NOW })).plans[0].created.length, 0); assert.equal(f.jobs().length, before);
});

test('a booking rescheduled away from the slot never records an empty existing occurrence', async () => {
  const f = fixture(), { result } = await f.create();
  const booked = await f.book({ date:'2026-10-14', time:'08:00', endTime:'10:00' });
  await f.mutate({ action:'schedule.update', jobId:booked.id, expectedRevision:booked.revision, changes:{ date:'2026-10-16', endDate:'2026-10-16', time:'08:00', endTime:'10:00' } });
  const run = await extendHorizon(f.store, manager, { now:NOW });
  assert.deepEqual(run.plans[0].adopted, []);
  assert.deepEqual(run.plans[0].conflicts.map(row => [row.date, row.code]), [['2026-10-14', 'recurring_slot_taken']]);
  const entry = f.rows.get('recurringPlans/' + result.plan.id).occurrences['2026-10-14'];
  assert.equal(entry.state, 'conflict'); assert.ok(entry.jobId); assert.equal(f.job(booked.id).date, '2026-10-16');
  const plan = await assertServedOrFlagged(f, result.plan.id, ['2026-09-30', '2026-10-07', '2026-10-14']);
  assert.deepEqual(plan.attention.map(row => row.date), ['2026-10-14']);
});

test('ending a plan, cancelling its visits and recreating it at the same time flags every held date for review', async () => {
  const f = fixture(), { template, result } = await f.create();
  await extendHorizon(f.store, manager, { now:NOW });
  const old = f.rows.get('recurringPlans/' + result.plan.id);
  await f.plan({ action:'end', planId:result.plan.id, expectedRevision:old.revision });
  for (const date of ['2026-09-30', '2026-10-07', '2026-10-14']) { const job = f.job(old.occurrences[date].jobId); await f.mutate({ action:'schedule.cancel', jobId:job.id, expectedRevision:job.revision }); }
  const { plan:next } = await f.plan({ action:'create', plan:{ templateJobId:template.id, cadence:{ frequency:'weekly' }, horizonDays:28, assignment:{ assignedCrew:['crew2'] } } });
  const run = await extendHorizon(f.store, manager, { now:NOW, planId:next.id });
  assert.deepEqual(run.plans[0].adopted, []); assert.deepEqual(run.plans[0].created.map(job => job.date), ['', '', '']);
  assert.deepEqual(run.plans[0].conflicts.map(row => row.code), ['recurring_slot_taken', 'recurring_slot_taken', 'recurring_slot_taken']);
  const plan = await assertServedOrFlagged(f, next.id, ['2026-09-30', '2026-10-07', '2026-10-14']);
  assert.deepEqual(plan.attention.map(row => row.date), ['2026-09-30', '2026-10-07', '2026-10-14']);
  const ended = (await f.overview()).find(row => row.id === result.plan.id);
  assert.deepEqual(ended.attention, [], 'cancelling an ended plan’s visits is the intended cleanup');
  assert.deepEqual(ended.occurrences.filter(row => row.date > '2026-09-23').map(row => row.state), ['cancelled', 'cancelled', 'cancelled']);
  // Restoring the old booking and cancelling the unscheduled duplicate leaves the date served and clear.
  const restored = f.job(old.occurrences['2026-09-30'].jobId), duplicate = f.job(f.rows.get('recurringPlans/' + next.id).occurrences['2026-09-30'].jobId);
  await f.mutate({ action:'schedule.restore', jobId:restored.id, expectedRevision:restored.revision });
  await f.mutate({ action:'schedule.cancel', jobId:duplicate.id, expectedRevision:duplicate.revision });
  const after = (await f.overview()).find(row => row.id === next.id);
  assert.equal(after.occurrences.find(row => row.date === '2026-09-30').state, 'covered');
  assert.deepEqual(after.attention.map(row => row.date), ['2026-10-07', '2026-10-14']);
});

test('the plan view reconciles generated visits with Dispatch: cancelled, moved, rescheduled and completed', async () => {
  const f = fixture(), { result } = await f.create({ horizonDays:35 });
  await f.book({ date:'2026-10-21', time:'09:00', endTime:'11:00' }, { customerId:'c2' });
  await extendHorizon(f.store, manager, { now:NOW });
  const index = () => f.rows.get('recurringPlans/' + result.plan.id).occurrences, visit = date => f.job(index()[date].jobId);
  let plan = (await f.overview())[0];
  assert.equal(plan.reconciled, true); assert.deepEqual(plan.attention.map(row => [row.date, row.state]), [['2026-10-21', 'conflict']]);
  const cancelled = visit('2026-09-30'), moved = visit('2026-10-07'), conflict = visit('2026-10-21');
  await f.mutate({ action:'schedule.cancel', jobId:cancelled.id, expectedRevision:cancelled.revision });
  await f.mutate({ action:'schedule.update', jobId:moved.id, expectedRevision:moved.revision, changes:{ date:'2026-10-08', endDate:'2026-10-08', time:'08:00', endTime:'10:00' } });
  await f.mutate({ action:'schedule.update', jobId:conflict.id, expectedRevision:conflict.revision, changes:{ date:'2026-10-22', endDate:'2026-10-22', time:'08:00', endTime:'10:00' } });
  plan = (await f.overview())[0];
  const state = date => plan.occurrences.find(row => row.date === date);
  assert.deepEqual([state('2026-09-30').state, state('2026-09-30').recorded], ['cancelled', 'scheduled']);
  assert.deepEqual([state('2026-10-07').state, state('2026-10-07').movedTo], ['moved', '2026-10-08']);
  assert.deepEqual([state('2026-10-21').state, state('2026-10-21').movedTo], ['rescheduled', '2026-10-22']);
  assert.equal(plan.upcoming.find(row => row.date === '2026-09-30').state, 'cancelled', 'a cancelled visit is never shown as scheduled');
  assert.deepEqual(plan.attention.map(row => [row.date, row.state]), [['2026-09-30', 'cancelled']]);
  // Skipping the cancelled date is how a manager records that the customer is skipping it.
  const skipped = await f.plan({ action:'update', planId:plan.id, expectedRevision:plan.revision, plan:{ skipDates:['2026-09-30'] } });
  assert.deepEqual(skipped.warnings.map(row => row.code), ['generated_visits_unchanged'], 'a cancelled visit on a skipped date needs no warning');
  assert.deepEqual((await f.overview())[0].attention, []);
  // Past visits closed in Dispatch show their outcome; a deleted job is flagged while still ahead.
  f.rows.set('jobs/' + visit('2026-10-14').id, { ...visit('2026-10-14'), status:'completed', pipelineStatus:'completed' });
  f.rows.delete('jobs/' + visit('2026-10-21').id);
  plan = (await f.overview())[0];
  assert.equal(plan.occurrences.find(row => row.date === '2026-10-14').state, 'completed');
  assert.deepEqual(plan.attention.map(row => [row.date, row.state]), [['2026-10-21', 'missing']]);
  const { byId, served } = recurringJobIndex(await f.store.jobs());
  assert.ok(!byId.has('_egc_schedule_lock_2026-09-30')); assert.equal(served.get('c1').has('2026-09-30'), false); assert.equal(served.get('c1').has('2026-10-08'), true);
});

test('an update that moves the series names every already-booked visit it no longer matches', async () => {
  const f = fixture(), { result } = await f.create();
  await extendHorizon(f.store, manager, { now:NOW });
  let current = f.rows.get('recurringPlans/' + result.plan.id);
  const shifted = await f.plan({ action:'update', planId:result.plan.id, expectedRevision:current.revision, plan:{ startDate:'2026-09-24' } });
  const off = shifted.warnings.find(row => row.code === 'generated_visits_off_pattern');
  assert.ok(off, 'weekday shift must warn about the old visits');
  assert.deepEqual(off.visits.map(row => row.date), ['2026-09-23', '2026-09-30', '2026-10-07', '2026-10-14']);
  assert.deepEqual(off.visits.map(row => row.jobId), ['2026-09-23', '2026-09-30', '2026-10-07', '2026-10-14'].map(date => current.occurrences[date].jobId));
  assert.match(off.message, /^4 visits already on the schedule no longer match this plan and were NOT removed: 2026-09-23, 2026-09-30, 2026-10-07, 2026-10-14\. Cancel them in Dispatch/);
  assert.deepEqual(shifted.warnings.map(row => row.code), ['generated_visits_off_pattern', 'generated_visits_unchanged']);
  const run = await extendHorizon(f.store, manager, { now:NOW });
  assert.deepEqual(run.plans[0].created.map(job => job.date), ['2026-09-24', '2026-10-01', '2026-10-08', '2026-10-15']);
  let plan = (await f.overview())[0];
  assert.deepEqual(plan.attention.map(row => [row.date, row.state]), [['2026-09-23', 'off_pattern'], ['2026-09-30', 'off_pattern'], ['2026-10-07', 'off_pattern'], ['2026-10-14', 'off_pattern']]);
  for (const date of ['2026-09-30', '2026-10-07']) { const job = f.job(current.occurrences[date].jobId); await f.mutate({ action:'schedule.cancel', jobId:job.id, expectedRevision:job.revision }); }
  plan = (await f.overview())[0];
  assert.deepEqual(plan.attention.map(row => row.date), ['2026-09-23', '2026-10-14'], 'cancelled off-pattern visits leave the list');
  // Shrinking the end date is reported the same way; visits already cancelled are not.
  current = f.rows.get('recurringPlans/' + result.plan.id);
  const shorter = await f.plan({ action:'update', planId:result.plan.id, expectedRevision:current.revision, plan:{ endsOn:'2026-10-02' } });
  assert.deepEqual(shorter.warnings.find(row => row.code === 'generated_visits_off_pattern').visits.map(row => row.date), ['2026-09-23', '2026-10-08', '2026-10-14', '2026-10-15']);
});

test('an update that lands mid-run applies to the rest of that run', async () => {
  const f = fixture(), { result } = await f.create(), commit = f.store.commit;
  let updated = false;
  f.store.commit = async writes => {
    await commit(writes);
    if (updated || !writes.some(write => write.collection === 'recurringPlans' && write.patch.occurrences)) return;
    updated = true;
    const current = f.rows.get('recurringPlans/' + result.plan.id);
    await f.plan({ action:'update', planId:result.plan.id, expectedRevision:current.revision, plan:{ skipDates:['2026-10-07'] } });
  };
  const run = await extendHorizon(f.store, manager, { now:NOW });
  f.store.commit = commit;
  assert.equal(updated, true);
  assert.deepEqual(run.plans[0].created.map(job => job.date), ['2026-09-30', '2026-10-14']);
  assert.equal(f.jobs().some(job => job.date === '2026-10-07'), false);
  assert.equal(f.rows.get('recurringPlans/' + result.plan.id).occurrences['2026-10-07'], undefined);
});

test('a saved request still replays after the feature flag is turned off', async () => {
  const f = fixture(), template = await f.book(), commit = f.store.commit, input = { action:'create', requestId:randomUUID(), plan:{ templateJobId:template.id, cadence:{ frequency:'weekly' } } };
  f.store.commit = async writes => { await commit(writes); throw Object.assign(new Error('lost'), { code:'dispatch_outcome_unknown', status:503 }); };
  await mutateRecurringPlan(f.store, manager, input, NOW, on).catch(() => null);
  f.store.commit = commit;
  const replayed = await mutateRecurringPlan(f.store, manager, input, NOW, { enabled:false });
  assert.equal(replayed.replayed, true); assert.equal(replayed.plan.status, 'active');
  const extend = { action:'extend', requestId:randomUUID(), planId:replayed.plan.id, expectedRevision:replayed.plan.revision };
  const first = await mutateRecurringPlan(f.store, manager, extend, NOW, on);
  const again = await mutateRecurringPlan(f.store, manager, extend, NOW, { enabled:false });
  assert.equal(again.replayed, true); assert.deepEqual(again.created.map(job => job.id), first.created.map(job => job.id));
  await assert.rejects(mutateRecurringPlan(f.store, manager, { ...extend, requestId:randomUUID() }, NOW, { enabled:false }), error => error.code === 'recurring_disabled' && error.status === 404);
});

test('plan-level dispatch failures block the run and record why without creating work', async () => {
  const f = fixture(), { result } = await f.create();
  f.roster.splice(1, 1);
  const run = await extendHorizon(f.store, manager, { now:NOW });
  assert.equal(run.plans[0].blocked.code, 'dispatch_employee_inactive'); assert.equal(run.plans[0].created.length, 0); assert.equal(run.complete, false);
  const saved = f.rows.get('recurringPlans/' + result.plan.id);
  assert.equal(saved.lastRun.status, 'blocked'); assert.equal(saved.warnings.at(-1).code, 'plan_blocked');
  f.roster.splice(1, 0, { id:'crew1', name:'Crew One', role:'crew' });
  const repaired = await extendHorizon(f.store, manager, { now:NOW });
  assert.equal(repaired.plans[0].created.length, 3); assert.equal(f.rows.get('recurringPlans/' + result.plan.id).lastRun.status, 'ok');
});

test('limit bounds each run and the next run continues where it stopped', async () => {
  const f = fixture(); await f.create();
  const first = await extendHorizon(f.store, manager, { now:NOW, limit:2 });
  assert.equal(first.plans[0].created.length, 2); assert.equal(first.complete, false);
  const second = await extendHorizon(f.store, manager, { now:NOW, limit:2 });
  assert.deepEqual(second.plans[0].created.map(job => job.date), ['2026-10-14']); assert.equal(second.complete, true);
});

test('pause stops generation, resume continues, end is terminal; all require the reviewed revision', async () => {
  const f = fixture(), { result } = await f.create();
  const paused = await f.plan({ action:'pause', planId:result.plan.id, expectedRevision:result.plan.revision });
  assert.equal(paused.plan.status, 'paused'); assert.equal(paused.warnings[0].code, 'generated_visits_unchanged');
  assert.equal((await extendHorizon(f.store, manager, { now:NOW })).plans.length, 0);
  await assert.rejects(f.plan({ action:'resume', planId:result.plan.id, expectedRevision:result.plan.revision }), error => error.code === 'recurring_revision_conflict' && error.status === 409);
  await assert.rejects(f.plan({ action:'pause', planId:result.plan.id, expectedRevision:paused.plan.revision }), error => error.code === 'recurring_state_invalid');
  const resumed = await f.plan({ action:'resume', planId:result.plan.id, expectedRevision:paused.plan.revision });
  assert.equal((await extendHorizon(f.store, manager, { now:NOW })).plans[0].created.length, 3);
  const current = f.rows.get('recurringPlans/' + result.plan.id);
  const ended = await f.plan({ action:'end', planId:result.plan.id, expectedRevision:current.revision });
  assert.equal(ended.plan.status, 'ended'); assert.deepEqual(ended.plan.upcoming, []); assert.equal(resumed.plan.status, 'active');
  await assert.rejects(f.plan({ action:'update', planId:result.plan.id, expectedRevision:ended.plan.revision, plan:{ time:'09:00' } }), error => error.code === 'recurring_state_invalid');
  assert.equal(f.jobs().filter(job => job.status === 'cancelled').length, 0);
});

test('update validates the merged schedule, keeps generated visits and warns about already scheduled skips', async () => {
  const f = fixture(), { result } = await f.create();
  await extendHorizon(f.store, manager, { now:NOW });
  let current = f.rows.get('recurringPlans/' + result.plan.id);
  await assert.rejects(f.plan({ action:'update', planId:result.plan.id, expectedRevision:current.revision, plan:{ time:'11:00', endTime:'10:00' } }), error => error.code === 'recurring_time_invalid');
  await assert.rejects(f.plan({ action:'update', planId:result.plan.id, expectedRevision:current.revision, plan:{ assignment:{ assignedCrew:['nobody'] } } }), error => error.code === 'recurring_employee_inactive');
  await assert.rejects(f.plan({ action:'update', planId:result.plan.id, expectedRevision:current.revision, plan:{ templateJobId:'other' } }), error => error.code === 'recurring_field_invalid');
  const updated = await f.plan({ action:'update', planId:result.plan.id, expectedRevision:current.revision, plan:{ time:'13:00', endTime:'15:00', skipDates:['2026-10-07', '2026-10-28'], cadence:{ frequency:'every_n_weeks', intervalWeeks:1 } } });
  assert.deepEqual(updated.warnings.map(row => row.code), ['skip_date_already_scheduled', 'generated_visits_unchanged']);
  assert.equal(updated.plan.cadenceLabel, 'Every week'); assert.equal(updated.plan.occurrences.length, 4);
  current = f.rows.get('recurringPlans/' + result.plan.id);
  assert.equal(current.time, '13:00'); assert.equal(f.rows.get('jobs/' + current.occurrences['2026-10-07'].jobId).time, '08:00');
  const run = await extendHorizon(f.store, manager, { now:'2026-10-20T12:00:00.000Z' });
  assert.deepEqual(run.plans[0].created.map(job => [job.date, job.time]), [['2026-10-21', '13:00'], ['2026-11-04', '13:00'], ['2026-11-11', '13:00']]);
});

test('create uses the template customer, crew and times; rejects foreign or non-operational templates', async () => {
  const f = fixture(), template = await f.book({ assignedCrew:['crew1', 'crew2'], crewLead:'crew2' });
  const { plan } = await f.plan({ action:'create', plan:{ templateJobId:template.id, cadence:{ frequency:'monthly', monthlyBy:'nth_weekday' } } });
  assert.deepEqual(plan.assignment, { assignedCrew:['crew1', 'crew2'], crewLead:'crew2', crewId:null, vehicleId:null });
  assert.deepEqual(plan.cadence, { frequency:'monthly', monthlyBy:'nth_weekday', nth:4, weekday:3 }); assert.equal(plan.cadenceLabel, 'Monthly on the 4th Wednesday');
  assert.equal(plan.horizonDays, 56); assert.equal(plan.customer, 'Test Customer');
  const walkthrough = (await mutateDispatch(f.store, manager, { action:'schedule.create', requestId:randomUUID(), customerId:'c1', kind:'walkthrough', changes:{ date:'2026-09-24', time:'08:00', endTime:'09:00' } }, NOW)).job;
  await assert.rejects(f.plan({ action:'create', plan:{ templateJobId:walkthrough.id, cadence:{ frequency:'weekly' } } }), error => error.code === 'recurring_template_invalid');
  await assert.rejects(f.plan({ action:'create', plan:{ templateJobId:'missing', cadence:{ frequency:'weekly' } } }), error => error.code === 'recurring_template_invalid');
  await assert.rejects(f.plan({ action:'create', plan:{ templateJobId:template.id, cadence:{ frequency:'daily' } } }), error => error.code === 'recurring_cadence_invalid');
  await assert.rejects(f.plan({ action:'create', plan:{ templateJobId:template.id, cadence:{ frequency:'weekly' }, customerId:'c2' } }), error => error.code === 'recurring_field_invalid');
});

test('customer reminders for generated visits are an explicit, validated plan choice', async () => {
  const f = fixture(), template = await f.book({ notify:true });
  const { plan } = await f.plan({ action:'create', plan:{ templateJobId:template.id, cadence:{ frequency:'weekly' }, horizonDays:14, notifyCustomer:true } });
  assert.equal(plan.notifyCustomer, true);
  const run = await extendHorizon(f.store, manager, { now:NOW });
  assert.equal(f.rows.get('jobs/' + run.plans[0].created[0].id).notify, true);
  const off = await f.plan({ action:'update', planId:plan.id, expectedRevision:f.rows.get('recurringPlans/' + plan.id).revision, plan:{ notifyCustomer:false } });
  assert.equal(off.plan.notifyCustomer, false);
  await assert.rejects(f.plan({ action:'update', planId:plan.id, expectedRevision:off.plan.revision, plan:{ notifyCustomer:'yes' } }), error => error.code === 'recurring_field_invalid');
  const other = await f.book({ date:'2026-09-24', notify:true }), { plan:quiet } = await f.plan({ action:'create', plan:{ templateJobId:other.id, cadence:{ frequency:'weekly' }, horizonDays:14 } });
  assert.equal(quiet.notifyCustomer, false);
});

test('create and state changes replay by request ID and reject reused IDs with different bodies', async () => {
  const f = fixture(), template = await f.book(), input = { action:'create', requestId:randomUUID(), plan:{ templateJobId:template.id, cadence:{ frequency:'biweekly' } } };
  const first = await mutateRecurringPlan(f.store, manager, input, NOW, on), again = await mutateRecurringPlan(f.store, manager, input, NOW, on);
  assert.equal(again.replayed, true); assert.equal(again.plan.id, first.plan.id); assert.equal(f.rows.size, [...f.rows.keys()].length);
  assert.equal([...f.rows.keys()].filter(key => key.startsWith('recurringPlans/')).length, 1);
  await assert.rejects(mutateRecurringPlan(f.store, manager, { ...input, plan:{ ...input.plan, cadence:{ frequency:'weekly' } } }, NOW, on), error => error.code === 'recurring_idempotency_conflict');
  const pause = { action:'pause', requestId:randomUUID(), planId:first.plan.id, expectedRevision:first.plan.revision };
  await mutateRecurringPlan(f.store, manager, pause, NOW, on);
  const current = f.rows.get('recurringPlans/' + first.plan.id);
  await mutateRecurringPlan(f.store, manager, { action:'resume', requestId:randomUUID(), planId:first.plan.id, expectedRevision:current.revision }, NOW, on);
  await assert.rejects(mutateRecurringPlan(f.store, manager, pause, NOW, on), error => error.code === 'recurring_changed_since_operation');
});

test('a lost save response is verified from the receipt on retry', async () => {
  const f = fixture(), template = await f.book(), commit = f.store.commit, input = { action:'create', requestId:randomUUID(), plan:{ templateJobId:template.id, cadence:{ frequency:'weekly' } } };
  f.store.commit = async writes => { await commit(writes); throw Object.assign(new Error('lost'), { code:'dispatch_outcome_unknown', status:503 }); };
  const saved = await mutateRecurringPlan(f.store, manager, input, NOW, on);
  f.store.commit = commit;
  assert.equal(saved.plan.status, 'active'); assert.equal((await mutateRecurringPlan(f.store, manager, input, NOW, on)).replayed, true);
});

test('extend requests are bounded, resumable after a partial run and replay from their receipt', async () => {
  const f = fixture(), { result } = await f.create({ horizonDays:56 });
  const input = { action:'extend', requestId:randomUUID(), planId:result.plan.id, expectedRevision:result.plan.revision, limit:3 };
  const commit = f.store.commit;
  let lose = true;
  f.store.commit = async writes => { if (lose && writes.some(write => write.collection === 'recurringPlanOperations')) { lose = false; throw Object.assign(new Error('lost'), { code:'dispatch_outcome_unknown', status:503 }); } return commit(writes); };
  await assert.rejects(mutateRecurringPlan(f.store, manager, input, NOW, on), error => error.code === 'recurring_outcome_unknown');
  const retried = await mutateRecurringPlan(f.store, manager, input, NOW, on);
  assert.deepEqual(retried.created.map(job => job.date), ['2026-09-30', '2026-10-07', '2026-10-14']); assert.equal(retried.complete, false);
  assert.equal(f.jobs().filter(job => job.recurringPlanId === result.plan.id).length, 3);
  const replayed = await mutateRecurringPlan(f.store, manager, input, NOW, on);
  assert.equal(replayed.replayed, true);
  let plan = retried.plan, total = 3;
  while (true) {
    const next = await mutateRecurringPlan(f.store, manager, { action:'extend', requestId:randomUUID(), planId:plan.id, expectedRevision:plan.revision, limit:3 }, NOW, on);
    total += next.created.length; plan = next.plan;
    if (next.complete) break;
  }
  assert.equal(total, 7); assert.equal(f.jobs().filter(job => job.recurringPlanId === result.plan.id).length, 7);
  await assert.rejects(mutateRecurringPlan(f.store, manager, { action:'extend', requestId:randomUUID(), planId:plan.id, expectedRevision:result.plan.revision }, NOW, on), error => error.code === 'recurring_revision_conflict');
});

test('the feature flag blocks new plans and generation but still allows pausing or ending', async () => {
  const f = fixture(), { result } = await f.create();
  const template = await f.book({ date:'2026-09-24' });
  await assert.rejects(f.plan({ action:'create', plan:{ templateJobId:template.id, cadence:{ frequency:'weekly' } } }, NOW, { enabled:false }), error => error.code === 'recurring_disabled' && error.status === 404);
  await assert.rejects(f.plan({ action:'extend', planId:result.plan.id, expectedRevision:result.plan.revision }, NOW, { enabled:false }), error => error.code === 'recurring_disabled');
  assert.equal((await f.plan({ action:'end', planId:result.plan.id, expectedRevision:result.plan.revision }, NOW, { enabled:false })).plan.status, 'ended');
  let touched = false;
  assert.deepEqual(await runRecurringHorizon({}, { actor:manager, now:NOW, storage:() => { touched = true; return f.store; } }), { ok:true, enabled:false, plans:[], complete:true });
  assert.equal(touched, false);
  const enabled = await runRecurringHorizon({ EGC_RECURRING_PLANS_ENABLED:'true' }, { actor:manager, now:NOW, storage:() => f.store });
  assert.equal(enabled.enabled, true); assert.equal(enabled.plans.length, 0);
});

test('only dispatchers can read or change plans or extend the horizon', async () => {
  const f = fixture(), crew = { user:'crew1', role:'crew', businessAccess:false };
  await assert.rejects(recurringPlansOverview(f.store, null, {}, new Date(NOW), on), error => error.status === 401);
  await assert.rejects(recurringPlansOverview(f.store, crew, {}, new Date(NOW), on), error => error.status === 403);
  await assert.rejects(extendHorizon(f.store, crew, { now:NOW }), error => error.code === 'dispatch_forbidden');
  await assert.rejects(extendHorizon(f.store, manager, { now:'yesterday' }), error => error.code === 'recurring_clock_invalid');
});

function http(f, { enabled = true, user = manager } = {}) {
  const handlers = recurringPlanHandlers({ session: async () => user, storage: () => f.store, now: () => new Date(NOW) });
  const env = enabled ? { EGC_RECURRING_PLANS_ENABLED:'true' } : {};
  const get = query => handlers.get({ request:new Request('https://easygaragecleaning.com/api/recurring-plans' + query), env });
  const post = (body, headers = {}) => handlers.post({ request:new Request('https://easygaragecleaning.com/api/recurring-plans', { method:'POST', headers:{ Origin:'https://easygaragecleaning.com', 'Content-Type':'application/json', ...headers }, body:typeof body === 'string' ? body : JSON.stringify(body) }), env });
  return { get, post };
}

test('HTTP API reports the flag, lists plans and enforces the dispatch request contract', async () => {
  const f = fixture(), { result } = await f.create(), api = http(f), off = http(f, { enabled:false });
  const status = await (await off.get('?view=status')).json();
  assert.deepEqual(status, { ok:true, enabled:false, viewer:{ id:'zacb' } });
  const list = await api.get('');
  assert.equal(list.headers.get('Cache-Control'), 'no-store'); assert.equal(list.headers.get('X-Content-Type-Options'), 'nosniff');
  const body = await list.json();
  assert.equal(body.enabled, true); assert.equal(body.plans[0].id, result.plan.id); assert.deepEqual(body.plans[0].upcoming.map(row => row.date).slice(0, 2), ['2026-09-23', '2026-09-30']);
  assert.equal(body.coverage.complete, true); assert.ok(Array.isArray(body.roster));
  assert.equal((await api.get('?view=status&view=plans')).status, 400);
  assert.equal((await api.get('?q=x')).status, 400);
  assert.equal((await api.get('?planId=missing')).status, 404);
  assert.equal((await api.post({}, { Origin:'https://evil.example' })).status, 403);
  assert.equal((await api.post({}, { 'Sec-Fetch-Site':'cross-site' })).status, 403);
  assert.equal((await api.post({}, { 'Content-Type':'text/plain' })).status, 415);
  assert.equal((await api.post('{', {})).status, 400);
  assert.equal((await api.post('x'.repeat(16001))).status, 413);
  const extend = await (await api.post({ action:'extend', requestId:randomUUID(), planId:result.plan.id, expectedRevision:result.plan.revision })).json();
  assert.equal(extend.ok, true); assert.equal(extend.created.length, 3); assert.equal(extend.complete, true); assert.equal(extend.created[0].payment, undefined);
  const disabled = await off.post({ action:'create', requestId:randomUUID(), plan:{ templateJobId:result.plan.templateJobId, cadence:{ frequency:'weekly' } } });
  assert.equal(disabled.status, 404); assert.equal((await disabled.json()).code, 'recurring_disabled');
  const denied = http(f, { user:{ user:'crew1', role:'crew' } });
  assert.equal((await denied.get('')).status, 403);
  assert.equal((await http(f, { user:null }).post({})).status, 401);
  const invalid = await (await api.post({ action:'pause', requestId:'nope', planId:result.plan.id, expectedRevision:'x' })).json();
  assert.equal(invalid.code, 'recurring_request_invalid');
});
