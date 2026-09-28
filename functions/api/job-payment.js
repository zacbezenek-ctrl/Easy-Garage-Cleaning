import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { readJob } from '../_lib/firestore-job.js';
import { createJobAssignmentAccess } from '../_lib/job-assignment.js';
import { customerMoneyState, customerPaymentNeedsReview, recordCrewStripePayment, stripeSecretKey as stripeKey } from '../_lib/customer-payments.js';

const STRIPE_API = 'https://api.stripe.com/v1';
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
  const job = await authorizedJob(env, jobId, session);
  if (!job) return json(403, { ok: false, error: 'This job is not assigned to you' });
  if (customerPaymentNeedsReview(job)) return json(409, { ok: false, error: 'An earlier recorded payment needs manager verification before taking another payment' });
  const customer = safe(job.customer || job.customerName, 120);
  const email = safe(job.email, 180);
  const finance = customerMoneyState(job);
  const totalCents = Math.round(finance.total * 100);
  const paidCents = Math.round(finance.paid * 100);
  const balanceCents = Math.max(0, totalCents - paidCents);
  if (!Number.isInteger(totalCents) || totalCents < 50 || amountCents > balanceCents) {
    return json(409, { ok: false, error: 'Payment exceeds the current job balance' });
  }
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
  try {
    const checkout = await stripe(secret, 'checkout/sessions', {
      method: 'POST',
      headers: { 'Idempotency-Key': `egc-job-payment:${jobId}:${requestId}`.slice(0, 255) },
      body: params,
    });
    if (!/^https:\/\/checkout\.stripe\.com\//.test(checkout.url || '')) throw new Error('Stripe did not return a safe Checkout URL');
    return json(200, { ok: true, sessionId: checkout.id || '', url: checkout.url });
  } catch (error) {
    return json(502, { ok: false, error: 'Stripe checkout could not be created', detail: error.type || '' });
  }
}

// The browser return and the Stripe webhook share recordCrewStripePayment, so
// either can land first and the charge is recorded once.
export function jobPaymentVerifier({ now = () => new Date() } = {}) {
  return async function onRequestGet({ request, env }) {
    if (!allowed(request)) return json(403, { ok: false, error: 'Forbidden origin' });
    const session = await getHubSession(request, env);
    if (!session) return json(401, { ok: false, code: 'HUB_AUTH_REQUIRED', error: 'Sign in to verify payment' });
    const secret = stripeKey(env);
    if (!secret) return json(501, { ok: false, code: 'STRIPE_NOT_CONFIGURED', error: 'Stripe is not configured' });
    const id = safe(new URL(request.url).searchParams.get('session_id'), 180);
    if (!/^cs_(?:test_|live_)?[A-Za-z0-9_]+$/.test(id)) return json(400, { ok: false, error: 'Invalid Checkout session' });
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
        ...(recorded ? { duplicate: recorded.duplicate, receiptUrl: recorded.receiptUrl, payment: recorded.payment, invoice: recorded.invoice, paymentSyncPayload: recorded.paymentSyncPayload } : {}),
      });
    } catch (error) {
      return json(502, { ok: false, error: 'Stripe payment could not be verified', detail: error.type || '' });
    }
  };
}

export const onRequestGet = jobPaymentVerifier();
