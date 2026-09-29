import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RECURRING_HORIZON_ACTOR, RECURRING_HORIZON_COMMAND, planManagerSession, runRecurringHorizonCommand } from '../functions/_lib/recurring-horizon-command.js';
import { signOperationsEnvelope } from '../functions/_lib/operations-envelope.js';
import { onRequestPost as portal } from '../functions/api/operations-portal.js';
import { extendHorizon, planHasWork, recurringPlansOverview } from '../functions/_lib/recurring-plan-service.js';
import { NOW, PROFILES, manager, recurringFixture } from './helpers/recurring-fixture.mjs';

const worker = { id:RECURRING_HORIZON_ACTOR, kind:'integration', role:'integration', workspace:'egc' };
const ENV = { EGC_RECURRING_PLANS_ENABLED:'true' };
const command = (extra = {}) => ({ command:RECURRING_HORIZON_COMMAND, ...extra });
const run = (f, body = command(), { now = NOW, env = ENV, actor = worker, profiles = PROFILES } = {}) => runRecurringHorizonCommand(env, actor, body, { now, runId:randomUUID(), storage:() => f.store, profiles:() => profiles });
const rejects = (promise, code, status) => assert.rejects(promise, error => { assert.equal(error.code, code); assert.equal(error.message, code); assert.equal(error.status, status); return true; });

test('only the recurring-horizon-worker integration actor can run the horizon command', async () => {
  const f = recurringFixture(); await f.create();
  const before = f.commits.length;
  for (const actor of [{ ...worker, id:'booking-adoption-worker' }, { ...worker, id:'mcp-oauth-grant:owner' }, { id:'zacb', kind:'human', role:'owner', workspace:'egc' }, { ...worker, kind:'human' }, { ...worker, role:'manager' }, null])
    await rejects(run(f, command(), { actor }), 'recurring_horizon_internal_only', 403);
  for (const body of [command({ now:'2027-01-01T00:00:00.000Z' }), command({ maxPlans:0 }), command({ maxPlans:26 }), command({ limit:21 }), command({ after:'_egc_schedule_lock_2026-09-23' }), command({ actor:worker }), { command:'recurring.extend' }, null])
    await rejects(run(f, body), 'recurring_horizon_invalid', 400);
  await rejects(run(f, command(), { now:'not a time' }), 'recurring_clock_invalid', 503);
  assert.equal(f.commits.length, before, 'refused commands never write');
});

test('the Hub flag keeps the command a no-op that reads nothing', async () => {
  const f = recurringFixture(); await f.create();
  let touched = false;
  const result = await runRecurringHorizonCommand({}, worker, command(), { now:NOW, storage:() => { touched = true; return f.store; }, profiles:() => PROFILES });
  assert.deepEqual({ ...result, runId:undefined }, { ok:true, authority:'employee_hub', command:RECURRING_HORIZON_COMMAND, asOf:NOW, runId:undefined, enabled:false, plans:[], complete:true, more:false, after:null });
  assert.equal(touched, false);
});

test('two runs with the same clock create every missing visit once and nothing the second time', async () => {
  const f = recurringFixture(), { result } = await f.create();
  const first = await run(f);
  assert.equal(first.enabled, true); assert.equal(first.complete, true); assert.equal(first.more, false);
  assert.deepEqual(first.plans.map(row => [row.planId, row.created, row.complete]), [[result.plan.id, 3, true]]);
  const dates = () => f.jobs().filter(job => job.recurringPlanId === result.plan.id).map(job => job.date).sort();
  assert.deepEqual(dates(), ['2026-09-30', '2026-10-07', '2026-10-14']);
  const commits = f.commits.length, rows = f.rows.size;
  const second = await run(f);
  assert.deepEqual(second.plans, [], 'a plan with nothing due is not even visited');
  assert.equal(second.complete, true); assert.equal(f.commits.length, commits); assert.equal(f.rows.size, rows);
  // A run whose response was lost part-way (the worker retries with the same clock) books nothing twice.
  const g = recurringFixture(), other = await g.create(), commit = g.store.commit;
  let lost = 0;
  g.store.commit = async writes => { await commit(writes); if (lost++ === 1) throw Object.assign(new Error('lost'), { code:'dispatch_outcome_unknown', status:503 }); };
  await run(g).catch(() => null);
  g.store.commit = commit;
  const retried = await run(g);
  assert.equal(retried.complete, true); assert.ok(lost > 1, 'a commit response was lost');
  assert.deepEqual(g.jobs().filter(job => job.recurringPlanId === other.result.plan.id).map(job => job.date).sort(), ['2026-09-30', '2026-10-07', '2026-10-14']);
  assert.deepEqual((await run(g)).plans, []);
  // An hour later the rolling window adds only the next date.
  const later = await run(f, command(), { now:'2026-09-29T12:00:00.000Z' });
  assert.equal(later.totals.created, 1); assert.deepEqual(dates(), ['2026-09-30', '2026-10-07', '2026-10-14', '2026-10-21']);
});

test('each call is bounded by maxPlans and limit and names where the next call resumes', async () => {
  const f = recurringFixture(), a = await f.create(), b = await f.plan({ action:'create', plan:{ templateJobId:(await f.book({ date:'2026-09-24' })).id, cadence:{ frequency:'weekly' }, horizonDays:14 } });
  const c = await f.plan({ action:'create', plan:{ templateJobId:(await f.book({ date:'2026-09-25', time:'13:00', endTime:'14:00' })).id, cadence:{ frequency:'weekly' }, horizonDays:14 } });
  const ids = [a.result.plan.id, b.plan.id, c.plan.id].sort();
  const first = await run(f, command({ maxPlans:2, limit:2 }));
  assert.deepEqual(first.plans.map(row => row.planId), ids.slice(0, 2)); assert.equal(first.totals.attempts, 2);
  assert.equal(first.more, true); assert.equal(first.complete, false);
  const second = await run(f, command({ maxPlans:2, limit:2, ...(first.after ? { after:first.after } : {}) }));
  assert.ok(second.totals.attempts <= 2);
  let calls = 2, last = second;
  while (last.more && calls < 10) { last = await run(f, command({ maxPlans:2, limit:2, ...(last.after ? { after:last.after } : {}) })); calls++; }
  assert.equal(last.more, false); assert.ok(calls < 10);
  for (const id of ids) assert.ok(f.jobs().some(job => job.recurringPlanId === id), id);
  assert.equal(f.jobs().filter(job => job.recurringPlanId).length, 3 + 1 + 1, 'three weekly visits in 28 days, one each in 14 days');
  assert.deepEqual((await run(f)).plans, []);
});

test('visits are created for the manager who last saved the plan, and never for someone who lost that role', async () => {
  const f = recurringFixture(), { result } = await f.create();
  const demoted = PROFILES.map(profile => profile.user === 'zacb' ? { ...profile, role:'sales' } : profile);
  const blocked = await run(f, command(), { profiles:demoted });
  assert.deepEqual(blocked.plans.map(row => [row.blocked, row.created]), [['recurring_plan_manager_inactive', 0]]);
  assert.equal(f.saved(result.plan.id).lastRun.code, 'recurring_plan_manager_inactive');
  const commits = f.commits.length;
  await run(f, command(), { profiles:demoted });
  assert.equal(f.commits.length, commits, 'the same block is not rewritten every hour');
  assert.equal(f.jobs().filter(job => job.recurringPlanId).length, 0);
  // A current manager saves the plan and becomes accountable for later runs.
  const current = f.saved(result.plan.id);
  await f.plan({ action:'update', planId:current.id, expectedRevision:current.revision, plan:{ horizonDays:35 } }, NOW, { enabled:true }, { user:'tylerg', displayName:'Synthetic Manager', role:'manager', businessAccess:true });
  const resumed = await run(f, command(), { profiles:demoted });
  assert.equal(resumed.totals.created, 4);
  assert.ok(f.jobs().filter(job => job.recurringPlanId).every(job => job.createdBy === 'tylerg'));
  assert.equal(f.saved(result.plan.id).lastRun.status, 'ok');
  assert.throws(() => planManagerSession({ updatedBy:'outside' }, [{ user:'outside', role:'manager', businessAccess:true }], worker), error => error.code === 'recurring_plan_manager_inactive');
  assert.throws(() => planManagerSession({ updatedBy:'tylerg' }, [...PROFILES, { user:'tylerg', role:'manager', businessAccess:true }], worker), error => error.code === 'recurring_plan_manager_inactive');
  assert.deepEqual({ ...planManagerSession({ createdBy:'TylerG' }, PROFILES, worker) }, { user:'tylerg', displayName:'Synthetic Manager', role:'manager', businessAccess:true, source:'recurring_horizon', via:'cron', actorId:RECURRING_HORIZON_ACTOR, actorKind:'integration', delegatedBy:RECURRING_HORIZON_ACTOR });
});

test('the command reports ids and counts only, and relays only namespaced error codes', async () => {
  const f = recurringFixture(); await f.create();
  const result = await run(f);
  assert.equal(/Synthetic|Street|555-01|14500|estimate/.test(JSON.stringify(result)), false, JSON.stringify(result));
  f.store.recurringPlans = async () => { throw Object.assign(new Error('socket token=synthetic-secret'), { code:'ECONNRESET' }); };
  await rejects(run(f), 'recurring_horizon_unavailable', 503);
  f.store.recurringPlans = async () => { throw Object.assign(new Error('Dispatch storage is unavailable.'), { code:'dispatch_storage_unavailable', status:503 }); };
  await rejects(run(f), 'dispatch_storage_unavailable', 503);
});

test('scheduled runs price visits only while MONEY_API_ENABLED is on, audited via cron under the plan manager', async () => {
  const f = recurringFixture(), { result } = await f.create({ pricePerVisitCents:14500, horizonDays:10 });
  const off = await run(f);
  assert.deepEqual([off.totals.created, off.totals.priced, off.complete], [1, 0, true]);
  assert.equal(f.all('moneyOperations').length, 0); assert.equal(f.all('hub_audit').length, 0);
  assert.deepEqual((await run(f)).plans, [], 'a price waiting for money writes is not work for the hourly run');
  const on = await run(f, command(), { env:{ ...ENV, MONEY_API_ENABLED:'true' } });
  assert.deepEqual([on.totals.priced, on.complete], [1, true]);
  const audits = f.all('hub_audit');
  assert.deepEqual(audits.map(row => [row.via, row.actor.id, row.actor.kind, row.action]), [['cron', 'zacb', 'human', 'money.estimate.save']]);
  assert.equal(f.jobs().find(job => job.recurringPlanId === result.plan.id).estimate.amountCents, 14500);
});

test('plans that keep failing without progress are passed over, so every later plan still gets its turn', async () => {
  const f = recurringFixture(), env = { ...ENV, MONEY_API_ENABLED:'true' }, ids = [];
  for (const [customerId, date] of [['c1', '2026-09-23'], ['c2', '2026-09-24'], ['c1', '2026-09-25']]) ids.push((await f.plan({ action:'create', plan:{ templateJobId:(await f.book({ date }, { customerId })).id, cadence:{ frequency:'weekly' }, horizonDays:14, pricePerVisitCents:14500 } })).plan.id);
  ids.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  // The first two plans' estimate saves always fail with an unknown outcome.
  const failing = new Set(ids.slice(0, 2)), commit = f.store.commit;
  f.store.commit = async writes => { const job = writes.find(write => write.collection === 'jobs'); if (writes.some(write => write.collection === 'moneyOperations') && failing.has(f.job(job.id)?.recurringPlanId)) throw Object.assign(new Error('down'), { code:'dispatch_storage_unavailable', status:503 }); return commit(writes); };
  const call = after => run(f, command({ maxPlans:3, limit:2, ...(after ? { after } : {}) }), { env });
  const first = await call(null);
  assert.deepEqual(first.plans.map(row => [row.planId, row.created, row.attempts]), [[ids[0], 1, 1], [ids[1], 1, 1], [ids[2], 0, 0]]);
  assert.deepEqual([first.more, first.after], [true, null], 'the failing plans still made progress, so the call resumes from them');
  const second = await call(first.after);
  assert.deepEqual(second.plans.map(row => [row.planId, row.created, row.priced, row.attempts, row.retryable]), [[ids[0], 0, 0, 1, true], [ids[1], 0, 0, 1, true], [ids[2], 0, 0, 0, false]]);
  assert.deepEqual([second.more, second.after], [true, ids[1]], 'plans that only retried are passed over');
  const third = await call(second.after);
  assert.deepEqual(third.plans.map(row => [row.planId, row.created, row.priced, row.complete]), [[ids[2], 1, 1, true]]);
  assert.deepEqual([third.more, third.after], [false, null]);
  // The next cycle retries each failing plan once more and ends.
  const again = await call(null);
  assert.deepEqual([again.plans.map(row => row.planId), again.totals.attempts, again.more], [ids.slice(0, 2), 2, false]);
});

test('plans are paged in code-unit id order, the order the after cursor uses', async () => {
  const f = recurringFixture(), a = await f.create(), b = await f.plan({ action:'create', plan:{ templateJobId:(await f.book({ date:'2026-09-24' }, { customerId:'c2' })).id, cadence:{ frequency:'weekly' }, horizonDays:14 } });
  // Ids that differ by letter case: 'plan_B' is before 'plan_a' by code unit and after it by locale.
  for (const [from, to] of [[a.result.plan.id, 'plan_a'], [b.plan.id, 'plan_B']]) { f.rows.set('recurringPlans/' + to, { ...f.rows.get('recurringPlans/' + from), id:to }); f.rows.delete('recurringPlans/' + from); }
  const first = await run(f, command({ maxPlans:1 }));
  assert.deepEqual([first.plans.map(row => row.planId), first.more, first.after], [['plan_B'], true, 'plan_B']);
  const second = await run(f, command({ maxPlans:1, after:first.after }));
  assert.deepEqual([second.plans.map(row => row.planId), second.more], [['plan_a'], false]);
  assert.ok(f.jobs().some(job => job.recurringPlanId === 'plan_a') && f.jobs().some(job => job.recurringPlanId === 'plan_B'));
});

test('calls in which every booked-visit change is dropped count as progress, so the plan is resumed at once', async () => {
  const f = recurringFixture(), { result } = await f.create({ horizonDays:60 }), id = result.plan.id;
  await extendHorizon(f.store, manager, { now:NOW, limit:20 });
  const visits = f.jobs().filter(job => job.recurringPlanId === id);
  assert.equal(visits.length, 8);
  const current = f.saved(id);
  await f.plan({ action:'update', planId:id, expectedRevision:current.revision, applyToBooked:true, plan:{ time:'09:00', endTime:'11:00' } });
  // Every booked visit is then retimed in Dispatch, so each pending change drops.
  for (const visit of visits) await f.mutate({ action:'schedule.update', jobId:visit.id, expectedRevision:f.job(visit.id).revision, changes:{ time:'07:00', endTime:'09:00' } });
  const first = await run(f, command({ limit:4 }));
  assert.deepEqual(first.plans.map(row => [row.planId, row.kept, row.updated, row.created, row.complete]), [[id, 4, 0, 0, false]]);
  assert.equal(first.totals.kept, 4);
  assert.deepEqual([first.more, first.after], [true, null], 'the plan is resumed in the next call, not passed over until the next hour');
  const second = await run(f, command({ limit:4 }));
  assert.deepEqual([second.totals.kept, second.complete, second.more], [4, true, false]);
  assert.equal(Object.values(f.saved(id).occurrences).some(entry => entry.apply), false);
  assert.ok(visits.every(visit => f.job(visit.id).time === '07:00'));
  assert.equal(f.saved(id).warnings.filter(row => row.code === 'booked_visit_not_updated' && row.reason === 'changed_in_dispatch').length, 8);
  assert.deepEqual((await run(f)).plans, []);
});

test('a date that keeps failing with a 5xx is recorded on the plan once, and a later run clears it', async () => {
  const f = recurringFixture(), { result } = await f.create({ horizonDays:17 }), id = result.plan.id;
  // A malformed schedule lock on the first due date: dispatch answers dispatch_lock_unavailable (503) for any change on that day.
  f.rows.set('jobs/_egc_schedule_lock_2026-09-30', { id:'_egc_schedule_lock_2026-09-30', recordType:'something_else', revision:'lock-r' });
  const first = await run(f);
  assert.deepEqual(first.plans.map(row => [row.planId, row.created, row.error]), [[id, 0, 'dispatch_lock_unavailable']]);
  assert.equal(first.totals.errors, 1);
  const stalled = f.saved(id);
  assert.deepEqual(['status','code','stage','date'].map(key => stalled.lastRun[key]), ['error', 'dispatch_lock_unavailable', 'create', '2026-09-30']);
  assert.match(stalled.lastRun.message, /could not be saved \(dispatch_lock_unavailable\)\. Each run retries it, and later visits wait for it\. If this continues, add 2026-09-30 as a skipped date/);
  // Later hourly runs retry it without rewriting the plan.
  for (const now of ['2026-09-22T13:00:00.000Z', '2026-09-22T14:00:00.000Z']) assert.equal((await run(f, command(), { now })).totals.errors, 1);
  assert.equal(f.saved(id).revision, stalled.revision, 'the same failure is recorded once');
  assert.equal(f.saved(id).warnings.filter(row => row.code === 'plan_run_failed').length, 1);
  const card = (await recurringPlansOverview(f.store, manager, {}, new Date(NOW), { enabled:true })).plans[0];
  assert.deepEqual([card.lastRun.status, card.lastRun.stage, card.lastRun.date], ['error', 'create', '2026-09-30']);
  assert.equal(f.jobs().filter(job => job.recurringPlanId === id).length, 0);
  // The manager skips that date, as the message says: the later visit is added and the plan runs clean again.
  const current = f.saved(id);
  await f.plan({ action:'update', planId:id, expectedRevision:current.revision, plan:{ skipDates:['2026-09-30'] } });
  const resumed = await run(f);
  assert.deepEqual([resumed.totals.created, resumed.totals.errors, resumed.complete], [1, 0, true]);
  assert.equal(f.saved(id).lastRun.status, 'ok');
  assert.deepEqual(f.jobs().filter(job => job.recurringPlanId === id).map(job => job.date), ['2026-10-07']);
  // A recorded failure with nothing left to add is still visited once, so the card clears.
  const g = recurringFixture(), other = await g.create({ horizonDays:10 }), otherId = other.result.plan.id;
  g.rows.set('jobs/_egc_schedule_lock_2026-09-30', { id:'_egc_schedule_lock_2026-09-30', recordType:'something_else', revision:'lock-r' });
  assert.equal((await run(g)).totals.errors, 1);
  const saved = g.saved(otherId);
  await g.plan({ action:'update', planId:otherId, expectedRevision:saved.revision, plan:{ skipDates:['2026-09-30'] } });
  assert.equal(planHasWork(g.saved(otherId), NOW), true);
  const cleared = await run(g);
  assert.deepEqual(cleared.plans.map(row => [row.planId, row.created, row.complete]), [[otherId, 0, true]]);
  assert.equal(g.saved(otherId).lastRun.status, 'ok');
  assert.deepEqual((await run(g)).plans, []);
});

test('a booked-visit move that keeps failing with a 5xx is recorded once, names its remedy, and saving the plan again cancels it', async () => {
  const f = recurringFixture(), { result } = await f.create({ horizonDays:10 }), id = result.plan.id;
  await run(f);
  const [visit] = f.jobs().filter(job => job.recurringPlanId === id);
  assert.deepEqual([visit.date, visit.time], ['2026-09-30', '08:00']);
  let current = f.saved(id);
  await f.plan({ action:'update', planId:id, expectedRevision:current.revision, applyToBooked:true, plan:{ startDate:'2026-09-24' } });
  // A malformed schedule lock on the visit's own day: dispatch answers dispatch_lock_unavailable (503) for the move only.
  f.rows.set('jobs/_egc_schedule_lock_2026-09-30', { id:'_egc_schedule_lock_2026-09-30', recordType:'something_else', revision:'lock-r' });
  const first = await run(f);
  assert.deepEqual(first.plans.map(row => [row.planId, row.updated, row.created, row.error]), [[id, 0, 0, 'dispatch_lock_unavailable']]);
  const stalled = f.saved(id);
  assert.deepEqual(['status','code','stage','date'].map(key => stalled.lastRun[key]), ['error', 'dispatch_lock_unavailable', 'apply', '2026-09-30']);
  assert.equal(stalled.lastRun.message, 'The 2026-09-30 visit could not be moved to follow the plan (dispatch_lock_unavailable). Each run retries it, and new visits wait for it. To cancel this move, save the plan again without "Also move booked visits" (the visit keeps its current time and crew), or give the visit a new date or time yourself in Dispatch.');
  // Later hourly runs retry it without rewriting the plan, and add no visits meanwhile.
  assert.equal((await run(f, command(), { now:'2026-09-22T13:00:00.000Z' })).totals.errors, 1);
  assert.equal(f.saved(id).revision, stalled.revision, 'the same failure is recorded once');
  assert.equal(f.saved(id).warnings.filter(row => row.code === 'plan_run_failed').length, 1);
  const card = (await recurringPlansOverview(f.store, manager, {}, new Date(NOW), { enabled:true })).plans[0];
  assert.deepEqual([card.lastRun.stage, card.lastRun.message], ['apply', stalled.lastRun.message]);
  assert.deepEqual(f.jobs().filter(job => job.recurringPlanId === id).map(job => job.date), ['2026-09-30']);
  // The manager saves the plan again without applyToBooked, as the message says: the move is cancelled,
  // the visit keeps its time, and the next run adds the new visits and clears the failure.
  current = f.saved(id);
  const saved = await f.plan({ action:'update', planId:id, expectedRevision:current.revision, plan:{ startDate:'2026-09-24' } });
  assert.ok(saved.warnings.some(row => row.code === 'booked_visits_update_cancelled'));
  const resumed = await run(f);
  assert.deepEqual([resumed.totals.created, resumed.totals.updated, resumed.totals.errors, resumed.complete], [2, 0, 0, true]);
  assert.equal(f.saved(id).lastRun.status, 'ok');
  assert.deepEqual([f.job(visit.id).date, f.job(visit.id).time], ['2026-09-30', '08:00']);
  assert.deepEqual(f.jobs().filter(job => job.recurringPlanId === id).map(job => job.date).sort(), ['2026-09-24', '2026-09-30', '2026-10-01']);
  assert.deepEqual((await run(f)).plans, []);
});

test('a visit price that keeps failing with a 5xx is recorded, and later visits are still priced', async () => {
  const f = recurringFixture(), { result } = await f.create({ pricePerVisitCents:14500, horizonDays:17 }), id = result.plan.id, env = { ...ENV, MONEY_API_ENABLED:'true' };
  await run(f);
  const visits = f.jobs().filter(job => job.recurringPlanId === id).sort((a, b) => a.date.localeCompare(b.date));
  assert.equal(visits.length, 2);
  // The first visit's estimate saves always fail with an unknown outcome.
  const commit = f.store.commit;
  f.store.commit = async writes => { if (writes.some(write => write.collection === 'moneyOperations') && writes.some(write => write.id === visits[0].id)) throw Object.assign(new Error('down'), { code:'dispatch_storage_unavailable', status:503 }); return commit(writes); };
  const first = await run(f, command(), { env });
  assert.deepEqual(first.plans.map(row => [row.priced, row.retryable]), [[1, true]]);
  assert.equal(f.job(visits[1].id).estimate.amountCents, 14500, 'the later visit is priced past the failing one');
  const saved = f.saved(id);
  assert.deepEqual(['status','code','stage','date'].map(key => saved.lastRun[key]), ['error', 'dispatch_storage_unavailable', 'price', visits[0].date]);
  await run(f, command(), { env, now:'2026-09-22T13:00:00.000Z' });
  assert.equal(f.saved(id).warnings.filter(row => row.code === 'plan_run_failed').length, 1);
  f.store.commit = commit;
  const fixed = await run(f, command(), { env, now:'2026-09-22T14:00:00.000Z' });
  assert.deepEqual([fixed.totals.priced, fixed.complete], [1, true]);
  assert.equal(f.saved(id).lastRun.status, 'ok');
});

const KEY = 'isolated-recurring-horizon-portal-key-0123456789';
async function signed(actor, body, env, iat) {
  const claims = { v:1, iss:'portal', aud:'egc-portal', iat, nonce:randomUUID(), actor, request:{ requestId:randomUUID(), body } };
  const response = await portal({ request:new Request('https://portal.test/api/operations-portal', { method:'POST', body:JSON.stringify({ envelope:await signOperationsEnvelope(claims, KEY) }) }), env });
  return { status:response.status, body:await response.json() };
}

test('the signed portal endpoint runs the command with the envelope clock and refuses other actors', async t => {
  t.mock.timers.enable({ apis:['Date'], now:Date.parse(NOW) });
  const hosts = [], bodies = [];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(String(input)); hosts.push(url.pathname.split('/').pop()); bodies.push(String(options.body || ''));
    assert.equal(url.hostname, 'firestore.googleapis.com');
    return new Response(JSON.stringify({ documents:[] }), { status:200, headers:{ 'Content-Type':'application/json' } });
  });
  const env = { EGC_OPERATIONS_ENABLED:'true', EGC_OPERATIONS_PORTAL_SIGNING_SECRET:KEY, FIREBASE_API_KEY:'firebase-test-recurring-horizon' }, iat = Math.floor(Date.parse(NOW) / 1000) - 30;
  const off = await signed(worker, command(), env, iat);
  assert.equal(off.status, 200); assert.equal(off.body.enabled, false); assert.equal(off.body.asOf, '2026-09-22T11:59:30.000Z'); assert.deepEqual(hosts, []);
  const on = await signed(worker, command({ maxPlans:5 }), { ...env, EGC_RECURRING_PLANS_ENABLED:'true' }, iat);
  assert.equal(on.status, 200); assert.equal(on.body.enabled, true); assert.equal(on.body.asOf, '2026-09-22T11:59:30.000Z', 'now comes from the signed envelope, not the request body or server clock');
  assert.deepEqual(hosts, ['recurringPlans']);
  // SEC-04: the shared bridge policy refuses every other caller before the command runs
  // (runRecurringHorizonCommand keeps its own recurring_horizon_internal_only check, tested above).
  hosts.length = 0;
  assert.deepEqual(await signed({ id:'zacb', kind:'human', role:'owner', workspace:'egc' }, command(), { ...env, EGC_RECURRING_PLANS_ENABLED:'true' }, iat), { status:403, body:{ error:'bridge_role_forbidden' } });
  for (const id of ['booking-adoption-worker', 'mcp-service-grant'])
    assert.deepEqual(await signed({ ...worker, id }, command(), { ...env, EGC_RECURRING_PLANS_ENABLED:'true' }, iat), { status:403, body:{ error:'bridge_integration_forbidden' } }, id);
  assert.deepEqual(hosts, [], 'A refused caller never reaches storage.');
  // BRIDGE-ADOPT-AUTHZ (merge): an id no service mints is refused by the issuer binding, before the command policy;
  // the only write is its create-only bridge.issuer_refused hub_audit entry.
  bodies.length = 0;
  assert.deepEqual(await signed({ ...worker, id:'recurring-horizon-worker-2' }, command(), { ...env, EGC_RECURRING_PLANS_ENABLED:'true' }, iat), { status:403, body:{ error:'bridge_integration_issuer_unknown' } });
  assert.deepEqual(hosts, ['documents:commit'], 'The refused id reaches storage only for its audit entry.');
  assert.match(bodies[0], /\/documents\/hub_audit\//); assert.match(bodies[0], /bridge\.issuer_refused/); assert.doesNotMatch(bodies[0], /recurringPlans/);
  hosts.length = 0;
  assert.deepEqual(await signed(worker, command({ limit:99 }), { ...env, EGC_RECURRING_PLANS_ENABLED:'true' }, iat), { status:400, body:{ error:'recurring_horizon_invalid' } });
  assert.deepEqual(await signed({ ...worker, workspace:'other' }, command(), { ...env, EGC_RECURRING_PLANS_ENABLED:'true' }, iat), { status:403, body:{ error:'workspace_forbidden' } });
});
