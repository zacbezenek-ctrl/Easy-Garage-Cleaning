import { MAX_TOTAL_CENTS, PAYMENT_KINDS, paymentLedger } from './money-core.js';

/**
 * Stored payment ledger (job.paymentLedger[]). The recorded paid total
 * (payment.amount) stays authoritative for every existing reader; the ledger
 * itemizes it with the LI-CORE entry shape plus verified/source:
 *   {id, kind, amountCents, method, processor, processorRef, receiptUrl, at, by, verified, source}
 * Itemized entries are verified Stripe sessions, card tips and gift credits (derived by
 * money-core paymentLedger, the same evidence the revenue report trusts) and
 * payments recorded through the money API. Whatever the paid total holds that
 * no itemized entry explains (payments recorded before the ledger existed or
 * by the legacy browser tools) is ONE recomputed 'legacy:manual' aggregate,
 * written only when the evidence is clean. Stripe and gift credit writers
 * outside this module do not append entries, so their evidence is folded in
 * on read. Pure: no I/O and no clock.
 */
export const LEDGER_VERSION = 1;
export const LEDGER_SOURCES = Object.freeze(['stripe_session', 'stripe_tip', 'gift_credit', 'gift_credit_total', 'hub_offline', 'legacy_aggregate']);
export const LEGACY_ENTRY_ID = 'legacy:manual';
const EVIDENCE = new Set(['stripe_session', 'stripe_tip', 'gift_credit', 'gift_credit_total']);
const ID = /^[A-Za-z0-9_:.-]{1,200}$/, METHOD = /^[a-z][a-z0-9_]{0,39}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\r\n\t]/.test(value) ? value : null;
const signed = row => row.amountCents === null ? null : row.kind === 'refund' ? -row.amountCents : row.amountCents;
const total = rows => rows.reduce((sum, row) => sum === null || signed(row) === null ? null : sum + signed(row), 0);

/** A saved ledger row in canonical shape, or null when any field is unusable. */
export function storedEntry(row) {
  if (!plain(row) || !ID.test(row.id || '') || !PAYMENT_KINDS.includes(row.kind) || !LEDGER_SOURCES.includes(row.source)) return null;
  if (!Number.isSafeInteger(row.amountCents) || row.amountCents <= 0 || row.amountCents > MAX_TOTAL_CENTS || typeof row.method !== 'string' || !METHOD.test(row.method) || typeof row.verified !== 'boolean') return null;
  const at = row.at === null || row.at === undefined ? null : instant(row.at), by = text(row.by ?? '', 120);
  if (row.at !== null && row.at !== undefined && !at || by === null) return null;
  const processor = text(row.processor ?? '', 40), processorRef = text(row.processorRef ?? '', 180), receiptUrl = text(row.receiptUrl ?? '', 500);
  if (processor === null || processorRef === null || receiptUrl === null || receiptUrl && !/^https:\/\/pay\.stripe\.com\/receipts\//.test(receiptUrl)) return null;
  return { id: row.id, kind: row.kind, amountCents: row.amountCents, method: row.method, processor, processorRef, receiptUrl, at, by, verified: row.verified, source: row.source };
}

const fromEvidence = entry => ({ id: entry.id, kind: entry.kind, amountCents: entry.amountCents, method: entry.method, processor: entry.processor || '', processorRef: entry.processorRef || '', receiptUrl: entry.receiptUrl || '', at: entry.at, by: entry.by || '', verified: entry.verified === true, source: entry.source });

/** The recomputed aggregate for recorded money no itemized entry explains. */
export const legacyEntry = (job, amountCents) => ({ id: LEGACY_ENTRY_ID, kind: 'offline', amountCents, method: 'legacy_manual', processor: '', processorRef: '', receiptUrl: '', at: null, by: 'legacy', verified: job?.payment?.verified === true, source: 'legacy_aggregate' });

/**
 * Reconciles a job's stored ledger (plus `extra` new entries) against its
 * recorded paid total. `complete` means every recorded cent is itemized or in
 * the clean legacy aggregate. Issues use money_* codes; derived-evidence
 * problems (unverified card sessions, conflicting receipts, refunds) block the
 * aggregate so a card payment is never relabelled as a manual one.
 */
export function reconcileLedger(job, extra = []) {
  const derived = paymentLedger(job), issues = [...derived.issues], stored = job?.paymentLedger, itemized = new Map();
  if (stored !== undefined && stored !== null && !Array.isArray(stored)) issues.push('money_ledger_invalid');
  for (const raw of Array.isArray(stored) ? stored : []) {
    const row = storedEntry(raw);
    if (!row) { issues.push('money_ledger_entry_invalid'); continue; }
    if (row.source === 'legacy_aggregate') continue;
    if (itemized.has(row.id)) { issues.push('money_ledger_duplicate'); continue; }
    itemized.set(row.id, row);
  }
  for (const entry of derived.entries) {
    if (!EVIDENCE.has(entry.source)) continue;
    const saved = itemized.get(entry.id);
    if (!saved) itemized.set(entry.id, fromEvidence(entry));
    else if (saved.amountCents !== entry.amountCents) issues.push('money_ledger_conflict');
  }
  for (const row of extra) itemized.set(row.id, row);
  const rows = [...itemized.values()], itemizedCents = total(rows), paidCents = derived.paidCents, found = [...new Set(issues)];
  let entries = rows, legacyCents = 0;
  if (paidCents !== null && itemizedCents !== null && !found.length) {
    if (paidCents > itemizedCents) { legacyCents = paidCents - itemizedCents; entries = [...rows, legacyEntry(job, legacyCents)]; }
    else if (paidCents < itemizedCents) found.push('money_ledger_exceeds_paid');
  }
  entries = [...entries].sort((a, b) => (a.at === null) - (b.at === null) || String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
  const ledgerCents = total(entries), unreconciledCents = paidCents === null || ledgerCents === null ? null : paidCents - ledgerCents;
  return { entries, paidCents, itemizedCents, legacyCents, unreconciledCents, stored: Array.isArray(stored), complete: !found.length && unreconciledCents === 0, issues: found };
}

/** Fields that persist a reconciled ledger on the job. */
export const ledgerPatch = (ledger, now) => ({ paymentLedger: ledger.entries, paymentLedgerVersion: LEDGER_VERSION, paymentLedgerStatus: ledger.complete ? 'complete' : 'needs_review', paymentLedgerIssues: ledger.issues, paymentLedgerUpdatedAt: now });

// Payments a person recorded on the job by hand through the money API (Estimates & payments): the stored ledger's
// hub_offline entries. Card payments, gift credits, tips and the legacy aggregate are never among them.
const manualRows = job => (Array.isArray(job?.paymentLedger) ? job.paymentLedger : []).map(storedEntry).filter(row => row && row.source === 'hub_offline' && row.verified && row.kind !== 'tip');
/** Ids of the payments a person has recorded on this job by hand (hub_offline ledger entries), at most 200. */
export const manualEntryIds = job => [...new Set(manualRows(job).map(row => row.id))].slice(0, 200);
/**
 * Whole cents a person recorded on this job by hand (hub_offline ledger entries) at or after `since` (an ISO instant),
 * leaving out the entries named in `exclude` (ones the job already had then). Each entry counts once; a refund entry
 * counts against the total, which is never below 0. 0 when `since` cannot be read. Pure: no clock.
 */
export function manualCentsSince(job, since, exclude = []) {
  const from = instant(since);
  if (!from) return 0;
  const skip = new Set(Array.isArray(exclude) ? exclude.map(String) : []), seen = new Set();
  let cents = 0;
  for (const row of manualRows(job)) {
    if (seen.has(row.id) || skip.has(row.id) || !row.at || Date.parse(row.at) < Date.parse(from)) continue;
    seen.add(row.id); cents += signed(row);
  }
  return Math.max(0, cents);
}
