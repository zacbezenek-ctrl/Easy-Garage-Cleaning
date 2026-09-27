import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields } from './firestore-job.js';
import { dispatchStorage } from './dispatch-storage.js';
import { requireDispatcher } from './dispatch-service.js';
import { PAYMENT_REVIEW_COLLECTION } from './customer-payments.js';

/**
 * Manager view of the Stripe items the webhook could not settle on its own:
 * payment_reviews/{sessionId} (confirmed crew charges held off the job) and
 * membership_reviews/{subscriptionId} (Garage Guard members without an exact
 * Hub customer link). Both collections are server-only; this read-only view
 * shows managers only what they already see on jobs and customers.
 */

const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
export const MEMBERSHIP_REVIEW_COLLECTION = 'membership_reviews';
export const REVIEW_LIST_LIMIT = 500;
const fail = (code, message, status = 503) => Object.assign(new Error(message), { code: 'stripe_review_' + code, status });
const text = (value, max = 200) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const count = value => Number.isInteger(value) ? value : null;
const jobId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(_egc_|secure_)/.test(value) ? value : '';
const newestFirst = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(a.id).localeCompare(String(b.id));

export function stripeReviewStorage(env, fetcher = firestoreFetch) {
  const store = dispatchStorage(env, fetcher);
  return {
    read: store.read,
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

// The crew return (or a later manager record) can put the same Stripe session
// on the job after it was held; showing that prevents applying it twice.
function recordedOnJob(job, sessionId) {
  return job?.payment?.verified === true && (Array.isArray(job.payment.stripeSessions) ? job.payment.stripeSessions : []).some(item => String(item?.sessionId || item) === sessionId);
}

function paymentReview(row, job) {
  const sessionId = text(row.sessionId, 200) || row.id;
  return {
    sessionId, jobId: text(row.jobId, 180), reason: text(row.reason, 60), status: text(row.status, 30),
    amountCents: count(row.amountCents), currency: text(row.currency, 3), paymentIntentId: text(row.paymentIntentId, 200), livemode: row.livemode === true,
    jobTotalCents: count(row.jobTotalCents), jobPaidCents: count(row.jobPaidCents), jobBalanceCents: count(row.jobBalanceCents),
    createdBy: text(row.createdBy, 80), recordedBy: text(row.recordedBy, 80), createdAt: text(row.createdAt, 40),
    customer: text(job?.customer, 200), jobFound: Boolean(job), recordedOnJob: recordedOnJob(job, sessionId),
  };
}

function membershipReview(row) {
  return {
    subscriptionId: text(row.subscriptionId, 200) || row.id, reason: text(row.reason, 60), status: text(row.status, 30), plan: text(row.plan, 20),
    candidateCustomerIds: (Array.isArray(row.candidateCustomerIds) ? row.candidateCustomerIds : []).map(id => text(id, 180)).filter(Boolean).slice(0, 20),
    customerName: text(row.customerName, 200), customerEmail: text(row.customerEmail, 254), phone: text(row.phone, 40), serviceAddress: text(row.serviceAddress, 1000),
    eventId: text(row.eventId, 200), createdAt: text(row.createdAt, 40), updatedAt: text(row.updatedAt, 40),
  };
}

/** Open Stripe reviews for managers. `now` is the injected read time (a Date). */
export async function stripeReviewOverview(store, actor, now = new Date()) {
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
  const membershipReviews = open(memberships.rows).map(membershipReview);
  return {
    ok: true, authority: 'employee_hub',
    counts: { paymentReviews: paymentReviews.length, membershipReviews: membershipReviews.length },
    paymentReviews, membershipReviews,
    coverage: { complete: payments.complete && memberships.complete, asOf: now.toISOString() },
  };
}
