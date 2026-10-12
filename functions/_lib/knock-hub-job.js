// "Create Hub job" from a door-to-door sale (Knock Admin > Sales, sale.handoff kind 'job', op 'create').
// It reuses the Hub's own server paths, the same ones a quote draft uses for an unscheduled job:
//   1. resolveCustomer (customer-resolution.js) finds the Hub customer by exact phone or email, or creates one.
//      It never duplicates a customer and refuses an ambiguous or conflicting match for a person to review.
//   2. mutateDispatch schedule.create (dispatch-service.js) creates ONE job with no date: it waits in Dispatch's
//      To schedule queue, flagged needsDispatchReview 'sold_schedule_later' (dispatch-queue.js), for a manager
//      to give it a time and a crew. Notify customer is off, nothing is synced to HighLevel (no date, so no
//      appointment and syncStatus 'not_needed') and no HighLevel tag or crew notice is queued.
// The request ids are derived from the sale id, so the job id is fixed per sale (dispatch_<id>): a double tap, a
// retry after a lost response or a second admin can never create a second job. A knock_receipts claim
// (job_<saleId>) tells a concurrent request that one is already running, and the sale records
// handoff.job = {mode:'hub', status:'created', ref, customerId, at, by} in the same commit that closes the claim.
// Nothing here sends anything, and no customer detail is ever logged.
import { knockFailure, write } from './knock-store.js';
import { loadSettings, requireAdmin } from './knock-access.js';
import { dispatchStorage } from './dispatch-storage.js';
import { resolveCustomer } from './customer-resolution.js';
import { mutateDispatch } from './dispatch-service.js';
import { dispatchReviewPatch } from './dispatch-queue.js';
import { stripCrewMoney } from './crew-money.js';

export const LEAD_SOURCE = 'door_to_door';
// A claim older than this is treated as an attempt that died (a Pages Function never runs this long).
const CLAIM_STALE_MS = 120000;
const SAFE_JOB_ID = /^[A-Za-z0-9_-]{1,180}$/;
const CLOSED = new Set(['cancelled', 'canceled', 'completed', 'invoiced', 'paid', 'review_requested', 'closed', 'noshow', 'no_show', 'no-show']);
const REVIEW_CUSTOMER = new Set(['ambiguous_customer', 'contact_conflict', 'ambiguous_provider', 'provider_link_conflict', 'idempotency_conflict', 'changed_since_operation', 'customer_changed', 'invalid_customer_id']);

const money = value => `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: Number(value) % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const titleStreet = street => String(street || '').trim().split(/\s+/).map(w => /^(N|S|E|W|NE|NW|SE|SW)$/.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
const hexOf = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');

/* A request id fixed by the sale: UUID-shaped (version 8) from a namespaced SHA-256. */
export async function saleRequestId(kind, saleId) {
  const hex = await hexOf(`egc-knock-hub-${kind}:${saleId}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/* The service address as the Hub stores it: number, street, unit and the neighborhood's town. */
export function serviceAddress(sale, neighborhood, settings) {
  const a = sale.address || {};
  const line = [a.number, titleStreet(a.street)].filter(Boolean).join(' ') + (a.unit ? ` #${a.unit}` : '');
  const town = settings?.cities?.[neighborhood?.cityKey]?.name || '';
  return town ? `${line}, ${town}, CO` : line;
}

const depositState = sale => {
  const d = sale.handoff?.deposit || {};
  return d.status === 'collected' ? `collected${d.collectedAmount != null ? ` (${money(d.collectedAmount)})` : ''}` : d.url ? 'Stripe link sent, not paid yet' : 'not collected';
};

/* The internal note Dispatch shows the manager. It names no phone or email. */
export function internalNote(sale, repName) {
  return [
    `Door-to-door sale by ${repName} on ${sale.saleDate}; right-to-cancel deadline ${sale.cancelDeadlineDate} (midnight); knock sale ${sale.id}.`,
    `Requested job date ${sale.jobDate}${sale.jobStartTime ? ` at ${sale.jobStartTime}` : ''}. Needs a time and a crew from a manager.`,
    `${sale.package}, quoted ${money(sale.ticket)}. ${Math.round(Number(sale.depositRate || 0.2) * 100)}% deposit ${money(sale.depositAmount)}: ${depositState(sale)} (recorded in Knock, not in the Hub ledger).`,
    'Notify customer is off: turn it on when booking only if the customer should get reminders.',
  ].join('\n');
}

// Dependency errors in canvassing terms. A customer the Hub cannot match safely needs a person; anything else may be retried.
function failure(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('knock_')) return error;
  const code = String(error?.code || '');
  if (code.startsWith('customer_resolve_')) {
    const reason = code.slice('customer_resolve_'.length);
    if (REVIEW_CUSTOMER.has(reason)) return knockFailure(`${error.message} Check the customer in the Hub, then create the job in Dispatch and record it here by hand.`, 409, 'knock_hub_customer_review');
    if (Number(error.status) === 400) return knockFailure(`The sale's customer details are not enough for the Hub: ${error.message}`, 400, 'knock_hub_customer_invalid');
    return knockFailure('The Hub customer could not be checked. Nothing was created; try again in a minute.', 503, 'knock_hub_unavailable');
  }
  if (code.startsWith('dispatch_')) {
    const retry = !error.status || Number(error.status) >= 500;
    return knockFailure(retry ? 'The Hub job could not be confirmed. Try again; it will never create a second job.' : `The Hub refused the job: ${error.message} Create it in Dispatch and record it here by hand.`, retry ? 503 : 409, retry ? 'knock_hub_unavailable' : 'knock_hub_job_refused');
  }
  return knockFailure('The Hub job could not be confirmed. Try again; it will never create a second job.', 503, 'knock_hub_unavailable');
}

const created = ({ __updateTime, ...sale }, job, wasCreated) => ({ sale, hubJob: { id: job.ref, customerId: job.customerId || '', created: wasCreated } });

/* Records the created job on the sale and closes the claim, in one commit. A sale that changed meanwhile is re-read. */
async function record(store, saleId, receiptId, { jobId, customerId, by, nowIso }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const sale = await store.get('knock_sales', saleId);
    if (!sale) throw knockFailure('That sale was not found.', 404, 'knock_sale_missing');
    const handoff = structuredClone(sale.handoff || {});
    handoff.job = { ...handoff.job, mode: 'hub', status: 'created', ref: jobId, customerId, at: handoff.job?.ref === jobId && handoff.job?.at ? handoff.job.at : nowIso, by: handoff.job?.ref === jobId && handoff.job?.by ? handoff.job.by : by };
    try {
      await store.commit([
        write.patch('knock_receipts', receiptId, { outcome: 'created', jobId, customerId, error: '', updatedAt: nowIso }),
        write.patch('knock_sales', sale.id, { handoff, updatedAt: nowIso }, sale.__updateTime),
      ]);
      return { ...sale, handoff, updatedAt: nowIso };
    } catch (error) {
      if (error.code !== 'knock_conflict') throw error;
    }
  }
  throw knockFailure('The Hub job was created, but the sale kept changing while it was recorded. Refresh; it shows once the sale settles.', 409, 'knock_conflict');
}

/* kind 'job', op 'create'. `sale` is the stored sale (not cancelled; runHandoff checked). Returns {sale, hubJob}. */
export async function createHubJob(store, admin, sale, nowIso, env, { dispatchStore = null } = {}) {
  requireAdmin(admin);
  const job = sale.handoff?.job || {};
  if (job.status === 'created' && job.mode === 'hub' && job.ref) return created(sale, job, false);
  if (job.status === 'created') throw knockFailure(`A job is already recorded for this sale${job.ref ? ` (${job.ref})` : ''}. Update that reference instead.`, 409, 'knock_job_already_recorded');
  const receiptId = `job_${sale.id}`;
  const receipt = await store.get('knock_receipts', receiptId);
  if (receipt?.outcome === 'created' && receipt.jobId) {
    const saved = await record(store, sale.id, receiptId, { jobId: receipt.jobId, customerId: receipt.customerId || '', by: receipt.by || admin.user, nowIso });
    return created(saved, saved.handoff.job, false);
  }
  const running = receipt?.outcome === 'creating' && Date.parse(nowIso) - Date.parse(receipt.updatedAt || 0) < CLAIM_STALE_MS;
  if (running) throw knockFailure('A Hub job is already being created for this sale. Refresh in a moment.', 409, 'knock_job_in_progress');
  // Claim before touching the Hub: only one request at a time works on a sale's job.
  const attempts = Number(receipt?.attempts || 0) + 1;
  try {
    await store.commit([receipt
      ? write.patch('knock_receipts', receiptId, { outcome: 'creating', attempts, error: '', updatedAt: nowIso, by: admin.user }, receipt.__updateTime)
      : write.create('knock_receipts', receiptId, { kind: 'sale_hub_job', saleId: sale.id, outcome: 'creating', attempts, jobId: '', customerId: '', error: '', createdAt: nowIso, updatedAt: nowIso, by: admin.user })]);
  } catch (error) {
    if (['knock_exists', 'knock_conflict'].includes(error.code)) throw knockFailure('A Hub job is already being created for this sale. Refresh in a moment.', 409, 'knock_job_in_progress');
    throw error;
  }
  const hub = dispatchStore || dispatchStorage(env);
  try {
    const [customerRequestId, jobRequestId, settings, neighborhood, rep] = await Promise.all([
      saleRequestId('customer', sale.id), saleRequestId('job', sale.id), loadSettings(store),
      sale.neighborhoodId ? store.get('knock_neighborhoods', sale.neighborhoodId).catch(() => null) : null,
      sale.repKey ? store.get('knock_reps', sale.repKey).catch(() => null) : null,
    ]);
    const address = serviceAddress(sale, neighborhood, settings);
    const authorize = session => { requireAdmin(session); return { dispatcher: true }; };

    // 1. The Hub customer. An earlier attempt (by any admin) that saved it is reused as it was saved.
    const customerReceipt = await hub.read('customerOperations', customerRequestId.toLowerCase());
    let customerId = customerReceipt?.customerId || '';
    if (!customerId) {
      const resolved = await resolveCustomer(hub, admin, { requestId: customerRequestId, customer: { name: sale.customer.name, phone: sale.customer.phone, email: sale.customer.email, address } }, { now: nowIso, authorize });
      customerId = resolved.customer.id;
    }

    // 2. One unscheduled job. Its id comes from the request id, so it can only ever be created once.
    const jobReceipt = await hub.read('dispatchOperations', jobRequestId.toLowerCase());
    let jobId = jobReceipt?.collection === 'jobs' ? jobReceipt.targetId : '';
    if (!jobId) {
      const repName = rep?.displayName || sale.repKey || 'a rep';
      const changes = {
        title: `${sale.package} (door-to-door sale)`, serviceType: sale.package, address,
        jobInstructions: stripCrewMoney(`${sale.package}, sold door to door. The customer asked for ${sale.jobDate}. Scope to be confirmed by the office.`),
        opsNotes: internalNote(sale, repName), notify: false,
      };
      const input = { action: 'schedule.create', requestId: jobRequestId, customerId, kind: 'job', changes };
      const extra = {
        leadSource: LEAD_SOURCE, preferredDate: sale.jobDate, preferredTime: sale.jobStartTime || '', customerAutomationEnabled: false,
        total: Number(sale.ticket), priceQuoted: Number(sale.ticket), deposit: { amount: Number(sale.depositAmount) },
        knockSale: {
          saleId: sale.id, repKey: sale.repKey || '', repName, soldAt: sale.soldAt, saleDate: sale.saleDate, cancelDeadlineDate: sale.cancelDeadlineDate, cancelEndsAt: sale.cancelEndsAt,
          requestedJobDate: sale.jobDate, requestedStartTime: sale.jobStartTime || '', package: sale.package, ticket: Number(sale.ticket),
          depositRate: Number(sale.depositRate), depositAmount: Number(sale.depositAmount), depositStatus: sale.handoff?.deposit?.status || 'pending',
          depositCollectedAmount: sale.handoff?.deposit?.collectedAmount ?? null, recordedAt: nowIso, recordedBy: admin.user,
        },
        ...dispatchReviewPatch('sold_schedule_later', nowIso),
      };
      // The job write carries the sale's facts in the same commit (as a quote draft adds its estimate). No HighLevel
      // tag and no crew notice: an undated job queues neither, and they are switched off here so it stays that way.
      const adapter = { ...hub, ghlTagOutbox: false, crewNotificationsEnabled: false,
        commit: async writes => {
          const target = writes.find(item => item.collection === 'jobs' && item.patch?.dispatchRequestId === jobRequestId);
          if (!target) throw Object.assign(new Error('The complete Hub job could not be prepared.'), { code: 'dispatch_outcome_unknown', status: 503 });
          Object.assign(target.patch, extra);
          return hub.commit(writes);
        } };
      const result = await mutateDispatch(adapter, admin, input, nowIso, { authorize, enforce: () => false });
      jobId = result.job.id;
    }
    const saved = await record(store, sale.id, receiptId, { jobId, customerId, by: admin.user, nowIso });
    return created(saved, saved.handoff.job, true);
  } catch (error) {
    const reported = failure(error);
    // Nothing is lost by freeing the claim: a retry finds whatever was saved through the fixed request ids.
    await store.commit([write.patch('knock_receipts', receiptId, { outcome: 'failed', error: reported.message.slice(0, 300), updatedAt: nowIso })]).catch(() => null);
    throw reported;
  }
}

const hubRef = sale => {
  const job = sale?.handoff?.job;
  return job?.mode === 'hub' && job.status === 'created' && SAFE_JOB_ID.test(String(job.ref || '')) && !/^(secure_|_egc_)/.test(job.ref) ? job.ref : '';
};
export const openHubJobMessage = ref => `Hub job ${ref} still open — cancel it in Dispatch`;

/* Cancelled sales whose Hub job is still open: Map saleId -> {code, jobId, message}. The Hub job is never cancelled
   from here. A job that cannot be read is reported as open, so the warning is never lost. */
export async function openHubJobWarnings(sales, dispatchStore) {
  const pending = sales.filter(sale => sale.status === 'cancelled' && hubRef(sale));
  const warnings = new Map();
  if (!pending.length) return warnings;
  let found = null;
  try { found = new Map((await dispatchStore.readMany('jobs', [...new Set(pending.map(hubRef))], ['status', 'pipelineStatus'])).map(row => [row.id, row])); } catch { found = null; }
  for (const sale of pending) {
    const ref = hubRef(sale), job = found?.get(ref);
    if (found && (!job || CLOSED.has(String(job.pipelineStatus || job.status || '').toLowerCase()))) continue;
    warnings.set(sale.id, { code: 'knock_hub_job_open', jobId: ref, message: openHubJobMessage(ref) });
  }
  return warnings;
}
