// FIX-DISPATCH-QUEUE: Dispatch's To schedule queue. Undated active work is listed oldest first by when it was sold,
// else approved, else created, with its age, where it came from and, for an imported Jobber job, the visit Jobber had.
// needsDispatchReview flags undated work the office has not booked (a portal approval, a Jobber import) and the first
// save that schedules it (Dispatch or a bridge schedule update) clears the flag. In-memory stores, synthetic data, a fixed clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { dispatchOverview, mutateDispatch, projectDispatchJob } from '../functions/_lib/dispatch-service.js';
import { dispatchHandlers } from '../functions/api/dispatch.js';
import { dispatchStorage, JOB_FIELDS } from '../functions/_lib/dispatch-storage.js';
import { DISPATCH_REVIEW_REASONS, QUEUE_JOB_FIELDS, dispatchReviewCleared, dispatchReviewPatch, queueFacts, queueOrder, queueSource, queued, withQueueFacts } from '../functions/_lib/dispatch-queue.js';
import { futureJobRecord } from '../functions/_lib/jobber-import-map.js';
import { runHubCommand } from '../functions/_lib/operations-hub-commands.js';
import { mutateScheduledVisit } from '../functions/_lib/operations-scheduling.js';
import { NOW as PORTAL_NOW, portalStore, portalCookie, portalHandlers, portalView, portalPost } from './helpers/portal-fixture.mjs';

// 12:00 UTC on 22 Sept is 06:00 in Denver; LATE is 23:30 Denver on 22 Sept, already 23 Sept in UTC.
const NOW = '2026-09-22T12:00:00.000Z', LATE = '2026-09-23T05:30:00.000Z';
const owner = { user: 'zacb', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
const booker = { user: 'sales.one', displayName: 'Synthetic Sales', role: 'sales', businessAccess: false, staffRoles: ['sales'] };
const crew = { user: 'crew1', displayName: 'Synthetic Crew', role: 'crew', businessAccess: false };
const ROSTER = [{ id: 'zacb', name: 'Synthetic Owner', role: 'owner' }, { id: 'crew1', name: 'Synthetic Crew', role: 'crew' }, { id: 'crew2', name: 'Synthetic Crew Two', role: 'crew' }];
const CANARY = ['987654', 'CANARY-SECRET-NOTE', 'sk_test_canary'];

// Applies a Firestore field mask the way the dispatch scans do (dispatch-storage.js JOB_FIELDS).
function masked(row, fields) {
  const out = { id: row.id, revision: row.revision };
  for (const path of fields) {
    const [top, sub] = path.split('.');
    if (row[top] === undefined) continue;
    if (sub === undefined) out[top] = structuredClone(row[top]);
    else if (row[top] && typeof row[top] === 'object' && row[top][sub] !== undefined) out[top] = { ...out[top], [sub]: structuredClone(row[top][sub]) };
  }
  return out;
}

function fixture() {
  const rows = new Map([['customers/c1', { id: 'c1', name: 'Synthetic Customer', phone: '+1 (970) 555-0101', email: 'synthetic@example.invalid', address: '1 Synthetic Way', revision: 'c1r' }]]);
  let revision = 0;
  const clone = value => structuredClone(value), all = prefix => [...rows].filter(([key]) => key.startsWith(prefix + '/')).map(([, value]) => clone(value));
  const store = {
    // The board scans with the production field mask; single reads return the whole document, as Firestore does.
    jobs: async () => all('jobs').map(row => masked(row, JOB_FIELDS)), resources: async () => all('dispatchResources'), customers: async () => all('customers'), roster: async () => clone(ROSTER),
    read: async (collection, id) => clone(rows.get(`${collection}/${id}`) || null),
    async commit(writes) {
      const seen = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = rows.get(key);
        assert.ok(!seen.has(key), 'no duplicate writes per document'); seen.add(key);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...(write.revision ? rows.get(`${write.collection}/${write.id}`) : {}), ...clone(write.patch), id: write.id, revision: `r${++revision}` });
    },
  };
  const put = (id, data) => { rows.set(`jobs/${id}`, { id, revision: `${id}-r1`, type: 'job', customerId: 'c1', customer: 'Synthetic Customer', address: '1 Synthetic Way', jobInstructions: 'Synthetic scope', status: 'unscheduled', pipelineStatus: 'unscheduled', assignedCrew: [], travelBufferMinutes: 0, date: '', time: '', endDate: '', endTime: '', createdAt: '2026-09-01T15:00:00.000Z', ...data }); return clone(rows.get(`jobs/${id}`)); };
  const update = (id, changes, at = NOW, session = owner, extra = {}) => mutateDispatch(store, session, { action: 'schedule.update', requestId: randomUUID(), jobId: id, expectedRevision: rows.get(`jobs/${id}`).revision, changes, ...extra }, at);
  const board = (session = owner, at = NOW, options = { readiness: true }) => dispatchOverview(store, session, { startDate: '2026-09-22', endDate: '2026-09-29', includeUnscheduled: 'true' }, new Date(at), options);
  return { rows, store, put, update, board, job: id => clone(rows.get(`jobs/${id}`)) };
}
const find = (overview, id) => overview.jobs.find(job => job.id === id);

test('queue facts: sold, then approved, then created, with the age in whole Denver days on the injected clock', () => {
  const base = { id: 'q', type: 'job', status: 'unscheduled', date: '', createdAt: '2026-09-01T15:00:00.000Z' };
  const sold = { ...base, funnelSale: { jobId: 'q', soldAt: '2026-09-13T04:30:00.000Z', cents: 987654 }, estimate: { acceptedAt: '2026-09-02T15:00:00.000Z' } };
  // Sold at 22:30 Denver on 12 Sept (13 Sept in UTC): ten Denver days before 22 Sept, early or late in the day.
  assert.deepEqual(queueFacts(sold, NOW), { since: '2026-09-13T04:30:00.000Z', sinceKind: 'sold', ageDays: 10, source: 'hub' });
  assert.equal(queueFacts(sold, new Date(LATE)).ageDays, 10, 'a late Denver evening is still the same Denver day');
  assert.equal(queueFacts(sold, '2026-09-23T06:30:00.000Z').ageDays, 11, 'past Denver midnight the age grows by one');
  assert.deepEqual(queueFacts({ ...base, estimate: { acceptedAt: '2026-09-20T18:00:00.000Z' } }, NOW), { since: '2026-09-20T18:00:00.000Z', sinceKind: 'approved', ageDays: 2, source: 'hub' });
  assert.deepEqual(queueFacts({ ...base, customerApproval: { approvedAt: '2026-09-21T18:00:00Z' } }, NOW).since, '2026-09-21T18:00:00.000Z');
  assert.deepEqual(queueFacts(base, NOW), { since: '2026-09-01T15:00:00.000Z', sinceKind: 'created', ageDays: 21, source: 'hub' });
  // An older browser write that saved only a date counts as that Denver day; unreadable dates are skipped.
  assert.deepEqual([queueFacts({ ...base, estimate: { acceptedAt: '2026-09-15' } }, NOW).since, queueFacts({ ...base, estimate: { acceptedAt: 'soon' } }, NOW).sinceKind], ['2026-09-15T12:00:00.000Z', 'created']);
  assert.deepEqual(queueFacts({ ...base, createdAt: 'not a date' }, NOW), { since: null, sinceKind: null, ageDays: null, source: 'hub' });
  assert.equal(queueFacts({ ...base, createdAt: '2026-09-30T15:00:00.000Z' }, NOW).ageDays, 0, 'never a negative age');
});

test('where the work came from: the review reason first, then the job record', () => {
  assert.deepEqual(['portal', 'walkthrough', 'jobber'], DISPATCH_REVIEW_REASONS.map(reason => queueSource({ dispatchReviewReason: reason })));
  assert.equal(queueSource({ scheduleSource: 'jobber_import' }), 'jobber');
  assert.equal(queueSource({ sourceWalkthroughId: 'walk-1' }), 'walkthrough');
  assert.equal(queueSource({ sourceWalkthroughId: 'secure_x' }), 'hub', 'a private id is not a source');
  assert.equal(queueSource({ customerApproval: { source: 'customer_portal' } }), 'portal');
  assert.equal(queueSource({ sourceWalkthroughId: 'walk-1', dispatchReviewReason: 'portal_approval' }), 'portal', 'an online approval of a walkthrough job reads as the approval');
  assert.equal(queueSource({ scheduleSource: 'egc_hub' }), 'hub');
});

test('only undated active customer work is queued; the review flag is set and cleared by explicit rules', () => {
  const work = { id: 'w', type: 'job', status: 'unscheduled', date: '' };
  assert.equal(queued(work), true);
  for (const row of [{ ...work, date: '2026-09-25' }, { ...work, status: 'cancelled' }, { ...work, pipelineStatus: 'completed' }, { ...work, type: 'blocked' }, { ...work, recordType: 'jobber_history' }, { ...work, id: '_egc_schedule_lock_2026-09-25' }, { ...work, type: 'availability' }, null])
    assert.equal(queued(row), false, JSON.stringify(row));
  assert.deepEqual(dispatchReviewPatch('portal_approval', NOW), { needsDispatchReview: true, dispatchReviewReason: 'portal_approval', dispatchReviewAt: NOW });
  for (const [reason, at] of [['guess', NOW], ['portal_approval', ''], ['portal_approval', 'yesterday'], ['__proto__', NOW]]) assert.throws(() => dispatchReviewPatch(reason, at), TypeError);
  assert.deepEqual(dispatchReviewCleared({ needsDispatchReview: true }, { start: 1 }, 'zacb', NOW), { needsDispatchReview: false, dispatchReviewClearedAt: NOW, dispatchReviewClearedBy: 'zacb' });
  for (const [current, scheduled] of [[{ needsDispatchReview: true }, null], [{ needsDispatchReview: false }, { start: 1 }], [{}, { start: 1 }], [null, { start: 1 }]]) assert.deepEqual(dispatchReviewCleared(current, scheduled, 'zacb', NOW), {});
});

// (FIX-DISPATCH-QUEUE after WT-OUTCOME) a closed walkthrough (walkthrough-state.js: a converted job, a final outcome or
// walkthroughCompletedAt) is finished work. Undated and still 'scheduled', it never waits in To schedule, on the server or the page.
test('a closed walkthrough with no date is never queued; an open one is', async () => {
  const f = fixture(), closed = ['walk-sold', 'walk-legacy-sold', 'walk-lost', 'walk-quote'];
  const walk = (id, extra = {}) => f.put(id, { type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', createdAt: '2026-09-20T15:00:00.000Z', ...extra });
  walk('walk-open');
  walk('walk-sold', { convertedJobId: 'job-sold', walkthroughOutcome: { outcome: 'sold_on_site', reasonCode: null, finishedAt: '2026-09-21T15:40:00.000Z' }, walkthroughCompletedAt: '2026-09-21T15:40:00.000Z' });
  walk('walk-legacy-sold', { convertedJobId: 'job-legacy' });
  walk('walk-lost', { walkthroughOutcome: { outcome: 'not_interested', reasonCode: 'price', finishedAt: '2026-09-21T15:40:00.000Z' }, walkthroughCompletedAt: '2026-09-21T15:40:00.000Z' });
  walk('walk-quote', { walkthroughOutcome: { outcome: 'quote_to_follow', reasonCode: null, finishedAt: '2026-09-21T15:40:00.000Z' } });
  for (const id of closed) assert.equal(queued(f.job(id)), false, id);
  assert.equal(queued(f.job('walk-open')), true);
  const board = await f.board();
  assert.deepEqual(board.jobs.filter(job => job.queue).map(job => job.id), ['walk-open']);
  for (const id of closed) assert.equal(find(board, id).walkthroughClosed, true, `${id} is on the board as finished work`);
  // The page judges a response without queue facts (a search result) by the same rule.
  const window = { addEventListener() {} }, context = vm.createContext({ window, Date, Intl, console });
  vm.runInContext(readFileSync(new URL('../employee-dispatch.js', import.meta.url), 'utf8'), context, { filename: 'employee-dispatch.js' });
  const { undated } = window.EGCDispatch.internals;
  assert.deepEqual(['walk-open', ...closed].map(id => undated(find(board, id))), [true, false, false, false, false]);
});

test('an imported Jobber job shows the first visit Jobber had; only a timed visit from today on can be used as it is', () => {
  const customer = { id: 'jobber_client_7', name: 'Synthetic Jobber Customer', phone: '9705550155', email: '', address: '7 Synthetic Loop' };
  const visit = (date, time, endTime, extra = {}) => ({ schedule: { date, time, endDate: date, endTime, startAt: null, endAt: null, ...extra }, assignedTo: 'Synthetic Crew', valueCents: 987654, title: 'Synthetic garage reset', address: { line: '7 Synthetic Loop' } });
  const imported = futureJobRecord({ jobNumber: '4410', jobType: 'one_off', jobberClientId: '7', visits: [visit('2026-10-08', '09:00', '12:00'), visit('2026-10-15', '09:00', '12:00')] }, customer, { now: '2026-09-20T15:00:00.000Z', runId: 'run-1' });
  const facts = queueFacts(imported, NOW);
  assert.deepEqual(facts, { since: '2026-09-20T15:00:00.000Z', sinceKind: 'created', ageDays: 2, source: 'jobber', jobber: { date: '2026-10-08', time: '09:00', endDate: '2026-10-08', endTime: '12:00', usable: true, past: false } });
  assert.equal(JSON.stringify(facts).includes('987654'), false, "Jobber's job value never reaches the queue");
  const first = (schedule, at = NOW) => queueFacts({ ...imported, jobber: { ...imported.jobber, visits: [schedule] } }, at).jobber;
  assert.deepEqual(first({ date: '2026-10-08', time: '', endTime: '', allDay: true }), { date: '2026-10-08', time: '', endDate: '2026-10-08', endTime: '', allDay: true, usable: false, past: false });
  assert.equal(first({ date: '2026-10-08', time: '09:00', endTime: '12:00', timeNeedsReview: true }).usable, false, 'a time Jobber flagged for review is shown, not used');
  assert.equal(first({ date: '2026-10-08', time: '12:00', endTime: '09:00' }).usable, false, 'an end before the start is not bookable');
  assert.equal(first({ date: '2026-11-01', time: '01:30', endTime: '03:00' }).usable, false, 'a start in the repeated DST hour is not bookable');
  assert.deepEqual([first({ date: '2026-09-21', time: '09:00', endTime: '12:00' }).past, first({ date: '2026-09-22', time: '09:00', endTime: '12:00' }, LATE).past], [true, false]);
  assert.equal(queueFacts({ ...imported, jobber: { visits: [{ date: 'soon' }] } }, NOW).jobber, undefined, 'no dated visit, no Jobber line');
  assert.equal(queueFacts({ ...imported, scheduleSource: 'egc_hub', dispatchReviewReason: 'portal_approval' }, NOW).jobber, undefined, 'only Jobber work shows a Jobber visit');
  // Approved online after the import: the row reads as the approval and still shows the visit Jobber had.
  const approved = queueFacts({ ...imported, dispatchReviewReason: 'portal_approval' }, NOW);
  assert.deepEqual([approved.source, approved.jobber?.date, approved.jobber?.usable], ['portal', '2026-10-08', true]);
});

test('To schedule order is oldest first, then the earlier Jobber visit, then id; the Hub board sends queued work in that order', async () => {
  const f = fixture();
  f.put('newer', { createdAt: '2026-09-20T15:00:00.000Z' });
  f.put('sold-old', { createdAt: '2026-09-21T15:00:00.000Z', funnelSale: { jobId: 'sold-old', soldAt: '2026-09-05T15:00:00.000Z', cents: 987654 }, sourceWalkthroughId: 'walk-9' });
  f.put('approved', { createdAt: '2026-08-01T15:00:00.000Z', estimate: { acceptedAt: '2026-09-10T15:00:00.000Z', amount: 9876.54, status: 'approved' }, customerApproval: { status: 'approved', approvedAt: '2026-09-10T15:00:00.000Z', source: 'customer_portal', amount: 9876.54 }, needsDispatchReview: true, dispatchReviewReason: 'portal_approval' });
  f.put('jobber-b', { createdAt: '2026-09-15T15:00:00.000Z', scheduleSource: 'jobber_import', needsDispatchReview: true, dispatchReviewReason: 'jobber_import', jobber: { valueCents: 987654, visits: [{ date: '2026-10-09', time: '09:00', endDate: '2026-10-09', endTime: '12:00' }] } });
  f.put('jobber-a', { createdAt: '2026-09-15T15:00:00.000Z', scheduleSource: 'jobber_import', needsDispatchReview: true, dispatchReviewReason: 'jobber_import', jobber: { valueCents: 987654, visits: [{ date: '2026-10-08', time: '09:00', endDate: '2026-10-08', endTime: '12:00' }] } });
  f.put('undated-cancelled', { status: 'cancelled', pipelineStatus: 'cancelled', createdAt: '2026-01-01T15:00:00.000Z' });
  f.put('scheduled', { date: '2026-09-24', endDate: '2026-09-24', time: '09:00', endTime: '11:00', status: 'scheduled', pipelineStatus: 'scheduled', assignedCrew: ['crew1'] });
  const board = await f.board();
  const queue = board.jobs.filter(job => job.queue);
  assert.deepEqual(queue.map(job => [job.id, job.queue.sinceKind, job.queue.ageDays, job.queue.source]), [['sold-old', 'sold', 17, 'walkthrough'], ['approved', 'approved', 12, 'portal'], ['jobber-a', 'created', 7, 'jobber'], ['jobber-b', 'created', 7, 'jobber'], ['newer', 'created', 2, 'hub']]);
  assert.deepEqual(queue.map(job => job.needsDispatchReview ?? null), [null, true, true, true, null], 'the review flag is in the dispatch DTO');
  assert.equal(find(board, 'approved').dispatchReviewReason, 'portal_approval');
  assert.equal('queue' in find(board, 'scheduled') || 'queue' in find(board, 'undated-cancelled'), false, 'dated or closed work is not queued');
  assert.equal(board.jobs[0].id, 'scheduled', 'dated work keeps its place ahead of the queue');
  // The same order from any starting order.
  const shuffled = [...queue].reverse().sort(() => 0).sort(queueOrder);
  assert.deepEqual(shuffled.map(job => job.id), queue.map(job => job.id));
  // Money stays out: the sale amount, the approved total and Jobber's value are never read by the board scan.
  assert.equal(JSON.stringify(queue).includes('987654') || JSON.stringify(queue).includes('9876.54'), false);
});

test("a sale copied onto a cloned visit is not the clone's sale: it neither dates nor orders its row", async () => {
  const base = { id: 'clone', type: 'job', status: 'unscheduled', date: '', createdAt: '2026-09-18T15:00:00.000Z' };
  const copied = { ...base, funnelSale: { jobId: 'original', soldAt: '2026-08-01T15:00:00.000Z', cents: 987654 } };
  assert.deepEqual(queueFacts(copied, NOW), { since: '2026-09-18T15:00:00.000Z', sinceKind: 'created', ageDays: 4, source: 'hub' });
  assert.deepEqual(queueFacts({ ...copied, estimate: { acceptedAt: '2026-09-19T15:00:00.000Z' } }, NOW).sinceKind, 'approved', 'the clone falls back to its own approval');
  for (const funnelSale of [{ soldAt: '2026-08-01T15:00:00.000Z' }, { jobId: '', soldAt: '2026-08-01T15:00:00.000Z' }, { jobId: ['clone'], soldAt: '2026-08-01T15:00:00.000Z' }, null, 'sold'])
    assert.equal(queueFacts({ ...base, funnelSale }, NOW).sinceKind, 'created', JSON.stringify(funnelSale));
  assert.equal(queueFacts({ ...copied, funnelSale: { ...copied.funnelSale, jobId: 'clone' } }, NOW).sinceKind, 'sold', 'its own sale counts');
  // Through the board's field mask: the original is the oldest sale; the clone waits by its own creation date.
  const f = fixture();
  f.put('original', { createdAt: '2026-09-15T15:00:00.000Z', funnelSale: { jobId: 'original', soldAt: '2026-08-01T15:00:00.000Z', cents: 987654 } });
  f.put('clone', { createdAt: '2026-09-18T15:00:00.000Z', funnelSale: { jobId: 'original', soldAt: '2026-08-01T15:00:00.000Z', cents: 987654 } });
  f.put('middle', { createdAt: '2026-09-10T15:00:00.000Z' });
  const queue = (await f.board()).jobs.filter(job => job.queue);
  assert.deepEqual(queue.map(job => [job.id, job.queue.sinceKind, job.queue.ageDays]), [['original', 'sold', 52], ['middle', 'created', 12], ['clone', 'created', 4]]);
  assert.equal(JSON.stringify(queue).includes('987654'), false);
});

test('queue facts come only with the Hub board; the signed bridge read gains only the optional review flag', async () => {
  const f = fixture();
  f.put('flagged', { needsDispatchReview: true, dispatchReviewReason: 'portal_approval', funnelSale: { jobId: 'flagged', soldAt: '2026-09-10T15:00:00.000Z', cents: 987654 } });
  f.put('legacy', {});
  const bridge = await f.board(owner, NOW, {});
  assert.deepEqual(bridge.jobs.map(job => ['queue' in job, job.needsDispatchReview ?? null]), [[false, true], [false, null]]);
  // Only the Hub board says its queued jobs are exactly those with queue facts.
  assert.deepEqual(['queueFacts' in bridge, (await f.board()).queueFacts], [false, true]);
  // A legacy job reads exactly as before this unit: the DTO without the new optional fields.
  const legacy = find(bridge, 'legacy');
  assert.deepEqual(Object.keys(legacy).filter(key => ['needsDispatchReview', 'dispatchReviewReason', 'queue'].includes(key)), []);
  assert.deepEqual(legacy, projectDispatchJob(masked(f.job('legacy'), JOB_FIELDS), ROSTER, NOW));
  // Through the signed bridge command itself.
  const profiles = [{ user: 'tylerg', displayName: 'Synthetic Manager', role: 'manager', businessAccess: true }];
  const result = await runHubCommand({}, { id: 'tylerg', role: 'manager', kind: 'human', workspace: 'egc' }, { command: 'hub.dispatch.overview', view: 'schedule', includeUnscheduled: true }, { storage: () => f.store, profiles: () => profiles, delegates: () => new Map(), now: () => new Date(NOW) });
  assert.deepEqual(result.jobs.map(job => [job.id, 'queue' in job, job.needsDispatchReview ?? null, job.dispatchReviewReason ?? null]), [['flagged', false, true, 'portal_approval'], ['legacy', false, null, null]]);
  assert.equal('queueFacts' in result, false);
  assert.equal(JSON.stringify(result).includes('987654'), false);
});

test('the board scan masks the queue fields in and every amount out', async () => {
  for (const field of QUEUE_JOB_FIELDS) assert.ok(JOB_FIELDS.includes(field), field);
  assert.ok(QUEUE_JOB_FIELDS.includes('funnelSale.jobId'), 'the sale names its job, so a copied sale can be told apart');
  assert.equal(new Set(JOB_FIELDS).size, JOB_FIELDS.length, 'each field once');
  for (const whole of ['funnelSale', 'jobber', 'estimate', 'customerApproval', 'funnelSale.cents', 'jobber.valueCents', 'estimate.amount', 'customerApproval.amount']) assert.equal(JOB_FIELDS.includes(whole), false, whole);
  const calls = [];
  const store = dispatchStorage({}, async (env, url) => { calls.push(new URL(url)); return new Response(JSON.stringify({ documents: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }); });
  await store.jobs();
  const mask = calls[0].searchParams.getAll('mask.fieldPaths');
  for (const field of QUEUE_JOB_FIELDS) assert.ok(mask.includes(field), field);
  assert.equal(mask.some(path => /^(funnelSale|jobber)$|cents|valueCents|amount/i.test(path)), false);
});

test('a booker sees To schedule without money; crew never read the board', async () => {
  const f = fixture();
  f.put('approved', { needsDispatchReview: true, dispatchReviewReason: 'portal_approval', funnelSale: { jobId: 'approved', soldAt: '2026-09-10T15:00:00.000Z', cents: 987654 }, estimate: { acceptedAt: '2026-09-10T15:00:00.000Z', amount: 9876.54, depositRequired: 4938.27, status: 'approved' }, customerApproval: { status: 'approved', approvedAt: '2026-09-10T15:00:00.000Z', amount: 9876.54, source: 'customer_portal' }, opsNotes: 'CANARY-SECRET-NOTE', payment: { reference: 'sk_test_canary' } });
  const env = { EGC_STAFF_ROLE_ACCESS: 'true' };
  const read = async session => { const response = await dispatchHandlers({ session: async () => session, storage: () => f.store, travel: () => null, now: () => new Date(NOW) }).get({ request: new Request('https://easygaragecleaning.com/api/dispatch?startDate=2026-09-22&endDate=2026-09-29&includeUnscheduled=true'), env }); return { status: response.status, text: await response.text() }; };
  const sales = await read(booker), body = JSON.parse(sales.text), row = find(body, 'approved');
  assert.equal(sales.status, 200);
  assert.deepEqual([row.queue.source, row.queue.sinceKind, row.queue.ageDays, row.needsDispatchReview, 'moneyReady' in row], ['portal', 'sold', 12, true, false]);
  for (const canary of ['987654', '9876.54', '4938.27', 'sk_test_canary', 'depositRequiredCents', 'moneyReady']) assert.equal(sales.text.includes(canary), false, canary);
  // An owner or manager gets the deposit chip's figures (FIX-DISPATCH-READY) on the same row.
  const manager = find(JSON.parse((await read(owner)).text), 'approved');
  assert.deepEqual([manager.queue.source, manager.moneyReady.depositRequiredCents, manager.moneyReady.depositDueCents], ['portal', 493827, 493827]);
  const refused = await read(crew);
  assert.equal(refused.status, 403);
  assert.equal(refused.text.includes('queue'), false);
});

test('the first save that schedules flagged work clears the flag with who and when; other saves keep it; legacy jobs gain nothing', async () => {
  const f = fixture();
  f.put('flagged', { needsDispatchReview: true, dispatchReviewReason: 'portal_approval', dispatchReviewAt: '2026-09-20T15:00:00.000Z' });
  await f.update('flagged', { opsNotes: 'Called, wants October' });
  assert.equal(f.job('flagged').needsDispatchReview, true, 'an edit that leaves it undated keeps the flag');
  const saved = await f.update('flagged', { date: '2026-09-25', time: '09:00', endDate: '2026-09-25', endTime: '11:00', assignedCrew: ['crew1'] }, '2026-09-22T13:00:00.000Z');
  assert.deepEqual([saved.job.needsDispatchReview, saved.job.dispatchReviewReason, saved.job.status], [false, 'portal_approval', 'scheduled']);
  const job = f.job('flagged');
  assert.deepEqual([job.needsDispatchReview, job.dispatchReviewClearedAt, job.dispatchReviewClearedBy, job.dispatchReviewReason, job.dispatchReviewAt], [false, '2026-09-22T13:00:00.000Z', 'zacb', 'portal_approval', '2026-09-20T15:00:00.000Z']);
  assert.equal('queue' in find(await f.board(), 'flagged'), false, 'booked work leaves To schedule');
  // Moving it back to To schedule later does not raise the flag again: the office has seen it.
  await f.update('flagged', { date: '', time: '', endDate: '', endTime: '' });
  const back = find(await f.board(), 'flagged');
  assert.deepEqual([back.queue.source, back.needsDispatchReview], ['portal', false]);
  // A cancellation closes the work and keeps the flag as it was.
  f.put('dropped', { needsDispatchReview: true, dispatchReviewReason: 'jobber_import' });
  await mutateDispatch(f.store, owner, { action: 'schedule.cancel', requestId: randomUUID(), jobId: 'dropped', expectedRevision: f.job('dropped').revision, changes: {}, reasonCode: 'customer_changed_plans', initiatedBy: 'customer' }, NOW);
  assert.deepEqual([f.job('dropped').needsDispatchReview, f.job('dropped').status], [true, 'cancelled']);
  // A legacy job scheduled the same way gets no review fields.
  f.put('legacy', {});
  await f.update('legacy', { date: '2026-09-26', time: '09:00', endDate: '2026-09-26', endTime: '11:00', assignedCrew: ['crew1'] });
  assert.deepEqual(Object.keys(f.job('legacy')).filter(key => /dispatchReview|needsDispatchReview/.test(key)), []);
});

test('a booker scheduling flagged work clears it too, through the same checks', async () => {
  const f = fixture(), env = { EGC_STAFF_ROLE_ACCESS: 'true' };
  f.put('portal', { needsDispatchReview: true, dispatchReviewReason: 'portal_approval' });
  const handlers = dispatchHandlers({ session: async () => booker, storage: () => f.store, travel: () => null, now: () => new Date(NOW), ghlTags: () => true });
  const body = { action: 'schedule.update', requestId: randomUUID(), jobId: 'portal', expectedRevision: f.job('portal').revision, changes: { date: '2026-09-25', time: '13:00', endDate: '2026-09-25', endTime: '15:00' } };
  const response = await handlers.post({ request: new Request('https://easygaragecleaning.com/api/dispatch', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env, waitUntil: () => {} });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual([f.job('portal').needsDispatchReview, f.job('portal').dispatchReviewClearedBy], [false, 'sales.one']);
});

// operations-scheduling.js (MCP egc.schedule_visit and bridge schedule changes): the same flag clears on the first booking.
function bridgeFixture(jobs) {
  const rows = new Map([['customers/c1', { id: 'c1', name: 'Synthetic Customer', highlevelContactId: 'contact-1', revision: 'c1r' }], ...Object.entries(jobs).map(([id, job]) => [`jobs/${id}`, { id, revision: `${id}-r1`, type: 'job', customerId: 'c1', customer: 'Synthetic Customer', address: '1 Synthetic Way', status: 'unscheduled', pipelineStatus: 'unscheduled', date: '', time: '', endDate: '', endTime: '', createdAt: '2026-09-01T15:00:00.000Z', ...job }])]);
  let revision = 0;
  const store = {
    read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null),
    day: async date => [...rows].filter(([key, row]) => key.startsWith('jobs/') && row.date === date).map(([, row]) => structuredClone(row)),
    async commit(writes) {
      for (const write of writes) { const old = rows.get(`${write.collection}/${write.id}`); if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('schedule_revision_conflict'), { status: 409 }); }
      for (const write of writes) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...structuredClone(write.patch), id: write.id, revision: `b${++revision}` });
      return {};
    },
  };
  const job = id => structuredClone(rows.get(`jobs/${id}`));
  const send = (actor, id, mode, changes, at) => mutateScheduledVisit(store, actor, { command: 'schedule.mutate', requestId: randomUUID(), mode, portalCustomerId: 'c1', portalVisitId: id, expectedRevision: job(id).revision, kind: 'job', changes }, at);
  return { rows, store, job, send };
}

test('a bridge schedule update that books flagged work clears the flag with who and when; a refused one or a legacy job changes nothing', async () => {
  const integration = { id: 'verified-grant', kind: 'integration', role: 'integration', workspace: 'egc' }, manager = { id: 'tylerg', kind: 'human', role: 'manager', workspace: 'egc' };
  const f = bridgeFixture({ portal: { needsDispatchReview: true, dispatchReviewReason: 'portal_approval', dispatchReviewAt: '2026-09-20T15:00:00.000Z' }, jobber: { needsDispatchReview: true, dispatchReviewReason: 'jobber_import', scheduleSource: 'jobber_import' }, legacy: {} });
  await f.send(integration, 'portal', 'update', { date: '2026-09-25', time: '09:00', endTime: '11:00' }, '2026-09-22T13:00:00.000Z');
  const portal = f.job('portal');
  assert.deepEqual([portal.date, portal.needsDispatchReview, portal.dispatchReviewClearedAt, portal.dispatchReviewClearedBy, portal.dispatchReviewReason, portal.dispatchReviewAt], ['2026-09-25', false, '2026-09-22T13:00:00.000Z', 'verified-grant', 'portal_approval', '2026-09-20T15:00:00.000Z']);
  assert.equal(queued(portal), false, 'booked work leaves To schedule');
  await f.send(manager, 'jobber', 'update', { date: '2026-09-26', time: '13:00', endTime: '15:00' }, NOW);
  assert.deepEqual([f.job('jobber').needsDispatchReview, f.job('jobber').dispatchReviewClearedBy, f.job('jobber').dispatchReviewReason], [false, 'tylerg', 'jobber_import']);
  // A later move keeps the first clearing as it was.
  await f.send(integration, 'portal', 'update', { time: '10:00', endTime: '12:00' }, '2026-09-22T14:00:00.000Z');
  assert.deepEqual([f.job('portal').dispatchReviewClearedAt, f.job('portal').time], ['2026-09-22T13:00:00.000Z', '10:00']);
  // A refused update clears nothing.
  f.rows.set('jobs/busy', { id: 'busy', revision: 'busy-r1', type: 'job', customerId: 'c1', date: '2026-09-27', time: '09:00', endDate: '2026-09-27', endTime: '11:00', status: 'scheduled', pipelineStatus: 'scheduled' });
  const blocked = bridgeFixture({ flagged: { needsDispatchReview: true, dispatchReviewReason: 'portal_approval' } });
  blocked.rows.set('jobs/busy', f.rows.get('jobs/busy'));
  await assert.rejects(blocked.send(integration, 'flagged', 'update', { date: '2026-09-27', time: '09:00', endTime: '11:00' }, NOW), /slot_conflict/);
  assert.deepEqual([blocked.job('flagged').needsDispatchReview, blocked.job('flagged').date], [true, '']);
  // A legacy job booked the same way gains no review fields.
  await f.send(integration, 'legacy', 'update', { date: '2026-09-28', time: '09:00', endTime: '11:00' }, NOW);
  assert.deepEqual([f.job('legacy').date, Object.keys(f.job('legacy')).filter(key => /dispatchReview|needsDispatchReview/.test(key))], ['2026-09-28', []]);
});

test("Use this time books an imported Jobber job at Jobber's time only through every dispatch check", async () => {
  const f = fixture();
  const customer = { id: 'c1', name: 'Synthetic Customer', phone: '9705550101', email: '', address: '1 Synthetic Way' };
  const imported = futureJobRecord({ jobNumber: '4411', jobType: 'one_off', jobberClientId: '8', visits: [{ schedule: { date: '2026-09-25', time: '09:00', endDate: '2026-09-25', endTime: '12:00' }, assignedTo: 'Synthetic Crew', valueCents: 987654, title: 'Synthetic reset', address: { line: '1 Synthetic Way' } }] }, customer, { now: '2026-09-20T15:00:00.000Z', runId: 'run-2' });
  f.put(imported.id, { ...imported, revision: undefined });
  f.rows.set(`jobs/${imported.id}`, { ...f.rows.get(`jobs/${imported.id}`), revision: 'imported-r1' });
  f.put('busy', { date: '2026-09-25', endDate: '2026-09-25', time: '10:00', endTime: '11:00', status: 'scheduled', pipelineStatus: 'scheduled', assignedCrew: ['crew1'] });
  const row = find(await f.board(), imported.id);
  assert.deepEqual([row.queue.source, row.queue.jobber.usable, row.needsDispatchReview], ['jobber', true, true]);
  // The editor opened by Use this time sends Jobber's time; a crew clash is still refused.
  const visit = row.queue.jobber, changes = { date: visit.date, time: visit.time, endDate: visit.endDate, endTime: visit.endTime };
  await assert.rejects(f.update(imported.id, { ...changes, assignedCrew: ['crew1'] }), error => error.code === 'dispatch_conflict' && error.details.conflicts.some(conflict => conflict.code === 'schedule_overlap'));
  assert.equal(f.job(imported.id).needsDispatchReview, true, 'a refused save clears nothing');
  await f.update(imported.id, { ...changes, assignedCrew: ['crew2'] });
  assert.deepEqual([f.job(imported.id).date, f.job(imported.id).time, f.job(imported.id).needsDispatchReview, f.job(imported.id).dispatchReviewReason], ['2026-09-25', '09:00', false, 'jobber_import']);
});

test('withQueueFacts keeps every other job in place and orders only the queued ones', () => {
  const raws = [{ id: 'dated', type: 'job', status: 'scheduled', date: '2026-09-24' }, { id: 'b', type: 'job', status: 'unscheduled', date: '', createdAt: '2026-09-10T15:00:00.000Z' }, { id: 'a', type: 'job', status: 'unscheduled', date: '', createdAt: '2026-09-12T15:00:00.000Z' }, { id: 'closed', type: 'job', status: 'cancelled', date: '' }];
  const out = withQueueFacts(raws, raws.map(({ id }) => ({ id })), NOW);
  assert.deepEqual(out.map(job => [job.id, job.queue?.ageDays ?? null]), [['dated', null], ['b', 12], ['a', 10], ['closed', null]]);
});

// customer-portal.js approve_estimate: an online approval of undated work is flagged for the office.
const portalJob = extra => ({ type: 'job', customer: 'Synthetic Customer', customerId: 'customer-1', address: '100 Synthetic Street', serviceType: 'Garage Turnaround', total: 800, status: 'unscheduled', pipelineStatus: 'unscheduled', date: '', estimate: { number: 'EST-1', status: 'sent', amount: 800, revision: 2, validUntil: '2026-10-01' }, ...extra });
const approve = shown => ({ action: 'approve_estimate', signed_name: 'Synthetic Customer', confirmed: true, estimate_revision: shown.revision, amount_cents: Math.round(shown.amount * 100), estimate_fingerprint: shown.fingerprint, request_id: randomUUID() });

test('approve_estimate flags the job for dispatch review only when it has no date', async t => {
  const f = portalStore(t, { 'job-1': portalJob() }), handlers = portalHandlers(), cookie = await portalCookie();
  const shown = (await portalView(handlers, cookie)).body.estimate, body = approve(shown);
  const approved = await portalPost(handlers, cookie, body);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const job = f.job('job-1');
  assert.deepEqual([job.needsDispatchReview, job.dispatchReviewReason, job.dispatchReviewAt, job.customerApproval.status], [true, 'portal_approval', PORTAL_NOW, 'approved']);
  assert.equal(JSON.stringify(approved.body).includes('needsDispatchReview'), false, 'the customer is not told about the office flag');
  // A retry of the same approval replays it without another write.
  const writes = f.writes.length, replay = await portalPost(handlers, cookie, body);
  assert.deepEqual([replay.status, replay.body.replayed, f.writes.length], [200, true, writes]);
  // Dated work, and work that is closed, is approved without the flag.
  for (const extra of [{ date: '2026-09-25', endDate: '2026-09-25', time: '09:00', endTime: '11:00', status: 'scheduled', pipelineStatus: 'scheduled' }, { status: 'cancelled', pipelineStatus: 'cancelled' }]) {
    const g = portalStore(t, { 'job-1': portalJob(extra) }), view = (await portalView(handlers, cookie)).body.estimate;
    const result = await portalPost(handlers, cookie, approve(view));
    if (result.status !== 200) { assert.equal(extra.status, 'cancelled', JSON.stringify(result.body)); continue; }
    assert.deepEqual(Object.keys(g.job('job-1')).filter(key => /DispatchReview|dispatchReview/.test(key)), [], JSON.stringify(extra));
    assert.equal(g.writes.at(-1).fields.includes('needsDispatchReview'), false);
  }
});

test('an imported Jobber job approved online is flagged as the approval and still shows the visit Jobber had', async t => {
  const visits = [{ date: '2026-10-08', time: '09:00', endDate: '2026-10-08', endTime: '12:00' }];
  const f = portalStore(t, { 'job-1': portalJob({ scheduleSource: 'jobber_import', importSource: 'jobber', notify: false, needsDispatchReview: true, dispatchReviewReason: 'jobber_import', dispatchReviewAt: '2026-09-20T15:00:00.000Z', jobber: { valueCents: 987654, visits } }) });
  const handlers = portalHandlers(), cookie = await portalCookie(), shown = (await portalView(handlers, cookie)).body.estimate;
  const approved = await portalPost(handlers, cookie, approve(shown));
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const job = { id: 'job-1', ...f.job('job-1') };
  assert.deepEqual([job.needsDispatchReview, job.dispatchReviewReason, job.scheduleSource], [true, 'portal_approval', 'jobber_import']);
  const facts = queueFacts(job, '2026-09-24T18:00:00.000Z');
  assert.deepEqual([facts.source, facts.jobber], ['portal', { date: '2026-10-08', time: '09:00', endDate: '2026-10-08', endTime: '12:00', usable: true, past: false }]);
});

test('an approved portal job then waits in To schedule as a Portal approval, oldest first by its sale', () => {
  const approvedJob = { id: 'job-1', ...portalJob(), needsDispatchReview: true, dispatchReviewReason: 'portal_approval', funnelSale: { jobId: 'job-1', soldAt: PORTAL_NOW }, estimate: { acceptedAt: PORTAL_NOW } };
  assert.deepEqual(queueFacts(approvedJob, '2026-09-24T18:00:00.000Z'), { since: PORTAL_NOW, sinceKind: 'sold', ageDays: 2, source: 'portal' });
});

// The Hub page (employee-dispatch.js) in a realm with a fixed clock: undated work drops the three generic warnings, and
// 'queue' is a built-in view no calendar module can register over.
test('the page leaves no-time, no-crew and crew-size warnings off undated work and reserves the queue view', () => {
  const Fixed = class extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return Date.parse(NOW); } };
  const window = { addEventListener() {} }, context = vm.createContext({ window, Date: Fixed, Intl, console });
  vm.runInContext(readFileSync(new URL('../employee-dispatch.js', import.meta.url), 'utf8'), context, { filename: 'employee-dispatch.js' });
  const dispatch = window.EGCDispatch, state = dispatch.internals.state();
  const lines = [['unscheduled', 'This job has no scheduled time.'], ['unassigned', 'No employees are assigned.'], ['crew_size_short', 'Requires 1 crew members; 0 assigned.'], ['missing_address', 'Add the job address before dispatching the crew.']];
  state.data = { warnings: ['undated', 'dated'].flatMap(jobId => lines.map(([code, message]) => ({ code, jobId, message }))) };
  const codes = job => JSON.parse(JSON.stringify(dispatch.internals.warningsFor(job))).map(warning => warning.code);
  assert.deepEqual(codes({ id: 'undated', date: '', status: 'unscheduled' }), ['missing_address']);
  assert.deepEqual(codes({ id: 'dated', date: '2026-09-25', status: 'scheduled' }), ['unscheduled', 'unassigned', 'crew_size_short', 'missing_address'], 'dated work keeps every line');
  assert.throws(() => dispatch.registerView('queue', { label: 'Synthetic', range: date => ({ startDate: date, endDate: date }), render() {} }), /invalid or already registered/);
});

// The page lists exactly the jobs the server sent queue facts for; without them it applies the server's rule itself.
test('the page counts and lists only what the server queued, and judges a search result by the same rule', () => {
  const Fixed = class extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return Date.parse(NOW); } };
  const window = { addEventListener() {} }, context = vm.createContext({ window, Date: Fixed, Intl, console });
  vm.runInContext(readFileSync(new URL('../employee-dispatch.js', import.meta.url), 'utf8'), context, { filename: 'employee-dispatch.js' });
  const { queued: pageQueued, undated, state } = window.EGCDispatch.internals;
  const work = { id: 'w', type: 'job', status: 'unscheduled', date: '' };
  const odd = [{ ...work, status: 'Cancelled' }, { ...work, pipelineStatus: 'COMPLETED', status: 'unscheduled' }, { ...work, type: 'availability' }, { ...work, type: 'blocked' }, { ...work, date: '2026-09-25' }];
  // The server's own rule (dispatch-queue.js queued) and the page's agree on every row.
  for (const row of [work, { ...work, type: 'walkthrough' }, { ...work, status: undefined }, ...odd]) assert.equal(undated(row), queued(row), JSON.stringify(row));
  // A board with queue facts: only the rows that carry them, whatever their status says.
  state().data = { queueFacts: true, jobs: [] };
  assert.deepEqual([pageQueued({ ...work, queue: { source: 'hub' } }), pageQueued(work), pageQueued({ ...work, status: 'Cancelled' })], [true, false, false]);
  // An older response without the flag: the same rule as the server.
  state().data = { jobs: [] };
  assert.deepEqual([pageQueued(work), ...odd.map(pageQueued)], [true, false, false, false, false, false]);
});
