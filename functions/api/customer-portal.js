import { clearCustomerPortalSessionCookie, createCustomerPortalCollaboratorAccessToken, getCustomerPortalSession } from '../_lib/customer-portal.js';
import { patchJob, patchJobsAtomic, readJob } from '../_lib/firestore-job.js';

const STRIPE_API = 'https://api.stripe.com/v1';
const HOST = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/;

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

function isoDate(value) {
  const text = safe(value, 30);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function email(value) {
  const text = safe(value, 180).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : '';
}

function id(value, prefix = 'item') {
  const cleaned = safe(value, 100).replace(/[^a-zA-Z0-9_-]/g, '');
  return cleaned || `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function customerExperience(job, owner = true) {
  const memory = job.customerMemory || {};
  const rules = job.jobDayRules || {};
  const collaborators = Array.isArray(job.customerCollaborators) ? job.customerCollaborators : [];
  const decisions = Array.isArray(job.customerDecisions) ? job.customerDecisions : [];
  const requests = Array.isArray(job.rebookingRequests) ? job.rebookingRequests : [];
  const cards = Array.isArray(job.giftWallet?.cards) ? job.giftWallet.cards : [];
  const redemptions = Array.isArray(job.giftWallet?.redemptions) ? job.giftWallet.redemptions : [];
  const guard = job.garageGuard || job.membership || {};
  return {
    memory: {
      accessInstructions: safe(memory.accessInstructions, 600), parkingNotes: safe(memory.parkingNotes, 400),
      petNotes: safe(memory.petNotes, 400), alarmNotes: safe(memory.alarmNotes, 400),
      importantItems: safe(memory.importantItems, 800), communicationPreference: ['text', 'email', 'call'].includes(memory.communicationPreference) ? memory.communicationPreference : 'text',
      preferredCrew: safe(memory.preferredCrew, 160), updatedAt: safe(memory.updatedAt, 50),
    },
    jobDayRules: {
      awayMode: Boolean(rules.awayMode), decisionMaker: safe(rules.decisionMaker, 120), payer: safe(rules.payer, 120),
      approvalLimit: Math.min(5000, Math.max(0, amount(rules.approvalLimit))),
      noResponseAction: ['pause', 'call_backup', 'manager_review'].includes(rules.noResponseAction) ? rules.noResponseAction : 'pause',
      remoteCompletionAllowed: Boolean(rules.remoteCompletionAllowed), updatedAt: safe(rules.updatedAt, 50),
    },
    collaborators: collaborators.slice(0, 8).map(person => ({
      id: id(person.id, 'person'), name: safe(person.name, 120), email: owner ? email(person.email) : '', role: safe(person.role || 'Family', 80),
      permissions: { view: person.permissions?.view !== false, decide: Boolean(person.permissions?.decide), pay: Boolean(person.permissions?.pay), rebook: Boolean(person.permissions?.rebook) },
      status: person.status === 'removed' ? 'removed' : 'active',
    })),
    decisions: decisions.slice(-20).map(item => ({
      id: id(item.id, 'decision'), title: safe(item.title, 180), details: safe(item.details, 1200),
      photoUrl: /^https:\/\/(?:drive|docs)\.google\.com\//i.test(item.photoUrl || '') ? item.photoUrl : '',
      priceDelta: Math.max(0, amount(item.priceDelta)), timeDeltaMinutes: Math.max(0, Number(item.timeDeltaMinutes || 0)),
      status: ['pending', 'approved', 'declined', 'cancelled'].includes(item.status) ? item.status : 'pending',
      promptedAt: safe(item.promptedAt, 50), respondedAt: safe(item.respondedAt, 50), responseNote: safe(item.responseNote, 600), responseBy: safe(item.responseBy, 120),
    })).sort((a, b) => String(b.promptedAt).localeCompare(String(a.promptedAt))),
    rebooking: requests.slice(-10).map(request => ({
      id: id(request.id, 'rebook'), kind: ['repeat', 'touch_up', 'garage_guard'].includes(request.kind) ? request.kind : 'repeat',
      preferredDate: isoDate(request.preferredDate), timing: ['asap', 'same_weekday', 'choose_date'].includes(request.timing) ? request.timing : 'asap',
      preferredCrew: Boolean(request.preferredCrew), notes: safe(request.notes, 600), status: safe(request.status || 'pending', 30), requestedAt: safe(request.requestedAt, 50),
    })).sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt))),
    giftWallet: {
      cards: cards.slice(0, 20).map(card => ({ id: id(card.id, 'credit'), label: safe(card.label || 'EGC service credit', 120), issuedAmount: Math.max(0, amount(card.issuedAmount)), remainingAmount: Math.max(0, amount(card.remainingAmount)), source: safe(card.source, 100), issuedAt: safe(card.issuedAt, 50) })),
      available: cards.reduce((sum, card) => sum + Math.max(0, amount(card.remainingAmount)), 0),
      applied: redemptions.reduce((sum, redemption) => sum + Math.max(0, amount(redemption.amount)), 0),
    },
    garageGuard: {
      plan: ['lite', 'guard', 'black'].includes(guard.plan) ? guard.plan : '', status: ['active', 'past_due', 'cancelled', 'paused'].includes(guard.status) ? guard.status : '',
      visitsIncluded: Math.max(0, Number(guard.visitsIncluded || 0)), visitsRemaining: Math.max(0, Number(guard.visitsRemaining || 0)),
      nextVisit: isoDate(guard.nextVisit), renewalDate: isoDate(guard.renewalDate),
    },
  };
}

function sanitize(job, session = {}) {
  const finance = moneyState(job);
  const estimate = estimateState(job, finance);
  const state = portalStatus(job);
  const owner = !session.actorId, experience = customerExperience(job, owner), actor = experience.collaborators.find(person => person.id === session.actorId);
  return {
    ok: true,
    viewer: { owner, actorId: safe(session.actorId, 100), name: actor?.name || '', permissions: session.permissions || { view: true, decide: true, pay: true, rebook: true } },
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
      creditApplied: Math.max(0, amount(job.payment?.giftCreditApplied)), completionRequiresPayment: true,
    },
    progress: {
      status: state,
      dispatchedAt: safe(job.dispatchedAt || job.lastCustomerMessage?.sentAt || '', 50),
      startedAt: safe(job.startedAt || '', 50),
      completedAt: safe(job.completedAt || job.postJobChecklist?.completedAt || '', 50),
      updatedAt: safe(job.updatedAt || '', 50),
    },
    photos: { customerUploadCount: Math.max(0, Number(job.customerPhotoCount || 0)), lastUploadedAt: safe(job.customerPhotoUpdatedAt || '', 50) },
    experience,
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
  const accountJobId = safe(job.customerAccountOwnerJobId || job.id, 120);
  const accountJob = accountJobId && accountJobId !== job.id ? await readJob(env, accountJobId).catch(() => null) : job;
  const source = accountJob || job;
  return {
    session, accountJobId: source.id || job.id, jobUpdateTime: job.__updateTime || '', accountUpdateTime: source.__updateTime || '',
    job: { ...job, customerMemory: source.customerMemory || job.customerMemory, customerCollaborators: source.customerCollaborators || job.customerCollaborators, giftWallet: source.giftWallet || job.giftWallet, garageGuard: source.garageGuard || job.garageGuard },
  };
}

export async function onRequestGet({ request, env }) {
  if (!allowed(request)) return reply(403, { ok: false, error: 'Forbidden origin' });
  const result = await requirePortal(request, env);
  if (result.error) return result.error;
  return reply(200, sanitize(result.job, result.session));
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
  const owner = !result.session.actorId, can = permission => owner || Boolean(result.session.permissions?.[permission]);
  const ownerOnly = new Set(['save_customer_memory', 'save_job_day_rules', 'save_collaborators', 'create_collaborator_invite', 'request_gift_transfer', 'record_photo_upload']);
  if (ownerOnly.has(body.action) && !owner) return reply(403, { ok: false, error: 'Only the primary customer can make that change' });
  if (body.action === 'approve_estimate' && !can('decide')) return reply(403, { ok: false, error: 'You are not authorized to approve changes' });
  if (body.action === 'respond_decision' && !can('decide')) return reply(403, { ok: false, error: 'You are not authorized to answer job decisions' });
  if (body.action === 'request_rebook' && !can('rebook')) return reply(403, { ok: false, error: 'You are not authorized to rebook this property' });
  if (['create_payment', 'verify_payment', 'apply_gift_credit'].includes(body.action) && !can('pay')) return reply(403, { ok: false, error: 'You are not authorized to pay for this job' });

  if (body.action === 'approve_estimate') {
    const signedName = safe(body.signed_name, 120);
    if (signedName.length < 3 || body.confirmed !== true) return reply(400, { ok: false, error: 'Enter your full name and confirm the estimate' });
    const finance = moneyState(result.job);
    if (finance.total < .01) return reply(409, { ok: false, error: 'The estimate is not ready yet' });
    if (result.job.estimate?.validUntil && String(result.job.estimate.validUntil) < new Date().toISOString().slice(0, 10)) return reply(409, { ok: false, error: 'This estimate has expired. Ask the team for an updated estimate.' });
    const approval = { status: 'approved', approvedAt: now, approvedBy: signedName, amount: finance.total, source: 'customer_portal' };
    try {
      await patchJob(env, result.session.jobId, {
        customerApproval: approval,
        estimate: { ...(result.job.estimate || {}), status: 'approved', acceptedAt: now, acceptedBy: signedName, amount: finance.total },
        quoteStatus: 'approved',
        updatedAt: now,
      }, result.jobUpdateTime);
    } catch { return reply(409, { ok: false, error: 'The estimate changed. Refresh before approving it.' }); }
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
      try {
        await patchJob(env, result.session.jobId, {
          payment: { ...(result.job.payment || {}), amount: paidTotal, lastAmount: amountPaid, method: 'stripe', verified: true, receiptUrl, receiptEmail: safe(checkout.customer_details?.email || checkout.customer_email, 180), stripeSessions: known ? previousSessions : [...previousSessions, paymentItem].slice(-20) },
          invoice: { ...(result.job.invoice || {}), amount: current.total, paid: paidTotal, balance, status: balance < .01 ? 'paid' : 'partial', updatedAt: now },
          paymentSyncStatus: 'pending',
          updatedAt: now,
        }, result.jobUpdateTime);
      } catch { return reply(409, { ok: false, error: 'The payment record changed. Refresh to confirm the latest balance.' }); }
      return reply(200, { ok: true, paid: true, amountPaid, balance, receiptUrl });
    } catch { return reply(502, { ok: false, error: 'Stripe payment could not be verified' }); }
  }

  if (body.action === 'save_customer_memory') {
    const memory = {
      accessInstructions: safe(body.access_instructions, 600), parkingNotes: safe(body.parking_notes, 400),
      petNotes: safe(body.pet_notes, 400), alarmNotes: safe(body.alarm_notes, 400), importantItems: safe(body.important_items, 800),
      communicationPreference: ['text', 'email', 'call'].includes(body.communication_preference) ? body.communication_preference : 'text',
      preferredCrew: safe(body.preferred_crew, 160), updatedAt: now, source: 'customer_portal',
    };
    await patchJob(env, result.accountJobId, { customerMemory: memory, customerMemoryUpdatedAt: now, updatedAt: now });
    return reply(200, { ok: true, memory });
  }

  if (body.action === 'save_job_day_rules') {
    const rules = {
      awayMode: Boolean(body.away_mode), decisionMaker: safe(body.decision_maker, 120), payer: safe(body.payer, 120),
      approvalLimit: Math.min(5000, Math.max(0, amount(body.approval_limit))),
      noResponseAction: ['pause', 'call_backup', 'manager_review'].includes(body.no_response_action) ? body.no_response_action : 'pause',
      remoteCompletionAllowed: Boolean(body.remote_completion_allowed), updatedAt: now, source: 'customer_portal',
    };
    if (rules.awayMode && (!rules.decisionMaker || !rules.payer)) return reply(400, { ok: false, error: 'Name the decision-maker and payer for an unattended job' });
    await patchJob(env, result.session.jobId, { jobDayRules: rules, updatedAt: now });
    return reply(200, { ok: true, rules });
  }

  if (body.action === 'save_collaborators') {
    const supplied = Array.isArray(body.collaborators) ? body.collaborators.slice(0, 8) : [];
    const collaborators = supplied.map(person => ({
      id: id(person.id, 'person'), name: safe(person.name, 120), email: email(person.email), role: safe(person.role || 'Family', 80),
      permissions: { view: true, decide: Boolean(person.permissions?.decide), pay: Boolean(person.permissions?.pay), rebook: Boolean(person.permissions?.rebook) },
      status: 'active', updatedAt: now,
    })).filter(person => person.name && person.email);
    if (supplied.length && !collaborators.length) return reply(400, { ok: false, error: 'Add a name and valid email for each person' });
    await patchJob(env, result.accountJobId, { customerCollaborators: collaborators, collaboratorsUpdatedAt: now, updatedAt: now });
    return reply(200, { ok: true, collaborators });
  }

  if (body.action === 'create_collaborator_invite') {
    const personId = id(body.person_id, 'person');
    const people = Array.isArray(result.job.customerCollaborators) ? result.job.customerCollaborators : [];
    const person = people.find(item => item.id === personId && item.status !== 'removed');
    if (!person) return reply(404, { ok: false, error: 'That authorized person is no longer available' });
    const token = await createCustomerPortalCollaboratorAccessToken(env, result.session.jobId, person.id, { view: true, decide: Boolean(person.permissions?.decide), pay: Boolean(person.permissions?.pay), rebook: Boolean(person.permissions?.rebook) });
    const origin = new URL(request.url).origin;
    return reply(200, { ok: true, person: safe(person.name, 120), url: `${origin}/api/customer-portal-session?access=${encodeURIComponent(token)}`, expiresInDays: 30 });
  }

  if (body.action === 'respond_decision') {
    const decisionId = id(body.decision_id, 'decision');
    const response = body.response === 'approved' ? 'approved' : body.response === 'declined' ? 'declined' : '';
    const signedName = safe(body.responded_by, 120);
    if (!response || signedName.length < 2) return reply(400, { ok: false, error: 'Choose approve or decline and enter your name' });
    const decisions = Array.isArray(result.job.customerDecisions) ? result.job.customerDecisions : [];
    const current = decisions.find(item => item.id === decisionId);
    if (!current) return reply(404, { ok: false, error: 'This decision is no longer available' });
    if (current.status !== 'pending') return reply(409, { ok: false, error: 'This decision has already been answered' });
    const updated = decisions.map(item => item.id === decisionId ? { ...item, status: response, respondedAt: now, responseBy: signedName, responseNote: safe(body.note, 600), responseSource: 'customer_portal' } : item);
    const approvedTotal = updated.filter(item => item.status === 'approved').reduce((sum, item) => sum + Math.max(0, amount(item.priceDelta)), 0);
    try {
      await patchJob(env, result.session.jobId, { customerDecisions: updated, approvedChangeTotal: approvedTotal, customerDecisionUpdatedAt: now, updatedAt: now }, result.jobUpdateTime);
    } catch { return reply(409, { ok: false, error: 'That decision changed. Refresh before answering it.' }); }
    return reply(200, { ok: true, decision: updated.find(item => item.id === decisionId), approvedChangeTotal: approvedTotal });
  }

  if (body.action === 'request_rebook') {
    const kind = ['repeat', 'touch_up', 'garage_guard'].includes(body.kind) ? body.kind : 'repeat';
    const timing = ['asap', 'same_weekday', 'choose_date'].includes(body.timing) ? body.timing : 'asap';
    const preferredDate = timing === 'choose_date' ? isoDate(body.preferred_date) : '';
    if (timing === 'choose_date' && (!preferredDate || preferredDate < new Date().toISOString().slice(0, 10))) return reply(400, { ok: false, error: 'Choose a future preferred date' });
    const requests = Array.isArray(result.job.rebookingRequests) ? result.job.rebookingRequests : [];
    const duplicate = requests.find(request => request.status === 'pending' && request.kind === kind && request.timing === timing && (request.preferredDate || '') === preferredDate && safe(request.notes, 600) === safe(body.notes, 600));
    if (duplicate) return reply(200, { ok: true, request: duplicate });
    if (requests.filter(request => request.status === 'pending').length >= 3) return reply(409, { ok: false, error: 'The team already has your rebooking request' });
    const request = { id: id('', 'rebook'), kind, timing, preferredDate, preferredCrew: Boolean(body.preferred_crew), notes: safe(body.notes, 600), status: 'pending', requestedAt: now, sourceJobId: result.session.jobId };
    try {
      await patchJob(env, result.session.jobId, { rebookingRequests: [...requests, request].slice(-10), rebookingStatus: 'pending', rebookingUpdatedAt: now, updatedAt: now }, result.jobUpdateTime);
    } catch { return reply(409, { ok: false, error: 'Your project changed. Refresh before requesting another visit.' }); }
    return reply(200, { ok: true, request });
  }

  if (body.action === 'apply_gift_credit') {
    const finance = moneyState(result.job);
    if (finance.balance < .01) return reply(409, { ok: false, error: 'This job is already paid in full' });
    const requestId = id(body.request_id, 'redeem');
    const wallet = result.job.giftWallet || {};
    const cards = Array.isArray(wallet.cards) ? wallet.cards : [];
    const redemptions = Array.isArray(wallet.redemptions) ? wallet.redemptions : [];
    const known = redemptions.find(item => item.requestId === requestId);
    if (known) return reply(200, { ok: true, applied: amount(known.amount), balance: finance.balance });
    const cardId = id(body.card_id, 'credit');
    const card = cards.find(item => item.id === cardId);
    if (!card || amount(card.remainingAmount) < .01) return reply(409, { ok: false, error: 'That credit is no longer available' });
    const requested = Math.max(.01, amount(body.amount));
    const applied = Math.min(requested, amount(card.remainingAmount), finance.balance);
    const updatedCards = cards.map(item => item.id === cardId ? { ...item, remainingAmount: Math.max(0, amount(item.remainingAmount) - applied), updatedAt: now } : item);
    const paidTotal = Math.min(finance.total, finance.paid + applied);
    const balance = Math.max(0, finance.total - paidTotal);
    const redemption = { id: id('', 'redemption'), requestId, cardId, amount: applied, appliedAt: now, jobId: result.session.jobId };
    const walletPatch = { giftWallet: { ...wallet, cards: updatedCards, redemptions: [...redemptions, redemption].slice(-40), updatedAt: now }, updatedAt: now };
    const jobPatch = {
      payment: { ...(result.job.payment || {}), amount: paidTotal, giftCreditApplied: amount(result.job.payment?.giftCreditApplied) + applied, lastAmount: applied, lastReceivedAt: now, method: finance.paid > 0 ? 'mixed_with_gift_credit' : 'gift_credit', verified: true },
      invoice: { ...(result.job.invoice || {}), amount: finance.total, paid: paidTotal, balance, status: balance < .01 ? 'paid' : 'partial', updatedAt: now }, updatedAt: now,
    };
    try {
      if (result.accountJobId === result.session.jobId) await patchJob(env, result.session.jobId, { ...walletPatch, ...jobPatch }, result.jobUpdateTime);
      else await patchJobsAtomic(env, [{ jobId: result.accountJobId, patch: walletPatch, updateTime: result.accountUpdateTime }, { jobId: result.session.jobId, patch: jobPatch, updateTime: result.jobUpdateTime }]);
    } catch { return reply(409, { ok: false, error: 'That credit changed while it was being applied. Refresh and try again.' }); }
    return reply(200, { ok: true, applied, balance });
  }

  if (body.action === 'request_gift_transfer') {
    const wallet = result.job.giftWallet || {};
    const cards = Array.isArray(wallet.cards) ? wallet.cards : [];
    const cardId = id(body.card_id, 'credit');
    const card = cards.find(item => item.id === cardId && amount(item.remainingAmount) > 0);
    const recipientName = safe(body.recipient_name, 120), recipientEmail = email(body.recipient_email);
    if (!card || !recipientName || !recipientEmail) return reply(400, { ok: false, error: 'Choose an available credit and enter the recipient’s name and email' });
    const requests = Array.isArray(wallet.transferRequests) ? wallet.transferRequests : [];
    const duplicate = requests.find(request => request.status === 'pending' && request.cardId === cardId && email(request.recipientEmail) === recipientEmail);
    if (duplicate) return reply(200, { ok: true, transfer: duplicate });
    const transfer = { id: id('', 'transfer'), cardId, recipientName, recipientEmail, amount: amount(card.remainingAmount), status: 'pending', requestedAt: now };
    try {
      await patchJob(env, result.accountJobId, { giftWallet: { ...wallet, transferRequests: [...requests, transfer].slice(-20), updatedAt: now }, giftTransferStatus: 'pending', updatedAt: now }, result.accountUpdateTime);
    } catch { return reply(409, { ok: false, error: 'The gift-card balance changed. Refresh before transferring it.' }); }
    return reply(200, { ok: true, transfer });
  }

  if (body.action === 'record_photo_upload') {
    const count = Math.min(3, Math.max(1, Number(body.count || 1)));
    try {
      await patchJob(env, result.session.jobId, { customerPhotoCount: Number(result.job.customerPhotoCount || 0) + count, customerPhotoUpdatedAt: now, updatedAt: now }, result.jobUpdateTime);
    } catch { return reply(409, { ok: false, error: 'The photo count changed. Refresh to see the latest uploads.' }); }
    return reply(200, { ok: true, count });
  }

  return reply(400, { ok: false, error: 'Unknown customer portal action' });
}

export async function onRequestDelete() {
  return reply(200, { ok: true }, { 'Set-Cookie': clearCustomerPortalSessionCookie() });
}
