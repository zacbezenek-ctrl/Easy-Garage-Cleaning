import { firestoreFetch } from './firebase-service-account.js';
import { encodeFirestoreFields } from './firestore-job.js';
import { dispatchStorage } from './dispatch-storage.js';
import { funnelPaymentEventsEnabled } from './payment-events.js';
import { moneyInvoiceStateEnabled, moneyTotalsMode } from './money-core.js';

const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
const failure = (code, message, status = 503) => Object.assign(new Error(message), { code, status });

// Everything the money reads, lists, CSV exports and the ledger and change-order backfills need.
// A mask is mandatory: raw job bodies also carry signature images and private notes.
export const MONEY_JOB_FIELDS = Object.freeze(['type', 'recordType', 'customer', 'customerId', 'date', 'status', 'pipelineStatus', 'serviceType', 'scopeSummary', 'notify',
  'total', 'priceQuoted', 'lockedTotal', 'rate', 'estimate', 'customerApproval', 'quoteStatus', 'invoice', 'payment', 'deposit', 'approvedChangeTotal', 'customerDecisions', 'changeOrders',
  'giftWallet.redemptions', 'refunds', 'completedAt', 'postJobChecklist.completedAt', 'postJobProgress.standardItems', 'costs',
  'paymentLedger', 'paymentLedgerStatus', 'paymentLedgerIssues', 'paymentLedgerVersion', 'moneyRequestId', 'isTest', 'test', 'businessAccountId', 'customerAutomationEnabled']);

/**
 * Money store over the same Firestore REST contract as dispatchStorage:
 * rows carry revision = updateTime and commit(writes) applies every write or
 * none, each with currentDocument.updateTime (update), exists:false (create) or,
 * for a write marked exists:true, exists:true (a merge into a document that must exist).
 * Firestore reports a stale updateTime as FAILED_PRECONDITION (HTTP 400) and a
 * create collision as ALREADY_EXISTS (409); both mean nothing was applied, so
 * both are money_revision_conflict. A lost or unexplained response is
 * money_outcome_unknown: retry the same requestId, whose receipt is the proof.
 * A write's optional `remove` lists field paths (e.g. 'costs.labor') deleted in the same write, and its optional
 * `mask` lists the field paths it sets (e.g. ['costs.labor'], leaving the rest of costs as it is) in place of its
 * patch's top-level keys. A write with `delete: true` deletes the document under its revision precondition
 * (exists:true without one). A write with `delete: true, exists: false` and no revision is a precondition only
 * (FUN-33: the tipped booking's "no review yet"): a no-op while the document does not exist, and it fails the
 * whole commit (money_revision_conflict, nothing applied) once it does.
 * paymentEvents (FUNNEL_PAYMENT_EVENTS_ENABLED and MONEY_API_ENABLED) tells
 * mutateMoney to add the FUN-33 funnel events and paid-in-full fields to its
 * commit, and the money reads to add their FUN-33 fields. totalsMode is
 * MONEY_UNIFIED_TOTALS (money-core moneyTotalsMode): 'unified' makes the
 * money reads, lists and actions use money-core's unified totals. invoiceState is
 * MONEY_INVOICE_STATE_ENABLED (money-core moneyInvoiceStateEnabled): payments
 * never write an invoice that was not issued, and reads and lists apply its rules.
 */
export function moneyStorage(env, fetcher = firestoreFetch) {
  const base = dispatchStorage(env, fetcher);
  async function mapped(work, message) {
    try { return await work(); }
    catch (error) { throw failure(error?.code === 'dispatch_storage_incomplete' ? 'money_storage_incomplete' : 'money_storage_unavailable', message); }
  }
  return {
    paymentEvents: funnelPaymentEventsEnabled(env), totalsMode: moneyTotalsMode(env), invoiceState: moneyInvoiceStateEnabled(env),
    read: (collection, id) => mapped(() => base.read(collection, id), 'The job money record could not be loaded. Retry.'),
    // A caller that needs a few more job fields (tip allocation reads the assigned crew) names them; the mask still applies.
    jobs: (extra = []) => mapped(() => base.jobRecords([...new Set([...MONEY_JOB_FIELDS, ...extra])]), 'The complete job money records could not be loaded. Retry.'),
    // JOB-COST-PRIVACY: the private labor records, and each job's legacy labor copy for the backfill that moves it.
    laborRecords: () => mapped(() => base.jobLaborCosts(), 'The complete job labor costs could not be loaded. Retry.'),
    laborCopies: () => mapped(() => base.jobRecords(['type', 'recordType', 'costs.labor', 'costs.laborCents', 'costs.recordedAt', 'costs.recordedBy', 'laborCost']), 'The complete job records could not be loaded. Retry.'),
    async commit(writes) {
      let response;
      const body = JSON.stringify({ writes: writes.map(write => write.delete === true ? { delete: `${ROOT}/${write.collection}/${write.id}`, currentDocument: write.revision ? { updateTime: write.revision } : write.exists === false ? { exists: false } : { exists: true } } : {
        update: { name: `${ROOT}/${write.collection}/${write.id}`, fields: encodeFirestoreFields(write.patch) },
        updateMask: { fieldPaths: [...(write.mask || Object.keys(write.patch)), ...(write.remove || [])] },
        currentDocument: write.revision ? { updateTime: write.revision } : { exists: write.exists === true },
      }) });
      try { response = await fetcher(env, `${BASE}:commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(20000) }); }
      catch { throw failure('money_outcome_unknown', 'The save response was lost. Retry the same request to safely check whether it saved.'); }
      if (response.ok) return response.json().catch(() => ({}));
      const detail = await response.json().catch(() => null);
      if ([409, 412].includes(response.status) || response.status === 400 && detail?.error?.status === 'FAILED_PRECONDITION') throw failure('money_revision_conflict', 'This job changed while you were saving. Refresh and review the latest money details.', 409);
      throw failure('money_outcome_unknown', 'The save could not be verified. Retry the same request to safely check its outcome.');
    },
  };
}
