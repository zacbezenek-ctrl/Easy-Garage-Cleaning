// Prints the customer portal answers tests/browser/test_portal_rerender_ui.py routes to the page, all produced by the
// real handlers (functions/api/customer-portal.js) over the Firestore emulation in tests/helpers/portal-fixture.mjs.
// Time is fixed; nothing reads the clock and nothing leaves the process (Stripe is answered here, HighLevel is not configured).
import assert from 'node:assert/strict';
import { CHECKOUT_KINDS } from '../../functions/_lib/customer-payments.js';
import { decodeFirestoreFields, encodeFirestoreFields } from '../../functions/_lib/firestore-job.js';
import { NOW, env, portalCookie, portalHandlers, portalPost, portalStore, portalView } from '../helpers/portal-fixture.mjs';

const t = { mock: { method: (object, name, impl) => { object[name] = impl; } } };
const job = {
  id: 'job-1', type: 'job', status: 'scheduled', pipelineStatus: 'scheduled', customer: 'Synthetic Customer', phone: '970-555-0142', email: 'synthetic.customer@example.invalid',
  serviceType: 'Garage Turnaround', address: '100 Synthetic Way, Fort Collins', total: 900, priceQuoted: 900, date: '2026-09-29', time: '09:00', endTime: '12:00',
  estimate: { number: 'EST-0142', status: 'sent', amount: 900, depositRequired: 450, scope: 'Synthetic cleanout, sorting and haul-away.', validUntil: '2026-10-15', revision: 1, sentAt: '2026-09-21T16:00:00.000Z',
    lineItems: [{ id: 'cleanout', kind: 'service', name: 'Garage cleanout and reset', description: 'Sorting, hauling and disposal', quantity: 1, unitCents: 90000, totalCents: 90000 }] },
  // Everything a quiet refresh re-renders: saved property details, a job-day plan, a helper, a crew question, a gift card and a message.
  customerMemory: { accessInstructions: 'Side door code on file', parkingNotes: 'Driveway is fine', petNotes: 'One cat' },
  jobDayRules: { decisionMaker: 'Synthetic Customer', payer: 'Synthetic Customer', noResponseAction: 'pause' },
  customerCollaborators: [{ id: 'person-1', name: 'Synthetic Partner', email: 'partner@example.invalid', role: 'Spouse', status: 'active', permissions: { view: true, decide: true } }],
  customerDecisions: [{ id: 'd1', status: 'pending', title: 'Add a second shelf?', details: 'The crew found space for another shelf.', priceDelta: 120, promptedAt: '2026-09-22T17:40:00.000Z' }],
  giftWallet: { cards: [{ id: 'g1', label: 'Synthetic gift card', issuedAmount: 50, remainingAmount: 50 }] },
  customerConversation: [{ id: 'team-1', direction: 'to_customer', authorRole: 'team', authorName: 'Synthetic Office', body: 'Your estimate is ready to review.', createdAt: '2026-09-21T16:01:00.000Z', delivery: { channel: 'portal', status: 'sent', attemptedAt: '2026-09-21T16:01:00.000Z' } }],
};

const store = portalStore(t, { 'job-1': job }), jobs = globalThis.fetch;
// The server-only payment collections next to the jobs: the portal checkout ledger (customer_payment_checkouts) and
// payment_reviews, with create-only and updateTime preconditions and the runQuery the tips-on read makes. Both start empty.
const docs = new Map();
let docVersion = 0;
const docAnswer = (path, row) => Response.json({ name: `projects/egcw-1ec83/databases/(default)/documents/${path}`, fields: encodeFirestoreFields(row.value), updateTime: row.updateTime });
function serverOnly(path, url, options) {
  const row = docs.get(path), method = options.method || 'GET';
  if (method === 'GET') return row ? docAnswer(path, row) : Response.json({}, { status: 404 });
  assert.equal(method, 'PATCH', `Unexpected Firestore ${method} ${path}`);
  const create = url.searchParams.get('currentDocument.exists') === 'false', revision = url.searchParams.get('currentDocument.updateTime');
  if (create ? row : !row || revision !== row.updateTime) return Response.json({ error: { code: 400, status: 'FAILED_PRECONDITION' } }, { status: 400 });
  const next = { value: decodeFirestoreFields(JSON.parse(options.body).fields), updateTime: `2026-09-22T01:00:00.${String(++docVersion).padStart(6, '0')}Z` };
  docs.set(path, next);
  return docAnswer(path, next);
}
function runQuery(options) {
  const query = JSON.parse(options.body).structuredQuery, filter = query.where.fieldFilter, collection = query.from[0].collectionId;
  assert.equal(collection, 'payment_reviews'); assert.equal(filter.op, 'EQUAL');
  const rows = [...docs].filter(([path, row]) => path.startsWith(`${collection}/`) && row.value[filter.field.fieldPath] === filter.value.stringValue);
  return Response.json(rows.length ? rows.map(([path, row]) => ({ document: { name: `projects/egcw-1ec83/databases/(default)/documents/${path}`, fields: encodeFirestoreFields(row.value), updateTime: row.updateTime } })) : [{ readTime: NOW }]);
}

// Stripe Checkout as the handlers use it: a created session is read back by id, and an Idempotency-Key always names the same parameters.
const sessions = new Map(), keys = new Map();
let stripeDown = false;
function stripe(url, options = {}) {
  const method = options.method || 'GET';
  assert.match(options.headers?.Authorization || '', /^Basic /);
  if (stripeDown) return Response.json({ error: { message: 'Synthetic Stripe outage' } }, { status: 500 });
  if (url.pathname === '/v1/checkout/sessions' && method === 'POST') {
    const params = new URLSearchParams(options.body), key = options.headers['Idempotency-Key'];
    assert.ok(key, 'every checkout is created under an Idempotency-Key');
    if (keys.has(key)) { assert.equal(keys.get(key).params, params.toString(), 'a replayed key carries the same parameters'); return Response.json(sessions.get(keys.get(key).id)); }
    const id = sessions.size ? `cs_test_synthetic_portal_rerender_${sessions.size + 1}` : 'cs_test_synthetic_portal_rerender';
    sessions.set(id, { id, object: 'checkout.session', mode: params.get('mode'), status: 'open', payment_status: 'unpaid', currency: params.get('line_items[0][price_data][currency]'),
      amount_total: Number(params.get('line_items[0][price_data][unit_amount]')), client_reference_id: params.get('client_reference_id'), livemode: false, url: `https://checkout.stripe.com/c/pay/${id}`,
      metadata: Object.fromEntries([...params].filter(([name]) => name.startsWith('metadata[')).map(([name, value]) => [name.slice(9, -1), value])) });
    keys.set(key, { id, params: params.toString() });
    return Response.json(sessions.get(id));
  }
  const session = sessions.get(decodeURIComponent(url.pathname.split('/')[4] || ''));
  assert.ok(session && method === 'GET' && url.pathname.split('/').length === 5, `Unexpected Stripe request ${method} ${url.pathname}`);
  return Response.json(session);
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  if (url.hostname === 'api.stripe.com') return stripe(url, options);
  const path = decodeURIComponent(url.pathname.split('/databases/(default)/documents')[1] || '');
  if (url.hostname === 'firestore.googleapis.com' && path === ':runQuery') return runQuery(options);
  if (url.hostname === 'firestore.googleapis.com' && /^\/(customer_payment_checkouts|payment_reviews)\/[^/]+$/.test(path)) return serverOnly(path.slice(1), url, options);
  return jobs(input, options);
};
const cookie = await portalCookie('job-1'), handlers = portalHandlers(NOW), payEnv = { ...env, STRIPE_SECRET_KEY: 'sk_test_synthetic_portal_rerender' };
const tipEnv = { ...payEnv, CUSTOMER_TIPS_ENABLED: 'true' };

const pending = await portalView(handlers, cookie);
const shown = pending.body.estimate;
const approve = await portalPost(handlers, cookie, { action: 'approve_estimate', signed_name: 'Synthetic Customer', confirmed: true, terms_version: shown.termsVersion, estimate_revision: shown.revision,
  amount_cents: Math.round(shown.amount * 100), estimate_fingerprint: shown.fingerprint, request_id: '50000000-0000-4000-8000-000000000001' });
const approved = await portalView(handlers, cookie);
// The helper the customer shared the project with may view and decide, but not pay (permissions come from the saved list).
const partner = await portalView(handlers, await portalCookie('job-1', { actorId: 'person-1', permissions: { view: true, decide: true, pay: false, rebook: false } }));
assert.deepEqual([partner.body.viewer.owner, partner.body.viewer.permissions.pay], [false, false]);

// Pay opens a real portal checkout (the ledger is written before Stripe is called).
const created = await portalPost(handlers, cookie, { action: 'create_payment', request_id: 'portal-pay-synthetic-rerender' }, payEnv);
assert.equal(created.status, 200); assert.equal(created.body.amount, 450);
const session = [...sessions.keys()][0], checkout = sessions.get(session);
// The session is a portal checkout in every way but one: Stripe has not settled it (status 'open'). So verify_payment's 409 comes from that alone.
assert.deepEqual([checkout.metadata.kind, checkout.metadata.job_id, checkout.client_reference_id, checkout.amount_total, checkout.status], [CHECKOUT_KINDS.portal, 'job-1', 'job-1', 45000, 'open']);
const unsettled = await portalPost(handlers, cookie, { action: 'verify_payment', session_id: session }, payEnv);
assert.deepEqual([unsettled.status, unsettled.body], [409, { ok: false, error: 'Stripe has not verified this job payment' }]);
// While Stripe cannot be reached (502).
stripeDown = true;
const outage = await portalPost(handlers, cookie, { action: 'verify_payment', session_id: session }, payEnv);
stripeDown = false;

// The customer pays: Stripe completes the session with its charge and receipt, and verify_payment records it on the job.
Object.assign(checkout, { status: 'complete', payment_status: 'paid', url: null, customer_details: { email: job.email },
  payment_intent: { id: 'pi_synthetic_portal_rerender', latest_charge: { id: 'ch_synthetic_portal_rerender', receipt_url: 'https://pay.stripe.com/receipts/synthetic-portal-rerender' } } });
const verified = await portalPost(handlers, cookie, { action: 'verify_payment', session_id: session }, payEnv);
assert.deepEqual([verified.status, verified.body.paid, verified.body.duplicate, verified.body.amountPaid, verified.body.balance], [200, true, false, 450, 450]);
const paid = await portalView(handlers, cookie);
assert.deepEqual([paid.body.payment.paid, paid.body.payment.receiptUrl], [450, 'https://pay.stripe.com/receipts/synthetic-portal-rerender']);
// A later retry of the same return finds the charge already recorded.
const again = await portalPost(handlers, cookie, { action: 'verify_payment', session_id: session }, payEnv);
assert.deepEqual([again.status, again.body.duplicate], [200, true]);

// With tips on: the crew completes the job (the Hub closeout's write), so the $450 balance is due with an optional tip.
store.edit('job-1', { status: 'completed', pipelineStatus: 'completed', completedAt: NOW });
const tipDue = await portalView(handlers, cookie, tipEnv);
assert.deepEqual([tipDue.body.payment.purpose, tipDue.body.payment.dueNow, tipDue.body.payment.tip.available], ['balance', 450, true]);
// The customer applies the $50 gift card (from another device): the next answer's due is $400.
const credit = await portalPost(handlers, cookie, { action: 'apply_gift_credit', card_id: 'g1', amount: 50, request_id: 'credit-g1-synthetic-rerender' }, tipEnv);
assert.equal(credit.status, 200);
const credited = await portalView(handlers, cookie, tipEnv);
assert.deepEqual([credited.body.payment.dueNow, credited.body.payment.tip.available], [400, true]);

// The estimate revised and sent again before anything was approved (revision 2, $1,200): what a quiet refresh brings to a customer
// still reviewing revision 1. And the read of a browser whose session has ended.
store.put('job-1', { ...job, total: 1200, priceQuoted: 1200, estimate: { ...job.estimate, amount: 1200, depositRequired: 600, revision: 2, sentAt: '2026-09-22T17:30:00.000Z',
  lineItems: [{ ...job.estimate.lineItems[0], unitCents: 120000, totalCents: 120000 }] } });
const revised = await portalView(handlers, cookie), signedOut = await portalView(handlers, '');

// The portal read while Firestore cannot answer: what a failed 20-second refresh receives.
globalThis.fetch = async () => Response.json({}, { status: 500 });
const down = await portalView(handlers, cookie);

process.stdout.write(JSON.stringify({ pending, approve, approved, partner, created, unsettled, outage, verified, paid, again, tipDue, credit, credited, revised, signedOut, down, session }));
