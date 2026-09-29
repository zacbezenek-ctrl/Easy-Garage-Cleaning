import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { extendHorizon, mutateRecurringPlan, occurrenceRequestId, planHasWork, recurringPlansOverview, runRecurringHorizon } from '../functions/_lib/recurring-plan-service.js';
import { normalizePlanPrice, priceKey, visitEstimateInput, visitPriceBlocker } from '../functions/_lib/recurring-plan-price.js';
import { mutateMoney } from '../functions/_lib/money-service.js';
import { recurringPlanHandlers } from '../functions/api/recurring-plans.js';
import { NOW, manager, recurringFixture } from './helpers/recurring-fixture.mjs';

const line = (id, unitCents, extra = {}) => ({ id, kind:'service', name:`Synthetic ${id}`, description:'', quantity:1, unitCents, ...extra });
const priced = f => f.jobs().filter(job => job.recurringPlanId).sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate));

test('a plan price is validated as integer-cent estimate lines', () => {
  assert.equal(normalizePlanPrice({ cadence:{} }), undefined, 'no price fields means no change');
  assert.deepEqual(normalizePlanPrice({ pricePerVisitCents:null }), { pricePerVisitCents:null, lineItems:null });
  const single = normalizePlanPrice({ pricePerVisitCents:14500 }, { serviceName:'Garage reset' });
  assert.equal(single.pricePerVisitCents, 14500); assert.equal(single.lineItems.length, 1);
  assert.deepEqual([single.lineItems[0].id, single.lineItems[0].kind, single.lineItems[0].name, single.lineItems[0].unitCents, single.lineItems[0].totalCents], ['recurring-visit', 'service', 'Garage reset (recurring visit)', 14500, 14500]);
  const lines = normalizePlanPrice({ lineItems:[line('reset', 9000), line('haul', 2500, { kind:'disposal', quantity:2 })] });
  assert.equal(lines.pricePerVisitCents, 14000);
  assert.equal(normalizePlanPrice({ pricePerVisitCents:14000, lineItems:[line('reset', 9000), line('haul', 2500, { kind:'disposal', quantity:2 })] }).pricePerVisitCents, 14000);
  for (const [input, code] of [[{ pricePerVisitCents:0 }, 'recurring_price_invalid'], [{ pricePerVisitCents:12.5 }, 'recurring_price_invalid'], [{ pricePerVisitCents:'145' }, 'recurring_price_invalid'],
    [{ lineItems:[] }, 'recurring_price_invalid'], [{ lineItems:Array.from({ length:13 }, (_, i) => line('l' + i, 100)) }, 'recurring_price_invalid'], [{ lineItems:[line('tip', 500, { kind:'tip' })] }, 'recurring_price_invalid'],
    [{ lineItems:[line('opt', 500, { optional:true, selected:true })] }, 'recurring_price_invalid'], [{ lineItems:[line('x', 500, { secretCost:1 })] }, 'recurring_price_invalid'], [{ pricePerVisitCents:100, lineItems:[line('a', 200)] }, 'recurring_price_mismatch']])
    assert.throws(() => normalizePlanPrice(input), error => error.code === code && error.status === 400, JSON.stringify(input));
});

test('each generated visit gets the plan price through estimate.save, once, with a receipt and audit entry', async () => {
  const f = recurringFixture(), { result } = await f.create({ lineItems:[line('reset', 12000), line('haul', 2500, { kind:'disposal' })] });
  assert.equal(result.plan.pricePerVisitCents, 14500);
  const run = await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  assert.equal(run.complete, true);
  assert.deepEqual(run.plans[0].priced.map(row => [row.date, row.status]), [['2026-09-30', 'applied'], ['2026-10-07', 'applied'], ['2026-10-14', 'applied']]);
  const key = await priceKey(f.saved(result.plan.id));
  for (const job of priced(f)) {
    const requestId = await occurrenceRequestId(result.plan.id, `job:${job.id}`, `price:${key}`);
    assert.equal(job.moneyRequestId, requestId); assert.ok(f.rows.get('moneyOperations/' + requestId));
    assert.deepEqual(job.estimate.lineItems.map(row => [row.id, row.kind, row.totalCents]), [['reset', 'service', 12000], ['haul', 'disposal', 2500]]);
    assert.equal(job.estimate.amountCents, 14500); assert.equal(job.total, 145); assert.equal(job.estimate.depositRequiredCents, 0);
    assert.equal(job.estimate.status, 'draft'); assert.equal(job.estimate.source, 'egc_hub'); assert.equal(job.estimate.scope, 'Garage reset — recurring visit (Every week).');
    assert.equal(job.estimate.validUntil, new Date(Date.parse(job.occurrenceDate + 'T12:00:00Z') + 30 * 86400000).toISOString().slice(0, 10));
    assert.equal(f.saved(result.plan.id).occurrences[job.occurrenceDate].price.status, 'applied');
  }
  assert.equal(f.all('hub_audit').filter(row => row.action === 'money.estimate.save').length, 3);
  const commits = f.commits.length;
  assert.deepEqual((await extendHorizon(f.store, manager, { pricing:true, now:NOW })).plans[0].priced, []);
  assert.equal(f.commits.length, commits, 'a rerun prices nothing again');
  const template = f.jobs().find(job => job.id === result.plan.templateJobId);
  assert.equal(template.estimate, undefined, 'the template visit keeps its own money');
});

test('an unpriced plan never writes money, keeping the legacy behavior', async () => {
  const f = recurringFixture(), { result } = await f.create();
  assert.equal(result.plan.pricePerVisitCents, null); assert.deepEqual(result.plan.lineItems, []);
  const run = await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  assert.deepEqual(run.plans[0].priced, []);
  assert.equal(f.all('moneyOperations').length, 0); assert.ok(priced(f).every(job => job.estimate === undefined && !f.saved(result.plan.id).occurrences[job.occurrenceDate].price));
});

test('a lost price confirmation is recovered from the visit without a second estimate save', async () => {
  const f = recurringFixture(), { result } = await f.create({ pricePerVisitCents:14500, horizonDays:10 }), commit = f.store.commit;
  f.store.commit = async writes => { if (writes.length === 1 && writes[0].collection === 'recurringPlans' && writes[0].patch.occurrences && Object.values(writes[0].patch.occurrences).some(entry => entry.price?.status === 'applied')) throw Object.assign(new Error('lost'), { code:'dispatch_outcome_unknown', status:503 }); return commit(writes); };
  await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  f.store.commit = commit;
  const [visit] = priced(f);
  assert.equal(f.saved(result.plan.id).occurrences[visit.occurrenceDate].price.status, 'pending');
  assert.equal(f.all('moneyOperations').length, 1);
  const again = await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  assert.deepEqual(again.plans[0].priced.map(row => row.status), ['applied']);
  assert.equal(f.all('moneyOperations').length, 1, 'the saved estimate is recognised by its request id');
  assert.equal(f.saved(result.plan.id).occurrences[visit.occurrenceDate].price.status, 'applied');
});

test('a failed or unknown estimate save leaves the price pending and the run retryable', async () => {
  const f = recurringFixture(), { result } = await f.create({ pricePerVisitCents:14500, horizonDays:10 }), commit = f.store.commit;
  f.store.commit = async writes => { if (writes.some(write => write.collection === 'moneyOperations')) throw Object.assign(new Error('storage down'), { code:'dispatch_storage_unavailable', status:503 }); return commit(writes); };
  const run = await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  f.store.commit = commit;
  assert.equal(run.complete, false); assert.equal(run.plans[0].retryable, true); assert.equal(run.plans[0].created.length, 1, 'the visit itself was booked');
  const [visit] = priced(f);
  assert.equal(f.saved(result.plan.id).occurrences[visit.occurrenceDate].price.status, 'pending');
  const retried = await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  assert.deepEqual(retried.plans[0].priced.map(row => row.status), ['applied']); assert.equal(f.job(visit.id).estimate.amountCents, 14500);
});

test('re-pricing booked visits never overwrites money a manager set, or an approved, invoiced or paid visit', async () => {
  const f = recurringFixture(), { result } = await f.create({ pricePerVisitCents:14500 });
  await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  const [first, second, third] = priced(f);
  // A manager changes one visit's estimate and records another customer's approval.
  await mutateMoney(f.store, manager, { action:'estimate.save', requestId:randomUUID(), jobId:first.id, expectedRevision:f.job(first.id).revision, lineItems:[line('custom', 19900)], scope:'Synthetic custom visit.', depositCents:0, validUntil:'2026-10-30' }, NOW);
  await mutateMoney(f.store, manager, { action:'estimate.record_approval', requestId:randomUUID(), jobId:second.id, expectedRevision:f.job(second.id).revision, approvedBy:'Synthetic Customer' }, NOW);
  const current = f.saved(result.plan.id);
  const update = await f.plan({ action:'update', planId:current.id, expectedRevision:current.revision, applyToBooked:true, plan:{ pricePerVisitCents:16000 } });
  assert.deepEqual(update.warnings.map(row => row.code), ['booked_visits_updating']);
  const run = await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  assert.deepEqual(run.plans[0].priced.map(row => [row.date, row.status, row.reason || null]), [['2026-09-30', 'skipped', 'price_changed_in_hub'], ['2026-10-07', 'skipped', 'price_locked'], ['2026-10-14', 'applied', null]]);
  assert.equal(f.job(first.id).estimate.amountCents, 19900); assert.equal(f.job(second.id).estimate.amountCents, 14500); assert.equal(f.job(third.id).estimate.amountCents, 16000);
  assert.deepEqual(f.saved(result.plan.id).warnings.filter(row => row.code === 'price_not_applied').map(row => row.date), ['2026-09-30', '2026-10-07']);
  assert.equal(visitPriceBlocker({ payment:{ amount:50 } }), 'price_locked'); assert.equal(visitPriceBlocker({ invoice:{ status:'issued', amount:100 } }), 'price_locked');
  assert.equal(visitPriceBlocker({ invoice:{ status:'void', amount:100 } }), null); assert.equal(visitPriceBlocker({}), null);
  assert.equal(visitPriceBlocker({ estimate:{ number:'EST-1', amount:10 }, moneyRequestId:'a' }, 'a'), null); assert.equal(visitPriceBlocker({ estimate:{ number:'EST-1', amount:10 }, moneyRequestId:'b' }, 'a'), 'price_changed_in_hub');
});

test('a price change without applyToBooked prices only new visits and says so', async () => {
  const f = recurringFixture(), { result } = await f.create({ pricePerVisitCents:14500, horizonDays:10 });
  await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  const current = f.saved(result.plan.id);
  const update = await f.plan({ action:'update', planId:current.id, expectedRevision:current.revision, plan:{ pricePerVisitCents:16000, horizonDays:17 } });
  assert.match(update.warnings.find(row => row.code === 'generated_visits_unchanged').message, /current time, crew and price/);
  await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  assert.deepEqual(priced(f).map(job => [job.occurrenceDate, job.estimate.amountCents]), [['2026-09-30', 14500], ['2026-10-07', 16000]]);
  // Removing the price stops pricing later visits; saved estimates stay.
  const again = f.saved(result.plan.id);
  const cleared = await f.plan({ action:'update', planId:again.id, expectedRevision:again.revision, plan:{ pricePerVisitCents:null, lineItems:null, horizonDays:24 } });
  assert.equal(cleared.plan.pricePerVisitCents, null);
  await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  assert.deepEqual(priced(f).map(job => [job.occurrenceDate, job.estimate?.amountCents ?? null]), [['2026-09-30', 14500], ['2026-10-07', 16000], ['2026-10-14', null]]);
});

test('applyToBooked moves future unstarted visits to the new time and crew in the same commit as their plan entry', async () => {
  const f = recurringFixture(), { result } = await f.create();
  await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  const [first, second, third] = priced(f);
  // One visit started in the field, one was retimed in Dispatch, one is untouched.
  f.rows.set('jobs/' + first.id, { ...f.rows.get('jobs/' + first.id), fieldLastActionAt:'2026-09-22T11:00:00.000Z', revision:'field-r' });
  await f.mutate({ action:'schedule.update', jobId:second.id, expectedRevision:f.job(second.id).revision, changes:{ time:'07:00', endTime:'09:00' } });
  const current = f.saved(result.plan.id);
  const update = await f.plan({ action:'update', planId:current.id, expectedRevision:current.revision, applyToBooked:true, plan:{ time:'09:00', endTime:'11:00', assignment:{ assignedCrew:['crew2'] } } });
  assert.deepEqual(update.warnings.map(row => row.code), ['booked_visits_updating', 'booked_visits_kept']);
  assert.deepEqual(update.warnings[0].visits.map(row => row.date), ['2026-10-14']);
  assert.deepEqual(update.warnings[1].visits.map(row => [row.date, row.reason]), [['2026-09-30', 'started'], ['2026-10-07', 'changed_in_dispatch']]);
  assert.equal(update.plan.occurrences.find(row => row.date === '2026-10-14').state, 'updating');
  assert.equal(f.job(third.id).time, '08:00', 'nothing moves inside the plan save itself');
  const run = await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  assert.deepEqual(run.plans[0].updated, [{ date:'2026-10-14', jobId:third.id, from:'2026-10-14' }]);
  const moved = f.job(third.id);
  assert.deepEqual([moved.date, moved.time, moved.endTime, moved.assignedCrew, moved.startAt], ['2026-10-14', '09:00', '11:00', ['crew2'], '2026-10-14T15:00:00.000Z']);
  const requestId = await occurrenceRequestId(result.plan.id, '2026-10-14', `apply:${update.requestId}`);
  assert.equal(moved.dispatchRequestId, requestId); assert.ok(f.rows.get('dispatchOperations/' + requestId));
  assert.deepEqual(['start','end','assignedCrew'].map(key => f.rows.get('jobs/_egc_schedule_lock_2026-10-14').entries.find(entry => entry.id === third.id)[key]), ['09:00', '11:00', ['crew2']]);
  const entry = f.saved(result.plan.id).occurrences['2026-10-14'];
  assert.equal(entry.apply, undefined); assert.deepEqual(entry.slot, { date:'2026-10-14', time:'09:00', endDate:'2026-10-14', endTime:'11:00' });
  assert.deepEqual([f.job(first.id).time, f.job(second.id).time], ['08:00', '07:00']);
  const commits = f.commits.length;
  assert.deepEqual((await extendHorizon(f.store, manager, { pricing:true, now:NOW })).plans[0].updated, []); assert.equal(f.commits.length, commits);
  // The rolling window then books new dates at the new time with the new crew.
  const later = await extendHorizon(f.store, manager, { pricing:true, now:'2026-09-29T12:00:00.000Z' });
  assert.deepEqual(later.plans[0].created.map(job => [job.date, job.time]), [['2026-10-21', '09:00']]);
});

test('a weekday change moves each booked visit to the nearest new date and reserves it', async () => {
  const f = recurringFixture(), { result } = await f.create();
  await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  const current = f.saved(result.plan.id), ids = priced(f).map(job => job.id);
  const update = await f.plan({ action:'update', planId:current.id, expectedRevision:current.revision, applyToBooked:true, plan:{ startDate:'2026-09-24' } });
  assert.deepEqual(update.warnings.find(row => row.code === 'booked_visits_updating').visits.map(row => [row.from, row.date]), [['2026-09-30', '2026-10-01'], ['2026-10-07', '2026-10-08'], ['2026-10-14', '2026-10-15']]);
  assert.match(update.warnings.find(row => row.code === 'booked_visits_updating').message, /2026-09-30 → 2026-10-01/);
  // The original template visit on the old weekday is reported like any off-pattern visit.
  assert.deepEqual(update.warnings.find(row => row.code === 'generated_visits_off_pattern').visits.map(row => row.date), ['2026-09-23']);
  const run = await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  assert.deepEqual(run.plans[0].updated.map(row => [row.from, row.date]), [['2026-09-30', '2026-10-01'], ['2026-10-07', '2026-10-08'], ['2026-10-14', '2026-10-15']]);
  assert.deepEqual(run.plans[0].created.map(job => job.date), ['2026-09-24'], 'only the one new date without a booked visit is added');
  assert.deepEqual(ids.map(id => [f.job(id).date, f.job(id).occurrenceDate]), [['2026-10-01', '2026-10-01'], ['2026-10-08', '2026-10-08'], ['2026-10-15', '2026-10-15']]);
  assert.equal(f.jobs().filter(job => job.recurringPlanId === result.plan.id).length, 4);
  const plan = (await recurringPlansOverview(f.store, manager, {}, new Date(NOW), { enabled:true })).plans[0];
  assert.deepEqual(plan.upcoming.map(row => [row.date, row.state]).slice(0, 4), [['2026-09-24', 'scheduled'], ['2026-10-01', 'scheduled'], ['2026-10-08', 'scheduled'], ['2026-10-15', 'scheduled']]);
});

test('a booked visit the new slot conflicts with keeps its time, returns to its date and is reported', async () => {
  const f = recurringFixture(), { result } = await f.create({ horizonDays:10 });
  await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  const [visit] = priced(f);
  await f.book({ date:'2026-09-30', time:'12:00', endTime:'14:00' }, { customerId:'c2' });
  const current = f.saved(result.plan.id);
  await f.plan({ action:'update', planId:current.id, expectedRevision:current.revision, applyToBooked:true, plan:{ time:'12:00', endTime:'13:00' } });
  const run = await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  assert.deepEqual(run.plans[0].updated, []); assert.equal(run.complete, true);
  assert.equal(f.job(visit.id).time, '08:00');
  const saved = f.saved(result.plan.id);
  assert.equal(saved.occurrences['2026-09-30'].apply, undefined); assert.equal(saved.occurrences['2026-09-30'].jobId, visit.id);
  assert.equal(saved.warnings.at(-1).code, 'booked_visit_not_updated'); assert.equal(saved.warnings.at(-1).reason, 'dispatch_conflict');
  assert.match(saved.warnings.at(-1).message, /It kept its original time/);
});

test('a later edit replaces booked-visit changes that have not run yet', async () => {
  const f = recurringFixture(), { result } = await f.create({ horizonDays:10 });
  await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  let current = f.saved(result.plan.id);
  await f.plan({ action:'update', planId:current.id, expectedRevision:current.revision, applyToBooked:true, plan:{ startDate:'2026-09-24' } });
  assert.ok(f.saved(result.plan.id).occurrences['2026-10-01'].apply, 'reserved on the new date');
  current = f.saved(result.plan.id);
  const undo = await f.plan({ action:'update', planId:current.id, expectedRevision:current.revision, plan:{ startDate:'2026-09-23' } });
  assert.equal(undo.warnings[0].code, 'booked_visits_update_cancelled');
  const saved = f.saved(result.plan.id);
  assert.equal(saved.occurrences['2026-10-01'], undefined); assert.equal(saved.occurrences['2026-09-30'].apply, undefined);
  assert.deepEqual((await extendHorizon(f.store, manager, { pricing:true, now:NOW })).plans[0].updated, []);
  assert.equal(priced(f)[0].date, '2026-09-30');
  // Ending a plan also drops changes that never ran.
  current = f.saved(result.plan.id);
  await f.plan({ action:'update', planId:current.id, expectedRevision:current.revision, applyToBooked:true, plan:{ time:'09:00', endTime:'11:00' } });
  current = f.saved(result.plan.id);
  await f.plan({ action:'end', planId:current.id, expectedRevision:current.revision });
  assert.equal(Object.values(f.saved(result.plan.id).occurrences).some(entry => entry.apply), false);
  await assert.rejects(f.plan({ action:'update', planId:current.id, expectedRevision:current.revision, applyToBooked:'yes', plan:{} }), error => error.code === 'recurring_request_invalid');
  await assert.rejects(f.plan({ action:'pause', planId:current.id, expectedRevision:current.revision, applyToBooked:true }), error => error.code === 'recurring_request_invalid');
});

test('the manager extend action reports priced and moved visits and replays them unchanged', async () => {
  const f = recurringFixture(), { result } = await f.create({ pricePerVisitCents:14500, horizonDays:10 });
  const extend = (plan, requestId = randomUUID()) => mutateRecurringPlan(f.store, manager, { action:'extend', requestId, planId:plan.id, expectedRevision:plan.revision }, NOW, { enabled:true, pricing:true });
  const first = await extend(result.plan);
  assert.deepEqual(first.priced.map(row => [row.date, row.status]), [['2026-09-30', 'applied']]); assert.deepEqual(first.updated, []);
  const again = await mutateRecurringPlan(f.store, manager, { action:'extend', requestId:first.requestId, planId:result.plan.id, expectedRevision:result.plan.revision }, NOW, { enabled:false });
  assert.equal(again.replayed, true); assert.deepEqual(again.priced, first.priced);
  const current = f.saved(result.plan.id);
  const moved = await f.plan({ action:'update', planId:current.id, expectedRevision:current.revision, applyToBooked:true, plan:{ time:'10:00', endTime:'12:00' } });
  const second = await extend(moved.plan);
  assert.deepEqual(second.updated.map(row => [row.from, row.date]), [['2026-09-30', '2026-09-30']]);
  assert.equal(f.job(second.updated[0].jobId).time, '10:00');
});

test('a date a moved visit left behind is booked again under a new request and never blocks the plan', async () => {
  const f = recurringFixture(), { result } = await f.create(), id = result.plan.id;
  await extendHorizon(f.store, manager, { now:NOW });
  let current = f.saved(id);
  await f.plan({ action:'update', planId:id, expectedRevision:current.revision, applyToBooked:true, plan:{ startDate:'2026-09-24' } });
  assert.deepEqual(f.saved(id).reissued, { '2026-09-30':1, '2026-10-07':1, '2026-10-14':1 }, 'each vacated date moves to its next generation');
  assert.equal((await extendHorizon(f.store, manager, { now:NOW })).plans[0].updated.length, 3);
  // Back to Wednesdays without moving the booked visits: the Wednesdays are due again.
  current = f.saved(id);
  const back = await f.plan({ action:'update', planId:id, expectedRevision:current.revision, plan:{ startDate:'2026-09-23' } });
  assert.deepEqual(back.warnings.find(row => row.code === 'generated_visits_off_pattern').visits.map(row => row.date), ['2026-09-24', '2026-10-01', '2026-10-08', '2026-10-15']);
  const run = await extendHorizon(f.store, manager, { now:NOW });
  assert.equal(run.plans[0].blocked, null); assert.equal(run.complete, true);
  // The moved visits still hold their original booking ids, so each Wednesday is saved unscheduled for a new time.
  assert.deepEqual(run.plans[0].conflicts.map(row => [row.date, row.code]), [['2026-09-30', 'recurring_slot_taken'], ['2026-10-07', 'recurring_slot_taken'], ['2026-10-14', 'recurring_slot_taken']]);
  const saved = f.saved(id);
  for (const date of ['2026-09-30', '2026-10-07', '2026-10-14']) assert.equal(saved.occurrences[date].requestId, await occurrenceRequestId(id, date, 'unscheduled:regen:1'));
  const visits = f.jobs().filter(job => job.recurringPlanId === id), dated = visits.filter(job => job.date).map(job => job.date);
  assert.equal(new Set(visits.map(job => job.occurrenceDate)).size, visits.length, 'no date has two visits from this plan');
  assert.equal(new Set(dated).size, dated.length, 'no day is booked twice');
  assert.equal(saved.lastRun.status, 'ok'); assert.equal(saved.warnings.some(row => row.code === 'plan_blocked'), false);
  // A week later the rolling window keeps adding visits.
  const later = await extendHorizon(f.store, manager, { now:'2026-09-29T12:00:00.000Z' });
  assert.equal(later.plans[0].blocked, null); assert.deepEqual(later.plans[0].created.map(job => [job.date, job.time]), [['2026-10-21', '08:00']]);
});

test('a plan that meets an already spent create request takes the next generation itself', async () => {
  const f = recurringFixture(), { result } = await f.create({ horizonDays:10 }), id = result.plan.id;
  await extendHorizon(f.store, manager, { now:NOW });
  let current = f.saved(id);
  await f.plan({ action:'update', planId:id, expectedRevision:current.revision, applyToBooked:true, plan:{ startDate:'2026-09-24' } });
  await extendHorizon(f.store, manager, { now:NOW });
  current = f.saved(id);
  await f.plan({ action:'update', planId:id, expectedRevision:current.revision, plan:{ startDate:'2026-09-23' } });
  // A plan saved before generations existed: the vacated date has no record of its spent request.
  const { reissued, ...legacy } = f.rows.get('recurringPlans/' + id);
  assert.deepEqual(reissued, { '2026-09-30':1 }); f.rows.set('recurringPlans/' + id, legacy);
  const run = await extendHorizon(f.store, manager, { now:NOW });
  assert.equal(run.plans[0].blocked, null); assert.deepEqual(run.plans[0].conflicts.map(row => row.date), ['2026-09-30']);
  assert.deepEqual(f.saved(id).reissued, { '2026-09-30':1 });
  assert.equal(f.saved(id).occurrences['2026-09-30'].requestId, await occurrenceRequestId(id, '2026-09-30', 'unscheduled:regen:1'));
});

test('a price changed and changed back with applyToBooked ends at the plan price, each save under a new request', async () => {
  const f = recurringFixture(), { result } = await f.create({ pricePerVisitCents:14500, horizonDays:10 }), id = result.plan.id;
  await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  const [visit] = priced(f);
  const edit = async (cents, run = true) => { const current = f.saved(id); await f.plan({ action:'update', planId:id, expectedRevision:current.revision, applyToBooked:true, plan:{ pricePerVisitCents:cents } }); return run ? extendHorizon(f.store, manager, { pricing:true, now:NOW }) : null; };
  for (const cents of [16000, 14500]) {
    const run = await edit(cents);
    assert.deepEqual(run.plans[0].priced.map(row => [row.date, row.status]), [['2026-09-30', 'applied']], String(cents));
    assert.equal(f.job(visit.id).estimate.amountCents, cents);
  }
  // A change that never ran, replaced by one back to the price already on the visit.
  await edit(17500, false); const settled = await edit(14500);
  assert.deepEqual(settled.plans[0].priced.map(row => row.status), ['applied']); assert.equal(f.job(visit.id).estimate.amountCents, 14500);
  const saves = f.all('moneyOperations').filter(row => row.jobId === visit.id).map(row => row.requestId);
  assert.equal(saves.length, 4); assert.equal(new Set(saves).size, 4, 'no price request is ever reused');
  assert.deepEqual(f.saved(id).warnings.filter(row => row.code === 'price_not_applied'), []);
  assert.equal(f.saved(id).occurrences['2026-09-30'].price.status, 'applied');
});

test('a price another run saved first, under a different manager, is recorded as applied and not as changed in the Hub', async () => {
  const f = recurringFixture(), { result } = await f.create({ pricePerVisitCents:14500, horizonDays:10 }), read = f.store.read;
  const other = { user:'tylerg', displayName:'Synthetic Manager', role:'manager', businessAccess:true };
  let raced = false;
  f.store.read = async (collection, id) => {
    if (collection === 'moneyOperations' && !raced) {
      raced = true;
      const visit = f.jobs().find(job => job.recurringPlanId === result.plan.id);
      await mutateMoney({ ...f.store, read }, other, visitEstimateInput(f.saved(result.plan.id), visit, { requestId:id, date:visit.occurrenceDate, today:'2026-09-22', serviceName:'Garage reset', cadence:'Every week' }), NOW);
    }
    return read(collection, id);
  };
  const run = await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  assert.equal(raced, true);
  assert.deepEqual(run.plans[0].priced.map(row => [row.status, row.reason || null]), [['applied', null]]);
  assert.equal(f.saved(result.plan.id).occurrences['2026-09-30'].price.status, 'applied');
  assert.deepEqual(f.saved(result.plan.id).warnings, []); assert.equal(f.all('moneyOperations').length, 1);
});

test('a price edit saved while a visit estimate save is running is applied after it, not reported as changed in the Hub', async () => {
  const f = recurringFixture(), { result } = await f.create({ pricePerVisitCents:14500, horizonDays:10 }), id = result.plan.id, read = f.store.read;
  let raced = false;
  f.store.read = async (collection, docId) => {
    if (collection === 'moneyOperations' && !raced) { raced = true; const current = f.saved(id); await f.plan({ action:'update', planId:id, expectedRevision:current.revision, applyToBooked:true, plan:{ pricePerVisitCents:16000 } }); }
    return read(collection, docId);
  };
  const run = await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  f.store.read = read;
  assert.equal(raced, true);
  const [visit] = priced(f), saves = f.all('moneyOperations').filter(row => row.jobId === visit.id).map(row => row.requestId);
  assert.deepEqual(run.plans[0].priced.map(row => [row.status, row.reason || null]), [['applied', null], ['applied', null]], 'the older price lands, then the edit follows it');
  assert.equal(f.job(visit.id).estimate.amountCents, 16000); assert.equal(saves.length, 2);
  assert.equal(f.job(visit.id).moneyRequestId, f.saved(id).occurrences[visit.occurrenceDate].price.requestId);
  assert.equal(saves[1], await occurrenceRequestId(id, `job:${visit.id}`, `price:${await priceKey(f.saved(id))}:${saves[0]}`));
  assert.deepEqual(f.saved(id).warnings.filter(row => row.code === 'price_not_applied'), []);
});

test('with server money writes off, visits are booked and their price waits until they are turned on', async () => {
  const f = recurringFixture(), template = await f.book(), env = { EGC_RECURRING_PLANS_ENABLED:'true' };
  const api = recurringPlanHandlers({ session:async () => manager, storage:() => f.store, now:() => new Date(NOW) });
  const post = async (body, extra = {}) => (await api.post({ request:new Request('https://easygaragecleaning.com/api/recurring-plans', { method:'POST', headers:{ Origin:'https://easygaragecleaning.com', 'Content-Type':'application/json' }, body:JSON.stringify({ requestId:randomUUID(), ...body }) }), env:{ ...env, ...extra } })).json();
  const created = await post({ action:'create', plan:{ templateJobId:template.id, cadence:{ frequency:'weekly' }, horizonDays:17, pricePerVisitCents:14500 } });
  assert.equal(created.ok, true); assert.deepEqual(created.warnings.map(row => row.code), ['price_waits_for_money_api']);
  const id = created.plan.id;
  const off = await runRecurringHorizon(env, { actor:manager, now:NOW, storage:() => f.store });
  assert.equal(off.complete, true);
  assert.deepEqual(off.plans[0].priced.map(row => [row.date, row.status, row.reason]), [['2026-09-30', 'waiting', 'money_api_disabled'], ['2026-10-07', 'waiting', 'money_api_disabled']]);
  assert.equal(f.all('moneyOperations').length, 0); assert.equal(f.all('hub_audit').length, 0); assert.ok(priced(f).every(job => job.estimate === undefined));
  assert.deepEqual(Object.values(f.saved(id).occurrences).filter(entry => entry.price).map(entry => entry.price.status), ['pending', 'pending']);
  assert.equal(planHasWork(f.saved(id), NOW), false, 'a waiting price is no work while money writes are off');
  assert.equal(planHasWork(f.saved(id), NOW, { pricing:true }), true);
  // The manager's extend reads the same flag.
  const extended = await post({ action:'extend', planId:id, expectedRevision:f.saved(id).revision });
  assert.deepEqual([extended.ok, extended.complete, extended.priced], [true, true, []]);
  const on = await runRecurringHorizon({ ...env, MONEY_API_ENABLED:'true' }, { actor:manager, now:NOW, storage:() => f.store });
  assert.deepEqual(on.plans[0].priced.map(row => [row.date, row.status]), [['2026-09-30', 'applied'], ['2026-10-07', 'applied']]);
  assert.ok(priced(f).every(job => job.estimate.amountCents === 14500));
  const current = f.saved(id), changed = await post({ action:'update', planId:id, expectedRevision:current.revision, plan:{ pricePerVisitCents:16000 } }, { MONEY_API_ENABLED:'true' });
  assert.equal(changed.warnings.some(row => row.code === 'price_waits_for_money_api'), false);
});

// Second review: a plan edit never double-books the customer, reads money
// fields from the visit itself, and never re-prices a started visit.
const liveSlots = f => f.jobs().filter(job => job.date && !['cancelled','canceled'].includes(job.pipelineStatus || job.status)).map(job => `${job.customerId} ${job.date} ${job.time}`);
const noDoubleBooking = f => { const slots = liveSlots(f); assert.equal(new Set(slots).size, slots.length, 'a customer date and time holds one live visit: ' + slots.sort().join(', ')); };

test('applyToBooked never moves a booked visit onto a date and time the customer already has booked with another crew', async () => {
  const f = recurringFixture(), { result } = await f.create({ horizonDays:10 }), id = result.plan.id;
  await extendHorizon(f.store, manager, { now:NOW });
  const [visit] = priced(f);
  assert.deepEqual([visit.date, visit.time, visit.assignedCrew], ['2026-09-30', '08:00', ['crew1']]);
  // A separate booking for the same customer on Thu 2026-10-01 08:00 with crew2; schedule.create refuses a second one there.
  const other = await f.book({ date:'2026-10-01', assignedCrew:['crew2'] });
  await assert.rejects(f.book({ date:'2026-10-01', assignedCrew:[] }), error => error.code === 'dispatch_job_already_exists');
  const current = f.saved(id);
  const update = await f.plan({ action:'update', planId:id, expectedRevision:current.revision, applyToBooked:true, plan:{ startDate:'2026-09-24' } });
  const held = update.warnings.find(row => row.code === 'booked_visits_slot_taken');
  assert.deepEqual(held.visits, [{ date:'2026-09-30', jobId:visit.id, reason:'slot_taken', to:'2026-10-01' }]);
  assert.match(held.message, /NOT moved because the customer already has another booking at the new time \(2026-09-30 → 2026-10-01 08:00\)/);
  assert.equal(update.warnings.some(row => row.code === 'booked_visits_updating'), false);
  assert.equal(f.saved(id).occurrences['2026-09-30'].apply, undefined);
  const run = await extendHorizon(f.store, manager, { now:NOW });
  assert.deepEqual([run.plans[0].updated, run.plans[0].kept], [[], []]);
  assert.deepEqual(run.plans[0].adopted, [{ date:'2026-10-01', jobId:other.id }], 'the separate booking stands in for the new date');
  assert.deepEqual(run.plans[0].created.map(job => job.date), ['2026-09-24']);
  assert.deepEqual([f.job(visit.id).date, f.job(visit.id).time], ['2026-09-30', '08:00']);
  noDoubleBooking(f);
});

test('a booking made at the new time after the edit keeps the visit where it is, even with no crew on either booking', async () => {
  const f = recurringFixture(), { result } = await f.create({ horizonDays:10, assignment:{ assignedCrew:[] } }), id = result.plan.id;
  await extendHorizon(f.store, manager, { now:NOW });
  const [visit] = priced(f);
  assert.deepEqual(visit.assignedCrew, []);
  const current = f.saved(id);
  const update = await f.plan({ action:'update', planId:id, expectedRevision:current.revision, applyToBooked:true, plan:{ startDate:'2026-09-24' } });
  assert.deepEqual(update.warnings.find(row => row.code === 'booked_visits_updating').visits.map(row => [row.from, row.date]), [['2026-09-30', '2026-10-01']]);
  // Before the run moves it, the customer is booked at that exact time with no crew: dispatch sees no crew or vehicle conflict.
  const other = await f.book({ date:'2026-10-01', assignedCrew:[] });
  const run = await extendHorizon(f.store, manager, { now:NOW });
  assert.deepEqual(run.plans[0].updated, []);
  assert.deepEqual(run.plans[0].kept, [{ date:'2026-09-30', jobId:visit.id, reason:'slot_taken' }]);
  assert.deepEqual([f.job(visit.id).date, f.job(visit.id).time, f.job(visit.id).revision], ['2026-09-30', '08:00', visit.revision], 'the visit was not written');
  const saved = f.saved(id), warning = saved.warnings.find(row => row.code === 'booked_visit_not_updated');
  assert.equal(saved.occurrences['2026-09-30'].jobId, visit.id); assert.equal(saved.occurrences['2026-09-30'].apply, undefined);
  assert.deepEqual([warning.reason, warning.date, warning.jobId], ['slot_taken', '2026-09-30', visit.id]);
  assert.match(warning.message, /not moved to 2026-10-01 08:00 because the customer already has another booking at that time/);
  // The date the move gave up is booked in the same run: the separate booking stands in for it.
  assert.deepEqual(run.plans[0].adopted, [{ date:'2026-10-01', jobId:other.id }]);
  assert.equal(run.plans[0].complete, true);
  noDoubleBooking(f);
});

test('a time change never moves a booked visit onto a time the customer already has booked that day', async () => {
  const f = recurringFixture(), { result } = await f.create({ horizonDays:17 }), id = result.plan.id;
  await extendHorizon(f.store, manager, { now:NOW });
  const [first, second] = priced(f);
  assert.deepEqual([first.date, second.date], ['2026-09-30', '2026-10-07']);
  await f.book({ date:'2026-09-30', time:'10:00', endTime:'12:00', assignedCrew:['crew2'] });
  const current = f.saved(id);
  const update = await f.plan({ action:'update', planId:id, expectedRevision:current.revision, applyToBooked:true, plan:{ time:'10:00', endTime:'12:00' } });
  assert.deepEqual(update.warnings.find(row => row.code === 'booked_visits_slot_taken').visits, [{ date:'2026-09-30', jobId:first.id, reason:'slot_taken', to:'2026-09-30' }]);
  assert.deepEqual(update.warnings.find(row => row.code === 'booked_visits_updating').visits.map(row => row.date), ['2026-10-07']);
  const run = await extendHorizon(f.store, manager, { now:NOW });
  assert.deepEqual(run.plans[0].updated.map(row => row.date), ['2026-10-07']);
  assert.deepEqual([f.job(first.id).time, f.job(second.id).time], ['08:00', '10:00']);
  noDoubleBooking(f);
});

test('a customer with two plans is never double-booked when one plan moves onto the other plan day', async () => {
  const f = recurringFixture(), wednesday = await f.create({ horizonDays:17 });
  const thursday = await f.plan({ action:'create', plan:{ templateJobId:(await f.book({ date:'2026-09-24' })).id, cadence:{ frequency:'weekly' }, horizonDays:17 } });
  await extendHorizon(f.store, manager, { now:NOW, limit:20 });
  const current = f.saved(wednesday.result.plan.id);
  const update = await f.plan({ action:'update', planId:current.id, expectedRevision:current.revision, applyToBooked:true, plan:{ startDate:'2026-09-24' } });
  assert.deepEqual(update.warnings.find(row => row.code === 'booked_visits_slot_taken').visits.map(row => [row.date, row.to]), [['2026-09-30', '2026-10-01'], ['2026-10-07', '2026-10-08']]);
  await extendHorizon(f.store, manager, { now:NOW, limit:20 });
  assert.ok(f.jobs().some(job => job.recurringPlanId === thursday.plan.id));
  noDoubleBooking(f);
});

test('a price saved but not recorded is re-priced with applyToBooked on the production-masked jobs scan', async () => {
  const f = recurringFixture(), { result } = await f.create({ pricePerVisitCents:14500, horizonDays:10 }), id = result.plan.id, commit = f.store.commit;
  // The estimate.save lands but the plan's record of it is lost.
  f.store.commit = async writes => { if (writes.length === 1 && writes[0].collection === 'recurringPlans' && Object.values(writes[0].patch.occurrences || {}).some(entry => entry.price?.status === 'applied')) throw Object.assign(new Error('lost'), { code:'dispatch_revision_conflict', status:409 }); return commit(writes); };
  await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  f.store.commit = commit;
  const [visit] = priced(f);
  assert.equal(f.saved(id).occurrences[visit.occurrenceDate].price.status, 'pending');
  assert.equal(f.job(visit.id).estimate.amountCents, 14500);
  const scanned = (await f.store.jobs()).find(job => job.id === visit.id);
  assert.deepEqual(['moneyRequestId', 'recurringPlanId', 'occurrenceDate'].filter(key => key in scanned), [], 'the scan carries dispatch fields only');
  // DISPATCH-DURATION's mask keeps estimate.status (for the duration source) and nothing else of the estimate: no amount reaches the scan.
  assert.deepEqual(Object.keys(scanned.estimate ?? {}).filter(key => key !== 'status'), [], 'the scan carries no estimate amount or lines');
  const current = f.saved(id);
  await f.plan({ action:'update', planId:id, expectedRevision:current.revision, applyToBooked:true, plan:{ pricePerVisitCents:16000 } });
  const run = await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  assert.deepEqual(run.plans[0].priced.map(row => [row.status, row.reason || null]), [['applied', null]]);
  assert.equal(f.job(visit.id).estimate.amountCents, 16000);
  assert.deepEqual(f.saved(id).warnings.filter(row => row.code === 'price_not_applied'), []);
});

test('a re-price queued before a visit started is not applied once its crew has started it', async () => {
  const f = recurringFixture(), { result } = await f.create({ pricePerVisitCents:14500, horizonDays:10 }), id = result.plan.id;
  await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  const [visit] = priced(f), date = visit.occurrenceDate;
  const current = f.saved(id);
  await f.plan({ action:'update', planId:id, expectedRevision:current.revision, applyToBooked:true, plan:{ pricePerVisitCents:16000 } });
  assert.equal(f.saved(id).occurrences[date].price.status, 'pending');
  // The crew starts the visit before the next run.
  f.rows.set('jobs/' + visit.id, { ...f.rows.get('jobs/' + visit.id), pipelineStatus:'in_progress', status:'in_progress', fieldLastActionAt:'2026-09-22T11:59:00.000Z', revision:'started-r' });
  const saves = f.all('moneyOperations').length;
  const run = await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  assert.deepEqual(run.plans[0].priced, [{ date, jobId:visit.id, status:'skipped', reason:'started' }]);
  assert.equal(f.job(visit.id).estimate.amountCents, 14500); assert.equal(f.all('moneyOperations').length, saves);
  const saved = f.saved(id);
  assert.deepEqual([saved.occurrences[date].price.status, saved.occurrences[date].price.reason], ['skipped', 'started']);
  assert.deepEqual([saved.warnings.at(-1).code, saved.warnings.at(-1).reason], ['price_not_applied', 'started']);
  assert.equal(planHasWork(saved, NOW, { pricing:true }), false, 'the skipped re-price is not retried');
  // A visit's first plan price is still saved after its crew started it.
  const g = recurringFixture(), first = await g.create({ pricePerVisitCents:14500, horizonDays:10 });
  await extendHorizon(g.store, manager, { now:NOW });
  const [booked] = priced(g);
  g.rows.set('jobs/' + booked.id, { ...g.rows.get('jobs/' + booked.id), fieldLastActionAt:'2026-09-22T11:59:00.000Z', revision:'started-g' });
  const later = await extendHorizon(g.store, manager, { pricing:true, now:NOW });
  assert.deepEqual(later.plans[0].priced.map(row => row.status), ['applied']);
  assert.equal(g.job(booked.id).estimate.amountCents, 14500); assert.equal(g.saved(first.result.plan.id).occurrences[booked.occurrenceDate].price.status, 'applied');
});

test('the manager extend reports booked-visit changes it had to drop, and replays them unchanged', async () => {
  const f = recurringFixture(), { result } = await f.create({ horizonDays:17 }), id = result.plan.id;
  await extendHorizon(f.store, manager, { now:NOW });
  const visits = priced(f);
  const current = f.saved(id);
  await f.plan({ action:'update', planId:id, expectedRevision:current.revision, applyToBooked:true, plan:{ time:'09:00', endTime:'11:00' } });
  for (const visit of visits) await f.mutate({ action:'schedule.update', jobId:visit.id, expectedRevision:f.job(visit.id).revision, changes:{ time:'07:00', endTime:'09:00' } });
  const request = { action:'extend', requestId:randomUUID(), planId:id, expectedRevision:f.saved(id).revision, limit:4 };
  const extended = await mutateRecurringPlan(f.store, manager, request, NOW, { enabled:true, pricing:true });
  assert.deepEqual(extended.kept, visits.map(visit => ({ date:visit.date, jobId:visit.id, reason:'changed_in_dispatch' })));
  assert.deepEqual([extended.updated, extended.complete], [[], true]);
  assert.equal(extended.plan.occurrences.some(row => row.state === 'updating'), false);
  assert.ok(visits.every(visit => f.job(visit.id).time === '07:00'));
  const replayed = await mutateRecurringPlan(f.store, manager, request, NOW, { enabled:true, pricing:true });
  assert.deepEqual([replayed.replayed, replayed.kept], [true, extended.kept]);
});

// The estimate.save lands but the plan's record of it is lost.
const loseRecords = f => { const commit = f.store.commit; f.store.commit = async writes => { if (writes.length === 1 && writes[0].collection === 'recurringPlans' && Object.values(writes[0].patch.occurrences || {}).some(entry => entry.price?.status === 'applied')) throw Object.assign(new Error('lost'), { code:'dispatch_revision_conflict', status:409 }); return commit(writes); }; return () => { f.store.commit = commit; }; };
const saveIds = (f, jobId) => f.all('moneyOperations').filter(row => row.jobId === jobId).map(row => row.requestId);
const notApplied = (f, id) => f.saved(id).warnings.filter(row => row.code === 'price_not_applied');

test('a price saved but not recorded stays with its visit when a plan edit moves it, and later price edits still apply', async () => {
  const f = recurringFixture(), { result } = await f.create({ pricePerVisitCents:14500, horizonDays:10 }), id = result.plan.id, restore = loseRecords(f);
  await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  restore();
  const [visit] = priced(f);
  assert.deepEqual([visit.date, f.saved(id).occurrences['2026-09-30'].price.status, visit.estimate.amountCents], ['2026-09-30', 'pending', 14500]);
  // A weekday edit that moves the visit and leaves its price alone.
  let current = f.saved(id);
  await f.plan({ action:'update', planId:id, expectedRevision:current.revision, applyToBooked:true, plan:{ startDate:'2026-09-24' } });
  const moved = await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  assert.deepEqual(moved.plans[0].updated.map(row => [row.from, row.date]), [['2026-09-30', '2026-10-01']]);
  assert.deepEqual(moved.plans[0].priced.filter(row => row.jobId === visit.id).map(row => [row.date, row.status, row.reason || null]), [['2026-10-01', 'applied', null]]);
  const entry = f.saved(id).occurrences['2026-10-01'];
  assert.deepEqual([entry.jobId, entry.price.status, entry.price.requestId], [visit.id, 'applied', visit.moneyRequestId]);
  assert.deepEqual(saveIds(f, visit.id), [visit.moneyRequestId], 'the landed save is recognised at the new date, never repeated');
  assert.deepEqual(notApplied(f, id), []);
  // The next price edit re-prices the moved visit from that save.
  current = f.saved(id);
  await f.plan({ action:'update', planId:id, expectedRevision:current.revision, applyToBooked:true, plan:{ pricePerVisitCents:16000 } });
  const repriced = await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  assert.deepEqual(repriced.plans[0].priced.filter(row => row.jobId === visit.id).map(row => [row.date, row.status, row.reason || null]), [['2026-10-01', 'applied', null]]);
  assert.equal(f.job(visit.id).estimate.amountCents, 16000);
  assert.equal(saveIds(f, visit.id)[1], await occurrenceRequestId(id, `job:${visit.id}`, `price:${await priceKey(f.saved(id))}:${visit.moneyRequestId}`));
  assert.deepEqual(notApplied(f, id), []);
});

test('a move and price edit saved while that visit estimate save is running is applied after it, at the new date', async () => {
  const f = recurringFixture(), { result } = await f.create({ pricePerVisitCents:14500, horizonDays:10 }), id = result.plan.id, commit = f.store.commit;
  let raced = false;
  // The edit commits after the estimate.save checked its receipt, before that save commits.
  f.store.commit = async writes => {
    if (!raced && writes.some(write => write.collection === 'moneyOperations')) { raced = true; f.store.commit = commit; const current = f.saved(id); await f.plan({ action:'update', planId:id, expectedRevision:current.revision, applyToBooked:true, plan:{ startDate:'2026-09-24', pricePerVisitCents:16000 } }); }
    return commit(writes);
  };
  await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  f.store.commit = commit;
  assert.equal(raced, true);
  // The older price landed, and the run's pending prices then applied the edit's price after it.
  const [visit] = priced(f), saves = saveIds(f, visit.id);
  assert.equal(saves.length, 2);
  assert.equal(saves[1], await occurrenceRequestId(id, `job:${visit.id}`, `price:${await priceKey(f.saved(id))}:${saves[0]}`), 'the landed save is chained onto the entry the edit moved');
  assert.deepEqual([f.job(visit.id).date, f.job(visit.id).estimate.amountCents, f.job(visit.id).moneyRequestId], ['2026-09-30', 16000, saves[1]]);
  const queued = f.saved(id).occurrences['2026-10-01'];
  assert.deepEqual([queued.jobId, queued.price.status, queued.price.requestId, 'apply' in queued], [visit.id, 'applied', saves[1], true]);
  const second = await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  assert.deepEqual(second.plans[0].updated.map(row => [row.from, row.date]), [['2026-09-30', '2026-10-01']]);
  assert.deepEqual(second.plans[0].priced.filter(row => row.jobId === visit.id), []);
  assert.deepEqual([f.job(visit.id).date, f.job(visit.id).estimate.amountCents], ['2026-10-01', 16000]);
  assert.equal(saveIds(f, visit.id).length, 2);
  assert.deepEqual(notApplied(f, id), []);
});

test('a new visit booked on a date a moved visit left gets its own price save', async () => {
  const f = recurringFixture(), { result } = await f.create({ pricePerVisitCents:14500, horizonDays:10 }), id = result.plan.id;
  await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  const [first] = priced(f);
  let current = f.saved(id);
  await f.plan({ action:'update', planId:id, expectedRevision:current.revision, applyToBooked:true, plan:{ startDate:'2026-09-24' } });
  await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  assert.equal(f.job(first.id).date, '2026-10-01');
  // Back to Wednesdays at a new time, leaving booked visits where they are: 2026-09-30 is booked again.
  current = f.saved(id);
  await f.plan({ action:'update', planId:id, expectedRevision:current.revision, plan:{ startDate:'2026-09-23', time:'09:00', endTime:'11:00' } });
  const run = await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  const [again] = priced(f).filter(job => job.date === '2026-09-30');
  assert.ok(again && again.id !== first.id);
  assert.deepEqual(run.plans[0].priced.filter(row => row.jobId === again.id).map(row => [row.date, row.status, row.reason || null]), [['2026-09-30', 'applied', null]]);
  assert.equal(f.job(again.id).estimate.amountCents, 14500);
  assert.notEqual(f.job(again.id).moneyRequestId, f.job(first.id).moneyRequestId, 'the two visits never share a price request');
  assert.deepEqual(notApplied(f, id), []);
});

test('a price saved but not recorded, then changed without applyToBooked, is kept as the visit price without a false warning', async () => {
  const f = recurringFixture(), { result } = await f.create({ pricePerVisitCents:14500, horizonDays:10 }), id = result.plan.id, restore = loseRecords(f);
  await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  restore();
  const [visit] = priced(f), queuedKey = f.saved(id).occurrences['2026-09-30'].price.key;
  const current = f.saved(id);
  const edit = await f.plan({ action:'update', planId:id, expectedRevision:current.revision, plan:{ pricePerVisitCents:16000 } });
  assert.ok(edit.warnings.some(row => row.code === 'generated_visits_unchanged'));
  const run = await extendHorizon(f.store, manager, { pricing:true, now:NOW });
  assert.deepEqual(run.plans[0].priced.map(row => [row.date, row.status, row.reason || null]), [['2026-09-30', 'applied', null]]);
  assert.equal(f.job(visit.id).estimate.amountCents, 14500, 'the visit keeps the price it already has');
  assert.deepEqual(['status', 'key', 'requestId'].map(key => f.saved(id).occurrences['2026-09-30'].price[key]), ['applied', queuedKey, visit.moneyRequestId]);
  assert.deepEqual(saveIds(f, visit.id), [visit.moneyRequestId]);
  assert.deepEqual(notApplied(f, id), []);
});
