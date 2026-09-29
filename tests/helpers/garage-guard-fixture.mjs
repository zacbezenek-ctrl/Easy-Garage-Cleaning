import assert from 'node:assert/strict';
import { applyGarageGuardEvent, garageGuardEvent } from '../../functions/_lib/garage-guard-membership.js';
import { garageGuardBilling, garageGuardLedgerStore } from '../../functions/_lib/garage-guard-ledger.js';

// Synthetic Garage Guard fixtures shared by the FUN-20 ledger and visit tests.
export const NOW = '2026-09-22T12:00:00.000Z';
export const T0 = Math.floor(Date.parse(NOW) / 1000);
export const YEAR = 365 * 86400;
export const conflict = () => Object.assign(new Error('Synthetic revision conflict'), { code: 'dispatch_revision_conflict', status: 409 });
export const unknown = () => Object.assign(new Error('Synthetic unknown outcome'), { code: 'dispatch_outcome_unknown', status: 503 });
export const at = seconds => new Date(seconds * 1000).toISOString();

export const account = () => ({
  'customerIdentityState/revision': { updatedAt: '2026-09-01T12:00:00.000Z', lastRequestId: 'synthetic-resolve' },
  'customers/cust-dana': { name: 'Synthetic Dana', phone: '(970) 555-0101', email: 'dana@example.invalid' },
  'customers/cust-other': { name: 'Synthetic Other', phone: '970-555-0199', email: 'other@example.invalid' },
  'jobs/job-root': { type: 'job', customerId: 'cust-dana', customer: 'Synthetic Dana', address: '1 Synthetic Way', status: 'paid', garageGuard: { nextVisit: '2026-10-05' } },
  'jobs/job-visit-1': { type: 'job', customerId: 'cust-dana', customerAccountOwnerJobId: 'job-root', customer: 'Synthetic Dana', projectId: 'project_job-visit-1', date: '2026-10-05', status: 'scheduled' },
  'jobs/job-other': { type: 'job', customerId: 'cust-other', customer: 'Synthetic Other', status: 'completed', completedAt: '2026-09-21T18:00:00.000Z' },
});

/** An in-memory Firestore stand-in: revisions per write, create-only and revision preconditions, read-only verify fences. */
export function memoryStore(seed = account()) {
  const rows = new Map(), commits = [], verified = [], visitReads = []; let revision = 0, failures = [], loseResponse = null, races = [], commitIndex = 0;
  const stamp = () => `2026-09-22T00:00:00.${String(++revision).padStart(6, '0')}Z`;
  const put = (path, value) => rows.set(path, { value: structuredClone(value), revision: stamp() });
  for (const [path, value] of Object.entries(seed)) put(path, value);
  const out = (path, row) => ({ ...structuredClone(row.value), id: path.split('/')[1], revision: row.revision });
  const collection = name => [...rows].filter(([path]) => path.startsWith(`${name}/`)).map(([path, row]) => out(path, row));
  return {
    rows, commits, verified, visitReads, put, collection,
    get: path => rows.has(path) ? structuredClone(rows.get(path).value) : null,
    revisionOf: path => rows.get(path)?.revision || null,
    failNextCommit: (...errors) => { failures = errors; },
    raceNextCommit: (...changes) => { races = changes; },
    loseNextResponse: (skip = 0) => { loseResponse = commitIndex + skip; },
    async read(name, id) { const path = `${name}/${id}`; return rows.has(path) ? out(path, rows.get(path)) : null; },
    async readMany(name, ids) { return ids.map(id => `${name}/${id}`).filter(path => rows.has(path)).map(path => out(path, rows.get(path))); },
    async customers() { return collection('customers'); },
    async customerJobs(customerId, limit) { return collection('jobs').filter(job => job.customerId === customerId).slice(0, limit); },
    async list(name) { return { rows: collection(name), complete: true }; },
    async memberVisits() { return { rows: collection('jobs').filter(job => job.membershipId), complete: true }; },
    // membershipStorage.membershipVisits: the webhook reads a membership's member-visit jobs when a billing period closes.
    async membershipVisits(membershipId) { visitReads.push(membershipId); return { rows: collection('jobs').filter(job => job.membershipId === membershipId), complete: true }; },
    async commit(writes) {
      const index = commitIndex++, race = races.shift(), failure = failures.shift();
      if (race) race();
      if (failure) throw failure;
      const paths = writes.map(write => `${write.collection}/${write.id}`);
      assert.equal(new Set(paths).size, paths.length, 'a commit never writes or verifies the same document twice');
      for (const [position, write] of writes.entries()) { const row = rows.get(paths[position]); if (write.verify ? !write.revision || row?.revision !== write.revision : write.revision ? row?.revision !== write.revision : row) throw conflict(); }
      for (const [position, write] of writes.entries()) if (!write.verify) rows.set(paths[position], { value: { ...(rows.get(paths[position])?.value || {}), ...structuredClone(write.patch) }, revision: stamp() });
      commits.push(paths.filter((_, position) => !writes[position].verify)); verified.push(paths.filter((_, position) => writes[position].verify));
      if (loseResponse === index) { loseResponse = null; throw unknown(); }
    },
  };
}

export const checkoutEvent = ({ id = 'evt_guard_checkout', type = 'checkout.session.completed', created = T0, subscription = 'sub_member_1', plan = 'guard', paymentStatus = 'paid', amountTotal = 80000, amountSubtotal = 90000, discount = 10000, livemode = false } = {}) => ({ id, type, created, livemode, data: { object: {
  id: 'cs_test_guard_member_1', object: 'checkout.session', mode: 'subscription', status: 'complete', payment_status: paymentStatus, subscription, customer: 'cus_member_1', invoice: 'in_guard_first',
  amount_total: amountTotal, amount_subtotal: amountSubtotal, currency: 'usd', total_details: { amount_discount: discount, amount_shipping: 0, amount_tax: 0 },
  discounts: [{ coupon: 'SYNTHETICTENOFF', promotion_code: 'promo_synthetic_ten' }], metadata: { plan },
  customer_details: { email: 'dana@example.invalid', phone: '+1 970 555 0101', name: 'Synthetic Dana' }, custom_fields: [{ key: 'service_address', text: { value: '1 Synthetic Way, Fort Collins' } }] } } });

export const invoiceEvent = ({ id, type = 'invoice.paid', created = T0 + 60, subscription = 'sub_member_1', plan = 'guard', reason = 'subscription_cycle', periodEnd = T0 + YEAR, invoice = 'in_guard_first', paid = 80000, total = 80000, due = 80000, discount = 10000, paidAt, attempt = 1, nextAttempt = null, livemode = false } = {}) => ({ id, type, created, livemode, data: { object: {
  id: invoice, object: 'invoice', billing_reason: reason, customer: 'cus_member_1', customer_email: 'dana@example.invalid', subscription, subscription_details: { metadata: { plan } }, currency: 'usd',
  amount_paid: paid, total, subtotal: total + discount, amount_due: due, total_discount_amounts: discount ? [{ amount: discount, discount: 'di_synthetic' }] : [], discount: discount ? { coupon: { id: 'SYNTHETICTENOFF' }, promotion_code: 'promo_synthetic_ten' } : null,
  status_transitions: { paid_at: type === 'invoice.paid' ? (paidAt ?? created) : null }, attempt_count: attempt, next_payment_attempt: nextAttempt,
  lines: { data: [{ type: 'subscription', subscription, period: { start: periodEnd - YEAR, end: periodEnd }, metadata: { plan } }] } } } });

export const deletedEvent = ({ id = 'evt_guard_deleted', created = T0 + 7200, subscription = 'sub_member_1', plan = 'guard', reason = 'cancellation_requested', feedback = 'unused', livemode = false } = {}) => ({ id, type: 'customer.subscription.deleted', created, livemode, data: { object: {
  id: subscription, object: 'subscription', customer: 'cus_member_1', status: 'canceled', metadata: plan ? { plan } : {}, canceled_at: created, ended_at: created,
  cancellation_details: reason ? { reason, feedback, comment: 'Synthetic free text that is never stored' } : undefined } } });

/**
 * Applies one Stripe event the way the webhook does: through the ledger store, with the injected clock. visitTracking stands for
 * GARAGE_GUARD_VISIT_TRACKING_ENABLED on the webhook request (on here, as in a deployment that counts member visits).
 */
export const webhookApply = (store, event, now = NOW, { visitTracking = true } = {}) => { const input = garageGuardEvent(event); return applyGarageGuardEvent(garageGuardLedgerStore(store, input, garageGuardBilling(event), now, { visitTracking }), input, { now, alerts: false }); };

/** A member, linked and mirrored, with one paid period of `paid` cents from `created` (Stripe test mode unless livemode). */
export async function member(store = memoryStore(), { paid = 80000, plan = 'guard', created = T0, livemode = false, visitTracking = true } = {}) {
  await webhookApply(store, checkoutEvent({ plan, created, amountTotal: paid, livemode }), NOW, { visitTracking });
  await webhookApply(store, invoiceEvent({ id: 'evt_guard_first_invoice', reason: 'subscription_create', created: created + 5, plan, paid, total: paid, due: paid, periodEnd: created + YEAR, livemode }), NOW, { visitTracking });
  return store;
}

export const completeVisit = (store, id = 'job-visit-1', completedAt = '2026-10-05T18:00:00.000Z', extra = {}) => store.put(`jobs/${id}`, { ...store.get(`jobs/${id}`), membershipId: 'sub_member_1', visitPurpose: 'member_visit', status: 'completed', pipelineStatus: 'completed', completedAt, ...extra });
