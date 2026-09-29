/* Account-level customer reads (SEC-06). Every request loads the customer and
   queries jobs by customerId, skips private and non-operational rows, and
   re-verifies each job's account root (customerId equality at every hop), so a
   job moved to another customer disappears on the next request and a job id
   supplied by the browser is never trusted. Only allowlisted DTO fields leave
   this module. A project linked to a business account (B2B-SAFE: non-empty
   businessAccountId on the job or its account root) is opened only through
   the Business Hub's role-checked access, so it is never listed, landed on or
   handed an owner-level portal session here. */
import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields } from './firestore-job.js';
import { dispatchStorage } from './dispatch-storage.js';
import { verifiedAccountRoot } from './dispatch-lineage.js';
import { createCustomerPortalSessionCookie, customerPortalLinkVersion } from './customer-portal.js';
import { customerPortalAccountRoot } from './customer-portal-revocation.js';
import { customerMoneyState, customerPaymentNeedsReview } from './customer-payments.js';
import { denverToday } from './dispatch-time.js';
import { customerAccountId, portalSessionVersion } from './customer-account-session.js';
import { projectReleased } from './business-hub-core.js';
import { businessAccountJob } from './portal-invitation.js';
import { hasBusinessAccess } from './hub-session.js';
import { auditWrite } from './hub-audit.js';

const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
export const ACCOUNT_PAGE_SIZE = 100;
export const ACCOUNT_MAX_JOBS = 200;
const ROOT_READS = 25;
// Masked query: only these fields leave Firestore, and only the named subfields
// of the quote, invoice and payment maps (never line items or signatures). The
// money inputs mirror customerMoneyState and customerPaymentNeedsReview, the
// quote inputs projectReleased.
export const ACCOUNT_JOB_FIELDS = Object.freeze([
  'type', 'recordType', 'customerId', 'customerAccountOwnerJobId', 'customerPortalLinkVersion', 'businessAccountId', 'status', 'pipelineStatus', 'date', 'time', 'endTime', 'address', 'serviceType', 'arrivalWindow',
  'quoteStatus', 'total', 'priceQuoted', 'lockedTotal', 'rate', 'createdAt', 'updatedAt',
  'estimate.number', 'estimate.status', 'estimate.amount', 'estimate.sentAt', 'estimate.validUntil', 'estimate.acceptedAt',
  'customerApproval.status', 'customerApproval.approvedAt', 'customerApproval.amount',
  'invoice.number', 'invoice.status', 'invoice.dueDate', 'invoice.paid', 'invoice.amountPaid',
  'payment.amount', 'payment.verified', 'payment.receiptUrl', 'payment.paidAt', 'payment.verifiedAt',
  'deposit.paidAmount', 'deposit.verified',
]);
const OPERATIONAL = new Set(['job', 'cleanout', 'reorg', 'walkthrough']);
const STAGES = new Set(['unscheduled', 'scheduled', 'dispatched', 'arrived', 'in_progress', 'completed', 'invoiced', 'paid', 'review_requested', 'closed', 'cancelled']);
const CLOSED = new Set(['cancelled', 'closed']);
const QUOTE_STATES = new Set(['ready', 'sent', 'approved', 'declined', 'expired']);
const INVOICE_STATES = new Set(['issued', 'sent', 'partial', 'paid', 'overdue', 'pending_verification']);
const RECEIPT_URL = /^https:\/\/pay\.stripe\.com\/receipts\/[A-Za-z0-9_\-/]+$/;
const fail = (code, message, status) => Object.assign(new Error(message), { code, status });
const incomplete = () => fail('CUSTOMER_ACCOUNT_STORAGE_UNAVAILABLE', 'Your projects could not be loaded completely. Please try again shortly.', 503);
const text = (value, max = 180) => typeof value === 'string' ? value.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim().slice(0, max) : '';
const isoDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : '';
const clock = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value || '') ? value : '';
const cents = dollars => Number.isFinite(dollars) ? Math.max(0, Math.round(dollars * 100)) : null;
const operational = row => Boolean(row && customerAccountId(row.id) && !row.recordType && OPERATIONAL.has(row.type));
// The page cursor is the last document id seen, which may be a legacy id the DTOs skip; Firestore ids only exclude '/'.
const cursor = value => typeof value === 'string' && value.length <= 1500 && !value.includes('/') && value !== '.' && value !== '..';
const stage = job => { const raw = String(job.pipelineStatus || job.status || 'scheduled').toLowerCase(); return raw === 'canceled' || raw === 'lost' ? 'cancelled' : STAGES.has(raw) ? raw : 'scheduled'; };
const hidden = job => ['superseded'].includes(String(job.pipelineStatus || job.status || '').toLowerCase());
const businessManaged = (job, root) => businessAccountJob(job) || businessAccountJob(root);

function decode(document) {
  const prefix = `${ROOT}/jobs/`, name = document?.name;
  const id = typeof name === 'string' && name.startsWith(prefix) ? name.slice(prefix.length) : '';
  if (!id || id.includes('/') || typeof document.updateTime !== 'string' || !document.updateTime || (document.fields !== undefined && (!document.fields || typeof document.fields !== 'object' || Array.isArray(document.fields)))) throw incomplete();
  return { ...decodeFirestoreFields(document.fields || {}), id, revision: document.updateTime };
}

/** dispatchStorage read/commit plus a masked, cursor-paginated jobs query. */
export function customerAccountStorage(env, fetcher = firestoreFetch) {
  const base = dispatchStorage(env, fetcher);
  return {
    read: base.read, commit: base.commit,
    async customerJobs(customerId, { limit = ACCOUNT_PAGE_SIZE, after = '' } = {}) {
      if (!customerAccountId(customerId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (after && !cursor(after))) throw fail('CUSTOMER_ACCOUNT_QUERY_INVALID', 'The project lookup is invalid.', 400);
      let response;
      try {
        response = await fetcher(env, `${BASE}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000), body: JSON.stringify({ structuredQuery: {
          from: [{ collectionId: 'jobs' }], select: { fields: ACCOUNT_JOB_FIELDS.map(fieldPath => ({ fieldPath })) },
          where: { fieldFilter: { field: { fieldPath: 'customerId' }, op: 'EQUAL', value: { stringValue: customerId } } },
          orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
          ...(after ? { startAt: { values: [{ referenceValue: `${ROOT}/jobs/${after}` }], before: false } } : {}),
          limit,
        } }) });
      } catch { throw fail('CUSTOMER_ACCOUNT_STORAGE_UNAVAILABLE', 'Your projects could not be loaded. Please try again shortly.', 503); }
      if (!response.ok) throw fail('CUSTOMER_ACCOUNT_STORAGE_UNAVAILABLE', 'Your projects could not be loaded. Please try again shortly.', 503);
      const rows = await response.json().catch(() => null);
      if (!Array.isArray(rows)) throw incomplete();
      return rows.filter(row => row?.document).map(row => decode(row.document));
    },
  };
}

// A page must be ordered, bounded, after the cursor and entirely this customer's.
async function customerRows(store, customerId, pageSize, maxJobs) {
  const rows = [];
  let after = '', complete = true;
  while (rows.length < maxJobs) {
    const limit = Math.min(pageSize, maxJobs - rows.length), page = await store.customerJobs(customerId, { limit, after });
    if (!Array.isArray(page) || page.length > limit) throw incomplete();
    for (const row of page) {
      if (!row || typeof row.id !== 'string' || !row.id || row.id <= after || row.customerId !== customerId) throw incomplete();
      rows.push(row); after = row.id;
    }
    if (page.length < limit) return { rows, complete };
  }
  complete = false;
  return { rows, complete };
}

function jobView(job) {
  return {
    jobId: job.id, type: job.type, service: text(job.serviceType, 120) || (job.type === 'walkthrough' ? 'Walkthrough' : 'Garage service'), status: stage(job),
    date: isoDate(job.date), time: clock(job.time), endTime: clock(job.endTime), address: text(job.address, 240), arrivalWindow: text(job.arrivalWindow, 80),
  };
}

function quoteView(job, today) {
  const estimate = job.estimate && typeof job.estimate === 'object' ? job.estimate : null;
  if (!estimate || (estimate.amount === undefined && !estimate.number)) return null;
  const raw = String(job.customerApproval?.status || estimate.status || job.quoteStatus || 'ready').toLowerCase();
  // The business hub's release rule: never a draft, void, withdrawn, replaced or unsent quote.
  if (!projectReleased(job) || ['draft', 'superseded'].includes(raw)) return null;
  const validUntil = isoDate(estimate.validUntil), approved = ['accepted', 'approved'].includes(raw);
  const status = approved ? 'approved' : validUntil && validUntil < today ? 'expired' : QUOTE_STATES.has(raw) ? raw : 'ready';
  return { jobId: job.id, number: text(estimate.number, 80), status, amountCents: cents(customerMoneyState(job).total), validUntil, approvedAt: text(job.customerApproval?.approvedAt || estimate.acceptedAt, 40) };
}

function invoiceView(job) {
  const invoice = job.invoice && typeof job.invoice === 'object' ? job.invoice : null;
  if (!invoice?.number) return null;
  const raw = String(invoice.status || 'draft').toLowerCase();
  if (['draft', 'void', 'superseded'].includes(raw)) return null;
  const finance = customerMoneyState(job), review = customerPaymentNeedsReview(job);
  // An unverified payment never produces a balance the customer could act on.
  return { jobId: job.id, number: text(invoice.number, 80), status: review ? 'pending_verification' : INVOICE_STATES.has(raw) ? raw : 'issued', totalCents: cents(finance.total), paidCents: review ? null : cents(finance.paid), balanceCents: review ? null : cents(finance.balance), dueDate: isoDate(invoice.dueDate), needsReview: review };
}

function receiptView(job) {
  const payment = job.payment && typeof job.payment === 'object' ? job.payment : null;
  if (payment?.verified !== true || !RECEIPT_URL.test(payment.receiptUrl || '')) return null;
  return { jobId: job.id, amountCents: cents(customerMoneyState(job).paid), paidAt: text(payment.paidAt || payment.verifiedAt, 40), receiptUrl: payment.receiptUrl };
}

// Upcoming visits first (soonest), then the most recent past visit; closed and cancelled work is never a landing page.
function landingOrder(today) {
  const rank = job => job.date && job.date >= today ? 0 : job.date ? 1 : 2;
  return (a, b) => rank(a.view) - rank(b.view) || (rank(a.view) === 0 ? `${a.view.date}${a.view.time}`.localeCompare(`${b.view.date}${b.view.time}`) : `${b.view.date}${b.view.time}`.localeCompare(`${a.view.date}${a.view.time}`)) || a.view.jobId.localeCompare(b.view.jobId);
}

// Roots are usually among the customer's own rows; anything else is read once, within a bound.
function rootLoader(store, rows) {
  const known = new Map(rows.map(row => [row.id, row])), extra = new Map();
  return async id => {
    if (known.has(id)) return known.get(id);
    if (!extra.has(id)) {
      if (extra.size >= ROOT_READS) throw fail('CUSTOMER_ACCOUNT_STORAGE_UNAVAILABLE', 'Your projects could not be verified completely. Please try again shortly.', 503);
      extra.set(id, store.read('jobs', id));
    }
    return extra.get(id);
  };
}

// A resolved account root, or null when its lineage needs review.
async function reviewed(resolve) {
  try { return await resolve(); }
  catch (error) {
    if (String(error?.code || '').startsWith('dispatch_lineage_')) return null;
    throw error?.code?.startsWith('CUSTOMER_ACCOUNT_') ? error : fail('CUSTOMER_ACCOUNT_STORAGE_UNAVAILABLE', 'Your projects could not be loaded. Please try again shortly.', 503);
  }
}
// The job's verified account root (the job itself must be operational), or null.
const verifiedRoot = (load, job, customerId) => reviewed(() => verifiedAccountRoot(load, job.id, customerId));

/** Customer, DTO lists and the landing job for a signed-in account session. */
export async function readCustomerAccountContext(store, session, { now = new Date(), pageSize = ACCOUNT_PAGE_SIZE, maxJobs = ACCOUNT_MAX_JOBS } = {}) {
  const customerId = session?.customerId;
  if (!customerAccountId(customerId)) throw fail('CUSTOMER_ACCOUNT_AUTH_REQUIRED', 'Sign in with the link we send to your phone or email.', 401);
  let customer;
  try { customer = await store.read('customers', customerId); } catch { throw fail('CUSTOMER_ACCOUNT_STORAGE_UNAVAILABLE', 'Your account could not be loaded. Please try again shortly.', 503); }
  if (!customer || customer.recordType || customer.id !== customerId) throw fail('CUSTOMER_ACCOUNT_SESSION_REVOKED', 'Your sign-in has ended. Request a new sign-in link.', 401);
  const { rows, complete } = await customerRows(store, customerId, pageSize, maxJobs);
  const load = rootLoader(store, rows), verified = [];
  let needsReview = 0, businessProjects = 0;
  for (const job of rows.filter(row => operational(row) && !hidden(row))) {
    const root = await verifiedRoot(load, job, customerId);
    if (!root) { needsReview += 1; continue; }
    // Opened through the Business Hub's member roles, never as the homeowner owner.
    if (businessManaged(job, root)) { businessProjects += 1; continue; }
    verified.push({ job, root, view: jobView(job) });
  }
  const today = denverToday(now);
  const byDate = [...verified].sort((a, b) => `${b.view.date}${b.view.time}`.localeCompare(`${a.view.date}${a.view.time}`) || a.view.jobId.localeCompare(b.view.jobId));
  const landing = verified.filter(entry => !CLOSED.has(entry.view.status) && customerPortalLinkVersion(entry.root) !== null).sort(landingOrder(today))[0] || null;
  return {
    customerId,
    view: {
      customer: { name: text(customer.name, 120), firstName: text(customer.firstName, 60) || text(customer.name, 120).split(/\s+/)[0] || '' },
      jobs: byDate.map(entry => entry.view),
      quotes: byDate.map(entry => quoteView(entry.job, today)).filter(Boolean),
      invoices: byDate.map(entry => invoiceView(entry.job)).filter(Boolean),
      receipts: byDate.map(entry => receiptView(entry.job)).filter(Boolean),
      coverage: { complete, needsReview, businessProjects, asOf: now.toISOString() },
    },
    landing: landing ? { jobId: landing.job.id, linkVersion: customerPortalLinkVersion(landing.root), linkRoot: landing.root.id } : null,
  };
}

/** One job of this account, re-verified. A foreign, missing or private id all
 * answer the same 404, so ids from the browser reveal nothing. */
export async function readCustomerAccountJob(store, session, jobId) {
  const customerId = session?.customerId;
  if (!customerAccountId(customerId)) throw fail('CUSTOMER_ACCOUNT_AUTH_REQUIRED', 'Sign in with the link we send to your phone or email.', 401);
  const missing = () => fail('CUSTOMER_ACCOUNT_JOB_NOT_FOUND', 'That project is not available in your account.', 404);
  if (!customerAccountId(jobId)) throw missing();
  const cache = new Map(), load = id => { if (!cache.has(id)) cache.set(id, store.read('jobs', id)); return cache.get(id); };
  let job, root;
  try {
    job = await load(jobId);
    if (!operational(job) || job.id !== jobId || job.customerId !== customerId || hidden(job)) throw missing();
    root = await verifiedAccountRoot(load, jobId, customerId);
  } catch (error) {
    if (error.code === 'CUSTOMER_ACCOUNT_JOB_NOT_FOUND' || String(error?.code || '').startsWith('dispatch_lineage_')) throw missing();
    throw fail('CUSTOMER_ACCOUNT_STORAGE_UNAVAILABLE', 'Your project could not be loaded. Please try again shortly.', 503);
  }
  if (businessManaged(job, root)) throw fail('CUSTOMER_ACCOUNT_JOB_BUSINESS', 'This project is shared with a business account. Its team opens it from the Business Hub.', 409);
  const linkVersion = customerPortalLinkVersion(root);
  if (linkVersion === null) throw fail('CUSTOMER_ACCOUNT_JOB_REVIEW', 'This project needs review by Easy Garage Cleaning before it can be opened.', 409);
  return { job: jobView(job), linkVersion, linkRoot: root.id };
}

/** Hands a verified account job to the existing per-job portal: an owner
 * session bound to the account root and its current P4-15 link version. */
export async function customerAccountPortalCookie(store, env, session, jobId, nowMs) {
  const { linkVersion, linkRoot } = await readCustomerAccountJob(store, session, jobId);
  return createCustomerPortalSessionCookie(env, jobId, { linkVersion, linkRoot }, nowMs);
}

const RECEIPTS = 'customerPortalOperations';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVOKE_FIELDS = ['requestId', 'customerId', 'expectedRevision'];
// Schedule placeholders that can carry a customerId but never hold a portal link.
const SCHEDULE_ROWS = new Set(['blocked', 'availability']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : plain(value) ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const revokeFail = (code, message, status = 400) => fail(`CUSTOMER_ACCOUNT_REVOKE_${code}`, message, status);

function requireManager(actor) {
  if (!actor?.user) throw revokeFail('SIGN_IN_REQUIRED', 'Sign in to the EGC Hub.', 401);
  if (!hasBusinessAccess(actor) || !['owner', 'manager'].includes(actor.role)) throw revokeFail('FORBIDDEN', 'Only an owner or manager can sign a customer out of Client Login and their project links.', 403);
}

/** Every account root of the customer's projects (the documents whose
 * customerPortalLinkVersion governs their homeowner portal links and
 * sessions), including closed and Business Hub projects. Each row's root is
 * resolved exactly as the portal resolves it when a link is opened
 * (customerPortalAccountRoot), so a legacy job with no type that is its own
 * root is covered too. A row whose owner chain needs review is counted in
 * needsReview (the portal refuses its links while the chain is broken, and
 * the revoke reports it as not complete). */
export async function customerAccountRoots(store, customerId, { pageSize = ACCOUNT_PAGE_SIZE, maxJobs = ACCOUNT_MAX_JOBS } = {}) {
  const { rows, complete } = await customerRows(store, customerId, pageSize, maxJobs);
  const load = rootLoader(store, rows), roots = new Map();
  let needsReview = 0;
  for (const job of rows.filter(row => customerAccountId(row.id) && !row.recordType && !SCHEDULE_ROWS.has(row.type))) {
    const root = await reviewed(() => customerPortalAccountRoot(load, job));
    if (root) roots.set(root.id, root); else needsReview += 1;
  }
  return { roots: [...roots.values()].sort((a, b) => a.id.localeCompare(b.id)), complete, needsReview };
}

/** Staff sign a customer out of every device. One commit bumps the customer's
 * portalSessionVersion (every Client Login account session and unused sign-in
 * link) and the customerPortalLinkVersion of each account root, resolved as
 * the portal resolves it (the per-job owner portal sessions handed out at
 * sign-in, the homeowner portal links staff shared and collaborator links
 * bound to that version), with an idempotency receipt and a hub_audit entry
 * per record. portalLinksComplete is true only when every project was read,
 * no owner chain needs review (needsReview, returned) and every root was
 * bumped. Company (biz_) sessions are checked against the business account
 * instead and are not affected. Nothing is sent to the customer. */
export async function revokeCustomerAccountSessions(store, actor, input, now = new Date().toISOString()) {
  requireManager(actor);
  if (!plain(input) || Object.keys(input).some(key => !REVOKE_FIELDS.includes(key)) || typeof input.requestId !== 'string' || !UUID.test(input.requestId)) throw revokeFail('INVALID_REQUEST', 'Signing a customer out needs a unique request ID, the customer and its expected revision.');
  if (!customerAccountId(input.customerId)) throw revokeFail('INVALID_REQUEST', 'Choose a valid customer.');
  if (typeof input.expectedRevision !== 'string' || !input.expectedRevision || input.expectedRevision.length > 64) throw revokeFail('INVALID_REQUEST', 'Refresh the customer before signing them out.');
  const request = { requestId: input.requestId, customerId: input.customerId, expectedRevision: input.expectedRevision };
  const actorId = String(actor.user).trim().toLowerCase();
  const fingerprint = await digest({ scope: 'customer_account_revoke', actor: actorId, input: request }), receiptId = input.requestId.toLowerCase();
  const saved = receipt => ({ ok: true, customerId: receipt.customerId, portalSessionVersion: receipt.portalSessionVersion, previousPortalSessionVersion: receipt.previousPortalSessionVersion, portalLinkAccounts: receipt.portalLinkAccounts || [], portalLinksComplete: receipt.portalLinksComplete === true, needsReview: Number.isSafeInteger(receipt.needsReview) ? receipt.needsReview : 0, revokedAt: receipt.createdAt, revokedBy: receipt.actorId });
  const replay = async () => {
    const receipt = await store.read(RECEIPTS, receiptId);
    if (!receipt) return null;
    if (receipt.scope !== 'customer_account_revoke' || receipt.fingerprint !== fingerprint) throw revokeFail('IDEMPOTENCY_CONFLICT', 'This request ID was already used for a different change. Refresh and retry.', 409);
    return { ...saved(receipt), replayed: true };
  };
  const prior = await replay();
  if (prior) return prior;
  const customer = await store.read('customers', input.customerId);
  if (!customer || customer.recordType) throw revokeFail('NOT_FOUND', 'That customer is no longer available.', 404);
  if (customer.revision !== input.expectedRevision) throw revokeFail('REVISION_CONFLICT', 'The customer changed. Refresh and try again.', 409);
  const previous = portalSessionVersion(customer);
  // Replacing an unreadable counter could revive sessions from an earlier version.
  if (previous === null || !Number.isSafeInteger(previous + 1)) throw revokeFail('ACCOUNT_REVIEW', 'This customer has an invalid sign-in version. Ask an owner to review it.', 409);
  let scan;
  try { scan = await customerAccountRoots(store, customer.id); }
  catch { throw revokeFail('UNAVAILABLE', 'The customer’s projects could not be loaded, so nothing was changed. Retry the same request shortly.', 503); }
  // A root with an unreadable version already refuses every homeowner link; it is left for an owner to review.
  const bumps = scan.roots.map(root => ({ root, from: customerPortalLinkVersion(root) })).filter(({ from }) => from !== null && Number.isSafeInteger(from + 1));
  const next = previous + 1, portalLinkAccounts = bumps.map(({ root, from }) => ({ jobId: root.id, linkVersion: from + 1 }));
  const needsReview = scan.needsReview, portalLinksComplete = scan.complete && needsReview === 0 && bumps.length === scan.roots.length;
  const human = { id: actorId, kind: 'human', role: actor.role };
  try {
    await store.commit([
      { collection: 'customers', id: customer.id, revision: customer.revision, patch: { portalSessionVersion: next, portalSessionsRevokedAt: now, portalSessionsRevokedBy: actorId } },
      ...bumps.map(({ root, from }) => ({ collection: 'jobs', id: root.id, revision: root.revision, patch: { customerPortalLinkVersion: from + 1, customerPortalLinksRevokedAt: now, customerPortalLinksRevokedBy: actorId } })),
      { collection: RECEIPTS, id: receiptId, patch: { scope: 'customer_account_revoke', requestId: input.requestId, fingerprint, actorId, customerId: customer.id, previousPortalSessionVersion: previous, portalSessionVersion: next, portalLinkAccounts, portalLinksComplete, needsReview, createdAt: now } },
      auditWrite({ actor: human, via: 'hub', action: 'customer.portal_sessions_revoked', entity: { collection: 'customers', id: customer.id }, before: { portalSessionVersion: previous }, after: { portalSessionVersion: next }, requestId: input.requestId, now }),
      ...bumps.map(({ root, from }) => auditWrite({ actor: human, via: 'hub', action: 'customer.portal_links_revoked', entity: { collection: 'jobs', id: root.id }, before: { customerPortalLinkVersion: from }, after: { customerPortalLinkVersion: from + 1 }, requestId: input.requestId, now })),
    ]);
  } catch (problem) {
    const recovered = await replay().catch(() => null);
    if (recovered) return recovered;
    if (problem?.code === 'dispatch_revision_conflict') throw revokeFail('REVISION_CONFLICT', 'The customer or one of their projects changed while their sessions were being ended. Refresh and try again.', 409);
    throw revokeFail('OUTCOME_UNKNOWN', 'The sign-out could not be confirmed. Retry the same request to check whether it saved.', 503);
  }
  return { ok: true, customerId: customer.id, portalSessionVersion: next, previousPortalSessionVersion: previous, portalLinkAccounts, portalLinksComplete, needsReview, revokedAt: now, revokedBy: actorId };
}
