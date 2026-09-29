import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { readJob } from '../_lib/firestore-job.js';
import { createJobAssignmentAccess } from '../_lib/job-assignment.js';
import { fieldJobLead } from '../_lib/field-permissions.js';
import { assignedOn, fieldVisitsEnabled } from '../_lib/field-execution-visits.js';
import { denverToday } from '../_lib/dispatch-time.js';
import { fieldPaymentJobEligible, fieldPaymentsReady } from './field-payments.js';
import { fieldRequestId } from '../_lib/field-execution.js';
import { moneyStorage } from '../_lib/money-storage.js';
import { FIELD_CARD_CHECKOUTS, activeFieldCard, fieldCardCanRecover, fieldCardClaim, fieldCardClose, fieldCardOpen, fieldPortalGuard } from '../_lib/field-payment-card.js';
import { CHECKOUT_HOLD_CODE, CHECKOUT_HOLD_TEXT, STRIPE_API_VERSION, TIP_PRESETS, addTipLine, checkoutHold, customerMoneyState, customerPaymentNeedsReview, customerTipsEnabled, customerTotalsShadow, recordCrewStripePayment, requestTip, stripeSecretKey as stripeKey, tipRefusal, validTip } from '../_lib/customer-payments.js';
import { customerMoneyTotals, moneyInvoiceStateEnabled, moneyTotalsMode } from '../_lib/money-core.js';

const STRIPE_API = 'https://api.stripe.com/v1';
const SESSION_ID = /^cs_(?:test_|live_)?[A-Za-z0-9_]+$/;
const JOB_ID = /^[A-Za-z0-9_-]{1,120}$/;
const HOST = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  }});
}

function allowed(request) {
  const raw = request.headers.get('Origin') || request.headers.get('Referer');
  if (!raw) return true;
  try { return HOST.test(new URL(raw).host); } catch { return false; }
}

function safe(value, max = 160) {
  return String(value || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
}

async function authorizedJob(env, jobId, session) {
  const job = await readJob(env, jobId).catch(() => null);
  return job && (hasBusinessAccess(session) || await createJobAssignmentAccess(env, session).assigned(job)) ? job : null;
}

function basicAuth(secret) {
  return `Basic ${btoa(`${secret}:`)}`;
}

async function stripe(secret, path, options = {}) {
  const response = await fetch(`${STRIPE_API}/${path}`, {
    ...options,
    headers: {
      Authorization: basicAuth(secret),
      // Pinned like every customer-payment call: the crew return needs payment_intent.latest_charge (2022-11-15 and
      // later) whatever the Stripe account's default API version is.
      'Stripe-Version': STRIPE_API_VERSION,
      ...(options.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('Stripe rejected the payment request');
    error.status = response.status;
    error.type = data.error?.type || '';
    throw error;
  }
  return data;
}

// A crew device that changes the amount or tip, or comes back from a cancelled checkout, names the checkout it
// opened before so only one link per job stays payable. Only this job's own crew checkout is ever closed; a
// completed one that is not on the job yet must be verified first, never charged again. Null means go ahead.
async function closeEarlierCheckout(secret, job, jobId, sessionId) {
  const earlier = await stripe(secret, `checkout/sessions/${encodeURIComponent(sessionId)}`).catch(error => { if (error.status === 404) return null; throw error; });
  if (!earlier || earlier.metadata?.kind !== 'egc_job_payment' || earlier.metadata?.job_id !== jobId || earlier.client_reference_id !== jobId) return null;
  if (earlier.status === 'complete') {
    const recorded = job.payment?.verified === true && (Array.isArray(job.payment.stripeSessions) ? job.payment.stripeSessions : []).some(item => String(item?.sessionId || item) === sessionId);
    return recorded ? null : json(409, { ok: false, code: 'JOB_PAYMENT_EARLIER_CHECKOUT_PAID', error: 'The earlier card checkout for this job was paid. Verify it before taking another payment. Do not charge again.', sessionId });
  }
  if (earlier.status !== 'open') return null;
  const closed = await stripe(secret, `checkout/sessions/${encodeURIComponent(sessionId)}/expire`, { method: 'POST' });
  return closed.status === 'expired' ? null : json(409, { ok: false, code: 'JOB_PAYMENT_EARLIER_CHECKOUT_OPEN', error: 'The earlier card checkout could not be closed yet. Retry in a moment.' });
}

export async function onRequestPost({ request, env }) {
  if (!allowed(request)) return json(403, { ok: false, error: 'Forbidden origin' });
  const session = await getHubSession(request, env);
  if (!session) return json(401, { ok: false, code: 'HUB_AUTH_REQUIRED', error: 'Sign in to take payment' });
  const secret = stripeKey(env);
  if (!secret) return json(501, { ok: false, code: 'STRIPE_NOT_CONFIGURED', error: 'Stripe is not configured' });
  const raw = await request.text();
  if (raw.length > 16 * 1024) return json(413, { ok: false, error: 'Payload too large' });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { ok: false, error: 'Invalid JSON' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { ok: false, error: 'Invalid payment request' });
  const fieldExact = body.mode === 'field_exact_balance';
  if (body.mode !== undefined && !fieldExact) return json(400, { ok: false, code: 'FIELD_PAY_MODE_INVALID', error: 'Choose a supported payment mode.' });
  if (fieldExact && !fieldPaymentsReady(env)) return json(404, { ok: false, code: 'FIELD_PAY_UNAVAILABLE', error: 'Field payments are not enabled for new collections.' });
  const jobId = safe(body.job_id, 120);
  const amountCents = Math.round(Number(body.amount_cents));
  const requestId = safe(body.request_id, 120);
  if (!jobId || !requestId || !Number.isInteger(amountCents) || amountCents < 50 || amountCents > 1000000) {
    return json(400, { ok: false, error: 'A valid job, request, and payment amount are required' });
  }
  if (fieldExact && !fieldRequestId(requestId)) return json(400, { ok: false, code: 'FIELD_PAY_REQUEST_INVALID', error: 'Use a unique field payment request ID.' });
  let tipCents;
  try { tipCents = requestTip(body.tip_cents); } catch (error) { return json(400, { ok: false, code: 'JOB_PAYMENT_TIP_INVALID', error: error.message }); }
  // Checkout rotation ships with tips: with CUSTOMER_TIPS_ENABLED unset, replaces_session_id is ignored and a card
  // payment request is handled exactly as it was before tips.
  const tipsEnabled = customerTipsEnabled(env), named = body.replaces_session_id;
  const replaces = (!tipsEnabled && !fieldExact) || named === undefined || named === null || named === '' ? '' : safe(named, 180);
  if (replaces && !SESSION_ID.test(replaces)) return json(400, { ok: false, code: 'JOB_PAYMENT_CHECKOUT_INVALID', error: 'The earlier checkout reference is invalid' });
  if (tipCents && !tipsEnabled) return json(409, { ok: false, code: 'JOB_PAYMENT_TIPS_DISABLED', error: 'Tips are not available for card payments right now. Take the payment without a tip.' });
  const job = await authorizedJob(env, jobId, session);
  if (!job) return json(403, { ok: false, error: 'This job is not assigned to you' });
  if (!fieldExact && fieldPaymentsReady(env) && !hasBusinessAccess(session)) return json(409, { ok: false, code: 'FIELD_PAY_CANONICAL_REQUIRED', error: 'Open this job in the Crew Hub to collect its exact balance.' });
  if (!fieldExact && job.fieldPaymentCardRequestId) return json(409, { ok: false, code: 'FIELD_PAY_CARD_OPEN', error: 'A field card checkout is open. Verify or cancel it before taking another payment.' });
  if (fieldExact) {
    if (!fieldPaymentJobEligible(job)) return json(409, { ok: false, code: 'FIELD_PAY_JOB_UNAVAILABLE', error: 'This job cannot take a field payment until operations reviews it.' });
    const access = createJobAssignmentAccess(env, session);
    if (hasBusinessAccess(session) || !await access.assigned(job) || !await fieldJobLead({ session, job, access }) || fieldVisitsEnabled(env) && !await assignedOn(job, denverToday(new Date()), access)) return json(403, { ok: false, code: 'FIELD_PAY_LEAD_REQUIRED', error: 'Only today’s assigned crew lead can collect this balance.' });
    if (!Number.isSafeInteger(body.amount_cents)) return json(400, { ok: false, code: 'FIELD_PAY_AMOUNT_INVALID', error: 'Use the exact current balance in cents.' });
  }
  if (customerPaymentNeedsReview(job)) return json(409, { ok: false, error: 'An earlier recorded payment needs manager verification before taking another payment' });
  // One check (one query) for both rules, fail closed; neither flag on means no read, exactly as before:
  // - CUSTOMER_TIPS_ENABLED: a tipped charge held for a manager (an open payment review, from this or any device or
  //   the portal) stops every new card checkout for the job, whatever the device remembers (a tip-config read that timed
  //   out sends a fresh request naming no earlier checkout), until it is resolved in Hub > Review queues;
  // - PAYMENT_REVIEW_CHECKOUT_BLOCK_ENABLED: any open payment review does.
  let held;
  try { held = await checkoutHold(env, jobId, job); } catch { return json(503, { ok: false, code: 'payment_review_unavailable', error: 'Payment reviews could not be checked. Retry before taking a payment.' }); }
  if (held) return json(409, { ok: false, code: CHECKOUT_HOLD_CODE, error: CHECKOUT_HOLD_TEXT.crew });
  // A tip never rides on a cancelled, superseded or lost job, a void invoice, or a refunded job.
  const refusal = tipCents ? tipRefusal(job) : '';
  if (refusal) return json(409, { ok: false, code: 'JOB_PAYMENT_TIP_UNAVAILABLE', error: `${refusal} Take the payment without a tip, or ask a manager.` });
  const customer = safe(job.customer || job.customerName, 120);
  const email = safe(job.email, 180);
  // The cap is the money totals mode's balance (FIX-MONEY-TOTALS: money-core's unified totals with
  // MONEY_UNIFIED_TOTALS=true, the closeout balance and the portal's); money it cannot read is never charged.
  const mode = moneyTotalsMode(env);
  if (mode === 'shadow') customerTotalsShadow(job, 'job_payment');
  const finance = customerMoneyState(job, mode);
  if (finance.unknown) return json(409, { ok: false, code: 'JOB_PAYMENT_MONEY_REVIEW', error: 'The amounts on this job need a manager review before a card payment. Do not charge the customer yet.' });
  const totalCents = Math.round(finance.total * 100);
  const paidCents = Math.round(finance.paid * 100);
  const balanceCents = Math.max(0, totalCents - paidCents);
  if (fieldExact) {
    const exact = customerMoneyTotals(job, { unified: true });
    if (!Number.isSafeInteger(exact.balanceCents) || amountCents !== exact.balanceCents) return json(409, { ok: false, code: 'FIELD_PAY_BALANCE_CHANGED', error: 'The exact balance changed. Refresh before opening the card checkout.' });
  }
  if (!Number.isInteger(totalCents) || totalCents < 50 || amountCents > balanceCents) {
    return json(409, { ok: false, error: 'Payment exceeds the current job balance' });
  }
  // The tip is bounded by what this card charge pays toward the balance: a partial charge carries at most half of
  // itself, so it is never a tip-only checkout (amount_cents is at least $0.50 above).
  try { validTip(tipCents, balanceCents, 'balance', amountCents); } catch (error) { return json(error.status || 400, { ok: false, code: 'JOB_PAYMENT_TIP_INVALID', error: error.message }); }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { ok: false, error: 'Customer email is invalid' });
  const origin = new URL(request.url).origin;
  const returnJob = encodeURIComponent(jobId);
  const params = new URLSearchParams({
    mode: 'payment',
    submit_type: 'pay',
    client_reference_id: jobId,
    success_url: `${origin}/crew/${fieldExact ? 'job.html' : 'postjob.html'}?jobId=${returnJob}&payment=stripe-success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/crew/${fieldExact ? 'job.html' : 'postjob.html'}?jobId=${returnJob}&payment=stripe-cancelled`,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(amountCents),
    'line_items[0][price_data][product_data][name]': `Easy Garage Cleaning — ${customer || 'job balance'}`,
    'metadata[kind]': 'egc_job_payment',
    'metadata[job_id]': jobId,
    'metadata[created_by]': safe(session.user, 80),
    ...(fieldExact ? { 'metadata[field_pay_mode]': 'exact_balance' } : {}),
    'payment_intent_data[metadata][kind]': 'egc_job_payment',
    'payment_intent_data[metadata][job_id]': jobId,
  });
  if (email) {
    params.set('customer_email', email);
    params.set('payment_intent_data[receipt_email]', email);
  }
  addTipLine(params, tipCents);
  try {
    let checkout;
    if (fieldExact) {
      const store = moneyStorage(env), earlier = await store.read(FIELD_CARD_CHECKOUTS, jobId);
      let claimJob = { ...job, revision: job.__updateTime };
      if (activeFieldCard(earlier) && earlier.requestId !== requestId.toLowerCase()) {
        if (!replaces || earlier.sessionId !== replaces) return json(409, { ok: false, code: 'FIELD_PAY_CARD_OPEN', error: 'An earlier card checkout is still open. Verify or cancel it before taking another payment.', sessionId: earlier.sessionId || '' });
        const stop = await closeEarlierCheckout(secret, job, jobId, replaces);
        if (stop) return stop;
        await fieldCardClose(store, earlier, 'expired');
        claimJob = await store.read('jobs', jobId);
        const access = createJobAssignmentAccess(env, session), refreshed = claimJob ? customerMoneyTotals(claimJob, { unified: true }) : null;
        if (!claimJob || !fieldPaymentJobEligible(claimJob) || !await access.assigned(claimJob) || !await fieldJobLead({ session, job: claimJob, access }) || fieldVisitsEnabled(env) && !await assignedOn(claimJob, denverToday(new Date()), access) || refreshed?.balanceCents !== amountCents || customerPaymentNeedsReview(claimJob)) return json(409, { ok: false, code: 'FIELD_PAY_BALANCE_CHANGED', error: 'The job or balance changed. Refresh before opening another card checkout.' });
      }
      const at = new Date().toISOString(), guard = await fieldPortalGuard(store, jobId, at);
      const claim = await fieldCardClaim(store, claimJob, { requestId, amountCents, tipCents, actorId: session.user, params, now: at, guards: [guard] });
      if (claim.status === 'open' && claim.sessionId) {
        checkout = await stripe(secret, `checkout/sessions/${encodeURIComponent(claim.sessionId)}`);
        if (checkout.id !== claim.sessionId || checkout.client_reference_id !== jobId || checkout.metadata?.kind !== 'egc_job_payment' || checkout.metadata?.job_id !== jobId || checkout.metadata?.field_pay_mode !== 'exact_balance' || checkout.amount_total !== amountCents + tipCents) return json(409, { ok: false, code: 'FIELD_PAY_CARD_UNVERIFIED', error: 'The saved Stripe checkout needs operations review.' });
        if (checkout.status === 'complete') return json(409, { ok: false, code: 'FIELD_PAY_CARD_PAID', error: 'This card checkout completed. Verify it before collecting again.', sessionId: claim.sessionId });
        if (checkout.status !== 'open') { await fieldCardClose(store, claim, 'expired'); return json(409, { ok: false, code: 'FIELD_PAY_CARD_EXPIRED', error: 'The earlier checkout expired. Refresh the balance before trying again.' }); }
      } else if (claim.status === 'creating') {
        if (!fieldCardCanRecover(claim)) return json(409, { ok: false, code: 'FIELD_PAY_CARD_RECONCILE_REQUIRED', error: 'This card checkout has an unknown Stripe outcome. Operations must reconcile it before another collection.' });
        checkout = await stripe(secret, 'checkout/sessions', { method: 'POST', headers: { 'Idempotency-Key': claim.key.slice(0, 255) }, body: new URLSearchParams(claim.params) });
        if (checkout.client_reference_id !== jobId || checkout.metadata?.kind !== 'egc_job_payment' || checkout.metadata?.job_id !== jobId || checkout.metadata?.field_pay_mode !== 'exact_balance' || checkout.amount_total !== amountCents + tipCents) return json(409, { ok: false, code: 'FIELD_PAY_CARD_UNVERIFIED', error: 'Stripe returned a different checkout. Operations must reconcile it.' });
        await fieldCardOpen(store, claim, checkout);
      } else return json(409, { ok: false, code: 'FIELD_PAY_CARD_CONFLICT', error: 'The card checkout changed. Refresh and retry.' });
    } else {
      const stop = replaces ? await closeEarlierCheckout(secret, job, jobId, replaces) : null;
      if (stop) return stop;
      // The older partial/deposit link remains its established flow.
      checkout = await stripe(secret, 'checkout/sessions', {
        method: 'POST',
        headers: { 'Idempotency-Key': `egc-job-payment:${jobId}:${requestId}${tipCents ? `:tip:${tipCents}` : ''}`.slice(0, 255) },
        body: params,
      });
    }
    if (fieldExact) {
      const current = await moneyStorage(env).read('jobs', jobId);
      const access = createJobAssignmentAccess(env, session);
      const exact = current ? customerMoneyTotals(current, { unified: true }) : null;
      const stillCurrent = current && current.fieldPaymentCardRequestId === requestId.toLowerCase() && fieldPaymentJobEligible(current) &&
        await access.assigned(current) && await fieldJobLead({ session, job: current, access }) &&
        (!fieldVisitsEnabled(env) || await assignedOn(current, denverToday(new Date()), access)) && exact?.balanceCents === amountCents && !customerPaymentNeedsReview(current);
      if (!stillCurrent) {
        const live = await stripe(secret, `checkout/sessions/${encodeURIComponent(checkout.id)}`);
        if (live.status === 'complete') return json(409, { ok: false, code: 'FIELD_PAY_CARD_PAID', error: 'This card checkout completed. Verify it before collecting again.', sessionId: checkout.id });
        const closed = live.status === 'open' ? await stripe(secret, `checkout/sessions/${encodeURIComponent(checkout.id)}/expire`, { method: 'POST' }) : live;
        if (closed.status !== 'expired') return json(409, { ok: false, code: 'FIELD_PAY_CARD_RECONCILE_REQUIRED', error: 'The earlier card checkout needs operations reconciliation.', sessionId: checkout.id });
        const store = moneyStorage(env), claim = await store.read(FIELD_CARD_CHECKOUTS, jobId);
        if (activeFieldCard(claim) && claim.sessionId === checkout.id) await fieldCardClose(store, claim, 'expired').catch(() => null);
        return json(409, { ok: false, code: 'FIELD_PAY_BALANCE_CHANGED', error: 'The job or balance changed while checkout opened. Refresh before collecting.', sessionId: checkout.id });
      }
    }
    // Never hand out the checkout just closed (a request can only replace an earlier one, not itself).
    if (replaces && checkout.id === replaces) return json(409, { ok: false, code: 'JOB_PAYMENT_REQUEST_STALE', error: 'This card payment request is out of date. Take the payment again.' });
    if (!/^https:\/\/checkout\.stripe\.com\//.test(checkout.url || '')) throw new Error('Stripe did not return a safe Checkout URL');
    return json(200, { ok: true, sessionId: checkout.id || '', url: checkout.url });
  } catch (error) {
    if (fieldExact && error.code) return json(error.status || 503, { ok: false, code: error.code, error: error.message, ...(error.sessionId ? { sessionId: error.sessionId } : {}) });
    return json(502, { ok: false, error: 'Stripe checkout could not be created', detail: error.type || '' });
  }
}

// The closeout's balance (business sessions: the financial closeout is theirs) in integer cents, from
// customerMoneyState in the money totals mode, exactly what POST caps a card payment at; null while money-core
// cannot read the amounts. issues names change_order_unbilled and any other money-core issue.
async function closeoutBalance(env, session, raw) {
  const jobId = safe(raw, 120);
  if (!JOB_ID.test(jobId) || /^(secure_|_egc_)/.test(jobId)) return json(400, { ok: false, error: 'A valid job is required' });
  if (!hasBusinessAccess(session)) return json(403, { ok: false, error: 'Only a manager can read the closeout balance' });
  // Flag off (the default): the page keeps its own figures, and the job is not read.
  const mode = moneyTotalsMode(env);
  if (mode === 'off') return json(200, { ok: true, jobId, unified: false });
  const job = await readJob(env, jobId).catch(() => null);
  if (!job || job.recordType) return json(404, { ok: false, error: 'This job could not be found' });
  if (mode === 'shadow') customerTotalsShadow(job, 'closeout');
  if (mode !== 'unified') return json(200, { ok: true, jobId, unified: false });
  const finance = customerMoneyState(job, mode), totals = customerMoneyTotals(job, { unified: true }), cents = value => Math.round(value * 100);
  return json(200, { ok: true, jobId, unified: true, balance: finance.unknown ? null : { totalCents: cents(finance.total), paidCents: cents(finance.paid), balanceCents: cents(finance.balance), approvedChangeCents: totals.approvedChangeCents }, issues: totals.issues });
}

// The browser return and the Stripe webhook share recordCrewStripePayment, so
// either can land first and the charge is recorded once.
export function jobPaymentVerifier({ now = () => new Date() } = {}) {
  return async function onRequestGet({ request, env }) {
    if (!allowed(request)) return json(403, { ok: false, error: 'Forbidden origin' });
    const session = await getHubSession(request, env);
    if (!session) return json(401, { ok: false, code: 'HUB_AUTH_REQUIRED', error: 'Sign in to verify payment' });
    const params = new URL(request.url).searchParams;
    // Closeout reads the balance it may charge from the same money as the cap (FIX-MONEY-TOTALS). Without
    // MONEY_UNIFIED_TOTALS=true it answers unified:false and the page keeps its own figures, as before.
    if (params.has('job_id') && [...params.keys()].length === 1) return closeoutBalance(env, session, params.get('job_id'));
    const secret = stripeKey(env);
    if (!secret) return json(501, { ok: false, code: 'STRIPE_NOT_CONFIGURED', error: 'Stripe is not configured' });
    // Closeout asks once whether it may offer the tip chips before a card payment.
    if (params.get('config') === 'tips' && [...params.keys()].length === 1) return json(200, { ok: true, tips: { enabled: customerTipsEnabled(env), presets: [...TIP_PRESETS] } });
    const id = safe(params.get('session_id'), 180);
    if (!SESSION_ID.test(id)) return json(400, { ok: false, error: 'Invalid Checkout session' });
    try {
      const checkout = await stripe(secret, `checkout/sessions/${encodeURIComponent(id)}?expand[]=payment_intent.latest_charge`);
      const paid = checkout.payment_status === 'paid' && checkout.status === 'complete';
      const jobId = safe(checkout.metadata?.job_id || checkout.client_reference_id, 120);
      const job = jobId ? await authorizedJob(env, jobId, session) : null;
      if (!job) return json(403, { ok: false, error: 'This payment is not for an assigned job' });
      let recorded = null;
      if (paid) {
        try { recorded = await recordCrewStripePayment(env, checkout, { expectedJobId: jobId, recordedBy: session.user, now: now().toISOString() }); }
        // A charge held for manager review (payment_reviews) is reported, never retried as a new charge.
        catch (error) { return json(error.status === 503 ? 503 : 409, { ok: false, error: error.message || 'Payment could not be recorded', ...(error.reviewRecorded ? { code: error.code, reviewRecorded: true } : {}) }); }
      }
      if (paid && recorded && checkout.metadata?.field_pay_mode === 'exact_balance') {
        const store = moneyStorage(env), state = await store.read(FIELD_CARD_CHECKOUTS, jobId).catch(() => null);
        if (state?.sessionId === id && activeFieldCard(state)) await fieldCardClose(store, state, 'settled').catch(() => null);
      }
      return json(200, {
        ok: true,
        paid,
        status: checkout.status || '',
        paymentStatus: checkout.payment_status || '',
        sessionId: checkout.id || '',
        paymentIntentId: typeof checkout.payment_intent === 'string' ? checkout.payment_intent : checkout.payment_intent?.id || '',
        amountTotal: Number(checkout.amount_total || 0),
        currency: checkout.currency || 'usd',
        jobId,
        receiptEmail: safe(checkout.customer_details?.email || checkout.customer_email, 180),
        // MONEY_INVOICE_STATE_ENABLED: a job with no issued invoice keeps its invoice as it was, so closeout reads the balance here.
        ...(recorded ? { duplicate: recorded.duplicate, receiptUrl: recorded.receiptUrl, payment: recorded.payment, invoice: recorded.invoice, paymentSyncPayload: recorded.paymentSyncPayload, ...(recorded.tipPaid ? { tipPaid: recorded.tipPaid } : {}), ...(moneyInvoiceStateEnabled(env) ? { balance: recorded.balance } : {}) } : {}),
      });
    } catch (error) {
      return json(502, { ok: false, error: 'Stripe payment could not be verified', detail: error.type || '' });
    }
  };
}

export const onRequestGet = jobPaymentVerifier();
