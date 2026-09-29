import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields } from './firestore-job.js';
import { dispatchStorage } from './dispatch-storage.js';
import { requireDispatcher } from './dispatch-service.js';
import { isHubOwner } from './hub-session.js';
import { auditWrite } from './hub-audit.js';
import { preconditionFetcher } from './firestore-precondition.js';
import { CHECKOUT_KINDS, PAYMENT_REVIEW_COLLECTION, PORTAL_CHECKOUT_COLLECTION, STRIPE_API_VERSION, customerMoneyState, refundFollowUpId, stripeSecretKey } from './customer-payments.js';
import { membershipAccount, membershipStorage, mirrorPatch } from './garage-guard-membership.js';
import { manualCentsSince } from './money-ledger.js';

/**
 * Manager view of the Stripe items the webhook could not settle on its own:
 * payment_reviews/{sessionId} (confirmed charges held off the job: crew charges
 * the job could not take, any crew or portal charge Stripe shows refunded, and
 * tipped crew or portal charges paid after their job closed, or held for any
 * reason: a tipped charge is never booked automatically) and
 * membership_reviews/{subscriptionId} (Garage Guard members without an exact
 * Hub customer link). Both collections are server-only; this view shows
 * managers only what they already see on jobs and customers.
 *
 * resolveStripeReview closes one open review in ONE commit: the review (its
 * revision), any membership link and account-job display mirror, a create-only
 * stripe_review_operations/{requestId} receipt (sha256 of {actor,input}) and a
 * hub_audit entry. Nothing here charges, refunds or messages anyone: a refund is
 * made in Stripe and only recorded here once Stripe shows it. A resolved payment
 * review is final: recordStripeCheckout never puts its session on the job
 * afterwards. Recording a refund for a session already on the job needs the
 * owner's acknowledgement, because the job still counts that charge as paid;
 * recording a partial refund of a charge not on the job needs the owner to
 * acknowledge the exact amount kept, which then has to be recorded on the job
 * by hand. A charge Stripe shows refunded is settled by the owner only, and only
 * by recording the refund: payment.reconcile checks Stripe too (read-only) and
 * never closes a charge Stripe shows refunded, so neither the owner-only rule
 * nor the amount-kept acknowledgement depends on which button was used or on
 * whether a crew return happened to see the refund. Payment resolutions write
 * a marker (paymentReviewResolvedAt) on the job at the revision they read: a
 * crew return or webhook that puts the charge on the job first makes the save a
 * conflict, and one that read the job earlier and writes later fails its own
 * revision check, re-reads, and finds the review resolved. A test-mode charge
 * Stripe cannot show to the configured account (no key, or a live key, such as
 * a test-mode review after going live) can still be closed by the owner with
 * payment.reconcile, audited owner-only. A live-mode charge is never closed
 * without the Stripe check: only Stripe can say whether it was refunded and how
 * much was kept, so it stays refused for everyone until the live key is set. A
 * refund Stripe shows after a charge's review was closed, beyond what the last
 * closed review in its chain settled, arrives as a follow-up review,
 * payment_reviews/{sessionId}:refund (then {sessionId}:refund:2, :3 ... each
 * time the last one is closed and Stripe later shows more than it settled),
 * resolved the same way. A tipped charge (tipCents on its review) is resolved
 * here too, with the same rules: the queue shows its service part and crew tip
 * apart, and a partial refund's kept amount split into service and tip (by
 * default the refund is read as coming out of the service first, so a kept tip
 * is never recorded as a service payment; the owner may say the crew tip was
 * refunded first instead). Resolving a tipped portal charge also settles its
 * portal checkout ledger when it is marked held for that session, in the same
 * commit under the ledger's revision, so the customer's Pay button comes back.
 * That is why the service part kept from a partial refund of a tipped charge not
 * on the job is recorded on the job FIRST, while the review still holds Pay:
 * recording the refund is refused (409 stripe_review_kept_not_recorded) while the
 * payments a person recorded on the job by hand since the charge was held (its
 * hub_offline ledger entries recorded at or after the review's createdAt, never
 * the net paid total, so a payment corrected down meanwhile cannot trap the owner)
 * come to less than that service part and the job still shows a balance a new
 * checkout could charge. Marking such a charge reconciled needs its whole service
 * part recorded the same way, or the resolver's appliedElsewhere:true saying it
 * was applied to another job or settled outside the Hub (saved on the review and
 * in the audit); otherwise 409 stripe_review_service_not_recorded. A follow-up
 * review of a charge not on its job (its earlier close had the money kept recorded
 * on the job by hand, or applied elsewhere) is settled like one on the job: the
 * owner confirms the correction (jobPaymentAcknowledged, else 409
 * stripe_review_refund_settled_earlier) and records nothing more first.
 */

const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
export const MEMBERSHIP_REVIEW_COLLECTION = 'membership_reviews';
export const STRIPE_REVIEW_OPERATIONS = 'stripe_review_operations';
export const REVIEW_LIST_LIMIT = 500;
export const STRIPE_REVIEW_ACTIONS = Object.freeze(['payment.reconcile', 'payment.refund', 'membership.link', 'membership.dismiss']);
export const REFUND_REASONS = Object.freeze({ duplicate_charge: 'Duplicate charge', exceeds_balance: 'More than the job balance', customer_request: 'Customer asked for a refund', job_cancelled: 'Job cancelled', other: 'Other' });
export const DISMISS_REASONS = Object.freeze({ not_a_customer: 'Not a Hub customer yet', handled_elsewhere: 'Handled outside the Hub', duplicate_membership: 'Duplicate membership', other: 'Other' });
const COMMON = ['action', 'requestId', 'reviewId', 'expectedRevision', 'actorId'];
const FIELDS = { 'payment.reconcile': ['note', 'appliedElsewhere'], 'payment.refund': ['reason', 'note', 'jobPaymentAcknowledged', 'keptCentsAcknowledged', 'tipRefundedFirst'], 'membership.link': ['customerId'], 'membership.dismiss': ['reason', 'note'] };
const FINAL = new Set(['stripe_review_idempotency_conflict', 'stripe_review_changed_since_operation', 'stripe_review_actor_changed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_ID = /^cs_(?:test_|live_)?[A-Za-z0-9_]{1,160}$/, SUBSCRIPTION_ID = /^sub_[A-Za-z0-9_]{1,160}$/;
// A payment review is the checkout session's own ID, or one of its refund follow-ups ({sessionId}:refund, {sessionId}:refund:2 ...).
const PAYMENT_REVIEW_ID = /^cs_(?:test_|live_)?[A-Za-z0-9_]{1,160}(?::refund(?::(?:[2-9]|[1-9][0-9]))?)?$/;
const FOLLOW_UP = /^(.+):refund(?::([2-9]|[1-9][0-9]))?$/;
const fail = (code, message, status = 503, details) => Object.assign(new Error(message), { code: 'stripe_review_' + code, status, ...(details ? { details } : {}) });
const text = (value, max = 200) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const count = value => Number.isInteger(value) ? value : null;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(_egc_|secure_)/.test(value);
const jobId = value => safeId(value) ? value : '';
const newestFirst = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(a.id).localeCompare(String(b.id));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value ?? null);
const usd = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
// A review's crew tip in cents: 0 when it has none (untipped, or from before tips), null when it cannot be read.
const tipOf = row => row.tipCents === undefined ? 0 : count(row.tipCents) !== null && row.tipCents >= 0 ? row.tipCents : null;
const serviceOf = (amountCents, tipCents) => amountCents !== null && tipCents !== null && tipCents <= amountCents ? amountCents - tipCents : null;
/**
 * What a partial refund of a tipped charge left kept, split into service and tip. Stripe does not say which part it
 * refunded. By default the refund is read as coming out of the service first (the tip counted as kept first), so
 * recording keptServiceCents on the job never books a kept tip as a service payment. The owner, who made the refund,
 * may say the crew tip was refunded first instead (tipRefundedFirst, with refundedCents: what this refund took), for
 * example when the customer asked to drop the tip. tipBeforeCents is the tip still kept before this refund: the whole
 * tip, or what an earlier recorded refund on the same charge left (a follow-up review), so each refund is read on its
 * own. Untipped: nothing to split ({}); an unreadable tip or amount: both null.
 */
export function keptSplit(keptCents, tipCents, { tipRefundedFirst = false, refundedCents = null, tipBeforeCents = tipCents } = {}) {
  if (tipCents === 0) return {};
  const unknown = { keptServiceCents: null, keptTipCents: null };
  if (!Number.isSafeInteger(keptCents) || keptCents < 0 || tipCents === null) return unknown;
  const before = Number.isSafeInteger(tipBeforeCents) && tipBeforeCents >= 0 && tipBeforeCents <= tipCents ? tipBeforeCents : tipCents;
  if (!tipRefundedFirst) {
    const keptTipCents = Math.min(keptCents, before);
    return { keptServiceCents: keptCents - keptTipCents, keptTipCents };
  }
  if (!Number.isSafeInteger(refundedCents) || refundedCents < 0) return unknown;
  const keptTipCents = Math.max(0, before - refundedCents);
  return keptTipCents <= keptCents ? { keptServiceCents: keptCents - keptTipCents, keptTipCents } : unknown;
}
// The earlier recorded refund a follow-up review names, and the tip it left kept, when both can be read.
const priorOf = row => { const prior = count(row.priorRefundedCents), tip = count(row.priorKeptTipCents), service = count(row.priorKeptServiceCents);
  return prior !== null && prior > 0 ? { prior, ...(tip !== null && tip >= 0 && service !== null && service >= 0 ? { keptTipCents: tip, keptServiceCents: service } : {}) } : { prior: 0 }; };
/** A review's refund split under one reading: the refund beyond an earlier recorded one is applied to what that record kept. */
export function reviewKeptSplit(review, refundedCents, keptCents, tipRefundedFirst = false) {
  const tipCents = tipOf(review), prior = priorOf(review), stacked = prior.keptTipCents !== undefined && refundedCents >= prior.prior;
  return keptSplit(keptCents, tipCents, { tipRefundedFirst, refundedCents: stacked ? refundedCents - prior.prior : refundedCents, tipBeforeCents: stacked ? prior.keptTipCents : tipCents });
}
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
/** Refunds are money leaving the business: the owner (zacb, owner role, business access) records them. */
export const canRecordRefund = actor => isHubOwner(actor) && actor?.role === 'owner';

export function stripeReviewStorage(env, fetcher = firestoreFetch) {
  const fenced = preconditionFetcher(fetcher), store = dispatchStorage(env, fenced), members = membershipStorage(env, fenced);
  return {
    read: store.read, readMany: store.readMany, commit: store.commit, customerJobs: members.customerJobs,
    /** Up to `limit` documents; complete:false when more exist, never a silently short list. */
    async list(collection, limit = REVIEW_LIST_LIMIT) {
      const rows = [], ids = new Set(), tokens = new Set();
      let token = '';
      do {
        const url = new URL(`${BASE}/${collection}`);
        url.searchParams.set('pageSize', '300');
        if (token) url.searchParams.set('pageToken', token);
        let response;
        try { response = await fetcher(env, url, { signal: AbortSignal.timeout(20000) }); }
        catch { throw fail('storage_unavailable', 'Stripe reviews could not be loaded. Retry.'); }
        if (!response.ok) throw fail('storage_unavailable', 'Stripe reviews could not be loaded. Retry.');
        const page = await response.json().catch(() => null);
        if (!page || typeof page !== 'object' || Array.isArray(page) || (page.documents !== undefined && !Array.isArray(page.documents)) || (page.nextPageToken !== undefined && typeof page.nextPageToken !== 'string')) throw fail('storage_incomplete', 'Stripe reviews returned an incomplete page. Retry.');
        for (const document of page.documents || []) {
          const id = String(document?.name || '').split(`/documents/${collection}/`)[1] || '';
          if (!id || id.includes('/') || ids.has(id) || typeof document.updateTime !== 'string' || !document.updateTime) throw fail('storage_incomplete', 'A Stripe review had no verifiable identity. Retry.');
          ids.add(id); rows.push({ ...decodeFirestoreFields(document.fields || {}), id, revision: document.updateTime });
        }
        token = page.nextPageToken || '';
        if (token && tokens.has(token)) throw fail('storage_incomplete', 'Stripe review pagination did not finish. Retry.');
        tokens.add(token);
        if (token && rows.length >= limit) return { rows, complete: false };
      } while (token);
      return { rows, complete: true };
    },
  };
}

/**
 * Read-only Stripe lookup used to check a held charge (and any refund) before a review is resolved; null when Stripe is not
 * configured. Pinned to the customer-payment API version; its livemode says which mode the configured key reads.
 */
export function stripeReviewClient(env, fetcher = (...args) => fetch(...args)) {
  const secret = stripeSecretKey(env);
  if (!secret) return null;
  return Object.assign(async path => {
    let response;
    try { response = await fetcher(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Basic ${btoa(`${secret}:`)}`, 'Stripe-Version': STRIPE_API_VERSION }, signal: AbortSignal.timeout(15000) }); }
    catch { throw fail('stripe_unavailable', 'Stripe could not be reached to check this charge. Retry the same request.'); }
    const data = await response.json().catch(() => null);
    if (response.status === 404) throw fail('stripe_not_found', 'Stripe has no record of this checkout for the configured account. Check test or live mode.', 409);
    if (!response.ok || !plain(data)) throw fail('stripe_unavailable', 'Stripe could not confirm this charge. Retry the same request.');
    return data;
  }, { livemode: /^(?:sk|rk)_live_/.test(secret) });
}

// The crew return (or a later manager record) can put the same Stripe session
// on the job after it was held; showing that prevents applying it twice.
function recordedOnJob(job, sessionId) {
  return job?.payment?.verified === true && (Array.isArray(job.payment.stripeSessions) ? job.payment.stripeSessions : []).some(item => String(item?.sessionId || item) === sessionId);
}

// reviewId is what a resolution names: the session ID, or its refund follow-up ({sessionId}:refund, {sessionId}:refund:N).
// amountCents is everything Stripe charged. A tipped charge keeps tipCents beside it (absent means no tip, as before
// tips existed), so a manager settles the service part and the crew tip apart instead of one lump overcharge.
function paymentReview(row, job) {
  const sessionId = text(row.sessionId, 200) || row.id, amountCents = count(row.amountCents), refundedCents = count(row.refundedCents), priorRefundedCents = count(row.priorRefundedCents);
  const tipCents = tipOf(row), kept = amountCents === null ? null : Math.max(0, amountCents - (refundedCents || 0));
  return {
    sessionId, reviewId: text(row.id, 200), revision: text(row.revision, 80), jobId: text(row.jobId, 180), reason: text(row.reason, 60), status: text(row.status, 30),
    amountCents, tipCents, serviceCents: serviceOf(amountCents, tipCents),
    currency: text(row.currency, 3), paymentIntentId: text(row.paymentIntentId, 200), livemode: row.livemode === true,
    // What the crew return last saw refunded in Stripe (the owner's refund record checks Stripe again).
    ...(refundedCents !== null && refundedCents > 0 ? { refundedCents, keptCents: kept, ...reviewKeptSplit(row, refundedCents, kept), refundSeenAt: text(row.refundSeenAt, 40), heldReason: text(row.heldReason, 60) } : {}),
    // A follow-up after a smaller refund was recorded: what that earlier record settled (and, on a tipped charge, the
    // service part and tip it left kept, so the queue reads only the refund beyond it).
    ...(priorRefundedCents !== null && priorRefundedCents > 0 ? { priorRefundedCents, ...(tipCents > 0 && priorOf(row).keptTipCents !== undefined ? { priorKeptServiceCents: priorOf(row).keptServiceCents, priorKeptTipCents: priorOf(row).keptTipCents } : {}) } : {}),
    jobTotalCents: count(row.jobTotalCents), jobPaidCents: count(row.jobPaidCents), jobBalanceCents: count(row.jobBalanceCents),
    createdBy: text(row.createdBy, 80), recordedBy: text(row.recordedBy, 80), createdAt: text(row.createdAt, 40),
    customer: text(job?.customer, 200), jobFound: Boolean(job), recordedOnJob: recordedOnJob(job, sessionId),
  };
}

const candidateIds = row => (Array.isArray(row.candidateCustomerIds) ? row.candidateCustomerIds : []).map(id => text(id, 180)).filter(Boolean).slice(0, 20);
function membershipReview(row, customers = new Map()) {
  const ids = candidateIds(row);
  return {
    subscriptionId: text(row.subscriptionId, 200) || row.id, revision: text(row.revision, 80), reason: text(row.reason, 60), status: text(row.status, 30), plan: text(row.plan, 20),
    candidateCustomerIds: ids,
    candidates: ids.map(id => { const customer = customers.get(id); return { id, found: Boolean(customer), name: text(customer?.name || [customer?.firstName, customer?.lastName].filter(Boolean).join(' '), 200), phone: text(customer?.phone, 40), email: text(customer?.email, 254), address: text(customer?.address, 300) }; }),
    customerName: text(row.customerName, 200), customerEmail: text(row.customerEmail, 254), phone: text(row.phone, 40), serviceAddress: text(row.serviceAddress, 1000),
    eventId: text(row.eventId, 200), createdAt: text(row.createdAt, 40), updatedAt: text(row.updatedAt, 40),
  };
}

// Candidate customers are read in batches (one request per 100), never one read each.
async function candidateCustomers(store, rows) {
  const ids = [...new Set(rows.flatMap(candidateIds))].filter(safeId), found = new Map();
  const batch = typeof store.readMany === 'function' ? chunk => store.readMany('customers', chunk) : async chunk => (await Promise.all(chunk.map(id => store.read('customers', id)))).filter(Boolean);
  for (let index = 0; index < ids.length; index += 100) for (const customer of await batch(ids.slice(index, index + 100))) if (customer?.id && !customer.recordType) found.set(customer.id, customer);
  return found;
}

/** Open Stripe reviews for managers. `now` is the injected read time (a Date). */
export async function stripeReviewOverview(store, actor, now = new Date(), { checkoutBlock = false } = {}) {
  requireDispatcher(actor);
  const [payments, memberships] = await Promise.all([store.list(PAYMENT_REVIEW_COLLECTION), store.list(MEMBERSHIP_REVIEW_COLLECTION)]);
  const open = rows => rows.filter(row => row.status === 'open').sort(newestFirst);
  const jobs = new Map(), paymentReviews = [];
  for (const row of open(payments.rows)) {
    const id = jobId(row.jobId);
    if (id && !jobs.has(id)) jobs.set(id, store.read('jobs', id));
    // A job read failure fails the whole view (503); it is never shown as "not recorded".
    paymentReviews.push(paymentReview(row, id ? await jobs.get(id) : null));
  }
  const openMemberships = open(memberships.rows), customers = openMemberships.some(row => candidateIds(row).length) ? await candidateCustomers(store, openMemberships) : new Map();
  const membershipReviews = openMemberships.map(row => membershipReview(row, customers));
  return {
    ok: true, authority: 'employee_hub',
    counts: { paymentReviews: paymentReviews.length, membershipReviews: membershipReviews.length },
    paymentReviews, membershipReviews,
    viewer: { canRecordRefund: canRecordRefund(actor) }, checkoutBlock: checkoutBlock === true,
    reasons: { refund: REFUND_REASONS, dismiss: DISMISS_REASONS },
    coverage: { complete: payments.complete && memberships.complete, asOf: now.toISOString() },
  };
}

function note(value, { required = false, label = 'The note' } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw fail('invalid_field', `${label} must be text.`, 400);
  const cleaned = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim();
  if (cleaned.length > 500) throw fail('invalid_field', `${label} must be at most 500 characters.`, 400);
  if (required && cleaned.length < 3) throw fail('invalid_field', `${label} is required.`, 400);
  return cleaned;
}

function validate(input, actor) {
  if (!plain(input) || !STRIPE_REVIEW_ACTIONS.includes(input.action) || typeof input.requestId !== 'string' || !UUID.test(input.requestId)) throw fail('request_invalid', 'Use a supported review action with a unique request ID.', 400);
  const unknown = Object.keys(input).filter(key => !COMMON.includes(key) && !FIELDS[input.action].includes(key));
  if (unknown.length) throw fail('request_invalid', 'This request contains unsupported fields. Refresh and try again.', 400, { fields: unknown.slice(0, 10) });
  const payment = input.action.startsWith('payment.');
  if (typeof input.reviewId !== 'string' || !(payment ? PAYMENT_REVIEW_ID : SUBSCRIPTION_ID).test(input.reviewId)) throw fail('request_invalid', 'Choose a valid review.', 400);
  if (typeof input.expectedRevision !== 'string' || !input.expectedRevision || input.expectedRevision.length > 100) throw fail('request_invalid', 'Refresh the review queue before resolving this review.', 400);
  if (input.actorId !== undefined && String(input.actorId).trim().toLowerCase() !== String(actor.user).trim().toLowerCase()) throw fail('actor_changed', 'The signed-in employee changed. Sign in as the original employee to finish this request, or discard it.', 403);
  if (input.action === 'payment.refund' && !Object.hasOwn(REFUND_REASONS, input.reason)) throw fail('invalid_field', 'Choose why the charge was refunded.', 400);
  if (input.jobPaymentAcknowledged !== undefined && typeof input.jobPaymentAcknowledged !== 'boolean') throw fail('invalid_field', 'Confirm whether the job still counts this charge as paid.', 400);
  if (input.keptCentsAcknowledged !== undefined && (!Number.isSafeInteger(input.keptCentsAcknowledged) || input.keptCentsAcknowledged < 1)) throw fail('invalid_field', 'Confirm the amount the business kept from the partial refund.', 400);
  if (input.tipRefundedFirst !== undefined && typeof input.tipRefundedFirst !== 'boolean') throw fail('invalid_field', 'Say whether the crew tip was refunded first.', 400);
  if (input.appliedElsewhere !== undefined && typeof input.appliedElsewhere !== 'boolean') throw fail('invalid_field', 'Say whether the charge\'s service part was applied to another job or settled outside the Hub.', 400);
  if (input.action === 'membership.dismiss' && !Object.hasOwn(DISMISS_REASONS, input.reason)) throw fail('invalid_field', 'Choose why this member is not being linked.', 400);
  if (input.action === 'membership.link' && !safeId(input.customerId)) throw fail('invalid_field', 'Choose the customer to link.', 400);
  return payment ? PAYMENT_REVIEW_COLLECTION : MEMBERSHIP_REVIEW_COLLECTION;
}

// The Stripe checkout a payment review holds: its own ID, or the charge its
// refund follow-up ({sessionId}:refund or {sessionId}:refund:N) is about, which
// the review also names.
function heldSession(review) {
  const id = String(review.id || ''), named = review.sessionId === undefined ? id : String(review.sessionId), followUp = FOLLOW_UP.exec(id);
  if (SESSION_ID.test(named) && (id === named || (followUp && followUp[1] === named && id === refundFollowUpId(named, followUp[2] ? Number(followUp[2]) : 1)))) return named;
  throw fail('stripe_mismatch', 'This review does not name the Stripe charge it holds. Nothing was saved.', 409);
}

// What Stripe shows refunded on the checkout this review holds (refundedCents 0
// when nothing is). Missing configuration is not retryable: the same request
// cannot succeed until STRIPE_SECRET_KEY is set.
async function stripeCharge(stripe, review, what = 'the refund cannot be confirmed') {
  if (!stripe) throw fail('stripe_unconfigured', `Stripe is not configured, so ${what}. Nothing was saved. Ask the owner to set the Stripe key, then try again.`, 409);
  const sessionId = heldSession(review), session = await stripe(`checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent.latest_charge`);
  const charge = plain(session.payment_intent?.latest_charge) ? session.payment_intent.latest_charge : null;
  if (session.id !== sessionId || (session.metadata?.job_id || session.client_reference_id) !== review.jobId || session.amount_total !== review.amountCents || (session.livemode === true) !== (review.livemode === true) || !charge) throw fail('stripe_mismatch', 'Stripe returned a different charge than the one held for review. Nothing was saved.', 409);
  const refundedCents = Number.isSafeInteger(charge.amount_refunded) && charge.amount_refunded > 0 ? Math.min(charge.amount_refunded, review.amountCents) : charge.refunded === true ? review.amountCents : 0;
  const full = refundedCents > 0 && (charge.refunded === true || refundedCents >= review.amountCents);
  return { refundedCents, full, keptCents: full ? 0 : review.amountCents - refundedCents };
}
// The checkout this review holds, refunded (fully or partly) in Stripe.
async function verifiedRefund(stripe, review) {
  let refund;
  try { refund = await stripeCharge(stripe, review); }
  catch (error) { throw liveCharge(review) ? liveUnchecked(error, stripe) : error; }
  if (refund.refundedCents <= 0) throw fail('refund_not_found', 'Stripe does not show a refund for this charge yet. Refund it in the Stripe dashboard first, then record it here.', 409);
  return refund;
}

function snapshot(review) {
  const keys = ['status', 'reason', 'resolution', 'amountCents', 'tipCents', 'jobId', 'plan', 'candidateCustomerIds', 'refundReason', 'refundedCents', 'refundFull', 'keptCents', 'keptServiceCents', 'keptTipCents', 'tipRefundedFirst', 'recordedOnJobAtResolution', 'settledEarlierAtResolution', 'serviceAppliedElsewhere', 'stripeCheck', 'linkedCustomerId', 'linkedJobId', 'dismissReason'];
  return Object.fromEntries(keys.filter(key => review[key] !== undefined).map(key => [key, review[key]]));
}

/** The resolved review as the Hub shows it; refund notes only to the owner. */
function resolvedView(review, actor) {
  const payment = Boolean(review.sessionId) || SESSION_ID.test(review.id || '');
  return {
    id: review.id, kind: payment ? 'payment' : 'membership', revision: text(review.revision, 80), status: text(review.status, 30), resolution: text(review.resolution, 30),
    resolvedAt: text(review.resolvedAt, 40), resolvedBy: text(review.resolvedBy, 80), note: review.resolution === 'refunded' && !canRecordRefund(actor) ? '' : text(review.resolutionNote, 500),
    ...(payment ? { jobId: text(review.jobId, 180), amountCents: count(review.amountCents), refundReason: text(review.refundReason, 40), refundedCents: count(review.refundedCents), refundFull: review.refundFull === true, keptCents: count(review.keptCents), recordedOnJobAtResolution: review.recordedOnJobAtResolution === true, ...(review.settledEarlierAtResolution === true ? { settledEarlierAtResolution: true } : {}), ...(review.serviceAppliedElsewhere === true ? { serviceAppliedElsewhere: true } : {}), ...(review.stripeCheck ? { stripeCheck: text(review.stripeCheck, 30) } : {}),
      ...(tipOf(review) !== 0 ? { tipCents: tipOf(review), ...(review.keptServiceCents !== undefined || review.keptTipCents !== undefined ? { keptServiceCents: count(review.keptServiceCents), keptTipCents: count(review.keptTipCents) } : {}), ...(review.tipRefundedFirst === true ? { tipRefundedFirst: true } : {}) } : {}) }
      : { linkedCustomerId: text(review.linkedCustomerId, 180), linkedJobId: text(review.linkedJobId, 180), dismissReason: text(review.dismissReason, 40) }),
  };
}

const heldJob = async (store, review) => safeId(review.jobId) ? store.read('jobs', review.jobId) : null;
// A marker written on the job at the revision this resolution read. Whether the
// charge is on the job (and the acknowledgement that depends on it) cannot
// change unseen: a crew return or webhook that puts it on the job first makes
// this save a conflict, and one that read the job earlier and writes after this
// save fails its own revision check, re-reads, and finds the review resolved.
// Nothing about the job's money changes.
const jobMark = (job, now) => job?.id && job.revision ? [{ collection: 'jobs', id: job.id, revision: job.revision, patch: { paymentReviewResolvedAt: now } }] : [];
const OWNER_REFUND = 'Stripe shows a refund on this charge, so only the owner can settle it, by recording the refund.';
// A live-mode charge: the review says so, or its checkout ID does.
const liveCharge = review => review.livemode === true || /^cs_live_/.test(String(review.sessionId ?? review.id ?? ''));
// Why Stripe cannot show this review's TEST-MODE charge to the configured
// account, or '' when the owner may not close it without the check: no key at
// all ('unconfigured'), or a 404 from a live key ('other_mode', a test-mode
// review after switching to sk_live_). A live-mode charge is never closed
// unchecked (only Stripe can say whether it was refunded and how much was
// kept), and a 404 in the charge's own mode stays an error for everyone.
function unseenCharge(error, stripe, review) {
  if (liveCharge(review)) return '';
  if (error?.code === 'stripe_review_stripe_unconfigured' && !stripe) return 'unconfigured';
  if (error?.code === 'stripe_review_stripe_not_found' && stripe?.livemode === true) return 'other_mode';
  return '';
}
// A live-mode charge the Hub cannot check: say what to fix, keeping the error's code and status.
function liveUnchecked(error, stripe) {
  if (error?.code === 'stripe_review_stripe_unconfigured') return fail('stripe_unconfigured', 'This is a live-mode charge and Stripe is not configured, so it cannot be checked or closed yet. Nothing was saved. Set the live Stripe key (STRIPE_SECRET_KEY), then try again.', error.status);
  if (error?.code === 'stripe_review_stripe_not_found' && stripe?.livemode === false) return fail('stripe_not_found', 'This is a live-mode charge, and the Hub\'s Stripe key is a test key, so it cannot be checked or closed yet. Nothing was saved. Set the live Stripe key (STRIPE_SECRET_KEY), then try again.', error.status);
  return error;
}
// What the owner records on the job before confirming a partial refund of a charge not on the job. An untipped charge's
// whole kept amount; a tipped charge's service part only, which depends on which part the owner refunded.
function keptFirst(review, refund) {
  const tipCents = tipOf(review);
  if (tipCents === 0) return `Record the ${usd(refund.keptCents)} kept on the job under Estimates & payments first, then confirm it here.`;
  const service = reviewKeptSplit(review, refund.refundedCents, refund.keptCents), tip = reviewKeptSplit(review, refund.refundedCents, refund.keptCents, true);
  if (!Number.isSafeInteger(service.keptServiceCents) || !Number.isSafeInteger(tip.keptServiceCents)) return 'Its split between service and the crew tip cannot be read: check the charge in Stripe, record only its service part on the job under Estimates & payments first, then confirm it here.';
  const amounts = service.keptServiceCents === tip.keptServiceCents ? `its ${usd(service.keptServiceCents)} service part on the job under Estimates & payments` : `its service part on the job under Estimates & payments (${usd(service.keptServiceCents)} if the refund came out of the service first, or ${usd(tip.keptServiceCents)} if the crew tip was refunded first)`;
  return `Up to ${usd(service.keptTipCents)} of it is the crew tip, which is never a service payment. First record ${amounts}, then confirm the amount kept here and say which part was refunded.`;
}
// A follow-up review ({sessionId}:refund, {sessionId}:refund:N): an earlier review of the same charge was closed.
const followUp = review => FOLLOW_UP.test(String(review?.id || ''));
/**
 * Service money a person recorded on the job by hand (Estimates & payments: the job's hub_offline ledger entries) since
 * the charge was held: entries recorded at or after review.createdAt, less any the job already had when it was held
 * (review.jobLedgerIds). Never the job's net paid total, so a payment corrected down while the review is open cannot
 * hide money recorded since, and never a card payment, gift credit or tip. 0 when the hold time cannot be read.
 */
export const serviceRecordedSince = (job, review) => manualCentsSince(job, review?.createdAt, review?.jobLedgerIds);
// The service part a tipped charge not on its job leaves with the business (kept from a partial refund, or the whole
// service part when it is reconciled) must be on the job before its review closes, while a new checkout could still
// charge the job's balance: a person must have recorded at least that much on the job since the charge was held
// (serviceRecordedSince). Null when nothing is missing: no service part, the job was not found, or no balance is left for
// a checkout to charge (more than the balance cannot be recorded, so the owner is never stuck). The resolve commit marks
// the job at the revision read here, so a payment changed meanwhile is a revision conflict.
function keptServiceMissing(job, review, keptServiceCents) {
  if (!job || !(Number.isSafeInteger(keptServiceCents) && keptServiceCents > 0)) return null;
  const finance = customerMoneyState(job), balanceCents = Math.round(finance.balance * 100);
  if (balanceCents <= 0) return null;
  const recordedSinceCents = serviceRecordedSince(job, review);
  if (recordedSinceCents >= keptServiceCents) return null;
  return { keptServiceCents, recordedSinceCents, heldAt: text(review.createdAt, 40), ...(count(review.jobPaidCents) !== null ? { jobPaidCentsWhenHeld: review.jobPaidCents } : {}), jobPaidCents: Math.round(finance.paid * 100), jobBalanceCents: balanceCents };
}
// Marking a tipped charge that is not on its job reconciled closes its review, which gives the customer's Pay button (and
// the crew card link) back for whatever balance the job shows. Its service part must be on the job first, measured as
// for a partial refund (keptServiceMissing), unless the person resolving it says it was applied to another job or settled
// outside the Hub (appliedElsewhere, saved on the review and in the audit). A follow-up review is exempt: the earlier
// close in its chain already settled where the charge's money went. A tip or service part that cannot be read counts as
// missing while the job shows a balance.
function serviceNotRecorded(job, review, onJob) {
  const tipCents = tipOf(review);
  if (onJob || tipCents === 0 || followUp(review) || !job) return null;
  const serviceCents = serviceOf(count(review.amountCents), tipCents);
  if (serviceCents !== null) return keptServiceMissing(job, review, serviceCents);
  const balanceCents = Math.round(customerMoneyState(job).balance * 100);
  return balanceCents > 0 ? { keptServiceCents: null, recordedSinceCents: serviceRecordedSince(job, review), jobBalanceCents: balanceCents } : null;
}
// The owner-facing refusal for serviceNotRecorded.
function serviceFirst(review, missing) {
  const tipCents = tipOf(review), service = Number.isSafeInteger(missing.keptServiceCents) ? `its ${usd(missing.keptServiceCents)} service part` : 'its service part';
  // Kept under 300 characters, which the Hub shows in full.
  return fail('service_not_recorded', `Not on the job: closing this review lets the job's ${usd(missing.jobBalanceCents)} balance be paid again. First record ${service} under Estimates & payments${tipCents > 0 ? ` (never the ${usd(tipCents)} tip)` : ''}; ${usd(missing.recordedSinceCents)} recorded since the hold. Or tick that it went to another job or outside the Hub. Nothing was saved.`, 409,
    { amountCents: count(review.amountCents), tipCents, serviceCents: missing.keptServiceCents, recordedSinceCents: missing.recordedSinceCents, jobBalanceCents: missing.jobBalanceCents });
}
const PLANS = {
  async 'payment.reconcile'({ store, review, input, actor, stripe, now }) {
    // A refund is the owner's to record (checked against Stripe, owner-only note and audit), never a business-visible reconcile.
    const owner = canRecordRefund(actor);
    if (review.reason === 'payment_refunded' && !owner) throw fail('owner_required', OWNER_REFUND, 403);
    const job = await heldJob(store, review), onJob = recordedOnJob(job, heldSession(review));
    const comment = note(input.note, { required: !onJob, label: onJob ? 'The note' : 'A note on how this charge was reconciled' });
    // A tipped charge not on its job: its service part is on the job, or the resolver says it went elsewhere. Checked
    // once Stripe shows no refund (a refund is recorded, never reconciled), on the job read here, which the resolve
    // commit marks at this revision.
    const elsewhere = () => {
      const missing = serviceNotRecorded(job, review, onJob);
      if (!missing) return {};
      if (input.appliedElsewhere !== true) throw serviceFirst(review, missing);
      return { serviceAppliedElsewhere: true };
    };
    const saying = applied => applied.serviceAppliedElsewhere ? ' (its service part is not on this job: applied to another job or settled outside the Hub)' : '';
    // What Stripe shows now decides who may close it, never the queue's last view:
    // a refund the Hub has not seen yet is caught here too.
    let refund;
    try { refund = await stripeCharge(stripe, review, 'this charge cannot be checked'); }
    catch (error) {
      const unseen = unseenCharge(error, stripe, review);
      if (!unseen) throw liveCharge(review) ? liveUnchecked(error, stripe) : error;
      // A test-mode charge Stripe has no record of for this account cannot be checked:
      // only the owner closes it, with an owner-only audit; managers stay refused.
      if (!owner) throw fail(error.code.slice('stripe_review_'.length), `${error.message} Only the owner can close it without a Stripe check.`, error.status);
      const applied = elsewhere();
      return { patch: { resolution: 'reconciled', resolutionNote: comment, recordedOnJobAtResolution: onJob, stripeCheck: unseen, ...applied }, reason: `Stripe has no record for the configured account${comment ? `: ${comment}` : ''}${saying(applied)}`, visibility: 'owner', marks: jobMark(job, now) };
    }
    if (refund.refundedCents > 0) {
      if (!owner) throw fail('owner_required', OWNER_REFUND, 403);
      // The owner records it as a refund, which confirms the amount kept (or the job correction); it is never reconciled.
      const shown = refund.full ? `the full ${usd(review.amountCents)}` : `${usd(refund.refundedCents)} of ${usd(review.amountCents)}`;
      throw fail('refund_shown', `Stripe shows ${shown} refunded, so this charge is settled by recording the refund, not by marking it reconciled. Use Record refund${onJob ? ', which confirms the job correction' : refund.full ? '' : `, which confirms the ${usd(refund.keptCents)} kept`}. Nothing was saved.`, 409,
        { amountCents: review.amountCents, refundedCents: refund.refundedCents, keptCents: refund.keptCents, ...(refund.full ? {} : reviewKeptSplit(review, refund.refundedCents, refund.keptCents)), recordedOnJob: onJob });
    }
    const applied = elsewhere();
    // The owner's exit for a charge flagged refunded that Stripe no longer shows refunded (the refund failed or was reversed).
    const exit = review.reason === 'payment_refunded', why = exit ? `Stripe no longer shows a refund${comment ? `: ${comment}` : ''}` : comment;
    return { patch: { resolution: 'reconciled', resolutionNote: comment, recordedOnJobAtResolution: onJob, ...applied }, reason: `${why}${saying(applied)}` || null, ...(exit ? { visibility: 'owner' } : {}), marks: jobMark(job, now) };
  },
  async 'payment.refund'({ store, review, input, actor, stripe, now }) {
    if (!canRecordRefund(actor)) throw fail('owner_required', 'Only the owner can record a refund.', 403);
    const comment = note(input.note), job = await heldJob(store, review), onJob = recordedOnJob(job, heldSession(review));
    // Recording the refund never changes the job, which still counts a charge already on it as paid.
    if (onJob && input.jobPaymentAcknowledged !== true) throw fail('refund_on_job', 'This charge is already counted as paid on the job, and recording the refund here does not change the job. Confirm that you will correct the job\'s payment, then record the refund.', 409, { recordedOnJob: true });
    // A follow-up of a charge not on its job: the earlier close in its chain already settled what the charge kept (the
    // money kept recorded on the job by hand, or the charge applied elsewhere), so this further refund is corrected where
    // that money was put, exactly like a charge on the job; nothing more is recorded on the job first.
    const settledEarlier = !onJob && followUp(review);
    if (settledEarlier && input.jobPaymentAcknowledged !== true) throw fail('refund_settled_earlier', 'This charge is not on the job, but an earlier review of it was closed, so the money it kept was recorded on the job by hand or applied to another job. Recording this further refund here changes neither. Confirm that you will correct that payment, then record the refund.', 409, { recordedOnJob: false, settledEarlier: true });
    const counted = onJob || settledEarlier;
    const refund = await verifiedRefund(stripe, review), tipCents = tipOf(review), tipFirst = input.tipRefundedFirst === true && tipCents > 0;
    // A tipped charge's kept money is split under the owner's reading (the service first unless they say the crew tip was refunded first).
    const split = reviewKeptSplit(review, refund.refundedCents, refund.keptCents, tipFirst), amounts = { amountCents: review.amountCents, refundedCents: refund.refundedCents, keptCents: refund.keptCents, ...split };
    const shown = refund.full ? '' : `Stripe shows ${usd(refund.refundedCents)} of ${usd(review.amountCents)} refunded; `;
    // A partial refund closes the review for good, and the money kept is on no job: it is recorded on the job FIRST (the
    // review still holds the customer's Pay button), then the owner confirms the exact amount kept here. A tipped charge's
    // kept money is split so the kept tip is never recorded on the job as a service payment.
    if (!refund.full && !counted && input.keptCentsAcknowledged !== refund.keptCents) throw fail('refund_partial', `Stripe shows ${usd(refund.refundedCents)} of ${usd(review.amountCents)} refunded. The ${usd(refund.keptCents)} kept is not on the job, and recording this refund closes the review for good. ${keptFirst(review, refund)}`, 409, amounts);
    // Before a tipped charge's review closes (which gives the customer Pay back), the service part kept must already be
    // on the job: otherwise Pay would ask for the balance that money already paid.
    const missing = !refund.full && !counted && tipCents > 0 ? keptServiceMissing(job, review, split.keptServiceCents) : null;
    if (missing) throw fail('kept_not_recorded', `Record the ${usd(missing.keptServiceCents)} service part kept on the job under Estimates & payments first${tipFirst ? ' (the crew tip was refunded first)' : ''}: the job's payments have grown by ${usd(missing.recordedSinceCents)} since this charge was held, so the customer's Pay button would ask again for money this charge already paid. Then record the refund. Nothing was saved.`, 409, { ...amounts, ...missing });
    const kept = !refund.full && tipCents > 0 && Number.isSafeInteger(split.keptServiceCents) ? `kept: ${usd(split.keptServiceCents)} service, ${usd(split.keptTipCents)} crew tip${tipFirst ? ', the tip refunded first' : ''}` : '';
    const where = onJob ? ` (${shown}${kept ? `${kept}; ` : ''}the job still counts this charge as paid)`
      : settledEarlier ? ` (${shown}${kept ? `${kept}; ` : ''}an earlier review of this charge was closed: what it kept is on the job, recorded by hand, or on another job)`
        : refund.full ? '' : ` (${shown}${kept || `the ${usd(refund.keptCents)} kept is not on the job`})`;
    // Refund notes and the audit reason are owner-only.
    return {
      patch: { resolution: 'refunded', refundReason: input.reason, resolutionNote: comment, refundedCents: refund.refundedCents, refundFull: refund.full, keptCents: refund.keptCents, ...(refund.full ? {} : split), ...(!refund.full && tipFirst ? { tipRefundedFirst: true } : {}), recordedOnJobAtResolution: onJob, ...(settledEarlier ? { settledEarlierAtResolution: true } : {}) },
      reason: `${REFUND_REASONS[input.reason]}${comment ? `: ${comment}` : ''}${where}`, visibility: 'owner', marks: jobMark(job, now),
    };
  },
  async 'membership.link'({ store, review, input, actor, now }) {
    if (!candidateIds(review).includes(input.customerId)) throw fail('customer_not_candidate', 'Choose one of the customers this member matched.', 400);
    const [membership, customer] = await Promise.all([store.read('memberships', review.id), store.read('customers', input.customerId)]);
    if (!membership?.revision || membership.link?.status !== 'needs_review') throw fail('membership_changed', 'This membership changed since it was flagged. Refresh the review queue.', 409);
    if (!customer?.revision || customer.recordType) throw fail('customer_not_found', 'That customer could not be found. Refresh the review queue.', 404);
    const fences = [{ collection: 'customers', id: customer.id, revision: customer.revision, verify: true }];
    let account;
    try { account = await membershipAccount(store, membership, customer.id, 'manager', fences, now); }
    catch (error) { if (error.code === 'garage_guard_account_changed') throw fail('revision_conflict', 'The customer account changed while linking. Refresh and try again.', 409); throw error; }
    if (account.review) throw fail('link_blocked', 'This customer account cannot take the membership yet. Fix the account in the Hub or dismiss the review.', 409, { reason: account.review.reason });
    const next = { ...membership, link: { ...account.link, linkedBy: String(actor.user).toLowerCase() } };
    const mirror = mirrorPatch(account.job, next, false, now);
    if (mirror) next.link.mirroredAt = now;
    const writes = [{ collection: 'memberships', id: membership.id, revision: membership.revision, patch: { link: next.link, updatedAt: now } }];
    if (mirror) writes.push({ collection: 'jobs', id: account.job.id, revision: account.job.revision, patch: { ...mirror, garageGuard: { ...mirror.garageGuard, updatedBy: String(actor.user).toLowerCase() } } });
    return { patch: { resolution: 'linked', linkedCustomerId: customer.id, linkedJobId: account.job.id }, writes, fences: account.fences };
  },
  async 'membership.dismiss'({ store, review, input, actor, now }) {
    const comment = note(input.note, { required: input.reason === 'other' }), membership = await store.read('memberships', review.id), writes = [];
    // A dismissed link stays with the manager: later events never re-open or re-guess it.
    if (membership?.revision && membership.link?.status === 'needs_review') writes.push({ collection: 'memberships', id: membership.id, revision: membership.revision, patch: { link: { status: 'dismissed', reason: input.reason, dismissedAt: now, dismissedBy: String(actor.user).toLowerCase(), reviewReason: text(membership.link.reason, 60) }, updatedAt: now } });
    else if (membership && membership.link?.status !== 'dismissed') throw fail('membership_changed', 'This membership changed since it was flagged. Refresh the review queue.', 409);
    return { patch: { resolution: 'dismissed', dismissReason: input.reason, resolutionNote: comment }, reason: `${DISMISS_REASONS[input.reason]}${comment ? `: ${comment}` : ''}`, writes };
  },
};

// A tipped portal charge held for a person marks the job's portal checkout ledger
// 'held' for its session (customer-payments markLedgerHeld). Resolving that review
// settles the mark in the same commit, under the ledger's revision, so the
// customer's Pay button comes back; the held charge itself is never booked. Only
// a tipped portal review reads the ledger, so every other resolution is unchanged.
async function releaseHeldCheckout(store, review, now) {
  if (review.kind !== CHECKOUT_KINDS.portal || !(tipOf(review) > 0) || !safeId(review.jobId)) return [];
  const sessionId = heldSession(review), ledger = await store.read(PORTAL_CHECKOUT_COLLECTION, review.jobId);
  if (!ledger?.revision || ledger.status !== 'held' || ledger.sessionId !== sessionId) return [];
  return [{ collection: PORTAL_CHECKOUT_COLLECTION, id: review.jobId, revision: ledger.revision, patch: { status: 'settled', settledAt: now, settledBy: 'review_resolved' } }];
}

async function execute(store, actor, input, collection, now, fingerprint, receiptId, stripe) {
  const review = await store.read(collection, input.reviewId);
  if (!review) throw fail('not_found', 'This review no longer exists. Refresh the review queue.', 404);
  if (review.status !== 'open') throw fail('already_resolved', 'This review was already resolved. Refresh the review queue.', 409, { resolution: text(review.resolution, 30) });
  if (review.revision !== input.expectedRevision) throw fail('revision_conflict', 'This review changed after you opened it. Refresh and review it again.', 409);
  const plan = await PLANS[input.action]({ store, review, input, actor, now, stripe });
  const released = collection === PAYMENT_REVIEW_COLLECTION ? await releaseHeldCheckout(store, review, now) : [];
  const actorId = String(actor.user).toLowerCase(), patch = { ...plan.patch, status: 'resolved', resolvedAt: now, resolvedBy: actorId, resolveRequestId: input.requestId, updatedAt: now };
  const audit = auditWrite({ actor: { id: actorId, kind: 'human', role: actor.role }, via: actor.via === 'mcp' ? 'mcp' : 'hub', action: `stripe_review.${input.action}`, entity: { collection, id: review.id }, before: snapshot(review), after: snapshot({ ...review, ...patch }), requestId: input.requestId, reason: plan.reason ?? null, visibility: plan.visibility || 'business', now });
  const writes = [{ collection, id: review.id, revision: review.revision, patch }, ...(plan.writes || []), ...released];
  const targets = new Set(writes.map(write => `${write.collection}/${write.id}`));
  for (const fence of plan.fences || []) if (!targets.has(`${fence.collection}/${fence.id}`)) { targets.add(`${fence.collection}/${fence.id}`); writes.push(fence); }
  const marks = (plan.marks || []).filter(mark => !targets.has(`${mark.collection}/${mark.id}`));
  await store.commit([...writes,
    { collection: STRIPE_REVIEW_OPERATIONS, id: receiptId, patch: { fingerprint, actorId, action: input.action, reviewCollection: collection, reviewId: review.id, requestId: input.requestId, auditId: audit.id, createdAt: now } },
    audit, ...marks]);
  const saved = await store.read(collection, review.id);
  if (!saved) throw fail('outcome_unknown', 'The resolved review could not be read back. Retry the same request.');
  if (saved.resolveRequestId !== input.requestId) throw fail('changed_since_operation', 'The review was saved, but it has changed again. Refresh the review queue.', 409);
  return saved;
}

/** Resolve one open payment or membership review. `now` is an ISO string; `stripe` is stripeReviewClient(env) or a fake. */
export async function resolveStripeReview(store, actor, input, now = new Date().toISOString(), { stripe = null } = {}) {
  requireDispatcher(actor);
  const collection = validate(input, actor), actorId = String(actor.user).toLowerCase();
  const fingerprint = await digest({ actor: actorId, input }), receiptId = input.requestId.toLowerCase();
  const result = (review, replayed) => ({ ok: true, authority: 'employee_hub', requestId: input.requestId, action: input.action, replayed, review: resolvedView(review, actor) });
  async function replay(replayed) {
    const receipt = await store.read(STRIPE_REVIEW_OPERATIONS, receiptId);
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint || receipt.actorId !== actorId) throw fail('idempotency_conflict', 'This request ID was already used for a different review change. Refresh before trying again.', 409);
    const review = await store.read(receipt.reviewCollection, receipt.reviewId);
    if (!review || review.resolveRequestId !== input.requestId) throw fail('changed_since_operation', 'That review change was saved, but the review has changed since. Refresh the review queue.', 409);
    return result(review, replayed);
  }
  const prior = await replay(true);
  if (prior) return prior;
  try { return result(await execute(store, actor, input, collection, now, fingerprint, receiptId, stripe), false); }
  catch (error) {
    if (FINAL.has(error.code)) throw error;
    // A lost commit response (or a racing copy of this request) may have saved: the receipt is the proof.
    const recovered = await replay(false).catch(replayError => { if (FINAL.has(replayError.code)) throw replayError; return null; });
    if (recovered) return recovered;
    throw error;
  }
}
