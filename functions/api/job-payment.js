import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { readJob } from '../_lib/firestore-job.js';
import { createJobAssignmentAccess } from '../_lib/job-assignment.js';
import { CHECKOUT_HOLD_CODE, CHECKOUT_HOLD_TEXT, STRIPE_API_VERSION, TIP_PRESETS, addTipLine, checkoutHold, customerMoneyState, customerPaymentNeedsReview, customerTipsEnabled, customerTotalsShadow, recordCrewStripePayment, requestTip, stripeSecretKey as stripeKey, tipRefusal, validTip } from '../_lib/customer-payments.js';
import { customerMoneyTotals, moneyTotalsMode } from '../_lib/money-core.js';

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
  const jobId = safe(body.job_id, 120);
  const amountCents = Math.round(Number(body.amount_cents));
  const requestId = safe(body.request_id, 120);
  if (!jobId || !requestId || !Number.isInteger(amountCents) || amountCents < 50 || amountCents > 1000000) {
    return json(400, { ok: false, error: 'A valid job, request, and payment amount are required' });
  }
  let tipCents;
  try { tipCents = requestTip(body.tip_cents); } catch (error) { return json(400, { ok: false, code: 'JOB_PAYMENT_TIP_INVALID', error: error.message }); }
  // Checkout rotation ships with tips: with CUSTOMER_TIPS_ENABLED unset, replaces_session_id is ignored and a card
  // payment request is handled exactly as it was before tips.
  const tipsEnabled = customerTipsEnabled(env), named = body.replaces_session_id;
  const replaces = !tipsEnabled || named === undefined || named === null || named === '' ? '' : safe(named, 180);
  if (replaces && !SESSION_ID.test(replaces)) return json(400, { ok: false, code: 'JOB_PAYMENT_CHECKOUT_INVALID', error: 'The earlier checkout reference is invalid' });
  if (tipCents && !tipsEnabled) return json(409, { ok: false, code: 'JOB_PAYMENT_TIPS_DISABLED', error: 'Tips are not available for card payments right now. Take the payment without a tip.' });
  const job = await authorizedJob(env, jobId, session);
  if (!job) return json(403, { ok: false, error: 'This job is not assigned to you' });
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
    success_url: `${origin}/crew/postjob.html?jobId=${returnJob}&payment=stripe-success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/crew/postjob.html?jobId=${returnJob}&payment=stripe-cancelled`,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(amountCents),
    'line_items[0][price_data][product_data][name]': `Easy Garage Cleaning — ${customer || 'job balance'}`,
    'metadata[kind]': 'egc_job_payment',
    'metadata[job_id]': jobId,
    'metadata[created_by]': safe(session.user, 80),
    'payment_intent_data[metadata][kind]': 'egc_job_payment',
    'payment_intent_data[metadata][job_id]': jobId,
  });
  if (email) {
    params.set('customer_email', email);
    params.set('payment_intent_data[receipt_email]', email);
  }
  addTipLine(params, tipCents);
  try {
    const stop = replaces ? await closeEarlierCheckout(secret, job, jobId, replaces) : null;
    if (stop) return stop;
    // A different tip is a different checkout; the same request and tip reuse Stripe's session.
    const checkout = await stripe(secret, 'checkout/sessions', {
      method: 'POST',
      headers: { 'Idempotency-Key': `egc-job-payment:${jobId}:${requestId}${tipCents ? `:tip:${tipCents}` : ''}`.slice(0, 255) },
      body: params,
    });
    // Never hand out the checkout just closed (a request can only replace an earlier one, not itself).
    if (replaces && checkout.id === replaces) return json(409, { ok: false, code: 'JOB_PAYMENT_REQUEST_STALE', error: 'This card payment request is out of date. Take the payment again.' });
    if (!/^https:\/\/checkout\.stripe\.com\//.test(checkout.url || '')) throw new Error('Stripe did not return a safe Checkout URL');
    return json(200, { ok: true, sessionId: checkout.id || '', url: checkout.url });
  } catch (error) {
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
        ...(recorded ? { duplicate: recorded.duplicate, receiptUrl: recorded.receiptUrl, payment: recorded.payment, invoice: recorded.invoice, paymentSyncPayload: recorded.paymentSyncPayload, ...(recorded.tipPaid ? { tipPaid: recorded.tipPaid } : {}) } : {}),
      });
    } catch (error) {
      return json(502, { ok: false, error: 'Stripe payment could not be verified', detail: error.type || '' });
    }
  };
}

export const onRequestGet = jobPaymentVerifier();
