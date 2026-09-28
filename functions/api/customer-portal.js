import { syncSalesFollowupExit } from '../_lib/sales-followup-exit.js';
import { clearCustomerPortalSessionCookie, createCustomerPortalCollaboratorAccessToken, readCookie, verifyCustomerPortalSessionToken } from '../_lib/customer-portal.js';
import { readCustomerPortalContext } from '../_lib/customer-portal-access.js';
import { denverToday } from '../_lib/dispatch-time.js';
import { fieldActivity } from '../_lib/field-execution.js';
import { patchJob, patchJobsAtomic, readJob } from '../_lib/firestore-job.js';
import { appendConversationMessage, cleanMessage, cleanRequestId, conversationMessages, deliverHighLevelMessage, findConversationMessage, replaceConversationMessage } from '../_lib/customer-messaging.js';
import { customerMoneyState as moneyState, customerDepositState, customerPaymentNeedsReview, createCustomerStripeCheckout, recordCustomerStripePayment, stripeRequest as stripe, stripeSecretKey as stripeKey } from '../_lib/customer-payments.js';
import { parseBusinessActor } from '../_lib/business-hub-core.js';
import { businessAccountJob } from '../_lib/portal-invitation.js';
import { moneyDocumentEnabled, moneyDocumentLinks } from '../_lib/money-document.js';

const HOST = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/;
const DEFAULT_REVIEW_URL = 'https://search.google.com/local/writereview?placeid=ChIJ17AGfBiyRIsRyJ3k4mDtX8Q';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVIEW_CLICK_WINDOW_MS = 60 * 1000;
const APPROVAL_ACTOR_FIELDS = ['approvedByActorId', 'approvedByBusinessAccountId', 'approvedByBusinessMemberId'];

function reply(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
}

function allowed(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const raw = request.headers.get('Origin') || request.headers.get('Referer');
  if (!raw) return true;
  try { return HOST.test(new URL(raw).host); } catch { return false; }
}

function safe(value, max = 180) {
  return String(value || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
}

function amount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value || '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

// Field tools store paused/waiting/delayed as an activity on top of the
// canonical stage; older writers may still save them as the status itself.
function portalStatus(job) {
  const raw = String(job.pipelineStatus || job.status || 'scheduled').toLowerCase();
  if (raw === 'paid') return 'paid';
  if (['completed', 'review_requested', 'closed'].includes(raw) || raw === 'invoiced' && (job.completedAt || job.postJobChecklist?.completedAt)) return 'completed';
  if (['in_progress', 'paused'].includes(raw) || job.startedAt) return 'in_progress';
  if (['arrived', 'waiting'].includes(raw) || job.arrivedAt) return 'arrived';
  if (['dispatched', 'delayed'].includes(raw) || job.dispatchedAt) return 'dispatched';
  return 'scheduled';
}

function portalActivity(job) {
  const activity = fieldActivity(job);
  return ['delayed', 'waiting', 'paused'].includes(activity) ? activity : '';
}

function paymentStatus(job, finance) {
  return customerPaymentNeedsReview(job) ? 'pending_verification' : finance.balance < .01 && finance.total ? 'paid' : finance.paid ? 'partial' : 'unpaid';
}

// The review ask appears only after the work is complete and fully paid.
function reviewReady(job) {
  return ['completed', 'paid'].includes(portalStatus(job)) && paymentStatus(job, moneyState(job)) === 'paid';
}

export function customerReviewUrl(env = {}) {
  const raw = String(env.GOOGLE_REVIEW_URL || '').trim();
  if (!raw || raw.length > 500) return DEFAULT_REVIEW_URL;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : DEFAULT_REVIEW_URL;
  } catch { return DEFAULT_REVIEW_URL; }
}

function estimateState(job, finance, today) {
  const rawStatus = String(job.customerApproval?.status || job.estimate?.status || job.quoteStatus || (finance.total ? 'ready' : 'not_ready')).toLowerCase();
  const validUntil = safe(job.estimate?.validUntil || '', 30);
  const status = validUntil && validUntil < today && !['accepted', 'approved'].includes(rawStatus) ? 'expired' : rawStatus;
  const sourceItems = Array.isArray(job.estimate?.lineItems) && job.estimate.lineItems.length ? job.estimate.lineItems : [{ name: job.serviceType || job.type || 'Garage service', description: job.estimate?.scope || job.scopeSummary || '', quantity: 1, amount: finance.total }];
  return {
    number: safe(job.estimate?.number || job.quoteId || `EST-${String(job.id || '').slice(-6).toUpperCase()}`, 80),
    status: ['accepted', 'approved'].includes(status) ? 'approved' : status,
    amount: finance.total,
    service: safe(job.serviceType || job.type || 'Garage service', 120),
    scope: safe(job.estimate?.scope || job.scopeSummary || 'Your flat-rate garage service based on the agreed walkthrough scope.', 1600),
    approvedAt: safe(job.customerApproval?.approvedAt || job.estimate?.acceptedAt || '', 50),
    approvedBy: safe(job.customerApproval?.approvedBy || '', 120),
    validUntil,
    revision: Math.max(1, Number(job.estimate?.revision || 1)),
    depositRequired: customerDepositState(job, finance).required,
    lineItems: sourceItems.slice(0, 12).map(item => ({ name: safe(item?.name || 'Garage service', 160), description: safe(item?.description || '', 600), quantity: Math.max(1, Number(item?.quantity || 1)), amount: Math.max(0, amount(item?.amount)) })),
    terms: 'This flat-rate estimate covers the scope shown. The displayed deposit is due upfront after approval and is applied to your total. The remaining balance is due on completion. Any material change requires your approval before additional work or charges.',
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

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function id(value, prefix = 'item') {
  const cleaned = safe(value, 100).replace(/[^a-zA-Z0-9_-]/g, '');
  return cleaned || newId(prefix);
}

// A company (biz_) approval names the delegated member, so an AP sign-off stays
// attributable after that member's name, role or access changes. Homeowner and
// family approvals keep their existing shape. Only the saved job holds these
// ids: the approval response and portal DTOs never return them.
function approvalActor(actorId) {
  if (!String(actorId || '').startsWith('biz_')) return {};
  const { accountId, memberId } = parseBusinessActor(actorId);
  return { approvedByActorId: actorId, approvedByBusinessAccountId: accountId, approvedByBusinessMemberId: memberId };
}

// The estimate is spread forward on re-approval; an earlier company approver
// must never be credited with a later signature.
function withoutApprovalActor(estimate) {
  return Object.fromEntries(Object.entries(estimate || {}).filter(([key]) => !APPROVAL_ACTOR_FIELDS.includes(key)));
}

// Firestore answers a stale currentDocument.updateTime with 400
// FAILED_PRECONDITION (as business-hub-store.js assumes); 409/412 count too.
function conflict(error) {
  return /\((400|409|412)\)/.test(String(error?.message));
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
    // A company project's people are managed in its business account, and the
    // server refuses invitations for it (CUSTOMER_PORTAL_BUSINESS_PROJECT).
    invitesAvailable: owner && !businessAccountJob(job),
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

function sanitize(job, session = {}, { today, reviewUrl }) {
  const finance = moneyState(job);
  const estimate = estimateState(job, finance, today);
  const state = portalStatus(job), review = reviewReady(job);
  const owner = !session.actorId, experience = customerExperience(job, owner), actor = experience.collaborators.find(person => person.id === session.actorId);
  return {
    ok: true,
    viewer: { owner, actorId: safe(session.actorId, 100), name: actor?.name || '', permissions: session.permissions || { view: true, decide: true, pay: true, rebook: true } },
    customer: { firstName: safe(job.customer || 'Customer', 120).split(/\s+/)[0], name: safe(job.customer || 'Customer', 120) },
    appointment: {
      date: safe(job.date, 30), time: safe(job.time, 20), endTime: safe(job.endTime, 20),
      address: safe(job.address, 240), service: estimate.service, status: state,
      // Dispatch writes a Denver range label; older jobs keep the walkthrough brief text.
      arrivalWindow: safe(job.arrivalWindow || job.jobInstructions?.arrivalWindow || job.instructions?.arrivalWindow || '', 80),
    },
    estimate,
    payment: {
      total: finance.total, paid: finance.paid, balance: finance.balance,
      dueNow: customerPaymentNeedsReview(job) ? 0 : customerDepositState(job, finance).dueNow,
      purpose: customerDepositState(job, finance).purpose,
      deposit: customerDepositState(job, finance),
      needsReview: customerPaymentNeedsReview(job),
      status: paymentStatus(job, finance),
      receiptUrl: /^https:\/\/pay\.stripe\.com\/receipts\//.test(job.payment?.receiptUrl || '') ? job.payment.receiptUrl : '',
      receiptEmail: safe(job.payment?.receiptEmail || '', 180),
      invoiceNumber: safe(job.invoice?.number || '', 80),
      invoiceStatus: safe(job.invoice?.status || '', 30),
      dueDate: safe(job.invoice?.dueDate || '', 30),
      creditApplied: Math.max(0, amount(job.payment?.giftCreditApplied)), completionRequiresPayment: true,
    },
    progress: {
      status: state, activity: portalActivity(job),
      dispatchedAt: safe(job.dispatchedAt || job.lastCustomerMessage?.sentAt || '', 50),
      arrivedAt: safe(job.arrivedAt || '', 50),
      startedAt: safe(job.startedAt || '', 50),
      completedAt: safe(job.completedAt || job.postJobChecklist?.completedAt || '', 50),
      updatedAt: safe(job.updatedAt || '', 50),
    },
    photos: { customerUploadCount: Math.max(0, Number(job.customerPhotoCount || 0)), lastUploadedAt: safe(job.customerPhotoUpdatedAt || '', 50) },
    conversation: conversationMessages(job).map(message => ({
      id: message.id, direction: message.direction, authorRole: message.authorRole, authorName: message.authorName,
      body: message.body, createdAt: message.createdAt,
      delivery: { channel: message.delivery.channel, status: message.delivery.status, attemptedAt: message.delivery.attemptedAt },
    })),
    messaging: { highLevelLinked: Boolean(job.highlevelContactId), refreshSeconds: 20 },
    review: { eligible: review, url: review ? reviewUrl : '' },
    experience,
    support: { phone: '(970) 999-1818', phoneHref: 'tel:+19709991818', smsHref: 'sms:+19709991818' },
  };
}

async function requirePortal(request, env, { clock, read }) {
  try { return await readCustomerPortalContext(env, await verifyCustomerPortalSessionToken(env, readCookie(request), clock().getTime()), { read }); }
  catch (error) {
    return { error: reply(error.status || 503, { ok: false, code: error.code || 'CUSTOMER_PORTAL_STORAGE_UNAVAILABLE', error: error.message }) };
  }
}

async function handleGet({ request, env }, deps) {
  if (!allowed(request)) return reply(403, { ok: false, error: 'Forbidden origin' });
  const result = await requirePortal(request, env, deps);
  if (result.error) return result.error;
  const at = deps.clock();
  return reply(200, { ...sanitize(result.job, result.session, { today: denverToday(at), reviewUrl: customerReviewUrl(env) }), documents: moneyDocumentLinks(result.job, { enabled: moneyDocumentEnabled(env), now: at.toISOString() }) });
}

async function handlePost({ request, env }, { clock, read }) {
  if (!allowed(request)) return reply(403, { ok: false, error: 'Forbidden origin' });
  const result = await requirePortal(request, env, { clock, read });
  if (result.error) return result.error;
  const raw = await request.text();
  if (raw.length > 32 * 1024) return reply(413, { ok: false, error: 'Request too large' });
  let body;
  try { body = JSON.parse(raw); } catch { return reply(400, { ok: false, error: 'Invalid JSON' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { ok: false, error: 'Invalid JSON' });
  const started = clock(), now = started.toISOString(), today = denverToday(started);
  const owner = !result.session.actorId, can = permission => owner || Boolean(result.session.permissions?.[permission]);
  const ownerOnly = new Set(['save_customer_memory', 'save_job_day_rules', 'save_collaborators', 'create_collaborator_invite', 'request_gift_transfer', 'record_photo_upload']);
  if (ownerOnly.has(body.action) && !owner) return reply(403, { ok: false, error: 'Only the primary customer can make that change' });
  if (body.action === 'approve_estimate' && !can('decide')) return reply(403, { ok: false, error: 'You are not authorized to approve changes' });
  if (body.action === 'respond_decision' && !can('decide')) return reply(403, { ok: false, error: 'You are not authorized to answer job decisions' });
  if (body.action === 'request_rebook' && !can('rebook')) return reply(403, { ok: false, error: 'You are not authorized to rebook this property' });
  if (['create_payment', 'verify_payment', 'apply_gift_credit'].includes(body.action) && !can('pay')) return reply(403, { ok: false, error: 'You are not authorized to pay for this job' });

  if (body.action === 'send_message') {
    const messageBody = cleanMessage(body.body), requestId = cleanRequestId(body.request_id);
    if (!messageBody) return reply(400, { ok: false, error: 'Write a message before sending' });
    if (!requestId) return reply(400, { ok: false, error: 'A valid message request ID is required' });
    const duplicate = findConversationMessage(result.job, { requestId });
    if (duplicate) return reply(200, { ok: true, duplicate: true, message: duplicate, conversation: conversationMessages(result.job) });
    const authorName = safe(result.session.actorId
      ? customerExperience(result.job, true).collaborators.find(person => person.id === result.session.actorId)?.name
      : result.job.customer, 120) || 'Customer';
    const message = {
      id: `customer-${requestId}`.slice(0, 140), requestId, direction: 'from_customer', authorRole: 'customer',
      authorName, body: messageBody, createdAt: now,
      delivery: { channel: 'portal', status: 'received', attemptedAt: now },
    };
    let queued;
    try {
      queued = await patchJob(env, result.session.jobId, { customerConversation: appendConversationMessage(result.job, message), customerConversationUpdatedAt: now, updatedAt: now }, result.jobUpdateTime);
    } catch {
      return reply(409, { ok: false, error: 'The conversation changed. Refresh and send again.' });
    }
    const highLevelDelivery = await deliverHighLevelMessage(env, queued, { body: messageBody, direction: 'from_customer' });
    const delivery = highLevelDelivery.status === 'sent' ? highLevelDelivery : message.delivery;
    let updated = queued;
    try {
      const latest = await read(env, result.session.jobId), deliveredAt = clock().toISOString();
      updated = await patchJob(env, result.session.jobId, { customerConversation: replaceConversationMessage(latest, message.id, { delivery }), customerConversationUpdatedAt: deliveredAt, updatedAt: deliveredAt }, latest.__updateTime);
    } catch { /* The customer reply is already safely stored in the project thread. */ }
    return reply(200, { ok: true, message: { ...message, delivery }, conversation: conversationMessages(updated) });
  }

  if (body.action === 'approve_estimate') {
    const signedName = safe(body.signed_name, 120);
    if (signedName.length < 3 || body.confirmed !== true) return reply(400, { ok: false, error: 'Enter your full name and confirm the estimate' });
    const finance = moneyState(result.job);
    if (finance.total < .01) return reply(409, { ok: false, error: 'The estimate is not ready yet' });
    if (result.job.estimate?.validUntil && String(result.job.estimate.validUntil) < today) return reply(409, { ok: false, error: 'This estimate has expired. Ask the team for an updated estimate.' });
    const approval = { status: 'approved', approvedAt: now, approvedBy: signedName, amount: finance.total, source: 'customer_portal' };
    const deposit = customerDepositState(result.job, finance), actor = approvalActor(result.session.actorId);
    try {
      await patchJob(env, result.session.jobId, {
        customerApproval: { ...approval, ...actor },
        estimate: { ...withoutApprovalActor(result.job.estimate), status: 'approved', acceptedAt: now, acceptedBy: signedName, amount: finance.total, depositRequired: deposit.required, ...actor },
        deposit: { ...(result.job.deposit || {}), amount: deposit.required, paidAmount: deposit.paid, status: deposit.due < .01 ? 'paid' : deposit.paid ? 'partial' : 'due' },
        quoteStatus: 'approved',
        updatedAt: now,
      }, result.jobUpdateTime);
    } catch { return reply(409, { ok: false, error: 'The estimate changed. Refresh before approving it.' }); }
    const salesFollowupExit = await syncSalesFollowupExit(env, result.session.jobId);
    return reply(200, { ok: true, approval, salesFollowupExit });
  }

  if (body.action === 'create_payment') {
    const secret = stripeKey(env);
    if (!secret) return reply(501, { ok: false, error: 'Online payments are not configured' });
    const requestId = safe(body.request_id, 120);
    if (!requestId) return reply(400, { ok: false, error: 'Payment request ID required' });
    try {
      return reply(200, await createCustomerStripeCheckout(env, secret, result.session.jobId, new URL(request.url).origin));
    } catch (error) { return reply(error.status || 502, { ok: false, error: error.message || 'Secure checkout could not be created' }); }
  }

  if (body.action === 'verify_payment') {
    const secret = stripeKey(env);
    if (!secret) return reply(501, { ok: false, error: 'Online payments are not configured' });
    const sessionId = safe(body.session_id, 180);
    if (!/^cs_(?:test_|live_)?[A-Za-z0-9_]+$/.test(sessionId)) return reply(400, { ok: false, error: 'Invalid Checkout session' });
    try {
      const checkout = await stripe(secret, `checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent.latest_charge`);
      return reply(200, { ok: true, ...await recordCustomerStripePayment(env, checkout, result.session.jobId) });
    } catch (error) { return reply(error.status || 502, { ok: false, error: error.message || 'Stripe payment could not be verified' }); }
  }

  if (body.action === 'save_customer_memory') {
    const memory = {
      accessInstructions: safe(body.access_instructions, 600), parkingNotes: safe(body.parking_notes, 400),
      petNotes: safe(body.pet_notes, 400), alarmNotes: safe(body.alarm_notes, 400), importantItems: safe(body.important_items, 800),
      communicationPreference: ['text', 'email', 'call'].includes(body.communication_preference) ? body.communication_preference : 'text',
      preferredCrew: safe(body.preferred_crew, 160), updatedAt: now, source: 'customer_portal',
    };
    try {
      await patchJob(env, result.memoryJobId, { customerMemory: memory, customerMemoryUpdatedAt: now, updatedAt: now }, result.memoryUpdateTime);
    } catch(error) {
      return reply(conflict(error)?409:503,{ok:false,error:'Property preferences could not be saved. Refresh the project and review its latest instructions before retrying.'});
    }
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
    try {
      await patchJob(env, result.session.jobId, { jobDayRules: rules, updatedAt: now }, result.jobUpdateTime);
    } catch (error) {
      return conflict(error)
        ? reply(409, { ok: false, code: 'CUSTOMER_PORTAL_REVISION_CONFLICT', error: 'Your job-day plan changed. Refresh and review it before saving again.' })
        : reply(503, { ok: false, code: 'CUSTOMER_PORTAL_STORAGE_UNAVAILABLE', error: 'Your job-day plan could not be saved. Please try again shortly.' });
    }
    return reply(200, { ok: true, rules });
  }

  if (body.action === 'save_collaborators') {
    const supplied = Array.isArray(body.collaborators) ? body.collaborators.slice(0, 8).map(person => person && typeof person === 'object' ? person : {}) : [];
    // Ids are server-issued: a browser may keep an existing person's id but
    // never mint one, and never one that could be read as a business grant.
    const known = new Set((Array.isArray(result.job.customerCollaborators) ? result.job.customerCollaborators : []).map(person => person?.id).filter(value => typeof value === 'string' && value && !value.startsWith('biz_')));
    const used = new Set();
    const collaborators = supplied.map(person => {
      const personId = known.has(person.id) && !used.has(person.id) ? person.id : newId('person');
      used.add(personId);
      return {
        id: personId, name: safe(person.name, 120), email: email(person.email), role: safe(person.role || 'Family', 80),
        permissions: { view: true, decide: Boolean(person.permissions?.decide), pay: Boolean(person.permissions?.pay), rebook: Boolean(person.permissions?.rebook) },
        status: 'active', updatedAt: now,
      };
    }).filter(person => person.name && person.email);
    if (supplied.length && !collaborators.length) return reply(400, { ok: false, error: 'Add a name and valid email for each person' });
    try {
      await patchJob(env, result.accountJobId, { customerCollaborators: collaborators, collaboratorsUpdatedAt: now, updatedAt: now }, result.accountUpdateTime);
    } catch (error) {
      return conflict(error)
        ? reply(409, { ok: false, code: 'CUSTOMER_PORTAL_REVISION_CONFLICT', error: 'Your authorized people changed. Refresh and review them before saving again.' })
        : reply(503, { ok: false, code: 'CUSTOMER_PORTAL_STORAGE_UNAVAILABLE', error: 'Authorized people could not be saved. Please try again shortly.' });
    }
    return reply(200, { ok: true, collaborators });
  }

  if (body.action === 'create_collaborator_invite') {
    // A company project's people are managed in its business account. An owner
    // link that predates the business link can never mint more access to it.
    if (businessAccountJob(result.job)) return reply(403, { ok: false, code: 'CUSTOMER_PORTAL_BUSINESS_PROJECT', error: 'This project is managed through a business account, so invitations are not available here. Contact Easy Garage Cleaning to add someone.' });
    const personId = id(body.person_id, 'person');
    const people = Array.isArray(result.job.customerCollaborators) ? result.job.customerCollaborators : [];
    const person = people.find(item => item.id === personId && item.status !== 'removed' && !personId.startsWith('biz_'));
    if (!person) return reply(404, { ok: false, error: 'That authorized person is no longer available' });
    // Bind the invitation to the account's current link version and root so a
    // staff revocation ends it even when saved people are kept (P4-15).
    const token = await createCustomerPortalCollaboratorAccessToken(env, result.session.jobId, person.id, { view: true, decide: Boolean(person.permissions?.decide), pay: Boolean(person.permissions?.pay), rebook: Boolean(person.permissions?.rebook) }, clock().getTime(), result.linkVersion, result.linkRoot);
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
    if (timing === 'choose_date' && (!preferredDate || preferredDate < today)) return reply(400, { ok: false, error: 'Choose a future preferred date' });
    const requests = Array.isArray(result.job.rebookingRequests) ? result.job.rebookingRequests : [];
    const duplicate = requests.find(request => request.status === 'pending' && request.kind === kind && request.timing === timing && (request.preferredDate || '') === preferredDate && safe(request.notes, 600) === safe(body.notes, 600));
    if (duplicate) return reply(200, { ok: true, request: duplicate });
    if (requests.filter(request => request.status === 'pending').length >= 3) return reply(409, { ok: false, error: 'The team already has your rebooking request' });
    const request = { id: newId('rebook'), kind, timing, preferredDate, preferredCrew: Boolean(body.preferred_crew), notes: safe(body.notes, 600), status: 'pending', requestedAt: now, sourceJobId: result.session.jobId };
    try {
      await patchJob(env, result.session.jobId, { rebookingRequests: [...requests, request].slice(-10), rebookingStatus: 'pending', rebookingUpdatedAt: now, updatedAt: now }, result.jobUpdateTime);
    } catch { return reply(409, { ok: false, error: 'Your project changed. Refresh before requesting another visit.' }); }
    return reply(200, { ok: true, request });
  }

  if (body.action === 'apply_gift_credit') {
    if (customerPaymentNeedsReview(result.job)) return reply(409, { ok: false, error: 'A recorded payment needs team verification before applying another payment or credit' });
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
    const redemption = { id: newId('redemption'), requestId, cardId, amount: applied, appliedAt: now, jobId: result.session.jobId };
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
    const transfer = { id: newId('transfer'), cardId, recipientName, recipientEmail, amount: amount(card.remainingAmount), status: 'pending', requestedAt: now };
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

  if (body.action === 'record_review_click') {
    const requestId = typeof body.request_id === 'string' && UUID.test(body.request_id) ? body.request_id.toLowerCase() : '';
    if (!requestId) return reply(400, { ok: false, code: 'CUSTOMER_PORTAL_REQUEST_INVALID', error: 'A valid review request ID is required' });
    const viewer = owner ? 'customer' : String(result.session.actorId).startsWith('biz_') ? 'business' : 'collaborator', actorId = owner ? '' : safe(result.session.actorId, 100);
    let job = result.job, updateTime = result.jobUpdateTime;
    // Only the click is recorded. Nothing is sent to the customer or Google.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const clicks = Array.isArray(job.reviewClicks) ? job.reviewClicks : [];
      if (clicks.some(click => click?.requestId === requestId)) return reply(200, { ok: true, recorded: false, duplicate: true });
      if (!reviewReady(job)) return reply(409, { ok: false, code: 'CUSTOMER_PORTAL_REVIEW_NOT_READY', error: 'Reviews open after your project is complete and paid.' });
      // One visit per viewer per minute: repeat taps or a looping client cannot
      // inflate the staff count or keep bumping the job's revision.
      if (clicks.some(item => item?.viewer === viewer && String(item.actorId || '') === actorId && Math.abs(started.getTime() - Date.parse(item.clickedAt)) < REVIEW_CLICK_WINDOW_MS)) return reply(200, { ok: true, recorded: false, duplicate: false });
      const click = { requestId, clickedAt: now, viewer, ...(owner ? {} : { actorId }) };
      try {
        await patchJob(env, result.session.jobId, {
          reviewClicks: [...clicks, click].slice(-20), reviewClickCount: Math.max(0, Number(job.reviewClickCount) || 0) + 1,
          reviewClickedAt: safe(job.reviewClickedAt, 50) || now, reviewLastClickedAt: now,
        }, updateTime);
        return reply(200, { ok: true, recorded: true, duplicate: false });
      } catch (error) {
        if (!conflict(error)) break;
      }
      try { job = await read(env, result.session.jobId); } catch { job = null; }
      if (!job) break;
      updateTime = job.__updateTime || '';
    }
    return reply(503, { ok: false, code: 'CUSTOMER_PORTAL_STORAGE_UNAVAILABLE', error: 'Your review link is ready. We could not note the visit, and nothing else changed.' });
  }

  return reply(400, { ok: false, error: 'Unknown customer portal action' });
}

export async function onRequestDelete() {
  return reply(200, { ok: true }, { 'Set-Cookie': clearCustomerPortalSessionCookie() });
}

export function createCustomerPortalHandlers({ now = () => new Date(), read = readJob } = {}) {
  const deps = { clock: now, read };
  return { onRequestGet: context => handleGet(context, deps), onRequestPost: context => handlePost(context, deps), onRequestDelete };
}

const handlers = createCustomerPortalHandlers();
export const onRequestGet = handlers.onRequestGet;
export const onRequestPost = handlers.onRequestPost;
