import { firestoreFetch } from './firebase-service-account.js';
import { readJob, patchJob, encodeFirestoreFields, decodeFirestoreFields } from './firestore-job.js';
import { customerMoneyTotals, invoiceTakesPayment, moneyInvoiceStateEnabled, moneyTotalsMode, moneyUnpriced, paymentLedger, refundsRecorded, reportTotalsMismatch } from './money-core.js';
import { manualEntryIds } from './money-ledger.js';
import { billedChangeCents } from './change-orders.js';
import { unsentQuoteDraft } from './quote-model.js';
import { moneyStorage } from './money-storage.js';
import { FIELD_CARD_CHECKOUTS, activeFieldCard, fieldCardClose } from './field-payment-card.js';
import { syncFieldPayment } from './field-payment-sync.js';
import { funnelPaymentEventsEnabled, moneyEventWrites, paymentKind, stripeChargeClock, stripePaymentMethod } from './payment-events.js';

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

// Optional tips on card balance payments. A tip is a second Checkout line and
// is recorded apart from the service money: payment.amount, the invoice and the
// deposit never include it, so it never lowers a balance or counts as revenue.
export const TIP_PRESETS = Object.freeze([10, 15, 20]);
export const TIP_LINE_NAME = 'Tip for your crew';
const TIP_FLOOR_CENTS = 50000;
/** CUSTOMER_TIPS_ENABLED === 'true' lets the portal and crew card checkouts carry a tip.
 * With it unset, money behaves exactly as before tips. The accepted differences from the pre-tips build, none of which
 * changes an amount charged, recorded or held: crew Stripe calls (checkout create, expire and session reads) send
 * Stripe-Version 2024-06-20 like every other customer-payment call, so payment_intent.latest_charge never depends on
 * the account's default API version; GET /api/stripe-reviews rows also carry tipCents (0) and serviceCents; with
 * PAYMENT_REVIEW_CHECKOUT_BLOCK_ENABLED the payment_reviews query also selects sessionId, reason, resolution and
 * tipCents; the portal checkout ledger's createdAt comes from the injected clock; crew/postjob asks
 * GET /api/job-payment?config=tips once per render; and charge.refunded webhooks stay acknowledged and ignored.
 * Two Review queues fixes apply whatever the flag, neither changing an amount charged or recorded: a refund Stripe
 * shows after the review of a charge NOT on its job was closed, beyond what that close settled, opens the
 * {sessionId}:refund follow-up exactly as it always did for a charge on its job (instead of answering "already
 * resolved" with nothing queued); and the webhook answers reviewRequired:false, not true, for a charge whose reviews
 * are all closed (payment_review_resolved), since nothing is queued for a person. */
export const customerTipsEnabled = env => String(env?.CUSTOMER_TIPS_ENABLED ?? '').trim() === 'true';
/** The most a tip may be: half the balance, or $500 when that is more, on a charge that pays the whole balance (the
 * portal always does). A partial card charge (crew closeout) may carry at most half of what it charges, so a small
 * partial charge can never carry a large, effectively tip-only, payment. The $500 floor is the product rule for a
 * whole balance, so a small remaining balance (even $0.50) may still carry up to a $500 tip; that is accepted, not
 * an oversight (the tip is still recorded apart from the balance and needs a real balance charge beside it). */
export const tipLimitCents = (balanceCents, chargeCents = balanceCents) => {
  const balance = Math.max(0, Number(balanceCents) || 0), charge = Math.max(0, Number(chargeCents) || 0);
  return charge < balance ? Math.round(charge / 2) : Math.max(Math.round(balance / 2), TIP_FLOOR_CENTS);
};
const CLOSED_STATUSES = ['cancelled', 'canceled', 'superseded', 'lost'];
// A no-show is terminal in dispatch (dispatch-service TERMINAL) but not closed to a balance payment (payable() is
// unchanged), so only a tip is refused on it. Completed, invoiced, paid, review_requested and closed jobs are the
// normal place for a balance tip.
const TIP_CLOSED_STATUSES = [...CLOSED_STATUSES, 'no_show', 'no-show', 'noshow'];
/** Why no tip can be added to this job, or '' when one can: never on a cancelled, superseded, lost or no-show job, on
 * a void or superseded invoice, or while refunds are recorded on it (money-core does not reconcile those yet). */
export function tipRefusal(job) {
  if (!job || [job.status, job.pipelineStatus].some(status => TIP_CLOSED_STATUSES.includes(String(status || '').toLowerCase()))) return 'This job is closed, so a tip cannot be added.';
  if (['void', 'superseded'].includes(String(job.invoice?.status || '').toLowerCase())) return 'This invoice is no longer open, so a tip cannot be added.';
  if (refundsRecorded(job)) return 'A refund is recorded on this job, so a tip cannot be added. Contact the team.';
  return '';
}
/** A browser-supplied tip in whole cents; absent means no tip. */
export function requestTip(value) {
  if (value === undefined || value === null) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw failure('Choose a tip in whole dollars and cents.', 400, 'tip_invalid');
  return value;
}
/** A tip rides only on a balance payment of at least $0.50, never alone or on a deposit, and within tipLimitCents
 * of the amount actually charged toward the balance (chargeCents; the whole balance unless a crew card charge is partial). */
export function validTip(tipCents, balanceCents, purpose = 'balance', chargeCents = balanceCents) {
  if (requestTip(tipCents) === 0) return 0;
  if (purpose !== 'balance') throw failure('A tip can be added when the remaining balance is paid, not with the deposit.', 409, 'tip_not_balance');
  if (!(balanceCents >= 50) || !(chargeCents >= 50)) throw failure('A tip can only be added to a balance payment.', 409, 'tip_without_balance');
  const limit = tipLimitCents(balanceCents, chargeCents), usd = value => `$${(value / 100).toFixed(2)}`;
  if (tipCents > limit) throw failure(`A tip can be at most ${usd(limit)} on ${chargeCents < balanceCents ? `a partial card payment of ${usd(chargeCents)}` : 'this balance'}.`, 400, 'tip_over_limit');
  return tipCents;
}
/** Adds the tip as Checkout line 2 and names it in the session and PaymentIntent metadata. */
export function addTipLine(params, tipCents) {
  if (!tipCents) return params;
  params.set('line_items[1][quantity]', '1'); params.set('line_items[1][price_data][currency]', 'usd');
  params.set('line_items[1][price_data][unit_amount]', String(tipCents));
  params.set('line_items[1][price_data][product_data][name]', TIP_LINE_NAME);
  params.set('line_items[1][price_data][product_data][description]', 'Optional. It goes to your crew and is not part of the service total.');
  params.set('metadata[tip_cents]', String(tipCents)); params.set('payment_intent_data[metadata][tip_cents]', String(tipCents));
  return params;
}
/** Tips recorded on the job, in cents, exactly as money-core counts them (a repeated row once, verified payments
 * only), so the portal and the receipt agree; null when the tip total cannot be read (copies that disagree, tips on
 * an unverified payment, an unreadable tip list). */
export const recordedTipCents = job => paymentLedger(job).tipCents;

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
  // A crew cash/check receipt has not entered the verified money ledger yet.
  // Its server-owned job lock pauses portal and crew checkouts, credits, and
  // ordinary offline payment entry until an operations manager reviews it.
  if (job?.fieldPaymentPendingId) return true;
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

// FIX-MONEY-TOTALS (MONEY_UNIFIED_TOTALS, money-core moneyTotalsMode): in mode 'unified' the portal, its checkout, the
// payment return, crew card links and closeout read money-core's customerMoneyTotals(job, {unified: true}) in integer
// cents: the quote plus the billed change-order lines, the money applied to the service (tips never count) and the
// balance, with the deposit, what is due now and the remainder. When money-core cannot read those (money that is not
// dollars and cents, a missing quote, tips that cannot be itemized), today's figures are shown with unknown: true and
// nothing can be charged; a job with no quote saved yet is also unpriced: true (money-core moneyUnpriced), which is not
// money for the team to review. Mode 'off' (unset) and 'shadow' serve today's figures; customerTotalsShadow logs the difference.
// The one "needs review" rule (the Hub board's employee-money-totals.js applies exactly this): the total, the money applied,
// the balance, what is due now and the remainder must read, and the deposit terms only while the deposit is what the
// checkout collects. A deposit term that cannot be read (money_deposit_invalid) never holds up a completed job's balance;
// its deposit figures are then null (unknown, never 0).
const UNIFIED_KEYS = ['totalCents', 'appliedCents', 'balanceCents', 'dueNowCents', 'remainderCents'];
const DEPOSIT_KEYS = ['depositRequiredCents', 'depositPaidCents', 'depositDueCents'];
function unifiedTotals(job) {
  const totals = customerMoneyTotals(job, { unified: true });
  return [...UNIFIED_KEYS, ...(totals.purpose === 'deposit' ? DEPOSIT_KEYS : [])].every(key => Number.isSafeInteger(totals[key])) ? totals : null;
}
const unifiedDollars = value => Number.isSafeInteger(value) ? value / 100 : null;
const unknownMoney = job => ({ unknown: true, ...(moneyUnpriced(customerMoneyTotals(job, { unified: true })) ? { unpriced: true } : {}) });

export function customerMoneyState(job, mode = 'off') {
  if (mode === 'unified') {
    const totals = unifiedTotals(job);
    return totals ? { total: totals.totalCents / 100, paid: totals.appliedCents / 100, balance: totals.balanceCents / 100 } : { ...customerMoneyState(job), ...unknownMoney(job) };
  }
  // Change-order lines billed from portal approvals (change-orders.js) are owed on top of the quote.
  const totalCents = quoteCents(job) + billedChangeCents(job);
  const paidCents = cents(job.payment?.amount ?? job.invoice?.paid ?? job.invoice?.amountPaid ?? job.deposit?.paidAmount);
  return { total: totalCents / 100, paid: paidCents / 100, balance: Math.max(0, totalCents - paidCents) / 100 };
}

/** Shadow mode: today's figures against the unified ones, logged once as money_totals_mismatch when they differ. */
export function customerTotalsShadow(job, surface, log) {
  const served = customerMoneyState(job), due = customerDepositState(job, served), unified = customerMoneyTotals(job, { unified: true });
  return reportTotalsMismatch(job?.id, surface, { totalCents: cents(served.total), paidCents: cents(served.paid), balanceCents: cents(served.balance), dueNowCents: cents(due.dueNow) },
    { totalCents: unified.totalCents, paidCents: unified.appliedCents, balanceCents: unified.balanceCents, dueNowCents: unified.dueNowCents }, log);
}

// Mode 'unified' ignores `finance` and reads the deposit terms from money-core (unknown money: nothing due now).
export function customerDepositState(job, finance = customerMoneyState(job), mode = 'off') {
  if (mode === 'unified') {
    const totals = unifiedTotals(job);
    if (totals) return { required: unifiedDollars(totals.depositRequiredCents), paid: unifiedDollars(totals.depositPaidCents), due: unifiedDollars(totals.depositDueCents), dueNow: totals.dueNowCents / 100, purpose: totals.purpose, remainder: totals.remainderCents / 100 };
    const legacy = customerDepositState(job);
    return { ...legacy, dueNow: 0, remainder: customerMoneyState(job).balance, ...unknownMoney(job) };
  }
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
// In mode 'unified' it charges money-core's unified figures, and refuses
// (CUSTOMER_PORTAL_MONEY_REVIEW) while money-core cannot read them, or
// (CUSTOMER_PORTAL_ESTIMATE_NOT_READY) while no quote is saved.
export const MONEY_REVIEW_TEXT = 'The amounts on this project need a quick review by our team before a card payment can open. Please call or text us.';
export const UNPRICED_TEXT = 'Your estimate is not priced yet. Payment opens once Easy Garage Cleaning sends it to you.';
export const unknownMoneyRefusal = state => state.unpriced ? { code: 'CUSTOMER_PORTAL_ESTIMATE_NOT_READY', error: UNPRICED_TEXT } : { code: 'CUSTOMER_PORTAL_MONEY_REVIEW', error: MONEY_REVIEW_TEXT };
export function payable(job, mode = 'off') {
  if (!job || [job.status, job.pipelineStatus].some(status => CLOSED_STATUSES.includes(String(status || '').toLowerCase()))) throw failure('This job is not available for payment');
  if (unsentQuoteDraft(job)) throw failure('Your estimate is being updated. Payment opens once Easy Garage Cleaning sends it to you for review.', 409, 'CUSTOMER_PORTAL_ESTIMATE_NOT_APPROVABLE');
  if (customerPaymentNeedsReview(job)) throw failure('A recorded payment is awaiting team verification. Please wait before paying again.');
  if (job.fieldPaymentCardRequestId) throw failure('A field card checkout is open for this job. Please wait for the team to verify it before paying again.', 409, 'field_card_checkout_open');
  const status = String(job.customerApproval?.status || job.estimate?.status || job.quoteStatus || '').toLowerCase();
  if (!['accepted', 'approved'].includes(status) && !['completed', 'paid'].includes(String(job.pipelineStatus || job.status || '').toLowerCase())) throw failure('Approve the estimate before paying');
  const due = customerDepositState(job, undefined, mode);
  if (due.unknown) { const { code, error } = unknownMoneyRefusal(due); throw failure(error, 409, code); }
  return due;
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

// The Hub checkout session a PaymentIntent was paid through, as Stripe lists it
// (payment_intent a plain ID), or null when there is none: a charge event
// (charge.refunded) names only its PaymentIntent. Throws 503 like
// readStripeCheckout when Stripe is not configured or cannot answer.
export async function findStripeCheckoutByPaymentIntent(env, paymentIntentId) {
  const secret = stripeSecretKey(env), id = clean(paymentIntentId);
  if (!secret) throw failure('Stripe is not configured, so the payment cannot be verified', 503, 'payment_stripe_unconfigured');
  if (!/^pi_[A-Za-z0-9_]+$/.test(id)) return null;
  let list;
  try { list = await stripeRequest(secret, `checkout/sessions?payment_intent=${encodeURIComponent(id)}&limit=1`, { signal: AbortSignal.timeout(15000) }); }
  catch { throw failure('Stripe could not confirm this payment. Please try again.', 503, 'payment_stripe_unavailable'); }
  if (!Array.isArray(list?.data)) throw failure('Stripe could not confirm this payment. Please try again.', 503, 'payment_stripe_unavailable');
  const session = list.data[0];
  return plainObject(session) && (session.payment_intent?.id || session.payment_intent) === id ? session : null;
}

// The portal checkout ledger, one server-only document per job.
export const PORTAL_CHECKOUT_COLLECTION = 'customer_payment_checkouts';
const ledgerUrl = jobId => `${DB}/${PORTAL_CHECKOUT_COLLECTION}/${encodeURIComponent(jobId)}`;
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

// metadata.tip_cents is written only by the Hub when it opens a checkout; the
// rest of amount_total is the service payment, which must still be a real charge.
function verifiedCheckout(checkout, kind, expectedJobId) {
  const jobId = clean(checkout?.metadata?.job_id, 120), sessionId = clean(checkout?.id), rawTip = checkout?.metadata?.tip_cents;
  const tipCents = rawTip === undefined || rawTip === null || rawTip === '' ? 0 : /^\d{1,9}$/.test(String(rawTip)) ? Number(rawTip) : NaN;
  if (!/^cs_(?:test_|live_)?[A-Za-z0-9_]+$/.test(sessionId) || !jobId || (expectedJobId && jobId !== expectedJobId) || checkout.client_reference_id !== jobId || checkout.metadata?.kind !== kind || checkout.currency !== 'usd' || checkout.mode !== 'payment' || checkout.status !== 'complete' || checkout.payment_status !== 'paid' || !Number.isInteger(checkout.amount_total) || checkout.amount_total <= 0
    || !Number.isSafeInteger(tipCents) || tipCents && checkout.amount_total - tipCents < 50) throw failure('Stripe has not verified this job payment', 409, 'payment_unverified');
  return { jobId, sessionId, tipCents, serviceCents: checkout.amount_total - tipCents };
}

async function paymentJob(env, jobId) {
  const job = await readJob(env, jobId).catch(() => null);
  if (!job?.__updateTime) throw failure('Payment information is temporarily unavailable', 503, 'payment_storage_unavailable');
  return job;
}

// A Stripe-confirmed charge that the job cannot take (a crew charge above the
// balance or behind an unverified receipt, any charge Stripe shows refunded, or
// a tipped charge on a job that closed after its checkout opened) is never left
// only in Stripe's retry queue. payment_reviews/{sessionId} is
// server-only and created once, so the webhook and the browser returns can all
// record it and the first record wins; later changes (a refund seen later, the
// mark when the charge reaches the job, a Hub resolution) are revision-checked
// updates. The job's money fields stay exactly as they were. A review of a
// tipped charge carries tipCents (its refund follow-ups too), so Review queues
// and the tip hold below can tell the service part from the crew tip.
export const PAYMENT_REVIEW_COLLECTION = 'payment_reviews';
// A refund Stripe shows on a charge, beyond what the last closed review in that
// charge's chain settled (nothing when it was reconciled, the refund the owner
// recorded when it was refunded), goes to the owner in a follow-up review, whether
// the job counts the charge as paid or its earlier close had the money kept
// recorded on the job by hand (or applied elsewhere): payment_reviews/{sessionId}:refund, then
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

// A tipped charge with no review is booked in ONE commit with a precondition-only
// write: deleting payment_reviews/{sessionId} with currentDocument.exists=false is
// a no-op while no review exists, and fails the whole commit (409 ALREADY_EXISTS,
// nothing applied) once one does, even one created after this job was read. An
// untipped charge keeps its single job PATCH, exactly as before tips.
async function patchJobUnlessReviewed(env, jobId, patch, updateTime, sessionId) {
  const root = 'projects/egcw-1ec83/databases/(default)/documents';
  const writes = [
    { update: { name: `${root}/jobs/${encodeURIComponent(jobId)}`, fields: encodeFirestoreFields(patch) }, updateMask: { fieldPaths: Object.keys(patch) }, currentDocument: { updateTime } },
    { delete: `${root}/${PAYMENT_REVIEW_COLLECTION}/${encodeURIComponent(sessionId)}`, currentDocument: { exists: false } },
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
const reviewsUnavailable = () => failure('Payment reviews could not be verified. Please try again shortly.', 503, 'payment_review_unavailable');
const tippedReview = review => Number.isSafeInteger(review?.tipCents) && review.tipCents > 0;

// One page of this job's payment reviews, read with one filtered query (an
// equality filter needs only the automatic single-field index). Fails closed
// (503): an unreadable answer is never taken to mean "no review".
async function jobPaymentReviews(env, jobId, fetcher) {
  let response;
  try {
    response = await fetcher(env, `${DB}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000), body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: PAYMENT_REVIEW_COLLECTION }], select: { fields: ['sessionId', 'jobId', 'status', 'reason', 'resolution', 'tipCents'].map(fieldPath => ({ fieldPath })) },
      where: { fieldFilter: { field: { fieldPath: 'jobId' }, op: 'EQUAL', value: { stringValue: String(jobId) } } }, limit: REVIEW_SCAN,
    } }) });
  } catch { throw reviewsUnavailable(); }
  if (!response?.ok) throw reviewsUnavailable();
  const rows = await response.json().catch(() => null);
  if (!Array.isArray(rows)) throw reviewsUnavailable();
  const reviews = rows.filter(row => row?.document).map(row => decodeFirestoreFields(row.document.fields || {}));
  if (reviews.some(review => review.jobId !== jobId)) throw reviewsUnavailable();
  return reviews;
}

/** Every payment review of each job, as a Map of jobId to its rows ({sessionId, jobId, status, reason, resolution,
 * tipCents}); one query per job, a few at a time. Fails closed (503): a job whose reviews cannot all be read (or fill a
 * whole page) is never taken to have none. */
export async function paymentReviewsForJobs(env, jobIds, fetcher = firestoreFetch) {
  const ids = [...new Set(jobIds)], found = new Map();
  for (let index = 0; index < ids.length; index += 8) {
    const chunk = ids.slice(index, index + 8);
    const pages = await Promise.all(chunk.map(jobId => jobPaymentReviews(env, jobId, fetcher)));
    chunk.forEach((jobId, at) => { if (pages[at].length >= REVIEW_SCAN) throw reviewsUnavailable(); found.set(jobId, pages[at]); });
  }
  return found;
}

/** True when the job has an open payment review. Fails closed (503) when it cannot be verified. */
export async function openPaymentReview(env, jobId, fetcher = firestoreFetch) {
  const reviews = await jobPaymentReviews(env, jobId, fetcher);
  if (reviews.some(review => review.status === 'open')) return true;
  // A full page without an open review cannot prove there is none beyond it.
  if (reviews.length >= REVIEW_SCAN) throw reviewsUnavailable();
  return false;
}

/**
 * The open review that stops a new card checkout (crew link or portal) for this
 * job, or null; one query serves both rules, and none runs when both are off:
 * - CUSTOMER_TIPS_ENABLED: an open review on a tipped charge. Such a charge is
 *   never booked automatically, so the customer may already have paid the
 *   balance it holds. A review on a charge the job already counts as paid (a
 *   refund Stripe showed after the charge was recorded, whether its own review or
 *   a {sessionId}:refund follow-up) does not count: the balance a new checkout
 *   charges already counts that charge, so it cannot be charged twice, and the
 *   refund stays with the owner in Review queues (the *_balance_open wording).
 * - PAYMENT_REVIEW_CHECKOUT_BLOCK_ENABLED: any open review.
 * Throws 503 payment_review_unavailable when the reviews cannot be read, or a
 * full page holds no match (one beyond it cannot be ruled out).
 */
export async function checkoutHold(env, jobId, job = null, fetcher = firestoreFetch) {
  const tips = customerTipsEnabled(env), block = paymentReviewCheckoutBlockEnabled(env);
  if (!tips && !block) return null;
  const reviews = await jobPaymentReviews(env, jobId, fetcher);
  const held = reviews.find(review => review.status === 'open' && (block || tippedReview(review) && !(job && knownSession(job, clean(review.sessionId)))));
  if (held) return { sessionId: clean(held.sessionId), reason: clean(held.reason, 60), tipped: tippedReview(held) };
  if (reviews.length >= REVIEW_SCAN) throw reviewsUnavailable();
  return null;
}

// The one refusal for a checkout while checkoutHold finds a review, for the crew
// link (job-payment.js answers it itself) and the portal. With tips on it carries
// reviewRecorded, so the portal passes its code on and refreshes into the held view.
export const CHECKOUT_HOLD_CODE = 'payment_review_open';
export const CHECKOUT_HOLD_TEXT = Object.freeze({
  crew: 'A confirmed card payment on this job is waiting for manager review. Do not charge again; a manager resolves it in Hub > Review queues.',
  portal: 'A recent card payment on this job is being reviewed by our team. Please wait for us to confirm it before paying again.',
});
const portalHoldRefusal = env => Object.assign(failure(CHECKOUT_HOLD_TEXT.portal, 409, CHECKOUT_HOLD_CODE), customerTipsEnabled(env) ? { reviewRecorded: true } : {});
async function checkoutReviewHold(env, jobId, job) {
  if (await checkoutHold(env, jobId, job)) throw portalHoldRefusal(env);
}

// What the crew (closeout screen) and the customer (portal) are told when a
// confirmed charge is held for a person instead of being recorded. A refund on
// a charge the job already counts as paid holds new checkouts only with
// PAYMENT_REVIEW_CHECKOUT_BLOCK_ENABLED; without it the balance (which already
// counts that charge) can still be paid, so the *_balance_open wording says so
// instead of "do not pay again". A tipped charge with any review is held under
// that review's reason (payment_tip_refused, payment_exceeds_balance,
// payment_needs_review ...), never booked automatically.
const HELD = {
  crew: {
    payment_refunded: 'Stripe shows a refund on this charge, so it was not added to the job. It is saved for manager review. Do not charge again.',
    payment_refunded_on_job: 'Stripe shows a refund on this charge, which the job already counts as paid. It is saved for the owner to review. Do not charge again.',
    payment_refunded_on_job_balance_open: 'Stripe shows a refund on this charge, which the job already counts as paid, so the job balance is unchanged. The owner is reviewing the refund. Do not charge again for this payment; any balance the job still shows can be collected as usual.',
    payment_review_resolved: 'The office already resolved this Stripe charge, so it was not added to the job. Do not charge again.',
    payment_review_resolved_on_job: 'Stripe shows a refund on this charge, and the office already resolved it. Check with the office before charging again.',
    payment_tip_refused: 'Stripe confirmed this payment, but the job is now closed, voided or refunded, so its tip cannot be added. The charge is saved for manager review. Do not charge again.',
    payment_exceeds_balance: 'Stripe confirmed this payment, but it exceeds the current job balance. The charge is saved for manager review. Do not charge again.',
    payment_needs_review: 'Stripe confirmed this payment, but an earlier recorded payment needs manager verification. The charge is saved for manager review. Do not charge again.',
    held: 'This Stripe charge is held for manager review, so it was not added to the job. Do not charge again.',
  },
  portal: {
    payment_refunded: 'Stripe shows this payment was refunded, so it was not added to your balance. It is held for our team to review. Please do not pay again until we contact you.',
    payment_refunded_on_job: 'Stripe shows this payment was refunded. It is held for our team to review. Please do not pay again until we contact you.',
    payment_refunded_on_job_balance_open: 'Stripe shows a refund on this payment, and our team is reviewing it. Your remaining balance is unchanged.',
    payment_review_resolved: 'Our team already reviewed this payment, so it was not added to your balance. Please contact us before paying again.',
    payment_review_resolved_on_job: 'Stripe shows this payment was refunded, and our team already reviewed it. Please contact us before paying again.',
    payment_tip_refused: 'Your card payment is confirmed. This job was closed, voided or refunded after checkout opened, so our team will review the payment and your tip before applying them. Please do not pay again.',
    payment_exceeds_balance: 'Your card payment is confirmed, but it is more than the balance now due, so our team will review it before applying it. Please do not pay again.',
    payment_needs_review: 'Your card payment is confirmed. An earlier recorded payment needs team verification, so our team will review this one before applying it. Please do not pay again.',
    held: 'This payment is held for our team to review, so it was not added to your balance. Please do not pay again until we contact you.',
  },
};

// The one mapping for every job write the recorder makes: true when nothing
// was applied because the job (or another precondition in the same commit)
// changed since it was read, so the recorder re-reads and decides again. A
// single-document patch or a direct :commit reports it as storageStatus 400
// FAILED_PRECONDITION (or 409/412); a :commit through moneyStorage as
// money_revision_conflict. Anything else is a storage failure (503, and Stripe retries).
const staleJobWrite = error => error?.code === 'money_revision_conflict' || [400, 409, 412].includes(error?.storageStatus);

// FUN-33: Stripe payments are recorded as {actor, via}: the webhook, the crew return or the customer portal.
// The webhook's actor is FUN-20's Stripe webhook audit actor (garage-guard-ledger.js), the same id on every Stripe
// webhook event in the funnel ledger. It carries role null, so no bridge verifier accepts it: it is never signed.
const STRIPE_ACTOR = Object.freeze({ id: 'stripe_webhook', kind: 'integration', role: null });
function paymentSource({ fromWebhook, crew, recordedBy }) {
  if (fromWebhook) return { via: 'stripe', actor: STRIPE_ACTOR };
  if (!crew) return { via: 'portal', actor: { id: 'customer', kind: 'customer' } };
  const user = String(recordedBy || '').trim().toLowerCase();
  return { via: 'field', actor: { id: /^[a-z0-9][a-z0-9_.@:+-]{0,119}$/.test(user) ? user : 'staff', kind: 'human' } };
}

// FUN-33 (FUNNEL_PAYMENT_EVENTS_ENABLED): the job change, its funnel events and
// paid-in-full fields in ONE :commit, with the review write the booking needs
// (`writes`): the revision-checked mark on the charge's open review, or, for a
// tipped charge with no review, the precondition-only delete of
// payment_reviews/{sessionId} (exists:false) that patchJobUnlessReviewed sends. An
// event that cannot be built never strands a confirmed charge: the payment is
// recorded and paymentEventIssue marks the job for reconciliation (FUN-25).
// The target is the verified metadata job ID (the document read), never a stored id field.
// amountCents is the service money only; a crew tip on the same charge is tipCents.
async function commitStripePayment(env, jobId, job, patch, { sessionId, amountCents, tipCents, classed, clock, method, now, livemode, via, actor, writes = [] }) {
  const source = `${jobId}:stripeSessions:${sessionId}`, before = { ...job, id: jobId };
  let recorded;
  try {
    recorded = await moneyEventWrites({
      before, after: { ...before, ...patch }, now, idempotencyKey: { kind: 'stripeSession', value: sessionId }, actor, via, clock,
      source: { collection: 'jobs', id: source.length <= 180 ? source : jobId }, payment: { amountCents, tipCents, kind: classed.kind, kindInferred: classed.inferred, method },
      stripe: { sessionId, ...(typeof livemode === 'boolean' ? { livemode } : {}) },
    });
  } catch (error) {
    if (!/^funnel_/.test(error?.code || '')) throw error;
    recorded = { patch: { paymentEventIssue: { code: error.code, sessionId, at: now } }, writes: [] };
  }
  await moneyStorage(env).commit([{ collection: 'jobs', id: jobId, revision: job.__updateTime, patch: { ...patch, ...recorded.patch } }, ...writes, ...recorded.writes]);
}

// One verified path for every EGC Checkout kind. The Stripe session ID saved on
// the job is the idempotency key, so a webhook, a browser return and their
// replays can arrive in any order and still record a charge exactly once.
// Every caller passes the session read from Stripe with its charge expanded
// (expand[]=payment_intent.latest_charge), so a refund is always seen; the
// webhook reads it again (readStripeCheckout) because its payload has no charge.
// settleHeld:false (the webhook) never puts a charge that already has an open
// review on the job: only a person's action does (a browser return or Review queues).
// holdOnly:true (the charge.refunded webhook) only ever holds: it opens or updates
// a review for a refund Stripe shows, and otherwise throws nothingHeld without
// writing anything, so booking is left to the completion webhook and the returns.
// A tipped checkout (metadata.tip_cents) is split into its service part
// (serviceCents: the only money that counts toward the job, its balance check and
// payment.amount) and the tip (payment.tips[]). A tipped charge is never booked
// automatically while it has any review, whoever returns (settleHeld does not
// apply to it), and one paid after its job closed (tipRefusal) is held as
// payment_tip_refused; only Review queues closes those reviews.
// Every error that says a review holds the charge carries reviewRecorded, and
// reviewOpen: true when an open review holds it now (one is queued for a person),
// false when the charge's reviews are all closed (payment_review_resolved).
// With FUNNEL_PAYMENT_EVENTS_ENABLED (and MONEY_API_ENABLED) the booking write
// also carries the charge's payment.received event and any paid-in-full
// crossing (FUN-33, commitStripePayment), keyed by the session ID and dated at
// the Stripe charge; every hold, refund and review rule above is unchanged.
// fromWebhook is true only for the Stripe webhook delivery (who recorded the payment).
// With MONEY_INVOICE_STATE_ENABLED (money-core invoiceState) a charge updates job.invoice only when it takes payments
// (money-core invoiceTakesPayment: issued, or numbered and live, exactly as before the flag). On any other job it writes
// the payment, deposit and ledger evidence only: job.invoice is left exactly as it was, and never gets a status or balance.
async function recordStripeCheckout(env, checkout, { kind, expectedJobId = '', recordedBy = '', settleHeld = true, holdOnly = false, now = new Date().toISOString(), fromWebhook = false }) {
  const crew = kind === CHECKOUT_KINDS.crew, { jobId, sessionId, tipCents, serviceCents } = verifiedCheckout(checkout, kind, expectedJobId), text = HELD[crew ? 'crew' : 'portal'];
  const events = funnelPaymentEventsEnabled(env), mode = moneyTotalsMode(env), invoiceState = moneyInvoiceStateEnabled(env);
  // Money is recorded only from a session whose charge was read: fail closed (retryable) otherwise.
  if (!plainObject(checkout.payment_intent) || !plainObject(checkout.payment_intent.latest_charge)) throw failure('Stripe could not confirm this payment. Please try again.', 503, 'payment_charge_unread');
  const ledger = crew ? null : await readLedger(env, jobId), ledgerTip = Number(ledger?.state.tipCents || 0);
  // The portal ledger keeps the service amount and the tip apart; together they are what Stripe charged.
  if (ledger?.state.sessionId === sessionId && (Number(ledger.state.amountCents) + ledgerTip !== checkout.amount_total || ledgerTip !== tipCents)) throw failure('The payment amount does not match this checkout');
  const paymentIntentId = clean(checkout.payment_intent.id), charge = checkout.payment_intent.latest_charge;
  const tipped = tipCents ? { tipPaid: tipCents / 100 } : {};
  // An existing review is already durable (create-only, first record wins); otherwise create it first.
  // id is the review document (the session ID, or its refund follow-up). A tipped review also names the payments a
  // person had recorded on the job by hand when it was held (jobLedgerIds), so Review queues counts only the service
  // money recorded since (stripe-reviews keptServiceMissing), never a payment that was already there.
  const heldForReview = async (job, finance, reason, message, review = null, extra = {}, id = sessionId) => {
    if (!review) await recordPaymentReview(env, {
      sessionId, jobId, kind, reason, status: 'open', amountCents: checkout.amount_total, ...(tipCents ? { tipCents, jobLedgerIds: manualEntryIds(job) } : {}), currency: 'usd', paymentIntentId, livemode: checkout.livemode === true,
      jobRevision: job.__updateTime, jobTotalCents: cents(finance.total), jobPaidCents: cents(finance.paid), jobBalanceCents: cents(finance.balance),
      createdBy: crew ? clean(checkout.metadata?.created_by, 80) : 'customer_portal', recordedBy: clean(recordedBy, 80), createdAt: now, ...extra,
    }, id);
    return Object.assign(failure(message, 409, reason), { reviewRecorded: true, reviewOpen: true });
  };
  // Every review of this charge is closed and settled what Stripe shows: nothing is queued for a person.
  const resolved = (message, extra = {}) => Object.assign(failure(message, 409, 'payment_review_resolved'), { reviewRecorded: true, reviewOpen: false, ...extra });
  // holdOnly found nothing to hold: nothing was written.
  const nothingHeld = () => Object.assign(failure('Stripe shows no refund on this charge and no review holds it, so nothing was held.', 409, 'payment_nothing_held'), { nothingHeld: true });
  // A charge's reviews form a chain: {sessionId}, then {sessionId}:refund, {sessionId}:refund:2 ... each created only
  // once the one before it was closed and Stripe later showed more refunded than it settled. The chain is walked from
  // `review` to its open review, or to the next id free for a follow-up; the last closed review is the latest word on the
  // charge (an earlier review that settled more, a refund recorded and then closed as "Stripe no longer shows a refund",
  // settles nothing now). lastSettled is what that last close settled, null when `review` is open or missing. A
  // follow-up names the earlier close (followUpOf, priorResolution, the reason the charge was first held) and, when it
  // recorded a refund, what it settled (priorRefundedCents) and, on a tipped charge, the service part and tip it left
  // kept, so Review queues reads only the refund beyond it.
  const refundChain = async review => {
    let extra = {}, id = sessionId, lastSettled = null;
    for (let index = 1; review && review.status !== 'open'; index++) {
      lastSettled = settledRefundCents(review);
      if (index > MAX_REFUND_FOLLOW_UPS) break;
      const heldReason = review.reason && review.reason !== 'payment_refunded' ? review.reason : review.heldReason;
      const priorSplit = lastSettled > 0 && lastSettled !== Number.MAX_SAFE_INTEGER && Number.isSafeInteger(review.keptServiceCents) && Number.isSafeInteger(review.keptTipCents) ? { priorKeptServiceCents: review.keptServiceCents, priorKeptTipCents: review.keptTipCents } : {};
      extra = { followUpOf: sessionId, ...(review.resolution ? { priorResolution: clean(review.resolution, 30) } : {}), ...(heldReason ? { heldReason: clean(heldReason, 60) } : {}), ...(lastSettled > 0 ? { priorRefundedCents: lastSettled, ...priorSplit } : {}) };
      id = refundFollowUpId(sessionId, index);
      review = await readPaymentReview(env, sessionId, id);
    }
    return { review, extra, id, lastSettled };
  };
  // A tipped portal charge held for a person marks its checkout ledger 'held', so
  // Pay stops re-reading this session and the portal shows the payment held. It is
  // only a mark: the review keeps the charge off the job, and every reader checks
  // the review again (portalPaymentHeld, createCustomerStripeCheckout), so a mark
  // that outlives a resolve never holds Pay. Best effort; never written without a tip.
  const markLedgerHeld = async reason => {
    if (crew || !tipCents || ledger.state.sessionId !== sessionId || ledger.state.status === 'held') return;
    try { await saveLedger(env, jobId, { ...ledger.state, status: 'held', heldReason: reason, heldAt: now }, ledger.version); } catch { /* The review still holds the charge. */ }
  };
  // Marks an open review with the refund Stripe shows now (under its revision). 'saved' when nothing had to change.
  const markRefund = async (review, refundedCents) => {
    if (!review || (review.reason === 'payment_refunded' && review.refundedCents === refundedCents)) return 'saved';
    return patchPaymentReview(env, review, { reason: 'payment_refunded', ...(review.reason !== 'payment_refunded' ? { heldReason: clean(review.reason, 60) } : {}), refundedCents, refundSeenAt: now, updatedAt: now });
  };
  let storageFailed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    // finance is what payment.amount is written from (the recorded paid total); served is the figure shown and capped
    // (FIX-MONEY-TOTALS: money-core's unified totals in mode 'unified', else the same figures).
    const job = await paymentJob(env, jobId), finance = customerMoneyState(job), served = mode === 'unified' ? customerMoneyState(job, mode) : finance;
    if (mode === 'shadow' && attempt === 0) customerTotalsShadow(job, crew ? 'crew_payment_record' : 'payment_record');
    if (knownSession(job, sessionId)) {
      // The job already counts this charge as paid and Stripe now shows a refund:
      // the job is left as it is, and the owner is told through a payment_refunded
      // review (created once, or the open one updated) instead of a silent duplicate.
      // Errors from here carry recordedOnJob: the job's balance already counts this
      // charge as paid, so a new checkout for that balance cannot charge it twice.
      if (chargeRefunded(charge)) {
        const refundedCents = refundedCentsOf(charge, checkout.amount_total);
        // When Stripe shows more refunded than the chain's last close settled (reconciled
        // before any refund, or a smaller refund recorded), the rest goes to the owner in
        // the next follow-up review, created once, never answered with a silent "already resolved".
        const { review, extra, id, lastSettled } = await refundChain(await readPaymentReview(env, sessionId));
        // Resolved only when the walk ends on a closed review that settled at least what Stripe shows.
        if (lastSettled !== null && review?.status !== 'open') {
          if (refundedCents <= lastSettled) throw resolved(text.payment_review_resolved_on_job, { recordedOnJob: true });
          // Every follow-up is used and closed: fail closed rather than open one past the last.
          if (review) throw failure('Payment information is temporarily unavailable', 503, 'payment_storage_unavailable');
        }
        const marked = review ? await markRefund(review, refundedCents) : 'saved';
        if (marked !== 'saved') { storageFailed = marked === 'failed'; continue; }
        // Without the checkout block the balance (which already counts this charge) can still be paid: say so.
        const message = paymentReviewCheckoutBlockEnabled(env) ? text.payment_refunded_on_job : text.payment_refunded_on_job_balance_open;
        throw Object.assign(await heldForReview(job, finance, 'payment_refunded', message, review, { ...extra, refundedCents, refundSeenAt: now }, id), { recordedOnJob: true });
      }
      // holdOnly never touches a charge already on the job that Stripe shows no refund on (not even its receipt link).
      if (holdOnly) throw nothingHeld();
      const latest = job.payment.stripeSessions.at(-1), saved = job.payment.stripeSessions.find(item => String(item?.sessionId || item) === sessionId);
      const receiptUrl = String(latest?.sessionId || latest) === sessionId && RECEIPT_URL.test(charge.receipt_url || '') ? charge.receipt_url : job.payment.receiptUrl || '';
      let payment = job.payment;
      // A receipt Stripe issued after the charge was recorded is added to the
      // job without adding the payment again.
      if (receiptUrl && receiptUrl !== job.payment.receiptUrl) {
        try { await patchJob(env, jobId, { payment: { ...job.payment, receiptUrl } }, job.__updateTime); payment = { ...job.payment, receiptUrl }; }
        catch { if (attempt < 2) continue; }
      }
      const item = saved && typeof saved === 'object' ? saved : { sessionId, paymentIntentId, amount: serviceCents / 100 };
      // paymentSyncPayload is the crew closeout's HighLevel payment-received note: it keeps today's figures in every mode.
      return { result: { paid: true, duplicate: true, amountPaid: serviceCents / 100, ...tipped, balance: served.balance, receiptUrl }, payment, invoice: job.invoice || {}, paymentSyncPayload: { ...item, balance: finance.balance, paidTotal: finance.paid }, withheld: unsentQuoteDraft(job) };
    }
    // A review the office closed (reconciled elsewhere, refunded) is final:
    // neither a browser return nor a webhook retry ever puts that charge on the job.
    const review = await readPaymentReview(env, sessionId);
    if (review && review.status !== 'open') {
      if (!chargeRefunded(charge)) throw resolved(text.payment_review_resolved);
      // Stripe shows more refunded than the chain's last close settled (a partial refund recorded with the money kept
      // put on the job by hand, or a charge reconciled before any refund): the owner gets the next follow-up review,
      // exactly as for a charge on the job, so what that close recorded or applied elsewhere is corrected, never a
      // silent "already resolved". No more than it settled: resolved, nothing queued.
      const refundedCents = refundedCentsOf(charge, checkout.amount_total), chain = await refundChain(review);
      if (chain.review?.status !== 'open') {
        if (refundedCents <= chain.lastSettled) throw resolved(text.payment_review_resolved);
        if (chain.review) throw failure('Payment information is temporarily unavailable', 503, 'payment_storage_unavailable');
      }
      const marked = chain.review ? await markRefund(chain.review, refundedCents) : 'saved';
      if (marked !== 'saved') { storageFailed = marked === 'failed'; continue; }
      throw await heldForReview(job, finance, 'payment_refunded', text.payment_refunded, chain.review, { ...chain.extra, refundedCents, refundSeenAt: now }, chain.id);
    }
    // holdOnly: Stripe shows no refund and no review holds the charge, so there is nothing to hold; booking it is left
    // to the completion webhook and the returns.
    if (holdOnly && !review && !chargeRefunded(charge)) throw nothingHeld();
    // Money Stripe shows as refunded never counts as paid on its own, for any
    // checkout kind; the owner settles it in Review queues. A review opened for
    // another reason is updated (under its revision) so the queue shows the refund.
    if (chargeRefunded(charge) || review?.reason === 'payment_refunded') {
      const refundedCents = chargeRefunded(charge) ? refundedCentsOf(charge, checkout.amount_total) : null;
      const marked = refundedCents === null ? 'saved' : await markRefund(review, refundedCents);
      if (marked !== 'saved') { storageFailed = marked === 'failed'; continue; }
      const held = await heldForReview(job, finance, 'payment_refunded', text.payment_refunded, review, refundedCents === null ? {} : { refundedCents, refundSeenAt: now });
      await markLedgerHeld('payment_refunded');
      throw held;
    }
    // A tipped charge with any open review stays held whatever the job looks like
    // now (restored, re-invoiced, its refund record removed, its balance freed) and
    // whoever returns: it is never booked automatically, only closed in Review queues.
    if (tipCents && review) {
      const reason = clean(review.reason, 60) || 'payment_needs_review', held = await heldForReview(job, finance, reason, text[reason] || text.held, review);
      await markLedgerHeld(reason);
      throw held;
    }
    // A tip is refused when a checkout opens, but a tipped checkout opened earlier
    // can still be paid after the job is cancelled, marked a no-show, voided or
    // refunded: that charge is held too, never booked onto the closed job.
    if ((tipCents || crew && checkout.metadata?.field_pay_mode === 'exact_balance') && tipRefusal(job)) {
      const held = await heldForReview(job, finance, 'payment_tip_refused', text.payment_tip_refused);
      await markLedgerHeld('payment_tip_refused');
      throw held;
    }
    // A webhook never settles a charge that already has an open review: only a
    // person's action does (the crew return, or Review queues). Stripe gets 200
    // and the job is unchanged.
    if (review && !settleHeld) throw await heldForReview(job, finance, clean(review.reason, 60) || 'payment_needs_review', text.held, review);
    // holdOnly never books a charge, nor saves a receipt for one.
    if (holdOnly) throw nothingHeld();
    if (customerPaymentNeedsReview(job)) {
      if (crew) throw await heldForReview(job, finance, 'payment_needs_review', text.payment_needs_review, review);
      // A crew-entered receipt cannot become verified merely because a separate
      // Stripe charge succeeds. Keep the confirmed charge durably recoverable,
      // and let Stripe retry after the manager verifies the earlier receipt.
      // amount is everything Stripe charged; a tipped charge also keeps serviceAmount (what counts toward the balance)
      // and tipCents apart, so settling it by hand never books the tip as service money.
      await saveLedger(env, jobId, { ...ledger.state, verifiedReceipt: { sessionId, amount: checkout.amount_total / 100, ...(tipCents ? { serviceAmount: serviceCents / 100, tipCents } : {}), paymentIntentId, confirmedAt: now }, requiresReview: true }, ledger.version);
      throw failure('Your Stripe payment is confirmed. An earlier recorded payment needs team verification before the balance can be updated. Please do not pay again.', 409, 'payment_needs_review');
    }
    // A crew link was sized to the balance when it opened. A payment recorded
    // since then means this charge needs a manager before it changes the job.
    // Only the service part is checked against the balance; the tip never counts toward it.
    // Unified money that cannot be read is never measured against a guess: a person settles the charge.
    if (crew && (served.unknown || cents(served.total) <= 0 || serviceCents > cents(served.balance) || checkout.metadata?.field_pay_mode === 'exact_balance' && serviceCents !== cents(served.balance))) throw await heldForReview(job, finance, 'payment_exceeds_balance', text.payment_exceeds_balance, review);
    // Only the service part is paid toward the job; the tip is kept in payment.tips.
    const paidCents = cents(finance.paid) + serviceCents, appliedCents = served === finance || served.unknown ? paidCents : cents(served.paid) + serviceCents, totalCents = cents(served.total);
    // Preserve every confirmed dollar, including any unexpected excess, for reconciliation.
    const paidTotal = paidCents / 100, balance = Math.max(0, totalCents - appliedCents) / 100;
    const deposit = customerDepositState(job, { ...finance, paid: paidTotal, balance });
    const receiptUrl = RECEIPT_URL.test(charge.receipt_url || '') ? charge.receipt_url : job.payment?.receiptUrl || '';
    const receiptEmail = clean(checkout.customer_details?.email || checkout.customer_email);
    const tipField = tipCents ? { tipCents } : {};
    const fieldExact = crew && checkout.metadata?.field_pay_mode === 'exact_balance';
    const paymentItem = crew
      ? { sessionId, paymentIntentId, amount: serviceCents / 100, ...tipField, ...(fieldExact ? { fieldExact: true } : {}), receiptEmail, createdBy: clean(checkout.metadata?.created_by, 80), recordedBy: clean(recordedBy, 80), verifiedAt: now }
      : { sessionId, paymentIntentId, amount: serviceCents / 100, ...tipField, purpose: clean(checkout.metadata?.payment_purpose, 20), quoteRevision: clean(checkout.metadata?.quote_revision, 20), quotedTotalCents: Number(checkout.metadata?.quoted_total_cents || 0), verifiedAt: now };
    // FUN-33: a payment without a purpose (every crew link) is classed by the payment kind rule for its funnel
    // event (a tipped charge is always a balance). The session keeps its own purpose (none): the inference is
    // only noted beside it, so the ledger, receipts and invoices read it exactly as before.
    const clock = events ? stripeChargeClock(checkout, now) : {}, classed = events ? paymentKind(job, { purpose: paymentItem.purpose, amountCents: serviceCents, tipCents, occurredAt: clock.occurredAt || now }) : null;
    if (classed?.inferred) paymentItem.inferredKind = classed.kind;
    const trustedSessions = job.payment?.verified === true ? (job.payment.stripeSessions || []) : [];
    const trustedTips = job.payment?.verified === true && Array.isArray(job.payment.tips) ? job.payment.tips : [];
    const tip = tipCents ? { sessionId, paymentIntentId, amountCents: tipCents, amount: tipCents / 100, source: crew ? 'crew_card' : 'customer_portal', createdBy: clean(checkout.metadata?.created_by, 80), recordedBy: clean(recordedBy, 80) || 'stripe', verifiedAt: now } : null;
    const tips = tip || Array.isArray(job.payment?.tips) ? { tips: [...trustedTips, ...(tip ? [tip] : [])] } : {};
    const payment = { ...(job.payment || {}), amount: paidTotal, lastAmount: paymentItem.amount, lastReceivedAt: now, method: 'stripe', processor: 'stripe', verified: true, receiptUrl, receiptEmail, reference: paymentIntentId || sessionId, stripeSessions: [...trustedSessions, paymentItem], ...tips, ...(crew ? { recordedBy: paymentItem.recordedBy } : {}) };
    const invoice = invoiceState && !invoiceTakesPayment(job.invoice) ? null : { ...(job.invoice || {}), amount: served.total, paid: appliedCents / 100, balance, status: balance < .01 ? 'paid' : 'partial', updatedAt: now };
    // The crew closeout sends this to HighLevel as its payment-received note (crew/postjob.html syncStripePaymentToHighLevel), so
    // it quotes today's figures in every mode, like every other HighLevel note; the answer and the invoice mirror are served money.
    const paymentSyncPayload = { ...paymentItem, balance: Math.max(0, cents(finance.total) - paidCents) / 100, paidTotal };
    const patch = {
      payment,
      deposit: { ...(job.deposit || {}), amount: deposit.required, paidAmount: deposit.paid, status: deposit.due < .01 ? 'paid' : deposit.paid ? 'partial' : 'due', verified: true, updatedAt: now },
      ...(invoice ? { invoice } : {}), paymentSyncStatus: 'pending', paymentSyncPayload,
      ...(fieldExact ? { fieldPaymentSyncPendingIds: [...new Set([...(Array.isArray(job.fieldPaymentSyncPendingIds) ? job.fieldPaymentSyncPendingIds : []), `card:${sessionId}`])] } : {}),
      ...(appliedCents > totalCents ? { paymentReviewRequired: true } : {}), updatedAt: now,
    };
    const mark = { jobRecordedAt: now, jobRecordedBy: clean(recordedBy, 80) };
    try {
      // FUN-33: the same booking as below, as one :commit with the charge's funnel events and the same review
      // preconditions. A held session's open review gets the same mark under its revision, so a manager resolving
      // it at the same time fails this commit; a tipped charge with no review carries the same "still no review"
      // precondition as patchJobUnlessReviewed, so a review created after this read fails it (money_revision_conflict)
      // and the retry takes the hold path. An untipped charge with no review has no review write, as below.
      if (events) await commitStripePayment(env, jobId, job, patch, { sessionId, amountCents: serviceCents, tipCents, classed, clock, method: stripePaymentMethod(checkout), now, livemode: checkout.livemode, ...paymentSource({ fromWebhook, crew, recordedBy }),
        writes: review ? [{ collection: PAYMENT_REVIEW_COLLECTION, id: review.sessionId, revision: review.revision, patch: mark }]
          : tipCents ? [{ collection: PAYMENT_REVIEW_COLLECTION, id: sessionId, delete: true, exists: false }] : [] });
      else if (review) await patchJobWithReview(env, jobId, patch, job.__updateTime, review, mark);
      // A tipped charge is booked only while it still has no review: a webhook or return that saw a refund Stripe shows
      // after this read creates payment_reviews/{sessionId}, which fails this commit, and the retry takes the hold path.
      else if (tipCents) await patchJobUnlessReviewed(env, jobId, patch, job.__updateTime, sessionId);
      else await patchJob(env, jobId, patch, job.__updateTime);
      return { result: { paid: true, duplicate: false, amountPaid: paymentItem.amount, ...tipped, balance, receiptUrl }, payment, invoice: invoice || job.invoice || {}, paymentSyncPayload, withheld: unsentQuoteDraft(job) };
    } catch (error) { storageFailed = !staleJobWrite(error); } // Firestore answers a stale updateTime with 400 FAILED_PRECONDITION.
  }
  // Each retry re-reads the job, so a write whose response was lost is found above as a duplicate.
  throw storageFailed ? failure('Payment information is temporarily unavailable', 503, 'payment_storage_unavailable') : failure('The payment record changed. Refresh to confirm the latest balance.', 409, 'payment_changed');
}

// recordedBy names who saw a held charge first ('customer_portal' for the portal
// return, 'stripe_webhook' for the webhook); settleHeld:false is the webhook;
// holdOnly:true (charge.refunded) never books, and throws nothingHeld when there is nothing to hold.
// fromWebhook:true (the checkout.session webhook) records a FUN-33 payment event as the Stripe webhook's.
// While a Hub quote draft has an unsent revision, the job's total is that revision, so the customer's reply
// (verify_payment, and create_payment's alreadyPaid) confirms the payment without a balance measured against
// terms they have not been sent. The payment itself is recorded in full either way.
export async function recordCustomerStripePayment(env, checkout, expectedJobId = '', now = new Date().toISOString(), { recordedBy = 'customer_portal', settleHeld = true, holdOnly = false, fromWebhook = false } = {}) {
  const { result, withheld } = await recordStripeCheckout(env, checkout, { kind: CHECKOUT_KINDS.portal, expectedJobId, recordedBy, settleHeld, holdOnly, now, fromWebhook });
  if (!withheld) return result;
  const { balance, ...confirmed } = result;
  return { ...confirmed, balanceWithheld: true };
}

// Crew card links (job-payment.js) settle through the same verification from
// the Stripe webhook or the crew browser return; the latter also receives the
// recorded job copy it shows during closeout.
export async function recordCrewStripePayment(env, checkout, { expectedJobId = '', recordedBy = '', settleHeld = true, holdOnly = false, now = new Date().toISOString(), fromWebhook = false } = {}) {
  const { result, payment, invoice, paymentSyncPayload } = await recordStripeCheckout(env, checkout, { kind: CHECKOUT_KINDS.crew, expectedJobId, recordedBy, settleHeld, holdOnly, now, fromWebhook });
  if (result.paid && checkout.metadata?.field_pay_mode === 'exact_balance') {
    // Either the Stripe webhook or the crew return may settle first. Clearing
    // the durable field claim is best effort; the verified job payment itself
    // is already committed and the next exact checkout still checks balance.
    const store = moneyStorage(env), claim = await store.read(FIELD_CARD_CHECKOUTS, expectedJobId || checkout.metadata.job_id).catch(() => null);
    if (activeFieldCard(claim) && claim.sessionId === checkout.id) await fieldCardClose(store, claim, 'settled').catch(() => null);
    // The verified charge and retry marker are already durable. A CRM outage
    // records an error for manager retry and never changes the money result.
    await syncFieldPayment(env, store, expectedJobId || checkout.metadata.job_id, 'card', checkout.id).catch(() => null);
  }
  return { ...result, payment, invoice, paymentSyncPayload };
}


/**
 * Whether Pay is held for this job right now (the portal GET, with tips on only).
 * 'held' is derived from the reviews, never trusted from a mark: the portal
 * checkout ledger marked 'held' counts only while that session's review is still
 * open (a missing review counts as held, failing closed); a mark whose review was
 * resolved is not held and is settled here, best effort. Otherwise it is held
 * when checkoutHold finds a review that would refuse a new checkout. Throws 503
 * when either cannot be read. `now` (ISO) stamps a settled mark.
 */
export async function portalPaymentHeld(env, jobId, job = null, now = new Date().toISOString()) {
  const ledger = await readLedger(env, jobId);
  if (ledger.state.status === 'held') {
    const review = ledger.state.sessionId ? await readPaymentReview(env, ledger.state.sessionId) : null;
    if (!review || review.status === 'open') return true;
    await saveLedger(env, jobId, { ...ledger.state, status: 'settled', settledAt: now, settledBy: 'review_resolved' }, ledger.version).catch(() => null);
  }
  return Boolean(await checkoutHold(env, jobId, job));
}

// A checkout with no tip keeps the exact fingerprint it had before tips existed,
// so an open session saved earlier is still resumed rather than expired. It is
// taken over the figures the checkout charges in the money totals `mode`.
const fingerprint = (job, tipCents = 0, mode = 'off') => JSON.stringify({ total: customerMoneyState(job, mode).total, paid: customerMoneyState(job, mode).paid, ...customerDepositState(job, undefined, mode), revision: job.estimate?.revision || 1, approval: job.customerApproval?.status || job.estimate?.status || job.quoteStatus || '', status: job.pipelineStatus || job.status || '', ...(tipCents ? { tipCents } : {}) });
// An open portal checkout whose saved fingerprint (with its saved tip) differs no longer matches the quote.
export const checkoutFingerprint = (job, tipCents = 0, mode = 'off') => fingerprint(job, tipCents, mode);

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
  try { due = cents(payable(job, moneyTotalsMode(env)).dueNow); } catch { /* nothing may be charged now: close it */ }
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

// now (ISO) stamps a charge this call records or holds for review, and the checkout claim it saves.
export async function createCustomerStripeCheckout(env, secret, jobId, origin, { tipCents = 0, now = new Date().toISOString() } = {}) {
  let ledger = await readLedger(env, jobId), state = ledger.state;
  let job = await readJob(env, jobId);
  if (!job?.__updateTime) throw failure('Payment information is temporarily unavailable', 503);
  // The checkout charges the money totals mode's figures (FIX-MONEY-TOTALS); shadow logs how they differ from unified.
  const mode = moneyTotalsMode(env);
  // Check a tip against the job and the balance before any earlier checkout is resumed or expired.
  if (requestTip(tipCents)) {
    const refusal = tipRefusal(job);
    if (refusal) throw failure(refusal, 409, 'tip_unavailable');
    const due = payable(job, mode); validTip(tipCents, cents(due.dueNow), due.purpose);
  }
  // A portal checkout marked held (a tipped charge held for a person) is checked
  // against its review before Stripe is read: while the review is open (or cannot
  // be found) Pay is refused; once Review queues resolved it, the mark is settled
  // here and the balance can be paid. The held charge is never booked from here.
  if (state.status === 'held') {
    const review = state.sessionId ? await readPaymentReview(env, state.sessionId) : null;
    if (!review || review.status === 'open') throw Object.assign(failure(CHECKOUT_HOLD_TEXT.portal, 409, CHECKOUT_HOLD_CODE), { reviewRecorded: true });
    ledger = await saveLedger(env, jobId, { ...state, status: 'settled', settledAt: now, settledBy: 'review_resolved' }, ledger.version);
    state = ledger.state;
  }
  // With tips on, a held tipped charge (this portal checkout's, or a crew card
  // link's) and, with PAYMENT_REVIEW_CHECKOUT_BLOCK_ENABLED, any open review stop
  // Pay before Stripe is read; the review decides and nothing is written here.
  // Tips off: the block flag alone is checked where it always was, below.
  const tips = customerTipsEnabled(env);
  if (tips) await checkoutReviewHold(env, jobId, job);
  let checkout;
  if (state.status === 'creating' && !state.sessionId) {
    // Persist both the key and exact parameters before Stripe. A lost response or
    // another browser can only recover the same session, never create a second.
    if (Date.parse(now) - Date.parse(state.createdAt) > 23 * 3600000) throw failure('An earlier checkout needs confirmation by the team before another payment can be opened.');
    // A field collection may have claimed this job after the portal first
    // saved its checkout intent. Re-read before contacting Stripe.
    const current = await readJob(env, jobId);
    const due = payable(current, mode);
    if (cents(due.dueNow) !== state.amountCents) throw failure('The balance changed before the card checkout opened. Refresh before paying.', 409, 'payment_balance_changed');
    checkout = await stripeRequest(secret, 'checkout/sessions', { method: 'POST', headers: { 'Idempotency-Key': state.key }, body: new URLSearchParams(state.params) });
    if (!checkout.id) throw failure('Stripe did not confirm a checkout session', 502);
    ledger = await saveLedger(env, jobId, { ...state, sessionId: checkout.id, status: 'open' }, ledger.version);
    state = ledger.state;
  }
  if (state.sessionId && !['expired', 'settled'].includes(state.status)) {
    checkout = checkout || await stripeRequest(secret, `checkout/sessions/${encodeURIComponent(state.sessionId)}?expand[]=payment_intent.latest_charge`);
    if (checkout.status === 'complete') {
      if (checkout.payment_status !== 'paid') throw failure('Your previous payment is still processing. Please wait before paying again.');
      // A charge held for review (for example, one Stripe shows refunded, or a
      // tipped charge on a job that closed) stops here with its "do not pay again"
      // message. Once the office has resolved it, that checkout is settled and the
      // current balance can be paid.
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
      // The same tip resumes it; a different tip (or none) expires it below.
      let stillPayable = false;
      const savedTip = Number(state.tipCents || 0);
      try { stillPayable = payable(job, mode).dueNow >= .5; } catch { /* Expire stale/cancelled scope below. */ }
      if (stillPayable && state.fingerprint === fingerprint(job, tipCents, mode) && checkout.amount_total === state.amountCents + savedTip && /^https:\/\/checkout\.stripe\.com\//.test(checkout.url || '')) {
        if (!tips) await checkoutReviewHold(env, jobId, job);
        return { ok: true, url: checkout.url, amount: state.amountCents / 100, ...(savedTip ? { tip: savedTip / 100 } : {}), purpose: state.purpose };
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
  if (mode === 'shadow') customerTotalsShadow(job, 'checkout');
  const deposit = payable(job, mode), amountCents = cents(deposit.dueNow), changeCents = billedChangeCents(job);
  if (amountCents < 50) throw failure(customerMoneyState(job, mode).balance < .5 ? 'There is no outstanding balance' : 'Your deposit is paid. The remaining balance is due on completion.');
  const tip = validTip(tipCents, amountCents, deposit.purpose);
  if (!tips) await checkoutReviewHold(env, jobId, job);
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
    'metadata[quote_revision]': String(job.estimate?.revision || 1), 'metadata[quoted_total_cents]': String(cents(customerMoneyState(job, mode).total)),
    'payment_intent_data[metadata][kind]': 'egc_customer_portal_payment', 'payment_intent_data[metadata][job_id]': jobId, 'payment_intent_data[metadata][payment_purpose]': deposit.purpose,
  });
  if (changeCents) params.set('metadata[approved_change_cents]', String(changeCents));
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(job.email || '')) {
    params.set('customer_email', job.email); params.set('payment_intent_data[receipt_email]', job.email);
  }
  addTipLine(params, tip);
  state = { status: 'creating', sessionId: '', key: `egc-customer-payment:${crypto.randomUUID()}`, params: params.toString(), amountCents, ...(tip ? { tipCents: tip } : {}), purpose: deposit.purpose, fingerprint: fingerprint(job, tip, mode), createdAt: now };
  await saveLedger(env, jobId, state, ledger.version);
  // Recover through the same path, including the current-scope check, before returning a link.
  return createCustomerStripeCheckout(env, secret, jobId, origin, { tipCents, now });
}
