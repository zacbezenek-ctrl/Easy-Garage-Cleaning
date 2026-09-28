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
});
