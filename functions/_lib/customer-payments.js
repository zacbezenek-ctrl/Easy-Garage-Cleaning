import { firestoreFetch } from './firebase-service-account.js';
import { readJob, patchJob, encodeFirestoreFields, decodeFirestoreFields } from './firestore-job.js';

const DB = 'https://firestore.googleapis.com/v1/projects/egcw-1ec83/databases/(default)/documents';
const clean = (value, limit = 180) => String(value || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, limit);
const cents = value => {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : 0;
};
const failure = (message, status = 409) => Object.assign(new Error(message), { status });
const knownSession = (job, sessionId) => job.payment?.verified === true && (job.payment?.stripeSessions || []).some(item => String(item?.sessionId || item) === sessionId);

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

export async function recordCustomerStripePayment(env, checkout, expectedJobId = '') {
  const jobId = clean(checkout.metadata?.job_id, 120), sessionId = clean(checkout.id);
  if (!/^cs_(?:test_|live_)?[A-Za-z0-9_]+$/.test(sessionId) || !jobId || (expectedJobId && jobId !== expectedJobId) || checkout.client_reference_id !== jobId || checkout.metadata?.kind !== 'egc_customer_portal_payment' || checkout.currency !== 'usd' || checkout.mode !== 'payment' || checkout.status !== 'complete' || checkout.payment_status !== 'paid' || !Number.isInteger(checkout.amount_total) || checkout.amount_total <= 0) throw failure('Stripe has not verified this job payment');
  const ledger = await readLedger(env, jobId);
  if (ledger.state.sessionId === sessionId && Number(ledger.state.amountCents) !== checkout.amount_total) throw failure('The payment amount does not match this checkout');
  for (let attempt = 0; attempt < 3; attempt++) {
    const job = await readJob(env, jobId);
    if (!job?.__updateTime) throw failure('Payment information is temporarily unavailable', 503);
    const finance = customerMoneyState(job), duplicate = knownSession(job, sessionId);
    if (duplicate) {
      const freshReceipt = checkout.payment_intent?.latest_charge?.receipt_url || '';
      const latest = job.payment.stripeSessions.at(-1);
      const receiptUrl = String(latest?.sessionId || latest) === sessionId && /^https:\/\/pay\.stripe\.com\/receipts\//.test(freshReceipt) ? freshReceipt : job.payment.receiptUrl || '';
      // Webhooks usually contain only a PaymentIntent ID. Enrich its receipt on
      // the expanded browser verification without adding the payment again.
      if (receiptUrl && receiptUrl !== job.payment.receiptUrl) {
        try { await patchJob(env, jobId, { payment: { ...job.payment, receiptUrl } }, job.__updateTime); }
        catch { if (attempt < 2) continue; }
      }
      return { paid: true, duplicate: true, amountPaid: checkout.amount_total / 100, balance: finance.balance, receiptUrl };
    }
    if (customerPaymentNeedsReview(job)) {
      // A crew-entered receipt cannot become verified merely because a separate
      // Stripe charge succeeds. Keep the confirmed charge durably recoverable,
      // and let Stripe retry after the manager verifies the earlier receipt.
      await saveLedger(env, jobId, { ...ledger.state, verifiedReceipt: { sessionId, amount: checkout.amount_total / 100, paymentIntentId: clean(checkout.payment_intent?.id || checkout.payment_intent), confirmedAt: new Date().toISOString() }, requiresReview: true }, ledger.version);
      throw failure('Your Stripe payment is confirmed. An earlier recorded payment needs team verification before the balance can be updated. Please do not pay again.');
    }
    const paidCents = cents(finance.paid) + checkout.amount_total;
    // Preserve every confirmed dollar, including any unexpected excess, for reconciliation.
    const paidTotal = paidCents / 100, balance = Math.max(0, cents(finance.total) - paidCents) / 100;
    const now = new Date().toISOString(), deposit = customerDepositState(job, { ...finance, paid: paidTotal, balance });
    const charge = checkout.payment_intent?.latest_charge || {};
    const receiptUrl = /^https:\/\/pay\.stripe\.com\/receipts\//.test(charge.receipt_url || '') ? charge.receipt_url : job.payment?.receiptUrl || '';
    const paymentItem = { sessionId, paymentIntentId: clean(checkout.payment_intent?.id || checkout.payment_intent), amount: checkout.amount_total / 100, purpose: clean(checkout.metadata?.payment_purpose, 20), quoteRevision: clean(checkout.metadata?.quote_revision, 20), quotedTotalCents: Number(checkout.metadata?.quoted_total_cents || 0), verifiedAt: now };
    const trustedSessions = job.payment?.verified === true ? (job.payment.stripeSessions || []) : [];
    const payment = { ...(job.payment || {}), amount: paidTotal, lastAmount: paymentItem.amount, lastReceivedAt: now, method: 'stripe', processor: 'stripe', verified: true, receiptUrl, receiptEmail: clean(checkout.customer_details?.email || checkout.customer_email), reference: paymentItem.paymentIntentId || sessionId, stripeSessions: [...trustedSessions, paymentItem] };
    try {
      await patchJob(env, jobId, {
        payment,
        deposit: { ...(job.deposit || {}), amount: deposit.required, paidAmount: deposit.paid, status: deposit.due < .01 ? 'paid' : deposit.paid ? 'partial' : 'due', verified: true, updatedAt: now },
        invoice: { ...(job.invoice || {}), amount: finance.total, paid: paidTotal, balance, status: balance < .01 ? 'paid' : 'partial', updatedAt: now },
        paymentSyncStatus: 'pending', paymentSyncPayload: { ...paymentItem, balance, paidTotal },
        ...(paidTotal > finance.total ? { paymentReviewRequired: true } : {}), updatedAt: now,
      }, job.__updateTime);
      return { paid: true, duplicate: false, amountPaid: paymentItem.amount, balance, receiptUrl };
    } catch (error) { if (attempt === 2) throw failure('The payment record changed. Refresh to confirm the latest balance.'); }
  }
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
