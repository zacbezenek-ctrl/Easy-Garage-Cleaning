// REP-WALKTHROUGH (owner decision 2026-10-21): a door-to-door rep who may run walkthroughs does the walkthrough at the
// door themselves ("Do the walkthrough now"). The Hub visit is booked to the rep, the walkthrough app opens on it by its
// Hub id, and when the rep signs it the job pays the rep's door-sale 25% alone: never the setter 13% plus an estimator's
// 7%. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NOW, MIN, USERS, bridgeWorld, id, iso } from './helpers/knock-bridge-fixture.mjs';
const USERS_JSON = JSON.stringify(USERS);
import { projectSetterAttribution, repRanWalkthrough } from '../functions/_lib/knock-setters.js';
import { channelLedger } from '../functions/_lib/estimator-commission.js';
import { commissionCsv, periodStatement } from '../crew/knock-money.js';
import { channelOf, commissionFor } from '../functions/_lib/job-actuals.js';
import { createJobAssignmentAccess } from '../functions/_lib/job-assignment.js';
import { assignedDuring } from '../functions/_lib/field-execution-visits.js';
import { selfRunVisit } from '../functions/_lib/knock-self-walkthrough.js';

const TODAY = '2026-10-20', MON_SET = '2026-10-26';
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

// Knock Admin > Walkthroughs: an admin turns it on for one rep (no Hub role changes).
const turnOn = (w, repKey = 'rep.two', on = true) => w.admin({ action: 'rep.update', repKey, changes: { walkthroughSelf: on } });

test('Knock offers "Do the walkthrough now" to a rep an admin turned Walkthroughs on for (no Sales role needed), and only with the bridge on', async () => {
  const w = await bridgeWorld();
  // Rep One holds the Sales role without the staff-role switches: the walkthrough app does not open for that, so no button.
  assert.equal((await w.me()).body.viewer.walkthroughNow, undefined, 'a Sales role the walkthrough app refuses gets no button');
  const roles = await bridgeWorld({ env: { EGC_STAFF_ROLE_ACCESS: 'true' } });
  assert.equal((await roles.me()).body.viewer.walkthroughNow, true, 'with role access an estimator runs walkthroughs: the button');
  assert.equal((await w.me(w.cookies.two)).body.viewer.walkthroughNow, undefined, 'Rep Two is crew, with Walkthroughs off: no button');
  const on = await turnOn(w);
  assert.equal(on.status, 200, JSON.stringify(on.body));
  const stored = w.fake.get('knock_reps/rep.two');
  assert.deepEqual([stored.walkthroughSelf, stored.walkthroughSelfBy, typeof stored.walkthroughSelfAt], [true, 'ZacB', 'string'], 'who turned it on, and when');
  const me = (await w.me(w.cookies.two)).body;
  assert.deepEqual([me.viewer.walkthroughNow, me.rep.walkthroughSelf], [true, true]);
  // Only an admin turns it on, and only with yes or no.
  assert.equal((await w.admin({ action: 'rep.update', repKey: 'rep.two', changes: { walkthroughSelf: true } }, w.cookies.rep)).status, 403);
  assert.equal((await w.admin({ action: 'rep.update', repKey: 'rep.two', changes: { walkthroughSelf: 'yes' } })).status, 400);
  await turnOn(w, 'rep.two', false);
  assert.equal((await w.me(w.cookies.two)).body.viewer.walkthroughNow, undefined, 'turned off again: no button');
  assert.deepEqual(w.fake.get('knock_reps/rep.two').walkthroughSelfLog.map(row => [row.on, row.by]), [[true, 'ZacB'], [false, 'ZacB']], 'every change is kept, not just the last');
  const off = await bridgeWorld({ bridge: false });
  await turnOn(off);
  assert.equal((await off.me(off.cookies.two)).body.viewer.walkthroughNow, undefined);
});

test('the rep\'s own walkthrough is booked to them today at the tapped time and opens by its Hub id; the setter record says they ran it', async () => {
  const w = await bridgeWorld();
  await turnOn(w, 'rep.one');
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
  const clock = { now: () => new Date(NOW) }, me = createJobAssignmentAccess(w.env, { user: 'Rep.One', displayName: 'Rep One' }, clock), bea = createJobAssignmentAccess(w.env, { user: 'Est.Bea', displayName: 'Bea Estimator' }, clock);
  assert.deepEqual([await assignedDuring(visit, TODAY, TODAY, me), await assignedDuring(visit, TODAY, TODAY, bea)], [true, false]);
  const setter = w.fake.get(`knock_setters/${visit.id}`);
  // No estimator recorded: the rep is never their own estimator (an estimator who takes it over is, by signing it).
  assert.deepEqual([setter.setterKey, setter.estimatorKey, setter.estimatorReference, setter.selfRun, setter.repStaffKey], ['rep.one', '', '', true, 'rep.one']);
  assert.equal(visit.d2d.selfRun, true, 'the mark that lets the rep open it in the walkthrough app');
  // A repeat (a lost answer) answers the same booking.
  const again = await w.book('walkthrough', walkId);
  assert.deepEqual([again.body.booking.selfRun, again.body.booking.walkthroughId, visits(w).length], [true, visit.id, 1]);
});

test('a crew rep with Walkthroughs on is booked to their own walkthrough, and is never put in the estimator pool for anyone else\'s', async () => {
  const w = await bridgeWorld();
  await turnOn(w);
  const own = selfRunBatch({ n: 2906 });
  own.events.forEach(event => { if (event.houseId) event.houseId = 'h-2906-blue-leaf-dr'; });
  assert.deepEqual((await w.send(own.events, w.cookies.two)).body.results.map(row => row.status), ['applied', 'applied', 'applied']);
  const booked = await w.book('walkthrough', own.walkId, w.cookies.two);
  assert.equal(booked.status, 200, JSON.stringify(booked.body));
  const [visit] = visits(w);
  assert.deepEqual([booked.body.booking.selfRun, booked.body.booking.walkthroughId, visit.assignedCrew, visit.d2d.selfRun], [true, visit.id, ['rep.two'], true]);
  // Rep One sets an ordinary walkthrough for an estimator at 11:00 the same day: never Rep Two, who is free then too.
  const set = selfRunBatch({ n: 2900, walk: { selfRun: undefined, date: MON_SET, time: undefined, dayPart: 'am' } });
  set.events.forEach(event => { if (event.houseId) event.houseId = 'h-2900-blue-leaf-dr'; });
  assert.deepEqual((await w.send(set.events)).body.results.map(row => row.status), ['applied', 'applied', 'applied']);
  const other = await w.book('walkthrough', set.walkId);
  assert.equal(other.status, 200, JSON.stringify(other.body));
  const estimatorVisit = visits(w).find(row => row.id !== visit.id);
  assert.ok(['est.alex', 'est.bea'].includes(estimatorVisit.assignedCrew[0]), JSON.stringify(estimatorVisit.assignedCrew));
  assert.equal(estimatorVisit.d2d.selfRun, undefined);
});

test('privacy: a Knock-only rep\'s "do it now" on a customer the Hub already has goes to an estimator, and the phone learns nothing about that customer', async () => {
  const w = await bridgeWorld();
  await turnOn(w);
  // The Hub already has this customer (Rep One set an ordinary walkthrough for them on Monday).
  const first = selfRunBatch({ n: 2904, walk: { selfRun: undefined, date: MON_SET, time: undefined, dayPart: 'am' } });
  assert.deepEqual((await w.send(first.events)).body.results.map(row => row.status), ['applied', 'applied', 'applied']);
  assert.equal((await w.book('walkthrough', first.walkId)).status, 200);
  const known = w.docs('customers/');
  assert.equal(known.length, 1);
  // Rep Two types that phone and one matching name word (a surname, which links) at another house, and taps "Do the walkthrough now".
  const probe = selfRunBatch({ n: 2906, walk: { customer: { name: 'Pat Synthetic', phone: '970-555-1904', email: '' } } });
  probe.events.forEach(event => { if (event.houseId) event.houseId = 'h-2906-blue-leaf-dr'; });
  assert.deepEqual((await w.send(probe.events, w.cookies.two)).body.results.map(row => row.status), ['applied', 'applied', 'applied']);
  const booked = await w.book('walkthrough', probe.walkId, w.cookies.two);
  assert.equal(booked.status, 200, JSON.stringify(booked.body));
  assert.equal(booked.body.booking.selfRun, undefined);
  assert.equal(booked.body.booking.walkthroughId, undefined, 'no visit id to open');
  assert.match(booked.body.booking.message, /^An estimator will do this one\. /);
  assert.doesNotMatch(booked.body.booking.message, /already|customer|Hub/i, 'never says the customer was known');
  const answer = JSON.stringify(booked.body);
  for (const stored of ['Synthetic 2904', 'kim@example.invalid', '2904', known[0].id, 'customer_']) assert.ok(!answer.includes(stored), `the answer never carries ${stored}`);
  // The visit is an estimator's, carries no self-run mark, and the rep's walkthrough right never opens it.
  const visit = visits(w).find(row => row.knockWalkthroughId === probe.walkId);
  assert.ok(['est.alex', 'est.bea'].includes(visit.assignedCrew[0]), JSON.stringify(visit.assignedCrew));
  assert.equal(visit.d2d.selfRun, undefined);
  assert.equal(selfRunVisit(visit, { user: 'Rep.Two' }), false);
  assert.equal(Object.hasOwn(w.fake.get(`knock_setters/${visit.id}`), 'selfRun'), false, 'an ordinary 13% + 7% walkthrough');
  // A new customer still self-runs for the same rep.
  const fresh = selfRunBatch({ n: 2902, walk: { customer: { name: 'Lee Fresh 2902', phone: '970-555-1902', email: 'lee@example.invalid' } } });
  fresh.events.forEach(event => { if (event.houseId) event.houseId = 'h-2902-blue-leaf-dr'; });
  assert.deepEqual((await w.send(fresh.events, w.cookies.two)).body.results.map(row => row.status), ['applied', 'applied', 'applied']);
  const own = await w.book('walkthrough', fresh.walkId, w.cookies.two);
  assert.equal(own.body.booking.selfRun, true, JSON.stringify(own.body));
});

test('an owner or manager who taps "Do the walkthrough now" on their own door is booked to it; an admin booking another rep\'s door books an estimator', async () => {
  const w = await bridgeWorld({ seed: {
    'knock_reps/zacb': { repKey: 'zacb', username: 'ZacB', displayName: 'Zac', role: 'admin', status: 'active', permitListed: true, premiumCleared: true, leadKey: '' },
    'knock_assignments/zacb__english-ranch__all': { repKey: 'zacb', neighborhoodId: 'english-ranch', street: '', active: true } } });
  assert.equal((await w.me(w.cookies.zac)).body.viewer.walkthroughNow, true);
  const mine = selfRunBatch({ n: 2902 });
  mine.events.forEach(event => { if (event.houseId) event.houseId = 'h-2902-blue-leaf-dr'; });
  assert.deepEqual((await w.send(mine.events, w.cookies.zac)).body.results.map(row => row.status), ['applied', 'applied', 'applied']);
  const booked = await w.book('walkthrough', mine.walkId, w.cookies.zac);
  assert.equal(booked.status, 200, JSON.stringify(booked.body));
  assert.deepEqual([booked.body.booking.selfRun, visits(w)[0].assignedCrew], [true, ['zacb']]);
  // Rep Two (Walkthroughs off) taps it; the phone's booking waits, and the admin books it from Admin > Sales: an estimator.
  const theirs = selfRunBatch({ n: 2906, walk: { customer: { name: 'Lee Synthetic 2906', phone: '970-555-1906', email: 'lee@example.invalid' } } });
  theirs.events.forEach(event => { if (event.houseId) event.houseId = 'h-2906-blue-leaf-dr'; });
  assert.deepEqual((await w.send(theirs.events, w.cookies.two)).body.results.map(row => row.status), ['applied', 'applied', 'applied']);
  const byAdmin = await w.book('walkthrough', theirs.walkId, w.cookies.zac);
  assert.equal(byAdmin.status, 200, JSON.stringify(byAdmin.body));
  const visit = visits(w).find(row => row.id !== visits(w)[0].id);
  assert.ok(['est.alex', 'est.bea'].includes(visit.assignedCrew[0]), JSON.stringify(visit.assignedCrew));
  assert.equal(byAdmin.body.booking.selfRun, undefined);
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
// knock-setter-v2 (owner decision 2026-10-30): earned when the job is completed and paid in full, so the job was completed
// on its day before the balance was paid (was 'scheduled': paid in full used to be enough).
const job = (signer, extra = {}) => ({ id: 'job-9', revision: 'r', type: 'job', status: 'completed', completedAt: '2026-10-19T18:00:00Z', date: '2026-10-19', sourceWalkthroughId: 'walk-9',
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

// #215: an estimator who may see only masked customers (a quote author without booking rights) never gets a known
// customer's record through "Do the walkthrough now".
test('a restricted estimator\'s "do it now" on a customer the Hub already has goes to an estimator, with nothing stored in the answer', async () => {
  const users = JSON.parse(USERS_JSON);
  users['Rep.One'] = { ...users['Rep.One'], staffRoles: ['sales'] };
  const w = await bridgeWorld({ env: { EGC_STAFF_ROLE_PERMISSIONS: 'true', HUB_AUTH_USERS_JSON: JSON.stringify(users) } });
  assert.equal((await w.me()).body.viewer.walkthroughNow, true, 'a quote author gets the button');
  // Rep Two sets an ordinary walkthrough for the customer on Monday: the Hub now has them.
  const first = selfRunBatch({ n: 2904, walk: { selfRun: undefined, date: MON_SET, time: undefined, dayPart: 'am' } });
  assert.deepEqual((await w.send(first.events, w.cookies.two)).body.results.map(row => row.status), ['applied', 'applied', 'applied']);
  assert.equal((await w.book('walkthrough', first.walkId, w.cookies.two)).status, 200);
  const known = w.docs('customers/')[0];
  const probe = selfRunBatch({ n: 2906, walk: { customer: { name: 'Pat Synthetic', phone: '970-555-1904', email: '' } } });
  probe.events.forEach(event => { if (event.houseId) event.houseId = 'h-2906-blue-leaf-dr'; });
  assert.deepEqual((await w.send(probe.events)).body.results.map(row => row.status), ['applied', 'applied', 'applied']);
  const booked = await w.book('walkthrough', probe.walkId);
  assert.equal(booked.status, 200, JSON.stringify(booked.body));
  assert.deepEqual([booked.body.booking.selfRun, booked.body.booking.walkthroughId], [undefined, undefined]);
  assert.match(booked.body.booking.message, /^An estimator will do this one\. /);
  const answer = JSON.stringify(booked.body);
  for (const stored of ['Synthetic 2904', 'kim@example.invalid', '2904', known.id]) assert.ok(!answer.includes(stored), stored);
  const visit = visits(w).find(row => row.knockWalkthroughId === probe.walkId);
  assert.notDeepEqual(visit.assignedCrew, ['rep.one']);
  assert.equal(visit.d2d.selfRun, undefined);
});

test('an office Book in Hub after a lost answer keeps the rep\'s own walkthrough theirs: the setter record still pays them as the rep who ran it', async () => {
  const w = await bridgeWorld({ seed: { 'knock_reps/rep.two': { repKey: 'rep.two', username: 'Rep.Two', displayName: 'Rep Two', role: 'knocker', status: 'active', permitListed: true, premiumCleared: false, leadKey: '', walkthroughSelf: true } } });
  const own = selfRunBatch({ n: 2906 });
  own.events.forEach(event => { if (event.houseId) event.houseId = 'h-2906-blue-leaf-dr'; });
  assert.deepEqual((await w.send(own.events, w.cookies.two)).body.results.map(row => row.status), ['applied', 'applied', 'applied']);
  // The rep's booking saves the visit, but its answer is lost before Knock records it (no booking, no setter record).
  const booked = await w.book('walkthrough', own.walkId, w.cookies.two);
  assert.equal(booked.body.booking.selfRun, true);
  const [visit] = visits(w);
  w.fake.documents.delete(`knock_setters/${visit.id}`);
  w.fake.documents.delete(`knock_receipts/setter_${own.walkId}`);
  const { revision, ...lost } = w.fake.get(`knock_walkthroughs/${own.walkId}`);
  w.fake.put(`knock_walkthroughs/${own.walkId}`, { ...lost, status: 'set', booking: { status: 'review', code: 'synthetic_lost_answer', jobId: '', date: '', time: '', endTime: '', estimator: '', at: null, by: '' } });
  // Before this fix the office's booking read the saved visit back without its self-run mark (13% + 7%, held for review).
  // The office books it from Admin > Sales: the saved visit is found by its receipt and stays the rep's.
  const office = await w.book('walkthrough', own.walkId, w.cookies.zac);
  assert.equal(office.status, 200, JSON.stringify(office.body));
  const setter = w.fake.get(`knock_setters/${visit.id}`);
  assert.deepEqual([setter?.selfRun, setter?.repStaffKey, setter?.estimatorKey], [true, 'rep.two', ''], JSON.stringify(setter));
  assert.equal(visits(w).length, 1, 'no second visit');
});

test('a lost answer, then the office gives the visit to an estimator: the rep\'s retry and Book in Hub record an ordinary 13% + 7% walkthrough', async () => {
  const w = await bridgeWorld({ seed: { 'knock_reps/rep.two': { repKey: 'rep.two', username: 'Rep.Two', displayName: 'Rep Two', role: 'knocker', status: 'active', permitListed: true, premiumCleared: false, leadKey: '', walkthroughSelf: true } } });
  const own = selfRunBatch({ n: 2906 });
  own.events.forEach(event => { if (event.houseId) event.houseId = 'h-2906-blue-leaf-dr'; });
  assert.deepEqual((await w.send(own.events, w.cookies.two)).body.results.map(row => row.status), ['applied', 'applied', 'applied']);
  assert.equal((await w.book('walkthrough', own.walkId, w.cookies.two)).body.booking.selfRun, true);
  const [visit] = visits(w);
  assert.deepEqual([visit.d2d.selfRun, visit.d2d.selfRunKey], [true, 'rep.two']);
  // The answer was lost: Knock has no booking and no setter record. Then Dispatch gives the visit to an estimator.
  w.fake.documents.delete(`knock_setters/${visit.id}`);
  w.fake.documents.delete(`knock_receipts/setter_${own.walkId}`);
  const { revision, ...lost } = w.fake.get(`knock_walkthroughs/${own.walkId}`);
  const pending = { status: 'pending', jobId: '', date: '', time: '', endTime: '', estimator: '', at: null, by: '' };
  w.fake.put(`knock_walkthroughs/${own.walkId}`, { ...lost, status: 'set', booking: pending });
  const { revision: visitRevision, path: visitPath, ...hub } = visits(w)[0];
  w.fake.put(`jobs/${visit.id}`, { ...hub, assignedCrew: ['est.alex'], assignedTo: 'est.alex' });
  // The rep's phone asks again: the saved visit is found by its receipt, and it is no longer the rep's.
  const retry = await w.book('walkthrough', own.walkId, w.cookies.two);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.deepEqual([retry.body.booking.selfRun, retry.body.booking.walkthroughId], [undefined, undefined]);
  // And the office's Book in Hub answers the same booking.
  const office = await w.book('walkthrough', own.walkId, w.cookies.zac);
  assert.equal(office.status, 200, JSON.stringify(office.body));
  const setter = w.fake.get(`knock_setters/${visit.id}`);
  assert.deepEqual([setter.setterKey, setter.estimatorKey, Object.hasOwn(setter, 'selfRun'), Object.hasOwn(setter, 'repStaffKey')], ['rep.two', 'est.alex', false, false], JSON.stringify(setter));
  // The estimator signs it: 13% to the rep and 7% to the estimator, never 25% to the rep.
  const row = projectSetterAttribution({ ...setter, id: visit.id, walkthroughId: 'walk-9' }, { id: 'walk-9', revision: 'r', type: 'walkthrough', status: 'completed', convertedJobId: 'job-9', walkthroughOutcome: { outcome: 'sold_on_site' } },
    job('Est.Alex'), [], Date.parse('2026-10-21T18:00:00Z'), TERMS);
  assert.equal(row.channel, 'appointment_setter');
  assert.deepEqual(row.allocations.map(share => [share.role, share.repKey]), [['setter', 'rep.two'], ['estimator', 'est.alex']]);
  // A record carrying an estimator's key as the rep's never pays 25% (repKeyFor(repStaffKey) must be the setter).
  assert.equal(repRanWalkthrough({ selfRun: true, repStaffKey: 'est.alex', setterKey: 'rep.two' }, job('Est.Alex')), false);
});
