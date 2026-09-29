import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { walkthroughClosed, walkthroughStatus, walkthroughStatusFields, walkthroughCard, rebookPrefill, walkthroughRebooked } from '../functions/_lib/walkthrough-state.js';
import { walkthroughVisitProjection } from '../functions/_lib/walkthrough-visit.js';
import { dispatchOverview, projectDispatchJob } from '../functions/_lib/dispatch-service.js';
import { crewJobProjection, CREW_PROJECTION_FIELDS } from '../functions/_lib/crew-job-projection.js';
import { crewJobsHandlers, CREW_LISTING_FIELDS } from '../functions/api/crew-jobs.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import * as fieldJobs from '../functions/api/field-jobs.js';
import { storage } from './helpers/field-fixture.mjs';
import { maskJob, recurringFixture, manager, NOW } from './helpers/recurring-fixture.mjs';
import { hubPage } from './helpers/hub-dom.mjs';

// WT-OUTCOME: walkthrough outcomes the office can see, the shared closed rule, the rebook, and the rep's day.
// Synthetic data only; the clock is always injected.
const occurrence = (date = '2026-09-22', time = '09:00', startAt = '2026-09-22T15:00:00.000Z', scheduleOccurrence = 1) => ({ number: 1, date, time, startAt, scheduleOccurrence });
// The saved record exactly as FUN-05 writes it, with the rep's private notes and timecard detail as canaries.
const outcome = (value, reasonCode = null, extra = {}) => ({ outcome: value, reasonCode, finishedAt: '2026-09-22T15:40:00.000Z', performedBy: 'sales.rep', recordingStatus: 'declined', requestId: randomUUID(),
  clockSource: 'server', occurrence: occurrence(), repTime: { status: 'segment_closed', segmentId: 'segment-secret' }, typedNotes: ['SYNTHETIC-PRIVATE-NOTE'], ...extra });
const walk = (extra = {}) => ({ id: 'w1', revision: 'wr1', type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c1', customer: 'Synthetic Walkthrough Customer', phone: '(970) 555-0101',
  address: '100 Synthetic Lane, Fort Collins, CO', date: '2026-09-22', endDate: '2026-09-22', time: '09:00', endTime: '10:00', arrivalWindowStart: '08:30', arrivalWindowEnd: '09:30', assignedCrew: ['crew1'], scheduleOccurrence: 1,
  estimate: { amount: 1437 }, signatureData: 'SYNTHETIC-SIGNATURE', internalNotes: 'Synthetic private note', ...extra });
const WT_FIELDS = ['walkthroughOutcome', 'convertedJobId', 'rebookPending', 'walkthroughState', 'walkthroughClosed', 'walkthroughBadge', 'rebook'];
const CANARIES = ['SYNTHETIC-PRIVATE-NOTE', 'segment-secret', 'sales.rep', '1437', 'SYNTHETIC-SIGNATURE', 'Synthetic private note'];

// The rule on raw rows, with the expected state, closed flag and badge.
const MATRIX = [
  ['no outcome', walk(), 'open', false, ''],
  ['converted job', walk({ convertedJobId: 'job-sold', walkthroughCompletedAt: '2026-09-22T15:40:00.000Z', walkthroughOutcome: outcome('sold_on_site') }), 'sold', true, 'Sold → open job'],
  ['converted job with no outcome (legacy hand-off)', walk({ convertedJobId: 'job-legacy' }), 'sold', true, 'Sold → open job'],
  ['signed on site, hand-off unfinished', walk({ walkthroughOutcome: outcome('sold_on_site'), walkthroughCompletedAt: '2026-09-22T15:40:00.000Z' }), 'sold', true, 'Sold → open job'],
  ['lost on price', walk({ walkthroughOutcome: outcome('not_interested', 'price'), walkthroughCompletedAt: '2026-09-22T15:40:00.000Z' }), 'lost', true, 'Lost: Price'],
  ['lost to a competitor', walk({ walkthroughOutcome: outcome('not_interested', 'chose_competitor'), walkthroughCompletedAt: '2026-09-22T15:40:00.000Z' }), 'lost', true, 'Lost: Chose a competitor'],
  ['lost, unknown reason', walk({ walkthroughOutcome: outcome('not_interested', 'retired_code') }), 'lost', true, 'Lost'],
  ['quote to follow', walk({ walkthroughOutcome: outcome('quote_to_follow'), walkthroughCompletedAt: '2026-09-22T15:40:00.000Z' }), 'quote', true, 'Quote to follow'],
  ['completed with no outcome (legacy gameplan)', walk({ walkthroughCompletedAt: '2026-09-21T20:00:00.000Z' }), 'done', true, 'Walkthrough done'],
  ['customer no-show', walk({ walkthroughOutcome: outcome('customer_no_show', 'customer_not_home') }), 'no_show', false, 'No-show · rebook'],
  ['rescheduled at the door', walk({ walkthroughOutcome: outcome('rescheduled', 'weather') }), 'rescheduled', false, 'Rescheduled · rebook'],
  ['no-show moved to a new day', walk({ date: '2026-09-25', endDate: '2026-09-25', walkthroughOutcome: outcome('customer_no_show', 'no_access') }), 'open', false, ''],
  ['no-show moved later the same day', walk({ time: '13:00', endTime: '14:00', walkthroughOutcome: outcome('customer_no_show', 'unreachable') }), 'open', false, ''],
  ['no-show counted as a new placement', walk({ scheduleOccurrence: 2, walkthroughOutcome: outcome('customer_no_show', 'other') }), 'open', false, ''],
  ['cancelled in dispatch', walk({ status: 'cancelled', pipelineStatus: 'cancelled' }), 'cancelled', false, 'Cancelled'],
  ['cancelled after a sale keeps the sale', walk({ status: 'cancelled', pipelineStatus: 'cancelled', convertedJobId: 'job-sold' }), 'sold', true, 'Sold → open job'],
  ['a secure_ id is never a converted job', walk({ convertedJobId: 'secure_vault_row' }), 'open', false, ''],
];

test('the shared closed rule: a converted job, a final outcome or walkthroughCompletedAt closes a walkthrough', () => {
  for (const [label, row, state, closed, badge] of MATRIX) {
    assert.equal(walkthroughClosed(row), closed, label);
    const status = walkthroughStatus(row);
    assert.deepEqual([status.state, status.closed, status.badge], [state, closed, badge], label);
  }
  assert.equal(walkthroughClosed({ ...walk({ convertedJobId: 'job-1' }), type: 'job' }), false, 'only walkthroughs close this way');
  assert.equal(walkthroughClosed(null), false);
  // A moved no-show is FUN-05's rebookPending: the next Start records the new occurrence.
  for (const [label, row] of MATRIX) assert.equal(walkthroughRebooked(row), walkthroughVisitProjection(row).rebookPending, `${label}: same rebook rule as the visit record`);
});

test('the browser copy of the rule gives the same state, badge and rebook for every raw row', () => {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(new URL('../employee-walkthrough-state.js', import.meta.url), 'utf8'), context, { filename: 'employee-walkthrough-state.js' });
  const browser = context.EGCWalkthroughState;
  for (const [label, row] of MATRIX) {
    assert.deepEqual({ ...browser.status(JSON.parse(JSON.stringify(row))) }, walkthroughStatus(row), label);
    // A row that already carries the server's fields (a dispatch or crew DTO) keeps them.
    const dto = { id: row.id, type: 'walkthrough', status: row.status, ...walkthroughStatusFields(row) };
    assert.deepEqual({ ...browser.status(dto) }, walkthroughStatus(row), `${label} (DTO)`);
  }
  assert.equal(browser.status({ type: 'job' }), null);
  assert.deepEqual({ ...browser.action(walk()) }, { href: '/crew/gameplan.html?walkthroughId=w1', label: 'Start walkthrough', badge: '', state: 'open' });
  assert.deepEqual({ ...browser.action(walk({ convertedJobId: 'job sold/1' })) }, { href: '/crew/gameplan.html?walkthroughId=w1', label: 'Start walkthrough', badge: '', state: 'open' }, 'an id the Hub would refuse is ignored, as on the server');
  assert.deepEqual({ ...browser.action(walk({ convertedJobId: 'job-sold' })) }, { href: '/crew/job.html?jobId=job-sold', label: 'Open job', badge: 'Sold → open job', state: 'sold' });
  assert.deepEqual({ ...browser.action(walk({ convertedJobId: 'job-sold' }), { jobLink: false }) }, { href: '/crew/gameplan.html?walkthroughId=w1', label: 'Open walkthrough', badge: 'Sold → open job', state: 'sold' }, 'a rep opens the sold walkthrough, not a job they may not be on');
  assert.deepEqual({ ...browser.action(walk({ walkthroughOutcome: outcome('customer_no_show', 'customer_not_home') })) }, { href: '/crew/gameplan.html?walkthroughId=w1', label: 'Open walkthrough', badge: 'No-show · rebook', state: 'no_show' });
});

test('rebook prefill: a walkthrough no-show moves with a FUN-02 reason; a service-job no-show books again with its label', () => {
  assert.deepEqual(rebookPrefill(walk({ walkthroughOutcome: outcome('customer_no_show', 'customer_not_home') })), { reasonCode: 'customer_request', initiatedBy: 'customer', label: 'Customer not home', missedOn: '2026-09-22' });
  assert.deepEqual(rebookPrefill(walk({ walkthroughOutcome: outcome('customer_no_show', 'no_access') })), { reasonCode: 'access_issue', initiatedBy: 'customer', label: 'No access', missedOn: '2026-09-22' });
  assert.deepEqual(rebookPrefill(walk({ walkthroughOutcome: outcome('customer_no_show', 'wrong_address') })), { reasonCode: 'other', initiatedBy: null, label: 'Wrong address', missedOn: '2026-09-22' });
  assert.deepEqual(rebookPrefill(walk({ walkthroughOutcome: outcome('rescheduled', 'crew_unavailable') })), { reasonCode: 'crew_unavailable', initiatedBy: 'company', label: 'Rep or crew unavailable', missedOn: '2026-09-22' });
  assert.equal(rebookPrefill(walk({ date: '2026-09-25', walkthroughOutcome: outcome('customer_no_show', 'no_access') })), null, 'already moved');
  assert.equal(rebookPrefill(walk({ walkthroughOutcome: outcome('not_interested', 'price') })), null);
  assert.deepEqual(rebookPrefill({ type: 'job', status: 'no_show', noShowReasonCode: 'unreachable', date: '2026-09-21' }), { reasonCode: null, initiatedBy: null, label: 'Could not reach the customer', missedOn: '2026-09-21' });
  assert.equal(rebookPrefill({ type: 'job', status: 'scheduled' }), null);
});

test('dispatch and calendar DTOs project the outcome, converted job and badge from the masked production scan, and nothing private', async () => {
  const f = recurringFixture();
  const put = row => f.rows.set(`jobs/${row.id}`, row);
  put(walk({ id: 'w-open' }));
  put(walk({ id: 'w-noshow', time: '11:00', endTime: '12:00', walkthroughOutcome: outcome('customer_no_show', 'customer_not_home', { occurrence: occurrence('2026-09-22', '11:00', '2026-09-22T17:00:00.000Z') }) }));
  put(walk({ id: 'w-lost', time: '13:00', endTime: '14:00', walkthroughOutcome: outcome('not_interested', 'price'), walkthroughCompletedAt: '2026-09-22T15:40:00.000Z' }));
  put(walk({ id: 'w-quote', time: '15:00', endTime: '16:00', walkthroughOutcome: outcome('quote_to_follow'), walkthroughCompletedAt: '2026-09-22T15:40:00.000Z' }));
  put(walk({ id: 'w-sold', time: '16:00', endTime: '17:00', convertedJobId: 'job-sold', walkthroughOutcome: outcome('sold_on_site'), walkthroughCompletedAt: '2026-09-22T15:40:00.000Z' }));
  put({ id: 'job-missed', revision: 'jm1', type: 'job', status: 'no_show', pipelineStatus: 'no_show', customerId: 'c1', customer: 'Synthetic Customer', address: '100 Synthetic Street', date: '2026-09-22', endDate: '2026-09-22', time: '08:00', endTime: '10:00',
    assignedCrew: ['crew1'], noShowAt: '2026-09-22T15:10:00.000Z', noShowBy: 'zacb', noShowReasonCode: 'no_access', total: 1437 });
  const board = await dispatchOverview(f.store, manager, { startDate: '2026-09-22', endDate: '2026-09-23', includeUnscheduled: 'true' }, new Date(NOW));
  const dto = id => board.jobs.find(job => job.id === id);
  for (const field of WT_FIELDS) assert.equal(field in dto('w-open'), false, `an open walkthrough's DTO is the legacy one (${field})`);
  assert.deepEqual(dto('w-open'), projectDispatchJob(maskJob(f.rows.get('jobs/w-open')), f.roster, NOW), 'the legacy projection, field for field');
  assert.deepEqual(dto('w-noshow').walkthroughOutcome, { outcome: 'customer_no_show', reasonCode: 'customer_not_home', finishedAt: '2026-09-22T15:40:00.000Z' });
  assert.deepEqual([dto('w-noshow').walkthroughState, dto('w-noshow').walkthroughClosed, dto('w-noshow').walkthroughBadge, dto('w-noshow').rebookPending], ['no_show', false, 'No-show · rebook', false]);
  assert.deepEqual(dto('w-noshow').rebook, { reasonCode: 'customer_request', initiatedBy: 'customer', label: 'Customer not home', missedOn: '2026-09-22' });
  assert.deepEqual([dto('w-lost').walkthroughBadge, dto('w-lost').walkthroughClosed, dto('w-quote').walkthroughBadge, dto('w-sold').walkthroughBadge, dto('w-sold').convertedJobId], ['Lost: Price', true, 'Quote to follow', 'Sold → open job', 'job-sold']);
  assert.deepEqual([dto('job-missed').status, dto('job-missed').noShowReasonCode, dto('job-missed').rebook], ['no_show', 'no_access', { reasonCode: null, initiatedBy: null, label: 'No access', missedOn: '2026-09-22' }]);
  const text = JSON.stringify(board);
  for (const secret of CANARIES) assert.equal(text.includes(secret), false, secret);
  for (const key of ['performedBy', 'typedNotes', 'repTime', 'occurrence', 'walkthroughCompletedAt']) assert.equal(text.includes(`"${key}"`), false, key);
  // The single-job view (view=job) projects the same fields from the full document.
  const one = await dispatchOverview(f.store, manager, { view: 'job', jobId: 'w-lost' }, new Date(NOW));
  assert.deepEqual([one.job.walkthroughState, one.job.walkthroughBadge], ['lost', 'Lost: Price']);
  assert.equal(JSON.stringify(one).includes('SYNTHETIC-PRIVATE-NOTE'), false);
});

test('Rebook moves the same walkthrough with the prefilled reason; the visit is open again and FUN-05 agrees', async () => {
  const f = recurringFixture();
  f.rows.set('jobs/w1', walk({ walkthroughOutcome: outcome('customer_no_show', 'customer_not_home') }));
  const before = (await dispatchOverview(f.store, manager, { startDate: '2026-09-22', endDate: '2026-09-23' }, new Date(NOW))).jobs.find(job => job.id === 'w1');
  // What the Rebook dialog sends once the new day is picked: the same visit, schedule.update, the prefilled move reason.
  const result = await f.mutate({ action: 'schedule.update', jobId: 'w1', expectedRevision: before.revision, changes: { date: '2026-09-24', time: '10:00', endDate: '2026-09-24', endTime: '11:00' }, reasonCode: before.rebook.reasonCode, initiatedBy: before.rebook.initiatedBy });
  assert.deepEqual([result.job.id, result.job.walkthroughState, result.job.rebookPending, result.job.walkthroughBadge, 'rebook' in result.job], ['w1', 'open', true, '', false]);
  const saved = f.job('w1');
  assert.equal(walkthroughVisitProjection(saved).rebookPending, true, 'the rep\'s next Start records the rebooked occurrence');
  assert.equal(f.all('jobs').filter(row => row.type === 'walkthrough').length, 1, 'no second visit is created');
  const moved = f.all('funnelEvents').find(event => event.type === 'walkthrough.rescheduled');
  assert.deepEqual([moved?.data.reasonCode, moved?.data.initiatedBy], ['customer_request', 'customer'], 'the FUN-02 move reason is recorded');
  const after = (await dispatchOverview(f.store, manager, { startDate: '2026-09-24', endDate: '2026-09-25' }, new Date(NOW))).jobs.find(job => job.id === 'w1');
  assert.deepEqual([after.walkthroughState, after.walkthroughClosed, after.rebookPending], ['open', false, true]);
});

test('a service-job no-show is booked again from that job: schedule.create with sourceJobId', async () => {
  const f = recurringFixture();
  const missed = await f.book({ date: '2026-09-22', time: '08:00', endTime: '10:00' });
  const marked = await f.mutate({ action: 'schedule.no_show', jobId: missed.id, expectedRevision: f.job(missed.id).revision, reasonCode: 'customer_not_home' }, '2026-09-22T15:00:00.000Z');
  assert.deepEqual([marked.job.status, marked.job.noShowReasonCode, marked.job.rebook.label], ['no_show', 'customer_not_home', 'Customer not home']);
  const again = await f.mutate({ action: 'schedule.create', customerId: 'c1', kind: 'job', sourceJobId: missed.id, booking: { channel: 'hub_phone' }, changes: { date: '2026-09-25', time: '08:00', endTime: '10:00', opsNotes: 'Books the no-show on Tue, Sep 22 (Customer not home) again as a new visit.' } });
  assert.notEqual(again.job.id, missed.id);
  assert.deepEqual([again.job.status, again.job.customerId, f.job(again.job.id).customerAccountOwnerJobId], ['scheduled', 'c1', f.job(missed.id).customerAccountOwnerJobId || missed.id]);
  assert.equal(f.job(missed.id).status, 'no_show', 'the missed visit keeps its history');
});

test('the crew projection carries where an assigned walkthrough stands, the same from the masked scan', () => {
  for (const [label, row] of MATRIX) {
    const masked = maskJob({ ...row, id: row.id, revision: row.revision }, CREW_LISTING_FIELDS);
    assert.deepEqual(crewJobProjection(masked, { viewer: 'crew1', now: NOW }), crewJobProjection(row, { viewer: 'crew1', now: NOW }), label);
  }
  const card = crewJobProjection(walk({ walkthroughOutcome: outcome('not_interested', 'price'), walkthroughCompletedAt: '2026-09-22T15:40:00.000Z' }), { viewer: 'crew1', now: NOW });
  assert.deepEqual([card.type, card.phone, card.walkthroughState, card.walkthroughBadge], ['walkthrough', '(970) 555-0101', 'lost', 'Lost: Price']);
  const text = JSON.stringify(card);
  for (const secret of CANARIES) assert.equal(text.includes(secret), false, secret);
  for (const field of ['walkthroughOutcome.occurrence', 'convertedJobId', 'walkthroughCompletedAt']) assert.ok(CREW_PROJECTION_FIELDS.includes(field), field);
  assert.ok(!CREW_LISTING_FIELDS.some(field => field === 'walkthroughOutcome' || /typedNotes|performedBy|repTime/.test(field)), 'the rep\'s notes are never read');
  assert.equal('walkthroughState' in crewJobProjection({ ...walk(), type: 'job' }, { now: NOW }), false, 'jobs are unchanged');
});

test('crew-jobs gives a rep their walkthrough with its state and phone, and a manager row the same state', async () => {
  const rows = [walk({ assignedCrew: ['sales.rep'], walkthroughOutcome: outcome('quote_to_follow'), walkthroughCompletedAt: '2026-09-22T15:40:00.000Z' }), walk({ id: 'w2', assignedCrew: ['sales.two'] })];
  const env = { FIREBASE_API_KEY: 'firebase-test-wt-outcome' };
  const get = user => crewJobsHandlers({ session: async () => user, storage: () => ({ jobRecords: async fields => rows.map(row => maskJob(row, fields)) }), now: () => new Date(NOW) }).get({ request: new Request('https://easygaragecleaning.com/api/crew-jobs'), env });
  const rep = await (await get({ user: 'Sales.Rep', displayName: 'Synthetic Sales Rep', role: 'sales', businessAccess: false })).json();
  assert.deepEqual(rep.jobs.map(job => [job.id, job.walkthroughState, job.walkthroughBadge, job.phone]), [['w1', 'quote', 'Quote to follow', '(970) 555-0101']]);
  assert.equal(JSON.stringify(rep).includes('SYNTHETIC-PRIVATE-NOTE'), false);
  const office = await (await get({ user: 'ZacB', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true })).json();
  assert.deepEqual(office.jobs.map(job => [job.id, job.walkthroughState || 'open']), [['w1', 'quote'], ['w2', 'open']]);
  assert.equal('walkthroughState' in office.jobs[1], false, 'an open walkthrough row is unchanged for managers');
});

const fieldEnv = { HUB_SESSION_SECRET: 'wt-outcome-session-secret-synthetic', FIREBASE_API_KEY: 'firebase-test-wt-outcome', HUB_AUTH_USERS_JSON: JSON.stringify({
  ZacB: { passwordHash: 'unused-synthetic', role: 'owner', displayName: 'Synthetic Owner' },
  'Sales.Rep': { passwordHash: 'unused-synthetic', role: 'sales', displayName: 'Synthetic Sales Rep' },
  'Sales.Two': { passwordHash: 'unused-synthetic', role: 'sales', displayName: 'Synthetic Second Rep' },
  'Crew.One': { passwordHash: 'unused-synthetic', role: 'crew', displayName: 'Synthetic Crew' } }) };
const fieldCookies = new Map(await Promise.all(['ZacB', 'Sales.Rep', 'Sales.Two', 'Crew.One'].map(async user => [user, (await createHubSessionCookie(fieldEnv, user)).split(';')[0]])));
const fieldGet = async (user, search) => fieldJobs.onRequestGet({ env: fieldEnv, request: new Request(`https://easygaragecleaning.com/api/field-jobs${search}`, { headers: { Cookie: fieldCookies.get(user) } }) });

test('field-jobs lists a walkthrough only to its assigned rep, as a read-only card', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-22T14:00:00.000Z') });
  const store = storage(t);
  store.put('jobs/w1', walk({ id: undefined, assignedCrew: ['Sales.Rep'] }));
  store.put('jobs/w2', walk({ id: undefined, customer: 'Synthetic Second Customer', time: '13:00', endTime: '14:00', assignedCrew: ['Sales.Two'] }));
  store.put('jobs/w3', walk({ id: undefined, date: '2026-09-23', endDate: '2026-09-23', assignedCrew: ['Sales.Rep'], convertedJobId: 'job-sold', walkthroughOutcome: outcome('sold_on_site'), walkthroughCompletedAt: '2026-09-22T15:40:00.000Z' }));
  store.put('jobs/w4', walk({ id: undefined, date: '2026-09-23', endDate: '2026-09-23', time: '11:00', endTime: '12:00', assignedCrew: ['Sales.Rep'], convertedJobId: 'job-mine', walkthroughOutcome: outcome('sold_on_site'), walkthroughCompletedAt: '2026-09-22T15:40:00.000Z' }));
  store.put('jobs/w5', walk({ id: undefined, date: '2026-09-23', endDate: '2026-09-23', time: '13:00', endTime: '14:00', assignedCrew: ['Sales.Rep'], status: 'cancelled', pipelineStatus: 'cancelled' }));
  store.put('jobs/job-1', { type: 'job', customer: 'Synthetic Job Customer', phone: '9705550100', address: '5 Synthetic Ct', date: '2026-09-22', endDate: '2026-09-22', time: '08:00', endTime: '11:00', status: 'scheduled', assignedCrew: ['Crew.One'] });
  // The sold visits' jobs, after the listed days: one the rep is not on, one the rep also works.
  store.put('jobs/job-sold', { type: 'job', customer: 'Synthetic Walkthrough Customer', date: '2026-10-05', endDate: '2026-10-05', time: '08:00', endTime: '11:00', status: 'scheduled', assignedCrew: ['Crew.One'] });
  store.put('jobs/job-mine', { type: 'job', customer: 'Synthetic Walkthrough Customer', date: '2026-10-05', endDate: '2026-10-05', time: '12:00', endTime: '15:00', status: 'scheduled', assignedCrew: ['Sales.Rep'] });
  const list = async (user, search = '?date=2026-09-22&days=2&status=all') => { const response = await fieldGet(user, search); assert.equal(response.status, 200, user); return response.json(); };
  const rep = await list('Sales.Rep');
  assert.deepEqual(rep.jobs, [], 'a walkthrough is never a field job');
  assert.deepEqual(rep.walkthroughs.map(card => [card.id, card.walkthroughState, card.walkthroughBadge, card.convertedJobOpen]), [['w1', 'open', '', false], ['w3', 'sold', 'Sold → open job', false], ['w4', 'sold', 'Sold → open job', true], ['w5', 'cancelled', 'Cancelled', false]]);
  // convertedJobOpen is the job page's own rule: the rep opens job-mine, and job-sold (not theirs) is refused.
  assert.deepEqual([(await fieldGet('Sales.Rep', '?jobId=job-mine')).status, (await fieldGet('Sales.Rep', '?jobId=job-sold')).status], [200, 403]);
  const first = rep.walkthroughs[0];
  assert.deepEqual([first.customer, first.phone, first.address, first.date, first.time, first.endTime, first.arrivalWindowStart, first.arrivalWindowEnd, first.status], ['Synthetic Walkthrough Customer', '(970) 555-0101', '100 Synthetic Lane, Fort Collins, CO', '2026-09-22', '09:00', '10:00', '08:30', '09:30', 'scheduled']);
  assert.deepEqual(first, walkthroughCard({ ...store.get('jobs/w1'), id: 'w1' }));
  for (const secret of CANARIES) assert.equal(JSON.stringify(rep).includes(secret), false, secret);
  assert.deepEqual((await list('Sales.Two')).walkthroughs.map(card => card.id), ['w2']);
  assert.deepEqual((await list('ZacB')).walkthroughs, [], 'a manager\'s day lists only walkthroughs assigned to them');
  const crew = await list('Crew.One');
  assert.deepEqual([crew.jobs.map(job => job.id), crew.walkthroughs], [['job-1'], []]);
  assert.deepEqual((await list('Sales.Rep', '?date=2026-09-22&days=2&status=active')).walkthroughs.map(card => card.id), ['w1'], 'a closed walkthrough is not active work');
  assert.deepEqual((await list('Sales.Rep', '?date=2026-09-22&days=2&status=completed')).walkthroughs.map(card => card.id), ['w3', 'w4']);
  assert.deepEqual((await list('Sales.Rep', '?date=2026-09-22&days=2&status=cancelled')).walkthroughs.map(card => card.id), ['w5']);
  // The walkthrough stays read-only here: the job detail and actions refuse it as before.
  const detail = await fieldGet('Sales.Rep', '?jobId=w1');
  assert.deepEqual([detail.status, (await detail.json()).code], [404, 'FIELD_JOB_NOT_FOUND']);
});

test('the rep\'s cards in the Hub agenda and the gameplan Today list show the badge and a link, never Start, once closed', () => {
  let business = false;
  const context = vm.createContext({ encodeURIComponent, EGCHubAuth: { canRunBusiness: () => business } });
  context.window = context;
  vm.runInContext(readFileSync(new URL('../employee-walkthrough-state.js', import.meta.url), 'utf8'), context);
  const line = (file, prefix) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split(/\r?\n/).find(row => row.startsWith(prefix)) || assert.fail(prefix);
  vm.runInContext("const esc=v=>String(v==null?'':v).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));", context);
  vm.runInContext(line('employee-suite.js', 'function walkthroughLink('), context);
  vm.runInContext(line('crew/gameplan.html', 'function appointmentRow('), context);
  assert.equal(context.walkthroughLink(walk()), '<a href="/crew/gameplan.html?walkthroughId=w1">Start walkthrough →</a>');
  assert.equal(context.walkthroughLink(walk({ walkthroughOutcome: outcome('not_interested', 'price'), walkthroughCompletedAt: 'x' })), '<span class="ops-status ops-walk-badge">Lost: Price</span><a href="/crew/gameplan.html?walkthroughId=w1">Open walkthrough →</a>');
  assert.equal(context.walkthroughLink(walk({ convertedJobId: 'job-sold' })), '<span class="ops-status ops-walk-badge">Sold → open job</span><a href="/crew/job.html?jobId=job-sold">Open job →</a>');
  const open = context.appointmentRow(walk({ customer: '<b>Synthetic</b>' }), 3);
  assert.match(open, /^<button type="button" class="appointment" onclick="useAppointment\(3\)">/);
  assert.match(open, /&lt;b&gt;Synthetic&lt;\/b&gt;/);
  const noShow = context.appointmentRow(walk({ walkthroughOutcome: outcome('customer_no_show', 'customer_not_home') }), 0);
  assert.doesNotMatch(noShow, /<button|useAppointment/);
  assert.match(noShow, /data-outcome="no_show".*No-show · rebook.*<a href="\/crew\/gameplan\.html\?walkthroughId=w1">Open walkthrough<\/a>/);
  // The gameplan's Today list follows crew home: a rep opens the sold walkthrough; a business account opens its job.
  assert.match(context.appointmentRow(walk({ convertedJobId: 'job-sold' }), 0), /<a href="\/crew\/gameplan\.html\?walkthroughId=w1">Open walkthrough<\/a>/);
  business = true;
  assert.match(context.appointmentRow(walk({ convertedJobId: 'job-sold' }), 0), /<a href="\/crew\/job\.html\?jobId=job-sold">Open job<\/a>/);
});

// Crew home (crew/index.html) run in a fake page with the real script and a fixed Denver day.
async function crewHome({ walkthroughs, business = false, jobs }) {
  const page = readFileSync(new URL('../crew/index.html', import.meta.url), 'utf8'), nodes = new Map();
  const element = id => { if (!nodes.has(id)) nodes.set(id, { id, hidden: false, textContent: '', innerHTML: '', className: '', dataset: { businessHref: '/crew/prejob' }, setAttribute() {}, classList: { toggle() {} } }); return nodes.get(id); };
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : ['2026-09-22T15:00:00.000Z'])); } static now() { return Date.parse('2026-09-22T15:00:00.000Z'); } }
  const context = vm.createContext({ Date: FixedDate, Intl, URLSearchParams, Promise, Set, Number, String, Array, Math, JSON, encodeURIComponent, window: {}, location: { search: '' }, navigator: { onLine: true }, addEventListener() {},
    document: { getElementById: element },
    EGCHubAuth: { profile: () => ({ user: 'Sales.Rep', displayName: 'Synthetic Sales Rep' }), canRunBusiness: () => business, canRunWalkthrough: () => walkthroughs, mountCrewNav() {},
      async fetch(path) { if (path === '/api/crew-jobs') return Response.json({ ok: true, jobs }); if (path === '/api/employee-hub') return Response.json({ ok: true, collections: { timeEntries: [] } }); throw new Error(`Unexpected ${path}`); } } });
  vm.runInContext(page.slice(page.lastIndexOf('<script>') + '<script>'.length, page.lastIndexOf('</script>')), context);
  await context.openCrewHome();
  return element;
}

test('crew home shows a walkthrough.perform rep their walkthrough with a tel: customer link, and a badge instead of Start once closed', async () => {
  const today = crewJobProjection(walk({ assignedCrew: ['sales.rep'] }), { viewer: 'sales.rep', now: NOW }), sold = crewJobProjection(walk({ id: 'w-sold', date: '2026-09-23', endDate: '2026-09-23', assignedCrew: ['sales.rep'], convertedJobId: 'job-sold', walkthroughOutcome: outcome('sold_on_site'), walkthroughCompletedAt: 'x' }), { viewer: 'sales.rep', now: NOW });
  const rep = await crewHome({ walkthroughs: true, jobs: [today, sold] });
  assert.match(rep('next-work').innerHTML, /<a class="primary" href="\/crew\/gameplan\?walkthroughId=w1">Start walkthrough<\/a>/);
  assert.match(rep('next-work').innerHTML, /<a href="tel:9705550101">Call customer<\/a>/, 'the rep can call the customer from the card');
  assert.match(rep('assigned-jobs').innerHTML, /href="\/crew\/gameplan\?walkthroughId=w-sold"/, 'a rep opens the sold walkthrough, not a job they are not on');
  assert.match(rep('assigned-jobs').innerHTML, /<em class="row-badge">Sold → open job<\/em>/, 'list rows carry the outcome badge');
  const missedFirst = await crewHome({ walkthroughs: true, jobs: [{ ...today, id: 'w-missed', time: '07:00', walkthroughState: 'no_show', walkthroughBadge: 'No-show · rebook' }, today] });
  assert.match(missedFirst('next-work').innerHTML, /walkthroughId=w1">Start walkthrough/, 'a missed visit does not take the next-work slot from an open one');
  assert.equal(rep('walkthrough-tool').hidden, false);
  const soldFirst = await crewHome({ walkthroughs: true, business: true, jobs: [sold] });
  assert.match(soldFirst('next-work').innerHTML, /<span class="job-stage">Sold → open job<\/span>/);
  assert.match(soldFirst('next-work').innerHTML, /<a class="primary" href="\/crew\/job\.html\?jobId=job-sold">Open job<\/a>/);
  assert.doesNotMatch(soldFirst('next-work').innerHTML, /Start walkthrough/);
  const crew = await crewHome({ walkthroughs: false, jobs: [today] });
  assert.match(crew('next-work').innerHTML, /No upcoming assignment/, 'without walkthrough.perform the walkthrough stays hidden');
  assert.equal(crew('walkthrough-tool').hidden, true);
});

test('the Walkthroughs screen replaces the built-in view for business access and, with staff roles, needs dispatch.write', () => {
  const nav = page => [...page.api.visibleNav()].filter(item => item[1] === 'walkthroughs').map(item => [...item]);
  const legacy = hubPage({ user: 'AlexK', business: true, role: 'manager' });
  assert.deepEqual(nav(legacy), [['RUN THE BUSINESS', 'walkthroughs', 'Walkthroughs']], 'one entry, in the built-in view\'s place');
  assert.equal(legacy.api.canView('walkthroughs'), true);
  assert.equal(hubPage({ user: 'Synthetic.Crew', business: false, role: 'crew' }).api.canView('walkthroughs'), false);
  // With staff-role permissions the screen reads and saves through /api/dispatch, so a manager who only approves time
  // (business access without dispatch.write) does not get a screen that answers 403.
  for (const [capabilities, expected] of [[['time.approve', 'dispatch.write'], true], [['dispatch.write'], true], [['time.approve'], false]]) {
    const page = hubPage({ user: 'AlexK', business: true, role: 'manager' });
    page.session.setItem('egc_capability_mode', 'staff_roles');
    page.session.setItem('egc_capabilities', JSON.stringify(capabilities));
    assert.equal(page.api.canView('walkthroughs'), expected, capabilities.join(','));
    assert.equal(nav(page).length, expected ? 1 : 0, capabilities.join(','));
  }
  // (WT-OUTCOME after SALES-BOOKING) with EGC_STAFF_ROLE_ACCESS a Sales or Phone booker (schedule.book, no business access)
  // keeps Walkthroughs, now this screen; a manager who only approves time still does not get it, even holding schedule.book.
  const roles = (profile, capabilities) => {
    const page = hubPage(profile);
    page.session.setItem('egc_capability_mode', 'staff_roles');
    page.session.setItem('egc_capabilities', JSON.stringify(capabilities));
    page.session.setItem('egc_role_access', 'true');
    return page;
  };
  for (const role of ['sales', 'phone']) {
    const booker = roles({ user: 'Synthetic.Booker', business: false, role }, ['schedule.book']);
    assert.equal(booker.api.canView('walkthroughs'), true, role);
    assert.deepEqual(nav(booker), [['RUN THE BUSINESS', 'walkthroughs', 'Walkthroughs']], role);
  }
  assert.equal(roles({ user: 'AlexK', business: true, role: 'manager' }, ['time.approve', 'schedule.book']).api.canView('walkthroughs'), false);
  assert.equal(roles({ user: 'Synthetic.Crew', business: false, role: 'crew' }, []).api.canView('walkthroughs'), false);
});
