import { firestoreFetch } from './firebase-service-account.js';
import { readJob, patchJob, encodeFirestoreFields, decodeFirestoreFields } from './firestore-job.js';

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

export function customerMoneyState(job) {
  // Crew can update an unpaid invoice during closeout, but cannot edit these
  // protected quote fields. An invoice never authorizes a larger card charge.
  const totalCents = cents(job.estimate?.amount ?? job.total ?? job.priceQuoted ?? job.lockedTotal ?? job.rate ?? job.customerApproval?.amount);
  const paidCents = cents(job.payment?.amount ?? job.invoice?.paid ?? job.invoice?.amountPaid ?? job.deposit?.paidAmount);
  return { total: totalCents / 100, paid: paidCents / 100, balance: Math.max(0, totalCents - paidCents) / 100 };
}

export function customerDepositState(job, finance = customerMoneyState(job)) {
  // Honor an existing signed deposit term; every new quote defaults to 50%.
  const saved = job.estimate?.depositRequired ?? job.deposit?.amount;
  const requiredCents = Math.min(cents(finance.total), saved == null ? Math.round(cents(finance.total) / 2) : cents(saved));
  const dueCents = Math.max(0, requiredCents - cents(finance.paid));
  const rawStatus = String(job.pipelineStatus || job.status || '').toLowerCase();
  const finalWalkthroughDone = (job.postJobProgress?.standardItems || []).some(item => item.key === '0_1' && item.completed === true);
  const closing = ['completed', 'paid'].includes(rawStatus) || Boolean(job.completedAt || job.postJobChecklist?.completedAt || finalWalkthroughDone);
  const amountDue = closing ? finance.balance : dueCents / 100;
  return { required: requiredCents / 100, paid: Math.min(requiredCents, cents(finance.paid)) / 100, due: dueCents / 100, dueNow: amountDue, purpose: closing ? 'balance' : 'deposit', remainder: Math.max(0, cents(finance.balance) - cents(amountDue)) / 100 };
}

function payable(job) {
  if (!job || [job.status, job.pipelineStatus].some(status => ['cancelled', 'canceled', 'superseded', 'lost'].includes(String(status || '').toLowerCase()))) throw failure('This job is not available for payment');
  if (customerPaymentNeedsReview(job)) throw failure('A recorded payment is awaiting team verification. Please wait before paying again.');
  const status = String(job.customerApproval?.status || job.estimate?.status || job.quoteStatus || '').toLowerCase();
  if (!['accepted', 'approved'].includes(status) && !['completed', 'paid'].includes(String(job.pipelineStatus || job.status || '').toLowerCase())) throw failure('Approve the estimate before paying');
  return customerDepositState(job);
}

export async function stripeRequest(secret, path, options = {}) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    ...options,
    headers: { Authorization: `Basic ${btoa(`${secret}:`)}`, ...(options.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw failure('Secure checkout could not be confirmed. Please try again.', 502);
  return data;
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

// A Stripe-confirmed crew charge that the job cannot take (it exceeds the
// balance, or an unverified receipt is on the job) is never left only in
// Stripe's retry queue. payment_reviews/{sessionId} is server-only and
// create-only, so the webhook and the crew return can both record it and the
// first record wins. The job's money fields stay exactly as they were.
export const PAYMENT_REVIEW_COLLECTION = 'payment_reviews';
const reviewUrl = sessionId => `${DB}/${PAYMENT_REVIEW_COLLECTION}/${encodeURIComponent(sessionId)}`;
async function recordPaymentReview(env, review) {
  const url = new URL(reviewUrl(review.sessionId));
  url.searchParams.set('currentDocument.exists', 'false');
  let response = null;
  try { response = await firestoreFetch(env, url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: encodeFirestoreFields(review) }) }); }
  catch { /* A lost response is settled by the read below. */ }
  if (response?.ok) return;
  // Already recorded by an earlier delivery, or our create landed without a response.
  const saved = await firestoreFetch(env, reviewUrl(review.sessionId)).catch(() => null);
  const doc = saved?.ok ? await saved.json().catch(() => null) : null;
  if (doc?.updateTime && decodeFirestoreFields(doc.fields || {}).sessionId === review.sessionId) return;
  throw failure('Payment information is temporarily unavailable', 503, 'payment_storage_unavailable');
}

// One verified path for every EGC Checkout kind. The Stripe session ID saved on
// the job is the idempotency key, so a webhook, a browser return and their
// replays can arrive in any order and still record a charge exactly once.
async function recordStripeCheckout(env, checkout, { kind, expectedJobId = '', recordedBy = '', now = new Date().toISOString() }) {
  const crew = kind === CHECKOUT_KINDS.crew, { jobId, sessionId } = verifiedCheckout(checkout, kind, expectedJobId);
  const ledger = crew ? null : await readLedger(env, jobId);
  if (ledger?.state.sessionId === sessionId && Number(ledger.state.amountCents) !== checkout.amount_total) throw failure('The payment amount does not match this checkout');
  const paymentIntentId = clean(checkout.payment_intent?.id || checkout.payment_intent), charge = checkout.payment_intent?.latest_charge || {};
  const heldForReview = async (job, finance, reason, message) => {
    await recordPaymentReview(env, {
      sessionId, jobId, kind, reason, status: 'open', amountCents: checkout.amount_total, currency: 'usd', paymentIntentId, livemode: checkout.livemode === true,
      jobRevision: job.__updateTime, jobTotalCents: cents(finance.total), jobPaidCents: cents(finance.paid), jobBalanceCents: cents(finance.balance),
      createdBy: clean(checkout.metadata?.created_by, 80), recordedBy: clean(recordedBy, 80), createdAt: now,
    });
    return Object.assign(failure(message, 409, reason), { reviewRecorded: true });
  };
  let storageFailed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const job = await paymentJob(env, jobId), finance = customerMoneyState(job);
    if (knownSession(job, sessionId)) {
      const latest = job.payment.stripeSessions.at(-1), saved = job.payment.stripeSessions.find(item => String(item?.sessionId || item) === sessionId);
      const receiptUrl = String(latest?.sessionId || latest) === sessionId && RECEIPT_URL.test(charge.receipt_url || '') ? charge.receipt_url : job.payment.receiptUrl || '';
      let payment = job.payment;
      // Webhooks usually contain only a PaymentIntent ID. Enrich its receipt on
      // the expanded browser verification without adding the payment again.
      if (receiptUrl && receiptUrl !== job.payment.receiptUrl) {
        try { await patchJob(env, jobId, { payment: { ...job.payment, receiptUrl } }, job.__updateTime); payment = { ...job.payment, receiptUrl }; }
        catch { if (attempt < 2) continue; }
      }
      const item = saved && typeof saved === 'object' ? saved : { sessionId, paymentIntentId, amount: checkout.amount_total / 100 };
      return { result: { paid: true, duplicate: true, amountPaid: checkout.amount_total / 100, balance: finance.balance, receiptUrl }, payment, invoice: job.invoice || {}, paymentSyncPayload: { ...item, balance: finance.balance, paidTotal: finance.paid } };
    }
    if (customerPaymentNeedsReview(job)) {
      if (crew) throw await heldForReview(job, finance, 'payment_needs_review', 'Stripe confirmed this payment, but an earlier recorded payment needs manager verification. The charge is saved for manager review. Do not charge again.');
      // A crew-entered receipt cannot become verified merely because a separate
      // Stripe charge succeeds. Keep the confirmed charge durably recoverable,
      // and let Stripe retry after the manager verifies the earlier receipt.
      await saveLedger(env, jobId, { ...ledger.state, verifiedReceipt: { sessionId, amount: checkout.amount_total / 100, paymentIntentId, confirmedAt: now }, requiresReview: true }, ledger.version);
      throw failure('Your Stripe payment is confirmed. An earlier recorded payment needs team verification before the balance can be updated. Please do not pay again.', 409, 'payment_needs_review');
    }
    // A crew link was sized to the balance when it opened. A payment recorded
    // since then means this charge needs a manager before it changes the job.
    if (crew && (cents(finance.total) <= 0 || checkout.amount_total > cents(finance.balance))) throw await heldForReview(job, finance, 'payment_exceeds_balance', 'Stripe confirmed this payment, but it exceeds the current job balance. The charge is saved for manager review. Do not charge again.');
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
    try {
      await patchJob(env, jobId, {
        payment,
        deposit: { ...(job.deposit || {}), amount: deposit.required, paidAmount: deposit.paid, status: deposit.due < .01 ? 'paid' : deposit.paid ? 'partial' : 'due', verified: true, updatedAt: now },
        invoice, paymentSyncStatus: 'pending', paymentSyncPayload,
        ...(paidTotal > finance.total ? { paymentReviewRequired: true } : {}), updatedAt: now,
      }, job.__updateTime);
      return { result: { paid: true, duplicate: false, amountPaid: paymentItem.amount, balance, receiptUrl }, payment, invoice, paymentSyncPayload };
    } catch (error) { storageFailed = ![400, 409, 412].includes(error.storageStatus); } // Firestore answers a stale updateTime with 400 FAILED_PRECONDITION.
  }
  // Each retry re-reads the job, so a write whose response was lost is found above as a duplicate.
  throw storageFailed ? failure('Payment information is temporarily unavailable', 503, 'payment_storage_unavailable') : failure('The payment record changed. Refresh to confirm the latest balance.', 409, 'payment_changed');
}

export async function recordCustomerStripePayment(env, checkout, expectedJobId = '', now = new Date().toISOString()) {
  return (await recordStripeCheckout(env, checkout, { kind: CHECKOUT_KINDS.portal, expectedJobId, now })).result;
}

// Crew card links (job-payment.js) settle through the same verification from
// the Stripe webhook or the crew browser return; the latter also receives the
// recorded job copy it shows during closeout.
export async function recordCrewStripePayment(env, checkout, { expectedJobId = '', recordedBy = '', now = new Date().toISOString() } = {}) {
  const { result, payment, invoice, paymentSyncPayload } = await recordStripeCheckout(env, checkout, { kind: CHECKOUT_KINDS.crew, expectedJobId, recordedBy, now });
  return { ...result, payment, invoice, paymentSyncPayload };
}

const fingerprint = job => JSON.stringify({ total: customerMoneyState(job).total, paid: customerMoneyState(job).paid, ...customerDepositState(job), revision: job.estimate?.revision || 1, approval: job.customerApproval?.status || job.estimate?.status || job.quoteStatus || '', status: job.pipelineStatus || job.status || '' });

export async function createCustomerStripeCheckout(env, secret, jobId, origin) {
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
      const recorded = await recordCustomerStripePayment(env, checkout, jobId);
      ledger = await saveLedger(env, jobId, { ...state, status: 'settled' }, ledger.version);
      state = ledger.state;
      if (!recorded.duplicate) return { ok: true, alreadyPaid: true, ...recorded };
      job = await readJob(env, jobId);
    } else if (checkout.status === 'open') {
      // Validate the current saved amount even when resuming an existing link.
      let stillPayable = false;
      try { stillPayable = payable(job).dueNow >= .5; } catch { /* Expire stale/cancelled scope below. */ }
      if (stillPayable && state.fingerprint === fingerprint(job) && checkout.amount_total === state.amountCents && /^https:\/\/checkout\.stripe\.com\//.test(checkout.url || '')) return { ok: true, url: checkout.url, amount: state.amountCents / 100, purpose: state.purpose };
      const expired = await stripeRequest(secret, `checkout/sessions/${encodeURIComponent(state.sessionId)}/expire`, { method: 'POST' });
      if (expired.status !== 'expired') throw failure('The earlier checkout must finish closing before another payment can be opened.');
      ledger = await saveLedger(env, jobId, { ...state, status: 'expired' }, ledger.version);
      state = ledger.state;
    } else if (checkout.status === 'expired') {
      ledger = await saveLedger(env, jobId, { ...state, status: 'expired' }, ledger.version);
      state = ledger.state;
    } else throw failure('Your previous checkout is still being confirmed. Please try again.');
  }
  const deposit = payable(job), amountCents = cents(deposit.dueNow);
  if (amountCents < 50) throw failure(customerMoneyState(job).balance < .5 ? 'There is no outstanding balance' : 'Your deposit is paid. The remaining balance is due on completion.');
  const params = new URLSearchParams({
    mode: 'payment', submit_type: 'pay', client_reference_id: jobId,
    success_url: `${origin}/customer-portal?payment=stripe-success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/customer-portal?payment=stripe-cancelled`,
    'payment_method_types[0]': 'card',
    'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(amountCents),
    'line_items[0][price_data][product_data][name]': `Easy Garage Cleaning — ${deposit.purpose === 'deposit' ? 'upfront deposit' : 'remaining balance'}`,
    'line_items[0][price_data][product_data][description]': `${clean(job.serviceType || 'Garage service', 100)}. ${deposit.purpose === 'deposit' ? 'Applied to your approved quote; remaining balance due on completion.' : 'Balance after previous payments and credits.'}`,
    'metadata[kind]': 'egc_customer_portal_payment', 'metadata[job_id]': jobId, 'metadata[payment_purpose]': deposit.purpose,
    'metadata[quote_revision]': String(job.estimate?.revision || 1), 'metadata[quoted_total_cents]': String(cents(customerMoneyState(job).total)),
    'payment_intent_data[metadata][kind]': 'egc_customer_portal_payment', 'payment_intent_data[metadata][job_id]': jobId, 'payment_intent_data[metadata][payment_purpose]': deposit.purpose,
  });
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(job.email || '')) {
    params.set('customer_email', job.email); params.set('payment_intent_data[receipt_email]', job.email);
  }
  state = { status: 'creating', sessionId: '', key: `egc-customer-payment:${crypto.randomUUID()}`, params: params.toString(), amountCents, purpose: deposit.purpose, fingerprint: fingerprint(job), createdAt: new Date().toISOString() };
  await saveLedger(env, jobId, state, ledger.version);
  // Recover through the same path, including the current-scope check, before returning a link.
  return createCustomerStripeCheckout(env, secret, jobId, origin);
}
