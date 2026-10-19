// Gaps left by the owner decisions of 2026-10-18 (D-JUNK, D-DEPOSIT) on the surfaces customers and the crew read: the
// portal's withheld estimate, Stripe Checkout, the service label, the crew brief's materials and the public payment copy.
// Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { encodeFirestoreFields, decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { CUSTOMER_PORTAL_CONTENT, CUSTOMER_PORTAL_TERMS_VERSION } from '../functions/_lib/customer-portal-content.js';
import { FINAL_25_75, SENT_25_75, SIGNED_25_75, paymentDateLabel, quotePaymentDates, withheldQuotePaymentSummary } from '../functions/_lib/quote-payment-policy.js';
import { junkOnlyGarageWork, unsentQuoteDraft, walkthroughGarageWork } from '../functions/_lib/quote-model.js';
import { saveWalkthroughHandoff, walkthroughGarageWork as handoffGarageWork } from '../functions/_lib/walkthrough-handoff.js';
import { priceCompositeQuote } from '../functions/_lib/composite-quote.js';
import { moneyDocumentModel } from '../functions/_lib/money-document.js';
import { salesExitService } from '../functions/_lib/sales-followup-exit.js';
import { signedGarageHandoff } from '../functions/_lib/knock-setters.js';
import { accountView } from '../functions/_lib/business-hub-core.js';
import { applyFirestoreCommit } from './helpers/firestore-commit.mjs';
import { env, portalCookie, portalHandlers, portalPost, portalStore, portalView } from './helpers/portal-fixture.mjs';
import { NOW as SIGNED_AT, ON_ENV, SHELF, TOTES, builderState, fixture, menu, menuItem, owner, signedPlan } from './helpers/estimator-fixture.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// A walkthrough signed on the current terms (walkthrough-handoff.js financePatch): $2,495.90, 25% due the signing day,
// 75% on the job day, Tuesday 2026-10-20.
const signedJob = (extra = {}, estimate = {}) => ({
  type: 'job', customer: 'Synthetic Customer', customerId: 'customer-1', email: 'synthetic@example.invalid', address: '100 Synthetic Street', serviceType: 'Garage transformation',
  total: 2495.9, priceQuoted: 2495.9, status: 'scheduled', date: '2026-10-20', time: '08:00', endTime: '15:00', quoteStatus: 'approved', termsVersion: SIGNED_25_75.version,
  customerApproval: { status: 'approved', approvedAt: '2026-10-19T16:00:00.000Z', approvedBy: 'Synthetic Customer', amount: 2495.9, source: 'in_person_signature' },
  estimate: { number: 'EST-SYN1', revision: 1, status: 'accepted', amount: 2495.9, depositRequired: 623.98, acceptedAt: '2026-10-19T16:00:00.000Z', acceptedBy: 'Synthetic Customer', acceptanceMethod: 'in_person_signature',
    termsVersion: SIGNED_25_75.version, source: 'walkthrough', scope: 'Removal / cleanout: Two-car garage base. Labor.', amountCents: 249590, depositRequiredCents: 62398, depositPct: 25, commercialPolicy: { ...SIGNED_25_75 },
    paymentSchedule: { depositCents: 62398, remainderCents: 187192, depositDueDate: '2026-10-19', remainderDueDate: '2026-10-20', timeZone: 'America/Denver', policyVersion: SIGNED_25_75.version }, ...estimate },
  deposit: { amount: 623.98, paidAmount: 0, status: 'due' },
  ...extra,
});
// Booked with draft prices the owner has not approved (walkthrough-handoff.js builderPatch): every customer surface withholds it.
const HELD = { pricesPendingApproval: { status: 'pending', reason: 'draft_prices', at: '2026-10-19T16:00:00.000Z', by: 'sales.person', requestId: 'r1', items: [{ id: 'egc-003', name: 'Two-car garage base' }] } };
// The same job signed before D-DEPOSIT (2026-09-deposit50): no commercial policy, no schedule.
const legacyJob = (extra = {}) => { const job = signedJob(extra, { termsVersion: '2026-09-deposit50', depositRequired: 1247.95, depositRequiredCents: 124795, depositPct: 50 }); delete job.estimate.commercialPolicy; delete job.estimate.paymentSchedule; job.deposit.amount = 1247.95; return job; };
const PAID = { deposit: { amount: 623.98, paidAmount: 623.98, status: 'paid', verified: true }, payment: { amount: 623.98, verified: true, method: 'stripe', processor: 'stripe', stripeSessions: [{ sessionId: 'cs_paid', paymentIntentId: 'pi_paid', amount: 623.98, purpose: 'deposit', verifiedAt: '2026-10-19T16:05:00.000Z' }] } };

test('a withheld estimate on the 25/75 terms names them without any amount; any other keeps the portal\'s own terms', async t => {
  // A sent FINAL_25_75 quote revised and not sent again: its revision 1 schedule is the one saved.
  const unsent = { quoteDraft: { version: 1, requestId: 'r1' }, customerApproval: undefined, quoteStatus: 'draft' };
  const unsentEstimate = { status: 'draft', revision: 2, sentRevision: 1, acceptedAt: undefined, acceptanceMethod: undefined, source: 'quote_draft', termsVersion: FINAL_25_75.version, commercialPolicy: { ...FINAL_25_75 },
    paymentSchedule: { depositCents: 62398, remainderCents: 187192, depositDueDate: '2026-10-13', remainderDueDate: '2026-10-20', timeZone: 'America/Denver', policyVersion: FINAL_25_75.version } };
  // Signed again after a 50% deposit was paid: its schedule keeps what was paid as the deposit.
  const paidMore = signedJob(HELD, { paymentSchedule: { depositCents: 124795, remainderCents: 124795, depositDueDate: '2026-10-19', remainderDueDate: '2026-10-20', timeZone: 'America/Denver', policyVersion: SIGNED_25_75.version } });
  portalStore(t, { 'job-held': signedJob(HELD), 'job-unsent': signedJob(unsent, unsentEstimate), 'job-legacy': legacyJob(HELD), 'job-paid-more': paidMore });
  const view = async id => (await portalView(portalHandlers(), await portalCookie(id))).body;
  const held = await view('job-held');
  assert.deepEqual([held.estimate.withheld, held.estimate.status, held.estimate.approvable, held.estimate.amount, held.estimate.depositRequired], [true, 'being_updated', false, 0, 0]);
  // Signed in person and held for the owner's prices: the job is booked and its prices are being confirmed, nothing is due
  // until the team sends the updated total (walkthrough-handoff.js releasePatch asks for no new approval).
  assert.equal(held.estimate.terms, 'This flat-rate estimate covers the scope shown. 25% deposit; 75% remainder due on the job day 2026-10-20 (America/Denver). Your job is booked and our team is confirming its prices: the amounts are shown when we send you the updated total, and nothing is due before then. Any material scope change requires your approval before additional work or charges.');
  assert.equal(held.estimate.heldSigned, true);
  assert.equal(held.estimate.termsVersion, '2026-10-deposit25');
  assert.doesNotMatch(held.estimate.terms, /upfront|on completion/);
  assert.doesNotMatch(JSON.stringify(held), /623\.98|2,?495\.9|1,?871\.92|62398|187192|249590/, 'no withheld amount reaches the customer');
  const sentRevision = await view('job-unsent');
  // A sent FINAL_25_75 quote's unsent revision is sent on today's sent-quote terms (SENT_25_75), so it names those.
  assert.deepEqual([sentRevision.estimate.withheld, sentRevision.estimate.termsVersion, sentRevision.estimate.heldSigned], [true, '2026-10-19-deposit25-on-approval', undefined], 'an unsent revision is sent for approval');
  assert.match(sentRevision.estimate.terms, /The amounts are shown when your estimate is sent to you, and nothing is due before then\./);
  assert.match(sentRevision.estimate.terms, /25% deposit due when you approve your estimate; 75% remainder due on the job day 2026-10-20 \(America\/Denver\)\./);
  assert.doesNotMatch(sentRevision.estimate.terms, /upfront|on completion/);
  assert.match((await view('job-paid-more')).estimate.terms, /50% deposit; 50% remainder due on the job day 2026-10-20/);
  // Signed on the earlier 50% terms: the portal's own wording and version, as before.
  const legacy = await view('job-legacy');
  assert.deepEqual([legacy.estimate.withheld, legacy.estimate.terms, legacy.estimate.termsVersion, legacy.estimate.heldSigned], [true, CUSTOMER_PORTAL_CONTENT.estimateTerms, CUSTOMER_PORTAL_TERMS_VERSION, true]);
  assert.equal(withheldQuotePaymentSummary({ commercialPolicy: { ...FINAL_25_75, depositPct: 50 } }), null, 'only a verified 25/75 policy');
  assert.equal(withheldQuotePaymentSummary({ commercialPolicy: { ...SIGNED_25_75 } }).text, '25% deposit; 75% remainder due on the job day. The amounts are shown when your estimate is sent to you, and nothing is due before then.', 'no schedule: no date');
  assert.equal(withheldQuotePaymentSummary({ commercialPolicy: { ...SIGNED_25_75 } }, { signed: true }).text, '25% deposit; 75% remainder due on the job day. Your job is booked and our team is confirming its prices: the amounts are shown when we send you the updated total, and nothing is due before then.');
  assert.equal(withheldQuotePaymentSummary({ commercialPolicy: { ...SENT_25_75 } }).text, '25% deposit due when you approve your estimate; 75% remainder due on the job day. The amounts are shown when your estimate is sent to you, and nothing is due before then.');
});

// Firestore (the job and the checkout ledger) and Stripe Checkout, for the real portal payment path.
function paymentStore(t, jobs) {
  const docs = new Map(), sessions = new Map(), keys = new Map(), created = [];
  let version = 0;
  const stamp = () => `2026-09-22T00:00:00.${String(++version).padStart(6, '0')}Z`;
  for (const [id, value] of Object.entries(jobs)) docs.set(`jobs/${id}`, { value: structuredClone(value), updateTime: stamp() });
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    if (url.hostname === 'firestore.googleapis.com') {
      if (url.pathname.endsWith('/documents:commit')) {
        const result = applyFirestoreCommit(JSON.parse(options.body), { read: key => docs.has(key) ? { data: docs.get(key).value, updateTime: docs.get(key).updateTime } : null, write: (key, value) => docs.set(key, { value, updateTime: stamp() }) });
        return Response.json({ writeResults: result.paths.map(() => ({})) });
      }
      const path = decodeURIComponent(url.pathname.split('/documents/')[1]), row = docs.get(path);
      if (method === 'PATCH') {
        const mask = url.searchParams.getAll('updateMask.fieldPaths'), patch = decodeFirestoreFields(JSON.parse(options.body).fields);
        docs.set(path, { value: mask.length ? { ...row?.value, ...Object.fromEntries(mask.map(key => [key, patch[key]])) } : patch, updateTime: stamp() });
      }
      const saved = docs.get(path);
      return saved ? Response.json({ name: `projects/egcw-1ec83/databases/(default)/documents/${path}`, fields: encodeFirestoreFields(saved.value), updateTime: saved.updateTime }) : Response.json({}, { status: 404 });
    }
    assert.equal(url.hostname, 'api.stripe.com', `Unexpected external request to ${url.hostname}`);
    assert.equal(`${method} ${url.pathname}`, 'POST /v1/checkout/sessions');
    const params = new URLSearchParams(options.body), key = options.headers['Idempotency-Key'];
    if (!keys.has(key)) { const id = `cs_test_gap_${sessions.size + 1}`; keys.set(key, id); created.push(params); sessions.set(id, { id, status: 'open', url: `https://checkout.stripe.com/c/pay/${id}`, amount_total: Number(params.get('line_items[0][price_data][unit_amount]')) }); }
    return Response.json(sessions.get(keys.get(key)));
  });
  return { created };
}

test('Stripe Checkout names a 25/75 deposit by its split and the job day its remainder is due (the rest of a part-paid one without a percent); legacy jobs keep their wording', async t => {
  const stripeEnv = { ...env, STRIPE_SECRET_KEY: 'sk_test_synthetic_gap_fixes' };
  const sent = signedJob({ customerApproval: { status: 'approved', approvedAt: '2026-10-19T16:00:00.000Z', approvedBy: 'Synthetic Customer' } }, { status: 'approved', acceptanceMethod: undefined, source: 'quote_draft', termsVersion: FINAL_25_75.version, commercialPolicy: { ...FINAL_25_75 },
    paymentSchedule: { depositCents: 62398, remainderCents: 187192, depositDueDate: '2026-10-13', remainderDueDate: '2026-10-20', timeZone: 'America/Denver', policyVersion: FINAL_25_75.version } });
  const f = paymentStore(t, { 'job-signed': signedJob(), 'job-sent': sent, 'job-legacy': legacyJob(), 'job-paid': signedJob(PAID), 'job-legacy-paid': legacyJob({ ...PAID, deposit: { ...PAID.deposit, amount: 1247.95, paidAmount: 1247.95 }, payment: { ...PAID.payment, amount: 1247.95, stripeSessions: [{ ...PAID.payment.stripeSessions[0], amount: 1247.95 }] } }) });
  const pay = async id => portalPost(portalHandlers(), await portalCookie(id), { action: 'create_payment', request_id: `synthetic-${id}` }, stripeEnv);
  const line = params => [params.get('line_items[0][price_data][product_data][name]'), params.get('line_items[0][price_data][product_data][description]'), params.get('line_items[0][price_data][unit_amount]')];
  for (const id of ['job-signed', 'job-sent']) {
    assert.equal((await pay(id)).status, 200, id);
    assert.deepEqual(line(f.created.at(-1)), ['Easy Garage Cleaning — 25% deposit', 'Garage transformation. Applied to your approved quote; the remaining 75% is due on the job day, Tuesday, October 20, 2026.', '62398'], id);
  }
  assert.equal((await pay('job-legacy')).status, 200);
  assert.deepEqual(line(f.created.at(-1)), ['Easy Garage Cleaning — upfront deposit', 'Garage transformation. Applied to your approved quote; remaining balance due on completion.', '124795']);
  const paid = await pay('job-paid');
  assert.deepEqual([paid.status, paid.body.error], [409, 'Your deposit is paid. The remaining balance is due on the job day, Tuesday, October 20, 2026.']);
  const legacyPaid = await pay('job-legacy-paid');
  assert.deepEqual([legacyPaid.status, legacyPaid.body.error], [409, 'Your deposit is paid. The remaining balance is due on completion.']);
  assert.equal(f.created.length, 3, 'no checkout opened for a paid deposit');
  // Review: part of the deposit recorded in cash ($225.00 of $623.98): the rest is not "25%", as the portal says too.
  const part = signedJob({ deposit: { amount: 623.98, paidAmount: 225, status: 'partial', verified: true }, payment: { amount: 225, verified: true, method: 'cash', processor: 'manual' } });
  const g = paymentStore(t, { 'job-part': part });
  const partPaid = await portalPost(portalHandlers(), await portalCookie('job-part'), { action: 'create_payment', request_id: 'synthetic-job-part' }, stripeEnv);
  assert.equal(partPaid.status, 200);
  assert.deepEqual(line(g.created.at(-1)), ['Easy Garage Cleaning — remaining deposit', 'Garage transformation. Applied to your approved quote; the remaining 75% is due on the job day, Tuesday, October 20, 2026.', '39898']);
  assert.equal(paymentDateLabel('2026-10-20'), 'Tuesday, October 20, 2026');
});

// Owner decision of 2026-10-18 evening: a quote sent on SENT_25_75 (saved with no deposit date) is due on approval on every
// surface the customer reads: the portal's estimate terms and payment DTO, the approval it binds, the estimate document and
// Stripe Checkout, dated by the approval once approved; the saved schedule is never rewritten. A quote already sent on
// FINAL_25_75 keeps its recorded date everywhere.
const sentOnApproval = (extra = {}, estimate = {}) => signedJob({ quoteDraft: { version: 1, requestId: 'r1' }, customerApproval: undefined, quoteStatus: 'sent', ...extra }, { status: 'sent', revision: 1, sentRevision: 1, sentAt: '2026-09-21T18:00:00.000Z', acceptedAt: undefined, acceptedBy: undefined, acceptanceMethod: undefined, source: 'quote_draft',
  termsVersion: SENT_25_75.version, commercialPolicy: { ...SENT_25_75 }, paymentSchedule: { depositCents: 62398, remainderCents: 187192, depositDueDate: null, remainderDueDate: '2026-10-20', timeZone: 'America/Denver', policyVersion: SENT_25_75.version, sourceWalkthroughId: 'w1', sourceRevision: 'w1r' }, ...estimate });
test('a quote sent on SENT_25_75 says the deposit is due on approval in the portal, the approval and the estimate document, then dates it by the approval', async t => {
  const final = sentOnApproval({}, { termsVersion: FINAL_25_75.version, commercialPolicy: { ...FINAL_25_75 }, paymentSchedule: { depositCents: 62398, remainderCents: 187192, depositDueDate: '2026-10-13', remainderDueDate: '2026-10-20', timeZone: 'America/Denver', policyVersion: FINAL_25_75.version } });
  const store = portalStore(t, { 'job-sent': sentOnApproval(), 'job-final': final }), handlers = portalHandlers();
  const cookie = await portalCookie('job-sent'), before = (await portalView(handlers, cookie)).body;
  assert.equal(before.estimate.terms, 'This flat-rate estimate covers the scope shown. 25% deposit $623.98 due on approval; 75% remainder $1,871.92 due 2026-10-20 (America/Denver). Any material scope change requires your approval before additional work or charges.');
  assert.deepEqual([before.estimate.termsVersion, before.estimate.approvable, before.estimate.paymentSchedule.depositDueDate, before.estimate.paymentSchedule.depositDueOn], [SENT_25_75.version, true, null, 'approval']);
  assert.deepEqual([before.payment.purpose, before.payment.dueNow], ['deposit', 623.98]);
  const sentDoc = moneyDocumentModel({ ...store.job('job-sent'), id: 'job-sent' }, { kind: 'estimate', now: '2026-09-22T18:00:00.000Z' });
  assert.deepEqual(sentDoc.dates.find(([label]) => label === '25% deposit due'), ['25% deposit due', 'When you approve this estimate']);
  assert.ok(sentDoc.rows.some(row => row.label === '25% deposit due on approval' && row.cents === 62398));
  assert.match(sentDoc.terms, /25% deposit \$623\.98 due on approval; 75% remainder \$1,871\.92 due 2026-10-20 \(America\/Denver\)\./);
  // The approval binds the terms the page showed.
  const approved = await portalPost(handlers, cookie, { action: 'approve_estimate', signed_name: 'Synthetic Customer', confirmed: true, estimate_revision: 1, amount_cents: 249590, estimate_fingerprint: before.estimate.fingerprint, terms_version: before.estimate.termsVersion, request_id: randomUUID() });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.approval.termsVersion, SENT_25_75.version);
  const after = (await portalView(handlers, cookie)).body, saved = { ...store.job('job-sent'), id: 'job-sent' };
  assert.equal(after.estimate.status, 'approved');
  assert.match(after.estimate.terms, /25% deposit \$623\.98 due on approval \(2026-09-22\); 75% remainder \$1,871\.92 due 2026-10-20 \(America\/Denver\)\./);
  assert.deepEqual([after.estimate.paymentSchedule.depositDueDate, after.payment.purpose, after.payment.dueNow], ['2026-09-22', 'deposit', 623.98], 'payable right after approval, due that day');
  assert.equal(saved.estimate.paymentSchedule.depositDueDate, null, 'the saved schedule is not rewritten');
  const approvedDoc = moneyDocumentModel(saved, { kind: 'estimate', now: '2026-09-22T18:30:00.000Z' });
  assert.deepEqual(approvedDoc.dates.find(([label]) => label === '25% deposit due'), ['25% deposit due', 'On approval, September 22, 2026']);
  assert.ok(approvedDoc.rows.some(row => row.label === '25% deposit due on approval (2026-09-22)'));
  for (const doc of [sentDoc, approvedDoc]) assert.doesNotMatch(JSON.stringify([doc.dates, doc.rows, doc.terms, doc.payNote]), /upfront|on completion|seven days|null/i);
  // Already sent on FINAL_25_75: its recorded deposit date, on the portal and the document.
  const finalView = (await portalView(handlers, await portalCookie('job-final'))).body;
  assert.match(finalView.estimate.terms, /25% deposit \$623\.98 due 2026-10-13; 75% remainder \$1,871\.92 due 2026-10-20 \(America\/Denver\)\./);
  assert.deepEqual([finalView.estimate.termsVersion, finalView.estimate.paymentSchedule.depositDueDate, finalView.estimate.paymentSchedule.depositDueOn], [FINAL_25_75.version, '2026-10-13', undefined]);
  assert.deepEqual(moneyDocumentModel({ ...final, id: 'job-final' }, { kind: 'estimate', now: '2026-09-22T18:00:00.000Z' }).dates.find(([label]) => label === '25% deposit due'), ['25% deposit due', 'October 13, 2026']);
});

test('Stripe Checkout and the receipt for a quote sent on SENT_25_75 say the deposit was due on approval and the 75% on the job day', async t => {
  const stripeEnv = { ...env, STRIPE_SECRET_KEY: 'sk_test_synthetic_gap_fixes' };
  const approved = sentOnApproval({ customerApproval: { status: 'approved', approvedAt: '2026-09-22T17:00:00.000Z', approvedBy: 'Synthetic Customer', source: 'customer_portal', termsVersion: SENT_25_75.version }, quoteStatus: 'approved' }, { status: 'approved', acceptedAt: '2026-09-22T17:00:00.000Z', acceptedBy: 'Synthetic Customer' });
  const f = paymentStore(t, { 'job-approved': approved, 'job-unapproved': sentOnApproval() });
  const line = params => [params.get('line_items[0][price_data][product_data][name]'), params.get('line_items[0][price_data][product_data][description]'), params.get('line_items[0][price_data][unit_amount]')];
  const paid = await portalPost(portalHandlers(), await portalCookie('job-approved'), { action: 'create_payment', request_id: 'synthetic-sent-approved' }, stripeEnv);
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.deepEqual(line(f.created.at(-1)), ['Easy Garage Cleaning — 25% deposit', 'Garage transformation. Due on approval of your quote; the remaining 75% is due on the job day, Tuesday, October 20, 2026.', '62398']);
  const early = await portalPost(portalHandlers(), await portalCookie('job-unapproved'), { action: 'create_payment', request_id: 'synthetic-sent-unapproved' }, stripeEnv);
  assert.notEqual(early.status, 200, 'nothing is charged before the approval');
  assert.equal(f.created.length, 1);
  // The deposit paid by card writes an invoice with no due date of its own (MONEY_INVOICE_STATE_ENABLED off): the invoice
  // document lists the 25/75 dates, the deposit's the approval day. An issued invoice keeps only its own due date.
  const paidJob = { ...approved, ...PAID, invoice: { amount: 2495.9, paid: 623.98, balance: 1871.92, status: 'partial' }, id: 'job-approved' };
  const receipt = moneyDocumentModel(paidJob, { kind: 'receipt', now: '2026-09-22T18:00:00.000Z' }), invoice = moneyDocumentModel(paidJob, { kind: 'invoice', now: '2026-09-22T18:00:00.000Z' });
  assert.deepEqual(invoice.dates, [['Issued', 'Not issued yet'], ['Payment due', 'Not specified'], ['25% deposit due', 'On approval, September 22, 2026'], ['75% remainder due', 'October 20, 2026'], ['Business timezone', 'America/Denver']]);
  for (const doc of [receipt, invoice]) assert.doesNotMatch(JSON.stringify([doc.dates, doc.rows, doc.terms, doc.payNote]), /upfront|on completion|seven days|null/i);
  const issued = moneyDocumentModel({ ...paidJob, invoice: { ...paidJob.invoice, number: 'INV-SYN1', status: 'issued', issuedAt: '2026-10-21T16:00:00.000Z', dueDate: '2026-10-28' } }, { kind: 'invoice', now: '2026-10-21T18:00:00.000Z' });
  assert.deepEqual(issued.dates, [['Issued', 'October 21, 2026'], ['Payment due', 'October 28, 2026']]);
});

// D-JUNK: a junk-only builder quote ($750 per truck, no Labor line) sent before the send gate on a walkthrough that records
// garage work is withheld like an unsent one until the office corrects and sends it again; an approved one keeps its price.
function sentJunkJob({ status = 'sent', instructions = { sortMethod: 'zones', finish: ['cleanout'], hazards: [] }, signed = false } = {}) {
  return { id: 'job-junk', type: 'job', status: 'scheduled', pipelineStatus: 'estimate_sent', customer: 'Synthetic', customerId: 'c1', serviceType: 'Junk removal', total: 1500, priceQuoted: 1500, quoteStatus: status,
    jobInstructions: instructions, ...(signed ? { compositeQuote: { breakdown: { source: 'composite', lines: [] } } } : {}),
    quoteDraft: { version: 1, requestId: 'r1', compositePricing: { menuVersion: 'm', settingsVersion: 's', steps: ['removal', 'shelving', 'storage'], removal: [{ id: 'egc-026', quantity: 2 }], shelving: [], storage: [] },
      breakdown: { version: 1, source: 'composite', lines: [{ id: 'egc-026', lineItemId: 'removal-junk-full', section: 'removal', group: 'junk', name: 'Full truck load', qty: 2 }], sections: [] } },
    estimate: { number: 'EST-JUNK', revision: 1, sentRevision: 1, status, sentAt: '2026-10-19T15:00:00.000Z', amount: 1500, amountCents: 150000, depositRequired: 375, depositRequiredCents: 37500, validUntil: '2026-10-30', source: 'quote_draft',
      scope: 'Junk removal only: Full truck load × 2. Loading, hauling and disposal; no sorting, organizing or reset.',
      lineItems: [{ id: 'removal-junk-full', kind: 'service', name: 'Junk removal: full truck load', description: 'Hauling and disposal by full truck load.', quantity: 2, unitCents: 75000, totalCents: 150000, optional: false, selected: true, taxable: false }] },
    ...(status === 'approved' ? { customerApproval: { status: 'approved', approvedAt: '2026-10-19T16:00:00.000Z', approvedBy: 'Synthetic' } } : {}),
    deposit: { amount: 375, paidAmount: 0, status: 'required' } };
}

test('a junk-only quote sent on a walkthrough that records garage work is withheld and cannot be approved; junk removal only, it stays approvable', async t => {
  assert.deepEqual(junkOnlyGarageWork(sentJunkJob()), ['sorting into keep / donate / haul zones and resetting what stays']);
  assert.equal(unsentQuoteDraft(sentJunkJob()), true);
  for (const job of [sentJunkJob({ status: 'approved' }), sentJunkJob({ signed: true }), sentJunkJob({ instructions: { sortMethod: 'remove_all', finish: ['cleanout'], hazards: [] } }), sentJunkJob({ instructions: { sortMethod: 'labels', finish: ['shelving'], shelfQty: 0 } })]) {
    assert.deepEqual(junkOnlyGarageWork(job), [], JSON.stringify(job.jobInstructions));
    assert.equal(unsentQuoteDraft(job), false);
  }
  // A count the capture did not record counts as work (fails closed); the signed walkthrough's own check is unchanged.
  assert.deepEqual(junkOnlyGarageWork(sentJunkJob({ instructions: { sortMethod: 'remove_all', finish: ['shelving', 'totes'] } })), ['shelving', 'storage totes']);
  assert.deepEqual(handoffGarageWork({ finish: ['shelving', 'totes'] }), [], 'a signed plan with no counts is judged as before');
  for (const scope of [{ sort_method: 'zones' }, { sort_method: 'customer', finish: ['deep_clean', 'pressure_wash', 'mouse_trapping'], hazards: ['Pest waste'] }, { finish: ['shelving', 'totes'], finish_details: { shelf_qty: 1, tote_qty: 4 } }]) {
    assert.deepEqual(handoffGarageWork(scope), walkthroughGarageWork(scope), JSON.stringify(scope));
  }
  // The builder's copy on the walkthrough page says the same.
  const context = { window: {} };
  vm.runInNewContext(read('crew/quote-draft.js'), context);
  const builderWork = context.window.EGCQuoteDraft.builder.walkthroughGarageWork;
  for (const scope of [{ sort_method: 'zones', finish: ['cleanout', 'shelving'], finish_details: { shelf_qty: 3 } }, { sort_method: 'remove_all', hazards: ['Pest waste'], finish: ['deep_clean'] }]) assert.deepEqual(Array.from(builderWork({ scope })), walkthroughGarageWork(scope));
  portalStore(t, { 'job-junk': sentJunkJob(), 'job-ok': { ...sentJunkJob({ instructions: { sortMethod: 'remove_all', finish: ['cleanout'], hazards: [] } }), id: 'job-ok' } });
  const handlers = portalHandlers(), view = await portalView(handlers, await portalCookie('job-junk'));
  assert.deepEqual([view.body.estimate.status, view.body.estimate.withheld, view.body.estimate.approvable, view.body.estimate.amount, view.body.payment.dueNow], ['being_updated', true, false, 0, 0]);
  const approve = await portalPost(handlers, await portalCookie('job-junk'), { action: 'approve_estimate', signed_name: 'Synthetic', confirmed: true, estimate_revision: 1, amount_cents: 150000, estimate_fingerprint: 'x' });
  assert.deepEqual([approve.status, approve.body.code], [409, 'CUSTOMER_PORTAL_ESTIMATE_NOT_APPROVABLE']);
  const ok = await portalView(handlers, await portalCookie('job-ok'));
  assert.deepEqual([ok.body.estimate.status, ok.body.estimate.approvable, ok.body.estimate.amount], ['sent', true, 1500]);
});

// D-JUNK: a junk-only quote is junk removal, and every customer surface names it so (the portal, the documents, Stripe);
// any other signed walkthrough is a garage transformation. HighLevel keeps the garage sales exit for these leads.
const state = builderState(), id = name => menuItem(name).id;
const descriptor = (removal, { shelving = [], storage = [], labor } = {}) => ({ menuVersion: menu.menuVersion, settingsVersion: state.settings.settingsVersion, steps: ['removal', 'shelving', 'storage'], removal, shelving, storage, ...(labor ? { labor } : {}) });
const quoteOf = priced => ({ line_items: priced.lineItems.map(line => ({ id: line.id, kind: line.kind, name: line.name, description: line.description, quantity: line.quantity, unitCents: line.unitCents, totalCents: line.totalCents })), catalog_version: priced.menuVersion, composite_pricing: priced.compositePricing });
const signWith = (f, priced, { scope = {}, briefs = null, job = null } = {}) => {
  const plan = signedPlan(1, { total: priced.totalCents / 100, quote: quoteOf(priced) });
  plan.scope = { ...plan.scope, ...scope };
  if (briefs) Object.assign(plan, briefs);
  return saveWalkthroughHandoff(f.store, owner, { actorId: owner.user, requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: f.rows.get('jobs/w1').revision, ...(job ? { jobId: job.id, expectedRevision: job.revision } : {}), plan }, SIGNED_AT, { env: ON_ENV, compositeState: async () => state });
};

test('a junk-only quote signed in person is "Junk removal" on the portal, the documents and Stripe; signed again with garage work it is a garage transformation', async t => {
  const junk = priceCompositeQuote(state, descriptor([{ id: id('Full truck load'), quantity: 2 }]), { complete: true });
  const garage = priceCompositeQuote(state, descriptor([{ id: id('Two-car garage base'), quantity: 1 }, { id: id('Full truck load'), quantity: 1 }], { labor: { manHours: null, fullness: 'medium' } }), { complete: true });
  const f = fixture(), signed = await signWith(f, junk, { scope: { sort_method: 'remove_all' } }), job = structuredClone(f.job(signed.job.id));
  assert.equal(job.serviceType, 'Junk removal');
  assert.equal(moneyDocumentModel(job, { kind: 'estimate', now: SIGNED_AT }).service, 'Junk removal');
  assert.equal(signedGarageHandoff(job), false, 'junk removal is not garage work for the setter terms, as before');
  assert.deepEqual([salesExitService(job), salesExitService({ serviceType: 'Junk removal', quoteDraft: {} }), salesExitService({ serviceType: 'Junk removal' }), salesExitService({ serviceType: 'Garage transformation', handoffVersion: 1 })], ['garage', 'garage', 'junk', 'garage'], 'a walkthrough lead keeps the garage sales exit');
  portalStore(t, { 'job-junk': { ...job, id: 'job-junk' } });
  const view = await portalView(portalHandlers(), await portalCookie('job-junk'));
  assert.deepEqual([view.body.appointment.service, view.body.estimate.service], ['Junk removal', 'Junk removal']);
  const resigned = await signWith(f, garage, { scope: { sort_method: 'zones' }, job: f.job(signed.job.id) });
  assert.equal(f.job(resigned.job.id).serviceType, 'Garage transformation');
  const g = fixture(), first = await signWith(g, garage, { scope: { sort_method: 'zones' } });
  assert.equal(g.job(first.job.id).serviceType, 'Garage transformation');
});

// The builder never reads or writes the walkthrough Finish step, so a builder quote's brief names the goods it sold (its
// shelving and storage packs) on its MATERIALS line, for the crew and the staff HighLevel note; never a price.
test('a signed builder quote\'s crew brief and HighLevel brief name the goods sold, not the Finish step\'s "None sold"', async () => {
  const brief = header => [header, 'CUSTOMER GOAL: Park two cars', 'FINISH SOLD: cleanout', 'MATERIALS: None sold', 'BRING: Hand truck / dolly, Contractor bags', 'WALKTHROUGH PHOTOS: 4 captured'].join('\n');
  const briefs = { internal_notes: brief('EGC INTERNAL JOB BRIEF'), crew_brief: brief('EGC CREW JOB BRIEF') };
  const goods = priceCompositeQuote(state, descriptor([{ id: id('Two-car garage base'), quantity: 1 }, { id: id('Full truck load'), quantity: 1 }], { shelving: [{ id: SHELF.id, quantity: 2 }], storage: [{ id: TOTES.id, quantity: 2 }], labor: { manHours: null, fullness: 'medium' } }), { complete: true });
  const f = fixture(), signed = await signWith(f, goods, { briefs }), job = f.job(signed.job.id);
  const materials = text => String(text).split('\n').find(row => row.startsWith('MATERIALS:'));
  const sold = `MATERIALS: ${SHELF.name} × 2 packs · ${TOTES.name} × 2 packs of ${TOTES.unitsPerPack}`;
  for (const text of [job.operationalScope.text, job.acceptedHandoffPayload.crew_brief, job.acceptedHandoffPayload.internal_notes, job.internalNotes]) {
    assert.equal(materials(text), sold);
    assert.doesNotMatch(text, /\$\s?\d/);
  }
  assert.match(job.operationalScope.text, /^FINISH SOLD: cleanout$/m, 'the rest of the brief is the page\'s');
  // A junk-only quote sells no goods; a brief without a MATERIALS line is kept as it was sent.
  const junk = priceCompositeQuote(state, descriptor([{ id: id('Full truck load'), quantity: 1 }]), { complete: true });
  const g = fixture(), junkJob = g.job((await signWith(g, junk, { briefs })).job.id);
  assert.equal(materials(junkJob.operationalScope.text), 'MATERIALS: None sold');
  const h = fixture(), plain = h.job((await signWith(h, goods)).job.id);
  assert.deepEqual([plain.acceptedHandoffPayload.internal_notes, plain.operationalScope.text], ['Synthetic internal brief', 'Synthetic crew brief']);
});

// Review: the walkthrough page's checklists name the builder's goods (soldGoods), two lines of up to 600 characters each,
// and the server refuses a checklist detail over 1,000 (walkthrough-handoff.js checks: 400 invalid_plan) after the homeowner
// signed. The page cuts a detail to 1,000, so a valid quote with many goods still signs.
test('a builder quote whose shelving and storage lines are both at the 600-character cap signs with the page\'s checklists', async () => {
  const section = name => menu.products.filter(product => product.section === name).map(product => ({ id: product.id, quantity: 2 }));
  const priced = priceCompositeQuote(state, descriptor([{ id: id('Two-car garage base'), quantity: 1 }, { id: id('Full truck load'), quantity: 1 }], { shelving: section('shelving').slice(0, 13), storage: section('storage').slice(0, 20), labor: { manHours: null, fullness: 'medium' } }), { complete: true });
  const soldGoods = priced.lineItems.filter(line => line.kind === 'product').map(line => String(line.description));
  assert.deepEqual(soldGoods.map(goods => goods.length), [600, 600], 'both goods lines at the cap');
  const page = read('crew/gameplan.html').split('\n').find(row => row.startsWith('function buildClientChecklists(')), context = {};
  vm.runInNewContext(`${page}; this.build = buildClientChecklists;`, context);
  const checks = context.build({ soldGoods, finish: ['cleanout', 'shelving', 'totes'], customerGoal: 'Park two cars', keepItems: 'Bike', removeItems: 'Boxes', exclusions: 'None', hazards: [], access: [], specialItems: [], bringList: ['Hand truck / dolly'] });
  const details = [...checks.preJob, ...checks.postJob].map(row => row.detail);
  assert.ok(details.every(detail => detail.length <= 1000), 'no detail over the server limit');
  const materials = checks.preJob.find(row => row.id === 'materials').detail;
  assert.equal(materials.length, 1000);
  assert.ok(materials.startsWith(`cleanout, shelving, totes · ${soldGoods[0]} · `) && materials.endsWith('…'), 'the goods lead, cut with an ellipsis');
  assert.equal(context.build({ soldGoods: ['HDX totes × 2 packs of 4'], finish: ['cleanout'] }).preJob.find(row => row.id === 'materials').detail, 'cleanout · HDX totes × 2 packs of 4', 'a short detail is unchanged');
  const f = fixture(), signed = await signWith(f, priced, { scope: { sort_method: 'zones' }, briefs: { client_checklists: checks } });
  const saved = f.job(signed.job.id);
  assert.equal(saved.estimate.amountCents, priced.totalCents);
  assert.ok(JSON.stringify(saved).includes(materials.slice(0, 200)), 'the cut checklist is saved');
});

// Owner decision of 2026-10-18 evening: a quote signed in person takes its 25% deposit the day it is signed, and a quote
// sent from 2026-10-19 on (SENT_25_75) when it is approved, so the copy says "when you sign or approve it". It names the
// walkthrough quote (an office estimate states its own deposit) and leaves each quote's dates to the quote, as quotes
// sent earlier on FINAL_25_75 keep theirs.
test('the public FAQ, the prep guide and the business rate card state the 25% deposit at signing or approval and the job-day remainder', () => {
  const faq = read('faq.html'), guide = read('blog/how-to-prepare-for-garage-cleanout.html');
  for (const page of [faq, guide]) assert.doesNotMatch(page, /Payment is (?:due|collected) at job completion/);
  assert.deepEqual(quotePaymentDates(SENT_25_75, { walkthroughDate: '2026-10-19', jobDate: '2026-11-10', approvalDate: '2026-10-21T15:00:00Z' }), { depositDueDate: '2026-10-21', remainderDueDate: '2026-11-10' }, 'a sent quote: due when approved');
  assert.deepEqual(quotePaymentDates(FINAL_25_75, { walkthroughDate: '2026-10-19', jobDate: '2026-11-10' }), { depositDueDate: '2026-11-03', remainderDueDate: '2026-11-10' }, 'a quote sent earlier keeps its dates');
  const answer = 'We accept cash, credit or debit card, Venmo, and Zelle. A quote from your walkthrough takes a 25% deposit when you sign or approve it, and the remaining 75% is due on the job day. Your quote shows the exact amounts and dates.';
  const schema = JSON.parse(faq.match(/<script type="application\/ld\+json">(\{"@context": "https:\/\/schema\.org", "@type": "FAQPage".*?)<\/script>/s)[1]);
  assert.equal(schema.mainEntity.find(entry => entry.name === 'What payment methods do you accept?').acceptedAnswer.text, answer);
  assert.ok(faq.includes(`<p>${answer}</p>`), 'the visible answer is the structured one');
  assert.match(guide, /A quote from your walkthrough takes a 25% deposit when you sign or approve it; the remaining 75% is due on the job day, and your quote shows the exact amounts and dates\./);
  for (const page of [faq, guide]) assert.doesNotMatch(page, /Quoted projects take/, 'the copy names the walkthrough quote: an office estimate keeps its own deposit');
  const account = { id: 'a'.repeat(32), company: 'Synthetic Co', billingEmail: 'billing@example.invalid', status: 'active', members: [], requests: [], messages: [], projects: [], properties: [] };
  const terms = accountView(account, { id: 'b'.repeat(32), name: 'Synthetic Admin', role: 'admin', status: 'active' }, []).rates.terms;
  assert.equal(terms[1], 'Full-service projects: your quote states the deposit and when each payment is due. A walkthrough quote takes a 25% deposit when it is signed or approved and the remaining 75% on the job day. Credit terms require a written agreement.');
  assert.doesNotMatch(terms.join(' '), /50%|on completion/);
  for (const copy of [faq, guide, terms.join(' ')]) assert.doesNotMatch(copy, /seven days|7 days|by the date on|on completion/i, 'no seven-day or completion deposit is promised');
});
