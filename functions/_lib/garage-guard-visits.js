import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields } from './firestore-job.js';
import { dispatchStorage } from './dispatch-storage.js';
import { denverToday, validDate } from './dispatch-time.js';
import { requireDispatcher } from './dispatch-service.js';
import { isHubOwner } from './hub-session.js';
import { auditWrite } from './hub-audit.js';
import { funnelEventWrite } from './funnel-events.js';
import { canonicalJson, funnelHubId, funnelVocabulary, hubEligibilityFields, sha256Hex, stripeEligibility } from './funnel-definitions.js';
import { funnelPeriod } from './funnel-calendar.js';
import { LEDGER_LIMITS, LIVE_MEMBERSHIP_STATUSES, VISIT_JOB_TYPES, afterPaidPeriod, cents, coveringPeriod, garageGuardDrift, garageGuardSummary, ledgerVisits, legacyMembershipYear, listedUnresolvedVisits, manualEditFlag, membershipDeferred, membershipVisitFloor, openPeriod, resolvePeriodVisits, settleBreakage, visitAllocation, visitCompleted, visitStage, withLiveManualEdit } from './garage-guard-ledger.js';

export { garageGuardVisitTrackingEnabled } from './garage-guard-ledger.js';

/**
 * FUN-20 Garage Guard member visits and the manager view.
 *
 * A member visit is a job carrying membershipId (booked with visitPurpose
 * member_visit, or linked here with visit.link). Completing it through the
 * field app records membershipVisit {status:'pending'} in the completion
 * commit; applyMembershipVisit then, in ONE commit, decrements
 * memberships/{id}.visitsRemaining, logs the visit in the open billing period
 * with its allocated revenue (garage-guard-ledger.js visitAllocation; kept
 * only there, since managers can read jobs), marks the visit job
 * membershipVisit.status 'applied' (so it is applied once), mirrors the count
 * onto the account job's garageGuard and writes membership.visit_used.
 * A visit belongs to the billing period it happened in: one completed before a
 * renewal (or a cancellation) but applied later is logged in that closed period,
 * turning its breakage back into visit revenue (and settling it, when the
 * period closed with that visit unresolved), and the current count is left
 * alone; one completed after the open period ended waits (awaiting_renewal)
 * until the renewal is paid, and one completed after a closed period's paid
 * year but before it closed (dunning before a cancellation) belongs to no paid
 * year (after_paid_period). visit.link also takes a cancelled membership's
 * completed visit when a closed period covers it, and a visit linked into a
 * closed period joins its unresolved visits (its breakage is unknown again
 * until the visit is counted or settled); every link writes the membership, so
 * a Stripe event closing a year meanwhile lists the visits again. A membership with no billing
 * period (recorded before this ledger) takes only visits in its current Stripe
 * year. A visit the ledger already holds is restored, never counted twice.
 * A visit the membership cannot take (not linked to this customer, before the
 * membership or its year on file, after the paid year, not active, no visits
 * left, or a manual browser edit of the counts not yet reconciled) is marked
 * needs_review and nothing is decremented; visits.reconcile can mark such
 * visits 'reconciled' with the true count so they are never applied on top of
 * it, settles a closed year's unresolved visits (dropping, unmarked, any that
 * are no longer a completed member visit of the membership), lists the visits
 * again for a year that closed without a list and, for a year it still cannot
 * list, records a manager's confirmation that none of its visits is waiting
 * (confirmEmptyPeriodIds). The automatic path runs only with GARAGE_GUARD_VISIT_TRACKING_ENABLED
 * (while it is off the ledger does not know a period's visits, so its
 * deferred revenue and breakage are unknown); managers apply, link and reconcile
 * through POST /api/garage-guard-members with a requestId receipt
 * (garage_guard_operations) and a hub_audit entry in the same commit.
 */

export const GARAGE_GUARD_OPERATIONS = 'garage_guard_operations';
export const GARAGE_GUARD_ACTIONS = Object.freeze(['visit.apply', 'visit.link', 'visits.reconcile']);
export const MEMBER_VISIT_LIMIT = 1000;
export const MEMBERSHIP_LIST_LIMIT = 2000;
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, SUBSCRIPTION = /^sub_[A-Za-z0-9_]{1,116}$/;
const JOB_TYPES = VISIT_JOB_TYPES;
const MIRRORED = new Set(['active', 'past_due', 'cancelled']);
const FIELDS = { 'visit.apply': ['jobId'], 'visit.link': ['jobId', 'membershipId', 'expectedRevision'], 'visits.reconcile': ['membershipId', 'expectedRevision', 'visitsRemaining', 'note', 'jobIds', 'confirmEmptyPeriodIds'] };
const MAX_COVERED = 20;
const VISIT_FIELDS = ['type', 'recordType', 'customerId', 'customer', 'date', 'time', 'status', 'pipelineStatus', 'completedAt', 'membershipId', 'visitPurpose', 'membershipVisit', 'projectId'];
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code: 'garage_guard_' + code, status });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => Array.isArray(value) ? value : [];
const text = (value, max = 200) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const count = value => Number.isInteger(value) && value >= 0 ? value : null;
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(_egc_|secure_)/.test(value);
const subscription = value => typeof value === 'string' && SUBSCRIPTION.test(value) ? value : '';
const stage = visitStage, completed = visitCompleted;
const earlier = (at, now) => Number.isFinite(Date.parse(at || '')) && Date.parse(at) < Date.parse(now) ? new Date(Date.parse(at)).toISOString() : now;
const hubRef = value => funnelHubId(value) ? value : undefined;
const person = actor => ({ id: String(actor?.user || actor?.id || '').trim().toLowerCase(), kind: 'human', role: actor?.role ? String(actor.role).toLowerCase() : null });
/** Membership money (amounts, allocations, deferred revenue) is owner-only, as the §7 Garage Guard metrics are. */
export const canSeeMembershipMoney = actor => isHubOwner(actor) && actor?.role === 'owner';

export function garageGuardStorage(env, fetcher = firestoreFetch) {
  const store = dispatchStorage(env, fetcher);
  async function send(url, options = {}) {
    try { return await fetcher(env, url, { ...options, signal: AbortSignal.timeout(20000) }); }
    catch { throw fail('storage_unavailable', 'Garage Guard records could not be loaded. Retry.', 503); }
  }
  const decode = (document, collection) => {
    const id = String(document?.name || '').split(`/documents/${collection}/`)[1] || '';
    if (!id || id.includes('/') || typeof document.updateTime !== 'string' || !document.updateTime) throw fail('storage_incomplete', 'A Garage Guard record had no verifiable identity. Retry.', 503);
    return { ...decodeFirestoreFields(document.fields || {}), id, revision: document.updateTime };
  };
  return {
    read: store.read, readMany: store.readMany, commit: store.commit,
    /** Up to `limit` documents; complete:false when more exist, never a silently short list. */
    async list(collection, limit = MEMBERSHIP_LIST_LIMIT) {
      const rows = [], ids = new Set(), tokens = new Set();
      let token = '';
      do {
        const url = new URL(`${BASE}/${collection}`);
        url.searchParams.set('pageSize', '300');
        if (token) url.searchParams.set('pageToken', token);
        const response = await send(url);
        if (!response.ok) throw fail('storage_unavailable', 'Garage Guard records could not be loaded. Retry.', 503);
        const page = await response.json().catch(() => null);
        if (!plain(page) || (page.documents !== undefined && !Array.isArray(page.documents)) || (page.nextPageToken !== undefined && typeof page.nextPageToken !== 'string')) throw fail('storage_incomplete', 'Garage Guard records returned an incomplete page. Retry.', 503);
        for (const document of page.documents || []) { const row = decode(document, collection); if (ids.has(row.id)) throw fail('storage_incomplete', 'Garage Guard records repeated a row. Retry.', 503); ids.add(row.id); rows.push(row); }
        token = page.nextPageToken || '';
        if (token && tokens.has(token)) throw fail('storage_incomplete', 'Garage Guard pagination did not finish. Retry.', 503);
        tokens.add(token);
        if (token && rows.length >= limit) return { rows, complete: false };
      } while (token);
      return { rows, complete: true };
    },
    /** Jobs that carry a membershipId (member visits), masked to the fields the view needs. */
    memberVisits(limit = MEMBER_VISIT_LIMIT) {
      return visitQuery({ unaryFilter: { op: 'IS_NOT_NULL', field: { fieldPath: 'membershipId' } } }, limit);
    },
    /** The member-visit jobs of one membership (visits.reconcile lists them again for a year that closed without a list). */
    membershipVisits(membershipId, limit = MEMBER_VISIT_LIMIT) {
      return visitQuery({ fieldFilter: { field: { fieldPath: 'membershipId' }, op: 'EQUAL', value: { stringValue: membershipId } } }, limit);
    },
  };
  /** Up to `limit` jobs matching `where`; complete:false when more exist, never a silently short list. */
  async function visitQuery(where, limit) {
    const response = await send(`${BASE}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'jobs' }], where, select: { fields: [...new Set([...VISIT_FIELDS, ...hubEligibilityFields()])].map(fieldPath => ({ fieldPath })) }, limit: limit + 1,
    } }) });
    if (!response.ok) throw fail('storage_unavailable', 'Member visits could not be loaded. Retry.', 503);
    const rows = await response.json().catch(() => null);
    if (!Array.isArray(rows)) throw fail('storage_incomplete', 'Member visits returned an incomplete response. Retry.', 503);
    const found = rows.filter(row => row?.document).map(row => decode(row.document, 'jobs'));
    return { rows: found.slice(0, limit), complete: found.length <= limit };
  }
}

/**
 * What one member visit needs now: {result, writes}. Pure over the reads;
 * the caller commits the writes (plus its receipt) and re-plans after a conflict.
 */
export async function planMembershipVisit(store, actor, jobId, via, now) {
  if (!safeId(jobId)) throw fail('visit_invalid', 'Choose a valid member visit.');
  const who = person(actor), job = await store.read('jobs', jobId);
  if (!job || job.recordType || !JOB_TYPES.has(job.type)) throw fail('visit_not_found', 'This visit is unavailable. Refresh the member visits.', 404);
  const membershipId = subscription(job.membershipId), saved = plain(job.membershipVisit) ? job.membershipVisit : {};
  if (!membershipId) return { result: { status: 'not_member_visit', jobId }, writes: [] };
  if (saved.status === 'reconciled') return { result: { status: 'reconciled', jobId, membershipId }, writes: [] };
  if (saved.status !== 'applied' && !completed(job)) return { result: { status: 'not_completed', jobId, membershipId }, writes: [] };
  const membership = await store.read('memberships', membershipId), link = plain(membership?.link) ? membership.link : {};
  // The ledger is the record of what was counted, and the only place a visit's revenue is kept (the job document is readable by managers).
  const counted = membership ? ledgerVisits(membership).get(job.id) : null;
  if (saved.status === 'applied') return { result: { status: 'duplicate', jobId, membershipId, occurrence: count(saved.occurrence), allocatedCents: counted?.kind === 'applied' ? cents(counted.entry.allocatedCents) : null }, writes: [] };
  // A visit the ledger holds (a job reopened and completed again) gets its marker back and is never counted twice.
  if (counted) {
    const entry = counted.entry, restored = counted.kind === 'applied'
      ? { status: 'applied', membershipId, occurrence: count(entry.occurrence), periodId: text(counted.period?.id, 200) || null, usedAt: text(entry.usedAt, 40) || null, appliedAt: text(entry.recordedAt, 40) || null, appliedBy: text(entry.by, 80) || null, via: text(entry.via, 20) || null, restoredAt: now, restoredBy: who.id }
      : { status: 'reconciled', membershipId, reconciledAt: text(entry.at, 40) || null, reconciledBy: text(entry.by, 80) || null, restoredAt: now, restoredBy: who.id };
    return { result: counted.kind === 'applied' ? { status: 'duplicate', jobId: job.id, membershipId, occurrence: restored.occurrence, allocatedCents: cents(entry.allocatedCents), restored: true } : { status: 'reconciled', jobId: job.id, membershipId, restored: true },
      writes: [{ collection: 'jobs', id: job.id, revision: job.revision, patch: { membershipVisit: restored } }, { collection: 'memberships', id: membershipId, revision: membership.revision, verify: true }] };
  }
  const usedAt = earlier(job.completedAt, now), used = Date.parse(usedAt), periods = structuredClone(list(membership?.periods)).filter(plain), open = openPeriod(periods);
  let reason = !membership ? 'membership_not_found' : link.status !== 'linked' ? 'membership_unlinked' : link.customerId !== job.customerId ? 'customer_mismatch' : '';
  // A visit belongs to the billing period it happened in, never to whichever one is open when it is applied.
  const period = reason ? null : coveringPeriod(periods, usedAt), late = period && period !== open ? period : null, live = LIVE_MEMBERSHIP_STATUSES.includes(membership?.status);
  if (!reason) {
    if (Number.isFinite(Date.parse(membership.startedAt || '')) && used < Date.parse(membership.startedAt)) reason = 'visit_before_membership';
    else if (late) reason = !Number.isInteger(late.visitsIncluded) || count(late.visitsUsed) === null ? 'visit_before_period' : late.visitsUsed >= late.visitsIncluded ? 'no_visits_remaining' : '';
    else if (open && !period) reason = 'visit_before_period';
    // After the open period ended and before its renewal is paid (dunning), the visit belongs to a year not yet paid for: it waits for the renewal.
    else if (open && Number.isFinite(Date.parse(open.periodEnd || '')) && used >= Date.parse(open.periodEnd)) reason = 'awaiting_renewal';
    // After a closed period's paid year ended and before it closed (dunning that ended in a cancellation): no paid year takes it.
    else if (!period && afterPaidPeriod(periods, usedAt)) reason = 'after_paid_period';
    else if (!open && live) {
      // No billing period (a member recorded before this ledger): only its current Stripe year can take the visit.
      const year = legacyMembershipYear(membership);
      reason = !year.start || used < Date.parse(year.start) ? 'visit_before_period' : year.end && used >= Date.parse(year.end) ? 'awaiting_renewal' : '';
    }
    if (!reason && !late) reason = !live ? 'membership_not_active' : !Number.isInteger(membership.visitsRemaining) ? 'visits_unknown' : membership.visitsRemaining < 1 ? 'no_visits_remaining' : '';
  }
  let account = null, drift = null;
  if (!reason && !late) {
    account = link.accountJobId === job.id ? job : safeId(link.accountJobId) ? await store.read('jobs', link.accountJobId) : null;
    if (!account?.revision || account.customerId !== link.customerId) reason = 'account_job_changed';
    // While the account's plan, status or visit counts differ from the membership (a browser edit), a manager reconciles them before any visit is counted.
    else if ((drift = garageGuardDrift(account.garageGuard, { ...membership, subscriptionId: membershipId }))) reason = 'manual_edit_open';
  }
  const review = why => {
    const writes = [];
    if (saved.status !== 'needs_review' || saved.reason !== why) writes.push({ collection: 'jobs', id: job.id, revision: job.revision, patch: { membershipVisit: { ...saved, status: 'needs_review', reason: why, membershipId, checkedAt: now, checkedBy: who.id, via } } });
    if (drift && membership.manualEdit?.status !== 'open') writes.push({ collection: 'memberships', id: membershipId, revision: membership.revision, patch: { manualEdit: manualEditFlag(membership.manualEdit, drift, now, `visit:${job.id}`), updatedAt: now } });
    return { result: { status: 'needs_review', reason: why, jobId: job.id, membershipId }, writes };
  };
  if (reason) return review(reason);
  const remaining = membership.visitsRemaining, included = membership.visitsIncluded, target = late || open;
  // The occurrence is the visit's place in its own period (a plan change or a reconcile can leave the membership counts on another basis);
  // a visit past the period's included visits is allocated no more than the period still holds.
  const occurrence = target ? (count(target.visitsUsed) ?? 0) + 1 : Number.isInteger(included) && included >= remaining ? included - remaining + 1 : null;
  const allocatedCents = target ? visitAllocation(target, Number.isInteger(target.visitsIncluded) ? Math.min(occurrence, target.visitsIncluded) : null) : null;
  const visit = { jobId: job.id, usedAt, recordedAt: now, occurrence, allocatedCents, via, by: who.id, ...(late ? { afterClose: true } : {}) };
  const patch = late ? { updatedAt: now } : { visitsRemaining: remaining - 1, lastVisitJobId: job.id, lastVisitAt: usedAt, updatedAt: now };
  if (target) {
    Object.assign(target, { visits: [...list(target.visits), visit].slice(-LEDGER_LIMITS.visits), visitsUsed: (count(target.visitsUsed) ?? 0) + 1 });
    if (allocatedCents !== null) target.recognizedCents = (cents(target.recognizedCents) ?? 0) + allocatedCents;
    // A late visit turns breakage its period booked at close back into visit revenue (still unknown when the period's breakage was); one the
    // period closed with unresolved is resolved by this count.
    if (late) { resolvePeriodVisits(target, [job.id]); settleBreakage(target); }
    patch.periods = periods;
  } else patch.unallocatedVisits = [...list(membership.unallocatedVisits), visit].slice(-LEDGER_LIMITS.visits);
  const plan = funnelVocabulary('garageGuardPlans').includes(membership.plan) ? membership.plan : undefined;
  let event = null;
  try {
    event = await funnelEventWrite(store, now, {
      type: 'membership.visit_used', idempotencyKey: { kind: 'derived', value: `garageGuardVisit:${job.id}` }, clockSource: 'system', occurredAt: usedAt,
      membershipId, jobId: job.id, customerId: hubRef(job.customerId), projectId: hubRef(job.projectId), actor: who, via, source: { collection: 'jobs', id: job.id },
      data: { occurrence: occurrence ?? undefined, amountCents: allocatedCents ?? undefined, plan }, eligibility: { hub: job, stripe: { livemode: membership.livemode, id: membershipId } },
    });
  } catch (error) { if (error.code !== 'funnel_event_idempotency_conflict') throw error; }
  // The event and the ledger entry are written together, so a visit_used event already on file for this job (identical or not) means it was counted in a way the ledger no longer shows: a manager decides.
  if (!event) return review('already_counted');
  // The job marker carries no money: managers can read jobs, and a visit's allocation reveals the price the member paid.
  const jobPatch = { membershipVisit: { status: 'applied', membershipId, occurrence, periodId: target?.id || null, ...(late ? { periodClosed: true } : {}), usedAt, appliedAt: now, appliedBy: who.id, via, eventId: event.id } };
  const writes = [{ collection: 'memberships', id: membershipId, revision: membership.revision, patch }, { collection: 'jobs', id: job.id, revision: job.revision, patch: jobPatch }];
  if (!late) {
    const guard = { ...(plain(account.garageGuard) ? account.garageGuard : {}), plan: membership.plan, status: membership.status, visitsIncluded: included, visitsRemaining: remaining - 1, membershipId, source: 'stripe', updatedAt: now, updatedBy: 'garage_guard_visit' };
    if (account.id === job.id) jobPatch.garageGuard = guard; else writes.push({ collection: 'jobs', id: account.id, revision: account.revision, patch: { garageGuard: guard, updatedAt: now } });
  }
  writes.push({ collection: event.collection, id: event.id, patch: event.patch });
  return {
    result: { status: 'applied', jobId: job.id, membershipId, occurrence, allocatedCents, visitsRemaining: late ? count(remaining) : remaining - 1, ...(late ? { periodId: late.id, periodClosed: true } : {}) },
    writes,
  };
}

/**
 * Applies one completed member visit exactly once (the field completion path).
 * A stale read retries from fresh reads, where an applied visit is a duplicate.
 */
export async function applyMembershipVisit(store, actor, input, now = new Date().toISOString()) {
  for (let attempt = 0; ; attempt++) {
    const { result, writes } = await planMembershipVisit(store, actor, input?.jobId, input?.via === 'field' ? 'field' : 'hub', now);
    if (!writes.length) return result;
    try { await store.commit(writes); return result; }
    catch (error) { if (['dispatch_revision_conflict', 'dispatch_outcome_unknown'].includes(error.code) && attempt < 2) continue; throw error; }
  }
}

async function planLink(store, who, input, now) {
  const job = await store.read('jobs', input.jobId);
  if (!job || job.recordType || !JOB_TYPES.has(job.type)) throw fail('visit_not_found', 'This visit is unavailable. Refresh the schedule.', 404);
  if (job.revision !== input.expectedRevision) throw fail('revision_conflict', 'This visit changed. Refresh and review it before linking.', 409);
  if (stage(job) === 'cancelled') throw fail('visit_cancelled', 'A cancelled visit cannot become a member visit.', 409);
  if (job.membershipVisit?.status === 'applied') throw fail('visit_already_applied', 'This visit was already counted against a membership.', 409);
  if (job.membershipId && job.membershipId !== input.membershipId) throw fail('visit_other_membership', 'This visit belongs to another membership.', 409);
  if (job.visitPurpose && !['service', 'member_visit'].includes(job.visitPurpose)) throw fail('visit_purpose_conflict', 'Only a service visit can become a member visit.', 409);
  const membership = await store.read('memberships', input.membershipId);
  if (!membership) throw fail('membership_not_found', 'This membership is not on file.', 404);
  if (membership.link?.status !== 'linked' || membership.link.customerId !== job.customerId) throw fail('membership_customer_mismatch', "This membership is not linked to this visit's customer.", 409);
  // A cancelled membership still takes a visit completed in a year it paid for (a closed period covers it), counted in that year.
  const periods = structuredClone(list(membership.periods)).filter(plain), paidYear = completed(job) ? coveringPeriod(periods, earlier(job.completedAt, now)) : null;
  if (!LIVE_MEMBERSHIP_STATUSES.includes(membership.status) && paidYear?.status !== 'closed') throw fail('membership_not_active', 'Only an active or past-due membership takes member visits; a cancelled one takes only a visit completed in a year it paid for.', 409);
  // A member visit falls on or after the membership's start; a member recorded before this ledger has no known start, so the earliest is its
  // oldest year on file (its current Stripe year, one year before currentPeriodEnd).
  const startedAt = Date.parse(membership.startedAt || ''), floor = Date.parse(membershipVisitFloor(membership) || '');
  const before = at => completed(job) ? Date.parse(job.completedAt) < at : validDate(job.date) && job.date < denverToday(new Date(at));
  if (Number.isFinite(startedAt) && before(startedAt)) throw fail('visit_before_membership', 'This visit was before the membership started, so it cannot be a member visit.', 409);
  if (Number.isFinite(floor) && before(floor)) throw fail('visit_before_period', 'This visit was before the membership year on file, so it cannot be a member visit.', 409);
  const result = { status: job.membershipId === input.membershipId && job.visitPurpose === 'member_visit' ? 'already_linked' : 'linked', jobId: job.id, membershipId: input.membershipId, completed: completed(job) };
  if (result.status === 'already_linked') return { result, writes: [] };
  const patch = { membershipId: input.membershipId, visitPurpose: 'member_visit', membershipLinkedAt: now, membershipLinkedBy: who.id };
  // The link writes the membership, never only verifies it: a Stripe event that closes a year meanwhile (having listed the member visits
  // before this link) then conflicts on the membership and lists them again. A visit completed in a year that already closed joins that
  // year's unresolved visits, so its breakage is unknown again until the visit is counted in it (visit.apply) or settled (visits.reconcile).
  const membershipPatch = { lastVisitLinkAt: now, lastVisitLinkJobId: job.id, updatedAt: now };
  if (paidYear?.status === 'closed' && paidYear.unresolvedVisitJobIds !== null && !ledgerVisits(membership).has(job.id)) {
    const ids = [...new Set([...list(paidYear.unresolvedVisitJobIds), job.id])].sort();
    paidYear.unresolvedVisitJobIds = ids.length > LEDGER_LIMITS.visits ? null : ids;
    settleBreakage(paidYear);
    Object.assign(membershipPatch, { periods });
    Object.assign(result, { periodId: text(paidYear.id, 200) || null, periodClosed: true });
  }
  return { result, writes: [{ collection: 'jobs', id: job.id, revision: job.revision, patch }, { collection: 'memberships', id: membership.id, revision: membership.revision, patch: membershipPatch }],
    audit: { action: 'garage_guard.visit_link', entity: { collection: 'jobs', id: job.id }, before: { membershipId: job.membershipId || null, visitPurpose: job.visitPurpose || null }, after: { membershipId: patch.membershipId, visitPurpose: patch.visitPurpose, ...(result.periodClosed ? { closedPeriodId: result.periodId } : {}) } } };
}

async function planReconcile(store, who, input, now) {
  const membership = await store.read('memberships', input.membershipId);
  if (!membership) throw fail('membership_not_found', 'This membership is not on file.', 404);
  if (membership.revision !== input.expectedRevision) throw fail('revision_conflict', 'This membership changed. Refresh and review it before saving.', 409);
  const included = membership.visitsIncluded, before = Number.isInteger(membership.visitsRemaining) ? membership.visitsRemaining : null, after = input.visitsRemaining;
  if (!Number.isInteger(after) || after < 0 || after > (Number.isInteger(included) ? included : 100)) throw fail('reconcile_invalid', `Visits remaining must be a whole number from 0 to ${Number.isInteger(included) ? included : 100}.`);
  const link = plain(membership.link) ? membership.link : {}, mirror = link.status === 'linked' && MIRRORED.has(membership.status);
  const account = mirror ? await store.read('jobs', link.accountJobId) : null;
  if (mirror && (!account?.revision || account.customerId !== link.customerId)) throw fail('account_job_changed', "The member's account job changed. Review the membership link first.", 409);
  const periods = structuredClone(list(membership.periods)), open = openPeriod(periods);
  // Member visits the reconciled count already includes are marked so they are never applied on top of it. A job a closed year is waiting
  // on (unresolved at its close, or linked into it later) can always be settled here, even once it is no longer a completed member visit of
  // this membership (cancelled as a duplicate, reopened, deleted, moved to another membership or counted elsewhere): it is then only dropped
  // from that year's list (droppedJobIds), never marked, so a later completion is still counted where it belongs.
  const awaited = new Set(periods.filter(period => plain(period) && period.status === 'closed').flatMap(period => list(period.unresolvedVisitJobIds)));
  const covered = [], dropped = [], counted = ledgerVisits(membership);
  for (const jobId of input.jobIds) {
    const job = account?.id === jobId ? account : await store.read('jobs', jobId), state = plain(job?.membershipVisit) ? job.membershipVisit.status : '';
    const ours = Boolean(job) && !job.recordType && JOB_TYPES.has(job.type) && job.membershipId === membership.id, uncounted = ours && !['applied', 'reconciled'].includes(state) && !counted.has(job.id);
    if (awaited.has(jobId) && !(uncounted && completed(job))) { dropped.push(jobId); continue; }
    if (!ours) throw fail('visit_not_member', 'Each visit this count covers must be a member visit of this membership.', 409);
    if (!uncounted) throw fail('visit_already_counted', 'A visit this count covers was already counted. Refresh the member visits.', 409);
    if (!completed(job)) throw fail('visit_not_completed', 'Only a completed visit can be covered by the reconciled count.', 409);
    covered.push(job);
  }
  const coveredIds = covered.map(job => job.id);
  let settled = false;
  // A closed year whose member visits could not be listed when it closed (unresolvedVisitJobIds null) lists them again now, so this reconcile
  // settles it; the listed jobs that could still land in it are fenced in this commit, as at the close.
  const fences = [], unlisted = periods.filter(period => plain(period) && period.status === 'closed' && period.unresolvedVisitJobIds === null);
  const confirming = input.confirmEmptyPeriodIds || [];
  for (const periodId of confirming) if (!unlisted.some(period => period.id === periodId)) throw fail('period_not_unlisted', 'Only a closed year whose member visits could not be listed can be confirmed as having none waiting. Refresh the membership.', 409);
  if (unlisted.length && typeof store.membershipVisits === 'function') {
    let found = null;
    // A listing that still fails does not block a manager who confirms the years it leaves unknown.
    try { found = await store.membershipVisits(membership.id); } catch (error) { if (!confirming.length) throw error; }
    for (const period of unlisted) {
      const listed = listedUnresolvedVisits(found, membership, period, now);
      if (listed.ids === null) continue;
      Object.assign(period, { unresolvedVisitJobIds: listed.ids, visitsListedAt: now });
      fences.push(...listed.fences);
      settleBreakage(period); settled = true;
    }
  }
  // A year still unlisted (the listing failed, or more than a year can list are waiting) is settled only by the manager's confirmation that
  // no member visit of it is waiting: an empty list, kept with who confirmed it and the note (the reconcile's, also in the audit entry).
  const confirmed = [];
  for (const period of unlisted) if (confirming.includes(period.id) && period.unresolvedVisitJobIds === null) {
    Object.assign(period, { unresolvedVisitJobIds: [], visitsConfirmedEmpty: { at: now, by: who.id, requestId: input.requestId, note: input.note } });
    settleBreakage(period); settled = true; confirmed.push(period.id);
  }
  // A visit a closed period was waiting on is settled by this reconcile: that year did not count it.
  for (const period of periods) if (period?.status === 'closed' && resolvePeriodVisits(period, input.jobIds)) { settleBreakage(period); settled = true; }
  // A restored count reverses no revenue; an unknown earlier count recognizes nothing it cannot prove.
  const adjustment = { at: now, by: who.id, from: before, to: after, recognizedCents: before !== null && after >= before ? 0 : null, note: input.note, jobIds: coveredIds, ...(dropped.length ? { droppedJobIds: dropped } : {}), ...(confirmed.length ? { confirmedEmptyPeriodIds: confirmed } : {}) };
  // The open period's own count moves by the change (its visitsIncluded, not the membership's, which a plan change can replace).
  const periodIncluded = Number.isInteger(open?.visitsIncluded) ? open.visitsIncluded : null, periodUsed = count(open?.visitsUsed);
  if (open && before !== null && after < before && periodUsed !== null) {
    // Visits used outside the Hub are recognized now, at the same per-visit allocation, as the next visits of the period.
    let recognized = 0;
    for (let next = periodUsed + 1; next <= periodUsed + before - after && recognized !== null; next++) {
      const value = visitAllocation({ ...open, recognizedCents: (cents(open.recognizedCents) ?? 0) + recognized }, periodIncluded === null ? null : Math.min(next, periodIncluded));
      recognized = value === null ? null : recognized + value;
    }
    adjustment.recognizedCents = recognized;
    if (recognized !== null) open.recognizedCents = (cents(open.recognizedCents) ?? 0) + recognized;
  }
  const patch = { visitsRemaining: after, updatedAt: now };
  if (open) {
    const moved = before !== null && periodUsed !== null ? periodUsed + before - after : periodIncluded !== null ? periodIncluded - after : null;
    Object.assign(open, { adjustments: [...list(open.adjustments), adjustment].slice(-LEDGER_LIMITS.adjustments), ...(moved !== null ? { visitsUsed: Math.max(0, periodIncluded === null ? moved : Math.min(periodIncluded, moved)) } : {}) });
    patch.periods = periods;
  }
  else {
    patch.visitAdjustments = [...list(membership.visitAdjustments), adjustment].slice(-LEDGER_LIMITS.adjustments);
    if (settled) patch.periods = periods;
  }
  if (membership.manualEdit?.status === 'open') patch.manualEdit = { ...membership.manualEdit, status: 'resolved', resolvedAt: now, resolvedBy: who.id, resolution: input.note };
  const writes = [{ collection: 'memberships', id: membership.id, revision: membership.revision, patch }];
  if (mirror) {
    patch.link = { ...link, mirroredAt: now };
    const garageGuard = { ...(plain(account.garageGuard) ? account.garageGuard : {}), plan: membership.plan, status: membership.status, visitsIncluded: included, visitsRemaining: after, membershipId: membership.id, source: 'stripe', updatedAt: now, updatedBy: 'garage_guard_reconcile' };
    writes.push({ collection: 'jobs', id: account.id, revision: account.revision, patch: { garageGuard, updatedAt: now } });
  }
  for (const job of covered) {
    const marked = { membershipVisit: { ...(plain(job.membershipVisit) ? job.membershipVisit : {}), status: 'reconciled', reason: null, membershipId: membership.id, reconciledAt: now, reconciledBy: who.id, requestId: input.requestId } };
    const existing = writes.find(write => write.collection === 'jobs' && write.id === job.id);
    if (existing) Object.assign(existing.patch, marked); else writes.push({ collection: 'jobs', id: job.id, revision: job.revision, patch: marked });
  }
  // A listed job this commit already writes at its read revision is fenced by that write.
  const targets = new Set(writes.map(write => `${write.collection}/${write.id}`));
  for (const fence of fences) if (!targets.has(`jobs/${fence.id}`)) { targets.add(`jobs/${fence.id}`); writes.push(fence); }
  const settledResult = { ...(dropped.length ? { droppedJobIds: dropped } : {}), ...(confirmed.length ? { confirmedEmptyPeriodIds: confirmed } : {}) };
  return { result: { status: 'reconciled', membershipId: membership.id, visitsRemaining: after, previousVisitsRemaining: before, mirrored: mirror, recognizedCents: adjustment.recognizedCents, manualEditResolved: Boolean(patch.manualEdit), coveredJobIds: coveredIds, ...settledResult }, writes,
    audit: { action: 'garage_guard.visits_reconcile', entity: { collection: 'memberships', id: membership.id }, before: { visitsRemaining: before, manualEdit: membership.manualEdit?.status || null }, after: { visitsRemaining: after, manualEdit: patch.manualEdit?.status || membership.manualEdit?.status || null, coveredJobIds: coveredIds, ...settledResult }, reason: input.note } };
}

function actionInput(input) {
  if (!plain(input) || !GARAGE_GUARD_ACTIONS.includes(input.action)) throw fail('action_invalid', 'Choose a supported Garage Guard action.');
  const allowed = new Set(['action', 'requestId', 'actorId', ...FIELDS[input.action]]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw fail('action_invalid', `The Garage Guard action does not take ${key}.`);
  if (typeof input.requestId !== 'string' || !UUID.test(input.requestId)) throw fail('request_id_invalid', 'A unique request ID is required. Keep it and retry the same request.');
  const clean = { action: input.action, requestId: input.requestId.toLowerCase() };
  if (FIELDS[input.action].includes('jobId')) { if (!safeId(input.jobId)) throw fail('visit_invalid', 'Choose a valid visit.'); clean.jobId = input.jobId; }
  if (FIELDS[input.action].includes('membershipId')) { if (!subscription(input.membershipId)) throw fail('membership_invalid', 'Choose a valid membership.'); clean.membershipId = input.membershipId; }
  if (FIELDS[input.action].includes('expectedRevision')) { if (typeof input.expectedRevision !== 'string' || !input.expectedRevision || input.expectedRevision.length > 80) throw fail('revision_required', 'Refresh and send the current revision.'); clean.expectedRevision = input.expectedRevision; }
  if (input.action === 'visits.reconcile') {
    const note = typeof input.note === 'string' ? input.note.trim() : '';
    if (note.length < 10 || note.length > 500) throw fail('reconcile_invalid', 'Explain the correct visit count in 10–500 characters.');
    const jobIds = input.jobIds === undefined ? [] : input.jobIds;
    if (!Array.isArray(jobIds) || jobIds.length > MAX_COVERED || !jobIds.every(safeId) || new Set(jobIds).size !== jobIds.length) throw fail('reconcile_invalid', `List at most ${MAX_COVERED} different member visits this count covers.`);
    Object.assign(clean, { visitsRemaining: input.visitsRemaining, note, jobIds: [...jobIds] });
    // Closed years whose member visits could not be listed, that the manager confirms have none waiting (kept out of the request
    // fingerprint when absent, so a request saved without it replays unchanged).
    if (input.confirmEmptyPeriodIds !== undefined) {
      const periodIds = input.confirmEmptyPeriodIds;
      if (!Array.isArray(periodIds) || !periodIds.length || periodIds.length > LEDGER_LIMITS.periods || !periodIds.every(id => typeof id === 'string' && id.length <= 200 && text(id, 200) === id && id !== '') || new Set(periodIds).size !== periodIds.length) throw fail('reconcile_invalid', `Confirm from 1 to ${LEDGER_LIMITS.periods} different closed years by their period id.`);
      clean.confirmEmptyPeriodIds = [...periodIds];
    }
  }
  return clean;
}

const project = (result, money) => money ? result : Object.fromEntries(Object.entries(result).filter(([key]) => !['allocatedCents', 'recognizedCents'].includes(key)));

/**
 * One manager action with a requestId receipt (sha256 of {actor, input}) and a
 * hub_audit entry in the commit that changes the membership or visit. The same
 * requestId with the same body returns the saved result (replayed:true); with a
 * different body it is 409 garage_guard_idempotency_conflict.
 */
export async function garageGuardAction(store, actor, raw, now = new Date().toISOString(), { visitsEnabled = false } = {}) {
  requireDispatcher(actor);
  const input = actionInput(raw), who = person(actor), money = canSeeMembershipMoney(actor);
  if (raw.actorId !== undefined && String(raw.actorId).trim().toLowerCase() !== who.id) throw fail('actor_changed', 'The signed-in account changed. Sign in again before retrying.', 401);
  const fingerprint = sha256Hex(canonicalJson({ actor: who.id, input })), replay = saved => {
    if (saved.fingerprint !== fingerprint) throw fail('idempotency_conflict', 'This request ID was already used for a different change.', 409);
    return project({ ...saved.result, replayed: true }, money);
  };
  for (let attempt = 0; ; attempt++) {
    const saved = await store.read(GARAGE_GUARD_OPERATIONS, input.requestId);
    if (saved) return replay(saved);
    if (input.action === 'visit.apply' && !visitsEnabled) throw fail('visits_disabled', 'Member visit tracking is off (GARAGE_GUARD_VISIT_TRACKING_ENABLED).', 503);
    const plan = input.action === 'visit.apply' ? await planMembershipVisit(store, actor, input.jobId, 'hub', now) : input.action === 'visit.link' ? await planLink(store, who, input, now) : await planReconcile(store, who, input, now);
    const result = { ok: true, authority: 'employee_hub', action: input.action, requestId: input.requestId, ...plan.result, replayed: false };
    const audit = plan.audit || (plan.writes.length ? { action: 'garage_guard.visit_apply', entity: { collection: 'jobs', id: input.jobId }, before: null, after: { status: plan.result.status, reason: plan.result.reason || null, occurrence: plan.result.occurrence ?? null } } : null);
    const writes = [...plan.writes, ...(audit ? [auditWrite({ actor: who, via: 'hub', ...audit, requestId: input.requestId, now })] : []).map(({ collection, id, patch }) => ({ collection, id, patch })),
      { collection: GARAGE_GUARD_OPERATIONS, id: input.requestId, patch: { requestId: input.requestId, action: input.action, actorId: who.id, fingerprint, result, createdAt: now } }];
    try { await store.commit(writes); return project(result, money); }
    catch (error) {
      if (!['dispatch_revision_conflict', 'dispatch_outcome_unknown'].includes(error.code)) throw error;
      // The commit is atomic: the receipt tells a landed save from a lost one.
      const landed = await store.read(GARAGE_GUARD_OPERATIONS, input.requestId).catch(() => null);
      if (landed) return replay(landed);
      // No receipt means nothing landed; a visit is re-planned from fresh reads (an applied one is then a duplicate).
      if (input.action === 'visit.apply' && attempt < 2) continue;
      if (error.code === 'dispatch_revision_conflict') throw fail('revision_conflict', 'This membership or visit changed. Refresh and review it before retrying.', 409);
      throw fail('outcome_unknown', 'The save could not be confirmed. Retry the same request to check its result.', 503);
    }
  }
}

function membershipView(row, account, money) {
  // A browser count the account shows now leaves the deferred revenue unknown, as the A8 summary reads it.
  const link = plain(row.link) ? row.link : {}, open = openPeriod(row.periods), deferred = membershipDeferred(withLiveManualEdit(row, account));
  const drift = link.status === 'linked' ? garageGuardDrift(account?.garageGuard, { ...row, subscriptionId: row.subscriptionId || row.id }) : null;
  const flag = row.manualEdit?.status === 'open' ? row.manualEdit : drift ? { status: 'open', firstDetectedAt: null, detectedAt: null, ...drift } : null;
  return {
    subscriptionId: text(row.subscriptionId, 200) || row.id, revision: row.revision, plan: text(row.plan, 20), status: text(row.status, 20), customerName: text(row.customerName, 200),
    testMode: !stripeEligibility({ livemode: row.livemode, id: row.subscriptionId || row.id }).eligible,
    link: text(link.status, 20) || 'unlinked', linkReason: text(link.reason, 60) || null, customerId: text(link.customerId, 180) || null, accountJobId: text(link.accountJobId, 180) || null,
    accountJobMissing: link.status === 'linked' && !account,
    visitsIncluded: count(row.visitsIncluded), visitsRemaining: count(row.visitsRemaining), currentPeriodEnd: text(row.currentPeriodEnd, 40) || null,
    startedAt: text(row.startedAt, 40) || null, provisionalStartedAt: text(row.provisionalStartedAt, 40) || null, preLedger: row.preLedger === true, cancelledAt: text(row.cancelledAt, 40) || null, renewalCount: count(row.renewalCount) ?? 0, paymentFailureCount: count(row.paymentFailureCount) ?? 0, lastPaymentFailedAt: text(row.lastPaymentFailedAt, 40) || null,
    churn: plain(row.churn) ? { class: row.churn.class || null, source: text(row.churn.source, 40), reason: row.churn.reason || null, at: text(row.churn.at, 40) || null } : null,
    manualEdit: flag ? { status: 'open', fields: list(flag.fields), rewritten: flag.rewritten === true, observed: flag.observed || null, expected: flag.expected || null, firstDetectedAt: flag.firstDetectedAt || null, detectedAt: flag.detectedAt || null, stored: row.manualEdit?.status === 'open' } : null,
    ledgerError: plain(row.ledgerError) ? { eventId: text(row.ledgerError.eventId, 200), at: text(row.ledgerError.at, 40), code: text(row.ledgerError.code, 80) } : null,
    openPeriod: open ? { id: text(open.id, 200), periodStart: open.periodStart || null, periodEnd: open.periodEnd || null, visitsIncluded: count(open.visitsIncluded), visitsUsed: count(open.visitsUsed) ?? 0, visitsTracked: open.visitsTracked === true, ...(money ? { paidCents: cents(open.paidCents), recognizedCents: cents(open.recognizedCents) } : {}) } : null,
    // Closed years whose breakage waits on member visits: count each in its year (visit.apply) or settle it (visits.reconcile jobIds);
    // jobIds null means the visits were never listed, and any visits.reconcile lists them again.
    unresolvedPeriods: list(row.periods).filter(period => plain(period) && period.status === 'closed' && period.breakageUnknown === 'visits_unresolved')
      .map(period => ({ periodId: text(period.id, 200), closedAt: text(period.closedAt, 40) || null, jobIds: Array.isArray(period.unresolvedVisitJobIds) ? period.unresolvedVisitJobIds.map(id => text(id, 180)) : null, unlisted: plain(period.visitsUnlisted) })),
    ...(money ? { amountPaidCents: cents(row.amountPaidCents), amountTotalCents: cents(row.amountTotalCents), discountCents: cents(row.discountCents), promotionCodes: list(row.promotionCodes).map(value => text(value, 120)).filter(Boolean), couponIds: list(row.couponIds).map(value => text(value, 120)).filter(Boolean), currency: text(row.currency, 3) || null,
      // Lifetime paid is every payment only when complete: a member recorded before FUN-20 (preLedger) paid earlier years the ledger never saw.
      lifetimePaidCents: cents(row.lifetimePaidCents), lifetimePaidComplete: row.lifetimePaidComplete === true && row.preLedger !== true, deferredCents: deferred.cents } : {}),
  };
}

function memberVisitView(job, money, allocations) {
  if (!safeId(job.id) || job.recordType || !JOB_TYPES.has(job.type) || !subscription(job.membershipId)) return null;
  const saved = plain(job.membershipVisit) ? job.membershipVisit : {}, done = completed(job), current = stage(job);
  const state = saved.status === 'applied' ? 'applied' : saved.status === 'reconciled' ? 'reconciled' : saved.status === 'needs_review' ? 'needs_review' : current === 'cancelled' ? 'cancelled' : done ? (saved.status === 'pending' ? 'pending' : 'not_recorded') : 'scheduled';
  return { jobId: job.id, revision: job.revision, customer: text(job.customer, 200), customerId: text(job.customerId, 180) || null, date: text(job.date, 10), status: current, completedAt: text(job.completedAt, 40) || null,
    membershipId: job.membershipId, visitPurpose: text(job.visitPurpose, 40) || null, state, reason: text(saved.reason, 60) || null, occurrence: count(saved.occurrence), appliedAt: text(saved.appliedAt, 40) || null,
    // A visit's revenue lives only in the server-only membership ledger.
    ...(money ? { allocatedCents: allocations.get(`${job.membershipId}/${job.id}`) ?? null } : {}) };
}

/** GET view for owners and managers: members, member visits and the A8 summary for a Denver period. */
export async function garageGuardOverview(store, actor, query = {}, now = new Date(), { visitsEnabled = false } = {}) {
  requireDispatcher(actor);
  const money = canSeeMembershipMoney(actor), asOf = now.toISOString();
  if (query.period !== 'custom' && (query.from !== undefined || query.to !== undefined)) throw fail('invalid_query', 'from and to are only for period=custom.');
  const period = funnelPeriod(query.period || 'mtd', now, query.period === 'custom' ? { from: query.from, to: query.to } : {});
  const [memberships, visits] = await Promise.all([store.list('memberships'), store.memberVisits()]);
  const accountIds = [...new Set(memberships.rows.filter(row => row.link?.status === 'linked' && safeId(row.link.accountJobId)).map(row => row.link.accountJobId))], accounts = new Map();
  // An account job read failure fails the view (503); it is never shown as "no manual edit".
  for (let index = 0; index < accountIds.length; index += 100) for (const job of await store.readMany('jobs', accountIds.slice(index, index + 100))) accounts.set(job.id, job);
  // The summary reads the account jobs too: a browser count no Stripe event or visit has flagged yet makes the open year's totals unknown.
  const summary = garageGuardSummary(memberships.rows, { startAt: period.startAt, endAt: period.elapsedThrough, asOf, accounts });
  const rows = memberships.rows.map(row => membershipView(row, accounts.get(row.link?.accountJobId), money)).sort((a, b) => a.status.localeCompare(b.status) || a.customerName.localeCompare(b.customerName) || a.subscriptionId.localeCompare(b.subscriptionId));
  const allocations = new Map();
  if (money) for (const row of memberships.rows) for (const [jobId, found] of ledgerVisits(row)) if (found.kind === 'applied') allocations.set(`${row.subscriptionId || row.id}/${jobId}`, cents(found.entry.allocatedCents));
  const memberVisits = visits.rows.map(job => memberVisitView(job, money, allocations)).filter(Boolean).sort((a, b) => String(b.completedAt || b.date).localeCompare(String(a.completedAt || a.date)) || a.jobId.localeCompare(b.jobId));
  const tally = state => memberVisits.filter(visit => visit.state === state).length;
  // Completed member visits not yet counted or settled mean the ledger's visit counts (utilization, deferred revenue) are behind.
  const testMode = new Set(rows.filter(row => row.testMode).map(row => row.subscriptionId));
  const unresolved = memberVisits.filter(visit => ['pending', 'not_recorded', 'needs_review'].includes(visit.state) && !testMode.has(visit.membershipId)).length;
  // A live-mode member with a manual edit open (stored, or an account job that differs from it now) means the ledger may have missed visits.
  const manualEdits = rows.filter(row => row.manualEdit && !row.testMode).length;
  if (!money) summary.revenue = null;
  return {
    ok: true, authority: 'employee_hub', viewer: { money }, visitTrackingEnabled: visitsEnabled === true,
    period: { period: period.period, from: period.from, to: period.to, startAt: period.startAt, elapsedThrough: period.elapsedThrough, inProgress: period.inProgress, timeZone: period.timeZone },
    summary, memberships: rows, visits: memberVisits,
    counts: { memberships: rows.length, manualEdits: rows.filter(row => row.manualEdit).length, pendingVisits: tally('pending'), unrecordedVisits: tally('not_recorded'), visitsNeedingReview: tally('needs_review'), appliedVisits: tally('applied'), reconciledVisits: tally('reconciled') },
    coverage: { complete: memberships.complete && visits.complete && summary.coverage.complete && !manualEdits && !unresolved, membershipsComplete: memberships.complete, visitsComplete: visits.complete, manualEdits, unresolvedVisits: unresolved,
      reasons: [...new Set([...summary.coverage.reasons, ...(manualEdits ? ['manualEdits'] : []), ...(unresolved ? ['visitsUnresolved'] : [])])], asOf },
  };
}
