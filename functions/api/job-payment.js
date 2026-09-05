import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { patchJob, readJob } from '../_lib/firestore-job.js';

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

function envVar(env, canonical, aliases = []) {
  if (env[canonical]) return String(env[canonical]);
  const wanted = [canonical, ...aliases].map(key => key.toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (const [key, value] of Object.entries(env || {})) {
    if (value && wanted.includes(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) return String(value);
  }
  return '';
}

function stripeKey(env) {
  const key = envVar(env, 'STRIPE_SECRET_KEY', ['STRIPE_SECRET', 'STRIPE_KEY']);
  return /^sk_(?:test|live)_[A-Za-z0-9_]+$/.test(key) ? key : '';
}

function safe(value, max = 160) {
  return String(value || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
}

const personKey = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function assignedToJob(job, session) {
  if (hasBusinessAccess(session)) return true;
  const identities = [session.user, session.displayName].map(personKey).filter(Boolean);
  const crew = [
    ...(Array.isArray(job.assignedCrew) ? job.assignedCrew : []),
    ...String(job.assignedTo || '').split(/\s*(?:,|\+|&|\band\b)\s*/i),
  ].map(value => personKey(typeof value === 'string' ? value : value?.name || value?.id || '')).filter(Boolean);
  return crew.some(name => identities.some(identity => name === identity ||
    (Math.min(name.length, identity.length) >= 3 && (name.startsWith(identity) || identity.startsWith(name)))));
}

async function authorizedJob(env, jobId, session) {
  const job = await readJob(env, jobId).catch(() => null);
  return job && assignedToJob(job, session) ? job : null;
}

async function recordStripePayment(env, job, checkout, session) {
  const amount = Number(checkout.amount_total || 0) / 100;
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Stripe returned an invalid amount');
  const current = job.payment && typeof job.payment === 'object' ? job.payment : {};
  const sessions = Array.isArray(current.stripeSessions) ? current.stripeSessions : [];
  const known = sessions.some(item => String(item?.sessionId || item) === String(checkout.id || ''));
  const paidBefore = Math.max(0, Number(current.amount || 0));
  const total = Math.max(0, Number(job.total ?? job.priceQuoted ?? job.rate ?? 0));
  if (!known && (total <= 0 || amount > Math.max(0, total - paidBefore) + 0.01)) {
    throw new Error('Stripe payment exceeds the current job balance');
  }
  const now = new Date().toISOString();
  const paidTotal = known ? paidBefore : paidBefore + amount;
  const balance = Math.max(0, total - paidTotal);
  const stripePayment = {
    sessionId: String(checkout.id || ''),
    paymentIntentId: typeof checkout.payment_intent === 'string' ? checkout.payment_intent : checkout.payment_intent?.id || '',
    amount,
    receiptEmail: safe(checkout.customer_details?.email || checkout.customer_email, 180),
    verifiedAt: now,
    recordedBy: safe(session.user, 80),
  };
  const payment = {
    ...current,
    amount: paidTotal,
    lastAmount: known ? Number(current.lastAmount || 0) : amount,
    lastReceivedAt: known ? current.lastReceivedAt || now : now,
    method: 'stripe',
    processor: 'stripe',
    reference: stripePayment.paymentIntentId || stripePayment.sessionId,
    verified: true,
    recordedBy: safe(session.user, 80),
    stripeSessions: known ? sessions : [...sessions, stripePayment].slice(-20),
  };
  const invoice = { ...(job.invoice || {}), status: balance < 0.01 ? 'paid' : 'partial', amount: total, balance, updatedAt: now };
  const paymentSyncPayload = { ...stripePayment, balance, paidTotal };
  await patchJob(env, job.id, { payment, invoice, paymentSyncStatus: 'pending', paymentSyncPayload, updatedAt: now }, job.__updateTime);
  return { payment, invoice, paymentSyncPayload };
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
  const customer = safe(job.customer || job.customerName, 120);
  const email = safe(job.email, 180);
  const totalCents = Math.round(Number(job.total ?? job.priceQuoted ?? job.rate ?? 0) * 100);
  const paidCents = Math.round(Number(job.payment?.amount || 0) * 100);
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

export async function onRequestGet({ request, env }) {
  if (!allowed(request)) return json(403, { ok: false, error: 'Forbidden origin' });
  const session = await getHubSession(request, env);
  if (!session) return json(401, { ok: false, code: 'HUB_AUTH_REQUIRED', error: 'Sign in to verify payment' });
  const secret = stripeKey(env);
  if (!secret) return json(501, { ok: false, code: 'STRIPE_NOT_CONFIGURED', error: 'Stripe is not configured' });
  const id = safe(new URL(request.url).searchParams.get('session_id'), 180);
  if (!/^cs_(?:test_|live_)?[A-Za-z0-9_]+$/.test(id)) return json(400, { ok: false, error: 'Invalid Checkout session' });
  try {
    const checkout = await stripe(secret, `checkout/sessions/${encodeURIComponent(id)}`);
    const paid = checkout.payment_status === 'paid' && checkout.status === 'complete';
    const jobId = safe(checkout.metadata?.job_id || checkout.client_reference_id, 120);
    const job = jobId ? await authorizedJob(env, jobId, session) : null;
    if (!job) return json(403, { ok: false, error: 'This payment is not for an assigned job' });
    let recorded = null;
    if (paid) {
      try { recorded = await recordStripePayment(env, job, checkout, session); }
      catch (error) { return json(409, { ok: false, error: error.message || 'Payment could not be recorded' }); }
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
      ...(recorded || {}),
    });
  } catch (error) {
    return json(502, { ok: false, error: 'Stripe payment could not be verified', detail: error.type || '' });
  }
}
