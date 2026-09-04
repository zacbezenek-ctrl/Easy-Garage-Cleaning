import { clearCustomerPortalSessionCookie, getCustomerPortalSession } from '../_lib/customer-portal.js';
import { patchJob, readJob } from '../_lib/firestore-job.js';

const STRIPE_API = 'https://api.stripe.com/v1';
const HOST = /(^|\.)easygaragecleaning\.com$|\.pages\.dev$|^localhost(:\d+)?$|^127\.0\.0\.1(:\d+)?$/;

function reply(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
}

function allowed(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const raw = request.headers.get('Origin') || request.headers.get('Referer');
  if (!raw) return true;
  try { return HOST.test(new URL(raw).host); } catch { return false; }
}

function envVar(env, canonical, aliases = []) {
  if (env[canonical]) return String(env[canonical]);
  const wanted = [canonical, ...aliases].map(key => key.toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (const [key, value] of Object.entries(env || {})) if (value && wanted.includes(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) return String(value);
  return '';
}

function stripeKey(env) {
  const key = envVar(env, 'STRIPE_SECRET_KEY', ['STRIPE_SECRET', 'STRIPE_KEY']);
  return /^sk_(?:test|live)_[A-Za-z0-9_]+$/.test(key) ? key : '';
}

function safe(value, max = 180) {
  return String(value || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
}

function amount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value || '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function moneyState(job) {
  const invoiceActive = job.invoice?.amount && !['draft', 'superseded', 'void'].includes(String(job.invoice?.status || '').toLowerCase());
  const total = Math.max(0, amount(invoiceActive ? job.invoice.amount : job.estimate?.amount || job.total || job.priceQuoted || job.lockedTotal || job.rate));
  const paid = Math.max(0, amount(job.payment?.amount || job.invoice?.paid || job.invoice?.amountPaid || job.deposit?.paidAmount));
  return { total, paid: Math.min(total || paid, paid), balance: Math.max(0, total - paid) };
}

function portalStatus(job) {
  const raw = String(job.pipelineStatus || job.status || 'scheduled').toLowerCase();
  if (raw === 'paid') return 'paid';
  if (raw === 'completed') return 'completed';
  if (raw === 'in_progress' || job.startedAt) return 'in_progress';
  if (raw === 'dispatched' || job.dispatchedAt) return 'dispatched';
  return 'scheduled';
}

function estimateState(job, finance) {
  const rawStatus = String(job.customerApproval?.status || job.estimate?.status || job.quoteStatus || (finance.total ? 'ready' : 'not_ready')).toLowerCase();
  const validUntil = safe(job.estimate?.validUntil || '', 30);
  const status = validUntil && validUntil < new Date().toISOString().slice(0, 10) && !['accepted', 'approved'].includes(rawStatus) ? 'expired' : rawStatus;
  const sourceItems = Array.isArray(job.estimate?.lineItems) && job.estimate.lineItems.length ? job.estimate.lineItems : [{ name: job.serviceType || job.type || 'Garage service', description: job.estimate?.scope || job.scopeSummary || '', quantity: 1, amount: finance.total }];
  return {
    number: safe(job.estimate?.number || job.quoteId || `EST-${String(job.id || '').slice(-6).toUpperCase()}`, 80),
    status: ['accepted', 'approved'].includes(status) ? 'approved' : status,
    amount: finance.total,
    service: safe(job.serviceType || job.type || 'Garage service', 120),
    scope: safe(job.estimate?.scope || job.scopeSummary || job.notes || 'Your flat-rate garage service based on the agreed walkthrough scope.', 1600),
    approvedAt: safe(job.customerApproval?.approvedAt || job.estimate?.acceptedAt || '', 50),
    approvedBy: safe(job.customerApproval?.approvedBy || '', 120),
    validUntil,
    revision: Math.max(1, Number(job.estimate?.revision || 1)),
    depositRequired: Math.max(0, amount(job.estimate?.depositRequired || job.deposit?.amount)),
    lineItems: sourceItems.slice(0, 12).map(item => ({ name: safe(item?.name || 'Garage service', 160), description: safe(item?.description || '', 600), quantity: Math.max(1, Number(item?.quantity || 1)), amount: Math.max(0, amount(item?.amount)) })),
    terms: 'This flat-rate estimate covers the scope shown. Any material change requires your approval before additional work or charges.',
  };
}

function sanitize(job) {
  const finance = moneyState(job);
  const estimate = estimateState(job, finance);
  const state = portalStatus(job);
  return {
    ok: true,
    customer: { firstName: safe(job.customer || 'Customer', 120).split(/\s+/)[0], name: safe(job.customer || 'Customer', 120) },
    appointment: {
      date: safe(job.date, 30), time: safe(job.time, 20), endTime: safe(job.endTime, 20),
      address: safe(job.address, 240), service: estimate.service, status: state,
      arrivalWindow: safe(job.jobInstructions?.arrivalWindow || job.instructions?.arrivalWindow || '', 80),
    },
    estimate,
    payment: {
      total: finance.total, paid: finance.paid, balance: finance.balance,
      status: finance.balance < .01 && finance.total ? 'paid' : finance.paid ? 'partial' : 'unpaid',
      receiptUrl: /^https:\/\/pay\.stripe\.com\/receipts\//.test(job.payment?.receiptUrl || '') ? job.payment.receiptUrl : '',
      receiptEmail: safe(job.payment?.receiptEmail || '', 180),
      invoiceNumber: safe(job.invoice?.number || '', 80),
      invoiceStatus: safe(job.invoice?.status || '', 30),
      dueDate: safe(job.invoice?.dueDate || '', 30),
    },
    progress: {
      status: state,
      dispatchedAt: safe(job.dispatchedAt || job.lastCustomerMessage?.sentAt || '', 50),
      startedAt: safe(job.startedAt || '', 50),
      completedAt: safe(job.completedAt || job.postJobChecklist?.completedAt || '', 50),
      updatedAt: safe(job.updatedAt || '', 50),
    },
    photos: { customerUploadCount: Math.max(0, Number(job.customerPhotoCount || 0)), lastUploadedAt: safe(job.customerPhotoUpdatedAt || '', 50) },
    support: { phone: '(970) 999-1818', phoneHref: 'tel:+19709991818', smsHref: 'sms:+19709991818' },
  };
}

function basicAuth(secret) { return `Basic ${btoa(`${secret}:`)}`; }

async function stripe(secret, path, options = {}) {
  const response = await fetch(`${STRIPE_API}/${path}`, {
    ...options,
    headers: { Authorization: basicAuth(secret), ...(options.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.type || `Stripe request failed (${response.status})`);
  return data;
}

async function requirePortal(request, env) {
  const session = await getCustomerPortalSession(request, env);
  if (!session) return { error: reply(401, { ok: false, code: 'CUSTOMER_PORTAL_AUTH_REQUIRED', error: 'Open the private link from Easy Garage Cleaning' }) };
  const job = await readJob(env, session.jobId).catch(() => null);
  if (!job) return { error: reply(404, { ok: false, error: 'This job is no longer available' }) };
  return { session, job };
}

export async function onRequestGet({ request, env }) {
  if (!allowed(request)) return reply(403, { ok: false, error: 'Forbidden origin' });
  const result = await requirePortal(request, env);
  if (result.error) return result.error;
  return reply(200, sanitize(result.job));
}

export async function onRequestPost({ request, env }) {
  if (!allowed(request)) return reply(403, { ok: false, error: 'Forbidden origin' });
  const result = await requirePortal(request, env);
  if (result.error) return result.error;
  const raw = await request.text();
  if (raw.length > 32 * 1024) return reply(413, { ok: false, error: 'Request too large' });
  let body;
  try { body = JSON.parse(raw); } catch { return reply(400, { ok: false, error: 'Invalid JSON' }); }
  const now = new Date().toISOString();

  if (body.action === 'approve_estimate') {
    const signedName = safe(body.signed_name, 120);
    if (signedName.length < 3 || body.confirmed !== true) return reply(400, { ok: false, error: 'Enter your full name and confirm the estimate' });
    const finance = moneyState(result.job);
    if (finance.total < .01) return reply(409, { ok: false, error: 'The estimate is not ready yet' });
    if (result.job.estimate?.validUntil && String(result.job.estimate.validUntil) < new Date().toISOString().slice(0, 10)) return reply(409, { ok: false, error: 'This estimate has expired. Ask the team for an updated estimate.' });
    const approval = { status: 'approved', approvedAt: now, approvedBy: signedName, amount: finance.total, source: 'customer_portal' };
    await patchJob(env, result.session.jobId, {
      customerApproval: approval,
      estimate: { ...(result.job.estimate || {}), status: 'approved', acceptedAt: now, acceptedBy: signedName, amount: finance.total },
      quoteStatus: 'approved',
      updatedAt: now,
    });
    return reply(200, { ok: true, approval });
  }

  if (body.action === 'create_payment') {
    const secret = stripeKey(env);
    if (!secret) return reply(501, { ok: false, error: 'Online payments are not configured' });
    const finance = moneyState(result.job);
    if (finance.balance < .5) return reply(409, { ok: false, error: 'There is no outstanding balance' });
    const estimate = estimateState(result.job, finance);
    if (!['approved', 'accepted'].includes(estimate.status) && portalStatus(result.job) !== 'completed') return reply(409, { ok: false, error: 'Approve the estimate before paying' });
    const requestId = safe(body.request_id, 120);
    if (!requestId) return reply(400, { ok: false, error: 'Payment request ID required' });
    const origin = new URL(request.url).origin;
    const params = new URLSearchParams({
      mode: 'payment', submit_type: 'pay', client_reference_id: result.session.jobId,
      success_url: `${origin}/customer-portal?payment=stripe-success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/customer-portal?payment=stripe-cancelled`,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(Math.round(finance.balance * 100)),
      'line_items[0][price_data][product_data][name]': `Easy Garage Cleaning — ${safe(result.job.serviceType || 'job balance', 100)}`,
      'metadata[kind]': 'egc_customer_portal_payment',
      'metadata[job_id]': result.session.jobId,
      'payment_intent_data[metadata][kind]': 'egc_customer_portal_payment',
      'payment_intent_data[metadata][job_id]': result.session.jobId,
    });
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.job.email || '')) {
      params.set('customer_email', result.job.email);
      params.set('payment_intent_data[receipt_email]', result.job.email);
    }
    try {
      const checkout = await stripe(secret, 'checkout/sessions', { method: 'POST', headers: { 'Idempotency-Key': `egc-portal:${result.session.jobId}:${requestId}`.slice(0, 255) }, body: params });
      if (!/^https:\/\/checkout\.stripe\.com\//.test(checkout.url || '')) throw new Error('unsafe_checkout_url');
      return reply(200, { ok: true, url: checkout.url });
    } catch { return reply(502, { ok: false, error: 'Secure checkout could not be created' }); }
  }

  if (body.action === 'verify_payment') {
    const secret = stripeKey(env);
    if (!secret) return reply(501, { ok: false, error: 'Online payments are not configured' });
    const sessionId = safe(body.session_id, 180);
    if (!/^cs_(?:test_|live_)?[A-Za-z0-9_]+$/.test(sessionId)) return reply(400, { ok: false, error: 'Invalid Checkout session' });
    try {
      const checkout = await stripe(secret, `checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent.latest_charge`);
      const paid = checkout.payment_status === 'paid' && checkout.status === 'complete';
      const checkoutJob = safe(checkout.metadata?.job_id || checkout.client_reference_id, 120);
      if (!paid || checkoutJob !== result.session.jobId) return reply(409, { ok: false, error: 'Stripe has not verified this job payment' });
      const current = moneyState(result.job);
      const amountPaid = Math.max(0, Number(checkout.amount_total || 0) / 100);
      const previousSessions = Array.isArray(result.job.payment?.stripeSessions) ? result.job.payment.stripeSessions : [];
      const known = previousSessions.some(item => String(item.sessionId || item) === sessionId);
      const paidTotal = known ? current.paid : Math.min(current.total || current.paid + amountPaid, current.paid + amountPaid);
      const balance = Math.max(0, current.total - paidTotal);
      const charge = checkout.payment_intent?.latest_charge || {};
      const receiptUrl = /^https:\/\/pay\.stripe\.com\/receipts\//.test(charge.receipt_url || '') ? charge.receipt_url : '';
      const paymentItem = { sessionId, paymentIntentId: checkout.payment_intent?.id || checkout.payment_intent || '', amount: amountPaid, verifiedAt: now };
      await patchJob(env, result.session.jobId, {
        payment: { ...(result.job.payment || {}), amount: paidTotal, lastAmount: amountPaid, method: 'stripe', verified: true, receiptUrl, receiptEmail: safe(checkout.customer_details?.email || checkout.customer_email, 180), stripeSessions: known ? previousSessions : [...previousSessions, paymentItem].slice(-20) },
        invoice: { ...(result.job.invoice || {}), amount: current.total, paid: paidTotal, balance, status: balance < .01 ? 'paid' : 'partial', updatedAt: now },
        paymentSyncStatus: 'pending',
        updatedAt: now,
      });
      return reply(200, { ok: true, paid: true, amountPaid, balance, receiptUrl });
    } catch { return reply(502, { ok: false, error: 'Stripe payment could not be verified' }); }
  }

  if (body.action === 'record_photo_upload') {
    const count = Math.min(3, Math.max(1, Number(body.count || 1)));
    await patchJob(env, result.session.jobId, { customerPhotoCount: Number(result.job.customerPhotoCount || 0) + count, customerPhotoUpdatedAt: now, updatedAt: now });
    return reply(200, { ok: true, count });
  }

  return reply(400, { ok: false, error: 'Unknown customer portal action' });
}

export async function onRequestDelete() {
  return reply(200, { ok: true }, { 'Set-Cookie': clearCustomerPortalSessionCookie() });
}
