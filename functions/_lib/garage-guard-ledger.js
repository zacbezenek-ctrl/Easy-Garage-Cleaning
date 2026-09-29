import { funnelEventWrite } from './funnel-events.js';
import { funnelHubId, funnelVocabulary, stripeEligibility } from './funnel-definitions.js';

/**
 * FUN-20 Garage Guard money ledger (pure; every function takes its clock).
 *
 * The signed Stripe webhook records a membership with applyGarageGuardEvent
 * (garage-guard-membership.js) over a store wrapped by garageGuardLedgerStore,
 * which adds to that SAME commit:
 *  - the Stripe amounts on stripe_events/{eventId}.amounts and on the
 *    membership (amountPaidCents, amountTotalCents, discountCents,
 *    promotionCodes, couponIds, currency, checkout, invoices[], lifetimePaidCents);
 *  - the billing-period ledger periods[]: a paid period (paidCents,
 *    visitsIncluded, visitsUsed, recognizedCents, visits[]) opens at the first
 *    payment and at each subscription_cycle renewal, and closes on renewal or
 *    cancellation with breakageCents = paid - recognized (owner decision 11:
 *    each member visit recognizes paid / included, the last one the remainder);
 *  - churn {class voluntary|involuntary} at cancellation, renewal and
 *    payment-failure counters, and a manualEdit flag when the account job's
 *    garageGuard still differs from the membership after this commit (a
 *    browser edit the mirror did not replace);
 *  - the funnel events membership.started / renewed / payment_failed / cancelled.
 * A period's recognized revenue is known only while the ledger itself counted
 * its visits: visitsTracked says GARAGE_GUARD_VISIT_TRACKING_ENABLED was on,
 * and the membership was linked to a Hub customer (the Hub counts no visit of
 * an unlinked member), at every Stripe event of the period (sampled when it
 * opens, at each event and when it closes). Otherwise, or when the account's
 * counts differed from the ledger's at close (a browser count), a completed
 * member visit of the period was still uncounted at close
 * (unresolvedVisitJobIds: pending, not recorded or needing review), a visit's
 * revenue was unknown (as for every visit after a mid-period plan change), or
 * the cancellation is a payment dispute, its breakage
 * (and, while open, its deferred revenue) is unknown: null, with the reason in
 * breakageUnknown, and left out of the renewed/cancelled event.
 * A membership recorded before this ledger is marked preLedger at its first
 * ledger write (it never 'starts'; provisionalStartedAt bounds when it was
 * live), and its pre-ledger year closes as a stub period with unknown amounts.
 * Unknown amounts stay null, never 0. A ledger failure never blocks recording
 * the membership: the event is saved without it and ledgerError says why (a
 * failure listing the member visits at a close is retried by Stripe for
 * VISIT_LIST_RETRY_MS, then recorded with that year's unresolved visits unknown).
 * The A8 summary reads a ledger that fell out of step with Stripe that way
 * (ledgerStaleFrom) as unknown from then on.
 */

export const GARAGE_GUARD_LEDGER_VERSION = 1;
export const LEDGER_LIMITS = Object.freeze({ periods: 40, invoices: 60, visits: 60, adjustments: 20, codes: 10, fences: 100 });
/** Why a period's breakage is unknown for good (set at close); the other reasons are recomputed from the period. */
const STICKY_GAPS = new Set(['manual_edit', 'payment_disputed']);
const COUNT_FIELDS = ['visitsRemaining', 'visitsIncluded'];

/** Member visits are counted by the ledger only when this is exactly "true" (the webhook samples it for each billing period). */
export function garageGuardVisitTrackingEnabled(env = {}) {
  return String(env.GARAGE_GUARD_VISIT_TRACKING_ENABLED || '').trim() === 'true';
}
export const LIVE_MEMBERSHIP_STATUSES = Object.freeze(['active', 'past_due']);
const MAX_CENTS = 100000000, DAY = 86400000, MONTH_DAYS = 365.25 / 12;
const STRIPE_EVENT_ID = /^evt_[A-Za-z0-9_]{6,120}$/, PROVIDER_ID = /^[A-Za-z0-9_-]{1,120}$/, CODE = /^[A-Za-z0-9_-]{1,120}$/;
const CANCELLATION_REASONS = new Set(['cancellation_requested', 'payment_failed', 'payment_disputed']);
const FEEDBACK = new Set(['customer_service', 'low_quality', 'missing_features', 'other', 'switched_service', 'too_complex', 'too_expensive', 'unused']);
const CYCLE_REASONS = ['subscription_create', 'subscription_cycle'];
const STRIPE_ACTOR = Object.freeze({ id: 'stripe_webhook', kind: 'integration', role: null });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => Array.isArray(value) ? value : [];
const text = (value, max = 200) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
export const cents = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_CENTS ? value : null;
const count = value => Number.isInteger(value) && value >= 0 ? value : null;
const iso = seconds => Number.isInteger(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
const ms = value => typeof value === 'string' && value ? Date.parse(value) : NaN;
const code = value => { const id = plain(value) ? value.id : value; return typeof id === 'string' && CODE.test(id) ? id : ''; };
const prefixed = (value, prefix) => { const id = code(value); return id.startsWith(prefix) ? id : null; };
const unique = values => [...new Set(values.filter(Boolean))].slice(0, LEDGER_LIMITS.codes);
const total = values => values.reduce((sum, value) => sum + value, 0);
const earlier = (at, now) => Number.isFinite(ms(at)) && ms(at) < ms(now) ? new Date(ms(at)).toISOString() : now;
// Every Garage Guard plan bills yearly (garage-guard-checkout.js): a year before a Stripe period end, on the same calendar day.
const yearBefore = at => { const date = new Date(ms(at)); date.setUTCFullYear(date.getUTCFullYear() - 1); return date.toISOString(); };
const instantOf = value => Number.isFinite(ms(value)) ? new Date(ms(value)).toISOString() : null;
// A subscription line bills the plan; an invoice item swept into the same invoice (even one attached to the subscription) has its own period.
const subscriptionLine = line => line.type === 'subscription' || line.parent?.type === 'subscription_item_details';
const prorationLine = line => line.proration === true || line.parent?.subscription_item_details?.proration === true;

/** Job types a member visit can be, and when one counts as completed (shared with garage-guard-visits.js). */
export const VISIT_JOB_TYPES = new Set(['job', 'cleanout', 'reorg']);
const DONE_STAGES = new Set(['completed', 'invoiced', 'paid', 'review_requested']);
// A cancelled or no-show job is not a visit that happened (the same spellings dispatch treats as closed).
const OFF_STAGES = new Set(['cancelled', 'canceled', 'no_show', 'noshow', 'no-show']);
export const visitStage = job => text(job?.pipelineStatus || job?.status, 40).toLowerCase();
export const visitCompleted = job => DONE_STAGES.has(visitStage(job)) && Number.isFinite(ms(job?.completedAt || ''));

/** The Stripe amounts, discounts and cancellation details of a verified event (null when Stripe did not say). */
export function garageGuardBilling(event) {
  const object = plain(event?.data?.object) ? event.data.object : {}, type = typeof event?.type === 'string' ? event.type : '';
  const discounts = [...list(object.discounts), ...(plain(object.discount) ? [object.discount] : [])].filter(plain);
  const billing = {
    sessionId: null, invoiceId: null, currency: typeof object.currency === 'string' && /^[a-z]{3}$/i.test(object.currency) ? object.currency.toLowerCase() : null,
    amountPaidCents: null, amountTotalCents: null, amountSubtotalCents: null, amountDueCents: null, discountCents: null,
    promotionCodes: unique(discounts.map(item => code(item.promotion_code))), couponIds: unique(discounts.map(item => code(item.coupon) || code(item.source?.coupon))),
    paidAt: null, periodStart: null, attemptCount: null, nextPaymentAttemptAt: null, cancellationReason: null, cancellationFeedback: null,
  };
  if (type.startsWith('checkout.session.')) {
    Object.assign(billing, { sessionId: prefixed(object.id, 'cs_'), invoiceId: prefixed(object.invoice, 'in_'), amountTotalCents: cents(object.amount_total), amountSubtotalCents: cents(object.amount_subtotal), discountCents: cents(object.total_details?.amount_discount),
      // Checkout reports no separate amount paid: a paid session charged its total.
      amountPaidCents: ['paid', 'no_payment_required'].includes(object.payment_status) ? cents(object.amount_total) : null });
  } else if (type.startsWith('invoice.')) {
    // The period a cycle invoice pays is its subscription lines' period (as invoiceSubscription reads them); proration lines can start mid-way through the last one.
    const lines = list(object.lines?.data).filter(plain).filter(subscriptionLine), billed = lines.filter(line => !prorationLine(line));
    const starts = (billed.length ? billed : lines).map(line => line.period?.start).filter(Number.isInteger);
    const discounted = Array.isArray(object.total_discount_amounts) ? object.total_discount_amounts.map(item => cents(item?.amount)) : null;
    Object.assign(billing, { invoiceId: prefixed(object.id, 'in_'), amountPaidCents: cents(object.amount_paid), amountTotalCents: cents(object.total), amountSubtotalCents: cents(object.subtotal), amountDueCents: cents(object.amount_due),
      discountCents: discounted && !discounted.includes(null) ? cents(total(discounted)) : null, paidAt: iso(object.status_transitions?.paid_at), periodStart: starts.length ? iso(Math.min(...starts)) : null,
      attemptCount: count(object.attempt_count), nextPaymentAttemptAt: iso(object.next_payment_attempt) });
  } else if (type === 'customer.subscription.deleted') {
    const details = plain(object.cancellation_details) ? object.cancellation_details : {};
    Object.assign(billing, { cancellationReason: CANCELLATION_REASONS.has(details.reason) ? details.reason : null, cancellationFeedback: FEEDBACK.has(details.feedback) ? details.feedback : null });
  }
  return billing;
}

export const openPeriod = periods => list(periods).findLast(period => plain(period) && period.status === 'open') || null;

const periodStartMs = period => ms(period.periodStart || period.openedAt);
// A closed period covers visits until it closed, but never past the end of the year it was paid for: a visit after that (dunning before
// a cancellation) belongs to a year nobody paid. An open period covers every later visit (planMembershipVisit holds one past its end).
const periodEndMs = period => period.status === 'open' ? Infinity : period.status === 'closed' ? Math.min(ms(period.closedAt), Number.isFinite(ms(period.periodEnd)) ? ms(period.periodEnd) : Infinity) : NaN;

/**
 * The period a visit completed at `usedAt` belongs to: the newest period that
 * had started by then and was still open, or closed after it and before its
 * paid periodEnd. A pre-ledger stub has no known start, so it covers
 * everything before its close (or its periodEnd). Null when no period covers it
 * (before the membership, after a cancellation, or after the paid year of a
 * closed period: afterPaidPeriod).
 */
export function coveringPeriod(periods, usedAt) {
  const at = ms(usedAt);
  if (!Number.isFinite(at)) return null;
  for (const period of [...list(periods)].reverse()) {
    if (!plain(period)) continue;
    const start = periodStartMs(period);
    if (Number.isFinite(start) && at < start) continue;
    return at < periodEndMs(period) ? period : null;
  }
  return null;
}

/** The closed period whose paid year ended before `usedAt` while it was still on file (from its periodEnd until it closed); null otherwise. */
export function afterPaidPeriod(periods, usedAt) {
  const at = ms(usedAt), period = [...list(periods)].reverse().find(item => plain(item) && !(Number.isFinite(periodStartMs(item)) && at < periodStartMs(item)));
  return Number.isFinite(at) && period?.status === 'closed' && at >= ms(period.periodEnd) && at < ms(period.closedAt) ? period : null;
}

/**
 * The membership year a visit can be placed in when no billing period covers
 * it (a member recorded before this ledger, or whose ledger write failed):
 * [start, end). end is the Stripe currentPeriodEnd and start one plan year
 * before it; with no period end on file, start is the later of when the Hub
 * recorded the membership and its provisional start, and end is unknown.
 * Null bounds are unknown.
 */
export function legacyMembershipYear(membership) {
  const end = instantOf(membership?.currentPeriodEnd);
  if (end) return { start: yearBefore(end), end };
  const bounds = [membership?.createdAt, membership?.provisionalStartedAt].map(instantOf).filter(Boolean).map(ms);
  return { start: bounds.length ? new Date(Math.max(...bounds)).toISOString() : null, end: null };
}

/**
 * The earliest instant a visit can belong to this membership as far as the
 * Hub knows: its ledger startedAt; else the start of its oldest billing period
 * (a pre-ledger stub's year ends at its periodEnd); else the start of its
 * current legacy year. Null when nothing bounds it.
 */
export function membershipVisitFloor(membership) {
  const started = instantOf(membership?.startedAt);
  if (started) return started;
  const starts = list(membership?.periods).filter(plain).map(period => instantOf(period.periodStart) || (period.preLedger && instantOf(period.periodEnd) ? yearBefore(period.periodEnd) : instantOf(period.openedAt))).filter(Boolean).map(ms);
  return starts.length ? new Date(Math.min(...starts)).toISOString() : legacyMembershipYear(membership).start;
}

/** Every visit job the ledger already counted (visits[]) or a reconcile covered (adjustments[].jobIds): Map jobId -> {kind, entry, period}. */
export function ledgerVisits(membership) {
  const found = new Map();
  for (const period of list(membership?.periods).filter(plain)) {
    for (const entry of list(period.visits).filter(plain)) if (typeof entry.jobId === 'string') found.set(entry.jobId, { kind: 'applied', entry, period });
    for (const adjustment of list(period.adjustments).filter(plain)) for (const jobId of list(adjustment.jobIds)) if (typeof jobId === 'string' && !found.has(jobId)) found.set(jobId, { kind: 'reconciled', entry: adjustment, period });
  }
  for (const entry of list(membership?.unallocatedVisits).filter(plain)) if (typeof entry.jobId === 'string') found.set(entry.jobId, { kind: 'applied', entry, period: null });
  for (const adjustment of list(membership?.visitAdjustments).filter(plain)) for (const jobId of list(adjustment.jobIds)) if (typeof jobId === 'string' && !found.has(jobId)) found.set(jobId, { kind: 'reconciled', entry: adjustment, period: null });
  return found;
}

/**
 * The member visits of `membership` that `period` (closed) covers but nobody
 * has counted or settled yet: completed jobs carrying its membershipId whose
 * membershipVisit is not applied or reconciled and that the ledger does not
 * hold (the overview's pending, not_recorded and needs_review). Sorted job ids;
 * null when there are more than a period can list (unknown).
 */
export function unresolvedPeriodVisits(jobs, membership, period, now) {
  const membershipId = membership?.subscriptionId || membership?.id, counted = ledgerVisits(membership);
  const ids = list(jobs).filter(plain).filter(job => typeof job.id === 'string' && job.membershipId === membershipId && !job.recordType && VISIT_JOB_TYPES.has(job.type) && visitCompleted(job)
    && !['applied', 'reconciled'].includes(job.membershipVisit?.status) && !counted.has(job.id) && coveringPeriod([period], earlier(job.completedAt, now)) === period).map(job => job.id);
  return ids.length > LEDGER_LIMITS.visits ? null : [...new Set(ids)].sort();
}

// Unresolved visits at close keep a period's breakage unknown until each is counted in it or settled, unless the period is already fully used.
const fullyUsed = period => Number.isInteger(period.visitsIncluded) && count(period.visitsUsed) !== null && period.visitsUsed >= period.visitsIncluded;
const unresolvedAtClose = period => period.status === 'closed' && (period.unresolvedVisitJobIds === null || list(period.unresolvedVisitJobIds).length > 0) && !fullyUsed(period);

/**
 * The member visits of `membership` that `period` would close with unresolved,
 * from a listing of its member-visit jobs ({rows, complete}): {ids, fences}.
 * ids is unresolvedPeriodVisits over the listing, so it is null (unknown) only
 * when the listing is missing or incomplete, or when more than
 * LEDGER_LIMITS.visits of the period's own completed visits are uncounted:
 * cancelled jobs, jobs of other years and scheduled jobs never make it
 * unknown. fences are read-only verify writes, at the revision listed, for the
 * uncounted jobs that could still land in the period (a visit job, never a
 * server record, that is not cancelled or no-show and was completed inside the
 * period or is not completed yet): a completion or other change to one of them
 * before the commit that uses ids makes that commit conflict and list them
 * again. At most LEDGER_LIMITS.fences are fenced (the ids are never nulled for
 * it): first the jobs not completed yet, nearest the close by date, then the
 * period's listed visits (a change to one of those can only leave the list
 * longer than it should be, never shorter). A fenceable job listed without a
 * revision cannot be fenced, so ids is then null.
 */
export function listedUnresolvedVisits(found, membership, period, now) {
  if (found?.complete !== true || !Array.isArray(found.rows)) return { ids: null, fences: [] };
  const ids = unresolvedPeriodVisits(found.rows, membership, period, now);
  // An unknown list is already the conservative answer: no change a fence could catch makes it less known.
  if (ids === null) return { ids, fences: [] };
  const membershipId = membership?.subscriptionId || membership?.id, counted = ledgerVisits(membership), waiting = [], listed = [];
  for (const job of found.rows) {
    if (!plain(job) || typeof job.id !== 'string' || job.membershipId !== membershipId || job.recordType || !VISIT_JOB_TYPES.has(job.type) || OFF_STAGES.has(visitStage(job))
      || ['applied', 'reconciled'].includes(job.membershipVisit?.status) || counted.has(job.id)) continue;
    if (!visitCompleted(job)) waiting.push(job);
    else if (coveringPeriod([period], earlier(job.completedAt, now)) === period) listed.push(job);
  }
  if ([...waiting, ...listed].some(job => typeof job.revision !== 'string' || !job.revision)) return { ids: null, fences: [] };
  // A visit completed late (an offline completion syncing) is most likely one dated near the close; a job with no date is fenced first.
  const close = Number.isFinite(ms(period?.closedAt)) ? ms(period.closedAt) : ms(now), distance = job => { const day = Date.parse(typeof job.date === 'string' ? job.date : ''); return Number.isFinite(day) ? Math.abs(day - close) : -1; };
  waiting.sort((a, b) => distance(a) - distance(b) || a.id.localeCompare(b.id));
  listed.sort((a, b) => a.id.localeCompare(b.id));
  return { ids, fences: [...waiting, ...listed].slice(0, LEDGER_LIMITS.fences).map(job => ({ collection: 'jobs', id: job.id, revision: job.revision, verify: true })) };
}

/** Removes settled job ids from a closed period's unresolved visits (a late visit counted in it, or a reconcile covering it); true when the list changed. */
export function resolvePeriodVisits(period, jobIds) {
  if (!plain(period) || !Array.isArray(period.unresolvedVisitJobIds)) return false;
  const left = period.unresolvedVisitJobIds.filter(id => !jobIds.includes(id));
  if (left.length === period.unresolvedVisitJobIds.length) return false;
  period.unresolvedVisitJobIds = left;
  return true;
}

/**
 * Revenue recognized by the `occurrence`-th visit of a period (owner decision
 * 11): paid / included, rounded down, with the last included visit taking the
 * remainder so the visits of a fully used period add up to exactly what was
 * paid. Never more than the period still holds; null when paid is unknown, or
 * once the plan changed during the period (price paid / included no longer
 * describes one plan, and a plan change does not reset the member's visit
 * count, so the per-visit revenue waits for an owner decision).
 */
export function visitAllocation(period, occurrence) {
  const paid = cents(period?.paidCents), included = period?.visitsIncluded, recognized = cents(period?.recognizedCents) ?? 0;
  if (paid === null || list(period?.planChanges).length || !Number.isInteger(included) || included < 1 || !Number.isInteger(occurrence) || occurrence < 1 || occurrence > included) return null;
  const base = Math.floor(paid / included);
  return Math.max(0, Math.min(occurrence === included ? paid - base * (included - 1) : base, paid - recognized));
}

/** Voluntary: the member (or staff) cancelled a paid-up membership. Involuntary: Stripe ended it after failed payments. */
export function churnClass(reason, previousStatus) {
  if (reason === 'payment_failed' || reason === 'payment_disputed') return { class: 'involuntary', source: 'stripe_reason' };
  if (reason === 'cancellation_requested') return { class: 'voluntary', source: 'stripe_reason' };
  if (previousStatus === 'past_due') return { class: 'involuntary', source: 'past_due_status' };
  if (previousStatus === 'active') return { class: 'voluntary', source: 'active_status' };
  return { class: null, source: 'unknown' };
}

/**
 * The account job's garageGuard against its membership once the server has
 * mirrored it: null when plan, status and visit counts agree, otherwise
 * {fields, rewritten, observed, expected}. `rewritten` says someone other than
 * the server saved the map (the browser "Garage Guard status" dialog replaces
 * it without source); a rewrite that only changed nextVisit or renewalDate is
 * not drift, since the next server mirror restores the rest.
 */
export function garageGuardDrift(guard, membership) {
  if (!plain(guard) || !plain(membership) || membership.link?.status !== 'linked' || !membership.link.mirroredAt) return null;
  const expected = { plan: membership.plan || null, status: membership.status || null, visitsIncluded: Number.isInteger(membership.visitsIncluded) ? membership.visitsIncluded : null, visitsRemaining: Number.isInteger(membership.visitsRemaining) ? membership.visitsRemaining : null };
  const observed = { plan: guard.plan ?? null, status: guard.status ?? null, visitsIncluded: guard.visitsIncluded ?? null, visitsRemaining: guard.visitsRemaining ?? null };
  const fields = Object.keys(expected).filter(key => expected[key] !== null && observed[key] !== expected[key]);
  const rewritten = guard.source !== 'stripe' || guard.membershipId !== (membership.subscriptionId || membership.id);
  if (!fields.length) return null;
  return { fields, rewritten, observed: { ...observed, source: text(guard.source, 40) || null, updatedBy: text(guard.updatedBy, 80) || null, updatedAt: text(guard.updatedAt, 40) || null }, expected };
}

/** The open manual-edit flag for a drift, keeping when it was first seen. */
export function manualEditFlag(previous, drift, now, detectedBy) {
  const open = previous?.status === 'open';
  return { status: 'open', firstDetectedAt: open && previous.firstDetectedAt ? previous.firstDetectedAt : now, detectedAt: now, detectedBy, fields: drift.fields, rewritten: drift.rewritten, observed: drift.observed, expected: drift.expected };
}

/**
 * Why a period's recognized revenue (so its deferred revenue and breakage) is
 * not known, or null when it is: a pre-ledger stub, a manual count or payment
 * dispute found at close, an unknown amount paid, visits the ledger did not
 * track for the whole period, completed member visits still uncounted when it
 * closed, or a visit or reconcile whose revenue is unknown.
 */
export function recognitionGap(period) {
  if (!plain(period)) return 'no_period';
  if (period.preLedger) return 'pre_ledger';
  if (STICKY_GAPS.has(period.breakageUnknown)) return period.breakageUnknown;
  if (cents(period.paidCents) === null) return 'amount_unknown';
  if (period.visitsTracked !== true) return 'visits_untracked';
  if (unresolvedAtClose(period)) return 'visits_unresolved';
  if (list(period.visits).some(visit => plain(visit) && cents(visit.allocatedCents) === null) || list(period.adjustments).some(adjustment => plain(adjustment) && cents(adjustment.recognizedCents) === null)) return 'unknown_allocation';
  return null;
}

/**
 * Why the ledger may not hold every member visit of `period` (so the visits
 * used, and the visit revenue recognized, in any range that overlaps it are
 * unknown), or null when it holds them all: a pre-ledger stub, visits it did
 * not track for the whole period, a browser count against it (found at its
 * close, or a manual edit open now while it is open), or completed member
 * visits still uncounted when it closed. An unknown amount paid is not such a
 * gap: every visit of a tracked period is still logged, with unknown revenue.
 */
export function visitCountGap(period, membership) {
  if (!plain(period)) return 'no_period';
  if (period.preLedger) return 'pre_ledger';
  if (period.visitsTracked !== true) return 'visits_untracked';
  if (period.breakageUnknown === 'manual_edit' || (period.status === 'open' && membership?.manualEdit?.status === 'open')) return 'manual_edit';
  if (unresolvedAtClose(period)) return 'visits_unresolved';
  return null;
}

/** The instants a period's visits can fall in, [start, end) in ms; an unknown bound is open-ended (a stub starts a plan year before its periodEnd). */
export function periodVisitSpan(period) {
  const start = period?.preLedger ? (Number.isFinite(ms(period.periodEnd)) ? ms(yearBefore(period.periodEnd)) : NaN) : periodStartMs(period || {}), end = plain(period) ? periodEndMs(period) : NaN;
  return [Number.isFinite(start) ? start : -Infinity, Number.isNaN(end) ? Infinity : end];
}

/** Sets a closed period's breakageCents (paid - recognized) and breakageUnknown from its current visits; null when unknown. */
export function settleBreakage(period) {
  const gap = recognitionGap(period);
  return Object.assign(period, { breakageUnknown: gap, breakageCents: gap ? null : Math.max(0, cents(period.paidCents) - (cents(period.recognizedCents) ?? 0)) });
}

function closePeriod(period, reason, at, gap = null, countsAtClose = null, unresolved = undefined) {
  Object.assign(period, { status: 'closed', closedAt: at, closeReason: reason, ...(gap ? { breakageUnknown: gap } : {}), ...(countsAtClose ? { countsAtClose } : {}), ...(unresolved !== undefined ? { unresolvedVisitJobIds: unresolved } : {}) });
  return settleBreakage(period);
}

// A member recorded before this ledger paid for its current year before FUN-20: when that year renews or ends, a closed stub stands for it (amounts and visits unknown) so the renewal or lapse is counted.
function preLedgerPeriod(current, reason, at) {
  return { id: 'pre_ledger', status: 'closed', preLedger: true, openedAt: null, paidSource: null, invoiceId: null, invoiceIds: [], paidCents: null, amountTotalCents: null, discountCents: null,
    periodStart: null, periodEnd: typeof current.currentPeriodEnd === 'string' && current.currentPeriodEnd ? current.currentPeriodEnd : null, plan: current.plan || null, visitsIncluded: Number.isInteger(current.visitsIncluded) ? current.visitsIncluded : null,
    visitsTracked: false, visitsUsed: null, recognizedCents: null, visits: [], adjustments: [], closedAt: at, closeReason: reason, breakageCents: null, breakageUnknown: 'pre_ledger' };
}

function newPeriod(id, source, billing, next, periodEnd, openedAt, visitTracking) {
  return { id, status: 'open', openedAt, paidSource: source, invoiceId: billing.invoiceId, invoiceIds: billing.invoiceId ? [billing.invoiceId] : [], paidCents: billing.amountPaidCents, amountTotalCents: billing.amountTotalCents, discountCents: billing.discountCents,
    periodStart: billing.periodStart, periodEnd: periodEnd || null, plan: next.plan || null, visitsIncluded: Number.isInteger(next.visitsIncluded) ? next.visitsIncluded : null, visitsTracked: visitTracking === true,
    visitsUsed: 0, recognizedCents: 0, visits: [], adjustments: [], closedAt: null, closeReason: null, breakageCents: null, breakageUnknown: null };
}

const receiptAmounts = billing => ({ currency: billing.currency, amountPaidCents: billing.amountPaidCents, amountTotalCents: billing.amountTotalCents, amountSubtotalCents: billing.amountSubtotalCents, amountDueCents: billing.amountDueCents,
  discountCents: billing.discountCents, promotionCodes: billing.promotionCodes, couponIds: billing.couponIds, invoiceId: billing.invoiceId, sessionId: billing.sessionId });

/**
 * The ledger fields, receipt fields and funnel event writes one applied Stripe
 * event adds to its membership commit. `current` is the membership as read
 * (null when new), `next` the membership patch applyGarageGuardEvent writes,
 * `accountJob` the linked account job it read, `mirroredGuard` the garageGuard
 * this commit writes onto that job (undefined when it writes none),
 * `visitTracking` whether GARAGE_GUARD_VISIT_TRACKING_ENABLED is on,
 * `visitJobs` an async loader of the membership's member-visit jobs
 * ({rows, complete}; called only when a tracked period closes, and with none
 * the closing period's unresolved visits are unknown), `now` the server time.
 */
export async function garageGuardLedger({ current = null, next, input, billing, accountJob = null, mirroredGuard, visitTracking = false, visitJobs = null, now }) {
  const previousStatus = typeof current?.status === 'string' ? current.status : '', status = next.status, eventAt = earlier(iso(input.created), now);
  const periods = structuredClone(list(current?.periods)).filter(plain), invoices = structuredClone(list(current?.invoices)).filter(plain);
  const membership = { ledgerVersion: GARAGE_GUARD_LEDGER_VERSION }, receipt = { amounts: receiptAmounts(billing) }, facts = [];
  let open = openPeriod(periods), closed = null;
  // Visit tracking must be on for a period's whole life for the ledger to know its visits; it is sampled at every Stripe event. The Hub
  // counts no visit of a member it has not linked to a customer (needs_review or unlinked), so such a period is untracked too.
  const tracking = visitTracking === true && next.link?.status === 'linked';
  if (open && !tracking) open.visitsTracked = false;
  // A membership recorded before this ledger (or whose first ledger write failed) that was already past pending may have been active
  // already: it is marked preLedger for good, and its status then was live at least since the Stripe event that set it.
  const firstLedgerWrite = Boolean(current) && !current.ledgerVersion && !['', 'pending'].includes(previousStatus);
  if (firstLedgerWrite) {
    membership.preLedger = true;
    const since = LIVE_MEMBERSHIP_STATUSES.includes(previousStatus) ? iso(Number(current.statusEventCreated)) : null;
    if (since) membership.provisionalStartedAt = since;
  }
  const preLedger = firstLedgerWrite || current?.preLedger === true;
  const legacyYear = !open && !periods.length && LIVE_MEMBERSHIP_STATUSES.includes(previousStatus) && preLedger;
  // The account job as it stood during the period this event may close: a browser count there (or a manual edit still open) means the
  // ledger did not see every visit of that period, so its breakage is unknown.
  const drift = current && accountJob && accountJob.id === current.link?.accountJobId ? garageGuardDrift(accountJob.garageGuard, { ...current, subscriptionId: input.subscriptionId }) : null;
  const storedEdit = current?.manualEdit?.status === 'open' ? current.manualEdit : null;
  const countsDisputed = Boolean(drift?.fields.some(field => COUNT_FIELDS.includes(field)) || (storedEdit && (!Array.isArray(storedEdit.fields) || storedEdit.fields.some(field => COUNT_FIELDS.includes(field)))));
  const countsAtClose = countsDisputed ? { membershipVisitsRemaining: count(current.visitsRemaining), accountVisitsRemaining: count(drift?.observed.visitsRemaining), manualEditOpen: Boolean(storedEdit) } : null;
  // A completed member visit of a tracked period that nobody has counted or settled when it closes (pending, not recorded or needing review)
  // keeps its breakage unknown until each is counted in it (a late visit) or settled (visits.reconcile); unknown when the jobs cannot be listed.
  // Every listed job the ledger has not counted is fenced in this commit (fences), so a change to one before it lands lists them again.
  const fences = [];
  let unlisted = null;
  const unresolvedAt = async (period, at, gap) => {
    if (period.visitsTracked !== true || gap) return undefined;
    const found = typeof visitJobs === 'function' ? await visitJobs() : null;
    if (plain(found?.unlisted)) unlisted = found.unlisted;
    const listed = listedUnresolvedVisits(found, { ...(current || {}), subscriptionId: input.subscriptionId }, { ...period, status: 'closed', closedAt: at }, now);
    fences.push(...listed.fences);
    return listed.ids;
  };

  if (input.action === 'checkout') {
    const checkout = plain(current?.checkout) ? current.checkout : null;
    if (!checkout || checkout.eventCreated <= input.created) membership.checkout = { sessionId: billing.sessionId, eventId: input.eventId, eventCreated: input.created, paid: input.paid === true, amountTotalCents: billing.amountTotalCents, amountSubtotalCents: billing.amountSubtotalCents, discountCents: billing.discountCents, promotionCodes: billing.promotionCodes, couponIds: billing.couponIds };
  }
  if (input.action === 'paid') {
    const key = billing.invoiceId || `event:${input.eventId}`;
    if (!invoices.some(row => (row.invoiceId || `event:${row.eventId}`) === key)) invoices.push({ invoiceId: billing.invoiceId, eventId: input.eventId, paidAt: earlier(billing.paidAt || eventAt, now), amountPaidCents: billing.amountPaidCents, amountTotalCents: billing.amountTotalCents, discountCents: billing.discountCents, billingReason: text(input.billingReason, 60) || null, periodEnd: input.periodEnd || null });
  }
  // The latest payment's amounts describe the membership; promotions accumulate.
  if ((input.action === 'checkout' && input.paid) || input.action === 'paid') {
    if (input.created >= Number(current?.amountsEventCreated || 0)) Object.assign(membership, { amountPaidCents: billing.amountPaidCents, amountTotalCents: billing.amountTotalCents, discountCents: billing.discountCents, currency: billing.currency || current?.currency || null, amountsEventCreated: input.created, amountsEventId: input.eventId });
    membership.promotionCodes = unique([...list(current?.promotionCodes), ...billing.promotionCodes]);
    membership.couponIds = unique([...list(current?.couponIds), ...billing.couponIds]);
  }
  // Lifetime paid is complete only once an invoice is on file (a checkout alone is not subscription cash) and every invoice amount is known.
  const trimmedInvoices = invoices.slice(-LEDGER_LIMITS.invoices), paid = trimmedInvoices.map(row => cents(row.amountPaidCents));
  Object.assign(membership, { invoices: trimmedInvoices, lifetimePaidCents: total(paid.filter(value => value !== null)), lifetimePaidComplete: trimmedInvoices.length > 0 && !paid.includes(null) });

  // Billing periods: the first paid checkout or invoice opens one; each cycle renewal closes it and opens the next.
  let extended = null;
  const reset = input.action === 'paid' && CYCLE_REASONS.includes(input.billingReason) && Boolean(input.periodEnd) && (!current?.currentPeriodEnd || input.periodEnd > current.currentPeriodEnd);
  if (input.action === 'checkout' && status === 'active' && !open) periods.push(open = newPeriod(`checkout:${input.eventId}`, 'checkout', billing, next, null, eventAt, tracking));
  if (reset && status !== 'cancelled') {
    if (input.billingReason === 'subscription_create' && open?.paidSource === 'checkout') {
      // The first invoice confirms the period its checkout opened.
      Object.assign(open, { paidSource: 'invoice', invoiceId: billing.invoiceId, invoiceIds: unique([...list(open.invoiceIds), billing.invoiceId]), paidCents: billing.amountPaidCents ?? open.paidCents, amountTotalCents: billing.amountTotalCents ?? open.amountTotalCents, discountCents: billing.discountCents ?? open.discountCents, periodStart: billing.periodStart, periodEnd: input.periodEnd });
    } else {
      const at = earlier(billing.paidAt || eventAt, now), gap = countsDisputed ? 'manual_edit' : null;
      if (open) closed = closePeriod(open, 'renewed', at, gap, countsAtClose, await unresolvedAt(open, at, gap));
      else if (legacyYear && input.billingReason === 'subscription_cycle') periods.push(closed = preLedgerPeriod(current, 'renewed', at));
      periods.push(open = newPeriod(billing.invoiceId || `invoice:${input.eventId}`, 'invoice', billing, next, input.periodEnd, eventAt, tracking));
    }
  } else if (input.action === 'paid' && !CYCLE_REASONS.includes(input.billingReason) && open && billing.invoiceId && !list(open.invoiceIds).includes(billing.invoiceId)) {
    // A proration or manual invoice pays into the current period.
    open.invoiceIds = [...list(open.invoiceIds), billing.invoiceId];
    open.paidCents = cents(open.paidCents) !== null && billing.amountPaidCents !== null ? cents(open.paidCents + billing.amountPaidCents) : null;
    // A plan change that resets the billing anchor bills a year from now (its subscription line ends after the open period): the member has
    // paid through that end, so the open period now runs to it (and its visits are held for a renewal only after it).
    if (input.periodEnd && Number.isFinite(ms(open.periodEnd)) && ms(input.periodEnd) > ms(open.periodEnd)) {
      extended = { previousPeriodEnd: open.periodEnd, periodEnd: input.periodEnd };
      open.periodEnd = input.periodEnd;
    }
  }
  const renewed = reset && input.billingReason === 'subscription_cycle' && status !== 'cancelled';
  if (renewed) Object.assign(membership, { renewalCount: Number(current?.renewalCount || 0) + 1, lastRenewedAt: earlier(billing.paidAt || eventAt, now) });

  // Only a membership this ledger followed from the start (never preLedger, no failed ledger write) can be past_due without ever having been active.
  const neverActive = !current || ['', 'pending'].includes(previousStatus) || (Boolean(current.ledgerVersion) && !preLedger && !current.ledgerError && previousStatus === 'past_due');
  const started = status === 'active' && !current?.startedAt && neverActive;
  if (started) Object.assign(membership, { startedAt: eventAt, startedEventId: input.eventId });
  if (input.action === 'payment_failed' && previousStatus !== 'cancelled') Object.assign(membership, { paymentFailureCount: Number(current?.paymentFailureCount || 0) + 1, lastPaymentFailedAt: eventAt,
    lastPaymentFailure: { invoiceId: billing.invoiceId, eventId: input.eventId, amountDueCents: billing.amountDueCents, attemptCount: billing.attemptCount, nextPaymentAttemptAt: billing.nextPaymentAttemptAt } });
  let churn = null;
  if (status === 'cancelled' && previousStatus !== 'cancelled') {
    const at = earlier(next.cancelledAt || eventAt, now);
    // A disputed charge is not breakage until the dispute is settled (refunds and disputes are FUN-17's).
    const gap = billing.cancellationReason === 'payment_disputed' ? 'payment_disputed' : countsDisputed ? 'manual_edit' : null;
    if (open) closed = closePeriod(open, 'cancelled', at, gap, countsAtClose, await unresolvedAt(open, at, gap));
    else if (legacyYear) periods.push(closed = preLedgerPeriod(current, 'cancelled', at));
    const classed = churnClass(billing.cancellationReason, previousStatus);
    churn = membership.churn = { class: classed.class, source: classed.source, reason: billing.cancellationReason, feedback: billing.cancellationFeedback, statusAtCancel: previousStatus || null, at, eventId: input.eventId };
    receipt.churnClass = classed.class;
  }
  // A plan change during a period (a proration invoice with the new plan), or a period an invoice extended, is recorded on it; from then on
  // its per-visit revenue is unknown (price paid / included no longer describes one plan year).
  const planChanged = open?.status === 'open' && next.plan && (open.plan ? open.plan !== next.plan : Number.isInteger(open.visitsIncluded) && open.visitsIncluded !== next.visitsIncluded);
  if (planChanged || (extended && open?.status === 'open')) {
    Object.assign(open, { ...(planChanged ? { plan: next.plan } : {}), planChanges: [...list(open.planChanges), { at: eventAt, eventId: input.eventId, plan: next.plan || null, visitsIncluded: Number.isInteger(next.visitsIncluded) ? next.visitsIncluded : null, ...(extended || {}) }].slice(-LEDGER_LIMITS.codes) });
  }
  // A year whose member visits could not be listed at its close (after VISIT_LIST_RETRY_MS of retries) says so; a manager settles it with visits.reconcile.
  if (closed && unlisted) { closed.visitsUnlisted = unlisted; receipt.visitsUnlisted = unlisted; }
  membership.periods = periods.slice(-LEDGER_LIMITS.periods);

  // A browser edit is flagged only where it still differs after this commit: a renewal whose mirror restores the visits settles the count
  // (the closed period keeps it in countsAtClose), and the mirror always rewrites plan, status and visits included.
  const after = drift || storedEdit ? garageGuardDrift(mirroredGuard === undefined ? accountJob?.garageGuard : mirroredGuard, { ...next, subscriptionId: input.subscriptionId }) : null;
  const fields = drift ? drift.fields.filter(field => after?.fields.includes(field)) : [];
  if (fields.length) membership.manualEdit = manualEditFlag(current.manualEdit, { ...drift, fields }, now, `stripe_event:${input.eventId}`);
  // An open flag a renewal settles (the new year starts from the Stripe count and the account matches it) is resolved; the closed year keeps the dispute.
  else if (storedEdit && !after && closed?.closeReason === 'renewed' && mirroredGuard !== undefined) membership.manualEdit = { ...storedEdit, status: 'resolved', resolvedAt: now, resolvedBy: 'stripe_webhook', resolution: 'renewal_reset', resolvedPeriodId: closed.id };

  const plan = funnelVocabulary('garageGuardPlans').includes(next.plan) ? next.plan : undefined;
  // Unknown breakage (null) is left out of the event, never sent as 0.
  if (started) facts.push(['membership.started', eventAt, { amountCents: billing.amountPaidCents, discountCents: billing.discountCents, plan }]);
  if (renewed) facts.push(['membership.renewed', earlier(billing.paidAt || eventAt, now), { amountCents: billing.amountPaidCents, discountCents: billing.discountCents, breakageCents: closed?.breakageCents ?? undefined, plan }]);
  if (input.action === 'payment_failed' && previousStatus !== 'cancelled') facts.push(['membership.payment_failed', eventAt, { amountCents: billing.amountDueCents, plan }]);
  if (churn) facts.push(['membership.cancelled', churn.at, { churnClass: churn.class, initiatedBy: churn.class === 'involuntary' ? 'system' : undefined, breakageCents: closed?.breakageCents ?? undefined, plan }]);
  const events = [];
  if (facts.length && STRIPE_EVENT_ID.test(input.eventId) && PROVIDER_ID.test(input.subscriptionId)) {
    const customerId = next.link?.status === 'linked' && funnelHubId(next.link.customerId) ? next.link.customerId : undefined;
    for (const [type, occurredAt, data] of facts) events.push(await funnelEventWrite(null, now, {
      type, idempotencyKey: { kind: 'stripeEvent', value: input.eventId }, clockSource: 'provider', occurredAt, membershipId: input.subscriptionId, customerId,
      actor: STRIPE_ACTOR, via: 'stripe', source: { collection: 'stripe_events', id: input.eventId }, data,
      eligibility: { stripe: { livemode: input.livemode, id: billing.sessionId || billing.invoiceId || input.subscriptionId } },
    }));
    receipt.funnelEventIds = events.map(write => write.id);
  } else if (facts.length) Object.assign(receipt, { funnelEventIds: [], funnelEventsSkipped: 'invalid_stripe_id' });
  return { membership, receipt, events: events.map(({ collection, id, patch }) => ({ collection, id, patch })), fences };
}

/**
 * Wraps the membership store for one Stripe event: reads are passed through
 * (remembering the membership and job rows applyGarageGuardEvent read in this
 * attempt) and the commit that writes this event's membership and receipt
 * gets the ledger fields and funnel events added. Every other commit (alert
 * claims and settlements) is passed through untouched. `visitTracking` is
 * garageGuardVisitTrackingEnabled(env) for this request. When a tracked
 * period closes, the membership's member-visit jobs are read with
 * store.membershipVisits(subscriptionId) ({rows, complete}) and every one the
 * ledger has not counted is fenced in the commit. A failure listing them fails
 * the commit like any other read (the webhook answers 503 and Stripe
 * redelivers) while the event is less than VISIT_LIST_RETRY_MS old; after
 * that the membership is recorded anyway, with the closing year's unresolved
 * visits unknown (null) and visitsUnlisted saying why, so a listing that keeps
 * failing never blocks the membership record. A store without the method
 * leaves the unresolved visits unknown.
 */
export const VISIT_LIST_RETRY_MS = 60 * 60 * 1000;
export function garageGuardLedgerStore(store, input, billing, now, { visitTracking = false } = {}) {
  const seen = new Map();
  return {
    ...store,
    async read(collection, id) {
      const row = await store.read(collection, id);
      if ((collection === 'memberships' && id === input.subscriptionId) || collection === 'jobs') seen.set(`${collection}/${id}`, row);
      return row;
    },
    async commit(writes) {
      const membership = writes.find(write => write.collection === 'memberships' && write.id === input.subscriptionId && !write.verify);
      const receipt = writes.find(write => write.collection === 'stripe_events' && write.id === input.eventId && !write.verify && !write.revision);
      if (!membership || !receipt) return store.commit(writes);
      const current = seen.get(`memberships/${input.subscriptionId}`) || null, link = membership.patch.link, linked = link?.status === 'linked';
      const mirror = linked ? writes.find(write => write.collection === 'jobs' && write.id === link.accountJobId && !write.verify && plain(write.patch?.garageGuard)) : null;
      let ledger, readFailure = null;
      const visitJobs = typeof store.membershipVisits === 'function' ? async () => {
        try { return await store.membershipVisits(input.subscriptionId); }
        catch (error) {
          const age = ms(now) - Number(input.created) * 1000;
          if (!(age >= VISIT_LIST_RETRY_MS)) { readFailure = error; throw error; }
          return { rows: null, complete: false, unlisted: { at: now, code: text(error?.code, 80) || 'visits_unlisted' } };
        }
      } : null;
      try { ledger = await garageGuardLedger({ current, next: membership.patch, input, billing, accountJob: linked ? seen.get(`jobs/${link.accountJobId}`) || null : null, mirroredGuard: mirror ? mirror.patch.garageGuard : undefined, visitTracking: visitTracking === true, visitJobs, now }); }
      catch (error) {
        // A storage read that failed is retried with the whole event, never recorded as a ledger gap.
        if (readFailure) throw readFailure;
        // The membership is still recorded; the gap is visible on it and on the receipt.
        const failure = { eventId: input.eventId, at: now, code: text(error?.code, 80) || 'ledger_failed' };
        return store.commit(writes.map(write => write === membership ? { ...write, patch: { ...write.patch, ledgerError: failure } } : write === receipt ? { ...write, patch: { ...write.patch, ledgerError: failure } } : write));
      }
      // A listed member visit this commit already writes (or fences) at its read revision is fenced by that write.
      const targets = new Set([...writes, ...ledger.events].map(write => `${write.collection}/${write.id}`));
      const fences = ledger.fences.filter(fence => !targets.has(`${fence.collection}/${fence.id}`) && targets.add(`${fence.collection}/${fence.id}`));
      return store.commit([...writes.map(write => write === membership ? { ...write, patch: { ...write.patch, ...ledger.membership } } : write === receipt ? { ...write, patch: { ...write.patch, ...ledger.receipt } } : write), ...ledger.events, ...fences]);
    },
  };
}

/**
 * When the ledger stopped following a membership, in ms (Infinity while it
 * follows it): a ledger write that failed (ledgerError, from when it was
 * recorded), a renewal it did not record (its open period ends before the
 * Stripe currentPeriodEnd on file: from that periodEnd), or a cancellation it
 * did not close (a cancelled membership whose period is still open: from the
 * cancellation); -Infinity when that time is unknown. From then on the ledger
 * may be missing visits, a year's close (its breakage) and the open year's
 * payment, so the A8 visits, visit revenue, breakage, deferred revenue and MRR
 * it would give are unknown.
 */
export function ledgerStaleFrom(membership) {
  const open = openPeriod(membership?.periods), since = [];
  if (membership?.ledgerError) since.push(ms(membership.ledgerError.at));
  if (open && ms(open.periodEnd) < ms(membership.currentPeriodEnd)) since.push(ms(open.periodEnd));
  if (open && membership.status === 'cancelled') since.push(ms(membership.cancelledAt || membership.churn?.at));
  return since.some(value => !Number.isFinite(value)) ? -Infinity : Math.min(Infinity, ...since);
}

/**
 * Deferred (paid, not yet recognized) cents of a membership now: {cents, known}.
 * Unknown while its open period's recognized revenue is (recognitionGap),
 * while a manual edit of its counts is open (the ledger may have missed
 * visits), or once the ledger is out of step with Stripe (ledgerStaleFrom: its
 * open period may be the wrong year).
 */
export function membershipDeferred(membership) {
  const open = openPeriod(membership?.periods);
  if (!open) return LIVE_MEMBERSHIP_STATUSES.includes(membership?.status) ? { cents: null, known: false } : { cents: 0, known: true };
  if (recognitionGap(open) || membership?.manualEdit?.status === 'open' || ledgerStaleFrom(membership) !== Infinity) return { cents: null, known: false };
  return { cents: Math.max(0, cents(open.paidCents) - (cents(open.recognizedCents) ?? 0)), known: true };
}

/**
 * The membership as the A8 summary and the owner's deferred revenue read it,
 * given its linked account job as read now (`account`): a browser "Garage
 * Guard status" edit whose visit counts differ from the membership, which no
 * Stripe event or visit has flagged yet, is a manual edit open, exactly as a
 * stored flag is (the ledger may have missed visits).
 */
export function withLiveManualEdit(row, account) {
  if (!plain(row) || row.manualEdit?.status === 'open' || row.link?.status !== 'linked' || !plain(account)) return row;
  const drift = garageGuardDrift(account.garageGuard, { ...row, subscriptionId: row.subscriptionId || row.id });
  return drift?.fields.some(field => COUNT_FIELDS.includes(field)) ? { ...row, manualEdit: { status: 'open', live: true, fields: drift.fields } } : row;
}

// A period's price per month, from its paid amount and its Stripe period length.
function monthlyCents(period) {
  const paid = cents(period?.paidCents), span = ms(period?.periodEnd) - ms(period?.periodStart);
  return paid === null || !Number.isFinite(span) || span < DAY ? null : Math.round(paid * MONTH_DAYS * DAY / span);
}

/**
 * When a member was first live: {at, provisional}. The ledger's startedAt is
 * known. A member recorded before the ledger has only a bound: it was live at
 * and after provisionalStartedAt (saved at its first ledger write) or, while
 * still live, after the Stripe event that set its status. Null when unknown.
 */
export function memberStart(row) {
  if (Number.isFinite(ms(row?.startedAt))) return { at: row.startedAt, provisional: false };
  if (Number.isFinite(ms(row?.provisionalStartedAt))) return { at: row.provisionalStartedAt, provisional: true };
  const since = LIVE_MEMBERSHIP_STATUSES.includes(row?.status) ? iso(Number(row.statusEventCreated)) : null;
  return since ? { at: since, provisional: true } : null;
}

/**
 * The A8 Garage Guard section for [startAt, endAt): members, voluntary and
 * involuntary churn, renewals, visit utilization and revenue (subscription
 * cash, visits recognized, breakage, deferred and MRR as of `asOf`, and the
 * revenue-basis member LTV to date). Stripe test-mode memberships are left out
 * (coverage.excluded). Churn rates are over the members live at the period
 * start; a cancellation that cannot be placed in or out of that population is
 * counted in coverage. A period whose visits the ledger did not track for its
 * whole life (visitsTracked) has unknown utilization, deferred revenue and
 * breakage (coverage visitsUntracked, unknownDeferred, unknownBreakage).
 * The visits used and the visit revenue of the range are known only when the
 * ledger holds every member visit of each billing period that overlaps it
 * (visitCountGap), every live member has an open period, and no member the
 * ledger did not follow from its start (recorded before FUN-20) may have been
 * live in the range before its first ledger year; otherwise
 * visits.usedInPeriod, revenue.visitRevenueCents and recognizedCents are null
 * (coverage unknownVisits counts those members; visits.knownUsedInPeriod is the
 * floor), even in a month where no period closes. A manual edit open on a
 * membership (its stored flag, or with `accounts`, a Map of account job id ->
 * job as the GET view reads them, an account job whose visit counts differ
 * from it now: withLiveManualEdit) makes its open year's visits and deferred
 * revenue unknown. A membership whose ledger fell out of step with Stripe
 * (ledgerStaleFrom: a ledgerError, a missed renewal or an unclosed
 * cancellation; coverage ledgerErrors) has unknown visits and visit revenue in
 * any range ending after that point, unknown breakage in a range holding that
 * point or a later close, and unknown deferred revenue and MRR.
 * Anything the ledger cannot establish is counted in coverage, never
 * zero-filled: a revenue total with any unknown contribution is null (the
 * revenue.knownCents object keeps the sum of the known contributions, a floor
 * on each total, for the owner to read next to coverage).
 */
export function garageGuardSummary(rows, { startAt, endAt, asOf, accounts = null }) {
  const from = ms(startAt), to = ms(endAt), inRange = at => { const value = ms(at); return Number.isFinite(value) && value >= from && value < to; };
  const members = { total: 0, active: 0, pastDue: 0, pending: 0, cancelled: 0, started: 0, cancelledInPeriod: 0, activeAtStart: 0, activeAtStartProvisional: 0 };
  const churn = { voluntary: 0, involuntary: 0, unknown: 0, ofActiveAtStart: 0, startedInPeriod: 0, rate: null, voluntaryRate: null, involuntaryRate: null, atRiskPastDue: 0 }, churned = { voluntary: 0, involuntary: 0 };
  const renewals = { due: 0, renewed: 0, lapsed: 0, awaitingPayment: 0, rate: null };
  const visits = { usedInPeriod: 0, knownUsedInPeriod: 0, closedPeriods: { count: 0, included: 0, used: 0, utilization: null }, openPeriods: { count: 0, included: 0, used: 0, utilization: null } };
  const revenue = { subscriptionCashCents: 0, visitRevenueCents: 0, adjustmentRevenueCents: 0, breakageCents: 0, recognizedCents: 0, deferredCents: 0, mrrCents: 0, memberLtv: { basis: 'revenue', members: 0, totalCents: 0, averageCents: null } };
  const gaps = { noLedger: 0, unknownStart: 0, provisionalStart: 0, unknownChurnPopulation: 0, unknownCash: 0, unknownAllocation: 0, unknownBreakage: 0, unknownDeferred: 0, unknownMrr: 0, unknownIncluded: 0, unknownUsed: 0, unknownVisits: 0, visitsUntracked: 0, unknownLifetime: 0, manualEdits: 0, ledgerErrors: 0 };
  const excluded = { testMode: 0 }, unknownRevenue = { visit: 0, adjustment: 0 };
  for (const saved of list(rows).filter(plain)) {
    // Stripe test-mode data is never business data (the shared eligibility rule; unknown livemode is not test mode).
    if (!stripeEligibility({ livemode: saved.livemode, id: saved.subscriptionId || saved.id }).eligible) { excluded.testMode++; continue; }
    // A browser count not flagged yet reads as the open manual edit it is; a ledger out of step with Stripe knows nothing after that point.
    const row = accounts instanceof Map ? withLiveManualEdit(saved, accounts.get(saved.link?.accountJobId)) : saved, staleFrom = ledgerStaleFrom(row);
    const status = row.status, live = LIVE_MEMBERSHIP_STATUSES.includes(status), cancelledAt = row.churn?.at || row.cancelledAt || null;
    members.total++;
    if (status === 'active') members.active++; else if (status === 'past_due') { members.pastDue++; churn.atRiskPastDue++; } else if (status === 'pending') members.pending++; else if (status === 'cancelled') members.cancelled++;
    if (row.manualEdit?.status === 'open') gaps.manualEdits++;
    if (staleFrom !== Infinity) gaps.ledgerErrors++;
    if (inRange(row.startedAt)) members.started++;
    const start = memberStart(row), begun = start ? ms(start.at) : NaN, atStart = begun < from && !(ms(cancelledAt) < from);
    if (status !== 'pending' && !start) gaps.unknownStart++;
    if (atStart) { members.activeAtStart++; if (start.provisional) { members.activeAtStartProvisional++; gaps.provisionalStart++; } }
    if (status === 'cancelled' && inRange(cancelledAt)) {
      const kind = row.churn?.class === 'voluntary' || row.churn?.class === 'involuntary' ? row.churn.class : 'unknown';
      members.cancelledInPeriod++; churn[kind]++;
      // A member who joined in the period is outside the rate by definition; one whose start cannot be placed is a gap.
      if (atStart) { churn.ofActiveAtStart++; if (kind !== 'unknown') churned[kind]++; } else if (start && !start.provisional && begun >= from) churn.startedInPeriod++; else gaps.unknownChurnPopulation++;
    }
    if (status !== 'pending') {
      // Revenue-basis LTV to date: only members whose every payment the ledger recorded.
      const lifetime = cents(row.lifetimePaidCents);
      if (Number.isFinite(ms(row.startedAt)) && !row.preLedger && staleFrom === Infinity && row.lifetimePaidComplete === true && lifetime !== null && list(row.invoices).length < LEDGER_LIMITS.invoices) { revenue.memberLtv.members++; revenue.memberLtv.totalCents += lifetime; } else gaps.unknownLifetime++;
    }
    for (const invoice of list(row.invoices).filter(plain)) if (inRange(invoice.paidAt)) { const paid = cents(invoice.amountPaidCents); if (paid === null) gaps.unknownCash++; else revenue.subscriptionCashCents += paid; }
    const periods = list(row.periods).filter(plain);
    if (live && !openPeriod(periods)) {
      gaps.noLedger++;
      // A member recorded before the ledger still renews on its Stripe period end.
      if (inRange(row.currentPeriodEnd)) { renewals.due++; renewals.awaitingPayment++; }
    }
    // The ledger holds every visit this member used in the range only when each billing period overlapping the range held all of its visits,
    // and a live member has an open period at all (one recorded before FUN-20 has none until its renewal): otherwise the visits used and
    // their revenue are unknown, whether or not a period closes in the range (an untracked open year recognizes nothing the ledger can see).
    // A member the ledger did not follow from its start (recorded before FUN-20, or whose first ledger write failed) also used visits the
    // ledger never saw before its first ledger year: a range before that is unknown unless the member had cancelled before the range.
    const followed = Number.isFinite(ms(row.startedAt)) || (Boolean(row.ledgerVersion) && row.preLedger !== true);
    const ledgerFrom = Math.min(Infinity, ...periods.filter(period => !period.preLedger).map(periodStartMs).filter(Number.isFinite));
    const unseenBefore = !followed && (live || status === 'cancelled') && from < ledgerFrom && !(ms(cancelledAt) < from);
    // Once the ledger fell out of step with Stripe (a failed write, a missed renewal, an unclosed cancellation), a range ending after that point is unknown.
    if ((live && !openPeriod(periods)) || unseenBefore || staleFrom < to || periods.some(period => { const [start, end] = periodVisitSpan(period); return start < to && end > from && visitCountGap(period, row) !== null; })) gaps.unknownVisits++;
    // Visits a membership took with no open period (unallocatedVisits) are used visits whose revenue is unknown.
    for (const visit of [...periods.flatMap(period => list(period.visits)), ...list(row.unallocatedVisits)].filter(plain)) if (inRange(visit.usedAt)) { visits.knownUsedInPeriod++; const value = cents(visit.allocatedCents); if (value === null) { gaps.unknownAllocation++; unknownRevenue.visit++; } else revenue.visitRevenueCents += value; }
    for (const adjustment of [...periods.flatMap(period => list(period.adjustments)), ...list(row.visitAdjustments)].filter(plain)) if (inRange(adjustment.at)) { const value = cents(adjustment.recognizedCents); if (value === null) { gaps.unknownAllocation++; unknownRevenue.adjustment++; } else revenue.adjustmentRevenueCents += value; }
    for (const period of periods) {
      if (inRange(period.periodEnd)) { renewals.due++; if (period.status === 'open') renewals.awaitingPayment++; else if (period.closeReason === 'renewed') renewals.renewed++; else renewals.lapsed++; }
      const bucket = period.status === 'open' ? visits.openPeriods : period.status === 'closed' && inRange(period.closedAt) ? visits.closedPeriods : null;
      if (bucket) {
        bucket.count++;
        const used = count(period.visitsUsed);
        if (!Number.isInteger(period.visitsIncluded)) gaps.unknownIncluded++; else if (used === null) gaps.unknownUsed++;
        // The ledger's count means something only for a period whose visits it tracked throughout, with no browser count against it.
        else if (period.visitsTracked !== true) gaps.visitsUntracked++;
        // A closed period with member visits nobody counted when it closed (visits_unresolved) used more than its count says.
        else if (['manual_edit', 'visits_unresolved'].includes(period.breakageUnknown) || (period.status === 'open' && row.manualEdit?.status === 'open')) gaps.unknownUsed++;
        else { bucket.included += period.visitsIncluded; bucket.used += used; }
      }
      // A close after the ledger fell out of step may have closed the wrong year.
      if (period.status === 'closed' && inRange(period.closedAt)) { const value = ms(period.closedAt) >= staleFrom ? null : cents(period.breakageCents); if (value === null) gaps.unknownBreakage++; else revenue.breakageCents += value; }
    }
    // The close the ledger missed (the renewal or cancellation where it fell out of step) belongs to the range holding that point.
    if (staleFrom === -Infinity || (staleFrom >= from && staleFrom < to)) gaps.unknownBreakage++;
    if (live) {
      // membershipDeferred is unknown for a ledger out of step (its open period may be the wrong year), and so is the MRR read from that period.
      const deferred = membershipDeferred(row), monthly = staleFrom === Infinity ? monthlyCents(openPeriod(periods)) : null;
      if (deferred.known) revenue.deferredCents += deferred.cents; else gaps.unknownDeferred++;
      if (monthly === null) gaps.unknownMrr++; else revenue.mrrCents += monthly;
    }
  }
  const ratio = (part, whole) => whole > 0 ? Math.round(part / whole * 10000) / 10000 : null;
  Object.assign(churn, { rate: ratio(churn.ofActiveAtStart, members.activeAtStart), voluntaryRate: ratio(churned.voluntary, members.activeAtStart), involuntaryRate: ratio(churned.involuntary, members.activeAtStart) });
  renewals.rate = ratio(renewals.renewed, renewals.renewed + renewals.lapsed);
  for (const bucket of [visits.closedPeriods, visits.openPeriods]) bucket.utilization = ratio(bucket.used, bucket.included);
  visits.usedInPeriod = gaps.unknownVisits ? null : visits.knownUsedInPeriod;
  revenue.recognizedCents = revenue.visitRevenueCents + revenue.adjustmentRevenueCents + revenue.breakageCents;
  // Unknown is null, never a partial sum presented as the total (FUN-22 divides by recognizedCents).
  const unknownIn = { subscriptionCashCents: gaps.unknownCash, visitRevenueCents: unknownRevenue.visit + gaps.unknownVisits, adjustmentRevenueCents: unknownRevenue.adjustment, breakageCents: gaps.unknownBreakage, deferredCents: gaps.unknownDeferred, mrrCents: gaps.unknownMrr };
  unknownIn.recognizedCents = unknownIn.visitRevenueCents + unknownIn.adjustmentRevenueCents + unknownIn.breakageCents;
  revenue.knownCents = Object.fromEntries(Object.keys(unknownIn).map(key => [key, revenue[key]]));
  for (const key of Object.keys(unknownIn)) if (unknownIn[key] > 0) revenue[key] = null;
  revenue.memberLtv.averageCents = revenue.memberLtv.members ? Math.round(revenue.memberLtv.totalCents / revenue.memberLtv.members) : null;
  const reasons = Object.entries(gaps).filter(([, value]) => value > 0).map(([key]) => key);
  return { startAt, endAt, asOf, members, churn, renewals, visits, revenue, coverage: { complete: !reasons.length, reasons, counts: gaps, excluded } };
}
