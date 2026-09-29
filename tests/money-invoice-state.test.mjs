import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import vm from './helpers/vm-realm.mjs';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { customerMoneyTotals, invoiceIssued, invoiceStatus, invoiceTakesPayment, moneyInvoiceStateEnabled, paymentLedger } from '../functions/_lib/money-core.js';
import { customerMoneyState, recordCrewStripePayment, tipRefusal } from '../functions/_lib/customer-payments.js';
import { INVOICE_NUMBERS, moneyProjection, mutateMoney } from '../functions/_lib/money-service.js';
import { listMoney, moneyCsv } from '../functions/_lib/money-reports.js';
import { invoiceEligibility, issueInvoiceBatch, listInvoiceBatch } from '../functions/_lib/money-batch.js';
import { moneyDocumentKinds, moneyDocumentLinks, moneyDocumentModel, renderMoneyDocument } from '../functions/_lib/money-document.js';
import { reconcileLedger } from '../functions/_lib/money-ledger.js';
import { moneyStorage } from '../functions/_lib/money-storage.js';
import { PORTAL_INVOICE, PORTAL_PAY, portalLanding } from '../functions/_lib/portal-landing.js';
import { moneyHandlers } from '../functions/api/money.js';
import * as jobPayment from '../functions/api/job-payment.js';
import { stripeWebhookHandlers } from '../functions/api/stripe-webhook.js';
import { onRequestPost as highlevelPost } from '../functions/api/highlevel.js';
import { moneyReviewReasons, numberlessInvoice, parseArgs, planNumberlessInvoiceBackfill, runNumberlessInvoiceBackfill } from '../scripts/backfill-numberless-invoices.mjs';
import { applyWrite } from './helpers/commit-write.mjs';
import { portalCookie, portalHandlers, portalPost } from './helpers/portal-fixture.mjs';
import { NOW, OFF, ORIGIN, moneyJobs, paymentWorld } from './helpers/money-totals-fixture.mjs';

// FIX-MONEY-INVOICE-STATE (MONEY_INVOICE_STATE_ENABLED): a payment never creates or implies an invoice that was not
// issued, and a service credit is never cash. Every scenario runs with the flag off (today, byte for byte) and on.
const ON = { ...OFF, MONEY_INVOICE_STATE_ENABLED: 'true' };
const OWNER = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const ISSUED_AT = '2026-09-20T16:00:00.000Z';
const read = async response => ({ status: (await response).status, body: await (await response).clone().json() });
const conflict = () => Object.assign(new Error('Conflict'), { code: 'money_revision_conflict', status: 409 });
const pickInvoice = invoice => invoice && { number: invoice.number ?? null, status: invoice.status ?? null, amount: invoice.amount ?? null, paid: invoice.paid ?? null, balance: invoice.balance ?? null, issuedAt: invoice.issuedAt ?? null };
// A job the portal fixture's base shape describes, under the id of the audit example ('job-deposit' printed INV-EPOSIT).
const depositJob = (extra = {}) => ({ ...moneyJobs()['quote-only'], id: 'job-deposit', email: 'job-deposit@example.invalid', ...extra });

// The money store (moneyStorage's contract) over an in-memory map: revisions, create-only writes, remove paths.
function memoryStore(jobs, flags = {}) {
  const docs = new Map(Object.entries(jobs).map(([id, row]) => [`jobs/${id}`, { ...structuredClone(row), id, revision: `${id}-r0` }]));
  let n = 0, hook = null;
  const commits = [];
  return {
    docs, commits, totalsMode: 'off', paymentEvents: false, invoiceState: false, ...flags,
    beforeCommit: fn => { hook = fn; },
    job: id => docs.get(`jobs/${id}`),
    jobs: async () => [...docs].filter(([key]) => key.startsWith('jobs/')).map(([, row]) => structuredClone(row)),
    read: async (collection, id) => structuredClone(docs.get(`${collection}/${id}`) ?? null),
    async commit(writes) {
      if (hook) { const fn = hook; hook = null; await fn(writes); }
      for (const write of writes) { const old = docs.get(`${write.collection}/${write.id}`); if (write.exists ? !old : write.revision ? old?.revision !== write.revision : old) throw conflict(); }
      commits.push(structuredClone(writes));
      for (const write of writes) { const key = `${write.collection}/${write.id}`; docs.set(key, { ...applyWrite(write.revision || write.exists ? docs.get(key) : {}, write), id: write.id, revision: `r${++n}` }); }
    },
  };
}

// The same contract over the payment world's Firestore rows, so the portal, the crew return, the Hub lists and the
// Invoicing batch all see one job.
function worldStore(world, flags = {}) {
  const others = new Map();
  const job = id => world.store.rows.has(id) ? { ...world.store.job(id), id, revision: world.store.revision(id) } : null;
  return {
    totalsMode: 'off', paymentEvents: false, invoiceState: false, ...flags, others,
    jobs: async () => [...world.store.rows.keys()].map(job),
    read: async (collection, id) => collection === 'jobs' ? job(id) : structuredClone(others.get(`${collection}/${id}`) ?? null),
    async commit(writes) {
      for (const write of writes) { const old = write.collection === 'jobs' ? job(write.id) : others.get(`${write.collection}/${write.id}`); if (write.exists ? !old : write.revision ? old?.revision !== write.revision : old) throw conflict(); }
      for (const write of writes) {
        if (write.collection === 'jobs') { const { revision: _revision, ...value } = applyWrite(job(write.id), write); world.store.put(write.id, value); }
        else others.set(`${write.collection}/${write.id}`, { ...applyWrite(write.revision || write.exists ? others.get(`${write.collection}/${write.id}`) : {}, write), id: write.id, revision: `o${others.size + 1}` });
      }
    },
  };
}

test('MONEY_INVOICE_STATE_ENABLED is on only for exactly "true"; an issued invoice has a number, an issue time and a live status', () => {
  for (const [value, on] of [[undefined, false], ['', false], ['false', false], ['TRUE', false], ['1', false], ['yes', false], ['true', true], [' true ', true]]) {
    assert.equal(moneyInvoiceStateEnabled(value === undefined ? {} : { MONEY_INVOICE_STATE_ENABLED: value }), on, String(value));
  }
  assert.equal(moneyInvoiceStateEnabled(undefined), false);
  assert.equal(moneyStorage({}).invoiceState, false); assert.equal(moneyStorage(ON).invoiceState, true);
  const issued = { number: 'INV-1', status: 'issued', issuedAt: ISSUED_AT };
  assert.equal(invoiceIssued(issued), true);
  assert.equal(invoiceIssued({ ...issued, status: 'partial' }), true);
  for (const [invoice, label] of [[null, 'none'], [[], 'a list'], [{ amount: 1000, paid: 500, balance: 500, status: 'partial' }, 'a payment wrote it'], [{ ...issued, number: '  ' }, 'a blank number'],
    [{ ...issued, issuedAt: undefined }, 'numbered by an offline payment, never issued'], [{ ...issued, issuedAt: 'soon' }, 'an unreadable issue time'], ...['void', 'draft', 'superseded', 'VOID'].map(status => [{ ...issued, status }, status])]) {
    assert.equal(invoiceIssued(invoice), false, label);
  }
  assert.equal(invoiceIssued({ number: 'JOBBER-12', status: 'issued', issuedAt: null, source: 'jobber_import' }), true, 'an imported Jobber balance without an issue date is still an issued invoice');
});

test('invoiceStatus: an invoice with neither a number nor issuedAt is not_issued with invoiceState; every other invoice reads exactly as before', () => {
  const job = moneyJobs()['deposit-paid'], fabricated = { ...job, invoice: { amount: 1000, paid: 500, balance: 500, status: 'partial', updatedAt: NOW } };
  assert.equal(invoiceStatus(fabricated, NOW), 'partial', 'today the card deposit reads as a partly paid invoice');
  for (const unified of [false, true]) {
    assert.equal(invoiceStatus(fabricated, NOW, { unified, invoiceState: true }), 'not_issued');
    assert.equal(invoiceStatus({ ...fabricated, invoice: { ...fabricated.invoice, status: 'paid' } }, NOW, { unified, invoiceState: true }), 'not_issued');
  }
  const invoices = [undefined, { number: 'INV-1', status: 'issued', issuedAt: ISSUED_AT, dueDate: '2026-09-29' }, { number: 'INV-2', status: 'issued', issuedAt: ISSUED_AT, dueDate: '2026-09-20' },
    { number: 'INV-OFFLINE', status: 'partial', amount: 1000 }, { status: 'issued', issuedAt: ISSUED_AT, amount: 1000 }, { number: 'INV-3', status: 'void', issuedAt: ISSUED_AT }, { number: 'INV-4', status: 'superseded', issuedAt: ISSUED_AT }, { number: 'INV-5', status: 'draft' }];
  for (const invoice of invoices) for (const unified of [false, true]) {
    const row = invoice === undefined ? job : { ...job, invoice };
    assert.equal(invoiceStatus(row, NOW, { unified, invoiceState: true }), invoiceStatus(row, NOW, { unified }), JSON.stringify(invoice));
  }
});

test('a portal card deposit (stubbed Stripe) writes no invoice; the invoice list leaves the job out and the Invoicing batch invoices it once done', async t => {
  for (const env of [OFF, ON]) await t.test(env === ON ? 'flag on' : 'flag off (today)', async t => {
    const on = env === ON, world = paymentWorld(t, { 'job-deposit': depositJob() }), handlers = portalHandlers(NOW), cookie = await portalCookie('job-deposit');
    const pay = await portalPost(handlers, cookie, { action: 'create_payment', request_id: 'pay-job-deposit' }, env), session = world.created.at(-1);
    assert.deepEqual([pay.status, session.unitAmount], [200, 50000]);
    world.complete(session.id, { paymentIntentId: 'pi_job_deposit', chargeId: 'ch_job_deposit', receiptUrl: 'https://pay.stripe.com/receipts/job-deposit' });
    const verified = await portalPost(handlers, cookie, { action: 'verify_payment', session_id: session.id }, env);
    assert.deepEqual([verified.status, verified.body.paid, verified.body.amountPaid, verified.body.balance], [200, true, 500, 500]);
    const saved = world.store.job('job-deposit');
    assert.deepEqual([saved.payment.amount, saved.payment.verified, saved.deposit.paidAmount, saved.deposit.status, saved.paymentSyncPayload.balance], [500, true, 500, 'paid', 500], 'the payment and the deposit are recorded either way');
    assert.deepEqual(paymentLedger(saved).entries.map(entry => [entry.id, entry.kind, entry.amountCents]), [[`stripe:${session.id}`, 'deposit', 50000]], 'the ledger holds the card payment');
    if (on) assert.equal(saved.invoice, undefined, 'no invoice is written for a job no one invoiced');
    else assert.deepEqual(pickInvoice(saved.invoice), { number: null, status: 'partial', amount: 1000, paid: 500, balance: 500, issuedAt: null }, 'today: a numberless, never-issued partial invoice');
    const store = worldStore(world, { invoiceState: on });
    const invoices = await listMoney(store, { view: 'invoices' }, NOW);
    assert.deepEqual(invoices.items.map(row => [row.number, row.status, row.balanceCents]), on ? [] : [['', 'partial', 50000]]);
    // The receipt names the card payment by its ledger entry id and prints no invoice number.
    const receipt = renderMoneyDocument(saved, { kind: 'receipt', now: NOW, audience: 'staff', invoiceState: on });
    if (on) { assert.ok(receipt.includes(`stripe:${session.id} · Garage Turnaround`)); assert.ok(!receipt.includes('INV-')); }
    else assert.ok(receipt.includes('INV-EPOSIT · Garage Turnaround'), 'today the receipt prints the made-up INV-EPOSIT');
    // The work is done: the Invoicing batch.
    world.store.edit('job-deposit', { status: 'completed', pipelineStatus: 'completed', completedAt: NOW });
    const list = await listInvoiceBatch(store, OWNER, NOW);
    if (!on) {
      assert.deepEqual(list.candidates, [], 'today the card-paid job is refused as already invoiced');
      assert.deepEqual(list.open.map(row => [row.jobId, row.invoiceStatus, row.invoice.number]), [['job-deposit', 'partial', '']]);
      assert.equal(invoiceEligibility(await store.read('jobs', 'job-deposit'), NOW).reason, 'already_invoiced');
      return;
    }
    assert.deepEqual(list.candidates.map(row => [row.jobId, row.invoiceStatus, row.totalCents, row.paidCents, row.balanceCents]), [['job-deposit', 'not_issued', 100000, 50000, 50000]]);
    const batch = await issueInvoiceBatch(store, OWNER, { action: 'issue', requestId: randomUUID(), dueDate: '2026-09-29', items: [{ jobId: 'job-deposit', expectedRevision: list.candidates[0].revision }] }, NOW);
    assert.deepEqual(batch.summary, { total: 1, issued: 1, replayed: 0, failed: 0, notAttempted: 0 });
    // Issued now with the deposit applied: the balance is what the work still owes, and it reads partly paid.
    assert.deepEqual([batch.results[0].invoice.number, batch.results[0].invoice.status, batch.results[0].invoice.amountCents, batch.results[0].balanceCents], ['INV-EPOSIT', 'partial', 100000, 50000]);
    const issued = world.store.job('job-deposit');
    assert.deepEqual(pickInvoice(issued.invoice), { number: 'INV-EPOSIT', status: 'issued', amount: 1000, paid: 500, balance: 500, issuedAt: NOW });
    assert.deepEqual([issued.invoice.dueDate, issued.invoice.balanceCents, issued.status], ['2026-09-29', 50000, 'invoiced']);
    assert.equal(store.others.get(`${INVOICE_NUMBERS}/n_INV-EPOSIT`).jobId, 'job-deposit', 'the number is reserved when the invoice is issued');
    assert.deepEqual((await listMoney(store, { view: 'invoices' }, NOW)).items.map(row => [row.number, row.status, row.paidCents, row.balanceCents]), [['INV-EPOSIT', 'partial', 50000, 50000]]);
    assert.equal(invoiceEligibility(await store.read('jobs', 'job-deposit'), NOW, { invoiceState: true }).reason, 'already_invoiced');
    // An issued invoice is listed beside the payment on the receipt.
    const doc = moneyDocumentModel(issued, { kind: 'receipt', now: NOW, invoiceState: true });
    assert.equal(doc.number, `stripe:${session.id}`); assert.deepEqual(doc.dates.at(-1), ['Invoice', 'INV-EPOSIT']);
  });
});

test('the Stripe webhook books a portal card deposit without an invoice when none was issued, and exactly as today with the flag off', async t => {
  for (const flags of [OFF, ON]) await t.test(flags === ON ? 'flag on' : 'flag off (today)', async t => {
    const env = { ...flags, STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_invoice_state' }, world = paymentWorld(t, { 'job-deposit': depositJob() });
    const pay = await portalPost(portalHandlers(NOW), await portalCookie('job-deposit'), { action: 'create_payment', request_id: 'pay-job-deposit-webhook' }, env), session = world.created.at(-1);
    assert.deepEqual([pay.status, session.unitAmount], [200, 50000]);
    world.complete(session.id, { paymentIntentId: 'pi_job_deposit_webhook', chargeId: 'ch_job_deposit_webhook', receiptUrl: 'https://pay.stripe.com/receipts/job-deposit-webhook' });
    // The customer never comes back to the portal: only Stripe's checkout.session.completed delivery books the charge.
    const timestamp = Math.floor(Date.parse(NOW) / 1000), raw = JSON.stringify({ id: 'evt_synthetic_invoice_state', type: 'checkout.session.completed', created: timestamp, data: { object: { ...world.sessions.get(session.id), payment_intent: 'pi_job_deposit_webhook' } } });
    const signature = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex');
    const delivered = await read(stripeWebhookHandlers({ now: () => new Date(NOW) }).post({ env, request: new Request(`${ORIGIN}/api/stripe-webhook`, { method: 'POST', headers: { 'Stripe-Signature': `t=${timestamp},v1=${signature}` }, body: raw }) }));
    assert.deepEqual([delivered.status, delivered.body.recorded, delivered.body.duplicate], [200, true, false]);
    const saved = world.store.job('job-deposit');
    assert.deepEqual([saved.payment.amount, saved.deposit.paidAmount, saved.paymentSyncPayload.balance], [500, 500, 500]);
    assert.deepEqual(paymentLedger(saved).entries.map(entry => [entry.id, entry.kind, entry.amountCents]), [[`stripe:${session.id}`, 'deposit', 50000]]);
    if (flags === ON) assert.equal(saved.invoice, undefined);
    else assert.deepEqual(pickInvoice(saved.invoice), { number: null, status: 'partial', amount: 1000, paid: 500, balance: 500, issuedAt: null });
  });
});

test('a card balance on an issued invoice still updates it, and a crew card return reports the balance itself when no invoice was issued', async t => {
  const issuedInvoice = { number: 'INV-B-0002', status: 'issued', amount: 1000, paid: 500, balance: 500, dueDate: '2026-09-29', issuedAt: ISSUED_AT, termsVersion: '2026-09' };
  const done = { status: 'completed', pipelineStatus: 'completed', completedAt: NOW };
  const jobs = { 'crew-open': { ...moneyJobs()['deposit-paid'], id: 'crew-open', ...done }, 'crew-invoiced': { ...moneyJobs()['deposit-paid'], id: 'crew-invoiced', ...done, invoice: issuedInvoice } };
  const checkout = id => ({ id: `cs_test_crew_${id.replace(/-/g, '_')}`, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid', client_reference_id: id, currency: 'usd', amount_total: 50000, livemode: false,
    metadata: { kind: 'egc_job_payment', job_id: id, created_by: 'crew1' }, payment_intent: { id: `pi_crew_${id.replace(/-/g, '_')}`, latest_charge: { id: `ch_crew_${id.replace(/-/g, '_')}`, receipt_url: `https://pay.stripe.com/receipts/${id}` } } });
  for (const env of [OFF, ON]) await t.test(env === ON ? 'flag on' : 'flag off (today)', async t => {
    const on = env === ON, world = paymentWorld(t, jobs);
    const open = await recordCrewStripePayment(env, checkout('crew-open'), { expectedJobId: 'crew-open', recordedBy: 'crew1', now: NOW });
    assert.deepEqual([open.paid, open.balance, world.store.job('crew-open').payment.amount], [true, 0, 1000]);
    if (on) { assert.equal(world.store.job('crew-open').invoice, undefined); assert.deepEqual(open.invoice, {}, 'the crew copy is the job\'s invoice as it was: none'); }
    else assert.deepEqual(pickInvoice(world.store.job('crew-open').invoice), { number: null, status: 'paid', amount: 1000, paid: 1000, balance: 0, issuedAt: null });
    const billed = await recordCrewStripePayment(env, checkout('crew-invoiced'), { expectedJobId: 'crew-invoiced', recordedBy: 'crew1', now: NOW });
    assert.deepEqual(pickInvoice(world.store.job('crew-invoiced').invoice), { number: 'INV-B-0002', status: 'paid', amount: 1000, paid: 1000, balance: 0, issuedAt: ISSUED_AT }, 'an issued invoice takes the payment, flag on or off');
    assert.equal(billed.invoice.status, 'paid');
  });
  await t.test('the crew return adds the balance only with the flag on, and closeout reads it', async t => {
    const world = paymentWorld(t, { 'crew-open': jobs['crew-open'] }), staff = (await createHubSessionCookie(ON, 'ZacB')).split(';')[0];
    const created = await read(jobPayment.onRequestPost({ env: ON, request: new Request(`${ORIGIN}/api/job-payment`, { method: 'POST', headers: { Cookie: staff, Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ job_id: 'crew-open', request_id: 'crew-open-card-1', amount_cents: 30000 }) }) }));
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const session = world.created.at(-1);
    world.complete(session.id, { paymentIntentId: 'pi_crew_open_card', chargeId: 'ch_crew_open_card', receiptUrl: 'https://pay.stripe.com/receipts/crew-open-card' });
    const verify = env => read(jobPayment.jobPaymentVerifier({ now: () => new Date(NOW) })({ env, request: new Request(`${ORIGIN}/api/job-payment?session_id=${session.id}`, { headers: { Cookie: staff, Origin: ORIGIN } }) }));
    const first = await verify(ON), again = await verify(OFF);
    assert.deepEqual([first.status, first.body.duplicate, first.body.balance, first.body.invoice], [200, false, 200, {}]);
    assert.deepEqual([again.status, again.body.duplicate, Object.hasOwn(again.body, 'balance')], [200, true, false], 'flag off: the response is today\'s');
    assert.equal(world.store.job('crew-open').invoice, undefined);
    // crew/postjob.html: the closeout hint reads the server balance when it is given, else the invoice's (today).
    const html = readFileSync(new URL('../crew/postjob.html', import.meta.url), 'utf8'), start = html.indexOf('async function recordVerifiedStripePayment('), end = html.indexOf('async function syncStripePaymentToHighLevel(', start);
    const context = vm.createContext({ ACTIVE: { jobId: 'crew-open' } });
    vm.runInContext(html.slice(start, end), context);
    const saved = await vm.runInContext('recordVerifiedStripePayment(result)', Object.assign(context, { result: first.body }));
    assert.equal(saved.balance, 200);
    const legacy = await vm.runInContext('recordVerifiedStripePayment(result)', Object.assign(context, { result: { ...again.body, invoice: { balance: 20 } } }));
    assert.equal(Object.hasOwn(legacy, 'balance'), false);
    assert.match(html, /balance=Number\(\(saved\.balance\?\?saved\.invoice\.balance\)\|\|0\);/);
  });
});

test('payment.record_offline on a job no one invoiced reserves no number and writes no invoice; the receipt names the payment', async () => {
  const job = { ...moneyJobs()['quote-only'], customerId: 'cust-offline' };
  const run = async flags => {
    const store = memoryStore({ 'job-abc123': job }, flags), requestId = randomUUID();
    store.docs.set('customers/cust-offline', { id: 'cust-offline', revision: 'c-r0', name: 'Synthetic Customer' });
    const result = await mutateMoney(store, OWNER, { action: 'payment.record_offline', requestId, jobId: 'job-abc123', expectedRevision: 'job-abc123-r0', amountCents: 30000, method: 'check', reference: 'CHK-4410' }, NOW);
    return { store, requestId, result, saved: store.job('job-abc123'), writes: store.commits.flat() };
  };
  const today = await run({}), fixed = await run({ invoiceState: true });
  // Today: INV-{last 6} is reserved and a partial invoice with no issue time is written (MONEY-12).
  assert.deepEqual(pickInvoice(today.saved.invoice), { number: 'INV-ABC123', status: 'partial', amount: 1000, paid: 300, balance: 700, issuedAt: null });
  assert.ok(today.writes.some(write => write.collection === INVOICE_NUMBERS));
  assert.equal(today.result.job.invoice.status, 'partial');
  // Fixed: the payment, the ledger and the audit only.
  assert.equal(fixed.saved.invoice, undefined);
  assert.equal(fixed.writes.some(write => write.collection === INVOICE_NUMBERS), false, 'no invoice number is reserved');
  assert.deepEqual([fixed.saved.payment.amount, fixed.saved.payment.verified, fixed.saved.payment.reference], [300, true, 'CHK-4410']);
  assert.deepEqual(fixed.saved.paymentLedger.map(row => [row.id, row.kind, row.amountCents, row.source]), [[`offline:${fixed.requestId.toLowerCase()}`, 'offline', 30000, 'hub_offline']]);
  assert.deepEqual([fixed.result.job.invoice.status, fixed.result.job.invoice.number, fixed.result.job.totals.balanceCents], ['not_issued', null, 70000]);
  assert.deepEqual(Object.keys(fixed.saved).filter(key => !Object.hasOwn(today.saved, key)), [], 'nothing new is written');
  assert.deepEqual(Object.keys(today.saved).filter(key => !Object.hasOwn(fixed.saved, key)), ['invoice']);
  for (const key of ['payment', 'paymentLedgerStatus', 'moneyUpdatedAt', 'status', 'pipelineStatus']) assert.deepEqual(fixed.saved[key], today.saved[key], key);
  // The customer's payment mirror (a best-effort commit after the job's) is written exactly as before.
  const mirror = run => run.writes.find(write => write.collection === 'customers');
  assert.deepEqual(mirror(fixed), mirror(today));
  assert.deepEqual([mirror(fixed).patch.lastPaymentStatus, mirror(fixed).patch.lastPaymentBalance], ['partial', 700]);
  // The receipt text: the ledger entry id, the check, no invoice number.
  const doc = moneyDocumentModel(fixed.saved, { kind: 'receipt', now: NOW, invoiceState: true });
  assert.equal(doc.number, `offline:${fixed.requestId.toLowerCase()}`);
  assert.deepEqual([doc.status, doc.statusLabel, doc.dates], ['partial', 'Partial payment', [['Receipt date', 'September 22, 2026']]]);
  assert.deepEqual(doc.payments.map(row => [row.label, row.amountCents]), [['Payment · Check', 30000]]);
  const html = renderMoneyDocument(fixed.saved, { kind: 'receipt', now: NOW, invoiceState: true });
  assert.ok(html.includes(`<title>Receipt offline:${fixed.requestId.toLowerCase()} · Easy Garage Cleaning</title>`));
  assert.ok(html.includes(`<p>offline:${fixed.requestId.toLowerCase()} · Garage Turnaround</p>`));
  assert.equal(/INV-/.test(html), false);
  assert.ok(renderMoneyDocument(today.saved, { kind: 'receipt', now: NOW }).includes('<p>INV-ABC123 · Garage Turnaround</p>'), 'today the receipt prints the reserved number');
  // A staff copy of the invoice: not issued, no number, never "Issued" status.
  const draft = moneyDocumentModel(fixed.saved, { kind: 'invoice', now: NOW, audience: 'staff', invoiceState: true });
  assert.deepEqual([draft.status, draft.statusLabel, draft.number, draft.notice, draft.dates[0]], ['not_issued', 'Not issued', '', 'Draft: this invoice has not been issued yet.', ['Issued', 'Not issued yet']]);
  const legacy = moneyDocumentModel(today.saved, { kind: 'invoice', now: NOW, audience: 'staff' });
  assert.deepEqual([legacy.status, legacy.number, legacy.dates[0]], ['partial', 'INV-ABC123', ['Issued', 'Not issued yet']], 'today: a partly paid invoice that was never issued');
  // Customers are offered the receipt only.
  assert.deepEqual(moneyDocumentKinds(fixed.saved, NOW, { invoiceState: true }), ['estimate', 'receipt']);
  assert.deepEqual(moneyDocumentKinds(today.saved, NOW), ['estimate', 'invoice', 'receipt']);
  assert.deepEqual(moneyDocumentLinks(today.saved, { enabled: true, now: NOW, invoiceState: true }).map(link => link.kind), ['estimate', 'invoice', 'receipt'], 'an invoice an older offline payment numbered reads as before (the backfill lists it for review)');
});

test('payment.record_offline on an issued invoice keeps its number, reserves nothing and pays it down; a made-up invoice is left alone', async () => {
  const issued = { number: 'INV-LEGACY-7', status: 'issued', amount: 1000, paid: 0, balance: 1000, dueDate: '2026-09-29', issuedAt: ISSUED_AT, source: 'egc_hub' };
  const base = { ...moneyJobs()['quote-only'], customerId: 'cust-issued', status: 'completed', pipelineStatus: 'completed', completedAt: NOW };
  for (const flags of [{}, { invoiceState: true }]) {
    const store = memoryStore({ 'job-issued': { ...base, invoice: issued } }, flags);
    const result = await mutateMoney(store, OWNER, { action: 'payment.record_offline', requestId: randomUUID(), jobId: 'job-issued', expectedRevision: 'job-issued-r0', amountCents: 100000, method: 'cash', reference: 'Receipt 9' }, NOW);
    assert.deepEqual(pickInvoice(store.job('job-issued').invoice), { number: 'INV-LEGACY-7', status: 'paid', amount: 1000, paid: 1000, balance: 0, issuedAt: ISSUED_AT });
    assert.deepEqual([result.job.invoice.status, store.job('job-issued').status], ['paid', 'paid']);
    // Today the number is reserved on the way (a legacy number never reserved); with the flag nothing is reserved.
    assert.equal(store.commits.flat().some(write => write.collection === INVOICE_NUMBERS), !flags.invoiceState);
  }
  const fabricated = { amount: 1000, paid: 200, balance: 800, status: 'partial', updatedAt: '2026-09-20T12:00:00.000Z' };
  const store = memoryStore({ 'job-made-up': { ...base, id: 'job-made-up', invoice: fabricated, payment: { amount: 200, verified: true, method: 'stripe', stripeSessions: [{ sessionId: 'cs_test_made_up', paymentIntentId: 'pi_made_up', amount: 200, purpose: 'deposit', verifiedAt: '2026-09-20T12:00:00.000Z' }] } } }, { invoiceState: true });
  const result = await mutateMoney(store, OWNER, { action: 'payment.record_offline', requestId: randomUUID(), jobId: 'job-made-up', expectedRevision: 'job-made-up-r0', amountCents: 30000, method: 'check', reference: 'CHK-2' }, NOW);
  assert.deepEqual(store.job('job-made-up').invoice, fabricated, 'the old made-up invoice is not touched (the backfill removes it)');
  assert.deepEqual([result.job.invoice.status, result.job.totals.balanceCents], ['not_issued', 50000]);
  // A deposit never touched the invoice, flag or not.
  const deposit = memoryStore({ 'job-dep': { ...moneyJobs()['quote-only'] } }, { invoiceState: true });
  await mutateMoney(deposit, OWNER, { action: 'deposit.record_offline', requestId: randomUUID(), jobId: 'job-dep', expectedRevision: 'job-dep-r0', amountCents: 50000, method: 'check', reference: 'CHK-3' }, NOW);
  assert.equal(deposit.job('job-dep').invoice, undefined);
});

// An invoice that already has a number but was never issued (an INV-{last 6} a Hub offline payment reserved before the
// flag, or the legacy browser tool's): every payment keeps its paid, balance and status current exactly as before the
// flag, and never reserves a number; a numberless invoice (one a payment wrote) is still left alone.
const NUMBERED = { number: 'INV-MBERED', status: 'partial', paid: 500, balance: 500 };
const MADE_UP = { amount: 1000, paid: 500, balance: 500, status: 'partial', updatedAt: '2026-09-19T12:00:00.000Z' };
const numberedJob = (id, invoice) => ({ ...moneyJobs()['deposit-paid'], id, customerId: 'cust-numbered', status: 'completed', pipelineStatus: 'completed', completedAt: NOW, invoice: structuredClone(invoice) });

test('invoiceTakesPayment: an issued invoice, or one with a number that is not void, superseded or draft; never a numberless one', () => {
  for (const [invoice, label] of [[{ number: 'INV-1', status: 'issued', issuedAt: ISSUED_AT }, 'issued'], [{ number: 'JOBBER-12', status: 'issued', issuedAt: null, source: 'jobber_import' }, 'a Jobber import'],
    [NUMBERED, 'numbered by an offline payment, never issued'], [{ ...NUMBERED, status: 'paid' }, 'numbered and paid'], [{ ...NUMBERED, status: undefined }, 'numbered, no status'], [{ number: 'INV-ABC123', status: 'Partial' }, 'the legacy INV-{last 6}']]) {
    assert.equal(invoiceTakesPayment(invoice), true, label);
  }
  for (const [invoice, label] of [[undefined, 'none'], [null, 'null'], [[], 'a list'], [MADE_UP, 'a payment wrote it'], [{ ...NUMBERED, number: '   ' }, 'a blank number'], [{ ...NUMBERED, number: 7 }, 'a number that is not text'],
    ...['void', 'superseded', 'draft', 'VOID', 'Draft'].flatMap(status => [[{ ...NUMBERED, status }, `numbered ${status}`], [{ number: 'INV-1', status, issuedAt: ISSUED_AT }, `issued ${status}`]])]) {
    assert.equal(invoiceTakesPayment(invoice), false, label);
  }
  // invoiceIssued itself is unchanged: the invoice list and the Invoicing batch read the status, never this rule.
  assert.equal(invoiceIssued(NUMBERED), false);
  assert.equal(invoiceStatus(numberedJob('job-numbered', NUMBERED), NOW, { invoiceState: true }), invoiceStatus(numberedJob('job-numbered', NUMBERED), NOW));
});

test('payment.record_offline pays down an invoice that has a number but was never issued, exactly as before the flag, and reserves no number', async () => {
  const run = async (flags, invoice) => {
    const store = memoryStore({ 'job-numbered': numberedJob('job-numbered', invoice) }, flags);
    store.docs.set('customers/cust-numbered', { id: 'cust-numbered', revision: 'c-r0', name: 'Synthetic Customer' });
    const result = await mutateMoney(store, OWNER, { action: 'payment.record_offline', requestId: '7d3f1e2a-9b4c-4d5e-8f60-1a2b3c4d5e6f', jobId: 'job-numbered', expectedRevision: 'job-numbered-r0', amountCents: 50000, method: 'check', reference: 'CHK-5150' }, NOW);
    return { result, saved: store.job('job-numbered'), writes: store.commits.flat() };
  };
  const today = await run({}, NUMBERED), fixed = await run({ invoiceState: true }, NUMBERED);
  for (const [label, { result, saved }] of [['flag off (today)', today], ['flag on', fixed]]) {
    assert.deepEqual([saved.invoice.number, saved.invoice.status, saved.invoice.balance, saved.invoice.paid, saved.invoice.balanceCents, saved.invoice.paidCents, saved.invoice.issuedAt], ['INV-MBERED', 'paid', 0, 1000, 0, 100000, undefined], label);
    assert.deepEqual([result.job.invoice.status, result.job.invoice.number, result.job.totals.balanceCents, saved.status, saved.payment.amount], ['paid', 'INV-MBERED', 0, 'paid', 1000], label);
  }
  assert.deepEqual(fixed.saved.invoice, today.saved.invoice, 'the stored invoice is exactly what the payment wrote before the flag');
  assert.deepEqual(fixed.writes.filter(write => write.collection === 'customers'), today.writes.filter(write => write.collection === 'customers'), 'the customer mirror too');
  // Before the flag the payment also reserved the number on the way; with the flag nothing is reserved or created.
  assert.deepEqual(today.writes.filter(write => write.collection === INVOICE_NUMBERS).map(write => [write.id, write.patch.number, write.patch.jobId]), [['n_INV-MBERED', 'INV-MBERED', 'job-numbered']]);
  assert.deepEqual(fixed.writes.filter(write => write.collection === INVOICE_NUMBERS), []);
  // A numberless invoice (a payment wrote it) is still left alone with the flag, and gets no number; today it is numbered.
  const madeUpToday = await run({}, MADE_UP), madeUpFixed = await run({ invoiceState: true }, MADE_UP);
  assert.deepEqual(madeUpFixed.saved.invoice, MADE_UP);
  assert.deepEqual([madeUpFixed.writes.some(write => write.collection === INVOICE_NUMBERS), madeUpFixed.result.job.invoice.status, madeUpFixed.saved.payment.amount], [false, 'not_issued', 1000]);
  assert.deepEqual([madeUpToday.saved.invoice.number, madeUpToday.saved.invoice.status], ['INV-MBERED', 'paid']);
  // A numbered draft is never paid down with the flag (it is not live); today it is.
  const draftFixed = await run({ invoiceState: true }, { ...NUMBERED, status: 'draft' });
  assert.deepEqual([draftFixed.saved.invoice, draftFixed.writes.some(write => write.collection === INVOICE_NUMBERS)], [{ ...NUMBERED, status: 'draft' }, false]);
});

test('a card balance through Stripe (crew link and portal) pays down an invoice that has a number but was never issued, exactly as before the flag', async t => {
  const checkout = id => ({ id: `cs_test_crew_${id.replace(/-/g, '_')}`, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid', client_reference_id: id, currency: 'usd', amount_total: 50000, livemode: false,
    metadata: { kind: 'egc_job_payment', job_id: id, created_by: 'crew1' }, payment_intent: { id: `pi_crew_${id.replace(/-/g, '_')}`, latest_charge: { id: `ch_crew_${id.replace(/-/g, '_')}`, receipt_url: `https://pay.stripe.com/receipts/${id}` } } });
  const saved = {};
  for (const env of [OFF, ON]) await t.test(env === ON ? 'flag on' : 'flag off (today)', async t => {
    const on = env === ON, world = paymentWorld(t, { 'crew-numbered': numberedJob('crew-numbered', NUMBERED), 'crew-made-up': numberedJob('crew-made-up', MADE_UP), 'portal-numbered': numberedJob('portal-numbered', NUMBERED) });
    // The crew card link (recordStripeCheckout, as the Stripe webhook and a held-review settle run it).
    const paid = await recordCrewStripePayment(env, checkout('crew-numbered'), { expectedJobId: 'crew-numbered', recordedBy: 'crew1', now: NOW });
    const crew = world.store.job('crew-numbered');
    assert.deepEqual([paid.paid, paid.balance, crew.payment.amount], [true, 0, 1000]);
    assert.deepEqual([crew.invoice.number, crew.invoice.status, crew.invoice.balance, crew.invoice.paid, crew.invoice.amount, crew.invoice.issuedAt], ['INV-MBERED', 'paid', 0, 1000, 1000, undefined]);
    assert.deepEqual(paid.invoice, crew.invoice, 'the crew return reads the invoice it paid down');
    // The customer's portal checkout for the same $500 balance.
    const handlers = portalHandlers(NOW), cookie = await portalCookie('portal-numbered');
    const pay = await portalPost(handlers, cookie, { action: 'create_payment', request_id: 'pay-portal-numbered' }, env), session = world.created.at(-1);
    assert.deepEqual([pay.status, session.unitAmount, session.jobId], [200, 50000, 'portal-numbered']);
    world.complete(session.id, { paymentIntentId: 'pi_portal_numbered', chargeId: 'ch_portal_numbered', receiptUrl: 'https://pay.stripe.com/receipts/portal-numbered' });
    const verified = await portalPost(handlers, cookie, { action: 'verify_payment', session_id: session.id }, env);
    assert.deepEqual([verified.status, verified.body.paid, verified.body.balance], [200, true, 0]);
    const portal = world.store.job('portal-numbered');
    assert.deepEqual([portal.invoice.number, portal.invoice.status, portal.invoice.balance, portal.invoice.paid, portal.payment.amount], ['INV-MBERED', 'paid', 0, 1000, 1000]);
    // A numberless invoice through the same path: left alone with the flag, paid down today.
    await recordCrewStripePayment(env, checkout('crew-made-up'), { expectedJobId: 'crew-made-up', recordedBy: 'crew1', now: NOW });
    const madeUp = world.store.job('crew-made-up');
    assert.equal(madeUp.payment.amount, 1000);
    if (on) assert.deepEqual(madeUp.invoice, MADE_UP);
    else assert.deepEqual(pickInvoice(madeUp.invoice), { number: null, status: 'paid', amount: 1000, paid: 1000, balance: 0, issuedAt: null });
    // No number is reserved or created by a card payment: the jobs are the only documents written.
    assert.deepEqual([...world.store.rows.keys()].sort(), ['crew-made-up', 'crew-numbered', 'portal-numbered']);
    saved[on ? 'on' : 'off'] = { crew: crew.invoice, portal: portal.invoice };
  });
  assert.deepEqual(saved.on, saved.off, 'the stored invoices are exactly what the card payments wrote before the flag');
});

test('a portal gift or account credit writes an invoice only when one was issued, and FUN-33 never counts it as cash', async t => {
  const wallet = { cards: [{ id: 'credit-1', label: 'EGC service credit', issuedAmount: 300, remainingAmount: 300, creditClass: 'courtesy' }] };
  const issuedInvoice = { number: 'INV-C-0001', status: 'issued', amount: 1000, paid: 500, balance: 500, dueDate: '2026-09-29', issuedAt: ISSUED_AT };
  const jobs = () => ({ 'credit-open': { ...moneyJobs()['deposit-paid'], id: 'credit-open', giftWallet: wallet }, 'credit-invoiced': { ...moneyJobs()['deposit-paid'], id: 'credit-invoiced', giftWallet: wallet, invoice: issuedInvoice } });
  for (const env of [OFF, ON]) await t.test(env === ON ? 'flag on' : 'flag off (today)', async t => {
    const on = env === ON, world = paymentWorld(t, jobs()), handlers = portalHandlers(NOW);
    for (const id of ['credit-open', 'credit-invoiced']) {
      const credit = await portalPost(handlers, await portalCookie(id), { action: 'apply_gift_credit', card_id: 'credit-1', amount: 300, request_id: `credit-${id}` }, env);
      assert.deepEqual([credit.status, credit.body.applied, credit.body.balance], [200, 300, 200], id);
      const saved = world.store.job(id);
      assert.deepEqual([saved.payment.amount, saved.payment.giftCreditApplied, saved.payment.method], [800, 300, 'mixed_with_gift_credit']);
    }
    if (on) assert.equal(world.store.job('credit-open').invoice, undefined, 'a credit never writes an invoice no one issued');
    else assert.deepEqual(pickInvoice(world.store.job('credit-open').invoice), { number: null, status: 'partial', amount: 1000, paid: 800, balance: 200, issuedAt: null });
    assert.deepEqual(pickInvoice(world.store.job('credit-invoiced').invoice), { number: 'INV-C-0001', status: 'partial', amount: 1000, paid: 800, balance: 200, issuedAt: ISSUED_AT });
    // FUN-33: the credit is a credit.redeemed event, never a payment.received (cash) one.
    const events = world.store.events();
    assert.deepEqual(events.map(event => [event.type, event.data.amountCents, event.data.creditClass]), [['credit.redeemed', 30000, 'courtesy'], ['credit.redeemed', 30000, 'courtesy']]);
  });
});

test('a portal gift or account credit keeps an invoice that has a number but was never issued current, exactly as before the flag; a numberless one is left alone', async t => {
  const wallet = { cards: [{ id: 'credit-1', label: 'EGC service credit', issuedAmount: 300, remainingAmount: 300, creditClass: 'courtesy' }] };
  const saved = {};
  for (const env of [OFF, ON]) await t.test(env === ON ? 'flag on' : 'flag off (today)', async t => {
    const on = env === ON, world = paymentWorld(t, { 'credit-numbered': { ...numberedJob('credit-numbered', NUMBERED), giftWallet: wallet }, 'credit-made-up': { ...numberedJob('credit-made-up', MADE_UP), giftWallet: wallet } }), handlers = portalHandlers(NOW);
    for (const id of ['credit-numbered', 'credit-made-up']) {
      const credit = await portalPost(handlers, await portalCookie(id), { action: 'apply_gift_credit', card_id: 'credit-1', amount: 300, request_id: `credit-${id}` }, env);
      assert.deepEqual([credit.status, credit.body.applied, credit.body.balance, world.store.job(id).payment.amount], [200, 300, 200, 800], id);
    }
    const numbered = world.store.job('credit-numbered').invoice;
    assert.deepEqual([numbered.number, numbered.status, numbered.paid, numbered.balance, numbered.amount, numbered.issuedAt], ['INV-MBERED', 'partial', 800, 200, 1000, undefined]);
    if (on) assert.deepEqual(world.store.job('credit-made-up').invoice, MADE_UP, 'a numberless invoice is never touched');
    else assert.deepEqual(pickInvoice(world.store.job('credit-made-up').invoice), { number: null, status: 'partial', amount: 1000, paid: 800, balance: 200, issuedAt: null });
    assert.deepEqual([...world.store.rows.keys()].sort(), ['credit-made-up', 'credit-numbered'], 'no number is reserved');
    saved[on ? 'on' : 'off'] = numbered;
  });
  assert.deepEqual(saved.on, saved.off);
});

test('with payment events on, the flag changes no FUN-33 event and no paid-in-full crossing, and credits stay non-cash', async () => {
  const job = { ...moneyJobs()['deposit-paid'], customerId: 'cust-events', status: 'completed', pipelineStatus: 'completed', completedAt: NOW,
    payment: { ...moneyJobs()['deposit-paid'].payment, amount: 700, giftCreditApplied: 200 }, giftWallet: { redemptions: [{ id: 'redemption-1', requestId: 'credit-a', cardId: 'credit-1', amount: 200, appliedAt: '2026-09-21T15:00:00.000Z', jobId: 'job-events' }] } };
  const run = async flags => {
    const store = memoryStore({ 'job-events': job }, { paymentEvents: true, ...flags }), requestId = '5f0c7c4e-2d7b-4b8e-9d51-6d2a1d3f4c11';
    const result = await mutateMoney(store, OWNER, { action: 'payment.record_offline', requestId, jobId: 'job-events', expectedRevision: 'job-events-r0', amountCents: 30000, method: 'check', reference: 'CHK-9' }, NOW);
    return { result, events: store.commits.flat().filter(write => write.collection === 'funnelEvents'), saved: store.job('job-events') };
  };
  const today = await run({}), fixed = await run({ invoiceState: true });
  assert.deepEqual(fixed.events, today.events, 'the same payment.received and paid-in-full events, byte for byte');
  assert.deepEqual(today.events.map(write => [write.patch.type, write.patch.data.amountCents, write.patch.data.cash ?? null]), [['payment.received', 30000, true], ['job.paid_in_full', 100000, null]]);
  assert.deepEqual([fixed.saved.paidInFullAt, fixed.saved.paidInFullRevision], [today.saved.paidInFullAt, today.saved.paidInFullRevision]);
  assert.deepEqual(fixed.result.job.payments.map(row => [row.method, row.nonCashCredit]), today.result.job.payments.map(row => [row.method, row.nonCashCredit]));
  assert.ok(fixed.result.job.payments.some(row => row.method === 'gift_credit' && row.nonCashCredit === true && row.kind === 'balance'), 'the money DTO keeps the ledger kind; only the payments list says credit');
  assert.deepEqual([fixed.result.job.paidInFull.paid, fixed.result.job.invoice.status, today.result.job.invoice.status], [true, 'not_issued', 'paid']);
});

test('the payments view lists service credits as credits, apart from cash, and totals cash without them', async () => {
  const card = (sessionId, amount, purpose, verifiedAt) => ({ sessionId, paymentIntentId: sessionId.replace('cs_test_', 'pi_'), amount, purpose, verifiedAt });
  const jobs = {
    'pay-card': { ...moneyJobs()['quote-only'], customerId: 'cust-a', payment: { amount: 500, verified: true, method: 'stripe', stripeSessions: [card('cs_test_pay_card', 500, 'deposit', '2026-09-18T16:00:00.000Z')] } },
    'pay-credit': { ...moneyJobs()['quote-only'], customerId: 'cust-b', payment: { amount: 700, verified: true, method: 'mixed_with_gift_credit', giftCreditApplied: 200, stripeSessions: [card('cs_test_pay_credit', 500, 'deposit', '2026-09-18T17:00:00.000Z')] },
      giftWallet: { redemptions: [{ id: 'redemption-9', requestId: 'credit-b', cardId: 'gift-9', amount: 200, appliedAt: '2026-09-19T15:00:00.000Z', jobId: 'pay-credit' }] } },
    'pay-tip': { ...moneyJobs()['tip-present'], customerId: 'cust-c' },
    'pay-legacy-credit': { ...moneyJobs()['quote-only'], customerId: 'cust-d', payment: { amount: 150, verified: true, method: 'gift_credit', giftCreditApplied: 150 } },
  };
  const today = await listMoney(memoryStore(jobs), { view: 'payments' }, NOW), fixed = await listMoney(memoryStore(jobs, { invoiceState: true }), { view: 'payments' }, NOW);
  const rows = page => page.items.map(row => [row.jobId, row.kind, row.method, row.amountCents]);
  assert.deepEqual(rows(today).filter(row => row[2] === 'gift_credit'), [['pay-credit', 'balance', 'gift_credit', 20000], ['pay-legacy-credit', 'balance', 'gift_credit', 15000]], 'today credits are listed as balance payments');
  assert.equal(today.total, 7); assert.equal(Object.hasOwn(today, 'credits'), false); assert.equal(Object.hasOwn(today, 'totals'), false);
  assert.deepEqual(rows(fixed), rows(today).filter(row => row[2] !== 'gift_credit'), 'the cash rows, in the same order');
  assert.equal(fixed.total, 5);
  assert.deepEqual(fixed.credits.map(row => [row.jobId, row.entryId, row.kind, row.method, row.amountCents, row.source]), [['pay-credit', 'gift:redemption-9', 'credit', 'gift_credit', 20000, 'gift_credit'], ['pay-legacy-credit', 'gift:pay-legacy-credit:applied', 'credit', 'gift_credit', 15000, 'gift_credit_total']]);
  assert.deepEqual(fixed.totals, { cashCents: 50000 + 50000 + 50000 + 20000 + 5000, tipCents: 5000, creditCents: 35000 });
  assert.equal(fixed.totals.cashCents, fixed.items.reduce((sum, row) => sum + row.amountCents, 0), 'every cash row counts once, tips included');
  // Paged: the credits and the totals cover every match, not only the page.
  const page = await listMoney(memoryStore(jobs, { invoiceState: true }), { view: 'payments', limit: 2 }, NOW);
  assert.deepEqual([page.items.length, page.total, page.nextOffset, page.credits.length, page.totals.creditCents], [2, 5, 2, 2, 35000]);
  // CSV: today's columns, the cash rows first, then the credits marked credit.
  const csv = moneyCsv('payments', fixed.rows).split('\r\n').filter(Boolean).map(line => line.split('","')[5]);
  assert.deepEqual(csv, ['Kind', 'tip', 'deposit', 'deposit', 'balance', 'deposit', 'credit', 'credit']);
  assert.equal(moneyCsv('payments', today.rows), moneyCsv('payments', (await listMoney(memoryStore(jobs), { view: 'payments' }, NOW)).rows), 'flag off: the same CSV');
  // An invoices-view filter never sees the payments split.
  assert.equal(Object.hasOwn(await listMoney(memoryStore(jobs, { invoiceState: true }), { view: 'invoices' }, NOW), 'credits'), false);
});

test('GET /api/money carries the credits and cash totals, and a job money read says not_issued, only with the flag', async () => {
  const jobs = { 'api-credit': { ...moneyJobs()['quote-only'], customerId: 'cust-api', payment: { amount: 200, verified: true, method: 'gift_credit', giftCreditApplied: 200 }, invoice: { amount: 1000, paid: 200, balance: 800, status: 'partial', updatedAt: NOW } } };
  for (const invoiceState of [false, true]) {
    const store = memoryStore(jobs, { invoiceState }), api = moneyHandlers({ session: async () => OWNER, storage: () => store, now: () => new Date(NOW) });
    const get = query => read(api.get({ request: new Request(`${ORIGIN}/api/money?${query}`, { headers: { 'Sec-Fetch-Site': 'same-origin', Origin: ORIGIN } }), env: { MONEY_API_ENABLED: 'true' } }));
    const payments = await get('view=payments'), invoices = await get('view=invoices'), job = await get('jobId=api-credit');
    assert.equal(payments.status, 200);
    assert.deepEqual([payments.body.items.length, payments.body.credits?.length ?? null, payments.body.totals ?? null], invoiceState ? [0, 1, { cashCents: 0, tipCents: 0, creditCents: 20000 }] : [1, null, null]);
    assert.deepEqual(invoices.body.items.map(row => row.status), invoiceState ? [] : ['partial']);
    assert.equal(job.body.job.invoice.status, invoiceState ? 'not_issued' : 'partial');
    const csv = await api.get({ request: new Request(`${ORIGIN}/api/money?view=payments&format=csv`, { headers: { 'Sec-Fetch-Site': 'same-origin', Origin: ORIGIN } }), env: {} });
    assert.equal((await csv.text()).split('\r\n')[1].split('","')[5], invoiceState ? 'credit' : 'balance');
  }
});

test('portal document links and landing read not_issued for a made-up invoice only with the flag', () => {
  const job = { ...moneyJobs()['deposit-paid'], invoice: { amount: 1000, paid: 500, balance: 500, status: 'partial', updatedAt: NOW } };
  assert.deepEqual(moneyDocumentLinks(job, { enabled: true, now: NOW }).map(link => link.kind), ['estimate', 'invoice', 'receipt']);
  assert.deepEqual(moneyDocumentLinks(job, { enabled: true, now: NOW, invoiceState: true }).map(link => link.kind), ['estimate', 'receipt']);
  const viewer = { permissions: { view: true } };
  assert.equal(portalLanding('invoice', { env: { MONEY_DOCUMENT_ENABLED: 'true' }, job, viewer, now: NOW }), PORTAL_INVOICE);
  assert.equal(portalLanding('invoice', { env: { MONEY_DOCUMENT_ENABLED: 'true', MONEY_INVOICE_STATE_ENABLED: 'true' }, job, viewer, now: NOW }), PORTAL_PAY);
  const issued = { ...job, invoice: { number: 'INV-9', status: 'issued', amount: 1000, dueDate: '2026-09-29', issuedAt: ISSUED_AT } };
  assert.equal(portalLanding('invoice', { env: { MONEY_DOCUMENT_ENABLED: 'true', MONEY_INVOICE_STATE_ENABLED: 'true' }, job: issued, viewer, now: NOW }), PORTAL_INVOICE);
  // The Hub money DTO follows the same rule.
  assert.equal(moneyProjection({ ...job, revision: 'r1' }, NOW).invoice.status, 'partial');
  assert.equal(moneyProjection({ ...job, revision: 'r1' }, NOW, { invoiceState: true }).invoice.status, 'not_issued');
});

// MONEY-GHL-PARITY: the Hub starts the HighLevel lifecycle trigger of a confirmed money save through the suite's own
// syncCustomerCommunication; the tag depends on the save, never on the invoice. Run on the saved job with the flag off
// and on, the /api/highlevel request and the HighLevel calls are the same.
const suite = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8');
const sourceLine = prefix => { const line = suite.split('\n').find(value => value.startsWith(prefix)); assert.ok(line, `missing ${prefix}`); return line; };
const sourceBetween = (start, end) => { const first = suite.indexOf(start), last = suite.indexOf(end, first); assert.ok(first >= 0 && last > first, `missing ${start}`); return suite.slice(first, last); };
const HUB_ENV = { HUB_SESSION_SECRET: 'synthetic-money-invoice-state-session', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'synthetic-zac', displayName: 'Synthetic Owner', role: 'owner', payType: 'owner', hourlyRate: 0 } }), HIGHLEVEL_API_KEY: 'synthetic-ghl-key', HIGHLEVEL_LOCATION_ID: 'location-1', EGC_OPERATIONS_ENABLED: 'false' };
const FIXED = Date.parse(NOW);
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [FIXED])); } static now() { return FIXED; } }
async function lifecycle(job) {
  const cookie = (await createHubSessionCookie(HUB_ENV, 'ZacB')).split(';')[0], requests = [], docs = new Map([[job.id, structuredClone(job)]]);
  const hubFetch = async (url, init = {}) => { requests.push({ url, body: init.body, key: init.headers?.['Idempotency-Key'] }); return highlevelPost({ request: new Request(ORIGIN + url, { method: init.method, headers: { Origin: ORIGIN, Cookie: cookie, ...init.headers }, body: init.body }), env: HUB_ENV }); };
  const db = { collection: () => ({ doc: id => ({ get: async () => ({ id, exists: docs.has(id), data: () => structuredClone(docs.get(id)) }), set: async (patch, options = {}) => { docs.set(id, { ...(options.merge ? docs.get(id) : {}), ...structuredClone(patch) }); } }) }), runTransaction: async run => run({ get: async ref => ref.get(), set: (ref, patch, options) => ref.set(patch, options) }) };
  const context = vm.createContext({ window: {}, Date: FixedDate, db, jobsCache: [structuredClone(job)], hubFetch, render: () => {}, showToast: () => {}, employeeIdentity: () => 'zacb', jobStage: row => row.pipelineStatus || row.status || 'scheduled' });
  vm.runInContext(['function jobs(){return jobsCache}', ...['const money=', 'const payMoney=', 'const day=', 'async function patchJob(', 'function cachePortalInvitation(', 'function cacheSalesExit(', 'function portalInvitationState(', 'function portalInvitationLabel(', 'async function syncLifecycle(', 'function financeState(', 'function communicationNote(', 'async function syncCustomerCommunication(', 'window.EGCCustomerCommunication='].map(sourceLine),
    sourceBetween('const customerCommunicationTypes={', 'function communicationNote(')].join('\n'), context);
  const sent = await context.window.EGCCustomerCommunication.sync(job, 'payment-received', `payment:${job.moneyUpdatedAt}`);
  return { sent, requests, log: docs.get(job.id).communicationLog };
}

test('MONEY-GHL-PARITY: an offline payment starts the same egc-payment-received trigger with the flag on as off', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const target = new URL(String(url));
    assert.equal(target.hostname, 'services.leadconnectorhq.com', `unexpected request to ${target.hostname}`);
    calls.push({ path: target.pathname, method: options.method || 'GET', body: options.body ?? null });
    return Response.json(target.pathname.endsWith('/notes') ? { note: { id: 'note-1' } } : {});
  });
  const base = { ...moneyJobs()['quote-only'], customerId: 'c1', notify: true, highlevelContactId: 'contact-1', highlevelAppointmentId: 'appt-1' };
  for (const [label, job] of [['with an estimate number', base], ['without one', { ...base, estimate: { ...base.estimate, number: undefined } }]]) {
    const runs = [];
    for (const invoiceState of [false, true]) {
      const store = memoryStore({ 'job-abc123': job }, { invoiceState });
      await mutateMoney(store, OWNER, { action: 'payment.record_offline', requestId: '0b8a3a7e-44a3-4d0e-9f7e-2f7b9f0c1a21', jobId: 'job-abc123', expectedRevision: 'job-abc123-r0', amountCents: 30000, method: 'check', reference: 'CHK-1002' }, NOW);
      const { revision: _revision, ...saved } = store.job('job-abc123');
      const result = await lifecycle(saved);
      runs.push({ ...result, calls: calls.splice(0), invoice: saved.invoice });
    }
    const [today, fixed] = runs;
    for (const run of runs) {
      assert.equal(run.sent, true, label);
      assert.deepEqual(run.calls.filter(call => call.path === '/contacts/contact-1/tags').map(call => JSON.parse(call.body).tags), [['egc-payment-received']], `${label}: exactly the egc-payment-received tag`);
      assert.equal(run.log.at(-1).trigger, 'egc-payment-received');
    }
    assert.deepEqual(fixed.calls.map(call => [call.path, call.method]), today.calls.map(call => [call.path, call.method]), `${label}: HighLevel sees the same calls`);
    const payload = run => JSON.parse(run.requests[0].body);
    if (job.estimate.number) assert.deepEqual(fixed.requests, today.requests, `${label}: byte for byte the same /api/highlevel request`);
    else {
      // The HighLevel note named the made-up invoice number today; it names none now. The tag is the same.
      assert.equal(payload(today).note, 'Payment received · INV-ABC123 · Service date 2026-09-22');
      assert.equal(payload(fixed).note, 'Payment received · Service date 2026-09-22');
      assert.deepEqual({ ...payload(fixed), note: '' }, { ...payload(today), note: '' });
      assert.equal(fixed.invoice, undefined);
    }
  }
});

test('the receipt is named after the latest cash payment: never a refund or a service credit, and no reference when no single cash payment exists', () => {
  const name = job => moneyDocumentModel(job, { kind: 'receipt', now: NOW, audience: 'staff', invoiceState: true }).number;
  const entry = (id, kind, amountCents, at) => ({ id, kind, amountCents, method: 'check', processor: '', processorRef: id.slice(-7), receiptUrl: '', at, by: 'zacb', verified: true, source: 'hub_offline' });
  // FIX-REFUNDS stores refunds in the payment ledger: a later refund never names the receipt.
  const refunded = { ...moneyJobs()['quote-only'], id: 'job-refunded', payment: { amount: 400, verified: true, method: 'check' },
    paymentLedger: [entry('offline:check-1', 'offline', 50000, '2026-09-20T16:00:00.000Z'), entry('offline:refund-1', 'refund', 10000, '2026-09-21T16:00:00.000Z')] };
  assert.deepEqual(reconcileLedger(refunded).entries.map(row => [row.id, row.kind]), [['offline:check-1', 'offline'], ['offline:refund-1', 'refund']]);
  assert.equal(name(refunded), 'offline:check-1');
  // A gift credit applied after the card deposit is not cash: the receipt names the card payment.
  const deposit = moneyJobs()['deposit-paid'], redemption = (id, jobId) => ({ id, jobId, cardId: 'credit-1', amount: 300, appliedAt: '2026-09-21T15:00:00.000Z' });
  const credited = { ...deposit, payment: { ...deposit.payment, amount: 800, giftCreditApplied: 300, method: 'mixed_with_gift_credit' }, giftWallet: { redemptions: [redemption('redeem-1', deposit.id)] } };
  assert.deepEqual(reconcileLedger(credited).entries.map(row => row.id), ['stripe:cs_test_deposit_deposit', 'gift:redeem-1']);
  assert.equal(name(credited), 'stripe:cs_test_deposit_deposit');
  // Paid by credit alone: a credit is never cash, so the receipt carries no single payment reference.
  const creditOnly = { ...moneyJobs()['quote-only'], id: 'job-credit-only', payment: { amount: 300, verified: true, method: 'gift_credit', giftCreditApplied: 300 }, giftWallet: { redemptions: [redemption('redeem-2', 'job-credit-only')] } };
  assert.deepEqual(reconcileLedger(creditOnly).entries.map(row => [row.id, row.source]), [['gift:redeem-2', 'gift_credit']]);
  assert.equal(name(creditOnly), '');
  // An account credit held only as the applied total (no redemption on this job) is a credit too.
  const accountCredit = { ...creditOnly, id: 'job-account-credit', giftWallet: undefined };
  assert.deepEqual(reconcileLedger(accountCredit).entries.map(row => [row.id, row.source]), [['gift:job-account-credit:applied', 'gift_credit_total']]);
  assert.equal(name(accountCredit), '');
  // $500 cash the older Hub tool recorded (kept only in the legacy:manual running total), then a $300 gift credit:
  // no single cash payment exists, so no reference; the credit never names the receipt.
  const legacyCash = { ...moneyJobs()['quote-only'], id: 'job-legacy-cash', payment: { amount: 800, verified: true, method: 'mixed_with_gift_credit', giftCreditApplied: 300 }, giftWallet: { redemptions: [redemption('redeem-3', 'job-legacy-cash')] } };
  assert.deepEqual(reconcileLedger(legacyCash).entries.map(row => [row.id, row.amountCents]), [['gift:redeem-3', 30000], ['legacy:manual', 50000]]);
  assert.equal(name(legacyCash), '');
  // The newest ledger entry is a refund and a gift credit sits between: still the card payment.
  const card = { id: 'stripe:cs_test_refund_newest', kind: 'deposit', amountCents: 50000, method: 'card', processor: 'stripe', processorRef: 'pi_refund_newest', receiptUrl: '', at: '2026-09-18T16:05:00.000Z', by: 'stripe', verified: true, source: 'stripe_session' };
  const refundNewest = { ...moneyJobs()['quote-only'], id: 'job-refund-newest', payment: { amount: 600, verified: true, method: 'mixed_with_gift_credit', giftCreditApplied: 300 }, giftWallet: { redemptions: [redemption('redeem-4', 'job-refund-newest')] },
    paymentLedger: [card, entry('offline:refund-9', 'refund', 20000, '2026-09-22T16:00:00.000Z')] };
  assert.deepEqual(reconcileLedger(refundNewest).entries.map(row => [row.id, row.kind]), [['stripe:cs_test_refund_newest', 'deposit'], ['gift:redeem-4', 'balance'], ['offline:refund-9', 'refund']]);
  assert.equal(name(refundNewest), 'stripe:cs_test_refund_newest');
  // An empty reference renders cleanly: the header and the title carry the service and the kind only, never an empty
  // label or a dangling separator, and no invoice number; with the flag off the receipt is today's.
  for (const job of [creditOnly, legacyCash]) {
    const html = renderMoneyDocument(job, { kind: 'receipt', now: NOW, invoiceState: true });
    assert.ok(html.includes('<title>Receipt · Easy Garage Cleaning</title>'), job.id);
    assert.ok(html.includes('<h1>Receipt</h1><p>Garage Turnaround</p>'), job.id);
    assert.equal(/INV-|Receipt #|<p>\s*·|·\s*<\/p>|<dd><\/dd>/.test(html), false, job.id);
    assert.deepEqual(moneyDocumentModel(job, { kind: 'receipt', now: NOW, invoiceState: true }).dates, [['Receipt date', 'September 21, 2026']], job.id);
  }
  assert.ok(renderMoneyDocument(creditOnly, { kind: 'receipt', now: NOW }).includes('<p>INV-T-ONLY · Garage Turnaround</p>'), 'flag off: today\'s receipt');
  // The receipt of an unsent quote draft (withheld from the customer) follows the same rule.
  const draft = { ...legacyCash, estimate: { ...legacyCash.estimate, status: 'draft', source: 'quote_draft', revision: 2 } };
  const withheld = moneyDocumentModel(draft, { kind: 'receipt', now: NOW, invoiceState: true });
  assert.deepEqual([withheld.withheld, withheld.number, withheld.dates], [true, '', [['Receipt date', 'September 21, 2026']]]);
  const withheldHtml = renderMoneyDocument(draft, { kind: 'receipt', now: NOW, invoiceState: true });
  assert.ok(withheldHtml.includes('<title>Receipt · Easy Garage Cleaning</title>') && withheldHtml.includes('<h1>Receipt</h1><p>Garage Turnaround</p>'));
  const cashDraft = { ...refundNewest, estimate: { ...refundNewest.estimate, status: 'draft', source: 'quote_draft', revision: 2 } };
  assert.deepEqual([moneyDocumentModel(cashDraft, { kind: 'receipt', now: NOW, invoiceState: true }).withheld, moneyDocumentModel(cashDraft, { kind: 'receipt', now: NOW, invoiceState: true }).number], [true, 'stripe:cs_test_refund_newest']);
});

// The numberless invoice backfill: dry run by default, --apply revision-fenced and audited, a rerun finds 0.
const BACKFILL_NOW = '2026-09-23T15:30:00.000Z', RUN = '00000000-0000-4000-8000-0000000000aa';
const backfillJobs = () => ({
  'job-deposit': { ...depositJob(), payment: { amount: 500, verified: true, method: 'stripe', stripeSessions: [{ sessionId: 'cs_test_bf_deposit', paymentIntentId: 'pi_bf_deposit', amount: 500, purpose: 'deposit', verifiedAt: '2026-09-18T16:05:00.000Z' }] },
    deposit: { amount: 500, paidAmount: 500, status: 'paid', verified: true }, invoice: { amount: 1000, paid: 500, balance: 500, status: 'partial', updatedAt: '2026-09-18T16:05:00.000Z' } },
  'job-credit': { ...moneyJobs()['quote-only'], id: 'job-credit', payment: { amount: 1000, verified: true, method: 'gift_credit', giftCreditApplied: 1000 }, invoice: { amount: 1000, paid: 1000, balance: 0, status: 'paid', updatedAt: '2026-09-19T12:00:00.000Z' } },
  'job-superseded': { ...moneyJobs()['quote-only'], id: 'job-superseded', payment: { amount: 500, verified: true, method: 'stripe', stripeSessions: [{ sessionId: 'cs_test_bf_superseded', paymentIntentId: 'pi_bf_superseded', amount: 500, purpose: 'deposit', verifiedAt: '2026-09-18T16:05:00.000Z' }] }, invoice: { amount: 1000, paid: 500, balance: 500, status: 'superseded', supersededAt: '2026-09-20T12:00:00.000Z', supersededReason: 'estimate_revised', updatedAt: '2026-09-19T12:00:00.000Z' } },
  // The job was cancelled and its made-up invoice voided: the job refuses a tip either way, so nothing moves and it is cleared.
  'job-voided': { ...moneyJobs()['quote-only'], id: 'job-voided', status: 'cancelled', pipelineStatus: 'cancelled', payment: { amount: 500, verified: true, method: 'stripe', stripeSessions: [{ sessionId: 'cs_test_bf_voided', paymentIntentId: 'pi_bf_voided', amount: 500, purpose: 'deposit', verifiedAt: '2026-09-18T16:05:00.000Z' }] },
    invoice: { amount: 1000, paid: 500, balance: 500, status: 'void', voidedAt: '2026-09-20T12:00:00.000Z', voidedBy: 'zacb', voidReason: 'Job cancelled', updatedAt: '2026-09-20T12:00:00.000Z' } },
  'job-issued': { ...moneyJobs()['quote-only'], id: 'job-issued', invoice: { number: 'INV-OK-1', status: 'issued', amount: 1000, paid: 0, balance: 1000, dueDate: '2026-09-29', issuedAt: ISSUED_AT } },
  'job-offline-number': { ...moneyJobs()['quote-only'], id: 'job-offline-number', invoice: { number: 'INV-NUMBER', status: 'partial', amount: 1000, paid: 300, balance: 700, updatedAt: '2026-09-19T12:00:00.000Z' } },
  'job-jobber': { ...moneyJobs()['quote-only'], id: 'job-jobber', invoice: { number: 'JOBBER-77', status: 'issued', amount: 400, paid: 0, balance: 400, issuedAt: null, source: 'jobber_import', imported: true } },
  'job-odd': { ...moneyJobs()['quote-only'], id: 'job-odd', invoice: { status: 'partial', amount: 1000, customerReference: 'PO-77' } },
  'job-plain': { ...moneyJobs()['quote-only'], id: 'job-plain' },
  walk: { type: 'walkthrough', invoice: { amount: 10, status: 'partial' } },
});

test('numberless invoice backfill: the dry run lists the made-up invoices, writes nothing and names the ones for review', async () => {
  assert.equal(numberlessInvoice(backfillJobs()['job-deposit']), true); assert.equal(numberlessInvoice(backfillJobs()['job-issued']), false); assert.equal(numberlessInvoice({ invoice: { number: '', issuedAt: '' } }), false);
  const store = memoryStore(backfillJobs()), report = await runNumberlessInvoiceBackfill(store, { now: BACKFILL_NOW, runId: RUN });
  assert.equal(report.mode, 'dry_run'); assert.equal(store.commits.length, 0);
  assert.deepEqual(report.preview, [
    { id: 'job-credit', status: 'paid', amountCents: 100000, paidCents: 100000, balanceCents: 0 },
    { id: 'job-deposit', status: 'partial', amountCents: 100000, paidCents: 50000, balanceCents: 50000 },
    { id: 'job-voided', status: 'void', amountCents: 100000, paidCents: 50000, balanceCents: 50000 },
  ]);
  // The superseded made-up invoice is what refuses a tip on this open job today: clearing it would reopen the tip offer.
  assert.deepEqual(report.jobs.needsReview, [{ id: 'job-odd', reasons: ['unknown_fields'], fields: ['customerReference'], status: 'partial', amountCents: 100000, paidCents: null, balanceCents: null },
    { id: 'job-superseded', reasons: ['tip_offer_changes'], status: 'superseded', amountCents: 100000, paidCents: 50000, balanceCents: 50000 }]);
  assert.deepEqual(report.jobs.numberedNotIssued, [{ id: 'job-offline-number', number: 'INV-NUMBER', status: 'partial', amountCents: 100000, paidCents: 30000, balanceCents: 70000 }]);
  assert.deepEqual([report.jobs.scanned, report.jobs.skippedRecords, report.jobs.withInvoice], [10, 1, 8]);
  assert.deepEqual(report.writes, { planned: 3, committed: 0, changedDuringRun: [], receipts: [] });
  assert.equal(JSON.stringify(report).includes('Synthetic'), false, 'the report carries no customer details');
  assert.deepEqual(planNumberlessInvoiceBackfill(await store.jobs()).writes.map(row => [row.id, row.revision]), [['job-credit', 'job-credit-r0'], ['job-deposit', 'job-deposit-r0'], ['job-voided', 'job-voided-r0']]);
  assert.throws(() => planNumberlessInvoiceBackfill(null), { code: 'numberless_invoice_backfill_input_invalid' });
});

test('numberless invoice backfill: --apply removes only the invoice, fenced by revision, audited and receipted; a rerun finds 0', async () => {
  const store = memoryStore(backfillJobs()), before = structuredClone(store.job('job-deposit'));
  const report = await runNumberlessInvoiceBackfill(store, { apply: true, now: BACKFILL_NOW, runId: RUN });
  assert.equal(report.aborted, undefined);
  assert.deepEqual([report.mode, report.writes.committed, report.writes.receipts.length, report.writes.changedDuringRun], ['apply', 3, 1, []]);
  const [batch] = store.commits;
  const jobs = batch.filter(write => write.collection === 'jobs');
  assert.deepEqual(jobs.map(write => [write.id, write.revision, write.patch, write.remove]), [['job-credit', 'job-credit-r0', {}, ['invoice']], ['job-deposit', 'job-deposit-r0', {}, ['invoice']], ['job-voided', 'job-voided-r0', {}, ['invoice']]]);
  const after = store.job('job-deposit');
  assert.equal(after.invoice, undefined);
  for (const key of ['payment', 'deposit', 'estimate', 'customerApproval', 'status']) assert.deepEqual(after[key], before[key], `${key} is kept`);
  assert.deepEqual(paymentLedger(after).entries.map(entry => [entry.id, entry.amountCents]), [['stripe:cs_test_bf_deposit', 50000]], 'the ledger is kept');
  assert.equal(invoiceEligibility({ ...after, status: 'completed', pipelineStatus: 'completed', completedAt: NOW }, BACKFILL_NOW).eligible, true, 'the card-paid job can now be invoiced, flag or not');
  const audits = batch.filter(write => write.collection === 'hub_audit');
  assert.equal(audits.length, 3);
  for (const audit of audits) {
    assert.deepEqual([audit.revision, audit.patch.action, audit.patch.actor.kind, audit.patch.via, audit.patch.at], [undefined, 'money.invoice.numberless_backfill', 'system', 'cron', BACKFILL_NOW]);
    assert.deepEqual(JSON.parse(audit.patch.after), { invoice: null });
  }
  assert.deepEqual(JSON.parse(audits.find(audit => audit.patch.entity.id === 'job-deposit').patch.before), { invoice: backfillJobs()['job-deposit'].invoice });
  const receipt = batch.find(write => write.collection === 'moneyOperations');
  assert.deepEqual([receipt.patch.runId, receipt.patch.createdAt, receipt.patch.targets.map(row => row.id)], [RUN, BACKFILL_NOW, ['job-credit', 'job-deposit', 'job-voided']]);
  for (const id of ['job-issued', 'job-offline-number', 'job-jobber', 'job-odd', 'job-superseded']) assert.deepEqual(store.job(id).invoice, backfillJobs()[id].invoice, `${id} is never touched`);
  const rerun = await runNumberlessInvoiceBackfill(store, { apply: true, now: BACKFILL_NOW, runId: RUN });
  assert.deepEqual([rerun.writes.planned, rerun.writes.committed, store.commits.length], [0, 0, 1], 'a rerun finds 0 and writes nothing');
});

test('numberless invoice backfill: a job saved during the run is left untouched and reported; a lost answer is settled by its receipt', async () => {
  const store = memoryStore(backfillJobs());
  // A card payment lands on job-deposit between the scan and the commit.
  store.beforeCommit(async () => { const job = store.job('job-deposit'); store.docs.set('jobs/job-deposit', { ...job, invoice: { ...job.invoice, note: 'x' }, revision: 'job-deposit-r1' }); });
  const report = await runNumberlessInvoiceBackfill(store, { apply: true, now: BACKFILL_NOW, runId: RUN });
  assert.deepEqual([report.writes.committed, report.writes.changedDuringRun], [2, ['job-deposit']]);
  assert.equal(store.job('job-deposit').invoice.status, 'partial', 'the changed job keeps its invoice for a rerun');
  assert.equal(store.job('job-credit').invoice, undefined);
  assert.equal(store.commits.length, 2, 'the batch was refused whole, then the others went one by one');
  const lost = memoryStore(backfillJobs()), commit = lost.commit.bind(lost);
  lost.commit = async writes => { await commit(writes); throw Object.assign(new Error('lost'), { code: 'money_outcome_unknown' }); };
  const recovered = await runNumberlessInvoiceBackfill(lost, { apply: true, now: BACKFILL_NOW, runId: RUN });
  assert.deepEqual([recovered.aborted, recovered.writes.committed], [undefined, 3]);
  const failing = memoryStore(backfillJobs());
  failing.commit = async () => { throw Object.assign(new Error('down'), { code: 'money_storage_unavailable' }); };
  const aborted = await runNumberlessInvoiceBackfill(failing, { apply: true, now: BACKFILL_NOW, runId: RUN });
  assert.equal(aborted.aborted.code, 'money_storage_unavailable'); assert.equal(aborted.writes.committed, 0);
  assert.deepEqual(parseArgs([]), { apply: false, report: '', help: false, hubUnifiedTotals: false });
  assert.deepEqual(parseArgs(['--apply', '--report', 'out.json']), { apply: true, report: 'out.json', help: false, hubUnifiedTotals: false });
  assert.deepEqual(parseArgs(['--apply', '--hub-unified-totals']), { apply: true, report: '', help: false, hubUnifiedTotals: true });
  assert.throws(() => parseArgs(['--apply', '--dry-run']), /either/); assert.throws(() => parseArgs(['--force']), /Unknown/);
});

// A job whose money would move once its invoice is gone is reported and never written: the paid figure some legacy jobs
// keep only on the invoice (money-core paymentLedger, customerMoneyState and the Hub board all read payment.amount ??
// invoice.paid ?? invoice.amountPaid), today's Hub board total (an active invoice's amount) and the recurring price lock.
const reviewJobs = () => {
  const quote = moneyJobs()['quote-only'], { customerApproval: _approval, ...unapproved } = quote, updatedAt = '2026-09-19T12:00:00.000Z';
  return {
    'job-paid-on-invoice': { ...quote, id: 'job-paid-on-invoice', invoice: { amount: 1000, paid: 600, balance: 400, status: 'partial', updatedAt } },
    'job-amount-paid': { ...quote, id: 'job-amount-paid', invoice: { amount: 1000, amountPaid: 1000, balance: 0, status: 'paid', updatedAt } },
    // The deposit card payment wrote the $1,150 invoice (the quote plus the billed $150 change) that today's board totals.
    'job-change-order': { ...moneyJobs()['billed-change'], id: 'job-change-order', invoice: { amount: 1150, paid: 500, balance: 650, status: 'partial', updatedAt } },
    // Nothing paid and no approval: the invoice is all that keeps a recurring plan from re-pricing the visit.
    'job-price-lock': { ...unapproved, id: 'job-price-lock', quoteStatus: 'sent', estimate: { ...quote.estimate, status: 'sent' }, invoice: { amount: 1000, balance: 1000, status: 'partial', updatedAt } },
    'job-deposit': backfillJobs()['job-deposit'],
  };
};
const withoutInvoice = job => { const { invoice: _invoice, ...rest } = job; return rest; };
// The Hub finance board as it runs (employee-suite.js financeState, with EGCMoneyTotals on or off).
function hubBoard(unified) {
  const session = new Map(unified ? [['egc.moneyTotals.unified', 'true']] : []), FIXED = Date.parse(BACKFILL_NOW);
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [FIXED])); } static now() { return FIXED; } }
  const context = vm.createContext({ window: { addEventListener: () => {} }, sessionStorage: { getItem: key => session.get(key) ?? null, setItem: () => {}, removeItem: () => {} }, Date: Clock });
  vm.runInContext(readFileSync(new URL('../employee-money-totals.js', import.meta.url), 'utf8'), context);
  vm.runInContext(['const payMoney=', 'const day=', 'function financeState('].map(sourceLine).join('\n'), context);
  assert.equal(context.window.EGCMoneyTotals.enabled(), unified);
  return job => { const state = context.financeState(structuredClone(job)); return [state.total, state.paid, state.balance]; };
}

test('numberless invoice backfill: a job whose money would move without its invoice is listed for review and never written, dry run or --apply', async () => {
  // Why: without the invoice these jobs would owe the whole quote again, on money-core (both modes) and the portal.
  for (const [id, applied, balance] of [['job-paid-on-invoice', 60000, 40000], ['job-amount-paid', 100000, 0]]) {
    const job = reviewJobs()[id];
    for (const unified of [false, true]) {
      assert.deepEqual([customerMoneyTotals(job, { unified }).appliedCents, customerMoneyTotals(job, { unified }).balanceCents], [applied, balance], `${id} today`);
      assert.equal(customerMoneyTotals(withoutInvoice(job), { unified }).balanceCents, 100000, `${id} without its invoice`);
    }
    assert.deepEqual(customerMoneyState(withoutInvoice(job)), { total: 1000, paid: 0, balance: 1000 });
  }
  const store = memoryStore(reviewJobs()), dry = await runNumberlessInvoiceBackfill(store, { now: BACKFILL_NOW, runId: RUN });
  assert.equal(store.commits.length, 0);
  assert.deepEqual(dry.preview.map(row => row.id), ['job-deposit'], 'a card payment saved on the job moves nothing: its invoice is still cleared');
  assert.deepEqual(dry.jobs.needsReview, [
    { id: 'job-amount-paid', reasons: ['paid_only_on_invoice'], status: 'paid', amountCents: 100000, paidCents: null, balanceCents: 0 },
    { id: 'job-change-order', reasons: ['hub_total_changes'], status: 'partial', amountCents: 115000, paidCents: 50000, balanceCents: 65000 },
    { id: 'job-paid-on-invoice', reasons: ['paid_only_on_invoice'], status: 'partial', amountCents: 100000, paidCents: 60000, balanceCents: 40000 },
    { id: 'job-price-lock', reasons: ['price_lock_changes'], status: 'partial', amountCents: 100000, paidCents: null, balanceCents: 100000 },
  ]);
  const applied = await runNumberlessInvoiceBackfill(store, { apply: true, now: BACKFILL_NOW, runId: RUN });
  assert.equal(applied.aborted, undefined);
  assert.deepEqual([applied.writes.planned, applied.writes.committed, applied.jobs.needsReview.map(row => row.id)], [1, 1, ['job-amount-paid', 'job-change-order', 'job-paid-on-invoice', 'job-price-lock']]);
  assert.deepEqual(store.commits[0].filter(write => write.collection === 'jobs').map(write => write.id), ['job-deposit']);
  for (const id of ['job-paid-on-invoice', 'job-amount-paid', 'job-change-order', 'job-price-lock']) assert.deepEqual(store.job(id).invoice, reviewJobs()[id].invoice, `${id} keeps its invoice`);
  assert.deepEqual(customerMoneyState(store.job('job-paid-on-invoice')), { total: 1000, paid: 600, balance: 400 }, 'the portal still asks for $400');
  assert.equal(customerMoneyTotals(store.job('job-amount-paid'), { unified: true }).balanceCents, 0);
  // A zero paid figure found only on the invoice is still left for review (the minimum rule), though nothing moves.
  const zero = { ...reviewJobs()['job-paid-on-invoice'], invoice: { amount: 1000, paid: 0, balance: 1000, status: 'partial' } };
  assert.deepEqual(moneyReviewReasons(zero), ['paid_only_on_invoice']);
  // Saved data a money reader cannot take (the portal's deposit state throws on it) is listed, never guessed at or fatal to the run.
  assert.deepEqual(moneyReviewReasons({ ...backfillJobs()['job-deposit'], postJobProgress: { standardItems: {} } }), ['money_unreadable']);
  // Once the Hub board reads money-core's totals (MONEY_API_ENABLED and MONEY_UNIFIED_TOTALS "true"), the change-order job is cleared.
  const unified = await runNumberlessInvoiceBackfill(store, { apply: true, hubUnifiedTotals: true, now: BACKFILL_NOW, runId: RUN });
  assert.deepEqual([unified.hubUnifiedTotals, unified.writes.committed, unified.jobs.needsReview.map(row => row.id)], [true, 1, ['job-amount-paid', 'job-paid-on-invoice', 'job-price-lock']]);
  assert.equal(store.job('job-change-order').invoice, undefined);
  const rerun = await runNumberlessInvoiceBackfill(store, { apply: true, hubUnifiedTotals: true, now: BACKFILL_NOW, runId: RUN });
  assert.deepEqual([rerun.writes.planned, rerun.jobs.needsReview.length], [0, 3], 'a rerun plans 0 and still lists the jobs for review');
});

test('numberless invoice backfill: a job is cleared only when the running Hub finance board would not move; hub_total_changes is a move of its total', () => {
  const legacy = hubBoard(false), unified = hubBoard(true);
  const moves = (board, job, figures = 3) => JSON.stringify(board(job).slice(0, figures)) !== JSON.stringify(board(withoutInvoice(job)).slice(0, figures));
  for (const [id, job] of Object.entries(reviewJobs())) {
    for (const [option, board, name] of [[false, legacy, "today's board"], [true, unified, 'the board on money-core totals']]) {
      if (moves(board, job)) assert.notDeepEqual(moneyReviewReasons(job, { hubUnifiedTotals: option }), [], `${id}: ${name} would move, so it is held`);
      assert.equal(moveReason(job, option), moves(board, job, 1), `${id}: ${name} total`);
    }
  }
  assert.deepEqual([legacy(reviewJobs()['job-change-order']), legacy(withoutInvoice(reviewJobs()['job-change-order']))], [[1150, 500, 650], [1000, 500, 500]], 'today the board would drop the billed change');
  assert.deepEqual(unified(withoutInvoice(reviewJobs()['job-change-order'])), [1150, 500, 650]);
  // Money-core cannot read this job's paid figure, so EGCMoneyTotals falls back to today's board: still listed with the option.
  const unreadable = { ...reviewJobs()['job-change-order'], payment: { ...reviewJobs()['job-change-order'].payment, amount: 'about 500' } };
  assert.equal(moves(unified, unreadable), true);
  assert.deepEqual(moneyReviewReasons(unreadable, { hubUnifiedTotals: true }), ['hub_total_changes']);
});
const moveReason = (job, hubUnifiedTotals) => moneyReviewReasons(job, { hubUnifiedTotals }).includes('hub_total_changes');

// A void or superseded invoice refuses a tip on the job (customer-payments tipRefusal) even when a payment wrote it
// without issuing it. The backfill's promise is that nothing read from a cleared job moves, so such a job is listed for
// review (tip_offer_changes) and never written; the same invoice on a closed job (the job itself refuses the tip) moves
// nothing and is cleared.
test('numberless invoice backfill: a void or superseded made-up invoice that refuses a tip is listed as tip_offer_changes and never written', async () => {
  const deposit = backfillJobs()['job-deposit'], stamp = '2026-09-20T12:00:00.000Z';
  const voided = { ...deposit.invoice, status: 'void', voidedAt: stamp, voidedBy: 'zacb', voidReason: 'Issued in error', updatedAt: stamp };
  const superseded = { ...deposit.invoice, status: 'superseded', supersededAt: stamp, supersededReason: 'estimate_revised', updatedAt: stamp };
  const closed = { status: 'cancelled', pipelineStatus: 'cancelled' };
  const jobs = () => ({
    'job-tip-void': { ...deposit, id: 'job-tip-void', invoice: structuredClone(voided) },
    'job-tip-superseded': { ...deposit, id: 'job-tip-superseded', invoice: structuredClone(superseded) },
    'job-closed-void': { ...deposit, ...closed, id: 'job-closed-void', invoice: structuredClone(voided) },
    'job-closed-superseded': { ...deposit, ...closed, id: 'job-closed-superseded', invoice: structuredClone(superseded) },
  });
  // Why: today the invoice is what refuses the tip; without it the portal and the crew card would offer one again.
  for (const id of ['job-tip-void', 'job-tip-superseded']) {
    const job = jobs()[id];
    assert.equal(numberlessInvoice(job), true, id);
    assert.deepEqual([tipRefusal(job), tipRefusal(withoutInvoice(job))], ['This invoice is no longer open, so a tip cannot be added.', ''], id);
    for (const hubUnifiedTotals of [false, true]) assert.deepEqual(moneyReviewReasons(job, { hubUnifiedTotals }), ['tip_offer_changes'], `${id} hubUnifiedTotals=${hubUnifiedTotals}`);
  }
  for (const id of ['job-closed-void', 'job-closed-superseded']) {
    const job = jobs()[id];
    assert.equal(tipRefusal(job), tipRefusal(withoutInvoice(job)), id);
    assert.deepEqual(moneyReviewReasons(job), [], id);
  }
  const summary = { amountCents: 100000, paidCents: 50000, balanceCents: 50000 };
  const review = [{ id: 'job-tip-superseded', reasons: ['tip_offer_changes'], status: 'superseded', ...summary }, { id: 'job-tip-void', reasons: ['tip_offer_changes'], status: 'void', ...summary }];
  const store = memoryStore(jobs()), dry = await runNumberlessInvoiceBackfill(store, { now: BACKFILL_NOW, runId: RUN });
  assert.deepEqual([store.commits.length, dry.writes.planned, dry.preview.map(row => row.id), dry.jobs.needsReview], [0, 2, ['job-closed-superseded', 'job-closed-void'], review]);
  for (const hubUnifiedTotals of [false, true]) {
    const applied = await runNumberlessInvoiceBackfill(store, { apply: true, hubUnifiedTotals, now: BACKFILL_NOW, runId: RUN });
    assert.equal(applied.aborted, undefined);
    assert.deepEqual(applied.jobs.needsReview, review, `hubUnifiedTotals=${hubUnifiedTotals}`);
    assert.deepEqual(store.commits.flat().filter(write => write.collection === 'jobs').map(write => write.id), ['job-closed-superseded', 'job-closed-void'], 'only the closed jobs were ever written');
    for (const id of ['job-tip-void', 'job-tip-superseded']) {
      assert.deepEqual(store.job(id).invoice, jobs()[id].invoice, `${id} keeps its invoice`);
      assert.equal(tipRefusal(store.job(id)), 'This invoice is no longer open, so a tip cannot be added.', `${id} still refuses a tip`);
    }
  }
  assert.deepEqual([store.job('job-closed-void').invoice, store.job('job-closed-superseded').invoice], [undefined, undefined]);
  const rerun = await runNumberlessInvoiceBackfill(store, { apply: true, now: BACKFILL_NOW, runId: RUN });
  assert.deepEqual([rerun.writes.planned, rerun.writes.committed, rerun.jobs.needsReview.map(row => row.id)], [0, 0, ['job-tip-superseded', 'job-tip-void']], 'a rerun plans 0 and still lists them');
});
