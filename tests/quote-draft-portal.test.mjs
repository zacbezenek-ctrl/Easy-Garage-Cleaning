import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { previewQuoteSend, saveQuoteDraft, sendQuoteDraft } from '../functions/_lib/quote-draft.js';
import { unsentQuoteDraft } from '../functions/_lib/quote-model.js';
import { moneyDocumentKinds, moneyDocumentModel, renderMoneyDocument } from '../functions/_lib/money-document.js';
import { payable } from '../functions/_lib/customer-payments.js';
import { encodeFirestoreFields, decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { moneyDocumentHandlers } from '../functions/api/money-document.js';
import { env, portalStore, portalCookie, portalHandlers, portalView, portalPost } from './helpers/portal-fixture.mjs';
import { applyFirestoreCommit } from './helpers/firestore-commit.mjs';

// P2-07: a quote drafted in the Hub reaches the homeowner portal only through a
// confirmed send, whatever CUSTOMER_PORTAL_REJECT_DRAFT_ESTIMATES says.
const NOW = '2026-09-22T18:00:00.000Z';
const LATER = '2026-09-22T18:02:00.000Z';
const VIEWED = '2026-09-22T19:00:00.000Z';
const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const HUB = { HUB_SESSION_SECRET: 'synthetic-quote-draft-portal-secret-0123456789' };
const shelf = { id: 'shelving', label: 'Shelving', selection: 'single', required: true };
const lines = () => [
  { id: 'cleanout', kind: 'service', name: 'Garage cleanout and reset', description: 'Sorting, hauling and disposal', quantity: 1, unitCents: 90000, totalCents: 90000 },
  { id: 'shelf-good', kind: 'product', name: 'Plastic shelving unit', quantity: 2, unitCents: 34900, totalCents: 69800, group: shelf, tier: 'good', selected: false },
  { id: 'shelf-better', kind: 'product', name: 'Wood shelving unit', quantity: 2, unitCents: 44900, totalCents: 89800, group: shelf, tier: 'better', selected: true },
];
const draft = (change = () => {}) => { const value = { client: { name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevel_contact_id: 'provider1' }, title: 'Garage reset options', scope: 'Cleanout plus your choice of shelving.', line_items: lines(), valid_until: '2026-10-06', catalog_version: '', crew_size: 2, estimated_duration_min: 240 }; change(value); return value; };

// The Hub side: an in-memory dispatch store that the quote-draft library writes.
function hub() {
  const rows = new Map([['customers/c1', { id: 'c1', revision: 'c1r', name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevelContactId: 'provider1' }]]);
  let n = 0;
  const list = prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([, value]) => structuredClone(value));
  const store = {
    read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null),
    jobs: async () => list('jobs/'), resources: async () => [], customers: async () => list('customers/'), roster: async () => [{ id: 'zacb', name: 'Synthetic Owner', role: 'owner' }],
    commit: async writes => {
      for (const write of writes) { const old = rows.get(`${write.collection}/${write.id}`); if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 }); }
      for (const write of writes) if (!write.verify) { const key = `${write.collection}/${write.id}`; rows.set(key, { ...rows.get(key), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` }); }
    },
  };
  const job = id => structuredClone(rows.get(`jobs/${id}`));
  const save = async (change, jobId) => (await saveQuoteDraft(store, owner, { requestId: randomUUID(), customerId: 'c1', ...(jobId ? { jobId, expectedRevision: job(jobId).revision } : {}), draft: draft(change) }, NOW, { env: HUB })).job.id;
  const send = async id => {
    const preview = await previewQuoteSend(store, owner, { jobId: id, expectedRevision: job(id).revision }, NOW, { env: HUB });
    return sendQuoteDraft(store, owner, { requestId: randomUUID(), jobId: id, expectedRevision: job(id).revision, confirmToken: preview.confirmToken }, LATER, { env: HUB });
  };
  return { job, save, send };
}
const approve = (shown, extra = {}) => ({ action: 'approve_estimate', signed_name: 'Synthetic Customer', confirmed: true, estimate_revision: shown.revision, amount_cents: Math.round(shown.amount * 100), estimate_fingerprint: shown.fingerprint, terms_version: shown.termsVersion, ...extra });
const withheldShape = estimate => [estimate.status, estimate.withheld, estimate.approvable, estimate.amount, estimate.depositRequired, estimate.lineItems.length, estimate.scope, estimate.validUntil];
const FLAGS = [env, { ...env, CUSTOMER_PORTAL_REJECT_DRAFT_ESTIMATES: 'true' }, { ...env, CUSTOMER_PORTAL_REJECT_DRAFT_ESTIMATES: 'false', MONEY_DOCUMENT_ENABLED: 'true' }];

test('a quote draft that was never sent is withheld from the portal and cannot be approved, whatever the draft flag says', async t => {
  const h = hub(), id = await h.save(), saved = h.job(id);
  assert.deepEqual([saved.estimate.status, saved.estimate.amountCents, saved.estimate.revision], ['draft', 179800, 1]);
  // The same quote once it has been sent: the fingerprint an approval of it would carry.
  const released = { ...saved, id: 'twin', estimate: { ...saved.estimate, status: 'sent', sentRevision: 1 } };
  const portal = portalStore(t, { [id]: saved, twin: released }), handlers = portalHandlers(VIEWED), cookie = await portalCookie(id);
  const twin = (await portalView(handlers, await portalCookie('twin'))).body.estimate;
  assert.deepEqual([twin.status, twin.approvable, twin.amount], ['sent', true, 1798]);
  for (const testEnv of FLAGS) {
    const view = await portalView(handlers, cookie, testEnv), text = JSON.stringify(view.body);
    assert.equal(view.status, 200);
    assert.deepEqual(withheldShape(view.body.estimate), ['being_updated', true, false, 0, 0, 0, '', ''], JSON.stringify(testEnv));
    assert.deepEqual([view.body.payment.total, view.body.payment.balance, view.body.payment.dueNow, view.body.payment.deposit.required], [0, 0, 0, 0]);
    for (const unsent of ['1798', '1,798', '899', 'Wood shelving unit', 'Garage cleanout and reset', 'Cleanout plus your choice']) assert.equal(text.includes(unsent), false, `${unsent} ${JSON.stringify(testEnv)}`);
    assert.deepEqual(view.body.moneyDocuments, []);
    // Neither the withheld page nor a request naming the real revision, total and content can approve it.
    for (const body of [approve(view.body.estimate), approve(twin)]) {
      const refused = await portalPost(handlers, cookie, body, testEnv);
      assert.deepEqual([refused.status, refused.body.code], [409, 'CUSTOMER_PORTAL_ESTIMATE_NOT_APPROVABLE']);
    }
    const credit = await portalPost(handlers, cookie, { action: 'apply_gift_credit', card_id: 'credit-1', amount: 10, request_id: 'redeem-1' }, testEnv);
    assert.deepEqual([credit.status, credit.body.code], [409, 'CUSTOMER_PORTAL_ESTIMATE_NOT_APPROVABLE']);
  }
  assert.equal(portal.writes.length, 0, 'nothing is approved or paid on an unsent quote');
  assert.deepEqual(moneyDocumentKinds(saved, VIEWED), []);
});

test('a sent quote is approvable; an unsent revision of it is withheld until that revision is sent', async t => {
  const h = hub(), id = await h.save();
  await h.send(id);
  const portal = portalStore(t, { [id]: h.job(id) }), handlers = portalHandlers(VIEWED), cookie = await portalCookie(id);
  const sent = (await portalView(handlers, cookie)).body.estimate;
  assert.deepEqual([sent.status, sent.approvable, sent.amount, sent.revision, sent.withheld], ['sent', true, 1798, 1, undefined]);
  assert.ok(sent.lineItems.some(line => line.name === 'Wood shelving unit'));
  assert.deepEqual(moneyDocumentKinds(h.job(id), VIEWED), ['estimate']);
  // Mid-edit: the author saves a material revision to $938 and has not sent it.
  await h.save(value => { value.line_items = value.line_items.map(line => line.id === 'cleanout' ? { ...line, unitCents: 4000, totalCents: 4000 } : line); }, id);
  assert.deepEqual([h.job(id).estimate.status, h.job(id).estimate.revision, h.job(id).estimate.amountCents, h.job(id).estimate.sentRevision], ['draft', 2, 93800, 1]);
  portal.edit(id, h.job(id));
  for (const testEnv of FLAGS) {
    const view = await portalView(handlers, cookie, testEnv), text = JSON.stringify(view.body);
    assert.deepEqual(withheldShape(view.body.estimate), ['being_updated', true, false, 0, 0, 0, '', ''], JSON.stringify(testEnv));
    assert.equal(view.body.estimate.revision, 2);
    for (const unsent of ['938', '469', 'Garage cleanout and reset']) assert.equal(text.includes(unsent), false, unsent);
    assert.deepEqual(view.body.moneyDocuments, []);
    // The page from before the revision, and one naming the unsent revision and total, are both refused.
    for (const body of [approve(sent), approve(sent, { estimate_revision: 2, amount_cents: 93800 })]) {
      const refused = await portalPost(handlers, cookie, body, testEnv);
      assert.deepEqual([refused.status, refused.body.code], [409, 'CUSTOMER_PORTAL_ESTIMATE_NOT_APPROVABLE']);
    }
  }
  assert.equal(portal.writes.length, 0);
  // Once the author previews and confirms the send of revision 2, the customer can approve exactly it.
  await h.send(id);
  portal.edit(id, h.job(id));
  const current = (await portalView(handlers, cookie)).body.estimate;
  assert.deepEqual([current.status, current.approvable, current.amount, current.revision], ['sent', true, 938, 2]);
  const approved = await portalPost(handlers, cookie, approve(current));
  assert.equal(approved.status, 200);
  assert.deepEqual([portal.job(id).customerApproval.status, portal.job(id).customerApproval.amount, portal.job(id).estimate.status], ['approved', 938, 'approved']);
});

test('only Hub quote drafts are held back: other estimates keep today\'s draft-flag behaviour', () => {
  const drafted = { quoteDraft: { version: 1 }, estimate: { source: 'quote_draft', status: 'draft', revision: 1 } };
  assert.equal(unsentQuoteDraft(drafted), true);
  assert.equal(unsentQuoteDraft({ ...drafted, estimate: { ...drafted.estimate, status: 'sent', sentRevision: 1 } }), false);
  assert.equal(unsentQuoteDraft({ ...drafted, estimate: { ...drafted.estimate, status: 'sent', revision: 2, sentRevision: 1 } }), true, 'a send of an older revision does not release a newer one');
  assert.equal(unsentQuoteDraft({ ...drafted, estimate: { ...drafted.estimate, status: 'accepted', revision: 2, acceptanceMethod: 'in_person_signature' } }), false, 'a signed quote is released');
  assert.equal(unsentQuoteDraft({ ...drafted, estimate: { ...drafted.estimate, status: 'superseded' } }), true);
  assert.equal(unsentQuoteDraft({ estimate: { source: 'quote_draft', status: 'draft' } }), true);
  // A job whose estimate was saved in Estimates & payments (no quote draft) is untouched.
  for (const job of [{ estimate: { source: 'egc_hub', status: 'draft', revision: 1 } }, { estimate: { status: 'draft' } }, {}, null]) assert.equal(unsentQuoteDraft(job), false);
});

// Firestore REST for jobs and the portal checkout ledger, and Stripe Checkout,
// as createCustomerStripeCheckout uses them.
function checkoutWorld(t, jobs) {
  const docs = new Map(), stripe = [], sessions = new Map();
  let version = 0;
  const put = (key, value) => docs.set(key, { value: structuredClone(value), updateTime: `2026-09-22T00:00:00.${String(++version).padStart(6, '0')}Z` });
  for (const [id, value] of Object.entries(jobs)) put(`jobs/${id}`, value);
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    if (url.hostname === 'api.stripe.com') {
      const path = url.pathname.replace(/^\/v1\//, '');
      stripe.push(`${method} ${path}`);
      if (method === 'POST' && path === 'checkout/sessions') {
        const params = new URLSearchParams(String(options.body)), id = `cs_test_${sessions.size + 1}`;
        // The session keeps what the portal sent, so a paid one verifies like Stripe's (kind, job, currency, mode).
        sessions.set(id, { id, status: 'open', amount_total: Number(params.get('line_items[0][price_data][unit_amount]')), url: `https://checkout.stripe.com/c/pay/${id}`, mode: params.get('mode'), currency: params.get('line_items[0][price_data][currency]'), client_reference_id: params.get('client_reference_id'), metadata: Object.fromEntries([...params].filter(([key]) => key.startsWith('metadata[')).map(([key, value]) => [key.slice(9, -1), value])) });
        return Response.json(sessions.get(id));
      }
      const [, id, expire] = /^checkout\/sessions\/([^/]+)(\/expire)?$/.exec(path) || [];
      assert.ok(sessions.has(id), `Unexpected Stripe call ${method} ${path}`);
      if (expire) sessions.get(id).status = 'expired';
      return Response.json(sessions.get(id));
    }
    assert.equal(url.hostname, 'firestore.googleapis.com', `Unexpected external request to ${url.hostname}`);
    // FUN-03 (merge): a portal approval commits the job with its funnel event (documents:commit).
    if (url.pathname.endsWith('/documents:commit')) {
      const result = applyFirestoreCommit(JSON.parse(options.body), { read: key => docs.has(key) ? { data: docs.get(key).value, updateTime: docs.get(key).updateTime } : null, write: (key, value) => put(key, value) });
      return result.stale ? Response.json({ error: { code: 400, status: 'FAILED_PRECONDITION' } }, { status: 400 }) : Response.json({ writeResults: result.paths.map(() => ({})) });
    }
    const key = decodeURIComponent(url.pathname.split('/documents/')[1] || '');
    // (merge) Recording a charge also reads its payment_reviews record (REVIEWS-UI); none exists here, so GET answers 404.
    assert.match(key, /^(jobs|customer_payment_checkouts|payment_reviews)\/[^/]+$/);
    const document = () => ({ name: `projects/egcw-1ec83/databases/(default)/documents/${key}`, updateTime: docs.get(key).updateTime, fields: encodeFirestoreFields(docs.get(key).value) });
    if (method === 'GET') return docs.has(key) ? Response.json(document()) : Response.json({}, { status: 404 });
    assert.equal(method, 'PATCH');
    const precondition = url.searchParams.get('currentDocument.updateTime'), exists = url.searchParams.get('currentDocument.exists');
    if (precondition && docs.get(key)?.updateTime !== precondition || exists === 'false' && docs.has(key)) return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 400 });
    const mask = url.searchParams.getAll('updateMask.fieldPaths'), patch = decodeFirestoreFields(JSON.parse(options.body).fields);
    const next = mask.length ? { ...(docs.get(key)?.value || {}) } : {};
    if (mask.length) for (const field of mask) next[field] = patch[field]; else Object.assign(next, patch);
    put(key, next);
    return Response.json(document());
  });
  return { stripe, sessions, ledger: id => structuredClone(docs.get(`customer_payment_checkouts/${id}`)?.value ?? null), edit: (id, value) => put(`jobs/${id}`, value), job: id => structuredClone(docs.get(`jobs/${id}`)?.value ?? null) };
}
const PAY = { ...env, STRIPE_SECRET_KEY: 'sk_test_synthetic_quote_draft' };
const completed = row => ({ ...row, status: 'completed', pipelineStatus: 'completed', completedAt: '2026-09-22T17:00:00.000Z' });
const cheaper = value => { value.line_items = value.line_items.map(line => line.id === 'cleanout' ? { ...line, unitCents: 4000, totalCents: 4000 } : line); };

test('checkout never charges an unsent quote draft, even once the crew has completed the job', async t => {
  const h = hub(), id = await h.save();
  const world = checkoutWorld(t, { [id]: completed(h.job(id)) }), handlers = portalHandlers(VIEWED), cookie = await portalCookie(id);
  const view = await portalView(handlers, cookie, PAY);
  assert.deepEqual([view.body.estimate.status, view.body.payment.total, view.body.payment.dueNow], ['being_updated', 0, 0]);
  const refused = await portalPost(handlers, cookie, { action: 'create_payment', request_id: 'pay-1' }, PAY);
  assert.deepEqual([refused.status, refused.body.code], [409, 'CUSTOMER_PORTAL_ESTIMATE_NOT_APPROVABLE']);
  assert.deepEqual([world.stripe, world.ledger(id)], [[], null], 'no Stripe session and no checkout ledger for the unsent $1,798');
  assert.throws(() => payable(completed(h.job(id))), error => error.code === 'CUSTOMER_PORTAL_ESTIMATE_NOT_APPROVABLE' && error.status === 409);
  // Once the author sends it (or marks it sent in Estimates & payments), the completed job's balance is the sent total.
  await h.send(id);
  world.edit(id, completed(h.job(id)));
  const opened = await portalPost(handlers, cookie, { action: 'create_payment', request_id: 'pay-2' }, PAY);
  assert.deepEqual([opened.status, opened.body.amount, opened.body.purpose, world.sessions.get('cs_test_1').amount_total], [200, 1798, 'balance', 179800]);
  // A revision saved after that send is refused, and the checkout still open for the sent terms is expired.
  await h.save(cheaper, id);
  world.edit(id, completed(h.job(id)));
  const stale = await portalPost(handlers, cookie, { action: 'create_payment', request_id: 'pay-3' }, PAY);
  assert.deepEqual([stale.status, stale.body.code], [409, 'CUSTOMER_PORTAL_ESTIMATE_NOT_APPROVABLE']);
  assert.deepEqual([world.sessions.get('cs_test_1').status, world.sessions.size, world.ledger(id).status], ['expired', 1, 'expired']);
});

test('while a revision is withheld, a customer who paid keeps a printable receipt of the payments, never the unsent total or balance', async t => {
  const h = hub(), id = await h.save();
  await h.send(id);
  // Paid in full for the sent $1,798; the author then saves a $938 revision and has not sent it.
  const paid = { payment: { amount: 1798, verified: true, receiptUrl: 'https://pay.stripe.com/receipts/synthetic-paid', stripeSessions: [{ sessionId: 'cs_test_paid', paymentIntentId: 'pi_paid', amount: 1798, purpose: 'balance', verifiedAt: '2026-09-22T18:30:00.000Z' }] } };
  await h.save(cheaper, id);
  const job = { ...h.job(id), ...paid }, DOCS = { ...env, MONEY_DOCUMENT_ENABLED: 'true' };
  assert.equal(unsentQuoteDraft(job), true);
  portalStore(t, { [id]: job });
  const view = await portalView(portalHandlers(VIEWED), await portalCookie(id), DOCS);
  assert.deepEqual([view.body.payment.paid, view.body.payment.status, view.body.payment.total, view.body.payment.balance, view.body.payment.receiptUrl], [1798, 'received', 0, 0, 'https://pay.stripe.com/receipts/synthetic-paid']);
  assert.deepEqual(view.body.moneyDocuments.map(link => link.kind), ['receipt']);
  assert.deepEqual(moneyDocumentKinds(job, VIEWED), ['receipt']);
  // The receipt through the portal's document route: payments only.
  const documents = moneyDocumentHandlers({ now: () => new Date(VIEWED), session: async () => null, portalSession: async () => ({ jobId: id }), portalContext: async () => ({ session: { jobId: id }, job }) });
  const open = kind => documents.get({ env: DOCS, request: new Request(`https://easygaragecleaning.com/api/money-document?kind=${kind}`, { headers: { 'Sec-Fetch-Site': 'same-origin' } }) });
  const receipt = await open('receipt'), html = await receipt.text();
  assert.equal(receipt.status, 200);
  assert.match(html, /Payment received/);
  assert.match(html, /<span>Total paid<\/span><strong>\$1,798\.00<\/strong>/);
  assert.match(html, /href="https:\/\/pay\.stripe\.com\/receipts\/synthetic-paid"/);
  assert.match(html, /Your estimate is being updated/);
  for (const unsent of ['$938', '$469', 'Service total', 'Balance', 'Overpayment', 'Paid in full', 'Garage cleanout and reset', 'Wood shelving unit', 'class="pay"']) assert.equal(html.includes(unsent), false, unsent);
  for (const kind of ['estimate', 'invoice']) {
    assert.equal((await open(kind)).status, 404, kind);
    assert.throws(() => moneyDocumentModel(job, { kind, now: VIEWED }), error => error.code === 'money_document_unavailable', kind);
  }
  // A Hub print copy is unchanged: staff see the saved revision in full.
  assert.match(renderMoneyDocument(job, { kind: 'receipt', now: VIEWED, audience: 'staff' }), /Overpayment on file/);
  // A customer who has not paid has no documents while the revision is withheld.
  assert.deepEqual(moneyDocumentKinds(h.job(id), VIEWED), []);
});

test('a payment verified while a revision is withheld is recorded, and its reply never states the unsent balance', async t => {
  const h = hub(), id = await h.save(); await h.send(id);
  const world = checkoutWorld(t, { [id]: h.job(id) }), handlers = portalHandlers(VIEWED), cookie = await portalCookie(id);
  // The customer approves the sent $1,798 and opens its $899 deposit checkout, then pays it on Stripe.
  const shown = (await portalView(handlers, cookie, PAY)).body.estimate;
  assert.equal((await portalPost(handlers, cookie, approve(shown), PAY)).status, 200);
  const opened = await portalPost(handlers, cookie, { action: 'create_payment', request_id: 'pay-1' }, PAY);
  assert.deepEqual([opened.status, opened.body.amount, opened.body.purpose], [200, 899, 'deposit']);
  // (merge) Money is recorded only from a session read with its charge expanded (payment_intent.latest_charge).
  Object.assign(world.sessions.get('cs_test_1'), { status: 'complete', payment_status: 'paid', payment_intent: { id: 'pi_synthetic_deposit', latest_charge: { id: 'ch_synthetic_deposit', receipt_url: 'https://pay.stripe.com/receipts/synthetic-deposit' } } });
  // Before the payment is verified, the author saves a $938 revision and does not send it.
  await h.save(cheaper, id);
  world.edit(id, { ...world.job(id), estimate: h.job(id).estimate, total: h.job(id).total, priceQuoted: h.job(id).priceQuoted, quoteDraft: h.job(id).quoteDraft });
  assert.equal(unsentQuoteDraft(world.job(id)), true);
  // create_payment finds the paid checkout and records it: confirmed, with no balance against the unsent $938.
  const again = await portalPost(handlers, cookie, { action: 'create_payment', request_id: 'pay-2' }, PAY);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual([again.body.alreadyPaid, again.body.amountPaid, again.body.balanceWithheld, 'balance' in again.body], [true, 899, true, false]);
  assert.deepEqual([world.job(id).payment.amount, world.job(id).payment.verified, world.ledger(id).status], [899, true, 'settled'], 'the payment is recorded in full');
  // The browser return verifies the same session: still confirmed without a balance.
  const verified = await portalPost(handlers, cookie, { action: 'verify_payment', session_id: 'cs_test_1' }, PAY);
  assert.deepEqual([verified.status, verified.body.paid, verified.body.duplicate, verified.body.amountPaid, 'balance' in verified.body], [200, true, true, 899, false]);
  assert.equal(JSON.stringify([again.body, verified.body]).includes('39'), false, 'the $39 left against the unsent revision is never named');
  // Once the author sends the revision, the same verification states the balance again.
  await h.send(id);
  world.edit(id, { ...world.job(id), estimate: h.job(id).estimate });
  const sent = await portalPost(handlers, cookie, { action: 'verify_payment', session_id: 'cs_test_1' }, PAY);
  assert.deepEqual([sent.status, sent.body.duplicate, sent.body.balance, 'balanceWithheld' in sent.body], [200, true, 39, false]);
  // The portal page says only "Payment verified." when no balance comes back.
  const page = readFileSync(new URL('../customer-portal.html', import.meta.url), 'utf8');
  // (merge) TIPS thanks the customer for a tip between the two; with no balance the notice stays exactly 'Payment verified.'.
  assert.match(page, /typeof verified\.balance==='number'\?`Payment verified\..*? \$\{money\(verified\.balance\)\} remaining\.`:'Payment verified\.'/);
});
