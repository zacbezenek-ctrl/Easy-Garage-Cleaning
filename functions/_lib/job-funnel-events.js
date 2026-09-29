import { funnelDefinitions, funnelHubId, hubRecordEligibility, sha256Hex } from './funnel-definitions.js';
import { funnelEventWrite } from './funnel-events.js';

// FUN-03: the field-execution and customer-portal funnel events. Each builder
// returns ONE create-only funnelEvents write (funnelEventWrite) that the caller
// adds to the SAME :commit as the business change, so a crew tap, portal
// approval, change-order answer, rebooking request, review click or credit
// redemption has its event exactly when the change itself is saved. Events are
// never inferred from a status afterwards. A private record (recordType, _egc_ or
// secure_) never has funnel events, so its builders return no write and the
// change saves as before.

const PROVIDER_ID = /^[A-Za-z0-9_-]{1,120}$/, ACTOR = /^[a-z0-9][a-z0-9_.@:+-]{0,119}$/, ROLE = /^[a-z][a-z_]{0,39}$/;
const PORTAL_KEY = /^[A-Za-z0-9_-]{8,120}$/, SOURCE_ID = /^[A-Za-z0-9_.:-]{1,180}$/, SLUG = /^[a-z][a-z0-9_]{0,39}$/;
const vocabulary = name => funnelDefinitions().vocabularies[name];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const recorded = job => hubRecordEligibility(job).exclusion !== 'private_record';
const hubRef = value => funnelHubId(value) ? value : undefined;
const providerRef = value => typeof value === 'string' && PROVIDER_ID.test(value) ? value : undefined;
export const vocabularyValue = (name, value) => vocabulary(name).includes(value) ? value : undefined;

/** The links an event about this job carries; an id the ledger cannot store is left out, never guessed. */
export function jobEventRefs(job) {
  return { jobId: job.id, projectId: hubRef(job.projectId), customerId: hubRef(job.customerId), businessAccountId: hubRef(job.businessAccountId), highlevelContactId: providerRef(job.highlevelContactId), highlevelOpportunityId: providerRef(job.highlevelOpportunityId) };
}

/** An actor id the ledger stores verbatim, or a stable pseudonymous digest of it. */
export function funnelActorId(value) {
  const id = String(value || '').trim().toLowerCase();
  return ACTOR.test(id) ? id : `sha256:${sha256Hex(`actor:${id}`).slice(0, 32)}`;
}

/** Cents of a saved dollar amount; unknown stays null, never 0. */
export function savedCents(value) {
  const text = typeof value === 'string' ? value.replace(/[^0-9.-]/g, '') : '', number = typeof value === 'number' ? value : /\d/.test(text) ? Number(text) : NaN;
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) : null;
}

// Crew status taps and closeout: the field status reached and its funnel event.
const FIELD_EVENTS = { dispatched: 'job.dispatched', arrived: 'job.arrived', started: 'job.started', completed: 'job.completed' };
export const fieldFunnelType = milestone => FIELD_EVENTS[milestone] || null;

/**
 * The job.dispatched/arrived/started/completed event of one field action.
 * The fieldEvents receipt (jobs/{jobId}/fieldEvents/{requestId}) is created in
 * the same commit, so the requestId key and the receipt both prove first
 * application; `now` is the server time of the action.
 */
export function fieldFunnelWrite(job, session, { requestId, type, fromStatus, toStatus }, now) {
  if (!recorded(job)) return null;
  const role = String(session?.role || '').toLowerCase(), data = {};
  if (SLUG.test(fromStatus || '')) data.fromStatus = fromStatus;
  if (SLUG.test(toStatus || '')) data.toStatus = toStatus;
  if (type === 'job.completed' && vocabularyValue('visitPurposes', job.visitPurpose)) data.visitPurpose = job.visitPurpose;
  return funnelEventWrite(null, now, {
    type, idempotencyKey: { kind: 'requestId', value: requestId }, ...jobEventRefs(job),
    actor: { id: funnelActorId(session?.user), kind: 'human', role: ROLE.test(role) ? role : null }, via: 'field',
    source: { collection: 'fieldEvents', id: requestId }, data, eligibility: { hub: job },
  });
}

/** The portal idempotency key: the page's request_id when the ledger can store it, else a stable digest of it. */
export function portalEventKey(value) {
  const text = String(value ?? '');
  return PORTAL_KEY.test(text) ? text : `portal-${sha256Hex(`portal:${text}`).slice(0, 40)}`;
}

/** Who acted in the portal: the link's customer, a family collaborator or a company member. */
export function portalActor(session) {
  const actorId = String(session?.actorId || '');
  if (!actorId) return { id: 'customer', kind: 'customer', role: 'customer' };
  return { id: funnelActorId(actorId), kind: 'customer', role: actorId.startsWith('biz_') ? 'business' : 'collaborator' };
}

// The saved record an event mirrors: '<jobId>:<field>[:<subId>]' (the §4.1
// sub-record convention), shortened to '<jobId>:<field>' or the job itself when
// the longer name would not fit.
function jobSource(jobId, field, subId) {
  const id = [[jobId, field, subId], [jobId, field]].map(parts => parts.filter(Boolean).join(':')).find(name => SOURCE_ID.test(name));
  return { collection: 'jobs', id: id || jobId };
}

/**
 * One portal event about `job` (the portal job the change applies to):
 * {type, key (portal request id), field/subId (the saved sub-record, on
 * sourceJobId when it lives on the account's root job), data}.
 * Server clock: the portal records when the customer acted, as the server saw it.
 */
export function portalFunnelWrite(job, session, { type, key, field = '', subId = '', sourceJobId = job.id, data = {} }, now) {
  if (!recorded(job)) return null;
  return funnelEventWrite(null, now, {
    type, idempotencyKey: { kind: 'portalRequest', value: portalEventKey(key) }, ...jobEventRefs(job),
    actor: portalActor(session), via: 'portal', source: jobSource(sourceJobId, field, subId), data, eligibility: { hub: job },
  });
}

// ---- Sales: the job's live sale (funnelSale) ----
// Every deal.sold writer saves, in the same :commit, the job's top-level
// `funnelSale` {jobId, cents, estimateRevision, key, eventId, soldAt}: the sale
// the ledger counts for this job now. The commit that retires it
// (deal.approval_superseded) clears or replaces it. It is server-owned: the
// Hub's browser writers (the legacy estimate editor and "Record approval"
// button, employee-suite.js) save named fields with set(merge) and never touch
// it, while they do rewrite customerApproval. So the ledger's sale is never
// inferred from customerApproval's status or source: a staff-recorded approval
// has no sale here until a sale writer records one, and a sale a browser
// revision superseded stays live until a server writer retires it.

const LEDGER_MAX_CENTS = 100000000;
const lower = value => String(value || '').toLowerCase();
const revisionOf = value => Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? value : null;
const supersededData = sale => ({ amountCents: sale.cents, ...(sale.estimateRevision !== null ? { estimateRevision: sale.estimateRevision } : {}) });

/**
 * The job's live sale {cents, estimateRevision, key, eventId} from its
 * funnelSale, or null. A funnelSale copied onto another job (a cloned visit)
 * names that other job and is not this job's sale.
 */
export function liveSale(job) {
  const sale = plain(job?.funnelSale) ? job.funnelSale : null;
  if (!sale || typeof job.id !== 'string' || !job.id || sale.jobId !== job.id || !Number.isSafeInteger(sale.cents) || sale.cents < 0 || sale.cents > LEDGER_MAX_CENTS) return null;
  return { cents: sale.cents, estimateRevision: revisionOf(sale.estimateRevision), key: typeof sale.key === 'string' ? sale.key : null, eventId: typeof sale.eventId === 'string' ? sale.eventId : null };
}

/**
 * The deal events that make a new signature the job's live sale, and the
 * funnelSale the same commit saves: {writes, funnelSale} (funnelSale undefined
 * when nothing is written). `soldData` is the deal.sold data (amountCents,
 * estimateRevision, ...); `event(type, data)` builds one of the writer's events
 * (its key, actor, via, source and clock). A live sale is retired first with
 * deal.approval_superseded, so net deal.sold minus superseded stays the
 * current contract. With keepSameTotal, a live sale at the same total is the
 * same sale (a re-signature) and nothing is written.
 */
export async function saleWrites(job, { soldData, keepSameTotal = false }, event) {
  if (!recorded(job)) return { writes: [], funnelSale: undefined };
  const live = liveSale(job);
  if (keepSameTotal && live && live.cents === soldData.amountCents) return { writes: [], funnelSale: undefined };
  const writes = live ? [await event('deal.approval_superseded', supersededData(live))] : [];
  const sold = await event('deal.sold', soldData);
  writes.push(sold);
  return { writes, funnelSale: { jobId: job.id, cents: sold.patch.data.amountCents, estimateRevision: revisionOf(soldData.estimateRevision), key: sold.patch.idempotencyKey, eventId: sold.id, soldAt: sold.patch.occurredAt } };
}

/**
 * The deal events of a portal estimate approval: {writes, funnelSale}. The
 * first signature is deal.sold at the approved total and revision. Re-signing
 * at the live sale's total (a double tap, a stale tab, a signature after a
 * staff-recorded approval of a sale already live, or after a handoff sale) is
 * not a second sale and writes nothing. A different total retires the live
 * sale first. Both name the approval request: '<jobId>:customerApproval:<key>'.
 */
export function portalApprovalWrites(job, session, { key, amountCents, estimateRevision }, now) {
  const source = { key, field: 'customerApproval', subId: portalEventKey(key) };
  const line = { serviceLine: vocabularyValue('serviceLines', job.serviceLine), funnelPath: vocabularyValue('funnelPaths', job.funnelPath) };
  return saleWrites(job, { soldData: { amountCents, estimateRevision, ...line }, keepSameTotal: true }, (type, data) => portalFunnelWrite(job, session, { type, ...source, data }, now));
}

/**
 * deal.approval_superseded for the live sale a Hub (M3) estimate revision
 * ends, written in the revision's own commit (server clock, the money
 * requestId as key, its moneyOperations receipt as source); the caller clears
 * funnelSale in that commit. null when no sale is live.
 */
export function moneySupersedeWrite(job, actor, { requestId, via, source }, now) {
  const live = recorded(job) ? liveSale(job) : null;
  if (!live) return null;
  const role = lower(actor?.role);
  return funnelEventWrite(null, now, {
    type: 'deal.approval_superseded', idempotencyKey: { kind: 'requestId', value: requestId }, ...jobEventRefs(job),
    actor: { id: funnelActorId(actor?.user), kind: 'human', role: ROLE.test(role) ? role : null }, via, source,
    data: supersededData(live), eligibility: { hub: job },
  });
}
