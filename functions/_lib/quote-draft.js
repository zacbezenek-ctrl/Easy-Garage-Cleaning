import { mutateDispatch } from './dispatch-service.js';
import { saveJobReads } from './dispatch-window-reads.js';
import { requireQuoteAuthor } from './quote-permissions.js';
import { identityMatches } from './walkthrough-handoff.js';
import { authorCustomer, authorOpensJob, jobCustomerAccess, refPatch, shownCustomerId } from './estimator-customer-access.js';
import { auditWrite } from './hub-audit.js';
import { addDays, denverToday, validDate } from './dispatch-time.js';
import { depositCents, estimateFingerprint, estimateChanged, estimateTotals, included, junkOnlyGarageWork, normalizeLineItems, packageTotals, validateSelection } from './quote-model.js';
import { customerMoneyTotals, invoiceNumber } from './money-core.js';
import { moneySnapshot } from './money-service.js';
import { moneySupersedeWrite } from './job-funnel-events.js';
import { funnelPaymentEventsEnabled, moneyEventWrites } from './payment-events.js';
import { checkoutFingerprint } from './customer-payments.js';
import { consumeConfirmation, issueConfirmation } from './confirm-token.js';
import { messagingFlags } from './approved-send.js';
import { maskRecipient, normalizeEmail, normalizePhone } from './ghl-messenger.js';
import { catalogQuotesEnabled, catalogStorage, quoteBuilderEnabled, readCatalogState, readCompositeState } from './catalog-store.js';
import { priceCatalogQuote } from './catalog-quote.js';
import { approvalRefusal, compositeApproval, priceCompositeQuote } from './composite-quote.js';
import { normalizeUnsignedCapture, unsignedCapturePatch } from './unsigned-walkthrough-capture.js';
import { quotePaymentSchedule, requireQuotePaymentTiming, quotePaymentDates, quotePaymentSummary, businessPaymentDate, sentQuotePaymentPolicy, snapshotQuotePaymentPolicy, PAYMENT_TIME_ZONE } from './quote-payment-policy.js';
import { prepareWalkthroughCaptureSync, walkthroughCaptureSyncView } from './walkthrough-capture-sync.js';

/**
 * P2-07 unsigned quote drafts and an explicit human send.
 *   saveQuoteDraft(store, actor, input, now, {env, checkouts})
 *     Without jobId: an unscheduled job through mutateDispatch schedule.create
 *     (with sourceWalkthroughId when the quote came from a Hub walkthrough).
 *     With jobId + expectedRevision: a revision of that draft's quote only.
 *     Either way estimate.status is 'draft' until a person sends it, and
 *     nothing reaches the customer: no provider sync, portal invitation or
 *     message. The source walkthrough keeps its status, completion and money.
 *   previewQuoteSend / sendQuoteDraft: a confirm token (SEC-03) bound to the
 *     exact estimate revision, fingerprint and delivery mode, consumed in the
 *     same commit that records estimate.sentAt / status 'sent'. Only then is the
 *     injected deliverer (the HighLevel estimate-ready automation, gated by the
 *     approved-send messaging flags) asked to notify the customer.
 * Every mutation carries a UUID requestId with a quoteDraftOperations receipt
 * (sha256 of {actor, input}) and a hub_audit entry in the same commit.
 * Lines are the canonical quote model: optional add-ons and single-select
 * good/better/best groups are kept, and the author's default choice sets the
 * total the customer sees. A material revision bumps estimate.revision, returns
 * the quote to draft, supersedes any approval and issued invoice (payments are
 * kept) and asks `checkouts` to expire an open portal checkout for the old terms.
 * With EGC_QUOTE_BUILDER_ENABLED a draft may instead carry composite_pricing (the guided builder: removal, then
 * shelving, then extra storage, then, for a quote with garage work, the Labor line of man-hours x the owner's labor
 * rate; a junk-only quote has none: $750 per truck; composite-quote.js): the server re-prices it, labor included, from
 * the selection and its own rate, saves its lines (the Labor line reads "Labor" and its amount for the customer) and
 * the cost-free section breakdown (quoteDraft.breakdown), and refuses a send preview or send while any of its prices is
 * a draft the owner has not approved, its labor rate is no longer the owner's, it has garage work and no Labor line, its
 * Labor line was priced before the owner's Labor decisions of 2026-10-18 (or a junk-only quote still has one), or its
 * man-hours were pre-filled from an estimate with no install time for some of its goods
 * (quote_draft_composite_prices_unapproved, with every reason in details.unapproved).
 * While that flag is on, a walkthrough quote priced outside the builder (no composite or catalog pricing) is saved
 * as before but its send preview and send are refused (quote_draft_builder_required, 409).
 * With FUNNEL_PAYMENT_EVENTS_ENABLED (and MONEY_API_ENABLED) a material revision
 * also carries the FUN-33 paid-in-full crossing it causes in its own commit
 * (payment-events.js moneyEventWrites): job.balance_reopened (estimate_revised)
 * when it raises a paid-in-full total, job.paid_in_full when it lowers an open
 * balance to 0, or only the moved paidInFullRevision when the job stays paid.
 */
export const QUOTE_DRAFT_RECEIPTS = 'quoteDraftOperations';
export const CHECKOUT_LEDGER = 'customer_payment_checkouts';
export const MAX_DRAFT_LINES = 40;
// The customer portal lists at most 12 charged lines (money-service MAX_ESTIMATE_LINES).
export const MAX_INCLUDED_LINES = 12;
const SEND_ACTION = 'quote.send';
const DRAFT_KEYS = ['client', 'title', 'scope', 'line_items', 'valid_until', 'catalog_version', 'crew_size', 'estimated_duration_min', 'walkthrough_capture'];
const SAVE_KEYS = ['actorId', 'requestId', 'customerId', 'sourceWalkthroughId', 'sourceRevision', 'jobId', 'expectedRevision', 'draft'];
const PREVIEW_KEYS = ['actorId', 'jobId', 'expectedRevision'];
const SEND_KEYS = ['actorId', 'requestId', 'jobId', 'expectedRevision', 'confirmToken'];
const catalogStateDefault = env => readCatalogState(catalogStorage(env));
const compositeStateDefault = env => readCompositeState(catalogStorage(env));
// Delivery outcomes that never claimed a send, or a definite provider refusal, may be retried by the same send request.
const RETRYABLE_DELIVERY = new Set(['pending', 'failed', 'unavailable', 'needs_contact', 'contact_mismatch', 'not_configured']);
const FINAL = new Set(['quote_draft_idempotency_conflict', 'quote_draft_changed_since_save', 'quote_draft_changed_since_send', 'quote_draft_actor_changed']);
const CLOSED = new Set(['cancelled', 'canceled', 'completed', 'invoiced', 'paid', 'review_requested', 'closed', 'noshow', 'no_show', 'no-show']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(secure_|_egc_)/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const fail = (code, message, status = 409, details) => Object.assign(new Error(message), { code: `quote_draft_${code}`, status, ...(details ? { details } : {}) });
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value ?? null);
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const stage = job => String(job?.pipelineStatus || job?.status || '').toLowerCase();
const operational = job => Boolean(job) && !job.recordType && ['job', 'cleanout', 'reorg'].includes(job.type);
const approved = value => ['accepted', 'approved'].includes(String(value || '').toLowerCase());
const usd = cents => Number.isSafeInteger(cents) ? (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : 'an unknown amount';
const pick = (value, keys) => plain(value) ? Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]])) : null;
const started = job => Boolean(job.fieldLastActionAt) || plain(job.fieldExecution) && (Object.keys(job.fieldExecution).some(key => key !== 'photos') || (job.fieldExecution.photos || []).some(photo => photo?.category !== 'walkthrough'));

function text(value, label, max, required = false) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max || required && !value.trim()) throw fail('invalid_draft', `${label} is missing or too long.`, 400);
  return value.trim();
}
function keys(value, allowed, message) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail('invalid_request', message, 400);
}
function requireRevision(row) {
  if (!safeId(row?.id) || typeof row.revision !== 'string' || !row.revision) throw fail('source_unavailable', 'A required customer or job record has no verifiable revision. Keep the draft and retry.', 503);
}
function actorMatches(input, actor) {
  if (input.actorId !== undefined && String(input.actorId).trim().toLowerCase() !== String(actor.user).trim().toLowerCase()) throw fail('actor_changed', 'The signed-in employee changed. Sign in as the original employee to finish this request, or discard it.', 403);
}

/** Validates the author's quote: canonical lines with a complete default choice. */
export function normalizeQuoteDraft(value, now = new Date().toISOString()) {
  keys(value, DRAFT_KEYS, 'The quote draft contains unsupported fields. Refresh and try again.');
  if (!plain(value.client)) throw fail('invalid_draft', 'The customer details are required.', 400);
  const client = { name: text(value.client.name, 'Customer name', 200, true), phone: text(value.client.phone, 'Phone', 40), email: text(value.client.email, 'Email', 254), address: text(value.client.address, 'Service address', 500, true), highlevel_contact_id: text(value.client.highlevel_contact_id, 'Contact link', 180) };
  if (!normalizePhone(client.phone) && !normalizeEmail(client.email) && !client.highlevel_contact_id) throw fail('customer_required', 'A customer phone, email or CRM contact is required.', 400);
  if (!Array.isArray(value.line_items) || !value.line_items.length) throw fail('invalid_line_items', 'Add at least one priced line item.', 400);
  if (value.line_items.length > MAX_DRAFT_LINES) throw fail('invalid_line_items', `A quote can hold up to ${MAX_DRAFT_LINES} lines, options included.`, 400);
  let lineItems;
  try { ({ lineItems } = normalizeLineItems(value.line_items, { strict: true })); }
  catch (error) { if (/^quote_/.test(error?.code || '')) throw fail('invalid_line_items', `The quote is invalid: ${error.message}`, 400, { code: error.code }); throw error; }
  if (lineItems.some(line => line.kind === 'tip')) throw fail('invalid_line_items', 'A quote cannot include a tip line.', 400);
  const selection = validateSelection(lineItems);
  if (!selection.ok) throw fail('invalid_selection', `Choose the option the customer sees first: ${selection.issues[0].message}`, 400, { issues: selection.issues });
  const totals = estimateTotals(lineItems);
  if (!totals.complete || !Number.isSafeInteger(totals.totalCents) || totals.totalCents <= 0) throw fail('invalid_amount', 'The chosen lines must add up to more than $0.00.', 400);
  if (lineItems.filter(included).length > MAX_INCLUDED_LINES) throw fail('invalid_line_items', `At most ${MAX_INCLUDED_LINES} lines can be charged in one quote so the customer portal shows every charge.`, 400);
  const today = denverToday(new Date(now)), validUntil = value.valid_until;
  if (!validDate(validUntil) || validUntil < today || validUntil > addDays(today, 90)) throw fail('invalid_valid_until', 'Choose a quote expiry date from today to 90 days out.', 400);
  const version = value.catalog_version ?? '';
  if (version !== '' && !(Number.isSafeInteger(version) && version >= 1) && !(typeof version === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(version))) throw fail('invalid_draft', 'The catalog version is invalid.', 400);
  const crew = value.crew_size ?? null, minutes = value.estimated_duration_min ?? null;
  if (crew !== null && (!Number.isInteger(crew) || crew < 1 || crew > 20)) throw fail('invalid_draft', 'Choose a crew size from 1 to 20.', 400);
  if (minutes !== null && (!Number.isInteger(minutes) || minutes < 15 || minutes > 1440)) throw fail('invalid_draft', 'The estimated job duration is invalid.', 400);
  return { client, title: text(value.title, 'Quote title', 200) || 'EGC Garage Service', scope: text(value.scope, 'The customer-facing scope', 1600, true), lineItems, totalCents: totals.totalCents, depositCents: depositCents(totals.totalCents, 50), validUntil, catalogVersion: version === '' ? null : version, crewSize: crew, estimatedDurationMin: minutes, walkthroughCapture: normalizeUnsignedCapture(value.walkthrough_capture) };
}

// The job's deposit for a required deposit in cents: recorded payments are kept, only its amount and status follow.
function depositDue(deposits, requiredCents) {
  const paid = typeof deposits.paidAmount === 'number' && Number.isFinite(deposits.paidAmount) ? Math.max(0, deposits.paidAmount) : 0, required = requiredCents / 100;
  return { ...deposits, amount: required, status: paid >= required ? 'paid' : paid > 0 ? 'partial' : 'required' };
}

// The quote fields of a draft save. A material change (lines, choice, total,
// deposit or scope) bumps the revision and returns the quote to draft, retiring
// an approval and an issued invoice; recorded payments are never touched.
function quotePatch(job, inputDraft, actor, now, jobId, newQuotePaymentPolicy) {
  const current = plain(job?.estimate) ? job.estimate : {}, deposits = plain(job?.deposit) ? job.deposit : {}, approval = plain(job?.customerApproval) ? job.customerApproval : null;
  // A new server policy applies only when creating a new quote job. Existing
  // quotes keep their snapshot (or legacy behavior), never today's new policy.
  const policy = job ? current.commercialPolicy : newQuotePaymentPolicy;
  const schedule = policy === undefined ? null : quotePaymentSchedule(inputDraft.totalCents, policy);
  const draft = schedule ? { ...inputDraft, depositCents: schedule.depositCents, depositPct: schedule.policy.depositPct } : inputDraft;
  const next = { ...current, number: invoiceNumber(jobId, 'estimate', current.number), amount: draft.totalCents / 100, amountCents: draft.totalCents, depositRequired: draft.depositCents / 100, depositRequiredCents: draft.depositCents, scope: draft.scope, lineItems: structuredClone(draft.lineItems), validUntil: draft.validUntil, termsVersion: current.termsVersion || job?.termsVersion || '2026-09', catalogVersion: draft.catalogVersion,
    ...(draft.catalogPricing ? { pricingSettingsVersion: draft.pricingSettingsVersion, depositPct: draft.depositPct } : draft.compositePricing ? { pricingSettingsVersion: draft.pricingSettingsVersion } : current.pricingSettingsVersion ? { pricingSettingsVersion: null, depositPct: null } : {}),
    source: 'quote_draft', createdAt: current.createdAt || now, updatedAt: now, updatedBy: actor.user };
  if (schedule) Object.assign(next, { commercialPolicy: schedule.policy, depositPct: schedule.policy.depositPct, termsVersion: current.termsVersion || schedule.policy.version });
  // Catalog provenance is part of the terms a customer reviewed. A new
  // approved settings/catalog version can leave every visible cent unchanged,
  // but must still retire the earlier send and approval. The same applies when
  // an author switches between catalog and legacy quote sources.
  const priorCatalog = plain(job?.quoteDraft?.catalogPricing) ? job.quoteDraft.catalogPricing : null;
  const nextCatalog = draft.catalogPricing || null;
  // A builder quote's selection and menu/settings versions are provenance in the same way. Of its labor only the
  // man-hours are terms the customer reviewed (the rate is in the lines): the estimate's inputs (the garage fullness)
  // and whether the estimator adjusted them are internal, so a re-save that changes only those is not material. So is the
  // walkthrough's garage size (garageSize), which only checks the deep clean and the pressure wash the lines already name.
  const termsOf = pricing => { if (!plain(pricing)) return pricing; const { garageSize, ...terms } = pricing; return plain(terms.labor) ? { ...terms, labor: { manHours: terms.labor.manHours } } : terms; };
  const priorComposite = termsOf(plain(job?.quoteDraft?.compositePricing) ? job.quoteDraft.compositePricing : null), nextComposite = termsOf(draft.compositePricing || null);
  const provenanceChanged = canonical(priorComposite) !== canonical(nextComposite) || canonical(priorCatalog) !== canonical(nextCatalog) || Boolean(priorCatalog || nextCatalog) && (
    current.catalogVersion !== draft.catalogVersion || (current.pricingSettingsVersion ?? null) !== (draft.pricingSettingsVersion ?? null) ||
    (current.depositPct ?? null) !== (draft.depositPct ?? null));
  const fresh = !current.number, material = fresh || estimateChanged(current, next) || provenanceChanged, wasApproved = approved(current.status) || approved(approval?.status), wasSent = current.status === 'sent' || Boolean(current.sentAt);
  next.revision = (Number.isSafeInteger(current.revision) && current.revision > 0 ? current.revision : 0) + (material ? 1 : 0);
  next.status = material ? 'draft' : current.status || 'draft';
  const patch = { estimate: next, total: draft.totalCents / 100, priceQuoted: draft.totalCents / 100, quoteStatus: material ? 'draft' : job?.quoteStatus || 'draft', deposit: depositDue(deposits, draft.depositCents) };
  const warnings = [];
  if (material && (wasApproved || approval?.status && approval.status !== 'superseded')) {
    patch.customerApproval = { ...(approval || {}), status: 'superseded', supersededAt: now, supersededBy: actor.user, reason: 'estimate_revised' };
    Object.assign(next, { acceptedAt: null, acceptedBy: null, acceptanceMethod: null });
    warnings.push({ code: 'approval_superseded', message: 'The customer decision no longer matches this quote. Send the revision for a fresh approval.' });
  }
  const invoice = plain(job?.invoice) ? job.invoice : null;
  if (material && invoice && invoice.amount !== undefined && invoice.amount !== null && !['void', 'superseded'].includes(invoice.status)) {
    patch.invoice = { ...invoice, status: 'superseded', supersededAt: now, supersededReason: 'estimate_revised' };
    warnings.push({ code: 'invoice_superseded', message: 'The issued invoice was superseded. Issue a new invoice after the revision is approved.' });
  }
  // As in the Hub estimate editor (money-service saveEstimate): payments are never touched, only flagged.
  const before = job ? customerMoneyTotals(job) : null;
  if (before?.appliedCents != null && before.appliedCents > draft.totalCents + (before.approvedChangeCents || 0)) warnings.push({ code: 'payments_exceed_total', message: 'Recorded payments are more than the revised total. The payments were kept; review them.' });
  if (draft.estimatedDurationMin !== null) patch.estimatedDurationMin = draft.estimatedDurationMin;
  return { patch, warnings, material, revisedRelease: material && !fresh && (wasSent || wasApproved) };
}

// The service a quote draft is for, as every customer surface names it (the portal, the money documents, Stripe): a
// junk-only builder quote is 'Junk removal' (D-JUNK: its scope is junk removal only), any other 'Garage transformation'.
// A revision relabels only a job this file labelled; a service Dispatch or another booking path set is kept.
const QUOTE_SERVICE_TYPES = ['Garage transformation', 'Junk removal'];
const quoteServiceType = junkOnly => junkOnly ? 'Junk removal' : 'Garage transformation';
const serviceTypeRevision = (job, junkOnly) => QUOTE_SERVICE_TYPES.includes(job.serviceType) ? { serviceType: quoteServiceType(junkOnly) } : {};
function capturePatch(job, draft, actor, now) {
  const patch = unsignedCapturePatch(job, draft.walkthroughCapture, actor, now);
  if (Object.keys(patch).length) patch.walkthroughCaptureSync = prepareWalkthroughCaptureSync({ ...job, ...patch }, now);
  return patch;
}

/** Quote author DTO: the quote, its options and send state; never signatures, payment evidence, notes or provider IDs.
 * seen (estimator-customer-access.js jobCustomerAccess): an estimator who may not see the job's customer gets their own
 * customer reference, or no customer id. */
export function quoteDraftView(job, seen = null) {
  const estimate = plain(job?.estimate) ? job.estimate : {}, lines = Array.isArray(estimate.lineItems) ? normalizeLineItems(estimate.lineItems).lineItems : [];
  return {
    id: job.id, revision: job.revision, customerId: seen ? shownCustomerId(job.customerId, seen) : job.customerId || '', customer: seen && !seen.full ? String(seen.name || '').slice(0, 200) : String(job.customer || '').slice(0, 200), projectId: job.projectId || '', sourceWalkthroughId: job.sourceWalkthroughId || '', status: stage(job), quoteStatus: job.quoteStatus || '',
    estimate: { number: estimate.number || '', revision: Number.isSafeInteger(estimate.revision) ? estimate.revision : null, status: estimate.status || 'draft', amountCents: Number.isSafeInteger(estimate.amountCents) ? estimate.amountCents : null, depositRequiredCents: Number.isSafeInteger(estimate.depositRequiredCents) ? estimate.depositRequiredCents : null, validUntil: validDate(estimate.validUntil) ? estimate.validUntil : null, scope: String(estimate.scope || '').slice(0, 1600), sentAt: estimate.sentAt || null, sentRevision: Number.isSafeInteger(estimate.sentRevision) ? estimate.sentRevision : null, fingerprint: estimateFingerprint(estimate),
      ...(estimate.pricingSettingsVersion ? { catalogVersion: estimate.catalogVersion, pricingSettingsVersion: estimate.pricingSettingsVersion, depositPct: estimate.depositPct } : {}),
      ...(estimate.commercialPolicy !== undefined ? { commercialPolicy: estimate.commercialPolicy, depositPct: estimate.depositPct } : {}),
      ...(estimate.paymentSchedule ? { paymentSchedule: estimate.paymentSchedule } : {}),
      lineItems: lines.map(line => ({ id: line.id, kind: line.kind, name: line.name, description: line.description, quantity: line.quantity, unitCents: line.unitCents, totalCents: line.totalCents, customerSupplied: line.customerSupplied === true, optional: line.optional, selected: line.selected, included: included(line), group: line.group ? { id: line.group.id, label: line.group.label, selection: line.group.selection, required: line.group.required } : null, tier: line.tier })),
      options: packageTotals(lines).map(group => ({ groupId: group.groupId, label: group.label, selection: group.selection, required: group.required, tiers: group.tiers, selectedTier: group.selectedTier })) },
    ...(plain(job.quoteDraft?.catalogPricing) ? { catalogPricing: job.quoteDraft.catalogPricing } : {}),
    // The builder selection and its cost-free breakdown (sections, itemized lines, purchase list).
    ...(plain(job.quoteDraft?.compositePricing) ? { compositePricing: job.quoteDraft.compositePricing, breakdown: plain(job.quoteDraft.breakdown) ? job.quoteDraft.breakdown : null } : {}),
    approval: pick(job.customerApproval, ['status', 'approvedAt', 'supersededAt']),
    ...(walkthroughCaptureSyncView(job) ? { captureSync: walkthroughCaptureSyncView(job) } : {}),
    delivery: pick(job.estimateReady, ['requestId', 'revision', 'mode', 'status', 'reason', 'attempts', 'recipient', 'tagReset', 'at']),
  };
}

function outcome(job, action, requestId, replayed, warnings, extra = {}, seen = null) {
  return { ok: true, authority: 'employee_hub', action, requestId, replayed, job: quoteDraftView(job, seen), warnings, ...extra };
}

// author ({actor, access, env}): an estimator opens only a draft they started or one whose customer they may see
// (estimator-customer-access.js authorOpensJob); owners, managers and dispatchers open any.
async function readJobFor(store, jobId, author = null) {
  const job = await store.read('jobs', jobId);
  if (!operational(job)) throw fail('job_not_found', 'This quote job could not be found.', 404);
  requireRevision(job);
  if (!plain(job.quoteDraft)) throw fail('not_a_draft', 'This job\'s quote was not drafted here. Revise it in Estimates & payments.');
  if (author && !await authorOpensJob(store, author.actor, author.access, job, author.env)) throw fail('job_forbidden', 'This quote belongs to another estimator. Ask the office to open it.', 403);
  return job;
}
const seenBy = (store, actor, access, env) => job => jobCustomerAccess(store, actor, access, job, { env });

function editable(job) {
  if (CLOSED.has(stage(job))) throw fail('job_closed', 'A closed or cancelled job cannot take a quote revision.');
  if (started(job)) throw fail('work_started', 'This job has already entered the field workflow. Use the explicit scope and finance revision tools instead.');
}

/**
 * Open (unsettled) portal checkouts are opened for one quote fingerprint; a
 * revised quote expires them in Stripe so the customer cannot pay the old terms.
 * Failures are reported, never retried blindly: the portal checkout also
 * refuses and expires a session whose fingerprint no longer matches. `mode` is
 * the money totals mode (MONEY_UNIFIED_TOTALS) the checkout was fingerprinted in.
 */
export async function expireStaleCheckout({ store, job, stripe, now = new Date().toISOString(), mode = 'off' }) {
  let ledger;
  try { ledger = await store.read(CHECKOUT_LEDGER, job.id); } catch { return { status: 'needs_review', reason: 'checkout_unreadable' }; }
  if (!ledger || !ledger.sessionId || ledger.status !== 'open') return { status: 'none' };
  if (ledger.fingerprint === checkoutFingerprint(job, Number(ledger.tipCents || 0), mode)) return { status: 'current' };
  if (typeof stripe !== 'function') return { status: 'needs_review', reason: 'stripe_not_configured' };
  let expired;
  try { expired = await stripe(`checkout/sessions/${encodeURIComponent(ledger.sessionId)}/expire`, { method: 'POST' }); } catch { return { status: 'needs_review', reason: 'stripe_unconfirmed' }; }
  if (expired?.status !== 'expired') return { status: 'needs_review', reason: 'checkout_not_expired' };
  try { await store.commit([{ collection: CHECKOUT_LEDGER, id: job.id, revision: ledger.revision, patch: { status: 'expired', expiredAt: now, expiredReason: 'quote_revised' } }]); }
  catch { /* Stripe already closed it; the next checkout reads that and records it. */ }
  return { status: 'expired' };
}

export async function readQuoteDraft(store, actor, query = {}, { env = {} } = {}) {
  const access = requireQuoteAuthor(actor, env);
  keys(query, ['jobId'], 'The quote lookup is invalid.');
  if (!safeId(query.jobId)) throw fail('invalid_request', 'Choose a valid quote job.', 400);
  const job = await readJobFor(store, query.jobId, { actor, access, env });
  return { ok: true, authority: 'employee_hub', job: quoteDraftView(job, await seenBy(store, actor, access, env)(job)) };
}

export async function saveQuoteDraft(store, actor, input, now = new Date().toISOString(), { env = {}, checkouts = null, catalogState = catalogStateDefault, compositeState = compositeStateDefault, newQuotePaymentPolicy } = {}) {
  const access = requireQuoteAuthor(actor, env), seen = seenBy(store, actor, access, env);
  keys(input, SAVE_KEYS, 'The quote draft needs a stable request and customer identity.');
  if (!uuid(input.requestId) || !safeId(input.customerId) || input.jobId && !safeId(input.jobId) || input.sourceWalkthroughId && !safeId(input.sourceWalkthroughId)) throw fail('invalid_request', 'The quote draft needs a stable request and customer identity.', 400);
  if (input.jobId && (typeof input.expectedRevision !== 'string' || !input.expectedRevision)) throw fail('invalid_request', 'Reload the quote before revising it.', 400);
  actorMatches(input, actor);
  const fingerprint = await hash({ actor: actor.user, input }), receiptId = input.requestId.toLowerCase();
  async function replay(replayed) {
    const receipt = await store.read(QUOTE_DRAFT_RECEIPTS, receiptId);
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint || receipt.actorId !== actor.user || receipt.action !== 'save') throw fail('idempotency_conflict', 'This save identity belongs to different quote content. Recover the original request before changing it.');
    const saved = await store.read('jobs', receipt.jobId);
    if (!saved || saved.customerId !== receipt.customerId || saved.quoteDraft?.requestId !== input.requestId) throw fail('changed_since_save', 'The earlier save succeeded, but this quote has changed since. Reload it before revising.');
    const checkout = receipt.revisedRelease && typeof checkouts === 'function' ? await checkouts(saved).catch(() => ({ status: 'needs_review', reason: 'checkout_unconfirmed' })) : null;
    const warnings = [...(receipt.warnings || []), ...(checkout && !['none', 'current', 'expired'].includes(checkout.status) ? [{ code: 'checkout_needs_review', message: 'An open card checkout for the earlier quote could not be closed. Review it in Stripe before the customer pays.' }] : [])];
    return outcome(saved, 'save', input.requestId, replayed, warnings, checkout ? { checkout } : {}, await seen(saved));
  }
  // A committed save replays before validation, so a retry after the Denver date
  // (and the quote's expiry window) moved on still returns the saved quote.
  const prior = await replay(true);
  if (prior) return prior;
  const catalogMode = input.draft?.catalog_pricing !== undefined;
  // With the builder flag off a composite_pricing field stays an unsupported draft field, as before.
  const compositeMode = quoteBuilderEnabled(env) && plain(input.draft) && input.draft.composite_pricing !== undefined;
  let draft, junkOnlyQuote = false;
  if (compositeMode) {
    if (catalogMode) throw fail('invalid_draft', 'A quote is priced by the builder or by the catalog, not both.', 400);
    const priced = priceCompositeQuote(await compositeState(env), input.draft.composite_pricing, { complete: true });
    if (input.draft.catalog_version !== priced.menuVersion || canonical(input.draft.line_items) !== canonical(priced.lineItems)) {
      throw fail('composite_price_changed', 'The quote lines do not match the current builder prices. Review the quote in the builder again before saving.', 409);
    }
    const material = { ...input.draft, line_items: priced.storedLineItems };
    delete material.composite_pricing;
    draft = normalizeQuoteDraft(material, now);
    if (draft.totalCents !== priced.totalCents) throw fail('composite_price_changed', 'The builder quote total changed. Review the quote in the builder again before saving.', 409);
    junkOnlyQuote = priced.junkOnly === true;
    Object.assign(draft, { pricingSettingsVersion: priced.settingsVersion, compositePricing: structuredClone(priced.compositePricing), breakdown: structuredClone(priced.breakdown) });
  } else if (catalogMode) {
    if (!catalogQuotesEnabled(env)) throw fail('catalog_disabled', 'Catalog quotes are turned off. Keep this draft for review.', 404);
    const priced = priceCatalogQuote(await catalogState(env), input.draft.catalog_pricing, now);
    if (input.draft.catalog_version !== priced.catalogVersion || canonical(input.draft.line_items) !== canonical(priced.lineItems)) {
      throw fail('catalog_price_changed', 'The catalog quote lines do not match the current server preview. Preview the products again.', 409);
    }
    const material = { ...input.draft, line_items: priced.storedLineItems };
    delete material.catalog_pricing;
    draft = normalizeQuoteDraft(material, now);
    if (draft.totalCents !== priced.totalCents) throw fail('catalog_price_changed', 'The catalog quote total changed. Preview the products again.', 409);
    Object.assign(draft, { depositCents: priced.depositCents, depositPct: priced.depositPct, pricingSettingsVersion: priced.settingsVersion, catalogPricing: structuredClone(priced.catalogPricing) });
  } else {
    draft = normalizeQuoteDraft(input.draft, now);
    if (draft.lineItems.some(line => line.catalog)) throw fail('catalog_descriptor_required', 'Catalog products must be saved from a current server price preview.', 409);
  }
  // An estimator names a customer they may not see only by their own customer-resolve reference, under an agreeing name.
  const named = await authorCustomer(store, actor, access, input.customerId, { env, clientName: draft.client.name, prefix: 'quote_draft_',
    source: input.sourceWalkthroughId ? await store.read('jobs', input.sourceWalkthroughId) : null, job: input.jobId ? await store.read('jobs', input.jobId) : null });
  const customer = named.customer; requireRevision(customer);
  if (!identityMatches(draft.client, customer)) throw fail('customer_mismatch', 'The quote\'s customer details do not match the selected customer. Review the phone, email and CRM link.');
  const record = (job, plan, jobId) => ({ quoteDraft: { ...(plain(job?.quoteDraft) ? job.quoteDraft : { version: 1, createdAt: now, createdBy: actor.user }), requestId: input.requestId, fingerprint, savedAt: now, savedBy: actor.user, sourceWalkthroughId: input.sourceWalkthroughId || '',
      ...(draft.catalogPricing ? { catalogPricing: draft.catalogPricing } : job?.quoteDraft?.catalogPricing ? { catalogPricing: null } : {}),
      ...(draft.compositePricing ? { compositePricing: draft.compositePricing, breakdown: draft.breakdown } : job?.quoteDraft?.compositePricing ? { compositePricing: null, breakdown: null } : {}) },
    receipt: { fingerprint, actorId: actor.user, action: 'save', customerId: customer.id, jobId, sourceWalkthroughId: input.sourceWalkthroughId || '', estimateRevision: plan.patch.estimate.revision, material: plan.material, revisedRelease: plan.revisedRelease, warnings: plan.warnings, createdAt: now } });
  const audit = (job, patch, jobId) => auditWrite({ actor: { id: actor.user, kind: 'human', role: actor.role }, via: 'hub', action: 'quote.draft.save', entity: { collection: 'jobs', id: jobId }, before: job ? moneySnapshot(job) : null, after: moneySnapshot({ ...(job || {}), ...patch }), requestId: input.requestId, reason: null, now });
  try {
    if (input.jobId) {
      const job = await readJobFor(store, input.jobId, { actor, access, env });
      if (job.customerId !== customer.id || (job.sourceWalkthroughId || '') !== (input.sourceWalkthroughId || '')) throw fail('job_mismatch', 'This quote belongs to a different customer or walkthrough. Reload it before revising.');
      if (job.revision !== input.expectedRevision) throw fail('revision_conflict', 'This quote changed after you opened it. Reload it and review the latest version.');
      editable(job);
      // An in-person signature is revised only through a new signed walkthrough handoff.
      if (approved(job.estimate?.status) && job.estimate?.acceptanceMethod === 'in_person_signature') throw fail('signed', 'The customer signed this quote in person. Start a signed revision in the walkthrough instead.');
      const plan = quotePatch(job, draft, actor, now, job.id), saved = record(job, plan, job.id), patch = { ...plan.patch, ...capturePatch(job, draft, actor, now), ...serviceTypeRevision(job, junkOnlyQuote), quoteDraft: saved.quoteDraft, ...refPatch(named, actor, draft.client.name), updatedAt: now };
      // FUN-03: a material revision ends the job's live sale (a portal approval of
      // an earlier revision), as the Hub estimate editor does: deal.approval_superseded
      // and the cleared funnelSale are in this revision's commit.
      const retired = plan.material ? await moneySupersedeWrite(job, actor, { requestId: input.requestId, via: 'hub', source: { collection: QUOTE_DRAFT_RECEIPTS, id: receiptId } }, now) : null;
      if (retired) patch.funnelSale = null;
      // FUN-33: the paid-in-full crossing of a material revision, in the same commit (nothing when the flag is off).
      const crossing = plan.material && funnelPaymentEventsEnabled(env) ? await moneyEventWrites({ before: job, after: { ...job, ...patch }, now, idempotencyKey: { kind: 'requestId', value: input.requestId },
        actor: { id: actor.user, kind: 'human', role: actor.role }, via: 'hub', source: { collection: QUOTE_DRAFT_RECEIPTS, id: receiptId }, reason: 'estimate_revised' }) : { patch: {}, writes: [] };
      Object.assign(patch, crossing.patch);
      await store.commit([
        { collection: 'jobs', id: job.id, revision: job.revision, patch },
        { collection: 'customers', id: customer.id, revision: customer.revision, verify: true },
        { collection: QUOTE_DRAFT_RECEIPTS, id: receiptId, patch: saved.receipt },
        audit(job, patch, job.id),
        ...(retired ? [retired] : []),
        ...crossing.writes,
      ]);
    } else await createDraft(store, actor, input, draft, customer, now, env, { record, audit, receiptId, newQuotePaymentPolicy, junkOnlyQuote, ref: refPatch(named, actor, draft.client.name) });
  } catch (error) {
    if (FINAL.has(error.code)) throw error;
    const recovered = await replay(false).catch(problem => { if (FINAL.has(problem.code)) throw problem; return null; });
    if (recovered) return recovered;
    if (error.code === 'dispatch_revision_conflict') throw fail('revision_conflict', 'The customer, walkthrough or quote changed while saving. Reload it and review the latest version.');
    throw error;
  }
  const saved = await replay(false);
  if (!saved) throw fail('outcome_unknown', 'The save could not be read back. Retry the identical request; do not start another quote.', 503);
  return saved;
}

async function createDraft(store, actor, input, draft, customer, now, env, { record, audit, receiptId, newQuotePaymentPolicy, junkOnlyQuote = false, ref = {} }) {
  let source = null, sourceProject = null;
  if (input.sourceWalkthroughId) {
    source = await store.read('jobs', input.sourceWalkthroughId); requireRevision(source);
    if (source.type !== 'walkthrough' || source.recordType || source.revision !== input.sourceRevision || ['cancelled', 'canceled', 'noshow', 'no_show'].includes(stage(source))) throw fail('source_changed', 'The walkthrough changed or was cancelled. Refresh and review it before saving.');
    if (source.customerId ? source.customerId !== customer.id : !identityMatches(source, customer)) throw fail('source_mismatch', 'The source walkthrough must belong to the exact same customer.');
    if (source.highlevelContactId && customer.highlevelContactId && source.highlevelContactId !== customer.highlevelContactId) throw fail('source_mismatch', 'The source and customer point to different CRM contacts.');
    // DISPATCH-SCALE: the same saveJobReads lookup the signed handoff uses (a query when windowed reads are on).
    if (source.convertedJobId || (await saveJobReads(store).where('sourceWalkthroughId', source.id)).some(row => operational(row) && row.sourceWalkthroughId === source.id)) throw fail('existing_job', 'This walkthrough already has a saved job. Revise that job\'s quote rather than starting another.');
    if (source.projectId) {
      sourceProject = await store.read('projects', source.projectId);
      if (!sourceProject) throw fail('source_unavailable', 'The source project is missing. Review the walkthrough linkage.', 503);
      requireRevision(sourceProject);
      if (sourceProject.customerId !== customer.id) throw fail('source_mismatch', 'The source project belongs to a different customer.');
    }
  }
  const changes = { title: draft.title, address: draft.client.address, serviceType: quoteServiceType(junkOnlyQuote), ...(draft.crewSize ? { crewNeeded: draft.crewSize } : {}) };
  const dispatchInput = { action: 'schedule.create', requestId: input.requestId, customerId: customer.id, kind: 'job', ...(source ? { sourceWalkthroughId: source.id } : {}), changes };
  const adapter = { ...store,
    // An orphan legacy walkthrough gains only the verified customer link; its
    // original revision is fenced in the same commit (as in the signed handoff).
    read: async (collection, id) => {
      const row = await store.read(collection, id);
      return collection === 'jobs' && source?.id === id && row?.revision === source.revision && !row.customerId ? { ...row, customerId: customer.id } : row;
    },
    commit: async writes => {
      const target = writes.find(write => write.collection === 'jobs' && write.patch?.dispatchRequestId === input.requestId);
      if (!target) throw fail('commit_incomplete', 'The complete quote draft could not be prepared.', 503);
      const plan = quotePatch(null, draft, actor, now, target.id, newQuotePaymentPolicy), saved = record(null, plan, target.id);
      Object.assign(target.patch, plan.patch, capturePatch(target.patch, draft, actor, now), { quoteDraft: saved.quoteDraft }, ref);
      // A review can finish before its quote exists. Preserve the finalized
      // source receipt and create the same gated note intent as finalize-after-
      // quote, using the new canonical job/contact identity, never the old one.
      if (draft.walkthroughCapture === undefined && source?.walkthroughReview?.stage === 'finalized' && source.walkthroughReview.latestFinalized) {
        target.patch.walkthroughReviewReference = { sourceJobId: source.id, ...source.walkthroughReview.latestFinalized };
        target.patch.walkthroughCaptureSync = prepareWalkthroughCaptureSync(target.patch, now);
      }
      function fence(collection, row, patch) {
        const found = writes.find(write => write.collection === collection && write.id === row.id);
        if (found) {
          if (found.revision !== row.revision) throw fail('source_changed', 'Customer or walkthrough evidence changed during save. Refresh and retry.');
          if (patch) { found.verify = false; found.patch = { ...found.patch, ...patch }; }
        } else writes.push({ collection, id: row.id, revision: row.revision, ...(patch ? { patch } : { verify: true }) });
      }
      fence('customers', customer);
      if (sourceProject) fence('projects', sourceProject);
      // The walkthrough keeps its status, completion, signature and money.
      if (source) fence('jobs', source, source.customerId ? null : { customerId: customer.id, updatedAt: now });
      writes.push({ collection: QUOTE_DRAFT_RECEIPTS, id: receiptId, patch: saved.receipt }, audit(null, target.patch, target.id));
      await store.commit(writes);
    },
  };
  await mutateDispatch(adapter, actor, dispatchInput, now, { authorize: session => requireQuoteAuthor(session, env) });
}

// Everything a send confirmation is bound to: the job revision, the exact
// estimate (revision and fingerprint) and whether HighLevel will be triggered.
function deliveryPlan(job, env) {
  const flags = messagingFlags(env), phone = normalizePhone(job.phone), email = normalizeEmail(job.email);
  const recipient = phone ? { channel: 'SMS', masked: maskRecipient('SMS', phone) } : email ? { channel: 'Email', masked: maskRecipient('Email', email) } : { channel: '', masked: '' };
  const mode = job.notify === false ? 'suppressed' : !flags.enabled ? 'off' : flags.dryRun ? 'dry_run' : 'automation';
  return { mode, recipient };
}
function sendBinding(job, delivery, paymentSchedule) {
  return { jobId: job.id, jobRevision: job.revision, customerId: job.customerId || '', estimateNumber: job.estimate.number, estimateRevision: job.estimate.revision, estimateFingerprint: estimateFingerprint(paymentSchedule ? {...job.estimate,paymentSchedule} : job.estimate), delivery: delivery.mode };
}
// The estimate as it is sent (owner decision of 2026-10-18 evening, quote-payment-policy.js SENT_25_75): a quote saved on
// the earlier sent-quote terms (FINAL_25_75 or the pending variant), or saved with none (a draft from before 2026-10-14,
// 50% upfront), and not sent in this revision, a new revision of a quote sent on them included, is sent on SENT_25_75
// (its 25% deposit due when the customer approves it), with its terms id and its 25% deposit (the same cents for the
// earlier 25/75 terms; the job's deposit follows it in the send). Any other estimate is sent on its own terms. A quote
// already sent keeps its saved estimate, terms and dates: this is read only when a revision is sent.
function sendingEstimate(estimate) {
  const saved = estimate.commercialPolicy, policy = sentQuotePaymentPolicy(saved, { quoteDraft: true });
  if (policy === saved) return estimate;
  const deposit = depositCents(estimate.amountCents, policy.depositPct);
  return { ...estimate, commercialPolicy: snapshotQuotePaymentPolicy(policy), depositPct: policy.depositPct, depositRequired: deposit / 100, depositRequiredCents: deposit,
    termsVersion: saved === undefined || saved === null || !estimate.termsVersion || estimate.termsVersion === saved.version ? policy.version : estimate.termsVersion };
}
// The saved schedule is sent again only for a revision sent on the same terms. A quote sent on SENT_25_75 has no deposit
// date to protect and every revision of it asks for a fresh approval, so its saved schedule is reused only while its
// remainder is still due on the booked job day: after a reschedule the revision is sent with the new job day.
const reusesSchedule = (job, sending) => Boolean(job.estimate.paymentSchedule) && sending === job.estimate &&
  !(sending.commercialPolicy?.depositDueRule === 'approval_day' && job.estimate.paymentSchedule.remainderDueDate !== businessPaymentDate(job.date));
async function paymentScheduleFor(store, job, sending = job.estimate) {
  if (!sending?.commercialPolicy) return null;
  // Issued agreements retain their exact schedule. Rescheduling cannot silently
  // rewrite those dates; a future explicit terms amendment is required. A quote
  // sent now on new terms (sendingEstimate), or a SENT_25_75 revision sent after
  // a reschedule (reusesSchedule), gets a new schedule of its terms.
  const source = job.sourceWalkthroughId ? await store.read('jobs', job.sourceWalkthroughId) : null, policy = sending.commercialPolicy, onApproval = policy.depositDueRule === 'approval_day';
  if (reusesSchedule(job, sending)) {
    const saved=sending.paymentSchedule,walk=businessPaymentDate(source?.walkthroughCompletedAt||source?.completedAt||source?.date),day=businessPaymentDate(job.date);
    if(day&&saved.remainderDueDate!==day||!onApproval&&walk&&saved.depositDueDate<walk)throw fail('payment_schedule_amendment_required','The schedule changed after these payment dates were issued. Review an explicit payment-terms amendment; the saved agreement was not changed.');
    const amounts=quotePaymentSchedule(sending.amountCents,policy);return {...saved,depositCents:amounts.depositCents,remainderCents:amounts.remainderCents};
  }
  // SENT_25_75 dates its deposit by the approval (none yet: depositDueDate null) and its remainder by the booked job day;
  // like every 25/75 quote it is sent for review only from a walkthrough booked in the Hub.
  if (onApproval && !source) throw fail('payment_dates_pending', 'A quote is sent for review only from a walkthrough booked in the Hub, once its job date is booked: the 75% balance is due on the job day.');
  const dates = quotePaymentDates(policy,{walkthroughDate:source?.walkthroughCompletedAt || source?.completedAt || source?.date,jobDate:job.date});
  const amounts = quotePaymentSchedule(sending.amountCents,policy);
  return {...dates,timeZone:PAYMENT_TIME_ZONE,policyVersion:policy.version,depositCents:amounts.depositCents,remainderCents:amounts.remainderCents,sourceWalkthroughId:source.id,sourceRevision:source.revision};
}
// The send preview's words for a schedule: a deposit due on approval says so (quote-payment-policy.js quotePaymentSummary).
const scheduleSummary = (schedule, policy) => quotePaymentSummary(policy?.depositDueRule === 'approval_day' ? { ...schedule, depositDueOn: 'approval' } : schedule);
function sendable(job, now, env) {
  editable(job);
  if (plain(job.quoteDraft?.catalogPricing) && !catalogQuotesEnabled(env)) throw fail('catalog_disabled', 'Catalog quotes are turned off. Keep this saved quote for review.', 404);
  if (plain(job.quoteDraft?.compositePricing) && !quoteBuilderEnabled(env)) throw fail('builder_disabled', 'The quote builder is turned off. Keep this saved quote for review.', 404);
  const estimate = plain(job.estimate) ? job.estimate : null;
  if (!estimate?.number || !Number.isSafeInteger(estimate.revision)) throw fail('estimate_missing', 'Save the quote before sending it.');
  requireQuotePaymentTiming(sentQuotePaymentPolicy(estimate.commercialPolicy, { quoteDraft: true }));
  if (approved(estimate.status) || approved(job.customerApproval?.status)) throw fail('already_approved', 'The customer already approved this quote. Revise it first if they are reviewing a change.');
  if (estimate.status === 'sent' && estimate.sentRevision === estimate.revision) throw fail('already_sent', `Revision ${estimate.revision} was already sent. Revise the quote to send an updated version.`);
  let lines;
  try { ({ lineItems: lines } = normalizeLineItems(estimate.lineItems, { strict: true })); } catch { throw fail('estimate_invalid', 'The saved quote lines need review before sending. Save the quote again.'); }
  const totals = estimateTotals(lines);
  if (!validateSelection(lines).ok || !totals.complete || totals.totalCents !== estimate.amountCents || totals.totalCents <= 0) throw fail('estimate_invalid', 'The saved quote total no longer matches its lines. Save the quote again before sending.');
  if (!validDate(estimate.validUntil) || estimate.validUntil < denverToday(new Date(now))) throw fail('estimate_expired', 'This quote has expired. Save it with a new expiry date before sending.');
}
// A builder quote is sent only when every price on it is owner-approved now (approved after the save counts).
// While the builder is on, a walkthrough quote priced outside it (the walkthrough's own itemized lines, priced from
// the same tables the builder holds as owner-unapproved drafts) is kept but never sent: it is rebuilt in the
// builder first. Catalog quotes keep their own catalog approval. D-JUNK: a junk-only builder quote ($750 per truck,
// no Labor line) is never sent on a walkthrough whose saved capture records garage work (junkOnlyGarageWork), as the
// homeowner never signs one on it (walkthrough-handoff.js): it stays saved until the work is added or the walkthrough
// corrected and the quote saved again.
async function compositeSendable(job, env, compositeState) {
  if (!plain(job.quoteDraft?.compositePricing)) {
    if (quoteBuilderEnabled(env) && !plain(job.quoteDraft?.catalogPricing)) throw fail('builder_required', 'With the quote builder on, a walkthrough quote is sent only after it is built in the quote builder from the owner\'s pricing menu. This draft stays saved: reopen "Send options for review" on the walkthrough and build it there.', 409,
      { unapproved: [{ id: null, name: 'Walkthrough-priced quote', unitCents: null, reason: 'Its lines were priced from the walkthrough tables, which the owner has not approved for the quote builder. Rebuild it in the quote builder (removal, then shelving, then extra storage) and send that quote.' }] });
    return;
  }
  const work = junkOnlyGarageWork(job);
  if (work.length) throw fail('junk_only_garage_work', `This junk-only quote prices the hauling only ($750 per truck covers the crew's time; it has no Labor line), but the walkthrough records garage work: ${work.join(', ')}. It stays saved as a draft and was not sent. Edit the quote and add that work (a garage cleaning base for the sorting and reset, cleaning, shelving or storage), then save and send it; or, if the homeowner wants junk removal only, change the walkthrough to Everything goes or Customer labels before arrival, remove those finish options and save the quote again.`, 409, { garageWork: work });
  const approval = compositeApproval(job.quoteDraft.breakdown, await compositeState(env));
  if (!approval.ready) throw approvalRefusal(approval);
}

export async function previewQuoteSend(store, actor, input, now = new Date().toISOString(), { env = {}, compositeState = compositeStateDefault } = {}) {
  const access = requireQuoteAuthor(actor, env);
  keys(input, PREVIEW_KEYS, 'Choose the saved quote to send.');
  if (!safeId(input.jobId) || typeof input.expectedRevision !== 'string' || !input.expectedRevision) throw fail('invalid_request', 'Choose the saved quote to send.', 400);
  actorMatches(input, actor);
  const job = await readJobFor(store, input.jobId, { actor, access, env });
  if (job.revision !== input.expectedRevision) throw fail('revision_conflict', 'This quote changed after you opened it. Reload it and review the latest version.');
  sendable(job, now, env);
  await compositeSendable(job, env, compositeState);
  const delivery = deliveryPlan(job, env), estimate = sendingEstimate(job.estimate), paymentSchedule = await paymentScheduleFor(store,job,estimate), sending = { ...job, estimate };
  // An estimator who may not see the customer is shown the name they typed (jobCustomerAccess), never the stored one.
  const seen = await seenBy(store, actor, access, env)(job), shownName = seen.full ? job.customer : seen.name;
  const summary = `Send ${estimate.number} revision ${estimate.revision} (${usd(estimate.amountCents)}) to ${String(shownName || 'the customer').slice(0, 80)}`+(paymentSchedule?'. '+scheduleSummary(paymentSchedule,estimate.commercialPolicy):'');
  const confirmation = await issueConfirmation(env, { actorId: actor.user, action: SEND_ACTION, entityId: `jobs/${job.id}`, payload: sendBinding(sending, delivery, paymentSchedule), summary, now });
  return { ok: true, authority: 'employee_hub', job: quoteDraftView(paymentSchedule?{...job,estimate:{...estimate,paymentSchedule}}:sending, seen), delivery, summary: confirmation.summary, confirmToken: confirmation.token, expiresAt: confirmation.expiresAt };
}

/**
 * Records the human send, then (and only then) asks `deliver(jobId, context)` to
 * notify the customer. A retry of the same request replays the saved send and
 * lets the deliverer's own ledger decide; it never records a second send.
 */
export async function sendQuoteDraft(store, actor, input, now = new Date().toISOString(), { env = {}, deliver = null, compositeState = compositeStateDefault } = {}) {
  const access = requireQuoteAuthor(actor, env);
  keys(input, SEND_KEYS, 'The send request contains unsupported fields.');
  if (!uuid(input.requestId) || !safeId(input.jobId) || typeof input.expectedRevision !== 'string' || !input.expectedRevision || typeof input.confirmToken !== 'string') throw fail('invalid_request', 'Preview the quote and confirm it before sending.', 400);
  actorMatches(input, actor);
  const fingerprint = await hash({ actor: actor.user, input }), receiptId = input.requestId.toLowerCase();
  async function replay(replayed) {
    const receipt = await store.read(QUOTE_DRAFT_RECEIPTS, receiptId);
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint || receipt.actorId !== actor.user || receipt.action !== 'send') throw fail('idempotency_conflict', 'This send identity belongs to a different request. Preview the quote again.');
    let saved = await store.read('jobs', receipt.jobId);
    if (!saved || saved.estimate?.sentRequestId !== input.requestId) throw fail('changed_since_send', 'The quote was sent, but it has changed since. Reload it to see its current state.');
    let delivery = pick(saved.estimateReady, ['status', 'reason', 'attempts', 'recipient', 'tagReset']) || { status: 'not_requested' };
    // A previously recorded send still replays truthfully after catalog rollback,
    // but a retry must not initiate a new provider delivery while it is off.
    if (typeof deliver === 'function' && !(plain(saved.quoteDraft?.catalogPricing) && !catalogQuotesEnabled(env)) && saved.estimateReady?.requestId === input.requestId && RETRYABLE_DELIVERY.has(saved.estimateReady.status)) {
      delivery = await deliver(saved.id, { requestId: input.requestId, actorId: actor.user, actorRole: actor.role, mode: saved.estimateReady.mode }).catch(() => ({ status: 'uncertain', reason: 'delivery_unconfirmed' }));
      saved = await store.read('jobs', receipt.jobId) || saved;
    }
    return outcome(saved, 'send', input.requestId, replayed, receipt.warnings || [], { delivery }, await seenBy(store, actor, access, env)(saved));
  }
  const prior = await replay(true);
  if (prior) return prior;
  const job = await readJobFor(store, input.jobId, { actor, access, env });
  if (job.revision !== input.expectedRevision) throw fail('revision_conflict', 'This quote changed after the preview. Preview it again before sending.');
  sendable(job, now, env);
  await compositeSendable(job, env, compositeState);
  const delivery = deliveryPlan(job, env), estimate = sendingEstimate(job.estimate), paymentSchedule = await paymentScheduleFor(store,job,estimate);
  const patch = {
    estimate: { ...estimate, ...(paymentSchedule?{paymentSchedule}:{}), status: 'sent', sentAt: now, sentBy: actor.user, sentChannel: 'estimate_ready', sentRevision: estimate.revision, sentFingerprint: estimateFingerprint(paymentSchedule?{...estimate,paymentSchedule}:estimate), sentRequestId: input.requestId, updatedAt: now },
    quoteStatus: 'sent',
    // A quote sent on new terms with a new deposit (sendingEstimate: a draft saved before 2026-10-14 at 50%) moves the job's deposit with it.
    ...(estimate.depositRequiredCents !== job.estimate.depositRequiredCents ? { deposit: depositDue(plain(job.deposit) ? job.deposit : {}, estimate.depositRequiredCents) } : {}),
    // The confirmed delivery mode: the deliverer never goes further than the person agreed to.
    estimateReady: { requestId: input.requestId, revision: estimate.revision, mode: delivery.mode, status: ['automation', 'dry_run'].includes(delivery.mode) ? 'pending' : delivery.mode === 'suppressed' ? 'suppressed' : 'messaging_disabled', attempts: 0, recipient: delivery.recipient.masked, requestedAt: now, requestedBy: actor.user },
    quoteDraft: { ...job.quoteDraft, sentAt: now, sentBy: actor.user },
    updatedAt: now,
  };
  const warnings = delivery.mode === 'off' ? [{ code: 'messaging_disabled', message: 'Customer messaging is turned off, so HighLevel was not asked to notify the customer. Share the quote with the customer yourself.' }] : delivery.mode === 'suppressed' ? [{ code: 'notifications_off', message: 'Customer notifications are off for this job, so HighLevel was not asked to notify the customer.' }] : [];
  const writes = [
    { collection: 'jobs', id: job.id, revision: job.revision, patch },
    { collection: QUOTE_DRAFT_RECEIPTS, id: receiptId, patch: { fingerprint, actorId: actor.user, action: 'send', customerId: job.customerId || '', jobId: job.id, estimateRevision: estimate.revision, delivery: delivery.mode, warnings, createdAt: now } },
    auditWrite({ actor: { id: actor.user, kind: 'human', role: actor.role }, via: 'hub', action: SEND_ACTION, entity: { collection: 'jobs', id: job.id }, before: moneySnapshot(job), after: moneySnapshot({ ...job, ...patch }), requestId: input.requestId, reason: `delivery:${delivery.mode}`, now }),
  ];
  if (paymentSchedule && !reusesSchedule(job, estimate)) writes.push({collection:'jobs',id:paymentSchedule.sourceWalkthroughId,revision:paymentSchedule.sourceRevision,verify:true});
  try { await consumeConfirmation(env, store, input.confirmToken, { actorId: actor.user, action: SEND_ACTION, entityId: `jobs/${job.id}`, payload: sendBinding({ ...job, estimate }, delivery, paymentSchedule), now, requestId: input.requestId }, writes); }
  catch (error) {
    const recovered = await replay(false).catch(problem => { if (FINAL.has(problem.code)) throw problem; return null; });
    if (recovered) return recovered;
    if (error.code === 'dispatch_revision_conflict') throw fail('revision_conflict', 'This quote changed while it was being sent. Preview it again.');
    throw error;
  }
  const saved = await replay(false);
  if (!saved) throw fail('outcome_unknown', 'The send could not be read back. Retry the identical request; it will not send twice.', 503);
  return saved;
}
