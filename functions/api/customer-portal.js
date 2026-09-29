import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { syncSalesFollowupExit } from '../_lib/sales-followup-exit.js';
import { clearCustomerPortalSessionCookie, createCustomerPortalCollaboratorAccessToken, readCookie, verifyCustomerPortalSessionToken } from '../_lib/customer-portal.js';
import { readCustomerPortalContext } from '../_lib/customer-portal-access.js';
import { denverToday } from '../_lib/dispatch-time.js';
import { fieldActivity } from '../_lib/field-execution.js';
import { customerPhotoPolicy, customerPhotoProjection, customerPhotosEnabled } from '../_lib/customer-photo-visibility.js';
import { commitDocuments, patchJob, readJob } from '../_lib/firestore-job.js';
import { CUSTOMER_PORTAL_CONTENT, CUSTOMER_PORTAL_TERMS_VERSION, approvalTermsVersion, customerPortalDocuments } from '../_lib/customer-portal-content.js';
import { appendConversationMessage, cleanMessage, cleanRequestId, conversationMessages, deliverHighLevelMessage, findConversationMessage, replaceConversationMessage } from '../_lib/customer-messaging.js';
import { TIP_PRESETS, customerMoneyState as moneyState, customerDepositState, customerPaymentNeedsReview, customerQuoteTotal, customerTipsEnabled, customerTotalsShadow, createCustomerStripeCheckout, portalPaymentHeld, recordCustomerStripePayment, recordedTipCents, requestTip, stripeRequest as stripe, stripeSecretKey as stripeKey, tipLimitCents, tipRefusal, unknownMoneyRefusal } from '../_lib/customer-payments.js';
import { approvalClosed, billedChangeCents, billedChangeOrders, changeOrderBillingEnabled, changeOrderSaved, decisionDeltaCents, respondToDecision } from '../_lib/change-orders.js';
import { parseBusinessActor } from '../_lib/business-hub-core.js';
import { businessAccountJob } from '../_lib/portal-invitation.js';
import { moneyDocumentEnabled, moneyDocumentLinks } from '../_lib/money-document.js';
import { customerMoneyTotals, invoiceTakesPayment, moneyInvoiceStateEnabled, moneyTotalsMode } from '../_lib/money-core.js';
import { estimateFingerprint, included, legacyLineItems, unsentQuoteDraft } from '../_lib/quote-model.js';
import { crewPublicProfilesEnabled, customerCrew, customerCrewProjection, readCrewPublicProfiles } from '../_lib/crew-public-profile.js';
import { liveSale, portalApprovalWrites, portalFunnelWrite, vocabularyValue } from '../_lib/job-funnel-events.js';

const HOST = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/;
const DEFAULT_REVIEW_URL = 'https://search.google.com/local/writereview?placeid=ChIJ17AGfBiyRIsRyJ3k4mDtX8Q';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVIEW_CLICK_WINDOW_MS = 60 * 1000;
const PORTAL_REQUEST = /^[A-Za-z0-9_-]{8,120}$/;
const CLOSED_VISIT = ['cancelled', 'canceled', 'no_show', 'noshow', 'no-show'];
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
// A field time on a cancelled or no-show visit, or from before a restore,
// belongs to an earlier attempt (dispatch keeps the times), so it never moves
// the visit the customer is waiting for past scheduled.
function portalStatus(job) {
  const raw = String(job.pipelineStatus || job.status || 'scheduled').toLowerCase();
  if (raw === 'paid') return 'paid';
  if (['completed', 'review_requested', 'closed'].includes(raw) || raw === 'invoiced' && (job.completedAt || job.postJobChecklist?.completedAt)) return 'completed';
  const restoredAt = Date.parse(job.restoredAt || ''), current = at => Boolean(at) && !CLOSED_VISIT.includes(raw) && !(Date.parse(at) <= restoredAt);
  if (['in_progress', 'paused'].includes(raw) || current(job.startedAt)) return 'in_progress';
  if (['arrived', 'waiting'].includes(raw) || current(job.arrivedAt)) return 'arrived';
  if (['dispatched', 'delayed'].includes(raw) || current(job.dispatchedAt)) return 'dispatched';
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
function reviewReady(job, mode = 'off') {
  return ['completed', 'paid'].includes(portalStatus(job)) && paymentStatus(job, moneyState(job, mode)) === 'paid';
}

export function customerReviewUrl(env = {}) {
  const raw = String(env.GOOGLE_REVIEW_URL || '').trim();
  if (!raw || raw.length > 500) return DEFAULT_REVIEW_URL;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : DEFAULT_REVIEW_URL;
  } catch { return DEFAULT_REVIEW_URL; }
}

// A replaced or withdrawn estimate is never approvable. A draft is refused only
// with CUSTOMER_PORTAL_REJECT_DRAFT_ESTIMATES=true: Hub estimate saves still
// release customer-facing estimates as 'draft' today. A quote drafted in the Hub
// (P2-07) that has not been sent in its current revision is never approvable,
// whatever the flag says (unsentQuoteDraft).
const rejectDrafts = env => env?.CUSTOMER_PORTAL_REJECT_DRAFT_ESTIMATES === 'true';
function approvalBlocked(job, draftsRejected) {
  const status = String(job.estimate?.status || '').toLowerCase();
  return ['superseded', 'void', 'withdrawn'].includes(status) || draftsRejected && status === 'draft' || unsentQuoteDraft(job);
}

function estimateRevision(job) {
  const value = Number(job.estimate?.revision || 1);
  return Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

// Saved lines are read through the canonical quote model: only included lines
// are shown, and discounts keep their sign.
function estimateLines(job, finance) {
  if (!Array.isArray(job.estimate?.lineItems) || !job.estimate.lineItems.length) return [{ name: safe(job.serviceType || job.type || 'Garage service', 160), description: safe(job.estimate?.scope || job.scopeSummary || '', 600), quantity: 1, amount: Math.max(0, amount(finance.total)) }];
  return legacyLineItems(job).lineItems.filter(included).map(line => ({ name: line.name, description: line.description, quantity: line.quantity, amount: line.amount ?? 0 }));
}

// A digest of exactly what the estimate card shows (total, deposit, scope and
// lines); an approval must name it, so a scope or line edit that keeps the
// revision and total still needs a fresh review.
const shownFingerprint = estimate => estimateFingerprint({ amount: estimate.amount, depositRequired: estimate.depositRequired, scope: estimate.scope, lineItems: estimate.lineItems });

// The estimate card shows the signed quote; billed change orders are part of
// the payment total, never of the estimate an approval binds to.
function estimateState(job, finance, today, draftsRejected = false) {
  const quote = { ...finance, total: customerQuoteTotal(job) };
  const rawStatus = String(job.customerApproval?.status || job.estimate?.status || job.quoteStatus || (quote.total ? 'ready' : 'not_ready')).toLowerCase();
  const validUntil = safe(job.estimate?.validUntil || '', 30);
  const status = validUntil && validUntil < today && !['accepted', 'approved'].includes(rawStatus) ? 'expired' : rawStatus;
  const estimate = {
    number: safe(job.estimate?.number || job.quoteId || `EST-${String(job.id || '').slice(-6).toUpperCase()}`, 80),
    status: ['accepted', 'approved'].includes(status) ? 'approved' : status,
    amount: quote.total,
    service: safe(job.serviceType || job.type || 'Garage service', 120),
    scope: safe(job.estimate?.scope || job.scopeSummary || 'Your flat-rate garage service based on the agreed walkthrough scope.', 1600),
    approvedAt: safe(job.customerApproval?.approvedAt || job.estimate?.acceptedAt || '', 50),
    approvedBy: safe(job.customerApproval?.approvedBy || '', 120),
    validUntil,
    revision: estimateRevision(job),
    approvable: !approvalBlocked(job, draftsRejected),
    depositRequired: customerDepositState(job, finance).required,
    lineItems: estimateLines(job, quote),
    terms: CUSTOMER_PORTAL_CONTENT.estimateTerms,
    termsVersion: CUSTOMER_PORTAL_TERMS_VERSION,
  };
  return { ...estimate, fingerprint: shownFingerprint(estimate) };
}

// An unsent quote draft is withheld: the customer sees that it is being updated,
// never its unsent price, deposit, scope or lines, and nothing to approve.
function withheldEstimate(job) {
  const estimate = {
    number: safe(job.estimate?.number || job.quoteId || `EST-${String(job.id || '').slice(-6).toUpperCase()}`, 80),
    status: 'being_updated', withheld: true, amount: 0,
    service: safe(job.serviceType || job.type || 'Garage service', 120), scope: '',
    approvedAt: '', approvedBy: '', validUntil: '', revision: estimateRevision(job), approvable: false,
    depositRequired: 0, lineItems: [], terms: CUSTOMER_PORTAL_CONTENT.estimateTerms, termsVersion: CUSTOMER_PORTAL_TERMS_VERSION,
  };
  return { ...estimate, fingerprint: shownFingerprint(estimate) };
}
// Recorded payments stay visible, with the Stripe receipt link and the printable
// receipt (moneyDocumentKinds keeps 'receipt', rendered without the unsent
// total). The unsent total, balance, deposit and any invoice do not, and the
// status never says whether the unsent total is covered: 'received', not 'partial'.
function withheldPayment(job, finance) {
  const needsReview = customerPaymentNeedsReview(job), deposit = { required: 0, paid: 0, due: 0, dueNow: 0, purpose: 'deposit', remainder: 0 };
  return {
    total: 0, paid: finance.paid, balance: 0, approvedChanges: 0, dueNow: 0, purpose: 'deposit', deposit, needsReview, withheld: true,
    status: needsReview ? 'pending_verification' : finance.paid ? 'received' : 'unpaid',
    receiptUrl: /^https:\/\/pay\.stripe\.com\/receipts\//.test(job.payment?.receiptUrl || '') ? job.payment.receiptUrl : '',
    receiptEmail: safe(job.payment?.receiptEmail || '', 180), invoiceNumber: '', invoiceStatus: '', dueDate: '',
    creditApplied: Math.max(0, amount(job.payment?.giftCreditApplied)), completionRequiresPayment: true,
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

// FUN-03: a portal change and its funnel events are one :commit (the events
// are create-only), so an event exists exactly when its change was saved. A
// private record has no events (the builders return null).
function commitWithEvents(env, updates, events) {
  return commitDocuments(env, [...updates, ...events.filter(Boolean).map(event => ({ ...event, create: true }))]);
}

// An event the funnel ledger refuses (funnel_event_*) is a server fault: the
// customer is never told the record changed and to refresh.
function eventRefused(error) {
  return String(error?.code || '').startsWith('funnel_event_') ? reply(503, { ok: false, code: 'CUSTOMER_PORTAL_STORAGE_UNAVAILABLE', error: 'This could not be saved right now, and nothing changed. Please try again shortly.' }) : null;
}

// An optional portal request_id (a later page resends it on retry); without
// one the server names the request. A malformed one is refused.
function portalRequestId(value) {
  if (value === undefined || value === null || value === '') return { id: '', key: crypto.randomUUID() };
  return typeof value === 'string' && PORTAL_REQUEST.test(value) ? { id: value, key: value } : null;
}

// Firestore answers a stale currentDocument.updateTime with 400
// FAILED_PRECONDITION; 409/412 count too.
function conflict(error) {
  return /\((400|409|412)\)/.test(String(error?.message));
}

// What the portal needs to show a job's decisions: every saved change-order
// line, the decisions billed on the balance, and (billing on) the clock that
// closes priced questions.
function decisionContext(job, { billing = false, now = '' } = {}) {
  const saved = (Array.isArray(job.changeOrders) ? job.changeOrders : []).filter(line => line !== null && typeof line === 'object' && !Array.isArray(line));
  return { job, billing, now, saved, billed: new Set(billedChangeOrders(job).map(line => line.decisionId)) };
}

// What a portal viewer sees of one crew decision. `billed` marks an approved
// change whose change-order line is on the balance. A pending question that
// already has its own saved line was answered before and a stale Hub write
// reverted it: it shows as the approval that line records, never with Approve
// and Decline (the server refuses both). `closed` marks a pending question
// that cannot be answered here, with closedReason 'review' (its line id is
// taken) or, with billing on, a priced question whose job is 'closed' or
// 'finished' or that has 'expired'.
function decisionView(item, context) {
  const priceDelta = Math.max(0, amount(item.priceDelta)), own = context.saved.find(line => line.decisionId === item.id);
  let status = ['pending', 'approved', 'declined', 'cancelled'].includes(item.status) ? item.status : 'pending';
  const reverted = status === 'pending' && Boolean(own);
  if (reverted) status = 'approved';
  const closedReason = status !== 'pending' ? '' : changeOrderSaved(context.saved, item.id) ? 'review' : context.billing && priceDelta > 0 ? approvalClosed(context.job, item, context.now) : '';
  return {
    id: id(item.id, 'decision'), title: safe(item.title, 180), details: safe(item.details, 1200),
    photoUrl: /^https:\/\/(?:drive|docs)\.google\.com\//i.test(item.photoUrl || '') ? item.photoUrl : '',
    priceDelta, timeDeltaMinutes: Math.max(0, Number(item.timeDeltaMinutes || 0)), status,
    promptedAt: safe(item.promptedAt, 50), respondedAt: safe(item.respondedAt || (reverted ? own.approvedAt : ''), 50), responseNote: safe(item.responseNote, 600), responseBy: safe(item.responseBy || (reverted ? own.approvedBy : ''), 120),
    billed: status === 'approved' && context.billed.has(item.id), closed: Boolean(closedReason), ...(closedReason ? { closedReason } : {}),
  };
}

function customerExperience(job, owner = true, { billing = false, now = '' } = {}) {
  const memory = job.customerMemory || {};
  const rules = job.jobDayRules || {};
  const collaborators = Array.isArray(job.customerCollaborators) ? job.customerCollaborators : [];
  const decisions = Array.isArray(job.customerDecisions) ? job.customerDecisions : [], shown = decisionContext(job, { billing, now });
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
    decisions: decisions.slice(-20).map(item => decisionView(item, shown)).sort((a, b) => String(b.promptedAt).localeCompare(String(a.promptedAt))),
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

// Shown only with CUSTOMER_TIPS_ENABLED: a tip is offered on the balance
// payment to a viewer who may pay, never on the deposit or while review waits
// (or a card payment is held for the team), and never on a closed, void-invoice
// or refunded job (tipRefusal).
function tipOffer(job, finance, permissions, held = false, mode = 'off') {
  const needsReview = customerPaymentNeedsReview(job), due = customerDepositState(job, finance, mode), dueCents = Math.round(due.dueNow * 100);
  const available = !needsReview && held !== true && !tipRefusal(job) && due.purpose === 'balance' && dueCents >= 50 && permissions?.pay !== false;
  return { available, maxCents: available ? tipLimitCents(dueCents) : 0, presets: [...TIP_PRESETS], paidCents: recordedTipCents(job) };
}

// Each change the customer approved that is billed on the balance, as its own line (never an approval without a line).
const approvedChanges = job => billedChangeOrders(job).map(line => ({ id: safe(line.id, 80), name: safe(line.name, 160) || 'Approved change', description: safe(line.description, 600), amount: line.totalCents / 100 }));

// An opaque per-job key the page scopes its saved requests with (never the job id).
const portalJobKey = jobId => bytesToHex(sha256(new TextEncoder().encode(`egc-portal-job:${jobId}`))).slice(0, 16);

// held (tips on only): true while a card payment is held for the team (the Pay
// button is hidden and nothing is due now), false when not, null when the
// checkout ledger or the job's payment reviews could not be read (Pay then
// refuses until they can be).
// mode is the money totals mode (MONEY_UNIFIED_TOTALS, money-core moneyTotalsMode). The estimate card and the approval it
// binds keep today's figures in every mode; in mode 'unified' the payment block serves money-core's unified totals, lists
// each billed change (changes) and says when the amounts need the team's review (moneyReview: nothing is due online). A job
// with no quote saved yet is shown as today, with nothing due and no review (unpriced).
function sanitize(job, session = {}, { today, reviewUrl, draftsRejected = false, billing = false, now = '', tips = false, held = false, mode = 'off' }) {
  const quoted = moneyState(job), finance = mode === 'unified' ? moneyState(job, mode) : quoted, withheld = unsentQuoteDraft(job);
  const estimate = withheld ? withheldEstimate(job) : estimateState(job, quoted, today, draftsRejected);
  const state = portalStatus(job), review = reviewReady(job, mode), { unknown = false, unpriced = false, ...deposit } = customerDepositState(job, finance, mode), moneyReview = unknown && !unpriced;
  const owner = !session.actorId, experience = customerExperience(job, owner, { billing, now }), actor = experience.collaborators.find(person => person.id === session.actorId);
  return {
    ok: true,
    viewer: { owner, actorId: safe(session.actorId, 100), name: actor?.name || '', permissions: session.permissions || { view: true, decide: true, pay: true, rebook: true }, jobKey: portalJobKey(job.id) },
    customer: { firstName: safe(job.customer || 'Customer', 120).split(/\s+/)[0], name: safe(job.customer || 'Customer', 120) },
    appointment: {
      date: safe(job.date, 30), time: safe(job.time, 20), endTime: safe(job.endTime, 20),
      address: safe(job.address, 240), service: estimate.service, status: state,
      // Dispatch writes a Denver range label; older jobs keep the walkthrough brief text.
      arrivalWindow: safe(job.arrivalWindow || job.jobInstructions?.arrivalWindow || job.instructions?.arrivalWindow || '', 80),
    },
    estimate,
    payment: withheld ? withheldPayment(job, finance) : {
      total: finance.total, paid: finance.paid, balance: finance.balance, approvedChanges: billedChangeCents(job) / 100,
      dueNow: customerPaymentNeedsReview(job) || (tips && held === true) ? 0 : deposit.dueNow,
      purpose: deposit.purpose,
      deposit,
      needsReview: customerPaymentNeedsReview(job),
      status: paymentStatus(job, finance),
      receiptUrl: /^https:\/\/pay\.stripe\.com\/receipts\//.test(job.payment?.receiptUrl || '') ? job.payment.receiptUrl : '',
      receiptEmail: safe(job.payment?.receiptEmail || '', 180),
      invoiceNumber: safe(job.invoice?.number || '', 80),
      invoiceStatus: safe(job.invoice?.status || '', 30),
      dueDate: safe(job.invoice?.dueDate || '', 30),
      creditApplied: Math.max(0, amount(job.payment?.giftCreditApplied)), completionRequiresPayment: true,
      ...(mode === 'unified' ? { changes: approvedChanges(job), moneyReview } : {}),
      ...(tips ? { held, tip: tipOffer(job, finance, session.actorId ? session.permissions : null, held, mode) } : {}),
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
    documents: customerPortalDocuments(),
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
  const at = deps.clock(), tips = customerTipsEnabled(env), mode = moneyTotalsMode(env);
  if (mode === 'shadow') customerTotalsShadow(result.job, 'portal');
  // Only with tips on, so the tips-off read is unchanged: held means Pay would be refused now (a held tipped charge,
  // or with PAYMENT_REVIEW_CHECKOUT_BLOCK_ENABLED any open review), derived from the reviews themselves.
  const held = tips ? await portalPaymentHeld(env, result.session.jobId, result.job, at.toISOString()).catch(() => null) : false;
  const body = { ...sanitize(result.job, result.session, { today: denverToday(at), reviewUrl: customerReviewUrl(env), draftsRejected: rejectDrafts(env), billing: changeOrderBillingEnabled(env), now: at.toISOString(), tips, held, mode }), moneyDocuments: moneyDocumentLinks(result.job, { enabled: moneyDocumentEnabled(env), now: at.toISOString(), unified: mode === 'unified', invoiceState: moneyInvoiceStateEnabled(env) }) };
  // Default off: without the flag the DTO keeps its current shape.
  if (customerPhotosEnabled(env) && result.session.permissions?.view !== false) body.beforeAfter = customerPhotoProjection(result.job, customerPhotoPolicy(env));
  // Default off as well. Only active crew profiles appear; a profile read failure hides the crew, never the project.
  if (crewPublicProfilesEnabled(env) && result.session.permissions?.view !== false) Object.assign(body, await customerCrew(env, result.job, { profiles: deps.crewProfiles, now: at }).catch(() => customerCrewProjection(result.job, new Map(), new Map(), at)));
  return reply(200, body);
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
    const highLevelDelivery = await deliverHighLevelMessage(env, queued, { body: messageBody, direction: 'from_customer', requestId }, { clock });
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
    const request = portalRequestId(body.request_id), saved = result.job.customerApproval;
    if (!request) return reply(400, { ok: false, code: 'CUSTOMER_PORTAL_REQUEST_INVALID', error: 'This approval request is invalid. Refresh and approve again.' });
    const spent = () => reply(409, { ok: false, code: 'CUSTOMER_PORTAL_IDEMPOTENCY_CONFLICT', error: 'This approval request was already used for an earlier signature. Review the current estimate before approving again.' });
    if (request.id && saved?.requestId === request.id) {
      // A retry of the same approval (its response was lost) returns the saved
      // signature only while the saved record is still that portal signature,
      // at the revision and total this request binds. The Hub's Record approval
      // merges a staff approval over it (keeping its requestId) and a revision
      // supersedes it: the request is then spent, and the page starts a new one.
      if (saved.status !== 'approved' || saved.source !== 'customer_portal' || saved.estimateRevision !== body.estimate_revision || Math.round(Number(saved.amount) * 100) !== body.amount_cents) return spent();
      const salesFollowupExit = await syncSalesFollowupExit(env, result.session.jobId, { now: clock });
      return reply(200, { ok: true, approval: { status: saved.status, approvedAt: saved.approvedAt, approvedBy: saved.approvedBy, amount: saved.amount, source: saved.source, termsVersion: saved.termsVersion }, replayed: true, salesFollowupExit });
    }
    const finance = moneyState(result.job), quote = customerQuoteTotal(result.job);
    if (quote < .01) return reply(409, { ok: false, error: 'The estimate is not ready yet' });
    if (result.job.estimate?.validUntil && String(result.job.estimate.validUntil) < today) return reply(409, { ok: false, error: 'This estimate has expired. Ask the team for an updated estimate.' });
    if (approvalBlocked(result.job, rejectDrafts(env))) return reply(409, { ok: false, code: 'CUSTOMER_PORTAL_ESTIMATE_NOT_APPROVABLE', error: 'This estimate is being updated and cannot be approved yet. Refresh the page or ask the team for the current estimate.' });
    // The approval binds to the exact revision, total and shown content the
    // customer saw. An older page that does not send them must refresh; it
    // never approves a price or scope it did not show.
    if (!Number.isSafeInteger(body.estimate_revision) || !Number.isSafeInteger(body.amount_cents) || typeof body.estimate_fingerprint !== 'string') return reply(409, { ok: false, code: 'CUSTOMER_PORTAL_ESTIMATE_CHANGED', error: 'This page is out of date. Refresh it to review the current estimate before approving.' });
    if (body.estimate_revision !== estimateRevision(result.job) || body.amount_cents !== Math.round(quote * 100) || body.estimate_fingerprint !== estimateState(result.job, finance, today).fingerprint) return reply(409, { ok: false, code: 'CUSTOMER_PORTAL_ESTIMATE_CHANGED', error: 'The estimate changed after this page loaded. Refresh and review the current estimate before approving.' });
    // The approval records the terms version the page displayed (a page from
    // before versioning is recorded as having shown only the estimate terms).
    // A page opened before the copy changed must reload rather than approve unseen terms.
    const termsVersion = approvalTermsVersion(body.terms_version);
    if (!termsVersion) return reply(409, { ok: false, code: 'CUSTOMER_PORTAL_TERMS_CHANGED', error: 'Our estimate terms were updated. Review the latest terms, then approve again.' });
    const approval = { status: 'approved', approvedAt: now, approvedBy: signedName, amount: quote, source: 'customer_portal', termsVersion };
    const deposit = customerDepositState(result.job, finance), actor = approvalActor(result.session.actorId);
    try {
      // deal.sold on the server clock at the bound total and revision, retiring
      // the job's live sale first; none when the live sale is at this total
      // (a re-signature). The job's funnelSale names the sale in the same commit.
      const sale = await portalApprovalWrites(result.job, result.session, { key: request.key, amountCents: body.amount_cents, estimateRevision: body.estimate_revision }, now);
      // A request whose deal.sold is the job's live sale never records a second
      // sale under the same key: an M3 staff approval replaced its signature
      // (without its requestId) and the total has changed since.
      const live = liveSale(result.job);
      if (live?.eventId && sale.writes.some(write => write.id === live.eventId)) return spent();
      await commitWithEvents(env, [{ id: result.session.jobId, updateTime: result.jobUpdateTime, patch: {
        // The request that saved this signature (a retry of it is a replay) and
        // the revision it binds; the sale's own key is funnelSale.key.
        customerApproval: { ...approval, ...actor, estimateRevision: body.estimate_revision, requestId: request.key },
        ...(sale.funnelSale ? { funnelSale: sale.funnelSale } : {}),
        estimate: { ...withoutApprovalActor(result.job.estimate), status: 'approved', acceptedAt: now, acceptedBy: signedName, amount: quote, depositRequired: deposit.required, acceptedTermsVersion: termsVersion, ...actor },
        deposit: { ...(result.job.deposit || {}), amount: deposit.required, paidAmount: deposit.paid, status: deposit.due < .01 ? 'paid' : deposit.paid ? 'partial' : 'due' },
        quoteStatus: 'approved',
        updatedAt: now,
      } }], sale.writes);
    } catch (error) {
      return conflict(error)
        ? reply(409, { ok: false, code: 'CUSTOMER_PORTAL_REVISION_CONFLICT', error: 'The estimate changed. Refresh before approving it.' })
        : reply(503, { ok: false, code: 'CUSTOMER_PORTAL_STORAGE_UNAVAILABLE', error: 'Your approval could not be saved. Please try again shortly.' });
    }
    const salesFollowupExit = await syncSalesFollowupExit(env, result.session.jobId, { now: clock });
    return reply(200, { ok: true, approval, salesFollowupExit });
  }

  if (body.action === 'create_payment') {
    // An unsent Hub quote draft is never charged, whatever the job's stage:
    // payable() refuses it on the job the checkout reads (409
    // CUSTOMER_PORTAL_ESTIMATE_NOT_APPROVABLE) and expires an open checkout.
    const secret = stripeKey(env);
    if (!secret) return reply(501, { ok: false, error: 'Online payments are not configured' });
    const requestId = safe(body.request_id, 120);
    if (!requestId) return reply(400, { ok: false, error: 'Payment request ID required' });
    let tipCents;
    try { tipCents = requestTip(body.tip_cents); } catch (error) { return reply(400, { ok: false, code: 'CUSTOMER_PORTAL_TIP_INVALID', error: error.message }); }
    if (tipCents && !customerTipsEnabled(env)) return reply(409, { ok: false, code: 'CUSTOMER_PORTAL_TIPS_DISABLED', error: 'Tips are not available online right now. Pay the balance without a tip.' });
    try {
      return reply(200, await createCustomerStripeCheckout(env, secret, result.session.jobId, new URL(request.url).origin, { tipCents, now }));
    } catch (error) { return reply(error.status || 502, { ok: false, ...(error.code === 'CUSTOMER_PORTAL_ESTIMATE_NOT_APPROVABLE' ? { code: error.code } : {}), error: error.message || 'Secure checkout could not be created', ...(/^tip_/.test(error.code || '') ? { code: 'CUSTOMER_PORTAL_TIP_INVALID' } : {}), ...(error.reviewRecorded ? { code: error.code, reviewRecorded: true } : {}) }); }
  }

  if (body.action === 'verify_payment') {
    const secret = stripeKey(env);
    if (!secret) return reply(501, { ok: false, error: 'Online payments are not configured' });
    const sessionId = safe(body.session_id, 180);
    if (!/^cs_(?:test_|live_)?[A-Za-z0-9_]+$/.test(sessionId)) return reply(400, { ok: false, error: 'Invalid Checkout session' });
    try {
      const checkout = await stripe(secret, `checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent.latest_charge`);
      return reply(200, { ok: true, ...await recordCustomerStripePayment(env, checkout, result.session.jobId, now) });
    // A charge held for review (for example, one Stripe shows refunded) answers 409 with its "do not pay again" message.
    // A confirmed charge waiting on an earlier payment's verification (payment_needs_review) names its code too, so the portal
    // shows that final message instead of asking again.
    } catch (error) { return reply(error.status || 502, { ok: false, error: error.message || 'Stripe payment could not be verified', ...(error.reviewRecorded ? { code: error.code, reviewRecorded: true } : error.code === 'payment_needs_review' ? { code: error.code } : {}) }); }
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
    const response = body.response === 'approved' ? 'approved' : body.response === 'declined' ? 'declined' : '';
    const input = { decisionId: id(body.decision_id, 'decision'), response, respondedBy: safe(body.responded_by, 120), note: safe(body.note, 600), requestId: typeof body.request_id === 'string' && UUID.test(body.request_id) ? body.request_id.toLowerCase() : '', priceDeltaCents: Number.isSafeInteger(body.price_delta_cents) ? body.price_delta_cents : null };
    if (!response || input.respondedBy.length < 2) return reply(400, { ok: false, error: 'Choose approve or decline and enter your name' });
    if (body.request_id !== undefined && !input.requestId) return reply(400, { ok: false, code: 'CUSTOMER_PORTAL_REQUEST_INVALID', error: 'A valid decision request ID is required' });
    const billing = changeOrderBillingEnabled(env);
    // FUN-03: the answer's funnel event is keyed by the page request, or by a
    // server-named key saved as responseEventKey (never as responseRequestId).
    const eventKey = input.requestId || crypto.randomUUID();
    let context = result;
    // Each retry re-reads the job through the portal access check (a revoked
    // link or decision right stops it), so an answer whose write landed without
    // a response is found as a replay: a change is added to the balance once.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt) {
        context = await requirePortal(request, env, { clock, read });
        if (context.error) { if (context.error.status >= 500) break; return context.error; }
        if (!owner && !context.session.permissions?.decide) return reply(403, { ok: false, error: 'You are not authorized to answer job decisions' });
      }
      const job = context.job, updateTime = context.jobUpdateTime;
      let plan;
      try { plan = respondToDecision(job, input, { billing, now, actorId: safe(context.session.actorId, 100), paidCents: customerMoneyTotals(job).appliedCents }); }
      catch (error) { return /^CUSTOMER_PORTAL_/.test(error.code || '') ? reply(error.status || 409, { ok: false, code: error.code, error: error.message }) : reply(503, { ok: false, code: 'CUSTOMER_PORTAL_STORAGE_UNAVAILABLE', error: 'Your answer could not be saved. Please try again shortly.' }); }
      const view = { ok: true, decision: decisionView(plan.decision, decisionContext(plan.patch ? { ...job, ...plan.patch } : job, { billing, now })), billed: plan.billedCents > 0, replayed: plan.replayed };
      if (!plan.patch) return reply(200, { ...view, approvedChangeTotal: amount(job.approvedChangeTotal) });
      // A billed change is written only against the revision it was planned on.
      if (billing && !updateTime) break;
      // change_order.approved/declined in this answer's commit (a replay above writes
      // none), at what the answer adds to the balance: the billed line with billing
      // on, otherwise the decision's price change.
      const current = job.customerDecisions.find(item => item && item.id === input.decisionId);
      const cents = Math.max(0, input.response === 'approved' && billing ? plan.billedCents : decisionDeltaCents(current) ?? Math.round(Math.max(0, amount(current?.priceDelta)) * 100));
      const patch = { ...plan.patch, customerDecisions: plan.patch.customerDecisions.map(item => item && item.id === input.decisionId ? { ...item, responseEventKey: eventKey } : item) };
      try {
        const event = await portalFunnelWrite(job, context.session, { type: `change_order.${input.response}`, key: eventKey, field: 'customerDecisions', subId: input.decisionId, data: { amountCents: cents } }, now);
        await commitWithEvents(env, [{ id: context.session.jobId, patch, updateTime }], [event]);
        return reply(200, { ...view, approvedChangeTotal: patch.approvedChangeTotal });
      } catch (error) {
        // An event the ledger refuses is a server fault: never retried, nothing saved.
        const refused = eventRefused(error); if (refused) return refused;
        /* the next attempt re-reads: another answer, a job edit, a storage error or a lost response */
      }
    }
    return reply(503, { ok: false, code: 'CUSTOMER_PORTAL_STORAGE_UNAVAILABLE', error: 'Your answer could not be confirmed. Please try again; it will only be recorded once.' });
  }

  if (body.action === 'request_rebook') {
    const kind = ['repeat', 'touch_up', 'garage_guard'].includes(body.kind) ? body.kind : 'repeat';
    const timing = ['asap', 'same_weekday', 'choose_date'].includes(body.timing) ? body.timing : 'asap';
    const preferredDate = timing === 'choose_date' ? isoDate(body.preferred_date) : '';
    const portalRequest = portalRequestId(body.request_id);
    if (!portalRequest) return reply(400, { ok: false, code: 'CUSTOMER_PORTAL_REQUEST_INVALID', error: 'This rebooking request is invalid. Refresh and send it again.' });
    const requests = Array.isArray(result.job.rebookingRequests) ? result.job.rebookingRequests : [];
    // A retry of a saved request_id (its response was lost) returns that
    // request only when it asks for the same visit; changed details under the
    // same id are refused, never silently dropped (the page then sends them as a new request).
    const replayed = portalRequest.id && requests.find(request => request.requestId === portalRequest.id);
    if (replayed) {
      const same = replayed.kind === kind && replayed.timing === timing && (replayed.preferredDate || '') === preferredDate && Boolean(replayed.preferredCrew) === Boolean(body.preferred_crew) && safe(replayed.notes, 600) === safe(body.notes, 600);
      return same ? reply(200, { ok: true, request: replayed, replayed: true }) : reply(409, { ok: false, code: 'CUSTOMER_PORTAL_IDEMPOTENCY_CONFLICT', error: 'This rebooking request was already sent with different details. Send the form again to make it a new request.' });
    }
    if (timing === 'choose_date' && (!preferredDate || preferredDate < today)) return reply(400, { ok: false, error: 'Choose a future preferred date' });
    const duplicate = requests.find(request => request.status === 'pending' && request.kind === kind && request.timing === timing && (request.preferredDate || '') === preferredDate && safe(request.notes, 600) === safe(body.notes, 600));
    if (duplicate) return reply(200, { ok: true, request: duplicate });
    if (requests.filter(request => request.status === 'pending').length >= 3) return reply(409, { ok: false, error: 'The team already has your rebooking request' });
    const request = { id: newId('rebook'), kind, timing, preferredDate, preferredCrew: Boolean(body.preferred_crew), notes: safe(body.notes, 600), status: 'pending', requestedAt: now, sourceJobId: result.session.jobId, ...(portalRequest.id ? { requestId: portalRequest.id } : {}) };
    try {
      // rebook.requested is recorded now: the saved list keeps only the last 10 requests.
      const event = await portalFunnelWrite(result.job, result.session, { type: 'rebook.requested', key: portalRequest.id || request.id, field: 'rebookingRequests', subId: request.id }, now);
      await commitWithEvents(env, [{ id: result.session.jobId, patch: { rebookingRequests: [...requests, request].slice(-10), rebookingStatus: 'pending', rebookingUpdatedAt: now, updatedAt: now }, updateTime: result.jobUpdateTime }], [event]);
    } catch (error) { return eventRefused(error) || reply(409, { ok: false, error: 'Your project changed. Refresh before requesting another visit.' }); }
    return reply(200, { ok: true, request });
  }

  if (body.action === 'apply_gift_credit') {
    if (unsentQuoteDraft(result.job)) return reply(409, { ok: false, code: 'CUSTOMER_PORTAL_ESTIMATE_NOT_APPROVABLE', error: 'Your estimate is being updated. Credits can be applied once you review and approve it.' });
    if (customerPaymentNeedsReview(result.job)) return reply(409, { ok: false, error: 'A recorded payment needs team verification before applying another payment or credit' });
    // finance is what payment.amount is written from; served is the balance the credit is capped at and answered with
    // (money-core's unified totals in mode 'unified', which never apply credit against money it cannot read).
    const mode = moneyTotalsMode(env), finance = moneyState(result.job), served = mode === 'unified' ? moneyState(result.job, mode) : finance;
    if (mode === 'shadow') customerTotalsShadow(result.job, 'gift_credit');
    if (served.unknown) return reply(409, { ok: false, ...unknownMoneyRefusal(served) });
    if (served.balance < .01) return reply(409, { ok: false, error: 'This job is already paid in full' });
    const requestId = id(body.request_id, 'redeem');
    const wallet = result.job.giftWallet || {};
    const cards = Array.isArray(wallet.cards) ? wallet.cards : [];
    const redemptions = Array.isArray(wallet.redemptions) ? wallet.redemptions : [];
    const known = redemptions.find(item => item.requestId === requestId);
    if (known) return reply(200, { ok: true, applied: amount(known.amount), balance: served.balance });
    const cardId = id(body.card_id, 'credit');
    const card = cards.find(item => item.id === cardId);
    if (!card || amount(card.remainingAmount) < .01) return reply(409, { ok: false, error: 'That credit is no longer available' });
    const requested = Math.max(.01, amount(body.amount));
    const applied = Math.min(requested, amount(card.remainingAmount), served.balance);
    const updatedCards = cards.map(item => item.id === cardId ? { ...item, remainingAmount: Math.max(0, amount(item.remainingAmount) - applied), updatedAt: now } : item);
    // Unified: payment.amount keeps every recorded dollar (an older tip inside it included) plus the credit, which is
    // already capped at the unified balance; capping it at today's total would drop the credit above today's balance.
    const paidTotal = served === finance ? Math.min(finance.total, finance.paid + applied) : (Math.round(finance.paid * 100) + Math.round(applied * 100)) / 100;
    let balance = Math.max(0, finance.total - paidTotal), shown = { total: finance.total, paid: paidTotal };
    if (served !== finance) {
      const totalCents = Math.round(served.total * 100), paidCents = Math.min(totalCents, Math.round(served.paid * 100) + Math.round(applied * 100));
      shown = { total: served.total, paid: paidCents / 100 }; balance = (totalCents - paidCents) / 100;
    }
    const redemption = { id: newId('redemption'), requestId, cardId, amount: applied, appliedAt: now, jobId: result.session.jobId };
    const creditClass = vocabularyValue('creditClasses', card.creditClass) || vocabularyValue('creditClasses', card.source);
    const walletPatch = { giftWallet: { ...wallet, cards: updatedCards, redemptions: [...redemptions, redemption].slice(-40), updatedAt: now }, updatedAt: now };
    // MONEY_INVOICE_STATE_ENABLED: a credit updates only an invoice that takes payments (money-core invoiceTakesPayment:
    // issued, or numbered and live, as before the flag) and never writes one on a job no one invoiced.
    const touchInvoice = !moneyInvoiceStateEnabled(env) || invoiceTakesPayment(result.job.invoice);
    const jobPatch = {
      payment: { ...(result.job.payment || {}), amount: paidTotal, giftCreditApplied: amount(result.job.payment?.giftCreditApplied) + applied, lastAmount: applied, lastReceivedAt: now, method: finance.paid > 0 ? 'mixed_with_gift_credit' : 'gift_credit', verified: true },
      ...(touchInvoice ? { invoice: { ...(result.job.invoice || {}), amount: shown.total, paid: shown.paid, balance, status: balance < .01 ? 'paid' : 'partial', updatedAt: now } } : {}), updatedAt: now,
    };
    try {
      // credit.redeemed for the credit applied to this job; the wallet may live on the account's root job.
      const event = await portalFunnelWrite(result.job, result.session, { type: 'credit.redeemed', key: requestId, field: 'giftWallet.redemptions', subId: redemption.id, sourceJobId: result.accountJobId, data: { amountCents: Math.round(applied * 100), creditClass } }, now);
      await commitWithEvents(env, result.accountJobId === result.session.jobId
        ? [{ id: result.session.jobId, patch: { ...walletPatch, ...jobPatch }, updateTime: result.jobUpdateTime }]
        : [{ id: result.accountJobId, patch: walletPatch, updateTime: result.accountUpdateTime }, { id: result.session.jobId, patch: jobPatch, updateTime: result.jobUpdateTime }], [event]);
    } catch (error) { return eventRefused(error) || reply(409, { ok: false, error: 'That credit changed while it was being applied. Refresh and try again.' }); }
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
      if (!reviewReady(job, moneyTotalsMode(env))) return reply(409, { ok: false, code: 'CUSTOMER_PORTAL_REVIEW_NOT_READY', error: 'Reviews open after your project is complete and paid.' });
      // One visit per viewer per minute: repeat taps or a looping client cannot
      // inflate the staff count or keep bumping the job's revision.
      if (clicks.some(item => item?.viewer === viewer && String(item.actorId || '') === actorId && Math.abs(started.getTime() - Date.parse(item.clickedAt)) < REVIEW_CLICK_WINDOW_MS)) return reply(200, { ok: true, recorded: false, duplicate: false });
      const click = { requestId, clickedAt: now, viewer, ...(owner ? {} : { actorId }) };
      try {
        const event = await portalFunnelWrite(job, result.session, { type: 'review.clicked', key: requestId, field: 'reviewClicks', subId: requestId }, now);
        await commitWithEvents(env, [{ id: result.session.jobId, updateTime, patch: {
          reviewClicks: [...clicks, click].slice(-20), reviewClickCount: Math.max(0, Number(job.reviewClickCount) || 0) + 1,
          reviewClickedAt: safe(job.reviewClickedAt, 50) || now, reviewLastClickedAt: now,
        } }], [event]);
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

export function createCustomerPortalHandlers({ now = () => new Date(), read = readJob, crewProfiles = readCrewPublicProfiles } = {}) {
  const deps = { clock: now, read, crewProfiles };
  return { onRequestGet: context => handleGet(context, deps), onRequestPost: context => handlePost(context, deps), onRequestDelete };
}

const handlers = createCustomerPortalHandlers();
export const onRequestGet = handlers.onRequestGet;
export const onRequestPost = handlers.onRequestPost;
