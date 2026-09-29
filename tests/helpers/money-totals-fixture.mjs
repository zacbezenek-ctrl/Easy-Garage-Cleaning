// FIX-MONEY-TOTALS fixtures: seven saved jobs (quote only, deposit paid, an approved change with its billed line, an
// approval without a line, overpaid, a tip on file, a business job) and the payment world the real handlers run in:
// portal-fixture's Firestore emulation for jobs, the server-only checkout ledger and payment reviews, and Stripe
// Checkout. Nothing leaves the process and nothing reads the clock (NOW is fixed).
import assert from 'node:assert/strict';
import { decodeFirestoreFields, encodeFirestoreFields } from '../../functions/_lib/firestore-job.js';
import { respondToDecision } from '../../functions/_lib/change-orders.js';
import { NOW, env as portalEnv, portalStore } from './portal-fixture.mjs';

export { NOW };
export const ORIGIN = 'https://easygaragecleaning.com';
const HUB = {
  HUB_SESSION_SECRET: 'synthetic-money-totals-hub-secret',
  HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { role: 'owner', displayName: 'Synthetic Owner', passwordHash: 'synthetic-hash' }, crew1: { role: 'crew', displayName: 'Synthetic Crew', passwordHash: 'synthetic-hash' } }),
};
export const OFF = { ...portalEnv, ...HUB, STRIPE_SECRET_KEY: 'sk_test_synthetic_money_totals', MONEY_DOCUMENT_ENABLED: 'true' };
export const UNIFIED = { ...OFF, MONEY_UNIFIED_TOTALS: 'true' };
export const SHADOW = { ...OFF, MONEY_UNIFIED_TOTALS: 'shadow' };

const APPROVED_AT = '2026-09-18T16:00:00.000Z';
const base = id => ({
  id, type: 'job', customer: 'Synthetic Customer', email: `${id}@example.invalid`, phone: '970-555-0142', address: '100 Synthetic Way, Fort Collins', serviceType: 'Garage Turnaround',
  date: '2026-09-22', time: '09:00', endTime: '13:00', status: 'scheduled', pipelineStatus: 'scheduled', total: 1000, priceQuoted: 1000, quoteStatus: 'approved',
  estimate: { number: `EST-${id.slice(-4).toUpperCase()}`, status: 'approved', amount: 1000, depositRequired: 500, revision: 1, scope: 'Synthetic garage reset scope.', validUntil: '2026-10-15', acceptedAt: APPROVED_AT, acceptedBy: 'Synthetic Customer',
    lineItems: [{ id: 'reset', kind: 'service', name: 'Synthetic garage reset', description: 'Sorting, hauling and a swept floor', quantity: 1, unitCents: 100000, totalCents: 100000 }] },
  customerApproval: { status: 'approved', approvedAt: APPROVED_AT, approvedBy: 'Synthetic Customer', amount: 1000, source: 'customer_portal' },
});
const card = (sessionId, amount, purpose, extra = {}) => ({ sessionId, paymentIntentId: sessionId.replace(/^cs_test_/, 'pi_'), amount, purpose, verifiedAt: '2026-09-18T16:05:00.000Z', ...extra });
const depositPaid = id => ({
  deposit: { amount: 500, paidAmount: 500, status: 'paid', verified: true },
  payment: { amount: 500, verified: true, method: 'stripe', processor: 'stripe', reference: `pi_${id}_deposit`, receiptUrl: `https://pay.stripe.com/receipts/${id}-deposit`, stripeSessions: [card(`cs_test_${id}_deposit`, 500, 'deposit')] },
});
const done = { status: 'completed', pipelineStatus: 'completed', completedAt: '2026-09-22T17:00:00.000Z' };
export const DECISION = { id: 'decision-freezer', title: 'Haul the old freezer', details: 'Synthetic crew note: it sits by the side door.', priceDelta: 150, status: 'pending', promptedAt: '2026-09-22T15:00:00.000Z' };

/** The seven saved jobs, keyed by fixture name (ids are the same names). */
export function moneyJobs() {
  const billedBefore = { ...base('billed-change'), ...depositPaid('billed'), status: 'in_progress', pipelineStatus: 'in_progress', customerDecisions: [DECISION] };
  // The customer approved the $150 change in the portal while billing was on (the line is the change-orders.js record).
  const billed = { ...billedBefore, ...respondToDecision(billedBefore, { decisionId: DECISION.id, response: 'approved', respondedBy: 'Synthetic Customer', note: '', requestId: 'synthetic-change-request-1', priceDeltaCents: 15000 }, { billing: true, now: '2026-09-22T16:00:00.000Z' }).patch, ...done };
  // The same approval recorded while CHANGE_ORDER_BILLING_ENABLED was off: approvedChangeTotal carries it, no line bills it.
  const unbilledBefore = { ...base('unbilled-change'), ...depositPaid('unbilled'), customerDecisions: [DECISION] };
  const unbilled = { ...unbilledBefore, ...respondToDecision(unbilledBefore, { decisionId: DECISION.id, response: 'approved', respondedBy: 'Synthetic Customer', note: '', requestId: 'synthetic-change-request-2' }, { billing: false, now: '2026-09-22T16:00:00.000Z' }).patch, ...done };
  return {
    'quote-only': base('quote-only'),
    'deposit-paid': { ...base('deposit-paid'), ...depositPaid('deposit') },
    'billed-change': billed,
    'unbilled-change': unbilled,
    overpaid: { ...base('overpaid'), ...done, status: 'paid', pipelineStatus: 'paid', payment: { amount: 1200, verified: true, method: 'check', recordedBy: 'zacb', reference: 'check-2001', lastAmount: 1200, lastReceivedAt: '2026-09-22T17:30:00.000Z' } },
    // $700 applied (the deposit and a $200 card payment) and a $50 tip beside it (payment.tips): $300 is still owed.
    'tip-present': { ...base('tip-present'), ...done, deposit: { amount: 500, paidAmount: 500, status: 'paid', verified: true },
      payment: { amount: 700, verified: true, method: 'stripe', processor: 'stripe', reference: 'pi_tip_partial', stripeSessions: [card('cs_test_tip_deposit', 500, 'deposit'), card('cs_test_tip_partial', 200, 'balance', { tipCents: 5000 })],
        tips: [{ sessionId: 'cs_test_tip_partial', paymentIntentId: 'pi_tip_partial', amountCents: 5000, amount: 50, source: 'customer_portal', recordedBy: 'stripe', verifiedAt: '2026-09-22T17:10:00.000Z' }] } },
    // A company project billed on terms: no deposit, an issued invoice, the whole total due.
    'business-job': { ...base('business-job'), ...done, businessAccountId: 'biz-synthetic-1', businessPropertyId: 'property-1', estimate: { ...base('business-job').estimate, depositRequired: 0 },
      invoice: { number: 'INV-B-0001', status: 'issued', amount: 1000, paid: 0, balance: 1000, dueDate: '2026-10-22', issuedAt: '2026-09-22T17:30:00.000Z', termsVersion: '2026-09' } },
  };
}

/**
 * The payment world over `jobs`: Firestore jobs (portal-fixture), the server-only customer_payment_checkouts and
 * payment_reviews documents and Stripe Checkout. stripe.created lists every session created with its line items.
 */
export function paymentWorld(t, jobs = moneyJobs()) {
  const store = portalStore(t, jobs), jobsFetch = globalThis.fetch;
  const docs = new Map(), sessions = new Map(), keys = new Map(), created = [];
  let version = 0;
  const answer = (path, row) => Response.json({ name: `projects/egcw-1ec83/databases/(default)/documents/${path}`, fields: encodeFirestoreFields(row.value), updateTime: row.updateTime });
  function serverOnly(path, url, options) {
    const row = docs.get(path), method = options.method || 'GET';
    if (method === 'GET') return row ? answer(path, row) : Response.json({}, { status: 404 });
    assert.equal(method, 'PATCH', `Unexpected Firestore ${method} ${path}`);
    const create = url.searchParams.get('currentDocument.exists') === 'false', revision = url.searchParams.get('currentDocument.updateTime');
    if (create ? row : !row || revision !== row.updateTime) return Response.json({ error: { code: 400, status: 'FAILED_PRECONDITION' } }, { status: 400 });
    const next = { value: decodeFirestoreFields(JSON.parse(options.body).fields), updateTime: `2026-09-22T02:00:00.${String(++version).padStart(6, '0')}Z` };
    docs.set(path, next);
    return answer(path, next);
  }
  function stripe(url, options = {}) {
    const method = options.method || 'GET';
    assert.match(options.headers?.Authorization || '', /^Basic /);
    if (url.pathname === '/v1/checkout/sessions' && method === 'POST') {
      const params = new URLSearchParams(options.body), key = options.headers['Idempotency-Key'];
      assert.ok(key, 'every checkout is created under an Idempotency-Key');
      if (keys.has(key)) { assert.equal(keys.get(key).params, params.toString(), 'a replayed key carries the same parameters'); return Response.json(sessions.get(keys.get(key).id)); }
      const id = `cs_test_synthetic_money_totals_${sessions.size + 1}`, unitAmount = Number(params.get('line_items[0][price_data][unit_amount]'));
      const session = { id, object: 'checkout.session', mode: params.get('mode'), status: 'open', payment_status: 'unpaid', client_reference_id: params.get('client_reference_id'), livemode: false, url: `https://checkout.stripe.com/c/pay/${id}`,
        amount_total: unitAmount + Number(params.get('line_items[1][price_data][unit_amount]') || 0), currency: 'usd',
        metadata: Object.fromEntries([...params].filter(([name]) => name.startsWith('metadata[')).map(([name, value]) => [name.slice(9, -1), value])) };
      sessions.set(id, session); keys.set(key, { id, params: params.toString() }); created.push({ id, unitAmount, kind: session.metadata.kind, jobId: session.metadata.job_id, params });
      return Response.json(session);
    }
    const session = sessions.get(decodeURIComponent(url.pathname.split('/')[4] || ''));
    assert.ok(session && method === 'GET', `Unexpected Stripe request ${method} ${url.pathname}`);
    return Response.json(session);
  }
  const route = async (input, options = {}) => {
    const url = new URL(input), path = decodeURIComponent(url.pathname.split('/databases/(default)/documents')[1] || '');
    if (url.hostname === 'api.stripe.com') return stripe(url, options);
    if (url.hostname === 'firestore.googleapis.com' && /^\/(customer_payment_checkouts|payment_reviews)\/[^/]+$/.test(path)) return serverOnly(path.slice(1), url, options);
    return jobsFetch(input, options);
  };
  if (t.mock?.method) t.mock.method(globalThis, 'fetch', route); else globalThis.fetch = route;
  return { store, docs, sessions, created, complete(id, charge) { Object.assign(sessions.get(id), { status: 'complete', payment_status: 'paid', url: null, payment_intent: { id: charge.paymentIntentId, latest_charge: { id: charge.chargeId, receipt_url: charge.receiptUrl } } }); } };
}
