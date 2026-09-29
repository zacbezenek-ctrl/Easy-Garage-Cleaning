import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const enabled = process.env.EGC_FIREBASE_EMULATOR_TEST === '1';

test('the money API commit, receipt, audit and ledger contracts hold on real Firestore', { skip: !enabled, timeout: 180000 }, async t => {
  const host = process.env.FIRESTORE_EMULATOR_HOST || '';
  assert.match(host, /^(?:127\.0\.0\.1|localhost):\d{2,5}$/, 'This test may only connect to a loopback Firestore emulator.');
  const run = randomUUID().slice(0, 8), projectId = `demo-egc-money-${run}`, [hostname] = host.split(':');
  const { moneyStorage } = await import('../functions/_lib/money-storage.js');
  const { mutateMoney } = await import('../functions/_lib/money-service.js');
  const { listMoney } = await import('../functions/_lib/money-reports.js');
  const { runPaymentLedgerBackfill } = await import('../scripts/backfill-payment-ledger.mjs');
  const fetcher = async (_env, url, options = {}) => {
    const target = new URL(url); target.protocol = 'http:'; target.host = host; target.pathname = target.pathname.replace('/projects/egcw-1ec83/', `/projects/${projectId}/`);
    assert.equal(target.hostname, hostname);
    return fetch(target, { ...options, ...(options.body ? { body: options.body.replaceAll('projects/egcw-1ec83/', `projects/${projectId}/`) } : {}), headers: { ...options.headers, Authorization: 'Bearer owner' } });
  };
  const store = moneyStorage({}, fetcher), owner = { user: 'zacb', role: 'owner', businessAccess: true };
  const NOW = '2026-09-22T18:00:00.000Z', jobId = `money-job-${run}`;
  await store.commit([{ collection: 'jobs', id: jobId, patch: { type: 'job', customerId: `cust-${run}`, customer: 'Synthetic Customer', serviceType: 'Garage transformation', date: '2026-09-24', status: 'scheduled', pipelineStatus: 'scheduled',
    payment: { amount: 200, verified: true, method: 'offline_or_processor', reference: 'CHK-LEGACY', lastAmount: 200, recordedBy: 'zacb' } } }]);
  const input = (action, fields) => store.read('jobs', jobId).then(job => ({ action, requestId: randomUUID(), jobId, expectedRevision: job.revision, ...fields }));

  await t.test('a money change, its receipt and its audit entry commit together and replay from the receipt', async () => {
    const body = await input('estimate.save', { lineItems: [{ id: 'base', kind: 'service', name: 'Garage cleanout', description: 'Synthetic', quantity: 1, unitCents: 90000 }, { id: 'shelves', kind: 'product', name: 'Shelving', description: '', quantity: 2.5, unitCents: 10000 }], scope: 'Reset the garage.', validUntil: '2026-10-06' });
    const saved = await mutateMoney(store, owner, body, NOW), job = await store.read('jobs', jobId);
    assert.equal(job.estimate.amountCents, 115000); assert.deepEqual(job.estimate.lineItems.map(line => [line.id, line.quantity, line.totalCents]), [['base', 1, 90000], ['shelves', 2.5, 25000]]);
    assert.equal(job.estimate.lineItems[0].group, null, 'null fields round-trip');
    const receipt = await store.read('moneyOperations', body.requestId.toLowerCase());
    assert.equal(receipt.jobId, jobId); assert.equal((await store.read('hub_audit', receipt.auditId)).action, 'money.estimate.save');
    const replay = await mutateMoney(store, owner, body, NOW);
    assert.deepEqual({ ...replay, replayed: false }, saved); assert.equal(replay.replayed, true);
  });

  await t.test('a stale updateTime (FAILED_PRECONDITION) and a reused create id (ALREADY_EXISTS) are both money_revision_conflict and apply nothing', async () => {
    const job = await store.read('jobs', jobId), id = randomUUID();
    await store.commit([{ collection: 'jobs', id: jobId, revision: job.revision, patch: { notes: 'touched' } }]);
    await assert.rejects(store.commit([{ collection: 'jobs', id: jobId, revision: job.revision, patch: { total: 1 } }, { collection: 'moneyOperations', id, patch: { fingerprint: 'x' } }]), error => error.code === 'money_revision_conflict' && error.status === 409);
    assert.equal(await store.read('moneyOperations', id), null);
    await store.commit([{ collection: 'moneyOperations', id, patch: { fingerprint: 'x' } }]);
    await assert.rejects(store.commit([{ collection: 'moneyOperations', id, patch: { fingerprint: 'y' } }]), error => error.code === 'money_revision_conflict');
    assert.equal((await store.read('moneyOperations', id)).fingerprint, 'x');
    const stale = await input('estimate.mark_sent', { channel: 'email' });
    await store.commit([{ collection: 'jobs', id: jobId, revision: (await store.read('jobs', jobId)).revision, patch: { notes: 'touched again' } }]);
    await assert.rejects(mutateMoney(store, owner, stale, NOW), error => error.code === 'money_revision_conflict');
  });

  await t.test('offline payments persist the ledger array, the invoice number reservation and the reconciled totals', async () => {
    await mutateMoney(store, owner, await input('estimate.record_approval', { approvedBy: 'Synthetic Customer' }), NOW);
    const issued = await mutateMoney(store, owner, await input('invoice.issue', { dueDate: '2026-09-29' }), NOW);
    const number = issued.job.invoice.number;
    assert.equal((await store.read('moneyInvoiceNumbers', `n_${number}`)).jobId, jobId);
    const paid = await mutateMoney(store, owner, await input('payment.record_offline', { amountCents: 30000, method: 'check', reference: 'CHK-77' }), NOW);
    const job = await store.read('jobs', jobId);
    assert.deepEqual(job.paymentLedger.map(row => [row.source, row.amountCents, row.at]), [['hub_offline', 30000, NOW], ['legacy_aggregate', 20000, null]]);
    assert.equal(job.payment.amount, 500); assert.equal(paid.job.totals.balanceCents, 65000); assert.equal(paid.job.ledger.complete, true);
    const page = await listMoney(store, { view: 'payments', customerId: `cust-${run}` }, NOW);
    assert.deepEqual(page.items.map(row => row.amountCents), [30000, 20000]);
    const invoices = await listMoney(store, { customerId: `cust-${run}` }, NOW);
    assert.deepEqual(invoices.items.map(row => [row.number, row.status, row.balanceCents]), [[number, 'partial', 65000]]);
    // The customer mirror is best effort outside the money commit: it merges into an existing customer and never creates one.
    assert.equal(await store.read('customers', `cust-${run}`), null);
    await store.commit([{ collection: 'customers', id: `cust-${run}`, patch: { name: 'Synthetic Customer', note: 'kept' } }]);
    await mutateMoney(store, owner, await input('payment.record_offline', { amountCents: 5000, method: 'cash', reference: 'Receipt 78' }), NOW);
    const customer = await store.read('customers', `cust-${run}`);
    assert.deepEqual([customer.latestJobId, customer.lastPaymentStatus, customer.lastPaymentBalance, customer.note], [jobId, 'partial', 600, 'kept']);
  });

  await t.test('the backfill finds the API-written ledger current and reserves nothing twice', async () => {
    const report = await runPaymentLedgerBackfill(store, { apply: true, now: NOW });
    assert.equal(report.aborted, undefined);
    assert.equal(report.preview.some(row => row.id === jobId), false);
    assert.equal(report.invoiceNumbers.toReserve.some(number => number.includes(jobId.slice(-6).toUpperCase())), false);
  });

  await t.test('a portal approval saved before change-order billing is backfilled, then voided from the Hub, on real Firestore', async () => {
    const { runChangeOrderBackfill } = await import('../scripts/backfill-change-orders.mjs');
    const { billedChangeCents } = await import('../functions/_lib/change-orders.js');
    const changeJob = `money-change-${run}`;
    await store.commit([{ collection: 'jobs', id: changeJob, patch: { type: 'job', customerId: `cust-${run}`, customer: 'Synthetic Customer', serviceType: 'Garage transformation', date: '2026-09-24', status: 'in_progress', pipelineStatus: 'in_progress',
      total: 1000, estimate: { amount: 1000, status: 'approved' }, payment: { amount: 500, verified: true }, approvedChangeTotal: 150,
      customerDecisions: [{ id: 'decision-freezer', title: 'Haul the old freezer', details: '', priceDelta: 150, status: 'approved', respondedAt: '2026-09-21T16:00:00.000Z', responseBy: 'Synthetic Customer', responseSource: 'customer_portal' }] } }]);
    const report = await runChangeOrderBackfill(store, { apply: true, now: NOW });
    assert.equal(report.aborted, undefined); assert.deepEqual(report.preview.map(row => row.id), [changeJob]);
    let job = await store.read('jobs', changeJob);
    assert.deepEqual(job.changeOrders.map(line => [line.id, line.totalCents, line.backfilled, line.approvedAt]), [['change-decision-freezer', 15000, true, '2026-09-21T16:00:00.000Z']]);
    assert.equal(billedChangeCents(job), 15000); assert.equal(job.customerDecisions[0].changeOrderId, 'change-decision-freezer');
    const voided = await mutateMoney(store, owner, { action: 'change_order.void', requestId: randomUUID(), jobId: changeJob, expectedRevision: job.revision, changeOrderId: 'change-decision-freezer', reason: 'Synthetic: not done' }, NOW);
    job = await store.read('jobs', changeJob);
    assert.deepEqual([job.changeOrders[0].status, job.approvedChangeTotal, billedChangeCents(job), voided.job.totals.totalCents, voided.job.changeOrders], ['void', 0, 0, 100000, []]);
    assert.equal((await runChangeOrderBackfill(store, { apply: true, now: NOW })).preview.length, 0, 'a voided change is never backfilled again');
  });

  await t.test('FIX-MONEY-INVOICE-STATE: an offline payment writes no invoice, and the backfill deletes a made-up one, on real Firestore', async () => {
    const { runNumberlessInvoiceBackfill } = await import('../scripts/backfill-numberless-invoices.mjs');
    const strict = moneyStorage({ MONEY_INVOICE_STATE_ENABLED: 'true' }, fetcher), openJob = `money-open-${run}`, madeUp = `money-made-up-${run}`;
    const quoted = { type: 'job', customerId: `cust-${run}`, customer: 'Synthetic Customer', serviceType: 'Garage transformation', date: '2026-09-24', status: 'scheduled', pipelineStatus: 'scheduled', total: 1000, estimate: { amount: 1000, status: 'approved' } };
    await store.commit([{ collection: 'jobs', id: openJob, patch: quoted }, { collection: 'jobs', id: madeUp, patch: { ...quoted, payment: { amount: 500, verified: true, method: 'gift_credit', giftCreditApplied: 500 }, invoice: { amount: 1000, paid: 500, balance: 500, status: 'partial', updatedAt: NOW } } }]);
    const job = await strict.read('jobs', openJob);
    const paid = await mutateMoney(strict, owner, { action: 'payment.record_offline', requestId: randomUUID(), jobId: openJob, expectedRevision: job.revision, amountCents: 20000, method: 'check', reference: 'CHK-STRICT' }, NOW);
    const saved = await strict.read('jobs', openJob);
    assert.deepEqual([saved.invoice, saved.payment.amount, paid.job.invoice.status], [undefined, 200, 'not_issued']);
    // The earlier money job shares the run suffix, so INV-{last 6} may already be its number: none is reserved for this job.
    assert.notEqual((await strict.read('moneyInvoiceNumbers', `n_INV-${openJob.slice(-6).toUpperCase()}`))?.jobId, openJob, 'no invoice number is reserved');
    const report = await runNumberlessInvoiceBackfill(strict, { apply: true, now: NOW });
    assert.equal(report.aborted, undefined); assert.deepEqual(report.preview.map(row => row.id), [madeUp]);
    const cleared = await strict.read('jobs', madeUp);
    assert.deepEqual([Object.hasOwn(cleared, 'invoice'), cleared.payment.giftCreditApplied, cleared.payment.amount], [false, 500, 500], 'the invoice field is deleted; the payment stays');
    const receipt = await strict.read('moneyOperations', report.writes.receipts[0]);
    assert.deepEqual([receipt.scope, receipt.targets.map(row => row.id)], ['numberless_invoice_backfill', [madeUp]]);
    assert.equal((await runNumberlessInvoiceBackfill(strict, { apply: true, now: NOW })).writes.planned, 0, 'a rerun finds 0');
  });
});

// TIPS: a tipped charge with no review is booked in ONE commit, the job update plus a precondition-only delete of
// payment_reviews/{sessionId} (currentDocument.exists=false). The recorder relies on Firestore treating that delete as a
// no-op while no review exists (nothing is created, a later create-only review still succeeds) and failing the whole
// commit with ALREADY_EXISTS, the job unchanged, once one does. Checked here on the emulator, raw and through the recorder.
test('the tipped booking commit (job update plus precondition-only review delete) holds on real Firestore', { skip: !enabled, timeout: 180000 }, async t => {
  const host = process.env.FIRESTORE_EMULATOR_HOST || '';
  assert.match(host, /^(?:127\.0\.0\.1|localhost):\d{2,5}$/, 'This test may only connect to a loopback Firestore emulator.');
  const run = randomUUID().slice(0, 8), projectId = `demo-egc-money-race-${run}`, [hostname] = host.split(':');
  const root = `projects/${projectId}/databases/(default)/documents`, NOW = '2026-09-22T18:00:00.000Z';
  const realFetch = globalThis.fetch, statuses = [];
  let beforeCommit = null;
  // Production Firestore URLs and bodies are rewritten to this run's demo project; anything else is refused.
  const emulator = async (input, init = {}) => {
    const target = new URL(String(input));
    assert.equal(target.hostname, 'firestore.googleapis.com', `unexpected request to ${target.hostname}`);
    target.protocol = 'http:'; target.host = host; target.pathname = target.pathname.replace('/projects/egcw-1ec83/', `/projects/${projectId}/`); target.searchParams.delete('key');
    assert.equal(target.hostname, hostname);
    const commit = target.pathname.endsWith('/documents:commit');
    if (commit && beforeCommit) { const run = beforeCommit; beforeCommit = null; await run(); }
    const response = await realFetch(target, { ...init, ...(init.body ? { body: String(init.body).replaceAll('projects/egcw-1ec83/', `projects/${projectId}/`) } : {}), headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: 'Bearer owner' } });
    if (commit) statuses.push(response.status);
    return response;
  };
  const { encodeFirestoreFields, decodeFirestoreFields } = await import('../functions/_lib/firestore-job.js');
  const direct = (path, init = {}) => realFetch(`http://${host}/v1/${root}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' } });
  const read = async path => { const response = await direct(`/${path}`); return response.status === 404 ? null : { status: response.status, ...(await response.json()) }; };
  const create = (path, value) => direct(`/${path}?currentDocument.exists=false`, { method: 'PATCH', body: JSON.stringify({ fields: encodeFirestoreFields(value) }) });
  const commit = writes => direct(':commit', { method: 'POST', body: JSON.stringify({ writes }) });
  const booking = (jobId, updateTime, sessionId, amount) => [
    { update: { name: `${root}/jobs/${jobId}`, fields: encodeFirestoreFields({ amount }) }, updateMask: { fieldPaths: ['amount'] }, currentDocument: { updateTime } },
    { delete: `${root}/payment_reviews/${sessionId}`, currentDocument: { exists: false } },
  ];

  await t.test('raw: the delete is a no-op precondition while no review exists, and refuses the whole commit once one does', async () => {
    const jobId = `race-raw-${run}`, sessionId = `cs_test_race_raw_${run}`;
    assert.equal((await create(`jobs/${jobId}`, { amount: 500 })).status, 200);
    const job = await read(`jobs/${jobId}`);
    const booked = await commit(booking(jobId, job.updateTime, sessionId, 1000));
    assert.equal(booked.status, 200);
    assert.equal(decodeFirestoreFields((await read(`jobs/${jobId}`)).fields).amount, 1000);
    assert.equal(await read(`payment_reviews/${sessionId}`), null, 'the precondition-only delete creates nothing');
    // A review created afterwards (create-only, as recordPaymentReview writes it) still succeeds.
    assert.equal((await create(`payment_reviews/${sessionId}`, { sessionId, status: 'open' })).status, 200);
    const current = await read(`jobs/${jobId}`), refused = await commit(booking(jobId, current.updateTime, sessionId, 1500)), body = await refused.json();
    assert.deepEqual([refused.status, body.error?.status], [409, 'ALREADY_EXISTS']);
    assert.deepEqual([decodeFirestoreFields((await read(`jobs/${jobId}`)).fields).amount, (await read(`jobs/${jobId}`)).updateTime], [1000, current.updateTime], 'nothing in the commit was applied');
    assert.equal(decodeFirestoreFields((await read(`payment_reviews/${sessionId}`)).fields).status, 'open', 'the review is untouched');
  });

  await t.test('the recorder books a tipped charge with no review, and holds one whose review lands just before its commit', async st => {
    st.mock.method(globalThis, 'fetch', emulator);
    const { recordCustomerStripePayment } = await import('../functions/_lib/customer-payments.js');
    const env = { FIREBASE_API_KEY: 'firebase-test-money-race', CUSTOMER_TIPS_ENABLED: 'true' };
    const job = { type: 'job', customer: 'Synthetic Tip Customer', total: 1000, status: 'completed', completedAt: '2026-09-22T10:00:00.000Z', estimate: { status: 'accepted', amount: 1000, depositRequired: 500 },
      deposit: { amount: 500, paidAmount: 500, status: 'paid', verified: true }, payment: { amount: 500, verified: true, method: 'stripe', stripeSessions: [{ sessionId: `cs_test_deposit_${run}`, paymentIntentId: `pi_deposit_${run}`, amount: 500, purpose: 'deposit', verifiedAt: '2026-09-18T16:05:00.000Z' }] } };
    const checkout = (jobId, sessionId) => ({ id: sessionId, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid', currency: 'usd', amount_total: 55000, client_reference_id: jobId, livemode: false,
      metadata: { kind: 'egc_customer_portal_payment', job_id: jobId, payment_purpose: 'balance', tip_cents: '5000' }, payment_intent: { id: `pi_${sessionId}`, latest_charge: { receipt_url: `https://pay.stripe.com/receipts/${sessionId}` } } });
    // No review: one commit books the service part and the tip, and leaves no review document behind.
    const quiet = `race-quiet-${run}`, first = `cs_test_race_quiet_${run}`;
    assert.equal((await create(`jobs/${quiet}`, job)).status, 200);
    const result = await recordCustomerStripePayment(env, checkout(quiet, first), quiet, NOW, { recordedBy: 'stripe_webhook', settleHeld: false });
    assert.deepEqual([result.paid, result.duplicate, statuses], [true, false, [200]]);
    const booked = decodeFirestoreFields((await read(`jobs/${quiet}`)).fields);
    assert.deepEqual([booked.payment.amount, booked.payment.tips.map(tip => tip.amountCents), booked.payment.stripeSessions.length], [1000, [5000], 2]);
    assert.equal(await read(`payment_reviews/${first}`), null);
    // A webhook that saw a refund records its review between this return's reads and its booking commit: the emulator
    // refuses the whole commit (409 ALREADY_EXISTS), and the retry finds the review and holds the charge.
    const raced = `race-held-${run}`, second = `cs_test_race_held_${run}`;
    assert.equal((await create(`jobs/${raced}`, job)).status, 200);
    const before = await read(`jobs/${raced}`);
    beforeCommit = async () => assert.equal((await create(`payment_reviews/${second}`, { sessionId: second, jobId: raced, kind: 'egc_customer_portal_payment', reason: 'payment_refunded', status: 'open', amountCents: 55000, tipCents: 5000, refundedCents: 20000, createdAt: NOW })).status, 200);
    statuses.length = 0;
    await assert.rejects(recordCustomerStripePayment(env, checkout(raced, second), raced, NOW, { recordedBy: 'customer_portal' }), error => error.code === 'payment_refunded' && error.reviewRecorded === true && error.reviewOpen === true);
    assert.deepEqual(statuses, [409], 'the booking commit was refused as a whole');
    const after = await read(`jobs/${raced}`);
    assert.deepEqual([after.updateTime, decodeFirestoreFields(after.fields).payment], [before.updateTime, job.payment], 'the refunded tipped charge is never booked');
    assert.equal(decodeFirestoreFields((await read(`payment_reviews/${second}`)).fields).status, 'open');
  });

  // FUN-33: with the payment events on, the booking is a moneyStorage :commit (the job plus its funnel events). Its
  // precondition-only form {delete: true, exists: false} must keep the same "no review yet" guard on real Firestore.
  await t.test('with FUN-33 payment events on, the moneyStorage booking keeps the same guard, events included', async st => {
    st.mock.method(globalThis, 'fetch', emulator);
    const { moneyStorage } = await import('../functions/_lib/money-storage.js');
    const { recordCustomerStripePayment } = await import('../functions/_lib/customer-payments.js');
    const env = { FIREBASE_API_KEY: 'firebase-test-money-race', CUSTOMER_TIPS_ENABLED: 'true', FUNNEL_PAYMENT_EVENTS_ENABLED: 'true', MONEY_API_ENABLED: 'true' };
    const funnelEvents = async jobId => { const response = await direct('/funnelEvents'); return ((await response.json()).documents || []).map(doc => decodeFirestoreFields(doc.fields)).filter(event => event.jobId === jobId); };
    // Raw: the precondition-only write is a no-op while no review exists and refuses the whole commit once one does.
    const rawJob = `race-events-raw-${run}`, rawSession = `cs_test_race_events_raw_${run}`;
    assert.equal((await create(`jobs/${rawJob}`, { amount: 500 })).status, 200);
    const store = moneyStorage(env), guard = { collection: 'payment_reviews', id: rawSession, delete: true, exists: false };
    await store.commit([{ collection: 'jobs', id: rawJob, revision: (await read(`jobs/${rawJob}`)).updateTime, patch: { amount: 1000 } }, guard]);
    assert.deepEqual([decodeFirestoreFields((await read(`jobs/${rawJob}`)).fields).amount, await read(`payment_reviews/${rawSession}`)], [1000, null], 'the guard creates nothing');
    assert.equal((await create(`payment_reviews/${rawSession}`, { sessionId: rawSession, status: 'open' })).status, 200);
    const current = await read(`jobs/${rawJob}`);
    await assert.rejects(store.commit([{ collection: 'jobs', id: rawJob, revision: current.updateTime, patch: { amount: 1500 } }, guard]), error => error.code === 'money_revision_conflict');
    assert.deepEqual([decodeFirestoreFields((await read(`jobs/${rawJob}`)).fields).amount, (await read(`jobs/${rawJob}`)).updateTime], [1000, current.updateTime], 'nothing in the commit was applied');
    // Through the recorder: the same job and tipped checkout as above.
    const job = { type: 'job', customer: 'Synthetic Tip Customer', total: 1000, status: 'completed', completedAt: '2026-09-22T10:00:00.000Z', estimate: { status: 'accepted', amount: 1000, depositRequired: 500 },
      deposit: { amount: 500, paidAmount: 500, status: 'paid', verified: true }, payment: { amount: 500, verified: true, method: 'stripe', stripeSessions: [{ sessionId: `cs_test_deposit_${run}`, paymentIntentId: `pi_deposit_${run}`, amount: 500, purpose: 'deposit', verifiedAt: '2026-09-18T16:05:00.000Z' }] } };
    const checkout = (jobId, sessionId) => ({ id: sessionId, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid', currency: 'usd', amount_total: 55000, client_reference_id: jobId, livemode: false,
      metadata: { kind: 'egc_customer_portal_payment', job_id: jobId, payment_purpose: 'balance', tip_cents: '5000' }, payment_intent: { id: `pi_${sessionId}`, latest_charge: { created: Date.parse(NOW) / 1000 - 60, receipt_url: `https://pay.stripe.com/receipts/${sessionId}` } } });
    const quiet = `race-events-quiet-${run}`, first = `cs_test_race_events_quiet_${run}`;
    assert.equal((await create(`jobs/${quiet}`, job)).status, 200);
    statuses.length = 0;
    const result = await recordCustomerStripePayment(env, checkout(quiet, first), quiet, NOW, { recordedBy: 'stripe_webhook', settleHeld: false, fromWebhook: true });
    assert.deepEqual([result.paid, result.duplicate, statuses], [true, false, [200]]);
    const booked = decodeFirestoreFields((await read(`jobs/${quiet}`)).fields);
    assert.deepEqual([booked.payment.amount, booked.payment.tips.map(tip => tip.amountCents), booked.paidInFullAt], [1000, [5000], '2026-09-22T17:59:00.000Z']);
    assert.equal(await read(`payment_reviews/${first}`), null);
    const events = (await funnelEvents(quiet)).sort((a, b) => a.type.localeCompare(b.type));
    assert.deepEqual(events.map(event => [event.type, event.data.amountCents, event.data.tipCents ?? null, event.actor.id]), [['job.paid_in_full', 100000, null, 'stripe_webhook'], ['payment.received', 50000, 5000, 'stripe_webhook']]);
    const raced = `race-events-held-${run}`, second = `cs_test_race_events_held_${run}`;
    assert.equal((await create(`jobs/${raced}`, job)).status, 200);
    const before = await read(`jobs/${raced}`);
    beforeCommit = async () => assert.equal((await create(`payment_reviews/${second}`, { sessionId: second, jobId: raced, kind: 'egc_customer_portal_payment', reason: 'payment_refunded', status: 'open', amountCents: 55000, tipCents: 5000, refundedCents: 20000, createdAt: NOW })).status, 200);
    statuses.length = 0;
    await assert.rejects(recordCustomerStripePayment(env, checkout(raced, second), raced, NOW, { recordedBy: 'customer_portal' }), error => error.code === 'payment_refunded' && error.reviewRecorded === true && error.reviewOpen === true);
    assert.equal(statuses.length, 1, 'one booking commit was tried');
    assert.ok([400, 409].includes(statuses[0]), `refused as a whole (${statuses[0]})`);
    const after = await read(`jobs/${raced}`);
    assert.deepEqual([after.updateTime, decodeFirestoreFields(after.fields).payment, decodeFirestoreFields(after.fields).paidInFullAt], [before.updateTime, job.payment, undefined], 'the refunded tipped charge is never booked');
    assert.deepEqual(await funnelEvents(raced), [], 'and no event is written for it');
  });
});
