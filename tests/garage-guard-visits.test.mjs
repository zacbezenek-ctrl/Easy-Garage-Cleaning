import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMembershipVisit, garageGuardAction, garageGuardOverview, garageGuardStorage, garageGuardVisitTrackingEnabled, GARAGE_GUARD_OPERATIONS } from '../functions/_lib/garage-guard-visits.js';
import { fieldCommand } from '../functions/_lib/field-execution.js';
import { garageGuardMemberHandlers } from '../functions/api/garage-guard-members.js';
import { coveringPeriod, garageGuardSummary } from '../functions/_lib/garage-guard-ledger.js';
import { NOW, T0, YEAR, at, account, completeVisit, conflict, deletedEvent, invoiceEvent, member, memoryStore, unknown, webhookApply } from './helpers/garage-guard-fixture.mjs';

const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const manager = { user: 'alexk', role: 'manager', businessAccess: true, displayName: 'Synthetic Manager' };
const crew = { user: 'crew.one', role: 'crew', businessAccess: false };
const DONE = '2026-10-05T18:00:00.000Z', LATER = '2026-10-05T19:00:00.000Z';
const origin = 'https://easygaragecleaning.com';
const uuid = () => crypto.randomUUID();
const events = store => store.collection('funnelEvents');
const visitEvents = store => events(store).filter(event => event.type === 'membership.visit_used');
const addVisit = (store, id, extra = {}) => store.put(`jobs/${id}`, { type: 'job', customerId: 'cust-dana', customerAccountOwnerJobId: 'job-root', customer: 'Synthetic Dana', status: 'scheduled', ...extra });

test('a completed member visit is counted once: decrement, allocated revenue, mirror and membership.visit_used in one commit', async () => {
  const store = await member(); completeVisit(store);
  const result = await applyMembershipVisit(store, crew, { jobId: 'job-visit-1', via: 'field' }, LATER);
  assert.deepEqual(result, { status: 'applied', jobId: 'job-visit-1', membershipId: 'sub_member_1', occurrence: 1, allocatedCents: 20000, visitsRemaining: 3 });
  const [event] = visitEvents(store);
  assert.deepEqual(store.commits.at(-1), ['memberships/sub_member_1', 'jobs/job-visit-1', 'jobs/job-root', `funnelEvents/${event.id}`]);
  const membership = store.get('memberships/sub_member_1'), period = membership.periods[0];
  assert.deepEqual([membership.visitsRemaining, membership.lastVisitJobId, membership.lastVisitAt, period.visitsUsed, period.recognizedCents], [3, 'job-visit-1', DONE, 1, 20000]);
  assert.deepEqual(period.visits, [{ jobId: 'job-visit-1', usedAt: DONE, recordedAt: LATER, occurrence: 1, allocatedCents: 20000, via: 'field', by: 'crew.one' }]);
  // Review finding: managers can read jobs, so the visit's revenue stays in the server-only membership ledger.
  assert.deepEqual(store.get('jobs/job-visit-1').membershipVisit, { status: 'applied', membershipId: 'sub_member_1', occurrence: 1, periodId: 'checkout:evt_guard_checkout', usedAt: DONE, appliedAt: LATER, appliedBy: 'crew.one', via: 'field', eventId: event.id });
  assert.equal(JSON.stringify(store.get('jobs/job-visit-1')).includes('20000'), false, 'no member money on the job document');
  const guard = store.get('jobs/job-root').garageGuard;
  assert.deepEqual({ plan: guard.plan, status: guard.status, included: guard.visitsIncluded, visits: guard.visitsRemaining, by: guard.updatedBy, source: guard.source, membershipId: guard.membershipId, nextVisit: guard.nextVisit }, { plan: 'guard', status: 'active', included: 4, visits: 3, by: 'garage_guard_visit', source: 'stripe', membershipId: 'sub_member_1', nextVisit: '2026-10-05' });
  assert.deepEqual([event.occurredAt, event.clockSource, event.recordedAt, event.jobId, event.customerId, event.projectId, event.via, event.actor, event.data, event.idempotencyKey, event.isTest],
    [DONE, 'system', LATER, 'job-visit-1', 'cust-dana', 'project_job-visit-1', 'field', { id: 'crew.one', kind: 'human', role: 'crew' }, { amountCents: 20000, occurrence: 1, plan: 'guard' }, 'derived:garageGuardVisit:job-visit-1', true]);
  assert.equal(events(store).find(event => event.type === 'membership.started').isTest, true, 'a visit of a Stripe test-mode membership is test data, like its start');
  const live = await member(undefined, { livemode: true }); completeVisit(live);
  await applyMembershipVisit(live, crew, { jobId: 'job-visit-1', via: 'field' }, LATER);
  assert.deepEqual([visitEvents(live)[0].isTest, visitEvents(live)[0].exclusion], [false, null]);
  const commits = store.commits.length;
  assert.equal((await applyMembershipVisit(store, crew, { jobId: 'job-visit-1', via: 'field' }, LATER)).status, 'duplicate');
  assert.equal(store.commits.length, commits); assert.equal(store.get('memberships/sub_member_1').visitsRemaining, 3);
});

test('concurrent and lost-response applies still decrement exactly once', async () => {
  const store = await member(); completeVisit(store);
  const results = await Promise.all([applyMembershipVisit(store, crew, { jobId: 'job-visit-1' }, LATER), applyMembershipVisit(store, owner, { jobId: 'job-visit-1' }, LATER)]);
  assert.deepEqual(results.map(result => result.status).sort(), ['applied', 'duplicate']);
  assert.deepEqual([store.get('memberships/sub_member_1').visitsRemaining, visitEvents(store).length], [3, 1]);
  const lost = await member(); completeVisit(lost); lost.loseNextResponse();
  assert.equal((await applyMembershipVisit(lost, crew, { jobId: 'job-visit-1' }, LATER)).status, 'duplicate', 'the retry reads the applied visit');
  assert.deepEqual([lost.get('memberships/sub_member_1').visitsRemaining, visitEvents(lost).length], [3, 1]);
  const stale = await member(); completeVisit(stale); stale.failNextCommit(conflict(), unknown(), conflict());
  await assert.rejects(applyMembershipVisit(stale, crew, { jobId: 'job-visit-1' }, LATER), { code: 'dispatch_revision_conflict' });
  assert.deepEqual([stale.get('memberships/sub_member_1').visitsRemaining, stale.get('jobs/job-visit-1').membershipVisit], [4, undefined], 'nothing partial is written');
});

test('four visits recognize exactly the price paid, and a fifth needs review without going below zero', async () => {
  const store = await member(undefined, { paid: 80001 });
  const ids = ['job-visit-1', 'job-visit-2', 'job-visit-3', 'job-visit-4', 'job-visit-5'];
  const dates = ['2026-10-05', '2026-11-05', '2026-12-05', '2027-01-05', '2027-02-05'];
  for (const [index, id] of ids.entries()) { if (index) addVisit(store, id); completeVisit(store, id, `${dates[index]}T18:00:00.000Z`); }
  const results = []; for (const id of ids) results.push(await applyMembershipVisit(store, owner, { jobId: id }, '2027-03-01T00:00:00.000Z'));
  assert.deepEqual(results.map(result => [result.status, result.occurrence, result.allocatedCents, result.reason]), [['applied', 1, 20000, undefined], ['applied', 2, 20000, undefined], ['applied', 3, 20000, undefined], ['applied', 4, 20001, undefined], ['needs_review', undefined, undefined, 'no_visits_remaining']]);
  const membership = store.get('memberships/sub_member_1');
  assert.deepEqual([membership.visitsRemaining, membership.periods[0].recognizedCents, membership.periods[0].visitsUsed, store.get('jobs/job-root').garageGuard.visitsRemaining], [0, 80001, 4, 0]);
  assert.deepEqual(store.get('jobs/job-visit-5').membershipVisit, { status: 'needs_review', reason: 'no_visits_remaining', membershipId: 'sub_member_1', checkedAt: '2027-03-01T00:00:00.000Z', checkedBy: 'zacb', via: 'hub' });
  const commits = store.commits.length;
  assert.equal((await applyMembershipVisit(store, owner, { jobId: 'job-visit-5' }, '2027-03-02T00:00:00.000Z')).reason, 'no_visits_remaining');
  assert.equal(store.commits.length, commits, 'an unchanged review reason is not rewritten');
});

test('visits the membership cannot take are marked for review and never decrement', async () => {
  const cases = [
    ['membership_not_found', store => completeVisit(store, 'job-visit-1', DONE, { membershipId: 'sub_missing' })],
    ['customer_mismatch', store => { store.put('jobs/job-other', { ...store.get('jobs/job-other'), membershipId: 'sub_member_1' }); return 'job-other'; }],
    ['membership_not_active', store => { completeVisit(store); store.put('memberships/sub_member_1', { ...store.get('memberships/sub_member_1'), status: 'cancelled' }); }],
    ['membership_unlinked', store => { completeVisit(store); store.put('memberships/sub_member_1', { ...store.get('memberships/sub_member_1'), link: { status: 'needs_review', reason: 'ambiguous_customer' } }); }],
    ['visits_unknown', store => { completeVisit(store); store.put('memberships/sub_member_1', { ...store.get('memberships/sub_member_1'), visitsRemaining: null }); }],
    ['account_job_changed', store => { completeVisit(store); store.put('jobs/job-root', { ...store.get('jobs/job-root'), customerId: 'cust-other' }); }],
  ];
  for (const [reason, arrange] of cases) {
    const store = await member(), target = arrange(store), jobId = typeof target === 'string' ? target : 'job-visit-1', before = store.get('memberships/sub_member_1').visitsRemaining;
    const result = await applyMembershipVisit(store, owner, { jobId }, LATER);
    assert.deepEqual([result.status, result.reason], ['needs_review', reason], reason);
    assert.equal(store.get(`jobs/${jobId}`).membershipVisit.reason, reason);
    assert.equal(store.get('memberships/sub_member_1').visitsRemaining, before); assert.equal(visitEvents(store).length, 0);
  }
  const store = await member(); addVisit(store, 'job-plain', { status: 'completed', completedAt: DONE });
  assert.deepEqual(await applyMembershipVisit(store, owner, { jobId: 'job-plain' }, LATER), { status: 'not_member_visit', jobId: 'job-plain' });
  store.put('jobs/job-visit-1', { ...store.get('jobs/job-visit-1'), membershipId: 'sub_member_1' });
  assert.equal((await applyMembershipVisit(store, owner, { jobId: 'job-visit-1' }, LATER)).status, 'not_completed');
  store.put('jobs/_egc_lock', { type: 'job', membershipId: 'sub_member_1' });
  for (const jobId of ['_egc_lock', 'secure_x', 'bad id', 'job-missing']) await assert.rejects(applyMembershipVisit(store, owner, { jobId }, LATER), error => ['garage_guard_visit_invalid', 'garage_guard_visit_not_found'].includes(error.code));
});

test('a manual browser count blocks counting until an owner or manager reconciles it; reconciling recognizes the visits used outside the Hub', async () => {
  const store = await member(); completeVisit(store);
  store.put('jobs/job-root', { ...store.get('jobs/job-root'), garageGuard: { plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 2, nextVisit: '2026-11-02', updatedAt: NOW, updatedBy: 'alexk', source: 'hub_manual' } });
  const blocked = await applyMembershipVisit(store, crew, { jobId: 'job-visit-1', via: 'field' }, LATER);
  assert.deepEqual([blocked.status, blocked.reason], ['needs_review', 'manual_edit_open']);
  const flag = store.get('memberships/sub_member_1').manualEdit;
  assert.deepEqual([flag.status, flag.fields, flag.rewritten, flag.detectedBy, flag.observed.visitsRemaining], ['open', ['visitsRemaining'], true, 'visit:job-visit-1', 2]);
  const revision = store.revisionOf('memberships/sub_member_1'), requestId = uuid();
  const reconcile = { action: 'visits.reconcile', requestId, membershipId: 'sub_member_1', expectedRevision: revision, visitsRemaining: 2, note: 'Two visits were done in August before tracking.' };
  const saved = await garageGuardAction(store, owner, reconcile, LATER);
  assert.deepEqual(saved, { ok: true, authority: 'employee_hub', action: 'visits.reconcile', requestId, status: 'reconciled', membershipId: 'sub_member_1', visitsRemaining: 2, previousVisitsRemaining: 4, mirrored: true, recognizedCents: 40000, manualEditResolved: true, coveredJobIds: [], replayed: false });
  const membership = store.get('memberships/sub_member_1'), period = membership.periods[0];
  assert.deepEqual([membership.visitsRemaining, membership.manualEdit.status, membership.manualEdit.resolvedBy, period.recognizedCents, period.visitsUsed, period.adjustments], [2, 'resolved', 'zacb', 40000, 2, [{ at: LATER, by: 'zacb', from: 4, to: 2, recognizedCents: 40000, note: 'Two visits were done in August before tracking.', jobIds: [] }]]);
  const guard = store.get('jobs/job-root').garageGuard;
  assert.deepEqual({ visits: guard.visitsRemaining, source: guard.source, by: guard.updatedBy, nextVisit: guard.nextVisit, membershipId: guard.membershipId }, { visits: 2, source: 'stripe', by: 'garage_guard_reconcile', nextVisit: '2026-11-02', membershipId: 'sub_member_1' });
  const audit = store.collection('hub_audit');
  assert.deepEqual(audit.map(entry => [entry.action, entry.entityKey, entry.requestId, entry.reason, entry.actor.id]), [['garage_guard.visits_reconcile', 'memberships/sub_member_1', requestId, 'Two visits were done in August before tracking.', 'zacb']]);
  assert.ok(store.commits.at(-1).includes(`${GARAGE_GUARD_OPERATIONS}/${requestId}`) && store.commits.at(-1).includes(`hub_audit/${audit[0].id}`), 'receipt and audit share the reconcile commit');
  assert.deepEqual(await garageGuardAction(store, owner, reconcile, '2026-10-06T00:00:00.000Z'), { ...saved, replayed: true });
  await assert.rejects(garageGuardAction(store, owner, { ...reconcile, visitsRemaining: 1 }, LATER), { code: 'garage_guard_idempotency_conflict', status: 409 });
  // The blocked visit now counts as the third of four.
  const applied = await applyMembershipVisit(store, crew, { jobId: 'job-visit-1' }, LATER);
  assert.deepEqual([applied.status, applied.occurrence, applied.allocatedCents, applied.visitsRemaining], ['applied', 3, 20000, 1]);
  assert.deepEqual([store.get('memberships/sub_member_1').periods[0].recognizedCents, store.get('jobs/job-root').garageGuard.visitsRemaining], [60000, 1]);
  await assert.rejects(garageGuardAction(store, owner, { ...reconcile, requestId: uuid() }, LATER), { code: 'garage_guard_revision_conflict', status: 409 });
  const restored = await garageGuardAction(store, manager, { ...reconcile, requestId: uuid(), expectedRevision: store.revisionOf('memberships/sub_member_1'), visitsRemaining: 2, note: 'Customer was promised one visit back.' }, LATER);
  assert.deepEqual([restored.visitsRemaining, restored.previousVisitsRemaining, restored.manualEditResolved, 'recognizedCents' in restored], [2, 1, false, false], 'managers never see recognized revenue');
  assert.deepEqual(store.get('memberships/sub_member_1').periods[0].adjustments.at(-1).recognizedCents, 0, 'restoring a visit reverses no revenue');
  assert.deepEqual([store.get('memberships/sub_member_1').periods[0].recognizedCents, store.get('memberships/sub_member_1').periods[0].visitsUsed], [60000, 2]);
  for (const bad of [{ visitsRemaining: 5 }, { visitsRemaining: -1 }, { visitsRemaining: 1.5 }, { note: 'short' }]) await assert.rejects(garageGuardAction(store, owner, { ...reconcile, requestId: uuid(), expectedRevision: store.revisionOf('memberships/sub_member_1'), ...bad }, LATER), { code: 'garage_guard_reconcile_invalid', status: 400 });
});

test('a stored manual-edit flag stays for the owner, but once the account matches again visits count', async () => {
  const store = await member(undefined, { livemode: true }); completeVisit(store);
  store.put('memberships/sub_member_1', { ...store.get('memberships/sub_member_1'), manualEdit: { status: 'open', firstDetectedAt: NOW, fields: ['visitsRemaining'] } });
  const applied = await applyMembershipVisit(store, crew, { jobId: 'job-visit-1' }, LATER);
  assert.deepEqual([applied.status, store.get('memberships/sub_member_1').manualEdit.status], ['applied', 'open']);
  const view = await garageGuardOverview(store, owner, {}, new Date(LATER));
  assert.deepEqual([view.memberships[0].manualEdit.stored, view.counts.manualEdits, view.summary.coverage.counts.manualEdits], [true, 1, 1]);
});

test('visit.link makes a service visit of the member customer a member visit, with a receipt, audit and membership fence', async () => {
  const store = await member(); addVisit(store, 'job-service', { date: '2026-11-05', visitPurpose: 'service' });
  const input = { action: 'visit.link', requestId: uuid(), jobId: 'job-service', membershipId: 'sub_member_1', expectedRevision: store.revisionOf('jobs/job-service') };
  const linked = await garageGuardAction(store, manager, input, LATER);
  assert.deepEqual([linked.status, linked.completed, linked.replayed], ['linked', false, false]);
  const job = store.get('jobs/job-service');
  assert.deepEqual([job.membershipId, job.visitPurpose, job.membershipLinkedBy, job.membershipLinkedAt], ['sub_member_1', 'member_visit', 'alexk', LATER]);
  // Second review: the link writes the membership at the revision the decision read (a fence a Stripe event closing a year meanwhile conflicts with), never only verifies it.
  assert.deepEqual([store.verified.at(-1), store.commits.at(-1).includes('memberships/sub_member_1'), store.get('memberships/sub_member_1').lastVisitLinkAt, store.get('memberships/sub_member_1').lastVisitLinkJobId], [[], true, LATER, 'job-service'], 'the membership the decision read is fenced by a write');
  assert.deepEqual(store.collection('hub_audit').map(entry => [entry.action, entry.entityKey]), [['garage_guard.visit_link', 'jobs/job-service']]);
  assert.equal((await garageGuardAction(store, manager, { ...input, requestId: uuid(), expectedRevision: store.revisionOf('jobs/job-service') }, LATER)).status, 'already_linked');
  const refusals = [
    ['garage_guard_revision_conflict', 409, s => ({ jobId: 'job-visit-1', expectedRevision: 'stale' })],
    ['garage_guard_visit_other_membership', 409, s => { s.put('jobs/job-visit-1', { ...s.get('jobs/job-visit-1'), membershipId: 'sub_other' }); return {}; }],
    ['garage_guard_visit_purpose_conflict', 409, s => { s.put('jobs/job-visit-1', { ...s.get('jobs/job-visit-1'), visitPurpose: 'rework' }); return {}; }],
    ['garage_guard_membership_customer_mismatch', 409, s => ({ jobId: 'job-other', expectedRevision: s.revisionOf('jobs/job-other') })],
    ['garage_guard_membership_not_active', 409, s => { s.put('memberships/sub_member_1', { ...s.get('memberships/sub_member_1'), status: 'cancelled' }); return {}; }],
    ['garage_guard_membership_not_found', 404, () => ({ membershipId: 'sub_missing' })],
    ['garage_guard_visit_cancelled', 409, s => { s.put('jobs/job-visit-1', { ...s.get('jobs/job-visit-1'), status: 'cancelled' }); return {}; }],
  ];
  for (const [code, status, arrange] of refusals) {
    const fresh = await member(), extra = arrange(fresh);
    await assert.rejects(garageGuardAction(fresh, manager, { action: 'visit.link', requestId: uuid(), jobId: 'job-visit-1', membershipId: 'sub_member_1', expectedRevision: fresh.revisionOf('jobs/job-visit-1'), ...extra }, LATER), { code, status }, code);
  }
});

test('visit.apply is a manager action behind the tracking flag; managers never see member money, the owner does', async () => {
  const store = await member(); completeVisit(store);
  const input = { action: 'visit.apply', requestId: uuid(), jobId: 'job-visit-1' };
  await assert.rejects(garageGuardAction(store, manager, input, LATER), { code: 'garage_guard_visits_disabled', status: 503 });
  assert.equal(garageGuardVisitTrackingEnabled({ GARAGE_GUARD_VISIT_TRACKING_ENABLED: 'true' }), true);
  for (const value of [undefined, 'TRUE', '1', 'yes']) assert.equal(garageGuardVisitTrackingEnabled({ GARAGE_GUARD_VISIT_TRACKING_ENABLED: value }), false);
  const applied = await garageGuardAction(store, manager, input, LATER, { visitsEnabled: true });
  assert.equal((await garageGuardAction(store, manager, input, LATER)).replayed, true, 'a saved apply replays even after tracking is switched off');
  assert.deepEqual(applied, { ok: true, authority: 'employee_hub', action: 'visit.apply', requestId: input.requestId, status: 'applied', jobId: 'job-visit-1', membershipId: 'sub_member_1', occurrence: 1, visitsRemaining: 3, replayed: false });
  assert.equal((await garageGuardAction(store, owner, { ...input, requestId: uuid() }, LATER, { visitsEnabled: true })).allocatedCents, 20000, 'the owner sees the allocation of a duplicate apply');
  assert.equal(store.get(`${GARAGE_GUARD_OPERATIONS}/${input.requestId}`).result.allocatedCents, 20000, 'the server-only receipt keeps the full result');
  assert.deepEqual(store.collection('hub_audit').map(entry => entry.action), ['garage_guard.visit_apply']);
  await assert.rejects(garageGuardAction(store, crew, input, LATER, { visitsEnabled: true }), { code: 'dispatch_forbidden', status: 403 });
  await assert.rejects(garageGuardAction(store, null, input, LATER, { visitsEnabled: true }), { code: 'dispatch_sign_in_required', status: 401 });
  for (const [body, code] of [[{ ...input, requestId: 'not-a-uuid' }, 'garage_guard_request_id_invalid'], [{ ...input, extra: 1 }, 'garage_guard_action_invalid'], [{ action: 'visit.delete', requestId: uuid() }, 'garage_guard_action_invalid'], [{ ...input, requestId: uuid(), actorId: 'someone-else' }, 'garage_guard_actor_changed']]) {
    await assert.rejects(garageGuardAction(store, manager, body, LATER, { visitsEnabled: true }), { code });
  }
  // A lost response is recovered from the receipt, never applied twice.
  const lost = await member(); completeVisit(lost); lost.loseNextResponse();
  const recovered = await garageGuardAction(lost, owner, { action: 'visit.apply', requestId: uuid(), jobId: 'job-visit-1' }, LATER, { visitsEnabled: true });
  assert.deepEqual([recovered.status, recovered.replayed, lost.get('memberships/sub_member_1').visitsRemaining], ['applied', true, 3]);
  const unsure = await member(); completeVisit(unsure); unsure.failNextCommit(unknown(), unknown(), unknown());
  await assert.rejects(garageGuardAction(unsure, owner, { action: 'visit.apply', requestId: uuid(), jobId: 'job-visit-1' }, LATER, { visitsEnabled: true }), { code: 'garage_guard_outcome_unknown', status: 503 });
  assert.equal(unsure.get('memberships/sub_member_1').visitsRemaining, 4);
  const retried = await member(); completeVisit(retried); retried.failNextCommit(unknown());
  assert.deepEqual([(await garageGuardAction(retried, owner, { action: 'visit.apply', requestId: uuid(), jobId: 'job-visit-1' }, LATER, { visitsEnabled: true })).status, retried.get('memberships/sub_member_1').visitsRemaining], ['applied', 3], 'an unconfirmed commit without a receipt is re-planned once, never doubled');
});

test('the overview lists members with live manual-edit flags, member visits by state and the A8 summary (money for the owner only)', async () => {
  const store = await member(undefined, { livemode: true }); completeVisit(store);
  await applyMembershipVisit(store, crew, { jobId: 'job-visit-1' }, LATER);
  addVisit(store, 'job-pending', { membershipId: 'sub_member_1', status: 'completed', completedAt: DONE, membershipVisit: { status: 'pending', membershipId: 'sub_member_1' } });
  addVisit(store, 'job-untracked', { membershipId: 'sub_member_1', status: 'completed', completedAt: DONE });
  addVisit(store, 'job-next', { membershipId: 'sub_member_1', date: '2027-01-05' });
  store.put('jobs/secure_hidden', { type: 'job', membershipId: 'sub_member_1', status: 'completed', completedAt: DONE });
  store.put('jobs/job-root', { ...store.get('jobs/job-root'), garageGuard: { ...store.get('jobs/job-root').garageGuard, visitsRemaining: 1, source: 'hub_manual' } });
  const now = new Date('2026-10-20T18:00:00.000Z');
  const view = await garageGuardOverview(store, manager, {}, now, { visitsEnabled: true });
  assert.deepEqual([view.ok, view.viewer.money, view.visitTrackingEnabled, view.period.period, view.period.from, view.period.startAt, view.period.elapsedThrough], [true, false, true, 'mtd', '2026-10-01', '2026-10-01T06:00:00.000Z', now.toISOString()]);
  const [row] = view.memberships;
  assert.deepEqual([row.subscriptionId, row.plan, row.status, row.link, row.customerId, row.accountJobId, row.visitsIncluded, row.visitsRemaining, row.startedAt, row.openPeriod.visitsUsed], ['sub_member_1', 'guard', 'active', 'linked', 'cust-dana', 'job-root', 4, 3, NOW, 1]);
  assert.deepEqual([row.manualEdit.fields, row.manualEdit.rewritten, row.manualEdit.stored], [['visitsRemaining'], true, false], 'an edit made after the last server write is flagged live');
  for (const key of ['amountPaidCents', 'deferredCents', 'lifetimePaidCents', 'promotionCodes']) assert.equal(Object.hasOwn(row, key), false, key);
  assert.equal(row.openPeriod.paidCents, undefined); assert.equal(view.summary.revenue, null);
  assert.deepEqual(view.visits.map(visit => [visit.jobId, visit.state]), [['job-next', 'scheduled'], ['job-pending', 'pending'], ['job-untracked', 'not_recorded'], ['job-visit-1', 'applied']]);
  assert.equal(view.visits.some(visit => 'allocatedCents' in visit), false);
  assert.deepEqual(view.counts, { memberships: 1, manualEdits: 1, pendingVisits: 1, unrecordedVisits: 1, visitsNeedingReview: 0, appliedVisits: 1, reconciledVisits: 0 });
  assert.equal(row.testMode, false);
  // Fifth review (probeA A6): the live browser count makes the open year's visits unknown in the summary too, and the view incomplete.
  assert.deepEqual([view.summary.members.active, view.summary.visits.usedInPeriod, view.summary.visits.knownUsedInPeriod, view.summary.coverage.counts.manualEdits], [1, null, 1, 1]);
  assert.deepEqual([view.coverage.complete, view.coverage.manualEdits, view.coverage.reasons.includes('manualEdits')], [false, 1, true]);
  // Once the account shows the membership's count again, the totals are known.
  store.put('jobs/job-root', { ...store.get('jobs/job-root'), garageGuard: { ...store.get('jobs/job-root').garageGuard, visitsRemaining: 3, source: 'stripe' } });
  const mine = await garageGuardOverview(store, owner, { period: 'custom', from: '2026-09-01', to: '2026-11-01' }, now);
  assert.deepEqual([mine.memberships[0].manualEdit, mine.coverage.manualEdits, mine.summary.visits.usedInPeriod], [null, 0, 1]);
  assert.deepEqual([mine.viewer.money, mine.memberships[0].amountPaidCents, mine.memberships[0].deferredCents, mine.memberships[0].promotionCodes, mine.visits.find(visit => visit.jobId === 'job-visit-1').allocatedCents], [true, 80000, 60000, ['promo_synthetic_ten'], 20000]);
  assert.deepEqual([mine.summary.revenue.subscriptionCashCents, mine.summary.revenue.visitRevenueCents, mine.summary.revenue.deferredCents, mine.summary.members.started], [80000, 20000, 60000, 1]);
  assert.deepEqual(mine.summary.revenue.memberLtv, { basis: 'revenue', members: 1, totalCents: 80000, averageCents: 80000 });
  // A Stripe test-mode membership is listed (flagged) but left out of every summary number.
  store.put('memberships/sub_member_1', { ...store.get('memberships/sub_member_1'), livemode: false });
  const test = await garageGuardOverview(store, owner, { period: 'custom', from: '2026-09-01', to: '2026-11-01' }, now);
  assert.deepEqual([test.memberships.length, test.memberships[0].testMode, test.summary.members.total, test.summary.revenue.subscriptionCashCents, test.summary.visits.usedInPeriod, test.summary.coverage.excluded], [1, true, 0, 0, 0, { testMode: 1 }]);
  await assert.rejects(garageGuardOverview(store, crew, {}, now), { code: 'dispatch_forbidden' });
  await assert.rejects(garageGuardOverview(store, owner, { period: 'custom', from: '2026-11-01', to: '2026-10-01' }, now), { code: 'funnel_period_invalid' });
  await assert.rejects(garageGuardOverview(store, owner, { period: 'mtd', from: '2026-10-01' }, now), { code: 'garage_guard_invalid_query', status: 400 });
  const partial = await member(); partial.list = async name => ({ rows: partial.collection(name), complete: false });
  assert.equal((await garageGuardOverview(partial, owner, {}, now)).coverage.complete, false, 'a truncated scan is never presented as complete');
});

test('the HTTP endpoint checks sign-in, origin, content type, size and query before touching storage', async () => {
  const store = await member(); let actor = manager;
  const handlers = garageGuardMemberHandlers({ session: async () => actor, storage: () => store, now: () => new Date('2026-10-20T18:00:00.000Z') });
  const env = { GARAGE_GUARD_VISIT_TRACKING_ENABLED: 'true' };
  const get = query => handlers.get({ env, request: new Request(`${origin}/api/garage-guard-members${query}`) });
  const post = (body, headers = {}) => handlers.post({ env, request: new Request(`${origin}/api/garage-guard-members`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  const ok = await get('?period=last_month');
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('Cache-Control'), 'no-store'); assert.equal((await ok.json()).period.period, 'last_month');
  for (const [query, code] of [['?nope=1', 'garage_guard_invalid_query'], ['?period=mtd&period=ytd', 'garage_guard_invalid_query'], ['?period=forever', 'funnel_period_invalid']]) {
    const response = await get(query); assert.equal(response.status, 400); assert.equal((await response.json()).code, code);
  }
  const cases = [
    [post({ action: 'visit.apply', requestId: uuid(), jobId: 'job-visit-1' }, { 'Sec-Fetch-Site': 'cross-site' }), 403, 'garage_guard_origin_forbidden'],
    [post({ action: 'visit.apply', requestId: uuid(), jobId: 'job-visit-1' }, { Origin: 'https://evil.example' }), 403, 'garage_guard_origin_forbidden'],
    [post({ action: 'visit.apply' }, { 'Content-Type': 'text/plain' }), 415, 'garage_guard_content_type'],
    [post('x'.repeat(9000)), 413, 'garage_guard_too_large'],
    [post('{bad'), 400, 'garage_guard_json_invalid'],
  ];
  for (const [pending, status, code] of cases) { const response = await pending; assert.equal(response.status, status); assert.equal((await response.json()).code, code); }
  completeVisit(store);
  const applied = await post({ action: 'visit.apply', requestId: uuid(), jobId: 'job-visit-1' });
  assert.equal(applied.status, 200); assert.equal((await applied.json()).status, 'applied');
  actor = null;
  const signedOut = await get(''); assert.equal(signedOut.status, 401); assert.equal((await signedOut.json()).code, 'dispatch_sign_in_required');
  actor = owner; store.list = async () => { throw new Error('Synthetic raw storage failure with secrets'); };
  const failed = await get(''), body = await failed.json();
  assert.equal(failed.status, 503); assert.equal(body.code, 'garage_guard_unavailable'); assert.equal(JSON.stringify(body).includes('Synthetic raw'), false);
});

test('field completion records a pending member visit in the completion commit only for member visits', () => {
  const job = { id: 'job-1', type: 'job', status: 'in_progress', pipelineStatus: 'in_progress', membershipId: 'sub_member_1', fieldExecution: { checks: {}, photos: [] } };
  const complete = (value, extra = {}) => { try { return fieldCommand(value, { user: 'crew.one', displayName: 'Crew One' }, { action: 'complete', requestId: '11111111-1111-4111-8111-111111111111', notes: 'Garage swept, re-tidied and hauled.', hasIssues: false, ...extra }, NOW).patch; } catch (error) { return error; } };
  const blocked = complete(job);
  assert.equal(blocked.code, 'FIELD_COMPLETION_INCOMPLETE', 'closeout rules are unchanged for member visits');
  const ready = { ...job, fieldExecution: { checks: Object.fromEntries(['departure-address', 'departure-equipment', 'arrival-scope', 'arrival-protection', 'work-scope', 'finish-cleanup', 'finish-walkthrough', 'finish-equipment'].map(id => [id, { completed: true }])), photos: ['before', 'after'].map((category, index) => ({ id: `1111111${index}-1111-4111-8111-111111111111`, fileId: `file-${category}`, category, verified: true })) } };
  assert.deepEqual(complete(ready).membershipVisit, { status: 'pending', membershipId: 'sub_member_1', requestId: '11111111-1111-4111-8111-111111111111', createdAt: NOW });
  assert.equal(complete({ ...ready, membershipId: undefined }).membershipVisit, undefined);
  // Review finding: a job reopened by a browser status edit and completed again keeps its counted state.
  for (const status of ['applied', 'reconciled']) assert.equal(complete({ ...ready, membershipVisit: { status, membershipId: 'sub_member_1', occurrence: 1 } }).membershipVisit, undefined, status);
  assert.equal(complete({ ...ready, membershipVisit: { status: 'needs_review', reason: 'no_visits_remaining' } }).membershipVisit.status, 'pending', 'a visit never counted is checked again');
  assert.equal(account()['jobs/job-visit-1'].customerAccountOwnerJobId, 'job-root');
  assert.equal(at(T0), NOW);
});

test('a visit completed before a renewal but applied after it counts in the year it happened, turning that year\'s breakage back into visit revenue', async () => {
  const store = await member(undefined, { livemode: true }), renewedAt = T0 + YEAR - 3600, done = at(T0 + YEAR - 2 * 86400);
  completeVisit(store, 'job-visit-1', done);
  await webhookApply(store, invoiceEvent({ id: 'evt_guard_renewal', reason: 'subscription_cycle', created: renewedAt, invoice: 'in_guard_second', periodEnd: T0 + 2 * YEAR, livemode: true }), at(renewedAt + 60));
  // Review finding: the visit was completed (pending) when the year closed, so its breakage is unknown until it is counted, and the renewal event leaves it out.
  assert.deepEqual(store.get('memberships/sub_member_1').periods.map(period => [period.status, period.recognizedCents, period.breakageCents, period.breakageUnknown, period.unresolvedVisitJobIds]), [['closed', 0, null, 'visits_unresolved', ['job-visit-1']], ['open', 0, null, null, undefined]]);
  assert.equal('breakageCents' in events(store).find(event => event.type === 'membership.renewed').data, false);
  assert.equal(coveringPeriod(store.get('memberships/sub_member_1').periods, done).id, 'checkout:evt_guard_checkout');
  const later = at(renewedAt + 3600), applied = await applyMembershipVisit(store, owner, { jobId: 'job-visit-1' }, later);
  assert.deepEqual(applied, { status: 'applied', jobId: 'job-visit-1', membershipId: 'sub_member_1', occurrence: 1, allocatedCents: 20000, visitsRemaining: 4, periodId: 'checkout:evt_guard_checkout', periodClosed: true });
  const membership = store.get('memberships/sub_member_1');
  assert.deepEqual(membership.periods.map(period => [period.status, period.visitsUsed, period.recognizedCents, period.breakageCents, period.visits.length]), [['closed', 1, 20000, 60000, 1], ['open', 0, 0, null, 0]]);
  assert.deepEqual([membership.periods[0].unresolvedVisitJobIds, membership.periods[0].breakageUnknown], [[], null], 'counting the visit settles the year it was waiting on');
  assert.deepEqual([membership.visitsRemaining, store.get('jobs/job-root').garageGuard.visitsRemaining], [4, 4], 'the new year keeps all its visits, in the portal too');
  assert.deepEqual(membership.periods[0].visits[0], { jobId: 'job-visit-1', usedAt: done, recordedAt: later, occurrence: 1, allocatedCents: 20000, via: 'hub', by: 'zacb', afterClose: true });
  const marker = store.get('jobs/job-visit-1').membershipVisit;
  assert.deepEqual([marker.status, marker.periodId, marker.periodClosed, marker.usedAt], ['applied', 'checkout:evt_guard_checkout', true, done]);
  assert.deepEqual(visitEvents(store).map(event => [event.occurredAt, event.data]), [[done, { amountCents: 20000, occurrence: 1, plan: 'guard' }]]);
  assert.equal(store.commits.at(-1).includes('jobs/job-root'), false, 'the account job is not rewritten');
  const summary = garageGuardSummary(store.collection('memberships'), { startAt: at(T0 + YEAR - 3 * 86400), endAt: at(T0 + YEAR), asOf: later }).revenue;
  assert.deepEqual([summary.visitRevenueCents, summary.breakageCents, summary.recognizedCents], [20000, 60000, 80000], 'year one still recognizes exactly what was paid');
  assert.equal((await applyMembershipVisit(store, owner, { jobId: 'job-visit-1' }, later)).status, 'duplicate');

  // A visit completed before a cancellation counts in the cancelled year; one after it cannot.
  const gone = await member(undefined, { livemode: true }); completeVisit(gone, 'job-visit-1', at(T0 + 1000)); addVisit(gone, 'job-after', { membershipId: 'sub_member_1', status: 'completed', completedAt: at(T0 + 2500) });
  await webhookApply(gone, deletedEvent({ created: T0 + 2000, livemode: true }), at(T0 + 2100));
  const counted = await applyMembershipVisit(gone, owner, { jobId: 'job-visit-1' }, at(T0 + 3000));
  assert.deepEqual([counted.status, counted.periodClosed, gone.get('memberships/sub_member_1').periods[0].breakageCents, gone.get('memberships/sub_member_1').periods[0].closeReason], ['applied', true, 60000, 'cancelled']);
  assert.deepEqual([(await applyMembershipVisit(gone, owner, { jobId: 'job-after' }, at(T0 + 3000))).reason, gone.get('memberships/sub_member_1').visitsRemaining], ['membership_not_active', 4]);
});

test('a visit before the membership started is never counted or linked', async () => {
  const store = await member(undefined, { livemode: true });
  completeVisit(store, 'job-visit-1', at(T0 - 86400));
  assert.deepEqual(await applyMembershipVisit(store, owner, { jobId: 'job-visit-1' }, LATER), { status: 'needs_review', reason: 'visit_before_membership', jobId: 'job-visit-1', membershipId: 'sub_member_1' });
  assert.deepEqual([store.get('memberships/sub_member_1').visitsRemaining, store.get('memberships/sub_member_1').periods[0].visitsUsed, visitEvents(store).length], [4, 0, 0]);
  addVisit(store, 'job-old', { status: 'completed', completedAt: at(T0 - 3600), visitPurpose: 'service' });
  addVisit(store, 'job-stale', { date: '2026-09-01', visitPurpose: 'service' });
  for (const jobId of ['job-old', 'job-stale']) {
    await assert.rejects(garageGuardAction(store, manager, { action: 'visit.link', requestId: uuid(), jobId, membershipId: 'sub_member_1', expectedRevision: store.revisionOf(`jobs/${jobId}`) }, LATER), { code: 'garage_guard_visit_before_membership', status: 409 }, jobId);
    assert.equal(store.get(`jobs/${jobId}`).membershipId, undefined);
  }
  // A member recorded before the ledger has no known start; its pre-ledger year is a stub with unknown visits, so a visit in it goes to a manager.
  const legacy = memoryStore();
  legacy.put('memberships/sub_member_1', { subscriptionId: 'sub_member_1', plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 4, currentPeriodEnd: at(T0), statusEventCreated: T0 - YEAR, livemode: true,
    link: { status: 'linked', customerId: 'cust-dana', accountJobId: 'job-root', mirroredAt: at(T0 - YEAR) } });
  completeVisit(legacy, 'job-visit-1', at(T0 - 86400));
  await webhookApply(legacy, invoiceEvent({ id: 'evt_guard_legacy_renewal', reason: 'subscription_cycle', created: T0 + 60, invoice: 'in_guard_second', livemode: true }), at(T0 + 120));
  assert.deepEqual((await applyMembershipVisit(legacy, owner, { jobId: 'job-visit-1' }, at(T0 + 600))).reason, 'visit_before_period');
  assert.deepEqual([legacy.get('memberships/sub_member_1').visitsRemaining, legacy.get('memberships/sub_member_1').periods.map(period => period.visitsUsed)], [4, [null, 0]]);
});

test('a counted visit completed again is restored from the ledger, never counted twice, and a manager apply answers instead of failing', async () => {
  const store = await member(); completeVisit(store);
  await applyMembershipVisit(store, crew, { jobId: 'job-visit-1', via: 'field' }, LATER);
  // Reopened by a legacy browser status edit and completed again: a new completedAt and a pending marker.
  const reopen = target => target.put('jobs/job-visit-1', { ...target.get('jobs/job-visit-1'), completedAt: '2026-10-06T18:00:00.000Z', membershipVisit: { status: 'pending', membershipId: 'sub_member_1' } });
  reopen(store);
  const commits = store.commits.length;
  assert.deepEqual(await applyMembershipVisit(store, crew, { jobId: 'job-visit-1', via: 'field' }, '2026-10-06T19:00:00.000Z'), { status: 'duplicate', jobId: 'job-visit-1', membershipId: 'sub_member_1', occurrence: 1, allocatedCents: 20000, restored: true });
  const marker = store.get('jobs/job-visit-1').membershipVisit;
  assert.deepEqual([marker.status, marker.occurrence, marker.periodId, marker.appliedAt, marker.restoredBy], ['applied', 1, 'checkout:evt_guard_checkout', LATER, 'crew.one']);
  assert.deepEqual([store.commits.length, store.verified.at(-1), store.get('memberships/sub_member_1').visitsRemaining, visitEvents(store).length], [commits + 1, ['memberships/sub_member_1'], 3, 1]);
  // Through the endpoint the manager gets the duplicate, not a generic retry.
  reopen(store);
  const handlers = garageGuardMemberHandlers({ session: async () => manager, storage: () => store, now: () => new Date('2026-10-07T00:00:00.000Z') });
  const post = body => handlers.post({ env: { GARAGE_GUARD_VISIT_TRACKING_ENABLED: 'true' }, request: new Request(`${origin}/api/garage-guard-members`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const response = await post({ action: 'visit.apply', requestId: uuid(), jobId: 'job-visit-1' });
  assert.equal(response.status, 200); assert.deepEqual([(await response.json()).status, store.get('memberships/sub_member_1').visitsRemaining], ['duplicate', 3]);
  // If the ledger no longer shows it but its visit_used event exists, a manager decides.
  const bare = await member(); completeVisit(bare);
  await applyMembershipVisit(bare, crew, { jobId: 'job-visit-1' }, LATER);
  const saved = bare.get('memberships/sub_member_1'); saved.periods[0].visits = []; bare.put('memberships/sub_member_1', saved); reopen(bare);
  assert.deepEqual(await applyMembershipVisit(bare, owner, { jobId: 'job-visit-1' }, '2026-10-06T19:00:00.000Z'), { status: 'needs_review', reason: 'already_counted', jobId: 'job-visit-1', membershipId: 'sub_member_1' });
  assert.deepEqual([bare.get('memberships/sub_member_1').visitsRemaining, visitEvents(bare).length], [3, 1]);
  // Nor does an identical event on file: it is written with the ledger entry, so the visit was counted.
  const same = await member(); completeVisit(same);
  await applyMembershipVisit(same, crew, { jobId: 'job-visit-1' }, LATER);
  const lost = same.get('memberships/sub_member_1'); Object.assign(lost, { visitsRemaining: 4 }); Object.assign(lost.periods[0], { visits: [], visitsUsed: 0, recognizedCents: 0 }); same.put('memberships/sub_member_1', lost);
  same.put('jobs/job-root', { ...same.get('jobs/job-root'), garageGuard: { ...same.get('jobs/job-root').garageGuard, visitsRemaining: 4 } });
  same.put('jobs/job-visit-1', { ...same.get('jobs/job-visit-1'), membershipVisit: { status: 'pending', membershipId: 'sub_member_1' } });
  assert.deepEqual([(await applyMembershipVisit(same, crew, { jobId: 'job-visit-1' }, LATER)).reason, same.get('memberships/sub_member_1').visitsRemaining, visitEvents(same).length], ['already_counted', 4, 1]);
  // Funnel event errors map to their own status and code.
  for (const [code, status] of [['funnel_event_idempotency_conflict', 409], ['funnel_event_invalid', 400]]) {
    const failing = garageGuardMemberHandlers({ session: async () => manager, storage: () => ({ read: async () => { throw Object.assign(new Error('Synthetic funnel event failure. Nothing was saved.'), { code, status: 503 }); } }) });
    const result = await failing.post({ env: {}, request: new Request(`${origin}/api/garage-guard-members`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'visit.apply', requestId: uuid(), jobId: 'job-visit-1' }) }) });
    assert.equal(result.status, status); assert.equal((await result.json()).code, code);
  }
});

test('a browser save that only moves the next visit never blocks counting; visits a reconciled count covers are never applied on top of it', async () => {
  const store = await member(); completeVisit(store);
  const guard = store.get('jobs/job-root').garageGuard;
  // The dialog replaces the map (no membershipId, source hub_manual) but keeps the counts.
  store.put('jobs/job-root', { ...store.get('jobs/job-root'), garageGuard: { plan: guard.plan, status: guard.status, visitsIncluded: 4, visitsRemaining: 4, nextVisit: '2026-12-01', renewalDate: guard.renewalDate, updatedAt: NOW, updatedBy: 'alexk', source: 'hub_manual' } });
  const applied = await applyMembershipVisit(store, crew, { jobId: 'job-visit-1' }, LATER);
  const mirrored = store.get('jobs/job-root').garageGuard;
  assert.deepEqual([applied.status, applied.visitsRemaining, mirrored.source, mirrored.membershipId, mirrored.nextVisit, store.get('memberships/sub_member_1').manualEdit], ['applied', 3, 'stripe', 'sub_member_1', '2026-12-01', undefined]);
  // Review repro: the manager lowered the browser count for the October visit, reconciles to that true count, then the blocked visit is applied.
  const twice = await member(); completeVisit(twice); addVisit(twice, 'job-next', { membershipId: 'sub_member_1', date: '2027-01-05' });
  twice.put('jobs/job-root', { ...twice.get('jobs/job-root'), garageGuard: { ...twice.get('jobs/job-root').garageGuard, visitsRemaining: 3, source: 'hub_manual', updatedBy: 'alexk' } });
  assert.equal((await applyMembershipVisit(twice, crew, { jobId: 'job-visit-1' }, LATER)).reason, 'manual_edit_open');
  const reconcile = { action: 'visits.reconcile', requestId: uuid(), membershipId: 'sub_member_1', expectedRevision: twice.revisionOf('memberships/sub_member_1'), visitsRemaining: 3, note: 'The browser count already took the October visit.', jobIds: ['job-visit-1'] };
  for (const [jobIds, code] of [[['job-visit-1', 'job-visit-1'], 'garage_guard_reconcile_invalid'], [['bad id'], 'garage_guard_reconcile_invalid'], [Array.from({ length: 21 }, (_, index) => `job-${index}`), 'garage_guard_reconcile_invalid'], ['job-visit-1', 'garage_guard_reconcile_invalid'],
    [['job-other'], 'garage_guard_visit_not_member'], [['job-next'], 'garage_guard_visit_not_completed']]) {
    await assert.rejects(garageGuardAction(twice, manager, { ...reconcile, requestId: uuid(), jobIds }, LATER), { code }, String(jobIds));
  }
  const saved = await garageGuardAction(twice, manager, reconcile, LATER);
  assert.deepEqual([saved.status, saved.visitsRemaining, saved.coveredJobIds, saved.manualEditResolved], ['reconciled', 3, ['job-visit-1'], true]);
  const marker = twice.get('jobs/job-visit-1').membershipVisit, audit = twice.collection('hub_audit').at(-1);
  assert.deepEqual([marker.status, marker.reason, marker.reconciledBy, marker.requestId], ['reconciled', null, 'alexk', reconcile.requestId]);
  assert.deepEqual([twice.get('memberships/sub_member_1').periods[0].adjustments.at(-1).jobIds, JSON.parse(audit.after).coveredJobIds], [['job-visit-1'], ['job-visit-1']]);
  assert.ok(twice.commits.at(-1).includes('jobs/job-visit-1'), 'the covered visit is marked in the reconcile commit');
  const again = await garageGuardAction(twice, manager, { action: 'visit.apply', requestId: uuid(), jobId: 'job-visit-1' }, LATER, { visitsEnabled: true });
  const membership = twice.get('memberships/sub_member_1');
  assert.deepEqual([again.status, membership.visitsRemaining, membership.periods[0].recognizedCents, visitEvents(twice).length], ['reconciled', 3, 20000, 0], 'counted and recognized once');
  // Even if a browser edit drops the marker, the ledger remembers the reconcile.
  twice.put('jobs/job-visit-1', { ...twice.get('jobs/job-visit-1'), membershipVisit: { status: 'pending', membershipId: 'sub_member_1' } });
  assert.deepEqual([(await applyMembershipVisit(twice, crew, { jobId: 'job-visit-1' }, LATER)).status, twice.get('jobs/job-visit-1').membershipVisit.status, twice.get('memberships/sub_member_1').visitsRemaining], ['reconciled', 'reconciled', 3]);
  await assert.rejects(garageGuardAction(twice, manager, { ...reconcile, requestId: uuid(), expectedRevision: twice.revisionOf('memberships/sub_member_1') }, LATER), { code: 'garage_guard_visit_already_counted', status: 409 });
  const view = await garageGuardOverview(twice, manager, {}, new Date('2026-10-20T18:00:00.000Z'));
  assert.deepEqual([view.visits.find(visit => visit.jobId === 'job-visit-1').state, view.counts.reconciledVisits], ['reconciled', 1]);
});

test('a member recorded before the ledger takes only visits in its current Stripe year, by link or by apply', async () => {
  // Recorded by M2 before FUN-20: linked and mirrored, renewed two months ago with 4 visits, no billing period yet.
  const legacy = (store, extra = {}) => {
    store.put('memberships/sub_member_1', { subscriptionId: 'sub_member_1', plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 4, currentPeriodEnd: at(T0 + YEAR - 60 * 86400), createdAt: at(T0 - YEAR), statusEventCreated: T0 - 60 * 86400, livemode: true,
      link: { status: 'linked', customerId: 'cust-dana', accountJobId: 'job-root', mirroredAt: at(T0 - 60 * 86400) }, ...extra });
    store.put('jobs/job-root', { ...store.get('jobs/job-root'), garageGuard: { plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 4, membershipId: 'sub_member_1', source: 'stripe' } });
    return store;
  };
  const store = legacy(memoryStore());
  // Review repro (probe A): a visit completed 420 days ago, before this membership year, was linked and applied, and the member lost a paid visit.
  addVisit(store, 'job-old', { status: 'completed', pipelineStatus: 'completed', completedAt: at(T0 - 420 * 86400), date: '2025-07-29', visitPurpose: 'service' });
  await assert.rejects(garageGuardAction(store, manager, { action: 'visit.link', requestId: uuid(), jobId: 'job-old', membershipId: 'sub_member_1', expectedRevision: store.revisionOf('jobs/job-old') }, NOW), { code: 'garage_guard_visit_before_period', status: 409 });
  assert.equal(store.get('jobs/job-old').membershipId, undefined);
  addVisit(store, 'job-old-scheduled', { date: '2025-07-29', visitPurpose: 'service' });
  await assert.rejects(garageGuardAction(store, manager, { action: 'visit.link', requestId: uuid(), jobId: 'job-old-scheduled', membershipId: 'sub_member_1', expectedRevision: store.revisionOf('jobs/job-old-scheduled') }, NOW), { code: 'garage_guard_visit_before_period', status: 409 });
  // Carrying membershipId some other way, it is sent to a manager when applied, never counted.
  store.put('jobs/job-old', { ...store.get('jobs/job-old'), membershipId: 'sub_member_1', visitPurpose: 'member_visit' });
  const old = await garageGuardAction(store, manager, { action: 'visit.apply', requestId: uuid(), jobId: 'job-old' }, NOW, { visitsEnabled: true });
  assert.deepEqual([old.status, old.reason], ['needs_review', 'visit_before_period']);
  assert.deepEqual([store.get('memberships/sub_member_1').visitsRemaining, store.get('memberships/sub_member_1').unallocatedVisits, store.get('jobs/job-root').garageGuard.visitsRemaining, visitEvents(store).length], [4, undefined, 4, 0]);
  // A visit in its current year is linked and counted against the current count.
  addVisit(store, 'job-this-year', { status: 'completed', pipelineStatus: 'completed', completedAt: at(T0 - 30 * 86400), visitPurpose: 'service' });
  assert.equal((await garageGuardAction(store, manager, { action: 'visit.link', requestId: uuid(), jobId: 'job-this-year', membershipId: 'sub_member_1', expectedRevision: store.revisionOf('jobs/job-this-year') }, NOW)).status, 'linked');
  const counted = await garageGuardAction(store, manager, { action: 'visit.apply', requestId: uuid(), jobId: 'job-this-year' }, NOW, { visitsEnabled: true });
  assert.deepEqual([counted.status, counted.occurrence, counted.visitsRemaining, store.get('memberships/sub_member_1').unallocatedVisits.map(visit => visit.jobId), store.get('jobs/job-root').garageGuard.visitsRemaining], ['applied', 1, 3, ['job-this-year'], 3]);
  // One completed after its Stripe period ended waits for the renewal.
  addVisit(store, 'job-after-end', { membershipId: 'sub_member_1', status: 'completed', completedAt: at(T0 + YEAR - 59 * 86400) });
  assert.equal((await applyMembershipVisit(store, crew, { jobId: 'job-after-end', via: 'field' }, at(T0 + YEAR - 58 * 86400))).reason, 'awaiting_renewal');
  assert.equal(store.get('memberships/sub_member_1').visitsRemaining, 3);
  // With no period end on file, the later of when the Hub recorded it and its provisional start bounds the year.
  const bare = legacy(memoryStore(), { currentPeriodEnd: '', createdAt: at(T0 - 30 * 86400), provisionalStartedAt: at(T0 - 20 * 86400), preLedger: true });
  addVisit(bare, 'job-early', { membershipId: 'sub_member_1', status: 'completed', completedAt: at(T0 - 25 * 86400) });
  addVisit(bare, 'job-inside', { membershipId: 'sub_member_1', status: 'completed', completedAt: at(T0 - 10 * 86400) });
  assert.deepEqual([(await applyMembershipVisit(bare, owner, { jobId: 'job-early' }, NOW)).reason, (await applyMembershipVisit(bare, owner, { jobId: 'job-inside' }, NOW)).status, bare.get('memberships/sub_member_1').visitsRemaining], ['visit_before_period', 'applied', 3]);
});

test('a visit after the paid year ended waits for the renewal, then counts in the new year; the old year keeps its visits', async () => {
  // Review repro (probe F): the renewal failed, the crew completed a visit in dunning, and the paid retry reset the year: a fifth visit, charged to year one.
  const store = await member(undefined, { livemode: true });
  await webhookApply(store, invoiceEvent({ id: 'evt_guard_renew_fail', type: 'invoice.payment_failed', reason: 'subscription_cycle', created: T0 + YEAR + 60, invoice: 'in_guard_second', periodEnd: T0 + 2 * YEAR, paid: 0, livemode: true }), at(T0 + YEAR + 120));
  completeVisit(store, 'job-visit-1', at(T0 + YEAR + 5 * 86400));
  const waiting = await applyMembershipVisit(store, crew, { jobId: 'job-visit-1', via: 'field' }, at(T0 + YEAR + 5 * 86400 + 60));
  assert.deepEqual([waiting.status, waiting.reason, store.get('jobs/job-visit-1').membershipVisit.reason], ['needs_review', 'awaiting_renewal', 'awaiting_renewal']);
  assert.deepEqual([store.get('memberships/sub_member_1').visitsRemaining, store.get('memberships/sub_member_1').periods[0].visitsUsed, visitEvents(store).length], [4, 0, 0]);
  await webhookApply(store, invoiceEvent({ id: 'evt_guard_renew_ok', reason: 'subscription_cycle', created: T0 + YEAR + 10 * 86400, invoice: 'in_guard_second', periodEnd: T0 + 2 * YEAR, livemode: true }), at(T0 + YEAR + 10 * 86400 + 60));
  const renewed = store.get('memberships/sub_member_1');
  assert.deepEqual(renewed.periods.map(period => [period.status, period.periodStart, period.visitsUsed, period.recognizedCents, period.breakageCents]), [['closed', at(T0), 0, 0, 80000], ['open', at(T0 + YEAR), 0, 0, null]]);
  const applied = await garageGuardAction(store, manager, { action: 'visit.apply', requestId: uuid(), jobId: 'job-visit-1' }, at(T0 + YEAR + 10 * 86400 + 120), { visitsEnabled: true });
  assert.deepEqual([applied.status, applied.occurrence, applied.visitsRemaining, 'periodClosed' in applied], ['applied', 1, 3, false]);
  const after = store.get('memberships/sub_member_1');
  assert.deepEqual(after.periods.map(period => [period.visitsUsed, period.recognizedCents, period.breakageCents]), [[0, 0, 80000], [1, 20000, null]]);
  assert.deepEqual([store.get('jobs/job-root').garageGuard.visitsRemaining, store.get('jobs/job-visit-1').membershipVisit.periodId], [3, 'in_guard_second']);
});

test('the overview is complete only when every completed member visit is counted or settled, and keeps visit money off the job', async () => {
  const store = await member(undefined, { livemode: true }); completeVisit(store);
  await applyMembershipVisit(store, crew, { jobId: 'job-visit-1', via: 'field' }, LATER);
  const now = new Date('2026-10-20T18:00:00.000Z'), view = () => garageGuardOverview(store, owner, {}, now, { visitsEnabled: true });
  const clean = await view();
  assert.deepEqual([clean.coverage.complete, clean.coverage.unresolvedVisits, clean.coverage.reasons, clean.visits[0].allocatedCents], [true, 0, [], 20000]);
  assert.equal(JSON.stringify(store.get('jobs/job-visit-1')).includes('allocatedCents'), false);
  // A completed member visit the ledger has not counted means its counts are behind.
  addVisit(store, 'job-untracked', { membershipId: 'sub_member_1', status: 'completed', completedAt: DONE });
  const behind = await view();
  assert.deepEqual([behind.coverage.complete, behind.coverage.unresolvedVisits, behind.coverage.reasons], [false, 1, ['visitsUnresolved']]);
  // The manager settles it (the reconciled count already includes it) and the view is complete again.
  await garageGuardAction(store, manager, { action: 'visits.reconcile', requestId: uuid(), membershipId: 'sub_member_1', expectedRevision: store.revisionOf('memberships/sub_member_1'), visitsRemaining: 2, note: 'The October visit was done by the crew lead.', jobIds: ['job-untracked'] }, LATER);
  assert.deepEqual([(await view()).coverage.complete, (await view()).counts.reconciledVisits], [true, 1]);
});

test('the manager store lists one membership\'s member visits with an exact membershipId query (recordType included), never as a short list', async () => {
  const requests = [], documents = [];
  const doc = (id, fields) => ({ document: { name: `projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`, updateTime: `2026-09-22T00:00:00.00000${documents.length}Z`, fields } });
  documents.push(doc('job-a', { type: { stringValue: 'job' }, membershipId: { stringValue: 'sub_member_1' }, status: { stringValue: 'completed' }, completedAt: { stringValue: DONE }, membershipVisit: { mapValue: { fields: { status: { stringValue: 'pending' } } } } }));
  documents.push(doc('job-b', { type: { stringValue: 'job' }, membershipId: { stringValue: 'sub_member_1' }, recordType: { stringValue: 'schedule_operation' } }));
  let respond = () => new Response(JSON.stringify([...documents, { readTime: '2026-09-22T00:00:01Z' }]), { status: 200 });
  const store = garageGuardStorage({}, async (_env, url, options) => { requests.push([String(url), JSON.parse(options.body)]); return respond(); });
  const found = await store.membershipVisits('sub_member_1');
  const [[url, body]] = requests;
  assert.equal(url.endsWith('/documents:runQuery'), true);
  assert.deepEqual(body.structuredQuery.where, { fieldFilter: { field: { fieldPath: 'membershipId' }, op: 'EQUAL', value: { stringValue: 'sub_member_1' } } });
  assert.ok(body.structuredQuery.select.fields.some(field => field.fieldPath === 'recordType'), 'a server record is never mistaken for a member visit');
  assert.deepEqual([found.complete, found.rows.map(row => [row.id, row.recordType ?? null, row.membershipVisit?.status ?? null]), typeof found.rows[0].revision], [true, [['job-a', null, 'pending'], ['job-b', 'schedule_operation', null]], 'string']);
  assert.equal((await store.membershipVisits('sub_member_1', 1)).complete, false, 'one more row than the limit proves the list is short');
  respond = () => new Response('{}', { status: 500 });
  await assert.rejects(store.membershipVisits('sub_member_1'), { code: 'garage_guard_storage_unavailable', status: 503 });
  respond = () => new Response(JSON.stringify({ not: 'rows' }), { status: 200 });
  await assert.rejects(store.membershipVisits('sub_member_1'), { code: 'garage_guard_storage_incomplete', status: 503 });
});
