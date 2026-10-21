// REP-WALKTHROUGH (owner decision 2026-10-21): a door-to-door rep who may run walkthroughs does the walkthrough at the
// door themselves ("Do the walkthrough now"). The Hub visit is booked to the rep, the walkthrough app opens on it by its
// Hub id, and when the rep signs it the job pays the rep's door-sale 25% alone: never the setter 13% plus an estimator's
// 7%. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NOW, MIN, bridgeWorld, id, iso } from './helpers/knock-bridge-fixture.mjs';
import { projectSetterAttribution, repRanWalkthrough } from '../functions/_lib/knock-setters.js';
import { channelLedger } from '../functions/_lib/estimator-commission.js';
import { commissionCsv, periodStatement } from '../crew/knock-money.js';
import { channelOf, commissionFor } from '../functions/_lib/job-actuals.js';
import { createJobAssignmentAccess } from '../functions/_lib/job-assignment.js';
import { assignedDuring } from '../functions/_lib/field-execution-visits.js';

const TODAY = '2026-10-20';
const visits = w => w.docs('jobs/').filter(row => row.type === 'walkthrough');

// A shift, a "Walkthrough set" door and the rep's own walkthrough, tapped at 11:00 Denver time (NOW).
function selfRunBatch({ n = 2904, walk = {} } = {}) {
  const shiftId = id(), knockId = id(), walkId = id();
  return { walkId, events: [
    { id: id(), type: 'shift.start', shiftId, cityKey: 'fort-collins', at: iso(NOW - 30 * MIN) },
    { id: knockId, type: 'knock', shiftId, houseId: `h-${n}-blue-leaf-dr`, outcome: 'walkthrough_set', carOutside: false, at: iso(NOW - 2 * MIN) },
    { id: walkId, type: 'walkthrough', knockId, houseId: `h-${n}-blue-leaf-dr`, at: iso(NOW - MIN), customer: { name: `Kim Synthetic ${n}`, phone: '970-555-1904', email: 'kim@example.invalid' },
      date: TODAY, time: '11:00', selfRun: true, textConsent: true, note: 'Wants it all priced today', ...walk },
  ] };
}

test('Knock offers "Do the walkthrough now" only to a rep who may run walkthroughs, and only with the bridge on', async () => {
  const w = await bridgeWorld();
  assert.equal((await w.me()).body.viewer.walkthroughNow, true, 'Rep One holds the Sales role');
  assert.equal((await w.me(w.cookies.two)).body.viewer.walkthroughNow, undefined, 'Rep Two is crew');
  const off = await bridgeWorld({ bridge: false });
  assert.equal((await off.me()).body.viewer.walkthroughNow, undefined);
});

test('the rep\'s own walkthrough is booked to them today at the tapped time and opens by its Hub id; the setter record says they ran it', async () => {
  const w = await bridgeWorld();
  const { walkId, events } = selfRunBatch();
  const synced = await w.send(events);
  assert.deepEqual(synced.body.results.map(row => row.status), ['applied', 'applied', 'applied'], JSON.stringify(synced.body));
  const record = w.fake.get(`knock_walkthroughs/${walkId}`);
  assert.deepEqual([record.selfRun, record.requested.source, record.requested.time], [true, 'self', '11:00']);

  const booked = await w.book('walkthrough', walkId);
  assert.equal(booked.status, 200, JSON.stringify(booked.body));
  const [visit] = visits(w);
  assert.deepEqual([visit.date, visit.time, visit.endTime, visit.assignedCrew, visit.source, visit.d2d.repKey], [TODAY, '11:00', '12:00', ['rep.one'], 'door_to_door', 'rep.one']);
  assert.match(visit.operationalScope?.text || visit.jobInstructions || '', /done at the door by the Knock rep|Wants it all priced today/);
  assert.deepEqual(booked.body.booking, { kind: 'walkthrough', id: walkId, status: 'booked', date: TODAY, time: '11:00', endTime: '12:00', estimator: 'Rep',
    message: 'Your walkthrough is ready: open it and walk the garage with the customer.', selfRun: true, walkthroughId: visit.id });
  assert.doesNotMatch(JSON.stringify(booked.body), /kim@example|555-1904|\+1970/, 'no customer contact in the answer the phone opens the walkthrough from');

  // Assigned to the rep themselves: the rule the walkthrough app's visit lookup and crew home use.
  const me = createJobAssignmentAccess(w.env, { user: 'Rep.One', displayName: 'Rep One' }), bea = createJobAssignmentAccess(w.env, { user: 'Est.Bea', displayName: 'Bea Estimator' });
  assert.deepEqual([await assignedDuring(visit, TODAY, TODAY, me), await assignedDuring(visit, TODAY, TODAY, bea)], [true, false]);
  const setter = w.fake.get(`knock_setters/${visit.id}`);
  assert.deepEqual([setter.setterKey, setter.estimatorKey, setter.selfRun, setter.repStaffKey], ['rep.one', 'rep.one', true, 'rep.one']);
  // A repeat (a lost answer) answers the same booking.
  const again = await w.book('walkthrough', walkId);
  assert.deepEqual([again.body.booking.selfRun, again.body.booking.walkthroughId, visits(w).length], [true, visit.id, 1]);
});

test('a rep who may not run walkthroughs, or a visit the Hub will not book to them, gets an estimator instead (13% + 7% as before)', async () => {
  const w = await bridgeWorld();
  const { walkId, events } = selfRunBatch({ n: 2906 });
  events.forEach(event => { if (event.type === 'knock' || event.type === 'walkthrough') event.houseId = 'h-2906-blue-leaf-dr'; });
  const synced = await w.send(events, w.cookies.two);
  assert.deepEqual(synced.body.results.map(row => row.status), ['applied', 'applied', 'applied'], JSON.stringify(synced.body));
  const booked = await w.book('walkthrough', walkId, w.cookies.two);
  assert.equal(booked.status, 200, JSON.stringify(booked.body));
  assert.equal(booked.body.booking.selfRun, undefined);
  assert.equal(booked.body.booking.walkthroughId, undefined, 'another estimator\'s visit is never handed to the rep');
  const [visit] = visits(w);
  assert.ok(['est.alex', 'est.bea'].includes(visit.assignedCrew[0]), JSON.stringify(visit.assignedCrew));
  const setter = w.fake.get(`knock_setters/${visit.id}`);
  assert.deepEqual([setter.setterKey, Object.hasOwn(setter, 'selfRun')], ['rep.two', false]);
});

test('a "do it now" walkthrough needs the tapped time and no estimator slot', async () => {
  const w = await bridgeWorld();
  const missing = selfRunBatch({ walk: { time: undefined, dayPart: 'am' } });
  const refused = await w.send(missing.events);
  assert.equal(refused.body.results[2].status, 'rejected');
  assert.match(refused.body.results[2].error, /time you start it/);
  const typed = selfRunBatch({ n: 2900, walk: { selfRun: 'yes' } });
  assert.equal((await w.send(typed.events)).body.results[2].status, 'rejected');
});

// ---------- commission ----------

const TERMS = { verified: true, approvedAt: '2026-10-20T16:00:00.000Z', reference: 'synthetic' };
const job = (signer, extra = {}) => ({ id: 'job-9', revision: 'r', type: 'job', status: 'scheduled', date: '2026-10-19', sourceWalkthroughId: 'walk-9',
  handoffVersion: 1, handoffRequestId: 'req-9', serviceType: 'Garage transformation', scope: { finish: ['cleanout', 'shelving'] },
  estimate: { status: 'accepted', amount: 3000, acceptedAt: '2026-10-17T15:00:00Z' }, acceptance: { recordedBy: signer, acceptedAt: '2026-10-17T14:55:00Z' },
  payment: { amount: 3000, verified: true, stripeSessions: [{ sessionId: 'cs_test_9', paymentIntentId: 'pi_9', amount: 3000, purpose: 'balance', verifiedAt: '2026-10-19T20:00:00Z' }] }, ...extra });
const visit = { id: 'walk-9', revision: 'r', type: 'walkthrough', status: 'completed', convertedJobId: 'job-9', walkthroughOutcome: { outcome: 'sold_on_site' }, assignedCrew: ['rep.one'] };
const selfRecord = (extra = {}) => ({ id: 'walk-9', walkthroughId: 'walk-9', setterKey: 'rep.one', serviceClassification: 'unverified', classificationReference: '',
  estimatorKey: 'rep.one', estimatorReference: 'knock-walkthrough:kw-9', channel: 'appointment_setter', requestId: 'kw-9', recordedBy: 'knock-bridge',
  recordedAt: '2026-10-16T18:00:00Z', source: 'knock_walkthrough', selfRun: true, repStaffKey: 'rep.one', ...extra });
const project = (record, signedBy) => projectSetterAttribution(record, visit, job(signedBy), [], Date.parse('2026-10-21T18:00:00Z'), TERMS);

test('the rep ran and signed it: one door-sale share of 25% to the rep, and no estimator share at all', () => {
  const row = project(selfRecord(), 'Rep.One');
  assert.deepEqual([row.channel, row.state, row.rate, row.estimatorKey, row.earnedCommission, row.projectedCommission], ['direct_sale', 'earned', 0.25, null, 750, 750]);
  assert.deepEqual(row.allocations.map(share => [share.role, share.repKey, share.amountCents]), [['direct_rep', 'rep.one', 75000]], 'one share, never 13% + 7% or 25% + 7%');
  assert.equal(repRanWalkthrough(selfRecord(), job('Rep.One')), true);
  // The statement pays it as the rep's walkthrough, in its own column, and nothing to an estimator.
  const ledger = channelLedger({ setters: { rows: [row] } });
  assert.deepEqual(ledger.items.map(item => [item.repKey, item.role, item.amount]), [['rep.one', 'direct_rep', 750]]);
  const period = { key: '2026-10-19_2026-11-01', start: '2026-10-19', end: '2026-11-01' };
  const statement = periodStatement({ reps: [{ repKey: 'rep.one', displayName: 'Rep One', status: 'active' }], settings: { commission: { verified: true }, payroll: {} }, period, channels: ledger.items });
  assert.deepEqual(statement.map(r => [r.repKey, r.earned, r.doorWalkthroughCommission, r.setterCommission, r.estimatorCommission]), [['rep.one', 750, 750, 0, 0]]);
  const [header, line] = commissionCsv(statement, period).trim().split('\r\n');
  assert.match(header, /,setter_commission_included,estimator_commission_included,door_walkthrough_commission_included$/);
  assert.match(line, /,0\.00,0\.00,750\.00$/);
});

test('anyone else signed it (an estimator took it over): the ordinary door-set split, 13% to the rep and 7% to the signer', () => {
  const row = project(selfRecord({ estimatorKey: '' }), 'Estimator.One');
  assert.deepEqual([row.channel, row.estimatorKey], ['appointment_setter', 'estimator.one']);
  assert.deepEqual(row.allocations.map(share => [share.role, share.repKey, share.amountCents]), [['setter', 'rep.one', 39000], ['estimator', 'estimator.one', 21000]]);
  assert.equal(repRanWalkthrough(selfRecord(), job('Estimator.One')), false);
  // A record the bridge did not mark as the rep's own never pays 25%, whoever signed it.
  assert.equal(repRanWalkthrough(selfRecord({ selfRun: undefined }), job('Rep.One')), false);
  assert.equal(repRanWalkthrough(selfRecord({ repStaffKey: 'Not A Key!' }), job('Rep.One')), false);
});

test('a door sale also linked to the job is held for review, never paid twice; junk removal still earns nothing', () => {
  const linked = projectSetterAttribution(selfRecord(), visit, job('Rep.One'), [{ repKey: 'rep.one', handoff: { job: { ref: 'job-9' } } }], Date.parse('2026-10-21T18:00:00Z'), TERMS);
  assert.deepEqual([linked.state, linked.earnedCommission, linked.reviewReasons.includes('direct_close_attribution_conflict')], ['review_required', null, true]);
  const junk = project(selfRecord({ serviceClassification: 'junk_removal' }), 'Rep.One');
  assert.deepEqual([junk.state, junk.earnedCommission], ['excluded', 0]);
});

test('job actuals: a walkthrough the rep ran is the door-sale channel (25% only); the other channels are unchanged', () => {
  const base = { id: 'job-9', sourceWalkthroughId: 'walk-9' };
  assert.equal(channelOf(base, { setterWalkthroughs: new Set(['walk-9']), repWalkthroughJobs: new Set(['job-9']) }), 'door_sale');
  assert.equal(channelOf(base, { setterWalkthroughs: new Set(['walk-9']) }), 'appointment_setter');
  assert.equal(channelOf(base, {}), 'direct_estimator');
  assert.equal(channelOf({ id: 'job-1' }, {}), 'none');
  const door = commissionFor(300000, 'door_sale');
  assert.deepEqual(door.lines.map(line => [line.role, line.cents]), [['door', 75000]], '25% and nothing else');
  assert.ok(!door.lines.some(line => line.role === 'estimator'));
  assert.deepEqual(commissionFor(300000, 'appointment_setter').lines.map(line => [line.role, line.cents]), [['setter', 39000], ['estimator', 21000]]);
  assert.deepEqual(commissionFor(300000, 'direct_estimator').lines.map(line => [line.role, line.cents]), [['estimator', 21000]]);
});

// ---------- the phone ----------

test('the phone opens the walkthrough app on the Hub visit by id once it is booked to the rep, and tells the rep when an estimator was booked instead', async () => {
  globalThis.document ??= { getElementById: () => null };
  const { install, openOwnWalkthrough } = await import('../crew/knock-walkthrough.js');
  const answers = [Object.assign(new Error('not synced yet'), { status: 404 }), { booking: { status: 'booked', selfRun: true, walkthroughId: 'visit_42' } }];
  const calls = [];
  install({ S: { settings: { integrations: { walkthroughUrl: '/crew/gameplan' } } }, fixers: {}, syncBeforeLeaving: async () => {},
    api: async (path, init) => { calls.push([path, init.body]); const next = answers.shift(); if (next instanceof Error) throw next; return next; } });
  const opened = [];
  await openOwnWalkthrough('walk-1', { wait: 5000, open: url => opened.push(url) });
  assert.deepEqual(opened, ['/crew/gameplan?walkthroughId=visit_42'], 'only the opaque Hub id travels in the address');
  assert.deepEqual(calls.map(([path, body]) => [path, body.kind, body.id]), [['/api/knock-job-bridge', 'walkthrough', 'walk-1'], ['/api/knock-job-bridge', 'walkthrough', 'walk-1']]);
  answers.push({ booking: { status: 'booked', estimator: 'Bea', message: 'Walkthrough booked: Mon Oct 26, 10:00 am with Bea' } });
  const instead = await openOwnWalkthrough('walk-2', { wait: 5000, open: url => opened.push(url) });
  assert.deepEqual([opened.length, instead.estimator], [1, 'Bea'], 'an estimator\'s visit is never opened on the rep\'s phone');
});
