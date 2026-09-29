import { firestoreFetch } from './firebase-service-account.js';
import { readJob, patchJob, encodeFirestoreFields, decodeFirestoreFields } from './firestore-job.js';
import { billedChangeCents } from './change-orders.js';
import { unsentQuoteDraft } from './quote-model.js';

const DB = 'https://firestore.googleapis.com/v1/projects/egcw-1ec83/databases/(default)/documents';
const clean = (value, limit = 180) => String(value || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, limit);
const cents = value => {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : 0;
};
const failure = (message, status = 409, code = '') => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
const knownSession = (job, sessionId) => job.payment?.verified === true && (job.payment?.stripeSessions || []).some(item => String(item?.sessionId || item) === sessionId);
const RECEIPT_URL = /^https:\/\/pay\.stripe\.com\/receipts\//;
export const CHECKOUT_KINDS = Object.freeze({ portal: 'egc_customer_portal_payment', crew: 'egc_job_payment' });

// Tolerant env read shared by every Stripe payment endpoint. Restricted keys
// (rk_) are accepted alongside secret keys; publishable keys never are.
export function stripeSecretKey(env = {}) {
  const wanted = ['STRIPE_SECRET_KEY', 'STRIPE_SECRET', 'STRIPE_KEY'].map(key => key.toLowerCase().replace(/[^a-z0-9]/g, ''));
  let key = env.STRIPE_SECRET_KEY ? String(env.STRIPE_SECRET_KEY) : '';
  for (const [name, value] of Object.entries(env || {})) if (!key && value && wanted.includes(name.toLowerCase().replace(/[^a-z0-9]/g, ''))) key = String(value);
  key = key.trim();
  return /^(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]+$/.test(key) ? key : '';
}

export function customerPaymentNeedsReview(job) {
  const paid = customerMoneyState(job).paid;
  if (paid <= 0 || job.payment?.verified === true) return false;
  if (job.payment?.amount != null) return true;
  return !(job.deposit?.verified === true && cents(job.deposit.paidAmount) >= cents(paid));
}

// Crew can update an unpaid invoice during closeout, but cannot edit these
// protected quote fields. An invoice never authorizes a larger card charge.
const quoteCents = job => cents(job.estimate?.amount ?? job.total ?? job.priceQuoted ?? job.lockedTotal ?? job.rate ?? job.customerApproval?.amount);

/** The quote the customer signs, without approved change orders (what the estimate card shows and an approval binds to). */
export function customerQuoteTotal(job) {
  return quoteCents(job) / 100;
}

export function customerMoneyState(job) {
  // Change-order lines billed from portal approvals (change-orders.js) are owed on top of the quote.
  const totalCents = quoteCents(job) + billedChangeCents(job);
  const paidCents = cents(job.payment?.amount ?? job.invoice?.paid ?? job.invoice?.amountPaid ?? job.deposit?.paidAmount);
  return { total: totalCents / 100, paid: paidCents / 100, balance: Math.max(0, totalCents - paidCents) / 100 };
}

export function customerDepositState(job, finance = customerMoneyState(job)) {
  // Honor an existing signed deposit term; every new quote defaults to 50%.
  // The term is on the quote: billed change orders are due with the balance.
  const saved = job.estimate?.depositRequired ?? job.deposit?.amount, quote = Math.max(0, cents(finance.total) - billedChangeCents(job));
  const requiredCents = Math.min(quote, saved == null ? Math.round(quote / 2) : cents(saved));
  const dueCents = Math.max(0, requiredCents - cents(finance.paid));
  const rawStatus = String(job.pipelineStatus || job.status || '').toLowerCase();
  const finalWalkthroughDone = (job.postJobProgress?.standardItems || []).some(item => item.key === '0_1' && item.completed === true);
  const closing = ['completed', 'paid'].includes(rawStatus) || Boolean(job.completedAt || job.postJobChecklist?.completedAt || finalWalkthroughDone);
  const amountDue = closing ? finance.balance : dueCents / 100;
  return { required: requiredCents / 100, paid: Math.min(requiredCents, cents(finance.paid)) / 100, due: dueCents / 100, dueNow: amountDue, purpose: closing ? 'balance' : 'deposit', remainder: Math.max(0, cents(finance.balance) - cents(amountDue)) / 100 };
}

// The portal checkout's own rule: throws when no card payment can open, else
// the customerDepositState it charges. Money documents offer "Pay" only on it.
// A Hub quote draft that was not sent in its current revision (P2-07) is never
// payable, even once the job is completed: the customer has not seen that total.
export function payable(job) {
  if (!job || [job.status, job.pipelineStatus].some(status => ['cancelled', 'canceled', 'superseded', 'lost'].includes(String(status || '').toLowerCase()))) throw failure('This job is not available for payment');
  if (unsentQuoteDraft(job)) throw failure('Your estimate is being updated. Payment opens once Easy Garage Cleaning sends it to you for review.', 409, 'CUSTOMER_PORTAL_ESTIMATE_NOT_APPROVABLE');
  if (customerPaymentNeedsReview(job)) throw failure('A recorded payment is awaiting team verification. Please wait before paying again.');
  const status = String(job.customerApproval?.status || job.estimate?.status || job.quoteStatus || '').toLowerCase();
  if (!['accepted', 'approved'].includes(status) && !['completed', 'paid'].includes(String(job.pipelineStatus || job.status || '').toLowerCase())) throw failure('Approve the estimate before paying');
  return customerDepositState(job);
}

// Every customer-payment call (portal checkout create, resume, expire and
// verify, and the webhook's read-back) is pinned to the API version the Garage
// Guard endpoints use, so payment_intent.latest_charge (2022-11-15 and later)
// never depends on the Stripe account's default version.
export const STRIPE_API_VERSION = '2024-06-20';

export async function stripeRequest(secret, path, options = {}) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    ...options,
    headers: { Authorization: `Basic ${btoa(`${secret}:`)}`, 'Stripe-Version': STRIPE_API_VERSION, ...(options.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw failure('Secure checkout could not be confirmed. Please try again.', 502);
  return data;
}

// A Checkout session as Stripe holds it now, with its charge (and any refund on
// it). A webhook payload carries only the PaymentIntent ID, so the webhook reads
// the session again before any money is recorded. Throws 503 when Stripe is not
// configured, cannot answer, or takes longer than 15 seconds, so Stripe retries
// the delivery.
export async function readStripeCheckout(env, sessionId) {
  const secret = stripeSecretKey(env), id = clean(sessionId);
  if (!secret) throw failure('Stripe is not configured, so the payment cannot be verified', 503, 'payment_stripe_unconfigured');
  if (!/^cs_(?:test_|live_)?[A-Za-z0-9_]+$/.test(id)) throw failure('Stripe has not verified this job payment', 409, 'payment_unverified');
  let checkout;
  try { checkout = await stripeRequest(secret, `checkout/sessions/${encodeURIComponent(id)}?expand[]=payment_intent.latest_charge`, { signal: AbortSignal.timeout(15000) }); }
  catch { throw failure('Stripe could not confirm this payment. Please try again.', 503, 'payment_stripe_unavailable'); }
  if (checkout?.id !== id) throw failure('Stripe could not confirm this payment. Please try again.', 503, 'payment_stripe_unavailable');
  return checkout;
}

const ledgerUrl = jobId => `${DB}/customer_payment_checkouts/${encodeURIComponent(jobId)}`;
async function readLedger(env, jobId) {
  const response = await firestoreFetch(env, ledgerUrl(jobId));
  if (response.status === 404) return { state: {}, version: '' };
  if (!response.ok) throw failure('Payment information is temporarily unavailable', 503);
  const doc = await response.json();
  if (!doc.updateTime) throw failure('Payment information is temporarily unavailable', 503);
  return { state: decodeFirestoreFields(doc.fields), version: doc.updateTime };
}
async function saveLedger(env, jobId, state, version) {
  const url = new URL(ledgerUrl(jobId));
  url.searchParams.set(version ? 'currentDocument.updateTime' : 'currentDocument.exists', version || 'false');
  const response = await firestoreFetch(env, url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: encodeFirestoreFields(state) }) });
  if (!response.ok) throw failure('Another payment request is being prepared. Please try again.');
  const doc = await response.json();
  if (!doc.updateTime) throw failure('Payment information is temporarily unavailable', 503);
  return { state, version: doc.updateTime };
}

function verifiedCheckout(checkout, kind, expectedJobId) {
  const jobId = clean(checkout?.metadata?.job_id, 120), sessionId = clean(checkout?.id);
  if (!/^cs_(?:test_|live_)?[A-Za-z0-9_]+$/.test(sessionId) || !jobId || (expectedJobId && jobId !== expectedJobId) || checkout.client_reference_id !== jobId || checkout.metadata?.kind !== kind || checkout.currency !== 'usd' || checkout.mode !== 'payment' || checkout.status !== 'complete' || checkout.payment_status !== 'paid' || !Number.isInteger(checkout.amount_total) || checkout.amount_total <= 0) throw failure('Stripe has not verified this job payment', 409, 'payment_unverified');
  return { jobId, sessionId };
}

async function paymentJob(env, jobId) {
  const job = await readJob(env, jobId).catch(() => null);
  if (!job?.__updateTime) throw failure('Payment information is temporarily unavailable', 503, 'payment_storage_unavailable');
  return job;
}

// A Stripe-confirmed charge that the job cannot take (a crew charge above the
// balance or behind an unverified receipt, or any charge Stripe shows refunded)
// is never left only in Stripe's retry queue. payment_reviews/{sessionId} is
// server-only and created once, so the webhook and the browser returns can all
// record it and the first record wins; later changes (a refund seen later, the
// mark when the charge reaches the job, a Hub resolution) are revision-checked
// updates. The job's money fields stay exactly as they were.
export const PAYMENT_REVIEW_COLLECTION = 'payment_reviews';
// A refund Stripe shows on a charge the job counts as paid, beyond what the
// last closed review in that charge's chain settled (nothing when it was
// reconciled, the refund the owner recorded when it was refunded), goes to the
// owner in a follow-up review: payment_reviews/{sessionId}:refund, then
// {sessionId}:refund:2, :3 ... when that follow-up is closed too and Stripe
// later shows more refunded. Each is created once (reason payment_refunded,
// sessionId the same charge); the chain is walked from the charge's own review,
// so every return and redelivery finds the same open follow-up instead of
// opening another.
export const MAX_REFUND_FOLLOW_UPS = 20;
export const refundFollowUpId = (sessionId, index = 1) => index > 1 ? `${sessionId}:refund:${index}` : `${sessionId}:refund`;
// The refund a closed payment review accounted for, in cents. A reconciled
// review settled none (Stripe showed no refund when it was checked); a
// recorded refund settled what Stripe showed then, or the whole charge.
export function settledRefundCents(review) {
  if (review?.resolution !== 'refunded') return 0;
  if (review.refundFull === true) return Number.MAX_SAFE_INTEGER;
  return Number.isSafeInteger(review.refundedCents) && review.refundedCents > 0 ? review.refundedCents : 0;
}
const reviewUrl = id => `${DB}/${PAYMENT_REVIEW_COLLECTION}/${encodeURIComponent(id)}`;
async function recordPaymentReview(env, review, id = review.sessionId) {
  const url = new URL(reviewUrl(id));
  url.searchParams.set('currentDocument.exists', 'false');
  let response = null;
  try { response = await firestoreFetch(env, url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: encodeFirestoreFields(review) }) }); }
  catch { /* A lost response is settled by the read below. */ }
  if (response?.ok) return;
  // Already recorded by an earlier delivery, or our create landed without a response.
  const saved = await firestoreFetch(env, reviewUrl(id)).catch(() => null);
  const doc = saved?.ok ? await saved.json().catch(() => null) : null;
  if (doc?.updateTime && decodeFirestoreFields(doc.fields || {}).sessionId === review.sessionId) return;
  throw failure('Payment information is temporarily unavailable', 503, 'payment_storage_unavailable');
}

// The held record for this session (or its refund follow-up, by id), if any,
// with its id and revision. Fails closed: an unreadable review is never taken
// to mean "no review".
async function readPaymentReview(env, sessionId, id = sessionId) {
  const response = await firestoreFetch(env, reviewUrl(id)).catch(() => null);
  if (response?.status === 404) return null;
  const doc = response?.ok ? await response.json().catch(() => null) : null;
  const review = doc?.updateTime ? decodeFirestoreFields(doc.fields || {}) : null;
  if (!review || review.sessionId !== sessionId) throw failure('Payment information is temporarily unavailable', 503, 'payment_storage_unavailable');
  return { ...review, id, revision: doc.updateTime };
}

// A held session that later fits the job is applied in ONE commit with a mark
// on its open review, preconditioned on the review's revision: a manager
// resolving the review at the same time makes this write fail and re-read.
async function patchJobWithReview(env, jobId, patch, updateTime, review, mark) {
  const root = 'projects/egcw-1ec83/databases/(default)/documents';
  const writes = [
    { update: { name: `${root}/jobs/${encodeURIComponent(jobId)}`, fields: encodeFirestoreFields(patch) }, updateMask: { fieldPaths: Object.keys(patch) }, currentDocument: { updateTime } },
    { update: { name: `${root}/${PAYMENT_REVIEW_COLLECTION}/${encodeURIComponent(review.sessionId)}`, fields: encodeFirestoreFields(mark) }, updateMask: { fieldPaths: Object.keys(mark) }, currentDocument: { updateTime: review.revision } },
  ];
  const response = await firestoreFetch(env, `${DB}:commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ writes }) });
  if (!response.ok) throw Object.assign(new Error(`Job storage write failed (${response.status})`), { storageStatus: response.status });
}

// Updates an open review under its revision. 'changed' means it was written
// since it was read (or the response was lost): re-read before deciding.
async function patchPaymentReview(env, review, patch) {
  const url = new URL(reviewUrl(review.id));
  Object.keys(patch).forEach(field => url.searchParams.append('updateMask.fieldPaths', field));
  url.searchParams.set('currentDocument.updateTime', review.revision);
  let response = null;
  try { response = await firestoreFetch(env, url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: encodeFirestoreFields(patch) }) }); }
  catch { return 'changed'; }
  if (response.ok) return 'saved';
  return [400, 409, 412].includes(response.status) ? 'changed' : 'failed'; // Firestore answers a stale updateTime with 400 FAILED_PRECONDITION.
}
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const chargeRefunded = charge => (Number.isSafeInteger(charge?.amount_refunded) && charge.amount_refunded > 0) || charge?.refunded === true;
// What Stripe shows refunded, in cents: a charge marked refunded without an amount counts as the whole charge.
const refundedCentsOf = (charge, amountCents) => Number.isSafeInteger(charge?.amount_refunded) && charge.amount_refunded > 0 ? Math.min(charge.amount_refunded, amountCents) : amountCents;

// A Stripe-confirmed charge held in payment_reviews means the customer may
// already have paid; with this flag on, no new card checkout (crew link or
// portal) opens for that job until a manager resolves the review in the Hub.
export const paymentReviewCheckoutBlockEnabled = env => env?.PAYMENT_REVIEW_CHECKOUT_BLOCK_ENABLED === 'true';
const REVIEW_SCAN = 200;

/** True when the job has an open payment review. Fails closed (503) when it cannot be verified. */
export async function openPaymentReview(env, jobId, fetcher = firestoreFetch) {
  const unavailable = () => failure('Payment reviews could not be verified. Please try again shortly.', 503, 'payment_review_unavailable');
  let response;
  try {
    response = await fetcher(env, `${DB}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000), body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: PAYMENT_REVIEW_COLLECTION }], select: { fields: [{ fieldPath: 'status' }, { fieldPath: 'jobId' }] },
      where: { fieldFilter: { field: { fieldPath: 'jobId' }, op: 'EQUAL', value: { stringValue: String(jobId) } } }, limit: REVIEW_SCAN,
    } }) });
  } catch { throw unavailable(); }
  if (!response.ok) throw unavailable();
  const rows = await response.json().catch(() => null);
  if (!Array.isArray(rows)) throw unavailable();
  const reviews = rows.filter(row => row?.document).map(row => decodeFirestoreFields(row.document.fields || {}));
  if (reviews.some(review => review.jobId !== jobId)) throw unavailable();
  if (reviews.some(review => review.status === 'open')) return true;
  // A full page without an open review cannot prove there is none beyond it.
  if (reviews.length >= REVIEW_SCAN) throw unavailable();
  return false;
}

async function checkoutReviewHold(env, jobId) {
  if (paymentReviewCheckoutBlockEnabled(env) && await openPaymentReview(env, jobId)) throw failure('A recent card payment on this job is being reviewed by our team. Please wait for us to confirm it before paying again.', 409, 'payment_review_open');
}

// What the crew (closeout screen) and the customer (portal) are told when a
// confirmed charge is held for a person instead of being recorded. A refund on
// a charge the job already counts as paid holds new checkouts only with
// PAYMENT_REVIEW_CHECKOUT_BLOCK_ENABLED; without it the balance (which already
// counts that charge) can still be paid, so the *_balance_open wording says so
// instead of "do not pay again".
const HELD = {
  crew: {
    payment_refunded: 'Stripe shows a refund on this charge, so it was not added to the job. It is saved for manager review. Do not charge again.',
    payment_refunded_on_job: 'Stripe shows a refund on this charge, which the job already counts as paid. It is saved for the owner to review. Do not charge again.',
    payment_refunded_on_job_balance_open: 'Stripe shows a refund on this charge, which the job already counts as paid, so the job balance is unchanged. The owner is reviewing the refund. Do not charge again for this payment; any balance the job still shows can be collected as usual.',
    payment_review_resolved: 'The office already resolved this Stripe charge, so it was not added to the job. Do not charge again.',
    payment_review_resolved_on_job: 'Stripe shows a refund on this charge, and the office already resolved it. Check with the office before charging again.',
    held: 'This Stripe charge is held for manager review, so it was not added to the job. Do not charge again.',
  },
  portal: {
    payment_refunded: 'Stripe shows this payment was refunded, so it was not added to your balance. It is held for our team to review. Please do not pay again until we contact you.',
    payment_refunded_on_job: 'Stripe shows this payment was refunded. It is held for our team to review. Please do not pay again until we contact you.',
    payment_refunded_on_job_balance_open: 'Stripe shows a refund on this payment, and our team is reviewing it. Your remaining balance is unchanged.',
    payment_review_resolved: 'Our team already reviewed this payment, so it was not added to your balance. Please contact us before paying again.',
    payment_review_resolved_on_job: 'Stripe shows this payment was refunded, and our team already reviewed it. Please contact us before paying again.',
    held: 'This payment is held for our team to review, so it was not added to your balance. Please do not pay again until we contact you.',
  },
};

// One verified path for every EGC Checkout kind. The Stripe session ID saved on
// the job is the idempotency key, so a webhook, a browser return and their
// replays can arrive in any order and still record a charge exactly once.
// Every caller passes the session read from Stripe with its charge expanded
// (expand[]=payment_intent.latest_charge), so a refund is always seen; the
// webhook reads it again (readStripeCheckout) because its payload has no charge.
// settleHeld:false (the webhook) never puts a charge that already has an open
// review on the job: only a person's action does (a browser return or Review queues).
async function recordStripeCheckout(env, checkout, { kind, expectedJobId = '', recordedBy = '', settleHeld = true, now = new Date().toISOString() }) {
  const crew = kind === CHECKOUT_KINDS.crew, { jobId, sessionId } = verifiedCheckout(checkout, kind, expectedJobId), text = HELD[crew ? 'crew' : 'portal'];
  // Money is recorded only from a session whose charge was read: fail closed (retryable) otherwise.
  if (!plainObject(checkout.payment_intent) || !plainObject(checkout.payment_intent.latest_charge)) throw failure('Stripe could not confirm this payment. Please try again.', 503, 'payment_charge_unread');
  const ledger = crew ? null : await readLedger(env, jobId);
  if (ledger?.state.sessionId === sessionId && Number(ledger.state.amountCents) !== checkout.amount_total) throw failure('The payment amount does not match this checkout');
  const paymentIntentId = clean(checkout.payment_intent.id), charge = checkout.payment_intent.latest_charge;
  // An existing review is already durable (create-only, first record wins); otherwise create it first.
  // id is the review document (the session ID, or its refund follow-up).
  const heldForReview = async (job, finance, reason, message, review = null, extra = {}, id = sessionId) => {
    if (!review) await recordPaymentReview(env, {
      sessionId, jobId, kind, reason, status: 'open', amountCents: checkout.amount_total, currency: 'usd', paymentIntentId, livemode: checkout.livemode === true,
      jobRevision: job.__updateTime, jobTotalCents: cents(finance.total), jobPaidCents: cents(finance.paid), jobBalanceCents: cents(finance.balance),
      createdBy: crew ? clean(checkout.metadata?.created_by, 80) : 'customer_portal', recordedBy: clean(recordedBy, 80), createdAt: now, ...extra,
    }, id);
    return Object.assign(failure(message, 409, reason), { reviewRecorded: true });
  };
  // Marks an open review with the refund Stripe shows now (under its revision). 'saved' when nothing had to change.
  const markRefund = async (review, refundedCents) => {
    if (!review || (review.reason === 'payment_refunded' && review.refundedCents === refundedCents)) return 'saved';
    return patchPaymentReview(env, review, { reason: 'payment_refunded', ...(review.reason !== 'payment_refunded' ? { heldReason: clean(review.reason, 60) } : {}), refundedCents, refundSeenAt: now, updatedAt: now });
  };
  let storageFailed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const job = await paymentJob(env, jobId), finance = customerMoneyState(job);
    if (knownSession(job, sessionId)) {
      // The job already counts this charge as paid and Stripe now shows a refund:
      // the job is left as it is, and the owner is told through a payment_refunded
      // review (created once, or the open one updated) instead of a silent duplicate.
      // Errors from here carry recordedOnJob: the job's balance already counts this
      // charge as paid, so a new checkout for that balance cannot charge it twice.
      if (chargeRefunded(charge)) {
        const refundedCents = refundedCentsOf(charge, checkout.amount_total);
        let review = await readPaymentReview(env, sessionId), extra = {}, id = sessionId, lastSettled = null;
        // The chain is walked to its last closed review, whose close is the latest word
        // on this charge: an earlier review that settled more (a refund recorded, then
        // closed as "Stripe no longer shows a refund") settles nothing now. When Stripe
        // shows more refunded than that last close settled (reconciled before any refund,
        // or a smaller refund recorded), the rest goes to the owner in the next follow-up
        // review, created once, never answered with a silent "already resolved".
        for (let index = 1; review && review.status !== 'open'; index++) {
          lastSettled = settledRefundCents(review);
          if (index > MAX_REFUND_FOLLOW_UPS) break;
          const heldReason = review.reason && review.reason !== 'payment_refunded' ? review.reason : review.heldReason;
          extra = { followUpOf: sessionId, ...(review.resolution ? { priorResolution: clean(review.resolution, 30) } : {}), ...(heldReason ? { heldReason: clean(heldReason, 60) } : {}), ...(lastSettled > 0 ? { priorRefundedCents: lastSettled } : {}) };
          id = refundFollowUpId(sessionId, index);
          review = await readPaymentReview(env, sessionId, id);
        }
        // Resolved only when the walk ends on a closed review that settled at least what Stripe shows.
        if (lastSettled !== null && review?.status !== 'open') {
          if (refundedCents <= lastSettled) throw Object.assign(failure(text.payment_review_resolved_on_job, 409, 'payment_review_resolved'), { reviewRecorded: true, recordedOnJob: true });
          // Every follow-up is used and closed: fail closed rather than open one past the last.
          if (review) throw failure('Payment information is temporarily unavailable', 503, 'payment_storage_unavailable');
        }
        const marked = review ? await markRefund(review, refundedCents) : 'saved';
        if (marked !== 'saved') { storageFailed = marked === 'failed'; continue; }
        // Without the checkout block the balance (which already counts this charge) can still be paid: say so.
        const message = paymentReviewCheckoutBlockEnabled(env) ? text.payment_refunded_on_job : text.payment_refunded_on_job_balance_open;
        throw Object.assign(await heldForReview(job, finance, 'payment_refunded', message, review, { ...extra, refundedCents, refundSeenAt: now }, id), { recordedOnJob: true });
      }
      const latest = job.payment.stripeSessions.at(-1), saved = job.payment.stripeSessions.find(item => String(item?.sessionId || item) === sessionId);
      const receiptUrl = String(latest?.sessionId || latest) === sessionId && RECEIPT_URL.test(charge.receipt_url || '') ? charge.receipt_url : job.payment.receiptUrl || '';
      let payment = job.payment;
      // A receipt Stripe issued after the charge was recorded is added to the
      // job without adding the payment again.
      if (receiptUrl && receiptUrl !== job.payment.receiptUrl) {
        try { await patchJob(env, jobId, { payment: { ...job.payment, receiptUrl } }, job.__updateTime); payment = { ...job.payment, receiptUrl }; }
        catch { if (attempt < 2) continue; }
      }
      const item = saved && typeof saved === 'object' ? saved : { sessionId, paymentIntentId, amount: checkout.amount_total / 100 };
      return { result: { paid: true, duplicate: true, amountPaid: checkout.amount_total / 100, balance: finance.balance, receiptUrl }, payment, invoice: job.invoice || {}, paymentSyncPayload: { ...item, balance: finance.balance, paidTotal: finance.paid }, withheld: unsentQuoteDraft(job) };
    }
    // A review the office closed (reconciled elsewhere, refunded) is final:
    // neither a browser return nor a webhook retry ever puts that charge on the job.
    const review = await readPaymentReview(env, sessionId);
    if (review && review.status !== 'open') throw Object.assign(failure(text.payment_review_resolved, 409, 'payment_review_resolved'), { reviewRecorded: true });
    // Money Stripe shows as refunded never counts as paid on its own, for any
    // checkout kind; the owner settles it in Review queues. A review opened for
    // another reason is updated (under its revision) so the queue shows the refund.
    if (chargeRefunded(charge) || review?.reason === 'payment_refunded') {
      const refundedCents = chargeRefunded(charge) ? refundedCentsOf(charge, checkout.amount_total) : null;
      const marked = refundedCents === null ? 'saved' : await markRefund(review, refundedCents);
      if (marked !== 'saved') { storageFailed = marked === 'failed'; continue; }
      throw await heldForReview(job, finance, 'payment_refunded', text.payment_refunded, review, refundedCents === null ? {} : { refundedCents, refundSeenAt: now });
    }
    // A webhook never settles a charge that already has an open review: only a
    // person's action does (the crew return, or Review queues). Stripe gets 200
    // and the job is unchanged.
    if (review && !settleHeld) throw await heldForReview(job, finance, clean(review.reason, 60) || 'payment_needs_review', text.held, review);
    if (customerPaymentNeedsReview(job)) {
      if (crew) throw await heldForReview(job, finance, 'payment_needs_review', 'Stripe confirmed this payment, but an earlier recorded payment needs manager verification. The charge is saved for manager review. Do not charge again.', review);
      // A crew-entered receipt cannot become verified merely because a separate
      // Stripe charge succeeds. Keep the confirmed charge durably recoverable,
      // and let Stripe retry after the manager verifies the earlier receipt.
      await saveLedger(env, jobId, { ...ledger.state, verifiedReceipt: { sessionId, amount: checkout.amount_total / 100, paymentIntentId, confirmedAt: now }, requiresReview: true }, ledger.version);
      throw failure('Your Stripe payment is confirmed. An earlier recorded payment needs team verification before the balance can be updated. Please do not pay again.', 409, 'payment_needs_review');
    }
    // A crew link was sized to the balance when it opened. A payment recorded
    // since then means this charge needs a manager before it changes the job.
    if (crew && (cents(finance.total) <= 0 || checkout.amount_total > cents(finance.balance))) throw await heldForReview(job, finance, 'payment_exceeds_balance', 'Stripe confirmed this payment, but it exceeds the current job balance. The charge is saved for manager review. Do not charge again.', review);
    const paidCents = cents(finance.paid) + checkout.amount_total;
    // Preserve every confirmed dollar, including any unexpected excess, for reconciliation.
    const paidTotal = paidCents / 100, balance = Math.max(0, cents(finance.total) - paidCents) / 100;
    const deposit = customerDepositState(job, { ...finance, paid: paidTotal, balance });
    const receiptUrl = RECEIPT_URL.test(charge.receipt_url || '') ? charge.receipt_url : job.payment?.receiptUrl || '';
    const receiptEmail = clean(checkout.customer_details?.email || checkout.customer_email);
    const paymentItem = crew
      ? { sessionId, paymentIntentId, amount: checkout.amount_total / 100, receiptEmail, createdBy: clean(checkout.metadata?.created_by, 80), recordedBy: clean(recordedBy, 80), verifiedAt: now }
      : { sessionId, paymentIntentId, amount: checkout.amount_total / 100, purpose: clean(checkout.metadata?.payment_purpose, 20), quoteRevision: clean(checkout.metadata?.quote_revision, 20), quotedTotalCents: Number(checkout.metadata?.quoted_total_cents || 0), verifiedAt: now };
    const trustedSessions = job.payment?.verified === true ? (job.payment.stripeSessions || []) : [];
    const payment = { ...(job.payment || {}), amount: paidTotal, lastAmount: paymentItem.amount, lastReceivedAt: now, method: 'stripe', processor: 'stripe', verified: true, receiptUrl, receiptEmail, reference: paymentIntentId || sessionId, stripeSessions: [...trustedSessions, paymentItem], ...(crew ? { recordedBy: paymentItem.recordedBy } : {}) };
    const invoice = { ...(job.invoice || {}), amount: finance.total, paid: paidTotal, balance, status: balance < .01 ? 'paid' : 'partial', updatedAt: now };
    const paymentSyncPayload = { ...paymentItem, balance, paidTotal };
    const patch = {
      payment,
      deposit: { ...(job.deposit || {}), amount: deposit.required, paidAmount: deposit.paid, status: deposit.due < .01 ? 'paid' : deposit.paid ? 'partial' : 'due', verified: true, updatedAt: now },
      invoice, paymentSyncStatus: 'pending', paymentSyncPayload,
      ...(paidTotal > finance.total ? { paymentReviewRequired: true } : {}), updatedAt: now,
    };
    try {
      if (review) await patchJobWithReview(env, jobId, patch, job.__updateTime, review, { jobRecordedAt: now, jobRecordedBy: clean(recordedBy, 80) });
      else await patchJob(env, jobId, patch, job.__updateTime);
      return { result: { paid: true, duplicate: false, amountPaid: paymentItem.amount, balance, receiptUrl }, payment, invoice, paymentSyncPayload, withheld: unsentQuoteDraft(job) };
    } catch (error) { storageFailed = ![400, 409, 412].includes(error.storageStatus); } // Firestore answers a stale updateTime with 400 FAILED_PRECONDITION.
  }
  // Each retry re-reads the job, so a write whose response was lost is found above as a duplicate.
  throw storageFailed ? failure('Payment information is temporarily unavailable', 503, 'payment_storage_unavailable') : failure('The payment record changed. Refresh to confirm the latest balance.', 409, 'payment_changed');
}

// recordedBy names who saw a held charge first ('customer_portal' for the portal
// return, 'stripe_webhook' for the webhook); settleHeld:false is the webhook.
// While a Hub quote draft has an unsent revision, the job's total is that revision, so the customer's reply
// (verify_payment, and create_payment's alreadyPaid) confirms the payment without a balance measured against
// terms they have not been sent. The payment itself is recorded in full either way.
export async function recordCustomerStripePayment(env, checkout, expectedJobId = '', now = new Date().toISOString(), { recordedBy = 'customer_portal', settleHeld = true } = {}) {
  const { result, withheld } = await recordStripeCheckout(env, checkout, { kind: CHECKOUT_KINDS.portal, expectedJobId, recordedBy, settleHeld, now });
  if (!withheld) return result;
  const { balance, ...confirmed } = result;
  return { ...confirmed, balanceWithheld: true };
}

// Crew card links (job-payment.js) settle through the same verification from
// the Stripe webhook or the crew browser return; the latter also receives the
// recorded job copy it shows during closeout.
export async function recordCrewStripePayment(env, checkout, { expectedJobId = '', recordedBy = '', settleHeld = true, now = new Date().toISOString() } = {}) {
  const { result, payment, invoice, paymentSyncPayload } = await recordStripeCheckout(env, checkout, { kind: CHECKOUT_KINDS.crew, expectedJobId, recordedBy, settleHeld, now });
  return { ...result, payment, invoice, paymentSyncPayload };
}

const fingerprint = job => JSON.stringify({ total: customerMoneyState(job).total, paid: customerMoneyState(job).paid, ...customerDepositState(job), revision: job.estimate?.revision || 1, approval: job.customerApproval?.status || job.estimate?.status || job.quoteStatus || '', status: job.pipelineStatus || job.status || '' });
// An open portal checkout whose saved fingerprint differs no longer matches the quote.
export const checkoutFingerprint = job => fingerprint(job);

/**
 * Closes the job's portal card checkout when it no longer charges exactly what
 * is due (a Hub change_order.void lowered the balance after it opened), so the
 * customer cannot pay the old amount; the next Pay opens one for the new
 * figure. Returns 'none' (no checkout is open), 'current' (it still charges
 * exactly what is due), 'expired' (it was closed now), 'paid' (the customer
 * already completed it; the payment webhook records it) or 'pending' (it is
 * still being created, or Stripe did not close it). Throws when storage or
 * Stripe cannot be read.
 */
export async function expireStaleCustomerCheckout(env, secret, jobId) {
  const ledger = await readLedger(env, jobId), state = ledger.state;
  if (!state.status || ['expired', 'settled'].includes(state.status)) return 'none';
  if (!state.sessionId) return 'pending';
  const job = await readJob(env, jobId);
  if (!job?.__updateTime) throw failure('Payment information is temporarily unavailable', 503);
  let due = null;
  try { due = cents(payable(job).dueNow); } catch { /* nothing may be charged now: close it */ }
  // Charging exactly what is due is harmless (a deposit checkout survives a void of a change due with the balance).
  if (due !== null && due >= 50 && Number(state.amountCents) === due) return 'current';
  const session = `checkout/sessions/${encodeURIComponent(state.sessionId)}`, checkout = await stripeRequest(secret, session);
  if (checkout.status === 'complete') return 'paid';
  if (checkout.status === 'open') {
    if ((await stripeRequest(secret, `${session}/expire`, { method: 'POST' })).status !== 'expired') return 'pending';
  } else if (checkout.status !== 'expired') return 'pending';
  await saveLedger(env, jobId, { ...state, status: 'expired' }, ledger.version);
  return 'expired';
}

// now (ISO) stamps a charge this call records or holds for review.
export async function createCustomerStripeCheckout(env, secret, jobId, origin, { now = new Date().toISOString() } = {}) {
  let ledger = await readLedger(env, jobId), state = ledger.state;
  let job = await readJob(env, jobId);
  if (!job?.__updateTime) throw failure('Payment information is temporarily unavailable', 503);
  let checkout;
  if (state.status === 'creating' && !state.sessionId) {
    // Persist both the key and exact parameters before Stripe. A lost response or
    // another browser can only recover the same session, never create a second.
    if (Date.now() - Date.parse(state.createdAt) > 23 * 3600000) throw failure('An earlier checkout needs confirmation by the team before another payment can be opened.');
    checkout = await stripeRequest(secret, 'checkout/sessions', { method: 'POST', headers: { 'Idempotency-Key': state.key }, body: new URLSearchParams(state.params) });
    if (!checkout.id) throw failure('Stripe did not confirm a checkout session', 502);
    ledger = await saveLedger(env, jobId, { ...state, sessionId: checkout.id, status: 'open' }, ledger.version);
    state = ledger.state;
  }
  if (state.sessionId && !['expired', 'settled'].includes(state.status)) {
    checkout = checkout || await stripeRequest(secret, `checkout/sessions/${encodeURIComponent(state.sessionId)}?expand[]=payment_intent.latest_charge`);
    if (checkout.status === 'complete') {
      if (checkout.payment_status !== 'paid') throw failure('Your previous payment is still processing. Please wait before paying again.');
      // A charge held for review (for example, one Stripe shows refunded) stops
      // here with its "do not pay again" message. Once the office has resolved
      // it, that checkout is settled and the current balance can be paid.
      // A refund on a charge the job already counts as paid still opens its
      // payment_refunded review, but the balance a new checkout charges already
      // counts that charge as paid, so it cannot be charged twice: it holds new
      // checkouts only with PAYMENT_REVIEW_CHECKOUT_BLOCK_ENABLED.
      // A refunded charge that is not on the job always holds: how much was
      // kept is unknown until the owner records it.
      let recorded = null;
      try { recorded = await recordCustomerStripePayment(env, checkout, jobId, now); }
      catch (error) {
        const refundOnJob = error.code === 'payment_refunded' && error.recordedOnJob === true && !paymentReviewCheckoutBlockEnabled(env);
        if (error.code !== 'payment_review_resolved' && !refundOnJob) throw error;
      }
      ledger = await saveLedger(env, jobId, { ...state, status: 'settled' }, ledger.version);
      state = ledger.state;
      if (recorded && !recorded.duplicate) return { ok: true, alreadyPaid: true, ...recorded };
      job = await readJob(env, jobId);
    } else if (checkout.status === 'open') {
      // Validate the current saved amount even when resuming an existing link.
      let stillPayable = false;
      try { stillPayable = payable(job).dueNow >= .5; } catch { /* Expire stale/cancelled scope below. */ }
      if (stillPayable && state.fingerprint === fingerprint(job) && checkout.amount_total === state.amountCents && /^https:\/\/checkout\.stripe\.com\//.test(checkout.url || '')) {
        await checkoutReviewHold(env, jobId);
        return { ok: true, url: checkout.url, amount: state.amountCents / 100, purpose: state.purpose };
      }
      const expired = await stripeRequest(secret, `checkout/sessions/${encodeURIComponent(state.sessionId)}/expire`, { method: 'POST' });
      if (expired.status !== 'expired') throw failure('The earlier checkout must finish closing before another payment can be opened.');
      ledger = await saveLedger(env, jobId, { ...state, status: 'expired' }, ledger.version);
      state = ledger.state;
    } else if (checkout.status === 'expired') {
      ledger = await saveLedger(env, jobId, { ...state, status: 'expired' }, ledger.version);
      state = ledger.state;
    } else throw failure('Your previous checkout is still being confirmed. Please try again.');
  }
  const deposit = payable(job), amountCents = cents(deposit.dueNow), changeCents = billedChangeCents(job);
  if (amountCents < 50) throw failure(customerMoneyState(job).balance < .5 ? 'There is no outstanding balance' : 'Your deposit is paid. The remaining balance is due on completion.');
  await checkoutReviewHold(env, jobId);
  const params = new URLSearchParams({
    mode: 'payment', submit_type: 'pay', client_reference_id: jobId,
    success_url: `${origin}/customer-portal?payment=stripe-success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/customer-portal?payment=stripe-cancelled`,
    'payment_method_types[0]': 'card',
    'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(amountCents),
    'line_items[0][price_data][product_data][name]': `Easy Garage Cleaning — ${deposit.purpose === 'deposit' ? 'upfront deposit' : 'remaining balance'}`,
    'line_items[0][price_data][product_data][description]': `${clean(job.serviceType || 'Garage service', 100)}. ${deposit.purpose === 'deposit' ? 'Applied to your approved quote; remaining balance due on completion.' : `Balance after previous payments and credits${changeCents ? `, including ${(changeCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} in approved changes` : ''}.`}`,
    'metadata[kind]': 'egc_customer_portal_payment', 'metadata[job_id]': jobId, 'metadata[payment_purpose]': deposit.purpose,
    'metadata[quote_revision]': String(job.estimate?.revision || 1), 'metadata[quoted_total_cents]': String(cents(customerMoneyState(job).total)),
    'payment_intent_data[metadata][kind]': 'egc_customer_portal_payment', 'payment_intent_data[metadata][job_id]': jobId, 'payment_intent_data[metadata][payment_purpose]': deposit.purpose,
  });
  if (changeCents) params.set('metadata[approved_change_cents]', String(changeCents));
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(job.email || '')) {
    params.set('customer_email', job.email); params.set('payment_intent_data[receipt_email]', job.email);
  }
  state = { status: 'creating', sessionId: '', key: `egc-customer-payment:${crypto.randomUUID()}`, params: params.toString(), amountCents, purpose: deposit.purpose, fingerprint: fingerprint(job), createdAt: new Date().toISOString() };
  await saveLedger(env, jobId, state, ledger.version);
  // Recover through the same path, including the current-scope check, before returning a link.
  return createCustomerStripeCheckout(env, secret, jobId, origin, { now });
}
